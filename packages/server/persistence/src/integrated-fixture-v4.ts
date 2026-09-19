import { createHash } from 'node:crypto';
import { z } from 'zod';

import { coreEvidenceWindowSchema } from '@workout/contracts/evidence-snapshots';
import {
  integratedCandidateV4Schema,
  type IntegratedCandidateV4,
  type IntegratedWriteV4,
} from '@workout/contracts/integrated-coaching';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { planDraftSchema } from '@workout/contracts/planning';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import type { Database } from './database.js';
import {
  IntegratedApprovalV4Error,
  type IntegratedApprovalV4Repository,
} from './integrated-approval-v4.js';
import { PersistenceConflict } from './outbox.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const fixtureWindowSchema = coreEvidenceWindowSchema.refine(
  (window) => window.timezone === 'UTC',
  'Integrated fixture uses UTC',
);

export const integratedFixtureV4CreateSchema = z.strictObject({
  threadId: uuid,
  evidenceSnapshotId: uuid,
  expectedConversationRevision: z.number().int().positive().max(2_147_483_646),
  trainingPlanVersionId: uuid,
  nutritionPlanId: uuid,
  nutritionPlanVersionId: uuid,
  routineBlueprintId: uuid,
  routineBlueprintVersionId: uuid,
  recoveryStrategyId: uuid,
  routineScheduleId: uuid,
  window: fixtureWindowSchema,
  idempotencyKey,
});
export type IntegratedFixtureV4Create = z.infer<typeof integratedFixtureV4CreateSchema>;

export class IntegratedFixtureV4Error extends Error {
  constructor(
    readonly code:
      | 'INTEGRATED_FIXTURE_DISABLED'
      | 'INTEGRATED_FIXTURE_UNAVAILABLE'
      | 'INTEGRATED_FIXTURE_REFERENCE_INVALID',
  ) {
    super(code);
  }
}

export interface IntegratedFixtureV4Repository {
  create(athleteId: string, command: IntegratedFixtureV4Create): Promise<IntegratedCandidateV4>;
}

const fixtureReceiptSchema = z.strictObject({ candidateId: uuid });
const fixtureReceiptKey = (key: string) =>
  `integrated-fixture-v4:${createHash('sha256').update(key).digest('hex')}`;

function deterministicUuid(part: string, command: IntegratedFixtureV4Create) {
  const characters = createHash('sha256')
    .update(`integrated-fixture-v4:${part}:${command.idempotencyKey}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  characters[12] = '4';
  characters[16] = '8';
  const value = characters.join('');
  return uuid.parse(
    `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`,
  );
}

function fixtureLabel(current: string, maximum: number) {
  const suffix = ' [integrated fixture]';
  if (!current.endsWith(suffix) && current.length + suffix.length <= maximum)
    return `${current}${suffix}`;
  return current === 'Integrated fixture proposal'
    ? 'Integrated fixture alternative'
    : 'Integrated fixture proposal';
}

export function createIntegratedFixtureV4Repository(
  database: Database,
  integratedApproval: Pick<
    IntegratedApprovalV4Repository,
    'captureBasis' | 'prepareInternal' | 'read'
  >,
  options: { enabled: boolean; environment: 'development' | 'test' | 'production' },
): IntegratedFixtureV4Repository {
  const enabled = options.enabled && options.environment !== 'production';
  return {
    async create(athleteId, raw) {
      if (!enabled) throw new IntegratedFixtureV4Error('INTEGRATED_FIXTURE_DISABLED');
      const command = integratedFixtureV4CreateSchema.parse(raw);
      const receiptKey = fixtureReceiptKey(command.idempotencyKey);
      const request = {
        kind: 'integrated_fixture_v4',
        threadId: command.threadId,
        evidenceSnapshotId: command.evidenceSnapshotId,
        expectedConversationRevision: command.expectedConversationRevision,
        trainingPlanVersionId: command.trainingPlanVersionId,
        nutritionPlanId: command.nutritionPlanId,
        nutritionPlanVersionId: command.nutritionPlanVersionId,
        routineBlueprintId: command.routineBlueprintId,
        routineBlueprintVersionId: command.routineBlueprintVersionId,
        recoveryStrategyId: command.recoveryStrategyId,
        routineScheduleId: command.routineScheduleId,
        window: command.window,
      };
      const replay = await database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const row = (
          await tx.query(
            'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
            [athleteId, receiptKey, JSON.stringify(request)],
          )
        ).rows[0];
        if (!row) return null;
        if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
        return fixtureReceiptSchema.parse(row['result']);
      });
      if (replay) {
        const candidate = await integratedApproval.read(athleteId, replay.candidateId);
        if (!candidate) throw new IntegratedFixtureV4Error('INTEGRATED_FIXTURE_UNAVAILABLE');
        return candidate;
      }
      const stored = await database.tenant(athleteId, async (tx) => {
        const evidence = await tx.query(
          `SELECT 1 FROM core_evidence_snapshot e JOIN coaching_thread t
           ON t.athlete_id=e.athlete_id AND t.id=e.thread_id
           WHERE e.athlete_id=$1 AND e.id=$2 AND e.thread_id=$3 AND t.revision=$4
             AND e.body IS NOT NULL AND e.purged_reason IS NULL`,
          [
            athleteId,
            command.evidenceSnapshotId,
            command.threadId,
            command.expectedConversationRevision,
          ],
        );
        const training = (
          await tx.query(
            `SELECT h.aggregate_id,p.draft FROM plan_snapshot p JOIN plan_head h
             ON h.athlete_id=p.athlete_id AND h.version_id=p.id
             WHERE p.athlete_id=$1 AND p.id=$2`,
            [athleteId, command.trainingPlanVersionId],
          )
        ).rows[0];
        const nutrition = (
          await tx.query(
            `SELECT v.record_json FROM nutrition_plan_version v JOIN nutrition_plan_head h
             ON h.athlete_id=v.athlete_id AND h.plan_id=v.plan_id AND h.version_id=v.version_id
             WHERE v.athlete_id=$1 AND v.plan_id=$2 AND v.version_id=$3`,
            [athleteId, command.nutritionPlanId, command.nutritionPlanVersionId],
          )
        ).rows[0];
        const blueprint = (
          await tx.query(
            `SELECT v.record_json FROM routine_blueprint_version v JOIN routine_blueprint_head h
             ON h.athlete_id=v.athlete_id AND h.routine_id=v.routine_id
               AND h.version_id=v.version_id
             WHERE v.athlete_id=$1 AND v.routine_id=$2 AND v.version_id=$3
               AND h.visibility='active'`,
            [athleteId, command.routineBlueprintId, command.routineBlueprintVersionId],
          )
        ).rows[0];
        if (!evidence.rowCount || !training || !nutrition || !blueprint)
          throw new IntegratedFixtureV4Error('INTEGRATED_FIXTURE_REFERENCE_INVALID');
        return {
          trainingAggregateId: uuid.parse(training['aggregate_id']),
          training: planDraftSchema.parse(training['draft']),
          nutrition: nutritionPlanVersionSchema.parse(nutrition['record_json']),
          blueprint: routineBlueprintVersionSchema.parse(blueprint['record_json']),
        };
      });

      if (
        stored.nutrition.planId !== command.nutritionPlanId ||
        stored.nutrition.versionId !== command.nutritionPlanVersionId ||
        stored.blueprint.routineId !== command.routineBlueprintId ||
        stored.blueprint.versionId !== command.routineBlueprintVersionId
      )
        throw new IntegratedFixtureV4Error('INTEGRATED_FIXTURE_REFERENCE_INVALID');

      const basis = await integratedApproval.captureBasis(athleteId, {
        evidenceSnapshotId: command.evidenceSnapshotId,
        trainingAggregateId: stored.trainingAggregateId,
        nutritionAggregateId: command.nutritionPlanId,
        recoveryAggregateId: command.recoveryStrategyId,
        routineScheduleAggregateId: command.routineScheduleId,
      });
      if (
        basis.conversationRevision !== command.expectedConversationRevision ||
        basis.planHeads.some(
          (head) =>
            (head.domain === 'training' &&
              (head.head.kind !== 'exists' ||
                head.head.versionId !== command.trainingPlanVersionId)) ||
            (head.domain === 'nutrition' &&
              (head.head.kind !== 'exists' ||
                head.head.versionId !== command.nutritionPlanVersionId)) ||
            ((head.domain === 'recovery' || head.domain === 'routine_schedule') &&
              head.head.kind !== 'absent'),
        )
      )
        throw new IntegratedApprovalV4Error('STALE_BASIS');

      const optionId = deterministicUuid('recovery-option', command);
      const scheduleVersionId = deterministicUuid('schedule-version', command);
      const writes: IntegratedWriteV4[] = [
        {
          domain: 'training',
          aggregateId: stored.trainingAggregateId,
          proposed: {
            ...stored.training,
            title: fixtureLabel(stored.training.title, 200),
          },
        },
        {
          domain: 'nutrition',
          aggregateId: command.nutritionPlanId,
          proposed: {
            period: stored.nutrition.period,
            timezone: stored.nutrition.timezone,
            purpose: fixtureLabel(stored.nutrition.purpose, 160),
            linkedTrainingPlanVersionId: stored.nutrition.linkedTrainingPlanVersionId,
            items: stored.nutrition.items
              .filter((item) => item.source === 'user_confirmed')
              .map(({ planVersionId: _versionId, ...item }) => ({
                ...item,
                source: 'user_confirmed' as const,
              })),
          },
        },
        {
          domain: 'recovery',
          aggregateId: command.recoveryStrategyId,
          selectedOptionId: optionId,
          proposed: {
            title: 'Integrated fixture recovery',
            goal: 'Deterministic non-production recovery proposal.',
            startDate: command.window.from,
            endDateExclusive: command.window.toExclusive,
            timezone: command.window.timezone,
            knownFacts: [],
            missingInformation: [],
            priority: 'normal',
            observations: [],
            planRefs: [
              {
                kind: 'training',
                aggregateId: stored.trainingAggregateId,
                headVersionId: command.trainingPlanVersionId,
              },
              {
                kind: 'nutrition',
                aggregateId: command.nutritionPlanId,
                headVersionId: command.nutritionPlanVersionId,
              },
            ],
            options: [
              {
                id: optionId,
                title: 'Fixture full rest',
                kind: 'full_rest',
                methodVersionId: null,
                explanation: 'Server-owned deterministic fixture option.',
              },
            ],
            reassessment: [
              {
                id: deterministicUuid('reassessment', command),
                trigger: 'plan_changed',
                plannedAt: null,
                description: 'Reassess when the referenced plan changes.',
                policyVersion: null,
              },
            ],
          },
        },
        {
          domain: 'routine_schedule',
          aggregateId: command.routineScheduleId,
          sourcePlanVersionId: command.trainingPlanVersionId,
          proposed: {
            schemaVersion: 4,
            id: command.routineScheduleId,
            versionId: scheduleVersionId,
            blueprint: {
              id: command.routineBlueprintId,
              versionId: command.routineBlueprintVersionId,
            },
            window: {
              startDate: command.window.from,
              endDateExclusive: command.window.toExclusive,
              timezone: command.window.timezone,
              maxOccurrences: 1,
            },
            rule: { kind: 'dates', dates: [command.window.from], localTime: '08:00' },
            state: 'active',
          },
          occurrences: [
            {
              id: deterministicUuid('occurrence', command),
              schedule: { id: command.routineScheduleId, versionId: scheduleVersionId },
              blueprint: {
                id: command.routineBlueprintId,
                versionId: command.routineBlueprintVersionId,
              },
              anchorKey: `date:${command.window.from}`,
              scheduledAt: `${command.window.from}T08:00:00.000Z`,
              timingStatus: 'resolved',
              stepBindings: [],
              selectedChoices: {},
            },
          ],
        },
      ];
      const candidate = integratedCandidateV4Schema.parse(
        await integratedApproval.prepareInternal(athleteId, {
          proposalId: deterministicUuid('proposal', command),
          basis,
          writes,
          summary: 'Deterministic non-production four-domain integrated fixture.',
          validation: { status: 'checked', errors: [], unknowns: [] },
          idempotencyKey: `fixture_v4_${createHash('sha256').update(command.idempotencyKey).digest('hex')}`,
        }),
      );
      await database.tenant(athleteId, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
        const row = (
          await tx.query(
            'SELECT request=$3::jsonb AS matches,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=$2',
            [athleteId, receiptKey, JSON.stringify(request)],
          )
        ).rows[0];
        if (row) {
          if (row['matches'] !== true) throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          const prior = fixtureReceiptSchema.parse(row['result']);
          if (prior.candidateId !== candidate.id)
            throw new PersistenceConflict('IDEMPOTENCY_CONFLICT');
          return;
        }
        await tx.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [
            athleteId,
            receiptKey,
            JSON.stringify(request),
            JSON.stringify({ candidateId: candidate.id }),
          ],
        );
      });
      return candidate;
    },
  };
}
