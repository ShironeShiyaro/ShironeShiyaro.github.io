import { expect, test } from './console-guard.ts';
import {
  authorize,
  openApp,
  publishAndWait,
  resetMock,
  setEditorValue,
  trackRequests,
  typeTitle,
} from './helpers.ts';

test.beforeEach(async ({ request }) => {
  await resetMock(request);
});

test.describe('editor surface', () => {
  test('E01: borderless title/body with article typography, labels and caret', async ({ page }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const title = page.getByTestId('post-title');
    const body = page.getByTestId('post-body');

    await expect(title).toHaveAccessibleName('Post title');
    await expect(body).toHaveAccessibleName('Post body in Markdown');
    await expect(title).toHaveAttribute('role', 'textbox');
    await expect(body).toHaveAttribute('aria-multiline', 'true');
    await expect(page.locator('.post-editor input, .post-editor textarea')).toHaveCount(0);
    // The editable post title is the page's only h1.
    await expect(page.locator('h1')).toHaveCount(1);

    const titleStyle = await title.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderTopWidth: style.borderTopWidth,
        borderRightWidth: style.borderRightWidth,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderStyle: style.borderStyle,
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        color: style.color,
      };
    });
    expect(titleStyle).toEqual({
      borderTopWidth: '0px',
      borderRightWidth: '0px',
      borderBottomWidth: '0px',
      borderLeftWidth: '0px',
      borderStyle: 'none',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      boxShadow: 'none',
      fontSize: '36px',
      fontWeight: '700',
      lineHeight: '43.2px',
      color: 'rgb(32, 32, 32)',
    });

    const bodyStyle = await body.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderTopWidth: style.borderTopWidth,
        borderStyle: style.borderStyle,
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        color: style.color,
      };
    });
    expect(bodyStyle).toEqual({
      borderTopWidth: '0px',
      borderStyle: 'none',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      boxShadow: 'none',
      fontSize: '16px',
      fontWeight: '400',
      lineHeight: '27.2px',
      color: 'rgb(32, 32, 32)',
    });

    await title.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = window.getSelection();
          return {
            active: document.activeElement?.getAttribute('data-testid') ?? null,
            hasRange: Boolean(selection && selection.rangeCount > 0),
          };
        }),
      )
      .toEqual({ active: 'post-title', hasRange: true });

    await body.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = window.getSelection();
          return {
            active: document.activeElement?.getAttribute('data-testid') ?? null,
            hasRange: Boolean(selection && selection.rangeCount > 0),
          };
        }),
      )
      .toEqual({ active: 'post-body', hasRange: true });
  });

  test('preview chunk renders through the shared sanitizer', async ({ page }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    await setEditorValue(page, 'title', 'Preview');
    await setEditorValue(page, 'body', '**bold** and <script>alert(1)</script>');
    await page.getByTestId('preview-toggle').click();
    await expect(page.getByTestId('preview-body')).toBeVisible();
    const previewHtml = await page.getByTestId('preview-body').innerHTML();
    expect(previewHtml).toContain('<strong>bold</strong>');
    expect(previewHtml.toLowerCase()).not.toContain('<script');
    expect(previewHtml).toContain('&lt;script&gt;');
    await expect(page.getByTestId('preview-toggle')).toHaveText('Hide preview');
  });

  test('E02: title is single-line, body keeps newlines and only one separator exists', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const title = page.getByTestId('post-title');
    const body = page.getByTestId('post-body');

    await typeTitle(page, 'One line title');
    await page.keyboard.press('Enter');
    await expect(title).toHaveText('One line title');
    await page.keyboard.press('Shift+Enter');
    await expect(title).toHaveText('One line title');
    await page.keyboard.insertText('attempted second line');
    await expect(title).toHaveText('One line titleattempted second line');
    expect((await title.textContent())?.includes('\n')).toBe(false);

    await body.click();
    await page.keyboard.insertText('line one');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('line two');
    await expect(body).toHaveText('line one\nline two');

    await expect(page.locator('.post-editor hr')).toHaveCount(1);
    await expect(page.locator('.post-editor')).toContainText('One line title');
  });

  test('E03: IME Enter is ignored, paste keeps only plain text, publish is never implicit', async ({
    page,
  }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const title = page.getByTestId('post-title');
    const body = page.getByTestId('post-body');
    const publishRequests = trackRequests(page, '/api/mock/publish');

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
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '标题' }));
    });
    await page.keyboard.insertText('中文标题');
    await expect(title).toHaveText('中文标题');
    expect((await title.textContent())?.includes('\n')).toBe(false);

    await body.click();
    await body.evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'Pasted plain');
      transfer.setData('text/html', '<b>Pasted rich</b><img src=x onerror=alert(1)>');
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: transfer });
      element.dispatchEvent(event);
    });
    await expect(body).toHaveText('Pasted plain');
    const bodyHtml = await body.evaluate((element) => element.innerHTML);
    expect(bodyHtml.toLowerCase()).not.toContain('<b>');
    expect(bodyHtml.toLowerCase()).not.toContain('<img');
    expect(bodyHtml.toLowerCase()).not.toContain('onerror');

    expect(publishRequests).toEqual([]);
    // R075-4: with the author signed in, Publish is an enabled explicit action —
    // nothing is sent by IME/paste/Enter; only a click may publish.
    await expect(page.getByTestId('publish-button')).toBeEnabled();
    await expect(page.getByTestId('publish-button')).toHaveText('Publish');
  });

  test('E03b: a real CDP IME composition never inserts a title newline', async ({ page }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const title = page.getByTestId('post-title');
    await title.click();
    await page.keyboard.insertText('Hello ');
    const heightBefore = (await title.boundingBox())?.height ?? 0;

    const client = await page.context().newCDPSession(page);
    await client.send('Input.imeSetComposition', {
      text: 'zhongwen',
      selectionStart: 8,
      selectionEnd: 8,
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);

    const text = (await title.textContent()) ?? '';
    const singleLineTitle = text.trim();
    expect(text).not.toContain('\n');
    expect(singleLineTitle).toBe('Hello zhongwen');
    const heightAfter = (await title.boundingBox())?.height ?? 0;
    expect(Math.abs(heightAfter - heightBefore)).toBeLessThan(1);

    await authorize(page);
    await setEditorValue(page, 'body', 'IME title body.');
    const captured = await publishAndWait(page);
    expect(captured.status).toBe(201);
    const markdown = captured.json.markdown as string;
    expect(markdown).toContain(`# ${singleLineTitle}\n\n`);
    expect(markdown.split('\n')[0]).toBe('---');
    expect(markdown).not.toContain(`# ${singleLineTitle}\n\n\n`);
    await expect(page.getByRole('heading', { name: 'Commit created' })).toBeVisible();
  });

  test('E04: client validation blocks the request with English errors', async ({ page }) => {
    await openApp(page);
    // R075-4: the editor only exists after the author signs in.
    await authorize(page);
    const publishRequests = trackRequests(page, '/api/mock/publish');
    const publish = page.getByTestId('publish-button');
    await expect(publish).toBeEnabled();

    await setEditorValue(page, 'title', '');
    await setEditorValue(page, 'body', '');
    await publish.click();
    await expect(page.getByText('Enter a title before publishing.')).toBeVisible();
    await expect(page.getByText('Enter the post body before publishing.')).toBeVisible();
    expect(publishRequests).toEqual([]);

    await setEditorValue(page, 'title', 'a'.repeat(61));
    await setEditorValue(page, 'body', 'Body');
    await publish.click();
    await expect(page.getByText(/60 characters or fewer/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    await setEditorValue(page, 'title', '😀'.repeat(59));
    await publish.click();
    await expect(page.getByText(/too long for a file name/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    await setEditorValue(page, 'title', 'Body size limit');
    await setEditorValue(page, 'body', 'a'.repeat(256 * 1024 + 1));
    await publish.click();
    await expect(page.getByText(/256 KiB or smaller/)).toBeVisible();
    expect(publishRequests).toEqual([]);

    // The invalid state is announced and linked to the field.
    await expect(page.getByTestId('post-body')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('post-body')).toHaveAttribute('aria-describedby', 'editor-errors');
    expect(await page.getByTestId('post-body').getAttribute('aria-describedby')).toBe(
      'editor-errors',
    );
  });
});
