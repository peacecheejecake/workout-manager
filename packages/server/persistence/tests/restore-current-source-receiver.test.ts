import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCurrentSourceReceiver } from '../src/restore-current-source-receiver.js';
import {
  CURRENT_PARENT_RELATIONS,
  CURRENT_PARENT_TYPED_RELATIONS,
} from '../src/restore-current-parent-artifact.js';
import { currentFamilyRelations } from '../src/restore-current-family-artifact.js';
import { currentSourceExtraRelations } from '../src/restore-current-source-partitions.js';
import {
  currentSourcePhysicalRelations,
  currentSourcePhysicalDefinition,
} from '../src/restore-current-source-projections.js';
import type { CurrentSourceCatalogExpected } from '../src/restore-current-source-catalog.js';
const captureId = '11111111-1111-4111-8111-111111111111',
  generationId = '22222222-2222-4222-8222-222222222222';
const key = Buffer.alloc(32, 1),
  auth = Buffer.alloc(32, 2);
function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')
    return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  throw Error('fixture');
}
const sha = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const expected: CurrentSourceCatalogExpected = {
  profileVersion: 1,
  normalSchemaVersion: 107,
  normalRegistry: Array.from({ length: 107 }, (_, i) => ({
    version: i + 1,
    checksum: 'a'.repeat(64),
  })),
  explicitPins: Array.from({ length: 9 }, (_, i) => ({
    version: 108 + i,
    checksum: 'b'.repeat(64),
  })),
  schemas: ['garmin_private', 'identity_private', 'public', 'wm_app_load'],
  relations: currentSourcePhysicalRelations
    .map((r) => {
      const p = r.split('.');
      return {
        schema: p.length === 2 ? (p[0] ?? '') : 'public',
        name: p.length === 2 ? (p[1] ?? '') : r,
      };
    })
    .sort((a, b) => (`${a.schema}.${a.name}` < `${b.schema}.${b.name}` ? -1 : 1)),
  roles: [{ tag: 'backup', name: 'offline' }],
  source: { databaseName: 'source', databaseOid: '42', systemIdentifier: '123' },
  operator: { roleName: 'offline', roleOid: '43', superuser: true, bypassRls: false },
  catalogSha256: 'c'.repeat(64),
};
const capture = {
  captureId,
  generationId,
  snapshotId: '0001-0002-1',
  transactionSnapshot: '1:2:',
  baselineLsn: '0/1',
};
// Synthetic crypto/physical metadata, not a PostgreSQL visibility/constraint witness.
const catalog = {
  database: {
    owner: 'offline',
    encoding: 'UTF8',
    collation: 'C',
    ctype: 'C',
    locale: null,
    collationVersion: null,
    allowConnections: true,
    connectionLimit: -1,
    rawAcl: null,
    acl: [],
  },
  defaultPrivileges: [],
  schemas: expected.schemas.map((name) => ({ name, owner: 'offline', rawAcl: null, acl: [] })),
  relations: expected.relations.map((r) => ({
    ...r,
    kind: 'r',
    owner: 'offline',
    rls: true,
    force: true,
    persistence: 'p',
    partitionBound: null,
    rawAcl: null,
    acl: [],
    columns: [],
    constraints: [],
    triggers: [],
    policies: [],
    index: null,
    sequence: null,
  })),
  functions: [],
  extensions: [],
  roles: [
    {
      tag: 'backup',
      name: 'offline',
      oid: '43',
      superuser: true,
      bypassRls: false,
      inherit: true,
      createDb: false,
      createRole: false,
      login: true,
      replication: false,
      connectionLimit: -1,
      config: null,
      memberships: [],
    },
  ],
  registry: expected.normalRegistry,
};
const limits = {
  authority: 'none',
  admissionAllowed: false,
  wholeWalTail: 'not_captured',
  sequenceFence: 'not_captured_non_mvcc',
  latestTail: 'not_checked',
  targetTransforms: 'not_implemented',
  archiveRowCorrespondence: 'not_verified',
};
type Physical = {
  ordinal: number;
  relation: string;
  row: Record<string, unknown>;
  arrayLayouts?: Record<string, unknown>;
};
function partition(kind: 'parent' | 'extra' | 'child', relations: readonly string[]) {
  return {
    kind,
    rows: [] as Physical[],
    physicalEvidence: relations.map((relation) => ({
      relation,
      rows: [] as {
        arrayLayouts: Record<string, unknown>;
        floatSigns: Record<string, string | null>;
      }[],
    })),
    census: relations.map((relation) => ({ relation, count: '0' })),
    state: 'independent_actual_census_zero',
  };
}
function fixture(
  options: {
    rowRelation?: string;
    changePacket?: (p: ReturnType<typeof partition>) => void;
    changeBody?: (b: ReturnType<typeof manifestBody>) => void;
    badMac?: boolean;
  } = {},
) {
  const objects = new Map<
    string,
    {
      descriptor: {
        objectId: string;
        versionId: string;
        owner: string;
        sha256: string;
        byteLength: number;
      };
      bytes: Buffer;
    }
  >();
  const reads: string[] = [];
  function encrypted(objectId: string, value: unknown) {
    const header = Buffer.from(
        JSON.stringify({ format: 1, keyId: 'enc1', owner: captureId, objectId }),
      ),
      nonce = Buffer.alloc(12, 3),
      c = createCipheriv('aes-256-gcm', key, nonce);
    c.setAAD(header);
    const ciphertext = Buffer.concat([c.update(canonical(value), 'utf8'), c.final()]),
      size = Buffer.alloc(4);
    size.writeUInt32BE(header.length);
    return Buffer.concat([
      Buffer.from('WMCUR001'),
      size,
      header,
      nonce,
      c.getAuthTag(),
      ciphertext,
    ]);
  }
  function put(objectId: string, bytes: Buffer) {
    const d = {
      objectId,
      versionId: 'immutable-v1',
      owner: captureId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.length,
    };
    objects.set(objectId, { descriptor: d, bytes });
    return d;
  }
  const parts = [
    partition(
      'parent',
      CURRENT_PARENT_RELATIONS.filter((r) => CURRENT_PARENT_TYPED_RELATIONS.some((t) => t === r)),
    ),
    partition('extra', currentSourceExtraRelations),
    partition('child', currentFamilyRelations),
  ];
  if (options.rowRelation) {
    const relation = options.rowRelation,
      part = parts.find((p) => p.census.some((c) => c.relation === relation));
    if (!part) throw Error('fixture relation');
    const def = currentSourcePhysicalDefinition(relation),
      row: Record<string, unknown> = {},
      arrayLayouts: Record<string, unknown> = {},
      floatSigns: Record<string, string | null> = {};
    for (const c of def.columns) {
      row[c.name] = c.nullable
        ? null
        : c.type === 'uuid'
          ? captureId
          : c.type === 'integer'
            ? 1
            : c.type === 'bigint'
              ? '1'
              : c.type === 'boolean'
                ? false
                : c.type === 'timestamp with time zone'
                  ? '2026-10-08T00:00:00.123456Z'
                  : c.type === 'double precision'
                    ? '-0'
                    : c.type === 'jsonb'
                      ? { unknown: null, zero: 0, ordered: ['b', 'a'] }
                      : c.type === 'uuid[]'
                        ? [captureId]
                        : c.type === 'inet[]'
                          ? ['192.0.2.1']
                          : 'opaque 한글';
      if (c.type.endsWith('[]'))
        arrayLayouts[c.name] = {
          isNull: c.nullable,
          dimensions: c.nullable ? [] : [{ lowerBound: -2, upperBound: -2 }],
        };
      if (c.type === 'double precision')
        floatSigns[c.name] = c.nullable ? null : '8000000000000000';
    }
    const count = part.census.find((c) => c.relation === relation),
      e = part.physicalEvidence.find((c) => c.relation === relation);
    if (!count || !e) throw Error('fixture');
    count.count = '1';
    e.rows.push({ arrayLayouts, floatSigns });
    part.rows.push({
      ordinal: 1,
      relation,
      row,
      ...(part.kind === 'extra' ? { arrayLayouts } : {}),
    });
    part.state = 'nonempty_physical_partition';
  }
  for (const part of parts) options.changePacket?.(part);
  const packets = parts.map((p) =>
    put(
      `${captureId}_${p.kind}`,
      encrypted(`${captureId}_${p.kind}`, {
        profile: 'normal107-explicit108-116',
        source: expected.source,
        snapshotId: capture.snapshotId,
        transactionSnapshot: capture.transactionSnapshot,
        baselineLsn: capture.baselineLsn,
        generationId,
        partition: p,
      }),
    ),
  );
  const archive = put(
    `${captureId}_archive`,
    Buffer.from('synthetic encrypted archive port; dump-row correspondence not verified'),
  );
  function manifestBody() {
    return {
      formatVersion: 1,
      sourceKeyId: 'auth1',
      profile: 'normal107-explicit108-116',
      ...capture,
      source: expected.source,
      installedProfile: {
        profileVersion: 1,
        normalSchemaVersion: 107,
        explicitPins: expected.explicitPins,
      },
      operatorSnapshot: {
        transactionSnapshot: capture.transactionSnapshot,
        isolation: 'repeatable read',
        readOnly: true,
        roleName: 'offline',
        roleOid: '43',
        statementTimeout: '10000',
      },
      catalog,
      catalogSha256: expected.catalogSha256,
      census: expected.relations.map((r) => {
        const full = r.schema === 'public' ? r.name : `${r.schema}.${r.name}`;
        return {
          schema: r.schema,
          relation: r.name,
          rows: parts.flatMap((p) => p.census).find((c) => c.relation === full)?.count ?? '0',
          rowStorageBytes: '0',
        };
      }),
      packets,
      archive,
      limits,
    };
  }
  const b = manifestBody();
  options.changeBody?.(b);
  const signature = options.badMac
    ? 'f'.repeat(64)
    : createHmac('sha256', auth)
        .update('wm-current-whole-source-baseline-v1\0')
        .update(canonical(b))
        .digest('hex');
  const m = put(
    `${captureId}_manifest`,
    encrypted(`${captureId}_manifest`, {
      body: b,
      bodyDigest: sha(b),
      sourceKeyId: 'auth1',
      signature,
    }),
  );
  const store = {
    async read(objectId: string, versionId: string) {
      reads.push(objectId);
      const o = objects.get(objectId);
      if (!o) throw Error('missing');
      if (versionId !== o.descriptor.versionId) throw Error('version');
      return { descriptor: { ...o.descriptor }, bytes: Buffer.from(o.bytes) };
    },
  };
  const configuration = {
    expected: structuredClone(expected),
    expectedCatalog: structuredClone(catalog),
    expectedCapture: { ...capture },
    expectedManifest: { ...m },
    encryptionKey: Buffer.from(key),
    encryptionKeyId: 'enc1',
    sourceAuthenticationKey: Buffer.from(auth),
    sourceKeyId: 'auth1',
    store,
  };
  return {
    configuration,
    manifest: m,
    objects,
    reads,
    receiver: createCurrentSourceReceiver(configuration),
  };
}
it('authenticates all222 explicit zero censuses through source HMAC and packet AEAD without granting admission', async () => {
  const f = fixture(),
    h = await f.receiver.receive(f.manifest);
  expect(f.reads).toHaveLength(5);
  f.receiver.withVerifiedCurrentSource(h, (r) => {
    expect(r.packets.flatMap((p) => p.partition.census)).toHaveLength(222);
    expect(r.packets.every((p) => p.partition.state === 'independent_actual_census_zero')).toBe(
      true,
    );
    expect(r.limits).toMatchObject({
      admissionAllowed: false,
      authority: 'none',
      archiveRowCorrespondence: 'not_verified',
      archiveEncryptionFormat: 'not_verified_by_packet_codec',
      latestTail: 'not_checked',
    });
  });
});
it.each([
  'schema_migrations',
  'course_share',
  'resource_url_fetch_hop',
  'healthkit_workout_batch_receipt',
  'course_revision',
])(
  'preserves typed nonempty %s physical rows, array bounds/float signs and µs as crypto-only unit evidence',
  async (rowRelation) => {
    const f = fixture({ rowRelation }),
      h = await f.receiver.receive(f.manifest);
    f.receiver.withVerifiedCurrentSource(h, (r) => {
      expect(r.packets.flatMap((p) => p.partition.rows)).toHaveLength(1);
      expect(r.packets.flatMap((p) => p.partition.rows)[0]?.relation).toBe(rowRelation);
    });
  },
);
it('rejects modified ciphertext before plaintext decode', async () => {
  const f = fixture();
  const o = f.objects.get(f.manifest.objectId);
  if (!o) throw Error('fixture');
  const last = o.bytes[o.bytes.length - 1];
  if (last === undefined) throw Error('fixture');
  o.bytes[o.bytes.length - 1] = last ^ 1;
  await expect(f.receiver.receive(f.manifest)).rejects.toMatchObject({
    code: 'INVALID_SOURCE_OBJECT',
  });
});
it('rejects source signature mismatch even when encrypted by the configured key', async () => {
  const f = fixture({ badMac: true });
  await expect(f.receiver.receive(f.manifest)).rejects.toMatchObject({
    code: 'SOURCE_AUTHENTICATION_FAILED',
  });
  expect(f.reads).toHaveLength(1);
});
it.each([
  'capture',
  'generation',
  'snapshot',
  'lsn',
  'source',
  'profile',
  'operator',
  'catalogPin',
] as const)(
  'rejects authentically signed but independently mismatched %s binding',
  async (field) => {
    const f = fixture({
      changeBody: (b) => {
        if (field === 'capture') b.captureId = generationId;
        else if (field === 'generation') b.generationId = captureId;
        else if (field === 'snapshot') b.snapshotId = 'other';
        else if (field === 'lsn') b.baselineLsn = '0/2';
        else if (field === 'source') b.source = { ...b.source, databaseOid: '44' };
        else if (field === 'profile')
          b.installedProfile = { ...b.installedProfile, explicitPins: [] };
        else if (field === 'operator') b.operatorSnapshot.roleName = 'attacker';
        else b.catalogSha256 = 'f'.repeat(64);
      },
    });
    await expect(f.receiver.receive(f.manifest)).rejects.toThrow();
  },
);
it.each(['census', 'order', 'evidence', 'state', 'duplicate'] as const)(
  'rejects signed physical %s mismatch',
  async (field) => {
    const f = fixture({
      changePacket: (p) => {
        if (p.kind !== 'extra') return;
        const first = p.census[0];
        if (!first) throw Error('fixture');
        if (field === 'census') first.count = '1';
        else if (field === 'order') p.census.reverse();
        else if (field === 'evidence') p.physicalEvidence.pop();
        else if (field === 'state') p.state = 'nonempty_physical_partition';
        else p.census.push({ ...first });
      },
    });
    await expect(f.receiver.receive(f.manifest)).rejects.toThrow();
  },
);
it('rejects signed duplicate PKs', async () => {
  const f = fixture({
    rowRelation: 'schema_migrations',
    changePacket: (p) => {
      if (p.kind !== 'extra') return;
      const r = p.rows[0],
        c = p.census.find((v) => v.relation === 'schema_migrations'),
        e = p.physicalEvidence.find((v) => v.relation === 'schema_migrations');
      if (!r || !c || !e || !e.rows[0]) throw Error('fixture');
      p.rows.push({ ...r, ordinal: 2 });
      c.count = '2';
      e.rows.push(e.rows[0]);
    },
  });
  await expect(f.receiver.receive(f.manifest)).rejects.toThrow();
});
it('rejects signed float fingerprint disagreement', async () => {
  const f = fixture({
    rowRelation: 'course_revision',
    changePacket: (p) => {
      for (const e of p.physicalEvidence)
        for (const r of e.rows)
          if ('distance_meters' in r.floatSigns)
            r.floatSigns['distance_meters'] = '0000000000000000';
    },
  });
  await expect(f.receiver.receive(f.manifest)).rejects.toThrow();
});
it('pins configuration keys, expected profile, reader and capture at constructor', async () => {
  const f = fixture();
  f.configuration.encryptionKey.fill(9);
  f.configuration.sourceAuthenticationKey.fill(9);
  f.configuration.expected.source.databaseOid = '44';
  f.configuration.expectedCapture.captureId = generationId;
  f.configuration.store.read = async () => {
    throw Error('replacement');
  };
  const h = await f.receiver.receive(f.manifest);
  expect(f.receiver.withVerifiedCurrentSource(h, (r) => r.manifest.source.databaseOid)).toBe('42');
});
it('rejects equal keys and independently wrong encryption/source keys', async () => {
  const f = fixture();
  expect(() =>
    createCurrentSourceReceiver({ ...f.configuration, sourceAuthenticationKey: key }),
  ).toThrow();
  for (const configuration of [
    { ...f.configuration, encryptionKey: Buffer.alloc(32, 8) },
    { ...f.configuration, sourceAuthenticationKey: Buffer.alloc(32, 8) },
  ])
    await expect(createCurrentSourceReceiver(configuration).receive(f.manifest)).rejects.toThrow();
});
it('rejects descriptor getters/cycles/unknown fields without executing getters or reading objects', async () => {
  const f = fixture();
  let calls = 0;
  const accessor = { ...f.manifest };
  Object.defineProperty(accessor, 'owner', {
    enumerable: true,
    get() {
      calls++;
      return captureId;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  for (const raw of [accessor, cycle, { ...f.manifest, admissionAllowed: true }])
    await expect(f.receiver.receive(raw)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(f.reads).toEqual([]);
});
it('rejects foreign/serialized handles and clones callback data each time', async () => {
  const f = fixture(),
    h = await f.receiver.receive(f.manifest);
  const other = fixture();
  for (const handle of [{}, JSON.parse(JSON.stringify(h)), null])
    expect(() => f.receiver.withVerifiedCurrentSource(handle, () => true)).toThrow();
  expect(() => other.receiver.withVerifiedCurrentSource(h, () => true)).toThrow();
  f.receiver.withVerifiedCurrentSource(h, (r) => {
    r.manifest.census.length = 0;
  });
  expect(f.receiver.withVerifiedCurrentSource(h, (r) => r.manifest.census.length)).toBe(222);
});
it('preserves callback exception and async return identity without logs or SQL ports', async () => {
  const f = fixture(),
    h = await f.receiver.receive(f.manifest),
    error = Error('callback');
  expect(() =>
    f.receiver.withVerifiedCurrentSource(h, () => {
      throw error;
    }),
  ).toThrow(error);
  const promise = Promise.resolve(5);
  expect(f.receiver.withVerifiedCurrentSource(h, () => promise)).toBe(promise);
});
it('rejects pre-aborted receives before store read', async () => {
  const f = fixture(),
    c = new AbortController();
  c.abort();
  await expect(f.receiver.receive(f.manifest, { signal: c.signal })).rejects.toMatchObject({
    code: 'RECEIVE_ABORTED',
  });
  expect(f.reads).toEqual([]);
});

it('rejects equal-config ciphertext hashes with invalid AEAD and immutable version mismatches', async () => {
  const f = fixture();
  const object = f.objects.get(f.manifest.objectId);
  if (!object) throw Error('fixture');
  const last = object.bytes[object.bytes.length - 1];
  if (last === undefined) throw Error('fixture');
  object.bytes[object.bytes.length - 1] = last ^ 1;
  object.descriptor.sha256 = createHash('sha256').update(object.bytes).digest('hex');
  const configured = createCurrentSourceReceiver({
    ...f.configuration,
    expectedManifest: object.descriptor,
  });
  await expect(configured.receive(object.descriptor)).rejects.toMatchObject({
    code: 'SOURCE_AUTHENTICATION_FAILED',
  });
  const versionFixture = fixture();
  const stored = versionFixture.objects.get(versionFixture.manifest.objectId);
  if (!stored) throw Error('fixture');
  stored.descriptor.versionId = 'replacement-v2';
  await expect(versionFixture.receiver.receive(versionFixture.manifest)).rejects.toThrow();
});
it.each(['ordinal', 'unknownBody', 'layout'] as const)(
  'rejects signed typed physical %s tamper',
  async (field) => {
    const f = fixture({
      rowRelation: 'course_share',
      changePacket: (p) => {
        const row = p.rows[0];
        if (!row) return;
        if (field === 'ordinal') row.ordinal = 2;
        else if (field === 'unknownBody') row.row['authority'] = true;
        else {
          const layouts = row.arrayLayouts;
          if (!layouts) throw Error('fixture');
          layouts['zone_ids'] = { isNull: false, dimensions: [{ lowerBound: 1, upperBound: 2 }] };
        }
      },
    });
    await expect(f.receiver.receive(f.manifest)).rejects.toThrow();
  },
);
it('rejects oversized row bodies without accepting validly signed bytes as source admission', async () => {
  const f = fixture({
    rowRelation: 'schema_migrations',
    changePacket: (p) => {
      const row = p.rows[0];
      if (row) row.row['checksum'] = '한'.repeat(1400000);
    },
  });
  await expect(f.receiver.receive(f.manifest)).rejects.toMatchObject({
    code: 'SOURCE_RECEIVER_LIMIT',
  });
});
it('rejects excessive depth, nonfinite, sparse arrays and prototype boundary without object reads', async () => {
  const f = fixture();
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = { nested: deep };
  for (const raw of [
    deep,
    { ...f.manifest, byteLength: Infinity },
    { ...f.manifest, unknown: new Array(2) },
    new Date(),
  ])
    await expect(f.receiver.receive(raw)).rejects.toThrow();
  expect(f.reads).toEqual([]);
});
it('does not permit archive descriptor equality to conceal changed immutable archive bytes', async () => {
  const f = fixture(),
    archive = f.objects.get(`${captureId}_archive`);
  if (!archive) throw Error('fixture');
  archive.bytes = Buffer.from('different ciphertext');
  await expect(f.receiver.receive(f.manifest)).rejects.toMatchObject({
    code: 'INVALID_SOURCE_OBJECT',
  });
});
