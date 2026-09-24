import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertMeasurableSourceTree,
  evaluateBudget,
  parseBudgetFile,
  percentile,
  repoRelative,
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
      unit?: 'ms' | 'MiB';
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
      };
      expect(result.mode, file).toBe('judged');
      expect(evaluateBudget(budget, result.samples, phases).passed, file).toBe(true);
    }
  });

  it('judges the load-failed server run 3 inconclusive under the admissible-load rule', () => {
    // Run 3 (2026-09-24T15:30Z) failed five time budgets while the load average rose to 124.
    // The rule was written after that run; re-judged under it, the run is inconclusive.
    const result = JSON.parse(readFileSync(research('performance-budget-result.json'), 'utf8')) as {
      previousRuns: { executedAt: string; mode: string; samples: Record<string, BudgetSample[]> }[];
    };
    const run3 = result.previousRuns.find((run) => run.executedAt.startsWith('2026-09-24T15:30'));
    expect(run3?.mode).toBe('judged');
    const judged = evaluateBudget(budget, run3?.samples ?? {}, [
      'api',
      'engine',
      'worker',
      'parse',
    ]);
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
