/**
 * M2-01k-f: the performance budget and the one function that judges a measurement against it.
 *
 * The budget itself is data, checked in at docs/implementation/research/performance-budget.json.
 * Both budget probes — the server probe (scripts/probe-performance-budget.mts) and the browser
 * spec (tests/performance/long-track-render.spec.ts) — hand their samples to
 * {@link evaluateBudget}, so a budget is judged the same way wherever it was measured.
 *
 * Rules this module enforces, not just documents:
 *
 * - A budget is an upper bound on a stated statistic (p95, max) of repeated samples. A metric
 *   with fewer samples than its `minimumSamples` is `insufficient`, and a metric that was not
 *   observed at all is `missing`; neither counts as passed.
 * - Every sample carries the 1-minute load average at the moment it was taken. The machine is
 *   shared, so a number without its load is not evidence.
 * - Admissible load (rule added by M2-01k-f round 4, after judged run 3 failed under a load
 *   average of up to 124; narrowed by M2-01ai): when a **time** budget is exceeded, it is
 *   `failed` if the statistic still exceeds the budget with every sample taken above that
 *   metric's baseline load (`baseline.loadAverage1m.max`) counted as 0 ms, or if at least
 *   `minimumSamples` admissible samples exceed it on their own; otherwise it is
 *   `inconclusive` and the run must be repeated at an admissible load. Load only excuses a
 *   failure the loaded samples could explain; it never
 *   turns one into a pass, and it never excuses memory or size metrics, which do not depend
 *   on CPU contention.
 * - One disclosed re-run (M2-01al): a judged attempt that failed only time budgets, with every
 *   check and every memory and size budget met, is measured once more in full
 *   ({@link retryDecision}); the pair passes only if the re-run passes by itself
 *   ({@link combineAttempts}). The 1-minute load average lags a short burst, so the
 *   admissible-load rule alone cannot tell one from a regression.
 * - A budget's baseline is checked against the recorded baseline runs it names
 *   ({@link verifyBaselinesAgainstRuns}): its sample count, per-run statistics, statistic
 *   and load range must be what those runs' samples give.
 * - Real-device budgets are `not_executed` with no numeric budget. Nothing here can turn one
 *   into `passed`: no desktop or Simulator sample is accepted for a real-device metric.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type BudgetStatistic = 'p50' | 'p95' | 'max';
export type BudgetUnit = 'ms' | 'MiB' | 'bytes';
export type BudgetPhase = 'parse' | 'worker' | 'api' | 'engine' | 'browser';

export interface BudgetSample {
  readonly value: number;
  /** `os.loadavg()[0]` when the sample was taken. */
  readonly loadAverage1m: number;
}

export interface DesktopMetricBudget {
  readonly phase: BudgetPhase;
  readonly unit: BudgetUnit;
  readonly statistic: BudgetStatistic;
  /** The value the statistic may not exceed. */
  readonly budget: number;
  readonly minimumSamples: number;
  readonly description: string;
  readonly baseline: {
    readonly statisticValue: number;
    readonly samples: number;
    readonly runs: readonly string[];
    /** The statistic of each baseline run, in `runs` order; `statisticValue` is the worst. */
    readonly perRunStatistic?: readonly number[];
    readonly loadAverage1m: { readonly min: number; readonly max: number };
  };
  readonly headroom: { readonly factor: number; readonly reason: string };
}

export interface RealDeviceMetric {
  readonly status: 'not_executed';
  readonly budget: null;
  readonly description: string;
}

export interface PerformanceBudgetFile {
  readonly schemaVersion: 1;
  readonly desktop: {
    readonly label: string;
    readonly metrics: Readonly<Record<string, DesktopMetricBudget>>;
  };
  readonly realDevice: {
    readonly status: 'not_executed';
    readonly reason: string;
    readonly metrics: Readonly<Record<string, RealDeviceMetric>>;
  };
}

/** The smallest n whose nearest-rank p95 is not the sample maximum. */
export const MIN_P95_SAMPLES = 20;

export type MetricVerdict = 'passed' | 'failed' | 'inconclusive' | 'missing' | 'insufficient';

export interface MetricEvaluation {
  readonly id: string;
  readonly verdict: MetricVerdict;
  readonly statistic: BudgetStatistic;
  readonly observed: number | null;
  readonly budget: number;
  readonly unit: BudgetUnit;
  readonly samples: number;
  readonly loadAverage1m: { readonly min: number; readonly max: number } | null;
}

export interface BudgetEvaluation {
  /** True only when every evaluated desktop metric passed. */
  readonly passed: boolean;
  /**
   * True when the run did not pass only because of `inconclusive` metrics (a time budget
   * exceeded above the admissible load): repeat it at an admissible load. Never true together
   * with `passed`.
   */
  readonly inconclusive: boolean;
  readonly metrics: readonly MetricEvaluation[];
  /** Always `not_executed`: listed so a report can never omit them silently. */
  readonly realDevice: readonly { readonly id: string; readonly verdict: 'not_executed' }[];
}

export function sampleNow(value: number): BudgetSample {
  return { value, loadAverage1m: Math.round((loadavg()[0] ?? 0) * 100) / 100 };
}

/** Nearest-rank percentile: the smallest sample with at least `p` of the samples at or below it. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new RangeError('EMPTY_SAMPLE');
  if (!(p > 0 && p <= 1)) throw new RangeError('INVALID_PERCENTILE');
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index] as number;
}

export function statisticOf(values: readonly number[], statistic: BudgetStatistic): number {
  switch (statistic) {
    case 'p50':
      return percentile(values, 0.5);
    case 'p95':
      return percentile(values, 0.95);
    case 'max':
      return Math.max(...values);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Validates the checked-in budget file. Beyond shape, it refuses a desktop budget that sits
 * below its own baseline (it would fail on the numbers it was derived from), a headroom
 * factor that does not match the budget it claims to explain, a baseline without load, and a
 * real-device metric that carries a number.
 */
export function parseBudgetFile(value: unknown): PerformanceBudgetFile {
  if (!isRecord(value) || value['schemaVersion'] !== 1) throw new Error('BUDGET_SCHEMA_VERSION');
  const desktop = value['desktop'];
  const realDevice = value['realDevice'];
  if (!isRecord(desktop) || typeof desktop['label'] !== 'string' || !isRecord(desktop['metrics']))
    throw new Error('BUDGET_DESKTOP_INVALID');
  for (const [id, metric] of Object.entries(desktop['metrics'])) {
    if (!isRecord(metric)) throw new Error(`BUDGET_METRIC_INVALID:${id}`);
    const baseline = metric['baseline'];
    const headroom = metric['headroom'];
    if (
      !['parse', 'worker', 'api', 'engine', 'browser'].includes(String(metric['phase'])) ||
      !['ms', 'MiB', 'bytes'].includes(String(metric['unit'])) ||
      !['p50', 'p95', 'max'].includes(String(metric['statistic'])) ||
      !positive(metric['budget']) ||
      !Number.isInteger(metric['minimumSamples']) ||
      (metric['minimumSamples'] as number) < 1 ||
      typeof metric['description'] !== 'string' ||
      !isRecord(baseline) ||
      !isRecord(headroom)
    )
      throw new Error(`BUDGET_METRIC_INVALID:${id}`);
    const load = baseline['loadAverage1m'];
    if (
      !positive(baseline['statisticValue']) ||
      !Number.isInteger(baseline['samples']) ||
      (baseline['samples'] as number) < (metric['minimumSamples'] as number) ||
      !Array.isArray(baseline['runs']) ||
      baseline['runs'].length === 0 ||
      !isRecord(load) ||
      typeof load['min'] !== 'number' ||
      typeof load['max'] !== 'number' ||
      (baseline['perRunStatistic'] !== undefined &&
        (!Array.isArray(baseline['perRunStatistic']) ||
          baseline['perRunStatistic'].length !== baseline['runs'].length ||
          !baseline['perRunStatistic'].every(positive)))
    )
      throw new Error(`BUDGET_BASELINE_INVALID:${id}`);
    if (!positive(headroom['factor']) || typeof headroom['reason'] !== 'string')
      throw new Error(`BUDGET_HEADROOM_INVALID:${id}`);
    // Below 20 samples the nearest-rank p95 is the maximum, so a single outlier would decide
    // the budget by itself.
    if (metric['statistic'] === 'p95' && (metric['minimumSamples'] as number) < MIN_P95_SAMPLES)
      throw new Error(`BUDGET_P95_TOO_FEW_SAMPLES:${id}`);
    const budget = metric['budget'] as number;
    const expected = (baseline['statisticValue'] as number) * (headroom['factor'] as number);
    if (budget < (baseline['statisticValue'] as number))
      throw new Error(`BUDGET_BELOW_BASELINE:${id}`);
    // The budget is the baseline times the stated factor, rounded up to a round number of
    // at most 10 % above it. Anything else means the factor does not explain the number.
    if (budget < expected || budget > Math.ceil(expected * 1.1))
      throw new Error(`BUDGET_HEADROOM_MISMATCH:${id}`);
  }
  if (
    !isRecord(realDevice) ||
    realDevice['status'] !== 'not_executed' ||
    typeof realDevice['reason'] !== 'string' ||
    !isRecord(realDevice['metrics'])
  )
    throw new Error('BUDGET_REAL_DEVICE_INVALID');
  for (const [id, metric] of Object.entries(realDevice['metrics']))
    if (!isRecord(metric) || metric['status'] !== 'not_executed' || metric['budget'] !== null)
      throw new Error(`BUDGET_REAL_DEVICE_METRIC_INVALID:${id}`);
  return value as unknown as PerformanceBudgetFile;
}

/** One run as a result file records it (the latest run, or an entry of `previousRuns`). */
export interface RecordedRun {
  readonly executedAt: string;
  readonly mode: string;
  readonly samples: Readonly<Record<string, readonly BudgetSample[]>>;
}

/** Every run a result file records: the latest one and its `previousRuns`. */
export function recordedRuns(result: unknown): RecordedRun[] {
  if (!isRecord(result)) throw new Error('RESULT_INVALID');
  const { previousRuns = [], ...latest } = result;
  if (!Array.isArray(previousRuns)) throw new Error('RESULT_INVALID');
  return [latest, ...(previousRuns as unknown[])].map((run) => {
    if (
      !isRecord(run) ||
      typeof run['executedAt'] !== 'string' ||
      typeof run['mode'] !== 'string' ||
      !isRecord(run['samples'])
    )
      throw new Error('RESULT_RUN_INVALID');
    return run as unknown as RecordedRun;
  });
}

/**
 * Re-derives every desktop baseline from the recorded runs it names and refuses any that
 * does not follow (M2-01ai, N-h). `parseBudgetFile` can check a budget against its own
 * baseline; only the recorded samples can say whether the baseline itself — and with it the
 * admissible load, `baseline.loadAverage1m.max` — is what was measured.
 *
 * For each metric, each run in `baseline.runs` must be exactly one recorded **record-only**
 * run (a judged run cannot be its own baseline) holding at least `minimumSamples` samples of
 * the metric. From those samples: the count must equal `baseline.samples`, the load range
 * must equal `baseline.loadAverage1m`, each run's statistic must equal `perRunStatistic`,
 * and the worst of them must equal `statisticValue`.
 */
export function verifyBaselinesAgainstRuns(
  budget: PerformanceBudgetFile,
  runs: readonly RecordedRun[],
): void {
  for (const [id, metric] of Object.entries(budget.desktop.metrics)) {
    const perRun: number[] = [];
    const loads: number[] = [];
    for (const executedAt of metric.baseline.runs) {
      const matching = runs.filter((run) => run.executedAt === executedAt);
      if (matching.length !== 1) throw new Error(`BASELINE_RUN_NOT_RECORDED:${id}:${executedAt}`);
      const [run] = matching as [RecordedRun];
      if (!run.mode.startsWith('record-only'))
        throw new Error(`BASELINE_RUN_NOT_RECORD_ONLY:${id}:${executedAt}`);
      const samples = run.samples[id] ?? [];
      if (samples.length < metric.minimumSamples)
        throw new Error(`BASELINE_RUN_TOO_FEW_SAMPLES:${id}:${executedAt}`);
      perRun.push(
        statisticOf(
          samples.map((sample) => sample.value),
          metric.statistic,
        ),
      );
      loads.push(...samples.map((sample) => sample.loadAverage1m));
    }
    if (loads.length !== metric.baseline.samples)
      throw new Error(`BASELINE_SAMPLES_MISMATCH:${id}`);
    if (
      Math.min(...loads) !== metric.baseline.loadAverage1m.min ||
      Math.max(...loads) !== metric.baseline.loadAverage1m.max
    )
      throw new Error(`BASELINE_LOAD_MISMATCH:${id}`);
    if (
      metric.baseline.perRunStatistic !== undefined &&
      (metric.baseline.perRunStatistic.length !== perRun.length ||
        metric.baseline.perRunStatistic.some((value, index) => value !== perRun[index]))
    )
      throw new Error(`BASELINE_PER_RUN_MISMATCH:${id}`);
    if (Math.max(...perRun) !== metric.baseline.statisticValue)
      throw new Error(`BASELINE_STATISTIC_MISMATCH:${id}`);
  }
}

/**
 * The verdict for a metric whose statistic over all of its samples exceeded the budget.
 *
 * Decision (M2-01ai, N-g, tightened after review NB-1): a loaded sample may excuse only an
 * excess it can explain.
 *
 * - Memory and size budgets do not depend on CPU contention: `failed`, whatever the load.
 * - A time budget, where "loaded" means taken above the metric's own admissible load
 *   (`baseline.loadAverage1m.max`), is `failed` when either
 *   - **best case over all samples:** the statistic still exceeds the budget with every loaded
 *     sample replaced by the best value it could have had (0 ms). The full n is kept, so one
 *     loaded sample in the default 20 cannot drop the run below `minimumSamples` and hide
 *     an excess; or
 *   - **admissible samples alone:** there are at least `minimumSamples` of them and their own
 *     statistic exceeds the budget.
 *
 *   Otherwise it is `inconclusive`: the loaded samples could account for the excess, and the
 *   run must be repeated at an admissible load.
 *
 * Until M2-01ai any single sample above the admissible load made an exceeded time budget
 * `inconclusive`. Load still never makes a pass: this function is reached only when the
 * statistic over *all* samples is over budget, and a run with an inconclusive metric does
 * not pass.
 */
function exceededVerdict(
  metric: DesktopMetricBudget,
  samples: readonly BudgetSample[],
): 'failed' | 'inconclusive' {
  if (metric.unit !== 'ms') return 'failed';
  const admissibleLoad = metric.baseline.loadAverage1m.max;
  const bestCase = samples.map((sample) =>
    sample.loadAverage1m <= admissibleLoad ? sample.value : 0,
  );
  if (statisticOf(bestCase, metric.statistic) > metric.budget) return 'failed';
  const admissible = samples
    .filter((sample) => sample.loadAverage1m <= admissibleLoad)
    .map((sample) => sample.value);
  if (admissible.length < metric.minimumSamples) return 'inconclusive';
  return statisticOf(admissible, metric.statistic) > metric.budget ? 'failed' : 'inconclusive';
}

/**
 * Judges the observed samples against the desktop budgets of the given phases.
 *
 * `observations` maps a metric id to its samples. Ids that are not desktop budgets are
 * refused rather than ignored: a sample offered for a real-device metric, or a typo, must not
 * vanish from the verdict.
 */
export function evaluateBudget(
  budget: PerformanceBudgetFile,
  observations: Readonly<Record<string, readonly BudgetSample[]>>,
  phases: readonly BudgetPhase[],
): BudgetEvaluation {
  for (const id of Object.keys(observations)) {
    if (id in budget.realDevice.metrics) throw new Error(`REAL_DEVICE_METRIC_NOT_MEASURABLE:${id}`);
    if (!(id in budget.desktop.metrics)) throw new Error(`UNKNOWN_METRIC:${id}`);
  }
  const metrics: MetricEvaluation[] = [];
  for (const [id, metric] of Object.entries(budget.desktop.metrics)) {
    if (!phases.includes(metric.phase)) continue;
    const samples = observations[id] ?? [];
    const loads = samples.map((sample) => sample.loadAverage1m);
    const base = {
      id,
      statistic: metric.statistic,
      budget: metric.budget,
      unit: metric.unit,
      samples: samples.length,
      loadAverage1m:
        loads.length === 0 ? null : { min: Math.min(...loads), max: Math.max(...loads) },
    };
    if (samples.length === 0) {
      metrics.push({ ...base, verdict: 'missing', observed: null });
      continue;
    }
    const values = samples.map((sample) => sample.value);
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`NON_FINITE_SAMPLE:${id}`);
    const observed = statisticOf(values, metric.statistic);
    const verdict: MetricVerdict =
      samples.length < metric.minimumSamples
        ? 'insufficient'
        : observed <= metric.budget
          ? 'passed'
          : exceededVerdict(metric, samples);
    metrics.push({ ...base, verdict, observed });
  }
  const passed = metrics.length > 0 && metrics.every((metric) => metric.verdict === 'passed');
  return {
    passed,
    inconclusive:
      !passed &&
      metrics.some((metric) => metric.verdict === 'inconclusive') &&
      metrics.every((metric) => metric.verdict === 'passed' || metric.verdict === 'inconclusive'),
    metrics,
    realDevice: Object.keys(budget.realDevice.metrics).map((id) => ({
      id,
      verdict: 'not_executed' as const,
    })),
  };
}

// ---------------------------------------------------------------- one disclosed re-run (M2-01al)

/**
 * A judged run is measured at most this many times: the first attempt and one re-run.
 *
 * Why a re-run and not a finer load reading (M2-01al (b)). The 1-minute load average is an
 * exponential average; it lags a short contention burst by tens of seconds, and reading it
 * more often reads the same lagging number. In the M2-01aj reviewer's run (2026-09-25T01:16Z)
 * the first seven `worker.parseMs` samples were 883–1,511 ms at load 13.73–17.92, the load
 * rose to 21.61 only once the parses were back at 440–480 ms, and it never passed the metric's
 * admissible 23.21: no load reading taken at, or even after, those samples would have told
 * them apart from an admissible-load regression. So the admissible-load rule stays as it is,
 * and a first attempt that failed **only time budgets** is measured once more, in full.
 */
export const MAX_JUDGED_ATTEMPTS = 2;

export type RetryDecision =
  | { readonly retry: true; readonly timeMetrics: readonly string[] }
  | { readonly retry: false; readonly reason: string };

/**
 * Whether judged attempt number `attempt` (1-based) may be measured once more: only when every
 * check passed and every metric that did not pass is a time budget (`ms`) that was `failed` or
 * `inconclusive`. A memory or size metric that did not pass, a `missing` or `insufficient`
 * metric, or a failed check is never re-run: CPU contention cannot explain it. Never after the
 * last attempt.
 */
export function retryDecision(
  evaluation: BudgetEvaluation,
  checksPassed: boolean,
  attempt: number,
): RetryDecision {
  if (attempt >= MAX_JUDGED_ATTEMPTS) return { retry: false, reason: 'no attempt left' };
  if (!checksPassed) return { retry: false, reason: 'a check failed' };
  if (evaluation.passed) return { retry: false, reason: 'passed' };
  const notPassed = evaluation.metrics.filter((metric) => metric.verdict !== 'passed');
  const refused = notPassed.filter(
    (metric) =>
      metric.unit !== 'ms' || (metric.verdict !== 'failed' && metric.verdict !== 'inconclusive'),
  );
  if (notPassed.length === 0 || refused.length > 0)
    return {
      retry: false,
      reason: `not only time budgets: ${
        refused.map((metric) => `${metric.id}:${metric.verdict}`).join(', ') || 'none judged'
      }`,
    };
  return { retry: true, timeMetrics: notPassed.map((metric) => metric.id) };
}

export interface JudgedAttempt {
  readonly evaluation: BudgetEvaluation;
  readonly checksPassed: boolean;
}

/**
 * The verdict of a run that was measured twice. The re-run is a whole new measurement judged
 * by the unchanged evaluator, and it has to pass by itself: every budget of every phase and
 * every check. So the pair passes only when
 *
 * - the first attempt was eligible ({@link retryDecision}): it failed only time budgets, and
 *   every memory and size budget and every check passed in it; and
 * - the second attempt passed completely.
 *
 * A memory or size metric is therefore met in both attempts, never excused by the re-run. A
 * regression present in both attempts fails. When the pair does not pass it is `inconclusive`
 * only if both attempts were (loaded samples could explain both); a time budget `failed` at an
 * admissible load in either attempt keeps it `failed`.
 */
export function combineAttempts(
  first: JudgedAttempt,
  second: JudgedAttempt,
): { readonly passed: boolean; readonly inconclusive: boolean } {
  if (!retryDecision(first.evaluation, first.checksPassed, 1).retry)
    return { passed: false, inconclusive: false };
  if (second.checksPassed && second.evaluation.passed) return { passed: true, inconclusive: false };
  return {
    passed: false,
    inconclusive:
      first.evaluation.inconclusive && second.checksPassed && second.evaluation.inconclusive,
  };
}

// ---------------------------------------------------------------- where output may go (M2-01al)

/**
 * Directories a tool empties on its own: Playwright clears `test-results/` (its output
 * directory) when it starts and rewrites `playwright-report/`; Vitest's coverage run clears
 * `coverage/`. The probe logs of M2-01ai and M2-01aj were lost that way. Neither a result nor
 * a log may be written under one of them inside the repository.
 */
export const WIPED_OUTPUT_DIRECTORIES = ['test-results', 'playwright-report', 'coverage'] as const;

/** Ignored by git and Prettier and emptied by no tool: probe and verification logs go here. */
export const VERIFICATION_LOG_DIRECTORY = 'verification-logs';

/**
 * `path` with its nearest existing ancestor resolved through symbolic links (`realpathSync`)
 * and the not-yet-existing rest appended, so a link such as `verification-logs/x ->
 * ../test-results` is judged by where it leads.
 */
function realOutputPath(path: string): string {
  const missing: string[] = [];
  let existing = path;
  // Bounded (path segments plus links followed), so a cycle of dangling links cannot spin.
  for (let hops = 0; hops < 256; hops += 1) {
    try {
      return join(realpathSync(existing), ...missing.reverse());
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) return path;
      // A dangling link (its target not created yet) is followed to where it will write.
      let link: string | null = null;
      try {
        if (lstatSync(existing).isSymbolicLink()) link = readlinkSync(existing);
      } catch {
        link = null;
      }
      if (link !== null) existing = resolve(parent, link);
      else {
        missing.push(basename(existing));
        existing = parent;
      }
    }
  }
  // Refused rather than guessed: a path that cannot be resolved is not shown to be durable.
  throw new Error(`OUTPUT_PATH_UNRESOLVABLE: ${path}`);
}

/**
 * Resolves an output path against the repository and refuses one inside it that lies under a
 * {@link WIPED_OUTPUT_DIRECTORIES} directory, at any depth. Segments are compared without
 * case (APFS and the default macOS volume are case-insensitive, so `Test-Results/` is
 * `test-results/`), and symbolic links are followed first (review N3).
 */
export function assertDurableOutputPath(repositoryRoot: string, path: string): string {
  const absolute = resolve(repositoryRoot, path);
  const root = realOutputPath(resolve(repositoryRoot));
  const inside = relative(root, realOutputPath(absolute));
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return absolute;
  const wiped = inside
    .split(sep)
    .find((segment) =>
      (WIPED_OUTPUT_DIRECTORIES as readonly string[]).includes(segment.toLowerCase()),
    );
  if (wiped !== undefined)
    throw new Error(
      `OUTPUT_PATH_WIPED_BY_TOOL: ${inside} lies under ${wiped}/, which a tool empties; use ${VERIFICATION_LOG_DIRECTORY}/`,
    );
  return absolute;
}

// ---------------------------------------------------------------- parse process RSS coverage (M2-01al)

export const PARSE_PROCESS_RSS_CHECK = 'worker-parse-process-rss-read-every-parse';

/**
 * M2-01al (a): the RSS of every parse measured for `worker.parseProcessPeakRssMiB` must have
 * been read. `minimumSamples` (5) alone would let a run judge the budget on 5 readings of 20
 * parses; a parse whose RSS was never read has an unknown peak, not one within budget.
 */
export function parseProcessRssCheck(
  parses: number,
  parsesWithoutReading: number,
): { readonly id: string; readonly passed: boolean; readonly detail: string } {
  return {
    id: PARSE_PROCESS_RSS_CHECK,
    passed: parses > 0 && parsesWithoutReading === 0,
    detail: `${parses - parsesWithoutReading} of ${parses} parses had their RSS read (${parsesWithoutReading} without a reading)`,
  };
}

/** One line per metric, for a console and a progress document. */
export function describeEvaluation(evaluation: BudgetEvaluation): string {
  return evaluation.metrics
    .map(
      (metric) =>
        `${metric.verdict.toUpperCase().padEnd(12)} ${metric.id}: ${metric.statistic} ${
          metric.observed ?? '-'
        } ${metric.unit} <= ${metric.budget} (n=${metric.samples}, load ${
          metric.loadAverage1m ? `${metric.loadAverage1m.min}-${metric.loadAverage1m.max}` : '-'
        })`,
    )
    .join('\n');
}

/**
 * Writes a run report and keeps every earlier run under `previousRuns`, so baseline runs, the
 * judged run and controlled failures all stay in the checked-in record.
 */
export async function writeResultWithHistory(
  path: string,
  report: Readonly<Record<string, unknown>>,
): Promise<void> {
  const previousRuns: unknown[] = [];
  try {
    const previous = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const { previousRuns: history = [], ...lastRun } = previous;
    if (Array.isArray(history)) previousRuns.push(...(history as unknown[]));
    previousRuns.push(lastRun);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...report, previousRuns }, null, 2)}\n`, {
    flag: 'wx',
  });
  await rename(temporary, path);
}

/**
 * A path as it may appear in a checked-in record: relative to the repository, or only its
 * file name when it lies outside. Never an absolute path, which would carry the user's home
 * directory or a temporary directory into the repository.
 */
export function repoRelative(repositoryRoot: string, path: string): string {
  const inside = relative(repositoryRoot, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
    ? inside
    : `<outside-repository>/${basename(path)}`;
}

export interface SourceTreeState {
  readonly head: string;
  /**
   * Changed, staged, untracked, renamed or deleted paths among the scanned paths (packages/,
   * apps/, scripts/, tests/ and the root workspace files). Both sides of a rename are listed.
   */
  readonly dirtyPaths: readonly string[];
  /**
   * SHA-256 over `git diff HEAD --binary` of those directories plus every untracked file's
   * path and bytes: the identity of the uncommitted change the run measured, comparable with
   * a reviewed tree. `null` when the tree is clean.
   */
  readonly diffSha256: string | null;
  readonly allowDirtyReason: string | null;
  readonly allowedProductPaths: readonly string[];
}

/**
 * What the guard scans and hashes. packages/ and apps/ hold product code; scripts/ and tests/
 * hold the probes, the browser spec and its helpers; the root files decide how the workspace
 * is installed, built and run (Playwright configs included). Only {@link isProductPath} paths
 * need to be named; everything else here needs a reason and is hashed.
 */
const MEASURED_DIRECTORIES = [
  'packages',
  'apps',
  'scripts',
  'tests',
  'playwright*.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig*.json',
] as const;
/** Test and fixture paths: a directory named test(s), __tests__ or fixtures, or a *.test.* / *.spec.* file. */
const TEST_OR_FIXTURE = /(^|\/)(tests?|__tests__|fixtures)\/|\.(test|spec)\.[^/]+$/;

/**
 * Product code is everything under packages/ and apps/ that is not a test or a fixture:
 * `src/`, but also Next `app/` routes, SQL migrations, configuration and public assets. A
 * mutant can live in any of them, and the probe runs all of them (the API phase applies the
 * migrations to a real PostgreSQL; the browser spec loads the shells' pages).
 */
export function isProductPath(path: string): boolean {
  return /^(packages|apps)\//.test(path) && !TEST_OR_FIXTURE.test(path);
}

interface StatusEntry {
  readonly code: string;
  readonly paths: readonly string[];
}

/**
 * `git status --porcelain=v1 -z`: NUL-separated, paths never quoted, and a rename or copy
 * carries its original path as the next field. Line-based parsing would keep the quotes
 * around a path with a space or a non-ASCII character and read `R  a -> b` as one path.
 */
export function parseStatusZ(output: string): StatusEntry[] {
  const fields = output.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? '';
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.includes('R') || code.includes('C')) {
      index += 1;
      entries.push({ code, paths: [path, fields[index] ?? ''] });
    } else entries.push({ code, paths: [path] });
  }
  return entries;
}

/**
 * Refuses to measure a tree that differs from HEAD, so a leftover mutant (M2-01k-f §4.1)
 * cannot silently become a baseline or a judged run. Untracked files count.
 *
 * - Any difference in the scanned paths (packages/, apps/, scripts/, tests/ and the root
 *   workspace and Playwright files) needs an explicit `allowDirtyReason`
 *   (a node's own probe and tests before they are committed).
 * - A difference in product code ({@link isProductPath}: everything under packages/ and apps/
 *   except tests and fixtures) is refused unless that exact path is listed in
 *   `allowedProductPaths`: the person running the probe has to name every product file they
 *   intend to be changed, and a mutant left in any other file stops the run.
 * - The dirty paths and a hash of the whole difference are returned to be recorded, so the
 *   measured tree can be compared with the reviewed one.
 *
 * It checks source, not build output: a stale `.next` or Vite `dist` is the caller's to rebuild.
 */
export function assertMeasurableSourceTree(
  repositoryRoot: string,
  allowDirtyReason: string | null,
  allowedProductPaths: readonly string[] = [],
): SourceTreeState {
  const run = (args: readonly string[]) =>
    execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  const head = run(['rev-parse', 'HEAD']).trim();
  const entries = parseStatusZ(
    run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...MEASURED_DIRECTORIES]),
  );
  const dirtyPaths = [...new Set(entries.flatMap((entry) => entry.paths))].sort();
  const unexpected = dirtyPaths.filter(
    (path) => isProductPath(path) && !allowedProductPaths.includes(path),
  );
  if (unexpected.length > 0)
    throw new Error(
      `SOURCE_TREE_MUTATED: product code differs from HEAD: ${unexpected.join(', ')}`,
    );
  if (dirtyPaths.length > 0 && allowDirtyReason === null)
    throw new Error(
      `SOURCE_TREE_DIRTY: ${dirtyPaths.join(', ')} (pass an explicit reason to record anyway)`,
    );
  let diffSha256: string | null = null;
  if (dirtyPaths.length > 0) {
    const hash = createHash('sha256');
    hash.update(run(['diff', 'HEAD', '--binary', '--', ...MEASURED_DIRECTORIES]));
    const untracked = entries
      .filter((entry) => entry.code === '??')
      .flatMap((entry) => entry.paths)
      .sort();
    for (const path of untracked) {
      hash.update(`\0${path}\0`);
      hash.update(readFileSync(join(repositoryRoot, path)));
    }
    diffSha256 = hash.digest('hex');
  }
  return {
    head,
    dirtyPaths,
    diffSha256,
    allowDirtyReason: dirtyPaths.length > 0 ? allowDirtyReason : null,
    allowedProductPaths: [...allowedProductPaths].sort(),
  };
}
