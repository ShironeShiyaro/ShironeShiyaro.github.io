import { describe, expect, it } from 'vitest';
import {
  compareBlogGroupKeysDescending,
  compareBlogPostsNewestFirst,
  sortBlogPostsNewestFirst,
} from './order.ts';

describe('order helpers', () => {
  it('orders posts by date descending, then time descending, then route ascending', () => {
    const posts = [
      { date: '2025-01-01', route: 'blog/2025/b/', time: '09:00' },
      { date: '2026-01-01', route: 'blog/2026/a/', time: '12:52' },
      { date: '2025-01-01', route: 'blog/2025/a/', time: '15:33' },
    ];
    expect(sortBlogPostsNewestFirst(posts).map((post) => post.route)).toEqual([
      'blog/2026/a/',
      'blog/2025/a/',
      'blog/2025/b/',
    ]);
    // Date wins over time: the 2025 post sorts after the 2026 post even though
    // its clock time (09:00) is earlier than the 2026 post's (12:52).
    expect(compareBlogPostsNewestFirst(posts[0]!, posts[1]!)).toBeGreaterThan(0);
  });

  it('R10-16: puts the later post first when both are on the same day', () => {
    const first = {
      date: '2026-11-27',
      route: 'blog/2026/The first blog-2026-11-27-12-52-30/',
      time: '12:52',
    };
    const second = {
      date: '2026-11-27',
      route: 'blog/2026/The second blog-2026-11-27-15-33-22/',
      time: '15:33',
    };
    expect(sortBlogPostsNewestFirst([first, second]).map((post) => post.time)).toEqual([
      '15:33',
      '12:52',
    ]);
    expect(compareBlogPostsNewestFirst(first, second)).toBeGreaterThan(0);
    expect(compareBlogPostsNewestFirst(second, first)).toBeLessThan(0);
  });

  it('keeps date ahead of time across different days', () => {
    const newerDateEarlierTime = { date: '2026-11-28', route: 'blog/2026/new-day/', time: '00:01' };
    const olderDateLaterTime = { date: '2026-11-27', route: 'blog/2026/old-day/', time: '23:59' };
    expect(sortBlogPostsNewestFirst([olderDateLaterTime, newerDateEarlierTime]).map((post) => post.date)).toEqual([
      '2026-11-28',
      '2026-11-27',
    ]);
  });

  it('places a same-day post without a time after every timed post', () => {
    const timed = { date: '2026-11-27', route: 'blog/2026/timed/', time: '08:00' };
    const untimedA = { date: '2026-11-27', route: 'blog/2026/aaa/' };
    const untimedZ = { date: '2026-11-27', route: 'blog/2026/zzz/' };
    expect(sortBlogPostsNewestFirst([untimedZ, timed, untimedA]).map((post) => post.route)).toEqual([
      'blog/2026/timed/',
      'blog/2026/aaa/',
      'blog/2026/zzz/',
    ]);
    // A timed post always precedes an untimed post on the same date.
    expect(compareBlogPostsNewestFirst(timed, untimedA)).toBeLessThan(0);
    expect(compareBlogPostsNewestFirst(untimedA, timed)).toBeGreaterThan(0);
  });

  it('uses route ascending when the date and the time are equal', () => {
    const b = { date: '2026-11-27', route: 'blog/2026/b/', time: '12:52' };
    const a = { date: '2026-11-27', route: 'blog/2026/a/', time: '12:52' };
    expect(sortBlogPostsNewestFirst([b, a]).map((post) => post.route)).toEqual([
      'blog/2026/a/',
      'blog/2026/b/',
    ]);
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
