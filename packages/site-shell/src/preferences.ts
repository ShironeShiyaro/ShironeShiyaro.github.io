/**
 * Shared user preferences (task 08): Theme, Reduced Motion and Text Size.
 *
 * This module is the single source of truth for the preference model, the
 * storage keys, the root attributes, the `<meta name="color-scheme">` value and
 * the non-sensitive cross-origin fragment. The public Astro site and the author
 * React app both import it through `@selfpage/site-shell/preferences`, so the
 * two origins cannot drift.
 *
 * Rules enforced here (frozen task-08 criteria):
 * - System (theme/motion) and Default (text size) are represented by an ABSENT
 *   storage key. Only an explicit choice is written, so "back to System" deletes
 *   the override instead of storing the literal `light`/`dark`.
 * - Storage is best effort. A blocked/disabled `localStorage` must never throw
 *   into the page, must keep the in-page preference usable, and is reported to
 *   the caller (`persistable === false`) so the settings UI can say it cannot
 *   save.
 * - The author origin receives only theme/motion/size through the URL fragment
 *   (never a query, never a session/token). The fragment is public data.
 * - The first-paint inline script is generated from the same keys/values
 *   (`PREFERENCE_BOOT_SCRIPT`) so it cannot disagree with the module.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type MotionPreference = 'system' | 'reduce' | 'full';
export type TextSizePreference = 'default' | 'small' | 'large';

export interface Preferences {
  theme: ThemePreference;
  motion: MotionPreference;
  textSize: TextSizePreference;
}

export type PreferenceName = keyof Preferences;

/** Every preference at its default: follow the system/leave the document alone. */
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  theme: 'system',
  motion: 'system',
  textSize: 'default',
});

/**
 * Per-preference storage keys. One key per preference keeps a `storage` event
 * cheap to filter and lets Reset remove exactly what exists. The `:preference:`
 * namespace cannot collide with the tab-scoped drawer keys.
 */
export const PREFERENCE_STORAGE_KEYS: Readonly<Record<PreferenceName, string>> = Object.freeze({
  theme: 'selfpage:preference:theme',
  motion: 'selfpage:preference:motion',
  textSize: 'selfpage:preference:text-size',
});

/** The explicit values that are allowed to be stored; the default is never stored. */
const EXPLICIT_VALUES: Readonly<Record<PreferenceName, readonly string[]>> = Object.freeze({
  theme: ['light', 'dark'],
  motion: ['reduce', 'full'],
  textSize: ['small', 'large'],
});

/** Root `data-*` attribute + spelling used by tokens.css for each preference. */
const ROOT_ATTRIBUTES: Readonly<Record<PreferenceName, string>> = Object.freeze({
  theme: 'data-theme',
  motion: 'data-motion',
  textSize: 'data-text-size',
});

const PREFERENCE_NAMES: readonly PreferenceName[] = ['theme', 'motion', 'textSize'];

/** The minimal `localStorage` surface used here, so tests can pass a fake. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Returns the explicit value when `raw` is a storable option, otherwise null. */
export function explicitPreferenceValue(name: PreferenceName, raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return EXPLICIT_VALUES[name].includes(raw) ? raw : null;
}

/** True when `value` is a valid value for `name`, including its default. */
export function isValidPreferenceValue(name: PreferenceName, value: string): boolean {
  return value === DEFAULT_PREFERENCES[name] || EXPLICIT_VALUES[name].includes(value);
}

/**
 * Reads the stored preferences. Missing, unreadable or invalid entries fall
 * back to the default, and a throwing storage never escapes into the page.
 */
export function readStoredPreferences(storage: PreferenceStorage | null): Preferences {
  const next: Preferences = { ...DEFAULT_PREFERENCES };
  if (!storage) return next;
  for (const name of PREFERENCE_NAMES) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(PREFERENCE_STORAGE_KEYS[name]);
    } catch {
      return next;
    }
    const explicit = explicitPreferenceValue(name, raw);
    if (explicit !== null) {
      // Narrowed by the shared EXPLICIT_VALUES table; the cast keeps the model
      // readable without a per-key switch.
      next[name] = explicit as never;
    }
  }
  return next;
}

/** Probe key used only to detect whether writes work; never a preference. */
const PREFERENCE_PROBE_KEY = 'selfpage:preference:probe';

/**
 * Returns the browser `localStorage` handle, or null only when even *reading*
 * the object throws (storage disabled for the origin).
 *
 * A successful read must never be discarded because writes fail: some browsers
 * expose previously stored values but throw on every `setItem` (quota zero,
 * read-only storage). Writability is reported separately by
 * `probeBrowserPreferenceStorage()` and only drives `persistable`.
 */
export function getBrowserPreferenceStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Best-effort write probe. Returns false when storing is unavailable, but the
 * caller still reads whatever is already stored; a failed probe must not turn
 * an existing preference into "no preference".
 *
 * The probe key is always cleaned up on a best-effort basis. If removal fails
 * (rare, usually transient) it is retried once in a task and again by the next
 * `cleanupPreferenceProbe()` call, so a dirty probe key cannot survive.
 */
export function probeBrowserPreferenceStorage(storage: PreferenceStorage | null): boolean {
  if (!storage) return false;
  let writable = false;
  try {
    storage.setItem(PREFERENCE_PROBE_KEY, '1');
    writable = true;
  } catch {
    // Read-only storage: keep reading, report that saving is unavailable.
    writable = false;
  }
  if (!cleanupPreferenceProbe(storage)) {
    try {
      setTimeout(() => cleanupPreferenceProbe(storage), 0);
    } catch {
      // No timers (non-browser test double): the next init retries.
    }
  }
  return writable;
}

/** Removes a probe key left behind by an interrupted probe; best effort. */
export function cleanupPreferenceProbe(storage: PreferenceStorage | null = null): boolean {
  const target = storage ?? getBrowserPreferenceStorage();
  if (!target) return true;
  try {
    target.removeItem(PREFERENCE_PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface PreferenceChange {
  state: Preferences;
  /** False when the change could not be written (storage blocked or missing). */
  persisted: boolean;
}

export type PreferenceListener = (change: PreferenceChange) => void;

/**
 * Small observable store around the preference model. It owns persistence and
 * value validation; applying the state to the document is a separate pure step
 * (`applyPreferencesToDocument`) so the store is testable without a DOM.
 */
export class PreferenceStore {
  private current: Preferences;
  private readonly storage: PreferenceStorage | null;
  private readonly listeners = new Set<PreferenceListener>();
  private writable: boolean;

  constructor(options: {
    storage: PreferenceStorage | null;
    /**
     * Initial write capability. Reads are always attempted; `false` only marks
     * that saving is unavailable (probe failed), never that stored values are
     * ignored. Defaults to true when a storage handle exists.
     */
    writable?: boolean;
    initial?: Preferences;
  }) {
    this.storage = options.storage;
    this.writable = options.storage !== null && (options.writable ?? true);
    this.current = options.initial ? { ...options.initial } : readStoredPreferences(options.storage);
  }

  get state(): Preferences {
    return { ...this.current };
  }

  /** True while every attempted write has succeeded in this page. */
  get persistable(): boolean {
    return this.storage !== null && this.writable;
  }

  set(name: PreferenceName, value: string): PreferenceChange {
    if (!isValidPreferenceValue(name, value)) {
      return { state: this.state, persisted: this.persistable };
    }
    this.current = { ...this.current, [name]: value } as Preferences;
    const change = this.persist(name, value as Preferences[PreferenceName]);
    this.emit(change);
    return change;
  }

  /** Restores System / System / Default and deletes every stored override. */
  reset(): PreferenceChange {
    this.current = { ...DEFAULT_PREFERENCES };
    let persisted = this.storage !== null;
    if (this.storage) {
      for (const name of PREFERENCE_NAMES) {
        persisted = this.remove(this.storage, name) && persisted;
      }
    }
    const change = { state: this.state, persisted: persisted && this.persistable };
    this.emit(change);
    return change;
  }

  /** Adopts state read elsewhere (another tab / the author fragment). */
  adopt(next: Preferences): PreferenceChange {
    const changed =
      next.theme !== this.current.theme ||
      next.motion !== this.current.motion ||
      next.textSize !== this.current.textSize;
    this.current = { ...next };
    const change = { state: this.state, persisted: this.persistable };
    if (changed) this.emit(change);
    return change;
  }

  /**
   * Writes the author-origin fragment values into this origin's own storage and
   * adopts them. Explicit values are stored; defaults delete the key, so a
   * fragment can also undo a previous override. Returns true when every write
   * succeeded (a blocked author storage still applies the values in memory).
   */
  importFragment(partial: Partial<Preferences>): PreferenceChange {
    let persisted = this.storage !== null;
    for (const name of PREFERENCE_NAMES) {
      const value = partial[name];
      if (value === undefined || !isValidPreferenceValue(name, value)) continue;
      this.current = { ...this.current, [name]: value } as Preferences;
      persisted = this.persist(name, value as Preferences[PreferenceName]).persisted && persisted;
    }
    const change = { state: this.state, persisted: persisted && this.persistable };
    this.emit(change);
    return change;
  }

  subscribe(listener: PreferenceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private persist(name: PreferenceName, value: Preferences[PreferenceName]): PreferenceChange {
    if (!this.storage) return { state: this.state, persisted: false };
    if (value === DEFAULT_PREFERENCES[name]) {
      this.remove(this.storage, name);
    } else {
      try {
        this.storage.setItem(PREFERENCE_STORAGE_KEYS[name], value);
        this.writable = true;
      } catch {
        this.writable = false;
      }
    }
    return { state: this.state, persisted: this.persistable };
  }

  /**
   * Removes a stored override. A successful removal is deliberately NOT
   * evidence that the storage is writable: a read-only localStorage can still
   * delete keys it already holds, but that does not make a later `setItem`
   * succeed. Only a real preference write may restore `persistable`, otherwise
   * the status would claim "saved" for a value that never reached storage
   * (supplementary review, U02).
   */
  private remove(storage: PreferenceStorage, name: PreferenceName): boolean {
    try {
      storage.removeItem(PREFERENCE_STORAGE_KEYS[name]);
      return true;
    } catch {
      this.writable = false;
      return false;
    }
  }

  private emit(change: PreferenceChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

/** Root attributes for the current state; a default value removes the attribute. */
export function preferenceAttributes(
  preferences: Preferences,
): Array<{ attribute: string; value: string | null }> {
  return PREFERENCE_NAMES.map((name) => {
    const value = preferences[name];
    return {
      attribute: ROOT_ATTRIBUTES[name],
      value: value === DEFAULT_PREFERENCES[name] ? null : value,
    };
  });
}

/** The `<meta name="color-scheme">` content for a theme choice. */
export function preferenceMetaColorScheme(theme: ThemePreference): string {
  return theme === 'system' ? 'light dark' : theme;
}

/**
 * Applies a preference state to a document: root `data-*` hooks for CSS and the
 * `color-scheme` meta so native scrollbars/form controls and the initial canvas
 * match. Idempotent; used by the first-paint script equivalent and every later
 * change.
 */
export function applyPreferencesToDocument(preferences: Preferences, doc: Document): void {
  const root = doc.documentElement;
  for (const entry of preferenceAttributes(preferences)) {
    if (entry.value === null) root.removeAttribute(entry.attribute);
    else root.setAttribute(entry.attribute, entry.value);
  }
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', preferenceMetaColorScheme(preferences.theme));
}

/**
 * Non-sensitive preference fragment shared with the author origin (R08-4).
 * Format: `#theme=dark&motion=reduce&size=large`. All three values are always
 * included so the author origin mirrors System/Default as well (it then deletes
 * its own overrides); no session, token or other data is ever included.
 */
export function preferenceFragment(preferences: Preferences): string {
  return new URLSearchParams({
    theme: preferences.theme,
    motion: preferences.motion,
    size: preferences.textSize,
  }).toString();
}

/** Adds or replaces the preference fragment on an href, keeping the path intact. */
export function withPreferenceFragment(href: string, preferences: Preferences): string {
  const base = href.split('#')[0] ?? href;
  return `${base}#${preferenceFragment(preferences)}`;
}

/**
 * Parses a preference fragment (`#theme=dark&motion=reduce&size=large`).
 * Unknown names and invalid values are ignored; a fragment without any valid
 * preference returns null so the author origin keeps its own stored state.
 */
export function parsePreferenceFragment(hash: string): Partial<Preferences> | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw === '') return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const partial: Partial<Preferences> = {};
  let found = false;
  const fromParam = (name: PreferenceName, parameter: string) => {
    const value = params.get(parameter);
    if (value === null || !isValidPreferenceValue(name, value)) return;
    partial[name] = value as never;
    found = true;
  };
  fromParam('theme', 'theme');
  fromParam('motion', 'motion');
  fromParam('textSize', 'size');
  return found ? partial : null;
}

/** Reads every explicit preference from another tab's `storage` event. */
export function preferenceStorageKeys(): readonly string[] {
  return PREFERENCE_NAMES.map((name) => PREFERENCE_STORAGE_KEYS[name]);
}

/**
 * First-paint script for the public site's `<head>`.
 *
 * It is generated here, from the same keys and allowed values as the runtime
 * module, so the two cannot drift. It is deliberately tiny, synchronous,
 * wrapped in try/catch and touches only `<html>` attributes plus the
 * `color-scheme` meta: it must run before the first background paint and must
 * never block parsing. The author origin cannot use an inline script (its CSP
 * is `script-src 'self'`), so it applies the same state from its external boot
 * module instead.
 */
export const PREFERENCE_BOOT_SCRIPT = [
  '(function(){try{',
  'var d=document.documentElement,m=document.querySelector(\'meta[name="color-scheme"]\');',
  `var t=localStorage.getItem(${JSON.stringify(PREFERENCE_STORAGE_KEYS.theme)});`,
  'if(t==="light"||t==="dark"){d.setAttribute("data-theme",t);if(m)m.setAttribute("content",t);}',
  `var o=localStorage.getItem(${JSON.stringify(PREFERENCE_STORAGE_KEYS.motion)});`,
  'if(o==="reduce"||o==="full")d.setAttribute("data-motion",o);',
  `var s=localStorage.getItem(${JSON.stringify(PREFERENCE_STORAGE_KEYS.textSize)});`,
  'if(s==="small"||s==="large")d.setAttribute("data-text-size",s);',
  '}catch(e){}})();',
].join('');

/**
 * End-of-body script for the Settings page (task 08 review P2-5).
 *
 * The page is static, so the server-rendered radios can only show the defaults.
 * This tiny parser-blocking script runs after the controls exist and before the
 * page is painted, syncing the checked radio to the same storage values the
 * head boot script already applied. The later module still owns reactive
 * updates; this script exists only so the first frame does not show System for
 * a stored Light/Dark choice. Generated from the same keys/values as the model.
 */
export const PREFERENCE_RADIO_SCRIPT = [
  '(function(){try{',
  `var k=${JSON.stringify(PREFERENCE_STORAGE_KEYS)};`,
  `var v=${JSON.stringify(EXPLICIT_VALUES)};`,
  `var g=${JSON.stringify(DEFAULT_PREFERENCES)};`,
  'var s=window.localStorage,r=document.querySelectorAll("input[data-preference]");',
  'for(var i=0;i<r.length;i++){var n=r[i].getAttribute("data-preference");',
  'var d=g[n],x=null;',
  'try{x=s.getItem(k[n]);}catch(e){}',
  'r[i].checked=(x&&v[n]&&v[n].indexOf(x)>=0)?x===r[i].value:d===r[i].value;',
  '}}catch(e){}})();',
].join('');

export interface PreferencesController {
  readonly store: PreferenceStore;
  /** Re-applies the current state to the document and to `[data-new-href]`. */
  apply(): void;
  set(name: PreferenceName, value: string): PreferenceChange;
  reset(): PreferenceChange;
  dispose(): void;
}

/**
 * Wires the shared model to a live document: first apply, New! links carrying
 * the preference fragment, cross-tab `storage` sync and bfcache re-adoption.
 */
export function initPreferences(doc: Document, win: Window): PreferencesController {
  const storage = getBrowserPreferenceStorage();
  // Read capability and write capability are independent: a read-only storage
  // still supplies the stored theme/motion/size, it only cannot save new ones.
  const store = new PreferenceStore({
    storage,
    writable: probeBrowserPreferenceStorage(storage),
  });
  cleanupPreferenceProbe(storage);

  const apply = (): void => {
    applyPreferencesToDocument(store.state, doc);
    for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[data-new-href]')) {
      const base = link.dataset.newHref ?? '';
      if (base === '') continue;
      link.setAttribute('href', withPreferenceFragment(base, store.state));
    }
  };

  const unsubscribe = store.subscribe(() => apply());
  apply();

  const onStorage = (event: StorageEvent): void => {
    // This page cannot read its own storage (getter threw): there is nothing
    // authoritative to adopt. Adopting `readStoredPreferences(null)` would
    // reset the user's in-memory choice because another tab wrote its own
    // storage (supplementary review, risk 3).
    if (storage === null) return;
    if (event.key !== null && !preferenceStorageKeys().includes(event.key)) return;
    store.adopt(readStoredPreferences(storage));
    apply();
  };
  win.addEventListener('storage', onStorage);
  const onPageShow = (): void => {
    // Same guard for bfcache restores: without readable storage the in-memory
    // choices are the only truth and must not be replaced by defaults.
    if (storage === null) return;
    store.adopt(readStoredPreferences(storage));
    apply();
  };
  win.addEventListener('pageshow', onPageShow);

  return {
    store,
    apply,
    set: (name, value) => store.set(name, value),
    reset: () => store.reset(),
    dispose: () => {
      unsubscribe();
      win.removeEventListener('storage', onStorage);
      win.removeEventListener('pageshow', onPageShow);
    },
  };
}
