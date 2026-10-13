import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import {
  identityApiOrigin,
  identityApiPort,
  identityMobileOrigin,
  identityWebOrigin,
  identityWebPort,
} from './scripts/fixtures/identity-ports';
import { identityShellRuntimeProfileEnv } from './scripts/fixtures/identity-shell-runtime-profile';
import { captureWorkerProtocol } from './tests/identity/diagnostics/protocol-capture';

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));
const identitySuite = process.env['IDENTITY_E2E_SUITE'];
if (
  identitySuite !== undefined &&
  !['general', 'app-consent', 'ai-settings-lifecycle', 'current-manual'].includes(identitySuite)
) {
  throw new Error('Unknown isolated identity suite');
}

// Profile-dependent tests move intact to one current core fixture. This is suite
// assignment, not skip/waiver; every discovered spec belongs to exactly one fixture.
const currentManualSpecs = Object.freeze([
  'check-in-template-routine.spec.ts',
  'competition-result-proofs.spec.ts',
  'current-runtime-personal-export-v38.spec.ts',
  'nutrition-new-plan-review.spec.ts',
  'nutrition-race-reconnect.spec.ts',
  'race-date-change-all-domains.spec.ts',
  'race-date-change-linked-nutrition.spec.ts',
  'race-date-change-review.spec.ts',
  'race-date-change-unresolved.spec.ts',
  'race-pb-chip-preferred.spec.ts',
]);
const isolatedSpecs = ['app-consent.spec.ts', 'ai-settings-lifecycle.spec.ts'];
function discoverIdentitySpecs(relative = ''): string[] {
  return readdirSync(join(repositoryDirectory, 'tests/identity', relative), {
    withFileTypes: true,
  })
    .flatMap((entry) => {
      if (entry.isSymbolicLink() || (entry.isDirectory() && entry.name === 'node_modules'))
        return [];
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      return entry.isDirectory()
        ? discoverIdentitySpecs(path)
        : entry.isFile() &&
            /\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(entry.name) &&
            /\.[cm]?[jt]sx?$/.test(entry.name)
          ? [path]
          : [];
    })
    .sort();
}
const fullIdentitySpecs = discoverIdentitySpecs();
const movedSpecs = [...isolatedSpecs, ...currentManualSpecs];
const generalSpecs = fullIdentitySpecs.filter((path) => !movedSpecs.includes(path));
const assignedSpecs = [...generalSpecs, ...movedSpecs];
if (
  new Set(assignedSpecs).size !== assignedSpecs.length ||
  JSON.stringify([...assignedSpecs].sort()) !== JSON.stringify(fullIdentitySpecs)
)
  throw new Error('Identity fixture roster is missing or duplicates a spec');
function exactIdentitySpec(relative: string) {
  const escaped = relative
    .split('/')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[/\\\\]');
  return new RegExp(`[/\\\\]tests[/\\\\]identity[/\\\\]${escaped}$`);
}

/**
 * The self-hosted basemap deployment, when one has been built on this machine.
 *
 * `scripts/build-basemap.mjs` is opt-in and its output is not committed, so a checkout
 * without it runs the same tests with no background map — which is a state the route
 * screen supports. The stored-track spec asserts the background map only when this is set.
 */
const basemapDirectory =
  // M0-06b-odbl: a scratch deployment (BASEMAP_WORK_ROOT build) can be served instead of the
  // shared one, to see the licence page against a deployment that carries its disclosure.
  process.env['IDENTITY_E2E_BASEMAP_DIST_DIR'] ?? join(repositoryDirectory, '.geo-build/dist');
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
const geoDataDirectory =
  process.env['IDENTITY_E2E_GEO_DATA_DIR'] ?? join(repositoryDirectory, '.geo-build/geo-data');
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
/**
 * The shells mirror the fixture API's runtime profile (scripts/test-identity.mjs selects it per
 * suite): profile27 enables the gallery UI in both shells; otherwise both variables are unset.
 */
const shellProfile = identityShellRuntimeProfileEnv(process.env['IDENTITY_E2E_RACE_MANUAL_PUBLIC']);
/**
 * Opt-in shell log capture (M2-01k-o T11): with `IDENTITY_E2E_SHELL_LOGS=pipe`, the two
 * shells' own stdout and stderr are printed into the run's output (prefixed `[WebServer]`),
 * so a run can be audited for what the shells wrote while a link was read through them —
 * `scripts/audit-shell-log.mts`. Off by default: normal runs keep the shells' stdout quiet.
 */
const shellLogs =
  process.env.IDENTITY_E2E_SHELL_LOGS === 'pipe'
    ? ({ stdout: 'pipe', stderr: 'pipe' } as const)
    : {};
if (diagnostics) {
  process.env.IDENTITY_E2E_DIAGNOSTICS_DIR ??= join(
    repositoryDirectory,
    'playwright-report/identity-diagnostics',
    process.env.IDENTITY_E2E_RUN_ID,
  );
  // The config is loaded again in every worker; only there does the browser connection live.
  if (process.env.TEST_WORKER_INDEX !== undefined)
    captureWorkerProtocol(process.env.IDENTITY_E2E_DIAGNOSTICS_DIR);
}

export default defineConfig({
  testDir: './tests/identity',
  ...(identitySuite === 'general'
    ? { testMatch: generalSpecs.map(exactIdentitySpec) }
    : identitySuite === 'current-manual'
      ? { testMatch: currentManualSpecs.map(exactIdentitySpec) }
      : identitySuite
        ? { testMatch: exactIdentitySpec(`${identitySuite}.spec.ts`) }
        : {}),
  workers: 1,
  ...(diagnostics
    ? {
        reporter: [[process.env.CI ? 'dot' : 'list'], ['./tests/identity/diagnostics/reporter.ts']],
      }
    : {}),
  forbidOnly: Boolean(process.env.CI),
  use: {
    ...devices['Desktop Chrome'],
    baseURL: identityWebOrigin,
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
      // Let the fixture stop its private PostgreSQL cluster before the runner exits. A kill
      // after DROP DATABASE but before DROP ROLE leaves the fixed roles behind in a disposable
      // PG and the next suite refuses to start; each cleanup query is already bounded.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 60000 },
    },
    {
      command: `pnpm --filter @workout/web exec next start --hostname 127.0.0.1 --port ${identityWebPort}`,
      url: identityWebOrigin,
      reuseExistingServer: false,
      env: { ...basemapEnv, ...shellProfile.web, API_ORIGIN: identityApiOrigin },
      ...shellLogs,
    },
    {
      command: 'exec node --import tsx scripts/fixtures/identity-mobile-preview.mts',
      url: identityMobileOrigin,
      reuseExistingServer: false,
      // Identity-only bridge uses the fixed Next guarded basemap route;
      // the internal Vite preview keeps its public basemap deny policy.
      // The preview builds its own run-owned dist so the baked profile always matches.
      timeout: 120000,
      // SIGTERM lets the preview close and remove that run-owned dist before the runner exits.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30000 },
      env: {
        ...shellProfile.mobile,
        API_ORIGIN: identityApiOrigin,
        ...(Object.keys(basemapEnv).length > 0 ? { BASEMAP_ORIGIN: identityWebOrigin } : {}),
      },
      ...shellLogs,
    },
  ],
});
