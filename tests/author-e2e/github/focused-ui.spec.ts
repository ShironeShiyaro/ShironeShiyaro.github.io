import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../console-guard.ts';

const BASE = process.env.AUTHOR_GITHUB_BASE_URL ?? 'http://localhost:43262';
const MOCK = process.env.AUTHOR_MOCK_BASE ?? 'http://127.0.0.1:43261';
const FIXED = '2026-11-23T15:42:15Z';

async function resetAll(request: APIRequestContext): Promise<void> {
  const mock = await request.post(`${MOCK}/__mock/reset`);
  expect(mock.status(), await mock.text()).toBe(200);
  const worker = await request.post(`${BASE}/api/test/reset`);
  expect(worker.status(), await worker.text()).toBe(200);
  const clock = await request.post(`${BASE}/api/test/clock`, { data: { now: FIXED } });
  expect(clock.status(), await clock.text()).toBe(200);
}

async function control(
  request: APIRequestContext,
  scenario: Record<string, unknown>,
): Promise<void> {
  const response = await request.post(`${MOCK}/__mock/control`, { data: { scenario } });
  expect(response.status(), await response.text()).toBe(200);
}

async function mockState(request: APIRequestContext): Promise<{ counters: Record<string, number> }> {
  const response = await request.get(`${MOCK}/__mock/state`);
  expect(response.status()).toBe(200);
  return response.json();
}

async function setEditorValue(page: Page, field: 'title' | 'body', value: string): Promise<void> {
  const locator = page.getByTestId(`post-${field}`);
  await locator.evaluate((element, text) => {
    element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }, value);
  await page.waitForTimeout(700);
}

async function authorizeThroughGitHub(page: Page): Promise<void> {
  await expect(page.getByTestId('auth-continue')).toBeVisible();
  await page.getByTestId('auth-continue').click();
  // D30: authorized sessions go straight to the editor (Logout in the top bar).
  await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 30_000 });
}

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.describe('focused independent fix retest UI', () => {
  test('P1-2: /new/ loads the real SPA editor with security headers', async ({ page }) => {
    const response = await page.goto('/new/');
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['access-control-allow-origin']).toBeUndefined();
    // R075-4: `/new/` serves the gate for a visitor without an author session.
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
  });

  test('P2b: a 401 publish clears the session into the expired gate with exactly one auth Back hook', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await setEditorValue(page, 'title', 'Strict back hook');
    await setEditorValue(page, 'body', 'One publish Back hook.');
    await control(request, { put: '401' });
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    expect((await responsePromise).status()).toBe(401);
    // R075-4: the expired authorization is the gate again (no editor/publish
    // panel), so only the auth Back hook exists and the draft stays stored.
    await expect(page.getByText(/Your GitHub authorization expired/)).toBeVisible();
    await expect(page.getByTestId('auth-status-back')).toHaveCount(1);
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('status-back')).toHaveCount(0);
    await expect(page.getByTestId('publish-reauthorize')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('selfpage:author:draft') ?? ''))
      .toContain('Strict back hook');
  });

  test('P2c: A06 Recheck permissions re-reads session without OAuth and keeps the draft', async ({
    page,
    request,
  }) => {
    const startRequests: string[] = [];
    page.on('request', (captured) => {
      if (captured.url().includes('/auth/github/start')) startRequests.push(captured.url());
    });

    // R075-4: write the draft while signed in; the permission terminal itself is
    // a gate, so the draft is restored after the installation is fixed.
    await control(request, { installation: 'default' });
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await setEditorValue(page, 'title', 'Permission draft survives');
    await setEditorValue(page, 'body', 'Recheck must keep this draft.');
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-continue')).toBeVisible();

    await control(request, { installation: 'none' });
    await page.getByTestId('auth-continue').click();
    await expect(page.getByText(/The GitHub App cannot write to this repository/)).toBeVisible({
      timeout: 30_000,
    });
    const authPanel = page.locator('.status-panel--auth');
    await expect(authPanel.getByTestId('auth-recheck')).toHaveText(/Recheck permissions/u);
    await expect(authPanel.getByTestId('review-permissions')).toBeVisible();
    await expect(authPanel.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);

    const startsBefore = startRequests.length;
    await page.getByTestId('auth-recheck').click();
    await expect(page.getByTestId('auth-recheck-status')).toContainText(/still reports/u);
    expect(startRequests.length).toBe(startsBefore);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('selfpage:author:draft') ?? ''))
      .toContain('Permission draft survives');

    // Fixing the installation and reauthorizing restores the kept draft.
    await control(request, { installation: 'default' });
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('post-title')).toHaveText('Permission draft survives');
    await expect(page.getByTestId('post-body')).toHaveText('Recheck must keep this draft.');
    expect((await mockState(request)).counters.putRequests).toBe(0);
  });
});
