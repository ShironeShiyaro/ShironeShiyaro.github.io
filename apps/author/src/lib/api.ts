/**
 * The author client's only network boundary.
 *
 * Two modes exist and are selected by the server, never by the browser:
 * - production / real integration: `/api/session`, `/api/logout`, `/api/posts`,
 *   `/api/deployments/<sha>` and `/auth/github/start`;
 * - task 06 mock suite: `/api/mock/*` (served only by APP_ENV=test without a
 *   test GitHub base URL).
 *
 * Tokens never reach this module: real responses only carry an opaque session
 * cookie (HttpOnly) and a CSRF token held in memory.
 */
import type {
  ClockResponse,
  DateResponse,
  DeploymentResponse,
  MockAuthOutcome,
  MockAuthResponse,
  MockSessionResponse,
  PublishErrorResponse,
  PublishRequestBody,
  PublishSuccessResponse,
  RealPublishRequestBody,
  SessionResponse,
} from '../../worker/contracts.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const JSON_HEADERS = { accept: 'application/json', 'content-type': 'application/json' } as const;

/** Reads the server-owned Asia/Shanghai publication date. */
export async function fetchPublicationDate(signal?: AbortSignal): Promise<DateResponse> {
  const response = await fetch('/api/date', {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(`The publication date request failed (HTTP ${response.status}).`, response.status, body);
  }
  return body as DateResponse;
}

/**
 * Reads the mock session. A 404 means this deployment has no mock auth surface
 * (production or real integration mode), so the editor reports authorization as
 * unavailable instead of offering a button that cannot work.
 */
export async function fetchMockSession(signal?: AbortSignal): Promise<MockSessionResponse | null> {
  const response = await fetch('/api/mock/session', {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });
  if (response.status === 404) {
    return null;
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(`The session request failed (HTTP ${response.status}).`, response.status, body);
  }
  return body as MockSessionResponse;
}

export type SessionState =
  | { mode: 'mock'; session: MockSessionResponse }
  | { mode: 'github'; session: SessionResponse }
  | { mode: 'unavailable' };

/**
 * Reads the mode hint the Worker injects into the served HTML (P2-3). The mock
 * surface and the real session route are mutually exclusive, so this lets a
 * real deployment skip the `/api/mock/session` probe entirely instead of logging
 * a 404 on every load. When the meta is absent (an older cached document) the
 * probe order below is used unchanged.
 */
function servedAuthorMode(): 'mock' | 'github' | null {
  if (typeof document === 'undefined') return null;
  const value = document
    .querySelector('meta[name="selfpage-author-mode"]')
    ?.getAttribute('content');
  return value === 'mock' || value === 'github' ? value : null;
}

async function fetchRealSession(signal?: AbortSignal): Promise<SessionState> {
  const response = await fetch('/api/session', {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });
  if (response.status === 404) {
    return { mode: 'unavailable' };
  }
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(`The session request failed (HTTP ${response.status}).`, response.status, body);
  }
  return { mode: 'github', session: body as SessionResponse };
}

/**
 * Detects the server mode. Mock mode probes the task 06 mock endpoint first (the
 * 06 suite depends on that request and its timeout); a real deployment is known
 * from the served mode hint and talks only to `/api/session`.
 */
export async function fetchSessionState(signal?: AbortSignal): Promise<SessionState> {
  if (servedAuthorMode() === 'github') {
    return fetchRealSession(signal);
  }
  const mockSession = await fetchMockSession(signal);
  if (mockSession !== null) {
    return { mode: 'mock', session: mockSession };
  }
  return fetchRealSession(signal);
}

/** Starts the real GitHub App web flow with a full-page same-origin navigation. */
export function startGitHubAuthorization(options: { switchAccount?: boolean } = {}): void {
  window.location.assign(options.switchAccount ? '/auth/github/start?switch=1' : '/auth/github/start');
}

export interface MockAuthResult {
  status: number;
  body: (MockAuthResponse & { error?: { code: string; message?: string } }) | null;
}

/** Explicit mock GitHub authorization; never called automatically. */
export async function authorizeWithMock(
  outcome: MockAuthOutcome,
  signal?: AbortSignal,
): Promise<MockAuthResult> {
  const response = await fetch('/api/mock/auth', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ outcome }),
    signal,
  });
  return {
    status: response.status,
    body: (await readJson(response)) as MockAuthResult['body'],
  };
}

export async function logoutMock(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch('/api/mock/logout', {
    method: 'POST',
    headers: { accept: 'application/json' },
    signal,
  });
  return response.ok;
}

export interface LogoutResult {
  status: number;
  body: { status?: string; error?: { code?: string; message?: string } } | null;
}

/** Revokes the real session; the CSRF token comes from `/api/session`. */
export async function logoutSession(csrfToken: string, signal?: AbortSignal): Promise<LogoutResult> {
  const response = await fetch('/api/logout', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'x-csrf-token': csrfToken },
    signal,
  });
  return {
    status: response.status,
    body: (await readJson(response)) as LogoutResult['body'],
  };
}

export interface PublishResult {
  status: number;
  body: PublishSuccessResponse | PublishErrorResponse | null;
}

/** Sends the structured draft to the task 06 mock publish endpoint. */
export async function publishDraft(
  payload: PublishRequestBody,
  signal?: AbortSignal,
): Promise<PublishResult> {
  const response = await fetch('/api/mock/publish', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
    signal,
  });
  return {
    status: response.status,
    body: (await readJson(response)) as PublishResult['body'],
  };
}

/** Sends the structured draft to the real same-origin publish endpoint. */
export async function publishRealDraft(
  payload: RealPublishRequestBody,
  csrfToken: string,
  signal?: AbortSignal,
): Promise<PublishResult> {
  const response = await fetch('/api/posts', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'x-csrf-token': csrfToken },
    body: JSON.stringify(payload),
    signal,
  });
  return {
    status: response.status,
    body: (await readJson(response)) as PublishResult['body'],
  };
}

export interface DeploymentResult {
  status: number;
  body: DeploymentResponse | { error?: string; message?: string } | null;
}

/** User-triggered deployment check; never polled automatically. */
export async function fetchDeployment(
  commitSha: string,
  signal?: AbortSignal,
): Promise<DeploymentResult> {
  const response = await fetch(`/api/deployments/${encodeURIComponent(commitSha)}`, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal,
  });
  return {
    status: response.status,
    body: (await readJson(response)) as DeploymentResult['body'],
  };
}

/** Test-only clock control, used by the E2E runner and manual verification. */
export async function setTestClock(
  now: string | { reset: true },
  signal?: AbortSignal,
): Promise<ClockResponse> {
  const response = await fetch('/api/test/clock', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(now),
    signal,
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new ApiError(`The test clock request failed (HTTP ${response.status}).`, response.status, body);
  }
  return body as ClockResponse;
}
