import { describe, expect, it } from 'vitest';
import {
  importActivitySchema,
  activityOverlayWriteSchema,
  activityListQuerySchema,
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
