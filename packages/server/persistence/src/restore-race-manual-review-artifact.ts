import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { verifyRaceManualReviewIntegrity } from '@workout/server-coaching/race-manual-review-integrity';
import { createRaceRelativeScheduleCalculationPorts } from './race-relative-schedule-calculation.js';
import { mapRaceManualReviewSourceInventory } from './race-manual-review-source-inventory.js';

// Preparation only: this authenticates a bounded family, not a complete archive,
// independent witness, SQL stage authority or restore processing admission.
// The future suppression event_id is not frozen and remains rejected. Nonnull
// payloads require the actual domain verifier and finite copied-body mapper below.
export const RACE_REVIEW_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const RACE_REVIEW_ARTIFACT_MAX_ROW_BYTES = 4 * 1024 * 1024;
const maxRows = 5000;
const domain = 'wm-race-manual-review-family-v1\0';
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const tenant = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v.trim() === v);
const timestamp = z.iso.datetime({ offset: true }).refine((v) => !/\.\d{7}/.test(v));
const revision = z.number().int().min(1).max(2147483647);
const receiptKey = z.string().regex(/^race-manual-review:store:[0-9a-f]{64}$/);
const kinds = z.enum([
  'race-event',
  'plan-snapshot',
  'nutrition-plan-version',
  'recovery-strategy-version',
  'routine-schedule-version',
  'routine-blueprint-version',
  'routine-occurrence',
  'routine-run',
  'session-completion',
]);
const sourceRef = z
  .strictObject({
    athlete_id: tenant,
    review_id: uuid,
    source_kind: kinds,
    source_id: z.string().min(1).max(200),
    version_key: z.string().min(1).max(128),
    source_row_digest: hash,
  })
  .superRefine((r, ctx) => {
    let valid = r.source_kind === 'session-completion' || uuid.safeParse(r.source_id).success;
    if (r.source_kind === 'session-completion') {
      try {
        const tuple = z.tuple([uuid, revision]).parse(JSON.parse(r.version_key));
        valid &&= JSON.stringify(tuple) === r.version_key;
      } catch {
        valid = false;
      }
    } else if (r.source_kind === 'routine-occurrence') valid &&= r.version_key === 'immutable';
    else if (['race-event', 'plan-snapshot', 'routine-run'].includes(r.source_kind)) {
      valid &&=
        /^(0|[1-9][0-9]{0,9})$/.test(r.version_key) &&
        Number(r.version_key) <= 2147483647 &&
        (r.source_kind === 'routine-run' || r.version_key !== '0');
    } else valid &&= uuid.safeParse(r.version_key).success;
    if (!valid) ctx.addIssue({ code: 'custom', message: 'INVALID_SOURCE_IDENTITY' });
  });
const suppression = sourceRef.extend({ occurred_at: timestamp });
const binding = z.strictObject({
  athleteId: tenant,
  event: z.strictObject({ id: uuid, revision }),
  readSetDigest: hash,
});
const payloadSchema = z.strictObject({
  context: z.json(),
  sourceInput: z.json(),
  candidate: z.json(),
  capturedBinding: binding,
});
const manualBasisSchema = z.strictObject({
  purpose: z.literal('manual_race_date_change'),
  app: z.strictObject({ state: z.literal('present'), granted: z.literal(true), revision }),
  policy: z.strictObject({
    id: z.literal('manual-race-date-impact'),
    version: z.literal(1),
    digest: hash,
  }),
});
const review = z
  .strictObject({
    athlete_id: tenant,
    id: uuid,
    schema_version: z.literal(1),
    created_at: timestamp,
    event_id: uuid,
    event_revision: revision,
    app_revision: revision,
    generation_id: uuid,
    policy_id: z.literal('manual-race-date-impact'),
    policy_version: z.literal(1),
    policy_digest: hash,
    read_set_digest: hash,
    candidate_digest: hash,
    payload_sql_digest: hash,
    receipt_key: receiptKey,
    request_digest: hash,
    payload: payloadSchema.nullable(),
    purged_at: timestamp.nullable(),
    purged_reason: z.literal('source_deleted').nullable(),
  })
  .refine((r) =>
    r.payload === null
      ? r.purged_at !== null && r.purged_reason === 'source_deleted'
      : r.purged_at === null && r.purged_reason === null,
  );
const receipt = z.strictObject({
  athlete_id: tenant,
  idempotency_key: receiptKey,
  request: z.strictObject({ schemaVersion: z.literal(1), requestDigest: hash }),
  result: z.strictObject({
    schemaVersion: z.literal(1),
    reviewId: uuid,
    candidateDigest: hash,
    createdAt: timestamp,
    approvalAllowed: z.literal(false),
    sourceCompleteness: z.literal('unverified'),
  }),
});
const collectionsSchema = z.strictObject({
  reviews: z.array(review).max(1000),
  sourceRefs: z.array(sourceRef).max(maxRows),
  suppressions: z.array(suppression).max(maxRows),
  receipts: z.array(receipt).max(1000),
});
const inventory = z.strictObject({ count: z.number().int().min(0).max(maxRows), sha256: hash });
const inventories = z.strictObject({
  reviews: inventory,
  sourceRefs: inventory,
  suppressions: inventory,
  receipts: inventory,
});
const identitySchema = z.strictObject({
  family: z.literal('race-manual-review-family-v1'),
  purpose: z.literal('owner_restore_race_manual_review_family'),
  sourceSchemaVersion: z.union([z.literal(105), z.literal(106)]),
  targetSchemaVersion: z.literal(106),
  sourceKeyId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/),
  sourceKeyVersion: revision,
  ownerId: uuid,
  generationId: uuid,
  targetNonce: uuid,
  targetIncarnation: uuid,
  controlRevision: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((v) => BigInt(v) <= 9223372036854775807n),
  schemaHash: hash,
  proofHash: hash,
  capturedAt: timestamp,
  inventories,
});
const bodySchema = identitySchema
  .extend({
    artifactVersion: z.literal(1),
    state: z.enum(['not_in_schema', 'present']),
    collections: collectionsSchema,
  })
  .strict();
const envelopeSchema = z.strictObject({ body: bodySchema, hmacSha256: hash });
export type RaceReviewArtifactIdentity = z.infer<typeof identitySchema>;
export type RaceReviewArtifactCollections = z.infer<typeof collectionsSchema>;
export type RaceReviewArtifactBodyV1 = z.infer<typeof bodySchema>;
export interface RaceReviewArtifactAuthority {
  // Supplied by the independently authenticated coordinator, not the artifact or client.
  readonly expected: RaceReviewArtifactIdentity;
  readonly resolveSourceKey: (id: string, version: number) => Uint8Array;
}
export interface VerifiedRaceReviewPreparation {
  readonly kind: 'preparation_verified_only';
  readonly admissionAllowed: false;
  readonly stageAllowed: false;
  readonly complete: false;
}
const verified = new WeakMap<VerifiedRaceReviewPreparation, RaceReviewArtifactBodyV1>();
function invalid(): never {
  throw new Error('INVALID_RACE_REVIEW_ARTIFACT');
}
function canonical(value: unknown, depth = 0, parents = new Set<object>()): string {
  if (depth > 64) invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || parents.has(value)) invalid();
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype))
    invalid();
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.getOwnPropertyNames(value).length !==
      Object.keys(value).length + (Array.isArray(value) ? 1 : 0)
  )
    invalid();
  parents.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (value.length > 100000 || Object.keys(value).length !== value.length) invalid();
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !('value' in descriptor)) invalid();
      items.push(canonical(descriptor.value, depth + 1, parents));
    }
    result = `[${items.join(',')}]`;
  } else
    result = `{${Object.keys(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) invalid();
        return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1, parents)}`;
      })
      .join(',')}}`;
  parents.delete(value);
  if (Buffer.byteLength(result) > RACE_REVIEW_ARTIFACT_MAX_BYTES) invalid();
  return result;
}
function sha(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function timestampMicros(value: string): bigint {
  const fraction = /\.(\d+)(?=Z|[+-])/.exec(value)?.[1] ?? '';
  const seconds = value.replace(/\.\d+(?=Z|[+-])/, '');
  return BigInt(Date.parse(seconds)) * 1000n + BigInt(fraction.padEnd(6, '0'));
}
function compareCanonical(a: unknown, b: unknown): number {
  const left = canonical(a),
    right = canonical(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
function refKey(r: z.infer<typeof sourceRef>): string {
  return canonical([r.review_id, r.source_kind, r.source_id, r.version_key]);
}
function validateBody(body: RaceReviewArtifactBodyV1): void {
  if ((body.sourceSchemaVersion === 105) !== (body.state === 'not_in_schema')) invalid();
  for (const name of ['reviews', 'sourceRefs', 'suppressions', 'receipts'] as const) {
    const rows = body.collections[name];
    if (body.sourceSchemaVersion === 105 && rows.length !== 0) invalid();
    if (body.inventories[name].count !== rows.length || body.inventories[name].sha256 !== sha(rows))
      invalid();
    if (
      rows.some(
        (r) =>
          r.athlete_id !== body.ownerId ||
          Buffer.byteLength(canonical(r)) > RACE_REVIEW_ARTIFACT_MAX_ROW_BYTES,
      )
    )
      invalid();
  }
  const reviews = new Map(body.collections.reviews.map((r) => [r.id, r]));
  const receipts = new Map(body.collections.receipts.map((r) => [r.idempotency_key, r]));
  const refs = new Map(body.collections.sourceRefs.map((r) => [refKey(r), r]));
  const markers = new Map(body.collections.suppressions.map((r) => [refKey(r), r]));
  if (
    reviews.size !== body.collections.reviews.length ||
    receipts.size !== body.collections.receipts.length ||
    refs.size !== body.collections.sourceRefs.length ||
    markers.size !== body.collections.suppressions.length
  )
    invalid();
  if (receipts.size !== reviews.size) invalid();
  for (const r of reviews.values()) {
    const stored = receipts.get(r.receipt_key);
    if (
      !stored ||
      stored.result.reviewId !== r.id ||
      stored.request.requestDigest !== r.request_digest ||
      stored.result.candidateDigest !== r.candidate_digest ||
      timestampMicros(stored.result.createdAt) !== timestampMicros(r.created_at) ||
      r.generation_id !== body.generationId
    )
      invalid();
    if (
      !body.collections.sourceRefs.some(
        (ref) =>
          ref.review_id === r.id &&
          ref.source_kind === 'race-event' &&
          ref.source_id === r.event_id &&
          ref.version_key === String(r.event_revision),
      )
    )
      invalid();
    if (r.payload === null) {
      if (!body.collections.suppressions.some((marker) => marker.review_id === r.id)) invalid();
    } else {
      if (Buffer.byteLength(canonical(r.payload)) > 4 * 1024 * 1024) invalid();
      const context = z
        .looseObject({
          athleteId: tenant,
          restoreGeneration: uuid,
          event: z.looseObject({ id: uuid, revision }),
          readSetDigest: hash,
          consumedSources: z.looseObject({ races: z.json() }),
          manualBasis: manualBasisSchema,
        })
        .parse(r.payload.context);
      if (
        context.athleteId !== r.athlete_id ||
        context.restoreGeneration !== r.generation_id ||
        context.event.id !== r.event_id ||
        context.event.revision !== r.event_revision ||
        context.readSetDigest !== r.read_set_digest ||
        context.manualBasis.app.revision !== r.app_revision ||
        context.manualBasis.policy.digest !== r.policy_digest ||
        canonical(r.payload.capturedBinding) !==
          canonical({
            athleteId: r.athlete_id,
            event: { id: r.event_id, revision: r.event_revision },
            readSetDigest: r.read_set_digest,
          })
      )
        invalid();
      const checked = verifyRaceManualReviewIntegrity(
        {
          candidate: r.payload.candidate,
          sourceInput: r.payload.sourceInput,
          capturedBinding: r.payload.capturedBinding,
          expectedBinding: r.payload.capturedBinding,
        },
        createRaceRelativeScheduleCalculationPorts(context.consumedSources.races),
      );
      if (checked.status !== 'consistent' || checked.candidate.digest !== r.candidate_digest)
        invalid();
      const mapped = mapRaceManualReviewSourceInventory({
        status: 'prepared_blocked',
        storage: 'not_persisted',
        sourceCompleteness: 'unverified',
        approvalAllowed: false,
        context: r.payload.context,
        sourceInput: r.payload.sourceInput,
        candidate: r.payload.candidate,
        binding: r.payload.capturedBinding,
      });
      if (mapped.inventoryState !== 'mapped' || !mapped.allCopiedBodiesIndexed) invalid();
      const actualRefs = body.collections.sourceRefs
        .filter((ref) => ref.review_id === r.id)
        .map((ref) => [ref.source_kind, ref.source_id, ref.version_key])
        .sort(compareCanonical);
      const mappedRefs = mapped.refs
        .map((ref) => [ref.kind, ref.sourceId, ref.versionKey])
        .sort(compareCanonical);
      if (canonical(actualRefs) !== canonical(mappedRefs)) invalid();
      // SQL UTC payload/source row hashes are independent from these canonical
      // HMAC/DTO hashes. Correspondence requires the future same-tx SQL adapter.
    }
  }
  for (const r of refs.values()) if (!reviews.has(r.review_id)) invalid();
  for (const r of markers.values()) {
    const ref = refs.get(refKey(r));
    if (
      !ref ||
      ref.source_row_digest !== r.source_row_digest ||
      reviews.get(r.review_id)?.payload !== null
    )
      invalid();
  }
}
export function raceReviewArtifactInventories(
  raw: unknown,
): RaceReviewArtifactIdentity['inventories'] {
  canonical(raw);
  const collections = collectionsSchema.parse(raw);
  return {
    reviews: { count: collections.reviews.length, sha256: sha(collections.reviews) },
    sourceRefs: { count: collections.sourceRefs.length, sha256: sha(collections.sourceRefs) },
    suppressions: { count: collections.suppressions.length, sha256: sha(collections.suppressions) },
    receipts: { count: collections.receipts.length, sha256: sha(collections.receipts) },
  };
}
/** Source-owner signing helper only, not key provisioning or SQL authority. */
export function signRaceReviewPreparation(raw: unknown, key: Uint8Array): Uint8Array {
  try {
    canonical(raw);
    const body = bodySchema.parse(raw);
    validateBody(body);
    if (key.byteLength !== 32) invalid();
    const hmacSha256 = createHmac('sha256', key)
      .update(domain)
      .update(canonical(body))
      .digest('hex');
    const bytes = Buffer.from(canonical({ body, hmacSha256 }));
    if (bytes.byteLength > RACE_REVIEW_ARTIFACT_MAX_BYTES) invalid();
    return bytes;
  } catch {
    invalid();
  }
}
export function prepareVerifiedRaceReviewArtifact(
  bytes: Uint8Array,
  authority: RaceReviewArtifactAuthority,
): VerifiedRaceReviewPreparation {
  try {
    if (bytes.byteLength > RACE_REVIEW_ARTIFACT_MAX_BYTES) invalid();
    // Bound recursive JSON depth before JSON.parse/schema traversal.
    let depth = 0,
      quoted = false,
      escaped = false;
    for (const b of bytes) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (b === 92) escaped = true;
        else if (b === 34) quoted = false;
      } else if (b === 34) quoted = true;
      else if (b === 123 || b === 91) {
        if (++depth > 64) invalid();
      } else if (b === 125 || b === 93) {
        if (--depth < 0) invalid();
      }
    }
    if (depth !== 0 || quoted) invalid();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const envelope = envelopeSchema.parse(JSON.parse(text));
    if (text !== canonical(envelope)) invalid();
    const expected = identitySchema.parse(authority.expected);
    const { artifactVersion: _, state: __, collections: ___, ...actual } = envelope.body;
    if (canonical(expected) !== canonical(actual)) invalid();
    const key = authority.resolveSourceKey(expected.sourceKeyId, expected.sourceKeyVersion);
    if (key.byteLength !== 32) invalid();
    const wanted = createHmac('sha256', key)
      .update(domain)
      .update(canonical(envelope.body))
      .digest();
    if (!timingSafeEqual(wanted, Buffer.from(envelope.hmacSha256, 'hex'))) invalid();
    validateBody(envelope.body);
    const handle: VerifiedRaceReviewPreparation = Object.freeze({
      kind: 'preparation_verified_only',
      admissionAllowed: false,
      stageAllowed: false,
      complete: false,
    });
    verified.set(handle, freeze(envelope.body));
    return handle;
  } catch {
    invalid();
  }
}
/** Summary only. No row accessor or staging port exists until typed body/seams freeze. */
export function readRaceReviewPreparation(handle: VerifiedRaceReviewPreparation): Readonly<{
  identity: RaceReviewArtifactIdentity;
  state: 'not_in_schema' | 'present';
  admissionAllowed: false;
  stageAllowed: false;
  complete: false;
}> {
  const body = verified.get(handle);
  if (!body) invalid();
  const { artifactVersion: _, state, collections: __, ...identity } = body;
  return freeze({ identity, state, admissionAllowed: false, stageAllowed: false, complete: false });
}
