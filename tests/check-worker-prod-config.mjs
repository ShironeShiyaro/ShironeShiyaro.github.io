#!/usr/bin/env node
/**
 * Production-config guard for the author Worker (`apps/author/wrangler.jsonc`).
 *
 * Task 09 criterion D06 says the production Worker must answer 404 for
 * `/api/mock/publish` and `/api/test/clock`. That is enforced at runtime by
 * `isMockSurfaceEnabled()`/`isTestEnvironment()` in `apps/author/worker/env.ts`,
 * which both require `APP_ENV === 'test'`. The way that guarantee gets lost in
 * practice is a deploy-time one: someone adds `vars.APP_ENV = "test"` to the
 * Wrangler config, or runs `wrangler deploy --var APP_ENV:test`. This script
 * makes the config half of that impossible to merge silently, and
 * `npm run deploy:author` runs it before it builds or uploads anything.
 *
 * Usage: node tests/check-worker-prod-config.mjs
 * Exit: 0 pass, 1 a production-config invariant is broken.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const configPath = join(repoRoot, 'apps', 'author', 'wrangler.jsonc');
const failures = [];
const facts = [];

function fail(message) {
  failures.push(message);
}

/** Remove `//` and block comments while leaving string contents untouched. */
function stripComments(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

/** Remove trailing commas before `}`/`]` outside strings (JSONC tolerance). */
function stripTrailingCommas(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === '}' || text[lookahead] === ']') continue;
    }
    output += char;
  }
  return output;
}

if (!existsSync(configPath)) {
  console.error(`error: ${configPath} is missing`);
  process.exit(1);
}

const raw = readFileSync(configPath, 'utf8');
let config;
try {
  config = JSON.parse(stripTrailingCommas(stripComments(raw)));
} catch (error) {
  console.error(`error: apps/author/wrangler.jsonc is not valid JSONC: ${error.message}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* production must not enable the test surface                               */
/* -------------------------------------------------------------------------- */

const text = stripComments(raw);
if (/APP_ENV/.test(text)) {
  const offender =
    text.split('\n').find((candidate) => candidate.includes('APP_ENV')) ??
    raw.split('\n').find((candidate) => candidate.includes('APP_ENV')) ??
    '';
  fail(`wrangler.jsonc mentions APP_ENV — production must leave it unset (${offender.trim()})`);
} else {
  facts.push('no APP_ENV anywhere: the deployed Worker runs in production mode (mock publish and test clock return 404)');
}
if (config.vars && typeof config.vars === 'object' && Object.keys(config.vars).length > 0) {
  facts.push(`plain-text vars present: ${Object.keys(config.vars).join(', ')} (review that none is test-only)`);
}

/* -------------------------------------------------------------------------- */
/* same-origin static assets + API                                           */
/* -------------------------------------------------------------------------- */

if (typeof config.name !== 'string' || config.name.trim() === '') {
  fail('missing Worker `name`');
} else {
  facts.push(`worker name: ${config.name}`);
}

if (typeof config.main !== 'string' || !existsSync(join(repoRoot, 'apps', 'author', config.main))) {
  fail(`\`main\` must point at an existing Worker entry (got ${JSON.stringify(config.main)})`);
}

const assets = config.assets;
if (!assets || typeof assets !== 'object') {
  fail('missing `assets` block: the Worker serves the author app from its own origin (same-origin static assets + API)');
} else {
  if (typeof assets.directory !== 'string' || assets.directory.trim() === '') {
    fail('assets.directory is required');
  }
  if (assets.binding !== 'ASSETS') {
    fail(`assets.binding must be ASSETS (got ${JSON.stringify(assets.binding)}); the Worker reads env.ASSETS`);
  }
  if (!Array.isArray(assets.run_worker_first) || !assets.run_worker_first.includes('/api')) {
    fail('assets.run_worker_first must include /api so API routes reach the Worker, not the asset fallback');
  }
  facts.push(`static assets: ${String(assets.directory)} bound as ${String(assets.binding)}`);
}

/* -------------------------------------------------------------------------- */
/* single-author fixed Durable Object                                        */
/* -------------------------------------------------------------------------- */

const bindings = config.durable_objects?.bindings;
if (!Array.isArray(bindings) || bindings.length !== 1) {
  fail(`expected exactly one Durable Object binding (single author), got ${JSON.stringify(bindings)}`);
} else {
  const [binding] = bindings;
  if (binding.name !== 'AUTHOR_STORE') {
    fail(`Durable Object binding must be named AUTHOR_STORE (got ${JSON.stringify(binding.name)})`);
  }
  if (binding.class_name !== 'AuthorStore') {
    fail(`Durable Object binding must use class_name AuthorStore (got ${JSON.stringify(binding.class_name)})`);
  }
  if (binding.script_name) {
    fail('AUTHOR_STORE must be a class binding in this Worker, not a binding to another script');
  }
  facts.push(`one Durable Object binding: ${String(binding.name)} -> class ${String(binding.class_name)}`);
}

const migrations = config.migrations;
if (!Array.isArray(migrations) || migrations.length === 0) {
  fail('missing `migrations`: a Durable Object class needs a migration before it can be deployed');
} else {
  const createsStore = migrations.some(
    (migration) =>
      Array.isArray(migration?.new_sqlite_classes) && migration.new_sqlite_classes.includes('AuthorStore'),
  );
  if (!createsStore) {
    fail('no migration creates AuthorStore via new_sqlite_classes (the free plan needs SQLite-backed Durable Objects)');
  } else {
    const tags = migrations.map((migration) => migration.tag).join(', ');
    facts.push(`migration(s) creating AuthorStore with new_sqlite_classes: ${tags}`);
  }
}

if (typeof config.compatibility_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date)) {
  fail('compatibility_date must be an explicit YYYY-MM-DD date');
} else {
  facts.push(`compatibility_date: ${config.compatibility_date}`);
}

/* -------------------------------------------------------------------------- */
/* report                                                                    */
/* -------------------------------------------------------------------------- */

for (const fact of facts) console.log(`  ${fact}`);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} production Worker config problem(s):`);
  for (const message of failures) console.error(`  ${message}`);
  process.exit(1);
}
console.log('\nPASS: apps/author/wrangler.jsonc is deployable in production mode (no APP_ENV, same-origin assets, one AUTHOR_STORE Durable Object)');
