import { describe, expect, it } from 'vitest';
import {
  buildRaceResultLegacySuccessor,
  RaceResultLegacyUpdateError,
} from '../src/race-result-legacy-update.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ref = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const values = {
  kind: 'race-result' as const,
  raceEventId: null,
  localDate: '2026-10-07',
  timezone: 'UTC',
  source: { kind: 'manual' as const },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: 5000,
  linkedActivityId: null,
  weatherNote: null,
};
const proofs = {
  link: 'https://example.test/proof',
  attachments: [
    {
      kind: 'gallery-image' as const,
      mediaItemId: ref,
      accessRevision: 1,
      mediaType: 'image/png' as const,
      byteSize: 1,
      sha256: 'a'.repeat(64),
    },
    {
      kind: 'resource-pdf' as const,
      resourceId: id,
      versionId: ref,
      status: 'unavailable' as const,
    },
  ],
};
const prior = { id, revision: 1, values: { ...values, schemaVersion: 2, proofs } };
const raw = { prior, nextValues: { ...values, chipSeconds: 900 }, nextRevision: 2 };
describe('legacy command pure successor shaping, not source authority', () => {
  it('preserves stored V2 proofs exactly, actual null/zero and original input without resolving unavailable or repinning', () => {
    const before = JSON.stringify(raw);
    const next = buildRaceResultLegacySuccessor(raw);
    expect(next).toEqual({
      ...values,
      chipSeconds: 900,
      schemaVersion: 2,
      proofs,
      id,
      revision: 2,
    });
    expect(JSON.stringify(raw)).toBe(before);
    expect(next).not.toHaveProperty('approvalAllowed');
  });
  it.each([
    { kind: 'manual' as const },
    { kind: 'device' as const, providerLabel: 'Synthetic' },
    { kind: 'official' as const, authority: 'Claim', resultUrl: 'https://example.test/result' },
  ])(
    'supports explicit V1 actual source replacement without inserting verifiedAt into V2',
    (source) => {
      const next = buildRaceResultLegacySuccessor({ ...raw, nextValues: { ...values, source } });
      expect(next.source).toEqual(source);
      expect(next.source).not.toHaveProperty('verifiedAt');
      expect(next).toHaveProperty('proofs', proofs);
    },
  );
  it('prior V1 stays V1 and follows original official-claim timestamp reset semantics', () => {
    const source = {
      kind: 'official' as const,
      authority: 'Claim',
      resultUrl: 'https://example.test/result',
    };
    const next = buildRaceResultLegacySuccessor({
      prior: {
        id,
        revision: 1,
        values: { ...values, source: { ...source, verifiedAt: '2026-10-07T00:00:00Z' } },
      },
      nextValues: { ...values, source },
      nextRevision: 2,
    });
    expect(next).toEqual({ ...values, source: { ...source, verifiedAt: null }, id, revision: 2 });
    expect(next).not.toHaveProperty('schemaVersion');
    expect(next).not.toHaveProperty('proofs');
  });
  it.each([
    { ...raw, nextRevision: 3 },
    { ...raw, prior: { ...prior, revision: 2147483647 }, nextRevision: 2147483648 },
    { ...raw, prior: { ...prior, values: { ...prior.values, id: ref } } },
    { ...raw, prior: { ...prior, athleteId: 'foreign' } },
    { ...raw, nextValues: { ...values, proofs: { link: null, attachments: [] } } },
    {
      ...raw,
      nextValues: {
        ...values,
        source: {
          kind: 'official',
          authority: 'Claim',
          resultUrl: 'https://example.test/result',
          verifiedAt: null,
        },
      },
    },
    {
      ...raw,
      prior: {
        ...prior,
        values: {
          ...prior.values,
          proofs: {
            link: null,
            attachments: [
              { kind: 'gallery-image', mediaItemId: ref, status: 'unavailable', byteSize: 1 },
            ],
          },
        },
      },
    },
  ])('rejects client proof injection, malformed/alias tuples and revision overflow', (input) => {
    expect(() => buildRaceResultLegacySuccessor(input)).toThrow(RaceResultLegacyUpdateError);
  });
  it('bounds original metadata before decode and cannot invent absent prior body', () => {
    expect(() => buildRaceResultLegacySuccessor({ ...raw, ignored: '가'.repeat(12000) })).toThrow(
      RaceResultLegacyUpdateError,
    );
    expect(() =>
      buildRaceResultLegacySuccessor({ ...raw, prior: { ...prior, values: null } }),
    ).toThrow(RaceResultLegacyUpdateError);
  });
});
