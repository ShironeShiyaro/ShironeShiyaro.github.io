import { expect, test, type Page } from '@playwright/test';

const SITE_TITLE = "Xinyang Zeng's Homepage";
const POST_2026 = '/blog/2026/Reading%20List%20for%20Spring-2026-11-20-08-40-00/';
const POST_2026_OTHER = '/blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/';

async function openDrawer(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'visible');
}

async function expectDrawerClosed(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
  const drawer = page.locator('#site-drawer');
  await expect(drawer).toHaveCSS('visibility', 'hidden');
  await expect(drawer).toHaveAttribute('inert', '');
  await expect(drawer).toHaveAttribute('aria-hidden', 'true');
  await expect(drawer).not.toHaveAttribute('role', 'dialog');
  // The whole page outside the drawer must be interactive and exposed again.
  for (const selector of ['main', '.site-brand', '.site-footer', '.skip-link']) {
    await expect(page.locator(selector), `${selector} is not inert when closed`).not.toHaveAttribute(
      'inert',
      '',
    );
    await expect(page.locator(selector), `${selector} is not aria-hidden when closed`).not.toHaveAttribute(
      'aria-hidden',
      'true',
    );
  }
}

/** Current stored drawer value for this tab (null when absent). */
async function storedDrawerValue(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try {
      return sessionStorage.getItem('selfpage:drawer-open');
    } catch {
      return null;
    }
  });
}

/**
 * Records every write to the drawer key for the current document. Installed as
 * an init script so navigation clicks can be proven not to touch storage while
 * the page reloads the hook for the next document.
 */
async function trackDrawerWrites(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    const log: string[] = [];
    Object.assign(window, { __drawerWrites: log });
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'selfpage:drawer-open') log.push(String(value));
      return original.call(this, key, value);
    };
  });
}

async function drawerWrites(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as Window & { __drawerWrites?: string[] }).__drawerWrites ?? [],
  );
}

async function currentEntries(page: Page): Promise<Array<{ text: string; value: string }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Site"] [aria-current]')].map((element) => ({
      text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      value: element.getAttribute('aria-current') ?? '',
    })),
  );
}

async function navRect(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => element.getBoundingClientRect().toJSON());
}

async function expandYear(page: Page, year: string): Promise<void> {
  const link = page.locator('.site-nav__year-toggle', { hasText: year });
  await link.click();
  await expect(link).toHaveAttribute('aria-expanded', 'true');
}

async function focusPostLinkByTab(page: Page): Promise<boolean> {
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => ({
      isPost: Boolean(document.activeElement?.classList?.contains('site-nav__post-link')),
      inDrawer: Boolean(document.activeElement?.closest('#site-drawer')),
    }));
    if (active.isPost) return true;
    if (!active.inDrawer && index > 0) return false;
  }
  return false;
}

test.describe('drawer and modal semantics', () => {
  test('narrow drawer is a named modal with a focus trap and four close paths', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/blog/');
    await openDrawer(page);

    const drawer = page.locator('#site-drawer');
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(drawer).toHaveAttribute('aria-label', 'Site menu');
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await expect(page.locator('.site-brand')).toHaveAttribute('inert', '');
    await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();

    // Tab never escapes the modal.
    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('#site-drawer')));
      expect(inside, `focus escaped after Tab ${index + 1}`).toBe(true);
    }

    // Escape returns focus to Menu and removes modality.
    await page.keyboard.press('Escape');
    await expectDrawerClosed(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();

    // Explicit Close.
    await openDrawer(page);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expectDrawerClosed(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();

    // Backdrop (the strip right of the 80% drawer).
    await openDrawer(page);
    await page.mouse.click(385, 500);
    await expectDrawerClosed(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();

    // The same Menu button toggles it closed.
    await openDrawer(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    await expectDrawerClosed(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  });

  test('320px modal keeps focus inside and Escape restores Menu', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    await openDrawer(page);
    await expect(page.locator('#site-drawer')).toHaveAttribute('role', 'dialog');
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
    for (let index = 0; index < 10; index += 1) {
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('#site-drawer'))),
        `focus escaped at 320px on Tab ${index + 1}`,
      ).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expectDrawerClosed(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  });

  test('Menu and brand keep identical coordinates and a single accessible brand', async ({ page }) => {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      const before = { menu: await navRect(page, '.menu-trigger'), brand: await navRect(page, '.site-brand') };
      await openDrawer(page);
      const after = { menu: await navRect(page, '.menu-trigger'), brand: await navRect(page, '.site-brand') };
      for (const key of ['menu', 'brand'] as const) {
        expect(Math.abs(after[key].x - before[key].x), `${width}: ${key} x`).toBeLessThanOrEqual(1);
        expect(Math.abs(after[key].y - before[key].y), `${width}: ${key} y`).toBeLessThanOrEqual(1);
        expect(Math.abs(after[key].width - before[key].width), `${width}: ${key} width`).toBeLessThanOrEqual(1);
      }
      await expect(page.locator('.site-brand')).toHaveCount(1);
      const brandOccurrences = await page.evaluate((title) => {
        const text = document.body.innerText;
        return text.split(title).length - 1;
      }, SITE_TITLE);
      expect(brandOccurrences, `${width}: visible brand text count`).toBe(1);
    }
  });
});

test.describe('persistent drawer state (user 2026-11-25 contract)', () => {
  test('1280: the open drawer survives a level-1 navigation and a closed one stays closed', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await trackDrawerWrites(page);
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menu' });
    const drawer = page.locator('#site-drawer');
    await openDrawer(page);
    expect(await drawerWrites(page), 'the explicit Menu open writes exactly "true"').toEqual(['true']);
    expect(await storedDrawerValue(page)).toBe('true');

    await page.locator('.site-nav__link--level-1', { hasText: 'Publications' }).click();
    await expect(page).toHaveURL(/\/publications\/$/);
    await expect(menu, 'drawer stays open after a level-1 navigation').toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(drawer).toHaveCSS('visibility', 'visible');
    // Neither the boot nor the controller writes the stored value on a
    // navigation click: the new document sees an untouched key.
    expect(await drawerWrites(page), 'navigation never writes storage').toEqual([]);
    expect(await storedDrawerValue(page)).toBe('true');

    // The wide drawer is the non-modal push layout: the article sits right of
    // the open drawer, stays interactive, and the page does not overflow.
    await expect(page.getByRole('heading', { level: 1, name: 'Selected Publications' })).toBeVisible();
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
    const geometry = await page.evaluate(() => {
      const mainRect = document.querySelector('main')?.getBoundingClientRect();
      const drawerRect = document.getElementById('site-drawer')?.getBoundingClientRect();
      return {
        mainStart: mainRect?.left ?? 0,
        drawerRight: drawerRect?.right ?? 0,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    expect(geometry.mainStart, 'the article is pushed right of the open drawer').toBeGreaterThanOrEqual(
      geometry.drawerRight - 1,
    );
    expect(geometry.scrollWidth, 'no page-level horizontal overflow').toBeLessThanOrEqual(
      geometry.clientWidth + 1,
    );

    await menu.click();
    await expectDrawerClosed(page);
    expect(await drawerWrites(page), 'the explicit Menu close writes exactly "false"').toEqual(['false']);
    expect(await storedDrawerValue(page)).toBe('false');

    // A closed wide drawer is inert by design, so the next route change is
    // exercised the way a bookmark/address entry would (same tab): the stored
    // closed state must still win on the new page.
    await page.goto('/blog/');
    await expectDrawerClosed(page);
    await expect(page.locator('html')).not.toHaveClass(/nav-scroll-locked/);
    expect(await drawerWrites(page), 'the new page writes nothing on boot/init').toEqual([]);
    expect(await storedDrawerValue(page)).toBe('false');
  });

  test('390/320: the modal drawer survives fragments, level-1 and article navigations', async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
      await page.goto('/');
      const menu = page.getByRole('button', { name: 'Menu' });
      const drawer = page.locator('#site-drawer');
      await openDrawer(page);

      // Same-document Home fragment.
      await page.locator('.site-nav__link--level-2', { hasText: 'About Me' }).click();
      await expect(page).toHaveURL(/#about-me$/);
      await expect(menu, `${width}: open after a Home fragment`).toHaveAttribute('aria-expanded', 'true');
      await expect(drawer).toHaveAttribute('role', 'dialog');

      // Level-1 route change to the Blog index.
      await page.locator('.site-nav__link--level-1', { hasText: 'Blog' }).click();
      await expect(page).toHaveURL(/\/blog\/$/);
      await expect(menu, `${width}: open after a level-1 navigation`).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(drawer).toHaveCSS('visibility', 'visible');
      // A restored open drawer on narrow screens must be a complete modal, not
      // a visually open but semantically closed one.
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      for (const selector of ['main', '.site-brand', '.site-footer', '.skip-link']) {
        await expect(page.locator(selector), `${width}: ${selector} is inert behind the modal`).toHaveAttribute(
          'inert',
          '',
        );
        await expect(page.locator(selector), `${width}: ${selector} is aria-hidden behind the modal`).toHaveAttribute(
          'aria-hidden',
          'true',
        );
      }
      await expect(page.locator('html')).toHaveClass(/nav-scroll-locked/);
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('#site-drawer'))),
        `${width}: restored modal owns focus`,
      ).toBe(true);

      // Article navigation.
      await expandYear(page, '2026');
      await page.locator('.site-nav__post-link:visible').first().click();
      await expect(page).toHaveURL(/\/blog\/2026\//);
      await expect(menu, `${width}: open after an article navigation`).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(drawer).toHaveAttribute('aria-modal', 'true');

      // Menu closes it; the closed state survives the next route change.
      await menu.click();
      await expectDrawerClosed(page);
      await expect(page.locator('html')).not.toHaveClass(/nav-scroll-locked/);
      await page.goto('/publications/');
      await expectDrawerClosed(page);
    }
  });

  test('reload keeps the stored state on both form factors', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menu' });
    const drawer = page.locator('#site-drawer');
    await openDrawer(page);

    await page.reload();
    await expect(menu, 'desktop: open survives reload').toHaveAttribute('aria-expanded', 'true');
    await expect(drawer).toHaveCSS('visibility', 'visible');
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');

    await menu.click();
    await expectDrawerClosed(page);
    await page.reload();
    await expectDrawerClosed(page);

    // Narrow restore must not leave a visually open but semantically closed
    // modal behind.
    await page.setViewportSize({ width: 390, height: 844 });
    await openDrawer(page);
    await page.reload();
    await expect(menu, 'narrow: open survives reload').toHaveAttribute('aria-expanded', 'true');
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await expect(page.locator('html')).toHaveClass(/nav-scroll-locked/);
    await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();

    // Narrow closed -> reload must stay closed as well (this is also the boot
    // closed branch + controller closed branch combination).
    await menu.click();
    await expectDrawerClosed(page);
    await page.reload();
    await expectDrawerClosed(page);
    expect(await storedDrawerValue(page)).toBe('false');
  });

  test('390/320: D37 year disclosure from an article keeps focus inside the modal', async ({
    page,
  }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
      await page.goto(POST_2026);
      const menu = page.getByRole('button', { name: 'Menu' });
      const drawer = page.locator('#site-drawer');
      await openDrawer(page);
      const pathBefore = new URL(page.url()).pathname;
      const year2026 = page.locator('[data-year-toggle][data-year="2026"]');
      await expect(year2026).toHaveAttribute('aria-expanded', 'true');

      // D37: on an article the year button is a pure disclosure, so the modal
      // (and the article document) stays exactly where it is while the year
      // list collapses.
      await year2026.click();
      await page.waitForTimeout(250);
      expect(new URL(page.url()).pathname, `${width}: no navigation`).toBe(pathBefore);
      expect(await page.evaluate(() => window.location.hash), `${width}: no hash`).toBe('');
      await expect(menu, `${width}: modal stays open`).toHaveAttribute('aria-expanded', 'true');
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      await expect(page.locator('html')).toHaveClass(/nav-scroll-locked/);
      await expect
        .poll(
          () => page.evaluate(() => Boolean(document.activeElement?.closest?.('#site-drawer'))),
          { message: `${width}: focus must stay inside the modal after the disclosure` },
        )
        .toBe(true);
      await expect(year2026).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toHaveCount(1);
    }
  });

  test('390: direct hash deep links with a stored open drawer keep focus in the modal', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const menu = page.getByRole('button', { name: 'Menu' });
    const drawer = page.locator('#site-drawer');
    await page.goto('/');
    await openDrawer(page);

    for (const path of ['/blog/#year-2025', '/#about-me']) {
      await page.goto(path);
      await expect(menu, `${path}: restored open`).toHaveAttribute('aria-expanded', 'true');
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      await expect
        .poll(
          () => page.evaluate(() => Boolean(document.activeElement?.closest?.('#site-drawer'))),
          { message: `${path}: focus must be inside the modal after the fragment load` },
        )
        .toBe(true);
    }
  });

  test('a module that loads after the 800ms fallback still ends in the stored closed state', async ({
    browser,
  }) => {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 568 },
      });
      const page = await context.newPage();
      // Boot's 800ms fallback opens the static navigation while the module is
      // still pending; a module that arrives later must still converge on the
      // stored state (closed here), not leave the fallback's "open" DOM behind.
      await page.route('**/_astro/SiteShell*.js', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        await route.continue();
      });
      const navigation = page.goto('/');
      // Observe the fallback state before the late module executes.
      await expect(page.locator('html'), `${width}: fallback opens while waiting`).toHaveAttribute(
        'data-drawer-open',
        'true',
        { timeout: 1600 },
      );
      await navigation;
      await expect
        .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-nav-ready')), {
          timeout: 8000,
        })
        .toBe(true);

      const menu = page.getByRole('button', { name: 'Menu' });
      const drawer = page.locator('#site-drawer');
      await expect(menu, `${width}: the late controller re-enables Menu`).toBeEnabled();
      await expect(page.locator('html'), `${width}: authoritative open flag`).toHaveAttribute(
        'data-drawer-open',
        'false',
      );
      await expect(menu, `${width}: Menu aria-expanded matches`).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect(drawer, `${width}: drawer is not visible`).toHaveCSS('visibility', 'hidden');
      await expect(drawer).toHaveAttribute('inert', '');
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator('html')).not.toHaveClass(/nav-scroll-locked/);
      if (width <= 768) {
        await expect(page.locator('[data-drawer-backdrop]')).not.toHaveCSS('visibility', 'visible');
      }

      // The late but healthy controller still works.
      await openDrawer(page);
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await expect(drawer).toHaveCSS('visibility', 'visible');
      await context.close();
    }
  });

  test('history navigation re-adopts the stored state', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menu' });
    await openDrawer(page);

    await page.goto('/publications/');
    await expect(menu, 'the open state carries into the next route').toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await menu.click();
    await expectDrawerClosed(page);

    await page.goBack();
    await expect(menu, 'back to the earlier page adopts the closed state').toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await openDrawer(page);
    await page.goForward();
    await expect(menu, 'forward adopts the stored open state').toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'visible');
  });

  test('explicit Close, Escape and backdrop close the drawer and unlock the tab', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const menu = page.getByRole('button', { name: 'Menu' });
    for (const path of ['close', 'escape', 'backdrop'] as const) {
      await page.goto('/');
      await openDrawer(page);
      await page.reload();
      await expect(menu, `${path}: reload keeps it open`).toHaveAttribute('aria-expanded', 'true');
      if (path === 'close') await page.getByRole('button', { name: 'Close' }).click();
      else if (path === 'escape') await page.keyboard.press('Escape');
      else await page.mouse.click(385, 500);
      await expectDrawerClosed(page);
      await expect(menu, `${path}: focus returns to Menu`).toBeFocused();
      await page.goto('/blog/');
      await expectDrawerClosed(page);
    }
  });

  test('a new tab does not inherit the stored state', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const first = await context.newPage();
    await first.goto('/');
    await openDrawer(first);
    await expect(first.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');

    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByRole('button', { name: 'Menu' }), 'new tab starts closed').toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(second.locator('#site-drawer')).toHaveCSS('visibility', 'hidden');
    await expect(second.locator('#site-drawer')).toHaveAttribute('inert', '');
    await second.goto('/publications/');
    await expect(second.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');

    // The first tab keeps its own state; the tabs are independent.
    await expect(first.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await context.close();
  });

  test('unavailable sessionStorage fails safe: closed, still navigable', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() {
          throw new Error('storage blocked');
        },
      });
    });
    const page = await context.newPage();
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu, 'unreadable storage defaults to closed').toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'hidden');

    await openDrawer(page);
    await page.locator('.site-nav__link--level-1', { hasText: 'Publications' }).click();
    await expect(page).toHaveURL(/\/publications\/$/);
    // The write fails too; the next page falls back to the closed default.
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('main')).not.toHaveAttribute('inert', '');
    await context.close();
  });
});

test.describe('middle navigation scroller', () => {
  test('wheel, keyboard and fixed rows work while the drawer scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto('/blog/');
    await openDrawer(page);
    await expandYear(page, '2026');

    const scroll = page.locator('[data-drawer-scroll]');
    const metrics = await scroll.evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollTop: element.scrollTop,
      tabIndex: element.tabIndex,
      role: element.getAttribute('role'),
      label: element.getAttribute('aria-label'),
    }));
    expect(metrics.scrollHeight, 'navigation must overflow so scrolling is observable').toBeGreaterThan(
      metrics.clientHeight,
    );
    expect(metrics.tabIndex, 'scrolling region is keyboard focusable').toBe(0);
    expect(metrics.role).toBe('region');
    expect(metrics.label).toBe('Site navigation');

    const menuBefore = await navRect(page, '.menu-trigger');
    const brandBefore = await navRect(page, '.site-brand');
    const settingsBefore = await navRect(page, '[data-settings-slot]');
    expect(Math.abs(settingsBefore.height - (await navRect(page, '.site-nav__link--level-1')).height)).toBeLessThanOrEqual(
      1,
    );

    const box = await scroll.boundingBox();
    if (!box) throw new Error('scroll area has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(250);
    expect(await scroll.evaluate((element) => element.scrollTop), 'wheel scrolls the middle area').toBeGreaterThan(0);

    await scroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await scroll.focus();
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(250);
    expect(await scroll.evaluate((element) => element.scrollTop), 'keyboard scrolls the middle area').toBeGreaterThan(0);

    await scroll.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await page.waitForTimeout(250);
    const after = {
      menu: await navRect(page, '.menu-trigger'),
      brand: await navRect(page, '.site-brand'),
      settings: await navRect(page, '[data-settings-slot]'),
    };
    expect(Math.abs(after.menu.y - menuBefore.y), 'Menu stays fixed').toBeLessThanOrEqual(1);
    expect(Math.abs(after.brand.y - brandBefore.y), 'brand stays fixed').toBeLessThanOrEqual(1);
    expect(Math.abs(after.settings.y - settingsBefore.y), 'Settings stays fixed').toBeLessThanOrEqual(1);
    expect(after.settings.bottom, 'Settings stays visible').toBeLessThanOrEqual(560 + 1);
  });

  test('scrollbar thumb is hidden until hover or focus but scrolling never is', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto('/blog/');
    await openDrawer(page);
    await expandYear(page, '2026');
    const scroll = page.locator('[data-drawer-scroll]');

    await page.mouse.move(1200, 300);
    await page.waitForTimeout(100);
    const idle = await scroll.evaluate((element) => getComputedStyle(element).scrollbarColor);
    expect(idle, `idle scrollbar thumb (${idle})`).toContain('rgba(0, 0, 0, 0)');

    const box = await scroll.boundingBox();
    if (!box) throw new Error('scroll area has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(100);
    const hovered = await scroll.evaluate((element) => getComputedStyle(element).scrollbarColor);
    expect(hovered, 'hover reveals a visible thumb').not.toBe(idle);

    await page.mouse.move(1200, 300);
    await scroll.focus();
    await page.waitForTimeout(100);
    const focused = await scroll.evaluate((element) => getComputedStyle(element).scrollbarColor);
    expect(focused, 'focus reveals a visible thumb').not.toBe(idle);
  });

  test('touch scrolls the middle navigation region', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 568 },
      hasTouch: true,
      isMobile: true,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    await page.goto('/blog/');
    await openDrawer(page);
    await expandYear(page, '2026');
    const scroll = page.locator('[data-drawer-scroll]');
    const box = await scroll.boundingBox();
    if (!box) throw new Error('scroll area has no box');
    const x = box.x + box.width / 2;
    const startY = box.y + box.height - 50;
    const client = await context.newCDPSession(page);
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: startY, id: 1, radiusX: 4, radiusY: 4 }],
    });
    for (let step = 1; step <= 8; step += 1) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: startY - step * 30, id: 1, radiusX: 4, radiusY: 4 }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    expect(await scroll.evaluate((element) => element.scrollTop), 'touch scrolls the middle area').toBeGreaterThan(0);
    await context.close();
  });
});

test.describe('persistent drawer scroll position (user 2026-11-25)', () => {
  const SCROLL_KEY = 'selfpage:drawer-scroll';

  function scrollArea(page: Page) {
    return page.locator('[data-drawer-scroll]');
  }

  async function drawerScroll(page: Page): Promise<{ top: number; max: number }> {
    return scrollArea(page).evaluate((element) => ({
      top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
    }));
  }

  async function storedScroll(page: Page): Promise<number | null> {
    return page.evaluate((key) => {
      try {
        const raw = sessionStorage.getItem(key);
        return raw === null ? null : Number.parseFloat(raw);
      } catch {
        return null;
      }
    }, SCROLL_KEY);
  }

  /** Real wheel input over the middle region, so the saved value is user-made. */
  async function wheelDrawer(page: Page, deltaY: number): Promise<void> {
    // Let the drawer slide finish first: a box captured mid-transition can sit
    // partly outside the viewport, so the wheel would miss the region.
    await page.waitForTimeout(300);
    const box = await scrollArea(page).boundingBox();
    if (!box) throw new Error('middle navigation region has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(200);
  }

  /** The restored offset may differ by a sub-pixel from the wheel value. */
  async function expectScrollRestored(page: Page, expected: number): Promise<void> {
    await expect
      .poll(async () => (await drawerScroll(page)).top, { timeout: 4000 })
      .toBeGreaterThanOrEqual(expected - 1);
    expect((await drawerScroll(page)).top, 'restored offset does not overshoot').toBeLessThanOrEqual(
      expected + 1,
    );
  }

  test('S1: article to article keeps the middle scroller offset', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await wheelDrawer(page, 400);

    const before = await drawerScroll(page);
    expect(before.max, 'the article sidebar overflows so an offset exists').toBeGreaterThan(0);
    expect(before.top).toBeGreaterThan(0);

    // Activating a link can scroll the region to bring the link fully into view
    // (a real user-visible move), so the value the next document must restore is
    // the one stored at navigation time, not the pre-click snapshot.
    await page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`).click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    const saved = await storedScroll(page);
    expect(saved, 'the offset did not jump to the top').toBeGreaterThan(0);
    await expectScrollRestored(page, saved as number);
  });

  test('S2: reload keeps the middle scroller offset', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await wheelDrawer(page, 400);
    const before = await drawerScroll(page);
    expect(before.top).toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await expectScrollRestored(page, before.top);
  });

  test('S3: a new tab starts at the top and does not inherit the offset', async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await wheelDrawer(page, 400);
    const before = await drawerScroll(page);
    expect(before.top).toBeGreaterThan(0);

    const second = await context.newPage();
    await second.setViewportSize({ width: 1280, height: 560 });
    await second.goto(POST_2026);
    await openDrawer(second);
    expect((await drawerScroll(second)).top, 'new tab starts at the top').toBe(0);
    expect(await storedScroll(second), 'new tab has no stored offset').toBeNull();
    await second.close();

    // The original tab still owns its own position after its own reload.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await expectScrollRestored(page, before.top);
  });

  test('S4: a shorter page clamps the restore without destroying the saved offset', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await wheelDrawer(page, 400);
    const before = await drawerScroll(page);
    expect(before.top).toBeGreaterThan(0);
    const savedBefore = await storedScroll(page);
    expect(savedBefore, 'the wheel position is stored').toBeGreaterThan(0);

    // The archive index has a shorter navigation list: the restored offset is
    // clamped and no scroll event fires, so the saved offset must survive.
    await page.locator('a[data-nav-key="blog"]').click();
    await page.waitForURL((url) => url.pathname === '/blog/');
    const onIndex = await drawerScroll(page);
    expect(onIndex.max, 'the archive index navigation is shorter than the article one').toBe(0);
    expect(onIndex.top, 'the offset is clamped on the shorter page').toBe(0);
    await page.waitForTimeout(150);
    expect(await storedScroll(page), 'a clamped restore is not written back').toBe(savedBefore);

    // Back on a long list the user's position comes back.
    await expandYear(page, '2026');
    await page.locator('.site-nav__post-link:visible').first().click();
    await page.waitForURL((url) => url.pathname.startsWith('/blog/2026/'));
    await expectScrollRestored(page, before.top);
  });

  test('S5: unreadable/unwritable storage degrades to the top without errors', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() {
          throw new Error('storage disabled');
        },
      });
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await wheelDrawer(page, 400);
    expect((await drawerScroll(page)).top, 'scrolling still works').toBeGreaterThan(0);

    await page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`).click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect((await drawerScroll(page)).top, 'without storage the tab starts at the top').toBe(0);
    expect(errors, 'storage failures never become page errors').toEqual([]);
  });

  test('S6: narrow modal restores the offset and keeps its modal semantics', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    // 200% text is the project's narrowest real combination: it is the only
    // one where the short archive overflows, so the offset is observable.
    await page.addInitScript(() => {
      const apply = () => {
        document.documentElement.style.fontSize = '200%';
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', apply, { once: true });
      } else {
        apply();
      }
    });
    await page.goto(POST_2026);
    await openDrawer(page);
    // Scroll to the end so the clicked post link is already fully visible: a
    // partly hidden link would legitimately scroll into view when focused.
    await wheelDrawer(page, 2000);
    const before = await drawerScroll(page);
    expect(before.max, 'the narrow article sidebar overflows at 200% text').toBeGreaterThan(0);
    expect(before.top, 'the middle region is at its end').toBe(before.max);

    await page.locator('.site-nav__post-link:visible').last().click();
    await page.waitForURL((url) => url.pathname.startsWith('/blog/2026/'));
    // Activating a link can scroll the region to bring the link fully into view
    // (a real user-visible move), so the value the new page must restore is the
    // one stored at navigation time, not the pre-click snapshot.
    const saved = await storedScroll(page);
    expect(saved, 'the offset is stored for this tab').toBeGreaterThan(0);
    const drawer = page.locator('#site-drawer');
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await expect(page.locator('html')).toHaveClass(/nav-scroll-locked/);
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('#site-drawer'))),
      'the restored modal owns focus',
    ).toBe(true);
    await expectScrollRestored(page, saved as number);
  });

  test('S9: a viewport clamp after a user scroll is not written back', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await wheelDrawer(page, 400);
    const before = await drawerScroll(page);
    expect(before.top, 'the sidebar overflows at the short viewport').toBeGreaterThan(0);
    const saved = await storedScroll(page);
    expect(saved, 'the wheel position is stored').toBeGreaterThan(0);

    // Growing the window removes part of the overflow; the browser clamps the
    // offset and fires a scroll event. That is not a user move (independent
    // review P1-1), so the stored user position must survive.
    await page.setViewportSize({ width: 1280, height: 600 });
    await expect.poll(async () => (await drawerScroll(page)).top).toBeLessThan(before.top);
    await page.waitForTimeout(450);
    expect(await storedScroll(page), 'a partial clamp is not written back').toBe(saved);

    // A taller window removes the overflow entirely; still nothing is written.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => (await drawerScroll(page)).top).toBe(0);
    await page.waitForTimeout(450);
    expect(await storedScroll(page), 'a full clamp is not written back').toBe(saved);

    // The user position is still what the next document restores.
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await expectScrollRestored(page, saved as number);
  });

  test('S10: a user scroll right after a resize is still recorded', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await wheelDrawer(page, 400);
    const before = await drawerScroll(page);
    expect(before.top, 'the sidebar overflows at the short viewport').toBeGreaterThan(0);

    // Resizing clamps the offset, and the user then scrolls back to the top
    // within the old 400ms suppression window (independent test P2-1): that
    // scroll is genuine input, so it must be recorded instead of the pre-resize
    // value.
    await page.setViewportSize({ width: 1280, height: 600 });
    await expect.poll(async () => (await drawerScroll(page)).top).toBeLessThan(before.top);
    await wheelDrawer(page, -200);
    expect((await drawerScroll(page)).top, 'the user reached the top').toBe(0);
    await expect.poll(async () => await storedScroll(page), { timeout: 4000 }).toBe(0);

    await page.setViewportSize({ width: 1280, height: 560 });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    expect((await drawerScroll(page)).top, 'the user position from after the resize is restored').toBe(0);
  });
});

test.describe('hierarchy, current state and keyboard', () => {
  test('exclusive branches keep only the current level-1 descendants', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await openDrawer(page);
    await expect(page.locator('.site-nav__sublist[role="list"][aria-label="Home sections"] .site-nav__link')).toHaveCount(4);
    await expect(page.locator('.site-nav__year-toggle')).toHaveCount(0);
    await expect(page.locator('.site-nav__group[data-nav-group="publications"] .site-nav__sublist')).toHaveCount(0);

    await page.locator('.site-nav__link--level-1', { hasText: 'Publications' }).click();
    await expect(page).toHaveURL(/\/publications\/$/);
    await openDrawer(page);
    expect(await currentEntries(page)).toEqual([{ text: 'Publications', value: 'page' }]);
    await expect(page.locator('.site-nav__sublist')).toHaveCount(0);
    await expect(page.locator('.site-nav__year-toggle')).toHaveCount(0);

    await page.locator('.site-nav__link--level-1', { hasText: 'Blog' }).click();
    await expect(page).toHaveURL(/\/blog\/$/);
    await openDrawer(page);
    await expect(page.locator('.site-nav__year-toggle')).toHaveCount(2);
    await expect(page.locator('.site-nav__sublist--posts')).toHaveCount(2);
    await expect(page.locator('.site-nav__post-link:visible')).toHaveCount(0);
    await expect(page.locator('.site-nav__link', { hasText: 'New!' })).toHaveCount(1);

    await expandYear(page, '2026');
    await expect(page.locator('.site-nav__sublist--posts:not([hidden]) .site-nav__post-link')).toHaveCount(2);
    await expandYear(page, '2025');
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveCount(1);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
    await expect(page.locator('.site-nav__sublist--posts:not([hidden]) .site-nav__post-link')).toHaveCount(2);

    await page.locator('.site-nav__post-link').filter({ hasText: 'Notes on Accessible Navigation' }).click();
    await expect(page).toHaveURL(/\/blog\/2025\/Notes%20on%20Accessible%20Navigation-/);
    await openDrawer(page);
    const entries = await currentEntries(page);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toContain('Notes on Accessible Navigation-11.02 14:05');
    await expect(page.locator('.site-nav__group[data-nav-group="blog"]')).toHaveClass(/is-current-ancestor/);
    await expect(page.locator('.site-nav__item--year[data-nav-year="2025"]')).toHaveClass(/is-current-ancestor/);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');

    // Another level-1 branch drops the Blog descendants.
    await page.locator('.site-nav__link--level-1', { hasText: 'Home' }).click();
    await expect(page).toHaveURL(/\/$/);
    await openDrawer(page);
    await expect(page.locator('.site-nav__year-toggle')).toHaveCount(0);
    await expect(page.locator('.site-nav__sublist[aria-label="Home sections"]')).toHaveCount(1);
  });

  test('D36: activating the expanded year collapses it without jumping the drawer', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto('/blog/');
    await openDrawer(page);
    const y2026 = page.locator('.site-nav__year-toggle[data-year="2026"]');
    const y2025 = page.locator('.site-nav__year-toggle[data-year="2025"]');
    const list2026 = page.locator('#nav-year-2026-posts');

    await expect(list2026).toHaveAttribute('hidden', '');
    await y2026.click();
    await expect(y2026).toHaveAttribute('aria-expanded', 'true');
    await expect(list2026).not.toHaveAttribute('hidden', '');
    await expect(list2026.locator('.site-nav__post-link')).toHaveCount(2);

    // Scroll the middle navigation area first: collapsing must not force it
    // back to the top (D21 keeps its own rules; a natural clamp is allowed).
    const scrolled = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-drawer-scroll]');
      if (!scroller) return null;
      scroller.scrollTop = scroller.scrollHeight;
      return { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight };
    });
    expect(scrolled?.max ?? 0).toBeGreaterThan(0);

    await y2026.click();
    await expect(y2026).toHaveAttribute('aria-expanded', 'false');
    await expect(list2026).toHaveAttribute('hidden', '');
    await expect(list2026).not.toBeVisible();
    // The collapsed year itself stays current and the hash does not change.
    await expect(y2026).toHaveAttribute('aria-current', 'location');
    await expect(page).toHaveURL(/\/blog\/#year-2026$/);

    // Same-hash guard: no hashchange/timer may bounce the list back open.
    await page.waitForTimeout(600);
    await expect(y2026).toHaveAttribute('aria-expanded', 'false');
    await expect(list2026).toHaveAttribute('hidden', '');

    const afterCollapse = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-drawer-scroll]');
      return scroller
        ? { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight }
        : null;
    });
    expect(afterCollapse?.top ?? -1).toBe(Math.min(scrolled?.top ?? 0, afterCollapse?.max ?? 0));

    // Re-activation reopens it, and only one year may stay open.
    await y2026.click();
    await expect(y2026).toHaveAttribute('aria-expanded', 'true');
    await y2025.click();
    await expect(y2025).toHaveAttribute('aria-expanded', 'true');
    await expect(y2026).toHaveAttribute('aria-expanded', 'false');

    // Keyboard parity: Space and Enter both perform the same toggle. A fragment
    // navigation moves focus to the year section heading, so re-focus the toggle
    // (as a keyboard user would) before activating it again.
    await y2026.focus();
    await page.keyboard.press('Space');
    await expect(y2026).toHaveAttribute('aria-expanded', 'true');
    await y2026.focus();
    await page.keyboard.press('Space');
    await expect(y2026).toHaveAttribute('aria-expanded', 'false');
    await y2026.focus();
    await page.keyboard.press('Enter');
    await expect(y2026).toHaveAttribute('aria-expanded', 'true');
  });

  test('D36: a #year deep link still expands its year on load', async ({ page }) => {
    await page.goto('/blog/#year-2025');
    await openDrawer(page);
    await expect(page.locator('.site-nav__year-toggle[data-year="2025"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(page.locator('#nav-year-2025-posts')).not.toHaveAttribute('hidden', '');
    await expect(page.locator('.site-nav__year-toggle[data-year="2026"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('D37: on a Blog article the year button only toggles (no navigation, hash or scroll)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(POST_2026);
    await openDrawer(page);
    const y2026 = page.locator('[data-year-toggle][data-year="2026"]');
    const y2025 = page.locator('[data-year-toggle][data-year="2025"]');
    await expect(y2026).toHaveAttribute('aria-expanded', 'true');
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');

    // Scroll the page and push the drawer scroller to its end: a disclosure must
    // neither move the page, the URL, nor store a clamped drawer offset.
    await page.evaluate(() => window.scrollTo(0, 240));
    const before = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[data-drawer-scroll]');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return {
        path: window.location.pathname,
        hash: window.location.hash,
        scrollY: window.scrollY,
        drawerScrollTop: scroller?.scrollTop ?? 0,
        stored: sessionStorage.getItem('selfpage:drawer-scroll'),
      };
    });
    expect(before.hash, 'the article page starts without a year hash').toBe('');

    const readState = () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-drawer-scroll]');
        return {
          path: window.location.pathname,
          hash: window.location.hash,
          scrollY: window.scrollY,
          drawerScrollTop: scroller?.scrollTop ?? 0,
          stored: sessionStorage.getItem('selfpage:drawer-scroll'),
          expanded: [...document.querySelectorAll('[data-year-toggle][aria-expanded="true"]')].map(
            (element) => element.getAttribute('data-year'),
          ),
        };
      });

    // First activation collapses the current year: zero years open is allowed
    // and the article itself stays the current item.
    await y2026.click();
    await page.waitForTimeout(350);
    const collapsed = await readState();
    expect(collapsed.expanded).toEqual([]);
    expect(collapsed.path).toBe(before.path);
    expect(collapsed.hash).toBe(before.hash);
    expect(collapsed.scrollY).toBe(before.scrollY);
    expect(collapsed.stored).toBe(before.stored);
    await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toHaveCount(1);

    // Another year: only that one opens, still no navigation.
    await y2025.click();
    await page.waitForTimeout(250);
    const otherYear = await readState();
    expect(otherYear.expanded).toEqual(['2025']);
    expect(otherYear.path).toBe(before.path);
    expect(otherYear.hash).toBe(before.hash);
    expect(otherYear.scrollY).toBe(before.scrollY);

    // Second activation collapses it again.
    await y2025.click();
    await page.waitForTimeout(250);
    expect((await readState()).expanded).toEqual([]);

    // Keyboard parity: Space and Enter toggle without navigating.
    await y2025.focus();
    await page.keyboard.press('Space');
    await expect(y2025).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');
    expect((await readState()).path).toBe(before.path);
    expect((await readState()).hash).toBe('');

    // Only the level-1 Blog link returns to the archive.
    await page.locator('.site-nav__link--level-1', { hasText: 'Blog' }).click();
    await expect(page).toHaveURL(/\/blog\/$/);
    await openDrawer(page);
    await y2025.click();
    await expect(page).toHaveURL(/\/blog\/#year-2025$/);
    await expect(y2025).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => window.scrollY), 'the archive click still scrolls').toBeGreaterThan(0);
  });

  test('D36/P1-2: Space on the archive matches the mouse; a same-hash change never bounces a collapsed year', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);
    const y2025 = page.locator('[data-year-toggle][data-year="2025"]');
    const y2026 = page.locator('[data-year-toggle][data-year="2026"]');
    expect(page.url(), 'the archive starts without a year hash').not.toMatch(/#year-/);

    // Keyboard Space must produce the same URL/scroll result as a click/Enter.
    await y2025.focus();
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(/\/blog\/#year-2025$/);
    await expect(y2025).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    // A second Space collapses it and keeps the fragment in the URL. The first
    // activation navigates to the section, which moves focus there, so re-focus
    // the toggle exactly as a keyboard user would.
    await y2025.focus();
    await page.keyboard.press('Space');
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');
    await expect(page).toHaveURL(/\/blog\/#year-2025$/);

    // The browser can deliver a hashchange for the same fragment after the
    // collapse click; it must not reopen the year (D36 anti-rebound).
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await page.waitForTimeout(250);
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');

    // A genuine navigation to another year still expands it and clears the guard.
    await page.evaluate(() => {
      window.location.hash = '#year-2026';
    });
    await expect(y2026).toHaveAttribute('aria-expanded', 'true');
    await expect(y2025).toHaveAttribute('aria-expanded', 'false');
  });

  test('only one aria-current exists while scrolling and switching fragments', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto('/');
    await openDrawer(page);
    const counts = [];
    counts.push((await currentEntries(page)).length);
    await page.locator('.site-nav__link--level-2', { hasText: 'Education' }).click();
    await page.waitForTimeout(700);
    counts.push((await currentEntries(page)).length);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    counts.push((await currentEntries(page)).length);
    await page.goto('/blog/');
    await openDrawer(page);
    await expandYear(page, '2025');
    await page.waitForTimeout(500);
    counts.push((await currentEntries(page)).length);
    expect(counts).toEqual([1, 1, 1, 1]);
  });

  test('current, ancestor and hover states use the overlay and non-colour cues', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/blog/');
    await openDrawer(page);

    const blogLink = page.locator('.site-nav__link--level-1', { hasText: 'Blog' });
    await expect(blogLink).toHaveCSS('background-color', 'rgb(45, 45, 45)');
    await expect(blogLink).toHaveCSS('font-weight', '600');
    await expect(blogLink).toHaveCSS('border-inline-start-width', '3px');
    await expect(blogLink).toHaveCSS('border-inline-start-color', 'rgb(168, 184, 200)');

    const publications = page.locator('.site-nav__link--level-1', { hasText: 'Publications' });
    await publications.hover();
    await expect(publications).toHaveCSS('background-color', 'rgb(45, 45, 45)');
    expect(await currentEntries(page)).toHaveLength(1);

    await page.goto(POST_2026);
    await openDrawer(page);
    for (const selector of [
      '.site-nav__group[data-nav-group="blog"] > .site-nav__link',
      '.site-nav__item--year[data-nav-year="2026"] > .site-nav__link',
      '.site-nav__post-link[aria-current]',
    ]) {
      await expect(page.locator(selector)).toHaveCSS('background-color', 'rgb(45, 45, 45)');
    }
    expect(await currentEntries(page)).toHaveLength(1);

    await page.emulateMedia({ forcedColors: 'active' });
    const outline = await page.locator('.site-nav__post-link[aria-current]').evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style, 'forced-colors current outline style').not.toBe('none');
    expect(Number.parseFloat(outline.width)).toBeGreaterThan(0);
  });

  test('keyboard traversal uses native links, no positive tabindex and synced aria', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/blog/');
    await openDrawer(page);
    await expandYear(page, '2026');

    const semantics = await page.evaluate(() => {
      const links = [...document.querySelectorAll('nav[aria-label="Site"] a')];
      return {
        positiveTabIndex: [...document.querySelectorAll('[tabindex]')].filter(
          (element) => Number(element.getAttribute('tabindex')) > 0,
        ).length,
        treeRoles: document.querySelectorAll('[role="tree"], [role="treeitem"]').length,
        allLinksTabbable: links.every((link) => (link as HTMLElement).tabIndex === 0),
        linkCount: links.length,
      };
    });
    expect(semantics.positiveTabIndex).toBe(0);
    expect(semantics.treeRoles).toBe(0);
    expect(semantics.allLinksTabbable).toBe(true);
    expect(semantics.linkCount).toBeGreaterThan(5);

    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveCount(1);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2026');
    await expect(page.locator('.site-nav__year-toggle[data-year="2025"]')).toHaveAttribute('aria-expanded', 'false');

    const publications = page.locator('.site-nav__link--level-1', { hasText: 'Publications' });
    await publications.focus();
    // Space keeps the native anchor semantics: it does not activate the link.
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(/\/blog\//);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/publications\/$/);
  });
});

test.describe('long labels and preview cards', () => {
  test('only overflowing labels marquee, to the end, then reset', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(POST_2026);
    await openDrawer(page);

    const links = page.locator('.site-nav__post-link:visible');
    await expect(links.first()).toBeVisible();
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.site-nav__post-link')]
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => ({
          text: element.textContent,
          overflow: element.getAttribute('data-overflow'),
          px: Number(element.getAttribute('data-overflow-px') ?? '0'),
          accessibleName: element.textContent?.replace(/\s+/g, ' ').trim(),
        })),
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      if (label.overflow === 'true') expect(label.px).toBeGreaterThan(1);
    }

    const first = links.first();
    const firstData = labels[0];
    expect(firstData?.text, 'full title is in the DOM').toContain('Reading List for Spring-11.20');
    await first.hover();
    await expect
      .poll(
        async () =>
          first.evaluate((element) => {
            const text = element.querySelector('.site-nav__post-text');
            return text ? getComputedStyle(text).transform : 'none';
          }),
        { timeout: 4000 },
      )
      .not.toBe('none');
    const end = await first.evaluate((element) => {
      const text = element.querySelector('.site-nav__post-text');
      const label = element.querySelector('[data-post-label]');
      return {
        transform: text ? getComputedStyle(text).transform : 'none',
        textRight: text?.getBoundingClientRect().right,
        labelRight: label?.getBoundingClientRect().right,
      };
    });
    expect(end.transform, 'marquee is running').not.toBe('none');
    await expect
      .poll(
        async () =>
          first.evaluate((element) => {
            const text = element.querySelector('.site-nav__post-text');
            const label = element.querySelector('[data-post-label]');
            return Math.abs((text?.getBoundingClientRect().right ?? 0) - (label?.getBoundingClientRect().right ?? 0));
          }),
        { timeout: 4000 },
      )
      .toBeLessThanOrEqual(2);

    await page.mouse.move(1200, 700);
    await expect
      .poll(
        async () =>
          first.evaluate((element) => {
            const text = element.querySelector('.site-nav__post-text');
            return text ? getComputedStyle(text).transform : 'none';
          }),
      )
      .toBe('none');

    // Short labels never play.
    await page.goto('/');
    await openDrawer(page);
    const shortLink = page.locator('.site-nav__link', { hasText: 'Skills' });
    await shortLink.hover();
    const shortTransform = await shortLink.evaluate((element) => {
      const text = element.querySelector('.site-nav__label');
      return text ? getComputedStyle(text).transform : 'none';
    });
    expect(shortTransform).toBe('none');
  });

  test('preview card is fixed size, clamps to three lines and never takes focus', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(POST_2026);
    await openDrawer(page);

    await page.evaluate(() => {
      const title = document.querySelector('.nav-preview__title');
      if (title) {
        title.textContent =
          'A deliberately long article title that keeps going well past three lines so the preview card has to clamp it with an ellipsis while the full title still lives in the navigation link';
      }
    });

    // Pointer hover opens the card without moving focus.
    const first = page.locator('.site-nav__post-link:visible').first();
    await first.hover();
    await expect(page.locator('.nav-preview[data-open="true"]')).toHaveCount(1);
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest('.site-nav__post-link'))),
      'hover does not move focus',
    ).toBe(false);
    await page.mouse.move(1200, 700);
    await expect(page.locator('.nav-preview[data-open="true"]')).toHaveCount(0);

    const reached = await focusPostLinkByTab(page);
    expect(reached, 'keyboard reached a post link').toBe(true);
    const card = page.locator('.nav-preview[data-open="true"]');
    await expect(card).toHaveCount(1);
    const geometry = await card.evaluate((element) => {
      const title = element.querySelector('.nav-preview__title');
      const date = element.querySelector('.nav-preview__date');
      const rect = element.getBoundingClientRect();
      const titleStyle = title ? getComputedStyle(title) : null;
      return {
        rect: rect.toJSON(),
        inViewport:
          rect.left >= -0.5 &&
          rect.top >= -0.5 &&
          rect.right <= window.innerWidth + 0.5 &&
          rect.bottom <= window.innerHeight + 0.5,
        titleClientHeight: title?.clientHeight,
        titleScrollHeight: title?.scrollHeight,
        titleLineHeight: titleStyle ? Number.parseFloat(titleStyle.lineHeight) : 0,
        titleClamp: titleStyle?.webkitLineClamp,
        dateText: date?.textContent,
        dateFont: date ? getComputedStyle(date).fontSize : '',
        titleFont: titleStyle?.fontSize ?? '',
        activeIsLink: Boolean(document.activeElement?.closest('.site-nav__post-link')),
      };
    });
    expect(geometry.inViewport, `preview card stays in the viewport: ${JSON.stringify(geometry.rect)}`).toBe(true);
    expect(geometry.titleClamp).toBe('3');
    expect(geometry.titleClientHeight ?? 0).toBeLessThanOrEqual((geometry.titleLineHeight ?? 0) * 3 + 1);
    expect(geometry.titleScrollHeight ?? 0).toBeGreaterThan(geometry.titleClientHeight ?? 0);
    expect(geometry.dateText).toBe('2026-11-20 08:40');
    expect(Number.parseFloat(geometry.dateFont)).toBeLessThan(Number.parseFloat(geometry.titleFont));
    expect(geometry.activeIsLink, 'focus is not moved into the preview').toBe(true);

    // Clicking the link still navigates.
    const second = page.locator('.site-nav__post-link:visible').nth(1);
    await second.click();
    await expect(page).toHaveURL(/\/blog\/2026\/Why%20I%20Keep%20a%20Learning%20Log-/);
  });

  test('preview card stays inside a 320px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(POST_2026);
    await openDrawer(page);
    const reached = await focusPostLinkByTab(page);
    expect(reached).toBe(true);
    const card = page.locator('.nav-preview[data-open="true"]');
    await expect(card).toHaveCount(1);
    const geometry = await card.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        rect: rect.toJSON(),
        fits:
          rect.left >= 0 &&
          rect.top >= 0 &&
          rect.right <= window.innerWidth + 0.5 &&
          rect.bottom <= window.innerHeight + 0.5,
      };
    });
    expect(geometry.fits, JSON.stringify(geometry.rect)).toBe(true);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce', colorScheme: 'dark' });

  test('drawer, years, scrollspy and marquee reach their final state without animation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/blog/');
    await openDrawer(page);
    const drawerTransition = await page.locator('#site-drawer').evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: style.transitionDuration, transform: style.transform, visibility: style.visibility };
    });
    expect(drawerTransition.duration).toMatch(/^0s(, 0s)*$/);
    expect(drawerTransition.visibility).toBe('visible');
    await expect(page.locator('#site-drawer')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');

    const mainMargin = await page.locator('main').evaluate((element) => getComputedStyle(element).marginInlineStart);
    expect(Number.parseFloat(mainMargin)).toBeGreaterThan(300);

    await expandYear(page, '2026');
    await expect(page.locator('.site-nav__sublist--posts:not([hidden]) .site-nav__post-link')).toHaveCount(2);

    const post = page.locator('.site-nav__post-link:visible').first();
    await post.focus();
    const marquee = await post.evaluate((element) => {
      const text = element.querySelector('.site-nav__post-text');
      return {
        transform: text ? getComputedStyle(text).transform : 'none',
        transition: text ? getComputedStyle(text).transitionDuration : '',
        overflow: element.getAttribute('data-overflow'),
      };
    });
    expect(marquee.transform, 'no time-driven text playback').toBe('none');
    expect(marquee.overflow).toBe('true');

    const scrollBehavior = await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
    expect(scrollBehavior).toBe('auto');

    await page.getByRole('button', { name: 'Menu' }).click();
    await expectDrawerClosed(page);
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  });
});

test.describe('small viewports, translation and fallbacks', () => {
  test('320px with 200% text keeps targets, order and no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/blog/');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);
    await openDrawer(page);
    await expandYear(page, '2026');

    const metrics = await page.evaluate(() => {
      const rect = (element: Element) => element.getBoundingClientRect();
      const links = [...document.querySelectorAll('.site-nav__link, [data-settings-slot], [data-drawer-close]')].filter(
        (element) => element.getClientRects().length > 0,
      );
      const boxes = links.map((element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 20),
        ...rect(element).toJSON(),
      }));
      let overlap = false;
      const navItems = [...document.querySelectorAll('.site-nav__link')].filter(
        (element) => element.getClientRects().length > 0,
      );
      for (let index = 1; index < navItems.length; index += 1) {
        const previous = rect(navItems[index - 1] as Element);
        const current = rect(navItems[index] as Element);
        if (previous.bottom > current.top + 1) overlap = true;
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        minWidth: Math.min(...boxes.map((box) => box.width)),
        minHeight: Math.min(...boxes.map((box) => box.height)),
        overlap,
        settingsHeight: document.querySelector('[data-settings-slot]')?.getBoundingClientRect().height ?? 0,
        levelOneHeight: document.querySelector('.site-nav__link--level-1')?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(metrics.scrollWidth, 'no horizontal overflow at 320px/200%').toBeLessThanOrEqual(metrics.clientWidth + 1);
    expect(metrics.minHeight, 'touch target height').toBeGreaterThanOrEqual(44);
    expect(metrics.minWidth, 'touch target width').toBeGreaterThanOrEqual(44);
    expect(metrics.overlap, 'no overlapping navigation rows').toBe(false);
    expect(Math.abs(metrics.settingsHeight - metrics.levelOneHeight)).toBeLessThanOrEqual(1);

    // Modal behaviour still works after the text scale change.
    await page.keyboard.press('Escape');
    await expectDrawerClosed(page);
  });

  test('translation-like label growth is re-measured without overlap', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(POST_2026);
    await openDrawer(page);
    const before = await page.locator('.site-nav__post-link').first().evaluate((element) => ({
      overflow: element.getAttribute('data-overflow'),
      px: Number(element.getAttribute('data-overflow-px') ?? '0'),
    }));
    expect(before.overflow).toBe('true');

    await page.evaluate(() => {
      const firstPost = document.querySelector('.site-nav__post-text');
      if (firstPost) {
        firstPost.textContent =
          'Reading List for Spring, translated into a much longer label that keeps going-11.20';
      }
      for (const label of document.querySelectorAll('.site-nav__link--level-1 > .site-nav__label, .site-nav__year-toggle > .site-nav__label')) {
        if (label.textContent === 'Publications') label.textContent = 'Publications and Preprints';
        if (label.textContent === 'Blog') label.textContent = 'Writing and Notes';
      }
    });
    await page.waitForTimeout(400);

    const after = await page.locator('.site-nav__post-link').first().evaluate((element) => ({
      overflow: element.getAttribute('data-overflow'),
      px: Number(element.getAttribute('data-overflow-px') ?? '0'),
      text: element.textContent,
    }));
    expect(after.text).toContain('much longer label');
    expect(after.overflow).toBe('true');
    expect(after.px).toBeGreaterThan(before.px);

    const layout = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.site-nav__link')].filter(
        (element) => element.getClientRects().length > 0,
      );
      let overlap = false;
      for (let index = 1; index < items.length; index += 1) {
        const previous = items[index - 1]?.getBoundingClientRect();
        const current = items[index]?.getBoundingClientRect();
        if (previous && current && previous.bottom > current.top + 1) overlap = true;
      }
      return {
        overlap,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        allRealDomText: [...document.querySelectorAll('.site-nav__label')].every(
          (element) => (element.textContent ?? '').trim().length > 0,
        ),
      };
    });
    expect(layout.overlap, 'translated labels do not overlap').toBe(false);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
    expect(layout.allRealDomText, 'visible labels are real DOM text').toBe(true);
  });

  test('navigation remains reachable when JavaScript is disabled', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.site-drawer')).toHaveCSS('visibility', 'visible');
    await expect(page.locator('nav[aria-label="Site"]')).toBeVisible();

    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    await expect(page.locator('.site-drawer')).toHaveCSS('position', 'static');
    await expect(page.locator('nav[aria-label="Site"]')).toBeVisible();
    await expect(page.locator('.site-nav__link--level-1').first()).toBeVisible();
    await context.close();
  });

  test('navigation, scrollspy and preview work without scroll-target-group/interest/anchor API use', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.goto('/');
    await openDrawer(page);
    const apiUsage = await page.evaluate(() => ({
      scrollTargetGroup: CSS.supports('scroll-target-group: auto'),
      anchorPositioning: CSS.supports('anchor-name: --a'),
      interestInvokers: 'interestForElement' in HTMLAnchorElement.prototype,
      interestAttributes: document.querySelectorAll('[interestfor]').length,
      popoverAttributes: document.querySelectorAll('[popover]').length,
      anchorNames: [...document.querySelectorAll('[style]')].filter((element) =>
        (element.getAttribute('style') ?? '').includes('anchor-name'),
      ).length,
    }));
    expect(apiUsage.interestAttributes).toBe(0);
    expect(apiUsage.popoverAttributes).toBe(0);
    expect(apiUsage.anchorNames).toBe(0);

    // Fragment scrollspy works through the JS fallback path.
    await page.locator('.site-nav__link--level-2', { hasText: 'Education' }).click();
    await expect
      .poll(async () => (await currentEntries(page))[0]?.text ?? '')
      .toBe('Education');
    expect(await currentEntries(page)).toHaveLength(1);

    // Preview cards also work without Interest Invokers / Anchor Positioning.
    await page.goto(POST_2026);
    await openDrawer(page);
    // The drawer is already open after the route change (persistent state), so
    // start the keyboard walk from the shared Menu trigger like a real user.
    await page.getByRole('button', { name: 'Menu' }).focus();
    const reached = await focusPostLinkByTab(page);
    expect(reached).toBe(true);
    await expect(page.locator('.nav-preview[data-open="true"]')).toHaveCount(1);
  });
});

test.describe('fix-round regressions', () => {
  test('200% text: scrollspy current follows the clicked Home section', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);
    await openDrawer(page);
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingBlockStart),
      )
      .toBe('200px');

    for (const name of ['About Me', 'Education', 'Skills', 'Projects']) {
      const link = page.locator('.site-nav__link--level-2', { hasText: name });
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await expect.poll(async () => (await currentEntries(page))[0]?.text ?? '', { timeout: 5000 }).toBe(name);
      expect(await currentEntries(page)).toHaveLength(1);
    }
  });

  test('Blog year hash stays current at 720/800/900', async ({ page }) => {
    for (const height of [720, 800, 900]) {
      await page.setViewportSize({ width: 1280, height });
      await page.goto('/blog/');
      await openDrawer(page);
      await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
      await expect.poll(async () => (await currentEntries(page))[0]?.text ?? '').toBe('2026');
      await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2026');

      await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
      await expect.poll(async () => (await currentEntries(page))[0]?.text ?? '').toBe('2025');
      await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');

      await page.goto('/blog/#year-2026');
      await openDrawer(page);
      await expect.poll(async () => (await currentEntries(page))[0]?.text ?? '').toBe('2026');
      await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2026');
    }
  });

  test('320px + 200%: keyboard focus keeps the preview open after focus scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(POST_2026);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);
    await openDrawer(page);
    const reached = await focusPostLinkByTab(page);
    expect(reached, 'Tab reached a post link').toBe(true);
    await expect(page.locator('.nav-preview[data-open="true"]')).toHaveCount(1);
    const metrics = await page.evaluate(() => {
      const card = document.querySelector('.nav-preview[data-open="true"]');
      const rect = card?.getBoundingClientRect();
      return {
        scrollTop: document.querySelector('[data-drawer-scroll]')?.scrollTop ?? 0,
        activeIsPost: Boolean(document.activeElement?.closest('.site-nav__post-link')),
        fits: rect
          ? rect.left >= 0 &&
            rect.top >= 0 &&
            rect.right <= window.innerWidth + 0.5 &&
            rect.bottom <= window.innerHeight + 0.5
          : false,
        rect: rect?.toJSON(),
      };
    });
    expect(metrics.scrollTop, 'focus scrolled the nav').toBeGreaterThan(0);
    expect(metrics.activeIsPost, 'focus remains on the post link').toBe(true);
    expect(metrics.fits, JSON.stringify(metrics.rect)).toBe(true);
  });

  test('narrow modal locks background scrolling and restores it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(() => window.scrollTo(0, 200));
    await page.waitForTimeout(100);
    await openDrawer(page);
    await expect(page.locator('html')).toHaveClass(/nav-scroll-locked/);
    const mainWidth = await page.locator('main').evaluate((element) => element.getBoundingClientRect().width);
    expect(mainWidth, 'scroll lock does not change layout width').toBeCloseTo(390, 0);

    await page.keyboard.press('PageDown');
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.scrollY), 'PageDown does not scroll the page').toBe(200);

    await page.mouse.move(385, 500);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => window.scrollY), 'backdrop wheel does not scroll the page').toBe(200);

    await page.getByRole('button', { name: 'Close' }).click();
    await expectDrawerClosed(page);
    await expect(page.locator('html')).not.toHaveClass(/nav-scroll-locked/);
    expect(await page.evaluate(() => window.scrollY), 'scroll position is preserved after close').toBe(200);
  });

  test('module load failure falls back to the static navigation', async ({ browser }) => {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'dark' });
      const page = await context.newPage();
      await page.route('**/_astro/*.js', (route) => route.abort());
      await page.goto('/');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-nav-ready')), {
          timeout: 4000,
        })
        .toBe(false);
      const fallback = await page.evaluate(() => {
        const drawer = document.querySelector('.site-drawer');
        const menu = document.querySelector('[data-drawer-toggle]');
        return {
          open: document.documentElement.getAttribute('data-drawer-open'),
          drawerVisibility: drawer ? getComputedStyle(drawer).visibility : null,
          drawerPosition: drawer ? getComputedStyle(drawer).position : null,
          drawerInert: drawer?.hasAttribute('inert'),
          menuDisabled: (menu as HTMLButtonElement | null)?.disabled ?? false,
          visibleLinks: [...document.querySelectorAll('.site-nav__link')].filter(
            (element) => element.getClientRects().length > 0,
          ).length,
        };
      });
      expect(fallback.open, `${width}: fallback opens navigation`).toBe('true');
      expect(fallback.drawerVisibility, `${width}: drawer/nav visible`).toBe('visible');
      expect(fallback.drawerPosition, `${width}: static band on narrow, fixed sidebar on wide`).toBe(
        width > 768 ? 'fixed' : 'static',
      );
      expect(fallback.drawerInert, `${width}: drawer not inert`).toBe(false);
      expect(fallback.menuDisabled, `${width}: dead Menu is disabled`).toBe(true);
      expect(fallback.visibleLinks, `${width}: navigation links visible`).toBeGreaterThanOrEqual(7);

      await page.locator('.site-nav__link--level-1', { hasText: 'Publications' }).click();
      await expect(page).toHaveURL(/\/publications\/$/);
      await context.close();
    }
  });

  test('320px + 200% translated Settings and Close stay inside the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/blog/');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);
    await openDrawer(page);
    await page.evaluate(() => {
      const settings = document.querySelector('[data-settings-slot]');
      if (settings) settings.textContent = 'Einstellungen und Barrierefreiheit';
      const close = document.querySelector('[data-drawer-close] span');
      if (close) close.textContent = 'Menü schließen';
    });
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(() => {
      const drawer = document.querySelector('.site-drawer')?.getBoundingClientRect();
      const settings = document.querySelector('[data-settings-slot]')?.getBoundingClientRect();
      const close = document.querySelector('[data-drawer-close]')?.getBoundingClientRect();
      const footer = document.querySelector('.site-drawer__footer');
      return {
        drawer: drawer?.toJSON(),
        settings: settings?.toJSON(),
        close: close?.toJSON(),
        settingsInside: Boolean(drawer && settings && settings.left >= drawer.left && settings.right <= drawer.right + 0.5),
        closeInside: Boolean(drawer && close && close.left >= drawer.left && close.right <= drawer.right + 0.5),
        footerOverflow: footer ? footer.scrollWidth - footer.clientWidth : 0,
        pageScrollWidth: document.documentElement.scrollWidth,
        pageClientWidth: document.documentElement.clientWidth,
      };
    });
    expect(metrics.settingsInside, JSON.stringify(metrics)).toBe(true);
    expect(metrics.closeInside, JSON.stringify(metrics)).toBe(true);
    expect(metrics.footerOverflow, 'footer has no horizontal overflow').toBeLessThanOrEqual(1);
    expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageClientWidth + 1);
  });
});

interface BlogYearState {
  hash: string;
  currents: Array<{ text: string; value: string; spy: string | null }>;
  y2026: { expanded: string | null; hidden: boolean | null; visiblePosts: number };
  y2025: { expanded: string | null; hidden: boolean | null; visiblePosts: number };
}

async function blogYearState(page: Page): Promise<BlogYearState> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Site"]');
    const yearState = (year: string) => {
      const link = nav?.querySelector(`[data-year-toggle][data-year="${year}"]`);
      const list = link?.nextElementSibling;
      return {
        expanded: link?.getAttribute('aria-expanded') ?? null,
        hidden: list?.hasAttribute('hidden') ?? null,
        visiblePosts: list
          ? [...list.querySelectorAll('a')].filter(
              (item) => (item as HTMLElement).getClientRects().length > 0,
            ).length
          : 0,
      };
    };
    return {
      hash: location.hash,
      currents: nav
        ? [...nav.querySelectorAll('[aria-current]')].map((element) => ({
            text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            value: element.getAttribute('aria-current') ?? '',
            spy: element.getAttribute('data-spy-target'),
          }))
        : [],
      y2026: yearState('2026'),
      y2025: yearState('2025'),
    };
  });
}

function expectPinnedYear(state: BlogYearState, year: '2026' | '2025'): void {
  const target = year === '2026' ? state.y2026 : state.y2025;
  const other = year === '2026' ? state.y2025 : state.y2026;
  expect(state.currents, 'exactly one aria-current').toHaveLength(1);
  expect(state.currents[0]?.spy, `current is year-${year}`).toBe(`year-${year}`);
  expect(state.currents[0]?.text).toBe(year);
  expect(state.hash, `hash is #year-${year}`).toBe(`#year-${year}`);
  expect(target.expanded, `${year} is expanded`).toBe('true');
  expect(target.hidden, `${year} list is visible`).toBe(false);
  expect(target.visiblePosts, `${year} posts are visible`).toBe(2);
  expect(other.expanded, `the other year is collapsed`).toBe('false');
  expect(other.hidden, `the other year list is hidden`).toBe(true);
  expect(other.visiblePosts, `the other year has no visible posts`).toBe(0);
}

async function waitForScrollToSettle(page: Page): Promise<number> {
  let previous = Number.NaN;
  await expect
    .poll(
      async () => {
        const current = await page.evaluate(() => window.scrollY);
        const settled = Number.isFinite(previous) && Math.abs(current - previous) < 0.01;
        previous = current;
        return settled;
      },
      { timeout: 4000, intervals: [120] },
    )
    .toBe(true);
  return page.evaluate(() => window.scrollY);
}

async function scrollPageToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroller = document.querySelector('[data-drawer-scroll]') as HTMLElement | null;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2,
        ),
      { timeout: 5000 },
    )
    .toBe(true);
}

test.describe('P0-2 residual regressions', () => {
  test('clicked year stays current through PageDown and wheel at 720/800', async ({ page }) => {
    for (const height of [720, 800]) {
      await page.setViewportSize({ width: 1280, height });
      await page.goto('/blog/');
      await openDrawer(page);
      await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
      await expect
        .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
        .toBe('year-2026');
      expectPinnedYear(await blogYearState(page), '2026');

      // 04a residual: at 720/800 the page barely moves, and atBottom used to
      // make an unexpanded 2025 current. The pin must keep 2026.
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(250);
      expectPinnedYear(await blogYearState(page), '2026');

      await page.mouse.move(1000, Math.round(height * 0.6));
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(300);
      expectPinnedYear(await blogYearState(page), '2026');
    }
  });

  test('direct #year-2026 deep link stays current through scrolling', async ({ page }) => {
    for (const height of [720, 800]) {
      await page.setViewportSize({ width: 1280, height });
      await page.goto('/blog/#year-2026');
      await openDrawer(page);
      await expect
        .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
        .toBe('year-2026');
      expectPinnedYear(await blogYearState(page), '2026');

      await page.keyboard.press('PageDown');
      await page.waitForTimeout(250);
      expectPinnedYear(await blogYearState(page), '2026');

      await page.mouse.move(1000, Math.round(height * 0.6));
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(300);
      expectPinnedYear(await blogYearState(page), '2026');
    }
  });

  test('atBottom keeps the expanded year and never an unexpanded year', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);

    await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
    await expect
      .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
      .toBe('year-2025');
    await scrollPageToBottom(page);
    const bottom2025 = await blogYearState(page);
    expectPinnedYear(bottom2025, '2025');
    expect(bottom2025.currents.some((item) => item.spy === 'year-2026')).toBe(false);

    await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
    await expect
      .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
      .toBe('year-2026');
    await scrollPageToBottom(page);
    const bottom2026 = await blogYearState(page);
    expectPinnedYear(bottom2026, '2026');
    expect(bottom2026.currents.some((item) => item.spy === 'year-2025')).toBe(false);
  });

  test('pin expires after 8s and scrollspy follows the viewport without a wrong year', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);
    await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
    await expect
      .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
      .toBe('year-2026');

    // Wait past the implementation's 8s explicit-fragment pin. A pin that
    // never expires would keep 2026 current even at the top of the page.
    await page.waitForTimeout(8600);

    // Downward scrolling still resolves to the expanded year at the bottom,
    // not to an unexpanded 2025 (the 04a contradiction).
    await scrollPageToBottom(page);
    expectPinnedYear(await blogYearState(page), '2026');

    // Back at the top, the released pin must let the scrollspy report the
    // Blog route (the visible top-level section). The explicit hash and the
    // expanded 2026 remain; no unexpanded year may become current.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBe(0);
    await expect
      .poll(async () => (await blogYearState(page)).currents[0]?.text ?? '', { timeout: 5000 })
      .toBe('Blog');
    const afterExpiry = await blogYearState(page);
    expect(afterExpiry.hash).toBe('#year-2026');
    expect(afterExpiry.y2026.expanded).toBe('true');
    expect(afterExpiry.y2025.expanded).toBe('false');
    expect(afterExpiry.currents.some((item) => item.spy === 'year-2025')).toBe(false);
  });

  test('pin timer alone does not change current before any scrolling', async ({ page }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);
    await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
    await expect
      .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
      .toBe('year-2026');
    // Let the click's smooth anchor scroll finish before taking the baseline.
    const scrollBefore = await waitForScrollToSettle(page);
    const before = await blogYearState(page);

    // The 8s expiry timer must only release the pin; it must not itself move
    // current away from the explicitly selected year.
    await page.waitForTimeout(8300);
    const after = await blogYearState(page);
    expect(after.currents).toEqual(before.currents);
    expect(after.hash).toBe('#year-2026');
    expect(after.y2026.expanded).toBe('true');
    expect(after.y2025.expanded).toBe('false');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  });

  test('switching years keeps only one expanded list and syncs current/hash', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/blog/');
    await openDrawer(page);
    await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
    await expect
      .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
      .toBe('year-2025');
    expectPinnedYear(await blogYearState(page), '2025');

    await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
    await expect
      .poll(async () => (await blogYearState(page)).currents[0]?.spy ?? '')
      .toBe('year-2026');
    expectPinnedYear(await blogYearState(page), '2026');
  });
});

// ---------------------------------------------------------------------------
// Independent verification of the 2026-11-25 drawer-scroll persistence patch
// (criteria S1-S8 frozen in docs_AI/台账/03-侧栏导航与抽屉/00-总台账.md §18.2).
//
// Written by the independent test agent; it re-implements every observation
// with its own helpers instead of trusting the executor's S1-S6 block above.
// - Session keys are checked from the page's own sessionStorage (same tab).
// - "Text scale 200%" is simulated by injecting a root font-size rule into the
//   document <head> before first paint; it is a reflow simulation, not
//   browser text-only zoom.
// - Where a click can make the browser scroll the drawer to reveal the focused
//   link, the criterion is "stored value == restored value", per the task note.
// ---------------------------------------------------------------------------
test.describe('independent drawer-scroll persistence S1-S8 (2026-11-25)', () => {
  const IT_SCROLL_KEY = 'selfpage:drawer-scroll';

  function itScrollArea(page: Page) {
    return page.locator('[data-drawer-scroll]');
  }

  async function itScrollState(page: Page): Promise<{ top: number; max: number }> {
    return itScrollArea(page).evaluate((element) => ({
      top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
    }));
  }

  async function itStoredScroll(page: Page): Promise<number | null> {
    return page.evaluate((key) => {
      try {
        const raw = sessionStorage.getItem(key);
        return raw === null ? null : Number.parseFloat(raw);
      } catch {
        return null;
      }
    }, IT_SCROLL_KEY);
  }

  async function itOpen(page: Page, path: string, width = 1280, height = 560): Promise<void> {
    await page.setViewportSize({ width, height });
    await page.goto(path);
    await openDrawer(page);
    // Let an explicit Menu click finish its slide before wheel input.
    await page.waitForTimeout(300);
  }

  /** Real wheel input over the middle navigation region (a user scroll). */
  async function itWheel(page: Page, deltaY: number): Promise<void> {
    await page.waitForTimeout(200);
    const box = await itScrollArea(page).boundingBox();
    expect(box, 'middle navigation region has a box').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(250);
  }

  async function itExpectRestored(page: Page, expected: number): Promise<void> {
    await expect
      .poll(async () => (await itScrollState(page)).top, { timeout: 4000 })
      .toBeGreaterThanOrEqual(expected - 1);
    expect((await itScrollState(page)).top, 'restored offset does not overshoot').toBeLessThanOrEqual(
      expected + 1,
    );
  }

  /** Root-font-size reflow simulation injected before the first paint. */
  async function itUseTextScale(page: Page, scale: string): Promise<void> {
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({
        response,
        body: body.replace('<head>', `<head><style>html{font-size:${scale}}</style>`),
      });
    });
  }

  async function itModalSnapshot(page: Page) {
    return page.evaluate(() => {
      const drawer = document.querySelector<HTMLElement>('#site-drawer');
      const area = document.querySelector<HTMLElement>('[data-drawer-scroll]');
      if (!drawer || !area) throw new Error('drawer missing');
      const drawerStyle = getComputedStyle(drawer);
      return {
        top: area.scrollTop,
        max: area.scrollHeight - area.clientHeight,
        role: drawer.getAttribute('role'),
        ariaModal: drawer.getAttribute('aria-modal'),
        drawerVisible: drawerStyle.visibility,
        mainInert: document.querySelector('main')?.hasAttribute('inert') ?? false,
        brandInert: document.querySelector('.site-brand')?.hasAttribute('inert') ?? false,
        footerInert: document.querySelector('.site-footer')?.hasAttribute('inert') ?? false,
        skipInert: document.querySelector('.skip-link')?.hasAttribute('inert') ?? false,
        scrollLocked: document.documentElement.classList.contains('nav-scroll-locked'),
        activeInsideDrawer: Boolean(document.activeElement?.closest('#site-drawer')),
        activeText: document.activeElement?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 30) ?? '',
        open: document.documentElement.dataset.drawerOpen,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyWidth: document.body.scrollWidth,
      };
    });
  }

  async function itExpectModalSemantics(page: Page): Promise<void> {
    const modal = await itModalSnapshot(page);
    expect(modal.open, 'drawer is open').toBe('true');
    expect(modal.drawerVisible, 'drawer is visible').toBe('visible');
    expect(modal.role, 'narrow drawer is a dialog').toBe('dialog');
    expect(modal.ariaModal, 'narrow drawer is aria-modal').toBe('true');
    expect(modal.mainInert, 'main is inert behind the modal').toBe(true);
    expect(modal.brandInert, 'brand is inert behind the modal').toBe(true);
    expect(modal.footerInert, 'footer is inert behind the modal').toBe(true);
    expect(modal.skipInert, 'skip link is inert behind the modal').toBe(true);
    expect(modal.scrollLocked, 'html.nav-scroll-locked is present').toBe(true);
    expect(modal.activeInsideDrawer, 'focus starts inside the modal').toBe(true);
    expect(modal.activeText, 'the restored modal focuses its Close control').toContain('Close');
    expect(modal.documentWidth, 'no horizontal overflow').toBeLessThanOrEqual(modal.clientWidth + 1);
    expect(modal.bodyWidth, 'body has no horizontal overflow').toBeLessThanOrEqual(modal.clientWidth + 1);
  }

  test('S1: article -> article keeps the middle scroller offset (1280x560)', async ({ page }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    // The fixture's navigation list only overflows at the shorter desktop
    // height: at 1280x720 the same list has max=0, so 560 is the observable
    // desktop case (matching the reported repro scrollTop=54/max=54).
    expect(before.max, 'the article navigation overflows').toBeGreaterThan(0);
    expect(before.top, 'the wheel position is a real offset').toBeGreaterThan(0);

    const link = page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`);
    const linkBox = await link.boundingBox();
    const areaBox = await itScrollArea(page).boundingBox();
    expect(linkBox && areaBox, 'link and scroller have boxes').toBeTruthy();
    // Fully visible link: click-induced focus scrolling is a user-visible
    // movement the criterion allows, but it cannot happen here because the
    // whole link is already inside the scroller, so the exact pre-click offset
    // must survive. The partially-visible variant is covered by S1b below,
    // which compares the stored value with the restored value instead.
    expect(linkBox!.y).toBeGreaterThanOrEqual(areaBox!.y);
    expect(linkBox!.y + linkBox!.height).toBeLessThanOrEqual(areaBox!.y + areaBox!.height);

    await link.click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');

    const saved = await itStoredScroll(page);
    expect(saved, 'the offset was stored for this tab').toBeGreaterThan(0);
    expect(Math.abs((saved as number) - before.top), 'fully visible link = same offset').toBeLessThanOrEqual(1);
    await itExpectRestored(page, saved as number);
  });

  test('S1b: partially visible link keeps stored == restored (200% reflow)', async ({ page }) => {
    await itUseTextScale(page, '200%');
    await itOpen(page, POST_2026);
    await itWheel(page, 500);
    const before = await itScrollState(page);
    expect(before.max, '200% text makes the article navigation overflow').toBeGreaterThan(0);

    const link = page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`);
    const linkBox = await link.boundingBox();
    const areaBox = await itScrollArea(page).boundingBox();
    expect(linkBox && areaBox).toBeTruthy();
    // The target must be genuinely cut by the scroll viewport; click the visible
    // part with raw mouse coordinates (locator.click would scroll it into view).
    const partiallyVisible = linkBox!.y < areaBox!.y + areaBox!.height && linkBox!.y + linkBox!.height > areaBox!.y + areaBox!.height;
    expect(partiallyVisible, 'the clicked link is partially visible').toBe(true);
    const clickY = Math.min(linkBox!.y + linkBox!.height - 2, areaBox!.y + areaBox!.height - 2);
    await page.mouse.click(linkBox!.x + linkBox!.width / 2, clickY);
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);

    const saved = await itStoredScroll(page);
    expect(saved, 'the offset is stored at navigation time').toBeGreaterThan(0);
    // Focus/click may scroll a partly hidden link into view (allowed movement);
    // the frozen criterion is that the new page restores exactly what was stored.
    await itExpectRestored(page, saved as number);
    expect(
      await page.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded'),
      'drawer stays open',
    ).toBe('true');
  });

  test('S2: reload keeps the middle scroller offset and the open state', async ({ page }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.top).toBeGreaterThan(0);
    const saved = await itStoredScroll(page);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await itExpectRestored(page, saved as number);
    expect(await itStoredScroll(page), 'reload does not rewrite the offset').toBe(saved);
  });

  test('S3: new tab/new context start at the top and do not disturb the original tab', async ({
    page,
    context,
    browser,
  }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.top).toBeGreaterThan(0);
    const saved = await itStoredScroll(page);

    const second = await context.newPage();
    await second.setViewportSize({ width: 1280, height: 560 });
    await second.goto(POST_2026);
    expect(await itStoredScroll(second), 'a new tab has no stored offset').toBeNull();
    await openDrawer(second);
    expect((await itScrollState(second)).top, 'a new tab starts at the top').toBe(0);
    await second.close();

    await itExpectRestored(page, saved as number);
    expect(await page.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('true');

    const fresh = await browser.newContext();
    try {
      const freshPage = await fresh.newPage();
      await freshPage.setViewportSize({ width: 1280, height: 560 });
      await freshPage.goto(POST_2026);
      expect(await itStoredScroll(freshPage), 'a new context has no stored offset').toBeNull();
      await openDrawer(freshPage);
      expect((await itScrollState(freshPage)).top).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  test('S4a: a shorter page clamps to a NON-ZERO value without writing it back', async ({ page }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.top).toBeGreaterThan(0);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    // Programmatic same-tab navigation to the shorter Home navigation list; no
    // user scroll is involved, so the saved offset must stay untouched.
    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[data-nav-key="home"]')?.click());
    await page.waitForURL((url) => url.pathname === '/');
    await page.waitForTimeout(300);
    const home = await itScrollState(page);
    expect(home.max, 'Home navigation still has a non-zero scroll range').toBeGreaterThan(0);
    expect(home.top, 'the restored value is clamped to the shorter list').toBe(home.max);
    expect(home.top, 'the clamp is smaller than the saved long-list offset').toBeLessThan(saved as number);
    expect(await itStoredScroll(page), 'the clamped value was not written back').toBe(saved);

    await page.goto(POST_2026);
    await itExpectRestored(page, saved as number);
    expect(await itStoredScroll(page)).toBe(saved);
  });

  test('S4b: a page with max=0 clamps to 0 without destroying the saved offset', async ({ page }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.top).toBeGreaterThan(0);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[data-nav-key="blog"]')?.click());
    await page.waitForURL((url) => url.pathname === '/blog/');
    await page.waitForTimeout(300);
    const index = await itScrollState(page);
    expect(index.max, 'the archive index navigation fits in the viewport').toBe(0);
    expect(index.top).toBe(0);
    expect(await itStoredScroll(page), 'a clamped-to-zero restore is not written back').toBe(saved);

    await page.goto(POST_2026);
    await itExpectRestored(page, saved as number);
  });

  test('S5a: unreadable storage (getter throws) never errors; starts at 0', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        get() {
          throw new Error('storage disabled');
        },
      });
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await openDrawer(page);
    expect((await itScrollState(page)).top, 'the drawer starts at the top').toBe(0);
    await itWheel(page, 400);
    expect((await itScrollState(page)).top, 'wheel scrolling still works').toBeGreaterThan(0);
    expect(await itStoredScroll(page), 'nothing can be persisted').toBeNull();

    await page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`).click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The open state cannot be read either, so the next document starts closed;
    // the drawer and navigation must still be fully usable.
    await openDrawer(page);
    expect((await itScrollState(page)).top, 'the next document starts at 0').toBe(0);
    await page.locator('.site-nav__link[data-nav-key="blog"]').click();
    await page.waitForURL((url) => url.pathname === '/blog/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(errors, 'storage failures never become page errors').toEqual([]);
  });

  test('S5b: unwritable storage (setItem throws) keeps scrolling/navigation usable, position 0', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'selfpage:drawer-scroll') throw new Error('quota exceeded');
        return setItem.call(this, key, value);
      };
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    expect((await itScrollState(page)).top, 'scrolling works without persistence').toBeGreaterThan(0);
    expect(await itStoredScroll(page), 'the failed write leaves no value').toBeNull();

    await page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`).click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    expect((await itScrollState(page)).top, 'the next document starts at 0').toBe(0);
    await itWheel(page, 400);
    expect((await itScrollState(page)).top, 'scrolling still works on the next document').toBeGreaterThan(0);
    expect(errors, 'a failed write never becomes a page error').toEqual([]);
  });

  test('S6a: 320x568 restoring modal restores the offset with full modal semantics', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.max, 'the 320px article navigation overflows').toBeGreaterThan(0);
    expect(before.top).toBe(before.max);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    await page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`).click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await page.waitForTimeout(300);

    await itExpectModalSemantics(page);
    await itExpectRestored(page, saved as number);
  });

  test('S6b: 390x844 modal restores an offset produced by 200% reflow', async ({ page }) => {
    await itUseTextScale(page, '200%');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(POST_2026);
    await openDrawer(page);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.max, '200% text makes the 390px navigation overflow').toBeGreaterThan(0);
    expect(before.top).toBeGreaterThan(0);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    const link = page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`);
    await link.click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await page.waitForTimeout(300);

    await itExpectModalSemantics(page);
    await itExpectRestored(page, saved as number);
  });

  test('S6c: 390x844 at 100% has no scrollable navigation but keeps modal semantics', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(POST_2026);
    await openDrawer(page);
    const state = await itScrollState(page);
    expect(state.max, 'the 390px navigation fits at 100% text').toBe(0);
    expect(state.top).toBe(0);
    await itExpectModalSemantics(page);
  });

  test('S8a: module-load failure fallback writes no scroll key and stays usable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.addInitScript(() => {
      const store = window as unknown as { __storageOps: string[] };
      store.__storageOps = [];
      const getItem = Storage.prototype.getItem;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key: string) {
        if (key === 'selfpage:drawer-scroll') store.__storageOps.push('get');
        return getItem.call(this, key);
      };
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key === 'selfpage:drawer-scroll') store.__storageOps.push(`set:${value}`);
        return setItem.call(this, key, value);
      };
    });
    await page.route('**/_astro/SiteShell*.js', (route) => route.abort());
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));

    await page.goto(POST_2026);
    await page.waitForTimeout(1300);
    const first = await page.evaluate(() => {
      const store = window as unknown as { __storageOps: string[] };
      const area = document.querySelector<HTMLElement>('[data-drawer-scroll]');
      return {
        ops: store.__storageOps.slice(),
        top: area?.scrollTop ?? -1,
        open: document.documentElement.dataset.drawerOpen,
        navReady: document.documentElement.hasAttribute('data-nav-ready'),
        menuDisabled: document.querySelector<HTMLButtonElement>('[data-drawer-toggle]')?.disabled ?? false,
        drawerVisible: getComputedStyle(document.querySelector('#site-drawer')!).visibility,
        navLinks: document.querySelectorAll('.site-nav__link').length,
      };
    });
    expect(first.open, 'fallback opens the server-rendered navigation').toBe('true');
    expect(first.menuDisabled, 'fallback disables the dead Menu button').toBe(true);
    expect(first.drawerVisible, 'fallback navigation is visible').toBe('visible');
    // 3 level-1 items + New! + 2 years + 2 current-year posts = 10 in the
    // fixture; assert a lower bound so content growth does not make the fallback
    // test fail for the wrong reason.
    expect(first.navLinks, 'the level-1 and Blog navigation links are rendered').toBeGreaterThanOrEqual(6);
    expect(first.ops.filter((op) => op === 'get').length, 'boot reads the key once').toBe(1);
    expect(first.ops.filter((op) => op.startsWith('set:')), 'fallback writes no scroll key').toEqual([]);

    // Seed a valid offset and navigate with the module still failing: the value
    // must survive untouched (no write) and the fallback must keep working.
    await page.evaluate(() => sessionStorage.setItem('selfpage:drawer-scroll', '54'));
    await page.evaluate(() => {
      (window as unknown as { __storageOps: string[] }).__storageOps.length = 0;
    });
    await page.locator('.site-nav__link[data-nav-key="blog"]').click();
    await page.waitForURL((url) => url.pathname === '/blog/');
    await page.waitForTimeout(1300);
    const second = await page.evaluate(() => {
      const store = window as unknown as { __storageOps: string[] };
      const ops = store.__storageOps.slice();
      const area = document.querySelector<HTMLElement>('[data-drawer-scroll]');
      return {
        ops,
        stored: sessionStorage.getItem('selfpage:drawer-scroll'),
        top: area?.scrollTop ?? -1,
        max: (area?.scrollHeight ?? 0) - (area?.clientHeight ?? 0),
        open: document.documentElement.dataset.drawerOpen,
        navReady: document.documentElement.hasAttribute('data-nav-ready'),
        h1: document.querySelector('h1')?.textContent,
      };
    });
    expect(second.stored, 'the saved offset survives the failed module load').toBe('54');
    expect(second.ops.filter((op) => op.startsWith('set:')), 'no write on the next document').toEqual([]);
    expect(second.top, 'the shorter archive page clamps the restored 54 to 0').toBe(0);
    expect(second.max).toBe(0);
    expect(second.open).toBe('true');
    expect(second.navReady).toBe(false);
    expect(second.h1).toBe('Blog');
    expect(errors, 'the fallback produces no page errors').toEqual([]);
  });

  test('S8b: with scripting disabled the server-rendered fallback navigates and keeps keys', async ({
    page,
    context,
    browser,
  }) => {
    test.skip(browser.browserType().name() !== 'chromium', 'CDP script disabling is Chromium-only');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.goto(POST_2026);
    await page.evaluate(() => {
      sessionStorage.clear();
      sessionStorage.setItem('selfpage:drawer-open', 'true');
      sessionStorage.setItem('selfpage:drawer-scroll', '0');
    });
    await page.reload();
    await page.waitForTimeout(500);
    const box = await page.locator('.site-nav__link[data-nav-key="blog"]').boundingBox();
    expect(box, 'the Blog link has a box before scripts are disabled').not.toBeNull();

    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
    await page.reload();
    await page.waitForLoadState('load');
    await page.waitForTimeout(300);
    // Native anchor click with no page script running.
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.waitForURL((url) => url.pathname === '/blog/');
    await cdp.send('Emulation.setScriptExecutionDisabled', { value: false });

    const noJs = await page.evaluate(() => ({
      navReady: document.documentElement.hasAttribute('data-nav-ready'),
      open: document.documentElement.dataset.drawerOpen,
      drawerVisible: getComputedStyle(document.querySelector('#site-drawer')!).visibility,
      navLinks: document.querySelectorAll('.site-nav__link').length,
      h1: document.querySelector('h1')?.textContent,
      scrollKey: sessionStorage.getItem('selfpage:drawer-scroll'),
      openKey: sessionStorage.getItem('selfpage:drawer-open'),
    }));
    expect(noJs.navReady, 'no navigation controller ran').toBe(false);
    expect(noJs.open, 'server-rendered open state is kept').toBe('true');
    expect(noJs.drawerVisible).toBe('visible');
    expect(noJs.navLinks, 'navigation links are available without JS').toBeGreaterThanOrEqual(6);
    expect(noJs.h1, 'the no-JS link click navigated').toBe('Blog');
    expect(noJs.scrollKey, 'the no-JS page did not write the scroll key').toBe('0');
    expect(noJs.openKey, 'the no-JS page did not write the open key').toBe('true');
    expect(errors, 'no page errors without JS').toEqual([]);
  });

  test('S8c: reduced motion restores the offset immediately without transitions', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.top).toBeGreaterThan(0);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    await page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`).click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    // Read immediately after the navigation commit: no animation frame wait is
    // allowed to be necessary for the restore.
    const immediate = await page.evaluate(() => {
      const drawer = document.querySelector<HTMLElement>('#site-drawer');
      const area = document.querySelector<HTMLElement>('[data-drawer-scroll]');
      return {
        top: area?.scrollTop ?? -1,
        transition: drawer ? getComputedStyle(drawer).transitionDuration : '',
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      };
    });
    expect(immediate.reduced, 'reduced-motion media is active').toBe(true);
    expect(immediate.transition, 'the drawer has no transition duration').toContain('0s');
    expect(Math.abs(immediate.top - (saved as number)), 'offset is already restored').toBeLessThanOrEqual(1);
    await itExpectRestored(page, saved as number);
  });

  test('extra: back/forward navigation keeps the offset', async ({ page }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    await page.locator(`.site-nav__post-link[href="${POST_2026_OTHER}"]`).click();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await itExpectRestored(page, saved as number);

    await page.goBack();
    await page.waitForURL((url) => url.pathname === POST_2026);
    await itExpectRestored(page, saved as number);
    expect(await itStoredScroll(page)).toBe(saved);

    await page.goForward();
    await page.waitForURL((url) => url.pathname === POST_2026_OTHER);
    await itExpectRestored(page, saved as number);
  });

  test('S4c: a viewport clamp after a user scroll is not written back', async ({ page }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const before = await itScrollState(page);
    expect(before.top, 'the sidebar overflows at 560px height').toBeGreaterThan(0);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    // Growing the window removes part of the overflow and the browser clamps
    // the scroller; that clamp is not a user move and must not be persisted.
    await page.setViewportSize({ width: 1280, height: 600 });
    await expect.poll(async () => (await itScrollState(page)).top).toBeLessThan(before.top);
    await page.waitForTimeout(450);
    expect(await itStoredScroll(page), 'a partial clamp is not written back').toBe(saved);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => (await itScrollState(page)).top).toBe(0);
    await page.waitForTimeout(450);
    expect(await itStoredScroll(page), 'a full clamp is not written back').toBe(saved);

    // Returning to the long list and reloading restores the user's position.
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await itExpectRestored(page, saved as number);
    expect(await itStoredScroll(page)).toBe(saved);
  });

  test('extra: closing and reopening the drawer keeps the offset', async ({ page }) => {
    await itOpen(page, POST_2026);
    await itWheel(page, 400);
    const saved = await itStoredScroll(page);
    expect(saved).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await itExpectRestored(page, saved as number);
    expect(await itStoredScroll(page)).toBe(saved);
  });
});
