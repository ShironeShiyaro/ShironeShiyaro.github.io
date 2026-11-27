import type {
  APIRequestContext,
  Page,
  Response as PlaywrightResponse,
} from '@playwright/test';
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

async function mockState(request: APIRequestContext): Promise<{
  commits: Array<{ sha: string; path: string; content: string; message: string }>;
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
}

async function authorizeThroughGitHub(page: Page): Promise<void> {
  await expect(page.getByTestId('auth-continue')).toBeVisible();
  await page.getByTestId('auth-continue').click();
  // D30: an authorized session goes straight to the editor; the signed-in
  // affordance is the top-bar Logout button.
  await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 25_000 });
}

async function publishAndWait(page: Page): Promise<PlaywrightResponse> {
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
  );
  await page.getByTestId('publish-button').click();
  return responsePromise;
}

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.describe('real GitHub route UI', () => {
  test('A17: the public New! entry /new/ is served through the Worker with CSP and anti-framing headers', async ({
    page,
  }) => {
    const response = await page.goto('/new/');
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['access-control-allow-origin']).toBeUndefined();
    // R075-4: the unauthenticated entry is the author gate, not the editor.
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
  });

  test('A02/A14: no auto OAuth, host-only HttpOnly Secure Lax cookie, publish and deployment check', async ({
    page,
    context,
    request,
  }) => {
    const startRequests: string[] = [];
    page.on('request', (captured) => {
      if (captured.url().includes('/auth/github/start')) {
        startRequests.push(captured.url());
      }
    });

    await page.goto('/');
    // R075-4: gate only (no editor/publish) until the author signs in.
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
    await expect(page.getByTestId('mock-controls')).toHaveCount(0);
    await page.waitForTimeout(30_000);
    expect(startRequests).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/');

    await authorizeThroughGitHub(page);
    const cookies = await context.cookies(BASE);
    const session = cookies.find((cookie) => cookie.name === 'sp_session');
    expect(session, 'session cookie').toBeTruthy();
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(session?.sameSite).toBe('Lax');
    expect(session?.domain.startsWith('.')).toBe(false);
    expect(session?.path).toBe('/');

    await setEditorValue(page, 'title', 'Real UI post');
    await setEditorValue(page, 'body', 'Published through the real Worker route.');
    const response = await publishAndWait(page);
    expect(response.status(), await response.text()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText(/deployment is still pending/i)).toBeVisible();
    await expect(page.getByTestId('check-deployment')).toBeVisible();
    await expect(page.locator('.publish-status code')).toHaveCount(2);

    await control(request, { actions: 'success' });
    await page.getByTestId('check-deployment').click();
    await expect(page.getByTestId('deployment-check')).toContainText('Deployed');
    await expect(page.getByTestId('view-actions')).toBeVisible();
    await expect(page.getByTestId('view-commit')).toBeVisible();

    const state = await mockState(request);
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0]?.path).toContain('Real UI post-2026-11-23-23-42-15.md');
    expect(state.commits[0]?.content).toContain('# Real UI post');

    await page.getByTestId('logout-button').click();
    // D32: logging out on the success page leaves the result visible; the
    // anonymous editor gate is one navigation away.
    await page.goto('/');
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    expect((await context.cookies(BASE)).some((cookie) => cookie.name === 'sp_session' && cookie.value)).toBe(
      false,
    );
  });

  test('A03: access_denied reaches cancelled, keeps the head unchanged, retry/back visible and no auto redirect', async ({
    page,
    request,
  }) => {
    await control(request, { authorize: 'deny' });
    const startRequests: string[] = [];
    page.on('request', (captured) => {
      if (captured.url().includes('/auth/github/start')) {
        startRequests.push(captured.url());
      }
    });

    await page.goto('/');
    await page.getByTestId('auth-continue').click();
    await expect(page.locator('.status-panel--auth').getByText(/GitHub authorization was cancelled/)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    // R075-4: a cancelled authorization is still the gate.
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    const urlAfterCancel = page.url();
    const startsAfterCancel = startRequests.length;
    await page.waitForTimeout(30_000);
    expect(page.url()).toBe(urlAfterCancel);
    expect(startRequests.length).toBe(startsAfterCancel);
    expect((await mockState(request)).commits).toHaveLength(0);
  });

  test('A06: permission terminal offers Review/Recheck/Back; Recheck re-reads the session without OAuth and keeps the draft', async ({
    page,
    request,
  }) => {
    const startRequests: string[] = [];
    page.on('request', (captured) => {
      if (captured.url().includes('/auth/github/start')) {
        startRequests.push(captured.url());
      }
    });

    // R075-4: the draft has to be written while the author is signed in; the
    // permission terminal itself is a gate and shows no editor.
    await control(request, { installation: 'default' });
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await setEditorValue(page, 'title', 'Permission draft');
    await setEditorValue(page, 'body', 'Draft survives a permission recheck.');
    await expect(page.getByText(/Draft saved in this browser/)).toBeVisible();
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-continue')).toBeVisible();

    await control(request, { installation: 'none' });
    await page.getByTestId('auth-continue').click();
    await expect(page.getByText(/cannot write to this repository/)).toBeVisible({ timeout: 25_000 });
    const authPanel = page.locator('.status-panel--auth');
    await expect(authPanel.getByTestId('auth-recheck')).toBeVisible();
    await expect(authPanel.getByTestId('review-permissions')).toBeVisible();
    await expect(authPanel.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem('selfpage:author:draft') ?? ''),
    ).toContain('Permission draft');

    const startsBeforeRecheck = startRequests.length;
    await page.getByTestId('auth-recheck').click();
    await expect(authPanel.getByTestId('auth-recheck-status')).toContainText(/still reports/u);
    expect(startRequests.length).toBe(startsBeforeRecheck);
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    expect(
      await page.evaluate(() => localStorage.getItem('selfpage:author:draft') ?? ''),
    ).toContain('Draft survives a permission recheck.');

    // Fixing the installation and reauthorizing restores the kept draft.
    await control(request, { installation: 'default' });
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('post-title')).toHaveText('Permission draft');
    await expect(page.getByTestId('post-body')).toHaveText('Draft survives a permission recheck.');
  });

  test('A08: conflict UI keeps the old file and offers View existing / new timestamp', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await setEditorValue(page, 'title', 'UI conflict');
    await setEditorValue(page, 'body', 'Original UI body');
    expect((await publishAndWait(page)).status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();

    // D32: the success page has no editor; return to it. The fixed test clock
    // maps the same title to the same second, so the second publish hits the
    // same file path and must conflict instead of overwriting it.
    await page.goto('/');
    await expect(page.getByTestId('post-title')).toBeVisible();
    await setEditorValue(page, 'title', 'UI conflict');
    await setEditorValue(page, 'body', 'Different UI body');
    const conflict = await publishAndWait(page);
    expect(conflict.status(), await conflict.text()).toBe(409);
    await expect(page.getByRole('heading', { name: 'Publishing conflict' })).toBeVisible();
    await expect(page.getByTestId('view-existing')).toBeVisible();
    await expect(page.getByTestId('view-existing')).toHaveAttribute(
      'href',
      /\/blob\/main\/content\/blog\/.+/u,
    );
    await expect(page.getByTestId('rename-title')).toHaveText('Rename title');
    await expect(page.getByTestId('publish-new-timestamp')).toBeVisible();
    const before = await mockState(request);
    expect(before.commits).toHaveLength(1);
    expect(before.commits[0]?.content).toContain('Original UI body');

    const newTimestamp = page.waitForResponse(
      (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-new-timestamp').click();
    expect((await newTimestamp).status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    expect((await mockState(request)).commits).toHaveLength(2);
  });

  test('A14: a 422 protected-branch rejection shows the branch-protection terminal without View existing or a replay', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await control(request, { put: 'branch_protected' });
    await setEditorValue(page, 'title', 'Protected branch UI');
    await setEditorValue(page, 'body', 'This write must never claim a file that is not there.');
    const response = await publishAndWait(page);
    expect(response.status(), await response.text()).toBe(422);

    await expect(page.getByRole('heading', { name: 'Protected branch' })).toBeVisible();
    await expect(page.getByText(/branch is protected/i)).toBeVisible();
    await expect(page.getByText(/direct writes to a protected branch are not allowed/i)).toBeVisible();
    await expect(page.getByText(/nothing was published/i).first()).toBeVisible();
    await expect(page.getByTestId('view-existing')).toHaveCount(0);
    await expect(page.getByTestId('publish-new-timestamp')).toHaveCount(0);
    await expect(page.getByTestId('review-branch-rules')).toBeVisible();
    await expect(page.getByTestId('status-back')).toBeVisible();
    await expect(page.getByText(/Publishing conflict/)).toHaveCount(0);
    await expect(
      page.locator('.publish-status').getByText(/already exists|existing file/i),
    ).toHaveCount(0);

    const before = await mockState(request);
    expect(before.commits).toHaveLength(0);
    expect(before.counters.putRequests).toBe(1);
    await page.waitForTimeout(1_500);
    const after = await mockState(request);
    expect(after.counters.putRequests, 'no automatic PUT retry').toBe(1);
    expect(after.commits).toHaveLength(0);
  });

  test('A10/A18: a 401 publish clears the session, keeps the draft and offers Reauthorize/Back', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await control(request, { put: '401' });
    await setEditorValue(page, 'title', 'Expired UI');
    await setEditorValue(page, 'body', 'Draft survives a revoked token.');
    const response = await publishAndWait(page);
    expect(response.status()).toBe(401);
    // R075-4: a 401 clears the session, so the expired authorization is a gate:
    // no editor, no publish controls, but the draft is kept in this browser.
    await expect(page.getByText(/Your GitHub authorization expired/)).toBeVisible();
    await expect(page.getByTestId('auth-continue')).toHaveText(/Reauthorize with GitHub/u);
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect
      .poll(async () => page.evaluate(() => localStorage.getItem('selfpage:author:draft') ?? ''))
      .toContain('Draft survives a revoked token.');

    // Reauthorizing restores the kept draft. This is a real full-page navigation
    // to the OAuth route: with a draft, the beforeunload prompt must NOT appear
    // (review P1-3) or cancelling it would abort the authorization.
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.accept();
    });
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('post-title')).toHaveText('Expired UI');
    await expect(page.getByTestId('post-body')).toHaveText('Draft survives a revoked token.');
    expect(dialogs, 'OAuth navigation must not raise a beforeunload prompt').not.toContain(
      'beforeunload',
    );
  });

  test('A11/A17: a 500 is a bounded terminal, Retry is explicit and succeeds without a blind replay', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await authorizeThroughGitHub(page);
    await control(request, { put: '500' });
    await setEditorValue(page, 'title', 'Retry UI');
    await setEditorValue(page, 'body', 'Retry keeps one commit.');
    const failed = await publishAndWait(page);
    expect(failed.status()).toBeGreaterThanOrEqual(500);
    await expect(page.getByRole('heading', { name: 'Publishing failed' })).toBeVisible();
    await expect(page.getByTestId('publish-retry')).toBeVisible();
    await expect(page.getByTestId('status-back')).toBeVisible();
    await expect(page.getByTestId('post-body')).toHaveText('Retry keeps one commit.');

    await control(request, { put: 'ok' });
    const retried = page.waitForResponse(
      (response) => response.url().includes('/api/posts') && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-retry').click();
    expect((await retried).status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    expect((await mockState(request)).commits).toHaveLength(1);
  });
});
