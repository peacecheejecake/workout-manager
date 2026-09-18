import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { coreEvidenceBodySchema } from '@workout/contracts/evidence-snapshots';
import { compareCoreEvidenceDependencies } from '@workout/contracts/evidence-dependencies';
import {
  jointCandidateV3Schema,
  jointCandidateDraftV3Schema,
  jointCandidatePartialSelectionV3Schema,
  jointNutritionPlanDraftV3Schema,
  jointNutritionPlanHeadV3Schema,
  type JointCandidateV3,
  type JointCandidatePartialSelectionV3,
  type JointCandidateWritesV3,
  type JointNutritionPlanContextV3,
  type JointSupplementaryLinkV3,
  type JointNutritionPlanDraftV3,
} from '@workout/contracts/joint-coaching';
import {
  jointApprovalRequestSchema,
  jointCoachingBasisSchema,
  type JointApprovalRequest,
  type JointCoachingBasis,
} from '@workout/contracts/nutrition';
import {
  nutritionPlanVersionSchema,
  type NutritionPlanVersion,
} from '@workout/contracts/nutrition-core';
import {
  planDraftSchema,
  planSnapshotSchema,
  type PlanDraft,
  type PlanSnapshot,
} from '@workout/contracts/planning';
import {
  sessionCompletionSchema,
  type SessionCompletion,
} from '@workout/contracts/session-completion';
import { supplementarySessionLinkSchema } from '@workout/contracts/supplementary-core';
import {
  compareJointCandidateFreshnessV3,
  derivePartialJointCandidateV3,
  projectJointCandidateV3,
  sealJointCandidateV3,
} from '@workout/server-coaching/joint-candidates';
import type { Database, Transaction } from './database.js';
import { enqueue, PersistenceConflict } from './outbox.js';
import { persistPlanVersion } from './planning.js';
import {
  persistSupplementarySessionLinks,
  type SupplementaryLinkChange,
} from './supplementary-plan-links.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const policySchema = z.strictObject({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
});
const prepareSchema = z.strictObject({
  runId: uuid,
  expectedBasis: jointCoachingBasisSchema,
  expectedNutritionPlanHeads: z.array(jointNutritionPlanHeadV3Schema).max(100),
  training: z
    .strictObject({
      proposed: planDraftSchema,
      supplementaryLinks: z
        .array(
          z.strictObject({
            schemaVersion: z.literal(2),
            plannedSessionId: supplementarySessionLinkSchema.shape.plannedSessionId,
            content: supplementarySessionLinkSchema.shape.content,
          }),
        )
        .max(1_000),
    })
    .nullable(),
  nutrition: z.array(z.strictObject({ planId: uuid, proposed: z.unknown() })).max(100),
  idempotencyKey,
});
const partialSchema = z.strictObject({
  selection: jointCandidatePartialSelectionV3Schema,
  idempotencyKey,
});
const receiptResultSchema = z.strictObject({
  trainingVersionId: uuid.nullable(),
  nutritionVersionIds: z.array(uuid).max(100),
});
const compare = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);
const iso = (value: unknown) => z.coerce.date().parse(value).toISOString();

function canonical(value: unknown): string {
  if (value === undefined) throw new TypeError('Undefined cannot be compared');
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Unserializable value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => compare(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Unserializable value');
  return canonical(JSON.parse(serialized) as unknown);
}
const receiptKey = (kind: 'prepare' | 'partial' | 'approve', key: string) =>
  `joint:${kind}:${createHash('sha256').update(key).digest('hex')}`;

export class JointApprovalError extends Error {
  constructor(
    readonly code:
      | 'RUN_NOT_READY'
      | 'CANDIDATE_UNAVAILABLE'
      | 'CANDIDATE_DIGEST_MISMATCH'
      | 'CANDIDATE_NOT_APPROVABLE'
      | 'CANDIDATE_LIMIT_REACHED'
      | 'STALE_BASIS'
      | 'AI_CONSENT_REQUIRED'
      | 'INVALID_PROJECTION'
      | 'INVALID_PARTIAL_SELECTION'
      | 'NUTRITION_REFERENCE_INVALID',
  ) {
    super(code);
  }
}

export interface JointApprovalResult {
  training: PlanSnapshot | null;
  nutrition: NutritionPlanVersion[];
}
export interface JointBasisCapture {
  basis: JointCoachingBasis;
  nutritionPlanHeads: JointCandidateV3['nutritionPlanHeads'];
}
export interface JointApprovalRepository {
  capture(
    athleteId: string,
    runId: string,
    scope: JointCandidateWritesV3['scope'],
    nutritionPlanIds?: readonly string[],
  ): Promise<JointBasisCapture>;
  /** Server application/worker only. Never expose this writer as a browser endpoint. */
  prepareInternal(
    athleteId: string,
    input: z.infer<typeof prepareSchema>,
  ): Promise<JointCandidateV3>;
  read(athleteId: string, candidateId: string): Promise<JointCandidateV3 | null>;
  list(athleteId: string, decisionId: string): Promise<JointCandidateV3[]>;
  derivePartial(
    athleteId: string,
    parentCandidateId: string,
    input: { selection: JointCandidatePartialSelectionV3; idempotencyKey: string },
  ): Promise<JointCandidateV3>;
  approve(athleteId: string, request: JointApprovalRequest): Promise<JointApprovalResult>;
}

interface RunRow {
  id: string;
  threadId: string;
  evidenceSnapshotId: string;
  conversationRevision: number;
  storedBasis: unknown;
  status: unknown;
  evidenceAvailable: boolean;
  evidenceBody: unknown;
  outputAvailable: boolean;
}

async function readRun(
  tx: Transaction,
  runId: string,
  policy: z.infer<typeof policySchema>,
): Promise<RunRow> {
  const rows = await tx.query(
    `SELECT r.id,r.thread_id,r.evidence_snapshot_id,r.conversation_revision,r.basis,r.policy,r.status,
      t.revision AS thread_revision,e.body AS evidence_body,
      (e.body IS NOT NULL AND e.purged_reason IS NULL) AS evidence_available,
      (o.body IS NOT NULL AND o.purged_reason IS NULL) AS output_available
     FROM coaching_run r JOIN coaching_thread t ON t.athlete_id=r.athlete_id AND t.id=r.thread_id
     JOIN core_evidence_snapshot e ON e.athlete_id=r.athlete_id AND e.id=r.evidence_snapshot_id
     LEFT JOIN coaching_analysis_output o ON o.athlete_id=r.athlete_id AND o.run_id=r.id
     WHERE r.athlete_id=$1 AND r.id=$2`,
    [tx.athleteId, runId],
  );
  const row = rows.rows[0];
  if (!row) throw new JointApprovalError('RUN_NOT_READY');
  if (!same(policySchema.parse(row['policy']), policy))
    throw new JointApprovalError('RUN_NOT_READY');
  const status = z.object({ kind: z.string() }).parse(row['status']);
  if (!['analysis_ready', 'validated_final'].includes(status.kind))
    throw new JointApprovalError('RUN_NOT_READY');
  return {
    id: uuid.parse(row['id']),
    threadId: uuid.parse(row['thread_id']),
    evidenceSnapshotId: uuid.parse(row['evidence_snapshot_id']),
    conversationRevision: z.number().int().positive().parse(row['thread_revision']),
    storedBasis: row['basis'],
    status: row['status'],
    evidenceAvailable: row['evidence_available'] === true,
    evidenceBody: row['evidence_body'],
    outputAvailable: row['output_available'] === true,
  };
}

interface CurrentContext {
  run: RunRow;
  basis: JointCoachingBasis;
  training: PlanSnapshot | null;
  beforeSupplementaryLinks: JointSupplementaryLinkV3[];
  nutritionContexts: JointNutritionPlanContextV3[];
  completions: SessionCompletion[];
  asOfLocalDate: string;
}

async function captureContext(
  tx: Transaction,
  runId: string,
  scope: JointCandidateWritesV3['scope'],
  pinnedPlanIds: readonly string[],
  policy: z.infer<typeof policySchema>,
  fallbackTimezone = 'UTC',
): Promise<CurrentContext> {
  const run = await readRun(tx, runId, policy);
  return captureContextForRun(tx, run, scope, pinnedPlanIds, policy, fallbackTimezone);
}

async function captureContextForRun(
  tx: Transaction,
  run: RunRow,
  scope: JointCandidateWritesV3['scope'],
  pinnedPlanIds: readonly string[],
  policy: z.infer<typeof policySchema>,
  fallbackTimezone = 'UTC',
): Promise<CurrentContext> {
  if (!run.evidenceAvailable) throw new JointApprovalError('STALE_BASIS');
  const consentRows = await tx.query(
    "SELECT revision,granted FROM consent WHERE athlete_id=$1 AND kind='ai'",
    [tx.athleteId],
  );
  const consent = consentRows.rows[0];
  if (!consent || consent['granted'] !== true) throw new JointApprovalError('AI_CONSENT_REQUIRED');
  const trainingRows = await tx.query(
    'SELECT p.id,p.version,p.created_at,p.draft FROM plan_head h JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id WHERE h.athlete_id=$1',
    [tx.athleteId],
  );
  const trainingRow = trainingRows.rows[0];
  const training = trainingRow
    ? planSnapshotSchema.parse({
        id: trainingRow['id'],
        version: trainingRow['version'],
        createdAt: iso(trainingRow['created_at']),
        draft: trainingRow['draft'],
      })
    : null;
  const evidence = coreEvidenceBodySchema.safeParse(run.evidenceBody);
  if (
    !evidence.success ||
    evidence.data.schemaVersion !== 2 ||
    evidence.data.plan.id !== training?.id
  )
    throw new JointApprovalError('STALE_BASIS');
  const coreDependencies = (
    await tx.query(
      `SELECT jsonb_build_object(
        'schemaVersion',2,'scope','core-ledgers-v2','athleteId',$1::text,
        'capturedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'trainingPlan',COALESCE((SELECT jsonb_build_object('kind','exists','versionId',version_id) FROM plan_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
        'activities',(SELECT jsonb_build_object('count',count(*)::text,'revisionSum',coalesce(sum(revision),0)::text) FROM activity_canonical WHERE athlete_id=$1),
        'checkIns',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM check_in_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
        'sessionCompletions',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM session_completion_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
        'userConstraints',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision) FROM coaching_constraint_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
        'aiConsent',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision,'granted',granted) FROM consent WHERE athlete_id=$1 AND kind='ai'),'{"kind":"absent"}'::jsonb)
      ) AS manifest`,
      [tx.athleteId],
    )
  ).rows[0]?.['manifest'];
  if (
    compareCoreEvidenceDependencies(evidence.data.dependencies, coreDependencies).status !== 'fresh'
  )
    throw new JointApprovalError('STALE_BASIS');
  if (scope !== 'nutrition' && training === null) throw new JointApprovalError('STALE_BASIS');
  const nutritionRows = await tx.query(
    `SELECT h.plan_id,v.record_json FROM nutrition_plan_head h JOIN nutrition_plan_version v
       ON v.athlete_id=h.athlete_id AND v.version_id=h.version_id
      WHERE h.athlete_id=$1 ORDER BY h.plan_id LIMIT 101`,
    [tx.athleteId],
  );
  if (nutritionRows.rows.length > 100) throw new JointApprovalError('CANDIDATE_LIMIT_REACHED');
  const planVersions = new Map<string, NutritionPlanVersion | null>();
  for (const row of nutritionRows.rows) {
    const version = nutritionPlanVersionSchema.parse(row['record_json']);
    if (version.planId !== row['plan_id']) throw new JointApprovalError('STALE_BASIS');
    planVersions.set(version.planId, version);
  }
  for (const id of pinnedPlanIds) if (!planVersions.has(id)) planVersions.set(id, null);
  if (planVersions.size > 100) throw new JointApprovalError('CANDIDATE_LIMIT_REACHED');
  const nutritionContexts: JointNutritionPlanContextV3[] = [...planVersions.entries()]
    .sort(([a], [b]) => compare(a, b))
    .map(([planId, version]) => ({
      head: { planId, versionId: version?.versionId ?? null },
      version: version ?? null,
    }));
  const linksRows =
    training === null
      ? { rows: [] as Record<string, unknown>[] }
      : await tx.query(
          `SELECT planned_session_id,content_kind,routine_version_id,embedded_spec_json
       FROM supplementary_session_link WHERE athlete_id=$1 AND plan_version_id=$2 ORDER BY planned_session_id`,
          [tx.athleteId, training.id],
        );
  const beforeSupplementaryLinks = linksRows.rows.map((row) => ({
    schemaVersion: 2 as const,
    plannedSessionId: String(row['planned_session_id']),
    content:
      row['content_kind'] === 'routine_version'
        ? {
            kind: 'routine_version' as const,
            routineVersionId: uuid.parse(row['routine_version_id']),
          }
        : {
            kind: 'embedded' as const,
            spec: supplementarySessionLinkSchema.shape.content.options[1].shape.spec.parse(
              row['embedded_spec_json'],
            ),
          },
  }));
  const currentSessionIds =
    scope === 'nutrition' ? [] : (training?.draft.sessions.map((session) => session.id) ?? []);
  const completionRows = await tx.query(
    "SELECT record_json FROM session_completion WHERE athlete_id=$1 AND session_id=ANY($2::text[]) AND record_json->>'status'='completed' ORDER BY session_id LIMIT 1001",
    [tx.athleteId, currentSessionIds],
  );
  if (completionRows.rows.length > 1000) throw new JointApprovalError('CANDIDATE_LIMIT_REACHED');
  const completions = completionRows.rows.map((row) =>
    sessionCompletionSchema.parse(row['record_json']),
  );
  const revisions = (
    await tx.query(
      `SELECT coalesce(i.intake_revision,0) AS intake,coalesce(i.set_revision,0) AS sets,
       coalesce(i.execution_revision,0) AS executions,
       coalesce(i.food_revision,0) AS food,coalesce(i.exercise_revision,0) AS exercise,
       coalesce(i.routine_revision,0) AS routine,
       coalesce((SELECT revision FROM coaching_constraint_head WHERE athlete_id=$1),0) AS constraints,
       coalesce((SELECT revision FROM session_completion_collection_head WHERE athlete_id=$1),0) AS completions,
       coalesce((SELECT revision FROM check_in_collection_head WHERE athlete_id=$1),0) AS check_ins,
       coalesce(i.activity_revision,0) AS activities
     FROM (SELECT $1::text AS athlete_id) owner LEFT JOIN integrated_dependency_head i
       ON i.athlete_id=owner.athlete_id`,
      [tx.athleteId],
    )
  ).rows[0];
  if (!revisions) throw new JointApprovalError('STALE_BASIS');
  const number = (value: unknown) =>
    z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(value);
  const contextDependencies = [
    ['supplementary-set-head', revisions['sets']],
    ['supplementary-execution-head', revisions['executions']],
    ['routine-catalog-head', revisions['routine']],
    ['intake-head', revisions['intake']],
    ['food-catalog-head', revisions['food']],
    ['activity-head', revisions['activities']],
    ['session-completion-head', revisions['completions']],
    ['check-in-head', revisions['check_ins']],
    ['coaching-constraint-head', revisions['constraints']],
    ['ai-consent', `${consent['revision']}:${consent['granted']}`],
  ].map(([kind, revision]) => ({ kind: String(kind), id: 'tenant', revision: String(revision) }));
  const trainingDomain =
    training === null
      ? null
      : {
          planVersionId: training.id,
          activityDataRevision: number(revisions['activities']),
          exerciseCatalogRevision: number(revisions['exercise']),
        };
  const nutritionDomain = {
    planVersionId:
      nutritionContexts.find((entry) => entry.version !== null)?.head.versionId ?? null,
    intakeDataRevision: number(revisions['intake']),
    foodCatalogRevision: number(revisions['food']),
  };
  const domains =
    scope === 'training'
      ? { scope, training: trainingDomain, nutrition: null }
      : scope === 'nutrition'
        ? { scope, training: null, nutrition: nutritionDomain }
        : { scope, training: trainingDomain, nutrition: nutritionDomain };
  const basis = jointCoachingBasisSchema.parse({
    schemaVersion: 3,
    domains,
    contextDependencies,
    preferenceRevision: number(revisions['constraints']),
    constraintRevision: number(revisions['constraints']),
    conversationRevision: run.conversationRevision,
    policyVersion: policy.version,
    evidenceSnapshotId: run.evidenceSnapshotId,
  });
  const timezone =
    training?.draft.timezone ??
    nutritionContexts.find((entry) => entry.version !== null)?.version?.timezone ??
    fallbackTimezone;
  const today = (
    await tx.query("SELECT to_char(statement_timestamp() AT TIME ZONE $1,'YYYY-MM-DD') AS today", [
      timezone,
    ])
  ).rows[0]?.['today'];
  return {
    run,
    basis,
    training,
    beforeSupplementaryLinks,
    nutritionContexts,
    completions,
    asOfLocalDate: z.iso.date().parse(today),
  };
}

/** Internal fixture producer only: derive the same v3 manifest before a run exists. */
export interface JointFixtureCapture {
  basis: JointCoachingBasis;
  training: PlanSnapshot;
  nutrition: NutritionPlanVersion;
  nutritionPlanHeads: JointCandidateV3['nutritionPlanHeads'];
  supplementaryLinks: JointSupplementaryLinkV3[];
}

export async function captureJointFixtureContext(
  tx: Transaction,
  input: {
    threadId: string;
    evidenceSnapshotId: string;
    nutritionPlanId: string;
    expectedConversationRevision: number;
    policy: { id: string; version: string };
  },
): Promise<JointFixtureCapture> {
  const row = (
    await tx.query(
      `SELECT t.id AS thread_id,t.revision,e.id AS evidence_id,e.body AS evidence_body,
        e.purged_reason FROM coaching_thread t
        JOIN core_evidence_snapshot e ON e.athlete_id=t.athlete_id AND e.thread_id=t.id
        WHERE t.athlete_id=$1 AND t.id=$2 AND e.id=$3`,
      [tx.athleteId, uuid.parse(input.threadId), uuid.parse(input.evidenceSnapshotId)],
    )
  ).rows[0];
  if (!row) throw new JointApprovalError('RUN_NOT_READY');
  if (row['revision'] !== input.expectedConversationRevision)
    throw new JointApprovalError('STALE_BASIS');
  const run: RunRow = {
    id: randomUUID(),
    threadId: uuid.parse(row['thread_id']),
    evidenceSnapshotId: uuid.parse(row['evidence_id']),
    conversationRevision: z.number().int().positive().parse(row['revision']),
    storedBasis: null,
    status: { kind: 'queued' },
    evidenceAvailable: row['evidence_body'] !== null && row['purged_reason'] === null,
    evidenceBody: row['evidence_body'],
    outputAvailable: false,
  };
  const context = await captureContextForRun(
    tx,
    run,
    'combined',
    [uuid.parse(input.nutritionPlanId)],
    policySchema.parse(input.policy),
  );
  const nutrition = context.nutritionContexts.find(
    (entry) => entry.head.planId === input.nutritionPlanId,
  )?.version;
  if (!context.training || !nutrition) throw new JointApprovalError('NUTRITION_REFERENCE_INVALID');
  return {
    basis: context.basis,
    training: context.training,
    nutrition,
    nutritionPlanHeads: context.nutritionContexts.map((entry) => entry.head),
    supplementaryLinks: context.beforeSupplementaryLinks,
  };
}

async function lockJoint(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [tx.athleteId]);
}

async function receipt(tx: Transaction, key: string, request: unknown): Promise<unknown | null> {
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

const storedDecisionSchema = z.strictObject({
  schemaVersion: z.literal(3),
  kind: z.literal('joint-decision'),
  id: uuid,
  runId: uuid,
  basis: jointCoachingBasisSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
const storedProposalSchema = z.strictObject({
  schemaVersion: z.literal(3),
  kind: z.literal('joint-proposal'),
  id: uuid,
  decisionId: uuid,
  candidateId: uuid,
  createdAt: z.iso.datetime({ offset: true }),
});

async function readStoredCandidate(
  tx: Transaction,
  id: string,
): Promise<{ candidate: JointCandidateV3; runId: string } | null> {
  const row = (
    await tx.query(
      `SELECT c.id AS candidate_id,c.decision_id AS candidate_decision_id,c.proposal_id AS candidate_proposal_id,
      c.parent_candidate_id,c.digest,c.body AS candidate_body,c.created_at AS candidate_created_at,
      p.body AS proposal_body,p.created_at AS proposal_created_at,
      d.body AS decision_body,d.run_id,d.created_at AS decision_created_at,
      r.evidence_snapshot_id,r.status,r.basis AS run_basis,e.body AS evidence_body
     FROM coaching_candidate c JOIN coaching_proposal p ON p.athlete_id=c.athlete_id AND p.id=c.proposal_id
     JOIN coaching_decision d ON d.athlete_id=p.athlete_id AND d.id=p.decision_id
     JOIN coaching_run r ON r.athlete_id=d.athlete_id AND r.id=d.run_id
     JOIN core_evidence_snapshot e ON e.athlete_id=r.athlete_id AND e.id=r.evidence_snapshot_id
     WHERE c.athlete_id=$1 AND c.id=$2`,
      [tx.athleteId, id],
    )
  ).rows[0];
  if (
    !row ||
    !row['candidate_body'] ||
    !row['proposal_body'] ||
    !row['decision_body'] ||
    !row['evidence_body']
  )
    return null;
  const candidateResult = jointCandidateV3Schema.safeParse(row['candidate_body']);
  const proposalResult = storedProposalSchema.safeParse(row['proposal_body']);
  const decisionResult = storedDecisionSchema.safeParse(row['decision_body']);
  const runBasisResult = jointCoachingBasisSchema.safeParse(row['run_basis']);
  if (
    !candidateResult.success ||
    !proposalResult.success ||
    !decisionResult.success ||
    !runBasisResult.success
  )
    return null;
  const candidate = candidateResult.data;
  const proposal = proposalResult.data;
  const decision = decisionResult.data;
  const status = z
    .object({ kind: z.string(), decisionId: uuid.optional() })
    .safeParse(row['status']);
  if (
    !status.success ||
    status.data.kind !== 'validated_final' ||
    status.data.decisionId !== decision.id ||
    candidate.id !== id ||
    candidate.id !== row['candidate_id'] ||
    candidate.decisionId !== decision.id ||
    candidate.decisionId !== row['candidate_decision_id'] ||
    candidate.proposalId !== proposal.id ||
    candidate.proposalId !== row['candidate_proposal_id'] ||
    candidate.parentCandidateId !== row['parent_candidate_id'] ||
    candidate.digest !== row['digest'] ||
    candidate.createdAt !== iso(row['candidate_created_at']) ||
    proposal.decisionId !== decision.id ||
    proposal.candidateId !== candidate.id ||
    proposal.createdAt !== iso(row['proposal_created_at']) ||
    decision.id !== row['candidate_decision_id'] ||
    decision.runId !== row['run_id'] ||
    decision.createdAt !== iso(row['decision_created_at']) ||
    decision.basis.evidenceSnapshotId !== row['evidence_snapshot_id'] ||
    !same(decision.basis, runBasisResult.data)
  )
    return null;
  const freshness = compareJointCandidateFreshnessV3(candidate, {
    basis: candidate.basis,
    nutritionPlanHeads: candidate.nutritionPlanHeads,
  });
  if (freshness.status === 'unsupported') return null;
  return { candidate, runId: decision.runId };
}

async function readResult(tx: Transaction, raw: unknown): Promise<JointApprovalResult> {
  const ids = receiptResultSchema.parse(raw);
  let training: PlanSnapshot | null = null;
  if (ids.trainingVersionId !== null) {
    const row = (
      await tx.query(
        'SELECT id,version,created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2',
        [tx.athleteId, ids.trainingVersionId],
      )
    ).rows[0];
    if (!row) throw new JointApprovalError('CANDIDATE_UNAVAILABLE');
    training = planSnapshotSchema.parse({
      id: row['id'],
      version: row['version'],
      createdAt: iso(row['created_at']),
      draft: row['draft'],
    });
  }
  const nutrition: NutritionPlanVersion[] = [];
  for (const versionId of ids.nutritionVersionIds) {
    const row = (
      await tx.query(
        'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
        [tx.athleteId, versionId],
      )
    ).rows[0];
    if (!row) throw new JointApprovalError('CANDIDATE_UNAVAILABLE');
    nutrition.push(nutritionPlanVersionSchema.parse(row['record_json']));
  }
  return { training, nutrition };
}

async function saveCandidate(
  tx: Transaction,
  candidate: JointCandidateV3,
  decisionId: string,
  createdAt: string,
) {
  const proposal = storedProposalSchema.parse({
    schemaVersion: 3,
    kind: 'joint-proposal',
    id: candidate.proposalId,
    decisionId,
    candidateId: candidate.id,
    createdAt,
  });
  const body = JSON.stringify(candidate);
  if (Buffer.byteLength(body) > 3 * 1024 * 1024)
    throw new JointApprovalError('CANDIDATE_LIMIT_REACHED');
  await tx.query(
    'INSERT INTO coaching_proposal(athlete_id,id,decision_id,body,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',
    [tx.athleteId, proposal.id, decisionId, JSON.stringify(proposal), createdAt],
  );
  await tx.query(
    `INSERT INTO coaching_candidate(athlete_id,id,decision_id,proposal_id,parent_candidate_id,digest,body,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      tx.athleteId,
      candidate.id,
      decisionId,
      candidate.proposalId,
      candidate.parentCandidateId,
      candidate.digest,
      body,
      createdAt,
    ],
  );
}

function linkChanges(
  before: readonly JointSupplementaryLinkV3[],
  after: readonly JointSupplementaryLinkV3[],
  nextDraft: PlanDraft,
): SupplementaryLinkChange[] {
  const strengthIds = new Set(
    nextDraft.sessions
      .filter((session) => session.sport === 'strength')
      .map((session) => session.id),
  );
  const next = new Map(after.map((link) => [link.plannedSessionId, link.content]));
  return changedLinkIds(before, after)
    .filter((id) => strengthIds.has(id))
    .map((id) => ({ plannedSessionId: id, content: next.get(id) ?? null }));
}

function changedLinkIds(
  before: readonly JointSupplementaryLinkV3[],
  after: readonly JointSupplementaryLinkV3[],
): string[] {
  const old = new Map(before.map((link) => [link.plannedSessionId, link.content]));
  const next = new Map(after.map((link) => [link.plannedSessionId, link.content]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .sort(compare)
    .filter((id) => !same(old.get(id) ?? null, next.get(id) ?? null));
}

async function saveNutritionPlan(
  tx: Transaction,
  planId: string,
  previous: NutritionPlanVersion | null,
  proposed: JointNutritionPlanDraftV3,
  approvedAt: string,
  training: PlanSnapshot | null,
  oldTrainingVersionId: string | null,
): Promise<NutritionPlanVersion> {
  const linkedTrainingPlanVersionId =
    training !== null && proposed.linkedTrainingPlanVersionId === oldTrainingVersionId
      ? training.id
      : proposed.linkedTrainingPlanVersionId;
  const trainingLink =
    linkedTrainingPlanVersionId === null
      ? null
      : (
          await tx.query('SELECT draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2', [
            tx.athleteId,
            linkedTrainingPlanVersionId,
          ])
        ).rows[0];
  if (linkedTrainingPlanVersionId !== null && !trainingLink)
    throw new JointApprovalError('NUTRITION_REFERENCE_INVALID');
  const sessions = new Set(
    trainingLink
      ? planDraftSchema.parse(trainingLink['draft']).sessions.map((session) => session.id)
      : [],
  );
  for (const item of proposed.items) {
    if (item.anchor.kind === 'relative' && !sessions.has(item.anchor.entityId))
      throw new JointApprovalError('NUTRITION_REFERENCE_INVALID');
  }
  const foodIds = [
    ...new Set(
      proposed.items.flatMap((item) =>
        item.foods.flatMap((food) => (food.foodVersionId ? [food.foodVersionId] : [])),
      ),
    ),
  ];
  if (foodIds.length) {
    const foods = await tx.query(
      'SELECT version_id FROM food_definition_version WHERE athlete_id=$1 AND version_id=ANY($2::uuid[])',
      [tx.athleteId, foodIds],
    );
    if (foods.rowCount !== foodIds.length)
      throw new JointApprovalError('NUTRITION_REFERENCE_INVALID');
  }
  const versionId = randomUUID();
  const approvalId = randomUUID();
  const version = (previous?.version ?? 0) + 1;
  const saved = nutritionPlanVersionSchema.parse({
    ...proposed,
    linkedTrainingPlanVersionId,
    items: proposed.items.map((item) => ({ ...item, planVersionId: versionId })),
    planId,
    versionId,
    version,
    previousVersionId: previous?.versionId ?? null,
    approvedAt,
    approvalId,
  });
  await tx.query(
    `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,previous_version_id,previous_version,
      period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      tx.athleteId,
      planId,
      versionId,
      version,
      previous?.versionId ?? null,
      previous?.version ?? null,
      saved.period.from,
      saved.period.toInclusive,
      linkedTrainingPlanVersionId,
      approvalId,
      approvedAt,
      JSON.stringify(saved),
    ],
  );
  if (previous === null) {
    await tx.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,$3,$4)',
      [tx.athleteId, planId, version, versionId],
    );
  } else {
    await tx.query(
      'UPDATE nutrition_plan_head SET version=$3,version_id=$4 WHERE athlete_id=$1 AND plan_id=$2',
      [tx.athleteId, planId, version, versionId],
    );
  }
  await tx.query(
    "INSERT INTO nutrition_plan_history(athlete_id,plan_id,version_id,approval_id,action) VALUES($1,$2,$3,$4,'candidate_approved')",
    [tx.athleteId, planId, versionId, approvalId],
  );
  return saved;
}

function unseal(candidate: JointCandidateV3) {
  return jointCandidateDraftV3Schema.parse({
    schemaVersion: candidate.schemaVersion,
    kind: candidate.kind,
    basis: candidate.basis,
    writes: candidate.writes,
    nutritionPlanHeads: candidate.nutritionPlanHeads,
    asOfLocalDate: candidate.asOfLocalDate,
    diff: candidate.diff,
    validation: candidate.validation,
  });
}

export function createJointApprovalRepository(
  database: Database,
  options: { policy: z.infer<typeof policySchema> },
): JointApprovalRepository {
  const policy = policySchema.parse(options.policy);
  const guarded = <T>(athleteId: string, operation: (tx: Transaction) => Promise<T>) =>
    database.tenant(athleteId, async (tx) => {
      await lockJoint(tx);
      return operation(tx);
    });
  return {
    capture(athleteId, runId, scope, nutritionPlanIds = []) {
      const id = uuid.parse(runId);
      const ids = z.array(uuid).max(100).parse(nutritionPlanIds);
      return guarded(athleteId, async (tx) => {
        const context = await captureContext(tx, id, scope, ids, policy);
        return {
          basis: context.basis,
          nutritionPlanHeads: context.nutritionContexts.map((item) => item.head),
        };
      });
    },
    prepareInternal(athleteId, input) {
      const command = prepareSchema.parse(input);
      const nutrition = command.nutrition.map((write) => ({
        planId: write.planId,
        proposed: jointNutritionPlanDraftV3Schema.parse(write.proposed),
      }));
      const scope =
        command.training === null ? 'nutrition' : nutrition.length ? 'combined' : 'training';
      if (command.training === null && nutrition.length === 0)
        throw new JointApprovalError('INVALID_PROJECTION');
      const key = receiptKey('prepare', command.idempotencyKey);
      const prepareRequest = {
        kind: 'joint_prepare_v3',
        runId: command.runId,
        expectedBasis: command.expectedBasis,
        expectedNutritionPlanHeads: command.expectedNutritionPlanHeads,
        training: command.training,
        nutrition,
      };
      // Receipts outlive consent/evidence purges. Keep only a digest of the
      // canonical request so retries can be compared without retaining drafts.
      const request = {
        kind: 'joint_prepare_v3',
        digest: createHash('sha256').update(canonicalJson(prepareRequest)).digest('hex'),
      };
      return guarded(athleteId, async (tx) => {
        const prior = await receipt(tx, key, request);
        if (prior !== null) {
          const saved = await readStoredCandidate(
            tx,
            uuid.parse(z.object({ candidateId: uuid }).parse(prior).candidateId),
          );
          if (!saved) throw new JointApprovalError('CANDIDATE_UNAVAILABLE');
          return saved.candidate;
        }
        const context = await captureContext(
          tx,
          command.runId,
          scope,
          [
            ...command.expectedNutritionPlanHeads.map((head) => head.planId),
            ...nutrition.map((write) => write.planId),
          ],
          policy,
          nutrition[0]?.proposed.timezone,
        );
        const status = z.object({ kind: z.string() }).parse(context.run.status);
        if (status.kind !== 'analysis_ready' || !context.run.outputAvailable)
          throw new JointApprovalError('RUN_NOT_READY');
        if (
          !same(jointCoachingBasisSchema.parse(context.run.storedBasis), command.expectedBasis) ||
          !same(context.basis, command.expectedBasis) ||
          !same(
            context.nutritionContexts.map((item) => item.head),
            [...command.expectedNutritionPlanHeads].sort((a, b) => compare(a.planId, b.planId)),
          )
        )
          throw new JointApprovalError('STALE_BASIS');
        const writes =
          command.training === null
            ? {
                scope: 'nutrition',
                training: null,
                nutrition: nutrition.map((write) => ({
                  ...write,
                  before:
                    context.nutritionContexts.find((item) => item.head.planId === write.planId)
                      ?.version ?? null,
                })),
              }
            : nutrition.length === 0
              ? {
                  scope: 'training',
                  training: {
                    before: context.training,
                    proposed: command.training.proposed,
                    beforeSupplementaryLinks: context.beforeSupplementaryLinks,
                    supplementaryLinks: command.training.supplementaryLinks,
                  },
                  nutrition: null,
                }
              : {
                  scope: 'combined',
                  training: {
                    before: context.training,
                    proposed: command.training.proposed,
                    beforeSupplementaryLinks: context.beforeSupplementaryLinks,
                    supplementaryLinks: command.training.supplementaryLinks,
                  },
                  nutrition: nutrition.map((write) => ({
                    ...write,
                    before:
                      context.nutritionContexts.find((item) => item.head.planId === write.planId)
                        ?.version ?? null,
                  })),
                };
        const projection = projectJointCandidateV3({
          basis: context.basis,
          writes,
          nutritionContexts: context.nutritionContexts,
          completions: context.completions,
          asOfLocalDate: context.asOfLocalDate,
        });
        if (!projection.ok) throw new JointApprovalError('INVALID_PROJECTION');
        const decisionId = randomUUID();
        const proposalId = randomUUID();
        const candidateId = randomUUID();
        const createdAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        const decision = storedDecisionSchema.parse({
          schemaVersion: 3,
          kind: 'joint-decision',
          id: decisionId,
          runId: command.runId,
          basis: context.basis,
          createdAt,
        });
        const candidate = sealJointCandidateV3(projection.draft, {
          id: candidateId,
          proposalId,
          decisionId,
          parentCandidateId: null,
          createdAt,
        });
        await tx.query(
          'INSERT INTO coaching_decision(athlete_id,id,run_id,body,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',
          [athleteId, decisionId, command.runId, JSON.stringify(decision), createdAt],
        );
        await saveCandidate(tx, candidate, decisionId, createdAt);
        await tx.query(
          `UPDATE coaching_run SET status='{"kind":"running","stage":"validating_candidates"}'::jsonb,
            updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2`,
          [athleteId, command.runId],
        );
        await tx.query(
          'UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
          [athleteId, command.runId, JSON.stringify({ kind: 'validated_final', decisionId })],
        );
        await finish(tx, key, request, { candidateId });
        return candidate;
      });
    },
    read(athleteId, candidateId) {
      const id = uuid.parse(candidateId);
      return database.tenant(
        athleteId,
        async (tx) => (await readStoredCandidate(tx, id))?.candidate ?? null,
      );
    },
    list(athleteId, decisionId) {
      const id = uuid.parse(decisionId);
      return database.tenant(athleteId, async (tx) => {
        const rows = await tx.query(
          'SELECT id FROM coaching_candidate WHERE athlete_id=$1 AND decision_id=$2 ORDER BY created_at,id LIMIT 101',
          [athleteId, id],
        );
        if (rows.rows.length > 100) throw new JointApprovalError('CANDIDATE_LIMIT_REACHED');
        const candidates: JointCandidateV3[] = [];
        for (const row of rows.rows) {
          const saved = await readStoredCandidate(tx, uuid.parse(row['id']));
          if (saved) candidates.push(saved.candidate);
        }
        return candidates;
      });
    },
    derivePartial(athleteId, parentCandidateId, input) {
      const parentId = uuid.parse(parentCandidateId);
      const command = partialSchema.parse(input);
      const key = receiptKey('partial', command.idempotencyKey);
      const request = {
        kind: 'joint_partial_v3',
        parentCandidateId: parentId,
        selection: command.selection,
      };
      return guarded(athleteId, async (tx) => {
        const prior = await receipt(tx, key, request);
        if (prior !== null) {
          const saved = await readStoredCandidate(
            tx,
            uuid.parse(z.object({ candidateId: uuid }).parse(prior).candidateId),
          );
          if (!saved) throw new JointApprovalError('CANDIDATE_UNAVAILABLE');
          return saved.candidate;
        }
        const stored = await readStoredCandidate(tx, parentId);
        if (!stored) throw new JointApprovalError('CANDIDATE_UNAVAILABLE');
        const parent = stored.candidate;
        const selection = command.selection;
        const selectedTraining =
          selection.includeTrainingTitle ||
          selection.trainingPeriodIds.length > 0 ||
          selection.trainingSessionIds.length > 0;
        const scope = selectedTraining
          ? selection.nutritionPlanIds.length
            ? 'combined'
            : 'training'
          : 'nutrition';
        const ids = parent.nutritionPlanHeads.map((head) => head.planId);
        const current = await captureContext(tx, stored.runId, parent.writes.scope, ids, policy);
        const selected = await captureContext(tx, stored.runId, scope, ids, policy);
        const freshness = compareJointCandidateFreshnessV3(parent, {
          basis: current.basis,
          nutritionPlanHeads: current.nutritionContexts.map((item) => item.head),
        });
        if (freshness.status !== 'fresh' || parent.asOfLocalDate !== current.asOfLocalDate)
          throw new JointApprovalError('STALE_BASIS');
        if (
          parent.writes.training &&
          !same(parent.writes.training.beforeSupplementaryLinks, current.beforeSupplementaryLinks)
        )
          throw new JointApprovalError('STALE_BASIS');
        const count = (
          await tx.query(
            'SELECT count(*)::integer AS count FROM coaching_candidate WHERE athlete_id=$1 AND decision_id=$2',
            [athleteId, parent.decisionId],
          )
        ).rows[0]?.['count'];
        if (z.number().int().parse(count) >= 100)
          throw new JointApprovalError('CANDIDATE_LIMIT_REACHED');
        const createdAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        const derived = derivePartialJointCandidateV3({
          parent,
          selection,
          fresh: {
            parentBasis: current.basis,
            selectedBasis: selected.basis,
            nutritionContexts: selected.nutritionContexts,
            completions: selected.completions,
            asOfLocalDate: selected.asOfLocalDate,
          },
          identity: {
            id: randomUUID(),
            proposalId: randomUUID(),
            decisionId: parent.decisionId,
            parentCandidateId: parent.id,
            createdAt,
          },
        });
        if (!derived.ok) throw new JointApprovalError('INVALID_PARTIAL_SELECTION');
        await saveCandidate(tx, derived.candidate, parent.decisionId, createdAt);
        await finish(tx, key, request, { candidateId: derived.candidate.id });
        return derived.candidate;
      });
    },
    approve(athleteId, input) {
      const command = jointApprovalRequestSchema.parse(input);
      const key = receiptKey('approve', command.idempotencyKey);
      const request = { kind: 'joint_approve_v3', ...command };
      return guarded(athleteId, async (tx) => {
        const prior = await receipt(tx, key, request);
        if (prior !== null) return readResult(tx, prior);
        const stored = await readStoredCandidate(tx, command.candidateId);
        if (!stored || stored.candidate.proposalId !== command.proposalId)
          throw new JointApprovalError('CANDIDATE_UNAVAILABLE');
        const candidate = stored.candidate;
        if (candidate.digest !== command.proposalDigest)
          throw new JointApprovalError('CANDIDATE_DIGEST_MISMATCH');
        if (!same(candidate.basis, command.expectedBasis))
          throw new JointApprovalError('STALE_BASIS');
        const context = await captureContext(
          tx,
          stored.runId,
          candidate.writes.scope,
          candidate.nutritionPlanHeads.map((head) => head.planId),
          policy,
        );
        const freshness = compareJointCandidateFreshnessV3(candidate, {
          basis: context.basis,
          nutritionPlanHeads: context.nutritionContexts.map((item) => item.head),
        });
        if (freshness.status !== 'fresh' || candidate.asOfLocalDate !== context.asOfLocalDate)
          throw new JointApprovalError('STALE_BASIS');
        if (
          candidate.writes.training &&
          !same(
            candidate.writes.training.beforeSupplementaryLinks,
            context.beforeSupplementaryLinks,
          )
        )
          throw new JointApprovalError('STALE_BASIS');
        const projection = projectJointCandidateV3({
          basis: context.basis,
          writes: candidate.writes,
          nutritionContexts: context.nutritionContexts,
          completions: context.completions,
          asOfLocalDate: context.asOfLocalDate,
        });
        if (!projection.ok || !same(projection.draft, unseal(candidate)))
          throw new JointApprovalError('CANDIDATE_UNAVAILABLE');
        if (projection.draft.validation.status !== 'checked')
          throw new JointApprovalError('CANDIDATE_NOT_APPROVABLE');
        let training: PlanSnapshot | null = null;
        if (candidate.writes.training) {
          const write = candidate.writes.training;
          const changedLinks = changedLinkIds(
            write.beforeSupplementaryLinks,
            write.supplementaryLinks,
          );
          if (changedLinks.length > 0) {
            const started = await tx.query(
              `SELECT 1 FROM supplementary_execution WHERE athlete_id=$1
                AND plan_version_id=$2 AND planned_session_id=ANY($3::text[]) LIMIT 1`,
              [athleteId, write.before.id, changedLinks],
            );
            if (started.rows.length > 0) throw new JointApprovalError('CANDIDATE_NOT_APPROVABLE');
          }
          const affected = [
            ...new Set(candidate.diff.relativeImpacts.map((item) => item.planId)),
          ].sort(compare);
          training = await persistPlanVersion(tx, {
            expectedVersionId: write.before.id,
            draft: write.proposed,
            reviewedRelativeNutritionPlanIds: affected,
          });
          await persistSupplementarySessionLinks(
            tx,
            write.before.id,
            training.id,
            write.proposed,
            linkChanges(write.beforeSupplementaryLinks, write.supplementaryLinks, write.proposed),
          );
          await tx.query(
            "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'candidate_approved')",
            [athleteId, training.id],
          );
        }
        const nutrition: NutritionPlanVersion[] = [];
        const approvedAt = iso(
          (await tx.query('SELECT statement_timestamp() AS at')).rows[0]?.['at'],
        );
        for (const write of [...(candidate.writes.nutrition ?? [])].sort((a, b) =>
          compare(a.planId, b.planId),
        )) {
          nutrition.push(
            await saveNutritionPlan(
              tx,
              write.planId,
              write.before,
              write.proposed,
              approvedAt,
              training,
              candidate.writes.training?.before.id ?? null,
            ),
          );
        }
        await enqueue(tx, {
          id: randomUUID(),
          idempotencyKey: key,
          topic: 'joint.candidate_approved',
          payload: {
            candidateId: candidate.id,
            trainingVersionId: training?.id ?? null,
            nutritionVersionIds: nutrition.map((item) => item.versionId),
          },
        });
        await finish(tx, key, request, {
          trainingVersionId: training?.id ?? null,
          nutritionVersionIds: nutrition.map((item) => item.versionId),
        });
        return { training, nutrition };
      });
    },
  };
}
