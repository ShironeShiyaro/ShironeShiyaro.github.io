import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './console-guard.ts';
import { openApp, openAuthorizedApp, resetMock } from './helpers.ts';

/**
 * Task 08 U11 independent axe scan for the author origin (`/new/`), added by the
 * independent test subagent. Uses the console guard so a CSP violation or an
 * uncaught page error fails the scan as well; the Worker sends
 * `script-src 'self'`, and a broken inline script here must not pass silently.
 *
 * The gate and the editor are scanned separately. Real screen-reader passes are
 * NOT RUN (recorded in the task report), so this file cannot claim U11 on its
 * own.
 */

const REVIEWED_VIOLATIONS: Record<string, string> = {};

interface AxeSummary {
  label: string;
  violations: Array<{ id: string; impact: string | null; targets: string[]; help: string }>;
  incomplete: Array<{ id: string; targets: string[] }>;
  passCount: number;
}

async function scan(page: import('@playwright/test').Page, label: string): Promise<AxeSummary> {
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
    `AUTHOR AXE ${label}: passes=${result.passes.length} violations=${result.violations.length} incomplete=${result.incomplete.length}`,
  );
  for (const violation of summary.violations) {
    console.log(
      `  VIOLATION ${violation.id} [${violation.impact}] ${violation.help} :: ${violation.targets.join(' | ')}`,
    );
  }
  for (const entry of summary.incomplete) {
    console.log(`  INCOMPLETE ${entry.id} :: ${entry.targets.join(' | ')}`);
  }
  return summary;
}

/** Controls painted on the top-bar band that axe reports as incomplete. */
const TOP_BAR_CONTROLS = ['.site-brand', '.shell-actions__button'];

function expectClean(summary: AxeSummary): void {
  const unreviewed = summary.violations.filter((violation) => !(violation.id in REVIEWED_VIOLATIONS));
  expect(unreviewed, `${summary.label}: unreviewed axe violations`).toEqual([]);
  expect(summary.passCount, `${summary.label}: axe actually evaluated rules`).toBeGreaterThanOrEqual(20);
  // The top-bar controls sit over the `.top-bar::before` band, which axe cannot
  // resolve; assertTopBarContrast measures each one independently below.
  const unresolved = summary.incomplete.filter(
    (entry) =>
      !(
        entry.id === 'color-contrast' &&
        entry.targets.every((target) => TOP_BAR_CONTROLS.includes(target))
      ),
  );
  expect(unresolved, `${summary.label}: incomplete results need review`).toEqual([]);
}

interface Rgba {
  r: number;
  g: number;
  b: number;
}

function parseRgb(value: string): Rgba | null {
  const match = /^rgba?\(([^)]+)\)$/u.exec(value.trim());
  const body = match?.[1];
  if (body === undefined) return null;
  const parts = body.split(/[\s,/]+/u).filter((token) => token !== '').map(Number);
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r, g, b };
}

function relativeLuminance(color: Rgba): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(first: Rgba, second: Rgba): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

/** Resolves the axe "incomplete" top-bar nodes against the painted band. */
async function assertTopBarContrast(page: import('@playwright/test').Page, label: string): Promise<void> {
  for (const selector of TOP_BAR_CONTROLS) {
    const colors = await page.evaluate((targetSelector) => {
      const control = document.querySelector<HTMLElement>(targetSelector);
      const topBar = document.querySelector<HTMLElement>('.top-bar');
      if (!control || !topBar) return null;
      return {
        text: getComputedStyle(control).color,
        background: getComputedStyle(topBar, '::before').backgroundColor,
      };
    }, selector);
    if (!colors) continue;
    const text = parseRgb(colors.text);
    const background = parseRgb(colors.background);
    if (!text || !background) {
      expect(false, `${label}: ${selector} colours parse (${JSON.stringify(colors)})`).toBe(true);
      continue;
    }
    const ratio = contrast(text, background);
    console.log(
      `AUTHOR TOPBAR CONTRAST ${label} ${selector}: ${ratio.toFixed(2)} (${colors.text} on ${colors.background})`,
    );
    expect(ratio, `${label}: ${selector} contrast (axe incomplete node)`).toBeGreaterThanOrEqual(4.5);
  }
}

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.describe('U11 axe: author origin', () => {
  test('/new/ gate and editor have no unreviewed axe violations', async ({ page }) => {
    test.setTimeout(120_000);

    // Gate: an unauthenticated visitor only sees the author statement.
    await openApp(page);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expectClean(await scan(page, 'author gate'));
    await assertTopBarContrast(page, 'author gate');

    // Editor: sign in through the mock session, wait for the editor state.
    await openAuthorizedApp(page);
    await expect(page.getByTestId('post-title')).toBeVisible();
    expectClean(await scan(page, 'author editor'));
    await assertTopBarContrast(page, 'author editor');

    // Editing a longer title/body must not break the named controls.
    await page.getByTestId('post-title').click();
    await page.keyboard.insertText('An accessible editing title');
    await page.getByTestId('post-body').click();
    await page.keyboard.insertText('A body paragraph with a link-like token and enough text.');
    expectClean(await scan(page, 'author editor with content'));
  });

  test('the author shell footer is not mojibake/corrupted text', async ({ page }) => {
    // The independent code review found a `漏` where the footer must render the
    // copyright sign; a test that only checks the year would miss it.
    await openApp(page);
    const footer = await page.locator('.site-footer').innerText();
    console.log(`AUTHOR FOOTER: ${JSON.stringify(footer)}`);
    expect(footer, 'the footer shows a real copyright sign').toContain('\u00a9');
    expect(footer, 'no replacement/mojibake characters').not.toMatch(/[\ufffd\u6f0f]/u);
    expect(footer, 'the footer keeps the year and the author name').toMatch(/\u00a9\s*\d{4}\s+Xinyang Zeng/u);
  });

  test('U08 keyboard-only: gate -> sign in -> editor -> publish button, no positive tabindex', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await expect(page.getByTestId('auth-continue')).toBeVisible();

    const activeTestId = () =>
      page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? '');
    const tabUntilTestId = async (testId: string, max = 80): Promise<boolean> => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let index = 0; index < max; index += 1) {
        await page.keyboard.press('Tab');
        if ((await activeTestId()) === testId) return true;
      }
      return false;
    };

    // Keyboard-only sign-in: Tab to Continue and activate it with Enter.
    expect(await tabUntilTestId('auth-continue'), 'Continue is reachable with Tab from the page start').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('post-title')).toBeVisible();
    await expect(page.getByTestId('logout-button')).toBeVisible();

    // The editor fields and the publish button are keyboard reachable; the mock
    // publish stops at the visible button (no network publish is attempted).
    expect(await tabUntilTestId('post-title'), 'the title field is keyboard reachable').toBe(true);
    await page.keyboard.insertText('A keyboard-only draft');
    expect(await tabUntilTestId('post-body'), 'the body field is keyboard reachable').toBe(true);
    await page.keyboard.insertText('Typed with the keyboard only.');
    expect(await tabUntilTestId('publish-button'), 'Publish is reachable with Tab').toBe(true);
    await expect(page.getByTestId('publish-button')).toBeVisible();
    await expect(page.getByTestId('publish-button')).toBeEnabled();

    const positiveTabindex = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('[tabindex]')].filter(
          (element) => Number(element.getAttribute('tabindex')) > 0,
        ).length,
    );
    expect(positiveTabindex, 'the author editor has no positive tabindex').toBe(0);
  });
});
