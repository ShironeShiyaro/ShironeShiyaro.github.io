/**
 * Task 03 browser verification (execution-agent evidence, not independent
 * acceptance). Runs the built site in system Edge and records N01-N14 style
 * checks plus screenshots under test-results/verify-navigation/.
 *
 * R09-19: output moved off docs_AI/记录/r03/assets/ (task 03's tracked evidence)
 * so re-running this script can never overwrite a historical record.
 *
 * Usage: start `astro preview --port 4322`, then `node tests/verify-navigation.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.VERIFY_BASE ?? 'http://127.0.0.1:4322';
const OUT = 'test-results/verify-navigation';
const POST_2026 = '/blog/2026/Reading%20List%20for%20Spring-2026-11-20-08-40-00/';
const POST_2026_OTHER = '/blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/';

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];

function record(id, status, details = {}) {
  results.push({ id, status, details });
  console.log(`${status} ${id} ${JSON.stringify(details)}`);
}

async function scenario(id, fn, status = 'PASS') {
  try {
    const details = await fn();
    record(id, status, details ?? {});
  } catch (error) {
    record(id, 'FAIL', { error: error instanceof Error ? error.message : String(error) });
  }
}

async function newPage(options) {
  const page = await browser.newPage(options);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.__pageErrors = pageErrors;
  return page;
}

async function openDrawer(page) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await page.waitForTimeout(320);
}

async function navState(page) {
  return page.evaluate(() => {
    const drawer = document.querySelector('.site-drawer');
    const style = drawer ? getComputedStyle(drawer) : null;
    return {
      open: document.documentElement.getAttribute('data-drawer-open'),
      menuExpanded: document.querySelector('[data-drawer-toggle]')?.getAttribute('aria-expanded'),
      drawer: {
        visibility: style?.visibility,
        transform: style?.transform,
        role: drawer?.getAttribute('role') ?? null,
        ariaModal: drawer?.getAttribute('aria-modal') ?? null,
        ariaHidden: drawer?.getAttribute('aria-hidden') ?? null,
        inert: drawer?.hasAttribute('inert') ?? null,
        rect: drawer?.getBoundingClientRect().toJSON(),
      },
      mainInert: document.querySelector('main')?.hasAttribute('inert') ?? null,
      brandInert: document.querySelector('.site-brand')?.hasAttribute('inert') ?? null,
      current: [...document.querySelectorAll('nav[aria-label="Site"] [aria-current]')].map((element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        value: element.getAttribute('aria-current') ?? '',
      })),
      ancestors: [...document.querySelectorAll('.site-nav__item.is-current-ancestor')].map((element) =>
        element.querySelector(':scope > .site-nav__link')?.textContent?.replace(/\s+/g, ' ').trim(),
      ),
      active: {
        tag: document.activeElement?.tagName,
        text: document.activeElement?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 40),
        inDrawer: Boolean(document.activeElement?.closest('#site-drawer')),
      },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// N01: desktop slide, push and restore
// ---------------------------------------------------------------------------
await scenario('N01', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(250);
  const closed = await navState(page);
  await page.screenshot({ path: `${OUT}/n01-desktop-closed.png` });
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.waitForTimeout(70);
  const opening = await navState(page);
  await page.screenshot({ path: `${OUT}/n01-desktop-opening.png` });
  await page.waitForTimeout(400);
  const open = await navState(page);
  await page.screenshot({ path: `${OUT}/n01-desktop-open.png` });
  await page.locator('main h1').click();
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.waitForTimeout(350);
  const closedAgain = await navState(page);

  const closedX = closed.drawer.rect.x;
  const openingX = opening.drawer.rect.x;
  const openX = open.drawer.rect.x;
  const mainClosedX = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.querySelector('main')).marginInlineStart));
  assert(closed.drawer.transform.includes('-'), 'closed drawer must be translated off-screen');
  assert(openingX > closedX && openingX < openX + 0.5, `intermediate slide transform: ${closedX} -> ${openingX} -> ${openX}`);
  assert(open.drawer.visibility === 'visible', 'open drawer visible');
  assert(open.drawer.rect.x >= -1, 'open drawer at x=0');
  assert(open.scrollWidth <= open.clientWidth + 1, 'no page horizontal scroll while open');
  assert(closedAgain.drawer.visibility === 'hidden', 'closed drawer hidden after transition');
  assert(closedAgain.scrollWidth <= closedAgain.clientWidth + 1, 'no page horizontal scroll when closed');
  await page.close();
  return { closedX, openingX, openX, mainClosedX, closedMenu: closed.menuExpanded, openMenu: open.menuExpanded, closedAgain: closedAgain.menuExpanded, pageErrors: page.__pageErrors };
});

// ---------------------------------------------------------------------------
// N02: narrow modal, focus trap and four dismissal paths
// ---------------------------------------------------------------------------
await scenario('N02', async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/blog/`);
  await page.waitForTimeout(250);
  await openDrawer(page);
  const opened = await navState(page);
  await page.mouse.move(380, 700);
  await page.screenshot({ path: `${OUT}/n02-narrow-390-open.png` });
  const tabs = [];
  for (let index = 0; index < 15; index += 1) {
    await page.keyboard.press('Tab');
    tabs.push(await page.evaluate(() => Boolean(document.activeElement?.closest('#site-drawer'))));
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(320);
  const afterEscape = await navState(page);

  async function reopen() {
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.waitForTimeout(320);
  }
  async function closedWithFocus() {
    await page.waitForTimeout(220);
    return page.evaluate(() => ({
      active: document.activeElement?.className ?? document.activeElement?.tagName,
      menuExpanded: document.querySelector('[data-drawer-toggle]')?.getAttribute('aria-expanded'),
      mainInert: document.querySelector('main')?.hasAttribute('inert'),
    }));
  }

  await reopen();
  await page.getByRole('button', { name: 'Close' }).click();
  const afterClose = await closedWithFocus();
  await reopen();
  await page.mouse.click(385, 500);
  const afterBackdrop = await closedWithFocus();
  await reopen();
  await page.getByRole('button', { name: 'Menu' }).click();
  const afterMenu = await closedWithFocus();

  assert(opened.drawer.role === 'dialog', 'drawer has dialog role');
  assert(opened.drawer.ariaModal === 'true', 'aria-modal true');
  assert(opened.mainInert === true && opened.brandInert === true, 'external content inert');
  assert(opened.active.inDrawer === true, `focus starts inside modal: ${opened.active.text}`);
  assert(tabs.every(Boolean), 'Tab never escapes the modal');
  assert(afterEscape.open === 'false' && afterEscape.menuExpanded === 'false', 'Escape closes');
  assert(afterEscape.mainInert === false, 'Escape removes external inert');
  assert(afterEscape.active.tag === 'BUTTON' && afterEscape.active.text === 'Menu', 'Escape restores Menu focus');
  for (const [label, state] of [['Close', afterClose], ['backdrop', afterBackdrop], ['Menu', afterMenu]]) {
    assert(state.menuExpanded === 'false', `${label} closes`);
    assert(state.mainInert === false, `${label} removes inert`);
    assert(state.active.includes('menu-trigger'), `${label} restores Menu focus (${state.active})`);
  }
  await page.close();
  return { tabsInside: tabs.filter(Boolean).length, role: opened.drawer.role, ariaModal: opened.drawer.ariaModal, focusStart: opened.active.text, afterEscape, afterClose, afterBackdrop, afterMenu };
});

// ---------------------------------------------------------------------------
// N03: stable chrome coordinates and one brand
// ---------------------------------------------------------------------------
await scenario('N03', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const rows = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => ({
      menu: document.querySelector('.menu-trigger')?.getBoundingClientRect().toJSON(),
      brand: document.querySelector('.site-brand')?.getBoundingClientRect().toJSON(),
      brands: document.querySelectorAll('.site-brand').length,
      brandText: document.body.innerText.split("Xinyang Zeng's Homepage").length - 1,
    }));
    await openDrawer(page);
    const after = await page.evaluate(() => ({
      menu: document.querySelector('.menu-trigger')?.getBoundingClientRect().toJSON(),
      brand: document.querySelector('.site-brand')?.getBoundingClientRect().toJSON(),
    }));
    const delta = {
      menu: [Math.abs(after.menu.x - before.menu.x), Math.abs(after.menu.y - before.menu.y)],
      brand: [Math.abs(after.brand.x - before.brand.x), Math.abs(after.brand.y - before.brand.y)],
    };
    assert(delta.menu[0] <= 1 && delta.menu[1] <= 1, `${width}: Menu moved ${JSON.stringify(delta.menu)}`);
    assert(delta.brand[0] <= 1 && delta.brand[1] <= 1, `${width}: brand moved ${JSON.stringify(delta.brand)}`);
    assert(before.brands === 1, `${width}: one brand element`);
    assert(before.brandText === 1, `${width}: one visible brand text (${before.brandText})`);
    rows.push({ width, delta, brands: before.brands, brandText: before.brandText });
  }
  await page.close();
  return rows;
});

// ---------------------------------------------------------------------------
// N04/N05: middle scroller, fixed rows, wheel/keyboard/touch, scrollbar
// ---------------------------------------------------------------------------
await scenario('N04', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 560 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/blog/`);
  await openDrawer(page);
  await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => ({
    menu: document.querySelector('.menu-trigger')?.getBoundingClientRect().toJSON(),
    brand: document.querySelector('.site-brand')?.getBoundingClientRect().toJSON(),
    settings: document.querySelector('[data-settings-slot]')?.getBoundingClientRect().toJSON(),
    levelOne: document.querySelector('.site-nav__link--level-1')?.getBoundingClientRect().height,
    scrollHeight: document.querySelector('[data-drawer-scroll]')?.scrollHeight,
    clientHeight: document.querySelector('[data-drawer-scroll]')?.clientHeight,
  }));
  assert((before.scrollHeight ?? 0) > (before.clientHeight ?? 0), 'nav content overflows');
  const box = await page.locator('[data-drawer-scroll]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(250);
  const wheelTop = await page.locator('[data-drawer-scroll]').evaluate((element) => element.scrollTop);
  await page.locator('[data-drawer-scroll]').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.locator('[data-drawer-scroll]').focus();
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(250);
  const keyboardTop = await page.locator('[data-drawer-scroll]').evaluate((element) => element.scrollTop);
  await page.locator('[data-drawer-scroll]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({
    menu: document.querySelector('.menu-trigger')?.getBoundingClientRect().toJSON(),
    brand: document.querySelector('.site-brand')?.getBoundingClientRect().toJSON(),
    settings: document.querySelector('[data-settings-slot]')?.getBoundingClientRect().toJSON(),
  }));
  await page.screenshot({ path: `${OUT}/n04-nav-scrolled.png` });
  assert(wheelTop > 0, `wheel scrolls (${wheelTop})`);
  assert(keyboardTop > 0, `keyboard scrolls (${keyboardTop})`);
  assert(Math.abs(after.menu.y - before.menu.y) <= 1, 'Menu fixed');
  assert(Math.abs(after.brand.y - before.brand.y) <= 1, 'brand fixed');
  assert(Math.abs(after.settings.y - before.settings.y) <= 1, 'Settings fixed');
  assert(after.settings.bottom <= 561, 'Settings visible');
  assert(Math.abs(before.settings.height - before.levelOne) <= 1, 'Settings height equals level-1 height');
  await page.close();
  return { wheelTop, keyboardTop, settingsHeight: before.settings.height, levelOneHeight: before.levelOne };
});

await scenario('N05', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 560 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/blog/`);
  await openDrawer(page);
  await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
  await page.waitForTimeout(400);
  await page.mouse.move(1200, 300);
  const idle = await page.locator('[data-drawer-scroll]').evaluate((element) => getComputedStyle(element).scrollbarColor);
  const box = await page.locator('[data-drawer-scroll]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const hovered = await page.locator('[data-drawer-scroll]').evaluate((element) => getComputedStyle(element).scrollbarColor);
  assert(idle.includes('rgba(0, 0, 0, 0)'), `idle thumb transparent (${idle})`);
  assert(hovered !== idle, 'hover reveals the thumb');
  await page.close();

  const context = await browser.newContext({ viewport: { width: 390, height: 568 }, hasTouch: true, isMobile: true });
  const touchPage = await context.newPage();
  await touchPage.goto(`${BASE}/blog/`);
  await openDrawer(touchPage);
  await touchPage.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
  await touchPage.waitForTimeout(400);
  const scroll = touchPage.locator('[data-drawer-scroll]');
  const touchBox = await scroll.boundingBox();
  const x = touchBox.x + touchBox.width / 2;
  const startY = touchBox.y + touchBox.height - 40;
  const client = await context.newCDPSession(touchPage);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY, id: 1 }] });
  for (let step = 1; step <= 8; step += 1) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - step * 30, id: 1 }] });
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchPage.waitForTimeout(400);
  const touchTop = await scroll.evaluate((element) => element.scrollTop);
  const coarse = await touchPage.evaluate(() => matchMedia('(pointer: coarse)').matches);
  assert(touchTop > 0, `touch scrolls (${touchTop})`);
  await context.close();
  return { idle, hovered, touchTop, coarse };
});

// ---------------------------------------------------------------------------
// N06: exclusive branches
// ---------------------------------------------------------------------------
await scenario('N06', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/`);
  await openDrawer(page);
  const home = await page.evaluate(() => ({
    homeSections: document.querySelectorAll('.site-nav__sublist[aria-label="Home sections"] .site-nav__link').length,
    years: document.querySelectorAll('.site-nav__year-toggle').length,
    publicationsSublist: document.querySelectorAll(
      '.site-nav__group[data-nav-group="publications"] .site-nav__sublist',
    ).length,
  }));
  await page.goto(`${BASE}/publications/`);
  await openDrawer(page);
  const publications = await page.evaluate(() => ({
    current: [...document.querySelectorAll('nav[aria-label="Site"] [aria-current]')].map((element) => element.textContent?.trim()),
    sublists: document.querySelectorAll('.site-nav__sublist').length,
  }));
  await page.goto(`${BASE}/blog/`);
  await openDrawer(page);
  const blog = await page.evaluate(() => ({
    years: document.querySelectorAll('.site-nav__year-toggle').length,
    newCount: [...document.querySelectorAll('.site-nav__link')].filter((element) => element.textContent?.includes('New!')).length,
    visiblePosts: [...document.querySelectorAll('.site-nav__post-link')].filter((element) => element.getClientRects().length > 0).length,
  }));
  await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
  await page.waitForTimeout(200);
  await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
  await page.waitForTimeout(200);
  await page.mouse.move(1200, 700);
  const exclusive = await page.evaluate(() => ({
    expanded: [...document.querySelectorAll('.site-nav__year-toggle[aria-expanded="true"]')].map((element) => element.textContent?.trim()),
    visiblePosts: [...document.querySelectorAll('.site-nav__post-link')].filter((element) => element.getClientRects().length > 0).length,
    yearRows: document.querySelectorAll('.site-nav__year-toggle').length,
  }));
  await page.screenshot({ path: `${OUT}/n06-blog-year-exclusive.png` });
  assert(home.homeSections === 4 && home.years === 0 && home.publicationsSublist === 0, 'Home only');
  assert(publications.current.length === 1 && publications.current[0] === 'Publications' && publications.sublists === 0, 'Publications leaf');
  assert(blog.years === 2 && blog.newCount === 1 && blog.visiblePosts === 0, 'Blog branches collapsed');
  assert(exclusive.expanded.length === 1 && exclusive.expanded[0] === '2025' && exclusive.visiblePosts === 2 && exclusive.yearRows === 2, 'year exclusivity');
  await page.close();
  return { home, publications, blog, exclusive };
});

// ---------------------------------------------------------------------------
// N07: current/ancestor/hover + forced colors
// ---------------------------------------------------------------------------
await scenario('N07', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/blog/`);
  await openDrawer(page);
  const current = await page.locator('.site-nav__link--level-1', { hasText: 'Blog' }).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      weight: style.fontWeight,
      border: style.borderInlineStartColor,
      borderWidth: style.borderInlineStartWidth,
    };
  });
  const publications = page.locator('.site-nav__link--level-1', { hasText: 'Publications' });
  await publications.hover();
  await page.waitForTimeout(250);
  const hovered = await publications.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.goto(`${BASE}${POST_2026}`);
  await openDrawer(page);
  const ancestors = await page.evaluate(() =>
    [...document.querySelectorAll('.site-nav__item.is-current-ancestor > .site-nav__link, .site-nav__item.is-current > .site-nav__link')].map(
      (element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim(),
        background: getComputedStyle(element).backgroundColor,
        weight: getComputedStyle(element).fontWeight,
      }),
    ),
  );
  const currentCount = await page.locator('nav[aria-label="Site"] [aria-current]').count();
  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await page.locator('.site-nav__post-link[aria-current]').evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, width: style.outlineWidth };
  });
  await page.screenshot({ path: `${OUT}/n07-forced-colors.png` });
  assert(current.background === 'rgb(45, 45, 45)', `current background ${current.background}`);
  assert(current.weight === '600' && current.borderWidth === '3px', 'current weight + indicator');
  assert(hovered === 'rgb(45, 45, 45)', `hover background ${hovered}`);
  assert(ancestors.length === 3 && ancestors.every((entry) => entry.background === 'rgb(45, 45, 45)'), 'three overlaid levels on a post');
  assert(currentCount === 1, 'one aria-current');
  assert(forced.outline !== 'none' && Number.parseFloat(forced.width) > 0, 'forced-colors outline');
  await page.close();
  return { current, hovered, ancestors, currentCount, forced };
});

// ---------------------------------------------------------------------------
// N08: keyboard semantics
// ---------------------------------------------------------------------------
await scenario('N08', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/blog/`);
  await openDrawer(page);
  await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
  await page.waitForTimeout(200);
  const semantics = await page.evaluate(() => {
    const links = [...document.querySelectorAll('nav[aria-label="Site"] a')];
    return {
      links: links.length,
      tabbable: links.every((link) => link.tabIndex === 0),
      positiveTabindex: [...document.querySelectorAll('[tabindex]')].filter((element) => Number(element.getAttribute('tabindex')) > 0).length,
      treeRoles: document.querySelectorAll('[role="tree"], [role="treeitem"], [role="menu"], [role="menuitem"]').length,
      expanded: [...document.querySelectorAll('.site-nav__year-toggle')].map((element) => ({
        year: element.textContent?.trim(),
        value: element.getAttribute('aria-expanded'),
      })),
    };
  });
  await page.locator('.site-nav__link--level-1', { hasText: 'Publications' }).focus();
  await page.keyboard.press('Space');
  const spaceUrl = page.url();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  const enterUrl = page.url();
  assert(semantics.tabbable && semantics.links > 5, 'all nav links tabbable');
  assert(semantics.positiveTabindex === 0, 'no positive tabindex');
  assert(semantics.treeRoles === 0, 'no fake tree/menu roles');
  assert(semantics.expanded.find((entry) => entry.year === '2026')?.value === 'true', 'year aria-expanded true');
  assert(spaceUrl.endsWith('/blog/#year-2026'), `Space must not activate the link (${spaceUrl})`);
  assert(/\/publications\/$/.test(enterUrl), 'Enter activates the link');
  await page.close();
  return { ...semantics, spaceUrl, enterUrl };
});

// ---------------------------------------------------------------------------
// N09: marquee only for overflow
// ---------------------------------------------------------------------------
await scenario('N09', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}${POST_2026}`);
  await openDrawer(page);
  const label = page.locator('.site-nav__post-link:visible').first();
  const data = await label.evaluate((element) => ({
    text: element.textContent,
    overflow: element.getAttribute('data-overflow'),
    px: Number(element.getAttribute('data-overflow-px') ?? '0'),
    labelWidth: element.querySelector('[data-post-label]')?.clientWidth,
    fullWidth: element.querySelector('[data-post-label]')?.scrollWidth,
  }));
  assert(data.overflow === 'true' && data.px > 0, 'long label flagged as overflowing');
  assert((data.text ?? '').includes('Reading List for Spring-11.20'), 'full title in the DOM');
  await label.hover();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/n09-marquee-running.png` });
  const end = await (async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const state = await label.evaluate((element) => {
        const text = element.querySelector('.site-nav__post-text');
        const labelElement = element.querySelector('[data-post-label]');
        return {
          transform: text ? getComputedStyle(text).transform : 'none',
          diff: Math.abs((text?.getBoundingClientRect().right ?? 0) - (labelElement?.getBoundingClientRect().right ?? 0)),
        };
      });
      if (state.diff <= 2) return state;
      await page.waitForTimeout(100);
    }
    return label.evaluate((element) => {
      const text = element.querySelector('.site-nav__post-text');
      const labelElement = element.querySelector('[data-post-label]');
      return {
        transform: text ? getComputedStyle(text).transform : 'none',
        diff: Math.abs((text?.getBoundingClientRect().right ?? 0) - (labelElement?.getBoundingClientRect().right ?? 0)),
      };
    });
  })();
  assert(end.diff <= 2, `marquee reaches the end (${end.diff})`);
  await page.screenshot({ path: `${OUT}/n09-marquee-end.png` });
  await page.mouse.move(1200, 700);
  await page.waitForTimeout(200);
  const reset = await label.evaluate((element) => {
    const text = element.querySelector('.site-nav__post-text');
    return text ? getComputedStyle(text).transform : 'none';
  });
  assert(reset === 'none', 'leave resets the marquee');

  await page.goto(`${BASE}/`);
  await openDrawer(page);
  const short = page.locator('.site-nav__link', { hasText: 'Skills' });
  await short.hover();
  const shortTransform = await short.evaluate((element) => {
    const text = element.querySelector('.site-nav__label');
    return text ? getComputedStyle(text).transform : 'none';
  });
  assert(shortTransform === 'none', 'short label does not move');

  // At 1920 the same third-level labels fit; they must not be flagged or play.
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(`${BASE}${POST_2026}`);
  await openDrawer(page);
  const widePost = page.locator('.site-nav__post-link:visible').first();
  const wideData = await widePost.evaluate((element) => ({
    overflow: element.getAttribute('data-overflow'),
    labelWidth: element.querySelector('[data-post-label]')?.clientWidth,
    fullWidth: element.querySelector('[data-post-label]')?.scrollWidth,
  }));
  await widePost.hover();
  await page.waitForTimeout(250);
  const wideTransform = await widePost.evaluate((element) => {
    const text = element.querySelector('.site-nav__post-text');
    return text ? getComputedStyle(text).transform : 'none';
  });
  assert(wideData.overflow === null, `fitting third-level label is not flagged (${wideData.fullWidth}/${wideData.labelWidth})`);
  assert(wideTransform === 'none', 'fitting third-level label does not move');
  await page.close();
  return { data, end, reset, shortTransform, wideData, wideTransform };
});

// ---------------------------------------------------------------------------
// N10: preview card
// ---------------------------------------------------------------------------
await scenario('N10', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}${POST_2026}`);
  await openDrawer(page);
  await page.evaluate(() => {
    const title = document.querySelector('.nav-preview__title');
    if (title) {
      title.textContent =
        'A deliberately long article title that keeps going well past three lines so the preview card has to clamp it with an ellipsis while the full title still lives in the navigation link';
    }
  });
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => Boolean(document.activeElement?.closest('.site-nav__post-link')))) break;
  }
  await page.waitForTimeout(200);
  const card = page.locator('.nav-preview[data-open="true"]');
  const geometry = await card.evaluate((element) => {
    const title = element.querySelector('.nav-preview__title');
    const date = element.querySelector('.nav-preview__date');
    const rect = element.getBoundingClientRect();
    return {
      rect: rect.toJSON(),
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5,
      titleHeight: title?.clientHeight,
      titleScroll: title?.scrollHeight,
      lineHeight: title ? Number.parseFloat(getComputedStyle(title).lineHeight) : 0,
      clamp: title ? getComputedStyle(title).webkitLineClamp : '',
      titleFont: title ? getComputedStyle(title).fontSize : '',
      dateText: date?.textContent,
      dateFont: date ? getComputedStyle(date).fontSize : '',
      focusOnLink: Boolean(document.activeElement?.closest('.site-nav__post-link')),
    };
  });
  await page.screenshot({ path: `${OUT}/n10-preview-desktop.png` });
  assert(geometry.inViewport, 'card inside viewport');
  assert(geometry.clamp === '3' && (geometry.titleHeight ?? 0) <= (geometry.lineHeight ?? 0) * 3 + 1, 'title clamps to 3 lines');
  assert((geometry.titleScroll ?? 0) > (geometry.titleHeight ?? 0), 'title is actually truncated');
  assert(geometry.dateText === '2026-11-20 08:40' && Number.parseFloat(geometry.dateFont) < Number.parseFloat(geometry.titleFont), 'date complete and smaller');
  assert(geometry.focusOnLink, 'focus stays on the link');
  await page.locator('.site-nav__post-link:visible').nth(1).click();
  await page.waitForTimeout(300);
  const navigated = page.url();
  assert(/Why%20I%20Keep/.test(navigated), 'clicking the link navigates');
  await page.close();

  const narrow = await newPage({ viewport: { width: 320, height: 568 }, colorScheme: 'dark' });
  await narrow.goto(`${BASE}${POST_2026}`);
  await openDrawer(narrow);
  for (let index = 0; index < 40; index += 1) {
    await narrow.keyboard.press('Tab');
    if (await narrow.evaluate(() => Boolean(document.activeElement?.closest('.site-nav__post-link')))) break;
  }
  await narrow.waitForTimeout(200);
  const narrowGeometry = await narrow.locator('.nav-preview[data-open="true"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      rect: rect.toJSON(),
      fits: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5,
    };
  });
  await narrow.screenshot({ path: `${OUT}/n10-preview-320.png` });
  assert(narrowGeometry.fits, `320 card fits: ${JSON.stringify(narrowGeometry.rect)}`);
  await narrow.close();
  return { geometry, navigated, narrowGeometry };
});

// ---------------------------------------------------------------------------
// N11: reduced motion
// ---------------------------------------------------------------------------
await scenario('N11', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto(`${BASE}/blog/`);
  await page.getByRole('button', { name: 'Menu' }).click();
  const opened = await navState(page);
  const transition = await page.locator('#site-drawer').evaluate((element) => {
    const style = getComputedStyle(element);
    return { duration: style.transitionDuration, property: style.transitionProperty };
  });
  await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
  await page.waitForTimeout(200);
  const post = page.locator('.site-nav__post-link:visible').first();
  await post.focus();
  const marquee = await post.evaluate((element) => {
    const text = element.querySelector('.site-nav__post-text');
    return { transform: text ? getComputedStyle(text).transform : 'none', overflow: element.getAttribute('data-overflow') };
  });
  const scrollBehavior = await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
  await page.screenshot({ path: `${OUT}/n11-reduced-motion-open.png` });
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.waitForTimeout(100);
  const closed = await navState(page);
  assert(opened.drawer.visibility === 'visible' && opened.drawer.transform.includes('matrix(1, 0, 0, 1, 0, 0)'), 'drawer at final open state immediately');
  assert(/^0s(, 0s)*$/.test(transition.duration), `transition duration 0 (${transition.duration})`);
  assert(marquee.transform === 'none', 'no marquee under reduced motion');
  assert(scrollBehavior === 'auto', 'no smooth scrolling');
  assert(closed.open === 'false' && closed.drawer.visibility === 'hidden', 'close reaches final state');
  await page.close();
  return { transition, marquee, scrollBehavior, closedVisibility: closed.drawer.visibility };
});

// ---------------------------------------------------------------------------
// N12: 320 / 200% / coarse
// ---------------------------------------------------------------------------
await scenario('N12', async () => {
  const page = await newPage({ viewport: { width: 320, height: 568 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/blog/`);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await page.waitForTimeout(200);
  await openDrawer(page);
  await page.locator('.site-nav__year-toggle', { hasText: '2026' }).click();
  await page.waitForTimeout(400);
  await page.locator('[data-drawer-scroll]').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  const metrics = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.site-nav__link, [data-drawer-close]')].filter(
      (element) => element.getClientRects().length > 0,
    );
    const boxes = links.map((element) => element.getBoundingClientRect().toJSON());
    const rows = [...document.querySelectorAll('.site-nav__link')].filter((element) => element.getClientRects().length > 0);
    let overlap = false;
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index - 1].getBoundingClientRect().bottom > rows[index].getBoundingClientRect().top + 1) overlap = true;
    }
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      minTarget: Math.min(...boxes.map((box) => Math.min(box.width, box.height))),
      overlap,
      settings: document.querySelector('[data-settings-slot]')?.getBoundingClientRect().height,
      levelOne: document.querySelector('.site-nav__link--level-1')?.getBoundingClientRect().height,
      coarse: matchMedia('(pointer: coarse)').matches,
    };
  });
  await page.screenshot({ path: `${OUT}/n12-320-200-open.png` });
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, 'no horizontal overflow');
  assert(metrics.minTarget >= 44, `targets >=44 (${metrics.minTarget})`);
  assert(!metrics.overlap, 'no overlapping rows');
  assert(Math.abs(metrics.settings - metrics.levelOne) <= 1, 'Settings equals level-1 height');
  await page.close();
  return metrics;
});

// ---------------------------------------------------------------------------
// N13: fallback (no reliance on new APIs) and N14: translation re-measure
// ---------------------------------------------------------------------------
await scenario('N14', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  await page.goto(`${BASE}${POST_2026}`);
  await openDrawer(page);
  const before = await page.locator('.site-nav__post-link').first().evaluate((element) => ({
    overflow: element.getAttribute('data-overflow'),
    px: Number(element.getAttribute('data-overflow-px') ?? '0'),
  }));
  await page.evaluate(() => {
    const text = document.querySelector('.site-nav__post-text');
    if (text) text.textContent = 'Reading List for Spring, translated into a much longer label that keeps going-11.20';
    for (const label of document.querySelectorAll('.site-nav__link--level-1 > .site-nav__label')) {
      if (label.textContent === 'Publications') label.textContent = 'Publications and Preprints';
      if (label.textContent === 'Blog') label.textContent = 'Writing and Notes';
    }
  });
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.site-nav__link')].filter((element) => element.getClientRects().length > 0);
    let overlap = false;
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index - 1].getBoundingClientRect().bottom > rows[index].getBoundingClientRect().top + 1) overlap = true;
    }
    const first = document.querySelector('.site-nav__post-link');
    return {
      px: Number(first?.getAttribute('data-overflow-px') ?? '0'),
      overflow: first?.getAttribute('data-overflow'),
      overlap,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      allRealText: [...document.querySelectorAll('.site-nav__label')].every((element) => (element.textContent ?? '').trim().length > 0),
    };
  });
  await page.screenshot({ path: `${OUT}/n14-translated-labels.png` });
  assert(after.overflow === 'true' && after.px > before.px, `overflow re-measured (${before.px} -> ${after.px})`);
  assert(!after.overlap, 'no overlap after translation');
  assert(after.scrollWidth <= after.clientWidth + 1, 'no horizontal overflow after translation');
  assert(after.allRealText, 'labels remain real DOM text');
  await page.close();
  return { before, after };
}, 'LIMITED');

await scenario('N13', async () => {
  const page = await newPage({ viewport: { width: 1280, height: 700 }, colorScheme: 'dark' });
  await page.goto(`${BASE}/`);
  const support = await page.evaluate(() => ({
    scrollTargetGroup: CSS.supports('scroll-target-group: auto'),
    anchorPositioning: CSS.supports('anchor-name: --a'),
    interestInvokers: 'interestForElement' in HTMLAnchorElement.prototype,
    interestAttributes: document.querySelectorAll('[interestfor]').length,
    popoverAttributes: document.querySelectorAll('[popover]').length,
    anchorStyles: [...document.querySelectorAll('[style]')].filter((element) => (element.getAttribute('style') ?? '').includes('anchor-name')).length,
  }));
  await openDrawer(page);
  await page.locator('.site-nav__link--level-2', { hasText: 'Education' }).click();
  await page.waitForTimeout(700);
  const current = await navState(page);
  await page.goto(`${BASE}${POST_2026}`);
  await openDrawer(page);
  for (let index = 0; index < 30; index += 1) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => Boolean(document.activeElement?.closest('.site-nav__post-link')))) break;
  }
  await page.waitForTimeout(200);
  const previewCount = await page.locator('.nav-preview[data-open="true"]').count();
  assert(support.interestAttributes === 0 && support.popoverAttributes === 0 && support.anchorStyles === 0, 'no new-API attributes');
  assert(current.current.length === 1, 'scrollspy works through the JS path');
  assert(previewCount === 1, 'preview works without Interest Invokers/Anchor Positioning');
  await page.close();
  return { support, current: current.current, previewCount };
}, 'LIMITED');

writeFileSync(`${OUT}/verify-03-results.json`, JSON.stringify({ base: BASE, checkedAt: new Date().toISOString(), results }, null, 2));
const failed = results.filter((entry) => entry.status === 'FAIL');
const limited = results.filter((entry) => entry.status === 'LIMITED');
await browser.close();
console.log(`\n${results.length - failed.length - limited.length}/${results.length} criteria PASS, ${limited.length} LIMITED, ${failed.length} FAIL`);
console.log('LIMITED: N13 (no Firefox/Safari/unsupported-API run), N14 (DOM-simulated translation, not the browser translation UI)');
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((entry) => entry.id).join(', ')}`);
  process.exitCode = 1;
}
