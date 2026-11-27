#!/usr/bin/env node
/**
 * Guards one rule that was broken twice (R09-6 for task 06's evidence, R09-16/R09-19 for
 * r07/r075/r03): a test/runner file may not reference `docs_AI/` at all — writing
 * there silently replaces the committed log of an earlier round, so "the number I
 * just measured" and "the number in the repository" stop being distinguishable
 * (that caused the 69/76/79/80 ambiguity during task 08).
 *
 * Rule: every non-comment line under `tests/**` that contains the literal
 * `docs_AI` is a failure, unless the file is allowlisted below.
 *
 * COVERAGE BOUNDARY (do not over-read this guard):
 *   * covered: a direct path string, and construction such as
 *     `['docs_AI','记录','x'].join('/')` or `join(root,'docs_AI',...)` — the
 *     literal appears on that line, so the line is reported. An earlier version
 *     only matched `join(`/`mkdirSync(` with the literal inside the parentheses,
 *     so the array-then-join form passed (P2-3).
 *   * NOT covered: building the token out of pieces (`'docs' + '_AI'`), reading
 *     it from the environment, or a file outside `tests/`. This is an
 *     accident-prevention check, not a sandbox.
 *
 * Allowlist (each reason is a read-only or self-reference case):
 *   * tests/check-format.mjs            — reads a few docs_AI paths in its include list
 *   * tests/check-test-output-paths.mjs — this guard: mentions the string only in
 *                                         its own messages
 *
 * Usage: node tests/check-test-output-paths.mjs
 * Exit: 0 pass, 1 a test file references historical evidence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const testsDir = join(repoRoot, 'tests');
const TOKEN = 'docs_AI';

const ALLOWLIST = new Set(['tests/check-format.mjs', 'tests/check-test-output-paths.mjs']);

function collect(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collect(absolute));
    else if (entry.isFile() && /\.(?:mjs|js|ts)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

const offenders = [];
let scanned = 0;
let allowlisted = 0;
for (const file of collect(testsDir)) {
  const display = relative(repoRoot, file).split('\\').join('/');
  scanned += 1;
  if (ALLOWLIST.has(display)) {
    allowlisted += 1;
    continue;
  }
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (line.includes(TOKEN)) offenders.push(`${display}:${index + 1}: ${trimmed}`);
    });
}

if (offenders.length > 0) {
  console.error(`FAIL: ${offenders.length} reference(s) to ${TOKEN}/ under tests/ in ${scanned} file(s):`);
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error('');
  console.error('Test output belongs in gitignored `test-results/<suite>/` (R09-6 / R09-16 / R09-19):');
  console.error('docs_AI/记录/**/assets/ is tracked historical evidence and must stay byte-identical.');
  process.exit(1);
}

console.log(
  `PASS: no test file references ${TOKEN}/ (${scanned} file(s) scanned, ${allowlisted} allowlisted); ` +
    'covers direct strings and array/join construction, not tokens split across literals',
);
