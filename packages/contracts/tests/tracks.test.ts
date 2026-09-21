import { describe, expect, it } from 'vitest';
import boutFixture from '../../../tests/fixtures/fit-activity-bout-export.json';
import detailFixture from '../../../tests/fixtures/fit-activity-details-export.json';
import summaryFixture from '../../../tests/fixtures/fit-activity-summary-export.json';
import trackFixture from '../../../tests/fixtures/fit-track-export.json';
import { activityDetailsSchema } from '../src/activity-details.js';
import {
  localFileProvenanceSchema,
  makeTrackSampleId,
  mapPathSchema,
  parsedTrackFileSchema,
  rawTrackFileSchema,
  recordedTrackSchema,
  trackDetailLinkSchema,
  trackLimits,
  trackPositionSchema,
  trackProvenanceSchema,
  trackTextSchema,
  type RecordedTrack,
} from '../src/tracks.js';

const sample = (index: number, position: [number, number] | null) => ({
  sampleId: makeTrackSampleId(0, index),
  sourceIndex: index,
  recordedAt: new Date(Date.parse('2026-03-01T00:00:00Z') + index * 1000).toISOString(),
  position,
  elevationMeters: null,
  distanceMeters: null,
  speedMetersPerSecond: null,
  heartRateBpm: null,
  lapIndex: null,
  detailLink: null,
});

const track: RecordedTrack = recordedTrackSchema.parse({
  schemaVersion: 1,
  provenance: {
    kind: 'local-file',
    format: 'gpx',
    fileSha256: 'a'.repeat(64),
    fileByteLength: 1024,
    parserId: 'gpx-track-v1',
    parserVersion: 1,
    streamIndex: 0,
    sourceItemIndex: 0,
    streamLabel: null,
  },
  sourceKind: 'gpx-trk',
  name: null,
  samples: [sample(0, [127, 37.5]), sample(1, [127.0001, 37.5])],
  segments: [{ index: 0, startReason: 'stream-start', sampleIds: ['0:0', '0:1'] }],
  segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
  distances: { deviceReportedMeters: null, recomputedFromPositionsMeters: 8.8 },
});

describe('track coordinate contract', () => {
  it('accepts WGS84 [longitude, latitude] and rejects reversed or out-of-range values', () => {
    expect(trackPositionSchema.parse([127.05, 37.5])).toEqual([127.05, 37.5]);
    expect(trackPositionSchema.safeParse([37.5, 127.05]).success).toBe(false); // latitude > 90
    expect(trackPositionSchema.safeParse([-180.1, 0]).success).toBe(false);
    expect(trackPositionSchema.safeParse([0, 90.1]).success).toBe(false);
  });

  it('rejects non-finite coordinates', () => {
    expect(trackPositionSchema.safeParse([Number.NaN, 37]).success).toBe(false);
    expect(trackPositionSchema.safeParse([Number.POSITIVE_INFINITY, 37]).success).toBe(false);
  });

  it('refuses extra coordinate dimensions so time and heart rate cannot hide in geometry', () => {
    expect(trackPositionSchema.safeParse([127, 37, 12.5]).success).toBe(false);
    expect(trackPositionSchema.safeParse([127, 37, 1_700_000_000]).success).toBe(false);
  });
});

describe('track provenance', () => {
  it('keeps a local preview free of any Activity identity', () => {
    const preview = {
      kind: 'local-file',
      format: 'fit',
      fileSha256: 'b'.repeat(64),
      fileByteLength: 10,
      parserId: 'fit-track-v1',
      parserVersion: 1,
      streamIndex: 0,
      sourceItemIndex: 0,
      streamLabel: null,
    };
    expect(localFileProvenanceSchema.safeParse(preview).success).toBe(true);
    expect(
      localFileProvenanceSchema.safeParse({ ...preview, activityId: 'activity-1' }).success,
    ).toBe(false);
  });

  it('requires activity, source and track revisions for a stored track', () => {
    const stored = {
      kind: 'activity-source',
      activityId: 'activity-1',
      sourceId: 'source-1',
      sourceRevision: 3,
      trackRevision: 1,
    };
    expect(trackProvenanceSchema.safeParse(stored).success).toBe(true);
    expect(trackProvenanceSchema.safeParse({ ...stored, trackRevision: 0 }).success).toBe(false);
    const { activityId, ...missing } = stored;
    expect(activityId).toBe('activity-1');
    expect(trackProvenanceSchema.safeParse(missing).success).toBe(false);
  });
});

describe('sample identity and segments', () => {
  it('requires the sample id to encode its own stream and source index', () => {
    const broken = recordedTrackSchema.safeParse({
      ...track,
      samples: [{ ...track.samples[0], sampleId: '0:7' }, track.samples[1]],
    });
    expect(broken.success).toBe(false);
  });

  it('rejects duplicate ids and non-increasing source order', () => {
    expect(
      recordedTrackSchema.safeParse({ ...track, samples: [track.samples[0], track.samples[0]] })
        .success,
    ).toBe(false);
  });

  it('requires every sample to belong to exactly one segment', () => {
    expect(
      recordedTrackSchema.safeParse({
        ...track,
        segments: [{ index: 0, startReason: 'stream-start', sampleIds: ['0:0'] }],
      }).success,
    ).toBe(false);
    expect(
      recordedTrackSchema.safeParse({
        ...track,
        segments: [
          { index: 0, startReason: 'stream-start', sampleIds: ['0:0', '0:1'] },
          { index: 1, startReason: 'time-gap', sampleIds: ['0:1'] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('map path contract', () => {
  const path = {
    schemaVersion: 1,
    role: 'recorded',
    sourceRevision: track.provenance,
    simplificationVersion: 1,
    toleranceMeters: 0,
    geometry: {
      type: 'MultiLineString',
      coordinates: [
        [
          [127, 37.5],
          [127.0001, 37.5],
        ],
      ],
    },
    vertexSampleIds: [['0:0', '0:1']],
    lineSegmentIndices: [0],
    points: [],
    insufficient: [],
    displayedPolylineLengthMeters: 8.8,
    crossesAntimeridian: false,
    outsideDisplayLatitude: false,
  };

  it('accepts a mapped line and rejects a mapping that misses a vertex', () => {
    expect(mapPathSchema.safeParse(path).success).toBe(true);
    expect(mapPathSchema.safeParse({ ...path, vertexSampleIds: [['0:0']] }).success).toBe(false);
    expect(mapPathSchema.safeParse({ ...path, lineSegmentIndices: [] }).success).toBe(false);
  });

  it('refuses a one-vertex line: a single point is a point, never a drawn line', () => {
    expect(
      mapPathSchema.safeParse({
        ...path,
        geometry: { type: 'MultiLineString', coordinates: [[[127, 37.5]]] },
        vertexSampleIds: [['0:0']],
      }).success,
    ).toBe(false);
  });
});

describe('untrusted metadata text', () => {
  it('rejects control, bidi-override and angle-bracket characters', () => {
    expect(trackTextSchema.parse('Morning run')).toBe('Morning run');
    expect(trackTextSchema.safeParse('ride\u0000').success).toBe(false);
    expect(trackTextSchema.safeParse('ride\u202E').success).toBe(false);
    expect(trackTextSchema.safeParse('<script>alert(1)</script>').success).toBe(false);
    expect(trackTextSchema.safeParse('x'.repeat(trackLimits.metadataTextLength + 1)).success).toBe(
      false,
    );
  });
});

describe('link to the GPS-free detail contract', () => {
  it('names the detail version, stream, session and record the sample came from', () => {
    expect(
      trackDetailLinkSchema.parse({
        detailSchemaVersion: 2,
        streamIndex: 0,
        sessionIndex: 0,
        recordIndex: 4,
      }).recordIndex,
    ).toBe(4);
    expect(
      trackDetailLinkSchema.safeParse({
        detailSchemaVersion: 4,
        streamIndex: 0,
        sessionIndex: 0,
        recordIndex: 4,
      }).success,
    ).toBe(false);
  });

  it('leaves detail v1, v2 and v3 unchanged and still GPS-free', () => {
    const details = [detailFixture, summaryFixture, boutFixture].flatMap((fixture) =>
      (fixture as { imports: { details?: unknown }[] }).imports.flatMap((item) =>
        item.details === undefined ? [] : [item.details],
      ),
    );
    const versions = new Set(
      details.map((value) => (value as { schemaVersion: number }).schemaVersion),
    );
    // The evidence is worthless unless all three versions are actually present.
    expect([...versions].sort()).toEqual([1, 2, 3]);
    let inspectedRecords = 0;
    for (const value of details) {
      const parsed = activityDetailsSchema.parse(value);
      // Replay is identical: the payload round-trips through the unchanged schema.
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(value);
      for (const record of (value as { records: Record<string, unknown>[] }).records) {
        inspectedRecords += 1;
        expect(Object.keys(record)).toEqual([
          'index',
          'timestamp',
          'distanceMeters',
          'heartRateBpm',
        ]);
      }
      // A coordinate added to any of the three versions is still rejected.
      expect(
        activityDetailsSchema.safeParse({
          ...(value as object),
          records: [
            {
              index: 0,
              timestamp: null,
              distanceMeters: null,
              heartRateBpm: null,
              position: [127, 37.5],
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(inspectedRecords).toBeGreaterThan(0);
  });
});

describe('the Python FIT producer matches this contract', () => {
  const imports = (trackFixture as { schemaVersion: number; imports: Record<string, unknown>[] })
    .imports;

  it('validates the exported track payload', () => {
    expect((trackFixture as { schemaVersion: number }).schemaVersion).toBe(5);
    for (const command of imports) {
      const parsed = recordedTrackSchema.parse(command.track);
      expect(parsed.provenance.kind).toBe('local-file');
      expect(parsed.samples.some((item) => item.position === null)).toBe(true);
      expect(parsed.samples.every((item) => item.heartRateBpm !== null)).toBe(true);
      expect(parsed.segments.map((item) => item.startReason)).toEqual([
        'stream-start',
        'missing-position',
        'missing-position',
      ]);
      const first = parsed.samples[0];
      expect(first?.detailLink).toEqual({
        detailSchemaVersion: 2,
        streamIndex: 0,
        sessionIndex: 0,
        recordIndex: 0,
      });
      expect(first?.position?.[0]).toBeCloseTo(127.05, 5);
      expect(first?.position?.[1]).toBeCloseTo(37.5, 5);
    }
  });

  it('is also a valid single-track parsed file', () => {
    const track0 = recordedTrackSchema.parse(imports[0]?.track);
    expect(
      parsedTrackFileSchema.safeParse({
        schemaVersion: 1,
        format: 'fit',
        fileSha256: track0.provenance.kind === 'local-file' ? track0.provenance.fileSha256 : '',
        fileByteLength:
          track0.provenance.kind === 'local-file' ? track0.provenance.fileByteLength : 1,
        parserId: 'fit-python-export-v1',
        parserVersion: 1,
        originalFilename: null,
        recorded: [track0],
        routes: [],
        waypoints: [],
        requiresSelection: false,
      }).success,
    ).toBe(true);
  });
});

describe('raw track file record', () => {
  const raw = {
    schemaVersion: 1,
    ownerAthleteId: 'athlete-1',
    importId: 'import-1',
    objectKey: 'tracks/athlete-1/import-1.fit',
    format: 'fit',
    byteLength: 2048,
    sha256: 'c'.repeat(64),
    originalFilename: 'morning.fit',
    sourceOrigin: { kind: 'user-upload' },
    parserId: 'fit-track-v1',
    parserVersion: 1,
    receivedAt: '2026-03-01T00:00:00Z',
  };

  it('accepts an upload and an activity-linked original, and rejects unknown fields', () => {
    expect(rawTrackFileSchema.safeParse(raw).success).toBe(true);
    expect(
      rawTrackFileSchema.safeParse({
        ...raw,
        sourceOrigin: {
          kind: 'activity-source',
          activityId: 'activity-1',
          sourceId: 'source-1',
          sourceRevision: 2,
        },
      }).success,
    ).toBe(true);
    expect(rawTrackFileSchema.safeParse({ ...raw, clientStorageKey: 'local' }).success).toBe(false);
    expect(rawTrackFileSchema.safeParse({ ...raw, originalFilename: 'a<b>.fit' }).success).toBe(
      false,
    );
  });
});
