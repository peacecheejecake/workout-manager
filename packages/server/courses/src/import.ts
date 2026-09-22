import {
  courseGpxCreator,
  courseLimits,
  courseNameSchema,
  coursePositionSchema,
  courseWaypointListSchema,
  type CourseGeneration,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import type { ParsedTrackFile } from '@workout/contracts/tracks';

import { plannedLineLengthMeters } from './segment.js';

/**
 * Turning a parsed GPX file into a course (M2-01j).
 *
 * Three rules hold this file together.
 *
 * 1. **A track, a route and a waypoint stay three different things.** A GPX `trk` is a
 *    recording somebody made and a `rte` is a planned line; both can become a *course*,
 *    which is planned data, and neither becomes an Activity or a recorded actual. Which
 *    one the bytes came from is recorded in the conditions and never forgotten.
 * 2. **Nothing is merged and nothing is guessed.** A file with more than one track or
 *    route requires an explicit selection, and a track whose positions are split into
 *    several runs is refused rather than joined with a line nobody walked.
 * 3. **A file's `wpt` elements are not course waypoints.** They are a third kind of thing,
 *    and promoting a stranger's points of interest into the start and finish of a course
 *    would be exactly the kind of silent promotion the track contract forbids. The one
 *    exception is a document this product wrote: its `creator` says so, its waypoints are
 *    this course's own waypoints, and that is what makes an export round-trip.
 */
export type CourseImportErrorCode =
  | 'COURSE_IMPORT_NAME_INVALID'
  | 'COURSE_IMPORT_NO_IMPORTABLE_ITEM'
  | 'COURSE_IMPORT_SELECTION_REQUIRED'
  | 'COURSE_IMPORT_SELECTION_UNKNOWN'
  | 'COURSE_IMPORT_SPANS_A_GAP'
  | 'COURSE_IMPORT_TOO_FEW_POSITIONS'
  | 'COURSE_IMPORT_TOO_MANY_VERTICES'
  | 'COURSE_IMPORT_NAME_REQUIRED';

export class CourseImportError extends Error {
  constructor(readonly code: CourseImportErrorCode) {
    super(code);
    this.name = 'CourseImportError';
  }
}

export interface CourseImportItem {
  readonly sourceKind: 'gpx-trk' | 'gpx-rte';
  readonly itemIndex: number;
  readonly name: string | null;
  readonly pointCount: number;
  readonly positionedPointCount: number;
}

export interface CourseImportSelection {
  readonly sourceKind: 'gpx-trk' | 'gpx-rte';
  readonly itemIndex: number;
}

export interface ImportedCourseContent {
  readonly name: string;
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly generation: CourseGeneration;
  readonly distanceMeters: number;
}

/** What the file offers, in a stable order: recorded tracks first, then planned routes. */
export function listImportItems(parsed: ParsedTrackFile): CourseImportItem[] {
  const items: CourseImportItem[] = [];
  parsed.recorded.forEach((track, itemIndex) => {
    items.push({
      sourceKind: 'gpx-trk',
      itemIndex,
      name: track.name,
      pointCount: track.samples.length,
      positionedPointCount: track.samples.filter((sample) => sample.position !== null).length,
    });
  });
  parsed.routes.forEach((route, itemIndex) => {
    items.push({
      sourceKind: 'gpx-rte',
      itemIndex,
      name: route.name,
      pointCount: route.points.length,
      positionedPointCount: route.points.length,
    });
  });
  return items;
}

/**
 * The coordinates of one selected item, with the fact of whether they form a single run.
 *
 * A recorded track's samples are already segmented by the parser — a pause, a jump, a
 * reversed timestamp or a missing position all start a new segment. Stitching those into
 * one line would draw a straight stretch the file never claimed, which is the refusal
 * `SEGMENT_SPANS_A_GAP` exists for elsewhere in this package. So more than one positioned
 * run is refused here, by name, instead of being joined.
 */
function coordinatesOf(
  parsed: ParsedTrackFile,
  selection: CourseImportSelection,
): { coordinates: CoursePosition[]; name: string | null } {
  if (selection.sourceKind === 'gpx-rte') {
    const route = parsed.routes[selection.itemIndex];
    if (!route) throw new CourseImportError('COURSE_IMPORT_SELECTION_UNKNOWN');
    return {
      coordinates: route.points.map((point) => coursePositionSchema.parse(point.position)),
      name: route.name,
    };
  }
  const track = parsed.recorded[selection.itemIndex];
  if (!track) throw new CourseImportError('COURSE_IMPORT_SELECTION_UNKNOWN');
  const positionOf = new Map(track.samples.map((sample) => [sample.sampleId, sample.position]));
  const runs: CoursePosition[][] = [];
  for (const segment of track.segments) {
    const run: CoursePosition[] = [];
    for (const sampleId of segment.sampleIds) {
      const position = positionOf.get(sampleId) ?? null;
      if (position !== null) run.push(coursePositionSchema.parse(position));
    }
    if (run.length > 0) runs.push(run);
  }
  if (runs.length === 0) throw new CourseImportError('COURSE_IMPORT_TOO_FEW_POSITIONS');
  if (runs.length > 1) throw new CourseImportError('COURSE_IMPORT_SPANS_A_GAP');
  return { coordinates: runs[0] ?? [], name: track.name };
}

/**
 * Whether the file's own waypoints may be adopted as this course's waypoints.
 *
 * Only for a document this product wrote. `creator` is untrusted text and is trusted for
 * nothing else: the waypoints it unlocks are still validated against the waypoint contract,
 * and the worst a forged creator can do is make the file's own points the course's own
 * points — which is what the owner asked for by importing the file.
 */
function adoptableWaypoints(parsed: ParsedTrackFile): readonly CourseWaypoint[] | null {
  if (parsed.creator !== courseGpxCreator) return null;
  const count = parsed.waypoints.length;
  const waypoints = parsed.waypoints.map((waypoint, index) => ({
    role:
      index === 0
        ? ('start' as const)
        : index === count - 1
          ? ('finish' as const)
          : ('via' as const),
    // Deliberately not `safeParse`, unlike the name below. A name the ledger refuses is an
    // ordinary, expected case — track metadata may be 256 characters and a course name 120
    // — while a position the course contract refuses cannot come out of this parser at
    // all, because the GPX reader validates every coordinate before it gets here. If one
    // ever did, it would mean the parser had stopped doing that, and quietly dropping the
    // adoption would hide it. The two rules differ because the two facts differ.
    position: coursePositionSchema.parse(waypoint.position),
    // A name from a file is untrusted text; the course name schema is the same rule the
    // rest of the ledger holds text to, and a name it refuses drops the whole adoption
    // rather than being silently blanked.
    name: waypoint.name === null ? null : (courseNameSchema.safeParse(waypoint.name).data ?? null),
    // An imported point was never observed by us. Claiming a recorded sample for it would
    // attach an observation ordinal to a coordinate no recording of ours produced.
    sourceSampleId: null,
    locked: false,
  }));
  // The waypoint contract is the single rule for whether this list may be adopted: too few
  // to be a start and a finish, more than a course may hold, or any other way the list is
  // not a course's waypoints, and the whole adoption is dropped rather than truncated or
  // repaired. A separate count check here said the same thing twice — removing it failed
  // nothing, which is how it was found — so the contract says it once.
  const parsedList = courseWaypointListSchema.safeParse(waypoints);
  return parsedList.success ? parsedList.data : null;
}

/**
 * Build the content of a course from one item of a parsed file.
 *
 * The caller has already parsed the bytes on the server: this function never sees a
 * client's parse, a client's geometry or a client's distance. What it produces is ordinary
 * course content, so everything downstream — digest, CAS, immutability, GPX export,
 * reclamation — applies to an imported course exactly as it does to a cut one.
 */
export function courseFromImportedFile(input: {
  readonly parsed: ParsedTrackFile;
  readonly selection: CourseImportSelection | null;
  readonly name: string | null;
}): ImportedCourseContent {
  const items = listImportItems(input.parsed);
  if (items.length === 0) throw new CourseImportError('COURSE_IMPORT_NO_IMPORTABLE_ITEM');
  if (items.length > 1 && input.selection === null)
    throw new CourseImportError('COURSE_IMPORT_SELECTION_REQUIRED');
  const only = items[0];
  if (only === undefined) throw new CourseImportError('COURSE_IMPORT_NO_IMPORTABLE_ITEM');
  const selection: CourseImportSelection = input.selection ?? {
    sourceKind: only.sourceKind,
    itemIndex: only.itemIndex,
  };
  if (
    !items.some(
      (item) => item.sourceKind === selection.sourceKind && item.itemIndex === selection.itemIndex,
    )
  )
    throw new CourseImportError('COURSE_IMPORT_SELECTION_UNKNOWN');
  const { coordinates, name: itemName } = coordinatesOf(input.parsed, selection);
  if (coordinates.length < 2) throw new CourseImportError('COURSE_IMPORT_TOO_FEW_POSITIONS');
  if (coordinates.length > courseLimits.vertices)
    throw new CourseImportError('COURSE_IMPORT_TOO_MANY_VERTICES');
  const chosenName = input.name ?? itemName;
  if (chosenName === null || chosenName.trim() === '')
    throw new CourseImportError('COURSE_IMPORT_NAME_REQUIRED');
  // A name from a file is untrusted text and it is held to the ledger's own rule, which is
  // stricter than the parser's: track metadata may be 256 characters and a course name may
  // be 120. A name the ledger will not take is a refusal with a name of its own, not an
  // unhandled schema error.
  const parsedName = courseNameSchema.safeParse(chosenName);
  if (!parsedName.success) throw new CourseImportError('COURSE_IMPORT_NAME_INVALID');
  const name = parsedName.data;
  const adopted = adoptableWaypoints(input.parsed);
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first === undefined || last === undefined)
    throw new CourseImportError('COURSE_IMPORT_TOO_FEW_POSITIONS');
  const waypoints: readonly CourseWaypoint[] = adopted ?? [
    { role: 'start', position: first, name: null, sourceSampleId: null, locked: false },
    { role: 'finish', position: last, name: null, sourceSampleId: null, locked: false },
  ];
  const generation: CourseGeneration = {
    kind: 'imported-file',
    format: 'gpx',
    sourceKind: selection.sourceKind,
    itemIndex: selection.itemIndex,
    parserId: input.parsed.parserId,
    parserVersion: 1,
    fileSha256: input.parsed.fileSha256,
    fileByteLength: input.parsed.fileByteLength,
    // The parser's name for the file, never the caller's. The browser is the only place
    // that knows what the file was called, so the name does come from the client — but it
    // goes in through the parse, which is where untrusted text is cleaned, and comes back
    // out of it here. Preferring the raw value would have put whatever the client sent
    // straight into the revision's conditions and the account export, which is exactly the
    // thing this route says it does not do.
    originalFilename: input.parsed.originalFilename,
    fileCreator: input.parsed.creator,
    vertexCount: coordinates.length,
    importedWaypointCount: adopted ? adopted.length : 0,
    ignoredFileWaypointCount: adopted ? 0 : input.parsed.waypoints.length,
  };
  return {
    name,
    coordinates,
    waypoints: courseWaypointListSchema.parse(waypoints),
    generation,
    distanceMeters: plannedLineLengthMeters(coordinates),
  };
}
