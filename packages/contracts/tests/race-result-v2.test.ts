import { describe, expect, it } from 'vitest';
import {
  raceResultV2Schema,
  raceResultReadV2Schema,
  raceResultCompatibleReadSchema,
  raceResultCreateV2CommandSchema,
  raceResultUpdateV2CommandSchema,
  raceResultListV2PageSchema,
  raceResultAttachmentInputSchema,
  raceResultAttachmentUnavailableSchema,
  raceResultStorageLifecycleV2Schema,
  raceResultCompatibleStorageLifecycleSchema,
} from '../src/race-result-v2.js';
import { raceResultSchema } from '../src/races.js';
import { raceResultCreateCommandSchema } from '../src/race-commands.js';

const id = 'abcdefab-1234-4123-8123-123456789abc';
const second = 'bbcdefab-1234-4123-8123-123456789abc';
const third = 'cbcdefab-1234-4123-8123-123456789abc';
const values = {
  kind: 'race-result',
  raceEventId: null,
  localDate: '2026-10-07',
  timezone: 'Asia/Seoul',
  source: { kind: 'manual' },
  chipSeconds: 0,
  gunSeconds: null,
  officialDistanceMeters: null,
  deviceDistanceMeters: 0.5,
  linkedActivityId: null,
  weatherNote: null,
};
const proofs = { link: 'https://example.org/results#finish', attachments: [] };
const input = { schemaVersion: 2, idempotencyKey: 'race_proof_001', values: { ...values, proofs } };
const record = { schemaVersion: 2, id, revision: 1, ...values, proofs };
const gallery = {
  kind: 'gallery-image',
  mediaItemId: second,
  accessRevision: 2,
  mediaType: 'image/png',
  byteSize: 3,
  sha256: 'a'.repeat(64),
};
const pdf = {
  kind: 'resource-pdf',
  resourceId: second,
  versionId: third,
  accessRevision: 3,
  mediaType: 'application/pdf',
  byteSize: 4,
  contentHash: 'b'.repeat(64),
};

describe('race result explicit V2 proof boundary', () => {
  it('preserves manual source, nullable facts and measured zero without verification authority', () => {
    expect(raceResultCreateV2CommandSchema.parse(input)).toEqual(input);
    expect(raceResultV2Schema.parse(record)).toEqual(record);
    expect(raceResultReadV2Schema.parse(record)).toEqual(record);
  });
  it.each([
    { kind: 'manual' },
    { kind: 'device', providerLabel: 'Synthetic device' },
    { kind: 'official', authority: 'Reported organizer', resultUrl: 'https://example.org/claim' },
  ])('keeps source claim separate from attached evidence %#', (source) => {
    const body = { ...record, source };
    expect(raceResultV2Schema.parse(body).source).toEqual(source);
    expect(
      raceResultV2Schema.safeParse({ ...body, source: { ...source, verifiedAt: null } }).success,
    ).toBe(false);
    expect(
      raceResultV2Schema.safeParse({ ...body, source: { ...source, verified: true } }).success,
    ).toBe(false);
  });
  it('preserves V1 original timestamp facts and rejects silent V1 proof widening', () => {
    const old = {
      id,
      revision: 1,
      ...values,
      source: {
        kind: 'official',
        authority: 'Historical claim',
        resultUrl: 'https://example.org/old',
        verifiedAt: '2026-10-06T10:00:00Z',
      },
    };
    expect(raceResultCompatibleReadSchema.parse(old)).toEqual(raceResultSchema.parse(old));
    expect(raceResultSchema.safeParse(record).success).toBe(false);
    expect(raceResultCreateCommandSchema.safeParse(input).success).toBe(false);
  });
  it('accepts only expected source versions in write refs, not resolved server facts', () => {
    const attachments = [
      { kind: 'gallery-image', mediaItemId: second, expectedAccessRevision: 2 },
      { kind: 'resource-pdf', resourceId: second, versionId: third, expectedAccessRevision: 3 },
    ];
    expect(
      raceResultCreateV2CommandSchema.parse({
        ...input,
        values: { ...values, proofs: { ...proofs, attachments } },
      }).values.proofs.attachments,
    ).toEqual(attachments);
    expect(raceResultAttachmentInputSchema.safeParse(gallery).success).toBe(false);
    expect(raceResultAttachmentInputSchema.safeParse(pdf).success).toBe(false);
  });
  it('stores bounded server descriptor facts but reads availability without metadata when unavailable', () => {
    const stored = { ...record, proofs: { ...proofs, attachments: [gallery, pdf] } };
    expect(raceResultV2Schema.parse(stored)).toEqual(stored);
    const available = {
      ...record,
      proofs: {
        ...proofs,
        attachments: [
          { ...gallery, status: 'available' },
          { ...pdf, status: 'available' },
        ],
      },
    };
    expect(raceResultReadV2Schema.parse(available)).toEqual(available);
    const unavailable = { kind: 'gallery-image', mediaItemId: second, status: 'unavailable' };
    expect(
      raceResultReadV2Schema.safeParse({
        ...record,
        proofs: { ...proofs, attachments: [unavailable] },
      }).success,
    ).toBe(true);
    expect(
      raceResultReadV2Schema.safeParse({
        ...record,
        proofs: { ...proofs, attachments: [{ ...gallery, status: 'unavailable' }] },
      }).success,
    ).toBe(false);
    expect(raceResultV2Schema.safeParse(available).success).toBe(false);
  });
  it.each(['verifiedAt', 'reviewer', 'verified', 'storageRef', 'signedUrl'])(
    'rejects unsupported truth or storage fields %s',
    (key) => {
      expect(
        raceResultCreateV2CommandSchema.safeParse({ ...input, [key]: 'injected' }).success,
      ).toBe(false);
      expect(
        raceResultV2Schema.safeParse({ ...record, proofs: { ...proofs, [key]: 'injected' } })
          .success,
      ).toBe(false);
    },
  );
  it.each([
    'http://example.org/proof',
    'https://user:secret@example.org/proof',
    `https://example.org/${'a'.repeat(2048)}`,
  ])('rejects unsafe or oversized link %#', (link) => {
    expect(raceResultV2Schema.safeParse({ ...record, proofs: { ...proofs, link } }).success).toBe(
      false,
    );
  });
  it('rejects exact duplicates, alternate version same source, case aliases and more than four refs', () => {
    const parse = (attachments: unknown[]) =>
      raceResultV2Schema.safeParse({ ...record, proofs: { ...proofs, attachments } }).success;
    expect(parse([gallery, gallery])).toBe(false);
    expect(parse([pdf, { ...pdf, versionId: id }])).toBe(false);
    expect(second.toUpperCase()).not.toBe(second);
    expect(parse([{ ...gallery, mediaItemId: second.toUpperCase() }])).toBe(false);
    expect(
      parse(
        Array.from({ length: 5 }, (_, index) => ({
          ...gallery,
          mediaItemId: `abcde${index}ab-1234-4123-8123-123456789abc`,
        })),
      ),
    ).toBe(false);
    expect(parse([{ ...gallery, mediaType: 'video/mp4' }])).toBe(false);
    expect(parse([{ ...pdf, mediaType: 'text/markdown' }])).toBe(false);
  });
  it('checks whole raw UTF8 command/record bytes before parsing and limits revisions', () => {
    // Scalar-valid 2000-char multibyte note; oversized raw unknown data must fail before stripping.
    const large = {
      ...input,
      values: { ...input.values, weatherNote: '가'.repeat(2000) },
      extra: '가'.repeat(6000),
    };
    const result = raceResultCreateV2CommandSchema.safeParse(large);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes('UTF-8'))).toBe(true);
    expect(
      raceResultCreateV2CommandSchema.safeParse({
        ...input,
        values: { ...input.values, weatherNote: '가'.repeat(2000) },
      }).success,
    ).toBe(true);
    expect(
      raceResultUpdateV2CommandSchema.safeParse({ ...input, expectedRevision: 2147483646 }).success,
    ).toBe(true);
    expect(
      raceResultUpdateV2CommandSchema.safeParse({ ...input, expectedRevision: 2147483647 }).success,
    ).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(raceResultV2Schema.safeParse(cyclic).success).toBe(false);
  });
  it('rejects scalar-valid multibyte proof records and commands above the whole UTF8 budget', () => {
    const source = {
      kind: 'official',
      authority: '사용자 보고',
      resultUrl: `https://example.org/${'가'.repeat(1900)}`,
    };
    const body = {
      ...values,
      source,
      weatherNote: '가'.repeat(2000),
      proofs: { link: `https://example.org/${'나'.repeat(1900)}`, attachments: [] },
    };
    // Existing scalar validators accept each field; only the combined envelope is too large.
    expect(
      raceResultCreateCommandSchema.safeParse({
        idempotencyKey: input.idempotencyKey,
        values: { ...values, source, weatherNote: body.weatherNote },
      }).success,
    ).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeGreaterThan(16384);
    expect(raceResultCreateV2CommandSchema.safeParse({ ...input, values: body }).success).toBe(
      false,
    );
    expect(raceResultV2Schema.safeParse({ ...record, ...body }).success).toBe(false);
  });
  it('preserves page collection/cursor binding, strict order, missing and unknown boundaries', () => {
    const collection = { revision: 2, privacyGeneration: '0' };
    const nextCursor = { kind: 'race-result', collection, afterId: second };
    const page = {
      schemaVersion: 2,
      kind: 'race-result',
      sort: 'id-asc',
      collection,
      items: [record, { ...record, id: second }],
      nextCursor,
    };
    expect(raceResultListV2PageSchema.parse(page)).toEqual(page);
    expect(raceResultListV2PageSchema.safeParse({ ...page, collection: null }).success).toBe(false);
    expect(
      raceResultListV2PageSchema.safeParse({ ...page, items: [...page.items].reverse() }).success,
    ).toBe(false);
    expect(
      raceResultListV2PageSchema.safeParse({
        ...page,
        nextCursor: { ...nextCursor, collection: { ...collection, privacyGeneration: '1' } },
      }).success,
    ).toBe(false);
    expect(raceResultListV2PageSchema.safeParse({ ...page, unknown: true }).success).toBe(false);
  });
});

describe('V2 explicit physical storage lifecycle', () => {
  const unavailableGallery = { kind: 'gallery-image', mediaItemId: second, status: 'unavailable' };
  const unavailablePdf = {
    kind: 'resource-pdf',
    resourceId: second,
    versionId: third,
    status: 'unavailable',
  };
  it('preserves resolved initial storage and accepts mixed contentless redaction without rewriting actuals', () => {
    const original = { ...record, proofs: { ...proofs, attachments: [gallery, pdf] } };
    expect(raceResultStorageLifecycleV2Schema.parse(original)).toEqual(
      raceResultV2Schema.parse(original),
    );
    const redacted = { ...original, proofs: { ...proofs, attachments: [unavailableGallery, pdf] } };
    expect(raceResultStorageLifecycleV2Schema.parse(redacted)).toEqual(redacted);
    expect(raceResultV2Schema.safeParse(redacted).success).toBe(false);
    expect(redacted.id).toBe(original.id);
    expect(redacted.revision).toBe(original.revision);
    expect({ ...redacted, proofs: undefined }).toEqual({ ...original, proofs: undefined });
  });
  it('keeps current and historical revision facts distinct and does not reconnect an unavailable ref', () => {
    const current = {
      ...record,
      revision: 7,
      chipSeconds: null,
      proofs: { link: null, attachments: [unavailableGallery] },
    };
    const history = {
      ...record,
      revision: 2,
      chipSeconds: 0,
      proofs: { ...proofs, attachments: [unavailablePdf] },
    };
    expect(raceResultStorageLifecycleV2Schema.parse(current)).toEqual(current);
    expect(raceResultStorageLifecycleV2Schema.parse(history)).toEqual(history);
    expect(raceResultReadV2Schema.parse(history)).toEqual(history);
    expect(history.proofs.attachments[0]).not.toHaveProperty('contentHash');
    expect(history.proofs.attachments[0]).not.toHaveProperty('accessRevision');
    expect(
      raceResultCreateV2CommandSchema.safeParse({
        ...input,
        values: { ...values, proofs: history.proofs },
      }).success,
    ).toBe(false);
    expect(
      raceResultUpdateV2CommandSchema.safeParse({
        ...input,
        expectedRevision: 7,
        values: { ...values, proofs: current.proofs },
      }).success,
    ).toBe(false);
  });
  it.each([
    'mediaType',
    'byteSize',
    'sha256',
    'contentHash',
    'accessRevision',
    'expectedAccessRevision',
    'reason',
    'verifiedAt',
  ])('rejects residual protected metadata or provenance on unavailable %s', (field) => {
    for (const ref of [unavailableGallery, unavailablePdf]) {
      const injected = { ...ref, [field]: 'copied' };
      expect(raceResultAttachmentUnavailableSchema.safeParse(injected).success).toBe(false);
      expect(
        raceResultStorageLifecycleV2Schema.safeParse({
          ...record,
          proofs: { ...proofs, attachments: [injected] },
        }).success,
      ).toBe(false);
    }
  });
  it('rejects mixed resolved/redacted duplicates, unknown or forged identities and lifecycle widening', () => {
    for (const refs of [
      [gallery, unavailableGallery],
      [pdf, unavailablePdf],
      [unavailablePdf, { ...unavailablePdf, versionId: id }],
    ])
      expect(
        raceResultStorageLifecycleV2Schema.safeParse({
          ...record,
          proofs: { ...proofs, attachments: refs },
        }).success,
      ).toBe(false);
    expect(
      raceResultAttachmentUnavailableSchema.safeParse({ ...unavailablePdf, versionId: undefined })
        .success,
    ).toBe(false);
    expect(
      raceResultAttachmentUnavailableSchema.safeParse({
        ...unavailableGallery,
        mediaItemId: second.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      raceResultAttachmentUnavailableSchema.safeParse({ ...unavailableGallery, versionId: third })
        .success,
    ).toBe(false);
    expect(
      raceResultStorageLifecycleV2Schema.safeParse({
        ...record,
        proofs: { ...proofs, attachments: [{ ...gallery, status: 'available' }] },
      }).success,
    ).toBe(false);
  });
  it('preserves legacy V1 original body and whole raw UTF8 lifecycle bound', () => {
    const old = {
      id,
      revision: 2,
      ...values,
      source: {
        kind: 'official',
        authority: 'Historical',
        resultUrl: 'https://example.org/old',
        verifiedAt: '2026-10-06T10:00:00Z',
      },
    };
    expect(raceResultCompatibleStorageLifecycleSchema.parse(old)).toEqual(old);
    const tooLarge = {
      ...record,
      proofs: { ...proofs, attachments: [unavailablePdf] },
      extra: '가'.repeat(6000),
    };
    const result = raceResultStorageLifecycleV2Schema.safeParse(tooLarge);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.message.includes('UTF-8'))).toBe(true);
  });
});
