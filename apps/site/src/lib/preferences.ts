/**
 * Public-site preference wiring (task 08).
 *
 * The model, storage keys, root attributes and fragment rules live in
 * `@selfpage/site-shell/preferences`, shared verbatim with the author app. This
 * file only owns the public site's page-scoped singleton so the global boot
 * module and the Settings page controls operate on the same store instance.
 *
 * The first-paint values are applied earlier by the inline `<head>` script in
 * `BaseLayout.astro`; this runtime controller re-applies the same state (it is
 * idempotent) and then keeps it in sync across tabs, bfcache restores and later
 * changes.
 */
import { initPreferences, type PreferencesController } from '@selfpage/site-shell/preferences';

interface PreferenceWindow extends Window {
  __selfpagePreferences?: PreferencesController;
}

/** Returns the page's single controller, creating it on first use. */
export function sitePreferences(): PreferencesController {
  const scope = window as PreferenceWindow;
  const existing = scope.__selfpagePreferences;
  if (existing) return existing;
  const controller = initPreferences(document, window);
  scope.__selfpagePreferences = controller;
  return controller;
}
