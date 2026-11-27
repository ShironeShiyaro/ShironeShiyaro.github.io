// Builds one real Astro site from a temporary content root and returns the
// rendered HTML of two probe posts. This is the independent oracle for X04
// (preview hard breaks vs. the real published Markdown renderer) and X10
// (sanitised raw HTML). The repository's own `content/` tree is only copied,
// never modified.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

export const X04_TITLE = 'Independent hard break probe';
export const X04_MARKDOWN = [
  'Hard break with two spaces  ',
  'next line after two.',
  '',
  'Soft break only',
  'next line after one.',
  '',
  'Hard break with three spaces   ',
  'next line after three.',
  '',
  'Trailing spaces at paragraph end  ',
  '',
  'Second paragraph.',
  '',
  '```text',
  'code line one  ',
  'code line two',
  '```',
  '',
  '- list item one',
  '  continuation after soft break',
  '- list item two  ',
  '  continuation after hard break',
  '',
  '> quote line one  ',
  '> quote line two',
  '',
  '> quote soft one',
  '> quote soft two',
  '',
].join('\n');

export const SANITIZE_TITLE = 'Independent sanitize probe';
export const SANITIZE_MARKDOWN = [
  'Visible paragraph.',
  '',
  '<script>window.__indepXss = 1;</script>',
  '',
  '<img src="x" onerror="window.__indepXss = 2">',
  '',
  '[bad link](javascript:window.__indepXss=3)',
  '',
  '<p onclick="window.__indepXss=4">Raw paragraph</p>',
  '',
].join('\n');

// P1-5 (cfc17eb): manual content may omit the time or carry an impossible one;
// the post is accepted, only the date is displayed, and the loader warns.
export const DATE_ONLY_TITLE = 'Independent date only probe';
export const INVALID_TIME_TITLE = 'Independent invalid time probe';
export const DATE_ONLY_FILE = `${DATE_ONLY_TITLE}-2026-11-24.md`;
export const INVALID_TIME_FILE = `${INVALID_TIME_TITLE}-2026-11-24-25-61-61.md`;

function blogFile(title: string, date: string, time: string, markdown: string): string {
  return [
    '---',
    `title: ${title}`,
    `date: ${date}`,
    '---',
    '',
    `# ${title}`,
    '',
    date,
    '',
    '---',
    '',
    markdown,
  ].join('\n');
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): {
  status: number;
  output: string;
} {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function findArticleHtml(dist: string, title: string): string {
  const stack = [dist];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.name !== 'index.html') continue;
      const html = readFileSync(absolute, 'utf8');
      if (html.includes(`<h1>${title}</h1>`)) {
        return absolute;
      }
    }
  }
  throw new Error(`built article for "${title}" was not found under ${dist}`);
}

export function buildX04Fixture(options: {
  tmpRoot: string;
  assetsDir: string;
}): {
  markdown: string;
  articleHtml: string;
  articleFile: string;
  sanitizeMarkdown: string;
  sanitizeHtml: string;
  sanitizeFile: string;
  dateOnlyHtml: string;
  invalidTimeHtml: string;
  blogIndexHtml: string;
  build: { status: number; log: string; outDir: string; contentRoot: string };
} {
  const tmpRoot = options.tmpRoot;
  const contentRoot = join(tmpRoot, 'x04-content');
  const outDir = join(tmpRoot, 'x04-dist');
  mkdirSync(tmpRoot, { recursive: true });
  rmSync(contentRoot, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  cpSync(join(root, 'content'), contentRoot, { recursive: true });
  mkdirSync(join(contentRoot, 'blog', '2026'), { recursive: true });

  writeFileSync(
    join(contentRoot, 'blog', '2026', `${X04_TITLE}-2026-11-24-10-00-00.md`),
    blogFile(X04_TITLE, '2026-11-24', '10-00-00', X04_MARKDOWN),
    'utf8',
  );
  writeFileSync(
    join(contentRoot, 'blog', '2026', `${SANITIZE_TITLE}-2026-11-24-10-05-00.md`),
    blogFile(SANITIZE_TITLE, '2026-11-24', '10-05-00', SANITIZE_MARKDOWN),
    'utf8',
  );
  writeFileSync(
    join(contentRoot, 'blog', '2026', DATE_ONLY_FILE),
    blogFile(DATE_ONLY_TITLE, '2026-11-24', '10-10-00', 'Date-only fallback body.\n'),
    'utf8',
  );
  writeFileSync(
    join(contentRoot, 'blog', '2026', INVALID_TIME_FILE),
    blogFile(INVALID_TIME_TITLE, '2026-11-24', '10-15-00', 'Invalid-time fallback body.\n'),
    'utf8',
  );

  const astroBin = join(root, 'node_modules', 'astro', 'bin', 'astro.mjs');
  const build = run(
    process.execPath,
    [astroBin, 'build', '--outDir', outDir, '--force'],
    {
      cwd: join(root, 'apps', 'site'),
      env: {
        BASE_PATH: '/',
        SELF_PAGE_CONTENT_ROOT: contentRoot,
        PUBLIC_AUTHOR_ORIGIN: 'http://localhost:43243',
      },
    },
  );
  const logPath = join(options.assetsDir, 'x04-build.log');
  writeFileSync(
    logPath,
    `$ astro build --outDir ${outDir} --force\ncontentRoot: ${contentRoot}\nexit: ${build.status}\n\n${build.output}\n`,
    'utf8',
  );
  if (build.status !== 0) {
    throw new Error(`real Astro build for the X04 fixture failed (exit ${build.status}); see ${logPath}`);
  }

  const articleFile = findArticleHtml(outDir, X04_TITLE);
  const sanitizeFile = findArticleHtml(outDir, SANITIZE_TITLE);
  const dateOnlyFile = findArticleHtml(outDir, DATE_ONLY_TITLE);
  const invalidTimeFile = findArticleHtml(outDir, INVALID_TIME_TITLE);
  return {
    markdown: X04_MARKDOWN,
    articleHtml: readFileSync(articleFile, 'utf8'),
    articleFile,
    sanitizeMarkdown: SANITIZE_MARKDOWN,
    sanitizeHtml: readFileSync(sanitizeFile, 'utf8'),
    sanitizeFile,
    dateOnlyHtml: readFileSync(dateOnlyFile, 'utf8'),
    invalidTimeHtml: readFileSync(invalidTimeFile, 'utf8'),
    blogIndexHtml: readFileSync(join(outDir, 'blog', 'index.html'), 'utf8'),
    build: { status: build.status, log: logPath, outDir, contentRoot },
  };
}

/**
 * X07 / P1-5: verifies the now-reachable missing/invalid time fallback. The
 * loader must accept both files, keep the date strict, warn, and produce a post
 * with no time fields so every view falls back to date-only. The real Astro
 * build of the same content is asserted by the Playwright spec.
 */
export async function probeTimeFallback(options: {
  tmpRoot: string;
  assetsDir: string;
}): Promise<{
  loaded: boolean;
  totalPosts: number;
  warnings: string[];
  dateOnly: Record<string, unknown> | null;
  invalidTime: Record<string, unknown> | null;
}> {
  const fallbackRoot = join(options.tmpRoot, 'fallback-content');
  rmSync(fallbackRoot, { recursive: true, force: true });
  cpSync(join(root, 'content'), fallbackRoot, { recursive: true });
  writeFileSync(
    join(fallbackRoot, 'blog', '2026', DATE_ONLY_FILE),
    blogFile(DATE_ONLY_TITLE, '2026-11-24', '10-10-00', 'Date-only fallback body.\n'),
    'utf8',
  );
  writeFileSync(
    join(fallbackRoot, 'blog', '2026', INVALID_TIME_FILE),
    blogFile(INVALID_TIME_TITLE, '2026-11-24', '10-15-00', 'Invalid-time fallback body.\n'),
    'utf8',
  );
  const { loadSiteContent } = await import('@selfpage/content-model');
  const loaded = loadSiteContent({ contentRoot: fallbackRoot, basePath: '/' });
  const pick = (title: string) => {
    const post = loaded.content.blog.posts.find((candidate) => candidate.title === title);
    if (!post) return null;
    return {
      title: post.title,
      date: post.date,
      shortDate: post.shortDate,
      time: post.time ?? null,
      displayDate: post.displayDate ?? null,
      displayShortDate: post.displayShortDate ?? null,
      route: post.route,
    };
  };
  const warnings = loaded.warnings.map((warning) => `${warning.file}: ${warning.message}`);
  const result = {
    loaded: true,
    totalPosts: loaded.content.blog.posts.length,
    warnings,
    dateOnly: pick(DATE_ONLY_TITLE),
    invalidTime: pick(INVALID_TIME_TITLE),
  };
  writeFileSync(
    join(options.assetsDir, 'x07-time-fallback.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  return result;
}
