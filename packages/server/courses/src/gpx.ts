import {
  courseGpxCreator,
  courseNameSchema,
  coursePositionSchema,
  courseWaypointSchema,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import {
  odblLicenceUrl,
  osmAttribution,
  osmCopyrightUrl,
} from '@workout/contracts/map-data-licence';

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
 * content, and elevation is not invented: a course carries no elevation, so no `ele`
 * element is written at all rather than a zero.
 *
 * What the document may say about itself is an allowlist (M2-01k-o, R6/A-1): `metadata`
 * always holds the OSM/ODbL notice and holds the course name only when the owner chose
 * to include names.
 * There is no description, no time, no extension, no course id and no revision number — a
 * GPX file is handed on, and each of those would tie the file to an account, a moment or
 * another file. `creator` is a neutral value that does not name this product.
 */
export const EXACT_COORDINATE_DIGITS = 7;
export const DISCLOSED_COORDINATE_DIGITS = 5;

/** GPX text is attribute- and element-safe. Names already refuse `<`, `>` and controls. */
function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function coordinateAttributes(position: CoursePosition, digits: number): string {
  const [longitude, latitude] = coursePositionSchema.parse(position);
  return `lat="${latitude.toFixed(digits)}" lon="${longitude.toFixed(digits)}"`;
}

export interface CourseGpxInput {
  readonly name: string;
  /**
   * Whether the course name and the waypoint names are written (D6). Off writes neither a
   * `name` element: the line, waypoint roles and required data attribution remain.
   */
  readonly includeNames: boolean;
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  /**
   * Decimal places of every coordinate. Five (about a metre) for what the privacy
   * confirmation discloses; seven only for the owner's explicitly chosen exact line.
   */
  readonly coordinateDigits: typeof EXACT_COORDINATE_DIGITS | typeof DISCLOSED_COORDINATE_DIGITS;
}

/**
 * Serialize a course as GPX 1.1.
 *
 * There is no storage reference, no athlete id, no activity id, no course id, no revision
 * and no time in the document: a file carries the line, the waypoint roles and — only when
 * the owner kept them — the names. The OSM/ODbL notice is independent of that choice.
 */
export function writeCourseGpx(input: CourseGpxInput): string {
  const name = courseNameSchema.parse(input.name);
  const waypoints = input.waypoints.map((waypoint) => courseWaypointSchema.parse(waypoint));
  const digits = input.coordinateDigits;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="${escapeXml(courseGpxCreator)}"` +
      ' xmlns="http://www.topografix.com/GPX/1/1">',
  ];
  lines.push('  <metadata>');
  if (input.includeNames) lines.push(`    <name>${escapeXml(name)}</name>`);
  lines.push('    <copyright author="OpenStreetMap contributors">');
  lines.push(`      <license>${escapeXml(odblLicenceUrl)}</license>`);
  lines.push('    </copyright>');
  lines.push(`    <link href="${escapeXml(osmCopyrightUrl)}">`);
  lines.push(`      <text>${escapeXml(osmAttribution)}</text>`);
  lines.push('    </link>');
  lines.push('  </metadata>');
  for (const waypoint of waypoints) {
    lines.push(`  <wpt ${coordinateAttributes(waypoint.position, digits)}>`);
    // No name is written for a waypoint that has none. A synthesised one ("<course>
    // start") is a fact nobody stated, and re-importing this document would turn it into
    // a name the owner never gave — the importer is the reason this is not cosmetic.
    if (input.includeNames && waypoint.name !== null)
      lines.push(`    <name>${escapeXml(waypoint.name)}</name>`);
    lines.push(`    <type>${escapeXml(waypoint.role)}</type>`);
    lines.push('  </wpt>');
  }
  lines.push('  <rte>');
  if (input.includeNames) lines.push(`    <name>${escapeXml(name)}</name>`);
  for (const position of input.coordinates)
    lines.push(`    <rtept ${coordinateAttributes(position, digits)} />`);
  lines.push('  </rte>');
  lines.push('</gpx>');
  return `${lines.join('\n')}\n`;
}

/**
 * File name of a course export. Sanitized to a conservative set, never a storage key, and
 * never a revision number (A-1): `-r3` would tell a recipient how often the owner edited
 * the course and tie two files of the same course together. Without names it is
 * `course.gpx`.
 */
export function courseGpxFileName(name: string | null): string {
  if (name === null) return 'course.gpx';
  const safe = courseNameSchema
    .parse(name)
    .replaceAll(/[^\p{Letter}\p{Number}_-]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 60);
  return `${safe.length > 0 ? safe : 'course'}.gpx`;
}
