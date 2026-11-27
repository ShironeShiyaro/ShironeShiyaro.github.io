/**
 * Strict post-render sanitisation for Markdown rendered by the public site.
 *
 * This is the single shared implementation. The public site re-exports it from
 * `apps/site/src/lib/sanitize-markdown.ts` (so its import path and behaviour
 * are unchanged) and the author preview imports it from this package. Keeping
 * it here removes the previous package-to-app reverse dependency.
 *
 * It is deliberately an allowlist: anything not listed below is discarded
 * rather than escaped, and raw HTML cannot smuggle scripts, event handlers,
 * dangerous URL schemes or layout-breaking CSS into the public site.
 *
 * Shiki (Astro's configured Markdown highlighter) needs `class` plus a small
 * set of inline styles on `pre`/`code`/`span`; those are kept, with the
 * smallest property/value allowlist that preserves the default `github-dark`
 * output.
 */
import sanitizeHtml from 'sanitize-html';

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
const FONT_STYLE = /^(?:normal|italic|oblique)$/i;
const FONT_WEIGHT = /^(?:normal|bold|bolder|lighter|[1-9]00)$/i;
const TEXT_DECORATION = /^(?:none|underline|line-through)(?:\s+(?:underline|line-through))?$/i;
const OVERFLOW_X = /^(?:auto|scroll|hidden)$/i;
const TAB_SIZE = /^\d{1,2}$/;

const SHIKI_STYLES = {
  'background-color': [HEX_COLOR],
  color: [HEX_COLOR],
  'font-style': [FONT_STYLE],
  'font-weight': [FONT_WEIGHT],
  'text-decoration': [TEXT_DECORATION],
  opacity: [/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/],
};

const allowedTags = [
  // Block and inline Markdown output. H1 is deliberately absent: every public
  // page renders its own single H1 from the content model, so a body `<h1>`
  // must lose its tag (its text remains) instead of creating a second H1.
  'p',
  'br',
  'hr',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'img',
  // GFM tables.
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // Syntax-highlighting wrapper emitted by Shiki.
  'span',
];

const allowedAttributes: sanitizeHtml.IOptions['allowedAttributes'] = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
  pre: ['class', 'style', 'tabindex'],
  code: ['class', 'style'],
  span: ['class', 'style'],
  th: ['scope', 'colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
};

export const markdownSanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags,
  allowedAttributes,
  allowedClasses: {
    pre: ['astro-code', 'shiki', /^[a-z0-9]+-(?:dark|light)$/i],
    code: [/^language-[a-z0-9+#.-]+$/i],
    span: ['line', 'highlighted', 'diff', 'add', 'remove'],
  },
  allowedStyles: {
    pre: {
      ...SHIKI_STYLES,
      'overflow-x': [OVERFLOW_X],
      'tab-size': [TAB_SIZE],
    },
    code: SHIKI_STYLES,
    span: SHIKI_STYLES,
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  // Images may only load from http(s); `data:` images are not allowed.
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  // Code blocks scroll horizontally inside `pre`; make each one keyboard
  // focusable with a fixed tabindex of 0 (author-supplied values are
  // overwritten here, so no positive tabindex can enter the page).
  transformTags: {
    pre: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, tabindex: '0' },
    }),
  },
  disallowedTagsMode: 'discard',
  // Never keep the text of executable/embedded elements: dropping the element
  // is required so `<script>alert(1)</script>` cannot surface as visible text
  // that a later feature might re-interpret.
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template'],
};

/** Sanitises rendered Markdown HTML with the site-wide allowlist. */
export function sanitizeMarkdownHtml(html: string): string {
  return sanitizeHtml(html, markdownSanitizeOptions);
}
