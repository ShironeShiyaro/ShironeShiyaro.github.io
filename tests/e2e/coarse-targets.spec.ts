import { expect, test, type Page } from '@playwright/test';

/**
 * Coarse-pointer target size audit (task 08 acceptance, DEF-08-01).
 *
 * At 320px with `(pointer: coarse)`, every standalone control/action link must
 * be at least 44x44 CSS px: WCAG 2.5.5 plus the visual contract's coarse rule.
 * Inline links inside prose are exempt (WCAG 2.5.8 inline exception), so the
 * scanner classifies a link as inline only when its paragraph has prose text
 * outside the link. Radio/checkbox inputs are measured through their wrapping
 * `<label>`, which is the actual target.
 */
const PAGES = [
  { path: '/', label: 'Home' },
  { path: '/publications/', label: 'Publications' },
  { path: '/blog/', label: 'Blog' },
  {
    path: '/blog/2025/Building%20a%20Quiet%20Homepage-2025-03-14-09-30-00/',
    label: 'Blog post',
  },
  { path: '/settings/', label: 'Settings' },
];

interface TargetInfo {
  tag: string;
  className: string;
  text: string;
  width: number;
  height: number;
  inlineProse: boolean;
}

test.use({ viewport: { width: 320, height: 800 }, hasTouch: true });

async function readTargets(page: Page): Promise<TargetInfo[]> {
  return page.evaluate(() => {
    const elements = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, summary, select, input:not([type="hidden"]), [role="button"]',
      ),
    ];
    const targets: TargetInfo[] = [];
    for (const element of elements) {
      // A radio/checkbox input is not the target: its wrapping label is.
      const labelled =
        element instanceof HTMLInputElement &&
        (element.type === 'radio' || element.type === 'checkbox') &&
        element.closest('label') !== null;
      const target = labelled ? (element.closest('label') as HTMLElement) : element;
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        target.getClientRects().length === 0
      ) {
        continue;
      }
      // Inline exception: a link that sits inside a paragraph which has real
      // prose text outside the link. Standalone actions in their own paragraph
      // (the Publications "Code" row, button rows) stay in scope.
      let inlineProse = false;
      const paragraph = element.closest('p');
      if (paragraph && paragraph.closest('.publication__actions, .button-row, .publication-links') === null) {
        const clone = paragraph.cloneNode(true) as HTMLElement;
        for (const nested of clone.querySelectorAll('a, button')) nested.remove();
        inlineProse = (clone.textContent ?? '').replace(/\s+/g, ' ').trim().length > 20;
      }
      targets.push({
        tag: target.tagName,
        className: typeof target.className === 'string' ? target.className : '',
        text: (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        inlineProse,
      });
    }
    return targets;
  });
}

test('coarse pointer: every standalone target is at least 44x44 at 320px', async ({ page }) => {
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

  for (const entry of PAGES) {
    await page.goto(entry.path);
    await expect(page.locator('main h1')).toBeVisible();
    const targets = await readTargets(page);
    expect(targets.length, `${entry.label}: targets were found`).toBeGreaterThan(2);
    for (const target of targets.filter((item) => !item.inlineProse)) {
      expect(
        target.width,
        `${entry.label}: "${target.text}" (${target.tag}.${target.className}) width`,
      ).toBeGreaterThanOrEqual(44);
      expect(
        target.height,
        `${entry.label}: "${target.text}" (${target.tag}.${target.className}) height`,
      ).toBeGreaterThanOrEqual(44);
    }
  }

  // DEF-08-01 regression: the short standalone "Code" action is explicitly
  // covered, and it must be in scope (not classified as inline prose).
  await page.goto('/publications/');
  const codeTargets = (await readTargets(page)).filter((target) =>
    target.className.includes('publication__action'),
  );
  expect(codeTargets.length, 'the Publications Code action exists').toBeGreaterThan(0);
  for (const target of codeTargets) {
    expect(target.inlineProse, 'the Code action is a standalone target').toBe(false);
    expect(target.width, 'Code action width').toBeGreaterThanOrEqual(44);
    expect(target.height, 'Code action height').toBeGreaterThanOrEqual(44);
  }
});
