import { expect, it } from 'vitest';
import {
  healthKitCreateActivityResultSchema,
  healthKitCreateActivitySchema,
} from '../src/healthkit-activity.js';

const command = {
  sampleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  expectedSampleDigest: 'a'.repeat(64),
  confirmed: true,
  idempotencyKey: 'create-healthkit-001',
};

it('requires an explicit confirmed digest-bound choice', () => {
  expect(healthKitCreateActivitySchema.parse(command)).toEqual(command);
  for (const invalid of [
    { ...command, confirmed: false },
    { ...command, expectedSampleDigest: 'bad' },
    { ...command, athleteId: 'other' },
    { ...command, title: 'inferred title' },
  ]) {
    expect(healthKitCreateActivitySchema.safeParse(invalid).success).toBe(false);
  }
});

it('returns only the canonical identity and state', () => {
  const result = {
    sampleId: command.sampleId,
    activityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    activityRevision: 1,
    state: 'created_activity',
  };
  expect(healthKitCreateActivityResultSchema.parse(result)).toEqual(result);
  expect(
    healthKitCreateActivityResultSchema.safeParse({ ...result, sourceBundleId: 'private' }).success,
  ).toBe(false);
});
