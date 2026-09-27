import { describe, expect, it } from 'vitest';
import {
  healthKitBindExistingResultSchema,
  healthKitBindExistingSchema,
} from '../src/healthkit-binding.js';

const command = {
  sampleId: '11111111-1111-4111-8111-111111111111',
  targetActivityId: '22222222-2222-4222-8222-222222222222',
  expectedActivityRevision: 2,
  expectedSampleDigest: 'a'.repeat(64),
  confirmed: true,
  idempotencyKey: 'bind_existing_1',
} as const;

describe('HealthKit existing Activity binding contract', () => {
  it('requires an explicit, version-checked, digest-pinned choice', () => {
    expect(healthKitBindExistingSchema.parse(command)).toEqual(command);
    for (const change of [
      { confirmed: false },
      { expectedActivityRevision: 0 },
      { expectedSampleDigest: 'A'.repeat(64) },
      { idempotencyKey: 'short' },
      { token: 'secret' },
    ]) {
      expect(healthKitBindExistingSchema.safeParse({ ...command, ...change }).success).toBe(false);
    }
  });

  it('returns only the linked Activity identity and reviewed revision', () => {
    const result = {
      sampleId: command.sampleId,
      activityId: command.targetActivityId,
      activityRevision: command.expectedActivityRevision,
      state: 'linked_existing',
    };
    expect(healthKitBindExistingResultSchema.parse(result)).toEqual(result);
    expect(healthKitBindExistingResultSchema.safeParse({ ...result, raw: 'private' }).success).toBe(
      false,
    );
  });
});
