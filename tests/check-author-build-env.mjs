#!/usr/bin/env node
/**
 * Deploy-time guard for the author build's public-site origin (R09-11).
 *
 * The author app is a separate origin, so its shell bakes the public site origin
 * into the bundle at build time (apps/author/vite.config.ts → siteNavPlugin).
 * Without PUBLIC_SITE_ORIGIN the build silently uses http://localhost:4321, and
 * every "Back to Blog" / left-navigation link in the *deployed* author app then
 * points at the user's own machine. A console warning is not enough — by the time
 * someone notices, a production artifact is already uploaded.
 *
 * This script runs first in `npm run deploy:author` and refuses to continue
 * unless the effective origin is an explicit, absolute, https origin that is not
 * a loopback address. It reads exactly the sources the build reads:
 *   1. apps/author/.env.production.local, .env.production, .env.local, .env
 *      (later file wins, same as Vite's loadEnv order), then
 *   2. process.env, which wins over every file (packages/... `resolveBuildEnv`).
 *
 * Deliberately NOT gated: `npm run dev:author`, `npm run dev:author:github`
 * (they do not deploy) and `npm test` (a checkout without a production origin
 * must still run its tests).
 *
 * Usage: node tests/check-author-build-env.mjs
 * Exit: 0 usable production origin, 1 missing/unsafe origin.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const authorDir = join(repoRoot, 'apps', 'author');

const ENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

function readDotenv(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

const fromFiles = {};
for (const file of ENV_FILES) {
  Object.assign(fromFiles, readDotenv(join(authorDir, file)));
}

const fromProcess = (process.env.PUBLIC_SITE_ORIGIN ?? '').replace(/^\uFEFF/, '').trim();
const value = fromProcess !== '' ? fromProcess : (fromFiles.PUBLIC_SITE_ORIGIN ?? '').trim();
const source = fromProcess !== '' ? 'process environment' : 'apps/author/.env*';

function fail(headline, details) {
  console.error(`FAIL: ${headline}`);
  for (const detail of details) console.error(`  ${detail}`);
  console.error('');
  console.error('Set it for the build, for example in PowerShell:');
  console.error("  $env:PUBLIC_SITE_ORIGIN='https://<username>.github.io/'");
  console.error('or put the same line in apps/author/.env.local (gitignored).');
  console.error('A value in the repository-root .dev.vars does NOT reach the Vite build:');
  console.error('that file is only read by Wrangler for the Worker runtime.');
  process.exit(1);
}

if (value === '') {
  fail('PUBLIC_SITE_ORIGIN is not set, refusing to deploy the author app', [
    'Without it the author bundle links every "Back to Blog" and left-navigation item to',
    'http://localhost:4321 — correct on the author\'s own machine, dead for every visitor.',
    `Looked at: ${source} and apps/author/{${ENV_FILES.join(',')}}.`,
  ]);
}

let url;
try {
  url = new URL(value);
} catch {
  fail(`PUBLIC_SITE_ORIGIN is not an absolute URL: ${JSON.stringify(value)}`, [
    'Expected something like https://<username>.github.io/ (trailing slash optional).',
  ]);
}

const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
if (loopback || url.protocol !== 'https:') {
  const problems = [];
  if (url.protocol !== 'https:') problems.push(`protocol is ${url.protocol}, must be https:`);
  if (loopback) problems.push(`host is ${url.hostname}, a loopback address the deployed app cannot reach`);
  fail(`PUBLIC_SITE_ORIGIN is not usable for a deployment: ${JSON.stringify(value)}`, [
    ...problems,
    'A deployed author app must link back to the real public site, not to a local server.',
  ]);
}

if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
  fail(`PUBLIC_SITE_ORIGIN must be a bare origin without credentials, query or fragment: ${JSON.stringify(value)}`, [
    'The author shell appends paths and hashes itself.',
  ]);
}

const normalized = url.pathname.endsWith('/') ? url.href : `${url.href}/`;
console.log(`  PUBLIC_SITE_ORIGIN (${source}): ${normalized}`);
console.log('  the author build will link "Back to Blog" and the left navigation to this origin');
console.log('\nPASS: author build has an explicit https public-site origin; deployment may proceed');
