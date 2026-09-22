import { createHash } from 'node:crypto';

import type { CourseGeneration, CourseLineage, CourseWaypoint } from '@workout/contracts/courses';

/**
 * Content identity of one course revision.
 *
 * This is what makes "a repeated successful write does not create a spurious version"
 * enforceable: a write whose result would be identical to the head under the same expected
 * revision returns the head instead of appending a copy of it. It therefore covers exactly
 * what a reader of the course would see — name, geometry, waypoints, the conditions the
 * geometry was generated under and the lineage it inherited.
 *
 * Three things are deliberately excluded because they change on every append and would
 * make every revision unique by construction: the revision number, the revision id and the
 * timestamps. So is the kind of edit that produced the revision — renaming a course back
 * to the name it already had is not a new version of anything.
 */
export interface CourseContent {
  readonly name: string;
  readonly coordinates: readonly (readonly [number, number])[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly generation: CourseGeneration;
  readonly lineage: readonly CourseLineage[];
}

function generationMaterial(generation: CourseGeneration): unknown {
  return [
    generation.kind,
    generation.activityId,
    generation.trackId,
    generation.trackRevision,
    generation.lineIndex,
    generation.segmentIndex,
    generation.startSampleId,
    generation.endSampleId,
    generation.vertexCount,
    generation.mapPathContentSha256,
    generation.simplificationVersion,
    generation.toleranceMeters,
  ];
}

export function courseContentDigest(content: CourseContent): string {
  const material = {
    algorithm: 'course-content-v1',
    name: content.name,
    coordinates: content.coordinates.map((position) => [position[0], position[1]]),
    waypoints: content.waypoints.map((waypoint) => [
      waypoint.role,
      waypoint.position[0],
      waypoint.position[1],
      waypoint.name,
      waypoint.sourceSampleId,
    ]),
    generation: generationMaterial(content.generation),
    lineage: [...content.lineage]
      .map((source) => [source.activityId, source.trackId, source.trackRevision] as const)
      .sort((left, right) => (left.join('|') < right.join('|') ? -1 : 1)),
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
