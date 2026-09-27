import { describe, expect, it } from 'vitest';
import {
  isVerifiedOfficialRaceCandidate,
  performanceRecordSchema,
  raceCourseRefSchema,
  raceEventSchema,
  raceResultSchema,
  trainingBestSchema,
} from '../src/races.js';

const raceId = '11111111-1111-4111-8111-111111111111';
const courseId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const activityId = '44444444-4444-4444-8444-444444444444';

const event = {
  id: raceId,
  revision: 1,
  title: '가을 10km',
  localDate: '2026-10-04',
  localStartTime: '08:30',
  timezone: 'Asia/Seoul',
  locationName: '서울',
  distance: { kind: 'standard', class: '10k' },
  priority: 'A',
  participation: 'registered',
  officialUrl: 'https://example.org/race',
  course: { courseId, courseRevision: 2, revisionId },
  targetSeconds: 2400,
  planVersionId: '55555555-5555-4555-8555-555555555555',
} as const;

const result = {
  kind: 'race-result',
  id: '66666666-6666-4666-8666-666666666666',
  revision: 1,
  raceEventId: raceId,
  localDate: '2026-10-04',
  timezone: 'Asia/Seoul',
  source: {
    kind: 'official',
    authority: '대회 주최자',
    resultUrl: 'https://example.org/result',
    verifiedAt: '2026-10-05T09:00:00+09:00',
  },
  chipSeconds: 2400,
  gunSeconds: 2410,
  officialDistanceMeters: 10000,
  deviceDistanceMeters: 10042,
  linkedActivityId: activityId,
  weatherNote: null,
} as const;

const trainingBest = {
  kind: 'training-best',
  id: '77777777-7777-4777-8777-777777777777',
  revision: 1,
  observedAt: '2026-10-03T08:00:00+09:00',
  source: { kind: 'activity', activityId },
  basis: 'device-estimated-split',
  distanceMeters: 10000,
  elapsedSeconds: 2390,
} as const;

describe('M2-02a race and record boundaries', () => {
  it('keeps a planned event separate from actual results and pins the Course revision', () => {
    expect(raceEventSchema.parse(event)).toEqual(event);
    expect(raceResultSchema.parse(result)).toEqual(result);
    expect(raceCourseRefSchema.parse(event.course)).toEqual(event.course);
    expect(raceEventSchema.safeParse({ ...event, chipSeconds: 2390 }).success).toBe(false);
    expect(raceResultSchema.safeParse({ ...result, targetSeconds: 2390 }).success).toBe(false);
    expect(raceCourseRefSchema.safeParse({ courseId, courseRevision: 2 }).success).toBe(false);
    expect(raceCourseRefSchema.safeParse({ ...event.course, courseRevision: 0 }).success).toBe(
      false,
    );
    expect(raceCourseRefSchema.safeParse({ ...event.course, useLatestHead: true }).success).toBe(
      false,
    );
  });

  it('rejects invalid local dates, timezone, official URL and oversized input', () => {
    expect(raceEventSchema.safeParse({ ...event, localDate: '2026-02-30' }).success).toBe(false);
    expect(raceEventSchema.safeParse({ ...event, timezone: '+09:00' }).success).toBe(false);
    expect(raceEventSchema.safeParse({ ...event, officialUrl: 'http://example.org' }).success).toBe(
      false,
    );
    expect(raceEventSchema.safeParse({ ...event, title: 'x'.repeat(201) }).success).toBe(false);
    expect(raceEventSchema.safeParse({ ...event, localStartTime: '25:00' }).success).toBe(false);
    expect(
      raceEventSchema.safeParse({
        ...event,
        distance: { kind: 'custom', label: '언덕', nominalMeters: null },
      }).success,
    ).toBe(true);
  });

  it('preserves unknown and zero rather than filling a planned or actual value', () => {
    const unknownEvent = raceEventSchema.parse({
      ...event,
      localStartTime: null,
      locationName: null,
      priority: null,
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    });
    expect(unknownEvent.targetSeconds).toBe(0);
    expect(unknownEvent.localStartTime).toBeNull();
    const partialResult = raceResultSchema.parse({
      ...result,
      chipSeconds: 0,
      gunSeconds: null,
      officialDistanceMeters: null,
      deviceDistanceMeters: 10042,
      linkedActivityId: null,
    });
    expect(partialResult.chipSeconds).toBe(0);
    expect(partialResult.gunSeconds).toBeNull();
    expect(partialResult.officialDistanceMeters).toBeNull();
    expect(partialResult.deviceDistanceMeters).toBe(10042);
    expect(isVerifiedOfficialRaceCandidate(partialResult)).toBe(false);
  });

  it('never treats a device split or an unverified/manual race report as an official PB candidate', () => {
    expect(performanceRecordSchema.parse(trainingBest)).toEqual(trainingBest);
    expect(isVerifiedOfficialRaceCandidate(performanceRecordSchema.parse(result))).toBe(true);
    expect(isVerifiedOfficialRaceCandidate(performanceRecordSchema.parse(trainingBest))).toBe(
      false,
    );
    expect(
      isVerifiedOfficialRaceCandidate(
        raceResultSchema.parse({ ...result, source: { kind: 'device', providerLabel: 'Watch' } }),
      ),
    ).toBe(false);
    expect(
      isVerifiedOfficialRaceCandidate(
        raceResultSchema.parse({ ...result, source: { ...result.source, verifiedAt: null } }),
      ),
    ).toBe(false);
    expect(
      isVerifiedOfficialRaceCandidate(
        raceResultSchema.parse({ ...result, source: { kind: 'manual' } }),
      ),
    ).toBe(false);
    expect(
      trainingBestSchema.safeParse({ ...trainingBest, source: { kind: 'official' } }).success,
    ).toBe(false);
  });

  it('rejects invalid actual units, sources and unbounded text', () => {
    expect(raceResultSchema.safeParse({ ...result, officialDistanceMeters: -1 }).success).toBe(
      false,
    );
    expect(raceResultSchema.safeParse({ ...result, chipSeconds: Number.NaN }).success).toBe(false);
    expect(raceResultSchema.safeParse({ ...result, weatherNote: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    expect(raceResultSchema.safeParse({ ...result, source: { kind: 'official' } }).success).toBe(
      false,
    );
    expect(trainingBestSchema.safeParse({ ...trainingBest, distanceMeters: 0 }).success).toBe(
      false,
    );
    expect(
      trainingBestSchema.safeParse({
        ...trainingBest,
        source: { kind: 'activity', activityId: 'bad' },
      }).success,
    ).toBe(false);
  });
});
