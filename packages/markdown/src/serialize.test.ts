import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  BODY_MAX_BYTES,
  SAFE_TITLE_MAX_BYTES,
  buildPostFileName,
  buildPostPath,
  countCodePoints,
  getShanghaiTimestamp,
  planPublish,
  sanitizeTitleForFileName,
  serializePost,
  utf8ByteLength,
} from './index.ts';

function frontMatterOf(markdown: string): { source: string; parsed: unknown } {
  const match = /^---\n([\s\S]*?)\n---\n\n/.exec(markdown);
  if (!match || match[1] === undefined) {
    throw new Error(`no front matter in ${JSON.stringify(markdown.slice(0, 80))}`);
  }
  return { source: match[1], parsed: parseYaml(match[1]) };
}

function errorCodes(result: ReturnType<typeof serializePost>): string[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

const BODY = 'Body Markdown stays exactly as the author wrote it.';

describe('serializePost', () => {
  it('produces the exact visible Markdown and a title/date-only front matter', () => {
    const result = serializePost({ title: 'Example Post', body: BODY, date: '2026-11-23' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.post.markdown).toBe(
      '---\ntitle: Example Post\ndate: 2026-11-23\n---\n\n' +
        '# Example Post\n\n2026-11-23\n\n---\n\n' +
        `${BODY}\n`,
    );
    expect(result.post.visibleMarkdown).toBe(`# Example Post\n\n2026-11-23\n\n---\n\n${BODY}\n`);

    const frontMatter = frontMatterOf(result.post.markdown);
    expect(Object.keys(frontMatter.parsed as object).sort()).toEqual(['date', 'title']);
    expect((frontMatter.parsed as { title: unknown }).title).toBe('Example Post');
    expect((frontMatter.parsed as { date: unknown }).date).toBe('2026-11-23');
  });

  it('trims only the title and keeps the full original title in the H1', () => {
    const result = serializePost({ title: '  Spaced Title  ', body: 'Body', date: '2026-11-23' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.post.title).toBe('Spaced Title');
    expect(result.post.visibleMarkdown.startsWith('# Spaced Title\n')).toBe(true);
  });

  describe('YAML safety', () => {
    const titles = [
      'A "B" * <C>',
      'Quote "double" and \'single\'',
      'Star * and ** and ~tilde~',
      '<angle> and brackets',
      'Backtick `code` and [link](x)',
      '- dash start',
      '| pipe',
      '% percent',
      '中文标题：冒号',
      '中文标题：冒号与问号？',
      'yes',
      'null',
      '123',
    ];

    it.each(titles)('keeps %j in a single H1 and only two front matter fields', (title) => {
      const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const frontMatter = frontMatterOf(result.post.markdown);
      expect(Object.keys(frontMatter.parsed as object).sort()).toEqual(['date', 'title']);
      expect((frontMatter.parsed as { title: unknown }).title).toBe(title);
      expect(result.post.visibleMarkdown.startsWith(`# ${title}\n\n2026-11-23\n\n---\n\n`)).toBe(true);
    });

    it('cannot inject extra front matter fields through a title', () => {
      const attempts = [
        'Title\nsecret: value',
        'Title\ndate: 1999-01-01',
        'Title\r\nsecret: value',
        'Title\u2028secret: value',
      ];
      for (const title of attempts) {
        const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
        expect(result.ok, title).toBe(false);
        expect(errorCodes(result)).toContain('title_single_line');
      }
    });
  });

  describe('title limits', () => {
    it('counts Unicode code points, not UTF-16 code units', () => {
      expect(countCodePoints('😀'.repeat(30))).toBe(30);
      expect(countCodePoints('a'.repeat(60))).toBe(60);
    });

    it('accepts 60 code points and rejects 61', () => {
      const ok = serializePost({ title: 'a'.repeat(60), body: 'Body', date: '2026-11-23' });
      expect(ok.ok).toBe(true);

      const tooLong = serializePost({ title: 'a'.repeat(61), body: 'Body', date: '2026-11-23' });
      expect(tooLong.ok).toBe(false);
      expect(errorCodes(tooLong)).toContain('title_too_long');
    });

    it('accepts a safe title of exactly 232 UTF-8 bytes and rejects 236', () => {
      const fiftyEightEmoji = '😀'.repeat(58);
      expect(utf8ByteLength(fiftyEightEmoji)).toBe(SAFE_TITLE_MAX_BYTES);
      const ok = serializePost({ title: fiftyEightEmoji, body: 'Body', date: '2026-11-23' });
      expect(ok.ok).toBe(true);

      const fiftyNineEmoji = '😀'.repeat(59);
      expect(utf8ByteLength(fiftyNineEmoji)).toBe(SAFE_TITLE_MAX_BYTES + 4);
      const tooLong = serializePost({ title: fiftyNineEmoji, body: 'Body', date: '2026-11-23' });
      expect(tooLong.ok).toBe(false);
      expect(errorCodes(tooLong)).toContain('title_filename_too_long');
    });

    it('measures bytes after replacement-only characters are replaced', () => {
      // 58 emoji + the Windows-illegal quote (1 byte) becomes 58 emoji + "-".
      const title = `${'😀'.repeat(58)}"`;
      expect(utf8ByteLength(sanitizeTitleForFileName(title))).toBe(SAFE_TITLE_MAX_BYTES + 1);
      const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
      expect(result.ok).toBe(false);
      expect(errorCodes(result)).toContain('title_filename_too_long');
    });

    it('rejects empty and whitespace-only titles', () => {
      for (const title of ['', '   ', '\n\t']) {
        const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
        expect(result.ok, JSON.stringify(title)).toBe(false);
        expect(errorCodes(result)).toContain('title_required');
      }
    });

    it('rejects titles ending in whitespace plus hashes (unstable public H1)', () => {
      for (const title of ['C #', 'C ##']) {
        const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
        expect(result.ok, title).toBe(false);
        expect(errorCodes(result)).toContain('title_unstable_heading');
      }
    });

    it('rejects raw line breaks and controls before trim can hide them', () => {
      for (const title of [
        'Title\n',
        'Title\n\n',
        '\nTitle',
        'Title\r',
        'Title\u2028',
        'Title\u2029',
        'Title\t',
        'Title\u0000',
      ]) {
        const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
        expect(result.ok, JSON.stringify(title)).toBe(false);
        expect(errorCodes(result), JSON.stringify(title)).toContain('title_single_line');
      }
    });

    it('rejects reserved route characters instead of replacing them', () => {
      for (const character of ['#', '$', '&', '+', ',', ':', ';', '=', '?', '@']) {
        const title = `a${character}b`;
        const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
        expect(result.ok, character).toBe(false);
        expect(errorCodes(result)).toContain('title_reserved_character');
      }
    });

    it('rejects colon and question mark explicitly (D22)', () => {
      for (const title of ['Notes: part 1', 'Why?']) {
        const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
        expect(result.ok, title).toBe(false);
        const reserved = result.ok ? undefined : result.errors.find((error) => error.code === 'title_reserved_character');
        expect(reserved?.field).toBe('title');
        expect(reserved?.message).toContain(title.includes(':') ? ':' : '?');
      }
    });

    it('replaces Windows-illegal characters in the file name but not the H1', () => {
      const title = 'A "B" * <C> | D E/F\\G';
      const result = serializePost({ title, body: 'Body', date: '2026-11-23' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.post.title).toBe(title);
      expect(result.post.safeTitle).toBe('A -B- - -C- - D E-F-G');
    });
  });

  describe('body preservation', () => {
    it('normalises CRLF and lone CR to LF', () => {
      const result = serializePost({
        title: 'Title',
        body: 'line1\r\nline2\rline3',
        date: '2026-11-23',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.post.body).toBe('line1\nline2\nline3\n');
    });

    it('adds only the missing final newline', () => {
      const missing = serializePost({ title: 'Title', body: 'abc', date: '2026-11-23' });
      const present = serializePost({ title: 'Title', body: 'abc\n', date: '2026-11-23' });
      const extra = serializePost({ title: 'Title', body: 'abc\n\n\n', date: '2026-11-23' });
      expect(missing.ok && missing.post.body).toBe('abc\n');
      expect(present.ok && present.post.body).toBe('abc\n');
      expect(extra.ok && extra.post.body).toBe('abc\n\n\n');
    });

    it('preserves leading and trailing blank lines exactly', () => {
      const body = '\n\n  leading blank lines\n\nmiddle\n\n\n';
      const result = serializePost({ title: 'Title', body, date: '2026-11-23' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.post.body).toBe(body);
      expect(result.post.visibleMarkdown.endsWith(body)).toBe(true);
    });

    it('preserves list and fenced-code Markdown character for character', () => {
      const body = [
        '# is not escaped inside the body',
        '',
        '- one',
        '- two',
        '',
        '```ts',
        'const value = "<tag> & `tick`";',
        '```',
        '',
        'After code.',
      ].join('\n');
      const result = serializePost({ title: 'Title', body, date: '2026-11-23' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.post.body).toBe(`${body}\n`);
      expect(result.post.visibleMarkdown.endsWith(`${body}\n`)).toBe(true);
    });

    it('rejects empty/whitespace-only bodies', () => {
      for (const body of ['', '   ', '\r\n\t']) {
        const result = serializePost({ title: 'Title', body, date: '2026-11-23' });
        expect(result.ok, JSON.stringify(body)).toBe(false);
        expect(errorCodes(result)).toContain('body_required');
      }
    });

    it('accepts exactly 256 KiB and rejects one byte more', () => {
      // The limit applies to the author's normalised body, before the
      // serializer adds the required final newline.
      const exact = 'a'.repeat(BODY_MAX_BYTES);
      const ok = serializePost({ title: 'Title', body: exact, date: '2026-11-23' });
      expect(ok.ok).toBe(true);

      const tooLarge = serializePost({
        title: 'Title',
        body: 'a'.repeat(BODY_MAX_BYTES + 1),
        date: '2026-11-23',
      });
      expect(tooLarge.ok).toBe(false);
      expect(errorCodes(tooLarge)).toContain('body_too_large');
    });

    it('rejects invalid dates and accepts leap days', () => {
      for (const date of ['', '2026-2-3', '2026-02-30', 'not-a-date']) {
        const result = serializePost({ title: 'Title', body: 'Body', date });
        expect(result.ok, date).toBe(false);
        expect(errorCodes(result)).toContain('date_invalid');
      }
      expect(serializePost({ title: 'Title', body: 'Body', date: '2028-02-29' }).ok).toBe(true);
    });

    it('returns every applicable error at once', () => {
      const result = serializePost({ title: '', body: '', date: 'nope' });
      expect(result.ok).toBe(false);
      expect(errorCodes(result)).toEqual(
        expect.arrayContaining(['title_required', 'body_required', 'date_invalid']),
      );
    });
  });
});

describe('Asia/Shanghai formatting and file names', () => {
  it('formats 2026-11-23T15:42:15Z as 2026-11-23 23-42-15', () => {
    expect(getShanghaiTimestamp(new Date('2026-11-23T15:42:15Z'))).toEqual({
      date: '2026-11-23',
      time: '23-42-15',
      timestamp: '2026-11-23-23-42-15',
    });
  });

  it('rolls the calendar day at 16:00Z (midnight in Shanghai)', () => {
    expect(getShanghaiTimestamp(new Date('2026-11-23T15:59:59Z')).date).toBe('2026-11-23');
    expect(getShanghaiTimestamp(new Date('2026-11-23T16:00:00Z'))).toEqual({
      date: '2026-11-24',
      time: '00-00-00',
      timestamp: '2026-11-24-00-00-00',
    });
  });

  it('builds <safe title>-YYYY-MM-DD-HH-mm-ss.md and the year path', () => {
    const instant = new Date('2026-11-23T15:42:15Z');
    const timestamp = getShanghaiTimestamp(instant);
    expect(buildPostFileName('终于写好了这个页面', timestamp)).toBe(
      '终于写好了这个页面-2026-11-23-23-42-15.md',
    );
    expect(buildPostPath('Example Post', timestamp)).toBe(
      'content/blog/2026/Example Post-2026-11-23-23-42-15.md',
    );
  });

  it('keeps CJK and NFC-normalises the file name title', () => {
    expect(sanitizeTitleForFileName('Cafe\u0301 Notes')).toBe('Café Notes');
    expect(sanitizeTitleForFileName('中文 标题')).toBe('中文 标题');
    expect(sanitizeTitleForFileName('a/b\\c:d"e|f?g*h<i>')).toBe('a-b-c-d-e-f-g-h-i-');
  });

  it('planPublish derives date, timestamp and path from one instant', () => {
    const result = planPublish(
      { title: 'Example Post', body: 'Hello' },
      new Date('2026-11-23T15:42:15Z'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.path).toBe('content/blog/2026/Example Post-2026-11-23-23-42-15.md');
    expect(result.plan.post.visibleMarkdown).toBe(
      '# Example Post\n\n2026-11-23\n\n---\n\nHello\n',
    );
  });
});
