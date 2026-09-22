import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { identityApiPort } from './scripts/fixtures/identity-api-port';

/**
 * The self-hosted basemap deployment, when one has been built on this machine.
 *
 * `scripts/build-basemap.mjs` is opt-in and its output is not committed, so a checkout
 * without it runs the same tests with no background map — which is a state the route
 * screen supports. The stored-track spec asserts the background map only when this is set.
 */
const basemapDirectory = join(import.meta.dirname, '.geo-build/dist');
const basemapEnv = existsSync(join(basemapDirectory, 'current.json'))
  ? { BASEMAP_DIST_DIR: basemapDirectory }
  : {};
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
      // Replace Playwright's shell so SIGTERM reaches the fixture's PostgreSQL cleanup handler.
      command: 'exec node --import tsx scripts/identity-e2e.mts',
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
      env: basemapEnv,
    },
    {
      command: 'API_ORIGIN=http://127.0.0.1:4300 pnpm --filter @workout/mobile-web preview',
      url: 'http://127.0.0.1:4200',
      reuseExistingServer: false,
      // This shell has no server of its own; during preview the background assets come
      // from the origin that already serves them.
      env: Object.keys(basemapEnv).length > 0 ? { BASEMAP_ORIGIN: 'http://127.0.0.1:3100' } : {},
    },
  ],
});
