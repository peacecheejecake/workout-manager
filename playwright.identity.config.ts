import { defineConfig, devices } from '@playwright/test';
import { identityApiPort } from './scripts/fixtures/identity-api-port';
export default defineConfig({
  testDir: './tests/identity',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm exec tsx scripts/identity-e2e.mts',
      url: `http://127.0.0.1:${identityApiPort}/health`,
      timeout: 60000,
      reuseExistingServer: false,
      // Let the fixture stop its private PostgreSQL cluster before the runner exits.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
    },
    {
      command: 'pnpm --filter @workout/web start',
      url: 'http://127.0.0.1:3100',
      reuseExistingServer: false,
    },
  ],
});
