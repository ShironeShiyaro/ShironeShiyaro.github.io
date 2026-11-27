#!/usr/bin/env node
/**
 * Test-only mock GitHub API + OAuth server for task 07.
 *
 * It is a plain Node HTTP server (no dependencies). It never prints or returns
 * tokens to the browser-facing Worker; `/__mock/state` exposes only test
 * bookkeeping (files, commits, counters, method+path log) and is used by the
 * integration runner.
 *
 * Scenario switches are set through `/__mock/control`:
 *   authorize: approve | deny
 *   user: author | other
 *   installation: default | none | repo_not_selected
 *   contents: write | read
 *   push: true | false
 *   exchange: ok | bad_verifier
 *   get: ok | 403 | 429 | 500
 *   put: ok | 401 | 403 | 429 | 500 | 409 | branch_protected | 422_existing |
 *        timeout | apply_timeout
 *   actions: none | pending | success | failure | cancelled | mixed | rerun |
 *            serial | unrelated-failure | all-failed | skipped | unknown |
 *            success-running | 403 | 429 | 500 | timeout
 */
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORT = Number(process.env.MOCK_GITHUB_PORT ?? 43261);
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const APP_ID = 5919244;
const INSTALLATION_ID = 9001;
const USER_ID = 315736688;
const OTHER_USER_ID = 315736689;
const REPO_ID = 1471620960;
const OWNER = 'ShironeShiyaro';
const REPO = 'selfpage-publish-test';
const BRANCH = 'main';

const DEFAULT_SCENARIO = {
  authorize: 'approve',
  user: 'author',
  installation: 'default',
  contents: 'write',
  push: true,
  exchange: 'ok',
  get: 'ok',
  put: 'ok',
  actions: 'none',
};

let scenario = { ...DEFAULT_SCENARIO };
let codes = new Map();
let tokens = new Map();
/** path -> { content, commitSha, blobSha } */
let files = new Map();
/** newest first */
let commits = [];
let counters = { putRequests: 0, tokenRequests: 0, installationTokenRequests: 0, actionsRequests: 0, contentsRequests: 0 };
let requestLog = [];

function reset() {
  scenario = { ...DEFAULT_SCENARIO };
  codes = new Map();
  tokens = new Map();
  files = new Map();
  commits = [];
  counters = { putRequests: 0, tokenRequests: 0, installationTokenRequests: 0, actionsRequests: 0, contentsRequests: 0 };
  requestLog = [];
}

function log(method, pathname, status) {
  if (requestLog.length < 500) {
    // Never log query strings: they contain OAuth code/state in this mock.
    requestLog.push({ method, path: pathname, status });
  }
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenFrom(req) {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/u.exec(header);
  if (!match) {
    return null;
  }
  return tokens.get(match[1]) ?? null;
}

function randomSha() {
  return randomBytes(20).toString('hex');
}

function blobSha(content) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
}

function commitMessage(input) {
  return input;
}

function userForScenario() {
  return scenario.user === 'other'
    ? { login: 'stranger', id: OTHER_USER_ID }
    : { login: 'mock-author', id: USER_ID };
}

function repoPayload() {
  return {
    id: REPO_ID,
    name: REPO,
    full_name: `${OWNER}/${REPO}`,
    owner: { login: OWNER },
    default_branch: BRANCH,
    private: false,
    permissions: {
      admin: false,
      maintain: false,
      push: scenario.push === true,
      triage: false,
      pull: true,
    },
  };
}

function installationPayload() {
  return {
    id: INSTALLATION_ID,
    app_id: APP_ID,
    account: { login: OWNER, id: 1 },
    permissions: { contents: scenario.contents === 'read' ? 'read' : 'write', metadata: 'read' },
    suspended_at: null,
  };
}

function encodeContentsPath(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function addCommit({ path, content, message, authorDate }) {
  const sha = randomSha();
  const commit = {
    sha,
    path,
    content,
    message,
    date: authorDate ?? new Date().toISOString(),
    html_url: `https://github.com/${OWNER}/${REPO}/commit/${sha}`,
  };
  commits.unshift(commit);
  files.set(path, { content, commitSha: sha, blobSha: blobSha(content) });
  return commit;
}

function contentsGetPayload(path) {
  const file = files.get(path);
  if (!file) {
    return null;
  }
  return {
    type: 'file',
    encoding: 'base64',
    size: Buffer.byteLength(file.content),
    name: path.split('/').at(-1),
    path,
    sha: file.blobSha,
    content: Buffer.from(file.content, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n'),
    html_url: `https://github.com/${OWNER}/${REPO}/blob/${BRANCH}/${encodeContentsPath(path)}`,
  };
}

function hold(res) {
  const timer = setTimeout(() => {
    if (!res.writableEnded) {
      json(res, 504, { message: 'mock timeout' });
    }
  }, 25_000);
  timer.unref();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const pathname = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (method === 'POST' && pathname === '/__mock/reset') {
      reset();
      log(method, pathname, 200);
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/__mock/control') {
      const body = JSON.parse((await readBody(req)) || '{}');
      scenario = { ...scenario, ...(body.scenario ?? {}) };
      log(method, pathname, 200);
      return json(res, 200, { ok: true, scenario });
    }
    if (method === 'POST' && pathname === '/__mock/seed') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.path !== 'string' || typeof body.content !== 'string') {
        return json(res, 400, { error: 'invalid_seed' });
      }
      const commit = addCommit({
        path: body.path,
        content: body.content,
        message: typeof body.message === 'string' ? body.message : 'Seed file',
      });
      log(method, pathname, 201);
      return json(res, 201, { ok: true, sha: commit.sha });
    }
    if (method === 'GET' && pathname === '/__mock/state') {
      return json(res, 200, {
        scenario,
        files: [...files.entries()].map(([path, file]) => ({ path, content: file.content, sha: file.commitSha })),
        commits,
        counters,
        log: requestLog,
      });
    }

    if (pathname === '/login/oauth/authorize' && method === 'GET') {
      if (url.searchParams.get('client_id') !== CLIENT_ID) {
        log(method, pathname, 400);
        return json(res, 400, { error: 'invalid_client' });
      }
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const challengeMethod = url.searchParams.get('code_challenge_method') ?? '';
      if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+\/auth\/github\/callback$/u.test(redirectUri)) {
        log(method, pathname, 400);
        return json(res, 400, { error: 'bad_redirect' });
      }
      if (!/^[A-Za-z0-9_-]{20,128}$/u.test(state) || !/^[A-Za-z0-9_-]{20,128}$/u.test(challenge) || challengeMethod !== 'S256') {
        log(method, pathname, 400);
        return json(res, 400, { error: 'bad_pkce_or_state' });
      }
      if (scenario.authorize === 'deny') {
        log(method, pathname, 302);
        redirect(res, `${redirectUri}?error=access_denied&error_description=cancelled&state=${encodeURIComponent(state)}`);
        return;
      }
      const code = randomBytes(24).toString('hex');
      codes.set(code, { redirectUri, challenge, used: false });
      log(method, pathname, 302);
      redirect(res, `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
      return;
    }

    if (pathname === '/login/oauth/access_token' && method === 'POST') {
      counters.tokenRequests += 1;
      const body = new URLSearchParams(await readBody(req));
      if (body.get('client_id') !== CLIENT_ID || body.get('client_secret') !== CLIENT_SECRET) {
        log(method, pathname, 401);
        return json(res, 200, { error: 'incorrect_client_credentials' });
      }
      const code = body.get('code') ?? '';
      const record = codes.get(code);
      if (!record || record.used) {
        log(method, pathname, 200);
        return json(res, 200, { error: 'bad_verification_code' });
      }
      record.used = true;
      if (body.get('redirect_uri') !== record.redirectUri) {
        log(method, pathname, 200);
        return json(res, 200, { error: 'redirect_uri_mismatch' });
      }
      const verifier = body.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (scenario.exchange !== 'ok' || challenge !== record.challenge) {
        log(method, pathname, 200);
        return json(res, 200, { error: 'bad_verification_code' });
      }
      const token = `ghu_mock_${randomBytes(20).toString('hex')}`;
      tokens.set(token, userForScenario());
      log(method, pathname, 200);
      return json(res, 200, {
        access_token: token,
        expires_in: 28_800,
        refresh_token: `ghr_mock_${randomBytes(20).toString('hex')}`,
        refresh_token_expires_in: 15_897_600,
        token_type: 'bearer',
        scope: '',
      });
    }

    const user = tokenFrom(req);

    if (pathname === '/user' && method === 'GET') {
      if (!user) {
        log(method, pathname, 401);
        return json(res, 401, { message: 'Bad credentials' });
      }
      log(method, pathname, 200);
      return json(res, 200, user);
    }

    if (pathname === '/user/installations' && method === 'GET') {
      if (!user) {
        log(method, pathname, 401);
        return json(res, 401, { message: 'Bad credentials' });
      }
      log(method, pathname, 200);
      return json(res, 200, {
        total_count: scenario.installation === 'none' ? 0 : 1,
        installations: scenario.installation === 'none' ? [] : [installationPayload()],
      });
    }

    const installationRepos = /^\/user\/installations\/(\d+)\/repositories$/u.exec(pathname);
    if (installationRepos && method === 'GET') {
      if (!user) {
        log(method, pathname, 401);
        return json(res, 401, { message: 'Bad credentials' });
      }
      const installed = scenario.installation !== 'none' && scenario.installation !== 'repo_not_selected';
      log(method, pathname, 200);
      return json(res, 200, {
        total_count: installed ? 1 : 0,
        repositories: installed ? [repoPayload()] : [],
      });
    }

    if (/^\/app\/installations\/\d+\/access_tokens$/u.test(pathname)) {
      counters.installationTokenRequests += 1;
      log(method, pathname, 403);
      return json(res, 403, { message: 'installation tokens are not used by this test' });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)$/u.exec(pathname);
    if (repoMatch && method === 'GET') {
      if (!user) {
        log(method, pathname, 401);
        return json(res, 401, { message: 'Bad credentials' });
      }
      log(method, pathname, 200);
      return json(res, 200, repoPayload());
    }

    const contentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/u.exec(pathname);
    if (contentsMatch && method === 'GET') {
      counters.contentsRequests += 1;
      if (scenario.get === '500') {
        log(method, pathname, 500);
        return json(res, 500, { message: 'mock failure' });
      }
      if (scenario.get === '403') {
        log(method, pathname, 403);
        return json(res, 403, { message: 'mock forbidden' });
      }
      if (scenario.get === '429') {
        log(method, pathname, 429);
        return json(res, 429, { message: 'mock rate limit' }, { 'retry-after': '30', 'x-ratelimit-remaining': '0' });
      }
      const path = contentsMatch[3]
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      const payload = contentsGetPayload(path);
      log(method, pathname, payload ? 200 : 404);
      if (!payload) {
        return json(res, 404, { message: 'Not Found' });
      }
      return json(res, 200, payload);
    }

    if (contentsMatch && method === 'PUT') {
      counters.putRequests += 1;
      if (!user) {
        log(method, pathname, 401);
        return json(res, 401, { message: 'Bad credentials' });
      }
      if (scenario.put === '401') {
        log(method, pathname, 401);
        return json(res, 401, { message: 'Bad credentials' });
      }
      if (scenario.put === '403') {
        log(method, pathname, 403);
        return json(res, 403, { message: 'mock forbidden' });
      }
      if (scenario.put === '429') {
        log(method, pathname, 429);
        return json(res, 429, { message: 'mock rate limit' }, { 'retry-after': '30', 'x-ratelimit-remaining': '0' });
      }
      if (scenario.put === '500') {
        log(method, pathname, 500);
        return json(res, 500, { message: 'mock failure' });
      }
      if (scenario.put === 'timeout') {
        log(method, pathname, 0);
        return hold(res);
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const path = contentsMatch[3]
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      if (typeof body.message !== 'string' || typeof body.content !== 'string' || body.branch !== BRANCH) {
        log(method, pathname, 422);
        return json(res, 422, { message: 'invalid contents body' });
      }
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      if (scenario.put === 'branch_protected') {
        // Real GitHub answers 422 "protected branch hook declined" for a
        // protected branch and does not create the file. No commit is added.
        log(method, pathname, 422);
        return json(res, 422, {
          message: 'protected branch hook declined',
          documentation_url: 'https://docs.github.com/rest/branches/branch-protection',
        });
      }
      if (scenario.put === '422_existing') {
        // The Worker's pre-write GET saw no file, but a concurrent writer landed
        // the path before this PUT; GitHub then answers 422 ("sha wasn't
        // supplied"). The Worker must re-read and report a conflict, never
        // overwrite the file that is actually there.
        if (!files.has(path)) {
          addCommit({
            path,
            content: 'Concurrent existing body',
            message: 'Concurrent writer',
            authorDate: new Date().toISOString(),
          });
        }
        log(method, pathname, 422);
        return json(res, 422, { message: 'sha wasn\u2019t supplied' });
      }
      if (scenario.put === '409') {
        // Simulate a concurrent writer applying this exact commit while the
        // API still answers 409 (e.g. a retried request after the first write).
        // The Worker must reconcile the existing file/commit instead of
        // reporting a false conflict or replaying the PUT.
        addCommit({
          path,
          content,
          message: commitMessage(body.message),
          authorDate: new Date().toISOString(),
        });
        log(method, pathname, 409);
        return json(res, 409, { message: 'sha wasn\u2019t supplied' });
      }
      if (files.has(path)) {
        log(method, pathname, 422);
        return json(res, 422, { message: 'sha wasn\u2019t supplied' });
      }
      const commit = addCommit({
        path,
        content,
        message: commitMessage(body.message),
        authorDate: new Date().toISOString(),
      });
      log(method, pathname, 201);
      if (scenario.put === 'apply_timeout') {
        return hold(res);
      }
      return json(res, 201, {
        content: contentsGetPayload(path),
        commit: {
          sha: commit.sha,
          html_url: commit.html_url,
          message: commit.message,
        },
      });
    }

    const commitsMatch = /^\/repos\/([^/]+)\/([^/]+)\/commits$/u.exec(pathname);
    if (commitsMatch && method === 'GET') {
      const path = url.searchParams.get('path') ?? '';
      const list = commits
        .filter((commit) => commit.path === path)
        .map((commit) => ({
          sha: commit.sha,
          html_url: commit.html_url,
          commit: {
            message: commit.message,
            committer: { date: commit.date },
            author: { date: commit.date },
          },
        }));
      log(method, pathname, 200);
      return json(res, 200, list);
    }

    const actionsMatch = /^\/repos\/([^/]+)\/([^/]+)\/actions\/runs$/u.exec(pathname);
    if (actionsMatch && method === 'GET') {
      counters.actionsRequests += 1;
      const headSha = url.searchParams.get('head_sha') ?? '';
      let nextRunId = 1;
      const run = (status, conclusion, workflow = 'pages') => ({
        id: nextRunId++,
        head_sha: headSha,
        status,
        conclusion,
        name: workflow === 'pages' ? 'Deploy to GitHub Pages' : 'Lint',
        path: `.github/workflows/${workflow}.yml`,
        html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${nextRunId - 1}`,
      });
      if (scenario.actions === '403') {
        log(method, pathname, 403);
        return json(res, 403, { message: 'mock forbidden' });
      }
      if (scenario.actions === '429') {
        log(method, pathname, 429);
        return json(res, 429, { message: 'mock rate limit' }, { 'retry-after': '30' });
      }
      if (scenario.actions === '500') {
        log(method, pathname, 500);
        return json(res, 500, { message: 'mock failure' });
      }
      if (scenario.actions === 'timeout') {
        log(method, pathname, 0);
        return hold(res);
      }
      const runs =
        scenario.actions === 'none'
          ? []
          : scenario.actions === 'pending'
            ? [run('in_progress', null)]
            : scenario.actions === 'success'
              ? [run('completed', 'success')]
              : scenario.actions === 'failure'
                ? [run('completed', 'failure')]
                : scenario.actions === 'cancelled'
                  ? [run('completed', 'cancelled')]
                  : scenario.actions === 'mixed'
                    ? [run('completed', 'failure', 'lint'), run('completed', 'success')]
                    : scenario.actions === 'rerun'
                      ? [run('completed', 'failure'), run('completed', 'success')]
                      : scenario.actions === 'serial'
                        ? [run('completed', 'failure'), run('in_progress', null)]
                        : scenario.actions === 'unrelated-failure'
                          ? [run('completed', 'failure', 'lint'), run('completed', 'success')]
                          : scenario.actions === 'all-failed'
                            ? [run('completed', 'failure'), run('completed', 'cancelled', 'lint')]
                            : scenario.actions === 'skipped'
                              ? [run('completed', 'skipped')]
                              : scenario.actions === 'unknown'
                                ? [run('completed', null)]
                                : scenario.actions === 'success-running'
                                  ? [run('completed', 'success'), run('in_progress', null, 'lint')]
                                  : [];
      log(method, pathname, 200);
      return json(res, 200, { total_count: runs.length, workflow_runs: runs });
    }

    log(method, pathname, 404);
    return json(res, 404, { message: 'mock route not found' });
  } catch (error) {
    log(method, pathname, 500);
    return json(res, 500, { message: 'mock server error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[mock-github] listening on http://127.0.0.1:${PORT}\n`);
});

function shutdown() {
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
