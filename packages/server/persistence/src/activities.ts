import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  activitySchema,
  activityValuesSchema,
  activityOverlaySchema,
  activityOverlayWriteSchema,
  activityDeleteSchema,
  activityListQuerySchema,
  activityImportResultSchema,
  importActivitySchema,
  type Activity,
  type ActivityImport,
  type ActivityImportResult,
  type ActivityList,
  type ActivitySummary,
  type ActivityOverlayWrite,
} from '@workout/contracts/activity';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

export class ActivityNotFound extends Error {
  constructor() {
    super('ACTIVITY_NOT_FOUND');
  }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const lock = (tx: Transaction) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tx.athleteId]);
const selectActivity = `SELECT c.id,c.revision,c.original,s.kind,s.source_id,s.source_revision,s.content_hash,coalesce(o.values_json,'{}'::jsonb) AS overlay FROM activity_canonical c JOIN activity_source_head s ON s.athlete_id=c.athlete_id AND s.activity_id=c.id LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND NOT c.deleted`;
function decode(row: Record<string, unknown>): Activity {
  const original = activityValuesSchema.parse(row['original']);
  const overlay = activityOverlaySchema.parse(row['overlay']);
  return activitySchema.parse({
    id: row['id'],
    revision: row['revision'],
    source: {
      kind: row['kind'],
      sourceId: row['source_id'],
      revision: row['source_revision'],
      contentHash: row['content_hash'],
    },
    original,
    overlay,
    effective: {
      ...original,
      ...(overlay.title === undefined ? {} : { title: overlay.title }),
      ...(overlay.distanceMeters === undefined ? {} : { distanceMeters: overlay.distanceMeters }),
      ...(overlay.durationSeconds === undefined
        ? {}
        : { durationSeconds: overlay.durationSeconds, durationKind: overlay.durationKind }),
    },
  });
}
async function detail(tx: Transaction, id: string) {
  const rows = await tx.query(`${selectActivity} AND c.id=$2`, [tx.athleteId, id]);
  return rows.rows[0] ? decode(rows.rows[0]) : null;
}
async function event(tx: Transaction, id: string, revision: number, action: string) {
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: `activity:${id}:${revision}`,
    topic: 'activity.changed',
    payload: { activityId: id, revision, action },
  });
}
export interface ActivityRepository {
  importActivity(athleteId: string, input: ActivityImport): Promise<ActivityImportResult>;
  listActivities(
    athleteId: string,
    input?: { limit?: number; offset?: number },
  ): Promise<ActivityList>;
  getActivity(athleteId: string, id: string): Promise<Activity | null>;
  updateOverlay(athleteId: string, id: string, input: ActivityOverlayWrite): Promise<Activity>;
  deleteActivity(athleteId: string, id: string, input: { expectedRevision: number }): Promise<void>;
  summary(athleteId: string): Promise<ActivitySummary>;
}
export function createActivityRepository(database: Database): ActivityRepository {
  return {
    importActivity(athleteId, input) {
      const command = importActivitySchema.parse(input);
      const hash = digest(command);
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const previous = await tx.query(
          'SELECT request_hash,result FROM activity_import_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, command.idempotencyKey],
        );
        if (previous.rows[0]) {
          if (previous.rows[0]['request_hash'] !== hash)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return activityImportResultSchema.parse(previous.rows[0]['result']);
        }
        const source = command.source;
        const head = await tx.query(
          `SELECT s.activity_id,s.source_revision,c.revision,c.deleted,EXISTS(SELECT 1 FROM activity_suppression d WHERE d.athlete_id=s.athlete_id AND d.kind=s.kind AND d.source_id=s.source_id) AS suppressed FROM activity_source_head s JOIN activity_canonical c ON c.athlete_id=s.athlete_id AND c.id=s.activity_id WHERE s.athlete_id=$1 AND s.kind=$2 AND s.source_id=$3`,
          [athleteId, source.kind, source.sourceId],
        );
        const existing = head.rows[0];
        const id = existing ? z.uuid().parse(existing['activity_id']) : randomUUID();
        let revision = existing ? z.number().int().positive().parse(existing['revision']) : 1;
        let outcome: ActivityImportResult['outcome'] = 'imported';
        if (existing?.['suppressed'] === true || existing?.['deleted'] === true)
          outcome = 'suppressed';
        else {
          const raw = await tx.query(
            'SELECT content_hash,normalized_raw FROM activity_source_revision WHERE athlete_id=$1 AND kind=$2 AND source_id=$3 AND source_revision=$4',
            [athleteId, source.kind, source.sourceId, source.revision],
          );
          if (raw.rows[0]) {
            if (
              raw.rows[0]['content_hash'] !== source.contentHash ||
              digest(activityValuesSchema.parse(raw.rows[0]['normalized_raw'])) !==
                digest(command.activity)
            )
              throw new PersistenceConflict('REVISION_CONFLICT');
            outcome = 'unchanged';
          } else {
            const headRevision = existing ? z.number().int().parse(existing['source_revision']) : 0;
            if (!existing) {
              await tx.query(
                'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
                [athleteId, id, JSON.stringify(command.activity)],
              );
              await tx.query(
                'INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,$2,$3,$4,$5,$6)',
                [athleteId, source.kind, source.sourceId, source.revision, source.contentHash, id],
              );
            }
            await tx.query(
              'INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
              [
                athleteId,
                source.kind,
                source.sourceId,
                source.revision,
                source.contentHash,
                JSON.stringify(command.activity),
              ],
            );
            if (source.revision < headRevision) outcome = 'stale';
            else if (existing) {
              revision += 1;
              await tx.query(
                'UPDATE activity_canonical SET original=$3::jsonb,revision=$4 WHERE athlete_id=$1 AND id=$2',
                [athleteId, id, JSON.stringify(command.activity), revision],
              );
              await tx.query(
                'UPDATE activity_source_head SET source_revision=$4,content_hash=$5 WHERE athlete_id=$1 AND kind=$2 AND source_id=$3',
                [athleteId, source.kind, source.sourceId, source.revision, source.contentHash],
              );
            }
            if (outcome === 'imported') await event(tx, id, revision, 'imported');
          }
        }
        const result = { outcome, activityId: id, revision };
        await tx.query(
          'INSERT INTO activity_import_receipt(athlete_id,idempotency_key,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',
          [athleteId, command.idempotencyKey, hash, JSON.stringify(result)],
        );
        return result;
      });
    },
    listActivities(athleteId, input = {}) {
      const query = activityListQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        // A single snapshot supplies both the bounded rows and total.
        const result = await tx.query(
          `SELECT (SELECT count(*)::int FROM activity_canonical WHERE athlete_id=$1 AND NOT deleted) AS total, coalesce(jsonb_agg(page),'[]'::jsonb) AS items FROM (${selectActivity} ORDER BY c.id LIMIT $2 OFFSET $3) page`,
          [athleteId, query.limit, query.offset],
        );
        const row = z
          .object({ total: z.number().int(), items: z.array(z.record(z.string(), z.unknown())) })
          .parse(result.rows[0]);
        return { total: row.total, items: row.items.map(decode) };
      });
    },
    getActivity(athleteId, id) {
      z.uuid().parse(id);
      return database.tenant(athleteId, (tx) => detail(tx, id));
    },
    updateOverlay(athleteId, id, input) {
      z.uuid().parse(id);
      const command = activityOverlayWriteSchema.parse(input);
      const receiptKey = `activity-overlay:${command.idempotencyKey}`;
      const requestHash = digest({ id, ...command });
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const receipt = await tx.query(
          'SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, receiptKey],
        );
        if (receipt.rows[0]) {
          if (z.object({ hash: z.string() }).parse(receipt.rows[0]['request']).hash !== requestHash)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return activitySchema.parse(receipt.rows[0]['result']);
        }
        const current = await detail(tx, id);
        if (!current) throw new ActivityNotFound();
        if (current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const values = activityOverlaySchema.parse({
          reason: command.reason,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.distanceMeters === undefined
            ? {}
            : { distanceMeters: command.distanceMeters }),
          ...(command.durationSeconds === undefined
            ? {}
            : { durationSeconds: command.durationSeconds, durationKind: command.durationKind }),
        });
        await tx.query(
          'INSERT INTO activity_overlay(athlete_id,activity_id,values_json) VALUES($1,$2,$3::jsonb) ON CONFLICT(athlete_id,activity_id) DO UPDATE SET values_json=activity_overlay.values_json || EXCLUDED.values_json',
          [athleteId, id, JSON.stringify(values)],
        );
        await tx.query(
          'INSERT INTO activity_overlay_revision(athlete_id,activity_id,revision,values_json) VALUES($1,$2,$3,$4::jsonb)',
          [athleteId, id, current.revision + 1, JSON.stringify(values)],
        );
        await tx.query(
          'UPDATE activity_canonical SET revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athleteId, id],
        );
        await event(tx, id, current.revision + 1, 'overlay');
        const result = await detail(tx, id);
        if (!result) throw new ActivityNotFound();
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, receiptKey, JSON.stringify({ hash: requestHash }), JSON.stringify(result)],
        );
        return result;
      });
    },
    deleteActivity(athleteId, id, input) {
      z.uuid().parse(id);
      const command = activityDeleteSchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const rows = await tx.query(
          'SELECT revision,deleted FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
          [athleteId, id],
        );
        const row = rows.rows[0];
        if (!row) throw new ActivityNotFound();
        if (row['deleted'] === true) return;
        const revision = z.number().int().parse(row['revision']);
        if (revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        await tx.query(
          'INSERT INTO activity_suppression(athlete_id,kind,source_id) SELECT athlete_id,kind,source_id FROM activity_source_head WHERE athlete_id=$1 AND activity_id=$2 ON CONFLICT DO NOTHING',
          [athleteId, id],
        );
        await tx.query(
          'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
          [athleteId, id],
        );
        await event(tx, id, revision + 1, 'deleted');
      });
    },
    summary(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `WITH activities AS (SELECT c.original || coalesce(o.values_json,'{}'::jsonb) AS effective FROM activity_canonical c LEFT JOIN activity_overlay o ON o.athlete_id=c.athlete_id AND o.activity_id=c.id WHERE c.athlete_id=$1 AND NOT c.deleted)
          SELECT count(*)::int AS count,sum((effective->>'distanceMeters')::numeric)::double precision AS distance,count(effective->>'distanceMeters')::int AS distance_count,
          (SELECT coalesce(jsonb_agg(d),'[]'::jsonb) FROM (SELECT effective->>'durationKind' AS kind,sum((effective->>'durationSeconds')::numeric)::double precision AS value,count(effective->>'durationSeconds')::int AS known_count FROM activities GROUP BY effective->>'durationKind') d) AS durations FROM activities`,
          [athleteId],
        );
        const row = z
          .object({
            count: z.number(),
            distance: z.number().nullable(),
            distance_count: z.number(),
            durations: z.array(
              z.object({
                kind: z.enum(['timer', 'elapsed', 'moving', 'unknown']),
                value: z.number().nullable(),
                known_count: z.number(),
              }),
            ),
          })
          .parse(result.rows[0]);
        const byKind: ActivitySummary['durationSeconds']['byKind'] = {
          timer: { value: null, knownCount: 0 },
          elapsed: { value: null, knownCount: 0 },
          moving: { value: null, knownCount: 0 },
          unknown: { value: null, knownCount: 0 },
        };
        for (const group of row.durations)
          byKind[group.kind] = { value: group.value, knownCount: group.known_count };
        const known = row.durations.filter((group) => group.known_count > 0);
        return {
          count: row.count,
          distanceMeters: { value: row.distance, knownCount: row.distance_count },
          durationSeconds: {
            value: known.length === 1 ? (known[0]?.value ?? null) : null,
            knownCount: known.reduce((total, group) => total + group.known_count, 0),
            byKind,
          },
        };
      });
    },
  };
}
