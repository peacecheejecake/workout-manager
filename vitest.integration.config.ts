import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/server/persistence/tests/**/*.integration.test.ts',
      'apps/api/tests/**/*.integration.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
