/**
 * Author-side preview renderer.
 *
 * The public site renders Markdown at build time with Astro's own pipeline.
 * The author app cannot run that pipeline in the browser, so this module
 * implements a deliberately small, safe subset: paragraphs (including CommonMark
 * hard line breaks, two or more trailing spaces), h2–h6, unordered
 * and ordered lists (nested, multi-paragraph items, hard breaks inside items),
 * blockquotes (which may themselves contain lists), fenced code, horizontal
 * rules and the common inline syntax. After rendering, the HTML is passed
 * through the shared `sanitizeMarkdownHtml` allowlist that the public site
 * re-exports, so the preview can never allow more than the public Blog allows.
 * There is exactly one allowlist implementation, not a copy.
 *
 * Known limitation (recorded in the task ledger): there is no syntax
 * highlighting and no GFM table support, so the preview is an approximation
 * of the public build, not byte-identical HTML.
 */
import { sanitizeMarkdownHtml } from './sanitize-markdown.ts';
import { normalizeBody } from './serialize.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function safeUrl(rawUrl: string, allowedSchemes: readonly string[]): string | null {
  const url = rawUrl.trim();
  if (url === '' || /[\u0000-\u001F\u007F]/.test(url) || url.startsWith('//')) {
    return null;
  }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    if (!allowedSchemes.includes(scheme)) {
      return null;
    }
  }
  return escapeHtml(url);
}

const CODE_SPAN = /`([^`\n]+)`/g;
const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

function renderInline(raw: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `\uE000${stash.length - 1}\uE001`;
  };

  // Remove the private-use delimiters so author text cannot forge a stash slot.
  let text = raw.replace(/[\uE000\uE001]/g, '');

  text = text.replace(CODE_SPAN, (_match, code: string) => keep(`<code>${escapeHtml(code)}</code>`));

  text = text.replace(IMAGE, (_match, alt: string, url: string) => {
    const safe = safeUrl(url, ['http', 'https']);
    return safe === null
      ? escapeHtml(alt)
      : keep(`<img src="${safe}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`);
  });

  text = text.replace(LINK, (_match, label: string, url: string) => {
    const safe = safeUrl(url, ['http', 'https', 'mailto']);
    return safe === null ? escapeHtml(label) : keep(`<a href="${safe}">${escapeHtml(label)}</a>`);
  });

  text = escapeHtml(text);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

  return text.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => stash[Number(index)] ?? '');
}

interface Fence {
  marker: '`' | '~';
  length: number;
  info: string;
}

function openingFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || match[1] === undefined) {
    return null;
  }
  return {
    marker: match[1][0] as '`' | '~',
    length: match[1].length,
    info: (match[2] ?? '').trim(),
  };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return (
    match !== null &&
    match[1] !== undefined &&
    match[1][0] === fence.marker &&
    match[1].length >= fence.length
  );
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const HORIZONTAL_RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCKQUOTE = /^ {0,3}> ?(.*)$/;
const UNORDERED_ITEM = /^ {0,3}[-+*][ \t]+(.*)$/;
const ORDERED_ITEM = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/;

function isBlockStart(line: string): boolean {
  return (
    line.trim() === '' ||
    openingFence(line) !== null ||
    HEADING.test(line) ||
    HORIZONTAL_RULE.test(line) ||
    BLOCKQUOTE.test(line) ||
    UNORDERED_ITEM.test(line) ||
    ORDERED_ITEM.test(line)
  );
}

function stripClosingHashes(text: string): string {
  return text.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

/**
 * CommonMark hard line break (D34): two or more trailing spaces before a
 * newline inside one paragraph. A private-use marker that does not occur in the
 * author's text stands in for the break; it survives HTML escaping and becomes
 * `<br>` after the inline renderer runs. A single newline stays a soft break
 * (rendered as a space by HTML), and trailing spaces on the paragraph's last
 * line are not a break.
 */
function renderParagraphMarkup(lines: readonly string[]): string {
  const text = lines.join('\n');
  let marker = '\uE010';
  for (let code = 0xe010; code <= 0xe0ff; code += 1) {
    marker = String.fromCharCode(code);
    if (!text.includes(marker)) break;
  }
  // The newline is consumed by the break: `<br>` replaces "spaces + newline",
  // so no stray soft break stays next to it.
  const source = text.replace(/ {2,}\n/g, marker);
  return renderInline(source).split(marker).join('<br>');
}

/**
 * Renders one list (unordered or ordered), including nested lists and
 * multi-paragraph items. Each item body is rendered recursively, so the same
 * paragraph rules apply inside a list item as at the top level — in particular
 * the CommonMark hard break from `renderParagraphMarkup` (X04) — and a nested
 * list becomes a real nested `<ul>`/`<ol>` instead of being flattened.
 *
 * `loose` follows CommonMark: a blank line that continues an item (an indented
 * block) or separates two items of the same list makes every paragraph in the
 * list wrapped in `<p>`; a tight list omits the paragraph wrapper.
 */
function renderList(
  lines: readonly string[],
  start: number,
): { html: string; next: number } {
  const first = lines[start] ?? '';
  const ordered = ORDERED_ITEM.test(first);
  const pattern = ordered ? ORDERED_ITEM : UNORDERED_ITEM;
  const items: string[][] = [];
  let loose = false;
  let index = start;

  while (index < lines.length) {
    const current = lines[index] ?? '';
    const match = pattern.exec(current);
    if (match) {
      const indent = /^[ \t]*/.exec(current)?.[0].length ?? 0;
      if (items.length === 0 || indent === 0) {
        items.push([match[1] ?? '']);
        index += 1;
        continue;
      }
      // An indented marker is a nested list inside the current item; the
      // recursive renderer below turns it into a nested <ul>/<ol>.
      items[items.length - 1]?.push(current.replace(/^[ \t]+/, ''));
      index += 1;
      continue;
    }

    if (items.length === 0) {
      break;
    }
    const item = items[items.length - 1];
    if (item === undefined) {
      break;
    }

    if (current.trim() === '') {
      // A blank line only stays inside the list when an indented block continues
      // the item, or when it merely separates two items of the same list.
      let ahead = index + 1;
      while (ahead < lines.length && (lines[ahead] ?? '').trim() === '') {
        ahead += 1;
      }
      if (ahead >= lines.length) {
        break;
      }
      const nextLine = lines[ahead] ?? '';
      if (/^[ \t]+/.test(nextLine)) {
        item.push('');
        loose = true;
        index = ahead;
        continue;
      }
      if (pattern.test(nextLine)) {
        loose = true;
        index = ahead;
        continue;
      }
      break;
    }

    if (/^[ \t]+(?:[-+*]|\d{1,9}[.)])[ \t]+/.test(current)) {
      item.push(current.replace(/^[ \t]+/, ''));
      index += 1;
      continue;
    }
    // Any other indented line (a fenced code block, a heading, a quote, plain
    // continuation) belongs to the item; strip only the indentation so the
    // recursive renderer sees the block at the top level.
    if (/^[ \t]+/.test(current)) {
      item.push(current.replace(/^[ \t]+/, ''));
      index += 1;
      continue;
    }
    if (isBlockStart(current)) {
      break;
    }
    // Lazy continuation. Only leading indentation is removed; trailing spaces
    // stay so a two-space hard break inside the item still becomes <br> (X04).
    item.push(current.replace(/^[ \t]+/, ''));
    index += 1;
  }

  const tag = ordered ? 'ol' : 'ul';
  const rendered = items.map((itemLines) => {
    let body = renderBlocks(itemLines);
    if (!loose) {
      // Tight list: CommonMark does not wrap item content in a paragraph.
      body = body.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    }
    return `<li>${body}</li>`;
  });
  // Whitespace between items matches the built article's text content (the
  // browser collapses it to a space), so the preview and the site agree.
  return { html: `<${tag}>\n${rendered.join('\n')}\n</${tag}>`, next: index };
}

/**
 * Renders Markdown blocks. Recursion is what lets list items and blockquotes
 * contain the same block types as the document (nested lists, multi-paragraph
 * items, a list inside a quote).
 */
function renderBlocks(lines: readonly string[]): string {
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = openingFence(line);
    if (fence) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !isClosingFence(lines[index] ?? '', fence)) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      const language = /^[A-Za-z0-9+#.-]+/.exec(fence.info)?.[0] ?? '';
      const languageClass = language === '' ? '' : ` class="language-${language.toLowerCase()}"`;
      blocks.push(`<pre><code${languageClass}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      blocks.push('<hr>');
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading && heading[1] !== undefined) {
      const level = heading[1].length;
      const text = stripClosingHashes(heading[2] ?? '');
      // The page already has one H1 from the post title. A user-authored H1 in
      // the body is shown as literal text so the preview never gains a second
      // heading (the real publish-time rejection belongs to task 07).
      blocks.push(
        level === 1 ? `<p>${renderInline(`# ${text}`)}</p>` : `<h${level}>${renderInline(text)}</h${level}>`,
      );
      index += 1;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = BLOCKQUOTE.exec(lines[index] ?? '');
        if (!match) {
          break;
        }
        quoted.push(match[1] ?? '');
        index += 1;
      }
      // Recursive: a quote may contain paragraphs, lists or nested quotes.
      blocks.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
      continue;
    }

    if (UNORDERED_ITEM.test(line) || ORDERED_ITEM.test(line)) {
      const list = renderList(lines, index);
      blocks.push(list.html);
      index = list.next;
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (paragraph.length > 0 && isBlockStart(current)) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push(`<p>${renderParagraphMarkup(paragraph)}</p>`);
  }

  return blocks.join('\n');
}

/**
 * Renders the Markdown body to HTML. The output is NOT safe on its own; always
 * pass it through `sanitizePreviewHtml` (or use `renderMarkdownPreview`).
 */
export function renderMarkdownBodyHtml(markdown: string): string {
  const lines = normalizeBody(markdown).replace(/\n$/, '').split('\n');
  return renderBlocks(lines);
}

/** Sanitises preview HTML with the public site's exact allowlist. */
export function sanitizePreviewHtml(html: string): string {
  return sanitizeMarkdownHtml(html);
}

/**
 * Renders and sanitises a body preview. The returned HTML is safe to assign to
 * `innerHTML`; nothing else in the author app may bypass this function.
 */
export function renderMarkdownPreview(markdown: string): string {
  return sanitizePreviewHtml(renderMarkdownBodyHtml(markdown));
}
