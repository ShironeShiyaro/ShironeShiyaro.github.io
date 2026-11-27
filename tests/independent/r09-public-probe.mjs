#!/usr/bin/env node
/**
 * Independent task-09 public-site probe (test subagent).
 *
 * Loads the public site in the system Edge channel and records, for each page:
 * HTTP status, title, first H1, the New! target, every request URL, console
 * errors and uncaught page errors. Used for two frozen criteria:
 *
 *   D10  the public site (astro preview, no author Worker running) is readable
 *        and makes no cross-origin / backend request; New! points at the
 *        configured author origin (a placeholder when PUBLIC_AUTHOR_ORIGIN is
 *        unset — the link target is checked, the author app is not).
 *   R09-7 the public site ships no CSP meta; if one ever appears, console CSP
 *        "refused to execute" messages are captured here so the inline-script
 *        breakage cannot pass silently.
 *
 * Usage: node tests/independent/r09-public-probe.mjs <base-url> <out.json>
 * Exit code 0 only when every page is 200, has an H1, produces no console/page
 * errors and issues no cross-origin request.
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const base = process.argv[2];
const outFile = process.argv[3];
if (!base || !outFile) {
  console.error('usage: node tests/independent/r09-public-probe.mjs <base-url> <out.json>');
  process.exit(2);
}
const origin = new URL(base).origin;

const paths = [
  '/',
  '/publications/',
  '/blog/',
  '/blog/2026/Why I Keep a Learning Log-2026-01-18-20-15-00/',
  '/settings/',
];

const browser = await chromium.launch({ channel: 'msedge' });
const results = [];
try {
  for (const path of paths) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    const consoleErrors = [];
    const pageErrors = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    const url = new URL(path, base).href;
    let status = null;
    let title = null;
    let h1 = null;
    let newHref = null;
    let cspMetaCount = 0;
    let loadError = null;
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
      status = response === null ? null : response.status();
      await page.waitForTimeout(400);
      title = await page.title();
      h1 = await page.locator('h1').first().innerText().catch(() => null);
      // The public shell appends the preference hand-off fragment at runtime
      // (`/new/#theme=...`), so match the path, not a trailing slash.
      newHref = await page
        .locator('a[href*="/new/"]')
        .first()
        .getAttribute('href')
        .catch(() => null);
      cspMetaCount = await page
        .locator('meta[http-equiv="Content-Security-Policy" i]')
        .count()
        .catch(() => -1);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
    await context.close();

    const crossOrigin = requests.filter((requestUrl) => {
      try {
        return new URL(requestUrl).origin !== origin;
      } catch {
        return true;
      }
    });
    const cspViolations = consoleErrors.filter((text) =>
      /content security policy|refused to (execute|load|apply)/i.test(text),
    );
    results.push({
      path,
      url,
      status,
      title,
      h1: h1 === null ? null : h1.replace(/\s+/g, ' ').trim(),
      newHref,
      cspMetaCount,
      cspViolations,
      crossOrigin,
      consoleErrors,
      pageErrors,
      requestCount: requests.length,
      loadError,
    });
  }
} finally {
  await browser.close();
}

const problems = [];
for (const result of results) {
  if (result.loadError) problems.push(`${result.path}: load error ${result.loadError}`);
  if (result.status !== 200) problems.push(`${result.path}: HTTP ${result.status}`);
  if (!result.h1) problems.push(`${result.path}: no H1 text`);
  if (result.cspMetaCount !== 0) problems.push(`${result.path}: ${result.cspMetaCount} CSP meta tag(s)`);
  if (result.path.startsWith('/blog/')) {
    if (!result.newHref) problems.push(`${result.path}: no New! link found`);
    else if (!result.newHref.includes('/new/')) {
      problems.push(`${result.path}: New! href ${result.newHref} is not an author /new/ target`);
    }
  }
  if (result.crossOrigin.length > 0) {
    problems.push(`${result.path}: cross-origin request(s) ${result.crossOrigin.join(', ')}`);
  }
  if (result.cspViolations.length > 0) {
    problems.push(`${result.path}: CSP violation(s) ${result.cspViolations.join(' | ')}`);
  }
  if (result.pageErrors.length > 0) {
    problems.push(`${result.path}: page error(s) ${result.pageErrors.join(' | ')}`);
  }
}

writeFileSync(outFile, `${JSON.stringify({ base, results, problems }, null, 2)}\n`, 'utf8');
for (const result of results) {
  console.log(
    `${result.status} ${result.path} title=${JSON.stringify(result.title)} ` +
      `h1=${JSON.stringify(result.h1)} newHref=${JSON.stringify(result.newHref)} ` +
      `requests=${result.requestCount} crossOrigin=${result.crossOrigin.length} ` +
      `consoleErrors=${result.consoleErrors.length} pageErrors=${result.pageErrors.length}`,
  );
}
if (problems.length > 0) {
  console.error(`\nFAIL: ${problems.length} public-site problem(s):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('\nPASS: all public pages readable with no cross-origin/backend request and no CSP violation');
