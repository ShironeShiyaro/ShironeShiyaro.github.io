import { expect, type Page } from '@playwright/test';

export interface PageExpectation {
  path: string;
  h1: string;
}

export async function assertUniqueMainAndLandmarks(page: Page): Promise<void> {
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.locator('main')).toHaveAttribute('id', 'content');
  await expect(page.locator('header')).toHaveCount(1);
  await expect(page.locator('footer')).toHaveCount(1);
  // The drawer is closed by default on narrow screens, so the Site nav is in
  // the DOM but intentionally inert. Include hidden elements so this remains a
  // role-based landmark assertion in every state; task 03's navigation suite
  // opens the drawer and asserts the visible navigation landmark separately.
  await expect(page.getByRole('navigation', { name: 'Site', includeHidden: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(1);

  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds, 'duplicate element ids').toEqual([]);
}

export async function assertHeadingStructure(page: Page, expectedH1: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(expectedH1);

  const levels = await page.evaluate(() =>
    [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) =>
      Number(heading.tagName.slice(1)),
    ),
  );
  expect(levels[0], 'first heading is h1').toBe(1);
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1] ?? 1;
    const current = levels[index] ?? previous;
    expect(current - previous, `heading level jump at index ${index}`).toBeLessThanOrEqual(1);
  }
}

export async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document, `${label}: document scrollWidth`).toBeLessThanOrEqual(widths.client + 1);
  expect(widths.body, `${label}: body scrollWidth`).toBeLessThanOrEqual(widths.client + 1);
}

/**
 * Simulates 200% text by doubling the root font size. This checks reflow under
 * scaled text; it is not the browser's text-only zoom setting, so the result is
 * recorded as a root-font-size simulation rather than a full zoom test.
 */
export async function assertTextScaleReflow(page: Page, label: string): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  const bodyFontSize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize));
  expect(bodyFontSize, `${label}: body font-size after 200% root font`).toBeGreaterThan(24);
  await assertNoHorizontalOverflow(page, `${label} at 200% text`);
}

export async function assertSkipLinkAndFocus(page: Page): Promise<void> {
  await page.keyboard.press('Tab');
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skipLink).toBeFocused();
  const outline = await skipLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style, 'skip link focus outline style').not.toBe('none');
  expect(outline.width, 'skip link focus outline width').toBeGreaterThan(0);
  await skipLink.press('Enter');
  await expect(page.locator('#content')).toBeFocused();
}

export async function assertPageAtNarrowViewport(page: Page, expectation: PageExpectation): Promise<void> {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(expectation.path);
  await assertUniqueMainAndLandmarks(page);
  await assertHeadingStructure(page, expectation.h1);
  await assertNoHorizontalOverflow(page, `${expectation.path} at 320px`);
  await assertTextScaleReflow(page, expectation.path);
}
