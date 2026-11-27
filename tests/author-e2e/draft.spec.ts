import type { Page } from '@playwright/test';
import { expect, test } from './console-guard.ts';
import {
  TEST_BASE_URL,
  authorize,
  chooseMockAuthOutcome,
  chooseMockPublishOutcome,
  continueWithGitHub,
  expectDraftSaved,
  openApp,
  readDraft,
  resetMock,
  setEditorValue,
  trackRequests,
  typeTitle,
  typeBody,
} from './helpers.ts';

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

/**
 * R075-4 (total-control ruling, 2026-11-26, from user D30): an unauthenticated
 * visitor only sees the short author statement (or the terminal state) plus
 * Continue/Back. The editor, the primary actions and Logout do not exist until
 * the author signs in; a local draft is kept and restored after sign-in.
 */
async function expectAuthorGate(page: Page): Promise<void> {
  await expect(
    page.getByText(/This page is where Xinyang Zeng writes Blog posts/),
  ).toBeVisible();
  await expect(page.getByTestId('auth-continue')).toBeVisible();
  await expect(page.getByTestId('post-title')).toHaveCount(0);
  await expect(page.getByTestId('post-body')).toHaveCount(0);
  await expect(page.getByTestId('publish-button')).toHaveCount(0);
  await expect(page.getByTestId('discard-button')).toHaveCount(0);
  await expect(page.getByTestId('preview-toggle')).toHaveCount(0);
  await expect(page.getByTestId('logout-button')).toHaveCount(0);
}

test.describe('browser drafts and access states', () => {
  test('E08: a draft is saved to this browser and restored after a reload', async ({ page }) => {
    await openApp(page);
    // R075-4: the editor only exists after signing in.
    await expectAuthorGate(page);
    await authorize(page);
    await typeTitle(page, 'Reloaded draft');
    await typeBody(page, 'Body survives a reload.\n\n- item one');

    const saved = await expectDraftSaved(page);
    expect(saved.title).toBe('Reloaded draft');
    expect(Object.keys(saved).sort()).toEqual(
      ['body', 'draftId', 'schemaVersion', 'title', 'updatedAt'].sort(),
    );
    expect(saved.body).toContain('Body survives a reload.');

    await page.reload();
    await expect(page.getByTestId('post-title')).toHaveText('Reloaded draft');
    await expect(page.getByTestId('post-body')).toHaveText('Body survives a reload.\n\n- item one');
    await expect(page.getByText('Draft restored from this browser.')).toBeVisible();
  });

  test('E08: cancelled authorization, mock 500 and conflict all keep the draft', async ({
    page,
    request,
  }) => {
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Cancelled draft');
    await typeBody(page, 'Keep this after a cancelled authorization.');
    await expectDraftSaved(page);

    // Signing out hides the editor again but never clears the draft; a
    // cancelled authorization keeps the same gate state.
    await page.getByTestId('logout-button').click();
    await expectAuthorGate(page);
    expect((await readDraft(page))?.title).toBe('Cancelled draft');

    await chooseMockAuthOutcome(page, 'cancelled');
    await continueWithGitHub(page);
    await expect(page.getByText(/GitHub authorization was cancelled/)).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expectDraftSaved(page);

    await page.reload();
    await expectAuthorGate(page);
    await expectDraftSaved(page);

    // An explicit Continue is the only way back into authorization; the editor
    // (and the stored draft) comes back only once the author is signed in.
    await chooseMockAuthOutcome(page, 'authorized');
    await continueWithGitHub(page);
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveText('Cancelled draft');
    await expect(page.getByTestId('post-body')).toHaveText(
      'Keep this after a cancelled authorization.',
    );

    await chooseMockPublishOutcome(page, 'server_error');
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Publishing failed' })).toBeVisible();
    await expectDraftSaved(page);

    await page.reload();
    await expect(page.getByTestId('post-title')).toHaveText('Cancelled draft');

    await setEditorValue(page, 'title', 'Conflict draft');
    await setEditorValue(page, 'body', 'Keep this after a conflict.');
    await expect
      .poll(async () => (await readDraft(page))?.title)
      .toBe('Conflict draft');
    await chooseMockPublishOutcome(page, 'conflict');
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Publishing conflict' })).toBeVisible();
    await expectDraftSaved(page);

    await page.reload();
    await expect(page.getByTestId('post-title')).toHaveText('Conflict draft');
    await expect(page.getByTestId('post-body')).toHaveText('Keep this after a conflict.');
    expect((await readDraft(page))?.body).toBe('Keep this after a conflict.');
  });

  test('E08: Discard asks for confirmation and can be cancelled', async ({ page }) => {
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Discard me');
    await typeBody(page, 'This text must survive Keep editing.');
    await expectDraftSaved(page);

    await page.getByTestId('discard-button').click();
    await expect(page.getByRole('heading', { name: 'Delete this draft?' })).toBeVisible();
    // P2-2: the safe action owns the initial focus; the destructive action is
    // one Tab away and Tab/Shift+Tab cycle inside the two buttons.
    await expect(page.getByTestId('discard-cancel')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('discard-confirm')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('discard-cancel')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('discard-confirm')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('discard-cancel')).toBeFocused();

    // Escape cancels and returns focus to the Delete draft trigger.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Delete this draft?' })).toHaveCount(0);
    await expect(page.getByTestId('discard-button')).toBeFocused();
    await expect(page.getByTestId('post-body')).toHaveText('This text must survive Keep editing.');

    await page.getByTestId('discard-button').click();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByTestId('post-title')).toHaveText('Discard me');
    await expect(page.getByTestId('post-body')).toHaveText('This text must survive Keep editing.');

    await page.getByTestId('discard-button').click();
    await page.getByTestId('discard-confirm').click();
    await expect(page.getByTestId('post-title')).toHaveText('');
    await expect(page.getByTestId('post-body')).toHaveText('');
    await expect(page.getByText('Draft deleted.')).toBeVisible();
    expect(await readDraft(page)).toBeNull();
    await expect(page.getByTestId('post-title')).toBeFocused();
  });

  test('E08: editing stays usable when localStorage throws', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError');
        },
      });
    });
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'No storage title');
    await typeBody(page, 'Editing still works without storage.');

    await expect(page.getByTestId('post-title')).toHaveText('No storage title');
    await expect(page.getByTestId('post-body')).toHaveText('Editing still works without storage.');
    await expect(page.getByText(/Autosave is unavailable because this browser blocked local storage/)).toBeVisible();
  });

  test('P1-3: the initial date and session GETs are bounded and offer explicit Retry', async ({
    page,
  }) => {
    // Simulate a proxy that accepts the connection but never answers.
    await page.route('**/api/date', () => new Promise(() => {}));
    await page.route('**/api/mock/session', () => new Promise(() => {}));
    await page.goto('/');
    await expect(page.getByText(/Checking GitHub authorization/)).toBeVisible();
    // R075-4: no editor before the author is signed in.
    await expect(page.getByTestId('post-title')).toHaveCount(0);

    // 12s hard timeout: the auth read must become an English terminal state,
    // not spin forever (the date read fails in the background and is shown once
    // the editor opens).
    await expect(page.getByText(/Could not check GitHub authorization/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('auth-retry')).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.getByText(/Could not check GitHub authorization/)).toBeVisible();
    await expect(page.getByTestId('auth-retry')).toBeVisible();

    await page.unroute('**/api/date');
    await page.unroute('**/api/mock/session');
    await page.getByTestId('auth-retry').click();
    // The mock session is anonymous now, so the gate offers Continue.
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('post-title')).toBeVisible();
    await expect(page.getByTestId('post-date')).toHaveText('Date unavailable');
    await expect(page.getByRole('button', { name: 'Retry date' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry date' }).click();
    await expect(page.getByTestId('post-date')).not.toHaveText(/Date unavailable|Loading date/);
  });

  test('E10: anonymous state never auto-redirects, Publish stays off, Back stays available', async ({
    page,
    request,
  }) => {
    await openApp(page);
    const authRequests = trackRequests(page, '/api/mock/auth');
    const initialUrl = page.url();

    await expectAuthorGate(page);
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toHaveAttribute(
      'href',
      /^http:\/\/localhost:4321\/blog\/$/,
    );

    // The contract is explicit: no automatic OAuth redirect for 30 seconds.
    await page.waitForTimeout(30_000);
    expect(page.url()).toBe(initialUrl);
    expect(authRequests).toEqual([]);
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(page.getByTestId('publish-button')).toHaveCount(0);

    // One explicit click produces exactly one authorization request.
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(page.getByTestId('post-title')).toBeVisible();
    expect(authRequests).toHaveLength(1);
    // D30/C: the authorized editor has no Back link of its own; going back to
    // the Blog is the shared shell's navigation, which targets the public site.
    await expect(page.getByTestId('back-to-blog')).toHaveCount(0);
    await expect(page.locator('.site-nav__link--level-1', { hasText: 'Blog' })).toHaveAttribute(
      'href',
      'http://localhost:4321/blog/',
    );

    // Every terminal authorization state keeps a Back link and stays a gate:
    // no editor, no primary actions, no Logout.
    const terminalStates: Array<[string, RegExp]> = [
      ['cancelled', /GitHub authorization was cancelled/],
      ['forbidden', /not the configured author/],
      ['expired', /authorization expired/i],
      ['permission_denied', /cannot write to this repository/],
    ];
    for (const [outcome, text] of terminalStates) {
      await request.post(`${TEST_BASE_URL}/api/mock/logout`);
      await page.goto('/');
      await expect(page.getByTestId('auth-continue')).toBeVisible();
      await chooseMockAuthOutcome(page, outcome);
      await continueWithGitHub(page);
      await expect(page.getByText(text)).toBeVisible();
      await expect(page.getByTestId('auth-status-back')).toBeVisible();
      await expect(page.getByTestId('auth-status-back')).toHaveAttribute('href', /blog/);
      await expect(page.getByTestId('post-title')).toHaveCount(0);
      await expect(page.getByTestId('publish-button')).toHaveCount(0);
      await expect(page.getByTestId('logout-button')).toHaveCount(0);
    }
  });
});
