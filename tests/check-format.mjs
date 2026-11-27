#!/usr/bin/env node
// Dependency-free text hygiene gate: UTF-8 without BOM, LF line endings, no
// trailing whitespace (one Markdown exception, below), and a final newline.
// This is not a style/lint tool; ESLint/Prettier are deferred to task 09 (see
// README and the task ledger).
//
// Trailing whitespace rule, with the D34 exception:
//   * `content/**/*.md` may end a non-blank line with EXACTLY two spaces. That
//     is the standard Markdown hard break (D34, total-control ledger
//     `docs_AI/台账/总控/00-总台账.md`: "行末两个空格 + 换行 = 硬换行"; the
//     author Preview renders it as `<br>`, and Astro does the same on the
//     public site). A real publish that contains a hard break therefore used to
//     fail the CI format gate even though the article is valid — a gate that
//     rejects contract-valid content is a gate bug (R09-9).
//   * Every other trailing-whitespace shape stays an error everywhere,
//     including in content Markdown: one space, three or more spaces, a tab,
//     and a whitespace-only line whose whole run happens to be two spaces
//     (that is not a hard break — there is no text for it to break).
//   * All other directories keep the strict "no trailing whitespace at all"
//     rule; only `content/**/*.md` gets the exception.
//
// Scope: task-owned source, content, tests, docs, root config and task records.
// Evidence under docs_AI/记录/**/assets is raw command output and is excluded;
// agent prompts and planning contracts are owned by total control and excluded.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const includeRoots = ['apps', 'packages', 'content', 'tests', 'docs', '.github'];
const includeFiles = [
  'README.md',
  '.gitattributes',
  '.dev.vars.example',
  'package.json',
  'tsconfig.base.json',
  'tsconfig.tests.json',
  'vitest.config.ts',
  'playwright.config.ts',
];
const includeDocsAIPaths = [
  'docs_AI/规范.md',
  'docs_AI/要求.md',
  'docs_AI/任务总览.md',
  'docs_AI/台账/01-项目骨架与内容数据',
  'docs_AI/台账/02-视觉系统与页面外壳',
  'docs_AI/记录/r01',
  'docs_AI/记录/r02',
];
const textExtensions = new Set([
  '.md',
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.json',
  '.jsonc',
  '.astro',
  '.css',
  '.yml',
  '.yaml',
  '.html',
  '.txt',
]);
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  '.astro',
  '.wrangler',
  'test-results',
  'playwright-report',
  'coverage',
  // Raw command-output evidence is allowed to keep its original encoding/line
  // endings; P2-13 separately converted historical UTF-16LE logs to UTF-8.
  'assets',
]);
const ignoredFiles = new Set(['package-lock.json']);

// Known UTF-8 -> GBK/CP936 mojibake signatures (task 08 review P1-2). This is a
// guard for the error mode we actually hit (a UTF-8 source file re-read with a
// legacy code page and written back), not a general encoding detector. The
// sequences are written as code-point escapes so this detector file does not
// match itself. Not included: the legitimate CJK character U+6F0F, which
// appeared in a real mojibake case but occurs in normal Chinese prose, so it
// would create false positives.
const MOJIBAKE_PATTERNS = [
  ['\u9225', 'UTF-8 read as GBK (lead bytes)'],
  ['\u9286', 'UTF-8 read as GBK (lead bytes)'],
  ['\u951B', 'UTF-8 read as GBK (lead bytes)'],
  ['\u9428', 'UTF-8 read as GBK (lead bytes)'],
  ['\u951F\u65A4\u62F7', 'replacement-character mojibake'],
  ['\uFFFD', 'Unicode replacement character'],
];

/**
 * Finds the first line whose trailing whitespace violates the rule.
 *
 * `allowHardBreaks` is true only for authored article Markdown under
 * `content/`. There, a line is accepted when its trailing run is exactly two
 * spaces AND some non-whitespace text precedes them: that is the D34 Markdown
 * hard break. A trailing run of one space, three or more spaces, any tab, or
 * two spaces on an otherwise blank line is still reported.
 */
function findTrailingWhitespaceIssue(text, allowHardBreaks) {
  const lines = text.split('\n');
  for (const [index, rawLine] of lines.entries()) {
    // CR is reported separately; strip it so a CRLF file still gets the
    // trailing-whitespace verdict it would get once converted to LF.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const match = /^(.*?)([ \t]+)$/u.exec(line);
    if (match === null) continue;
    const [, head, trailing] = match;
    if (allowHardBreaks && trailing === '  ' && head.length > 0) continue;
    if (allowHardBreaks) {
      return `trailing whitespace (line ${index + 1} ends with ${JSON.stringify(trailing)}; content/**/*.md allows exactly two spaces as a Markdown hard break)`;
    }
    return `trailing whitespace (line ${index + 1})`;
  }
  return null;
}

function inspectText(text, options = {}) {
  const issues = [];
  if (text.includes('\r')) issues.push('CRLF or CR line ending (use LF)');
  const trailing = findTrailingWhitespaceIssue(text, options.hardBreaks === true);
  if (trailing !== null) issues.push(trailing);
  if (text.length > 0 && !text.endsWith('\n')) issues.push('missing final newline');
  if (options.mojibake !== false) {
    for (const [sequence, description] of MOJIBAKE_PATTERNS) {
      if (text.includes(sequence)) issues.push(`mojibake sequence "${sequence}" (${description})`);
    }
  }
  return issues;
}

/**
 * The D34 hard-break exception applies to authored article Markdown only.
 * Fixture content trees under `tests/fixtures/` are test data, not published
 * articles, and stay under the strict rule.
 */
function isContentMarkdown(display) {
  return display.startsWith('content/') && display.endsWith('.md');
}

/**
 * The mojibake guard only covers product/test source. Historical acceptance and
 * review evidence under `docs_AI/` is deliberately excluded: two old r04 logs
 * contain a legitimate U+FFFD from captured console output, and rewriting
 * evidence to satisfy a new guard would be worse than the false positive.
 */
function isMojibakeCheckedPath(display) {
  return ['apps/', 'packages/', 'content/', 'tests/'].some((prefix) => display.startsWith(prefix));
}

function readUtf8WithoutBom(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new Error('UTF-8 BOM is not allowed');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('file is not valid UTF-8');
  }
}

function collect(directory, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collect(join(directory, entry.name), files);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
    if (textExtensions.has(extension)) files.push(absolute);
  }
}

function collectScenario() {
  const files = [];
  for (const root of includeRoots) collect(join(repoRoot, root), files);
  for (const file of includeFiles) {
    const absolute = join(repoRoot, file);
    if (existsSync(absolute) && statSync(absolute).isFile()) files.push(absolute);
  }
  for (const entry of includeDocsAIPaths) {
    const absolute = join(repoRoot, entry);
    if (!existsSync(absolute)) continue;
    if (statSync(absolute).isDirectory()) collect(absolute, files);
    else files.push(absolute);
  }
  return [...new Set(files)].sort();
}

function runSelfTest() {
  const contentTrailing = (line, found) =>
    `trailing whitespace (line ${line} ends with ${JSON.stringify(found)}; content/**/*.md allows exactly two spaces as a Markdown hard break)`;
  const cases = [
    ['clean LF file', 'alpha\nbeta\n', []],
    ['clean Chinese text with 漏', '这是正常中文，包含遗漏与漏水。\n', []],
    // D34 hard break: two positives, then the shapes that must stay rejected.
    ['content hard break: exactly two spaces', 'alpha  \nbeta\n', [], { hardBreaks: true }],
    [
      'content hard break inside a prose article',
      '---\ntitle: Example\n---\n\n# Example\n\nFirst line  \nsecond line.\n',
      [],
      { hardBreaks: true },
    ],
    ['content hard break: one trailing space', 'alpha \nbeta\n', [contentTrailing(1, ' ')], { hardBreaks: true }],
    ['content hard break: three trailing spaces', 'alpha   \nbeta\n', [contentTrailing(1, '   ')], { hardBreaks: true }],
    ['content hard break: trailing tab', 'alpha\t\nbeta\n', [contentTrailing(1, '\t')], { hardBreaks: true }],
    ['content hard break: two spaces on a blank line', 'alpha\n  \nbeta\n', [contentTrailing(2, '  ')], { hardBreaks: true }],
    // The exception is scoped: the same two spaces are still an error elsewhere.
    ['two trailing spaces outside content', 'alpha  \nbeta\n', ['trailing whitespace (line 1)'], {}],
    ['CRLF file', 'alpha\r\nbeta\r\n', ['CRLF or CR line ending (use LF)']],
    ['trailing spaces', 'alpha \nbeta\n', ['trailing whitespace (line 1)']],
    ['trailing tab', 'alpha\t\nbeta\n', ['trailing whitespace (line 1)']],
    ['no final newline', 'alpha\nbeta', ['missing final newline']],
    [
      'mojibake lead-byte sequence',
      'copyright \u6F0F 2026 \u9225? dash\n',
      ['mojibake sequence "\u9225" (UTF-8 read as GBK (lead bytes))'],
    ],
  ];
  let failed = 0;
  for (const [name, text, expected, options] of cases) {
    const actual = inspectText(text, options);
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
      failed += 1;
      console.error(`SELF-TEST FAIL ${name}: ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'selfpage-format-'));
  try {
    const bomPath = join(directory, 'bom.md');
    writeFileSync(bomPath, Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0a]));
    let bomRejected = false;
    try {
      readUtf8WithoutBom(bomPath);
    } catch {
      bomRejected = true;
    }
    if (!bomRejected) {
      failed += 1;
      console.error('SELF-TEST FAIL UTF-8 BOM was not rejected');
    }
    const invalidPath = join(directory, 'invalid.md');
    writeFileSync(invalidPath, Buffer.from([0xc3, 0x28]));
    let invalidRejected = false;
    try {
      readUtf8WithoutBom(invalidPath);
    } catch {
      invalidRejected = true;
    }
    if (!invalidRejected) {
      failed += 1;
      console.error('SELF-TEST FAIL invalid UTF-8 was not rejected');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  if (failed > 0) {
    console.error(`FAIL: ${failed} format self-test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(
      'PASS: format self-test (LF, trailing whitespace incl. the content/**/*.md D34 hard-break exception, final newline, UTF-8 BOM, invalid UTF-8)',
    );
  }
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else if (process.argv.includes('--list-files')) {
  for (const absolute of collectScenario()) {
    console.log(relative(repoRoot, absolute).split('\\').join('/'));
  }
} else {
  const uniqueFiles = collectScenario();
  const failures = [];
  for (const absolute of uniqueFiles) {
    const display = relative(repoRoot, absolute).split('\\').join('/');
    try {
      const text = readUtf8WithoutBom(absolute);
      for (const issue of inspectText(text, {
        mojibake: isMojibakeCheckedPath(display),
        hardBreaks: isContentMarkdown(display),
      })) {
        failures.push(`${display}: ${issue}`);
      }
    } catch (error) {
      failures.push(`${display}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} format issue(s) in ${uniqueFiles.length} text file(s)`);
    for (const failure of failures.slice(0, 100)) console.error(`  ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `PASS: ${uniqueFiles.length} text files are UTF-8 (no BOM), LF, no forbidden trailing whitespace (content/**/*.md allows only the D34 two-space hard break), final newline; source files have no known mojibake sequence`,
    );
  }
}
