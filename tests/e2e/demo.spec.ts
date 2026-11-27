import { expect, test } from '@playwright/test';
import {
  assertHeadingStructure,
  assertNoHorizontalOverflow,
  assertSkipLinkAndFocus,
  assertTextScaleReflow,
  assertUniqueMainAndLandmarks,
} from './helpers';

const base = process.env.E2E_BASE_URL ?? '';

const pages = [
  { path: '', h1: 'Home' },
  { path: 'publications/', h1: 'Selected Publications' },
  { path: 'blog/', h1: 'Blog' },
  {
    path: 'blog/2025/Building%20a%20Quiet%20Homepage-2025-03-14-09-30-00/',
    h1: 'Building a Quiet Homepage',
  },
];

test('demo base pages keep the base path and pass the same structure/reflow checks', async ({ page }) => {
  expect(base, 'E2E_BASE_URL must end with /demo/').toMatch(/\/demo\/$/);
  for (const expectation of pages) {
    const url = new URL(expectation.path, base).href;
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(url);
    await assertUniqueMainAndLandmarks(page);
    await assertHeadingStructure(page, expectation.h1);
    await assertNoHorizontalOverflow(page, `${url} at 320px`);
    await assertTextScaleReflow(page, url);

    const internalHrefs = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((anchor) => anchor.getAttribute('href') ?? '')
        .filter((href) => href.startsWith('/')),
    );
    for (const href of internalHrefs) {
      expect(href, `${url}: internal link uses /demo/ once`).toMatch(/^\/demo\//);
    }
  }
});

test('demo base skip link and focus ring work', async ({ page }) => {
  expect(base, 'E2E_BASE_URL must end with /demo/').toMatch(/\/demo\/$/);
  await page.goto(base);
  await assertSkipLinkAndFocus(page);
});
