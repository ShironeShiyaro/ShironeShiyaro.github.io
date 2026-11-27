import { expect, test, type Page } from '@playwright/test';

interface ShellGeometry {
  viewport: number;
  clientWidth: number;
  scrollWidth: number;
  bodyScrollWidth: number;
  main: { x: number; width: number; center: number };
  footer: { x: number; width: number };
  drawerRight: number;
  drawerTop: number;
  drawerVisibility: string;
  drawerTransform: string;
  mainInert: boolean;
}

async function readShellGeometry(page: Page): Promise<ShellGeometry> {
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const footer = document.querySelector('footer');
    const drawer = document.querySelector('.site-drawer');
    if (!main || !footer || !drawer) throw new Error('shell elements are missing');
    const mainRect = main.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const drawerRect = drawer.getBoundingClientRect();
    const drawerStyle = getComputedStyle(drawer);
    return {
      viewport: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      main: {
        x: mainRect.x,
        width: mainRect.width,
        center: mainRect.x + mainRect.width / 2,
      },
      footer: { x: footerRect.x, width: footerRect.width },
      drawerRight: drawerRect.right,
      drawerTop: drawerRect.top,
      drawerVisibility: drawerStyle.visibility,
      drawerTransform: drawerStyle.transform,
      mainInert: main.hasAttribute('inert'),
    };
  });
}

function expectNoPageOverflow(geometry: ShellGeometry, label: string): void {
  expect(geometry.scrollWidth, `${label}: documentElement.scrollWidth`).toBeLessThanOrEqual(
    geometry.clientWidth + 1,
  );
  expect(geometry.bodyScrollWidth, `${label}: body.scrollWidth`).toBeLessThanOrEqual(
    geometry.clientWidth + 1,
  );
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'visible');
}

test('desktop drawer slides in, shifts the article container and restores it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const closed = await readShellGeometry(page);
  expect(closed.drawerVisibility, 'closed drawer visibility').toBe('hidden');
  expect(closed.main.width / closed.viewport, 'closed: article width ratio').toBeGreaterThanOrEqual(0.58);
  expect(closed.main.width / closed.viewport, 'closed: article width ratio').toBeLessThanOrEqual(0.6);
  expect(closed.main.center / closed.viewport, 'closed: article center ratio').toBeGreaterThanOrEqual(0.49);
  expect(closed.main.center / closed.viewport, 'closed: article center ratio').toBeLessThanOrEqual(0.51);
  expectNoPageOverflow(closed, 'closed');

  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'visible');
  // The transform must travel through an intermediate state, and the closed
  // state must not leak into the open layout.
  await expect(page.locator('#site-drawer')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect
    .poll(async () => (await readShellGeometry(page)).main.center, { timeout: 5000 })
    .toBeGreaterThan(closed.main.center + 80);
  const open = await readShellGeometry(page);

  expect(open.main.width / open.viewport, 'open: article width ratio').toBeGreaterThanOrEqual(0.58);
  expect(open.main.width / open.viewport, 'open: article width ratio').toBeLessThanOrEqual(0.6);
  expect(open.main.center / open.viewport, 'open: article center ratio').toBeGreaterThanOrEqual(0.585);
  expect(open.main.center / open.viewport, 'open: article center ratio').toBeLessThanOrEqual(0.605);
  expect(open.main.x, 'open: article starts right of the drawer').toBeGreaterThanOrEqual(open.drawerRight - 1);
  expect(Math.abs(open.footer.x - open.main.x), 'open: footer aligns with article').toBeLessThanOrEqual(1);
  expect(Math.abs(open.footer.width - open.main.width), 'open: footer width matches article').toBeLessThanOrEqual(1);
  expect(open.mainInert, 'wide drawer is not modal').toBe(false);
  expectNoPageOverflow(open, 'open');

  // Article content stays interactive while the wide drawer is open.
  await expect(page.locator('main h1')).toBeVisible();
  await page.locator('main h1').click();

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'hidden');
  const closedAgain = await readShellGeometry(page);
  expect(Math.abs(closedAgain.main.x - closed.main.x), 'closed: article returns').toBeLessThanOrEqual(1);
  expectNoPageOverflow(closedAgain, 'closed again');
});

test('closed desktop drawer is hidden from focus and the tab order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/publications/');
  await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('#site-drawer')).toHaveAttribute('inert', '');

  const programmaticFocus = await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('.site-nav__link');
    if (!link) throw new Error('navigation link is missing');
    link.focus();
    return document.activeElement === link;
  });
  expect(programmaticFocus, 'closed drawer link must not accept programmatic focus').toBe(false);

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const visited: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press('Tab');
    visited.push(
      await page.evaluate(() => (typeof document.activeElement?.className === 'string' ? document.activeElement.className : '')),
    );
  }
  expect(
    visited.some((entry) => entry.includes('site-nav__link')),
    `closed drawer must not be tabbable: ${JSON.stringify(visited)}`,
  ).toBe(false);
  expect(visited.some((entry) => entry.includes('skip-link'))).toBe(true);

  await openDrawer(page);
  const drawerLinkFocusable = await page.evaluate(() => {
    const link = document.querySelector<HTMLAnchorElement>('.site-nav__link');
    if (!link) return false;
    link.focus();
    return document.activeElement === link;
  });
  expect(drawerLinkFocusable, 'open drawer link accepts focus').toBe(true);
});

test('narrow drawer is an overlay with a backdrop and never shifts the article', async ({ page }) => {
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 568 });
    await page.goto('/');
    const closed = await readShellGeometry(page);
    expect(closed.main.width, `${width}: article width closed`).toBeCloseTo(width, 0);
    expect(closed.main.x, `${width}: article start closed`).toBeCloseTo(0, 0);
    expect(closed.drawerVisibility, `${width}: closed drawer hidden`).toBe('hidden');
    expectNoPageOverflow(closed, `${width}: closed`);

    await openDrawer(page);
    const open = await readShellGeometry(page);
    expect(open.main.width, `${width}: article width unchanged`).toBeCloseTo(width, 0);
    expect(open.main.x, `${width}: article start unchanged`).toBeCloseTo(0, 0);
    expect(open.drawerTop, `${width}: drawer starts below the fixed top bar`).toBeGreaterThanOrEqual(84);
    expect(open.drawerRight, `${width}: drawer leaves a backdrop strip`).toBeLessThan(width);
    await expect(page.locator('[data-drawer-backdrop]')).toHaveCSS('visibility', 'visible');
    await expect(page.locator('[data-drawer-backdrop]')).toHaveCSS('pointer-events', 'auto');
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    expectNoPageOverflow(open, `${width}: open`);

    await page.keyboard.press('Escape');
    await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'hidden');
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  }
});
