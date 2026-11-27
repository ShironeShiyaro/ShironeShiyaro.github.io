import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ContentValidationError } from './errors.ts';
import { loadSiteContent } from './load.ts';
import { buildNavigationManifest } from './manifest.ts';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
// R09-8: this suite must NOT read the live `content/` tree. It used to, and
// asserted "exactly 4 posts", so publishing the first real article through New!
// turned `npm test` red while `npm run build` stayed green — a gate/deployment
// signal mix-up (a legitimate content commit must never fail a code gate).
// `tests/fixtures/valid/site-content/content` is a byte-identical snapshot of
// the shipped placeholder content; the assertions below keep the same strength
// and now describe that fixture, not whatever the site currently publishes.
const contentRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'site-content', 'content');
const minimalRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'minimal', 'content');

function internalHrefs(manifest: ReturnType<typeof loadSiteContent>['manifest']): string[] {
  return [
    manifest.home.href,
    ...manifest.home.children.map((child) => child.href),
    manifest.publications.href,
    manifest.blog.href,
    ...manifest.blog.years.map((year) => year.href),
    ...manifest.blog.years.flatMap((year) => year.posts.map((post) => post.href)),
  ];
}

describe('site content', () => {
  const loaded = loadSiteContent({ contentRoot });

  it('extracts all Home H1 sections in order with unique ids', () => {
    expect(loaded.content.home.sections.map((section) => section.title)).toEqual([
      'About Me',
      'Education',
      'Skills',
      'Projects',
    ]);
    const ids = loaded.content.home.sections.map((section) => section.id);
    expect(ids).toEqual(['about-me', 'education', 'skills', 'projects']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(loaded.manifest.home.children.map((child) => child.title)).toEqual(
      loaded.content.home.sections.map((section) => section.title),
    );
    expect(loaded.manifest.home.children.map((child) => child.href)).toEqual(
      loaded.content.home.sections.map((section) => section.href),
    );
  });

  it('never creates Publications navigation children, even with H1/H2 content', () => {
    expect(loaded.content.publications.title).toBe('Selected Publications');
    expect(loaded.content.publications.markdown).toContain('## Peer-Reviewed Papers');
    expect(loaded.manifest.publications.children).toEqual([]);
  });

  it('extracts three fictional publication entries and omits missing links', () => {
    expect(loaded.content.publications.items).toHaveLength(3);
    expect(loaded.content.publications.items[0]?.paperHref).toMatch(/^https:\/\/example\.org\//);
    expect(loaded.content.publications.items[0]?.codeHref).toMatch(/^https:\/\/example\.org\//);
    expect(loaded.content.publications.items[2]?.paperHref).toBeUndefined();
    expect(loaded.content.publications.items[2]?.codeHref).toBeUndefined();
  });

  it('sorts Blog years and posts in descending order with MM.DD dates', () => {
    expect(loaded.content.blog.posts.map((post) => post.date)).toEqual([
      '2026-11-20',
      '2026-01-18',
      '2025-11-02',
      '2025-03-14',
    ]);
    expect(loaded.manifest.blog.years.map((year) => year.year)).toEqual(['2026', '2025']);
    const firstYear = loaded.manifest.blog.years[0];
    expect(firstYear?.posts.map((post) => post.shortDate)).toEqual(['11.20', '01.18']);
    expect(firstYear?.posts.every((post) => /^\d{2}\.\d{2}$/.test(post.shortDate))).toBe(true);
    expect(firstYear?.href).toBe('/blog/#year-2026');
  });

  it('reads the publication time from the file-name -HH-mm-ss suffix (D35)', () => {
    const posts = loaded.manifest.blog.years.flatMap((year) => year.posts);
    // Newest first; the minute is taken from the file name, seconds never shown.
    expect(posts.map((post) => post.time)).toEqual(['08:40', '20:15', '14:05', '09:30']);
    expect(posts.map((post) => post.displayDate)).toEqual([
      '2026-11-20 08:40',
      '2026-01-18 20:15',
      '2025-11-02 14:05',
      '2025-03-14 09:30',
    ]);
    expect(posts.map((post) => post.displayShortDate)).toEqual([
      '11.20 08:40',
      '01.18 20:15',
      '11.02 14:05',
      '03.14 09:30',
    ]);
    for (const post of posts) {
      expect(post.displayDate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(post.displayShortDate).toMatch(/^\d{2}\.\d{2} \d{2}:\d{2}$/);
      expect(post.displayDate).not.toMatch(/:\d{2}:\d{2}$/);
    }
  });

  it('keeps a manifest without file-name times backward compatible (date-only)', () => {
    // Documents/manifests produced before task 07.5 have no time fields; the
    // optional contract must keep them loadable and displayable.
    const legacy = buildNavigationManifest(
      {
        home: { title: 'Home', sections: [] },
        publications: { title: 'Selected Publications', markdown: '', items: [] },
        blog: {
          title: 'Blog',
          posts: [
            {
              id: 'blog/2025/Legacy-2025-01-02-00-00-00/',
              route: 'blog/2025/Legacy-2025-01-02-00-00-00/',
              title: 'Legacy',
              date: '2025-01-02',
              shortDate: '01.02',
              year: '2025',
              month: '01',
              href: '/blog/2025/Legacy-2025-01-02-00-00-00/',
              sourcePath: 'content/blog/2025/Legacy-2025-01-02-00-00-00.md',
              segments: ['2025', 'Legacy-2025-01-02-00-00-00'],
              bodyMarkdown: 'Body',
              visibleMarkdown: '# Legacy\n\n2025-01-02\n\n---\n\nBody',
            },
          ],
        },
      },
      { basePath: '/' },
    );
    const post = legacy.blog.years[0]?.posts[0];
    expect(post?.date).toBe('2025-01-02');
    expect(post?.shortDate).toBe('01.02');
    expect(post?.time).toBeUndefined();
    expect(post?.displayDate).toBeUndefined();
    expect(post?.displayShortDate).toBeUndefined();
  });

  it('derives every Blog route from the file path and never stores a slug field', () => {
    expect(loaded.content.blog.posts.map((post) => post.route)).toEqual([
      'blog/2026/Reading%20List%20for%20Spring-2026-11-20-08-40-00/',
      'blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/',
      'blog/2025/Notes%20on%20Accessible%20Navigation-2025-11-02-14-05-00/',
      'blog/2025/Building%20a%20Quiet%20Homepage-2025-03-14-09-30-00/',
    ]);
    expect(loaded.content.blog.posts.every((post) => post.bodyMarkdown.trim().length > 0)).toBe(true);
    expect(loaded.content.blog.posts.every((post) => post.visibleMarkdown.startsWith('# '))).toBe(true);
    expect(loaded.content.blog.posts[0]?.segments).toEqual([
      '2026',
      'Reading List for Spring-2026-11-20-08-40-00',
    ]);
  });

  it('ships English placeholder content covering at least two years and two months', () => {
    const years = new Set(loaded.content.blog.posts.map((post) => post.year));
    const months = new Set(loaded.content.blog.posts.map((post) => post.date.slice(0, 7)));
    expect(years.size).toBeGreaterThanOrEqual(2);
    expect(months.size).toBeGreaterThanOrEqual(2);

    const visibleText = [
      ...loaded.content.home.sections.flatMap((section) => [section.title, section.markdown]),
      loaded.content.publications.markdown,
      ...loaded.content.publications.items.flatMap((item) => [item.title, item.venue, ...item.authors]),
      ...loaded.content.blog.posts.flatMap((post) => [post.title, post.bodyMarkdown]),
    ].join('\n');
    expect(visibleText).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('builds newHref from PUBLIC_AUTHOR_ORIGIN and contains no secrets or local paths', () => {
    expect(loaded.manifest.blog.newHref).toBe('https://selfpage-author.invalid/new/');
    const serialised = JSON.stringify(loaded.manifest);
    expect(serialised).not.toContain(repoRoot);
    expect(serialised).not.toMatch(/[A-Za-z]:\\/);
    expect(serialised.toLowerCase()).not.toContain('token');
    expect(serialised.toLowerCase()).not.toContain('secret');
    expect(serialised.toLowerCase()).not.toContain('oauth');
  });

  it('applies BASE_PATH to every internal manifest href exactly once', () => {
    const demo = loadSiteContent({ contentRoot, basePath: '/demo/', authorOrigin: 'https://author.example' });
    for (const href of internalHrefs(demo.manifest)) {
      expect(href.startsWith('/demo/')).toBe(true);
      expect(href).not.toContain('/demo/demo');
    }
    expect(demo.manifest.blog.newHref).toBe('https://author.example/new/');
    expect(demo.manifest.blog.years.flatMap((year) => year.posts).every((post) => post.href.startsWith('/demo/blog/'))).toBe(
      true,
    );
  });

  it('rejects an invalid base path or author origin as configuration errors', () => {
    expect(() => loadSiteContent({ contentRoot, basePath: 'demo' })).toThrow(ContentValidationError);
    expect(() => loadSiteContent({ contentRoot, authorOrigin: 'http://author.example' })).toThrow(
      ContentValidationError,
    );
    expect(() => loadSiteContent({ contentRoot: join(repoRoot, 'does-not-exist') })).toThrow(
      ContentValidationError,
    );
  });
});

describe('minimal fixture', () => {
  it('de-duplicates repeated Home headings instead of overwriting ids', () => {
    const loaded = loadSiteContent({
      contentRoot: minimalRoot,
      basePath: '/demo/',
      authorOrigin: 'https://author.example',
    });
    expect(loaded.content.home.sections.map((section) => section.id)).toEqual([
      'about-me',
      'about-me-2',
      'skills',
    ]);
    expect(loaded.warnings.some((warning) => warning.message.includes('duplicate Home heading'))).toBe(true);
    expect(loaded.manifest.home.children.map((child) => child.href)).toEqual([
      '/demo/#about-me',
      '/demo/#about-me-2',
      '/demo/#skills',
    ]);
  });

  it('keeps site-relative publication links inside BASE_PATH and drops absent links', () => {
    const loaded = loadSiteContent({ contentRoot: minimalRoot, basePath: '/demo/' });
    expect(loaded.content.publications.items[1]?.paperHref).toBe('/demo/papers/two');
    expect(loaded.content.publications.items[1]?.codeHref).toBeUndefined();
    expect(loaded.manifest.publications.children).toEqual([]);
  });

  it('sorts two years and months in descending order', () => {
    const loaded = loadSiteContent({ contentRoot: minimalRoot, basePath: '/demo/' });
    expect(loaded.manifest.blog.years.map((year) => year.year)).toEqual(['2025', '2024']);
    expect(loaded.manifest.blog.years.flatMap((year) => year.posts).map((post) => post.date)).toEqual([
      '2025-05-01',
      '2024-12-31',
    ]);
  });
});

describe('mixed duplicate and suffixed Home headings fixture', () => {
  const mixedRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'duplicate-home-headings', 'content');

  it('generates a unique id for every section, including suffixed-title collisions', () => {
    const loaded = loadSiteContent({ contentRoot: mixedRoot });
    const ids = loaded.content.home.sections.map((section) => section.id);
    expect(loaded.content.home.sections.map((section) => section.title)).toEqual([
      'About Me',
      'About Me',
      'About Me 2',
      'Section',
      'Section 2',
      'Section',
    ]);
    expect(ids).toEqual(['about-me', 'about-me-2', 'about-me-3', 'section', 'section-2', 'section-3']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(loaded.manifest.home.children.map((child) => child.id)).toEqual(ids);
    expect(loaded.manifest.home.children.map((child) => child.href)).toEqual(
      ids.map((id) => `/#${id}`),
    );
    expect(loaded.warnings.filter((warning) => warning.message.includes('duplicate Home heading'))).toHaveLength(3);
  });
});

describe('complex route fixture', () => {
  const complexRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'complex-routes', 'content');

  it('keeps NFC, CJK, spaces and percent signs identical in route and Astro segment input', () => {
    const loaded = loadSiteContent({ contentRoot: complexRoot });
    for (const post of loaded.content.blog.posts) {
      expect(post.route).toBe(`blog/${post.segments.map((segment) => encodeURIComponent(segment)).join('/')}/`);
      expect(encodeURI(post.segments.join('/'))).toBe(post.route.slice('blog/'.length, -1));
    }
    const café = loaded.content.blog.posts.find((post) => post.title === 'Café Notes');
    expect(café?.route).toBe('blog/2025/Caf%C3%A9%20Notes-2025-06-01-00-00-00/');
    const nfd = loaded.content.blog.posts.find((post) => post.title === 'Résumé Notes');
    expect(nfd?.route).toBe('blog/2025/R%C3%A9sum%C3%A9%20Notes-2025-06-05-00-00-00/');
    expect(nfd?.segments[1]).toBe('Résumé Notes-2025-06-05-00-00-00');
  });
});

describe('blog path and file-name contract', () => {
  const blogFilenameRoot = join(repoRoot, 'tests', 'fixtures', 'invalid', 'blog-filename', 'content');
  const dotPathRoot = join(repoRoot, 'tests', 'fixtures', 'invalid', 'dot-path-segments', 'content');
  const manualDateRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'manual-date-warning', 'content');
  const timeFallbackRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'time-fallback', 'content');

  it('rejects a missing date and a file-name title mismatch, but accepts an invalid time with a warning', () => {
    let issueList: Array<{ file: string; message: string }> = [];
    try {
      loadSiteContent({ contentRoot: blogFilenameRoot });
    } catch (error) {
      if (!(error instanceof ContentValidationError)) throw error;
      issueList = error.issues;
    }
    expect(issueList).toHaveLength(2);
    expect(issueList.map((issue) => issue.file)).toEqual(
      expect.arrayContaining([
        'content/blog/2025/missing-timestamp.md',
        'content/blog/2025/Wrong Title-2025-01-06-00-00-00.md',
      ]),
    );
    expect(issueList.some((issue) => issue.message.includes('must end with -YYYY-MM-DD'))).toBe(true);
    expect(issueList.some((issue) => issue.message.includes('does not match sanitised H1/title'))).toBe(
      true,
    );
  });

  it('falls back to a date-only post when the file name time is missing or invalid (P1-5/D35)', () => {
    const loaded = loadSiteContent({ contentRoot: timeFallbackRoot });
    const posts = loaded.content.blog.posts;
    const byTitle = new Map(posts.map((post) => [post.title, post]));

    const normal = byTitle.get('Normal Post');
    expect(normal?.time).toBe('03:04');
    expect(normal?.displayDate).toBe('2025-01-02 03:04');
    expect(normal?.displayShortDate).toBe('01.02 03:04');

    // No time segment: the date still comes from the strict date part.
    const dateOnly = byTitle.get('Date Only');
    expect(dateOnly?.date).toBe('2025-01-03');
    expect(dateOnly?.time).toBeUndefined();
    expect(dateOnly?.displayDate).toBeUndefined();
    expect(dateOnly?.displayShortDate).toBeUndefined();

    // Impossible time: accepted with a warning, display falls back to the date.
    const badTime = byTitle.get('Bad Time');
    expect(badTime?.date).toBe('2025-01-04');
    expect(badTime?.time).toBeUndefined();
    expect(badTime?.displayDate).toBeUndefined();

    const warnings = loaded.warnings.map((warning) => `${warning.file}: ${warning.message}`);
    expect(warnings).toHaveLength(2);
    expect(
      warnings.some(
        (warning) =>
          warning.includes('Date Only-2025-01-03.md') && warning.includes('no -HH-mm-ss'),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (warning) =>
          warning.includes('Bad Time-2025-01-04-25-10-10.md') &&
          warning.includes('not a valid 24-hour time'),
      ),
    ).toBe(true);
    // Missing/invalid time never aborts the load and never yields ":" as time.
    expect(posts.every((post) => post.time !== ':' && post.time !== '')).toBe(true);
  });

  it('accepts a manual file-name date mismatch with a warning (D11)', () => {
    const loaded = loadSiteContent({ contentRoot: manualDateRoot });
    const warning = loaded.warnings.find((entry) => entry.message.includes('file name date "2025-01-02"'));
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('manual content is accepted');
    const post = loaded.content.blog.posts.find((entry) => entry.title === 'Manual Date');
    expect(post?.date).toBe('2025-01-03');
    expect(post?.sourcePath).toBe('content/blog/2025/Manual Date-2025-01-02-00-00-00.md');
  });

  it('accepts an H1/date edit without renaming the file via warnings (acceptance clause 8 / D11)', () => {
    const loaded = loadSiteContent({ contentRoot: manualDateRoot });
    const edited = loaded.content.blog.posts.find((entry) => entry.title === 'Edited Post Updated');
    expect(edited?.date).toBe('2025-02-03');
    expect(edited?.sourcePath).toBe('content/blog/2025/Edited Post-2025-02-02-00-00-00.md');
    const warnings = loaded.warnings.map((entry) => entry.message);
    expect(warnings.some((message) => message.includes('file name date "2025-02-02"'))).toBe(true);
    expect(warnings.some((message) => message.includes('file name title "Edited Post"'))).toBe(true);
  });

  it('rejects the same date mismatch in New! strict mode (D11)', () => {
    expect(() =>
      loadSiteContent({ contentRoot: manualDateRoot, strictBlogFileNameDate: true }),
    ).toThrow(/New! strict mode requires a matching date/);
  });

  it('rejects empty, dot and dot-dot path segments with the content file path', () => {
    let issueList: Array<{ file: string; message: string }> = [];
    try {
      loadSiteContent({ contentRoot: dotPathRoot });
    } catch (error) {
      if (!(error instanceof ContentValidationError)) throw error;
      issueList = error.issues;
    }
    expect(issueList).toHaveLength(3);
    for (const file of ['content/blog/2025/.md', 'content/blog/2025/..md', 'content/blog/2025/...md']) {
      expect(issueList.some((issue) => issue.file === file)).toBe(true);
    }
    expect(issueList.filter((issue) => issue.message.includes('contains the path segment')).length).toBe(2);
    expect(issueList.some((issue) => issue.message.includes('empty path segment'))).toBe(true);
  });
});

describe('security audit warnings', () => {
  it('warns about raw HTML and javascript: links without failing valid content', () => {
    const auditRoot = join(repoRoot, 'tests', 'fixtures', 'valid', 'security-audit', 'content');
    const loaded = loadSiteContent({ contentRoot: auditRoot });
    const auditWarnings = loaded.warnings.filter((warning) => warning.message.includes('security audit'));
    expect(auditWarnings.map((warning) => warning.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('raw <script>'),
        expect.stringContaining('inline event handler'),
        expect.stringContaining('javascript: link'),
      ]),
    );
    expect(auditWarnings.every((warning) => warning.file === 'content/blog/2025/New Post-2025-05-01-10-00-00.md')).toBe(
      true,
    );
  });
});

describe('resume front matter', () => {
  it('rejects an empty front matter block with the content file path', () => {
    const resumeRoot = join(repoRoot, 'tests', 'fixtures', 'invalid', 'resume-empty-front-matter', 'content');
    let issueList: Array<{ file: string; message: string }> = [];
    try {
      loadSiteContent({ contentRoot: resumeRoot });
    } catch (error) {
      if (!(error instanceof ContentValidationError)) throw error;
      issueList = error.issues;
    }
    expect(issueList).toHaveLength(1);
    expect(issueList[0]?.file).toBe('content/home/resume.md');
    expect(issueList[0]?.message).toContain('resume front matter is not defined');
  });
});

describe('BASE_PATH normalisation warning', () => {
  it('warns instead of silently accepting a missing trailing slash', () => {
    const loaded = loadSiteContent({ contentRoot: minimalRoot, basePath: '/demo' });
    expect(loaded.content.home.sections[0]?.href).toBe('/demo/#about-me');
    expect(loaded.warnings.some((warning) => warning.message.includes('missing a trailing slash'))).toBe(true);
  });
});
