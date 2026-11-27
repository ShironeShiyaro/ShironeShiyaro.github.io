/**
 * Pure content guards added by task 07 on top of the task 06 serializer.
 *
 * `packages/markdown` stays the single Markdown/YAML serializer; these helpers
 * only reject inputs that would make the published file invalid or would try to
 * smuggle a path through a title. They are pure so the browser can run the same
 * checks before sending a request.
 */

export interface LevelOneHeading {
  /** 1-based line number in the author's body. */
  line: number;
  /** Trimmed heading text (without leading `#`/trailing hashes). */
  text: string;
}

const ATX_H1 = /^ {0,3}#(?!#)(?:[ \t]+(.*?))?[ \t]*$/u;
const SETEXT_H1 = /^ {0,3}=+[ \t]*$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * Finds the first level-1 heading in the body outside fenced code blocks.
 *
 * ATX (`# Heading`) and Setext (`Heading` followed by `===`) both create an
 * H1 in Markdown. The serializer already emits the post's only H1 from the
 * title, so any additional H1 in the body is rejected before publishing.
 */
export function findLevelOneHeading(body: string): LevelOneHeading | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let fence: { character: string; length: number } | null = null;
  let previousText = '';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (fence !== null) {
      const closing = new RegExp(`^ {0,3}${fence.character === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`, 'u');
      if (closing.test(line)) {
        fence = null;
      }
      continue;
    }

    const fenceMatch = FENCE.exec(line);
    if (fenceMatch && fenceMatch[1] !== undefined) {
      const marker = fenceMatch[1];
      fence = { character: marker[0] ?? '`', length: marker.length };
      previousText = '';
      continue;
    }

    const atx = ATX_H1.exec(line);
    if (atx) {
      const text = (atx[1] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim();
      return { line: index + 1, text };
    }

    if (SETEXT_H1.test(line) && previousText !== '') {
      return { line: index + 1, text: previousText };
    }

    previousText = line.trim() === '' ? '' : line.trim();
  }

  return null;
}

const ENCODED_SEPARATOR = /%2f|%5c|%00|%2e%2e|%252f|%255c/iu;

/** Returns the first percent-encoded separator/path token, if any. */
export function findEncodedSeparator(value: string): string | null {
  const match = ENCODED_SEPARATOR.exec(value);
  return match?.[0] ?? null;
}

/** True when the title contains a raw path separator or NUL. */
export function findRawPathSeparator(value: string): string | null {
  for (const character of value) {
    if (character === '/' || character === '\\' || character === '\u0000') {
      return character;
    }
  }
  return null;
}
