import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['packages/tooling/tests/**/*.test.{ts,mjs}'],
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
          include: ['packages/tooling/fixtures/**/*.test.tsx'],
          setupFiles: ['packages/tooling/test-setup.ts'],
        },
      },
    ],
  },
});
