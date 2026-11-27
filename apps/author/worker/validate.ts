/**
 * Server-side publish input validation (task 07).
 *
 * The task 06 serializer remains the only Markdown/YAML source; this module
 * adds the 07 publish boundary checks: strict structured payload, path-smuggling
 * rejection, the single-H1 rule for the body, and the final path assertion.
 */
import {
  planPublish,
  type MarkdownError,
  type PublishPlan,
} from '@selfpage/markdown';
import {
  findEncodedSeparator,
  findLevelOneHeading,
  findRawPathSeparator,
} from './content-guard.ts';

export type PublishField = 'title' | 'body' | 'date' | 'request';

export interface PublishIssue {
  code: string;
  field: PublishField;
  message: string;
}

export interface PublishInput {
  title: string;
  body: string;
  draftId: string;
  attemptId: string;
  /** True only when the user explicitly chose "Publish with a new timestamp". */
  newTimestamp: boolean;
}

export type PublishParseResult =
  | { ok: true; input: PublishInput }
  | { ok: false; status: 400 | 422; issues: PublishIssue[] };

const ALLOWED_FIELDS = new Set(['title', 'body', 'draftId', 'attemptId', 'newTimestamp']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(code: string, field: PublishField, message: string): PublishIssue {
  return { code, field, message };
}

function fromMarkdownError(error: MarkdownError): PublishIssue {
  return { code: error.code, field: error.field, message: error.message };
}

function validateIdentifiers(value: Record<string, unknown>): PublishIssue[] {
  const issues: PublishIssue[] = [];
  for (const [field, label] of [
    ['draftId', 'draft ID'],
    ['attemptId', 'publish attempt ID'],
  ] as const) {
    const raw = value[field];
    if (typeof raw !== 'string' || !IDENTIFIER.test(raw)) {
      issues.push(
        issue(
          'invalid_identifier',
          'request',
          `The request is missing a valid ${label}. Reload the page and try again.`,
        ),
      );
    }
  }
  return issues;
}

/** Lines/percentage checks that must happen before the serializer runs. */
function validateTitleBoundary(title: string): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const rawSeparator = findRawPathSeparator(title);
  if (rawSeparator !== null) {
    issues.push(
      issue(
        'title_path_separator',
        'title',
        'The title cannot contain "/", "\\" or a null character. Use plain text without paths.',
      ),
    );
    return issues;
  }
  const encoded = findEncodedSeparator(title);
  if (encoded !== null) {
    issues.push(
      issue(
        'title_encoded_separator',
        'title',
        `The title contains the encoded path separator "${encoded}", which is not allowed.`,
      ),
    );
  }
  return issues;
}

function validateBodyBoundary(body: string): PublishIssue[] {
  const heading = findLevelOneHeading(body);
  if (heading !== null) {
    return [
      issue(
        'body_extra_h1',
        'body',
        `The body cannot contain another level-1 heading (line ${heading.line}). The title becomes the only H1.`,
      ),
    ];
  }
  return [];
}

/**
 * Strictly validates the JSON body of `POST /api/posts`.
 *
 * Unknown fields are rejected instead of ignored: a caller must not be able to
 * smuggle `path`, `author`, `committer`, `branch` or a blob `sha` into the
 * publish transaction.
 */
export function validatePublishPayload(value: unknown): PublishParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      status: 400,
      issues: [issue('invalid_request', 'request', 'The request body must be a JSON object.')],
    };
  }

  const unexpected = Object.keys(value).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unexpected.length > 0) {
    return {
      ok: false,
      status: 422,
      issues: [
        issue(
          'unexpected_field',
          'request',
          'The request contains a field the author server does not accept. Reload the page and try again.',
        ),
      ],
    };
  }

  const typeIssues: PublishIssue[] = [];
  for (const field of ['title', 'body', 'draftId', 'attemptId'] as const) {
    if (typeof value[field] !== 'string') {
      typeIssues.push(
        issue(
          'invalid_field',
          field === 'title' || field === 'body' ? field : 'request',
          'The request contains an invalid field. Reload the page and try again.',
        ),
      );
    }
  }
  if (value.newTimestamp !== undefined && typeof value.newTimestamp !== 'boolean') {
    typeIssues.push(
      issue('invalid_field', 'request', 'The new timestamp option must be true or false.'),
    );
  }
  if (typeIssues.length > 0) {
    return { ok: false, status: 400, issues: typeIssues };
  }

  const identifierIssues = validateIdentifiers(value);
  if (identifierIssues.length > 0) {
    return { ok: false, status: 400, issues: identifierIssues };
  }

  const title = value.title as string;
  const body = value.body as string;
  const boundaryIssues = [...validateTitleBoundary(title), ...validateBodyBoundary(body)];
  if (boundaryIssues.length > 0) {
    return { ok: false, status: 422, issues: boundaryIssues };
  }

  return {
    ok: true,
    input: {
      title,
      body,
      draftId: value.draftId as string,
      attemptId: value.attemptId as string,
      newTimestamp: value.newTimestamp === true,
    },
  };
}

export type PublishPlanResult =
  | { ok: true; plan: PublishPlan }
  | { ok: false; status: 422; issues: PublishIssue[] };

/** Runs the task 06 serializer for a server-owned instant and asserts the final path. */
export function buildPublishPlan(
  input: Pick<PublishInput, 'title' | 'body'>,
  instant: number,
): PublishPlanResult {
  const planned = planPublish({ title: input.title, body: input.body }, instant);
  if (!planned.ok) {
    return { ok: false, status: 422, issues: planned.errors.map(fromMarkdownError) };
  }

  const pathIssues = assertSafePublishPath(
    planned.plan.path,
    planned.plan.fileName,
    planned.plan.timestamp.date,
  );
  if (pathIssues.length > 0) {
    return { ok: false, status: 422, issues: pathIssues };
  }
  return { ok: true, plan: planned.plan };
}

/**
 * Defense in depth: the serializer builds the path, but the publish transaction
 * still asserts the exact content root/shape and file-name byte limit before a
 * GitHub request is made.
 */
export function assertSafePublishPath(
  path: string,
  fileName: string,
  date: string,
): PublishIssue[] {
  const issues: PublishIssue[] = [];
  const year = date.slice(0, 4);
  const expected = `content/blog/${year}/${fileName}`;
  const unsafe =
    path !== expected ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
    fileName.startsWith('.') ||
    new TextEncoder().encode(fileName).length > 255;

  if (unsafe) {
    issues.push(
      issue(
        'path_rejected',
        'request',
        'The generated post path is not allowed. Nothing was sent to GitHub.',
      ),
    );
  }
  return issues;
}
