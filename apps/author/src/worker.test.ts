import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type AuthorWorkerEnv } from '../worker/index.ts';
import type {
  ClockResponse,
  DateResponse,
  MockAuthResponse,
  MockSessionResponse,
  PublishErrorResponse,
  PublishSuccessResponse,
} from '../worker/contracts.ts';

function createEnv(appEnv: string | null = 'test'): AuthorWorkerEnv {
  return {
    ...(appEnv === null ? {} : { APP_ENV: appEnv }),
    ASSETS: {
      async fetch(): Promise<Response> {
        return new Response('<!doctype html><html lang="en"><title>Author shell</title></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
  };
}

function request(path: string, init: RequestInit = {}, env: AuthorWorkerEnv = createEnv()): Promise<Response> {
  return worker.fetch(new Request(`https://author.example${path}`, init), env);
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function resetState(): Promise<void> {
  const response = await request('/api/test/reset', { method: 'POST' });
  expect(response.status).toBe(200);
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

const VALID_POST = { title: 'Example Post', body: 'Hello **world**', draftId: 'draft-1' };

beforeEach(async () => {
  await resetState();
});

describe('author worker health', () => {
  it('serves the health endpoint as JSON', async () => {
    const response = await request('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      service: 'selfpage-author',
      version: '0.1.0',
    });
  });

  it('rejects non-GET health requests with an Allow header', async () => {
    const response = await request('/api/health', { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    await expect(response.json()).resolves.toEqual({ error: 'method_not_allowed' });
  });

  it('returns JSON 404 for unknown API paths instead of the SPA shell', async () => {
    for (const path of ['/api', '/api/', '/api/health/', '/api/unknown']) {
      const response = await request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toContain('application/json');
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    }
  });

  it('routes the exact /api path through the Worker in the Wrangler assets config', () => {
    const config = JSON.parse(
      readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    ) as { assets?: { run_worker_first?: string[] } };
    const patterns = config.assets?.run_worker_first ?? [];
    // A14/P1-2: the public Blog "New!" link is `<origin>/new/`. Cloudflare's
    // asset-first routing would otherwise serve the SPA shell without invoking
    // the Worker, so no CSP/XFO/referrer-policy/nosniff headers would be added.
    expect(patterns).toEqual(
      expect.arrayContaining(['/api', '/api/*', '/', '/new', '/new/*']),
    );
  });

  it('keeps Cloudflare invocation logs off so OAuth code/state never reach account logs', () => {
    const config = JSON.parse(
      readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    ) as {
      observability?: { enabled?: boolean; logs?: { invocation_logs?: boolean } };
    };
    // A16: the callback query contains the one-time code and state. Invocation
    // logs record "<Method> <URL>", so they must stay disabled. Observability
    // itself stays enabled for the application's own redacted console logs.
    expect(config.observability?.enabled).toBe(true);
    expect(config.observability?.logs?.invocation_logs).toBe(false);
  });

  it('falls back to static assets for non-API paths and keeps security headers', async () => {
    const response = await request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(response.text()).resolves.toContain('Author shell');
  });
});

describe('GET /api/date', () => {
  it('returns the Asia/Shanghai calendar date from the fixed test clock', async () => {
    await setClock('2026-11-23T15:42:15Z');
    const response = await request('/api/date');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as DateResponse;
    expect(body).toEqual({ date: '2026-11-23', timeZone: 'Asia/Shanghai' });
  });

  it('rolls to the next Shanghai day after 16:00Z', async () => {
    await setClock('2026-11-23T16:00:00Z');
    const response = await request('/api/date');
    await expect(response.json()).resolves.toEqual({
      date: '2026-11-24',
      timeZone: 'Asia/Shanghai',
    });
  });

  it('supports HEAD and rejects other methods', async () => {
    const head = await request('/api/date', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');

    const post = await request('/api/date', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });

  it('returns a real date when no test clock is set', async () => {
    const response = await request('/api/date');
    const body = (await response.json()) as DateResponse;
    expect(body.timeZone).toBe('Asia/Shanghai');
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('POST /api/test/clock', () => {
  it('sets, reports and resets an RFC 3339 clock', async () => {
    const set = await request('/api/test/clock', jsonInit({ now: '2026-11-23T15:42:15Z' }));
    expect(set.status).toBe(200);
    const body = (await set.json()) as ClockResponse;
    expect(body.now).toBe('2026-11-23T15:42:15.000Z');
    expect(body.date).toBe('2026-11-23');
    expect(body.timeZone).toBe('Asia/Shanghai');

    const reset = await request('/api/test/clock', jsonInit({ reset: true }));
    expect(reset.status).toBe(200);
    expect(new Date(((await reset.json()) as ClockResponse).now).getTime()).toBeGreaterThan(
      Date.parse('2026-11-23T15:42:15Z'),
    );
  });

  it('rejects missing/invalid clocks and non-POST methods', async () => {
    for (const body of [{}, { now: '2026-11-23' }, { now: 'not-a-date' }, { now: 42 }]) {
      const response = await request('/api/test/clock', jsonInit(body));
      expect(response.status, JSON.stringify(body)).toBe(422);
      const json = (await response.json()) as { error: string };
      expect(json.error).toBe('invalid_clock');
    }

    const invalidJson = await request('/api/test/clock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(invalidJson.status).toBe(400);

    const get = await request('/api/test/clock');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });
});

describe('mock authorization', () => {
  it('starts anonymous, authorizes explicitly, and logs out', async () => {
    const anonymous = (await (await request('/api/mock/session')).json()) as MockSessionResponse;
    expect(anonymous).toEqual({ status: 'anonymous' });

    await authorize();
    const authorized = (await (await request('/api/mock/session')).json()) as MockSessionResponse;
    expect(authorized.status).toBe('authorized');
    expect(authorized.user?.login).toBe('mock-author');

    const logout = await request('/api/mock/logout', { method: 'POST' });
    expect(logout.status).toBe(200);
    const after = (await (await request('/api/mock/session')).json()) as MockSessionResponse;
    expect(after).toEqual({ status: 'anonymous' });
  });

  it('maps cancelled, forbidden, expired and permission-denied outcomes', async () => {
    const cases = [
      { outcome: 'cancelled', status: 400 },
      { outcome: 'forbidden', status: 403 },
      { outcome: 'expired', status: 401 },
      { outcome: 'permission_denied', status: 403 },
    ] as const;
    for (const { outcome, status } of cases) {
      const response = await request('/api/mock/auth', jsonInit({ outcome }));
      expect(response.status, outcome).toBe(status);
      const body = (await response.json()) as MockAuthResponse & { error: { code: string } };
      expect(body.status).toBe(outcome);
      expect(body.error.code).toBe(outcome);
    }
  });

  it('rejects unknown outcomes and wrong methods', async () => {
    const unknown = await request('/api/mock/auth', jsonInit({ outcome: 'root' }));
    expect(unknown.status).toBe(422);

    const get = await request('/api/mock/auth');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });
});

describe('mock publish', () => {
  it('requires authorization before publishing', async () => {
    const response = await publish(VALID_POST);
    expect(response.status).toBe(401);
    const body = (await response.json()) as PublishErrorResponse;
    expect(body.status).toBe('not_authorized');
  });

  it('returns the exact Markdown, commit path and a pending deployment for the fixed clock', async () => {
    await setClock('2026-11-23T15:42:15Z');
    await authorize();

    const response = await publish(VALID_POST);
    expect(response.status).toBe(201);
    const body = (await response.json()) as PublishSuccessResponse;
    expect(body.status).toBe('committed');
    expect(body.duplicate).toBe(false);
    expect(body.markdown).toBe(
      '---\ntitle: Example Post\ndate: 2026-11-23\n---\n\n' +
        '# Example Post\n\n2026-11-23\n\n---\n\nHello **world**\n',
    );
    expect(body.commit.path).toBe(
      'content/blog/2026/Example Post-2026-11-23-23-42-15.md',
    );
    expect(body.commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.deployment.status).toBe('pending');
    expect(body.deployment.message.toLowerCase()).toContain('not live');
    expect(body.markdown.toLowerCase()).not.toContain('token');
  });

  it('rejects invalid title/body with structured English errors and no commit', async () => {
    await setClock('2026-11-23T15:42:15Z');
    await authorize();

    const cases = [
      { title: '', body: 'body', draftId: 'd1', code: 'title_required' },
      { title: 'Title', body: '', draftId: 'd2', code: 'body_required' },
      { title: 'a'.repeat(61), body: 'body', draftId: 'd3', code: 'title_too_long' },
      { title: '😀'.repeat(59), body: 'body', draftId: 'd4', code: 'title_filename_too_long' },
      { title: 'Title', body: 'a'.repeat(256 * 1024 + 1), draftId: 'd5', code: 'body_too_large' },
      { title: 'Hello zhongwen\n\n', body: 'body', draftId: 'd6', code: 'title_single_line' },
    ];

    for (const { code, ...post } of cases) {
      const response = await publish(post);
      expect(response.status, code).toBe(422);
      const body = (await response.json()) as PublishErrorResponse;
      expect(body.status).toBe('validation_error');
      expect(body.errors?.map((error) => error.code)).toContain(code);
      expect(body.error.message).toMatch(/[A-Za-z]/);
    }
  });

  it('rejects malformed request bodies and missing draft IDs', async () => {
    await authorize();
    const invalidJson = await request('/api/mock/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(invalidJson.status).toBe(400);

    for (const draftId of [undefined, '', '   ', 42, 'x'.repeat(201)]) {
      const response = await publish({ ...VALID_POST, draftId });
      expect(response.status, String(draftId)).toBe(400);
    }

    const get = await request('/api/mock/publish');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('deduplicates the same draft/content within three hours and allows a new article at three hours', async () => {
    await setClock('2026-11-23T15:42:15Z');
    await authorize();

    const first = await publish(VALID_POST);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as PublishSuccessResponse;

    // Same second: accidental double submit.
    const sameSecond = await publish(VALID_POST);
    expect(sameSecond.status).toBe(200);
    const sameSecondBody = (await sameSecond.json()) as PublishSuccessResponse;
    expect(sameSecondBody.status).toBe('duplicate_ignored');
    expect(sameSecondBody.duplicate).toBe(true);
    expect(sameSecondBody.commit.sha).toBe(firstBody.commit.sha);
    expect(sameSecondBody.markdown).toBe(firstBody.markdown);

    // 2h59m59.999s later: still deduplicated.
    await setClock('2026-11-23T18:42:14.999Z');
    const almost = await publish(VALID_POST);
    expect(almost.status).toBe(200);
    expect(((await almost.json()) as PublishSuccessResponse).commit.sha).toBe(firstBody.commit.sha);

    // Exactly 3h later: an explicit publish creates a new timestamped article.
    await setClock('2026-11-23T18:42:15Z');
    const later = await publish(VALID_POST);
    expect(later.status).toBe(201);
    const laterBody = (await later.json()) as PublishSuccessResponse;
    expect(laterBody.status).toBe('committed');
    expect(laterBody.commit.sha).not.toBe(firstBody.commit.sha);
    expect(laterBody.timestamp).toBe('2026-11-24-02-42-15');
    expect(laterBody.commit.path).toBe(
      'content/blog/2026/Example Post-2026-11-24-02-42-15.md',
    );
  });

  it('treats a different content hash as a new article immediately', async () => {
    await setClock('2026-11-23T15:42:15Z');
    await authorize();
    const first = (await (await publish(VALID_POST)).json()) as PublishSuccessResponse;
    const second = await publish({ ...VALID_POST, body: 'Different body' });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as PublishSuccessResponse;
    expect(secondBody.commit.sha).not.toBe(first.commit.sha);
    expect(secondBody.timestamp).toBe('2026-11-23-23-42-15');
  });

  it('maps forced failure outcomes to bounded HTTP errors', async () => {
    await setClock('2026-11-23T15:42:15Z');
    await authorize();

    const cases = [
      { outcome: 'conflict', status: 409 },
      { outcome: 'rate_limited', status: 429 },
      { outcome: 'server_error', status: 500 },
      { outcome: 'timeout', status: 504 },
      { outcome: 'permission_denied', status: 403 },
    ] as const;

    for (const { outcome, status } of cases) {
      const response = await publish({ ...VALID_POST, mockOutcome: outcome });
      expect(response.status, outcome).toBe(status);
      const body = (await response.json()) as PublishErrorResponse;
      expect(body.status).toBe(outcome);
      expect(body.error.message).toMatch(/[A-Za-z]/);
      if (outcome === 'rate_limited') {
        expect(response.headers.get('retry-after')).toBe('30');
        expect(body.retryAfterSeconds).toBe(30);
      }
    }

    const expired = await publish({ ...VALID_POST, mockOutcome: 'expired' });
    expect(expired.status).toBe(401);
    const session = (await (await request('/api/mock/session')).json()) as MockSessionResponse;
    expect(session.status).toBe('anonymous');
  });

  it('distinguishes commit success from deployment failure and unconfirmed status', async () => {
    await setClock('2026-11-23T15:42:15Z');
    await authorize();

    for (const [outcome, deployment] of [
      ['deploy_failed', 'failed'],
      ['deploy_unconfirmed', 'unconfirmed'],
    ] as const) {
      const response = await publish({ ...VALID_POST, draftId: `draft-${outcome}`, mockOutcome: outcome });
      expect(response.status).toBe(201);
      const body = (await response.json()) as PublishSuccessResponse;
      expect(body.status).toBe('committed');
      expect(body.deployment.status).toBe(deployment);
      expect(body.deployment.message).toMatch(/not live|could not be confirmed/i);
    }
  });
});

describe('production isolation', () => {
  it.each([
    ['/api/mock/publish', 'POST'],
    ['/api/mock/session', 'GET'],
    ['/api/mock/auth', 'POST'],
    ['/api/mock/logout', 'POST'],
    ['/api/test/clock', 'POST'],
    ['/api/test/reset', 'POST'],
  ])('%s returns 404 when APP_ENV is not test', async (path, method) => {
    for (const appEnv of [null, 'production', 'development', 'TEST']) {
      const env = createEnv(appEnv);
      const response = await worker.fetch(
        new Request(`https://author.example${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'POST' ? '{}' : undefined,
        }),
        env,
      );
      expect(response.status, `${path} ${String(appEnv)}`).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    }
  });

  it('keeps /api/date available without exposing the test clock', async () => {
    const response = await request('/api/date', {}, createEnv(null));
    expect(response.status).toBe(200);
    const body = (await response.json()) as DateResponse;
    expect(body.timeZone).toBe('Asia/Shanghai');
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('does not expose token or secret values in any JSON payload', async () => {
    await setClock('2026-11-23T15:42:15Z');
    await authorize();
    const responses = [
      await request('/api/health'),
      await request('/api/date'),
      await request('/api/mock/session'),
      await publish(VALID_POST),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(text.toLowerCase()).not.toContain('client_secret');
      expect(text.toLowerCase()).not.toContain('access_token');
      expect(text.toLowerCase()).not.toContain('code_verifier');
    }
  });
});
