import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { coreEvidenceCaptureSchema } from '@workout/contracts/evidence-snapshots';
import {
  jointCandidateV3Schema,
  jointNutritionPlanHeadV3Schema,
  type JointCandidateV3,
} from '@workout/contracts/joint-coaching';
import { jointCoachingBasisSchema } from '@workout/contracts/nutrition';
import {
  createCoreEvidenceSnapshotRepository,
  type CoreEvidenceSnapshotRepository,
} from './evidence-snapshots.js';
import type { Database, Transaction } from './database.js';
import {
  captureJointFixtureContext,
  JointApprovalError,
  type JointApprovalRepository,
  type JointFixtureCapture,
} from './joint-approval.js';
import { enqueue, PersistenceConflict } from './outbox.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const jointFixtureCreateSchema = z.strictObject({
  threadId: uuid,
  nutritionPlanId: uuid,
  expectedConversationRevision: z.number().int().positive().max(2147483646),
  window: coreEvidenceCaptureSchema.shape.window,
  idempotencyKey,
});
export type JointFixtureCreate = z.infer<typeof jointFixtureCreateSchema>;

const receiptSchema = z.strictObject({
  runId: uuid,
  evidenceSnapshotId: uuid,
  basis: jointCoachingBasisSchema,
  nutritionPlanHeads: z.array(jointNutritionPlanHeadV3Schema).max(100),
});
interface FixtureRunState {
  receipt: z.infer<typeof receiptSchema>;
  candidateId: string | null;
  context?: JointFixtureCapture;
}
const policy = { id: 'running-core-v3-joint', version: '1' } as const;
const source = { kind: 'deterministic_fixture', fixtureId: 'synthetic-v3-joint' } as const;
const hashKey = (part: string, key: string) =>
  `joint-fixture-${part}-${createHash('sha256').update(key).digest('hex')}`;

export class JointFixtureError extends Error {
  constructor(readonly code: 'JOINT_FIXTURE_DISABLED' | 'JOINT_FIXTURE_UNAVAILABLE') {
    super(code);
  }
}

export interface JointFixtureRepository {
  create(athleteId: string, command: JointFixtureCreate): Promise<JointCandidateV3>;
}

/** A conservative pre/post guard closes the gap around the existing evidence capture transaction. */
async function captureGuard(tx: Transaction, command: JointFixtureCreate): Promise<unknown> {
  const row = (
    await tx.query(
      `SELECT t.revision AS thread_revision,t.plan_version_id AS pinned_plan_version_id,
        p.version_id AS training_version_id,n.version_id AS nutrition_version_id,
        to_jsonb(i)-'athlete_id' AS integrated_heads,
        c.revision AS constraint_revision,s.revision AS completion_revision,
        k.revision AS check_in_revision,a.revision AS consent_revision,
        a.granted AS consent_granted
       FROM coaching_thread t
       LEFT JOIN plan_head p ON p.athlete_id=t.athlete_id
       LEFT JOIN nutrition_plan_head n ON n.athlete_id=t.athlete_id AND n.plan_id=$3
       LEFT JOIN integrated_dependency_head i ON i.athlete_id=t.athlete_id
       LEFT JOIN coaching_constraint_head c ON c.athlete_id=t.athlete_id
       LEFT JOIN session_completion_collection_head s ON s.athlete_id=t.athlete_id
       LEFT JOIN check_in_collection_head k ON k.athlete_id=t.athlete_id
       LEFT JOIN consent a ON a.athlete_id=t.athlete_id AND a.kind='ai'
       WHERE t.athlete_id=$1 AND t.id=$2`,
      [tx.athleteId, command.threadId, command.nutritionPlanId],
    )
  ).rows[0];
  if (!row || row['thread_revision'] !== command.expectedConversationRevision)
    throw new JointApprovalError('STALE_BASIS');
  if (row['pinned_plan_version_id'] !== row['training_version_id'])
    throw new JointApprovalError('STALE_BASIS');
  if (row['nutrition_version_id'] === null)
    throw new JointApprovalError('NUTRITION_REFERENCE_INVALID');
  if (row['consent_granted'] !== true) throw new JointApprovalError('AI_CONSENT_REQUIRED');
  return row;
}

async function lock(tx: Transaction) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [tx.athleteId]);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77209))', [tx.athleteId]);
}

async function readReceipt(
  tx: Transaction,
  key: string,
  request: unknown,
): Promise<z.infer<typeof receiptSchema> | null> {
  const row = (
    await tx.query(
      'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
      [tx.athleteId, key, JSON.stringify(request)],
    )
  ).rows[0];
  if (!row) return null;
  if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
  return receiptSchema.parse(row['result']);
}

function proposedLabel(current: string, maximum: number): string {
  const suffix = ' [joint fixture]';
  if (current.length + suffix.length <= maximum && !current.endsWith(suffix))
    return `${current}${suffix}`;
  return current === 'Joint fixture proposal'
    ? 'Joint fixture alternative'
    : 'Joint fixture proposal';
}

async function rootCandidateId(tx: Transaction, runId: string): Promise<string | null> {
  const row = (
    await tx.query(
      `SELECT c.id FROM coaching_candidate c JOIN coaching_decision d
        ON d.athlete_id=c.athlete_id AND d.id=c.decision_id
       WHERE d.athlete_id=$1 AND d.run_id=$2 AND c.parent_candidate_id IS NULL
       LIMIT 1`,
      [tx.athleteId, runId],
    )
  ).rows[0];
  return row ? uuid.parse(row['id']) : null;
}

export function createJointFixtureRepository(
  database: Database,
  jointApproval: JointApprovalRepository,
  options: {
    enabled: boolean;
    environment: 'development' | 'test' | 'production';
    evidenceSnapshots?: Pick<CoreEvidenceSnapshotRepository, 'capture'>;
  },
): JointFixtureRepository {
  const enabled = options.enabled && options.environment !== 'production';
  const evidence = options.evidenceSnapshots ?? createCoreEvidenceSnapshotRepository(database);
  return {
    async create(athleteId, input) {
      if (!enabled) throw new JointFixtureError('JOINT_FIXTURE_DISABLED');
      const command = jointFixtureCreateSchema.parse(input);
      const key = hashKey('run', command.idempotencyKey);
      const request = {
        kind: 'joint_fixture_v3',
        threadId: command.threadId,
        nutritionPlanId: command.nutritionPlanId,
        expectedConversationRevision: command.expectedConversationRevision,
        window: command.window,
      };
      let stored: FixtureRunState | null = await database.tenant(athleteId, async (tx) => {
        await lock(tx);
        const prior = await readReceipt(tx, key, request);
        if (prior) return { receipt: prior, candidateId: await rootCandidateId(tx, prior.runId) };
        return null;
      });
      if (stored?.candidateId) {
        const candidate = await jointApproval.read(athleteId, stored.candidateId);
        if (!candidate) throw new JointFixtureError('JOINT_FIXTURE_UNAVAILABLE');
        return candidate;
      }

      if (!stored) {
        const before = await database.tenant(athleteId, async (tx) => {
          await lock(tx);
          return captureGuard(tx, command);
        });
        const snapshot = await evidence.capture(athleteId, command.threadId, {
          expectedConversationRevision: command.expectedConversationRevision,
          window: command.window,
          idempotencyKey: hashKey('evidence', command.idempotencyKey),
        });
        if (snapshot.status !== 'available')
          throw new JointFixtureError('JOINT_FIXTURE_UNAVAILABLE');
        stored = await database.tenant(athleteId, async (tx) => {
          await lock(tx);
          const prior = await readReceipt(tx, key, request);
          if (prior) return { receipt: prior, candidateId: await rootCandidateId(tx, prior.runId) };
          const after = await captureGuard(tx, command);
          if (!isDeepStrictEqual(before, after)) throw new JointApprovalError('STALE_BASIS');
          const context = await captureJointFixtureContext(tx, {
            threadId: command.threadId,
            evidenceSnapshotId: snapshot.id,
            nutritionPlanId: command.nutritionPlanId,
            expectedConversationRevision: command.expectedConversationRevision,
            policy,
          });
          const runId = randomUUID();
          const outputId = randomUUID();
          await tx.query(
            `INSERT INTO coaching_run(athlete_id,id,thread_id,evidence_snapshot_id,
              conversation_revision,policy,source,basis)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
            [
              athleteId,
              runId,
              command.threadId,
              snapshot.id,
              command.expectedConversationRevision,
              JSON.stringify(policy),
              JSON.stringify(source),
              JSON.stringify(context.basis),
            ],
          );
          for (const status of [
            { kind: 'running', stage: 'preparing_evidence' },
            { kind: 'running', stage: 'evaluating' },
          ])
            await tx.query(
              'UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
              [athleteId, runId, JSON.stringify(status)],
            );
          await tx.query(
            'INSERT INTO coaching_analysis_output(athlete_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb)',
            [
              athleteId,
              outputId,
              runId,
              JSON.stringify({
                schemaVersion: 3,
                kind: 'joint-fixture-analysis',
                fixtureId: source.fixtureId,
                trust: 'untrusted_fixture',
                validation: 'unvalidated',
              }),
            ],
          );
          await tx.query(
            'UPDATE coaching_run SET status=$3::jsonb,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
            [athleteId, runId, JSON.stringify({ kind: 'analysis_ready', outputId })],
          );
          const receipt = receiptSchema.parse({
            runId,
            evidenceSnapshotId: snapshot.id,
            basis: context.basis,
            nutritionPlanHeads: context.nutritionPlanHeads,
          });
          await enqueue(tx, {
            id: randomUUID(),
            idempotencyKey: key,
            topic: 'coaching.joint_fixture_ready',
            payload: { runId, evidenceSnapshotId: snapshot.id },
          });
          await tx.query(
            'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
            [athleteId, key, JSON.stringify(request), JSON.stringify(receipt)],
          );
          return { receipt, candidateId: null, context };
        });
      }

      if (stored.candidateId) {
        const candidate = await jointApproval.read(athleteId, stored.candidateId);
        if (!candidate) throw new JointFixtureError('JOINT_FIXTURE_UNAVAILABLE');
        return candidate;
      }

      // Replays without a candidate reconstruct only from current tenant-owned heads.
      const context: JointFixtureCapture = stored.context
        ? stored.context
        : await database.tenant(athleteId, async (tx) => {
            await lock(tx);
            return captureJointFixtureContext(tx, {
              threadId: command.threadId,
              evidenceSnapshotId: stored.receipt.evidenceSnapshotId,
              nutritionPlanId: command.nutritionPlanId,
              expectedConversationRevision: command.expectedConversationRevision,
              policy,
            });
          });
      if (
        !isDeepStrictEqual(context.basis, stored.receipt.basis) ||
        !isDeepStrictEqual(context.nutritionPlanHeads, stored.receipt.nutritionPlanHeads)
      )
        throw new JointApprovalError('STALE_BASIS');
      return jointCandidateV3Schema.parse(
        await jointApproval.prepareInternal(athleteId, {
          runId: stored.receipt.runId,
          expectedBasis: stored.receipt.basis,
          expectedNutritionPlanHeads: stored.receipt.nutritionPlanHeads,
          training: {
            proposed: {
              ...context.training.draft,
              title: proposedLabel(context.training.draft.title, 200),
            },
            supplementaryLinks: context.supplementaryLinks,
          },
          nutrition: [
            {
              planId: command.nutritionPlanId,
              proposed: {
                period: context.nutrition.period,
                timezone: context.nutrition.timezone,
                purpose: proposedLabel(context.nutrition.purpose, 160),
                linkedTrainingPlanVersionId: context.nutrition.linkedTrainingPlanVersionId,
                items: context.nutrition.items.map(
                  ({ planVersionId: _versionId, ...item }) => item,
                ),
              },
            },
          ],
          idempotencyKey: hashKey('candidate', command.idempotencyKey),
        }),
      );
    },
  };
}
