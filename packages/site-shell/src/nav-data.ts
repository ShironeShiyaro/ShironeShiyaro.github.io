import type { NavigationManifest } from '@selfpage/content-model';
import { navYearListId, siteSettingsHref } from './nav-model.ts';
import { resolveSiteHref } from './origin.ts';

/**
 * Framework-agnostic shell data for the public site and the author app.
 *
 * The content-model `NavigationManifest` holds site-root-relative hrefs (with
 * `BASE_PATH`) and the author origin for New!. The author app needs the same
 * hierarchy with absolute links to the public site, so this projection is the
 * single place where that translation happens: the Astro site and the React
 * author shell both render labels, hrefs and level-3 labels from here, and a
 * new post shows up in both without a second source of truth.
 */
export interface ShellNavPost {
  title: string;
  /** Absolute public-site URL. */
  href: string;
  /** Level-3 label: `{title}-{MM.DD HH:mm}` (D35). */
  label: string;
  /** Preview-card date: `YYYY-MM-DD HH:mm` (D35). */
  previewDate: string;
}

export interface ShellNavYear {
  year: string;
  /** Absolute `…/blog/#year-YYYY` URL. */
  href: string;
  label: string;
  /** Stable id of the year's level-3 list, referenced by aria-controls. */
  listId: string;
  posts: ShellNavPost[];
}

export interface ShellNavLink {
  label: string;
  href: string;
}

export interface ShellNav {
  home: { label: string; href: string; children: ShellNavLink[] };
  publications: ShellNavLink;
  blog: { label: string; href: string; newHref: string; years: ShellNavYear[] };
  /** Fixed Settings row: the public site's /settings/ page on the public origin. */
  settings: ShellNavLink;
}

export interface ShellNavOptions {
  /** Validated `PUBLIC_SITE_ORIGIN`. */
  siteOrigin: string;
  /**
   * Override for the New! link. The author app points it at its own `/new/`
   * route; the public site keeps the manifest's `PUBLIC_AUTHOR_ORIGIN` value.
   */
  newHref?: string;
}

export function buildShellNav(manifest: NavigationManifest, options: ShellNavOptions): ShellNav {
  const { siteOrigin } = options;
  return {
    home: {
      label: manifest.home.title,
      href: resolveSiteHref(siteOrigin, manifest.home.href),
      children: manifest.home.children.map((child) => ({
        label: child.title,
        href: resolveSiteHref(siteOrigin, child.href),
      })),
    },
    publications: {
      label: manifest.publications.title,
      href: resolveSiteHref(siteOrigin, manifest.publications.href),
    },
    blog: {
      label: manifest.blog.title,
      href: resolveSiteHref(siteOrigin, manifest.blog.href),
      newHref: options.newHref ?? manifest.blog.newHref,
      years: manifest.blog.years.map((year) => ({
        year: year.year,
        href: resolveSiteHref(siteOrigin, year.href),
        label: year.year,
        listId: navYearListId(year.year),
        posts: year.posts.map((post) => ({
          title: post.title,
          href: resolveSiteHref(siteOrigin, post.href),
          label: `${post.title}-${post.displayShortDate ?? post.shortDate}`,
          previewDate: post.displayDate ?? post.date,
        })),
      })),
    },
    settings: {
      label: 'Settings',
      href: resolveSiteHref(siteOrigin, siteSettingsHref(manifest.home.href)),
    },
  };
}
