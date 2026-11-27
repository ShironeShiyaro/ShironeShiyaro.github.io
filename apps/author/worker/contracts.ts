/**
 * HTTP contract shared by the author client and the same-origin Worker.
 *
 * Task 06 mock shapes are kept verbatim so its E2E suite still passes. Task 07
 * adds the real GitHub session/publish/deployment response types.
 */
import type { MarkdownError } from '@selfpage/markdown';

export interface HealthResponse {
  status: 'ok';
  service: 'selfpage-author';
  version: string;
}

export interface DateResponse {
  /** Asia/Shanghai calendar date, `YYYY-MM-DD`. */
  date: string;
  timeZone: 'Asia/Shanghai';
}

/** Mock authorization outcomes that task 06 can render as terminal states. */
export const MOCK_AUTH_OUTCOMES = [
  'authorized',
  'cancelled',
  'forbidden',
  'expired',
  'permission_denied',
] as const;

export type MockAuthOutcome = (typeof MOCK_AUTH_OUTCOMES)[number];

/** Terminal authorization states (pending is client-only). */
export type AuthStatus = 'anonymous' | 'authorized' | 'cancelled' | 'forbidden' | 'expired' | 'permission_denied';

export interface MockUser {
  login: string;
  id: number;
}

export interface MockSessionResponse {
  status: 'anonymous' | 'authorized';
  user?: MockUser;
}

export interface MockAuthRequest {
  outcome?: MockAuthOutcome;
}

export interface MockAuthResponse {
  status: Exclude<AuthStatus, 'anonymous'>;
  user?: MockUser;
}

/** Mock publish simulations used by the test-only controls and E2E. */
export const MOCK_PUBLISH_OUTCOMES = [
  'auto',
  'conflict',
  'rate_limited',
  'server_error',
  'timeout',
  'expired',
  'permission_denied',
  'deploy_failed',
  'deploy_unconfirmed',
  'slow',
] as const;

export type MockPublishOutcome = (typeof MOCK_PUBLISH_OUTCOMES)[number];

export interface PublishRequestBody {
  title: string;
  body: string;
  draftId: string;
  /** Test-only simulation selector; ignored in production (route is 404). */
  mockOutcome?: MockPublishOutcome;
}

export type DeploymentStatus = 'pending' | 'deployed' | 'failed' | 'unconfirmed';

export interface CommitInfo {
  sha: string;
  committedAt: string;
  /** `content/blog/YYYY/<file>.md` */
  path: string;
  fileName: string;
  /** GitHub commit page for real publishes. */
  url?: string;
}

export interface ExistingPost {
  path: string;
  url: string;
}

export interface PublishSuccessResponse {
  status: 'committed' | 'duplicate_ignored';
  /** True only for `duplicate_ignored`. */
  duplicate: boolean;
  markdown: string;
  visibleMarkdown: string;
  frontMatter: string;
  date: string;
  timestamp: string;
  commit: CommitInfo;
  deployment: {
    status: DeploymentStatus;
    message: string;
    actionsUrl?: string;
  };
  /** Present on a 409 conflict. */
  existing?: ExistingPost | null;
}

export type PublishErrorStatus =
  | 'validation_error'
  | 'not_authorized'
  | 'expired'
  | 'forbidden'
  | 'permission_denied'
  | 'conflict'
  | 'branch_protected'
  | 'write_rejected'
  | 'not_found'
  | 'rate_limited'
  | 'security_blocked'
  | 'server_error'
  | 'timeout';

/** A publish-time validation issue; extends the task 06 serializer codes. */
export interface PublishValidationIssue {
  code: string;
  field: 'title' | 'body' | 'date' | 'request';
  message: string;
}

export interface PublishErrorResponse {
  status: PublishErrorStatus;
  error: {
    code: string;
    message: string;
  };
  /** Present for `validation_error`. */
  errors?: Array<PublishValidationIssue | MarkdownError>;
  /** Present for `rate_limited`. */
  retryAfterSeconds?: number;
  /** Present for `conflict`. */
  existing?: ExistingPost | null;
  /**
   * Present for `branch_protected` / `write_rejected`: a GitHub settings page
   * where the repository's branch rules can be reviewed.
   */
  reviewUrl?: string;
}

export interface ClockRequest {
  /** RFC 3339 instant. Omit and set `reset` to clear the override. */
  now?: string;
  reset?: boolean;
}

export interface ClockResponse {
  now: string;
  date: string;
  timeZone: 'Asia/Shanghai';
}

/* ------------------------------------------------------------------------- */
/* Task 07 real GitHub API                                                   */
/* ------------------------------------------------------------------------- */

export interface SessionUser {
  login: string;
  id: number;
}

export interface SessionRepo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  branch: string;
}

export type AuthOutcomeStatus =
  | 'cancelled'
  | 'forbidden'
  | 'permission_denied'
  | 'expired'
  | 'state_invalid'
  | 'oauth_error'
  | 'configuration_error';

export interface AuthOutcomeInfo {
  status: AuthOutcomeStatus;
  code: string;
  message: string;
}

export type SessionResponse =
  | {
      status: 'authorized';
      user: SessionUser;
      repo: SessionRepo;
      csrfToken: string;
      expiresAt: string;
      mode?: 'github';
    }
  | {
      status: 'anonymous';
      auth?: AuthOutcomeInfo;
      clearCookie?: boolean;
      mode?: 'github';
    };

/** Body accepted by the real same-origin publish endpoint. */
export interface RealPublishRequestBody {
  title: string;
  body: string;
  draftId: string;
  attemptId: string;
  /** Set only when the user explicitly retries a path conflict at a new second. */
  newTimestamp?: boolean;
}

export interface DeploymentResponse {
  commitSha: string;
  status: DeploymentStatus;
  conclusion?: string;
  message: string;
  runUrl?: string;
  actionsUrl: string;
  commitUrl: string;
  checkedAt: string;
  retryAfterSeconds?: number;
}
