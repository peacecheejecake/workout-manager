import {
  courseGpxCreator,
  courseNameSchema,
  coursePositionSchema,
  courseWaypointSchema,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';

/**
 * GPX export of one course.
 *
 * A course is a planned line, so it is written as a `rte`, never as a `trk`. That
 * distinction is the same one the importer keeps: M2-01a states a route is never promoted
 * into a recorded actual, and exporting a course as a track would be exactly that
 * promotion, performed by us. Waypoints are written as top-level `wpt` elements, which is
 * where GPX puts named points of interest; they are not repeated inside the route, so a
 * reader cannot mistake a waypoint for an extra route point.
 *
 * Coordinates are written with fixed precision so an export is byte-stable for the same
 * revision, and elevation is not invented: a course carries no elevation, so no `ele`
 * element is written at all rather than a zero.
 */
const COORDINATE_DIGITS = 7;

/** GPX text is attribute- and element-safe. Names already refuse `<`, `>` and controls. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function coordinateAttributes(position: CoursePosition): string {
  const [longitude, latitude] = coursePositionSchema.parse(position);
  return `lat="${latitude.toFixed(COORDINATE_DIGITS)}" lon="${longitude.toFixed(COORDINATE_DIGITS)}"`;
}

export interface CourseGpxInput {
  readonly name: string;
  readonly courseId: string;
  readonly courseRevision: number;
  readonly createdAt: string;
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
}

/**
 * Serialize a course revision as GPX 1.1.
 *
 * The identity of the revision travels in `metadata` as a plain name and description, not
 * as a private key: there is no storage reference, no athlete id and no activity id in the
 * document. An export is a personal artifact — it is not prepared for publication and
 * carries no sharing information.
 */
export function writeCourseGpx(input: CourseGpxInput): string {
  const name = courseNameSchema.parse(input.name);
  const waypoints = input.waypoints.map((waypoint) => courseWaypointSchema.parse(waypoint));
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(courseGpxCreator)}"` +
      ' xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${escapeXml(name)}</name>`,
    `    <desc>course ${escapeXml(input.courseId)} revision ${input.courseRevision}</desc>`,
    `    <time>${escapeXml(input.createdAt)}</time>`,
    '  </metadata>',
  ];
  for (const waypoint of waypoints) {
    lines.push(`  <wpt ${coordinateAttributes(waypoint.position)}>`);
    // No name is written for a waypoint that has none. A synthesised one ("<course>
    // start") is a fact nobody stated, and re-importing this document would turn it into
    // a name the owner never gave — the importer is the reason this is not cosmetic.
    if (waypoint.name !== null) lines.push(`    <name>${escapeXml(waypoint.name)}</name>`);
    lines.push(`    <type>${escapeXml(waypoint.role)}</type>`);
    lines.push('  </wpt>');
  }
  lines.push('  <rte>');
  lines.push(`    <name>${escapeXml(name)}</name>`);
  for (const position of input.coordinates)
    lines.push(`    <rtept ${coordinateAttributes(position)} />`);
  lines.push('  </rte>');
  lines.push('</gpx>');
  return `${lines.join('\n')}\n`;
}

/** File name of a course export. Sanitized to a conservative set, never a storage key. */
export function courseGpxFileName(name: string, courseRevision: number): string {
  const safe = courseNameSchema
    .parse(name)
    .replaceAll(/[^\p{Letter}\p{Number}_-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 60);
  return `${safe.length > 0 ? safe : 'course'}-r${courseRevision}.gpx`;
}
