/**
 * Independent focused retest for P1-3: deployment status aggregation.
 *
 * This file is written by the independent tester and exercises the real
 * `checkDeployments` export through a fake Actions endpoint. It does not use
 * the executor's `deployment-status.test.ts` assertions.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDeployments, type DeploymentResult } from '../../../apps/author/worker/github.ts';
import { resolveGitHubConfig, type AuthorWorkerEnv } from '../../../apps/author/worker/env.ts';

interface FakeRun {
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  name?: string;
  path?: string;
}

let server: Server;
let apiBase = '';
let runs: FakeRun[] = [];
let httpStatus = 200;
let requests = 0;

function env(): AuthorWorkerEnv {
  return {
    ASSETS: { fetch: async () => new Response('') },
    APP_ENV: 'test',
    GITHUB_API_BASE: apiBase,
    GITHUB_OAUTH_BASE: apiBase,
    SESSION_SECRET: 't'.repeat(48),
    TOKEN_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(9)).toString('base64'),
    GITHUB_APP_CLIENT_ID: 'Iv23liFocusedTest',
    GITHUB_APP_CLIENT_SECRET: 'focused-test-secret-value',
    GITHUB_APP_ID: '5919244',
    GITHUB_ALLOWED_USER_ID: '315736688',
    GITHUB_ALLOWED_REPO_ID: '1471620960',
    GITHUB_REPO_OWNER: 'ShironeShiyaro',
    GITHUB_REPO_NAME: 'selfpage-publish-test',
    GITHUB_REPO_BRANCH: 'main',
    GITHUB_CONTENT_ROOT: 'content/blog',
  };
}

async function check(nextRuns: FakeRun[], status = 200): Promise<DeploymentResult> {
  runs = nextRuns;
  httpStatus = status;
  const resolved = resolveGitHubConfig(env());
  if (!resolved.ok) throw new Error(JSON.stringify(resolved));
  return checkDeployments(resolved.config, 'd'.repeat(40));
}

function run(
  conclusion: string | null,
  workflow = 'pages',
  status = 'completed',
): FakeRun {
  const id = Math.random().toString(36).slice(2, 8);
  return {
    status,
    conclusion,
    name: workflow === 'pages' ? 'Deploy to GitHub Pages' : 'Lint',
    path: `.github/workflows/${workflow}.yml`,
    html_url: `https://github.com/ShironeShiyaro/selfpage-publish-test/actions/runs/${workflow}-${id}`,
  };
}

beforeAll(async () => {
  server = createServer((_request, response) => {
    requests += 1;
    if (httpStatus !== 200) {
      response.writeHead(httpStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'focused mock error' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake server has no port');
  apiBase = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  runs = [];
  httpStatus = 200;
  requests = 0;
});

describe('independent deployment aggregation', () => {
  it('any still-running run keeps pending, including after a success', async () => {
    for (const active of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const result = await check([run('success'), run(null, 'lint', active)]);
      expect(result.status, active).toBe('pending');
    }
    expect(requests).toBeGreaterThan(0);
  });

  it('a success anywhere is deployed when nothing is running', async () => {
    const result = await check([run('failure', 'lint'), run('success', 'pages')]);
    expect(result).toMatchObject({ ok: true, status: 'deployed', conclusion: 'success' });
    if (result.ok) expect(result.runUrl).toContain('/actions/runs/pages-');
  });

  it('acknowledged remaining P2: failure plus an unrelated success is still deployed', async () => {
    // The fix intentionally treats any success as success; the independent
    // tester records this as a residual P2, not a new FAIL, because the
    // executor acknowledged it in the fix round.
    const result = await check([run('failure', 'lint'), run('success', 'pages')]);
    expect(result.status).toBe('deployed');
  });

  it('failed only when every run is terminal, one explicitly failed, and none succeeded', async () => {
    for (const terminal of [
      [run('failure'), run('cancelled', 'lint')],
      [run('failure'), run('skipped', 'lint')],
      [run('failure'), run('neutral', 'lint')],
      [run('timed_out'), run('failure', 'pages')],
    ]) {
      const result = await check(terminal);
      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/not live/u);
    }
  });

  it('skipped/neutral/unknown/incomplete runs are unconfirmed, never failed', async () => {
    for (const conclusion of ['skipped', 'neutral', 'stale', 'timed_out', 'action_required']) {
      const result = await check([run(conclusion)]);
      expect(result.status, conclusion).toBe('unconfirmed');
      expect(result.message).toMatch(/could not be confirmed/u);
    }
    const unknown = await check([run(null)]);
    expect(unknown.status).toBe('unconfirmed');
    const mixed = await check([run('failure'), run(null, 'lint', 'completed')]);
    expect(mixed.status).toBe('unconfirmed');
  });

  it('no runs is pending (not started), not failed', async () => {
    const result = await check([]);
    expect(result).toMatchObject({ ok: true, status: 'pending' });
  });

  it('Actions permission/rate/server errors are unconfirmed', async () => {
    for (const status of [403, 429, 500]) {
      const result = await check([run('success')], status);
      expect(result.status, String(status)).toBe('unconfirmed');
      expect(result.message).toMatch(/could not be confirmed/u);
    }
  });
});
