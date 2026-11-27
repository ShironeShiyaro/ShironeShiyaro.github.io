/**
 * Independent test suite for the New! Markdown serializer (task 06).
 *
 * Written by the independent test sub-agent from the frozen criteria E04–E07
 * and the public contract, not from the executor's tests. It deliberately uses
 * table-driven expectations and asserts exact byte sequences where the
 * criteria require "verbatim".
 *
 * D22 note: after the fix round the serializer rejects all ten route-reserved
 * characters (`# $ & + , : ; = ? @`) before publish and only silently replaces
 * `< > " | *` in the file-name form. The 15-case D22 probe
 * (`tests/independent/d22-probe.mjs`) is the focused regression check for that
 * rule; this file asserts the same set through `serializePost`/`validateTitle`.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  BODY_MAX_BYTES,
  SAFE_TITLE_MAX_BYTES,
  buildPostFileName,
  countCodePoints,
  getShanghaiTimestamp,
  normalizeBody,
  planPublish,
  sanitizeTitleForFileName,
  serializePost,
  utf8ByteLength,
  validateTitle,
} from './index.ts';
import type { MarkdownError } from './errors.ts';

const DATE = '2026-11-23';

function errorCodes(errors: MarkdownError[]): string[] {
  return errors.map((error) => error.code);
}

function expectOk(result: ReturnType<typeof serializePost>) {
  if (!result.ok) {
    throw new Error(`expected success, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.post;
}

function frontMatterAndVisible(markdown: string): { yaml: string; visible: string } {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(markdown);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`unexpected markdown shape: ${JSON.stringify(markdown.slice(0, 120))}`);
  }
  return { yaml: match[1], visible: match[2] };
}

describe('[independent] E05 exact fixed-date render', () => {
  it('produces the exact front matter and visible body the acceptance asks to capture', () => {
    const post = expectOk(
      serializePost({
        title: 'Example Post',
        body: 'Body Markdown stays exactly as the author wrote it.',
        date: DATE,
      }),
    );

    expect(post.markdown).toBe(
      '---\ntitle: Example Post\ndate: 2026-11-23\n---\n\n' +
        '# Example Post\n\n2026-11-23\n\n---\n\n' +
        'Body Markdown stays exactly as the author wrote it.\n',
    );
    expect(post.frontMatter).toBe('title: Example Post\ndate: 2026-11-23\n');
    expect(post.visibleMarkdown).toBe(
      '# Example Post\n\n2026-11-23\n\n---\n\nBody Markdown stays exactly as the author wrote it.\n',
    );
    expect(Object.keys(parseYaml(post.frontMatter) as object).sort()).toEqual(['date', 'title']);
    expect(post.markdown.startsWith(post.frontMatter)).toBe(false);
  });

  it('uses the Asia/Shanghai date of 2026-11-23T15:42:15Z and the file timestamp 23-42-15', () => {
    const timestamp = getShanghaiTimestamp(Date.parse('2026-11-23T15:42:15Z'));
    expect(timestamp).toEqual({
      date: '2026-11-23',
      time: '23-42-15',
      timestamp: '2026-11-23-23-42-15',
    });
    const plan = planPublish(
      { title: 'Example Post', body: 'Fixed clock body' },
      Date.parse('2026-11-23T15:42:15Z'),
    );
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.plan.post.date).toBe('2026-11-23');
      expect(plan.plan.fileName).toBe('Example Post-2026-11-23-23-42-15.md');
      expect(plan.plan.path).toBe('content/blog/2026/Example Post-2026-11-23-23-42-15.md');
      expect(plan.plan.post.visibleMarkdown.startsWith('# Example Post\n\n2026-11-23\n\n---\n\n')).toBe(
        true,
      );
    }
  });

  it('rolls the visible date and file name at Shanghai midnight (16:00Z)', () => {
    const before = getShanghaiTimestamp(Date.parse('2026-11-23T15:59:59Z'));
    const at = getShanghaiTimestamp(Date.parse('2026-11-23T16:00:00Z'));
    expect(before.date).toBe('2026-11-23');
    expect(before.time).toBe('23-59-59');
    expect(at.date).toBe('2026-11-24');
    expect(at.time).toBe('00-00-00');
  });
});

describe('[independent] E04 validation boundaries (no publish)', () => {
  const body = 'Plain body for the boundary checks.';

  it('rejects an empty/whitespace title and an empty body with English messages', () => {
    const empty = serializePost({ title: '', body: '', date: DATE });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(errorCodes(empty.errors).sort()).toEqual(['body_required', 'title_required']);
      for (const error of empty.errors) {
        expect(error.message).toMatch(/^[A-Z][\x20-\x7E]+$/); // ASCII English sentence
      }
    }

    const whitespace = serializePost({ title: '   \t  ', body: ' \n\t ', date: DATE });
    expect(whitespace.ok).toBe(false);
    if (!whitespace.ok) {
      expect(errorCodes(whitespace.errors).sort()).toEqual(['body_required', 'title_required']);
    }
  });

  it('accepts exactly 60 Unicode code points and rejects 61, counting astral characters once', () => {
    const sixtyAscii = 'a'.repeat(60);
    const sixtyOneAscii = 'a'.repeat(61);
    expect(countCodePoints(sixtyAscii)).toBe(60);
    expect(validateTitle(sixtyAscii).errors).toEqual([]);
    expect(expectOk(serializePost({ title: sixtyAscii, body, date: DATE })).title).toBe(sixtyAscii);

    // 60 astral code points are 240 UTF-8 bytes, so this title is rejected by
    // the independent 232-byte file-name rule; code-point counting itself still
    // must treat each surrogate pair as one code point.
    const sixtyAstral = '😀'.repeat(60);
    expect(countCodePoints(sixtyAstral)).toBe(60);
    expect(countCodePoints(sixtyAstral.slice(0, 2))).toBe(1);
    const sixtyOneAstral = '😀'.repeat(61);
    expect(countCodePoints(sixtyOneAstral)).toBe(61);
    const sixtyAstralResult = serializePost({ title: sixtyAstral, body, date: DATE });
    expect(sixtyAstralResult.ok).toBe(false);
    if (!sixtyAstralResult.ok) {
      expect(errorCodes(sixtyAstralResult.errors)).toEqual(['title_filename_too_long']);
    }

    const rejected = serializePost({ title: sixtyOneAscii, body, date: DATE });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(errorCodes(rejected.errors)).toContain('title_too_long');
    }
    const rejectedAstral = serializePost({ title: sixtyOneAstral, body, date: DATE });
    expect(rejectedAstral.ok).toBe(false);
    if (!rejectedAstral.ok) {
      expect(errorCodes(rejectedAstral.errors)).toContain('title_too_long');
      expect(errorCodes(rejectedAstral.errors)).toContain('title_filename_too_long');
    }
  });

  it(`accepts a safe title of exactly ${SAFE_TITLE_MAX_BYTES} UTF-8 bytes and rejects one code point more`, () => {
    // 58 four-byte emoji = 58 code points, 232 UTF-8 bytes: inside both limits.
    const exactly = '😀'.repeat(58);
    expect(utf8ByteLength(sanitizeTitleForFileName(exactly))).toBe(SAFE_TITLE_MAX_BYTES);
    expect(countCodePoints(exactly)).toBe(58);
    expect(validateTitle(exactly).errors).toEqual([]);

    // 59 emoji = 236 bytes but still only 59 code points: the byte limit alone rejects it.
    const tooManyBytes = '😀'.repeat(59);
    expect(countCodePoints(tooManyBytes)).toBe(59);
    expect(utf8ByteLength(sanitizeTitleForFileName(tooManyBytes))).toBe(236);
    const result = serializePost({ title: tooManyBytes, body, date: DATE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(errorCodes(result.errors)).toEqual(['title_filename_too_long']);
      expect(result.errors[0]?.message).toMatch(/232 UTF-8 bytes/);
    }

    // Replacing a four-byte character with a one-byte '-' can only shrink the
    // safe title; the H1 is unaffected.
    const replaced = `${'😀'.repeat(57)}<`;
    expect(countCodePoints(replaced)).toBe(58);
    expect(utf8ByteLength(sanitizeTitleForFileName(replaced))).toBe(229);
    expect(validateTitle(replaced).errors).toEqual([]);
  });

  it(`accepts exactly ${BODY_MAX_BYTES} UTF-8 bytes and rejects one byte more`, () => {
    const exactBody = 'a'.repeat(BODY_MAX_BYTES);
    expect(utf8ByteLength(exactBody)).toBe(BODY_MAX_BYTES);
    const accepted = serializePost({ title: 'Exact body', body: exactBody, date: DATE });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      // The serializer adds a final newline; the author limit excludes it.
      expect(accepted.post.body).toBe(`${exactBody}\n`);
    }

    const tooLarge = serializePost({
      title: 'Too large body',
      body: 'a'.repeat(BODY_MAX_BYTES + 1),
      date: DATE,
    });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(errorCodes(tooLarge.errors)).toEqual(['body_too_large']);
      expect(tooLarge.errors[0]?.field).toBe('body');
      expect(tooLarge.errors[0]?.message).toContain('256 KiB');
    }
  });

  it('counts the 256 KiB limit after CRLF normalisation, not before', () => {
    // 131_072 "a\r\n" pairs = 262_144 bytes raw, but 262_144 bytes after CRLF->LF
    // (each pair becomes "a\n"), so this body is exactly at the limit.
    const crlfAtLimit = 'a\r\n'.repeat(BODY_MAX_BYTES / 2);
    expect(utf8ByteLength(normalizeBody(crlfAtLimit))).toBe(BODY_MAX_BYTES);
    expect(serializePost({ title: 'CRLF limit', body: crlfAtLimit, date: DATE }).ok).toBe(true);

    const crlfOver = `${crlfAtLimit}x`;
    const overResult = serializePost({ title: 'CRLF over', body: crlfOver, date: DATE });
    expect(overResult.ok).toBe(false);
    if (!overResult.ok) {
      expect(errorCodes(overResult.errors)).toEqual(['body_too_large']);
    }
  });

  it('reports every applicable error at once instead of failing one at a time', () => {
    const result = serializePost({
      title: `${'😀'.repeat(62)}: "x"`,
      body: 'a'.repeat(BODY_MAX_BYTES + 1),
      date: '2026-02-30',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = errorCodes(result.errors);
      expect(codes).toContain('title_too_long');
      expect(codes).toContain('title_filename_too_long');
      expect(codes).toContain('body_too_large');
      expect(codes).toContain('date_invalid');
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
});

describe('[independent] E06 body is preserved verbatim', () => {
  it('preserves leading/trailing blanks, hashes, lists, code fences and trailing spaces', () => {
    const raw =
      '\r\n\r\n# a body H1 line stays literal\r\n\r\n- one\r\n- two\r\n\r\n' +
      '```ts\r\nconst value = "<tag> & `tick`";\r\n```\r\n\r\n' +
      'trailing spaces kept   \r\n\r\n\r\n';
    const normalized = raw.replace(/\r\n?/g, '\n');

    const post = expectOk(serializePost({ title: 'Preserved body', body: raw, date: DATE }));
    expect(post.body).toBe(normalized); // already ends with \n, nothing added
    const { visible } = frontMatterAndVisible(post.markdown);
    expect(visible).toBe(`# Preserved body\n\n${DATE}\n\n---\n\n${normalized}`);
    expect(visible.endsWith('trailing spaces kept   \n\n\n')).toBe(true);
    expect(visible).not.toContain('\r');
    expect(visible).toContain('`tick`');
    expect(visible).toContain('const value = "<tag> & `tick`";');
  });

  it('normalises lone CR and CRLF everywhere but never trims or escapes', () => {
    const raw = 'first\rsecond\r\nthird\n\n  indented\r\n';
    const post = expectOk(serializePost({ title: 'Newlines', body: raw, date: DATE }));
    expect(post.body).toBe('first\nsecond\nthird\n\n  indented\n');
    expect(post.visibleMarkdown.endsWith('\n\n  indented\n')).toBe(true);
  });

  it('adds exactly one final newline only when missing', () => {
    const cases: Array<[string, string]> = [
      ['no newline', 'no newline\n'],
      ['one newline\n', 'one newline\n'],
      ['two newlines\n\n', 'two newlines\n\n'],
      ['crlf\r\n', 'crlf\n'],
      ['cr\r', 'cr\n'],
      ['x\r\n\r\n', 'x\n\n'],
    ];
    for (const [raw, expected] of cases) {
      const post = expectOk(serializePost({ title: 'Ending', body: raw, date: DATE }));
      expect(post.body, JSON.stringify(raw)).toBe(expected);
    }
  });

  it('does not let body content change the front matter', () => {
    const body = '---\ntitle: injected\ndate: 2000-01-01\n---\n';
    const post = expectOk(serializePost({ title: 'Real title', body, date: DATE }));
    const { yaml, visible } = frontMatterAndVisible(post.markdown);
    expect(Object.keys(parseYaml(yaml) as object).sort()).toEqual(['date', 'title']);
    expect(visible).toContain(body);
  });
});

describe('[independent] E07 YAML-safe titles (publishable characters)', () => {
  // D22 requires `:` to be rejected, so the UI-level YAML cases only use the
  // still-publishable characters `"`, `*`, `<` (plus apostrophes and Unicode).
  const cases: Array<[string, string]> = [
    ['double quotes', 'A "B" post'],
    ['asterisks', '*Not emphasis* and **not bold**'],
    ['angle brackets', 'A <script> tag is text'],
    ['quotes + star + angle', 'A "B" * <C>'],
    ['apostrophe', "Author's post"],
    ['unicode + quotes', 'Ünïcode ☃ "snow"'],
  ];

  it.each(cases)('keeps %s as the literal H1 and adds no YAML fields', (_label, title) => {
    const post = expectOk(serializePost({ title, body: 'Body text.', date: DATE }));
    const { yaml, visible } = frontMatterAndVisible(post.markdown);

    const parsed = parseYaml(yaml) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['date', 'title']);
    expect(parsed.title).toBe(title);
    expect(parsed.date).toBe(DATE);
    expect(visible.startsWith(`# ${title}\n\n${DATE}\n\n---\n\n`)).toBe(true);
    // Only the two expected top-level YAML keys exist, even for a title with
    // quotes/asterisks/angle brackets that YAML could otherwise reinterpret.
    expect(yaml.match(/^[A-Za-z_][A-Za-z0-9_]*:/gm)?.length).toBe(2);
  });

  it('rejects a newline/control character in the title before publish', () => {
    for (const title of ['Injected\nsecret: yes', 'Tab\tinside', 'Carriage\rReturn']) {
      const result = serializePost({ title, body: 'Body.', date: DATE });
      expect(result.ok, JSON.stringify(title)).toBe(false);
      if (!result.ok) {
        expect(errorCodes(result.errors)).toContain('title_single_line');
      }
    }
  });

  it('rejects reserved route characters instead of silently replacing them (D22 set)', () => {
    for (const character of ['#', '$', '&', '+', ',', ':', ';', '?', '=', '@']) {
      const title = `Route ${character} character`;
      const result = serializePost({ title, body: 'Body.', date: DATE });
      expect(result.ok, `title with ${character} must be rejected`).toBe(false);
      if (!result.ok) {
        expect(errorCodes(result.errors)).toContain('title_reserved_character');
      }
    }
  });

  it('rejects D22 colon/question titles with the English reserved-character message and no post', () => {
    for (const title of ['C: A Subtitle', 'Why?', 'A: "B" * <C>']) {
      const result = serializePost({ title, body: 'Body.', date: DATE });
      expect(result.ok, title).toBe(false);
      if (!result.ok) {
        const reserved = result.errors.find((error) => error.code === 'title_reserved_character');
        expect(reserved, title).toBeDefined();
        expect(reserved?.field).toBe('title');
        expect(reserved?.message).toMatch(/^Title contains ".", which cannot be used/);
      }
    }
  });

  it('replaces only the file-name characters that D22 still allows (< > " | *) in the file name, never in the H1', () => {
    const title = 'Angle <x> Pipe | Star * Quote "Q"';
    const result = serializePost({ title, body: 'Body.', date: DATE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.post.safeTitle).toBe('Angle -x- Pipe - Star - Quote -Q-');
      expect(result.post.safeTitle).not.toMatch(/[<>"|*]/);
      expect(result.post.visibleMarkdown.startsWith(`# ${title}\n`)).toBe(true);
      expect(result.post.safeTitle).not.toBe(title);
    }
  });

  it('rejects a title ending in " #" because the public H1 would lose the hash', () => {
    const result = serializePost({ title: 'C #', body: 'Body.', date: DATE });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(errorCodes(result.errors)).toContain('title_unstable_heading');
    }
  });
});

describe('[independent] date, file name and plan helpers', () => {
  it('rejects impossible dates even when the pattern matches', () => {
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-1', '20260101', '']) {
      const result = serializePost({ title: 'Date check', body: 'Body.', date });
      expect(result.ok, date).toBe(false);
      if (!result.ok) {
        expect(errorCodes(result.errors)).toContain('date_invalid');
      }
    }
  });

  it('keeps CJK, accents and percent signs out of the replaced set and NFC-normalises', () => {
    const decomposed = 'Cafe\u0301 中文 100%';
    expect(sanitizeTitleForFileName(decomposed)).toBe('Café 中文 100%');
    const post = expectOk(serializePost({ title: decomposed, body: 'Body.', date: DATE }));
    expect(post.safeTitle).toBe('Café 中文 100%');
    expect(post.title).toBe(decomposed); // H1 keeps the exact author text
  });

  it('builds the documented path and never accepts a caller-chosen root', () => {
    const timestamp = getShanghaiTimestamp(Date.parse('2026-11-23T15:42:15Z'));
    expect(buildPostFileName('A <B>', timestamp)).toBe('A -B--2026-11-23-23-42-15.md');
    expect(buildPostFileName("It's fine", timestamp)).toBe("It's fine-2026-11-23-23-42-15.md");
    const plan = planPublish({ title: 'A <B>', body: 'Body.' }, Date.parse('2026-11-23T15:42:15Z'));
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.plan.path.startsWith('content/blog/2026/')).toBe(true);
      expect(plan.plan.path).not.toContain('..');
    }
  });
});
