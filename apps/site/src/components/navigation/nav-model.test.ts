import { describe, expect, it } from 'vitest';
import type { NavigationManifest } from '@selfpage/content-model';
import {
  findBlogPost,
  isSameDocument,
  navPreviewId,
  navYearListId,
  nextExpandedYear,
  normalizePathname,
  resolveNavigationState,
  resolveYearActivation,
  siteSettingsHref,
} from '@selfpage/site-shell/nav-model';

function manifest(base: string): NavigationManifest {
  const blog = `${base}blog/`;
  return {
    home: {
      title: 'Home',
      href: base,
      children: [{ id: 'about', title: 'About Me', href: `${base}#about` }],
    },
    publications: { title: 'Publications', href: `${base}publications/`, children: [] },
    blog: {
      title: 'Blog',
      href: blog,
      newHref: 'https://selfpage-author.invalid/new/',
      years: [
        {
          year: '2026',
          href: `${blog}#year-2026`,
          posts: [
            {
              title: 'Reading List for Spring',
              date: '2026-11-20',
              shortDate: '11.20',
              href: `${blog}2026/Reading%20List%20for%20Spring-2026-11-20-08-40-00/`,
            },
          ],
        },
        {
          year: '2025',
          href: `${blog}#year-2025`,
          posts: [
            {
              title: 'Café Notes',
              date: '2025-06-01',
              shortDate: '06.01',
              href: `${blog}2025/Caf%C3%A9%20Notes-2025-06-01-00-00-00/`,
            },
          ],
        },
      ],
    },
  };
}

const rootManifest = manifest('/');

describe('normalizePathname', () => {
  it('adds one trailing slash and leaves the root alone', () => {
    expect(normalizePathname('/blog')).toBe('/blog/');
    expect(normalizePathname('/blog/')).toBe('/blog/');
    expect(normalizePathname('/')).toBe('/');
    expect(normalizePathname('')).toBe('/');
  });

  it('drops query and hash and collapses repeated slashes', () => {
    expect(normalizePathname('/blog?x=1#year-2025')).toBe('/blog/');
    expect(normalizePathname('//blog//2025//')).toBe('/blog/2025/');
  });
});

describe('resolveNavigationState', () => {
  it('resolves the three top-level pages', () => {
    expect(resolveNavigationState(rootManifest, '/')).toMatchObject({ page: 'home', key: 'home' });
    expect(resolveNavigationState(rootManifest, '/publications/')).toMatchObject({
      page: 'publications',
      key: 'publications',
    });
    expect(resolveNavigationState(rootManifest, '/blog/')).toMatchObject({ page: 'blog', key: 'blog' });
  });

  it('resolves a blog post with its year', () => {
    const state = resolveNavigationState(
      rootManifest,
      '/blog/2025/Caf%C3%A9%20Notes-2025-06-01-00-00-00/',
    );
    expect(state.page).toBe('blog-post');
    expect(state.key).toBe('blog');
    expect(state.post).toEqual({
      href: '/blog/2025/Caf%C3%A9%20Notes-2025-06-01-00-00-00/',
      title: 'Café Notes',
      year: '2025',
    });
  });

  it('keeps unknown blog subpaths on the Blog branch and other paths unknown', () => {
    expect(resolveNavigationState(rootManifest, '/blog/unknown')).toMatchObject({ page: 'blog', key: 'blog' });
    expect(resolveNavigationState(rootManifest, '/missing/')).toEqual({
      pathname: '/missing/',
      page: 'other',
    });
  });

  it('works with a project base path', () => {
    const demo = manifest('/demo/');
    expect(resolveNavigationState(demo, '/demo/')).toMatchObject({ page: 'home' });
    expect(resolveNavigationState(demo, '/demo/blog/')).toMatchObject({ page: 'blog' });
    expect(
      resolveNavigationState(demo, '/demo/blog/2026/Reading%20List%20for%20Spring-2026-11-20-08-40-00/'),
    ).toMatchObject({ page: 'blog-post', post: { year: '2026' } });
  });

  it('resolves the Settings page as its own branch with no Blog sub-state', () => {
    expect(resolveNavigationState(rootManifest, '/settings/')).toEqual({
      pathname: '/settings/',
      page: 'settings',
      key: 'settings',
    });
    const demo = manifest('/demo/');
    expect(resolveNavigationState(demo, '/demo/settings/')).toMatchObject({
      page: 'settings',
      key: 'settings',
    });
    // A guessed root path is not Settings when the site is deployed below a base.
    expect(resolveNavigationState(demo, '/settings/')).toMatchObject({ page: 'other' });
  });

  it('derives the Settings path from the Home href (BASE_PATH aware)', () => {
    expect(siteSettingsHref('/')).toBe('/settings/');
    expect(siteSettingsHref('/demo/')).toBe('/demo/settings/');
    expect(siteSettingsHref('')).toBe('/settings/');
  });
});

describe('nextExpandedYear (D36 three-state year toggle)', () => {
  it('expands a collapsed year', () => {
    expect(nextExpandedYear('2026', false)).toBe('2026');
  });

  it('collapses the already expanded year', () => {
    expect(nextExpandedYear('2026', true)).toBeNull();
  });
});

describe('resolveYearActivation (D37 year button page semantics)', () => {
  it('navigates and expands on the Blog index', () => {
    expect(resolveYearActivation('blog')).toBe('archive-navigation');
  });

  it('only toggles on a Blog article', () => {
    expect(resolveYearActivation('blog-post')).toBe('local-disclosure');
  });

  it('never navigates on pages that do not render the year list', () => {
    for (const page of ['home', 'publications', 'settings', 'other', undefined, '']) {
      expect(resolveYearActivation(page)).toBe('local-disclosure');
    }
  });
});

describe('link helpers', () => {  it('compares fragment links against the current document', () => {
    expect(isSameDocument('/#about', '/')).toBe(true);
    expect(isSameDocument('/blog/#year-2025', '/blog/')).toBe(true);
    expect(isSameDocument('/blog/', '/')).toBe(false);
  });

  it('finds a post by href and builds stable element ids', () => {
    expect(findBlogPost(rootManifest, '/blog/2025/Caf%C3%A9%20Notes-2025-06-01-00-00-00/')?.title).toBe(
      'Café Notes',
    );
    expect(findBlogPost(rootManifest, '/')).toBeUndefined();
    expect(navPreviewId('2025', 0)).toBe('nav-preview-2025-0');
    expect(navYearListId('2025')).toBe('nav-year-2025-posts');
  });
});
