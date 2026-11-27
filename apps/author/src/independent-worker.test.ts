/**
 * Independent Worker contract tests (task 06).
 *
 * These run the real Worker module with a fake ASSETS binding and cover the
 * test-only mock surface boundaries: production 404, explicit authorization,
 * the exact three-hour dedupe boundary, the commit/deployment split, structured
 * validation and the absence of secret material in responses.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type AuthorWorkerEnv } from '../worker/index.ts';
import type {
  ClockResponse,
  MockSessionResponse,
  PublishErrorResponse,
  PublishSuccessResponse,
} from '../worker/contracts.ts';

const FIXED = '2026-11-23T15:42:15Z';
const FIXED_MS = Date.parse(FIXED);

function createEnv(appEnv: string | null = 'test'): AuthorWorkerEnv {
  return {
    ...(appEnv === null ? {} : { APP_ENV: appEnv }),
    ASSETS: {
      async fetch(): Promise<Response> {
        return new Response('<!doctype html><title>Author</title>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
  };
}

function request(
  path: string,
  init: RequestInit = {},
  env: AuthorWorkerEnv = createEnv(),
): Promise<Response> {
  return worker.fetch(new Request(`https://author.example${path}`, init), env);
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function setClock(now: string): Promise<void> {
  const response = await request('/api/test/clock', jsonInit({ now }));
  expect(response.status).toBe(200);
}

async function authorize(): Promise<void> {
  const response = await request('/api/mock/auth', jsonInit({ outcome: 'authorized' }));
  expect(response.status).toBe(200);
}

async function publish(body: Record<string, unknown>): Promise<Response> {
  return request('/api/mock/publish', jsonInit(body));
}

async function publishOk(body: Record<string, unknown>): Promise<PublishSuccessResponse> {
  const response = await publish(body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as PublishSuccessResponse;
}

beforeEach(async () => {
  const response = await request('/api/test/reset', { method: 'POST' });
  expect(response.status).toBe(200);
  await setClock(FIXED);
  await authorize();
});

describe('[independent] E15 production isolation of the mock surface', () => {
  it.each([
    ['/api/mock/publish', 'POST', { title: 'x', body: 'y', draftId: 'd' }],
    ['/api/test/clock', 'POST', { now: FIXED }],
    ['/api/test/clock', 'GET', undefined],
    ['/api/mock/session', 'GET', undefined],
    ['/api/mock/auth', 'POST', { outcome: 'authorized' }],
    ['/api/mock/logout', 'POST', undefined],
    ['/api/test/reset', 'POST', {}],
  ] as const)('returns JSON 404 for %s %s when APP_ENV is absent or production', async (path, method, data) => {
    for (const env of [createEnv(null), createEnv('production'), createEnv('')]) {
      const response = await request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'content-type': 'application/json' } }) }, env);
      expect(response.status, `${path} in ${String(env.APP_ENV)}`).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('keeps /api/health and /api/date available in production but not the test clock', async () => {
    const env = createEnv(null);
    expect((await request('/api/health', {}, env)).status).toBe(200);
    expect((await request('/api/date', {}, env)).status).toBe(200);
    const clock = await request('/api/test/clock', jsonInit({ now: FIXED }), env);
    expect(clock.status).toBe(404);
  });
});

describe('[independent] explicit authorization and bounded states', () => {
  it('rejects publish before authorization, then accepts exactly one explicit auth', async () => {
    // Drop the session prepared for the other tests to measure the anonymous case.
    const reset = await request('/api/test/reset', { method: 'POST' });
    expect(reset.status).toBe(200);
    const before = await publish({ title: 'A', body: 'B', draftId: 'd1' });
    expect(before.status).toBe(401);
    expect(((await before.json()) as PublishErrorResponse).status).toBe('not_authorized');

    await authorize();
    const session = (await (await request('/api/mock/session')).json()) as MockSessionResponse;
    expect(session.status).toBe('authorized');
    expect(session.user?.login).toBe('mock-author');

    await publishOk({ title: 'A', body: 'B', draftId: 'd1' });
  });

  it('maps cancelled/forbidden/expired/permission-denied authorization outcomes and clears the session', async () => {
    const cases = [
      ['cancelled', 400, /cancelled/i],
      ['forbidden', 403, /not the configured author/i],
      ['expired', 401, /expired/i],
      ['permission_denied', 403, /permission/i],
    ] as const;
    for (const [outcome, status, message] of cases) {
      await authorize();
      const response = await request('/api/mock/auth', jsonInit({ outcome }));
      expect(response.status, outcome).toBe(status);
      const body = (await response.json()) as { status: string; error?: { message?: string } };
      expect(body.status).toBe(outcome);
      expect(body.error?.message ?? '').toMatch(message);
      const session = (await (await request('/api/mock/session')).json()) as MockSessionResponse;
      expect(session.status).toBe('anonymous');
    }
  });

  it('validates the test clock and resets it with { reset: true }', async () => {
    for (const now of ['not-a-date', '2026-11-23', '2026-11-23T15:42:15', 42]) {
      const response = await request('/api/test/clock', jsonInit({ now }));
      expect(response.status, String(now)).toBe(422);
    }
    const reset = await request('/api/test/clock', jsonInit({ reset: true }));
    expect(reset.status).toBe(200);
    const body = (await reset.json()) as ClockResponse;
    expect(Number.isFinite(Date.parse(body.now))).toBe(true);
    expect(body.timeZone).toBe('Asia/Shanghai');
    const wrongMethod = await request('/api/test/clock', { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toContain('POST');
  });
});

describe('[independent] E12 dedupe and the exact three-hour boundary', () => {
  it('returns the original commit inside three hours and a new one at exactly three hours', async () => {
    const first = await publishOk({ title: 'Boundary', body: 'Same body', draftId: 'boundary-draft' });
    expect(first.status).toBe('committed');
    expect(first.duplicate).toBe(false);

    // 1 ms before the boundary: still the original commit.
    await setClock(new Date(FIXED_MS + 3 * 3_600_000 - 1).toISOString());
    const duplicateResponse = await publish({ title: 'Boundary', body: 'Same body', draftId: 'boundary-draft' });
    expect(duplicateResponse.status).toBe(200);
    const duplicate = (await duplicateResponse.json()) as PublishSuccessResponse;
    expect(duplicate.status).toBe('duplicate_ignored');
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.commit.sha).toBe(first.commit.sha);
    expect(duplicate.commit.path).toBe(first.commit.path);
    expect(duplicate.markdown).toBe(first.markdown);
    expect(duplicate.deployment).toEqual(first.deployment);

    // Exactly three hours after the first commit: a fresh article time.
    await setClock(new Date(FIXED_MS + 3 * 3_600_000).toISOString());
    const laterResponse = await publish({ title: 'Boundary', body: 'Same body', draftId: 'boundary-draft' });
    expect(laterResponse.status).toBe(201);
    const later = (await laterResponse.json()) as PublishSuccessResponse;
    expect(later.status).toBe('committed');
    expect(later.commit.sha).not.toBe(first.commit.sha);
    expect(later.timestamp).toBe('2026-11-24-02-42-15');
    expect(later.markdown).not.toBe(first.markdown); // visible date rolled to 11-24
  });

  it('keys dedupe by draftId + content: either changing starts a new commit', async () => {
    const first = await publishOk({ title: 'Key', body: 'Body', draftId: 'key-1' });
    const otherDraft = await publishOk({ title: 'Key', body: 'Body', draftId: 'key-2' });
    expect(otherDraft.commit.sha).not.toBe(first.commit.sha);

    await setClock(new Date(FIXED_MS + 60_000).toISOString());
    const otherContent = await publishOk({ title: 'Key', body: 'Body changed', draftId: 'key-1' });
    expect(otherContent.commit.sha).not.toBe(first.commit.sha);
    expect(otherContent.commit.sha).not.toBe(otherDraft.commit.sha);
  });

  it('does not let a forced failure consume the dedupe slot', async () => {
    const failed = await publish({
      title: 'Failure then success',
      body: 'Body',
      draftId: 'retry-draft',
      mockOutcome: 'conflict',
    });
    expect(failed.status).toBe(409);

    const success = await publishOk({
      title: 'Failure then success',
      body: 'Body',
      draftId: 'retry-draft',
    });
    expect(success.status).toBe('committed');
    expect(success.duplicate).toBe(false);
  });
});

describe('[independent] E12 commit vs deployment and bounded failure mapping', () => {
  it('distinguishes commit success from deployment pending/failed/unconfirmed', async () => {
    const pending = await publishOk({ title: 'Deploy pending', body: 'B', draftId: 'p1' });
    expect(pending.commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pending.deployment.status).toBe('pending');
    expect(pending.deployment.message).toMatch(/not live yet/i);

    const failed = await publishOk({
      title: 'Deploy failed',
      body: 'B',
      draftId: 'p2',
      mockOutcome: 'deploy_failed',
    });
    expect(failed.status).toBe('committed');
    expect(failed.commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(failed.deployment.status).toBe('failed');
    expect(failed.deployment.message).toMatch(/not live/i);

    const unconfirmed = await publishOk({
      title: 'Deploy unconfirmed',
      body: 'B',
      draftId: 'p3',
      mockOutcome: 'deploy_unconfirmed',
    });
    expect(unconfirmed.deployment.status).toBe('unconfirmed');
    expect(unconfirmed.deployment.message).toMatch(/could not be confirmed/i);
  });

  it.each([
    ['conflict', 409],
    ['rate_limited', 429],
    ['server_error', 500],
    ['timeout', 504],
    ['expired', 401],
    ['permission_denied', 403],
  ] as const)('maps %s to a bounded HTTP %i with an English message', async (outcome, status) => {
    const startedAt = Date.now();
    const response = await publish({
      title: `Failure ${outcome}`,
      body: 'Body',
      draftId: `failure-${outcome}`,
      mockOutcome: outcome,
    });
    expect(response.status).toBe(status);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const body = (await response.json()) as PublishErrorResponse;
    expect(body.error.message).toMatch(/^[A-Z][\x20-\x7E]+$/);
  });

  it('adds a retry-after hint to rate limiting', async () => {
    const response = await publish({
      title: 'Rate limited',
      body: 'Body',
      draftId: 'rate',
      mockOutcome: 'rate_limited',
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(((await response.json()) as PublishErrorResponse).retryAfterSeconds).toBe(30);
  });
});

describe('[independent] E04 server-side validation mirrors the serializer', () => {
  it.each([
    ['empty title', '', 'Body', 'title_required'],
    ['empty body', 'Title', '', 'body_required'],
    ['61 code points', 'a'.repeat(61), 'Body', 'title_too_long'],
    ['236 safe bytes', '😀'.repeat(59), 'Body', 'title_filename_too_long'],
    ['256KiB+1 body', 'Title', 'a'.repeat(256 * 1024 + 1), 'body_too_large'],
  ] as const)('rejects %s with 422 and a structured error', async (_label, title, body, code) => {
    const response = await publish({ title, body, draftId: 'invalid-post' });
    expect(response.status).toBe(422);
    const payload = (await response.json()) as PublishErrorResponse & {
      errors?: Array<{ code: string; field: string; message: string }>;
    };
    expect(payload.status).toBe('validation_error');
    expect(payload.errors?.some((error) => error.code === code)).toBe(true);
    expect(payload.errors?.every((error) => /^[A-Z][\x20-\x7E]+$/.test(error.message))).toBe(true);
  });

  it('rejects D22 colon/question titles before creating a commit', async () => {
    for (const title of ['C: A Subtitle', 'Why?', 'A: "B" * <C>']) {
      const response = await publish({ title, body: 'Body', draftId: 'd22-invalid' });
      expect(response.status, title).toBe(422);
      const payload = (await response.json()) as PublishErrorResponse & {
        errors?: Array<{ code: string; message: string }>;
      };
      expect(payload.status).toBe('validation_error');
      expect(payload.errors?.some((error) => error.code === 'title_reserved_character')).toBe(true);
      expect(payload.errors?.every((error) => /^[A-Z][\x20-\x7E]+$/.test(error.message))).toBe(true);
    }

    // Invalid attempts must not consume the dedupe slot for the draft/content.
    const valid = await publishOk({ title: 'Valid after D22', body: 'Body', draftId: 'd22-invalid' });
    expect(valid.status).toBe('committed');
  });

  it('still publishes the D22-allowed file-name characters and keeps them in the H1', async () => {
    const title = 'A "B" * <C> | D';
    const published = await publishOk({ title, body: 'Body', draftId: 'd22-allowed' });
    expect(published.visibleMarkdown.split('\n')[0]).toBe(`# ${title}`);
    expect(published.commit.path).toContain('A -B- - -C- - D-');
  });

  it('validates the request shape before touching the publish plan', async () => {
    const missingDraft = await publish({ title: 'T', body: 'B' });
    expect(missingDraft.status).toBe(400);
    expect(((await missingDraft.json()) as PublishErrorResponse).error.message).toMatch(/draft ID/i);

    const nonObject = await request('/api/mock/publish', jsonInit('string'));
    expect(nonObject.status).toBe(400);

    const malformed = await request('/api/mock/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
  });

  it('never creates a commit from invalid input (no dedupe slot consumed)', async () => {
    await publish({ title: '', body: '', draftId: 'reuse-draft' });
    const valid = await publishOk({ title: 'Valid after invalid', body: 'Body', draftId: 'reuse-draft' });
    expect(valid.status).toBe('committed');
  });
});

describe('[independent] E09 no secret material in mock payloads', () => {
  it('contains no token/secret/state/verifier field in success or error responses', async () => {
    const bodies: string[] = [];
    const session = await request('/api/mock/session');
    bodies.push(await session.text());
    const auth = await request('/api/mock/auth', jsonInit({ outcome: 'authorized' }));
    bodies.push(await auth.text());

    const success = await publish({ title: 'Secret scan', body: 'No secrets', draftId: 'secret-scan' });
    bodies.push(await success.clone().text());
    for (const outcome of ['conflict', 'server_error', 'timeout', 'rate_limited'] as const) {
      const failure = await publish({
        title: 'Secret failure',
        body: 'No secrets',
        draftId: `secret-${outcome}`,
        mockOutcome: outcome,
      });
      bodies.push(await failure.text());
    }

    const haystack = bodies.join('\n');
    expect(haystack).not.toMatch(/client_secret/i);
    expect(haystack).not.toMatch(/access_token/i);
    expect(haystack).not.toMatch(/code_verifier/i);
    expect(haystack).not.toMatch(/oauth_state/i);
    expect(haystack).not.toMatch(/ghu_|github_pat_/);
    expect(haystack).not.toMatch(/client_id/i);
  });
});
