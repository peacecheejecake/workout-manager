import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  recoveryStrategyDraftSchema,
  recoveryStrategyVersionSchema,
  type RecoveryStrategyDraft,
} from '@workout/contracts/recovery-core';
import {
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  type RoutineScheduleVersion,
  type RoutineOccurrence,
} from '@workout/contracts/routines';
import type { Transaction } from './database.js';

export class RaceManualApprovalDomainWriteError extends Error {
  constructor(readonly code: 'CANDIDATE_NOT_APPROVABLE' | 'STALE_BASIS') {
    super(code);
    this.name = 'RaceManualApprovalDomainWriteError';
  }
}

/** Same-transaction write primitives. The caller must first establish actual
 * owned sources, app admission, complete affected scope and current head CAS;
 * neither a parsed draft nor this function grants approval authority. History,
 * outbox and the parent approval receipt remain the caller's atomic responsibility. */
export async function persistRecoveryStrategyVersionIn(
  tx: Transaction,
  input: {
    aggregateId: string;
    expectedVersionId: string | null;
    draft: RecoveryStrategyDraft;
    selectedOptionId: string;
    approvedAt: string;
    createId?: () => string;
  },
) {
  const draft = recoveryStrategyDraftSchema.parse(input.draft);
  const selected = draft.options.find((row) => row.id === input.selectedOptionId);
  if (!selected) throw new RaceManualApprovalDomainWriteError('CANDIDATE_NOT_APPROVABLE');
  const previousRow =
    input.expectedVersionId === null
      ? undefined
      : (
          await tx.query(
            'SELECT record_json FROM recovery_strategy_version WHERE athlete_id=$1 AND version_id=$2',
            [tx.athleteId, input.expectedVersionId],
          )
        ).rows[0];
  const previous = previousRow
    ? recoveryStrategyVersionSchema.parse(previousRow['record_json'])
    : null;
  if (
    input.expectedVersionId !== null &&
    (previous === null ||
      previous.strategyId !== input.aggregateId ||
      previous.versionId !== input.expectedVersionId)
  )
    throw new RaceManualApprovalDomainWriteError('STALE_BASIS');
  const saved = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: input.aggregateId,
    versionId: (input.createId ?? randomUUID)(),
    version: (previous?.version ?? 0) + 1,
    previousVersionId: previous?.versionId ?? null,
    status: 'user_confirmed',
    selectedOptionId: input.selectedOptionId,
    createdAt: input.approvedAt,
    draft,
  });
  await tx.query(
    `INSERT INTO recovery_strategy_version
    (athlete_id,strategy_id,version_id,version,previous_version_id,previous_version,record_json)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      tx.athleteId,
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
    [tx.athleteId, saved.strategyId, saved.version, saved.versionId],
  );
  return saved;
}

/** Materialize a new immutable version, never mutate existing occurrences/runs.
 * The transaction owner must hold the tenant command fence and validate the full
 * affected/started-anchor roster before calling. These structural/CAS checks do
 * not grant approval authority. Repeated anchors require the version-scoped SQL
 * successor; the historical immutable schema is never bypassed here. */
export async function persistRoutineScheduleVersionIn(
  tx: Transaction,
  input: {
    aggregateId: string;
    expectedVersionId: string | null;
    schedule: RoutineScheduleVersion;
    sourcePlanVersionId: string | null;
    occurrences: readonly RoutineOccurrence[];
    approvedAt: string;
  },
) {
  const schedule = routineScheduleVersionSchema.parse(input.schedule);
  const occurrences = z.array(routineOccurrenceSchema).max(1000).parse(input.occurrences);
  if (
    schedule.id !== input.aggregateId ||
    schedule.versionId === input.expectedVersionId ||
    new Set(occurrences.map((item) => item.id)).size !== occurrences.length ||
    new Set(occurrences.map((item) => item.anchorKey)).size !== occurrences.length ||
    occurrences.some(
      (item) =>
        item.schedule.id !== input.aggregateId ||
        item.schedule.versionId !== schedule.versionId ||
        item.blueprint.id !== schedule.blueprint.id ||
        item.blueprint.versionId !== schedule.blueprint.versionId,
    )
  )
    throw new RaceManualApprovalDomainWriteError('CANDIDATE_NOT_APPROVABLE');
  const head = (
    await tx.query(
      `SELECT h.version_id,v.record_json FROM routine_schedule_head h
       JOIN routine_schedule_version v ON v.athlete_id=h.athlete_id
         AND v.schedule_id=h.schedule_id AND v.version_id=h.version_id
       WHERE h.athlete_id=$1 AND h.schedule_id=$2 FOR UPDATE OF h`,
      [tx.athleteId, input.aggregateId],
    )
  ).rows[0];
  if (input.expectedVersionId === null ? head !== undefined : head === undefined)
    throw new RaceManualApprovalDomainWriteError('STALE_BASIS');
  if (head) {
    const prior = routineScheduleVersionSchema.parse(head['record_json']);
    if (
      head['version_id'] !== input.expectedVersionId ||
      prior.versionId !== input.expectedVersionId ||
      prior.id !== input.aggregateId
    )
      throw new RaceManualApprovalDomainWriteError('STALE_BASIS');
  }
  await tx.query(
    `INSERT INTO routine_schedule_version
    (athlete_id,schedule_id,version_id,prior_version_id,blueprint_routine_id,
     blueprint_version_id,source_plan_version_id,record_json,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [
      tx.athleteId,
      input.aggregateId,
      schedule.versionId,
      input.expectedVersionId,
      schedule.blueprint.id,
      schedule.blueprint.versionId,
      input.sourcePlanVersionId,
      JSON.stringify(schedule),
      input.approvedAt,
    ],
  );
  const advanced = await tx.query(
    input.expectedVersionId === null
      ? `INSERT INTO routine_schedule_head(athlete_id,schedule_id,version_id) VALUES($1,$2,$3)
         ON CONFLICT(athlete_id,schedule_id) DO NOTHING RETURNING version_id`
      : `UPDATE routine_schedule_head SET version_id=$3
         WHERE athlete_id=$1 AND schedule_id=$2 AND version_id=$4 RETURNING version_id`,
    input.expectedVersionId === null
      ? [tx.athleteId, input.aggregateId, schedule.versionId]
      : [tx.athleteId, input.aggregateId, schedule.versionId, input.expectedVersionId],
  );
  if (advanced.rowCount !== 1) throw new RaceManualApprovalDomainWriteError('STALE_BASIS');
  for (const item of occurrences)
    await tx.query(
      `INSERT INTO routine_occurrence
    (athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,
     blueprint_version_id,anchor_key,scheduled_at,record_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        tx.athleteId,
        item.id,
        input.aggregateId,
        schedule.versionId,
        item.blueprint.id,
        item.blueprint.versionId,
        item.anchorKey,
        item.scheduledAt,
        JSON.stringify(item),
      ],
    );
  return { versionId: schedule.versionId, occurrenceIds: occurrences.map((row) => row.id) };
}
