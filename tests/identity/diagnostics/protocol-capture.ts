import { mkdirSync, openSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { format } from 'node:util';
import { test } from '@playwright/test';
import { sanitizeLine } from './protocol-lines';

/**
 * Opt-in (`IDENTITY_E2E_DIAGNOSTICS=1`) capture inside each Playwright worker process, which
 * is where the browser's CDP connection lives.
 *
 * - `pw:api`, `pw:protocol` and `pw:browser` debug output — the same streams `DEBUG=pw:…`
 *   prints — goes to `protocol-<pid>.log`, one line per message, tagged with the running
 *   test's id so the reporter can cut out a failed test's share.
 * - Once a second, this worker's event-loop delay. A CDP command that was sent but never
 *   answered while the worker's loop kept turning points at the browser; a long loop delay
 *   points at this process being starved.
 *
 * Lines are truncated and session material redacted (`protocol-lines.ts`).
 */
const debugNamespaces = 'pw:api,pw:protocol,pw:browser';

type DebugModule = {
  enable: (namespaces: string) => void;
  log: (...args: unknown[]) => void;
};

function isDebugModule(value: unknown): value is DebugModule {
  return (
    (typeof value === 'function' || typeof value === 'object') &&
    value !== null &&
    'enable' in value &&
    typeof value.enable === 'function'
  );
}

/** The `debug` instance Playwright logs through (it bundles its own copy). */
function playwrightDebug(): DebugModule {
  const fromHere = createRequire(import.meta.url);
  const fromTest = createRequire(fromHere.resolve('@playwright/test'));
  const fromRunner = createRequire(fromTest.resolve('playwright'));
  const bundle: unknown = fromRunner('playwright-core/lib/utilsBundle');
  const debug =
    typeof bundle === 'object' && bundle !== null && 'debug' in bundle ? bundle.debug : null;
  if (!isDebugModule(debug)) throw new Error('Playwright debug logger not found');
  return debug;
}

function currentTestId(): string {
  try {
    return test.info().testId;
  } catch {
    return '-';
  }
}

export function captureWorkerProtocol(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = openSync(join(directory, `protocol-${process.pid}.log`), 'a', 0o600);
  const write = (text: string) => {
    const line = sanitizeLine(text);
    // Synchronous so the lines of a failing test survive the worker being replaced.
    writeSync(file, `${new Date().toISOString()} ${currentTestId()} ${line}\n`);
  };
  const debug = playwrightDebug();
  debug.log = (...args: unknown[]) => write(format(...args));
  debug.enable(debugNamespaces);
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  setInterval(() => {
    const max = loop.max / 1e6;
    const p99 = loop.percentile(99) / 1e6;
    write(`[diag] worker event-loop delay max=${max.toFixed(1)}ms p99=${p99.toFixed(1)}ms`);
    loop.reset();
  }, 1000).unref();
}
