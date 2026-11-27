/**
 * Public site origin for the author app (task 07.5, D29).
 *
 * The author app is served from its own origin, so every shell link must be an
 * absolute URL back to the public site. `PUBLIC_SITE_ORIGIN` is public config
 * (never a secret), and this module is the only place that validates it:
 *
 * - `https:` is always allowed (the production domain);
 * - `http:` is allowed only for a loopback development host (`localhost`,
 *   `127.0.0.1`, `[::1]`), matching the documented development default;
 * - credentials, a query, a fragment or a path are rejected. The site's
 *   `BASE_PATH` is a separate build input, so accepting a path here would
 *   silently duplicate it in every link.
 *
 * The author app must never hard-code or guess a production domain.
 */
export const DEFAULT_PUBLIC_SITE_ORIGIN = 'http://localhost:4321';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validates and normalises `PUBLIC_SITE_ORIGIN`; throws on an unsafe value. */
export function resolvePublicSiteOrigin(raw: string | undefined): string {
  const candidate = raw?.trim();
  if (!candidate) {
    return DEFAULT_PUBLIC_SITE_ORIGIN;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`PUBLIC_SITE_ORIGIN is not a valid URL: ${candidate}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PUBLIC_SITE_ORIGIN must use https:// (or http://localhost for development): ${candidate}`);
  }
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(
      `PUBLIC_SITE_ORIGIN may only use plain http:// for a loopback development host: ${candidate}`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`PUBLIC_SITE_ORIGIN must not contain credentials: ${candidate}`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error(`PUBLIC_SITE_ORIGIN must not contain a query or fragment: ${candidate}`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(
      `PUBLIC_SITE_ORIGIN must be an origin without a path; set BASE_PATH for the site's sub-path: ${candidate}`,
    );
  }
  return url.origin;
}

/**
 * Resolves a site-root-relative href (for example `/blog/`, already carrying
 * `BASE_PATH`) against the public site origin. The author app never builds a
 * second, guessed route: every href comes from the same content-model manifest
 * the public site uses.
 */
export function resolveSiteHref(siteOrigin: string, href: string): string {
  const base = siteOrigin.endsWith('/') ? siteOrigin : `${siteOrigin}/`;
  return new URL(href, base).toString();
}
