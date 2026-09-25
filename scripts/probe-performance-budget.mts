/**
 * M2-01k-f: measure the server path of the representative long track and ASSERT the
 * performance budget in docs/implementation/research/performance-budget.json.
 *
 *   node --import tsx scripts/probe-performance-budget.mts --execute [options]
 *
 * Options:
 *   --phases=api,engine,worker,parse   phases to run (default: all four, in this order)
 *   --samples=N                        repeated samples per metric (default 20, minimum 5).
 *                                      20 is the smallest n whose nearest-rank p95 is not the
 *                                      maximum, so one outlier on a loaded machine cannot
 *                                      decide a p95 budget by itself.
 *   --record-only                      measure and write samples, judge nothing (baseline runs)
 *   --budget=PATH                      judge against another budget file (controlled checks)
 *   --out=PATH                         where to write the result (default: the research file)
 *   --evaluate=RESULT.json             measure nothing: re-judge recorded samples against
 *                                      the budget (used for the tightened-budget control)
 *   --allow-dirty=REASON               measure although the scanned paths (packages/, apps/,
 *                                      scripts/, tests/, root workspace and Playwright files)
 *                                      differ from HEAD (e.g. a node's own uncommitted probe);
 *                                      the dirty paths and a hash of the difference are recorded.
 *   --allow-product=PATH[,PATH]        product files that may differ from HEAD. Product is
 *                                      everything under packages/ and apps/ except tests and
 *                                      fixtures (src/, Next app/ routes, migrations, config).
 *                                      Any other changed product file is refused, so a leftover
 *                                      mutant stops the run. Checks source, not build output.
 *   --log=PATH                         where the console output is also written (appended).
 *                                      Default: verification-logs/performance-budget/<start>.log
 *                                      (git- and Prettier-ignored, emptied by no tool).
 *   --no-retry                         judge the first attempt only (controlled checks)
 *
 * Output location (M2-01al): neither --out nor --log may lie under test-results/,
 * playwright-report/ or coverage/ in the repository. Playwright empties test-results/ when it
 * starts and Vitest's coverage empties coverage/; the M2-01ai and M2-01aj logs were lost that
 * way. Keep probe logs, redirected shell output included, in verification-logs/.
 *
 * One disclosed re-run (M2-01al): when a judged attempt passed every check and every memory and
 * size budget but failed or left inconclusive a time budget, the probe waits
 * RETRY_PAUSE_MS and measures every requested phase again in a fresh process
 * (`--retry-of=<first attempt's executedAt>`). Both attempts are recorded; the second carries
 * `attempt.retryOf` and the first attempt's non-passing metrics. The pair passes only if the
 * re-run passes by itself (scripts/performance-budget.ts, `combineAttempts`). The 1-minute load
 * average lags a short burst of contention, so the admissible-load rule cannot catch one.
 *
 * Engine graph (M2-01ak): the engine memory budgets are bound to the graph they were baselined
 * on, the national graph. A judged run that includes the engine phase must point at that
 * deployment (ROUTING_GRAPH_ROOT=<its root> ROUTING_EXTRACT_SOURCE=osm-extract-south-korea); on
 * the default .geo-build (Seoul) graph it stops with ENGINE_GRAPH_NOT_BASELINED instead of judging.
 *
 * Opt-in, refuses CI, and is NOT part of `pnpm test`: a budget judged on a shared, loaded
 * machine belongs in a separate step whose failure a person reads, not in a suite whose
 * failure blocks unrelated work. The `api` and `engine` phases bind the fixture identity
 * provider on 4400 (hold the harness lock) and start the self-hosted routing engine on
 * loopback 8991. Nothing external is called. The track is synthetic (scripts/fixtures/
 * long-track.ts); no personal FIT or GPS is read.
 *
 * Phases, in the order they run (the API phase first so the process's peak RSS is the API's
 * and not the in-process parser's):
 *
 *   api     production composition (`createConfiguredApi`) over Fastify inject: upload with
 *           server re-parse in the bounded parse process, finalize, map_path and normalized
 *           reads.
 *   engine  the GraphHopper JVM's RSS idle and under routing load. The load is the product's
 *           own admission shape: two tenants, each at its concurrency limit (2), sending
 *           the contract's maximum waypoint count (12) spread along the long track (a ~26 km
 *           route) through the API.
 *           This is the workload the budget is about, bounded and short — not machine load.
 *   worker  the bounded parse host (`createBoundedTrackParser`): wall time, the peak RSS of
 *           each parse process (M2-01aj), the smallest V8 heap ceiling the long track parses
 *           under, and the concurrency bound at its limit. The phase and its metric ids keep
 *           their M2-01k-f name; since M2-01ai each parse runs in a child process
 *           (`--max-old-space-size`), not a worker thread.
 *   parse   the same product functions in-process (warm): parse+normalize and map_path time,
 *           and the serialized sizes of both artifacts.
 *
 * Every sample records the 1-minute load average when it was taken. The run exits non-zero
 * when any budget or check fails, or when a time budget is `inconclusive` (exceeded above the
 * baseline's highest load; see scripts/performance-budget.ts) — that run must be repeated at
 * an admissible load and is neither a pass nor a regression. With the re-run, the exit code is
 * the pair's verdict.
 */
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, promisify } from 'node:util';

import { trackLimits } from '../packages/contracts/src/tracks.ts';
import { routingLimits, walkingRouteResultSchema } from '../packages/contracts/src/routing.ts';
import { buildMapPath, parseTrackFile } from '../packages/track-parsing/src/index.ts';
import {
  DEFAULT_TRACK_PARSE_HEAP_MEGABYTES,
  createBoundedTrackParser,
} from '../packages/server/track-storage/src/parse-host.ts';
import type { StoredTrackSelection } from '../packages/server/track-storage/src/artifacts.ts';
import {
  LONG_TRACK_SAMPLES,
  longTrackAt,
  longTrackFitBytes,
  longTrackLengthMeters,
  longTrackPosition,
} from './fixtures/long-track.ts';
import {
  describeEvaluation,
  evaluateBudget,
  parseBudgetFile,
  sampleNow,
  type BudgetEvaluation,
  type BudgetPhase,
  type BudgetSample,
  assertDurableOutputPath,
  assertMeasurableSourceTree,
  combineAttempts,
  MAX_JUDGED_ATTEMPTS,
  parseProcessRssCheck,
  repoRelative,
  retryDecision,
  runContext,
  VERIFICATION_LOG_DIRECTORY,
  writeResultWithHistory,
  type RecordedRun,
  type RetryDecision,
  type SourceTreeState,
} from './performance-budget.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultBudgetPath = join(
  repositoryRoot,
  'docs/implementation/research/performance-budget.json',
);
const defaultResultPath = join(
  repositoryRoot,
  'docs/implementation/research/performance-budget-result.json',
);
const ENGINE_PORT = 8991;
const ALL_PHASES = ['api', 'engine', 'worker', 'parse'] as const;
type ServerPhase = (typeof ALL_PHASES)[number];
const execFileAsync = promisify(execFile);
const MiB = 2 ** 20;
/** How long the probe waits before its one re-run, so a short burst can pass (M2-01al). */
const RETRY_PAUSE_MS = 30_000;

export interface ProbeOptions {
  readonly phases: readonly ServerPhase[];
  readonly samples: number;
  readonly recordOnly: boolean;
  readonly budgetPath: string;
  readonly outPath: string;
  readonly evaluatePath: string | null;
  readonly allowDirtyReason: string | null;
  readonly allowedProductPaths: readonly string[];
  /** `null`: the default under verification-logs/, named by the start time. */
  readonly logPath: string | null;
  readonly retry: boolean;
  /** Set only on the re-run the probe starts itself: the first attempt's `executedAt`. */
  readonly retryOf: string | null;
}

export function parseProbeArguments(args: readonly string[]): ProbeOptions | null {
  if (!args.includes('--execute')) return null;
  let phases: ServerPhase[] = [...ALL_PHASES];
  let samples = 20;
  let recordOnly = false;
  let budgetPath = defaultBudgetPath;
  let outPath = defaultResultPath;
  let evaluatePath: string | null = null;
  let allowDirtyReason: string | null = null;
  let allowedProductPaths: string[] = [];
  let logPath: string | null = null;
  let retry = true;
  let retryOf: string | null = null;
  for (const argument of args) {
    if (argument === '--execute') continue;
    if (argument === '--record-only') {
      recordOnly = true;
      continue;
    }
    if (argument === '--no-retry') {
      retry = false;
      continue;
    }
    const separator = argument.indexOf('=');
    const name = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? undefined : argument.slice(separator + 1);
    if (value === undefined || value === '') return null;
    if (name === '--phases') {
      const requested = value.split(',');
      if (requested.some((phase) => !(ALL_PHASES as readonly string[]).includes(phase)))
        return null;
      // Always in the fixed order, whatever order was typed.
      phases = ALL_PHASES.filter((phase) => requested.includes(phase));
    } else if (name === '--samples') {
      samples = Number(value);
      if (!Number.isInteger(samples) || samples < 5 || samples > 50) return null;
    } else if (name === '--budget') budgetPath = resolve(value);
    else if (name === '--out') outPath = resolve(value);
    else if (name === '--evaluate') evaluatePath = resolve(value);
    else if (name === '--allow-dirty') allowDirtyReason = value;
    else if (name === '--allow-product') allowedProductPaths = value.split(',');
    else if (name === '--log') logPath = resolve(value);
    else if (name === '--retry-of') retryOf = value;
    else return null;
  }
  // A re-run is judged and is never re-run again.
  if (retryOf !== null && (recordOnly || evaluatePath !== null || !retry)) return null;
  return {
    phases,
    samples,
    recordOnly,
    budgetPath,
    outPath,
    evaluatePath,
    allowDirtyReason,
    allowedProductPaths,
    logPath,
    retry,
    retryOf,
  };
}

/** Everything the probe prints also goes to `path` (appended), which survives Playwright. */
function teeConsoleTo(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const print = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    print(...args);
    appendFileSync(path, `${format(...args)}\n`);
  };
}

/**
 * Starts the one re-run in a fresh process, so no state of the first attempt (module-level
 * samples, the process's own peak RSS, warm caches) reaches it. Same arguments, the same log,
 * and `--retry-of`. Resolves to the re-run's exit code.
 */
async function startRetry(firstExecutedAt: string, logPath: string): Promise<number> {
  const args = process.argv
    .slice(2)
    .filter((argument) => !argument.startsWith('--log=') && !argument.startsWith('--retry-of='));
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      ...args,
      `--log=${logPath}`,
      `--retry-of=${firstExecutedAt}`,
    ],
    { stdio: 'inherit' },
  );
  return new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', (code, signal) => done(code ?? (signal === null ? 1 : 128)));
  });
}

interface FirstAttempt {
  readonly executedAt: string;
  readonly mode: string;
  readonly sourceTree: SourceTreeState;
  readonly evaluation: BudgetEvaluation;
  readonly checks: readonly { id: string; passed: boolean }[];
}

/** The first attempt as the result file records it: the latest run, named by `--retry-of`. */
async function readFirstAttempt(outPath: string, executedAt: string): Promise<FirstAttempt> {
  const recorded = JSON.parse(await readFile(outPath, 'utf8')) as Partial<FirstAttempt>;
  if (
    recorded.executedAt !== executedAt ||
    recorded.mode !== 'judged' ||
    recorded.sourceTree === undefined ||
    recorded.evaluation === undefined ||
    recorded.evaluation === null ||
    !Array.isArray(recorded.checks)
  )
    throw new Error(`RETRY_FIRST_ATTEMPT_NOT_FOUND: ${executedAt}`);
  return recorded as FirstAttempt;
}

// ---------------------------------------------------------------- recording
const observations: Record<string, BudgetSample[]> = {};
const checks: { id: string; passed: boolean; detail: string }[] = [];
const details: Record<string, unknown> = {};

function record(metric: string, value: number) {
  const sample = sampleNow(value);
  (observations[metric] ??= []).push(sample);
  console.log(`  ${metric}: ${value} (load ${sample.loadAverage1m})`);
}
function check(id: string, passed: boolean, detail: string) {
  checks.push({ id, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}
const elapsed = (started: number) => Math.round(performance.now() - started);
const mib = (bytes: number) => Math.round((bytes / MiB) * 10) / 10;

async function rssMiB(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kib = Number(stdout.trim());
    return Number.isFinite(kib) && kib > 0 ? Math.round(kib / 1024) : null;
  } catch {
    return null;
  }
}

/** Samples a process's RSS every `intervalMs` until stopped; returns every reading. */
function rssSampler(pid: number, intervalMs = 250) {
  const readings: number[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const value = await rssMiB(pid);
      if (value !== null) readings.push(value);
      await new Promise((done) => setTimeout(done, intervalMs));
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return readings;
    },
  };
}

const selection: StoredTrackSelection = {
  recordedTrackIndex: 0,
  provenance: {
    kind: 'activity-source',
    activityId: '11111111-1111-4111-8111-111111111111',
    sourceId: '22222222-2222-4222-8222-222222222222',
    sourceRevision: 1,
    trackRevision: 1,
  },
};

// ---------------------------------------------------------------- worker phase
/** How often the parse processes' RSS is read while a parse runs. */
const CHILD_RSS_INTERVAL_MS = 20;

/**
 * The RSS of the parse processes `parser` is running, read with `ps` every
 * {@link CHILD_RSS_INTERVAL_MS} until `pending` settles (M2-01ai moved the parse into a child
 * process, so its memory is no longer inside this process's own RSS; M2-01aj budgets it).
 * The processes are the parser's own (`processIds()`), so tsx's esbuild service, which is
 * also a child of this process, is never counted.
 *
 * Returns the highest single-process reading and the highest sum over the processes alive
 * at one reading, or `null` for either when no reading was taken. A reading can miss a peak
 * shorter than the interval, so the value is a lower bound of the true peak; the budget was
 * derived from values read the same way.
 */
async function withChildRss<T>(
  parser: ReturnType<typeof createBoundedTrackParser>,
  pending: Promise<T>,
): Promise<{ value: T; peakChildMiB: number | null; peakSumMiB: number | null }> {
  let settled = false;
  const done = pending.finally(() => {
    settled = true;
  });
  let peakChild: number | null = null;
  let peakSum: number | null = null;
  while (!settled) {
    const pids = parser.processIds();
    if (pids.length > 0) {
      try {
        const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', pids.join(',')]);
        const readings = stdout
          .split('\n')
          .map((line) => Number(line.trim()))
          .filter((kib) => Number.isFinite(kib) && kib > 0)
          .map((kib) => Math.round(kib / 1024));
        if (readings.length > 0) {
          peakChild = Math.max(peakChild ?? 0, ...readings);
          peakSum = Math.max(
            peakSum ?? 0,
            readings.reduce((sum, value) => sum + value, 0),
          );
        }
      } catch {
        // The process ended between `processIds()` and `ps`: a missing reading, not a zero.
      }
    }
    await Promise.race([done, new Promise((wait) => setTimeout(wait, CHILD_RSS_INTERVAL_MS))]);
  }
  return { value: await done, peakChildMiB: peakChild, peakSumMiB: peakSum };
}

async function workerPhase(fitBytes: Uint8Array, samples: number) {
  // The metric ids keep their M2-01k-f names (`worker.*`). Since M2-01ai the bounded parse
  // runs in a child process, not a worker thread; each sample includes starting it.
  console.log('worker phase (bounded parse process)');
  const parser = createBoundedTrackParser();
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const outcome = await parser.parse(fitBytes, selection, { filename: 'long.fit' });
    if (!outcome.ok) throw new Error(`WORKER_PARSE_FAILED: ${outcome.code}`);
    if (outcome.artifacts.track.samples.length !== LONG_TRACK_SAMPLES)
      throw new Error('WORKER_SAMPLE_COUNT');
    record('worker.parseMs', elapsed(started));
  }

  // M2-01aj: the peak RSS of each parse process (default 256 MiB ceiling), one parse at a
  // time. These are parses of their own, so reading the RSS (`ps` every 20 ms) never sits
  // inside a time sample above.
  let unread = 0;
  for (let index = 0; index < samples; index += 1) {
    const { value: outcome, peakChildMiB } = await withChildRss(
      parser,
      parser.parse(fitBytes, selection, { filename: 'long.fit' }),
    );
    if (!outcome.ok) throw new Error(`WORKER_PARSE_FAILED: ${outcome.code}`);
    if (peakChildMiB === null) unread += 1;
    else record('worker.parseProcessPeakRssMiB', peakChildMiB);
  }
  // M2-01al (a): a parse whose RSS was never read does not count as within budget.
  const coverage = parseProcessRssCheck(samples, unread);
  check(coverage.id, coverage.passed, coverage.detail);
  // For the record, not a budget: both processes of one parser at its bound at once. An API
  // runs two parsers (course import, stored recordings), so up to twice this.
  const pair = createBoundedTrackParser();
  const atBound = await withChildRss(
    pair,
    Promise.all(
      Array.from({ length: trackLimits.workerConcurrency }, () => pair.parse(fitBytes, selection)),
    ),
  );
  if (!atBound.value.every((outcome) => outcome.ok)) throw new Error('WORKER_PAIR_PARSE_FAILED');
  const perParse = observations['worker.parseProcessPeakRssMiB'] ?? [];
  details['parseProcessRss'] = {
    peakChildMiB: perParse.length === 0 ? null : Math.max(...perParse.map((s) => s.value)),
    parsesWithoutReading: unread,
    atBoundPeakSumMiB: atBound.peakSumMiB,
    intervalMs: CHILD_RSS_INTERVAL_MS,
    note: "ps RSS of the parser's own parse processes every 20 ms. peakChildMiB is the highest worker.parseProcessPeakRssMiB sample (one parse at a time, in parses separate from the worker.parseMs samples; budgeted since M2-01aj). atBoundPeakSumMiB is the highest sum over the processes of one parser at its concurrency bound, recorded only. A reading can miss a shorter peak.",
  };

  // The smallest V8 old-generation ceiling the long track parses under. Ascending ladder,
  // twice; each rung is a fresh parse process. A rung below the answer must fail with the memory
  // code, or the answer is only "the floor of the ladder" and says nothing.
  const ladder = [16, 24, 32, 48, 64, 96, 128, 192, DEFAULT_TRACK_PARSE_HEAP_MEGABYTES];
  const ladderRuns: { ceilingMb: number; outcome: string }[][] = [];
  for (let run = 0; run < 2; run += 1) {
    const rungs: { ceilingMb: number; outcome: string }[] = [];
    let found: number | null = null;
    for (const ceilingMb of ladder) {
      const outcome = await createBoundedTrackParser({
        maxOldGenerationSizeMb: ceilingMb,
      }).parse(fitBytes, selection);
      rungs.push({ ceilingMb, outcome: outcome.ok ? 'ok' : outcome.code });
      if (outcome.ok) {
        found = ceilingMb;
        break;
      }
    }
    ladderRuns.push(rungs);
    if (found === null) throw new Error('LONG_TRACK_DOES_NOT_PARSE_UNDER_PRODUCT_CEILING');
    record('worker.minimumHeapCeilingMiB', found);
  }
  details['heapCeilingLadder'] = ladderRuns;
  const refusedBelow = ladderRuns.every((rungs) =>
    rungs.slice(0, -1).some((rung) => rung.outcome === 'TRACK_PARSE_MEMORY_EXCEEDED'),
  );
  check(
    'worker-heap-ceiling-is-a-real-threshold',
    refusedBelow,
    ladderRuns
      .map((rungs) => rungs.map((rung) => `${rung.ceilingMb}:${rung.outcome}`).join(' '))
      .join(' | '),
  );

  // Concurrency at the product's bound: three parses at once against the default parser.
  // Exactly the bound runs; the rest is refused, not queued; the bound frees afterwards.
  const bounded = createBoundedTrackParser();
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: trackLimits.workerConcurrency + 1 }, () =>
        bounded.parse(fitBytes, selection),
      ),
    );
    const wall = elapsed(started);
    const parsed = outcomes.filter((outcome) => outcome.ok).length;
    const busy = outcomes.filter(
      (outcome) => !outcome.ok && outcome.code === 'TRACK_PARSER_BUSY',
    ).length;
    if (index === 0)
      check(
        'worker-concurrency-bound-at-limit',
        parsed === trackLimits.workerConcurrency && busy === 1 && bounded.active() === 0,
        `bound ${trackLimits.workerConcurrency}: ${parsed} parsed, ${busy} TRACK_PARSER_BUSY, active after ${bounded.active()}`,
      );
    record('worker.concurrentAtBoundMs', wall);
  }
  // M2-01ai: every parse process of the phase — ladder rungs that V8 aborted included — is
  // gone once its parse has answered. None is left behind by this phase.
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'ppid=,command=']);
  const leftover = stdout
    .split('\n')
    .filter((line) => line.trim().startsWith(`${process.pid} `) && line.includes('parse-child'));
  check(
    'worker-no-parse-process-left',
    leftover.length === 0 &&
      [parser, pair, bounded].every((each) => each.processIds().length === 0),
    `${leftover.length} parse processes alive after the phase`,
  );
}

// ---------------------------------------------------------------- parse phase
async function parsePhase(fitBytes: Uint8Array, samples: number) {
  console.log('parse phase (in-process, warm)');
  // One warm-up, not recorded: the production parse process is cold every time and is measured
  // by the worker phase; this phase isolates the functions themselves.
  const warm = await parseTrackFile(fitBytes, { filename: 'long.fit' });
  buildMapPath(warm.recorded[0] as NonNullable<(typeof warm.recorded)[0]>);
  for (let index = 0; index < samples; index += 1) {
    let started = performance.now();
    const file = await parseTrackFile(fitBytes, { filename: 'long.fit' });
    record('parse.parseNormalizeMs', elapsed(started));
    const track = file.recorded[0];
    if (!track || track.samples.length !== LONG_TRACK_SAMPLES) throw new Error('PARSE_SAMPLES');
    started = performance.now();
    const mapPath = buildMapPath(track);
    record('parse.mapPathMs', elapsed(started));
    record('parse.normalizedBytes', Buffer.byteLength(JSON.stringify(track)));
    record('parse.mapPathBytes', Buffer.byteLength(JSON.stringify(mapPath)));
  }
}

// ---------------------------------------------------------------- api + engine phases
async function servicePhases(fitBytes: Buffer, options: ProbeOptions) {
  const { createConfiguredApi } = await import('../apps/api/src/configured.ts');
  const {
    routingExtract,
    routingGraphConfig,
    routingGraphDirectory,
    startEngine,
    stopEngine,
    waitForEngine,
  } = await import('./build-routing-graph.mts');
  const { fixtureOidc, startFixtureOidc } = await import('./fixtures/oidc-provider.ts');
  const { PUBLIC_ORIGIN, Session, detectedBin, startDatabase } =
    await import('./probe-routing-operational.mts');
  if (detectedBin === undefined) throw new Error('MISSING_PREREQUISITE: PostgreSQL binaries');

  const workRoot = join(repositoryRoot, '.geo-build');
  const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
  const directory = await mkdtemp(join(tmpdir(), 'workout-performance-budget-'));
  const storageRoot = join(directory, 'objects');
  await mkdir(storageRoot, { recursive: true });
  const database = await startDatabase(directory, detectedBin);
  const oidc = await startFixtureOidc();
  const engine = startEngine({
    jarPath,
    configPath: routingGraphConfig,
    // Follows ROUTING_GRAPH_ROOT / ROUTING_EXTRACT_SOURCE (M2-01ak: the national graph).
    extractPath: routingExtract.path,
    graphPath: routingGraphDirectory,
  });
  let api: Awaited<ReturnType<typeof createConfiguredApi>> | null = null;
  try {
    await waitForEngine(engine, ENGINE_PORT);
    const enginePid = engine.process.pid;
    if (enginePid === undefined) throw new Error('ENGINE_PID_UNKNOWN');
    // Which graph the engine metrics were measured on (M2-01ak re-baselined them on the
    // national graph): read from the manifest the API verifies below.
    const manifest = JSON.parse(
      await readFile(join(routingGraphDirectory, 'routing-graph-manifest.json'), 'utf8'),
    ) as { extractRegion?: unknown; graphContentSha256?: unknown; extractSha256?: unknown };
    details['routingGraph'] = {
      extractSource: routingExtract.sourceId,
      extractRegion: manifest.extractRegion,
      extractSha256: manifest.extractSha256,
      graphContentSha256: manifest.graphContentSha256,
    };
    api = await createConfiguredApi({
      NODE_ENV: 'development',
      DATABASE_URL: database.runtimeUrl,
      PUBLIC_ORIGIN,
      OIDC_ISSUER: fixtureOidc.issuer,
      OIDC_CLIENT_ID: fixtureOidc.clientId,
      OIDC_CLIENT_SECRET: fixtureOidc.clientSecret,
      ALLOW_INSECURE_LOCALHOST: 'true',
      PRIVATE_RESOURCE_STORAGE_ROOT: storageRoot,
      ROUTING_ENGINE_URL: `http://127.0.0.1:${ENGINE_PORT}/`,
      ROUTING_GRAPH_DIRECTORY: routingGraphDirectory,
      ROUTING_ENGINE_ARTIFACT: jarPath,
      ROUTING_PROFILE_CONFIG: routingGraphConfig,
    });
    const app = api;
    await app.ready();
    const alice = new Session();
    await alice.login(app, 'alice');

    if (options.phases.includes('api')) {
      console.log('api phase');
      const length = Math.round(longTrackLengthMeters());
      const statuses: number[] = [];
      for (let index = 0; index < options.samples; index += 1) {
        const imported = await app.inject({
          method: 'POST',
          url: '/bff/v1/activity-imports',
          headers: alice.headers(true),
          payload: {
            source: {
              kind: 'fit',
              sourceId: randomUUID(),
              revision: 1,
              contentHash: 'f'.repeat(64),
            },
            activity: {
              title: `M2-01k-f long track ${index}`,
              kind: 'running',
              startedAt: longTrackAt(index * 100_000),
              timezone: 'UTC',
              durationSeconds: LONG_TRACK_SAMPLES,
              durationKind: 'elapsed',
              distanceMeters: length,
            },
          },
        });
        statuses.push(imported.statusCode);
        const activity = imported.json() as { activityId: string; revision: number };
        const reserved = await app.inject({
          method: 'POST',
          url: `/bff/v1/activities/${activity.activityId}/track-uploads`,
          headers: alice.headers(true),
          payload: { expectedActivityRevision: activity.revision, recordedTrackIndex: 0 },
        });
        statuses.push(reserved.statusCode);
        const { uploadId } = reserved.json() as { uploadId: string };

        let started = performance.now();
        const uploaded = await app.inject({
          method: 'PUT',
          url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
          headers: {
            ...alice.headers(true),
            'content-type': 'application/octet-stream',
            'x-track-file-name': encodeURIComponent('long.fit'),
          },
          payload: fitBytes,
        });
        statuses.push(uploaded.statusCode);
        record('api.uploadParseMs', elapsed(started));

        started = performance.now();
        const finalized = await app.inject({
          method: 'POST',
          url: `/bff/v1/activity-track-uploads/${uploadId}/finalize`,
          // No body, so no JSON content type: Fastify refuses an empty JSON body.
          headers: Object.fromEntries(
            Object.entries(alice.headers(true)).filter(([name]) => name !== 'content-type'),
          ),
        });
        statuses.push(finalized.statusCode);
        record('api.finalizeMs', elapsed(started));

        for (const variant of ['map_path', 'normalized'] as const) {
          started = performance.now();
          const read = await app.inject({
            method: 'GET',
            url: `/bff/v1/activities/${activity.activityId}/track/content?variant=${variant}`,
            headers: alice.headers(false),
          });
          const ms = elapsed(started);
          statuses.push(read.statusCode);
          const key = variant === 'map_path' ? 'MapPath' : 'Normalized';
          record(`api.read${key}Ms`, ms);
          record(`api.read${key}Bytes`, read.rawPayload.byteLength);
          if (index === 0 && variant === 'map_path') {
            const body = read.json() as { geometry: { coordinates: unknown[][] } };
            const vertices = body.geometry.coordinates.reduce((sum, line) => sum + line.length, 0);
            check(
              'api-map-path-carries-the-whole-track',
              vertices === LONG_TRACK_SAMPLES,
              `${vertices} vertices for ${LONG_TRACK_SAMPLES} samples`,
            );
          }
        }
        // The process's own high-water mark: API, parse host and this probe together. Since
        // M2-01ai the parse itself runs in a child process and is not in this number; the
        // worker phase measures and budgets that memory (worker.parseProcessPeakRssMiB,
        // M2-01aj), and this budget was re-derived without it.
        record('api.processPeakRssMiB', Math.round(process.resourceUsage().maxRSS / 1024));
      }
      const failed = statuses.filter((status) => status !== 200);
      check(
        'api-every-request-succeeded',
        failed.length === 0,
        `${statuses.length} requests, non-200: ${failed.join(',') || 'none'}`,
      );
    }

    if (options.phases.includes('engine')) {
      console.log('engine phase');
      const bob = new Session();
      await bob.login(app, 'bob');
      const heavy = Array.from({ length: routingLimits.maxWaypoints }, (_, index) =>
        longTrackPosition(
          Math.min(
            LONG_TRACK_SAMPLES - 1,
            Math.floor((index * LONG_TRACK_SAMPLES) / routingLimits.maxWaypoints),
          ),
        ),
      );
      let requestRevision = 0;
      const route = async (session: InstanceType<typeof Session>) => {
        requestRevision += 1;
        const started = performance.now();
        const response = await app.inject({
          method: 'POST',
          url: '/bff/v1/routing/walking-routes',
          headers: session.headers(true),
          payload: {
            schemaVersion: 1,
            requestId: `perf-${randomUUID()}`,
            requestRevision,
            profileId: 'foot-v1',
            waypoints: heavy,
          },
        });
        const ms = elapsed(started);
        const parsed = walkingRouteResultSchema.safeParse(response.json());
        return {
          ms,
          status: response.statusCode,
          outcome: parsed.success ? parsed.data.outcome : `invalid:${response.statusCode}`,
          distance:
            parsed.success && parsed.data.outcome === 'route_computed'
              ? Math.round(parsed.data.distanceMeters)
              : null,
        };
      };
      // One warm-up request (alice), not recorded: the first query loads graph pages.
      const warm = await route(alice);
      details['engineWarmUp'] = warm;
      // Idle: after warm-up, before load. One reading per sample, half a second apart.
      for (let index = 0; index < options.samples; index += 1) {
        const value = await rssMiB(enginePid);
        if (value !== null) record('engine.idleRssMiB', value);
        await new Promise((done) => setTimeout(done, 500));
      }
      // Load: each round runs both tenants at their concurrency limit at once, i.e.
      // 2 x tenantConcurrency routes in flight. The number of rounds is what the tenant rate
      // window admits (1 warm-up + rounds x concurrency <= tenantRequestsPerWindow), so
      // admission refuses nothing and every request reaches the engine.
      const perRound = routingLimits.tenantConcurrency;
      const rounds = Math.floor((routingLimits.tenantRequestsPerWindow - 1) / perRound);
      const outcomes: string[] = [warm.outcome];
      const distances = new Set<number | null>([warm.distance]);
      for (let round = 0; round < rounds; round += 1) {
        const sampler = rssSampler(enginePid);
        const results = await Promise.all([
          ...Array.from({ length: perRound }, () => route(alice)),
          ...Array.from({ length: perRound }, () => route(bob)),
        ]);
        const readings = await sampler.stop();
        for (const result of results) {
          outcomes.push(result.outcome);
          distances.add(result.distance);
          record('engine.routeUnderLoadMs', result.ms);
        }
        if (readings.length > 0) record('engine.loadPeakRssMiB', Math.max(...readings));
      }
      const notComputed = outcomes.filter((outcome) => outcome !== 'route_computed');
      check(
        'engine-load-every-route-computed',
        notComputed.length === 0,
        `${outcomes.length} routes (${2 * perRound} in flight per round), ${
          notComputed.length
        } not computed ${notComputed.slice(0, 3).join(',')}; distances ${[...distances].join(',')} m`,
      );
      details['engineLoad'] = {
        inFlightPerRound: 2 * perRound,
        rounds,
        waypoints: heavy.length,
        heapArguments: '-Xms512m -Xmx2048m (scripts/build-routing-graph.mts startEngine default)',
      };
    }
  } finally {
    if (api !== null) await api.close().catch(() => undefined);
    await stopEngine(engine);
    await oidc.close().catch(() => undefined);
    await database.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- budget-to-bound checks
/**
 * The budget has to sit inside the product's hard bounds, or a track that meets the budget
 * could still be refused by the product (or the bound could never be reached).
 */
function boundChecks(budgetPath: string, budget: ReturnType<typeof parseBudgetFile>) {
  const metrics = budget.desktop.metrics;
  const ceiling = metrics['worker.minimumHeapCeilingMiB'];
  const parseTime = metrics['worker.parseMs'];
  const routeTime = metrics['engine.routeUnderLoadMs'];
  const normalized = metrics['api.readNormalizedBytes'];
  check(
    'budget-heap-below-product-ceiling',
    ceiling !== undefined && ceiling.budget <= DEFAULT_TRACK_PARSE_HEAP_MEGABYTES,
    `${ceiling?.budget ?? '-'} MiB <= ${DEFAULT_TRACK_PARSE_HEAP_MEGABYTES} MiB (${repoRelative(repositoryRoot, budgetPath)})`,
  );
  check(
    'budget-parse-time-below-parser-deadline',
    parseTime !== undefined && parseTime.budget < trackLimits.parseMilliseconds,
    `${parseTime?.budget ?? '-'} ms < ${trackLimits.parseMilliseconds} ms`,
  );
  check(
    'budget-route-time-below-routing-deadline',
    routeTime !== undefined && routeTime.budget < routingLimits.deadlineMilliseconds,
    `${routeTime?.budget ?? '-'} ms < ${routingLimits.deadlineMilliseconds} ms`,
  );
  check(
    'budget-normalized-below-output-limit',
    normalized !== undefined && normalized.budget < trackLimits.normalizedBytes,
    `${normalized?.budget ?? '-'} B < ${trackLimits.normalizedBytes} B`,
  );
}

const phaseMap: Record<ServerPhase, BudgetPhase> = {
  api: 'api',
  engine: 'engine',
  worker: 'worker',
  parse: 'parse',
};

async function main() {
  const options = parseProbeArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-performance-budget.mts --execute ' +
        '[--phases=api,engine,worker,parse] [--samples=N] [--record-only] [--budget=PATH] ' +
        '[--out=PATH] [--evaluate=RESULT.json] [--log=PATH] [--no-retry]. The api/engine ' +
        'phases bind the fixture OIDC provider on 4400 (hold the harness lock) and the ' +
        `routing engine on loopback 8991. Logs go to ${VERIFICATION_LOG_DIRECTORY}/, never test-results/. ` +
        'The engine memory budgets are bound to the national graph (M2-01ak): a judged run with the engine ' +
        'phase needs ROUTING_GRAPH_ROOT=<the national deployment root> and ROUTING_EXTRACT_SOURCE=' +
        'osm-extract-south-korea; on the default .geo-build (Seoul) graph it stops with ENGINE_GRAPH_NOT_BASELINED.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Performance budget probes are disabled in CI');
  // M2-01al (c): refuse a result or log path that a tool would empty, before measuring.
  assertDurableOutputPath(repositoryRoot, options.outPath);
  const logPath = assertDurableOutputPath(
    repositoryRoot,
    options.logPath ??
      join(
        VERIFICATION_LOG_DIRECTORY,
        'performance-budget',
        `${new Date().toISOString().replaceAll(':', '-')}.log`,
      ),
  );
  teeConsoleTo(logPath);
  console.log(
    `probe-performance-budget ${process.argv.slice(2).join(' ')} (log ${repoRelative(repositoryRoot, logPath)})`,
  );

  if (options.evaluatePath !== null) {
    // Re-judge recorded samples: no measurement, same evaluator, possibly another budget.
    const recorded = JSON.parse(await readFile(options.evaluatePath, 'utf8')) as {
      phases: ServerPhase[];
      samples: Record<string, BudgetSample[]>;
      details?: RecordedRun['details'];
    };
    const budget = parseBudgetFile(JSON.parse(await readFile(options.budgetPath, 'utf8')));
    const evaluation = evaluateBudget(
      budget,
      recorded.samples,
      recorded.phases.map((phase) => phaseMap[phase]),
      runContext(recorded),
    );
    console.log(describeEvaluation(evaluation));
    console.log(
      JSON.stringify({
        passed: evaluation.passed,
        inconclusive: evaluation.inconclusive,
        budget: repoRelative(repositoryRoot, options.budgetPath),
      }),
    );
    if (!evaluation.passed) process.exitCode = 1;
    return;
  }

  // Before anything is measured: a tree that differs from HEAD is refused (see the option).
  const sourceTree = assertMeasurableSourceTree(
    repositoryRoot,
    options.allowDirtyReason,
    options.allowedProductPaths,
  );
  const fitBytes = longTrackFitBytes();
  const startedAt = new Date().toISOString();
  const loadAtStart = loadavg().map((value) => Math.round(value * 100) / 100);
  if (options.phases.includes('api') || options.phases.includes('engine'))
    await servicePhases(fitBytes, options);
  if (options.phases.includes('worker')) await workerPhase(fitBytes, options.samples);
  if (options.phases.includes('parse')) await parsePhase(fitBytes, options.samples);

  let evaluation: BudgetEvaluation | null = null;
  if (!options.recordOnly) {
    const budget = parseBudgetFile(JSON.parse(await readFile(options.budgetPath, 'utf8')));
    boundChecks(options.budgetPath, budget);
    evaluation = evaluateBudget(
      budget,
      observations,
      options.phases.map((phase) => phaseMap[phase]),
      runContext({ details }),
    );
    console.log(describeEvaluation(evaluation));
  }

  // M2-01al (b): the one re-run. The first attempt says whether it may be re-run; the re-run
  // reads the first attempt back and records the pair's verdict.
  let attempt: Record<string, unknown> | null = null;
  let retry: RetryDecision | null = null;
  let pair: ReturnType<typeof combineAttempts> | null = null;
  if (evaluation !== null && options.retryOf === null) {
    retry = options.retry
      ? retryDecision(
          evaluation,
          checks.every((entry) => entry.passed),
          1,
        )
      : { retry: false, reason: '--no-retry' };
    attempt = { number: 1, of: MAX_JUDGED_ATTEMPTS, retry };
  } else if (evaluation !== null && options.retryOf !== null) {
    const first = await readFirstAttempt(options.outPath, options.retryOf);
    check(
      'retry-measured-the-same-tree',
      first.sourceTree.head === sourceTree.head &&
        first.sourceTree.diffSha256 === sourceTree.diffSha256,
      `first attempt ${first.sourceTree.head.slice(0, 7)}/${first.sourceTree.diffSha256?.slice(0, 8) ?? 'clean'}, re-run ${sourceTree.head.slice(0, 7)}/${sourceTree.diffSha256?.slice(0, 8) ?? 'clean'}`,
    );
    pair = combineAttempts(
      { evaluation: first.evaluation, checksPassed: first.checks.every((entry) => entry.passed) },
      { evaluation, checksPassed: checks.every((entry) => entry.passed) },
    );
    attempt = {
      number: 2,
      of: MAX_JUDGED_ATTEMPTS,
      retryOf: first.executedAt,
      firstAttemptNotPassed: first.evaluation.metrics
        .filter((metric) => metric.verdict !== 'passed')
        .map((metric) => ({
          id: metric.id,
          verdict: metric.verdict,
          observed: metric.observed,
          budget: metric.budget,
          loadAverage1m: metric.loadAverage1m,
        })),
      ownVerdict: checks.every((entry) => entry.passed) && evaluation.passed,
      pair,
      rule: 'Re-run once, in full, only after a first attempt that failed only time budgets with every check and every memory and size budget met. The pair passes only if the re-run passes by itself (scripts/performance-budget.ts combineAttempts).',
    };
  }
  const checksPassed = checks.every((entry) => entry.passed);
  // On the re-run, `passed` is the pair's verdict (`attempt.ownVerdict` keeps the re-run's own).
  const passed =
    pair !== null ? pair.passed : checksPassed && (evaluation === null ? null : evaluation.passed);
  await writeResultWithHistory(options.outPath, {
    schemaVersion: 1,
    node: 'M2-01k-f',
    executedAt: startedAt,
    finishedAt: new Date().toISOString(),
    label:
      'Desktop, this shared machine, synthetic 20,000-sample track. Not a device result. ' +
      'Every sample carries the 1-minute load average when it was taken.',
    mode: options.recordOnly ? 'record-only (baseline, not judged)' : 'judged',
    budgetFile: options.recordOnly ? null : repoRelative(repositoryRoot, options.budgetPath),
    sourceTree,
    phases: options.phases,
    samplesPerMetric: options.samples,
    track: {
      kind: 'synthetic',
      samples: LONG_TRACK_SAMPLES,
      fitBytes: fitBytes.byteLength,
      approximateLengthMeters: Math.round(longTrackLengthMeters()),
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
      loadAverageAtStart: loadAtStart,
      loadAverageAtEnd: loadavg().map((value) => Math.round(value * 100) / 100),
    },
    passed,
    // M2-01al: which attempt this is and, on the first, whether it is re-run and why.
    ...(attempt === null ? {} : { attempt }),
    checks,
    evaluation,
    samples: observations,
    summary: Object.fromEntries(
      Object.entries(observations).map(([id, values]) => {
        const sorted = values.map((sample) => sample.value).sort((a, b) => a - b);
        return [
          id,
          {
            n: sorted.length,
            min: sorted[0],
            p50: sorted[Math.ceil(0.5 * sorted.length) - 1],
            p95: sorted[Math.ceil(0.95 * sorted.length) - 1],
            max: sorted.at(-1),
          },
        ];
      }),
    ),
    details,
  });
  console.log(
    JSON.stringify({
      passed,
      // Repeat at an admissible load: a time budget was exceeded above the baseline's load.
      inconclusive:
        pair !== null ? pair.inconclusive : checksPassed && evaluation?.inconclusive === true,
      attempt: options.retryOf === null ? 1 : 2,
      ...(retry === null ? {} : { retry }),
      failedChecks: checks.filter((entry) => !entry.passed).map((entry) => entry.id),
      failedMetrics:
        evaluation?.metrics
          .filter((metric) => metric.verdict !== 'passed')
          .map((metric) => `${metric.id}:${metric.verdict}`) ?? [],
      out: repoRelative(repositoryRoot, options.outPath),
    }),
  );
  if (passed === false || (options.recordOnly && !checksPassed)) process.exitCode = 1;
  console.log(`process peak RSS ${mib(process.resourceUsage().maxRSS * 1024)} MiB`);
  if (retry?.retry === true) {
    console.log(
      `RETRY: the first attempt failed only time budgets (${retry.timeMetrics.join(', ')}); ` +
        `measuring every phase once more after ${RETRY_PAUSE_MS / 1000} s. The pair passes only if the re-run passes.`,
    );
    await new Promise((done) => setTimeout(done, RETRY_PAUSE_MS));
    process.exitCode = await startRetry(startedAt, logPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
