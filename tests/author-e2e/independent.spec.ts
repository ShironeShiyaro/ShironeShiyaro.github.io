/**
 * Independent author E2E suite (task 06).
 *
 * Written from the frozen P0 criteria E01–E16 plus the total-control D22 note.
 * It is run by `tests/run-author-e2e-independent.mjs` on the ports assigned to
 * this independent role (test Worker 43253, production-mode Worker 43254).
 *
 * LIMIT notes:
 * - Real OS-level IME and browser translation are not injectable in headless
 *   Edge; composition is simulated with the real CompositionEvent/KeyboardEvent
 *   fields and translation growth is approximated by 150% control text.
 * - 200% OS text scale is approximated by a 32px root font size because all
 *   design tokens are rem-based (documented approximation, not real browser
 *   zoom).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './console-guard.ts';
import { parse as parseYaml } from 'yaml';
import {
  DRAFT_KEY,
  FIXED_CLOCK,
  PROD_BASE_URL,
  TEST_BASE_URL,
  authorize,
  backToEditor,
  chooseMockAuthOutcome,
  chooseMockPublishOutcome,
  continueWithGitHub,
  expectDraftSaved,
  frontMatterOf,
  openApp,
  readDraft,
  resetMock,
  setClock,
  setEditorValue,
  trackRequests,
  typeBody,
  typeTitle,
} from './helpers.ts';

const DATE = '2026-11-23';
const PUBLISH_PATH = '/api/mock/publish';

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  await setClock(request, FIXED_CLOCK);
});

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectInsideViewport(page: Page, locator: Locator, width: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, 'locator must be visible').not.toBeNull();
  if (!box) {
    return;
  }
  expect(box.x, 'left edge').toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, 'right edge').toBeLessThanOrEqual(width + 1);
}

async function overlap(page: Page, first: Locator, second: Locator): Promise<boolean> {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  if (!a || !b) {
    return false;
  }
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function caretIsInside(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    const selection = window.getSelection();
    return Boolean(
      element &&
        document.activeElement === element &&
        selection &&
        selection.rangeCount > 0 &&
        selection.anchorNode !== null &&
        element.contains(selection.anchorNode),
    );
  }, testId);
}

async function placeCaretAtEnd(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

async function expectEnglishErrors(page: Page, patterns: RegExp[]): Promise<void> {
  const list = page.locator('.field-errors li');
  await expect(list.first()).toBeVisible();
  const messages = await list.allInnerTexts();
  expect(messages.length).toBeGreaterThanOrEqual(patterns.length);
  for (const pattern of patterns) {
    expect(messages.some((message) => pattern.test(message)), String(pattern)).toBe(true);
  }
  for (const message of messages) {
    expect(message).toMatch(/^[A-Z][\x20-\x7E"'()\u2014.,:;]+$/);
  }
}

async function readStoredDraftField<T = unknown>(page: Page, key: string): Promise<T | null> {
  return page.evaluate(
    ({ storageKey, field }) => {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) {
        return null;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return (parsed[field] as T) ?? null;
    },
    { storageKey: DRAFT_KEY, field: key },
  );
}

async function openMockControlsCheckbox(page: Page): Promise<void> {
  const details = page.getByTestId('mock-controls');
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator('summary').click();
  }
}

test.describe('editor surface (E01-E03)', () => {
  test('E01: borderless article typography, programmatic labels and a real caret', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const title = page.getByTestId('post-title');
    const body = page.getByTestId('post-body');

    await expect(title).toHaveAccessibleName('Post title');
    await expect(body).toHaveAccessibleName('Post body in Markdown');
    await expect(title).toHaveRole('textbox');
    await expect(title).toHaveAttribute('aria-multiline', 'false');
    await expect(body).toHaveAttribute('aria-multiline', 'true');
    expect(await page.locator('.post-editor input, .post-editor textarea').count()).toBe(0);

    // D30: the long intro is gone, so the editable article title is the page's
    // only h1 and there is no "New post" heading above the editor. R075-4 also
    // hides the whole editor behind the author gate, so this is the signed-in view.
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveClass(/post-title/);
    await expect(page.locator('#page-heading')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'New post' })).toHaveCount(0);

    const chrome = await page.evaluate(() => {
      const read = (element: Element | null) => {
        if (!element) {
          return null;
        }
        const style = getComputedStyle(element);
        return {
          borderTop: style.borderTopWidth,
          borderRight: style.borderRightWidth,
          borderBottom: style.borderBottomWidth,
          borderLeft: style.borderLeftWidth,
          borderStyle: style.borderStyle,
          background: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          boxShadow: style.boxShadow,
          outlineStyle: style.outlineStyle,
          appearance: style.appearance,
        };
      };
      return {
        title: read(document.querySelector('[data-testid="post-title"]')),
        body: read(document.querySelector('[data-testid="post-body"]')),
        editor: read(document.querySelector('.post-editor')),
        titleParent: read(document.querySelector('.post-title')),
      };
    });
    for (const [name, style] of Object.entries(chrome)) {
      expect(style, name).not.toBeNull();
      expect(style?.borderTop, `${name} top border`).toBe('0px');
      expect(style?.borderRight, `${name} right border`).toBe('0px');
      expect(style?.borderBottom, `${name} bottom border`).toBe('0px');
      expect(style?.borderLeft, `${name} left border`).toBe('0px');
      expect(style?.borderStyle, `${name} border style`).toBe('none');
      expect(style?.background, `${name} background`).toBe('rgba(0, 0, 0, 0)');
      expect(style?.backgroundImage, `${name} background image`).toBe('none');
      expect(style?.boxShadow, `${name} shadow`).toBe('none');
      expect(style?.appearance, `${name} native appearance`).toBe('none');
    }

    const typography = await page.evaluate(() => {
      const titleElement = document.querySelector('[data-testid="post-title"]');
      const bodyElement = document.querySelector('[data-testid="post-body"]');
      if (!titleElement || !bodyElement) {
        return null;
      }
      const read = (element: Element) => {
        const style = getComputedStyle(element);
        return {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          color: style.color,
          textAlign: style.textAlign,
        };
      };
      return {
        title: read(titleElement),
        body: read(bodyElement),
      };
    });
    expect(typography).not.toBeNull();
    // Expected values come from the public site's article CSS + design tokens:
    // h1 = --font-size-3xl (2.25rem=36px), bold 700, --line-height-tight 1.2;
    // body = 1rem, 400, --line-height-relaxed 1.7; text = #202020 in light mode.
    expect(typography?.title).toEqual({
      fontFamily: typography?.title.fontFamily,
      fontSize: '36px',
      fontWeight: '700',
      lineHeight: '43.2px',
      color: 'rgb(32, 32, 32)',
      textAlign: 'start',
    });
    expect(typography?.body).toEqual({
      fontFamily: typography?.title.fontFamily,
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: '27.2px',
      color: 'rgb(32, 32, 32)',
      textAlign: 'start',
    });
    expect(typography?.title.fontFamily).toContain('system-ui');
    expect(typography?.body.fontFamily).toBe(typography?.title.fontFamily);

    await title.click();
    await expect.poll(() => caretIsInside(page, 'post-title')).toBe(true);
    await body.click();
    await expect.poll(() => caretIsInside(page, 'post-body')).toBe(true);
  });

  test('E02: title cannot gain a newline, body keeps multi-line Markdown, exactly one hr', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const title = page.getByTestId('post-title');
    const body = page.getByTestId('post-body');

    await typeTitle(page, 'One line title');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.insertText(' stays one line');
    await expect(title).toHaveText('One line title stays one line');
    expect((await title.textContent())?.includes('\n')).toBe(false);
    expect((await title.textContent())?.startsWith('#')).toBe(false);

    await body.click();
    await page.keyboard.insertText('line one');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('line two');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('- list item');
    await expect(body).toHaveText('line one\nline two\n- list item');
    const bodyHtml = await body.evaluate((element) => element.innerHTML);
    expect(bodyHtml).not.toContain('<p');
    expect(bodyHtml).not.toContain('<div');
    expect(bodyHtml).not.toContain('<br');

    await expect(page.locator('.post-editor hr')).toHaveCount(1);
    await expect(page.getByTestId('post-date')).toHaveText(DATE);
    expect(await page.locator('.post-editor input, .post-editor textarea').count()).toBe(0);
  });

  test('E03: IME composition Enter does not corrupt/submit, paste stays plain, Publish is explicit', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const title = page.getByTestId('post-title');
    const body = page.getByTestId('post-body');
    const publishRequests = trackRequests(page, PUBLISH_PATH);

    // Composition event sequence used by Chromium/Safari while an IME candidate
    // window is open. LIMIT: real OS IME cannot be installed in headless Edge.
    await title.click();
    await title.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
      element.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '中文标题' }),
      );
    });
    await page.keyboard.insertText('中文标题');
    await expect(title).toHaveText('中文标题');
    expect((await title.textContent())?.includes('\n')).toBe(false);

    // Rich paste into the body: only text/plain may survive.
    await body.click();
    await body.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'Pasted **plain**\nsecond line');
      transfer.setData('text/html', '<b>rich</b><img src=x onerror=alert(1)><p>block</p>');
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      element.dispatchEvent(event);
    });
    await expect(body).toHaveText('Pasted **plain**\nsecond line');
    const html = await body.evaluate((element) => element.innerHTML);
    expect(html.toLowerCase()).not.toContain('<b>');
    expect(html.toLowerCase()).not.toContain('<img');
    expect(html.toLowerCase()).not.toContain('onerror');

    // HTML-only clipboard data must not inject markup either.
    const before = await body.textContent();
    await body.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData('text/html', '<h2>only html</h2>');
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      element.dispatchEvent(event);
    });
    expect(await body.textContent()).toBe(before);

    // Pasting a multi-line rich title into the single-line field collapses it.
    await setEditorValue(page, 'title', '');
    await title.click();
    await title.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'Line one\nLine two\tTabbed');
      transfer.setData('text/html', '<h1>Line one</h1><p>Line two</p>');
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      element.dispatchEvent(event);
    });
    await expect(title).toHaveText('Line one Line two Tabbed');
    expect((await title.textContent())?.includes('\n')).toBe(false);

    // R075-4: with the author signed in Publish is enabled, but it stays an
    // explicit click — no IME/paste/Enter sequence sends a request.
    await expect(page.getByTestId('publish-button')).toBeEnabled();
    await page.waitForTimeout(1_000);
    expect(publishRequests).toEqual([]);
  });
});

test.describe('validation and Markdown output (E04-E07)', () => {
  test('E04: empty/61/232-byte/256KiB violations show English errors and send no publish request', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    const publishRequests = trackRequests(page, PUBLISH_PATH);
    const publish = page.getByTestId('publish-button');

    await setEditorValue(page, 'title', '');
    await setEditorValue(page, 'body', '');
    await publish.click();
    await expectEnglishErrors(page, [/Enter a title before publishing\./, /Enter the post body before publishing\./]);
    await expect(page.getByTestId('post-title')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('post-body')).toHaveAttribute('aria-invalid', 'true');
    expect(publishRequests).toEqual([]);

    await setEditorValue(page, 'title', 'a'.repeat(61));
    await setEditorValue(page, 'body', 'Body text');
    await publish.click();
    await expect(page.getByText(/60 characters or fewer/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    // 59 astral code points: under the 60-code-point cap but 236 UTF-8 bytes
    // after file-name sanitisation, so only the byte rule may reject it.
    await setEditorValue(page, 'title', '😀'.repeat(59));
    await publish.click();
    await expect(page.getByText(/too long for a file name/)).toBeVisible();
    await expect(page.getByText(/232 UTF-8 bytes/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    await setEditorValue(page, 'title', 'Body size limit');
    await setEditorValue(page, 'body', 'a'.repeat(256 * 1024 + 1));
    await publish.click();
    await expect(page.getByText(/256 KiB or smaller/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    await expect(page.getByTestId('post-body')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('post-body')).toHaveAttribute('aria-describedby', 'editor-errors');
    expect(publishRequests).toEqual([]);
  });

  test('E04: 60 code points, exactly 232 safe bytes and exactly 256 KiB are publishable', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);

    const publishAndCapture = async () => {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
      );
      await page.getByTestId('publish-button').click();
      const response = await responsePromise;
      expect(response.status()).toBe(201);
      return (await response.json()) as { markdown: string; visibleMarkdown: string; date: string };
    };

    await setEditorValue(page, 'title', 'a'.repeat(60));
    await setEditorValue(page, 'body', 'Sixty code points.');
    const sixty = await publishAndCapture();
    expect(sixty.visibleMarkdown.startsWith(`# ${'a'.repeat(60)}\n\n${DATE}\n\n---\n\n`)).toBe(true);

    // D32: a successful publish leaves the editor, so return for the next size.
    await backToEditor(page);
    await setEditorValue(page, 'title', '😀'.repeat(58));
    await setEditorValue(page, 'body', 'Exactly 232 safe bytes.');
    const bytes = await publishAndCapture();
    expect(bytes.visibleMarkdown.split('\n')[0]).toBe(`# ${'😀'.repeat(58)}`);

    await backToEditor(page);
    await setEditorValue(page, 'title', 'Exact body size');
    await setEditorValue(page, 'body', 'x'.repeat(256 * 1024));
    const size = await publishAndCapture();
    expect(size.markdown).toContain(`${'x'.repeat(1024)}`);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
  });

  test('E05: fixed clock yields only title/date front matter and the exact visible Markdown', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the date lives in the editor, which exists only after sign-in.
    await authorize(page);
    await expect(page.getByTestId('post-date')).toHaveText(DATE);
    expect(await page.locator('input[type="date"]').count()).toBe(0);
    await setEditorValue(page, 'title', 'Example Post');
    await setEditorValue(page, 'body', 'Body Markdown stays exactly as the author wrote it.');

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const body = (await response.json()) as {
      markdown: string;
      visibleMarkdown: string;
      frontMatter: string;
      date: string;
      timestamp: string;
      commit: { path: string };
      deployment: { status: string };
    };

    expect(body.markdown).toBe(
      '---\ntitle: Example Post\ndate: 2026-11-23\n---\n\n' +
        '# Example Post\n\n2026-11-23\n\n---\n\n' +
        'Body Markdown stays exactly as the author wrote it.\n',
    );
    expect(body.visibleMarkdown).toBe(
      '# Example Post\n\n2026-11-23\n\n---\n\n' +
        'Body Markdown stays exactly as the author wrote it.\n',
    );
    expect(body.frontMatter).toBe('title: Example Post\ndate: 2026-11-23\n');
    const parsed = parseYaml(body.frontMatter) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['date', 'title']);
    expect(parsed.title).toBe('Example Post');
    expect(parsed.date).toBe(DATE);
    expect(body.date).toBe(DATE);
    expect(body.timestamp).toBe('2026-11-23-23-42-15');
    expect(body.commit.path).toBe('content/blog/2026/Example Post-2026-11-23-23-42-15.md');

    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText(/deployment is still pending/i)).toBeVisible();
    const statusText = await page.locator('.publish-status').innerText();
    expect(statusText).not.toMatch(/\bis live\b/i);
    expect(statusText).toContain('not live');
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toHaveAttribute('href', /^http:\/\/localhost:4321\/blog\/$/);
  });

  test('P1-2: publishing after Shanghai midnight updates the visible date to the written date', async ({
    page,
    request,
  }) => {
    await openApp(page);
    await authorize(page);
    await expect(page.getByTestId('post-date')).toHaveText(DATE);
    await setEditorValue(page, 'title', 'Midnight post');
    await setEditorValue(page, 'body', 'Published after midnight.');

    await setClock(request, '2026-11-23T18:42:15Z');
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const body = (await response.json()) as {
      date: string;
      timestamp: string;
      visibleMarkdown: string;
      commit: { path: string };
    };
    expect(body.date).toBe('2026-11-24');
    expect(body.timestamp).toBe('2026-11-24-02-42-15');
    expect(body.visibleMarkdown.split('\n')[2]).toBe('2026-11-24');
    expect(body.commit.path).toBe('content/blog/2026/Midnight post-2026-11-24-02-42-15.md');
    // D32: the editor left after the commit; the success page shows the written
    // path (which carries the rolled Shanghai date) instead of the editor date.
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByTestId('success-panel')).toContainText(
      'content/blog/2026/Midnight post-2026-11-24-02-42-15.md',
    );
  });

  test('P1-2: a window focus refreshes the server-owned date without publishing', async ({
    page,
    request,
  }) => {
    await openApp(page);
    // R075-4: the date lives in the editor, which exists only after sign-in.
    await authorize(page);
    await expect(page.getByTestId('post-date')).toHaveText(DATE);
    await setClock(request, '2026-11-23T18:42:15Z');
    expect(trackRequests(page, '/api/mock/publish')).toEqual([]);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.getByTestId('post-date')).toHaveText('2026-11-24');
    await expect(page.getByTestId('post-title')).toHaveText('');
  });

  test('E06: CRLF, leading/trailing blanks, lists, code and hashes survive verbatim', async ({
    page,
  }) => {
    const rawBody = [
      '',
      '',
      '# body hash line stays literal',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const value = "<tag> & `tick`";',
      '```',
      '',
      'trailing spaces kept   ',
      '',
      '',
      '',
    ].join('\r\n');

    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Preserved body');
    await setEditorValue(page, 'body', rawBody);
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const responseBody = (await response.json()) as { markdown: string; visibleMarkdown: string };

    const normalized = rawBody.replace(/\r\n?/g, '\n');
    const { visible } = frontMatterOf(responseBody.markdown);
    const prefix = `# Preserved body\n\n${DATE}\n\n---\n\n`;
    expect(visible.startsWith(prefix)).toBe(true);
    expect(visible.slice(prefix.length)).toBe(normalized);
    expect(responseBody.visibleMarkdown).toBe(visible);
    expect(responseBody.markdown).not.toContain('\r');
    expect(visible.startsWith(`${prefix}\n\n`)).toBe(true);
    expect(visible.endsWith('trailing spaces kept   \n\n\n')).toBe(true);
    expect(visible).toContain('- one\n- two');
    expect(visible).toContain('const value = "<tag> & `tick`";');
  });

  test('E07: YAML-safe quote/star/angle titles and reserved-character rejection', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    const title = 'A "B" * <C>';
    await setEditorValue(page, 'title', title);
    await setEditorValue(page, 'body', 'yaml safety');
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const responseBody = (await response.json()) as { markdown: string };
    const { source: yaml, visible } = frontMatterOf(responseBody.markdown);
    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['date', 'title']);
    expect(parsed.title).toBe(title);
    expect(visible.split('\n')[0]).toBe(`# ${title}`);
    expect(visible).toContain(`# ${title}\n\n${DATE}\n\n---\n\nyaml safety\n`);

    const publishRequests = trackRequests(page, PUBLISH_PATH);
    await backToEditor(page);
    await setEditorValue(page, 'title', 'Injected\nsecret: yes');
    await page.getByTestId('publish-button').click();
    await expect(page.getByText(/single line of plain text/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    // D22: all ten route-reserved characters are rejected before any request,
    // including `:`/`?` which the pre-fix round silently replaced.
    for (const character of ['#', '$', '&', '+', ',', ':', ';', '?', '=', '@']) {
      await setEditorValue(page, 'title', `Bad ${character} title`);
      await page.getByTestId('publish-button').click();
      await expect(
        page.getByText(new RegExp(`Title contains "${character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)),
      ).toBeVisible();
    }
    expect(publishRequests).toEqual([]);

    const state = await page.evaluate(() => ({
      active: document.activeElement?.getAttribute('data-testid'),
      errors: document.querySelectorAll('.field-errors li').length,
    }));
    expect(state.errors).toBeGreaterThan(0);
  });
});

test.describe('browser drafts and access states (E08-E10)', () => {
  test('E08: reload restores the draft; Discard needs confirmation and can be cancelled', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    await typeTitle(page, 'Reloaded draft');
    await typeBody(page, 'Body survives a reload.\n\n- item one');
    const saved = await expectDraftSaved(page);
    expect(Object.keys(saved).sort()).toEqual(
      ['draftId', 'schemaVersion', 'title', 'body', 'updatedAt'].sort(),
    );
    expect(saved.schemaVersion).toBe(1);

    await page.reload();
    await expect(page.getByTestId('post-title')).toHaveText('Reloaded draft');
    await expect(page.getByTestId('post-body')).toHaveText('Body survives a reload.\n\n- item one');
    await expect(page.getByText('Draft restored from this browser.')).toBeVisible();

    await page.getByTestId('discard-button').click();
    await expect(page.getByRole('heading', { name: 'Delete this draft?' })).toBeVisible();
    // P2-2: the safe action is focused first; Escape still cancels.
    await expect(page.getByTestId('discard-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Delete this draft?' })).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toHaveText('Reloaded draft');
    expect(await readStoredDraftField(page, 'title')).toBe('Reloaded draft');

    await page.getByTestId('discard-button').click();
    await page.getByTestId('discard-confirm').click();
    await expect(page.getByTestId('post-title')).toHaveText('');
    await expect(page.getByTestId('post-body')).toHaveText('');
    await expect(page.getByText('Draft deleted.')).toBeVisible();
    expect(await readDraft(page)).toBeNull();
    await expect(page.getByTestId('post-title')).toBeFocused();
  });

  test('E08: cancelled auth, mock 500 and conflict all keep the draft across a reload', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await typeTitle(page, 'Keep after failures');
    await typeBody(page, 'Draft survives cancelled auth, 500 and conflict.');
    await expectDraftSaved(page);

    // R075-4: signing out returns to the gate without clearing the draft; the
    // cancelled authorization keeps that same gate state.
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    expect((await readDraft(page))?.title).toBe('Keep after failures');

    await chooseMockAuthOutcome(page, 'cancelled');
    await continueWithGitHub(page);
    await expect(page.getByText(/GitHub authorization was cancelled/)).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expectDraftSaved(page);

    await page.reload();
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expectDraftSaved(page);

    await chooseMockAuthOutcome(page, 'authorized');
    await continueWithGitHub(page);
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveText('Keep after failures');

    await chooseMockPublishOutcome(page, 'server_error');
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Publishing failed' })).toBeVisible();
    await expectDraftSaved(page);
    await page.reload();
    await expect(page.getByTestId('post-title')).toHaveText('Keep after failures');

    await chooseMockPublishOutcome(page, 'conflict');
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Publishing conflict' })).toBeVisible();
    await expectDraftSaved(page);
    await page.reload();
    await expect(page.getByTestId('post-title')).toHaveText('Keep after failures');
    await expect(page.getByTestId('post-body')).toHaveText(
      'Draft survives cancelled auth, 500 and conflict.',
    );
  });

  test('E08: blocked localStorage keeps editing usable and says autosave is unavailable', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Storage is blocked', 'SecurityError');
        },
      });
    });
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    await typeTitle(page, 'No storage title');
    await typeBody(page, 'Editing still works without storage.');
    await expect(page.getByTestId('post-title')).toHaveText('No storage title');
    await expect(page.getByTestId('post-body')).toHaveText('Editing still works without storage.');
    await expect(page.getByText(/Autosave is unavailable because this browser blocked local storage/)).toBeVisible();
    expect(
      await page.evaluate(() => {
        try {
          window.localStorage.getItem('x');
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);

    await page.reload();
    await expect(page.getByTestId('post-title')).toHaveText('');
    await typeTitle(page, 'Still editable after reload');
    await expect(page.getByTestId('post-title')).toHaveText('Still editable after reload');

    // Publishing does not depend on storage; it still works explicitly.
    await authorize(page);
    await typeBody(page, 'Publish works with blocked storage.');
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
  });

  test('E10: anonymous never auto-OAuths for 30 seconds; Publish is unavailable; Back always works', async ({
    page,
  }) => {
    await openApp(page);
    const initialUrl = page.url();
    const authRequests = trackRequests(page, '/api/mock/auth');
    const externalRequests = trackRequests(page, 'github.com');
    const publishRequests = trackRequests(page, PUBLISH_PATH);

    await expect(page.getByText(/This page is where Xinyang Zeng writes Blog posts/)).toBeVisible();
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    // R075-4: no editor and no primary action before the author signs in.
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('discard-button')).toHaveCount(0);
    await expect(page.getByTestId('preview-toggle')).toHaveCount(0);
    await expect(page.getByTestId('logout-button')).toHaveCount(0);
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toHaveAttribute(
      'href',
      'http://localhost:4321/blog/',
    );

    await page.waitForTimeout(30_000);
    expect(page.url()).toBe(initialUrl);
    expect(authRequests).toEqual([]);
    expect(externalRequests).toEqual([]);
    expect(publishRequests).toEqual([]);
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await expect(page.getByTestId('publish-button')).toHaveCount(0);

    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(page.getByTestId('post-title')).toBeVisible();
    expect(authRequests).toHaveLength(1);
    await expect(page.getByTestId('publish-button')).toBeEnabled();
    await expect(page.getByTestId('logout-button')).toBeVisible();
    // D30: the authorized editor has no top-bar Back link; the shared shell's
    // Blog navigation is the (public-site) way back.
    await expect(page.getByTestId('back-to-blog')).toHaveCount(0);
    expect(page.url()).toBe(initialUrl);
  });

  test('E10/E11: pending and every mock authorization terminal state keep Back and disable Publish', async ({
    page,
  }) => {
    await openApp(page);
    const authPanel = page.locator('.status-panel--auth');
    const publish = page.getByTestId('publish-button');

    // Pending: observable because the mock Worker delays the decision by 400ms.
    await page.getByTestId('auth-continue').click();
    await expect(authPanel).toHaveAttribute('aria-busy', 'true');
    await expect(authPanel.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByText(/Waiting for GitHub authorization/)).toBeVisible();
    // R075-4: no editor while the authorization is still pending.
    await expect(publish).toHaveCount(0);
    await expect(page.getByTestId('logout-button')).toHaveCount(0);
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await expect(publish).toBeEnabled();

    // Start the terminal-state loop from anonymous again.
    await page.getByTestId('logout-button').click();
    await expect(page.getByTestId('auth-continue')).toBeVisible();

    const terminals: Array<{ outcome: string; text: RegExp }> = [
      { outcome: 'cancelled', text: /GitHub authorization was cancelled/ },
      { outcome: 'forbidden', text: /not the configured author/ },
      { outcome: 'expired', text: /Your GitHub authorization expired/ },
      { outcome: 'permission_denied', text: /cannot write to this repository/ },
    ];
    for (const terminal of terminals) {
      await chooseMockAuthOutcome(page, terminal.outcome);
      await continueWithGitHub(page);
      await expect(page.getByText(terminal.text)).toBeVisible();
      await expect(authPanel.getByTestId('auth-status-back')).toBeVisible();
      await expect(authPanel).not.toHaveAttribute('aria-busy', 'true');
      // R075-4: a terminal authorization state is still the gate.
      await expect(publish).toHaveCount(0);
      await expect(page.getByTestId('post-title')).toHaveCount(0);
      await expect(page.getByTestId('logout-button')).toHaveCount(0);
      const copy = await authPanel.innerText();
      expect(copy).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  test('P1-3: hanging initial date/session GETs reach bounded English terminals with explicit Retry', async ({
    page,
  }) => {
    await page.route('**/api/date', () => new Promise(() => {}));
    await page.route('**/api/mock/session', () => new Promise(() => {}));
    await page.goto('/');
    // R075-4: the gate shows the auth read; the editor (and the date UI) only
    // exists after sign-in, so the bounded date read is observed after it opens.
    await expect(page.getByText(/Checking GitHub authorization/)).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);

    // 12s hard timeout: the auth read must become an English terminal state, not spin.
    await expect(page.getByText(/Could not check GitHub authorization/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId('auth-retry')).toBeVisible();
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    await expect(page.getByText(/Could not check GitHub authorization/)).toBeVisible();

    await page.unroute('**/api/date');
    await page.unroute('**/api/mock/session');
    await page.getByTestId('auth-retry').click();
    // The mock session is anonymous now, so the gate offers Continue; the date
    // read failed in the background and its retry is in the opened editor.
    await expect(page.getByTestId('auth-continue')).toBeVisible();
    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('post-date')).toHaveText('Date unavailable');
    await expect(page.getByRole('button', { name: 'Retry date' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry date' }).click();
    await expect(page.getByTestId('post-date')).not.toHaveText(/Date unavailable|Loading date/);
  });
});

test.describe('bounded terminal states and publish races (E11-E13)', () => {
  test('E11: every mock failure reaches an English terminal state with Back, no retry loop, draft kept', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    const failures: Array<{ outcome: string; heading: string }> = [
      { outcome: 'conflict', heading: 'Publishing conflict' },
      { outcome: 'rate_limited', heading: 'Rate limit reached' },
      { outcome: 'server_error', heading: 'Publishing failed' },
      { outcome: 'timeout', heading: 'Publishing timed out' },
      { outcome: 'permission_denied', heading: 'Permission denied' },
    ];

    for (const failure of failures) {
      await setEditorValue(page, 'title', `Terminal ${failure.outcome}`);
      await setEditorValue(page, 'body', `Draft for ${failure.outcome}`);
      await chooseMockPublishOutcome(page, failure.outcome);
      const requests = trackRequests(page, PUBLISH_PATH);
      const startedAt = Date.now();
      await page.getByTestId('publish-button').click();
      await expect(page.getByRole('heading', { name: failure.heading })).toBeVisible({
        timeout: 12_000,
      });
      expect(Date.now() - startedAt).toBeLessThan(12_000);
      expect(requests).toHaveLength(1);
      await expect(page.locator('.publish-status').getByTestId('status-back')).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await expectDraftSaved(page);
      await page.waitForTimeout(1_000);
      expect(requests, `${failure.outcome} must not auto-retry`).toHaveLength(1);
      if (failure.outcome === 'rate_limited') {
        await expect(page.getByText(/Retry after about 30 seconds/)).toBeVisible();
      }
    }

    // Expired authorization is a terminal state that also disables Publish and
    // offers an explicit reauthorization. R075-4: it is a gate, so the publish
    // panel disappears and only the auth Back/reauthorize hooks remain.
    await setEditorValue(page, 'title', 'Expired terminal');
    await setEditorValue(page, 'body', 'Draft for expired');
    await chooseMockPublishOutcome(page, 'expired');
    await page.getByTestId('publish-button').click();
    await expect(page.getByText(/Your GitHub authorization expired/)).toBeVisible();
    await expect(page.getByTestId('status-back')).toHaveCount(0);
    await expect(page.getByTestId('auth-status-back')).toHaveCount(1);
    await expectDraftSaved(page);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('auth-continue')).toHaveText(/Reauthorize with GitHub/);

    await page.getByTestId('auth-continue').click();
    await expect(page.getByTestId('logout-button')).toBeVisible();
    await chooseMockPublishOutcome(page, 'auto');
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
  });

  test('E11: a dropped connection is a terminal state; Retry only happens on explicit click', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Offline terminal');
    await setEditorValue(page, 'body', 'Draft survives a dropped connection.');
    await page.route('**/api/mock/publish', (route) => route.abort());

    const requests = trackRequests(page, PUBLISH_PATH);
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Connection problem' })).toBeVisible();
    expect(requests).toHaveLength(1);
    await expect(page.getByTestId('status-back')).toBeVisible();
    await expectDraftSaved(page);
    await page.waitForTimeout(1_000);
    expect(requests).toHaveLength(1);

    await page.unroute('**/api/mock/publish');
    await page.getByTestId('publish-retry').click();
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    expect(requests).toHaveLength(2);
  });

  test('E12: double click is one request; duplicate inside three hours, new post at the boundary', async ({
    page,
    request,
  }) => {
    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Double click');
    await setEditorValue(page, 'body', 'One request only.');
    const requests = trackRequests(page, PUBLISH_PATH);
    const savedDraft = await expectDraftSaved(page);

    const firstResponsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="publish-button"]');
      button?.click();
      button?.click();
    });
    const firstResponse = await firstResponsePromise;
    expect(firstResponse.status()).toBe(201);
    expect(requests).toHaveLength(1);
    const first = (await firstResponse.json()) as {
      status: string;
      timestamp: string;
      commit: { sha: string; path: string };
      deployment: { status: string };
    };
    expect(first.status).toBe('committed');
    expect(first.deployment.status).toBe('pending');
    expect(first.timestamp).toBe('2026-11-23-23-42-15');
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText(/deployment is still pending/i)).toBeVisible();
    const committedText = await page.locator('.publish-status').innerText();
    expect(committedText).not.toMatch(/\bis live\b/i);
    expect(committedText).toContain('not live');

    await page.waitForTimeout(800);
    expect(await readDraft(page)).toBeNull();

    // D32: the success page has no second Publish action, so the 3-hour dedupe
    // contract is exercised through the same same-origin endpoint with the same
    // draft id and content (the request the old editor made on a repeated click).
    const publishAgain = () =>
      request.post(`${TEST_BASE_URL}${PUBLISH_PATH}`, {
        data: { title: 'Double click', body: 'One request only.', draftId: savedDraft.draftId },
      });

    const duplicateResponse = await publishAgain();
    expect(duplicateResponse.status()).toBe(200);
    const duplicate = (await duplicateResponse.json()) as {
      status: string;
      duplicate: boolean;
      commit: { sha: string };
    };
    expect(duplicate.status).toBe('duplicate_ignored');
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.commit.sha).toBe(first.commit.sha);

    // 1 ms before three hours: still the original commit.
    await setClock(request, new Date(Date.parse(FIXED_CLOCK) + 3 * 3_600_000 - 1).toISOString());
    const beforeBoundary = await publishAgain();
    expect(beforeBoundary.status()).toBe(200);
    expect(
      ((await beforeBoundary.json()) as { status: string; commit: { sha: string } }).commit.sha,
    ).toBe(first.commit.sha);

    // Exactly three hours: a new file with the rolled Shanghai date.
    await setClock(request, '2026-11-23T18:42:15Z');
    const laterResponse = await publishAgain();
    expect(laterResponse.status()).toBe(201);
    const later = (await laterResponse.json()) as {
      status: string;
      timestamp: string;
      commit: { sha: string; path: string };
    };
    expect(later.status).toBe('committed');
    expect(later.commit.sha).not.toBe(first.commit.sha);
    expect(later.timestamp).toBe('2026-11-24-02-42-15');
    expect(later.commit.path).toBe(
      'content/blog/2026/Double click-2026-11-24-02-42-15.md',
    );
    // The success page keeps showing the committed path that was written.
    await expect(page.getByTestId('success-panel')).toContainText(
      'content/blog/2026/Double click-2026-11-23-23-42-15.md',
    );
    expect(requests).toHaveLength(1);
  });

  test('E13: a publish in flight never clears a newer edit; explicit publish keeps typing intact', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await chooseMockPublishOutcome(page, 'slow');
    await setEditorValue(page, 'title', 'Race draft');
    await setEditorValue(page, 'body', 'Original body');

    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    await expect(page.getByRole('heading', { name: 'Publishing…' })).toBeVisible();

    const body = page.getByTestId('post-body');
    await placeCaretAtEnd(body);
    await page.keyboard.insertText(' edited while waiting');
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const published = (await response.json()) as { markdown: string };
    expect(published.markdown.endsWith('Original body\n')).toBe(true);
    expect(published.markdown).not.toContain('edited while waiting');

    // D32: the publish navigated to the success page and states that the newer
    // edit was kept; returning to the editor restores that newer draft.
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByText('A newer edit was kept in this browser.')).toBeVisible();
    // D33: leaving the success page while that newer draft is unpublished asks
    // first; Leave keeps the draft on this device and opens the editor with it.
    await page.getByTestId('new-post').click();
    await expect(page.getByTestId('leave-confirm')).toBeVisible();
    await page.getByTestId('leave-accept').click();
    await expect(page.getByTestId('post-title')).toBeVisible();
    await expect(page.getByTestId('post-body')).toHaveText('Original body edited while waiting');
    const draft = await expectDraftSaved(page);
    expect(draft.body).toBe('Original body edited while waiting');
    expect(draft.title).toBe('Race draft');
  });

  test('E12: deployment failed/unconfirmed are commit successes and never claim the post is live', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);

    await setEditorValue(page, 'title', 'Deployment failed');
    await setEditorValue(page, 'body', 'The commit exists.');
    await chooseMockPublishOutcome(page, 'deploy_failed');
    await page.getByTestId('publish-button').click();
    await expect(
      page.getByRole('heading', { name: 'Commit created, deployment failed' }),
    ).toBeVisible();
    await expect(page.getByTestId('deployment-status')).toHaveText('Failed');
    await expect(page.locator('.publish-status').getByText(/not live/i)).toBeVisible();
    const failedText = await page.locator('.publish-status').innerText();
    expect(failedText).not.toMatch(/\bis live\b/i);
    await expect(page.locator('.publish-status code')).toHaveCount(2);
    await expect(page.getByTestId('back-to-blog')).toBeVisible();

    await backToEditor(page);
    await setEditorValue(page, 'title', 'Deployment unconfirmed');
    await setEditorValue(page, 'body', 'The commit exists too.');
    await chooseMockPublishOutcome(page, 'deploy_unconfirmed');
    await page.getByTestId('publish-button').click();
    await expect(
      page.getByRole('heading', { name: 'Commit created, deployment unconfirmed' }),
    ).toBeVisible();
    await expect(page.getByText(/could not be confirmed/i)).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
  });

  test('P2: Write another post returns to a fresh editor and reloads the date', async ({
    page,
  }) => {
    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'First post');
    await setEditorValue(page, 'body', 'First body');
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    // The identical draft was cleared by the publish, so the exit must not ask
    // for a confirmation (D33: published content is not a pending draft).
    expect(await readDraft(page)).toBeNull();

    await page.getByTestId('new-post').click();
    await expect(page.getByTestId('leave-confirm')).toHaveCount(0);
    await expect(page.getByTestId('post-title')).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveText('');
    await expect(page.getByTestId('post-body')).toHaveText('');
    expect(await readDraft(page)).toBeNull();
    await expect(page.getByTestId('post-date')).not.toHaveText(/Loading date|Date unavailable/);
  });
});

test.describe('responsive, keyboard, reduced motion and translation (E14-E16)', () => {
  test.describe('320 CSS px', () => {
    test.use({ viewport: { width: 320, height: 568 } });

    test('E14: editing, authorization and publishing work from the keyboard without horizontal overflow', async ({
      page,
    }) => {
      await openApp(page);
      // R075-4: keyboard-only sign-in first (the editor does not exist before it).
      await expect(page.getByTestId('post-title')).toHaveCount(0);
      for (const testId of ['back-to-blog', 'auth-continue']) {
        await expectInsideViewport(page, page.getByTestId(testId), 320);
      }
      await page.getByTestId('auth-continue').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('logout-button')).toBeVisible();
      await expect(page.getByTestId('post-title')).toBeVisible();

      await typeTitle(page, `A long title ${'x'.repeat(40)}`);
      await typeBody(page, `A long body token ${'y'.repeat(120)}\nSecond line.`);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      for (const testId of ['publish-button', 'discard-button', 'preview-toggle']) {
        await expectInsideViewport(page, page.getByTestId(testId), 320);
      }

      await page.getByTestId('publish-button').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
      // D32: the success page is the terminal state; its exits must fit 320px.
      for (const testId of ['back-to-blog', 'check-deployment', 'new-post']) {
        await expectInsideViewport(page, page.getByTestId(testId), 320);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.activeElement?.tagName ?? '')).not.toBe('BODY');
    });

    test('E14: 200% text scale keeps controls visible and functional', async ({ page }) => {
      await openApp(page);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '32px';
      });
      // R075-4: sign in before the editor exists, then edit at 200% text.
      await authorize(page);
      await typeTitle(page, 'Scaled title');
      await typeBody(page, 'Scaled body keeps working.');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      await page.getByTestId('publish-button').focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
      for (const testId of ['back-to-blog', 'check-deployment', 'new-post']) {
        await expectInsideViewport(page, page.getByTestId(testId), 320);
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    });

    test('E16: English DOM text and 150% longer labels do not overlap controls', async ({ page }) => {
      await openApp(page);
      await authorize(page);
      await page.addStyleTag({
        content:
          'button, .back-link, summary, .mock-field > span { font-size: 150%; letter-spacing: 0.04em; }',
      });
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

      const controls = [
        page.getByTestId('publish-button'),
        page.getByTestId('discard-button'),
        page.getByTestId('preview-toggle'),
        page.getByTestId('logout-button'),
      ];
      for (let first = 0; first < controls.length; first += 1) {
        for (let second = first + 1; second < controls.length; second += 1) {
          expect(
            await overlap(page, controls[first] as Locator, controls[second] as Locator),
            `controls ${first}/${second} must not overlap`,
          ).toBe(false);
        }
      }

      // E16: every control carries real English DOM text. `textContent` is the
      // right source here: the closed drawer's links are complete in the DOM
      // but not rendered, so `innerText` would be empty for them.
      const texts = await page
        .locator('button, a, h2')
        .evaluateAll((elements) => elements.map((element) => element.textContent ?? ''));
      for (const text of texts) {
        expect(text.trim(), 'every control has real DOM text').not.toBe('');
        expect(text).not.toMatch(/[\u4e00-\u9fff]/);
      }
      const mainText = await page.locator('main').innerText();
      expect(mainText).not.toMatch(/[\u4e00-\u9fff]/);
      expect(await page.title()).toBe("New post — Xinyang Zeng's Homepage");
      expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
    });
  });

  test('E14: reduced motion changes nothing functionally and removes button transitions', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    // R075-4: the publish controls live in the editor, which exists only after
    // the author signs in.
    await authorize(page);
    const transition = await page.getByTestId('publish-button').evaluate((element) => {
      const style = getComputedStyle(element);
      return { duration: style.transitionDuration, property: style.transitionProperty };
    });
    expect(transition.duration.split(',')[0]?.trim()).toBe('0s');

    await typeTitle(page, 'Reduced motion');
    await typeBody(page, 'Publishes without relying on animation.');
    await page.getByTestId('publish-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
    await expect(page.getByTestId('back-to-blog')).toBeVisible();
  });
});

test.describe('production isolation and secret scan (E09, E15)', () => {
  test('E15: production-mode Worker returns JSON 404 for mock publish and test clock', async ({
    request,
  }) => {
    const cases: Array<[string, 'GET' | 'POST', Record<string, unknown>?]> = [
      ['/api/mock/publish', 'POST', { title: 'x', body: 'y', draftId: 'z' }],
      ['/api/mock/publish', 'GET'],
      ['/api/test/clock', 'POST', { now: FIXED_CLOCK }],
      ['/api/test/clock', 'GET'],
      ['/api/mock/session', 'GET'],
      ['/api/mock/auth', 'POST', { outcome: 'authorized' }],
      ['/api/test/reset', 'POST', {}],
    ];
    for (const [path, method, data] of cases) {
      const response = await request.fetch(`${PROD_BASE_URL}${path}`, { method, data });
      expect(response.status(), `${method} ${path}`).toBe(404);
      expect(response.headers()['content-type']).toContain('application/json');
      expect(await response.json()).toEqual({ error: 'not_found' });
    }

    const date = await request.get(`${PROD_BASE_URL}/api/date`);
    expect(date.status()).toBe(200);
    expect(await date.json()).toMatchObject({ timeZone: 'Asia/Shanghai' });
  });

  test('E15: the production UI offers no mock surface and keeps the author gate closed', async ({
    page,
  }) => {
    await page.goto(PROD_BASE_URL);
    // R075-4: without a real author session the production build shows the
    // terminal gate; the editor and the primary actions do not exist.
    await expect(page.getByText(/GitHub authorization is not available in this build/)).toBeVisible();
    await expect(page.getByTestId('post-title')).toHaveCount(0);
    await expect(page.getByTestId('publish-button')).toHaveCount(0);
    await expect(page.getByTestId('mock-controls')).toHaveCount(0);
    await expect(page.getByTestId('auth-status-back')).toBeVisible();
  });

  test('E09: no secret/token/state/verifier in localStorage, page JS, network or built assets', async ({
    page,
    request,
  }) => {
    const requestBodies: string[] = [];
    const requestUrls: string[] = [];
    const responseBodies: string[] = [];
    page.on('request', (captured) => {
      requestUrls.push(captured.url());
      const data = captured.postData();
      if (data) {
        requestBodies.push(data);
      }
    });
    page.on('response', async (response) => {
      if (response.url().includes('/api/')) {
        try {
          responseBodies.push(await response.text());
        } catch {
          // non-text response
        }
      }
    });

    await openApp(page);
    await authorize(page);
    await setEditorValue(page, 'title', 'Secret scan');
    await setEditorValue(page, 'body', 'No secrets anywhere.');
    await expectDraftSaved(page);

    // Load the lazy preview chunk too so its JS is included in the scan.
    const previewToggle = page.getByTestId('preview-toggle');
    if (await previewToggle.isVisible()) {
      await previewToggle.click();
      await expect(page.getByTestId('preview-body')).toBeVisible();
    }

    const storage = await page.evaluate((key) => {
      const entries: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const storageKey = localStorage.key(index);
        if (storageKey !== null) {
          entries[storageKey] = localStorage.getItem(storageKey) ?? '';
        }
      }
      return { key, entries };
    }, DRAFT_KEY);
    for (const [key, value] of Object.entries(storage.entries)) {
      expect(key).toBe(DRAFT_KEY);
      const parsed = JSON.parse(value) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(
        ['schemaVersion', 'draftId', 'title', 'body', 'updatedAt'].sort(),
      );
    }

    await setEditorValue(page, 'title', 'Secret scan published');
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes(PUBLISH_PATH) && response.request().method() === 'POST',
    );
    await page.getByTestId('publish-button').click();
    await responsePromise;

    const html = await page.content();
    const pageScriptSources = await page
      .locator('script[src]')
      .evaluateAll((elements) => elements.map((element) => element.getAttribute('src') ?? ''));
    const resourceScriptSources = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.endsWith('.js') || name.includes('/assets/')),
    );
    const scriptSources = [...new Set([...pageScriptSources, ...resourceScriptSources])];
    const scriptBodies: string[] = [];
    for (const source of scriptSources.filter(Boolean)) {
      const response = await request.get(new URL(source, TEST_BASE_URL).toString());
      expect(response.status()).toBe(200);
      scriptBodies.push(await response.text());
    }
    await page.waitForTimeout(500);

    const haystack = [
      JSON.stringify(storage),
      html,
      ...requestUrls,
      ...requestBodies,
      ...responseBodies,
      ...scriptBodies,
    ].join('\n');
    for (const pattern of [
      /client_secret/i,
      /code_verifier/i,
      /access_token/i,
      /refresh_token/i,
      /oauth_state/i,
      /ghu_/,
      /github_pat_/,
      /private_key/i,
    ]) {
      expect(haystack, String(pattern)).not.toMatch(pattern);
    }
    expect(requestUrls.join('\n')).not.toMatch(/[?&](code|state|verifier)=/i);
  });
});
