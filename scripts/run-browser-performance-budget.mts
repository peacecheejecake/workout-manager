/**
 * M2-01ar (a): the browser budget with the same one disclosed re-run as the server probe.
 *
 *   node --import tsx scripts/run-browser-performance-budget.mts --execute [--log=PATH]
 *
 * Runs tests/performance/long-track-render.spec.ts through playwright.performance.config.ts
 * (hold the harness lock: the identity harness binds 3100/4200/4300/4400), reads back the
 * attempt the spec recorded and, when `retryDecision` allows it (only time budgets failed,
 * the median of each one failed at an admissible load still within it, every check and every
 * memory budget met), waits 30 s and runs the spec once more with PERF_RETRY_OF. Playwright
 * starts a fresh harness and a fresh browser for it, so nothing of the first attempt is reused.
 * The re-run records the pair (scripts/performance-budget.ts `combineAttempts`); its `passed` is
 * the pair's verdict, and the exit code is the re-run's.
 *
 * Why a runner and not a retry inside the spec: the spec is one Playwright test whose harness
 * (servers, browser) lives as long as the run. A retry inside it would re-measure on the same
 * warm servers and browser process, and Playwright's own `retries` would re-run it without
 * recording the first attempt or applying the re-run rule.
 *
 * Every PERF_* variable of the spec passes through (PERF_OUT, PERF_BUDGET, PERF_SAMPLES,
 * PERF_ALLOW_DIRTY, PERF_ALLOW_PRODUCT, PERF_RERUN_REASON, PERF_RECORD_ONLY). The runner sets
 * PERF_ATTEMPT_RUNNER and PERF_RETRY_OF itself and refuses them from outside. The console
 * output of both attempts goes to --log (default
 * verification-logs/performance-budget/browser-<start>.log), never under test-results/, which
 * Playwright empties when it starts. Opt-in; refuses CI.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDurableOutputPath,
  attemptAfter,
  repoRelative,
  VERIFICATION_LOG_DIRECTORY,
} from './performance-budget.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const RETRY_PAUSE_MS = 30_000;

/** The latest run of the result file (its `previousRuns` are not looked at), or null. */
async function latestRecord(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** One Playwright run of the browser spec; its output goes to the console and the log. */
function runAttempt(env: Readonly<Record<string, string>>, logPath: string): Promise<number> {
  const child = spawn(
    join(repositoryRoot, 'node_modules/.bin/playwright'),
    ['test', '--config', 'playwright.performance.config.ts'],
    {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const tee = (write: (chunk: Buffer) => void) => (chunk: Buffer) => {
    write(chunk);
    appendFileSync(logPath, chunk);
  };
  child.stdout.on(
    'data',
    tee((chunk) => process.stdout.write(chunk)),
  );
  child.stderr.on(
    'data',
    tee((chunk) => process.stderr.write(chunk)),
  );
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const log = args.find((argument) => argument.startsWith('--log='))?.slice('--log='.length);
  if (
    !args.includes('--execute') ||
    args.some((argument) => argument !== '--execute' && !argument.startsWith('--log=')) ||
    log === ''
  ) {
    console.log(
      'Opt-in only: node --import tsx scripts/run-browser-performance-budget.mts --execute [--log=PATH]. ' +
        'Runs the browser budget spec with one disclosed re-run; hold the harness lock. ' +
        `Logs go to ${VERIFICATION_LOG_DIRECTORY}/, never test-results/.`,
    );
    return;
  }
  if (process.env.CI) throw new Error('Performance budget probes are disabled in CI');
  if (process.env.PERF_ATTEMPT_RUNNER !== undefined || process.env.PERF_RETRY_OF !== undefined)
    throw new Error('PERF_ATTEMPT_RUNNER and PERF_RETRY_OF are set by the runner only');
  const outPath = assertDurableOutputPath(
    repositoryRoot,
    process.env.PERF_OUT ??
      join(repositoryRoot, 'docs/implementation/research/performance-budget-browser-result.json'),
  );
  const startedAt = new Date().toISOString();
  const logPath = assertDurableOutputPath(
    repositoryRoot,
    log === undefined
      ? join(
          VERIFICATION_LOG_DIRECTORY,
          'performance-budget',
          `browser-${startedAt.replaceAll(':', '-')}.log`,
        )
      : resolve(log),
  );
  mkdirSync(dirname(logPath), { recursive: true });
  const say = (line: string) => {
    console.log(line);
    appendFileSync(logPath, `${line}\n`);
  };
  say(
    `run-browser-performance-budget (out ${repoRelative(repositoryRoot, outPath)}, log ${repoRelative(repositoryRoot, logPath)})`,
  );

  const firstExit = await runAttempt({ PERF_ATTEMPT_RUNNER: '1' }, logPath);
  const next = attemptAfter(await latestRecord(outPath), startedAt);
  say(`attempt 1 exited ${firstExit}; next: ${JSON.stringify(next)}`);
  if (next.action === 'stop') {
    say(JSON.stringify({ attempts: 1, exit: firstExit, reason: next.reason }));
    // A run that wrote no result did not pass, whatever Playwright said.
    process.exitCode = next.reason === 'the attempt wrote no result' ? 1 : firstExit;
    return;
  }
  say(
    `RETRY: the first attempt failed only time budgets (${next.timeMetrics.join(', ')}); ` +
      `measuring once more after ${RETRY_PAUSE_MS / 1000} s. The pair passes only if the re-run passes.`,
  );
  await new Promise((done) => setTimeout(done, RETRY_PAUSE_MS));
  const secondExit = await runAttempt(
    { PERF_ATTEMPT_RUNNER: '1', PERF_RETRY_OF: next.retryOf },
    logPath,
  );
  const second = (await latestRecord(outPath)) as {
    attempt?: { number?: unknown; retryOf?: unknown; pair?: unknown };
    passed?: unknown;
  } | null;
  const recorded = second?.attempt?.number === 2 && second.attempt.retryOf === next.retryOf;
  say(
    JSON.stringify({
      attempts: 2,
      retryOf: next.retryOf,
      exit: secondExit,
      pair: recorded ? second?.attempt?.pair : 'not recorded',
    }),
  );
  // The pair passes only when the re-run recorded it as passed and Playwright agreed.
  process.exitCode = recorded && second?.passed === true && secondExit === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
