/**
 * Pre-mount boot for the author app (task 07.5, extended by task 08).
 *
 * Applies the tab-scoped drawer state before React mounts, exactly like the
 * public site's inline boot in `SiteShell.astro`; React then renders the same
 * state and the shared shell's drawer controller adopts it.
 *
 * Task 08 adds the author side of the preference hand-off: the public site
 * appends a non-sensitive fragment (`#theme=…&motion=…&size=…`) to the New!
 * link. This module writes those three values into the author origin's own
 * `localStorage`, deletes the one-time fragment and applies the resulting
 * Theme/Reduced Motion/Text Size before the first React render. No session,
 * token or other data is read from the fragment, and a blocked author storage
 * still applies the values for this page.
 *
 * This lives in an external module (not an inline `<script>`) because the
 * Worker's CSP is `script-src 'self'`: an inline script is refused, which used
 * to leave `data-drawer-open`/`data-nav-ready` unset (review P1-1). Vite emits
 * this file as a same-origin module chunk.
 */
import {
  PreferenceStore,
  applyPreferencesToDocument,
  cleanupPreferenceProbe,
  getBrowserPreferenceStorage,
  parsePreferenceFragment,
  probeBrowserPreferenceStorage,
} from '@selfpage/site-shell/preferences';

const root = document.documentElement;
let drawerOpen = false;
try {
  drawerOpen = sessionStorage.getItem('selfpage:drawer-open') === 'true';
} catch {
  drawerOpen = false;
}
root.setAttribute('data-drawer-open', String(drawerOpen));
// `data-nav-ready` keeps the narrow fallback from putting the drawer in flow
// while the app is mounting (the shell CSS uses `:root:not([data-nav-ready])`).
root.setAttribute('data-nav-ready', '');

// Theme / Reduced Motion / Text Size. The fragment is public preference data
// only; it is applied and then removed from the address bar so a later reload
// reads this origin's own storage instead of a stale URL. Reads and writes are
// independent: a read-only storage still applies what it holds.
const storage = getBrowserPreferenceStorage();
const store = new PreferenceStore({
  storage,
  writable: probeBrowserPreferenceStorage(storage),
});
cleanupPreferenceProbe(storage);
const fragmentPreferences = parsePreferenceFragment(window.location.hash);
if (fragmentPreferences) {
  store.importFragment(fragmentPreferences);
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  } catch {
    // History rewriting is best effort; the preferences already applied.
  }
}
applyPreferencesToDocument(store.state, document);

export {};
