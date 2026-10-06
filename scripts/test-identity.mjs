import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

// Explicit file-focused commands retain the Playwright CLI. A full run gives
// permission and restore lifecycle scenarios their own fresh disposable fixture.
const args = process.argv.slice(2);
const focused = args.some((arg) => arg !== '--list');
const suites = focused ? [null] : ['general', 'app-consent', 'ai-settings-lifecycle'];
let interrupted = false;

async function run(suite) {
  const env = { ...process.env, IDENTITY_E2E_RUN_ID: randomUUID() };
  if (suite) {
    env.IDENTITY_E2E_SUITE = suite;
    env.IDENTITY_E2E_AI_SETTINGS_LIFECYCLE = suite === 'ai-settings-lifecycle' ? 'on' : 'off';
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
