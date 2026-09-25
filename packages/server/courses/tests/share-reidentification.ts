import { courseSharingLimits } from '@workout/contracts/course-sharing';
import type { CoursePosition, CourseWaypoint } from '@workout/contracts/courses';

import {
  disclosureChoices,
  drawShareOffset,
  shareCircles,
  shareContinuationCutMeters,
  shareScaleMeters,
  type DisclosureCircle,
  type ShareOffset,
} from '../src/disclosure.js';
import { insideAnyCircle, lineEntersAnyCircle } from '../src/privacy-trim.js';

/**
 * The re-identification attack suite for view-only links (M2-01as).
 *
 * Synthetic homes, synthetic courses and the product's own share path: every link here is
 * cut by `disclosureChoices('share', …)` against `shareCircles(zone, offset)`, exactly what
 * the confirmation route and the link store run. Attackers then estimate the home from the
 * links of one protected area and the error is measured in metres and in units of
 * S = max(r, 200 m).
 *
 * The course models: T22's winding course, its loops (both ends), a correlated random walk, an
 * 80 m grid walk, a staircase grid, and the re-identification reviewer's r2 grid.
 *
 * The attackers: eleven that need nothing but the links (circle fit, mean of the cut ends,
 * back-projection, mleHead and dead reckoning, the last three each over headings taken 60 m,
 * 1 · S and 2 · S along the line), and two learned ones — an affine combination of all eleven,
 * trained on zones of other seeds, once per course model and once pooled over every model.
 *
 * Nothing here is a real location. Homes are drawn at random over the globe with fixed seeds,
 * so every run measures the same thing.
 */

export type CourseModel =
  't22' | 't22-loop' | 'correlated-walk' | 'grid-80m' | 'grid-80m-staircase' | 'grid-80m-r2';

export const courseModels: readonly CourseModel[] = [
  't22',
  't22-loop',
  'correlated-walk',
  'grid-80m',
  'grid-80m-staircase',
  'grid-80m-r2',
];

/** How the secret offset of a link is chosen: the product's, and two broken ones. */
export type OffsetPolicy = 'per-zone' | 'zero' | 'per-link';

/** The share-circle geometry, as multiples of S. The gate uses the product's. */
export interface ShareGeometry {
  readonly offsetFactor: number;
  readonly radiusFactor: number;
}

export const productGeometry: ShareGeometry = {
  offsetFactor: courseSharingLimits.shareOffsetFactor,
  radiusFactor: courseSharingLimits.shareRadiusFactor,
};

export interface SuiteOptions {
  readonly seed: number;
  readonly zones: number;
  /** Link counts N; each smaller N is a prefix of the largest one's links. */
  readonly sizes: readonly number[];
  readonly models: readonly CourseModel[];
  readonly offsets: OffsetPolicy;
  /** false: the M2-01k-o cut, with every circle's continuation removed (the unmitigated control). */
  readonly continuation: boolean;
  /**
   * Seeds whose zones train the learned attackers (disjoint from `seed`), and how many zones
   * each. Without them the learned cells are not measured.
   */
  readonly training?: { readonly seeds: readonly number[]; readonly zones: number };
  /** Combiners trained once elsewhere (`trainAttackers`), reused across measured seeds. */
  readonly combiners?: TrainedAttackers;
  /**
   * Exploration only (the documented full runs): the continuation as a multiple of S, and the
   * share-circle geometry, instead of the product's. The gating test sets neither.
   */
  readonly continuationFactor?: number;
  readonly geometry?: ShareGeometry;
}

export interface Cell {
  readonly model: CourseModel;
  readonly estimator: Estimator;
  readonly size: number;
  /** One per zone that reached N links. */
  readonly errorsMeters: readonly number[];
  readonly errorsScaled: readonly number[];
}

export interface SuiteResult {
  readonly cells: readonly Cell[];
  /** Courses the share path refused (too short, re-entry) and were drawn again. */
  readonly refusedCourses: number;
  readonly drawnCourses: number;
  /** Shared lines with a vertex, a segment or an end inside a circle they were cut against. */
  readonly linesTouchingACircle: number;
  /** Cut ends the recipient saw, per model, over every zone's links. */
  readonly observations: Readonly<Partial<Record<CourseModel, number>>>;
}

/** A small deterministic PRNG (mulberry32), the same one T22 uses. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const METERS_PER_DEGREE = (Math.PI / 180) * 6_371_008.8;
const DEG = Math.PI / 180;

type Local = readonly [number, number];

function toLocal(origin: CoursePosition, position: CoursePosition): Local {
  return [
    (position[0] - origin[0]) * METERS_PER_DEGREE * Math.cos(origin[1] * DEG),
    (position[1] - origin[1]) * METERS_PER_DEGREE,
  ];
}

function fromLocal(origin: CoursePosition, [east, north]: Local): CoursePosition {
  return [
    origin[0] + east / (METERS_PER_DEGREE * Math.cos(origin[1] * DEG)),
    origin[1] + north / METERS_PER_DEGREE,
  ];
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

// ── Course models (local metres, home at the origin) ───────────────────────────────────

const STEP = 10;

/** T22's own model: ±15° a step, held within ±35° of the outward heading. */
function winding(heading: number, length: number, random: () => number): Local[] {
  const line: Local[] = [[0, 0]];
  let east = 0;
  let north = 0;
  let direction = heading;
  for (let travelled = 0; travelled < length; travelled += STEP) {
    direction += (random() - 0.5) * 30 * DEG;
    direction = heading + Math.max(-35 * DEG, Math.min(35 * DEG, direction - heading));
    east += STEP * Math.cos(direction);
    north += STEP * Math.sin(direction);
    line.push([east, north]);
  }
  return line;
}

/** Straight stretch from `from` to `to`, a vertex every step (the far side of a loop). */
function straight(from: Local, to: Local): Local[] {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.max(1, Math.ceil(length / STEP));
  return Array.from({ length: count }, (_, index) => {
    const t = (index + 1) / count;
    return [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])] as const;
  });
}

/**
 * A loop from the home and back: out along one T22 path, across, and home along another
 * whose heading differs by 30–110°. Both ends are cut, and both count.
 */
function loop(heading: number, length: number, random: () => number): Local[] {
  const out = winding(heading, length, random);
  const turn = (30 + random() * 80) * DEG * (random() < 0.5 ? -1 : 1);
  const back = winding(heading + turn, length, random).reverse();
  const outEnd = out[out.length - 1] ?? [0, 0];
  const backStart = back[0] ?? [0, 0];
  return [...out, ...straight(outEnd, backStart).slice(0, -1), ...back];
}

/** A correlated random walk: the heading drifts ±8° (1σ) a step, with no bound at all. */
function correlatedWalk(heading: number, length: number, random: () => number): Local[] {
  const line: Local[] = [[0, 0]];
  let east = 0;
  let north = 0;
  let direction = heading;
  for (let travelled = 0; travelled < length; travelled += STEP) {
    direction += gaussian(random) * 8 * DEG;
    east += STEP * Math.cos(direction);
    north += STEP * Math.sin(direction);
    line.push([east, north]);
  }
  return line;
}

interface Grid {
  readonly angle: number;
  readonly shift: Local;
}

/** The grid's frame: to world metres, the home in grid coordinates, the corner nearest it. */
function gridFrame(grid: Grid, block: number) {
  const cos = Math.cos(grid.angle);
  const sin = Math.sin(grid.angle);
  const toWorld = ([u, v]: Local): Local => [
    grid.shift[0] + u * cos - v * sin,
    grid.shift[1] + u * sin + v * cos,
  ];
  const hx = -grid.shift[0];
  const hy = -grid.shift[1];
  const home: Local = [hx * cos + hy * sin, -hx * sin + hy * cos];
  const corner: Local = [Math.round(home[0] / block) * block, Math.round(home[1] / block) * block];
  return { toWorld, home, corner };
}

const GRID_DIRECTIONS: readonly Local[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/**
 * An 80 m street grid, turned and shifted at random for each zone: from the home to the
 * nearest corner, then block by block — straight on while that leads away (60 %), otherwise
 * mostly (85 %) onto a corner further from the home — never straight back.
 */
function gridWalk(grid: Grid, length: number, random: () => number): Local[] {
  const block = 80;
  const frame = gridFrame(grid, block);
  const home = frame.home;
  let corner = frame.corner;
  const line: Local[] = [[0, 0], ...straight([0, 0], frame.toWorld(corner))];
  const visited = new Set<string>([`${corner[0]},${corner[1]}`]);
  let previous = -1;
  let travelled = 0;
  while (travelled < length) {
    const from = corner;
    const options = GRID_DIRECTIONS.map((direction, index) => ({ direction, index })).filter(
      ({ index }) => previous < 0 || index !== (previous + 2) % 4,
    );
    const distance = (point: Local) => Math.hypot(point[0] - home[0], point[1] - home[1]);
    const next = (index: number): Local => {
      const direction = GRID_DIRECTIONS[index] ?? [1, 0];
      return [from[0] + direction[0] * block, from[1] + direction[1] * block];
    };
    const fresh = options.filter(({ index }) => !visited.has(next(index).join(',')));
    const pool = fresh.length > 0 ? fresh : options;
    const outward = pool.filter(({ index }) => distance(next(index)) > distance(from));
    // Streets are followed: straight on, when that still leads away, more often than not.
    const ahead = outward.find(({ index }) => index === previous);
    const choices = outward.length > 0 && random() < 0.85 ? outward : pool;
    const chosen =
      ahead !== undefined && random() < 0.6
        ? ahead
        : (choices[Math.floor(random() * choices.length)] ?? pool[0]);
    if (chosen === undefined) break;
    corner = next(chosen.index);
    visited.add(corner.join(','));
    previous = chosen.index;
    line.push(...straight(frame.toWorld(from), frame.toWorld(corner)));
    travelled += block;
  }
  return line;
}

/**
 * A staircase grid (this node's own reconstruction of the review r2 grid, kept as a model of
 * its own): the same 80 m grid, but the runner holds a bearing and staircases along it — at every corner the step
 * that keeps closest to the ray from the home at that bearing (85 %), otherwise the other
 * outward step, the bearing drifting ±4° (1σ) a block. Its lines keep their heading for many
 * blocks, which makes it the strongest model for the heading attackers.
 */
function gridStaircase(grid: Grid, heading: number, length: number, random: () => number): Local[] {
  const block = 80;
  const frame = gridFrame(grid, block);
  const home = frame.home;
  let corner = frame.corner;
  const line: Local[] = [[0, 0], ...straight([0, 0], frame.toWorld(corner))];
  let bearing = heading - grid.angle;
  let travelled = 0;
  while (travelled < length) {
    const from = corner;
    bearing += gaussian(random) * 4 * DEG;
    const ray: Local = [Math.cos(bearing), Math.sin(bearing)];
    const offRay = (point: Local) =>
      Math.abs((point[0] - home[0]) * ray[1] - (point[1] - home[1]) * ray[0]);
    const steps = GRID_DIRECTIONS.map((direction): Local => [
      from[0] + direction[0] * block,
      from[1] + direction[1] * block,
    ]).filter((point) => (point[0] - from[0]) * ray[0] + (point[1] - from[1]) * ray[1] > 1e-9);
    steps.sort((left, right) => offRay(left) - offRay(right));
    const chosen = (random() < 0.85 ? steps[0] : steps[1]) ?? steps[0];
    if (chosen === undefined) break;
    corner = chosen;
    line.push(...straight(frame.toWorld(from), frame.toWorld(corner)));
    travelled += block;
  }
  return line;
}

/**
 * The re-identification reviewer's r2 grid generator (round 2 of M2-01as), as the reviewer
 * specified it: axis-aligned 80 m blocks (the grid shifted at random, not turned); from the
 * corner nearest the home, every block straight on (50 %), a left turn (25 %) or a right turn
 * (25 %); and when the chosen step would lead back toward the home, the heading is flipped.
 */
function gridReview(grid: Grid, heading: number, length: number, random: () => number): Local[] {
  const block = 80;
  const frame = gridFrame({ angle: 0, shift: grid.shift }, block);
  const home = frame.home;
  let corner = frame.corner;
  const line: Local[] = [[0, 0], ...straight([0, 0], frame.toWorld(corner))];
  const distance = (point: Local) => Math.hypot(point[0] - home[0], point[1] - home[1]);
  let direction =
    Math.floor((((heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2)) % 4;
  let travelled = 0;
  while (travelled < length) {
    const from = corner;
    const turn = random();
    if (turn >= 0.5) direction = (direction + (turn < 0.75 ? 1 : 3)) % 4;
    const step = (index: number): Local => {
      const unit = GRID_DIRECTIONS[index] ?? [1, 0];
      return [from[0] + unit[0] * block, from[1] + unit[1] * block];
    };
    if (distance(step(direction)) < distance(from)) direction = (direction + 2) % 4;
    corner = step(direction);
    line.push(...straight(frame.toWorld(from), frame.toWorld(corner)));
    travelled += block;
  }
  return line;
}

// ── Estimators ─────────────────────────────────────────────────────────────────────────

/**
 * One cut end as the recipient sees it: where it is, and which way the line leaves it — the
 * direction to the point 60 m, 1 · S and 2 · S along the line (the whole line when shorter).
 */
export interface Observation {
  readonly point: Local;
  /** Unit vectors along the line away from the cut end, one per heading span. */
  readonly headings: readonly [Local, Local, Local];
}

/** The heading spans: 60 m, 1 · S and 2 · S. */
export type HeadingSpan = 0 | 1 | 2;

function pointAlong(line: readonly Local[], meters: number): Local | null {
  const start = line[0];
  if (start === undefined) return null;
  let travelled = 0;
  let far: Local = start;
  for (let index = 1; index < line.length; index += 1) {
    const from = line[index - 1];
    const to = line[index];
    if (from === undefined || to === undefined) continue;
    const segment = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (travelled + segment >= meters) {
      const t = segment === 0 ? 0 : (meters - travelled) / segment;
      return [from[0] + t * (to[0] - from[0]), from[1] + t * (to[1] - from[1])];
    }
    travelled += segment;
    far = to;
  }
  return far;
}

function observe(line: readonly Local[], scale: number): Observation | null {
  const point = line[0];
  if (point === undefined) return null;
  const headings: Local[] = [];
  for (const span of [60, scale, 2 * scale]) {
    const far = pointAlong(line, span);
    if (far === null) return null;
    const dx = far[0] - point[0];
    const dy = far[1] - point[1];
    const norm = Math.hypot(dx, dy);
    if (norm === 0) return null;
    headings.push([dx / norm, dy / norm]);
  }
  const [h0, h1, h2] = headings;
  if (!h0 || !h1 || !h2) return null;
  return { point, headings: [h0, h1, h2] };
}

/** Algebraic (Kåsa) least-squares circle fit: centre and radius, or null if degenerate. */
export function fitCircle(points: readonly Local[]): { center: Local; radius: number } | null {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  const n = points.length;
  if (n < 3) return null;
  // Centre the points first: the normal equations are badly conditioned far from the origin.
  const mx = points.reduce((sum, point) => sum + point[0], 0) / n;
  const my = points.reduce((sum, point) => sum + point[1], 0) / n;
  for (const [px, py] of points) {
    const x = px - mx;
    const y = py - my;
    const z = x * x + y * y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sx += x;
    sy += y;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }
  type Row = readonly [number, number, number];
  const det = (r0: Row, r1: Row, r2: Row) =>
    r0[0] * (r1[1] * r2[2] - r1[2] * r2[1]) -
    r0[1] * (r1[0] * r2[2] - r1[2] * r2[0]) +
    r0[2] * (r1[0] * r2[1] - r1[1] * r2[0]);
  const [b0, b1, b2] = [-sxz, -syz, -sz];
  const d = det([sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const dD = det([b0, sxy, sx], [b1, syy, sy], [b2, sy, n]);
  const dE = det([sxx, b0, sx], [sxy, b1, sy], [sx, b2, n]);
  const dF = det([sxx, sxy, b0], [sxy, syy, b1], [sx, sy, b2]);
  const D = dD / d;
  const E = dE / d;
  const F = dF / d;
  const radiusSquared = (D * D + E * E) / 4 - F;
  if (!(radiusSquared > 0)) return null;
  return { center: [mx - D / 2, my - E / 2], radius: Math.sqrt(radiusSquared) };
}

function mean(points: readonly Local[]): Local {
  const n = points.length;
  return [
    points.reduce((sum, point) => sum + point[0], 0) / n,
    points.reduce((sum, point) => sum + point[1], 0) / n,
  ];
}

/** The point nearest every back-projected line in the least-squares sense. */
export function backProjection(observations: readonly Observation[], span: HeadingSpan): Local {
  let a = 0;
  let b = 0;
  let c = 0;
  let px = 0;
  let py = 0;
  for (const { point, headings } of observations) {
    const [ux, uy] = headings[span];
    // I − u uᵀ projects onto the line's normal.
    const m00 = 1 - ux * ux;
    const m01 = -ux * uy;
    const m11 = 1 - uy * uy;
    a += m00;
    b += m01;
    c += m11;
    px += m00 * point[0] + m01 * point[1];
    py += m01 * point[0] + m11 * point[1];
  }
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-9) return mean(observations.map((observation) => observation.point));
  return [(c * px - b * py) / det, (a * py - b * px) / det];
}

/**
 * mleHead: the most likely home given how the links were cut. The cut ends lie on (or, past
 * a continuation, around) one ring whose centre is the home moved by a bounded offset (the
 * share design is public). So the search is confined to the disc of half the fitted radius
 * around the fitted centre — the spread of the cut ends — and scores each candidate by how
 * squarely every line leaves it (a von Mises heading likelihood). A coarse grid, then two
 * finer ones around the best point.
 */
export function mleHead(observations: readonly Observation[], span: HeadingSpan): Local {
  const points = observations.map((observation) => observation.point);
  const centroid = mean(points);
  const spread = Math.max(
    1,
    Math.sqrt(
      points.reduce(
        (sum, point) => sum + (point[0] - centroid[0]) ** 2 + (point[1] - centroid[1]) ** 2,
        0,
      ) / points.length,
    ),
  );
  const fitted = fitCircle(points);
  const disc =
    fitted !== null && fitted.radius < 4 * spread
      ? { center: fitted.center, radius: fitted.radius / 2 }
      : { center: centroid, radius: spread };
  const score = (hx: number, hy: number) => {
    let heading = 0;
    for (const { point, headings } of observations) {
      const outward = headings[span];
      const dx = point[0] - hx;
      const dy = point[1] - hy;
      const distance = Math.hypot(dx, dy);
      if (distance > 0) heading += 1 - (dx * outward[0] + dy * outward[1]) / distance;
    }
    return heading;
  };
  let best: Local = disc.center;
  let bestScore = score(best[0], best[1]);
  let half = disc.radius;
  let center = disc.center;
  for (const steps of [24, 10, 10]) {
    const step = (2 * half) / steps;
    for (let i = 0; i <= steps; i += 1)
      for (let j = 0; j <= steps; j += 1) {
        const hx = center[0] - half + i * step;
        const hy = center[1] - half + j * step;
        if (Math.hypot(hx - disc.center[0], hy - disc.center[1]) > disc.radius) continue;
        const value = score(hx, hy);
        if (value < bestScore) {
          bestScore = value;
          best = [hx, hy];
        }
      }
    center = best;
    half = step;
  }
  return best;
}

/**
 * Dead reckoning (the re-identification review r1 of M2-01as): past the continuation cut the
 * visible ends lie on a ring whose centre sits between the home and the share-circle centre.
 * Step back from every end along its own heading by the fitted ring radius, and average.
 * Untrained: it needs nothing but the links.
 */
export function deadReckoning(observations: readonly Observation[], span: HeadingSpan): Local {
  const points = observations.map((observation) => observation.point);
  const centroid = mean(points);
  const radius =
    fitCircle(points)?.radius ??
    points.reduce(
      (sum, point) => sum + Math.hypot(point[0] - centroid[0], point[1] - centroid[1]),
      0,
    ) / points.length;
  return mean(
    observations.map(({ point, headings }) => {
      const [ux, uy] = headings[span];
      return [point[0] - radius * ux, point[1] - radius * uy] as const;
    }),
  );
}

/** Every estimate an attacker computes from the links alone (no training). */
export const baseEstimators = [
  'circle-fit',
  'cut-mean',
  'back-projection',
  'back-projection-1s',
  'back-projection-2s',
  'mle-head',
  'mle-head-1s',
  'mle-head-2s',
  'dead-reckoning',
  'dead-reckoning-1s',
  'dead-reckoning-2s',
] as const;
export type BaseEstimator = (typeof baseEstimators)[number];

/** The learned attackers: a linear combination of every base estimate, trained elsewhere. */
export const learnedEstimators = ['learned-per-model', 'learned-pooled'] as const;
export type Estimator = BaseEstimator | (typeof learnedEstimators)[number];
export const estimators: readonly Estimator[] = [...baseEstimators, ...learnedEstimators];

export function estimate(estimator: BaseEstimator, observations: readonly Observation[]): Local {
  const points = observations.map((observation) => observation.point);
  switch (estimator) {
    case 'circle-fit':
      return fitCircle(points)?.center ?? mean(points);
    case 'cut-mean':
      return mean(points);
    case 'back-projection':
      return backProjection(observations, 0);
    case 'back-projection-1s':
      return backProjection(observations, 1);
    case 'back-projection-2s':
      return backProjection(observations, 2);
    case 'mle-head':
      return mleHead(observations, 0);
    case 'mle-head-1s':
      return mleHead(observations, 1);
    case 'mle-head-2s':
      return mleHead(observations, 2);
    case 'dead-reckoning':
      return deadReckoning(observations, 0);
    case 'dead-reckoning-1s':
      return deadReckoning(observations, 1);
    case 'dead-reckoning-2s':
      return deadReckoning(observations, 2);
  }
}

// ── The learned combiner ───────────────────────────────────────────────────────────────

/**
 * What one zone's N links gave the attacker: every base estimate, in metres with the home at
 * the origin (the attacker does not know the origin; every combination below is an affine
 * one, weights summing to 1, so it does not need to), and the zone's S.
 */
export interface ZoneEstimates {
  readonly model: CourseModel;
  readonly size: number;
  readonly scale: number;
  readonly estimates: Readonly<Record<BaseEstimator, Local>>;
}

/** Affine weights over the base estimates (they sum to 1), by group. */
export type Combiner = ReadonlyMap<string, readonly number[]>;

/** Solve A x = b (small, dense) by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, index) => [...row, b[index] ?? 0]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1)
      if (Math.abs(m[row]?.[column] ?? 0) > Math.abs(m[pivot]?.[column] ?? 0)) pivot = row;
    const swap = m[column];
    m[column] = m[pivot] ?? [];
    m[pivot] = swap ?? [];
    const lead = m[column]?.[column] ?? 0;
    if (Math.abs(lead) < 1e-12) continue;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = (m[row]?.[column] ?? 0) / lead;
      for (let k = column; k <= n; k += 1)
        (m[row] as number[])[k] = (m[row]?.[k] ?? 0) - factor * (m[column]?.[k] ?? 0);
    }
  }
  return m.map((row, index) => {
    const lead = row[index] ?? 0;
    return Math.abs(lead) < 1e-12 ? 0 : (row[n] ?? 0) / lead;
  });
}

/**
 * Train an affine combiner per group: h = e₀ + Σ wₖ (eₖ − e₀), least squares on the home
 * (the origin), every zone scaled by its S so large areas do not dominate, with a small ridge.
 */
export function trainCombiner(
  training: readonly ZoneEstimates[],
  groupOf: (zone: ZoneEstimates) => string,
): Combiner {
  const groups = new Map<string, ZoneEstimates[]>();
  for (const zone of training) {
    const key = groupOf(zone);
    groups.set(key, [...(groups.get(key) ?? []), zone]);
  }
  const combiner = new Map<string, number[]>();
  const k = baseEstimators.length - 1;
  for (const [key, zones] of groups) {
    const ata = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
    const atb = Array.from({ length: k }, () => 0);
    for (const zone of zones) {
      const base = zone.estimates[baseEstimators[0]];
      for (const axis of [0, 1] as const) {
        const row = baseEstimators
          .slice(1)
          .map((name) => (zone.estimates[name][axis] - base[axis]) / zone.scale);
        const target = -base[axis] / zone.scale;
        for (let i = 0; i < k; i += 1) {
          atb[i] = (atb[i] ?? 0) + (row[i] ?? 0) * target;
          for (let j = 0; j < k; j += 1)
            (ata[i] as number[])[j] = (ata[i]?.[j] ?? 0) + (row[i] ?? 0) * (row[j] ?? 0);
        }
      }
    }
    const trace = ata.reduce((sum, row, index) => sum + (row[index] ?? 0), 0);
    for (let i = 0; i < k; i += 1) (ata[i] as number[])[i] = (ata[i]?.[i] ?? 0) + 1e-6 * trace;
    const tail = solve(ata, atb);
    combiner.set(key, [1 - tail.reduce((sum, weight) => sum + weight, 0), ...tail]);
  }
  return combiner;
}

export function combine(weights: readonly number[], zone: ZoneEstimates): Local {
  let x = 0;
  let y = 0;
  baseEstimators.forEach((name, index) => {
    const weight = weights[index] ?? 0;
    x += weight * zone.estimates[name][0];
    y += weight * zone.estimates[name][1];
  });
  return [x, y];
}

export const perModelGroup = (zone: ZoneEstimates) => `${zone.model}|${zone.size}`;
export const pooledGroup = (zone: ZoneEstimates) => `${zone.size}`;

// ── The suite ──────────────────────────────────────────────────────────────────────────

const lineEnds = (coordinates: readonly CoursePosition[]): CourseWaypoint[] => {
  const start = coordinates[0];
  const finish = coordinates[coordinates.length - 1];
  if (!start || !finish) throw new Error('two ends');
  return [
    { role: 'start', position: start, name: null, sourceSampleId: null, locked: false },
    { role: 'finish', position: finish, name: null, sourceSampleId: null, locked: false },
  ];
};

const modelSeed: Record<CourseModel, number> = {
  t22: 1,
  't22-loop': 2,
  'correlated-walk': 3,
  'grid-80m': 4,
  'grid-80m-staircase': 5,
  'grid-80m-r2': 6,
};

/** Tries per link before a zone is given up for that N (counted, never silently). */
const ATTEMPTS_PER_LINK = 40;

/**
 * The circles one link is cut against: the product's `shareCircles`, or — exploration only —
 * the same pair built with another geometry or continuation.
 */
function circlesOf(
  zone: { readonly center: CoursePosition; readonly radiusMeters: number },
  offset: ShareOffset,
  options: SuiteOptions,
): DisclosureCircle[] {
  const scale = shareScaleMeters(zone.radiusMeters);
  const product = shareCircles(zone, offset);
  const geometry = options.geometry;
  const circles: DisclosureCircle[] =
    geometry === undefined
      ? product
      : [
          {
            center: fromLocal(zone.center, [
              offset.x * geometry.offsetFactor * scale,
              offset.y * geometry.offsetFactor * scale,
            ]),
            radiusMeters: geometry.radiusFactor * scale,
            continuationCutMeters: shareContinuationCutMeters(zone.radiusMeters),
          },
          ...product.slice(1),
        ];
  if (!options.continuation)
    return circles.map(({ center, radiusMeters }) => ({ center, radiusMeters }));
  const factor = options.continuationFactor;
  return factor === undefined
    ? circles
    : circles.map((circle) => ({ ...circle, continuationCutMeters: factor * scale }));
}

/**
 * The links of one zone, as the recipient sees them: the observations of each link's cut
 * ends (the start; both ends for a loop), or null for a course the share path refused.
 */
function shareOne(
  model: CourseModel,
  zone: { readonly center: CoursePosition; readonly radiusMeters: number },
  circles: readonly DisclosureCircle[],
  grid: Grid,
  random: () => number,
  touching: { count: number },
): Observation[] | null {
  const scale = shareScaleMeters(zone.radiusMeters);
  const length = (7 + 3 * random()) * scale;
  const heading = random() * 2 * Math.PI;
  const local =
    model === 't22'
      ? winding(heading, length, random)
      : model === 't22-loop'
        ? loop(heading, length, random)
        : model === 'correlated-walk'
          ? correlatedWalk(heading, length, random)
          : model === 'grid-80m'
            ? gridWalk(grid, length, random)
            : model === 'grid-80m-staircase'
              ? gridStaircase(grid, heading, length, random)
              : gridReview(grid, heading, length, random);
  const course = local.map((point) => fromLocal(zone.center, point));
  const choices = disclosureChoices('share', course, lineEnds(course), circles);
  const shared = choices.options[0];
  if (choices.classification.outcome !== 'ends-inside' || shared === undefined) return null;
  if (
    shared.coordinates.some((position) => insideAnyCircle(position, circles)) ||
    lineEntersAnyCircle(shared.coordinates, circles) ||
    shared.line.waypoints.some((waypoint) => insideAnyCircle(waypoint.position, circles))
  )
    touching.count += 1;
  const seen = shared.coordinates.map((position) => toLocal(zone.center, position));
  const observations: Observation[] = [];
  const start = observe(seen, scale);
  if (start) observations.push(start);
  if (model === 't22-loop') {
    const finish = observe([...seen].reverse(), scale);
    if (finish) observations.push(finish);
  }
  return observations;
}

interface Collected {
  readonly zones: ZoneEstimates[];
  readonly refusedCourses: number;
  readonly drawnCourses: number;
  readonly linesTouchingACircle: number;
  readonly observations: Partial<Record<CourseModel, number>>;
}

/** Share every zone's links and compute every base estimate, for one seed. */
function collect(options: SuiteOptions): Collected {
  const largest = Math.max(...options.sizes);
  let refusedCourses = 0;
  let drawnCourses = 0;
  const touching = { count: 0 };
  const seen: Partial<Record<CourseModel, number>> = {};
  const zones: ZoneEstimates[] = [];
  for (const model of options.models) {
    for (let zoneIndex = 0; zoneIndex < options.zones; zoneIndex += 1) {
      // One stream per model and zone: a zone's first links are the same whatever the
      // largest N, so the gating run (N ≤ the lifetime bound) and the full run (N = 50)
      // measure the same links for every N they share.
      const random = mulberry32(
        Math.imul(options.seed * 16 + modelSeed[model], 100_003) + zoneIndex * 7_919,
      );
      const center: CoursePosition = [-150 + random() * 300, -55 + random() * 110];
      const radiusMeters = 50 + random() * 350;
      const zone = { center, radiusMeters };
      const scale = shareScaleMeters(radiusMeters);
      const grid = { angle: random() * Math.PI, shift: [random() * 80, random() * 80] as Local };
      const zoneOffset = drawShareOffset(random);
      const offsetFor = (): ShareOffset =>
        options.offsets === 'zero'
          ? { x: 0, y: 0 }
          : options.offsets === 'per-link'
            ? drawShareOffset(random)
            : zoneOffset;
      const links: Observation[][] = [];
      for (let link = 0; link < largest; link += 1) {
        let observations: Observation[] | null = null;
        for (let attempt = 0; attempt < ATTEMPTS_PER_LINK && observations === null; attempt += 1) {
          drawnCourses += 1;
          observations = shareOne(
            model,
            zone,
            circlesOf(zone, offsetFor(), options),
            grid,
            random,
            touching,
          );
          if (observations === null) refusedCourses += 1;
        }
        if (observations === null) break;
        links.push(observations);
        seen[model] = (seen[model] ?? 0) + observations.length;
      }
      for (const size of options.sizes) {
        if (links.length < size) continue;
        const observations = links.slice(0, size).flat();
        if (observations.length < 3) continue;
        const estimates = Object.fromEntries(
          baseEstimators.map((name) => [name, estimate(name, observations)]),
        ) as Record<BaseEstimator, Local>;
        zones.push({ model, size, scale, estimates });
      }
    }
  }
  return {
    zones,
    refusedCourses,
    drawnCourses,
    linesTouchingACircle: touching.count,
    observations: seen,
  };
}

/** The learned attackers, trained on their own seeds. */
export interface TrainedAttackers {
  readonly perModel: Combiner;
  readonly pooled: Combiner;
}

/** Train both learned attackers on `training.seeds` (never a measured seed). */
export function trainAttackers(
  options: SuiteOptions & { readonly training: NonNullable<SuiteOptions['training']> },
): TrainedAttackers {
  const training = options.training.seeds.flatMap(
    (seed) => collect({ ...options, seed, zones: options.training.zones }).zones,
  );
  return {
    perModel: trainCombiner(training, perModelGroup),
    pooled: trainCombiner(training, pooledGroup),
  };
}

export function runAttackSuite(options: SuiteOptions): SuiteResult {
  const measured = collect(options);
  const trained =
    options.combiners ??
    (options.training ? trainAttackers({ ...options, training: options.training }) : null);
  const perModel: Combiner | null = trained?.perModel ?? null;
  const pooled: Combiner | null = trained?.pooled ?? null;
  const names: readonly Estimator[] = trained ? estimators : baseEstimators;
  const cells = new Map<string, { errorsMeters: number[]; errorsScaled: number[] }>();
  const key = (model: CourseModel, estimator: Estimator, size: number) =>
    `${model}|${estimator}|${size}`;
  const record = (zone: ZoneEstimates, estimator: Estimator, [x, y]: Local) => {
    const error = Math.hypot(x, y);
    const cell = cells.get(key(zone.model, estimator, zone.size)) ?? {
      errorsMeters: [],
      errorsScaled: [],
    };
    cell.errorsMeters.push(error);
    cell.errorsScaled.push(error / zone.scale);
    cells.set(key(zone.model, estimator, zone.size), cell);
  };
  for (const zone of measured.zones) {
    for (const name of baseEstimators) record(zone, name, zone.estimates[name]);
    const modelWeights = perModel?.get(perModelGroup(zone));
    if (modelWeights) record(zone, 'learned-per-model', combine(modelWeights, zone));
    const pooledWeights = pooled?.get(pooledGroup(zone));
    if (pooledWeights) record(zone, 'learned-pooled', combine(pooledWeights, zone));
  }
  const result: Cell[] = [];
  for (const model of options.models)
    for (const estimator of names)
      for (const size of options.sizes) {
        const cell = cells.get(key(model, estimator, size));
        result.push({
          model,
          estimator,
          size,
          errorsMeters: cell?.errorsMeters ?? [],
          errorsScaled: cell?.errorsScaled ?? [],
        });
      }
  return {
    cells: result,
    refusedCourses: measured.refusedCourses,
    drawnCourses: measured.drawnCourses,
    linesTouchingACircle: measured.linesTouchingACircle,
    observations: measured.observations,
  };
}

// ── Thresholds ─────────────────────────────────────────────────────────────────────────

export const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

/** The acceptance bound of M2-01as, both relative to S and in metres. */
export const shareReidentificationBound = {
  medianScaled: 0.3,
  p10Scaled: 0.1,
  medianMeters: 60,
  p10Meters: 20,
} as const;

export interface CellVerdict {
  readonly medianScaled: number;
  readonly p10Scaled: number;
  readonly medianMeters: number;
  readonly p10Meters: number;
  /** The bounds this cell misses, by name; empty when it passes. */
  readonly failures: readonly (keyof typeof shareReidentificationBound)[];
}

/** Judge one cell against every bound. A cell with no zones fails every bound. */
export function judgeCell(cell: {
  readonly errorsMeters: readonly number[];
  readonly errorsScaled: readonly number[];
}): CellVerdict {
  const medianScaled = quantile(cell.errorsScaled, 0.5);
  const p10Scaled = quantile(cell.errorsScaled, 0.1);
  const medianMeters = quantile(cell.errorsMeters, 0.5);
  const p10Meters = quantile(cell.errorsMeters, 0.1);
  const failures: (keyof typeof shareReidentificationBound)[] = [];
  const bound = shareReidentificationBound;
  if (!(medianScaled >= bound.medianScaled)) failures.push('medianScaled');
  if (!(p10Scaled >= bound.p10Scaled)) failures.push('p10Scaled');
  if (!(medianMeters >= bound.medianMeters)) failures.push('medianMeters');
  if (!(p10Meters >= bound.p10Meters)) failures.push('p10Meters');
  return { medianScaled, p10Scaled, medianMeters, p10Meters, failures };
}

/** A fixed-width text table of every cell, for the progress record. */
export function formatCells(cells: readonly Cell[]): string {
  const lines = [
    'model            estimator            N   zones  med/S  p10/S  med m  p10 m  pass',
  ];
  for (const cell of cells) {
    const verdict = judgeCell(cell);
    lines.push(
      [
        cell.model.padEnd(16),
        cell.estimator.padEnd(20),
        String(cell.size).padStart(2),
        String(cell.errorsScaled.length).padStart(6),
        verdict.medianScaled.toFixed(2).padStart(6),
        verdict.p10Scaled.toFixed(2).padStart(6),
        verdict.medianMeters.toFixed(0).padStart(6),
        verdict.p10Meters.toFixed(0).padStart(6),
        verdict.failures.length === 0 ? '  yes' : `  NO (${verdict.failures.join(',')})`,
      ].join(' '),
    );
  }
  return lines.join('\n');
}
