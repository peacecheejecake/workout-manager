import { randomBytes } from 'node:crypto';

import {
  courseSharingLimits,
  type CourseDisclosureExposure,
  type CourseDisclosureOption,
  type CourseDisclosurePurpose,
} from '@workout/contracts/course-sharing';
import {
  courseLimits,
  courseWaypointListSchema,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';

import { greatCircleMeters } from './geo.js';
import {
  CourseTrimError,
  insideAnyCircle,
  lineEntersAnyCircle,
  trimLineAgainstCircles,
  type ProtectedCircle,
  type TrimmedLine,
} from './privacy-trim.js';
import { plannedLineLengthMeters } from './segment.js';

/**
 * What a course may disclose when it leaves the account (M2-01k-o §2–§5).
 *
 * One classification and one finishing step, shared by the owner's GPX and the view-only
 * link so the two can never be cut by different rules:
 *
 * 1. **Classify** the owner's line against a set of circles — the protected areas for a
 *    GPX, the wider offset share circles for a link. The classification is the privacy
 *    trim's own (`trimLineAgainstCircles`): no circles, a refusal (re-entry, a line through
 *    an area, nothing left), no contact at all, or ends inside.
 * 2. **Finish** the line that will leave: round every coordinate to five decimals (R-2)
 *    and then check the circles again, on the rounded line (T25). Rounding moves a vertex by
 *    up to about a metre, which can push a vertex that sat just outside an edge onto it; the
 *    finished line is trimmed again rather than trusted. Only then are the waypoints fixed:
 *    a via inside a circle goes, and an end that was cut becomes the unnamed end of the line.
 *
 * The exact line (the owner's explicit choice, D3b) skips both: it is the revision as it is.
 */
export type DisclosureClassification =
  | { readonly outcome: 'no-zones' }
  | { readonly outcome: 'blocked'; readonly reason: BlockedReason }
  | { readonly outcome: 'no-intersection' }
  | { readonly outcome: 'ends-inside'; readonly trimmed: TrimmedLine };

type BlockedReason =
  | 'COURSE_TRIM_SPLITS_THE_LINE'
  | 'COURSE_TRIM_LINE_CROSSES_AREA'
  | 'COURSE_TRIM_REMOVES_EVERYTHING';

function blockedReason(error: CourseTrimError): BlockedReason | null {
  switch (error.code) {
    case 'COURSE_TRIM_SPLITS_THE_LINE':
    case 'COURSE_TRIM_LINE_CROSSES_AREA':
    case 'COURSE_TRIM_REMOVES_EVERYTHING':
      return error.code;
    default:
      return null;
  }
}

export function classifyDisclosure(
  coordinates: readonly CoursePosition[],
  waypoints: readonly CourseWaypoint[],
  circles: readonly ProtectedCircle[],
): DisclosureClassification {
  if (circles.length === 0) return { outcome: 'no-zones' };
  try {
    return {
      outcome: 'ends-inside',
      trimmed: trimLineAgainstCircles(coordinates, waypoints, circles),
    };
  } catch (error) {
    if (!(error instanceof CourseTrimError)) throw error;
    if (error.code === 'COURSE_TRIM_CHANGES_NOTHING') return { outcome: 'no-intersection' };
    const reason = blockedReason(error);
    if (reason === null) throw error;
    return { outcome: 'blocked', reason };
  }
}

/** Round one position to `digits` decimals, both ordinates. */
export function roundPosition(position: CoursePosition, digits: number): CoursePosition {
  const factor = 10 ** digits;
  return [Math.round(position[0] * factor) / factor, Math.round(position[1] * factor) / factor];
}

export interface DisclosedLine {
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly distanceMeters: number;
}

/**
 * Round, re-check and fix the waypoints of a line that is about to leave.
 *
 * `cutStart`/`cutFinish` say whether the classification already removed that end; the
 * re-check may remove more. A cut end is always the unnamed end of the finished line. An
 * uncut end keeps the owner's waypoint (rounded) unless it lies in a circle itself.
 *
 * `endsOnLine` (a link, R-3): both ends are always the finished line's own first and last
 * vertex, cut or not. Otherwise a link whose start sat exactly on its first vertex would say
 * it had been cut, and one whose start did not would say it had not.
 *
 * Throws `CourseTrimError` with a blocking code if the rounded line would have to be cut
 * in the middle — rounding has then produced a line that cannot leave, and it does not.
 */
export function finishDisclosedLine(input: {
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly circles: readonly ProtectedCircle[];
  readonly cutStart: boolean;
  readonly cutFinish: boolean;
  readonly endsOnLine?: boolean;
}): DisclosedLine {
  const digits = courseSharingLimits.disclosedCoordinateDigits;
  const rounded = input.coordinates.map((position) => roundPosition(position, digits));
  const roundedWaypoints = input.waypoints.map((waypoint) => ({
    ...waypoint,
    position: roundPosition(waypoint.position, digits),
  }));
  let line: readonly CoursePosition[] = rounded;
  let cutStart = input.cutStart;
  let cutFinish = input.cutFinish;
  if (input.circles.length > 0) {
    try {
      const again = trimLineAgainstCircles(rounded, roundedWaypoints, input.circles);
      line = again.coordinates;
      cutStart ||= again.removedLeadingVertexCount > 0;
      cutFinish ||= again.removedTrailingVertexCount > 0;
    } catch (error) {
      if (!(error instanceof CourseTrimError) || error.code !== 'COURSE_TRIM_CHANGES_NOTHING')
        throw error;
    }
  }
  const first = line[0];
  const last = line[line.length - 1];
  if (first === undefined || last === undefined || line.length < 2)
    throw new CourseTrimError('COURSE_TRIM_REMOVES_EVERYTHING');
  const outside = (position: CoursePosition) => !insideAnyCircle(position, input.circles);
  const originalStart = roundedWaypoints[0];
  const originalFinish = roundedWaypoints[roundedWaypoints.length - 1];
  const lineEnd = (role: 'start' | 'finish', position: CoursePosition): CourseWaypoint => ({
    role,
    position,
    name: null,
    sourceSampleId: null,
    locked: false,
  });
  const endsOnLine = input.endsOnLine === true;
  const start =
    !endsOnLine && !cutStart && originalStart !== undefined && outside(originalStart.position)
      ? originalStart
      : lineEnd('start', first);
  const finish =
    !endsOnLine && !cutFinish && originalFinish !== undefined && outside(originalFinish.position)
      ? originalFinish
      : lineEnd('finish', last);
  const vias = roundedWaypoints
    .filter((waypoint) => waypoint.role === 'via' && outside(waypoint.position))
    .slice(0, courseLimits.waypoints - 2);
  const waypoints = courseWaypointListSchema.parse([
    { ...start, role: 'start' },
    ...vias,
    { ...finish, role: 'finish' },
  ]);
  // The invariant, asserted rather than assumed: nothing that leaves touches a circle.
  if (
    line.some((position) => !outside(position)) ||
    lineEntersAnyCircle(line, input.circles) ||
    waypoints.some((waypoint) => !outside(waypoint.position))
  )
    throw new CourseTrimError('COURSE_TRIM_LINE_CROSSES_AREA');
  return { coordinates: line, waypoints, distanceMeters: plannedLineLengthMeters(line) };
}

/** Each line the owner may confirm, for one purpose, exactly as it would leave. */
export interface DisclosureChoices {
  readonly classification: DisclosureClassification;
  readonly options: readonly (CourseDisclosureOption & { readonly line: DisclosedLine })[];
  readonly defaultExposure: CourseDisclosureExposure | null;
}

function option(
  exposure: CourseDisclosureExposure,
  source: readonly CoursePosition[],
  line: DisclosedLine,
  extra: {
    readonly requiresAcknowledgement: boolean;
    readonly appendsRevision: boolean;
    readonly coordinateDigits: 5 | 7;
    readonly removedWaypointCount: number;
  },
): CourseDisclosureOption & { readonly line: DisclosedLine } {
  const start = line.coordinates[0];
  const finish = line.coordinates[line.coordinates.length - 1];
  const sourceStart = source[0];
  const sourceFinish = source[source.length - 1];
  if (!start || !finish || !sourceStart || !sourceFinish) throw new Error('EMPTY_LINE');
  return {
    exposure,
    coordinates: line.coordinates.map((position) => [position[0], position[1]]),
    start,
    finish,
    startShiftMeters: greatCircleMeters(sourceStart, start),
    finishShiftMeters: greatCircleMeters(sourceFinish, finish),
    vertexCount: line.coordinates.length,
    distanceMeters: line.distanceMeters,
    ...extra,
    line,
  };
}

/** The owner's exact line, as their own GPX would carry it (D3b): no rounding, no trim. */
export function exactLine(
  coordinates: readonly CoursePosition[],
  waypoints: readonly CourseWaypoint[],
): DisclosedLine {
  return { coordinates, waypoints, distanceMeters: plannedLineLengthMeters(coordinates) };
}

/**
 * Everything the confirmation screen may offer for `purpose` (§5 table):
 *
 * | case             | export                                       | share                  |
 * | ---------------- | -------------------------------------------- | ---------------------- |
 * | no zones         | `no-zones-exact` after a warning (D3a)       | nothing (D3c)          |
 * | refused trim     | nothing (D3)                                 | nothing (D3)           |
 * | no contact       | `no-zone-intersection`                       | `no-zone-intersection` |
 * | ends inside      | `trimmed` (default), `owner-exact` + warning | `trimmed` only (D3b)   |
 */
export function disclosureChoices(
  purpose: CourseDisclosurePurpose,
  coordinates: readonly CoursePosition[],
  waypoints: readonly CourseWaypoint[],
  circles: readonly ProtectedCircle[],
): DisclosureChoices {
  try {
    return choicesFor(purpose, coordinates, waypoints, circles);
  } catch (error) {
    // The rounded line could not leave without a cut in the middle (T25): rounding moved a
    // vertex that sat within a metre of an edge onto it. That line does not leave either.
    if (!(error instanceof CourseTrimError)) throw error;
    const reason = blockedReason(error);
    if (reason === null) throw error;
    return { classification: { outcome: 'blocked', reason }, options: [], defaultExposure: null };
  }
}

function choicesFor(
  purpose: CourseDisclosurePurpose,
  coordinates: readonly CoursePosition[],
  waypoints: readonly CourseWaypoint[],
  circles: readonly ProtectedCircle[],
): DisclosureChoices {
  const classification = classifyDisclosure(coordinates, waypoints, circles);
  const finish = (line: {
    coordinates: readonly CoursePosition[];
    waypoints: readonly CourseWaypoint[];
    cutStart: boolean;
    cutFinish: boolean;
  }) => finishDisclosedLine({ ...line, circles, endsOnLine: purpose === 'share' });
  switch (classification.outcome) {
    case 'blocked':
      return { classification, options: [], defaultExposure: null };
    case 'no-zones': {
      if (purpose === 'share') return { classification, options: [], defaultExposure: null };
      const line = finish({ coordinates, waypoints, cutStart: false, cutFinish: false });
      return {
        classification,
        options: [
          option('no-zones-exact', coordinates, line, {
            requiresAcknowledgement: true,
            appendsRevision: false,
            coordinateDigits: 5,
            removedWaypointCount: 0,
          }),
        ],
        defaultExposure: 'no-zones-exact',
      };
    }
    case 'no-intersection': {
      const line = finish({ coordinates, waypoints, cutStart: false, cutFinish: false });
      return {
        classification,
        options: [
          option('no-zone-intersection', coordinates, line, {
            requiresAcknowledgement: false,
            appendsRevision: false,
            coordinateDigits: 5,
            removedWaypointCount: waypoints.length - line.waypoints.length,
          }),
        ],
        defaultExposure: 'no-zone-intersection',
      };
    }
    case 'ends-inside': {
      const trimmed = classification.trimmed;
      const line = finish({
        coordinates: trimmed.coordinates,
        waypoints: trimmed.waypoints,
        cutStart: trimmed.removedLeadingVertexCount > 0,
        cutFinish: trimmed.removedTrailingVertexCount > 0,
      });
      const trimmedOption = option('trimmed', coordinates, line, {
        requiresAcknowledgement: false,
        // Only the owner's GPX writes a revision: the link keeps its snapshot beside the
        // ledger and never adds to it (B-1).
        appendsRevision: purpose === 'export',
        coordinateDigits: 5,
        removedWaypointCount: trimmed.removedWaypointCount,
      });
      if (purpose === 'share')
        return { classification, options: [trimmedOption], defaultExposure: 'trimmed' };
      return {
        classification,
        options: [
          trimmedOption,
          option('owner-exact', coordinates, exactLine(coordinates, waypoints), {
            requiresAcknowledgement: true,
            appendsRevision: false,
            coordinateDigits: 7,
            removedWaypointCount: 0,
          }),
        ],
        defaultExposure: 'trimmed',
      };
    }
  }
}

/** How many of the line's vertices each circle covers, in the circles' own order. */
export function removedVerticesPerCircle(
  coordinates: readonly CoursePosition[],
  circles: readonly ProtectedCircle[],
): number[] {
  return circles.map(
    (circle) =>
      coordinates.filter(
        (position) => greatCircleMeters(circle.center, position) <= circle.radiusMeters,
      ).length,
  );
}

// ── Share circles (B-1) ────────────────────────────────────────────────────────────────

/**
 * A protected area's secret offset, as a point of the unit disc. It is drawn once, when
 * the area is made, and scaled by 0.5 · S whenever it is used; it is never drawn again for
 * a link, never returned in any response and never logged.
 */
export interface ShareOffset {
  readonly x: number;
  readonly y: number;
}

/** A uniform number in [0, 1) from the operating system's CSPRNG (48 bits). */
export function secureUnitRandom(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/** A point drawn uniformly from the unit disc. */
export function drawShareOffset(unit: () => number = secureUnitRandom): ShareOffset {
  const radius = Math.sqrt(unit());
  const angle = 2 * Math.PI * unit();
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

const METERS_PER_DEGREE_LATITUDE = (Math.PI / 180) * 6_371_008.8;

/** S = max(r, 200 m). */
export function shareScaleMeters(radiusMeters: number): number {
  return Math.max(radiusMeters, courseSharingLimits.shareMinimumScaleMeters);
}

/**
 * The circle a link is trimmed against for one protected area: radius 1.5 · S, centred on
 * the area's centre moved by the secret offset scaled to 0.5 · S. The protected area lies
 * wholly inside it (0.5 · S + r ≤ 1.5 · S), so a link never shows more than the owner's own
 * trim would.
 */
export function shareCircle(
  zone: { readonly center: CoursePosition; readonly radiusMeters: number },
  offset: ShareOffset,
): ProtectedCircle {
  const scale = shareScaleMeters(zone.radiusMeters);
  const shift = courseSharingLimits.shareOffsetFactor * scale;
  const [longitude, latitude] = zone.center;
  const north = offset.y * shift;
  const east = offset.x * shift;
  const centerLatitude = Math.max(-90, Math.min(90, latitude + north / METERS_PER_DEGREE_LATITUDE));
  const cosine = Math.max(1e-6, Math.cos((latitude * Math.PI) / 180));
  const rawLongitude = longitude + east / (METERS_PER_DEGREE_LATITUDE * cosine);
  const centerLongitude = ((((rawLongitude + 180) % 360) + 360) % 360) - 180;
  return {
    center: [centerLongitude, centerLatitude],
    radiusMeters: courseSharingLimits.shareRadiusFactor * scale,
  };
}

/**
 * Every circle a link is cut against for one protected area: its share circle and the area
 * itself (R-2). The share circle is placed on a flat local map but tested with great-circle
 * distance, so for a large area it can miss a sliver of the area's own edge — about 0.15 m
 * for a 5 km area at 37.5°N, more further north. Cutting against the area as well makes
 * "a link never shows what the owner's own trim would remove" exact rather than nearly so.
 */
export function shareCircles(
  zone: { readonly center: CoursePosition; readonly radiusMeters: number },
  offset: ShareOffset,
): ProtectedCircle[] {
  return [shareCircle(zone, offset), { center: zone.center, radiusMeters: zone.radiusMeters }];
}

/** Whether a stored link's line or waypoints touch a circle — the zone-add re-check (B-6). */
export function sharedLineTouchesCircle(
  snapshot: {
    readonly coordinates: readonly CoursePosition[];
    readonly waypoints: readonly { readonly position: CoursePosition }[];
  },
  circle: ProtectedCircle,
): boolean {
  return (
    snapshot.coordinates.some((position) => insideAnyCircle(position, [circle])) ||
    lineEntersAnyCircle(snapshot.coordinates, [circle]) ||
    snapshot.waypoints.some((waypoint) => insideAnyCircle(waypoint.position, [circle]))
  );
}
