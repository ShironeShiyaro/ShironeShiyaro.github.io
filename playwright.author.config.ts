import { defineConfig, devices } from '@playwright/test';

/**
 * Author-only Playwright configuration.
 *
 * The Worker and the preview/production fixture are started by
 * `tests/run-author-e2e.mjs`; this config only points at the test Worker on
 * 43243. The site-wide `playwright.config.ts` and `tests/run-e2e.mjs` are not
 * modified by task 06.
 */
export default defineConfig({
  testDir: './tests/author-e2e',
  // Task 07 real-route specs live in tests/author-e2e/github and run through
  // playwright.github.config.ts; the 06 suite keeps its original scope.
  testIgnore: ['**/github/**'],
  fullyParallel: false,
  // The mock session, dedupe map and test clock live in one Worker process, so
  // the suite must not parallelise across tests.
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results/author-playwright',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/author-playwright-report' }]],
  use: {
    baseURL: process.env.AUTHOR_E2E_BASE_URL ?? 'http://127.0.0.1:43243',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'msedge',
      use: { ...devices['Desktop Chrome'], channel: 'msedge' },
    },
  ],
});
