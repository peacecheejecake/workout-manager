import type { CoursePosition, CourseWaypoint } from '@workout/contracts/courses';
import { describe, expect, it } from 'vitest';

import {
  classifyDisclosure,
  disclosureChoices,
  drawShareOffset,
  finishDisclosedLine,
  removedVerticesPerCircle,
  roundPosition,
  shareCircle,
  shareCircles,
  shareCircleSet,
  shareContinuationCutMeters,
  shareCutAreaIndexes,
  shareScaleMeters,
  sharedLineTouchesCircle,
  type ShareOffset,
} from '../src/disclosure.js';
import { greatCircleMeters, segmentDistanceToPointMeters } from '../src/geo.js';
import type { ProtectedCircle } from '../src/privacy-trim.js';

/**
 * What a course discloses when it leaves (M2-01k-o §2–§5, B-1, R-2, T3, T22, T25).
 *
 * Every coordinate below is synthetic. No personal location is used anywhere in this file.
 */
const home: ProtectedCircle = { center: [127.02, 37.5], radiusMeters: 200 };

const ends = (coordinates: readonly CoursePosition[], startName: string | null = '집 앞') => {
  const start = coordinates[0];
  const finish = coordinates.at(-1);
  if (!start || !finish) throw new Error('two ends');
  return [
    { role: 'start', position: start, name: startName, sourceSampleId: null, locked: false },
    { role: 'finish', position: finish, name: null, sourceSampleId: null, locked: false },
  ] satisfies CourseWaypoint[];
};

/** Every vertex and waypoint outside every circle, and no segment touching one (T3). */
function assertOutside(
  line: { coordinates: readonly CoursePosition[]; waypoints: readonly CourseWaypoint[] },
  circles: readonly ProtectedCircle[],
) {
  for (const circle of circles) {
    for (const position of line.coordinates)
      expect(greatCircleMeters(circle.center, position)).toBeGreaterThan(circle.radiusMeters);
    for (const waypoint of line.waypoints)
      expect(greatCircleMeters(circle.center, waypoint.position)).toBeGreaterThan(
        circle.radiusMeters,
      );
    for (let index = 1; index < line.coordinates.length; index += 1) {
      const from = line.coordinates[index - 1];
      const to = line.coordinates[index];
      if (!from || !to) continue;
      expect(segmentDistanceToPointMeters(from, to, circle.center)).toBeGreaterThan(
        circle.radiusMeters,
      );
    }
  }
}

const outAndBack: CoursePosition[] = [
  [127.02, 37.5],
  [127.0205, 37.5005],
  [127.03, 37.51],
  [127.04, 37.52],
  [127.0205, 37.5006],
  [127.02, 37.5001],
];
/** The same line with a vertex at least every `meters` (straight interpolation). */
function densify(line: readonly CoursePosition[], meters: number): CoursePosition[] {
  const dense: CoursePosition[] = [];
  for (let index = 1; index < line.length; index += 1) {
    const from = line[index - 1];
    const to = line[index];
    if (!from || !to) continue;
    const steps = Math.max(1, Math.ceil(greatCircleMeters(from, to) / meters));
    for (let step = 0; step < steps; step += 1)
      dense.push([
        from[0] + ((to[0] - from[0]) * step) / steps,
        from[1] + ((to[1] - from[1]) * step) / steps,
      ]);
  }
  const last = line.at(-1);
  if (last) dense.push(last);
  return dense;
}
const elsewhere: CoursePosition[] = [
  [127.1, 37.6],
  [127.11, 37.61],
  [127.12, 37.62],
];

describe('the disclosure classification (§5 table)', () => {
  it('offers the exact line with a warning when there is no protected area, GPX only (D3a, D3c)', () => {
    const exportChoices = disclosureChoices('export', outAndBack, ends(outAndBack), []);
    expect(exportChoices.classification.outcome).toBe('no-zones');
    expect(exportChoices.options.map((option) => option.exposure)).toEqual(['no-zones-exact']);
    expect(exportChoices.options[0]?.requiresAcknowledgement).toBe(true);
    // Rounded to five places (R-2): only owner-exact keeps seven.
    expect(exportChoices.options[0]?.coordinateDigits).toBe(5);
    const shareChoices = disclosureChoices('share', outAndBack, ends(outAndBack), []);
    expect(shareChoices.options).toEqual([]);
  });

  it('blocks a refused trim for both purposes (D3)', () => {
    const reentry: CoursePosition[] = [
      [127.03, 37.51],
      [127.04, 37.52],
      [127.02, 37.5],
      [127.05, 37.53],
    ];
    for (const purpose of ['export', 'share'] as const) {
      const choices = disclosureChoices(purpose, reentry, ends(reentry), [home]);
      expect(choices.classification).toEqual({
        outcome: 'blocked',
        reason: 'COURSE_TRIM_SPLITS_THE_LINE',
      });
      expect(choices.options).toEqual([]);
    }
  });

  it('lets a line that touches no area leave as it is, rounded', () => {
    const choices = disclosureChoices('export', elsewhere, ends(elsewhere), [home]);
    expect(choices.classification.outcome).toBe('no-intersection');
    expect(choices.options.map((option) => option.exposure)).toEqual(['no-zone-intersection']);
    expect(choices.options[0]?.startShiftMeters).toBe(0);
    // The owner's own start name survives an untouched end.
    expect(choices.options[0]?.line.waypoints[0]?.name).toBe('집 앞');
  });

  it('defaults to the trimmed line and offers the exact one only to the owner GPX (D3b)', () => {
    const exportChoices = disclosureChoices('export', outAndBack, ends(outAndBack), [home]);
    expect(exportChoices.classification.outcome).toBe('ends-inside');
    expect(exportChoices.defaultExposure).toBe('trimmed');
    expect(exportChoices.options.map((option) => option.exposure)).toEqual([
      'trimmed',
      'owner-exact',
    ]);
    const exact = exportChoices.options[1];
    expect(exact?.requiresAcknowledgement).toBe(true);
    expect(exact?.coordinateDigits).toBe(7);
    expect(exact?.coordinates).toEqual(outAndBack);
    const trimmed = exportChoices.options[0];
    expect(trimmed?.appendsRevision).toBe(true);
    expect(trimmed?.startShiftMeters).toBeGreaterThan(0);
    if (!trimmed) throw new Error('unreachable');
    assertOutside(trimmed.line, [home]);
    // The cut end is the unnamed end of the line, never the owner's named doorstep.
    expect(trimmed.line.waypoints[0]?.name).toBeNull();

    const shareChoices = disclosureChoices('share', outAndBack, ends(outAndBack), [home]);
    expect(shareChoices.options.map((option) => option.exposure)).toEqual(['trimmed']);
    expect(shareChoices.options[0]?.appendsRevision).toBe(false);
  });

  it('removes a via waypoint inside a circle from a line that never touches one', () => {
    const waypoints: CourseWaypoint[] = [
      ...ends(elsewhere).slice(0, 1),
      { role: 'via', position: [127.02, 37.5], name: '현관', sourceSampleId: null, locked: false },
      ...ends(elsewhere).slice(1),
    ];
    const choices = disclosureChoices('export', elsewhere, waypoints, [home]);
    const line = choices.options[0]?.line;
    expect(line?.waypoints.map((waypoint) => waypoint.name)).toEqual(['집 앞', null]);
    if (!line) throw new Error('unreachable');
    assertOutside(line, [home]);
  });
});

describe('rounding is checked again after it happens (R-2, T25)', () => {
  it('rounds every disclosed coordinate to five decimals', () => {
    const choices = disclosureChoices('export', outAndBack, ends(outAndBack), [home]);
    for (const position of choices.options[0]?.coordinates ?? [])
      for (const ordinate of position) expect(Math.round(ordinate * 1e5) / 1e5).toBe(ordinate);
  });

  it('drops a kept vertex that rounding pushes back into the circle', () => {
    const center: CoursePosition = [127, 37.5];
    // A grid point just inside the circle, and a raw vertex a few decimetres further out
    // that rounds onto it: outside before rounding, inside after.
    const grid: CoursePosition = [127.003, 37.5];
    const raw: CoursePosition = [127.0030049, 37.5];
    const circle: ProtectedCircle = { center, radiusMeters: greatCircleMeters(center, grid) + 0.2 };
    expect(greatCircleMeters(center, raw)).toBeGreaterThan(circle.radiusMeters);
    expect(roundPosition(raw, 5)).toEqual(grid);
    const line: CoursePosition[] = [center, raw, [127.01, 37.5], [127.02, 37.5]];
    const classification = classifyDisclosure(line, ends(line), [circle]);
    if (classification.outcome !== 'ends-inside') throw new Error('expected a trim');
    // Before the re-check the kept start is the raw vertex.
    expect(classification.trimmed.coordinates[0]).toEqual(raw);
    const finished = finishDisclosedLine({
      coordinates: classification.trimmed.coordinates,
      waypoints: classification.trimmed.waypoints,
      circles: [circle],
      cutStart: true,
      cutFinish: false,
    });
    expect(finished.coordinates[0]).toEqual([127.01, 37.5]);
    assertOutside(finished, [circle]);
  });

  it('counts an end only rounding pulls into a circle as removed there (M2-01ax)', () => {
    const center: CoursePosition = [127, 37.5];
    // The end itself is the raw vertex: outside the circle before rounding, inside after.
    const grid: CoursePosition = [127.003, 37.5];
    const raw: CoursePosition = [127.0030049, 37.5];
    const circle: ProtectedCircle = { center, radiusMeters: greatCircleMeters(center, grid) + 0.2 };
    const line: CoursePosition[] = [raw, [127.01, 37.5], [127.02, 37.5], [127.03, 37.5]];
    for (const position of line)
      expect(greatCircleMeters(center, position)).toBeGreaterThan(circle.radiusMeters);
    // The confirmation cuts that end (it is classified on the rounded line) …
    const choice = disclosureChoices('export', line, ends(line), [circle]).options[0];
    expect(choice?.exposure).toBe('trimmed');
    expect(choice?.coordinates[0]).toEqual([127.01, 37.5]);
    // … so the screen says this area removes it, not "0 vertices" (and an area the line
    // never comes near still removes nothing).
    const away: ProtectedCircle = { center: [127.2, 37.7], radiusMeters: 200 };
    expect(removedVerticesPerCircle(line, [circle, away])).toEqual([1, 0]);
  });
});

describe('share circles (B-1)', () => {
  it('scales to S = max(r, 200 m), R_eff = 2 S, offset ≤ 1 S, and keeps the protected area inside', () => {
    for (const radiusMeters of [50, 199, 200, 350, 5000]) {
      const zone = { center: [127.02, 37.5] as CoursePosition, radiusMeters };
      const scale = shareScaleMeters(radiusMeters);
      expect(scale).toBe(Math.max(radiusMeters, 200));
      for (const offset of [
        { x: 1, y: 0 },
        { x: 0, y: -1 },
        { x: Math.SQRT1_2, y: Math.SQRT1_2 },
        { x: 0, y: 0 },
      ]) {
        const circle = shareCircle(zone, offset);
        expect(circle.radiusMeters).toBeCloseTo(2 * scale, 6);
        const shift = greatCircleMeters(zone.center, circle.center);
        expect(shift).toBeLessThanOrEqual(scale + 0.01);
        // Placed on a flat local map, measured on the sphere: within a metre per 5 km.
        expect(Math.abs(shift - scale * Math.hypot(offset.x, offset.y))).toBeLessThan(
          0.5 + scale * 2e-4,
        );
        // The area itself lies wholly inside the share circle.
        expect(shift + radiusMeters).toBeLessThanOrEqual(circle.radiusMeters + 0.01);
      }
    }
  });

  it('draws offsets from the unit disc, uniformly by area', () => {
    let state = 7;
    const unit = () => {
      state = (state * 1103515245 + 12345) % 2 ** 31;
      return state / 2 ** 31;
    };
    const offsets = Array.from({ length: 4000 }, () => drawShareOffset(unit));
    expect(offsets.every((offset) => Math.hypot(offset.x, offset.y) <= 1)).toBe(true);
    const insideHalf = offsets.filter((offset) => Math.hypot(offset.x, offset.y) <= Math.SQRT1_2);
    // Uniform by area: half of the points lie within radius 1/√2.
    expect(insideHalf.length / offsets.length).toBeGreaterThan(0.45);
    expect(insideHalf.length / offsets.length).toBeLessThan(0.55);
    expect(drawShareOffset()).not.toEqual(drawShareOffset());
  });

  it('says whether a stored link touches a newly added circle (B-6)', () => {
    const snapshot = { coordinates: elsewhere, waypoints: ends(elsewhere) };
    expect(sharedLineTouchesCircle(snapshot, home)).toBe(false);
    expect(sharedLineTouchesCircle(snapshot, { center: [127.11, 37.61], radiusMeters: 50 })).toBe(
      true,
    );
    // A segment passing through, with both vertices outside.
    expect(sharedLineTouchesCircle(snapshot, { center: [127.105, 37.605], radiusMeters: 60 })).toBe(
      true,
    );
  });
});

// ── T22: re-identification by circle fitting, on synthetic data only ─────────────────────

/** A small deterministic PRNG so the simulation is the same on every run. */
function mulberry32(seed: number): () => number {
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

function toLocal(origin: CoursePosition, position: CoursePosition): [number, number] {
  return [
    (position[0] - origin[0]) * METERS_PER_DEGREE * Math.cos((origin[1] * Math.PI) / 180),
    (position[1] - origin[1]) * METERS_PER_DEGREE,
  ];
}

function fromLocal(origin: CoursePosition, east: number, north: number): CoursePosition {
  return [
    origin[0] + east / (METERS_PER_DEGREE * Math.cos((origin[1] * Math.PI) / 180)),
    origin[1] + north / METERS_PER_DEGREE,
  ];
}

/** Algebraic (Kåsa) least-squares circle fit; returns the centre. */
function fitCircleCenter(points: readonly [number, number][]): [number, number] {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sxz = 0;
  let syz = 0;
  let sz = 0;
  const n = points.length;
  for (const [x, y] of points) {
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
  // Solve [sxx sxy sx; sxy syy sy; sx sy n] [D E F]ᵀ = -[sxz syz sz]ᵀ by Cramer's rule.
  type Row = readonly [number, number, number];
  const det = (r0: Row, r1: Row, r2: Row) =>
    r0[0] * (r1[1] * r2[2] - r1[2] * r2[1]) -
    r0[1] * (r1[0] * r2[2] - r1[2] * r2[0]) +
    r0[2] * (r1[0] * r2[1] - r1[1] * r2[0]);
  const [b0, b1, b2] = [-sxz, -syz, -sz];
  const d = det([sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]);
  const dD = det([b0, sxy, sx], [b1, syy, sy], [b2, sy, n]);
  const dE = det([sxx, b0, sx], [sxy, b1, sy], [sx, b2, n]);
  return [-(dD / d) / 2, -(dE / d) / 2];
}

/** A winding course that starts at `start` and heads away along `heading` (radians). */
function windingCourse(
  start: CoursePosition,
  heading: number,
  lengthMeters: number,
  random: () => number,
): CoursePosition[] {
  const step = 10;
  const line: CoursePosition[] = [start];
  let east = 0;
  let north = 0;
  let direction = heading;
  for (let travelled = 0; travelled < lengthMeters; travelled += step) {
    // Wander up to ±15° a step, held within ±35° of the outward heading. Seen from a share
    // circle's centre (at most 0.5 S from the home, radius 1.5 S) the outward direction is
    // then at most 19.5° + 35° off radial where the course crosses the edge, so the course
    // leaves the circle once and never turns back into it.
    direction += ((random() - 0.5) * (30 * Math.PI)) / 180;
    direction =
      heading +
      Math.max(-(35 * Math.PI) / 180, Math.min((35 * Math.PI) / 180, direction - heading));
    east += step * Math.cos(direction);
    north += step * Math.sin(direction);
    line.push(fromLocal(start, east, north));
  }
  return line;
}

interface Simulation {
  /** error / S for every zone, one array per N. */
  readonly normalizedErrors: Map<number, number[]>;
  readonly blocked: number;
}

/**
 * The reviewer's attack, with our own share trim: synthetic homes, N shared courses from
 * each home in random directions, a circle fitted to the shared starts, and the distance
 * from the fitted centre to the home measured in units of S.
 *
 * `offsetFor(zoneIndex, linkIndex)` is where the offset of a link comes from. The product
 * stores one per zone; the negative controls pass a zero offset (V19) or a fresh one per
 * link (V19b) to show that the thresholds have the power to catch either.
 */
function simulate(
  offsetFor: (zone: number, link: number, random: () => number) => ShareOffset,
  sizes: readonly number[] = [3, 5, 10, 20],
  zones = 500,
): Simulation {
  const random = mulberry32(20260925);
  const normalizedErrors = new Map<number, number[]>(sizes.map((size) => [size, []]));
  let blocked = 0;
  for (let zoneIndex = 0; zoneIndex < zones; zoneIndex += 1) {
    const center: CoursePosition = [-150 + random() * 300, -55 + random() * 110];
    const radiusMeters = 50 + random() * 350;
    const scale = shareScaleMeters(radiusMeters);
    const zone = { center, radiusMeters };
    for (const size of sizes) {
      const starts: [number, number][] = [];
      for (let link = 0; link < size; link += 1) {
        const circle = shareCircle(zone, offsetFor(zoneIndex, link, random));
        // 8 · S: a link loses up to 3 · S inside the share circle and a further 2.5 · S of
        // path past it (M2-01as); shorter walks would be refused.
        const course = windingCourse(center, random() * 2 * Math.PI, 8 * scale, random);
        const choices = disclosureChoices('share', course, ends(course, null), [circle]);
        const shared = choices.options[0];
        if (choices.classification.outcome !== 'ends-inside' || !shared) {
          blocked += 1;
          continue;
        }
        starts.push(toLocal(center, shared.start));
      }
      if (starts.length < 3) continue;
      const [x, y] = fitCircleCenter(starts);
      normalizedErrors.get(size)?.push(Math.hypot(x, y) / scale);
    }
  }
  return { normalizedErrors, blocked };
}

const quantile = (values: readonly number[], q: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

describe('re-identification review r1 (R-2, R-3)', () => {
  // A 5 km area whose offset points south-west, and a grid point of its north-east edge that
  // its share circle misses: inside the area and outside the share circle, about 7 cm each.
  const wide = { center: [127.02, 37.5] as CoursePosition, radiusMeters: 5000 };
  const angle = (2 * Math.PI * 38) / 64;
  const southWest: ShareOffset = { x: 0.999999 * Math.cos(angle), y: 0.999999 * Math.sin(angle) };
  const sliver: CoursePosition = [127.06716, 37.52495];
  // From about 27 km north-east straight to the sliver: long enough that a link still has a
  // line left after the continuation cut of 2.5 · S = 12.5 km (M2-01as) past the cut end.
  const towardSliver: CoursePosition[] = [
    ...Array.from(
      { length: 25 },
      (_, index) => [127.09536 + 0.0094 * (25 - index), 37.54004 + 0.00503 * (25 - index)] as const,
    ).map(([longitude, latitude]): CoursePosition => [longitude, latitude]),
    [127.09536, 37.54004],
    [127.08596, 37.53501],
    [127.07656, 37.52998],
    sliver,
  ];

  it('R-2: the share circle alone misses a sliver of a large area; the pair does not', () => {
    const alone = shareCircle(wide, southWest);
    expect(greatCircleMeters(wide.center, sliver)).toBeLessThan(wide.radiusMeters);
    expect(greatCircleMeters(alone.center, sliver)).toBeGreaterThan(alone.radiusMeters);
    // With the share circle alone the line would leave with its end inside the area.
    const leaky = disclosureChoices('share', towardSliver, ends(towardSliver), [alone]);
    expect(leaky.classification.outcome).toBe('no-intersection');
    // With the area as well it is cut, and nothing that leaves is inside either circle.
    const circles = shareCircles(wide, southWest);
    expect(circles).toEqual([
      alone,
      {
        center: wide.center,
        radiusMeters: wide.radiusMeters,
        continuationCutMeters: 2.5 * wide.radiusMeters,
      },
    ]);
    const cut = disclosureChoices('share', towardSliver, ends(towardSliver), circles);
    expect(cut.classification.outcome).toBe('ends-inside');
    const line = cut.options[0]?.line;
    if (!line) throw new Error('no line');
    assertOutside(line, circles);
    expect(line.coordinates).not.toContainEqual(sliver);
    // The zone-add re-check sees the sliver too.
    const snapshot = { coordinates: towardSliver, waypoints: ends(towardSliver) };
    expect(sharedLineTouchesCircle(snapshot, alone)).toBe(false);
    expect(circles.some((circle) => sharedLineTouchesCircle(snapshot, circle))).toBe(true);
  });

  it('R-3: a link’s ends are always its line’s ends; the owner GPX keeps an uncut end', () => {
    // A line far from the area whose start waypoint sits beside its first vertex.
    const line: CoursePosition[] = [
      [127.05, 37.52],
      [127.051, 37.5205],
      [127.052, 37.521],
    ];
    const waypoints: CourseWaypoint[] = [
      {
        role: 'start',
        position: [127.0501, 37.5201],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
      {
        role: 'finish',
        position: [127.052, 37.521],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ];
    const circles = [shareCircle(home, { x: 0, y: 0 })];
    const share = disclosureChoices('share', line, waypoints, circles);
    expect(share.classification.outcome).toBe('no-intersection');
    const shared = share.options[0]?.line;
    if (!shared) throw new Error('no line');
    expect(shared.waypoints[0]?.position).toEqual(shared.coordinates[0]);
    expect(shared.waypoints.at(-1)?.position).toEqual(shared.coordinates.at(-1));
    const owner = disclosureChoices('export', line, waypoints, [home]);
    expect(owner.options[0]?.line.waypoints[0]?.position).toEqual([127.0501, 37.5201]);
    // And when an end is cut, the link's end is the cut line's end, as before. (A vertex every
    // 50 m, so the line outlives the 2.5 · S continuation cut at both ends.)
    const dense = densify(outAndBack, 50);
    const cut = disclosureChoices('share', dense, ends(dense), circles).options[0]?.line;
    if (!cut) throw new Error('no line');
    expect(cut.waypoints[0]?.position).toEqual(cut.coordinates[0]);
    expect(cut.waypoints.at(-1)?.position).toEqual(cut.coordinates.at(-1));
  });
});

describe('T22: circle fitting over many shared starts cannot find the home', () => {
  it('keeps the median error ≥ 0.3 S and the 10th percentile ≥ 0.1 S for N = 3, 5, 10, 20', () => {
    // One offset per zone, drawn once — what the product stores (B-1).
    const stored = new Map<number, ShareOffset>();
    const result = simulate((zone, _link, random) => {
      const existing = stored.get(zone);
      if (existing) return existing;
      const drawn = drawShareOffset(random);
      stored.set(zone, drawn);
      return drawn;
    });
    // A handful of synthetic walks graze an edge within the rounding metre and are refused
    // (T25 at work); the attack is still run on essentially every zone.
    expect(result.blocked).toBeLessThan(0.01 * 500 * (3 + 5 + 10 + 20));
    for (const [size, errors] of result.normalizedErrors) {
      expect(errors.length, `zones fitted for N=${size}`).toBeGreaterThanOrEqual(495);
      expect(quantile(errors, 0.5), `median, N=${size}`).toBeGreaterThanOrEqual(0.3);
      expect(quantile(errors, 0.1), `p10, N=${size}`).toBeGreaterThanOrEqual(0.1);
    }
  }, 120_000);

  it('has the power to catch a zero offset (V19) and a fresh offset per link (V19b)', () => {
    const zero = simulate(() => ({ x: 0, y: 0 }), [3, 20], 200);
    // M2-01as: the continuation cut scatters the cut ends along 2.5 · S of path, so a zero
    // offset no longer puts them on one circle about the home (median 0.03 · S before it,
    // about 0.15 · S now at N = 3) — still far under the bound, and 0.03 · S by N = 20.
    expect(quantile(zero.normalizedErrors.get(3) ?? [], 0.5)).toBeLessThan(0.3);
    expect(quantile(zero.normalizedErrors.get(20) ?? [], 0.5)).toBeLessThan(0.1);
    const perLink = simulate((_zone, _link, random) => drawShareOffset(random), [20], 200);
    // The offsets average away as links accumulate: N = 20 collapses below the bound.
    expect(quantile(perLink.normalizedErrors.get(20) ?? [], 0.5)).toBeLessThan(0.3);
  }, 120_000);
});

describe('M2-01as: a link loses a further 2.5 · S of path past each cut end', () => {
  // S = 200 m: the share circle (offset 0) has radius 400 m and the continuation is 500 m.
  const circles = shareCircles(home, { x: 0, y: 0 });
  const east: CoursePosition[] = densify(
    [
      [127.02, 37.5],
      [127.0426, 37.5],
    ],
    10,
  );

  it('moves the cut end 500 m further along the line, for a link only', () => {
    expect(shareContinuationCutMeters(home.radiusMeters)).toBe(500);
    const share = disclosureChoices('share', east, ends(east), circles).options[0]?.line;
    if (!share) throw new Error('no link line');
    const start = share.coordinates[0];
    if (!start) throw new Error('no start');
    // First vertex past 400 m, then at least 500 m more of path; never more than one step on.
    expect(greatCircleMeters(home.center, start)).toBeGreaterThanOrEqual(900);
    expect(greatCircleMeters(home.center, start)).toBeLessThan(920);
    expect(share.waypoints[0]?.position).toEqual(start);
    assertOutside(share, circles);
    // The owner's GPX is cut against the area itself and continues nothing (D10).
    const gpx = disclosureChoices('export', east, ends(east), [home]).options[0]?.line;
    const gpxStart = gpx?.coordinates[0];
    if (!gpxStart) throw new Error('no GPX line');
    expect(greatCircleMeters(home.center, gpxStart)).toBeLessThan(215);
    // And a circle that carries no continuation cuts exactly as before.
    const plain = circles.map(({ center, radiusMeters }) => ({ center, radiusMeters }));
    const before = disclosureChoices('share', east, ends(east), plain).options[0]?.line;
    const beforeStart = before?.coordinates[0];
    if (!beforeStart) throw new Error('no line');
    expect(greatCircleMeters(home.center, beforeStart)).toBeLessThan(415);
  });

  it('cuts both ends of a loop, and refuses a link too short to outlive it', () => {
    const loop = [...east, ...[...east].reverse().slice(1)].map(
      (position, index, all): CoursePosition =>
        // Bring the way back 100 m north, so it is a loop and not the same line twice.
        index >= all.length / 2 ? [position[0], position[1] + 0.0009] : position,
    );
    const shared = disclosureChoices('share', loop, ends(loop), circles).options[0]?.line;
    const first = shared?.coordinates[0];
    const last = shared?.coordinates.at(-1);
    if (!first || !last) throw new Error('no loop line');
    expect(greatCircleMeters(home.center, first)).toBeGreaterThanOrEqual(900);
    expect(greatCircleMeters(home.center, last)).toBeGreaterThanOrEqual(890);
    // 400 m inside the circle, then 500 m more: a 700 m line keeps nothing and is refused.
    const short = east.slice(0, 71);
    const refused = disclosureChoices('share', short, ends(short), circles);
    expect(refused.classification).toEqual({
      outcome: 'blocked',
      reason: 'COURSE_TRIM_REMOVES_EVERYTHING',
    });
    // The owner's own GPX of that course is still offered.
    expect(disclosureChoices('export', short, ends(short), [home]).options[0]?.exposure).toBe(
      'trimmed',
    );
  });

  it('continues by the largest continuation when nested areas both hold the cut end', () => {
    // Review r2 peer finding 3: two areas over the same home, 100 m (S 200: share radius 400 m,
    // continuation 500 m) and 400 m (S 400: share radius 800 m, continuation 1,000 m). The cut
    // end is past the larger share circle and then 1,000 m more — never the smaller 500 m.
    const inner = { center: home.center, radiusMeters: 100 };
    const outer = { center: home.center, radiusMeters: 400 };
    const nested = shareCircleSet([
      { zone: inner, offset: { x: 0, y: 0 } },
      { zone: outer, offset: { x: 0, y: 0 } },
    ]);
    const long = densify(
      [
        [127.02, 37.5],
        [127.07, 37.5],
      ],
      10,
    );
    for (const circles of [nested, [...nested].reverse()]) {
      const start = disclosureChoices('share', long, ends(long), circles).options[0]?.line
        .coordinates[0];
      if (!start) throw new Error('no line');
      expect(greatCircleMeters(home.center, start)).toBeGreaterThanOrEqual(1800);
      expect(greatCircleMeters(home.center, start)).toBeLessThan(1820);
    }
  });

  it('continues an end that only rounding pulls into a circle (phase review finding 1)', () => {
    // A grid point (five decimals) just inside the 400 m share circle, and a raw end a few
    // decimetres further out that rounds onto it: outside before rounding, inside after.
    let found: { grid: CoursePosition; raw: CoursePosition } | null = null;
    for (let i = 450; i <= 470 && found === null; i += 1)
      for (let j = -40; j <= 40 && found === null; j += 1) {
        const grid: CoursePosition = [
          Number((127.02 + i * 1e-5).toFixed(5)),
          Number((37.5 + j * 1e-5).toFixed(5)),
        ];
        const inside = greatCircleMeters(home.center, grid);
        if (!(inside > 399.7 && inside <= 400)) continue;
        for (const [dx, dy] of [
          [0.45e-5, 0],
          [0.45e-5, 0.45e-5],
          [0.45e-5, -0.45e-5],
        ] as const) {
          const raw: CoursePosition = [grid[0] + dx, grid[1] + dy];
          if (greatCircleMeters(home.center, raw) > 400 && roundPosition(raw, 5)[0] === grid[0]) {
            found = { grid, raw };
            break;
          }
        }
      }
    if (!found) throw new Error('no grid point found');
    const { grid, raw } = found;
    expect(greatCircleMeters(home.center, raw)).toBeGreaterThan(400);
    expect(roundPosition(raw, 5)).toEqual(grid);
    // Out from the raw end, straight away from the home, for 3 km.
    const bearing = [raw[0] - home.center[0], raw[1] - home.center[1]] as const;
    const unit = Math.hypot(bearing[0], bearing[1]);
    const line: CoursePosition[] = [
      raw,
      ...Array.from({ length: 300 }, (_, index): CoursePosition => {
        const k = ((index + 1) * 10) / 400;
        return [raw[0] + (bearing[0] / unit) * unit * k, raw[1] + (bearing[1] / unit) * unit * k];
      }),
    ];
    const choice = disclosureChoices('share', line, ends(line), circles).options[0];
    const start = choice?.line.coordinates[0];
    if (!choice || !start) throw new Error('no link line');
    // The end rounding put inside is cut like any other — with its 500 m continuation — and
    // the link says it was trimmed.
    expect(choice.exposure).toBe('trimmed');
    expect(greatCircleMeters(home.center, start)).toBeGreaterThanOrEqual(900);
    assertOutside(choice.line, circles);
  });

  it('drops a via waypoint on the hidden stretch and keeps one on the line that leaves', () => {
    const hidden = east[60];
    const shown = east[150];
    if (!hidden || !shown) throw new Error('fixture');
    const waypoints: CourseWaypoint[] = [
      ...ends(east).slice(0, 1),
      { role: 'via', position: hidden, name: '빵집', sourceSampleId: null, locked: false },
      { role: 'via', position: shown, name: '다리', sourceSampleId: null, locked: false },
      ...ends(east).slice(1),
    ];
    const choice = disclosureChoices('share', east, waypoints, circles).options[0];
    expect(choice?.line.waypoints.map((waypoint) => waypoint.name)).toEqual([null, '다리', null]);
    // The start waypoint at the home (inside the circle) and the hidden via.
    expect(choice?.removedWaypointCount).toBe(2);
  });

  it('counts a link against the areas that cut it, with a 2 m margin (lifetime budget)', () => {
    const far = { center: [127.2, 37.7] as CoursePosition, radiusMeters: 100 };
    const set = shareCircleSet([
      { zone: home, offset: { x: 0, y: 0 } },
      { zone: far, offset: { x: 0, y: 0 } },
    ]);
    expect(set.map((circle) => circle.continuationCutMeters)).toEqual([500, 500, 500, 500]);
    expect(shareCutAreaIndexes(east, set, 2)).toEqual([0]);
    expect(shareCutAreaIndexes(elsewhere, set, 2)).toEqual([]);
    // A vertex a metre outside the share circle still counts: rounding may cut it.
    const metresPerDegree = greatCircleMeters([127.02, 37.5], [127.03, 37.5]) / 0.01;
    const edge: CoursePosition = [127.02 + 401 / metresPerDegree, 37.5];
    expect(greatCircleMeters(home.center, edge)).toBeGreaterThan(400);
    expect(greatCircleMeters(home.center, edge)).toBeLessThan(402);
    expect(shareCutAreaIndexes([edge, [127.1, 37.5]], set, 2)).toEqual([0]);
  });
});
