import { describe, expect, it } from 'vitest';
import {
  compareBlogGroupKeysDescending,
  compareBlogPostsNewestFirst,
  sortBlogPostsNewestFirst,
} from './order.ts';

describe('order helpers', () => {
  it('orders posts by date descending and then route ascending', () => {
    const posts = [
      { date: '2025-01-01', route: 'blog/2025/b/' },
      { date: '2026-01-01', route: 'blog/2026/a/' },
      { date: '2025-01-01', route: 'blog/2025/a/' },
    ];
    expect(sortBlogPostsNewestFirst(posts).map((post) => post.route)).toEqual([
      'blog/2026/a/',
      'blog/2025/a/',
      'blog/2025/b/',
    ]);
    expect(compareBlogPostsNewestFirst(posts[0]!, posts[2]!)).toBeGreaterThan(0);
  });

  it('does not mutate the input array', () => {
    const posts = [
      { date: '2025-01-01', route: 'blog/2025/a/' },
      { date: '2026-01-01', route: 'blog/2026/a/' },
    ];
    const sorted = sortBlogPostsNewestFirst(posts);
    expect(sorted).not.toBe(posts);
    expect(posts.map((post) => post.date)).toEqual(['2025-01-01', '2026-01-01']);
  });

  it('orders year and month keys descending', () => {
    expect(['2025', '2026', '2024'].sort(compareBlogGroupKeysDescending)).toEqual([
      '2026',
      '2025',
      '2024',
    ]);
    expect(['2025-03', '2025-11', '2026-01'].sort(compareBlogGroupKeysDescending)).toEqual([
      '2026-01',
      '2025-11',
      '2025-03',
    ]);
  });
});
