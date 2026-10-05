import { describe, expect, it } from 'vitest';
import {
  healthKitListRegisteredWorkoutsQuerySchema,
  healthKitListRegisteredWorkoutsResultSchema,
  healthKitRegisterWorkoutsResultSchema,
  healthKitRegisterWorkoutsSchema,
  healthKitRegisteredIngestionAckSchema,
  healthKitRegisteredIngestionBatchSchema,
  healthKitRegistrationErrorSchema,
} from '../src/healthkit-registration.js';

const sampleId = '01c173b9-1733-4fa5-9cc6-ff0dfebfab84';
const otherSampleId = '41c173b9-1733-4fa5-9cc6-ff0dfebfab84';
const claimEpoch = '13f606b4-c8ea-4e24-a787-cc012129e878';
const nextClaimEpoch = '23f606b4-c8ea-4e24-a787-cc012129e878';
const installationId = '33f606b4-c8ea-4e24-a787-cc012129e878';
const batchId = '7b840128-e253-41db-af9f-b199c9531f96';

const register = {
  schemaVersion: 1,
  sampleIds: [sampleId],
  accountAttributionDeclared: true,
  expectedConsentRevision: 2,
  expectedRegistryRevision: 0,
  idempotencyKey: 'register_001',
} as const;

const upsert = {
  kind: 'upsert',
  sampleId,
  claimEpoch,
  sourceBundleId: 'com.example.workouts',
  sourceVersion: null,
  activityType: 37,
  observedFrom: '2026-09-28T09:00:00+09:00',
  observedTo: '2026-09-28T09:30:00+09:00',
  durationSeconds: 1800,
  distanceMeters: null,
  energyKilocalories: 0,
} as const;

describe('HealthKit account registration contracts', () => {
  it('requires an explicit account attribution declaration and valid consent revision', () => {
    expect(healthKitRegisterWorkoutsSchema.parse(register).accountAttributionDeclared).toBe(true);
    for (const invalid of [
      { ...register, accountAttributionDeclared: false },
      { ...register, accountAttributionDeclared: undefined },
      { ...register, expectedConsentRevision: 0 },
      { ...register, expectedConsentRevision: 2.5 },
      { ...register, expectedRegistryRevision: -1 },
      { ...register, idempotencyKey: 'short' },
      { ...register, athleteId: 'other-account' },
      { ...register, schemaVersion: 2 },
    ]) {
      expect(healthKitRegisterWorkoutsSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('bounds selected UUIDs and rejects case-insensitive duplicates', () => {
    expect(
      healthKitRegisterWorkoutsSchema.parse({
        ...register,
        sampleIds: [sampleId.toUpperCase(), otherSampleId],
      }).sampleIds,
    ).toEqual([sampleId, otherSampleId]);
    expect(
      healthKitRegisterWorkoutsSchema.safeParse({
        ...register,
        sampleIds: [sampleId, sampleId.toUpperCase()],
      }).success,
    ).toBe(false);
    expect(healthKitRegisterWorkoutsSchema.safeParse({ ...register, sampleIds: [] }).success).toBe(
      false,
    );
    const fiftyOne = Array.from(
      { length: 51 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    );
    expect(
      healthKitRegisterWorkoutsSchema.safeParse({ ...register, sampleIds: fiftyOne.slice(0, 50) })
        .success,
    ).toBe(true);
    expect(
      healthKitRegisterWorkoutsSchema.safeParse({ ...register, sampleIds: fiftyOne }).success,
    ).toBe(false);
  });

  it('uses opaque claim epochs and a bounded account-scoped listing', () => {
    const claim = { sampleId: sampleId.toUpperCase(), claimEpoch: claimEpoch.toUpperCase() };
    expect(
      healthKitRegisterWorkoutsResultSchema.parse({
        schemaVersion: 1,
        claims: [claim],
        registryRevision: 1,
      }).claims,
    ).toEqual([{ sampleId, claimEpoch }]);
    expect(
      healthKitRegisterWorkoutsResultSchema.safeParse({
        schemaVersion: 1,
        claims: [claim, { sampleId, claimEpoch: nextClaimEpoch }],
        registryRevision: 1,
      }).success,
    ).toBe(false);
    expect(healthKitListRegisteredWorkoutsQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    for (const query of [{ limit: '0' }, { limit: '101' }, { limit: '+1' }, { cursor: '..' }]) {
      expect(healthKitListRegisteredWorkoutsQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(
      healthKitListRegisteredWorkoutsResultSchema.safeParse({
        schemaVersion: 1,
        claims: [],
        registryRevision: 0,
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      healthKitListRegisteredWorkoutsResultSchema.safeParse({
        schemaVersion: 1,
        claims: [{ sampleId, claimEpoch }],
        registryRevision: 1,
        nextCursor: null,
        ownerAthleteId: 'other-account',
      }).success,
    ).toBe(false);
  });

  it('rejects legacy v1 batches and requires a claim epoch on every v2 event', () => {
    const batch = { schemaVersion: 2, installationId, batchId, events: [upsert] };
    expect(healthKitRegisteredIngestionBatchSchema.safeParse(batch).success).toBe(true);
    for (const invalid of [
      { ...batch, schemaVersion: 1 },
      { ...batch, events: [{ ...upsert, claimEpoch: undefined }] },
      { ...batch, events: [{ ...upsert, ownerAthleteId: 'other-account' }] },
      { ...batch, events: [{ ...upsert, distanceMeters: -1 }] },
      {
        ...batch,
        events: [upsert, { kind: 'delete', sampleId: sampleId.toUpperCase(), claimEpoch }],
      },
      { ...batch, events: [{ kind: 'delete', sampleId, claimEpoch: 'bad' }] },
    ]) {
      expect(healthKitRegisteredIngestionBatchSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      healthKitRegisteredIngestionBatchSchema.parse({
        ...batch,
        events: [{ kind: 'delete', sampleId: sampleId.toUpperCase(), claimEpoch }],
      }).events,
    ).toEqual([{ kind: 'delete', sampleId, claimEpoch }]);
    expect(
      healthKitRegisteredIngestionAckSchema.safeParse({
        schemaVersion: 2,
        installationId,
        batchId,
        acceptedCount: 1,
      }).success,
    ).toBe(true);
    expect(
      healthKitRegisteredIngestionAckSchema.safeParse({
        schemaVersion: 1,
        installationId,
        batchId,
        acceptedCount: 1,
      }).success,
    ).toBe(false);
  });

  it('keeps conflict codes stable without leaking another account or UUID', () => {
    for (const code of [
      'INVALID_REQUEST',
      'BEARER_REQUIRED',
      'UNAUTHENTICATED',
      'CONSENT_REQUIRED',
      'CONSENT_EPOCH_EXPIRED',
      'REGISTRATION_REQUIRED',
      'CLAIM_CONFLICT',
      'CLAIM_EPOCH_EXPIRED',
      'REGISTRY_REVISION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'LEGACY_BATCH_UNSUPPORTED',
    ]) {
      expect(
        healthKitRegistrationErrorSchema.safeParse({ error: { code }, requestId: 'request-1' })
          .success,
      ).toBe(true);
    }
    expect(
      healthKitRegistrationErrorSchema.safeParse({
        error: { code: 'CLAIM_CONFLICT', ownerAthleteId: 'other-account' },
        requestId: 'request-1',
      }).success,
    ).toBe(false);
    expect(
      healthKitRegistrationErrorSchema.safeParse({
        error: { code: 'UNKNOWN' },
        requestId: 'request-1',
      }).success,
    ).toBe(false);
  });
});
