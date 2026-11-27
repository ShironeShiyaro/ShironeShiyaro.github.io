/**
 * Browser-local draft storage for the New! editor.
 *
 * Only `schemaVersion`, `draftId`, `title`, `body` and `updatedAt` are stored.
 * No OAuth state, token, verifier or any other secret may ever be written here.
 *
 * Every operation tolerates a missing or throwing `Storage`: the editor stays
 * usable when localStorage is blocked, it just cannot autosave.
 */

export const DRAFT_STORAGE_KEY = 'selfpage:author:draft';
export const DRAFT_SCHEMA_VERSION = 1;

export interface DraftRecord {
  schemaVersion: typeof DRAFT_SCHEMA_VERSION;
  draftId: string;
  title: string;
  body: string;
  /** ISO 8601 instant of the last successful save. */
  updatedAt: string;
}

/** The subset of Storage used by the editor (easy to fake in unit tests). */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isDraftRecord(value: unknown): value is DraftRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === DRAFT_SCHEMA_VERSION &&
    typeof record.draftId === 'string' &&
    record.draftId.trim() !== '' &&
    typeof record.title === 'string' &&
    typeof record.body === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

/**
 * Reads and validates the stored draft. Corrupt, foreign or older-schema data
 * is treated as absent (and not rewritten here) instead of breaking the page.
 */
export function loadDraft(storage: DraftStorage | null): DraftRecord | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(DRAFT_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isDraftRecord(parsed)) {
      return null;
    }
    // Return only the known schema fields; never echo unexpected stored keys.
    return {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      draftId: parsed.draftId,
      title: parsed.title,
      body: parsed.body,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

/** Writes the draft. Returns false when storage is unavailable or full. */
export function saveDraft(
  storage: DraftStorage | null,
  draft: { draftId: string; title: string; body: string; updatedAt?: Date },
): DraftRecord | null {
  if (!storage) {
    return null;
  }
  const record: DraftRecord = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    draftId: draft.draftId,
    title: draft.title,
    body: draft.body,
    updatedAt: (draft.updatedAt ?? new Date()).toISOString(),
  };
  try {
    storage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(record));
    return record;
  } catch {
    return null;
  }
}

/** Removes the draft. Returns false only when an existing value could not be removed. */
export function clearDraft(storage: DraftStorage | null): boolean {
  if (!storage) {
    return true;
  }
  try {
    storage.removeItem(DRAFT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the browser localStorage when a write/remove probe succeeds, or null
 * when it is missing, blocked by policy, or full. The probe key is namespaced
 * and removed immediately.
 */
export function getBrowserDraftStorage(): DraftStorage | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const storage = window.localStorage;
    const probeKey = 'selfpage:author:draft-probe';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}

/** A stable draft ID for the request; falls back where randomUUID is missing. */
export function createDraftId(now = Date.now(), random = Math.random): string {
  const cryptoObject = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  return `draft-${now.toString(36)}-${random().toString(36).slice(2, 10)}`;
}

export interface DraftSnapshot {
  draftId: string;
  title: string;
  body: string;
}

/** True only when the draft ID and the visible text all still match. */
export function isSameDraft(snapshot: DraftSnapshot, current: DraftSnapshot): boolean {
  return (
    snapshot.draftId === current.draftId &&
    snapshot.title === current.title &&
    snapshot.body === current.body
  );
}

/** Content that should trigger leave protection. */
export function hasDraftContent(title: string, body: string): boolean {
  return title.trim() !== '' || body.trim() !== '';
}

/** Title paste: rich text becomes plain text and can never add a second line. */
export function normalizePastedTitle(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\n\t]+/g, ' ');
}
