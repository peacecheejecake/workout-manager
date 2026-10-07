import { z } from 'zod';
import { courseHeadSchema, courseRevisionSchema, courseLimits } from '@workout/contracts/courses';
import { raceCourseRefSchema } from '@workout/contracts/races';
import { activityTrackRevisionSchema } from '@workout/contracts/activity-tracks';
import { courseContentDigest } from '@workout/server-courses/digest';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

const uuid = z.uuid();
const tenant = z.string().min(1).max(200);
const absent = z.strictObject({ state: z.literal('absent') });
const suppression = z.discriminatedUnion('state', [
  absent,
  z.strictObject({ state: z.literal('present') }),
]);
const lineageSource = z.strictObject({
  athleteId: tenant,
  activity: z.strictObject({
    id: uuid,
    revision: z.number().int().min(1).max(2147483647),
    deleted: z.boolean(),
  }),
  track: activityTrackRevisionSchema,
  suppression,
});
/** Already captured owned rows, not a browser DTO or an ownership authorization.
 * Legacy metadata remains decodable but cannot establish geometry correspondence. */
export const courseReadManifestSchema = z.strictObject({
  ref: raceCourseRefSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  owned: z
    .strictObject({
      athleteId: tenant,
      head: courseHeadSchema,
      revision: courseRevisionSchema.nullable(),
      deletion: z.discriminatedUnion('state', [
        absent,
        z.strictObject({ state: z.literal('present'), courseId: uuid }),
      ]),
    })
    .optional(),
  lineageSources: z.array(lineageSource).max(5000).optional(),
});
export type CourseReadManifest = z.infer<typeof courseReadManifestSchema>;
export type CourseReadBlocker =
  | 'invalid_projection'
  | 'projection_limit'
  | 'course_reference_mismatch'
  | 'course_owned_projection_port_missing'
  | 'foreign_source'
  | 'course_deleted'
  | 'course_unavailable'
  | 'course_version_missing'
  | 'course_version_mismatch'
  | 'course_head_mismatch'
  | 'course_digest_mismatch'
  | 'course_geometry_mismatch'
  | 'lineage_source_port_missing'
  | 'lineage_source_mismatch'
  | 'lineage_source_unavailable';
const fullManifestMissing = [
  'complete_catalog_and_actual_manifest',
  'supplementary_reference_manifest',
  'routine_occurrences_and_started_runs',
  'complete_source_permission_manifest',
  'manual_purpose_app_and_policy_binding',
] as const;
export type CourseReadManifestResult = {
  status: 'validated_read_scope' | 'blocked';
  authority: 'none';
  freshness: 'not_checked';
  complete: false;
  remaining: readonly (typeof fullManifestMissing)[number][];
  blockers: CourseReadBlocker[];
  digest: string | null;
};
const scopeSchema = z.strictObject({
  athleteId: tenant,
  eventCourse: raceCourseRefSchema.nullable(),
});
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sourceKey = (activityId: string, trackId: string, trackRevision: number) =>
  JSON.stringify([activityId.toLowerCase(), trackId.toLowerCase(), trackRevision]);
function bytes(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? Infinity : Buffer.byteLength(encoded, 'utf8');
  } catch {
    return Infinity;
  }
}
/** Frozen correspondence only. Routing acceptance, source permissions, current
 * freshness and complete approval admission require separate actual producers. */
export function validateCourseReadManifest(
  scopeInput: unknown,
  captureInput: unknown,
): CourseReadManifestResult {
  const blockers: CourseReadBlocker[] = [];
  const result = (digest: string | null = null): CourseReadManifestResult => ({
    status: blockers.length === 0 ? 'validated_read_scope' : 'blocked',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    remaining: fullManifestMissing,
    blockers,
    digest,
  });
  if (bytes(captureInput) > 4 * 1024 * 1024) {
    blockers.push('projection_limit');
    return result();
  }
  const scope = scopeSchema.safeParse(scopeInput);
  const parsed = courseReadManifestSchema.nullable().safeParse(captureInput);
  if (!scope.success || !parsed.success) {
    blockers.push('invalid_projection');
    return result();
  }
  const capture = parsed.data;
  const ref = scope.data.eventCourse;
  if (ref === null || capture === null) {
    if (ref !== null || capture !== null) blockers.push('course_reference_mismatch');
    return result(blockers.length === 0 ? impactDependencyDigest(null) : null);
  }
  if (
    !same(ref.courseId, capture.ref.courseId) ||
    ref.courseRevision !== capture.ref.courseRevision ||
    !same(ref.revisionId, capture.ref.revisionId)
  )
    blockers.push('course_reference_mismatch');
  const owned = capture.owned;
  if (!owned) {
    blockers.push('course_owned_projection_port_missing');
    return result();
  }
  if (owned.athleteId !== scope.data.athleteId) blockers.push('foreign_source');
  if (owned.deletion.state === 'present') {
    blockers.push(
      same(owned.deletion.courseId, ref.courseId) ? 'course_deleted' : 'course_reference_mismatch',
    );
  }
  const revision = owned.revision;
  if (owned.head.status !== 'available') blockers.push('course_unavailable');
  if (revision === null) {
    blockers.push('course_version_missing');
    return result();
  }
  if (
    !same(revision.courseId, ref.courseId) ||
    revision.courseRevision !== ref.courseRevision ||
    !same(revision.revisionId, ref.revisionId)
  )
    blockers.push('course_version_mismatch');
  const head = owned.head;
  if (!same(head.courseId, ref.courseId)) blockers.push('course_head_mismatch');
  if (
    head.status === 'available' &&
    (head.headRevision < ref.courseRevision ||
      (head.headRevision === ref.courseRevision &&
        (!same(head.revisionId, ref.revisionId) || head.name !== revision.name)) ||
      (head.headRevision > ref.courseRevision && same(head.revisionId, ref.revisionId)))
  )
    blockers.push('course_head_mismatch');
  if (
    revision.contentDigest !== capture.digest ||
    courseContentDigest({ ...revision, coordinates: revision.geometry.coordinates }) !==
      capture.digest
  )
    blockers.push('course_digest_mismatch');
  if (
    bytes(revision.geometry) > courseLimits.geometryBytes ||
    revision.generation.vertexCount !== revision.geometry.coordinates.length
  )
    blockers.push('course_geometry_mismatch');
  const sources = capture.lineageSources;
  if (!sources && revision.lineage.length > 0) blockers.push('lineage_source_port_missing');
  if (sources) {
    const byTuple = new Map(
      sources.map((source) => [
        sourceKey(source.track.activityId, source.track.trackId, source.track.trackRevision),
        source,
      ]),
    );
    const lineageKeys = revision.lineage.map((lineage) =>
      sourceKey(lineage.activityId, lineage.trackId, lineage.trackRevision),
    );
    if (
      byTuple.size !== sources.length ||
      new Set(lineageKeys).size !== lineageKeys.length ||
      sources.length !== lineageKeys.length
    )
      blockers.push('lineage_source_mismatch');
    for (const lineage of revision.lineage) {
      const source = byTuple.get(
        sourceKey(lineage.activityId, lineage.trackId, lineage.trackRevision),
      );
      if (!source || !same(source.activity.id, lineage.activityId)) {
        blockers.push('lineage_source_mismatch');
        continue;
      }
      if (source.athleteId !== scope.data.athleteId) blockers.push('foreign_source');
      if (source.activity.deleted || source.suppression.state !== 'absent')
        blockers.push('lineage_source_unavailable');
      const generation = revision.generation;
      if (generation.kind === 'recorded-segment') {
        const paths = source.track.derivatives.filter((entry) => entry.kind === 'map_path');
        if (
          same(generation.activityId, lineage.activityId) &&
          same(generation.trackId, lineage.trackId) &&
          generation.trackRevision === lineage.trackRevision &&
          (paths.length !== 1 || paths[0]?.sha256 !== generation.mapPathContentSha256)
        )
          blockers.push('lineage_source_mismatch');
      }
      if (new Set(source.track.derivatives.map((entry) => entry.kind)).size !== 2)
        blockers.push('lineage_source_mismatch');
    }
  }
  return result(blockers.length === 0 ? impactDependencyDigest(capture) : null);
}
