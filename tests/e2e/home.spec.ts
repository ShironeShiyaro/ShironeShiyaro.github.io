import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Task 04 browser coverage for Home (resume) and Publications.
 *
 * The Home expectations are derived from the real resume Markdown, so changing
 * an H1 without rebuilding/reloading the page makes this suite fail instead of
 * silently accepting hard-coded section data. Everything else is checked
 * against the rendered DOM and the public navigation contract from task 03.
 */

const RESUME_PATH = join(process.cwd(), 'content', 'home', 'resume.md');

interface ResumeHeading {
  title: string;
  id: string;
}

/** Local copy of the public heading-id rule (do not import product helpers). */
function slugifyHeading(title: string): string {
  const normalized = title.normalize('NFC').toLowerCase().trim();
  const slug = normalized.replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'section' : slug;
}

function readResumeHeadings(): ResumeHeading[] {
  const markdown = readFileSync(RESUME_PATH, 'utf8');
  const headings: ResumeHeading[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^# +(.*\S)\s*$/.exec(line);
    if (match?.[1]) {
      const title = match[1].trim();
      headings.push({ title, id: slugifyHeading(title) });
    }
  }
  return headings;
}

async function openSiteNav(page: Page): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
  await expect(page.getByRole('navigation', { name: 'Site' })).toBeVisible();
}

function homeSectionLinks(page: Page) {
  return page.locator('.site-nav__sublist[aria-label="Home sections"] .site-nav__link');
}

async function currentNavTexts(page: Page): Promise<string[]> {
  return page.locator('.site-nav [aria-current]').allTextContents().then((texts) =>
    texts.map((text) => text.replace(/\s+/g, ' ').trim()),
  );
}

async function topBarBottom(page: Page): Promise<number> {
  return page.locator('.top-bar').evaluate((element) => element.getBoundingClientRect().bottom);
}

/** Lets native smooth scrolling finish before geometry is measured. */
async function settleScroll(page: Page): Promise<void> {
  await page.waitForTimeout(800);
}

async function targetTop(page: Page, id: string): Promise<number> {
  return page.locator(`#${id}`).evaluate((element) => element.getBoundingClientRect().top);
}

async function assertNoPageOverflow(page: Page, label: string): Promise<void> {
  const widths = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    body: document.body.scrollWidth,
  }));
  expect(widths.document, `${label}: document scrollWidth`).toBeLessThanOrEqual(widths.client + 1);
  expect(widths.body, `${label}: body scrollWidth`).toBeLessThanOrEqual(widths.client + 1);
}

function channelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance([red, green, blue]: [number, number, number]): number {
  return 0.2126 * channelToLinear(red) + 0.7152 * channelToLinear(green) + 0.0722 * channelToLinear(blue);
}

function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

interface Rgba {
  rgb: [number, number, number];
  alpha: number;
}

function parseColor(value: string): Rgba {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match?.[1]) throw new Error(`unsupported color: ${value}`);
  const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  return {
    rgb: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
    alpha: parts[3] === undefined ? 1 : parts[3],
  };
}

async function assertTextContrast(page: Page, selector: string, label: string): Promise<void> {
  const colors = await page.evaluate((target) => {
    const element = document.querySelector(target);
    if (!element) throw new Error(`missing element: ${target}`);
    const bodyBackground = getComputedStyle(document.body).backgroundColor;
    const style = getComputedStyle(element);
    return { foreground: style.color, background: bodyBackground };
  }, selector);
  const foreground = parseColor(colors.foreground);
  const background = parseColor(colors.background);
  const ratio = contrastRatio(foreground.rgb, background.rgb);
  expect(ratio, `${label}: contrast ratio ${colors.foreground} on ${colors.background}`).toBeGreaterThanOrEqual(4.5);
}

test.describe('Home resume', () => {
  test('renders one section per resume H1 and mirrors the manifest navigation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');

    const headings = readResumeHeadings();
    expect(headings.length, 'the placeholder resume must keep several H1 sections').toBeGreaterThanOrEqual(3);

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Home');

    const sections = page.locator('main article.home section[data-resume-section]');
    await expect(sections).toHaveCount(headings.length);

    await openSiteNav(page);
    const links = homeSectionLinks(page);
    await expect(links).toHaveCount(headings.length);

    for (const [index, heading] of headings.entries()) {
      const section = sections.nth(index);
      await expect(section).toHaveAttribute('aria-labelledby', heading.id);
      const title = section.locator('h2');
      await expect(title).toHaveText(heading.title);
      await expect(title).toHaveAttribute('id', heading.id);
      await expect(title).toHaveAttribute('tabindex', '-1');

      const link = links.nth(index);
      await expect(link).toHaveText(heading.title);
      await expect(link).toHaveAttribute('data-spy-target', heading.id);
      await expect(link).toHaveAttribute('href', new RegExp(`#${heading.id}$`));
    }

    // Rendered Markdown HTML is present instead of a re-parsed copy.
    await expect(sections.nth(0)).toContainText('placeholder copy for the Home page');
    await expect(sections.nth(1).locator('ul li')).toHaveCount(2);
    await expect(sections.nth(2).locator('ul li')).toHaveCount(3);
    await expect(sections.nth(3).locator('ul li')).toHaveCount(3);

    const duplicateIds = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    expect(duplicateIds, 'duplicate element ids').toEqual([]);
  });

  test('every secondary click reveals its target below the fixed bar with one current item', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await openSiteNav(page);

    const headings = readResumeHeadings();
    const links = homeSectionLinks(page);
    const barBottom = await topBarBottom(page);
    const viewportHeight = page.viewportSize()?.height ?? 900;

    for (const [index, heading] of headings.entries()) {
      await links.nth(index).click();
      await expect(page).toHaveURL(new RegExp(`#${heading.id}$`));
      await settleScroll(page);

      const count = await page.locator('.site-nav [aria-current]').count();
      expect(count, `${heading.title}: exactly one aria-current`).toBe(1);
      expect(await currentNavTexts(page)).toEqual([heading.title]);
      await expect(page.locator('.site-nav__group[data-nav-group="home"]')).toHaveClass(/is-current-ancestor/);

      const top = await targetTop(page, heading.id);
      expect(top, `${heading.title}: not hidden by the fixed top bar`).toBeGreaterThanOrEqual(barBottom - 0.5);
      expect(top, `${heading.title}: target inside the viewport`).toBeLessThan(viewportHeight);

      const visible = await page.locator(`#${heading.id}`).isVisible();
      expect(visible, `${heading.title}: target visible`).toBe(true);
    }
  });

  test('manual scrolling updates the single current and keeps Home as the current branch', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await openSiteNav(page);

    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, 0);
    });
    const headings = readResumeHeadings();
    const first = headings[0];
    const last = headings[headings.length - 1];
    if (!first || !last) throw new Error('resume headings are missing');
    // Home has no year branch: at the very top the first section is current,
    // so the first fragment can be reached by scrolling even on a short page.
    await expect.poll(() => currentNavTexts(page)).toEqual([first.title]);

    const firstTop = await page
      .locator(`#${first.id}`)
      .evaluate((element) => element.getBoundingClientRect().top + window.scrollY);
    await page.evaluate((target) => {
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, target - 90);
    }, firstTop);
    await expect.poll(() => currentNavTexts(page)).toEqual([first.title]);
    expect(await page.locator('.site-nav [aria-current]').count()).toBe(1);
    await expect(page.locator('.site-nav__group[data-nav-group="home"]')).toHaveClass(/is-current-ancestor/);

    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => currentNavTexts(page)).toEqual([last.title]);
    expect(await page.locator('.site-nav [aria-current]').count()).toBe(1);

    // Home never renders Publications/Blog descendants.
    await expect(page.locator('.site-nav__group[data-nav-group="publications"] .site-nav__sublist')).toHaveCount(0);
    await expect(page.locator('.site-nav__year-toggle')).toHaveCount(0);
  });

  test('user scroll releases the fragment pin so current follows the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/#skills');
    await expect.poll(() => currentNavTexts(page)).toEqual(['Skills']);

    // A deep-linked fragment is pinned for programmatic positioning; the first
    // real wheel input must release it and let the spy follow the viewport.
    await page.mouse.move(900, 500);
    await page.mouse.wheel(0, -2400);
    const headings = readResumeHeadings();
    const first = headings[0];
    const last = headings[headings.length - 1];
    if (!first || !last) throw new Error('resume headings are missing');
    await expect.poll(() => currentNavTexts(page)).toEqual([first.title]);
    expect(await page.locator('.site-nav [aria-current]').count()).toBe(1);

    // Same after an explicit navigation click, then a user wheel to the end.
    await openSiteNav(page);
    await homeSectionLinks(page).filter({ hasText: 'Skills' }).click();
    await settleScroll(page);
    await expect.poll(() => currentNavTexts(page)).toEqual(['Skills']);
    await page.mouse.move(900, 500);
    await page.mouse.wheel(0, 3000);
    await expect.poll(() => currentNavTexts(page)).toEqual([last.title]);
    expect(await page.locator('.site-nav [aria-current]').count()).toBe(1);

    // Keyboard scroll input releases the pin as well.
    await homeSectionLinks(page).filter({ hasText: 'Education' }).click();
    await settleScroll(page);
    await expect.poll(() => currentNavTexts(page)).toEqual(['Education']);
    await page.keyboard.press('Home');
    await expect.poll(() => currentNavTexts(page)).toEqual([first.title]);
  });

  test('1920x1080: the first section is current at the top of the short Home page', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('/');
    const headings = readResumeHeadings();
    const first = headings[0];
    const last = headings[headings.length - 1];
    if (!first || !last) throw new Error('resume headings are missing');

    const maxScroll = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(maxScroll, 'the placeholder Home page is intentionally short at 1080p').toBeLessThan(300);
    await expect.poll(() => currentNavTexts(page)).toEqual([first.title]);

    // The short page still lets the last section become current via the
    // bottom-edge fallback after real keyboard scrolling.
    await page.keyboard.press('End');
    await expect.poll(() => currentNavTexts(page)).toEqual([last.title]);
  });

  test('narrow drawer stays open after a Home fragment and only Menu closes it', async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
      await page.goto('/');
      await openSiteNav(page);

      const menu = page.getByRole('button', { name: 'Menu' });
      const drawer = page.locator('#site-drawer');
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await homeSectionLinks(page).filter({ hasText: 'About Me' }).click();

      // The drawer is persistent navigation (user 2026-11-25 contract): a Home
      // fragment must not dismiss it. Because the narrow drawer is a modal, the
      // target stays behind it until the user closes the drawer explicitly.
      await expect(page).toHaveURL(/#about-me$/);
      await expect(menu, `${width}: drawer stays open after a Home fragment`).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page.locator('#site-drawer'), `${width}: drawer stays visible`).toHaveCSS(
        'visibility',
        'visible',
      );
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('#site-drawer'))),
        `${width}: focus stays inside the open modal`,
      ).toBe(true);

      // Only the explicit Menu toggle closes it; the target is then revealed
      // below the fixed top bar.
      await menu.click();
      await expect(menu, `${width}: Menu closes the drawer`).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#site-drawer'), `${width}: drawer is hidden`).toHaveCSS(
        'visibility',
        'hidden',
      );
      await expect(page.locator('main')).not.toHaveAttribute('inert', '');
      await expect(page.locator('#about-me')).toBeVisible();

      const top = await targetTop(page, 'about-me');
      const barBottom = await topBarBottom(page);
      expect(top, `${width}: target is below the fixed bar`).toBeGreaterThanOrEqual(barBottom - 0.5);
    }
  });

  test('deep links, reloads and history navigation restore fragment and current state', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/#skills');
    await expect(page).toHaveURL(/#skills$/);
    await expect.poll(() => currentNavTexts(page)).toEqual(['Skills']);

    await page.reload();
    await expect.poll(() => currentNavTexts(page)).toEqual(['Skills']);
    expect(await page.locator('.site-nav [aria-current]').count()).toBe(1);

    await page.goto('/');
    await openSiteNav(page);
    const links = homeSectionLinks(page);
    await links.filter({ hasText: 'About Me' }).click();
    await settleScroll(page);
    await links.filter({ hasText: 'Education' }).click();
    await settleScroll(page);
    await expect.poll(() => currentNavTexts(page)).toEqual(['Education']);

    await page.goBack();
    await expect(page).toHaveURL(/#about-me$/);
    await expect.poll(() => currentNavTexts(page)).toEqual(['About Me']);

    await page.goForward();
    await expect(page).toHaveURL(/#education$/);
    await expect.poll(() => currentNavTexts(page)).toEqual(['Education']);
  });

  test('reduced motion jumps without animation and keyboard activation moves focus into the target', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');

    const behavior = await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
    expect(behavior, 'reduced motion disables smooth scrolling').toBe('auto');

    await openSiteNav(page);
    const link = homeSectionLinks(page).filter({ hasText: 'Education' });
    await link.focus();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/#education$/);
    await expect.poll(() => currentNavTexts(page)).toEqual(['Education']);
    await expect(page.locator('#education')).toBeFocused();
    const focusedInside = await page.evaluate(() => {
      const active = document.activeElement;
      const section = active?.closest('[data-resume-section]');
      return {
        sectionId: section?.querySelector('h2')?.id ?? null,
        bodyIsActive: active === document.body,
      };
    });
    expect(focusedInside.sectionId, 'focus lands inside the target section').toBe('education');
    expect(focusedInside.bodyIsActive, 'focus is not dropped on body').toBe(false);

    const top = await targetTop(page, 'education');
    expect(top).toBeGreaterThanOrEqual((await topBarBottom(page)) - 0.5);

    // With reduced motion the target must already be in its final position;
    // no space animation may continue after the activation.
    const immediate = await page.evaluate(() => {
      const target = document.getElementById('education');
      return { top: target?.getBoundingClientRect().top ?? 0, scrollY: window.scrollY };
    });
    await page.waitForTimeout(350);
    const settled = await page.evaluate(() => {
      const target = document.getElementById('education');
      return { top: target?.getBoundingClientRect().top ?? 0, scrollY: window.scrollY };
    });
    expect(settled.top, 'reduced motion: no ongoing vertical scroll').toBeCloseTo(immediate.top, 0);
    expect(settled.scrollY, 'reduced motion: scroll position is already final').toBeCloseTo(immediate.scrollY, 0);
  });
});

test.describe('Publications', () => {
  test('is a safe academic list with no sidebar children or bad links', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/publications/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Selected Publications');
    await expect(page.getByRole('heading', { name: 'Peer-Reviewed Papers' })).toBeVisible();

    const items = page.locator('main ol.publication-list > li');
    const count = await items.count();
    expect(count, 'at least three English placeholder entries').toBeGreaterThanOrEqual(3);

    await expect(page.locator('main table')).toHaveCount(0);
    await expect(page.locator('main .publication')).toHaveCount(count);

    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const order = await item.evaluate((element) =>
        [...element.children].map((child) => child.className.split(/\s+/)[0] ?? ''),
      );
      expect(order, `item ${index}: venue/year -> title -> code -> authors`).toEqual([
        'publication__meta',
        'publication__title',
        'publication__actions',
        'publication__authors',
      ]);

      await expect(item.locator('.publication__venue')).not.toBeEmpty();
      await expect(item.locator('.publication__year')).toHaveText(/^\d{4}$/);
      await expect(item.locator('.publication__title')).not.toBeEmpty();
      await expect(item.locator('.publication__authors')).not.toBeEmpty();
      await expect(item.locator('.publication__actions')).not.toBeEmpty();

      for (const link of await item.locator('a[target="_blank"]').all()) {
        const rel = (await link.getAttribute('rel')) ?? '';
        expect(rel, 'external links use noopener noreferrer').toContain('noopener');
        expect(rel, 'external links use noopener noreferrer').toContain('noreferrer');
      }
    }

    const badLinks = await page.evaluate(() =>
      [...document.querySelectorAll('a[href]')]
        .map((anchor) => anchor.getAttribute('href') ?? '')
        .filter((href) => href.includes('to-be-public')),
    );
    expect(badLinks, 'no link may point at /to-be-public').toEqual([]);
    await expect(page.getByText('Paper: to be public')).toHaveCount(1);
    await expect(page.getByText('Code: to be public')).toHaveCount(2);

    const externalLinks = page.locator('main ol a[href^="http"]');
    expect(await externalLinks.count(), 'placeholder paper/code links exist').toBeGreaterThanOrEqual(3);

    // Navigation: no children at all, only Publications is current.
    await expect(page.locator('.site-nav__sublist')).toHaveCount(0);
    await expect(page.locator('.site-nav__year-toggle')).toHaveCount(0);
    await expect(page.locator('.site-nav [aria-current]')).toHaveCount(1);
    await expect(page.locator('.site-nav [aria-current]')).toHaveText('Publications');

    // No Google Scholar exit for fictional placeholder content.
    await expect(page.getByText(/google scholar/i)).toHaveCount(0);
    expect(await page.locator('a[href*="scholar.google"]').count()).toBe(0);

    // The visible page is English placeholder content, not a copied homepage.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await page.getByText(/Xuefeng Bai|goodbai|Harbin Institute/i).count()).toBe(0);
  });

  test('reflows at 320px/200% with long titles, authors and translated labels', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/publications/');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);

    await page.locator('.publication').first().evaluate((item) => {
      const longTitle =
        'A Very Long Placeholder Paper Title About Accessible Static Sites and Content Pipelines That Wraps Across Several Lines ' +
        'AccessibleStaticSitesAndContentPipelinesWithoutAnySpacesInThisPlaceholderTitleToken';
      const longAuthors =
        'Alexandra Placeholder-With-A-Long-Surname, Blair Sample, Casey Example, Drew Placeholder, Elliot Sample, ' +
        'Frances Example, Gabriel Placeholder, Harper Sample, VeryLongUnbrokenAuthorIdentifierWithoutAnySpacesInThisPlaceholderName';
      const title = item.querySelector('.publication__title');
      const titleLink = item.querySelector('.publication__title-link');
      const venue = item.querySelector('.publication__venue');
      const authors = item.querySelector('.publication__authors');
      if (titleLink) titleLink.textContent = longTitle;
      else if (title) title.textContent = longTitle;
      if (venue) venue.textContent = 'International Example Conference on Accessible Web Systems and Content Engineering';
      if (authors) authors.textContent = longAuthors;
    });
    await page.waitForTimeout(100);

    await assertNoPageOverflow(page, '/publications/ at 320px and 200% text');

    const layout = await page.locator('.publication').first().evaluate((item) => {
      const selectors = ['.publication__meta', '.publication__title', '.publication__actions', '.publication__authors'];
      const rects = selectors.map((selector) => item.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null);
      const links = [...item.querySelectorAll('a')].map((link) => link.getBoundingClientRect().toJSON());
      return {
        rects,
        links,
        width: window.innerWidth,
        titleHeight: item.querySelector('.publication__title')?.getBoundingClientRect().height ?? 0,
      };
    });
    expect(layout.rects.every(Boolean), 'all publication rows exist').toBe(true);
    for (let index = 1; index < layout.rects.length; index += 1) {
      const previous = layout.rects[index - 1];
      const current = layout.rects[index];
      if (!previous || !current) continue;
      expect(previous.bottom, `publication row ${index} does not overlap`).toBeLessThanOrEqual(current.top + 1);
    }
    for (const link of layout.links) {
      expect(link.left, 'link starts inside viewport').toBeGreaterThanOrEqual(-1);
      expect(link.right, 'link ends inside viewport').toBeLessThanOrEqual(layout.width + 1);
    }
    expect(layout.titleHeight, 'long title wraps instead of clipping').toBeGreaterThan(40);

    // Keyboard focus is visible and links keep a non-colour cue.
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    let reached = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.keyboard.press('Tab');
      const activeClass = await page.evaluate(() =>
        typeof document.activeElement?.className === 'string' ? document.activeElement.className : '',
      );
      if (activeClass.includes('publication__title-link') || activeClass.includes('publication__action')) {
        reached = true;
        break;
      }
    }
    expect(reached, 'Tab reaches a publication link').toBe(true);
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof Element)) throw new Error('no focused element');
      const style = getComputedStyle(active);
      return {
        focusVisible: active.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        decoration: style.textDecorationLine,
      };
    });
    expect(focus.focusVisible, 'focus-visible matches the link').toBe(true);
    expect(focus.outlineStyle, 'focus ring is visible').not.toBe('none');
    expect(focus.outlineWidth, 'focus ring has width').toBeGreaterThan(0);
    expect(focus.decoration, 'links keep an underline').toContain('underline');
  });

  test('text and links meet 4.5:1 contrast in light and dark themes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/publications/');

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.reload();
      await assertTextContrast(page, '.publication__authors', `${colorScheme}: authors`);
      await assertTextContrast(page, '.publication__title-link', `${colorScheme}: title link`);
      await assertTextContrast(page, '.publication__missing', `${colorScheme}: missing link text`);
      await assertTextContrast(page, '.publication__meta', `${colorScheme}: venue/year`);
    }

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await assertTextContrast(page, '.home__title', `${colorScheme}: Home title`);
      await assertTextContrast(page, '.resume-section h2', `${colorScheme}: resume section title`);
      await assertTextContrast(page, '.resume-section__body p', `${colorScheme}: resume body`);
    }
  });
});

test.describe('Home reflow', () => {
  test('long translated section text stays inside a 320px/200% page', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.waitForTimeout(150);

    await page.locator('.resume-section').first().evaluate((section) => {
      const title = section.querySelector('h2');
      const paragraph = section.querySelector('p');
      if (title) {
        title.textContent =
          'About Me, Translated Into A Much Longer Heading That Must Wrap Without Overflowing The Page';
      }
      if (paragraph) {
        paragraph.textContent =
          'This is a translated placeholder paragraph with a very long unbroken token ' +
          'placeholder-placeholder-placeholder-placeholder-placeholder to prove that the reading layout reflows.';
      }
    });
    await page.waitForTimeout(100);

    await assertNoPageOverflow(page, '/ at 320px and 200% text');
    const metrics = await page.evaluate(() => {
      const section = document.querySelector('.resume-section');
      const title = section?.querySelector('h2');
      return {
        titleHeight: title?.getBoundingClientRect().height ?? 0,
        sectionWidth: section?.getBoundingClientRect().width ?? 0,
        viewport: window.innerWidth,
      };
    });
    expect(metrics.titleHeight, 'long section title wraps').toBeGreaterThan(40);
    expect(metrics.sectionWidth, 'section fills but does not exceed the page').toBeLessThanOrEqual(metrics.viewport + 1);
  });
});
