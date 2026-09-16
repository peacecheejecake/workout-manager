import { describe, expect, it } from 'vitest';
import {
  importActivitySchema,
  activityOverlayWriteSchema,
  activityListQuerySchema,
  activitySchema,
  activityReportSchema,
  manualActivityCreateSchema,
} from '../src/activity.js';
const input = {
  idempotencyKey: 'import-fixture-0001',
  source: { kind: 'fixture', sourceId: 'session-1', revision: 1, contentHash: 'a'.repeat(64) },
  activity: {
    title: null,
    kind: 'running',
    startedAt: null,
    durationSeconds: null,
    durationKind: 'unknown',
    distanceMeters: 0,
    timezone: null,
  },
};
describe('M1-03 source and activity wire contracts', () => {
  it('preserves unknown, zero and source measurement definitions', () => {
    expect(importActivitySchema.parse(input).activity).toEqual(input.activity);
  });
  it.each([-1, Infinity, NaN])('rejects invalid metrics %s', (distanceMeters) => {
    expect(
      importActivitySchema.safeParse({ ...input, activity: { ...input.activity, distanceMeters } })
        .success,
    ).toBe(false);
  });
  it('rejects fabricated ownership, provider types and timezone values', () => {
    expect(importActivitySchema.safeParse({ ...input, athleteId: 'someone' }).success).toBe(false);
    expect(
      importActivitySchema.safeParse({ ...input, source: { ...input.source, kind: 'garmin' } })
        .success,
    ).toBe(false);
    expect(
      importActivitySchema.safeParse({
        ...input,
        activity: { ...input.activity, timezone: 'Mars/Olympus' },
      }).success,
    ).toBe(false);
  });
  it('requires revision, reason and idempotency for explicit corrections, preserving null', () => {
    const correction = {
      expectedRevision: 1,
      idempotencyKey: 'overlay-command-1',
      reason: 'GPS correction',
      distanceMeters: null,
    };
    expect(activityOverlayWriteSchema.parse(correction).distanceMeters).toBeNull();
    expect(activityOverlayWriteSchema.safeParse({ ...correction, reason: '' }).success).toBe(false);
    expect(
      activityOverlayWriteSchema.safeParse({
        expectedRevision: 1,
        idempotencyKey: 'overlay-command-1',
        reason: 'nothing',
      }).success,
    ).toBe(false);
  });
  it('bounds pagination and forbids supplied athlete scopes', () => {
    expect(activityListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(activityListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(activityListQuerySchema.safeParse({ athleteId: 'other' }).success).toBe(false);
  });
});

it('requires a duration correction to specify its pinned measurement definition', () => {
  const base = {
    expectedRevision: 1,
    idempotencyKey: 'duration-correction',
    reason: 'timer correction',
  };
  expect(activityOverlayWriteSchema.safeParse({ ...base, durationSeconds: 60 }).success).toBe(
    false,
  );
  expect(activityOverlayWriteSchema.safeParse({ ...base, durationKind: 'timer' }).success).toBe(
    false,
  );
  expect(
    activityOverlayWriteSchema.parse({ ...base, durationSeconds: null, durationKind: 'timer' }),
  ).toMatchObject({ durationSeconds: null, durationKind: 'timer' });
});

describe('M1-04e bounded activity search', () => {
  const period = { from: '2024-03-10', toExclusive: '2024-03-11', timezone: 'America/New_York' };
  it('keeps literal search text, source/kind and finite sort while coercing paging', () => {
    expect(
      activityListQuerySchema.parse({
        ...period,
        limit: '10',
        offset: '20',
        search: '  run_%  ',
        source: 'fit',
        kind: 'running',
        sort: 'distance_desc',
      }),
    ).toEqual({
      ...period,
      limit: 10,
      offset: 20,
      search: 'run_%',
      source: 'fit',
      kind: 'running',
      sort: 'distance_desc',
    });
  });
  it.each([
    { from: period.from },
    { from: period.from, toExclusive: period.toExclusive },
    { timezone: period.timezone },
    { ...period, toExclusive: period.from },
    { ...period, toExclusive: '2024-03-09' },
    { ...period, from: '2024-02-30' },
    { ...period, from: '0000-12-31' },
    { ...period, from: '2000-01-01' },
    { ...period, timezone: 'Invalid/Timezone' },
    { search: ' ' },
    { search: 'x'.repeat(201) },
    { sort: 'distance; DROP TABLE activity_canonical' },
    { source: 'garmin' },
    { kind: 'flying' },
  ])('rejects incomplete or invalid filters: %j', (query) => {
    expect(activityListQuerySchema.safeParse(query).success).toBe(false);
  });
  it('validates calendar days independently of DST and accepts leap days', () => {
    expect(activityListQuerySchema.parse(period)).toMatchObject(period);
    expect(
      activityListQuerySchema.safeParse({
        ...period,
        from: '2024-02-29',
        toExclusive: '2024-03-01',
      }).success,
    ).toBe(true);
  });
});

describe('M1-04g manual provenance and self reports', () => {
  const manual = {
    confirmed: true,
    idempotencyKey: 'manual-fixture-0001',
    activity: {
      ...input.activity,
      title: '직접 기록',
      startedAt: '2024-03-10T12:00:00Z',
      timezone: 'Asia/Seoul',
    },
    report: { sessionRpe: 0, note: null, planLink: null },
  };
  it('requires explicit confirmation and known manual title/start/timezone while keeping unknown metrics', () => {
    const parsed = manualActivityCreateSchema.parse(manual);
    expect(parsed.report.sessionRpe).toBe(0);
    expect(parsed.activity.durationSeconds).toBeNull();
    for (const replacement of [
      { confirmed: false },
      { source: input.source },
      { athleteId: 'foreign' },
      { activity: { ...manual.activity, title: null } },
      { activity: { ...manual.activity, startedAt: null } },
      { activity: { ...manual.activity, startedAt: '0000-01-01T00:00:00Z' } },
      { activity: { ...manual.activity, timezone: null } },
      { report: { ...manual.report, sessionRpe: -1 } },
      { report: { ...manual.report, sessionRpe: 11 } },
      { report: { ...manual.report, rpeReportedAt: '2024-01-01T00:00:00Z' } },
      { report: { ...manual.report, note: 'x'.repeat(4001) } },
    ])
      expect(manualActivityCreateSchema.safeParse({ ...manual, ...replacement }).success).toBe(
        false,
      );
  });
  it('cannot forge manual provenance through the FIT/fixture import command', () => {
    expect(
      importActivitySchema.safeParse({ ...input, source: { ...input.source, kind: 'manual' } })
        .success,
    ).toBe(false);
  });
  it('reads legacy activities without inventing a self report or RPE zero', () => {
    const legacy = activitySchema.parse({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 1,
      source: input.source,
      original: input.activity,
      effective: input.activity,
      overlay: {},
    });
    expect(legacy.userReport).toBeUndefined();
    expect(legacy.overlay.userReport).toBeUndefined();
  });
  it('requires report timestamp only for known RPE and forbids provenance in correction commands', () => {
    const report = {
      ...manual.report,
      definitionVersion: 'activity-report-v1',
      source: 'user',
      method: 'self_report',
      rpeReportedAt: '2024-03-10T13:00:00Z',
    };
    expect(activityReportSchema.parse(report).sessionRpe).toBe(0);
    expect(activityReportSchema.safeParse({ ...report, rpeReportedAt: null }).success).toBe(false);
    expect(activityReportSchema.safeParse({ ...report, sessionRpe: null }).success).toBe(false);
    expect(
      activityReportSchema.parse({ ...report, sessionRpe: null, rpeReportedAt: null }).sessionRpe,
    ).toBeNull();
    const correction = {
      expectedRevision: 1,
      idempotencyKey: 'report-correction-1',
      reason: '보고 정정',
    };
    expect(
      activityOverlayWriteSchema.parse({ ...correction, report: manual.report }).report?.sessionRpe,
    ).toBe(0);
    expect(
      activityOverlayWriteSchema.safeParse({ ...correction, userReport: report }).success,
    ).toBe(false);
    expect(activityOverlayWriteSchema.safeParse({ ...correction, report }).success).toBe(false);
  });
  it('requires start instant and timezone to be corrected together, preserving explicit null', () => {
    const correction = {
      expectedRevision: 1,
      idempotencyKey: 'time-correction-1',
      reason: '시각 정정',
    };
    expect(activityOverlayWriteSchema.safeParse({ ...correction, startedAt: null }).success).toBe(
      false,
    );
    expect(activityOverlayWriteSchema.safeParse({ ...correction, timezone: null }).success).toBe(
      false,
    );
    expect(
      activityOverlayWriteSchema.parse({
        ...correction,
        startedAt: null,
        timezone: null,
        kind: 'walking',
      }),
    ).toMatchObject({ startedAt: null, timezone: null, kind: 'walking' });
  });
});

describe('explicit linked Block list filters', () => {
  const linked = {
    linkedPlanVersionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    linkedBlockId: 'block/한글 %_',
  };
  it('preserves an exact version and Block pair independently from actual date filters', () => {
    expect(activityListQuerySchema.parse(linked)).toMatchObject(linked);
    expect(
      activityListQuerySchema.parse({
        ...linked,
        from: '2024-03-10',
        toExclusive: '2024-03-11',
        timezone: 'America/New_York',
        offset: 20,
        limit: 20,
      }),
    ).toMatchObject({ ...linked, from: '2024-03-10', offset: 20 });
    expect(activityListQuerySchema.parse({})).not.toHaveProperty('linkedPlanVersionId');
  });
  it('rejects incomplete and invalid linked filters instead of silently widening a query', () => {
    for (const query of [
      { linkedPlanVersionId: linked.linkedPlanVersionId },
      { linkedBlockId: linked.linkedBlockId },
      { ...linked, linkedPlanVersionId: 'not-a-version' },
      { ...linked, linkedBlockId: '' },
      { ...linked, linkedBlockId: ' block ' },
      { ...linked, linkedBlockId: null },
      { ...linked, linkedPlanVersionId: null },
    ])
      expect(activityListQuerySchema.safeParse(query).success).toBe(false);
  });
});
