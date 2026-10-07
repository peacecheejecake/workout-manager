import { z } from 'zod';
import { courseHeadSchema, courseRevisionSchema, courseLimits } from '@workout/contracts/courses';
import { raceCourseRefSchema } from '@workout/contracts/races';
import { activityTrackRevisionSchema } from '@workout/contracts/activity-tracks';
import type { Transaction } from './database.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { RaceImpactDependencyError } from './race-plan-impact-dependencies.js';
import {
  courseReadManifestSchema,
  type CourseReadManifest,
} from './race-plan-impact-course-manifest.js';

const decimal = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/);
const uuid = z.uuid().transform((v) => v.toLowerCase());
const revision = z.number().int().min(1).max(2147483646);
const lineageSchema = z.strictObject({ activityId: uuid, trackId: uuid, trackRevision: revision });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
function unavailable(): never {
  throw new RaceImpactDependencyError('SOURCE_UNAVAILABLE');
}
const stamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
// Same public metadata as activity-tracks.toRevision: no object locator or geometry.
const trackBody = `jsonb_build_object(
 'activityId',r.activity_id,'trackId',r.track_id,'trackRevision',r.track_revision,
 'sourceKind',r.source_kind,'sourceId',r.source_id,'sourceRevision',r.source_revision,
 'recordedSourceKind',r.recorded_source_kind,
 'correspondence',jsonb_build_object('algorithm','track-correspondence-v1','parserId',r.parser_id,'parserVersion',r.parser_version,'digest',r.correspondence_digest),
 'file',jsonb_build_object('originalFileName',r.original_filename,'format',r.format,'byteSize',r.raw_size_bytes,'sha256',r.raw_content_hash),
 'derivatives',jsonb_build_array(jsonb_build_object('kind','normalized','byteSize',r.normalized_size_bytes,'sha256',r.normalized_content_hash),jsonb_build_object('kind','map_path','byteSize',r.map_path_size_bytes,'sha256',r.map_path_content_hash)),
 'sampleCount',r.sample_count,'positionedSampleCount',r.positioned_sample_count,'segmentCount',r.segment_count,
 'segmentPolicy',r.segment_policy,'distances',r.distances,'createdAt',${stamp('r.created_at')})`;
const trackJoin = `FROM course_revision_source l
 JOIN activity_canonical a ON a.athlete_id=l.athlete_id AND a.id=l.activity_id
 JOIN activity_track_revision r ON r.athlete_id=l.athlete_id AND r.activity_id=l.activity_id AND r.track_id=l.track_id AND r.track_revision=l.track_revision
 WHERE l.athlete_id=$1 AND l.course_id=$2::uuid AND l.course_revision=$3`;
/** Fenced owned snapshot read only. Caller must provide its coherent tenant
 * transaction. Content correspondence does not establish processing permission,
 * routing acceptance, source authenticity, external cleanup or approval freshness.
 * Missing immutable bodies remain unavailable; no requested revision is invented. */
export async function captureCourseReadSources(
  tx: Transaction,
  unknownRef: unknown,
  budget: SourceBudget,
): Promise<CourseReadManifest | null> {
  parse(
    z.strictObject({
      bytes: z.bigint().min(0n).max(4194304n),
      sources: z.number().int().min(0).max(5000),
    }),
    budget,
  );
  const ref = parse(raceCourseRefSchema.nullable(), unknownRef);
  if (ref === null) return null;
  const values = [tx.athleteId, ref.courseId, ref.courseRevision, ref.revisionId];
  // Capability check is outside failing SQL, so an unavailable port cannot leave
  // the surrounding transaction aborted. Ledger table is never queried directly.
  const capability = parse(
    z.strictObject({ available: z.boolean() }),
    (
      await tx.query(
        `SELECT coalesce(has_function_privilege(current_user,to_regprocedure('public.export_course_deletions()'),'EXECUTE'),false) AS available`,
      )
    ).rows[0],
  );
  if (!capability.available) unavailable();
  const deleted = parse(
    z.strictObject({ deleted: z.boolean() }),
    (
      await tx.query(
        `SELECT EXISTS(SELECT 1 FROM public.export_course_deletions() d WHERE d.athlete_id=$1 AND d.course_id=$2::uuid) AS deleted`,
        values.slice(0, 2),
      )
    ).rows[0],
  );
  if (deleted.deleted) unavailable();
  // Scalar-only preflight precedes any coordinate or track metadata transport.
  const raw = (
    await tx.query(
      `SELECT
  octet_length(r.geometry::text)::text AS geometry_bytes,
  octet_length(r.waypoints::text)::text AS waypoint_bytes,
  octet_length(r.generation::text)::text AS generation_bytes,
  octet_length(r.edit::text)::text AS edit_bytes,
  (octet_length(r.geometry::text)+octet_length(r.waypoints::text)+octet_length(r.generation::text)+octet_length(r.edit::text)+4096)::text AS bytes,
  (SELECT count(*)::text FROM course_revision_source l WHERE l.athlete_id=r.athlete_id AND l.course_id=r.course_id AND l.course_revision=r.course_revision) AS lineage_count
  FROM course c JOIN course_revision r ON r.athlete_id=c.athlete_id AND r.course_id=c.course_id
  WHERE c.athlete_id=$1 AND c.course_id=$2::uuid AND r.course_revision=$3 AND r.revision_id=$4::uuid AND c.status='available'`,
      values,
    )
  ).rows[0];
  if (!raw) unavailable();
  const pre = parse(
    z.strictObject({
      geometry_bytes: decimal,
      waypoint_bytes: decimal,
      generation_bytes: decimal,
      edit_bytes: decimal,
      bytes: decimal,
      lineage_count: decimal,
    }),
    raw,
  );
  if (
    BigInt(pre.geometry_bytes) > BigInt(courseLimits.geometryBytes) ||
    BigInt(pre.waypoint_bytes) > 65536n ||
    BigInt(pre.generation_bytes) > 4096n ||
    BigInt(pre.edit_bytes) > 512n
  )
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  const sourceCount = BigInt(pre.lineage_count);
  if (sourceCount > BigInt(courseLimits.waypoints))
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
  const tracks = parse(
    z.strictObject({ count: decimal, bytes: decimal }),
    (
      await tx.query(
        `SELECT count(*)::text AS count,coalesce(sum(octet_length((${trackBody})::text)+2048),0)::text AS bytes ${trackJoin}`,
        values.slice(0, 3),
      )
    ).rows[0],
  );
  if (BigInt(tracks.count) !== sourceCount) unavailable();
  reserveSourceBudget(budget, BigInt(pre.bytes) + BigInt(tracks.bytes), 1 + Number(sourceCount));
  const courseRow = (
    await tx.query(
      `SELECT
  CASE WHEN c.status='available' THEN jsonb_build_object('status',c.status,'courseId',c.course_id,'name',c.name,'visibility',c.visibility,'headRevision',c.head_revision,'revisionId',c.revision_id,'createdAt',${stamp('c.created_at')},'updatedAt',${stamp('c.updated_at')})
  ELSE jsonb_build_object('status',c.status,'courseId',c.course_id,'name',c.name,'visibility',c.visibility,'reason',c.unavailable_reason,'reclaimedAt',${stamp('c.reclaimed_at')},'createdAt',${stamp('c.created_at')},'updatedAt',${stamp('c.updated_at')}) END AS head,
  jsonb_build_object('courseId',r.course_id,'courseRevision',r.course_revision,'revisionId',r.revision_id,'name',r.name,'geometry',r.geometry,'waypoints',r.waypoints,'generation',r.generation,'edit',r.edit,'distanceMeters',r.distance_meters,'contentDigest',r.content_digest,'createdAt',${stamp('r.created_at')}) AS body
  FROM course c JOIN course_revision r ON r.athlete_id=c.athlete_id AND r.course_id=c.course_id
  WHERE c.athlete_id=$1 AND c.course_id=$2::uuid AND r.course_revision=$3 AND r.revision_id=$4::uuid AND c.status='available'`,
      values,
    )
  ).rows[0];
  if (!courseRow) unavailable();
  const course = parse(
    z.strictObject({ head: courseHeadSchema, body: z.record(z.string(), z.unknown()) }),
    courseRow,
  );
  const lineageRows = (
    await tx.query(
      `SELECT activity_id AS "activityId",track_id AS "trackId",track_revision AS "trackRevision" FROM course_revision_source WHERE athlete_id=$1 AND course_id=$2::uuid AND course_revision=$3 ORDER BY activity_id,track_id,track_revision LIMIT 13`,
      values.slice(0, 3),
    )
  ).rows;
  const lineage = parse(z.array(lineageSchema).max(courseLimits.waypoints), lineageRows);
  if (BigInt(lineage.length) !== sourceCount) unavailable();
  const body = parse(courseRevisionSchema, { ...course.body, lineage });
  if (
    body.courseId.toLowerCase() !== ref.courseId.toLowerCase() ||
    body.courseRevision !== ref.courseRevision ||
    body.revisionId.toLowerCase() !== ref.revisionId.toLowerCase() ||
    course.head.courseId.toLowerCase() !== ref.courseId.toLowerCase()
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const sourceRows = (
    await tx.query(
      `SELECT a.id AS activity_id,a.revision AS activity_revision,a.deleted,${trackBody} AS track,
  EXISTS(SELECT 1 FROM activity_source_head h JOIN activity_suppression s ON s.athlete_id=h.athlete_id AND s.kind=h.kind AND s.source_id=h.source_id WHERE h.athlete_id=a.athlete_id AND h.activity_id=a.id) AS suppressed
  ${trackJoin} ORDER BY l.activity_id,l.track_id,l.track_revision LIMIT 13`,
      values.slice(0, 3),
    )
  ).rows;
  const sources = parse(
    z
      .array(
        z.strictObject({
          activity_id: uuid,
          activity_revision: z.number().int().min(1).max(2147483647),
          deleted: z.boolean(),
          track: activityTrackRevisionSchema,
          suppressed: z.boolean(),
        }),
      )
      .max(courseLimits.waypoints),
    sourceRows,
  );
  if (sources.length !== lineage.length) unavailable();
  const expected = new Set(
    lineage.map((l) => JSON.stringify([l.activityId, l.trackId, l.trackRevision])),
  );
  for (const source of sources) {
    if (
      source.activity_id !== source.track.activityId ||
      !expected.delete(
        JSON.stringify([source.track.activityId, source.track.trackId, source.track.trackRevision]),
      )
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
  }
  return parse(courseReadManifestSchema, {
    ref,
    digest: body.contentDigest,
    owned: {
      athleteId: tx.athleteId,
      head: course.head,
      revision: body,
      deletion: { state: 'absent' },
    },
    lineageSources: sources.map((s) => ({
      athleteId: tx.athleteId,
      activity: { id: s.activity_id, revision: s.activity_revision, deleted: s.deleted },
      track: s.track,
      suppression: { state: s.suppressed ? 'present' : 'absent' },
    })),
  });
}
