/**
 * `@selfpage/site-shell` — the public site shell shared by both origins
 * (task 07.5, D29): the navigation model/data projection, `PUBLIC_SITE_ORIGIN`
 * validation, the drawer controller and the shell CSS.
 *
 * Import the pieces explicitly in app code (`…/nav-model`, `…/nav-data`,
 * `…/origin`, `…/drawer`, `…/shell.css`) so a consumer only pulls what it needs;
 * this index exists for tests and for type imports.
 */
export * from './nav-model.ts';
export * from './origin.ts';
export * from './nav-data.ts';
export * from './drawer.ts';
export * from './preferences.ts';
