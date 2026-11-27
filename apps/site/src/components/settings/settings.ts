/**
 * Settings page controller (task 08).
 *
 * The shared store owns persistence and validation; this module only reflects
 * its state into the native radio controls and the save-status message. The
 * status is a `role="status"` live region, so a blocked localStorage (U02) is
 * announced instead of silently losing the choice.
 */
import { isValidPreferenceValue, type PreferenceName } from '@selfpage/site-shell/preferences';
import { sitePreferences } from '../../lib/preferences';

const SAVED_MESSAGE = 'Your settings are saved in this browser.';
const BLOCKED_MESSAGE =
  "Your settings can't be saved because this browser blocked local storage. They still apply on this page.";
const RESET_SAVED_MESSAGE =
  'Settings were reset to the System theme, System reduced motion and Default text size.';
const RESET_BLOCKED_MESSAGE =
  'Settings were reset for this page only. This browser blocked local storage, so the previous stored choices may return after a reload.';

function initSettingsPage(): void {
  const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-preference]'));
  if (radios.length === 0) return;

  const controller = sitePreferences();
  const status = document.querySelector<HTMLElement>('[data-settings-status]');
  const reset = document.querySelector<HTMLButtonElement>('[data-settings-reset]');

  const setStatus = (message: string): void => {
    if (status && status.textContent !== message) status.textContent = message;
  };

  const saveMessage = (): string =>
    controller.store.persistable ? SAVED_MESSAGE : BLOCKED_MESSAGE;

  const syncRadios = (): void => {
    const state = controller.store.state;
    for (const radio of radios) {
      const name = radio.dataset.preference as PreferenceName | undefined;
      if (name === undefined) continue;
      radio.checked = state[name] === radio.value;
    }
  };

  for (const radio of radios) {
    radio.addEventListener('change', () => {
      const name = radio.dataset.preference as PreferenceName | undefined;
      if (name === undefined || !radio.checked) return;
      if (!isValidPreferenceValue(name, radio.value)) return;
      controller.set(name, radio.value);
    });
  }

  controller.store.subscribe(() => {
    syncRadios();
    setStatus(saveMessage());
  });

  reset?.addEventListener('click', () => {
    const change = controller.reset();
    syncRadios();
    setStatus(change.persisted ? RESET_SAVED_MESSAGE : RESET_BLOCKED_MESSAGE);
  });

  syncRadios();
  setStatus(saveMessage());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSettingsPage, { once: true });
} else {
  initSettingsPage();
}

export {};
