#!/usr/bin/env node
/**
 * Build-artifact gate: everything that is about to be published must be checked.
 *
 * It answers the task-09 questions "do the internal links survive this BASE_PATH",
 * "did a local absolute path leak into the output" and "does a secret, a test
 * fixture or a test-only endpoint ship with the artifact" — for the public site
 * that GitHub Pages will serve, and (informatively) for the author app bundles
 * that Cloudflare will serve.
 *
 * Usage:
 *   node tests/check-deploy-artifacts.mjs
 *   node tests/check-deploy-artifacts.mjs --site apps/site/dist --base /demo/
 *   BASE_PATH=/demo/ node tests/check-deploy-artifacts.mjs
 *
 * Preconditions: `npm run build` has produced the dist directories. Exit codes:
 * 0 pass, 1 a check failed, 2 usage/precondition problem.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`error: --${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const siteDir = resolve(repoRoot, option('site', 'apps/site/dist'));
const authorClientDir = resolve(repoRoot, option('author-client', 'apps/author/dist/client'));
const authorWorkerDir = resolve(repoRoot, option('author-worker', 'apps/author/dist/worker'));
const basePath = (option('base', process.env.BASE_PATH ?? '')).trim() || '/';

/** Extensions we may read as UTF-8 text. Everything else is skipped as binary. */
const TEXT_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.map',
  '.svg',
  '.txt',
  '.xml',
  '.webmanifest',
]);

const failures = [];
const notes = [];
const counters = { files: 0, bytes: 0, skipped: 0 };
/** True when the built New! link still points at the placeholder origin. */
let placeholderNewHref = false;

function display(absolute) {
  return relative(repoRoot, absolute).split('\\').join('/');
}

function walk(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/* rule sets                                                                 */
/* -------------------------------------------------------------------------- */

/** Never acceptable in any artifact: local machine paths and real credentials. */
const COMMON_NO_LEAK = [
  { pattern: /(?:^|[^A-Za-z0-9])[A-Za-z]:\\/, label: 'Windows local absolute path' },
  { pattern: /(?:^|[^A-Za-z0-9])[A-Za-z]:\/(?:SelfPage|Users|Documents|Temp|node_modules)/, label: 'local absolute path' },
  { pattern: /file:\/\/\//i, label: 'file:// URL' },
  { pattern: /\\\\\?\\/, label: 'Windows extended-length path' },
  { pattern: /tests[\\/]fixtures/i, label: 'test fixture path' },
  // R09-18: every GitHub token shape, not just the two the first version knew
  // (ghu_/ghs_). ghp_ is the classic personal access token and github_pat_ the
  // fine-grained one — both are exactly what a stray copy-paste would leak.
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{20,})/,
    label: 'GitHub token literal',
  },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'private key block' },
];

/** Server-side secret names must never reach a browser bundle. */
const NO_SERVER_SECRET_NAMES = [
  { pattern: /\.dev\.vars/i, label: 'reference to .dev.vars' },
  { pattern: /GITHUB_APP_CLIENT_SECRET/, label: 'client-secret variable name' },
  { pattern: /GITHUB_APP_CLIENT_ID/, label: 'GitHub App client id in a public artifact' },
  { pattern: /SESSION_SECRET/, label: 'session-secret variable name' },
  { pattern: /TOKEN_ENCRYPTION_KEY/, label: 'token-encryption-key variable name' },
];

/** The Pages artifact must not carry any part of the test surface. */
const NO_TEST_SURFACE = [
  { pattern: /\/api\/mock\//, label: 'test-only mock endpoint' },
  { pattern: /\/api\/test\/clock/, label: 'test-only clock endpoint' },
  { pattern: /\/api\/test\/reset/, label: 'test-only reset endpoint' },
];

/**
 * The author Worker bundle is where the mock/clock routes are implemented, so
 * it necessarily contains those two route strings and the secret *names* it
 * reads from `env`. What it must never contain is a local path or a credential
 * value; its production 404 behaviour is checked by the author E2E suite.
 */
const WORKER_RULES = COMMON_NO_LEAK;

const SITE_RULES = [...COMMON_NO_LEAK, ...NO_SERVER_SECRET_NAMES, ...NO_TEST_SURFACE];
const CLIENT_RULES = [...COMMON_NO_LEAK, ...NO_SERVER_SECRET_NAMES];

/* -------------------------------------------------------------------------- */
/* preconditions                                                             */
/* -------------------------------------------------------------------------- */

if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) {
  console.error(`error: ${display(siteDir)} does not exist; run \`npm run build\` first`);
  process.exit(2);
}

console.log(`checking public site artifact: ${display(siteDir)} (BASE_PATH=${basePath})`);

/* -------------------------------------------------------------------------- */
/* 1. internal links under the configured base                               */
/* -------------------------------------------------------------------------- */

const linkCheck = spawnSync(
  process.execPath,
  [join(repoRoot, 'tests', 'check-build-links.mjs'), siteDir, basePath],
  { cwd: repoRoot, encoding: 'utf8' },
);
if (linkCheck.status !== 0) {
  const output = `${linkCheck.stdout ?? ''}${linkCheck.stderr ?? ''}`.trim();
  failures.push(`internal link check failed (exit ${linkCheck.status}):\n${output}`);
} else {
  const summary = (linkCheck.stdout ?? '').split('\n')[0];
  console.log(`  ${summary}`);
}

/* -------------------------------------------------------------------------- */
/* 2. no sitemap (task 09 explicitly does not add one)                        */
/* -------------------------------------------------------------------------- */

const sitemaps = walk(siteDir).filter((file) => /sitemap[^\\/]*\.(xml|txt)$/i.test(file));
if (sitemaps.length > 0) {
  failures.push(`public site ships a sitemap that task 09 did not ask for: ${sitemaps.map(display).join(', ')}`);
} else {
  console.log('  no sitemap file in the public site artifact');
}

/* -------------------------------------------------------------------------- */
/* 3. artifact scans                                                         */
/* -------------------------------------------------------------------------- */

function scan({ directory, label, rules }) {
  const files = walk(directory);
  if (files.length === 0) {
    failures.push(`${label}: no files under ${display(directory)}`);
    return;
  }
  let scanned = 0;
  let skipped = 0;
  for (const file of files) {
    if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) {
      skipped += 1;
      continue;
    }
    const contents = readFileSync(file, 'utf8');
    scanned += 1;
    counters.files += 1;
    counters.bytes += Buffer.byteLength(contents, 'utf8');
    for (const rule of rules) {
      const match = rule.pattern.exec(contents);
      rule.pattern.lastIndex = 0;
      if (match) {
        failures.push(`${label}: ${display(file)} contains ${rule.label} — ${JSON.stringify(match[0].slice(0, 80))}`);
      }
    }
  }
  counters.skipped += skipped;
  console.log(
    `  scanned ${scanned} text file(s) in ${display(directory)}${skipped > 0 ? ` (${skipped} binary skipped)` : ''}`,
  );
}

scan({ directory: siteDir, label: 'public site', rules: SITE_RULES });

/* Report the New! target that was baked in, so a placeholder origin is visible. */
const newHrefOrigins = new Set();
for (const file of walk(siteDir)) {
  if (extname(file).toLowerCase() !== '.html') continue;
  for (const match of readFileSync(file, 'utf8').matchAll(/href="(https?:\/\/[^"]*?\/new\/)"/g)) {
    newHrefOrigins.add(match[1]);
  }
}
if (newHrefOrigins.size > 0) {
  const origins = [...newHrefOrigins];
  console.log(`  New! target(s) in the artifact: ${origins.join(', ')}`);
  if (origins.some((origin) => origin.includes('.invalid'))) {
    placeholderNewHref = true;
  }
}

if (existsSync(authorClientDir)) {
  scan({ directory: authorClientDir, label: 'author client', rules: CLIENT_RULES });
  const callSites = walk(authorClientDir)
    .filter((file) => TEXT_EXTENSIONS.has(extname(file).toLowerCase()))
    .filter((file) => /\/api\/mock\/|\/api\/test\/clock/.test(readFileSync(file, 'utf8')));
  if (callSites.length > 0) {
    notes.push(
      `author client keeps ${callSites.length} file(s) that call the test-only endpoints ` +
        `(${callSites.map(display).join(', ')}). A production Worker answers 404 for those routes ` +
        '(APP_ENV unset), which the author E2E production spec asserts; deleting the client code ' +
        'would be a product change, so it is documented rather than silently special-cased.',
    );
  }
} else {
  notes.push(`author client bundle not found at ${display(authorClientDir)} — skipped`);
}

if (existsSync(authorWorkerDir)) {
  scan({ directory: authorWorkerDir, label: 'author worker', rules: WORKER_RULES });
} else {
  notes.push(`author worker bundle not found at ${display(authorWorkerDir)} — skipped`);
}

/* -------------------------------------------------------------------------- */
/* report                                                                    */
/* -------------------------------------------------------------------------- */

console.log('');
if (placeholderNewHref) {
  console.warn(
    'WARNING: the New! link points at the placeholder origin https://selfpage-author.invalid/.\n' +
      '         Anyone who clicks New! on the deployed site will get a failed navigation',
  );
  console.warn(
    '         (DNS/route failure), not the author page. Set PUBLIC_AUTHOR_ORIGIN to the deployed\n' +
      '         author Worker origin, rebuild, and redeploy before you announce the site.\n' +
      '         This is a warning, not a failure: the static pages themselves are fine.',
  );
}
for (const message of notes) console.log(`  note: ${message}`);

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} artifact problem(s) after scanning ${counters.files} text file(s):`);
  for (const message of failures) console.error(`  ${message}`);
  process.exit(1);
}

console.log(
  `\nPASS: public site artifact verified (${counters.files} text files, ${counters.bytes} bytes, BASE_PATH=${basePath}); ` +
    'internal links resolve, no sitemap, no local path, no secret, no test surface in the Pages artifact',
);
