import { describe, expect, it } from 'vitest';
import {
  projectRaceResultLegacyRead,
  projectStoredRaceResultLegacyRead,
  RaceResultLegacyProjectionError,
} from '../src/race-result-legacy-projection.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ref = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actual = {
  kind: 'race-result' as const,
  id,
  revision: 3,
  raceEventId: ref,
  localDate: '2026-10-07',
  timezone: 'Asia/Seoul',
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: 5000,
  linkedActivityId: ref,
  weatherNote: null,
};
const proofs = {
  link: 'https://example.org/private-proof',
  attachments: [
    {
      kind: 'gallery-image' as const,
      mediaItemId: ref,
      status: 'available' as const,
      accessRevision: 2,
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
const manual = { kind: 'manual' as const };
describe('explicit legacy read wire projection; not storage or ownership authority', () => {
  it.each([
    manual,
    { kind: 'device' as const, providerLabel: 'Synthetic observation' },
    {
      kind: 'official' as const,
      authority: 'Synthetic claim',
      resultUrl: 'https://example.org/result',
      verifiedAt: '2026-10-07T00:00:00Z',
    },
    {
      kind: 'official' as const,
      authority: 'Synthetic claim',
      resultUrl: 'https://example.org/result',
      verifiedAt: null,
    },
  ])('preserves V1 source and actual facts unchanged', (source) => {
    const record = { ...actual, source };
    expect(projectRaceResultLegacyRead(record)).toEqual(record);
  });
  it.each([manual, { kind: 'device' as const, providerLabel: 'Synthetic observation' }])(
    'preserves V2 actual/source fields while omitting all proof fields',
    (source) => {
      const record = { ...actual, schemaVersion: 2, source, proofs };
      const before = JSON.stringify(record);
      const projected = projectRaceResultLegacyRead(record);
      expect(projected).toEqual({ ...actual, source });
      expect(JSON.stringify(record)).toBe(before);
      for (const field of [
        'schemaVersion',
        'proofs',
        'accessRevision',
        'byteSize',
        'sha256',
        'private-proof',
        'versionId',
        'unavailable',
      ])
        expect(JSON.stringify(projected)).not.toContain(field);
    },
  );
  it('never converts V2 official link/attachment presence into verifiedAt', () => {
    const source = {
      kind: 'official' as const,
      authority: 'Synthetic claim',
      resultUrl: 'https://example.org/result',
    };
    expect(projectRaceResultLegacyRead({ ...actual, schemaVersion: 2, source, proofs })).toEqual({
      ...actual,
      source: { ...source, verifiedAt: null },
    });
  });
  it('retains null/zero, distance provenance, timezone and relational references', () => {
    const result = projectRaceResultLegacyRead({
      ...actual,
      schemaVersion: 2,
      source: manual,
      proofs: { link: null, attachments: [] },
    });
    expect(result).toMatchObject({
      chipSeconds: 0,
      gunSeconds: null,
      officialDistanceMeters: null,
      deviceDistanceMeters: 5000,
      timezone: 'Asia/Seoul',
      localDate: '2026-10-07',
      raceEventId: ref,
      linkedActivityId: ref,
      revision: 3,
    });
  });
  it.each([
    { ...actual, source: manual, athleteId: 'foreign' },
    { ...actual, schemaVersion: 2, source: manual, proofs, tenant: 'foreign' },
    {
      ...actual,
      schemaVersion: 2,
      source: {
        kind: 'official',
        authority: 'Claim',
        resultUrl: 'https://example.org/result',
        verifiedAt: '2026-10-07T00:00:00Z',
      },
      proofs,
    },
    {
      ...actual,
      schemaVersion: 2,
      source: manual,
      proofs: {
        link: null,
        attachments: [
          {
            kind: 'resource-pdf',
            resourceId: id,
            versionId: ref,
            status: 'unavailable',
            contentHash: 'a'.repeat(64),
          },
        ],
      },
    },
    { ...actual, source: manual, chipSeconds: undefined },
    { ...actual, source: manual, revision: 0 },
    null,
  ])('rejects malformed/unknown keys without granting ownership', (raw) => {
    expect(() => projectRaceResultLegacyRead(raw)).toThrow(RaceResultLegacyProjectionError);
  });
  it('checks original decoded UTF8 envelope before normalization/field omission', () => {
    expect(() =>
      projectRaceResultLegacyRead({ ...actual, source: manual, ignored: '가'.repeat(6000) }),
    ).toThrow(RaceResultLegacyProjectionError);
    const cycle: Record<string, unknown> = { ...actual, source: manual };
    cycle.self = cycle;
    expect(() => projectRaceResultLegacyRead(cycle)).toThrow(RaceResultLegacyProjectionError);
  });
});

describe('strict original relational stored tuple boundary', () => {
  const { id: _id, revision: _revision, ...storedActual } = actual;
  const storedProofs = {
    link: proofs.link,
    attachments: [
      {
        kind: 'gallery-image',
        mediaItemId: ref,
        accessRevision: 2,
        mediaType: 'image/png',
        byteSize: 1,
        sha256: 'a'.repeat(64),
      },
      { kind: 'resource-pdf', resourceId: id, versionId: ref, status: 'unavailable' },
    ],
  };
  it('validates stored descriptors without converting them to available read facts', () => {
    const values = { ...storedActual, source: manual, schemaVersion: 2, proofs: storedProofs };
    const tuple = { id, revision: 3, values };
    const before = JSON.stringify(tuple);
    expect(projectStoredRaceResultLegacyRead(tuple)).toEqual({ ...actual, source: manual });
    expect(JSON.stringify(tuple)).toBe(before);
    // Read boundary remains strict and does not coerce original descriptors.
    expect(() => projectRaceResultLegacyRead({ ...values, id, revision: 3 })).toThrow(
      RaceResultLegacyProjectionError,
    );
  });
  it('preserves historical V1 timestamp and source unlink nulls in V2 actuals', () => {
    const source = {
      kind: 'official',
      authority: 'Synthetic',
      resultUrl: 'https://example.org/result',
      verifiedAt: '2026-10-07T00:00:00Z',
    };
    expect(
      projectStoredRaceResultLegacyRead({ id, revision: 3, values: { ...storedActual, source } }),
    ).toEqual({ ...actual, source });
    const { verifiedAt: _verifiedAt, ...claim } = source;
    const values = {
      ...storedActual,
      raceEventId: null,
      linkedActivityId: null,
      source: claim,
      schemaVersion: 2,
      proofs: storedProofs,
    };
    const result = projectStoredRaceResultLegacyRead({ id, revision: 4, values });
    expect(result).toEqual({
      ...actual,
      revision: 4,
      raceEventId: null,
      linkedActivityId: null,
      source: { ...claim, verifiedAt: null },
    });
    expect(JSON.stringify(result)).not.toContain('sha256');
    expect(JSON.stringify(result)).not.toContain('unavailable');
    // These synthetic nulls prove projection behavior, not actual DB deletion.
  });
  it.each([
    { id: 'bad', revision: 3, values: { ...storedActual, source: manual } },
    { id: id.toUpperCase(), revision: 3, values: { ...storedActual, source: manual } },
    { id, revision: 0, values: { ...storedActual, source: manual } },
    { id, revision: 2147483648, values: { ...storedActual, source: manual } },
    { id, revision: 3, values: { ...storedActual, source: manual, id: ref } },
    { id, revision: 3, values: { ...storedActual, source: manual, revision: 1 } },
    { id, revision: 3, values: { ...storedActual, source: manual }, athleteId: 'foreign' },
    {
      id,
      revision: 3,
      values: {
        ...storedActual,
        source: manual,
        schemaVersion: 2,
        proofs: {
          link: null,
          attachments: [
            {
              kind: 'gallery-image',
              mediaItemId: ref,
              status: 'unavailable',
              sha256: 'a'.repeat(64),
            },
          ],
        },
      },
    },
  ])('rejects tuple forgery, identity aliases and redacted metadata', (raw) => {
    expect(() => projectStoredRaceResultLegacyRead(raw)).toThrow(RaceResultLegacyProjectionError);
  });
  it('bounds raw tuple bytes and rejects unknown source values', () => {
    expect(() =>
      projectStoredRaceResultLegacyRead({
        id,
        revision: 3,
        values: { ...storedActual, source: manual, ignored: '가'.repeat(6000) },
      }),
    ).toThrow(RaceResultLegacyProjectionError);
    expect(() =>
      projectStoredRaceResultLegacyRead({
        id,
        revision: 3,
        values: { ...storedActual, source: manual, ignored: 'x' },
      }),
    ).toThrow(RaceResultLegacyProjectionError);
  });
});

it('preserves schema-valid near-limit historical V1 stored body plus finite relational overhead while V2 retains its own strict envelope', () => {
  const { id: _id, revision: _revision, ...values } = actual;
  const source = {
    kind: 'official' as const,
    authority: 'Synthetic historical',
    resultUrl: 'https://example.org/result',
    verifiedAt: '2026-10-07T00:00:00.' + '0'.repeat(15890) + 'Z',
  };
  const body = { ...values, source };
  const size = Buffer.byteLength(JSON.stringify(body));
  expect(size).toBeLessThanOrEqual(16384);
  const tuple = { id, revision: 3, values: body };
  expect(Buffer.byteLength(JSON.stringify(tuple))).toBeGreaterThan(16384);
  expect(projectStoredRaceResultLegacyRead(tuple)).toEqual({ ...body, id, revision: 3 });
  expect(projectRaceResultLegacyRead({ ...body, id, revision: 3 })).toEqual({
    ...body,
    id,
    revision: 3,
  });
  expect(() =>
    projectStoredRaceResultLegacyRead({
      id,
      revision: 3,
      values: { ...body, source: { ...source, verifiedAt: source.verifiedAt + '0'.repeat(256) } },
    }),
  ).toThrow(RaceResultLegacyProjectionError);
});
