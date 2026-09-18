import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  confirmRecoveryStrategyRequestSchema,
  correctRecoveryActionRequestSchema,
  createRecoveryActionRequestSchema,
  createRecoveryMethodRequestSchema,
  createRecoveryStrategyRequestSchema,
  deleteRecoveryActionRequestSchema,
  deletedRecoveryActionSchema,
  recoveryActionLogSchema,
  recoveryActionRecordSchema,
  recoveryMethodVersionSchema,
  recoveryStrategyVersionSchema,
  recoveryWorkspaceReadSchema,
  type ConfirmRecoveryStrategyRequest,
  type CorrectRecoveryActionRequest,
  type CreateRecoveryActionRequest,
  type CreateRecoveryMethodRequest,
  type CreateRecoveryStrategyRequest,
  type DeleteRecoveryActionRequest,
  type DeletedRecoveryAction,
  type RecoveryActionLog,
  type RecoveryActionRecord,
  type RecoveryMethodVersion,
  type RecoveryObservationRef,
  type RecoveryPlanRef,
  type RecoveryStrategyDraft,
  type RecoveryStrategyVersion,
  type RecoveryWorkspaceRead,
} from '@workout/contracts/recovery-core';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';

export class RecoveryReferenceError extends Error {
  constructor(
    readonly code:
      | 'METHOD_NOT_FOUND'
      | 'STRATEGY_NOT_FOUND'
      | 'ACTION_NOT_FOUND'
      | 'OBSERVATION_NOT_FOUND'
      | 'PLAN_NOT_FOUND'
      | 'OPTION_LINK_INVALID',
  ) {
    super(code);
  }
}

export class RecoveryValidationError extends Error {
  readonly code = 'OCCURRED_AT_IN_FUTURE';
  constructor() {
    super('OCCURRED_AT_IN_FUTURE');
  }
}

export interface RecoveryRepository {
  workspace(athleteId: string): Promise<RecoveryWorkspaceRead>;
  readStrategy(athleteId: string, strategyId: string): Promise<RecoveryStrategyVersion | null>;
  createMethod(
    athleteId: string,
    input: CreateRecoveryMethodRequest,
  ): Promise<RecoveryMethodVersion>;
  createStrategy(
    athleteId: string,
    input: CreateRecoveryStrategyRequest,
  ): Promise<RecoveryStrategyVersion>;
  confirmStrategy(
    athleteId: string,
    input: ConfirmRecoveryStrategyRequest,
  ): Promise<RecoveryStrategyVersion>;
  createAction(athleteId: string, input: CreateRecoveryActionRequest): Promise<RecoveryActionLog>;
  correctAction(athleteId: string, input: CorrectRecoveryActionRequest): Promise<RecoveryActionLog>;
  deleteAction(
    athleteId: string,
    input: DeleteRecoveryActionRequest,
  ): Promise<DeletedRecoveryAction>;
}

async function lockCommands(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tx.athleteId]);
}

async function replay<T>(tx: Transaction, key: string, request: unknown, schema: z.ZodType<T>) {
  const found = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!found.rows[0]) return null;
  if (found.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return schema.parse(found.rows[0]['result']);
}

async function finish<T>(
  tx: Transaction,
  key: string,
  request: unknown,
  result: T,
  topic: string,
  id: string,
) {
  await enqueue(tx, {
    id: randomUUID(),
    idempotencyKey: key,
    topic,
    payload: { id },
  });
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify(result)],
  );
  return result;
}

async function observationState(tx: Transaction, ref: RecoveryObservationRef) {
  if (ref.kind === 'check_in') {
    const row = await tx.query(
      'SELECT revision,deleted FROM check_in WHERE athlete_id=$1 AND id=$2',
      [tx.athleteId, ref.id],
    );
    if (!row.rows[0] || row.rows[0]['deleted'] === true) return 'deleted' as const;
    return row.rows[0]['revision'] === ref.revision ? ('current' as const) : ('revised' as const);
  }
  if (ref.kind === 'activity') {
    const row = await tx.query(
      'SELECT revision,deleted FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
      [tx.athleteId, ref.id],
    );
    if (!row.rows[0] || row.rows[0]['deleted'] === true) return 'deleted' as const;
    return row.rows[0]['revision'] === ref.revision ? ('current' as const) : ('revised' as const);
  }
  const row = await tx.query(
    'SELECT current_revision,status FROM intake_entry WHERE athlete_id=$1 AND id=$2',
    [tx.athleteId, ref.id],
  );
  if (!row.rows[0] || row.rows[0]['status'] !== 'active') return 'deleted' as const;
  return row.rows[0]['current_revision'] === ref.revision
    ? ('current' as const)
    : ('revised' as const);
}

async function planState(tx: Transaction, ref: RecoveryPlanRef) {
  if (ref.kind === 'training') {
    const row = await tx.query(
      `SELECT version_id FROM plan_head WHERE athlete_id=$1
       AND EXISTS (SELECT 1 FROM plan_snapshot WHERE athlete_id=$1 AND id=$2)`,
      [tx.athleteId, ref.aggregateId],
    );
    if (!row.rows[0]) return 'deleted' as const;
    return row.rows[0]['version_id'] === ref.headVersionId
      ? ('current' as const)
      : ('changed' as const);
  }
  const row = await tx.query(
    'SELECT version_id FROM nutrition_plan_head WHERE athlete_id=$1 AND plan_id=$2',
    [tx.athleteId, ref.aggregateId],
  );
  if (!row.rows[0]) return 'deleted' as const;
  return row.rows[0]['version_id'] === ref.headVersionId
    ? ('current' as const)
    : ('changed' as const);
}

async function validateDraft(tx: Transaction, draft: RecoveryStrategyDraft) {
  for (const option of draft.options) {
    if (option.methodVersionId !== null) await ownedMethod(tx, option.methodVersionId);
  }
  for (const ref of draft.observations) {
    const state = await observationState(tx, ref);
    if (state === 'deleted') throw new RecoveryReferenceError('OBSERVATION_NOT_FOUND');
    if (state !== 'current') throw new PersistenceConflict('REVISION_CONFLICT');
  }
  for (const ref of draft.planRefs) {
    const state = await planState(tx, ref);
    if (state === 'deleted') throw new RecoveryReferenceError('PLAN_NOT_FOUND');
    if (state !== 'current') throw new PersistenceConflict('REVISION_CONFLICT');
  }
}

async function ownedMethod(tx: Transaction, versionId: string): Promise<RecoveryMethodVersion> {
  const found = await tx.query(
    'SELECT record_json FROM recovery_method_version WHERE athlete_id=$1 AND version_id=$2',
    [tx.athleteId, versionId],
  );
  if (!found.rows[0]) throw new RecoveryReferenceError('METHOD_NOT_FOUND');
  return recoveryMethodVersionSchema.parse(found.rows[0]['record_json']);
}

async function ownedStrategy(tx: Transaction, versionId: string): Promise<RecoveryStrategyVersion> {
  const found = await tx.query(
    'SELECT record_json FROM recovery_strategy_version WHERE athlete_id=$1 AND version_id=$2',
    [tx.athleteId, versionId],
  );
  if (!found.rows[0]) throw new RecoveryReferenceError('STRATEGY_NOT_FOUND');
  return recoveryStrategyVersionSchema.parse(found.rows[0]['record_json']);
}

async function validateActionLinks(tx: Transaction, action: CreateRecoveryActionRequest) {
  await ownedMethod(tx, action.methodVersionId);
  for (const ref of [action.beforeCheckIn, action.afterCheckIn]) {
    if (ref === null) continue;
    const state = await observationState(tx, ref);
    if (state === 'deleted') throw new RecoveryReferenceError('OBSERVATION_NOT_FOUND');
    if (state !== 'current') throw new PersistenceConflict('REVISION_CONFLICT');
  }
  if (action.strategyVersionId === null) return;
  const strategy = await ownedStrategy(tx, action.strategyVersionId);
  if (strategy.status !== 'user_confirmed') throw new RecoveryReferenceError('OPTION_LINK_INVALID');
  if (strategy.selectedOptionId !== action.plannedOptionId)
    throw new RecoveryReferenceError('OPTION_LINK_INVALID');
  const option = strategy.draft.options.find((item) => item.id === action.plannedOptionId);
  if (option?.kind !== 'nonexercise_action' || option.methodVersionId !== action.methodVersionId) {
    throw new RecoveryReferenceError('OPTION_LINK_INVALID');
  }
}

async function currentAction(tx: Transaction, id: string): Promise<RecoveryActionRecord | null> {
  const found = await tx.query(
    `SELECT r.record_json FROM recovery_action_log a JOIN recovery_action_revision r
     ON r.athlete_id=a.athlete_id AND r.action_id=a.action_id AND r.revision=a.revision
     WHERE a.athlete_id=$1 AND a.action_id=$2`,
    [tx.athleteId, id],
  );
  return found.rows[0] ? recoveryActionRecordSchema.parse(found.rows[0]['record_json']) : null;
}

export function createRecoveryRepository(
  database: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
): RecoveryRepository {
  return {
    readStrategy(athleteId, strategyId) {
      const id = z.uuid().parse(strategyId);
      return database.tenant(athleteId, async (tx) => {
        const found = await tx.query(
          `SELECT v.record_json FROM recovery_strategy_head h JOIN recovery_strategy_version v
           ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 AND h.strategy_id=$2`,
          [athleteId, id],
        );
        return found.rows[0]
          ? recoveryStrategyVersionSchema.parse(found.rows[0]['record_json'])
          : null;
      });
    },
    workspace(athleteId) {
      return database.tenant(athleteId, async (tx) => {
        const methodRows = await tx.query(
          `SELECT v.record_json FROM recovery_method_head h JOIN recovery_method_version v
           ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 ORDER BY h.method_id LIMIT 100`,
          [athleteId],
        );
        const strategyRows = await tx.query(
          `SELECT v.record_json FROM recovery_strategy_head h JOIN recovery_strategy_version v
           ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
           WHERE h.athlete_id=$1 ORDER BY h.strategy_id LIMIT 100`,
          [athleteId],
        );
        const actionRows = await tx.query(
          `SELECT r.record_json FROM recovery_action_log a JOIN recovery_action_revision r
           ON r.athlete_id=a.athlete_id AND r.action_id=a.action_id AND r.revision=a.revision
           WHERE a.athlete_id=$1 ORDER BY a.action_id LIMIT 100`,
          [athleteId],
        );
        const methods = methodRows.rows.map((row) =>
          recoveryMethodVersionSchema.parse(row['record_json']),
        );
        const strategies = strategyRows.rows.map((row) =>
          recoveryStrategyVersionSchema.parse(row['record_json']),
        );
        const actions = actionRows.rows.map((row) =>
          recoveryActionRecordSchema.parse(row['record_json']),
        );
        const observationRefs = new Map<string, RecoveryObservationRef>();
        const planRefs = new Map<string, RecoveryPlanRef>();
        for (const strategy of strategies) {
          for (const ref of strategy.draft.observations)
            observationRefs.set(ref.kind + ':' + ref.id + ':' + ref.revision, ref);
          for (const ref of strategy.draft.planRefs)
            planRefs.set(ref.kind + ':' + ref.aggregateId + ':' + ref.headVersionId, ref);
        }
        for (const action of actions) {
          if (action.status === 'deleted') continue;
          for (const ref of [action.beforeCheckIn, action.afterCheckIn]) {
            if (ref !== null)
              observationRefs.set(ref.kind + ':' + ref.id + ':' + ref.revision, ref);
          }
        }
        const observations = [];
        for (const reference of observationRefs.values()) {
          observations.push({ reference, state: await observationState(tx, reference) });
        }
        const readPlans = [];
        for (const reference of planRefs.values()) {
          readPlans.push({ reference, state: await planState(tx, reference) });
        }
        const staleObservations = new Set(
          observations
            .filter((item) => item.state !== 'current')
            .map((item) => item.reference.kind + ':' + item.reference.id),
        );
        const stalePlans = new Set(
          readPlans
            .filter((item) => item.state !== 'current')
            .map((item) => item.reference.kind + ':' + item.reference.aggregateId),
        );
        const reassessment = strategies.flatMap((strategy) =>
          strategy.draft.reassessment.flatMap((condition) => {
            const scheduled =
              condition.trigger === 'scheduled_checkin' &&
              condition.plannedAt !== null &&
              condition.plannedAt <= now().toISOString();
            const observationChanged =
              condition.trigger === 'user_report_changed' &&
              strategy.draft.observations.some((ref) =>
                staleObservations.has(ref.kind + ':' + ref.id),
              );
            const planChanged =
              condition.trigger === 'plan_changed' &&
              strategy.draft.planRefs.some((ref) =>
                stalePlans.has(ref.kind + ':' + ref.aggregateId),
              );
            if (!scheduled && !observationChanged && !planChanged) return [];
            return [
              {
                strategyId: strategy.strategyId,
                conditionId: condition.id,
                reason: scheduled
                  ? ('scheduled' as const)
                  : planChanged
                    ? ('plan_changed' as const)
                    : ('observation_changed' as const),
              },
            ];
          }),
        );
        return recoveryWorkspaceReadSchema.parse({
          methods,
          strategies,
          actions,
          observations,
          planRefs: readPlans,
          reassessment,
        });
      });
    },
    createMethod(athleteId, input) {
      const command = createRecoveryMethodRequestSchema.parse(input);
      const request = { operation: 'recovery_method_create', ...command };
      const key = 'recovery-method:' + command.idempotencyKey;
      return database.tenant(athleteId, async (tx) => {
        await lockCommands(tx);
        const prior = await replay(tx, key, request, recoveryMethodVersionSchema);
        if (prior) return prior;
        const saved = recoveryMethodVersionSchema.parse({
          schemaVersion: 1,
          methodId: randomUUID(),
          versionId: randomUUID(),
          version: 1,
          title: command.title,
          category: command.category,
          intendedUse: command.intendedUse,
          applicability: command.applicability,
          cautions: command.cautions,
          sourceDescription: command.sourceDescription,
          evidenceLimitations: command.evidenceLimitations,
          reviewState: 'unreviewed',
          reviewedAt: null,
          source: 'user_recorded',
          createdAt: now().toISOString(),
        });
        await tx.query(
          'INSERT INTO recovery_method_version(athlete_id,method_id,version_id,version,record_json) VALUES($1,$2,$3,1,$4::jsonb)',
          [athleteId, saved.methodId, saved.versionId, JSON.stringify(saved)],
        );
        await tx.query(
          'INSERT INTO recovery_method_head(athlete_id,method_id,version,version_id) VALUES($1,$2,1,$3)',
          [athleteId, saved.methodId, saved.versionId],
        );
        return finish(tx, key, request, saved, 'recovery.method.created', saved.methodId);
      });
    },
    createStrategy(athleteId, input) {
      const command = createRecoveryStrategyRequestSchema.parse(input);
      const request = { operation: 'recovery_strategy_create', ...command };
      const key = 'recovery-strategy:' + command.idempotencyKey;
      return database.tenant(athleteId, async (tx) => {
        await lockCommands(tx);
        const prior = await replay(tx, key, request, recoveryStrategyVersionSchema);
        if (prior) return prior;
        await validateDraft(tx, command.draft);
        const saved = recoveryStrategyVersionSchema.parse({
          schemaVersion: 1,
          strategyId: randomUUID(),
          versionId: randomUUID(),
          version: 1,
          previousVersionId: null,
          status: 'draft',
          selectedOptionId: null,
          createdAt: now().toISOString(),
          draft: command.draft,
        });
        await tx.query(
          `INSERT INTO recovery_strategy_version
           (athlete_id,strategy_id,version_id,version,previous_version_id,previous_version,record_json)
           VALUES($1,$2,$3,1,NULL,NULL,$4::jsonb)`,
          [athleteId, saved.strategyId, saved.versionId, JSON.stringify(saved)],
        );
        await tx.query(
          'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) VALUES($1,$2,1,$3)',
          [athleteId, saved.strategyId, saved.versionId],
        );
        return finish(tx, key, request, saved, 'recovery.strategy.drafted', saved.strategyId);
      });
    },
    confirmStrategy(athleteId, input) {
      const command = confirmRecoveryStrategyRequestSchema.parse(input);
      const request = { operation: 'recovery_strategy_confirm', ...command };
      const key = 'recovery-strategy-confirm:' + command.idempotencyKey;
      return database.tenant(athleteId, async (tx) => {
        await lockCommands(tx);
        const prior = await replay(tx, key, request, recoveryStrategyVersionSchema);
        if (prior) return prior;
        const head = await tx.query(
          'SELECT version,version_id FROM recovery_strategy_head WHERE athlete_id=$1 AND strategy_id=$2',
          [athleteId, command.strategyId],
        );
        if (!head.rows[0]) throw new RecoveryReferenceError('STRATEGY_NOT_FOUND');
        if (head.rows[0]['version_id'] !== command.expectedHeadVersionId)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const previous = await ownedStrategy(tx, command.expectedHeadVersionId);
        if (previous.status !== 'draft') throw new PersistenceConflict('REVISION_CONFLICT');
        if (!previous.draft.options.some((item) => item.id === command.selectedOptionId))
          throw new RecoveryReferenceError('OPTION_LINK_INVALID');
        await validateDraft(tx, previous.draft);
        const saved = recoveryStrategyVersionSchema.parse({
          ...previous,
          versionId: randomUUID(),
          version: previous.version + 1,
          previousVersionId: previous.versionId,
          status: 'user_confirmed',
          selectedOptionId: command.selectedOptionId,
          createdAt: now().toISOString(),
        });
        await tx.query(
          `INSERT INTO recovery_strategy_version
           (athlete_id,strategy_id,version_id,version,previous_version_id,previous_version,record_json)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            athleteId,
            saved.strategyId,
            saved.versionId,
            saved.version,
            previous.versionId,
            previous.version,
            JSON.stringify(saved),
          ],
        );
        await tx.query(
          'UPDATE recovery_strategy_head SET version=$3,version_id=$4 WHERE athlete_id=$1 AND strategy_id=$2',
          [athleteId, saved.strategyId, saved.version, saved.versionId],
        );
        return finish(tx, key, request, saved, 'recovery.strategy.confirmed', saved.strategyId);
      });
    },
    createAction(athleteId, input) {
      const command = createRecoveryActionRequestSchema.parse(input);
      const request = { operation: 'recovery_action_create', ...command };
      const key = 'recovery-action:' + command.idempotencyKey;
      return database.tenant(athleteId, async (tx) => {
        await lockCommands(tx);
        const prior = await replay(tx, key, request, recoveryActionLogSchema);
        if (prior) {
          const current = await currentAction(tx, prior.actionId);
          if (current === null || current.status === 'deleted')
            throw new RecoveryReferenceError('ACTION_NOT_FOUND');
          return prior;
        }
        if (Date.parse(command.occurredAt) > now().getTime() + 5 * 60_000)
          throw new RecoveryValidationError();
        await validateActionLinks(tx, command);
        const { idempotencyKey: _key, ...fields } = command;
        void _key;
        const saved = recoveryActionLogSchema.parse({
          schemaVersion: 1,
          actionId: randomUUID(),
          revisionId: randomUUID(),
          revision: 1,
          status: 'active',
          recordedAt: now().toISOString(),
          ...fields,
        });
        await tx.query(
          `INSERT INTO recovery_action_log(athlete_id,action_id,revision,revision_id,status)
           VALUES($1,$2,1,$3,'active')`,
          [athleteId, saved.actionId, saved.revisionId],
        );
        await tx.query(
          `INSERT INTO recovery_action_revision
           (athlete_id,action_id,revision,revision_id,status,record_json)
           VALUES($1,$2,1,$3,'active',$4::jsonb)`,
          [athleteId, saved.actionId, saved.revisionId, JSON.stringify(saved)],
        );
        return finish(tx, key, request, saved, 'recovery.action.created', saved.actionId);
      });
    },
    correctAction(athleteId, input) {
      const command = correctRecoveryActionRequestSchema.parse(input);
      const request = { operation: 'recovery_action_correct', ...command };
      const key = 'recovery-action-correct:' + command.idempotencyKey;
      return database.tenant(athleteId, async (tx) => {
        await lockCommands(tx);
        const prior = await replay(tx, key, request, recoveryActionLogSchema);
        if (prior) {
          const current = await currentAction(tx, prior.actionId);
          if (current === null || current.status === 'deleted')
            throw new RecoveryReferenceError('ACTION_NOT_FOUND');
          return prior;
        }
        const current = await currentAction(tx, command.actionId);
        if (current === null || current.status === 'deleted')
          throw new RecoveryReferenceError('ACTION_NOT_FOUND');
        if (current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        if (Date.parse(command.occurredAt) > now().getTime() + 5 * 60_000)
          throw new RecoveryValidationError();
        await validateActionLinks(tx, command);
        const { actionId, expectedRevision: _revision, idempotencyKey: _key, ...fields } = command;
        void _revision;
        void _key;
        const saved = recoveryActionLogSchema.parse({
          schemaVersion: 1,
          actionId,
          revisionId: randomUUID(),
          revision: current.revision + 1,
          status: 'active',
          recordedAt: now().toISOString(),
          ...fields,
        });
        await tx.query(
          `INSERT INTO recovery_action_revision
           (athlete_id,action_id,revision,revision_id,status,record_json)
           VALUES($1,$2,$3,$4,'active',$5::jsonb)`,
          [athleteId, actionId, saved.revision, saved.revisionId, JSON.stringify(saved)],
        );
        await tx.query(
          `UPDATE recovery_action_log SET revision=$3,revision_id=$4
           WHERE athlete_id=$1 AND action_id=$2`,
          [athleteId, actionId, saved.revision, saved.revisionId],
        );
        return finish(tx, key, request, saved, 'recovery.action.corrected', saved.actionId);
      });
    },
    deleteAction(athleteId, input) {
      const command = deleteRecoveryActionRequestSchema.parse(input);
      const request = { operation: 'recovery_action_delete', ...command };
      const key = 'recovery-action-delete:' + command.idempotencyKey;
      return database.tenant(athleteId, async (tx) => {
        await lockCommands(tx);
        const prior = await replay(tx, key, request, deletedRecoveryActionSchema);
        if (prior) return prior;
        const current = await currentAction(tx, command.actionId);
        if (current === null || current.status === 'deleted')
          throw new RecoveryReferenceError('ACTION_NOT_FOUND');
        if (current.revision !== command.expectedRevision)
          throw new PersistenceConflict('REVISION_CONFLICT');
        const saved = deletedRecoveryActionSchema.parse({
          actionId: current.actionId,
          revisionId: randomUUID(),
          revision: current.revision + 1,
          status: 'deleted',
          deletedAt: now().toISOString(),
        });
        await tx.query(
          `INSERT INTO recovery_action_revision
           (athlete_id,action_id,revision,revision_id,status,record_json)
           VALUES($1,$2,$3,$4,'deleted',$5::jsonb)`,
          [athleteId, saved.actionId, saved.revision, saved.revisionId, JSON.stringify(saved)],
        );
        await tx.query(
          `UPDATE recovery_action_log SET revision=$3,revision_id=$4,status='deleted'
           WHERE athlete_id=$1 AND action_id=$2`,
          [athleteId, saved.actionId, saved.revision, saved.revisionId],
        );
        return finish(tx, key, request, saved, 'recovery.action.deleted', saved.actionId);
      });
    },
  };
}
