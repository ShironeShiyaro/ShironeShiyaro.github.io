import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { serializePost } from '@selfpage/markdown';
import { requestDrawerClose } from '@selfpage/site-shell/drawer';
import { shellNav } from 'virtual:selfpage-site-nav';
import type {
  AuthOutcomeInfo,
  AuthStatus,
  DeploymentResponse,
  DeploymentStatus,
  ExistingPost,
  MockAuthOutcome,
  MockPublishOutcome,
  MockUser,
  PublishErrorResponse,
  PublishSuccessResponse,
  PublishValidationIssue,
} from '../worker/contracts.ts';
import { findLevelOneHeading } from '../worker/content-guard.ts';
import EditableText from './components/EditableText.tsx';
import SiteShell from './components/SiteShell.tsx';
import {
  authorizeWithMock,
  fetchDeployment,
  fetchPublicationDate,
  fetchSessionState,
  logoutMock,
  logoutSession,
  publishDraft,
  publishRealDraft,
  startGitHubAuthorization,
  type MockAuthResult,
  type PublishResult,
} from './lib/api.ts';
import { PUBLIC_BLOG_URL } from './lib/config.ts';
import {
  clearDraft,
  createDraftId,
  getBrowserDraftStorage,
  hasDraftContent,
  isSameDraft,
  loadDraft,
  saveDraft,
  type DraftSnapshot,
  type DraftStorage,
} from './lib/draft.ts';

const AUTH_TIMEOUT_MS = 12_000;
const GET_TIMEOUT_MS = 12_000;
const PUBLISH_TIMEOUT_MS = 20_000;
const DEPLOYMENT_TIMEOUT_MS = 12_000;
const DRAFT_SAVE_DEBOUNCE_MS = 500;
const DATE_REFRESH_INTERVAL_MS = 60_000;

type AuthUi =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | { kind: 'pending' }
  | { kind: 'authorized'; user: MockUser }
  | { kind: 'cancelled' }
  | { kind: 'forbidden' }
  | { kind: 'expired' }
  | { kind: 'permission_denied' }
  | { kind: 'oauth_error' }
  | { kind: 'timeout' }
  | { kind: 'check_failed' }
  | { kind: 'unavailable' };

type PublishUi =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | { kind: 'conflict'; message: string; existing?: ExistingPost | null }
  | { kind: 'branch_protected'; message: string; reviewUrl?: string }
  | { kind: 'write_rejected'; message: string; reviewUrl?: string }
  | { kind: 'rate_limited'; message: string; retryAfterSeconds?: number }
  | { kind: 'offline'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'expired'; message: string }
  | { kind: 'permission_denied'; message: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'security_blocked'; message: string };

type DeploymentUi =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'result'; response: DeploymentResponse }
  | { kind: 'failed'; message: string };

type SessionMode = 'loading' | 'mock' | 'github' | 'unavailable';

type DateUi = { kind: 'loading' } | { kind: 'ready'; date: string } | { kind: 'error' };

type Route = 'editor' | 'success';

type SuccessKind = 'committed' | 'duplicate' | 'deploy_failed' | 'deploy_unconfirmed';

/**
 * What the success page needs from a finished publish (D32). It holds only
 * public publication data — commit identity, deployment status and the file
 * path — never a token, session id or CSRF value. It survives a refresh in
 * `sessionStorage` and is cleared by the publish flow that replaces it.
 */
interface PublishRecord {
  kind: SuccessKind;
  commit: { sha: string; committedAt: string; path: string; url?: string };
  deployment: { status: DeploymentStatus; message: string; actionsUrl?: string };
  date: string;
  clearedDraft: boolean;
  savedAt: string;
}

const PUBLISH_RECORD_KEY = 'selfpage:publish-result';

function normalizePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** `/new/success` is the only success route of the author SPA. */
function isSuccessPath(pathname: string): boolean {
  return normalizePath(pathname) === '/new/success';
}

function isPublishRecord(value: unknown): value is PublishRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<PublishRecord>;
  return (
    (record.kind === 'committed' ||
      record.kind === 'duplicate' ||
      record.kind === 'deploy_failed' ||
      record.kind === 'deploy_unconfirmed') &&
    typeof record.commit?.sha === 'string' &&
    typeof record.commit.path === 'string' &&
    typeof record.commit.committedAt === 'string' &&
    typeof record.deployment?.status === 'string' &&
    typeof record.deployment.message === 'string' &&
    typeof record.date === 'string' &&
    typeof record.savedAt === 'string'
  );
}

function loadPublishRecord(): PublishRecord | null {
  try {
    const raw = window.sessionStorage.getItem(PUBLISH_RECORD_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPublishRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function savePublishRecord(record: PublishRecord): void {
  try {
    window.sessionStorage.setItem(PUBLISH_RECORD_KEY, JSON.stringify(record));
  } catch {
    // The success page still receives the in-memory record for this visit.
  }
}

/**
 * Review P2-5: the success record survives in sessionStorage, so its URLs are
 * untrusted input by the time the page renders. Only a plain https GitHub URL
 * may become a clickable link; anything else (javascript:, data:, another host)
 * is rendered as text instead.
 */
function safeGithubUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const AUTH_OUTCOME_LABELS: Record<MockAuthOutcome, string> = {
  authorized: 'Authorize as the author',
  cancelled: 'Cancel authorization',
  forbidden: 'Not the configured author',
  expired: 'Expired authorization',
  permission_denied: 'Missing repository permission',
};

const PUBLISH_OUTCOME_LABELS: Record<MockPublishOutcome, string> = {
  auto: 'Automatic (deduplicate by draft and content)',
  conflict: 'Conflict: the path already exists',
  rate_limited: 'Rate limited (429)',
  server_error: 'Server error (500)',
  timeout: 'Timeout (504)',
  expired: 'Expired authorization (401)',
  permission_denied: 'Permission denied (403)',
  deploy_failed: 'Commit succeeds, deployment fails',
  deploy_unconfirmed: 'Commit succeeds, deployment unconfirmed',
  slow: 'Slow response (2.5 seconds)',
};

function BackLink({ testId = 'status-back' }: { testId?: string }) {
  return (
    <a className="back-link" data-testid={testId} href={PUBLIC_BLOG_URL}>
      Back to Blog
    </a>
  );
}

function formatSavedTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCommitTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Shanghai',
  });
}

function messageFrom(error: PublishErrorResponse | null, fallback: string): string {
  return typeof error?.error?.message === 'string' && error.error.message.trim() !== ''
    ? error.error.message
    : fallback;
}

function createAttemptId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reads the server date with a hard upper bound so a stuck proxy cannot spin forever. */
async function fetchDateWithTimeout(): Promise<{ date: string }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
  try {
    return await fetchPublicationDate(controller.signal);
  } finally {
    window.clearTimeout(timer);
  }
}

export default function App() {
  const [storage] = useState<DraftStorage | null>(() => getBrowserDraftStorage());
  const [initialDraft] = useState(() => loadDraft(storage));
  const [storageAvailable, setStorageAvailable] = useState(storage !== null);
  const [title, setTitle] = useState(initialDraft?.title ?? '');
  const [body, setBody] = useState(initialDraft?.body ?? '');
  const [draftId, setDraftId] = useState(initialDraft?.draftId ?? createDraftId());
  const [editorResetToken, setEditorResetToken] = useState(0);
  const [savedAt, setSavedAt] = useState<string | null>(initialDraft?.updatedAt ?? null);
  const [dirty, setDirty] = useState(false);
  const [draftNotice, setDraftNotice] = useState(
    initialDraft ? 'Draft restored from this browser.' : '',
  );
  const [errors, setErrors] = useState<PublishValidationIssue[]>([]);
  const [dateState, setDateState] = useState<DateUi>({ kind: 'loading' });
  const [auth, setAuth] = useState<AuthUi>({ kind: 'loading' });
  const [authMessage, setAuthMessage] = useState('');
  const [sessionMode, setSessionMode] = useState<SessionMode>('loading');
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [mockEnabled, setMockEnabled] = useState(false);
  const [mockAuthOutcome, setMockAuthOutcome] = useState<MockAuthOutcome>('authorized');
  const [mockPublishOutcome, setMockPublishOutcome] = useState<MockPublishOutcome>('auto');
  const [publish, setPublish] = useState<PublishUi>({ kind: 'idle' });
  const [deployment, setDeployment] = useState<DeploymentUi>({ kind: 'idle' });
  const [retryAfterUntil, setRetryAfterUntil] = useState<number | null>(null);
  const [recheckingPermissions, setRecheckingPermissions] = useState(false);
  const [recheckNotice, setRecheckNotice] = useState('');
  const [confirmAction, setConfirmAction] = useState<'discard' | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [notice, setNotice] = useState('');
  // D32: the success page is a same-origin SPA route, so a refresh reads the
  // record back from sessionStorage and a direct visit without state degrades.
  const [route, setRoute] = useState<Route>(() =>
    isSuccessPath(window.location.pathname) ? 'success' : 'editor',
  );
  const [publishRecord, setPublishRecord] = useState<PublishRecord | null>(() =>
    isSuccessPath(window.location.pathname) ? loadPublishRecord() : null,
  );
  // D33: in-app navigation away from an unpublished draft asks first.
  const [pendingLeaveHref, setPendingLeaveHref] = useState<string | null>(null);
  const leavingRef = useRef(false);
  const leaveTriggerRef = useRef<HTMLElement | null>(null);
  const hasUnpublishedDraftRef = useRef(false);

  const titleRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLSpanElement>(null);
  const discardDialogRef = useRef<HTMLDivElement>(null);
  const discardInertRef = useRef<HTMLElement[]>([]);
  const discardConfirmRef = useRef<HTMLButtonElement>(null);
  const discardCancelRef = useRef<HTMLButtonElement>(null);
  const publishStatusRef = useRef<HTMLDivElement>(null);
  const publishGuardRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const publishedSnapshotRef = useRef<DraftSnapshot | null>(null);
  const mountedRef = useRef(true);
  const dateSequenceRef = useRef(0);
  const csrfRef = useRef<string | null>(null);
  const attemptRef = useRef<{ fingerprint: string; attemptId: string } | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const latestRef = useRef<DraftSnapshot>({ draftId, title, body });
  latestRef.current = { draftId, title, body };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Applies a server-authoritative date and invalidates older refreshes. */
  const applyServerDate = (date: string) => {
    dateSequenceRef.current += 1;
    setDateState({ kind: 'ready', date });
  };

  /**
   * Reads `/api/date` with the bounded GET timeout. `silent` keeps a
   * background refresh failure from replacing an already valid date with an
   * error panel; a publish preflight uses its own hard-failing read.
   */
  const loadDate = async (silent: boolean): Promise<string | null> => {
    const sequence = ++dateSequenceRef.current;
    try {
      const response = await fetchDateWithTimeout();
      if (mountedRef.current && sequence === dateSequenceRef.current) {
        setDateState({ kind: 'ready', date: response.date });
      }
      return response.date;
    } catch {
      if (!silent && mountedRef.current && sequence === dateSequenceRef.current) {
        setDateState({ kind: 'error' });
      }
      return null;
    }
  };

  // Initial publication date (bounded) and explicit Retry.
  useEffect(() => {
    setDateState({ kind: 'loading' });
    void loadDate(false);
  }, []);

  // Keep the server-owned date fresh across midnight, tab focus and returning
  // to the page. Failures here are silent; Publish re-reads the date and
  // surfaces a terminal error if it still cannot be loaded.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void loadDate(true);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const interval = window.setInterval(refresh, DATE_REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      window.clearInterval(interval);
    };
  }, []);

  const applyAuthOutcome = (outcome: AuthOutcomeInfo | undefined) => {
    if (!outcome) {
      setAuthMessage('');
      setAuth({ kind: 'anonymous' });
      return;
    }
    setAuthMessage(outcome.message);
    switch (outcome.status) {
      case 'cancelled':
        setAuth({ kind: 'cancelled' });
        return;
      case 'forbidden':
        setAuth({ kind: 'forbidden' });
        return;
      case 'expired':
        setAuth({ kind: 'expired' });
        return;
      case 'permission_denied':
        setAuth({ kind: 'permission_denied' });
        return;
      default:
        setAuth({ kind: 'oauth_error' });
    }
  };

  // The initial authorization check is bounded too: a hung session endpoint
  // must reach an English terminal state with an explicit Retry instead of
  // leaving "Checking GitHub authorization…" forever. The mock endpoint is
  // probed first so the task 06 suite keeps its exact request/timeout contract;
  // production falls through to the real same-origin session.
  useEffect(() => {
    let active = true;
    setAuth({ kind: 'loading' });
    setMockEnabled(false);
    setSessionMode('loading');
    setAuthMessage('');
    csrfRef.current = null;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
    fetchSessionState(controller.signal)
      .then((state) => {
        if (!active) {
          return;
        }
        window.clearTimeout(timer);
        setSessionMode(state.mode);
        if (state.mode === 'unavailable') {
          setAuth({ kind: 'unavailable' });
          return;
        }
        if (state.mode === 'mock') {
          setMockEnabled(true);
          if (state.session.status === 'authorized' && state.session.user) {
            setAuth({ kind: 'authorized', user: state.session.user });
          } else {
            setAuth({ kind: 'anonymous' });
          }
          return;
        }
        if (state.session.status === 'authorized') {
          csrfRef.current = state.session.csrfToken;
          setAuth({ kind: 'authorized', user: state.session.user });
          setAuthMessage('');
        } else {
          applyAuthOutcome(state.session.auth);
        }
      })
      .catch(() => {
        window.clearTimeout(timer);
        if (active) {
          setMockEnabled(false);
          setSessionMode('unavailable');
          setAuth({ kind: 'check_failed' });
        }
      });
    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [sessionAttempt]);

  // Autosave. The published snapshot is never re-saved; any newer edit is.
  useEffect(() => {
    if (!storageAvailable || !storage) {
      return;
    }
    const current = { draftId, title, body };
    const snapshot = publishedSnapshotRef.current;
    if (snapshot && isSameDraft(snapshot, current)) {
      clearDraft(storage);
      setDirty(false);
      return;
    }
    if (!hasDraftContent(title, body)) {
      clearDraft(storage);
      setDirty(false);
      setSavedAt(null);
      return;
    }
    setDirty(true);
    const timer = window.setTimeout(() => {
      saveTimerRef.current = null;
      // A publish response may have cleared this exact draft in the meantime.
      if (publishedSnapshotRef.current && isSameDraft(publishedSnapshotRef.current, latestRef.current)) {
        return;
      }
      const record = saveDraft(storage, current);
      if (record) {
        setSavedAt(record.updatedAt);
        setDirty(false);
      } else {
        setStorageAvailable(false);
        setDraftNotice(
          'Autosave is unavailable because this browser blocked local storage. Keep this tab open or copy your text before leaving this page.',
        );
      }
    }, DRAFT_SAVE_DEBOUNCE_MS);
    saveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (saveTimerRef.current === timer) {
        saveTimerRef.current = null;
      }
    };
  }, [title, body, draftId, storage, storageAvailable]);

  // D33: an unpublished non-empty draft is protected across page unloads. A
  // normal browser refresh or tab close gets the native prompt (its wording is
  // not customisable); in-app navigation uses the custom Leave/Stay modal.
  // A draft that is already stored still counts — the user asked for a
  // confirmation before leaving, not only for unsaved text.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      if (!hasUnpublishedDraftRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // D33: confirm in-app and cross-origin link navigation first. Modified
  // clicks, downloads, `_blank` links and same-document fragment links are not
  // navigations away from the draft.
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const element = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(element instanceof HTMLAnchorElement)) return;
      if (element.target === '_blank' || element.hasAttribute('download')) return;
      const url = new URL(element.href, window.location.href);
      const sameDocument =
        url.origin === window.location.origin &&
        normalizePath(url.pathname) === normalizePath(window.location.pathname);
      if (sameDocument) return;
      if (!hasUnpublishedDraftRef.current) return;
      event.preventDefault();
      leaveTriggerRef.current = element;
      setPendingLeaveHref(url.href);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // D32: history navigation between `/new/` and `/new/success` stays inside the
  // SPA and re-reads the record, so a back/forward never shows a blank page.
  useEffect(() => {
    const onPopState = () => {
      const success = isSuccessPath(window.location.pathname);
      setRoute(success ? 'success' : 'editor');
      setPublishRecord(success ? loadPublishRecord() : null);
      setDeployment({ kind: 'idle' });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    document.title =
      route === 'success'
        ? "Published — Xinyang Zeng's Homepage"
        : "New post — Xinyang Zeng's Homepage";
  }, [route]);

  useEffect(() => {
    if (confirmAction !== null) {
      // P2-2: the initial focus belongs on the safe action. Deleting a draft is
      // destructive and must not be one Enter keypress away by default.
      discardCancelRef.current?.focus();
    }
  }, [confirmAction]);

  // Task 08 (07.5 review P2): the delete-draft confirmation is a real modal, so
  // it needs `aria-modal` AND an inert background. The dialog stays inline in
  // the publish panel (tests and layout rely on that), so every sibling outside
  // the dialog's ancestor chain is made inert while it is open and exactly the
  // elements this effect changed are restored on close. This keeps Tab, pointer
  // and assistive technology out of the rest of the page.
  //
  // The list is also kept in a ref so the close paths can release the background
  // synchronously before moving focus back to the trigger: focusing an element
  // that is still inside an `inert` subtree is ignored by the browser, which
  // left focus on <body> after Escape (task 08 fix round).
  const releaseDiscardInert = (): void => {
    const changed = discardInertRef.current;
    discardInertRef.current = [];
    for (const element of changed) element.removeAttribute('inert');
  };

  /** Closes the modal, then returns focus to its trigger once the DOM settled. */
  const closeDiscardDialog = (): void => {
    // Synchronously first: the trigger is inside the background that the effect
    // made inert, and focus() on an inert subtree is a no-op.
    releaseDiscardInert();
    setConfirmAction(null);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="discard-button"]')?.focus();
    });
  };

  useEffect(() => {
    if (confirmAction !== 'discard') return;
    const dialog = discardDialogRef.current;
    if (!dialog) return;
    const changed: HTMLElement[] = [];
    let node: HTMLElement | null = dialog;
    while (node !== null && node !== document.body) {
      const parent: HTMLElement | null = node.parentElement;
      if (parent === null) break;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node || !(sibling instanceof HTMLElement)) continue;
        if (sibling.hasAttribute('inert')) continue;
        sibling.setAttribute('inert', '');
        changed.push(sibling);
      }
      node = parent;
    }
    discardInertRef.current = changed;
    return releaseDiscardInert;
  }, [confirmAction]);

  // Disabling Publish while the request is in flight blurs it. Once a terminal
  // state renders, move focus to the result so keyboard users are not dropped
  // onto <body> and screen readers announce the outcome.
  useEffect(() => {
    if (publish.kind === 'idle' || publish.kind === 'publishing') {
      return;
    }
    const frame = window.requestAnimationFrame(() => publishStatusRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [publish.kind]);

  // Preview is a lazy chunk so sanitize-html is not in the editor's first load.
  useEffect(() => {
    if (!previewOpen) {
      return;
    }
    let cancelled = false;
    setPreviewFailed(false);
    import('@selfpage/markdown/preview')
      .then((module) => {
        if (!cancelled) {
          setPreviewHtml(module.renderMarkdownPreview(body));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [previewOpen, body]);

  const focusFirstError = (list: PublishValidationIssue[]) => {
    const first = list[0];
    window.requestAnimationFrame(() => {
      if (first?.field === 'body') {
        bodyRef.current?.focus();
      } else if (first?.field === 'title') {
        titleRef.current?.focus();
      }
    });
  };

  const updateTitle = (value: string) => {
    setTitle(value);
    setDirty(true);
    setErrors((current) => current.filter((error) => error.field !== 'title'));
  };

  const updateBody = (value: string) => {
    setBody(value);
    setDirty(true);
    setErrors((current) => current.filter((error) => error.field !== 'body'));
  };

  const continueWithGitHub = async (options: { switchAccount?: boolean } = {}) => {
    if (auth.kind === 'pending') {
      return;
    }
    setNotice('');
    if (sessionMode === 'github') {
      setAuth({ kind: 'pending' });
      // Review P1-3: signing in / reauthorizing is an intentional full-page
      // navigation to the GitHub OAuth route. Without this flag a local draft
      // would make the browser show its "Leave site?" prompt, and cancelling it
      // aborts the authorization before the request is sent.
      leavingRef.current = true;
      startGitHubAuthorization(options);
      return;
    }
    if (sessionMode !== 'mock') {
      setAuth({ kind: sessionMode === 'unavailable' ? 'unavailable' : 'check_failed' });
      return;
    }
    setAuth({ kind: 'pending' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      const result = await authorizeWithMock(mockAuthOutcome, controller.signal);
      applyAuthResult(result);
    } catch {
      setAuth({ kind: 'timeout' });
    } finally {
      window.clearTimeout(timer);
    }
  };

  const applyAuthResult = (result: MockAuthResult) => {
    if (result.status === 404) {
      setAuth({ kind: 'unavailable' });
      return;
    }
    const status = result.body?.status;
    if (status === 'authorized') {
      setAuth({
        kind: 'authorized',
        user: result.body?.user ?? { login: 'mock-author', id: 0 },
      });
      setAuthMessage('');
      return;
    }
    if (status === 'cancelled' || status === 'forbidden' || status === 'expired') {
      setAuth({ kind: status as Extract<AuthStatus, 'cancelled' | 'forbidden' | 'expired'> });
      return;
    }
    if (status === 'permission_denied') {
      setAuth({ kind: 'permission_denied' });
      return;
    }
    setAuth({ kind: 'timeout' });
  };

  /**
   * A06 "Recheck": re-read the author-server session/permission state without
   * starting OAuth and without touching the draft. A failed authorization has
   * no durable session, so this cannot call GitHub again; it refreshes the
   * stored outcome and either keeps the permission terminal, recovers an
   * authorized session, or falls back to an anonymous Continue.
   */
  const recheckPermissions = async () => {
    if (recheckingPermissions || sessionMode !== 'github') {
      return;
    }
    setNotice('');
    setRecheckNotice('');
    setRecheckingPermissions(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), GET_TIMEOUT_MS);
    try {
      const state = await fetchSessionState(controller.signal);
      if (state.mode === 'github' && state.session.status === 'authorized') {
        csrfRef.current = state.session.csrfToken;
        setAuth({ kind: 'authorized', user: state.session.user });
        setAuthMessage('');
        setRecheckNotice('');
        setNotice('Permissions rechecked: the author session is authorized.');
        return;
      }
      if (
        state.mode === 'github' &&
        state.session.status === 'anonymous' &&
        state.session.auth?.status === 'permission_denied'
      ) {
        setAuth({ kind: 'permission_denied' });
        setAuthMessage(state.session.auth.message);
        setRecheckNotice(
          'Permissions rechecked. GitHub still reports that the App cannot write to this repository.',
        );
        return;
      }
      setAuth({ kind: 'anonymous' });
      setAuthMessage('');
      setRecheckNotice('');
      setNotice(
        'No active GitHub authorization was found. Update the App installation, then continue with GitHub.',
      );
    } catch {
      setRecheckNotice('Could not recheck permissions. Your draft is safe; try again.');
    } finally {
      window.clearTimeout(timer);
      setRecheckingPermissions(false);
    }
  };

  const handleLogout = async () => {
    setNotice('');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
    try {
      if (sessionMode === 'github') {
        const csrfToken = csrfRef.current;
        if (!csrfToken) {
          setAuth({ kind: 'anonymous' });
          setPublish({ kind: 'idle' });
          return;
        }
        const result = await logoutSession(csrfToken, controller.signal);
        if (result.status === 200 || result.status === 401) {
          csrfRef.current = null;
          setAuth({ kind: 'anonymous' });
          setAuthMessage('');
          setPublish({ kind: 'idle' });
          setDeployment({ kind: 'idle' });
        } else {
          setNotice('Could not sign out. Your draft is safe; try again.');
        }
        return;
      }
      const ok = await logoutMock(controller.signal);
      if (ok) {
        setAuth({ kind: 'anonymous' });
        setPublish({ kind: 'idle' });
      } else {
        setNotice('Could not sign out. Your draft is safe; try again.');
      }
    } catch {
      setNotice('Could not sign out. Your draft is safe; try again.');
    } finally {
      window.clearTimeout(timer);
    }
  };

  const applyPublishError = (result: PublishResult) => {
    const errorBody = result.body as PublishErrorResponse | null;
    switch (result.status) {
      case 422: {
        const code = errorBody?.error?.code;
        if (code === 'branch_protected') {
          setPublish({
            kind: 'branch_protected',
            message: messageFrom(
              errorBody,
              'GitHub rejected the write because this branch is protected. Direct writes are not allowed, so nothing was published.',
            ),
            reviewUrl: errorBody?.reviewUrl,
          });
          return;
        }
        if (code === 'write_rejected') {
          setPublish({
            kind: 'write_rejected',
            message: messageFrom(
              errorBody,
              'GitHub rejected this write because of a repository rule. Nothing was published.',
            ),
            reviewUrl: errorBody?.reviewUrl,
          });
          return;
        }
        setErrors((errorBody?.errors ?? []) as PublishValidationIssue[]);
        setPublish({ kind: 'idle' });
        if (errorBody?.errors && errorBody.errors.length > 0) {
          focusFirstError(errorBody.errors);
        }
        return;
      }
      case 401:
        setAuth({ kind: 'expired' });
        setPublish({
          kind: 'expired',
          message: messageFrom(
            errorBody,
            'The GitHub authorization expired. Sign in again. Your draft is safe.',
          ),
        });
        return;
      case 403:
        if (errorBody?.error?.code === 'security_blocked') {
          setPublish({
            kind: 'security_blocked',
            message: messageFrom(
              errorBody,
              'The request was blocked by the author server. Reload the page and try again.',
            ),
          });
          return;
        }
        setPublish({
          kind: 'permission_denied',
          message: messageFrom(
            errorBody,
            'The GitHub App cannot write to this repository. Nothing was published.',
          ),
        });
        return;
      case 409:
        setPublish({
          kind: 'conflict',
          message: messageFrom(
            errorBody,
            'A different post already exists at this path. Nothing was overwritten. Your draft is safe.',
          ),
          existing: errorBody?.existing ?? null,
        });
        return;
      case 429:
        setPublish({
          kind: 'rate_limited',
          message: messageFrom(errorBody, 'GitHub rate limit reached. Try again later.'),
          retryAfterSeconds: errorBody?.retryAfterSeconds,
        });
        if (errorBody?.retryAfterSeconds) {
          const until = Date.now() + errorBody.retryAfterSeconds * 1000;
          setRetryAfterUntil(until);
          if (retryTimerRef.current !== null) {
            window.clearTimeout(retryTimerRef.current);
          }
          retryTimerRef.current = window.setTimeout(
            () => setRetryAfterUntil(null),
            errorBody.retryAfterSeconds * 1000,
          );
        }
        return;
      case 413:
        setPublish({
          kind: 'error',
          message: messageFrom(errorBody, 'The post is too large to publish. Shorten the body.'),
        });
        return;
      case 502:
      case 503:
        setPublish({
          kind: 'error',
          message: messageFrom(
            errorBody,
            'The publishing service is unavailable. Your draft is safe; try again shortly.',
          ),
        });
        return;
      case 504:
        setPublish({
          kind: 'timeout',
          message: messageFrom(
            errorBody,
            'The publishing request timed out. Your draft is still on this device.',
          ),
        });
        return;
      case 500:
        setPublish({
          kind: 'error',
          message: messageFrom(
            errorBody,
            'The publishing service returned an error. Your draft is safe.',
          ),
        });
        return;
      case 404:
        setPublish({
          kind: 'not_found',
          message: messageFrom(
            errorBody,
            'The target repository or branch could not be found. Nothing was published.',
          ),
        });
        return;
      default:
        setPublish({
          kind: 'error',
          message: messageFrom(
            errorBody,
            `The publishing request failed (HTTP ${result.status}). Your draft is safe.`,
          ),
        });
    }
  };

  /**
   * D32: a completed publish leaves the editor and lands on the same-origin
   * success route. The record (commit + deployment, both public data) is kept
   * in sessionStorage so a refresh renders the same result, and the URL change
   * uses `pushState` so no full reload or beforeunload prompt is involved.
   */
  const enterSuccessPage = (record: PublishRecord) => {
    savePublishRecord(record);
    setPublishRecord(record);
    setDeployment({ kind: 'idle' });
    setPublish({ kind: 'idle' });
    setRetryAfterUntil(null);
    setErrors([]);
    setRoute('success');
    window.history.pushState({ selfpage: 'success' }, '', '/new/success');
    window.scrollTo(0, 0);
  };

  const applyPublishSuccess = (response: PublishSuccessResponse, snapshot: DraftSnapshot) => {
    const clearedDraft = isSameDraft(snapshot, latestRef.current);
    if (response.status !== 'duplicate_ignored') {
      // The commit response is the authoritative publication date. If the
      // request crossed Asia/Shanghai midnight, the visible date is corrected
      // to the date actually written to the file/front matter.
      applyServerDate(response.date);
    }
    if (clearedDraft) {
      // Stop a debounce that was armed just before the response; otherwise it
      // would re-create the draft that was just committed.
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      clearDraft(storage);
      publishedSnapshotRef.current = snapshot;
      setSavedAt(null);
      setDirty(false);
    }
    // A completed publish ends the retry attempt: the next explicit Publish is
    // a new user action (and may create a new timestamped article after 3h).
    attemptRef.current = null;

    const kind: SuccessKind =
      response.status === 'duplicate_ignored'
        ? 'duplicate'
        : response.deployment.status === 'failed'
          ? 'deploy_failed'
          : response.deployment.status === 'unconfirmed'
            ? 'deploy_unconfirmed'
            : 'committed';

    enterSuccessPage({
      kind,
      commit: {
        sha: response.commit.sha,
        committedAt: response.commit.committedAt,
        path: response.commit.path,
        ...(response.commit.url ? { url: response.commit.url } : {}),
      },
      deployment: {
        status: response.deployment.status,
        message: response.deployment.message,
        ...(response.deployment.actionsUrl ? { actionsUrl: response.deployment.actionsUrl } : {}),
      },
      date: response.date,
      clearedDraft,
      savedAt: new Date().toISOString(),
    });
  };

  const handlePublish = async (forceNewTimestamp?: boolean) => {
    if (publishGuardRef.current || publish.kind === 'publishing') {
      return;
    }
    setNotice('');
    if (auth.kind !== 'authorized') {
      return;
    }
    const publishWithGitHub = sessionMode === 'github';
    const wantsNewTimestamp = forceNewTimestamp === true;

    publishGuardRef.current = true;
    setErrors([]);
    setDeployment({ kind: 'idle' });
    setPublish({ kind: 'publishing' });
    try {
      // Read the server-owned date immediately before publishing. The worker
      // stamps the file at request time, so a page loaded before midnight must
      // not publish with yesterday's displayed date.
      let freshDate: string;
      try {
        const fresh = await fetchDateWithTimeout();
        freshDate = fresh.date;
        applyServerDate(fresh.date);
      } catch {
        if (mountedRef.current) {
          setDateState({ kind: 'error' });
        }
        setPublish({
          kind: 'error',
          message:
            'The publication date could not be loaded. Nothing was sent. Retry publishing when the date is available.',
        });
        return;
      }

      const validation = serializePost({ title, body, date: freshDate });
      if (!validation.ok) {
        setErrors(validation.errors);
        setPublish({ kind: 'idle' });
        focusFirstError(validation.errors);
        return;
      }

      if (publishWithGitHub) {
        const bodyHeading = findLevelOneHeading(body);
        if (bodyHeading !== null) {
          const headingError: PublishValidationIssue = {
            code: 'body_extra_h1',
            field: 'body',
            message: `The body cannot contain another level-1 heading (line ${bodyHeading.line}). The title becomes the only H1.`,
          };
          setErrors([headingError]);
          setPublish({ kind: 'idle' });
          focusFirstError([headingError]);
          return;
        }
      }

      const snapshot: DraftSnapshot = { draftId, title, body };
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), PUBLISH_TIMEOUT_MS);
      try {
        let result: PublishResult;
        try {
          if (publishWithGitHub) {
            const csrfToken = csrfRef.current;
            if (!csrfToken) {
              setAuth({ kind: 'expired' });
              setPublish({
                kind: 'expired',
                message:
                  'The GitHub authorization expired. Sign in again. Your draft is safe.',
              });
              return;
            }
            const fingerprint = `${draftId}\u0000${title}\u0000${body}`;
            if (
              wantsNewTimestamp ||
              attemptRef.current === null ||
              attemptRef.current.fingerprint !== fingerprint
            ) {
              attemptRef.current = { fingerprint, attemptId: createAttemptId() };
            }
            result = await publishRealDraft(
              {
                title,
                body,
                draftId,
                attemptId: attemptRef.current.attemptId,
                ...(wantsNewTimestamp ? { newTimestamp: true } : {}),
              },
              csrfToken,
              controller.signal,
            );
          } else {
            result = await publishDraft(
              {
                title,
                body,
                draftId,
                ...(mockEnabled ? { mockOutcome: mockPublishOutcome } : {}),
              },
              controller.signal,
            );
          }
        } catch {
          setPublish(
            controller.signal.aborted
              ? {
                  kind: 'timeout',
                  message: 'The publishing request timed out. Your draft is still on this device.',
                }
              : {
                  kind: 'offline',
                  message:
                    'The publishing request could not reach the server. Your draft is still on this device.',
                },
          );
          return;
        }

        if (result.status === 200 || result.status === 201) {
          const success = result.body as PublishSuccessResponse | null;
          if (success && success.commit && success.deployment) {
            applyPublishSuccess(success, snapshot);
            return;
          }
        }
        if (result.status === 401) {
          csrfRef.current = null;
        }
        applyPublishError(result);
      } finally {
        window.clearTimeout(timer);
      }
    } finally {
      publishGuardRef.current = false;
    }
  };

  const handleCheckDeployment = async () => {
    if (deployment.kind === 'checking') {
      return;
    }
    const sha = publishRecord?.commit.sha;
    if (!sha) {
      setDeployment({ kind: 'failed', message: 'The commit SHA is unavailable; nothing was queried.' });
      return;
    }
    setDeployment({ kind: 'checking' });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), DEPLOYMENT_TIMEOUT_MS);
    try {
      const result = await fetchDeployment(sha, controller.signal);
      if (result.status === 200 && result.body && 'status' in result.body) {
        setDeployment({ kind: 'result', response: result.body as DeploymentResponse });
      } else if (result.status === 429) {
        setDeployment({
          kind: 'failed',
          message: 'The deployment check is rate limited. Try again shortly.',
        });
      } else if (result.status === 503) {
        setDeployment({
          kind: 'failed',
          message:
            'Deployment status needs the GitHub connection; it is not available in this environment. Check the Actions page instead.',
        });
      } else {
        setDeployment({
          kind: 'failed',
          message: 'The deployment status could not be confirmed. Check the Actions page.',
        });
      }
    } catch {
      setDeployment({
        kind: 'failed',
        message: 'The deployment check could not reach the author server.',
      });
    } finally {
      window.clearTimeout(timer);
    }
  };

  const confirmDiscard = () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    clearDraft(storage);
    publishedSnapshotRef.current = null;
    setTitle('');
    setBody('');
    setDraftId(createDraftId());
    setEditorResetToken((value) => value + 1);
    setSavedAt(null);
    setDirty(false);
    setErrors([]);
    setPublish({ kind: 'idle' });
    // Release the inert background before the deferred focus below (same reason
    // as closeDiscardDialog): the title is inside the background region.
    releaseDiscardInert();
    setConfirmAction(null);
    setDraftNotice('Draft deleted.');
    window.requestAnimationFrame(() => titleRef.current?.focus());
  };

  const confirmPendingAction = () => {
    if (confirmAction === 'discard') {
      confirmDiscard();
    }
  };

  /** D33 "Stay": close the modal and return focus to the link that opened it. */
  const stayOnPage = () => {
    const trigger = leaveTriggerRef.current;
    leaveTriggerRef.current = null;
    setPendingLeaveHref(null);
    window.requestAnimationFrame(() => {
      // P2-8: on narrow screens the drawer is closed while the dialog is open,
      // so a trigger inside it is inert now; fall back to the Menu button.
      const target =
        trigger !== null && trigger.isConnected && trigger.closest('[inert]') === null
          ? trigger
          : document.querySelector<HTMLElement>('[data-drawer-toggle]');
      target?.focus({ preventScroll: true });
    });
  };

  /** D33 "Leave": a real navigation; the native prompt is suppressed once. */
  const leavePage = () => {
    const href = pendingLeaveHref;
    if (!href) return;
    leavingRef.current = true;
    setPendingLeaveHref(null);
    window.location.assign(href);
  };

  const dateText = dateState.kind === 'ready' ? dateState.date : null;
  const authorized = auth.kind === 'authorized';
  const canPublish = authorized && dateState.kind === 'ready' && publish.kind !== 'publishing';
  const titleInvalid = errors.some((error) => error.field === 'title');
  const bodyInvalid = errors.some((error) => error.field === 'body');
  const publishedContentCurrent =
    publishedSnapshotRef.current !== null &&
    isSameDraft(publishedSnapshotRef.current, { draftId, title, body });

  const saveStatus = !storageAvailable
    ? 'Autosave is unavailable because this browser blocked local storage. Keep this tab open or copy your text before leaving this page.'
    : dirty
      ? 'Saving draft…'
      : savedAt
        ? `Draft saved in this browser at ${formatSavedTime(savedAt)}.`
        : publishedContentCurrent
          ? 'This exact content was committed; no draft is stored in this browser.'
          : hasDraftContent(title, body)
            ? 'Draft not saved yet.'
            : 'No draft is stored yet.';

  // D33: a draft must be non-empty and not already published to be protected.
  const hasUnpublishedDraft = hasDraftContent(title, body) && !publishedContentCurrent;
  hasUnpublishedDraftRef.current = hasUnpublishedDraft;

  const logoutButton = authorized ? (
    <button type="button" className="shell-actions__button" data-testid="logout-button" onClick={handleLogout}>
      Log out
    </button>
  ) : null;

  return (
    <SiteShell nav={shellNav} actions={logoutButton}>
      {route === 'success' ? (
        <SuccessPanel
          record={publishRecord}
          deployment={deployment}
          onCheckDeployment={() => void handleCheckDeployment()}
        />
      ) : (
        <div className="author-page">
          {auth.kind !== 'authorized' && (
            <section
              className="status-panel status-panel--auth"
              aria-labelledby="auth-heading"
              aria-live="polite"
              aria-busy={auth.kind === 'loading' || auth.kind === 'pending'}
            >
              <h1 id="auth-heading" className="visually-hidden">
                Publishing access
              </h1>
              {auth.kind === 'loading' && <p>Checking GitHub authorization…</p>}
              {auth.kind === 'pending' && (
                <div>
                  <p>
                    <strong>Waiting for GitHub authorization…</strong> Your draft stays in this
                    browser.
                  </p>
                  <p>
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
              {auth.kind === 'anonymous' && (
                <div>
                  <p>
                    This page is where Xinyang Zeng writes Blog posts; publishing requires the
                    author&rsquo;s own GitHub account.
                  </p>
                  <p className="button-row">
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-continue"
                      onClick={() => void continueWithGitHub()}
                    >
                      Continue with GitHub
                    </button>
                    <BackLink testId="back-to-blog" />
                  </p>
                </div>
              )}
              {auth.kind === 'cancelled' && (
                <div>
                  <p>
                    <strong>GitHub authorization was cancelled.</strong> Nothing was published. Your
                    draft is still in this browser.
                  </p>
                  <p>
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-continue"
                      onClick={() => void continueWithGitHub()}
                    >
                      Continue with GitHub
                    </button>{' '}
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
              {auth.kind === 'forbidden' && (
                <div>
                  <p>
                    <strong>This GitHub account is not the configured author.</strong> Nothing was
                    published.
                  </p>
                  <p>
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-continue"
                      onClick={() => void continueWithGitHub({ switchAccount: true })}
                    >
                      Switch account
                    </button>{' '}
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
              {auth.kind === 'expired' && (
                <div>
                  <p>
                    <strong>Your GitHub authorization expired.</strong> Your draft is still in this
                    browser.
                  </p>
                  <p>
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-continue"
                      onClick={() => void continueWithGitHub()}
                    >
                      Reauthorize with GitHub
                    </button>{' '}
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
              {auth.kind === 'permission_denied' && (
                <div>
                  <p>
                    <strong>The GitHub App cannot write to this repository.</strong> Nothing was
                    published. Review the App permissions before trying again.
                  </p>
                  {authMessage !== '' && <p className="muted">{authMessage}</p>}
                  <p>
                    <button
                      type="button"
                      className="button button--quiet"
                      data-testid="auth-recheck"
                      onClick={() => void recheckPermissions()}
                      disabled={recheckingPermissions || sessionMode !== 'github'}
                    >
                      {recheckingPermissions ? 'Rechecking permissions…' : 'Recheck permissions'}
                    </button>{' '}
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-continue"
                      onClick={() => void continueWithGitHub()}
                    >
                      Reauthorize with GitHub
                    </button>{' '}
                    <a
                      className="back-link"
                      href="https://github.com/settings/installations"
                      target="_blank"
                      rel="noreferrer noopener"
                      data-testid="review-permissions"
                    >
                      Review App permissions
                    </a>{' '}
                    <BackLink testId="auth-status-back" />
                  </p>
                  {recheckNotice !== '' && (
                    <p className="muted" role="status" data-testid="auth-recheck-status">
                      {recheckNotice}
                    </p>
                  )}
                </div>
              )}
              {auth.kind === 'oauth_error' && (
                <div>
                  <p>
                    <strong>GitHub authorization could not be completed.</strong> Nothing was
                    published. Your draft is still in this browser.
                  </p>
                  {authMessage !== '' && <p className="muted">{authMessage}</p>}
                  <p>
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-continue"
                      onClick={() => void continueWithGitHub()}
                    >
                      Try again
                    </button>{' '}
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
              {auth.kind === 'timeout' && (
                <div>
                  <p>
                    <strong>Authorization did not finish in time.</strong> No request is still
                    running.
                  </p>
                  <p>
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-continue"
                      onClick={() => void continueWithGitHub()}
                    >
                      Try again
                    </button>{' '}
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
              {auth.kind === 'check_failed' && (
                <div>
                  <p>
                    <strong>Could not check GitHub authorization.</strong> The author server did not
                    answer in time, so no authorization request was sent. Your draft is still in
                    this browser.
                  </p>
                  <p>
                    <button
                      type="button"
                      className="button"
                      data-testid="auth-retry"
                      onClick={() => setSessionAttempt((value) => value + 1)}
                    >
                      Retry authorization check
                    </button>{' '}
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
              {auth.kind === 'unavailable' && (
                <div>
                  <p>
                    <strong>GitHub authorization is not available in this build.</strong> Signing in
                    as the author is required to open the editor.
                  </p>
                  <p>
                    <BackLink testId="auth-status-back" />
                  </p>
                </div>
              )}
            </section>
          )}

          {/* R075-4 (user D30): an unauthenticated visitor only gets the short
              author statement/terminal above — no editor, no Publish/Delete
              draft/Preview, no Logout. The local draft is not cleared; signing
              in re-mounts the editor with the same draft state. */}
          {authorized && (
            <>
          <article className="post-editor" aria-label="Post editor">
            <span id="title-label" className="visually-hidden">
              Post title
            </span>
            <h1 className="post-title">
              <EditableText
                id="post-title"
                labelId="title-label"
                multiline={false}
                value={title}
                resetToken={editorResetToken}
                onChange={updateTitle}
                className="post-title__input"
                testId="post-title"
                invalid={titleInvalid}
                describedBy="editor-errors"
                elementRef={titleRef}
              />
            </h1>
            {dateText ? (
              <p className="post-date">
                <time data-testid="post-date" dateTime={dateText}>
                  {dateText}
                </time>
              </p>
            ) : (
              <p className="post-date">
                <span data-testid="post-date">
                  {dateState.kind === 'error' ? 'Date unavailable' : 'Loading date…'}
                </span>
              </p>
            )}
            <hr />
            <span id="body-label" className="visually-hidden">
              Post body in Markdown
            </span>
            <EditableText
              id="post-body"
              labelId="body-label"
              multiline
              value={body}
              resetToken={editorResetToken}
              onChange={updateBody}
              className="post-body"
              testId="post-body"
              invalid={bodyInvalid}
              describedBy="editor-errors"
              elementRef={bodyRef}
            />
          </article>

          <section className="publish-panel" aria-labelledby="publish-heading">
            <h2 id="publish-heading">Publish</h2>
            <p className="muted" id="publish-hint">
              Publishing creates one new Markdown file in the site repository. Your draft stays in
              this browser until it is published.
            </p>
            {dateState.kind === 'error' && (
              <p className="field-error" role="alert">
                The publication date could not be loaded. Publishing stays disabled until it is
                available.{' '}
                <button
                  type="button"
                  className="button button--quiet"
                  onClick={() => {
                    setDateState({ kind: 'loading' });
                    void loadDate(false);
                  }}
                >
                  Retry date
                </button>
              </p>
            )}
            <div className="publish-actions">
              <button
                type="button"
                className="button button--primary"
                data-testid="publish-button"
                onClick={() => void handlePublish()}
                disabled={!canPublish}
                aria-describedby="publish-hint"
              >
                {publish.kind === 'publishing' ? 'Publishing…' : 'Publish'}
              </button>
              <button
                type="button"
                className="button"
                data-testid="discard-button"
                onClick={() => setConfirmAction('discard')}
                disabled={publish.kind === 'publishing'}
              >
                Delete draft
              </button>
              <button
                type="button"
                className="button"
                aria-expanded={previewOpen}
                aria-controls="preview-region"
                onClick={() => setPreviewOpen((value) => !value)}
                data-testid="preview-toggle"
              >
                {previewOpen ? 'Hide preview' : 'Preview'}
              </button>
            </div>

            <p className="draft-status" role="status">
              {saveStatus}
            </p>
            {draftNotice !== '' && (
              <p className="draft-status" role="status">
                {draftNotice}
              </p>
            )}
            {notice !== '' && (
              <p className="field-error" role="alert">
                {notice}
              </p>
            )}

            {errors.length > 0 && (
              <div className="field-errors" id="editor-errors" role="alert">
                <h3>Check the post before publishing</h3>
                <ul>
                  {errors.map((error) => (
                    <li key={`${error.field}-${error.code}`}>{error.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {confirmAction === 'discard' && (
              <>
                <div className="confirm-layer" aria-hidden="true" />
                <div
                  ref={discardDialogRef}
                  className="confirm-panel"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="confirm-heading"
                  aria-describedby="confirm-description"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      // The shared drawer controller also listens for Escape on
                      // document; this Escape belongs to the dialog only.
                      event.stopPropagation();
                      closeDiscardDialog();
                      return;
                    }
                    if (event.key !== 'Tab') return;
                    // P2-2: keep Tab inside the two buttons; the safe action is
                    // the initial focus and the destructive one is reached with
                    // Tab. Stopping propagation keeps the narrow drawer's own
                    // Tab trap from moving focus behind the inert background.
                    const buttons = Array.from(
                      event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
                    );
                    const first = buttons[0];
                    const last = buttons[buttons.length - 1];
                    if (!first || !last) return;
                    if (event.shiftKey && document.activeElement === first) {
                      event.preventDefault();
                      event.stopPropagation();
                      last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                      event.preventDefault();
                      event.stopPropagation();
                      first.focus();
                    }
                  }}
                >
                  <h3 id="confirm-heading">Delete this draft?</h3>
                  <p id="confirm-description">
                    The title and body will be removed from this browser. This cannot be undone. No
                    request is sent to GitHub, and any already published post stays online.
                  </p>
                  <div className="button-row">
                    <button
                      ref={discardConfirmRef}
                      type="button"
                      className="button button--danger"
                      data-testid="discard-confirm"
                      onClick={confirmPendingAction}
                    >
                      Delete draft
                    </button>
                    <button
                      ref={discardCancelRef}
                      type="button"
                      className="button"
                      data-testid="discard-cancel"
                      onClick={closeDiscardDialog}
                    >
                      Keep editing
                    </button>
                  </div>
                </div>
              </>
            )}

            <div className="publish-status-focus" ref={publishStatusRef} tabIndex={-1}>
              <PublishStatus
                publish={publish}
                retryAfterUntil={retryAfterUntil}
                onRetry={() => void handlePublish()}
                onReauthorize={() => void continueWithGitHub()}
                onNewTimestamp={() => void handlePublish(true)}
              />
            </div>

            {previewOpen && (
              <section className="preview" id="preview-region" aria-labelledby="preview-heading">
                <h3 id="preview-heading">Preview</h3>
                {previewFailed ? (
                  <p className="muted">
                    The preview could not be rendered. Your Markdown is unchanged.
                  </p>
                ) : previewHtml === null ? (
                  <p className="muted">Rendering preview…</p>
                ) : body.trim() === '' ? (
                  <p className="muted">Nothing to preview yet.</p>
                ) : (
                  <div
                    className="preview-body"
                    data-testid="preview-body"
                    dangerouslySetInnerHTML={{ __html: previewHtml }}
                  />
                )}
              </section>
            )}

            {mockEnabled && (
              <details className="mock-controls" data-testid="mock-controls">
                <summary>Mock publishing controls (test environment only)</summary>
                <p className="muted">
                  This build runs the Worker with <code>APP_ENV=test</code>. These selectors choose
                  the simulated authorization and publishing result; they are absent in production.
                </p>
                <div className="mock-controls__grid">
                  <label className="mock-field">
                    <span>Mock authorization result</span>
                    <select
                      value={mockAuthOutcome}
                      data-testid="mock-auth-outcome"
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        setMockAuthOutcome(event.target.value as MockAuthOutcome)
                      }
                    >
                      {(Object.keys(AUTH_OUTCOME_LABELS) as MockAuthOutcome[]).map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {AUTH_OUTCOME_LABELS[outcome]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mock-field">
                    <span>Mock publish result</span>
                    <select
                      value={mockPublishOutcome}
                      data-testid="mock-publish-outcome"
                      onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                        setMockPublishOutcome(event.target.value as MockPublishOutcome)
                      }
                    >
                      {(Object.keys(PUBLISH_OUTCOME_LABELS) as MockPublishOutcome[]).map((outcome) => (
                        <option key={outcome} value={outcome}>
                          {PUBLISH_OUTCOME_LABELS[outcome]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
            )}
          </section>
            </>
          )}
        </div>
      )}

      {pendingLeaveHref !== null && <LeaveConfirmDialog onLeave={leavePage} onStay={stayOnPage} />}
    </SiteShell>
  );
}
interface PublishStatusProps {
  publish: PublishUi;
  retryAfterUntil: number | null;
  onRetry: () => void;
  onReauthorize: () => void;
  onNewTimestamp: () => void;
}

const DEPLOYMENT_LABELS: Record<DeploymentStatus, string> = {
  pending: 'Pending',
  deployed: 'Deployed',
  failed: 'Failed',
  unconfirmed: 'Unconfirmed',
};

/**
 * Terminal publish errors stay on the editor (D31/D32): a failed publish must
 * never navigate away or clear the draft. Only Retry / Reauthorize / Back are
 * offered here; success has its own page.
 */
function PublishStatus({
  publish,
  retryAfterUntil,
  onRetry,
  onReauthorize,
  onNewTimestamp,
}: PublishStatusProps): ReactNode {
  if (publish.kind === 'idle') {
    return null;
  }

  if (publish.kind === 'publishing') {
    return (
      <div className="publish-status" role="status" aria-busy="true">
        <h3>Publishing…</h3>
        <p>
          Waiting for the publishing service. You can keep editing; a newer draft will not be
          cleared by this response.
        </p>
      </div>
    );
  }

  const errorHeadings: Record<string, string> = {
    conflict: 'Publishing conflict',
    branch_protected: 'Protected branch',
    write_rejected: 'Write rejected by repository rules',
    rate_limited: 'Rate limit reached',
    offline: 'Connection problem',
    timeout: 'Publishing timed out',
    error: 'Publishing failed',
    expired: 'Authorization expired',
    permission_denied: 'Permission denied',
    not_found: 'Repository not found',
    security_blocked: 'Request blocked',
  };

  const retryable =
    publish.kind === 'rate_limited' ||
    publish.kind === 'offline' ||
    publish.kind === 'timeout' ||
    publish.kind === 'error' ||
    publish.kind === 'not_found';
  const reauthorize = publish.kind === 'expired' || publish.kind === 'permission_denied';
  const retryBlocked = retryAfterUntil !== null && retryAfterUntil > Date.now();

  return (
    <div className="publish-status" role="status">
      <h3>{errorHeadings[publish.kind]}</h3>
      <p>{publish.message}</p>
      {publish.kind === 'rate_limited' && publish.retryAfterSeconds ? (
        <p>Retry after about {publish.retryAfterSeconds} seconds.</p>
      ) : null}
      {publish.kind === 'conflict' ? (
        <div>
          <p>Rename the title or publish again with a new timestamp. The existing file is kept.</p>
          {publish.existing ? (
            <p>
              <a
                className="back-link"
                href={publish.existing.url}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="view-existing"
              >
                View existing file
              </a>
            </p>
          ) : null}
          <p>
            <button
              type="button"
              className="button"
              data-testid="publish-new-timestamp"
              onClick={onNewTimestamp}
            >
              Publish with a new timestamp
            </button>
          </p>
        </div>
      ) : null}
      {publish.kind === 'branch_protected' ? (
        <div>
          <p>
            The GitHub branch rules blocked the write before any file was created. Nothing was
            published by this request.
          </p>
          {publish.reviewUrl ? (
            <p>
              <a
                className="back-link"
                href={publish.reviewUrl}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="review-branch-rules"
              >
                Review branch rules
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      {publish.kind === 'write_rejected' ? (
        <div>
          <p>
            GitHub&apos;s repository rules blocked this write. Nothing was published by this
            request.
          </p>
          {publish.reviewUrl ? (
            <p>
              <a
                className="back-link"
                href={publish.reviewUrl}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="review-repository-rules"
              >
                Review repository rules
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="button-row">
        {retryable && (
          <button
            type="button"
            className="button"
            data-testid="publish-retry"
            onClick={onRetry}
            disabled={retryBlocked}
          >
            Retry publishing
          </button>
        )}
        {reauthorize && (
          <button
            type="button"
            className="button"
            data-testid="publish-reauthorize"
            onClick={onReauthorize}
          >
            Reauthorize with GitHub
          </button>
        )}
        {reauthorize && (
          <a
            className="back-link"
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noreferrer noopener"
          >
            Review App permissions
          </a>
        )}
        <BackLink />
      </div>
    </div>
  );
}

interface SuccessPanelProps {
  record: PublishRecord | null;
  deployment: DeploymentUi;
  onCheckDeployment: () => void;
}

/**
 * D32 success page: a same-origin SPA route with the shared shell.
 *
 * It separates the two facts the user must not confuse — the commit exists, and
 * the site deployment may not have completed yet — and gives the two exits
 * ("Write another post" and "Back to Blog"). Refreshing or opening `/new/success`
 * without a record renders the no-state fallback instead of a blank page.
 */
function SuccessPanel({ record, deployment, onCheckDeployment }: SuccessPanelProps): ReactNode {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // D32/X11: entering the success route moves focus to its heading, so keyboard
  // and screen-reader users are not dropped on <body> when the editor leaves.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  if (record === null) {
    return (
      <article className="author-page success-page" aria-labelledby="success-heading">
        <h1 id="success-heading" className="post-title" ref={headingRef} tabIndex={-1}>
          No publication result to show
        </h1>
        <p className="muted">
          This page shows the result of a publish that happened in this tab. Publish a post to see a
          new result, or go back to the Blog.
        </p>
        <div className="button-row">
          <a className="button" href="/new/" data-testid="new-post">
            Write another post
          </a>
          <BackLink testId="back-to-blog" />
        </div>
      </article>
    );
  }

  const headings: Record<SuccessKind, string> = {
    committed: 'Commit created',
    duplicate: 'Already published',
    deploy_failed: 'Commit created, deployment failed',
    deploy_unconfirmed: 'Commit created, deployment unconfirmed',
  };
  const actionsUrl =
    safeGithubUrl(
      record.deployment.actionsUrl ??
        (record.commit.url ? `${record.commit.url.split('/commit/')[0]}/actions` : undefined),
    ) ?? '';
  // P2-5: validate the stored commit URL before it can become a link.
  const commitUrl = safeGithubUrl(record.commit.url);
  const deploymentStatus = deployment.kind === 'result' ? deployment.response.status : record.deployment.status;
  const deploymentMessage =
    deployment.kind === 'result' ? deployment.response.message : record.deployment.message;

  return (
    <article className="author-page success-page" aria-labelledby="success-heading">
      <h1 id="success-heading" className="post-title" ref={headingRef} tabIndex={-1}>
        {headings[record.kind]}
      </h1>
      <p className="post-date">
        <time dateTime={record.commit.committedAt}>{formatCommitTime(record.commit.committedAt)}</time>
      </p>
      <hr />
      <section className="publish-status" aria-labelledby="deployment-heading" data-testid="success-panel">
        {record.kind === 'duplicate' ? (
          <p>
            This draft and content were already published within the last three hours. The original
            commit was kept; nothing new was created.
          </p>
        ) : (
          <p>
            The commit was created in the site repository, so the post source is saved. A commit is
            not a deployment: the post only appears on the public site after the site deployment
            completes.
          </p>
        )}
        <p>
          File: <code>{record.commit.path}</code>
        </p>
        <p>
          Commit <code>{record.commit.sha.slice(0, 12)}</code>{' '}
          {commitUrl ? (
            <a
              className="back-link"
              href={commitUrl}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="view-commit"
            >
              View commit
            </a>
          ) : (
            <span className="muted">
              {record.commit.url
                ? '(the stored commit URL is not a https GitHub URL; shown as text only)'
                : '(this environment has no GitHub commit URL)'}
            </span>
          )}
        </p>
        <p>
          {record.clearedDraft
            ? 'The identical draft was removed from this browser.'
            : 'A newer edit was kept in this browser.'}
        </p>
        <div className="deployment-check" data-testid="deployment-check">
          <h2 id="deployment-heading">Deployment</h2>
          <p role="status">
            Deployment status:{' '}
            <strong data-testid="deployment-status">{DEPLOYMENT_LABELS[deploymentStatus]}</strong>.{' '}
            {deploymentMessage}
          </p>
          <p>
            {deployment.kind === 'result' || deployment.kind === 'failed' ? (
              // A19: after a deployment check the explicit recheck keeps the
              // same hook the task 07 acceptance expects.
              <button
                type="button"
                className="button button--quiet"
                data-testid="recheck-deployment"
                onClick={onCheckDeployment}
              >
                Recheck deployment
              </button>
            ) : (
              <button
                type="button"
                className="button button--quiet"
                data-testid="check-deployment"
                onClick={onCheckDeployment}
                disabled={deployment.kind === 'checking'}
              >
                {deployment.kind === 'checking' ? 'Checking deployment…' : 'Check deployment'}
              </button>
            )}
            {actionsUrl !== '' ? (
              <>
                {' '}
                <a
                  className="back-link"
                  href={actionsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="view-actions"
                >
                  View Actions
                </a>
              </>
            ) : null}
          </p>
          {deployment.kind === 'failed' && (
            <p className="muted" role="status">
              {deployment.message}
            </p>
          )}
        </div>
        <div className="button-row">
          <a className="button" href="/new/" data-testid="new-post">
            Write another post
          </a>
          <BackLink testId="back-to-blog" />
        </div>
      </section>
    </article>
  );
}

interface LeaveConfirmDialogProps {
  onLeave: () => void;
  onStay: () => void;
}

/**
 * D33 in-app leave confirmation. Escape and the "Stay" button both keep the
 * draft; Tab is constrained to the two buttons and focus returns to the link
 * that opened the dialog when it closes.
 *
 * Review P2-8: the dialog is portalled to <body> (outside <main>) and every
 * other shell region becomes inert while it is open, so the background cannot
 * be reached by Tab or a pointer. On narrow screens the drawer is closed first
 * (requestDrawerClose) instead of stacking the modal on top of the overlay, and
 * the keydown handler stops the drawer's own Tab trap from stealing focus.
 */
function LeaveConfirmDialog({ onLeave, onStay }: LeaveConfirmDialogProps): ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);

  // P2-8: keep the rest of the page out of the accessibility/pointer tree and,
  // on narrow screens, close the drawer instead of stacking the dialog on the
  // overlay. This effect must run before the focus effect below: closing the
  // drawer moves focus to the Menu button, which would otherwise steal the
  // dialog's initial focus.
  useEffect(() => {
    if (window.matchMedia('(max-width: 48em)').matches) requestDrawerClose();
    const regions = ['.top-bar', '#site-drawer', '.site-main', '.site-footer', '[data-drawer-backdrop]']
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((element): element is HTMLElement => element !== null);
    const previouslyInert = regions.map((element) => element.hasAttribute('inert'));
    for (const element of regions) element.setAttribute('inert', '');
    return () => {
      regions.forEach((element, index) => {
        if (!previouslyInert[index]) element.removeAttribute('inert');
      });
    };
  }, []);

  useEffect(() => {
    stayRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Capture-phase stop: the drawer controller also listens on document and
        // must not treat this Escape as its own close path.
        event.stopPropagation();
        onStay();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href]'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (active === null || !dialog.contains(active)) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onStay]);

  return createPortal(
    <div className="leave-layer">
      <div
        ref={dialogRef}
        className="leave-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-heading"
        data-testid="leave-confirm"
      >
        <h2 id="leave-heading">You have an unpublished draft. Leave anyway?</h2>
        <div className="button-row">
          <button
            type="button"
            className="button button--danger"
            data-testid="leave-accept"
            onClick={onLeave}
          >
            Leave
          </button>
          <button
            ref={stayRef}
            type="button"
            className="button"
            data-testid="leave-stay"
            onClick={onStay}
          >
            Stay
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
