#!/usr/bin/env node
/**
 * Independent product-gap probe (task 06), observational evidence.
 *
 * The frozen criteria pass on the fixed-clock happy path; this probe measures
 * the three contract-adjacent gaps found in the previous round after the fix
 * round:
 *
 * A. Date displayed before/after crossing Asia/Shanghai midnight: the visible
 *    date must match the date actually written to the file/front matter.
 * B. U+200B (zero-width space) pasted into the body: is the author's character
 *    preserved in the stored draft/state? (May remain a P2 edge.)
 * C. Hanging GET /api/date: bounded English terminal + explicit Retry.
 * D. Hanging GET /api/mock/session: bounded English terminal + explicit Retry.
 *
 * Needs a running test Worker (APP_ENV=test); caller supplies its URL.
 * Exit code stays 0: evidence collection, not a pass/fail gate.
 */
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:43256';
const FIXED = '2026-11-23T15:42:15Z';
const MIDNIGHT = '2026-11-23T18:42:15Z';

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const out = { baseUrl, A: null, B: null, C: null, D: null };

await post('/api/test/reset');
await post('/api/test/clock', { now: FIXED });

const browser = await chromium.launch({ channel: 'msedge' });
try {
  // ---- A: date displayed vs date written after crossing Shanghai midnight ----
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('post-title').waitFor();
  await page.getByTestId('post-date').waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="post-date"]')?.textContent?.trim() !== 'Loading date…',
  );
  const uiDateBefore = (await page.getByTestId('post-date').innerText()).trim();

  await post('/api/mock/auth', { outcome: 'authorized' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('post-title').waitFor();
  await page.getByTestId('post-title').click();
  await page.keyboard.insertText('Midnight date probe');
  await page.getByTestId('post-body').click();
  await page.keyboard.insertText('A body written before midnight.');

  await post('/api/test/clock', { now: MIDNIGHT });
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/mock/publish') && response.request().method() === 'POST',
  );
  await page.getByTestId('publish-button').click();
  const publishResponse = await responsePromise;
  const publishJson = await publishResponse.json();
  const uiDateAfter = (await page.getByTestId('post-date').innerText()).trim();
  const visibleDateLine = String(publishJson.visibleMarkdown ?? '').split('\n')[2];
  out.A = {
    uiDateBefore,
    serverDate: publishJson.date,
    serverTimestamp: publishJson.timestamp,
    uiDateAfter,
    visibleMarkdownDateLine: visibleDateLine,
    consistent:
      uiDateAfter === publishJson.date &&
      visibleDateLine === publishJson.date &&
      String(publishJson.commit?.path ?? '').includes(publishJson.date),
  };
  await page.close();

  // ---- B: U+200B pasted into the body is stripped from state/storage ----
  const pastePage = await browser.newPage();
  await pastePage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await pastePage.getByTestId('post-body').waitFor();
  await pastePage.getByTestId('post-body').click();
  await pastePage.getByTestId('post-body').evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'before\u200Bafter');
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
  });
  await pastePage.waitForTimeout(800);
  out.B = await pastePage.evaluate(() => {
    const element = document.querySelector('[data-testid="post-body"]');
    const raw = localStorage.getItem('selfpage:author:draft');
    const draft = raw === null ? null : JSON.parse(raw);
    return {
      domTextLength: element?.textContent?.length ?? null,
      domHasZeroWidth: element?.textContent?.includes('\u200B') ?? null,
      storedBody: draft?.body ?? null,
      storedBodyLength: draft?.body?.length ?? null,
    };
  });
  await pastePage.close();

  // ---- C: hanging GET /api/date must reach a bounded terminal with Retry ----
  await post('/api/test/clock', { now: FIXED });
  const hangPage = await browser.newPage();
  await hangPage.route('**/api/date', () => new Promise(() => {}));
  await hangPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await hangPage.getByTestId('post-title').waitFor();
  await hangPage.waitForTimeout(13_000);
  const cBefore = await hangPage.evaluate(() => ({
    dateText: document.querySelector('[data-testid="post-date"]')?.textContent?.trim() ?? null,
    publishDisabled:
      document.querySelector('[data-testid="publish-button"]')?.hasAttribute('disabled') ?? null,
    retryDateButtonPresent: [...document.querySelectorAll('button')].some((button) =>
      /retry date/i.test(button.textContent ?? ''),
    ),
    authText: document.querySelector('.status-panel--auth')?.textContent ?? '',
  }));
  await hangPage.unroute('**/api/date');
  await hangPage.getByRole('button', { name: 'Retry date' }).click();
  await hangPage.waitForTimeout(500);
  const cAfterRetryDate = (await hangPage.getByTestId('post-date').innerText()).trim();
  out.C = { ...cBefore, afterRetryDate: cAfterRetryDate };
  await hangPage.close();

  // ---- D: hanging GET /api/mock/session must reach a bounded terminal ----
  await post('/api/mock/logout');
  const sessionPage = await browser.newPage();
  await sessionPage.route('**/api/mock/session', () => new Promise(() => {}));
  await sessionPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await sessionPage.getByTestId('post-title').waitFor();
  await sessionPage.waitForTimeout(13_000);
  const dBefore = await sessionPage.evaluate(() => ({
    authText: document.querySelector('.status-panel--auth')?.textContent?.trim() ?? null,
    authRetryPresent: Boolean(document.querySelector('[data-testid="auth-retry"]')),
    publishDisabled:
      document.querySelector('[data-testid="publish-button"]')?.hasAttribute('disabled') ?? null,
    backVisible: Boolean(document.querySelector('[data-testid="back-to-blog"]')),
  }));
  await sessionPage.unroute('**/api/mock/session');
  await sessionPage.getByTestId('auth-retry').click();
  const dAfterRetry = await sessionPage
    .getByTestId('auth-continue')
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  out.D = { ...dBefore, afterRetryShowsContinue: dAfterRetry };
  await sessionPage.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify(out, null, 2));
