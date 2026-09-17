import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  manualPlanCommandSchema,
  planReadSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  type ManualPlanCommand,
  type PlanRead,
  type PlanSnapshot,
} from '@workout/contracts/planning';
import type { Database } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

export class PlanLockedError extends Error {
  readonly code = 'PLAN_LOCKED';
  constructor() {
    super('Plan session is locked');
  }
}
export interface PlanningRepository {
  read(athleteId: string): Promise<PlanRead>;
  readVersion(athleteId: string, versionId: string): Promise<PlanSnapshot | null>;
  save(athleteId: string, input: ManualPlanCommand): Promise<PlanSnapshot>;
}
function snapshot(row: Record<string, unknown>): PlanSnapshot {
  const createdAt = row['created_at'];
  return planSnapshotSchema.parse({
    id: row['id'],
    version: row['version'],
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt,
    draft: row['draft'],
  });
}
export function createPlanningRepository(database: Database): PlanningRepository {
  return {
    async readVersion(athleteId, versionId) {
      const id = z.uuid().parse(versionId).toLowerCase();
      return database.tenant(athleteId, async (transaction) => {
        const result = await transaction.query(
          'SELECT id,version,created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
          [athleteId, id],
        );
        return result.rows[0] ? snapshot(result.rows[0]) : null;
      });
    },
    async read(athleteId) {
      return database.tenant(athleteId, async (transaction) => {
        // One query observes head and history from one PostgreSQL statement snapshot.
        const result = await transaction.query(
          `SELECT p.id,p.version,p.created_at,p.draft->>'title' AS title,CASE WHEN h.version_id=p.id THEN p.draft ELSE NULL END AS draft,h.version_id = p.id AS is_head FROM plan_snapshot p
          LEFT JOIN plan_head h ON h.athlete_id=p.athlete_id WHERE p.athlete_id=$1 ORDER BY p.version DESC LIMIT 100`,
          [athleteId],
        );
        const head = result.rows.find((row) => row['is_head'] === true);
        return planReadSchema.parse({
          head: head === undefined ? null : snapshot(head),
          history: result.rows.map((row) => ({
            id: row['id'],
            version: row['version'],
            createdAt:
              row['created_at'] instanceof Date
                ? row['created_at'].toISOString()
                : row['created_at'],
            title: row['title'],
          })),
        });
      });
    },
    async save(athleteId, input) {
      const command = manualPlanCommandSchema.parse(input);
      return database.tenant(athleteId, async (transaction) => {
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          athleteId,
        ]);
        const request = {
          operation: 'manual_plan_save',
          source: command.source,
          confirmed: command.confirmed,
          expectedVersionId: command.expectedVersionId,
          draft: command.draft,
        };
        const receipt = await transaction.query(
          'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
          [athleteId, command.idempotencyKey, JSON.stringify(request)],
        );
        if (receipt.rows.length > 0) {
          if (receipt.rows[0]?.['matches'] !== true)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return planSnapshotSchema.parse(receipt.rows[0]?.['result']);
        }
        const current = await transaction.query(
          'SELECT p.* FROM plan_head h JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=$1',
          [athleteId],
        );
        const previous = current.rows[0] === undefined ? null : snapshot(current.rows[0]);
        if ((previous?.id ?? null) !== command.expectedVersionId)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (previous !== null && !preservesSessionLocks(previous.draft, command.draft))
          throw new PlanLockedError();
        const id = randomUUID();
        const inserted = await transaction.query(
          'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,$3,$4::jsonb) RETURNING *',
          [athleteId, id, (previous?.version ?? 0) + 1, JSON.stringify(command.draft)],
        );
        const saved = snapshot(inserted.rows[0] ?? {});
        await transaction.query(
          'INSERT INTO plan_head(athlete_id,version_id) VALUES($1,$2) ON CONFLICT(athlete_id) DO UPDATE SET version_id=EXCLUDED.version_id',
          [athleteId, id],
        );
        await transaction.query(
          "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
          [athleteId, id],
        );
        await enqueue(transaction, {
          id: randomUUID(),
          idempotencyKey: command.idempotencyKey,
          topic: 'plan.manual_saved',
          payload: { versionId: id, version: saved.version },
        });
        await transaction.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [athleteId, command.idempotencyKey, JSON.stringify(request), JSON.stringify(saved)],
        );
        return saved;
      });
    },
  };
}
