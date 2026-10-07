import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  raceCommandResultSchema,
  raceEventCreateCommandSchema,
  raceEventDeleteCommandSchema,
  raceEventUpdateCommandSchema,
  raceResultCreateCommandSchema,
  raceResultDeleteCommandSchema,
  raceResultUpdateCommandSchema,
  trainingBestCreateCommandSchema,
  trainingBestDeleteCommandSchema,
  trainingBestUpdateCommandSchema,
  type RaceCommandResult,
  type RaceEventCreateCommand,
  type RaceEventDeleteCommand,
  type RaceEventUpdateCommand,
  type RaceResultCreateCommand,
  type RaceResultDeleteCommand,
  type RaceResultUpdateCommand,
  type TrainingBestCreateCommand,
  type TrainingBestDeleteCommand,
  type TrainingBestUpdateCommand,
} from '@workout/contracts/race-commands';
import {
  raceEventSchema,
  raceResultSchema,
  trainingBestSchema,
  type RaceEvent,
  type RaceResult,
  type TrainingBest,
} from '@workout/contracts/races';
import type { Database, Transaction } from './database.js';
import { lockAppAdmission, requireAppAdmission } from './app-admission.js';
import {
  raceCollectionStampSchema,
  raceListQuerySchema,
  raceEventListPageSchema,
  raceResultListPageSchema,
  trainingBestListPageSchema,
  type RaceListQueryInput,
  type RaceEventListPage,
  type RaceResultListPage,
  type TrainingBestListPage,
} from '@workout/contracts/race-queries';
import { enqueue, PersistenceConflict } from './outbox.js';
import {
  projectStoredRaceResultLegacyRead,
  RaceResultLegacyProjectionError,
} from './race-result-legacy-projection.js';

export class RaceRepositoryError extends Error {
  constructor(
    readonly code:
      | 'RACE_NOT_FOUND'
      | 'RACE_REFERENCE_UNAVAILABLE'
      | 'RACE_PLAN_IMPACT_REQUIRED'
      | 'RACE_REVISION_LIMIT'
      | 'RACE_CURSOR_KIND_MISMATCH'
      | 'RACE_CURSOR_STALE'
      | 'RACE_CURSOR_UNAVAILABLE',
  ) {
    super(code);
  }
}
export interface RaceRepository {
  listRaceEvents(athleteId: string, input?: RaceListQueryInput): Promise<RaceEventListPage>;
  listRaceResults(athleteId: string, input?: RaceListQueryInput): Promise<RaceResultListPage>;
  listTrainingBests(athleteId: string, input?: RaceListQueryInput): Promise<TrainingBestListPage>;
  createRaceEvent(athleteId: string, input: RaceEventCreateCommand): Promise<RaceCommandResult>;
  updateRaceEvent(
    athleteId: string,
    id: string,
    input: RaceEventUpdateCommand,
  ): Promise<RaceCommandResult>;
  deleteRaceEvent(
    athleteId: string,
    id: string,
    input: RaceEventDeleteCommand,
  ): Promise<RaceCommandResult>;
  getRaceEvent(athleteId: string, id: string): Promise<RaceEvent | null>;
  createRaceResult(athleteId: string, input: RaceResultCreateCommand): Promise<RaceCommandResult>;
  updateRaceResult(
    athleteId: string,
    id: string,
    input: RaceResultUpdateCommand,
  ): Promise<RaceCommandResult>;
  deleteRaceResult(
    athleteId: string,
    id: string,
    input: RaceResultDeleteCommand,
  ): Promise<RaceCommandResult>;
  getRaceResult(athleteId: string, id: string): Promise<RaceResult | null>;
  createTrainingBest(
    athleteId: string,
    input: TrainingBestCreateCommand,
  ): Promise<RaceCommandResult>;
  updateTrainingBest(
    athleteId: string,
    id: string,
    input: TrainingBestUpdateCommand,
  ): Promise<RaceCommandResult>;
  deleteTrainingBest(
    athleteId: string,
    id: string,
    input: TrainingBestDeleteCommand,
  ): Promise<RaceCommandResult>;
  getTrainingBest(athleteId: string, id: string): Promise<TrainingBest | null>;
}
const tables = {
  'race-event': 'race_event',
  'race-result': 'race_result',
  'training-best': 'training_best',
} as const;
type Kind = keyof typeof tables;
type Command =
  | RaceEventCreateCommand
  | RaceEventUpdateCommand
  | RaceResultCreateCommand
  | RaceResultUpdateCommand
  | TrainingBestCreateCommand
  | TrainingBestUpdateCommand;
const uuid = raceEventSchema.shape.id;
const maxRevision = 2147483647;

const legacyResultReadBytes = 16 * 1024;
const resultReadScalar = z.strictObject({
  count: z.number().int().min(0).max(101),
  bytes: z
    .string()
    .max(20)
    .regex(/^[0-9]+$/),
  maximum: z
    .string()
    .max(20)
    .regex(/^[0-9]+$/),
});
async function requireBoundedLegacyResults(
  tx: Transaction,
  id: string | null,
  after: string | null,
  limit: number,
) {
  // Protect the driver before fetching JSON. Call while holding the same tenant
  // command lock as result writes and privacy redaction; no consent is required.
  const result = await tx.query(
    `SELECT count(*)::int AS count,coalesce(sum(n),0)::text AS bytes,coalesce(max(n),0)::text AS maximum FROM
    (SELECT octet_length(values_json::text) AS n FROM race_result WHERE athlete_id=$1 AND NOT deleted
    AND ($2::uuid IS NULL OR id=$2::uuid) AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id ASC LIMIT $4) bounded`,
    [tx.athleteId, id, after, limit],
  );
  if (result.rows.length !== 1) throw new RaceResultLegacyProjectionError();
  const scalar = resultReadScalar.parse(result.rows[0]);
  if (
    scalar.count > limit ||
    BigInt(scalar.maximum) > BigInt(legacyResultReadBytes) ||
    BigInt(scalar.bytes) > BigInt(limit * legacyResultReadBytes)
  )
    throw new RaceResultLegacyProjectionError();
}
function legacyResultRow(row: Record<string, unknown>) {
  return projectStoredRaceResultLegacyRead({
    id: row['id'],
    revision: row['revision'],
    values: row['values_json'],
  });
}

async function requireActivity(tx: Transaction, activityId: string) {
  const rows = await tx.query(
    'SELECT id FROM activity_canonical WHERE athlete_id=$1 AND id=$2 AND NOT deleted FOR SHARE',
    [tx.athleteId, activityId],
  );
  if (!rows.rows[0]) throw new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE');
}
async function requireReferences(tx: Transaction, record: RaceEvent | RaceResult | TrainingBest) {
  if ('planVersionId' in record) {
    if (record.planVersionId !== null) {
      // Plan snapshots are immutable. The tenant transaction already fences account erasure.
      const rows = await tx.query(
        'SELECT id::text FROM plan_snapshot WHERE athlete_id=$1 AND id::text=$2',
        [tx.athleteId, record.planVersionId],
      );
      if (!rows.rows[0]) throw new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE');
    }
    if (record.course !== null) {
      // Lock the parent whose deletion/reclamation removes immutable revisions. Never resolve
      // a mutable head into a new Course ref, and never fetch geometry into this ledger.
      const rows = await tx.query(
        "SELECT course_id FROM course WHERE athlete_id=$1 AND course_id=$2 AND status='available' FOR SHARE",
        [tx.athleteId, record.course.courseId],
      );
      if (!rows.rows[0]) throw new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE');
      const revision = await tx.query(
        'SELECT revision_id FROM course_revision WHERE athlete_id=$1 AND course_id=$2 AND course_revision=$3 AND revision_id=$4',
        [
          tx.athleteId,
          record.course.courseId,
          record.course.courseRevision,
          record.course.revisionId,
        ],
      );
      if (!revision.rows[0]) throw new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE');
    }
  } else if (record.kind === 'race-result') {
    if (record.raceEventId !== null) {
      const rows = await tx.query(
        'SELECT id FROM race_event WHERE athlete_id=$1 AND id=$2 AND NOT deleted FOR SHARE',
        [tx.athleteId, record.raceEventId],
      );
      if (!rows.rows[0]) throw new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE');
    }
    if (record.linkedActivityId !== null) await requireActivity(tx, record.linkedActivityId);
  } else if (record.source.kind === 'activity') {
    await requireActivity(tx, record.source.activityId);
  }
}

/** Commands save only race ledgers. Plan impact, official verification and PB ranking
 * are separate use cases; a user claim never inherits an earlier verification fact.
 */
export function createRaceRepository(
  database: Database,
  options: { now?: () => Date; createId?: () => string } = {},
): RaceRepository {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  async function write(
    athleteId: string,
    kind: Kind,
    id: string | null,
    input: Command,
  ): Promise<RaceCommandResult> {
    const { idempotencyKey, ...body } = input;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind, action: id === null ? 'create' : 'update', id, body }))
      .digest('hex');
    const table = tables[kind];
    return database.tenant(athleteId, async (tx) => {
      // Shared with the existing Course/Activity/Plan command lock. Together with row
      // locks this validates referenced liveness before the atomic ledger commit.
      await lockAppAdmission(tx);
      const receipt = await tx.query(
        'SELECT request_hash,result FROM race_command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
        [athleteId, idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0]['request_hash'] !== requestHash)
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return raceCommandResultSchema.parse(receipt.rows[0]['result']);
      }
      // Completed receipts survive revocation; fresh core plan/actual writes do not.
      await requireAppAdmission(tx);
      let previousRevision = 0;
      if (id !== null) {
        const rows = await tx.query(
          `SELECT revision,values_json FROM ${table} WHERE athlete_id=$1 AND id=$2 AND NOT deleted FOR UPDATE`,
          [athleteId, id],
        );
        const previous = rows.rows[0];
        if (!previous) throw new RaceRepositoryError('RACE_NOT_FOUND');
        previousRevision = raceCommandResultSchema.shape.revision.parse(previous['revision']);
        if (!('expectedRevision' in input) || input.expectedRevision !== previousRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (kind === 'race-event') {
          const prior = raceEventSchema.parse({
            ...z.record(z.string(), z.unknown()).parse(previous['values_json']),
            id,
            revision: previousRevision,
          });
          const next = raceEventUpdateCommandSchema.parse(input).values;
          if (
            prior.localDate !== next.localDate &&
            (prior.planVersionId !== null || next.planVersionId !== null)
          )
            throw new RaceRepositoryError('RACE_PLAN_IMPACT_REQUIRED');
        }
      }
      const heads = await tx.query(
        'SELECT revision FROM race_collection_head WHERE athlete_id=$1 AND kind=$2',
        [athleteId, kind],
      );
      const head = heads.rows[0]
        ? raceCommandResultSchema.shape.revision.parse(heads.rows[0]['revision'])
        : 0;
      if (previousRevision >= maxRevision || head >= maxRevision)
        throw new RaceRepositoryError('RACE_REVISION_LIMIT');
      const result = raceCommandResultSchema.parse({
        id: id ?? createId(),
        revision: previousRevision + 1,
      });
      let record: RaceEvent | RaceResult | TrainingBest;
      if (kind === 'race-event')
        record = raceEventSchema.parse({
          ...raceEventCreateCommandSchema.parse({ idempotencyKey, values: input.values }).values,
          ...result,
        });
      else if (kind === 'race-result') {
        const values = raceResultCreateCommandSchema.parse({
          idempotencyKey,
          values: input.values,
        }).values;
        const source =
          values.source.kind === 'official'
            ? { ...values.source, verifiedAt: null }
            : values.source;
        record = raceResultSchema.parse({ ...values, source, ...result });
      } else
        record = trainingBestSchema.parse({
          ...trainingBestCreateCommandSchema.parse({ idempotencyKey, values: input.values }).values,
          ...result,
        });
      await requireReferences(tx, record);
      const { id: _id, revision: _revision, ...values } = record;
      const timestamp = z.date().parse(now());
      if (id === null)
        await tx.query(
          `INSERT INTO ${table}(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$5)`,
          [athleteId, result.id, result.revision, JSON.stringify(values), timestamp],
        );
      else
        await tx.query(
          `UPDATE ${table} SET revision=$3,values_json=$4::jsonb,updated_at=$5 WHERE athlete_id=$1 AND id=$2`,
          [athleteId, result.id, result.revision, JSON.stringify(values), timestamp],
        );
      await tx.query(
        `INSERT INTO ${table}_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,$3,$4::jsonb,$5)`,
        [athleteId, result.id, result.revision, JSON.stringify(values), timestamp],
      );
      await tx.query(
        'INSERT INTO race_collection_head(athlete_id,kind,revision) VALUES($1,$2,$3) ON CONFLICT(athlete_id,kind) DO UPDATE SET revision=EXCLUDED.revision',
        [athleteId, kind, head + 1],
      );
      await tx.query(
        'INSERT INTO race_command_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
        [athleteId, idempotencyKey, requestHash, JSON.stringify(result)],
      );
      await enqueue(tx, {
        id: createId(),
        idempotencyKey: `race:${kind}:${result.id}:${result.revision}`,
        topic: `race.${kind}_changed`,
        payload: {
          ...result,
          kind,
          collectionRevision: head + 1,
          action: id === null ? 'create' : 'update',
        },
      });
      return result;
    });
  }
  async function remove(
    athleteId: string,
    kind: Kind,
    id: string,
    input: RaceEventDeleteCommand | RaceResultDeleteCommand | TrainingBestDeleteCommand,
  ): Promise<RaceCommandResult> {
    const { idempotencyKey, ...body } = input;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ kind, action: 'delete', id, body }))
      .digest('hex');
    return database.tenant(athleteId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
      const receipt = await tx.query(
        'SELECT request_hash,result FROM race_command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
        [athleteId, idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0]['request_hash'] !== requestHash)
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return raceCommandResultSchema.parse(receipt.rows[0]['result']);
      }
      let result: RaceCommandResult;
      try {
        const rows = await tx.query('SELECT public.delete_race_entity($1,$2,$3) AS result', [
          kind,
          id,
          input.expectedRevision,
        ]);
        result = raceCommandResultSchema.parse(rows.rows[0]?.['result']);
      } catch (error) {
        if (error instanceof Error && error.message === 'RACE_NOT_FOUND')
          throw new RaceRepositoryError('RACE_NOT_FOUND');
        if (error instanceof Error && error.message === 'REVISION_CONFLICT')
          throw new PersistenceConflict('REVISION_CONFLICT');
        throw error;
      }
      await tx.query(
        'INSERT INTO race_command_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
        [athleteId, idempotencyKey, requestHash, JSON.stringify(result)],
      );
      return result;
    });
  }
  async function read<T>(
    athleteId: string,
    table: (typeof tables)[Kind],
    id: string,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const target = uuid.parse(id);
    return database.tenant(athleteId, async (tx) => {
      if (table === tables['race-result']) {
        await lockAppAdmission(tx);
        await requireBoundedLegacyResults(tx, target, null, 1);
      }
      const rows = await tx.query(
        `SELECT id,revision,values_json FROM ${table} WHERE athlete_id=$1 AND id=$2 AND NOT deleted`,
        [athleteId, target],
      );
      if (table === tables['race-result'] && rows.rows.length > 1)
        throw new RaceResultLegacyProjectionError();
      const row = rows.rows[0];
      if (row && table === tables['race-result']) return schema.parse(legacyResultRow(row));
      // No joins to unavailable source content: only the stored, pinned identifiers survive.
      return row
        ? schema.parse({
            ...z.record(z.string(), z.unknown()).parse(row['values_json']),
            id: row['id'],
            revision: row['revision'],
          })
        : null;
    });
  }
  async function list<T, P>(
    athleteId: string,
    kind: Kind,
    input: RaceListQueryInput | undefined,
    itemSchema: z.ZodType<T>,
    pageSchema: z.ZodType<P>,
  ): Promise<P> {
    const query = raceListQuerySchema.parse(input ?? {});
    if (query.cursor !== null && query.cursor.kind !== kind)
      throw new RaceRepositoryError('RACE_CURSOR_KIND_MISMATCH');
    return database.tenant(athleteId, async (tx) => {
      // Commands and privacy redaction share lock0: the collection stamp and rows
      // must describe the same committed state, including terminal revision redaction.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
      const heads = await tx.query(
        'SELECT revision,privacy_generation::text AS "privacyGeneration" FROM race_collection_head WHERE athlete_id=$1 AND kind=$2',
        [athleteId, kind],
      );
      const collection = heads.rows[0] ? raceCollectionStampSchema.parse(heads.rows[0]) : null;
      if (query.cursor !== null) {
        // Cursor shape is a position, never ownership authority. Check live membership
        // under the authenticated tenant even when a foreign collection tuple matches.
        if (
          collection === null ||
          collection.revision !== query.cursor.collection.revision ||
          collection.privacyGeneration !== query.cursor.collection.privacyGeneration
        )
          throw new RaceRepositoryError('RACE_CURSOR_STALE');
        const anchor = await tx.query(
          `SELECT id FROM ${tables[kind]} WHERE athlete_id=$1 AND id=$2 AND NOT deleted`,
          [athleteId, query.cursor.afterId],
        );
        if (!anchor.rows[0]) throw new RaceRepositoryError('RACE_CURSOR_UNAVAILABLE');
      }
      if (kind === 'race-result')
        await requireBoundedLegacyResults(tx, null, query.cursor?.afterId ?? null, query.limit + 1);
      const rows = await tx.query(
        `SELECT id,revision,values_json FROM ${tables[kind]} WHERE athlete_id=$1 AND NOT deleted AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id ASC LIMIT $3`,
        [athleteId, query.cursor?.afterId ?? null, query.limit + 1],
      );
      if (kind === 'race-result' && rows.rows.length > query.limit + 1)
        throw new RaceResultLegacyProjectionError();
      const pageRows = rows.rows.slice(0, query.limit);
      const items = pageRows.map((row) =>
        kind === 'race-result'
          ? itemSchema.parse(legacyResultRow(row))
          : itemSchema.parse({
              ...z.record(z.string(), z.unknown()).parse(row['values_json']),
              id: row['id'],
              revision: row['revision'],
            }),
      );
      const last = pageRows.at(-1);
      return pageSchema.parse({
        schemaVersion: 1,
        kind,
        sort: 'id-asc',
        collection,
        items,
        nextCursor:
          rows.rows.length > query.limit && last && collection !== null
            ? { kind, collection, afterId: last['id'] }
            : null,
      });
    });
  }
  return {
    listRaceEvents: (athleteId, input) =>
      list(athleteId, 'race-event', input, raceEventSchema, raceEventListPageSchema),
    listRaceResults: (athleteId, input) =>
      list(athleteId, 'race-result', input, raceResultSchema, raceResultListPageSchema),
    listTrainingBests: (athleteId, input) =>
      list(athleteId, 'training-best', input, trainingBestSchema, trainingBestListPageSchema),
    createRaceEvent: async (athleteId, input) =>
      write(athleteId, 'race-event', null, raceEventCreateCommandSchema.parse(input)),
    updateRaceEvent: async (athleteId, id, input) =>
      write(athleteId, 'race-event', uuid.parse(id), raceEventUpdateCommandSchema.parse(input)),
    deleteRaceEvent: async (athleteId, id, input) =>
      remove(athleteId, 'race-event', uuid.parse(id), raceEventDeleteCommandSchema.parse(input)),
    getRaceEvent: (athleteId, id) => read(athleteId, tables['race-event'], id, raceEventSchema),
    createRaceResult: async (athleteId, input) =>
      write(athleteId, 'race-result', null, raceResultCreateCommandSchema.parse(input)),
    updateRaceResult: async (athleteId, id, input) =>
      write(athleteId, 'race-result', uuid.parse(id), raceResultUpdateCommandSchema.parse(input)),
    deleteRaceResult: async (athleteId, id, input) =>
      remove(athleteId, 'race-result', uuid.parse(id), raceResultDeleteCommandSchema.parse(input)),
    getRaceResult: (athleteId, id) => read(athleteId, tables['race-result'], id, raceResultSchema),
    createTrainingBest: async (athleteId, input) =>
      write(athleteId, 'training-best', null, trainingBestCreateCommandSchema.parse(input)),
    updateTrainingBest: async (athleteId, id, input) =>
      write(
        athleteId,
        'training-best',
        uuid.parse(id),
        trainingBestUpdateCommandSchema.parse(input),
      ),
    deleteTrainingBest: async (athleteId, id, input) =>
      remove(
        athleteId,
        'training-best',
        uuid.parse(id),
        trainingBestDeleteCommandSchema.parse(input),
      ),
    getTrainingBest: (athleteId, id) =>
      read(athleteId, tables['training-best'], id, trainingBestSchema),
  };
}
