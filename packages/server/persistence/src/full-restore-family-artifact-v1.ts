import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  createFullRestoreInventoryParserV1,
  FullRestoreInventoryError,
  type ValidatedFullRestoreInventoryV1,
} from './full-restore-inventory-v1.js';

/**
 * New versioned authenticated full-family manifest (EXT-RESTOREa).
 *
 * The historical source100 -> target102 -> upgrade105 family, the current
 * child family and their HMAC domains are untouched; this module uses its own
 * domain and never accepts their bytes. The manifest binds one independently
 * registered inventory, one source snapshot/slot/LSN, the complete ordered
 * tail chain up to its head, object provenance, sequence high-water marks and
 * one CLOSED target (nonce/incarnation/revision). A successful verification is
 * still `authority: none` and `admissionAllowed: false`: the rows must be
 * loaded and the target postconditions observed before any admission.
 */
export const FULL_FAMILY_ARTIFACT_V1_MAX_BYTES = 8 * 1024 * 1024;
export const FULL_FAMILY_ARTIFACT_V1_MAX_SEGMENTS = 100000;
export const FULL_FAMILY_ARTIFACT_V1_MAX_OBJECTS = 200000;
const DOMAIN = 'wm-full-restore-family-authentication-v1\0';
const SEGMENT_DOMAIN = 'wm-full-restore-tail-segment-v1\0';
const HEAD_DOMAIN = 'wm-full-restore-tail-head-v1\0';
const BASELINE_DOMAIN = 'wm-full-restore-baseline-v1\0';
const EMPTY_ROWS_SHA256 = createHash('sha256').update('[]').digest('hex');

export type FullFamilyArtifactErrorCode =
  | 'INVALID_FULL_FAMILY_CONFIGURATION'
  | 'INVALID_FULL_FAMILY_ARTIFACT'
  | 'FULL_FAMILY_AUTHENTICATION_FAILED'
  | 'FULL_FAMILY_INVENTORY_REJECTED'
  | 'FULL_FAMILY_AUTHENTICATION_STATE_RETAINED'
  | 'FULL_FAMILY_TAIL_REJECTED'
  | 'FULL_FAMILY_LATEST_TAIL_MISMATCH'
  | 'FULL_FAMILY_OBJECT_REJECTED'
  | 'FULL_FAMILY_SEQUENCE_REJECTED'
  | 'FULL_FAMILY_TARGET_MISMATCH';
export class FullFamilyArtifactError extends Error {
  constructor(readonly code: FullFamilyArtifactErrorCode) {
    super(code);
    this.name = 'FullFamilyArtifactError';
  }
}
function fail(code: FullFamilyArtifactErrorCode): never {
  throw new FullFamilyArtifactError(code);
}

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const keyId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const lsn = z.string().regex(/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/);
const int64 = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n);
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((v) => z.iso.datetime({ precision: 6 }).safeParse(v).success);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const objectKey = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((v) => !v.includes('//') && !v.split('/').some((p) => p === '.' || p === '..'));

const relationRef = z.strictObject({ schema: identifier, relation: identifier });
const sourceSchema = z.strictObject({
  generationId: uuid,
  systemIdentifier: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .refine((v) => BigInt(v) <= 18446744073709551615n),
  serverVersionNum: z.number().int().min(170000).max(179999),
  snapshotId: z.string().regex(/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/),
  slotName: identifier,
  consistentLsn: lsn,
  capturedAt: timestamp,
});
const segmentSchema = z.strictObject({
  ordinal: z.number().int().min(1).max(FULL_FAMILY_ARTIFACT_V1_MAX_SEGMENTS),
  startLsn: lsn,
  endLsn: lsn,
  recordCount: count,
  recordsSha256: hash,
  previousSegmentSha256: hash,
  segmentSha256: hash,
});
const bodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  protocol: z.literal('wm-full-restore-family-v1'),
  keyId,
  source: sourceSchema,
  inventory: z.unknown(),
  objects: z
    .array(
      z.strictObject({
        objectKey,
        byteLength: count,
        sha256: hash,
        owner: relationRef,
      }),
    )
    .max(FULL_FAMILY_ARTIFACT_V1_MAX_OBJECTS),
  sequences: z.array(
    z.strictObject({ ...relationRef.shape, lastValue: int64, isCalled: z.boolean() }),
  ),
  tail: z.strictObject({
    segments: z.array(segmentSchema).max(FULL_FAMILY_ARTIFACT_V1_MAX_SEGMENTS),
    head: z.strictObject({
      lastOrdinal: z.number().int().min(0).max(FULL_FAMILY_ARTIFACT_V1_MAX_SEGMENTS),
      endLsn: lsn,
      headSha256: hash,
    }),
  }),
  target: z.strictObject({
    targetNonce: uuid,
    targetIncarnation: uuid,
    closedRevision: revision,
  }),
  authentication: z.strictObject({ sessionsRequireReauthentication: z.literal(true) }),
});
type Body = z.infer<typeof bodySchema>;
export type FullFamilyArtifactBodyV1 = Omit<Body, 'inventory'> & { inventory: unknown };
type Segment = z.infer<typeof segmentSchema>;

const configurationSchema = z.strictObject({
  keyId,
  authenticationResetRelations: z.array(relationRef).max(1000),
  budgetRelations: z.array(relationRef).max(1000),
  sequences: z
    .array(z.strictObject({ ...relationRef.shape, owner: relationRef, column: identifier }))
    .max(1000),
  maxObjects: z.number().int().min(0).max(FULL_FAMILY_ARTIFACT_V1_MAX_OBJECTS),
  maxObjectBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type FullFamilyArtifactConfigurationV1 = z.infer<typeof configurationSchema>;

const bindingSchema = z.strictObject({
  /** Read from the live CLOSED control of this target, never from the artifact. */
  target: z.strictObject({
    targetNonce: uuid,
    targetIncarnation: uuid,
    closedRevision: revision,
  }),
  /** Independently retained latest head witness; null records `not_checked`. */
  latestHead: z.strictObject({ lastOrdinal: count, endLsn: lsn, headSha256: hash }).nullable(),
});
export type FullFamilyArtifactBindingV1 = z.infer<typeof bindingSchema>;

export type VerifiedFullFamilyArtifactV1 = Readonly<{
  kind: 'verified_full_family_artifact_v1';
  authority: 'none';
  admissionAllowed: false;
  latestTail: 'witness_matched' | 'not_checked';
  artifactSha256: string;
  baselineSha256: string;
  keyId: string;
  source: Readonly<Body['source']>;
  inventory: ValidatedFullRestoreInventoryV1;
  objects: readonly Readonly<Body['objects'][number]>[];
  sequences: readonly Readonly<Body['sequences'][number]>[];
  tail: Readonly<{
    segments: readonly Readonly<Segment>[];
    head: Readonly<Body['tail']['head']>;
  }>;
  target: Readonly<Body['target']>;
  totals: Readonly<{ objectCount: number; objectBytes: number; tailRecords: number }>;
}>;

export function canonicalFullFamilyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFullFamilyJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_FULL_FAMILY_ARTIFACT');
    return `{${Object.keys(value)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalFullFamilyJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    fail('INVALID_FULL_FAMILY_ARTIFACT');
  const text = JSON.stringify(value);
  if (text === undefined) fail('INVALID_FULL_FAMILY_ARTIFACT');
  return text;
}
const sha = (domain: string, value: unknown) =>
  createHash('sha256').update(domain).update(canonicalFullFamilyJson(value)).digest('hex');
const qualified = (v: { schema: string; relation: string }) => `${v.schema}.${v.relation}`;
function parseLsn(value: string): bigint {
  const [high, low] = value.split('/');
  return (BigInt(`0x${high ?? ''}`) << 32n) | BigInt(`0x${low ?? ''}`);
}

/** Digest of a segment without its own `segmentSha256` field. */
export function fullFamilySegmentSha256(segment: Omit<Segment, 'segmentSha256'>): string {
  const { ordinal, startLsn, endLsn, recordCount, recordsSha256, previousSegmentSha256 } = segment;
  return sha(SEGMENT_DOMAIN, {
    ordinal,
    startLsn,
    endLsn,
    recordCount,
    recordsSha256,
    previousSegmentSha256,
  });
}
/** Baseline digest binds the source snapshot identity and the exact inventory. */
export function fullFamilyBaselineSha256(source: Body['source'], inventory: unknown): string {
  return sha(BASELINE_DOMAIN, { source, inventory });
}
export function fullFamilyHeadSha256(
  baselineSha256: string,
  segments: readonly Pick<Segment, 'segmentSha256'>[],
  endLsn: string,
): string {
  return sha(HEAD_DOMAIN, {
    baselineSha256,
    endLsn,
    segments: segments.map((s) => s.segmentSha256),
  });
}

const issued = new WeakSet<object>();
/** True only for results issued by a verifier in this process (not structural look-alikes). */
export function isVerifiedFullFamilyArtifactV1(
  value: unknown,
): value is VerifiedFullFamilyArtifactV1 {
  return typeof value === 'object' && value !== null && issued.has(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function verifyTail(body: Body, baselineSha256: string) {
  const { segments, head } = body.tail;
  let previous = baselineSha256,
    position = parseLsn(body.source.consistentLsn),
    records = 0;
  for (const [index, segment] of segments.entries()) {
    const start = parseLsn(segment.startLsn),
      end = parseLsn(segment.endLsn);
    if (
      segment.ordinal !== index + 1 ||
      start !== position ||
      end < start ||
      segment.previousSegmentSha256 !== previous ||
      (segment.recordCount === 0) !== (segment.recordsSha256 === EMPTY_ROWS_SHA256) ||
      (segment.recordCount > 0 && end === start) ||
      fullFamilySegmentSha256(segment) !== segment.segmentSha256
    )
      fail('FULL_FAMILY_TAIL_REJECTED');
    records += segment.recordCount;
    if (!Number.isSafeInteger(records)) fail('FULL_FAMILY_TAIL_REJECTED');
    previous = segment.segmentSha256;
    position = end;
  }
  if (
    head.lastOrdinal !== segments.length ||
    parseLsn(head.endLsn) !== position ||
    fullFamilyHeadSha256(baselineSha256, segments, head.endLsn) !== head.headSha256
  )
    fail('FULL_FAMILY_TAIL_REJECTED');
  return records;
}

/**
 * Configure with an independently approved registry/roster and policy lists;
 * none of these are taken from the artifact. The key resolver must return the
 * exact 32-byte source key for the configured key id.
 */
export function createFullFamilyArtifactVerifierV1(input: {
  readonly trustedRegistry: unknown;
  readonly configuration: FullFamilyArtifactConfigurationV1;
  readonly resolveKey: (keyId: string) => Uint8Array;
}) {
  const configured = configurationSchema.safeParse(input.configuration);
  if (!configured.success || typeof input.resolveKey !== 'function')
    fail('INVALID_FULL_FAMILY_CONFIGURATION');
  const configuration = deepFreeze(structuredClone(configured.data));
  let parser: ReturnType<typeof createFullRestoreInventoryParserV1>,
    registry: { relations: { schema: string; relation: string }[] };
  try {
    // One owned snapshot feeds both the parser and the policy membership checks.
    registry = structuredClone(input.trustedRegistry) as typeof registry;
    parser = createFullRestoreInventoryParserV1(registry);
  } catch {
    fail('INVALID_FULL_FAMILY_CONFIGURATION');
  }
  const registered = new Set(registry.relations.map(qualified));
  const unique = (rows: readonly { schema: string; relation: string }[]) =>
    new Set(rows.map(qualified)).size === rows.length;
  if (
    !unique(configuration.authenticationResetRelations) ||
    !unique(configuration.budgetRelations) ||
    !unique(configuration.sequences) ||
    [
      ...configuration.authenticationResetRelations,
      ...configuration.budgetRelations,
      ...configuration.sequences.map((s) => s.owner),
    ].some((r) => !registered.has(qualified(r))) ||
    configuration.budgetRelations.some((r) =>
      configuration.authenticationResetRelations.some((a) => qualified(a) === qualified(r)),
    )
  )
    fail('INVALID_FULL_FAMILY_CONFIGURATION');
  const resolveKey = input.resolveKey;
  function key(): Uint8Array {
    let value: unknown;
    try {
      value = resolveKey(configuration.keyId);
    } catch {
      fail('FULL_FAMILY_AUTHENTICATION_FAILED');
    }
    if (!(value instanceof Uint8Array) || value.byteLength !== 32)
      fail('FULL_FAMILY_AUTHENTICATION_FAILED');
    return Uint8Array.from(value);
  }

  function verify(bytes: Uint8Array, rawBinding: unknown): VerifiedFullFamilyArtifactV1 {
    const binding = bindingSchema.safeParse(rawBinding);
    if (!binding.success) fail('FULL_FAMILY_TARGET_MISMATCH');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > FULL_FAMILY_ARTIFACT_V1_MAX_BYTES)
      fail('INVALID_FULL_FAMILY_ARTIFACT');
    const owned = Uint8Array.from(bytes);
    let decoded: string, envelope: { body: unknown; hmacSha256: string };
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned);
      if (decoded.charCodeAt(0) === 0xfeff) fail('INVALID_FULL_FAMILY_ARTIFACT');
      envelope = z.strictObject({ body: z.unknown(), hmacSha256: hash }).parse(JSON.parse(decoded));
    } catch {
      fail('INVALID_FULL_FAMILY_ARTIFACT');
    }
    const parsed = bodySchema.safeParse(envelope.body);
    if (!parsed.success) fail('INVALID_FULL_FAMILY_ARTIFACT');
    const body = parsed.data;
    // Rejects duplicate keys, alternate spacing/order and lossy numbers.
    let canonicalBody: string;
    try {
      canonicalBody = canonicalFullFamilyJson(envelope.body);
    } catch {
      fail('INVALID_FULL_FAMILY_ARTIFACT');
    }
    if (decoded !== `{"body":${canonicalBody},"hmacSha256":${JSON.stringify(envelope.hmacSha256)}}`)
      fail('INVALID_FULL_FAMILY_ARTIFACT');
    if (body.keyId !== configuration.keyId) fail('FULL_FAMILY_AUTHENTICATION_FAILED');
    const wanted = createHmac('sha256', key()).update(DOMAIN).update(canonicalBody).digest();
    if (!timingSafeEqual(wanted, Buffer.from(envelope.hmacSha256, 'hex')))
      fail('FULL_FAMILY_AUTHENTICATION_FAILED');

    let inventory: ValidatedFullRestoreInventoryV1;
    try {
      inventory = parser.parse(body.inventory);
    } catch (error) {
      if (error instanceof FullRestoreInventoryError) fail('FULL_FAMILY_INVENTORY_REJECTED');
      throw error;
    }
    const byName = new Map(inventory.inventory.relations.map((r) => [qualified(r), r]));
    // Sessions, login attempts and provider tokens are never restored live.
    for (const relation of configuration.authenticationResetRelations) {
      const row = byName.get(qualified(relation));
      if (!row || row.state !== 'explicit_empty' || row.rowsSha256 !== EMPTY_ROWS_SHA256)
        fail('FULL_FAMILY_AUTHENTICATION_STATE_RETAINED');
    }
    for (const relation of configuration.budgetRelations)
      if (!byName.has(qualified(relation))) fail('FULL_FAMILY_INVENTORY_REJECTED');

    let objectBytes = 0;
    if (body.objects.length > configuration.maxObjects) fail('FULL_FAMILY_OBJECT_REJECTED');
    for (const [index, object] of body.objects.entries()) {
      const previous = body.objects[index - 1];
      const owner = byName.get(qualified(object.owner));
      if (
        (previous && !(previous.objectKey < object.objectKey)) ||
        !owner ||
        owner.state !== 'present' ||
        configuration.authenticationResetRelations.some(
          (r) => qualified(r) === qualified(object.owner),
        )
      )
        fail('FULL_FAMILY_OBJECT_REJECTED');
      objectBytes += object.byteLength;
      if (!Number.isSafeInteger(objectBytes) || objectBytes > configuration.maxObjectBytes)
        fail('FULL_FAMILY_OBJECT_REJECTED');
    }

    if (body.sequences.length !== configuration.sequences.length)
      fail('FULL_FAMILY_SEQUENCE_REJECTED');
    for (const [index, sequence] of body.sequences.entries()) {
      const expected = configuration.sequences[index];
      if (!expected || qualified(expected) !== qualified(sequence))
        fail('FULL_FAMILY_SEQUENCE_REJECTED');
      // An empty owner may still have consumed values; a nonempty owner needs a called sequence.
      const owner = byName.get(qualified(expected.owner));
      if (owner?.state === 'present' && !sequence.isCalled) fail('FULL_FAMILY_SEQUENCE_REJECTED');
      if (BigInt(sequence.lastValue) < 1n) fail('FULL_FAMILY_SEQUENCE_REJECTED');
    }

    const baselineSha256 = fullFamilyBaselineSha256(body.source, body.inventory);
    const tailRecords = verifyTail(body, baselineSha256);
    const witness = binding.data.latestHead;
    if (
      witness &&
      (witness.lastOrdinal !== body.tail.head.lastOrdinal ||
        witness.endLsn !== body.tail.head.endLsn ||
        witness.headSha256 !== body.tail.head.headSha256)
    )
      fail('FULL_FAMILY_LATEST_TAIL_MISMATCH');

    const target = binding.data.target;
    if (
      body.target.targetNonce !== target.targetNonce ||
      body.target.targetIncarnation !== target.targetIncarnation ||
      body.target.closedRevision !== target.closedRevision
    )
      fail('FULL_FAMILY_TARGET_MISMATCH');

    const copy = deepFreeze(structuredClone(body));
    const result: VerifiedFullFamilyArtifactV1 = Object.freeze({
      kind: 'verified_full_family_artifact_v1',
      authority: 'none',
      admissionAllowed: false,
      latestTail: witness ? 'witness_matched' : 'not_checked',
      artifactSha256: createHash('sha256').update(owned).digest('hex'),
      baselineSha256,
      keyId: body.keyId,
      source: copy.source,
      inventory,
      objects: copy.objects,
      sequences: copy.sequences,
      tail: copy.tail,
      target: copy.target,
      totals: Object.freeze({ objectCount: body.objects.length, objectBytes, tailRecords }),
    });
    issued.add(result);
    return result;
  }
  return Object.freeze({ verify });
}

/** Producer helper for fixtures and the future capture path. Validates shape only. */
export function signFullFamilyArtifactV1(rawBody: unknown, key: Uint8Array): Uint8Array {
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success || !(key instanceof Uint8Array) || key.byteLength !== 32)
    fail('INVALID_FULL_FAMILY_ARTIFACT');
  const body = canonicalFullFamilyJson(rawBody);
  const mac = createHmac('sha256', key).update(DOMAIN).update(body).digest('hex');
  return Buffer.from(`{"body":${body},"hmacSha256":"${mac}"}`, 'utf8');
}
