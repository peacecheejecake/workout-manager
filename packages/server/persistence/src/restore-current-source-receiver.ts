import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  currentSourceCatalogExpectedSchema,
  parseCurrentSourceCatalogMetadata,
  type CurrentSourceCatalogExpected,
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
} from './restore-current-source-projections.js';

const maximum = 16 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const decimal = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/);
const descriptor = z.strictObject({
  objectId: identifier,
  versionId: z.string().min(1).max(200),
  owner: z.uuid(),
  sha256: hash,
  byteLength: z
    .number()
    .int()
    .min(1)
    .max(maximum + 4096),
});
const binding = z.strictObject({
  captureId: z.uuid(),
  generationId: z.uuid(),
  snapshotId: z.string().min(1).max(200),
  transactionSnapshot: z.string().regex(/^[0-9]+:[0-9]+:[0-9,]*$/),
  baselineLsn: z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/),
});
const originalLimits = z.strictObject({
  authority: z.literal('none'),
  admissionAllowed: z.literal(false),
  wholeWalTail: z.literal('not_captured'),
  sequenceFence: z.literal('not_captured_non_mvcc'),
  latestTail: z.literal('not_checked'),
  targetTransforms: z.literal('not_implemented'),
  archiveRowCorrespondence: z.literal('not_verified'),
});
const entry = z.strictObject({
  ordinal: z.number().int().min(1).max(5000),
  relation: z.string().min(1).max(200),
  row: z.record(z.string(), z.json()),
  arrayLayouts: z.record(z.string(), z.json()).optional(),
});
const evidenceRow = z.strictObject({
  arrayLayouts: z.record(z.string(), z.json()),
  floatSigns: z.record(
    z.string(),
    z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .nullable(),
  ),
});
const partition = z.strictObject({
  kind: z.enum(['parent', 'extra', 'child']),
  rows: z.array(entry).max(5000),
  physicalEvidence: z
    .array(z.strictObject({ relation: z.string(), rows: z.array(evidenceRow).max(5000) }))
    .max(222),
  census: z.array(z.strictObject({ relation: z.string(), count: decimal })).max(222),
  state: z.enum(['nonempty_physical_partition', 'independent_actual_census_zero']),
});
const packet = z.strictObject({
  profile: z.literal('normal107-explicit108-116'),
  source: currentSourceCatalogExpectedSchema.shape.source,
  snapshotId: binding.shape.snapshotId,
  transactionSnapshot: binding.shape.transactionSnapshot,
  baselineLsn: binding.shape.baselineLsn,
  generationId: z.uuid(),
  partition,
});
const body = z.strictObject({
  formatVersion: z.literal(1),
  sourceKeyId: identifier,
  profile: z.literal('normal107-explicit108-116'),
  ...binding.shape,
  source: currentSourceCatalogExpectedSchema.shape.source,
  installedProfile: z.strictObject({
    profileVersion: z.literal(1),
    normalSchemaVersion: z.literal(107),
    explicitPins: currentSourceCatalogExpectedSchema.shape.explicitPins,
  }),
  operatorSnapshot: z.strictObject({
    transactionSnapshot: binding.shape.transactionSnapshot,
    isolation: z.enum(['repeatable read', 'serializable']),
    readOnly: z.literal(true),
    roleName: z.string(),
    roleOid: decimal,
    statementTimeout: z.string().min(1).max(32),
  }),
  catalog: z.json(),
  catalogSha256: hash,
  census: z
    .array(
      z.strictObject({
        schema: z.string(),
        relation: z.string(),
        rows: decimal,
        rowStorageBytes: decimal,
      }),
    )
    .length(222),
  packets: z.array(descriptor).length(3),
  archive: descriptor,
  limits: originalLimits,
});
const manifest = z.strictObject({
  body,
  bodyDigest: hash,
  sourceKeyId: identifier,
  signature: hash,
});
const readLimits = Object.freeze({
  authority: 'none' as const,
  admissionAllowed: false as const,
  sourceAuthentication: 'configured_source_hmac_and_packet_aead' as const,
  catalogCorrespondence: 'independently_pinned_bytes_only' as const,
  archiveCiphertextReadback: 'verified' as const,
  archiveEncryptionFormat: 'not_verified_by_packet_codec' as const,
  archiveRowCorrespondence: 'not_verified' as const,
  wholeWalTail: 'not_captured' as const,
  latestTail: 'not_checked' as const,
  sequenceFence: 'not_captured_non_mvcc' as const,
  targetTransforms: 'not_implemented' as const,
  operationalKeyProvenance: 'external_gate' as const,
});
export type CurrentSourceReceiverLimits = typeof readLimits;
export class CurrentSourceReceiverError extends Error {
  constructor(
    readonly code:
      | 'INVALID_RECEIVER_CONFIGURATION'
      | 'INVALID_SOURCE_OBJECT'
      | 'SOURCE_BINDING_MISMATCH'
      | 'SOURCE_AUTHENTICATION_FAILED'
      | 'PHYSICAL_CORRESPONDENCE_FAILED'
      | 'SOURCE_RECEIVER_LIMIT'
      | 'INVALID_VERIFIED_HANDLE'
      | 'RECEIVE_ABORTED',
  ) {
    super(code);
  }
}
function fail(code: CurrentSourceReceiverError['code']): never {
  throw new CurrentSourceReceiverError(code);
}
function plain(raw: unknown, cap = maximum): void {
  let nodes = 0;
  const active = new Set<object>();
  function walk(v: unknown, depth: number): void {
    if (depth > 64 || ++nodes > maximum) fail('SOURCE_RECEIVER_LIMIT');
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
      fail('INVALID_SOURCE_OBJECT');
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      fail('INVALID_SOURCE_OBJECT');
    active.add(v);
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && k === 'length') continue;
      if (!d.enumerable || !('value' in d)) fail('INVALID_SOURCE_OBJECT');
      walk(d.value, depth + 1);
    }
    active.delete(v);
  }
  walk(raw, 0);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > cap) fail('SOURCE_RECEIVER_LIMIT');
}
function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number')
    return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return fail('INVALID_SOURCE_OBJECT');
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function digest(v: unknown): string {
  return createHash('sha256').update(canonical(v)).digest('hex');
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  plain(raw);
  const r = schema.safeParse(raw);
  if (!r.success) fail('INVALID_SOURCE_OBJECT');
  return r.data;
}
function decrypt(
  bytes: Buffer,
  d: z.infer<typeof descriptor>,
  key: Buffer,
  keyId: string,
): unknown {
  if (bytes.length < 40 || bytes.subarray(0, 8).toString() !== 'WMCUR001')
    fail('SOURCE_AUTHENTICATION_FAILED');
  const n = bytes.readUInt32BE(8);
  if (n < 1 || n > 1024 || bytes.length < n + 40) fail('SOURCE_AUTHENTICATION_FAILED');
  const header = bytes.subarray(12, 12 + n);
  if (
    header.toString() !== JSON.stringify({ format: 1, keyId, owner: d.owner, objectId: d.objectId })
  )
    fail('SOURCE_AUTHENTICATION_FAILED');
  let text: string;
  try {
    const c = createDecipheriv('aes-256-gcm', key, bytes.subarray(12 + n, 24 + n));
    c.setAAD(header);
    c.setAuthTag(bytes.subarray(24 + n, 40 + n));
    text = Buffer.concat([c.update(bytes.subarray(40 + n)), c.final()]).toString('utf8');
  } catch {
    fail('SOURCE_AUTHENTICATION_FAILED');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    fail('INVALID_SOURCE_OBJECT');
  }
  plain(decoded);
  if (text !== canonical(decoded)) fail('INVALID_SOURCE_OBJECT');
  return decoded;
}
const parentRelations = CURRENT_PARENT_RELATIONS.filter((r) =>
  CURRENT_PARENT_TYPED_RELATIONS.some((t) => t === r),
);
const groups = {
  parent: parentRelations,
  extra: currentSourceExtraRelations,
  child: currentFamilyRelations,
};
function verifyPartition(p: z.infer<typeof partition>): number {
  const roster = groups[p.kind];
  if (
    !same(
      p.census.map((r) => r.relation),
      roster,
    ) ||
    !same(
      p.physicalEvidence.map((r) => r.relation),
      roster,
    ) ||
    p.state !== (p.rows.length ? 'nonempty_physical_partition' : 'independent_actual_census_zero')
  )
    fail('PHYSICAL_CORRESPONDENCE_FAILED');
  let index = 0,
    encodedRowBytes = 0;
  for (const [ri, relation] of roster.entries()) {
    const count = p.census[ri],
      e = p.physicalEvidence[ri];
    if (!count || !e || BigInt(count.count) !== BigInt(e.rows.length))
      fail('PHYSICAL_CORRESPONDENCE_FAILED');
    const def = currentSourcePhysicalDefinition(relation);
    const arrays = def.columns
      .filter((c) => c.type.endsWith('[]'))
      .map((c) => c.name)
      .sort();
    const floats = def.columns
      .filter((c) => c.type === 'double precision')
      .map((c) => c.name)
      .sort();
    let prior: string | undefined;
    for (const physical of e.rows) {
      const row = p.rows[index];
      if (!row || row.relation !== relation || row.ordinal !== index + 1)
        fail('PHYSICAL_CORRESPONDENCE_FAILED');
      index++;
      const encodedRow = {
        row: row.row,
        arrayLayouts: physical.arrayLayouts,
        floatSigns: physical.floatSigns,
      };
      plain(encodedRow, 4 * 1024 * 1024);
      encodedRowBytes += Buffer.byteLength(canonical(encodedRow));
      if (encodedRowBytes > maximum) fail('SOURCE_RECEIVER_LIMIT');
      if (
        !same(Object.keys(physical.arrayLayouts).sort(), arrays) ||
        !same(Object.keys(physical.floatSigns).sort(), floats) ||
        (p.kind === 'extra' && !same(row.arrayLayouts, physical.arrayLayouts)) ||
        (p.kind !== 'extra' && row.arrayLayouts !== undefined)
      )
        fail('PHYSICAL_CORRESPONDENCE_FAILED');
      const pk = canonical(def.primaryKey.map((k) => row.row[k]));
      if (prior !== undefined && pk <= prior) fail('PHYSICAL_CORRESPONDENCE_FAILED');
      prior = pk;
      for (const name of floats) {
        const value = row.row[name],
          binary = physical.floatSigns[name];
        if (value === null) {
          if (binary !== null) fail('PHYSICAL_CORRESPONDENCE_FAILED');
          continue;
        }
        if (typeof binary !== 'string') fail('PHYSICAL_CORRESPONDENCE_FAILED');
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
        if (number === null) fail('PHYSICAL_CORRESPONDENCE_FAILED');
        if (Number.isNaN(number)) {
          if (!Number.isNaN(Buffer.from(binary, 'hex').readDoubleBE()))
            fail('PHYSICAL_CORRESPONDENCE_FAILED');
        } else {
          const b = Buffer.alloc(8);
          b.writeDoubleBE(number);
          if (b.toString('hex') !== binary) fail('PHYSICAL_CORRESPONDENCE_FAILED');
        }
      }
    }
  }
  if (index !== p.rows.length) fail('PHYSICAL_CORRESPONDENCE_FAILED');
  try {
    if (p.kind === 'parent') parseCurrentParentPhysicalRowsV2(p.rows);
    else if (p.kind === 'extra') parseCurrentSourceExtraPhysicalRows(p.rows);
    else if (p.rows.length) parseCurrentFamilyPhysicalRows(p.rows);
  } catch {
    fail('PHYSICAL_CORRESPONDENCE_FAILED');
  }
  return encodedRowBytes;
}
export type CurrentSourceReceiverConfiguration = Readonly<{
  expected: CurrentSourceCatalogExpected;
  /** Independently configured catalogue JSON. Its PostgreSQL text hash is the
   * expected.catalogSha256 pin; Node canonical hashing is a different namespace. */
  expectedCatalog: unknown;
  expectedCapture: z.infer<typeof binding>;
  expectedManifest: z.infer<typeof descriptor>;
  encryptionKey: Uint8Array;
  encryptionKeyId: string;
  sourceAuthenticationKey: Uint8Array;
  sourceKeyId: string;
  store: Readonly<{
    read(
      objectId: string,
      versionId: string,
      signal?: AbortSignal,
    ): Promise<{ descriptor: unknown; bytes: Uint8Array }>;
  }>;
}>;
export type VerifiedCurrentSourceRead = Readonly<{
  manifest: z.infer<typeof body>;
  packets: readonly z.infer<typeof packet>[];
  limits: CurrentSourceReceiverLimits;
}>;
/** The handle has no serialized credential. Only this exact configured factory
 * retains membership. It authenticates bytes, never restore admission/row truth. */
export function createCurrentSourceReceiver(configuration: CurrentSourceReceiverConfiguration) {
  let expected: CurrentSourceCatalogExpected,
    capture: z.infer<typeof binding>,
    manifestDescriptor: z.infer<typeof descriptor>,
    catalog: unknown;
  try {
    plain(configuration.expected);
    plain(configuration.expectedCapture);
    plain(configuration.expectedManifest);
    plain(configuration.expectedCatalog);
    expected = currentSourceCatalogExpectedSchema.parse(configuration.expected);
    capture = binding.parse(configuration.expectedCapture);
    manifestDescriptor = descriptor.parse(configuration.expectedManifest);
    catalog = parseCurrentSourceCatalogMetadata(configuration.expectedCatalog);
  } catch {
    fail('INVALID_RECEIVER_CONFIGURATION');
  }
  if (
    !(configuration.encryptionKey instanceof Uint8Array) ||
    !(configuration.sourceAuthenticationKey instanceof Uint8Array) ||
    configuration.encryptionKey.length !== 32 ||
    configuration.sourceAuthenticationKey.length !== 32 ||
    Buffer.from(configuration.encryptionKey).equals(
      Buffer.from(configuration.sourceAuthenticationKey),
    ) ||
    !identifier.safeParse(configuration.encryptionKeyId).success ||
    !identifier.safeParse(configuration.sourceKeyId).success ||
    manifestDescriptor.owner !== capture.captureId ||
    manifestDescriptor.objectId !== `${capture.captureId}_manifest` ||
    !same(
      [...expected.relations]
        .map((r) => (r.schema === 'public' ? r.name : `${r.schema}.${r.name}`))
        .sort(),
      [...currentSourcePhysicalRelations].sort(),
    )
  )
    fail('INVALID_RECEIVER_CONFIGURATION');
  const key = Buffer.from(configuration.encryptionKey),
    auth = Buffer.from(configuration.sourceAuthenticationKey),
    keyId = configuration.encryptionKeyId,
    sourceKeyId = configuration.sourceKeyId;
  const read = configuration.store.read.bind(configuration.store);
  const handles = new WeakMap<object, string>();
  function aborted(signal?: AbortSignal) {
    if (signal?.aborted) fail('RECEIVE_ABORTED');
  }
  async function object(d: z.infer<typeof descriptor>, signal?: AbortSignal) {
    aborted(signal);
    const response = await read(d.objectId, d.versionId, signal);
    aborted(signal);
    plain(response.descriptor);
    const observed = parse(descriptor, response.descriptor);
    if (
      !same(observed, d) ||
      !(response.bytes instanceof Uint8Array) ||
      response.bytes.byteLength !== d.byteLength
    )
      fail('INVALID_SOURCE_OBJECT');
    const bytes = Buffer.from(response.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== d.sha256)
      fail('INVALID_SOURCE_OBJECT');
    return bytes;
  }
  return {
    async receive(rawDescriptor: unknown, options: { signal?: AbortSignal } = {}) {
      const d = parse(descriptor, rawDescriptor);
      if (!same(d, manifestDescriptor)) fail('SOURCE_BINDING_MISMATCH');
      const m = parse(manifest, decrypt(await object(d, options.signal), d, key, keyId));
      const b = m.body;
      let observedCatalog;
      try {
        observedCatalog = parseCurrentSourceCatalogMetadata(b.catalog);
      } catch {
        fail('SOURCE_BINDING_MISMATCH');
      }
      if (
        !same(observedCatalog.registry, expected.normalRegistry) ||
        !same(
          observedCatalog.roles.map((r) => ({ tag: r.tag, name: r.name })),
          expected.roles,
        ) ||
        !same(observedCatalog.schemas.map((r) => r.name).sort(), [...expected.schemas].sort()) ||
        !same(
          observedCatalog.relations
            .filter((r) => r.kind === 'r' || r.kind === 'p')
            .map((r) => (r.schema === 'public' ? r.name : `${r.schema}.${r.name}`))
            .sort(),
          [...currentSourcePhysicalRelations].sort(),
        )
      )
        fail('SOURCE_BINDING_MISMATCH');
      if (
        m.sourceKeyId !== sourceKeyId ||
        b.sourceKeyId !== sourceKeyId ||
        m.bodyDigest !== digest(b)
      )
        fail('SOURCE_AUTHENTICATION_FAILED');
      const mac = createHmac('sha256', auth)
        .update('wm-current-whole-source-baseline-v1\0')
        .update(canonical(b))
        .digest();
      if (!timingSafeEqual(mac, Buffer.from(m.signature, 'hex')))
        fail('SOURCE_AUTHENTICATION_FAILED');
      if (
        !same(b.source, expected.source) ||
        !same(b.installedProfile, {
          profileVersion: 1,
          normalSchemaVersion: 107,
          explicitPins: expected.explicitPins,
        }) ||
        b.catalogSha256 !== expected.catalogSha256 ||
        !same(b.catalog, catalog) ||
        !same(
          {
            captureId: b.captureId,
            generationId: b.generationId,
            snapshotId: b.snapshotId,
            transactionSnapshot: b.transactionSnapshot,
            baselineLsn: b.baselineLsn,
          },
          capture,
        ) ||
        b.operatorSnapshot.transactionSnapshot !== capture.transactionSnapshot ||
        b.operatorSnapshot.roleName !== expected.operator.roleName ||
        b.operatorSnapshot.roleOid !== expected.operator.roleOid
      )
        fail('SOURCE_BINDING_MISMATCH');
      const censusNames = b.census.map((r) =>
        r.schema === 'public' ? r.relation : `${r.schema}.${r.relation}`,
      );
      if (
        !same(
          censusNames,
          expected.relations.map((r) => (r.schema === 'public' ? r.name : `${r.schema}.${r.name}`)),
        )
      )
        fail('PHYSICAL_CORRESPONDENCE_FAILED');
      const packets: z.infer<typeof packet>[] = [];
      let bytes = 0,
        rowBytes = 0,
        rows = 0;
      for (const [i, kind] of (['parent', 'extra', 'child'] as const).entries()) {
        const pd = b.packets[i];
        if (!pd || pd.owner !== capture.captureId || pd.objectId !== `${capture.captureId}_${kind}`)
          fail('SOURCE_BINDING_MISMATCH');
        const decoded = decrypt(await object(pd, options.signal), pd, key, keyId);
        bytes += Buffer.byteLength(canonical(decoded));
        if (bytes > maximum * 3) fail('SOURCE_RECEIVER_LIMIT');
        const p = parse(packet, decoded);
        if (
          !same(p.source, b.source) ||
          p.snapshotId !== b.snapshotId ||
          p.transactionSnapshot !== b.transactionSnapshot ||
          p.baselineLsn !== b.baselineLsn ||
          p.generationId !== b.generationId ||
          p.partition.kind !== kind
        )
          fail('SOURCE_BINDING_MISMATCH');
        rowBytes += verifyPartition(p.partition);
        if (rowBytes > maximum) fail('SOURCE_RECEIVER_LIMIT');
        rows += p.partition.rows.length;
        if (rows > 5000) fail('SOURCE_RECEIVER_LIMIT');
        for (const c of p.partition.census) {
          const actual = b.census.find(
            (r) =>
              (r.schema === 'public' ? r.relation : `${r.schema}.${r.relation}`) === c.relation,
          );
          if (!actual || actual.rows !== c.count) fail('PHYSICAL_CORRESPONDENCE_FAILED');
        }
        packets.push(p);
      }
      if (
        b.archive.owner !== capture.captureId ||
        b.archive.objectId === d.objectId ||
        b.packets.some((p) => p.objectId === b.archive.objectId)
      )
        fail('SOURCE_BINDING_MISMATCH');
      await object(b.archive, options.signal);
      // Archive port's encrypted binary format is independently owned. Only its
      // exact immutable ciphertext descriptor/readback is checked here.
      const result = { manifest: b, packets, limits: readLimits };
      // Three independently bounded packet envelopes plus the independently
      // bounded manifest. This is not physical DB/network byte accounting.
      // Actual encoded rows retain C's aggregate16MiB/per-row4MiB/5000 caps.
      plain(result, maximum * 4);
      const handle = Object.freeze({});
      handles.set(handle, canonical(result));
      return handle;
    },
    withVerifiedCurrentSource<T>(
      handle: unknown,
      consume: (read: VerifiedCurrentSourceRead) => T,
    ): T {
      if (typeof handle !== 'object' || handle === null || typeof consume !== 'function')
        fail('INVALID_VERIFIED_HANDLE');
      const stored = handles.get(handle);
      if (!stored) fail('INVALID_VERIFIED_HANDLE');
      // Fresh bounded clone prevents callbacks from changing later consumers.
      const raw: unknown = JSON.parse(stored);
      plain(raw, maximum * 4);
      const cloned = z
        .strictObject({ manifest: body, packets: z.array(packet).length(3), limits: z.unknown() })
        .parse(raw);
      return consume({ manifest: cloned.manifest, packets: cloned.packets, limits: readLimits });
    },
  };
}
