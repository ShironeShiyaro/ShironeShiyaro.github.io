import { defineConfig, devices } from '@playwright/test';

/**
 * Independent 07.5 probe configuration. The servers are started by
 * `run.mjs`; these specs use absolute site/author URLs from the environment so
 * the two origins are never accidentally treated as one origin.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 10_000 },
  outputDir: '../../test-results/indep-075/playwright',
  reporter: [
    ['list'],
    ['json', { outputFile: process.env.INDEP_RESULTS ?? '../../test-results/indep-075/results.json' }],
  ],
  use: {
    baseURL: process.env.INDEP_SITE_URL ?? 'http://localhost:4324',
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
