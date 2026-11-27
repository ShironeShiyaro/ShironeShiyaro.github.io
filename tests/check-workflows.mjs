#!/usr/bin/env node
/**
 * Structural checks for the two workflows in `.github/workflows/`.
 *
 * Why this exists: the frozen task-09 criteria (D02/D03) are about the shape of
 * the CI and Pages workflows — PR runs must not deploy, the Pages job must sit
 * behind a build job with the `github-pages` environment and only the three
 * minimal permissions, and no secret may be referenced. Those are easy to
 * regress in a one-line edit, and a workflow YAML cannot be type-checked. This
 * script re-reads the two files and fails the normal `npm run check` gate when
 * an invariant is broken.
 *
 * It is deliberately a hand-written, dependency-free reader for the small YAML
 * subset used here (block mappings/sequences, scalars). It does not parse YAML
 * in general; it slices the files by indentation and asserts on the resulting
 * lines, so a reformat is fine but a semantic change is not.
 *
 * Usage: node tests/check-workflows.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const workflowDir = join(repoRoot, '.github', 'workflows');

const RESULTS = [];
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    RESULTS.push(`ok   ${name}`);
  } else {
    failures.push(name);
    RESULTS.push(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function readWorkflow(fileName) {
  const path = join(workflowDir, fileName);
  const text = readFileSync(path, 'utf8');
  return { fileName, path, text, lines: text.split('\n') };
}

/** Lines that are not pure comments; comments may legitimately mention a token. */
function executableLines(lines) {
  return lines.filter((line) => !line.trimStart().startsWith('#'));
}

/**
 * The block belonging to a column-0 `key:`. Ends at the next column-0 token or
 * a column-0 comment, which is how these two files are laid out.
 */
function topLevelBlock(lines, key) {
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) return null;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) || line.trimStart().startsWith('#')) break;
    block.push(line);
  }
  return block;
}

/** A nested `key:` at `indent` spaces inside an already sliced block. */
function nestedBlock(fromLines, key, indent) {
  const pad = ' '.repeat(indent);
  const start = fromLines.findIndex((line) => line.startsWith(`${pad}${key}:`));
  if (start === -1) return null;
  const block = [fromLines[start]];
  for (let index = start + 1; index < fromLines.length; index += 1) {
    const line = fromLines[index];
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    const leading = line.length - line.trimStart().length;
    if (leading <= indent) break;
    block.push(line);
  }
  return block;
}

/** The block of a job (`  <name>:`) inside `jobs:`, up to the next sibling job. */
function jobBlock(lines, name) {
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return null;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || /^\S/.test(line)) break;
    block.push(line);
  }
  return block;
}

/**
 * Strip a YAML trailing comment from one line.
 *
 * `#` starts a comment only at the start of a line or after whitespace, and never
 * inside a quoted scalar — that is why this walks the line instead of using
 * `replace(/\s+#.*$/)`. Without it, the semantically correct
 * `permissions:  # read-only on purpose` reads as the scalar value
 * `# read-only on purpose` and a correct file goes red (a false red is worse than
 * no check: it teaches the next person to delete the assertion).
 */
function stripTrailingComment(line) {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (single) {
      if (char === "'") single = false;
      continue;
    }
    if (double) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === '"') double = false;
      continue;
    }
    if (char === "'") {
      single = true;
      continue;
    }
    if (char === '"') {
      double = true;
      continue;
    }
    if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Parse `key: value` pairs in a block at the given indent (trailing comments dropped). */
function mapping(block, indent = 2) {
  const prefix = ' '.repeat(indent);
  const result = new Map();
  for (const rawLine of block ?? []) {
    const line = stripTrailingComment(rawLine);
    const match = new RegExp(`^${prefix}([A-Za-z0-9_-]+):\\s*(.*)$`).exec(line);
    if (match) result.set(match[1], match[2].trim());
  }
  return result;
}

/**
 * Parse a `permissions:` value in EITHER YAML style:
 *   block:  `permissions:\n  contents: read\n  pages: write`
 *   flow:   `permissions: {contents: read, pages: write, id-token: write}`
 *   scalar: `permissions: read-all` / `write-all`
 * Returns `{ style, entries }`; `entries` is a Map of scope -> level, and a
 * scalar shorthand is reported with `style: 'scalar'` and its value, which every
 * caller here treats as a failure (it is wider than the frozen scope list).
 * Block/flow/scalar are all supported, and trailing comments are stripped first
 * (P2-1) so a correct file with explanations cannot be reported as broken.
 */
function parsePermissions(block) {
  if (!block || block.length === 0) return null;
  const [rawFirst, ...rest] = block;
  const first = stripTrailingComment(rawFirst);
  const inline = first.trim().replace(/^permissions:\s*/, '').trim();
  if (inline !== '') {
    if (inline.startsWith('{')) {
      const entries = new Map();
      for (const match of inline.matchAll(/([A-Za-z0-9_-]+)\s*:\s*([A-Za-z0-9_-]+)/g)) {
        entries.set(match[1], match[2]);
      }
      return { style: 'flow', entries };
    }
    return { style: 'scalar', entries: new Map([['*', inline]]) };
  }
  return { style: 'block', entries: mapping(rest, indentOfBlock(block)) };
}

/** Indent of the first child line of a block (2 for top-level keys, 6 for jobs). */
function indentOfBlock(block) {
  for (const line of block.slice(1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    return line.length - line.trimStart().length;
  }
  return 2;
}

/** True when the parsed permissions are exactly `expected` (Map) and no scalar. */
function permissionsEqual(parsed, expected) {
  if (!parsed || parsed.style === 'scalar') return false;
  if (parsed.entries.size !== expected.size) return false;
  for (const [scope, level] of expected) {
    if (parsed.entries.get(scope) !== level) return false;
  }
  return true;
}

function findIndexMatching(block, pattern) {
  return (block ?? []).findIndex((line) => pattern.test(line));
}

/**
 * The `- name:` step containing the first line matching `pattern`, expanded
 * backwards to its `- ` marker and forwards to the next step or column-0 line.
 */
function enclosingStep(lines, pattern) {
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return null;
  let start = index;
  while (start > 0 && !/^ {6}- \S/.test(lines[start])) start -= 1;
  let end = index + 1;
  while (end < lines.length && !/^ {6}- \S/.test(lines[end]) && !/^\S/.test(lines[end])) end += 1;
  return lines.slice(start, end);
}

const usesLines = (lines) => lines.filter((line) => /^\s*-?\s*uses:/.test(line));
const shaPinned = (line) => /uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}\s*$/.test(line.trimEnd());

/* -------------------------------------------------------------------------- */
/* ci.yml — verification only                                                */
/* -------------------------------------------------------------------------- */

const ci = readWorkflow('ci.yml');
const ciText = executableLines(ci.lines).join('\n');

check(
  'ci: declares no permission beyond contents: read',
  permissionsEqual(
    parsePermissions(topLevelBlock(ci.lines, 'permissions')),
    new Map([['contents', 'read']]),
  ),
  'top-level `permissions:` must contain exactly `contents: read` (block or flow style)',
);

check(
  'ci: pull_request, push to main and workflow_dispatch triggers',
  (() => {
    const block = topLevelBlock(ci.lines, 'on');
    if (!block) return false;
    const text = block.join('\n');
    return (
      /^\s{2}pull_request:$/m.test(text) &&
      /^\s{2}push:$/m.test(text) &&
      /^\s*-\s*main\b/m.test(text) &&
      /^\s{2}workflow_dispatch:$/m.test(text)
    );
  })(),
  'ci.yml must run on pull_request, push (branches: main) and workflow_dispatch',
);

for (const [label, pattern] of [
  ['npm ci', /^\s*run:\s*npm ci\s*$/m],
  ['npm run check', /^\s*run:\s*npm run check\s*$/m],
  ['npm test', /^\s*run:\s*npm test\s*$/m],
  ['npm run build', /^\s*run:\s*npm run build\s*$/m],
  ['npm run check:dist', /^\s*run:\s*npm run check:dist\s*$/m],
  ['npx playwright install msedge', /^\s*run:\s*npx playwright install msedge\s*$/m],
  ['npm run test:e2e', /^\s*run:\s*npm run test:e2e\s*$/m],
]) {
  check(`ci: runs ${label}`, pattern.test(ciText));
}

check(
  'ci: no deployment action and no deploy permission',
  !/deploy-pages|upload-pages-artifact|configure-pages|pages:\s*write|id-token:\s*write|wrangler\s+deploy/i.test(ciText),
  'ci.yml must not be able to deploy; Pages actions belong to pages.yml',
);

check('ci: no secret reference', !/secrets\./i.test(ciText), 'no step may read `secrets.`');
check('ci: has an explicit runner', /^\s+runs-on:\s*\S+/m.test(ciText));

check(
  'ci: uploads test-results/ with if: always()',
  (() => {
    const step = enclosingStep(ci.lines, /actions\/upload-artifact@/);
    if (!step) return false;
    const text = step.join('\n');
    return /^\s+if:\s*always\(\)\s*$/m.test(text) && /^\s+name:\s*ci-site-e2e\s*$/m.test(text) && /test-results\//.test(text);
  })(),
  'E2E evidence must be downloadable from a failed run (upload-artifact + if: always())',
);

check(
  'ci: author E2E runs in its own job and uploads its evidence',
  (() => {
    const runIndex = ci.lines.findIndex((line) => /^ {8}run:\s*npm run test:e2e:author\s*$/.test(line));
    if (runIndex === -1) return false;
    // Walk back to the job header (`  name:` at two spaces).
    let jobStart = runIndex;
    while (jobStart > 0 && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(ci.lines[jobStart])) jobStart -= 1;
    const jobName = ci.lines[jobStart].trim().replace(/:$/, '');
    const job = jobBlock(ci.lines, jobName);
    if (!job) return false;
    const text = job.join('\n');
    return (
      jobName !== 'verify' &&
      /^\s{4}runs-on:\s*\S+/m.test(text) &&
      /actions\/upload-artifact@[0-9a-f]{40}/.test(text) &&
      /^\s+name:\s*ci-author-e2e\s*$/m.test(text) &&
      /^\s+if:\s*always\(\)\s*$/m.test(text) &&
      /test-results\//.test(text)
    );
  })(),
  'the author suite needs its own job, runner and downloadable artifact (ci-author-e2e)',
);

/* -------------------------------------------------------------------------- */
/* pages.yml — the one deployment workflow                                   */
/* -------------------------------------------------------------------------- */

const pages = readWorkflow('pages.yml');
const pagesText = executableLines(pages.lines).join('\n');

check(
  'pages: triggers are push to main and workflow_dispatch only',
  (() => {
    const block = topLevelBlock(pages.lines, 'on');
    if (!block) return false;
    const text = block.join('\n');
    return (
      /^\s{2}push:$/m.test(text) &&
      /^\s*-\s*main\b/m.test(text) &&
      /^\s{2}workflow_dispatch:$/m.test(text) &&
      !/^\s{2}pull_request:/m.test(text)
    );
  })(),
  'pages.yml must deploy on push to main and workflow_dispatch, never on pull_request',
);

check(
  'pages: manual runs are refused outside main',
  (() => {
    const step = enclosingStep(pages.lines, /- name: Refuse a manual deploy from a non-main ref/);
    if (!step) return false;
    const text = step.join('\n');
    return (
      /github\.event_name\s*==\s*'workflow_dispatch'/.test(text) &&
      /github\.ref\s*!=\s*'refs\/heads\/main'/.test(text) &&
      /throw/.test(text)
    );
  })(),
  'workflow_dispatch can start from any branch; a guard must refuse non-main refs before building',
);

check(
  'pages: the main-ref guard takes the ref from env, not from inline interpolation',
  (() => {
    const step = enclosingStep(pages.lines, /- name: Refuse a manual deploy from a non-main ref/);
    if (!step) return false;
    const text = step.join('\n');
    const runStart = step.findIndex((line) => /^\s+run:\s*\|/.test(line));
    const runText = runStart === -1 ? '' : step.slice(runStart).join('\n');
    return (
      /^\s+env:\s*$/m.test(text) &&
      /^\s+WORKFLOW_REF:\s*\$\{\{\s*github\.ref\s*\}\}\s*$/m.test(text) &&
      /\$env:WORKFLOW_REF/.test(runText) &&
      !/\$\{\{/.test(runText)
    );
  })(),
  'interpolating github.ref into a run script lets a branch name inject PowerShell, e.g. foo$(calc)',
);

check(
  'pages: workflow permissions are exactly contents:read / pages:write / id-token:write',
  permissionsEqual(
    parsePermissions(topLevelBlock(pages.lines, 'permissions')),
    new Map([
      ['contents', 'read'],
      ['pages', 'write'],
      ['id-token', 'write'],
    ]),
  ),
  'the three documented scopes, with no extra scope (block or flow style)',
);

const buildJob = jobBlock(pages.lines, 'build');
const deployJob = jobBlock(pages.lines, 'deploy');

check('pages: build job exists', buildJob !== null);
check('pages: deploy job exists', deployJob !== null);

const buildJobText = (buildJob ?? []).join('\n');
const deployJobText = (deployJob ?? []).join('\n');

check(
  'pages: the main-ref guard is the FIRST step of the build job',
  (() => {
    if (!buildJob) return false;
    const firstStep = buildJob.findIndex((line) => /^ {6}- \S/.test(line));
    const guardStep = buildJob.findIndex((line) =>
      /^ {6}- name: Refuse a manual deploy from a non-main ref/.test(line),
    );
    return firstStep !== -1 && guardStep !== -1 && firstStep === guardStep;
  })(),
  'anything ordered before the guard (checkout, build, upload) would run for a refused ref',
);

check(
  'pages: deploy needs build',
  /^    needs:\s*build\s*$/m.test(deployJobText),
  'deploy must not run without the build job',
);

check(
  'pages: deploy uses the github-pages environment',
  /^    environment:$/m.test(deployJobText) &&
    /^\s+name:\s*github-pages\s*$/m.test(deployJobText) &&
    /^\s+url:\s*\$\{\{\s*steps\.deployment\.outputs\.page_url\s*\}\}\s*$/m.test(deployJobText),
  'environment name github-pages plus the deployment page_url',
);

check(
  'pages: build job narrows itself to contents: read',
  permissionsEqual(
    parsePermissions(nestedBlock(buildJob ?? [], 'permissions', 4)),
    new Map([['contents', 'read']]),
  ),
  'the build job must not hold pages:write/id-token:write (block or flow style)',
);

check(
  'pages: deploy job declares no wider permission than the workflow',
  !/^ {4}permissions:/m.test(deployJobText),
  'deploy inherits the three workflow scopes; do not widen them here (block or flow style)',
);

check(
  'pages: build job receives SITE_URL, BASE_PATH and PUBLIC_AUTHOR_ORIGIN',
  /^\s+SITE_URL:\s*\$\{\{\s*vars\.SITE_URL\s*\}\}\s*$/m.test(buildJobText) &&
    /^\s+BASE_PATH:\s*\$\{\{\s*vars\.BASE_PATH\s*\}\}\s*$/m.test(buildJobText) &&
    /^\s+PUBLIC_AUTHOR_ORIGIN:\s*\$\{\{\s*vars\.PUBLIC_AUTHOR_ORIGIN\s*\}\}\s*$/m.test(buildJobText),
  'all three build-time values come from repository variables, never from secrets',
);

check(
  'pages: concurrency group is pages and does not cancel a running deploy',
  (() => {
    const block = topLevelBlock(pages.lines, 'concurrency');
    if (!block) return false;
    const text = block.join('\n');
    return /group:\s*pages\s*$/m.test(text) && /cancel-in-progress:\s*false\s*$/m.test(text);
  })(),
  'one deployment at a time, never cancelled mid-flight',
);

const buildCommandIndex = findIndexMatching(buildJob, /npm run build --workspace @selfpage\/site/);
const verifyIndex = findIndexMatching(buildJob, /npm run check:dist/);
const configureIndex = findIndexMatching(buildJob, /actions\/configure-pages@/);
const uploadIndex = findIndexMatching(buildJob, /actions\/upload-pages-artifact@/);

check('pages: build job builds the site', buildCommandIndex !== -1);
check(
  'pages: artifacts are verified before upload',
  verifyIndex !== -1 && buildCommandIndex !== -1 && verifyIndex > buildCommandIndex,
);
check(
  'pages: build precedes configure-pages',
  configureIndex !== -1 && buildCommandIndex !== -1 && configureIndex > buildCommandIndex,
);
check(
  'pages: configure-pages precedes upload-pages-artifact',
  uploadIndex !== -1 && configureIndex !== -1 && uploadIndex > configureIndex,
);
check(
  'pages: uploads apps/site/dist',
  /^\s+path:\s*apps\/site\/dist\s*$/m.test(buildJobText),
  'the Pages artifact must be the built public site directory',
);
check('pages: deploy job runs deploy-pages', /actions\/deploy-pages@/.test(deployJobText));

check(
  'pages: no secret reference and no manual push/deploy',
  !/secrets\./i.test(pagesText) && !/git\s+push/i.test(pagesText) && !/wrangler\s+deploy/i.test(pagesText),
  'the deployment must use the GITHUB_TOKEN OIDC flow only',
);

/* -------------------------------------------------------------------------- */
/* both workflows                                                            */
/* -------------------------------------------------------------------------- */

for (const workflow of [ci, pages]) {
  const lines = executableLines(workflow.lines);
  const text = lines.join('\n');
  const unscoped = usesLines(lines).filter((line) => !shaPinned(line));
  check(
    `${workflow.fileName}: every action is pinned to a commit SHA`,
    unscoped.length === 0,
    unscoped.length === 0 ? '' : `floating refs: ${unscoped.map((line) => line.trim()).join('; ')}`,
  );
  check(`${workflow.fileName}: no secrets./write-all/pull_request_target`, !/secrets\.|write-all|pull_request_target/i.test(text));
}

const failed = failures.length;
for (const line of RESULTS) console.log(`  ${line}`);
if (failed > 0) {
  console.error(`\nFAIL: ${failed} workflow invariant(s) broken (${RESULTS.length - failed}/${RESULTS.length} ok)`);
  process.exit(1);
}
console.log(`\nPASS: ${RESULTS.length} workflow invariants (ci.yml is verification-only, pages.yml is the only deployer)`);
