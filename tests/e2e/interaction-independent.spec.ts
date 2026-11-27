import { expect, test, type BrowserContext, type Page } from '@playwright/test';


/**
 * Task 08 independent interaction probes (U08, U09, U10, U13, U14).
 *
 * U08 walks the public site with the keyboard only (skip link, drawer, Settings,
 * Blog index, expanded year, article, New! link, Settings again) and checks the
 * focus contract on the way. The author-origin edit page is covered by the
 * companion author spec; the built E2E site points New! at a `.invalid` origin,
 * so this file verifies the exact link/fragment and deliberately does not follow
 * it (recorded as LIMITED in the report).
 *
 * U09 checks 320px, 200% text, a half-width 200% page-zoom proxy and the coarse
 * pointer target size. U10 doubles every visible label through the real DOM.
 */

const TEXT_SIZE_KEY = 'selfpage:preference:text-size';
const POST_2026 = '/blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/';
const POST_2025 = '/blog/2025/Notes%20on%20Accessible%20Navigation-2025-11-02-14-05-00/';

async function noHorizontalOverflow(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    documentClient: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
    bodyClient: document.body.clientWidth,
  }));
  expect(widths.document, `${label}: document scrollWidth`).toBeLessThanOrEqual(widths.documentClient + 1);
  expect(widths.body, `${label}: body scrollWidth`).toBeLessThanOrEqual(widths.bodyClient + 1);
}

async function openDrawer(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
}

interface ActiveInfo {
  tag: string;
  text: string;
  navKey: string | null;
  year: string | null;
  isPostLink: boolean;
  isSettings: boolean;
  isNew: boolean;
  href: string | null;
  insideDrawer: boolean;
  insideMain: boolean;
}

async function activeInfo(page: Page): Promise<ActiveInfo> {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return {
      tag: active?.tagName ?? '',
      text: (active?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      navKey: active?.getAttribute('data-nav-key') ?? null,
      year: active?.getAttribute('data-year') ?? null,
      isPostLink: active?.classList.contains('site-nav__post-link') ?? false,
      isSettings: active?.hasAttribute('data-settings-link') ?? false,
      isNew: active?.hasAttribute('data-new-href') ?? false,
      href: active instanceof HTMLAnchorElement ? active.href : null,
      insideDrawer: Boolean(active?.closest('.site-drawer')),
      insideMain: Boolean(active?.closest('main')),
    };
  });
}

async function tabUntil(
  page: Page,
  predicate: (info: ActiveInfo) => boolean,
  label: string,
  maxTabs = 160,
): Promise<ActiveInfo> {
  const seen: string[] = [];
  for (let index = 0; index < maxTabs; index += 1) {
    await page.keyboard.press('Tab');
    const info = await activeInfo(page);
    seen.push(`${info.tag}:${info.navKey ?? info.year ?? info.text.slice(0, 20)}`);
    if (predicate(info)) return info;
  }
  throw new Error(`${label}: focus target not reached in ${maxTabs} tabs; visited=${seen.join(' > ')}`);
}

async function assertNoPositiveTabindex(page: Page, label: string): Promise<void> {
  const count = await page.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>('[tabindex]')].filter(
        (element) => Number(element.getAttribute('tabindex')) > 0,
      ).length,
  );
  expect(count, `${label}: no positive tabindex`).toBe(0);
}

async function assertSingleAriaCurrent(page: Page, label: string): Promise<string | null> {
  const values = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[aria-current]')].map((element) => ({
      value: element.getAttribute('aria-current'),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    })),
  );
  expect(values.length, `${label}: exactly one aria-current (${JSON.stringify(values)})`).toBe(1);
  return values[0]?.value ?? null;
}

test.describe('U08 independent: keyboard-only journey', () => {
  test('/ -> drawer -> Settings -> /blog/ -> article -> New! and back to Settings without a trap', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.goto('/');
    await assertNoPositiveTabindex(page, 'home');
    // Home is the current branch; its current leaf is a section, so the single
    // aria-current is either the Home page itself or the scrolled-to section.
    expect(['page', 'location'], 'Home has one current entry').toContain(
      await assertSingleAriaCurrent(page, 'home'),
    );
    const homeIsCurrent = await page.evaluate(() => {
      const item = document.querySelector('.site-nav__link[data-nav-key="home"]')?.closest('li');
      return {
        current: item?.classList.contains('is-current') ?? false,
        ancestor: item?.classList.contains('is-current-ancestor') ?? false,
      };
    });
    expect(
      homeIsCurrent.current || homeIsCurrent.ancestor,
      'Home level-1 keeps a visual current/ancestor state',
    ).toBe(true);

    // Skip link, then Menu, then the drawer.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#content')).toBeFocused();

    await page.goto('/');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');

    const blog = await tabUntil(page, (info) => info.navKey === 'blog', 'Blog level-1 link');
    expect(blog.insideDrawer, 'the Blog link is inside the drawer').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/blog\/$/u);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await assertSingleAriaCurrent(page, 'blog index'), 'Blog is the current page').toBe('page');
    await assertNoPositiveTabindex(page, 'blog index');

    // The wide-screen drawer stays open across navigation; reach the year
    // disclosure by keyboard and expand it.
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    const year = await tabUntil(page, (info) => info.year === '2026', '2026 year toggle');
    expect(year.insideDrawer).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.locator('#nav-year-2026-posts')).not.toHaveAttribute('hidden', '');

    const post = await tabUntil(page, (info) => info.isPostLink, 'article link in the expanded year');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/blog\/2026\//u);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await assertSingleAriaCurrent(page, 'article'), 'the article is the single current page').toBe('page');
    await assertNoPositiveTabindex(page, 'article');
    const ancestors = await page.evaluate(() =>
      [...document.querySelectorAll('.site-nav__item.is-current-ancestor > .site-nav__link')].map((link) =>
        (link.textContent ?? '').replace(/\s+/g, ' ').trim(),
      ),
    );
    expect(ancestors, 'the article keeps Blog and its year as ancestors').toEqual(['Blog', '2026']);

    // New!: keyboard reachable, correct author target and non-sensitive fragment.
    const newLink = await tabUntil(page, (info) => info.isNew, 'New! link');
    expect(newLink.href, 'New! has a target').not.toBeNull();
    const url = new URL(newLink.href ?? '');
    expect(url.pathname, 'New! targets the author origin root').toBe('/new/');
    expect(url.origin, 'New! leaves the public origin').not.toBe(new URL(page.url()).origin);
    const fragment = new URLSearchParams(url.hash.replace(/^#/u, ''));
    expect([...fragment.keys()].sort(), 'only preferences are passed to the author origin').toEqual([
      'motion',
      'size',
      'theme',
    ]);
    expect(fragment.get('theme')).toBe('system');
    expect(fragment.get('motion')).toBe('system');
    expect(fragment.get('size')).toBe('default');
    expect(url.hash, 'no session/token in the fragment').not.toMatch(/session|token|state|verifier/iu);

    // Continue to the fixed Settings row, use it, and prove the wide drawer is
    // not a focus trap: the next Tab leaves the drawer.
    const settings = await tabUntil(page, (info) => info.isSettings, 'Settings link');
    expect(settings.insideDrawer).toBe(true);
    await page.keyboard.press('Tab');
    const afterSettings = await activeInfo(page);
    expect(afterSettings.insideDrawer, 'wide-screen drawer does not trap Tab').toBe(false);

    await tabUntil(page, (info) => info.isSettings, 'Settings link again');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/settings\/$/u);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await assertSingleAriaCurrent(page, 'settings'), 'the fixed Settings row is current').toBe('page');
    await assertNoPositiveTabindex(page, 'settings');
  });
});

test.describe('U09 independent: 320px, 200% text, 200% zoom proxy, coarse targets', () => {
  test('home/settings/blog/article have no horizontal scrolling at 320px with 200% text', async ({ page }) => {
    await page.addInitScript(({ key }) => localStorage.setItem(key, 'large'), { key: TEXT_SIZE_KEY });
    await page.setViewportSize({ width: 320, height: 568 });
    for (const path of ['/', '/settings/', '/blog/', POST_2026]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-text-size', 'large');
      await noHorizontalOverflow(page, `${path} at 320px Large`);

      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      await page.waitForTimeout(50);
      await noHorizontalOverflow(page, `${path} at 320px Large 200% text`);

      // Content is not dropped to fit: the main region still has real text and
      // the primary navigation is still reachable.
      const content = await page.evaluate(() => ({
        text: (document.querySelector('main')?.textContent ?? '').replace(/\s+/g, ' ').trim().length,
        links: document.querySelectorAll('main a[href]').length,
      }));
      expect(content.text, `${path}: main content survives reflow`).toBeGreaterThan(80);

      // 200% page zoom proxy: a 200% zoom at 1280x720 is a 640x360 CSS
      // viewport. The layout must reflow, not scroll sideways.
      await page.setViewportSize({ width: 640, height: 360 });
      await noHorizontalOverflow(page, `${path} at the 200% page-zoom proxy`);
      await page.setViewportSize({ width: 320, height: 568 });
    }
  });

  test('CDP page scale 2 keeps a single-column layout proxy without 2D scrolling', async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await page.setViewportSize({ width: 640, height: 360 });
    for (const path of ['/', '/settings/']) {
      await page.goto(path);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      const facts = await page.evaluate(() => ({
        scale: window.visualViewport?.scale ?? 0,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      console.log(`PAGE SCALE ${path}: ${JSON.stringify(facts)}`);
      expect(facts.scale, `${path}: page scale factor is 2`).toBe(2);
      expect(facts.scrollWidth, `${path}: no layout 2D scroll under page scale`).toBeLessThanOrEqual(
        facts.clientWidth + 1,
      );
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    }
  });

  test.describe('coarse pointer', () => {
    test.use({ hasTouch: true, viewport: { width: 320, height: 568 } });

    test('every visible coarse-pointer target is at least 44 by 44 CSS px', async ({ page }) => {
      const pages = ['/', '/settings/', '/blog/', POST_2026];
      for (const path of pages) {
        await page.goto(path);
        await openDrawer(page);
        const coarse = await page.evaluate(() => ({
          coarse: matchMedia('(pointer: coarse)').matches,
          touch: navigator.maxTouchPoints,
        }));
        expect(coarse.coarse || coarse.touch > 0, `${path}: emulated as a touch/coarse device`).toBe(true);

        const targets = await page.evaluate(() => {
          const selectors = [
            '.menu-trigger',
            '.site-drawer__close',
            '.site-brand',
            '.site-nav__settings',
            '.site-nav__link',
            '.settings__option',
            '[data-settings-reset]',
          ];
          const results: Array<{ selector: string; width: number; height: number; text: string }> = [];
          for (const selector of selectors) {
            for (const element of document.querySelectorAll<HTMLElement>(selector)) {
              const box = element.getBoundingClientRect();
              if (box.width === 0 || box.height === 0) continue;
              const style = getComputedStyle(element);
              if (style.visibility === 'hidden' || style.display === 'none') continue;
              results.push({
                selector,
                width: box.width,
                height: box.height,
                text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
              });
            }
          }
          return results;
        });
        expect(targets.length, `${path}: coarse targets found`).toBeGreaterThan(4);
        for (const target of targets) {
          expect(minimum(target), `${path}: ${target.selector} "${target.text}" target size`).toBeGreaterThanOrEqual(44);
        }
        // Every one of the required fixed controls is measured on this page.
        for (const required of ['.menu-trigger', '.site-drawer__close', '.site-nav__link', '.site-nav__settings']) {
          expect(
            targets.some((target) => target.selector === required),
            `${path}: ${required} measured`,
          ).toBe(true);
        }
      }
    });

    function minimum(target: { width: number; height: number }): number {
      return Math.min(target.width, target.height);
    }
  });
});

test.describe('U10 independent: doubled translation labels', () => {
  async function doubleLabels(page: Page): Promise<void> {
    await page.evaluate(() => {
      const brand = document.querySelector<HTMLElement>('.site-brand');
      if (brand) brand.textContent = "Xinyang Zeng's Homepage and Research Portfolio";
      const levelOne: Record<string, string> = {
        home: 'Home and recent highlights',
        publications: 'Publications and selected research outputs',
        blog: 'Blog and occasional longer notes',
      };
      for (const [key, text] of Object.entries(levelOne)) {
        const link = document.querySelector<HTMLElement>(`.site-nav__link[data-nav-key="${key}"] .site-nav__label`);
        if (link) link.textContent = text;
      }
      const settingsLabel = document.querySelector<HTMLElement>('.site-nav__settings .site-nav__label');
      if (settingsLabel) settingsLabel.textContent = 'Settings and accessibility preferences';
      for (const label of document.querySelectorAll<HTMLElement>('.site-nav__post-text')) {
        const current = label.textContent ?? '';
        label.textContent = `${current} (extended translated title for localization)`;
      }
      const heading = document.querySelector<HTMLElement>('.settings__title');
      if (heading) heading.textContent = 'Settings and accessibility preferences';
      for (const groupHeading of document.querySelectorAll<HTMLElement>('.settings__heading')) {
        groupHeading.textContent = `${groupHeading.textContent ?? ''} for this browser and device`;
      }
      for (const label of document.querySelectorAll<HTMLElement>('.settings__option-label')) {
        label.textContent = `${label.textContent ?? ''} choice for this device`;
      }
      for (const hint of document.querySelectorAll<HTMLElement>('.settings__option-detail')) {
        hint.textContent = `${hint.textContent ?? ''}, following the setting of this browser on this device.`;
      }
      const intro = document.querySelector<HTMLElement>('.settings__intro');
      if (intro) intro.textContent = `${intro.textContent ?? ''} These preferences are stored in this browser only, on this device and nowhere else.`;
      const reset = document.querySelector<HTMLElement>('[data-settings-reset]');
      if (reset) reset.textContent = 'Reset every setting to the default values';
      const status = document.querySelector<HTMLElement>('[data-settings-status]');
      if (status) status.textContent = `${status.textContent ?? ''} Stored only in this browser, never on a server.`;
    });
    // The page re-measures on ResizeObserver; give it a frame to settle.
    await page.waitForTimeout(400);
  }

  test('doubled labels at 320px do not overlap, clip or widen the page', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/settings/');
    await openDrawer(page);
    await doubleLabels(page);
    await noHorizontalOverflow(page, '320px doubled labels');

    const layout = await page.evaluate(() => {
      const rect = (element: Element) => element.getBoundingClientRect();
      const menu = document.querySelector<HTMLElement>('.menu-trigger');
      const brand = document.querySelector<HTMLElement>('.site-brand');
      const drawer = document.querySelector<HTMLElement>('.site-drawer');
      const drawerLink = document.querySelector<HTMLElement>('.site-nav__settings');
      const settingsRows = [...document.querySelectorAll<HTMLElement>('.settings__option')];
      const reset = document.querySelector<HTMLElement>('[data-settings-reset]');
      const status = document.querySelector<HTMLElement>('.settings__status');
      const title = document.querySelector<HTMLElement>('.settings__title');
      const visibleNavItems = [...document.querySelectorAll<HTMLElement>('.site-nav__link')].filter(
        (element) => element.getBoundingClientRect().height > 0,
      );
      const overlaps = (first: DOMRect, second: DOMRect): boolean =>
        first.left < second.right - 0.5 &&
        second.left < first.right - 0.5 &&
        first.top < second.bottom - 0.5 &&
        second.top < first.bottom - 0.5;
      const navOverlaps: string[] = [];
      for (let index = 0; index < visibleNavItems.length; index += 1) {
        for (let other = index + 1; other < visibleNavItems.length; other += 1) {
          const first = visibleNavItems[index];
          const second = visibleNavItems[other];
          if (!first || !second) continue;
          const firstRect = rect(first);
          const secondRect = rect(second);
          // Nested links are never siblings; only compare different rows.
          if (first.contains(second) || second.contains(first)) continue;
          if (overlaps(firstRect, secondRect)) {
            navOverlaps.push(
              `${(first.textContent ?? '').trim().slice(0, 20)} / ${(second.textContent ?? '').trim().slice(0, 20)}`,
            );
          }
        }
      }
      // Inline labels (spans) report clientWidth 0, so a white-space:nowrap
      // fault would silently pass a bare scrollWidth check; compare the line
      // boxes with the parent box instead.
      const overflows = (element: HTMLElement): boolean => {
        const style = getComputedStyle(element);
        if (style.display === 'inline') {
          const rects = [...element.getClientRects()];
          const parent = element.parentElement?.getBoundingClientRect();
          if (rects.length === 0 || !parent) return false;
          const minLeft = Math.min(...rects.map((box) => box.left));
          const maxRight = Math.max(...rects.map((box) => box.right));
          return minLeft < parent.left - 1 || maxRight > parent.right + 1;
        }
        return element.scrollWidth > element.clientWidth + 1;
      };
      const labelOverflow = (selector: string): string[] =>
        [...document.querySelectorAll<HTMLElement>(selector)]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .filter((element) => overflows(element))
          .map((element) => `${selector}: ${(element.textContent ?? '').trim().slice(0, 30)}`);
      const labelInsideRow = [...document.querySelectorAll<HTMLElement>('.settings__option-label, .settings__option-detail')]
        .filter((element) => element.getBoundingClientRect().width > 0)
        .filter((element) => {
          const row = element.closest<HTMLElement>('.settings__option');
          if (!row) return false;
          const box = rect(element);
          const rowBox = rect(row);
          return box.left < rowBox.left - 1 || box.right > rowBox.right + 1;
        })
        .map((element) => (element.textContent ?? '').trim().slice(0, 30));
      return {
        pageWidth: document.documentElement.clientWidth,
        menuBrandOverlap: menu && brand ? overlaps(rect(menu), rect(brand)) : false,
        menuInsideTopBar: menu ? rect(menu).top >= 0 && rect(menu).right <= window.innerWidth + 1 : false,
        brandInsideTopBar: brand ? rect(brand).right <= window.innerWidth + 1 : false,
        drawerInsideViewport: drawer
          ? rect(drawer).left >= -1 && rect(drawer).right <= window.innerWidth + 1
          : false,
        settingsRowInsideDrawer:
          drawer && drawerLink
            ? rect(drawerLink).left >= rect(drawer).left - 1 && rect(drawerLink).right <= rect(drawer).right + 1
            : false,
        navOverlaps,
        rowsInsideViewport: settingsRows.every((row) => {
          const box = rect(row);
          return box.left >= -1 && box.right <= window.innerWidth + 1;
        }),
        rowsNoInternalOverflow: settingsRows.every((row) => row.scrollWidth <= row.clientWidth + 1),
        optionLabelsInsideRows: labelInsideRow,
        rowsMinHeight: Math.min(...settingsRows.map((row) => rect(row).height)),
        resetInsideViewport: reset ? rect(reset).right <= window.innerWidth + 1 : false,
        resetBelowRows: reset && settingsRows.length > 0
          ? rect(reset).top >= rect(settingsRows[settingsRows.length - 1] as Element).bottom - 1
          : false,
        statusBelowReset: reset && status ? rect(status).top >= rect(reset).bottom - 1 : false,
        titleInside: title ? rect(title).right <= window.innerWidth + 1 : false,
        levelOneLabelOverflow: labelOverflow('.site-nav__label'),
        optionLabelOverflow: labelOverflow('.settings__option-label'),
        optionDetailOverflow: labelOverflow('.settings__option-detail'),
        resetOverflow: labelOverflow('.settings__button'),
        headingOverflow: labelOverflow('.settings__heading'),
      };
    });
    expect(layout.menuBrandOverlap, 'menu and brand never overlap').toBe(false);
    expect(layout.menuInsideTopBar, 'menu stays inside the top bar').toBe(true);
    expect(layout.brandInsideTopBar, 'doubled brand stays inside the top bar').toBe(true);
    expect(layout.drawerInsideViewport, 'the drawer stays inside the viewport').toBe(true);
    expect(layout.settingsRowInsideDrawer, 'the Settings row stays inside the drawer').toBe(true);
    expect(layout.navOverlaps, 'navigation rows never overlap after translation').toEqual([]);
    expect(layout.rowsInsideViewport, 'settings rows stay inside the viewport').toBe(true);
    expect(layout.rowsNoInternalOverflow, 'settings rows have no internal horizontal overflow').toBe(true);
    expect(layout.optionLabelsInsideRows, 'option labels stay inside their row').toEqual([]);
    expect(layout.rowsMinHeight, 'settings rows keep a 44px target').toBeGreaterThanOrEqual(44);
    expect(layout.resetInsideViewport, 'Reset stays inside the viewport').toBe(true);
    expect(layout.resetBelowRows, 'Reset stays below the option rows').toBe(true);
    expect(layout.statusBelowReset, 'the live status stays after Reset').toBe(true);
    expect(layout.titleInside, 'the doubled page title stays inside').toBe(true);
    expect(layout.levelOneLabelOverflow, 'drawer labels wrap instead of clipping').toEqual([]);
    expect(layout.optionLabelOverflow, 'option labels wrap instead of clipping').toEqual([]);
    expect(layout.optionDetailOverflow, 'option details wrap instead of clipping').toEqual([]);
    expect(layout.resetOverflow, 'the doubled Reset label wraps').toEqual([]);
    expect(layout.headingOverflow, 'group headings wrap').toEqual([]);

    // The post labels are allowed a visual ellipsis; move to an article where
    // the current year is expanded, double those labels too, and verify the
    // ellipsis keeps the row inside the drawer with the full text in the DOM.
    await page.goto(POST_2026);
    await openDrawer(page);
    await page.evaluate(() => {
      for (const label of document.querySelectorAll<HTMLElement>('.site-nav__post-text')) {
        label.textContent = `${label.textContent ?? ''} (extended translated title for localization)`;
      }
    });
    await page.waitForTimeout(400);
    const postLabels = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.site-nav__post-label')]
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => {
          const box = element.getBoundingClientRect();
          return {
            textOverflow: getComputedStyle(element).textOverflow,
            whiteSpace: getComputedStyle(element).whiteSpace,
            text: (element.textContent ?? '').trim(),
            width: box.width,
            scrollWidth: element.scrollWidth,
          };
        }),
    );
    expect(postLabels.length, 'visible post labels exist').toBeGreaterThan(0);
    for (const label of postLabels) {
      expect(label.textOverflow, 'post labels use an ellipsis').toBe('ellipsis');
      expect(label.whiteSpace).toBe('nowrap');
      expect(label.text.length, 'post label keeps its full text in the DOM').toBeGreaterThan(20);
      expect(label.scrollWidth, 'the full label stays in the DOM').toBeGreaterThan(label.width);
    }

    // The hover preview bubble: doubled title stays inside a 320px viewport and
    // clamps instead of widening the page.
    const link = page.locator('.site-nav__post-link[data-overflow="true"]').first();
    await link.hover();
    await page.evaluate(() => {
      for (const title of document.querySelectorAll<HTMLElement>('.nav-preview__title')) {
        title.textContent = `${title.textContent ?? ''} with an extended translated title for localization testing`;
      }
    });
    await page.waitForTimeout(150);
    const bubble = await page.evaluate(() => {
      const preview = [...document.querySelectorAll<HTMLElement>('.nav-preview')].find(
        (element) => getComputedStyle(element).visibility === 'visible',
      );
      if (!preview) return null;
      const box = preview.getBoundingClientRect();
      const title = preview.querySelector<HTMLElement>('.nav-preview__title');
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        titleOverflow: title ? title.scrollWidth - title.clientWidth : -1,
        lineClamp: title ? getComputedStyle(title).webkitLineClamp : '',
        text: (title?.textContent ?? '').trim().length,
      };
    });
    expect(bubble, 'a preview bubble is visible on hover').not.toBeNull();
    if (bubble) {
      expect(bubble.left, 'bubble left inside viewport').toBeGreaterThanOrEqual(-1);
      expect(bubble.right, 'bubble right inside viewport').toBeLessThanOrEqual(bubble.viewportWidth + 1);
      expect(bubble.top, 'bubble top inside viewport').toBeGreaterThanOrEqual(-1);
      expect(bubble.bottom, 'bubble bottom inside viewport').toBeLessThanOrEqual(bubble.viewportHeight + 1);
      expect(bubble.titleOverflow, 'doubled bubble title does not scroll horizontally').toBeLessThanOrEqual(1);
      expect(bubble.lineClamp, 'bubble title is line-clamped').toBe('3');
      expect(bubble.text, 'bubble title keeps its text').toBeGreaterThan(20);
    }
  });

  test('the preview bubble stays usable at 320px with 200% text and Large', async ({ page }) => {
    await page.addInitScript(({ key }) => localStorage.setItem(key, 'large'), { key: TEXT_SIZE_KEY });
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(POST_2026);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    await openDrawer(page);
    const link = page.locator('.site-nav__post-link[data-overflow="true"]').first();
    await link.hover();
    await page.waitForTimeout(150);
    const bubble = await page.evaluate(() => {
      const preview = [...document.querySelectorAll<HTMLElement>('.nav-preview')].find(
        (element) => getComputedStyle(element).visibility === 'visible',
      );
      if (!preview) return null;
      const box = preview.getBoundingClientRect();
      const title = preview.querySelector<HTMLElement>('.nav-preview__title');
      const date = preview.querySelector<HTMLElement>('.nav-preview__date');
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        titleOverflow: title ? title.scrollWidth - title.clientWidth : -1,
        titleFont: title ? getComputedStyle(title).fontSize : '',
        lineClamp: title ? getComputedStyle(title).webkitLineClamp : '',
        titleText: (title?.textContent ?? '').trim(),
        dateVisible: date ? date.getBoundingClientRect().height > 0 : false,
        bodyOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(bubble, `a preview bubble is visible at 320px/200%/Large`).not.toBeNull();
    if (!bubble) return;
    expect(bubble.left, 'bubble left inside viewport').toBeGreaterThanOrEqual(-1);
    expect(bubble.right, 'bubble right inside viewport').toBeLessThanOrEqual(bubble.viewportWidth + 1);
    expect(bubble.top, 'bubble top inside viewport').toBeGreaterThanOrEqual(-1);
    expect(bubble.bottom, 'bubble bottom inside viewport').toBeLessThanOrEqual(bubble.viewportHeight + 1);
    expect(bubble.titleOverflow, 'the bubble title has no horizontal overflow').toBeLessThanOrEqual(1);
    expect(bubble.lineClamp, 'the bubble title is still clamped to three lines').toBe('3');
    expect(bubble.titleText.length, 'the bubble title keeps its text').toBeGreaterThan(10);
    expect(bubble.dateVisible, 'the bubble date stays visible').toBe(true);
    expect(Number.parseFloat(bubble.titleFont), 'the bubble title follows Text Size + 200% text').toBeGreaterThan(30);
    expect(bubble.bodyOverflow, 'the bubble does not widen the page').toBeLessThanOrEqual(1);
  });

  test('doubled labels at 1280px keep the drawer and settings usable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings/');
    await openDrawer(page);
    await doubleLabels(page);
    await noHorizontalOverflow(page, '1280px doubled labels');
    const facts = await page.evaluate(() => {
      const drawer = document.querySelector<HTMLElement>('.site-drawer');
      const settings = document.querySelector<HTMLElement>('.site-nav__settings');
      if (!drawer || !settings) return null;
      return {
        drawerWidth: drawer.getBoundingClientRect().width,
        settingsWidth: settings.getBoundingClientRect().width,
        settingsHeight: settings.getBoundingClientRect().height,
        settingsScrollWidth: settings.scrollWidth,
        settingsClientWidth: settings.clientWidth,
      };
    });
    expect(facts).not.toBeNull();
    if (facts) {
      expect(facts.settingsWidth, 'Settings row fills the drawer width').toBeLessThanOrEqual(facts.drawerWidth + 1);
      expect(facts.settingsHeight, 'Settings row keeps its 56px height').toBeGreaterThanOrEqual(44);
      expect(facts.settingsScrollWidth, 'Settings label wraps inside the row').toBeLessThanOrEqual(
        facts.settingsClientWidth + 1,
      );
    }
  });
});

test.describe('U13/U14 independent recheck', () => {
  test('the whole top-bar band uses the sidebar colour in light/dark and open/closed states', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const samples: Array<{
      theme: string;
      open: string;
      band: string;
      drawer: string;
      page: string;
      width: number;
      height: number;
    }> = [];
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      for (const open of ['closed', 'open'] as const) {
        if (open === 'open') await openDrawer(page);
        else {
          const menu = page.getByRole('button', { name: 'Menu' });
          if ((await menu.getAttribute('aria-expanded')) === 'true') {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.getByRole('button', { name: 'Close' }).click();
            await page.setViewportSize({ width: 1280, height: 900 });
          }
        }
        const sample = await page.evaluate(() => {
          const topBar = document.querySelector<HTMLElement>('.top-bar');
          const drawer = document.querySelector<HTMLElement>('.site-drawer');
          if (!topBar || !drawer) return null;
          const box = topBar.getBoundingClientRect();
          return {
            band: getComputedStyle(topBar, '::before').backgroundColor,
            drawer: getComputedStyle(drawer).backgroundColor,
            page: getComputedStyle(document.body).backgroundColor,
            width: box.width,
            height: box.height,
          };
        });
        expect(sample, `${theme}/${open}: top bar and drawer exist`).not.toBeNull();
        if (sample) samples.push({ theme, open, ...sample });
      }
    }
    for (const sample of samples) {
      console.log(
        `TOPBAR ${sample.theme} ${sample.open}: band=${sample.band} drawer=${sample.drawer} page=${sample.page} ${sample.width}x${sample.height}`,
      );
      expect(sample.band, `${sample.theme}/${sample.open}: band equals the sidebar colour`).toBe(sample.drawer);
      expect(sample.band, `${sample.theme}/${sample.open}: band differs from the page canvas`).not.toBe(sample.page);
      expect(sample.width, `${sample.theme}/${sample.open}: band spans the viewport`).toBe(1280);
      expect(sample.height, `${sample.theme}/${sample.open}: band covers the top bar`).toBeGreaterThanOrEqual(84);
    }
    expect(samples.find((sample) => sample.theme === 'light')?.band, 'light sidebar token').toBe('rgb(245, 245, 245)');
    expect(samples.find((sample) => sample.theme === 'dark')?.band, 'dark sidebar token').toBe('rgb(27, 27, 27)');
  });

  test('favicon links exist and /favicon.ico is served, not 404', async ({ page }) => {
    await page.goto('/settings/');
    const icons = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')].map((link) => ({
        href: new URL(link.href, location.href).href,
        type: link.type,
        sizes: link.getAttribute('sizes'),
      })),
    );
    console.log(`FAVICON links ${JSON.stringify(icons)}`);
    expect(icons.length, 'icon links declared').toBeGreaterThanOrEqual(2);
    expect(icons.some((icon) => icon.href.endsWith('/favicon.ico')), 'favicon.ico link exists').toBe(true);
    expect(icons.some((icon) => icon.href.endsWith('/favicon.svg')), 'favicon.svg link exists').toBe(true);
    for (const icon of icons) {
      expect(new URL(icon.href).origin, `${icon.href} is local`).toBe(new URL(page.url()).origin);
    }
    for (const path of ['/favicon.ico', '/favicon.svg']) {
      const response = await page.request.get(path, { failOnStatusCode: false });
      const body = await response.body();
      const contentType = response.headers()['content-type'] ?? '';
      console.log(`FAVICON ${path}: status=${response.status()} type=${contentType} bytes=${body.length}`);
      expect(response.status(), `${path} status`).toBe(200);
      expect(body.length, `${path} has content`).toBeGreaterThan(100);
      expect(contentType, `${path} content type`).toMatch(/image\/(x-icon|vnd\.microsoft\.icon|svg\+xml)/u);
    }
  });
});
