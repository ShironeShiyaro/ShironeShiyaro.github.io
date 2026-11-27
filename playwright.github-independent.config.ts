import { defineConfig, devices } from '@playwright/test';

/**
 * Task 07 independent real-route UI probes.
 *
 * `tests/run-author-github-independent.mjs` builds the client and starts the
 * mock GitHub server (43261), the real-route test Worker (43262) and a
 * production-mode Worker (43263). This config is deliberately separate from
 * `playwright.github.config.ts` so the executor's UI suite is not modified.
 */
export default defineConfig({
  testDir: './tests/author-e2e/github',
  testMatch: '**/independent-ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 150_000,
  expect: { timeout: 20_000 },
  outputDir: './test-results/author-github-independent',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/author-github-independent-report' }]],
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
