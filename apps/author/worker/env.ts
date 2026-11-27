/**
 * Worker/DO environment contract.
 *
 * Secrets are read only inside the Worker/DO; the browser bundle never imports
 * this module. `.dev.vars`/`wrangler secret` supply these names.
 */

export interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): Fetcher;
}

export interface AuthorWorkerEnv {
  /** Static asset binding created by the `assets` block in wrangler.jsonc. */
  ASSETS: Fetcher;
  /** Fixed single-author Durable Object namespace. */
  AUTHOR_STORE?: DurableObjectNamespaceLike;
  /** `test` enables the test clock and the task 06 mock surface. */
  APP_ENV?: string;

  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_ALLOWED_USER_ID?: string;
  GITHUB_ALLOWED_REPO_ID?: string;
  GITHUB_REPO_OWNER?: string;
  GITHUB_REPO_NAME?: string;
  GITHUB_REPO_BRANCH?: string;
  GITHUB_CONTENT_ROOT?: string;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;

  /**
   * Test-only GitHub endpoints. Only honored when `APP_ENV === 'test'`;
   * production always uses the official GitHub URLs.
   */
  GITHUB_API_BASE?: string;
  GITHUB_OAUTH_BASE?: string;
}

export interface AuthorGitHubConfig {
  clientId: string;
  clientSecret: string;
  appId: number;
  allowedUserId: number;
  allowedRepoId: number;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  branch: string;
  contentRoot: string;
  sessionSecret: string;
  tokenEncryptionKey: string;
  apiBase: string;
  oauthBase: string;
  /** True when a test-only GitHub base URL is active. */
  testGitHub: boolean;
}

const OFFICIAL_API_BASE = 'https://api.github.com';
const OFFICIAL_OAUTH_BASE = 'https://github.com';
const CONFIGURED_CONTENT_ROOT = 'content/blog';

const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$/u;
const BRANCH_NAME = /^[A-Za-z0-9._/-]{1,200}$/u;

export type ConfigResult =
  | { ok: true; config: AuthorGitHubConfig }
  | { ok: false; missing: string[]; invalid: string[] };

function positiveInteger(value: string | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{1,12}$/u.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validates all non-test configuration. Values are never included in error
 * messages: only variable names are reported.
 */
export function resolveGitHubConfig(env: AuthorWorkerEnv): ConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];

  const require = (name: keyof AuthorWorkerEnv): string => {
    const value = trimmed(env[name] as string | undefined);
    if (value === '') {
      missing.push(String(name));
    }
    return value;
  };

  const clientId = require('GITHUB_APP_CLIENT_ID');
  const clientSecret = require('GITHUB_APP_CLIENT_SECRET');
  const sessionSecret = require('SESSION_SECRET');
  const tokenEncryptionKey = require('TOKEN_ENCRYPTION_KEY');
  const repoOwner = require('GITHUB_REPO_OWNER');
  const repoName = require('GITHUB_REPO_NAME');

  const appId = positiveInteger(env.GITHUB_APP_ID);
  if (appId === null) {
    if (trimmed(env.GITHUB_APP_ID) === '') {
      missing.push('GITHUB_APP_ID');
    } else {
      invalid.push('GITHUB_APP_ID');
    }
  }
  const allowedUserId = positiveInteger(env.GITHUB_ALLOWED_USER_ID);
  if (allowedUserId === null) {
    if (trimmed(env.GITHUB_ALLOWED_USER_ID) === '') {
      missing.push('GITHUB_ALLOWED_USER_ID');
    } else {
      invalid.push('GITHUB_ALLOWED_USER_ID');
    }
  }
  const allowedRepoId = positiveInteger(env.GITHUB_ALLOWED_REPO_ID);
  if (allowedRepoId === null) {
    if (trimmed(env.GITHUB_ALLOWED_REPO_ID) === '') {
      missing.push('GITHUB_ALLOWED_REPO_ID');
    } else {
      invalid.push('GITHUB_ALLOWED_REPO_ID');
    }
  }

  if (repoOwner !== '' && !OWNER_NAME.test(repoOwner)) {
    invalid.push('GITHUB_REPO_OWNER');
  }
  if (repoName !== '' && !OWNER_NAME.test(repoName)) {
    invalid.push('GITHUB_REPO_NAME');
  }

  const branch = trimmed(env.GITHUB_REPO_BRANCH) || 'main';
  if (!BRANCH_NAME.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    invalid.push('GITHUB_REPO_BRANCH');
  }

  const contentRoot = trimmed(env.GITHUB_CONTENT_ROOT) || CONFIGURED_CONTENT_ROOT;
  if (contentRoot !== CONFIGURED_CONTENT_ROOT) {
    // packages/markdown is the single path source and hard-codes this root.
    invalid.push('GITHUB_CONTENT_ROOT');
  }

  if (sessionSecret !== '' && sessionSecret.length < 32) {
    invalid.push('SESSION_SECRET');
  }
  if (tokenEncryptionKey !== '') {
    const trimmedKey = tokenEncryptionKey.trim();
    let validKey = /^[0-9a-f]{64}$/iu.test(trimmedKey);
    if (!validKey && /^[A-Za-z0-9+/_-]+={0,2}$/u.test(trimmedKey)) {
      try {
        const normalized = trimmedKey.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/u, '');
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
        validKey = atob(padded).length === 32;
      } catch {
        validKey = false;
      }
    }
    if (!validKey && new TextEncoder().encode(trimmedKey).length >= 32) {
      validKey = true;
    }
    if (!validKey) {
      invalid.push('TOKEN_ENCRYPTION_KEY');
    }
  }

  const isTest = env.APP_ENV === 'test';
  const testApiBase = isTest ? trimmed(env.GITHUB_API_BASE) : '';
  const testOauthBase = isTest ? trimmed(env.GITHUB_OAUTH_BASE) : '';
  if ((testApiBase === '') !== (testOauthBase === '')) {
    invalid.push('GITHUB_API_BASE/GITHUB_OAUTH_BASE');
  }
  for (const [name, value] of [
    ['GITHUB_API_BASE', testApiBase],
    ['GITHUB_OAUTH_BASE', testOauthBase],
  ] as const) {
    if (value !== '' && !/^http:\/\/(127\.0\.0\.1|localhost)(?::\d{1,5})?$/u.test(value)) {
      invalid.push(name);
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    return { ok: false, missing, invalid };
  }

  return {
    ok: true,
    config: {
      clientId,
      clientSecret,
      appId: appId as number,
      allowedUserId: allowedUserId as number,
      allowedRepoId: allowedRepoId as number,
      repoOwner,
      repoName,
      repoFullName: `${repoOwner}/${repoName}`,
      branch,
      contentRoot,
      sessionSecret,
      tokenEncryptionKey,
      apiBase: testApiBase || OFFICIAL_API_BASE,
      oauthBase: testOauthBase || OFFICIAL_OAUTH_BASE,
      testGitHub: testApiBase !== '',
    },
  };
}

/** True when the task 06 mock surface should be mounted (test env, no test GitHub base). */
export function isMockSurfaceEnabled(env: AuthorWorkerEnv): boolean {
  return env.APP_ENV === 'test' && trimmed(env.GITHUB_API_BASE) === '';
}

/**
 * True when this build has no GitHub App configuration at all.
 *
 * Task 06's production-mode fixture is intentionally unconfigured; the real
 * session route reports 404 there so the editor can keep its documented
 * "authorization is not available in this build" terminal. A partially
 * configured deployment is a misconfiguration and reports 503 instead.
 */
export function hasAnyGitHubConfiguration(env: AuthorWorkerEnv): boolean {
  return [
    'GITHUB_APP_CLIENT_ID',
    'GITHUB_APP_CLIENT_SECRET',
    'GITHUB_APP_ID',
    'GITHUB_ALLOWED_USER_ID',
    'GITHUB_ALLOWED_REPO_ID',
    'GITHUB_REPO_OWNER',
    'GITHUB_REPO_NAME',
    'SESSION_SECRET',
    'TOKEN_ENCRYPTION_KEY',
  ].some((name) => trimmed(env[name as keyof AuthorWorkerEnv] as string | undefined) !== '');
}
