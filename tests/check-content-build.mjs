#!/usr/bin/env node
// Build-level regression checks for the task 01 content contract:
//   1. For allowed complex file names (NFC accents, CJK, spaces, `%`) and
//      literal titles, the manifest blog href must equal the URL implied by
//      the Astro build output, and the built H1 must equal the manifest title.
//   2. Mixed duplicate/suffixed Home headings must produce one unique fragment
//      id per section in both the manifest and the built HTML (review P0-1).
//   3. Home titles with `~`, `<`, `*`, backticks and double spaces must render
//      from the model title as escaped text, including `<script>` escaping.
//   4. Reserved path characters (# $ & + , : ; = ? @) must make the public CLI
//      fail with the content file path (review P1-2).
//
// Run from `npm run test:e2e` (see tests/run-e2e.mjs) or directly with Node.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(repoRoot, 'tests', 'fixtures');
const astroBin = join(repoRoot, 'node_modules', 'astro', 'bin', 'astro.mjs');
const cliBin = join(repoRoot, 'packages', 'content-model', 'src', 'cli.ts');
const siteRoot = join(repoRoot, 'apps', 'site');
const node = process.execPath;

// Keep the temporary builds on the repository volume. Astro moves generated
// assets from apps/site/.astro into --outDir with fs.rename; on Windows that
// fails with EXDEV when os.tmpdir() is on a different drive (this worktree is
// on F:, the system temp directory is on C:). `_tmp/` is git-ignored and is
// also where the repository convention puts throwaway build artifacts.
const tempParent = join(repoRoot, '_tmp');
mkdirSync(tempParent, { recursive: true });
const workRoot = mkdtempSync(join(tempParent, 'content-build-'));
const failures = [];
let checks = 0;

function fail(message) {
  failures.push(message);
  console.error(`  FAIL  ${message}`);
}

function pass(message) {
  console.log(`  PASS  ${message}`);
}

function run(args, options = {}) {
  return spawnSync(node, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: { ...process.env, BASE_PATH: '/', ...options.env },
  });
}

function buildSite(contentRoot, outDir) {
  const result = run(
    [astroBin, 'build', '--force', '--outDir', outDir],
    { cwd: siteRoot, env: { SELF_PAGE_CONTENT_ROOT: contentRoot } },
  );
  if (result.status !== 0) {
    console.error(result.stdout ?? '');
    console.error(result.stderr ?? '');
    throw new Error(`astro build failed for ${contentRoot}`);
  }
}

function writeManifest(contentRoot, outputPath) {
  return run([cliBin, 'manifest', contentRoot, outputPath]);
}

function readManifest(outputPath) {
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(absolute));
    else if (entry.isFile() && entry.name === 'index.html') found.push(absolute);
  }
  return found;
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function checkComplexRoutes() {
  checks += 1;
  console.log('[1/4] allowed complex characters and literal titles: manifest href == built URL');
  const contentRoot = join(fixtureRoot, 'valid', 'complex-routes', 'content');
  const distRoot = join(workRoot, 'complex-dist');
  const manifestPath = join(workRoot, 'complex-manifest.json');
  const manifestResult = writeManifest(contentRoot, manifestPath);
  if (manifestResult.status !== 0) {
    fail(`content:manifest failed for ${contentRoot}: ${manifestResult.stderr}`);
    return;
  }
  buildSite(contentRoot, distRoot);

  const manifest = readManifest(manifestPath);
  const posts = manifest.blog.years.flatMap((year) => year.posts);
  const expectedTitles = [
    'Café Notes',
    '中文 标题',
    '100% Done',
    'Two  Spaces',
    'Résumé Notes',
    'C*',
    '<angle>',
    '~tilde~',
    'Use `code`',
    '<script>',
  ];
  const titles = posts.map((post) => post.title);
  for (const title of expectedTitles) {
    if (!titles.includes(title)) fail(`complex route fixture is missing post ${JSON.stringify(title)}`);
  }

  const builtPostDirs = walk(distRoot)
    .map((file) => toPosix(relative(distRoot, file)))
    .map((relativeFile) => relativeFile.replace(/\/index\.html$/, '/'))
    .filter((relativeDir) => relativeDir.startsWith('blog/') && relativeDir.split('/').length === 4);
  const decodedManifestDirs = posts.map((post) => decodeURIComponent(post.href.replace(/^\//, '')));
  let checkedHeadings = 0;

  for (const post of posts) {
    const decodedDir = decodeURIComponent(post.href.replace(/^\//, ''));
    const builtFile = join(distRoot, ...decodedDir.split('/'), 'index.html');
    if (!existsSync(builtFile)) {
      fail(`built file is missing for manifest href ${post.href} (${builtFile})`);
      continue;
    }
    const builtUrl = `/${encodeURI(decodedDir)}`;
    if (builtUrl !== post.href) {
      fail(`built URL ${builtUrl} differs from manifest href ${post.href} for "${post.title}"`);
    } else {
      pass(`"${post.title}" ${post.href}`);
    }

    const html = readFileSync(builtFile, 'utf8');
    const headingMatch = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
    if (headingMatch?.[0] === undefined) {
      fail(`built post ${post.href} has no H1`);
      continue;
    }
    if (/<script\b/i.test(headingMatch[0])) {
      fail(`built post ${post.href} rendered an unescaped script title`);
      continue;
    }
    const headingText = decodeHtmlEntities(headingMatch[1]).trim();
    if (headingText !== post.title) {
      fail(`built H1 ${JSON.stringify(headingText)} differs from manifest title ${JSON.stringify(post.title)}`);
    } else {
      checkedHeadings += 1;
    }
  }
  if (checkedHeadings === posts.length) {
    pass(`${checkedHeadings} built post H1s match manifest titles`);
  }
  for (const dir of builtPostDirs) {
    if (!decodedManifestDirs.includes(dir)) fail(`unexpected built post directory ${dir}`);
  }
  for (const dir of decodedManifestDirs) {
    if (!builtPostDirs.includes(dir)) fail(`manifest post has no built directory ${dir}`);
  }
}

function checkHomeFragmentIds() {
  checks += 1;
  console.log('[2/4] mixed duplicate/suffixed Home headings: unique ids in manifest and HTML');
  const contentRoot = join(fixtureRoot, 'valid', 'duplicate-home-headings', 'content');
  const distRoot = join(workRoot, 'home-dist');
  const manifestPath = join(workRoot, 'home-manifest.json');
  const manifestResult = writeManifest(contentRoot, manifestPath);
  if (manifestResult.status !== 0) {
    fail(`content:manifest failed for ${contentRoot}: ${manifestResult.stderr}`);
    return;
  }
  buildSite(contentRoot, distRoot);

  const manifest = readManifest(manifestPath);
  const expectedIds = ['about-me', 'about-me-2', 'about-me-3', 'section', 'section-2', 'section-3'];
  const manifestIds = manifest.home.children.map((child) => child.id);
  if (JSON.stringify(manifestIds) !== JSON.stringify(expectedIds)) {
    fail(`manifest Home ids ${JSON.stringify(manifestIds)} do not match ${JSON.stringify(expectedIds)}`);
  } else {
    pass(`manifest Home ids ${JSON.stringify(manifestIds)}`);
  }
  if (new Set(manifestIds).size !== manifestIds.length) {
    fail(`manifest Home ids contain duplicates: ${JSON.stringify(manifestIds)}`);
  }
  for (const child of manifest.home.children) {
    const expectedHref = `/#${child.id}`;
    if (child.href !== expectedHref) fail(`manifest child href ${child.href} should be ${expectedHref}`);
  }

  const html = readFileSync(join(distRoot, 'index.html'), 'utf8');
  const headingIds = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
  if (JSON.stringify(headingIds) !== JSON.stringify(expectedIds)) {
    fail(`built Home section ids ${JSON.stringify(headingIds)} do not match ${JSON.stringify(expectedIds)}`);
  } else {
    pass(`built Home page renders all sections ${JSON.stringify(headingIds)}`);
  }
  for (const id of expectedIds) {
    const occurrences = [...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length;
    if (occurrences !== 1) fail(`fragment id "${id}" appears ${occurrences} times in the built Home page`);
  }
}

function checkHomeTitleRendering() {
  checks += 1;
  console.log('[3/4] Home titles are literal, escaped and equal in manifest and built HTML');
  const contentRoot = join(fixtureRoot, 'valid', 'home-title-rendering', 'content');
  const distRoot = join(workRoot, 'home-title-dist');
  const manifestPath = join(workRoot, 'home-title-manifest.json');
  const manifestResult = writeManifest(contentRoot, manifestPath);
  if (manifestResult.status !== 0) {
    fail(`content:manifest failed for ${contentRoot}: ${manifestResult.stderr}`);
    return;
  }
  buildSite(contentRoot, distRoot);

  const manifest = readManifest(manifestPath);
  const expectedTitles = ['~tilde~', '<angle>', 'C*', 'Use `code`', 'Two  Spaces', '<script>'];
  const manifestTitles = manifest.home.children.map((child) => child.title);
  if (JSON.stringify(manifestTitles) !== JSON.stringify(expectedTitles)) {
    fail(`manifest Home titles ${JSON.stringify(manifestTitles)} do not match ${JSON.stringify(expectedTitles)}`);
  } else {
    pass(`manifest Home titles ${JSON.stringify(manifestTitles)}`);
  }

  const html = readFileSync(join(distRoot, 'index.html'), 'utf8');
  const headingMatches = [...html.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)];
  const renderedTitles = headingMatches.map((match) => decodeHtmlEntities(match[2]).trim());
  if (JSON.stringify(renderedTitles) !== JSON.stringify(expectedTitles)) {
    fail(`built Home h2 titles ${JSON.stringify(renderedTitles)} do not match ${JSON.stringify(expectedTitles)}`);
  } else {
    pass(`built Home h2 titles ${JSON.stringify(renderedTitles)}`);
  }
  if (/<h2[^>]*><script\b/i.test(html) || html.includes('<script>alert')) {
    fail('Home title rendered as an unescaped script');
  }
  if (!html.includes('&lt;script&gt;')) {
    fail('Home title did not escape <script> as &lt;script&gt;');
  }
}

function checkReservedCharacters() {
  checks += 1;
  console.log('[4/4] reserved path characters: public CLI rejects with file paths');
  const contentRoot = join(fixtureRoot, 'invalid', 'reserved-route-characters', 'content');
  const result = run([cliBin, 'validate', contentRoot]);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 1) {
    fail(`content:validate exited ${result.status} instead of 1 for reserved characters`);
  } else {
    pass('content:validate exits 1');
  }
  if ((result.stdout ?? '').includes('Content is valid')) {
    fail('content:validate still reports valid content');
  }
  const expectedFiles = [
    'C# Notes-2025-06-01-00-00-00.md',
    'Price $5-2025-06-02-00-00-00.md',
    'Q&A-2025-06-03-00-00-00.md',
    'C++ Tips-2025-06-04-00-00-00.md',
    'A,B-2025-06-05-00-00-00.md',
    'A;B-2025-06-06-00-00-00.md',
    'A=B-2025-06-07-00-00-00.md',
    'user@example-2025-06-08-00-00-00.md',
  ];
  for (const file of expectedFiles) {
    if (!output.includes(`content/blog/2025/${file}`)) {
      fail(`validation output does not mention content/blog/2025/${file}`);
    }
  }
  if (!output.includes('reserved character')) fail('validation output does not explain the reserved character');
  if (!output.includes('Astro would build a different URL')) {
    fail('validation output does not explain the single-source route reason');
  }
  const manifestPath = join(workRoot, 'reserved-manifest.json');
  const manifestResult = writeManifest(contentRoot, manifestPath);
  if (manifestResult.status !== 1) fail(`content:manifest exited ${manifestResult.status} instead of 1`);
  if (existsSync(manifestPath)) fail('content:manifest wrote an output file for invalid content');
}

const started = Date.now();
try {
  checkComplexRoutes();
  checkHomeFragmentIds();
  checkHomeTitleRendering();
  checkReservedCharacters();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (failures.length > 0) {
    console.error(`\nFAIL: ${failures.length} content build check(s) failed. Temporary output kept at ${workRoot}`);
    process.exitCode = 1;
  } else {
    rmSync(workRoot, { recursive: true, force: true });
    console.log(`\nPASS: ${checks}/4 content build checks in ${Date.now() - started}ms`);
  }
}
