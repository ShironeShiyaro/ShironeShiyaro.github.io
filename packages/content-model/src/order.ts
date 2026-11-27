export interface BlogOrderFields {
  date: string;
  route: string;
}

/** Newest date first, then route ascending as a deterministic tie-breaker. */
export function compareBlogPostsNewestFirst(left: BlogOrderFields, right: BlogOrderFields): number {
  const byDate = right.date.localeCompare(left.date);
  return byDate !== 0 ? byDate : left.route.localeCompare(right.route);
}

/** Return a newest-first copy; the input array is never mutated. */
export function sortBlogPostsNewestFirst<T extends BlogOrderFields>(posts: readonly T[]): T[] {
  return [...posts].sort(compareBlogPostsNewestFirst);
}

/** Descending lexicographic order for year and month keys (`2026` before `2025`). */
export function compareBlogGroupKeysDescending(left: string, right: string): number {
  return right.localeCompare(left);
}
