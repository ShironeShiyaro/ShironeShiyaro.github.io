import type { Page } from '@playwright/test';
import { expect, test } from './console-guard.ts';
import { openApp } from './helpers.ts';

/**
 * Task 08 author-origin preference hand-off (R08-3 / R08-4).
 *
 * The public site appends only three non-sensitive values to the New! link
 * (`#theme=…&motion=…&size=…`). The author boot module (external, because the
 * Worker CSP is `script-src 'self'`) writes them into this origin's own
 * localStorage, applies them before React mounts and removes the one-time
 * fragment. No session, token or query parameter is involved.
 *
 * Every test imports the shared console guard: a CSP violation or uncaught page
 * error fails it (the 07.5 inline-script regression lesson).
 */

const THEME_KEY = 'selfpage:preference:theme';
const MOTION_KEY = 'selfpage:preference:motion';
const TEXT_SIZE_KEY = 'selfpage:preference:text-size';
const PUBLIC_SETTINGS_URL = 'http://localhost:4321/settings/';

interface RootPreferenceState {
  theme: string | null;
  motion: string | null;
  textSize: string | null;
  meta: string | null;
  colorScheme: string;
}

async function readRootState(page: Page): Promise<RootPreferenceState> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      theme: root.getAttribute('data-theme'),
      motion: root.getAttribute('data-motion'),
      textSize: root.getAttribute('data-text-size'),
      meta: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
      colorScheme: getComputedStyle(root).colorScheme,
    };
  });
}

async function readStored(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(
    ({ themeKey, motionKey, textSizeKey }) => ({
      theme: localStorage.getItem(themeKey),
      motion: localStorage.getItem(motionKey),
      textSize: localStorage.getItem(textSizeKey),
    }),
    { themeKey: THEME_KEY, motionKey: MOTION_KEY, textSizeKey: TEXT_SIZE_KEY },
  );
}

async function openDrawer(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
}

test.describe('R08-4 preference fragment import', () => {
  test('the fragment is written to this origin, applied before render and removed from the URL', async ({
    page,
  }) => {
    await openApp(page, '/new/#theme=dark&motion=reduce&size=large');

    const state = await readRootState(page);
    expect(state.theme).toBe('dark');
    expect(state.motion).toBe('reduce');
    expect(state.textSize).toBe('large');
    expect(state.meta, 'the color-scheme meta follows the imported theme').toBe('dark');
    expect(state.colorScheme).toBe('dark');

    expect(await readStored(page), 'the author origin stores its own copy').toEqual({
      theme: 'dark',
      motion: 'reduce',
      textSize: 'large',
    });

    const url = new URL(page.url());
    expect(url.pathname, 'the author route is unchanged').toBe('/new/');
    expect(url.hash, 'the one-time preference fragment is removed').toBe('');
    expect(url.search, 'no query is used for preferences').toBe('');
    // Dark has to be visible immediately, not only after React re-renders.
    await expect(page.locator('.top-bar')).toBeVisible();
    await expect(page.locator('.site-drawer')).toHaveCount(1);
  });

  test('a default fragment deletes the author overrides instead of storing literals', async ({ page }) => {
    // Start with an explicit preference so the deletion is observable.
    await openApp(page, '/new/#theme=dark&motion=reduce&size=large');
    expect(await readStored(page)).toEqual({ theme: 'dark', motion: 'reduce', textSize: 'large' });

    await page.goto('/new/#theme=system&motion=system&size=default');
    // A hash-only change is same-document and would not re-run the boot module,
    // so force a real document load for the one-time fragment import.
    await page.reload();
    await expect(page.locator('.top-bar')).toBeVisible();
    const state = await readRootState(page);
    expect(state.theme, 'System has no root attribute').toBeNull();
    expect(state.motion).toBeNull();
    expect(state.textSize).toBeNull();
    expect(state.meta).toBe('light dark');
    expect(state.colorScheme).toBe('light dark');
    expect(await readStored(page), 'the three override keys are gone').toEqual({
      theme: null,
      motion: null,
      textSize: null,
    });
    expect(new URL(page.url()).hash).toBe('');
  });

  test('a blocked author localStorage still applies the fragment for this page', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError');
        },
      });
    });

    await openApp(page, '/new/#theme=dark&motion=full&size=small');
    const state = await readRootState(page);
    expect(state.theme, 'the fragment still applies without storage').toBe('dark');
    expect(state.motion).toBe('full');
    expect(state.textSize).toBe('small');
    await expect(page.locator('.top-bar')).toBeVisible();
    await expect(
      page.getByTestId('auth-continue').or(page.getByTestId('post-title')),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('a read-only storage still reads its stored theme and applies a fragment', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // P1-1: seed dark, then make every preference write throw. Reads must keep
    // working: the stored theme and the fragment both have to be applied.
    await page.addInitScript(
      ({ themeKey }) => {
        localStorage.setItem(themeKey, 'dark');
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (String(key).startsWith('selfpage:preference')) {
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
          }
          original.call(this, key, value);
        };
      },
      { themeKey: THEME_KEY },
    );

    await openApp(page, '/new/#theme=light&motion=reduce&size=large');
    const state = await readRootState(page);
    expect(state.theme, 'the fragment wins for this page').toBe('light');
    expect(state.motion).toBe('reduce');
    expect(state.textSize).toBe('large');
    expect(state.meta).toBe('light');
    expect(new URL(page.url()).hash, 'the one-time fragment is still removed').toBe('');
    expect((await readStored(page)).theme, 'the failed write leaves the stored value alone').toBe(
      'dark',
    );
    expect(
      await page.evaluate(() => localStorage.getItem('selfpage:preference:probe')),
      'the probe key is cleaned up',
    ).toBeNull();
    await expect(page.locator('.top-bar')).toBeVisible();
    expect(pageErrors, 'no uncaught errors with read-only storage').toEqual([]);
  });

  test('invalid or unrelated fragments are ignored and do not touch preferences', async ({ page }) => {
    await openApp(page, '/new/#theme=purple&session=abc&motion=reduce');
    const state = await readRootState(page);
    expect(state.theme, 'an invalid theme is ignored').toBeNull();
    expect(state.motion, 'a valid value next to invalid ones still imports').toBe('reduce');
    expect(state.textSize).toBeNull();
    expect((await readStored(page)).theme).toBeNull();
    expect((await readStored(page)).motion).toBe('reduce');

    await page.goto('/new/#unrelated=1');
    // Same-document hash change: reload so the boot parser actually runs again.
    await page.reload();
    await expect(page.locator('.top-bar')).toBeVisible();
    expect(await readRootState(page)).toMatchObject({ theme: null, motion: 'reduce', textSize: null });
  });
});

test.describe('R08-3 Settings entry on the author origin', () => {  test('Settings is a link to the public site page, not a second author settings surface', async ({
    page,
  }) => {
    await openApp(page);
    await openDrawer(page);
    const settings = page.locator('.site-nav__settings');
    await expect(settings).toHaveCount(1);
    await expect(settings).toHaveJSProperty('tagName', 'A');
    await expect(settings).toHaveText('Settings');
    await expect(settings).toHaveAttribute('href', PUBLIC_SETTINGS_URL);
    await expect(settings).not.toHaveAttribute('aria-current', /.+/u);

    // It is not a navigation list item and creates no second-level entry.
    expect(
      await page.locator('nav[aria-label="Site"] .site-nav__settings').count(),
      'Settings stays outside the navigation list',
    ).toBe(0);

    // No session data is ever added to the link.
    const href = await settings.getAttribute('href');
    expect(href ?? '').not.toMatch(/[?&](session|token|state|code|verifier)=/iu);
  });

  test('the author origin has no /settings/ route of its own', async ({ page }) => {
    await page.goto('/settings/');
    await expect(page.locator('.top-bar')).toBeVisible();
    const inventory = await page.evaluate(() => ({
      navPage: document.documentElement.getAttribute('data-nav-page'),
      settingsHeading: [...document.querySelectorAll('h1')].some(
        (heading) => (heading.textContent ?? '').trim() === 'Settings',
      ),
      radios: document.querySelectorAll('input[data-preference]').length,
    }));
    expect(inventory.navPage, 'the author shell keeps its own page type').toBe('author');
    expect(inventory.settingsHeading, 'no Settings page is rendered on the author origin').toBe(false);
    expect(inventory.radios, 'no preference controls are rendered on the author origin').toBe(0);
  });
});
