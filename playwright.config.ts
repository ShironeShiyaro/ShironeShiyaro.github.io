import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  // Playwright clears outputDir at the start of a run. Keep preview logs/PIDs
  // outside it (test-results/e2e-preview) so they survive for post-run checks.
  outputDir: './test-results/playwright',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:43211',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The preview server is started and stopped by `tests/run-e2e.mjs`, which is
  // what `npm run test:e2e` invokes. Playwright's own webServer teardown hangs
  // on Windows when the child preview process inherits the stdout pipe.
  projects: [
    {
      name: 'msedge',
      use: { ...devices['Desktop Chrome'], channel: 'msedge' },
    },
  ],
});
