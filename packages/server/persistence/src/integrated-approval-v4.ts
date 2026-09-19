import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  integratedApprovalResultV4Schema,
  integratedCandidatePrepareV4Schema,
  integratedCandidateV4Schema,
  type IntegratedApprovalResultV4,
  type IntegratedCandidatePrepareV4,
  type IntegratedCandidateV4,
  type IntegratedWriteV4,
} from '@workout/contracts/integrated-coaching';
import { compareCoreEvidenceDependencies } from '@workout/contracts/evidence-dependencies';
import { coreEvidenceBodySchema } from '@workout/contracts/evidence-snapshots';
import {
  nutritionPlanVersionSchema,
  type NutritionPlanVersion,
} from '@workout/contracts/nutrition-core';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import {
  integratedApprovalV023Schema,
  integratedCoachingBasisV023Schema,
  type IntegratedCoachingBasisV023,
  type IntegratedApprovalV023,
  type PlanHeadExpectation,
} from '@workout/contracts/routines';
import type { Database, Transaction } from './database.js';
import { captureCoreEvidenceDependencies } from './evidence-dependencies.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { persistPlanVersion } from './planning.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(z.string().parse(value)).toISOString();

function canonical(value: unknown): string {
  if (value === undefined) throw new TypeError('Undefined is not canonical JSON');
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Value is not canonical JSON');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compare(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const receiptKey = (kind: 'prepare' | 'approve', key: string) =>
  `integrated-v4:${kind}:${createHash('sha256').update(key).digest('hex')}`;
const requiredDependencyKinds = [
  'activity-head',
  'intake-head',
  'supplementary-execution-head',
  'supplementary-set-head',
  'food-catalog-head',
  'exercise-catalog-head',
  'routine-catalog-head',
  'routine-run-head',
  'routine-occurrence-head',
  'routine-blueprint-head',
  'recovery-action-head',
  'recovery-method-head',
  'check-in-head',
  'session-completion-head',
  'coaching-constraint-head',
  'ai-consent',
] as const;

export class IntegratedApprovalV4Error extends Error {
  constructor(
    readonly code:
      | 'CANDIDATE_UNAVAILABLE'
      | 'CANDIDATE_MISMATCH'
      | 'CANDIDATE_NOT_APPROVABLE'
      | 'STALE_BASIS'
      | 'AI_CONSENT_REQUIRED',
  ) {
    super(code);
  }
}

export interface IntegratedApprovalV4Repository {
  captureBasis(
    athleteId: string,
    input: IntegratedApprovalV4BasisInput,
  ): Promise<IntegratedCoachingBasisV023>;
  prepareInternal(
    athleteId: string,
    input: IntegratedCandidatePrepareV4,
  ): Promise<IntegratedCandidateV4>;
  read(athleteId: string, candidateId: string): Promise<IntegratedCandidateV4 | null>;
  approve(athleteId: string, input: IntegratedApprovalV023): Promise<IntegratedApprovalResultV4>;
}

export interface IntegratedApprovalV4BasisInput {
  evidenceSnapshotId: string;
  trainingAggregateId: string;
  nutritionAggregateId: string;
  recoveryAggregateId: string;
  routineScheduleAggregateId: string;
}

const basisInputSchema = z.strictObject({
  evidenceSnapshotId: uuid,
  trainingAggregateId: uuid,
  nutritionAggregateId: uuid,
  recoveryAggregateId: uuid,
  routineScheduleAggregateId: uuid,
});

const capturedBasisRowSchema = z.object({
  evidence_body: coreEvidenceBodySchema,
  conversation_revision: z.coerce.number().int().nonnegative(),
  consent_revision: z.coerce.number().int().nonnegative().nullable(),
  consent_granted: z.boolean().nullable(),
  constraint_revision: z.coerce.number().int().nonnegative(),
  training_version_id: uuid.nullable(),
  nutrition_version_id: uuid.nullable(),
  recovery_version_id: uuid.nullable(),
  routine_schedule_version_id: uuid.nullable(),
  training_head_conflict: z.boolean(),
  intake_revision: z.coerce.number().int().nonnegative(),
  activity_revision: z.coerce.number().int().nonnegative(),
  execution_revision: z.coerce.number().int().nonnegative(),
  set_revision: z.coerce.number().int().nonnegative(),
  food_revision: z.coerce.number().int().nonnegative(),
  exercise_revision: z.coerce.number().int().nonnegative(),
  routine_revision: z.coerce.number().int().nonnegative(),
  routine_run_revision: z.coerce.number().int().nonnegative(),
  routine_occurrence_revision: z.coerce.number().int().nonnegative(),
  routine_blueprint_revision: z.coerce.number().int().nonnegative(),
  recovery_action_revision: z.coerce.number().int().nonnegative(),
  recovery_method_revision: z.coerce.number().int().nonnegative(),
  check_in_revision: z.coerce.number().int().nonnegative(),
  session_completion_revision: z.coerce.number().int().nonnegative(),
});

async function captureBasis(
  tx: Transaction,
  raw: IntegratedApprovalV4BasisInput,
  policyVersion: string,
): Promise<IntegratedCoachingBasisV023> {
  const input = basisInputSchema.parse(raw);
  const result = await tx.query(
    `SELECT e.body AS evidence_body,t.revision AS conversation_revision,
       c.revision AS consent_revision,c.granted AS consent_granted,
       coalesce(ch.revision,0) AS constraint_revision,
       ph.version_id AS training_version_id,nh.version_id AS nutrition_version_id,
       rh.version_id AS recovery_version_id,sh.version_id AS routine_schedule_version_id,
       EXISTS(SELECT 1 FROM plan_head other
         WHERE other.athlete_id=e.athlete_id AND other.aggregate_id<>$3) AS training_head_conflict,
       coalesce(d.intake_revision,0) AS intake_revision,
       coalesce(d.activity_revision,0) AS activity_revision,
       coalesce(d.execution_revision,0) AS execution_revision,
       coalesce(d.set_revision,0) AS set_revision,
       coalesce(d.food_revision,0) AS food_revision,
       coalesce(d.exercise_revision,0) AS exercise_revision,
       coalesce(d.routine_revision,0) AS routine_revision,
       coalesce(d.routine_run_revision,0) AS routine_run_revision,
       coalesce(d.routine_occurrence_revision,0) AS routine_occurrence_revision,
       coalesce(d.routine_blueprint_revision,0) AS routine_blueprint_revision,
       coalesce(d.recovery_action_revision,0) AS recovery_action_revision,
       coalesce(d.recovery_method_revision,0) AS recovery_method_revision,
       coalesce(ci.revision,0) AS check_in_revision,
       coalesce(sc.revision,0) AS session_completion_revision
     FROM core_evidence_snapshot e
     JOIN coaching_thread t ON t.athlete_id=e.athlete_id AND t.id=e.thread_id
     LEFT JOIN consent c ON c.athlete_id=e.athlete_id AND c.kind='ai'
     LEFT JOIN coaching_constraint_head ch ON ch.athlete_id=e.athlete_id
     LEFT JOIN plan_head ph ON ph.athlete_id=e.athlete_id AND ph.aggregate_id=$3
     LEFT JOIN nutrition_plan_head nh
       ON nh.athlete_id=e.athlete_id AND nh.plan_id=$4
     LEFT JOIN recovery_strategy_head rh
       ON rh.athlete_id=e.athlete_id AND rh.strategy_id=$5
     LEFT JOIN routine_schedule_head sh
       ON sh.athlete_id=e.athlete_id AND sh.schedule_id=$6
     LEFT JOIN integrated_dependency_head d ON d.athlete_id=e.athlete_id
     LEFT JOIN check_in_collection_head ci ON ci.athlete_id=e.athlete_id
     LEFT JOIN session_completion_collection_head sc ON sc.athlete_id=e.athlete_id
     WHERE e.athlete_id=$1 AND e.id=$2 AND e.body IS NOT NULL AND e.purged_reason IS NULL`,
    [
      tx.athleteId,
      input.evidenceSnapshotId,
      input.trainingAggregateId,
      input.nutritionAggregateId,
      input.recoveryAggregateId,
      input.routineScheduleAggregateId,
    ],
  );
  if (!result.rows[0]) throw new IntegratedApprovalV4Error('STALE_BASIS');
  const row = capturedBasisRowSchema.parse(result.rows[0]);
  if (row.training_head_conflict) throw new IntegratedApprovalV4Error('STALE_BASIS');
  if (row.consent_granted !== true || row.consent_revision === null)
    throw new IntegratedApprovalV4Error('AI_CONSENT_REQUIRED');
  const currentEvidenceDependencies = await captureCoreEvidenceDependencies(tx);
  if (
    compareCoreEvidenceDependencies(row.evidence_body.dependencies, currentEvidenceDependencies)
      .status !== 'fresh'
  )
    throw new IntegratedApprovalV4Error('STALE_BASIS');
  const revisions: Record<(typeof requiredDependencyKinds)[number], string> = {
    'activity-head': String(row.activity_revision),
    'intake-head': String(row.intake_revision),
    'supplementary-execution-head': String(row.execution_revision),
    'supplementary-set-head': String(row.set_revision),
    'food-catalog-head': String(row.food_revision),
    'exercise-catalog-head': String(row.exercise_revision),
    'routine-catalog-head': String(row.routine_revision),
    'routine-run-head': String(row.routine_run_revision),
    'routine-occurrence-head': String(row.routine_occurrence_revision),
    'routine-blueprint-head': String(row.routine_blueprint_revision),
    'recovery-action-head': String(row.recovery_action_revision),
    'recovery-method-head': String(row.recovery_method_revision),
    'check-in-head': String(row.check_in_revision),
    'session-completion-head': String(row.session_completion_revision),
    'coaching-constraint-head': String(row.constraint_revision),
    'ai-consent': `${row.consent_revision}:true`,
  };
  const head = (versionId: string | null) =>
    versionId === null ? ({ kind: 'absent' } as const) : ({ kind: 'exists', versionId } as const);
  return integratedCoachingBasisV023Schema.parse({
    schemaVersion: 4,
    planHeads: [
      {
        domain: 'training',
        aggregateId: input.trainingAggregateId,
        head: head(row.training_version_id),
      },
      {
        domain: 'nutrition',
        aggregateId: input.nutritionAggregateId,
        head: head(row.nutrition_version_id),
      },
      {
        domain: 'recovery',
        aggregateId: input.recoveryAggregateId,
        head: head(row.recovery_version_id),
      },
      {
        domain: 'routine_schedule',
        aggregateId: input.routineScheduleAggregateId,
        head: head(row.routine_schedule_version_id),
      },
    ],
    contextDependencies: requiredDependencyKinds.map((kind) => ({
      kind,
      id: 'tenant',
      revision: revisions[kind],
    })),
    preferenceRevision: row.constraint_revision,
    constraintRevision: row.constraint_revision,
    conversationRevision: row.conversation_revision,
    policyVersion,
    evidenceSnapshotId: input.evidenceSnapshotId,
  });
}

async function lock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [tx.athleteId]);
}

async function replay(tx: Transaction, key: string, request: unknown): Promise<unknown | null> {
  const row = (
    await tx.query(
      'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
      [tx.athleteId, key, JSON.stringify(request)],
    )
  ).rows[0];
  if (!row) return null;
  if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return row['result'];
}

async function finish(tx: Transaction, key: string, request: unknown, result: unknown) {
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify(result)],
  );
}

async function readCandidate(tx: Transaction, candidateId: string) {
  const row = (
    await tx.query(
      'SELECT id,proposal_id,digest,body,created_at FROM integrated_candidate_v4 WHERE athlete_id=$1 AND id=$2',
      [tx.athleteId, candidateId],
    )
  ).rows[0];
  if (!row) return null;
  const candidate = integratedCandidateV4Schema.safeParse(row['body']);
  if (
    !candidate.success ||
    candidate.data.id !== row['id'] ||
    candidate.data.proposalId !== row['proposal_id'] ||
    candidate.data.digest !== row['digest'] ||
    candidate.data.createdAt !== iso(row['created_at'])
  )
    return null;
  return candidate.data;
}

async function currentHead(tx: Transaction, expected: PlanHeadExpectation): Promise<string | null> {
  if (expected.domain === 'training') {
    const row = (
      await tx.query('SELECT version_id FROM plan_head WHERE athlete_id=$1 AND aggregate_id=$2', [
        tx.athleteId,
        expected.aggregateId,
      ])
    ).rows[0];
    return row ? uuid.parse(row['version_id']) : null;
  }
  const table =
    expected.domain === 'nutrition'
      ? ['nutrition_plan_head', 'plan_id']
      : expected.domain === 'recovery'
        ? ['recovery_strategy_head', 'strategy_id']
        : ['routine_schedule_head', 'schedule_id'];
  const row = (
    await tx.query(`SELECT version_id FROM ${table[0]} WHERE athlete_id=$1 AND ${table[1]}=$2`, [
      tx.athleteId,
      expected.aggregateId,
    ])
  ).rows[0];
  return row ? uuid.parse(row['version_id']) : null;
}

async function assertFresh(
  tx: Transaction,
  candidate: IntegratedCandidateV4,
  policyVersion: string,
) {
  if (candidate.basis.policyVersion !== policyVersion)
    throw new IntegratedApprovalV4Error('STALE_BASIS');
  const consent = (
    await tx.query("SELECT revision,granted FROM consent WHERE athlete_id=$1 AND kind='ai'", [
      tx.athleteId,
    ])
  ).rows[0];
  if (!consent || consent['granted'] !== true)
    throw new IntegratedApprovalV4Error('AI_CONSENT_REQUIRED');
  const evidence = (
    await tx.query(
      `SELECT t.revision,e.body FROM core_evidence_snapshot e JOIN coaching_thread t
       ON t.athlete_id=e.athlete_id AND t.id=e.thread_id
       WHERE e.athlete_id=$1 AND e.id=$2 AND e.body IS NOT NULL AND e.purged_reason IS NULL`,
      [tx.athleteId, candidate.basis.evidenceSnapshotId],
    )
  ).rows[0];
  if (!evidence || Number(evidence['revision']) !== candidate.basis.conversationRevision)
    throw new IntegratedApprovalV4Error('STALE_BASIS');
  const evidenceBody = coreEvidenceBodySchema.safeParse(evidence['body']);
  if (
    !evidenceBody.success ||
    compareCoreEvidenceDependencies(
      evidenceBody.data.dependencies,
      await captureCoreEvidenceDependencies(tx),
    ).status !== 'fresh'
  )
    throw new IntegratedApprovalV4Error('STALE_BASIS');

  const constraintRevision = Number(
    (
      await tx.query(
        'SELECT coalesce((SELECT revision FROM coaching_constraint_head WHERE athlete_id=$1),0) AS revision',
        [tx.athleteId],
      )
    ).rows[0]?.['revision'],
  );
  if (
    constraintRevision !== candidate.basis.constraintRevision ||
    constraintRevision !== candidate.basis.preferenceRevision
  )
    throw new IntegratedApprovalV4Error('STALE_BASIS');

  for (const expectation of candidate.basis.planHeads) {
    const actual = await currentHead(tx, expectation);
    const expected = expectation.head.kind === 'exists' ? expectation.head.versionId : null;
    if (actual !== expected) throw new IntegratedApprovalV4Error('STALE_BASIS');
  }

  const heads = (
    await tx.query(
      `SELECT coalesce(i.intake_revision,0) AS intake,coalesce(i.activity_revision,0) AS activity,
       coalesce(i.execution_revision,0) AS execution,coalesce(i.set_revision,0) AS sets,
       coalesce(i.food_revision,0) AS food,coalesce(i.exercise_revision,0) AS exercise,
       coalesce(i.routine_revision,0) AS supplementary_routine,
       coalesce(i.routine_run_revision,0) AS routine_run,
       coalesce(i.routine_occurrence_revision,0) AS routine_occurrence,
       coalesce(i.routine_blueprint_revision,0) AS routine_blueprint,
       coalesce(i.recovery_action_revision,0) AS recovery_action,
       coalesce(i.recovery_method_revision,0) AS recovery_method,
       coalesce((SELECT revision FROM check_in_collection_head WHERE athlete_id=$1),0) AS check_ins,
       coalesce((SELECT revision FROM session_completion_collection_head WHERE athlete_id=$1),0) AS completions
       FROM (SELECT $1::text AS athlete_id) owner LEFT JOIN integrated_dependency_head i
         ON i.athlete_id=owner.athlete_id`,
      [tx.athleteId],
    )
  ).rows[0];
  const values: Record<string, unknown> = {
    'intake-head': heads?.['intake'],
    'activity-head': heads?.['activity'],
    'supplementary-execution-head': heads?.['execution'],
    'supplementary-set-head': heads?.['sets'],
    'food-catalog-head': heads?.['food'],
    'exercise-catalog-head': heads?.['exercise'],
    'routine-catalog-head': heads?.['supplementary_routine'],
    'routine-run-head': heads?.['routine_run'],
    'routine-occurrence-head': heads?.['routine_occurrence'],
    'routine-blueprint-head': heads?.['routine_blueprint'],
    'recovery-action-head': heads?.['recovery_action'],
    'recovery-method-head': heads?.['recovery_method'],
    'check-in-head': heads?.['check_ins'],
    'session-completion-head': heads?.['completions'],
    'coaching-constraint-head': constraintRevision,
    'ai-consent': `${consent['revision']}:${consent['granted']}`,
  };
  const dependencies = new Map(
    candidate.basis.contextDependencies.map((dependency) => [dependency.kind, dependency]),
  );
  if (
    dependencies.size !== requiredDependencyKinds.length ||
    requiredDependencyKinds.some((kind) => !dependencies.has(kind)) ||
    [...dependencies.keys()].some(
      (kind) => !(requiredDependencyKinds as readonly string[]).includes(kind),
    )
  )
    throw new IntegratedApprovalV4Error('STALE_BASIS');
  for (const dependency of candidate.basis.contextDependencies) {
    if (
      dependency.id !== 'tenant' ||
      values[dependency.kind] === undefined ||
      String(values[dependency.kind]) !== dependency.revision
    )
      throw new IntegratedApprovalV4Error('STALE_BASIS');
  }

  for (const write of candidate.writes) {
    if (write.domain !== 'recovery') continue;
    for (const reference of write.proposed.planRefs) {
      const expected = candidate.basis.planHeads.find(
        (head) => head.domain === reference.kind && head.aggregateId === reference.aggregateId,
      );
      if (expected?.head.kind !== 'exists' || expected.head.versionId !== reference.headVersionId)
        throw new IntegratedApprovalV4Error('STALE_BASIS');
    }
    const selected = write.proposed.options.find((option) => option.id === write.selectedOptionId);
    if (!selected) throw new IntegratedApprovalV4Error('CANDIDATE_NOT_APPROVABLE');
    if (selected.methodVersionId !== null) {
      const method = await tx.query(
        'SELECT 1 FROM recovery_method_version WHERE athlete_id=$1 AND version_id=$2',
        [tx.athleteId, selected.methodVersionId],
      );
      if (!method.rowCount) throw new IntegratedApprovalV4Error('CANDIDATE_NOT_APPROVABLE');
    }
  }
}

async function saveNutrition(
  tx: Transaction,
  write: Extract<IntegratedWriteV4, { domain: 'nutrition' }>,
  previousVersionId: string | null,
  approvedAt: string,
  linkedTrainingVersions: ReadonlyMap<string, string>,
): Promise<string> {
  const previousRow = previousVersionId
    ? (
        await tx.query(
          'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
          [tx.athleteId, previousVersionId],
        )
      ).rows[0]
    : undefined;
  const previous = previousRow
    ? nutritionPlanVersionSchema.parse(previousRow['record_json'])
    : null;
  const versionId = randomUUID();
  const approvalId = randomUUID();
  const linked = write.proposed.linkedTrainingPlanVersionId;
  const linkedTrainingPlanVersionId =
    linked === null ? null : (linkedTrainingVersions.get(linked) ?? linked);
  const sessions = new Set<string>();
  if (linkedTrainingPlanVersionId !== null) {
    const found = await tx.query('SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
      tx.athleteId,
      linkedTrainingPlanVersionId,
    ]);
    if (!found.rowCount) throw new IntegratedApprovalV4Error('CANDIDATE_NOT_APPROVABLE');
    for (const session of planDraftSchema.parse(found.rows[0]?.['draft']).sessions) {
      sessions.add(session.id);
    }
  }
  if (
    write.proposed.items.some(
      (item) => item.anchor.kind === 'relative' && !sessions.has(item.anchor.entityId),
    )
  )
    throw new IntegratedApprovalV4Error('CANDIDATE_NOT_APPROVABLE');
  const foodVersionIds = [
    ...new Set(
      write.proposed.items.flatMap((item) =>
        item.foods.flatMap((food) => (food.foodVersionId ? [food.foodVersionId] : [])),
      ),
    ),
  ];
  if (foodVersionIds.length > 0) {
    const foods = await tx.query(
      'SELECT version_id FROM food_definition_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[])',
      [tx.athleteId, foodVersionIds],
    );
    if (foods.rowCount !== foodVersionIds.length)
      throw new IntegratedApprovalV4Error('CANDIDATE_NOT_APPROVABLE');
  }
  const saved: NutritionPlanVersion = nutritionPlanVersionSchema.parse({
    ...write.proposed,
    planId: write.aggregateId,
    versionId,
    version: (previous?.version ?? 0) + 1,
    previousVersionId: previous?.versionId ?? null,
    approvedAt,
    approvalId,
    linkedTrainingPlanVersionId,
    items: write.proposed.items.map((item) => ({ ...item, planVersionId: versionId })),
  });
  await tx.query(
    `INSERT INTO nutrition_plan_version
     (athlete_id,plan_id,version_id,version,previous_version_id,previous_version,period_from,period_to,
      linked_training_plan_version_id,approval_id,approved_at,record_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      tx.athleteId,
      saved.planId,
      saved.versionId,
      saved.version,
      saved.previousVersionId,
      previous?.version ?? null,
      saved.period.from,
      saved.period.toInclusive,
      saved.linkedTrainingPlanVersionId,
      saved.approvalId,
      saved.approvedAt,
      JSON.stringify(saved),
    ],
  );
  await tx.query(
    `INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,$3,$4)
     ON CONFLICT(athlete_id,plan_id) DO UPDATE SET version=EXCLUDED.version,version_id=EXCLUDED.version_id`,
    [tx.athleteId, saved.planId, saved.version, saved.versionId],
  );
  await tx.query(
    "INSERT INTO nutrition_plan_history(athlete_id,plan_id,version_id,approval_id,action) VALUES($1,$2,$3,$4,'candidate_approved')",
    [tx.athleteId, saved.planId, saved.versionId, saved.approvalId],
  );
  return saved.versionId;
}

async function reviewedRelativeNutritionIds(
  tx: Transaction,
  previousVersionId: string | null,
  proposed: PlanDraft,
) {
  if (previousVersionId === null) return [];
  const row = (
    await tx.query('SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
      tx.athleteId,
      previousVersionId,
    ])
  ).rows[0];
  if (!row) throw new IntegratedApprovalV4Error('STALE_BASIS');
  const previous = planDraftSchema.parse(row['draft']);
  const before = new Map(previous.sessions.map((session) => [session.id, session]));
  const after = new Map(proposed.sessions.map((session) => [session.id, session]));
  const timezoneChanged = previous.timezone !== proposed.timezone;
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((id) => {
    const old = before.get(id);
    const next = after.get(id);
    return (
      !old ||
      !next ||
      timezoneChanged ||
      old.date !== next.date ||
      old.localStartTime !== next.localStartTime ||
      old.durationSeconds !== next.durationSeconds ||
      !same(old.durationRange ?? null, next.durationRange ?? null)
    );
  });
  if (changed.length === 0) return [];
  const rows = await tx.query(
    `SELECT h.plan_id FROM nutrition_plan_head h JOIN nutrition_plan_version v
       ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
     WHERE h.athlete_id=$1 AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(v.record_json->'items') item
       WHERE item->'anchor'->>'kind'='relative'
         AND item->'anchor'->>'entityId'=ANY($2::text[])
     ) ORDER BY h.plan_id`,
    [tx.athleteId, changed],
  );
  return rows.rows.map((item) => String(item['plan_id']));
}

export function createIntegratedApprovalV4Repository(
  database: Database,
  options: { policyVersion: string },
): IntegratedApprovalV4Repository {
  const policyVersion = z.string().min(1).max(200).parse(options.policyVersion);
  const guarded = <T>(athleteId: string, operation: (tx: Transaction) => Promise<T>) =>
    database.tenant(athleteId, async (tx) => {
      await lock(tx);
      return operation(tx);
    });
  return {
    captureBasis(athleteId, input) {
      return guarded(athleteId, (tx) => captureBasis(tx, input, policyVersion));
    },
    prepareInternal(athleteId, raw) {
      const input = integratedCandidatePrepareV4Schema.parse(raw);
      const key = receiptKey('prepare', input.idempotencyKey);
      const payload = {
        proposalId: input.proposalId,
        basis: input.basis,
        writes: input.writes,
        summary: input.summary,
        validation: input.validation,
      };
      const request = { kind: 'integrated_prepare_v4', digest: sha256(payload) };
      return guarded(athleteId, async (tx) => {
        const prior = await replay(tx, key, request);
        if (prior !== null) {
          const candidateId = uuid.parse(z.object({ candidateId: uuid }).parse(prior).candidateId);
          const candidate = await readCandidate(tx, candidateId);
          if (!candidate) throw new IntegratedApprovalV4Error('CANDIDATE_UNAVAILABLE');
          return candidate;
        }
        const createdAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        const candidate = integratedCandidateV4Schema.parse({
          schemaVersion: 4,
          id: randomUUID(),
          ...payload,
          digest: sha256(payload),
          createdAt,
        });
        await assertFresh(tx, candidate, policyVersion);
        await tx.query(
          `INSERT INTO integrated_candidate_v4(athlete_id,id,proposal_id,digest,body,created_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            athleteId,
            candidate.id,
            candidate.proposalId,
            candidate.digest,
            JSON.stringify(candidate),
            candidate.createdAt,
          ],
        );
        await finish(tx, key, request, { candidateId: candidate.id });
        return candidate;
      });
    },
    read(athleteId, candidateId) {
      const id = uuid.parse(candidateId);
      return database.tenant(athleteId, (tx) => readCandidate(tx, id));
    },
    approve(athleteId, raw) {
      const input = integratedApprovalV023Schema.parse(raw);
      const key = receiptKey('approve', input.idempotencyKey);
      const request = { kind: 'integrated_approve_v4', ...input };
      return guarded(athleteId, async (tx) => {
        const prior = await replay(tx, key, request);
        if (prior !== null) return integratedApprovalResultV4Schema.parse(prior);
        const candidate = await readCandidate(tx, input.candidateId);
        if (!candidate) throw new IntegratedApprovalV4Error('CANDIDATE_UNAVAILABLE');
        const candidateDomains = [...new Set(candidate.writes.map((write) => write.domain))].sort(
          compare,
        );
        if (
          candidate.proposalId !== input.proposalId ||
          candidate.digest !== input.proposalDigest ||
          !same(candidate.basis, input.expectedBasis) ||
          !same(candidateDomains, [...input.writeDomains].sort(compare))
        )
          throw new IntegratedApprovalV4Error('CANDIDATE_MISMATCH');
        if (
          candidate.validation.status !== 'checked' ||
          candidate.validation.errors.length > 0 ||
          candidate.validation.unknowns.length > 0
        )
          throw new IntegratedApprovalV4Error('CANDIDATE_NOT_APPROVABLE');
        await assertFresh(tx, candidate, policyVersion);

        const approvedAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        const approvalId = randomUUID();
        const versions: IntegratedApprovalResultV4['versions'] = [];
        const occurrenceIds: string[] = [];
        const linkedTrainingVersions = new Map<string, string>();
        const expectation = new Map(
          candidate.basis.planHeads.map((head) => [`${head.domain}:${head.aggregateId}`, head]),
        );

        for (const write of candidate.writes) {
          if (write.domain !== 'training') continue;
          const head = expectation.get(`training:${write.aggregateId}`);
          if (!head) throw new IntegratedApprovalV4Error('STALE_BASIS');
          const saved = await persistPlanVersion(tx, {
            expectedVersionId: head.head.kind === 'exists' ? head.head.versionId : null,
            aggregateId: write.aggregateId,
            draft: write.proposed,
            reviewedRelativeNutritionPlanIds: await reviewedRelativeNutritionIds(
              tx,
              head.head.kind === 'exists' ? head.head.versionId : null,
              write.proposed,
            ),
          });
          linkedTrainingVersions.set(write.aggregateId, saved.id);
          if (head.head.kind === 'exists') {
            linkedTrainingVersions.set(head.head.versionId, saved.id);
          }
          await tx.query(
            "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'candidate_approved')",
            [athleteId, saved.id],
          );
          versions.push({
            domain: 'training',
            aggregateId: write.aggregateId,
            versionId: saved.id,
          });
        }
        for (const write of candidate.writes) {
          if (write.domain !== 'nutrition') continue;
          const head = expectation.get(`nutrition:${write.aggregateId}`);
          if (!head) throw new IntegratedApprovalV4Error('STALE_BASIS');
          const versionId = await saveNutrition(
            tx,
            write,
            head.head.kind === 'exists' ? head.head.versionId : null,
            approvedAt,
            linkedTrainingVersions,
          );
          versions.push({ domain: 'nutrition', aggregateId: write.aggregateId, versionId });
        }
        for (const write of candidate.writes) {
          const head = expectation.get(`${write.domain}:${write.aggregateId}`);
          if (!head) throw new IntegratedApprovalV4Error('STALE_BASIS');
          if (write.domain === 'recovery') {
            const previousRow =
              head.head.kind === 'exists'
                ? (
                    await tx.query(
                      'SELECT record_json FROM recovery_strategy_version WHERE athlete_id=$1 AND version_id=$2',
                      [athleteId, head.head.versionId],
                    )
                  ).rows[0]
                : undefined;
            const previous = previousRow
              ? recoveryStrategyVersionSchema.parse(previousRow['record_json'])
              : null;
            const saved = recoveryStrategyVersionSchema.parse({
              schemaVersion: 1,
              strategyId: write.aggregateId,
              versionId: randomUUID(),
              version: (previous?.version ?? 0) + 1,
              previousVersionId: previous?.versionId ?? null,
              status: 'user_confirmed',
              selectedOptionId: write.selectedOptionId,
              createdAt: approvedAt,
              draft: write.proposed,
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
                saved.previousVersionId,
                previous?.version ?? null,
                JSON.stringify(saved),
              ],
            );
            await tx.query(
              `INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id)
               VALUES($1,$2,$3,$4) ON CONFLICT(athlete_id,strategy_id)
               DO UPDATE SET version=EXCLUDED.version,version_id=EXCLUDED.version_id`,
              [athleteId, saved.strategyId, saved.version, saved.versionId],
            );
            versions.push({
              domain: 'recovery',
              aggregateId: write.aggregateId,
              versionId: saved.versionId,
            });
          }
          if (write.domain === 'routine_schedule') {
            const previousVersionId = head.head.kind === 'exists' ? head.head.versionId : null;
            if (
              write.proposed.versionId === previousVersionId ||
              write.occurrences.some(
                (item) =>
                  item.schedule.id !== write.aggregateId ||
                  item.schedule.versionId !== write.proposed.versionId ||
                  item.blueprint.id !== write.proposed.blueprint.id ||
                  item.blueprint.versionId !== write.proposed.blueprint.versionId,
              )
            )
              throw new IntegratedApprovalV4Error('CANDIDATE_NOT_APPROVABLE');
            await tx.query(
              `INSERT INTO routine_schedule_version
               (athlete_id,schedule_id,version_id,prior_version_id,blueprint_routine_id,
                blueprint_version_id,source_plan_version_id,record_json,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
              [
                athleteId,
                write.aggregateId,
                write.proposed.versionId,
                previousVersionId,
                write.proposed.blueprint.id,
                write.proposed.blueprint.versionId,
                write.sourcePlanVersionId,
                JSON.stringify(write.proposed),
                approvedAt,
              ],
            );
            await tx.query(
              `INSERT INTO routine_schedule_head(athlete_id,schedule_id,version_id) VALUES($1,$2,$3)
               ON CONFLICT(athlete_id,schedule_id) DO UPDATE SET version_id=EXCLUDED.version_id`,
              [athleteId, write.aggregateId, write.proposed.versionId],
            );
            for (const item of write.occurrences) {
              await tx.query(
                `INSERT INTO routine_occurrence
                 (athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,
                  blueprint_version_id,anchor_key,scheduled_at,record_json)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
                [
                  athleteId,
                  item.id,
                  write.aggregateId,
                  write.proposed.versionId,
                  item.blueprint.id,
                  item.blueprint.versionId,
                  item.anchorKey,
                  item.scheduledAt,
                  JSON.stringify(item),
                ],
              );
              occurrenceIds.push(item.id);
            }
            versions.push({
              domain: 'routine_schedule',
              aggregateId: write.aggregateId,
              versionId: write.proposed.versionId,
            });
          }
        }

        versions.sort(
          (left, right) =>
            compare(left.domain, right.domain) || compare(left.aggregateId, right.aggregateId),
        );
        occurrenceIds.sort(compare);
        const result = integratedApprovalResultV4Schema.parse({
          schemaVersion: 4,
          approvalId,
          candidateId: candidate.id,
          versions,
          occurrenceIds,
          approvedAt,
        });
        await tx.query(
          `INSERT INTO integrated_approval_v4
           (athlete_id,approval_id,candidate_id,proposal_id,proposal_digest,write_domains,result_json,approved_at)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
          [
            athleteId,
            approvalId,
            candidate.id,
            candidate.proposalId,
            candidate.digest,
            JSON.stringify(candidateDomains),
            JSON.stringify(result),
            approvedAt,
          ],
        );
        for (const item of versions) {
          if (item.domain === 'recovery')
            await tx.query(
              "INSERT INTO recovery_strategy_history(athlete_id,version_id,approval_id,action) VALUES($1,$2,$3,'candidate_approved')",
              [athleteId, item.versionId, approvalId],
            );
          if (item.domain === 'routine_schedule')
            await tx.query(
              "INSERT INTO routine_schedule_history(athlete_id,version_id,approval_id,action) VALUES($1,$2,$3,'candidate_approved')",
              [athleteId, item.versionId, approvalId],
            );
        }
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: key,
          topic: 'integrated.candidate_approved_v4',
          payload: result,
        });
        await finish(tx, key, request, result);
        return result;
      });
    },
  };
}
