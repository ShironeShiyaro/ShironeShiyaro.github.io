/**
 * Public site configuration for the author app (task 07.5, D29).
 *
 * The author app lives on its own origin, so the shell links and the fixed
 * "Back to Blog" target come from `PUBLIC_SITE_ORIGIN` — validated and baked in
 * at build time by `apps/author/vite.config.ts` (development default
 * `http://localhost:4321`). The author app never hard-codes or guesses the
 * production domain; `BASE_PATH` is read by the same build so a project-page
 * deployment keeps its sub-path.
 *
 * Only public navigation data crosses the origin boundary. No session, token,
 * CSRF value or other secret is ever placed in a cross-origin URL,
 * localStorage or a postMessage payload.
 */
export { publicBlogUrl as PUBLIC_BLOG_URL, publicSiteOrigin as PUBLIC_SITE_ORIGIN } from 'virtual:selfpage-site-nav';
