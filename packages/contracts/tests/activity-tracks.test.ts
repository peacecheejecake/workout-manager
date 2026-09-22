import { describe, expect, it } from 'vitest';

import {
  activityTrackReadResultSchema,
  activityTrackReserveMetadataSchema,
  activityTrackRevisionSchema,
  activityTrackUploadReservationSchema,
} from '../src/activity-tracks.js';

const revision = {
  trackId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  activityId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sourceKind: 'fit',
  sourceId: 'source-1',
  sourceRevision: 2,
  trackRevision: 3,
  recordedSourceKind: 'fit-session',
  correspondence: {
    algorithm: 'track-correspondence-v1',
    parserId: 'fit-track-v1',
    parserVersion: 1,
    digest: 'a'.repeat(64),
  },
  file: {
    originalFileName: 'run.fit',
    format: 'fit',
    byteSize: 2048,
    sha256: 'b'.repeat(64),
  },
  derivatives: [
    { kind: 'normalized', byteSize: 4096, sha256: 'c'.repeat(64) },
    { kind: 'map_path', byteSize: 1024, sha256: 'd'.repeat(64) },
  ],
  sampleCount: 10,
  positionedSampleCount: 9,
  segmentCount: 2,
  segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
  distances: { deviceReportedMeters: 1000, recomputedFromPositionsMeters: 998 },
  createdAt: '2026-09-19T01:00:00.000Z',
};

describe('stored track contract', () => {
  it('accepts a stored revision and rejects an unknown field', () => {
    expect(activityTrackRevisionSchema.parse(revision).trackRevision).toBe(3);
    expect(
      activityTrackRevisionSchema.safeParse({ ...revision, storageRef: 'private/v1/tenants/x' })
        .success,
    ).toBe(false);
    expect(activityTrackRevisionSchema.safeParse({ ...revision, samples: [] }).success).toBe(false);
  });

  it('requires exactly the two server-built derivatives', () => {
    for (const derivatives of [
      [],
      [revision.derivatives[0]],
      [...revision.derivatives, { kind: 'normalized', byteSize: 1, sha256: 'e'.repeat(64) }],
    ])
      expect(activityTrackRevisionSchema.safeParse({ ...revision, derivatives }).success).toBe(
        false,
      );
  });

  it('leaves no place for a client parse result, a storage key or an athlete id', () => {
    expect(
      activityTrackReserveMetadataSchema.parse({
        expectedActivityRevision: 4,
        recordedTrackIndex: 0,
      }),
    ).toEqual({ expectedActivityRevision: 4, recordedTrackIndex: 0 });
    for (const extra of [
      { athleteId: 'someone-else' },
      { storageRef: 'private/v1/tenants/x' },
      { samples: [] },
      { sampleCount: 5 },
      { correspondenceDigest: 'a'.repeat(64) },
      { trackRevision: 9 },
    ])
      expect(
        activityTrackReserveMetadataSchema.safeParse({
          expectedActivityRevision: 4,
          recordedTrackIndex: 0,
          ...extra,
        }).success,
      ).toBe(false);
  });

  it('keeps an unavailable track distinguishable from an available one', () => {
    const unavailable = activityTrackReadResultSchema.parse({
      status: 'unavailable',
      activityId: revision.activityId,
    });
    expect(unavailable.status).toBe('unavailable');
    expect(
      activityTrackReadResultSchema.safeParse({ status: 'available', track: revision }).success,
    ).toBe(true);
    // A reservation carries ids and state only, never the source or the revision it holds.
    expect(
      activityTrackUploadReservationSchema.safeParse({
        uploadId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        activityId: revision.activityId,
        trackId: revision.trackId,
        state: 'reserved',
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt,
        trackRevision: 1,
      }).success,
    ).toBe(false);
  });

  it('refuses a positioned sample count above the sample count only where the server checks it', () => {
    // The contract bounds both counts; the ordering between them is enforced by the
    // database CHECK and the repository, which this test documents rather than duplicates.
    expect(activityTrackRevisionSchema.safeParse({ ...revision, sampleCount: -1 }).success).toBe(
      false,
    );
    expect(
      activityTrackRevisionSchema.safeParse({ ...revision, segmentPolicy: { version: 2 } }).success,
    ).toBe(false);
  });
});
