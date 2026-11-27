#!/usr/bin/env node
/**
 * Task 07 independent HTTP probes.
 *
 * Runs against the real Worker routes + real Durable Object with the local mock
 * GitHub server (started by `tests/run-author-github-independent.mjs`).
 *
 * This file deliberately goes beyond `tests/author-e2e/github/http.mjs`:
 *   - state/PKCE one-time consumption and cross-flow mixing;
 *   - permission intersection details;
 *   - pending/timeout reconciliation with a moved test clock;
 *   - CSRF/Origin matrix including logout;
 *   - path/encoding/length boundary groups;
 *   - cookie attributes and fixed-DO architecture evidence;
 *   - secret/log surfaces and return_to/open-redirect;
 *   - rate limits and bounded timeouts;
 *   - deployment pending/failed/unconfirmed branches and no polling.
 *
 * It never prints tokens, cookies, state, code or configured secret values.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.AUTHOR_GITHUB_TEST_BASE ?? 'http://localhost:43262';
const PROD = process.env.AUTHOR_GITHUB_PROD_BASE ?? 'http://localhost:43263';
const MOCK = process.env.AUTHOR_MOCK_BASE ?? 'http://127.0.0.1:43261';
const ROOT = process.env.INDEP_REPO_ROOT ?? process.cwd();
const REPORT = process.env.INDEP_HTTP_REPORT ?? '';
const SECRETS = [
  process.env.INDEP_SESSION_SECRET ?? '',
  process.env.INDEP_TOKEN_KEY ?? '',
  process.env.INDEP_CLIENT_SECRET ?? '',
].filter((value) => value.length >= 8);

const FIXED = '2026-11-23T15:42:15Z';
const FIXED_SHANGHAI = '2026-11-23-23-42-15';
const THREE_HOURS_LATER = '2026-11-23T18:42:15Z';
const RESULTS = [];
const SEEN_BODIES = [];
const SEEN_HEADERS = [];
const SECRET_PATTERN = /ghu_|ghr_|client_secret|access_token|refresh_token|code_verifier|oauth_state|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}/iu;
let failures = 0;
let limited = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, status, detail = '') {
  const entry = { name, status, detail };
  RESULTS.push(entry);
  if (status === 'FAIL') {
    failures += 1;
    process.stdout.write(`FAIL ${name}${detail ? `: ${detail}` : ''}\n`);
  } else {
    process.stdout.write(`${status === 'LIMITED' ? 'lim  ' : 'ok   '}${name}${detail ? `: ${detail}` : ''}\n`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    record(name, 'PASS');
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error));
  }
}

async function request(url, init = {}, options = {}) {
  const response = await fetch(url, { redirect: 'manual', ...init });
  const text = await response.text();
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  if (options.track !== false && text.length < 200_000) {
    SEEN_BODIES.push(text);
  }
  SEEN_HEADERS.push([...response.headers.entries()].map(([key, value]) => `${key}: ${value}`).join('\n'));
  return {
    status: response.status,
    headers: response.headers,
    body,
    text,
    setCookies: response.headers.getSetCookie?.() ?? [],
  };
}

function jsonInit(body, extraHeaders = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

async function setClock(now) {
  const response = await request(`${BASE}/api/test/clock`, jsonInit({ now }));
  assert.equal(response.status, 200, `clock ${response.status}: ${response.text}`);
}

async function resetAll() {
  const worker = await request(`${BASE}/api/test/reset`, { method: 'POST' });
  assert.equal(worker.status, 200, `worker reset ${worker.status}: ${worker.text}`);
  const mock = await request(`${MOCK}/__mock/reset`, { method: 'POST' }, { track: false });
  assert.equal(mock.status, 200, `mock reset ${mock.status}: ${mock.text}`);
  await setClock(FIXED);
}

async function control(scenario) {
  const response = await request(`${MOCK}/__mock/control`, jsonInit({ scenario }), { track: false });
  assert.equal(response.status, 200, `control ${response.status}: ${response.text}`);
}

async function mockState() {
  // The mock state includes a method+path request log whose OAuth token path
  // (`/login/oauth/access_token`) is not an application response. Keep it out
  // of the API-body secret scan; commits/files are scanned explicitly.
  const response = await request(`${MOCK}/__mock/state`, {}, { track: false });
  assert.equal(response.status, 200);
  return response.body;
}

function cookieFrom(setCookies) {
  for (const value of setCookies) {
    const match = /(?:^|,\s*)sp_session=([A-Za-z0-9_-]+)/u.exec(value);
    if (match) {
      return { value: match[1], header: `sp_session=${match[1]}`, raw: value };
    }
  }
  return null;
}

async function startAndAuthorize({ startPath = '/auth/github/start' } = {}) {
  const start = await request(`${BASE}${startPath}`);
  assert.equal(start.status, 302, `start ${start.status}: ${start.text}`);
  const authorizeUrl = start.headers.get('location');
  assert.ok(authorizeUrl, 'authorize location');
  const authorize = await request(authorizeUrl);
  const callbackUrl = authorize.headers.get('location');
  assert.ok(callbackUrl, 'callback location');
  return { start, authorizeUrl, authorize, callbackUrl };
}

async function beginFlow({ startPath = '/auth/github/start' } = {}) {
  const pending = await startAndAuthorize({ startPath });
  const callback = await request(pending.callbackUrl);
  const cookie = cookieFrom(callback.setCookies);
  return { ...pending, callback, cookie };
}

async function authenticate() {
  const flow = await beginFlow();
  assert.equal(flow.callback.status, 302);
  assert.equal(flow.callback.headers.get('location'), '/');
  assert.ok(flow.cookie, 'session cookie missing');
  const session = await request(`${BASE}/api/session`, {
    headers: { cookie: flow.cookie.header },
  });
  assert.equal(session.status, 200);
  assert.equal(session.body?.status, 'authorized', session.text);
  return { cookie: flow.cookie.header, csrf: session.body.csrfToken, session: session.body, flow };
}

function publishInit(auth, body, extraHeaders = {}) {
  return {
    method: 'POST',
    headers: {
      origin: BASE,
      'content-type': 'application/json',
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

async function publish(auth, body, extraHeaders = {}) {
  return request(`${BASE}/api/posts`, publishInit(auth, body, extraHeaders));
}

function validBody(overrides = {}) {
  return {
    title: '独立测试 中文标题',
    body: 'Hello **independent**\n\n- one\n- two',
    draftId: 'indep-draft-0001',
    attemptId: 'indep-attempt-0001',
    ...overrides,
  };
}

function assertStatus(actual, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  assert.ok(allowed.includes(actual), `${label}: expected ${allowed.join('/')} got ${actual}`);
}

function assertNoCookie(flow, label) {
  assert.equal(cookieFrom(flow.callback.setCookies), null, `${label}: unexpected session cookie`);
}

function assertLocationRoot(response, label) {
  assert.equal(response.status, 302, `${label}: status ${response.status}`);
  assert.equal(response.headers.get('location'), '/', `${label}: location ${response.headers.get('location')}`);
}

async function sessionAnonymous(authCookie = null) {
  const response = await request(`${BASE}/api/session`, authCookie ? { headers: { cookie: authCookie } } : {});
  assert.equal(response.status, 200);
  assert.equal(response.body?.status, 'anonymous', response.text);
  return response.body;
}

async function expectedPutCount(value, label) {
  const state = await mockState();
  assert.equal(state.counters.putRequests, value, `${label}: putRequests ${state.counters.putRequests} != ${value}`);
}

/* ------------------------------------------------------------------------- */
/* A03: access_denied / cancelled                                             */
/* ------------------------------------------------------------------------- */

async function probeA03() {
  await test('A03 access_denied: cancelled terminal, no session, head unchanged', async () => {
    await resetAll();
    const before = await mockState();
    await control({ authorize: 'deny' });
    const flow = await beginFlow();
    assertLocationRoot(flow.callback, 'A03 callback');
    assertNoCookie(flow, 'A03');
    const session = await sessionAnonymous();
    assert.ok(['cancelled', 'permission_denied', 'oauth_error'].includes(session.auth?.status), session.auth?.status);
    assert.equal(session.auth?.status, 'cancelled', JSON.stringify(session));
    const after = await mockState();
    assert.equal(after.commits.length, before.commits.length);
    assert.deepEqual(after.files.map((file) => file.path), before.files.map((file) => file.path));
    assert.equal(after.counters.putRequests, 0);
    await control({ authorize: 'approve' });
  });
}

/* ------------------------------------------------------------------------- */
/* A04: state / PKCE one-time and replay                                      */
/* ------------------------------------------------------------------------- */

async function probeA04() {
  await test('A04 missing state: rejected before token exchange and write', async () => {
    await resetAll();
    const response = await request(`${BASE}/auth/github/callback?code=deadbeefdeadbeef`);
    assertLocationRoot(response, 'A04 missing state');
    assert.equal(cookieFrom(response.setCookies), null);
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 0);
    assert.equal(state.counters.putRequests, 0);
    const session = await sessionAnonymous();
    assert.ok(['oauth_error', 'state_invalid'].includes(session.auth?.status), JSON.stringify(session));
  });

  await test('A04 random/wrong state: rejected, no token, no write', async () => {
    await resetAll();
    const response = await request(`${BASE}/auth/github/callback?state=${'B'.repeat(43)}&code=deadbeefdeadbeef`);
    assertLocationRoot(response, 'A04 wrong state');
    assert.equal(cookieFrom(response.setCookies), null);
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 0);
    assert.equal(state.counters.putRequests, 0);
    const session = await sessionAnonymous();
    assert.ok(['oauth_error', 'state_invalid'].includes(session.auth?.status), JSON.stringify(session));
  });

  await test('A04 replay of a consumed callback: no second session/token/write', async () => {
    await resetAll();
    const flow = await beginFlow();
    assert.ok(flow.cookie, 'initial flow should create a session');
    const replay = await request(flow.callbackUrl);
    assertLocationRoot(replay, 'A04 replay');
    assert.equal(cookieFrom(replay.setCookies), null);
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 1, 'only the initial flow may exchange');
    assert.equal(state.counters.putRequests, 0);
  });

  await test('A04 wrong PKCE verifier: exchange fails, no session, no write', async () => {
    await resetAll();
    await control({ exchange: 'bad_verifier' });
    const flow = await beginFlow();
    assertLocationRoot(flow.callback, 'A04 bad verifier');
    assertNoCookie(flow, 'A04 bad verifier');
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 1);
    assert.equal(state.counters.putRequests, 0);
    const session = await sessionAnonymous();
    assert.ok(['oauth_error', 'state_invalid'].includes(session.auth?.status), JSON.stringify(session));
    await control({ exchange: 'ok' });
  });

  await test('A04 cross-flow state/code mix: rejected, no session, no write', async () => {
    await resetAll();
    const pendingA = await startAndAuthorize();
    const pendingB = await startAndAuthorize();
    const mixed = new URL(pendingA.callbackUrl);
    mixed.searchParams.set('code', new URL(pendingB.callbackUrl).searchParams.get('code') ?? '');
    const response = await request(mixed.href);
    assertLocationRoot(response, 'A04 mixed flow');
    assert.equal(cookieFrom(response.setCookies), null);
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 1);
    assert.equal(state.counters.putRequests, 0);
    const session = await sessionAnonymous();
    assert.ok(['oauth_error', 'state_invalid'].includes(session.auth?.status), JSON.stringify(session));
  });

  await test('A04 valid state older than 10 minutes: expired state, no token/write', async () => {
    await resetAll();
    const pending = await startAndAuthorize();
    await setClock('2026-11-23T15:52:16Z'); // 10 min + 1 s after FIXED
    const expired = await request(pending.callbackUrl);
    assertLocationRoot(expired, 'A04 expired state');
    assert.equal(cookieFrom(expired.setCookies), null);
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 0);
    assert.equal(state.counters.putRequests, 0);
    // Restore the fixed clock for later probes.
    await setClock(FIXED);
  });

  await test('A04 valid state but redirect_uri mismatch is consumed once', async () => {
    await resetAll();
    const pending = await startAndAuthorize();
    const badUrl = pending.callbackUrl.replace('http://localhost:43262', 'http://127.0.0.1:43262');
    const first = await request(badUrl);
    assertLocationRoot(first, 'A04 redirect mismatch');
    assert.equal(cookieFrom(first.setCookies), null);
    const second = await request(pending.callbackUrl);
    assertLocationRoot(second, 'A04 redirect mismatch replay');
    assert.equal(cookieFrom(second.setCookies), null);
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 0);
    assert.equal(state.counters.putRequests, 0);
  });

  await test('A04 state-valid callback without code: oauth_error, no token/write', async () => {
    await resetAll();
    const pending = await startAndAuthorize();
    const url = new URL(pending.callbackUrl);
    url.searchParams.delete('code');
    const response = await request(url.href);
    assertLocationRoot(response, 'A04 missing code');
    assert.equal(cookieFrom(response.setCookies), null);
    const state = await mockState();
    assert.equal(state.counters.tokenRequests, 0);
    assert.equal(state.counters.putRequests, 0);
  });
}

/* ------------------------------------------------------------------------- */
/* A05: non-author, switch account                                           */
/* ------------------------------------------------------------------------- */

async function probeA05() {
  await test('A05 non-author numeric user id: forbidden terminal, no session/write', async () => {
    await resetAll();
    await control({ user: 'other' });
    const flow = await beginFlow();
    assertLocationRoot(flow.callback, 'A05 callback');
    assertNoCookie(flow, 'A05');
    const session = await sessionAnonymous();
    assert.equal(session.auth?.status, 'forbidden', JSON.stringify(session));
    assert.equal(session.auth?.code, 'forbidden');
    const state = await mockState();
    assert.equal(state.counters.putRequests, 0);
    assert.equal(state.counters.installationTokenRequests, 0);
    await control({ user: 'author' });
  });

  await test('A05 switch account start only adds prompt=select_account (fresh state/PKCE)', async () => {
    await resetAll();
    const start = await request(`${BASE}/auth/github/start?switch=1`);
    assert.equal(start.status, 302);
    const location = start.headers.get('location');
    assert.ok(location, 'authorize location');
    const url = new URL(location);
    assert.equal(url.searchParams.get('prompt'), 'select_account');
    assert.match(url.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{20,128}$/u);
    assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{20,128}$/u);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('allow_signup'), 'false');
    assert.equal(url.searchParams.get('code_verifier'), null);
    assert.doesNotMatch(location, /code_verifier/u);
  });
}

/* ------------------------------------------------------------------------- */
/* A06: permission intersection                                              */
/* ------------------------------------------------------------------------- */

async function probeA06() {
  const cases = [
    ['App not installed', { installation: 'none' }, 'app_not_installed'],
    ['target repository not selected', { installation: 'repo_not_selected' }, 'repo_not_selected'],
    ['Contents read-only', { contents: 'read' }, 'contents_read_only'],
    ['user push=false', { push: false }, 'no_push'],
  ];
  for (const [label, scenario, expectedCode] of cases) {
    await test(`A06 ${label}: permission_denied, no write, no installation token`, async () => {
      await resetAll();
      await control(scenario);
      const flow = await beginFlow();
      assertLocationRoot(flow.callback, `A06 ${label}`);
      assertNoCookie(flow, `A06 ${label}`);
      const session = await sessionAnonymous();
      assert.equal(session.auth?.status, 'permission_denied', JSON.stringify(session));
      assert.equal(session.auth?.code, expectedCode);
      const state = await mockState();
      assert.equal(state.counters.putRequests, 0);
      assert.equal(state.counters.installationTokenRequests, 0);
      await control({ installation: 'default', contents: 'write', push: true });
    });
  }
}

/* ------------------------------------------------------------------------- */
/* A07/A08: valid publish and conflict                                       */
/* ------------------------------------------------------------------------- */

async function probeA07() {
  await test('A07 valid publish: exactly one file/commit, expected bytes and URLs', async () => {
    await resetAll();
    const auth = await authenticate();
    const body = {
      title: '独立测试 中文标题',
      body: 'Hello **independent**\n\n- one\n- two',
      draftId: 'indep-a07-draft',
      attemptId: 'indep-a07-attempt',
    };
    const response = await publish(auth, body);
    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.status, 'committed');
    assert.equal(response.body.duplicate, false);
    assert.equal(response.body.commit.path, `content/blog/2026/独立测试 中文标题-${FIXED_SHANGHAI}.md`);
    assert.match(response.body.commit.sha, /^[0-9a-f]{40}$/u);
    assert.equal(
      response.body.commit.url,
      `https://github.com/ShironeShiyaro/selfpage-publish-test/commit/${response.body.commit.sha}`,
    );
    assert.equal(response.body.deployment.status, 'pending');
    assert.match(
      response.body.markdown,
      /^---\ntitle: 独立测试 中文标题\ndate: 2026-11-23\n---\n\n# 独立测试 中文标题\n\n2026-11-23\n\n---\n\nHello \*\*independent\*\*\n\n- one\n- two\n$/u,
    );
    const state = await mockState();
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.counters.installationTokenRequests, 0);
    assert.equal(state.commits.length, 1);
    assert.equal(state.files.length, 1);
    assert.equal(state.commits[0].path, response.body.commit.path);
    assert.equal(state.commits[0].content, response.body.markdown);
    assert.match(state.commits[0].message, /Draft-ID: indep-a07-draft/u);
    assert.match(state.commits[0].message, /Content-Hash: [0-9a-f]{64}/u);
  });
}

async function probeA08() {
  await test('A08 Chinese filename, date consistency, conflict keeps blob, new timestamp succeeds', async () => {
    await resetAll();
    const auth = await authenticate();
    const title = '中文标题 独立测试';
    const first = await publish(auth, {
      title,
      body: 'Original independent body',
      draftId: 'indep-a08-draft-1',
      attemptId: 'indep-a08-attempt-1',
    });
    assert.equal(first.status, 201, first.text);
    assert.match(first.body.commit.path, /^content\/blog\/2026\/中文标题 独立测试-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.md$/u);
    assert.ok(first.body.commit.path.includes(`-${FIXED_SHANGHAI}.md`));
    assert.equal(first.body.date, '2026-11-23');
    assert.ok(first.body.markdown.includes('date: 2026-11-23'));
    const original = (await mockState()).commits[0];

    const conflict = await publish(auth, {
      title,
      body: 'A different independent body',
      draftId: 'indep-a08-draft-2',
      attemptId: 'indep-a08-attempt-2',
    });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.body.status, 'conflict');
    assert.ok(conflict.body.existing?.url, 'conflict should include existing URL');
    let state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.files[0].content, original.content);
    assert.equal(state.files[0].sha, original.sha);

    const retry = await publish(auth, {
      title,
      body: 'A different independent body',
      draftId: 'indep-a08-draft-2',
      attemptId: 'indep-a08-attempt-3',
      newTimestamp: true,
    });
    assert.equal(retry.status, 201, retry.text);
    assert.ok(retry.body.commit.path.endsWith('-2026-11-23-23-42-16.md'), retry.body.commit.path);
    state = await mockState();
    assert.equal(state.commits.length, 2);
    assert.equal(state.counters.putRequests, 2);
  });
}

/* ------------------------------------------------------------------------- */
/* A09: dedupe, 3h boundary, timeout reconciliation, double click            */
/* ------------------------------------------------------------------------- */

async function probeA09() {
  const body = {
    title: 'A09 去重测试',
    body: 'same content',
    draftId: 'indep-a09-draft',
    attemptId: 'indep-a09-attempt-1',
  };

  await test('A09 same second, different attempt id: one commit, duplicate response', async () => {
    await resetAll();
    const auth = await authenticate();
    const first = await publish(auth, body);
    assert.equal(first.status, 201, first.text);
    const second = await publish(auth, { ...body, attemptId: 'indep-a09-attempt-2' });
    assert.equal(second.status, 200, second.text);
    assert.equal(second.body.status, 'duplicate_ignored');
    assert.equal(second.body.commit.sha, first.body.commit.sha);
    assert.equal(second.body.commit.path, first.body.commit.path);
    const state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1);
  });

  await test('A09 3h boundary: within <3h duplicate, original attempt at 3h duplicate, new attempt at 3h new timestamp', async () => {
    await resetAll();
    const auth = await authenticate();
    const first = await publish(auth, body);
    assert.equal(first.status, 201, first.text);
    await setClock('2026-11-23T18:42:14.999Z'); // 3h - 1 ms
    const almost = await publish(auth, { ...body, attemptId: 'indep-a09-attempt-2' });
    assert.equal(almost.status, 200, almost.text);
    assert.equal(almost.body.commit.sha, first.body.commit.sha);
    await setClock(THREE_HOURS_LATER); // exactly 3h
    const sameAttempt = await publish(auth, body);
    assert.equal(sameAttempt.status, 200, sameAttempt.text);
    assert.equal(sameAttempt.body.commit.sha, first.body.commit.sha);
    const newAttempt = await publish(auth, { ...body, attemptId: 'indep-a09-attempt-3' });
    assert.equal(newAttempt.status, 201, newAttempt.text);
    assert.equal(newAttempt.body.timestamp, '2026-11-24-02-42-15');
    assert.notEqual(newAttempt.body.commit.sha, first.body.commit.sha);
    const state = await mockState();
    assert.equal(state.commits.length, 2);
    assert.equal(state.counters.putRequests, 2);
  });

  await test('A09 PUT applied then response timeout: retry after +10min returns the original commit/path', async () => {
    await resetAll();
    const auth = await authenticate();
    await control({ put: 'apply_timeout' });
    const timedOut = await publish(auth, body);
    assert.equal(timedOut.status, 504, timedOut.text);
    let state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1);
    const originalPath = state.commits[0].path;
    assert.ok(originalPath.endsWith(`-${FIXED_SHANGHAI}.md`), originalPath);
    await setClock('2026-11-23T15:52:15Z'); // +10 min
    await control({ put: 'ok' });
    const retry = await publish(auth, body);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.status, 'duplicate_ignored');
    assert.equal(retry.body.commit.sha, state.commits[0].sha);
    assert.equal(retry.body.commit.path, originalPath);
    assert.equal(retry.body.timestamp, FIXED_SHANGHAI);
    state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1, 'reconciliation must not issue a second PUT');
  });

  await test('A09 PUT response timeout without apply: retry 4h later still uses the first timestamp', async () => {
    await resetAll();
    const auth = await authenticate();
    await control({ put: 'timeout' });
    const started = Date.now();
    const timedOut = await publish(auth, { ...body, draftId: 'indep-a09-timeout-draft' });
    const elapsed = Date.now() - started;
    assert.equal(timedOut.status, 504, timedOut.text);
    assert.ok(elapsed < 20_000, `timeout took ${elapsed}ms`);
    let state = await mockState();
    assert.equal(state.commits.length, 0);
    assert.equal(state.counters.putRequests, 1);
    await setClock('2026-11-23T19:42:15Z'); // +4h
    await control({ put: 'ok' });
    const retry = await publish(auth, { ...body, draftId: 'indep-a09-timeout-draft' });
    assert.equal(retry.status, 201, retry.text);
    assert.equal(retry.body.timestamp, FIXED_SHANGHAI);
    assert.ok(retry.body.commit.path.endsWith(`-${FIXED_SHANGHAI}.md`), retry.body.commit.path);
    state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 2);
  });

  await test('A09 rapid double click: exactly one 201/one duplicate, one PUT/commit', async () => {
    await resetAll();
    const auth = await authenticate();
    const responses = await Promise.all([
      publish(auth, { ...body, draftId: 'indep-a09-double' }),
      publish(auth, { ...body, draftId: 'indep-a09-double' }),
    ]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 201], statuses.join(','));
    const committed = responses.find((response) => response.status === 201);
    const duplicate = responses.find((response) => response.status === 200);
    assert.equal(duplicate.body.commit.sha, committed.body.commit.sha);
    assert.equal(duplicate.body.commit.path, committed.body.commit.path);
    const state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1);
  });

  await test('A09 executor mock put:409 scenario is unimplemented (harness gap, not a product assertion)', async () => {
    await resetAll();
    const auth = await authenticate();
    await control({ put: '409' });
    const response = await publish(auth, {
      title: 'A09 PUT conflict',
      body: 'same body',
      draftId: 'indep-a09-put409',
      attemptId: 'indep-a09-put409-attempt-1',
    });
    // The mock's header comment advertises `put: 409`, but its PUT handler has
    // no 409 branch, so it falls through and succeeds. This is a harness gap:
    // the real Worker branch that reconciles a GitHub PUT 409/422 is not
    // runtime-exercised here and is recorded as LIMITED below.
    assert.equal(response.status, 201, response.text);
    const state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1);
  });
  record(
    'A09 PUT 409/422 reconciliation branch',
    'LIMITED',
    'executor mock declares put:409 but has no 409 branch (falls through to 201); the Worker conflict-reconcile-after-PUT branch is source-reviewed, not runtime-exercised',
  );
  limited += 1;
}

/* ------------------------------------------------------------------------- */
/* A10: 401 / revoked session                                                */
/* ------------------------------------------------------------------------- */

async function probeA10() {
  await test('A10 publish 401 clears the session and rejects the old cookie', async () => {
    await resetAll();
    const auth = await authenticate();
    await control({ put: '401' });
    const response = await publish(auth, validBody({ draftId: 'indep-a10-draft', attemptId: 'indep-a10-attempt' }));
    assert.equal(response.status, 401, response.text);
    assert.match(response.setCookies.join('\n'), /Max-Age=0/u);
    const session = await request(`${BASE}/api/session`, { headers: { cookie: auth.cookie } });
    assert.equal(session.body?.status, 'anonymous');
    const again = await publish(auth, validBody({ draftId: 'indep-a10-draft', attemptId: 'indep-a10-attempt' }));
    assert.equal(again.status, 401);
    const state = await mockState();
    assert.equal(state.commits.length, 0);
    assert.equal(state.counters.putRequests, 1);
    await control({ put: 'ok' });
  });

  await test('A10 server-clock session expiry: 401, cookie cleared, no write', async () => {
    await resetAll();
    const auth = await authenticate();
    // Token/session expires 8h after FIXED; move past it without any write.
    await setClock('2026-11-23T23:50:00Z');
    const response = await publish(auth, validBody({ draftId: 'indep-a10-expiry', attemptId: 'indep-a10-expiry-attempt' }));
    assert.equal(response.status, 401, response.text);
    assert.match(response.setCookies.join('\n'), /Max-Age=0/u);
    const session = await request(`${BASE}/api/session`, { headers: { cookie: auth.cookie } });
    assert.equal(session.body?.status, 'anonymous');
    assert.ok(['expired', 'oauth_error'].includes(session.body?.auth?.status), JSON.stringify(session.body));
    const state = await mockState();
    assert.equal(state.commits.length, 0);
    assert.equal(state.counters.putRequests, 0);
  });
}

/* ------------------------------------------------------------------------- */
/* A11: bounded error terminals                                              */
/* ------------------------------------------------------------------------- */

async function probeA11() {
  await test('A11 500/429/403/timeout reach bounded terminals, one PUT per request, no auto retry', async () => {
    await resetAll();
    const auth = await authenticate();
    const draft = (suffix) => ({
      title: `A11 ${suffix}`,
      body: `body ${suffix}`,
      draftId: `indep-a11-${suffix}`,
      attemptId: `indep-a11-attempt-${suffix}`,
    });

    await control({ put: '500' });
    const serverError = await publish(auth, draft('500'));
    assert.ok([500, 502, 503].includes(serverError.status), String(serverError.status));
    assert.match(serverError.body.error.message, /draft is safe/iu);

    await control({ put: '429' });
    const rateLimited = await publish(auth, draft('429'));
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.headers.get('retry-after'), '30');
    assert.equal(rateLimited.body.retryAfterSeconds, 30);

    await control({ put: '403' });
    const forbidden = await publish(auth, draft('403'));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.status, 'permission_denied');

    await control({ put: 'timeout' });
    const started = Date.now();
    const timedOut = await publish(auth, draft('timeout'));
    const elapsed = Date.now() - started;
    assert.equal(timedOut.status, 504, timedOut.text);
    assert.ok(elapsed < 20_000, `bounded timeout took ${elapsed}ms`);

    const state = await mockState();
    assert.equal(state.commits.length, 0);
    assert.equal(state.counters.putRequests, 4, 'one PUT attempt per request; no blind retry loop');
    await control({ put: 'ok' });
  });
  record(
    'A11 repository 404 branch',
    'LIMITED',
    'the executor mock cannot inject a repo/branch 404 (only 403/429/500/timeout); 404 mapping is source-reviewed, browser-offline is covered by the independent UI probe',
  );
  limited += 1;
}

/* ------------------------------------------------------------------------- */
/* A12: session / CSRF / Origin / logout                                     */
/* ------------------------------------------------------------------------- */

async function probeA12() {
  await test('A12 no session, CSRF and Origin matrix rejected before GitHub write', async () => {
    await resetAll();
    const auth = await authenticate();
    const noSession = await request(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    assert.equal(noSession.status, 401);

    const noCsrf = await request(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json', cookie: auth.cookie },
      body: JSON.stringify(validBody()),
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.error.code, 'security_blocked');

    const wrongCsrf = await publish(auth, validBody(), { 'x-csrf-token': 'x'.repeat(43) });
    assert.equal(wrongCsrf.status, 403);

    const wrongOrigin = await publish(auth, validBody(), { origin: 'https://evil.example' });
    assert.equal(wrongOrigin.status, 403);

    const originNull = await publish(auth, validBody(), { origin: 'null' });
    assert.equal(originNull.status, 403);

    const noOrigin = await request(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      body: JSON.stringify(validBody()),
    });
    assert.equal(noOrigin.status, 403);

    const crossSite = await request(`${BASE}/api/posts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify(validBody()),
    });
    assert.equal(crossSite.status, 403);

    const getPosts = await request(`${BASE}/api/posts`, { headers: { cookie: auth.cookie } });
    assert.equal(getPosts.status, 405);
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  await test('A12 logout requires CSRF+Origin; wrong CSRF keeps the session; correct logout is immediate', async () => {
    await resetAll();
    const auth = await authenticate();
    const wrongCsrf = await request(`${BASE}/api/logout`, {
      method: 'POST',
      headers: {
        origin: BASE,
        'content-type': 'application/json',
        cookie: auth.cookie,
        'x-csrf-token': 'y'.repeat(43),
      },
      body: '{}',
    });
    assert.equal(wrongCsrf.status, 403);
    let session = await request(`${BASE}/api/session`, { headers: { cookie: auth.cookie } });
    assert.equal(session.body?.status, 'authorized', 'wrong CSRF must not revoke');

    const noOrigin = await request(`${BASE}/api/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      body: '{}',
    });
    assert.equal(noOrigin.status, 403);
    session = await request(`${BASE}/api/session`, { headers: { cookie: auth.cookie } });
    assert.equal(session.body?.status, 'authorized', 'missing Origin must not revoke');

    const logout = await request(`${BASE}/api/logout`, {
      method: 'POST',
      headers: {
        origin: BASE,
        'content-type': 'application/json',
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.match(logout.setCookies.join('\n'), /Max-Age=0/u);
    const after = await request(`${BASE}/api/session`, { headers: { cookie: auth.cookie } });
    assert.equal(after.body?.status, 'anonymous');
    const publishAfter = await publish(auth, validBody({ draftId: 'indep-a12-draft', attemptId: 'indep-a12-attempt' }));
    assert.equal(publishAfter.status, 401);
    assert.equal((await mockState()).counters.putRequests, 0);
  });
}

/* ------------------------------------------------------------------------- */
/* A13: paths, fields, title/body limits                                     */
/* ------------------------------------------------------------------------- */

function invalidCases() {
  const base = {
    title: 'A13 invalid',
    body: 'valid body',
    draftId: 'indep-a13-draft',
    attemptId: 'indep-a13-attempt',
  };
  return [
    ['unknown path/author/committer/branch/sha/date fields', {
      ...base,
      path: '../.github/workflows/pwn.yml',
      author: 'evil',
      committer: 'evil',
      branch: 'evil',
      sha: 'deadbeef',
      date: '2026-01-01',
    }],
    ['content root outside via path field', { ...base, path: 'content/home/resume.md' }],
    ['traversal title', { ...base, title: '../.github/workflows/pwn.yml' }],
    ['absolute path title', { ...base, title: '/etc/passwd' }],
    ['backslash title', { ...base, title: '..\\pwn' }],
    ['encoded slash', { ...base, title: '..%2f.github' }],
    ['encoded backslash', { ...base, title: '..%5c.github' }],
    ['encoded NUL', { ...base, title: 'a%00b' }],
    ['encoded dot-dot', { ...base, title: '%2e%2e%2fpwn' }],
    ['double encoded slash', { ...base, title: '%252f%252e%252e' }],
    ['raw NUL in title', { ...base, title: 'a\u0000b' }],
    ['raw newline in title', { ...base, title: 'a\nb' }],
    ['61 code points', { ...base, title: 'a'.repeat(61) }],
    ['236 UTF-8 bytes', { ...base, title: '😀'.repeat(59) }],
    ['body 256 KiB + 1', { ...base, body: 'a'.repeat(256 * 1024 + 1) }],
    ['missing title type', { ...base, title: 42 }],
    ['missing body', { ...base, body: '' }],
    ['invalid draft id', { ...base, draftId: 'bad id!' }],
    ['invalid attempt id', { ...base, attemptId: '' }],
    ['non-boolean newTimestamp', { ...base, newTimestamp: 'yes' }],
  ];
}

async function probeA13() {
  const cases = invalidCases();
  let cursor = 0;
  let group = 0;
  while (cursor < cases.length) {
    group += 1;
    const groupCases = cases.slice(cursor, cursor + 6);
    await test(`A13 invalid inputs group ${group}: rejected before any GitHub write`, async () => {
      await resetAll();
      const auth = await authenticate();
      for (const [label, body] of groupCases) {
        const response = await publish(auth, body);
        assert.ok([400, 413, 422].includes(response.status), `${label}: status ${response.status} ${response.text.slice(0, 300)}`);
        if (response.status !== 413) {
          assert.ok(
            ['validation_error', 'invalid_request'].includes(response.body?.status),
            `${label}: ${JSON.stringify(response.body).slice(0, 300)}`,
          );
        }
      }
      assert.equal((await mockState()).counters.putRequests, 0, `after group ${group}`);
    });
    cursor += 6;
  }

  await test('A13 declared/actual oversized body is rejected with 413/422 before GitHub', async () => {
    await resetAll();
    const auth = await authenticate();
    const huge = await publish(auth, {
      title: 'A13 oversized',
      body: 'x'.repeat(600 * 1024 + 1),
      draftId: 'indep-a13-huge',
      attemptId: 'indep-a13-huge-attempt',
    });
    assert.ok([413, 422].includes(huge.status), `status ${huge.status}`);
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  await test('A13 legal boundaries: 60 code points, exactly 232 UTF-8 bytes, exactly 256 KiB body', async () => {
    await resetAll();
    let auth = await authenticate();
    const sixty = await publish(auth, {
      title: 'a'.repeat(60),
      body: 'boundary 60',
      draftId: 'indep-a13-60cp',
      attemptId: 'indep-a13-60cp-attempt',
    });
    assert.equal(sixty.status, 201, sixty.text);

    await resetAll();
    auth = await authenticate();
    const emoji = '😀'.repeat(58); // 232 UTF-8 bytes, 58 code points
    const bytes232 = await publish(auth, {
      title: emoji,
      body: 'boundary 232 bytes',
      draftId: 'indep-a13-232b',
      attemptId: 'indep-a13-232b-attempt',
    });
    assert.equal(bytes232.status, 201, bytes232.text);
    assert.equal(Buffer.byteLength(bytes232.body.commit.fileName, 'utf8'), 255);

    await resetAll();
    auth = await authenticate();
    const body256 = await publish(auth, {
      title: 'A13 body boundary',
      body: 'a'.repeat(256 * 1024),
      draftId: 'indep-a13-256k',
      attemptId: 'indep-a13-256k-attempt',
    });
    assert.equal(body256.status, 201, body256.text);
    assert.ok(body256.body.markdown.length > 256 * 1024);
  });
}

/* ------------------------------------------------------------------------- */
/* A14: cookie / logout / fixed DO / serial publish                          */
/* ------------------------------------------------------------------------- */

function sourceEvidence(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

async function probeA14() {
  await test('A14 session cookie attributes and immediate logout invalidation', async () => {
    await resetAll();
    const flow = await beginFlow();
    assert.ok(flow.cookie, 'session cookie');
    const raw = flow.callback.setCookies.join('\n');
    assert.match(raw, /HttpOnly/u);
    assert.match(raw, /Secure/u);
    assert.match(raw, /SameSite=Lax/u);
    assert.match(raw, /Path=\//u);
    assert.doesNotMatch(raw, /Domain=/iu);
    assert.doesNotMatch(raw, /Max-Age|Expires=/iu);
    assert.match(flow.cookie.value, /^[A-Za-z0-9_-]{20,128}$/u);

    const session = await request(`${BASE}/api/session`, { headers: { cookie: flow.cookie.header } });
    assert.equal(session.body?.status, 'authorized');
    const logout = await request(`${BASE}/api/logout`, {
      method: 'POST',
      headers: {
        origin: BASE,
        'content-type': 'application/json',
        cookie: flow.cookie.header,
        'x-csrf-token': session.body.csrfToken,
      },
      body: '{}',
    });
    assert.equal(logout.status, 200);
    assert.match(logout.setCookies.join('\n'), /Max-Age=0/u);
    const after = await request(`${BASE}/api/session`, { headers: { cookie: flow.cookie.header } });
    assert.equal(after.body?.status, 'anonymous');
  });

  await test('A14 fixed single SQLite DO and synchronous consume/revoke evidence', async () => {
    const index = sourceEvidence('apps/author/worker/index.ts');
    const store = sourceEvidence('apps/author/worker/author-store.ts');
    const wrangler = sourceEvidence('apps/author/wrangler.jsonc');
    assert.match(index, /idFromName\('selfpage-author'\)/u);
    assert.match(wrangler, /new_sqlite_classes/u);
    assert.match(wrangler, /"class_name": "AuthorStore"/u);
    assert.match(store, /blockConcurrencyWhile/u);
    assert.match(store, /enqueue</u);
    assert.match(store, /UPDATE oauth_tx SET consumed = 1/u);
    assert.match(store, /UPDATE sessions SET revoked = 1/u);
    assert.match(store, /CREATE TABLE IF NOT EXISTS publishes/u);
  });

  await test('A14 five concurrent publishes of one draft create one commit', async () => {
    await resetAll();
    const auth = await authenticate();
    const body = {
      title: 'A14 concurrency',
      body: 'one serialized publish',
      draftId: 'indep-a14-concurrent',
      attemptId: 'indep-a14-concurrent-attempt',
    };
    const responses = await Promise.all(Array.from({ length: 5 }, () => publish(auth, body)));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(responses.filter((response) => response.status === 200).length, 4);
    const state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1);
  });

  record(
    'A14 cross-colo callback consistency',
    'LIMITED',
    'local single Miniflare process cannot exercise multiple colos; fixed single DO name/SQLite architecture and local serial behaviour verified only',
  );
  limited += 1;
}

/* ------------------------------------------------------------------------- */
/* A15/A16: secret surfaces and open redirect                                */
/* ------------------------------------------------------------------------- */

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

async function probeA15A16() {
  await test('A15 API JSON, mock commit and built author bundle contain no secrets', async () => {
    const haystacks = [...SEEN_BODIES];
    const state = await mockState();
    haystacks.push(JSON.stringify(state.commits));
    haystacks.push(JSON.stringify(state.files));
    const distDir = join(ROOT, 'apps', 'author', 'dist', 'client');
    const distFiles = walkFiles(distDir);
    for (const file of distFiles) {
      const text = readFileSync(file, 'utf8');
      haystacks.push(text);
    }
    const findings = [];
    for (const [index, text] of haystacks.entries()) {
      const match = SECRET_PATTERN.exec(text);
      if (match) {
        findings.push({ surface: index < SEEN_BODIES.length ? 'api-or-mock' : 'built-asset', match: match[0] });
      }
    }
    assert.deepEqual(findings, [], JSON.stringify(findings));
    assert.ok(distFiles.length > 0, 'author build is missing');
  });

  await test('A15 configured test secrets never appear in API responses or mock state', async () => {
    const state = await mockState();
    const haystack = `${SEEN_BODIES.join('\n')}\n${JSON.stringify(state.commits)}\n${JSON.stringify(state.files)}`;
    for (const secret of SECRETS) {
      assert.equal(haystack.includes(secret), false, 'configured secret leaked to a visible surface');
    }
  });

  await test('A16 callback Location is only "/", return_to ignored, referrer-policy no-referrer', async () => {
    await resetAll();
    const start = await request(`${BASE}/auth/github/start?return_to=${encodeURIComponent('https://evil.example/pwn')}`);
    assert.equal(start.status, 302);
    assert.equal(start.headers.get('referrer-policy'), 'no-referrer');
    const authorizeUrl = start.headers.get('location');
    assert.doesNotMatch(authorizeUrl, /return_to|evil\.example/iu);
    const authorize = await request(authorizeUrl);
    assert.equal(authorize.status, 302);
    const callbackUrl = authorize.headers.get('location');
    const tampered = `${callbackUrl}&return_to=${encodeURIComponent('//evil.example/pwn')}`;
    const callback = await request(tampered);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/');
    assert.doesNotMatch(callback.headers.get('location') ?? '', /evil|return_to|code=|state=|error=/iu);
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    const session = await request(`${BASE}/api/session`, { headers: { cookie: cookieFrom(callback.setCookies)?.header ?? '' } });
    assert.equal(session.body?.status, 'authorized');
  });

  await test('A16 authorize URL carries state + S256 challenge but never the verifier', async () => {
    await resetAll();
    const start = await request(`${BASE}/auth/github/start`);
    const url = new URL(start.headers.get('location'));
    assert.ok((url.searchParams.get('state') ?? '').length >= 20);
    assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 20);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.has('code_verifier'), false);
    assert.equal(url.searchParams.has('verifier'), false);
  });
}

/* ------------------------------------------------------------------------- */
/* A17: rate limits, headers, CSP, no CORS, bounded timeout                  */
/* ------------------------------------------------------------------------- */

async function probeA17() {
  await test('A17 start rate limit 10/10min returns 429 + Retry-After', async () => {
    await resetAll();
    const statuses = [];
    let limitedResponse = null;
    for (let index = 0; index < 11; index += 1) {
      const response = await request(`${BASE}/auth/github/start`);
      statuses.push(response.status);
      if (response.status === 429) {
        limitedResponse = response;
      }
    }
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(302));
    assert.equal(statuses[10], 429, statuses.join(','));
    assert.ok(limitedResponse.headers.get('retry-after'), 'Retry-After missing');
    assert.ok(Number(limitedResponse.body.retryAfterSeconds) > 0);
  });

  await test('A17 publish rate limit 8/5min/session returns 429 + Retry-After', async () => {
    await resetAll();
    const auth = await authenticate();
    const statuses = [];
    let limitedResponse = null;
    for (let index = 0; index < 9; index += 1) {
      const response = await publish(auth, {
        title: '',
        body: '',
        draftId: `indep-a17-${index}`,
        attemptId: `indep-a17-attempt-${index}`,
      });
      statuses.push(response.status);
      if (response.status === 429) {
        limitedResponse = response;
      }
    }
    assert.equal(statuses.at(-1), 429, statuses.join(','));
    assert.ok(limitedResponse.headers.get('retry-after'));
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  await test('A17 deployment rate limit 30/5min/IP returns 429 + Retry-After', async () => {
    await resetAll();
    const sha = 'a'.repeat(40);
    const statuses = [];
    let limitedResponse = null;
    for (let index = 0; index < 31; index += 1) {
      const response = await request(`${BASE}/api/deployments/${sha}`);
      statuses.push(response.status);
      if (response.status === 429) {
        limitedResponse = response;
      }
    }
    assert.equal(statuses.slice(0, 30).every((status) => status === 200), true, statuses.join(','));
    assert.equal(statuses[30], 429, statuses.join(','));
    assert.ok(limitedResponse.headers.get('retry-after'));
  });

  await test('A17 security headers, CSP and no CORS on API/HTML/OPTIONS', async () => {
    await resetAll();
    const health = await request(`${BASE}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('access-control-allow-origin'), null);

    const session = await request(`${BASE}/api/session`);
    assert.equal(session.headers.get('access-control-allow-origin'), null);
    assert.equal(session.headers.get('x-content-type-options'), 'nosniff');

    const options = await request(`${BASE}/api/posts`, { method: 'OPTIONS' });
    assert.equal(options.headers.get('access-control-allow-origin'), null);

    const shell = await request(`${BASE}/`);
    assert.equal(shell.status, 200);
    const csp = shell.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/u);
    assert.match(csp, /script-src 'self'/u);
    assert.match(csp, /style-src 'self' 'unsafe-inline'/u);
    assert.match(csp, /object-src 'none'/u);
    assert.match(csp, /base-uri 'none'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.doesNotMatch(csp, /unsafe-eval/u);
    assert.match(shell.text, /<script[^>]+src=/u);
  });
}

/* ------------------------------------------------------------------------- */
/* A19: deployment status branches, no polling                               */
/* ------------------------------------------------------------------------- */

async function probeA19() {
  await test('A19 publish always reports pending first and does not auto-check Actions', async () => {
    await resetAll();
    const auth = await authenticate();
    await control({ actions: 'success' });
    const response = await publish(auth, {
      title: 'A19 deployment',
      body: 'deployment branch check',
      draftId: 'indep-a19-draft',
      attemptId: 'indep-a19-attempt',
    });
    assert.equal(response.status, 201, response.text);
    assert.equal(response.body.deployment.status, 'pending');
    await sleep(2_000);
    const state = await mockState();
    assert.equal(state.counters.actionsRequests, 0, 'no automatic Actions request after publish');
    assert.equal(state.counters.putRequests, 1);
    const sha = response.body.commit.sha;

    const cases = [
      ['none', 'pending'],
      ['pending', 'pending'],
      ['success', 'deployed'],
      ['failure', 'failed'],
      ['cancelled', 'failed'],
      ['403', 'unconfirmed'],
      ['429', 'unconfirmed'],
      ['500', 'unconfirmed'],
    ];
    for (const [scenario, expected] of cases) {
      await control({ actions: scenario });
      const deployment = await request(`${BASE}/api/deployments/${sha}`);
      assert.equal(deployment.status, 200, scenario);
      assert.equal(deployment.body.status, expected, `${scenario}: ${JSON.stringify(deployment.body)}`);
      assert.ok(deployment.body.actionsUrl.includes('/actions'));
      assert.ok(deployment.body.commitUrl.includes(sha));
      assert.ok(deployment.body.checkedAt);
    }

    await control({ actions: 'timeout' });
    const started = Date.now();
    const timeout = await request(`${BASE}/api/deployments/${sha}`);
    const elapsed = Date.now() - started;
    assert.equal(timeout.body.status, 'unconfirmed');
    assert.ok(elapsed < 15_000, `deployment timeout took ${elapsed}ms`);

    await control({ actions: 'none' });
    const stateAfter = await mockState();
    assert.equal(stateAfter.counters.putRequests, 1, 'deployment checks must not republish');
  });
}

/* ------------------------------------------------------------------------- */
/* Production-mode isolation                                                  */
/* ------------------------------------------------------------------------- */

async function probeProduction() {
  await test('production-mode Worker: mock/test routes 404, real routes unconfigured, no CORS', async () => {
    const mock = await request(`${PROD}/api/mock/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(mock.status, 404);
    const clock = await request(`${PROD}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: FIXED }),
    });
    assert.equal(clock.status, 404);
    const session = await request(`${PROD}/api/session`);
    assert.equal(session.status, 404);
    assert.equal(session.headers.get('access-control-allow-origin'), null);
  });
}

/* ------------------------------------------------------------------------- */
/* Main                                                                       */
/* ------------------------------------------------------------------------- */

async function main() {
  const startedAt = new Date().toISOString();
  await probeProduction();
  await probeA03();
  await probeA04();
  await probeA05();
  await probeA06();
  await probeA07();
  await probeA08();
  await probeA09();
  await probeA10();
  await probeA11();
  await probeA12();
  await probeA13();
  await probeA14();
  await probeA15A16();
  await probeA17();
  await probeA19();

  const report = {
    status: failures === 0 ? 'PASS' : 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    total: RESULTS.length,
    passed: RESULTS.length - failures,
    failed: failures,
    limited,
    results: RESULTS,
    surfacesScanned: {
      apiBodies: SEEN_BODIES.length,
      headers: SEEN_HEADERS.length,
      authorDistFiles: walkFiles(join(ROOT, 'apps', 'author', 'dist', 'client')).length,
    },
  };
  if (REPORT !== '') {
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`\nindependent HTTP: ${report.passed}/${report.total} passed, ${failures} failed, ${limited} limited\n`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
