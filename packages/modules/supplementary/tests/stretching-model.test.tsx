import { describe, expect, it } from 'vitest';
import type { StretchingExerciseRead } from '@workout/contracts/stretching';
import {
  emptyStretchForm,
  localDateTimeInput,
  stretchValuesFromForm,
} from '../src/stretching-model';

const read: StretchingExerciseRead = {
  definition: {
    schemaVersion: 2,
    exerciseId: '11111111-1111-4111-8111-111111111111',
    versionId: '22222222-2222-4222-8222-222222222222',
    name: 'Reach',
    family: 'stretching',
    equipment: ['bodyweight'],
    tags: [],
    countDefinitions: [],
    mediaAssetIds: [],
    resourceVersionIds: [],
    reviewState: 'unreviewed',
    description: 'Reach',
    safetyNotes: '',
    supportedMetrics: ['duration'],
    createdAt: '2026-09-18T09:00:00Z',
  },
  profile: {
    method: 'static_hold',
    movement: 'active',
    assistance: 'self',
    context: 'cooldown',
    bodyRegions: ['shoulder'],
    sideBasis: 'per_side',
    source: { kind: 'user_authored' },
  },
  version: 1,
};
const activityId = '33333333-3333-4333-8333-333333333333';
describe('stretching form projection', () => {
  it('keeps unknown metrics null and an unallocated block unallocated', () => {
    const values = stretchValuesFromForm(
      {
        ...emptyStretchForm,
        occurredAt: '2026-09-18T18:00',
        allocation: 'activity_block',
        side: 'unknown',
      },
      activityId,
      read,
    );
    expect(values.holdSeconds).toBeNull();
    expect(values.repetitions).toBeNull();
    expect(values.restSeconds).toBeNull();
    expect(values.allocation).toEqual({
      kind: 'activity_block',
      startedAt: null,
      endedAtExclusive: null,
    });
  });
  it('does not divide a total hold into two side values or merge rest', () => {
    const values = stretchValuesFromForm(
      {
        ...emptyStretchForm,
        occurredAt: '2026-09-18T18:00',
        side: 'total',
        state: 'partial',
        metric: '40',
        rest: '12',
      },
      activityId,
      read,
    );
    expect(values).toMatchObject({
      side: 'total',
      holdSeconds: 40,
      repetitions: null,
      restSeconds: 12,
    });
  });
  it('links a frozen planned target without copying its prescribed hold to actual', () => {
    const executionId = '44444444-4444-4444-8444-444444444444';
    const values = stretchValuesFromForm(
      {
        ...emptyStretchForm,
        occurredAt: '2026-09-18T18:00',
        plannedTargetId: 'hold-left',
        side: 'left',
        state: 'unconfirmed',
      },
      activityId,
      read,
      [
        {
          executionId,
          targetSetId: 'hold-left',
          exerciseVersionId: read.definition.versionId,
          side: 'left',
          plannedHoldSeconds: { min: 40, max: 40 },
          plannedRepetitions: null,
          restAfterSeconds: 20,
        },
      ],
    );
    expect(values.plannedTarget).toEqual({ executionId, targetSetId: 'hold-left' });
    expect(values.holdSeconds).toBeNull();
    expect(values.restSeconds).toBeNull();
  });
  it('requires both explicit block bounds and integer dynamic repetitions', () => {
    expect(() =>
      stretchValuesFromForm(
        {
          ...emptyStretchForm,
          occurredAt: '2026-09-18T18:00',
          allocation: 'activity_block',
          blockStart: '2026-09-18T18:01',
        },
        activityId,
        read,
      ),
    ).toThrow('BLOCK_BOUNDS_REQUIRED');
    const dynamic: StretchingExerciseRead = {
      ...read,
      profile: { ...read.profile, method: 'dynamic_repetitions' },
      definition: {
        ...read.definition,
        supportedMetrics: ['count'],
        countDefinitions: [
          {
            kind: 'repetitions',
            basis: 'per_side',
            definitionId: 'rep-v1',
          },
        ],
      },
    };
    expect(() =>
      stretchValuesFromForm(
        {
          ...emptyStretchForm,
          occurredAt: '2026-09-18T18:00',
          metric: '2.5',
        },
        activityId,
        dynamic,
      ),
    ).toThrow('INVALID_METRIC');
  });
  it('preserves sub-minute source instants on correction until the user edits a time field', () => {
    const original = {
      occurredAt: '2026-09-18T09:04:12.345Z',
      allocation: {
        kind: 'activity_block' as const,
        startedAt: '2026-09-18T09:04:01.123Z',
        endedAtExclusive: '2026-09-18T09:04:59.987Z',
      },
    };
    const form = {
      ...emptyStretchForm,
      side: 'left' as const,
      state: 'performed' as const,
      metric: '25',
      allocation: 'activity_block' as const,
      occurredAt: localDateTimeInput(original.occurredAt),
      blockStart: localDateTimeInput(original.allocation.startedAt),
      blockEnd: localDateTimeInput(original.allocation.endedAtExclusive),
    };
    const unchanged = stretchValuesFromForm(form, activityId, read, [], original);
    expect(unchanged.occurredAt).toBe(original.occurredAt);
    expect(unchanged.allocation).toEqual(original.allocation);
    const nextOccurred = localDateTimeInput(
      new Date(Date.parse(original.occurredAt) + 60_000).toISOString(),
    );
    const nextBlockEnd = localDateTimeInput(
      new Date(Date.parse(original.allocation.endedAtExclusive) + 60_000).toISOString(),
    );
    const edited = stretchValuesFromForm(
      { ...form, occurredAt: nextOccurred, blockEnd: nextBlockEnd },
      activityId,
      read,
      [],
      original,
    );
    expect(edited.occurredAt).not.toBe(original.occurredAt);
    expect(edited.allocation.kind).toBe('activity_block');
    if (edited.allocation.kind === 'activity_block') {
      expect(edited.allocation.startedAt).toBe(original.allocation.startedAt);
      expect(edited.allocation.endedAtExclusive).not.toBe(original.allocation.endedAtExclusive);
    }
  });
});
