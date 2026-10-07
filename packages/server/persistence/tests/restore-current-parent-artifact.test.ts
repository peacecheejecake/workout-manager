import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  CURRENT_PARENT_MAX_ROW_BYTES,
  CURRENT_PARENT_PHYSICAL_PROFILE_SHA256,
  CURRENT_PARENT_RELATIONS,
  CURRENT_PARENT_TYPED_RELATIONS,
  createCurrentParentArtifactVerifier,
  currentParentRowsSha256,
  signCurrentParentArtifact,
  type CurrentParentConfiguredIdentity,
  type VerifiedCurrentParentBytes,
} from '../src/restore-current-parent-artifact.js';
const id = (n: number) => `abcdefab-abcd-7abc-8abc-${String(n).padStart(12, '0')}`;
const athlete = id(1),
  at = '2026-10-08T01:02:03.123456Z',
  key = Buffer.alloc(32, 1),
  otherKey = Buffer.alloc(32, 2),
  sha = 'a'.repeat(64);
function rows() {
  return [
    {
      ordinal: 1,
      relation: 'consent',
      row: { athlete_id: athlete, kind: 'app', granted: true, revision: 1 },
    },
    {
      ordinal: 2,
      relation: 'identity_private.account',
      row: { athlete_id: athlete, issuer: 'https://example.invalid', subject: 'synthetic-subject' },
    },
    {
      ordinal: 3,
      relation: 'plan_head',
      row: { athlete_id: athlete, version_id: id(2), aggregate_id: id(3) },
    },
    {
      ordinal: 4,
      relation: 'resource_object',
      row: {
        athlete_id: athlete,
        storage_ref: 'opaque synthetic object',
        content_hash: sha,
        size_bytes: '9223372036854775807',
        media_type: 'application/pdf',
        created_at: at,
      },
    },
    { ordinal: 5, relation: 'tenant_erasure', row: { athlete_id: athlete, erased_at: at } },
  ];
}
function body(input = rows()) {
  return {
    artifactVersion: 1,
    profile: {
      profileVersion: 1,
      normalSchemaVersion: 107,
      explicitVersions: [108, 109, 110, 111, 112, 113, 114, 115, 116],
      rowEncoding: 'utc-microseconds-decimal-bigint-hex-bytea-v1',
      physicalProfileSha256: CURRENT_PARENT_PHYSICAL_PROFILE_SHA256,
    },
    source: {
      systemIdentifier: '18446744073709551615',
      databaseOid: 42,
      captureId: id(4),
      generationId: id(5),
      registrySha256: sha,
      catalogSha256: sha,
      baselineThroughLsn: 'A/B',
    },
    identity: {
      artifactId: id(6),
      athleteId: athlete,
      sourceKeyId: 'test_parent_key',
      sourceKeyVersion: 1,
    },
    count: input.length,
    census: CURRENT_PARENT_RELATIONS.map((relation) => ({
      relation,
      count: input.filter((row) => row.relation === relation).length,
    })),
    rowsSha256: currentParentRowsSha256(input),
    rows: input,
    sourceCapture: 'not_verified',
    sqlRowEncoding: 'not_verified',
    originalTailCoverage: 'not_authenticated',
  };
}
function configured(b = body()): CurrentParentConfiguredIdentity {
  const {
    artifactVersion,
    rows,
    sourceCapture,
    sqlRowEncoding,
    originalTailCoverage,
    ...expected
  } = b;
  void artifactVersion;
  void rows;
  void sourceCapture;
  void sqlRowEncoding;
  void originalTailCoverage;
  return {
    profile: {
      profileVersion: 1,
      normalSchemaVersion: 107,
      explicitVersions: [108, 109, 110, 111, 112, 113, 114, 115, 116],
      rowEncoding: 'utc-microseconds-decimal-bigint-hex-bytea-v1',
      physicalProfileSha256: CURRENT_PARENT_PHYSICAL_PROFILE_SHA256,
    },
    source: { ...expected.source },
    identity: { ...expected.identity },
    count: expected.count,
    census: expected.census.map((p) => ({ ...p })),
    rowsSha256: expected.rowsSha256,
  };
}
function verifier(b = body(), resolveSourceKey = () => key) {
  return createCurrentParentArtifactVerifier({ expected: configured(b), resolveSourceKey });
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? '';
}
it('authenticates exact current physical bytes without granting source capture, census or loader authority', () => {
  const b = body(),
    v = verifier(b),
    handle = v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(b, key));
  expect(handle).toEqual({
    kind: 'verified_current_parent_bytes',
    parentClosure: 'blocked',
    sqlStage: 'unavailable',
    authority: 'none',
    admissionAllowed: false,
  });
  v.withVerifiedCurrentParentArtifact(handle, (copy, limits) => {
    expect(copy.rows).toEqual(b.rows);
    expect(limits).toMatchObject({
      parentClosure: 'blocked',
      reason: 'source_catalog_census_not_authenticated',
      sourceCapture: 'not_verified',
      sourceCatalogCensus: 'not_authenticated',
      sqlRowEncoding: 'not_verified',
      domainConstraints: 'not_verified',
      sqlStage: 'unavailable',
      originalTailStage: 'unavailable',
      authority: 'none',
      admissionAllowed: false,
    });
  });
});
it('has exact current required 94 physical codecs and explicit remaining installed partitions', () => {
  expect(CURRENT_PARENT_TYPED_RELATIONS).toHaveLength(94);
  expect(CURRENT_PARENT_RELATIONS).toHaveLength(201);
  expect(CURRENT_PARENT_TYPED_RELATIONS).toContain('resource_version');
  expect(CURRENT_PARENT_TYPED_RELATIONS).toContain('race_result_revision');
  expect(CURRENT_PARENT_RELATIONS).toContain('identity_private.session');
  expect(CURRENT_PARENT_TYPED_RELATIONS).not.toContain('identity_private.session');
});
it('nonempty unsupported secret partition is signed census only and remains explicitly blocked', () => {
  const b = body();
  b.count++;
  b.census = b.census.map((p) =>
    p.relation === 'identity_private.session' ? { ...p, count: 1 } : p,
  );
  const v = verifier(b),
    handle = v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(b, key));
  v.withVerifiedCurrentParentArtifact(handle, (_, limits) =>
    expect(limits).toMatchObject({
      reason: 'parent_partitions_unimplemented',
      unsupportedPartitions: [{ relation: 'identity_private.session', count: 1 }],
    }),
  );
  expect(() =>
    signCurrentParentArtifact(
      {
        ...b,
        rows: [
          ...b.rows,
          { ordinal: 6, relation: 'identity_private.session', row: { athlete_id: athlete } },
        ],
      },
      key,
    ),
  ).toThrow('INVALID_CURRENT_PARENT_ARTIFACT');
});
it.each([
  'databaseOid',
  'captureId',
  'generationId',
  'registrySha256',
  'catalogSha256',
  'baselineThroughLsn',
] as const)('rejects independently configured source mismatch %s', (field) => {
  const b = body(),
    e = configured(b);
  if (field === 'databaseOid') e.source.databaseOid++;
  else if (field === 'baselineThroughLsn') e.source.baselineThroughLsn = 'A/C';
  else if (field.endsWith('Sha256')) {
    e.source.registrySha256 = sha.replace(/^a/, 'b');
    e.source.catalogSha256 = e.source.registrySha256;
  } else {
    e.source.captureId = id(20);
    e.source.generationId = id(21);
  }
  const v = createCurrentParentArtifactVerifier({ expected: e, resolveSourceKey: () => key });
  expect(() => v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(b, key))).toThrow(
    'INVALID_CURRENT_PARENT_ARTIFACT',
  );
});
it('rejects wrong key and child domain signatures', () => {
  const b = body(),
    v = verifier(b);
  expect(() =>
    v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(b, otherKey)),
  ).toThrow();
  const hmacSha256 = createHmac('sha256', key)
    .update('wm-current-child-family-authentication-v1\0')
    .update(canonical(b))
    .digest('hex');
  expect(() =>
    v.prepareVerifiedCurrentParentArtifact(Buffer.from(canonical({ body: b, hmacSha256 }))),
  ).toThrow();
});
it('honors revocation both at preparation and subsequent handle use', () => {
  let revoked = false;
  const v = verifier(body(), () => {
    if (revoked) throw new Error('revoked');
    return key;
  });
  const bytes = signCurrentParentArtifact(body(), key),
    handle = v.prepareVerifiedCurrentParentArtifact(bytes);
  revoked = true;
  expect(() => v.prepareVerifiedCurrentParentArtifact(bytes)).toThrow(
    'INVALID_CURRENT_PARENT_ARTIFACT',
  );
  expect(() => v.withVerifiedCurrentParentArtifact(handle, () => true)).toThrow(
    'INVALID_CURRENT_PARENT_ARTIFACT',
  );
});
it('rejects reused key version with changed material at callback use', () => {
  let sourceKey = key;
  const v = verifier(body(), () => sourceKey),
    handle = v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(body(), key));
  sourceKey = otherKey;
  expect(() => v.withVerifiedCurrentParentArtifact(handle, () => true)).toThrow();
});
it('factory handles cannot be forged or moved between factories', () => {
  const b = body(),
    v = verifier(b),
    other = verifier(b),
    handle = v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(b, key));
  expect(() => other.withVerifiedCurrentParentArtifact(handle, () => true)).toThrow();
  const fake: VerifiedCurrentParentBytes = {
    kind: 'verified_current_parent_bytes',
    parentClosure: 'blocked',
    sqlStage: 'unavailable',
    authority: 'none',
    admissionAllowed: false,
  };
  expect(() => v.withVerifiedCurrentParentArtifact(fake, () => true)).toThrow();
});
it('callback mutation does not change authenticated bytes and configuration mutation is pinned', () => {
  const b = body(),
    expected = configured(b),
    v = createCurrentParentArtifactVerifier({ expected, resolveSourceKey: () => key });
  expected.identity.sourceKeyId = 'changed';
  const handle = v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(b, key));
  v.withVerifiedCurrentParentArtifact(handle, (copy) => {
    const entry = copy.rows[0];
    if (!entry) throw new Error('fixture missing');
    entry.row.athlete_id = 'changed';
  });
  v.withVerifiedCurrentParentArtifact(handle, (copy) =>
    expect(copy.rows[0]?.row.athlete_id).toBe(athlete),
  );
});
it('rejects byte tampering, noncanonical wrapper, unknown top-level keys and invalid UTF8', () => {
  const b = body(),
    v = verifier(b),
    bytes = signCurrentParentArtifact(b, key);
  expect(() =>
    v.prepareVerifiedCurrentParentArtifact(
      Buffer.from(new TextDecoder().decode(bytes).replace('synthetic-subject', 'tampered-subject')),
    ),
  ).toThrow();
  expect(() =>
    v.prepareVerifiedCurrentParentArtifact(Buffer.from(` ${new TextDecoder().decode(bytes)}`)),
  ).toThrow();
  expect(() => signCurrentParentArtifact({ ...b, approvalAllowed: true }, key)).toThrow();
  expect(() => v.prepareVerifiedCurrentParentArtifact(new Uint8Array([255]))).toThrow();
});
it('rejects wrong tenant, changed physical columns, historic plan head schema and body checksum', () => {
  const b = body();
  expect(() =>
    signCurrentParentArtifact({ ...b, identity: { ...b.identity, athleteId: id(40) } }, key),
  ).toThrow();
  const raw = rows().map((entry, index) =>
    index === 2 ? { ...entry, row: { ...entry.row, obsolete: 'unknown' } } : entry,
  );
  expect(() => currentParentRowsSha256(raw)).toThrow();
  expect(() =>
    currentParentRowsSha256([
      { ordinal: 1, relation: 'plan_head', row: { athlete_id: athlete, version_id: id(2) } },
    ]),
  ).toThrow();
  expect(() => signCurrentParentArtifact({ ...b, rowsSha256: 'b'.repeat(64) }, key)).toThrow();
});
it('rejects incomplete, reordered and duplicate census or mismatched counts', () => {
  const b = body();
  expect(() => signCurrentParentArtifact({ ...b, census: b.census.slice(1) }, key)).toThrow();
  expect(() => signCurrentParentArtifact({ ...b, census: [...b.census].reverse() }, key)).toThrow();
  expect(() =>
    signCurrentParentArtifact(
      { ...b, census: b.census.map((p, i) => (i === 1 ? b.census[0] : p)) },
      key,
    ),
  ).toThrow();
  expect(() => signCurrentParentArtifact({ ...b, count: 0 }, key)).toThrow();
  expect(() =>
    signCurrentParentArtifact(
      { ...b, census: b.census.map((p) => (p.relation === 'consent' ? { ...p, count: 0 } : p)) },
      key,
    ),
  ).toThrow();
});
it('enforces ordinal, ordered relation/PK membership and no duplicate source row', () => {
  const r = rows();
  expect(() => currentParentRowsSha256([...r].reverse())).toThrow();
  expect(() => currentParentRowsSha256(r.map((x) => ({ ...x, ordinal: 2 })))).toThrow();
  expect(() =>
    currentParentRowsSha256([
      { ...r[0], ordinal: 1 },
      { ...r[0], ordinal: 2 },
    ]),
  ).toThrow();
  const pair = [
    {
      ordinal: 1,
      relation: 'consent',
      row: { athlete_id: athlete, kind: 'app', granted: true, revision: 1 },
    },
    {
      ordinal: 2,
      relation: 'consent',
      row: { athlete_id: athlete, kind: 'provider', granted: false, revision: 2 },
    },
  ];
  expect(currentParentRowsSha256(pair)).toMatch(/^[a-f0-9]{64}$/);
  expect(() =>
    currentParentRowsSha256(pair.map((p, i) => ({ ...pair[1 - i], ordinal: i + 1 }))),
  ).toThrow();
});
it('preserves six-digit UTC and exact int8 string boundary rather than JS millisecond/number coercion', () => {
  const r = rows();
  expect(currentParentRowsSha256(r)).toMatch(/^[a-f0-9]{64}$/);
  const objectRow = {
    athlete_id: athlete,
    storage_ref: 'opaque',
    content_hash: sha,
    size_bytes: '9223372036854775807',
    media_type: 'application/pdf',
    created_at: at,
  };
  expect(() =>
    currentParentRowsSha256([
      {
        ordinal: 1,
        relation: 'resource_object',
        row: { ...objectRow, size_bytes: 9223372036854776000 },
      },
    ]),
  ).toThrow();
  expect(() =>
    currentParentRowsSha256([
      {
        ordinal: 1,
        relation: 'resource_object',
        row: { ...objectRow, size_bytes: '9223372036854775808' },
      },
    ]),
  ).toThrow();
  expect(() =>
    currentParentRowsSha256([
      {
        ordinal: 1,
        relation: 'resource_object',
        row: { ...objectRow, created_at: '2026-10-08T01:02:03.123Z' },
      },
    ]),
  ).toThrow();
});
it('preserves JSONB arrays and opaque keys without a DTO transform', () => {
  const row = {
    ordinal: 1,
    relation: 'plan_snapshot',
    row: {
      athlete_id: athlete,
      id: id(2),
      version: 1,
      created_at: at,
      draft: { sessions: [{ id: '긴 opaque𐀀\\"', values: [0, null] }] },
    },
  };
  const r = [row],
    b = body([]);
  const full = {
    ...b,
    rows: r,
    count: 1,
    rowsSha256: currentParentRowsSha256(r),
    census: b.census.map((p) => (p.relation === 'plan_snapshot' ? { ...p, count: 1 } : p)),
  };
  expect(signCurrentParentArtifact(full, key)).toBeInstanceOf(Uint8Array);
  expect(
    currentParentRowsSha256([
      {
        ...row,
        row: { ...row.row, draft: { sessions: [{ id: '긴 opaque𐀀\\"', values: [null, 0] }] } },
      },
    ]),
  ).not.toBe(full.rowsSha256);
});
it('bounds rows before signing, including UTF8 size and pre-dedup visits', () => {
  expect(() =>
    currentParentRowsSha256(
      Array.from({ length: 5001 }, (_, i) => ({
        ordinal: i + 1,
        relation: 'consent',
        row: { athlete_id: athlete, kind: 'app', granted: true, revision: 1 },
      })),
    ),
  ).toThrow();
  const row = {
    ordinal: 1,
    relation: 'plan_snapshot',
    row: {
      athlete_id: athlete,
      id: id(2),
      version: 1,
      created_at: at,
      draft: { text: '가'.repeat(Math.ceil(CURRENT_PARENT_MAX_ROW_BYTES / 3)) },
    },
  };
  expect(() => currentParentRowsSha256([row])).toThrow();
});
it('rejects getters, cycles, sparse arrays, nonplain objects and deep ingress before schema parse', () => {
  const b = body();
  let read = false;
  Object.defineProperty(b, 'poison', {
    enumerable: true,
    get() {
      read = true;
      return true;
    },
  });
  expect(() => signCurrentParentArtifact(b, key)).toThrow();
  expect(read).toBe(false);
  const cycle: { next?: unknown } = {};
  cycle.next = cycle;
  const sparse = new Array(2);
  sparse[1] = null;
  for (const value of [cycle, sparse, new Date(), { value: undefined }])
    expect(() =>
      currentParentRowsSha256([
        {
          ordinal: 1,
          relation: 'plan_snapshot',
          row: { athlete_id: athlete, id: id(2), version: 1, created_at: at, draft: value },
        },
      ]),
    ).toThrow();
  let deep: unknown = null;
  for (let i = 0; i < 65; i++) deep = { next: deep };
  expect(() =>
    currentParentRowsSha256([
      {
        ordinal: 1,
        relation: 'plan_snapshot',
        row: { athlete_id: athlete, id: id(2), version: 1, created_at: at, draft: deep },
      },
    ]),
  ).toThrow();
});
it('empty signed census never authenticates absent source partitions or admits restore', () => {
  const b = body([]),
    v = verifier(b),
    handle = v.prepareVerifiedCurrentParentArtifact(signCurrentParentArtifact(b, key));
  v.withVerifiedCurrentParentArtifact(handle, (_, limits) => {
    expect(limits.reason).toBe('source_catalog_census_not_authenticated');
    expect(limits.parentClosure).toBe('blocked');
    expect(limits.admissionAllowed).toBe(false);
  });
});
it('rejects whole-body overflow even when each individual physical row is under its bound', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    ordinal: index + 1,
    relation: 'plan_snapshot',
    row: {
      athlete_id: athlete,
      id: id(index + 20),
      version: index + 1,
      created_at: at,
      draft: { text: 'x'.repeat(3_500_000) },
    },
  }));
  expect(() => currentParentRowsSha256(entries)).toThrow('INVALID_CURRENT_PARENT_ARTIFACT');
});
