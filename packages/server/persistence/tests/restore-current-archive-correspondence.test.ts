import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createCurrentArchiveCorrespondenceVerifier,
  type CurrentArchiveCorrespondenceConfiguration,
} from '../src/restore-current-archive-correspondence.js';
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
    parts,
  };
}

const target = {
  databaseName: 'archive_target',
  databaseOid: '99',
  roleName: 'offline',
  roleOid: '43',
};
function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options);
  let bodyReads = 0;
  let scalarReads = 0;
  let mutate: (row: Record<string, unknown>) => void = () => {};
  let revoked = false;
  let invalidContext = false;
  let oversize = false;
  const { encryptionKey: _e, sourceAuthenticationKey: _a, ...source } = f.configuration;
  const tx = {
    async query(sql: string) {
      if (sql.includes('current_database()'))
        return {
          rows: [
            {
              ...target,
              sessionRole: 'offline',
              isolation: invalidContext ? 'read committed' : 'repeatable read',
              readOnly: true,
              statementTimeout: '10000',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('public.schema_migrations'))
        return { rows: expected.normalRegistry, rowCount: 107 };
      if (sql.includes('row_security_active'))
        return {
          rows: currentSourcePhysicalRelations.map((relation) => ({
            relation,
            readable: true,
            filtered: false,
          })),
          rowCount: 222,
        };
      const relation = currentSourcePhysicalRelations.find((r) => {
        const p = r.split('.');
        return sql.includes(
          `FROM ONLY "${p.length === 2 ? p[0] : 'public'}"."${p.length === 2 ? p[1] : r}" t`,
        );
      });
      if (!relation) throw Error('UNEXPECTED_TEST_QUERY');
      const p = f.parts.find((p) => p.census.some((c) => c.relation === relation));
      if (!p) throw Error('MISSING_PART');
      const rows = p.rows
        .filter((r) => r.relation === relation)
        .map((r, index) => {
          const evidence = p.physicalEvidence.find((e) => e.relation === relation)?.rows[index];
          if (!evidence) throw Error('EVIDENCE');
          const row = structuredClone({ row: r.row, ...evidence });
          mutate(row);
          return row;
        });
      if (sql.startsWith('WITH encoded')) {
        scalarReads++;
        return {
          rows: [
            {
              count: String(rows.length),
              bytes: oversize ? '16777217' : '4096',
              maximum: oversize ? '4194305' : '4096',
            },
          ],
          rowCount: 1,
        };
      }
      bodyReads++;
      return { rows, rowCount: rows.length };
    },
  };
  const configuration: CurrentArchiveCorrespondenceConfiguration = {
    source,
    target,
    async resolveKeys() {
      return revoked ? null : { encryptionKey: key, sourceAuthenticationKey: auth };
    },
    async withRestoredArchive(binding, consume) {
      expect(binding.descriptor.owner).toBe(captureId);
      expect(binding.capture).toEqual(capture);
      return await consume(tx);
    },
  };
  return {
    f,
    configuration,
    verifier: createCurrentArchiveCorrespondenceVerifier(configuration),
    counts: () => ({ bodyReads, scalarReads }),
    mutation(fn: typeof mutate) {
      mutate = fn;
    },
    revoke() {
      revoked = true;
    },
    badContext() {
      invalidContext = true;
    },
    oversize() {
      oversize = true;
    },
  };
}
it('compares exact full222 empty physical censuses with no admission from configured encrypted packet authentication', async () => {
  const s = setup();
  const result = await s.verifier.verify();
  expect(result.census).toHaveLength(222);
  expect(s.counts()).toEqual({ bodyReads: 222, scalarReads: 222 });
  expect(result.limits).toMatchObject({
    authority: 'none',
    admissionAllowed: false,
    archiveRowCorrespondence: 'verified_against_authenticated_packets',
    latestTail: 'not_checked',
  });
});
it('matches current immutable full body including semantic arrays/null/zero and SQL microseconds', async () => {
  const s = setup({ rowRelation: 'race_event' });
  const result = await s.verifier.verify();
  expect(result.census.find((r) => r.relation === 'race_event')?.count).toBe('1');
});
it('rejects same count changed body rather than accepting dump count', async () => {
  const s = setup({ rowRelation: 'race_event' });
  s.mutation((r) => {
    const row = r['row'];
    if (row && typeof row === 'object' && !Array.isArray(row)) Object.assign(row, { revision: 99 });
  });
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_ROW_MISMATCH');
});
it('rejects a truncated timestamp despite equal census', async () => {
  const s = setup({ rowRelation: 'food_definition_version' });
  s.mutation((r) => {
    const row = r['row'];
    if (row && typeof row === 'object' && !Array.isArray(row))
      Object.assign(row, { created_at: '2026-10-08T00:00:00.123Z' });
  });
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_ROW_MISMATCH');
});
it('rejects foreign physical keys', async () => {
  const s = setup({ rowRelation: 'race_event' });
  s.mutation((r) => {
    const row = r['row'];
    if (row && typeof row === 'object' && !Array.isArray(row))
      Object.assign(row, { athlete_id: 'foreign' });
  });
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_ROW_MISMATCH');
});
it('rejects malformed row/accessor without executing getter', async () => {
  const s = setup({ rowRelation: 'race_event' });
  let reads = 0;
  s.mutation((r) => {
    Object.defineProperty(r, 'secret', {
      enumerable: true,
      get() {
        reads++;
        return 'secret';
      },
    });
  });
  await expect(s.verifier.verify()).rejects.toThrow('INVALID_CONFIGURATION');
  expect(reads).toBe(0);
});
it('refuses scalar over budget before body read', async () => {
  const s = setup();
  s.oversize();
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_LIMIT');
  expect(s.counts()).toEqual({ scalarReads: 1, bodyReads: 0 });
});
it('refuses RC read scope before physical response', async () => {
  const s = setup();
  s.badContext();
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_CONTEXT_MISMATCH');
  expect(s.counts().bodyReads).toBe(0);
});
it('resolves keys fresh every call and denies revoked original key', async () => {
  const s = setup();
  await s.verifier.verify();
  s.revoke();
  await expect(s.verifier.verify()).rejects.toThrow('KEY_UNAVAILABLE');
});
it('pins resolver and source metadata against configuration reassignment', async () => {
  const s = setup();
  s.configuration.source.expected.source.databaseName = 'attacker';
  Object.defineProperty(s.configuration, 'resolveKeys', {
    value: async () => ({
      encryptionKey: Buffer.alloc(32, 8),
      sourceAuthenticationKey: Buffer.alloc(32, 9),
    }),
  });
  expect((await s.verifier.verify()).source.databaseName).toBe('source');
});
it('rejects incorrect encryption keys without invoking archive port', async () => {
  const s = setup();
  const v = createCurrentArchiveCorrespondenceVerifier({
    ...s.configuration,
    async resolveKeys() {
      return { encryptionKey: Buffer.alloc(32, 8), sourceAuthenticationKey: auth };
    },
  });
  await expect(v.verify()).rejects.toThrow('SOURCE_AUTHENTICATION_FAILED');
});
it('rejects no actual callback even if trusted port returns forged status', async () => {
  const s = setup();
  const v = createCurrentArchiveCorrespondenceVerifier({
    ...s.configuration,
    async withRestoredArchive() {
      throw Error('PORT_UNAVAILABLE');
    },
  });
  await expect(v.verify()).rejects.toThrow('PORT_UNAVAILABLE');
});
it('rejects aborted verification before object reads', async () => {
  const s = setup();
  const c = new AbortController();
  c.abort();
  await expect(s.verifier.verify({ signal: c.signal })).rejects.toThrow('VERIFY_ABORTED');
  expect(s.f.reads).toHaveLength(0);
});
it('rejects omitted physical NULL rather than treating it as absent', async () => {
  const s = setup({ rowRelation: 'race_event' });
  // Choose a present physical nullable column from the fixed runtime roster.
  s.mutation((r) => {
    const row = r['row'];
    const name = currentSourcePhysicalDefinition('race_event').columns.find(
      (c) => c.nullable,
    )?.name;
    if (row && typeof row === 'object' && !Array.isArray(row) && name)
      Reflect.deleteProperty(row, name);
  });
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_ROW_MISMATCH');
});
it('preserves array order rather than accepting sorted semantic arrays', async () => {
  const s = setup({ rowRelation: 'race_event' });
  s.mutation((r) => {
    const row = r['row'];
    if (row && typeof row === 'object' && !Array.isArray(row))
      Object.assign(row, { values_json: { unknown: null, zero: 0, ordered: ['a', 'b'] } });
  });
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_ROW_MISMATCH');
});
it('rejects changed array lower bound even when element values match', async () => {
  const s = setup({ rowRelation: 'course_share' });
  s.mutation((r) => {
    const layouts = r['arrayLayouts'];
    if (layouts && typeof layouts === 'object' && !Array.isArray(layouts)) {
      const field = Object.keys(layouts)[0];
      if (field)
        Object.assign(layouts, {
          [field]: { isNull: false, dimensions: [{ lowerBound: 1, upperBound: 1 }] },
        });
    }
  });
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_ROW_MISMATCH');
});
it('rejects changed float bit evidence independently of JSON number text', async () => {
  const s = setup({ rowRelation: 'course_revision' });
  s.mutation((r) => {
    const signs = r['floatSigns'];
    if (signs && typeof signs === 'object' && !Array.isArray(signs)) {
      const field = Object.keys(signs)[0];
      if (field) Object.assign(signs, { [field]: '0000000000000000' });
    }
  });
  await expect(s.verifier.verify()).rejects.toThrow('ARCHIVE_ROW_MISMATCH');
});
it('rejects giant config input before serialization', () => {
  const s = setup();
  expect(() =>
    createCurrentArchiveCorrespondenceVerifier({
      ...s.configuration,
      source: {
        ...s.configuration.source,
        expectedCapture: { ...capture, snapshotId: 'x'.repeat(4194305) },
      },
    }),
  ).toThrow('INVALID_CONFIGURATION');
});
it('does not execute nested configuration getters', () => {
  const s = setup();
  let reads = 0;
  Object.defineProperty(s.configuration.source.expectedCapture, 'snapshotId', {
    enumerable: true,
    get() {
      reads++;
      return 'x';
    },
  });
  expect(() => createCurrentArchiveCorrespondenceVerifier(s.configuration)).toThrow(
    'INVALID_CONFIGURATION',
  );
  expect(reads).toBe(0);
});
