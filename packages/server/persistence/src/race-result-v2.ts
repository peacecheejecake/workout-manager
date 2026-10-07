import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  raceResultCreateV2CommandSchema,
  raceResultUpdateV2CommandSchema,
  raceResultReadV2CommandSchema,
  raceResultListV2QuerySchema,
  raceResultCompatibleStorageLifecycleSchema,
  raceResultCompatibleReadSchema,
  raceResultV2Schema,
  raceResultMixedListV2PageSchema,
  RACE_RESULT_V2_MAX_BYTES,
  type RaceResultCompatibleRead,
  type RaceResultMixedListV2Page,
} from '@workout/contracts/race-result-v2';
import { raceCommandResultSchema, type RaceCommandResult } from '@workout/contracts/race-commands';
import { raceCollectionStampSchema } from '@workout/contracts/race-queries';
import type { Database, Transaction } from './database.js';
import { lockAppAdmission, requireAppAdmission } from './app-admission.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { RaceRepositoryError } from './races.js';
import { prepareRaceResultProofs, projectRaceResultProofsIn } from './race-result-proofs.js';

export class RaceResultV2Error extends Error {
  constructor(readonly code: 'RACE_RESULT_INVALID_SOURCE' | 'RACE_RESULT_READ_LIMIT') {
    super(code);
  }
}
const revision = raceCommandResultSchema.shape.revision;
const rowSchema = z.strictObject({
  id: z.uuid(),
  revision,
  values_json: z.record(z.string(), z.unknown()),
});
const bytesSchema = z.strictObject({
  count: z.number().int().min(0).max(101),
  bytes: z.string().regex(/^[0-9]+$/),
  maximum: z.string().regex(/^[0-9]+$/),
});
function boundedRows(rows: readonly unknown[]) {
  if (rows.length > 101) throw new RaceResultV2Error('RACE_RESULT_READ_LIMIT');
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded, 'utf8') > RACE_RESULT_V2_MAX_BYTES + 256
    )
      throw new RaceResultV2Error('RACE_RESULT_READ_LIMIT');
  }
}
async function projection(tx: Transaction, unknownRow: unknown): Promise<RaceResultCompatibleRead> {
  const row = rowSchema.parse(unknownRow);
  // Identity and revision are relational fields, never trusted values_json aliases.
  if ('id' in row.values_json || 'revision' in row.values_json)
    throw new RaceResultV2Error('RACE_RESULT_INVALID_SOURCE');
  const saved = raceResultCompatibleStorageLifecycleSchema.parse({
    ...row.values_json,
    id: row.id,
    revision: row.revision,
  });
  if (!('schemaVersion' in saved)) return saved;
  return raceResultCompatibleReadSchema.parse({
    ...saved,
    proofs: await projectRaceResultProofsIn(tx, saved.proofs),
  });
}
async function references(
  tx: Transaction,
  values: { raceEventId: string | null; linkedActivityId: string | null },
) {
  if (values.raceEventId !== null) {
    const result = await tx.query(
      'SELECT id FROM race_event WHERE athlete_id=$1 AND id=$2 AND NOT deleted FOR SHARE',
      [tx.athleteId, values.raceEventId],
    );
    if (result.rows.length !== 1) throw new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE');
  }
  if (values.linkedActivityId !== null) {
    const result = await tx.query(
      'SELECT id FROM activity_canonical WHERE athlete_id=$1 AND id=$2 AND NOT deleted FOR SHARE',
      [tx.athleteId, values.linkedActivityId],
    );
    if (result.rows.length !== 1) throw new RaceRepositoryError('RACE_REFERENCE_UNAVAILABLE');
  }
}
/** Explicit V2 factory; no API activation or official verification/PB authority.
 * Proof resolver and SQL109 enforce source correspondence, not attachment truth.
 * Retained reads/replays survive app withdrawal; only fresh writes require consent. */
export function createRaceResultV2Repository(
  database: Database,
  options: { now?: () => Date; createId?: () => string } = {},
) {
  const now = options.now ?? (() => new Date()),
    createId = options.createId ?? randomUUID;
  async function write(
    athleteId: string,
    id: string | null,
    raw: unknown,
  ): Promise<RaceCommandResult> {
    const input =
      id === null
        ? raceResultCreateV2CommandSchema.parse(raw)
        : raceResultUpdateV2CommandSchema.parse(raw);
    const { idempotencyKey, ...body } = input;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          kind: 'race-result',
          action: id === null ? 'create-v2' : 'update-v2',
          id,
          body,
        }),
      )
      .digest('hex');
    return database.tenant(athleteId, async (tx) => {
      await lockAppAdmission(tx);
      const receipt = await tx.query(
        'SELECT request_hash,result FROM race_command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
        [athleteId, idempotencyKey],
      );
      if (receipt.rows.length > 1) throw new RaceResultV2Error('RACE_RESULT_INVALID_SOURCE');
      if (receipt.rows[0]) {
        if (receipt.rows[0]['request_hash'] !== requestHash)
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return raceCommandResultSchema.parse(receipt.rows[0]['result']);
      }
      await requireAppAdmission(tx);
      let previous = 0;
      if (id !== null) {
        const result = await tx.query(
          'SELECT revision FROM race_result WHERE athlete_id=$1 AND id=$2 AND NOT deleted FOR UPDATE',
          [athleteId, id],
        );
        if (result.rows.length !== 1) throw new RaceRepositoryError('RACE_NOT_FOUND');
        previous = revision.parse(result.rows[0]?.['revision']);
        if (!('expectedRevision' in input) || input.expectedRevision !== previous)
          throw new PersistenceConflict('REVISION_CONFLICT');
      }
      const heads = await tx.query(
        "SELECT revision FROM race_collection_head WHERE athlete_id=$1 AND kind='race-result'",
        [athleteId],
      );
      if (heads.rows.length > 1) throw new RaceResultV2Error('RACE_RESULT_INVALID_SOURCE');
      const head = heads.rows[0] ? revision.parse(heads.rows[0]['revision']) : 0;
      if (previous >= 2147483647 || head >= 2147483647)
        throw new RaceRepositoryError('RACE_REVISION_LIMIT');
      await references(tx, input.values);
      const proofs = await prepareRaceResultProofs(tx, input.values.proofs);
      const result = raceCommandResultSchema.parse({
        id: id ?? createId(),
        revision: previous + 1,
      });
      const saved = raceResultV2Schema.parse({
        ...input.values,
        schemaVersion: 2,
        ...result,
        proofs,
      });
      const { id: _id, revision: _revision, ...values } = saved;
      const timestamp = z.date().parse(now());
      if (id === null)
        await tx.query(
          'INSERT INTO race_result(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$5)',
          [athleteId, result.id, result.revision, JSON.stringify(values), timestamp],
        );
      else {
        const updated = await tx.query(
          'UPDATE race_result SET revision=$3,values_json=$4::jsonb,updated_at=$5 WHERE athlete_id=$1 AND id=$2 AND revision=$6 AND NOT deleted',
          [athleteId, result.id, result.revision, JSON.stringify(values), timestamp, previous],
        );
        if (updated.rowCount !== 1) throw new PersistenceConflict('REVISION_CONFLICT');
      }
      await tx.query(
        'INSERT INTO race_result_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',
        [athleteId, result.id, result.revision, JSON.stringify(values), timestamp],
      );
      await tx.query(
        "INSERT INTO race_collection_head(athlete_id,kind,revision) VALUES($1,'race-result',$2) ON CONFLICT(athlete_id,kind) DO UPDATE SET revision=EXCLUDED.revision",
        [athleteId, head + 1],
      );
      await tx.query(
        'INSERT INTO race_command_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
        [athleteId, idempotencyKey, requestHash, JSON.stringify(result)],
      );
      await enqueue(tx, {
        id: createId(),
        idempotencyKey: `race:race-result:${result.id}:${result.revision}`,
        topic: 'race.race-result_changed',
        payload: {
          ...result,
          kind: 'race-result',
          collectionRevision: head + 1,
          action: id === null ? 'create' : 'update',
        },
      });
      return result;
    });
  }
  return {
    create(athleteId: string, input: unknown) {
      return write(athleteId, null, input);
    },
    update(athleteId: string, id: string, input: unknown) {
      return write(athleteId, raceResultReadV2CommandSchema.shape.id.parse(id), input);
    },
    read(athleteId: string, input: unknown): Promise<RaceResultCompatibleRead | null> {
      const command = raceResultReadV2CommandSchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        await lockAppAdmission(tx); // Lock only; no new-processing permission for retained read.
        await preflight(tx, command.id, null, 1);
        const rows = await tx.query(
          'SELECT id,revision,values_json FROM race_result WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
          [athleteId, command.id],
        );
        if (rows.rows.length > 1) throw new RaceResultV2Error('RACE_RESULT_INVALID_SOURCE');
        boundedRows(rows.rows);
        return rows.rows[0] ? projection(tx, rows.rows[0]) : null;
      });
    },
    list(athleteId: string, input: unknown): Promise<RaceResultMixedListV2Page> {
      const query = raceResultListV2QuerySchema.parse(input);
      if (query.cursor !== null && query.cursor.kind !== 'race-result')
        throw new RaceRepositoryError('RACE_CURSOR_KIND_MISMATCH');
      return database.tenant(athleteId, async (tx) => {
        await lockAppAdmission(tx);
        const heads = await tx.query(
          'SELECT revision,privacy_generation::text AS "privacyGeneration" FROM race_collection_head WHERE athlete_id=$1 AND kind=$2',
          [athleteId, 'race-result'],
        );
        if (heads.rows.length > 1) throw new RaceResultV2Error('RACE_RESULT_INVALID_SOURCE');
        const collection = heads.rows[0] ? raceCollectionStampSchema.parse(heads.rows[0]) : null;
        if (query.cursor !== null) {
          if (
            !collection ||
            collection.revision !== query.cursor.collection.revision ||
            collection.privacyGeneration !== query.cursor.collection.privacyGeneration
          )
            throw new RaceRepositoryError('RACE_CURSOR_STALE');
          const anchor = await tx.query(
            'SELECT id FROM race_result WHERE athlete_id=$1 AND id=$2 AND NOT deleted',
            [athleteId, query.cursor.afterId],
          );
          if (anchor.rows.length !== 1) throw new RaceRepositoryError('RACE_CURSOR_UNAVAILABLE');
        }
        await preflight(tx, null, query.cursor?.afterId ?? null, query.limit + 1);
        const rows = await tx.query(
          'SELECT id,revision,values_json FROM race_result WHERE athlete_id=$1 AND NOT deleted AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id ASC LIMIT $3',
          [athleteId, query.cursor?.afterId ?? null, query.limit + 1],
        );
        if (rows.rows.length > query.limit + 1)
          throw new RaceResultV2Error('RACE_RESULT_READ_LIMIT');
        boundedRows(rows.rows);
        const items: RaceResultCompatibleRead[] = [];
        for (const row of rows.rows.slice(0, query.limit)) items.push(await projection(tx, row));
        return raceResultMixedListV2PageSchema.parse({
          schemaVersion: 2,
          kind: 'race-result',
          sort: 'id-asc',
          collection,
          items,
          nextCursor:
            rows.rows.length > query.limit && items.at(-1) && collection
              ? { kind: 'race-result', collection, afterId: items.at(-1)?.id }
              : null,
        });
      });
    },
  };
}
async function preflight(tx: Transaction, id: string | null, after: string | null, limit: number) {
  // Scalar bounds BEFORE driver fetches protected JSON. Limit+1 is explicit, not truncation.
  const result = await tx.query(
    `SELECT count(*)::int AS count,coalesce(sum(n),0)::text AS bytes,coalesce(max(n),0)::text AS maximum FROM
    (SELECT octet_length(values_json::text)+128 AS n FROM race_result WHERE athlete_id=$1 AND NOT deleted
    AND ($2::uuid IS NULL OR id=$2::uuid) AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id ASC LIMIT $4) bounded`,
    [tx.athleteId, id, after, limit],
  );
  if (result.rows.length !== 1) throw new RaceResultV2Error('RACE_RESULT_INVALID_SOURCE');
  const scalar = bytesSchema.parse(result.rows[0]);
  if (
    scalar.count > limit ||
    BigInt(scalar.maximum) > BigInt(RACE_RESULT_V2_MAX_BYTES) ||
    BigInt(scalar.bytes) > BigInt(101 * RACE_RESULT_V2_MAX_BYTES)
  )
    throw new RaceResultV2Error('RACE_RESULT_READ_LIMIT');
}
export type RaceResultV2Repository = ReturnType<typeof createRaceResultV2Repository>;
