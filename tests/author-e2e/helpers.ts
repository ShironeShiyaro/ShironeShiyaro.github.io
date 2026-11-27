import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const TEST_BASE_URL = process.env.AUTHOR_E2E_BASE_URL ?? 'http://127.0.0.1:43243';
export const PROD_BASE_URL = process.env.AUTHOR_E2E_PROD_BASE_URL ?? 'http://127.0.0.1:43244';
export const DRAFT_KEY = 'selfpage:author:draft';
export const FIXED_CLOCK = '2026-11-23T15:42:15Z';

export interface StoredDraft {
  schemaVersion: number;
  draftId: string;
  title: string;
  body: string;
  updatedAt: string;
}

export async function resetMock(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${TEST_BASE_URL}/api/test/reset`);
  expect(response.status(), await response.text()).toBe(200);
}

export async function setClock(request: APIRequestContext, now: string): Promise<void> {
  const response = await request.post(`${TEST_BASE_URL}/api/test/clock`, { data: { now } });
  expect(response.status(), await response.text()).toBe(200);
}

export async function shiftClockHours(
  request: APIRequestContext,
  baseIso: string,
  hours: number,
): Promise<string> {
  const shifted = new Date(Date.parse(baseIso) + hours * 3_600_000).toISOString();
  await setClock(request, shifted);
  return shifted;
}

/**
 * Opens the author app and waits for its entry state to settle.
 *
 * R075-4 (user D30): an unauthenticated visitor gets only the short author
 * statement; the editor does not exist until the author signs in. The mock
 * Worker session is process-wide, so a reload can land either on the gate or
 * straight in the editor — both are valid here.
 */
export async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.locator('.top-bar')).toBeVisible();
  await expect(
    page.getByTestId('auth-continue').or(page.getByTestId('post-title')),
  ).toBeVisible();
  if (await page.getByTestId('post-title').isVisible()) {
    await expect(page.getByTestId('post-date')).not.toHaveText(/Loading date/);
  }
}

/** Opens the author app and signs the mock session in when the gate is shown. */
export async function openAuthorizedApp(page: Page, path = '/'): Promise<void> {
  await openApp(page, path);
  await authorize(page);
}

/**
 * D32: a successful publish now lands on `/new/success`, so a scenario that
 * continues editing must explicitly return to the editor. The published draft
 * was cleared, therefore the editor starts empty (a new draft id).
 */
export async function backToEditor(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('post-title')).toBeVisible();
  await expect(page.getByTestId('post-date')).not.toHaveText(/Loading date|Date unavailable/);
}

export async function openMockControls(page: Page): Promise<void> {
  const details = page.getByTestId('mock-controls');
  await expect(details).toBeVisible();
  const open = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) {
    await details.locator('summary').click();
  }
}

const authOutcomeByPage = new WeakMap<Page, string>();
const authRoutedPages = new WeakSet<Page>();

/**
 * Selects the mock authorization outcome for the next Continue.
 *
 * R075-4: the unauthenticated page has no editor, so the test-only mock
 * controls (inside the editor panel) do not exist on the gate either. The
 * outcome is therefore simulated on the same `/api/mock/auth` request the
 * Continue button sends: `authorized` passes through to the Worker, every other
 * outcome is answered with the Worker's own mock response shape.
 */
export async function chooseMockAuthOutcome(page: Page, outcome: string): Promise<void> {
  authOutcomeByPage.set(page, outcome);
  if (authRoutedPages.has(page)) {
    return;
  }
  authRoutedPages.add(page);
  await page.route('**/api/mock/auth', async (route) => {
    const selected = authOutcomeByPage.get(page) ?? 'authorized';
    if (selected === 'authorized') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: selected }),
    });
  });
}

export async function chooseMockPublishOutcome(page: Page, outcome: string): Promise<void> {
  await openMockControls(page);
  await page.getByTestId('mock-publish-outcome').selectOption(outcome);
}

export async function continueWithGitHub(page: Page): Promise<void> {
  await page.getByTestId('auth-continue').click();
}

export async function authorize(page: Page): Promise<void> {
  // R075-4: signing in from the gate is what opens the editor. The mock
  // session can already be authorized (process-wide) after a reload, so accept
  // both entry states.
  const logout = page.getByTestId('logout-button');
  if (!(await logout.isVisible())) {
    await continueWithGitHub(page);
  }
  // D30: an authorized session goes straight to the editor, so the only
  // signed-in affordance is the top-bar Logout button (no "Signed in as…" line).
  await expect(logout).toBeVisible();
  await expect(page.getByTestId('post-title')).toBeVisible();
  await expect(page.locator('.status-panel--auth')).toHaveCount(0);
}

/** Sets a contenteditable value through the same input event the user produces. */
export async function setEditorValue(
  page: Page,
  field: 'title' | 'body',
  value: string,
): Promise<void> {
  const locator = page.getByTestId(`post-${field}`);
  await locator.evaluate((element, text) => {
    element.textContent = text;
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
  }, value);
}

export async function typeTitle(page: Page, value: string): Promise<void> {
  const title = page.getByTestId('post-title');
  await title.click();
  await page.keyboard.insertText(value);
}

export async function typeBody(page: Page, value: string): Promise<void> {
  const body = page.getByTestId('post-body');
  await body.click();
  await page.keyboard.insertText(value);
}

export async function readDraft(page: Page): Promise<StoredDraft | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as StoredDraft);
  }, DRAFT_KEY);
}

export async function expectDraftSaved(page: Page): Promise<StoredDraft> {
  await expect.poll(async () => (await readDraft(page)) !== null).toBe(true);
  const draft = await readDraft(page);
  expect(draft).not.toBeNull();
  return draft as StoredDraft;
}

export interface CapturedPublish {
  status: number;
  json: Record<string, unknown>;
}

export async function publishAndWait(page: Page): Promise<CapturedPublish> {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/mock/publish') &&
      response.request().method() === 'POST',
  );
  await page.getByTestId('publish-button').click();
  const response = await responsePromise;
  return { status: response.status(), json: (await response.json()) as Record<string, unknown> };
}

export function trackRequests(page: Page, fragment: string): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(fragment)) {
      requests.push(`${request.method()} ${request.url()}`);
    }
  });
  return requests;
}

export function frontMatterOf(markdown: string): { source: string; visible: string } {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(markdown);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`markdown has no front matter: ${JSON.stringify(markdown.slice(0, 80))}`);
  }
  return { source: match[1], visible: match[2] };
}
