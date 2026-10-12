import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  identityApiPort,
  identityGarminPort,
  identityMobilePort,
  identityOidcPort,
  identityWebPort,
} from './fixtures/identity-ports.ts';

// Focused commands retain the Playwright CLI. --full also permits a full run with
// a caller's reporter/config flags while preserving four disposable fixtures.
const providedArgs = process.argv.slice(2);
const fullRun = providedArgs.includes('--full');
const args = providedArgs.filter((arg) => arg !== '--full');
const focused = !fullRun && args.some((arg) => arg !== '--list');
const suites = focused
  ? [null]
  : ['general', 'app-consent', 'ai-settings-lifecycle', 'current-manual'];
let interrupted = false;

async function run(suite) {
  const env = {
    ...process.env,
    IDENTITY_E2E_RUN_ID: randomUUID(),
    WORKOUT_IDENTITY_WEB_PORT: String(identityWebPort),
    WORKOUT_IDENTITY_MOBILE_PORT: String(identityMobilePort),
    WORKOUT_IDENTITY_API_PORT: String(identityApiPort),
    WORKOUT_IDENTITY_OIDC_PORT: String(identityOidcPort),
    WORKOUT_IDENTITY_GARMIN_PORT: String(identityGarminPort),
  };
  if (suite) {
    // Canonical fixtures have distinct fixed recipes. Focused CLI remains caller-selected.
    delete env.IDENTITY_E2E_RACE_RESULTS_V2;
    delete env.IDENTITY_E2E_CHECK_IN_TEMPLATES;
    delete env.IDENTITY_E2E_RACE_MANUAL_PUBLIC;
    if (suite === 'current-manual')
      env.IDENTITY_E2E_RACE_MANUAL_PUBLIC = 'installed-current-profile26';
    env.IDENTITY_E2E_SUITE = suite;
    env.IDENTITY_E2E_AI_SETTINGS_LIFECYCLE = suite === 'ai-settings-lifecycle' ? 'on' : 'off';
    env.IDENTITY_E2E_AI_SETTINGS_LIFECYCLE_SPEC_ONLY =
      suite === 'ai-settings-lifecycle' ? '1' : '0';
  }
  const child = spawn(
    'pnpm',
    ['exec', 'playwright', 'test', '--config', 'playwright.identity.config.ts', ...args],
    { env, stdio: 'inherit' },
  );
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      interrupted = true;
      child.kill(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

for (const suite of suites) {
  const result = await run(suite);
  if (result !== 0 || interrupted) {
    process.exitCode = result || 130;
    break;
  }
}
