import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  activityDeletionImpactSchema,
  courseEditSchema,
  courseGenerationSchema,
  courseLimits,
  courseListSchema,
  courseNameSchema,
  coursePositionSchema,
  coursePrivacyZoneSchema,
  courseReadResultSchema,
  courseCandidateBoundsSchema,
  courseCandidateEvaluationSchema,
  courseCandidateSearchSummarySchema,
  courseRouteCandidateSchema,
  courseRouteCandidateSetSchema,
  courseRouteProposalSchema,
  courseWaypointListSchema,
  courseWaypointSchema,
  targetDistanceLimits,
  type CourseEdit,
  type CourseGeneration,
  type CourseLineage,
  type CoursePosition,
  type CoursePrivacyZone,
  type CourseCandidateEvaluation,
  type CourseRouteCandidate,
  type CourseRouteCandidateSet,
  type CourseRouteProposal,
  type CourseWaypoint,
} from '@workout/contracts/courses';
import {
  routeComputationRecordSchema,
  snappedWaypointSchema,
  type RouteComputationRecord,
} from '@workout/contracts/routing';

import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

type ReadResult = z.infer<typeof courseReadResultSchema>;
type CourseListResult = z.infer<typeof courseListSchema>;
type DeletionImpact = z.infer<typeof activityDeletionImpactSchema>;

export class CourseNotFoundError extends Error {
  readonly code = 'COURSE_NOT_FOUND';

  constructor() {
    super('COURSE_NOT_FOUND');
    this.name = 'CourseNotFoundError';
  }
}

export class CourseStateError extends Error {
  constructor(
    readonly code:
      | 'COURSE_REVISION_CONFLICT'
      | 'COURSE_QUOTA_EXCEEDED'
      | 'COURSE_REVISION_LIMIT'
      | 'COURSE_UNAVAILABLE'
      | 'ROUTE_PROPOSAL_QUOTA_EXCEEDED'
      | 'ROUTE_PROPOSAL_NOT_FOUND'
      | 'ROUTE_PROPOSAL_ALREADY_SAVED'
      | 'ROUTE_PROPOSAL_EXPIRED'
      | 'ROUTE_PROPOSAL_STALE_DRAFT'
      | 'ROUTE_PROPOSAL_CONTENT_MISMATCH'
      | 'COURSE_ZONE_ACKNOWLEDGEMENT_STALE'
      | 'ROUTE_CANDIDATE_SET_MISMATCH'
      | 'ROUTE_CANDIDATE_ALREADY_CHOSEN'
      | 'ROUTE_PROPOSAL_IS_CANDIDATE',
  ) {
    super(code);
    this.name = 'CourseStateError';
  }
}

/**
 * Content of one revision, already derived by the application from the server's own stored
 * recording. The repository never derives geometry and never accepts one from a client
 * path: it records what the derivation produced, with the lineage that decides
 * reclamation.
 */
export interface PreparedCourseContent {
  readonly name: string;
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly generation: CourseGeneration;
  readonly edit: CourseEdit;
  readonly lineage: readonly CourseLineage[];
  readonly distanceMeters: number;
  readonly contentDigest: string;
}

/**
 * One computed route to keep until the owner decides. `ttlSeconds` bounds how long an
 * unreviewed computation keeps private coordinates around.
 */
export interface StoredRouteProposalInput {
  readonly courseId: string;
  readonly draftRevision: number;
  readonly requestId: string;
  readonly waypoints: readonly CourseWaypoint[];
  readonly coordinates: readonly CoursePosition[];
  readonly engineDistanceMeters: number;
  readonly engineDurationSeconds: number;
  readonly snappedWaypoints: readonly z.infer<typeof snappedWaypointSchema>[];
  readonly computation: RouteComputationRecord;
  readonly ttlSeconds: number;
}

/**
 * Consuming a reviewed proposal in the same transaction as the revision it becomes.
 *
 * `geometrySha256` is recomputed by the caller from the coordinates it is about to write
 * and compared against the value stored with the proposal, so the line that ends up in the
 * ledger is the line that was proposed. `draftRevision` must be the one the proposal was
 * computed from: a draft that moved on is recomputed, never saved from a stale answer.
 */
export interface CourseUpdateOptions {
  readonly consumeProposal?: {
    readonly proposalId: string;
    readonly draftRevision: number;
    readonly geometrySha256: string;
  };
  /**
   * Picking one generated candidate (M2-01i). Everything `consumeProposal` checks is
   * checked, and the candidate must belong to the search the request named — otherwise a
   * revision could record conditions pointing at a search its line did not come from.
   */
  readonly consumeCandidate?: {
    readonly proposalId: string;
    readonly candidateSetId: string;
    readonly draftRevision: number;
    readonly geometrySha256: string;
  };
  /**
   * Re-check the owner's protected areas **inside the writing transaction** (M2-01j).
   *
   * A privacy trim is computed against the areas the screen showed, and the API checks
   * that set before it derives anything. That check is a different transaction from the
   * write, so an area added in between would leave its coordinates inside a line that was
   * reported as a successful trim. The guard is repeated here, under the same tenant lock
   * every zone write takes, so nothing can be added or removed between the check and the
   * revision it guards.
   *
   * `digestOf` is injected rather than imported: what may leave the server is a domain
   * rule (ids and radii only, never a centre), and this repository must not be the place
   * that decides it.
   */
  readonly requireZoneSet?: {
    readonly expectedDigest: string;
    readonly digestOf: (zones: readonly CoursePrivacyZone[]) => string;
  };
}

/** One candidate as the application hands it over, before anything is stored. */
export interface PreparedCandidate {
  readonly ordinal: number;
  readonly attemptIndex: number;
  readonly candidateSeed: string;
  readonly waypoints: readonly CourseWaypoint[];
  readonly coordinates: readonly CoursePosition[];
  readonly engineDistanceMeters: number;
  readonly engineDurationSeconds: number;
  readonly snappedWaypoints: readonly z.infer<typeof snappedWaypointSchema>[];
  readonly computation: RouteComputationRecord;
  readonly evaluation: CourseCandidateEvaluation;
}

/**
 * One bounded search and the candidates it offered. Writing this changes nothing about the
 * course: it is the reviewable artefact the owner may or may not pick one of.
 */
export interface StoredCandidateSetInput {
  readonly courseId: string;
  readonly draftRevision: number;
  readonly requestId: string;
  readonly targetDistanceMeters: number;
  readonly searchSeed: string;
  readonly bounds: unknown;
  readonly search: unknown;
  readonly candidates: readonly PreparedCandidate[];
  readonly ttlSeconds: number;
}

/** One stored candidate, with the search facts a revision has to record alongside it. */
export interface StoredCandidateRead {
  readonly candidate: CourseRouteCandidate;
  readonly candidateSetId: string;
  readonly draftRevision: number;
  readonly targetDistanceMeters: number;
  readonly searchSeed: string;
}

/** The head as the application needs it before it can derive a new revision. */
export interface CourseHeadContent {
  readonly courseId: string;
  readonly courseRevision: number;
  readonly name: string;
  readonly coordinates: readonly CoursePosition[];
  readonly waypoints: readonly CourseWaypoint[];
  readonly generation: CourseGeneration;
  readonly lineage: readonly CourseLineage[];
}

export interface CourseRepository {
  /**
   * Which course a completed command under this key produced and at which revision, or
   * `null` when the key is unused. A different request under a used key is a conflict.
   *
   * This exists so a caller can recognise its own successful resend **before** it reads
   * the head: once the first attempt advanced the revision, the resent expectation no
   * longer matches the head, and without this lookup an identical resend would be
   * answered with a revision conflict instead of the original result.
   */
  replayCommand(
    athleteId: string,
    requestIdempotencyKey: string,
    request: unknown,
  ): Promise<{ courseId: string; courseRevision: number } | null>;
  /**
   * `request` is what the receipt records. The API passes the *client's* request so a
   * resend can be recognised before any derivation; callers that have no such request
   * fall back to the derived content, which is deterministic for one selection.
   */
  create(
    athleteId: string,
    content: PreparedCourseContent,
    requestIdempotencyKey: string,
    request?: unknown,
  ): Promise<ReadResult>;
  read(athleteId: string, courseId: string): Promise<ReadResult>;
  list(athleteId: string): Promise<CourseListResult>;
  /** The head content an edit starts from. `null` when the course has been reclaimed. */
  headContent(athleteId: string, courseId: string): Promise<CourseHeadContent | null>;
  update(
    athleteId: string,
    courseId: string,
    expectedRevision: number,
    content: PreparedCourseContent,
    requestIdempotencyKey: string,
    request?: unknown,
    options?: CourseUpdateOptions,
  ): Promise<ReadResult>;
  /**
   * Store one computed route as a proposal. Nothing about the course changes; this is the
   * reviewable artefact the owner may or may not save, and it is also where M2-01g's
   * computation record becomes durable.
   */
  storeRouteProposal(
    athleteId: string,
    input: StoredRouteProposalInput,
  ): Promise<CourseRouteProposal>;
  /**
   * Store one bounded search and its candidates. Nothing about the course changes; at most
   * one of these rows can ever become a revision, and only when the owner picks it.
   */
  storeRouteCandidateSet(
    athleteId: string,
    input: StoredCandidateSetInput,
  ): Promise<CourseRouteCandidateSet>;
  /** One stored candidate, or `null` when it is unknown, expired or already saved. */
  readRouteCandidate(
    athleteId: string,
    courseId: string,
    candidateSetId: string,
    proposalId: string,
  ): Promise<StoredCandidateRead | null>;
  /** One stored proposal, or `null` when it is unknown, expired or already saved. */
  readRouteProposal(
    athleteId: string,
    courseId: string,
    proposalId: string,
  ): Promise<CourseRouteProposal | null>;
  remove(
    athleteId: string,
    courseId: string,
    expectedRevision: number,
  ): Promise<{ deleted: boolean }>;
  affectedByActivityDeletion(athleteId: string, activityId: string): Promise<DeletionImpact>;
}

const instant = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

const headRowSchema = z.object({
  course_id: uuid,
  name: z.string(),
  status: z.enum(['available', 'unavailable']),
  head_revision: z.number().int().positive().nullable(),
  revision_id: uuid.nullable(),
  unavailable_reason: z.literal('source_activity_deleted').nullable(),
  reclaimed_at: z.union([z.date(), z.string()]).nullable(),
  created_at: z.union([z.date(), z.string()]),
  updated_at: z.union([z.date(), z.string()]),
});

const revisionRowSchema = z.object({
  course_id: uuid,
  course_revision: z.number().int().positive(),
  revision_id: uuid,
  name: z.string(),
  geometry: z.unknown(),
  waypoints: z.unknown(),
  generation: z.unknown(),
  edit: z.unknown(),
  distance_meters: z.coerce.number().finite(),
  content_digest: z.string(),
  created_at: z.union([z.date(), z.string()]),
});

const geometrySchema = z.strictObject({
  type: z.literal('LineString'),
  coordinates: z.array(coursePositionSchema).min(2).max(courseLimits.vertices),
});

function head(row: z.infer<typeof headRowSchema>) {
  const common = {
    courseId: row.course_id,
    name: courseNameSchema.parse(row.name),
    visibility: 'private' as const,
    createdAt: instant(row.created_at),
    updatedAt: instant(row.updated_at),
  };
  if (row.status === 'available')
    return {
      status: 'available' as const,
      ...common,
      headRevision: z.number().int().positive().parse(row.head_revision),
      revisionId: z.string().parse(row.revision_id),
    };
  return {
    status: 'unavailable' as const,
    ...common,
    reason: z.literal('source_activity_deleted').parse(row.unavailable_reason),
    reclaimedAt: instant(row.reclaimed_at),
  };
}

function revision(row: z.infer<typeof revisionRowSchema>, lineage: readonly CourseLineage[]) {
  return {
    courseId: row.course_id,
    courseRevision: row.course_revision,
    revisionId: row.revision_id,
    name: row.name,
    geometry: geometrySchema.parse(row.geometry),
    waypoints: z.array(courseWaypointSchema).parse(row.waypoints),
    generation: courseGenerationSchema.parse(row.generation),
    edit: courseEditSchema.parse(row.edit),
    lineage,
    distanceMeters: row.distance_meters,
    contentDigest: row.content_digest,
    createdAt: instant(row.created_at),
  };
}

async function lineageOf(
  tx: Transaction,
  courseId: string,
  courseRevision: number,
): Promise<CourseLineage[]> {
  const rows = await tx.query(
    `SELECT activity_id,track_id,track_revision FROM course_revision_source
     WHERE athlete_id=$1 AND course_id=$2 AND course_revision=$3
     ORDER BY activity_id,track_id,track_revision`,
    [tx.athleteId, courseId, courseRevision],
  );
  return rows.rows.map((row) =>
    z
      .object({
        activityId: uuid,
        trackId: uuid,
        trackRevision: z.number().int().positive(),
      })
      .parse({
        activityId: row['activity_id'],
        trackId: row['track_id'],
        trackRevision: row['track_revision'],
      }),
  );
}

async function readCourse(tx: Transaction, courseId: string): Promise<ReadResult> {
  const found = await tx.query(
    `SELECT course_id,name,status,head_revision,revision_id,unavailable_reason,reclaimed_at,
       created_at,updated_at
     FROM course WHERE athlete_id=$1 AND course_id=$2`,
    [tx.athleteId, courseId],
  );
  if (!found.rows[0]) throw new CourseNotFoundError();
  const course = head(headRowSchema.parse(found.rows[0]));
  if (course.status === 'unavailable')
    return courseReadResultSchema.parse({ status: 'unavailable', course });
  const revisionRow = await tx.query(
    `SELECT course_id,course_revision,revision_id,name,geometry,waypoints,generation,edit,
       distance_meters,content_digest,created_at
     FROM course_revision WHERE athlete_id=$1 AND course_id=$2 AND course_revision=$3`,
    [tx.athleteId, courseId, course.headRevision],
  );
  if (!revisionRow.rows[0]) throw new CourseNotFoundError();
  const parsed = revisionRowSchema.parse(revisionRow.rows[0]);
  return courseReadResultSchema.parse({
    status: 'available',
    course,
    revision: revision(parsed, await lineageOf(tx, courseId, parsed.course_revision)),
  });
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Identity of one planned line. Computed the same way when a proposal is stored and when
 * the revision it becomes is written, so the two can be compared inside the writing
 * transaction rather than trusted to be the same.
 */
export function courseGeometrySha256(coordinates: readonly CoursePosition[]): string {
  return createHash('sha256')
    .update(JSON.stringify(coordinates.map((position) => [position[0], position[1]])))
    .digest('hex');
}

const proposalRowSchema = z.object({
  proposal_id: uuid,
  course_id: uuid,
  request_id: z.string(),
  draft_revision: z.number().int().positive(),
  waypoints: z.unknown(),
  geometry: z.unknown(),
  engine_distance_meters: z.coerce.number().finite(),
  engine_duration_seconds: z.coerce.number().finite(),
  snapped_waypoints: z.unknown(),
  computation: z.unknown(),
  created_at: z.union([z.date(), z.string()]),
  expires_at: z.union([z.date(), z.string()]),
});

function proposal(row: z.infer<typeof proposalRowSchema>): CourseRouteProposal {
  return courseRouteProposalSchema.parse({
    proposalId: row.proposal_id,
    courseId: row.course_id,
    requestId: row.request_id,
    draftRevision: row.draft_revision,
    waypoints: row.waypoints,
    geometry: row.geometry,
    engineDistanceMeters: row.engine_distance_meters,
    engineDurationSeconds: row.engine_duration_seconds,
    snappedWaypoints: row.snapped_waypoints,
    computation: row.computation,
    createdAt: instant(row.created_at),
    expiresAt: instant(row.expires_at),
  });
}

const PROPOSAL_COLUMNS = `proposal_id,course_id,request_id,draft_revision,waypoints,geometry,
  engine_distance_meters,engine_duration_seconds,snapped_waypoints,computation,created_at,
  expires_at`;

const candidateRowSchema = proposalRowSchema.extend({
  candidate_set_id: uuid,
  candidate_ordinal: z.number().int().min(0),
  candidate_attempt_index: z.number().int().min(0),
  candidate_seed: z.string(),
  candidate_evaluation: z.unknown(),
});

const CANDIDATE_COLUMNS = `${PROPOSAL_COLUMNS},candidate_set_id,candidate_ordinal,
  candidate_attempt_index,candidate_seed,candidate_evaluation`;

function candidate(row: z.infer<typeof candidateRowSchema>): CourseRouteCandidate {
  return courseRouteCandidateSchema.parse({
    proposalId: row.proposal_id,
    ordinal: row.candidate_ordinal,
    attemptIndex: row.candidate_attempt_index,
    candidateSeed: row.candidate_seed,
    waypoints: row.waypoints,
    geometry: row.geometry,
    engineDistanceMeters: row.engine_distance_meters,
    engineDurationSeconds: row.engine_duration_seconds,
    snappedWaypoints: row.snapped_waypoints,
    computation: row.computation,
    evaluation: row.candidate_evaluation,
  });
}

const candidateSetRowSchema = z.object({
  candidate_set_id: uuid,
  course_id: uuid,
  request_id: z.string(),
  draft_revision: z.number().int().positive(),
  target_distance_meters: z.coerce.number().finite(),
  search_seed: z.string(),
  generator_version: z.string(),
  evaluation_version: z.number().int(),
  bounds: z.unknown(),
  search: z.unknown(),
  created_at: z.union([z.date(), z.string()]),
  expires_at: z.union([z.date(), z.string()]),
});

const CANDIDATE_SET_COLUMNS = `candidate_set_id,course_id,request_id,draft_revision,
  target_distance_meters,search_seed,generator_version,evaluation_version,bounds,search,
  created_at,expires_at`;

/** Map a bounded database refusal onto the state error the API answers with. */
function proposalStateError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  for (const code of [
    'ROUTE_CANDIDATE_SET_MISMATCH',
    'ROUTE_CANDIDATE_ALREADY_CHOSEN',
    'ROUTE_PROPOSAL_IS_CANDIDATE',
    'ROUTE_PROPOSAL_NOT_FOUND',
    'ROUTE_PROPOSAL_ALREADY_SAVED',
    'ROUTE_PROPOSAL_EXPIRED',
    'ROUTE_PROPOSAL_STALE_DRAFT',
    'ROUTE_PROPOSAL_CONTENT_MISMATCH',
  ] as const)
    if (message.includes(code)) throw new CourseStateError(code);
  throw error;
}

/**
 * The owner's protected areas, ordered, for the in-transaction trim guard. The rows are
 * returned as the contract describes them; what may be digested from them is decided by
 * the domain, not here.
 */
async function readPrivacyZones(tx: Transaction): Promise<CoursePrivacyZone[]> {
  const rows = await tx.query(
    `SELECT zone_id,name,center_longitude,center_latitude,radius_meters,created_at,updated_at
     FROM course_privacy_zone WHERE athlete_id=$1 ORDER BY created_at,zone_id LIMIT $2`,
    [tx.athleteId, courseLimits.privacyZonesPerTenant],
  );
  return rows.rows.map((row) =>
    coursePrivacyZoneSchema.parse({
      zoneId: row['zone_id'],
      name: row['name'],
      center: [Number(row['center_longitude']), Number(row['center_latitude'])],
      radiusMeters: Number(row['radius_meters']),
      createdAt: instant(row['created_at']),
      updatedAt: instant(row['updated_at']),
    }),
  );
}

async function tenantLock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
}

async function databaseNow(tx: Transaction) {
  return instant((await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at']);
}

/**
 * Replay of a completed command: which course it produced and at which revision. The
 * caller reads the course from that, so what a resend sees is the course's current state,
 * not a snapshot of the moment the command ran. A different request under the same key is
 * a conflict rather than a silent overwrite.
 */
async function replay(
  tx: Transaction,
  key: string,
  request: unknown,
): Promise<{ courseId: string; courseRevision: number } | null> {
  const previous = await tx.query(
    `SELECT request=$3::jsonb AS matches,result FROM command_receipt
     WHERE athlete_id=$1 AND idempotency_key=$2`,
    [tx.athleteId, key, JSON.stringify({ sha256: digest(request) })],
  );
  if (previous.rows.length === 0) return null;
  if (previous.rows[0]?.['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return z
    .object({ courseId: uuid, courseRevision: z.number().int().positive() })
    .parse(previous.rows[0]?.['result']);
}

async function recordCommand(
  tx: Transaction,
  key: string,
  request: unknown,
  result: { courseId: string; courseRevision: number },
  topic: string,
) {
  await enqueue(tx, { id: randomUUID(), idempotencyKey: key, topic, payload: result });
  await tx.query(
    `INSERT INTO command_receipt(athlete_id,idempotency_key,request,result)
     VALUES($1,$2,$3::jsonb,$4::jsonb)`,
    [tx.athleteId, key, JSON.stringify({ sha256: digest(request) }), JSON.stringify(result)],
  );
}

async function insertRevision(
  tx: Transaction,
  courseId: string,
  courseRevision: number,
  revisionId: string,
  content: PreparedCourseContent,
  at: string,
) {
  await tx.query(
    `INSERT INTO course_revision(athlete_id,course_id,course_revision,revision_id,name,geometry,
       waypoints,generation,edit,vertex_count,distance_meters,content_digest,created_at)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`,
    [
      tx.athleteId,
      courseId,
      courseRevision,
      revisionId,
      content.name,
      JSON.stringify({ type: 'LineString', coordinates: content.coordinates }),
      JSON.stringify(content.waypoints),
      JSON.stringify(content.generation),
      JSON.stringify(content.edit),
      content.coordinates.length,
      content.distanceMeters,
      content.contentDigest,
      at,
    ],
  );
  for (const source of content.lineage)
    await tx.query(
      `INSERT INTO course_revision_source(athlete_id,course_id,course_revision,activity_id,
         track_id,track_revision) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        tx.athleteId,
        courseId,
        courseRevision,
        source.activityId,
        source.trackId,
        source.trackRevision,
      ],
    );
}

function validateContent(content: PreparedCourseContent): PreparedCourseContent {
  return {
    name: courseNameSchema.parse(content.name),
    coordinates: geometrySchema.parse({ type: 'LineString', coordinates: content.coordinates })
      .coordinates,
    waypoints: courseWaypointListSchema.parse(content.waypoints),
    generation: courseGenerationSchema.parse(content.generation),
    edit: courseEditSchema.parse(content.edit),
    lineage: z
      .array(
        z.strictObject({
          activityId: uuid,
          trackId: uuid,
          trackRevision: z.number().int().positive(),
        }),
      )
      // Empty only for a course whose coordinates never came from one of our recordings:
      // an imported file (M2-01j). Everything derived from a recording still names it, so
      // reclamation on activity deletion is unchanged.
      .max(courseLimits.waypoints)
      .parse(content.lineage),
    distanceMeters: z.number().finite().nonnegative().parse(content.distanceMeters),
    contentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(content.contentDigest),
  };
}

/**
 * The private course ledger.
 *
 * Nothing in here writes to an Activity, a source revision, an overlay or a PlanVersion:
 * the only table this repository writes is the course ledger, and the recording a course
 * came from is read through its lineage columns. Concurrency is controlled by an explicit
 * expected revision, and a repeated write that would produce identical content returns the
 * head it already has instead of appending a copy of it.
 */
export function createCourseRepository(database: Database): CourseRepository {
  return {
    replayCommand(athleteId, rawKey, request) {
      const tenantId = uuid.parse(athleteId);
      const key = idempotencyKey.parse(rawKey);
      return database.tenant(tenantId, (tx) => replay(tx, key, request));
    },

    create(athleteId, rawContent, rawKey, clientRequest) {
      const tenantId = uuid.parse(athleteId);
      const content = validateContent(rawContent);
      const key = idempotencyKey.parse(rawKey);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const request = clientRequest ?? { kind: 'course_create', content };
        const replayed = await replay(tx, key, request);
        if (replayed) return readCourse(tx, replayed.courseId);
        const existing = await tx.query(
          'SELECT count(*)::integer AS total FROM course WHERE athlete_id=$1',
          [tenantId],
        );
        if (z.number().int().parse(existing.rows[0]?.['total']) >= courseLimits.coursesPerTenant)
          throw new CourseStateError('COURSE_QUOTA_EXCEEDED');
        const at = await databaseNow(tx);
        const courseId = randomUUID();
        const revisionId = randomUUID();
        await tx.query(
          `INSERT INTO course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,
             created_at,updated_at)
           VALUES($1,$2,$3,'private','available',1,$4,$5,$5)`,
          [tenantId, courseId, content.name, revisionId, at],
        );
        await insertRevision(tx, courseId, 1, revisionId, content, at);
        await recordCommand(
          tx,
          key,
          request,
          { courseId, courseRevision: 1 },
          'course.revision_stored',
        );
        return readCourse(tx, courseId);
      });
    },

    read(athleteId, rawCourseId) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      return database.tenant(tenantId, (tx) => readCourse(tx, courseId));
    },

    list(athleteId) {
      const tenantId = uuid.parse(athleteId);
      return database.tenant(tenantId, async (tx) => {
        const rows = await tx.query(
          `SELECT course_id,name,status,head_revision,revision_id,unavailable_reason,reclaimed_at,
             created_at,updated_at
           FROM course WHERE athlete_id=$1 ORDER BY created_at,course_id LIMIT $2`,
          [tenantId, courseLimits.coursesPerTenant],
        );
        const courses = rows.rows.map((row) => head(headRowSchema.parse(row)));
        return courseListSchema.parse({ courses, total: courses.length });
      });
    },

    headContent(athleteId, rawCourseId) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      return database.tenant(tenantId, async (tx) => {
        const result = await readCourse(tx, courseId);
        if (result.status !== 'available') return null;
        return {
          courseId,
          courseRevision: result.revision.courseRevision,
          name: result.revision.name,
          coordinates: result.revision.geometry.coordinates,
          waypoints: result.revision.waypoints,
          generation: result.revision.generation,
          lineage: result.revision.lineage,
        };
      });
    },

    storeRouteProposal(athleteId, rawInput) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawInput.courseId);
      const draftRevision = z
        .number()
        .int()
        .min(1)
        .max(courseLimits.maxDraftRevision)
        .parse(rawInput.draftRevision);
      const waypoints = courseWaypointListSchema.parse(rawInput.waypoints);
      const geometry = geometrySchema.parse({
        type: 'LineString',
        coordinates: rawInput.coordinates,
      });
      const computation = routeComputationRecordSchema.parse(rawInput.computation);
      const snapped = z.array(snappedWaypointSchema).min(2).parse(rawInput.snappedWaypoints);
      const ttlSeconds = z.number().int().min(1).max(86_400).parse(rawInput.ttlSeconds);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        // Expired and already-saved rows go first, so an owner who keeps recomputing does
        // not accumulate private coordinates and the bound below measures live drafts.
        await tx.query('SELECT public.reap_course_route_proposals()');
        const course = await tx.query(
          'SELECT status FROM course WHERE athlete_id=$1 AND course_id=$2',
          [tenantId, courseId],
        );
        if (!course.rows[0]) throw new CourseNotFoundError();
        if (course.rows[0]['status'] !== 'available')
          throw new CourseStateError('COURSE_UNAVAILABLE');
        const open = await tx.query(
          `SELECT count(*) FILTER (WHERE course_id=$2)::integer AS for_course,
                  count(*)::integer AS for_tenant
           FROM course_route_proposal
           WHERE athlete_id=$1 AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
          [tenantId, courseId],
        );
        const counts = z
          .object({ for_course: z.number().int(), for_tenant: z.number().int() })
          .parse(open.rows[0]);
        if (
          counts.for_course >= courseLimits.openRouteProposalsPerCourse ||
          counts.for_tenant >= courseLimits.openRouteProposalsPerTenant
        )
          throw new CourseStateError('ROUTE_PROPOSAL_QUOTA_EXCEEDED');
        const proposalId = randomUUID();
        const inserted = await tx.query(
          `INSERT INTO course_route_proposal(athlete_id,proposal_id,course_id,draft_revision,
             request_id,waypoints,geometry,geometry_sha256,engine_distance_meters,
             engine_duration_seconds,snapped_waypoints,computation,graph_build_id,created_at,
             expires_at)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13,
             statement_timestamp(),statement_timestamp()+make_interval(secs=>$14))
           RETURNING ${PROPOSAL_COLUMNS}`,
          [
            tenantId,
            proposalId,
            courseId,
            draftRevision,
            computation.requestId,
            JSON.stringify(waypoints),
            JSON.stringify(geometry),
            courseGeometrySha256(geometry.coordinates),
            rawInput.engineDistanceMeters,
            rawInput.engineDurationSeconds,
            JSON.stringify(snapped),
            JSON.stringify(computation),
            computation.graph.graphBuildId,
            ttlSeconds,
          ],
        );
        return proposal(proposalRowSchema.parse(inserted.rows[0]));
      });
    },

    storeRouteCandidateSet(athleteId, rawInput) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawInput.courseId);
      const draftRevision = z
        .number()
        .int()
        .min(1)
        .max(courseLimits.maxDraftRevision)
        .parse(rawInput.draftRevision);
      const searchSeed = z
        .string()
        .regex(/^[0-9a-f]{16}$/)
        .parse(rawInput.searchSeed);
      const targetDistanceMeters = z
        .number()
        .finite()
        .min(targetDistanceLimits.minTargetMeters)
        .max(targetDistanceLimits.maxTargetMeters)
        .parse(rawInput.targetDistanceMeters);
      const bounds = courseCandidateBoundsSchema.parse(rawInput.bounds);
      const search = courseCandidateSearchSummarySchema.parse(rawInput.search);
      const ttlSeconds = z.number().int().min(1).max(86_400).parse(rawInput.ttlSeconds);
      const candidates = z
        .array(z.unknown())
        .min(1)
        .max(targetDistanceLimits.maxCandidates)
        .parse(rawInput.candidates)
        .map((_, index) => {
          const input = rawInput.candidates[index] as PreparedCandidate;
          return {
            ordinal: z
              .number()
              .int()
              .min(0)
              .max(targetDistanceLimits.maxCandidates - 1)
              .parse(input.ordinal),
            attemptIndex: z
              .number()
              .int()
              .min(0)
              .max(targetDistanceLimits.maxAttempts - 1)
              .parse(input.attemptIndex),
            candidateSeed: z
              .string()
              .regex(/^[0-9a-f]{16}$/)
              .parse(input.candidateSeed),
            waypoints: courseWaypointListSchema.parse(input.waypoints),
            geometry: geometrySchema.parse({
              type: 'LineString',
              coordinates: input.coordinates,
            }),
            engineDistanceMeters: input.engineDistanceMeters,
            engineDurationSeconds: input.engineDurationSeconds,
            snappedWaypoints: z.array(snappedWaypointSchema).min(2).parse(input.snappedWaypoints),
            computation: routeComputationRecordSchema.parse(input.computation),
            evaluation: courseCandidateEvaluationSchema.parse(input.evaluation),
          };
        });
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        // Expired searches and the candidates cascading from them go first, for the same
        // reason the proposal reaper runs here: an owner who keeps generating must not
        // accumulate private coordinates, and the bound below has to measure live rows.
        await tx.query('SELECT public.reap_course_route_candidate_sets()');
        await tx.query('SELECT public.reap_course_route_proposals()');
        const course = await tx.query(
          'SELECT status FROM course WHERE athlete_id=$1 AND course_id=$2',
          [tenantId, courseId],
        );
        if (!course.rows[0]) throw new CourseNotFoundError();
        if (course.rows[0]['status'] !== 'available')
          throw new CourseStateError('COURSE_UNAVAILABLE');
        const open = await tx.query(
          `SELECT count(*) FILTER (WHERE course_id=$2)::integer AS for_course,
                  count(*)::integer AS for_tenant
           FROM course_route_proposal
           WHERE athlete_id=$1 AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
          [tenantId, courseId],
        );
        const counts = z
          .object({ for_course: z.number().int(), for_tenant: z.number().int() })
          .parse(open.rows[0]);
        // A whole search has to fit inside the same proposal bound a single reroute does.
        // Candidates are proposals; letting a search write past the bound would be a way
        // around it.
        if (
          counts.for_course + candidates.length > courseLimits.openRouteProposalsPerCourse ||
          counts.for_tenant + candidates.length > courseLimits.openRouteProposalsPerTenant
        )
          throw new CourseStateError('ROUTE_PROPOSAL_QUOTA_EXCEEDED');
        const candidateSetId = randomUUID();
        const insertedSet = await tx.query(
          `INSERT INTO course_route_candidate_set(athlete_id,candidate_set_id,course_id,
             draft_revision,request_id,target_distance_meters,search_seed,generator_version,
             evaluation_version,bounds,search,created_at,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,'target-distance-loop-v1',1,$8::jsonb,$9::jsonb,
             statement_timestamp(),statement_timestamp()+make_interval(secs=>$10))
           RETURNING ${CANDIDATE_SET_COLUMNS}`,
          [
            tenantId,
            candidateSetId,
            courseId,
            draftRevision,
            rawInput.requestId,
            targetDistanceMeters,
            searchSeed,
            JSON.stringify(bounds),
            JSON.stringify(search),
            ttlSeconds,
          ],
        );
        const setRow = candidateSetRowSchema.parse(insertedSet.rows[0]);
        const stored: CourseRouteCandidate[] = [];
        for (const item of candidates) {
          const inserted = await tx.query(
            `INSERT INTO course_route_proposal(athlete_id,proposal_id,course_id,draft_revision,
               request_id,waypoints,geometry,geometry_sha256,engine_distance_meters,
               engine_duration_seconds,snapped_waypoints,computation,graph_build_id,created_at,
               expires_at,candidate_set_id,candidate_ordinal,candidate_attempt_index,
               candidate_seed,candidate_evaluation)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13,
               $14,$15,$16,$17,$18,$19,$20::jsonb)
             RETURNING ${CANDIDATE_COLUMNS}`,
            [
              tenantId,
              randomUUID(),
              courseId,
              draftRevision,
              item.computation.requestId,
              JSON.stringify(item.waypoints),
              JSON.stringify(item.geometry),
              courseGeometrySha256(item.geometry.coordinates),
              item.engineDistanceMeters,
              item.engineDurationSeconds,
              JSON.stringify(item.snappedWaypoints),
              JSON.stringify(item.computation),
              item.computation.graph.graphBuildId,
              setRow.created_at,
              setRow.expires_at,
              candidateSetId,
              item.ordinal,
              item.attemptIndex,
              item.candidateSeed,
              JSON.stringify(item.evaluation),
            ],
          );
          stored.push(candidate(candidateRowSchema.parse(inserted.rows[0])));
        }
        return courseRouteCandidateSetSchema.parse({
          candidateSetId,
          courseId,
          requestId: setRow.request_id,
          draftRevision: setRow.draft_revision,
          targetDistanceMeters: setRow.target_distance_meters,
          searchSeed: setRow.search_seed,
          generatorVersion: setRow.generator_version,
          evaluationVersion: setRow.evaluation_version,
          bounds: setRow.bounds,
          search: setRow.search,
          candidates: stored,
          createdAt: instant(setRow.created_at),
          expiresAt: instant(setRow.expires_at),
        });
      });
    },

    readRouteCandidate(athleteId, rawCourseId, rawSetId, rawProposalId) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      const candidateSetId = uuid.parse(rawSetId);
      const proposalId = uuid.parse(rawProposalId);
      return database.tenant(tenantId, async (tx) => {
        const rows = await tx.query(
          `SELECT ${CANDIDATE_COLUMNS} FROM course_route_proposal
           WHERE athlete_id=$1 AND course_id=$2 AND proposal_id=$3 AND candidate_set_id=$4
             AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
          [tenantId, courseId, proposalId, candidateSetId],
        );
        if (!rows.rows[0]) return null;
        const setRows = await tx.query(
          // A spent search stops offering every one of its candidates, not just the taken
          // one: the owner chose, and the siblings were alternatives to that choice.
          `SELECT ${CANDIDATE_SET_COLUMNS} FROM course_route_candidate_set
           WHERE athlete_id=$1 AND course_id=$2 AND candidate_set_id=$3
             AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
          [tenantId, courseId, candidateSetId],
        );
        if (!setRows.rows[0]) return null;
        const setRow = candidateSetRowSchema.parse(setRows.rows[0]);
        return {
          candidate: candidate(candidateRowSchema.parse(rows.rows[0])),
          candidateSetId,
          draftRevision: setRow.draft_revision,
          targetDistanceMeters: setRow.target_distance_meters,
          searchSeed: setRow.search_seed,
        };
      });
    },

    readRouteProposal(athleteId, rawCourseId, rawProposalId) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      const proposalId = uuid.parse(rawProposalId);
      return database.tenant(tenantId, async (tx) => {
        const rows = await tx.query(
          // `candidate_set_id IS NULL` is the point of this clause: a candidate is a
          // proposal row, and answering with one here would let the generic reroute save
          // record it under conditions that carry no target, no seed and no evaluation.
          // The database refuses it too; this stops the request before it gets there.
          `SELECT ${PROPOSAL_COLUMNS} FROM course_route_proposal
           WHERE athlete_id=$1 AND course_id=$2 AND proposal_id=$3
             AND candidate_set_id IS NULL
             AND consumed_at IS NULL AND expires_at>statement_timestamp()`,
          [tenantId, courseId, proposalId],
        );
        if (!rows.rows[0]) return null;
        return proposal(proposalRowSchema.parse(rows.rows[0]));
      });
    },

    update(athleteId, rawCourseId, rawExpected, rawContent, rawKey, clientRequest, options) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      const expectedRevision = z.number().int().positive().parse(rawExpected);
      const content = validateContent(rawContent);
      const key = idempotencyKey.parse(rawKey);
      return database.tenant(tenantId, async (tx) => {
        await tenantLock(tx);
        const request = clientRequest ?? {
          kind: 'course_update',
          courseId,
          expectedRevision,
          content,
        };
        const replayed = await replay(tx, key, request);
        if (replayed) return readCourse(tx, replayed.courseId);
        const current = await tx.query(
          `SELECT status,head_revision FROM course WHERE athlete_id=$1 AND course_id=$2 FOR UPDATE`,
          [tenantId, courseId],
        );
        if (!current.rows[0]) throw new CourseNotFoundError();
        const state = z
          .object({
            status: z.enum(['available', 'unavailable']),
            head_revision: z.number().int().positive().nullable(),
          })
          .parse(current.rows[0]);
        if (state.status !== 'available') throw new CourseStateError('COURSE_UNAVAILABLE');
        if (state.head_revision !== expectedRevision)
          throw new CourseStateError('COURSE_REVISION_CONFLICT');
        // The protected areas, re-read inside this transaction. The API checked them
        // before it derived the trimmed line, but that was another transaction: an area
        // added in between would otherwise leave its coordinates inside a line reported as
        // a successful trim. Every write to `course_privacy_zone` takes the same tenant
        // advisory lock this transaction already holds, so the set cannot move between
        // this check and the revision it guards.
        const zoneGuard = options?.requireZoneSet;
        if (
          zoneGuard &&
          zoneGuard.digestOf(await readPrivacyZones(tx)) !== zoneGuard.expectedDigest
        )
          throw new CourseStateError('COURSE_ZONE_ACKNOWLEDGEMENT_STALE');
        const headRow = await tx.query(
          'SELECT content_digest FROM course_revision WHERE athlete_id=$1 AND course_id=$2 AND course_revision=$3',
          [tenantId, courseId, expectedRevision],
        );
        // Identical content under the same expectation is the same version, not a new one.
        if (z.string().parse(headRow.rows[0]?.['content_digest']) === content.contentDigest) {
          await recordCommand(
            tx,
            key,
            request,
            { courseId, courseRevision: expectedRevision },
            'course.revision_unchanged',
          );
          return readCourse(tx, courseId);
        }
        if (expectedRevision >= courseLimits.revisionsPerCourse)
          throw new CourseStateError('COURSE_REVISION_LIMIT');
        const at = await databaseNow(tx);
        const nextRevision = expectedRevision + 1;
        const revisionId = randomUUID();
        // Inside this transaction, not before it. A proposal read outside would leave the
        // window where two saves of one reviewed computation both find it unconsumed; the
        // bounded function takes the row `FOR UPDATE`, checks the course, the draft
        // revision, the expiry and the geometry it is about to become, and marks it used.
        const pickCandidate = options?.consumeCandidate;
        if (pickCandidate)
          await tx
            .query('SELECT public.consume_course_route_candidate($1,$2,$3,$4,$5,$6)', [
              uuid.parse(pickCandidate.proposalId),
              uuid.parse(pickCandidate.candidateSetId),
              courseId,
              z
                .number()
                .int()
                .min(1)
                .max(courseLimits.maxDraftRevision)
                .parse(pickCandidate.draftRevision),
              z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .parse(pickCandidate.geometrySha256),
              nextRevision,
            ])
            .catch(proposalStateError);
        const consume = options?.consumeProposal;
        if (consume)
          await tx
            .query('SELECT public.consume_course_route_proposal($1,$2,$3,$4,$5)', [
              uuid.parse(consume.proposalId),
              courseId,
              z
                .number()
                .int()
                .min(1)
                .max(courseLimits.maxDraftRevision)
                .parse(consume.draftRevision),
              z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .parse(consume.geometrySha256),
              nextRevision,
            ])
            .catch(proposalStateError);
        await insertRevision(tx, courseId, nextRevision, revisionId, content, at);
        const advanced = await tx.query(
          `UPDATE course SET name=$3,head_revision=$4,revision_id=$5,updated_at=$6
           WHERE athlete_id=$1 AND course_id=$2 AND head_revision=$7 AND status='available'`,
          [tenantId, courseId, content.name, nextRevision, revisionId, at, expectedRevision],
        );
        if (advanced.rowCount !== 1) throw new CourseStateError('COURSE_REVISION_CONFLICT');
        await recordCommand(
          tx,
          key,
          request,
          { courseId, courseRevision: nextRevision },
          'course.revision_stored',
        );
        return readCourse(tx, courseId);
      });
    },

    remove(athleteId, rawCourseId, rawExpected) {
      const tenantId = uuid.parse(athleteId);
      const courseId = uuid.parse(rawCourseId);
      const expectedRevision = z.number().int().positive().parse(rawExpected);
      return database.tenant(tenantId, async (tx) => {
        // Deletion joins the serialisation every other write in this repository uses. It
        // did not before, which left it free to interleave with a store-and-reap on the
        // same tenant's searches and candidates. The lock order inside the database is
        // fixed separately (see `delete_course` in migration 036); this is the other half,
        // and it is the half that keeps the application's writers in one queue.
        await tenantLock(tx);
        // The expected revision is checked inside the function, which raises rather than
        // deleting when it does not match; a stale delete never removes a newer course.
        const deleted = await tx
          .query('SELECT public.delete_course($1,$2) AS deleted', [courseId, expectedRevision])
          .catch((error: unknown) => {
            if (error instanceof Error && error.message.includes('COURSE_REVISION_CONFLICT'))
              throw new CourseStateError('COURSE_REVISION_CONFLICT');
            throw error;
          });
        if (deleted.rows[0]?.['deleted'] !== true) throw new CourseNotFoundError();
        return { deleted: true };
      });
    },

    affectedByActivityDeletion(athleteId, rawActivityId) {
      const tenantId = uuid.parse(athleteId);
      const activityId = uuid.parse(rawActivityId);
      return database.tenant(tenantId, async (tx) => {
        // One statement, so the list and its digest describe the same snapshot. Reading
        // them separately let a course created in between appear in the digest but not in
        // the list the user confirmed.
        const rows = await tx.query(
          'SELECT courses,digest FROM public.activity_course_impact($1)',
          [activityId],
        );
        const impact = z
          .object({
            courses: z.array(
              z.object({
                course_id: uuid,
                name: courseNameSchema,
                head_revision: z.number().int().positive(),
              }),
            ),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(rows.rows[0]);
        const courses = impact.courses.map((row) => ({
          courseId: row.course_id,
          name: row.name,
          headRevision: row.head_revision,
        }));
        return activityDeletionImpactSchema.parse({
          activityId,
          digest: impact.digest,
          courses,
          total: courses.length,
        });
      });
    },
  };
}
