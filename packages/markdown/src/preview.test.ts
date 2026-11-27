import { describe, expect, it } from 'vitest';
import { renderMarkdownPreview, sanitizePreviewHtml } from './preview.ts';

describe('renderMarkdownPreview', () => {
  it('renders paragraphs, headings, lists and fenced code', () => {
    const html = renderMarkdownPreview(
      ['Intro **bold** and *italic*.', '', '## Section', '', '- one', '- two', '', '```ts', 'const a = 1;', '```'].join(
        '\n',
      ),
    );

    expect(html).toContain('<p>Intro <strong>bold</strong> and <em>italic</em>.</p>');
    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(html).toContain('<pre tabindex="0">');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('const a = 1;');
  });

  it('keeps safe links and drops javascript/data URLs', () => {
    const safe = renderMarkdownPreview('[site](https://example.com/a?b=1)');
    expect(safe).toContain('<a href="https://example.com/a?b=1">site</a>');

    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
      const preview = renderMarkdownPreview(`[click](${url})`);
      expect(preview).not.toContain('href');
      expect(preview.toLowerCase()).not.toContain('javascript:alert');
      expect(preview.toLowerCase()).not.toContain('vbscript');
      expect(preview).toContain('click');
    }
  });

  it('escapes raw HTML instead of executing it', () => {
    const preview = renderMarkdownPreview(
      '<script>alert(1)</script> <img src=x onerror="alert(2)"> <a href="javascript:alert(3)">x</a>',
    );
    expect(preview.toLowerCase()).not.toMatch(/<script/i);
    expect(preview.toLowerCase()).not.toMatch(/<img[^>]*onerror=/i);
    expect(preview.toLowerCase()).not.toMatch(/<a[^>]*javascript:/i);
    expect(preview).toContain('&lt;script&gt;');
    expect(preview).toContain('&lt;img');
  });

  it('never emits a second H1 for a body-authored H1', () => {
    const preview = renderMarkdownPreview('# Looks like a title');
    expect(preview).not.toContain('<h1');
    expect(preview).toContain('# Looks like a title');
  });

  it('uses the public site allowlist (unsupported tags are discarded)', () => {
    // The renderer escapes raw HTML, so exercise the shared sanitizer directly:
    // the public allowlist has no `div`, and `discard` keeps the text but drops
    // the tag and its attributes.
    const sanitized = sanitizePreviewHtml('<div class="card">hidden</div>Hello');
    expect(sanitized).not.toContain('<div');
    expect(sanitized).not.toContain('class="card"');
    expect(sanitized).toContain('hidden');
    expect(sanitized).toContain('Hello');
  });

  it('renders blockquotes, ordered lists and horizontal rules', () => {
    const html = renderMarkdownPreview(['> quoted', '', '1. first', '2. second', '', '---'].join('\n'));
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    expect(html).toContain('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
    expect(html).toMatch(/<hr ?\/?>/);
  });

  it('preserves private-use characters as text without forging stash slots', () => {
    const html = renderMarkdownPreview('\uE0000\uE001 plain');
    expect(html).toContain('0 plain');
  });

  it('renders a CommonMark hard break for two or more trailing spaces (D34)', () => {
    // sanitize-html serialises the allowed `br` as `<br />`; the rendering is
    // identical to `<br>`.
    expect(renderMarkdownPreview('one  \ntwo')).toContain('<p>one<br />two</p>');
    expect(renderMarkdownPreview('one   \ntwo')).toContain('<p>one<br />two</p>');
    expect(renderMarkdownPreview('one  \ntwo  \nthree')).toContain(
      '<p>one<br />two<br />three</p>',
    );
  });

  it('keeps a single newline as a soft break (space, no <br>) and ignores paragraph-end spaces', () => {
    const soft = renderMarkdownPreview('one\ntwo');
    expect(soft).toContain('<p>one\ntwo</p>');
    expect(soft).not.toContain('<br');
    const trailing = renderMarkdownPreview('one  ');
    expect(trailing).not.toContain('<br');
    expect(trailing).toContain('one');
  });

  it('does not convert line endings inside code blocks, lists or blockquotes', () => {
    const code = renderMarkdownPreview(['```ts', 'const a = 1;  ', 'const b = 2;', '```'].join('\n'));
    expect(code).not.toContain('<br');
    expect(code).toContain('const a = 1;  ');
    expect(code).toContain('const b = 2;');

    const list = renderMarkdownPreview(['- first  ', '- second'].join('\n'));
    expect(list).not.toContain('<br');
    expect(list).toContain('<li>first');
    expect(list).toContain('<li>second</li>');

    const quote = renderMarkdownPreview(['> quoted  ', '> next'].join('\n'));
    // A hard break inside a blockquote is real CommonMark (the built site
    // renders it too); only soft newlines stay converted to a space.
    expect(quote).toContain('<blockquote><p>quoted<br />next</p></blockquote>');
    const softQuote = renderMarkdownPreview(['> quoted', '> next'].join('\n'));
    expect(softQuote).not.toContain('<br');
    expect(softQuote).toContain('<p>quoted\nnext</p>');
  });

  it('uses the common hard-break HTML that the Astro/CommonMark pipeline emits', () => {
    // The public site renders the same Markdown with Astro's remark pipeline,
    // whose CommonMark output for a two-space break is `<p>one<br>two</p>`
    // (D34; sanitize-html serialises the same node as `<br />`). The site's
    // sanitizer keeps `br` in its allowlist, so the preview and the built
    // article agree on this construct.
    const markdown = 'First line  \nSecond line with **bold**  \nThird line';
    expect(renderMarkdownPreview(markdown)).toBe(
      '<p>First line<br />Second line with <strong>bold</strong><br />Third line</p>',
    );
  });

  it('renders a hard break inside a list item exactly like the built article (X04)', () => {
    // The X04 independent test compares this exact Markdown with the real Astro
    // article: a two-space break inside a list item must produce one <br>, the
    // single-newline item stays a soft break, and items are separated by
    // whitespace so the rendered text matches the built page.
    const html = renderMarkdownPreview(
      [
        '- list item one',
        '  continuation after soft break',
        '- list item two  ',
        '  continuation after hard break',
      ].join('\n'),
    );
    expect(html).toMatch(/<ul>\s*<li>list item one\s+continuation after soft break<\/li>/u);
    expect(html).toContain('<li>list item two<br />continuation after hard break</li>');
    expect(html.match(/<br/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/<\/li>\s*<li>/u);
    // No <br> at the end of the item either: the trailing spaces are only a
    // break when a newline follows them inside the paragraph.
    expect(html).not.toMatch(/two<br \/>\s*<\/li>/u);
  });

  it('covers three-space breaks, ordered, nested, multi-paragraph and quoted lists (X04)', () => {
    expect(renderMarkdownPreview(['- item   ', '  next'].join('\n'))).toContain(
      '<li>item<br />next</li>',
    );

    const ordered = renderMarkdownPreview(['1. first  ', '   second'].join('\n'));
    expect(ordered).toContain('<ol>');
    expect(ordered).toContain('<li>first<br />second</li>');

    // A nested marker is rendered as a real nested list, with the same hard
    // break rules inside the nested item.
    const nested = renderMarkdownPreview(['- parent', '  - child  ', '    more'].join('\n'));
    expect(nested).toContain('<li>parent');
    expect(nested).toContain('<li>child<br />more</li>');
    expect(nested.match(/<ul>/g) ?? []).toHaveLength(2);

    // A blank line followed by an indented block makes a multi-paragraph item
    // (a loose list): every item's paragraphs keep their <p> wrapper.
    const multi = renderMarkdownPreview(
      ['- first para', '', '  second para', '', '- next'].join('\n'),
    );
    expect(multi).toMatch(/<li><p>first para<\/p>\s*<p>second para<\/p><\/li>/u);
    expect(multi).toContain('<li><p>next</p></li>');

    // A list inside a blockquote uses the same renderer (and hard breaks).
    const quoted = renderMarkdownPreview(['> - one', '> - two  ', '>   more'].join('\n'));
    expect(quoted).toContain('<blockquote>');
    expect(quoted).toContain('<li>one</li>');
    expect(quoted).toContain('<li>two<br />more</li>');
  });

  it('keeps code blocks inside list items verbatim and never forges the break marker (X04)', () => {
    const html = renderMarkdownPreview(
      ['- item', '', '  ```text', '  code line  ', '  next line', '  ```'].join('\n'),
    );
    expect(html).toContain('<li>');
    expect(html).toContain('<pre');
    expect(html).toContain('code line  \nnext line');
    expect(html).not.toMatch(/code line[^<]*<br/u);

    // An author-typed marker character is text: the renderer must pick another
    // private-use marker and still emit exactly one real <br>.
    const forged = renderMarkdownPreview(['- item \uE010  ', '  next'].join('\n'));
    expect(forged).toContain('\uE010<br />next');
    expect(forged.match(/<br/g) ?? []).toHaveLength(1);
  });
});
