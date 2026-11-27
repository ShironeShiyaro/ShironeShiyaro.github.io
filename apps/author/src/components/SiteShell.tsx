import { useEffect, useState, type ReactNode } from 'react';
import { initDrawer, readStoredDrawerOpen } from '@selfpage/site-shell/drawer';
import { nextExpandedYear } from '@selfpage/site-shell/nav-model';
import type { ShellNav } from '@selfpage/site-shell/nav-data';

const SITE_TITLE = "Xinyang Zeng's Homepage";

interface SiteShellProps {
  nav: ShellNav;
  /** Author-only top-bar controls (Logout). The public site renders none. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Author-side instance of the shared public-site shell (task 07.5, D29).
 *
 * The markup intentionally mirrors `apps/site/src/components/layout/SiteShell.astro`
 * + `SiteNav.astro` + `TopBar.astro` class-for-class and attribute-for-attribute:
 * Astro components cannot be rendered by React without adding a framework
 * integration dependency, so the *rendering* is mirrored while everything that
 * could drift is shared — `@selfpage/site-shell/shell.css` (all geometry,
 * colour and states), `@selfpage/site-shell/nav-data` (labels/hrefs/levels from
 * the same content manifest) and the drawer controller/storage keys. A geometry
 * comparison between the two origins is part of X01/07.5 acceptance.
 *
 * The only deliberate differences from the public shell:
 * - a `[data-shell-actions]` slot on the right of the top bar for Logout;
 * - the New! link points at this app's `/new/` route;
 * - no preview cards (the author app has no scrollspy/preview controller; post
 *   labels still keep their full text and ellipsis);
 * - years are a local three-state toggle exactly like the public archive (D36):
 *   the first activation expands that year (closing the other one), a second
 *   activation collapses it, and level-3 links open the public article URL; a
 *   modified click still opens the public year archive in a new tab.
 */
export default function SiteShell({ nav, actions, children }: SiteShellProps) {
  // The first frame already reflects the tab-scoped drawer state, so an open
  // drawer never flashes closed (and vice versa) before the controller runs.
  const open = readStoredDrawerOpen();
  // R075-7 (D36 parity): at most one year list is open; a refresh starts
  // collapsed because the author origin has no archive fragment state.
  const [expandedYear, setExpandedYear] = useState<string | null>(null);
  const year = new Date().getFullYear();

  useEffect(() => initDrawer(), []);

  return (
    <>
      <a className="skip-link" href="#content">
        Skip to main content
      </a>

      <header className="top-bar" data-layout="top-bar" data-size="topbar">
        <div className="top-bar__chrome">
          <button
            type="button"
            className="menu-trigger"
            data-size="nav-item"
            data-drawer-toggle
            aria-controls="site-drawer"
            aria-expanded={open ? 'true' : 'false'}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
            <span className="visually-hidden">Menu</span>
          </button>
          <a className="site-brand" href={nav.home.href}>
            {SITE_TITLE}
          </a>
          {actions ? (
            <div className="shell-actions" data-shell-actions>
              {actions}
            </div>
          ) : null}
        </div>
      </header>

      <div className="site-topbar-spacer" data-size="topbar-spacer" />

      <div className="site-backdrop" data-drawer-backdrop aria-hidden="true" />

      <div
        className="site-drawer"
        id="site-drawer"
        data-layout="drawer"
        {...(open ? {} : { inert: true, 'aria-hidden': 'true' })}
      >
        <div className="site-drawer__first-row" data-size="drawer-first-row" aria-hidden="true" />
        <div className="site-drawer__close-row">
          <button type="button" className="site-drawer__close" data-drawer-close>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            <span>Close</span>
          </button>
        </div>
        <div
          className="site-drawer__scroll"
          data-drawer-scroll
          tabIndex={0}
          role="region"
          aria-label="Site navigation"
        >
          <nav className="site-nav" aria-label="Site" data-navigation>
            <ul className="site-nav__list" role="list">
              <li
                className="site-nav__item site-nav__group"
                data-nav-item
                data-nav-group="home"
              >
                <a
                  className="site-nav__link site-nav__link--level-1"
                  data-nav-link
                  data-size="nav-item"
                  data-nav-key="home"
                  href={nav.home.href}
                >
                  <span className="site-nav__label">{nav.home.label}</span>
                </a>
                {/* D20 exclusive branch rule, mirroring SiteNav.astro: Home
                    sections render only while Home is the current public-site
                    page. The author app is never a public-site page, so this
                    branch is always closed here; the sections remain reachable
                    through the Home link. Rendering them unconditionally used
                    to make Home look expanded on /new/. */}
              </li>

              <li
                className="site-nav__item site-nav__group"
                data-nav-item
                data-nav-group="publications"
              >
                <a
                  className="site-nav__link site-nav__link--level-1"
                  data-nav-link
                  data-size="nav-item"
                  data-nav-key="publications"
                  href={nav.publications.href}
                >
                  <span className="site-nav__label">{nav.publications.label}</span>
                </a>
              </li>

              <li
                className="site-nav__item site-nav__group is-current-ancestor"
                data-nav-item
                data-nav-group="blog"
              >
                <a
                  className="site-nav__link site-nav__link--level-1"
                  data-nav-link
                  data-size="nav-item"
                  data-nav-key="blog"
                  data-current-kind="branch"
                  aria-current="true"
                  href={nav.blog.href}
                >
                  <span className="site-nav__label">{nav.blog.label}</span>
                </a>
                <ul className="site-nav__sublist" role="list" aria-label="Blog">
                  <li className="site-nav__item site-nav__item--level-2 is-current" data-nav-item>
                    <a
                      className="site-nav__link site-nav__link--level-2"
                      data-nav-link
                      data-size="nav-item"
                      data-current-kind="page"
                      aria-current="page"
                      href={nav.blog.newHref}
                    >
                      <span className="site-nav__label">New!</span>
                      <span className="visually-hidden"> (author tools)</span>
                    </a>
                  </li>
                  {nav.blog.years.map((yearEntry) => {
                    const isExpanded = expandedYear === yearEntry.year;
                    const toggle = () => {
                      setExpandedYear((current) => nextExpandedYear(yearEntry.year, current === yearEntry.year));
                    };
                    return (
                    <li
                      className="site-nav__item site-nav__item--level-2 site-nav__item--year"
                      data-nav-item
                      data-nav-year={yearEntry.year}
                      key={yearEntry.year}
                    >
                      <a
                        className="site-nav__link site-nav__link--level-2 site-nav__year-toggle"
                        data-nav-link
                        data-size="nav-item"
                        data-year-toggle
                        data-year={yearEntry.year}
                        data-spy-target={`year-${yearEntry.year}`}
                        aria-expanded={isExpanded ? 'true' : 'false'}
                        aria-controls={yearEntry.listId}
                        href={yearEntry.href}
                        onClick={(event) => {
                          // A modified click still opens the public archive in a
                          // new tab; a plain activation toggles locally (D36).
                          if (
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          ) {
                            return;
                          }
                          event.preventDefault();
                          toggle();
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== ' ' && event.key !== 'Spacebar') return;
                          event.preventDefault();
                          toggle();
                        }}
                      >
                        <span className="site-nav__label">{yearEntry.label}</span>
                      </a>
                      <ul
                        id={yearEntry.listId}
                        className="site-nav__sublist site-nav__sublist--posts"
                        role="list"
                        aria-label={`${yearEntry.year} posts`}
                        hidden={!isExpanded}
                      >
                        {yearEntry.posts.map((post) => (
                          <li
                            className="site-nav__item site-nav__item--level-3"
                            data-nav-item
                            key={post.href}
                          >
                            <a
                              className="site-nav__link site-nav__link--level-3 site-nav__post-link"
                              data-nav-link
                              data-size="nav-item"
                              href={post.href}
                            >
                              <span className="site-nav__post-label" data-post-label>
                                <span className="site-nav__post-text">{post.label}</span>
                              </span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </li>
                    );
                  })}
                </ul>
              </li>
            </ul>
          </nav>
        </div>
        <nav className="site-drawer__footer" data-size="drawer-footer" aria-label="Settings">
          {/* Task 08 (R08-3): Settings is the public site's page on the public
              origin, not a second settings surface on the author origin. The
              fixed row is a named navigation landmark so its content is not
              outside every landmark when the drawer is open (axe `region`). */}
          <a
            className="site-nav__settings"
            data-size="nav-item"
            data-settings-slot
            data-settings-link
            href={nav.settings.href}
          >
            <span className="site-nav__label">{nav.settings.label}</span>
          </a>
        </nav>
      </div>

      <main id="content" className="site-main" data-layout="article-container" tabIndex={-1}>
        {children}
      </main>

      <footer className="site-footer">
        <p>© {year} Xinyang Zeng</p>
      </footer>
    </>
  );
}
