import { describe, expect, it } from 'vitest';
import {
  DRAFT_SCHEMA_VERSION,
  DRAFT_STORAGE_KEY,
  clearDraft,
  createDraftId,
  getBrowserDraftStorage,
  hasDraftContent,
  isSameDraft,
  loadDraft,
  normalizePastedTitle,
  saveDraft,
  type DraftStorage,
} from './draft.ts';

class FakeStorage implements DraftStorage {
  readonly data = new Map<string, string>();
  failOnRead = false;
  failOnWrite = false;
  failOnRemove = false;

  getItem(key: string): string | null {
    if (this.failOnRead) {
      throw new DOMException('blocked', 'SecurityError');
    }
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnWrite) {
      throw new DOMException('full', 'QuotaExceededError');
    }
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failOnRemove) {
      throw new DOMException('blocked', 'SecurityError');
    }
    this.data.delete(key);
  }
}

const validRecord = {
  schemaVersion: DRAFT_SCHEMA_VERSION,
  draftId: 'draft-1',
  title: 'Example',
  body: 'Body\n',
  updatedAt: '2026-11-23T15:42:15.000Z',
};

describe('draft storage', () => {
  it('round-trips only the allowed schema fields', () => {
    const storage = new FakeStorage();
    const saved = saveDraft(storage, {
      draftId: 'draft-1',
      title: 'Example',
      body: 'Body\n',
      updatedAt: new Date('2026-11-23T15:42:15Z'),
    });
    expect(saved).toEqual(validRecord);

    const raw = storage.data.get(DRAFT_STORAGE_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ['body', 'draftId', 'schemaVersion', 'title', 'updatedAt'].sort(),
    );
    // No OAuth material may ever be stored.
    expect(raw).not.toMatch(/token|secret|verifier|state/i);

    expect(loadDraft(storage)).toEqual(validRecord);
  });

  it('returns null for missing, corrupt, legacy and foreign records', () => {
    const storage = new FakeStorage();

    expect(loadDraft(null)).toBeNull();
    expect(loadDraft(storage)).toBeNull();

    const corrupt = [
      'not json',
      'null',
      '[]',
      JSON.stringify({ ...validRecord, schemaVersion: 0 }),
      JSON.stringify({ ...validRecord, draftId: '' }),
      JSON.stringify({ ...validRecord, title: 42 }),
      JSON.stringify({ ...validRecord, body: null }),
      JSON.stringify({ ...validRecord, updatedAt: 42 }),
    ];
    for (const raw of corrupt) {
      storage.data.set(DRAFT_STORAGE_KEY, raw);
      expect(loadDraft(storage), raw).toBeNull();
    }
  });

  it('drops unexpected stored keys instead of echoing them', () => {
    const storage = new FakeStorage();
    storage.data.set(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ ...validRecord, token: 'ghu_secret', state: 'abc', verifier: 'v' }),
    );
    expect(loadDraft(storage)).toEqual(validRecord);
  });

  it('survives getItem/setItem/removeItem throwing', () => {
    const storage = new FakeStorage();
    storage.failOnRead = true;
    expect(loadDraft(storage)).toBeNull();

    storage.failOnRead = false;
    storage.failOnWrite = true;
    expect(saveDraft(storage, { draftId: 'd', title: 't', body: 'b' })).toBeNull();

    storage.failOnWrite = false;
    storage.data.set(DRAFT_STORAGE_KEY, JSON.stringify(validRecord));
    storage.failOnRemove = true;
    expect(clearDraft(storage)).toBe(false);

    storage.failOnRemove = false;
    expect(clearDraft(storage)).toBe(true);
    expect(clearDraft(null)).toBe(true);
  });

  it('probes browser localStorage without leaving a probe key behind', () => {
    const storage = new FakeStorage();
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { localStorage: storage };
    try {
      expect(getBrowserDraftStorage()).toBe(storage);
      expect(storage.data.has('selfpage:author:draft-probe')).toBe(false);

      storage.failOnWrite = true;
      expect(getBrowserDraftStorage()).toBeNull();
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});

describe('draft helpers', () => {
  it('generates a non-empty draft ID', () => {
    const id = createDraftId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(8);
    expect(id).not.toMatch(/\s/);
  });

  it('compares draft ID, title and body exactly', () => {
    const snapshot = { draftId: 'a', title: 'Title', body: 'Body' };
    expect(isSameDraft(snapshot, { ...snapshot })).toBe(true);
    expect(isSameDraft(snapshot, { ...snapshot, body: 'Body ' })).toBe(false);
    expect(isSameDraft(snapshot, { ...snapshot, title: 'title' })).toBe(false);
    expect(isSameDraft(snapshot, { ...snapshot, draftId: 'b' })).toBe(false);
  });

  it('detects content for leave protection', () => {
    expect(hasDraftContent('', '')).toBe(false);
    expect(hasDraftContent('  ', '\n')).toBe(false);
    expect(hasDraftContent('Title', '')).toBe(true);
    expect(hasDraftContent('', 'Body')).toBe(true);
  });

  it('normalises pasted titles to one plain-text line', () => {
    expect(normalizePastedTitle('Hello\r\nWorld')).toBe('Hello World');
    expect(normalizePastedTitle('A\tB\nC')).toBe('A B C');
    expect(normalizePastedTitle('  Keep spaces  ')).toBe('  Keep spaces  ');
  });
});
