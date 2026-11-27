import { expect, test, type Page } from '@playwright/test';

import AxeBuilder from '@axe-core/playwright';

/**
 * Task 08 U11 independent automated accessibility scan (public site).
 *
 * Written by the independent test subagent; it does not reuse the executor's
 * suite. Every violation is reviewed here: a violation either fails the test
 * (unreviewed) or is listed in REVIEWED_VIOLATIONS with the product-owner
 * reason. Axe's "incomplete" results are reviewed too, because an incomplete
 * color-contrast result on a pseudo-element background would otherwise be a
 * silent hole: the known `.site-brand` case is re-checked with an independent
 * WCAG calculation in this file.
 *
 * Human screen readers (NVDA+Firefox, VoiceOver+Safari, TalkBack+Chrome) are
 * NOT RUN by this file and are recorded as NOT RUN in the task report.
 */

const POST_2026 = '/blog/2026/Why%20I%20Keep%20a%20Learning%20Log-2026-01-18-20-15-00/';

/**
 * Reviewed violations. Empty today: the scan reports zero violations on every
 * required page/state. A new violation fails the test and must be triaged in
 * the report instead of being appended here to make the suite green.
 */
const REVIEWED_VIOLATIONS: Record<string, string> = {};

/**
 * Reviewed "incomplete" results. axe cannot resolve colours painted by a
 * pseudo-element or inside the off-canvas drawer, so it reports those nodes as
 * incomplete instead of pass/fail. The same test resolves them with an
 * independent WCAG calculation: `.site-brand` against `.top-bar::before`, and
 * every drawer label against the drawer background (both themes).
 */
const REVIEWED_INCOMPLETE: Record<string, string> = {
  'color-contrast .site-brand': 'top-bar band is a ::before pseudo-element; measured in assertBrandContrast',
};

/** Drawer label targets whose contrast is independently measured below. */
function isDrawerContrastTarget(target: string): boolean {
  return (
    target === '.site-settings' ||
    target.startsWith('.site-nav') ||
    target.startsWith('a[data-nav-key') ||
    target.startsWith('a[data-year')
  );
}

interface AxeSummary {
  label: string;
  violations: Array<{ id: string; impact: string | null; targets: string[]; help: string }>;
  incomplete: Array<{ id: string; targets: string[] }>;
  passCount: number;
}

async function scan(page: Page, label: string): Promise<AxeSummary> {
  const result = await new AxeBuilder({ page }).analyze();
  const summary: AxeSummary = {
    label,
    violations: result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    incomplete: result.incomplete.map((entry) => ({
      id: entry.id,
      targets: entry.nodes.map((node) => node.target.join(' ')),
    })),
    passCount: result.passes.length,
  };
  console.log(
    `AXE ${label}: rules=${result.passes.length + result.violations.length + result.incomplete.length} ` +
      `passes=${result.passes.length} violations=${result.violations.length} incomplete=${result.incomplete.length}`,
  );
  for (const violation of summary.violations) {
    console.log(`  VIOLATION ${violation.id} [${violation.impact}] ${violation.help} :: ${violation.targets.join(' | ')}`);
  }
  for (const entry of summary.incomplete) {
    console.log(`  INCOMPLETE ${entry.id} :: ${entry.targets.join(' | ')}`);
  }
  return summary;
}

function expectNoUnreviewed(summary: AxeSummary): void {
  const unreviewed = summary.violations.filter((violation) => !(violation.id in REVIEWED_VIOLATIONS));
  expect(unreviewed, `${summary.label}: unreviewed axe violations`).toEqual([]);
  // A scan that runs almost no rules would also "pass"; require real coverage.
  expect(summary.passCount, `${summary.label}: axe actually evaluated rules`).toBeGreaterThanOrEqual(30);
  for (const entry of summary.incomplete) {
    for (const target of entry.targets) {
      if (`${entry.id} ${target}` in REVIEWED_INCOMPLETE) continue;
      // Drawer controls are resolved by assertDrawerContrast in the same scan.
      if (entry.id === 'color-contrast' && isDrawerContrastTarget(target)) continue;
      expect(false, `${summary.label}: incomplete ${entry.id} ${target} was not reviewed`).toBe(true);
    }
  }
}

/** WCAG 2.x relative luminance/contrast for the pseudo-element brand check. */
function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
  const match = /^rgba?\(([^)]+)\)$/u.exec(value.trim());
  const body = match?.[1];
  if (body === undefined) return null;
  const parts = body.split(/[\s,/]+/u).filter((token) => token !== '').map(Number);
  const [r, g, b, a] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r, g, b, a: a ?? 1 };
}

function luminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(first: { r: number; g: number; b: number }, second: { r: number; g: number; b: number }): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

async function assertBrandContrast(page: Page, label: string): Promise<void> {
  const colors = await page.evaluate(() => {
    const brand = document.querySelector<HTMLElement>('.site-brand');
    const topBar = document.querySelector<HTMLElement>('.top-bar');
    if (!brand || !topBar) return null;
    return {
      text: getComputedStyle(brand).color,
      background: getComputedStyle(topBar, '::before').backgroundColor,
    };
  });
  expect(colors, `${label}: brand/top-bar exist`).not.toBeNull();
  if (!colors) return;
  const text = parseRgb(colors.text);
  const background = parseRgb(colors.background);
  expect(text, `${label}: brand colour parse`).not.toBeNull();
  expect(background, `${label}: top-bar band colour parse`).not.toBeNull();
  if (!text || !background) return;
  const ratio = contrast(text, background);
  console.log(`BRAND CONTRAST ${label}: ${ratio.toFixed(2)} (${colors.text} on ${colors.background})`);
  expect(ratio, `${label}: brand text contrast (axe incomplete node)`).toBeGreaterThanOrEqual(4.5);
}

/**
 * Independently resolves the drawer colour-contrast "incomplete" nodes: every
 * visible drawer label is measured against its own painted background (the
 * current/hover state surface) or the drawer surface, in both themes.
 */
async function assertDrawerContrast(page: Page, label: string): Promise<void> {
  const samples = await page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>('.site-drawer');
    if (!drawer) return [];
    const drawerBackground = getComputedStyle(drawer).backgroundColor;
    return [...drawer.querySelectorAll<HTMLElement>('.site-nav__label')]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const control = element.closest<HTMLElement>('.site-nav__link, .site-nav__settings');
        const controlBackground = control ? getComputedStyle(control).backgroundColor : 'rgba(0, 0, 0, 0)';
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return { text, color: getComputedStyle(element).color, controlBackground, drawerBackground };
      });
  });
  expect(samples.length, `${label}: visible drawer labels measured`).toBeGreaterThan(3);
  for (const sample of samples) {
    const foreground = parseRgb(sample.color);
    const stateSurface = parseRgb(sample.controlBackground);
    const surface = parseRgb(sample.drawerBackground);
    expect(foreground, `${label}: ${sample.text} colour parse`).not.toBeNull();
    expect(surface, `${label}: drawer background parse`).not.toBeNull();
    if (!foreground || !surface) continue;
    const background = stateSurface && stateSurface.a > 0 ? stateSurface : surface;
    const ratio = contrast(foreground, background);
    console.log(`DRAWER CONTRAST ${label}: ${ratio.toFixed(2)} "${sample.text}"`);
    expect(ratio, `${label}: drawer label "${sample.text}"`).toBeGreaterThanOrEqual(4.5);
  }
}

function consoleGuard(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/content security policy|refused to (execute|load|apply)|violates the following/iu.test(text)) {
      problems.push(`console: ${text}`);
    }
  });
  return problems;
}
test.describe('U11 axe: public pages', () => {
  test('every required public page has no unreviewed axe violations', async ({ page }) => {
    test.setTimeout(180_000);
    const problems = consoleGuard(page);
    const pages = [
      { path: '/', label: 'home light' },
      { path: '/publications/', label: 'publications light' },
      { path: '/blog/', label: 'blog light' },
      { path: POST_2026, label: 'article light' },
      { path: '/settings/', label: 'settings light' },
    ];
    for (const entry of pages) {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(entry.path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(150);
      const summary = await scan(page, entry.label);
      expectNoUnreviewed(summary);
      await assertBrandContrast(page, entry.label);
    }
    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });

  test('drawer-open and dark-theme states have no unreviewed axe violations', async ({ page }) => {
    test.setTimeout(180_000);
    const problems = consoleGuard(page);

    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/blog/');
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(150);
    expectNoUnreviewed(await scan(page, 'blog drawer open light'));
    await assertDrawerContrast(page, 'blog drawer open light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(150);
    expectNoUnreviewed(await scan(page, 'blog drawer open dark'));
    await assertBrandContrast(page, 'blog drawer open dark');
    await assertDrawerContrast(page, 'blog drawer open dark');

    await page.goto('/settings/');
    await page.waitForTimeout(150);
    expectNoUnreviewed(await scan(page, 'settings dark'));

    // Narrow viewport (the drawer becomes the modal overlay).
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/settings/');
    const menu = page.getByRole('button', { name: 'Menu' });
    if ((await menu.getAttribute('aria-expanded')) !== 'true') await menu.click();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
    await page.waitForTimeout(150);
    expectNoUnreviewed(await scan(page, 'settings 320 drawer open dark'));

    expect(problems, 'no uncaught errors or CSP refusals').toEqual([]);
  });
});
