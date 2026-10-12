import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Real PostgreSQL + native codec runs use vitest.integration.config.ts explicitly.
    exclude: ['**/node_modules/**', 'tests/**/*.integration.test.ts'],
  },
});
