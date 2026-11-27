import { describe, expect, it } from 'vitest';
import {
  BLOG_ROUTE_RESERVED_CHARACTERS,
  createUniqueSlugger,
  deriveBlogPathSegments,
  deriveBlogRoute,
  deriveBlogRouteFromSegments,
  findReservedBlogRouteCharacter,
  findUnsafeBlogPathSegment,
  parseBlogFileName,
  sanitizeBlogTitleForFileName,
  slugifyHeading,
} from './slug.ts';

describe('slugifyHeading', () => {
  it('creates lowercase, hyphenated fragment ids', () => {
    expect(slugifyHeading('About Me')).toBe('about-me');
    expect(slugifyHeading('  Projects & Notes  ')).toBe('projects-notes');
    expect(slugifyHeading('!!!')).toBe('section');
  });

  it('keeps Unicode letters and normalises NFC/NFD to the same id', () => {
    const nfc = 'Café Notes';
    const nfd = nfc.normalize('NFD');
    expect(slugifyHeading(nfc)).toBe('café-notes');
    expect(slugifyHeading(nfd)).toBe(slugifyHeading(nfc));
  });

  it('suffixes duplicate titles deterministically', () => {
    const next = createUniqueSlugger();
    expect(next('About Me')).toBe('about-me');
    expect(next('About Me')).toBe('about-me-2');
    expect(next('About Me')).toBe('about-me-3');
    expect(next('Skills')).toBe('skills');
  });

  it('never reuses an id already claimed by a different heading (review P0-1)', () => {
    const next = createUniqueSlugger();
    const ids = ['About Me', 'About Me', 'About Me 2'].map((title) => next(title));
    expect(ids).toEqual(['about-me', 'about-me-2', 'about-me-3']);
    expect(new Set(ids).size).toBe(ids.length);

    const other = createUniqueSlugger();
    const sectionIds = ['Section', 'Section 2', 'Section'].map((title) => other(title));
    expect(sectionIds).toEqual(['section', 'section-2', 'section-3']);
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
  });

  it('also handles the suffixed title appearing first', () => {
    const next = createUniqueSlugger();
    const ids = ['Section 2', 'Section', 'Section'].map((title) => next(title));
    expect(ids).toEqual(['section-2', 'section', 'section-3']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('deriveBlogRoute', () => {
  it('derives a route from path segments with NFC and encodeURIComponent', () => {
    expect(deriveBlogRoute('2025/Hello World')).toBe('blog/2025/Hello%20World/');
    expect(deriveBlogRoute('2025/Café Notes')).toBe('blog/2025/Caf%C3%A9%20Notes/');
    expect(deriveBlogRoute('2025/Café Notes'.normalize('NFD'))).toBe('blog/2025/Caf%C3%A9%20Notes/');
  });

  it('encodes percent signs, keeps hex uppercase and handles Windows separators', () => {
    expect(deriveBlogRoute('2025/100% Done')).toBe('blog/2025/100%25%20Done/');
    expect(deriveBlogRoute('2025\\backslash')).toBe('blog/2025/backslash/');
    expect(deriveBlogRoute('2025/中文')).toBe('blog/2025/%E4%B8%AD%E6%96%87/');
  });

  it('exposes NFC path segments for getStaticPaths', () => {
    expect(deriveBlogPathSegments('2025/Café Notes'.normalize('NFD'))).toEqual(['2025', 'Café Notes']);
  });

  it('builds the route from the same segments Astro consumes', () => {
    const path = '2025/Café  Notes-2025-06-01-00-00-00';
    const segments = deriveBlogPathSegments(path);
    expect(deriveBlogRouteFromSegments(segments)).toBe(deriveBlogRoute(path));
    expect(encodeURI(segments.join('/'))).toBe(deriveBlogRoute(path).slice('blog/'.length, -1));
  });
});

describe('reserved route characters', () => {
  it('lists the characters whose Astro build URL differs from encodeURIComponent', () => {
    expect(BLOG_ROUTE_RESERVED_CHARACTERS).toBe('#$&+,:;=?@');
  });

  it('finds reserved characters in any path segment after NFC normalisation', () => {
    expect(findReservedBlogRouteCharacter('2025/C# Notes-2025-06-01-00-00-00')).toBe('#');
    expect(findReservedBlogRouteCharacter('2025/Q&A-2025-06-01-00-00-00')).toBe('&');
    expect(findReservedBlogRouteCharacter('2025/C++ Tips-2025-06-01-00-00-00')).toBe('+');
    expect(findReservedBlogRouteCharacter('2025/A$B-2025-06-01-00-00-00')).toBe('$');
    expect(findReservedBlogRouteCharacter('2025/A,B-2025-06-01-00-00-00')).toBe(',');
    expect(findReservedBlogRouteCharacter('2025/A;B-2025-06-01-00-00-00')).toBe(';');
    expect(findReservedBlogRouteCharacter('2025/A=B-2025-06-01-00-00-00')).toBe('=');
    expect(findReservedBlogRouteCharacter('2025/A@B-2025-06-01-00-00-00')).toBe('@');
    expect(findReservedBlogRouteCharacter('2025/A:B-2025-06-01-00-00-00')).toBe(':');
    expect(findReservedBlogRouteCharacter('2025/A?B-2025-06-01-00-00-00')).toBe('?');
  });

  it('allows spaces, percent signs, CJK and NFC-normalised accents', () => {
    expect(findReservedBlogRouteCharacter('2025/Café Notes-2025-06-01-00-00-00')).toBeNull();
    expect(findReservedBlogRouteCharacter('2025/Café Notes-2025-06-01-00-00-00'.normalize('NFD'))).toBeNull();
    expect(findReservedBlogRouteCharacter('2025/100% Done-2025-06-01-00-00-00')).toBeNull();
    expect(findReservedBlogRouteCharacter('2025/中文 标题-2025-06-01-00-00-00')).toBeNull();
  });
});

describe('unsafe blog path segments', () => {
  it('rejects empty, dot and dot-dot segments', () => {
    expect(findUnsafeBlogPathSegment('')).toEqual({ reason: 'empty-segment', segment: '' });
    expect(findUnsafeBlogPathSegment('2025/')).toEqual({ reason: 'empty-segment', segment: '' });
    expect(findUnsafeBlogPathSegment('2025//post')).toEqual({ reason: 'empty-segment', segment: '' });
    expect(findUnsafeBlogPathSegment('.')).toEqual({ reason: 'dot-segment', segment: '.' });
    expect(findUnsafeBlogPathSegment('2025/..')).toEqual({ reason: 'dot-segment', segment: '..' });
    expect(findUnsafeBlogPathSegment('2025/./post')).toEqual({ reason: 'dot-segment', segment: '.' });
  });

  it('accepts normal nested blog paths, including dot-prefixed file names', () => {
    expect(findUnsafeBlogPathSegment('2025/Reading List-2026-01-01-00-00-00')).toBeNull();
    expect(findUnsafeBlogPathSegment('2025/.hidden')).toBeNull();
    expect(findUnsafeBlogPathSegment('2025/...')).toBeNull();
  });
});

describe('parseBlogFileName', () => {
  it('accepts the documented title-date-time contract', () => {
    expect(parseBlogFileName('Reading List-2026-11-20-08-40-00')).toEqual({
      ok: true,
      title: 'Reading List',
      date: '2026-11-20',
      time: '08-40-00',
    });
    expect(parseBlogFileName('中文 标题-2025-06-02-00-00-00')).toEqual({
      ok: true,
      title: '中文 标题',
      date: '2025-06-02',
      time: '00-00-00',
    });
  });

  it('rejects a missing timestamp, invalid date and invalid time', () => {
    expect(parseBlogFileName('no-timestamp')).toMatchObject({ ok: false, reason: 'missing-timestamp' });
    expect(parseBlogFileName('bad-date-2025-02-30-00-00-00')).toMatchObject({
      ok: false,
      reason: 'invalid-date',
    });
    expect(parseBlogFileName('bad-time-2025-01-01-24-00-00')).toMatchObject({
      ok: false,
      reason: 'invalid-time',
    });
    expect(parseBlogFileName('bad-time-2025-01-01-12-60-00')).toMatchObject({
      ok: false,
      reason: 'invalid-time',
    });
  });

  it('rejects a title longer than the documented 232 UTF-8 bytes', () => {
    const title = 'é'.repeat(117);
    expect(new TextEncoder().encode(title).length).toBe(234);
    expect(parseBlogFileName(`${title}-2025-01-01-00-00-00`)).toMatchObject({
      ok: false,
      reason: 'title-too-long',
    });
  });

  it('parses title text that itself contains dates or hyphen boundaries (D14)', () => {
    expect(parseBlogFileName('Draft 2025-01-01 notes-2025-01-02-00-00-00')).toMatchObject({
      ok: true,
      title: 'Draft 2025-01-01 notes',
      date: '2025-01-02',
    });
    expect(parseBlogFileName('Notes 2025-01-01-2025-01-02-00-00-00')).toMatchObject({
      ok: true,
      title: 'Notes 2025-01-01',
      date: '2025-01-02',
    });
    expect(parseBlogFileName('Two  Spaces-2025-01-03-00-00-00')).toMatchObject({
      ok: true,
      title: 'Two  Spaces',
    });
    expect(parseBlogFileName('A--2025-01-04-00-00-00')).toMatchObject({ ok: true, title: 'A-' });
  });

  it('accepts an exactly 232-byte sanitised title and rejects 233 bytes', () => {
    const exact = 'é'.repeat(116);
    expect(new TextEncoder().encode(exact).length).toBe(232);
    expect(parseBlogFileName(`${exact}-2025-01-01-00-00-00`)).toMatchObject({ ok: true, title: exact });
    const tooLong = 'é'.repeat(116) + 'a';
    expect(new TextEncoder().encode(tooLong).length).toBe(233);
    expect(parseBlogFileName(`${tooLong}-2025-01-01-00-00-00`)).toMatchObject({
      ok: false,
      reason: 'title-too-long',
    });
  });
});

describe('sanitizeBlogTitleForFileName (D14)', () => {
  it('applies NFC, trim and the New! illegal-character replacement', () => {
    expect(sanitizeBlogTitleForFileName('  C*  ')).toBe('C-');
    expect(sanitizeBlogTitleForFileName('<angle>')).toBe('-angle-');
    expect(sanitizeBlogTitleForFileName('A/B\\C')).toBe('A-B-C');
    expect(sanitizeBlogTitleForFileName('Use `code`')).toBe('Use `code`');
    expect(sanitizeBlogTitleForFileName('~tilde~')).toBe('~tilde~');
    expect(sanitizeBlogTitleForFileName('Two  Spaces')).toBe('Two  Spaces');
    expect(sanitizeBlogTitleForFileName('Café'.normalize('NFD'))).toBe('Café');
  });
});
