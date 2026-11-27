import { expect, test, type Page } from '@playwright/test';


/**
 * Task 08 independent verification (U01–U07, U12), written without reusing the
 * executor's spec helpers.
 *
 * The public site is served from the built `dist/` (see tests/run-e2e.mjs).
 * This file deliberately probes the cases that can pass while being uncovered:
 * System writing no key at all (not the literal "system"), OS changes after an
 * explicit choice, cross-tab and pageshow/bfcache adoption, both blocked-storage
 * injections, the state of `<html>`/`<meta>` at DOMContentLoaded plus the first
 * animation frame, the full 2x3 OS × user motion matrix, root-font ownership at
 * 200%, and an independently computed WCAG contrast pass.
 */

const THEME_KEY = 'selfpage:preference:theme';
const MOTION_KEY = 'selfpage:preference:motion';
const TEXT_SIZE_KEY = 'selfpage:preference:text-size';
const PREFERENCE_PREFIX = 'selfpage:preference:';
const POST_2026 = '/blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/';
const POST_2025 = '/blog/2025/Notes%20on%20Accessible%20Navigation-2025-11-02-14-05-00/';

interface StorageState {
  theme: string | null;
  motion: string | null;
  textSize: string | null;
  keys: string[];
  systemLiterals: string[];
}

interface RootState {
  theme: string | null;
  motion: string | null;
  textSize: string | null;
  meta: string | null;
  colorScheme: string;
  htmlFontSize: string;
  inlineRootFontSize: string;
  scrollBehavior: string;
  bodyBackground: string;
}

async function storageState(page: Page): Promise<StorageState> {
  return page.evaluate(
    ({ themeKey, motionKey, textSizeKey, prefix }) => {
      const keys = Object.keys(localStorage).filter((key) => key.startsWith(prefix));
      const values = keys.map((key) => localStorage.getItem(key) ?? '');
      return {
        theme: localStorage.getItem(themeKey),
        motion: localStorage.getItem(motionKey),
        textSize: localStorage.getItem(textSizeKey),
        keys,
        systemLiterals: keys.filter((key) => localStorage.getItem(key) === 'system'),
      };
    },
    { themeKey: THEME_KEY, motionKey: MOTION_KEY, textSizeKey: TEXT_SIZE_KEY, prefix: PREFERENCE_PREFIX },
  );
}

async function rootState(page: Page): Promise<RootState> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    return {
      theme: root.getAttribute('data-theme'),
      motion: root.getAttribute('data-motion'),
      textSize: root.getAttribute('data-text-size'),
      meta: meta?.getAttribute('content') ?? null,
      colorScheme: getComputedStyle(root).colorScheme,
      htmlFontSize: getComputedStyle(root).fontSize,
      inlineRootFontSize: root.style.fontSize,
      scrollBehavior: getComputedStyle(root).scrollBehavior,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  });
}

/** Collects uncaught errors and CSP/refusal console errors for a page. */
function consoleGuard(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/content security policy|refused to (execute|load|apply)|violates the following/iu.test(text)) {
      problems.push(`console: ${text}`);
    }
  });
  return problems;
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings/');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
}

async function openDrawer(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
}

async function choose(page: Page, name: string, value: string): Promise<void> {
  const radio = page.locator(`input[data-preference="${name}"][value="${value}"]`);
  await radio.check();
  await expect(radio).toBeChecked();
}

async function assertNotBlank(page: Page, label: string): Promise<void> {
  const info = await page.evaluate(() => ({
    text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().length,
    main: document.querySelectorAll('main').length,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));
  expect(info.text, `${label}: body has visible text`).toBeGreaterThan(40);
  expect(info.main, `${label}: exactly one main`).toBe(1);
  expect(info.bodyBackground, `${label}: body has an explicit canvas`).not.toBe('rgba(0, 0, 0, 0)');
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseCssColor(value: string): Rgba | null {
  const match = /^rgba?\(([^)]+)\)$/u.exec(value.trim());
  const body = match?.[1];
  if (body === undefined) return null;
  const parts = body.split(/[\s,/]+/u).filter((token) => token !== '').map(Number);
  const [r, g, b, a] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r, g, b, a: a ?? 1 };
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first: Rgba, second: Rgba): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

interface ColorSample {
  selector: string;
  part: 'text' | 'border' | 'outline';
  foreground: string;
  background: string;
  ratio: number;
}

/**
 * Reads a computed colour plus the composited background behind it.
 * `backgroundSelector`/`backgroundPseudo` let the caller point at a painted
 * pseudo-element (the top bar band paints `.top-bar::before`).
 */
async function sampleColor(
  page: Page,
  selector: string,
  part: 'text' | 'border' | 'outline',
  backgroundSelector?: string,
  backgroundPseudo?: string,
): Promise<ColorSample | null> {
  const raw = await page.evaluate(
    ({ targetSelector, targetPart, bgSelector, bgPseudo }) => {
      const element = document.querySelector<HTMLElement>(targetSelector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const foreground =
        targetPart === 'text'
          ? style.color
          : targetPart === 'border'
            ? style.borderInlineStartColor
            : style.outlineColor;
      const backgroundSource = bgSelector
        ? document.querySelector<HTMLElement>(bgSelector)
        : element;
      const background = backgroundSource
        ? bgPseudo
          ? getComputedStyle(backgroundSource, bgPseudo).backgroundColor
          : getComputedStyle(backgroundSource).backgroundColor
        : null;
      return { foreground, background };
    },
    { targetSelector: selector, targetPart: part, bgSelector: backgroundSelector, bgPseudo: backgroundPseudo },
  );
  if (!raw) return null;
  const foreground = parseCssColor(raw.foreground);
  let background = raw.background === null ? null : parseCssColor(raw.background);
  if (!foreground || !background) return null;
  if (background.a < 1) {
    // Composite against the document canvas read from <body>.
    const canvasRaw = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const canvas = parseCssColor(canvasRaw);
    if (canvas) background = composite(background, canvas);
  }
  return {
    selector,
    part,
    foreground: raw.foreground,
    background: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
    ratio: contrastRatio(foreground, background),
  };
}

function expectContrast(sample: ColorSample | null, minimum: number, label: string): number {
  expect(sample, `${label}: could not sample a colour`).not.toBeNull();
  if (!sample) return 0;
  console.log(`CONTRAST ${label}: ${sample.ratio.toFixed(2)} (${sample.foreground} on ${sample.background})`);
  expect(sample.ratio, `${label}: ${sample.foreground} on ${sample.background}`).toBeGreaterThanOrEqual(minimum);
  return sample.ratio;
}

test.describe('U01 independent: no System key, explicit choices pinned, cross-tab and pageshow', () => {
  test('System leaves no key, explicit values are exact, OS changes cannot override, a second tab and pageshow adopt', async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSettings(page);

    const initial = await storageState(page);
    expect(initial, 'System/System/Default stores nothing').toEqual({
      theme: null,
      motion: null,
      textSize: null,
      keys: [],
      systemLiterals: [],
    });
    const initialRoot = await rootState(page);
    expect(initialRoot.theme, 'System sets no data-theme').toBeNull();
    expect(initialRoot.meta, 'System meta still supports both schemes').toBe('light dark');
    expect(initialRoot.colorScheme, 'System computed color-scheme').toBe('light dark');

    // Explicit Dark: the stored value is `dark`, never `system`, and an OS
    // change after the choice must not win.
    await page.emulateMedia({ colorScheme: 'dark' });
    await choose(page, 'theme', 'dark');
    let stored = await storageState(page);
    expect(stored.theme, 'explicit Dark stored as dark').toBe('dark');
    expect(stored.systemLiterals, 'no key stores the literal "system"').toEqual([]);
    expect(stored.keys, 'only explicit preferences create keys').toEqual([THEME_KEY]);

    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(150);
    let root = await rootState(page);
    expect(root.theme, 'OS change cannot override explicit Dark').toBe('dark');
    expect(root.bodyBackground, 'the canvas stays dark after the OS change').toBe('rgb(21, 21, 23)');
    expect(root.meta).toBe('dark');

    // A second tab in the same context receives the storage event.
    const second = await context.newPage();
    await second.emulateMedia({ colorScheme: 'light' });
    await second.goto('/');
    await expect.poll(async () => (await rootState(second)).theme, { timeout: 5000 }).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await choose(page, 'theme', 'light');
    await expect.poll(async () => (await rootState(second)).theme, { timeout: 5000 }).toBe('light');
    expect((await rootState(second)).meta, 'second tab meta follows the storage event').toBe('light');

    // Back to System: the override key is deleted (not set to "system").
    await choose(page, 'theme', 'system');
    stored = await storageState(page);
    expect(stored.theme, 'System deletes the theme key').toBeNull();
    expect(stored.keys, 'no preference keys remain after System').toEqual([]);
    expect((await rootState(page)).theme).toBeNull();
    expect((await rootState(page)).meta).toBe('light dark');
    await expect.poll(async () => (await rootState(second)).theme, { timeout: 5000 }).toBeNull();
    expect((await rootState(second)).meta).toBe('light dark');

    // Refresh keeps System (nothing to restore).
    await page.reload();
    expect((await rootState(page)).theme, 'refresh keeps System').toBeNull();
    expect((await storageState(page)).theme).toBeNull();

    // bfcache/pageshow: an out-of-band write from this same document does not
    // fire a storage event, so only the pageshow handler can adopt it.
    await page.evaluate((key) => localStorage.setItem(key, 'dark'), THEME_KEY);
    expect((await rootState(page)).theme, 'a same-document write alone does not apply').toBeNull();
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await expect.poll(async () => (await rootState(page)).theme, { timeout: 5000 }).toBe('dark');
    expect((await rootState(page)).colorScheme, 'pageshow also updates the computed scheme').toBe('dark');

    // Clean up so the final System assertion is meaningful.
    await page.evaluate((key) => {
      localStorage.removeItem(key);
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }, THEME_KEY);
    await expect.poll(async () => (await rootState(page)).theme, { timeout: 5000 }).toBeNull();
    await second.close();
  });

  test('back/forward history restores the theme from storage and records whether bfcache was used', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const scope = window as unknown as { __pageShow: Array<{ persisted: boolean; theme: string | null }> };
      scope.__pageShow = [];
      window.addEventListener('pageshow', (event) => {
        scope.__pageShow.push({
          persisted: (event as PageTransitionEvent).persisted,
          theme: document.documentElement.getAttribute('data-theme'),
        });
      });
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/blog/');
    expect((await rootState(page)).theme, 'start on System').toBeNull();

    await openSettings(page);
    await choose(page, 'theme', 'dark');
    expect((await rootState(page)).theme).toBe('dark');

    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(page.url(), 'back returned to the Blog index').toMatch(/\/blog\/$/u);
    await expect.poll(async () => (await rootState(page)).theme, { timeout: 5000 }).toBe('dark');

    const pageShow = await page.evaluate(
      () => (window as unknown as { __pageShow: Array<{ persisted: boolean; theme: string | null }> }).__pageShow,
    );
    console.log(`PAGESHOW records=${JSON.stringify(pageShow)}`);
    expect(pageShow.length, 'a pageshow fired during the history walk').toBeGreaterThan(0);

    await page.goForward();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect((await rootState(page)).theme, 'forward keeps the explicit theme').toBe('dark');
  });
});

test.describe('U02 independent: blocked localStorage never breaks the page', () => {
  test('localStorage getter throws: readable pages, switching works, cannot-save notice, no page errors', async ({
    page,
  }) => {
    const problems = consoleGuard(page);
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked by policy', 'SecurityError');
        },
      });
    });

    await page.goto('/');
    await assertNotBlank(page, '/ with throwing localStorage getter');
    await openDrawer(page);
    expect((await rootState(page)).theme, 'System still applies with blocked storage').toBeNull();

    await openSettings(page);
    const status = page.locator('[data-settings-status]');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status, 'blocked-storage notice in English').toContainText(/can't be saved/u);
    await expect(status).toContainText(/blocked local storage/u);

    await choose(page, 'theme', 'dark');
    await choose(page, 'motion', 'reduce');
    await choose(page, 'textSize', 'large');
    const root = await rootState(page);
    expect(root.theme, 'the choice applies immediately').toBe('dark');
    expect(root.meta, 'meta follows the in-page choice').toBe('dark');
    expect(root.colorScheme).toBe('dark');
    expect(root.bodyBackground).toBe('rgb(21, 21, 23)');
    expect(root.textSize, 'text size applies immediately').toBe('large');
    const bodySize = await page.evaluate(() => getComputedStyle(document.body).fontSize);
    expect(bodySize, 'Large applies without storage').toBe('18px');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.locator('[data-settings-status]')).toContainText(/blocked local storage/u);
    await assertNotBlank(page, 'Settings after reload with blocked storage');
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });

  test('Storage.prototype.setItem throws: every public page stays usable and no error escapes', async ({
    page,
  }) => {
    const problems = consoleGuard(page);
    await page.addInitScript(() => {
      Storage.prototype.setItem = function setItem(): void {
        throw new DOMException('quota/blocked', 'QuotaExceededError');
      };
    });

    for (const path of ['/', '/publications/', '/blog/', POST_2025, '/settings/']) {
      await page.goto(path);
      await assertNotBlank(page, `${path} with throwing setItem`);
    }

    await openSettings(page);
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);
    await choose(page, 'theme', 'dark');
    expect((await rootState(page)).theme, 'switch applies in memory').toBe('dark');
    // getItem still works; nothing was written.
    const stored = await storageState(page);
    expect(stored.keys, 'no preference key was written').toEqual([]);
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });

  test('readable-but-unwritable storage keeps the stored non-default preferences applied', async ({
    page,
  }) => {
    // Regression probe reported by the independent code reviewer: when reads
    // still work but writes throw, the boot script applies the stored theme and
    // then initPreferences() must NOT fall back to defaults and wipe it.
    const problems = consoleGuard(page);
    await page.addInitScript(
      ({ themeKey, motionKey, textSizeKey }) => {
        localStorage.setItem(themeKey, 'dark');
        localStorage.setItem(motionKey, 'reduce');
        localStorage.setItem(textSizeKey, 'large');
      },
      { themeKey: THEME_KEY, motionKey: MOTION_KEY, textSizeKey: TEXT_SIZE_KEY },
    );
    await page.addInitScript(() => {
      Storage.prototype.setItem = function setItem(): void {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      };
    });

    await page.goto('/settings/');
    // Wait for the deferred module bundle to run and re-apply the store state.
    await page.waitForTimeout(300);
    const root = await rootState(page);
    expect(root.theme, 'the stored Dark theme survives a failed write probe').toBe('dark');
    expect(root.meta, 'meta keeps the stored theme').toBe('dark');
    expect(root.colorScheme, 'computed color-scheme keeps the stored theme').toBe('dark');
    expect(root.bodyBackground, 'the canvas keeps the stored theme').toBe('rgb(21, 21, 23)');
    expect(root.motion, 'the stored Reduce choice survives').toBe('reduce');
    expect(root.textSize, 'the stored Large choice survives').toBe('large');
    const bodySize = await page.evaluate(() => getComputedStyle(document.body).fontSize);
    expect(bodySize, 'Large still applies from the readable storage').toBe('18px');

    // getItem is unaffected, so the stored values are still there.
    const stored = await storageState(page);
    expect(stored.theme).toBe('dark');
    expect(stored.motion).toBe('reduce');
    expect(stored.textSize).toBe('large');

    // The controls and the live status must reflect the stored state and say
    // that new changes cannot be saved.
    await expect(page.locator('input[data-preference="theme"][value="dark"]')).toBeChecked();
    await expect(page.locator('input[data-preference="motion"][value="reduce"]')).toBeChecked();
    await expect(page.locator('input[data-preference="textSize"][value="large"]')).toBeChecked();
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });

  test('a successful removeItem never turns a read-only storage into "saved" (P2-2)', async ({
    page,
  }) => {
    // Supplementary round 0b92743: a read-only localStorage can still delete
    // existing keys, but that must not be mistaken for write capability. The
    // old behaviour showed "Your settings are saved" after a removal even
    // though the preceding setItem never reached storage.
    const problems = consoleGuard(page);
    await page.addInitScript(() => {
      const scope = window as unknown as { __removedKeys: string[] };
      scope.__removedKeys = [];
      const originalRemove = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function removeItem(key: string) {
        scope.__removedKeys.push(key);
        return originalRemove.call(this, key);
      };
      Storage.prototype.setItem = function setItem(): void {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      };
    });
    await openSettings(page);
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);

    // A real (failed) preference write: Light never reaches storage.
    await choose(page, 'theme', 'light');
    expect((await rootState(page)).theme, 'the in-memory Light applies').toBe('light');
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);

    // Now make motion non-default (failed write), then ask for System, which
    // only calls removeItem — and removeItem succeeds in this read-only store.
    await choose(page, 'motion', 'reduce');
    await page.locator('input[data-preference="motion"][value="system"]').check();
    await page.waitForTimeout(100);
    const removals = await page.evaluate(
      () => (window as unknown as { __removedKeys: string[] }).__removedKeys,
    );
    expect(removals, 'the System choice really called removeItem').toContain(MOTION_KEY);
    const status = (await page.locator('[data-settings-status]').textContent()) ?? '';
    console.log(`P2-2 STATUS after a successful removeItem: ${JSON.stringify(status)}`);
    expect(status, 'a successful removal is not write capability').toContain("can't be saved");
    expect(status, 'the UI must never claim it saved a value that never reached storage').not.toMatch(
      /settings are saved/iu,
    );
    expect((await rootState(page)).theme, 'the in-memory Light still applies').toBe('light');
    await expect(page.locator('input[data-preference="theme"][value="light"]')).toBeChecked();
    expect(
      await page.evaluate(() => localStorage.getItem('selfpage:preference:theme')),
      'the theme never reached storage',
    ).toBeNull();
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });

  test('a cross-tab write cannot reset this page when its own storage is unreadable (risk 3)', async ({
    page,
    context,
  }) => {
    // Supplementary round b732f60: with window.localStorage throwing, another
    // tab's write used to arrive as a storage event and re-adopt
    // readStoredPreferences(null) — i.e. defaults over the in-memory choice.
    const problems = consoleGuard(page);
    await page.addInitScript(() => {
      const scope = window as unknown as { __storageEvents: string[] };
      scope.__storageEvents = [];
      window.addEventListener('storage', (event) => {
        scope.__storageEvents.push(`${event.key ?? 'null'}:${event.newValue ?? ''}`);
      });
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked by policy', 'SecurityError');
        },
      });
    });
    await openSettings(page);
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);
    await choose(page, 'theme', 'dark');
    expect((await rootState(page)).theme, 'the in-memory Dark applies').toBe('dark');

    // A second tab on the same origin can still write; the real browser storage
    // event must reach the blocked page.
    const other = await context.newPage();
    await other.goto('/settings/');
    await other.locator('input[data-preference="theme"][value="light"]').check();
    expect(
      await other.evaluate(() => localStorage.getItem('selfpage:preference:theme')),
      'the other tab really stored Light',
    ).toBe('light');
    await expect
      .poll(
        async () =>
          page.evaluate(() => (window as unknown as { __storageEvents: string[] }).__storageEvents.length),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
    await page.waitForTimeout(150);
    const events = await page.evaluate(
      () => (window as unknown as { __storageEvents: string[] }).__storageEvents,
    );
    console.log(`RISK3 storage events observed by the blocked page: ${JSON.stringify(events)}`);
    const after = await rootState(page);
    expect(after.theme, 'the blocked page keeps its in-memory Dark').toBe('dark');
    expect(after.meta, 'meta keeps the in-memory Dark').toBe('dark');
    await expect(page.locator('input[data-preference="theme"][value="dark"]')).toBeChecked();
    await other.close();
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });
});

test.describe('U03 independent: first paint, head order and meta/computed agreement', () => {
  test('stored preferences are on <html> at DOMContentLoaded and at the first animation frame, before styles', async ({
    page,
  }) => {
    const problems = consoleGuard(page);
    await page.addInitScript(
      ({ themeKey, motionKey, textSizeKey }) => {
        localStorage.setItem(themeKey, 'dark');
        localStorage.setItem(motionKey, 'reduce');
        localStorage.setItem(textSizeKey, 'large');
        const scope = window as unknown as {
          __frames: Array<{
            readyState: string;
            theme: string | null;
            motion: string | null;
            textSize: string | null;
            hasMeta: boolean;
            hasBody: boolean;
            colorScheme: string;
          }>;
        };
        scope.__frames = [];
        const record = (): void => {
          scope.__frames.push({
            readyState: document.readyState,
            theme: document.documentElement.getAttribute('data-theme'),
            motion: document.documentElement.getAttribute('data-motion'),
            textSize: document.documentElement.getAttribute('data-text-size'),
            hasMeta: document.querySelector('meta[name="color-scheme"]') !== null,
            hasBody: document.body !== null,
            colorScheme: getComputedStyle(document.documentElement).colorScheme,
          });
          if (scope.__frames.length < 10) requestAnimationFrame(record);
        };
        requestAnimationFrame(record);
      },
      { themeKey: THEME_KEY, motionKey: MOTION_KEY, textSizeKey: TEXT_SIZE_KEY },
    );

    await page.goto('/settings/', { waitUntil: 'domcontentloaded' });
    const atDomContentLoaded = await rootState(page);
    expect(atDomContentLoaded.theme, 'data-theme at DOMContentLoaded').toBe('dark');
    expect(atDomContentLoaded.motion).toBe('reduce');
    expect(atDomContentLoaded.textSize).toBe('large');
    expect(atDomContentLoaded.meta, 'meta matches the stored theme').toBe('dark');
    expect(atDomContentLoaded.colorScheme, 'computed color-scheme matches the meta').toBe('dark');
    expect(atDomContentLoaded.bodyBackground).toBe('rgb(21, 21, 23)');
    expect(atDomContentLoaded.htmlFontSize, 'Text Size never changes the root font size').toBe('16px');
    expect(atDomContentLoaded.inlineRootFontSize, 'no inline root font-size is set').toBe('');

    const headFacts = await page.evaluate(() => {
      const bootScript = document.head.querySelector<HTMLScriptElement>('script:not([src])');
      const nodes = [...document.head.querySelectorAll('script, link[rel="stylesheet"], style')];
      const bootIndex = bootScript ? nodes.indexOf(bootScript) : -1;
      const firstStyle = nodes.findIndex(
        (node) => node.tagName === 'STYLE' || (node.tagName === 'LINK' && node.getAttribute('rel') === 'stylesheet'),
      );
      const frames = (window as unknown as { __frames: Array<Record<string, unknown>> }).__frames;
      return {
        bootIndex,
        firstStyle,
        tags: nodes.map((node) => node.tagName),
        inlineScript: bootScript?.textContent ?? '',
        frames,
        paint: performance.getEntriesByType('paint').map((entry) => ({ name: entry.name, startTime: entry.startTime })),
      };
    });

    expect(headFacts.bootIndex, 'inline boot script exists in <head>').toBeGreaterThanOrEqual(0);
    expect(
      headFacts.bootIndex,
      `boot script precedes the first style (${headFacts.tags.join(',')})`,
    ).toBeLessThan(headFacts.firstStyle);
    expect(headFacts.inlineScript, 'boot script reads the shared theme key').toContain(THEME_KEY);
    expect(headFacts.inlineScript, 'boot script reads the shared motion key').toContain(MOTION_KEY);
    expect(headFacts.inlineScript, 'boot script reads the shared text-size key').toContain(TEXT_SIZE_KEY);

    // Proxy evidence for "no wrong-theme first paint": every frame that already
    // has <body> (i.e. after the head was parsed) also has the stored theme.
    const afterBody = headFacts.frames.filter((frame) => frame.hasBody === true);
    expect(afterBody.length, 'animation frames were observed after <body> existed').toBeGreaterThan(0);
    for (const frame of afterBody) {
      expect(frame.theme, `frame theme (${JSON.stringify(frame)})`).toBe('dark');
      expect(frame.hasMeta).toBe(true);
      expect(frame.colorScheme).toBe('dark');
    }
    expect(headFacts.paint.length, 'paint timing entries available').toBeGreaterThan(0);
    const firstPaint = headFacts.paint.find((entry) => entry.name === 'first-paint');
    const firstContentful = headFacts.paint.find((entry) => entry.name === 'first-contentful-paint');
    console.log(`PAINT first-paint=${firstPaint?.startTime ?? 'n/a'} fcp=${firstContentful?.startTime ?? 'n/a'}`);
    expect(firstPaint?.startTime ?? 0).toBeGreaterThan(0);
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });

  test('the first-paint radio matches the stored theme before any module bundle runs', async ({
    page,
  }) => {
    // 93c1dd2 claims the server-rendered radio is synced at first paint. With
    // every module bundle aborted, only the inline head script can do that, so
    // this cannot pass because the settings controller later fixed it up.
    const problems = consoleGuard(page);
    await page.addInitScript(
      ({ themeKey, motionKey, textSizeKey }) => {
        localStorage.setItem(themeKey, 'dark');
        localStorage.setItem(motionKey, 'reduce');
        localStorage.setItem(textSizeKey, 'large');
      },
      { themeKey: THEME_KEY, motionKey: MOTION_KEY, textSizeKey: TEXT_SIZE_KEY },
    );
    await page.route('**/_astro/*.js', (route) => route.abort());
    await page.goto('/settings/');
    const state = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme'),
      meta: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
      checked: [...document.querySelectorAll<HTMLInputElement>('input[data-preference]:checked')].map(
        (input) => `${input.dataset.preference ?? ''}=${input.value}`,
      ),
    }));
    console.log(`FIRST PAINT RADIO ${JSON.stringify(state)}`);
    expect(state.theme, 'the inline boot script applied the stored theme').toBe('dark');
    expect(state.meta).toBe('dark');
    expect(
      state.checked,
      'the checked radios already match the stored theme/motion/size at first paint',
    ).toEqual(['theme=dark', 'motion=reduce', 'textSize=large']);
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
    await page.unroute('**/_astro/*.js');
  });
});

test.describe('U04 independent: 2x3 OS x user motion matrix', () => {
  interface MotionRow {
    os: 'no-preference' | 'reduce';
    user: 'system' | 'reduce' | 'full';
  }
  const rows: MotionRow[] = [
    { os: 'no-preference', user: 'system' },
    { os: 'no-preference', user: 'reduce' },
    { os: 'no-preference', user: 'full' },
    { os: 'reduce', user: 'system' },
    { os: 'reduce', user: 'reduce' },
    { os: 'reduce', user: 'full' },
  ];

  test('six combinations produce the expected transitions and final states', async ({ page }) => {
    test.setTimeout(180_000);
    for (const row of rows) {
      await page.emulateMedia({ reducedMotion: row.os, colorScheme: 'light' });
      await page.addInitScript(
        ({ motionKey, user }) => {
          if (user === 'system') localStorage.removeItem(motionKey);
          else localStorage.setItem(motionKey, user);
        },
        { motionKey: MOTION_KEY, user: row.user },
      );
      await page.goto(POST_2026);
      await openDrawer(page);

      const state = await page.evaluate(() => {
        const drawer = document.getElementById('site-drawer');
        const preview = document.querySelector<HTMLElement>('.nav-preview');
        const yearToggle = document.querySelector<HTMLElement>('[data-year-toggle]');
        const overflowLink = document.querySelector<HTMLElement>('.site-nav__post-link[data-overflow="true"]');
        const style = (element: Element | null) => (element ? getComputedStyle(element) : null);
        const drawerStyle = style(drawer);
        return {
          motion: document.documentElement.getAttribute('data-motion'),
          osReduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
          drawerDuration: drawerStyle?.transitionDuration ?? '',
          drawerAnimations: drawer ? drawer.getAnimations().length : -1,
          scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
          previewDuration: style(preview)?.transitionDuration ?? '',
          yearToggleTransition: yearToggle ? getComputedStyle(yearToggle, '::after').transitionDuration : '',
          overflowLinkExists: overflowLink !== null,
        };
      });
      const motionOn = row.os === 'no-preference' ? row.user !== 'reduce' : row.user === 'full';
      const tag = `OS=${row.os} user=${row.user}`;
      expect(state.osReduce, `${tag}: emulated OS preference taken`).toBe(row.os === 'reduce');
      expect(state.motion, `${tag}: root data-motion`).toBe(row.user === 'system' ? null : row.user);

      const drawerDurations = state.drawerDuration.split(',').map((part) => part.trim());
      if (motionOn) {
        expect(drawerDurations[0], `${tag}: drawer transition restored`).toBe('0.2s');
        expect(state.scrollBehavior, `${tag}: smooth fragment scrolling`).toBe('smooth');
        expect(state.previewDuration, `${tag}: preview fade restored`).toContain('0.12s');
        expect(state.yearToggleTransition, `${tag}: year chevron transition restored`).toContain('0.12s');
      } else {
        expect(drawerDurations.every((duration) => duration === '0s'), `${tag}: drawer has no duration`).toBe(true);
        expect(state.drawerAnimations, `${tag}: drawer has no running animation`).toBe(0);
        expect(state.scrollBehavior, `${tag}: instant fragment scrolling`).toBe('auto');
        expect(state.previewDuration, `${tag}: preview has no transition`).toBe('0s');
        expect(state.yearToggleTransition, `${tag}: chevron has no transition`).toBe('0s');
      }
      expect(state.overflowLinkExists, `${tag}: an overflowing label exists to probe the marquee`).toBe(true);

      // Marquee transition lives on the text span and only under `:hover` or
      // `:focus-visible`; hover it with a real pointer and read the resolved
      // transition (a synthetic mouseover does not match CSS :hover).
      const postLink = page.locator('.site-nav__post-link[data-overflow="true"]').first();
      await postLink.hover();
      await page.waitForTimeout(50);
      const marquee = await postLink.evaluate((link) => {
        const text = link.querySelector<HTMLElement>('.site-nav__post-text');
        const label = link.querySelector<HTMLElement>('.site-nav__post-label');
        return {
          textTransition: text ? getComputedStyle(text).transitionDuration : '',
          textTransform: text ? getComputedStyle(text).transform : '',
          labelTextOverflow: label ? getComputedStyle(label).textOverflow : '',
        };
      });
      if (motionOn) {
        expect(marquee.textTransition, `${tag}: marquee transition restored`).not.toBe('0s');
        expect(marquee.textTransform, `${tag}: marquee moves the text`).not.toBe('none');
        expect(marquee.labelTextOverflow, `${tag}: marquee clips the ellipsis`).toBe('clip');
      } else {
        expect(marquee.textTransition, `${tag}: marquee has no transition`).toBe('0s');
        expect(marquee.textTransform, `${tag}: marquee does not move`).toBe('none');
        expect(marquee.labelTextOverflow, `${tag}: the label keeps its ellipsis`).toBe('ellipsis');
      }
    }
  });

  test('Reduce reaches every final state without waiting for animationend/transitionend', async ({ page }) => {
    const problems = consoleGuard(page);
    // Only the combinations whose resolved motion is "reduce": OS reduce with
    // System/Reduce, and the explicit Reduce choice over a no-preference OS.
    const reducedRows: Array<{ os: 'no-preference' | 'reduce'; user: 'system' | 'reduce' }> = [
      { os: 'no-preference', user: 'reduce' },
      { os: 'reduce', user: 'system' },
      { os: 'reduce', user: 'reduce' },
    ];
    for (const row of reducedRows) {
      {
        const os = row.os;
        const user = row.user;
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.emulateMedia({ reducedMotion: os, colorScheme: 'light' });
        await page.addInitScript(
          ({ motionKey, value }) => {
            if (value === 'system') localStorage.removeItem(motionKey);
            else localStorage.setItem(motionKey, value);
          },
          { motionKey: MOTION_KEY, value: user },
        );
        await page.goto('/blog/');
        const tag = `OS=${os} user=${user}`;
        await openDrawer(page);
        const opened = await page.evaluate(() => {
          const drawer = document.getElementById('site-drawer');
          return {
            open: document.documentElement.getAttribute('data-drawer-open'),
            visibility: drawer ? getComputedStyle(drawer).visibility : '',
            transform: drawer ? getComputedStyle(drawer).transform : '',
            animations: drawer ? drawer.getAnimations().length : -1,
          };
        });
        expect(opened.open, `${tag}: drawer opens`).toBe('true');
        expect(opened.visibility, `${tag}: drawer visible in the same task`).toBe('visible');
        expect(opened.transform, `${tag}: drawer at its final transform`).toBe('matrix(1, 0, 0, 1, 0, 0)');
        expect(opened.animations, `${tag}: no running drawer animation`).toBe(0);

        // Year expansion: the list is un-hidden immediately, no animation wait.
        const year = page.locator('[data-year-toggle][data-year="2025"]');
        await year.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#nav-year-2025-posts')).not.toHaveAttribute('hidden', '');
        const expanded = await page.evaluate(() => {
          const list = document.getElementById('nav-year-2025-posts');
          const toggle = document.querySelector<HTMLElement>('[data-year-toggle][data-year="2025"]');
          return {
            animations: list ? list.getAnimations().length : -1,
            ariaExpanded: toggle?.getAttribute('aria-expanded') ?? null,
            hash: location.hash,
          };
        });
        expect(expanded.ariaExpanded, `${tag}: the year is expanded`).toBe('true');
        expect(expanded.animations, `${tag}: the post list has no animation`).toBe(0);
        expect(expanded.hash, `${tag}: fragment navigation still happens`).toBe('#year-2025');
        console.log(
          `REDUCE SCROLL ${tag}: ${JSON.stringify(
            await page.evaluate(() => ({
              scrollY: window.scrollY,
              height: document.documentElement.scrollHeight,
              viewport: window.innerHeight,
              targetTop: document.getElementById('year-2025')?.getBoundingClientRect().top ?? null,
              active: (document.activeElement as HTMLElement | null)?.className ?? '',
            })),
          )}`,
        );
        // The archive can be shorter than the viewport, so the fragment may
        // clamp and not move scrollY; the contract is that the target ends up
        // inside the viewport without waiting for an animation.
        await expect
          .poll(
            async () =>
              page.evaluate(() => {
                const target = document.getElementById('year-2025');
                if (!target) return false;
                const box = target.getBoundingClientRect();
                return box.top >= -1 && box.top < window.innerHeight;
              }),
            { timeout: 5000 },
          )
          .toBe(true);

        // Close is immediate too. The close row only exists in the narrow
        // overlay, so switch form factor before closing.
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
        await page.getByRole('button', { name: 'Close' }).click();
        const closed = await page.evaluate(() => {
          const drawer = document.getElementById('site-drawer');
          return drawer ? getComputedStyle(drawer).visibility : '';
        });
        expect(closed, `${tag}: closing is immediate, no transitionend wait`).toBe('hidden');
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    }

    // Static check: the shipped bundles must not depend on animation end events.
    const scriptSources = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((script) => script.src),
    );
    expect(scriptSources.length, 'the built page loads module bundles').toBeGreaterThan(0);
    for (const source of scriptSources) {
      const response = await page.request.get(source);
      expect(response.ok(), `bundle ${source} fetched`).toBe(true);
      const body = await response.text();
      expect(body, `${source} must not wait for animationend`).not.toMatch(/animationend/iu);
      expect(body, `${source} must not wait for transitionend`).not.toMatch(/transitionend/iu);
    }
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });
});

test.describe('U05 independent: text size owns component tokens only', () => {
  test('16/14/18px body on every page type, html stays 16px, no inline root font-size', async ({ page }) => {
    await openSettings(page);
    const pages = ['/', '/blog/', POST_2026, '/settings/'];
    const cases: Array<{ value: 'default' | 'small' | 'large'; body: string; mainText: string }> = [
      { value: 'default', body: '16px', mainText: '16px' },
      { value: 'small', body: '14px', mainText: '14px' },
      { value: 'large', body: '18px', mainText: '18px' },
    ];
    for (const item of cases) {
      await openSettings(page);
      await choose(page, 'textSize', item.value);
      for (const path of pages) {
        await page.goto(path);
        const measured = await page.evaluate(() => {
          // Resolve the component typography token directly: this is the value
          // the whole site reads, independent of which element happens to be
          // first in <main>.
          const probe = document.createElement('div');
          probe.style.fontSize = 'var(--font-size-body)';
          probe.style.position = 'absolute';
          probe.style.visibility = 'hidden';
          document.body.append(probe);
          const resolvedBodyToken = getComputedStyle(probe).fontSize;
          probe.remove();
          return {
            html: getComputedStyle(document.documentElement).fontSize,
            inlineRoot: document.documentElement.style.fontSize,
            body: getComputedStyle(document.body).fontSize,
            mainText: resolvedBodyToken,
            scale: getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim(),
            attr: document.documentElement.getAttribute('data-text-size'),
          };
        });
        const tag = `${item.value} ${path}`;
        expect(measured.html, `${tag}: root font-size is browser-owned`).toBe('16px');
        expect(measured.inlineRoot, `${tag}: no inline root font-size`).toBe('');
        expect(measured.body, `${tag}: body token`).toBe(item.body);
        expect(measured.mainText, `${tag}: component text token`).toBe(item.mainText);
        expect(measured.attr, `${tag}: data-text-size`).toBe(item.value === 'default' ? null : item.value);
        // Browsers serialise the custom property without a leading zero.
        expect(Number.parseFloat(measured.scale), `${tag}: --font-scale`).toBe(
          item.value === 'small' ? 0.875 : item.value === 'large' ? 1.125 : 1,
        );
      }
    }
    // Explicitly named stored value is never "default".
    await openSettings(page);
    await choose(page, 'textSize', 'small');
    expect((await storageState(page)).textSize).toBe('small');
    await choose(page, 'textSize', 'default');
    expect((await storageState(page)).textSize, 'Default deletes the key').toBeNull();
  });

  test('200% root text keeps Large proportional and never double-multiplies or overflows', async ({ page }) => {
    await page.addInitScript(({ textSizeKey }) => localStorage.setItem(textSizeKey, 'large'), {
      textSizeKey: TEXT_SIZE_KEY,
    });
    const pages = ['/', '/publications/', '/blog/', POST_2026, '/settings/'];
    for (const path of pages) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      const measured = await page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).fontSize,
        body: getComputedStyle(document.body).fontSize,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      const tag = `200% ${path}`;
      expect(measured.html, `${tag}: browser-owned root at 200%`).toBe('32px');
      // Large is 1.125 x 32px. A squared/double application would be 40.5px.
      expect(measured.body, `${tag}: Large = 18px x 2, not squared`).toBe('36px');
      expect(measured.scrollWidth, `${tag}: no horizontal scroll`).toBeLessThanOrEqual(measured.clientWidth + 1);

      // 200% browser page zoom reflow proxy: the CSS viewport halves while the
      // root text stays 16px. A real 200% zoom is a 640px layout viewport.
      await page.setViewportSize({ width: 640, height: 450 });
      await page.goto(path);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      const zoomed = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        zoomed.scrollWidth,
        `${tag}: no horizontal scroll at the half-width zoom proxy`,
      ).toBeLessThanOrEqual(zoomed.clientWidth + 1);
    }
  });
});

test.describe('U06 independent: Reset', () => {
  test('Reset from non-default values restores System/System/Default, deletes keys and announces in English', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openSettings(page);
    await choose(page, 'theme', 'light');
    await choose(page, 'motion', 'full');
    await choose(page, 'textSize', 'small');
    expect(await storageState(page)).toMatchObject({ theme: 'light', motion: 'full', textSize: 'small' });

    await page.getByRole('button', { name: 'Reset Settings' }).click();
    const root = await rootState(page);
    expect(root.theme, 'theme attribute removed').toBeNull();
    expect(root.motion, 'motion attribute removed').toBeNull();
    expect(root.textSize, 'text-size attribute removed').toBeNull();
    expect(root.meta).toBe('light dark');
    expect(root.colorScheme).toBe('light dark');
    expect((await storageState(page)).keys, 'every override deleted').toEqual([]);

    const checked = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement>('input[data-preference]:checked')].map(
        (input) => `${input.dataset.preference ?? ''}=${input.value}`,
      ),
    );
    expect(checked, 'UI returns to the three defaults').toEqual([
      'theme=system',
      'motion=system',
      'textSize=default',
    ]);
    const status = page.locator('[data-settings-status]');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toContainText(/reset/u);
    const statusText = (await status.textContent()) ?? '';
    console.log(`RESET STATUS: ${statusText}`);
    expect(statusText, 'status message is real English text').toMatch(/[A-Za-z]{4,}/u);
    expect(statusText, 'status message has no untranslated CJK').not.toMatch(/[\u4e00-\u9fff]/u);

    await page.reload();
    expect((await rootState(page)).theme, 'System survives a reload').toBeNull();
    expect((await storageState(page)).keys).toEqual([]);
  });
});

test.describe('U07 independent: contrast and forced colors', () => {
  async function settingsSurfaceContrast(page: Page, theme: string): Promise<void> {
    await openSettings(page);
    await openDrawer(page);
    expectContrast(await sampleColor(page, '.settings__intro', 'text'), 4.5, `${theme} settings intro`);
    expectContrast(await sampleColor(page, '.settings__option-detail', 'text'), 4.5, `${theme} option hint`);
    expectContrast(await sampleColor(page, '.settings__option', 'border'), 3, `${theme} option border`);
    expectContrast(await sampleColor(page, '.settings__button', 'border'), 3, `${theme} reset border`);
    expectContrast(await sampleColor(page, '.skip-link', 'text'), 4.5, `${theme} skip link`);
    expectContrast(await sampleColor(page, '.site-footer p', 'text'), 4.5, `${theme} footer text`);
    // The fixed Settings row is the current item on this page: its text sits on
    // the state surface and its start indicator must also stay visible.
    expectContrast(
      await sampleColor(page, '.site-nav__settings[aria-current="page"]', 'text'),
      4.5,
      `${theme} current Settings row text`,
    );
    expectContrast(
      await sampleColor(page, '.site-nav__settings[aria-current="page"]', 'border'),
      3,
      `${theme} current Settings row indicator`,
    );

    // Focus ring from the keyboard (not a programmatic focus).
    await page.keyboard.press('Tab');
    const reset = page.locator('[data-settings-reset]');
    await reset.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expectContrast(await sampleColor(page, '[data-settings-reset]', 'outline'), 3, `${theme} reset focus ring`);
  }

  async function navigationContrast(page: Page, theme: string): Promise<void> {
    await page.goto('/');
    await openDrawer(page);
    // The top-bar band is painted by ::before, so it is sampled there; this is
    // also the node axe reports as "incomplete".
    expectContrast(
      await sampleColor(page, '.site-brand', 'text', '.top-bar', '::before'),
      4.5,
      `${theme} brand on top-bar band`,
    );
    expectContrast(
      await sampleColor(page, '.site-nav__link[data-nav-key="publications"]', 'text', '.site-drawer'),
      4.5,
      `${theme} idle nav label`,
    );
    expectContrast(
      await sampleColor(page, '.site-nav__item.is-current > .site-nav__link', 'text'),
      4.5,
      `${theme} current nav label`,
    );
    expectContrast(
      await sampleColor(page, '.site-nav__item.is-current > .site-nav__link', 'border'),
      3,
      `${theme} current nav indicator`,
    );
  }

  test('light theme computed colours meet 4.5:1 text and 3:1 non-text', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await navigationContrast(page, 'light');
    await settingsSurfaceContrast(page, 'light');
  });

  test('dark theme computed colours meet the same minimums', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/settings/');
    const dark = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      root: getComputedStyle(document.documentElement).colorScheme,
    }));
    expect(dark.body, 'dark theme is actually applied').toBe('rgb(21, 21, 23)');
    expect(dark.root).toBe('light dark');

    await navigationContrast(page, 'dark');
    await settingsSurfaceContrast(page, 'dark');
  });

  test('forced colors keeps current, focus and boundaries distinguishable', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light', forcedColors: 'active' });
    await openSettings(page);
    await openDrawer(page);
    const forcedActive = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
    expect(forcedActive, 'forced colours emulation is active').toBe(true);

    const settingsFacts = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        return {
          color: style.color,
          background: style.backgroundColor,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineColor: style.outlineColor,
          borderColor: style.borderInlineStartColor,
          forcedColorAdjust: style.getPropertyValue('forced-color-adjust'),
        };
      };
      return {
        settingsCurrent: read('.site-nav__settings[aria-current="page"]'),
        topBarBorder: (() => {
          const topBar = document.querySelector<HTMLElement>('.top-bar');
          if (!topBar) return null;
          const style = getComputedStyle(topBar);
          return { width: style.borderBlockEndWidth, color: style.borderBlockEndColor };
        })(),
        drawerBorder: (() => {
          const drawer = document.querySelector<HTMLElement>('.site-drawer');
          if (!drawer) return null;
          const style = getComputedStyle(drawer);
          return { width: style.borderInlineEndWidth, color: style.borderInlineEndColor };
        })(),
        checkedOption: read('.settings__option:has(input:checked)'),
        radioAppearance: (() => {
          const radio = document.querySelector<HTMLInputElement>('input[data-preference]');
          return radio ? getComputedStyle(radio).appearance : '';
        })(),
      };
    });
    console.log(`FORCED settings ${JSON.stringify(settingsFacts)}`);

    expect(settingsFacts.settingsCurrent?.outlineStyle, 'forced-colors Settings current outline').toBe('solid');
    expect(
      Number.parseFloat(settingsFacts.settingsCurrent?.outlineWidth ?? '0'),
      'forced-colors Settings current outline width',
    ).toBeGreaterThanOrEqual(3);
    expect(settingsFacts.topBarBorder?.width, 'top-bar boundary exists in forced colors').toBe('1px');
    expect(settingsFacts.topBarBorder?.color, 'top-bar boundary uses a system colour').not.toBe('rgba(0, 0, 0, 0)');
    expect(settingsFacts.drawerBorder?.width, 'drawer boundary exists in forced colors').toBe('1px');
    expect(settingsFacts.drawerBorder?.color, 'drawer boundary uses a system colour').not.toBe('rgba(0, 0, 0, 0)');
    expect(settingsFacts.checkedOption?.outlineStyle, 'forced-colors checked row outline').toBe('solid');
    expect(settingsFacts.checkedOption?.borderColor, 'forced-colors checked row border visible').not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(settingsFacts.radioAppearance, 'native radio kept in forced colors').not.toBe('none');

    // Keyboard focus ring in forced colors.
    await page.keyboard.press('Tab');
    const resetReached = await (async () => {
      for (let index = 0; index < 120; index += 1) {
        const tag = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return { reset: active?.hasAttribute('data-settings-reset') ?? false };
        });
        if (tag.reset) return true;
        await page.keyboard.press('Tab');
      }
      return false;
    })();
    expect(resetReached, 'Reset reachable by keyboard in forced colors').toBe(true);
    const focusRing = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        background: getComputedStyle(document.body).backgroundColor,
      };
    });
    expect(focusRing?.outlineStyle, 'forced-colors focus ring style').toMatch(/^(solid|auto)$/u);
    expect(Number.parseFloat(focusRing?.outlineWidth ?? '0'), 'forced-colors focus ring width').toBeGreaterThanOrEqual(3);
    const ringColor = parseCssColor(focusRing?.outlineColor ?? '');
    const canvas = parseCssColor(focusRing?.background ?? '');
    if (ringColor && canvas) {
      const ratio = contrastRatio(ringColor, canvas);
      console.log(`FORCED focus ring contrast ${ratio.toFixed(2)}`);
      expect(ratio, 'forced-colors focus ring is visible').toBeGreaterThanOrEqual(3);
    }

    // Current navigation item: forced colors replaces the background overlay,
    // so it must add a system outline whose colour differs from the canvas.
    await page.goto('/');
    await openDrawer(page);
    const navFacts = await page.evaluate(() => {
      const current = document.querySelector<HTMLElement>(
        '.site-nav__item.is-current > .site-nav__link',
      );
      if (!current) return null;
      const style = getComputedStyle(current);
      const body = getComputedStyle(document.body);
      return {
        color: style.color,
        background: style.backgroundColor,
        bodyBackground: body.backgroundColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        borderColor: style.borderInlineStartColor,
        forcedColorAdjust: style.getPropertyValue('forced-color-adjust'),
      };
    });
    console.log(`FORCED nav current ${JSON.stringify(navFacts)}`);
    expect(navFacts, 'current nav item exists on Home in forced colors').not.toBeNull();
    if (navFacts) {
      expect(navFacts.outlineStyle, 'forced-colors current nav item has a system outline').toBe('solid');
      expect(Number.parseFloat(navFacts.outlineWidth), 'forced-colors current outline width').toBeGreaterThanOrEqual(3);
      const foreground = parseCssColor(navFacts.color);
      const background = parseCssColor(navFacts.background);
      expect(foreground).not.toBeNull();
      expect(background).not.toBeNull();
      if (foreground && background) {
        const ratio = contrastRatio(foreground, background);
        console.log(`FORCED current text contrast ${ratio.toFixed(2)}`);
        expect(ratio, 'forced-colors current text remains readable').toBeGreaterThanOrEqual(4.5);
      }
      const outline = parseCssColor(navFacts.outlineColor);
      if (outline && background) {
        const outlineRatio = contrastRatio(outline, background);
        console.log(`FORCED current outline contrast ${outlineRatio.toFixed(2)}`);
        expect(outlineRatio, 'forced-colors current outline is visible').toBeGreaterThanOrEqual(3);
      }
      expect(navFacts.forcedColorAdjust, 'no control opts out of forced colors').not.toBe('none');
    }
  });
});

test.describe('U12 independent: no unrequested features', () => {
  test('settings contains only three preferences plus Reset and the site adds no new surfaces', async ({
    page,
  }) => {
    const problems = consoleGuard(page);
    await openSettings(page);
    const inventory = await page.evaluate(() => ({
      h1: document.querySelectorAll('h1').length,
      fieldsets: document.querySelectorAll('main fieldset').length,
      radios: document.querySelectorAll('main input[type="radio"]').length,
      buttons: [...document.querySelectorAll<HTMLElement>('main button')].map((element) =>
        (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
      selects: document.querySelectorAll('select').length,
      searchInputs: document.querySelectorAll(
        'input[type="search"], [role="search"], input[name="q"], input[name="query"]',
      ).length,
      iframes: document.querySelectorAll('iframe').length,
      canvases: document.querySelectorAll('canvas').length,
      lang: document.documentElement.lang,
      alternates: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
      suspiciousText: [...document.querySelectorAll<HTMLElement>('a, button, label, h2, h3')]
        .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((text) =>
          /search|comment|language|translate|translation|sign in|log in|login|account|analytics|statistics|newsletter|notification|subscribe|rss/iu.test(
            text,
          ),
        ),
      groupTitles: [...document.querySelectorAll('main h2')].map((heading) => heading.textContent?.trim() ?? ''),
    }));
    expect(inventory.fieldsets, 'exactly the three preference groups').toBe(3);
    expect(inventory.radios, 'three options per group').toBe(9);
    expect(inventory.buttons, 'the only page action is Reset').toEqual(['Reset Settings']);
    expect(inventory.selects, 'no select control').toBe(0);
    expect(inventory.searchInputs, 'no search UI').toBe(0);
    expect(inventory.iframes).toBe(0);
    expect(inventory.canvases).toBe(0);
    expect(inventory.lang, 'document language').toBe('en');
    expect(inventory.alternates, 'no alternate-language links').toBe(0);
    expect(inventory.suspiciousText, 'no language/search/comment/account/analytics controls').toEqual([]);
    expect(inventory.groupTitles, 'three preference headings plus Reset').toEqual([
      'Theme',
      'Reduced Motion',
      'Text Size',
      'Reset',
    ]);

    const allPages = ['/', '/publications/', '/blog/', POST_2026, '/settings/'];
    const navLevelOne: string[][] = [];
    for (const path of allPages) {
      await page.goto(path);
      const scan = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        search: document.querySelectorAll(
          'input[type="search"], [role="search"], input[name="q"], input[name="query"]',
        ).length,
        selects: document.querySelectorAll('select').length,
        comments: document.querySelectorAll(
          '[class*="comment" i], [id*="comment" i], [data-testid*="comment" i]',
        ).length,
        iframes: document.querySelectorAll('iframe').length,
        canvases: document.querySelectorAll('canvas').length,
        levelOne: [...document.querySelectorAll<HTMLElement>('.site-nav__list > .site-nav__item > .site-nav__link')].map(
          (link) => (link.textContent ?? '').replace(/\s+/g, ' ').trim(),
        ),
        externalScripts: [...document.querySelectorAll<HTMLScriptElement>('script[src]')]
          .map((script) => new URL(script.src, location.href))
          .filter((url) => url.origin !== location.origin).length,
        analytics: [...document.querySelectorAll<HTMLScriptElement>('script[src]')].filter((script) =>
          /analytics|gtag|googletagmanager|plausible|matomo|segment|hotjar/iu.test(script.src),
        ).length,
        // Visible labels must be real DOM text, never only canvas/CSS content.
        emptyControls: [...document.querySelectorAll<HTMLElement>('a[href], button')]
          .filter((element) => {
            if (element.getAttribute('aria-label')) return false;
            if (element.getAttribute('aria-labelledby')) return false;
            return (element.textContent ?? '').trim() === '' && element.querySelector('svg') === null;
          })
          .map((element) => element.outerHTML.slice(0, 80)),
        svgOnlyControls: [...document.querySelectorAll<HTMLElement>('a[href], button')]
          .filter((element) => (element.textContent ?? '').trim() === '' && element.getAttribute('aria-label') === null)
          .map((element) => element.outerHTML.slice(0, 100)),
      }));
      expect(scan.lang, `${path}: lang=en`).toBe('en');
      expect(scan.search, `${path}: no search UI`).toBe(0);
      expect(scan.selects, `${path}: no select`).toBe(0);
      expect(scan.comments, `${path}: no comment UI`).toBe(0);
      expect(scan.iframes).toBe(0);
      expect(scan.canvases, `${path}: no canvas-only labels`).toBe(0);
      expect(scan.externalScripts, `${path}: no third-party scripts`).toBe(0);
      expect(scan.analytics, `${path}: no analytics scripts`).toBe(0);
      expect(scan.emptyControls, `${path}: no control without a text/aria label`).toEqual([]);
      // The only icon-only controls are the Menu button (visually hidden text)
      // and the drawer close button (which also carries a visible "Close").
      expect(scan.svgOnlyControls, `${path}: no icon-only control without a label`).toEqual([]);
      navLevelOne.push(scan.levelOne);
    }
    for (const labels of navLevelOne) {
      expect(labels, 'navigation has exactly Home/Publications/Blog').toEqual([
        'Home',
        'Publications',
        'Blog',
      ]);
    }

    for (const missing of ['/search/', '/comments/', '/account/', '/login/', '/zh/']) {
      const response = await page.request.get(missing, { failOnStatusCode: false });
      expect(response.status(), `${missing} does not exist`).toBe(404);
    }
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });
});
