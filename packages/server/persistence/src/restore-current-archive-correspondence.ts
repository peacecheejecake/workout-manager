import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createCurrentSourceReceiver,
  type CurrentSourceReceiverConfiguration,
  type VerifiedCurrentSourceRead,
} from './restore-current-source-receiver.js';
import { type CurrentSourceCaptureTransaction } from './restore-current-source-catalog.js';
import {
  currentSourcePhysicalRelations,
  currentSourcePhysicalDefinition,
  currentSourcePhysicalSql,
} from './restore-current-source-projections.js';

export class CurrentArchiveCorrespondenceError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CONFIGURATION'
      | 'KEY_UNAVAILABLE'
      | 'ARCHIVE_CONTEXT_MISMATCH'
      | 'ARCHIVE_ROW_MISMATCH'
      | 'ARCHIVE_LIMIT'
      | 'VERIFY_ABORTED',
  ) {
    super(code);
  }
}
function fail(code: CurrentArchiveCorrespondenceError['code']): never {
  throw new CurrentArchiveCorrespondenceError(code);
}
/** Exact JSON UTF8 size is charged before serialization or cloning. The global
 * node/key bounds derive from this byte ceiling, not the 5000 source-ref cap.
 * Dense arrays need at least one byte per value; object property syntax costs
 * more. Counting array length keys permits at most twice the byte ceiling.
 */
function clone<T>(value: T, cloneBytes = 4 * 1024 * 1024): T {
  const active = new Set<object>();
  let bytes = 0,
    nodes = 0,
    ownKeys = 0;
  function charge(amount: number) {
    bytes += amount;
    if (bytes > cloneBytes) fail('INVALID_CONFIGURATION');
  }
  function stringBytes(text: string) {
    // One UTF16 code unit needs at least one JSON byte; fail before UTF8 scan.
    if (text.length > cloneBytes - bytes - 2) fail('INVALID_CONFIGURATION');
    charge(2 + Buffer.byteLength(text, 'utf8'));
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (
        code === 34 ||
        code === 92 ||
        code === 8 ||
        code === 9 ||
        code === 10 ||
        code === 12 ||
        code === 13
      )
        charge(1);
      else if (code < 32) charge(5);
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
        else charge(3); // JSON escapes lone surrogate (6), UTF8 replacement was 3.
      } else if (code >= 0xdc00 && code <= 0xdfff) charge(3);
    }
  }
  function walk(item: unknown, depth: number): void {
    if (depth > 64 || ++nodes > cloneBytes + 1) fail('INVALID_CONFIGURATION');
    if (item === null) {
      charge(4);
      return;
    }
    if (typeof item === 'string') {
      stringBytes(item);
      return;
    }
    if (typeof item === 'boolean') {
      charge(item ? 4 : 5);
      return;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      charge(JSON.stringify(item).length);
      return;
    }
    if (typeof item !== 'object' || active.has(item)) fail('INVALID_CONFIGURATION');
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (proto !== (array ? Array.prototype : Object.prototype) && proto !== null)
      fail('INVALID_CONFIGURATION');
    if (array && item.length > cloneBytes) fail('INVALID_CONFIGURATION');
    active.add(item);
    const keys = Reflect.ownKeys(item);
    ownKeys += keys.length;
    if (ownKeys > cloneBytes * 2) fail('INVALID_CONFIGURATION');
    if (
      array &&
      (keys.length !== item.length + 1 ||
        keys.some(
          (key) =>
            key !== 'length' &&
            (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length),
        ))
    )
      fail('INVALID_CONFIGURATION');
    charge(2);
    let entries = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (
        typeof key !== 'string' ||
        !descriptor ||
        !('value' in descriptor) ||
        !descriptor.enumerable
      )
        fail('INVALID_CONFIGURATION');
      if (entries++) charge(1);
      if (!array) {
        stringBytes(key);
        charge(1);
      }
      walk(descriptor.value, depth + 1);
    }
    active.delete(item);
  }
  walk(value, 0);
  // At most 4MiB is allocated now; all JSON values/properties were inspected.
  if (Buffer.byteLength(JSON.stringify(value)) !== bytes) fail('INVALID_CONFIGURATION');
  return structuredClone(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const decimal = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/);
const targetSchema = z.strictObject({
  databaseName: z.string().min(1).max(63),
  databaseOid: decimal,
  roleName: z.string().min(1).max(63),
  roleOid: decimal,
});
const scalarSchema = z.strictObject({ count: decimal, bytes: decimal, maximum: decimal });
const physicalSchema = z.strictObject({
  row: z.record(z.string(), z.json()),
  arrayLayouts: z.record(z.string(), z.json()),
  floatSigns: z.record(
    z.string(),
    z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .nullable(),
  ),
});
export type CurrentArchiveRestorationBinding = Readonly<{
  descriptor: VerifiedCurrentSourceRead['manifest']['archive'];
  source: VerifiedCurrentSourceRead['manifest']['source'];
  capture: Pick<
    VerifiedCurrentSourceRead['manifest'],
    'captureId' | 'generationId' | 'snapshotId' | 'transactionSnapshot' | 'baselineLsn'
  >;
}>;
export type CurrentArchiveCorrespondenceConfiguration = Readonly<{
  source: Omit<CurrentSourceReceiverConfiguration, 'encryptionKey' | 'sourceAuthenticationKey'>;
  resolveKeys(
    ids: Readonly<{ encryptionKeyId: string; sourceKeyId: string }>,
  ): Promise<Readonly<{ encryptionKey: Uint8Array; sourceAuthenticationKey: Uint8Array }> | null>;
  target: z.infer<typeof targetSchema>;
  /** Trusted server I/O: read this EXACT immutable ciphertext, authenticate archive
   * encryption, pg_restore into the pinned disposable DB and hold RR READ ONLY.
   * This callback is not a JSON authentication credential; implementation/provisioning
   * is independently verified by integration, never inferred from a completion flag.
   */
  withRestoredArchive<T>(
    binding: CurrentArchiveRestorationBinding,
    consume: (tx: CurrentSourceCaptureTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}>;
const limits = Object.freeze({
  authority: 'none' as const,
  admissionAllowed: false as const,
  archiveRowCorrespondence: 'verified_against_authenticated_packets' as const,
  archiveOrigin: 'configured_restoration_port' as const,
  catalogFidelity: 'fixed_projection_and_registry_only' as const,
  targetClosedAdmission: 'not_verified' as const,
  wholeWalTail: 'not_captured' as const,
  latestTail: 'not_checked' as const,
  sequenceFence: 'not_captured_non_mvcc' as const,
  targetTransforms: 'not_implemented' as const,
  operationalKeyProvenance: 'external_gate' as const,
});
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) fail('VERIFY_ABORTED');
}
async function compare(
  tx: CurrentSourceCaptureTransaction,
  read: VerifiedCurrentSourceRead,
  target: z.infer<typeof targetSchema>,
  signal?: AbortSignal,
) {
  const context = z
    .strictObject({
      ...targetSchema.shape,
      sessionRole: z.string(),
      isolation: z.string(),
      readOnly: z.boolean(),
      statementTimeout: decimal,
    })
    .safeParse(
      (
        await tx.query(
          `SELECT current_database() AS "databaseName",d.oid::text AS "databaseOid",current_user AS "roleName",r.oid::text AS "roleOid",session_user AS "sessionRole",current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only')='on' AS "readOnly",(SELECT setting FROM pg_settings WHERE name='statement_timeout') AS "statementTimeout" FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`,
        )
      ).rows[0],
    );
  if (!context.success) fail('ARCHIVE_CONTEXT_MISMATCH');
  const c = context.data;
  if (
    c.databaseName !== target.databaseName ||
    c.databaseOid !== target.databaseOid ||
    c.roleName !== target.roleName ||
    c.roleOid !== target.roleOid ||
    c.sessionRole !== c.roleName ||
    !c.readOnly ||
    !['repeatable read', 'serializable'].includes(c.isolation) ||
    BigInt(c.statementTimeout) === 0n ||
    BigInt(c.statementTimeout) > 60000n ||
    target.databaseName === read.manifest.source.databaseName ||
    target.databaseOid === read.manifest.source.databaseOid
  )
    fail('ARCHIVE_CONTEXT_MISMATCH');
  const registry = z
    .array(
      z.strictObject({ version: z.number().int(), checksum: z.string().regex(/^[a-f0-9]{64}$/) }),
    )
    .max(107)
    .safeParse(
      (await tx.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version'))
        .rows,
    );
  const catalog = read.manifest.catalog;
  if (
    !registry.success ||
    !catalog ||
    typeof catalog !== 'object' ||
    Array.isArray(catalog) ||
    !Object.hasOwn(catalog, 'registry') ||
    canonical(registry.data) !== canonical(catalog['registry'])
  )
    fail('ARCHIVE_CONTEXT_MISMATCH');
  const inventory = z
    .array(z.strictObject({ relation: z.string(), readable: z.boolean(), filtered: z.boolean() }))
    .max(222)
    .safeParse(
      (
        await tx.query(
          `SELECT CASE WHEN n.nspname='public' THEN c.relname ELSE n.nspname||'.'||c.relname END AS relation,has_table_privilege(c.oid,'SELECT') AS readable,row_security_active(c.oid) AS filtered FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p')`,
        )
      ).rows,
    );
  if (
    !inventory.success ||
    inventory.data.some((r) => !r.readable || r.filtered) ||
    canonical(inventory.data.map((r) => r.relation).sort()) !==
      canonical([...currentSourcePhysicalRelations].sort())
  )
    fail('ARCHIVE_CONTEXT_MISMATCH');
  let totalBytes = 0n,
    totalRows = 0n;
  const census: { relation: string; count: string; rowDigest: string }[] = [];
  for (const relation of currentSourcePhysicalRelations) {
    cancelled(signal);
    const sql = currentSourcePhysicalSql(relation),
      def = currentSourcePhysicalDefinition(relation);
    const partition = read.packets.find((p) =>
      p.partition.census.some((r) => r.relation === relation),
    )?.partition;
    const evidence = partition?.physicalEvidence.find((r) => r.relation === relation);
    const expectedRows = partition?.rows.filter((r) => r.relation === relation);
    if (!evidence || !expectedRows || expectedRows.length !== evidence.rows.length)
      fail('ARCHIVE_ROW_MISMATCH');
    const scalar = scalarSchema.safeParse(
      (
        await tx.query(
          `WITH encoded AS(SELECT ${sql.row} AS row,${sql.layouts} AS "arrayLayouts",${sql.floatSigns} AS "floatSigns" FROM ONLY ${sql.table} t) SELECT count(*)::text AS count,COALESCE(sum(octet_length(to_jsonb(encoded)::text)),0)::text AS bytes,COALESCE(max(octet_length(to_jsonb(encoded)::text)),0)::text AS maximum FROM encoded`,
        )
      ).rows[0],
    );
    if (!scalar.success) fail('ARCHIVE_ROW_MISMATCH');
    if (BigInt(scalar.data.count) !== BigInt(expectedRows.length)) fail('ARCHIVE_ROW_MISMATCH');
    totalBytes += BigInt(scalar.data.bytes);
    totalRows += BigInt(scalar.data.count);
    if (totalBytes > 16777216n || totalRows > 5000n || BigInt(scalar.data.maximum) > 4194304n)
      fail('ARCHIVE_LIMIT');
    const raw = (
      await tx.query(
        `SELECT ${sql.row} AS row,${sql.layouts} AS "arrayLayouts",${sql.floatSigns} AS "floatSigns" FROM ONLY ${sql.table} t`,
      )
    ).rows;
    clone(raw, 16 * 1024 * 1024);
    const parsed = z.array(physicalSchema).max(5000).safeParse(raw);
    if (!parsed.success || parsed.data.length !== expectedRows.length) fail('ARCHIVE_ROW_MISMATCH');
    const rows = parsed.data.sort((a, b) => {
      const x = canonical(def.primaryKey.map((k) => a.row[k])),
        y = canonical(def.primaryKey.map((k) => b.row[k]));
      return x < y ? -1 : x > y ? 1 : 0;
    });
    const digest = createHash('sha256').update(
      'wm-archive-packet-physical-row-correspondence-v1\0',
    );
    for (const [index, row] of rows.entries()) {
      const expected = expectedRows[index],
        physical = evidence.rows[index];
      if (!expected || !physical) fail('ARCHIVE_ROW_MISMATCH');
      clone(row);
      const exact = {
        row: expected.row,
        arrayLayouts: physical.arrayLayouts,
        floatSigns: physical.floatSigns,
      };
      if (canonical(row) !== canonical(exact)) fail('ARCHIVE_ROW_MISMATCH');
      digest.update(canonical(row)).update('\0');
    }
    census.push({ relation, count: scalar.data.count, rowDigest: digest.digest('hex') });
  }
  return {
    status: 'archive_rows_correspond' as const,
    profile: 'normal107-explicit108-116' as const,
    captureId: read.manifest.captureId,
    generationId: read.manifest.generationId,
    source: clone(read.manifest.source),
    archive: clone(read.manifest.archive),
    target: clone(target),
    census,
    digestMethod: 'wm-archive-packet-physical-row-correspondence-v1' as const,
    limits,
  };
}
/** Verifies fixed116 rows, not current/latest source, WAL, sequence, or target admission.
 * Source HMAC/AEAD is refreshed on EVERY call. No public or constructible handle.
 */
export function createCurrentArchiveCorrespondenceVerifier(
  configuration: CurrentArchiveCorrespondenceConfiguration,
) {
  const resolveKeys = configuration.resolveKeys,
    restore = configuration.withRestoredArchive;
  if (
    typeof resolveKeys !== 'function' ||
    typeof restore !== 'function' ||
    typeof configuration.source.store.read !== 'function'
  )
    fail('INVALID_CONFIGURATION');
  const readObject = configuration.source.store.read.bind(configuration.source.store);
  const { store: _store, ...metadata } = configuration.source;
  const pinned = clone(metadata),
    target = targetSchema.parse(clone(configuration.target));
  return Object.freeze({
    async verify(options: { signal?: AbortSignal } = {}) {
      cancelled(options.signal);
      const keys = await resolveKeys(
        Object.freeze({ encryptionKeyId: pinned.encryptionKeyId, sourceKeyId: pinned.sourceKeyId }),
      );
      if (!keys) fail('KEY_UNAVAILABLE');
      const receiver = createCurrentSourceReceiver({
        ...clone(pinned),
        store: { read: readObject },
        encryptionKey: new Uint8Array(keys.encryptionKey),
        sourceAuthenticationKey: new Uint8Array(keys.sourceAuthenticationKey),
      });
      const handle = await receiver.receive(clone(pinned.expectedManifest), options);
      return await receiver.withVerifiedCurrentSource(handle, async (read) => {
        const { captureId, generationId, snapshotId, transactionSnapshot, baselineLsn } =
          read.manifest;
        const binding = clone({
          descriptor: read.manifest.archive,
          source: read.manifest.source,
          capture: { captureId, generationId, snapshotId, transactionSnapshot, baselineLsn },
        });
        let calls = 0;
        let observed: ReturnType<typeof compare> | undefined;
        await restore(
          binding,
          async (tx) => {
            if (++calls !== 1) fail('ARCHIVE_CONTEXT_MISMATCH');
            observed = compare(tx, read, target, options.signal);
            return await observed;
          },
          options.signal,
        );
        if (calls !== 1 || !observed) fail('ARCHIVE_CONTEXT_MISMATCH');
        return await observed;
      });
    },
  });
}
