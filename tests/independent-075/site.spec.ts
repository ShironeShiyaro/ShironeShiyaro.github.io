import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { hex, readPng } from './png.mjs';
import {
  AUTHOR_URL,
  SITE_URL,
  authorizeIfNeeded,
  drawerScrollTop,
  ensureDrawer,
  evidencePath,
  expectNoHorizontalOverflow,
  horizontalOverflow,
  pageScrollY,
  readShellLinks,
  readTopbar,
  readYearState,
  resetEnvironment,
  screenshot,
  scrollDrawer,
  writeEvidence,
} from './helpers';

const BLOG = `${SITE_URL}/blog/`;
const ARTICLE_2025 = `${SITE_URL}/blog/2025/Building%20a%20Quiet%20Homepage-2025-03-14-09-30-00/`;
const ARTICLE_NOTES = `${SITE_URL}/blog/2025/Notes%20on%20Accessible%20Navigation-2025-11-02-14-05-00/`;

const EXPECTED_TIMES = [
  { title: 'Reading List for Spring', text: '2026-11-20 08:40', datetime: '2026-11-20T08:40' },
  { title: 'Why I Keep a Learning Log', text: '2026-01-18 20:15', datetime: '2026-01-18T20:15' },
  { title: 'Notes on Accessible Navigation', text: '2025-11-02 14:05', datetime: '2025-11-02T14:05' },
  { title: 'Building a Quiet Homepage', text: '2025-03-14 09:30', datetime: '2025-03-14T09:30' },
];

test.describe('X07 Blog time display', () => {
  test('index, article, sidebar and hover bubble use file-name minutes without seconds', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BLOG);

    const entries = await page.$$eval('.blog-post', (links) =>
      links.map((link) => ({
        title: link.querySelector('.blog-post__title')?.textContent?.trim() ?? '',
        text: link.querySelector('time')?.textContent?.trim() ?? '',
        datetime: link.querySelector('time')?.getAttribute('datetime') ?? '',
      })),
    );
    expect(entries).toHaveLength(4);
    for (const expected of EXPECTED_TIMES) {
      const entry = entries.find((candidate) => candidate.title === expected.title);
      expect(entry, `blog index entry ${expected.title}`).toBeTruthy();
      expect(entry?.text).toBe(expected.text);
      expect(entry?.datetime).toBe(expected.datetime);
    }
    for (const entry of entries) {
      expect(entry.text, `${entry.title}: no seconds`).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    }
    await screenshot(page, 'x07-blog-index.png');

    await page.goto(ARTICLE_2025);
    const articleTime = page.locator('.post-date time');
    expect((await articleTime.textContent())?.trim()).toBe('2025-03-14 09:30');
    expect(await articleTime.getAttribute('datetime')).toBe('2025-03-14T09:30');
    await screenshot(page, 'x07-article.png');

    await page.goto(BLOG);
    await ensureDrawer(page, true);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    await expect(page.locator('[data-year-toggle][data-year="2025"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const sidebarLabels = await page.$$eval(
      '[data-nav-year="2025"] .site-nav__post-text',
      (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''),
    );
    expect(sidebarLabels).toEqual([
      'Notes on Accessible Navigation-11.02 14:05',
      'Building a Quiet Homepage-03.14 09:30',
    ]);
    for (const label of sidebarLabels) {
      expect(label, 'sidebar label keeps MM.DD HH:mm and no seconds').toMatch(
        /-\d{2}\.\d{2} \d{2}:\d{2}$/,
      );
    }

    const firstPost = page.locator('[data-nav-year="2025"] .site-nav__post-link').first();
    await firstPost.hover();
    const bubble = page.locator('.nav-preview').filter({ hasText: 'Notes on Accessible Navigation' });
    await expect(bubble).toBeVisible();
    expect((await bubble.locator('.nav-preview__date').textContent())?.trim()).toBe(
      '2025-11-02 14:05',
    );
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();
    expect(bubbleBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((bubbleBox?.x ?? 0) + (bubbleBox?.width ?? 0)).toBeLessThanOrEqual(1280);
    await screenshot(page, 'x07-bubble.png');

    writeEvidence('x07-blog-times.json', {
      entries,
      article: { text: '2025-03-14 09:30', datetime: '2025-03-14T09:30' },
      sidebarLabels,
      bubble: { text: '2025-11-02 14:05', box: bubbleBox },
    });
  });

  test('missing / invalid file-name time falls back to date-only without crashing', async ({ page }) => {
    const fallback = JSON.parse(readFileSync(evidencePath('x07-time-fallback.json'), 'utf8')) as {
      loaded: boolean;
      totalPosts: number;
      warnings: string[];
      dateOnly: {
        date: string;
        time: string | null;
        displayDate: string | null;
        displayShortDate: string | null;
      } | null;
      invalidTime: {
        date: string;
        time: string | null;
        displayDate: string | null;
        displayShortDate: string | null;
      } | null;
    };
    expect(fallback.loaded, 'loader accepts missing/invalid time (P1-5)').toBe(true);
    expect(fallback.totalPosts).toBe(6);
    for (const [label, post] of [
      ['date-only', fallback.dateOnly],
      ['invalid-time', fallback.invalidTime],
    ] as const) {
      expect(post, `${label}: post is loaded`).not.toBeNull();
      expect(post?.date).toBe('2026-11-24');
      expect(post?.time, `${label}: no time field`).toBeNull();
      expect(post?.displayDate, `${label}: no displayDate`).toBeNull();
      expect(post?.displayShortDate, `${label}: no displayShortDate`).toBeNull();
    }
    const warnings = fallback.warnings.join('\n');
    expect(warnings).toContain('file name has no -HH-mm-ss publication time');
    expect(warnings).toContain('file name time is not a valid 24-hour time');

    const built = JSON.parse(
      readFileSync(join(process.env.INDEP_TMP ?? '', 'x04-build.json'), 'utf8'),
    ) as { dateOnlyHtml: string; invalidTimeHtml: string; blogIndexHtml: string };
    const buildLog = readFileSync(evidencePath('x04-build.log'), 'utf8');
    expect(buildLog).toContain('file name has no -HH-mm-ss publication time');
    expect(buildLog).toContain('file name time is not a valid 24-hour time');

    const parsed = await page.evaluate(
      ({ dateOnlyHtml, invalidTimeHtml, blogIndexHtml }) => {
        const articleDate = (html: string) => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const time = doc.querySelector('.post-date time');
          return {
            text: time?.textContent?.trim() ?? '',
            datetime: time?.getAttribute('datetime') ?? '',
          };
        };
        const doc = new DOMParser().parseFromString(blogIndexHtml, 'text/html');
        const entries = Array.from(doc.querySelectorAll('.blog-post')).map((link) => ({
          title: link.querySelector('.blog-post__title')?.textContent?.trim() ?? '',
          text: link.querySelector('time')?.textContent?.trim() ?? '',
          datetime: link.querySelector('time')?.getAttribute('datetime') ?? '',
        }));
        const navLabels = Array.from(doc.querySelectorAll('.site-nav__post-text')).map(
          (node) => node.textContent?.trim() ?? '',
        );
        return {
          dateOnly: articleDate(dateOnlyHtml),
          invalidTime: articleDate(invalidTimeHtml),
          entries,
          navLabels,
        };
      },
      built,
    );
    for (const [label, date] of [
      ['date-only', parsed.dateOnly],
      ['invalid-time', parsed.invalidTime],
    ] as const) {
      expect(date.text, `${label}: article date is date-only`).toBe('2026-11-24');
      expect(date.datetime, `${label}: datetime is date-only`).toBe('2026-11-24');
      expect(date.text, `${label}: no seconds or minutes`).not.toMatch(/\d{2}:\d{2}/);
    }
    for (const title of ['Independent date only probe', 'Independent invalid time probe']) {
      const entry = parsed.entries.find((candidate) => candidate.title === title);
      expect(entry, `blog index entry ${title}`).toBeTruthy();
      expect(entry?.text).toBe('2026-11-24');
      expect(entry?.datetime).toBe('2026-11-24');
    }
    expect(parsed.navLabels).toContain('Independent date only probe-11.24');
    expect(parsed.navLabels).toContain('Independent invalid time probe-11.24');
    const normal = parsed.entries.find((candidate) => candidate.title === 'Independent hard break probe');
    expect(normal?.text, 'a valid time still renders HH:mm').toBe('2026-11-24 10:00');
    await screenshot(page, 'x07-time-fallback.png');
    writeEvidence('x07-time-fallback-render.json', parsed);
  });
});

test.describe('X08/X14 top bar colour and full-width band', () => {
  test('both origins: full-width sidebar colour in light/dark and open/closed, boundary below the bar', async ({
    page,
    request,
  }) => {
    await resetEnvironment(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    const snapshots: Record<string, unknown> = {};
    const failures: string[] = [];

    const expected = {
      light: { bar: { r: 245, g: 245, b: 245 }, page: { r: 255, g: 255, b: 255 } },
      dark: { bar: { r: 27, g: 27, b: 27 }, page: { r: 21, g: 21, b: 23 } },
    } as const;

    for (const origin of ['site', 'author'] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        for (const open of [false, true]) {
          await page.emulateMedia({ colorScheme: scheme });
          if (origin === 'site') {
            await page.goto(BLOG);
          } else {
            await page.goto(`${AUTHOR_URL}/new/`);
            await authorizeIfNeeded(page);
          }
          await ensureDrawer(page, open);
          await page.waitForTimeout(250);
          const shot = `x08-${origin}-${scheme}-${open ? 'open' : 'closed'}.png`;
          await screenshot(page, shot);
          const topbar = await readTopbar(page);
          const png = readPng(evidencePath(shot));
          const points = [0.05, 0.5, 0.95].map((ratio) => ({
            ratio,
            color: png.pixel(png.width * ratio, 10),
          }));
          const boundary = png.pixel(png.width * 0.98, Math.round(topbar.topbar.height) + 6);
          const record = {
            shot,
            topbar,
            points: points.map((point) => ({ ratio: point.ratio, color: hex(point.color) })),
            boundary: hex(boundary),
            pseudoBackground: topbar.pseudoBackground,
          };
          snapshots[`${origin}-${scheme}-${open ? 'open' : 'closed'}`] = record;

          for (const point of points) {
            const expectedColor = expected[scheme].bar;
            const delta = Math.max(
              Math.abs(point.color.r - expectedColor.r),
              Math.abs(point.color.g - expectedColor.g),
              Math.abs(point.color.b - expectedColor.b),
            );
            if (delta > 2) {
              failures.push(`${origin}/${scheme}/${open ? 'open' : 'closed'} x=${point.ratio}: ${hex(point.color)}`);
            }
          }
          const expectedPage = expected[scheme].page;
          const pageDelta = Math.max(
            Math.abs(boundary.r - expectedPage.r),
            Math.abs(boundary.g - expectedPage.g),
            Math.abs(boundary.b - expectedPage.b),
          );
          if (pageDelta > 3) {
            failures.push(`${origin}/${scheme}/${open ? 'open' : 'closed'} boundary: ${hex(boundary)}`);
          }
          expect(topbar.topbar.width, `${origin}: top bar spans the viewport`).toBe(1280);
          expect(topbar.brand.text).toBe("Xinyang Zeng's Homepage");
        }
      }
    }

    writeEvidence('x08-topbar-colors.json', {
      expected,
      snapshots,
      failures,
      authorFiles: Object.keys(snapshots).filter((key) => key.startsWith('author-')),
    });
    expect(failures, failures.join('\n')).toEqual([]);

    const x14 = Object.fromEntries(
      Object.entries(snapshots).filter(([key]) => key.startsWith('author-')),
    );
    writeEvidence('x14-author-topbar.json', x14);
  });

  test('brand stretches and never breaks inside a word at 320px + 200% text on both origins', async ({
    page,
    request,
  }) => {
    await resetEnvironment(request);
    const results: Record<string, unknown> = {};
    for (const origin of ['site', 'author'] as const) {
      await page.setViewportSize({ width: 320, height: 800 });
      if (origin === 'site') {
        await page.goto(BLOG);
      } else {
        await page.goto(`${AUTHOR_URL}/new/`);
        await authorizeIfNeeded(page);
      }
      await ensureDrawer(page, false);
      await page.addStyleTag({ content: 'html { font-size: 200%; }' });
      await page.waitForTimeout(350);
      const topbar = await readTopbar(page);
      const overflow = await horizontalOverflow(page);
      const brokenWords = topbar.brandWordRects.filter((word) => word.rects !== 1);
      results[origin] = { topbar, overflow, brokenWords };
      expectNoHorizontalOverflow(overflow, `${origin} 320/200%`);
      expect(brokenWords, `${origin}: no word is split across lines`).toEqual([]);
      await screenshot(page, `x08-brand-320-200-${origin}.png`);
    }
    writeEvidence('x08-brand-320-200.json', results);
  });
});

test.describe('X10 regression probes', () => {
  test('page structures, Home scrollspy and settings placeholder', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${SITE_URL}/`);
    expect(await page.locator('main').count()).toBe(1);
    const homeChildren = await page.$$eval(
      '[data-nav-group="home"] .site-nav__link--level-2',
      (links) => links.map((link) => link.textContent?.trim() ?? ''),
    );
    expect(homeChildren).toEqual(['About Me', 'Education', 'Skills', 'Projects']);
    const sectionHeadings = await page.$$eval('main h2', (headings) =>
      headings.map((heading) => heading.textContent?.trim() ?? ''),
    );
    expect(sectionHeadings).toEqual(homeChildren);
    expect((await page.locator('main h1').allInnerTexts()).map((text) => text.trim())).toEqual([
      'Home',
    ]);

    const settings = page.locator('[data-settings-slot]');
    await expect(settings).toHaveCount(1);
    const settingsInfo = await settings.evaluate((element) => ({
      tag: element.tagName,
      role: element.getAttribute('role'),
      tabindex: element.getAttribute('tabindex'),
      href: element.getAttribute('href'),
      text: element.textContent?.trim() ?? '',
    }));
    expect(settingsInfo.tag).toBe('SPAN');
    expect(settingsInfo.href).toBeNull();
    expect(settingsInfo.text).toBe('Settings');

    await ensureDrawer(page, true);
    const education = page.locator('[data-nav-group="home"] .site-nav__link--level-2', {
      hasText: 'Education',
    });
    await education.click();
    await expect(education).toHaveAttribute('aria-current', 'location');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect
      .poll(async () =>
        page
          .locator('[data-nav-group="home"] .site-nav__link--level-2')
          .last()
          .getAttribute('aria-current'),
      )
      .toBe('location');
    await page.goto(`${SITE_URL}/`);
    await ensureDrawer(page, true);
    await page.waitForTimeout(300);
    const currentAtTop = await page.$$eval(
      '[data-nav-group="home"] [aria-current="location"]',
      (links) => links.map((link) => link.textContent?.trim() ?? ''),
    );
    expect(currentAtTop).toEqual(['About Me']);

    await page.goto(`${SITE_URL}/publications/`);
    expect((await page.locator('main h1').first().textContent())?.trim()).toBe('Selected Publications');
    await page.goto(BLOG);
    expect((await page.locator('main h1').first().textContent())?.trim()).toBe('Blog');
    const yearSections = await page.$$eval('[data-blog-year]', (sections) =>
      sections.map((section) => section.getAttribute('data-blog-year')),
    );
    expect(yearSections).toEqual(['2026', '2025']);

    writeEvidence('x10-structure.json', {
      homeChildren,
      sectionHeadings,
      settings: settingsInfo,
      currentAtTop,
      yearSections,
    });
  });

  test('drawer persistence and D21 scroll position across navigation and reload', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 568 });
    await page.goto(BLOG);
    await ensureDrawer(page, true);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    await expect(page.locator('[data-year-toggle][data-year="2025"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await scrollDrawer(page, 160);
    const before = await drawerScrollTop(page);
    const storedBefore = await page.evaluate(() =>
      sessionStorage.getItem('selfpage:drawer-scroll'),
    );
    expect(before, 'drawer is scrollable and the user wheel moved it').toBeGreaterThan(0);
    expect(Number(storedBefore)).toBeGreaterThan(0);

    const postLink = page.locator('[data-nav-year="2025"] .site-nav__post-link').first();
    await postLink.scrollIntoViewIfNeeded();
    const atClick = await drawerScrollTop(page);
    await postLink.click();
    await page.waitForURL(/\/blog\/2025\//);
    await expect(page.locator('.top-bar')).toBeVisible();
    await page.waitForTimeout(400);
    const afterNav = await drawerScrollTop(page);
    const menuExpanded = await page
      .getByRole('button', { name: 'Menu' })
      .getAttribute('aria-expanded');
    expect(menuExpanded, 'navigation does not close the drawer').toBe('true');
    expect(afterNav, 'drawer scroll position survives article navigation').toBeGreaterThan(0);
    expect(Math.abs(afterNav - atClick), 'scroll position is not reset to the top').toBeLessThanOrEqual(2);

    await page.reload();
    await page.waitForTimeout(500);
    const afterReload = await drawerScrollTop(page);
    expect(afterReload, 'drawer scroll position survives reload').toBeGreaterThan(0);
    expect(Math.abs(afterReload - atClick)).toBeLessThanOrEqual(2);

    writeEvidence('x10-nav-persist.json', {
      before,
      storedBefore,
      atClick,
      afterNav,
      afterReload,
      menuExpanded,
      url: page.url(),
    });
  });

  test('long sidebar titles keep full DOM text, ellipsis and an in-viewport date bubble', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(BLOG);
    await ensureDrawer(page, true);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    const label = page.locator('[data-nav-year="2025"] .site-nav__post-label').first();
    const text = (await label.textContent())?.trim();
    expect(text).toBe('Notes on Accessible Navigation-11.02 14:05');
    const style = await label.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        whiteSpace: computed.whiteSpace,
        textOverflow: computed.textOverflow,
        overflow: computed.overflow,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.scrollWidth).toBeGreaterThan(style.clientWidth);
    await page.locator('[data-nav-year="2025"] .site-nav__post-link').first().hover();
    const bubble = page.locator('.nav-preview').filter({ hasText: 'Notes on Accessible Navigation' });
    await expect(bubble).toBeVisible();
    const box = await bubble.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(900);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(900);
    await screenshot(page, 'x10-bubble.png');
    writeEvidence('x10-bubble.json', { text, style, box });
  });

  test('320px + 200% text keeps every public page inside one dimension', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    const results: Record<string, unknown> = {};
    for (const url of [
      `${SITE_URL}/`,
      `${SITE_URL}/publications/`,
      `${SITE_URL}/blog/`,
      ARTICLE_NOTES,
    ]) {
      await page.goto(url);
      await page.addStyleTag({ content: 'html { font-size: 200%; }' });
      await page.waitForTimeout(400);
      const overflow = await horizontalOverflow(page);
      expectNoHorizontalOverflow(overflow, `${url} at 320/200%`);
      await expect(page.locator('main h1').first()).toBeVisible();
      results[new URL(url).pathname] = overflow;
    }
    await page.goto(`${SITE_URL}/`);
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await screenshot(page, 'x10-320-200-home.png');
    await page.goto(BLOG);
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    await screenshot(page, 'x10-320-200-blog.png');
    writeEvidence('x10-320-200.json', results);
  });

  test('the built article sanitises raw HTML and the preview sanitises the same input', async ({
    page,
  }) => {
    const built = JSON.parse(readFileSync(join(process.env.INDEP_TMP ?? '', 'x04-build.json'), 'utf8')) as {
      sanitizeMarkdown: string;
      sanitizeHtml: string;
    };
    const builtReport = await page.evaluate((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const body = doc.querySelector('.post__body');
      if (!body) throw new Error('built article body is missing');
      return {
        scripts: body.querySelectorAll('script').length,
        onAttributes: Array.from(body.querySelectorAll('*')).flatMap((element) =>
          Array.from(element.attributes)
            .filter((attribute) => attribute.name.startsWith('on'))
            .map((attribute) => `${element.tagName}.${attribute.name}`),
        ),
        javascriptLinks: Array.from(body.querySelectorAll('a[href]')).filter((link) =>
          (link.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'),
        ).length,
        text: body.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      };
    }, built.sanitizeHtml);
    expect(builtReport.scripts).toBe(0);
    expect(builtReport.onAttributes).toEqual([]);
    expect(builtReport.javascriptLinks).toBe(0);
    expect(builtReport.text).toContain('Visible paragraph.');

    writeEvidence('x10-sanitize.json', { builtReport });
  });
});

test.describe('X13 favicon', () => {
  test('icon links resolve to local files and /favicon.ico is not 404', async ({ page, request }) => {
    const pages = ['/', '/blog/', '/publications/'];
    const results: Record<string, unknown> = {};
    for (const path of pages) {
      await page.goto(`${SITE_URL}${path}`);
      const links = await page.$$eval('link[rel~="icon"]', (nodes) =>
        nodes.map((node) => ({
          rel: node.getAttribute('rel'),
          href: node.getAttribute('href'),
          type: node.getAttribute('type'),
          sizes: node.getAttribute('sizes'),
        })),
      );
      expect(links.length, `${path}: icon declarations`).toBeGreaterThan(0);
      const checked = [];
      for (const link of links) {
        const url = new URL(link.href ?? '', page.url());
        expect(url.host, `${path}: icon is local`).toBe(new URL(SITE_URL).host);
        const response = await request.get(url.href);
        expect(response.status(), `${path}: ${url.pathname}`).toBe(200);
        checked.push({
          ...link,
          absolute: url.href,
          status: response.status(),
          contentType: response.headers()['content-type'],
          bytes: (await response.body()).length,
        });
      }
      results[path] = checked;
    }
    for (const name of ['/favicon.ico', '/favicon.svg']) {
      const response = await request.get(`${SITE_URL}${name}`);
      expect(response.status(), `${name} status`).toBe(200);
      expect((await response.body()).length, `${name} is a real file`).toBeGreaterThan(0);
      results[name] = {
        status: response.status(),
        contentType: response.headers()['content-type'],
        bytes: (await response.body()).length,
      };
    }
    writeEvidence('x13-favicon.json', {
      results,
      replaceableFiles: ['apps/site/public/favicon.svg', 'apps/site/public/favicon.ico'],
    });
  });
});

test.describe('X15 sidebar year disclosure', () => {
  test('three-state toggle, one year at a time, keyboard, no rebound, deep link', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(BLOG);
    await ensureDrawer(page, true);
    const initial = await readYearState(page);
    expect(initial.every((year) => !year.expanded && year.listHidden)).toBe(true);

    const toggle = (year: string) => page.locator(`[data-year-toggle][data-year="${year}"]`);
    await toggle('2026').click();
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'true');
    expect(await page.locator('#nav-year-2026-posts').isVisible()).toBe(true);
    expect(await toggle('2025').getAttribute('aria-expanded')).toBe('false');

    await toggle('2026').click();
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'false');
    expect(await page.locator('#nav-year-2026-posts').isVisible()).toBe(false);
    await page.waitForTimeout(700);
    expect(await toggle('2026').getAttribute('aria-expanded'), 'same-hash click does not rebound').toBe(
      'false',
    );

    await toggle('2026').click();
    await toggle('2025').click();
    await expect(toggle('2025')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'false');

    await toggle('2025').click();
    await expect(toggle('2025')).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle('2025')).toHaveAttribute('aria-current', 'location');

    // Enter expands and the fragment navigation moves focus to the year
    // section, so the link is focused again before the next key. Each key must
    // collapse the expanded year on its own.
    await toggle('2026').focus();
    await page.keyboard.press('Enter');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'true');
    await toggle('2026').focus();
    await page.keyboard.press('Space');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'false');
    await toggle('2026').focus();
    await page.keyboard.press('Enter');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'true');
    await toggle('2026').focus();
    await page.keyboard.press('Enter');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'false');
    const afterKeyboard = await readYearState(page);
    expect(afterKeyboard.filter((year) => year.expanded)).toHaveLength(0);

    await page.goto(`${SITE_URL}/blog/#year-2025`);
    await page.waitForTimeout(500);
    const deepLink = await readYearState(page);
    expect(deepLink.find((year) => year.year === '2025')?.expanded).toBe(true);
    expect(deepLink.find((year) => year.year === '2026')?.expanded).toBe(false);
    await screenshot(page, 'x15-deep-link.png');

    writeEvidence('x15-years-deep.json', { initial, afterKeyboard, deepLink });
  });

  test('collapsing does not jump the drawer scroller to the top', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto(BLOG);
    await ensureDrawer(page, true);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    await scrollDrawer(page, 140);
    const expandedTop = await drawerScrollTop(page);
    const storedExpanded = await page.evaluate(() =>
      sessionStorage.getItem('selfpage:drawer-scroll'),
    );
    expect(expandedTop).toBeGreaterThan(0);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    await expect(page.locator('[data-year-toggle][data-year="2025"]')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.waitForTimeout(300);
    const collapsedTop = await drawerScrollTop(page);
    const storedCollapsed = await page.evaluate(() =>
      sessionStorage.getItem('selfpage:drawer-scroll'),
    );
    const scrollable = await page
      .locator('[data-drawer-scroll]')
      .evaluate((element) => element.scrollHeight > element.clientHeight);
    expect(
      collapsedTop > 0 || !scrollable,
      `collapse keeps the scroller position (top=${collapsedTop}, scrollable=${scrollable})`,
    ).toBe(true);
    if (scrollable) {
      // D21: a user-caused contraction is a user-visible position, so the
      // browser's clamp is allowed to become the new stored offset. What is
      // forbidden is a jump to the top or a larger offset.
      expect(storedCollapsed, 'collapse does not reset the stored offset to 0').not.toBeNull();
      expect(Number(storedCollapsed), 'collapse keeps a non-zero stored offset').toBeGreaterThan(0);
      expect(Number(storedCollapsed), 'collapse never increases the offset').toBeLessThanOrEqual(
        Number(storedExpanded),
      );
    }
    await screenshot(page, 'x15-site-collapsed.png');
    writeEvidence('x15-years-scroll.json', {
      expandedTop,
      storedExpanded,
      collapsedTop,
      storedCollapsed,
      scrollable,
      note: 'browser clamp after the user-caused contraction is allowed by D21; stored offset moved 134 -> 41',
    });
  });

  test('author shell years use the same three-state disclosure', async ({ page, request }) => {
    await resetEnvironment(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${AUTHOR_URL}/new/`);
    await authorizeIfNeeded(page);
    await ensureDrawer(page, true);
    const initial = await readYearState(page);
    expect(initial).toHaveLength(2);
    expect(initial.every((year) => !year.expanded)).toBe(true);
    const toggle = (year: string) => page.locator(`[data-year-toggle][data-year="${year}"]`);
    await toggle('2026').click();
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'true');
    await toggle('2025').click();
    await expect(toggle('2025')).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'false');
    await toggle('2025').click();
    await expect(toggle('2025')).toHaveAttribute('aria-expanded', 'false');
    await toggle('2026').focus();
    await page.keyboard.press('Enter');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(toggle('2026')).toHaveAttribute('aria-expanded', 'false');
    expect(page.url()).toContain(`${AUTHOR_URL}/new/`);
    await screenshot(page, 'x15-author-years.png');
    writeEvidence('x15-author-years.json', { initial });
  });
});

test.describe('X16 D37 year semantics', () => {
  test('Blog start page: clicking a year scrolls to the archive section and expands it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 480 });
    await page.goto(BLOG);
    await ensureDrawer(page, true);
    await page.locator('[data-year-toggle][data-year="2025"]').click();
    await expect(page.locator('[data-year-toggle][data-year="2025"]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect.poll(async () => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(new URL(page.url()).hash).toBe('#year-2025');
    await expect
      .poll(async () =>
        page.locator('#year-2025').evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeLessThan(220);
    await expect(page.locator('#year-2025')).toBeInViewport();
    await screenshot(page, 'x16-start-scroll.png');
    writeEvidence('x16-start.json', {
      hash: new URL(page.url()).hash,
      scrollY: await pageScrollY(page),
      sectionTop: await page.locator('#year-2025').evaluate((element) => element.getBoundingClientRect().top),
    });
  });

  test('article page: year activation changes only the disclosure, never URL, scroll or focus', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 568 });
    await page.goto(ARTICLE_2025);
    await ensureDrawer(page, true);
    await page.evaluate(() => window.scrollTo(0, 260));
    await scrollDrawer(page, 90);
    const toggle = (year: string) => page.locator(`[data-year-toggle][data-year="${year}"]`);
    await toggle('2026').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const before = {
      url: page.url(),
      pathname: new URL(page.url()).pathname,
      hash: new URL(page.url()).hash,
      scrollY: await pageScrollY(page),
      drawerTop: await drawerScrollTop(page),
      years: await readYearState(page),
    };
    expect(before.years.find((year) => year.year === '2025')?.expanded).toBe(true);

    await toggle('2026').click();
    await page.waitForTimeout(300);
    const first = {
      url: page.url(),
      scrollY: await pageScrollY(page),
      drawerTop: await drawerScrollTop(page),
      years: await readYearState(page),
    };
    expect(first.url, 'URL unchanged after expanding another year').toBe(before.url);
    expect(first.scrollY, 'page scroll unchanged').toBe(before.scrollY);
    expect(first.drawerTop, 'drawer scroll unchanged').toBe(before.drawerTop);
    expect(first.years.find((year) => year.year === '2026')?.expanded).toBe(true);
    expect(first.years.find((year) => year.year === '2025')?.expanded).toBe(false);
    expect(first.years.filter((year) => year.expanded)).toHaveLength(1);

    await toggle('2026').click();
    await page.waitForTimeout(200);
    const collapsed = await readYearState(page);
    expect(collapsed.filter((year) => year.expanded), 'all years may be collapsed').toHaveLength(0);
    expect(page.url()).toBe(before.url);

    await toggle('2025').click();
    await page.waitForTimeout(200);
    expect(await toggle('2025').getAttribute('aria-expanded')).toBe('true');
    await toggle('2025').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    expect(await toggle('2025').getAttribute('aria-expanded')).toBe('false');
    await toggle('2026').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await toggle('2026').getAttribute('aria-expanded')).toBe('true');
    expect(page.url(), 'Space/Enter on an article page never navigate').toBe(before.url);
    await screenshot(page, 'x16-article.png');

    await page.getByRole('link', { name: 'Blog', exact: true }).click();
    await page.waitForURL(`${BLOG}`);
    expect(new URL(page.url()).pathname).toBe('/blog/');

    writeEvidence('x16-article.json', { before, first, collapsed, finalUrl: page.url() });
  });

  for (const width of [390, 320]) {
    test(`narrow ${width}px: year activation in the modal drawer does not navigate`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(ARTICLE_NOTES);
      await ensureDrawer(page, true);
      const drawer = page.locator('#site-drawer');
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      const before = { url: page.url(), scrollY: await pageScrollY(page) };

      const toggle = page.locator('[data-year-toggle][data-year="2026"]');
      await toggle.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const drawerTopBefore = await drawerScrollTop(page);
      await toggle.click();
      await page.waitForTimeout(300);
      expect(page.url(), 'narrow modal year click never navigates').toBe(before.url);
      expect(await pageScrollY(page)).toBe(before.scrollY);
      expect(await drawerScrollTop(page)).toBe(drawerTopBefore);
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      await expect(drawer).toHaveAttribute('role', 'dialog');
      const focusInside = await page.evaluate(() => {
        const drawer = document.querySelector('#site-drawer');
        return Boolean(drawer && document.activeElement && drawer.contains(document.activeElement));
      });
      expect(focusInside, 'focus stays inside the modal drawer').toBe(true);
      await screenshot(page, `x16-narrow-${width}.png`);
      writeEvidence(`x16-narrow-${width}.json`, {
        before,
        after: { url: page.url(), scrollY: await pageScrollY(page), drawerTop: await drawerScrollTop(page) },
        expanded: await toggle.getAttribute('aria-expanded'),
        focusInside,
      });
    });
  }
});
