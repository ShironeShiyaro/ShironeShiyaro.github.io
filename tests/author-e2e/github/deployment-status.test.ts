/**
 * Behaviour tests for the public deployment-status source (A19, P1-3).
 *
 * A commit SHA can carry several Actions runs: a failed deploy plus its
 * successful re-run, an unrelated lint workflow, or a re-run that is still in
 * progress. The user must not see "Failed / the post is not live" unless every
 * run is terminal, no run succeeded, and at least one run explicitly failed.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDeployments, type DeploymentResult } from '../../../apps/author/worker/github.ts';
import { resolveGitHubConfig, type AuthorWorkerEnv } from '../../../apps/author/worker/env.ts';

type FakeRun = {
  id?: number;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  name?: string;
  path?: string;
};

let server: Server;
let apiBase = '';
let runs: FakeRun[] = [];
let requestCount = 0;

function configuredEnv(): AuthorWorkerEnv {
  return {
    ASSETS: { fetch: async () => new Response('') },
    APP_ENV: 'test',
    GITHUB_API_BASE: apiBase,
    GITHUB_OAUTH_BASE: apiBase,
    SESSION_SECRET: 's'.repeat(48),
    TOKEN_ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString('base64'),
    GITHUB_APP_CLIENT_ID: 'Iv23liTestClientId',
    GITHUB_APP_CLIENT_SECRET: 'test-client-secret-value',
    GITHUB_APP_ID: '5919244',
    GITHUB_ALLOWED_USER_ID: '315736688',
    GITHUB_ALLOWED_REPO_ID: '1471620960',
    GITHUB_REPO_OWNER: 'ShironeShiyaro',
    GITHUB_REPO_NAME: 'selfpage-publish-test',
    GITHUB_REPO_BRANCH: 'main',
    GITHUB_CONTENT_ROOT: 'content/blog',
  };
}

async function check(workflowRuns: FakeRun[]): Promise<DeploymentResult> {
  runs = workflowRuns;
  const resolved = resolveGitHubConfig(configuredEnv());
  if (!resolved.ok) {
    throw new Error(JSON.stringify(resolved));
  }
  return checkDeployments(resolved.config, 'a'.repeat(40));
}

function run(conclusion: string | null, workflow = 'pages', status = 'completed'): FakeRun {
  return {
    status,
    conclusion,
    name: workflow === 'pages' ? 'Deploy to GitHub Pages' : 'Lint',
    path: `.github/workflows/${workflow}.yml`,
    html_url: `https://github.com/ShironeShiyaro/selfpage-publish-test/actions/runs/${workflow}-${conclusion ?? 'running'}`,
  };
}

beforeAll(async () => {
  server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not expose a TCP address');
  }
  apiBase = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  runs = [];
  requestCount = 0;
});

describe('deployment status aggregation (A19)', () => {
  it('reports deployed when a failed run was re-run successfully', async () => {
    const result = await check([run('failure'), run('success')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('deployed');
      expect(result.conclusion).toBe('success');
      expect(result.runUrl).toContain('/actions/runs/pages-success');
      expect(result.message).toMatch(/completed successfully/u);
    }
    expect(requestCount).toBe(1);
  });

  it('reports deployed when an unrelated workflow failed but the deploy succeeded', async () => {
    const result = await check([run('failure', 'lint'), run('success', 'pages')]);
    expect(result.status).toBe('deployed');
  });

  it('keeps pending when a re-run is still queued or in progress', async () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const result = await check([
        run('failure'),
        { ...run(null, 'pages', status), conclusion: null },
      ]);
      expect(result.status, status).toBe('pending');
    }
    const stillRunningAfterSuccess = await check([run('success'), run(null, 'lint', 'in_progress')]);
    expect(stillRunningAfterSuccess.status).toBe('pending');
  });

  it('reports failed only when every run is terminal and none succeeded', async () => {
    const result = await check([run('failure'), run('cancelled', 'lint')]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('failed');
      expect(result.conclusion).toBe('failure');
      expect(result.message).toMatch(/not live/u);
    }
    expect(requestCount).toBe(1);
  });

  it('does not claim failed from skipped/neutral/unknown terminal runs', async () => {
    for (const conclusion of ['skipped', 'neutral', 'stale', 'timed_out', 'action_required']) {
      const result = await check([run(conclusion)]);
      expect(result.status, conclusion).toBe('unconfirmed');
      expect(result.message).toMatch(/could not be confirmed/u);
    }
    const incomplete = await check([run('failure'), run(null)]);
    expect(incomplete.status).toBe('unconfirmed');
  });

  it('keeps pending when no run exists yet, matching the "not started" contract', async () => {
    const result = await check([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('pending');
    }
  });
});
