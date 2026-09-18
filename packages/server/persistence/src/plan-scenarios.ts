import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  planScenarioSchema,
  planScenarioListSchema,
  planScenarioListQuerySchema,
  planScenarioCreateSchema,
  planScenarioSaveSchema,
  planScenarioApplySchema,
  planScenarioApplyResultSchema,
  type PlanScenario,
  type PlanScenarioList,
  type PlanScenarioListQuery,
  type PlanScenarioCreate,
  type PlanScenarioSave,
  type PlanScenarioApply,
  type PlanScenarioApplyResult,
} from '@workout/contracts/plan-scenarios';
import { planDraftSchema, preservesSessionLocks } from '@workout/contracts/planning';
import {
  preservesSessionCompletions,
  sessionCompletionSchema,
} from '@workout/contracts/session-completion';
import type { Database, Transaction } from './database.js';
import { persistPlanVersion, PlanLockedError } from './planning.js';
import { SessionCompletionError } from './session-completions.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { persistSupplementarySessionLinks } from './supplementary-plan-links.js';

export class PlanScenarioError extends Error {
  constructor(
    readonly code:
      | 'SCENARIO_NOT_FOUND'
      | 'PLAN_VERSION_NOT_FOUND'
      | 'SCENARIO_SLOT_EXISTS'
      | 'SCENARIO_REVISION_CONFLICT'
      | 'COMPLETION_REVISION_CONFLICT',
  ) {
    super(code);
  }
}
export interface PlanScenarioRepository {
  list(athleteId: string, input?: Partial<PlanScenarioListQuery>): Promise<PlanScenarioList>;
  read(athleteId: string, id: string): Promise<PlanScenario | null>;
  readRevision(athleteId: string, id: string, revision: number): Promise<PlanScenario | null>;
  create(athleteId: string, input: PlanScenarioCreate): Promise<PlanScenario>;
  save(athleteId: string, id: string, input: PlanScenarioSave): Promise<PlanScenario>;
  apply(athleteId: string, id: string, input: PlanScenarioApply): Promise<PlanScenarioApplyResult>;
}
const idSchema = z.uuid().transform((value) => value.toLowerCase());
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
function scenario(row: Record<string, unknown>): PlanScenario {
  return planScenarioSchema.parse({
    id: row['id'],
    basePlanVersionId: row['base_plan_version_id'],
    label: row['label'],
    revision: row['revision'],
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    draft: row['draft'],
  });
}
async function current(tx: Transaction, id: string): Promise<PlanScenario | null> {
  const result = await tx.query('SELECT * FROM plan_scenario WHERE athlete_id=$1 AND id=$2', [
    tx.athleteId,
    id,
  ]);
  return result.rows[0] ? scenario(result.rows[0]) : null;
}
const lock = (tx: Transaction) =>
  tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tx.athleteId]);
async function replay(
  tx: Transaction,
  key: string,
  request: unknown,
): Promise<unknown | undefined> {
  const result = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!result.rows[0]) return undefined;
  if (result.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return result.rows[0]['result'];
}
async function receipt(tx: Transaction, key: string, request: unknown, result: unknown) {
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify(result)],
  );
}
async function branchEvent(
  tx: Transaction,
  key: string,
  value: PlanScenario,
  topic: 'plan.scenario_created' | 'plan.scenario_saved',
) {
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: key,
    topic,
    payload: {
      scenarioId: value.id,
      revision: value.revision,
      basePlanVersionId: value.basePlanVersionId,
      label: value.label,
    },
  });
}
async function recordRevision(tx: Transaction, value: PlanScenario) {
  await tx.query(
    'INSERT INTO plan_scenario_revision(athlete_id,scenario_id,revision,record_json) VALUES($1,$2,$3,$4::jsonb)',
    [tx.athleteId, value.id, value.revision, JSON.stringify(value)],
  );
}
export function createPlanScenarioRepository(database: Database): PlanScenarioRepository {
  return {
    list(athleteId, input = {}) {
      const query = planScenarioListQuerySchema.parse(input);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          `WITH filtered AS MATERIALIZED (SELECT id,base_plan_version_id AS "basePlanVersionId",label,revision,created_at AS "createdAt",updated_at AS "updatedAt",draft->>'title' AS title FROM plan_scenario WHERE athlete_id=$1 AND ($2::uuid IS NULL OR base_plan_version_id=$2::uuid)),page AS (SELECT * FROM filtered ORDER BY "createdAt" DESC,id ASC LIMIT $3 OFFSET $4) SELECT (SELECT count(*)::int FROM filtered) AS total,coalesce((SELECT jsonb_agg(p ORDER BY "createdAt" DESC,id ASC) FROM page p),'[]'::jsonb) AS items`,
          [athleteId, query.basePlanVersionId ?? null, query.limit, query.offset],
        );
        return planScenarioListSchema.parse(result.rows[0]);
      });
    },
    read(athleteId, id) {
      const parsed = idSchema.parse(id);
      return database.tenant(athleteId, (tx) => current(tx, parsed));
    },
    readRevision(athleteId, id, revision) {
      const parsed = idSchema.parse(id);
      planScenarioSchema.shape.revision.parse(revision);
      return database.tenant(athleteId, async (tx) => {
        const result = await tx.query(
          'SELECT record_json FROM plan_scenario_revision WHERE athlete_id=$1 AND scenario_id=$2 AND revision=$3',
          [athleteId, parsed, revision],
        );
        return result.rows[0] ? planScenarioSchema.parse(result.rows[0]['record_json']) : null;
      });
    },
    create(athleteId, input) {
      const command = planScenarioCreateSchema.parse(input),
        key = `scenario:create:${command.idempotencyKey}`,
        request = { operation: 'scenario_create', command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const prior = await replay(tx, key, request);
        if (prior !== undefined) return planScenarioSchema.parse(prior);
        const base = await tx.query(
          'SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.basePlanVersionId],
        );
        if (!base.rows[0]) throw new PlanScenarioError('PLAN_VERSION_NOT_FOUND');
        const draft = planDraftSchema.parse(base.rows[0]['draft']);
        const occupied = await tx.query(
          'SELECT id FROM plan_scenario WHERE athlete_id=$1 AND base_plan_version_id=$2 AND label=$3',
          [athleteId, command.basePlanVersionId, command.label],
        );
        if (occupied.rows.length) throw new PlanScenarioError('SCENARIO_SLOT_EXISTS');
        const inserted = await tx.query(
          'INSERT INTO plan_scenario(athlete_id,id,base_plan_version_id,label,revision,draft) VALUES($1,$2,$3,$4,1,$5::jsonb) RETURNING *',
          [
            athleteId,
            randomUUID(),
            command.basePlanVersionId,
            command.label,
            JSON.stringify(draft),
          ],
        );
        const value = scenario(inserted.rows[0] ?? {});
        await recordRevision(tx, value);
        await branchEvent(tx, key, value, 'plan.scenario_created');
        await receipt(tx, key, request, value);
        return value;
      });
    },
    save(athleteId, id, input) {
      const parsed = idSchema.parse(id),
        command = planScenarioSaveSchema.parse(input),
        key = `scenario:save:${command.idempotencyKey}`,
        request = { operation: 'scenario_save', id: parsed, command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const prior = await replay(tx, key, request);
        if (prior !== undefined) return planScenarioSchema.parse(prior);
        const previous = await current(tx, parsed);
        if (!previous) throw new PlanScenarioError('SCENARIO_NOT_FOUND');
        if (previous.revision !== command.expectedRevision)
          throw new PlanScenarioError('SCENARIO_REVISION_CONFLICT');
        if (!preservesSessionLocks(previous.draft, command.draft)) throw new PlanLockedError();
        const reports = await tx.query(
          "SELECT record_json FROM session_completion WHERE athlete_id=$1 AND record_json->>'status'='completed'",
          [athleteId],
        );
        if (
          !preservesSessionCompletions(
            command.draft,
            reports.rows.map((row) => sessionCompletionSchema.parse(row['record_json'])),
          )
        )
          throw new SessionCompletionError('PLAN_COMPLETED_SESSION');
        const updated = await tx.query(
          'UPDATE plan_scenario SET revision=revision+1,draft=$3::jsonb,updated_at=now() WHERE athlete_id=$1 AND id=$2 RETURNING *',
          [athleteId, parsed, JSON.stringify(command.draft)],
        );
        const value = scenario(updated.rows[0] ?? {});
        await recordRevision(tx, value);
        await branchEvent(tx, key, value, 'plan.scenario_saved');
        await receipt(tx, key, request, value);
        return value;
      });
    },
    apply(athleteId, id, input) {
      const parsed = idSchema.parse(id),
        command = planScenarioApplySchema.parse(input),
        key = `scenario:apply:${command.idempotencyKey}`,
        request = { operation: 'scenario_apply', id: parsed, command };
      return database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const prior = await replay(tx, key, request);
        if (prior !== undefined) return planScenarioApplyResultSchema.parse(prior);
        const alternative = await current(tx, parsed);
        if (!alternative) throw new PlanScenarioError('SCENARIO_NOT_FOUND');
        if (alternative.revision !== command.expectedScenarioRevision)
          throw new PlanScenarioError('SCENARIO_REVISION_CONFLICT');
        const head = await tx.query(
          'SELECT version_id::text AS id FROM plan_head WHERE athlete_id=$1',
          [athleteId],
        );
        if (head.rows[0]?.['id'] !== command.expectedPlanVersionId)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const completion = await tx.query(
          'SELECT revision FROM session_completion_collection_head WHERE athlete_id=$1',
          [athleteId],
        );
        const completionRevision = z
          .number()
          .int()
          .nonnegative()
          .parse(completion.rows[0]?.['revision'] ?? 0);
        if (completionRevision !== command.expectedCompletionRevision)
          throw new PlanScenarioError('COMPLETION_REVISION_CONFLICT');
        const plan = await persistPlanVersion(tx, {
          expectedVersionId: command.expectedPlanVersionId,
          draft: alternative.draft,
        });
        await persistSupplementarySessionLinks(
          tx,
          command.expectedPlanVersionId,
          plan.id,
          alternative.draft,
          [],
        );
        await tx.query(
          "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'scenario_applied')",
          [athleteId, plan.id],
        );
        await tx.query(
          'INSERT INTO plan_scenario_application(athlete_id,version_id,scenario_id,scenario_revision,previous_version_id,completion_revision) VALUES($1,$2,$3,$4,$5,$6)',
          [
            athleteId,
            plan.id,
            parsed,
            alternative.revision,
            command.expectedPlanVersionId,
            completionRevision,
          ],
        );
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: key,
          topic: 'plan.scenario_applied',
          payload: {
            versionId: plan.id,
            version: plan.version,
            scenarioId: parsed,
            scenarioRevision: alternative.revision,
          },
        });
        const result = planScenarioApplyResultSchema.parse({
          plan,
          scenarioId: parsed,
          scenarioRevision: alternative.revision,
        });
        await receipt(tx, key, request, result);
        return result;
      });
    },
  };
}
