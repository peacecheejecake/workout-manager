import { describe, expect, it } from 'vitest';
import { mapPathSchema, recordedTrackSchema } from '@workout/contracts/tracks';
import {
  buildHighlightPath,
  buildRecordInstantIndex,
  buildStoredTrackGeometry,
  definiteRecordForSample,
  definiteSampleForRecord,
  indexStoredTrack,
  lapCorrespondence,
  sampleForInstant,
  samplesInRange,
} from '../src/stored-track-geometry';
import { summarizeTrack } from '../src/track-preview-geometry';
import {
  activityId,
  instant,
  at,
  sourceId,
  storedDetails,
  storedMapPath,
  storedTrack,
} from './stored-track-fixtures';

describe('stored track display geometry', () => {
  it('flattens the stored lines into one path, breaks the gap and keeps every vertex keyed by its sample id', () => {
    const geometry = buildStoredTrackGeometry(storedMapPath(), 'stored-track');
    expect(geometry.path.positions).toHaveLength(4);
    // The missing-fix sample sits between the two lines, so the drawn line stops and
    // restarts instead of being joined across it.
    expect(geometry.path.breaks).toEqual([2]);
    expect(geometry.vertexSampleIds).toEqual(['0:0', '0:1', '0:3', '0:4']);
    expect(geometry.path.vertexKeys).toEqual(geometry.vertexSampleIds);
    expect(geometry.path.revision).toBe(`${activityId}:1`);
    // The reverse map is the only thing that turns a sample id back into a vertex, so it
    // must agree with the forward order at every index.
    for (const [index, sampleId] of geometry.vertexSampleIds.entries())
      expect(geometry.vertexIndexBySampleId.get(sampleId)).toBe(index);
    expect(geometry.vertexIndexBySampleId.get('0:2')).toBeUndefined();
    expect(geometry.insufficient).toEqual([
      { segmentIndex: 1, reason: 'no-position', sampleIds: ['0:2'] },
    ]);
  });

  it('changes revision with the track revision so a new revision is different geometry', () => {
    expect(buildStoredTrackGeometry(storedMapPath({ trackRevision: 2 }), 'p').path.revision).toBe(
      `${activityId}:2`,
    );
  });

  it('merges a single-sample segment back into recording order and draws it as its own piece', () => {
    const path = mapPathSchema.parse({
      ...storedMapPath(),
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [127.02, 37.5],
            [127.021, 37.501],
          ],
        ],
      },
      vertexSampleIds: [['0:0', '0:1']],
      lineSegmentIndices: [2],
      points: [{ segmentIndex: 0, sampleId: '0:9', position: [127.0, 37.4] }],
      insufficient: [{ segmentIndex: 0, reason: 'single-point', sampleIds: ['0:9'] }],
    });
    const geometry = buildStoredTrackGeometry(path, 'p');
    // Segment 0 is the lone point and must come first, before the line of segment 2.
    expect(geometry.vertexSampleIds).toEqual(['0:9', '0:0', '0:1']);
    expect(geometry.path.breaks).toEqual([1]);
  });

  it('drops a line whose stored sample mapping does not cover every vertex instead of inventing keys', () => {
    // `mapPathSchema` refuses this, so it is built without the schema on purpose: the
    // guard must hold for a document that reached the builder some other way.
    const broken = {
      ...storedMapPath(),
      vertexSampleIds: [['0:0'], ['0:3', '0:4']],
    } as unknown as Parameters<typeof buildStoredTrackGeometry>[0];
    const geometry = buildStoredTrackGeometry(broken, 'p');
    expect(geometry.vertexSampleIds).toEqual(['0:3', '0:4']);
  });
});

describe('stored track selection correspondence', () => {
  const track = storedTrack();
  const index = indexStoredTrack(track);

  it('resolves a detail observation to the sample recorded at the same instant', () => {
    expect(sampleForInstant(index, instant(0))).toEqual({ kind: 'unique', sampleId: '0:0' });
    expect(sampleForInstant(index, instant(30))).toEqual({ kind: 'unique', sampleId: '0:3' });
    // An observation with no matching sample instant has no correspondence at all; a
    // nearby sample is never substituted.
    expect(sampleForInstant(index, instant(35))).toEqual({ kind: 'none' });
    expect(sampleForInstant(index, null)).toEqual({ kind: 'none' });
  });

  it('reports an instant shared by several samples as ambiguous rather than picking one', () => {
    const duplicated = recordedTrackSchema.parse({
      ...track,
      samples: track.samples.map((sample) => ({ ...sample, recordedAt: at(0) })),
    });
    // Two samples at one instant are two different places. Taking the first would move a
    // selection to a point nobody chose, so there is no answer here at all.
    expect(sampleForInstant(indexStoredTrack(duplicated), instant(0))).toEqual({
      kind: 'ambiguous',
      reason: 'samples',
      count: 5,
    });
  });

  it('applies the same both-sides rule in the observation → sample direction', () => {
    const records = buildRecordInstantIndex(storedDetails().records);
    expect(definiteSampleForRecord(index, records, instant(30))).toEqual({
      kind: 'unique',
      sampleId: '0:3',
    });
    // One sample, two observations at that instant. The chart must not commit a marker
    // here: the reverse click would refuse to link back and the observation selection
    // would vanish, so the two directions have to agree.
    const duplicatedRecords = buildRecordInstantIndex([
      ...storedDetails().records,
      { index: 9, timestamp: at(30), distanceMeters: null, heartRateBpm: null },
    ]);
    expect(definiteSampleForRecord(index, duplicatedRecords, instant(30))).toEqual({
      kind: 'ambiguous',
      reason: 'observations',
      count: 2,
    });
    // Both directions now answer the same way for the same instant.
    expect(definiteRecordForSample(index, duplicatedRecords, '0:3')).toBeNull();
    // Two samples and one observation stays reported against the sample side.
    const duplicatedSamples = indexStoredTrack(
      recordedTrackSchema.parse({
        ...track,
        samples: track.samples.map((sample) =>
          sample.sampleId === '0:1' ? { ...sample, recordedAt: at(0) } : sample,
        ),
      }),
    );
    expect(definiteSampleForRecord(duplicatedSamples, records, instant(0))).toEqual({
      kind: 'ambiguous',
      reason: 'samples',
      count: 2,
    });
    expect(definiteSampleForRecord(index, records, null)).toEqual({ kind: 'none' });
    expect(definiteSampleForRecord(index, records, instant(35))).toEqual({ kind: 'none' });
  });

  it('links a sample to an observation only when both sides are unique at that instant', () => {
    const records = buildRecordInstantIndex(storedDetails().records);
    expect(definiteRecordForSample(index, records, '0:3')).toEqual({
      recordIndex: 3,
      instant: instant(30),
    });
    // Two samples at one instant: the observation cannot be said to belong to this sample
    // rather than to its twin, so there is no definite link in this direction either.
    const duplicated = indexStoredTrack(
      recordedTrackSchema.parse({
        ...track,
        samples: track.samples.map((sample) =>
          sample.sampleId === '0:1' ? { ...sample, recordedAt: at(0) } : sample,
        ),
      }),
    );
    expect(definiteRecordForSample(duplicated, records, '0:1')).toBeNull();
    expect(definiteRecordForSample(duplicated, records, '0:0')).toBeNull();
    // Two observations at one instant: likewise no definite link.
    const duplicatedRecords = buildRecordInstantIndex([
      ...storedDetails().records,
      { index: 9, timestamp: at(30), distanceMeters: null, heartRateBpm: null },
    ]);
    expect(definiteRecordForSample(index, duplicatedRecords, '0:3')).toBeNull();
    // A sample with no instant has nothing to link through.
    expect(definiteRecordForSample(index, records, '0:404')).toBeNull();
  });

  it('prefers the stored lap ordinal and falls back to the lap range only when there is none', () => {
    const laps = storedDetails().laps;
    const first = laps[0];
    const second = laps[1];
    expect(first && second).toBeTruthy();
    expect(lapCorrespondence(index, 0, { start: instant(0), end: instant(20) })).toEqual({
      sampleIds: ['0:0', '0:1', '0:2'],
      basis: 'lap-index',
    });

    const withoutLaps = recordedTrackSchema.parse({
      ...track,
      samples: track.samples.map((sample) => ({ ...sample, lapIndex: null })),
    });
    expect(
      lapCorrespondence(indexStoredTrack(withoutLaps), 0, { start: instant(0), end: instant(20) }),
    ).toEqual({ sampleIds: ['0:0', '0:1', '0:2'], basis: 'time-range' });
    // No lap ordinal and no usable range is reported as no correspondence, not as the
    // whole recording.
    expect(lapCorrespondence(indexStoredTrack(withoutLaps), 0, null)).toEqual({
      sampleIds: [],
      basis: 'none',
    });
    expect(
      lapCorrespondence(indexStoredTrack(withoutLaps), 7, { start: instant(90), end: instant(99) }),
    ).toEqual({ sampleIds: [], basis: 'none' });
  });

  it('includes both range endpoints and refuses a reversed range', () => {
    expect(samplesInRange(index, { start: instant(10), end: instant(30) })).toEqual([
      '0:1',
      '0:2',
      '0:3',
    ]);
    expect(samplesInRange(index, { start: instant(10), end: instant(10) })).toEqual(['0:1']);
    expect(samplesInRange(index, { start: instant(30), end: instant(10) })).toEqual([]);
  });

  it('keeps every observation that shares an instant instead of reducing them to one', () => {
    const records = storedDetails().records;
    const byInstant = buildRecordInstantIndex([
      ...records,
      { index: 9, timestamp: at(0), distanceMeters: null, heartRateBpm: null },
      { index: 10, timestamp: null, distanceMeters: null, heartRateBpm: null },
    ]);
    expect(byInstant.get(instant(0))).toEqual([0, 9]);
    expect(byInstant.get(instant(40))).toEqual([4]);
    expect(byInstant.size).toBe(5);
  });

  it('highlights only the drawn runs a range covers and never joins them across a gap', () => {
    const geometry = buildStoredTrackGeometry(storedMapPath(), 'stored-track');
    // `0:2` has no fix and is not drawn; `0:1` and `0:3` sit on either side of the gap.
    const path = buildHighlightPath(geometry, ['0:1', '0:2', '0:3'], 'range');
    expect(path?.vertexKeys).toEqual(['0:1', '0:3']);
    expect(path?.breaks).toEqual([1]);
    expect(path?.role).toBe('candidate');
    const contiguous = buildHighlightPath(geometry, ['0:3', '0:4'], 'range');
    expect(contiguous?.breaks).toEqual([]);
    expect(buildHighlightPath(geometry, ['0:2'], 'range')).toBeNull();
    expect(buildHighlightPath(geometry, [], 'range')).toBeNull();
  });

  it('round-trips every drawn vertex through its sample id and back to an observation', () => {
    const geometry = buildStoredTrackGeometry(storedMapPath(), 'stored-track');
    const byInstant = buildRecordInstantIndex(storedDetails().records);
    const seen: number[] = [];
    for (const [vertex, sampleId] of geometry.vertexSampleIds.entries()) {
      const sample = index.bySampleId.get(sampleId);
      expect(sample).toBeDefined();
      const recordIndex = byInstant.get(Date.parse(sample?.recordedAt ?? ''));
      expect(recordIndex).toBeDefined();
      // …and the observation resolves back to the same vertex it came from.
      const back = definiteSampleForRecord(index, byInstant, Date.parse(sample?.recordedAt ?? ''));
      expect(back).toEqual({ kind: 'unique', sampleId });
      expect(geometry.vertexIndexBySampleId.get(sampleId)).toBe(vertex);
      if (recordIndex !== undefined) seen.push(...recordIndex);
    }
    expect(seen).toEqual([0, 1, 3, 4]);
  });

  it('keeps the summary identical whatever the display geometry drops', () => {
    const full = summarizeTrack(track);
    // The stored geometry draws 4 of 5 samples; none of the aggregate values may move.
    expect(full.sampleCount).toBe(5);
    expect(full.positionedSampleCount).toBe(4);
    expect(full.elapsedSeconds).toBe(40);
    expect(full.deviceDistanceMeters).toBe(250);
    expect(full.recomputedDistanceMeters).toBe(248);
    const simplified = buildStoredTrackGeometry(
      mapPathSchema.parse({
        ...storedMapPath(),
        toleranceMeters: 50,
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [127.02, 37.5],
              [127.024, 37.504],
            ],
          ],
        },
        vertexSampleIds: [['0:0', '0:4']],
        lineSegmentIndices: [0],
        insufficient: [],
      }),
      'p',
    );
    expect(simplified.path.positions).toHaveLength(2);
    expect(summarizeTrack(track)).toEqual(full);
  });

  it('keeps the provenance the track was stored under', () => {
    expect(track.provenance).toEqual({
      kind: 'activity-source',
      activityId,
      sourceId,
      sourceRevision: 1,
      trackRevision: 1,
    });
  });
});
