/**
 * Independent preview-safety tests (task 06).
 *
 * The frozen criteria only require the preview to use the public site's
 * sanitizer allowlist, not to reproduce Astro's renderer. These tests measure
 * exactly that: `renderMarkdownPreview` must be the composition of the local
 * renderer and the *same* `sanitizeMarkdownHtml` module that the public site
 * re-exports, and adversarial Markdown/HTML must not survive as active content.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderMarkdownBodyHtml,
  renderMarkdownPreview,
  sanitizePreviewHtml,
} from './preview.ts';
import {
  markdownSanitizeOptions,
  sanitizeMarkdownHtml,
} from './sanitize-markdown.ts';
import {
  markdownSanitizeOptions as siteMarkdownSanitizeOptions,
  sanitizeMarkdownHtml as siteSanitizeMarkdownHtml,
} from '../../../apps/site/src/lib/sanitize-markdown.ts';

const VECTORS: Array<[string, string]> = [
  ['plain paragraph', 'Hello **world** and `code`.'],
  ['h1 in body', '# Not a second H1'],
  ['list', '- one\n- two\n\n1. first\n2. second'],
  ['fence', '```ts\nconst x = "<tag>";\n```'],
  ['raw script', '<script>alert(1)</script>'],
  ['raw img onerror', '<img src=x onerror="alert(1)">'],
  ['javascript link', '[click](javascript:alert(1))'],
  ['data image', '![alt](data:image/png;base64,AAAA)'],
  ['protocol-relative link', '[x](//evil.example/a)'],
  ['quote and hr', '> quoted\n\n---\n\nend'],
  ['angle text', 'a < b > c'],
  ['private use', '\uE0000\uE001 literal'],
];

describe('[independent] preview sanitisation parity', () => {
  it('public site module is a re-export of the single package implementation', () => {
    expect(siteSanitizeMarkdownHtml).toBe(sanitizeMarkdownHtml);
    expect(siteMarkdownSanitizeOptions).toBe(markdownSanitizeOptions);
    expect(renderMarkdownPreview('**shared**')).toBe(siteSanitizeMarkdownHtml('<p><strong>shared</strong></p>'));
  });

  it.each(VECTORS)('is the exact composition of the site sanitizer: %s', (_label, markdown) => {
    expect(renderMarkdownPreview(markdown)).toBe(
      sanitizeMarkdownHtml(renderMarkdownBodyHtml(markdown)),
    );
    expect(sanitizePreviewHtml('<p>probe</p>')).toBe(sanitizeMarkdownHtml('<p>probe</p>'));
  });

  it('drops everything outside the public site allowlist, even if a caller builds raw HTML', () => {
    const hostile =
      '<div>div</div><iframe src="https://evil"></iframe><style>p{}</style>' +
      '<svg onload="alert(1)"></svg><a href="https://ok.example" onclick="alert(1)">ok</a>' +
      '<p style="position:fixed">styled</p><img src="data:image/png;base64,AA">' +
      '<pre><code>code</code></pre><table><tr><td>cell</td></tr></table>';
    const output = sanitizePreviewHtml(hostile);
    expect(output).not.toMatch(/<div|<iframe|<style|<svg|onload|onclick|style=|src="data:/i);
    expect(output).toContain('div');
    expect(output).toContain('<a href="https://ok.example">ok</a>');
    expect(output).not.toContain('onclick');
    expect(output).toContain('<p>styled</p>');
    expect(output).toContain('<pre tabindex="0"><code>code</code></pre>');
    expect(output).toContain('<table>');
  });

  it('keeps only plain text from pasted/raw HTML in Markdown and never an executable element', () => {
    const markdown =
      '<img src=x onerror="alert(1)">\n\n' +
      '<script>document.title="pwned"</script>\n\n' +
      '[x](javascript:alert(document.domain))\n\n' +
      '[y](vbscript:msgbox)\n\n' +
      '![z](data:text/html,<script>alert(1)</script>)';
    const html = renderMarkdownPreview(markdown);
    // The HTML-significant characters are escaped text, not live markup; no
    // executable element/URL survives. Event-handler *text* inside an escaped
    // tag (`&lt;img ... onerror=...&gt;`) is inert.
    expect(html).not.toMatch(/<script|<img|href="javascript:|href="vbscript:|src="data:/i);
    const tagNames = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((match) => match[1]);
    expect(new Set(tagNames)).toEqual(new Set(['p']));
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('renders a body-authored H1 as literal paragraph text (never a second document h1)', () => {
    const html = renderMarkdownPreview('# Body heading');
    expect(html).not.toContain('<h1');
    expect(html).toContain('<p># Body heading</p>');
  });

  it('escapes HTML-significant characters in inline text', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
    const html = renderMarkdownPreview('5 < 7 & 9 > 3 "q"');
    // sanitize-html re-serialises text nodes, so a double quote may appear
    // unescaped in text (safe); `<`, `>` and `&` must stay escaped.
    expect(html).toContain('5 &lt; 7 &amp; 9 &gt; 3 "q"');
  });

  it('keeps safe http(s)/mailto links but strips unsafe schemes and protocol-relative URLs', () => {
    const html = renderMarkdownPreview(
      '[a](https://example.com/a?x=1&y=2) [b](mailto:a@example.com) ' +
        '[c](ftp://example.com) [d](//example.com)',
    );
    expect(html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(html).toContain('href="mailto:a@example.com"');
    expect(html).not.toMatch(/ftp:|href="\/\//);
    expect(html).toContain('c');
    expect(html).toContain('d');
  });
});
