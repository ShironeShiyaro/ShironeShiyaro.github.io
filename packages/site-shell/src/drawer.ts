/**
 * Framework-agnostic drawer controller for the shared site shell (task 07.5,
 * D29).
 *
 * The public site keeps its own richer controller (`apps/site/src/components/
 * navigation/navigation.ts`: scrollspy, preview cards, three-state year
 * toggles), which task 03 verified. This module is the single base
 * implementation of the drawer contract for shell consumers that only need the
 * drawer itself; the author app uses it. Both sides share the same DOM contract,
 * CSS and storage keys, so the geometry, the open/closed state and the narrow
 * overlay cannot drift:
 *
 * - `html[data-drawer-open="true|false"]` is the single layout state flag;
 * - `[data-drawer-toggle]` (with aria-expanded/aria-controls), `#site-drawer`,
 *   `[data-drawer-close]`, `[data-drawer-backdrop]`, `[data-drawer-scroll]`;
 * - `sessionStorage['selfpage:drawer-open']` (per tab; absent = closed);
 * - `sessionStorage['selfpage:drawer-scroll']` (middle scroller position; only
 *   user gestures record it, so a browser clamp after a resize never writes);
 * - narrow screens (<=48em) get a modal drawer: role=dialog, aria-modal, the
 *   rest of the page inert, scroll lock, focus in the drawer, a Tab trap and
 *   Escape/Close/backdrop as explicit close paths.
 *
 * The open state is only written by explicit Menu/Close/Escape/backdrop actions;
 * navigation (including SPA route changes) never closes the drawer.
 */

const DRAWER_STORAGE_KEY = 'selfpage:drawer-open';
const DRAWER_SCROLL_STORAGE_KEY = 'selfpage:drawer-scroll';
const NARROW_QUERY = '(max-width: 48em)';
const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
const USER_SCROLL_WINDOW_MS = 1500;

/** Stored drawer state for this tab (absent or unreadable means closed). */
export function readStoredDrawerOpen(): boolean {
  try {
    return window.sessionStorage.getItem(DRAWER_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Ask an initialized shell drawer to close (review P2-8). The author's leave
 * confirmation uses it on narrow screens so the dialog is not stacked on top of
 * the modal drawer. The controller below owns the state, storage and focus; this
 * is only a request, and it is a no-op when no drawer is mounted or it is closed.
 */
export function requestDrawerClose(): void {
  document.dispatchEvent(new CustomEvent('selfpage:drawer-close-request'));
}

function writeStoredDrawerOpen(open: boolean): void {
  try {
    window.sessionStorage.setItem(DRAWER_STORAGE_KEY, String(open));
  } catch {
    // Persistence is progressive enhancement; the page stays correct.
  }
}

function readStoredDrawerScrollTop(): number {
  try {
    const value = Number.parseFloat(window.sessionStorage.getItem(DRAWER_SCROLL_STORAGE_KEY) ?? '');
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeStoredDrawerScrollTop(top: number): boolean {
  try {
    window.sessionStorage.setItem(DRAWER_SCROLL_STORAGE_KEY, String(Math.max(0, Math.round(top))));
    return true;
  } catch {
    return false;
  }
}

type FocusPolicy = 'interactive' | 'restore';

/**
 * Wires the drawer. Returns a disposer so a framework that mounts effects twice
 * (for example React StrictMode in development) can clean up and re-initialise.
 */
export function initDrawer(): () => void {
  const root = document.documentElement;
  if (root.dataset.navInitialized === 'true') {
    return () => {};
  }

  // The typed aliases keep closure bodies non-nullable without weakening the
  // graceful "no shell markup, do nothing" early returns.
  const drawerNode = document.getElementById('site-drawer');
  const menuNode = document.querySelector<HTMLButtonElement>('[data-drawer-toggle]');
  if (!drawerNode || !menuNode) {
    return () => {};
  }
  const drawer: HTMLElement = drawerNode;
  const menu: HTMLButtonElement = menuNode;
  const closeButtonNode = drawer.querySelector<HTMLButtonElement>('[data-drawer-close]');
  const scrollAreaNode = drawer.querySelector<HTMLElement>('[data-drawer-scroll]');
  const backdropNode = document.querySelector<HTMLElement>('[data-drawer-backdrop]');
  if (!closeButtonNode || !scrollAreaNode || !backdropNode) {
    return () => {};
  }
  const closeButton: HTMLButtonElement = closeButtonNode;
  const scrollArea: HTMLElement = scrollAreaNode;
  const backdrop: HTMLElement = backdropNode;

  root.dataset.navInitialized = 'true';
  root.dataset.navReady = '';
  menu.disabled = false;

  const narrowQuery = window.matchMedia(NARROW_QUERY);
  let narrowMode = narrowQuery.matches;
  let isOpen = readStoredDrawerOpen();

  const main = document.querySelector<HTMLElement>('main');
  const footer = document.querySelector<HTMLElement>('.site-footer');
  const brand = document.querySelector<HTMLElement>('.site-brand');
  const skipLink = document.querySelector<HTMLElement>('.skip-link');
  const shellActions = document.querySelector<HTMLElement>('[data-shell-actions]');
  const outsideElements = [main, footer, brand, skipLink, shellActions].filter(
    (element): element is HTMLElement => element !== null,
  );

  let backgroundScrollLocked = false;

  function lockBackgroundScroll(): void {
    if (backgroundScrollLocked) return;
    backgroundScrollLocked = true;
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

  function applyOpen(next: boolean, focusPolicy: FocusPolicy): void {
    const changed = next !== isOpen;
    isOpen = next;
    root.setAttribute('data-drawer-open', String(next));
    menu.setAttribute('aria-expanded', String(next));

    if (next) {
      drawer.removeAttribute('inert');
      drawer.removeAttribute('aria-hidden');
      applyModalAttributes(narrowMode);
      if (narrowMode) {
        const active = document.activeElement;
        const inside = active instanceof Node && drawer.contains(active);
        if ((focusPolicy === 'interactive' && changed) || !inside) {
          closeButton.focus({ preventScroll: true });
        }
      }
      return;
    }

    const active = document.activeElement;
    const inside = active instanceof Node && drawer.contains(active);
    if ((focusPolicy === 'interactive' && changed) || inside) menuFocus();
    applyModalAttributes(false);
    drawer.setAttribute('inert', '');
    drawer.setAttribute('aria-hidden', 'true');
  }

  function setOpen(next: boolean): void {
    writeStoredDrawerOpen(next);
    applyOpen(next, 'interactive');
  }

  // --- persistent middle-scroller position ------------------------------
  let savedScrollTop = readStoredDrawerScrollTop();
  let userScrollTop: number | null = null;
  let lastInputAt = 0;
  let pointerHeld = false;
  let userTookOver = false;
  let scrollSaveFrame = 0;

  function markUserInput(): void {
    userTookOver = true;
    lastInputAt = performance.now();
  }

  function userDrivingScroll(): boolean {
    if (pointerHeld) return true;
    if (lastInputAt <= 0) return false;
    return performance.now() - lastInputAt <= USER_SCROLL_WINDOW_MS;
  }

  function flushUserScrollTop(): void {
    scrollSaveFrame = 0;
    if (userScrollTop === null) return;
    const top = Math.round(userScrollTop);
    if (top === savedScrollTop) return;
    if (writeStoredDrawerScrollTop(top)) savedScrollTop = top;
  }

  function cancelScheduledSave(): void {
    if (!scrollSaveFrame) return;
    cancelAnimationFrame(scrollSaveFrame);
    scrollSaveFrame = 0;
  }

  function restoreScrollTop(): void {
    if (userTookOver) return;
    const stored = readStoredDrawerScrollTop();
    if (stored <= 0) return;
    if (Math.abs(scrollArea.scrollTop - stored) < 1) return;
    scrollArea.scrollTop = stored;
  }

  function flushNow(): void {
    cancelScheduledSave();
    pointerHeld = false;
    flushUserScrollTop();
  }

  function onScroll(): void {
    if (!userDrivingScroll()) return;
    userScrollTop = scrollArea.scrollTop;
    if (scrollSaveFrame) return;
    scrollSaveFrame = requestAnimationFrame(flushUserScrollTop);
  }

  function onWheel(): void {
    markUserInput();
  }

  function onTouchStart(): void {
    markUserInput();
  }

  function onTouchMove(): void {
    markUserInput();
  }

  function onMouseDown(): void {
    markUserInput();
  }

  function onFocusIn(): void {
    markUserInput();
  }

  function onPointerDown(): void {
    pointerHeld = true;
    markUserInput();
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.buttons === 0) pointerHeld = false;
  }

  function onReleasePointer(): void {
    pointerHeld = false;
  }

  function onScrollKeyDown(event: KeyboardEvent): void {
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
  }

  function onResize(): void {
    cancelScheduledSave();
    pointerHeld = false;
    lastInputAt = 0;
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') flushNow();
  }

  // --- focus trap --------------------------------------------------------
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

  function onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (isOpen && narrowMode) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === 'Tab' && isOpen && narrowMode) trapTab(event);
  }

  function onMenuClick(): void {
    setOpen(!isOpen);
  }

  function onCloseClick(): void {
    setOpen(false);
  }

  function onBackdropClick(): void {
    if (narrowMode) setOpen(false);
  }

  function onCloseRequest(): void {
    if (isOpen) setOpen(false);
  }

  function onNarrowChange(): void {
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
    } else {
      applyModalAttributes(false);
      if (document.activeElement === closeButton) menuFocus();
    }
  }

  function onPageShow(event: PageTransitionEvent): void {
    narrowMode = narrowQuery.matches;
    // A bfcache restore re-uses the frozen DOM while another page may have
    // changed the tab-scoped state; adopt storage without writing it back.
    const stored = readStoredDrawerOpen();
    const next = event.persisted ? stored : isOpen;
    applyOpen(next, 'restore');
    if (event.persisted) savedScrollTop = readStoredDrawerScrollTop();
    requestAnimationFrame(restoreScrollTop);
  }

  function onLoad(): void {
    requestAnimationFrame(restoreScrollTop);
  }

  menu.addEventListener('click', onMenuClick);
  closeButton.addEventListener('click', onCloseClick);
  backdrop.addEventListener('click', onBackdropClick);
  narrowQuery.addEventListener('change', onNarrowChange);
  document.addEventListener('keydown', onDocumentKeyDown);
  document.addEventListener('selfpage:drawer-close-request', onCloseRequest);
  scrollArea.addEventListener('scroll', onScroll, { passive: true });
  scrollArea.addEventListener('wheel', onWheel, { passive: true });
  scrollArea.addEventListener('touchstart', onTouchStart, { passive: true });
  scrollArea.addEventListener('touchmove', onTouchMove, { passive: true });
  scrollArea.addEventListener('mousedown', onMouseDown);
  scrollArea.addEventListener('focusin', onFocusIn);
  scrollArea.addEventListener('pointerdown', onPointerDown);
  scrollArea.addEventListener('pointermove', onPointerMove, { passive: true });
  scrollArea.addEventListener('keydown', onScrollKeyDown);
  window.addEventListener('pointerup', onReleasePointer, true);
  window.addEventListener('pointercancel', onReleasePointer, true);
  window.addEventListener('mouseup', onReleasePointer, true);
  window.addEventListener('blur', onReleasePointer);
  window.addEventListener('resize', onResize);
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('load', onLoad, { once: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Adopt the stored state before the user interacts; the author shell also
  // renders its first frame from the same key, so aria-expanded and
  // html[data-drawer-open] never disagree.
  applyOpen(isOpen, 'restore');
  restoreScrollTop();

  return () => {
    root.removeAttribute('data-nav-initialized');
    menu.removeEventListener('click', onMenuClick);
    closeButton.removeEventListener('click', onCloseClick);
    backdrop.removeEventListener('click', onBackdropClick);
    narrowQuery.removeEventListener('change', onNarrowChange);
    document.removeEventListener('keydown', onDocumentKeyDown);
    document.removeEventListener('selfpage:drawer-close-request', onCloseRequest);
    scrollArea.removeEventListener('scroll', onScroll);
    scrollArea.removeEventListener('wheel', onWheel);
    scrollArea.removeEventListener('touchstart', onTouchStart);
    scrollArea.removeEventListener('touchmove', onTouchMove);
    scrollArea.removeEventListener('mousedown', onMouseDown);
    scrollArea.removeEventListener('focusin', onFocusIn);
    scrollArea.removeEventListener('pointerdown', onPointerDown);
    scrollArea.removeEventListener('pointermove', onPointerMove);
    scrollArea.removeEventListener('keydown', onScrollKeyDown);
    window.removeEventListener('pointerup', onReleasePointer, true);
    window.removeEventListener('pointercancel', onReleasePointer, true);
    window.removeEventListener('mouseup', onReleasePointer, true);
    window.removeEventListener('blur', onReleasePointer);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pagehide', flushNow);
    window.removeEventListener('pageshow', onPageShow);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    cancelScheduledSave();
  };
}
