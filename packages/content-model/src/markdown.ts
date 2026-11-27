import { parse as parseYaml } from 'yaml';

export interface ParsedFrontMatter {
  data: Record<string, unknown>;
  body: string;
  /** 1-based line number of the first line after the front matter. */
  bodyStartLine: number;
  hasFrontMatter: boolean;
}

export interface MarkdownHeading {
  level: number;
  /** Literal heading text with closing hashes removed (the D12 title source). */
  text: string;
  /** Markdown-stripped text retained for diagnostics/tests; not the D12 title. */
  plainText: string;
  lineIndex: number;
  lineNumber: number;
}

export function normalizeNewlines(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

export function parseFrontMatter(raw: string): ParsedFrontMatter {
  const text = normalizeNewlines(raw);
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: text, bodyStartLine: 1, hasFrontMatter: false };
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingIndex === -1) {
    throw new Error('front matter starts with "---" but has no closing "---"');
  }
  const yamlSource = lines.slice(1, closingIndex).join('\n');
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlSource);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid YAML front matter: ${message}`);
  }
  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('front matter must be a YAML mapping');
  }
  return {
    data: parsed as Record<string, unknown>,
    body: lines.slice(closingIndex + 1).join('\n'),
    bodyStartLine: closingIndex + 2,
    hasFrontMatter: true,
  };
}

function stripClosingHashes(text: string): string {
  return text.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

/**
 * Strip inline Markdown syntax for diagnostics and legacy tests. Page titles
 * under D12 use the literal heading text (`MarkdownHeading.text`), not this
 * stripped form. Only paired, syntactically valid inline delimiters are
 * removed; literal `*`, `~`, backticks and `<...>` stay untouched.
 */
export function stripInlineMarkdown(text: string): string {
  const stored: string[] = [];
  const stash = (value: string): string => {
    stored.push(value);
    return `\uE000${stored.length - 1}\uE001`;
  };

  let value = text;
  // Code spans: an opening backtick run is closed by a run of the same length.
  // The lookarounds keep a shorter match from slicing a longer run in half.
  value = value.replace(/(?<!`)(`+)([^`]+?)\1(?!`)/g, (_match, _ticks: string, content: string) => stash(content));
  // Backslash escapes stay literal and must not be treated as delimiters.
  value = value.replace(/\\([\\`*_{}[\]()#+\-.!~>])/g, (_match, escaped: string) => stash(escaped));
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  value = value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  value = value.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1');
  value = value.replace(/(^|[\s(])__(?=\S)(.+?)(?<=\S)__(?=$|[\s).,;:!?])/g, '$1$2');
  value = value.replace(/(?<!\*)\*(?!\*)(?=\S)(.+?)(?<=\S)(?<!\*)\*(?!\*)/g, '$1');
  value = value.replace(/(^|[\s(])_(?=\S)(.+?)(?<=\S)_(?=$|[\s).,;:!?])/g, '$1$2');
  value = value.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1');
  value = value.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => stored[Number(index)] ?? '');
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeTitleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Compare a front matter title with the literal H1 text. Under the D12
 * decision, page headings are rendered from the model title as escaped plain
 * text, so inline Markdown is not interpreted and internal spacing/`~`/`<` is
 * preserved. Only surrounding whitespace and Unicode composition are normalised.
 */
export function normalizeLiteralTitle(text: string): string {
  return text.normalize('NFC').trim();
}

export interface MarkdownSafetyFinding {
  code: 'script' | 'event-handler' | 'javascript-link';
  message: string;
}

/**
 * Best-effort audit for raw HTML and script-bearing links in content Markdown.
 * Content is trusted in task 01, so these are warnings (reported by the CLI and
 * the Astro build logger), not a sanitizer. Tasks 06/07 must sanitize or reject
 * untrusted content before it can be published.
 */
export function auditMarkdownSafety(markdown: string): MarkdownSafetyFinding[] {
  const findings: MarkdownSafetyFinding[] = [];
  if (/<script\b/i.test(markdown)) {
    findings.push({ code: 'script', message: 'raw <script> tag is not sanitised; content is trusted by the build' });
  }
  if (/\son[a-z]+\s*=/i.test(markdown)) {
    findings.push({
      code: 'event-handler',
      message: 'inline event handler attribute is not sanitised; content is trusted by the build',
    });
  }
  if (/\]\(\s*javascript:/i.test(markdown) || /href\s*=\s*["']?\s*javascript:/i.test(markdown)) {
    findings.push({
      code: 'javascript-link',
      message: 'javascript: link is not sanitised; content is trusted by the build',
    });
  }
  return findings;
}

export function extractHeadings(markdown: string, firstLineNumber = 1): MarkdownHeading[] {
  const lines = normalizeNewlines(markdown).split('\n');
  const headings: MarkdownHeading[] = [];
  let openFence: { marker: '`' | '~'; length: number } | null = null;

  lines.forEach((line, index) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (openFence) {
      if (
        fenceMatch &&
        fenceMatch[1] !== undefined &&
        fenceMatch[1][0] === openFence.marker &&
        fenceMatch[1].length >= openFence.length &&
        (fenceMatch[2] ?? '').trim() === ''
      ) {
        openFence = null;
      }
      return;
    }
    if (fenceMatch && fenceMatch[1] !== undefined) {
      openFence = { marker: fenceMatch[1][0] as '`' | '~', length: fenceMatch[1].length };
      return;
    }
    const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
    if (!headingMatch || headingMatch[1] === undefined) {
      return;
    }
    const text = stripClosingHashes(headingMatch[2] ?? '');
    headings.push({
      level: headingMatch[1].length,
      text,
      plainText: stripInlineMarkdown(text),
      lineIndex: index,
      lineNumber: firstLineNumber + index,
    });
  });

  return headings;
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export interface BlogMarkdownData {
  frontMatter: Record<string, unknown>;
  title: string;
  date: string;
  shortDate: string;
  year: string;
  month: string;
  /** Markdown after the visible date separator. */
  body: string;
  /** Full visible Markdown from the H1 through the body, without front matter. */
  visibleMarkdown: string;
  headings: MarkdownHeading[];
}

const BLOG_FRONT_MATTER_KEYS = new Set(['title', 'date']);

export function parseBlogMarkdown(raw: string): BlogMarkdownData {
  const { data, body, bodyStartLine } = parseFrontMatter(raw);
  const headings = extractHeadings(body, bodyStartLine);
  const h1s = headings.filter((heading) => heading.level === 1);

  if (h1s.length === 0) {
    throw new Error('missing H1 heading');
  }
  if (h1s.length > 1) {
    const lines = h1s.map((heading) => heading.lineNumber).join(', ');
    throw new Error(`expected exactly one H1 heading, found ${h1s.length} (lines ${lines})`);
  }
  const h1 = h1s[0];
  if (h1 === undefined) {
    throw new Error('missing H1 heading');
  }
  if (h1.text === '') {
    throw new Error('H1 heading must not be empty');
  }

  const lines = normalizeNewlines(body).split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  if (firstContentIndex !== h1.lineIndex) {
    throw new Error('the H1 heading must be the first visible content in the post');
  }

  let cursor = h1.lineIndex + 1;
  while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') {
    cursor += 1;
  }
  const dateLine = (lines[cursor] ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateLine)) {
    throw new Error(`visible date must be YYYY-MM-DD immediately after the H1 (line ${bodyStartLine + cursor})`);
  }
  if (!isValidIsoDate(dateLine)) {
    throw new Error(`visible date is not a real calendar date: ${dateLine}`);
  }
  cursor += 1;
  while (cursor < lines.length && (lines[cursor] ?? '').trim() === '') {
    cursor += 1;
  }
  if ((lines[cursor] ?? '').trim() !== '---') {
    throw new Error(`visible date must be followed by a "---" separator (line ${bodyStartLine + cursor})`);
  }
  const visibleDate = dateLine;

  for (const key of Object.keys(data)) {
    if (!BLOG_FRONT_MATTER_KEYS.has(key)) {
      throw new Error(`unsupported front matter field "${key}"; only "title" and "date" are allowed`);
    }
  }

  const frontMatterTitle = data.title;
  if (frontMatterTitle !== undefined) {
    if (typeof frontMatterTitle !== 'string') {
      throw new Error('front matter "title" must be a string');
    }
    // D12: page H1s are rendered from this model title as escaped plain text,
    // so the front matter title must match the literal H1 (not a Markdown-stripped
    // version). Double spaces, backticks, `~` and `<...>` stay significant.
    if (normalizeLiteralTitle(frontMatterTitle) !== normalizeLiteralTitle(h1.text)) {
      throw new Error(
        `front matter title "${frontMatterTitle}" does not match H1 "${h1.text}"`,
      );
    }
  }

  const frontMatterDate = data.date;
  if (frontMatterDate !== undefined) {
    if (typeof frontMatterDate !== 'string') {
      throw new Error('front matter "date" must be a YYYY-MM-DD string');
    }
    if (frontMatterDate !== visibleDate) {
      throw new Error(`front matter date "${frontMatterDate}" does not match visible date "${visibleDate}"`);
    }
  }

  const postBody = lines.slice(cursor + 1).join('\n').replace(/^\n+/, '');
  if (postBody.trim() === '') {
    throw new Error('post body is empty');
  }

  const [year, month] = visibleDate.split('-');
  return {
    frontMatter: data,
    title: h1.text,
    date: visibleDate,
    shortDate: `${month ?? ''}.${(visibleDate.split('-')[2] ?? '')}`,
    year: year ?? '',
    month: month ?? '',
    body: postBody,
    visibleMarkdown: lines.slice(h1.lineIndex).join('\n'),
    headings,
  };
}

export interface ResumeMarkdownSection {
  title: string;
  markdown: string;
  lineNumber: number;
}

export function parseResumeMarkdown(raw: string): {
  frontMatter: Record<string, unknown>;
  hasFrontMatter: boolean;
  sections: ResumeMarkdownSection[];
  headings: MarkdownHeading[];
} {
  const { data, body, bodyStartLine, hasFrontMatter } = parseFrontMatter(raw);
  const headings = extractHeadings(body, bodyStartLine);
  const h1s = headings.filter((heading) => heading.level === 1);
  if (h1s.length === 0) {
    throw new Error('resume must contain at least one H1 section heading');
  }
  const lines = normalizeNewlines(body).split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');
  const firstH1 = h1s[0];
  if (firstH1 !== undefined && firstContentIndex !== firstH1.lineIndex) {
    throw new Error('resume content before the first H1 is not supported; start with an H1 section');
  }

  const sections: ResumeMarkdownSection[] = [];
  h1s.forEach((heading, index) => {
    if (heading.text === '') {
      throw new Error(`resume H1 at line ${heading.lineNumber} must not be empty`);
    }
    const next = h1s[index + 1];
    const endIndex = next ? next.lineIndex : lines.length;
    const sectionMarkdown = lines
      .slice(heading.lineIndex + 1, endIndex)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
    sections.push({
      title: heading.text,
      markdown: sectionMarkdown,
      lineNumber: heading.lineNumber,
    });
  });

  return { frontMatter: data, hasFrontMatter, sections, headings };
}
