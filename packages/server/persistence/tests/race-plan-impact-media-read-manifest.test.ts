import { expect, it } from 'vitest';
import { galleryMediaItemSchema } from '@workout/contracts/gallery';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { raceMediaCleanupSourceSchema } from '../src/race-media-cleanup-source.js';
import {
  mediaReadManifestProjectionSchema,
  validateMediaReadManifest,
  type MediaReadManifestProjection,
} from '../src/race-plan-impact-media-read-manifest.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const hash = 'a'.repeat(64),
  locatorDigest = impactDependencyDigest('synthetic-object');
function fixture(preview = false): MediaReadManifestProjection {
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
    file: { originalFileName: '합성.png', mediaType: 'image/png', byteSize: 12, sha256: hash },
    preview: preview
      ? { kind: 'preview', mediaType: 'image/png', byteSize: 3, sha256: 'b'.repeat(64) }
      : null,
    accessRevision: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
  });
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
      { digest: '1'.repeat(64), reason: null, state: 'absent' },
      ...(preview ? [{ digest: '3'.repeat(64), reason: null, state: 'absent' }] : []),
    ],
    digestVersion: 'postgres-jsonb-v1',
    sourceDigest: '2'.repeat(64),
  });
  return mediaReadManifestProjectionSchema.parse({
    requestedIds: [id],
    metadata: [
      {
        requestedId: id,
        state: 'owned',
        accessRevision: 1,
        visibility: 'private',
        includeForCoach: false,
        content: {
          kind: 'image',
          objectIdentity: { state: 'present', contentHash: hash, idDigest: locatorDigest },
          contentHash: hash,
          previewPresent: preview,
        },
        cleanup,
      },
    ],
    sourceFacts: {
      requestedIds: [id],
      facts: [
        {
          requestedId: id,
          state: 'owned',
          reason: null,
          record: item,
          current: { mediaItemId: id, accessRevision: 1, deleted: false },
          originalLedger: { sha256: hash, byteSize: 12, mediaType: 'image/png' },
          originalObjectIdentityDigest: locatorDigest,
          previewLedger: item.preview
            ? {
                sha256: item.preview.sha256,
                byteSize: item.preview.byteSize,
                mediaType: item.preview.mediaType,
              }
            : null,
          cleanup: { status: 'available', source: cleanup },
        },
      ],
      authority: 'none',
      freshness: 'not_checked',
      sourceScope: 'db_recorded_descriptor_only',
    },
  });
}
function rows(c: MediaReadManifestProjection) {
  const row = c.metadata[0],
    source = c.sourceFacts,
    fact = source?.facts[0];
  if (
    !row ||
    row.state !== 'owned' ||
    row.content.objectIdentity.state !== 'present' ||
    !source ||
    !fact ||
    !fact.record ||
    !fact.current ||
    !fact.originalLedger ||
    !fact.cleanup ||
    fact.cleanup.status !== 'available'
  )
    throw new Error('Fixture incomplete');
  return {
    row,
    identity: row.content.objectIdentity,
    source,
    fact,
    body: fact.record,
    current: fact.current,
    ledger: fact.originalLedger,
    cleanup: fact.cleanup.source,
  };
}
const reasons = (input: unknown) => validateMediaReadManifest(input).blockers.map((b) => b.reason);
for (const preview of [false, true])
  it(`validates exact retained ${preview ? 'original+preview' : 'original'} descriptors without byte/permission authority`, () => {
    const c = fixture(preview),
      copy = structuredClone(c);
    expect(validateMediaReadManifest(c)).toMatchObject({
      status: 'validated_read_sources',
      authority: 'none',
      freshness: 'not_checked',
      complete: false,
      sourceScope: 'db_recorded_descriptor_only',
      blockers: [],
    });
    expect(c).toEqual(copy);
    expect(JSON.stringify(c)).not.toMatch(/storage_ref|storageRef|synthetic-object/);
    expect(rows(c).identity.idDigest).not.toBe(rows(c).cleanup.refs[0]?.digest);
    expect(rows(c).body.capturedAt).toBeNull();
  });
it('validates video public descriptor and preserves null metadata', () => {
  const c = fixture(),
    { row, body, ledger } = rows(c);
  row.content.kind = 'video';
  body.mediaKind = 'video';
  body.file.mediaType = 'video/mp4';
  ledger.mediaType = 'video/mp4';
  expect(validateMediaReadManifest(c).status).toBe('validated_read_sources');
});
it('accepts empty consumption without source port', () => {
  expect(validateMediaReadManifest({ requestedIds: [], metadata: [] })).toMatchObject({
    status: 'validated_read_sources',
    authority: 'none',
  });
});
it('requires actual source port for nonempty metadata', () => {
  const c = fixture();
  delete c.sourceFacts;
  expect(reasons(c)).toContain('source_port_missing');
});
it('dedups normalized UUID consumer requests but retains visit limits and input bytes', () => {
  const c = fixture(),
    copy = structuredClone(c);
  c.requestedIds.push(id.toUpperCase());
  const result = validateMediaReadManifest(c);
  expect(result.status).toBe('validated_read_sources');
  expect(c.metadata).toEqual(copy.metadata);
  expect(c.requestedIds).toEqual([id, id.toUpperCase()]);
});
it('normalizes UUID fact/body/current identities without SQL casting opaque IDs', () => {
  const c = fixture(),
    { row, fact, body, current, source } = rows(c);
  c.requestedIds = [id.toUpperCase()];
  row.requestedId = id.toUpperCase();
  fact.requestedId = id.toUpperCase();
  source.requestedIds = [id.toUpperCase()];
  body.id = id.toUpperCase();
  current.mediaItemId = id.toUpperCase();
  expect(validateMediaReadManifest(c).status).toBe('validated_read_sources');
});
for (const target of ['metadata', 'facts', 'sourceRequests'] as const)
  it(`rejects duplicate ${target}`, () => {
    const c = fixture(),
      { row, fact, source } = rows(c);
    if (target === 'metadata') c.metadata.push(structuredClone(row));
    else if (target === 'facts') source.facts.push(structuredClone(fact));
    else source.requestedIds.push(id.toUpperCase());
    expect(validateMediaReadManifest(c).status).toBe('blocked');
  });
for (const target of ['metadata', 'facts', 'sourceRequests'] as const)
  it(`rejects missing ${target}`, () => {
    const c = fixture(),
      { source } = rows(c);
    if (target === 'metadata') c.metadata = [];
    else if (target === 'facts') source.facts = [];
    else source.requestedIds = [];
    expect(reasons(c)).toContain('source_unavailable');
  });
for (const target of ['metadata', 'facts'] as const)
  it(`rejects unused ${target}`, () => {
    const c = fixture(),
      { row, fact, source } = rows(c);
    if (target === 'metadata') {
      const extra = structuredClone(row);
      extra.requestedId = other;
      c.metadata.push(extra);
    } else {
      const extra = structuredClone(fact);
      extra.requestedId = other;
      source.facts.push(extra);
      source.requestedIds.push(other);
    }
    expect(reasons(c)).toContain('unused_source');
  });
for (const [name, mutate, reason] of [
  [
    'fingerprint',
    (c: MediaReadManifestProjection) => {
      rows(c).identity.idDigest = 'f'.repeat(64);
    },
    'source_digest_mismatch',
  ],
  [
    'contenthash',
    (c: MediaReadManifestProjection) => {
      rows(c).row.content.contentHash = 'f'.repeat(64);
    },
    'source_digest_mismatch',
  ],
  [
    'objecthash',
    (c: MediaReadManifestProjection) => {
      rows(c).identity.contentHash = 'f'.repeat(64);
    },
    'source_digest_mismatch',
  ],
  [
    'metadata revision',
    (c: MediaReadManifestProjection) => {
      rows(c).row.accessRevision = 2;
    },
    'source_identity_mismatch',
  ],
  [
    'body revision',
    (c: MediaReadManifestProjection) => {
      rows(c).body.accessRevision = 2;
    },
    'source_identity_mismatch',
  ],
  [
    'foreign current',
    (c: MediaReadManifestProjection) => {
      rows(c).current.mediaItemId = other;
    },
    'source_identity_mismatch',
  ],
  [
    'foreign body',
    (c: MediaReadManifestProjection) => {
      rows(c).body.id = other;
    },
    'source_identity_mismatch',
  ],
  [
    'previewpresent',
    (c: MediaReadManifestProjection) => {
      rows(c).row.content.previewPresent = true;
    },
    'source_identity_mismatch',
  ],
  [
    'mediakind',
    (c: MediaReadManifestProjection) => {
      rows(c).row.content.kind = 'video';
    },
    'source_identity_mismatch',
  ],
  [
    'ledgerhash',
    (c: MediaReadManifestProjection) => {
      rows(c).ledger.sha256 = 'f'.repeat(64);
    },
    'source_identity_mismatch',
  ],
  [
    'ledgerbytes',
    (c: MediaReadManifestProjection) => {
      rows(c).ledger.byteSize = 13;
    },
    'source_identity_mismatch',
  ],
  [
    'cleanupdigest',
    (c: MediaReadManifestProjection) => {
      const { row } = rows(c);
      if ('schemaVersion' in row.cleanup) row.cleanup.sourceDigest = 'f'.repeat(64);
    },
    'cleanup_mismatch',
  ],
  [
    'cleanuprefs',
    (c: MediaReadManifestProjection) => {
      const { row } = rows(c);
      if ('schemaVersion' in row.cleanup) {
        const ref = row.cleanup.refs[0];
        if (ref) ref.digest = 'f'.repeat(64);
      }
    },
    'cleanup_mismatch',
  ],
  [
    'cleanuprevision',
    (c: MediaReadManifestProjection) => {
      rows(c).cleanup.observedAccessRevision = 2;
    },
    'invalid_projection',
  ],
  [
    'missingfingerprint',
    (c: MediaReadManifestProjection) => {
      rows(c).fact.originalObjectIdentityDigest = null;
    },
    'object_identity_port_missing',
  ],
] as const)
  it(`blocks altered ${name}`, () => {
    const c = fixture();
    mutate(c);
    expect(reasons(c)).toContain(reason);
  });
it('rejects cleanup SQL ref hash being substituted for semantic locator fingerprint', () => {
  const c = fixture(),
    { identity, cleanup } = rows(c);
  identity.idDigest = cleanup.refs[0]?.digest ?? '';
  expect(reasons(c)).toContain('source_digest_mismatch');
});
it('blocks pending cleanup for a live source', () => {
  const c = fixture(),
    { cleanup } = rows(c);
  cleanup.deleted = true;
  cleanup.state = 'pending';
  cleanup.refs = cleanup.refs.map((r) => ({ ...r, reason: 'resource_deleted', state: 'pending' }));
  expect(validateMediaReadManifest(c).status).toBe('blocked');
});
it('blocks missing cleanup capability and matches no inferred permission', () => {
  const c = fixture(),
    { row, fact } = rows(c);
  row.cleanup = { state: 'unavailable', reason: 'READ_CAPABILITY_UNAVAILABLE' };
  fact.cleanup = { status: 'unavailable', reason: 'READ_CAPABILITY_UNAVAILABLE' };
  expect(reasons(c)).toContain('source_unavailable');
});
it('blocks deleted nullbody and actual pending cleanup without resurrecting descriptors', () => {
  const c = fixture(),
    { row, source, cleanup } = rows(c);
  cleanup.deleted = true;
  cleanup.state = 'pending';
  cleanup.refs = cleanup.refs.map((r) => ({ ...r, reason: 'resource_deleted', state: 'pending' }));
  c.metadata = [
    {
      requestedId: id,
      state: 'deleted',
      accessRevision: 1,
      visibility: 'private',
      includeForCoach: false,
      content: null,
      cleanup,
    },
  ];
  source.facts = [
    {
      requestedId: id,
      state: 'deleted',
      reason: null,
      record: null,
      current: { mediaItemId: id, accessRevision: 1, deleted: true },
      originalLedger: null,
      originalObjectIdentityDigest: null,
      previewLedger: null,
      cleanup: { status: 'available', source: cleanup },
    },
  ];
  expect(reasons(c)).toContain('source_deleted');
  expect(row.content.contentHash).toBe(hash);
  expect(source.facts[0]?.record).toBeNull();
});
it('blocks unavailable opaque IDs with no manufactured source tuple', () => {
  const opaque = 'opaque:Case/not-a-uuid';
  const c = {
    requestedIds: [opaque],
    metadata: [{ requestedId: opaque, state: 'unavailable', content: null }],
    sourceFacts: {
      requestedIds: [opaque],
      facts: [
        {
          requestedId: opaque,
          state: 'unavailable',
          reason: 'owned_media_unavailable',
          record: null,
          current: null,
          originalLedger: null,
          originalObjectIdentityDigest: null,
          previewLedger: null,
          cleanup: null,
        },
      ],
      authority: 'none',
      freshness: 'not_checked',
      sourceScope: 'db_recorded_descriptor_only',
    },
  };
  expect(reasons(c)).toContain('source_unavailable');
  expect(reasons({ ...c, requestedIds: ['opaque:case/not-a-uuid'] })).toContain('unused_source');
});
for (const extra of ['manualPermission', 'verifiedBytes', 'storage_ref'] as const)
  it(`rejects unknown ${extra}`, () => {
    expect(reasons({ ...fixture(), [extra]: true })).toContain('invalid_projection');
  });
it('rejects unknown metadata keys', () => {
  const c = fixture(),
    { row } = rows(c);
  expect(reasons({ ...c, metadata: [{ ...row, ownerVerified: true }] })).toContain(
    'invalid_projection',
  );
});
it('counts duplicate consumed visits before roster dedup', () => {
  const c = fixture();
  c.requestedIds = Array.from({ length: 4999 }, () => id);
  expect(validateMediaReadManifest(c).status).toBe('validated_read_sources');
  c.requestedIds.push(id);
  expect(reasons(c)).toContain('bounds_exceeded');
});
it('enforces 4MiB UTF8 and opaque ID length limits', () => {
  expect(reasons({ ...fixture(), extra: '원'.repeat(1400000) })).toContain('bounds_exceeded');
  expect(reasons({ ...fixture(), requestedIds: ['x'.repeat(201)] })).toContain(
    'invalid_projection',
  );
});
it('still checks deleted current revision and cleanup tuple while blocking consumed deletion', () => {
  const c = fixture(),
    { source, cleanup } = rows(c);
  cleanup.deleted = true;
  cleanup.state = 'pending';
  cleanup.refs = cleanup.refs.map((r) => ({ ...r, reason: 'resource_deleted', state: 'pending' }));
  c.metadata = [
    {
      requestedId: id,
      state: 'deleted',
      accessRevision: 2,
      visibility: 'private',
      includeForCoach: false,
      content: null,
      cleanup: { ...cleanup, sourceDigest: 'f'.repeat(64) },
    },
  ];
  source.facts = [
    {
      requestedId: id,
      state: 'deleted',
      reason: null,
      record: null,
      current: { mediaItemId: id, accessRevision: 1, deleted: true },
      originalLedger: null,
      originalObjectIdentityDigest: null,
      previewLedger: null,
      cleanup: { status: 'available', source: cleanup },
    },
  ];
  expect(reasons(c)).toEqual(
    expect.arrayContaining(['source_deleted', 'source_identity_mismatch', 'cleanup_mismatch']),
  );
});
it('rejects wrong preview descriptor tuple despite matching preview presence metadata', () => {
  const c = fixture(true),
    { fact } = rows(c);
  if (!fact.previewLedger) throw new Error('No preview');
  fact.previewLedger.byteSize = 4;
  expect(reasons(c)).toContain('source_identity_mismatch');
});
