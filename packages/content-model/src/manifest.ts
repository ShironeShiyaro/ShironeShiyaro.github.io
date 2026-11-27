import { compareBlogGroupKeysDescending, sortBlogPostsNewestFirst } from './order.ts';
import { buildAuthorNewHref, normalizeBasePath, withBasePath } from './paths.ts';
import type { BlogPostSummary, NavigationManifest, SiteContent } from './types.ts';

export interface ManifestOptions {
  basePath?: string;
  authorOrigin?: string;
}

/**
 * Build the public navigation manifest from validated content. Hrefs are
 * rebuilt from BASE_PATH here rather than copied from per-page data, so a
 * manifest can never contain a stale or double-prefixed base path.
 */
export function buildNavigationManifest(content: SiteContent, options: ManifestOptions = {}): NavigationManifest {
  const basePath = normalizeBasePath(options.basePath);
  const homeHref = withBasePath(basePath, '/');
  const publicationsHref = withBasePath(basePath, '/publications/');
  const blogHref = withBasePath(basePath, '/blog/');

  const sortedPosts = sortBlogPostsNewestFirst(content.blog.posts);

  const postsByYear = new Map<string, BlogPostSummary[]>();
  for (const post of sortedPosts) {
    const posts = postsByYear.get(post.year) ?? [];
    posts.push({
      title: post.title,
      date: post.date,
      shortDate: post.shortDate,
      // D35: optional so a manifest/document from before the time display keeps
      // working unchanged (views fall back to the date).
      ...(post.time === undefined ? {} : { time: post.time }),
      ...(post.displayDate === undefined ? {} : { displayDate: post.displayDate }),
      ...(post.displayShortDate === undefined ? {} : { displayShortDate: post.displayShortDate }),
      href: withBasePath(basePath, post.route),
    });
    postsByYear.set(post.year, posts);
  }

  const years = [...postsByYear.keys()]
    .sort(compareBlogGroupKeysDescending)
    .map((year) => ({
      year,
      href: `${blogHref}#year-${year}`,
      posts: postsByYear.get(year) ?? [],
    }));

  return {
    home: {
      title: 'Home',
      href: homeHref,
      children: content.home.sections.map((section) => ({
        id: section.id,
        title: section.title,
        href: `${homeHref}#${section.id}`,
      })),
    },
    publications: {
      title: 'Publications',
      href: publicationsHref,
      children: [],
    },
    blog: {
      title: 'Blog',
      href: blogHref,
      newHref: buildAuthorNewHref(options.authorOrigin),
      years,
    },
  };
}
