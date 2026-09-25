import {
  courseRouteAccessValueSchema,
  courseRouteSurfaceValueSchema,
  type CoursePosition,
  type CourseRouteKnowledge,
} from '@workout/contracts/courses';
import type { RoutePathDetails } from '@workout/contracts/routing';

import { greatCircleMeters } from './geo.js';

/**
 * Stairs, surface and access restrictions of one computed line, measured from the engine's
 * path details (M2-01ap, candidate evaluation version 2).
 *
 * The engine reports `[fromVertex, toVertex, value]` intervals over the geometry it returned.
 * Each geometry segment (vertex `i` to `i + 1`) takes the value of the interval that holds
 * it, and its length is measured from the geometry itself, so the metres here add up to the
 * line's own length and never to the engine's distance estimate.
 *
 * WHAT COUNTS AS KNOWN, PER FACT. Only a value that is a finding is reported as known; the
 * rest of the line is `unknownMeters` and reads "확인되지 않음":
 *
 * - stairs: `road_class=steps` is a stairway and any other named class is not one. The class
 *   `other` (a highway value GraphHopper does not name) is unknown.
 * - surface: every named surface is known; `missing` (no tag) is unknown.
 * - access restrictions: `road_access` other than `yes`, and `foot_access=false`. A stretch
 *   with neither is unknown — `road_access=yes` is also what an untagged way reads, so it is
 *   not evidence that nothing restricts it.
 *
 * A value this code does not recognise is unknown too: a name it cannot place is not a
 * finding it can report. A detail the engine did not report at all is `not_reported`.
 */
export function routeKnowledgeFromPathDetails(
  coordinates: readonly CoursePosition[],
  details: RoutePathDetails,
): CourseRouteKnowledge {
  const segmentMeters: number[] = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1];
    const to = coordinates[index];
    segmentMeters.push(from && to ? greatCircleMeters(from, to) : 0);
  }
  const stairs = tally(segmentMeters, [details.roadClass], ([roadClass]) => {
    if (roadClass === 'steps') return ['steps'];
    if (typeof roadClass === 'string' && roadClass !== 'other') return ['not_steps'];
    return [];
  });
  const surfaceValues = new Set<string>(courseRouteSurfaceValueSchema.options);
  const surface =
    details.surface === null
      ? null
      : tally(segmentMeters, [details.surface], ([value]) =>
          typeof value === 'string' && surfaceValues.has(value) ? [value] : [],
        );
  const accessValues = new Set<string>(courseRouteAccessValueSchema.options);
  const access =
    details.roadAccess === null && details.footAccess === null
      ? null
      : tally(segmentMeters, [details.roadAccess, details.footAccess], ([road, foot]) => {
          const found: string[] = [];
          if (typeof road === 'string' && road !== 'yes') {
            const value = `road_access=${road}`;
            if (accessValues.has(value)) found.push(value);
          }
          if (foot === false) found.push('foot_access=no');
          return found;
        });
  return {
    stairs: stairs === null ? { status: 'not_reported' } : reported(stairs, ['steps', 'not_steps']),
    surface:
      surface === null
        ? { status: 'not_reported' }
        : reported(surface, courseRouteSurfaceValueSchema.options),
    accessRestrictions:
      access === null
        ? { status: 'not_reported' }
        : reported(access, courseRouteAccessValueSchema.options),
    nightAccess: 'unknown',
    gradient: 'unknown',
  };
}

type Intervals = readonly (readonly [number, number, string | number | boolean])[];

interface Tally {
  readonly known: Map<string, { meters: number; sections: number }>;
  readonly unknownMeters: number;
}

/**
 * Walk the segments once. `classify` turns the values the listed details hold for a segment
 * into the findings it carries (none means unknown). A stretch is a maximal run of adjacent
 * segments carrying the same finding. `null` when every listed detail is missing.
 */
function tally(
  segmentMeters: readonly number[],
  lists: readonly (Intervals | null)[],
  classify: (values: readonly (string | number | boolean | undefined)[]) => readonly string[],
): Tally | null {
  if (lists.every((list) => list === null)) return null;
  const perSegment = lists.map((list) => valuesPerSegment(list, segmentMeters.length));
  const known = new Map<string, { meters: number; sections: number }>();
  let unknownMeters = 0;
  let previous = new Set<string>();
  for (const [index, meters] of segmentMeters.entries()) {
    const findings = new Set(classify(perSegment.map((values) => values[index])));
    if (findings.size === 0) unknownMeters += meters;
    for (const finding of findings) {
      const entry = known.get(finding) ?? { meters: 0, sections: 0 };
      entry.meters += meters;
      if (!previous.has(finding)) entry.sections += 1;
      known.set(finding, entry);
    }
    previous = findings;
  }
  return { known, unknownMeters };
}

function valuesPerSegment(
  list: Intervals | null,
  segmentCount: number,
): (string | number | boolean | undefined)[] {
  const values = new Array<string | number | boolean | undefined>(segmentCount).fill(undefined);
  if (list === null) return values;
  for (const [from, to, value] of list)
    for (let segment = from; segment < to && segment < segmentCount; segment += 1)
      values[segment] = value;
  return values;
}

/** Metres to 0.1 m: the stored evaluation stays bounded, and nothing finer is meaningful here. */
function tenth(meters: number): number {
  return Math.round(meters * 10) / 10;
}

function reported<Value extends string>(
  tallied: Tally,
  order: readonly Value[],
): {
  status: 'reported';
  known: { value: Value; meters: number; sections: number }[];
  unknownMeters: number;
} {
  const known = order
    .flatMap((value) => {
      const entry = tallied.known.get(value);
      return entry === undefined
        ? []
        : [{ value, meters: tenth(entry.meters), sections: entry.sections }];
    })
    // Longest first, then the contract's own order, so the same line always reads the same.
    .sort((left, right) => right.meters - left.meters);
  return { status: 'reported', known, unknownMeters: tenth(tallied.unknownMeters) };
}
