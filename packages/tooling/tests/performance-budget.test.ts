import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertDurableOutputPath,
  assertMeasurableSourceTree,
  combineAttempts,
  evaluateBudget,
  PARSE_PROCESS_RSS_CHECK,
  parseBudgetFile,
  parseProcessRssCheck,
  percentile,
  recordedRuns,
  repoRelative,
  retryDecision,
  runContext,
  VERIFICATION_LOG_DIRECTORY,
  verifyBaselinesAgainstRuns,
  WIPED_OUTPUT_DIRECTORIES,
  type BudgetEvaluation,
  type BudgetSample,
  type PerformanceBudgetFile,
} from '../../../scripts/performance-budget';

/**
 * M2-01k-f. The measurement itself is a separate, opt-in step (the probe and the browser
 * spec); what runs here is the judgement: the evaluator both of them use, and the
 * consistency of the checked-in budget with the evidence it was derived from.
 */
const research = (name: string) =>
  fileURLToPath(new URL(`../../../docs/implementation/research/${name}`, import.meta.url));

const samples = (values: readonly number[], load = 20): BudgetSample[] =>
  values.map((value) => ({ value, loadAverage1m: load }));

function budgetWith(
  metrics: Record<
    string,
    {
      budget: number;
      statistic?: 'p95' | 'max';
      minimumSamples?: number;
      unit?: 'ms' | 'MiB' | 'bytes';
    }
  >,
): PerformanceBudgetFile {
  return parseBudgetFile({
    schemaVersion: 1,
    desktop: {
      label: 'unit fixture',
      metrics: Object.fromEntries(
        Object.entries(metrics).map(([id, metric]) => [
          id,
          {
            phase: 'parse',
            unit: metric.unit ?? 'ms',
            statistic: metric.statistic ?? 'max',
            budget: metric.budget,
            minimumSamples: metric.minimumSamples ?? (metric.statistic === 'p95' ? 20 : 5),
            description: 'fixture',
            baseline: {
              statisticValue: metric.budget / 2,
              samples: 40,
              runs: ['fixture'],
              loadAverage1m: { min: 10, max: 30 },
            },
            headroom: { factor: 2, reason: 'fixture' },
          },
        ]),
      ),
    },
    realDevice: {
      status: 'not_executed',
      reason: 'fixture',
      metrics: { 'device.renderMs': { status: 'not_executed', budget: null, description: 'x' } },
    },
  });
}

describe('percentile', () => {
  it('is nearest-rank: p95 of up to 20 samples is the maximum, p50 the lower middle', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(twenty, 0.95)).toBe(19);
    expect(() => percentile([], 0.95)).toThrow('EMPTY_SAMPLE');
  });
});

describe('evaluateBudget', () => {
  const budget = budgetWith({ 'parse.a': { budget: 100 }, 'parse.b': { budget: 10 } });

  it('passes at the budget and fails one unit above it', () => {
    const at = evaluateBudget(
      budget,
      { 'parse.a': samples([40, 60, 100, 80, 70]), 'parse.b': samples([10, 1, 2, 3, 4]) },
      ['parse'],
    );
    expect(at.passed).toBe(true);
    const over = evaluateBudget(
      budget,
      { 'parse.a': samples([40, 60, 101, 80, 70]), 'parse.b': samples([10, 1, 2, 3, 4]) },
      ['parse'],
    );
    expect(over.passed).toBe(false);
    expect(over.metrics.find((metric) => metric.id === 'parse.a')).toMatchObject({
      verdict: 'failed',
      observed: 101,
    });
  });

  it('never passes a metric that was not observed or has too few samples', () => {
    const missing = evaluateBudget(budget, { 'parse.a': samples([1, 1, 1, 1, 1]) }, ['parse']);
    expect(missing.passed).toBe(false);
    expect(missing.metrics.find((metric) => metric.id === 'parse.b')?.verdict).toBe('missing');
    const few = evaluateBudget(
      budget,
      { 'parse.a': samples([1, 1, 1, 1]), 'parse.b': samples([1, 1, 1, 1, 1]) },
      ['parse'],
    );
    expect(few.passed).toBe(false);
    expect(few.metrics.find((metric) => metric.id === 'parse.a')?.verdict).toBe('insufficient');
    // No phase selected is no evidence at all, not a vacuous pass.
    expect(evaluateBudget(budget, {}, ['browser']).passed).toBe(false);
  });

  it('keeps the load average of the samples it judged', () => {
    const judged = evaluateBudget(
      budget,
      { 'parse.a': samples([1, 1, 1, 1, 1], 31.5), 'parse.b': samples([1, 1, 1, 1, 1], 12) },
      ['parse'],
    );
    expect(judged.metrics.find((metric) => metric.id === 'parse.a')?.loadAverage1m).toEqual({
      min: 31.5,
      max: 31.5,
    });
  });

  it('refuses a sample offered for a real-device metric, and lists those as not_executed', () => {
    expect(() =>
      evaluateBudget(budget, { 'device.renderMs': samples([1, 1, 1, 1, 1]) }, ['parse']),
    ).toThrow('REAL_DEVICE_METRIC_NOT_MEASURABLE');
    expect(() =>
      evaluateBudget(budget, { 'parse.typo': samples([1, 1, 1, 1, 1]) }, ['parse']),
    ).toThrow('UNKNOWN_METRIC');
    expect(evaluateBudget(budget, {}, ['parse']).realDevice).toEqual([
      { id: 'device.renderMs', verdict: 'not_executed' },
    ]);
  });
});

describe('p95 budgets', () => {
  it('require at least 20 samples, the smallest n whose nearest-rank p95 is not the maximum', () => {
    expect(() => budgetWith({ 'parse.p': { budget: 100, statistic: 'p95' } })).not.toThrow();
    expect(() =>
      budgetWith({ 'parse.p': { budget: 100, statistic: 'p95', minimumSamples: 19 } }),
    ).toThrow('BUDGET_P95_TOO_FEW_SAMPLES');
  });

  it('are not decided by one outlier in 20 samples, but are by two', () => {
    const budget = budgetWith({ 'parse.p': { budget: 100, statistic: 'p95' } });
    const quiet = Array.from({ length: 19 }, () => 50);
    expect(evaluateBudget(budget, { 'parse.p': samples([...quiet, 900]) }, ['parse']).passed).toBe(
      true,
    );
    expect(
      evaluateBudget(budget, { 'parse.p': samples([...quiet.slice(1), 900, 900]) }, ['parse'])
        .passed,
    ).toBe(false);
  });
});

describe('admissible load', () => {
  const budget = budgetWith({
    'parse.time': { budget: 100 },
    'parse.memory': { budget: 100, unit: 'MiB' },
  });
  const within = samples([90, 90, 90, 90, 90], 20);

  it('makes a time budget exceeded above the baseline load inconclusive, not failed', () => {
    const loaded = evaluateBudget(
      budget,
      { 'parse.time': samples([90, 90, 90, 90, 150], 31), 'parse.memory': within },
      ['parse'],
    );
    expect(loaded.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe(
      'inconclusive',
    );
    expect(loaded.passed).toBe(false);
    expect(loaded.inconclusive).toBe(true);
  });

  it('fails the same excess at an admissible load, and never excuses memory', () => {
    const calm = evaluateBudget(
      budget,
      { 'parse.time': samples([90, 90, 90, 90, 150], 30), 'parse.memory': within },
      ['parse'],
    );
    expect(calm.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe('failed');
    expect(calm.inconclusive).toBe(false);
    const memory = evaluateBudget(
      budget,
      { 'parse.time': within, 'parse.memory': samples([90, 90, 90, 90, 150], 99) },
      ['parse'],
    );
    expect(memory.metrics.find((metric) => metric.id === 'parse.memory')?.verdict).toBe('failed');
    expect(memory.inconclusive).toBe(false);
  });

  // M2-01ai (N-g): the admissible-load samples are judged on their own. These cases tell that
  // design apart from the M2-01k-f one, where any one sample above the admissible load made
  // an exceeded time budget inconclusive.
  it('does not let one loaded sample hide a failure the admissible samples show by themselves', () => {
    const oneLoaded = evaluateBudget(
      budget,
      {
        'parse.time': [...samples([150, 150, 150, 150, 150], 20), ...samples([150], 99)],
        'parse.memory': within,
      },
      ['parse'],
    );
    expect(oneLoaded.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe('failed');
    expect(oneLoaded.inconclusive).toBe(false);
  });

  it('is inconclusive when the admissible samples alone meet the budget', () => {
    // The excess is the loaded sample's: judged without it, the metric is within budget.
    const loadedExcess = evaluateBudget(
      budget,
      {
        'parse.time': [...samples([90, 90, 90, 90, 90], 20), ...samples([150], 99)],
        'parse.memory': within,
      },
      ['parse'],
    );
    expect(loadedExcess.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe(
      'inconclusive',
    );
    expect(loadedExcess.passed).toBe(false);
    expect(loadedExcess.inconclusive).toBe(true);
  });

  describe('at the default 20 samples of a p95 budget', () => {
    const p95 = budgetWith({ 'parse.p95': { budget: 100, statistic: 'p95' } });
    const verdict = (observed: BudgetSample[]) =>
      evaluateBudget(p95, { 'parse.p95': observed }, ['parse']).metrics[0]?.verdict;

    it('fails 3x the budget even when one of the 20 samples was loaded (review NB-1)', () => {
      // 19 admissible samples are fewer than minimumSamples (20), so judging the admissible
      // samples alone could not decide it. Counted at its best case (0 ms), the loaded sample
      // leaves the p95 of all 20 at 300: the excess is not the loaded sample's.
      expect(verdict([...samples(Array(19).fill(300), 20), ...samples([300], 99)])).toBe('failed');
    });

    it('is inconclusive when too few admissible samples remain and the loaded ones explain the excess', () => {
      // 18 admissible at 50 and one at 150, two loaded at 150: p95 over all 21 is 150. At
      // their best case the loaded samples give a p95 of 50, and 19 admissible samples are
      // too few to judge alone.
      expect(
        verdict([...samples([...Array(18).fill(50), 150], 20), ...samples([150, 150], 99)]),
      ).toBe('inconclusive');
    });
  });

  it('takes the admissible load from the baseline maximum, not its minimum', () => {
    // Load 20 lies between the fixture baseline's minimum (10) and maximum (30): admissible.
    const between = evaluateBudget(
      budget,
      { 'parse.time': samples([150, 150, 150, 150, 150], 20), 'parse.memory': within },
      ['parse'],
    );
    expect(between.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe('failed');
  });

  it('never turns load into a pass, and a real failure keeps the run from being inconclusive', () => {
    // Within budget under heavy load is simply passed.
    expect(
      evaluateBudget(
        budget,
        { 'parse.time': samples([90, 90, 90, 90, 90], 99), 'parse.memory': within },
        ['parse'],
      ).passed,
    ).toBe(true);
    // One inconclusive time metric next to a real memory failure: the run failed.
    const mixed = evaluateBudget(
      budget,
      {
        'parse.time': samples([150, 150, 150, 150, 150], 99),
        'parse.memory': samples([150, 150, 150, 150, 150], 20),
      },
      ['parse'],
    );
    expect(mixed.passed).toBe(false);
    expect(mixed.inconclusive).toBe(false);
  });
});

describe('parseBudgetFile', () => {
  const valid = JSON.parse(JSON.stringify(budgetWith({ 'parse.a': { budget: 100 } }))) as {
    desktop: { metrics: Record<string, Record<string, unknown>> };
    realDevice: { metrics: Record<string, Record<string, unknown>> };
  };
  const mutate = (change: (copy: typeof valid) => void) => {
    const copy = JSON.parse(JSON.stringify(valid)) as typeof valid;
    change(copy);
    return () => parseBudgetFile(copy);
  };

  it('refuses a budget below its own baseline or unexplained by its headroom factor', () => {
    expect(
      mutate((copy) => {
        (copy.desktop.metrics['parse.a'] as { budget: number }).budget = 40;
      }),
    ).toThrow('BUDGET_BELOW_BASELINE');
    expect(
      mutate((copy) => {
        (copy.desktop.metrics['parse.a'] as { budget: number }).budget = 400;
      }),
    ).toThrow('BUDGET_HEADROOM_MISMATCH');
  });

  it('refuses a real-device metric that carries a number', () => {
    expect(
      mutate((copy) => {
        (copy.realDevice.metrics['device.renderMs'] as { budget: unknown }).budget = 500;
      }),
    ).toThrow('BUDGET_REAL_DEVICE_METRIC_INVALID');
  });
});

describe('repoRelative', () => {
  it('keeps a path inside the repository relative and hides one outside it', () => {
    expect(repoRelative('/repo', '/repo/docs/a.json')).toBe('docs/a.json');
    expect(repoRelative('/repo', '/tmp/x/budget.json')).toBe('<outside-repository>/budget.json');
    expect(repoRelative('/repo', '/repo')).toBe('<outside-repository>/repo');
  });
});

describe('assertMeasurableSourceTree', () => {
  /** A throwaway repository with product code in src/, a Next app/ route and a migration. */
  function fixtureRepository() {
    const root = mkdtempSync(join(tmpdir(), 'budget-tree-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    const write = (path: string, content: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'fixture');
    write('packages/kit/src/a.ts', 'export const a = 1;\n');
    write('packages/kit/tests/a.test.ts', 'export {};\n');
    write('apps/web/app/activities/page.tsx', 'export default function Page() {}\n');
    write('packages/server/persistence/migrations/001_foundation.sql', 'SELECT 1;\n');
    write('scripts/old-name.mts', 'export {};\n');
    write('tests/performance/render.spec.ts', 'export {};\n');
    write('playwright.performance.config.ts', 'export default {};\n');
    write('package.json', '{}\n');
    write('pnpm-workspace.yaml', 'packages: []\n');
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('turbo.json', '{}\n');
    write('tsconfig.base.json', '{}\n');
    write('docs/notes.md', 'notes\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    return { root, git, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('refuses a changed or untracked file unless allowed, and records what it measured', () => {
    const { root, write, cleanup } = fixtureRepository();
    try {
      const clean = assertMeasurableSourceTree(root, null);
      expect(clean.dirtyPaths).toEqual([]);
      expect(clean.diffSha256).toBeNull();

      // An untracked probe script: refused without a reason, recorded with one.
      write('scripts/probe.mts', 'export {};\n');
      expect(() => assertMeasurableSourceTree(root, null)).toThrow('SOURCE_TREE_DIRTY');
      const dirty = assertMeasurableSourceTree(root, 'node files');
      expect(dirty.dirtyPaths).toEqual(['scripts/probe.mts']);
      expect(dirty.diffSha256).toMatch(/^[0-9a-f]{64}$/);
      // The hash covers the untracked file's bytes, not only its name.
      write('scripts/probe.mts', 'export const changed = true;\n');
      expect(assertMeasurableSourceTree(root, 'node files').diffSha256).not.toBe(dirty.diffSha256);

      // A test file is not product code: a reason is enough.
      write('packages/kit/tests/a.test.ts', 'export const x = 1;\n');
      expect(() => assertMeasurableSourceTree(root, 'node files')).not.toThrow();
    } finally {
      cleanup();
    }
  });

  for (const path of [
    'tests/performance/render.spec.ts',
    'playwright.performance.config.ts',
    'package.json',
    'pnpm-workspace.yaml',
    // N-i (M2-01ai): the lockfile decides what is installed, turbo.json how it is built, and
    // tsconfig*.json how it is compiled — each scanned and hashed like the rest.
    'pnpm-lock.yaml',
    'turbo.json',
    'tsconfig.base.json',
  ])
    it(`scans and hashes ${path} as non-product: a reason is needed and enough`, () => {
      const { root, write, cleanup } = fixtureRepository();
      try {
        write(path, 'changed\n');
        expect(() => assertMeasurableSourceTree(root, null)).toThrow(`SOURCE_TREE_DIRTY: ${path}`);
        const first = assertMeasurableSourceTree(root, 'node files');
        expect(first.dirtyPaths).toEqual([path]);
        write(path, 'changed again\n');
        expect(assertMeasurableSourceTree(root, 'node files').diffSha256).not.toBe(
          first.diffSha256,
        );
      } finally {
        cleanup();
      }
    });

  it('does not scan documentation, which the probe does not run', () => {
    const { root, write, cleanup } = fixtureRepository();
    try {
      write('docs/notes.md', 'changed\n');
      expect(assertMeasurableSourceTree(root, null).dirtyPaths).toEqual([]);
    } finally {
      cleanup();
    }
  });

  for (const [label, path, mutant] of [
    ['src/', 'packages/kit/src/a.ts', 'export const a = 2;\n'],
    ['a Next app/ route', 'apps/web/app/activities/page.tsx', 'export default function P() {}\n'],
    ['a SQL migration', 'packages/server/persistence/migrations/001_foundation.sql', 'SELECT 2;\n'],
  ] as const)
    it(`refuses changed product code in ${label} unless that exact file is named`, () => {
      const { root, write, cleanup } = fixtureRepository();
      try {
        write(path, mutant);
        expect(() => assertMeasurableSourceTree(root, 'node files')).toThrow(
          `SOURCE_TREE_MUTATED: product code differs from HEAD: ${path}`,
        );
        expect(() =>
          assertMeasurableSourceTree(root, 'node files', ['packages/other/src/x.ts']),
        ).toThrow('SOURCE_TREE_MUTATED');
        const named = assertMeasurableSourceTree(root, 'node files', [path]);
        expect(named.dirtyPaths).toEqual([path]);
        // Named, the hash still tells two contents of the same file apart.
        write(path, `${mutant}-- again\n`);
        expect(assertMeasurableSourceTree(root, 'node files', [path]).diffSha256).not.toBe(
          named.diffSha256,
        );
      } finally {
        cleanup();
      }
    });

  it('reads paths with spaces or non-ASCII characters, and both sides of a rename, exactly', () => {
    const { root, git, write, cleanup } = fixtureRepository();
    try {
      // Without -z, git quotes this path ("scripts/\354\203\210 ...") and a line parser keeps it.
      write('scripts/새 파일.mts', 'export {};\n');
      git('mv', 'scripts/old-name.mts', 'scripts/new name.mts');
      const state = assertMeasurableSourceTree(root, 'node files');
      expect(state.dirtyPaths).toEqual([
        'scripts/new name.mts',
        'scripts/old-name.mts',
        'scripts/새 파일.mts',
      ]);
      // A non-ASCII product path is matched against the allow list by its real name.
      write('packages/kit/src/한 글.ts', 'export {};\n');
      expect(() => assertMeasurableSourceTree(root, 'node files')).toThrow(
        'packages/kit/src/한 글.ts',
      );
      expect(() =>
        assertMeasurableSourceTree(root, 'node files', ['packages/kit/src/한 글.ts']),
      ).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

/** Budgeted since M2-01aj: the peak RSS of one parse process (the parse left the API in M2-01ai). */
const PARSE_PROCESS_RSS = 'worker.parseProcessPeakRssMiB';

describe('the checked-in budget', () => {
  const budget = parseBudgetFile(
    JSON.parse(readFileSync(research('performance-budget.json'), 'utf8')),
  );

  it('covers the server path, the browser, memory and the engine under load', () => {
    const phases = new Set(Object.values(budget.desktop.metrics).map((metric) => metric.phase));
    expect([...phases].sort()).toEqual(['api', 'browser', 'engine', 'parse', 'worker']);
    for (const id of [
      'api.uploadParseMs',
      'api.readMapPathMs',
      'worker.parseMs',
      'worker.minimumHeapCeilingMiB',
      'worker.parseProcessPeakRssMiB',
      'engine.loadPeakRssMiB',
      'browser.next.navigationToDrawnMs',
      'browser.vite.navigationToDrawnMs',
      'browser.next.jsHeapAfterDrawnMiB',
    ])
      expect(budget.desktop.metrics[id], id).toBeDefined();
  });

  it('keeps every real-device budget not_executed', () => {
    expect(budget.realDevice.status).toBe('not_executed');
    expect(Object.keys(budget.realDevice.metrics).length).toBeGreaterThan(0);
    for (const metric of Object.values(budget.realDevice.metrics)) expect(metric.budget).toBeNull();
  });

  it('records no absolute or home-directory path in any checked-in result', () => {
    // Every run, including previousRuns: a path would carry the user name into the repository.
    const forbidden = ['/Users/', '/private/', '/var/folders/', '/home/', homedir()];
    for (const file of [
      'performance-budget.json',
      'performance-budget-result.json',
      'performance-budget-browser-result.json',
    ]) {
      const text = readFileSync(research(file), 'utf8');
      for (const needle of forbidden)
        expect(text.includes(needle), `${file}: ${needle}`).toBe(false);
    }
  });

  it('is met by the recorded judged runs it was checked against', () => {
    // The checked-in evidence and the checked-in budget must agree. Tightening a budget below
    // what was measured, without measuring again, fails here.
    for (const [file, phases] of [
      ['performance-budget-result.json', ['api', 'engine', 'worker', 'parse']],
      ['performance-budget-browser-result.json', ['browser']],
    ] as const) {
      const result = JSON.parse(readFileSync(research(file), 'utf8')) as {
        mode: string;
        samples: Record<string, BudgetSample[]>;
        details?: { routingGraph?: { graphContentSha256?: unknown } };
      };
      expect(result.mode, file).toBe('judged');
      expect(evaluateBudget(budget, result.samples, phases, runContext(result)).passed, file).toBe(
        true,
      );
    }
  });

  describe('the parse process memory (M2-01aj)', () => {
    const metric = budget.desktop.metrics[PARSE_PROCESS_RSS];
    const judgedRun = JSON.parse(
      readFileSync(research('performance-budget-result.json'), 'utf8'),
    ) as { mode: string; samples: Record<string, BudgetSample[]> };

    it('is a budgeted worker metric: the peak RSS of each parse process', () => {
      expect(metric).toMatchObject({ phase: 'worker', unit: 'MiB', statistic: 'max' });
      // Measured from three record-only runs, like every other budget.
      expect(metric?.baseline.runs).toHaveLength(3);
    });

    it('comes with an API process budget re-derived from runs whose parse ran outside it', () => {
      // Until M2-01ai the parse was a thread of the API process and its baseline (716 MiB)
      // included it. The re-derived baseline is taken from the same runs as the parse process.
      expect(budget.desktop.metrics['api.processPeakRssMiB']?.baseline.runs).toEqual(
        metric?.baseline.runs,
      );
    });

    it('is judged in the recorded judged run, and passed there', () => {
      expect(judgedRun.mode).toBe('judged');
      const judged = evaluateBudget(budget, judgedRun.samples, ['worker']);
      const verdict = judged.metrics.find((each) => each.id === PARSE_PROCESS_RSS);
      expect(verdict?.verdict).toBe('passed');
      expect(verdict?.samples).toBeGreaterThanOrEqual(metric?.minimumSamples ?? Infinity);
    });

    it('fails a worker run whose parse process holds more than the budget, at any load', () => {
      const over = (metric?.budget ?? 0) + 1;
      const worker = {
        ...judgedRun.samples,
        [PARSE_PROCESS_RSS]: [
          ...(judgedRun.samples[PARSE_PROCESS_RSS] ?? []).slice(1),
          // Memory is never excused by load, however high.
          { value: over, loadAverage1m: 500 },
        ],
      };
      const judged = evaluateBudget(budget, worker, ['worker']);
      expect(judged.passed).toBe(false);
      expect(judged.inconclusive).toBe(false);
      expect(judged.metrics.find((each) => each.id === PARSE_PROCESS_RSS)).toMatchObject({
        verdict: 'failed',
        observed: over,
      });
    });

    it('fails a worker run that did not measure it', () => {
      const { [PARSE_PROCESS_RSS]: _unmeasured, ...rest } = judgedRun.samples;
      const judged = evaluateBudget(budget, rest, ['worker']);
      expect(judged.passed).toBe(false);
      expect(judged.metrics.find((each) => each.id === PARSE_PROCESS_RSS)?.verdict).toBe('missing');
    });
  });

  describe('baselines re-derived from the recorded runs (N-h)', () => {
    const runs = [
      ...recordedRuns(JSON.parse(readFileSync(research('performance-budget-result.json'), 'utf8'))),
      ...recordedRuns(
        JSON.parse(readFileSync(research('performance-budget-browser-result.json'), 'utf8')),
      ),
    ];
    type MutableBaseline = {
      statisticValue: number;
      samples: number;
      runs: string[];
      perRunStatistic?: number[];
      loadAverage1m: { min: number; max: number };
    };
    const changed = (id: string, change: (baseline: MutableBaseline) => void) => {
      const copy = structuredClone(budget) as unknown as {
        desktop: { metrics: Record<string, { baseline: MutableBaseline }> };
      };
      change((copy.desktop.metrics[id] as { baseline: MutableBaseline }).baseline);
      return () => verifyBaselinesAgainstRuns(copy as unknown as PerformanceBudgetFile, runs);
    };

    it('follow, metric by metric, from the samples of the runs they name', () => {
      expect(() => verifyBaselinesAgainstRuns(budget, runs)).not.toThrow();
    });

    it('refuses an admissible load that the baseline runs did not record', () => {
      expect(
        changed('api.uploadParseMs', (baseline) => {
          baseline.loadAverage1m.max = 38;
        }),
      ).toThrow('BASELINE_LOAD_MISMATCH:api.uploadParseMs');
      expect(
        changed('worker.parseMs', (baseline) => {
          baseline.loadAverage1m.min = 1;
        }),
      ).toThrow('BASELINE_LOAD_MISMATCH:worker.parseMs');
    });

    it('refuses a statistic, a per-run statistic or a count the runs do not give', () => {
      expect(
        changed('api.uploadParseMs', (baseline) => {
          baseline.statisticValue = 600;
        }),
      ).toThrow('BASELINE_STATISTIC_MISMATCH');
      expect(
        changed('api.uploadParseMs', (baseline) => {
          baseline.perRunStatistic = [623, 629];
        }),
      ).toThrow('BASELINE_PER_RUN_MISMATCH');
      expect(
        changed('api.uploadParseMs', (baseline) => {
          baseline.samples = 47;
        }),
      ).toThrow('BASELINE_SAMPLES_MISMATCH');
    });

    it('refuses a baseline run that is missing, judged, or too small to count', () => {
      expect(
        changed('api.uploadParseMs', (baseline) => {
          baseline.runs = [...baseline.runs, '2026-01-01T00:00:00.000Z'];
        }),
      ).toThrow('BASELINE_RUN_NOT_RECORDED');
      expect(
        changed('api.uploadParseMs', (baseline) => {
          // The judged run 4 cannot be its own baseline.
          baseline.runs = ['2026-09-24T15:58:23.437Z'];
        }),
      ).toThrow('BASELINE_RUN_NOT_RECORD_ONLY');
      expect(
        changed('api.uploadParseMs', (baseline) => {
          // Baseline 1 has 7 samples: below the 20 a p95 baseline needs.
          baseline.runs = ['2026-09-24T03:06:45.593Z', ...baseline.runs];
        }),
      ).toThrow('BASELINE_RUN_TOO_FEW_SAMPLES');
    });
  });

  it('judges the load-failed server run 3 inconclusive under the admissible-load rule', () => {
    // Run 3 (2026-09-24T15:30Z) failed five time budgets while the load average rose to 124.
    // The rule was written after that run; re-judged under it, the run is inconclusive.
    const result = JSON.parse(readFileSync(research('performance-budget-result.json'), 'utf8')) as {
      previousRuns: { executedAt: string; mode: string; samples: Record<string, BudgetSample[]> }[];
    };
    const run3 = result.previousRuns.find((run) => run.executedAt.startsWith('2026-09-24T15:30'));
    expect(run3?.mode).toBe('judged');
    // The parse-process metric came with M2-01aj; run 3 could not measure it, and without it
    // the run would be `missing` a metric rather than inconclusive. Judge it by the rest. The
    // engine memory metrics are bound to the national graph since M2-01ak and run 3 measured
    // the Seoul graph: they are not comparable, so they are left out too (evaluateBudget
    // refuses them rather than judging them).
    const {
      [PARSE_PROCESS_RSS]: _added,
      'engine.idleRssMiB': _idle,
      'engine.loadPeakRssMiB': _peak,
      ...before
    } = budget.desktop.metrics;
    const judged = evaluateBudget(
      { ...budget, desktop: { ...budget.desktop, metrics: before } },
      Object.fromEntries(Object.entries(run3?.samples ?? {}).filter(([id]) => id in before)),
      ['api', 'engine', 'worker', 'parse'],
    );
    expect(judged.passed).toBe(false);
    expect(judged.inconclusive).toBe(true);
    expect(
      judged.metrics
        .filter((metric) => metric.verdict === 'inconclusive')
        .map((metric) => metric.id),
    ).toEqual([
      'api.uploadParseMs',
      'api.finalizeMs',
      'api.readMapPathMs',
      'api.readNormalizedMs',
      'worker.parseMs',
    ]);
  });
});

describe('the parse process RSS of every parse is read (M2-01al a)', () => {
  it('fails the check when any parse had no reading, however many were read', () => {
    expect(parseProcessRssCheck(20, 0)).toMatchObject({
      id: PARSE_PROCESS_RSS_CHECK,
      passed: true,
    });
    // minimumSamples (5) alone would judge 5 readings of 20 parses; so would 19 of 20.
    expect(parseProcessRssCheck(20, 15).passed).toBe(false);
    expect(parseProcessRssCheck(20, 1).passed).toBe(false);
    expect(parseProcessRssCheck(20, 1).detail).toBe(
      '19 of 20 parses had their RSS read (1 without a reading)',
    );
    // No parse at all is no evidence.
    expect(parseProcessRssCheck(0, 0).passed).toBe(false);
  });

  it('is a passed check of the recorded judged run, which read every parse', () => {
    const latest = JSON.parse(readFileSync(research('performance-budget-result.json'), 'utf8')) as {
      mode: string;
      checks: { id: string; passed: boolean }[];
      details: { parseProcessRss: { parsesWithoutReading: number } };
    };
    expect(latest.mode).toBe('judged');
    expect(latest.checks.find((each) => each.id === PARSE_PROCESS_RSS_CHECK)?.passed).toBe(true);
    expect(latest.details.parseProcessRss.parsesWithoutReading).toBe(0);
  });
});

describe('one disclosed re-run (M2-01al b)', () => {
  const budget = budgetWith({
    'parse.time': { budget: 100 },
    'parse.memory': { budget: 100, unit: 'MiB' },
    'parse.size': { budget: 100, unit: 'bytes' },
  });
  const ok = samples([90, 90, 90, 90, 90], 20);
  const judge = (
    observed: Partial<Record<'parse.time' | 'parse.memory' | 'parse.size', BudgetSample[]>>,
  ): BudgetEvaluation =>
    evaluateBudget(
      budget,
      { 'parse.time': ok, 'parse.memory': ok, 'parse.size': ok, ...observed },
      ['parse'],
    );
  // The fixture's admissible load is 30 (its baseline maximum).
  const slow = judge({ 'parse.time': samples([150, 150, 150, 150, 150], 20) });
  const loaded = judge({ 'parse.time': samples([150, 150, 150, 150, 150], 99) });
  const passing = judge({});

  it('re-runs a first attempt that failed only a time budget, even at an admissible load', () => {
    expect(slow.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe('failed');
    expect(retryDecision(slow, true, 1)).toEqual({ retry: true, timeMetrics: ['parse.time'] });
    // An inconclusive time budget is re-run too: the re-run is the repeat the rule asks for.
    expect(loaded.inconclusive).toBe(true);
    expect(retryDecision(loaded, true, 1)).toEqual({ retry: true, timeMetrics: ['parse.time'] });
  });

  it('never re-runs for a memory or size budget, a missing or thin metric, or a failed check', () => {
    const over = samples([150, 150, 150, 150, 150], 99);
    for (const evaluation of [
      judge({ 'parse.memory': over }),
      judge({ 'parse.size': over }),
      // A slow time budget next to a memory failure: the memory failure decides.
      judge({ 'parse.time': samples([150, 150, 150, 150, 150], 20), 'parse.memory': over }),
      // parse.size missing.
      evaluateBudget(budget, { 'parse.time': over, 'parse.memory': ok }, ['parse']),
      // parse.size insufficient (4 of 5 samples).
      judge({ 'parse.time': samples([150, 150, 150, 150, 150], 20), 'parse.size': ok.slice(1) }),
    ])
      expect(retryDecision(evaluation, true, 1).retry).toBe(false);
    expect(retryDecision(slow, false, 1)).toEqual({ retry: false, reason: 'a check failed' });
    expect(retryDecision(passing, true, 1).retry).toBe(false);
  });

  it('never re-runs a time budget that was missing or had too few samples (review N2)', () => {
    // Only the time metric is short of evidence; memory and size passed. Unmeasured is not
    // slow: nothing a burst could explain, so there is nothing to re-run.
    const missingTime = evaluateBudget(budget, { 'parse.memory': ok, 'parse.size': ok }, ['parse']);
    expect(missingTime.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe(
      'missing',
    );
    expect(retryDecision(missingTime, true, 1)).toEqual({
      retry: false,
      reason: 'not only time budgets: parse.time:missing',
    });
    const thinTime = judge({ 'parse.time': samples([150, 150, 150, 150], 20) });
    expect(thinTime.metrics.find((metric) => metric.id === 'parse.time')?.verdict).toBe(
      'insufficient',
    );
    expect(retryDecision(thinTime, true, 1)).toEqual({
      retry: false,
      reason: 'not only time budgets: parse.time:insufficient',
    });
  });

  it('re-runs at most once', () => {
    expect(retryDecision(slow, true, 2)).toEqual({ retry: false, reason: 'no attempt left' });
  });

  it('passes only when the re-run passes by itself', () => {
    expect(
      combineAttempts(
        { evaluation: slow, checksPassed: true },
        { evaluation: passing, checksPassed: true },
      ),
    ).toEqual({ passed: true, inconclusive: false });
    // A real regression at an admissible load is slow in the re-run too: failed.
    expect(
      combineAttempts(
        { evaluation: slow, checksPassed: true },
        { evaluation: slow, checksPassed: true },
      ),
    ).toEqual({ passed: false, inconclusive: false });
    // The re-run is judged whole: a check or a memory budget it fails fails the pair.
    expect(
      combineAttempts(
        { evaluation: slow, checksPassed: true },
        { evaluation: passing, checksPassed: false },
      ).passed,
    ).toBe(false);
    expect(
      combineAttempts(
        { evaluation: slow, checksPassed: true },
        {
          evaluation: judge({ 'parse.memory': samples([150, 150, 150, 150, 150], 20) }),
          checksPassed: true,
        },
      ).passed,
    ).toBe(false);
  });

  it('never excuses memory: a first attempt with a memory failure fails, whatever the re-run', () => {
    const memoryAndTime = judge({
      'parse.time': samples([150, 150, 150, 150, 150], 20),
      'parse.memory': samples([150, 150, 150, 150, 150], 20),
    });
    expect(
      combineAttempts(
        { evaluation: memoryAndTime, checksPassed: true },
        { evaluation: passing, checksPassed: true },
      ),
    ).toEqual({ passed: false, inconclusive: false });
    // Nor a failed check of the first attempt.
    expect(
      combineAttempts(
        { evaluation: slow, checksPassed: false },
        { evaluation: passing, checksPassed: true },
      ).passed,
    ).toBe(false);
  });

  it('keeps a pair inconclusive only when both attempts were', () => {
    expect(
      combineAttempts(
        { evaluation: loaded, checksPassed: true },
        { evaluation: loaded, checksPassed: true },
      ),
    ).toEqual({ passed: false, inconclusive: true });
    // A time budget failed at an admissible load in either attempt keeps the pair failed.
    for (const [first, second] of [
      [slow, loaded],
      [loaded, slow],
    ] as const)
      expect(
        combineAttempts(
          { evaluation: first, checksPassed: true },
          { evaluation: second, checksPassed: true },
        ),
      ).toEqual({ passed: false, inconclusive: false });
  });

  describe('on the M2-01aj reviewer burst (2026-09-25T01:16Z, worker.parseMs)', () => {
    const checkedIn = parseBudgetFile(
      JSON.parse(readFileSync(research('performance-budget.json'), 'utf8')),
    );
    const parseBudget: PerformanceBudgetFile = {
      ...checkedIn,
      desktop: {
        ...checkedIn.desktop,
        metrics: Object.fromEntries(
          Object.entries(checkedIn.desktop.metrics).filter(([id]) => id === 'worker.parseMs'),
        ),
      },
    };
    // The reviewer's 20 samples in order, each with the 1-minute load it was taken at: seven
    // slow parses at load 13.73–17.92; the load reached 21.61 only after they were fast again.
    const burst: BudgetSample[] = (
      [
        [1511, 13.73],
        [1412, 13.73],
        [1446, 17.92],
        [1345, 17.92],
        [1260, 17.92],
        [1060, 17.92],
        [883, 17.92],
        [837, 21.61],
        [634, 21.61],
        [457, 21.61],
        [471, 21.61],
        [444, 21.61],
        [448, 21.61],
        [444, 21.61],
        [440, 21.61],
        [484, 21.61],
        [468, 21.61],
        [454, 20.12],
        [455, 20.12],
        [451, 20.12],
      ] as const
    ).map(([value, loadAverage1m]) => ({ value, loadAverage1m }));
    const firstAttempt = evaluateBudget(parseBudget, { 'worker.parseMs': burst }, ['worker']);

    it('is failed, not inconclusive, under the unchanged admissible-load rule', () => {
      // Every sample lies below the admissible 23.21: the lagging load cannot excuse the burst.
      expect(checkedIn.desktop.metrics['worker.parseMs']?.baseline.loadAverage1m.max).toBe(23.21);
      expect(firstAttempt.metrics[0]).toMatchObject({ verdict: 'failed', observed: 1446 });
      expect(retryDecision(firstAttempt, true, 1).retry).toBe(true);
    });

    it('passes with a re-run at the recorded judged speed, and fails with one as slow', () => {
      const judged = JSON.parse(
        readFileSync(research('performance-budget-result.json'), 'utf8'),
      ) as { samples: Record<string, BudgetSample[]> };
      const fast = evaluateBudget(
        parseBudget,
        { 'worker.parseMs': judged.samples['worker.parseMs'] ?? [] },
        ['worker'],
      );
      expect(fast.passed).toBe(true);
      const first = { evaluation: firstAttempt, checksPassed: true };
      expect(combineAttempts(first, { evaluation: fast, checksPassed: true }).passed).toBe(true);
      expect(combineAttempts(first, { evaluation: firstAttempt, checksPassed: true }).passed).toBe(
        false,
      );
    });
  });
});

describe('output that survives the test runners (M2-01al c)', () => {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));

  it('refuses a result or log under a directory that Playwright or coverage empties', () => {
    expect(WIPED_OUTPUT_DIRECTORIES).toEqual(['test-results', 'playwright-report', 'coverage']);
    for (const path of [
      'test-results/m2-01al/probe.log',
      'playwright-report/result.json',
      'coverage/m2-01aj/identity.log',
      'apps/web/test-results/probe.log',
    ])
      expect(() => assertDurableOutputPath('/repo', path), path).toThrow(
        'OUTPUT_PATH_WIPED_BY_TOOL',
      );
    expect(assertDurableOutputPath('/repo', 'verification-logs/m2-01al/probe.log')).toBe(
      '/repo/verification-logs/m2-01al/probe.log',
    );
    expect(assertDurableOutputPath('/repo', '/repo/docs/implementation/research/result.json')).toBe(
      '/repo/docs/implementation/research/result.json',
    );
    // Outside the repository no tool of this workspace empties anything: the caller's choice.
    expect(assertDurableOutputPath('/repo', '/elsewhere/test-results/x.log')).toBe(
      '/elsewhere/test-results/x.log',
    );
    // A file named like one of them is not under it.
    expect(() => assertDurableOutputPath('/repo', 'verification-logs/coverage.log')).not.toThrow();
  });

  it('matches the directory names without case, as the case-insensitive volume does (review N3)', () => {
    for (const path of [
      'Test-Results/a.log',
      'TEST-RESULTS/m2-01al/probe.log',
      'Playwright-Report/result.json',
      'apps/web/Coverage/x.log',
    ])
      expect(() => assertDurableOutputPath('/repo', path), path).toThrow(
        'OUTPUT_PATH_WIPED_BY_TOOL',
      );
  });

  it('follows symbolic links to where the output would land (review N3)', () => {
    const root = mkdtempSync(join(tmpdir(), 'budget-output-'));
    try {
      mkdirSync(join(root, 'test-results'));
      mkdirSync(join(root, 'verification-logs'));
      mkdirSync(join(root, 'kept'));
      // An existing directory reached through a link, at the file's own parent or higher.
      symlinkSync('../test-results', join(root, 'verification-logs/link'));
      expect(() => assertDurableOutputPath(root, 'verification-logs/link/a.log')).toThrow(
        'OUTPUT_PATH_WIPED_BY_TOOL',
      );
      expect(() => assertDurableOutputPath(root, 'verification-logs/link/deeper/a.log')).toThrow(
        'OUTPUT_PATH_WIPED_BY_TOOL',
      );
      // A link to a directory not created yet (Playwright creates it on its next run).
      symlinkSync('../coverage/m2-01al', join(root, 'verification-logs/dangling'));
      expect(() => assertDurableOutputPath(root, 'verification-logs/dangling/a.log')).toThrow(
        'OUTPUT_PATH_WIPED_BY_TOOL',
      );
      // The file itself a link into one of them.
      symlinkSync('../test-results/a.log', join(root, 'verification-logs/file.log'));
      expect(() => assertDurableOutputPath(root, 'verification-logs/file.log')).toThrow(
        'OUTPUT_PATH_WIPED_BY_TOOL',
      );
      // A link that leads somewhere durable is accepted, under its own name.
      symlinkSync('../kept', join(root, 'verification-logs/good'));
      expect(assertDurableOutputPath(root, 'verification-logs/good/a.log')).toBe(
        join(root, 'verification-logs/good/a.log'),
      );
      // A cycle of dangling links is refused, not followed forever.
      symlinkSync('loop-b', join(root, 'verification-logs/loop-a'));
      symlinkSync('loop-a', join(root, 'verification-logs/loop-b'));
      expect(() => assertDurableOutputPath(root, 'verification-logs/loop-a/x.log')).toThrow(
        /OUTPUT_PATH_UNRESOLVABLE|ELOOP/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the verification log directory out of git and Prettier', () => {
    expect(WIPED_OUTPUT_DIRECTORIES).not.toContain(VERIFICATION_LOG_DIRECTORY);
    // Exits 0 only when the path is ignored.
    expect(() =>
      execFileSync('git', [
        '-C',
        repository,
        'check-ignore',
        '-q',
        `${VERIFICATION_LOG_DIRECTORY}/m2-01al/probe.log`,
      ]),
    ).not.toThrow();
    expect(readFileSync(join(repository, '.prettierignore'), 'utf8').split('\n')).toContain(
      `${VERIFICATION_LOG_DIRECTORY}/`,
    );
  });
});

describe('engine memory budgets are bound to the graph they were baselined on (M2-01ak)', () => {
  const national = 'c'.repeat(64);
  const seoul = 'a'.repeat(64);
  const engineBudget = (graph: string | undefined) => ({
    schemaVersion: 1,
    desktop: {
      label: 'unit fixture',
      metrics: {
        'engine.rss': {
          phase: 'engine',
          unit: 'MiB',
          statistic: 'max',
          budget: 150,
          minimumSamples: 5,
          description: 'fixture',
          baseline: {
            statisticValue: 100,
            samples: 5,
            runs: ['r1'],
            loadAverage1m: { min: 20, max: 20 },
            ...(graph === undefined ? {} : { routingGraphContentSha256: graph }),
          },
          headroom: { factor: 1.5, reason: 'fixture' },
        },
      },
    },
    realDevice: { status: 'not_executed', reason: 'fixture', metrics: {} },
  });
  const within = samples([90, 90, 90, 90, 90]);

  it('refuses an engine memory metric whose baseline does not name its graph', () => {
    expect(() => parseBudgetFile(engineBudget(undefined))).toThrow(
      'BUDGET_BASELINE_GRAPH_INVALID:engine.rss',
    );
    expect(() => parseBudgetFile(engineBudget('not-a-hash'))).toThrow(
      'BUDGET_BASELINE_GRAPH_INVALID',
    );
  });

  it('judges samples from the baselined graph and refuses another graph or an unrecorded one', () => {
    const budget = parseBudgetFile(engineBudget(national));
    const judge = (graph: string | null | undefined) =>
      evaluateBudget(budget, { 'engine.rss': within }, ['engine'], {
        routingGraphContentSha256: graph,
      });
    expect(judge(national).passed).toBe(true);
    // A Seoul-graph run under the national budget would pass a doubled Seoul RSS: refused.
    expect(() => judge(seoul)).toThrow('ENGINE_GRAPH_NOT_BASELINED:engine.rss');
    expect(() => judge(null)).toThrow('ENGINE_GRAPH_NOT_BASELINED');
    expect(() => evaluateBudget(budget, { 'engine.rss': within }, ['engine'])).toThrow(
      'ENGINE_GRAPH_NOT_BASELINED',
    );
  });

  it('refuses a baseline run measured on another graph', () => {
    const budget = parseBudgetFile(engineBudget(national));
    const run = (graph: string) => ({
      executedAt: 'r1',
      mode: 'record-only (baseline, not judged)',
      samples: { 'engine.rss': samples([100, 90, 90, 90, 90], 20) },
      details: { routingGraph: { graphContentSha256: graph } },
    });
    expect(() => verifyBaselinesAgainstRuns(budget, [run(national)])).not.toThrow();
    expect(() => verifyBaselinesAgainstRuns(budget, [run(seoul)])).toThrow(
      'BASELINE_RUN_GRAPH_MISMATCH:engine.rss:r1',
    );
  });

  it('binds the checked-in engine memory budgets to the national graph', () => {
    const checkedIn = parseBudgetFile(
      JSON.parse(readFileSync(research('performance-budget.json'), 'utf8')),
    );
    for (const id of ['engine.idleRssMiB', 'engine.loadPeakRssMiB'])
      expect(checkedIn.desktop.metrics[id]?.baseline.routingGraphContentSha256, id).toBe(
        '138a1978042736ce55b784d942a45b55a4b635c4a67a848e2265d523d130f085',
      );
  });
});
