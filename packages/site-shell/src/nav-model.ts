/**
 * Pure navigation-state helpers shared by the server-rendered shell, the
 * progressive-enhancement controller and the unit tests.
 *
 * The component tree never copies manifest data: every value rendered by
 * `SiteNav.astro` comes from the `NavigationManifest` produced by task 01.
 * This module only projects that manifest plus the current URL into the small
 * amount of state the navigation UI needs.
 */

import type { NavigationManifest } from '@selfpage/content-model';

export type NavigationPage = 'home' | 'publications' | 'blog' | 'blog-post' | 'settings' | 'other';
export type NavigationKey = 'home' | 'publications' | 'blog' | 'settings';

export interface CurrentBlogPost {
  href: string;
  title: string;
  year: string;
}

export interface NavigationState {
  /** Trailing-slash pathname used to compare the current document. */
  pathname: string;
  page: NavigationPage;
  key?: NavigationKey;
  post?: CurrentBlogPost;
}

/** Normalises a URL pathname to a single trailing slash and no query/hash. */
export function normalizePathname(pathname: string): string {
  const withoutQuery = pathname.split('?')[0]?.split('#')[0] ?? '/';
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/');
  if (collapsed === '' || collapsed === '/') return '/';
  return collapsed.endsWith('/') ? collapsed : `${collapsed}/`;
}

/** Returns true when an href resolves to the same document as `pathname`. */
export function isSameDocument(href: string, pathname: string): boolean {
  const url = new URL(href, 'https://selfpage.invalid');
  return normalizePathname(url.pathname) === normalizePathname(pathname);
}

/**
 * Site-root-relative path of the Settings page (task 08, R08-2).
 *
 * Settings is a fixed route, not a content entry, so it is derived from the
 * Home href: the Home href already carries `BASE_PATH` (for example `/demo/`),
 * and Settings must live at the same base (`/demo/settings/`). The public site,
 * the author shell and the navigation model all use this one helper, so a
 * sub-path deployment cannot produce a second, guessed route.
 */
export function siteSettingsHref(homeHref: string): string {
  const base = normalizePathname(homeHref === '' ? '/' : homeHref);
  return base === '/' ? '/settings/' : `${base}settings/`;
}

/**
 * Resolves the focused navigation branch from the manifest and pathname.
 * Blog index and blog posts both keep the Blog branch current; a blog post
 * also exposes its year so the ancestor chain can be rendered server-side.
 * Settings is its own branch and never adds a second-level navigation item.
 */
export function resolveNavigationState(manifest: NavigationManifest, pathname: string): NavigationState {
  const path = normalizePathname(pathname);
  const homeHref = normalizePathname(manifest.home.href);
  const publicationsHref = normalizePathname(manifest.publications.href);
  const blogHref = normalizePathname(manifest.blog.href);

  if (path === homeHref) return { pathname: path, page: 'home', key: 'home' };
  if (path === publicationsHref) return { pathname: path, page: 'publications', key: 'publications' };
  if (path === blogHref) return { pathname: path, page: 'blog', key: 'blog' };
  if (path === normalizePathname(siteSettingsHref(manifest.home.href))) {
    return { pathname: path, page: 'settings', key: 'settings' };
  }

  const post = findBlogPost(manifest, path);
  if (post) return { pathname: path, page: 'blog-post', key: 'blog', post };

  // Unknown nested paths below /blog/ still belong to the Blog branch so the
  // drawer never shows a contradictory current state.
  if (path.startsWith(blogHref)) return { pathname: path, page: 'blog', key: 'blog' };

  return { pathname: path, page: 'other' };
}

/** Finds the manifest post whose href matches `pathname`. */
export function findBlogPost(manifest: NavigationManifest, pathname: string): CurrentBlogPost | undefined {
  const path = normalizePathname(pathname);
  for (const year of manifest.blog.years) {
    for (const post of year.posts) {
      if (normalizePathname(post.href) === path) {
        return { href: post.href, title: post.title, year: year.year };
      }
    }
  }
  return undefined;
}

/**
 * Stable id for the fixed-size preview card of a blog post. Both the drawer
 * link and the preview layer derive it from the same manifest entry.
 */
export function navPreviewId(year: string, index: number): string {
  return `nav-preview-${year}-${index}`;
}

/** Stable id for a year's third-level `<ul>`, referenced by aria-controls. */
export function navYearListId(year: string): string {
  return `nav-year-${year}-posts`;
}

/**
 * Three-state Blog year toggle (D36, user 2026-11-25). Activating a collapsed
 * year expands it (and therefore collapses every other year, because only one
 * year list may be open); activating the already expanded year collapses it.
 * Returns the year key that should stay expanded, or `null` for "none".
 */
export function nextExpandedYear(clickedYear: string, clickedExpanded: boolean): string | null {
  return clickedExpanded ? null : clickedYear;
}

/** D37: what activating a Blog year button does on the current page type. */
export type YearActivation = 'archive-navigation' | 'local-disclosure';

/**
 * Blog year button semantics (D37, user 2026-11-26).
 *
 * - On the Blog index (`/blog/`) the year button scrolls to that year's archive
 *   section and expands it (it is a fragment navigation within the archive).
 * - On a Blog article the same button is a pure disclosure: it only toggles the
 *   year's level-3 list. It must not navigate, change the URL/hash or scroll.
 * - Any other page does not render the year list, so the value is irrelevant;
 *   it is reported as `local-disclosure` to keep every "not the archive" page
 *   away from navigation side effects.
 *
 * The decision comes from the server-rendered page type
 * (`html[data-nav-page]`), never from the URL/hash, so it cannot be flipped by
 * a fragment the user did not ask for.
 */
export function resolveYearActivation(page: NavigationPage | string | undefined): YearActivation {
  return page === 'blog' ? 'archive-navigation' : 'local-disclosure';
}
