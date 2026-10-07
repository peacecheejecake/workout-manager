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
      priorVersionId = randomUUID(),
      { tx, query } = transaction([
        { version_id: priorVersionId, record_json: { ...schedule, versionId: priorVersionId } },
      ]);
    const result = await persistRoutineScheduleVersionIn(tx, {
      aggregateId: schedule.id,
      expectedVersionId: priorVersionId,
      schedule,
      sourcePlanVersionId: null,
      occurrences: [occurrence],
      approvedAt: at,
    });
    expect(result).toEqual({ versionId: schedule.versionId, occurrenceIds: [occurrence.id] });
    expect(query.mock.calls[1]?.[1]?.[7]).toBe(JSON.stringify(schedule));
    expect(query.mock.calls[3]?.[1]?.[8]).toBe(JSON.stringify(occurrence));
    expect(query.mock.calls[2]?.[0]).toContain('AND version_id=$4 RETURNING');
    expect(query.mock.calls[2]?.[1]?.[3]).toBe(priorVersionId);
    expect(query.mock.calls.some(([sql]) => sql.includes('routine_run'))).toBe(false);
  });
  it('creates an absent head without updating historical occurrences', async () => {
    const { schedule, occurrence } = routine(),
      { tx, query } = transaction();
    await persistRoutineScheduleVersionIn(tx, {
      aggregateId: schedule.id,
      expectedVersionId: null,
      schedule,
      sourcePlanVersionId: null,
      occurrences: [occurrence],
      approvedAt: at,
    });
    expect(query.mock.calls[2]?.[0]).toContain('DO NOTHING RETURNING');
    expect(
      query.mock.calls.some(([sql]) => /(?:UPDATE|DELETE).*routine_occurrence/s.test(sql)),
    ).toBe(false);
  });
  it.each(['absent', 'changed', 'foreign'] as const)(
    'rejects %s prior head before new version writes',
    async (kind) => {
      const { schedule, occurrence } = routine(),
        expected = randomUUID();
      const { tx, query } = transaction(
        kind === 'absent'
          ? []
          : [
              {
                version_id: kind === 'changed' ? randomUUID() : expected,
                record_json: {
                  ...schedule,
                  id: kind === 'foreign' ? randomUUID() : schedule.id,
                  versionId: expected,
                },
              },
            ],
      );
      await expect(
        persistRoutineScheduleVersionIn(tx, {
          aggregateId: schedule.id,
          expectedVersionId: expected,
          schedule,
          sourcePlanVersionId: null,
          occurrences: [occurrence],
          approvedAt: at,
        }),
      ).rejects.toThrow('STALE_BASIS');
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
  it('rejects a present head when absence was expected', async () => {
    const { schedule, occurrence } = routine(),
      prior = randomUUID();
    const { tx, query } = transaction([
      { version_id: prior, record_json: { ...schedule, versionId: prior } },
    ]);
    await expect(
      persistRoutineScheduleVersionIn(tx, {
        aggregateId: schedule.id,
        expectedVersionId: null,
        schedule,
        sourcePlanVersionId: null,
        occurrences: [occurrence],
        approvedAt: at,
      }),
    ).rejects.toThrow('STALE_BASIS');
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('rejects a failed head CAS before occurrence writes', async () => {
    const { schedule, occurrence } = routine(),
      prior = randomUUID();
    const { tx, query } = transaction([
      { version_id: prior, record_json: { ...schedule, versionId: prior } },
    ]);
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      persistRoutineScheduleVersionIn(tx, {
        aggregateId: schedule.id,
        expectedVersionId: prior,
        schedule,
        sourcePlanVersionId: null,
        occurrences: [occurrence],
        approvedAt: at,
      }),
    ).rejects.toThrow('STALE_BASIS');
    expect(query).toHaveBeenCalledTimes(3);
  });
  it.each(['id', 'anchorKey'] as const)('rejects duplicate %s before SQL', async (key) => {
    const { schedule, occurrence } = routine(),
      { tx, query } = transaction();
    const other =
      key === 'id'
        ? { ...occurrence, anchorKey: 'different' }
        : { ...occurrence, id: randomUUID() };
    await expect(
      persistRoutineScheduleVersionIn(tx, {
        aggregateId: schedule.id,
        expectedVersionId: null,
        schedule,
        sourcePlanVersionId: null,
        occurrences: [occurrence, other],
        approvedAt: at,
      }),
    ).rejects.toThrow('CANDIDATE_NOT_APPROVABLE');
    expect(query).not.toHaveBeenCalled();
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
