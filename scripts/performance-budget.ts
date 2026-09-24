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
 *   average of up to 124): a **time** budget that is exceeded while any of the metric's samples
 *   was taken above the highest load of that metric's own baseline
 *   (`baseline.loadAverage1m.max`) is `inconclusive`, not `failed`. The run must be repeated
 *   at an admissible load. Load only excuses a failure; it never turns one into a pass, and it
 *   never excuses memory or size metrics, which do not depend on CPU contention.
 * - Real-device budgets are `not_executed` with no numeric budget. Nothing here can turn one
 *   into `passed`: no desktop or Simulator sample is accepted for a real-device metric.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

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
      typeof load['max'] !== 'number'
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
    const aboveAdmissibleLoad =
      metric.unit === 'ms' && Math.max(...loads) > metric.baseline.loadAverage1m.max;
    const verdict: MetricVerdict =
      samples.length < metric.minimumSamples
        ? 'insufficient'
        : observed <= metric.budget
          ? 'passed'
          : aboveAdmissibleLoad
            ? 'inconclusive'
            : 'failed';
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
