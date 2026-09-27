import { describe, expect, it } from 'vitest';
import {
  healthKitIngestionAckSchema,
  healthKitIngestionBatchSchema,
} from '../src/healthkit-ingestion.js';

const installationId = '13f606b4-c8ea-4e24-a787-cc012129e878';
const batchId = '7b840128-e253-41db-af9f-b199c9531f96';
const sampleId = '01c173b9-1733-4fa5-9cc6-ff0dfebfab84';

const upsert = {
  kind: 'upsert',
  sampleId,
  sourceBundleId: 'com.apple.Health',
  sourceVersion: null,
  activityType: 37,
  observedFrom: '2026-09-28T09:00:00+09:00',
  observedTo: '2026-09-28T09:30:00+09:00',
  durationSeconds: 1800,
  distanceMeters: null,
  energyKilocalories: 0,
} as const;

const batch = { schemaVersion: 1, installationId, batchId, events: [upsert] } as const;

describe('HealthKit raw workout ingestion boundary', () => {
  it('preserves null versus zero and normalizes UUID casing', () => {
    const parsed = healthKitIngestionBatchSchema.parse({
      ...batch,
      installationId: installationId.toUpperCase(),
      events: [{ ...upsert, sampleId: sampleId.toUpperCase() }],
    });
    expect(parsed.installationId).toBe(installationId);
    expect(parsed.events[0]).toMatchObject({
      sampleId,
      distanceMeters: null,
      energyKilocalories: 0,
    });
  });

  it('accepts a bounded delete without invented observation fields', () => {
    expect(
      healthKitIngestionBatchSchema.parse({
        ...batch,
        events: [{ kind: 'delete', sampleId }],
      }).events,
    ).toEqual([{ kind: 'delete', sampleId }]);
  });

  it('rejects duplicate sample IDs even when casing or event kind differs', () => {
    expect(
      healthKitIngestionBatchSchema.safeParse({
        ...batch,
        events: [upsert, { kind: 'delete', sampleId: sampleId.toUpperCase() }],
      }).success,
    ).toBe(false);
  });

  it('rejects unbounded batches and unexpected raw payloads', () => {
    expect(healthKitIngestionBatchSchema.safeParse({ ...batch, events: [] }).success).toBe(false);
    const distinctEvents = Array.from({ length: 101 }, (_, index) => ({
      kind: 'delete',
      sampleId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    }));
    expect(
      healthKitIngestionBatchSchema.safeParse({ ...batch, events: distinctEvents.slice(0, 100) })
        .success,
    ).toBe(true);
    expect(
      healthKitIngestionBatchSchema.safeParse({
        ...batch,
        events: distinctEvents,
      }).success,
    ).toBe(false);
    expect(
      healthKitIngestionBatchSchema.safeParse({
        ...batch,
        events: [{ ...upsert, heartRateSamples: [120], token: 'secret' }],
      }).success,
    ).toBe(false);
    expect(
      healthKitIngestionBatchSchema.safeParse({
        ...batch,
        events: [{ kind: 'delete', sampleId, deletedAt: '2026-09-28T00:00:00Z' }],
      }).success,
    ).toBe(false);
  });

  it('rejects reversed time, negative or nonfinite metrics, and unsupported versions', () => {
    const invalidUpserts = [
      { ...upsert, observedTo: '2026-09-28T08:00:00+09:00' },
      { ...upsert, distanceMeters: -1 },
      { ...upsert, energyKilocalories: Number.POSITIVE_INFINITY },
      { ...upsert, durationSeconds: -1 },
      { ...upsert, sourceBundleId: '' },
      { ...upsert, sourceBundleId: '   ' },
      { ...upsert, sourceVersion: '   ' },
      { ...upsert, activityType: 1_000_001 },
      { ...upsert, durationSeconds: 2_678_401 },
    ];
    for (const event of invalidUpserts) {
      expect(healthKitIngestionBatchSchema.safeParse({ ...batch, events: [event] }).success).toBe(
        false,
      );
    }
    expect(healthKitIngestionBatchSchema.safeParse({ ...batch, schemaVersion: 2 }).success).toBe(
      false,
    );
    expect(healthKitIngestionBatchSchema.safeParse({ ...batch, installationId: 'x' }).success).toBe(
      false,
    );
  });

  it('validates a bounded acknowledgement', () => {
    const ack = {
      schemaVersion: 1,
      installationId,
      batchId,
      acceptedCount: 1,
    };
    expect(healthKitIngestionAckSchema.safeParse(ack).success).toBe(true);
    expect(healthKitIngestionAckSchema.safeParse({ ...ack, acceptedCount: 101 }).success).toBe(
      false,
    );
    expect(healthKitIngestionAckSchema.safeParse({ ...ack, athleteId: sampleId }).success).toBe(
      false,
    );
  });
});
