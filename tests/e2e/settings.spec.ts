import { expect, test, type Page } from '@playwright/test';

/**
 * Task 08 public-site preference and accessibility suite (U01–U10, U12).
 *
 * These tests drive the real built site through the browser, so they cover the
 * parts unit tests cannot: first-paint hooking, `<meta name="color-scheme">` vs
 * computed `color-scheme`, persistence and cross-tab `storage` sync, the
 * reduced-motion/marquee behaviour, Text Size against the browser-owned root
 * font size, the Reset contract, keyboard reachability, reflow and simulated
 * translation growth.
 *
 * U11 (axe + human screen-reader checks) is covered elsewhere: axe by the
 * independent tester, the human passes by total control during acceptance.
 */

const THEME_KEY = 'selfpage:preference:theme';
const MOTION_KEY = 'selfpage:preference:motion';
const TEXT_SIZE_KEY = 'selfpage:preference:text-size';
const POST_2026 = '/blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/';

interface RootState {
  theme: string | null;
  motion: string | null;
  textSize: string | null;
  meta: string | null;
  colorScheme: string;
  checked: string[];
  bodyBackground: string;
}

interface StoredState {
  theme: string | null;
  motion: string | null;
  textSize: string | null;
}

async function readRootState(page: Page): Promise<RootState> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    return {
      theme: root.getAttribute('data-theme'),
      motion: root.getAttribute('data-motion'),
      textSize: root.getAttribute('data-text-size'),
      meta: meta?.getAttribute('content') ?? null,
      colorScheme: getComputedStyle(root).colorScheme,
      checked: [...document.querySelectorAll<HTMLInputElement>('input[data-preference]:checked')].map(
        (input) => `${input.dataset.preference ?? ''}=${input.value}`,
      ),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    };
  });
}

async function readStored(page: Page): Promise<StoredState> {
  return page.evaluate(
    ({ themeKey, motionKey, textSizeKey }) => ({
      theme: localStorage.getItem(themeKey),
      motion: localStorage.getItem(motionKey),
      textSize: localStorage.getItem(textSizeKey),
    }),
    { themeKey: THEME_KEY, motionKey: MOTION_KEY, textSizeKey: TEXT_SIZE_KEY },
  );
}

async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings/');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
}

async function choose(page: Page, name: string, value: string): Promise<void> {
  const radio = page.locator(`input[data-preference="${name}"][value="${value}"]`);
  await radio.check();
  await expect(radio).toBeChecked();
}

async function openDrawer(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
}

interface ActiveElementInfo {
  tag: string;
  className: string;
  text: string;
  testId: string;
  isSettingsLink: boolean;
  isResetButton: boolean;
}

async function activeInfo(page: Page): Promise<ActiveElementInfo> {
  return page.evaluate(() => {
    const element = document.activeElement;
    const html = element instanceof HTMLElement ? element : null;
    return {
      tag: element?.tagName ?? '',
      className: typeof html?.className === 'string' ? html.className : '',
      text: (element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      testId: html?.dataset.testid ?? '',
      isSettingsLink: html?.hasAttribute('data-settings-link') ?? false,
      isResetButton: html?.hasAttribute('data-settings-reset') ?? false,
    };
  });
}

/** Tabs from the start of the document until `match` accepts the active element. */
async function tabUntil(
  page: Page,
  match: (info: ActiveElementInfo) => boolean,
  maxTabs = 80,
): Promise<ActiveElementInfo | null> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Tab');
    const info = await activeInfo(page);
    if (match(info)) return info;
  }
  return null;
}

interface ContrastSample {
  ratio: number;
  foreground: string;
  background: string;
}

/**
 * WCAG contrast for a computed text, border or outline colour against the
 * nearest opaque ancestor background. Colours already in the accessibility
 * tokens, so this catches drift between a token and its surface.
 */
async function contrastOf(
  page: Page,
  selector: string,
  part: 'text' | 'border' | 'outline',
): Promise<ContrastSample | null> {
  return page.evaluate(
    ({ selector: targetSelector, part: targetPart }) => {
      interface Rgba {
        r: number;
        g: number;
        b: number;
        a: number;
      }
      const parse = (value: string): Rgba | null => {
        const match = /rgba?\(([^)]+)\)/u.exec(value);
        const body = match?.[1];
        if (body === undefined) return null;
        const parts = body
          .split(/[\s,/]+/u)
          .filter((token) => token !== '')
          .map(Number);
        const r = parts[0];
        const g = parts[1];
        const b = parts[2];
        const a = parts[3] ?? 1;
        if (r === undefined || g === undefined || b === undefined) return null;
        return { r, g, b, a };
      };
      const luminance = (color: { r: number; g: number; b: number }): number => {
        const channel = (value: number): number => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      };
      const element = document.querySelector<HTMLElement>(targetSelector);
      if (!element) return null;
      const style = getComputedStyle(element);
      const rawForeground = parse(
        targetPart === 'text'
          ? style.color
          : targetPart === 'border'
            ? style.borderTopColor
            : style.outlineColor,
      );
      let rawBackground: Rgba | null = null;
      let node: HTMLElement | null = element;
      while (node) {
        const candidate = parse(getComputedStyle(node).backgroundColor);
        if (candidate && candidate.a > 0) {
          rawBackground = candidate;
          break;
        }
        node = node.parentElement;
      }
      if (!rawForeground || !rawBackground) return null;
      const over = (foreground: Rgba, background: Rgba) => ({
        r: foreground.r * foreground.a + background.r * (1 - foreground.a),
        g: foreground.g * foreground.a + background.g * (1 - foreground.a),
        b: foreground.b * foreground.a + background.b * (1 - foreground.a),
        a: 1,
      });
      const solidForeground =
        rawForeground.a < 1 ? over(rawForeground, { r: 255, g: 255, b: 255, a: 1 }) : rawForeground;
      const solidBackground =
        rawBackground.a < 1 ? over(rawBackground, { r: 255, g: 255, b: 255, a: 1 }) : rawBackground;
      const lighter = Math.max(luminance(solidForeground), luminance(solidBackground));
      const darker = Math.min(luminance(solidForeground), luminance(solidBackground));
      return {
        ratio: (lighter + 0.05) / (darker + 0.05),
        foreground:
          targetPart === 'text'
            ? style.color
            : targetPart === 'border'
              ? style.borderTopColor
              : style.outlineColor,
        background: `rgb(${Math.round(solidBackground.r)}, ${Math.round(solidBackground.g)}, ${Math.round(solidBackground.b)})`,
      };
    },
    { selector, part },
  );
}

function expectContrast(sample: ContrastSample | null, minimum: number, label: string): void {
  expect(sample, `${label}: no sample`).not.toBeNull();
  if (sample === null) return;
  expect(sample.ratio, `${label} (${sample.foreground} on ${sample.background})`).toBeGreaterThanOrEqual(
    minimum,
  );
}

test.describe('U01/U03 theme', () => {
  test('System follows the OS, Light/Dark pin the scheme, refresh persists and System deletes the override', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSettings(page);

    const system = await readRootState(page);
    expect(system.theme, 'System stores no override attribute').toBeNull();
    expect(system.meta, 'System meta').toBe('light dark');
    expect(system.colorScheme, 'System computed color-scheme').toBe('light dark');
    expect(system.checked, 'default radios').toEqual([
      'theme=system',
      'motion=system',
      'textSize=default',
    ]);
    expect(await readStored(page), 'System writes no storage keys').toEqual({
      theme: null,
      motion: null,
      textSize: null,
    });
    expect(system.bodyBackground, 'System follows OS light').toBe('rgb(255, 255, 255)');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(async () => (await readRootState(page)).bodyBackground)
      .toBe('rgb(21, 21, 23)');
    expect((await readRootState(page)).meta, 'System keeps the meta on light dark').toBe(
      'light dark',
    );

    await page.emulateMedia({ colorScheme: 'light' });
    await choose(page, 'theme', 'dark');
    let dark = await readRootState(page);
    expect(dark.theme).toBe('dark');
    expect(dark.meta).toBe('dark');
    expect(dark.colorScheme).toBe('dark');
    expect((await readStored(page)).theme, 'explicit Dark is stored').toBe('dark');
    expect(dark.bodyBackground).toBe('rgb(21, 21, 23)');

    // A later OS change must not override an explicit choice.
    await page.emulateMedia({ colorScheme: 'light' });
    await expect
      .poll(async () => (await readRootState(page)).bodyBackground)
      .toBe('rgb(21, 21, 23)');
    expect((await readRootState(page)).theme).toBe('dark');

    await page.reload();
    dark = await readRootState(page);
    expect(dark.theme, 'refresh keeps the explicit theme').toBe('dark');
    expect(dark.checked, 'refresh keeps the radio').toContain('theme=dark');
    expect(dark.meta).toBe('dark');

    await choose(page, 'theme', 'light');
    const light = await readRootState(page);
    expect(light.theme).toBe('light');
    expect(light.meta).toBe('light');
    expect(light.colorScheme).toBe('light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect
      .poll(async () => (await readRootState(page)).bodyBackground)
      .toBe('rgb(255, 255, 255)');
    expect((await readRootState(page)).theme, 'explicit Light is not overridden').toBe('light');

    await choose(page, 'theme', 'system');
    const backToSystem = await readRootState(page);
    expect(backToSystem.theme, 'returning to System removes data-theme').toBeNull();
    expect(backToSystem.meta).toBe('light dark');
    expect(backToSystem.colorScheme).toBe('light dark');
    expect((await readStored(page)).theme, 'returning to System deletes the key').toBeNull();
    expect((await readRootState(page)).bodyBackground, 'System follows the current OS dark').toBe(
      'rgb(21, 21, 23)',
    );

    // The native form-control colour scheme follows the same state.
    const controlScheme = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector<HTMLInputElement>('input[data-preference]') ?? document.body)
          .colorScheme,
    );
    expect(controlScheme, 'native controls follow the theme').toBe('light dark');
  });

  test('a theme change in one tab reaches the other tab through the storage event', async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSettings(page);
    const second = await context.newPage();
    await second.emulateMedia({ colorScheme: 'light' });
    await openSettings(second);

    await choose(page, 'theme', 'dark');
    await expect
      .poll(async () => (await readRootState(second)).theme, { timeout: 5000 })
      .toBe('dark');
    const synced = await readRootState(second);
    expect(synced.meta, 'the second tab updates the meta too').toBe('dark');
    expect(synced.checked, 'the second tab updates its radios').toContain('theme=dark');

    await choose(page, 'theme', 'system');
    await expect
      .poll(async () => (await readRootState(second)).theme, { timeout: 5000 })
      .toBeNull();
    expect((await readRootState(second)).meta).toBe('light dark');
    await second.close();
  });

  test('U03: the inline head script applies the stored theme before any module bundle runs', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ themeKey, motionKey, textSizeKey }) => {
        try {
          localStorage.setItem(themeKey, 'dark');
          localStorage.setItem(motionKey, 'reduce');
          localStorage.setItem(textSizeKey, 'large');
        } catch {
          // A blocked storage is covered by the U02 test; this one needs values.
        }
      },
      { themeKey: THEME_KEY, motionKey: MOTION_KEY, textSizeKey: TEXT_SIZE_KEY },
    );
    // Prove the first paint does not depend on the bundled module scripts.
    await page.route('**/_astro/*.js', (route) => route.abort());
    await page.goto('/settings/');

    const state = await readRootState(page);
    expect(state.theme).toBe('dark');
    expect(state.motion).toBe('reduce');
    expect(state.textSize).toBe('large');
    expect(state.meta, 'meta matches the stored theme').toBe('dark');
    expect(state.colorScheme).toBe('dark');
    expect(state.bodyBackground, 'the dark canvas is already painted').toBe('rgb(21, 21, 23)');
    // Review P2-5: the radios are synced by an end-of-body inline script, so
    // the first frame shows the stored choice even with every module aborted.
    expect(state.checked, 'the first-frame radios match storage').toEqual([
      'theme=dark',
      'motion=reduce',
      'textSize=large',
    ]);

    const headOrder = await page.evaluate(() => {
      const nodes = [
        ...document.head.querySelectorAll('script, link[rel="stylesheet"], style'),
      ];
      return {
        tags: nodes.map((node) => node.tagName),
        inlineScript: document.head.querySelector('script:not([src])')?.textContent ?? '',
      };
    });
    const scriptIndex = headOrder.tags.indexOf('SCRIPT');
    const firstStyleIndex = headOrder.tags.findIndex((tag) => tag === 'LINK' || tag === 'STYLE');
    expect(scriptIndex, 'the boot script is in the head').toBeGreaterThanOrEqual(0);
    expect(
      scriptIndex,
      `boot script precedes every stylesheet (${headOrder.tags.join(',')})`,
    ).toBeLessThan(firstStyleIndex);
    expect(headOrder.inlineScript, 'the generated script reads the shared keys').toContain(
      THEME_KEY,
    );
    await page.unroute('**/_astro/*.js');
    await page.emulateMedia({ colorScheme: 'light' });
  });
});

test.describe('U02 blocked storage', () => {
  test('the page stays usable, the current choice applies, and the UI says it cannot save', async ({
    page,
  }) => {
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

    await openSettings(page);
    const status = page.locator('[data-settings-status]');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toContainText(/can't be saved/u);

    await choose(page, 'theme', 'dark');
    await choose(page, 'textSize', 'large');
    const state = await readRootState(page);
    expect(state.theme, 'the current choice still applies').toBe('dark');
    expect(state.meta).toBe('dark');
    expect(state.textSize).toBe('large');
    expect(state.checked).toEqual(['theme=dark', 'motion=system', 'textSize=large']);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(pageErrors, 'no uncaught errors with blocked storage').toEqual([]);
  });

  test('a readable but read-only storage keeps the stored theme instead of falling back to System', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // P1-1: seed a stored theme, then make every preference write throw. The
    // runtime must still READ `dark`; a failed write probe may only disable
    // saving, not discard the stored choice.
    await page.addInitScript(({ themeKey }) => {
      localStorage.setItem(themeKey, 'dark');
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (String(key).startsWith('selfpage:preference')) {
          throw new DOMException('Quota exceeded', 'QuotaExceededError');
        }
        original.call(this, key, value);
      };
    }, { themeKey: THEME_KEY });

    await openSettings(page);
    const state = await readRootState(page);
    expect(state.theme, 'the stored theme is still read and applied').toBe('dark');
    expect(state.meta, 'the meta still matches the stored theme').toBe('dark');
    expect(state.colorScheme).toBe('dark');
    expect(state.checked, 'the radio shows the stored theme').toContain('theme=dark');
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);
    expect((await readStored(page)).theme, 'storage is not corrupted').toBe('dark');
    expect(
      await page.evaluate(() => localStorage.getItem('selfpage:preference:probe')),
      'the probe key is cleaned up',
    ).toBeNull();

    // A new choice applies for this page even though it cannot be saved.
    await choose(page, 'theme', 'light');
    expect((await readRootState(page)).theme).toBe('light');
    expect((await readRootState(page)).meta).toBe('light');
    expect((await readStored(page)).theme, 'the failed write leaves the stored value alone').toBe(
      'dark',
    );
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);
    expect(pageErrors, 'no uncaught errors with read-only storage').toEqual([]);
  });

  test('a successful removal is not reported as saved while writes still fail', async ({ page }) => {
    // Supplementary review (U02): write fails, then selecting a default value
    // removes a key successfully. That removal must not flip the status back to
    // "saved" for a theme that never reached storage.
    await page.addInitScript(
      ({ motionKey }) => {
        localStorage.setItem(motionKey, 'reduce');
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (String(key).startsWith('selfpage:preference')) {
            throw new DOMException('Quota exceeded', 'QuotaExceededError');
          }
          original.call(this, key, value);
        };
      },
      { motionKey: MOTION_KEY },
    );

    await openSettings(page);
    const status = page.locator('[data-settings-status]');
    await expect(status).toContainText(/can't be saved/u);
    expect((await readRootState(page)).checked).toContain('motion=reduce');

    // 1. Theme=Light: setItem throws.
    await choose(page, 'theme', 'light');
    await expect(status).toContainText(/can't be saved/u);
    expect((await readRootState(page)).theme, 'the current choice still applies').toBe('light');
    expect((await readStored(page)).theme, 'nothing reached storage').toBeNull();

    // 2. Motion=System: removeItem succeeds for an existing key.
    await choose(page, 'motion', 'system');
    expect((await readRootState(page)).motion, 'the removal applied').toBeNull();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), MOTION_KEY),
      'the key really was removed',
    ).toBeNull();

    // The UI must still say it cannot save; the theme never reached storage.
    await expect(status).toContainText(/can't be saved/u);
    await expect(status).not.toContainText(/Your settings are saved/u);
    expect((await readStored(page)).theme, 'the theme is still unsaved').toBeNull();
  });

  test('a cross-tab write cannot reset in-memory choices when this page cannot read storage', async ({
    page,
    context,
  }) => {
    // Supplementary review (risk 3): this page cannot read localStorage at all;
    // another tab writing must not make it adopt defaults over the user's
    // current in-memory choice.
    await page.addInitScript(() => {
      const scope = window as unknown as { __storageEvents?: number };
      scope.__storageEvents = 0;
      window.addEventListener('storage', () => {
        scope.__storageEvents = (scope.__storageEvents ?? 0) + 1;
      });
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError');
        },
      });
    });

    await openSettings(page);
    await choose(page, 'theme', 'dark');
    expect((await readRootState(page)).theme, 'the in-memory choice applies').toBe('dark');
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);

    const second = await context.newPage();
    await openSettings(second);
    await choose(second, 'theme', 'light');
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as unknown as { __storageEvents?: number }).__storageEvents ?? 0,
          ),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);

    // The storage event reached this page, but its state must be unchanged.
    const after = await readRootState(page);
    expect(after.theme, 'the cross-tab write did not reset the in-memory choice').toBe('dark');
    expect(after.meta).toBe('dark');
    expect(after.checked).toContain('theme=dark');
    await expect(page.locator('[data-settings-status]')).toContainText(/can't be saved/u);
    await second.close();
  });
});

test.describe('U04 Reduced Motion', () => {
  test('Reduce removes spatial motion and keeps every final state; Full restores it even under OS reduce', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
    await openSettings(page);
    await choose(page, 'motion', 'reduce');

    const reduced = await page.evaluate(() => {
      const drawer = document.getElementById('site-drawer');
      return {
        motion: document.documentElement.getAttribute('data-motion'),
        drawerDuration: drawer ? getComputedStyle(drawer).transitionDuration : '',
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        stored: localStorage.getItem('selfpage:preference:motion'),
      };
    });
    expect(reduced.motion).toBe('reduce');
    expect(reduced.drawerDuration, 'Reduce zeroes the drawer transition').toBe('0s, 0s');
    expect(reduced.scrollBehavior, 'Reduce disables smooth scrolling').toBe('auto');
    expect(reduced.stored).toBe('reduce');

    // Functional final states with no animation: open/close, year expansion and
    // a fragment scroll all complete without waiting for an animation event.
    await page.goto('/blog/');
    await openDrawer(page);
    const opened = await page.evaluate(() => {
      const drawer = document.getElementById('site-drawer');
      return {
        visibility: drawer ? getComputedStyle(drawer).visibility : '',
        transform: drawer ? getComputedStyle(drawer).transform : '',
      };
    });
    expect(opened.visibility).toBe('visible');
    expect(opened.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');

    const year = page.locator('[data-year-toggle][data-year="2025"]');
    await year.click();
    await expect(page.locator('#nav-year-2025-posts')).not.toHaveAttribute('hidden', '');
    expect(await page.evaluate(() => location.hash), 'year activation still navigates the archive').toBe(
      '#year-2025',
    );
    // The archive is short enough that the fragment clamps at the page bottom;
    // what matters is that the fragment scroll happened and the target is in
    // view, with no animation needed to get there.
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const fragmentState = await page.evaluate(() => {
      const target = document.getElementById('year-2025');
      return {
        top: target ? target.getBoundingClientRect().top : -1,
        scrollY: window.scrollY,
        viewport: window.innerHeight,
      };
    });
    expect(fragmentState.scrollY, 'the fragment scroll moved the page').toBeGreaterThan(0);
    expect(fragmentState.top, 'the target is not above the viewport').toBeGreaterThanOrEqual(-1);
    expect(fragmentState.top, 'the target is inside the viewport').toBeLessThan(fragmentState.viewport);

    // Long-title marquee is a time-driven spatial animation: no transform under
    // Reduce. On a Blog article the current year's list is already expanded.
    await page.goto(POST_2026);
    await openDrawer(page);
    const post = page.locator('.site-nav__post-link:visible').first();
    await expect(post).toHaveAttribute('data-overflow', 'true');
    await post.hover();
    const reducedMarquee = await post.evaluate((element) => {
      const text = element.querySelector<HTMLElement>('.site-nav__post-text');
      return {
        transform: text ? getComputedStyle(text).transform : '',
        transition: text ? getComputedStyle(text).transitionDuration : '',
      };
    });
    expect(reducedMarquee.transform, 'Reduce has no marquee transform').toBe('none');
    expect(reducedMarquee.transition, 'Reduce has no marquee transition').toBe('0s');

    // Full is an explicit choice: it restores motion even when the OS asks for
    // reduced motion, but never flashing/uncontrolled movement.
    await page.goto('/settings/');
    await choose(page, 'motion', 'full');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const full = await page.evaluate(() => {
      const drawer = document.getElementById('site-drawer');
      return {
        motion: document.documentElement.getAttribute('data-motion'),
        drawerDuration: drawer ? getComputedStyle(drawer).transitionDuration : '',
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      };
    });
    expect(full.motion).toBe('full');
    expect(full.drawerDuration, 'Full restores the token duration').toContain('0.2s');
    expect(full.scrollBehavior, 'Full restores smooth scrolling').toBe('smooth');

    await page.goto(POST_2026);
    await openDrawer(page);
    const fullPost = page.locator('.site-nav__post-link:visible').first();
    await expect(fullPost).toHaveAttribute('data-overflow', 'true');
    await fullPost.hover();
    const fullMarquee = await fullPost.evaluate((element) => {
      const text = element.querySelector<HTMLElement>('.site-nav__post-text');
      return {
        transform: text ? getComputedStyle(text).transform : '',
        transition: text ? getComputedStyle(text).transitionDuration : '',
      };
    });
    expect(fullMarquee.transition, 'Full restores the marquee transition').not.toBe('0s');
    expect(fullMarquee.transform, 'Full starts the marquee transform').not.toBe('none');
  });

  test('System with an OS reduce setting follows the system without storing an override', async ({
    page,
  }) => {
    // Review P2-3: the missing combination was "user System + OS reduce", where
    // no data-motion attribute may exist and the media query must still win.
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await openSettings(page);
    const state = await readRootState(page);
    expect(state.motion, 'System stores no motion attribute').toBeNull();
    expect(state.checked, 'the motion radio is System').toContain('motion=system');
    expect((await readStored(page)).motion, 'System writes no motion key').toBeNull();

    const systemReduced = await page.evaluate(() => {
      const drawer = document.getElementById('site-drawer');
      return {
        mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        drawerDuration: drawer ? getComputedStyle(drawer).transitionDuration : '',
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
      };
    });
    expect(systemReduced.mediaMatches).toBe(true);
    expect(
      systemReduced.drawerDuration
        .split(',')
        .map((value) => value.trim())
        .every((value) => value === '0s'),
      `the media query still zeroes the transition (${systemReduced.drawerDuration})`,
    ).toBe(true);
    expect(systemReduced.scrollBehavior, 'the media query keeps instant scrolling').toBe('auto');

    await page.goto(POST_2026);
    await openDrawer(page);
    const post = page.locator('.site-nav__post-link:visible').first();
    await expect(post).toHaveAttribute('data-overflow', 'true');
    await post.hover();
    const marquee = await post.evaluate((element) => {
      const text = element.querySelector<HTMLElement>('.site-nav__post-text');
      return {
        transform: text ? getComputedStyle(text).transform : '',
        transition: text ? getComputedStyle(text).transitionDuration : '',
      };
    });
    expect(marquee.transform, 'the OS reduce setting still stops the marquee').toBe('none');
    expect(marquee.transition).toBe('0s');
  });
});

test.describe('U05 Text Size', () => {
  test('three sizes change component typography only and never the browser-owned root size', async ({
    page,
  }) => {
    await openSettings(page);
    const readSizes = () =>
      page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).fontSize,
        body: getComputedStyle(document.body).fontSize,
        intro: getComputedStyle(document.querySelector('.settings__intro') ?? document.body).fontSize,
        heading: getComputedStyle(document.querySelector('h1') ?? document.body).fontSize,
      }));

    const initial = await readSizes();
    expect(initial, 'Default keeps the 16px root and body').toEqual({
      html: '16px',
      body: '16px',
      intro: '16px',
      heading: '36px',
    });

    await choose(page, 'textSize', 'small');
    const small = await readSizes();
    expect(small.html, 'Small must not change the root font size').toBe('16px');
    expect(small.body).toBe('14px');
    expect(small.intro).toBe('14px');
    expect((await readStored(page)).textSize).toBe('small');

    await choose(page, 'textSize', 'large');
    const large = await readSizes();
    expect(large.html, 'Large must not change the root font size').toBe('16px');
    expect(large.body).toBe('18px');
    expect(large.intro).toBe('18px');
    expect(large.heading).toBe('40.5px');

    // 200% browser text scale multiplies the root once; Large applies on top of
    // it proportionally instead of being pinned to a px value.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    const scaled = await readSizes();
    expect(scaled.html).toBe('32px');
    expect(scaled.body, 'Large at 200% is 18px x 2').toBe('36px');
    expect(scaled.intro).toBe('36px');
    await page.setViewportSize({ width: 320, height: 568 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'no page-level 2D scrolling at 320px/200%/Large').toBeLessThanOrEqual(1);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});

test.describe('U06 Reset Settings', () => {
  test('Reset restores System / System / Default in the UI and deletes every stored override', async ({
    page,
  }) => {
    await openSettings(page);
    await choose(page, 'theme', 'dark');
    await choose(page, 'motion', 'reduce');
    await choose(page, 'textSize', 'large');
    expect(await readStored(page)).toEqual({ theme: 'dark', motion: 'reduce', textSize: 'large' });

    await page.getByRole('button', { name: 'Reset Settings' }).click();
    const reset = await readRootState(page);
    expect(reset.theme).toBeNull();
    expect(reset.motion).toBeNull();
    expect(reset.textSize).toBeNull();
    expect(reset.meta).toBe('light dark');
    expect(reset.colorScheme).toBe('light dark');
    expect(reset.checked, 'the UI shows the defaults').toEqual([
      'theme=system',
      'motion=system',
      'textSize=default',
    ]);
    expect(await readStored(page), 'storage matches the UI').toEqual({
      theme: null,
      motion: null,
      textSize: null,
    });
    await expect(page.locator('[data-settings-status]')).toContainText(/reset/u);

    await page.reload();
    expect(await readStored(page), 'defaults survive a refresh').toEqual({
      theme: null,
      motion: null,
      textSize: null,
    });
    expect((await readRootState(page)).checked).toContain('theme=system');
  });

  test('the New! link carries exactly the current non-sensitive preference fragment', async ({
    page,
  }) => {
    // Review P2-3: the emission side of R08-4 had no public-site test.
    await openSettings(page);
    await choose(page, 'theme', 'dark');
    await choose(page, 'motion', 'reduce');
    await choose(page, 'textSize', 'large');
    await page.goto('/blog/');
    const newLink = page.locator('a[data-new-href]');
    await expect(newLink).toHaveCount(1);
    const href = (await newLink.getAttribute('href')) ?? '';
    const url = new URL(href);
    expect(url.pathname, 'the author route is untouched').toBe('/new/');
    expect(url.search, 'no query is used').toBe('');
    expect(url.hash, 'the fragment holds exactly the three preferences').toBe(
      '#theme=dark&motion=reduce&size=large',
    );
    expect(href, 'no session/token material ever enters the URL').not.toMatch(
      /session|token|csrf|state=|code=|verifier/iu,
    );

    // Returning every preference to its default still emits the explicit
    // defaults, so the author origin can delete its own overrides.
    await page.goto('/settings/');
    await page.getByRole('button', { name: 'Reset Settings' }).click();
    await page.goto('/blog/');
    const resetHref = (await page.locator('a[data-new-href]').getAttribute('href')) ?? '';
    expect(new URL(resetHref).hash).toBe('#theme=system&motion=system&size=default');
  });
});

test.describe('U07 contrast and forced colors', () => {
  test('text, control borders and focus rings meet the contrast minimums in light and dark', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSettings(page);

    expectContrast(await contrastOf(page, '.settings__intro', 'text'), 4.5, 'light intro text');
    expectContrast(await contrastOf(page, '.settings__option-detail', 'text'), 4.5, 'light option hint');
    // Review P2-1: the first option is checked, so its border switches to the
    // text token; sampling it measured text contrast and could never fail on a
    // weak control boundary. Sample an unchecked row instead and prove it is
    // really unchecked, so this assertion can fail if --color-control-border
    // drops below 3:1 against the page surface.
    const controlOption = '.settings__group:first-of-type .settings__option:nth-of-type(2)';
    expect(
      await page.locator(controlOption).locator('input').isChecked(),
      'the sampled row is not the checked one',
    ).toBe(false);
    expectContrast(await contrastOf(page, controlOption, 'border'), 3, 'light option border');
    expectContrast(await contrastOf(page, '.skip-link', 'text'), 4.5, 'light skip link text');

    const resetReached = await tabUntil(page, (info) => info.isResetButton);
    expect(resetReached, 'Reset is keyboard reachable').not.toBeNull();
    expectContrast(await contrastOf(page, '[data-settings-reset]', 'outline'), 3, 'light focus ring');

    await page.emulateMedia({ colorScheme: 'dark' });
    expectContrast(await contrastOf(page, '.settings__intro', 'text'), 4.5, 'dark intro text');
    expectContrast(await contrastOf(page, '.settings__option-detail', 'text'), 4.5, 'dark option hint');
    expectContrast(await contrastOf(page, controlOption, 'border'), 3, 'dark option border');
    expectContrast(await contrastOf(page, '.skip-link', 'text'), 4.5, 'dark skip link text');
  });

  test('forced colors keeps the current item, the focus ring and boundaries visible', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light', forcedColors: 'active' });
    await openSettings(page);
    await openDrawer(page);

    const forced = await page.evaluate(() => {
      const settingsLink = document.querySelector<HTMLElement>('.site-nav__settings');
      const topBar = document.querySelector<HTMLElement>('.top-bar');
      const drawer = document.getElementById('site-drawer');
      const option = document.querySelector<HTMLElement>('.settings__option');
      const checkedOption = document.querySelector<HTMLElement>('.settings__option:has(input:checked)');
      const styleOf = (element: HTMLElement | null) => (element ? getComputedStyle(element) : null);
      const settingsStyle = styleOf(settingsLink);
      const optionStyle = styleOf(checkedOption ?? option);
      return {
        currentOutline: settingsStyle
          ? `${settingsStyle.outlineStyle} ${settingsStyle.outlineWidth}`
          : '',
        currentColor: settingsStyle?.outlineColor ?? '',
        topBarBorder: topBar
          ? `${getComputedStyle(topBar).borderBlockEndWidth} ${getComputedStyle(topBar).borderBlockEndColor}`
          : '',
        drawerBorder: drawer
          ? `${getComputedStyle(drawer).borderInlineEndWidth} ${getComputedStyle(drawer).borderInlineEndColor}`
          : '',
        optionOutline: optionStyle ? `${optionStyle.outlineStyle} ${optionStyle.outlineWidth}` : '',
        optionBorder: optionStyle?.borderTopColor ?? '',
        radioAppearance: (() => {
          const radio = document.querySelector<HTMLInputElement>('input[data-preference]');
          return radio ? getComputedStyle(radio).appearance : '';
        })(),
      };
    });

    expect(forced.currentOutline, 'current Settings row has a forced outline').toMatch(/^solid 3px$/u);
    expect(forced.currentColor, 'the outline uses a system colour').not.toBe('rgba(0, 0, 0, 0)');
    expect(forced.topBarBorder, 'top-bar band has a visible boundary').toMatch(/^1px /u);
    expect(forced.drawerBorder, 'drawer has a visible boundary').toMatch(/^1px /u);
    expect(forced.optionOutline, 'the selected option has a forced outline').toMatch(/^solid 3px$/u);
    expect(forced.optionBorder, 'the option boundary is visible').not.toBe('rgba(0, 0, 0, 0)');
    expect(forced.radioAppearance, 'the native radio is kept').not.toBe('none');

    // Close the drawer with the keyboard, then reach Reset by keyboard only so
    // the focus ring appears (programmatic focus does not match :focus-visible).
    await page.keyboard.press('Tab');
    const resetReached = await tabUntil(page, (info) => info.isResetButton);
    expect(resetReached, 'Reset is reachable while forced colors is active').not.toBeNull();
    const focusRing = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return '';
      const style = getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`;
    });
    expect(focusRing, `forced-colors focus ring (${focusRing})`).toMatch(/^(solid|auto) 3px /u);
  });
});

test.describe('U08 keyboard', () => {
  test('the Settings entry is reachable and operable with the keyboard only', async ({ page }) => {
    await page.goto('/');
    // Keyboard-only: skip link, then Menu, Enter opens the drawer, then Tab
    // reaches the fixed Settings row. No pointer event is used here.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Tab');
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toHaveAttribute('aria-expanded', 'true');

    const reached = await tabUntil(page, (info) => info.isSettingsLink, 120);
    expect(reached, 'the Settings link is in the keyboard order when the drawer is open').not.toBeNull();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/$/u);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  test('radios work with arrow keys, Reset with Enter, and focus is not trapped', async ({ page }) => {
    await openSettings(page);

    // Skip link is the first stop and moves focus to main.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#content')).toBeFocused();

    // Tab reaches the native radio group; arrows change the value and persist it.
    const themeSystem = page.locator('input[data-preference="theme"][value="system"]');
    await themeSystem.focus();
    await page.keyboard.press('ArrowDown');
    await expect(themeSystem).not.toBeChecked();
    await expect(page.locator('input[data-preference="theme"][value="light"]')).toBeChecked();
    await expect
      .poll(async () => (await readStored(page)).theme)
      .toBe('light');
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('input[data-preference="theme"][value="dark"]')).toBeChecked();
    await expect
      .poll(async () => (await readRootState(page)).theme)
      .toBe('dark');
    await expect
      .poll(async () => (await readStored(page)).theme)
      .toBe('dark');

    // Tab leaves the radio group instead of being trapped in it.
    await page.keyboard.press('Tab');
    const afterGroup = await activeInfo(page);
    expect(afterGroup.className, 'focus moves on to another control').toContain('settings__radio');

    // Reset is reachable and activates with Enter.
    const resetReached = await tabUntil(page, (info) => info.isResetButton);
    expect(resetReached).not.toBeNull();
    await page.keyboard.press('Enter');
    expect((await readRootState(page)).checked).toContain('theme=system');

    const positiveTabindex = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[tabindex]')].filter(
        (element) => Number(element.getAttribute('tabindex')) > 0,
      ).length,
    );
    expect(positiveTabindex, 'no positive tabindex on the page').toBe(0);
  });
});

test.describe('U09/U10 reflow, translation and coarse targets', () => {
  test('320px at 200% text and doubled labels keep the page and controls usable', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await openSettings(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await choose(page, 'textSize', 'large');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'no page-level 2D scrolling at 320px/200%/Large').toBeLessThanOrEqual(1);

    const layout = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('.settings__option')];
      const reset = document.querySelector<HTMLElement>('[data-settings-reset]');
      const status = document.querySelector<HTMLElement>('[data-settings-status]');
      const rect = (element: HTMLElement) => element.getBoundingClientRect();
      return {
        rowsInside: rows.every((row) => {
          const box = rect(row);
          return box.left >= -0.5 && box.right <= window.innerWidth + 1;
        }),
        rowsNoClip: rows.every((row) => row.scrollWidth <= row.clientWidth + 1),
        minRowHeight: Math.min(...rows.map((row) => rect(row).height)),
        resetInside: reset ? rect(reset).right <= window.innerWidth + 1 : false,
        resetHeight: reset ? rect(reset).height : 0,
        statusBelowReset:
          reset && status ? rect(status).top >= rect(reset).bottom - 1 : false,
        radioVisible: rows.every((row) => row.querySelector('input')?.getClientRects().length === 1),
        labelsAreText: rows.every((row) => (row.textContent ?? '').trim().length > 0),
      };
    });
    expect(layout.rowsInside).toBe(true);
    expect(layout.rowsNoClip).toBe(true);
    expect(layout.minRowHeight, 'every option row is a 44px target').toBeGreaterThanOrEqual(44);
    expect(layout.resetInside).toBe(true);
    expect(layout.resetHeight).toBeGreaterThanOrEqual(44);
    expect(layout.statusBelowReset).toBe(true);
    expect(layout.radioVisible).toBe(true);
    expect(layout.labelsAreText).toBe(true);

    // Simulated browser translation: every visible settings label becomes
    // roughly twice as long. Layout must reflow instead of clipping or
    // overflowing, and the radio + reset stay usable.
    await page.evaluate(() => {
      for (const label of document.querySelectorAll<HTMLElement>('.settings__option-label')) {
        label.textContent = 'Einstellungen für Darstellung und Barrierefreiheit';
      }
      for (const hint of document.querySelectorAll<HTMLElement>('.settings__option-detail')) {
        hint.textContent =
          'Diese Option folgt der Einstellung des Geräts und überschreibt sie nicht.';
      }
      for (const heading of document.querySelectorAll<HTMLElement>('.settings__heading')) {
        heading.textContent = 'Erscheinungsbild und Bedienungshilfen';
      }
      const reset = document.querySelector<HTMLElement>('[data-settings-reset]');
      if (reset) reset.textContent = 'Alle Einstellungen auf die Standardwerte zurücksetzen';
      const settingsLabel = document.querySelector<HTMLElement>(
        '.site-nav__settings .site-nav__label',
      );
      if (settingsLabel) settingsLabel.textContent = 'Einstellungen und Barrierefreiheit';
    });
    // Condition wait instead of a fixed timeout (review P2-2): the translated
    // heading must be in the DOM, then two frames let layout/paint settle.
    await expect(page.locator('.settings__heading').first()).toHaveText(
      'Erscheinungsbild und Bedienungshilfen',
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    const translated = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('.settings__option')];
      const reset = document.querySelector<HTMLElement>('[data-settings-reset]');
      const status = document.querySelector<HTMLElement>('[data-settings-status]');
      const rect = (element: HTMLElement) => element.getBoundingClientRect();
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rowsNoClip: rows.every((row) => row.scrollWidth <= row.clientWidth + 1),
        resetInside: reset ? rect(reset).right <= window.innerWidth + 1 : false,
        statusBelowReset:
          reset && status ? rect(status).top >= rect(reset).bottom - 1 : false,
        resetHeight: reset ? rect(reset).height : 0,
      };
    });
    expect(translated.pageOverflow, 'translated labels do not widen the page').toBeLessThanOrEqual(1);
    expect(translated.rowsNoClip, 'translated labels wrap inside their row').toBe(true);
    expect(translated.resetInside).toBe(true);
    expect(translated.statusBelowReset).toBe(true);
    expect(translated.resetHeight).toBeGreaterThanOrEqual(44);

    // The long Settings label in the drawer still stays inside it.
    await openDrawer(page);
    const drawerFit = await page.evaluate(() => {
      const drawer = document.querySelector<HTMLElement>('.site-drawer');
      const link = document.querySelector<HTMLElement>('.site-nav__settings');
      if (!drawer || !link) return null;
      const drawerBox = drawer.getBoundingClientRect();
      const linkBox = link.getBoundingClientRect();
      return {
        inside: linkBox.left >= drawerBox.left - 0.5 && linkBox.right <= drawerBox.right + 0.5,
        height: linkBox.height,
      };
    });
    expect(drawerFit, 'the Settings entry exists in the drawer').not.toBeNull();
    expect(drawerFit?.inside).toBe(true);
    expect(drawerFit?.height).toBeGreaterThanOrEqual(44);
  });

  test.describe('coarse pointer', () => {
    test.use({ hasTouch: true, viewport: { width: 320, height: 568 } });

    test('coarse pointer targets are at least 44 by 44 CSS px', async ({ page }) => {
      await openSettings(page);
      await openDrawer(page);
      const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
      expect(coarse, 'the emulated context is a coarse pointer').toBe(true);

      const targets = await page.evaluate(() => {
        const selectors = [
          '.menu-trigger',
          '.site-drawer__close',
          '.site-nav__settings',
          '.site-nav__link--level-1',
          '[data-settings-reset]',
          '.settings__option',
        ];
        return selectors.map((selector) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) return { selector, width: 0, height: 0 };
          const box = element.getBoundingClientRect();
          return { selector, width: box.width, height: box.height };
        });
      });
      for (const target of targets) {
        expect(target.height, `${target.selector} height`).toBeGreaterThanOrEqual(44);
        expect(target.width, `${target.selector} width`).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

test.describe('U12 no unrequested features', () => {
  test('the settings page contains only the three preferences and Reset', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await openSettings(page);

    const inventory = await page.evaluate(() => ({
      title: document.title,
      navPage: document.documentElement.getAttribute('data-nav-page'),
      fieldsets: document.querySelectorAll('main fieldset').length,
      radios: document.querySelectorAll('main input[type="radio"]').length,
      buttons: [...document.querySelectorAll<HTMLButtonElement>('main button')].map(
        (button) => button.textContent?.trim() ?? '',
      ),
      selects: document.querySelectorAll('main select').length,
      textInputs: document.querySelectorAll('main input:not([type="radio"])').length,
      suspicious: [...document.querySelectorAll<HTMLElement>('main a, main button, main label')]
        .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((text) => /search|comment|language|translation|analytics|statistics|account|sign in|log in|notification|newsletter/iu.test(text)),
      navSettingsItems: [...document.querySelectorAll('nav[aria-label="Site"] a')].filter(
        (link) => (link.textContent ?? '').trim() === 'Settings',
      ).length,
      settingsCurrent:
        document.querySelector('.site-nav__settings')?.getAttribute('aria-current') ?? null,
      currentPages: document.querySelectorAll('.site-drawer [aria-current="page"]').length,
    }));

    expect(inventory.title).toBe("Settings | Xinyang Zeng's Homepage");
    expect(inventory.navPage).toBe('settings');
    expect(inventory.fieldsets, 'one fieldset per preference').toBe(3);
    expect(inventory.radios, 'three options per preference').toBe(9);
    expect(inventory.buttons, 'only Reset Settings as a page action').toEqual(['Reset Settings']);
    expect(inventory.selects).toBe(0);
    expect(inventory.textInputs).toBe(0);
    expect(inventory.suspicious, 'no search/comment/language/account/analytics controls').toEqual([]);
    expect(inventory.navSettingsItems, 'Settings never becomes a navigation list item').toBe(0);
    expect(inventory.settingsCurrent, 'the fixed Settings row is the current item').toBe('page');
    expect(inventory.currentPages, 'exactly one current page item in the drawer').toBe(1);
    expect(pageErrors).toEqual([]);
  });
});
