import {
  preservesSessionCompletions,
  sessionCompletionSchema,
} from '@workout/contracts/session-completion';
import { SessionCompletionError } from './session-completions.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  manualPlanCommandSchema,
  planReadSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  type ManualPlanCommand,
  type PlanDraft,
  type PlanRead,
  type PlanSnapshot,
} from '@workout/contracts/planning';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { persistSupplementarySessionLinks } from './supplementary-plan-links.js';

export class PlanLockedError extends Error {
  readonly code = 'PLAN_LOCKED';
  constructor() {
    super('Plan session is locked');
  }
}
export class CombinedReviewRequiredError extends Error {
  readonly code = 'COMBINED_REVIEW_REQUIRED';
  constructor() {
    super('Relative nutrition plans require a combined change review');
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
function changedSessionTimingIds(previous: PlanDraft | null, proposed: PlanDraft): string[] {
  const before = new Map(previous?.sessions.map((session) => [session.id, session]) ?? []);
  const after = new Map(proposed.sessions.map((session) => [session.id, session]));
  const timezoneChanged = previous !== null && previous.timezone !== proposed.timezone;
  return [...new Set([...before.keys(), ...after.keys()])].filter((id) => {
    const old = before.get(id);
    const next = after.get(id);
    if (!old || !next || timezoneChanged) return true;
    return (
      old.date !== next.date ||
      old.localStartTime !== next.localStartTime ||
      old.durationSeconds !== next.durationSeconds ||
      JSON.stringify(old.durationRange ?? null) !== JSON.stringify(next.durationRange ?? null)
    );
  });
}
async function assertRelativeNutritionUnaffected(
  transaction: Transaction,
  previous: PlanDraft | null,
  proposed: PlanDraft,
  reviewedRelativeNutritionPlanIds: readonly string[] = [],
): Promise<void> {
  const ids = changedSessionTimingIds(previous, proposed);
  if (ids.length === 0) {
    if (reviewedRelativeNutritionPlanIds.length > 0) throw new CombinedReviewRequiredError();
    return;
  }
  const affected = await transaction.query(
    `SELECT h.plan_id FROM nutrition_plan_head h JOIN nutrition_plan_version v
       ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
     WHERE h.athlete_id=$1 AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(v.record_json->'items') item
       WHERE item->'anchor'->>'kind'='relative'
         AND item->'anchor'->>'entityId'=ANY($2::text[])
     ) ORDER BY h.plan_id`,
    [transaction.athleteId, ids],
  );
  const actual = affected.rows.map((row) => String(row['plan_id']));
  const reviewed = [...new Set(reviewedRelativeNutritionPlanIds)].sort();
  if (
    reviewed.length !== reviewedRelativeNutritionPlanIds.length ||
    reviewed.length !== actual.length ||
    reviewed.some((id, index) => id !== actual[index])
  )
    throw new CombinedReviewRequiredError();
}
/** Internal transaction primitive. Callers own successful-receipt replay before this call,
 * and history/outbox/source audit/receipt writes afterwards in the SAME transaction.
 * The shared lock serializes current-plan writes with completion reports.
 */
export async function persistPlanVersion(
  transaction: Transaction,
  {
    expectedVersionId,
    aggregateId,
    draft,
    reviewedRelativeNutritionPlanIds = [],
  }: {
    expectedVersionId: string | null;
    /** Stable plan identity. Schema-v4 callers provide it; legacy callers preserve or allocate one. */
    aggregateId?: string;
    draft: PlanDraft;
    /** Joint approval only: exact set of current nutrition heads reviewed for changed relative anchors. */
    reviewedRelativeNutritionPlanIds?: readonly string[];
  },
): Promise<PlanSnapshot> {
  await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    transaction.athleteId,
  ]);
  const current = await transaction.query(
    'SELECT p.* FROM plan_head h JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=$1',
    [transaction.athleteId],
  );
  const previous = current.rows[0] === undefined ? null : snapshot(current.rows[0]);
  if ((previous?.id ?? null) !== expectedVersionId)
    throw new PersistenceConflict('REVISION_CONFLICT');
  if (previous !== null && !preservesSessionLocks(previous.draft, draft))
    throw new PlanLockedError();
  const completions = await transaction.query(
    "SELECT record_json FROM session_completion WHERE athlete_id=$1 AND record_json->>'status'='completed'",
    [transaction.athleteId],
  );
  if (
    !preservesSessionCompletions(
      draft,
      completions.rows.map((row) => sessionCompletionSchema.parse(row['record_json'])),
    )
  )
    throw new SessionCompletionError('PLAN_COMPLETED_SESSION');
  await assertRelativeNutritionUnaffected(
    transaction,
    previous?.draft ?? null,
    draft,
    reviewedRelativeNutritionPlanIds,
  );
  const id = randomUUID();
  const inserted = await transaction.query(
    'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,$3,$4::jsonb) RETURNING *',
    [transaction.athleteId, id, (previous?.version ?? 0) + 1, JSON.stringify(draft)],
  );
  const saved = snapshot(inserted.rows[0] ?? {});
  await transaction.query(
    `INSERT INTO plan_head(athlete_id,aggregate_id,version_id)
     VALUES($1,coalesce($3::uuid,gen_random_uuid()),$2)
     ON CONFLICT(athlete_id) DO UPDATE SET version_id=EXCLUDED.version_id`,
    [transaction.athleteId, id, aggregateId ?? null],
  );
  return saved;
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
          ...(command.supplementaryLinks === undefined
            ? {}
            : { supplementaryLinks: command.supplementaryLinks }),
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
        const saved = await persistPlanVersion(transaction, {
          expectedVersionId: command.expectedVersionId,
          draft: command.draft,
        });
        await persistSupplementarySessionLinks(
          transaction,
          command.expectedVersionId,
          saved.id,
          command.draft,
          command.supplementaryLinks ?? [],
        );
        const id = saved.id;
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
