import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'tests/author-e2e/**/*.test.ts',
    ],
    environment: 'node',
  },
});
