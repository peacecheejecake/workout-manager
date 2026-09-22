import {
  activityDeletionImpactSchema,
  courseCreateRequestSchema,
  courseDeleteRequestSchema,
  courseGpxMediaType,
  courseLimits,
  courseListSchema,
  courseReadResultSchema,
  courseUpdateRequestSchema,
  type CourseEdit,
  type CourseGeneration,
  type CourseLineage,
  type CoursePosition,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import { mapPathSchema, trackLimits } from '@workout/contracts/tracks';
import { courseContentDigest } from '@workout/server-courses/digest';
import { courseGpxFileName, writeCourseGpx } from '@workout/server-courses/gpx';
import {
  CourseSegmentError,
  deriveCourseFromRecordedSegment,
  plannedLineLengthMeters,
} from '@workout/server-courses/segment';
import { parseObjectKey, validateObjectKey } from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import type { ActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import {
  CourseNotFoundError,
  CourseStateError,
  type CourseHeadContent,
  type CourseRepository,
  type PreparedCourseContent,
} from '@workout/server-persistence/courses';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const COURSE_BODY_LIMIT = 4 * 1024;

const courseParamsSchema = z.strictObject({
  courseId: z.uuid().transform((value) => value.toLowerCase()),
});
const activityParamsSchema = z.strictObject({
  activityId: z.uuid().transform((value) => value.toLowerCase()),
});
const deleteQuerySchema = z.strictObject({
  expectedRevision: z.coerce.number().int().min(1).max(2147483646),
});
const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export interface CourseServices {
  courses: CourseRepository;
  tracks: ActivityTrackRepository;
  storage: ObjectStorage;
}

function courseError(error: unknown): ProductRequestError | undefined {
  if (error instanceof CourseNotFoundError) return new ProductRequestError(404, 'COURSE_NOT_FOUND');
  if (error instanceof CourseStateError)
    return new ProductRequestError(error.code === 'COURSE_UNAVAILABLE' ? 410 : 409, error.code);
  if (error instanceof CourseSegmentError) return new ProductRequestError(422, error.code);
  return undefined;
}

function execute<T>(operation: () => Promise<T>) {
  return command(operation, courseError);
}

function contentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Read the stored display geometry of a recording back from the object store.
 *
 * Deriving a course reads the server's own derivative, never a geometry a client sent: the
 * request names a selection, and this is where the coordinates behind that selection come
 * from. The reference is re-checked against the tenant, the activity and the artifact kind
 * before a byte is opened, exactly as the download route does.
 */
async function readStoredMapPath(
  services: CourseServices,
  athleteId: string,
  activityId: string,
  trackRevision: number,
) {
  const track = await execute(() => services.tracks.read(athleteId, activityId));
  if (track.status !== 'available') throw new ProductRequestError(404, 'ACTIVITY_TRACK_NOT_FOUND');
  // A selection was made against one revision of the recording. If the stored recording has
  // moved on, the selection is refused rather than silently applied to different samples.
  if (track.track.trackRevision !== trackRevision)
    throw new ProductRequestError(409, 'TRACK_REVISION_CHANGED');
  const resolved = await execute(() =>
    services.tracks.resolveObject(athleteId, activityId, 'map_path'),
  );
  if (resolved === null) throw new ProductRequestError(404, 'ACTIVITY_TRACK_NOT_FOUND');
  const objectKey = validateObjectKey(resolved.storageRef);
  const parsedKey = parseObjectKey(objectKey);
  if (
    parsedKey.kind !== 'track_final' ||
    parsedKey.tenantId !== athleteId ||
    parsedKey.activityId !== activityId ||
    parsedKey.trackId !== resolved.trackId ||
    parsedKey.artifactKind !== 'map_path' ||
    parsedKey.sha256 !== resolved.sha256
  )
    throw new Error('INVALID_ACTIVITY_TRACK_STORAGE_REF');
  if (resolved.byteSize > trackLimits.normalizedBytes)
    throw new ProductRequestError(503, 'ACTIVITY_TRACK_CONTENT_UNAVAILABLE');
  const object = await services.storage.open(objectKey);
  if (object === null || object.sizeBytes !== resolved.byteSize)
    throw new ProductRequestError(503, 'ACTIVITY_TRACK_CONTENT_UNAVAILABLE');
  const bytes = new Uint8Array(resolved.byteSize);
  let offset = 0;
  for await (const chunk of object.body) {
    if (offset + chunk.byteLength > resolved.byteSize)
      throw new ProductRequestError(503, 'ACTIVITY_TRACK_CONTENT_UNAVAILABLE');
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== resolved.byteSize)
    throw new ProductRequestError(503, 'ACTIVITY_TRACK_CONTENT_UNAVAILABLE');
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ProductRequestError(503, 'ACTIVITY_TRACK_CONTENT_UNAVAILABLE');
  }
  const path = mapPathSchema.parse(document);
  // The cached object must describe this recording. A key that matches proves nothing
  // about the bytes behind it, so the provenance inside the document is checked too.
  if (
    path.sourceRevision.kind !== 'activity-source' ||
    path.sourceRevision.activityId !== activityId ||
    path.sourceRevision.trackRevision !== trackRevision
  )
    throw new ProductRequestError(503, 'STORED_TRACK_ARTIFACT_MISMATCH');
  return { path, trackId: resolved.trackId, contentSha256: resolved.sha256 };
}

function prepared(content: {
  name: string;
  coordinates: readonly CoursePosition[];
  waypoints: readonly CourseWaypoint[];
  generation: CourseGeneration;
  edit: CourseEdit;
  lineage: readonly CourseLineage[];
  distanceMeters: number;
}): PreparedCourseContent {
  return {
    ...content,
    contentDigest: courseContentDigest({
      name: content.name,
      coordinates: content.coordinates,
      waypoints: content.waypoints,
      generation: content.generation,
      lineage: content.lineage,
    }),
  };
}

/** Cut a new course out of one recording. The recording itself is only read. */
async function courseFromRecordedSegment(
  services: CourseServices,
  athleteId: string,
  name: string,
  from: {
    readonly activityId: string;
    readonly trackRevision: number;
    readonly startSampleId: string;
    readonly endSampleId: string;
  },
): Promise<PreparedCourseContent> {
  const source = await readStoredMapPath(services, athleteId, from.activityId, from.trackRevision);
  const derived = await execute(async () =>
    deriveCourseFromRecordedSegment({
      path: source.path,
      selection: { startSampleId: from.startSampleId, endSampleId: from.endSampleId },
      source: {
        activityId: from.activityId,
        trackId: source.trackId,
        trackRevision: from.trackRevision,
        mapPathContentSha256: source.contentSha256,
      },
    }),
  );
  return prepared({
    name,
    coordinates: derived.coordinates,
    waypoints: derived.waypoints,
    generation: derived.generation,
    edit: { kind: 'created' },
    lineage: [
      {
        activityId: from.activityId,
        trackId: source.trackId,
        trackRevision: from.trackRevision,
      },
    ],
    distanceMeters: derived.distanceMeters,
  });
}

/**
 * Copy an existing course. The copy inherits the lineage it was made from: copying is not
 * a way to detach coordinates from the recording they came from, so deleting that
 * recording reclaims the copy by the same rule that reclaims the original.
 */
async function courseFromCopy(
  services: CourseServices,
  athleteId: string,
  name: string,
  from: { readonly courseId: string; readonly expectedRevision: number },
): Promise<PreparedCourseContent> {
  const head = await execute(() => services.courses.headContent(athleteId, from.courseId));
  if (head === null) throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
  if (head.courseRevision !== from.expectedRevision)
    throw new ProductRequestError(409, 'COURSE_REVISION_CONFLICT');
  return prepared({
    name,
    coordinates: head.coordinates,
    waypoints: head.waypoints,
    generation: head.generation,
    edit: {
      kind: 'copied',
      copiedFromCourseId: head.courseId,
      copiedFromRevision: head.courseRevision,
    },
    lineage: head.lineage,
    distanceMeters: plannedLineLengthMeters(head.coordinates),
  });
}

/**
 * Re-cut an existing course from the same recording it came from.
 *
 * The recording is read again — never written — and the revision named in the course's own
 * generation conditions must still be the stored head, so a re-trim cannot silently move a
 * course onto different samples of a re-parsed recording.
 */
async function courseFromRetrim(
  services: CourseServices,
  athleteId: string,
  head: CourseHeadContent,
  change: { readonly startSampleId: string; readonly endSampleId: string },
): Promise<PreparedCourseContent> {
  if (head.generation.kind !== 'recorded-segment')
    throw new ProductRequestError(409, 'COURSE_NOT_FROM_A_RECORDING');
  const generation = head.generation;
  const source = await readStoredMapPath(
    services,
    athleteId,
    generation.activityId,
    generation.trackRevision,
  );
  const derived = await execute(async () =>
    deriveCourseFromRecordedSegment({
      path: source.path,
      selection: { startSampleId: change.startSampleId, endSampleId: change.endSampleId },
      source: {
        activityId: generation.activityId,
        trackId: source.trackId,
        trackRevision: generation.trackRevision,
        mapPathContentSha256: source.contentSha256,
      },
    }),
  );
  return prepared({
    name: head.name,
    coordinates: derived.coordinates,
    waypoints: derived.waypoints,
    generation: derived.generation,
    edit: { kind: 'retrimmed' },
    lineage: head.lineage,
    distanceMeters: derived.distanceMeters,
  });
}

/**
 * Private course ledger.
 *
 * Every route derives its owner from the session. Nothing here can reach an Activity, a
 * source revision, an overlay or a PlanVersion: the only writes are to the course ledger,
 * and a recording is read, never modified. There is no sharing route, no ACL parameter and
 * no public URL — a course leaves this server only through its owner's authenticated GPX
 * export.
 */
export function registerCourseRoutes(
  routes: FastifyInstance,
  services: CourseServices,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.register(async (courseRoutes) => {
    courseRoutes.post('/courses', { bodyLimit: COURSE_BODY_LIMIT }, async (request) => {
      input(emptyQuery, request.query);
      const athleteId = principal(request).athleteId;
      const body = input(courseCreateRequestSchema, request.body);
      const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
      // The receipt is read before anything is derived: a resend of a command that already
      // succeeded is not derived or written again. The reply is the course **as it is
      // now** — a later edit is visible in it — not a snapshot of the moment the command
      // ran. What the replay guarantees is exactly-once application, not a frozen answer.
      const command = { kind: 'course_create', body };
      const replayed = await execute(() => services.courses.replayCommand(athleteId, key, command));
      if (replayed)
        return courseReadResultSchema.parse(
          await execute(() => services.courses.read(athleteId, replayed.courseId)),
        );
      const from = body.from;
      const content =
        from.kind === 'recorded-segment'
          ? await courseFromRecordedSegment(services, athleteId, body.name, from)
          : await courseFromCopy(services, athleteId, body.name, from);
      return courseReadResultSchema.parse(
        await execute(() => services.courses.create(athleteId, content, key, command)),
      );
    });

    courseRoutes.get('/courses', async (request) => {
      input(emptyQuery, request.query);
      return courseListSchema.parse(
        await execute(() => services.courses.list(principal(request).athleteId)),
      );
    });

    courseRoutes.get('/courses/:courseId', async (request) => {
      input(emptyQuery, request.query);
      const { courseId } = input(courseParamsSchema, request.params);
      const result = courseReadResultSchema.parse(
        await execute(() => services.courses.read(principal(request).athleteId, courseId)),
      );
      z.literal(courseId).parse(result.course.courseId);
      return result;
    });

    courseRoutes.patch('/courses/:courseId', { bodyLimit: COURSE_BODY_LIMIT }, async (request) => {
      input(emptyQuery, request.query);
      const athleteId = principal(request).athleteId;
      const { courseId } = input(courseParamsSchema, request.params);
      const body = input(courseUpdateRequestSchema, request.body);
      const key = input(idempotencyKeySchema, request.headers['idempotency-key']);
      // Before the head is read. The first attempt advanced the revision, so an identical
      // resend no longer matches the head: without this it would be answered with a
      // revision conflict instead of being recognised as its own resend. The reply is the
      // course as it is now, which may already include a later edit; it is not a snapshot
      // of what this command produced.
      const command = { kind: 'course_update', courseId, body };
      const replayed = await execute(() => services.courses.replayCommand(athleteId, key, command));
      if (replayed)
        return courseReadResultSchema.parse(
          await execute(() => services.courses.read(athleteId, replayed.courseId)),
        );
      const head = await execute(() => services.courses.headContent(athleteId, courseId));
      if (head === null) throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
      if (head.courseRevision !== body.expectedRevision)
        throw new ProductRequestError(409, 'COURSE_REVISION_CONFLICT');
      const content =
        body.change.kind === 'rename'
          ? prepared({
              name: body.change.name,
              coordinates: head.coordinates,
              waypoints: head.waypoints,
              generation: head.generation,
              edit: { kind: 'renamed' },
              lineage: head.lineage,
              distanceMeters: plannedLineLengthMeters(head.coordinates),
            })
          : await courseFromRetrim(services, athleteId, head, body.change);
      return courseReadResultSchema.parse(
        await execute(() =>
          services.courses.update(
            athleteId,
            courseId,
            body.expectedRevision,
            content,
            key,
            command,
          ),
        ),
      );
    });

    courseRoutes.delete('/courses/:courseId', async (request) => {
      if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
      const { courseId } = input(courseParamsSchema, request.params);
      const { expectedRevision } = input(deleteQuerySchema, request.query);
      courseDeleteRequestSchema.parse({ expectedRevision });
      return execute(() =>
        services.courses.remove(principal(request).athleteId, courseId, expectedRevision),
      );
    });

    /**
     * Personal GPX export. A course is a planned line, so it leaves as a route with its
     * waypoints, never as a recorded track, and the response is private and uncached.
     */
    courseRoutes.get('/courses/:courseId/export.gpx', async (request, reply) => {
      input(emptyQuery, request.query);
      const { courseId } = input(courseParamsSchema, request.params);
      const result = courseReadResultSchema.parse(
        await execute(() => services.courses.read(principal(request).athleteId, courseId)),
      );
      if (result.status !== 'available') throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
      const document = writeCourseGpx({
        name: result.revision.name,
        courseId: result.revision.courseId,
        courseRevision: result.revision.courseRevision,
        createdAt: result.revision.createdAt,
        coordinates: result.revision.geometry.coordinates,
        waypoints: result.revision.waypoints,
      });
      const body = Buffer.from(document, 'utf8');
      return reply
        .header('content-type', `${courseGpxMediaType}; charset=utf-8`)
        .header('content-length', body.byteLength)
        .header('cache-control', 'private, no-store')
        .header(
          'content-disposition',
          contentDisposition(
            courseGpxFileName(result.revision.name, result.revision.courseRevision),
          ),
        )
        .send(body);
    });

    /**
     * What deleting this activity would reclaim. The delete confirmation shows it, so the
     * loss of a course derived from the recording is never a surprise.
     */
    courseRoutes.get('/activities/:activityId/deletion-impact', async (request) => {
      input(emptyQuery, request.query);
      const { activityId } = input(activityParamsSchema, request.params);
      const impact = activityDeletionImpactSchema.parse(
        await execute(() =>
          services.courses.affectedByActivityDeletion(principal(request).athleteId, activityId),
        ),
      );
      z.literal(activityId).parse(impact.activityId);
      z.number().int().max(courseLimits.coursesPerTenant).parse(impact.total);
      return impact;
    });
  });
}
