import { expect, it } from 'vitest';
import { galleryMediaItemSchema, GALLERY_VIDEO_MAX_BYTES } from '@workout/contracts/gallery';
import {
  impactDependencyDigest,
  RaceImpactDependencyError,
} from '../src/race-plan-impact-dependencies.js';

import type { Transaction } from '../src/database.js';
import { raceMediaCleanupSourceSchema } from '../src/race-media-cleanup-source.js';
import {
  captureMediaRetainedReadFacts,
  mediaRetainedReadFactsSchema,
  validateMediaRetainedReadFacts,
} from '../src/race-plan-impact-media-read-facts.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hash = 'a'.repeat(64);
const objectRef = `private/v1/tenants/${other}/gallery/${id}/objects/uploads/${other}/sha256/${hash}.png`;
const item = galleryMediaItemSchema.parse({
  id,
  mediaKind: 'image',
  visibility: 'private',
  includeForCoach: false,
  album: null,
  caption: null,
  activityId: null,
  capturedAt: null,
  capturedLocalDate: null,
  file: { originalFileName: '원본.png', mediaType: 'image/png', byteSize: 12, sha256: hash },
  preview: null,
  accessRevision: 1,
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
});
const ledger = { sha256: hash, byteSize: 12, mediaType: 'image/png' };
const cleanupSource = raceMediaCleanupSourceSchema.parse({
  schemaVersion: 1,
  authority: 'db_cleanup_status_only',
  mediaItemId: id,
  expectedAccessRevision: 1,
  observedAccessRevision: 1,
  deleted: false,
  inventoryComplete: true,
  state: 'absent',
  reason: null,
  refs: [{ digest: '1'.repeat(64), reason: null, state: 'absent' }],
  digestVersion: 'postgres-jsonb-v1',
  sourceDigest: '2'.repeat(64),
});
const scalar = { id, access_revision: 1, deleted: false, bytes: '2048', derivatives: 0 };
const body = {
  record: item,
  original_ledger: ledger,
  original_object_ref: objectRef,
  preview_ledger: null,
};
function harness(
  replies: Record<string, unknown>[][] = [
    [scalar],
    [{ available: true }],
    [{ source: cleanupSource }],
    [body],
  ],
) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'owner',
    async query(sql, values) {
      calls.push({ sql, values });
      const rows = replies.shift();
      if (!rows) throw Error('unexpected query');
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, calls, budget: { bytes: 0n, sources: 0 } };
}
function projection() {
  return mediaRetainedReadFactsSchema.parse({
    requestedIds: [id],
    facts: [
      {
        requestedId: id,
        state: 'owned',
        reason: null,
        record: item,
        current: { mediaItemId: id, accessRevision: 1, deleted: false },
        originalLedger: ledger,
        originalObjectIdentityDigest: impactDependencyDigest(objectRef),
        previewLedger: null,
        cleanup: { status: 'available', source: cleanupSource },
      },
    ],
    authority: 'none',
    freshness: 'not_checked',
    sourceScope: 'db_recorded_descriptor_only',
  });
}
it('captures exact own current full descriptor and ledger after scalar preflight; no byte/permission authority', async () => {
  const h = harness(),
    r = await captureMediaRetainedReadFacts(h.tx, [id], h.budget);
  expect(r).toEqual(projection());
  expect(validateMediaRetainedReadFacts(r)).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
    sourceScope: 'db_recorded_descriptor_only',
  });
  expect(h.calls).toHaveLength(4);
  expect(h.calls[0]?.sql).toContain('octet_length');
  expect(h.calls[0]?.values).toEqual(['owner', id]);
  expect(h.calls[1]?.sql).toContain('has_function_privilege');
  expect(h.calls[3]?.values).toEqual(['owner', id, 1]);
  expect(JSON.stringify(r)).not.toMatch(/storage_ref|storageRef|lease|signedURL/);
  expect(r.facts[0]?.record?.capturedAt).toBeNull();
});
it('matches preview full tuple with two exact cleanup refs', async () => {
  const preview = { kind: 'preview', mediaType: 'image/png', byteSize: 3, sha256: 'b'.repeat(64) };
  const withPreview = galleryMediaItemSchema.parse({ ...item, preview, accessRevision: 2 });
  const source = raceMediaCleanupSourceSchema.parse({
    ...cleanupSource,
    expectedAccessRevision: 2,
    observedAccessRevision: 2,
    refs: [...cleanupSource.refs, { digest: '3'.repeat(64), state: 'absent', reason: null }],
  });
  const h = harness([
    [{ ...scalar, access_revision: 2, derivatives: 1 }],
    [{ available: true }],
    [{ source }],
    [
      {
        record: withPreview,
        original_ledger: ledger,
        original_object_ref: objectRef,
        preview_ledger: { mediaType: preview.mediaType, byteSize: 3, sha256: preview.sha256 },
      },
    ],
  ]);
  expect(
    validateMediaRetainedReadFacts(await captureMediaRetainedReadFacts(h.tx, [id], h.budget))
      .status,
  ).toBe('validated_read_sources');
});
it('returns deleted nullbody and exact pending DB cleanup, still blocked for consumed read', async () => {
  const source = raceMediaCleanupSourceSchema.parse({
    ...cleanupSource,
    expectedAccessRevision: 2,
    observedAccessRevision: 2,
    deleted: true,
    state: 'pending',
    refs: [{ digest: '1'.repeat(64), state: 'pending', reason: 'resource_deleted' }],
  });
  const h = harness([
      [{ ...scalar, deleted: true, access_revision: 2, bytes: '0' }],
      [{ available: true }],
      [{ source }],
    ]),
    r = await captureMediaRetainedReadFacts(h.tx, [id], h.budget);
  expect(h.calls).toHaveLength(3);
  expect(r.facts[0]).toMatchObject({
    state: 'deleted',
    record: null,
    originalLedger: null,
    current: { deleted: true, accessRevision: 2 },
  });
  expect(validateMediaRetainedReadFacts(r).blockers).toContainEqual({
    path: 'facts[0]',
    reason: 'source_deleted',
  });
});
it('does not invent identity for absent or foreign requested media', async () => {
  const h = harness([[]]),
    r = await captureMediaRetainedReadFacts(h.tx, [id], h.budget);
  expect(r.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'owned_media_unavailable',
    current: null,
    record: null,
    cleanup: null,
  });
  expect(h.calls).toHaveLength(1);
});
it('preserves opaque media refs as unavailable without UUID query', async () => {
  const h = harness([]),
    r = await captureMediaRetainedReadFacts(h.tx, ['opaque-media'], h.budget);
  expect(r.requestedIds).toEqual(['opaque-media']);
  expect(h.calls).toHaveLength(0);
  expect(validateMediaRetainedReadFacts(r).status).toBe('blocked');
});
it('normalizes case and counts visits before cache dedup', async () => {
  const h = harness(),
    r = await captureMediaRetainedReadFacts(h.tx, [id.toUpperCase(), id], h.budget);
  expect(r.requestedIds).toEqual([id]);
  expect(h.budget.sources).toBe(3);
  expect(h.calls).toHaveLength(4);
});
it('missing narrow function/EXECUTE produces honest unavailable cleanup without failing query', async () => {
  const h = harness([[scalar], [{ available: false }], [body]]),
    r = await captureMediaRetainedReadFacts(h.tx, [id], h.budget);
  expect(h.calls).toHaveLength(3);
  expect(r.facts[0]?.cleanup).toEqual({
    status: 'unavailable',
    reason: 'READ_CAPABILITY_UNAVAILABLE',
  });
  expect(validateMediaRetainedReadFacts(r).status).toBe('blocked');
});
it('unknown historical or inflight inventory is blocked while own public DTO remains factual', async () => {
  const source = raceMediaCleanupSourceSchema.parse({
    ...cleanupSource,
    inventoryComplete: false,
    state: 'unavailable',
    reason: 'INVENTORY_UNAVAILABLE',
  });
  const h = harness([[scalar], [{ available: true }], [{ source }], [body]]),
    r = await captureMediaRetainedReadFacts(h.tx, [id], h.budget);
  expect(r.facts[0]?.record).toEqual(item);
  expect(validateMediaRetainedReadFacts(r).blockers).toContainEqual({
    path: 'facts[0]',
    reason: 'INVENTORY_UNAVAILABLE',
  });
});
it('ledger absence/mismatch is explicit unavailable rather than full source', async () => {
  const h = harness([
      [scalar],
      [{ available: true }],
      [{ source: cleanupSource }],
      [{ ...body, original_ledger: { ...ledger, sha256: 'b'.repeat(64) } }],
    ]),
    r = await captureMediaRetainedReadFacts(h.tx, [id], h.budget);
  expect(r.facts[0]).toMatchObject({
    state: 'unavailable',
    reason: 'object_inventory_unavailable',
    record: null,
  });
});
it('concurrent metadata/tombstone change refuses stale body', async () => {
  const h = harness([[scalar], [{ available: true }], [{ source: cleanupSource }], []]);
  await expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget)).rejects.toThrow(
    'SOURCE_UNAVAILABLE',
  );
});
it('propagates SQL caller/fence error for outer rollback', async () => {
  const h = harness([[scalar]]),
    base = h.tx.query;
  h.tx.query = async (sql, values) => {
    if (sql.includes('has_function_privilege')) throw Error('42501 caller fence');
    return base(sql, values);
  };
  await expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget)).rejects.toThrow('42501');
});
it('5001 visited count fails before any query', async () => {
  const h = harness();
  h.budget.sources = 5000;
  await expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget)).rejects.toThrow(
    'CONTEXT_UNAVAILABLE',
  );
  expect(h.calls).toHaveLength(0);
});
it('shared byte cap refuses cleanup and DTO transport after scalar', async () => {
  const h = harness([[scalar]]);
  h.budget.bytes = 4190000n;
  await expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget)).rejects.toThrow(
    'CONTEXT_UNAVAILABLE',
  );
  expect(h.calls).toHaveLength(1);
});
it.each([{ bytes: '16385' }, { derivatives: 2 }])(
  'finite body preflight %j fails before cleanup/body',
  (change) => {
    const h = harness([[{ ...scalar, ...change }]]);
    return expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget))
      .rejects.toThrow('CONTEXT_UNAVAILABLE')
      .then(() => expect(h.calls).toHaveLength(1));
  },
);
it('crosswired source row rejects', async () => {
  const h = harness([[{ ...scalar, id: other }]]);
  await expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget)).rejects.toThrow(
    'INVALID_CONTEXT',
  );
});
it('old expected access revision is not a historical DTO proof', () => {
  const p = projection(),
    f = p.facts[0];
  if (!f || !f.current) throw Error('fixture');
  f.current.accessRevision = 2;
  expect(validateMediaRetainedReadFacts(p).status).toBe('blocked');
});
it.each([
  (p: ReturnType<typeof projection>) => ({ ...p, extra: true }),
  (p: ReturnType<typeof projection>) => ({ ...p, authority: 'verified' }),
  (p: ReturnType<typeof projection>) => ({ ...p, sourceScope: 'actual_binary_bytes' }),
  (p: ReturnType<typeof projection>) => ({ ...p, facts: [] }),
  (p: ReturnType<typeof projection>) => ({ ...p, requestedIds: [id, id.toUpperCase()] }),
  (p: ReturnType<typeof projection>) => ({ ...p, facts: [...p.facts, ...p.facts] }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({ ...f, current: { ...f.current, mediaItemId: other } })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({ ...f, record: { ...item, file: { ...item.file, byteSize: 0 } } })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({ ...f, record: { ...item, includeForCoach: true } })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({
      ...f,
      record: {
        ...item,
        preview: { kind: 'preview', mediaType: 'image/png', byteSize: 1, sha256: hash },
      },
    })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({ ...f, originalLedger: { ...ledger, mediaType: 'image/jpeg' } })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({
      ...f,
      cleanup: { status: 'available', source: { ...cleanupSource, mediaItemId: other } },
    })),
  }),
  (p: ReturnType<typeof projection>) => ({
    ...p,
    facts: p.facts.map((f) => ({
      ...f,
      cleanup: { status: 'available', source: { ...cleanupSource, refs: [] } },
    })),
  }),
])('rejects malformed/unknown correspondence %i', (change) => {
  expect(validateMediaRetainedReadFacts(change(projection())).status).toBe('blocked');
});
it('empty scoped portion is valid descriptor scope only', () => {
  expect(
    validateMediaRetainedReadFacts({ ...projection(), requestedIds: [], facts: [] }),
  ).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
  });
});
it('rejects cyclic and oversized unknown boundary', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(validateMediaRetainedReadFacts(circular).status).toBe('blocked');
  expect(validateMediaRetainedReadFacts({ x: 'x'.repeat(4194305) }).status).toBe('blocked');
});

it.each([
  { ...scalar, bytes: null },
  { ...scalar, extra: 'unknown' },
  { ...scalar, access_revision: 0 },
])('malformed stored scalar returns stable dependency error %j', async (row) => {
  const h = harness([[row]]);
  await expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget)).rejects.toBeInstanceOf(
    RaceImpactDependencyError,
  );
  expect(h.calls).toHaveLength(1);
});
it.each([
  { ...body, extra: true },
  { ...body, record: { ...item, file: { ...item.file, byteSize: 0 } } },
])('malformed stored full body returns stable dependency error %j', async (row) => {
  const h = harness([[scalar], [{ available: true }], [{ source: cleanupSource }], [row]]);
  await expect(captureMediaRetainedReadFacts(h.tx, [id], h.budget)).rejects.toMatchObject({
    code: 'INVALID_CONTEXT',
  });
});
it('uses actual public video maximum while retaining exact immutable tuple correspondence', async () => {
  const record = galleryMediaItemSchema.parse({
    ...item,
    mediaKind: 'video',
    file: {
      originalFileName: 'video.mp4',
      mediaType: 'video/mp4',
      byteSize: GALLERY_VIDEO_MAX_BYTES,
      sha256: hash,
    },
  });
  const h = harness([
    [scalar],
    [{ available: true }],
    [{ source: cleanupSource }],
    [
      {
        record,
        original_object_ref: objectRef,
        original_ledger: {
          mediaType: 'video/mp4',
          byteSize: GALLERY_VIDEO_MAX_BYTES,
          sha256: hash,
        },
        preview_ledger: null,
      },
    ],
  ]);
  expect(
    validateMediaRetainedReadFacts(await captureMediaRetainedReadFacts(h.tx, [id], h.budget))
      .status,
  ).toBe('validated_read_sources');
});

it('captures original object fingerprint in the dependency namespace, independently of SQL113 ref digest', async () => {
  const h = harness(),
    result = await captureMediaRetainedReadFacts(h.tx, [id], h.budget);
  expect(result.facts[0]?.originalObjectIdentityDigest).toBe(impactDependencyDigest(objectRef));
  expect(result.facts[0]?.originalObjectIdentityDigest).not.toBe(cleanupSource.refs[0]?.digest);
  expect(JSON.stringify(result)).not.toContain(objectRef);
});
it.each([null, 'unknown', 'A'.repeat(64)])(
  'rejects missing/malformed object identity digest %j',
  (fingerprint) => {
    const p = projection();
    expect(
      validateMediaRetainedReadFacts({
        ...p,
        facts: p.facts.map((f) => ({ ...f, originalObjectIdentityDigest: fingerprint })),
      }).status,
    ).toBe('blocked');
  },
);
