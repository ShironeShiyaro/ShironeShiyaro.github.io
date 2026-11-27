import type { Dialog, Page } from '@playwright/test';
import { expect, test } from './console-guard.ts';
import {
  TEST_BASE_URL,
  authorize,
  openApp,
  resetMock,
  typeTitle,
  typeBody,
} from './helpers.ts';

/**
 * Task 07.5 shell behaviours on the author origin.
 *
 * R075-4 (total-control ruling 2026-11-26, from user D30): unauthenticated
 * visitors only get the short author statement + Continue + Back to Blog; the
 * editor, the primary actions and Logout exist only after signing in, and a
 * local draft survives the sign-out/sign-in round trip.
 *
 * R075-7 (ruling 2026-11-26): the author-side Blog year is a local three-state
 * toggle with the public archive's semantics (D36): one year open at a time,
 * a second activation collapses it, keyboard parity, level-3 links point at the
 * public article URLs.
 */
const DRAFT_KEY = 'selfpage:author:draft';

async function openDrawer(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') {
    await menu.click();
  }
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
}

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.describe('author gate (R075-4)', () => {
  test('an unauthenticated visitor sees only the short statement, Continue and Back', async ({
    page,
  }) => {
    await openApp(page);
    await expect(
      page.getByText(/This page is where Xinyang Zeng writes Blog posts/),
    ).toBeVisible();
    await expect(page.getByTestId('auth-continue')).toHaveText('Continue with GitHub');
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toHaveAttribute(
      'href',
      /^http:\/\/localhost:4321\/blog\/$/,
    );
    // No editor, no primary actions, no Logout, no long "how to write" copy.
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('post-body')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('discard-button')).toHaveCount(0);
    await expect(page.getByTestId('preview-toggle')).toHaveCount(0);
    await expect(page.getByTestId('logout-button')).toHaveCount(0);
    await expect(page.getByText(/Write a new Blog post for Xinyang Zeng/i)).toHaveCount(0);
    await expect(page.getByText(/The title becomes the page heading/i)).toHaveCount(0);
    // The shared public-site shell is still there (menu + brand + drawer).
    await expect(page.locator('.top-bar')).toBeVisible();
    await expect(page.locator('.site-brand')).toHaveText("Xinyang Zeng's Homepage");
    await openDrawer(page);
    await expect(page.locator('.site-nav__settings')).toHaveText('Settings');
    // P2-3: the mock Worker serves the matching mode hint.
    await expect(page.locator('meta[name="selfpage-author-mode"]')).toHaveAttribute(
      'content',
      'mock',
    );
  });

  test('a local draft survives sign-out and is restored after sign-in', async ({ page }) => {
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Ruling draft');
    await typeBody(page, 'Draft survives sign-out and sign-in.');
    await expect
      .poll(async () => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))
      .not.toBeNull();

    // Signing out hides the editor but must not clear the draft.
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toContain(
      'Ruling draft',
    );

    // Signing in again opens the editor with the same draft.
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveText('Ruling draft');
    await expect(page.getByTestId('post-body')).toHaveText(
      'Draft survives sign-out and sign-in.',
    );
  });

  test('a real reload while signed out stays on the gate and keeps the stored draft', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Reload gate draft');
    await typeBody(page, 'Still here after a signed-out reload.');
    await expect
      .poll(async () => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))
      .not.toBeNull();
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-continue')).toBeVisible();

    // The draft raises the native beforeunload prompt; accept it to leave.
    const accept = async (dialog: Dialog) => dialog.accept();
    page.on('dialog', accept);
    await page.reload({ waitUntil: 'networkidle' });
    page.off('dialog', accept);

    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toContain(
      'Reload gate draft',
    );

    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('post-title')).toHaveText('Reload gate draft');
  });
});

test.describe('author shell navigation (R075-7 / X01)', () => {
  test('the author navigation marks the Blog branch and New! as the current items (P1-4)', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await openDrawer(page);
    await expect(page.locator('html')).toHaveAttribute('data-nav-page', 'author');

    const blogLink = page.locator('.site-nav__link--level-1[data-nav-key="blog"]');
    await expect(blogLink).toHaveAttribute('aria-current', 'true');
    await expect(blogLink.locator('xpath=ancestor::li[1]')).toHaveClass(/is-current-ancestor/u);

    const newLink = page.locator('.site-nav__link--level-2', { hasText: 'New!' });
    await expect(newLink).toHaveAttribute('aria-current', 'page');
    await expect(newLink.locator('xpath=ancestor::li[1]')).toHaveClass(/\bis-current\b/u);
    // Exactly one current page item in the whole navigation.
    await expect(page.locator('nav[aria-label="Site"] [aria-current="page"]')).toHaveCount(1);
    // The current state is also visible (not colour-only): the shared stylesheet
    // gives is-current / is-current-ancestor a background + weight.
    const backgrounds = await page.evaluate(() =>
      ['is-current', 'is-current-ancestor'].map((name) => {
        const item = document.querySelector(`.site-nav__item.${name} > .site-nav__link`);
        return item === null ? '' : getComputedStyle(item).backgroundColor;
      }),
    );
    expect(backgrounds[0]).not.toBe('rgba(0, 0, 0, 0)');
    expect(backgrounds[1]).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('every shell link targets the public site; New! stays in the author app', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await openDrawer(page);
    const links = await page.evaluate(() =>
      [...document.querySelectorAll('nav[aria-label="Site"] a[href]')].map((element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        href: element.getAttribute('href') ?? '',
      })),
    );
    expect(links.length).toBeGreaterThan(5);
    const newLink = links.find((link) => link.text.startsWith('New!'));
    expect(newLink?.href).toBe('/new/');
    for (const link of links.filter((entry) => entry !== newLink)) {
      expect(link.href, `${link.text} targets the public site`).toMatch(
        /^http:\/\/localhost:4321\//,
      );
    }
    // Brand and the public-site navigation never carry session data.
    for (const href of links.map((link) => link.href)) {
      expect(href).not.toMatch(/[?&](session|token|state|code|verifier)=/i);
    }
  });

  test('a year expands one list at a time and collapses on a second activation', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await openDrawer(page);

    const y2026 = page.locator('[data-year-toggle][data-year="2026"]');
    const y2025 = page.locator('[data-year-toggle][data-year="2025"]');
    const list2026 = page.locator('#nav-year-2026-posts');
    const list2025 = page.locator('#nav-year-2025-posts');

    await expect(y2026).toHaveAttribute('aria-expanded', 'false');
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');
    await expect(list2026).toHaveAttribute('hidden', '');

    await y2026.click();
    await expect(y2026).toHaveAttribute('aria-expanded', 'true');
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');
    await expect(list2026).not.toHaveAttribute('hidden', '');
    await expect(list2026.locator('.site-nav__post-link')).toHaveCount(2);
    await expect(list2026.locator('.site-nav__post-link').first()).toBeVisible();

    // Only one year may be open; the other one closes.
    await y2025.click();
    await expect(y2025).toHaveAttribute('aria-expanded', 'true');
    await expect(y2026).toHaveAttribute('aria-expanded', 'false');
    await expect(list2025).not.toHaveAttribute('hidden', '');
    await expect(list2026).toHaveAttribute('hidden', '');

    // Second activation of the open year collapses it (D36).
    await y2025.click();
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');
    await expect(list2025).toHaveAttribute('hidden', '');

    // Keyboard parity: Enter and Space toggle exactly like a click.
    await y2025.focus();
    await page.keyboard.press('Enter');
    await expect(y2025).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Space');
    await expect(y2025).toHaveAttribute('aria-expanded', 'true');

    // Level-3 links open the public article URLs.
    const postHrefs = await list2025
      .locator('.site-nav__post-link')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('href') ?? ''));
    expect(postHrefs.length).toBeGreaterThan(0);
    for (const href of postHrefs) {
      expect(href).toMatch(/^http:\/\/localhost:4321\/blog\/2025\//);
    }
    // A plain activation never navigates the author app away.
    expect(page.url()).toBe(`${TEST_BASE_URL}/`);
    await expect(page.locator('.site-brand')).toHaveAttribute(
      'href',
      'http://localhost:4321/',
    );
  });

  test('D20: Home never expands and no site page is current on /new/', async ({ page }) => {
    // User-reported real-device defect: the author shell rendered the Home
    // section list unconditionally, so Home looked expanded on /new/. Public
    // SiteNav.astro renders it only while Home is the current site page, and
    // the author origin is never a public site page.
    await openApp(page);
    await authorize(page);
    if (await page.getByTestId('logout-button').isVisible()) {
      await page.getByTestId('logout-button').click();
    }
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await openDrawer(page);

    const expectNoHomeBranch = async (state: string): Promise<void> => {
      await expect(
        page.locator('ul[aria-label="Home sections"]'),
        `${state}: Home section list`,
      ).toHaveCount(0);
      const home = page.locator('.site-nav__link[data-nav-key="home"]');
      await expect(home, `${state}: Home link`).toHaveAttribute(
        'href',
        'http://localhost:4321/',
      );
      await expect(home, `${state}: Home link current`).not.toHaveAttribute(
        'aria-current',
        /.*/u,
      );
      expect(
        await page
          .locator('[data-nav-group="home"] [aria-current], [data-nav-group="publications"] [aria-current]')
          .count(),
        `${state}: no site page is current`,
      ).toBe(0);
    };

    // Gate state.
    await expectNoHomeBranch('gate');
    // Regression: Settings is still the public-site link and Blog entries exist.
    const settings = page.locator('.site-nav__settings');
    await expect(settings).toHaveJSProperty('tagName', 'A');
    await expect(settings).toHaveAttribute('href', 'http://localhost:4321/settings/');
    await expect(page.locator('[data-year-toggle]').first()).toBeVisible();

    // Editor state.
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expectNoHomeBranch('editor');

    // Regression: the Blog year disclosure and level-3 article links still work.
    const y2026 = page.locator('[data-year-toggle][data-year="2026"]');
    await y2026.click();
    await expect(page.locator('#nav-year-2026-posts .site-nav__post-link')).toHaveCount(2);
  });
});

test.describe('success record URLs (P2-5)', () => {
  test('only https GitHub URLs from the stored record become links', async ({ page }) => {
    const record = (commitUrl: string, actionsUrl: string) => ({
      kind: 'committed',
      commit: {
        sha: 'a'.repeat(40),
        committedAt: '2026-11-26T10:00:00Z',
        path: 'content/blog/2026/Stored-2026-11-26-10-00-00.md',
        url: commitUrl,
      },
      deployment: { status: 'pending', message: 'The commit exists.', actionsUrl },
      date: '2026-11-26',
      clearedDraft: true,
      savedAt: '2026-11-26T10:00:00Z',
    });

    await page.goto('/');
    await page.evaluate((value) => sessionStorage.setItem('selfpage:publish-result', value), JSON.stringify(record('javascript:alert(1)', 'data:text/html,<script>alert(1)</script>')));
    await page.goto('/new/success');
    await expect(page.getByTestId('success-panel')).toBeVisible();
    await expect(page.getByTestId('view-commit')).toHaveCount(0);
    await expect(page.getByTestId('view-actions')).toHaveCount(0);
    await expect(page.getByText(/not a https GitHub URL/)).toBeVisible();
    const hrefs = await page
      .locator('a[href]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('href') ?? ''));
    expect(hrefs.some((href) => /^(javascript|data):/i.test(href))).toBe(false);

    // The same record with a proper GitHub URL renders the two links again.
    await page.evaluate(
      (value) => sessionStorage.setItem('selfpage:publish-result', value),
      JSON.stringify(
        record(
          'https://github.com/ShironeShiyaro/selfpage-publish-test/commit/abc123',
          'https://github.com/ShironeShiyaro/selfpage-publish-test/actions',
        ),
      ),
    );
    await page.reload();
    await expect(page.getByTestId('view-commit')).toHaveAttribute(
      'href',
      'https://github.com/ShironeShiyaro/selfpage-publish-test/commit/abc123',
    );
    await expect(page.getByTestId('view-actions')).toHaveAttribute(
      'href',
      'https://github.com/ShironeShiyaro/selfpage-publish-test/actions',
    );
  });
});

test.describe('beforeunload (P2-9)', () => {
  test('a real browser prompt protects an unsaved draft and disappears after delete', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Beforeunload draft');
    await typeBody(page, 'The browser must ask before this leaves.');
    await expect
      .poll(async () => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))
      .toContain('Beforeunload draft');

    const dialogTypes: string[] = [];
    const handler = async (dialog: Dialog) => {
      dialogTypes.push(dialog.type());
      await dialog.dismiss();
    };
    page.on('dialog', handler);
    // Dismissing the prompt cancels the navigation, so the reload is expected to
    // be aborted; the prompt itself is the assertion.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => null);
    await expect.poll(() => dialogTypes).toContain('beforeunload');
    await expect(page.getByTestId('post-title')).toHaveText('Beforeunload draft');
    page.off('dialog', handler);

    // Deleting the draft removes the prompt: the same reload now goes through.
    await page.getByTestId('discard-button').click();
    await page.getByTestId('discard-confirm').click();
    await expect
      .poll(async () => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))
      .toBeNull();
    const afterDelete: string[] = [];
    const afterHandler = async (dialog: Dialog) => {
      afterDelete.push(dialog.type());
      await dialog.accept();
    };
    page.on('dialog', afterHandler);
    await page.reload({ waitUntil: 'domcontentloaded' });
    page.off('dialog', afterHandler);
    expect(afterDelete).not.toContain('beforeunload');
    // The draft is gone, not the session: the reload still lands in the
    // authorized editor, so the title input exists and is empty. Wait for the
    // editor to be ready instead of racing a count that is only 0 before mount.
    await expect(page.getByTestId('logout-button')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('post-title')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveText('');
    await expect(page.getByTestId('post-body')).toHaveText('');
    expect(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY)).toBeNull();
  });
});

test.describe('leave confirmation accessibility (P2-8)', () => {
  test('narrow: the drawer closes, the shell is inert and focus cannot escape', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Leave modal draft');
    await typeBody(page, 'Background must be inert.');
    await expect
      .poll(async () => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))
      .toContain('Leave modal draft');

    // Navigate from the open narrow drawer to the public site: D33 asks first.
    await openDrawer(page);
    await page.locator('.site-nav__link--level-1[data-nav-key="publications"]').click();
    await expect(page.getByTestId('leave-confirm')).toBeVisible();
    // The drawer is closed instead of stacking the dialog on the overlay.
    await expect(page.locator('html')).toHaveAttribute('data-drawer-open', 'false');
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // The rest of the page is inert (pointer + accessibility tree).
    for (const selector of ['.top-bar', '.site-main', '.site-footer', '#site-drawer']) {
      await expect(page.locator(selector)).toHaveAttribute('inert', '');
    }
    await expect(page.getByTestId('leave-stay')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('leave-accept')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('leave-stay')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('leave-accept')).toBeFocused();

    // Escape means Stay; focus falls back to the Menu button (the trigger's
    // drawer was closed) and the editor becomes interactive again.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('leave-confirm')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
    await expect(page.locator('.site-main')).not.toHaveAttribute('inert', '');
    expect(page.url()).toBe(`${TEST_BASE_URL}/`);
    await expect(page.getByTestId('post-title')).toHaveText('Leave modal draft');
  });

  test('wide: the open drawer is inert while the dialog is up, and Stay restores its trigger', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Wide leave draft');
    await typeBody(page, 'Focus returns to the trigger.');
    await expect
      .poll(async () => page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))
      .not.toBeNull();

    await openDrawer(page);
    const trigger = page.locator('.site-nav__link--level-1[data-nav-key="publications"]');
    await trigger.click();
    await expect(page.getByTestId('leave-confirm')).toBeVisible();
    // Wide screens keep the push drawer open, but it is inert behind the dialog.
    await expect(page.locator('html')).toHaveAttribute('data-drawer-open', 'true');
    await expect(page.locator('#site-drawer')).toHaveAttribute('inert', '');
    await expect(page.getByTestId('leave-stay')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('leave-confirm')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator('#site-drawer')).not.toHaveAttribute('inert', '');
  });
});
