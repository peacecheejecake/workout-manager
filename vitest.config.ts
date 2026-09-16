import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/tooling/tests/**/*.test.{ts,mjs}',
            'packages/api-client/tests/**/*.test.ts',
            'apps/api/tests/**/*.test.ts',
            'packages/server/identity/tests/**/*.test.ts',
          ],
          exclude: ['**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'contracts',
          environment: 'node',
          include: ['packages/contracts/tests/**/*.test.ts'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'components',
          environment: 'jsdom',
          environmentOptions: { jsdom: { url: 'http://localhost/' } },
          include: [
            'packages/tooling/fixtures/**/*.test.tsx',
            'packages/platform/tests/**/*.test.tsx',
            'packages/modules/*/tests/**/*.test.tsx',
            'packages/ui/*/tests/**/*.test.tsx',
          ],
          setupFiles: ['packages/tooling/test-setup.ts'],
        },
      },
    ],
  },
});
