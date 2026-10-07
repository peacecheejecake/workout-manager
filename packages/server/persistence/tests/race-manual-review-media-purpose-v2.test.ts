import { raceMediaCleanupSourceSchema } from '../src/race-media-cleanup-source.js';
import { expect, it } from 'vitest';
import { galleryMediaItemSchema } from '@workout/contracts/gallery';
import {
  captureRaceManualMediaPurposeV2In,
  raceManualMediaPurposeObservationV2Schema,
} from '../src/race-manual-review-media-purpose-v2.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import type { Transaction } from '../src/database.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(preview = false) {
  const locator = `private/v1/tenants/${id}/gallery/${id}/objects/uploads/${id}/sha256/${'a'.repeat(64)}.png`;
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
    file: {
      originalFileName: 'synthetic.png',
      mediaType: 'image/png',
      byteSize: 2,
      sha256: 'a'.repeat(64),
    },
    preview: preview
      ? { kind: 'preview', mediaType: 'image/jpeg', byteSize: 2, sha256: 'b'.repeat(64) }
      : null,
    accessRevision: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
  });
  const consent = { kind: 'media', granted: true, revision: 1 };
  const scalar = {
    id,
    access_revision: 1,
    deleted: false,
    bytes: '2048',
    derivatives: preview ? 1 : 0,
  };
  const cleanup = raceMediaCleanupSourceSchema.parse({
    schemaVersion: 1,
    authority: 'db_cleanup_status_only',
    mediaItemId: id,
    expectedAccessRevision: 1,
    observedAccessRevision: 1,
    deleted: false,
    inventoryComplete: true,
    state: 'absent',
    reason: null,
    refs: [
      { digest: 'c'.repeat(64), reason: null, state: 'absent' },
      ...(preview ? [{ digest: 'd'.repeat(64), reason: null, state: 'absent' }] : []),
    ],
    digestVersion: 'postgres-jsonb-v1',
    sourceDigest: 'e'.repeat(64),
  });
  const body = {
    record: item,
    original_ledger: { sha256: 'a'.repeat(64), byteSize: 2, mediaType: 'image/png' },
    original_object_ref: locator,
    preview_ledger: preview
      ? { sha256: 'b'.repeat(64), byteSize: 2, mediaType: 'image/jpeg' }
      : null,
  };
  const replies: Record<string, unknown>[][] = [
    [consent],
    [scalar],
    [{ available: true }],
    [{ source: cleanup }],
    [body],
  ];
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'synthetic-owner',
    async query(sql, values) {
      calls.push({ sql, values });
      const rows = replies.shift();
      if (!rows) throw Error('UNEXPECTED_QUERY');
      return { rows, rowCount: rows.length };
    },
  };
  const request = {
    mediaItemId: id,
    expectedAccessRevision: 1,
    expectedDescriptorDigest: impactDependencyDigest(item),
    expectedObjectIdentityDigest: impactDependencyDigest(locator),
  };
  return {
    tx,
    calls,
    replies,
    consent,
    scalar,
    cleanup,
    body,
    request,
    budget: { bytes: 0n, sources: 0 },
  };
}
it.each([false, true])(
  'actual recorded original/preview correspondence remains none/unverified preview=%s',
  async (preview) => {
    const f = fixture(preview),
      r = await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget);
    expect(r).toMatchObject({
      status: 'observed_media_use',
      authority: 'none',
      permissionAuthority: 'none',
      sourceAuthentication: 'unverified',
      freshness: 'not_checked',
      approvalAllowed: false,
      observation: {
        mediaConsent: { kind: 'media', granted: true, revision: 1 },
        descriptorDigest: f.request.expectedDescriptorDigest,
        cleanup: { state: 'absent', digestVersion: 'postgres-jsonb-v1' },
      },
    });
    expect(JSON.stringify(r)).not.toContain(f.body.original_object_ref);
    expect(JSON.stringify(r)).not.toContain('includeForCoach');
    expect(f.calls[0]?.values).toEqual(['synthetic-owner']);
  },
);
it.each(['absent', 'false'] as const)(
  'actual individual consent %s blocks before source body',
  async (kind) => {
    const f = fixture();
    if (kind === 'absent') f.replies[0] = [];
    else f.consent.granted = false;
    expect(await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
      reason: 'media_consent_required',
      observation: null,
    });
    expect(f.calls).toHaveLength(1);
  },
);
it('normal107 missing113 capability is finite and never issues missing function SQL', async () => {
  const f = fixture();
  f.replies[2] = [{ available: false }];
  f.replies.splice(3, 1);
  expect(await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
    reason: 'media_cleanup_capability_unavailable',
  });
  expect(f.calls.some((c) => c.sql.startsWith('SELECT source FROM'))).toBe(false);
});
it.each(['revision', 'descriptor', 'fingerprint'] as const)(
  'optimistic %s tamper cannot authorize use',
  async (part) => {
    const f = fixture();
    if (part === 'revision') f.request.expectedAccessRevision++;
    else if (part === 'descriptor') f.request.expectedDescriptorDigest = 'f'.repeat(64);
    else f.request.expectedObjectIdentityDigest = 'f'.repeat(64);
    expect(await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
      reason: 'media_source_tuple_mismatch',
      observation: null,
    });
  },
);
it.each(['original', 'preview'] as const)('wrong %s ledger blocks', async (part) => {
  const f = fixture(true);
  if (part === 'original') f.body.original_ledger.sha256 = 'f'.repeat(64);
  else if (f.body.preview_ledger) f.body.preview_ledger.sha256 = 'f'.repeat(64);
  expect(await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
    status: 'blocked',
    reason: 'media_source_unavailable',
  });
});
it('foreign/absent actual row cannot be inferred from expected digest', async () => {
  const f = fixture();
  f.replies[1] = [];
  expect(await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
    reason: 'media_source_unavailable',
  });
  expect(f.calls).toHaveLength(2);
});
it('deleted source is blocked without fetching retained original body', async () => {
  const f = fixture();
  f.scalar.deleted = true;
  f.cleanup.deleted = true;
  f.cleanup.state = 'pending';
  f.cleanup.refs[0] = { digest: 'c'.repeat(64), reason: 'resource_deleted', state: 'pending' };
  expect(await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
    reason: 'media_source_deleted',
  });
  expect(f.calls).toHaveLength(4);
});
it('live source cleanup inventory failure stays unavailable', async () => {
  const f = fixture();
  f.cleanup.inventoryComplete = false;
  f.cleanup.state = 'unavailable';
  f.cleanup.reason = 'REFERENCE_PRESENT';
  expect(await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).toMatchObject({
    reason: 'media_cleanup_unavailable',
  });
});
it('malformed/unknown/accessor/large caller input fails before DB', async () => {
  for (const input of [
    { permission: true },
    '食'.repeat(1400000),
    { ...fixture().request, approved: true },
  ]) {
    const f = fixture();
    await expect(captureRaceManualMediaPurposeV2In(f.tx, input, f.budget)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  }
  const f = fixture();
  let reads = 0;
  const input = {};
  Object.defineProperty(input, 'mediaItemId', {
    enumerable: true,
    get() {
      reads++;
      return id;
    },
  });
  await expect(captureRaceManualMediaPurposeV2In(f.tx, input, f.budget)).rejects.toThrow();
  expect(reads).toBe(0);
  expect(f.calls).toHaveLength(0);
});
it('response budget is charged before body and SQL errors propagate', async () => {
  const f = fixture();
  f.budget.bytes = 4194304n;
  await expect(captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  expect(f.calls).toHaveLength(0);
  const g = fixture();
  g.tx.query = async () => {
    throw Error('42501');
  };
  await expect(captureRaceManualMediaPurposeV2In(g.tx, g.request, g.budget)).rejects.toThrow(
    '42501',
  );
});
it('observation strict codec accepts no authentication booleans', async () => {
  const f = fixture(),
    r = await captureRaceManualMediaPurposeV2In(f.tx, f.request, f.budget);
  expect(
    raceManualMediaPurposeObservationV2Schema.safeParse({ ...r.observation, verified: true })
      .success,
  ).toBe(false);
});
