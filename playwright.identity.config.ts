import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { identityApiPort } from './scripts/fixtures/identity-api-port';
import { captureWorkerProtocol } from './tests/identity/diagnostics/protocol-capture';

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
/**
 * The self-hosted place and elevation datasets, when they have been built on this machine.
 *
 * `scripts/build-geo-datasets.mjs` is opt-in and its output is not committed either, so a
 * checkout without it runs the same tests against "no dataset" — which is a state both
 * screens support and say out loud.
 */
const geoDataDirectory = join(import.meta.dirname, '.geo-build/geo-data');
const geoDataEnv = existsSync(join(geoDataDirectory, 'places.json'))
  ? { GEO_DATA_DIR: geoDataDirectory }
  : {};

/**
 * One id per run, inherited by the harness (webServer) and the spec workers: the files they
 * hand each other are named after it, so another harness on this machine cannot remove them.
 */
process.env.IDENTITY_E2E_RUN_ID ??= randomUUID();

/**
 * Opt-in failure evidence for stalls nobody could reproduce (M2-01ad): with
 * `IDENTITY_E2E_DIAGNOSTICS=1`, each worker logs Playwright's API/CDP/browser debug streams
 * and its event-loop delay, and a reporter samples machine pressure and, for each failed
 * test, writes that test's share next to its trace. Off by default: normal runs load neither.
 * See README "Identity E2E diagnostics".
 */
const diagnostics = process.env.IDENTITY_E2E_DIAGNOSTICS === '1';
if (diagnostics) {
  process.env.IDENTITY_E2E_DIAGNOSTICS_DIR ??= join(
    import.meta.dirname,
    'playwright-report/identity-diagnostics',
    process.env.IDENTITY_E2E_RUN_ID,
  );
  // The config is loaded again in every worker; only there does the browser connection live.
  if (process.env.TEST_WORKER_INDEX !== undefined)
    captureWorkerProtocol(process.env.IDENTITY_E2E_DIAGNOSTICS_DIR);
}

export default defineConfig({
  testDir: './tests/identity',
  workers: 1,
  ...(diagnostics
    ? {
        reporter: [[process.env.CI ? 'dot' : 'list'], ['./tests/identity/diagnostics/reporter.ts']],
      }
    : {}),
  forbidOnly: Boolean(process.env.CI),
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3100',
    // A trace keeps the session cookie, CSRF token, session id and OIDC code/state/nonce
    // unredacted, and CI failure artifacts of this public repository are downloadable by
    // anyone signed in. CI records no trace; its failures upload the redacted diagnostics and
    // screenshots instead (.github/workflows/ci.yml, M2-01ae). Local runs keep the trace.
    trace: process.env.CI ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // Replace Playwright's shell so SIGTERM reaches the fixture's PostgreSQL cleanup handler.
      command: 'exec node --import tsx scripts/identity-e2e.mts',
      url: `http://127.0.0.1:${identityApiPort}/health`,
      timeout: 60000,
      reuseExistingServer: false,
      env: geoDataEnv,
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
