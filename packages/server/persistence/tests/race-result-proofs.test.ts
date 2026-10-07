import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/database.js';
import { prepareRaceResultProofs, projectRaceResultProofsIn } from '../src/race-result-proofs.js';
const imageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherVersion = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const hash = 'a'.repeat(64);
const image = { kind: 'gallery-image' as const, mediaItemId: imageId, expectedAccessRevision: 1 };
const pdf = { kind: 'resource-pdf' as const, resourceId, versionId, expectedAccessRevision: 1 };
const storedImage = {
  kind: image.kind,
  mediaItemId: imageId,
  accessRevision: 1,
  mediaType: 'image/png' as const,
  byteSize: 10,
  sha256: hash,
};
const storedPdf = {
  kind: pdf.kind,
  resourceId,
  versionId,
  accessRevision: 1,
  mediaType: 'application/pdf' as const,
  byteSize: 20,
  contentHash: hash,
};
function fixture(
  options: {
    absent?: boolean;
    alive?: boolean;
    revision?: number;
    suppressed?: boolean;
    valid?: boolean;
    missingObject?: boolean;
    wrongVersion?: boolean;
    malformed?: boolean;
    changedHash?: boolean;
  } = {},
) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic-athlete',
    async query(sql, values = []) {
      calls.push({ sql, values });
      expect(values[0]).toBe(tx.athleteId);
      expect(sql).toContain('athlete_id=$1');
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
      if (sql.includes('FOR SHARE')) {
        const rows = options.absent
          ? []
          : [
              {
                id: values[1],
                access_revision: options.revision ?? 1,
                alive: options.alive ?? true,
              },
            ];
        return { rows, rowCount: rows.length };
      }
      const isPdf = sql.includes('public.resource r');
      const rows = options.missingObject
        ? []
        : [
            {
              id: values[1],
              version_id: isPdf ? (options.wrongVersion ? otherVersion : values[2]) : null,
              media_type: isPdf ? 'application/pdf' : 'image/png',
              size_bytes: options.malformed ? '9007199254740993' : isPdf ? '20' : '10',
              content_hash: options.changedHash ? 'b'.repeat(64) : hash,
              valid: options.valid ?? true,
              suppressed: options.suppressed ?? false,
            },
          ];
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, calls };
}
describe('race result proof internal preparation (query-port units, not actual PG)', () => {
  it('locks all owned parents canonically before exact descriptor reads and preserves input order', async () => {
    const { tx, calls } = fixture();
    expect(
      await prepareRaceResultProofs(tx, {
        link: 'https://example.test/result',
        attachments: [pdf, image],
      }),
    ).toEqual({ link: 'https://example.test/result', attachments: [storedPdf, storedImage] });
    expect(calls.map((call) => call.sql.includes('FOR SHARE'))).toEqual([true, true, false, false]);
    expect(calls.slice(0, 2).map((call) => call.values[1])).toEqual([imageId, resourceId]);
    expect(calls[2]?.values[2]).toBe(versionId);
    expect(calls[2]?.sql).not.toContain('current_version_id');
  });
  it('checks immutable object consistency and durable deletion suppression in actual query shape', async () => {
    const { tx, calls } = fixture();
    await prepareRaceResultProofs(tx, { link: null, attachments: [image, pdf] });
    const descriptors = calls.slice(2).map((call) => call.sql);
    for (const sql of descriptors) {
      expect(sql).toContain('public.race_result_proof_source_suppressed($1::text,');
      expect(sql).not.toContain('restore_suppression_event');
      expect(sql).toContain('o.content_hash=');
      expect(sql).toContain('o.size_bytes=');
    }
    expect(descriptors[1]).toContain("v.content_status='raw_stored'");
    expect(descriptors[1]).toContain('v.version_id=$3');
  });
  it.each([
    { absent: true },
    { alive: false },
    { suppressed: true },
    { valid: false },
    { missingObject: true },
  ])('rejects missing/foreign/deleted/staged/suppressed source: %j', async (options) => {
    const { tx } = fixture(options);
    await expect(
      prepareRaceResultProofs(tx, { link: null, attachments: [image] }),
    ).rejects.toMatchObject({ code: 'PROOF_UNAVAILABLE' });
  });
  it('checks live access revision before reading the source body', async () => {
    const { tx, calls } = fixture({ revision: 2 });
    await expect(
      prepareRaceResultProofs(tx, { link: null, attachments: [pdf] }),
    ).rejects.toMatchObject({ code: 'STALE_PROOF_ACCESS' });
    expect(calls).toHaveLength(1);
  });
  it.each([{ wrongVersion: true }, { malformed: true }])(
    'rejects forged exact version/invalid bounded scalar source: %j',
    async (options) => {
      await expect(
        prepareRaceResultProofs(fixture(options).tx, { link: null, attachments: [pdf] }),
      ).rejects.toMatchObject({ code: 'INVALID_PROOF_SOURCE' });
    },
  );
  it.each([
    { link: null, attachments: [image, image] },
    { link: null, attachments: [pdf, { ...pdf, versionId: otherVersion }] },
    { link: null, attachments: [{ ...image, mediaItemId: imageId.toUpperCase() }] },
    { link: null, attachments: [storedImage] },
    {
      link: null,
      attachments: [{ kind: image.kind, mediaItemId: imageId, status: 'unavailable' }],
    },
    { link: 'https://example.test/' + 'a'.repeat(17000), attachments: [] },
    { link: null, attachments: [], verifiedAt: '2026-10-07T00:00:00Z' },
  ])(
    'rejects untrusted duplicate/alias/descriptor/oversized input before querying',
    async (proofs) => {
      const { tx, calls } = fixture();
      await expect(prepareRaceResultProofs(tx, proofs)).rejects.toMatchObject({
        code: 'INVALID_PROOFS',
      });
      expect(calls).toHaveLength(0);
    },
  );
  it('preserves saved descriptors after harmless live access/metadata revision without repinning', async () => {
    const proofs = { link: null, attachments: [storedPdf, storedImage] },
      bytes = JSON.stringify(proofs);
    expect(await projectRaceResultProofsIn(fixture({ revision: 8 }).tx, proofs)).toEqual({
      link: null,
      attachments: [
        { ...storedPdf, status: 'available' },
        { ...storedImage, status: 'available' },
      ],
    });
    expect(JSON.stringify(proofs)).toBe(bytes);
  });
  it.each([
    { absent: true },
    { alive: false },
    { suppressed: true },
    { missingObject: true },
    { changedHash: true },
  ])('returns no copied metadata when exact source is unavailable: %j', async (options) => {
    expect(
      await projectRaceResultProofsIn(fixture(options).tx, {
        link: null,
        attachments: [storedPdf],
      }),
    ).toEqual({
      link: null,
      attachments: [{ kind: pdf.kind, resourceId, versionId, status: 'unavailable' }],
    });
  });
  it('does not treat a regressed source access head as current stored provenance', async () => {
    const { tx, calls } = fixture({ revision: 1 });
    expect(
      await projectRaceResultProofsIn(tx, {
        link: null,
        attachments: [{ ...storedPdf, accessRevision: 2 }],
      }),
    ).toEqual({
      link: null,
      attachments: [{ kind: pdf.kind, resourceId, versionId, status: 'unavailable' }],
    });
    expect(calls).toHaveLength(1);
  });
  it('propagates query failure without opening, committing or claiming a prepared result', async () => {
    const failure = new Error('synthetic-query-failure');
    const tx: Transaction = {
      athleteId: 'synthetic-athlete',
      async query() {
        throw failure;
      },
    };
    await expect(prepareRaceResultProofs(tx, { link: null, attachments: [image] })).rejects.toBe(
      failure,
    );
  });
  it('never resolves a storage-redacted identity again even if a live source exists', async () => {
    const { tx, calls } = fixture();
    const proofs = {
      link: null,
      attachments: [{ kind: image.kind, mediaItemId: imageId, status: 'unavailable' }],
    };
    expect(await projectRaceResultProofsIn(tx, proofs)).toEqual(proofs);
    expect(calls).toHaveLength(0);
  });
  it('rejects unavailable rows retaining copied metadata before querying', async () => {
    const { tx, calls } = fixture();
    await expect(
      projectRaceResultProofsIn(tx, {
        link: null,
        attachments: [{ ...storedImage, status: 'unavailable' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROOFS' });
    expect(calls).toHaveLength(0);
  });
  it('retains a link-only proof without fetching it or touching the DB', async () => {
    const { tx, calls } = fixture();
    const proofs = { link: 'https://example.test/result', attachments: [] };
    expect(await prepareRaceResultProofs(tx, proofs)).toEqual(proofs);
    expect(calls).toHaveLength(0);
  });
});
