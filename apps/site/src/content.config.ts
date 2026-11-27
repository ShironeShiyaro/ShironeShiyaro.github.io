import { fileURLToPath } from 'node:url';
import { defineCollection } from 'astro:content';
import { loadSiteContent } from '@selfpage/content-model';
import type {
  BlogEntryData,
  ManifestEntryData,
  PublicationsEntryData,
  ResumeEntryData,
} from './lib/entry-types.ts';
import { sanitizeMarkdownHtml } from './lib/sanitize-markdown.ts';

const contentRoot =
  process.env.SELF_PAGE_CONTENT_ROOT?.trim() || fileURLToPath(new URL('../../../content', import.meta.url));

/**
 * One collection for the whole public site. The loader is the only place that
 * parses content: packages/content-model validates and extracts data, while
 * Astro's configured Markdown processor renders it into HTML strings that are
 * stored with each entry. Pages therefore never parse Markdown themselves.
 */
const site = defineCollection({
  loader: {
    name: 'selfpage-site-content',
    load: async ({ store, renderMarkdown, generateDigest, logger }) => {
      const loaded = loadSiteContent({
        contentRoot,
        basePath: process.env.BASE_PATH,
        authorOrigin: process.env.PUBLIC_AUTHOR_ORIGIN,
      });

      for (const warning of loaded.warnings) {
        logger.warn(`${warning.file}: ${warning.message}`);
      }

      store.clear();

      /**
       * Every Markdown body rendered for the public site goes through the same
       * strict allowlist before it is stored. Doing it here (instead of on one
       * page) keeps Home, Publications and Blog equally safe and means pages
       * never handle unsanitised HTML from the content model.
       */
      const renderSafeMarkdown = async (markdown: string) => {
        const rendered = await renderMarkdown(markdown);
        return { ...rendered, html: sanitizeMarkdownHtml(rendered.html) };
      };

      for (const [order, section] of loaded.content.home.sections.entries()) {
        const entryId = `resume:${section.id}`;
        if (store.has(entryId)) {
          // loadHome already rejects duplicate fragment ids; this guard makes
          // an accidental store overwrite impossible even if that changes.
          throw new Error(
            `duplicate Home fragment id "${section.id}" for "${section.title}"; refusing to overwrite content collection entry "${entryId}"`,
          );
        }
        const data: ResumeEntryData = {
          type: 'resume',
          id: section.id,
          title: section.title,
          href: section.href,
          order,
        };
        store.set({
          id: entryId,
          data,
          rendered: await renderSafeMarkdown(section.markdown),
          digest: generateDigest(`${section.title}\n${section.markdown}`),
        });
      }

      const publicationsData: PublicationsEntryData = {
        type: 'publications',
        title: loaded.content.publications.title,
        items: loaded.content.publications.items,
      };
      store.set({
        id: 'publications',
        data: publicationsData,
        rendered: await renderSafeMarkdown(loaded.content.publications.markdown),
        digest: generateDigest(`${loaded.content.publications.title}\n${loaded.content.publications.markdown}`),
      });

      for (const post of loaded.content.blog.posts) {
        const data: BlogEntryData = {
          type: 'blog',
          title: post.title,
          date: post.date,
          shortDate: post.shortDate,
          ...(post.time === undefined ? {} : { time: post.time }),
          ...(post.displayDate === undefined ? {} : { displayDate: post.displayDate }),
          ...(post.displayShortDate === undefined ? {} : { displayShortDate: post.displayShortDate }),
          year: post.year,
          month: post.month,
          route: post.route,
          href: post.href,
          segments: post.segments,
        };
        store.set({
          id: `blog:${post.id}`,
          data,
          // The H1 and date are rendered as escaped model data on the page;
          // Astro only renders the body Markdown after the separator.
          rendered: await renderSafeMarkdown(post.bodyMarkdown),
          digest: generateDigest(post.visibleMarkdown),
        });
      }

      const manifestData: ManifestEntryData = {
        type: 'manifest',
        manifest: loaded.manifest,
      };
      store.set({
        id: 'manifest',
        data: manifestData,
        digest: generateDigest(JSON.stringify(loaded.manifest)),
      });
    },
  },
});

export const collections = { site };
