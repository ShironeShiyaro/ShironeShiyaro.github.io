import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCE_BOOT_SCRIPT,
  PREFERENCE_RADIO_SCRIPT,
  PREFERENCE_STORAGE_KEYS,
  PreferenceStore,
  cleanupPreferenceProbe,
  explicitPreferenceValue,
  isValidPreferenceValue,
  parsePreferenceFragment,
  preferenceAttributes,
  preferenceFragment,
  preferenceMetaColorScheme,
  preferenceStorageKeys,
  probeBrowserPreferenceStorage,
  readStoredPreferences,
  withPreferenceFragment,
  type PreferenceStorage,
} from './preferences.ts';

/**
 * In-memory storage double. `failWrites` makes both writes and removals throw;
 * `failSetOnly` reproduces a read-only storage where removals still succeed
 * (the case that must not restore `persistable`).
 */
function fakeStorage(
  initial: Record<string, string> = {},
  options: { failWrites?: boolean; failReads?: boolean; failSetOnly?: boolean } = {},
) {
  const data = new Map(Object.entries(initial));
  const storage: PreferenceStorage = {
    getItem(key) {
      if (options.failReads) throw new DOMException('blocked', 'SecurityError');
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      if (options.failWrites || options.failSetOnly) {
        throw new DOMException('blocked', 'SecurityError');
      }
      data.set(key, value);
    },
    removeItem(key) {
      if (options.failWrites) throw new DOMException('blocked', 'SecurityError');
      data.delete(key);
    },
  };
  return { storage, data };
}

describe('preference storage model', () => {
  it('defaults to System / System / Default when nothing is stored', () => {
    const { storage } = fakeStorage();
    expect(readStoredPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
    expect(readStoredPreferences(null)).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads only explicit, valid values', () => {
    const { storage } = fakeStorage({
      [PREFERENCE_STORAGE_KEYS.theme]: 'dark',
      [PREFERENCE_STORAGE_KEYS.motion]: 'sometimes',
      [PREFERENCE_STORAGE_KEYS.textSize]: 'large',
    });
    expect(readStoredPreferences(storage)).toEqual({ theme: 'dark', motion: 'system', textSize: 'large' });
  });

  it('keeps the default when storage throws on read', () => {
    const { storage } = fakeStorage(
      { [PREFERENCE_STORAGE_KEYS.theme]: 'dark' },
      { failReads: true },
    );
    expect(readStoredPreferences(storage)).toEqual(DEFAULT_PREFERENCES);
  });

  it('accepts exactly the documented explicit values', () => {
    expect(explicitPreferenceValue('theme', 'light')).toBe('light');
    expect(explicitPreferenceValue('theme', 'system')).toBeNull();
    expect(isValidPreferenceValue('theme', 'system')).toBe(true);
    expect(isValidPreferenceValue('motion', 'reduce')).toBe(true);
    expect(isValidPreferenceValue('textSize', 'small')).toBe(true);
    expect(isValidPreferenceValue('textSize', 'huge')).toBe(false);
  });

  it('writes only explicit values and deletes the key when returning to the default', () => {
    const { storage, data } = fakeStorage();
    const store = new PreferenceStore({ storage });

    store.set('theme', 'dark');
    expect(data.get(PREFERENCE_STORAGE_KEYS.theme)).toBe('dark');

    // U01: returning to System deletes the override; no literal "system" is stored.
    store.set('theme', 'system');
    expect(data.has(PREFERENCE_STORAGE_KEYS.theme)).toBe(false);
    expect([...data.values()]).not.toContain('system');
  });

  it('never stores the literal default for text size or motion', () => {
    const { storage, data } = fakeStorage();
    const store = new PreferenceStore({ storage });
    store.set('textSize', 'large');
    store.set('textSize', 'default');
    store.set('motion', 'reduce');
    store.set('motion', 'system');
    expect([...data.keys()]).toEqual([]);
  });

  it('keeps the in-page value usable when storage is blocked, and reports it', () => {
    const { storage } = fakeStorage({}, { failWrites: true });
    const store = new PreferenceStore({ storage });
    const change = store.set('theme', 'dark');
    expect(change.state.theme).toBe('dark');
    expect(change.persisted).toBe(false);
    expect(store.persistable).toBe(false);
    // A later change still takes effect for this page.
    expect(store.set('theme', 'light').state.theme).toBe('light');
  });

  it('applies values in memory when localStorage is unavailable entirely', () => {
    const store = new PreferenceStore({ storage: null });
    const change = store.set('motion', 'reduce');
    expect(change.state.motion).toBe('reduce');
    expect(change.persisted).toBe(false);
    expect(store.persistable).toBe(false);
  });

  it('reset restores System / System / Default and removes every stored key', () => {
    const { storage, data } = fakeStorage({
      [PREFERENCE_STORAGE_KEYS.theme]: 'dark',
      [PREFERENCE_STORAGE_KEYS.motion]: 'reduce',
      [PREFERENCE_STORAGE_KEYS.textSize]: 'small',
    });
    const store = new PreferenceStore({ storage });
    const change = store.reset();
    expect(change.state).toEqual(DEFAULT_PREFERENCES);
    expect(change.persisted).toBe(true);
    for (const key of preferenceStorageKeys()) expect(data.has(key)).toBe(false);
  });

  it('notifies subscribers with the new state', () => {
    const { storage } = fakeStorage();
    const store = new PreferenceStore({ storage });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set('textSize', 'large');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      state: { textSize: 'large' },
      persisted: true,
    });
    unsubscribe();
    store.set('textSize', 'small');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('preference fragment (author origin hand-off)', () => {
  it('round-trips all three values through the fragment', () => {
    const preferences = { theme: 'dark', motion: 'reduce', textSize: 'large' } as const;
    const fragment = preferenceFragment(preferences);
    expect(fragment).toBe('theme=dark&motion=reduce&size=large');
    expect(parsePreferenceFragment(`#${fragment}`)).toEqual(preferences);
  });

  it('includes System / Default so the author origin can mirror them', () => {
    expect(parsePreferenceFragment(`#${preferenceFragment(DEFAULT_PREFERENCES)}`)).toEqual(
      DEFAULT_PREFERENCES,
    );
  });

  it('never includes anything except the three preferences', () => {
    const fragment = preferenceFragment({ theme: 'light', motion: 'full', textSize: 'small' });
    const names = [...new URLSearchParams(fragment).keys()];
    expect(names).toEqual(['theme', 'motion', 'size']);
    expect(fragment).not.toMatch(/session|token|csrf|code|state/i);
  });

  it('ignores unknown names and invalid values, and returns null when nothing matches', () => {
    expect(parsePreferenceFragment('#theme=dark&session=abc')).toEqual({ theme: 'dark' });
    expect(parsePreferenceFragment('#theme=purple&size=enormous')).toBeNull();
    expect(parsePreferenceFragment('#')).toBeNull();
    expect(parsePreferenceFragment('')).toBeNull();
  });

  it('replaces an existing fragment instead of appending a second one', () => {
    expect(withPreferenceFragment('https://author.invalid/new/', DEFAULT_PREFERENCES)).toBe(
      'https://author.invalid/new/#theme=system&motion=system&size=default',
    );
    expect(
      withPreferenceFragment('https://author.invalid/new/#theme=dark', { theme: 'light', motion: 'full', textSize: 'small' }),
    ).toBe('https://author.invalid/new/#theme=light&motion=full&size=small');
  });

  it('imports the fragment into this origin and deletes overrides restored to the default', () => {
    const { storage, data } = fakeStorage({ [PREFERENCE_STORAGE_KEYS.theme]: 'dark' });
    const store = new PreferenceStore({ storage });
    store.importFragment({ theme: 'system', motion: 'reduce' });
    expect(data.has(PREFERENCE_STORAGE_KEYS.theme)).toBe(false);
    expect(data.get(PREFERENCE_STORAGE_KEYS.motion)).toBe('reduce');
    expect(store.state).toMatchObject({ theme: 'system', motion: 'reduce' });
  });
});

describe('document hooks', () => {
  it('maps explicit values to root attributes and defaults to no attribute', () => {
    expect(preferenceAttributes(DEFAULT_PREFERENCES)).toEqual([
      { attribute: 'data-theme', value: null },
      { attribute: 'data-motion', value: null },
      { attribute: 'data-text-size', value: null },
    ]);
    expect(
      preferenceAttributes({ theme: 'light', motion: 'full', textSize: 'small' }).map((entry) => entry.value),
    ).toEqual(['light', 'full', 'small']);
  });

  it('keeps meta color-scheme in step with the theme choice', () => {
    expect(preferenceMetaColorScheme('system')).toBe('light dark');
    expect(preferenceMetaColorScheme('light')).toBe('light');
    expect(preferenceMetaColorScheme('dark')).toBe('dark');
  });
});

describe('first-paint boot script', () => {
  it('reads the same storage keys and only the allowed explicit values', () => {
    for (const key of preferenceStorageKeys()) expect(PREFERENCE_BOOT_SCRIPT).toContain(key);
    expect(PREFERENCE_BOOT_SCRIPT).toContain('"data-theme"');
    expect(PREFERENCE_BOOT_SCRIPT).toContain('"data-motion"');
    expect(PREFERENCE_BOOT_SCRIPT).toContain('"data-text-size"');
    expect(PREFERENCE_BOOT_SCRIPT).toContain('meta[name="color-scheme"]');
  });

  it('is synchronous, non-module code that cannot block parsing or leak data', () => {
    expect(PREFERENCE_BOOT_SCRIPT).not.toMatch(/\bimport\b|\bawait\b|=>/);
    expect(PREFERENCE_BOOT_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|session|token/i);
    // Wrapped in try/catch so a throwing localStorage cannot break first paint.
    expect(PREFERENCE_BOOT_SCRIPT.startsWith('(function(){try{')).toBe(true);
    expect(PREFERENCE_BOOT_SCRIPT).toContain('}catch(e){}');
  });
});

describe('settings radio sync script (P2-5)', () => {
  it('is generated from the same keys/values and is synchronous', () => {
    for (const key of preferenceStorageKeys()) expect(PREFERENCE_RADIO_SCRIPT).toContain(key);
    for (const value of ['light', 'dark', 'reduce', 'full', 'small', 'large']) {
      expect(PREFERENCE_RADIO_SCRIPT).toContain(`"${value}"`);
    }
    expect(PREFERENCE_RADIO_SCRIPT).toContain('input[data-preference]');
    expect(PREFERENCE_RADIO_SCRIPT).not.toMatch(/\bimport\b|\bawait\b|=>/);
    expect(PREFERENCE_RADIO_SCRIPT.startsWith('(function(){try{')).toBe(true);
  });

  it('derives the default radio state from DEFAULT_PREFERENCES instead of hard-coding it', () => {
    // Supplementary review risk 1: if the defaults ever change, the script must
    // change with them. The generated defaults table is the proof.
    expect(PREFERENCE_RADIO_SCRIPT).toContain(JSON.stringify(DEFAULT_PREFERENCES));
    expect(PREFERENCE_RADIO_SCRIPT).not.toContain('n==="textSize"');
    expect(PREFERENCE_RADIO_SCRIPT).not.toContain('"default":"system"');
  });
});

describe('read/write capability separation (P1-1 review)', () => {
  it('uses stored values even when writes fail, and never rewrites them', () => {
    const { storage, data } = fakeStorage(
      { [PREFERENCE_STORAGE_KEYS.theme]: 'dark', [PREFERENCE_STORAGE_KEYS.motion]: 'reduce' },
      { failWrites: true },
    );
    const store = new PreferenceStore({ storage, writable: false });
    expect(store.state, 'readable storage still supplies the stored preferences').toEqual({
      theme: 'dark',
      motion: 'reduce',
      textSize: 'default',
    });
    expect(store.persistable, 'saving is reported as unavailable').toBe(false);

    const change = store.set('theme', 'light');
    expect(change.state.theme, 'the current choice still applies in memory').toBe('light');
    expect(change.persisted).toBe(false);
    expect(data.get(PREFERENCE_STORAGE_KEYS.theme), 'the stored value is not corrupted').toBe('dark');
  });

  it('a successful removal does not restore persistability after a failed write', () => {
    // Supplementary review: read-only storage where removeItem works. Selecting
    // a default value must not flip the status back to "saved" for a theme that
    // never reached storage.
    const { storage } = fakeStorage({}, { failSetOnly: true });
    const store = new PreferenceStore({ storage, writable: false });

    store.set('theme', 'light');
    expect(store.persistable, 'the write failed').toBe(false);

    const removed = store.set('motion', 'system');
    expect(removed.persisted, 'removal success is not write capability').toBe(false);
    expect(store.persistable, 'still cannot claim settings are saved').toBe(false);
  });

  it('probe reports read-only storage without discarding readable values', () => {
    const { storage } = fakeStorage({ [PREFERENCE_STORAGE_KEYS.theme]: 'dark' }, { failWrites: true });
    expect(probeBrowserPreferenceStorage(storage)).toBe(false);
    expect(readStoredPreferences(storage).theme).toBe('dark');
  });

  it('probe removes its key again and retries a failed cleanup', async () => {
    const data = new Map<string, string>();
    let removeCalls = 0;
    const storage: PreferenceStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        removeCalls += 1;
        if (removeCalls === 1) throw new DOMException('transient', 'UnknownError');
        data.delete(key);
      },
    };
    expect(probeBrowserPreferenceStorage(storage), 'the write itself succeeded').toBe(true);
    expect(data.has('selfpage:preference:probe'), 'the failed removal left the key').toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(data.has('selfpage:preference:probe'), 'the retry cleaned the key').toBe(false);
  });

  it('cleanupPreferenceProbe removes a probe key left by an earlier page', () => {
    const { storage, data } = fakeStorage({ 'selfpage:preference:probe': '1' });
    expect(cleanupPreferenceProbe(storage)).toBe(true);
    expect(data.has('selfpage:preference:probe')).toBe(false);
  });
});
