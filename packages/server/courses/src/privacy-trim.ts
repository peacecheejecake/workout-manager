import { createHash } from 'node:crypto';

import {
  courseLimits,
  courseWaypointListSchema,
  type CourseGeneration,
  type CoursePosition,
  type CoursePrivacyZone,
  type CourseWaypoint,
} from '@workout/contracts/courses';

import { greatCircleMeters, segmentDistanceToPointMeters } from './geo.js';
import { plannedLineLengthMeters } from './segment.js';

/**
 * Privacy trim (M2-01j).
 *
 * The trim is an explicit **derived** revision. It does not rewrite the revision it trims:
 * that one stays immutable in the ledger and this one is appended after it, which is what
 * lets an owner see exactly what was removed and from what.
 *
 * It checks the whole line, not its ends. A course that leaves a protected area and comes
 * back into it later is the case that a start/finish trim gets wrong, and here it does not
 * silently produce a line that passes through the area: removing an interior stretch would
 * leave two runs, and joining them would draw a straight line through the very place the
 * owner is protecting. So that is refused by name and the owner is told why.
 */
export type CourseTrimErrorCode =
  | 'COURSE_TRIM_NO_PROTECTED_AREA'
  | 'COURSE_TRIM_CHANGES_NOTHING'
  | 'COURSE_TRIM_SPLITS_THE_LINE'
  /**
   * Every vertex is outside the areas, but a drawn segment runs through or along one.
   *
   * A separate code from `SPLITS_THE_LINE` because it is a separate fact. Nothing
   * re-enters: there is no interior vertex to drop and no gap to jump, so the refusal is
   * "the line you already have passes through it", not "removing the middle would split
   * it". Both refuse, and the owner was being told the wrong reason for one of them.
   */
  | 'COURSE_TRIM_LINE_CROSSES_AREA'
  | 'COURSE_TRIM_REMOVES_EVERYTHING';

export class CourseTrimError extends Error {
  constructor(readonly code: CourseTrimErrorCode) {
    super(code);
    this.name = 'CourseTrimError';
  }
}

export const PRIVACY_TRIM_POLICY_VERSION = 1;

/**
 * Identity of a set of protected areas: zone ids and radii, ordered, **never a centre**.
 *
 * It travels with a trim request so a trim computed against a set that has since changed
 * is refused, and it is stored in the trimmed revision's conditions — which the account
 * export carries verbatim. A centre is the owner's home; putting one in a digest that
 * leaves the server would defeat the feature it belongs to.
 *
 * The cost of that is real and is stated here rather than discovered later: **a moved
 * centre is invisible to this digest**, so an acknowledged set would still match after one
 * moved. That is only safe while nothing can move a centre. The product has no such path
 * and the runtime role is granted no UPDATE on `course_privacy_zone` (`migrate.ts`), which
 * is what keeps the two facts consistent. A path that moves, renames or resizes an area
 * has to change this function first.
 */
export function privacyZoneSetDigest(zones: readonly CoursePrivacyZone[]): string {
  const material = [...zones]
    .map((zone) => [zone.zoneId, zone.radiusMeters] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([zoneId, radiusMeters]) => `${zoneId}:${radiusMeters}`);
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function insideAnyZone(position: CoursePosition, zones: readonly CoursePrivacyZone[]): boolean {
  return zones.some((zone) => greatCircleMeters(zone.center, position) <= zone.radiusMeters);
}

/**
 * Whether the straight line between two vertices enters a protected area.
 *
 * Two vertices can both sit outside an area while the line between them runs through it —
 * the case a per-vertex test cannot see. Because the drawn course is that line, a segment
 * that crosses an area means the trimmed course still describes it.
 */
function segmentEntersAnyZone(
  from: CoursePosition,
  to: CoursePosition,
  zones: readonly CoursePrivacyZone[],
): boolean {
  return zones.some(
    (zone) => segmentDistanceToPointMeters(from, to, zone.center) <= zone.radiusMeters,
  );
}

/** Whether any drawn segment of a line enters a protected area. */
function lineEntersAnyZone(
  coordinates: readonly CoursePosition[],
  zones: readonly CoursePrivacyZone[],
): boolean {
  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1];
    const to = coordinates[index];
    if (from === undefined || to === undefined) continue;
    if (segmentEntersAnyZone(from, to, zones)) return true;
  }
  return false;
}

export interface TrimmedCourseContent {
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly generation: CourseGeneration;
  readonly distanceMeters: number;
}

export interface TrimCourseInput {
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly zones: readonly CoursePrivacyZone[];
  readonly sourceRevision: number;
  readonly sourceGenerationKind:
    | 'recorded-segment'
    | 'routed-waypoints'
    | 'target-distance-loop'
    | 'imported-file'
    | 'privacy-trimmed';
  readonly sourceGraphBuildId: string | null;
}

export function trimCourseForPrivacy(input: TrimCourseInput): TrimmedCourseContent {
  if (input.zones.length === 0) throw new CourseTrimError('COURSE_TRIM_NO_PROTECTED_AREA');
  const inside = input.coordinates.map((position) => insideAnyZone(position, input.zones));
  const removedVertexCount = inside.filter(Boolean).length;
  // "Nothing to remove" is a statement about the drawn line, not about its vertices: a
  // course whose vertices all sit outside an area can still be drawn straight through it,
  // and saying "this course never enters a protected area" about such a line would be
  // false. That case falls through to `COURSE_TRIM_LINE_CROSSES_AREA` below instead.
  if (removedVertexCount === 0 && !lineEntersAnyZone(input.coordinates, input.zones))
    throw new CourseTrimError('COURSE_TRIM_CHANGES_NOTHING');
  if (removedVertexCount === inside.length)
    throw new CourseTrimError('COURSE_TRIM_REMOVES_EVERYTHING');
  const firstKept = inside.indexOf(false);
  const lastKept = inside.lastIndexOf(false);
  // Every removal between the first and last kept vertex is a re-entry: the owner's route
  // goes back into a protected area in the middle. Dropping those vertices would leave the
  // line jumping across the area in a straight stretch, so this is a refusal, by name.
  for (let index = firstKept; index <= lastKept; index += 1)
    if (inside[index]) throw new CourseTrimError('COURSE_TRIM_SPLITS_THE_LINE');
  const coordinates = input.coordinates.slice(firstKept, lastKept + 1);
  if (coordinates.length < 2) throw new CourseTrimError('COURSE_TRIM_REMOVES_EVERYTHING');
  // The kept vertices are outside every area; the line between them need not be. A trim
  // whose result would still cross an area is refused rather than returned as a success —
  // producing it would put the very coordinates the owner is protecting into the response,
  // the GPX and the thumbnail of that course.
  if (lineEntersAnyZone(coordinates, input.zones))
    throw new CourseTrimError('COURSE_TRIM_LINE_CROSSES_AREA');
  // A waypoint inside a protected area goes, name and all: the name an owner gave the
  // waypoint at their front door is as revealing as the coordinate.
  const keptWaypoints = input.waypoints.filter(
    (waypoint) => waypoint.role === 'via' && !insideAnyZone(waypoint.position, input.zones),
  );
  const start = coordinates[0];
  const finish = coordinates[coordinates.length - 1];
  if (start === undefined || finish === undefined)
    throw new CourseTrimError('COURSE_TRIM_REMOVES_EVERYTHING');
  const waypoints = courseWaypointListSchema.parse([
    // The new ends are the ends of the trimmed line. They carry no name and no recorded
    // sample: they are not the waypoints the owner placed, and saying otherwise would
    // attach an observation ordinal to a position nothing observed as a waypoint.
    { role: 'start', position: start, name: null, sourceSampleId: null, locked: false },
    ...keptWaypoints.slice(0, courseLimits.waypoints - 2).map((waypoint) => ({
      ...waypoint,
      role: 'via' as const,
    })),
    { role: 'finish', position: finish, name: null, sourceSampleId: null, locked: false },
  ]);
  const generation: CourseGeneration = {
    kind: 'privacy-trimmed',
    sourceRevision: input.sourceRevision,
    sourceGenerationKind: input.sourceGenerationKind,
    sourceGraphBuildId: input.sourceGraphBuildId,
    policyVersion: PRIVACY_TRIM_POLICY_VERSION,
    zoneSetDigest: privacyZoneSetDigest(input.zones),
    appliedZoneCount: input.zones.length,
    removedVertexCount,
    removedLeadingVertexCount: firstKept,
    removedTrailingVertexCount: inside.length - 1 - lastKept,
    // Waypoints that fell inside a protected area. The two ends are always replaced by the
    // ends of the trimmed line, which is a different fact and not counted here.
    removedWaypointCount: input.waypoints.filter((waypoint) =>
      insideAnyZone(waypoint.position, input.zones),
    ).length,
    vertexCount: coordinates.length,
  };
  return {
    coordinates,
    waypoints,
    generation,
    distanceMeters: plannedLineLengthMeters(coordinates),
  };
}
