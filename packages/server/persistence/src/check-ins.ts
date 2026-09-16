import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  checkInCreateSchema,
  checkInUpdateSchema,
  checkInDeleteSchema,
  checkInSchema,
  checkInCommandResultSchema,
  checkInListSchema,
  checkInListQuerySchema,
  type CheckIn,
  type CheckInCreate,
  type CheckInUpdate,
  type CheckInDelete,
  type CheckInCommandResult,
  type CheckInList,
  type CheckInListQuery,
  type CheckInValues,
} from '@workout/contracts/check-ins';
import type { Database } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
export class CheckInNotFound extends Error {
  constructor() {
    super('CHECK_IN_NOT_FOUND');
  }
}
export class CheckInValidationError extends Error {
  readonly code = 'OBSERVED_AT_IN_FUTURE';
  constructor() {
    super('OBSERVED_AT_IN_FUTURE');
  }
}
export interface CheckInRepository {
  createCheckIn(athleteId: string, input: CheckInCreate): Promise<CheckInCommandResult>;
  updateCheckIn(athleteId: string, id: string, input: CheckInUpdate): Promise<CheckInCommandResult>;
  deleteCheckIn(athleteId: string, id: string, input: CheckInDelete): Promise<CheckInCommandResult>;
  getCheckIn(athleteId: string, id: string): Promise<CheckIn | null>;
  listCheckIns(athleteId: string, input: CheckInListQuery): Promise<CheckInList>;
}
function decode(row: Record<string, unknown>): CheckIn {
  return checkInSchema.parse({
    id: row['id'],
    revision: row['revision'],
    values: row['values_json'],
    localDate: row['local_date'],
    recordedAt: z.date().parse(row['recorded_at']).toISOString(),
    updatedAt: z.date().parse(row['updated_at']).toISOString(),
    source: 'user',
    method: 'self_report',
    definitionVersion: 'checkin-v1',
  });
}
function localDate(values: CheckInValues) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: values.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(values.observedAt));
  const value = (kind: string) => parts.find((p) => p.type === kind)?.value;
  return `${value('year')?.padStart(4, '0')}-${value('month')}-${value('day')}`;
}
const selection = 'id,revision,values_json,local_date::text,recorded_at,updated_at';
export function createCheckInRepository(
  database: Database,
  options: { now?: () => Date } = {},
): CheckInRepository {
  const now = options.now ?? (() => new Date());
  async function command(
    athleteId: string,
    id: string | null,
    action: 'create' | 'update' | 'delete',
    input: CheckInCreate | CheckInUpdate | CheckInDelete,
  ): Promise<CheckInCommandResult> {
    const values =
      'values' in input
        ? { ...input.values, observedAt: new Date(input.values.observedAt).toISOString() }
        : null;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ action, id, input: { ...input, ...(values ? { values } : {}) } }))
      .digest('hex');
    return database.tenant(athleteId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [athleteId]);
      const receipt = await tx.query(
        'SELECT request_hash,result FROM check_in_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
        [athleteId, input.idempotencyKey],
      );
      if (receipt.rows[0]) {
        if (receipt.rows[0]['request_hash'] !== requestHash)
          throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return checkInCommandResultSchema.parse(receipt.rows[0]['result']);
      }
      if (values && Date.parse(values.observedAt) > now().getTime() + 300000)
        throw new CheckInValidationError();
      const recordId = id ?? randomUUID();
      let revision = 1;
      if (action !== 'create') {
        const existing = await tx.query(
          'SELECT revision,deleted FROM check_in WHERE athlete_id=$1 AND id=$2',
          [athleteId, recordId],
        );
        const row = existing.rows[0];
        if (!row || row['deleted'] === true) throw new CheckInNotFound();
        if (!('expectedRevision' in input) || row['revision'] !== input.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        revision = z.number().int().parse(row['revision']) + 1;
      }
      if (action === 'delete') {
        await tx.query('DELETE FROM check_in_revision WHERE athlete_id=$1 AND check_in_id=$2', [
          athleteId,
          recordId,
        ]);
        await tx.query(
          'UPDATE check_in SET revision=$3,deleted=true,values_json=NULL,local_date=NULL,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
          [athleteId, recordId, revision],
        );
      } else if (values) {
        if (action === 'create')
          await tx.query(
            'INSERT INTO check_in(athlete_id,id,revision,values_json,local_date) VALUES($1,$2,$3,$4::jsonb,$5)',
            [athleteId, recordId, revision, JSON.stringify(values), localDate(values)],
          );
        else
          await tx.query(
            'UPDATE check_in SET revision=$3,values_json=$4::jsonb,local_date=$5,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
            [athleteId, recordId, revision, JSON.stringify(values), localDate(values)],
          );
        await tx.query(
          'INSERT INTO check_in_revision(athlete_id,check_in_id,revision,values_json,reason) VALUES($1,$2,$3,$4::jsonb,$5)',
          [
            athleteId,
            recordId,
            revision,
            JSON.stringify(values),
            'reason' in input ? input.reason : null,
          ],
        );
      }
      const head = await tx.query(
        'INSERT INTO check_in_collection_head(athlete_id,revision) VALUES($1,1) ON CONFLICT(athlete_id) DO UPDATE SET revision=check_in_collection_head.revision+1 RETURNING revision',
        [athleteId],
      );
      const result = checkInCommandResultSchema.parse({
        id: recordId,
        revision,
        collectionRevision: head.rows[0]?.['revision'],
        deleted: action === 'delete',
      });
      await tx.query(
        'INSERT INTO check_in_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
        [athleteId, input.idempotencyKey, requestHash, JSON.stringify(result)],
      );
      await enqueue(tx, {
        id: randomUUID(),
        idempotencyKey: `checkin:${recordId}:${revision}`,
        topic: 'checkin.changed',
        payload: {
          checkInId: recordId,
          revision,
          collectionRevision: result.collectionRevision,
          action,
        },
      });
      return result;
    });
  }
  return {
    createCheckIn: async (athleteId, input) =>
      command(athleteId, null, 'create', checkInCreateSchema.parse(input)),
    updateCheckIn: async (athleteId, id, input) =>
      command(athleteId, z.uuid().parse(id), 'update', checkInUpdateSchema.parse(input)),
    deleteCheckIn: async (athleteId, id, input) =>
      command(athleteId, z.uuid().parse(id), 'delete', checkInDeleteSchema.parse(input)),
    async getCheckIn(athleteId, id) {
      z.uuid().parse(id);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `SELECT ${selection} FROM check_in WHERE athlete_id=$1 AND id=$2 AND NOT deleted`,
          [athleteId, id],
        );
        return result.rows[0] ? decode(result.rows[0]) : null;
      });
    },
    async listCheckIns(athleteId, input) {
      const query = checkInListQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        // One statement gives records, count and collection revision the same MVCC snapshot.
        const result = await tx.query(
          `WITH selected AS MATERIALIZED (SELECT ${selection} FROM check_in WHERE athlete_id=$1 AND NOT deleted AND local_date >= $2::date AND local_date < $3::date) SELECT (SELECT coalesce(jsonb_agg(r ORDER BY r.local_date DESC,r.id),'[]'::jsonb) FROM (SELECT * FROM selected ORDER BY local_date DESC,id LIMIT $4 OFFSET $5) r) AS items,(SELECT count(*)::int FROM selected) AS total,coalesce((SELECT revision FROM check_in_collection_head WHERE athlete_id=$1),0) AS revision`,
          [athleteId, query.from, query.toExclusive, query.limit, query.offset],
        );
        const row = result.rows[0];
        const items = z.array(z.record(z.string(), z.unknown())).parse(row?.['items']);
        return checkInListSchema.parse({
          items: items.map((item) =>
            decode({
              ...item,
              recorded_at: new Date(z.string().parse(item['recorded_at'])),
              updated_at: new Date(z.string().parse(item['updated_at'])),
            }),
          ),
          total: row?.['total'],
          collectionRevision: row?.['revision'],
        });
      });
    },
  };
}
