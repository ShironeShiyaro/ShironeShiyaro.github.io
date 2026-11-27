import { expect, test, type Page } from '@playwright/test';
import {
  assertPageAtNarrowViewport,
  assertSkipLinkAndFocus,
  type PageExpectation,
} from './helpers';

const postPath = '/blog/2025/Building%20a%20Quiet%20Homepage-2025-03-14-09-30-00/';

const pages: PageExpectation[] = [
  { path: '/', h1: 'Home' },
  { path: '/publications/', h1: 'Selected Publications' },
  { path: '/blog/', h1: 'Blog' },
  { path: postPath, h1: 'Building a Quiet Homepage' },
  { path: '/settings/', h1: 'Settings' },
];

async function openSiteNav(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(page.getByRole('navigation', { name: 'Site' })).toBeVisible();
}

test('public pages render from the static build', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page).toHaveTitle("Home | Xinyang Zeng's Homepage");
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  await openSiteNav(page);
  await expect(page.getByRole('heading', { level: 2, name: 'About Me' })).toBeVisible();

  await page.getByRole('link', { name: 'Publications', exact: true }).click();
  await expect(page).toHaveURL(/\/publications\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Selected Publications' })).toBeVisible();
  await expect(page.getByText('Paper: to be public')).toHaveCount(1);
  await expect(page.getByText('Paper: to be public')).toBeVisible();
  await expect(page.getByText('Code: to be public')).toHaveCount(2);
  await expect(page.getByText('Code: to be public').first()).toBeVisible();

  await openSiteNav(page);
  await page.getByRole('link', { name: 'Blog', exact: true }).click();
  await expect(page).toHaveURL(/\/blog\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Blog' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['2026', '2025']);
  await expect(page.getByRole('heading', { level: 3 })).toHaveText(['November', 'January', 'November', 'March']);
  await expect(page.locator('#year-2026')).toBeVisible();
  await expect(page.locator('main time[datetime="2026-11-20T08:40"]').first()).toHaveText(
    '2026-11-20 08:40',
  );

  await page.getByRole('link', { name: /Building a Quiet Homepage/ }).click();
  await expect(page).toHaveURL(/\/blog\/2025\/Building%20a%20Quiet%20Homepage-/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Building a Quiet Homepage');
  await expect(page.locator('main time[datetime="2025-03-14T09:30"]').first()).toHaveText(
    '2025-03-14 09:30',
  );

  expect(pageErrors).toEqual([]);
});

test('every public page has one main, landmarks, a sane heading order and unique ids', async ({ page }) => {
  for (const expectation of pages) {
    await assertPageAtNarrowViewport(page, expectation);
  }
});

test('skip link moves keyboard focus to main content with a visible focus ring', async ({ page }) => {
  await page.goto('/');
  await assertSkipLinkAndFocus(page);
});
