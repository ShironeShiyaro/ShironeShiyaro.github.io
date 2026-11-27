import { describe, expect, it } from 'vitest';
import {
  parseBlogFileName,
  parseBlogMarkdown,
  sanitizeBlogTitleForFileName,
} from '@selfpage/content-model';
import { buildPostPath, getShanghaiTimestamp, sanitizeTitleForFileName, serializePost } from './index.ts';

/**
 * The content model is the public site's parser. A New! file must parse with
 * it unchanged: same front matter fields, literal H1/title match, visible date
 * match and a valid timestamped file name. These tests keep the generator and
 * the consumer from drifting apart.
 */
describe('generated posts parse with @selfpage/content-model', () => {
  it('round-trips the exact E05 post', () => {
    const result = serializePost({
      title: 'Example Post',
      body: 'Body Markdown stays exactly as the author wrote it.',
      date: '2026-11-23',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseBlogMarkdown(result.post.markdown);
    expect(parsed.title).toBe('Example Post');
    expect(parsed.date).toBe('2026-11-23');
    expect(parsed.frontMatter).toEqual({ title: 'Example Post', date: '2026-11-23' });
    expect(parsed.visibleMarkdown).toBe(result.post.visibleMarkdown);
    expect(parsed.body.trim()).toBe('Body Markdown stays exactly as the author wrote it.');
  });

  it.each([
    'A "B" * <C>',
    'Quotes "And" *Stars* <Tags> | Pipes',
    "Quote 'single' and \"double\"",
    'Star * star ** star',
    '中文标题：冒号与问号？',
    'Tilde ~ and backtick `code`',
    'yes',
    'null',
    '123',
  ])('parses a post titled %j with only title/date front matter', (title) => {
    const result = serializePost({ title, body: 'Hello\n\n- item', date: '2026-11-23' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseBlogMarkdown(result.post.markdown);
    expect(parsed.title).toBe(title);
    expect(Object.keys(parsed.frontMatter).sort()).toEqual(['date', 'title']);
    expect(parsed.frontMatter.title).toBe(title);
    expect(parsed.date).toBe('2026-11-23');
  });

  it('generates a file name the content model accepts', () => {
    const timestamp = getShanghaiTimestamp(new Date('2026-11-23T15:42:15Z'));
    const path = buildPostPath('终于写好了这个页面', timestamp);
    expect(path).toBe('content/blog/2026/终于写好了这个页面-2026-11-23-23-42-15.md');

    const fileName = path.split('/').at(-1) ?? '';
    const parsed = parseBlogFileName(fileName.replace(/\.md$/, ''));
    expect(parsed).toEqual({
      ok: true,
      title: '终于写好了这个页面',
      date: '2026-11-23',
      time: '23-42-15',
    });
  });

  it('uses the same file-name sanitisation as the content model', () => {
    for (const title of ['Plain title', 'A "B" * <C> | D', 'Café Notes', '中文 标题']) {
      expect(sanitizeTitleForFileName(title)).toBe(sanitizeBlogTitleForFileName(title));
    }
  });

  it('keeps a list/code-block body parseable even with leading blank lines', () => {
    const result = serializePost({
      title: 'Complex body',
      body: '\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n',
      date: '2026-11-23',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = parseBlogMarkdown(result.post.markdown);
    expect(parsed.title).toBe('Complex body');
    expect(parsed.body).toContain('- one');
    expect(parsed.body).toContain('```ts');
  });
});
