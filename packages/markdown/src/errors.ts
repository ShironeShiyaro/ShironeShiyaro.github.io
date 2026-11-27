/**
 * Shared validation types for the one New! Markdown serializer.
 *
 * Every validation failure is a structured value that callers (author UI,
 * mock Worker, tests) can map to an English message; `serializePost` never
 * throws for user input.
 */

export type MarkdownField = 'title' | 'body' | 'date';

export type MarkdownErrorCode =
  | 'title_required'
  | 'title_too_long'
  | 'title_single_line'
  | 'title_reserved_character'
  | 'title_unstable_heading'
  | 'title_filename_too_long'
  | 'body_required'
  | 'body_too_large'
  | 'date_invalid';

export interface MarkdownError {
  code: MarkdownErrorCode;
  field: MarkdownField;
  /** English, user-facing message. */
  message: string;
}

export interface ValidationFailure {
  ok: false;
  errors: MarkdownError[];
}
