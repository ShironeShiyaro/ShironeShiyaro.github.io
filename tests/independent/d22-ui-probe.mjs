#!/usr/bin/env node
/**
 * D22 UI-level probe (independent test evidence, task 06).
 *
 * Verifies in the real editor that titles containing `:` or `?` are rejected
 * client-side with the English reserved-character message and send no publish
 * request, while `"`/`*`/`<` still publish with the exact H1 and a valid
 * title/date front matter. Expects a running test Worker (APP_ENV=test).
 *
 * Exit 1 if any case regresses; 0 when D22 UI behavior is conformant.
 */
import { chromium } from '@playwright/test';
import { parse as parseYaml } from 'yaml';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:43256';

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return response.status;
}

await post('/api/test/reset');
await post('/api/test/clock', { now: '2026-11-23T15:42:15Z' });
await post('/api/mock/auth', { outcome: 'authorized' });

const rows = [];
let failed = false;

function check(name, condition, detail) {
  if (!condition) {
    failed = true;
  }
  rows.push({ case: name, result: condition ? 'PASS' : 'FAIL', detail });
}

async function setEditor(page, field, value) {
  await page.getByTestId(`post-${field}`).evaluate((element, text) => {
    element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }, value);
}

const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  const publishRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/mock/publish') && request.method() === 'POST') {
      publishRequests.push(request.url());
    }
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('post-title').waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="post-date"]')?.textContent?.trim() !== 'Loading date…',
  );

  for (const [title, character] of [
    ['Notes: part 1', ':'],
    ['Why?', '?'],
  ]) {
    const before = publishRequests.length;
    await setEditor(page, 'title', title);
    await setEditor(page, 'body', 'A body.');
    await page.getByTestId('publish-button').click();
    await page.waitForTimeout(700); // allow the date preflight + client validation to render
    const errorText = (await page.locator('.field-errors').allInnerTexts()).join(' ');
    check(
      `reject ${JSON.stringify(title)}`,
      errorText.includes(`Title contains "${character}"`) &&
        publishRequests.length === before,
      { errorText: errorText.slice(0, 160), publishRequests: publishRequests.length - before },
    );
  }

  const title = 'A "B" * <C>';
  await setEditor(page, 'title', title);
  await setEditor(page, 'body', 'A body.');
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/mock/publish') && response.request().method() === 'POST',
  );
  await page.getByTestId('publish-button').click();
  const response = await responsePromise;
  const json = await response.json();
  const yaml = /^---\n([\s\S]*?)\n---\n\n/.exec(json.markdown ?? '')?.[1] ?? '';
  const parsed = yaml === '' ? {} : parseYaml(yaml);
  const h1 = String(json.visibleMarkdown ?? '').split('\n')[0];
  check(
    'publish D22-allowed characters',
    response.status() === 201 &&
      JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(['date', 'title']) &&
      parsed.title === title &&
      h1 === `# ${title}`,
    { httpStatus: response.status(), keys: Object.keys(parsed).sort(), h1, yaml },
  );

  await page.close();
} finally {
  await browser.close();
}

for (const row of rows) {
  console.log(`${row.result} ${row.case} ${JSON.stringify(row.detail)}`);
}
console.log(`\nD22 UI CONFORMANCE: ${failed ? 'FAIL' : 'PASS'} (${rows.filter((row) => row.result === 'FAIL').length}/${rows.length} failed)`);
process.exit(failed ? 1 : 0);
