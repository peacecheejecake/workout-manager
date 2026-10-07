import { createHash, createDecipheriv, createHmac } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createCurrentSourceCaptureService,
  type CurrentSourceEncryptedStore,
  type CurrentSourceEncryptedObject,
  type CurrentSourceSnapshotProvider,
} from '../src/restore-current-source-capture.js';
import { currentSourcePhysicalRelations } from '../src/restore-current-source-projections.js';
import type * as CatalogModule from '../src/restore-current-source-catalog.js';
import { type CurrentSourceCatalogExpected } from '../src/restore-current-source-catalog.js';
const mock = vi.hoisted(() => ({ censusMismatch: false, contextMismatch: false }));
vi.mock('../src/restore-current-source-catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof CatalogModule>();
  return {
    ...actual,
    captureCurrentSourceCatalogIn: vi.fn(async () => ({
      profile: { profileVersion: 1, normalSchemaVersion: 107, explicitPins: expected.explicitPins },
      snapshot: {
        transactionSnapshot: mock.contextMismatch ? '2:3:' : '1:2:',
        isolation: 'repeatable read',
        readOnly: true,
        roleName: 'offline',
        roleOid: '43',
        statementTimeout: '10000',
      },
      catalog: { unit: 'query-mock-not-PG' },
      catalogSha256: 'c'.repeat(64),
      census: currentSourcePhysicalRelations.map((relation) => {
        const p = relation.split('.');
        return {
          schema: p.length === 2 ? p[0] : 'public',
          relation: p.length === 2 ? p[1] : p[0],
          rows: mock.censusMismatch ? '1' : '0',
          rowStorageBytes: '0',
        };
      }),
    })),
  };
});
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
    .map((relation) => {
      const p = relation.split('.');
      return {
        schema: p.length === 2 ? (p[0] ?? 'public') : 'public',
        name: p.length === 2 ? (p[1] ?? '') : 'public' === relation ? '' : relation,
      };
    })
    .sort((a, b) => (`${a.schema}.${a.name}` < `${b.schema}.${b.name}` ? -1 : 1)),
  roles: [{ tag: 'backup', name: 'offline' }],
  source: { databaseName: 'source', databaseOid: '42', systemIdentifier: '123' },
  operator: { roleName: 'offline', roleOid: '43', superuser: true, bypassRls: false },
  catalogSha256: 'c'.repeat(64),
};
const owner = '11111111-1111-4111-8111-111111111111',
  generation = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  mock.censusMismatch = false;
  mock.contextMismatch = false;
});
function fixture() {
  const objects = new Map<
    string,
    { descriptor: CurrentSourceEncryptedObject; bytes: Uint8Array }
  >();
  const writes: string[] = [],
    removed: string[] = [],
    queries: string[] = [];
  let corrupt = false,
    wrongOwner = false,
    failCleanup = false,
    opened = 0,
    oversized = false,
    wrongGeneration = false;
  const store: CurrentSourceEncryptedStore = {
    async put(input) {
      writes.push(input.objectId);
      if (objects.has(input.objectId)) throw new Error('DUPLICATE_WRITE');
      const descriptor = {
        objectId: input.objectId,
        owner: input.owner,
        versionId: 'v1',
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        byteLength: input.bytes.length,
      };
      objects.set(input.objectId, { descriptor, bytes: Buffer.from(input.bytes) });
      return descriptor;
    },
    async read(objectId) {
      const item = objects.get(objectId);
      if (!item) throw new Error('MISSING_OBJECT');
      return {
        descriptor: wrongOwner ? { ...item.descriptor, owner: generation } : item.descriptor,
        bytes: corrupt ? Buffer.from('tampered') : Buffer.from(item.bytes),
      };
    },
    async removeOwned(d) {
      removed.push(d.objectId);
      if (failCleanup) throw new Error('REMOVE_FAILED');
      const item = objects.get(d.objectId);
      if (item?.descriptor.owner !== d.owner || item.descriptor.versionId !== d.versionId)
        throw new Error('FOREIGN_DELETE');
      objects.delete(d.objectId);
    },
  };
  const snapshots: CurrentSourceSnapshotProvider = {
    async withSnapshot(callback) {
      opened++;
      return callback({
        source: expected.source,
        captureId: owner,
        generationId: generation,
        snapshotId: '00000001-00000002-1',
        transactionSnapshot: '1:2:',
        baselineLsn: '0/1',
        tx: {
          async query(sql) {
            queries.push(sql);
            if (sql.includes('current_restore_generation'))
              return {
                rows: [{ generationId: wrongGeneration ? owner : generation }],
                rowCount: 1,
              };
            if (sql.startsWith('WITH encoded'))
              return {
                rows: [{ count: '0', bytes: oversized ? '16777217' : '0', maximum: '0' }],
                rowCount: 1,
              };
            if (sql.includes('txid_current_snapshot'))
              return { rows: [{ snapshot: '1:2:' }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
          },
        },
        async archive(input) {
          await store.put({
            objectId: `${owner}_archive`,
            owner,
            bytes: Buffer.from('unit-encrypted-archive-port'),
          });
          return {
            descriptor: objects.get(`${owner}_archive`)?.descriptor ?? {
              objectId: 'missing',
              owner,
              versionId: 'v1',
              sha256: '0'.repeat(64),
              byteLength: 1,
            },
            snapshotId: input.snapshotId,
            baselineLsn: '0/1',
            source: expected.source,
          };
        },
      });
    },
  };
  const config = {
    expected,
    encryptionKey: Buffer.alloc(32, 1),
    encryptionKeyId: 'encrypt',
    sourceAuthenticationKey: Buffer.alloc(32, 2),
    sourceKeyId: 'source',
    store,
    snapshots,
  };
  return {
    config,
    objects,
    writes,
    removed,
    queries,
    get opened() {
      return opened;
    },
    oversized() {
      oversized = true;
    },
    wrongGeneration() {
      wrongGeneration = true;
    },
    corrupt() {
      corrupt = true;
    },
    wrongOwner() {
      wrongOwner = true;
    },
    failCleanup() {
      failCleanup = true;
    },
  };
}
function decrypt(bytes: Uint8Array): unknown {
  const b = Buffer.from(bytes),
    length = b.readUInt32BE(8),
    header = b.subarray(12, 12 + length),
    d = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 1), b.subarray(12 + length, 24 + length));
  d.setAAD(header);
  d.setAuthTag(b.subarray(24 + length, 40 + length));
  return JSON.parse(Buffer.concat([d.update(b.subarray(40 + length)), d.final()]).toString());
}
function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')
    return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`)
      .join(',')}}`;
  throw Error('INVALID');
}
it('actually encrypts immutable three empty packets and signed whole census; repeat calls never double-write (query mocks, not PG source proof)', async () => {
  const f = fixture(),
    service = createCurrentSourceCaptureService(f.config);
  const [first, second] = await Promise.all([service.capture(), service.capture()]);
  expect(second).toBe(first);
  expect(f.opened).toBe(1);
  expect(f.writes).toHaveLength(5);
  expect(first.status).toBe('baseline_captured');
  expect(first.limits).toMatchObject({
    admissionAllowed: false,
    archiveRowCorrespondence: 'not_verified',
    sequenceFence: 'not_captured_non_mvcc',
  });
  for (const packet of first.packets) {
    const body = z
      .object({ partition: z.object({ state: z.string(), rows: z.array(z.unknown()) }) })
      .parse(decrypt(f.objects.get(packet.objectId)?.bytes ?? Buffer.alloc(0)));
    expect(body.partition.state).toBe('independent_actual_census_zero');
    expect(body.partition.rows).toEqual([]);
  }
  const envelope = z
    .object({
      body: z.object({ census: z.array(z.unknown()) }).passthrough(),
      signature: z.string(),
    })
    .parse(decrypt(f.objects.get(first.manifest.objectId)?.bytes ?? Buffer.alloc(0)));
  expect(envelope.body.census).toHaveLength(222);
  expect(envelope.signature).toBe(
    createHmac('sha256', Buffer.alloc(32, 2))
      .update('wm-current-whole-source-baseline-v1\0')
      .update(canonical(envelope.body))
      .digest('hex'),
  );
  expect(f.queries.filter((sql) => sql.startsWith('WITH encoded'))).toHaveLength(222);
  expect(f.removed).toEqual([]);
});
it('copies separated key buffers at factory lifetime and rejects equal keys before opening source', async () => {
  const f = fixture();
  expect(() =>
    createCurrentSourceCaptureService({
      ...f.config,
      sourceAuthenticationKey: f.config.encryptionKey,
    }),
  ).toThrow('INVALID_CAPTURE_CONFIGURATION');
  expect(f.opened).toBe(0);
  const service = createCurrentSourceCaptureService(f.config);
  f.config.encryptionKey.fill(3);
  f.config.sourceAuthenticationKey.fill(4);
  const result = await service.capture();
  expect(() =>
    decrypt(f.objects.get(result.manifest.objectId)?.bytes ?? Buffer.alloc(0)),
  ).not.toThrow();
});
it('preserves actual census/context failure and performs no body or writes', async () => {
  for (const reason of ['census', 'context']) {
    const f = fixture();
    mock.censusMismatch = reason === 'census';
    mock.contextMismatch = reason === 'context';
    await expect(createCurrentSourceCaptureService(f.config).capture()).rejects.toMatchObject({
      code: reason === 'census' ? 'CENSUS_MISMATCH' : 'SNAPSHOT_BINDING_MISMATCH',
    });
    expect(f.writes).toEqual([]);
  }
});
it.each(['ciphertext', 'owner'])(
  'rejects immutable readback %s tamper and cleans only exact owned resources',
  async (kind) => {
    const f = fixture();
    if (kind === 'ciphertext') f.corrupt();
    else f.wrongOwner();
    await expect(createCurrentSourceCaptureService(f.config).capture()).rejects.toMatchObject({
      code: 'OBJECT_READBACK_MISMATCH',
    });
    expect(f.removed).toHaveLength(1);
    expect(f.objects.size).toBe(0);
  },
);
it('cancellation before source opens creates no objects; cleanup failures remain failures', async () => {
  const f = fixture(),
    c = new AbortController();
  c.abort();
  expect(() => createCurrentSourceCaptureService(f.config).capture({ signal: c.signal })).toThrow(
    'CAPTURE_ABORTED',
  );
  expect(f.opened).toBe(0);
  f.corrupt();
  f.failCleanup();
  await expect(createCurrentSourceCaptureService(f.config).capture()).rejects.toMatchObject({
    code: 'CLEANUP_FAILED',
  });
});

it('reserves scalar bytes before any body/packet transfer and rejects actual generation mismatch', async () => {
  for (const kind of ['oversize', 'generation']) {
    const f = fixture();
    if (kind === 'oversize') f.oversized();
    else f.wrongGeneration();
    await expect(createCurrentSourceCaptureService(f.config).capture()).rejects.toMatchObject({
      code: kind === 'oversize' ? 'PHYSICAL_CAPTURE_LIMIT' : 'SNAPSHOT_BINDING_MISMATCH',
    });
    expect(f.writes).toEqual([]);
    expect(f.queries.some((sql) => sql.startsWith('SELECT jsonb_build_object'))).toBe(false);
  }
});
