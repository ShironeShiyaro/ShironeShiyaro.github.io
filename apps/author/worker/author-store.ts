/**
 * Single-author Durable Object.
 *
 * All security-critical state lives in one fixed SQLite-backed instance:
 * one-time OAuth transactions, sessions (encrypted tokens), publish
 * transactions, path claims, rate-limit windows and the last auth outcome.
 *
 * Every publish runs through an in-instance serial queue, so two requests
 * cannot both observe "no commit" and create two files. Logout flips
 * `revoked` synchronously; an in-flight publish re-checks it before writing.
 */
import type { PublishPlan } from '@selfpage/markdown';
import {
  buildPublishPlan,
  validatePublishPayload,
  type PublishInput,
  type PublishIssue,
} from './validate.ts';
import {
  encryptSecret,
  decryptSecret,
  hmacBase64Url,
  hmacHex,
  randomToken,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqual,
} from './crypto.ts';
import {
  checkAccess,
  exchangeOAuthCode,
  getContents,
  listCommitsForPath,
  putContents,
  type CommitRecord,
  type GitHubRepo,
  type GitHubUser,
} from './github.ts';
import { resolveGitHubConfig, type AuthorGitHubConfig, type AuthorWorkerEnv } from './env.ts';

type SqlValue = string | number | null;

interface SqlCursor<T> {
  toArray(): T[];
  one(): T;
}

interface SqlStorageLike {
  exec<T>(query: string, ...bindings: SqlValue[]): SqlCursor<T>;
}

interface DurableObjectStorageLike {
  sql: SqlStorageLike;
}

interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface OAuthTransactionRow extends Record<string, SqlValue> {
  state_hash: string;
  verifier: string;
  redirect_uri: string;
  created_at: number;
  expires_at: number;
  consumed: number;
}

interface SessionRow extends Record<string, SqlValue> {
  id_hash: string;
  token_cipher: string;
  user_login: string;
  user_id: number;
  repo_id: number;
  repo_full_name: string;
  token_expires_at: number;
  created_at: number;
  csrf_hash: string;
  revoked: number;
}

interface PublishRow extends Record<string, SqlValue> {
  draft_id: string;
  content_hash: string;
  attempt_id: string;
  path: string;
  file_name: string;
  timestamp: string;
  date: string;
  markdown: string;
  visible_markdown: string;
  front_matter: string;
  published_at_ms: number;
  status: string;
  commit_sha: string | null;
  commit_url: string | null;
  committed_at: number | null;
  first_attempt_at: number;
}

interface PathClaimRow extends Record<string, SqlValue> {
  path: string;
  draft_id: string;
  content_hash: string;
  commit_sha: string | null;
  committed_at: number | null;
}

interface RateLimitRow extends Record<string, SqlValue> {
  key: string;
  window_start: number;
  count: number;
}

interface AuthOutcomeRow extends Record<string, SqlValue> {
  id: number;
  status: string;
  code: string;
  message: string;
  created_at: number;
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
/**
 * Hard wall-clock budget for one publish request, covering every GitHub call
 * (including new-timestamp candidates and post-PUT reconciliation). Each call
 * also gets its own smaller timeout, capped by the remaining budget, so the
 * whole publish path is bounded (A11) even when GitHub is slow repeatedly.
 */
const PUBLISH_DEADLINE_MS = 45_000;
const OAUTH_TX_TTL_MS = 10 * 60 * 1000;
const AUTH_OUTCOME_TTL_MS = 5 * 60 * 1000;
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9_-]{20,128}$/u;
const STATE_VALUE = /^[A-Za-z0-9_-]{20,128}$/u;
const CODE_VALUE = /^[A-Za-z0-9_-]{4,512}$/u;

const AUTH_MESSAGES = {
  cancelled: 'GitHub authorization was cancelled. Nothing was published.',
  forbidden: 'This GitHub account is not the configured author. Nothing was published.',
  expired: 'The GitHub authorization expired. Sign in again. Your draft is safe.',
  app_not_installed: 'The GitHub App is not installed for this account. Install it on the target repository and try again.',
  repo_not_selected: 'The GitHub App is not installed on the target repository. Select that repository in the App installation and try again.',
  contents_read_only: 'The GitHub App has read-only access to this repository. Change Contents permission to Read and write.',
  no_push: 'This GitHub account cannot push to the target repository. Check the account permission on the repository.',
  repo_unavailable: 'The target repository could not be read with this authorization. Check the App installation and repository ID.',
  permission_check_failed: 'The author server could not verify the App installation permissions. Review the App installation and try again.',
  permission_denied: 'The GitHub App cannot write to this repository. Review the App installation and try again.',
  token_invalid: 'GitHub rejected the authorization. Sign in again. Your draft is safe.',
  state_invalid: 'The authorization response could not be verified. Start again from this page.',
  oauth_error: 'GitHub did not complete the authorization. Try again from this page.',
  configuration_error: 'GitHub authorization is not configured on the author server. Try again later.',
} as const;

const DEPLOYMENT_PENDING_MESSAGE =
  'The commit exists, but the site deployment is still pending. The post is not live yet.';

type AuthOutcomeCode = keyof typeof AUTH_MESSAGES;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNow(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now();
}

function deadlineRemainingMs(deadlineAt: number): number {
  return deadlineAt - Date.now();
}

function brandPath(config: AuthorGitHubConfig, path: string): string {
  return `https://github.com/${config.repoFullName}/blob/${config.branch}/${path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

/** Review path for a write rejected by branch protection or repository rules. */
function branchRulesUrl(config: AuthorGitHubConfig): string {
  return `https://github.com/${config.repoFullName}/settings/branches`;
}

function commitLooksOwned(commit: CommitRecord, draftId: string, contentHash: string): boolean {
  return (
    commit.message.includes(`Draft-ID: ${draftId}`) &&
    commit.message.includes(`Content-Hash: ${contentHash}`)
  );
}

export class AuthorStore {
  private readonly ctx: DurableObjectStateLike;
  private readonly env: AuthorWorkerEnv;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectStateLike, env: AuthorWorkerEnv) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
    });
  }

  private sql(): SqlStorageLike {
    return this.ctx.storage.sql;
  }

  private ensureSchema(): void {
    this.sql().exec(`CREATE TABLE IF NOT EXISTS oauth_tx (
      state_hash TEXT PRIMARY KEY,
      verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql().exec(`CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      token_cipher TEXT NOT NULL,
      user_login TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      repo_id INTEGER NOT NULL,
      repo_full_name TEXT NOT NULL,
      token_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      csrf_hash TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql().exec(`CREATE TABLE IF NOT EXISTS publishes (
      draft_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      date TEXT NOT NULL,
      markdown TEXT NOT NULL,
      visible_markdown TEXT NOT NULL,
      front_matter TEXT NOT NULL,
      published_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      commit_sha TEXT,
      commit_url TEXT,
      committed_at INTEGER,
      first_attempt_at INTEGER NOT NULL,
      PRIMARY KEY (draft_id, content_hash)
    )`);
    this.sql().exec(`CREATE TABLE IF NOT EXISTS path_claims (
      path TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      commit_sha TEXT,
      committed_at INTEGER
    )`);
    this.sql().exec(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL
    )`);
    this.sql().exec(`CREATE TABLE IF NOT EXISTS auth_outcomes (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  }

  private enqueue<T>(callback: () => Promise<T>): Promise<T> {
    const run = this.queue.then(callback, callback);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' && request.method !== 'GET') {
        return json(405, { error: 'method_not_allowed' });
      }
      const body = request.method === 'POST' ? await this.readJson(request) : {};
      if (body === null) {
        return json(400, { error: 'invalid_json' });
      }
      switch (url.pathname) {
        case '/auth/start':
          return await this.handleStart(body);
        case '/auth/callback':
          return await this.handleCallback(body);
        case '/auth/outcome':
          return await this.handleOutcome(body);
        case '/session':
          return await this.handleSession(body);
        case '/logout':
          return await this.handleLogout(body);
        case '/publish':
          return await this.handlePublish(body);
        case '/rate':
          return await this.handleRate(body);
        case '/test/reset':
          return await this.handleTestReset();
        default:
          return json(404, { error: 'not_found' });
      }
    } catch {
      return json(500, {
        error: 'store_error',
        message: 'The author server could not complete the request. Reload the page and try again.',
      });
    }
  }

  private async readJson(request: Request): Promise<Record<string, unknown> | null> {
    try {
      const value = await request.json();
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  }

  private configOrError(): { ok: true; config: AuthorGitHubConfig } | { ok: false; response: Response } {
    const resolved = resolveGitHubConfig(this.env);
    if (resolved.ok) {
      return resolved;
    }
    console.error(
      JSON.stringify({
        event: 'author_configuration_error',
        missing: resolved.missing,
        invalid: resolved.invalid,
      }),
    );
    return { ok: false, response: json(503, { error: 'configuration_error' }) };
  }

  private rateLimit(
    keys: Array<{ key: string; limit: number }>,
    windowMs: number,
    now: number,
  ): number | null {
    if (keys.length === 0) {
      return null;
    }
    const rows = keys.map((entry) =>
      this.sql()
        .exec<RateLimitRow>('SELECT key, window_start, count FROM rate_limits WHERE key = ?', entry.key)
        .toArray()
        .at(0) ?? null,
    );
    for (let index = 0; index < keys.length; index += 1) {
      const entry = keys[index] as { key: string; limit: number };
      const row = rows[index] ?? null;
      if (row && now - row.window_start < windowMs && row.count >= entry.limit) {
        const retryAfter = Math.max(1, Math.ceil((row.window_start + windowMs - now) / 1000));
        return retryAfter;
      }
    }
    for (let index = 0; index < keys.length; index += 1) {
      const entry = keys[index] as { key: string; limit: number };
      const row = rows[index] ?? null;
      if (!row || now - row.window_start >= windowMs) {
        this.sql().exec(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
          entry.key,
          now,
        );
      } else {
        this.sql().exec('UPDATE rate_limits SET count = count + 1 WHERE key = ?', entry.key);
      }
    }
    return null;
  }

  private setAuthOutcome(
    status: AuthOutcomeCode,
    code: string,
    message: string,
    now: number,
  ): void {
    this.sql().exec(
      `INSERT INTO auth_outcomes (id, status, code, message, created_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, code = excluded.code,
         message = excluded.message, created_at = excluded.created_at`,
      status,
      code,
      message,
      now,
    );
  }

  private readAuthOutcome(now: number): { status: string; code: string; message: string } | null {
    const row = this.sql()
      .exec<AuthOutcomeRow>('SELECT * FROM auth_outcomes WHERE id = 1')
      .toArray()
      .at(0);
    if (!row) {
      return null;
    }
    if (now - row.created_at > AUTH_OUTCOME_TTL_MS) {
      this.sql().exec('DELETE FROM auth_outcomes WHERE id = 1');
      return null;
    }
    return { status: row.status, code: row.code, message: row.message };
  }

  private clearAuthOutcome(): void {
    this.sql().exec('DELETE FROM auth_outcomes WHERE id = 1');
  }

  private csrfToken(config: AuthorGitHubConfig, sessionId: string): Promise<string> {
    // Derived from the opaque session id + server secret: no plaintext CSRF
    // token is stored, and every session read can return the same token.
    return hmacBase64Url(config.sessionSecret, `selfpage-csrf:${sessionId}`);
  }

  private async csrfMatches(
    config: AuthorGitHubConfig,
    sessionId: string,
    row: SessionRow,
    provided: unknown,
  ): Promise<boolean> {
    if (typeof provided !== 'string' || provided.length < 20 || provided.length > 128) {
      return false;
    }
    const expected = await this.csrfToken(config, sessionId);
    if (!timingSafeEqual(provided, expected)) {
      return false;
    }
    const expectedHash = await hmacHex(config.sessionSecret, expected);
    return timingSafeEqual(row.csrf_hash, expectedHash);
  }

  private async handleStart(body: Record<string, unknown>): Promise<Response> {
    const configResult = this.configOrError();
    if (!configResult.ok) {
      const now = safeNow(body.now);
      this.setAuthOutcome('configuration_error', 'configuration_error', AUTH_MESSAGES.configuration_error, now);
      return configResult.response;
    }
    const config = configResult.config;
    const now = safeNow(body.now);
    const ipHash = typeof body.ipHash === 'string' ? body.ipHash : 'unknown';
    const retryAfter = this.rateLimit(
      [{ key: `start:ip:${ipHash}`, limit: 10 }],
      10 * 60 * 1000,
      now,
    );
    if (retryAfter !== null) {
      return json(429, { error: 'rate_limited', retryAfterSeconds: retryAfter });
    }
    const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : '';
    if (!/^https?:\/\/[^\s]+$/u.test(redirectUri) || redirectUri.length > 300) {
      return json(400, { error: 'invalid_redirect_uri' });
    }

    this.sql().exec('DELETE FROM oauth_tx WHERE expires_at < ?', now);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = await sha256Base64Url(verifier);
    const stateHash = await hmacHex(config.sessionSecret, state);
    this.sql().exec(
      'INSERT INTO oauth_tx (state_hash, verifier, redirect_uri, created_at, expires_at, consumed) VALUES (?, ?, ?, ?, ?, 0)',
      stateHash,
      verifier,
      redirectUri,
      now,
      now + OAUTH_TX_TTL_MS,
    );
    this.clearAuthOutcome();

    const authorize = new URL(`${config.oauthBase}/login/oauth/authorize`);
    authorize.searchParams.set('client_id', config.clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('allow_signup', 'false');
    if (body.switchAccount === true) {
      authorize.searchParams.set('prompt', 'select_account');
    }
    return json(200, { authorizeUrl: authorize.toString() });
  }

  private async handleCallback(body: Record<string, unknown>): Promise<Response> {
    const configResult = this.configOrError();
    if (!configResult.ok) {
      const now = safeNow(body.now);
      this.setAuthOutcome('configuration_error', 'configuration_error', AUTH_MESSAGES.configuration_error, now);
      return configResult.response;
    }
    const config = configResult.config;
    const now = safeNow(body.now);
    const ipHash = typeof body.ipHash === 'string' ? body.ipHash : 'unknown';
    const retryAfter = this.rateLimit(
      [{ key: `callback:ip:${ipHash}`, limit: 20 }],
      10 * 60 * 1000,
      now,
    );
    if (retryAfter !== null) {
      return json(429, { error: 'rate_limited', retryAfterSeconds: retryAfter });
    }

    const state = typeof body.state === 'string' ? body.state : '';
    const fail = (status: AuthOutcomeCode, code: string, message: string): Response => {
      this.setAuthOutcome(status, code, message, now);
      return json(200, { status: 'failed', outcome: { status, code, message } });
    };

    if (!STATE_VALUE.test(state)) {
      return fail('oauth_error', 'state_invalid', AUTH_MESSAGES.state_invalid);
    }
    const stateHash = await hmacHex(config.sessionSecret, state);
    const tx = this.sql()
      .exec<OAuthTransactionRow>('SELECT * FROM oauth_tx WHERE state_hash = ?', stateHash)
      .toArray()
      .at(0);
    if (!tx || tx.consumed !== 0 || tx.expires_at < now) {
      return fail('oauth_error', 'state_invalid', AUTH_MESSAGES.state_invalid);
    }
    // Consume synchronously before any await: a replay cannot exchange twice.
    this.sql().exec('UPDATE oauth_tx SET consumed = 1 WHERE state_hash = ?', stateHash);

    const currentRedirect = typeof body.redirectUri === 'string' ? body.redirectUri : '';
    if (currentRedirect !== tx.redirect_uri) {
      return fail('oauth_error', 'state_invalid', AUTH_MESSAGES.state_invalid);
    }

    const githubError = typeof body.error === 'string' ? body.error : '';
    if (githubError !== '') {
      if (githubError === 'access_denied') {
        return fail('cancelled', 'access_denied', AUTH_MESSAGES.cancelled);
      }
      return fail('oauth_error', 'oauth_error', AUTH_MESSAGES.oauth_error);
    }

    const code = typeof body.code === 'string' ? body.code : '';
    if (!CODE_VALUE.test(code)) {
      return fail('oauth_error', 'oauth_error', AUTH_MESSAGES.oauth_error);
    }

    const exchanged = await exchangeOAuthCode(config, {
      code,
      redirectUri: tx.redirect_uri,
      verifier: tx.verifier,
      repositoryId: config.allowedRepoId,
    });
    if (!exchanged.ok) {
      if (exchanged.kind === 'denied') {
        return fail('cancelled', 'access_denied', AUTH_MESSAGES.cancelled);
      }
      if (exchanged.kind === 'configuration') {
        return fail('oauth_error', 'configuration_error', AUTH_MESSAGES.configuration_error);
      }
      return fail('oauth_error', 'oauth_error', AUTH_MESSAGES.oauth_error);
    }

    const access = await checkAccess(config, exchanged.token.accessToken);
    if (!access.ok) {
      switch (access.code) {
        case 'token_invalid':
          return fail('expired', 'token_invalid', AUTH_MESSAGES.token_invalid);
        case 'forbidden':
          return fail('forbidden', 'forbidden', AUTH_MESSAGES.forbidden);
        case 'app_not_installed':
          return fail('permission_denied', access.code, AUTH_MESSAGES.app_not_installed);
        case 'repo_not_selected':
          return fail('permission_denied', access.code, AUTH_MESSAGES.repo_not_selected);
        case 'contents_read_only':
          return fail('permission_denied', access.code, AUTH_MESSAGES.contents_read_only);
        case 'no_push':
          return fail('permission_denied', access.code, AUTH_MESSAGES.no_push);
        case 'repo_unavailable':
          return fail('permission_denied', access.code, AUTH_MESSAGES.repo_unavailable);
        case 'permission_check_failed':
          return fail('permission_denied', access.code, AUTH_MESSAGES.permission_check_failed);
        default:
          return fail('oauth_error', 'oauth_error', AUTH_MESSAGES.oauth_error);
      }
    }

    const sessionId = randomToken(32);
    const idHash = await hmacHex(config.sessionSecret, sessionId);
    const csrf = await this.csrfToken(config, sessionId);
    const csrfHash = await hmacHex(config.sessionSecret, csrf);
    const tokenCipher = await encryptSecret(
      exchanged.token.accessToken,
      config.tokenEncryptionKey,
    );
    const tokenExpiresAt = Math.min(
      now + exchanged.token.expiresInSeconds * 1000,
      now + SESSION_MAX_MS,
    );

    this.sql().exec('DELETE FROM sessions WHERE token_expires_at <= ?', now);
    this.sql().exec(
      `INSERT INTO sessions (id_hash, token_cipher, user_login, user_id, repo_id, repo_full_name,
        token_expires_at, created_at, csrf_hash, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      idHash,
      tokenCipher,
      access.user.login,
      access.user.id,
      config.allowedRepoId,
      config.repoFullName,
      tokenExpiresAt,
      now,
      csrfHash,
    );
    this.clearAuthOutcome();

    return json(200, {
      status: 'authorized',
      sessionId,
      csrfToken: csrf,
      expiresAt: new Date(tokenExpiresAt).toISOString(),
      user: access.user,
      repo: {
        id: config.allowedRepoId,
        fullName: config.repoFullName,
        owner: config.repoOwner,
        name: config.repoName,
        branch: config.branch,
      },
    });
  }

  private async handleOutcome(body: Record<string, unknown>): Promise<Response> {
    const now = safeNow(body.now);
    const status = typeof body.status === 'string' ? body.status : 'oauth_error';
    const allowed: AuthOutcomeCode[] = [
      'cancelled',
      'forbidden',
      'expired',
      'permission_denied',
      'state_invalid',
      'oauth_error',
      'configuration_error',
    ];
    const safeStatus = (allowed as string[]).includes(status)
      ? (status as AuthOutcomeCode)
      : 'oauth_error';
    const message =
      typeof body.message === 'string' && body.message.length > 0 && body.message.length < 300
        ? body.message
        : AUTH_MESSAGES[safeStatus];
    this.setAuthOutcome(safeStatus, safeStatus, message, now);
    return json(200, { status: 'recorded' });
  }

  private async handleSession(body: Record<string, unknown>): Promise<Response> {
    const configResult = this.configOrError();
    if (!configResult.ok) {
      return configResult.response;
    }
    const config = configResult.config;
    const now = safeNow(body.now);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!SESSION_ID.test(sessionId)) {
      const auth = this.readAuthOutcome(now);
      return json(200, { status: 'anonymous', ...(auth ? { auth } : {}) });
    }
    const idHash = await hmacHex(config.sessionSecret, sessionId);
    const row = this.sql()
      .exec<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', idHash)
      .toArray()
      .at(0);
    if (!row) {
      const auth = this.readAuthOutcome(now);
      return json(200, { status: 'anonymous', ...(auth ? { auth } : {}) });
    }
    if (row.revoked !== 0) {
      this.sql().exec('DELETE FROM sessions WHERE id_hash = ?', idHash);
      return json(200, { status: 'anonymous', clearCookie: true });
    }
    if (row.token_expires_at <= now) {
      this.sql().exec('DELETE FROM sessions WHERE id_hash = ?', idHash);
      this.setAuthOutcome('expired', 'expired', AUTH_MESSAGES.expired, now);
      return json(200, {
        status: 'anonymous',
        clearCookie: true,
        auth: { status: 'expired', code: 'expired', message: AUTH_MESSAGES.expired },
      });
    }
    this.clearAuthOutcome();
    return json(200, {
      status: 'authorized',
      user: { login: row.user_login, id: row.user_id },
      repo: {
        id: row.repo_id,
        fullName: row.repo_full_name,
        owner: config.repoOwner,
        name: config.repoName,
        branch: config.branch,
      },
      csrfToken: await this.csrfToken(config, sessionId),
      expiresAt: new Date(row.token_expires_at).toISOString(),
    });
  }

  private async handleLogout(body: Record<string, unknown>): Promise<Response> {
    const configResult = this.configOrError();
    if (!configResult.ok) {
      return configResult.response;
    }
    const config = configResult.config;
    const now = safeNow(body.now);
    const ipHash = typeof body.ipHash === 'string' ? body.ipHash : 'unknown';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!SESSION_ID.test(sessionId)) {
      return json(200, { status: 'anonymous', revoked: false });
    }
    const idHash = await hmacHex(config.sessionSecret, sessionId);
    const row = this.sql()
      .exec<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', idHash)
      .toArray()
      .at(0);
    const retryAfter = this.rateLimit(
      [
        { key: `logout:ip:${ipHash}`, limit: 30 },
        ...(row ? [{ key: `logout:sess:${idHash.slice(0, 24)}`, limit: 20 }] : []),
      ],
      5 * 60 * 1000,
      now,
    );
    if (retryAfter !== null) {
      return json(429, { error: 'rate_limited', retryAfterSeconds: retryAfter });
    }
    if (!row) {
      return json(200, { status: 'anonymous', revoked: false });
    }
    if (!(await this.csrfMatches(config, sessionId, row, body.csrfToken))) {
      return json(403, { error: 'security_blocked' });
    }
    this.sql().exec('UPDATE sessions SET revoked = 1 WHERE id_hash = ?', idHash);
    this.clearAuthOutcome();
    return json(200, { status: 'anonymous', revoked: true });
  }

  private async handleRate(body: Record<string, unknown>): Promise<Response> {
    const configResult = this.configOrError();
    if (!configResult.ok) {
      return configResult.response;
    }
    const now = safeNow(body.now);
    const ipHash = typeof body.ipHash === 'string' ? body.ipHash : 'unknown';
    const bucket = typeof body.bucket === 'string' ? body.bucket : '';
    if (bucket !== 'deployments') {
      return json(400, { error: 'invalid_bucket' });
    }
    const retryAfter = this.rateLimit(
      [{ key: `deployments:ip:${ipHash}`, limit: 30 }],
      5 * 60 * 1000,
      now,
    );
    if (retryAfter !== null) {
      return json(429, { error: 'rate_limited', retryAfterSeconds: retryAfter });
    }
    return json(200, { ok: true });
  }

  private async handleTestReset(): Promise<Response> {
    for (const table of [
      'oauth_tx',
      'sessions',
      'publishes',
      'path_claims',
      'rate_limits',
      'auth_outcomes',
    ]) {
      this.sql().exec(`DELETE FROM ${table}`);
    }
    return json(200, { status: 'reset' });
  }

  private async sessionForPublish(
    config: AuthorGitHubConfig,
    sessionId: string,
    now: number,
    csrfToken: unknown,
  ): Promise<
    | { ok: true; sessionId: string; row: SessionRow; token: string }
    | { ok: false; status: number; body: unknown }
  > {
    if (!SESSION_ID.test(sessionId)) {
      return {
        ok: false,
        status: 401,
        body: {
          status: 'not_authorized',
          error: { code: 'not_authorized', message: 'Sign in with GitHub before publishing.' },
        },
      };
    }
    const idHash = await hmacHex(config.sessionSecret, sessionId);
    const row = this.sql()
      .exec<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', idHash)
      .toArray()
      .at(0);
    if (!row || row.revoked !== 0) {
      return {
        ok: false,
        status: 401,
        body: {
          status: 'expired',
          error: { code: 'expired', message: AUTH_MESSAGES.expired },
          clearCookie: true,
        },
      };
    }
    if (row.token_expires_at <= now) {
      this.sql().exec('DELETE FROM sessions WHERE id_hash = ?', idHash);
      this.setAuthOutcome('expired', 'expired', AUTH_MESSAGES.expired, now);
      return {
        ok: false,
        status: 401,
        body: {
          status: 'expired',
          error: { code: 'expired', message: AUTH_MESSAGES.expired },
          clearCookie: true,
        },
      };
    }
    if (!(await this.csrfMatches(config, sessionId, row, csrfToken))) {
      return {
        ok: false,
        status: 403,
        body: {
          status: 'forbidden',
          error: {
            code: 'security_blocked',
            message: 'The request was blocked by the author server. Reload the page and try again.',
          },
        },
      };
    }
    let token: string;
    try {
      token = await decryptSecret(row.token_cipher, config.tokenEncryptionKey);
    } catch {
      this.sql().exec('DELETE FROM sessions WHERE id_hash = ?', idHash);
      this.setAuthOutcome('expired', 'expired', AUTH_MESSAGES.expired, now);
      return {
        ok: false,
        status: 401,
        body: {
          status: 'expired',
          error: { code: 'expired', message: AUTH_MESSAGES.expired },
          clearCookie: true,
        },
      };
    }
    return { ok: true, sessionId, row, token };
  }

  /** Bounded terminal for an exhausted overall publish budget (A11). */
  private publishTimeoutResponse(): Response {
    return json(504, {
      status: 'timeout',
      error: {
        code: 'timeout',
        message:
          'The publishing request timed out or could not reach GitHub. Your draft is safe. Retry to reconcile.',
      },
    });
  }

  private githubCallTimeout(deadlineAt: number, baseMs: number): number | null {
    const remaining = deadlineRemainingMs(deadlineAt);
    if (remaining <= 0) {
      return null;
    }
    return Math.max(1, Math.min(baseMs, remaining));
  }

  private async handlePublish(body: Record<string, unknown>): Promise<Response> {
    const configResult = this.configOrError();
    if (!configResult.ok) {
      return configResult.response;
    }
    const config = configResult.config;
    const now = safeNow(body.now);
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const session = await this.sessionForPublish(config, sessionId, now, body.csrfToken);
    if (!session.ok) {
      return json(session.status, session.body);
    }
    const ipHash = typeof body.ipHash === 'string' ? body.ipHash : 'unknown';
    const retryAfter = this.rateLimit(
      [
        { key: `publish:ip:${ipHash}`, limit: 15 },
        { key: `publish:sess:${session.row.id_hash.slice(0, 24)}`, limit: 8 },
      ],
      5 * 60 * 1000,
      now,
    );
    if (retryAfter !== null) {
      return json(429, {
        status: 'rate_limited',
        error: { code: 'rate_limited', message: 'Too many publishing requests. Try again shortly.' },
        retryAfterSeconds: retryAfter,
      });
    }

    const parsed = validatePublishPayload({
      title: body.title,
      body: body.body,
      draftId: body.draftId,
      attemptId: body.attemptId,
      ...(body.newTimestamp === undefined ? {} : { newTimestamp: body.newTimestamp }),
    });
    if (!parsed.ok) {
      return json(parsed.status, {
        status: 'validation_error',
        error: {
          code: 'validation_error',
          message: 'The post could not be published. Check the highlighted fields.',
        },
        errors: parsed.issues,
      });
    }
    const input: PublishInput = parsed.input;
    const contentHash = await sha256Hex(`${input.title.trim()}\n${input.body.replace(/\r\n?/g, '\n')}`);
    // The budget starts before queueing: waiting behind another publish is part
    // of this request's bounded wall-clock time.
    const deadlineAt = Date.now() + PUBLISH_DEADLINE_MS;

    try {
      return await this.enqueue(() =>
        this.publishTransaction(config, session, input, contentHash, now, deadlineAt),
      );
    } catch {
      return json(500, {
        status: 'server_error',
        error: {
          code: 'server_error',
          message: 'The publishing service returned an error. Your draft is safe.',
        },
      });
    }
  }

  private async publishTransaction(
    config: AuthorGitHubConfig,
    session: { row: SessionRow; token: string },
    input: PublishInput,
    contentHash: string,
    now: number,
    deadlineAt: number,
  ): Promise<Response> {
    if (deadlineRemainingMs(deadlineAt) <= 0) {
      return this.publishTimeoutResponse();
    }
    const current = this.sql()
      .exec<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', session.row.id_hash)
      .toArray()
      .at(0);
    if (!current || current.revoked !== 0 || current.token_expires_at <= now) {
      return json(401, {
        status: 'expired',
        error: { code: 'expired', message: AUTH_MESSAGES.expired },
        clearCookie: true,
      });
    }

    const existing = this.sql()
      .exec<PublishRow>(
        'SELECT * FROM publishes WHERE draft_id = ? AND content_hash = ?',
        input.draftId,
        contentHash,
      )
      .toArray()
      .at(0);

    if (existing && existing.status === 'committed') {
      const committedAt = existing.committed_at ?? 0;
      const withinThreeHours = now - committedAt < THREE_HOURS_MS;
      if (withinThreeHours || existing.attempt_id === input.attemptId) {
        return this.duplicateResponse(config, existing);
      }
      // At/after three hours a *new* explicit attempt may create a new
      // timestamped article. Fall through with the new plan.
    }

    if (existing && existing.status === 'pending') {
      const reconciled = await this.reconcilePath(
        config,
        session.token,
        existing.path,
        existing.markdown,
        input.draftId,
        contentHash,
        deadlineAt,
      );
      if (reconciled.kind === 'found') {
        this.markCommitted(existing, reconciled.commit, now);
        const updated = this.sql()
          .exec<PublishRow>(
            'SELECT * FROM publishes WHERE draft_id = ? AND content_hash = ?',
            input.draftId,
            contentHash,
          )
          .toArray()
          .at(0);
        return this.duplicateResponse(config, updated ?? existing);
      }
      if (reconciled.kind === 'error') {
        return reconciled.response;
      }
      if (reconciled.kind === 'conflict') {
        return this.conflictResponse(config, existing.path, reconciled.commit);
      }
      // Not found yet: retry the original timestamp/path below.
      return this.attemptPut(config, session, input, contentHash, existing, now, deadlineAt);
    }

    // No record for this draft+content. Choose a path (explicit new-timestamp
    // retries may skip up to 5 seconds of already-claimed paths).
    const candidateCount = input.newTimestamp ? 5 : 1;
    for (let offset = 0; offset < candidateCount; offset += 1) {
      const readTimeout = this.githubCallTimeout(deadlineAt, 8_000);
      if (readTimeout === null) {
        return this.publishTimeoutResponse();
      }
      const planResult = buildPublishPlan(input, now + offset * 1_000);
      if (!planResult.ok) {
        return this.validationResponse(planResult.issues);
      }
      const plan = planResult.plan;
      const claim = this.sql()
        .exec<PathClaimRow>('SELECT * FROM path_claims WHERE path = ?', plan.path)
        .toArray()
        .at(0);
      if (claim && claim.content_hash !== contentHash) {
        if (candidateCount > 1) {
          continue;
        }
        return this.conflictResponse(config, plan.path, null);
      }
      const remote = await getContents(config, session.token, plan.path, readTimeout);
      if (!remote.ok) {
        if (deadlineRemainingMs(deadlineAt) <= 0) {
          return this.publishTimeoutResponse();
        }
        return this.contentsErrorResponse(remote);
      }
      if (remote.exists) {
        if (remote.file.contentText === plan.post.markdown) {
          const reconciled = await this.reconcilePath(
            config,
            session.token,
            plan.path,
            plan.post.markdown,
            input.draftId,
            contentHash,
            deadlineAt,
          );
          if (reconciled.kind === 'found') {
            const row = this.insertPending(
              input,
              contentHash,
              plan,
              now,
            );
            this.markCommitted(row, reconciled.commit, now);
            const updated = this.sql()
              .exec<PublishRow>(
                'SELECT * FROM publishes WHERE draft_id = ? AND content_hash = ?',
                input.draftId,
                contentHash,
              )
              .toArray()
              .at(0);
            return this.duplicateResponse(config, updated ?? row);
          }
          if (reconciled.kind === 'error') {
            return reconciled.response;
          }
        }
        if (candidateCount > 1) {
          continue;
        }
        return this.conflictResponse(config, plan.path, null);
      }

      const row = this.insertPending(input, contentHash, plan, now);
      const result = await this.attemptPut(
        config,
        session,
        input,
        contentHash,
        row,
        now,
        deadlineAt,
      );
      if (result.status === 409 && candidateCount > 1 && offset < candidateCount - 1) {
        // Another second's path was claimed concurrently; try the next one.
        this.sql().exec(
          'DELETE FROM publishes WHERE draft_id = ? AND content_hash = ? AND status = ?',
          input.draftId,
          contentHash,
          'pending',
        );
        continue;
      }
      return result;
    }
    return this.conflictResponse(config, '', null);
  }

  private insertPending(
    input: PublishInput,
    contentHash: string,
    plan: PublishPlan,
    now: number,
  ): PublishRow {
    this.sql().exec(
      `INSERT INTO publishes (draft_id, content_hash, attempt_id, path, file_name, timestamp, date,
        markdown, visible_markdown, front_matter, published_at_ms, status, commit_sha, commit_url,
        committed_at, first_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?)
       ON CONFLICT(draft_id, content_hash) DO UPDATE SET attempt_id = excluded.attempt_id,
         path = excluded.path, file_name = excluded.file_name, timestamp = excluded.timestamp,
         date = excluded.date, markdown = excluded.markdown,
         visible_markdown = excluded.visible_markdown, front_matter = excluded.front_matter,
         published_at_ms = excluded.published_at_ms, status = 'pending',
         commit_sha = NULL, commit_url = NULL, committed_at = NULL`,
      input.draftId,
      contentHash,
      input.attemptId,
      plan.path,
      plan.fileName,
      plan.timestamp.timestamp,
      plan.post.date,
      plan.post.markdown,
      plan.post.visibleMarkdown,
      plan.post.frontMatter,
      now,
      now,
    );
    return this.sql()
      .exec<PublishRow>(
        'SELECT * FROM publishes WHERE draft_id = ? AND content_hash = ?',
        input.draftId,
        contentHash,
      )
      .toArray()
      .at(0) as PublishRow;
  }

  private commitMessage(input: PublishInput, contentHash: string): string {
    return `New blog post: ${input.title.trim()}\n\nDraft-ID: ${input.draftId}\nContent-Hash: ${contentHash}`;
  }

  private async attemptPut(
    config: AuthorGitHubConfig,
    session: { row: SessionRow; token: string },
    input: PublishInput,
    contentHash: string,
    row: PublishRow,
    now: number,
    deadlineAt: number,
  ): Promise<Response> {
    const recheck = this.sql()
      .exec<SessionRow>('SELECT * FROM sessions WHERE id_hash = ?', session.row.id_hash)
      .toArray()
      .at(0);
    if (!recheck || recheck.revoked !== 0) {
      return json(401, {
        status: 'expired',
        error: { code: 'expired', message: AUTH_MESSAGES.expired },
        clearCookie: true,
      });
    }
    const putTimeout = this.githubCallTimeout(deadlineAt, 12_000);
    if (putTimeout === null) {
      return this.publishTimeoutResponse();
    }
    const put = await putContents(
      config,
      session.token,
      {
        path: row.path,
        message: this.commitMessage(input, contentHash),
        markdown: row.markdown,
      },
      putTimeout,
    );
    if (put.ok) {
      const commit: CommitRecord = {
        sha: put.commitSha,
        htmlUrl: put.commitUrl,
        message: this.commitMessage(input, contentHash),
        committedAt: new Date(now).toISOString(),
      };
      this.markCommitted(row, commit, now);
      const updated = this.sql()
        .exec<PublishRow>(
          'SELECT * FROM publishes WHERE draft_id = ? AND content_hash = ?',
          input.draftId,
          contentHash,
        )
        .toArray()
        .at(0) as PublishRow;
      return this.successResponse(config, updated, false);
    }

    if (put.code === 'token_invalid') {
      this.sql().exec('UPDATE sessions SET revoked = 1 WHERE id_hash = ?', session.row.id_hash);
      this.setAuthOutcome('expired', 'expired', AUTH_MESSAGES.expired, now);
      return json(401, {
        status: 'expired',
        error: { code: 'expired', message: AUTH_MESSAGES.expired },
        clearCookie: true,
      });
    }
    // The budget is exhausted: do not start a reconciliation round (and never
    // replay the PUT). The pending row is kept for an explicit Retry.
    if (deadlineRemainingMs(deadlineAt) <= 0) {
      return this.publishTimeoutResponse();
    }
    if (put.code === 'conflict') {
      const reconciled = await this.reconcilePath(
        config,
        session.token,
        row.path,
        row.markdown,
        input.draftId,
        contentHash,
        deadlineAt,
      );
      if (reconciled.kind === 'found') {
        this.markCommitted(row, reconciled.commit, now);
        const updated = this.sql()
          .exec<PublishRow>(
            'SELECT * FROM publishes WHERE draft_id = ? AND content_hash = ?',
            input.draftId,
            contentHash,
          )
          .toArray()
          .at(0) as PublishRow;
        return this.duplicateResponse(config, updated);
      }
      if (reconciled.kind === 'error') {
        return reconciled.response;
      }
      return this.conflictResponse(config, row.path, null);
    }
    if (put.code === 'branch_protected') {
      // GitHub rejected the whole write because the branch is protected. There
      // is no file to show (and possibly no file at all), so this must never be
      // rendered as a path conflict / "existing file".
      return json(422, {
        status: 'branch_protected',
        error: {
          code: 'branch_protected',
          message:
            'GitHub rejected the write because this branch is protected. Direct writes to a protected branch are not allowed, so nothing was published. The repository was not changed by this request.',
        },
        reviewUrl: branchRulesUrl(config),
      });
    }
    if (put.code === 'write_rejected') {
      // A non-protection 422 is a conflict only when the target file really
      // exists. If it does not, report a repository-rule rejection without any
      // "existing file" link.
      const reconciled = await this.reconcilePath(
        config,
        session.token,
        row.path,
        row.markdown,
        input.draftId,
        contentHash,
        deadlineAt,
      );
      if (reconciled.kind === 'found') {
        this.markCommitted(row, reconciled.commit, now);
        const updated = this.sql()
          .exec<PublishRow>(
            'SELECT * FROM publishes WHERE draft_id = ? AND content_hash = ?',
            input.draftId,
            contentHash,
          )
          .toArray()
          .at(0) as PublishRow;
        return this.duplicateResponse(config, updated);
      }
      if (reconciled.kind === 'error') {
        return reconciled.response;
      }
      if (reconciled.kind === 'conflict') {
        return this.conflictResponse(config, row.path, reconciled.commit);
      }
      return json(422, {
        status: 'write_rejected',
        error: {
          code: 'write_rejected',
          message:
            'GitHub rejected this write because of a repository rule. Nothing was published, and the repository was not changed by this request. Review the repository rules before trying again.',
        },
        reviewUrl: branchRulesUrl(config),
      });
    }
    if (put.code === 'rate_limited') {
      return json(429, {
        status: 'rate_limited',
        error: { code: 'rate_limited', message: "GitHub's rate limit was reached. Try again later." },
        retryAfterSeconds: put.retryAfterSeconds ?? 60,
      });
    }
    if (put.code === 'permission_denied') {
      return json(403, {
        status: 'permission_denied',
        error: {
          code: 'permission_denied',
          message: 'The GitHub App no longer has permission to write to this repository. Nothing was published.',
        },
      });
    }
    if (put.code === 'not_found') {
      return json(404, {
        status: 'not_found',
        error: {
          code: 'not_found',
          message: 'The target repository or branch could not be found. Nothing was published.',
        },
      });
    }
    if (put.code === 'github_unavailable') {
      return json(504, {
        status: 'timeout',
        error: {
          code: 'timeout',
          message: 'The publishing request timed out or could not reach GitHub. Your draft is safe. Retry to reconcile.',
        },
      });
    }
    return json(500, {
      status: 'server_error',
      error: {
        code: 'server_error',
        message: 'The GitHub request failed. Your draft is safe.',
      },
    });
  }

  private markCommitted(row: PublishRow, commit: CommitRecord, now: number): void {
    this.sql().exec(
      `UPDATE publishes SET status = 'committed', commit_sha = ?, commit_url = ?, committed_at = ?
       WHERE draft_id = ? AND content_hash = ?`,
      commit.sha,
      commit.htmlUrl,
      now,
      row.draft_id,
      row.content_hash,
    );
    this.sql().exec(
      `INSERT INTO path_claims (path, draft_id, content_hash, commit_sha, committed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET draft_id = excluded.draft_id,
         content_hash = excluded.content_hash, commit_sha = excluded.commit_sha,
         committed_at = excluded.committed_at`,
      row.path,
      row.draft_id,
      row.content_hash,
      commit.sha,
      now,
    );
  }

  private async reconcilePath(
    config: AuthorGitHubConfig,
    token: string,
    path: string,
    markdown: string,
    draftId: string,
    contentHash: string,
    deadlineAt: number,
  ): Promise<
    | { kind: 'found'; commit: CommitRecord }
    | { kind: 'missing' }
    | { kind: 'conflict'; commit: CommitRecord | null }
    | { kind: 'error'; response: Response }
  > {
    const readTimeout = this.githubCallTimeout(deadlineAt, 8_000);
    if (readTimeout === null) {
      return { kind: 'error', response: this.publishTimeoutResponse() };
    }
    const remote = await getContents(config, token, path, readTimeout);
    if (!remote.ok) {
      if (deadlineRemainingMs(deadlineAt) <= 0) {
        return { kind: 'error', response: this.publishTimeoutResponse() };
      }
      return { kind: 'error', response: this.contentsErrorResponse(remote) };
    }
    if (!remote.exists) {
      return { kind: 'missing' };
    }
    if (remote.file.contentText !== markdown) {
      return { kind: 'conflict', commit: null };
    }
    const commitsTimeout = this.githubCallTimeout(deadlineAt, 8_000);
    if (commitsTimeout === null) {
      return { kind: 'error', response: this.publishTimeoutResponse() };
    }
    const commits = await listCommitsForPath(config, token, path, 5, commitsTimeout);
    if (!commits.ok) {
      if (deadlineRemainingMs(deadlineAt) <= 0) {
        return { kind: 'error', response: this.publishTimeoutResponse() };
      }
      return {
        kind: 'error',
        response: json(502, {
          status: 'server_error',
          error: { code: 'server_error', message: 'The GitHub commit list could not be read. Your draft is safe.' },
        }),
      };
    }
    const match = commits.commits.find((commit) => commitLooksOwned(commit, draftId, contentHash));
    if (match) {
      return { kind: 'found', commit: match };
    }
    return { kind: 'conflict', commit: commits.commits[0] ?? null };
  }

  private contentsErrorResponse(
    error: Extract<Awaited<ReturnType<typeof getContents>>, { ok: false }>,
  ): Response {
    switch (error.code) {
      case 'token_invalid':
        return json(401, {
          status: 'expired',
          error: { code: 'expired', message: AUTH_MESSAGES.expired },
          clearCookie: true,
        });
      case 'rate_limited':
        return json(429, {
          status: 'rate_limited',
          error: { code: 'rate_limited', message: "GitHub's rate limit was reached. Try again later." },
          retryAfterSeconds: error.retryAfterSeconds ?? 60,
        });
      case 'permission_denied':
        return json(403, {
          status: 'permission_denied',
          error: {
            code: 'permission_denied',
            message: 'The GitHub App cannot read or write this repository. Nothing was published.',
          },
        });
      case 'not_found':
        return json(404, {
          status: 'not_found',
          error: {
            code: 'not_found',
            message: 'The target repository or branch could not be found. Nothing was published.',
          },
        });
      case 'server_error':
        return json(500, {
          status: 'server_error',
          error: {
            code: 'server_error',
            message: 'The GitHub request failed. Your draft is safe.',
          },
        });
      default:
        return json(504, {
          status: 'timeout',
          error: {
            code: 'timeout',
            message: 'The GitHub request timed out. Your draft is safe. Retry to reconcile.',
          },
        });
    }
  }

  private conflictResponse(
    config: AuthorGitHubConfig,
    path: string,
    commit: CommitRecord | null,
  ): Response {
    return json(409, {
      status: 'conflict',
      error: {
        code: 'conflict',
        message:
          'A different post already exists at this path. Nothing was overwritten. Your draft is safe.',
      },
      existing: path
        ? {
            path,
            url: commit?.htmlUrl || brandPath(config, path),
          }
        : null,
    });
  }

  private validationResponse(issues: PublishIssue[]): Response {
    return json(422, {
      status: 'validation_error',
      error: {
        code: 'validation_error',
        message: 'The post could not be published. Check the highlighted fields.',
      },
      errors: issues,
    });
  }

  private successResponse(
    config: AuthorGitHubConfig,
    row: PublishRow,
    duplicate: boolean,
  ): Response {
    return json(duplicate ? 200 : 201, {
      status: duplicate ? 'duplicate_ignored' : 'committed',
      duplicate,
      markdown: row.markdown,
      visibleMarkdown: row.visible_markdown,
      frontMatter: row.front_matter,
      date: row.date,
      timestamp: row.timestamp,
      commit: {
        sha: row.commit_sha ?? '',
        committedAt: row.committed_at ? new Date(row.committed_at).toISOString() : '',
        path: row.path,
        fileName: row.file_name,
        url: row.commit_url ?? '',
      },
      deployment: {
        status: 'pending',
        message: DEPLOYMENT_PENDING_MESSAGE,
        actionsUrl: `https://github.com/${config.repoFullName}/actions`,
      },
    });
  }

  private duplicateResponse(config: AuthorGitHubConfig, row: PublishRow): Response {
    return this.successResponse(config, row, true);
  }
}
