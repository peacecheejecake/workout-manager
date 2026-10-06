import { describe, expect, it } from 'vitest';
import {
  raceCommandResultSchema,
  raceEventDeleteCommandSchema,
  raceResultDeleteCommandSchema,
  trainingBestDeleteCommandSchema,
  raceEventCreateCommandSchema,
  raceEventUpdateCommandSchema,
  raceEventReadCommandSchema,
  raceEventReadSchema,
  raceResultCreateCommandSchema,
  raceResultUpdateCommandSchema,
  raceResultReadCommandSchema,
  raceResultReadSchema,
  trainingBestCreateCommandSchema,
  trainingBestUpdateCommandSchema,
  trainingBestReadCommandSchema,
  trainingBestReadSchema,
} from '../src/race-commands.js';

const id = '11111111-1111-4111-8111-111111111111';
const courseId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const idempotencyKey = 'race_command_001';
const event = {
  title: '가을 10km',
  localDate: '2026-10-04',
  localStartTime: null,
  timezone: 'Asia/Seoul',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: { courseId, courseRevision: 2, revisionId },
  targetSeconds: 0,
  planVersionId: null,
} as const;
const result = {
  kind: 'race-result',
  raceEventId: null,
  localDate: '2026-10-04',
  timezone: 'Asia/Seoul',
  source: { kind: 'official', authority: '주최자', resultUrl: 'https://example.org/result' },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: 10042,
  linkedActivityId: null,
  weatherNote: '맑음\n약한 바람',
} as const;
const best = {
  kind: 'training-best',
  observedAt: '2026-10-03T08:00:00+09:00',
  source: { kind: 'activity', activityId: id },
  basis: 'device-estimated-split',
  distanceMeters: null,
  elapsedSeconds: 0,
} as const;

describe('M2-02b / S15 S16 / V2-F20 storage command boundaries', () => {
  const boundaries = [
    { create: raceEventCreateCommandSchema, update: raceEventUpdateCommandSchema, values: event },
    {
      create: raceResultCreateCommandSchema,
      update: raceResultUpdateCommandSchema,
      values: result,
    },
    {
      create: trainingBestCreateCommandSchema,
      update: trainingBestUpdateCommandSchema,
      values: best,
    },
  ];

  it('preserves full replacement values, unknowns, zero, units and original time representations', () => {
    for (const { create, update, values } of boundaries) {
      expect(create.parse({ idempotencyKey, values })).toEqual({ idempotencyKey, values });
      expect(update.parse({ idempotencyKey, expectedRevision: 2, values })).toEqual({
        idempotencyKey,
        expectedRevision: 2,
        values,
      });
    }
    expect(
      raceEventCreateCommandSchema.safeParse({
        idempotencyKey,
        values: { ...event, localStartTime: undefined },
      }).success,
    ).toBe(false);
    expect(
      raceResultCreateCommandSchema.safeParse({
        idempotencyKey,
        values: { ...result, gunSeconds: undefined },
      }).success,
    ).toBe(false);
    expect(
      trainingBestCreateCommandSchema.safeParse({
        idempotencyKey,
        values: { ...best, distanceMeters: 0 },
      }).success,
    ).toBe(false);
  });

  it('rejects server-owned ID, revision and ownership fields at every input boundary', () => {
    for (const { create, update, values } of boundaries) {
      for (const injected of [{ id }, { revision: 4 }, { athleteId: id }, { ownerId: id }]) {
        expect(create.safeParse({ idempotencyKey, values, ...injected }).success).toBe(false);
        expect(
          create.safeParse({ idempotencyKey, values: { ...values, ...injected } }).success,
        ).toBe(false);
        expect(
          update.safeParse({ idempotencyKey, expectedRevision: 1, values, ...injected }).success,
        ).toBe(false);
        expect(
          update.safeParse({
            idempotencyKey,
            expectedRevision: 1,
            values: { ...values, ...injected },
          }).success,
        ).toBe(false);
      }
    }
  });

  it('requires a bounded prior revision and key without claiming that a valid revision is fresh', () => {
    for (const { create, update, values } of boundaries) {
      for (const expectedRevision of [undefined, null, 0, -1, 1.5, '1', 2147483647]) {
        expect(update.safeParse({ idempotencyKey, expectedRevision, values }).success).toBe(false);
      }
      // A structurally valid old revision reaches the repository, where comparison is required.
      expect(update.safeParse({ idempotencyKey, expectedRevision: 1, values }).success).toBe(true);
      expect(create.safeParse({ idempotencyKey, expectedRevision: 0, values }).success).toBe(false);
      for (const invalidKey of ['', 'short', 'x'.repeat(129), 'key with spaces', 'key/with/path']) {
        expect(create.safeParse({ idempotencyKey: invalidKey, values }).success).toBe(false);
        expect(
          update.safeParse({ idempotencyKey: invalidKey, expectedRevision: 1, values }).success,
        ).toBe(false);
      }
    }
  });

  it('accepts an official claim but rejects even null client verification and keeps sources separate', () => {
    for (const verifiedAt of [null, '2026-10-05T09:00:00+09:00']) {
      const values = { ...result, source: { ...result.source, verifiedAt } };
      expect(raceResultCreateCommandSchema.safeParse({ idempotencyKey, values }).success).toBe(
        false,
      );
      expect(
        raceResultUpdateCommandSchema.safeParse({ idempotencyKey, expectedRevision: 1, values })
          .success,
      ).toBe(false);
    }
    for (const source of [{ kind: 'manual' }, { kind: 'device', providerLabel: 'Watch' }]) {
      expect(
        raceResultCreateCommandSchema.parse({ idempotencyKey, values: { ...result, source } })
          .values.source,
      ).toEqual(source);
      expect(
        raceResultCreateCommandSchema.safeParse({
          idempotencyKey,
          values: { ...result, source: { ...source, authority: '주최자' } },
        }).success,
      ).toBe(false);
    }
    expect(raceResultCreateCommandSchema.safeParse({ idempotencyKey, values: best }).success).toBe(
      false,
    );
    expect(
      trainingBestCreateCommandSchema.safeParse({ idempotencyKey, values: result }).success,
    ).toBe(false);
    expect(
      trainingBestCreateCommandSchema.safeParse({
        idempotencyKey,
        values: { ...best, source: result.source },
      }).success,
    ).toBe(false);
    expect(
      trainingBestCreateCommandSchema.parse({
        idempotencyKey,
        values: { ...best, source: { kind: 'manual' }, basis: 'user-entered' },
      }).values.source.kind,
    ).toBe('manual');
  });

  it('pins Course revision and rejects silent plan actions and unexpected nested keys', () => {
    for (const course of [
      { courseId },
      { courseId, courseRevision: 2 },
      { ...event.course, useLatestHead: true },
    ]) {
      expect(
        raceEventCreateCommandSchema.safeParse({ idempotencyKey, values: { ...event, course } })
          .success,
      ).toBe(false);
    }
    expect(
      raceEventUpdateCommandSchema.safeParse({
        idempotencyKey,
        expectedRevision: 1,
        values: { ...event, localDate: '2026-10-11', applyPlanChanges: true },
      }).success,
    ).toBe(false);
    expect(
      raceEventCreateCommandSchema.safeParse({
        idempotencyKey,
        values: { ...event, distance: { ...event.distance, unit: 'km' } },
      }).success,
    ).toBe(false);
    expect(
      raceEventCreateCommandSchema.safeParse({
        idempotencyKey,
        values: { ...event, timezone: '+09:00' },
      }).success,
    ).toBe(false);
    expect(
      raceResultCreateCommandSchema.safeParse({
        idempotencyKey,
        values: { ...result, chipSeconds: -1 },
      }).success,
    ).toBe(false);
  });

  it('returns the final int4 revision while bounding future update inputs', () => {
    expect(raceCommandResultSchema.parse({ id, revision: 2147483647 })).toEqual({
      id,
      revision: 2147483647,
    });
    expect(raceCommandResultSchema.safeParse({ id, revision: 2147483648 }).success).toBe(false);
    expect(
      raceEventUpdateCommandSchema.safeParse({
        idempotencyKey,
        expectedRevision: 2147483647,
        values: event,
      }).success,
    ).toBe(false);
  });

  it('reads by resource ID only and accepts server facts solely in read output', () => {
    expect(raceCommandResultSchema.parse({ id, revision: 2 })).toEqual({ id, revision: 2 });
    expect(raceCommandResultSchema.safeParse({ id, revision: 2, values: result }).success).toBe(
      false,
    );
    expect(raceCommandResultSchema.safeParse({ id, revision: 0 }).success).toBe(false);
    for (const read of [
      raceEventReadCommandSchema,
      raceResultReadCommandSchema,
      trainingBestReadCommandSchema,
    ]) {
      expect(read.parse({ id })).toEqual({ id });
      expect(read.safeParse({ id, athleteId: id }).success).toBe(false);
      expect(read.safeParse({ id, expectedRevision: 1 }).success).toBe(false);
      expect(read.safeParse({ id: 'bad' }).success).toBe(false);
    }
    expect(raceEventReadSchema.parse({ ...event, id, revision: 2 }).revision).toBe(2);
    const verified = {
      ...result,
      id,
      revision: 1,
      source: { ...result.source, verifiedAt: '2026-10-05T09:00:00+09:00' },
    };
    expect(raceResultReadSchema.parse(verified)).toEqual(verified);
    expect(trainingBestReadSchema.parse({ ...best, id, revision: 1 }).elapsedSeconds).toBe(0);
    expect(raceResultReadSchema.safeParse({ ...result, id, revision: 1 }).success).toBe(false);
  });
});

// M2-02f: a terminal revision cannot prevent privacy deletion.
describe('race deletion boundary', () => {
  it('accepts terminal CAS while rejecting ownership, health data and invalid revisions', () => {
    for (const schema of [
      raceEventDeleteCommandSchema,
      raceResultDeleteCommandSchema,
      trainingBestDeleteCommandSchema,
    ]) {
      expect(schema.parse({ idempotencyKey, expectedRevision: 2147483647 })).toEqual({
        idempotencyKey,
        expectedRevision: 2147483647,
      });
      for (const expectedRevision of [undefined, null, 0, -1, 1.5, '1', 2147483648])
        expect(schema.safeParse({ idempotencyKey, expectedRevision }).success).toBe(false);
      for (const extra of [
        { athleteId: id },
        { ownerId: id },
        { id },
        { values: result },
        { confirmed: true },
      ])
        expect(schema.safeParse({ idempotencyKey, expectedRevision: 1, ...extra }).success).toBe(
          false,
        );
      for (const invalidKey of ['', 'short', 'x'.repeat(129), 'key/with/path'])
        expect(schema.safeParse({ idempotencyKey: invalidKey, expectedRevision: 1 }).success).toBe(
          false,
        );
    }
  });
});
