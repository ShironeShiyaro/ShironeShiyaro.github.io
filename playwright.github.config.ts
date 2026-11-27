import { defineConfig, devices } from '@playwright/test';

/**
 * Task 07 real-route UI suite.
 *
 * `tests/run-author-github-e2e.mjs` builds the client, starts the mock GitHub
 * server (43261), the real-route test Worker (43262, APP_ENV=test with the
 * mock GitHub base) and a production-mode Worker (43263). This config only
 * points at the test Worker. The task 06 suite keeps using
 * `playwright.author.config.ts`.
 */
export default defineConfig({
  testDir: './tests/author-e2e/github',
  testMatch: '**/ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: './test-results/author-github-playwright',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/author-github-report' }]],
  use: {
    baseURL: process.env.AUTHOR_GITHUB_BASE_URL ?? 'http://localhost:43262',
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
