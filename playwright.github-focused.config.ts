import { defineConfig, devices } from '@playwright/test';

/**
 * Focused independent retest configuration for the task 07 fix round.
 *
 * The focused runner starts mock GitHub (43261), the test Worker (43262) and
 * the production-mode Worker (43263); this config points only at 43262.
 */
export default defineConfig({
  testDir: './tests/author-e2e/github',
  testMatch: '**/focused-ui.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  outputDir: './test-results/author-github-focused',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'test-results/author-github-focused-report' }]],
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
