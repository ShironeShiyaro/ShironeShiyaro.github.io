// The content model is the route/file-name source of truth. Its package
// `exports` map exposes only the root index, which also pulls in the Node-only
// loader (`node:fs`/`node:path`); the author browser bundle and the Worker must
// not include that loader, so use the single public slug module directly.
import {
  BLOG_ROUTE_RESERVED_CHARACTERS,
  sanitizeBlogTitleForFileName,
} from '../../content-model/src/slug.ts';
import type { MarkdownError } from './errors.ts';

/**
 * Trimmed title length limit, counted in Unicode code points.
 */
export const TITLE_MAX_CODE_POINTS = 60;
/** UTF-8 byte limit for the file-name form of the title (23 bytes are reserved for the timestamp + ".md"). */
export const SAFE_TITLE_MAX_BYTES = 232;
/** UTF-8 byte limit for the normalised body (256 KiB). */
export const BODY_MAX_BYTES = 256 * 1024;

/** Control/line-separator characters that must never enter a single-line title. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

/**
 * `packages/content-model` strips trailing closing hashes from an H1
 * (`/[ \t]+#+[ \t]*$/`), so a title ending in ` #` would no longer match the
 * front matter title and the public build would reject the post.
 */
const UNSTABLE_TRAILING_HASHES = /[ \t]+#+$/u;

function stripClosingHashes(text: string): string {
  return text.replace(UNSTABLE_TRAILING_HASHES, '').trim();
}

const encoder = new TextEncoder();

/** Number of Unicode code points (not UTF-16 code units). */
export function countCodePoints(value: string): number {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
  }
  return count;
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * The public site's single file-name sanitisation rule (D14): Unicode NFC,
 * trim, replace `/`, `\`, control characters and Windows-illegal characters
 * (`< > : " | ? *`) with `-`. D22 rejects `:` and `?` (and the other route
 * reserved characters) before this point, so only `< > " | *` can actually
 * reach a published title's file name. The H1 keeps the original title.
 */
export function sanitizeTitleForFileName(title: string): string {
  return sanitizeBlogTitleForFileName(title);
}

function findReservedRouteCharacter(title: string): string | null {
  for (const character of title.normalize('NFC')) {
    if (BLOG_ROUTE_RESERVED_CHARACTERS.includes(character)) {
      return character;
    }
  }
  return null;
}

export interface TitleValidation {
  /** Trimmed original title; only meaningful when `errors` is empty. */
  title: string;
  safeTitle: string;
  errors: MarkdownError[];
}

/** Validates a raw title value. Never throws. */
export function validateTitle(rawTitle: unknown): TitleValidation {
  const errors: MarkdownError[] = [];
  const raw = typeof rawTitle === 'string' ? rawTitle : '';
  const title = raw.trim();
  const safeTitle = sanitizeTitleForFileName(title);

  if (typeof rawTitle !== 'string') {
    errors.push({
      code: 'title_required',
      field: 'title',
      message: 'Enter a title before publishing.',
    });
    return { title, safeTitle, errors };
  }

  // A whitespace-only value is a missing title, not a line-break title; both
  // are rejected before publish. For non-empty values check the raw string so
  // trailing `\n`/`\u2028` cannot be hidden by trim.
  if (title === '') {
    errors.push({
      code: 'title_required',
      field: 'title',
      message: 'Enter a title before publishing.',
    });
    return { title, safeTitle, errors };
  }

  // Check the raw value, not the trimmed one: `Title\n` and `Title\u2028`
  // must never be silently accepted as a single-line title. This is the
  // server-side backstop for IME/beforeinput regressions in the editor.
  if (CONTROL_CHARACTER.test(raw)) {
    errors.push({
      code: 'title_single_line',
      field: 'title',
      message:
        'Title must be a single line of plain text. Line breaks, tabs and control characters are not allowed.',
    });
  }

  if (countCodePoints(title) > TITLE_MAX_CODE_POINTS) {
    errors.push({
      code: 'title_too_long',
      field: 'title',
      message: `Title must be ${TITLE_MAX_CODE_POINTS} characters or fewer (Unicode code points).`,
    });
  }

  if (stripClosingHashes(title) !== title) {
    errors.push({
      code: 'title_unstable_heading',
      field: 'title',
      message:
        'Title cannot end with a space followed by "#" because the published heading would lose those characters.',
    });
  }

  const reserved = findReservedRouteCharacter(title);
  if (reserved !== null) {
    errors.push({
      code: 'title_reserved_character',
      field: 'title',
      message: `Title contains "${reserved}", which cannot be used in a published file name. Remove it and try again.`,
    });
  }

  if (utf8ByteLength(safeTitle) > SAFE_TITLE_MAX_BYTES) {
    errors.push({
      code: 'title_filename_too_long',
      field: 'title',
      message: `The title is too long for a file name (maximum ${SAFE_TITLE_MAX_BYTES} UTF-8 bytes after replacing characters that are not allowed in file names). Shorten the title.`,
    });
  }

  return { title, safeTitle, errors };
}
