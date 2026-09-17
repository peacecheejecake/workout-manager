import { describe, expect, it } from 'vitest';
import { activitySchema } from '../src/activity.js';
import { selectedActivityExportSchema } from '../src/activity-export.js';

const activity = activitySchema.parse({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 2,
  source: { kind: 'manual', sourceId: 'local-record', revision: 1, contentHash: 'a'.repeat(64) },
  original: {
    title: '원본',
    kind: 'walking',
    startedAt: '2026-01-01T10:00:00+09:00',
    timezone: 'Asia/Seoul',
    durationSeconds: null,
    durationKind: 'timer',
    distanceMeters: 0,
  },
  effective: {
    title: '정정',
    kind: 'walking',
    startedAt: '2026-01-01T10:00:00+09:00',
    timezone: 'Asia/Seoul',
    durationSeconds: 0,
    durationKind: 'elapsed',
    distanceMeters: 0,
  },
  overlay: { title: '정정', durationSeconds: 0, durationKind: 'elapsed', reason: '정정 사유' },
  userReport: {
    definitionVersion: 'activity-report-v1',
    source: 'user',
    method: 'self_report',
    sessionRpe: 0,
    rpeReportedAt: '2026-01-02T00:00:00Z',
    note: '보고 메모',
    planLink: null,
  },
});
const artifact = {
  schemaVersion: 1,
  format: 'workout-manager-activity-summary',
  generatedAt: '2026-09-17T00:00:00Z',
  consistency: 'per-activity-revision',
  activities: [activity],
};

describe('selected activity summary export boundary', () => {
  it('round trips source, corrections, report, timezone and unknown/zero measurement definitions', () => {
    const exported = selectedActivityExportSchema.parse(JSON.parse(JSON.stringify(artifact)));
    expect(exported.activities).toEqual([activity]);
    expect(exported.activities[0]?.original.durationSeconds).toBeNull();
    expect(exported.activities[0]?.effective.durationSeconds).toBe(0);
    expect(exported.activities[0]?.userReport?.sessionRpe).toBe(0);
    expect(exported.activities[0]?.userReport?.rpeReportedAt).toBe('2026-01-02T00:00:00Z');
  });
  it('preserves absent legacy reports without fabricating self reports', () => {
    const { userReport: _report, ...legacy } = activity;
    const exported = selectedActivityExportSchema.parse({ ...artifact, activities: [legacy] });
    expect(exported.activities[0]).not.toHaveProperty('userReport');
  });
  it('requires a nonempty bounded unique selection including normalized UUID identity', () => {
    for (const activities of [
      [],
      [activity, activity],
      [activity, { ...activity, id: activity.id.toUpperCase() }],
      Array.from({ length: 101 }, () => activity),
    ]) {
      expect(selectedActivityExportSchema.safeParse({ ...artifact, activities }).success).toBe(
        false,
      );
    }
  });
  it('rejects unsupported versions and false atomic snapshot claims', () => {
    expect(selectedActivityExportSchema.safeParse({ ...artifact, schemaVersion: 3 }).success).toBe(
      false,
    );
    expect(
      selectedActivityExportSchema.safeParse({
        ...artifact,
        consistency: 'atomic-database-snapshot',
      }).success,
    ).toBe(false);
    expect(
      selectedActivityExportSchema.safeParse({ ...artifact, generatedAt: 'yesterday' }).success,
    ).toBe(false);
  });
  it('rejects import commands, credentials and unbounded detail fields', () => {
    expect(selectedActivityExportSchema.safeParse({ schemaVersion: 1, imports: [] }).success).toBe(
      false,
    );
    expect(
      selectedActivityExportSchema.safeParse({ ...artifact, sessionId: 'private-session' }).success,
    ).toBe(false);
    expect(
      selectedActivityExportSchema.safeParse({
        ...artifact,
        activities: [{ ...activity, details: { records: [] } }],
      }).success,
    ).toBe(false);
  });
});
