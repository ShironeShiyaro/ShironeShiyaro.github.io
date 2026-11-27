import { DEFAULT_AUTHOR_ORIGIN } from './types.ts';

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+.-]*:/i;

function assertSafeString(value: string, label: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }
  if (/\s/.test(value)) {
    throw new Error(`${label} must not contain whitespace`);
  }
}

/**
 * Normalise BASE_PATH into `/` or a value with exactly one leading and one
 * trailing slash. Throws on values that cannot be used safely as a public base.
 * A missing trailing slash is normalised and, when a warning callback is
 * supplied, reported instead of silently changing the configuration.
 */
export function normalizeBasePath(
  raw?: string | null,
  warn?: (message: string) => void,
): string {
  const value = (raw ?? '').trim();
  if (value === '' || value === '/') {
    return '/';
  }
  if (value.startsWith('//')) {
    throw new Error('BASE_PATH must not start with a protocol-relative "//"');
  }
  if (!value.startsWith('/')) {
    throw new Error('BASE_PATH must start with "/"');
  }
  if (/[\\?#%]/.test(value)) {
    throw new Error('BASE_PATH must not contain "\\", "?", "#" or "%"');
  }
  assertSafeString(value, 'BASE_PATH');
  if (value.slice(1).includes('//')) {
    throw new Error('BASE_PATH must not contain empty path segments');
  }
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('BASE_PATH must not contain "." or ".." segments');
  }
  const normalized = `/${segments.join('/')}/`;
  if (!value.endsWith('/')) {
    warn?.(`BASE_PATH "${value}" is missing a trailing slash; normalised to "${normalized}"`);
  }
  return normalized;
}

/**
 * Prefix a site-internal path with BASE_PATH. The input must not already
 * contain the base path; double-prefixing is a configuration error, not
 * something to silently repair.
 */
export function withBasePath(basePath: string | undefined, internalPath: string): string {
  const base = normalizeBasePath(basePath);
  const path = internalPath.trim();
  assertSafeString(path, 'Internal path');
  if (ABSOLUTE_URL_PATTERN.test(path) || path.startsWith('//')) {
    throw new Error(`Internal path must not be an absolute or protocol-relative URL: ${path}`);
  }
  if (path.includes('\\')) {
    throw new Error(`Internal path must use "/" separators: ${path}`);
  }
  const withoutLeadingSlashes = path.replace(/^\/+/, '');
  if (base !== '/') {
    const baseSegment = base.slice(1, -1);
    if (withoutLeadingSlashes === baseSegment || withoutLeadingSlashes.startsWith(`${baseSegment}/`)) {
      throw new Error(`Internal path already contains BASE_PATH "${base}": ${path}`);
    }
  }
  const result = `${base}${withoutLeadingSlashes}`;
  if (result.includes('//') && !result.startsWith('http://') && !result.startsWith('https://')) {
    throw new Error(`Internal path produced a double slash: ${result}`);
  }
  return result;
}

/**
 * Build the public URL of the author application's New! entry point from the
 * single PUBLIC_AUTHOR_ORIGIN configuration value.
 */
export function buildAuthorNewHref(rawOrigin?: string | null): string {
  const value = (rawOrigin ?? DEFAULT_AUTHOR_ORIGIN).trim();
  if (value === '') {
    throw new Error('PUBLIC_AUTHOR_ORIGIN must not be empty');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_AUTHOR_ORIGIN must be a valid absolute URL: ${value}`);
  }
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('PUBLIC_AUTHOR_ORIGIN must use https (http is allowed only for localhost)');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('PUBLIC_AUTHOR_ORIGIN must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('PUBLIC_AUTHOR_ORIGIN must not contain a query string or fragment');
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }
  return new URL('new/', url).href;
}

/**
 * A publication link that starts with one `/` must stay an unambiguous
 * same-site path: no query string, no fragment, and no `.`/`..` segments (also
 * after percent-decoding), which a browser could normalise outside BASE_PATH.
 */
function assertSiteRelativePath(value: string): void {
  if (value.includes('?') || value.includes('#')) {
    throw new Error('site-relative links must not contain a query string or fragment');
  }
  for (const segment of value.split('/').slice(1)) {
    if (segment === '.' || segment === '..') {
      throw new Error('site-relative links must not contain "." or ".." path segments');
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    if (decoded === '.' || decoded === '..') {
      throw new Error('site-relative links must not contain percent-encoded "." or ".." path segments');
    }
  }
}

/**
 * Validate a publication link from content. Absolute http(s) URLs are kept;
 * a single-leading-slash path is treated as site-internal and receives BASE_PATH.
 */
export function resolvePublicUrl(rawValue: string, basePath: string | undefined): string {
  const value = rawValue.trim();
  if (value === '') {
    throw new Error('link must not be empty; omit the field when there is no link');
  }
  if (/\s/.test(value)) {
    throw new Error(`link must not contain whitespace: ${value}`);
  }
  if (value.startsWith('//')) {
    throw new Error('protocol-relative links are not allowed');
  }
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`link is not a valid absolute URL: ${value}`);
    }
    if (url.username !== '' || url.password !== '') {
      throw new Error('links must not contain credentials');
    }
    return url.href;
  }
  if (ABSOLUTE_URL_PATTERN.test(value)) {
    throw new Error(`unsupported link protocol: ${value}`);
  }
  if (!value.startsWith('/')) {
    throw new Error('link must be an absolute http(s) URL or a site-relative path starting with "/"');
  }
  assertSiteRelativePath(value);
  return withBasePath(basePath, value);
}
