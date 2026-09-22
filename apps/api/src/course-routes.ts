import {
  activityDeletionImpactSchema,
  courseCreateRequestSchema,
  courseDeleteRequestSchema,
  courseGenerationGraphBuildId,
  courseGpxMediaType,
  courseLimits,
  courseListSchema,
  courseReadResultSchema,
  courseRouteCandidateRequestSchema,
  courseRouteCandidateResultSchema,
  courseRouteProposalRequestSchema,
  courseRouteProposalResultSchema,
  targetDistanceLimits,
  courseUpdateRequestSchema,
  type CourseEdit,
  type CourseGeneration,
  type CourseLineage,
  type CoursePosition,
  type CourseRouteProposal,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import {
  CandidateSearchError,
  generateTargetDistanceCandidates,
  targetDistanceGeneration,
  type CandidateLegRouter,
} from '@workout/server-courses/candidates';
import { mapPathSchema, trackLimits } from '@workout/contracts/tracks';
import { courseContentDigest } from '@workout/server-courses/digest';
import { courseGpxFileName, writeCourseGpx } from '@workout/server-courses/gpx';
import { RoutedCourseError, routedCourseGeneration } from '@workout/server-courses/routed';
import {
  CourseSegmentError,
  deriveCourseFromRecordedSegment,
  plannedLineLengthMeters,
} from '@workout/server-courses/segment';
import { parseObjectKey, validateObjectKey } from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import { randomBytes } from 'node:crypto';
import type { ActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import {
  CourseNotFoundError,
  courseGeometrySha256,
  CourseStateError,
  type CourseHeadContent,
  type CourseRepository,
  type PreparedCourseContent,
  type StoredCandidateRead,
} from '@workout/server-persistence/courses';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { CoursePreferenceRepository } from '@workout/server-persistence/course-preferences';
import {
  CourseTrimError,
  privacyZoneSetDigest,
  trimCourseForPrivacy,
} from '@workout/server-courses/privacy-trim';

import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';
import { cancellationSignal } from './request-cancellation.js';
import type { WalkingRoutePort } from './routing-routes.js';
import { RoutingRequestError } from '@workout/server-integrations/routing';

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
  /**
   * Our own pedestrian engine (M2-01g). Absent until an engine endpoint is configured, and
   * then the proposal route is not registered at all rather than pretending to compute.
   */
  walkingRoutes?: WalkingRoutePort;
  /**
   * The owner's protected areas (M2-01j). Absent: a privacy trim is refused as
   * unconfigured rather than computed against an empty set, which would trim nothing and
   * look like "this course never enters a protected area".
   */
  privacyZones?: CoursePreferenceRepository;
}

/**
 * A refused proposal is 409 and an unknown one is 404: "we refused and stored nothing" and
 * "there is nothing there" are different answers, and the screen tells them apart.
 */
function proposalStatus(code: CourseStateError['code']): number {
  if (code === 'COURSE_UNAVAILABLE') return 410;
  if (code === 'ROUTE_PROPOSAL_NOT_FOUND') return 404;
  if (code === 'ROUTE_CANDIDATE_SET_MISMATCH') return 409;
  if (code === 'ROUTE_CANDIDATE_ALREADY_CHOSEN') return 409;
  if (code === 'ROUTE_PROPOSAL_IS_CANDIDATE') return 409;
  if (code === 'ROUTE_PROPOSAL_QUOTA_EXCEEDED') return 429;
  return 409;
}

function courseError(error: unknown): ProductRequestError | undefined {
  if (error instanceof CourseNotFoundError) return new ProductRequestError(404, 'COURSE_NOT_FOUND');
  if (error instanceof CourseStateError)
    return new ProductRequestError(proposalStatus(error.code), error.code);
  if (error instanceof CourseSegmentError) return new ProductRequestError(422, error.code);
  if (error instanceof RoutedCourseError) return new ProductRequestError(422, error.code);
  if (error instanceof CourseTrimError) return new ProductRequestError(422, error.code);
  if (error instanceof CandidateSearchError) return new ProductRequestError(422, error.code);
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
 * Turn one reviewed proposal into the content of the next revision.
 *
 * The geometry and the waypoints both come from the stored proposal, never from the
 * request: that is what makes it impossible to save the line of one draft with the
 * waypoints of another. The lineage is inherited from the head, so a course whose
 * coordinates started in a recording keeps naming that recording after it has been
 * rerouted — rerouting is not a way out of deletion.
 */
function courseFromProposal(
  head: CourseHeadContent,
  reviewed: CourseRouteProposal,
): PreparedCourseContent {
  const coordinates = reviewed.geometry.coordinates;
  const generation = routedCourseGeneration({
    computation: reviewed.computation,
    coordinates,
    waypoints: reviewed.waypoints,
    engineDistanceMeters: reviewed.engineDistanceMeters,
    engineDurationSeconds: reviewed.engineDurationSeconds,
    snappedWaypoints: reviewed.snappedWaypoints,
  });
  return prepared({
    name: head.name,
    coordinates,
    waypoints: reviewed.waypoints,
    generation,
    edit: { kind: 'rerouted' },
    lineage: head.lineage,
    // The course's own planned line length, measured from its vertices. The engine's
    // estimate is kept separately in the generation conditions; they are different values
    // and the screen says so.
    distanceMeters: plannedLineLengthMeters(coordinates),
  });
}

/**
 * Turn the one candidate the owner picked into the content of the next revision.
 *
 * Exactly like a reviewed reroute: the geometry and the waypoints come from the stored
 * candidate, never from the request. What it adds is the search — the target, both seeds,
 * the attempt index, the generator and evaluation versions and the whole evaluation — so
 * the saved course can say how far off the target it landed, and so the same search can be
 * run again. The lineage is inherited from the head: generating a loop is not a way out of
 * the reclamation that follows the recording the course came from.
 */
function courseFromCandidate(
  head: CourseHeadContent,
  picked: StoredCandidateRead,
): PreparedCourseContent {
  const candidate = picked.candidate;
  const coordinates = candidate.geometry.coordinates;
  const generation = targetDistanceGeneration({
    computation: candidate.computation,
    coordinates,
    waypoints: candidate.waypoints,
    engineDistanceMeters: candidate.engineDistanceMeters,
    engineDurationSeconds: candidate.engineDurationSeconds,
    snappedWaypoints: candidate.snappedWaypoints,
    targetDistanceMeters: picked.targetDistanceMeters,
    searchSeed: picked.searchSeed,
    candidateSeed: candidate.candidateSeed,
    attemptIndex: candidate.attemptIndex,
    evaluation: candidate.evaluation,
  });
  return prepared({
    name: head.name,
    coordinates,
    waypoints: candidate.waypoints,
    generation,
    edit: { kind: 'generated' },
    lineage: head.lineage,
    // The course's own planned line length. The engine estimate and the target are two
    // other values, kept apart in the conditions and shown apart on screen.
    distanceMeters: plannedLineLengthMeters(coordinates),
  });
}

/**
 * The one way the candidate search reaches the engine: the ordinary bounded walking-route
 * port, with its admission control, deadline and answer validation untouched. A request the
 * service refuses before the engine sees it is `request_refused` — a refusal with no
 * computation to report, which is a different fact from an engine that answered.
 */
function candidateRouter(port: WalkingRoutePort, athleteId: string): CandidateLegRouter {
  return {
    // The signal comes from the search, not from this closure: it carries both the
    // dropped connection and the search's own remaining budget, so a leg is abandoned
    // when either runs out rather than only when the caller goes away.
    async route(leg, context) {
      let computation;
      try {
        computation = await port.compute(
          athleteId,
          {
            schemaVersion: 1,
            requestId: leg.requestId,
            requestRevision: leg.requestRevision,
            profileId: 'foot-v1',
            waypoints: leg.waypoints.map((position) => [position[0], position[1]]),
          },
          { signal: context.signal },
        );
      } catch (error) {
        if (error instanceof RoutingRequestError)
          return { kind: 'refused', outcome: 'request_refused', computation: null };
        throw error;
      }
      const result = computation.result;
      if (result.outcome !== 'route_computed')
        return { kind: 'refused', outcome: result.outcome, computation: result.computation };
      return {
        kind: 'computed',
        coordinates: result.geometry.coordinates,
        distanceMeters: result.distanceMeters,
        durationSeconds: result.durationSeconds,
        snappedWaypoints: result.snappedWaypoints,
        computation: result.computation,
      };
    },
  };
}

/**
 * Status for one candidate search. `no_candidate` is 200 because it is a **known** answer:
 * the search ran inside its bounds and found nothing worth offering, and it stored nothing.
 * A timeout or an engine failure is not that, and gets a status that says so.
 */
function candidateOutcomeStatus(outcome: string): number {
  return outcome === 'no_candidate' || outcome === 'candidates_generated'
    ? 200
    : proposalOutcomeStatus(outcome);
}

/**
 * Status for one computation attempt that produced no proposal. Mirrors the internal
 * routing endpoint so the two cannot drift: a refusal that stored nothing (`no_route`,
 * `outside_coverage`, `snap_too_far`) is a 200 answer with a named outcome, while an
 * unknown result (`timeout`) and an engine problem are not.
 */
function proposalOutcomeStatus(outcome: string): number {
  switch (outcome) {
    case 'no_route':
    case 'outside_coverage':
    case 'snap_too_far':
      return 200;
    case 'overloaded':
      return 429;
    case 'timeout':
    case 'compute_budget_exceeded':
      return 504;
    case 'cancelled':
      return 499;
    default:
      return 502;
  }
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
      if (body.change.kind === 'reroute') {
        const change = body.change;
        // The graph the owner reviewed, on both sides. `previous` is what the head was
        // computed on; it is read from the head this write is doing CAS against, so a head
        // that moved is already refused above and cannot slip past this check. `next` is
        // what the proposal was computed on. A course computed on an older graph therefore
        // cannot be replaced by an answer from a newer one unless the screen showed the
        // change and sent both values back.
        if (change.acknowledgedGraph.previous !== courseGenerationGraphBuildId(head.generation))
          throw new ProductRequestError(409, 'COURSE_GRAPH_ACKNOWLEDGEMENT_STALE');
        const reviewed = await execute(() =>
          services.courses.readRouteProposal(athleteId, courseId, change.proposalId),
        );
        if (reviewed === null) throw new ProductRequestError(404, 'ROUTE_PROPOSAL_NOT_FOUND');
        if (reviewed.draftRevision !== change.draftRevision)
          throw new ProductRequestError(409, 'ROUTE_PROPOSAL_STALE_DRAFT');
        if (reviewed.computation.graph.graphBuildId !== change.acknowledgedGraph.next)
          throw new ProductRequestError(409, 'COURSE_GRAPH_ACKNOWLEDGEMENT_STALE');
        const content = courseFromProposal(head, reviewed);
        return courseReadResultSchema.parse(
          await execute(() =>
            services.courses.update(
              athleteId,
              courseId,
              body.expectedRevision,
              content,
              key,
              command,
              {
                consumeProposal: {
                  proposalId: reviewed.proposalId,
                  draftRevision: reviewed.draftRevision,
                  // Recomputed from the coordinates about to be written, and compared with
                  // the proposal's own hash inside the writing transaction.
                  geometrySha256: courseGeometrySha256(content.coordinates),
                },
              },
            ),
          ),
        );
      }
      if (body.change.kind === 'pick-candidate') {
        const change = body.change;
        // The same two-sided graph acknowledgement a reroute needs. `previous` is read from
        // the head this write does CAS against, so a head that moved is already refused.
        if (change.acknowledgedGraph.previous !== courseGenerationGraphBuildId(head.generation))
          throw new ProductRequestError(409, 'COURSE_GRAPH_ACKNOWLEDGEMENT_STALE');
        const picked = await execute(() =>
          services.courses.readRouteCandidate(
            athleteId,
            courseId,
            change.candidateSetId,
            change.proposalId,
          ),
        );
        if (picked === null) throw new ProductRequestError(404, 'ROUTE_PROPOSAL_NOT_FOUND');
        if (picked.draftRevision !== change.draftRevision)
          throw new ProductRequestError(409, 'ROUTE_PROPOSAL_STALE_DRAFT');
        if (picked.candidate.computation.graph.graphBuildId !== change.acknowledgedGraph.next)
          throw new ProductRequestError(409, 'COURSE_GRAPH_ACKNOWLEDGEMENT_STALE');
        const content = courseFromCandidate(head, picked);
        return courseReadResultSchema.parse(
          await execute(() =>
            services.courses.update(
              athleteId,
              courseId,
              body.expectedRevision,
              content,
              key,
              command,
              {
                consumeCandidate: {
                  proposalId: picked.candidate.proposalId,
                  candidateSetId: picked.candidateSetId,
                  draftRevision: picked.draftRevision,
                  geometrySha256: courseGeometrySha256(content.coordinates),
                },
              },
            ),
          ),
        );
      }
      if (body.change.kind === 'privacy-trim') {
        const change = body.change;
        const zoneRepository = services.privacyZones;
        if (!zoneRepository) throw new ProductRequestError(409, 'COURSE_TRIM_NOT_CONFIGURED');
        const zones = await execute(() => zoneRepository.listPrivacyZones(athleteId));
        if (zones.length === 0) throw new ProductRequestError(409, 'COURSE_TRIM_NO_PROTECTED_AREA');
        // The area set the screen showed. A trim computed against areas that have since
        // changed is refused rather than quietly applied against a different set — the
        // same shape as the graph acknowledgement above.
        if (privacyZoneSetDigest(zones) !== change.acknowledgedZoneSetDigest)
          throw new ProductRequestError(409, 'COURSE_ZONE_ACKNOWLEDGEMENT_STALE');
        const trimmed = await execute(async () =>
          trimCourseForPrivacy({
            coordinates: head.coordinates,
            waypoints: head.waypoints,
            zones,
            sourceRevision: head.courseRevision,
            sourceGenerationKind: head.generation.kind,
            sourceGraphBuildId: courseGenerationGraphBuildId(head.generation),
          }),
        );
        // A derived revision, appended. The revision it trims stays exactly as it was:
        // this is not an overwrite, and the ledger keeps both.
        const trimmedContent = prepared({
          name: head.name,
          coordinates: trimmed.coordinates,
          waypoints: trimmed.waypoints,
          generation: trimmed.generation,
          edit: { kind: 'privacy-trimmed' },
          lineage: head.lineage,
          distanceMeters: trimmed.distanceMeters,
        });
        return courseReadResultSchema.parse(
          await execute(() =>
            services.courses.update(
              athleteId,
              courseId,
              body.expectedRevision,
              trimmedContent,
              key,
              command,
              {
                // The same check again, inside the transaction that writes the revision.
                // The one above runs before the line is derived and in its own
                // transaction; an area added in between would otherwise end up inside a
                // line reported as a successful trim.
                requireZoneSet: {
                  expectedDigest: change.acknowledgedZoneSetDigest,
                  digestOf: privacyZoneSetDigest,
                },
              },
            ),
          ),
        );
      }
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
     * Ask our own pedestrian engine for a route under the current waypoint draft.
     *
     * This is the only route in this file that can spend engine time, and it is bounded on
     * every side: the course must exist, be the caller's and still be available before the
     * engine is touched; M2-01g's service applies the tenant rate, concurrency, waypoint,
     * distance and deadline limits; and the caller going away cancels the computation
     * through the response stream, which is the server-side bound the plan asks for.
     *
     * A successful computation is stored as a **proposal**. The course is unchanged by it:
     * no revision appears, no head moves, and the owner has to save it explicitly. Every
     * other outcome stores nothing at all, leaving the uncomputed draft exactly as it was,
     * and none of them returns a substitute geometry — a straight line is never an answer.
     */
    if (services.walkingRoutes) {
      const walkingRoutes = services.walkingRoutes;
      courseRoutes.post(
        '/courses/:courseId/route-proposals',
        { bodyLimit: COURSE_BODY_LIMIT },
        async (request: FastifyRequest, reply: FastifyReply) => {
          input(emptyQuery, request.query);
          const athleteId = principal(request).athleteId;
          const { courseId } = input(courseParamsSchema, request.params);
          const body = input(courseRouteProposalRequestSchema, request.body);
          // Before any engine work: an unknown, someone else's or a reclaimed course buys
          // no computation at all.
          const course = await execute(() => services.courses.read(athleteId, courseId));
          if (course.status !== 'available')
            throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
          const cancellation = cancellationSignal(reply);
          let computation;
          try {
            computation = await walkingRoutes.compute(
              athleteId,
              {
                schemaVersion: 1,
                requestId: body.requestId,
                // The draft the request was made from travels into the computation record,
                // so a result can be matched back to the exact draft it belongs to.
                requestRevision: body.draftRevision,
                profileId: 'foot-v1',
                waypoints: body.waypoints.map((waypoint) => waypoint.position),
              },
              { signal: cancellation.signal },
            );
          } catch (error) {
            if (error instanceof RoutingRequestError)
              throw new ProductRequestError(422, error.code);
            throw error;
          } finally {
            cancellation.dispose();
          }
          if (computation.retryAfterSeconds !== null)
            reply.header('retry-after', String(computation.retryAfterSeconds));
          const result = computation.result;
          if (result.outcome !== 'route_computed')
            return reply.code(proposalOutcomeStatus(result.outcome)).send(
              courseRouteProposalResultSchema.parse({
                outcome: result.outcome,
                computation: result.computation,
                draftRevision: body.draftRevision,
              }),
            );
          const stored = await execute(() =>
            services.courses.storeRouteProposal(athleteId, {
              courseId,
              draftRevision: body.draftRevision,
              requestId: body.requestId,
              waypoints: body.waypoints,
              coordinates: result.geometry.coordinates,
              engineDistanceMeters: result.distanceMeters,
              engineDurationSeconds: result.durationSeconds,
              snappedWaypoints: result.snappedWaypoints,
              computation: result.computation,
              ttlSeconds: courseLimits.routeProposalTtlSeconds,
            }),
          );
          return reply.code(200).send(
            courseRouteProposalResultSchema.parse({
              outcome: 'route_computed',
              proposal: stored,
            }),
          );
        },
      );
    }

    /**
     * Generate bounded target-distance candidates under the current draft (M2-01i).
     *
     * A target distance is an approximation, and this route says so in every direction. The
     * search has a ceiling on candidates, attempts, wall-clock time and how far from the
     * origin it may wander; it records the seed it ran from and the evaluation version, and
     * it reports the attempts that produced nothing alongside the ones that did.
     *
     * **Nothing is saved or approved here.** A successful search stores its candidates as
     * proposals, exactly as a reroute stores one, and the course is unchanged by it: no
     * revision appears and no head moves. The owner picks one and saves it explicitly, and
     * at most one candidate from a search can ever become a revision.
     *
     * `no_candidate` is an answer, not an error: the search looked inside its bounds and
     * found nothing worth offering. No outcome returns a substitute geometry — every leg of
     * every candidate came back from the ordinary bounded routing path, which refuses an
     * answer the engine cannot attest with the edges behind it.
     */
    if (services.walkingRoutes) {
      const walkingRoutes = services.walkingRoutes;
      courseRoutes.post(
        '/courses/:courseId/route-candidates',
        { bodyLimit: COURSE_BODY_LIMIT },
        async (request: FastifyRequest, reply: FastifyReply) => {
          input(emptyQuery, request.query);
          const athleteId = principal(request).athleteId;
          const { courseId } = input(courseParamsSchema, request.params);
          const body = input(courseRouteCandidateRequestSchema, request.body);
          // Before any engine work: an unknown, someone else's or a reclaimed course buys
          // no search at all.
          const course = await execute(() => services.courses.read(athleteId, courseId));
          if (course.status !== 'available')
            throw new ProductRequestError(410, 'COURSE_UNAVAILABLE');
          // The seed is the caller's only when they are replaying a recorded one. Otherwise
          // the server draws it, so a caller cannot steer the search into a chosen shape by
          // grinding seeds against somebody else's engine time.
          const searchSeed = body.seed ?? randomBytes(8).toString('hex');
          const cancellation = cancellationSignal(reply);
          let search;
          try {
            search = await execute(() =>
              generateTargetDistanceCandidates({
                requestId: body.requestId,
                draftRevision: body.draftRevision,
                targetDistanceMeters: body.targetDistanceMeters,
                searchSeed,
                waypoints: body.waypoints,
                router: candidateRouter(walkingRoutes, athleteId),
                clock: { now: () => new Date() },
                signal: cancellation.signal,
              }),
            );
          } finally {
            cancellation.dispose();
          }
          const common = {
            courseId,
            draftRevision: body.draftRevision,
            targetDistanceMeters: body.targetDistanceMeters,
            searchSeed,
            generatorVersion: 'target-distance-loop-v1' as const,
            evaluationVersion: 1 as const,
            bounds: search.bounds,
            search: search.search,
          };
          if (search.candidates.length === 0) {
            // A refusal by the engine or a tenant bound is not the same fact as "we looked
            // and found nothing", and the two get different outcomes and different codes.
            const outcome = search.terminalOutcome ?? 'no_candidate';
            return reply.code(candidateOutcomeStatus(outcome)).send(
              courseRouteCandidateResultSchema.parse({
                outcome: outcome === 'request_refused' ? 'no_candidate' : outcome,
                ...common,
                computation: search.lastComputation,
              }),
            );
          }
          const stored = await execute(() =>
            services.courses.storeRouteCandidateSet(athleteId, {
              courseId,
              draftRevision: body.draftRevision,
              requestId: body.requestId,
              targetDistanceMeters: body.targetDistanceMeters,
              searchSeed,
              bounds: search.bounds,
              search: search.search,
              ttlSeconds: courseLimits.routeProposalTtlSeconds,
              candidates: search.candidates.map((candidate, ordinal) => ({
                ordinal,
                attemptIndex: candidate.attemptIndex,
                candidateSeed: candidate.candidateSeed,
                waypoints: candidate.waypoints,
                coordinates: candidate.coordinates,
                engineDistanceMeters: candidate.engineDistanceMeters,
                engineDurationSeconds: candidate.engineDurationSeconds,
                snappedWaypoints: candidate.snappedWaypoints,
                computation: candidate.computation,
                evaluation: candidate.evaluation,
              })),
            }),
          );
          z.number().max(targetDistanceLimits.maxCandidates).parse(stored.candidates.length);
          return reply.code(200).send(
            courseRouteCandidateResultSchema.parse({
              outcome: 'candidates_generated',
              set: stored,
            }),
          );
        },
      );
    }

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
