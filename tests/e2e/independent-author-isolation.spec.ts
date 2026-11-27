import { expect, test } from '@playwright/test';

const AUTHOR_ORIGIN = process.env.INDEP_AUTHOR_ORIGIN ?? 'https://indep-author.invalid';

/**
 * A01: a public visitor reading Home/Blog/Publications must never trigger the
 * author Worker or an auth request. This spec runs against a static Astro
 * preview only; no author Worker is started for this probe.
 */
test('A01 public pages render without any author/auth request or session cookie', async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  const pages = [
    { path: '/', heading: 'Home' },
    { path: '/publications/', heading: 'Selected Publications' },
    { path: '/blog/', heading: 'Blog' },
  ] as const;

  for (const entry of pages) {
    const response = await page.goto(entry.path);
    expect(response?.status(), entry.path).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: entry.heading })).toBeVisible();
    await page.waitForTimeout(1_500);
  }

  const authorRequests = requests.filter(
    (url) =>
      url.startsWith(AUTHOR_ORIGIN) ||
      url.includes('/auth/github/start') ||
      url.includes('/auth/github/callback') ||
      url.includes('/api/session'),
  );
  expect(authorRequests, authorRequests.join('\n')).toEqual([]);

  const cookies = await context.cookies();
  expect(cookies.filter((cookie) => cookie.name === 'sp_session')).toEqual([]);
  const documentCookie = await page.evaluate(() => document.cookie);
  expect(documentCookie).not.toContain('sp_session');
});
