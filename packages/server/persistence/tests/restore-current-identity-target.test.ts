import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createCurrentSourceReceiver } from '../src/restore-current-source-receiver.js';
import { createCurrentIdentityTargetPreparation } from '../src/restore-current-identity-target.js';
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
    rowRelations?: string[];
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
  for (const relation of options.rowRelations ?? []) {
    const part = parts.find((p) => p.census.some((c) => c.relation === relation));
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
      ordinal: part.rows.length + 1,
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
const identityRelations = [
  'identity_private.login_attempt',
  'identity_private.logout_token_replay',
  'identity_private.native_exchange_code',
  'identity_private.native_login_attempt',
  'identity_private.session',
];
function preparation(f: ReturnType<typeof fixture>) {
  let active = true;
  let changed = false;
  const {
    encryptionKey: _encryption,
    sourceAuthenticationKey: _authentication,
    ...source
  } = f.configuration;
  const configuration = {
    source,
    async resolveKeys() {
      return active
        ? {
            encryptionKey: changed ? Buffer.alloc(32, 9) : Buffer.from(key),
            sourceAuthenticationKey: Buffer.from(auth),
          }
        : null;
    },
  };
  return {
    configuration,
    factory: createCurrentIdentityTargetPreparation(configuration),
    revoke() {
      active = false;
    },
    changeKey() {
      changed = true;
    },
  };
}
it('authenticates actual synthetic ciphertext and transforms five nonempty source families into empty credentials plus exact deny audit', async () => {
  const f = fixture({ rowRelations: identityRelations });
  const p = preparation(f);
  const prepared = await p.factory.prepare();
  expect(prepared.census.map((r) => r.sourceCount)).toEqual(['1', '1', '1', '1', '1']);
  expect(prepared.census.map((r) => r.targetCount)).toEqual(['0', '1', '0', '0', '0']);
  expect(JSON.stringify(prepared)).not.toMatch(/verifier|csrf_token|token_hash|opaque 한글/);
  const result = await p.factory.withPreparedIdentityTarget(prepared.handle, (target) => target);
  expect(result.rows.map((r) => r.relation)).toEqual(['identity_private.logout_token_replay']);
  expect(result.rows[0]?.ordinal).toBe(2); // original full source partition position
  expect(result.rows[0]?.row).toMatchObject({
    issuer: 'opaque 한글',
    jti_hash: 'opaque 한글',
    received_at: '2026-10-08T00:00:00.123456Z',
  });
  expect(result.limits).toMatchObject({
    authority: 'none',
    admissionAllowed: false,
    sqlApply: 'not_executed',
    latestTail: 'not_checked',
  });
  expect(f.reads).toHaveLength(10); // complete fresh five-object reads on prepare and consume
});
it('requires explicit five-family zero census rather than inventing absent source', async () => {
  const p = preparation(fixture());
  expect(
    (await p.factory.prepare()).census.every((r) => r.sourceCount === '0' && r.targetCount === '0'),
  ).toBe(true);
});
it('rejects copied/foreign/public JSON handles without reading or callback', async () => {
  const f = fixture();
  const p = preparation(f);
  const prepared = await p.factory.prepare();
  const other = preparation(f);
  let calls = 0;
  await expect(
    other.factory.withPreparedIdentityTarget(prepared.handle, () => calls++),
  ).rejects.toMatchObject({ code: 'INVALID_HANDLE' });
  await expect(
    p.factory.withPreparedIdentityTarget(
      JSON.parse(JSON.stringify(prepared.handle)),
      () => calls++,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_HANDLE' });
  expect(calls).toBe(0);
  expect(f.reads).toHaveLength(5);
});
it('rechecks revoked keys on prepare and consume without retaining a live credential', async () => {
  const f = fixture();
  const p = preparation(f);
  const prepared = await p.factory.prepare();
  p.revoke();
  await expect(p.factory.prepare()).rejects.toMatchObject({ code: 'KEY_UNAVAILABLE' });
  await expect(
    p.factory.withPreparedIdentityTarget(prepared.handle, () => 'never'),
  ).rejects.toMatchObject({ code: 'KEY_UNAVAILABLE' });
  expect(f.reads).toHaveLength(5);
});
it('rejects changed active keys through real AEAD decoding', async () => {
  const f = fixture();
  const p = preparation(f);
  const prepared = await p.factory.prepare();
  p.changeKey();
  await expect(
    p.factory.withPreparedIdentityTarget(prepared.handle, () => 'never'),
  ).rejects.toThrow();
  expect(f.reads).toHaveLength(6);
});
it('pins original configuration and resolver and read method against later replacement', async () => {
  const f = fixture();
  const p = preparation(f);
  p.configuration.source.expected.source.databaseName = 'attacker';
  p.configuration.source.expectedManifest.sha256 = 'f'.repeat(64);
  p.configuration.resolveKeys = async () => ({
    encryptionKey: Buffer.alloc(32, 9),
    sourceAuthenticationKey: Buffer.alloc(32, 8),
  });
  p.configuration.source.store.read = async () => {
    throw Error('attacker');
  };
  const prepared = await p.factory.prepare();
  expect(prepared.status).toBe('prepared_identity_partition');
  p.revoke();
  await expect(p.factory.prepare()).rejects.toMatchObject({ code: 'KEY_UNAVAILABLE' });
});
it('re-reads exact immutable cipher objects before consume and propagates callback errors', async () => {
  const f = fixture();
  const p = preparation(f);
  const prepared = await p.factory.prepare();
  const error = new Error('callback');
  await expect(
    p.factory.withPreparedIdentityTarget(prepared.handle, () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const object = f.objects.get(`${captureId}_extra`);
  if (!object) throw Error('fixture');
  object.descriptor.versionId = 'replaced-version';
  await expect(
    p.factory.withPreparedIdentityTarget(prepared.handle, () => 'never'),
  ).rejects.toThrow();
});
it('provides fresh bounded target clones and preserves async callbacks', async () => {
  const p = preparation(fixture({ rowRelations: identityRelations }));
  const prepared = await p.factory.prepare();
  await p.factory.withPreparedIdentityTarget(prepared.handle, async (t) => {
    const row = t.rows[0];
    if (!row || !('issuer' in row.row)) throw Error('fixture');
    row.row.issuer = 'mutated';
    return 'ok';
  });
  expect(
    await p.factory.withPreparedIdentityTarget(prepared.handle, async (t) => {
      const row = t.rows[0];
      if (!row || !('issuer' in row.row)) throw Error('fixture');
      return row.row.issuer;
    }),
  ).toBe('opaque 한글');
});
it.each(['source', 'generation', 'catalog', 'profile', 'manifestVersion'])(
  'rejects mismatched authenticated %s bindings',
  async (mutation) => {
    const f = fixture({
      changeBody(b) {
        if (mutation === 'source') b.source.databaseName = 'other';
        if (mutation === 'generation') b.generationId = '33333333-3333-4333-8333-333333333333';
        if (mutation === 'catalog') b.catalogSha256 = 'f'.repeat(64);
        if (mutation === 'profile') Object.assign(b, { profile: 'normal107-explicit108-124' });
        if (mutation === 'manifestVersion') {
          const packet = b.packets[1];
          if (!packet) throw new Error('Missing fixture packet');
          b.packets[1] = { ...packet, versionId: 'wrong' };
        }
      },
    });
    await expect(preparation(f).factory.prepare()).rejects.toThrow();
  },
);
it('rejects malformed extra secret fields, duplicate PK, missing zero census, and truncated µs', async () => {
  for (const mutate of [
    (p: ReturnType<typeof partition>) => {
      if (p.kind === 'extra') {
        const row = p.rows[0];
        if (!row) throw Error('fixture');
        row.row.extraSecret = 'must-not-be-accepted';
      }
    },
    (p: ReturnType<typeof partition>) => {
      if (p.kind === 'extra') {
        const row = p.rows[0];
        if (!row) throw Error('fixture');
        p.rows.push({ ...row, ordinal: 2 });
      }
    },
    (p: ReturnType<typeof partition>) => {
      if (p.kind === 'extra')
        p.census = p.census.filter((r) => r.relation !== 'identity_private.session');
    },
    (p: ReturnType<typeof partition>) => {
      if (p.kind === 'extra') {
        const row = p.rows[0];
        if (!row) throw Error('fixture');
        row.row.created_at = '2026-10-08T00:00:00.123Z';
      }
    },
  ])
    await expect(
      preparation(
        fixture({ rowRelations: ['identity_private.login_attempt'], changePacket: mutate }),
      ).factory.prepare(),
    ).rejects.toThrow();
});
it('rejects accessor, cyclic and oversized independently configured metadata before invoking getters', () => {
  const f = fixture();
  let reads = 0;
  Object.defineProperty(f.configuration.expectedCatalog, 'trap', {
    enumerable: true,
    get() {
      reads++;
      return 'secret';
    },
  });
  expect(() => preparation(f)).toThrow();
  expect(reads).toBe(0);
  const cyclic = fixture();
  Object.assign(cyclic.configuration.expectedCatalog, {
    cycle: cyclic.configuration.expectedCatalog,
  });
  expect(() => preparation(cyclic)).toThrow();
  const large = fixture();
  Object.assign(large.configuration.expectedCatalog, { large: 'x'.repeat(4194305) });
  expect(() => preparation(large)).toThrow();
});

it.each(['giant_string', 'aggregate_strings', 'escape_expansion', 'wide_nested_objects'])(
  'rejects %s before serializing or cloning the oversized configuration',
  (mutation) => {
    const f = fixture();
    const giant =
      mutation === 'giant_string'
        ? 'x'.repeat(4194305)
        : mutation === 'aggregate_strings'
          ? Array.from({ length: 5 }, () => '한'.repeat(300000))
          : mutation === 'escape_expansion'
            ? '\u0001'.repeat(700000)
            : Array.from({ length: 1000 }, () => ({
                a: 'x'.repeat(1000),
                b: 'x'.repeat(1000),
                c: 'x'.repeat(1000),
                d: 'x'.repeat(1000),
                e: 'x'.repeat(1000),
              }));
    Object.assign(f.configuration.expectedCatalog, { giant });
    let objectSerializations = 0;
    const original = JSON.stringify;
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
      if (value !== null && typeof value === 'object') objectSerializations++;
      return original(value);
    });
    const cloning = vi.spyOn(globalThis, 'structuredClone');
    try {
      expect(() => preparation(f)).toThrow('INVALID_CONFIGURATION');
      expect(objectSerializations).toBe(0);
      expect(cloning).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
      cloning.mockRestore();
    }
  },
);
it('preserves getter non-execution across wide aggregate budget rejection', () => {
  const f = fixture();
  const entries = Array.from({ length: 200 }, () => ({ value: 'x'.repeat(24000) }));
  let reads = 0;
  const last = entries[199];
  if (!last) throw Error('fixture');
  Object.defineProperty(last, 'trap', {
    enumerable: true,
    get() {
      reads++;
      return 'secret';
    },
  });
  Object.assign(f.configuration.expectedCatalog, { entries });
  expect(() => preparation(f)).toThrow('INVALID_CONFIGURATION');
  expect(reads).toBe(0);
});
it('rejects sparse arrays, array properties, and excessively deep metadata before cloning', () => {
  for (const array of [new Array(100), Object.assign(['dense'], { extra: 'unknown' })]) {
    const f = fixture();
    Object.assign(f.configuration.expectedCatalog, { array });
    expect(() => preparation(f)).toThrow('INVALID_CONFIGURATION');
  }
  const f = fixture();
  let deep: unknown = null;
  for (let i = 0; i < 66; i++) deep = { deep };
  Object.assign(f.configuration.expectedCatalog, { deep });
  expect(() => preparation(f)).toThrow('INVALID_CONFIGURATION');
});
