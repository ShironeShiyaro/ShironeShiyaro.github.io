/**
 * Minimal GitHub REST client for the single-author publish flow.
 *
 * - Uses only a GitHub App user access token for writes; never requests an
 *   installation token and never uses an App private key.
 * - The token is only ever placed in the `Authorization` request header.
 * - Response bodies are mapped to fixed English error codes; nothing from the
 *   response is logged or forwarded verbatim to the browser.
 */
import type { AuthorGitHubConfig } from './env.ts';
import { bytesToBase64, base64ToBytes } from './crypto.ts';

export interface GitHubUser {
  login: string;
  id: number;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean; maintain?: boolean; triage?: boolean };
}

export interface GitHubInstallation {
  id: number;
  app_id: number;
  permissions: Record<string, string>;
  suspended_at?: string | null;
  account?: { login?: string; id?: number };
}

interface RawFetchSuccess {
  ok: true;
  status: number;
  headers: Headers;
  body: unknown;
}

interface RawFetchFailure {
  ok: false;
  kind: 'timeout' | 'network';
  status?: number;
}

type RawFetchResult = RawFetchSuccess | RawFetchFailure;

const USER_AGENT = 'SelfPage-Author';
const API_VERSION = '2022-11-28';

async function requestJson(
  config: AuthorGitHubConfig,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT';
    token?: string;
    jsonBody?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<RawFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
  };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.jsonBody !== undefined) {
    headers['content-type'] = 'application/json';
  }
  try {
    const response = await fetch(`${config.apiBase}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.jsonBody === undefined ? undefined : JSON.stringify(options.jsonBody),
      signal: controller.signal,
    });
    let body: unknown = null;
    const text = await response.text();
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { ok: true, status: response.status, headers: response.headers, body };
  } catch {
    return {
      ok: false,
      kind: controller.signal.aborted ? 'timeout' : 'network',
    };
  } finally {
    clearTimeout(timer);
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts GitHub's own error text for local classification only. It is never
 * logged and never forwarded to the browser.
 */
function errorText(body: unknown): string {
  if (!isRecord(body)) {
    return '';
  }
  const parts: string[] = [];
  if (typeof body.message === 'string') {
    parts.push(body.message);
  }
  if (Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      if (isRecord(entry) && typeof entry.message === 'string') {
        parts.push(entry.message);
      }
    }
  }
  return parts.join(' ').slice(0, 4_096).toLowerCase();
}

/**
 * Classifies a Contents API 422 without trusting the response text downstream.
 *
 * GitHub uses 422 for unrelated outcomes: a missing `sha` when the file already
 * exists, protected-branch rejections, and repository-rule violations. Only a
 * message that explicitly names branch protection becomes `branch_protected`;
 * every other 422 is `write_rejected`, and the caller must check whether the
 * file actually exists before it may report a conflict.
 */
export function classifyUnprocessablePut(body: unknown): 'branch_protected' | 'write_rejected' {
  const text = errorText(body);
  if (
    text.includes('protected branch') ||
    text.includes('branch protection') ||
    text.includes('branch is protected') ||
    text.includes('protected ref')
  ) {
    return 'branch_protected';
  }
  return 'write_rejected';
}

function parseLinkNext(header: string | null): string | null {
  if (!header) {
    return null;
  }
  const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(header);
  return match?.[1] ?? null;
}

async function getPaginated<T>(
  config: AuthorGitHubConfig,
  path: string,
  token: string,
  maximumPages: number,
): Promise<{ ok: true; items: T[] } | { ok: false; status: number }> {
  const items: T[] = [];
  let next: string | null = `${config.apiBase}${path}`;
  for (let page = 0; page < maximumPages && next !== null; page += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(next, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': USER_AGENT,
          'x-github-api-version': API_VERSION,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, status: response.status };
      }
      const payload = (await response.json()) as unknown;
      if (Array.isArray(payload)) {
        items.push(...(payload as T[]));
      } else if (payload !== null && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        for (const key of ['items', 'installations', 'repositories']) {
          if (Array.isArray(record[key])) {
            items.push(...(record[key] as T[]));
            break;
          }
        }
      }
      next = parseLinkNext(response.headers.get('link'));
    } catch {
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, items };
}

export interface TokenResult {
  accessToken: string;
  expiresInSeconds: number;
}

export type ExchangeResult =
  | { ok: true; token: TokenResult }
  | { ok: false; kind: 'unavailable' | 'denied' | 'oauth_error' | 'configuration'; githubCode?: string };

/** Exchanges a web-flow code for a user access token, discarding the refresh token. */
export async function exchangeOAuthCode(
  config: AuthorGitHubConfig,
  input: { code: string; redirectUri: string; verifier: string; repositoryId: number },
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    repository_id: String(input.repositoryId),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${config.oauthBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, kind: 'unavailable' };
    }
    const payload = (await response.json()) as unknown;
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, kind: 'unavailable' };
    }
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string') {
      const code = /^[a-z_]{1,64}$/u.test(record.error) ? record.error : 'oauth_error';
      return { ok: false, kind: code === 'access_denied' ? 'denied' : 'oauth_error', githubCode: code };
    }
    const accessToken = record.access_token;
    if (typeof accessToken !== 'string' || !/^[A-Za-z0-9_]{16,512}$/u.test(accessToken)) {
      return { ok: false, kind: 'oauth_error' };
    }
    if (typeof record.token_type === 'string' && record.token_type.toLowerCase() !== 'bearer') {
      return { ok: false, kind: 'oauth_error' };
    }
    const expiresIn =
      typeof record.expires_in === 'number' && Number.isFinite(record.expires_in)
        ? Math.min(28_800, Math.max(60, Math.floor(record.expires_in)))
        : 28_800;
    return { ok: true, token: { accessToken, expiresInSeconds: expiresIn } };
  } catch {
    return { ok: false, kind: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export type AccessCheck =
  | { ok: true; user: GitHubUser; repo: GitHubRepo; installation: GitHubInstallation }
  | {
      ok: false;
      code:
        | 'token_invalid'
        | 'forbidden'
        | 'app_not_installed'
        | 'repo_not_selected'
        | 'contents_read_only'
        | 'no_push'
        | 'repo_unavailable'
        | 'permission_check_failed'
        | 'github_unavailable';
    };

/**
 * Verifies the token's actual identity/repository/permission intersection.
 *
 * A user access token only has the intersection of the App's installation
 * permissions and the user's repository permission. Both sides are checked:
 * installation `contents: write` and repository `permissions.push === true`.
 */
export async function checkAccess(
  config: AuthorGitHubConfig,
  token: string,
): Promise<AccessCheck> {
  const userResponse = await requestJson(config, '/user', { token, timeoutMs: 6_000 });
  if (!userResponse.ok) {
    return { ok: false, code: 'github_unavailable' };
  }
  if (userResponse.status === 401) {
    return { ok: false, code: 'token_invalid' };
  }
  if (userResponse.status !== 200) {
    return { ok: false, code: 'github_unavailable' };
  }
  const userRecord = userResponse.body as Record<string, unknown> | null;
  const userId = numberOrNull(userRecord?.id);
  const userLogin = typeof userRecord?.login === 'string' ? userRecord.login : '';
  if (userId === null || userLogin === '') {
    return { ok: false, code: 'github_unavailable' };
  }
  if (userId !== config.allowedUserId) {
    return { ok: false, code: 'forbidden' };
  }

  const installations = await getPaginated<GitHubInstallation>(
    config,
    '/user/installations?per_page=100',
    token,
    3,
  );
  if (!installations.ok) {
    if (installations.status === 401) {
      return { ok: false, code: 'token_invalid' };
    }
    return { ok: false, code: 'permission_check_failed' };
  }

  const appInstallations = installations.items.filter(
    (installation) =>
      numberOrNull(installation.app_id) === config.appId &&
      (installation.suspended_at === null || installation.suspended_at === undefined),
  );
  if (appInstallations.length === 0) {
    return { ok: false, code: 'app_not_installed' };
  }

  let matchedInstallation: GitHubInstallation | null = null;
  for (const installation of appInstallations) {
    const installationId = numberOrNull(installation.id);
    if (installationId === null) {
      continue;
    }
    const repositories = await getPaginated<GitHubRepo>(
      config,
      `/user/installations/${installationId}/repositories?per_page=100`,
      token,
      5,
    );
    if (!repositories.ok) {
      if (repositories.status === 401) {
        return { ok: false, code: 'token_invalid' };
      }
      return { ok: false, code: 'permission_check_failed' };
    }
    if (repositories.items.some((repo) => numberOrNull(repo.id) === config.allowedRepoId)) {
      matchedInstallation = installation;
      break;
    }
  }
  if (matchedInstallation === null) {
    return { ok: false, code: 'repo_not_selected' };
  }

  const contents = matchedInstallation.permissions?.contents;
  if (contents !== 'write') {
    return { ok: false, code: 'contents_read_only' };
  }

  const repoResponse = await requestJson(
    config,
    `/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}`,
    { token, timeoutMs: 6_000 },
  );
  if (!repoResponse.ok) {
    return { ok: false, code: 'github_unavailable' };
  }
  if (repoResponse.status === 401) {
    return { ok: false, code: 'token_invalid' };
  }
  if (repoResponse.status === 404) {
    return { ok: false, code: 'repo_unavailable' };
  }
  if (repoResponse.status !== 200) {
    return { ok: false, code: 'github_unavailable' };
  }
  const repoRecord = repoResponse.body as Record<string, unknown> | null;
  const repoId = numberOrNull(repoRecord?.id);
  const fullName = typeof repoRecord?.full_name === 'string' ? repoRecord.full_name : '';
  const permissions = repoRecord?.permissions as Record<string, unknown> | undefined;
  if (repoId !== config.allowedRepoId || fullName.toLowerCase() !== config.repoFullName.toLowerCase()) {
    return { ok: false, code: 'repo_unavailable' };
  }
  if (permissions?.push !== true) {
    return { ok: false, code: 'no_push' };
  }

  const repo = repoResponse.body as GitHubRepo;
  return {
    ok: true,
    user: { login: userLogin, id: userId },
    repo,
    installation: matchedInstallation,
  };
}

export interface RemoteFile {
  sha: string;
  contentText: string;
  htmlUrl: string;
}

export type ContentsResult =
  | { ok: true; exists: false }
  | { ok: true; exists: true; file: RemoteFile }
  | {
      ok: false;
      code:
        | 'token_invalid'
        | 'not_found'
        | 'rate_limited'
        | 'permission_denied'
        | 'server_error'
        | 'github_unavailable';
      retryAfterSeconds?: number;
    };

function retryAfterSeconds(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const parsed = Number(retryAfter);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(3_600, Math.ceil(parsed));
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null) {
    const parsed = Number(reset);
    if (Number.isFinite(parsed)) {
      const delta = Math.ceil(parsed - Date.now() / 1_000);
      if (delta > 0) {
        return Math.min(3_600, delta);
      }
    }
  }
  return undefined;
}

function mapContentsError(status: number, headers: Headers): Extract<ContentsResult, { ok: false }> {
  if (status === 401) {
    return { ok: false, code: 'token_invalid' };
  }
  if (status === 403 || status === 429) {
    const retry = retryAfterSeconds(headers);
    if (headers.get('x-ratelimit-remaining') === '0' || status === 429) {
      return { ok: false, code: 'rate_limited', retryAfterSeconds: retry };
    }
    return { ok: false, code: 'permission_denied' };
  }
  if (status === 404) {
    return { ok: false, code: 'not_found' };
  }
  if (status >= 500) {
    return { ok: false, code: 'server_error' };
  }
  return { ok: false, code: 'github_unavailable' };
}

export async function getContents(
  config: AuthorGitHubConfig,
  token: string,
  path: string,
  timeoutMs = 8_000,
): Promise<ContentsResult> {
  const response = await requestJson(
    config,
    `/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`,
    { token, timeoutMs },
  );
  if (!response.ok) {
    return { ok: false, code: 'github_unavailable' };
  }
  if (response.status === 404) {
    return { ok: true, exists: false };
  }
  if (response.status !== 200) {
    return mapContentsError(response.status, response.headers);
  }
  const record = response.body as Record<string, unknown> | null;
  if (
    !record ||
    record.type !== 'file' ||
    typeof record.content !== 'string' ||
    typeof record.sha !== 'string'
  ) {
    return { ok: false, code: 'github_unavailable' };
  }
  let contentText = '';
  try {
    contentText = new TextDecoder().decode(base64ToBytes(record.content.replace(/\n/gu, '')));
  } catch {
    return { ok: false, code: 'github_unavailable' };
  }
  return {
    ok: true,
    exists: true,
    file: {
      sha: record.sha,
      contentText,
      htmlUrl: typeof record.html_url === 'string' ? record.html_url : '',
    },
  };
}

export type PutResult =
  | { ok: true; commitSha: string; commitUrl: string; contentUrl: string }
  | {
      ok: false;
      code:
        | 'token_invalid'
        | 'not_found'
        | 'rate_limited'
        | 'permission_denied'
        | 'conflict'
        | 'branch_protected'
        | 'write_rejected'
        | 'validation_failed'
        | 'server_error'
        | 'github_unavailable';
      retryAfterSeconds?: number;
    };

export interface CommitRecord {
  sha: string;
  htmlUrl: string;
  message: string;
  committedAt: string;
}

export async function listCommitsForPath(
  config: AuthorGitHubConfig,
  token: string,
  path: string,
  perPage = 10,
  timeoutMs = 8_000,
): Promise<{ ok: true; commits: CommitRecord[] } | { ok: false; status: number }> {
  const response = await requestJson(
    config,
    `/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(config.branch)}&per_page=${perPage}`,
    { token, timeoutMs },
  );
  if (!response.ok) {
    return { ok: false, status: 0 };
  }
  if (response.status !== 200 || !Array.isArray(response.body)) {
    return { ok: false, status: response.status };
  }
  const commits: CommitRecord[] = [];
  for (const item of response.body as Array<Record<string, unknown>>) {
    const sha = typeof item.sha === 'string' ? item.sha : '';
    const commit = item.commit as Record<string, unknown> | undefined;
    const message = typeof commit?.message === 'string' ? commit.message : '';
    const htmlUrl = typeof item.html_url === 'string' ? item.html_url : '';
    const committer = commit?.committer as Record<string, unknown> | undefined;
    const committedAt = typeof committer?.date === 'string' ? committer.date : '';
    if (sha !== '') {
      commits.push({ sha, htmlUrl, message, committedAt });
    }
  }
  return { ok: true, commits };
}

export async function putContents(
  config: AuthorGitHubConfig,
  token: string,
  input: { path: string; message: string; markdown: string },
  timeoutMs = 12_000,
): Promise<PutResult> {
  const response = await requestJson(
    config,
    `/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/contents/${encodePath(input.path)}`,
    {
      method: 'PUT',
      token,
      timeoutMs,
      jsonBody: {
        message: input.message,
        content: bytesToBase64(new TextEncoder().encode(input.markdown)),
        branch: config.branch,
      },
    },
  );
  if (!response.ok) {
    return { ok: false, code: 'github_unavailable' };
  }
  if (response.status === 401) {
    return { ok: false, code: 'token_invalid' };
  }
  if (response.status === 404) {
    return { ok: false, code: 'not_found' };
  }
  if (response.status === 403 || response.status === 429) {
    const retry = retryAfterSeconds(response.headers);
    if (response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429) {
      return { ok: false, code: 'rate_limited', retryAfterSeconds: retry };
    }
    return { ok: false, code: 'permission_denied' };
  }
  if (response.status === 409) {
    return { ok: false, code: 'conflict' };
  }
  if (response.status === 422) {
    // 422 is ambiguous: it can mean "file already exists" (missing sha) or a
    // protected-branch/repository-rule rejection. Never report a conflict from
    // the status alone; classify and let the caller verify the file.
    return { ok: false, code: classifyUnprocessablePut(response.body) };
  }
  if (response.status === 400) {
    return { ok: false, code: 'validation_failed' };
  }
  if (response.status >= 500) {
    return { ok: false, code: 'server_error' };
  }
  if (response.status !== 201 && response.status !== 200) {
    return { ok: false, code: 'github_unavailable' };
  }
  const record = response.body as Record<string, unknown> | null;
  const commit = record?.commit as Record<string, unknown> | undefined;
  const sha = typeof commit?.sha === 'string' ? commit.sha : '';
  const commitUrl =
    typeof commit?.html_url === 'string'
      ? commit.html_url
      : `https://github.com/${config.repoFullName}/commit/${sha}`;
  const content = record?.content as Record<string, unknown> | undefined;
  const contentUrl = typeof content?.html_url === 'string' ? content.html_url : '';
  if (sha === '') {
    return { ok: false, code: 'github_unavailable' };
  }
  return { ok: true, commitSha: sha, commitUrl, contentUrl };
}

export type DeploymentResult =
  | {
      ok: true;
      status: 'pending' | 'deployed' | 'failed' | 'unconfirmed';
      conclusion?: string;
      runUrl?: string;
      message: string;
    }
  | {
      ok: false;
      status: 'unconfirmed';
      message: string;
      retryAfterSeconds?: number;
    };

const DEPLOYMENT_MESSAGES = {
  pending: 'The commit exists, but the deployment is still pending. The post is not live yet.',
  deployed: 'The commit exists and the deployment completed successfully.',
  failed: 'The commit exists, but the deployment failed. The post is not live.',
  unconfirmed:
    'The commit exists, but the deployment status could not be confirmed. Check the Actions page.',
} as const;

interface WorkflowRun {
  status?: string;
  conclusion?: string | null;
  html_url?: string;
}

const ACTIVE_RUN_STATUSES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
]);

const TERMINAL_RUN_CONCLUSIONS = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'neutral',
  'stale',
  'timed_out',
  'action_required',
]);

/** The only conclusions that may produce a user-visible `failed` (A19). */
const EXPLICIT_FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled']);

type DeploymentClassification =
  | { status: 'pending' }
  | { status: 'deployed'; conclusion: string; runUrl?: string }
  | { status: 'failed'; conclusion: string; runUrl?: string }
  | { status: 'unconfirmed' };

/**
 * Conservative aggregation of all workflow runs for one commit.
 *
 * The same SHA can carry several runs (a failed deploy plus its successful
 * re-run, or an unrelated lint workflow). A19 requires that only an explicit
 * failure of the deployment source is reported as `failed`, so:
 * - any still-running run keeps the result `pending`, even if another run
 *   already succeeded (a re-run must not be hidden);
 * - a success anywhere means the deployment is `deployed`;
 * - `failed` requires every run to be terminal AND an explicit
 *   failure/cancelled run AND no success;
 * - everything else (skipped/neutral/unknown) stays `unconfirmed`.
 */
function classifyWorkflowRuns(runs: WorkflowRun[]): DeploymentClassification {
  if (runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status ?? ''))) {
    return { status: 'pending' };
  }
  const successRun = runs.find((run) => run.conclusion === 'success');
  if (successRun) {
    return {
      status: 'deployed',
      conclusion: 'success',
      ...(successRun.html_url ? { runUrl: successRun.html_url } : {}),
    };
  }
  const failureRun = runs.find((run) =>
    EXPLICIT_FAILURE_CONCLUSIONS.has(run.conclusion ?? ''),
  );
  const allTerminal = runs.every((run) =>
    TERMINAL_RUN_CONCLUSIONS.has(run.conclusion ?? ''),
  );
  if (allTerminal && failureRun) {
    return {
      status: 'failed',
      conclusion: failureRun.conclusion ?? 'failure',
      ...(failureRun.html_url ? { runUrl: failureRun.html_url } : {}),
    };
  }
  return { status: 'unconfirmed' };
}

/** Reads public Actions runs for a commit without authentication. */
export async function checkDeployments(
  config: AuthorGitHubConfig,
  commitSha: string,
): Promise<DeploymentResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      `${config.apiBase}/repos/${encodeURIComponent(config.repoOwner)}/${encodeURIComponent(config.repoName)}/actions/runs?head_sha=${encodeURIComponent(commitSha)}&per_page=20`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': USER_AGENT,
          'x-github-api-version': API_VERSION,
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return {
        ok: false,
        status: 'unconfirmed',
        message: DEPLOYMENT_MESSAGES.unconfirmed,
        ...(response.status === 403 || response.status === 429
          ? { retryAfterSeconds: retryAfterSeconds(response.headers) }
          : {}),
      };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const runs = Array.isArray(payload.workflow_runs)
      ? (payload.workflow_runs as WorkflowRun[]).filter(
          (run) => typeof run === 'object' && run !== null,
        )
      : [];
    if (runs.length === 0) {
      return { ok: true, status: 'pending', message: DEPLOYMENT_MESSAGES.pending };
    }
    const classified = classifyWorkflowRuns(runs);
    switch (classified.status) {
      case 'pending':
        return { ok: true, status: 'pending', message: DEPLOYMENT_MESSAGES.pending };
      case 'deployed':
        return {
          ok: true,
          status: 'deployed',
          conclusion: classified.conclusion,
          ...(classified.runUrl ? { runUrl: classified.runUrl } : {}),
          message: DEPLOYMENT_MESSAGES.deployed,
        };
      case 'failed':
        return {
          ok: true,
          status: 'failed',
          conclusion: classified.conclusion,
          ...(classified.runUrl ? { runUrl: classified.runUrl } : {}),
          message: DEPLOYMENT_MESSAGES.failed,
        };
      default:
        return {
          ok: false,
          status: 'unconfirmed',
          message: DEPLOYMENT_MESSAGES.unconfirmed,
        };
    }
  } catch {
    return { ok: false, status: 'unconfirmed', message: DEPLOYMENT_MESSAGES.unconfirmed };
  } finally {
    clearTimeout(timer);
  }
}
