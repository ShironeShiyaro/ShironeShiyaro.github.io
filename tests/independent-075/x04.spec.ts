import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  openAuthorized,
  resetEnvironment,
  screenshot,
  setEditorValue,
  writeEvidence,
} from './helpers';

interface X04Build {
  markdown: string;
  articleHtml: string;
  sanitizeMarkdown: string;
  sanitizeHtml: string;
}

function builtJson(): X04Build {
  return JSON.parse(
    readFileSync(join(process.env.INDEP_TMP ?? '', 'x04-build.json'), 'utf8'),
  ) as X04Build;
}

async function openPreview(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('preview-toggle').click();
  await expect(page.getByTestId('preview-body')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await resetEnvironment(request);
});

test('X04 preview hard breaks match the real Astro article for the same Markdown', async ({ page }) => {
  const built = builtJson();
  await openAuthorized(page);
  await setEditorValue(page, 'body', built.markdown);
  await openPreview(page);

  const signature = await page.evaluate((builtHtml) => {
    interface Block {
      tag: string;
      br: number;
      text: string;
      pres: string[];
    }
    const normalize = (root: Element): Block[] =>
      Array.from(root.children).map((block) => {
        const clone = block.cloneNode(true) as Element;
        const isPre = block.tagName === 'PRE';
        const pres = isPre
          ? [(block.textContent ?? '').replace(/\n$/, '')]
          : Array.from(clone.querySelectorAll('pre')).map((pre) =>
              (pre.textContent ?? '').replace(/\n$/, ''),
            );
        if (isPre) {
          clone.replaceChildren(document.createTextNode('[[PRE]]'));
        } else {
          clone.querySelectorAll('pre').forEach((pre) => {
            pre.replaceWith(document.createTextNode('[[PRE]]'));
          });
        }
        const breaks = Array.from(clone.querySelectorAll('br'));
        breaks.forEach((br) => br.replaceWith(document.createTextNode('[[BR]]')));
        // Whitespace immediately around a <br> is not rendered; one renderer
        // keeps the source newline, the other does not. Normalise it so the
        // signature compares the semantic break, not source-format spacing.
        const text = (clone.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\s*\[\[BR\]\]\s*/g, '[[BR]]');
        return {
          tag: block.tagName.toLowerCase(),
          br: breaks.length,
          text,
          pres,
        };
      });
    const previewRoot = document.querySelector('[data-testid="preview-body"]');
    if (!previewRoot) throw new Error('preview body is missing');
    const doc = new DOMParser().parseFromString(builtHtml, 'text/html');
    const builtRoot = doc.querySelector('.post__body');
    if (!builtRoot) throw new Error('built post body is missing');
    return {
      preview: normalize(previewRoot),
      built: normalize(builtRoot),
      previewScripts: previewRoot.querySelectorAll('script').length,
    };
  }, built.articleHtml);

  expect(signature.previewScripts).toBe(0);
  const differences = signature.preview
    .map((block, index) => ({
      index,
      preview: block,
      built: signature.built[index] ?? null,
    }))
    .filter(({ preview, built }) => JSON.stringify(preview) !== JSON.stringify(built));
  const equal = differences.length === 0;
  writeEvidence('x04-debug.json', {
    markdown: built.markdown,
    hasListBr: built.articleHtml.includes('list item two<br'),
    bodyText: await page.getByTestId('post-body').evaluate((element) => element.textContent),
    previewHtml: await page.getByTestId('preview-body').evaluate((element) => element.innerHTML),
    articleSnippet: built.articleHtml.slice(
      Math.max(0, built.articleHtml.indexOf('list item one') - 100),
      built.articleHtml.indexOf('list item one') + 500,
    ),
    previewUl: signature.preview.find((block) => block.tag === 'ul'),
    builtUl: signature.built.find((block) => block.tag === 'ul'),
    differences,
  });
  writeEvidence('x04-signature.json', {
    markdown: built.markdown,
    preview: signature.preview,
    built: signature.built,
    equal,
    differences,
    previewScripts: signature.previewScripts,
  });
  await screenshot(page, 'x04-preview.png');

  const find = (blocks: typeof signature.preview, needle: string) => {
    const block = blocks.find(
      (candidate) =>
        candidate.text.includes(needle) || candidate.pres.some((pre) => pre.includes(needle)),
    );
    if (!block) throw new Error(`block containing "${needle}" is missing`);
    return block;
  };
  for (const blocks of [signature.preview, signature.built]) {
    expect(find(blocks, 'Hard break with two spaces').br).toBe(1);
    expect(find(blocks, 'Soft break only next line after one.').br).toBe(0);
    expect(find(blocks, 'Hard break with three spaces').br).toBe(1);
    expect(find(blocks, 'Trailing spaces at paragraph end').br).toBe(0);
    expect(find(blocks, 'Second paragraph.').br).toBe(0);
    expect(find(blocks, 'code line one').pres).toEqual(['code line one  \ncode line two']);
    expect(
      find(blocks, 'list item one').br,
      'a two-space hard break inside a list item must match the built article',
    ).toBe(1);
    expect(find(blocks, 'quote line one').br).toBe(1);
    expect(find(blocks, 'quote soft one').br).toBe(0);
  }
  expect(differences, 'preview and built Markdown semantics are identical').toEqual([]);
});

test('X04 code blocks preserve trailing spaces and newlines; paragraph-end spaces do not add breaks', async ({
  page,
}) => {
  const built = builtJson();
  await openAuthorized(page);
  await setEditorValue(page, 'body', built.markdown);
  await openPreview(page);
  const preview = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="preview-body"]');
    if (!root) throw new Error('preview body is missing');
    return {
      preText: Array.from(root.querySelectorAll('pre')).map((pre) => pre.textContent ?? ''),
      brInPre: root.querySelectorAll('pre br').length,
      brInParagraphs: Array.from(root.querySelectorAll('p')).map((p) => p.querySelectorAll('br').length),
    };
  });
  // The preview keeps the code text (including its two trailing spaces) but
  // does not add a newline after the closing fence; the built article may.
  expect(preview.preText.map((text) => text.replace(/\n$/, ''))).toEqual([
    'code line one  \ncode line two',
  ]);
  expect(preview.brInPre).toBe(0);
  expect(preview.brInParagraphs[0]).toBe(1);
  expect(preview.brInParagraphs[1]).toBe(0);
  expect(preview.brInParagraphs[2]).toBe(1);
  expect(preview.brInParagraphs[3]).toBe(0);
  writeEvidence('x04-code-block.json', preview);
});

test('X10 preview sanitises script, event handlers and javascript: links', async ({ page }) => {
  const built = builtJson();
  await openAuthorized(page);
  await setEditorValue(page, 'body', built.sanitizeMarkdown);
  await openPreview(page);
  const report = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="preview-body"]');
    if (!root) throw new Error('preview body is missing');
    return {
      scripts: root.querySelectorAll('script').length,
      onAttributes: Array.from(root.querySelectorAll('*')).flatMap((element) =>
        Array.from(element.attributes)
          .filter((attribute) => attribute.name.startsWith('on'))
          .map((attribute) => `${element.tagName}.${attribute.name}`),
      ),
      javascriptLinks: Array.from(root.querySelectorAll('a[href]')).filter((link) =>
        (link.getAttribute('href') ?? '').toLowerCase().startsWith('javascript:'),
      ).length,
      text: (root.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
  expect(report.scripts).toBe(0);
  expect(report.onAttributes).toEqual([]);
  expect(report.javascriptLinks).toBe(0);
  expect(report.text).toContain('Visible paragraph.');
  await screenshot(page, 'x10-preview-sanitize.png');
  writeEvidence('x10-preview-sanitize.json', report);
});
