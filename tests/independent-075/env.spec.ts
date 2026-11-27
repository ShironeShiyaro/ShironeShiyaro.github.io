import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { AUTHOR_URL, SITE_URL, openAnonymous, resetEnvironment, screenshot, writeEvidence } from './helpers';

test('the two origins are up with the configured cross-origin shell marker', async ({ page, request }) => {
  await resetEnvironment(request);
  await page.goto(`${SITE_URL}/blog/`);
  await expect(page.locator('.top-bar')).toBeVisible();
  const newHref = await page
    .locator('.site-nav a[href*="/new/"]')
    .first()
    .getAttribute('href');
  expect(newHref, 'public site New! points at the author origin').toBe(`${AUTHOR_URL}/new/`);

  await openAnonymous(page);
  await screenshot(page, 'env-author-gate.png');
  writeEvidence('env.json', {
    site: SITE_URL,
    author: AUTHOR_URL,
    newHref,
    title: await page.title(),
  });
});

test('the real Astro X04 fixture build produced both probe articles', async () => {
  const built = JSON.parse(
    readFileSync(join(process.env.INDEP_TMP ?? '', 'x04-build.json'), 'utf8'),
  ) as { markdown: string; articleHtml: string; sanitizeHtml: string };
  expect(built.markdown).toContain('Hard break with two spaces  ');
  expect(built.articleHtml).toContain('post__body');
  expect(built.sanitizeHtml).toContain('Visible paragraph.');
});
