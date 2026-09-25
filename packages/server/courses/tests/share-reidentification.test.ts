import {
  courseShareMeasuredResidual,
  courseSharingLimits,
} from '@workout/contracts/course-sharing';
import { writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  courseModels,
  estimators,
  formatCells,
  judgeCell,
  runAttackSuite,
  trainAttackers,
  type Cell,
  type SuiteResult,
} from './share-reidentification.js';

/**
 * M2-01as: the view-only link against re-identification attackers, on synthetic data.
 *
 * The acceptance contract (task-graph M2-01as, and the re-identification review r1 of it): at
 * least 300 protected areas per seed and three measured seeds, r uniform in 50–400 m, N links
 * per area up to the lifetime bound, six course models (T22, its loops with both ends, a
 * correlated random walk, an 80 m grid, a staircase grid and the reviewer's r2 grid) and every attacker of the suite — circle fit, mean,
 * back-projection, mleHead and dead reckoning over 60 m, 1 · S and 2 · S headings, and an
 * affine combiner of all of them learned on two disjoint seeds, per model and pooled — run
 * through the real share path. In every cell a median error of at least 0.3 · S and 60 m and a
 * 10th percentile of at least 0.1 · S and 20 m. In the same test, the power controls: the
 * M2-01k-o cut, the M2-01k-o geometry with the continuation, a zero offset and a fresh offset
 * per link must each fail the same bound.
 *
 * The N list is the acceptance list cut at the lifetime bound, and the bound itself: N = 15, 20
 * and 50 are never reachable in the product, and raising or removing the bound puts them back in
 * the suite (where the loop model fails). The full table is recorded in
 * docs/implementation/progress/M2-01as.md.
 */
/** The measured seeds: three, so one lucky seed cannot carry the verdict (review r2). */
const SEEDS = [20260926, 11, 22] as const;
const SEED = SEEDS[0];
const TRAINING = { seeds: [20260927, 20260928], zones: 200 } as const;
/** How far below the measurement the owner's warning may round (it never rounds up). */
const RESIDUAL_ROUNDING_METERS = 15;
const ZONES = 300;
const M2_01K_O_GEOMETRY = { offsetFactor: 0.5, radiusFactor: 1.5 } as const;
const lifetime = courseSharingLimits.shareLinksPerAreaLifetime;
const sizes = [
  ...new Set([
    ...[3, 5, 10, 20, 50].filter((size) => !(size > lifetime)),
    ...(Number.isFinite(lifetime) ? [lifetime] : []),
  ]),
].sort((left, right) => left - right);

function failing(result: SuiteResult): Cell[] {
  return result.cells.filter((cell) => judgeCell(cell).failures.length > 0);
}

function cell(result: SuiteResult, model: string, estimator: string, size: number): Cell {
  const found = result.cells.find(
    (candidate) =>
      candidate.model === model && candidate.estimator === estimator && candidate.size === size,
  );
  if (!found) throw new Error(`no cell ${model}/${estimator}/${size}`);
  return found;
}

describe('the bound itself', () => {
  const pass = { errorsMeters: [80, 90, 30, 100], errorsScaled: [0.4, 0.45, 0.15, 0.5] };
  it('passes a cell over every bound and names each bound a cell misses', () => {
    expect(judgeCell(pass).failures).toEqual([]);
    expect(
      judgeCell({ errorsMeters: [80, 90, 30, 100], errorsScaled: [0.2, 0.25, 0.15, 0.5] }).failures,
    ).toEqual(['medianScaled']);
    expect(judgeCell({ errorsMeters: [], errorsScaled: [] }).failures).toEqual([
      'medianScaled',
      'p10Scaled',
      'medianMeters',
      'p10Meters',
    ]);
  });

  it('checks the metres on their own: a cell over the S bound but under 60 m / 20 m fails', () => {
    // As if S were 100 m: 0.4 · S is 40 m. S never is (S ≥ 200 m), which is exactly why the
    // absolute floor is checked separately rather than assumed from it.
    const small = { errorsMeters: [40, 45, 15, 50], errorsScaled: [0.4, 0.45, 0.15, 0.5] };
    expect(judgeCell(small).failures).toEqual(['medianMeters', 'p10Meters']);
  });
});

describe('M2-01as: links cut against one protected area do not narrow its home down', () => {
  it('passes every model × attacker × N up to the lifetime bound, and the controls fail', () => {
    // The acceptance N list, cut at the bound: [3, 5, 10] with the bound at 10.
    expect(sizes.at(-1)).toBe(lifetime);
    // The learned attackers train on seeds the measured zones never use, once, and attack
    // every measured seed.
    for (const seed of SEEDS) expect(TRAINING.seeds).not.toContain(seed);
    const suite = {
      zones: ZONES,
      sizes,
      models: courseModels,
      offsets: 'per-zone',
      continuation: true,
    } as const;
    const combiners = trainAttackers({ ...suite, seed: SEED, training: TRAINING });
    const runs = SEEDS.map((seed) => ({
      seed,
      result: runAttackSuite({ ...suite, seed, combiners }),
    }));
    const tableFile = process.env['SHARE_REIDENTIFICATION_TABLE'];
    for (const { seed, result: product } of runs) {
      expect(courseModels).toHaveLength(6);
      expect(estimators).toEqual(
        expect.arrayContaining([
          'dead-reckoning',
          'dead-reckoning-1s',
          'dead-reckoning-2s',
          'learned-per-model',
          'learned-pooled',
        ]),
      );
      expect(product.cells).toHaveLength(courseModels.length * estimators.length * sizes.length);
      // Nothing that leaves touches a circle it was cut against (T3 for every link here).
      expect(product.linesTouchingACircle).toBe(0);
      // Every zone reaches every N, for every attacker, the learned ones included: the refused
      // courses (a walk turning back into its circle) are drawn again, and they are few.
      for (const each of product.cells) expect(each.errorsMeters).toHaveLength(ZONES);
      // A loop gives the recipient both of its cut ends; every other model one (its start).
      const largest = Math.max(...sizes);
      expect(product.observations).toEqual({
        t22: ZONES * largest,
        't22-loop': 2 * ZONES * largest,
        'correlated-walk': ZONES * largest,
        'grid-80m': ZONES * largest,
        'grid-80m-staircase': ZONES * largest,
        'grid-80m-r2': ZONES * largest,
      });
      expect(product.refusedCourses).toBeLessThan(0.03 * product.drawnCourses);
      // SHARE_REIDENTIFICATION_TABLE=<prefix> writes each seed's table the progress record quotes.
      if (tableFile)
        writeFileSync(`${tableFile}-seed${seed}.txt`, `${formatCells(product.cells)}\n`);
      expect(failing(product), `seed ${seed}\n${formatCells(product.cells)}`).toEqual([]);
    }

    // Power control 1: the M2-01k-o cut (its geometry, no continuation) is broken by the
    // heading attackers at N = 20 in T22's own model…
    const unmitigated = runAttackSuite({
      seed: SEED,
      zones: ZONES,
      sizes: [20],
      models: ['t22'],
      offsets: 'per-zone',
      continuation: false,
      geometry: M2_01K_O_GEOMETRY,
    });
    expect(judgeCell(cell(unmitigated, 't22', 'back-projection', 20)).failures).not.toEqual([]);
    expect(judgeCell(cell(unmitigated, 't22', 'mle-head', 20)).failures).not.toEqual([]);
    // …while circle fitting alone, what T22 measures, does not see it.
    expect(judgeCell(cell(unmitigated, 't22', 'circle-fit', 20)).failures).toEqual([]);

    // Power control 2: the M2-01k-o geometry with the continuation (the review r1 attack):
    // dead reckoning on loops breaks it at the bound.
    const narrow = runAttackSuite({
      seed: SEED,
      zones: ZONES,
      sizes: [lifetime],
      models: ['t22-loop'],
      offsets: 'per-zone',
      continuation: true,
      geometry: M2_01K_O_GEOMETRY,
    });
    expect(
      ['dead-reckoning', 'dead-reckoning-1s', 'dead-reckoning-2s'].some(
        (name) => judgeCell(cell(narrow, 't22-loop', name, lifetime)).failures.length > 0,
      ),
    ).toBe(true);

    // Power control 3: no secret offset, with the continuation, at N = 3.
    const zero = runAttackSuite({
      seed: SEED,
      zones: ZONES,
      sizes: [3],
      models: ['t22'],
      offsets: 'zero',
      continuation: true,
    });
    expect(judgeCell(cell(zero, 't22', 'circle-fit', 3)).failures).not.toEqual([]);

    // Power control 4: a fresh offset for every link, with the continuation, at N = 20.
    const perLink = runAttackSuite({
      seed: SEED,
      zones: ZONES,
      sizes: [20],
      models: ['t22'],
      offsets: 'per-link',
      continuation: true,
    });
    expect(judgeCell(cell(perLink, 't22', 'circle-fit', 20)).failures).not.toEqual([]);

    // Last, the owner's warning states the residual of the STRONGEST attacker at the bound:
    // the smallest median and the smallest 10th percentile over every model, attacker and
    // measured seed, the learned ones included. The warning may round down (never up), by less
    // than RESIDUAL_ROUNDING_METERS, so a small numeric drift does not break the test with a
    // misleading cause while an overstated warning always does.
    const atBound = runs.flatMap(({ result }) =>
      result.cells.filter((each) => each.size === lifetime).map(judgeCell),
    );
    const medianMeters = Math.min(...atBound.map((verdict) => verdict.medianMeters));
    const p10Meters = Math.min(...atBound.map((verdict) => verdict.p10Meters));
    expect(courseShareMeasuredResidual.links).toBe(lifetime);
    expect(courseShareMeasuredResidual.medianMeters % 5).toBe(0);
    expect(courseShareMeasuredResidual.p10Meters % 5).toBe(0);
    expect(courseShareMeasuredResidual.medianMeters).toBeLessThanOrEqual(medianMeters);
    expect(courseShareMeasuredResidual.p10Meters).toBeLessThanOrEqual(p10Meters);
    expect(courseShareMeasuredResidual.medianMeters).toBeGreaterThan(
      medianMeters - RESIDUAL_ROUNDING_METERS,
    );
    expect(courseShareMeasuredResidual.p10Meters).toBeGreaterThan(
      p10Meters - RESIDUAL_ROUNDING_METERS,
    );
  }, 900_000);
});
