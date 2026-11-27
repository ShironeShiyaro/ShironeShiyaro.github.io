import type {
  APIRequestContext,
  Page,
  Response as PlaywrightResponse,
} from '@playwright/test';
import { expect, test } from '../console-guard.ts';

const BASE = process.env.AUTHOR_GITHUB_BASE_URL ?? 'http://localhost:43262';
const MOCK = process.env.AUTHOR_MOCK_BASE ?? 'http://127.0.0.1:43261';
const FIXED = '2026-11-23T15:42:15Z';
const SECRET_PATTERN = /ghu_|ghr_|client_secret|access_token|refresh_token|code_verifier|oauth_state|BEGIN [A-Z ]*PRIVATE KEY/iu;

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

async function mockState(request: APIRequestContext): Promise<{
  commits: Array<{ sha: string; path: string; content: string; message: string }>;
  files: Array<{ path: string; content: string; sha: string }>;
  counters: Record<string, number>;
}> {
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
  await page.waitForTimeout(700); // draft save debounce is 500 ms
}

async function authorizeThroughGitHub(page: Page): Promise<void> {
  await expect(page.getByTestId('auth-continue')).toBeVisible();
  await page.getByTestId('auth-continue').click();
  // D30: authorized sessions go straight to the editor (Logout in the top bar).
  await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 30_000 });
}

async function publishAndWait(page: Page): Promise<PlaywrightResponse> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
  );
  await page.getByTestId('publish-button').click();
  return responsePromise;
}

async function waitForDeployment(page: Page): Promise<PlaywrightResponse> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/deployments/') && response.request().method() === 'GET',
  );
  return responsePromise;
}

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.describe('independent real GitHub route UI', () => {
  test('A02/A17: 30s no auto OAuth, explanation/Continue/Back visible, CSP editor works', async ({
    page,
  }) => {
    const startRequests: string[] = [];
    page.on('request', (captured) => {
      if (captured.url().includes('/auth/github/start')) startRequests.push(captured.url());
    });

    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    const csp = (await response?.allHeaders())?.['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");

    // R075-4: the unauthenticated entry is the author gate, not the editor.
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByText(/This page is where Xinyang Zeng writes Blog posts/)).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
    await expect(page.getByTestId('mock-controls')).toHaveCount(0);

    await page.waitForTimeout(30_000);
    expect(startRequests).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/');
  });

  test('A03: access_denied is cancelled with Retry/Back and no auto re-jump for 30s', async ({
    page,
    request,
  }) => {
    await control(request, { authorize: 'deny' });
    const startRequests: string[] = [];
    page.on('request', (captured) => {
      if (captured.url().includes('/auth/github/start')) startRequests.push(captured.url());
    });

    await page.goto('/');
    await page.getByTestId('auth-continue').click();
    await expect(page.getByText(/GitHub authorization was cancelled/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    // R075-4: a cancelled authorization is a gate (auth Back hook, no editor).
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('status-back')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    const urlAfterCancel = page.url();
    const startsAfterCancel = startRequests.length;
    await page.waitForTimeout(30_000);
    expect(page.url()).toBe(urlAfterCancel);
    expect(startRequests.length).toBe(startsAfterCancel);
    const state = await mockState(request);
    expect(state.commits).toHaveLength(0);
    expect(state.files).toHaveLength(0);
  });

  test('A05: non-author gets forbidden, Switch account and Back are visible', async ({ page, request }) => {
    await control(request, { user: 'other' });
    await page.goto('/');
    await page.getByTestId('auth-continue').click();
    await expect(page.getByText(/This GitHub account is not the configured author/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('auth-continue')).toHaveText(/Switch account/u);
    // R075-4: forbidden is a gate (no editor, no publish controls).
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('status-back')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    const state = await mockState(request);
    expect(state.counters.putRequests).toBe(0);
    expect(state.counters.installationTokenRequests).toBe(0);
  });

  test('A06: App-not-installed shows permission terminal with Review/Reauthorize/Back', async ({ page, request }) => {
    await control(request, { installation: 'none' });
    await page.goto('/');
    await page.getByTestId('auth-continue').click();
    await expect(page.getByText(/The GitHub App cannot write to this repository/)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('review-permissions')).toBeVisible();
    await expect(page.getByTestId('auth-continue')).toHaveText(/Reauthorize with GitHub/u);
    // R075-4: the permission terminal is a gate (no editor, no publish controls).
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('status-back')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    const state = await mockState(request);
    expect(state.counters.putRequests).toBe(0);
    expect(state.counters.installationTokenRequests).toBe(0);
  });

  test('A15/A18: localStorage holds only the draft, 401 keeps the draft and offers Reauthorize/Back', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await setEditorValue(page, 'title', 'A15 local draft');
    await setEditorValue(page, 'body', 'Draft body stays local.');

    const entries = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage).map(([key, value]) => [key, value])),
    );
    expect(Object.keys(entries).sort()).toEqual(['selfpage:author:draft']);
    const draft = JSON.parse(entries['selfpage:author:draft'] ?? '{}');
    expect(draft.title).toBe('A15 local draft');
    expect(draft.body).toBe('Draft body stays local.');
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(SECRET_PATTERN);
    const cookie = await page.evaluate(() => document.cookie);
    expect(cookie).not.toContain('sp_session');

    await control(request, { put: '401' });
    const response = await publishAndWait(page);
    expect(response.status()).toBe(401);
    // R075-4: a 401 publish clears the session, so the expired authorization is
    // the gate again and only its auth Back/reauthorize hooks exist.
    await expect(page.getByText(/Your GitHub authorization expired/)).toBeVisible();
    await expect(page.getByTestId('auth-continue')).toHaveText(/Reauthorize with GitHub/u);
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('status-back')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('selfpage:author:draft') ?? ''))
      .toContain('A15 local draft');
  });

  test('A18: editing while a slow publish is pending is not cleared by the old timeout response', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await setEditorValue(page, 'title', 'Old snapshot');
    await setEditorValue(page, 'body', 'Old body');
    await control(request, { put: 'apply_timeout' });

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    await setEditorValue(page, 'title', 'Newer edit');
    await setEditorValue(page, 'body', 'Newer body');
    expect((await responsePromise).status()).toBe(504);
    await expect(page.getByRole('heading', { name: 'Publishing timed out' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('post-title')).toHaveText('Newer edit');
    await expect(page.getByTestId('post-body')).toHaveText('Newer body');
    const draft = await page.evaluate(() => localStorage.getItem('selfpage:author:draft'));
    expect(draft).toContain('Newer edit');
    expect(draft).toContain('Newer body');
    const state = await mockState(request);
    expect(state.commits).toHaveLength(1);
    expect(state.counters.putRequests).toBe(1);
  });

  test('A11: a network failure while publishing reaches Connection problem with Retry/Back and keeps the draft', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await setEditorValue(page, 'title', 'A11 offline');
    await setEditorValue(page, 'body', 'Draft survives a network failure.');
    await page.route('**/api/posts', (route) => route.abort('failed'));
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Connection problem' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('publish-retry')).toBeVisible();
    await expect(page.getByTestId('status-back')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveText('A11 offline');
    await expect(page.getByTestId('post-body')).toHaveText('Draft survives a network failure.');
    await page.unroute('**/api/posts');
    await control(request, { put: 'ok' });
    const retried = page.waitForResponse(
      (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-retry').click();
    expect((await retried).status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    const state = await mockState(request);
    expect(state.commits).toHaveLength(1);
    expect(state.counters.putRequests).toBe(1);
  });

  test('A19: commit starts pending, Check shows failed then deployed then unconfirmed, Recheck is explicit only', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await control(request, { actions: 'failure' });
    await setEditorValue(page, 'title', 'A19 deployment UI');
    await setEditorValue(page, 'body', 'Deployment branches.');
    const response = await publishAndWait(page);
    expect(response.status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText(/deployment is still pending/iu)).toBeVisible();
    await expect(page.getByTestId('check-deployment')).toBeVisible();
    await expect(page.getByTestId('view-actions')).toBeVisible();
    await expect(page.getByTestId('view-commit')).toBeVisible();
    let state = await mockState(request);
    expect(state.counters.putRequests).toBe(1);
    expect(state.counters.actionsRequests).toBe(0);
    await page.waitForTimeout(2_000);
    state = await mockState(request);
    expect(state.counters.actionsRequests).toBe(0);

    const failedResponse = waitForDeployment(page);
    await page.getByTestId('check-deployment').click();
    expect((await failedResponse).status()).toBe(200);
    await expect(page.getByTestId('deployment-check')).toContainText('Deployment status: Failed');
    await expect(page.getByTestId('recheck-deployment')).toBeVisible();
    await page.waitForTimeout(5_000);
    state = await mockState(request);
    expect(state.counters.actionsRequests).toBe(1);
    expect(state.counters.putRequests).toBe(1);

    await control(request, { actions: 'success' });
    const deployedResponse = waitForDeployment(page);
    await page.getByTestId('recheck-deployment').click();
    expect((await deployedResponse).status()).toBe(200);
    await expect(page.getByTestId('deployment-check')).toContainText('Deployment status: Deployed');

    await control(request, { actions: '403' });
    const unconfirmedResponse = waitForDeployment(page);
    await page.getByTestId('recheck-deployment').click();
    expect((await unconfirmedResponse).status()).toBe(200);
    await expect(page.getByTestId('deployment-check')).toContainText('Deployment status: Unconfirmed');
    await expect(page.getByTestId('recheck-deployment')).toBeVisible();
    state = await mockState(request);
    expect(state.counters.actionsRequests).toBe(3);
    expect(state.counters.putRequests).toBe(1);
    expect(state.commits).toHaveLength(1);
  });
});
