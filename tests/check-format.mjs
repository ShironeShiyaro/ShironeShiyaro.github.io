#!/usr/bin/env node
// Dependency-free text hygiene gate: UTF-8 without BOM, LF line endings, no
// trailing whitespace, and a final newline. This is not a style/lint tool;
// ESLint/Prettier are deferred to task 09 (see README and the task ledger).
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

function inspectText(text, options = {}) {
  const issues = [];
  if (text.includes('\r')) issues.push('CRLF or CR line ending (use LF)');
  if (/[ \t]+$/m.test(text)) issues.push('trailing whitespace');
  if (text.length > 0 && !text.endsWith('\n')) issues.push('missing final newline');
  if (options.mojibake !== false) {
    for (const [sequence, description] of MOJIBAKE_PATTERNS) {
      if (text.includes(sequence)) issues.push(`mojibake sequence "${sequence}" (${description})`);
    }
  }
  return issues;
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
  const cases = [
    ['clean LF file', 'alpha\nbeta\n', []],
    ['clean Chinese text with 漏', '这是正常中文，包含遗漏与漏水。\n', []],
    ['CRLF file', 'alpha\r\nbeta\r\n', ['CRLF or CR line ending (use LF)']],
    ['trailing spaces', 'alpha \nbeta\n', ['trailing whitespace']],
    ['trailing tab', 'alpha\t\nbeta\n', ['trailing whitespace']],
    ['no final newline', 'alpha\nbeta', ['missing final newline']],
    [
      'mojibake lead-byte sequence',
      'copyright \u6F0F 2026 \u9225? dash\n',
      ['mojibake sequence "\u9225" (UTF-8 read as GBK (lead bytes))'],
    ],
  ];
  let failed = 0;
  for (const [name, text, expected] of cases) {
    const actual = inspectText(text);
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
    console.log('PASS: format self-test (LF, trailing whitespace, final newline, UTF-8 BOM, invalid UTF-8)');
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
      for (const issue of inspectText(text, { mojibake: isMojibakeCheckedPath(display) })) {
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
      `PASS: ${uniqueFiles.length} text files are UTF-8 (no BOM), LF, no trailing whitespace, final newline; source files have no known mojibake sequence`,
    );
  }
}
