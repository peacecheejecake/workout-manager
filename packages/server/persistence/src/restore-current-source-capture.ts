import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import {
  captureCurrentSourceCatalogIn,
  currentSourceCatalogExpectedSchema,
  type CurrentSourceCatalogExpected,
  type CurrentSourceCaptureTransaction,
} from './restore-current-source-catalog.js';
import {
  CURRENT_PARENT_RELATIONS,
  CURRENT_PARENT_TYPED_RELATIONS,
  parseCurrentParentPhysicalRowsV2,
} from './restore-current-parent-artifact.js';
import {
  currentFamilyRelations,
  parseCurrentFamilyPhysicalRows,
} from './restore-current-family-artifact.js';
import {
  currentSourceExtraRelations,
  parseCurrentSourceExtraPhysicalRows,
} from './restore-current-source-partitions.js';
import {
  currentSourcePhysicalDefinition,
  currentSourcePhysicalRelations,
  currentSourcePhysicalSql,
} from './restore-current-source-projections.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.uuid(),
  lsn = z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const bytesLimit = 16 * 1024 * 1024;
const descriptorSchema = z.strictObject({
  objectId: identifier,
  versionId: z.string().min(1).max(200),
  owner: uuid,
  sha256: hash,
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(bytesLimit + 4096),
});
export type CurrentSourceEncryptedObject = z.infer<typeof descriptorSchema>;
export interface CurrentSourceEncryptedStore {
  put(input: {
    objectId: string;
    owner: string;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<unknown>;
  read(
    objectId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<{ descriptor: unknown; bytes: Uint8Array }>;
  /** Only exact successfully created object descriptors may be cleaned up. */
  removeOwned(descriptor: CurrentSourceEncryptedObject): Promise<void>;
}
export type CurrentSourceSnapshotPort = Readonly<{
  tx: CurrentSourceCaptureTransaction;
  snapshotId: string;
  transactionSnapshot: string;
  baselineLsn: string;
  captureId: string;
  generationId: string;
  source: CurrentSourceCatalogExpected['source'];
  /** Adapter encrypts the pg_dump --snapshot archive before publishing any bytes. */
  archive(input: { snapshotId: string; captureId: string; signal?: AbortSignal }): Promise<
    Readonly<{
      descriptor: CurrentSourceEncryptedObject;
      snapshotId: string;
      baselineLsn: string;
      source: CurrentSourceCatalogExpected['source'];
    }>
  >;
}>;
export interface CurrentSourceSnapshotProvider {
  /** Trusted configured I/O: hold exporter lifetime through callback; import its
   * exact snapshot into RR READ ONLY before giving tx to the service. */
  withSnapshot<T>(
    callback: (snapshot: CurrentSourceSnapshotPort) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}
export class CurrentSourceCaptureError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CAPTURE_CONFIGURATION'
      | 'SNAPSHOT_BINDING_MISMATCH'
      | 'CENSUS_MISMATCH'
      | 'PHYSICAL_CAPTURE_LIMIT'
      | 'PHYSICAL_CODEC_UNAVAILABLE'
      | 'OBJECT_READBACK_MISMATCH'
      | 'CAPTURE_ABORTED'
      | 'CLEANUP_FAILED',
  ) {
    super(code);
  }
}
function fail(code: CurrentSourceCaptureError['code']): never {
  throw new CurrentSourceCaptureError(code);
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) fail('CAPTURE_ABORTED');
}
function plain(raw: unknown, max = bytesLimit) {
  let visits = 0;
  const active = new Set<object>();
  function walk(v: unknown, depth: number): void {
    if (depth > 64 || ++visits > 1000000) fail('PHYSICAL_CAPTURE_LIMIT');
    if (
      v === null ||
      typeof v === 'string' ||
      typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))
    )
      return;
    if (
      typeof v !== 'object' ||
      active.has(v) ||
      Object.getOwnPropertySymbols(v).length ||
      (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
    )
      fail('PHYSICAL_CODEC_UNAVAILABLE');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      fail('PHYSICAL_CODEC_UNAVAILABLE');
    active.add(v);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && k === 'length') continue;
      if (!d.enumerable || !('value' in d)) fail('PHYSICAL_CODEC_UNAVAILABLE');
      walk(d.value, depth + 1);
    }
    active.delete(v);
  }
  walk(raw, 0);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > max) fail('PHYSICAL_CAPTURE_LIMIT');
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
  return fail('PHYSICAL_CODEC_UNAVAILABLE');
}
function digest(v: unknown) {
  plain(v);
  return createHash('sha256').update(canonical(v)).digest('hex');
}
function encrypt(
  body: unknown,
  key: Buffer,
  keyId: string,
  owner: string,
  objectId: string,
): Buffer {
  plain(body);
  const header = Buffer.from(JSON.stringify({ format: 1, keyId, owner, objectId }));
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(canonical(body), 'utf8'), cipher.final()]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([
    Buffer.from('WMCUR001'),
    length,
    header,
    nonce,
    cipher.getAuthTag(),
    encrypted,
  ]);
}
function readback(
  ciphertext: Buffer,
  key: Buffer,
  keyId: string,
  owner: string,
  objectId: string,
  expected: unknown,
) {
  if (ciphertext.length > bytesLimit + 4096 || ciphertext.subarray(0, 8).toString() !== 'WMCUR001')
    fail('OBJECT_READBACK_MISMATCH');
  const length = ciphertext.readUInt32BE(8);
  if (length < 1 || length > 1024 || ciphertext.length < length + 40)
    fail('OBJECT_READBACK_MISMATCH');
  const header = ciphertext.subarray(12, 12 + length);
  if (header.toString() !== JSON.stringify({ format: 1, keyId, owner, objectId }))
    fail('OBJECT_READBACK_MISMATCH');
  try {
    const d = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(12 + length, 24 + length));
    d.setAAD(header);
    d.setAuthTag(ciphertext.subarray(24 + length, 40 + length));
    const body = Buffer.concat([d.update(ciphertext.subarray(40 + length)), d.final()]);
    if (body.toString() !== canonical(expected)) fail('OBJECT_READBACK_MISMATCH');
  } catch {
    fail('OBJECT_READBACK_MISMATCH');
  }
}
const rawRow = z.strictObject({
  row: z.record(z.string(), z.unknown()),
  arrayLayouts: z.record(z.string(), z.unknown()),
  floatSigns: z.record(
    z.string(),
    z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .nullable(),
  ),
});
const limits = Object.freeze({
  authority: 'none' as const,
  admissionAllowed: false as const,
  wholeWalTail: 'not_captured' as const,
  sequenceFence: 'not_captured_non_mvcc' as const,
  latestTail: 'not_checked' as const,
  targetTransforms: 'not_implemented' as const,
  archiveRowCorrespondence: 'not_verified' as const,
});
export function createCurrentSourceCaptureService(configuration: {
  expected: unknown;
  encryptionKey: Uint8Array;
  encryptionKeyId: string;
  sourceAuthenticationKey: Uint8Array;
  sourceKeyId: string;
  store: CurrentSourceEncryptedStore;
  snapshots: CurrentSourceSnapshotProvider;
}) {
  plain(configuration.expected);
  const parsed = currentSourceCatalogExpectedSchema.safeParse(configuration.expected);
  if (
    !parsed.success ||
    !(configuration.encryptionKey instanceof Uint8Array) ||
    !(configuration.sourceAuthenticationKey instanceof Uint8Array) ||
    configuration.encryptionKey.length !== 32 ||
    configuration.sourceAuthenticationKey.length !== 32 ||
    !identifier.safeParse(configuration.encryptionKeyId).success ||
    !identifier.safeParse(configuration.sourceKeyId).success ||
    Buffer.from(configuration.encryptionKey).equals(
      Buffer.from(configuration.sourceAuthenticationKey),
    )
  )
    fail('INVALID_CAPTURE_CONFIGURATION');
  const expected = parsed.data,
    key = Buffer.from(configuration.encryptionKey),
    authKey = Buffer.from(configuration.sourceAuthenticationKey);
  const store = configuration.store,
    snapshots = configuration.snapshots,
    keyId = configuration.encryptionKeyId,
    sourceKeyId = configuration.sourceKeyId;
  async function capture(input: { signal?: AbortSignal } = {}) {
    const owned: CurrentSourceEncryptedObject[] = [];
    async function publish(objectId: string, owner: string, body: unknown) {
      cancelled(input.signal);
      const bytes = encrypt(body, key, keyId, owner, objectId);
      const descriptor = descriptorSchema.parse(
        await store.put({
          objectId,
          owner,
          bytes,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      if (
        descriptor.objectId !== objectId ||
        descriptor.owner !== owner ||
        descriptor.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
        descriptor.byteLength !== bytes.length
      )
        fail('OBJECT_READBACK_MISMATCH');
      owned.push(descriptor);
      const remote = await store.read(objectId, descriptor.versionId, input.signal);
      const read = descriptorSchema.parse(remote.descriptor);
      if (canonical(read) !== canonical(descriptor) || !Buffer.from(remote.bytes).equals(bytes))
        fail('OBJECT_READBACK_MISMATCH');
      readback(Buffer.from(remote.bytes), key, keyId, owner, objectId, body);
      return descriptor;
    }
    try {
      return await snapshots.withSnapshot(async (snapshot) => {
        cancelled(input.signal);
        if (
          !uuid.safeParse(snapshot.captureId).success ||
          !uuid.safeParse(snapshot.generationId).success ||
          !lsn.safeParse(snapshot.baselineLsn).success ||
          !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{8}-[0-9]+$/.test(snapshot.snapshotId) ||
          canonical(snapshot.source) !== canonical(expected.source)
        )
          fail('SNAPSHOT_BINDING_MISMATCH');
        const capture = await captureCurrentSourceCatalogIn(snapshot.tx, expected);
        const generation = z
          .strictObject({ generationId: uuid })
          .parse(
            (
              await snapshot.tx.query(
                'SELECT public.current_restore_generation() AS "generationId"',
              )
            ).rows[0],
          );
        if (generation.generationId !== snapshot.generationId) fail('SNAPSHOT_BINDING_MISMATCH');
        if (capture.snapshot.transactionSnapshot !== snapshot.transactionSnapshot)
          fail('SNAPSHOT_BINDING_MISMATCH');
        const census = capture.census;
        const discovered = census
          .map((r) => (r.schema === 'public' ? r.relation : `${r.schema}.${r.relation}`))
          .sort();
        if (canonical(discovered) !== canonical([...currentSourcePhysicalRelations].sort()))
          fail('CENSUS_MISMATCH');
        const groups: { relation: string; rows: z.infer<typeof rawRow>[]; count: string }[] = [];
        let bytes = 0n,
          rows = 0n;
        for (const relation of currentSourcePhysicalRelations) {
          cancelled(input.signal);
          const projection = currentSourcePhysicalSql(relation);
          const scalar = z
            .strictObject({
              count: z.string().regex(/^\d+$/),
              bytes: z.string().regex(/^\d+$/),
              maximum: z.string().regex(/^\d+$/),
            })
            .parse(
              (
                await snapshot.tx.query(
                  `WITH encoded AS(SELECT ${projection.row} AS row,${projection.layouts} AS "arrayLayouts",${projection.floatSigns} AS "floatSigns" FROM ONLY ${projection.table} t) SELECT count(*)::text AS count,COALESCE(sum(octet_length(to_jsonb(encoded)::text)),0)::text AS bytes,COALESCE(max(octet_length(to_jsonb(encoded)::text)),0)::text AS maximum FROM encoded`,
                )
              ).rows[0],
            );
          const actual = census.find(
            (c) => c.schema === projection.schema && c.relation === projection.name,
          );
          if (!actual || actual.rows !== scalar.count) fail('CENSUS_MISMATCH');
          bytes += BigInt(scalar.bytes);
          rows += BigInt(scalar.count);
          if (
            bytes > BigInt(bytesLimit) ||
            rows > 5000n ||
            BigInt(scalar.maximum) > 4n * 1024n * 1024n
          )
            fail('PHYSICAL_CAPTURE_LIMIT');
          const raw = await snapshot.tx.query(
            `SELECT ${projection.row} AS row,${projection.layouts} AS "arrayLayouts",${projection.floatSigns} AS "floatSigns" FROM ONLY ${projection.table} t`,
          );
          plain(raw.rows);
          const actualRows = z.array(rawRow).max(5000).parse(raw.rows);
          if (BigInt(actualRows.length) !== BigInt(scalar.count)) fail('CENSUS_MISMATCH');
          const definition = currentSourcePhysicalDefinition(relation);
          const floatNames = definition.columns
            .filter((c) => c.type === 'double precision')
            .map((c) => c.name)
            .sort();
          for (const row of actualRows) {
            if (canonical(Object.keys(row.floatSigns).sort()) !== canonical(floatNames))
              fail('PHYSICAL_CODEC_UNAVAILABLE');
            for (const name of floatNames) {
              const value = row.row[name],
                binary = row.floatSigns[name];
              if (value === null) {
                if (binary !== null) fail('PHYSICAL_CODEC_UNAVAILABLE');
                continue;
              }
              const number =
                typeof value === 'number'
                  ? value
                  : value === '-0'
                    ? -0
                    : value === 'NaN'
                      ? NaN
                      : value === 'Infinity'
                        ? Infinity
                        : value === '-Infinity'
                          ? -Infinity
                          : null;
              if (number === null || typeof binary !== 'string') fail('PHYSICAL_CODEC_UNAVAILABLE');
              if (value === 'NaN') {
                if (!Number.isNaN(Buffer.from(binary, 'hex').readDoubleBE()))
                  fail('PHYSICAL_CODEC_UNAVAILABLE');
                continue;
              }
              const encoding = Buffer.alloc(8);
              encoding.writeDoubleBE(number);
              if (encoding.toString('hex') !== binary) fail('PHYSICAL_CODEC_UNAVAILABLE');
            }
          }
          actualRows.sort((a, b) => {
            const x = canonical(definition.primaryKey.map((k) => a.row[k])),
              y = canonical(definition.primaryKey.map((k) => b.row[k]));
            return x < y ? -1 : x > y ? 1 : 0;
          });
          for (let index = 1; index < actualRows.length; index++) {
            const a = actualRows[index - 1],
              b = actualRows[index];
            if (!a || !b) fail('PHYSICAL_CODEC_UNAVAILABLE');
            if (
              canonical(definition.primaryKey.map((k) => a.row[k])) ===
              canonical(definition.primaryKey.map((k) => b.row[k]))
            )
              fail('PHYSICAL_CODEC_UNAVAILABLE');
          }
          groups.push({ relation, rows: actualRows, count: scalar.count });
        }
        function partition(relations: readonly string[], kind: 'parent' | 'extra' | 'child') {
          const selected = groups
            .filter((g) => relations.includes(g.relation))
            .sort((a, b) => relations.indexOf(a.relation) - relations.indexOf(b.relation));
          const entries = selected
            .flatMap((g) =>
              g.rows.map((r) => ({
                relation: g.relation,
                row: r.row,
                ...(kind === 'extra' ? { arrayLayouts: r.arrayLayouts } : {}),
              })),
            )
            .map((r, i) => ({ ordinal: i + 1, ...r }));
          try {
            if (kind === 'parent') parseCurrentParentPhysicalRowsV2(entries);
            else if (kind === 'extra') parseCurrentSourceExtraPhysicalRows(entries);
            else if (entries.length) parseCurrentFamilyPhysicalRows(entries);
          } catch {
            fail('PHYSICAL_CODEC_UNAVAILABLE');
          }
          return {
            kind,
            rows: entries,
            physicalEvidence: selected.map((g) => ({
              relation: g.relation,
              rows: g.rows.map((r) => ({
                arrayLayouts: r.arrayLayouts,
                floatSigns: r.floatSigns,
              })),
            })),
            census: selected.map((g) => ({ relation: g.relation, count: g.count })),
            state: entries.length
              ? 'nonempty_physical_partition'
              : 'independent_actual_census_zero',
          };
        }
        const parentOrder = CURRENT_PARENT_RELATIONS.filter((r) =>
          CURRENT_PARENT_TYPED_RELATIONS.some((t) => t === r),
        );
        const packets = [];
        for (const p of [
          partition(parentOrder, 'parent'),
          partition(currentSourceExtraRelations, 'extra'),
          partition(currentFamilyRelations, 'child'),
        ])
          packets.push(
            await publish(`${snapshot.captureId}_${p.kind}`, snapshot.captureId, {
              profile: 'normal107-explicit108-116',
              source: expected.source,
              snapshotId: snapshot.snapshotId,
              transactionSnapshot: snapshot.transactionSnapshot,
              baselineLsn: snapshot.baselineLsn,
              generationId: snapshot.generationId,
              partition: p,
            }),
          );
        cancelled(input.signal);
        const archive = await snapshot.archive({
          snapshotId: snapshot.snapshotId,
          captureId: snapshot.captureId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (
          archive.snapshotId !== snapshot.snapshotId ||
          archive.baselineLsn !== snapshot.baselineLsn ||
          canonical(archive.source) !== canonical(expected.source) ||
          archive.descriptor.owner !== snapshot.captureId
        )
          fail('SNAPSHOT_BINDING_MISMATCH');
        const archiveDescriptor = descriptorSchema.parse(archive.descriptor);
        owned.push(archiveDescriptor);
        const archiveReadback = await store.read(
          archiveDescriptor.objectId,
          archiveDescriptor.versionId,
          input.signal,
        );
        if (
          canonical(descriptorSchema.parse(archiveReadback.descriptor)) !==
            canonical(archiveDescriptor) ||
          archiveReadback.bytes.byteLength !== archiveDescriptor.byteLength ||
          createHash('sha256').update(archiveReadback.bytes).digest('hex') !==
            archiveDescriptor.sha256
        )
          fail('OBJECT_READBACK_MISMATCH');
        const final = await snapshot.tx.query('SELECT txid_current_snapshot()::text AS snapshot');
        if (final.rows[0]?.['snapshot'] !== snapshot.transactionSnapshot)
          fail('SNAPSHOT_BINDING_MISMATCH');
        const body = {
          formatVersion: 1,
          sourceKeyId,
          profile: 'normal107-explicit108-116',
          captureId: snapshot.captureId,
          generationId: snapshot.generationId,
          source: expected.source,
          snapshotId: snapshot.snapshotId,
          transactionSnapshot: snapshot.transactionSnapshot,
          baselineLsn: snapshot.baselineLsn,
          installedProfile: capture.profile,
          operatorSnapshot: capture.snapshot,
          catalog: capture.catalog,
          catalogSha256: capture.catalogSha256,
          census,
          packets,
          archive: archive.descriptor,
          limits,
        };
        plain(body);
        const bodyDigest = digest(body);
        const signature = createHmac('sha256', authKey)
          .update('wm-current-whole-source-baseline-v1\0')
          .update(canonical(body))
          .digest('hex');
        const signatureCheck = createHmac('sha256', authKey)
          .update('wm-current-whole-source-baseline-v1\0')
          .update(canonical(body))
          .digest();
        if (!timingSafeEqual(Buffer.from(signature, 'hex'), signatureCheck))
          fail('OBJECT_READBACK_MISMATCH');
        const manifest = await publish(`${snapshot.captureId}_manifest`, snapshot.captureId, {
          body,
          bodyDigest,
          sourceKeyId,
          signature,
        });
        return {
          status: 'baseline_captured' as const,
          manifest,
          packets,
          archive: archive.descriptor,
          bodyDigest,
          source: expected.source,
          limits,
        };
      }, input.signal);
    } catch (error) {
      const cleanup = await Promise.allSettled(owned.map((d) => store.removeOwned(d)));
      if (cleanup.some((r) => r.status === 'rejected')) fail('CLEANUP_FAILED');
      throw error;
    }
  }
  // One configured capture-service lifetime is one baseline operation. Repeated
  // callers observe the original immutable result/failure, never mint a new snapshot.
  let operation: ReturnType<typeof capture> | undefined;
  return {
    capture(input: { signal?: AbortSignal } = {}) {
      cancelled(input.signal);
      operation ??= capture(input);
      return operation;
    },
  };
}

export type CurrentSourceBaselineCapture = Awaited<
  ReturnType<ReturnType<typeof createCurrentSourceCaptureService>['capture']>
>;
