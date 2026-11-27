#!/usr/bin/env node
/**
 * Independent focused retest for the task 07 fix round.
 *
 * Covers:
 * - P1-1 observability invocation-log configuration (static);
 * - P1-2 `/` and `/new/` security headers + SPA shell + assets on both Workers;
 * - P2a mock PUT 409 is real and the Worker reconciles without a second PUT;
 * - P1-3 deployment aggregation through the real HTTP route;
 * - P1-4 real Tier 2 repository guard wiring (static; unit tests separately);
 * - 45s publish budget coverage (static + one applied-PUT timeout retry).
 *
 * It never reads `.dev.vars` and never prints tokens/cookies.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.AUTHOR_GITHUB_TEST_BASE ?? 'http://localhost:43262';
const PROD = process.env.AUTHOR_GITHUB_PROD_BASE ?? 'http://localhost:43263';
const MOCK = process.env.AUTHOR_MOCK_BASE ?? 'http://127.0.0.1:43261';
const ROOT = process.env.INDEP_REPO_ROOT ?? process.cwd();
const REPORT = process.env.INDEP_FOCUS_HTTP_REPORT ?? '';
const FIXED = '2026-11-23T15:42:15Z';
const FIXED_SHANGHAI = '2026-11-23-23-42-15';
const OFFICIAL_INVOCATION_DOC =
  'https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs';

const RESULTS = [];
let failures = 0;
let limited = 0;
let observations = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, status, detail = '') {
  RESULTS.push({ name, status, detail });
  if (status === 'FAIL') {
    failures += 1;
    process.stdout.write(`FAIL ${name}${detail ? `: ${detail}` : ''}\n`);
  } else {
    process.stdout.write(`${status === 'LIMITED' ? 'lim  ' : status === 'P2' ? 'p2   ' : 'ok   '}${name}${detail ? `: ${detail}` : ''}\n`);
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

function recordLimited(name, detail) {
  record(name, 'LIMITED', detail);
  limited += 1;
}

function recordP2(name, detail) {
  record(name, 'P2', detail);
  observations += 1;
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

async function setClock(now) {
  const response = await request(`${BASE}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now }),
  });
  assert.equal(response.status, 200, `clock ${response.status}`);
}

async function resetAll() {
  const worker = await request(`${BASE}/api/test/reset`, { method: 'POST' });
  assert.equal(worker.status, 200, `worker reset ${worker.status}`);
  const mock = await request(`${MOCK}/__mock/reset`, { method: 'POST' });
  assert.equal(mock.status, 200, `mock reset ${mock.status}`);
  await setClock(FIXED);
}

async function control(scenario) {
  const response = await request(`${MOCK}/__mock/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  assert.equal(response.status, 200, `control ${response.status}`);
}

async function mockState() {
  const response = await request(`${MOCK}/__mock/state`);
  assert.equal(response.status, 200);
  return response.body;
}

function cookieFrom(setCookies) {
  for (const value of setCookies) {
    const match = /(?:^|,\s*)sp_session=([A-Za-z0-9_-]+)/u.exec(value);
    if (match) return { header: `sp_session=${match[1]}` };
  }
  return null;
}

async function authenticate() {
  const start = await request(`${BASE}/auth/github/start`);
  assert.equal(start.status, 302);
  const authorize = await request(start.headers.get('location'));
  const callback = await request(authorize.headers.get('location'));
  const cookie = cookieFrom(callback.setCookies);
  assert.ok(cookie, 'session cookie');
  const session = await request(`${BASE}/api/session`, { headers: { cookie: cookie.header } });
  assert.equal(session.body?.status, 'authorized');
  return { cookie: cookie.header, csrf: session.body.csrfToken };
}

async function publish(auth, body) {
  return request(`${BASE}/api/posts`, {
    method: 'POST',
    headers: {
      origin: BASE,
      'content-type': 'application/json',
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
    },
    body: JSON.stringify(body),
  });
}

function assertHeaders(response, label) {
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/u, `${label} default-src`);
  assert.match(csp, /script-src 'self'/u, `${label} script-src`);
  assert.match(csp, /frame-ancestors 'none'/u, `${label} frame-ancestors`);
  assert.equal(response.headers.get('x-frame-options'), 'DENY', `${label} x-frame-options`);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer', `${label} referrer-policy`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff', `${label} nosniff`);
  assert.equal(response.headers.get('access-control-allow-origin'), null, `${label} ACAO`);
}

function staticChecks() {
  const wrangler = JSON.parse(readFileSync(join(ROOT, 'apps', 'author', 'wrangler.jsonc'), 'utf8'));
  assert.equal(wrangler.observability?.enabled, true);
  assert.equal(wrangler.observability?.logs?.invocation_logs, false);
  assert.ok(wrangler.assets.run_worker_first.includes('/new'));
  assert.ok(wrangler.assets.run_worker_first.includes('/new/*'));

  const real = readFileSync(join(ROOT, 'tests', 'real-github-e2e.mjs'), 'utf8');
  const guard = real.indexOf('assertDedicatedTestRepository(');
  const form = real.indexOf("getByTestId('post-title').evaluate");
  const publish = real.indexOf("getByTestId('publish-button').click");
  assert.ok(guard > 0 && form > guard && publish > guard, 'guard must precede form/publish');

  const store = readFileSync(join(ROOT, 'apps', 'author', 'worker', 'author-store.ts'), 'utf8');
  const deadline = store.indexOf('const deadlineAt = Date.now() + PUBLISH_DEADLINE_MS;');
  const enqueue = store.indexOf('this.enqueue(() =>', deadline);
  assert.ok(store.includes('const PUBLISH_DEADLINE_MS = 45_000;'));
  assert.ok(deadline > 0 && enqueue > deadline, 'deadline must start before queueing');
  assert.ok(store.includes('this.publishTransaction(config, session, input, contentHash, now, deadlineAt)'));
  assert.ok(store.includes('githubCallTimeout(deadlineAt, 8_000)'));
  assert.ok(store.includes('githubCallTimeout(deadlineAt, 12_000)'));
  assert.ok(store.includes('private publishTimeoutResponse(): Response'));
  assert.ok(store.includes("status: 'timeout'"));
  assert.ok(store.includes('if (deadlineRemainingMs(deadlineAt) <= 0)'));
  return { officialInvocationDoc: OFFICIAL_INVOCATION_DOC };
}

async function main() {
  const startedAt = new Date().toISOString();
  const staticResult = { officialInvocationDoc: OFFICIAL_INVOCATION_DOC };

  await test('P1-1 observability: enabled, invocation_logs=false, /new in run_worker_first', async () => {
    staticResult.checks = staticChecks();
  });

  await test('P1-2 / and /new/ on test+production Workers: SPA shell, CSP, anti-framing, no CORS', async () => {
    const assets = new Set();
    for (const [label, base] of [['test', BASE], ['production', PROD]]) {
      for (const path of ['/', '/new/']) {
        const response = await request(`${base}${path}`);
        assert.equal(response.status, 200, `${label} ${path} status`);
        assert.match(response.headers.get('content-type') ?? '', /text\/html/u, `${label} ${path} content-type`);
        assertHeaders(response, `${label} ${path}`);
        assert.match(response.text, /<div id="root">/u, `${label} ${path} SPA root`);
        assert.match(response.text, /<script[^>]+src=/u, `${label} ${path} script`);
        for (const match of response.text.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/gu)) {
          assets.add(match[1]);
        }
      }
    }
    assert.ok(assets.size >= 2, `expected JS+CSS assets, found ${assets.size}`);
    for (const [label, base] of [['test', BASE], ['production', PROD]]) {
      for (const asset of assets) {
        const response = await request(`${base}${asset}`);
        assert.equal(response.status, 200, `${label} ${asset} status`);
        assert.match(
          response.headers.get('content-type') ?? '',
          /(javascript|css)/u,
          `${label} ${asset} content-type`,
        );
        assert.equal(response.headers.get('access-control-allow-origin'), null, `${label} ${asset} ACAO`);
      }
    }
    staticResult.newEntryAssetCount = assets.size;
  });

  await test('P2a mock PUT 409 is real and the Worker reconciles without a second PUT', async () => {
    await resetAll();
    const auth = await authenticate();
    await control({ put: '409' });
    const body = {
      title: 'Focused PUT 409',
      body: 'The mock applies the commit and returns 409; the Worker must reconcile.',
      draftId: 'focus-put409-draft',
      attemptId: 'focus-put409-attempt',
    };
    const first = await publish(auth, body);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.status, 'duplicate_ignored');
    assert.equal(first.body.duplicate, true);
    let state = await mockState();
    assert.equal(state.counters.putRequests, 1);
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0].sha, first.body.commit.sha);
    assert.equal(state.commits[0].content, first.body.markdown);
    const putLogs = state.log.filter((entry) => entry.method === 'PUT');
    assert.equal(putLogs.length, 1);
    assert.equal(putLogs[0].status, 409, 'mock must actually return 409');

    const retry = await publish(auth, body);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.status, 'duplicate_ignored');
    assert.equal(retry.body.commit.sha, first.body.commit.sha);
    state = await mockState();
    assert.equal(state.counters.putRequests, 1, 'retry must reconcile, not PUT again');
    assert.equal(state.commits.length, 1);
  });

  await test('P1-3 deployment aggregation through real route', async () => {
    await resetAll();
    const sha = 'e'.repeat(40);
    const cases = [
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
    ];
    for (const [scenario, expected] of cases) {
      await control({ actions: scenario });
      const response = await request(`${BASE}/api/deployments/${sha}`);
      assert.equal(response.status, 200, scenario);
      assert.equal(response.body.status, expected, `${scenario}: ${JSON.stringify(response.body)}`);
      assert.ok(response.body.actionsUrl.includes('/actions'));
      assert.ok(response.body.commitUrl.includes(sha));
    }
    staticResult.deploymentCases = cases.length;
    recordP2(
      'P1-3 residual: failure + success on the same SHA -> deployed',
      'The fix intentionally lets any success win; a failed deploy plus an unrelated successful workflow on the same SHA is still reported deployed. Executor acknowledged this remaining P2.',
    );
  });

  await test('P1-4 real Tier 2 guard is wired before form and Publish (static)', async () => {
    // Re-run the same static assertions in this report; the independent Vitest
    // guard test exercises the guard behaviour itself.
    staticChecks();
  });

  await test('45s budget: per-call timeout + applied-PUT retry reconciles the original commit', async () => {
    await resetAll();
    const auth = await authenticate();
    await control({ put: 'apply_timeout' });
    const body = {
      title: 'Focused budget timeout',
      body: 'Applied then timed out; retry must reconcile the original commit.',
      draftId: 'focus-budget-draft',
      attemptId: 'focus-budget-attempt',
    };
    const started = Date.now();
    const timedOut = await publish(auth, body);
    const elapsed = Date.now() - started;
    assert.equal(timedOut.status, 504, timedOut.text);
    assert.ok(elapsed < 20_000, `per-call timeout took ${elapsed}ms`);
    let state = await mockState();
    assert.equal(state.commits.length, 1);
    assert.equal(state.counters.putRequests, 1);
    const originalPath = state.commits[0].path;
    assert.ok(originalPath.endsWith(`-${FIXED_SHANGHAI}.md`), originalPath);
    await setClock('2026-11-23T15:52:15Z');
    await control({ put: 'ok' });
    const retry = await publish(auth, body);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.body.status, 'duplicate_ignored');
    assert.equal(retry.body.commit.sha, state.commits[0].sha);
    assert.equal(retry.body.commit.path, originalPath);
    assert.equal(retry.body.timestamp, FIXED_SHANGHAI);
    state = await mockState();
    assert.equal(state.counters.putRequests, 1, 'reconciliation must not replay the PUT');
    assert.equal(state.commits.length, 1);
  });

  recordLimited(
    '45s overall publish budget end-to-end',
    'static coverage verified (deadline starts before queue, caps GET/PUT/commits/reconcile, 504 timeout, pending retry reconciles first); a real 45s wall-clock E2E was not run, so the overall budget is LIMITED. Per-call 12s timeout and applied-PUT retry were exercised above.',
  );

  const report = {
    status: failures === 0 ? 'PASS' : 'FAIL',
    startedAt,
    finishedAt: new Date().toISOString(),
    total: RESULTS.length,
    failed: failures,
    limited,
    observations,
    officialDocs: { invocationLogs: OFFICIAL_INVOCATION_DOC },
    static: staticResult,
    results: RESULTS,
  };
  if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nfocused HTTP: ${RESULTS.length} results, ${failures} failed, ${limited} limited, ${observations} observations\n`);
  if (failures > 0) process.exitCode = 1;
}

await main();
