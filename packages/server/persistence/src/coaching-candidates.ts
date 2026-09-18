import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  trainingCandidateDraftV1Schema,
  trainingCandidateV1Schema,
  trainingCandidateStrategyV1Schema,
  trainingDecisionV1Schema,
  trainingProposalV1Schema,
  type TrainingCandidateDraftV1,
  type TrainingCandidateV1,
  type TrainingDecisionV1,
  type TrainingProposalV1,
} from '@workout/contracts/coaching-candidates';
import {
  compareTrainingCoachingBasis,
  trainingCoachingBasisV1Schema,
  trainingCoachingPolicySchema,
} from '@workout/contracts/coaching-basis';
import {
  coachingFixtureCandidateContentV1Schema,
  coachingRunModelSourceSchema,
  coachingRunStatusSchema,
} from '@workout/contracts/coaching-runs';
import { coreEvidenceDependencyManifestV2Schema } from '@workout/contracts/evidence-dependencies';
import { coreEvidenceSnapshotSchema } from '@workout/contracts/evidence-snapshots';
import { planDraftSchema, planSnapshotSchema } from '@workout/contracts/planning';
import { sessionCompletionSchema } from '@workout/contracts/session-completion';
import { projectTrainingCandidateV1 } from '@workout/server-coaching/candidates';
import type { Database, Transaction } from './database.js';
import { PersistenceConflict } from './outbox.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const createCommandSchema = z.strictObject({
  runId: uuid,
  proposed: planDraftSchema,
  strategy: trainingCandidateStrategyV1Schema,
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value === value.trim()),
});
const createFromFixtureCommandSchema = createCommandSchema.pick({
  runId: true,
  idempotencyKey: true,
});
const storedFixtureOutputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  content: z.json(),
});
const iso = (value: unknown) => z.coerce.date().parse(value).toISOString();

export type TrainingCandidateCreateCommand = z.infer<typeof createCommandSchema>;
export type TrainingCandidateFixtureCommand = z.infer<typeof createFromFixtureCommandSchema>;
export interface TrainingCandidateBundle {
  decision: TrainingDecisionV1;
  proposal: TrainingProposalV1;
  candidate: TrainingCandidateV1;
}
export interface TrainingCandidateRepository {
  create(
    athleteId: string,
    command: TrainingCandidateCreateCommand,
  ): Promise<TrainingCandidateBundle>;
  createFromFixture(
    athleteId: string,
    command: TrainingCandidateFixtureCommand,
  ): Promise<TrainingCandidateBundle>;
  read(athleteId: string, candidateId: string): Promise<TrainingCandidateBundle | null>;
  list(athleteId: string, runId: string): Promise<TrainingCandidateBundle[]>;
}
export class TrainingCandidateError extends Error {
  constructor(
    readonly code:
      | 'RUN_NOT_FOUND'
      | 'RUN_NOT_READY'
      | 'EVIDENCE_UNAVAILABLE'
      | 'AI_CONSENT_REQUIRED'
      | 'STALE_BASIS'
      | 'POLICY_MISMATCH'
      | 'INVALID_COMPLETION_BASIS'
      | 'INVALID_PROJECTION'
      | 'INVALID_FIXTURE_OUTPUT'
      | 'CANDIDATE_UNAVAILABLE'
      | 'CANDIDATE_TOO_LARGE',
  ) {
    super(code);
  }
}

/** Stable object-key order; array order and explicit null remain part of the digest. */
function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('Undefined cannot be hashed');
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Value cannot be hashed');
    return encoded;
  }
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function digestTrainingCandidate(input: {
  runId: string;
  decisionId: string;
  proposalId: string;
  candidateId: string;
  draft: TrainingCandidateDraftV1;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion: 1,
        branch: {
          runId: input.runId,
          decisionId: input.decisionId,
          proposalId: input.proposalId,
          candidateId: input.candidateId,
        },
        draft: input.draft,
      }),
    )
    .digest('hex');
}

function unsealCandidate(candidate: TrainingCandidateV1): TrainingCandidateDraftV1 {
  return trainingCandidateDraftV1Schema.parse({
    schemaVersion: candidate.schemaVersion,
    scope: candidate.scope,
    basis: candidate.basis,
    before: candidate.before,
    proposed: candidate.proposed,
    asOfLocalDate: candidate.asOfLocalDate,
    strategy: candidate.strategy,
    diff: candidate.diff,
    validation: candidate.validation,
  });
}

/** One observation after tenant locks: missing aggregate heads are explicit. */
const currentSql = `SELECT r.id AS run_id,r.thread_id,r.evidence_snapshot_id,r.conversation_revision,
 r.policy,r.source,r.basis,r.status,
 o.id AS output_id,(o.body IS NOT NULL) AS output_available,
 o.purged_reason AS output_purged_reason,
 t.revision AS current_conversation_revision,
 e.created_at AS evidence_created_at,e.body AS evidence_body,e.purged_reason AS evidence_purged_reason,
 p.id AS current_plan_id,p.version AS current_plan_version,p.created_at AS current_plan_created_at,p.draft AS current_plan_draft,
 jsonb_build_object('schemaVersion',2,'scope','core-ledgers-v2','athleteId',$1::text,
 'capturedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'trainingPlan',COALESCE((SELECT jsonb_build_object('kind','exists','versionId',version_id)
  FROM plan_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'activities',(SELECT jsonb_build_object('count',count(*)::text,'revisionSum',coalesce(sum(revision),0)::text)
  FROM activity_canonical WHERE athlete_id=$1),
 'checkIns',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision)
  FROM check_in_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'sessionCompletions',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision)
  FROM session_completion_collection_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'userConstraints',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision)
  FROM coaching_constraint_head WHERE athlete_id=$1),'{"kind":"absent"}'::jsonb),
 'aiConsent',COALESCE((SELECT jsonb_build_object('kind','exists','revision',revision,'granted',granted)
  FROM consent WHERE athlete_id=$1 AND kind='ai'),'{"kind":"absent"}'::jsonb)) AS dependencies
 FROM coaching_run r
 JOIN coaching_thread t ON t.athlete_id=r.athlete_id AND t.id=r.thread_id
 JOIN core_evidence_snapshot e ON e.athlete_id=r.athlete_id AND e.id=r.evidence_snapshot_id
 LEFT JOIN coaching_analysis_output o ON o.athlete_id=r.athlete_id AND o.run_id=r.id
 LEFT JOIN plan_head h ON h.athlete_id=r.athlete_id
 LEFT JOIN plan_snapshot p ON p.athlete_id=h.athlete_id AND p.id=h.version_id
 WHERE r.athlete_id=$1 AND r.id=$2`;

async function currentContext(
  tx: Transaction,
  runId: string,
  policy: z.infer<typeof trainingCoachingPolicySchema>,
  source: z.infer<typeof coachingRunModelSourceSchema>,
) {
  const selected = await tx.query(currentSql, [tx.athleteId, runId]);
  const row = selected.rows[0];
  if (!row) throw new TrainingCandidateError('RUN_NOT_FOUND');
  const storedPolicy = trainingCoachingPolicySchema.safeParse(row['policy']);
  const storedSource = coachingRunModelSourceSchema.safeParse(row['source']);
  if (
    !storedPolicy.success ||
    !storedSource.success ||
    canonicalJson(storedPolicy.data) !== canonicalJson(policy) ||
    canonicalJson(storedSource.data) !== canonicalJson(source)
  )
    throw new TrainingCandidateError('POLICY_MISMATCH');
  if (row['evidence_body'] === null || row['evidence_purged_reason'] !== null)
    throw new TrainingCandidateError('EVIDENCE_UNAVAILABLE');
  const snapshot = coreEvidenceSnapshotSchema.safeParse({
    id: row['evidence_snapshot_id'],
    threadId: row['thread_id'],
    createdAt: iso(row['evidence_created_at']),
    status: 'available',
    body: row['evidence_body'],
  });
  const basis = trainingCoachingBasisV1Schema.safeParse(row['basis']);
  const dependencies = coreEvidenceDependencyManifestV2Schema.safeParse(row['dependencies']);
  const plan = planSnapshotSchema.safeParse({
    id: row['current_plan_id'],
    version: row['current_plan_version'],
    createdAt: row['current_plan_created_at'] === null ? null : iso(row['current_plan_created_at']),
    draft: row['current_plan_draft'],
  });
  if (
    !snapshot.success ||
    snapshot.data.status !== 'available' ||
    snapshot.data.body.schemaVersion !== 2 ||
    !basis.success ||
    !dependencies.success ||
    !plan.success
  )
    throw new TrainingCandidateError('STALE_BASIS');
  if (dependencies.data.aiConsent.kind !== 'exists' || !dependencies.data.aiConsent.granted)
    throw new TrainingCandidateError('AI_CONSENT_REQUIRED');
  if (
    basis.data.athleteId !== tx.athleteId ||
    basis.data.threadId !== row['thread_id'] ||
    basis.data.evidenceSnapshotId !== row['evidence_snapshot_id'] ||
    basis.data.conversationRevision !== row['conversation_revision'] ||
    canonicalJson(snapshot.data.body.plan) !== canonicalJson(plan.data)
  )
    throw new TrainingCandidateError('STALE_BASIS');
  const comparison = compareTrainingCoachingBasis(basis.data, {
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    athleteId: tx.athleteId,
    evidence: {
      id: snapshot.data.id,
      threadId: snapshot.data.threadId,
      createdAt: snapshot.data.createdAt,
      status: 'available',
    },
    conversationRevision: row['current_conversation_revision'],
    dependencies: dependencies.data,
    policy,
    retrieval: { kind: 'none' },
  });
  if (comparison.status !== 'fresh') throw new TrainingCandidateError('STALE_BASIS');
  const completions = await tx.query(
    `SELECT record_json FROM session_completion WHERE athlete_id=$1
      AND record_json->>'status'='completed' ORDER BY session_id LIMIT 1001`,
    [tx.athleteId],
  );
  if (completions.rows.length > 1000) throw new TrainingCandidateError('INVALID_COMPLETION_BASIS');
  const parsedCompletions = z
    .array(sessionCompletionSchema)
    .safeParse(completions.rows.map((item) => item['record_json']));
  if (!parsedCompletions.success) throw new TrainingCandidateError('INVALID_COMPLETION_BASIS');
  return { row, basis: basis.data, plan: plan.data, completions: parsedCompletions.data };
}

async function readBundle(
  tx: Transaction,
  candidateId: string,
): Promise<TrainingCandidateBundle | null> {
  const selected = await tx.query(
    `SELECT c.id AS candidate_id,c.decision_id AS candidate_decision_id,
      c.created_at AS candidate_created_at,
      c.body AS candidate_body,c.digest,c.purged_reason AS candidate_purged_reason,
      p.id AS proposal_id,p.decision_id AS proposal_decision_id,
      p.created_at AS proposal_created_at,
      p.body AS proposal_body,p.purged_reason AS proposal_purged_reason,
      d.id AS decision_id,d.created_at AS decision_created_at,d.body AS decision_body,
      d.purged_reason AS decision_purged_reason,d.run_id
     FROM coaching_candidate c
     JOIN coaching_proposal p ON p.athlete_id=c.athlete_id AND p.id=c.proposal_id
     JOIN coaching_decision d ON d.athlete_id=p.athlete_id AND d.id=p.decision_id
     WHERE c.athlete_id=$1 AND c.id=$2`,
    [tx.athleteId, candidateId],
  );
  const row = selected.rows[0];
  if (
    !row ||
    row['candidate_body'] === null ||
    row['proposal_body'] === null ||
    row['decision_body'] === null ||
    row['digest'] === null ||
    row['candidate_purged_reason'] !== null ||
    row['proposal_purged_reason'] !== null ||
    row['decision_purged_reason'] !== null
  )
    return null;
  const candidate = trainingCandidateV1Schema.safeParse(row['candidate_body']);
  const proposal = trainingProposalV1Schema.safeParse(row['proposal_body']);
  const decision = trainingDecisionV1Schema.safeParse(row['decision_body']);
  if (!candidate.success || !proposal.success || !decision.success) return null;
  if (
    candidate.data.id !== candidateId ||
    candidate.data.id !== row['candidate_id'] ||
    candidate.data.createdAt !== iso(row['candidate_created_at']) ||
    candidate.data.digest !== row['digest'] ||
    proposal.data.id !== row['proposal_id'] ||
    proposal.data.createdAt !== iso(row['proposal_created_at']) ||
    decision.data.id !== row['decision_id'] ||
    decision.data.createdAt !== iso(row['decision_created_at']) ||
    row['candidate_decision_id'] !== decision.data.id ||
    row['proposal_decision_id'] !== decision.data.id ||
    candidate.data.runId !== row['run_id'] ||
    candidate.data.decisionId !== decision.data.id ||
    candidate.data.proposalId !== proposal.data.id ||
    proposal.data.decisionId !== decision.data.id ||
    proposal.data.runId !== decision.data.runId ||
    !proposal.data.candidateIds.includes(candidateId) ||
    canonicalJson(candidate.data.basis) !== canonicalJson(decision.data.basis) ||
    digestTrainingCandidate({
      runId: candidate.data.runId,
      decisionId: candidate.data.decisionId,
      proposalId: candidate.data.proposalId,
      candidateId,
      draft: unsealCandidate(candidate.data),
    }) !== candidate.data.digest
  )
    return null;
  return { decision: decision.data, proposal: proposal.data, candidate: candidate.data };
}

function requireStatus(
  row: Record<string, unknown>,
  expected: 'analysis_ready' | 'validated_final',
  decisionId?: string,
) {
  const status = coachingRunStatusSchema.safeParse(row['status']);
  if (
    !status.success ||
    status.data.kind !== expected ||
    (status.data.kind === 'validated_final' &&
      decisionId !== undefined &&
      status.data.decisionId !== decisionId) ||
    (status.data.kind === 'analysis_ready' &&
      (row['output_id'] !== status.data.outputId ||
        row['output_available'] !== true ||
        row['output_purged_reason'] !== null))
  )
    throw new TrainingCandidateError('RUN_NOT_READY');
}

async function currentLocalDate(tx: Transaction, timezone: string): Promise<string> {
  const result = await tx.query(
    "SELECT to_char(statement_timestamp() AT TIME ZONE $1,'YYYY-MM-DD') AS local_date",
    [timezone],
  );
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .parse(result.rows[0]?.['local_date']);
}

type CandidateContext = Awaited<ReturnType<typeof currentContext>>;
type ReceiptRequest = { requestHash: string };

function receiptKey(idempotencyKey: string, kind: 'prepared' | 'fixture'): string {
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return kind === 'fixture'
    ? `coaching:candidate:fixture:${digest}`
    : `coaching:candidate:${digest}`;
}

function receiptRequest(value: unknown): ReceiptRequest {
  // Receipts survive deletion; they contain no source text, plan body, or model output.
  return { requestHash: createHash('sha256').update(canonicalJson(value)).digest('hex') };
}

async function replayCandidate(
  tx: Transaction,
  key: string,
  request: ReceiptRequest,
  policy: z.infer<typeof trainingCoachingPolicySchema>,
  source: z.infer<typeof coachingRunModelSourceSchema>,
): Promise<TrainingCandidateBundle | null> {
  const receipt = await tx.query(
    'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
    [tx.athleteId, key, JSON.stringify(request)],
  );
  if (!receipt.rows[0]) return null;
  if (receipt.rows[0]['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  const prior = z.strictObject({ candidateId: uuid }).parse(receipt.rows[0]['result']);
  const bundle = await readBundle(tx, prior.candidateId);
  if (!bundle) throw new TrainingCandidateError('CANDIDATE_UNAVAILABLE');
  const context = await currentContext(tx, bundle.decision.runId, policy, source);
  requireStatus(context.row, 'validated_final', bundle.decision.id);
  if (bundle.candidate.asOfLocalDate !== (await currentLocalDate(tx, context.plan.draft.timezone)))
    throw new TrainingCandidateError('CANDIDATE_UNAVAILABLE');
  return bundle;
}

async function deriveFixtureProposal(tx: Transaction, context: CandidateContext) {
  const selected = await tx.query(
    `SELECT body FROM coaching_analysis_output
     WHERE athlete_id=$1 AND run_id=$2 AND id=$3 AND purged_reason IS NULL`,
    [tx.athleteId, context.row['run_id'], context.row['output_id']],
  );
  const stored = storedFixtureOutputSchema.safeParse(selected.rows[0]?.['body']);
  const output = stored.success
    ? coachingFixtureCandidateContentV1Schema.safeParse(stored.data.content)
    : null;
  if (!output?.success) throw new TrainingCandidateError('INVALID_FIXTURE_OUTPUT');
  const { sessionId, durationSeconds } = output.data.intent;
  const target = context.plan.draft.sessions.find((session) => session.id === sessionId);
  if (
    !target ||
    target.durationSeconds === null ||
    target.durationRange != null ||
    target.durationSeconds === durationSeconds
  )
    throw new TrainingCandidateError('INVALID_FIXTURE_OUTPUT');
  const proposed = planDraftSchema.safeParse({
    ...context.plan.draft,
    sessions: context.plan.draft.sessions.map((session) =>
      session.id === sessionId ? { ...session, durationSeconds } : session,
    ),
  });
  if (!proposed.success) throw new TrainingCandidateError('INVALID_FIXTURE_OUTPUT');
  return { proposed: proposed.data, strategy: output.data.strategy };
}

async function sealCandidate(
  tx: Transaction,
  context: CandidateContext,
  command: Pick<TrainingCandidateCreateCommand, 'runId' | 'proposed' | 'strategy'>,
  key: string,
  request: ReceiptRequest,
): Promise<TrainingCandidateBundle> {
  const asOfLocalDate = await currentLocalDate(tx, context.plan.draft.timezone);
  const projection = projectTrainingCandidateV1({
    basis: context.basis,
    before: context.plan,
    proposed: command.proposed,
    strategy: command.strategy,
    asOfLocalDate,
    completions: context.completions,
  });
  if (!projection.ok)
    throw new TrainingCandidateError(
      projection.reason === 'INVALID_COMPLETION_BASIS'
        ? 'INVALID_COMPLETION_BASIS'
        : 'INVALID_PROJECTION',
    );
  const decisionId = randomUUID();
  const proposalId = randomUUID();
  const candidateId = randomUUID();
  const createdAt = iso(
    (await tx.query('SELECT statement_timestamp() AS created_at')).rows[0]?.['created_at'],
  );
  const digest = digestTrainingCandidate({
    runId: command.runId,
    decisionId,
    proposalId,
    candidateId,
    draft: projection.draft,
  });
  const decision = trainingDecisionV1Schema.parse({
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    id: decisionId,
    runId: command.runId,
    basis: context.basis,
    strategy: command.strategy,
    createdAt,
  });
  const proposal = trainingProposalV1Schema.parse({
    schemaVersion: 1,
    scope: 'running-core-v2-training',
    id: proposalId,
    runId: command.runId,
    decisionId,
    candidateIds: [candidateId],
    createdAt,
  });
  const candidate = trainingCandidateV1Schema.parse({
    ...projection.draft,
    id: candidateId,
    runId: command.runId,
    decisionId,
    proposalId,
    createdAt,
    digest,
  });
  const candidateBody = JSON.stringify(candidate);
  // Leave room for JSONB's expanded representation under the 4 MiB table cap.
  if (Buffer.byteLength(candidateBody) > 3 * 1024 * 1024)
    throw new TrainingCandidateError('CANDIDATE_TOO_LARGE');
  await tx.query(
    'INSERT INTO coaching_decision(athlete_id,id,run_id,body,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',
    [tx.athleteId, decisionId, command.runId, JSON.stringify(decision), createdAt],
  );
  await tx.query(
    'INSERT INTO coaching_proposal(athlete_id,id,decision_id,body,created_at) VALUES($1,$2,$3,$4::jsonb,$5)',
    [tx.athleteId, proposalId, decisionId, JSON.stringify(proposal), createdAt],
  );
  await tx.query(
    `INSERT INTO coaching_candidate(athlete_id,id,decision_id,proposal_id,parent_candidate_id,digest,body,created_at)
     VALUES($1,$2,$3,$4,NULL,$5,$6::jsonb,$7)`,
    [tx.athleteId, candidateId, decisionId, proposalId, digest, candidateBody, createdAt],
  );
  await tx.query(
    `UPDATE coaching_run SET status='{"kind":"running","stage":"validating_candidates"}'::jsonb,
      updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2`,
    [tx.athleteId, command.runId],
  );
  await tx.query(
    'UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
    [tx.athleteId, command.runId, JSON.stringify({ kind: 'validated_final', decisionId })],
  );
  await tx.query(
    'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
    [tx.athleteId, key, JSON.stringify(request), JSON.stringify({ candidateId })],
  );
  return { decision, proposal, candidate };
}

export function createTrainingCandidateRepository(
  database: Database,
  options: {
    policy: z.input<typeof trainingCoachingPolicySchema>;
    source: z.input<typeof coachingRunModelSourceSchema>;
  },
): TrainingCandidateRepository {
  const policy = trainingCoachingPolicySchema.parse(options.policy);
  const source = coachingRunModelSourceSchema.parse(options.source);
  const guarded = <T>(athleteId: string, operation: (tx: Transaction) => Promise<T>) =>
    database.tenant(athleteId, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [athleteId]);
      return operation(tx);
    });
  return {
    create(athleteId, input) {
      const command = createCommandSchema.parse(input);
      const key = receiptKey(command.idempotencyKey, 'prepared');
      const request = receiptRequest({
        schemaVersion: 1,
        runId: command.runId,
        proposed: command.proposed,
        strategy: command.strategy,
      });
      return guarded(athleteId, async (tx) => {
        const replay = await replayCandidate(tx, key, request, policy, source);
        if (replay) return replay;
        const context = await currentContext(tx, command.runId, policy, source);
        requireStatus(context.row, 'analysis_ready');
        return sealCandidate(tx, context, command, key, request);
      });
    },
    createFromFixture(athleteId, input) {
      const command = createFromFixtureCommandSchema.parse(input);
      const key = receiptKey(command.idempotencyKey, 'fixture');
      const request = receiptRequest({
        schemaVersion: 1,
        kind: 'stored_deterministic_fixture',
        runId: command.runId,
      });
      return guarded(athleteId, async (tx) => {
        const replay = await replayCandidate(tx, key, request, policy, source);
        if (replay) return replay;
        const context = await currentContext(tx, command.runId, policy, source);
        requireStatus(context.row, 'analysis_ready');
        if (source.kind !== 'deterministic_fixture' || source.fixtureId !== 'synthetic-v1')
          throw new TrainingCandidateError('INVALID_FIXTURE_OUTPUT');
        const derived = await deriveFixtureProposal(tx, context);
        return sealCandidate(tx, context, { runId: command.runId, ...derived }, key, request);
      });
    },
    read(athleteId, candidateId) {
      const id = uuid.parse(candidateId);
      return guarded(athleteId, async (tx) => {
        const bundle = await readBundle(tx, id);
        if (!bundle) return null;
        try {
          const context = await currentContext(tx, bundle.decision.runId, policy, source);
          requireStatus(context.row, 'validated_final', bundle.decision.id);
          return canonicalJson(context.basis) === canonicalJson(bundle.candidate.basis) &&
            bundle.candidate.asOfLocalDate ===
              (await currentLocalDate(tx, context.plan.draft.timezone))
            ? bundle
            : null;
        } catch (error) {
          if (error instanceof TrainingCandidateError) return null;
          throw error;
        }
      });
    },
    list(athleteId, runId) {
      const id = uuid.parse(runId);
      return guarded(athleteId, async (tx) => {
        let context: Awaited<ReturnType<typeof currentContext>>;
        try {
          context = await currentContext(tx, id, policy, source);
          requireStatus(context.row, 'validated_final');
        } catch (error) {
          if (error instanceof TrainingCandidateError) return [];
          throw error;
        }
        const result = await tx.query(
          `SELECT c.id FROM coaching_candidate c JOIN coaching_proposal p
            ON p.athlete_id=c.athlete_id AND p.id=c.proposal_id
           JOIN coaching_decision d ON d.athlete_id=p.athlete_id AND d.id=p.decision_id
           WHERE c.athlete_id=$1 AND d.run_id=$2 ORDER BY c.created_at,c.id LIMIT 101`,
          [athleteId, id],
        );
        if (result.rows.length > 100) return [];
        const today = await currentLocalDate(tx, context.plan.draft.timezone);
        const bundles = await Promise.all(
          result.rows.map(async (item) => readBundle(tx, uuid.parse(item['id']))),
        );
        return bundles.filter(
          (bundle): bundle is TrainingCandidateBundle =>
            bundle !== null &&
            canonicalJson(bundle.candidate.basis) === canonicalJson(context.basis) &&
            bundle.candidate.asOfLocalDate === today &&
            (context.row['status'] as Record<string, unknown>)['decisionId'] === bundle.decision.id,
        );
      });
    },
  };
}
