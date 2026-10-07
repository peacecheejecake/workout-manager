import { describe, expect, it } from 'vitest';
import {
  calculateRacePersonalBests,
  RacePersonalBestInputError,
} from '../src/race-personal-bests.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const base = {
  kind: 'race-result' as const,
  id,
  revision: 1,
  raceEventId: null,
  localDate: '2026-10-07',
  timezone: 'Asia/Seoul',
  source: { kind: 'manual' as const },
  chipSeconds: 1000,
  gunSeconds: 1100,
  officialDistanceMeters: 5000,
  deviceDistanceMeters: null,
  linkedActivityId: null,
  weatherNote: null,
};
const policy = {
  distance: { kind: 'standard' as const },
  timeKinds: ['chip', 'gun'] as const,
  period: { from: null, to: null, cutoff: '2026-10-07' },
};
const calculate = (records: unknown[], selected: unknown = policy) =>
  calculateRacePersonalBests({ records, policy: selected });
describe('explicit-policy race PB candidates; pure, not verification or ownership', () => {
  it('separates chip/gun groups and preserves source actuals without mutation', () => {
    const records = [structuredClone(base)];
    const before = JSON.stringify(records);
    const result = calculate(records);
    expect(result.groups.map((group) => [group.timeKind, group.best.seconds])).toEqual([
      ['chip', 1000],
      ['gun', 1100],
    ]);
    expect(JSON.stringify(records)).toBe(before);
    expect(result.evaluations[0]?.record).toEqual(base);
  });
  it.each([
    [5000, '5k'],
    [10000, '10k'],
    [21097.5, 'half-marathon'],
    [42195, 'marathon'],
  ])('maps exact official standard distance %s', (meters, category) => {
    expect(calculate([{ ...base, officialDistanceMeters: meters }]).groups[0]?.distance).toEqual({
      kind: 'standard',
      class: category,
      meters,
    });
  });
  it('does not round near-standard distance; arbitrary exact policy groups exact meters', () => {
    const record = { ...base, officialDistanceMeters: 5000.01 };
    expect(calculate([record]).evaluations[0]?.exclusion).toBe('distance_not_standard');
    const result = calculate([record, { ...base, id: secondId, officialDistanceMeters: 5000 }], {
      ...policy,
      distance: { kind: 'exact' },
    });
    expect(result.groups.map((group) => group.distance.meters)).toEqual([
      5000, 5000, 5000.01, 5000.01,
    ]);
  });
  it('manual and official claims are candidates but devices are not, irrespective of attached evidence', () => {
    const official = {
      ...base,
      id: secondId,
      source: {
        kind: 'official',
        authority: 'Synthetic',
        resultUrl: 'https://example.org/result',
        verifiedAt: '2026-10-07T00:00:00Z',
      },
    };
    expect(calculate([base, official]).groups[0]?.candidates).toHaveLength(2);
    const device = { ...base, source: { kind: 'device', providerLabel: 'synthetic' } };
    expect(
      calculate([device]).evaluations.every((value) => value.exclusion === 'device_source'),
    ).toBe(true);
    expect(calculate([device]).groups).toEqual([]);
  });
  it('preserves distinct null and zero time reasons without substituting chip/gun', () => {
    const result = calculate([{ ...base, chipSeconds: 0, gunSeconds: null }]);
    expect(result.evaluations.map((value) => [value.seconds, value.exclusion])).toEqual([
      [0, 'time_zero'],
      [null, 'time_unknown'],
    ]);
    expect(result.evaluations[0]?.record.chipSeconds).toBe(0);
    expect(result.groups).toEqual([]);
  });
  it('never promotes device distance to official distance', () => {
    expect(
      calculate([{ ...base, officialDistanceMeters: null, deviceDistanceMeters: 5000 }])
        .evaluations[0]?.exclusion,
    ).toBe('distance_unknown');
  });
  it('uses inclusive stored civil dates across timezones with explicit cutoff', () => {
    const selected = {
      ...policy,
      period: { from: '2026-10-07', to: '2026-10-07', cutoff: '2026-10-07' },
    };
    expect(calculate([{ ...base, timezone: 'America/New_York' }], selected).groups).toHaveLength(2);
    expect(
      calculate([{ ...base, localDate: '2026-10-06' }], selected).evaluations[0]?.exclusion,
    ).toBe('outside_period');
    expect(
      calculate([{ ...base, localDate: '2026-10-08' }], selected).evaluations[0]?.exclusion,
    ).toBe('after_cutoff');
  });
  it('sorts time then date then canonical UUID independent of input order', () => {
    const thirdId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const records = [
      { ...base, id: thirdId },
      { ...base, id: secondId, localDate: '2026-10-06' },
      { ...base, localDate: '2026-10-06' },
    ];
    const result = calculate(records);
    expect(result.groups[0]?.candidates.map((value) => value.record.id)).toEqual([
      id,
      secondId,
      thirdId,
    ]);
    expect(calculate([...records].reverse())).toEqual(result);
    expect(calculate([{ ...base, id: id.toUpperCase() }]).groups[0]?.best.record.id).toBe(id);
  });
  it('keeps V2 evidence counts and legacy timestamp as facts, never certification', () => {
    const result = calculate([
      {
        ...base,
        schemaVersion: 2,
        proofs: {
          link: 'https://example.org/proof',
          attachments: [
            { kind: 'gallery-image', mediaItemId: secondId, status: 'unavailable' },
            {
              kind: 'resource-pdf',
              resourceId: id,
              versionId: secondId,
              status: 'available',
              accessRevision: 1,
              mediaType: 'application/pdf',
              byteSize: 1,
              contentHash: 'a'.repeat(64),
            },
          ],
        },
      },
    ]);
    expect(result.evaluations[0]?.evidence).toEqual({
      linkPresent: true,
      availableAttachments: 1,
      unavailableAttachments: 1,
      legacyVerifiedAt: null,
    });
    expect(JSON.stringify(result)).not.toContain('certified');
    const legacy = calculate([
      {
        ...base,
        source: {
          kind: 'official',
          authority: 'Synthetic',
          resultUrl: 'https://example.org/result',
          verifiedAt: '2026-10-07T00:00:00Z',
        },
      },
    ]);
    expect(legacy.evaluations[0]?.evidence.legacyVerifiedAt).toBe('2026-10-07T00:00:00Z');
  });
  it('empty capture and a caller-selected single time kind remain valid', () => {
    expect(calculate([]).groups).toEqual([]);
    expect(
      calculate([base], { ...policy, timeKinds: ['gun'] }).evaluations.map(
        (value) => value.timeKind,
      ),
    ).toEqual(['gun']);
  });
  it.each([
    { records: [base, base] },
    { records: [base, { ...base, revision: 2 }] },
    { records: [base, { ...base, id: id.toUpperCase() }] },
  ])('rejects duplicate or conflicting identity without picking latest revision', ({ records }) => {
    expect(() => calculate(records)).toThrow(RacePersonalBestInputError);
  });
  it.each([
    { ...base, chipSeconds: -1 },
    { ...base, timezone: 'not/a/timezone' },
    { ...base, localDate: '2026-02-30' },
    { ...base, unexpected: true },
    { ...base, chipSeconds: undefined },
  ])('rejects malformed/partial DTO rather than treating missing as zero', (record) => {
    expect(() => calculate([record])).toThrow(RacePersonalBestInputError);
  });
  it('requires policy and rejects implicit selections, reversed dates or duplicate time kinds', () => {
    for (const invalid of [
      { ...policy, timeKinds: [] },
      { ...policy, timeKinds: ['chip', 'chip'] },
      { ...policy, distance: { kind: 'approximate' } },
      { ...policy, period: { from: '2026-10-08', to: '2026-10-07', cutoff: '2026-10-07' } },
    ])
      expect(() => calculate([base], invalid)).toThrow(RacePersonalBestInputError);
    expect(() => calculateRacePersonalBests({ records: [base] })).toThrow(
      RacePersonalBestInputError,
    );
  });
  it('enforces count and original decoded whole-JSON byte budgets before accepting records', () => {
    expect(() => calculate(Array.from({ length: 5001 }, () => base))).toThrow(
      RacePersonalBestInputError,
    );
    expect(() =>
      calculateRacePersonalBests({ records: [], policy, ignored: '가'.repeat(1_400_000) }),
    ).toThrow(RacePersonalBestInputError);
    expect(() => calculateRacePersonalBests({ records: [], policy, ignored: 'x' })).toThrow(
      RacePersonalBestInputError,
    );
  });
});
