import { describe, expect, it } from 'vitest';
import { supplementaryExerciseVersionSchema } from '../src/supplementary-core.js';
import {
  stretchLogCreateSchema,
  stretchingExerciseSaveSchema,
  stretchLogCorrectSchema,
} from '../src/stretching.js';

const id = {
  exercise: '11111111-1111-4111-8111-111111111111',
  version: '22222222-2222-4222-8222-222222222222',
  activity: '33333333-3333-4333-8333-333333333333',
  log: '44444444-4444-4444-8444-444444444444',
};
const definition = {
  schemaVersion: 2,
  exerciseId: id.exercise,
  versionId: id.version,
  name: 'Gentle reach',
  family: 'stretching',
  equipment: ['bodyweight'],
  tags: ['shoulder'],
  countDefinitions: [],
  mediaAssetIds: [],
  resourceVersionIds: [],
  reviewState: 'unreviewed',
  description: 'User-described reach',
  safetyNotes: 'Stop if uncomfortable',
  supportedMetrics: ['duration'],
  createdAt: '2026-09-18T09:00:00.000Z',
};
const profile = {
  method: 'static_hold',
  movement: 'active',
  assistance: 'self',
  context: 'cooldown',
  bodyRegions: ['shoulder'],
  sideBasis: 'per_side',
  source: { kind: 'user_authored' },
};
const values = {
  activityId: id.activity,
  exerciseVersionId: id.version,
  plannedTarget: null,
  allocation: { kind: 'standalone' },
  side: 'left',
  state: 'performed',
  holdSeconds: 30,
  repetitions: null,
  restSeconds: null,
  comfort: 'unknown',
  discomfortNote: null,
  reason: null,
  occurredAt: '2026-09-18T09:01:00.000Z',
};
describe('stretching v2 extension', () => {
  it('preserves historical v2 exercise payloads exactly', () => {
    const legacy = { ...definition, family: 'mobility' };
    expect(supplementaryExerciseVersionSchema.parse(legacy)).toEqual(legacy);
    expect(
      stretchingExerciseSaveSchema.safeParse({
        definition,
        profile,
        expectedVersionId: null,
        idempotencyKey: 'stretch-save-1',
        confirmed: true,
      }).success,
    ).toBe(true);
    expect(
      stretchingExerciseSaveSchema.safeParse({
        definition: { ...definition, family: 'mobility' },
        profile,
        expectedVersionId: null,
        idempotencyKey: 'stretch-save-1',
        confirmed: true,
      }).success,
    ).toBe(false);
  });
  it('keeps static and dynamic targets and source provenance distinct', () => {
    expect(
      stretchingExerciseSaveSchema.safeParse({
        definition: {
          ...definition,
          supportedMetrics: ['count'],
          countDefinitions: [{ kind: 'repetitions', basis: 'per_side', definitionId: 'rep-1' }],
        },
        profile,
        expectedVersionId: null,
        idempotencyKey: 'stretch-save-1',
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      stretchingExerciseSaveSchema.safeParse({
        definition,
        profile: { ...profile, source: { kind: 'resource_version', resourceVersionId: 'missing' } },
        expectedVersionId: null,
        idempotencyKey: 'stretch-save-1',
        confirmed: true,
      }).success,
    ).toBe(false);
  });
  it('does not infer side-specific actuals from a total timer or draft', () => {
    expect(
      stretchLogCreateSchema.safeParse({
        schemaVersion: 1,
        logId: id.log,
        idempotencyKey: 'stretch-log-1',
        confirmation: 'user_confirmed',
        values,
      }).success,
    ).toBe(true);
    expect(
      stretchLogCreateSchema.safeParse({
        schemaVersion: 1,
        logId: id.log,
        idempotencyKey: 'stretch-log-1',
        confirmation: 'draft',
        values,
      }).success,
    ).toBe(false);
    expect(
      stretchLogCreateSchema.safeParse({
        schemaVersion: 1,
        logId: id.log,
        idempotencyKey: 'stretch-log-1',
        confirmation: 'user_confirmed',
        values: { ...values, state: 'performed', holdSeconds: null },
      }).success,
    ).toBe(false);
    expect(
      stretchLogCorrectSchema.safeParse({
        schemaVersion: 1,
        logId: id.log,
        expectedRevision: 1,
        idempotencyKey: 'stretch-log-2',
        confirmation: 'user_confirmed',
        values: { ...values, state: 'stopped', holdSeconds: null, reason: 'Discomfort' },
      }).success,
    ).toBe(true);
  });
  it('requires explicit block bounds or unknown bounds, not a fabricated split', () => {
    const base = {
      schemaVersion: 1,
      logId: id.log,
      idempotencyKey: 'stretch-log-1',
      confirmation: 'user_confirmed',
      values,
    };
    expect(
      stretchLogCreateSchema.safeParse({
        ...base,
        values: {
          ...values,
          allocation: {
            kind: 'activity_block',
            startedAt: null,
            endedAtExclusive: null,
          },
        },
      }).success,
    ).toBe(true);
    expect(
      stretchLogCreateSchema.safeParse({
        ...base,
        values: {
          ...values,
          allocation: {
            kind: 'activity_block',
            startedAt: '2026-09-18T09:00:00Z',
            endedAtExclusive: null,
          },
        },
      }).success,
    ).toBe(false);
  });
});
