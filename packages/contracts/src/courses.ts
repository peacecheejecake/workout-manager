import { instantSchema, revisionSchema } from './primitives.js';
import { trackSampleIdSchema, trackTextSchema } from './tracks.js';
import { z } from 'zod';

/**
 * Course ledger contract (M2-01f).
 *
 * A Course is planned data with its own identity. It is never an Activity, never an
 * approved PlanVersion and never a recorded actual: editing a course cannot reach either
 * of those, and the coordinates a course was derived from stay in the recording that owns
 * them. A `CourseRevision` is immutable — geometry, waypoints, the conditions it was
 * generated under and the source revision it came from are all fixed when it is written,
 * and an edit appends the next revision instead of rewriting one.
 *
 * Courses are private. There is no visibility value other than `private` and no sharing
 * field anywhere in this file: public sharing waits for its own requirements, ACL and
 * re-identification review.
 */
export const courseLimits = {
  /** Vertices in one course geometry. */
  vertices: 20_000,
  /** Waypoints on one course, start and finish included. */
  waypoints: 12,
  /** Revisions one course may accumulate. */
  revisionsPerCourse: 50,
  /** Courses one tenant may keep. */
  coursesPerTenant: 200,
  /** Serialized bytes of one revision's geometry. */
  geometryBytes: 1024 * 1024,
  /** Course name characters. */
  nameLength: 120,
} as const;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest');

/**
 * WGS84 `[longitude, latitude]`, exactly two finite dimensions. Deliberately its own
 * schema rather than a recorded-track position: a course vertex is planned geometry, not
 * an observation, and it carries no time, heart rate or elevation.
 */
export const coursePositionSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
export type CoursePosition = z.infer<typeof coursePositionSchema>;

/**
 * A course name is untrusted text held to the same rule as track metadata: control,
 * bidirectional-override and angle-bracket characters are refused rather than escaped
 * somewhere downstream.
 */
export const courseNameSchema = z.string().max(courseLimits.nameLength).pipe(trackTextSchema);

/**
 * A waypoint is planned input. `via` waypoints are added by the waypoint editor (M2-01h);
 * a course derived from a recorded segment starts with exactly its two ends.
 */
export const courseWaypointSchema = z.strictObject({
  role: z.enum(['start', 'via', 'finish']),
  position: coursePositionSchema,
  name: courseNameSchema.nullable(),
  /**
   * The recorded sample this waypoint was taken from, when it came from a recording.
   * It names an observation in the source track revision; it is not an index into the
   * course geometry.
   */
  sourceSampleId: trackSampleIdSchema.nullable(),
});
export type CourseWaypoint = z.infer<typeof courseWaypointSchema>;

/**
 * How one course revision's geometry was generated, and under what conditions.
 *
 * `recorded-segment` means the server re-read the stored map-path derivative of a track
 * revision and cut the explicitly selected inclusive sample range out of a single drawn
 * line. The content hash of that derivative is part of the conditions, so a revision
 * always names the exact bytes it was cut from. Routing-generated geometry is not part of
 * this union yet: the routing adapter of M2-01g produces its own record and storing it is
 * the waypoint editor's work (M2-01h).
 *
 * These are geometry conditions, not an edit history: a revision that only renames the
 * course keeps the conditions its geometry was generated under. What kind of edit produced
 * a revision is {@link courseEditSchema}.
 */
export const courseGenerationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('recorded-segment'),
    activityId: uuid,
    trackId: uuid,
    trackRevision: revisionSchema.min(1),
    /** Index of the drawn line the range was cut from. A range never spans two lines. */
    lineIndex: z.number().int().min(0).max(1_999),
    /** Source segment index that line renders. Display index and source index stay apart. */
    segmentIndex: z.number().int().min(0).max(999_999),
    startSampleId: trackSampleIdSchema,
    endSampleId: trackSampleIdSchema,
    vertexCount: z.number().int().min(2).max(courseLimits.vertices),
    mapPathContentSha256: sha256Schema,
    simplificationVersion: z.literal(1),
    toleranceMeters: z.number().finite().min(0).max(1_000),
  }),
]);
export type CourseGeneration = z.infer<typeof courseGenerationSchema>;

/**
 * What produced this revision. A copy names what it was copied from, which is how an
 * independently edited copy stays traceable; it does not change where the geometry came
 * from, and it never detaches the copy from the recording's lineage.
 */
export const courseEditSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('created') }),
  z.strictObject({ kind: z.literal('renamed') }),
  z.strictObject({ kind: z.literal('retrimmed') }),
  z.strictObject({
    kind: z.literal('copied'),
    copiedFromCourseId: uuid,
    copiedFromRevision: revisionSchema.min(1),
  }),
]);
export type CourseEdit = z.infer<typeof courseEditSchema>;

/**
 * The recording a revision's coordinates came from. Lineage is a set because a revision
 * inherits every source of the revision it was derived from: an independently edited copy
 * keeps naming the recording it came from, so deleting that activity still reaches it.
 */
export const courseLineageSchema = z.strictObject({
  activityId: uuid,
  trackId: uuid,
  trackRevision: revisionSchema.min(1),
});
export type CourseLineage = z.infer<typeof courseLineageSchema>;

/**
 * One immutable revision. `distanceMeters` is the length of this planned line and nothing
 * else: it is not the device-reported distance, not the distance recomputed from the
 * recording's positions, and not a routing estimate.
 */
export const courseRevisionSchema = z.strictObject({
  courseId: uuid,
  courseRevision: revisionSchema.min(1),
  revisionId: uuid,
  name: courseNameSchema,
  geometry: z.strictObject({
    type: z.literal('LineString'),
    coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
  }),
  waypoints: z.array(courseWaypointSchema).min(2).max(courseLimits.waypoints),
  generation: courseGenerationSchema,
  edit: courseEditSchema,
  lineage: z.array(courseLineageSchema).min(1).max(courseLimits.waypoints),
  distanceMeters: z.number().finite().nonnegative().max(1_000_000_000),
  /** Digest over the revision's content. Equal content under CAS is not a new version. */
  contentDigest: sha256Schema,
  createdAt: instantSchema,
});
export type CourseRevision = z.infer<typeof courseRevisionSchema>;

/**
 * The head of a course. `unavailable` is what is left when the recording a course was
 * derived from is deleted: the reference stays visible to its owner and its revisions are
 * gone, rather than the course silently disappearing or dangling.
 */
export const availableCourseHeadSchema = z.strictObject({
  status: z.literal('available'),
  courseId: uuid,
  name: courseNameSchema,
  visibility: z.literal('private'),
  headRevision: revisionSchema.min(1),
  revisionId: uuid,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const unavailableCourseHeadSchema = z.strictObject({
  status: z.literal('unavailable'),
  courseId: uuid,
  name: courseNameSchema,
  visibility: z.literal('private'),
  reason: z.literal('source_activity_deleted'),
  reclaimedAt: instantSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const courseHeadSchema = z.discriminatedUnion('status', [
  availableCourseHeadSchema,
  unavailableCourseHeadSchema,
]);
export type CourseHead = z.infer<typeof courseHeadSchema>;

export const courseReadResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    course: availableCourseHeadSchema,
    revision: courseRevisionSchema,
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    course: unavailableCourseHeadSchema,
  }),
]);
export type CourseReadResult = z.infer<typeof courseReadResultSchema>;

export const courseListSchema = z.strictObject({
  courses: z.array(courseHeadSchema).max(courseLimits.coursesPerTenant),
  total: z.number().int().min(0).max(courseLimits.coursesPerTenant),
});
export type CourseList = z.infer<typeof courseListSchema>;

/**
 * Creating a course names a selection, never geometry. The server reads its own stored
 * derivative for the coordinates: a client cannot hand in a line and have it recorded.
 */
export const courseCreateRequestSchema = z.strictObject({
  name: courseNameSchema,
  from: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('recorded-segment'),
      activityId: uuid,
      /** The revision the selection was made against. A newer stored track is refused. */
      trackRevision: revisionSchema.min(1),
      startSampleId: trackSampleIdSchema,
      endSampleId: trackSampleIdSchema,
    }),
    z.strictObject({
      kind: z.literal('course-copy'),
      courseId: uuid,
      expectedRevision: revisionSchema.min(1),
    }),
  ]),
});
export type CourseCreateRequest = z.infer<typeof courseCreateRequestSchema>;

/**
 * Every write carries the revision it expected to find. A stale expectation is refused;
 * it never merges, and it never silently wins.
 */
export const courseUpdateRequestSchema = z.strictObject({
  expectedRevision: revisionSchema.min(1),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('rename'), name: courseNameSchema }),
    /** Re-cut from the same stored derivative. The recording itself is never touched. */
    z.strictObject({
      kind: z.literal('retrim'),
      startSampleId: trackSampleIdSchema,
      endSampleId: trackSampleIdSchema,
    }),
  ]),
});
export type CourseUpdateRequest = z.infer<typeof courseUpdateRequestSchema>;

export const courseDeleteRequestSchema = z.strictObject({
  expectedRevision: revisionSchema.min(1),
});

/**
 * What deleting an activity would take with it. The delete confirmation shows this, so a
 * reclamation is never a surprise. Courses are listed by identity and name only.
 */
export const activityDeletionImpactSchema = z.strictObject({
  activityId: uuid,
  /** Digest of exactly this list. The delete command carries it back for re-validation. */
  digest: sha256Schema,
  courses: z
    .array(
      z.strictObject({
        courseId: uuid,
        name: courseNameSchema,
        headRevision: revisionSchema.min(1),
      }),
    )
    .max(courseLimits.coursesPerTenant),
  total: z.number().int().min(0).max(courseLimits.coursesPerTenant),
});
export type ActivityDeletionImpact = z.infer<typeof activityDeletionImpactSchema>;

/** Exported GPX is a personal artifact, not a shareable publication. */
export const courseGpxMediaType = 'application/gpx+xml';
export const courseGpxCreator = 'workout-manager/course-v1';
