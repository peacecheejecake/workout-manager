import type { CoursePosition } from '@workout/contracts/courses';

/**
 * The out-and-back (A→B→A) draft (M2-01k-j).
 *
 * An out-and-back is an ordinary ordered waypoint list — start A, turnaround B, finish A —
 * routed by the same bounded engine path as every other draft. Nothing here calls the
 * engine or changes what it is asked: the draft is three waypoints and the engine answers
 * for exactly those three, which is what the route guard already checks (M2-01g: the answer
 * must visit the requested waypoints in order).
 *
 * What this module adds is a MEASUREMENT of that answer: which parts of the way back run
 * over the way out. The engine usually retraces the same streets, but not always — a one-way
 * footpath, a different side of a square — and the owner has to see which is which rather
 * than assume "out-and-back" means "the same street twice". The measurement is geometric
 * only. Two legs drawn over the same line are not evidence that the street is passable, lit
 * or open; that remains unknown and is said so on screen.
 */

/** Bounds of the overlap measurement. Changing one changes what "overlapping" means. */
export const outAndBackOverlapDefinition = {
  version: 1,
  /** A point of the way back within this distance of the way out is on the same ground. */
  toleranceMeters: 12,
  /**
   * …and only when it runs along it. A piece of the way back counts only when its direction
   * and the direction of a nearby piece of the way out agree to within this |cos| (about
   * 25°), either way round. Without it a way back that CROSSES the way out, or leaves the
   * turnaround at a shallow angle along another street, was reported as walked twice: the
   * crossing lies within the tolerance for 2·tolerance/sin θ metres, 24 m at 90°.
   */
  minimumAlignment: 0.9,
  /** The way back is examined in pieces no longer than this. */
  sampleMeters: 4,
  /**
   * Shorter shared stretches are not reported. Every A→B→A shares its turnaround and its
   * ends, and a leg leaving B at an angle stays within the tolerance for a few metres; that
   * touch is where two lines meet, not a stretch walked twice.
   */
  minimumRunMeters: 20,
  /** Where the turnaround may sit relative to a snapped waypoint, as the route guard uses. */
  anchorMeters: 1,
} as const;

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function metersBetween(from: CoursePosition, to: CoursePosition): number {
  const dLat = toRadians(to[1] - from[1]);
  const dLon = toRadians(to[0] - from[0]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from[1])) * Math.cos(toRadians(to[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function lineMeters(coordinates: readonly CoursePosition[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous !== undefined && current !== undefined) total += metersBetween(previous, current);
  }
  return total;
}

/** One stretch of the way back that runs over the way out. */
export interface OverlapSegment {
  /** Where the stretch starts and ends, measured along the way back from the turnaround. */
  readonly fromMeters: number;
  readonly toMeters: number;
  readonly meters: number;
  /** The stretch itself, on the way back's own line. Drawn on the map as it is. */
  readonly positions: readonly CoursePosition[];
}

export interface OutAndBackOverlap {
  readonly outMeters: number;
  readonly backMeters: number;
  /** Length of the way back that lies on the way out. */
  readonly overlapMeters: number;
  /** `overlapMeters` as a share of the way back; `0` for an empty way back. */
  readonly overlapRatio: number;
  readonly segments: readonly OverlapSegment[];
}

type Point = readonly [x: number, y: number];

/**
 * Local metres around one reference position. Over the few kilometres of a walking route the
 * equirectangular error is far below the tolerance; this is a measurement of whether two
 * lines lie on each other, not a survey.
 */
function projector(reference: CoursePosition): (position: CoursePosition) => Point {
  const scaleX = toRadians(1) * EARTH_RADIUS_METERS * Math.cos(toRadians(reference[1]));
  const scaleY = toRadians(1) * EARTH_RADIUS_METERS;
  return (position) => [
    (position[0] - reference[0]) * scaleX,
    (position[1] - reference[1]) * scaleY,
  ];
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared),
        );
  return Math.hypot(point[0] - (from[0] + t * dx), point[1] - (from[1] + t * dy));
}

/**
 * Which segments of a line pass near which grid cell (one cell = the tolerance). The way out
 * is walked in steps of at most half a cell and every step registers its segment in its own
 * cell and the eight around it. The query (`alongOut`) then looks in the point's own cell AND
 * the eight around it, so a point within the tolerance of a segment finds it even when its
 * nearest step lies two cells away. (With steps of half a cell the registration alone already
 * reaches every such point — a brute-force search over bearings found no counter-example —
 * so the wider query is a margin, not a fix; it costs nine map lookups per piece.) The index
 * grows with the length of the line rather than with the area of its bounding box.
 */
function segmentIndex(points: readonly Point[], cell: number): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  const register = (x: number, y: number, segment: number) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let ox = -1; ox <= 1; ox += 1)
      for (let oy = -1; oy <= 1; oy += 1) {
        const key = `${cx + ox}:${cy + oy}`;
        const set = index.get(key);
        if (set === undefined) index.set(key, new Set([segment]));
        else set.add(segment);
      }
  };
  for (let segment = 1; segment < points.length; segment += 1) {
    const from = points[segment - 1];
    const to = points[segment];
    if (from === undefined || to === undefined) continue;
    const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / (cell / 2)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      register(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, segment - 1);
    }
  }
  return index;
}

/**
 * Where the way back runs over the way out.
 *
 * The way back is cut into short pieces; a piece whose midpoint lies within the tolerance of
 * the way out is on shared ground. Consecutive shared pieces form one stretch, and stretches
 * shorter than {@link outAndBackOverlapDefinition.minimumRunMeters} are dropped as the touch
 * where two lines meet. The answer depends on the lines, not on how many vertices the engine
 * used to encode them: the same walk split differently gives the same stretches.
 */
export function outAndBackOverlap(
  out: readonly CoursePosition[],
  back: readonly CoursePosition[],
  definition: {
    readonly toleranceMeters: number;
    readonly sampleMeters: number;
    readonly minimumRunMeters: number;
    readonly minimumAlignment: number;
  } = outAndBackOverlapDefinition,
): OutAndBackOverlap {
  const outMeters = lineMeters(out);
  const backMeters = lineMeters(back);
  const reference = out[0] ?? back[0];
  if (reference === undefined || out.length < 2 || back.length < 2)
    return { outMeters, backMeters, overlapMeters: 0, overlapRatio: 0, segments: [] };
  const project = projector(reference);
  const outPoints = out.map(project);
  const cell = definition.toleranceMeters;
  const index = segmentIndex(outPoints, cell);
  /**
   * Whether a piece of the way back, at `position` and heading along `direction` (local
   * metres), runs over the way out: a segment of the way out lies within the tolerance AND
   * runs the same way or the opposite way.
   */
  const alongOut = (position: CoursePosition, direction: Point): boolean => {
    const point = project(position);
    const directionLength = Math.hypot(direction[0], direction[1]);
    if (directionLength === 0) return false;
    const cx = Math.floor(point[0] / cell);
    const cy = Math.floor(point[1] / cell);
    for (let ox = -1; ox <= 1; ox += 1)
      for (let oy = -1; oy <= 1; oy += 1) {
        const segments = index.get(`${cx + ox}:${cy + oy}`);
        if (segments === undefined) continue;
        for (const segment of segments) {
          const from = outPoints[segment];
          const to = outPoints[segment + 1];
          if (from === undefined || to === undefined) continue;
          if (distanceToSegment(point, from, to) > definition.toleranceMeters) continue;
          const sx = to[0] - from[0];
          const sy = to[1] - from[1];
          const segmentLength = Math.hypot(sx, sy);
          if (segmentLength === 0) continue;
          const cosine =
            (sx * direction[0] + sy * direction[1]) / (segmentLength * directionLength);
          if (Math.abs(cosine) >= definition.minimumAlignment) return true;
        }
      }
    return false;
  };

  const segments: OverlapSegment[] = [];
  let run: { fromMeters: number; positions: CoursePosition[] } | null = null;
  let along = 0;
  const close = () => {
    if (run === null) return;
    const meters = along - run.fromMeters;
    if (meters >= definition.minimumRunMeters)
      segments.push({
        fromMeters: run.fromMeters,
        toMeters: along,
        meters,
        positions: run.positions,
      });
    run = null;
  };
  for (let edge = 1; edge < back.length; edge += 1) {
    const from = back[edge - 1];
    const to = back[edge];
    if (from === undefined || to === undefined) continue;
    const length = metersBetween(from, to);
    if (length <= 0) continue;
    const pieces = Math.max(1, Math.ceil(length / definition.sampleMeters));
    const at = (t: number): CoursePosition => [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
    ];
    const fromPoint = project(from);
    const toPoint = project(to);
    const direction: Point = [toPoint[0] - fromPoint[0], toPoint[1] - fromPoint[1]];
    for (let piece = 0; piece < pieces; piece += 1) {
      const shared = alongOut(at((piece + 0.5) / pieces), direction);
      if (shared) {
        if (run === null) run = { fromMeters: along, positions: [at(piece / pieces)] };
      } else close();
      along += length / pieces;
      if (shared && run !== null) run.positions.push(at((piece + 1) / pieces));
    }
  }
  close();
  // Positions inside one edge are collinear; keep the line, not every sample on it.
  const trimmed = segments.map((segment) => ({
    ...segment,
    positions: dropCollinear(segment.positions),
  }));
  const overlapMeters = trimmed.reduce((sum, segment) => sum + segment.meters, 0);
  return {
    outMeters,
    backMeters,
    overlapMeters,
    overlapRatio: backMeters > 0 ? Math.min(1, overlapMeters / backMeters) : 0,
    segments: trimmed,
  };
}

function dropCollinear(positions: readonly CoursePosition[]): CoursePosition[] {
  if (positions.length <= 2) return [...positions];
  const kept: CoursePosition[] = [positions[0] as CoursePosition];
  for (let index = 1; index < positions.length - 1; index += 1) {
    const previous = kept[kept.length - 1] as CoursePosition;
    const current = positions[index] as CoursePosition;
    const next = positions[index + 1] as CoursePosition;
    const cross =
      (current[0] - previous[0]) * (next[1] - previous[1]) -
      (current[1] - previous[1]) * (next[0] - previous[0]);
    if (Math.abs(cross) > 1e-14) kept.push(current);
  }
  kept.push(positions[positions.length - 1] as CoursePosition);
  return kept;
}

/**
 * The vertex of the computed line where the way out ends and the way back begins.
 *
 * The turnaround is the snapped B the engine reported. The line visits it once, between the
 * two ends, so the first vertex after the start that lies on it is the split — the same
 * anchor the route guard uses. If no vertex is on it (a line from before snapping was
 * reported), the nearest inner vertex stands in.
 */
export function turnaroundIndex(
  coordinates: readonly CoursePosition[],
  turnaround: CoursePosition,
): number | null {
  if (coordinates.length < 3) return null;
  let nearest = -1;
  let nearestMeters = Number.POSITIVE_INFINITY;
  for (let index = 1; index < coordinates.length - 1; index += 1) {
    const vertex = coordinates[index];
    if (vertex === undefined) continue;
    const meters = metersBetween(vertex, turnaround);
    if (meters <= outAndBackOverlapDefinition.anchorMeters) return index;
    if (meters < nearestMeters) {
      nearest = index;
      nearestMeters = meters;
    }
  }
  return nearest < 0 ? null : nearest;
}

const samePosition = (left: CoursePosition, right: CoursePosition) =>
  left[0] === right[0] && left[1] === right[1];

/**
 * Whether an ordered waypoint list is an out-and-back: exactly a start, one turnaround and
 * a finish at the start's own position.
 */
export function isOutAndBack(waypoints: readonly CoursePosition[]): boolean {
  const [start, turnaround, finish] = waypoints;
  return (
    waypoints.length === 3 &&
    start !== undefined &&
    turnaround !== undefined &&
    finish !== undefined &&
    samePosition(start, finish) &&
    !samePosition(start, turnaround)
  );
}

export interface OutAndBackAnalysis extends OutAndBackOverlap {
  readonly turnaroundIndex: number;
}

/**
 * The overlap of one computed out-and-back, or `null` when the draft it was computed for is
 * not one. `snapped` is where the engine put each waypoint; without it the requested
 * turnaround stands in.
 */
export function analyseOutAndBack(input: {
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CoursePosition[];
  readonly snappedWaypoints?: readonly CoursePosition[] | undefined;
}): OutAndBackAnalysis | null {
  if (!isOutAndBack(input.waypoints)) return null;
  const turnaround = input.snappedWaypoints?.[1] ?? input.waypoints[1];
  if (turnaround === undefined) return null;
  const split = turnaroundIndex(input.coordinates, turnaround);
  if (split === null) return null;
  return {
    turnaroundIndex: split,
    ...outAndBackOverlap(input.coordinates.slice(0, split + 1), input.coordinates.slice(split)),
  };
}
