import { describe, expect, it } from 'vitest';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import type { ActivityLap, ActivityRecord } from '@workout/contracts/activity-details';
import {
  chartSegments,
  detailsMatchActivity,
  lapOverlapsRange,
  lapTimeRange,
  recordInRange,
  recordTime,
} from '../src/detail-projection';
const lap: ActivityLap = {
  index: 0,
  startedAt: '2026-01-01T00:00:00Z',
  recordedAt: '2026-01-02T00:00:00Z',
  elapsedSeconds: 10,
  timerSeconds: 5,
  distanceMeters: 0,
  averageHeartRateBpm: null,
  maximumHeartRateBpm: null,
};
const time = Date.parse('2026-01-01T00:00:00Z');
function record(index: number, second: number | null, value: number | null = 0): ActivityRecord {
  return {
    index,
    timestamp: second === null ? null : new Date(time + second * 1000).toISOString(),
    distanceMeters: value,
    heartRateBpm: value,
  };
}
describe('activity observation projection', () => {
  it('uses start plus elapsed, never written time or timer duration', () => {
    expect(lapTimeRange(lap)).toEqual({ start: time, end: time + 10000 });
    expect(lapTimeRange({ ...lap, elapsedSeconds: 0 })).toEqual({ start: time, end: time });
    expect(lapTimeRange({ ...lap, elapsedSeconds: null })).toBeNull();
    expect(lapTimeRange({ ...lap, startedAt: null })).toBeNull();
    expect(lapTimeRange({ ...lap, elapsedSeconds: Number.MAX_VALUE })).toBeNull();
    expect(lapTimeRange({ ...lap, startedAt: 'invalid' })).toBeNull();
  });
  it('retains offset/year-zero instants and rejects unparseable times', () => {
    expect(recordTime({ ...record(0, 0), timestamp: '0000-12-31T23:30:00-01:00' })).toBe(
      Date.parse('0001-01-01T00:30:00Z'),
    );
    expect(recordTime({ ...record(0, 0), timestamp: 'invalid' })).toBeNull();
    expect(recordTime(record(0, null))).toBeNull();
  });
  it('breaks on missing metrics/times, duplicate and reversed time without dropping zero or points', () => {
    const records = [
      record(0, 0),
      record(1, 1),
      record(2, 2, null),
      record(3, 3),
      record(4, 3),
      record(5, 2),
      record(6, null),
      record(7, 5),
    ];
    const original = structuredClone(records);
    const segments = chartSegments(records, 'heartRateBpm');
    expect(segments.map((segment) => segment.map((point) => point.index))).toEqual([
      [0, 1],
      [3],
      [4],
      [5],
      [7],
    ]);
    expect(segments[0]?.[0]?.value).toBe(0);
    expect(records).toEqual(original);
    expect(chartSegments([], 'distanceMeters')).toEqual([]);
  });
  it('uses the requested metric independently and processes the full bounded record count', () => {
    const records = Array.from({ length: 20000 }, (_, index) => ({
      ...record(index, index),
      heartRateBpm: null,
    }));
    expect(chartSegments(records, 'distanceMeters')[0]).toHaveLength(20000);
    expect(chartSegments(records, 'heartRateBpm')).toEqual([]);
  });
  it('uses inclusive selection endpoints including zero duration and rejects unavailable ranges', () => {
    expect(recordInRange(record(0, 10), { start: time, end: time + 10000 })).toBe(true);
    expect(recordInRange(record(0, null), { start: time, end: time })).toBe(false);
    expect(recordInRange(record(0, 0), { start: time + 1, end: time })).toBe(false);
    expect(lapOverlapsRange(lap, { start: time + 10000, end: time + 11000 })).toBe(true);
    expect(lapOverlapsRange({ ...lap, elapsedSeconds: 0 }, { start: time, end: time })).toBe(true);
    expect(lapOverlapsRange({ ...lap, elapsedSeconds: null }, { start: time, end: time })).toBe(
      false,
    );
    expect(lapOverlapsRange(lap, { start: Number.NaN, end: time })).toBe(false);
  });
  it('requires canonical revision and every source lineage field to match', () => {
    const values = {
      title: null,
      kind: 'unknown' as const,
      startedAt: null,
      durationSeconds: null,
      durationKind: 'unknown' as const,
      timezone: null,
      distanceMeters: 0,
    };
    const activity: Activity = {
      id: 'activity',
      revision: 2,
      source: { kind: 'fit', sourceId: 'source', revision: 1, contentHash: 'a'.repeat(64) },
      original: values,
      effective: values,
      overlay: {},
    };
    const read: ActivityDetailsRead = {
      activityId: activity.id,
      activityRevision: 2,
      source: { ...activity.source },
      details: null,
    };
    expect(detailsMatchActivity(activity, read)).toBe(true);
    expect(detailsMatchActivity(activity, { ...read, activityId: 'other' })).toBe(false);
    expect(detailsMatchActivity(activity, { ...read, activityRevision: 3 })).toBe(false);
    for (const source of [
      { ...read.source, kind: 'fixture' as const },
      { ...read.source, sourceId: 'other' },
      { ...read.source, revision: 2 },
      { ...read.source, contentHash: 'b'.repeat(64) },
    ])
      expect(detailsMatchActivity(activity, { ...read, source })).toBe(false);
  });
});
