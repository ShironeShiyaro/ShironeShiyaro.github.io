import { expect, test, type Page } from '@playwright/test';

const POSTS = [
  {
    year: '2026',
    title: 'Reading List for Spring',
    date: '2026-11-20',
    shortDate: '11.20',
    time: '08:40',
    displayDate: '2026-11-20 08:40',
    displayShortDate: '11.20 08:40',
    href: '/blog/2026/Reading%20List%20for%20Spring-2026-11-20-08-40-00/',
  },
  {
    year: '2026',
    title: 'Why I Keep a Learning Log',
    date: '2026-01-18',
    shortDate: '01.18',
    time: '20:15',
    displayDate: '2026-01-18 20:15',
    displayShortDate: '01.18 20:15',
    href: '/blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/',
  },
  {
    year: '2025',
    title: 'Notes on Accessible Navigation',
    date: '2025-11-02',
    shortDate: '11.02',
    time: '14:05',
    displayDate: '2025-11-02 14:05',
    displayShortDate: '11.02 14:05',
    href: '/blog/2025/Notes%20on%20Accessible%20Navigation-2025-11-02-14-05-00/',
  },
  {
    year: '2025',
    title: 'Building a Quiet Homepage',
    date: '2025-03-14',
    shortDate: '03.14',
    time: '09:30',
    displayDate: '2025-03-14 09:30',
    displayShortDate: '03.14 09:30',
    href: '/blog/2025/Building%20a%20Quiet%20Homepage-2025-03-14-09-30-00/',
  },
] as const;

/** Human-readable sidebar label: `{title}-{MM.DD HH:mm}` (D35). */
function sidebarLabel(post: (typeof POSTS)[number]): string {
  return `${post.title}-${post.displayShortDate}`;
}

const POST_2026 = POSTS[0].href;
const POST_2025 = POSTS[2].href;
const POST_BUILDING = POSTS[3].href;

async function openDrawer(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#site-drawer')).toHaveCSS('visibility', 'visible');
}

async function currentEntries(page: Page): Promise<Array<{ text: string; value: string }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Site"] [aria-current]')].map((element) => ({
      text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      value: element.getAttribute('aria-current') ?? '',
    })),
  );
}

async function expectOnlyYearCurrent(page: Page, year: string): Promise<void> {
  await expect
    .poll(async () => (await currentEntries(page)).map((entry) => entry.text))
    .toEqual([year]);
  const entries = await currentEntries(page);
  expect(entries[0]?.value).toBe('location');
}

async function expandedYears(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.site-nav__year-toggle[aria-expanded="true"]')].map(
      (element) => element.textContent?.trim() ?? '',
    ),
  );
}

async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document, `${label}: document scrollWidth`).toBeLessThanOrEqual(widths.client + 1);
  expect(widths.body, `${label}: body scrollWidth`).toBeLessThanOrEqual(widths.client + 1);
}

test.describe('Blog archive directory', () => {
  test('years, months and posts are newest-first with full dates and real links', async ({ page }) => {
    await page.goto('/blog/');
    await expect(page.getByRole('heading', { level: 1, name: 'Blog' })).toHaveCount(1);
    await expect(page.locator('main h2')).toHaveText(['2026', '2025']);
    await expect(page.locator('main h3')).toHaveText(['November', 'January', 'November', 'March']);
    await expect(page.locator('main h1')).toHaveCount(1);

    const groups = await page.evaluate(() =>
      [...document.querySelectorAll('main .blog-year-group')].map((year) => ({
        year: year.querySelector('h2')?.textContent?.trim() ?? '',
        months: [...year.querySelectorAll('.blog-month-group')].map((month) => ({
          label: month.querySelector('h3')?.textContent?.trim() ?? '',
          posts: [...month.querySelectorAll('.blog-post')].map((link) => ({
            title: link.querySelector('.blog-post__title')?.textContent?.trim() ?? '',
            date: link.querySelector('time')?.textContent?.trim() ?? '',
            datetime: link.querySelector('time')?.getAttribute('datetime') ?? '',
            href: link.getAttribute('href') ?? '',
          })),
        })),
      })),
    );

    expect(groups.map((group) => group.year)).toEqual(['2026', '2025']);
    expect(groups[0]?.months.map((month) => month.label)).toEqual(['November', 'January']);
    expect(groups[1]?.months.map((month) => month.label)).toEqual(['November', 'March']);

    // The outer classes must not collide with content.css's legacy
    // `.blog-year`/`.blog-month` rules, which would inflate post titles.
    await expect(page.locator('main .blog-year, main .blog-month')).toHaveCount(0);
    const typography = await page.evaluate(() => ({
      month: Number.parseFloat(getComputedStyle(document.querySelector('.blog-month__title') ?? document.body).fontSize),
      title: Number.parseFloat(getComputedStyle(document.querySelector('.blog-post__title') ?? document.body).fontSize),
      date: Number.parseFloat(getComputedStyle(document.querySelector('.blog-post__date') ?? document.body).fontSize),
    }));
    expect(typography.title, 'post title uses the body size, not the month size').toBeLessThan(typography.month);
    expect(typography.date).toBeLessThan(typography.title);

    const flattened = groups.flatMap((group) =>
      group.months.flatMap((month) => month.posts.map((post) => ({ ...post, year: group.year }))),
    );
    expect(flattened).toEqual(
      POSTS.map((post) => ({
        title: post.title,
        date: post.displayDate,
        datetime: `${post.date}T${post.time}`,
        href: post.href,
        year: post.year,
      })),
    );

    // Every directory link is a real page whose H1 and visible date (with the
    // file-name time, D35) agree with the archive.
    for (const post of POSTS) {
      const response = await page.request.get(post.href);
      expect(response.status(), `${post.href} status`).toBe(200);
      await page.goto(post.href);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(post.title);
      await expect(page.locator('article .post-date time')).toHaveAttribute(
        'datetime',
        `${post.date}T${post.time}`,
      );
      await expect(page.locator('article .post-date time')).toHaveText(post.displayDate);
    }
  });

  test('months never enter the sidebar; New! is first and has no third level', async ({ page }) => {
    await page.goto('/blog/');
    await openDrawer(page);

    const blogList = page.locator('.site-nav__sublist[aria-label="Blog"]');
    await expect(blogList).toHaveCount(1);
    const firstItem = blogList.locator(':scope > li').first();
    await expect(firstItem.locator('a')).toContainText('New!');
    await expect(firstItem.locator('.site-nav__sublist')).toHaveCount(0);
    await expect(blogList.locator(':scope > li')).toHaveCount(3);

    const newHref = await firstItem.locator('a').getAttribute('href');
    expect(newHref, 'New! href').toBeTruthy();
    const newUrl = new URL(newHref ?? 'http://invalid.example');
    expect(newUrl.pathname).toBe('/new/');
    expect(newUrl.origin).not.toBe(new URL(page.url()).origin);
    const expectedOrigin = process.env.E2E_AUTHOR_ORIGIN;
    if (expectedOrigin) expect(newUrl.origin).toBe(expectedOrigin);

    const yearLinks = page.locator('.site-nav__year-toggle');
    await expect(yearLinks).toHaveCount(2);
    await expect(yearLinks).toHaveText(['2026', '2025']);
    const navText = await page.locator('.site-nav').innerText();
    for (const month of ['November', 'January', 'March']) {
      expect(navText, `sidebar must not contain month ${month}`).not.toContain(month);
    }

    // No month layer appears under a year either.
    await yearLinks.first().click();
    await expect(page.locator('.site-nav__sublist--posts:not([hidden]) .site-nav__post-link')).toHaveCount(2);
    const visibleLabels = await page.evaluate(() =>
      [...document.querySelectorAll('.site-nav__sublist--posts:not([hidden]) .site-nav__post-link')].map(
        (link) => link.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      ),
    );
    expect(visibleLabels).toEqual(['Reading List for Spring-11.20 08:40', 'Why I Keep a Learning Log-01.18 20:15']);
  });

  test('clicking a year expands only that year, updates the hash and keeps one current item', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);

    const year2026 = page.locator('.site-nav__year-toggle', { hasText: '2026' });
    const year2025 = page.locator('.site-nav__year-toggle', { hasText: '2025' });

    await year2026.click();
    await expect(page).toHaveURL(/\/blog\/#year-2026$/);
    await expect(year2026).toHaveAttribute('aria-expanded', 'true');
    await expect(year2025).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.site-nav__sublist--posts:not([hidden]) .site-nav__post-link')).toHaveCount(2);
    await expectOnlyYearCurrent(page, '2026');
    expect(await expandedYears(page)).toEqual(['2026']);

    await year2025.click();
    await expect(page).toHaveURL(/\/blog\/#year-2025$/);
    await expect(year2025).toHaveAttribute('aria-expanded', 'true');
    await expect(year2026).toHaveAttribute('aria-expanded', 'false');
    await expectOnlyYearCurrent(page, '2025');
    expect(await expandedYears(page)).toEqual(['2025']);

    const geometry = await page.evaluate(() => {
      const topBar = document.querySelector('.top-bar')?.getBoundingClientRect();
      const target = document.getElementById('year-2025')?.getBoundingClientRect();
      return topBar && target ? { topBarBottom: topBar.bottom, targetTop: target.top } : null;
    });
    expect(geometry, 'year-2025 target exists').not.toBeNull();
    expect(geometry?.targetTop ?? -1).toBeGreaterThanOrEqual((geometry?.topBarBottom ?? 0) - 1);
    expect(geometry?.targetTop ?? 9999).toBeLessThan(720);
    await expect(page).toHaveURL(/\/blog\/#year-2025$/);

    // History and a direct hash load restore the same exclusive expansion.
    await page.goBack();
    await expect(page).toHaveURL(/\/blog\/#year-2026$/);
    await expect(year2026).toHaveAttribute('aria-expanded', 'true');
    await expectOnlyYearCurrent(page, '2026');

    await page.goto('/blog/#year-2025');
    await expect(year2025).toHaveAttribute('aria-expanded', 'true');
    await expect(year2026).toHaveAttribute('aria-expanded', 'false');
    await expectOnlyYearCurrent(page, '2025');
  });

  test('D37: a year toggles on an article; the archive #year deep link survives reload/history', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(POST_2026);
    await openDrawer(page);

    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2026');
    const current = await currentEntries(page);
    expect(current).toHaveLength(1);
    expect(current[0]?.text).toBe('Reading List for Spring-11.20 08:40');
    expect(current[0]?.value).toBe('page');

    // D37: on a Blog article the year button is a disclosure, not a jump back
    // to the archive — the URL and the current article stay unchanged.
    const articleUrl = page.url();
    await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
    await page.waitForTimeout(250);
    expect(page.url(), 'D37: no navigation from the article year button').toBe(articleUrl);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
    await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toContainText(
      'Reading List for Spring-11.20 08:40',
    );

    // The last year is still reachable through the archive's own deep link; the
    // hash is a property of the directory page, not of the article year button.
    await page.goto('/blog/#year-2025');
    await openDrawer(page);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
    await expect(
      page.locator('.site-nav__post-link', { hasText: 'Notes on Accessible Navigation-11.02 14:05' }),
    ).toBeVisible();
    await expectOnlyYearCurrent(page, '2025');

    await page.reload();
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
    await openDrawer(page);
    await expectOnlyYearCurrent(page, '2025');

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${POST_2026.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    await openDrawer(page);
    await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toContainText(
      'Reading List for Spring-11.20 08:40',
    );

    await page.goForward();
    await page.waitForURL(/\/blog\/#year-2025$/);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
  });
});

test.describe('Blog article page', () => {
  test('has exactly one H1, the date, one divider and the Markdown body without duplicates', async ({ page }) => {
    await page.goto(POST_BUILDING);

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Building a Quiet Homepage');

    const article = page.locator('article.post');
    await expect(article).toHaveCount(1);
    const structure = await article.evaluate((element) => ({
      children: [...element.children].map((child) => child.tagName.toLowerCase()),
      h1Count: element.querySelectorAll('h1').length,
      bodyH1: element.querySelectorAll('.post__body h1').length,
      bodyTime: element.querySelectorAll('.post__body time').length,
      hrCount: element.querySelectorAll(':scope > hr').length,
      dateText: element.querySelector('.post-date time')?.textContent?.trim(),
      dateAttr: element.querySelector('.post-date time')?.getAttribute('datetime'),
      firstBodyText: element.querySelector('.post__body')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80),
    }));
    expect(structure.children).toEqual(['h1', 'p', 'hr', 'div']);
    expect(structure.h1Count).toBe(1);
    expect(structure.bodyH1).toBe(0);
    expect(structure.bodyTime).toBe(0);
    expect(structure.hrCount).toBe(1);
    expect(structure.dateText).toBe('2025-03-14 09:30');
    expect(structure.dateAttr).toBe('2025-03-14T09:30');
    expect(structure.firstBodyText).toContain('This is a placeholder post for the SelfPage scaffold.');

    // The page H1 is rendered as escaped text from the model, and the whole
    // document keeps a valid heading order.
    const levels = await page.evaluate(() =>
      [...document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')].map((heading) =>
        Number(heading.tagName.slice(1)),
      ),
    );
    expect(levels[0]).toBe(1);
  });

  test('renders Markdown lists and links with the sanitised allowlist', async ({ page }) => {
    await page.goto(POST_2026);
    const body = page.locator('.post__body');
    await expect(body.locator('ul li')).toHaveCount(3);
    await expect(body.locator('li').first()).toHaveText('A book about writing clear documentation');

    const scriptCount = await page.evaluate(() => document.querySelectorAll('main script').length);
    const eventAttributes = await page.evaluate(() =>
      [...document.querySelectorAll('main *')].flatMap((element) =>
        [...element.attributes].filter((attribute) => attribute.name.startsWith('on')).map((attribute) => attribute.name),
      ),
    );
    expect(scriptCount).toBe(0);
    expect(eventAttributes).toEqual([]);
  });

  test('current article, Blog and its year keep the correct ancestor state', async ({ page }) => {
    await page.goto(POST_2025);
    await openDrawer(page);

    await expect(page.locator('.site-nav__group[data-nav-group="blog"]')).toHaveClass(/is-current-ancestor/);
    await expect(page.locator('.site-nav__item--year[data-nav-year="2025"]')).toHaveClass(/is-current-ancestor/);
    await expect(page.locator('.site-nav__item--year[data-nav-year="2026"]')).not.toHaveClass(/is-current-ancestor/);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
    await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('.site-nav__post-link[aria-current="page"]')).toHaveText(
      'Notes on Accessible Navigation-11.02 14:05',
    );
    expect(await currentEntries(page)).toHaveLength(1);
  });

  test('long labels keep the full title, exact shortcut and a matching preview card', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(POST_2025);
    await openDrawer(page);

    const postLink = page.locator('.site-nav__post-link', { hasText: 'Notes on Accessible Navigation-11.02 14:05' });
    await expect(postLink).toHaveCount(1);
    await expect(postLink.locator('.site-nav__post-text')).toHaveText('Notes on Accessible Navigation-11.02 14:05');
    await expect(postLink).toHaveAttribute('data-overflow', 'true');

    await postLink.focus();
    const card = page.locator('.nav-preview[data-open="true"]');
    await expect(card).toHaveCount(1);
    const preview = await card.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        title: element.querySelector('.nav-preview__title')?.textContent,
        date: element.querySelector('.nav-preview__date')?.textContent,
        inViewport:
          rect.left >= -0.5 &&
          rect.top >= -0.5 &&
          rect.right <= window.innerWidth + 0.5 &&
          rect.bottom <= window.innerHeight + 0.5,
      };
    });
    expect(preview.title).toBe('Notes on Accessible Navigation');
    expect(preview.date).toBe('2025-11-02 14:05');
    expect(preview.inViewport).toBe(true);

    // The directory itself always exposes the full title.
    await page.goto('/blog/');
    const directoryTitle = page.locator('.blog-post', { hasText: 'Notes on Accessible Navigation' }).locator('.blog-post__title');
    await expect(directoryTitle).toHaveText('Notes on Accessible Navigation');
    const box = await directoryTitle.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
  });
});

test.describe('Blog directory scrollspy', () => {
  test('manual scrolling keeps exactly one current year and does not cover the target', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);

    await page.evaluate(() => window.scrollTo(0, 100));
    await expect.poll(async () => (await currentEntries(page)).map((entry) => entry.text)).toEqual(['2026']);
    expect(await currentEntries(page)).toHaveLength(1);

    await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
    await expectOnlyYearCurrent(page, '2025');

    const targetGeometry = await page.evaluate(() => {
      const topBar = document.querySelector('.top-bar')?.getBoundingClientRect();
      const target = document.getElementById('year-2025')?.getBoundingClientRect();
      return topBar && target ? { topBarBottom: topBar.bottom, targetTop: target.top } : null;
    });
    expect(targetGeometry?.targetTop ?? -1).toBeGreaterThanOrEqual((targetGeometry?.topBarBottom ?? 0) - 1);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(200);
    // With the last year expanded, the bottom of the page still resolves to a
    // single second-level current item (2025), not to the Blog route link.
    await expectOnlyYearCurrent(page, '2025');

    await page.goto('/blog/#year-2025');
    await expectOnlyYearCurrent(page, '2025');
  });

  test('with every year collapsed, the bottom of the directory makes the last year current', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    expect(await expandedYears(page)).toEqual([]);

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    const atBottom = await page.evaluate(
      () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2,
    );
    expect(atBottom, 'page is scrolled to the bottom').toBe(true);
    await expectOnlyYearCurrent(page, '2025');
    const entries = await currentEntries(page);
    expect(
      entries.some((entry) => entry.text === 'Blog'),
      'Blog route link is not the second-level current',
    ).toBe(false);
  });

  test('an explicitly expanded year stays current after PageDown and at the bottom (P0-2)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);

    const year2026 = page.locator('.site-nav__year-toggle', { hasText: '2026' });
    await year2026.click();
    await expectOnlyYearCurrent(page, '2026');
    await expect(year2026).toHaveAttribute('aria-expanded', 'true');

    await page.getByRole('button', { name: 'Menu' }).click();
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(250);
    await expectOnlyYearCurrent(page, '2026');

    // The click pins the hash for a short while; let it expire so the atBottom
    // branch itself has to keep the expanded year instead of the last year.
    await page.waitForTimeout(8300);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(500);
    await expectOnlyYearCurrent(page, '2026');
    expect(await expandedYears(page)).toEqual(['2026']);
  });

  test('reduced motion keeps instant positioning, expansion and current state', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/blog/');
    await openDrawer(page);

    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
    await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
    await expect(page).toHaveURL(/\/blog\/#year-2025$/);
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
    await expectOnlyYearCurrent(page, '2025');

    // The long-title preview still opens on focus without any time-driven
    // motion; only the marquee translation is suppressed.
    const post = page.locator('.site-nav__post-link:visible').first();
    await post.focus();
    await expect(page.locator('.nav-preview[data-open="true"]')).toHaveCount(1);
    const marquee = await post.evaluate((element) => {
      const text = element.querySelector('.site-nav__post-text');
      return text ? getComputedStyle(text).transform : 'none';
    });
    expect(marquee).toBe('none');
  });
});

test.describe('Blog responsive and safety requirements', () => {
  test('320px and 200% text keep dates readable, targets usable and no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/blog/');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);

    await assertNoHorizontalOverflow(page, '/blog/ at 320px/200%');
    const dates = await page.evaluate(() =>
      [...document.querySelectorAll('.blog-post__date')].map((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          text: element.textContent?.trim() ?? '',
          lines: Math.round(rect.height / Number.parseFloat(style.lineHeight)),
          whiteSpace: style.whiteSpace,
        };
      }),
    );
    expect(dates).toHaveLength(4);
    for (const date of dates) {
      expect(date.text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(date.lines, `${date.text} stays on one line`).toBe(1);
      expect(date.whiteSpace).toBe('nowrap');
    }

    const touched = await page.evaluate(() =>
      [...document.querySelectorAll('.blog-post')].every((element) => {
        const rect = element.getBoundingClientRect();
        return rect.height >= 44;
      }),
    );
    expect(touched, 'coarse pointer targets at 320px/200%').toBe(true);

    await openDrawer(page);
    await page.locator('.site-nav__year-toggle', { hasText: '2025' }).click();
    await page.locator('.site-nav__post-link', { hasText: 'Building a Quiet Homepage-03.14 09:30' }).click();
    await page.waitForURL(/\/blog\/2025\/Building%20a%20Quiet%20Homepage-/);
    // The narrow drawer is persistent navigation and stays open across the
    // article navigation as a modal; assert that precondition before closing it
    // explicitly (otherwise a persistence regression would make Escape a no-op
    // and this step would still pass).
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#site-drawer')).toHaveAttribute('role', 'dialog');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    // A full navigation resets the inline root font size; re-apply 200% before
    // asserting that the article itself also reflows at 320px/200%.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize))).toBeGreaterThan(24);
    await assertNoHorizontalOverflow(page, 'article at 320px/200%');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Building a Quiet Homepage');
  });

  test('translated labels grow without overflowing the directory', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/blog/');
    await page.evaluate(() => {
      for (const heading of document.querySelectorAll('.blog-month__title')) {
        heading.textContent = `${heading.textContent} translated into a considerably longer label`;
      }
      for (const title of document.querySelectorAll('.blog-post__title')) {
        title.textContent = `${title.textContent} with a translated suffix that keeps going`;
      }
    });
    await page.waitForTimeout(150);
    await assertNoHorizontalOverflow(page, 'translated Blog labels');
    const headingsHaveText = await page.evaluate(() =>
      [...document.querySelectorAll('.blog-month__title')].every(
        (heading) => (heading.textContent ?? '').trim().length > 0,
      ),
    );
    expect(headingsHaveText).toBe(true);
  });

  test('touch context keeps year expansion and article navigation working', async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto('/blog/');
    await openDrawer(page);
    await page.locator('.site-nav__year-toggle', { hasText: '2025' }).tap();
    await expect(page.locator('.site-nav__year-toggle[aria-expanded="true"]')).toHaveText('2025');
    await page.locator('.site-nav__post-link', { hasText: 'Building a Quiet Homepage-03.14 09:30' }).tap();
    await page.waitForURL(/\/blog\/2025\/Building%20a%20Quiet%20Homepage-/);
    // Persistence keeps the modal drawer open on the article; Close is the
    // touch-friendly explicit path back to the page.
    await page.getByRole('button', { name: 'Close' }).tap();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Building a Quiet Homepage');
    await context.close();
  });

  test('no comments, login UI or public authentication requests appear', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (/github\.com\/(login|oauth)|oauth|authorize|api\/auth/i.test(url)) requests.push(url);
    });

    for (const path of ['/blog/', POST_2026, POST_2025]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const text = await page.locator('body').innerText();
      expect(text, `${path}: comment UI`).not.toMatch(/leave a comment|comments \(\d+\)|post a comment/i);
      expect(text, `${path}: login UI`).not.toMatch(/sign in|log in|login|create account/i);
    }
    expect(requests, `authentication requests: ${requests.join(', ')}`).toEqual([]);
  });

  test('attack fixture, when provided, cannot execute injected HTML', async ({ page }) => {
    const attackPath = process.env.E2E_ATTACK_ARTICLE;
    test.skip(!attackPath, 'E2E_ATTACK_ARTICLE is only set for the sanitizer fixture build');

    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await page.goto(attackPath ?? '/blog/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForTimeout(200);

    const attack = await page.evaluate(() => {
      const article = document.querySelector('article.post');
      return {
        script: article?.querySelectorAll('script').length ?? 0,
        eventAttributes:
          article === null || article === undefined
            ? []
            : [...article.querySelectorAll('*')].flatMap((element) =>
                [...element.attributes]
                  .filter((attribute) => attribute.name.startsWith('on'))
                  .map((attribute) => `${element.tagName}.${attribute.name}`),
              ),
        javascriptHref:
          article === null || article === undefined
            ? 0
            : [...article.querySelectorAll('a')].filter((link) =>
                /^\s*(?:javascript|vbscript|data):/i.test(link.getAttribute('href') ?? ''),
              ).length,
        heading: article?.querySelector('h2')?.textContent ?? '',
        listItems: article?.querySelectorAll('ul li').length ?? 0,
        codeBlocks: article?.querySelectorAll('pre code').length ?? 0,
        inlineCode: article?.querySelector('code')?.textContent ?? '',
      };
    });

    expect(dialogs).toEqual([]);
    expect(attack.script).toBe(0);
    expect(attack.eventAttributes).toEqual([]);
    expect(attack.javascriptHref).toBe(0);
    expect(attack.heading).toBe('Attack heading');
    expect(attack.listItems).toBe(2);
    expect(attack.codeBlocks).toBe(1);
    expect(attack.inlineCode).toBeTruthy();
  });
});
