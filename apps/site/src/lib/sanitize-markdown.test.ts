import { describe, expect, it } from 'vitest';
import { sanitizeMarkdownHtml } from './sanitize-markdown';

function sanitize(markdownHtml: string): string {
  return sanitizeMarkdownHtml(markdownHtml);
}

describe('sanitizeMarkdownHtml allowlist', () => {
  it('keeps the Markdown structures the article page needs', () => {
    const html = sanitize(
      [
        '<h2>Section</h2>',
        '<p>Text with <strong>bold</strong>, <em>italics</em> and <del>deleted</del> text.</p>',
        '<ul><li>One</li><li>Two</li></ul>',
        '<ol><li>First</li></ol>',
        '<blockquote><p>Quote</p></blockquote>',
        '<p><a href="https://example.com/page">External</a></p>',
        '<p><a href="/blog/2025/example/">Site relative</a></p>',
        '<p><a href="mailto:author@example.com">Mail</a></p>',
        '<p><code>inline()</code></p>',
        '<table><thead><tr><th scope="col">Head</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>',
      ].join(''),
    );

    expect(html).toContain('<h2>Section</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italics</em>');
    expect(html).toContain('<del>deleted</del>');
    expect(html).toContain('<ul><li>One</li><li>Two</li></ul>');
    expect(html).toContain('<ol><li>First</li></ol>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('href="/blog/2025/example/"');
    expect(html).toContain('href="mailto:author@example.com"');
    expect(html).toContain('<code>inline()</code>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th scope="col">Head</th>');
    expect(html).toContain('<td>Cell</td>');
  });

  it('removes body H1 tags but keeps their text for the single page H1', () => {
    const html = sanitize('<h1>Duplicate <em>title</em></h1><p>After</p>');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('</h1>');
    expect(html).toContain('Duplicate <em>title</em>');
    expect(html).toContain('<p>After</p>');
  });

  it('keeps the classes and inline styles Shiki needs for code blocks', () => {
    const html = sanitize(
      '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8;overflow-x:auto;position:fixed" tabindex="5">' +
        '<code class="language-js"><span class="line"><span style="color:#F97583;font-weight:bold">const</span> x = 1;</span></code></pre>',
    );

    expect(html).toContain('class="astro-code github-dark"');
    expect(html).toContain('background-color:#24292e');
    expect(html).toContain('color:#e1e4e8');
    expect(html).toContain('overflow-x:auto');
    expect(html).toContain('class="language-js"');
    expect(html).toContain('class="line"');
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('tabindex="5"');
    expect(html).not.toContain('position:fixed');
  });

  it('removes executable tags, event handlers and dangerous protocols', () => {
    const html = sanitize(
      [
        '<h2>Heading</h2>',
        '<script>alert(1)</script>',
        '<style>body { color: red; }</style>',
        '<img src="x" alt="x" onerror="alert(1)" onload="alert(2)">',
        '<img src="data:image/png;base64,AAAA" alt="data">',
        '<a href="javascript:alert(1)">js</a>',
        '<a href="vbscript:msgbox(1)">vb</a>',
        '<a href="data:text/html,<script>alert(1)</script>">data</a>',
        '<a href="java&#x73;cript:alert(1)">entity</a>',
        '<a href="//evil.example/">protocol relative</a>',
        '<iframe src="https://example.com"></iframe>',
        '<object data="x"></object>',
        '<embed src="x">',
        '<form action="/x"><input name="x"><button>go</button></form>',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        '<link rel="stylesheet" href="https://evil.example/x.css">',
        '<svg onload="alert(1)"><circle r="1"></circle></svg>',
        '<p style="position:fixed" class="x">styled</p>',
        '<span class="line" style="color:#fff;position:fixed;background-image:url(javascript:alert(1))">code</span>',
      ].join(''),
    );

    for (const forbidden of [
      '<script',
      '<style',
      'onerror',
      'onload',
      'javascript:',
      'vbscript:',
      'data:text/html',
      'data:image',
      '//evil.example',
      '<iframe',
      '<object',
      '<embed',
      '<form',
      '<input',
      '<button',
      '<meta',
      '<link',
      '<svg',
      'position:fixed',
      'background-image',
      'url(',
      'alert(1)',
    ]) {
      expect(html, `must not contain ${forbidden}`).not.toContain(forbidden);
    }

    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('alt="x"');
    expect(html).toContain('alt="data"');
    expect(html).not.toContain('src="data:image');
    expect(html).toContain('>js</a>');
    expect(html).toContain('>protocol relative</a>');
    expect(html).toContain('color:#fff');
  });

  it('drops unknown classes instead of passing them through', () => {
    const html = sanitize(
      '<pre class="astro-code site-drawer"><code class="language-js nav-scroll-locked"><span class="line is-current">x</span></code></pre>',
    );
    expect(html).toContain('class="astro-code"');
    expect(html).toContain('class="language-js"');
    expect(html).toContain('class="line"');
    expect(html).not.toContain('site-drawer');
    expect(html).not.toContain('nav-scroll-locked');
    expect(html).not.toContain('is-current');
  });

  it('returns safe empty output for empty input', () => {
    expect(sanitize('')).toBe('');
  });
});
