/**
 * SDK-free geometry input for the map experience kit.
 *
 * Nothing here knows about FIT, GPX, activities, revisions of stored tracks, or server
 * policy. A caller converts whatever it owns into a `MapPath` and gets selections back.
 * `vertexKeys` is an opaque identifier per vertex: the kit never interprets it, it only
 * hands it back on selection so the owner can map a picked vertex to its own sample.
 *
 * This is a display contract. Simplification, zoom and map interaction never change the
 * numbers a caller reports as actual distance, pace or duration.
 */

/** WGS84 `[longitude, latitude]`. Altitude, time and heart rate are never packed in here. */
export type GeoPosition = readonly [longitude: number, latitude: number];

/**
 * `uncomputed` is a line nobody computed: an owner's waypoints joined in order, drawn only so
 * the order can be seen. The renderer draws it dashed and apart from every other line, and a
 * caller that uses it must say in words what it is — it is never a route and never a distance.
 *
 * `overlap` marks stretches of a computed line that are walked twice — the way back of an
 * out-and-back running over the way out (M2-01k-j). It is drawn over the line it belongs to
 * and never stands alone as a route.
 */
export type MapPathRole = 'recorded' | 'planned' | 'candidate' | 'uncomputed' | 'overlap';

export interface MapPath {
  readonly id: string;
  readonly role: MapPathRole;
  /** Opaque geometry revision. A different value means different geometry. */
  readonly revision: string;
  readonly positions: readonly GeoPosition[];
  /**
   * Indices at which continuity is broken. `breaks: [10]` means the drawn line stops
   * after vertex 9 and restarts at vertex 10. Gaps are never bridged with a straight line.
   */
  readonly breaks?: readonly number[];
  /** Optional per-vertex opaque keys; when present, must have one entry per position. */
  readonly vertexKeys?: readonly string[];
}

export interface MapSelection {
  readonly pathId: string;
  readonly vertexIndex: number;
}

export interface MapBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  /** True when the tightest bounds run across ±180°; `east` is then less than `west`. */
  readonly crossesAntimeridian: boolean;
}

export type MapPathProblem =
  | 'EMPTY_PATH'
  | 'NON_FINITE_COORDINATE'
  | 'LONGITUDE_OUT_OF_RANGE'
  | 'LATITUDE_OUT_OF_RANGE'
  | 'VERTEX_KEY_LENGTH_MISMATCH'
  | 'BREAK_OUT_OF_RANGE'
  | 'BREAK_NOT_ASCENDING';

export type MapPathValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: MapPathProblem; readonly index: number | null };

export function validateMapPath(path: MapPath): MapPathValidation {
  if (path.positions.length === 0) return { ok: false, problem: 'EMPTY_PATH', index: null };
  if (path.vertexKeys && path.vertexKeys.length !== path.positions.length)
    return { ok: false, problem: 'VERTEX_KEY_LENGTH_MISMATCH', index: null };
  for (const [index, position] of path.positions.entries()) {
    const [longitude, latitude] = position;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude))
      return { ok: false, problem: 'NON_FINITE_COORDINATE', index };
    if (longitude < -180 || longitude > 180)
      return { ok: false, problem: 'LONGITUDE_OUT_OF_RANGE', index };
    if (latitude < -90 || latitude > 90)
      return { ok: false, problem: 'LATITUDE_OUT_OF_RANGE', index };
  }
  let previous = -1;
  for (const value of path.breaks ?? []) {
    if (!Number.isInteger(value) || value <= 0 || value >= path.positions.length)
      return { ok: false, problem: 'BREAK_OUT_OF_RANGE', index: value };
    if (value <= previous) return { ok: false, problem: 'BREAK_NOT_ASCENDING', index: value };
    previous = value;
  }
  return { ok: true };
}

export interface MapSegment {
  readonly pathId: string;
  readonly role: MapPathRole;
  /** Index of the first vertex of this segment inside the owning path. */
  readonly startIndex: number;
  readonly positions: readonly GeoPosition[];
}

/**
 * Split a path at its breaks. A segment with a single position is returned as-is: the
 * caller renders it as a point, never as a line, because one sample is not a track.
 */
export function splitSegments(path: MapPath): MapSegment[] {
  const boundaries = [0, ...(path.breaks ?? []), path.positions.length];
  const segments: MapSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index] ?? 0;
    const end = boundaries[index + 1] ?? start;
    if (end <= start) continue;
    segments.push({
      pathId: path.id,
      role: path.role,
      startIndex: start,
      positions: path.positions.slice(start, end),
    });
  }
  return segments;
}

/**
 * Tightest bounds over every path. Longitudes are compared both in the plain range and
 * shifted across the antimeridian; the narrower span wins, so a track crossing ±180°
 * does not produce a whole-world viewport.
 */
export function computeBounds(paths: readonly MapPath[]): MapBounds | null {
  const longitudes: number[] = [];
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const path of paths) {
    for (const [longitude, latitude] of path.positions) {
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
      longitudes.push(longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
  }
  if (longitudes.length === 0) return null;
  const plainWest = Math.min(...longitudes);
  const plainEast = Math.max(...longitudes);
  const shifted = longitudes.map((value) => (value < 0 ? value + 360 : value));
  const shiftedWest = Math.min(...shifted);
  const shiftedEast = Math.max(...shifted);
  if (shiftedEast - shiftedWest < plainEast - plainWest) {
    return {
      west: shiftedWest > 180 ? shiftedWest - 360 : shiftedWest,
      east: shiftedEast > 180 ? shiftedEast - 360 : shiftedEast,
      south,
      north,
      crossesAntimeridian: true,
    };
  }
  return { west: plainWest, east: plainEast, south, north, crossesAntimeridian: false };
}

/** Squared planar distance with a cosine longitude correction; ordering only, not a distance. */
function proximity(a: GeoPosition, b: GeoPosition): number {
  const scale = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (a[0] - b[0]) * scale;
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * Nearest vertex to a picked position. Ties break on the lowest path index then the
 * lowest vertex index so selection is deterministic.
 */
export function findNearestVertex(
  paths: readonly MapPath[],
  position: GeoPosition,
): MapSelection | null {
  let best: MapSelection | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    for (const [index, vertex] of path.positions.entries()) {
      const score = proximity(vertex, position);
      if (score < bestScore) {
        bestScore = score;
        best = { pathId: path.id, vertexIndex: index };
      }
    }
  }
  return best;
}

export function selectedPosition(
  paths: readonly MapPath[],
  selection: MapSelection | null,
): GeoPosition | null {
  if (!selection) return null;
  const path = paths.find((candidate) => candidate.id === selection.pathId);
  return path?.positions[selection.vertexIndex] ?? null;
}

/** Opaque key of a selected vertex, for callers that supplied `vertexKeys`. */
export function selectedVertexKey(
  paths: readonly MapPath[],
  selection: MapSelection | null,
): string | null {
  if (!selection) return null;
  const path = paths.find((candidate) => candidate.id === selection.pathId);
  return path?.vertexKeys?.[selection.vertexIndex] ?? null;
}

export interface MapPathFeatureCollection {
  readonly type: 'FeatureCollection';
  readonly features: readonly {
    readonly type: 'Feature';
    readonly id: string;
    readonly properties: {
      readonly pathId: string;
      readonly role: MapPathRole;
      readonly startIndex: number;
      readonly insufficient: boolean;
    };
    readonly geometry:
      | { readonly type: 'LineString'; readonly coordinates: readonly GeoPosition[] }
      | { readonly type: 'Point'; readonly coordinates: GeoPosition };
  }[];
}

/** Renderer-neutral GeoJSON. Gaps become separate features; a lone sample becomes a point. */
export function toFeatureCollection(paths: readonly MapPath[]): MapPathFeatureCollection {
  const features: MapPathFeatureCollection['features'][number][] = [];
  for (const path of paths) {
    for (const segment of splitSegments(path)) {
      const [only] = segment.positions;
      if (!only) continue;
      const properties = {
        pathId: segment.pathId,
        role: segment.role,
        startIndex: segment.startIndex,
        insufficient: segment.positions.length < 2,
      } as const;
      features.push({
        type: 'Feature',
        id: `${path.id}:${path.revision}:${segment.startIndex}`,
        properties,
        geometry:
          segment.positions.length < 2
            ? { type: 'Point', coordinates: only }
            : { type: 'LineString', coordinates: segment.positions },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
