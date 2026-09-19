import { describe, expect, it } from 'vitest';
import {
  createRecoveryActionRequestSchema,
  recoveryMethodVersionSchema,
  recoveryStrategyDraftSchema,
} from '../src/recovery-core.js';

const id = '10000000-0000-4000-8000-000000000001';

describe('manual recovery boundaries', () => {
  it('allows complete rest without creating any action, activity or confirmed actual', () => {
    const draft = recoveryStrategyDraftSchema.parse({
      title: 'Pause and review',
      goal: 'Review after rest',
      startDate: '2026-09-18',
      endDateExclusive: '2026-09-20',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: ['Next check-in'],
      priority: 'normal',
      observations: [],
      planRefs: [],
      options: [
        { id, title: 'Full rest', kind: 'full_rest', methodVersionId: null, explanation: '' },
      ],
      reassessment: [
        {
          id: '10000000-0000-4000-8000-000000000002',
          trigger: 'scheduled_checkin',
          plannedAt: '2026-09-20T00:00:00.000Z',
          description: 'Check in',
          policyVersion: null,
        },
      ],
    });
    expect(draft.options[0]?.kind).toBe('full_rest');
    expect(draft.observations).toEqual([]);
    expect(draft.planRefs).toEqual([]);
  });

  it('keeps stable training aggregate identity separate from its frozen head version', () => {
    const aggregateId = '20000000-0000-4000-8000-000000000001';
    const headVersionId = '20000000-0000-4000-8000-000000000002';
    const draft = recoveryStrategyDraftSchema.parse({
      title: 'Stable training reference',
      goal: '',
      startDate: '2026-09-19',
      endDateExclusive: '2026-09-20',
      timezone: 'UTC',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [{ kind: 'training', aggregateId, headVersionId }],
      options: [
        {
          id: '20000000-0000-4000-8000-000000000003',
          title: 'Rest',
          kind: 'full_rest',
          methodVersionId: null,
          explanation: '',
        },
      ],
      reassessment: [
        {
          id: '20000000-0000-4000-8000-000000000004',
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Review the updated plan head.',
          policyVersion: null,
        },
      ],
    });
    expect(draft.planRefs).toEqual([{ kind: 'training', aggregateId, headVersionId }]);
  });

  it('rejects client assertions that a user-recorded method is reviewed', () => {
    const method = {
      schemaVersion: 1,
      methodId: id,
      versionId: id,
      version: 1,
      title: 'Manual entry',
      category: 'thermal_method',
      intendedUse: '',
      applicability: [],
      cautions: [],
      sourceDescription: '',
      evidenceLimitations: 'No efficacy review',
      reviewState: 'reviewed_for_stated_use',
      reviewedAt: null,
      source: 'user_recorded',
      createdAt: '2026-09-18T00:00:00.000Z',
    };
    expect(recoveryMethodVersionSchema.safeParse(method).success).toBe(false);
  });

  it('does not allow an action to claim an unrelated plan option or non-check-in report', () => {
    const action = {
      methodVersionId: id,
      strategyVersionId: null,
      plannedOptionId: id,
      occurredAt: '2026-09-18T12:00:00.000Z',
      timezone: 'UTC',
      state: 'performed',
      durationSeconds: null,
      actualConditions: '',
      beforeCheckIn: null,
      afterCheckIn: null,
      discomfort: '',
      userNotes: '',
      source: 'user_confirmed',
      idempotencyKey: 'recovery-contract-1',
    };
    expect(createRecoveryActionRequestSchema.safeParse(action).success).toBe(false);
    expect(
      createRecoveryActionRequestSchema.safeParse({
        ...action,
        plannedOptionId: null,
        beforeCheckIn: { kind: 'activity', id, revision: 1 },
      }).success,
    ).toBe(false);
  });
});
