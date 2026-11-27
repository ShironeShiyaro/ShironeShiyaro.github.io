import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SITE_URL = process.env.INDEP_SITE_URL ?? 'http://localhost:4324';
export const AUTHOR_URL = process.env.INDEP_AUTHOR_URL ?? 'http://localhost:43243';
// P2-3: the fallback must not point at task 07.5's tracked evidence
// (docs_AI/记录/r075/assets/indep-075). `run.mjs` passes INDEP_ASSETS, but a
// direct spec run uses this default, so it has to be the gitignored tree too.
export const ASSETS = process.env.INDEP_ASSETS ?? join(process.cwd(), 'test-results', 'independent-075');
export const DRAFT_KEY = 'selfpage:author:draft';
export const FIXED_CLOCK = '2026-11-23T15:42:15Z';

export function evidencePath(name: string): string {
  mkdirSync(ASSETS, { recursive: true });
  return join(ASSETS, name);
}

export function writeEvidence(name: string, value: unknown): void {
  writeFileSync(evidencePath(name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: evidencePath(name), animations: 'disabled' });
}

export async function resetEnvironment(request: APIRequestContext): Promise<void> {
  const reset = await request.post(`${AUTHOR_URL}/api/test/reset`);
  expect(reset.status(), await reset.text()).toBe(200);
  const clock = await request.post(`${AUTHOR_URL}/api/test/clock`, { data: { now: FIXED_CLOCK } });
  expect(clock.status(), await clock.text()).toBe(200);
}

export async function openAuthorPage(page: Page, path = '/new/'): Promise<void> {
  await page.goto(`${AUTHOR_URL}${path}`);
  await expect(page.locator('.top-bar')).toBeVisible();
  await expect(page.getByTestId('auth-continue').or(page.getByTestId('post-title'))).toBeVisible();
}

export async function authorize(page: Page): Promise<void> {
  const logout = page.getByTestId('logout-button');
  if (!(await logout.isVisible())) {
    await page.getByTestId('auth-continue').click();
  }
  await expect(logout).toBeVisible();
  await expect(page.getByTestId('post-title')).toBeVisible();
  await expect(page.locator('.status-panel--auth')).toHaveCount(0);
}

export async function openAuthorized(page: Page, path = '/new/'): Promise<void> {
  await openAuthorPage(page, path);
  await authorize(page);
}

/** Waits out the entry loading state, then signs in when the gate is shown. */
export async function authorizeIfNeeded(page: Page): Promise<void> {
  await expect(page.getByTestId('auth-continue').or(page.getByTestId('post-title'))).toBeVisible();
  if (await page.getByTestId('auth-continue').isVisible()) {
    await page.getByTestId('auth-continue').click();
  }
  await expect(page.getByTestId('post-title')).toBeVisible();
}

export async function openAnonymous(page: Page, path = '/new/'): Promise<void> {
  await openAuthorPage(page, path);
  await expect(page.getByTestId('auth-continue')).toBeVisible();
  await expect(page.getByTestId('post-title')).toHaveCount(0);
}

export async function setEditorValue(
  page: Page,
  field: 'title' | 'body',
  value: string,
): Promise<void> {
  await page.getByTestId(`post-${field}`).evaluate((element, text) => {
    element.textContent = text;
    element.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
  }, value);
}

export async function fillDraft(page: Page, title: string, body: string): Promise<void> {
  await setEditorValue(page, 'title', title);
  await setEditorValue(page, 'body', body);
}

export interface StoredDraft {
  schemaVersion: number;
  draftId: string;
  title: string;
  body: string;
  updatedAt: string;
}

export async function readDraft(page: Page): Promise<StoredDraft | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as StoredDraft);
  }, DRAFT_KEY);
}

export async function waitForDraftSaved(page: Page): Promise<StoredDraft> {
  await expect.poll(async () => (await readDraft(page)) !== null).toBe(true);
  const draft = await readDraft(page);
  expect(draft).not.toBeNull();
  return draft as StoredDraft;
}

export async function editorText(page: Page): Promise<{ title: string; body: string }> {
  return page.evaluate(() => ({
    title: document.querySelector<HTMLElement>('[data-testid="post-title"]')?.textContent ?? '',
    body: document.querySelector<HTMLElement>('[data-testid="post-body"]')?.textContent ?? '',
  }));
}

export async function ensureDrawer(page: Page, open: boolean): Promise<void> {
  const menu = page.getByRole('button', { name: 'Menu' });
  const expanded = (await menu.getAttribute('aria-expanded')) === 'true';
  if (expanded !== open) {
    await menu.click();
  }
  await expect(menu).toHaveAttribute('aria-expanded', String(open), { timeout: 5_000 });
  await expect(page.locator('html')).toHaveAttribute('data-drawer-open', String(open));
  await expect(page.locator('#site-drawer')).toHaveCSS('visibility', open ? 'visible' : 'hidden');
}

export interface YearState {
  year: string;
  expanded: boolean;
  listHidden: boolean;
  current: string | null;
  label: string;
}

export async function readYearState(page: Page): Promise<YearState[]> {
  return page.$$eval('[data-year-toggle]', (links) =>
    links.map((link) => {
      const listId = link.getAttribute('aria-controls');
      const list = listId ? document.getElementById(listId) : null;
      return {
        year: (link as HTMLElement).dataset.year ?? '',
        expanded: link.getAttribute('aria-expanded') === 'true',
        listHidden: list ? list.hidden : true,
        current: link.getAttribute('aria-current'),
        label: link.textContent?.trim() ?? '',
      };
    }),
  );
}

export async function drawerScrollTop(page: Page): Promise<number> {
  return page.locator('[data-drawer-scroll]').evaluate((element) => element.scrollTop);
}

export async function scrollDrawer(page: Page, deltaY: number): Promise<void> {
  const box = await page.locator('[data-drawer-scroll]').boundingBox();
  if (!box) throw new Error('drawer scroller has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 80));
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(350);
}

export async function pageScrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

export async function horizontalOverflow(page: Page): Promise<{
  clientWidth: number;
  scrollWidth: number;
  bodyScrollWidth: number;
}> {
  return page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

export interface NetworkEntry {
  method: string;
  url: string;
  resourceType: string;
}

export function trackNetwork(page: Page): NetworkEntry[] {
  const entries: NetworkEntry[] = [];
  page.on('request', (request) => {
    entries.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
    });
  });
  return entries;
}

export interface TopbarSnapshot {
  topbar: { x: number; y: number; width: number; height: number };
  menu: { x: number; y: number; width: number; height: number };
  brand: { x: number; y: number; width: number; height: number; text: string };
  drawer: { x: number; y: number; width: number; height: number };
  main: { x: number; y: number; width: number; height: number };
  pseudoBackground: string;
  barBackground: string;
  brandWrap: string;
  brandWordRects: { word: string; rects: number }[];
  viewport: { width: number; height: number };
}

export async function readTopbar(page: Page): Promise<TopbarSnapshot> {
  return page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (!element) throw new Error('missing geometry element');
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const topbar = document.querySelector('.top-bar');
    const menu = document.querySelector('.menu-trigger');
    const brand = document.querySelector('.site-brand');
    const drawer = document.querySelector('.site-drawer');
    const main = document.querySelector('main');
    if (!topbar || !menu || !brand || !drawer || !main) {
      throw new Error('shell geometry elements are missing');
    }
    const brandText = (brand.textContent ?? '').trim();
    const node = brand.firstChild;
    const words: { word: string; rects: number }[] = [];
    if (node && node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      const matcher = /\S+/g;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(text)) !== null) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        words.push({ word: match[0], rects: range.getClientRects().length });
      }
    }
    return {
      topbar: rect(topbar),
      menu: rect(menu),
      brand: { ...rect(brand), text: brandText },
      drawer: rect(drawer),
      main: rect(main),
      pseudoBackground: getComputedStyle(topbar, '::before').backgroundColor,
      barBackground: getComputedStyle(topbar).backgroundColor,
      brandWrap: getComputedStyle(brand).overflowWrap,
      brandWordRects: words,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

export function expectNoHorizontalOverflow(
  metrics: { clientWidth: number; scrollWidth: number; bodyScrollWidth: number },
  label: string,
): void {
  expect(metrics.scrollWidth, `${label}: documentElement.scrollWidth`).toBeLessThanOrEqual(
    metrics.clientWidth + 1,
  );
  expect(metrics.bodyScrollWidth, `${label}: body.scrollWidth`).toBeLessThanOrEqual(
    metrics.clientWidth + 1,
  );
}

export interface LinkEntry {
  text: string;
  href: string;
  absolute: string;
  inTopbar: boolean;
}

export async function readShellLinks(page: Page): Promise<LinkEntry[]> {
  return page.evaluate(() => {
    const topbar = document.querySelector('.top-bar');
    const drawer = document.querySelector('.site-drawer');
    return Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .filter((link) => topbar?.contains(link) || drawer?.contains(link))
      .map((link) => ({
        text: (link.textContent ?? '').replace(/\s+/g, ' ').trim(),
        href: link.getAttribute('href') ?? '',
        absolute: link.href,
        inTopbar: Boolean(topbar?.contains(link)),
      }));
  });
}

export function currentPath(page: Page): string {
  return new URL(page.url()).pathname;
}

export function currentUrl(page: Page): string {
  return page.url();
}
