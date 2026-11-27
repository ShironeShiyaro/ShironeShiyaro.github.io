import { isValidIsoDate } from './markdown.ts';

/**
 * Turn a resume/blog heading into a stable, unique fragment id.
 * Unicode letters, numbers and combining marks are kept; everything else
 * becomes a dash. Duplicate ids are suffixed deterministically.
 */
export function slugifyHeading(title: string): string {
  const normalized = title.normalize('NFC').toLowerCase().trim();
  const slug = normalized
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'section' : slug;
}

/**
 * Keep every generated id in a used-id set. Counting occurrences of a base slug
 * is not enough: a distinct heading such as `About Me 2` already produces the
 * candidate `about-me-2`, which must not be handed out again to a repeated
 * `About Me`. A conflicting base keeps its numeric family (`about-me-2` ->
 * `about-me-3`) or starts at `-2`; the suffix increases until the id is unused.
 */
export function createUniqueSlugger(): (title: string) => string {
  const used = new Set<string>();
  return (title: string) => {
    const base = slugifyHeading(title);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    const trailingSuffix = /^(.*)-(\d+)$/.exec(base);
    const root = trailingSuffix?.[1] ? trailingSuffix[1] : base;
    let suffix = trailingSuffix?.[2] ? Number(trailingSuffix[2]) + 1 : 2;
    let candidate = `${root}-${suffix}`;
    while (used.has(candidate)) {
      suffix += 1;
      candidate = `${root}-${suffix}`;
    }
    used.add(candidate);
    return candidate;
  };
}

/**
 * Characters that Astro's static build URL (`encodeURI` over a decoded path)
 * and the manifest route (`encodeURIComponent` per path segment) do not encode
 * identically. A content file path containing one of them would produce two
 * different blog routes, so the validator rejects it instead of guessing.
 *
 * `/` and `\` are path separators and are handled by `deriveBlogPathSegments`.
 * `%`, spaces, Unicode letters (CJK included) and combining marks encode the
 * same way in both functions and stay allowed.
 */
export const BLOG_ROUTE_RESERVED_CHARACTERS = '#$&+,:;=?@';

/** Return the first reserved route character in a path, or `null`. */
export function findReservedBlogRouteCharacter(relativeFileWithoutExtension: string): string | null {
  for (const segment of relativeFileWithoutExtension.split(/[\\/]/)) {
    for (const character of segment.normalize('NFC')) {
      if (BLOG_ROUTE_RESERVED_CHARACTERS.includes(character)) {
        return character;
      }
    }
  }
  return null;
}

export interface UnsafeBlogPathSegment {
  reason: 'empty-segment' | 'dot-segment';
  segment: string;
}

/**
 * Reject path segments that a browser or file system would normalise: empty
 * segments (including a file literally named `.md`) and `.`/`..` segments.
 * These would otherwise turn a blog post into the blog index or escape its
 * directory. The caller reports the content file path.
 */
export function findUnsafeBlogPathSegment(relativeFileWithoutExtension: string): UnsafeBlogPathSegment | null {
  const segments = relativeFileWithoutExtension.split(/[\\/]/);
  if (relativeFileWithoutExtension === '' || segments.some((segment) => segment === '')) {
    return { reason: 'empty-segment', segment: '' };
  }
  const dotSegment = segments.find((segment) => segment === '.' || segment === '..');
  return dotSegment === undefined ? null : { reason: 'dot-segment', segment: dotSegment };
}

/**
 * New! title-to-file-name rule (D14): Unicode NFC, trim, replace `/`, `\`,
 * control characters and Windows-illegal characters (`< > : " | ? *`) with `-`.
 * No truncation and no hash. Reserved route characters are not replaced here;
 * the loader rejects them separately (U5), and New! must report an error rather
 * than silently generating a route breaking filename.
 */
export function sanitizeBlogTitleForFileName(title: string): string {
  return title
    .normalize('NFC')
    .trim()
    .replace(/[\/\\\u0000-\u001f\u007f<>:"|?*]/g, '-');
}

export type BlogFileNameCheck =  | { ok: true; date: string; time: string; title: string }
  | {
      ok: false;
      reason: 'invalid-date' | 'invalid-time' | 'missing-timestamp' | 'title-too-long';
      detail: string;
    };

const BLOG_FILE_NAME_PATTERN =
  /^(?<title>.+)-(?<date>\d{4}-\d{2}-\d{2})-(?<hour>\d{2})-(?<minute>\d{2})-(?<second>\d{2})$/;

/**
 * Validate the documented `<sanitised title>-YYYY-MM-DD-HH-mm-ss.md` file name
 * contract (the `.md` extension is already removed). The date and 24-hour time
 * must be real; the caller compares the date with the visible date.
 */
export function parseBlogFileName(fileNameWithoutExtension: string): BlogFileNameCheck {
  const match = BLOG_FILE_NAME_PATTERN.exec(fileNameWithoutExtension);
  const groups = match?.groups;
  if (groups === undefined) {
    return {
      ok: false,
      reason: 'missing-timestamp',
      detail: 'file name must end with -YYYY-MM-DD-HH-mm-ss before the .md extension',
    };
  }
  const title = groups.title ?? '';
  const date = groups.date ?? '';
  const hour = groups.hour ?? '';
  const minute = groups.minute ?? '';
  const second = groups.second ?? '';
  if (!isValidIsoDate(date)) {
    return { ok: false, reason: 'invalid-date', detail: `file name date "${date}" is not a real calendar date` };
  }
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return {
      ok: false,
      reason: 'invalid-time',
      detail: `file name time "${hour}-${minute}-${second}" is not a valid 24-hour time`,
    };
  }
  if (new TextEncoder().encode(title.normalize('NFC')).length > 232) {
    return { ok: false, reason: 'title-too-long', detail: 'file name title exceeds 232 UTF-8 bytes' };
  }
  return { ok: true, title, date, time: `${hour}-${minute}-${second}` };
}

/**
 * Loader-side file-name check for the D35 fallback (review P1-5).
 *
 * Manual blog files may omit the `-HH-mm-ss` suffix (`<title>-YYYY-MM-DD.md`) or
 * carry an impossible time; the date itself stays a hard requirement (D14) and
 * the loader only warns about the missing/invalid time, then displays the date
 * without a time. `parseBlogFileName` above remains the strict contract used by
 * New!, which always writes a valid time.
 */
export type BlogFileNameLoadCheck =
  | {
      ok: true;
      title: string;
      date: string;
      /** `HH-mm-ss` when the file name carries a valid time, `null` otherwise. */
      time: string | null;
      /** Why `time` is null; the loader reports it as a warning. */
      timeIssue?: 'missing-time' | 'invalid-time';
    }
  | {
      ok: false;
      reason: 'invalid-date' | 'missing-date' | 'title-too-long';
      detail: string;
    };

const BLOG_FILE_NAME_LOAD_PATTERN =
  /^(?<title>.+)-(?<date>\d{4}-\d{2}-\d{2})(?:-(?<hour>\d{2})-(?<minute>\d{2})-(?<second>\d{2}))?$/;

export function parseBlogFileNameForLoad(fileNameWithoutExtension: string): BlogFileNameLoadCheck {
  const groups = BLOG_FILE_NAME_LOAD_PATTERN.exec(fileNameWithoutExtension)?.groups;
  if (groups === undefined) {
    return {
      ok: false,
      reason: 'missing-date',
      detail: 'file name must end with -YYYY-MM-DD or -YYYY-MM-DD-HH-mm-ss before the .md extension',
    };
  }
  const title = groups.title ?? '';
  const date = groups.date ?? '';
  if (!isValidIsoDate(date)) {
    return { ok: false, reason: 'invalid-date', detail: `file name date "${date}" is not a real calendar date` };
  }
  if (new TextEncoder().encode(title.normalize('NFC')).length > 232) {
    return { ok: false, reason: 'title-too-long', detail: 'file name title exceeds 232 UTF-8 bytes' };
  }
  const hour = groups.hour;
  if (hour === undefined) {
    return { ok: true, title, date, time: null, timeIssue: 'missing-time' };
  }
  const minute = groups.minute ?? '';
  const second = groups.second ?? '';
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return {
      ok: true,
      title,
      date,
      time: null,
      timeIssue: 'invalid-time',
    };
  }
  return { ok: true, title, date, time: `${hour}-${minute}-${second}` };
}

/**
 * The route is derived only from the repository-relative file path:
 * remove `.md`, Unicode-NFC each segment, then encodeURIComponent each segment.
 * Percent signs are encoded as `%25` and hex digits are uppercase.
 *
 * `deriveBlogPathSegments` is the decoded form consumed by Astro's
 * `getStaticPaths`; both the route and those segments are produced by this one
 * file-path parsing step so the page never calculates a second route.
 */
export function deriveBlogRoute(relativeFileWithoutExtension: string): string {
  return deriveBlogRouteFromSegments(deriveBlogPathSegments(relativeFileWithoutExtension));
}

export function deriveBlogRouteFromSegments(segments: readonly string[]): string {
  const encoded = segments
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment.normalize('NFC')));
  return `blog/${encoded.join('/')}/`;
}

export function deriveBlogPathSegments(relativeFileWithoutExtension: string): string[] {
  return relativeFileWithoutExtension
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.normalize('NFC'));
}
