/**
 * Strict post-render sanitisation for Markdown that Astro renders at build
 * time.
 *
 * Astro's content loader gives us the rendered HTML string (`RenderedContent`),
 * so this module is the single choke point applied by
 * `apps/site/src/content.config.ts` to Home sections, Publications and Blog
 * bodies.
 *
 * The implementation and allowlist are shared with the author preview in
 * `packages/markdown/src/sanitize-markdown.ts` (exported as
 * `@selfpage/markdown/sanitize`). This file is intentionally a re-export shim:
 * the public site keeps its existing import path and behaviour while there is
 * exactly one allowlist in the repository.
 */
export {
  markdownSanitizeOptions,
  sanitizeMarkdownHtml,
} from '@selfpage/markdown/sanitize';
