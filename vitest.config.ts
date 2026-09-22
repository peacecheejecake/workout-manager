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
            'packages/server/coaching/tests/**/*.test.ts',
            'packages/server/media/tests/**/*.test.ts',
            // These two packages ship their own vitest config, so their tests
            // never reached the default suite or CI. Retrieval chunking and the
            // derived-store cleanup worker are covered here instead.
            'packages/server/resource-ingestion/tests/**/*.test.ts',
            'packages/track-parsing/tests/**/*.test.ts',
            'packages/server/integrations/tests/**/*.test.ts',
            'packages/server/track-storage/tests/**/*.test.ts',
            'apps/worker/tests/**/*.test.ts',
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
            'packages/experience/*/tests/**/*.test.tsx',
            'packages/ui/*/tests/**/*.test.tsx',
          ],
          setupFiles: ['packages/tooling/test-setup.ts'],
        },
      },
    ],
  },
});
