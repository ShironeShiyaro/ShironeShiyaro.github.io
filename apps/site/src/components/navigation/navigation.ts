/**
 * Task 03 navigation controller (progressive enhancement).
 *
 * Responsibilities:
 * - drawer state machine (`html[data-drawer-open]`, aria-expanded/inert/aria-hidden)
 * - persistent drawer state for the current tab (`sessionStorage`): navigation
 *   never dismisses the drawer, only explicit Menu/Close/Escape/backdrop actions
 *   do (user 2026-11-25 contract)
 * - narrow-screen modal semantics: dialog role, external inert, focus trap,
 *   Close/Menu/Escape/backdrop dismissal, focus restore to Menu
 * - exclusive Blog year expansion with a three-state toggle (D36): activating
 *   the expanded year collapses its list again
 * - generic fragment scrollspy with exactly one `aria-current`
 * - marquee overflow detection for level-3 blog labels
 * - fixed-size preview cards with viewport flipping (no Interest Invokers or
 *   CSS anchor positioning required)
 *
 * No functionality depends on transition/animation end events: layout and
 * focus reach their final state synchronously, and CSS hides the closed drawer
 * after the slide via a delayed `visibility` transition.
 */

import { isSameDocument, nextExpandedYear, resolveYearActivation } from '@selfpage/site-shell/nav-model';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const SPY_TOLERANCE = 1;
const MARQUEE_PX_PER_SECOND = 55;
const PREVIEW_MARGIN = 8;
const PREVIEW_GAP = 12;

/**
 * The single source of truth for the tab-scoped drawer state. `SiteShell`'s
 * inline boot script reads the same key before first paint. It is only written
 * by an explicit toggle/Close/Escape/backdrop action, never by navigation, so
 * the drawer stays open across same-tab route changes and reloads while a new
 * tab (empty sessionStorage) starts closed.
 */
const DRAWER_STORAGE_KEY = 'selfpage:drawer-open';

/** Stored drawer state, or `null` when absent or unreadable (default: closed). */
function readStoredDrawerOpen(): boolean | null {
  try {
    const value = window.sessionStorage.getItem(DRAWER_STORAGE_KEY);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  } catch {
    // Storage throws when site data is blocked; fail safe to closed.
    return null;
  }
}

/** Best-effort persistence: a failed write must never break navigation. */
function writeStoredDrawerOpen(open: boolean): void {
  try {
    window.sessionStorage.setItem(DRAWER_STORAGE_KEY, String(open));
  } catch {
    // Persistence is progressive enhancement; the current page stays correct.
  }
}

/**
 * The middle navigation scroller's position is part of the same tab-scoped
 * persistent navigation contract as the open state (user 2026-11-25): switching
 * articles or pages must not rewind the sidebar to its top. `SiteShell`'s inline
 * boot script restores the same key before first paint; the controller restores
 * again once it owns the drawer and writes the key only for genuine user
 * scrolls.
 */
const DRAWER_SCROLL_STORAGE_KEY = 'selfpage:drawer-scroll';

/** Stored scroll offset, or 0 when absent, unreadable or invalid. */
function readStoredDrawerScrollTop(): number {
  try {
    const value = Number.parseFloat(
      window.sessionStorage.getItem(DRAWER_SCROLL_STORAGE_KEY) ?? '',
    );
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    // Storage throws when site data is blocked; the top is a safe default.
    return 0;
  }
}

/**
 * Best-effort persistence: a failed write must never break navigation. Returns
 * whether the value is now stored, so the caller only advances its in-memory
 * baseline after a successful write (a transient failure is retried).
 */
function writeStoredDrawerScrollTop(top: number): boolean {
  try {
    window.sessionStorage.setItem(DRAWER_SCROLL_STORAGE_KEY, String(Math.max(0, Math.round(top))));
    return true;
  } catch {
    // Persistence is progressive enhancement; the current page stays correct.
    return false;
  }
}

/**
 * `interactive` is an explicit user toggle: focus must move to Close (narrow
 * open) or Menu (close). `restore` adopts stored state: wide screens never
 * steal focus on load, but a narrow modal must still own focus (N02).
 */
type DrawerFocusPolicy = 'interactive' | 'restore';

interface PreviewState {
  link: HTMLAnchorElement;
  popover: HTMLElement;
}

function scheduleFrame(callback: () => void): () => void {
  let pending = 0;
  return () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      callback();
    });
  };
}

/** Decoded fragment id without the leading `#`, or an empty string. */
function currentHash(): string {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The line where a fragment target is considered current. It must match the
 * CSS `scroll-padding-block-start` used for anchor/focus scrolling so the
 * scrollspy agrees with the browser at every text scale (200% included).
 * Falls back to the top-bar bottom plus one root-rem only when the computed
 * scroll padding is unavailable.
 */
function scrollTriggerLine(): number {
  const rootStyle = getComputedStyle(document.documentElement);
  const scrollPadding = Number.parseFloat(rootStyle.scrollPaddingBlockStart);
  if (Number.isFinite(scrollPadding) && scrollPadding > 0) return scrollPadding;
  const topBar = document.querySelector<HTMLElement>('.top-bar');
  const rootRem = Number.parseFloat(rootStyle.fontSize);
  const extra = Number.isFinite(rootRem) && rootRem > 0 ? rootRem : 16;
  return (topBar?.getBoundingClientRect().bottom ?? 0) + extra;
}

function initNavigation(): void {
  const root = document.documentElement;
  if (root.dataset.navInitialized === 'true') return;
  root.dataset.navInitialized = 'true';

  const drawerNode = document.getElementById('site-drawer');
  const menuNode = document.querySelector<HTMLButtonElement>('[data-drawer-toggle]');
  if (!drawerNode || !menuNode) return;
  const drawer: HTMLElement = drawerNode;
  const menu: HTMLButtonElement = menuNode;
  // The inline boot may have fallen back to the static open navigation (module
  // loaded late after its timeout); re-enable the controller once it is ready.
  root.setAttribute('data-nav-ready', '');
  menu.disabled = false;

  const closeButtonNode = drawer.querySelector<HTMLButtonElement>('[data-drawer-close]');
  const scrollAreaNode = drawer.querySelector<HTMLElement>('[data-drawer-scroll]');
  const backdropNode = document.querySelector<HTMLElement>('[data-drawer-backdrop]');
  if (!closeButtonNode || !scrollAreaNode || !backdropNode) return;
  const closeButton: HTMLButtonElement = closeButtonNode;
  const scrollArea: HTMLElement = scrollAreaNode;
  const backdrop: HTMLElement = backdropNode;

  const main = document.querySelector<HTMLElement>('main');
  const footer = document.querySelector<HTMLElement>('.site-footer');
  const skipLink = document.querySelector<HTMLElement>('.skip-link');
  const brand = document.querySelector<HTMLElement>('.site-brand');

  const narrowQuery = window.matchMedia('(max-width: 48em)');
  const hoverQuery = window.matchMedia('(hover: hover)');

  // The inline boot applied the stored state before first paint; read the same
  // key here so the controller is authoritative even if that script was
  // skipped, and so a late fallback that force-opened the drawer is repaired.
  let isOpen = readStoredDrawerOpen() === true;
  let narrowMode = narrowQuery.matches;
  let preview: PreviewState | null = null;

  // ---------------------------------------------------------------------
  // Drawer state
  // ---------------------------------------------------------------------

  const outsideElements = [main, footer, skipLink, brand].filter(
    (element): element is HTMLElement => element !== null,
  );

  // Narrow modals must not scroll the inert page behind the backdrop.
  // `scrollbar-gutter: stable` in CSS keeps the viewport width stable when the
  // browser removes the scrollbar.
  let backgroundScrollLocked = false;

  function lockBackgroundScroll(): void {
    if (backgroundScrollLocked) return;
    backgroundScrollLocked = true;
    // Classic scrollbars remove their width when html overflow becomes hidden.
    // Reserve that width only when one actually exists; overlay scrollbars
    // (mobile/headless) must not gain a synthetic gutter.
    const scrollbarGap = window.innerWidth - document.documentElement.clientWidth;
    root.classList.add('nav-scroll-locked');
    root.classList.toggle('nav-scroll-locked--gutter', scrollbarGap > 0);
  }

  function unlockBackgroundScroll(): void {
    if (!backgroundScrollLocked) return;
    backgroundScrollLocked = false;
    root.classList.remove('nav-scroll-locked', 'nav-scroll-locked--gutter');
  }

  function setOutsideHidden(hidden: boolean): void {
    for (const element of outsideElements) {
      if (hidden) {
        element.setAttribute('inert', '');
        element.setAttribute('aria-hidden', 'true');
      } else {
        element.removeAttribute('inert');
        element.removeAttribute('aria-hidden');
      }
    }
  }

  function applyModalAttributes(modal: boolean): void {
    if (modal) {
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.setAttribute('aria-label', 'Site menu');
    } else {
      drawer.removeAttribute('role');
      drawer.removeAttribute('aria-modal');
      drawer.removeAttribute('aria-label');
    }
    setOutsideHidden(modal);
    if (modal) lockBackgroundScroll();
    else unlockBackgroundScroll();
  }

  function menuFocus(): void {
    menu.focus({ preventScroll: true });
  }

  /**
   * Fragment navigation moves focus to the target (or body) after a click.
   * While the narrow drawer is modal, return focus to the activated link so
   * focus never ends up in inert background content.
   */
  function keepFocusInModal(link: HTMLAnchorElement): void {
    if (!isOpen || !narrowMode) return;
    requestAnimationFrame(() => {
      if (isOpen && narrowMode && drawer.contains(link)) link.focus({ preventScroll: true });
    });
  }

  /**
   * An open narrow modal must own focus (N02). Browsers can move focus to
   * `<body>` while resolving a fragment after this controller focused the
   * drawer (cross-document `#hash` navigations do it after DOMContentLoaded),
   * so re-assert focus once the navigation settles. This only runs when focus
   * is genuinely outside the drawer, so it never fights a user who already is
   * inside it or a bfcache restore that kept its focus.
   */
  function reassertModalFocus(): void {
    if (!isOpen || !narrowMode) return;
    const active = document.activeElement;
    if (active instanceof Node && drawer.contains(active)) return;
    closeButton.focus({ preventScroll: true });
  }

  /**
   * Applies the open state to the DOM and the narrow-screen modal contract.
   * The open path never half-applies modality: `applyModalAttributes` sets the
   * dialog role, background inert and scroll lock together, so a drawer
   * restored from storage cannot be visually open while inert/focus still say
   * closed. It is idempotent, so it also repairs a DOM left behind by the
   * inline boot fallback or by a frozen bfcache page.
   */
  function applyOpen(next: boolean, focusPolicy: DrawerFocusPolicy): void {
    const changed = next !== isOpen;
    isOpen = next;
    root.setAttribute('data-drawer-open', String(next));
    menu.setAttribute('aria-expanded', String(next));

    if (next) {
      drawer.removeAttribute('inert');
      drawer.removeAttribute('aria-hidden');
      applyModalAttributes(narrowMode);
      scheduleOverflowMeasure();
      if (narrowMode) {
        const active = document.activeElement;
        const inside = active instanceof Node && drawer.contains(active);
        if ((focusPolicy === 'interactive' && changed) || !inside) {
          closeButton.focus({ preventScroll: true });
        }
      }
      return;
    }

    hidePreview();
    // Move focus before hiding the drawer so focus is never inside an
    // aria-hidden/inert subtree.
    const active = document.activeElement;
    const inside = active instanceof Node && drawer.contains(active);
    if ((focusPolicy === 'interactive' && changed) || inside) menuFocus();
    applyModalAttributes(false);
    drawer.setAttribute('inert', '');
    drawer.setAttribute('aria-hidden', 'true');
  }

  function setOpen(next: boolean): void {
    // Only explicit user actions reach this function, so this is the only
    // place that writes the persisted state; navigation clicks never do. The
    // idempotent apply also repairs any half state left by a late module load.
    writeStoredDrawerOpen(next);
    applyOpen(next, 'interactive');
  }

  menu.addEventListener('click', () => {
    setOpen(!isOpen);
  });

  closeButton.addEventListener('click', () => {
    setOpen(false);
  });

  backdrop.addEventListener('click', () => {
    if (narrowMode) setOpen(false);
  });

  // ---------------------------------------------------------------------
  // Persistent drawer scroll position
  // ---------------------------------------------------------------------

  // The stored offset must come from the user, never from the browser. Several
  // browser-driven scrolls look like user input: a restore on a shorter page is
  // clamped and emits `scroll`, and a resize/zoom or a content shrink can clamp
  // the scroller later. So a scroll only counts while a user gesture is driving
  // the scroller (pointer held on it, or an input event in the recent window),
  // and the flushed value is the last position recorded during such a gesture,
  // not the current `scrollTop`. A clamped restore therefore cannot overwrite a
  // longer list's position, and neither can a viewport change after scrolling.
  // A shrink caused by the user's own click (collapsing a year) is the position
  // the user then sees, so it stays a user position; only clamps without input
  // (resize/zoom/layout) are ignored.
  const USER_SCROLL_WINDOW_MS = 1500;
  let savedScrollTop = readStoredDrawerScrollTop();
  let userScrollTop: number | null = null;
  let lastInputAt = 0;
  let pointerHeld = false;
  let userTookOver = false;
  let scrollSaveFrame = 0;
  /**
   * D37: a year disclosure on a Blog article may shrink the drawer list and let
   * the browser clamp the scroller; that clamp is not a user scroll and must not
   * overwrite the stored position. The window also swallows the pointerdown the
   * click itself bubbles into the scroller.
   */
  let suppressScrollRecordUntil = 0;

  function suppressScrollRecord(): void {
    suppressScrollRecordUntil = performance.now() + 600;
    userScrollTop = null;
  }

  function markUserInput(): void {
    userTookOver = true;
    lastInputAt = performance.now();
  }

  function userDrivingScroll(): boolean {
    if (pointerHeld) return true;
    // `lastInputAt === 0` is the "no input since the last reset" sentinel;
    // without this check a fresh document (performance.now() is small) would
    // look like an input just happened and a clamped restore would be written.
    if (lastInputAt <= 0) return false;
    return performance.now() - lastInputAt <= USER_SCROLL_WINDOW_MS;
  }

  function flushUserScrollTop(): void {
    scrollSaveFrame = 0;
    if (userScrollTop === null) return;
    const top = Math.round(userScrollTop);
    if (top === savedScrollTop) return;
    // Advance the in-memory baseline only after the write went through, so a
    // transient storage failure is retried instead of being hidden forever.
    if (writeStoredDrawerScrollTop(top)) savedScrollTop = top;
  }

  function cancelScheduledSave(): void {
    if (!scrollSaveFrame) return;
    cancelAnimationFrame(scrollSaveFrame);
    scrollSaveFrame = 0;
  }

  /** Re-apply the stored position until the user takes over the scroller. */
  function restoreScrollTop(): void {
    if (userTookOver) return;
    const stored = readStoredDrawerScrollTop();
    if (stored <= 0) return;
    if (Math.abs(scrollArea.scrollTop - stored) < 1) return;
    scrollArea.scrollTop = stored;
  }

  scrollArea.addEventListener(
    'scroll',
    () => {
      // A D37 disclosure on an article page may clamp the scroller; never record
      // that as a user position.
      if (performance.now() < suppressScrollRecordUntil) {
        userScrollTop = null;
        return;
      }
      if (!userDrivingScroll()) return;
      userScrollTop = scrollArea.scrollTop;
      if (scrollSaveFrame) return;
      scrollSaveFrame = requestAnimationFrame(flushUserScrollTop);
    },
    { passive: true },
  );

  // Inputs that let the user drive the scroller. Pointer/touch/wheel cover the
  // mouse, touch and the native scrollbar (Chromium dispatches
  // pointerdown/mousedown on the region when its scrollbar is used); `focusin`
  // covers the browser scrolling a Tab-focused link into view; the scroll keys
  // cover the keyboard region.
  scrollArea.addEventListener('wheel', markUserInput, { passive: true });
  scrollArea.addEventListener('touchstart', markUserInput, { passive: true });
  scrollArea.addEventListener('touchmove', markUserInput, { passive: true });
  scrollArea.addEventListener('mousedown', markUserInput);
  scrollArea.addEventListener('focusin', markUserInput);
  scrollArea.addEventListener('pointerdown', () => {
    pointerHeld = true;
    markUserInput();
  });
  scrollArea.addEventListener('keydown', (event) => {
    if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'PageUp' ||
      event.key === 'PageDown' ||
      event.key === 'Home' ||
      event.key === 'End' ||
      event.key === ' ' ||
      event.key === 'Spacebar'
    ) {
      markUserInput();
    }
  });

  function releasePointer(): void {
    pointerHeld = false;
  }
  // The mouse is implicitly captured while a button is down, so these reach the
  // window even when the button is released outside the page. `mouseup` covers
  // engines that do not dispatch pointer events for a native scrollbar drag;
  // a move with no buttons pressed ends a latch left by a lost release.
  window.addEventListener('pointerup', releasePointer, true);
  window.addEventListener('pointercancel', releasePointer, true);
  window.addEventListener('mouseup', releasePointer, true);
  window.addEventListener('blur', releasePointer);
  scrollArea.addEventListener(
    'pointermove',
    (event) => {
      if (event.buttons === 0) pointerHeld = false;
    },
    { passive: true },
  );

  // A viewport/zoom change can clamp the offset without any user input. Drop the
  // gesture state and the "recent input" marker, so the clamp's scroll event is
  // ignored (review P1: 560 -> 900 used to rewrite 54 as 0) while a real scroll
  // that starts after the resize is still recorded.
  window.addEventListener('resize', () => {
    cancelScheduledSave();
    pointerHeld = false;
    lastInputAt = 0;
  });

  // The final user position is flushed when the tab is hidden or the document
  // goes away (link navigation and bfcache entry both fire `pagehide`). Writing
  // the recorded user position, not `scrollTop`, keeps a later clamp out.
  function flushNow(): void {
    cancelScheduledSave();
    pointerHeld = false;
    flushUserScrollTop();
  }
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });

  // ---------------------------------------------------------------------
  // Narrow-screen focus trap
  // ---------------------------------------------------------------------

  function focusableInDrawer(): HTMLElement[] {
    const candidates = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    return candidates.filter((element) => {
      if (element.closest('[hidden]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return element.getClientRects().length > 0;
    });
  }

  function trapTab(event: KeyboardEvent): void {
    const focusable = focusableInDrawer();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    const active = document.activeElement;
    const insideDrawer = active instanceof Node && drawer.contains(active);
    if (!insideDrawer) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (preview) {
        hidePreview();
        if (isOpen && narrowMode) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }
      if (isOpen && narrowMode) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === 'Tab' && isOpen && narrowMode) trapTab(event);
  });

  // ---------------------------------------------------------------------
  // Responsive mode changes
  // ---------------------------------------------------------------------

  narrowQuery.addEventListener('change', () => {
    const nextNarrow = narrowQuery.matches;
    if (nextNarrow === narrowMode) return;
    narrowMode = nextNarrow;
    if (!isOpen) {
      applyModalAttributes(false);
      return;
    }
    if (narrowMode) {
      closeButton.focus({ preventScroll: true });
      applyModalAttributes(true);
      hidePreview();
    } else {
      applyModalAttributes(false);
      if (document.activeElement === closeButton) menuFocus();
    }
  });

  // ---------------------------------------------------------------------
  // Exclusive Blog year expansion
  // ---------------------------------------------------------------------

  const yearToggles = Array.from(drawer.querySelectorAll<HTMLAnchorElement>('[data-year-toggle]'));
  // D37: the server-rendered page type decides the year button's semantics —
  // never the URL/hash, so a disclosure click cannot look like a fragment
  // navigation and dirty the history.
  const yearActivation = resolveYearActivation(document.documentElement.dataset.navPage);

  function setYearExpanded(link: HTMLAnchorElement, expanded: boolean): void {
    link.setAttribute('aria-expanded', String(expanded));
    const listId = link.getAttribute('aria-controls');
    if (!listId) return;
    const list = document.getElementById(listId);
    if (list) list.hidden = !expanded;
  }

  function setExpandedYear(target: HTMLAnchorElement | null): void {
    for (const link of yearToggles) setYearExpanded(link, link === target);
    scheduleOverflowMeasure();
  }

  /**
   * D36: the year toggle is a three-state control, not only an expander.
   * Activating a collapsed year expands it (and collapses the others, so at
   * most one year list is open); activating the already expanded year collapses
   * it. The collapsed year itself stays current and the drawer scroll position
   * is untouched (no scroll write happens here; D21 keeps its own rules).
   */
  let collapsedYearHash = '';

  function toggleYear(link: HTMLAnchorElement): void {
    const expanded = link.getAttribute('aria-expanded') === 'true';
    const next = nextExpandedYear(link.dataset.year ?? '', expanded);
    setExpandedYear(next === null ? null : link);
    // D36/P1-2: record the collapsed year's fragment on *every* collapse — the
    // browser may deliver the fragment navigation's `hashchange` after the
    // click handler even when the URL already matched (same-hash click), and
    // only recording it when the hash "was" already equal missed exactly those
    // real events, so the list bounced back open. Any expansion clears the
    // guard; a genuine navigation to another fragment clears it too.
    const spyTarget = link.dataset.spyTarget ?? '';
    collapsedYearHash = next === null ? spyTarget : '';
  }

  /**
   * D36/P1-2: the keyboard Space path has no native link navigation, so on the
   * archive it must reproduce the mouse/Enter result: same URL fragment and the
   * same scroll to the year section. Enter already gets this from the browser's
   * synthetic click.
   */
  function navigateToYearFragment(link: HTMLAnchorElement): void {
    const target = link.dataset.spyTarget ?? '';
    if (target === '') return;
    if (currentHash() !== `#${target}`) {
      window.location.hash = target;
      return;
    }
    document.getElementById(target)?.scrollIntoView({ block: 'start' });
  }

  /**
   * D37: the year button has two page-dependent behaviours.
   *
   * - Blog index (`archive-navigation`): fragment navigation to `#year-YYYY`
   *   plus expansion, pinning the year current (the archive is on this page).
   * - Blog article (`local-disclosure`): a pure expand/collapse disclosure.
   *   The click is prevented so the browser never navigates to `/blog/`, the
   *   hash never changes, no scroll happens and no drawer scroll offset is
   *   recorded; the current item stays the article and only the level-3 list
   *   toggles (one open at most, zero allowed).
   */
  function activateYear(link: HTMLAnchorElement, event: Event, viaKeyboard = false): void {
    if (yearActivation === 'local-disclosure') {
      event.preventDefault();
      toggleYear(link);
      suppressScrollRecord();
      keepFocusInModal(link);
      return;
    }
    if (!isSameDocument(link.href, window.location.pathname)) return;
    toggleYear(link);
    pinSpyTarget(link.dataset.spyTarget);
    setCurrent(link);
    keepFocusInModal(link);
    // A click/Enter performs the fragment navigation natively; Space has to do
    // it explicitly so the URL and scroll position match.
    if (viaKeyboard) navigateToYearFragment(link);
  }

  for (const link of yearToggles) {
    link.addEventListener('click', (event) => activateYear(link, event));
    // Enter activates a link with a synthetic click; Space has no default link
    // behaviour, so give it the same three-state toggle for keyboard parity.
    link.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      activateYear(link, event, true);
    });
  }

  function expandYearFromHash(): void {
    const hash = currentHash();
    if (!hash || hash === collapsedYearHash) return;
    const link = yearToggles.find((candidate) => candidate.dataset.spyTarget === hash);
    if (link) setExpandedYear(link);
  }

  window.addEventListener('hashchange', () => {
    const hash = currentHash();
    // A different fragment is a genuine navigation: the collapse guard no longer
    // applies and the hash-deep-link expansion below may run.
    if (collapsedYearHash !== '' && hash !== collapsedYearHash) collapsedYearHash = '';
    expandYearFromHash();
    pinCurrentHash();
    hidePreview();
    const hashed = hashedSpyEntry();
    if (hashed) {
      setCurrent(hashed.link);
      keepFocusInModal(hashed.link);
    }
    reassertModalFocus();
    scheduleSpyUpdate();
  });

  // ---------------------------------------------------------------------
  // Preview card (task N10 / N13 fallback path)
  // ---------------------------------------------------------------------

  let previewScrollTimer = 0;

  function positionPreview(link: HTMLAnchorElement, popover: HTMLElement): void {
    const anchorRect = link.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    const maxInline = window.innerWidth - PREVIEW_MARGIN;

    let left = anchorRect.right + PREVIEW_GAP;
    if (left + width > maxInline) left = anchorRect.left - width - PREVIEW_GAP;
    left = Math.max(PREVIEW_MARGIN, Math.min(left, maxInline - width));

    const maxBlock = window.innerHeight - PREVIEW_MARGIN;
    let top = anchorRect.top;
    if (top + height > maxBlock) top = maxBlock - height;
    top = Math.max(PREVIEW_MARGIN, top);

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function hidePreview(): void {
    if (previewScrollTimer) {
      window.clearTimeout(previewScrollTimer);
      previewScrollTimer = 0;
    }
    if (!preview) return;
    delete preview.popover.dataset.open;
    preview = null;
  }

  function showPreview(link: HTMLAnchorElement): void {
    const targetId = link.dataset.previewTarget;
    if (!targetId) return;
    const popover = document.getElementById(targetId);
    if (!popover) return;
    if (preview && preview.popover !== popover) hidePreview();
    preview = { link, popover };
    popover.dataset.open = 'true';
    positionPreview(link, popover);
  }

  const postLinks = Array.from(drawer.querySelectorAll<HTMLAnchorElement>('.site-nav__post-link'));

  for (const link of postLinks) {
    link.addEventListener('pointerenter', () => {
      if (hoverQuery.matches) showPreview(link);
    });
    link.addEventListener('pointerleave', () => {
      if (preview?.link === link) hidePreview();
    });
    link.addEventListener('focusin', () => {
      showPreview(link);
    });
    link.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !link.contains(next)) hidePreview();
    });
  }

  function previewAnchorVisible(link: HTMLAnchorElement): boolean {
    const rect = link.getBoundingClientRect();
    const area = scrollArea.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.bottom <= area.top + 1 || rect.top >= area.bottom - 1) return false;
    return rect.bottom > 0 && rect.top < window.innerHeight;
  }

  /**
   * Scroll is not an unconditional reason to close the card: focusing a link
   * far down the list makes the browser scroll it into view, and a user wheel
   * scroll with focus still on the link should keep the preview anchored.
   * Re-evaluate after the scroll settles, then reposition or close.
   */
  function settlePreviewAfterScroll(): void {
    if (!preview) return;
    if (previewScrollTimer) window.clearTimeout(previewScrollTimer);
    previewScrollTimer = window.setTimeout(() => {
      previewScrollTimer = 0;
      if (!preview) return;
      const active = document.activeElement;
      const focused = active === preview.link || preview.link.contains(active);
      const hovered = preview.link.matches(':hover');
      if (!focused && !hovered) {
        hidePreview();
        return;
      }
      if (!previewAnchorVisible(preview.link)) {
        hidePreview();
        return;
      }
      positionPreview(preview.link, preview.popover);
    }, 160);
  }

  document.addEventListener('scroll', settlePreviewAfterScroll, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    if (preview) settlePreviewAfterScroll();
  });

  // ---------------------------------------------------------------------
  // Overflow detection for level-3 labels
  // ---------------------------------------------------------------------

  const measureOverflow = scheduleFrame(() => {
    if (drawer.getClientRects().length === 0) return;
    if (getComputedStyle(drawer).visibility !== 'visible') return;
    for (const link of postLinks) {
      if (link.matches(':hover, :focus-visible')) continue;
      const label = link.querySelector<HTMLElement>('[data-post-label]');
      if (!label) continue;
      const overflow = label.scrollWidth - label.clientWidth;
      if (overflow > 1) {
        link.dataset.overflow = 'true';
        link.dataset.overflowPx = String(overflow);
        link.style.setProperty('--marquee-distance', `${-overflow}px`);
        const duration = Math.min(15, Math.max(0.6, overflow / MARQUEE_PX_PER_SECOND));
        link.style.setProperty('--marquee-duration', `${duration.toFixed(2)}s`);
      } else {
        delete link.dataset.overflow;
        delete link.dataset.overflowPx;
        link.style.removeProperty('--marquee-distance');
        link.style.removeProperty('--marquee-duration');
      }
    }
  });

  function scheduleOverflowMeasure(): void {
    measureOverflow();
  }

  const resizeObserver = new ResizeObserver(() => scheduleOverflowMeasure());
  resizeObserver.observe(scrollArea);
  for (const link of postLinks) {
    const label = link.querySelector<HTMLElement>('[data-post-label]');
    if (label) resizeObserver.observe(label);
  }

  const mutationObserver = new MutationObserver(() => scheduleOverflowMeasure());
  mutationObserver.observe(drawer, { subtree: true, childList: true, characterData: true });

  document.fonts?.ready.then(() => scheduleOverflowMeasure()).catch(() => undefined);
  window.addEventListener('load', scheduleOverflowMeasure, { once: true });

  // ---------------------------------------------------------------------
  // Scrollspy
  // ---------------------------------------------------------------------

  interface SpyEntry {
    link: HTMLAnchorElement;
    target: HTMLElement;
  }

  const nav = drawer.querySelector<HTMLElement>('.site-nav');
  const spyLinks = nav
    ? Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[data-scrollspy-target]'))
    : [];
  const spyEntries: SpyEntry[] = [];
  for (const link of spyLinks) {
    const targetId = link.dataset.spyTarget;
    if (!targetId) continue;
    if (!isSameDocument(link.href, window.location.pathname)) continue;
    const target = document.getElementById(targetId);
    if (!target) continue;
    spyEntries.push({ link, target });
  }

  const navLinks = nav ? Array.from(nav.querySelectorAll<HTMLAnchorElement>('a[data-nav-link]')) : [];

  // No navigation-link click handler: the drawer is persistent navigation, so
  // activating any level-1/level-2/level-3 item (or New!) keeps it open on both
  // form factors. Only the explicit Menu/Close/Escape/backdrop paths change the
  // state (user 2026-11-25 contract; the earlier narrow auto-close is revoked).

  function hashedSpyEntry(): SpyEntry | null {
    const hash = currentHash();
    if (!hash) return null;
    return spyEntries.find((entry) => entry.target.id === hash) ?? null;
  }

  // A fragment that was just loaded or clicked is authoritative until the
  // user starts scrolling on their own. This keeps an explicitly selected
  // Blog year current even when the page is at its bottom edge (where the
  // "last section" fallback would otherwise win) without freezing the spy
  // when the user scrolls away.
  const HASH_PIN_MS = 8000;
  let pinnedHash = '';
  let pinnedUntil = 0;
  let pinExpiryTimer = 0;

  function clearHashPin(): void {
    pinnedHash = '';
    pinnedUntil = 0;
    if (pinExpiryTimer) {
      window.clearTimeout(pinExpiryTimer);
      pinExpiryTimer = 0;
    }
  }

  function pinSpyTarget(targetId: string | undefined): void {
    if (!targetId || !spyEntries.some((entry) => entry.target.id === targetId)) {
      clearHashPin();
      return;
    }
    pinnedHash = targetId;
    pinnedUntil = performance.now() + HASH_PIN_MS;
    if (pinExpiryTimer) window.clearTimeout(pinExpiryTimer);
    pinExpiryTimer = window.setTimeout(() => {
      pinExpiryTimer = 0;
      clearHashPin();
      scheduleSpyUpdate();
    }, HASH_PIN_MS);
  }

  function pinCurrentHash(): void {
    pinSpyTarget(currentHash() || undefined);
  }

  function pinnedSpyEntry(): SpyEntry | null {
    if (!pinnedHash) return null;
    if (performance.now() > pinnedUntil) {
      clearHashPin();
      return null;
    }
    return spyEntries.find((entry) => entry.target.id === pinnedHash) ?? null;
  }


  const linkKinds = new Map<HTMLAnchorElement, string>();
  for (const link of navLinks) {
    const value = link.getAttribute('aria-current');
    if (value) linkKinds.set(link, value);
  }
  const routeCurrent = navLinks.find((link) => linkKinds.has(link)) ?? null;

  function currentKind(link: HTMLAnchorElement): string {
    return linkKinds.get(link) ?? (link.hasAttribute('data-scrollspy-target') ? 'location' : 'page');
  }

  function clearCurrent(): void {
    if (!nav) return;
    for (const element of nav.querySelectorAll('[aria-current]')) element.removeAttribute('aria-current');
    for (const item of nav.querySelectorAll('.site-nav__item')) {
      item.classList.remove('is-current', 'is-current-ancestor');
    }
  }

  function setCurrent(link: HTMLAnchorElement | null): void {
    if (!nav) return;
    clearCurrent();
    if (!link) return;
    link.setAttribute('aria-current', currentKind(link));
    const item = link.closest('li[data-nav-item]');
    if (!item) return;
    item.classList.add('is-current');
    let ancestor = item.parentElement?.closest('li[data-nav-item]') ?? null;
    while (ancestor) {
      ancestor.classList.add('is-current-ancestor');
      ancestor = ancestor.parentElement?.closest('li[data-nav-item]') ?? null;
    }
  }

  function lastExpandedYearLink(): HTMLAnchorElement | null {
    let expanded: HTMLAnchorElement | null = null;
    for (const entry of spyEntries) {
      if (
        entry.link.hasAttribute('data-year-toggle') &&
        entry.link.getAttribute('aria-expanded') === 'true'
      ) {
        expanded = entry.link;
      }
    }
    return expanded;
  }

  /** Last year toggle in DOM order (the manifest renders years newest-first). */
  function lastYearLink(): HTMLAnchorElement | null {
    let last: HTMLAnchorElement | null = null;
    for (const entry of spyEntries) {
      if (entry.link.hasAttribute('data-year-toggle')) last = entry.link;
    }
    return last;
  }

  function hasYearEntries(): boolean {
    return spyEntries.some((entry) => entry.link.hasAttribute('data-year-toggle'));
  }

  function scrollActiveLink(): HTMLAnchorElement | null {
    if (window.scrollY <= 2) {
      // Home has no year branch, and its page can be shorter than the viewport
      // (or only scroll a few pixels). Make the first section current at the
      // top so the first fragment is reachable through scrollspy; Blog keeps
      // its route-level current, and Publications has no spy entries at all.
      if (!hasYearEntries()) return spyEntries[0]?.link ?? routeCurrent;
      return routeCurrent;
    }
    const trigger = scrollTriggerLine() + SPY_TOLERANCE;
    const atBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    if (atBottom) {
      // Prefer the year the reader explicitly opened (P0-2), but at the very
      // bottom of an archive whose years are all collapsed the last year is
      // the section actually in view, not the Blog route link.
      if (hasYearEntries()) return lastExpandedYearLink() ?? lastYearLink();
      return spyEntries[spyEntries.length - 1]?.link ?? routeCurrent;
    }

    let active: HTMLAnchorElement | null = null;
    for (const entry of spyEntries) {
      if (entry.target.getBoundingClientRect().top <= trigger) active = entry.link;
    }
    return active ?? routeCurrent;
  }

  const updateSpy = (): void => {
    if (spyEntries.length === 0) return;
    const pinned = pinnedSpyEntry();
    if (pinned) {
      setCurrent(pinned.link);
      return;
    }
    const documentElement = document.documentElement;
    const scrollable = documentElement.scrollHeight > window.innerHeight + 2;
    if (!scrollable) {
      // Short pages cannot move a target across the trigger line; keep the
      // fragment link current instead of falling back to the route link. Home
      // (no year branch) exposes its first section so it is still reachable.
      const hashed = hashedSpyEntry();
      if (hashed) {
        setCurrent(hashed.link);
      } else if (!hasYearEntries() && spyEntries[0]) {
        setCurrent(spyEntries[0].link);
      } else {
        setCurrent(routeCurrent);
      }
      return;
    }
    setCurrent(scrollActiveLink());
  };
  const scheduleSpyUpdate = scheduleFrame(updateSpy);

  /**
   * The hash pin is a short-lived guard for programmatic fragment positioning
   * (click/hash load), not a lock on user scrolling. Explicit scroll input
   * releases it immediately and recomputes current so a wheel at the page edge
   * (where no scroll event follows) still updates; the 8s timer remains only
   * as a fallback for inputs that emit none of these events.
   */
  function releaseHashPinOnUserScroll(): void {
    if (!pinnedHash) return;
    clearHashPin();
    scheduleSpyUpdate();
  }

  function isScrollAreaPointer(target: EventTarget | null): boolean {
    if (target === document.documentElement || target === document.body) return true;
    if (!(target instanceof HTMLElement)) return false;
    if (target.closest('[data-drawer-scroll]')) return true;
    if (target.scrollHeight <= target.clientHeight) return false;
    const overflow = getComputedStyle(target).overflowY;
    return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
  }

  window.addEventListener('wheel', releaseHashPinOnUserScroll, { passive: true, capture: true });
  window.addEventListener('touchstart', releaseHashPinOnUserScroll, { passive: true, capture: true });
  document.addEventListener(
    'keydown',
    (event) => {
      // Arrow/Page/Space/Home/End are the standard scroll keys; Space is
      // " " in modern browsers with "Spacebar" kept for older engines.
      if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'PageUp' ||
        event.key === 'PageDown' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === ' ' ||
        event.key === 'Spacebar'
      ) {
        releaseHashPinOnUserScroll();
      }
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (isScrollAreaPointer(event.target)) releaseHashPinOnUserScroll();
    },
    true,
  );

  if (spyEntries.length > 0) {
    for (const entry of spyEntries) {
      entry.link.addEventListener('click', () => {
        pinSpyTarget(entry.target.id);
        setCurrent(entry.link);
        keepFocusInModal(entry.link);
      });
    }
    window.addEventListener('scroll', scheduleSpyUpdate, { passive: true });
    window.addEventListener('resize', scheduleSpyUpdate);
    requestAnimationFrame(() => {
      pinCurrentHash();
      expandYearFromHash();
      const hashed = hashedSpyEntry();
      if (hashed) setCurrent(hashed.link);
      updateSpy();
    });
  } else {
    requestAnimationFrame(expandYearFromHash);
  }

  // Bfcache restores reuse the DOM frozen when the tab left the page, while an
  // explicit toggle on a later page may have changed sessionStorage. Re-adopt
  // the stored state without writing it so the same-tab contract also holds for
  // history navigation, and refresh the responsive mode in case the viewport
  // crossed the 48em breakpoint while the page was frozen. A cross-document
  // fragment navigation can move focus back to <body> after the controller
  // initialised, so an open narrow modal re-asserts focus (N02) here without
  // stealing it from a bfcache restore that already owns focus in the drawer.
  window.addEventListener('pageshow', (event) => {
    narrowMode = narrowQuery.matches;
    const stored = readStoredDrawerOpen();
    const next = event.persisted && stored !== null ? stored : isOpen;
    applyOpen(next, 'restore');
    // A bfcache page keeps the offset it was frozen with while another page may
    // have stored a newer one; refresh the in-memory baseline so leaving this
    // page flushes the position the user actually sees, not a stale comparison.
    if (event.persisted) savedScrollTop = readStoredDrawerScrollTop();
    requestAnimationFrame(reassertModalFocus);
  });

  // The fragment can also be resolved after `pageshow` (slow/deferred scroll
  // restoration), so run one extra one-shot re-assert once the load event and
  // the following frames have settled. Module scripts block `load`, so this
  // listener is always registered in time.
  window.addEventListener(
    'load',
    () => {
      requestAnimationFrame(() => requestAnimationFrame(reassertModalFocus));
    },
    { once: true },
  );

  // Adopt the state the inline boot applied from sessionStorage before first
  // paint. A restored open drawer must not be a half state: on narrow screens
  // it is a real modal (inert background, scroll lock, focus inside), while the
  // wide push drawer stays non-modal and never steals focus on load. The same
  // call also repairs a late module load that raced the boot fallback.
  applyOpen(isOpen, 'restore');

  // Restore the middle scroller once the drawer owns its final layout (the boot
  // script already did it before first paint; this also covers a skipped boot
  // script and a value the browser clamped before layout settled). A one-shot
  // retry after `load` covers late font metrics, and both calls stand down as
  // soon as the user scrolls.
  restoreScrollTop();
  window.addEventListener('load', () => requestAnimationFrame(restoreScrollTop), { once: true });

  // Tells the inline boot script that the controller owns the drawer, so its
  // timeout/error fallback stands down.
  document.dispatchEvent(new CustomEvent('site:navigation-ready'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNavigation, { once: true });
} else {
  initNavigation();
}

export {};
