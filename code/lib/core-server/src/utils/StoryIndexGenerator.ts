import path from 'path';
import chalk from 'chalk';
import fs from 'fs-extra';
import glob from 'globby';
import slash from 'slash';

import type {
  IndexEntry,
  StoryIndexEntry,
  DocsIndexEntry,
  ComponentTitle,
  NormalizedStoriesSpecifier,
  StoryIndexer,
  DocsOptions,
  Path,
  Tag,
  StoryIndex,
  V2CompatIndexEntry,
  StoryId,
  StoryName,
} from '@storybook/types';
import { userOrAutoTitleFromSpecifier, sortStoriesV7 } from '@storybook/preview-api';
import { normalizeStoryPath } from '@storybook/core-common';
import { logger } from '@storybook/node-logger';
import { getStorySortParameter } from '@storybook/csf-tools';
import { toId } from '@storybook/csf';
import { analyze } from '@storybook/docs-mdx';
import dedent from 'ts-dedent';
import { autoName } from './autoName';
import { IndexingError, MultipleIndexingError } from './IndexingError';

/** A .mdx file will produce a docs entry */
type DocsCacheEntry = DocsIndexEntry;
/** A *.stories.* file will produce a list of stories and possibly a docs entry */
type StoriesCacheEntry = {
  entries: (StoryIndexEntry | DocsIndexEntry)[];
  dependents: Path[];
  type: 'stories';
};
type ErrorEntry = {
  type: 'error';
  err: IndexingError;
};
type CacheEntry = false | StoriesCacheEntry | DocsCacheEntry | ErrorEntry;
type SpecifierStoriesCache = Record<Path, CacheEntry>;

export const AUTODOCS_TAG = 'autodocs';
export const STORIES_MDX_TAG = 'stories-mdx';
export const PLAY_FN_TAG = 'play-fn';

/** Was this docs entry generated by a .mdx file? (see discussion below) */
export function isMdxEntry({ tags }: DocsIndexEntry) {
  return !tags?.includes(AUTODOCS_TAG) && !tags?.includes(STORIES_MDX_TAG);
}

const makeAbsolute = (otherImport: Path, normalizedPath: Path, workingDir: Path) =>
  otherImport.startsWith('.')
    ? slash(
        path.resolve(
          workingDir,
          normalizeStoryPath(path.join(path.dirname(normalizedPath), otherImport))
        )
      )
    : otherImport;

/**
 * The StoryIndexGenerator extracts stories and docs entries for each file matching
 * (one or more) stories "specifiers", as defined in main.js.
 *
 * The output is a set of entries (see above for the types).
 *
 * Each file is treated as a stories or a (modern) docs file.
 *
 * A stories file is indexed by an indexer (passed in), which produces a list of stories.
 *   - If the stories have the `parameters.docsOnly` setting, they are disregarded.
 *   - If the stories have the 'stories-mdx' tag (i.e. were generated by a .stories.mdx file),
 *        OR autodocs is enabled, a docs entry is added pointing to the story file.
 *
 * A (modern) docs (.mdx) file is indexed, a docs entry is added.
 *
 * In the preview, a docs entry with either the `autodocs` or `stories-mdx` tags will be rendered
 * as a CSF file that exports an MDX template on the `docs.page` parameter, whereas
 * other docs entries are rendered as MDX files directly.
 *
 * The entries are "uniq"-ed and sorted. Stories entries are preferred to docs entries and
 * MDX docs entries are preferred to CSF templates (with warnings).
 */
export class StoryIndexGenerator {
  // An internal cache mapping specifiers to a set of path=><set of stories>
  // Later, we'll combine each of these subsets together to form the full index
  private specifierToCache: Map<NormalizedStoriesSpecifier, SpecifierStoriesCache>;

  // Cache the last value of `getStoryIndex`. We invalidate (by unsetting) when:
  //  - any file changes, including deletions
  //  - the preview changes [not yet implemented]
  private lastIndex?: StoryIndex;

  // Same as the above but for the error case
  private lastError?: Error;

  constructor(
    public readonly specifiers: NormalizedStoriesSpecifier[],
    public readonly options: {
      workingDir: Path;
      configDir: Path;
      storiesV2Compatibility: boolean;
      storyStoreV7: boolean;
      storyIndexers: StoryIndexer[];
      docs: DocsOptions;
    }
  ) {
    this.specifierToCache = new Map();
  }

  async initialize() {
    // Find all matching paths for each specifier
    const specifiersAndCaches = await Promise.all(
      this.specifiers.map(async (specifier) => {
        const pathToSubIndex = {} as SpecifierStoriesCache;

        const fullGlob = slash(
          path.join(this.options.workingDir, specifier.directory, specifier.files)
        );
        const files = await glob(fullGlob);
        files.sort().forEach((absolutePath: Path) => {
          const ext = path.extname(absolutePath);
          if (ext === '.storyshot') {
            const relativePath = path.relative(this.options.workingDir, absolutePath);
            logger.info(`Skipping ${ext} file ${relativePath}`);
            return;
          }

          pathToSubIndex[absolutePath] = false;
        });

        return [specifier, pathToSubIndex] as const;
      })
    );

    // We do this in a second step to avoid timing issues with the Promise.all above -- to ensure
    // the keys in the `specifierToCache` object are consistent with the order of specifiers.
    specifiersAndCaches.forEach(([specifier, cache]) =>
      this.specifierToCache.set(specifier, cache)
    );

    // Extract stories for each file
    await this.ensureExtracted();
  }

  /**
   * Run the updater function over all the empty cache entries
   */
  async updateExtracted(
    updater: (
      specifier: NormalizedStoriesSpecifier,
      absolutePath: Path,
      existingEntry: CacheEntry
    ) => Promise<CacheEntry>,
    overwrite = false
  ) {
    await Promise.all(
      this.specifiers.map(async (specifier) => {
        const entry = this.specifierToCache.get(specifier);
        return Promise.all(
          Object.keys(entry).map(async (absolutePath) => {
            if (entry[absolutePath] && !overwrite) return;

            try {
              entry[absolutePath] = await updater(specifier, absolutePath, entry[absolutePath]);
            } catch (err) {
              const relativePath = `.${path.sep}${path.relative(
                this.options.workingDir,
                absolutePath
              )}`;

              entry[absolutePath] = {
                type: 'error',
                err: new IndexingError(err.message, [relativePath], err.stack),
              };
            }
          })
        );
      })
    );
  }

  isDocsMdx(absolutePath: Path) {
    return /(?<!\.stories)\.mdx$/i.test(absolutePath);
  }

  async ensureExtracted(): Promise<(IndexEntry | ErrorEntry)[]> {
    // First process all the story files. Then, in a second pass,
    // process the docs files. The reason for this is that the docs
    // files may use the `<Meta of={XStories} />` syntax, which requires
    // that the story file that contains the meta be processed first.
    await this.updateExtracted(async (specifier, absolutePath) =>
      this.isDocsMdx(absolutePath) ? false : this.extractStories(specifier, absolutePath)
    );

    await this.updateExtracted(async (specifier, absolutePath) =>
      this.extractDocs(specifier, absolutePath)
    );

    return this.specifiers.flatMap((specifier) => {
      const cache = this.specifierToCache.get(specifier);
      return Object.values(cache).flatMap((entry): (IndexEntry | ErrorEntry)[] => {
        if (!entry) return [];
        if (entry.type === 'docs') return [entry];
        if (entry.type === 'error') return [entry];
        return entry.entries;
      });
    });
  }

  findDependencies(absoluteImports: Path[]) {
    const dependencies = [] as StoriesCacheEntry[];
    const foundImports = new Set();
    this.specifierToCache.forEach((cache) => {
      const fileNames = Object.keys(cache).filter((fileName) => {
        const foundImport = absoluteImports.find((storyImport) => fileName.startsWith(storyImport));
        if (foundImport) foundImports.add(foundImport);
        return !!foundImport;
      });
      fileNames.forEach((fileName) => {
        const cacheEntry = cache[fileName];
        if (cacheEntry && cacheEntry.type === 'stories') {
          dependencies.push(cacheEntry);
        } else {
          throw new Error(`Unexpected dependency: ${cacheEntry}`);
        }
      });
    });

    // imports can include non-story imports, so it's ok if
    // there are fewer foundImports than absoluteImports
    // if (absoluteImports.length !== foundImports.size) {
    //   throw new Error(`Missing dependencies: ${absoluteImports.filter((p) => !foundImports.has(p))}`));
    // }

    return dependencies;
  }

  async extractStories(specifier: NormalizedStoriesSpecifier, absolutePath: Path) {
    const relativePath = path.relative(this.options.workingDir, absolutePath);
    const entries = [] as IndexEntry[];
    const importPath = slash(normalizeStoryPath(relativePath));
    const makeTitle = (userTitle?: string) => {
      return userOrAutoTitleFromSpecifier(importPath, specifier, userTitle);
    };

    const storyIndexer = this.options.storyIndexers.find((indexer) =>
      indexer.test.exec(absolutePath)
    );
    if (!storyIndexer) {
      throw new Error(`No matching story indexer found for ${absolutePath}`);
    }
    const csf = await storyIndexer.indexer(absolutePath, { makeTitle });

    const componentTags = csf.meta.tags || [];
    csf.stories.forEach(({ id, name, tags: storyTags, parameters }) => {
      if (!parameters?.docsOnly) {
        const tags = [...(storyTags || componentTags), 'story'];
        entries.push({ id, title: csf.meta.title, name, importPath, tags, type: 'story' });
      }
    });

    if (csf.stories.length) {
      const { autodocs } = this.options.docs;
      const componentAutodocs = componentTags.includes(AUTODOCS_TAG);
      const autodocsOptedIn = autodocs === true || (autodocs === 'tag' && componentAutodocs);
      // We need a docs entry attached to the CSF file if either:
      //  a) it is a stories.mdx transpiled to CSF, OR
      //  b) we have docs page enabled for this file
      if (componentTags.includes(STORIES_MDX_TAG) || autodocsOptedIn) {
        const name = this.options.docs.defaultName;
        const id = toId(csf.meta.title, name);
        entries.unshift({
          id,
          title: csf.meta.title,
          name,
          importPath,
          type: 'docs',
          tags: [
            ...componentTags,
            'docs',
            ...(autodocsOptedIn && !componentAutodocs ? [AUTODOCS_TAG] : []),
          ],
          storiesImports: [],
        });
      }
    }

    return { entries, type: 'stories', dependents: [] } as StoriesCacheEntry;
  }

  async extractDocs(specifier: NormalizedStoriesSpecifier, absolutePath: Path) {
    const relativePath = path.relative(this.options.workingDir, absolutePath);
    try {
      if (!this.options.storyStoreV7) {
        throw new Error(`You cannot use \`.mdx\` files without using \`storyStoreV7\`.`);
      }

      const normalizedPath = normalizeStoryPath(relativePath);
      const importPath = slash(normalizedPath);

      const content = await fs.readFile(absolutePath, 'utf8');

      const result: {
        title?: ComponentTitle;
        of?: Path;
        name?: StoryName;
        isTemplate?: boolean;
        imports?: Path[];
        tags?: Tag[];
      } = analyze(content);

      // Templates are not indexed
      if (result.isTemplate) return false;

      const absoluteImports = (result.imports as string[]).map((p) =>
        makeAbsolute(p, normalizedPath, this.options.workingDir)
      );

      // Go through the cache and collect all of the cache entries that this docs file depends on.
      // We'll use this to make sure this docs cache entry is invalidated when any of its dependents
      // are invalidated.f
      const dependencies = this.findDependencies(absoluteImports);

      // Also, if `result.of` is set, it means that we're using the `<Meta of={XStories} />` syntax,
      // so find the `title` defined the file that `meta` points to.
      let csfEntry: StoryIndexEntry;
      if (result.of) {
        const absoluteOf = makeAbsolute(result.of, normalizedPath, this.options.workingDir);
        dependencies.forEach((dep) => {
          if (dep.entries.length > 0) {
            const first = dep.entries.find((e) => e.type !== 'docs') as StoryIndexEntry;

            if (
              path
                .normalize(path.resolve(this.options.workingDir, first.importPath))
                .startsWith(path.normalize(absoluteOf))
            ) {
              csfEntry = first;
            }
          }
        });

        if (!csfEntry)
          throw new Error(
            dedent`Could not find CSF file at path "${result.of}" referenced by \`of={}\` in docs file "${relativePath}".
            
              - Does that file exist?
              - If so, is it a CSF file (\`.stories.*\`)?
              - If so, is it matched by the \`stories\` glob in \`main.js\`?`
          );
      }

      // Track that we depend on this for easy invalidation later.
      dependencies.forEach((dep) => {
        dep.dependents.push(absolutePath);
      });

      const title =
        csfEntry?.title || userOrAutoTitleFromSpecifier(importPath, specifier, result.title);
      const { defaultName } = this.options.docs;
      const name =
        result.name ||
        (csfEntry ? autoName(importPath, csfEntry.importPath, defaultName) : defaultName);
      const id = toId(title, name);

      const docsEntry: DocsCacheEntry = {
        id,
        title,
        name,
        importPath,
        storiesImports: dependencies.map((dep) => dep.entries[0].importPath),
        type: 'docs',
        tags: [...(result.tags || []), 'docs'],
      };
      return docsEntry;
    } catch (err) {
      if (err.source?.match(/mdast-util-mdx-jsx/g)) {
        logger.warn(
          `💡 This seems to be an MDX2 syntax error. Please refer to the MDX section in the following resource for assistance on how to fix this: ${chalk.yellow(
            'https://storybook.js.org/migration-guides/7.0'
          )}`
        );
      }
      throw err;
    }
  }

  chooseDuplicate(firstEntry: IndexEntry, secondEntry: IndexEntry): IndexEntry {
    let firstIsBetter = true;
    if (secondEntry.type === 'story') {
      firstIsBetter = false;
    } else if (isMdxEntry(secondEntry) && firstEntry.type === 'docs' && !isMdxEntry(firstEntry)) {
      firstIsBetter = false;
    }
    const betterEntry = firstIsBetter ? firstEntry : secondEntry;
    const worseEntry = firstIsBetter ? secondEntry : firstEntry;

    const changeDocsName = 'Use `<Meta of={} name="Other Name">` to distinguish them.';

    // This shouldn't be possible, but double check and use for typing
    if (worseEntry.type === 'story')
      throw new IndexingError(`Duplicate stories with id: ${firstEntry.id}`, [
        firstEntry.importPath,
        secondEntry.importPath,
      ]);

    if (betterEntry.type === 'story') {
      const worseDescriptor = isMdxEntry(worseEntry)
        ? `component docs page`
        : `automatically generated docs page`;
      if (betterEntry.name === this.options.docs.defaultName) {
        logger.warn(
          `🚨 You have a story for ${betterEntry.title} with the same name as your default docs entry name (${betterEntry.name}), so the docs page is being dropped. Consider changing the story name.`
        );
      } else {
        logger.warn(
          `🚨 You have a story for ${betterEntry.title} with the same name as your ${worseDescriptor} (${worseEntry.name}), so the docs page is being dropped. ${changeDocsName}`
        );
      }
    } else if (isMdxEntry(betterEntry)) {
      // Both entries are MDX but pointing at the same place
      if (isMdxEntry(worseEntry)) {
        logger.warn(
          `🚨 You have two component docs pages with the same name ${betterEntry.title}:${betterEntry.name}. ${changeDocsName}`
        );
      }

      // If you link a file to a tagged CSF file, you have probably made a mistake
      if (worseEntry.tags?.includes(AUTODOCS_TAG) && this.options.docs.autodocs !== true)
        throw new IndexingError(
          `You created a component docs page for '${worseEntry.title}', but also tagged the CSF file with '${AUTODOCS_TAG}'. This is probably a mistake.`,
          [betterEntry.importPath, worseEntry.importPath]
        );

      // Otherwise the existing entry is created by `autodocs=true` which allowed to be overridden.
    } else {
      // If both entries are templates (e.g. you have two CSF files with the same title), then
      //   we need to merge the entries. We'll use the the first one's name and importPath,
      //   but ensure we include both as storiesImports so they are both loaded before rendering
      //   the story (for the <Stories> block & friends)
      return {
        ...betterEntry,
        storiesImports: [
          ...betterEntry.storiesImports,
          worseEntry.importPath,
          ...worseEntry.storiesImports,
        ],
      };
    }

    return betterEntry;
  }

  async sortStories(entries: StoryIndex['entries']) {
    const sortableStories = Object.values(entries);

    // Skip sorting if we're in v6 mode because we don't have
    // all the info we need here
    if (this.options.storyStoreV7) {
      const storySortParameter = await this.getStorySortParameter();
      const fileNameOrder = this.storyFileNames();
      sortStoriesV7(sortableStories, storySortParameter, fileNameOrder);
    }

    return sortableStories.reduce((acc, item) => {
      acc[item.id] = item;
      return acc;
    }, {} as StoryIndex['entries']);
  }

  async getIndex() {
    if (this.lastIndex) return this.lastIndex;
    if (this.lastError) throw this.lastError;

    // Extract any entries that are currently missing
    // Pull out each file's stories into a list of stories, to be composed and sorted
    const storiesList = await this.ensureExtracted();

    try {
      const errorEntries = storiesList.filter((entry) => entry.type === 'error');
      if (errorEntries.length)
        throw new MultipleIndexingError(errorEntries.map((entry) => (entry as ErrorEntry).err));

      const duplicateErrors: IndexingError[] = [];
      const indexEntries: StoryIndex['entries'] = {};
      (storiesList as IndexEntry[]).forEach((entry) => {
        try {
          const existing = indexEntries[entry.id];
          if (existing) {
            indexEntries[entry.id] = this.chooseDuplicate(existing, entry);
          } else {
            indexEntries[entry.id] = entry;
          }
        } catch (err) {
          duplicateErrors.push(err);
        }
      });
      if (duplicateErrors.length) throw new MultipleIndexingError(duplicateErrors);

      const sorted = await this.sortStories(indexEntries);

      let compat = sorted;
      if (this.options.storiesV2Compatibility) {
        const titleToStoryCount = Object.values(sorted).reduce((acc, story) => {
          acc[story.title] = (acc[story.title] || 0) + 1;
          return acc;
        }, {} as Record<ComponentTitle, number>);

        // @ts-expect-error (Converted from ts-ignore)
        compat = Object.entries(sorted).reduce((acc, entry) => {
          const [id, story] = entry;
          if (story.type === 'docs') return acc;

          acc[id] = {
            ...story,
            kind: story.title,
            story: story.name,
            parameters: {
              __id: story.id,
              docsOnly: titleToStoryCount[story.title] === 1 && story.name === 'Page',
              fileName: story.importPath,
            },
          };
          return acc;
        }, {} as Record<StoryId, V2CompatIndexEntry>);
      }

      this.lastIndex = {
        v: 4,
        entries: compat,
      };

      return this.lastIndex;
    } catch (err) {
      this.lastError = err;
      logger.warn(`🚨 ${this.lastError.toString()}`);
      throw this.lastError;
    }
  }

  invalidate(specifier: NormalizedStoriesSpecifier, importPath: Path, removed: boolean) {
    const absolutePath = slash(path.resolve(this.options.workingDir, importPath));
    const cache = this.specifierToCache.get(specifier);

    const cacheEntry = cache[absolutePath];
    if (cacheEntry && cacheEntry.type === 'stories') {
      const { dependents } = cacheEntry;

      const invalidated = new Set();
      // the dependent can be in ANY cache, so we loop over all of them
      this.specifierToCache.forEach((otherCache) => {
        dependents.forEach((dep) => {
          if (otherCache[dep]) {
            invalidated.add(dep);
            // eslint-disable-next-line no-param-reassign
            otherCache[dep] = false;
          }
        });
      });
    }

    if (removed) {
      if (cacheEntry && cacheEntry.type === 'docs') {
        const absoluteImports = cacheEntry.storiesImports.map((p) =>
          path.resolve(this.options.workingDir, p)
        );
        const dependencies = this.findDependencies(absoluteImports);
        dependencies.forEach((dep) =>
          dep.dependents.splice(dep.dependents.indexOf(absolutePath), 1)
        );
      }
      delete cache[absolutePath];
    } else {
      cache[absolutePath] = false;
    }
    this.lastIndex = null;
    this.lastError = null;
  }

  async getStorySortParameter() {
    const previewFile = ['js', 'jsx', 'ts', 'tsx']
      .map((ext) => path.join(this.options.configDir, `preview.${ext}`))
      .find((fname) => fs.existsSync(fname));
    let storySortParameter;
    if (previewFile) {
      const previewCode = (await fs.readFile(previewFile, 'utf-8')).toString();
      storySortParameter = await getStorySortParameter(previewCode);
    }

    return storySortParameter;
  }

  // Get the story file names in "imported order"
  storyFileNames() {
    return Array.from(this.specifierToCache.values()).flatMap((r) => Object.keys(r));
  }
}
