import { expect, test as base } from '@playwright/test';

/**
 * Console/CSP guard for the author UI suites (task 07.5 review P1-1).
 *
 * The Worker sends `Content-Security-Policy: script-src 'self'`. A hidden inline
 * script used to be refused there and went unnoticed because nothing collected
 * console errors. Every author spec now imports `test` from this module: the
 * auto fixture records console errors and uncaught page errors, and fails the
 * test when a CSP violation or a page error appeared.
 *
 * Only CSP/refusal messages and uncaught exceptions fail the test. Ordinary
 * "Failed to load resource: 404" console noise from intentional negative tests
 * is not a product defect and stays out of the assertion.
 */
const CSP_PATTERN = /content security policy|refused to (execute|load|apply)|violates the following|CSP/i;

export const test = base.extend<{ consoleGuard: void }>({
  consoleGuard: [
    async ({ page }, use) => {
      const violations: string[] = [];
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (CSP_PATTERN.test(text)) {
          violations.push(`console: ${text}`);
        }
      });
      page.on('pageerror', (error) => {
        violations.push(`pageerror: ${error.message}`);
      });
      await use();
      expect(violations, 'CSP violations / uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
