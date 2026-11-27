import type { Locator, Page } from '@playwright/test';
import { expect, test } from './console-guard.ts';
import {
  authorize,
  openApp,
  typeBody,
  typeTitle,
  resetMock,
} from './helpers.ts';

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function elementWithinViewport(page: Page, locator: Locator, width: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) {
    return;
  }
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
}

async function rectsOverlap(page: Page, locators: Locator[]): Promise<boolean> {
  const boxes = [];
  for (const locator of locators) {
    boxes.push(await locator.boundingBox());
  }
  for (let first = 0; first < boxes.length; first += 1) {
    for (let second = first + 1; second < boxes.length; second += 1) {
      const a = boxes[first];
      const b = boxes[second];
      if (!a || !b || a.width === 0 || b.width === 0) {
        continue;
      }
      const horizontal = a.x < b.x + b.width && b.x < a.x + a.width;
      const vertical = a.y < b.y + b.height && b.y < a.y + a.height;
      if (horizontal && vertical) {
        return true;
      }
    }
  }
  return false;
}

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.describe('E14 at 320 CSS px with keyboard only', () => {
  test.use({ viewport: { width: 320, height: 568 } });

  test('editing, restore, mock authorization and publish work without horizontal overflow', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the gate first (no editor), then the keyboard-only sign-in opens it.
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    for (const testId of ['back-to-blog', 'auth-continue']) {
      await elementWithinViewport(page, page.getByTestId(testId), 320);
    }
    await page.getByTestId('auth-continue').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(page.getByTestId('post-title')).toBeVisible();

    await typeTitle(page, `A long title ${'x'.repeat(40)}`);
    await typeBody(page, `A long body token ${'y'.repeat(120)}\nSecond line.`);
    await expect.poll(() => horizontalOverflow(page)).toBeLessThanOrEqual(1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    for (const testId of ['publish-button', 'discard-button', 'preview-toggle']) {
      await elementWithinViewport(page, page.getByTestId(testId), 320);
    }

    await page.getByTestId('publish-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    // D32: the success page owns the terminal state and its exits fit 320px.
    for (const testId of ['back-to-blog', 'check-deployment', 'new-post']) {
      await elementWithinViewport(page, page.getByTestId(testId), 320);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(activeTag).not.toBe('BODY');
  });

  test('200% text keeps controls visible and does not overflow', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '32px';
    });
    await authorize(page);
    await typeTitle(page, 'Scaled title');
    await typeBody(page, 'Scaled body keeps working.');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    await page.getByTestId('publish-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    for (const testId of ['back-to-blog', 'check-deployment', 'new-post']) {
      await elementWithinViewport(page, page.getByTestId(testId), 320);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('longer translated labels do not overlap controls and all UI text is English', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await page.addStyleTag({
      content: 'button, .back-link, summary, label > span { font-size: 150%; letter-spacing: 0.04em; }',
    });
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    const buttons = [
      page.getByTestId('publish-button'),
      page.getByTestId('discard-button'),
      page.getByTestId('preview-toggle'),
      page.getByTestId('logout-button'),
    ];
    expect(await rectsOverlap(page, buttons)).toBe(false);

    const mainText = await page.locator('main').innerText();
    expect(mainText).not.toMatch(/[\u4e00-\u9fff]/);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  });

  test('reduced motion changes nothing functionally and removes spatial transitions', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    await authorize(page);
    const transition = await page.getByTestId('publish-button').evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: style.transitionDuration, property: style.transitionProperty };
    });
    expect(transition.duration.split(',')[0]).toBe('0s');

    await typeTitle(page, 'Reduced motion');
    await typeBody(page, 'Publishes without animation.');
    await page.getByTestId('publish-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
  });
});
