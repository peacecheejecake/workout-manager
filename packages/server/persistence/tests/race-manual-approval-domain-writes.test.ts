import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  recoveryStrategyDraftSchema,
  recoveryStrategyVersionSchema,
} from '@workout/contracts/recovery-core';
import { routineScheduleVersionSchema, routineOccurrenceSchema } from '@workout/contracts/routines';
import {
  RaceManualApprovalDomainWriteError,
  persistRecoveryStrategyVersionIn,
  persistRoutineScheduleVersionIn,
} from '../src/race-manual-approval-domain-writes.js';
import {
  IntegratedApprovalV4Error,
  runIntegratedApprovalDomainWrite,
} from '../src/integrated-approval-v4.js';
import type { Transaction } from '../src/database.js';
const at = '2026-10-08T00:00:00.000Z';
function recovery() {
  const option = randomUUID();
  return {
    option,
    draft: recoveryStrategyDraftSchema.parse({
      title: 'Synthetic',
      goal: 'Retain reported facts',
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-10',
      timezone: 'UTC',
      knownFacts: ['User reported'],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        {
          id: option,
          title: 'Existing rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: 'Existing selected option',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'plan_changed',
          description: 'Review',
          plannedAt: null,
          policyVersion: null,
        },
      ],
    }),
  };
}
function routine() {
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: randomUUID(), versionId: randomUUID() },
    window: {
      startDate: '2026-10-07',
      endDateExclusive: '2026-10-10',
      timezone: 'UTC',
      maxOccurrences: 2,
    },
    rule: { kind: 'dates', dates: ['2026-10-08'], localTime: '07:00' },
    state: 'active',
  });
  const occurrence = routineOccurrenceSchema.parse({
    id: randomUUID(),
    schedule: { id: schedule.id, versionId: schedule.versionId },
    blueprint: schedule.blueprint,
    anchorKey: 'date:2026-10-08',
    scheduledAt: '2026-10-08T07:00:00Z',
    timingStatus: 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  return { schedule, occurrence };
}
function transaction(rows: Record<string, unknown>[] = []) {
  const query = vi.fn<Transaction['query']>().mockResolvedValue({ rows: [], rowCount: 1 });
  query.mockResolvedValueOnce({ rows, rowCount: rows.length });
  return { tx: { athleteId: 'synthetic-tenant', query } satisfies Transaction, query };
}
describe('same transaction recovery/routine writes', () => {
  it('retains exact confirmed recovery draft and increments immutable prior version', async () => {
    const { option, draft } = recovery(),
      aggregateId = randomUUID(),
      versionId = randomUUID(),
      next = randomUUID();
    const prior = recoveryStrategyVersionSchema.parse({
      schemaVersion: 1,
      strategyId: aggregateId,
      versionId,
      version: 2,
      previousVersionId: randomUUID(),
      status: 'user_confirmed',
      selectedOptionId: option,
      createdAt: at,
      draft,
    });
    const { tx, query } = transaction([{ record_json: prior }]);
    const saved = await persistRecoveryStrategyVersionIn(tx, {
      aggregateId,
      expectedVersionId: versionId,
      draft,
      selectedOptionId: option,
      approvedAt: at,
      createId: () => next,
    });
    expect(saved).toMatchObject({
      version: 3,
      versionId: next,
      previousVersionId: versionId,
      draft,
      selectedOptionId: option,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[1]?.[0]).toBe(tx.athleteId);
  });
  it('denies missing/foreign prior and absent selected option before writes', async () => {
    const { option, draft } = recovery();
    const { tx, query } = transaction();
    await expect(
      persistRecoveryStrategyVersionIn(tx, {
        aggregateId: randomUUID(),
        expectedVersionId: randomUUID(),
        draft,
        selectedOptionId: option,
        approvedAt: at,
      }),
    ).rejects.toThrow('STALE_BASIS');
    expect(query).toHaveBeenCalledTimes(1);
    query.mockClear();
    await expect(
      persistRecoveryStrategyVersionIn(tx, {
        aggregateId: randomUUID(),
        expectedVersionId: null,
        draft,
        selectedOptionId: randomUUID(),
        approvedAt: at,
      }),
    ).rejects.toThrow('CANDIDATE_NOT_APPROVABLE');
    expect(query).not.toHaveBeenCalled();
  });
  it('persists exact new schedule and occurrence bytes without touching started runs', async () => {
    const { schedule, occurrence } = routine(),
      { tx, query } = transaction();
    const result = await persistRoutineScheduleVersionIn(tx, {
      aggregateId: schedule.id,
      expectedVersionId: randomUUID(),
      schedule,
      sourcePlanVersionId: null,
      occurrences: [occurrence],
      approvedAt: at,
    });
    expect(result).toEqual({ versionId: schedule.versionId, occurrenceIds: [occurrence.id] });
    expect(query.mock.calls[0]?.[1]?.[7]).toBe(JSON.stringify(schedule));
    expect(query.mock.calls[2]?.[1]?.[8]).toBe(JSON.stringify(occurrence));
    expect(query.mock.calls.some(([sql]) => sql.includes('routine_run'))).toBe(false);
  });
  it('denies foreign lineage and reused schedule version before SQL', async () => {
    const { schedule, occurrence } = routine(),
      { tx, query } = transaction();
    for (const args of [
      {
        schedule,
        occurrences: [
          { ...occurrence, blueprint: { ...occurrence.blueprint, versionId: randomUUID() } },
        ],
        expectedVersionId: randomUUID(),
      },
      { schedule, occurrences: [occurrence], expectedVersionId: schedule.versionId },
    ])
      await expect(
        persistRoutineScheduleVersionIn(tx, {
          aggregateId: schedule.id,
          sourcePlanVersionId: null,
          approvedAt: at,
          ...args,
        }),
      ).rejects.toThrow('CANDIDATE_NOT_APPROVABLE');
    expect(query).not.toHaveBeenCalled();
  });
});

describe('legacy approval domain error translation', () => {
  it.each(['STALE_BASIS', 'CANDIDATE_NOT_APPROVABLE'] as const)(
    'preserves %s API error identity',
    async (code) => {
      const failure = new RaceManualApprovalDomainWriteError(code);
      const result = runIntegratedApprovalDomainWrite(async () => {
        throw failure;
      });
      await expect(result).rejects.toBeInstanceOf(IntegratedApprovalV4Error);
      await expect(result).rejects.toMatchObject({ code });
    },
  );
  it('preserves database, schema and unrelated errors without message matching', async () => {
    for (const failure of [
      new Error('STALE_BASIS'),
      new TypeError('schema'),
      Object.assign(new Error('database'), { code: '42501' }),
    ]) {
      await expect(
        runIntegratedApprovalDomainWrite(async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    }
  });
});
