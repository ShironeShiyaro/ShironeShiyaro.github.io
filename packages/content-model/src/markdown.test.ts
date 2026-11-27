import { describe, expect, it } from 'vitest';
import {
  auditMarkdownSafety,
  extractHeadings,
  isValidIsoDate,
  parseBlogMarkdown,
  parseFrontMatter,
  parseResumeMarkdown,
  stripInlineMarkdown,
} from './markdown.ts';

const VALID_POST = `---
title: "Hello *World*"
date: 2025-03-14
---
# Hello *World*

2025-03-14

---

First paragraph.

- One
- Two
`;

describe('parseFrontMatter', () => {
  it('returns the body unchanged when there is no front matter', () => {
    const parsed = parseFrontMatter('# Title\n\nBody\n');
    expect(parsed.hasFrontMatter).toBe(false);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('# Title\n\nBody\n');
    expect(parsed.bodyStartLine).toBe(1);
  });

  it('parses YAML front matter and records the body start line', () => {
    const parsed = parseFrontMatter('---\ntitle: Example\ndate: 2025-01-02\n---\n# H1\n');
    expect(parsed.hasFrontMatter).toBe(true);
    expect(parsed.data).toEqual({ title: 'Example', date: '2025-01-02' });
    expect(parsed.body).toBe('# H1\n');
    expect(parsed.bodyStartLine).toBe(5);
  });

  it('normalises CRLF and strips a BOM', () => {
    const parsed = parseFrontMatter('\uFEFF---\r\ntitle: Example\r\n---\r\n# H1\r\n');
    expect(parsed.data.title).toBe('Example');
    expect(parsed.body).toBe('# H1\n');
  });

  it('rejects malformed front matter', () => {
    expect(() => parseFrontMatter('---\ntitle: Example\n# H1\n')).toThrow(/no closing/);
    expect(() => parseFrontMatter('---\ntitle: [\n---\nBody\n')).toThrow(/invalid YAML/);
    expect(() => parseFrontMatter('---\n- one\n- two\n---\nBody\n')).toThrow(/YAML mapping/);
  });
});

describe('extractHeadings and inline text', () => {
  it('extracts ATX headings, removes closing hashes and ignores fenced code', () => {
    const markdown = `# One

\`\`\`md
# Not a heading
\`\`\`

## Two ##

#NoSpace is a paragraph

### Three ###
`;
    const headings = extractHeadings(markdown);
    expect(headings.map((heading) => [heading.level, heading.plainText])).toEqual([
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
    ]);
  });

  it('strips only paired inline Markdown delimiters for title comparison', () => {
    expect(stripInlineMarkdown('Hello *World* and [link](https://example.org)')).toBe('Hello World and link');
    expect(stripInlineMarkdown('Use `code` and **strong** text')).toBe('Use code and strong text');
    expect(stripInlineMarkdown('My_file and snake_case')).toBe('My_file and snake_case');
    expect(stripInlineMarkdown('My _very_ good notes')).toBe('My very good notes');
    expect(stripInlineMarkdown('~~gone~~ and **bold** and *em*')).toBe('gone and bold and em');
  });

  it('keeps literal punctuation that is not a valid paired delimiter (review P1-3)', () => {
    expect(stripInlineMarkdown('C*')).toBe('C*');
    expect(stripInlineMarkdown('~tilde~')).toBe('~tilde~');
    expect(stripInlineMarkdown('<angle>')).toBe('<angle>');
    expect(stripInlineMarkdown('a * b * c')).toBe('a * b * c');
    expect(stripInlineMarkdown('unpaired `tick')).toBe('unpaired `tick');
    expect(stripInlineMarkdown('C\\*')).toBe('C*');
    expect(stripInlineMarkdown('`*literal*`')).toBe('*literal*');
  });

  it('requires matching backtick runs for a code span', () => {
    expect(stripInlineMarkdown('Use `code`')).toBe('Use code');
    expect(stripInlineMarkdown('Use `a``')).toBe('Use `a``');
  });

  it('validates real calendar dates', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2023-02-29')).toBe(false);
    expect(isValidIsoDate('2025-13-01')).toBe(false);
    expect(isValidIsoDate('2025-2-1')).toBe(false);
  });
});

describe('parseBlogMarkdown', () => {
  it('extracts the visible literal title, date and body', () => {
    const post = parseBlogMarkdown(VALID_POST);
    expect(post.title).toBe('Hello *World*');
    expect(post.date).toBe('2025-03-14');
    expect(post.shortDate).toBe('03.14');
    expect(post.year).toBe('2025');
    expect(post.month).toBe('03');
    expect(post.body).toContain('First paragraph.');
    expect(post.visibleMarkdown.startsWith('# Hello *World*')).toBe(true);
    expect(post.visibleMarkdown).not.toContain('title: Hello World');
    expect(post.headings.filter((heading) => heading.level === 1)).toHaveLength(1);
  });

  it('accepts a post without front matter', () => {
    const post = parseBlogMarkdown(`# Bare Post\n\n2025-06-01\n\n---\n\nBody text.\n`);
    expect(post.title).toBe('Bare Post');
    expect(post.date).toBe('2025-06-01');
    expect(post.frontMatter).toEqual({});
  });

  it('rejects missing, multiple or non-leading H1 headings', () => {
    expect(() => parseBlogMarkdown('2025-01-01\n\n---\n\nBody\n')).toThrow(/missing H1/);
    expect(() =>
      parseBlogMarkdown('# One\n\n2025-01-01\n\n---\n\n# Two\n\nBody\n'),
    ).toThrow(/exactly one H1/);
    expect(() => parseBlogMarkdown('Intro\n\n# One\n\n2025-01-01\n\n---\n\nBody\n')).toThrow(
      /first visible content/,
    );
  });

  it('ignores an H1 inside a fenced code block', () => {
    const post = parseBlogMarkdown(
      '# Real Post\n\n2025-01-01\n\n---\n\n```md\n# Fake\n```\n',
    );
    expect(post.title).toBe('Real Post');
    expect(post.headings.filter((heading) => heading.level === 1)).toHaveLength(1);
  });

  it('rejects invalid or missing visible dates and separators', () => {
    expect(() =>
      parseBlogMarkdown('# Post\n\n2025-02-30\n\n---\n\nBody\n'),
    ).toThrow(/not a real calendar date/);
    expect(() => parseBlogMarkdown('# Post\n\nnot-a-date\n\n---\n\nBody\n')).toThrow(/must be YYYY-MM-DD/);
    expect(() => parseBlogMarkdown('# Post\n\n2025-01-01\n\nBody\n')).toThrow(/separator/);
    expect(() => parseBlogMarkdown('# Post\n\n2025-01-01\n\n---\n\n   \n')).toThrow(/body is empty/);
  });

  it('rejects front matter that disagrees with visible content', () => {
    expect(() =>
      parseBlogMarkdown('---\ntitle: Wrong\ndate: 2025-01-01\n---\n# Right\n\n2025-01-01\n\n---\n\nBody\n'),
    ).toThrow(/does not match H1/);
    expect(() =>
      parseBlogMarkdown('---\ntitle: Post\ndate: 2025-01-02\n---\n# Post\n\n2025-01-01\n\n---\n\nBody\n'),
    ).toThrow(/does not match visible date/);
  });

  it('preserves literal title text for escaped H1 rendering (D12)', () => {
    expect(parseBlogMarkdown('---\ntitle: C*\n---\n# C*\n\n2025-01-01\n\n---\n\nBody\n').title).toBe('C*');
    expect(
      parseBlogMarkdown('---\ntitle: "Use `code`"\n---\n# Use `code`\n\n2025-01-01\n\n---\n\nBody\n').title,
    ).toBe('Use `code`');
    expect(
      parseBlogMarkdown('---\ntitle: "~tilde~"\n---\n# ~tilde~\n\n2025-01-01\n\n---\n\nBody\n').title,
    ).toBe('~tilde~');
    expect(
      parseBlogMarkdown('---\ntitle: "<angle>"\n---\n# <angle>\n\n2025-01-01\n\n---\n\nBody\n').title,
    ).toBe('<angle>');
    expect(
      parseBlogMarkdown('---\ntitle: "Two  Spaces"\n---\n# Two  Spaces\n\n2025-01-01\n\n---\n\nBody\n').title,
    ).toBe('Two  Spaces');
    expect(
      parseBlogMarkdown('---\ntitle: "<script>"\n---\n# <script>\n\n2025-01-01\n\n---\n\nBody\n').title,
    ).toBe('<script>');
  });

  it('rejects a front matter title that only matches after Markdown stripping', () => {
    expect(() =>
      parseBlogMarkdown('---\ntitle: Use code\n---\n# Use `code`\n\n2025-01-01\n\n---\n\nBody\n'),
    ).toThrow(/does not match H1/);
  });

  it('still rejects a front matter title that differs from the visible H1', () => {
    expect(() =>
      parseBlogMarkdown('---\ntitle: C#\n---\n# C*\n\n2025-01-01\n\n---\n\nBody\n'),
    ).toThrow(/does not match H1/);
  });

  it('rejects unsupported front matter fields and non-string values', () => {
    expect(() =>
      parseBlogMarkdown('---\ntitle: Post\nslug: post\n---\n# Post\n\n2025-01-01\n\n---\n\nBody\n'),
    ).toThrow(/unsupported front matter field/);
    expect(() =>
      parseBlogMarkdown('---\ntitle: 12\ndate: 2025-01-01\n---\n# 12\n\n2025-01-01\n\n---\n\nBody\n'),
    ).toThrow(/must be a string/);
  });
});

describe('parseResumeMarkdown', () => {
  it('splits sections at every H1 and keeps body Markdown', () => {
    const resume = parseResumeMarkdown(`# About Me\n\nIntro.\n\n# Education\n\n- Example University\n`);
    expect(resume.sections.map((section) => section.title)).toEqual(['About Me', 'Education']);
    expect(resume.sections[0]?.markdown).toBe('Intro.');
    expect(resume.sections[1]?.markdown).toBe('- Example University');
    expect(resume.hasFrontMatter).toBe(false);
  });

  it('reports even an empty front matter block so the loader can reject it', () => {
    const resume = parseResumeMarkdown('---\n---\n# About Me\n\nOne.\n');
    expect(resume.hasFrontMatter).toBe(true);
    expect(resume.sections.map((section) => section.title)).toEqual(['About Me']);
  });

  it('allows duplicate H1 text and rejects content before the first H1', () => {
    const resume = parseResumeMarkdown('# About Me\n\nOne.\n\n# About Me\n\nTwo.\n');
    expect(resume.sections).toHaveLength(2);
    expect(() => parseResumeMarkdown('Intro\n\n# About Me\n\nOne.\n')).toThrow(/before the first H1/);
    expect(() => parseResumeMarkdown('## Only H2\n\nText\n')).toThrow(/at least one H1/);
  });

  it('does not treat setext headings as H1 (only ATX headings are supported)', () => {
    expect(() => parseResumeMarkdown('About Me\n========\n\nText\n')).toThrow(/at least one H1/);
  });
});

describe('auditMarkdownSafety', () => {
  it('reports raw scripts, event handlers and javascript: links without sanitising them', () => {
    const findings = auditMarkdownSafety(
      "<script>alert(1)</script>\n\n<img src=\"x\" onerror=\"alert(1)\">\n\n[bad](javascript:alert(1))\n",
    );
    expect(findings.map((finding) => finding.code)).toEqual(['script', 'event-handler', 'javascript-link']);
    expect(findings.every((finding) => finding.message.includes('not sanitised'))).toBe(true);
  });

  it('reports nothing for ordinary Markdown', () => {
    expect(auditMarkdownSafety('# Title\n\nA paragraph with `code` and [a link](https://example.org).\n')).toEqual([]);
  });
});
