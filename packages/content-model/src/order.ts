export interface BlogOrderFields {
  date: string;
  route: string;
  /**
   * Publication time `HH:mm` taken from the file name's `-HH-mm-ss` suffix
   * (D35). Absent for manual content without a usable time.
   */
  time?: string;
}

/**
 * Newest first, in a deterministic total order:
 *
 * 1. `date` descending (`YYYY-MM-DD`);
 * 2. on the same date, `time` descending (`HH:mm`, D35) so the later post of
 *    the day comes first. This fixes R10-16: the old code fell straight from
 *    date to `route`, which put "The first blog" above "The second blog" on
 *    the same day;
 * 3. a post without a time (manual content without `-HH-mm-ss`) sorts after
 *    every timed post on that same date: its publication time is unknown, so
 *    treating it as older than any known time is deterministic and keeps the
 *    date group intact;
 * 4. `route` ascending is the final tie-breaker for posts with the same date
 *    and the same `HH:mm` (or both without a time).
 */
export function compareBlogPostsNewestFirst(left: BlogOrderFields, right: BlogOrderFields): number {
  const byDate = right.date.localeCompare(left.date);
  if (byDate !== 0) return byDate;
  // An empty string sorts before every "HH:mm", so in newest-first order a
  // missing time lands last within the same date.
  const byTime = (right.time ?? '').localeCompare(left.time ?? '');
  if (byTime !== 0) return byTime;
  return left.route.localeCompare(right.route);
}

/** Return a newest-first copy; the input array is never mutated. */
export function sortBlogPostsNewestFirst<T extends BlogOrderFields>(posts: readonly T[]): T[] {
  return [...posts].sort(compareBlogPostsNewestFirst);
}

/** Descending lexicographic order for year and month keys (`2026` before `2025`). */
export function compareBlogGroupKeysDescending(left: string, right: string): number {
  return right.localeCompare(left);
}
