/**
 * M2-01ay: the coverage probe's tag check (scripts/probe-routing-korea-coverage.mts), moved out of
 * the probe so it can be unit-tested without the probe's engine and osmium code. Pure functions
 * over OSM tags and route geometry; nothing here reads a file or starts a process.
 */
import { haversineMeters } from '../packages/server/integrations/src/routing/geo.js';

/** Route segments closer than this to a tagged way segment, and parallel to it, count as on it. */
export const wayMatchToleranceMeters = 1.5;
export const wayMatchMaxAngleDegrees = 20;
/** A route vertex this close to a tagged node counts as passing it. */
export const nodeMatchToleranceMeters = 1.0;

export type Position = [number, number];

/** Array access that fails loudly instead of asserting. */
export function item<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`INDEX_OUT_OF_RANGE: ${index}`);
  return value;
}

/** OPL escapes a character in a key or value as `%<hex code point>%`. */
export function decodeOpl(text: string): string {
  return text.replace(/%([0-9a-f]+)%/g, (_match, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

// ---------------------------------------------------------------------------------------
// OSM tags
// ---------------------------------------------------------------------------------------

export type Tags = Readonly<Record<string, string>>;

export interface TaggedWay {
  readonly id: string;
  readonly tags: Tags;
  readonly coordinates: readonly Position[];
}

export interface TaggedNode {
  readonly id: string;
  readonly tags: Tags;
  readonly position: Position;
}

export interface TaggedArea {
  readonly id: string;
  readonly tags: Tags;
  /** Outer and inner rings of every polygon part. */
  readonly polygons: readonly (readonly (readonly Position[])[])[];
  readonly bbox: readonly [number, number, number, number];
}

const restrictiveValues = new Set([
  'no',
  'private',
  'restricted',
  'military',
  'emergency',
  'permit',
]);
const otherAccessValues = new Set([
  'destination',
  'customers',
  'delivery',
  'agricultural',
  'forestry',
  'discouraged',
]);

/**
 * How GraphHopper 10.0's foot access parser would read the way's `foot`/`access` tags.
 * The more specific key wins (`foot` before `access`). This is a label for the reviewer,
 * derived from the tags, not a statement about the ground.
 */
export function accessClass(tags: Tags): string | null {
  const foot = tags.foot;
  const access = tags.access;
  if (foot === 'no') return 'foot=no';
  if (foot !== undefined && restrictiveValues.has(foot)) return `foot=${foot}`;
  if (access !== undefined && restrictiveValues.has(access))
    return foot === undefined ? `access=${access}` : `access=${access} with foot=${foot}`;
  if (foot !== undefined && otherAccessValues.has(foot)) return `foot=${foot}`;
  if (access !== undefined && otherAccessValues.has(access))
    return foot === undefined ? `access=${access}` : `access=${access} with foot=${foot}`;
  return null;
}

/**
 * Pedestrian access by the same precedence (M2-01ay): a restrictive `foot` value restricts; with
 * no `foot` value a restrictive `access` value restricts; a non-restrictive `foot` value over a
 * restrictive `access` value lets a pedestrian through (the M0-06b review's ACC-PRV-01 gate,
 * `barrier=gate` + `access=no` + `foot=yes`). A label from the tags, not the ground.
 */
export function pedestrianAccess(
  tags: Tags,
): 'restricted' | 'foot-overrides-restrictive-access' | 'not-restricted' {
  const foot = tags.foot;
  const access = tags.access;
  if (foot !== undefined && restrictiveValues.has(foot)) return 'restricted';
  if (access !== undefined && restrictiveValues.has(access))
    return foot === undefined ? 'restricted' : 'foot-overrides-restrictive-access';
  return 'not-restricted';
}

const reportedTagKeys = [
  'highway',
  'name',
  'foot',
  'access',
  'access:conditional',
  'foot:conditional',
  'opening_hours',
  'footway',
  'crossing',
  'sidewalk',
  'barrier',
  'indoor',
  'level',
  'tunnel',
  'bridge',
  'route',
  'landuse',
  'military',
  'sac_scale',
  // M2-01ay: which deck of a stacked crossing (BRG-01: Banpo Bridge above Jamsugyo).
  'layer',
] as const;

/**
 * Whether the way carries a time condition the serving profile does not model (M0-06b coverage
 * review): `access:conditional`, `foot:conditional` or `opening_hours`.
 */
export function timeConditional(tags: Tags): boolean {
  return (
    tags['access:conditional'] !== undefined ||
    tags['foot:conditional'] !== undefined ||
    tags.opening_hours !== undefined
  );
}

export function reportedTags(tags: Tags): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of reportedTagKeys) {
    const value = tags[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

export function stringTags(properties: unknown): Tags {
  const tags: Record<string, string> = {};
  if (typeof properties !== 'object' || properties === null) return tags;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') tags[key] = value;
  }
  return tags;
}

export function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

export function positions(value: unknown): Position[] {
  return Array.isArray(value) ? value.filter(isPosition).map(([x, y]): Position => [x, y]) : [];
}

export interface TagIndex {
  readonly ways: readonly TaggedWay[];
  readonly nodes: readonly TaggedNode[];
  readonly areas: readonly TaggedArea[];
  readonly statistics: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------
// Geometry helpers for the tag check
// ---------------------------------------------------------------------------------------

const metersPerDegreeLatitude = 111_320;

/** Local planar projection around a latitude, in meters. Adequate for metre-scale checks. */
function project(position: Position, originLatitude: number): [number, number] {
  return [
    position[0] * metersPerDegreeLatitude * Math.cos((originLatitude * Math.PI) / 180),
    position[1] * metersPerDegreeLatitude,
  ];
}

function pointToSegmentMeters(point: Position, a: Position, b: Position): number {
  const [px, py] = project(point, point[1]);
  const [ax, ay] = project(a, point[1]);
  const [bx, by] = project(b, point[1]);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function bearingDegrees(a: Position, b: Position): number {
  const [ax, ay] = project(a, a[1]);
  const [bx, by] = project(b, a[1]);
  return (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
}

function parallel(first: number, second: number): boolean {
  const difference = Math.abs(first - second) % 180;
  return Math.min(difference, 180 - difference) <= wayMatchMaxAngleDegrees;
}

const cellDegrees = 0.001;
const cellKey = (x: number, y: number) =>
  `${Math.floor(x / cellDegrees)}:${Math.floor(y / cellDegrees)}`;

export interface IndexedSegment {
  readonly way: TaggedWay;
  readonly a: Position;
  readonly b: Position;
}

export function indexSegments(ways: readonly TaggedWay[]): Map<string, IndexedSegment[]> {
  const grid = new Map<string, IndexedSegment[]>();
  for (const way of ways)
    for (let index = 1; index < way.coordinates.length; index += 1) {
      const a = item(way.coordinates, index - 1);
      const b = item(way.coordinates, index);
      const keys = new Set<string>();
      const steps = Math.max(1, Math.ceil(haversineMeters(a, b) / 50));
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        keys.add(cellKey(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
      }
      for (const key of keys) {
        const bucket = grid.get(key) ?? [];
        bucket.push({ way, a, b });
        grid.set(key, bucket);
      }
    }
  return grid;
}

export function indexNodes(nodes: readonly TaggedNode[]): Map<string, TaggedNode[]> {
  const grid = new Map<string, TaggedNode[]>();
  for (const node of nodes) {
    const key = cellKey(node.position[0], node.position[1]);
    const bucket = grid.get(key) ?? [];
    bucket.push(node);
    grid.set(key, bucket);
  }
  return grid;
}

function neighbourKeys(position: Position): string[] {
  const x = Math.floor(position[0] / cellDegrees);
  const y = Math.floor(position[1] / cellDegrees);
  const keys: string[] = [];
  for (let dx = -1; dx <= 1; dx += 1)
    for (let dy = -1; dy <= 1; dy += 1) keys.push(`${x + dx}:${y + dy}`);
  return keys;
}

function ringContains(ring: readonly Position[], point: Position): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = item(ring, i);
    const [xj, yj] = item(ring, j);
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function areaContains(area: TaggedArea, point: Position): boolean {
  const [minX, minY, maxX, maxY] = area.bbox;
  if (point[0] < minX || point[0] > maxX || point[1] < minY || point[1] > maxY) return false;
  return area.polygons.some(
    (rings) =>
      rings[0] !== undefined &&
      ringContains(rings[0], point) &&
      !rings.slice(1).some((hole) => ringContains(hole, point)),
  );
}

/** One OSM way the engine reports under a route, and the route metres on it (M2-01ay). */
export interface EngineWay {
  readonly wayId: number;
  readonly meters: number;
}

/**
 * How the tag check found the ways under a route (M2-01ay).
 *
 * `engine-way-ids`: the graph encodes `osm_way_id`, the supplementary request asks for it, and
 * each way's metres are summed from the engine's own intervals. Exact for the edges the route
 * uses; a parallel way under or beside it cannot be matched by mistake (the M0-06b review's
 * FRY-03 `foot=no` match was such a parallel way).
 *
 * `geometric`: the graph has no way ids (built before M2-01ay). A route segment counts as running
 * along a tagged way when its midpoint is near it and the directions agree, as before.
 */
export type WayMatchMethod = 'engine-way-ids' | 'geometric';

export interface TagCheck {
  readonly wayMatchMethod: WayMatchMethod;
  readonly waysAlongRoute: {
    wayId: string;
    accessClass: string | null;
    tags: Record<string, string>;
    metersAlongRoute: number;
  }[];
  readonly nodesOnRoute: {
    nodeId: string;
    accessClass: string | null;
    pedestrianAccess: ReturnType<typeof pedestrianAccess>;
    tags: Record<string, string>;
  }[];
  readonly militaryAreasEntered: {
    areaId: string;
    tags: Record<string, string>;
    routeMetersInside: number;
  }[];
  readonly summary: {
    footNoMeters: number;
    accessPrivateOrNoWithoutFootOverrideMeters: number;
    accessRestrictedWithFootOverrideMeters: number;
    otherAccessValueMeters: number;
    ferryMeters: number;
    /** Nodes with any foot/access/barrier value this probe classes (unchanged since M0-06b). */
    restrictedNodesPassed: number;
    /**
     * M2-01ay: of those, the nodes whose PEDESTRIAN access is restricted: a restrictive `foot`
     * value, or a restrictive `access` value with no `foot` value. GraphHopper's foot parser reads
     * `foot` before `access`, so `access=no` + `foot=yes` is a gate a pedestrian may pass.
     */
    footRestrictedNodesPassed: number;
    /** M2-01ay: nodes with a restrictive `access` and a `foot` value that overrides it. */
    accessRestrictedNodesWithFootOverridePassed: number;
    militaryAreaMeters: number;
    /** Along `footway=crossing` ways. */
    crossingWayMeters: number;
    /** `highway=crossing` nodes the route passes. */
    crossingNodesPassed: number;
    /** Along highway ways with `access:conditional`, `foot:conditional` or `opening_hours`. */
    timeConditionMeters: number;
  };
}

/**
 * Whether an engine-reported way belongs in `waysAlongRoute`: the classes the geometric index
 * holds (access-tagged, ferry, crossing, time-conditional), and bridges and tunnels, so a
 * reviewer can see which crossing a route took (M2-01ay, BRG-01).
 */
export function reportableWay(tags: Tags): boolean {
  return (
    accessClass(tags) !== null ||
    tags.route === 'ferry' ||
    tags.footway === 'crossing' ||
    timeConditional(tags) ||
    (tags.bridge !== undefined && tags.bridge !== 'no') ||
    (tags.tunnel !== undefined && tags.tunnel !== 'no')
  );
}

export function checkRouteTags(
  route: readonly Position[],
  index: TagIndex,
  grid: Map<string, IndexedSegment[]>,
  nodeGrid: Map<string, TaggedNode[]>,
  engineWays: {
    readonly ways: readonly EngineWay[];
    readonly tags: ReadonlyMap<number, Tags>;
  } | null,
): TagCheck {
  const alongWay = new Map<string, { way: TaggedWay; meters: number }>();
  const insideArea = new Map<string, { area: TaggedArea; meters: number }>();
  if (engineWays !== null)
    for (const { wayId, meters } of engineWays.ways) {
      const tags = engineWays.tags.get(wayId);
      if (tags === undefined) throw new Error(`ENGINE_WAY_NOT_IN_EXTRACT: w${wayId}`);
      if (!reportableWay(tags)) continue;
      const id = `w${wayId}`;
      const entry = alongWay.get(id) ?? { way: { id, tags, coordinates: [] }, meters: 0 };
      alongWay.set(id, { way: entry.way, meters: entry.meters + meters });
    }
  for (let i = 1; i < route.length; i += 1) {
    const a = item(route, i - 1);
    const b = item(route, i);
    const meters = haversineMeters(a, b);
    if (meters < 0.5) continue;
    const middle: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const bearing = bearingDegrees(a, b);
    const matched = new Set<string>();
    if (engineWays === null)
      for (const key of neighbourKeys(middle))
        for (const segment of grid.get(key) ?? []) {
          if (matched.has(segment.way.id)) continue;
          if (pointToSegmentMeters(middle, segment.a, segment.b) > wayMatchToleranceMeters)
            continue;
          if (!parallel(bearing, bearingDegrees(segment.a, segment.b))) continue;
          matched.add(segment.way.id);
          const entry = alongWay.get(segment.way.id) ?? { way: segment.way, meters: 0 };
          alongWay.set(segment.way.id, { way: entry.way, meters: entry.meters + meters });
        }
    for (const area of index.areas)
      if (areaContains(area, middle)) {
        const entry = insideArea.get(area.id) ?? { area, meters: 0 };
        insideArea.set(area.id, { area, meters: entry.meters + meters });
      }
  }
  // Grid lookup: the national extract has far too many crossing nodes for a scan per route.
  const passed = new Map<string, TaggedNode>();
  for (const vertex of route)
    for (const key of neighbourKeys(vertex))
      for (const node of nodeGrid.get(key) ?? [])
        if (haversineMeters(vertex, node.position) <= nodeMatchToleranceMeters)
          passed.set(node.id, node);
  const nodesOnRoute = [...passed.values()]
    .sort((x, y) => x.id.localeCompare(y.id))
    .map((node) => ({
      nodeId: node.id,
      accessClass: accessClass(node.tags),
      pedestrianAccess: pedestrianAccess(node.tags),
      tags: reportedTags(node.tags),
    }));

  const waysAlongRoute = [...alongWay.values()]
    .map(({ way, meters }) => ({
      wayId: way.id,
      accessClass: accessClass(way.tags),
      tags: reportedTags(way.tags),
      metersAlongRoute: Number(meters.toFixed(1)),
    }))
    .sort((x, y) => x.wayId.localeCompare(y.wayId));
  const sum = (predicate: (klass: string | null, tags: Record<string, string>) => boolean) =>
    Number(
      waysAlongRoute
        .filter((entry) => predicate(entry.accessClass, entry.tags))
        .reduce((total, entry) => total + entry.metersAlongRoute, 0)
        .toFixed(1),
    );
  const militaryAreasEntered = [...insideArea.values()].map(({ area, meters }) => ({
    areaId: area.id,
    tags: reportedTags(area.tags),
    routeMetersInside: Number(meters.toFixed(1)),
  }));
  return {
    wayMatchMethod: engineWays === null ? 'geometric' : 'engine-way-ids',
    waysAlongRoute,
    nodesOnRoute,
    militaryAreasEntered,
    summary: {
      footNoMeters: sum((klass) => klass === 'foot=no'),
      accessPrivateOrNoWithoutFootOverrideMeters: sum(
        (klass) => klass === 'access=private' || klass === 'access=no',
      ),
      accessRestrictedWithFootOverrideMeters: sum(
        (klass) => klass !== null && klass.startsWith('access=') && klass.includes(' with foot='),
      ),
      otherAccessValueMeters: sum(
        (klass) =>
          klass !== null &&
          klass !== 'foot=no' &&
          klass !== 'access=private' &&
          klass !== 'access=no' &&
          !klass.includes(' with foot='),
      ),
      ferryMeters: sum((_klass, tags) => tags.route === 'ferry'),
      restrictedNodesPassed: nodesOnRoute.filter((node) => node.accessClass !== null).length,
      footRestrictedNodesPassed: [...passed.values()].filter(
        (node) => pedestrianAccess(node.tags) === 'restricted',
      ).length,
      accessRestrictedNodesWithFootOverridePassed: [...passed.values()].filter(
        (node) => pedestrianAccess(node.tags) === 'foot-overrides-restrictive-access',
      ).length,
      militaryAreaMeters: Number(
        militaryAreasEntered
          .reduce((total, entry) => total + entry.routeMetersInside, 0)
          .toFixed(1),
      ),
      crossingWayMeters: sum((_klass, tags) => tags.footway === 'crossing'),
      crossingNodesPassed: nodesOnRoute.filter((node) => node.tags.highway === 'crossing').length,
      timeConditionMeters: sum((_klass, tags) => timeConditional(tags)),
    },
  };
}
