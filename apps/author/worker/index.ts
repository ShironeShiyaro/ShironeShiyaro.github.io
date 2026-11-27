import {
  AUTHOR_TIME_ZONE,
  getShanghaiTimestamp,
  planPublish,
  type MarkdownError,
} from '@selfpage/markdown';
import {
  MOCK_AUTH_OUTCOMES,
  MOCK_PUBLISH_OUTCOMES,
  type ClockRequest,
  type ClockResponse,
  type DateResponse,
  type DeploymentResponse,
  type DeploymentStatus,
  type MockAuthOutcome,
  type MockAuthRequest,
  type MockAuthResponse,
  type MockPublishOutcome,
  type MockSessionResponse,
  type PublishErrorResponse,
  type PublishRequestBody,
  type PublishSuccessResponse,
  type SessionResponse,
} from './contracts.ts';
import { hasAnyGitHubConfiguration, isMockSurfaceEnabled, resolveGitHubConfig, type AuthorWorkerEnv } from './env.ts';
import { AuthorStore } from './author-store.ts';
import { checkDeployments } from './github.ts';
import { hmacHex, sha256Hex } from './crypto.ts';

export { AuthorStore };
export type { AuthorWorkerEnv } from './env.ts';

const HEALTH_BODY = JSON.stringify({
  status: 'ok',
  service: 'selfpage-author',
  version: '0.1.0',
});

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const MOCK_AUTH_DELAY_MS = 400;
const MOCK_SLOW_PUBLISH_DELAY_MS = 2500;
const SESSION_COOKIE = 'sp_session';
const SESSION_COOKIE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;
const MAX_PUBLISH_BODY_BYTES = 600 * 1024;
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
].join('; ');

const DEPLOY_MESSAGES: Record<DeploymentStatus, string> = {
  pending: 'The commit exists, but the site deployment is still pending. The post is not live yet.',
  deployed: 'The commit exists and the deployment completed successfully.',
  failed: 'The commit exists, but the deployment failed. The post is not live.',
  unconfirmed: 'The commit exists, but the deployment status could not be confirmed.',
};

/** Process-local mock state. It is test-only and disappears on a Worker restart. */
let clockOverride: number | null = null;
let mockSession: { user: { login: string; id: number } } | null = null;
const mockCommits = new Map<string, MockCommitRecord>();

interface MockCommitRecord {
  key: string;
  markdown: string;
  visibleMarkdown: string;
  frontMatter: string;
  date: string;
  timestamp: string;
  commit: {
    sha: string;
    committedAt: string;
    path: string;
    fileName: string;
  };
  committedAtMs: number;
}

const MOCK_USER = { login: 'mock-author', id: 1_000_001 } as const;

function securityHeaders(headers: Headers): void {
  if (!headers.has('x-content-type-options')) {
    headers.set('x-content-type-options', 'nosniff');
  }
  if (!headers.has('referrer-policy')) {
    headers.set('referrer-policy', 'no-referrer');
  }
  if (!headers.has('x-frame-options')) {
    headers.set('x-frame-options', 'DENY');
  }
}

/**
 * Build-time-independent mode hint (P2-3): the same client bundle is served by
 * the mock worker (task 06 suite) and by a real deployment, so the served HTML
 * tells the client which session endpoint exists. Without it the client has to
 * probe `/api/mock/session` first, which logs a 404 in production.
 */
const AUTHOR_MODE_META = 'selfpage-author-mode';

async function withSecurityHeaders(
  response: Response,
  mode: 'mock' | 'github',
): Promise<Response> {
  const headers = new Headers(response.headers);
  securityHeaders(headers);
  const isHtml = (headers.get('content-type') ?? '').includes('text/html');
  if (isHtml && !headers.has('content-security-policy')) {
    headers.set('content-security-policy', CSP);
  }
  if (!isHtml) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const original = await response.text();
  const html = original.includes(`name="${AUTHOR_MODE_META}"`)
    ? original
    : original.replace(
        /<head(\s[^>]*)?>/i,
        (match) => `${match}\n    <meta name="${AUTHOR_MODE_META}" content="${mode}" />`,
      );
  headers.delete('content-length');
  headers.set('content-length', String(new TextEncoder().encode(html).byteLength));
  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  securityHeaders(headers);
  return new Response(JSON.stringify(body), { status, headers });
}

function redirectResponse(location: string, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  securityHeaders(headers);
  return new Response(null, { status: 302, headers });
}

function apiNotFound(): Response {
  return jsonResponse({ error: 'not_found' }, 404);
}

function methodNotAllowed(allow: string): Response {
  return jsonResponse({ error: 'method_not_allowed' }, 405, { allow });
}

function isTestEnvironment(env: AuthorWorkerEnv): boolean {
  return env.APP_ENV === 'test';
}

function nowMs(): number {
  return clockOverride ?? Date.now();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sha256HexMock(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}

async function readJsonLimited(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; tooLarge?: boolean }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_PUBLISH_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false };
  }
  if (new TextEncoder().encode(text).length > MAX_PUBLISH_BODY_BYTES) {
    return { ok: false, tooLarge: true };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMockAuthOutcome(value: unknown): value is MockAuthOutcome {
  return typeof value === 'string' && (MOCK_AUTH_OUTCOMES as readonly string[]).includes(value);
}

function isMockPublishOutcome(value: unknown): value is MockPublishOutcome {
  return typeof value === 'string' && (MOCK_PUBLISH_OUTCOMES as readonly string[]).includes(value);
}

function publishError(
  status: PublishErrorResponse['status'],
  message: string,
  extra: Partial<PublishErrorResponse> = {},
): PublishErrorResponse {
  return { status, error: { code: status, message }, ...extra };
}

const MOCK_AUTH_MESSAGES: Record<Exclude<MockAuthOutcome, 'authorized'>, string> = {
  cancelled: 'GitHub authorization was cancelled. Nothing was published.',
  forbidden: 'This GitHub account is not the configured author. Nothing was published.',
  expired: 'The GitHub authorization expired. Continue with GitHub to sign in again.',
  permission_denied:
    'The GitHub App cannot write to this repository. Review the App permissions before trying again.',
};

async function handleDate(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed('GET, HEAD');
  }
  const parts = getShanghaiTimestamp(nowMs());
  const body: DateResponse = { date: parts.date, timeZone: AUTHOR_TIME_ZONE };
  if (request.method === 'HEAD') {
    const headers = new Headers({ 'cache-control': 'no-store' });
    securityHeaders(headers);
    return new Response(null, { status: 200, headers });
  }
  return jsonResponse(body, 200);
}

async function handleMockSession(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }
  const body: MockSessionResponse = mockSession
    ? { status: 'authorized', user: mockSession.user }
    : { status: 'anonymous' };
  return jsonResponse(body, 200);
}

async function handleMockAuth(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  const parsed = await readJson(request);
  if (!parsed.ok) {
    return jsonResponse(publishError('validation_error', 'The request body must be JSON.'), 400);
  }
  const body = isRecord(parsed.value) ? (parsed.value as unknown as MockAuthRequest) : {};
  const outcome = body.outcome ?? 'authorized';
  if (!isMockAuthOutcome(outcome)) {
    return jsonResponse(
      publishError('validation_error', 'Unknown mock authorization outcome.'),
      422,
    );
  }

  // Simulate a browser round trip so the pending state is observable, but never
  // leave the client waiting indefinitely.
  await sleep(MOCK_AUTH_DELAY_MS);

  if (outcome === 'authorized') {
    mockSession = { user: { ...MOCK_USER } };
    const response: MockAuthResponse = { status: 'authorized', user: mockSession.user };
    return jsonResponse(response, 200);
  }

  mockSession = null;
  const statusCode = outcome === 'cancelled' ? 400 : outcome === 'expired' ? 401 : 403;
  const response: MockAuthResponse = { status: outcome };
  return jsonResponse(
    {
      ...response,
      error: { code: outcome, message: MOCK_AUTH_MESSAGES[outcome] },
    },
    statusCode,
  );
}

async function handleMockLogout(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  mockSession = null;
  const body: MockSessionResponse = { status: 'anonymous' };
  return jsonResponse(body, 200);
}

function deploymentStatusFor(outcome: MockPublishOutcome | undefined): DeploymentStatus {
  if (outcome === 'deploy_failed') {
    return 'failed';
  }
  if (outcome === 'deploy_unconfirmed') {
    return 'unconfirmed';
  }
  return 'pending';
}

function successResponse(record: MockCommitRecord, duplicate: boolean): PublishSuccessResponse {
  return {
    status: duplicate ? 'duplicate_ignored' : 'committed',
    duplicate,
    markdown: record.markdown,
    visibleMarkdown: record.visibleMarkdown,
    frontMatter: record.frontMatter,
    date: record.date,
    timestamp: record.timestamp,
    commit: record.commit,
    deployment: {
      status: 'pending',
      message: DEPLOY_MESSAGES.pending,
    },
  };
}

async function handleMockPublish(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (!mockSession) {
    return jsonResponse(
      publishError('not_authorized', 'Sign in with GitHub before publishing.'),
      401,
    );
  }

  const parsed = await readJson(request);
  if (!parsed.ok) {
    return jsonResponse(publishError('validation_error', 'The request body must be JSON.'), 400);
  }
  if (!isRecord(parsed.value)) {
    return jsonResponse(publishError('validation_error', 'The request body must be an object.'), 400);
  }
  const body = parsed.value as unknown as PublishRequestBody;
  const title = typeof body.title === 'string' ? body.title : '';
  const rawBody = typeof body.body === 'string' ? body.body : '';
  const draftId = typeof body.draftId === 'string' ? body.draftId.trim() : '';
  const outcome = isMockPublishOutcome(body.mockOutcome) ? body.mockOutcome : 'auto';

  if (draftId === '' || draftId.length > 200) {
    return jsonResponse(
      publishError('validation_error', 'The request is missing a valid draft ID.'),
      400,
    );
  }

  const plan = planPublish({ title, body: rawBody }, nowMs());
  if (!plan.ok) {
    const errors: MarkdownError[] = plan.errors;
    return jsonResponse(
      publishError('validation_error', 'The post could not be published. Check the highlighted fields.', {
        errors,
      }),
      422,
    );
  }

  if (outcome === 'server_error') {
    return jsonResponse(publishError('server_error', 'The publishing service returned an error. Your draft is safe.'), 500);
  }
  if (outcome === 'timeout') {
    return jsonResponse(publishError('timeout', 'The publishing request timed out. Your draft is safe.'), 504);
  }
  if (outcome === 'rate_limited') {
    return jsonResponse(
      publishError('rate_limited', "GitHub's rate limit was reached. Try again later.", {
        retryAfterSeconds: 30,
      }),
      429,
      { 'retry-after': '30' },
    );
  }
  if (outcome === 'expired') {
    mockSession = null;
    return jsonResponse(
      publishError('expired', 'The GitHub authorization expired. Sign in again. Your draft is safe.'),
      401,
    );
  }
  if (outcome === 'permission_denied') {
    return jsonResponse(
      publishError(
        'permission_denied',
        'The GitHub App no longer has permission to write to this repository. Nothing was published.',
      ),
      403,
    );
  }
  if (outcome === 'conflict') {
    return jsonResponse(
      publishError(
        'conflict',
        'A different post already exists at this path. Nothing was overwritten. Your draft is safe.',
      ),
      409,
    );
  }
  if (outcome === 'slow') {
    await sleep(MOCK_SLOW_PUBLISH_DELAY_MS);
  }

  const { post, fileName, path, timestamp } = plan.plan;
  const contentHash = await sha256HexMock(`${post.title}\n${post.body}`);
  const key = `${draftId}:${contentHash}`;
  const currentNow = nowMs();
  const existing = mockCommits.get(key);

  if (existing && currentNow - existing.committedAtMs < THREE_HOURS_MS) {
    return jsonResponse(successResponse(existing, true), 200);
  }

  const deploymentStatus = deploymentStatusFor(outcome);
  const commitSha = (
    await sha256HexMock(`selfpage-mock-commit:${key}:${timestamp.timestamp}:${currentNow}`)
  ).slice(0, 40);
  const record: MockCommitRecord = {
    key,
    markdown: post.markdown,
    visibleMarkdown: post.visibleMarkdown,
    frontMatter: post.frontMatter,
    date: post.date,
    timestamp: timestamp.timestamp,
    commit: {
      sha: commitSha,
      committedAt: new Date(currentNow).toISOString(),
      path,
      fileName,
    },
    committedAtMs: currentNow,
  };
  mockCommits.set(key, record);

  return jsonResponse(
    {
      ...successResponse(record, false),
      deployment: { status: deploymentStatus, message: DEPLOY_MESSAGES[deploymentStatus] },
    },
    201,
  );
}

function isValidRfc3339(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

async function handleTestClock(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  const parsed = await readJson(request);
  if (!parsed.ok) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }
  const body = (isRecord(parsed.value) ? parsed.value : {}) as ClockRequest;

  if (body.reset === true) {
    clockOverride = null;
  } else if (typeof body.now === 'string' && isValidRfc3339(body.now)) {
    clockOverride = Date.parse(body.now);
  } else {
    return jsonResponse(
      { error: 'invalid_clock', message: 'Send an RFC 3339 "now" value or { "reset": true }.' },
      422,
    );
  }

  const instant = nowMs();
  const parts = getShanghaiTimestamp(instant);
  const response: ClockResponse = {
    now: new Date(instant).toISOString(),
    date: parts.date,
    timeZone: AUTHOR_TIME_ZONE,
  };
  return jsonResponse(response, 200);
}

async function handleTestReset(request: Request, env: AuthorWorkerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  clockOverride = null;
  mockSession = null;
  mockCommits.clear();
  const store = storeStub(env);
  if (store) {
    try {
      await callStore(store, '/test/reset', {});
    } catch {
      // The mock suite's reset must still succeed when no DO is bound (unit tests).
    }
  }
  return jsonResponse({ status: 'reset' }, 200);
}

/* ------------------------------------------------------------------------- */
/* Task 07 real GitHub routes                                                */
/* ------------------------------------------------------------------------- */

interface StoreStub {
  fetch(request: Request): Promise<Response>;
}

function storeStub(env: AuthorWorkerEnv): StoreStub | null {
  if (!env.AUTHOR_STORE) {
    return null;
  }
  try {
    const id = env.AUTHOR_STORE.idFromName('selfpage-author');
    return env.AUTHOR_STORE.get(id);
  } catch {
    return null;
  }
}

interface StoreResult {
  status: number;
  body: Record<string, unknown>;
}

async function callStore(
  store: StoreStub,
  path: string,
  payload: Record<string, unknown>,
): Promise<StoreResult> {
  const response = await store.fetch(
    new Request(`https://author-store.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    body = isRecord(parsed) ? parsed : {};
  } catch {
    body = {};
  }
  return { status: response.status, body };
}

function serviceUnavailable(): Response {
  return jsonResponse(
    {
      status: 'server_error',
      error: {
        code: 'store_unavailable',
        message: 'The author server is not available. Your draft is safe. Try again shortly.',
      },
    },
    503,
  );
}

function clientIpHash(request: Request, env: AuthorWorkerEnv): Promise<string> {
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const secret = env.SESSION_SECRET;
  return secret && secret.length >= 32
    ? hmacHex(secret, `selfpage-ip:${ip}`)
    : sha256Hex(ip);
}

function parseCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function sessionIdFromRequest(request: Request): string | null {
  const value = parseCookie(request.headers.get('cookie'), SESSION_COOKIE);
  return value !== null && SESSION_COOKIE_PATTERN.test(value) ? value : null;
}

function sessionCookie(value: string): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    return origin === new URL(request.url).origin;
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

function securityBlocked(): Response {
  return jsonResponse(
    {
      status: 'forbidden',
      error: {
        code: 'security_blocked',
        message: 'The request was blocked by the author server. Reload the page and try again.',
      },
    },
    403,
  );
}

async function handleAuthStart(request: Request, env: AuthorWorkerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }
  const store = storeStub(env);
  if (!store) {
    return serviceUnavailable();
  }
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return securityBlocked();
  }
  const result = await callStore(store, '/auth/start', {
    redirectUri: `${url.origin}/auth/github/callback`,
    ipHash: await clientIpHash(request, env),
    switchAccount: url.searchParams.get('switch') === '1',
    now: nowMs(),
  });
  if (result.status === 200 && typeof result.body.authorizeUrl === 'string') {
    return redirectResponse(result.body.authorizeUrl);
  }
  if (result.status === 429) {
    return jsonResponse(
      { status: 'rate_limited', error: { code: 'rate_limited', message: 'Too many authorization attempts. Try again later.' }, retryAfterSeconds: result.body.retryAfterSeconds },
      429,
      { 'retry-after': String(result.body.retryAfterSeconds ?? 60) },
    );
  }
  // Configuration/unexpected failures store an auth outcome in the DO; send the
  // browser back to the editor where /api/session can render the terminal state.
  return redirectResponse('/');
}

async function handleAuthCallback(request: Request, env: AuthorWorkerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }
  const store = storeStub(env);
  if (!store) {
    return serviceUnavailable();
  }
  const url = new URL(request.url);
  const params = url.searchParams;
  const result = await callStore(store, '/auth/callback', {
    code: params.get('code') ?? '',
    state: params.get('state') ?? '',
    error: params.get('error') ?? '',
    redirectUri: `${url.origin}/auth/github/callback`,
    ipHash: await clientIpHash(request, env),
    now: nowMs(),
  });
  if (result.status === 200 && result.body.status === 'authorized' && typeof result.body.sessionId === 'string') {
    return redirectResponse('/', { 'set-cookie': sessionCookie(result.body.sessionId) });
  }
  if (result.status === 429) {
    return jsonResponse(
      { status: 'rate_limited', error: { code: 'rate_limited', message: 'Too many authorization attempts. Try again later.' } },
      429,
      { 'retry-after': String(result.body.retryAfterSeconds ?? 60) },
    );
  }
  return redirectResponse('/');
}

async function handleApiSession(request: Request, env: AuthorWorkerEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }
  if (!hasAnyGitHubConfiguration(env)) {
    // No GitHub App is configured in this build (e.g. the task 06
    // production-mode fixture): report the documented unavailable state.
    return apiNotFound();
  }
  const store = storeStub(env);
  if (!store) {
    return serviceUnavailable();
  }
  const sessionId = sessionIdFromRequest(request);
  const result = await callStore(store, '/session', {
    sessionId: sessionId ?? '',
    now: nowMs(),
  });
  if (result.status !== 200) {
    return jsonResponse(result.body, result.status);
  }
  if (result.body.status === 'authorized') {
    const body = { ...result.body, mode: 'github' } as SessionResponse;
    return jsonResponse(body, 200);
  }
  const clear = result.body.clearCookie === true || sessionId !== null;
  const extra: Record<string, string> = clear ? { 'set-cookie': clearSessionCookie() } : {};
  const body = { ...result.body, mode: 'github' } as SessionResponse;
  return jsonResponse(body, 200, extra);
}

async function handleApiLogout(request: Request, env: AuthorWorkerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (!sameOrigin(request)) {
    return securityBlocked();
  }
  const store = storeStub(env);
  if (!store) {
    return serviceUnavailable();
  }
  const sessionId = sessionIdFromRequest(request);
  const result = await callStore(store, '/logout', {
    sessionId: sessionId ?? '',
    csrfToken: request.headers.get('x-csrf-token') ?? '',
    ipHash: await clientIpHash(request, env),
    now: nowMs(),
  });
  if (result.status === 200) {
    return jsonResponse({ status: 'anonymous' }, 200, { 'set-cookie': clearSessionCookie() });
  }
  const headers: Record<string, string> =
    result.status === 429 && result.body.retryAfterSeconds !== undefined
      ? { 'retry-after': String(result.body.retryAfterSeconds) }
      : {};
  return jsonResponse(result.body, result.status, headers);
}

const PUBLISH_FIELDS = new Set(['title', 'body', 'draftId', 'attemptId', 'newTimestamp']);

async function handleApiPosts(request: Request, env: AuthorWorkerEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (!sameOrigin(request)) {
    return securityBlocked();
  }
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse(
      { status: 'validation_error', error: { code: 'validation_error', message: 'The request body must be JSON.' } },
      400,
    );
  }
  const parsed = await readJsonLimited(request);
  if (!parsed.ok) {
    return jsonResponse(
      {
        status: parsed.tooLarge ? 'validation_error' : 'validation_error',
        error: {
          code: parsed.tooLarge ? 'body_too_large' : 'invalid_request',
          message: parsed.tooLarge
            ? 'The request body is too large. Shorten the post and try again.'
            : 'The request body must be valid JSON.',
        },
      },
      parsed.tooLarge ? 413 : 400,
    );
  }
  if (!isRecord(parsed.value)) {
    return jsonResponse(
      { status: 'validation_error', error: { code: 'invalid_request', message: 'The request body must be a JSON object.' } },
      400,
    );
  }
  const unexpected = Object.keys(parsed.value).filter((key) => !PUBLISH_FIELDS.has(key));
  if (unexpected.length > 0) {
    return jsonResponse(
      {
        status: 'validation_error',
        error: {
          code: 'unexpected_field',
          message: 'The request contains a field the author server does not accept. Reload the page and try again.',
        },
        errors: [
          {
            code: 'unexpected_field',
            field: 'request',
            message: 'The request contains a field the author server does not accept. Reload the page and try again.',
          },
        ],
      },
      422,
    );
  }
  const store = storeStub(env);
  if (!store) {
    return serviceUnavailable();
  }
  const sessionId = sessionIdFromRequest(request);
  const result = await callStore(store, '/publish', {
    sessionId: sessionId ?? '',
    csrfToken: request.headers.get('x-csrf-token') ?? '',
    ipHash: await clientIpHash(request, env),
    now: nowMs(),
    title: parsed.value.title,
    body: parsed.value.body,
    draftId: parsed.value.draftId,
    attemptId: parsed.value.attemptId,
    ...(parsed.value.newTimestamp === undefined ? {} : { newTimestamp: parsed.value.newTimestamp }),
  });
  const extra: Record<string, string> = {};
  if (result.status === 429 && result.body.retryAfterSeconds !== undefined) {
    extra['retry-after'] = String(result.body.retryAfterSeconds);
  }
  if (result.body.clearCookie === true) {
    extra['set-cookie'] = clearSessionCookie();
  }
  return jsonResponse(result.body, result.status, extra);
}

async function handleApiDeployments(
  request: Request,
  env: AuthorWorkerEnv,
  sha: string,
): Promise<Response> {
  if (request.method !== 'GET') {
    return methodNotAllowed('GET');
  }
  if (!/^[0-9a-f]{7,40}$/iu.test(sha)) {
    return jsonResponse(
      { error: 'invalid_commit_sha', message: 'A valid commit SHA is required.' },
      400,
    );
  }
  const resolved = resolveGitHubConfig(env);
  if (!resolved.ok) {
    return jsonResponse({ error: 'configuration_error' }, 503);
  }
  const config = resolved.config;
  const store = storeStub(env);
  if (store) {
    const rate = await callStore(store, '/rate', {
      bucket: 'deployments',
      ipHash: await clientIpHash(request, env),
      now: nowMs(),
    });
    if (rate.status === 429) {
      return jsonResponse(
        { error: 'rate_limited', retryAfterSeconds: rate.body.retryAfterSeconds },
        429,
        { 'retry-after': String(rate.body.retryAfterSeconds ?? 60) },
      );
    }
  }
  const result = await checkDeployments(config, sha);
  const body: DeploymentResponse = {
    commitSha: sha,
    status: result.status,
    ...(result.status !== 'unconfirmed' && 'conclusion' in result && result.conclusion
      ? { conclusion: result.conclusion }
      : {}),
    message: result.message,
    ...(result.status !== 'unconfirmed' && 'runUrl' in result && result.runUrl
      ? { runUrl: result.runUrl }
      : {}),
    actionsUrl: `https://github.com/${config.repoFullName}/actions`,
    commitUrl: `https://github.com/${config.repoFullName}/commit/${sha}`,
    checkedAt: new Date(nowMs()).toISOString(),
    ...(result.status === 'unconfirmed' && 'retryAfterSeconds' in result && result.retryAfterSeconds
      ? { retryAfterSeconds: result.retryAfterSeconds }
      : {}),
  };
  return jsonResponse(body, 200);
}

function isMockPath(pathname: string): boolean {
  return pathname.startsWith('/api/mock/');
}

const worker = {
  async fetch(request: Request, env: AuthorWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return methodNotAllowed('GET, HEAD');
      }
      const headers = new Headers({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      securityHeaders(headers);
      return new Response(request.method === 'HEAD' ? null : HEALTH_BODY, { status: 200, headers });
    }

    if (url.pathname === '/api/date') {
      return handleDate(request);
    }

    if (url.pathname === '/auth/github/start') {
      return handleAuthStart(request, env);
    }

    if (url.pathname === '/auth/github/callback') {
      return handleAuthCallback(request, env);
    }

    if (url.pathname === '/api/session') {
      return handleApiSession(request, env);
    }

    if (url.pathname === '/api/logout') {
      return handleApiLogout(request, env);
    }

    if (url.pathname === '/api/posts') {
      return handleApiPosts(request, env);
    }

    if (url.pathname.startsWith('/api/deployments/')) {
      const sha = url.pathname.slice('/api/deployments/'.length);
      return handleApiDeployments(request, env, sha);
    }

    if (isMockPath(url.pathname)) {
      // The mock surface must not exist in production, including a dry-run
      // build that has no APP_ENV binding. Everything below is test-only.
      if (!isMockSurfaceEnabled(env)) {
        return apiNotFound();
      }
      switch (url.pathname) {
        case '/api/mock/session':
          return handleMockSession(request);
        case '/api/mock/auth':
          return handleMockAuth(request);
        case '/api/mock/logout':
          return handleMockLogout(request);
        case '/api/mock/publish':
          return handleMockPublish(request);
        default:
          return apiNotFound();
      }
    }

    if (url.pathname.startsWith('/api/test/')) {
      if (!isTestEnvironment(env)) {
        return apiNotFound();
      }
      switch (url.pathname) {
        case '/api/test/clock':
          return handleTestClock(request);
        case '/api/test/reset':
          return handleTestReset(request, env);
        default:
          return apiNotFound();
      }
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return apiNotFound();
    }

    if (!env.ASSETS) {
      return jsonResponse({ error: 'assets_unavailable' }, 503);
    }

    return withSecurityHeaders(
      await env.ASSETS.fetch(request),
      isMockSurfaceEnabled(env) ? 'mock' : 'github',
    );
  },
};

export default worker;
