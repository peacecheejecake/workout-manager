import {
  courseLimits,
  type CourseGeneration,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import type { MapPath } from '@workout/contracts/tracks';
import { greatCircleMeters } from './geo.js';

/**
 * Cutting an explicitly selected range out of a stored recording.
 *
 * The input is the server's own stored map-path derivative, not anything a client sent:
 * the request names two sample ids and the server decides what geometry they denote. Three
 * rules make the cut honest.
 *
 * 1. A selection must lie inside ONE drawn line. Lines are the runs the recording could
 *    actually be drawn as, so a range that spans two of them spans a gap, and joining
 *    across a gap with a straight line is exactly what the plan forbids.
 * 2. Endpoints are matched by sample id, never by display index. The stored
 *    `vertexSampleIds` is the only mapping between a drawn vertex and an observation.
 * 3. An ambiguous endpoint — a sample id that appears at more than one vertex of the line
 *    — is refused rather than resolved to the first match.
 *
 * Nothing here writes to the recording. The result is new geometry for a new course
 * revision; the `MapPath` it was cut from is untouched and stays the recording's own.
 */
export class CourseSegmentError extends Error {
  constructor(
    readonly code:
      | 'SEGMENT_ENDPOINT_NOT_DRAWN'
      | 'SEGMENT_ENDPOINT_AMBIGUOUS'
      | 'SEGMENT_SPANS_A_GAP'
      | 'SEGMENT_TOO_SHORT'
      | 'SEGMENT_TOO_LONG'
      | 'SEGMENT_NOT_A_RECORDING',
  ) {
    super(code);
    this.name = 'CourseSegmentError';
  }
}

export interface CourseSegmentSelection {
  readonly startSampleId: string;
  readonly endSampleId: string;
}

export interface CourseSegmentSource {
  readonly activityId: string;
  readonly trackId: string;
  readonly trackRevision: number;
  readonly mapPathContentSha256: string;
}

export interface DerivedCourseGeometry {
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly generation: CourseGeneration;
  readonly distanceMeters: number;
}

/** Vertices of one line, with the sample each one came from. */
interface LineMatch {
  readonly lineIndex: number;
  readonly startVertex: number;
  readonly endVertex: number;
}

function locate(sampleIds: readonly string[], sampleId: string): number | null | 'ambiguous' {
  let found: number | null = null;
  for (let index = 0; index < sampleIds.length; index += 1) {
    if (sampleIds[index] !== sampleId) continue;
    if (found !== null) return 'ambiguous';
    found = index;
  }
  return found;
}

function matchLine(path: MapPath, selection: CourseSegmentSelection): LineMatch {
  let match: LineMatch | null = null;
  let sawStart = false;
  let sawEnd = false;
  for (let lineIndex = 0; lineIndex < path.vertexSampleIds.length; lineIndex += 1) {
    const sampleIds = path.vertexSampleIds[lineIndex] ?? [];
    const start = locate(sampleIds, selection.startSampleId);
    const end = locate(sampleIds, selection.endSampleId);
    if (start === 'ambiguous' || end === 'ambiguous')
      throw new CourseSegmentError('SEGMENT_ENDPOINT_AMBIGUOUS');
    if (start !== null) sawStart = true;
    if (end !== null) sawEnd = true;
    if (start === null || end === null) continue;
    // The same id cannot legitimately appear in two lines: a sample is drawn at most once.
    if (match !== null) throw new CourseSegmentError('SEGMENT_ENDPOINT_AMBIGUOUS');
    match = { lineIndex, startVertex: start, endVertex: end };
  }
  if (match !== null) return match;
  // Both ends are drawn, but not in the same run: the selection would have to jump a gap.
  if (sawStart && sawEnd) throw new CourseSegmentError('SEGMENT_SPANS_A_GAP');
  throw new CourseSegmentError('SEGMENT_ENDPOINT_NOT_DRAWN');
}

/**
 * Derive one course geometry from a stored recording.
 *
 * A reversed selection is accepted and cut in recording order — the user picked two ends,
 * not a direction — and the waypoints keep the order the geometry is drawn in.
 */
export function deriveCourseFromRecordedSegment(input: {
  readonly path: MapPath;
  readonly selection: CourseSegmentSelection;
  readonly source: CourseSegmentSource;
}): DerivedCourseGeometry {
  const { path, selection, source } = input;
  if (path.role !== 'recorded') throw new CourseSegmentError('SEGMENT_NOT_A_RECORDING');
  const match = matchLine(path, selection);
  const first = Math.min(match.startVertex, match.endVertex);
  const last = Math.max(match.startVertex, match.endVertex);
  if (last - first < 1) throw new CourseSegmentError('SEGMENT_TOO_SHORT');
  if (last - first + 1 > courseLimits.vertices) throw new CourseSegmentError('SEGMENT_TOO_LONG');
  const line = path.geometry.coordinates[match.lineIndex] ?? [];
  const sampleIds = path.vertexSampleIds[match.lineIndex] ?? [];
  const coordinates: CoursePosition[] = [];
  for (let index = first; index <= last; index += 1) {
    const position = line[index];
    if (position === undefined) throw new CourseSegmentError('SEGMENT_ENDPOINT_NOT_DRAWN');
    coordinates.push([position[0], position[1]]);
  }
  const startSampleId = sampleIds[first];
  const endSampleId = sampleIds[last];
  if (startSampleId === undefined || endSampleId === undefined)
    throw new CourseSegmentError('SEGMENT_ENDPOINT_NOT_DRAWN');
  const waypoints: CourseWaypoint[] = [
    {
      role: 'start',
      position: coordinates[0] as CoursePosition,
      name: null,
      sourceSampleId: startSampleId,
      locked: false,
    },
    {
      role: 'finish',
      position: coordinates[coordinates.length - 1] as CoursePosition,
      name: null,
      sourceSampleId: endSampleId,
      locked: false,
    },
  ];
  return {
    coordinates,
    waypoints,
    distanceMeters: plannedLineLengthMeters(coordinates),
    generation: {
      kind: 'recorded-segment',
      activityId: source.activityId,
      trackId: source.trackId,
      trackRevision: source.trackRevision,
      lineIndex: match.lineIndex,
      segmentIndex: path.lineSegmentIndices[match.lineIndex] ?? 0,
      startSampleId,
      endSampleId,
      vertexCount: coordinates.length,
      mapPathContentSha256: source.mapPathContentSha256,
      simplificationVersion: 1,
      toleranceMeters: path.toleranceMeters,
    },
  };
}

/**
 * Length of the planned line. This is the fourth of the four distances the plan keeps
 * apart: it is not the device-reported distance, not the distance recomputed from the
 * recording's own positions, and not a routing estimate. It is only the length of the
 * vertices this course actually carries.
 */
export function plannedLineLengthMeters(coordinates: readonly CoursePosition[]): number {
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    if (previous === undefined || current === undefined) continue;
    total += greatCircleMeters(previous, current);
  }
  return total;
}
