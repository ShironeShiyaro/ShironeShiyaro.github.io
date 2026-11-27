#!/usr/bin/env node
/** Focused debug probe for the P1-3 session retry path. */
import { chromium } from '@playwright/test';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:43256';
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  const events = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/mock/session')) {
      events.push(`request ${request.method()} ${request.url()}`);
    }
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/mock/session')) {
      events.push(`response ${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/mock/session')) {
      events.push(`failed ${request.failure()?.errorText} ${request.url()}`);
    }
  });

  await page.route('**/api/mock/session', () => new Promise(() => {}));
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('post-title').waitFor();
  await page.waitForTimeout(13_000);
  const before = await page.locator('.status-panel--auth').innerText();
  await page.unroute('**/api/mock/session');
  await page.getByTestId('auth-retry').click();
  const states = [];
  for (let index = 0; index < 8; index += 1) {
    await page.waitForTimeout(500);
    states.push({
      at: (index + 1) * 500,
      text: (await page.locator('.status-panel--auth').innerText()).replace(/\s+/g, ' ').slice(0, 160),
      continueVisible: await page.getByTestId('auth-continue').isVisible().catch(() => false),
      retryVisible: await page.getByTestId('auth-retry').isVisible().catch(() => false),
    });
  }
  console.log(JSON.stringify({ before: before.replace(/\s+/g, ' ').slice(0, 200), events, states }, null, 2));
  await page.close();
} finally {
  await browser.close();
}
