#!/usr/bin/env node
/**
 * Task 07 Tier 1 integration assertions against the real Worker routes + real
 * Durable Object, with the local mock GitHub server. Run by
 * `tests/run-author-github-e2e.mjs`; not part of `npm test`.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const BASE = process.env.AUTHOR_GITHUB_TEST_BASE ?? 'http://localhost:43262';
const PROD = process.env.AUTHOR_GITHUB_PROD_BASE ?? 'http://localhost:43263';
const MOCK = process.env.AUTHOR_MOCK_BASE ?? 'http://127.0.0.1:43261';
const FIXED = '2026-11-23T15:42:15Z';
const DRAFT = 'draft-07-integration-0001';
const ATTEMPT = 'attempt-07-integration-0001';
const SECRET_PATTERN = /ghu_|ghr_|client_secret|access_token|code_verifier|oauth_state/i;

const results = [];
const visibleBodies = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
  if (!ok) {
    failures += 1;
    process.stdout.write(`FAIL ${name}${detail ? `: ${detail}` : ''}\n`);
  } else {
    process.stdout.write(`ok   ${name}\n`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

async function request(url, init = {}) {
  const response = await fetch(url, { redirect: 'manual', ...init });
  const text = await response.text();
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    text,
    setCookies: response.headers.getSetCookie?.() ?? [],
  };
}

async function resetAll() {
  const resetWorker = await request(`${BASE}/api/test/reset`, { method: 'POST' });
  assert.equal(resetWorker.status, 200, `worker reset ${resetWorker.status}`);
  const resetMock = await request(`${MOCK}/__mock/reset`, { method: 'POST' });
  assert.equal(resetMock.status, 200, `mock reset ${resetMock.status}`);
  const clock = await request(`${BASE}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now: FIXED }),
  });
  assert.equal(clock.status, 200, `clock ${clock.status}`);
}

async function control(scenario) {
  const response = await request(`${MOCK}/__mock/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  assert.equal(response.status, 200);
}

async function mockState() {
  const response = await request(`${MOCK}/__mock/state`);
  assert.equal(response.status, 200);
  return response.body;
}

function cookieFrom(setCookies) {
  for (const value of setCookies) {
    const match = /(?:^|,\s*)sp_session=([A-Za-z0-9_-]+)/u.exec(value);
    if (match) {
      return { value: match[1], header: `sp_session=${match[1]}` };
    }
  }
  return null;
}

async function beginFlow() {
  const start = await request(`${BASE}/auth/github/start`);
  assert.equal(start.status, 302, `start ${start.status}: ${start.text}`);
  const authorizeUrl = start.headers.get('location');
  assert.ok(authorizeUrl, 'authorize location');
  const authorize = await request(authorizeUrl);
  const callbackUrl = authorize.headers.get('location');
  assert.ok(callbackUrl, 'callback location');
  const callback = await request(callbackUrl);
  const cookie = cookieFrom(callback.setCookies);
  return { start, authorizeUrl, authorize, callbackUrl, callback, cookie };
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
  assert.equal(session.body?.status, 'authorized', JSON.stringify(session.body));
  visibleBodies.push(session.text);
  return {
    cookie: flow.cookie.header,
    session: session.body,
    csrf: session.body.csrfToken,
    flow,
  };
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
    title: '中文标题 发布测试',
    body: 'Hello **world**\n\n- one\n- two',
    draftId: DRAFT,
    attemptId: ATTEMPT,
    ...overrides,
  };
}

async function main() {
  await resetAll();

  await test('production Worker: mock surface and test clock are 404', async () => {
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

  await test('publish without a session is rejected before GitHub', async () => {
    const response = await request(`${BASE}/api/posts`, {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify(validBody()),
    });
    assert.equal(response.status, 401);
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  let auth;
  await test('OAuth start/callback creates a host-only HttpOnly Secure Lax session', async () => {
    auth = await authenticate();
    const setCookie = auth.flow.callback.setCookies.join('\n');
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /Secure/u);
    assert.match(setCookie, /SameSite=Lax/u);
    assert.match(setCookie, /Path=\//u);
    assert.doesNotMatch(setCookie, /Domain=/iu);
    assert.equal(auth.flow.start.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(auth.flow.callback.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(auth.flow.callback.headers.get('location'), '/');
    assert.doesNotMatch(auth.flow.callback.headers.get('location') ?? '', /[?&](code|state|error)=/u);
    assert.match(auth.session.user.login, /^mock-author$/u);
    assert.equal(auth.session.repo.id, 1471620960);
  });

  await test('callback ignores return_to and cannot open-redirect', async () => {
    const start = await request(`${BASE}/auth/github/start`);
    const authorize = await request(start.headers.get('location'));
    const callbackUrl = authorize.headers.get('location');
    const tampered = callbackUrl.replace(
      '/auth/github/callback?',
      '/auth/github/callback?return_to=https%3A%2F%2Fevil.example&',
    );
    const callback = await request(tampered);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), '/');
  });

  await test('bad/replayed state never exchanges a code or creates a session', async () => {
    const before = (await mockState()).counters.tokenRequests;
    const flow = await beginFlow();
    const bad = await request(`${BASE}/auth/github/callback?state=${'A'.repeat(43)}&code=deadbeef`);
    assert.equal(bad.status, 302);
    assert.equal(bad.headers.get('location'), '/');
    assert.equal(cookieFrom(bad.setCookies), null);
    const replay = await request(flow.callbackUrl);
    assert.equal(replay.status, 302);
    assert.equal(replay.headers.get('location'), '/');
    assert.equal(cookieFrom(replay.setCookies), null);
    const after = (await mockState()).counters.tokenRequests;
    assert.equal(after, before + 1, 'only the initial flow may exchange a code');
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  await test('a wrong PKCE verifier fails without a session or commit', async () => {
    await control({ exchange: 'bad_verifier' });
    const flow = await beginFlow();
    assert.equal(flow.callback.status, 302);
    assert.equal(cookieFrom(flow.callback.setCookies), null);
    const session = await request(`${BASE}/api/session`);
    assert.equal(session.status, 200);
    assert.equal(session.body?.status, 'anonymous');
    assert.ok(['oauth_error', 'state_invalid'].includes(session.body?.auth?.status));
    assert.equal((await mockState()).counters.putRequests, 0);
    await control({ exchange: 'ok' });
  });

  await test('a non-author numeric user id is forbidden and gets no session', async () => {
    await control({ user: 'other' });
    const flow = await beginFlow();
    assert.equal(cookieFrom(flow.callback.setCookies), null);
    const session = await request(`${BASE}/api/session`);
    assert.equal(session.body?.status, 'anonymous');
    assert.equal(session.body?.auth?.status, 'forbidden');
    assert.equal((await mockState()).counters.putRequests, 0);
    await control({ user: 'author' });
  });

  for (const [label, scenario, expectedCode] of [
    ['App not installed', { installation: 'none' }, 'app_not_installed'],
    ['repository not selected', { installation: 'repo_not_selected' }, 'repo_not_selected'],
    ['Contents read-only', { contents: 'read' }, 'contents_read_only'],
    ['user push=false', { push: false }, 'no_push'],
  ]) {
    await test(`${label}: permission terminal, no write, no installation token`, async () => {
      await control(scenario);
      const flow = await beginFlow();
      assert.equal(cookieFrom(flow.callback.setCookies), null);
      const session = await request(`${BASE}/api/session`);
      assert.equal(session.body?.status, 'anonymous');
      assert.equal(session.body?.auth?.status, 'permission_denied');
      assert.equal(session.body?.auth?.code, expectedCode);
      const state = await mockState();
      assert.equal(state.counters.putRequests, 0);
      assert.equal(state.counters.installationTokenRequests, 0);
      await control({ installation: 'default', contents: 'write', push: true });
    });
  }

  await test('first publish creates exactly one file/commit with the expected bytes', async () => {
    await resetAll();
    auth = await authenticate();
    const response = await publish(auth, validBody());
    assert.equal(response.status, 201, response.text);
    visibleBodies.push(response.text);
    const body = response.body;
    assert.equal(body.status, 'committed');
    assert.equal(body.duplicate, false);
    assert.equal(
      body.commit.path,
      'content/blog/2026/中文标题 发布测试-2026-11-23-23-42-15.md',
    );
    assert.match(body.commit.sha, /^[0-9a-f]{40}$/u);
    assert.equal(body.commit.url, `https://github.com/ShironeShiyaro/selfpage-publish-test/commit/${body.commit.sha}`);
    assert.equal(body.deployment.status, 'pending');
    assert.match(body.markdown, /^---\ntitle: 中文标题 发布测试\ndate: 2026-11-23\n---\n\n# 中文标题 发布测试\n\n2026-11-23\n\n---\n\nHello \*\*world\*\*\n\n- one\n- two\n$/u);
    const state = await mockState();
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0].path, body.commit.path);
    assert.equal(state.commits[0].content, body.markdown);
    assert.match(state.commits[0].message, new RegExp(`Draft-ID: ${DRAFT}`, 'u'));
    assert.match(state.commits[0].message, /Content-Hash: [0-9a-f]{64}/u);
  });

  await test('same draft+content in the same second is a duplicate (no second commit)', async () => {
    const first = await publish(auth, validBody());
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'duplicate_ignored');
    assert.equal(first.body.duplicate, true);
    assert.equal((await mockState()).commits.length, 1);
  });

  await test('inside three hours returns the original commit; same attempt at 3h is still a retry', async () => {
    await request(`${BASE}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: '2026-11-23T18:42:14.999Z' }),
    });
    const almost = await publish(auth, validBody());
    assert.equal(almost.body.status, 'duplicate_ignored');
    await request(`${BASE}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ now: '2026-11-23T18:42:15Z' }),
    });
    const sameAttempt = await publish(auth, validBody());
    assert.equal(sameAttempt.body.status, 'duplicate_ignored');
    assert.equal((await mockState()).commits.length, 1);
  });

  await test('a new explicit attempt after three hours creates a new timestamped article', async () => {
    const later = await publish(auth, validBody({ attemptId: 'attempt-07-after-3h' }));
    assert.equal(later.status, 201, later.text);
    assert.equal(later.body.status, 'committed');
    assert.equal(later.body.timestamp, '2026-11-24-02-42-15');
    assert.equal((await mockState()).commits.length, 2);
  });

  await test('different content at the same path conflicts and never overwrites', async () => {
    await resetAll();
    auth = await authenticate();
    const first = await publish(auth, { ...validBody(), title: 'Conflict title', body: 'Original body' });
    assert.equal(first.status, 201);
    const conflict = await publish(auth, {
      ...validBody(),
      title: 'Conflict title',
      body: 'Different body',
      attemptId: 'attempt-conflict',
    });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.body.status, 'conflict');
    assert.ok(conflict.body.existing?.url);
    const state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0].content, first.body.markdown);
    assert.equal(state.counters.putRequests, 1);
  });

  await test('explicit new-timestamp retry shifts to the next free second', async () => {
    const retry = await publish(auth, {
      ...validBody(),
      title: 'Conflict title',
      body: 'Different body',
      attemptId: 'attempt-conflict-new-time',
      newTimestamp: true,
    });
    assert.equal(retry.status, 201, retry.text);
    assert.match(retry.body.commit.path, /Conflict title-2026-11-23-23-42-16\.md$/u);
    assert.equal((await mockState()).commits.length, 2);
  });

  await test('PUT 422 protected branch: dedicated terminal, no existing file link and no replay', async () => {
    await resetAll();
    auth = await authenticate();
    await control({ put: 'branch_protected' });
    const response = await publish(auth, {
      ...validBody(),
      title: 'Protected branch post',
      draftId: 'draft-branch-protected-0001',
      attemptId: 'attempt-branch-protected-0001',
    });
    assert.equal(response.status, 422, response.text);
    assert.equal(response.body.status, 'branch_protected');
    assert.equal(response.body.error.code, 'branch_protected');
    assert.match(response.body.error.message, /protected branch/iu);
    assert.match(response.body.error.message, /direct writes?/iu);
    assert.match(response.body.error.message, /not allowed/iu);
    assert.doesNotMatch(response.body.error.message, /already exists|existing file/iu);
    assert.equal(response.body.existing, undefined);
    assert.equal(
      response.body.reviewUrl,
      'https://github.com/ShironeShiyaro/selfpage-publish-test/settings/branches',
    );
    let state = await mockState();
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.counters.installationTokenRequests, 0);
    assert.equal(state.commits.length, 0);
    assert.equal(state.files.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    state = await mockState();
    assert.equal(state.counters.putRequests, 1, 'no automatic PUT retry after branch protection');
    assert.equal(state.commits.length, 0);
    await control({ put: 'ok' });
  });

  await test('PUT 422 with a file that really exists stays a conflict and never overwrites it', async () => {
    await resetAll();
    auth = await authenticate();
    await control({ put: '422_existing' });
    const response = await publish(auth, {
      ...validBody(),
      title: '422 existing post',
      draftId: 'draft-422-existing-0001',
      attemptId: 'attempt-422-existing-0001',
    });
    assert.equal(response.status, 409, response.text);
    assert.equal(response.body.status, 'conflict');
    assert.equal(response.body.error.code, 'conflict');
    assert.ok(response.body.existing?.url, 'conflict keeps a link to the real file');
    assert.match(response.body.existing.url, /\/blob\/main\/content\/blog\//u);
    const state = await mockState();
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0].content, 'Concurrent existing body');
    await control({ put: 'ok' });
  });

  await test('PUT applied then timed out: the retry reconciles the same commit', async () => {
    await resetAll();
    auth = await authenticate();
    await control({ put: 'apply_timeout' });
    const timedOut = await publish(auth, {
      ...validBody(),
      title: 'Timeout reconcile',
      draftId: 'draft-timeout-0001',
      attemptId: 'attempt-timeout-0001',
    });
    assert.equal(timedOut.status, 504, timedOut.text);
    assert.equal((await mockState()).commits.length, 1);
    await control({ put: 'ok' });
    const retry = await publish(auth, {
      ...validBody(),
      title: 'Timeout reconcile',
      draftId: 'draft-timeout-0001',
      attemptId: 'attempt-timeout-0001',
    });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.status, 'duplicate_ignored');
    assert.equal(retry.body.commit.sha, (await mockState()).commits[0].sha);
    assert.equal((await mockState()).commits.length, 1);
  });

  await test('PUT 409 after the commit landed: reconcile returns the original commit and never replays the PUT', async () => {
    await resetAll();
    auth = await authenticate();
    await control({ put: '409' });
    const first = await publish(auth, {
      ...validBody(),
      title: 'Conflict reconcile',
      draftId: 'draft-put-409-0001',
      attemptId: 'attempt-put-409-0001',
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.status, 'duplicate_ignored');
    let state = await mockState();
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.commits.length, 1);
    assert.equal(first.body.commit.sha, state.commits[0].sha);
    assert.equal(first.body.commit.path, state.commits[0].path);
    assert.equal(state.commits[0].content, first.body.markdown);

    const retry = await publish(auth, {
      ...validBody(),
      title: 'Conflict reconcile',
      draftId: 'draft-put-409-0001',
      attemptId: 'attempt-put-409-0001',
    });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.status, 'duplicate_ignored');
    assert.equal(retry.body.commit.sha, first.body.commit.sha);
    state = await mockState();
    assert.equal(state.counters.putRequests, 1, 'the retry must reconcile, not PUT again');
    assert.equal(state.commits.length, 1);
    await control({ put: 'ok' });
  });

  await test('GitHub 429 reaches 429 + Retry-After with no commit', async () => {
    await resetAll();
    auth = await authenticate();
    await control({ put: '429' });
    const response = await publish(auth, validBody());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '30');
    assert.equal(response.body.retryAfterSeconds, 30);
    assert.equal((await mockState()).commits.length, 0);
    await control({ put: 'ok' });
  });

  await test('GitHub 500 reaches a bounded server error with draft-safe copy', async () => {
    await control({ put: '500' });
    const response = await publish(auth, validBody());
    assert.ok([500, 502, 503].includes(response.status), String(response.status));
    assert.match(response.body.error.message, /draft is safe/iu);
    assert.equal((await mockState()).commits.length, 0);
    await control({ put: 'ok' });
  });

  await test('GitHub 401 clears the session and rejects the old cookie', async () => {
    await control({ put: '401' });
    const response = await publish(auth, validBody());
    assert.equal(response.status, 401);
    const session = await request(`${BASE}/api/session`, { headers: { cookie: auth.cookie } });
    assert.equal(session.body?.status, 'anonymous');
    const again = await publish(auth, validBody());
    assert.equal(again.status, 401);
    await control({ put: 'ok' });
  });

  await test('logout revokes the session immediately; the old cookie cannot publish', async () => {
    await resetAll();
    auth = await authenticate();
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
    const session = await request(`${BASE}/api/session`, { headers: { cookie: auth.cookie } });
    assert.equal(session.body?.status, 'anonymous');
    const response = await publish(auth, validBody());
    assert.equal(response.status, 401);
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  await test('missing CSRF, wrong Origin and missing Origin are rejected before GitHub', async () => {
    await resetAll();
    auth = await authenticate();
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
    const noOrigin = await request(`${BASE}/api/posts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
      body: JSON.stringify(validBody()),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  await test('invalid input and path smuggling are rejected before any GitHub write', async () => {
    await resetAll();
    auth = await authenticate();
    const cases = [
      ['unknown path/author fields', { ...validBody(), path: '../.github/workflows/pwn.yml', author: 'evil' }],
      ['traversal title', validBody({ title: '../.github/workflows/pwn.yml' })],
      ['backslash title', validBody({ title: '..\\pwn' })],
      ['encoded separator', validBody({ title: '..%2f.github' })],
      ['61 code points', validBody({ title: 'a'.repeat(61) })],
      ['over 232 safe bytes', validBody({ title: '😀'.repeat(59) })],
      ['over 256 KiB body', validBody({ body: 'x'.repeat(256 * 1024 + 1) })],
      ['extra H1 in body', validBody({ body: '# Second H1' })],
      ['H1 inside a fence is allowed', validBody({ title: 'Fence ok', body: '```\n# literal\n```' })],
    ];
    for (const [label, body] of cases) {
      const response = await publish(auth, body);
      if (label === 'H1 inside a fence is allowed') {
        assert.equal(response.status, 201, label);
      } else {
        assert.ok([400, 422].includes(response.status), `${label}: ${response.status}`);
        assert.equal(response.body.status, 'validation_error', label);
      }
    }
    const state = await mockState();
    // Only the fence-ok publish reached GitHub.
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.commits.length, 1);
  });

  await test('deployment status: pending/success/failure/cancelled and unconfirmed paths', async () => {
    const commitSha = (await mockState()).commits[0].sha;
    for (const [scenario, expected] of [
      ['none', 'pending'],
      ['pending', 'pending'],
      ['success', 'deployed'],
      ['failure', 'failed'],
      ['cancelled', 'failed'],
      ['mixed', 'deployed'],
      ['rerun', 'deployed'],
      ['unrelated-failure', 'deployed'],
      ['serial', 'pending'],
      ['all-failed', 'failed'],
      ['skipped', 'unconfirmed'],
      ['unknown', 'unconfirmed'],
      ['success-running', 'pending'],
      ['403', 'unconfirmed'],
      ['429', 'unconfirmed'],
      ['500', 'unconfirmed'],
    ]) {
      await control({ actions: scenario });
      const response = await request(`${BASE}/api/deployments/${commitSha}`);
      assert.equal(response.status, 200, scenario);
      assert.equal(response.body.status, expected, `${scenario}: ${JSON.stringify(response.body)}`);
      assert.ok(response.body.actionsUrl.includes('/actions'));
      assert.ok(response.body.commitUrl.includes(commitSha));
    }
    await control({ actions: 'none' });
  });

  await test('invalid deployment SHA is rejected; OPTIONS has no CORS headers', async () => {
    const invalid = await request(`${BASE}/api/deployments/not-a-sha`);
    assert.equal(invalid.status, 400);
    const options = await request(`${BASE}/api/posts`, { method: 'OPTIONS' });
    assert.equal(options.headers.get('access-control-allow-origin'), null);
  });

  await test('write rate limit returns 429 + Retry-After', async () => {
    await resetAll();
    auth = await authenticate();
    let limited = null;
    for (let index = 0; index < 9; index += 1) {
      const response = await publish(auth, validBody({ title: '', body: '' }));
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    assert.ok(limited, 'expected a 429');
    assert.equal(limited.headers.get('retry-after') !== null, true);
    assert.equal((await mockState()).counters.putRequests, 0);
  });

  await test('parallel publishes of the same draft create one commit', async () => {
    await resetAll();
    auth = await authenticate();
    const bodies = Array.from({ length: 5 }, () => validBody());
    const responses = await Promise.all(bodies.map((body) => publish(auth, body)));
    const commits = responses.filter((response) => response.status === 201);
    const duplicates = responses.filter((response) => response.status === 200);
    assert.equal(commits.length + duplicates.length, 5, responses.map((r) => r.status).join(','));
    assert.equal((await mockState()).commits.length, 1);
    assert.equal((await mockState()).counters.putRequests, 1);
  });

  await test('static author shell has CSP/security headers at / and the public /new/ entry, with no CORS', async () => {
    for (const path of ['/', '/new/']) {
      const shell = await request(`${BASE}${path}`);
      assert.equal(shell.status, 200, path);
      assert.match(shell.headers.get('content-type') ?? '', /text\/html/u, path);
      const csp = shell.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/u, path);
      assert.match(csp, /script-src 'self'/u, path);
      assert.match(csp, /frame-ancestors 'none'/u, path);
      assert.equal(shell.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(shell.headers.get('referrer-policy'), 'no-referrer', path);
      assert.equal(shell.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(shell.headers.get('access-control-allow-origin'), null, path);
      assert.match(shell.text, /<div id="root">/u, path);
    }
    const haystack = visibleBodies.join('\n');
    assert.doesNotMatch(haystack, SECRET_PATTERN);
  });

  await request(`${BASE}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true }),
  });

  const report = {
    status: failures === 0 ? 'PASS' : 'FAIL',
    total: results.length,
    passed: results.length - failures,
    failed: failures,
    results,
    finishedAt: new Date().toISOString(),
  };
  if (process.env.AUTHOR_GITHUB_HTTP_REPORT) {
    writeFileSync(process.env.AUTHOR_GITHUB_HTTP_REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`\nHTTP integration: ${report.passed}/${report.total} passed\n`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
