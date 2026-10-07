import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { manualReviewSourceIdentityV7Schema } from './restore-suppression-records-v7.js';
import { raceManualReviewLifecycleEdgeV2Schema } from './race-manual-review-lifecycle-inventory-v2.js';
import { raceManualReviewRetainedPayloadV2Schema } from './race-manual-review-retained-payload-v2.js';

/** Typed child-byte authentication only. Neither original events nor parents,
 * PostgreSQL row hashes, historical seals, processing or restore are authenticated here. */
export const CURRENT_FAMILY_MAX_ROWS = 5000;
export const CURRENT_FAMILY_MAX_ROW_BYTES = 4 * 1024 * 1024;
export const CURRENT_FAMILY_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const domain = 'wm-current-child-family-authentication-v1\0';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const tenant = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v === v.trim());
const text = z.string().max(CURRENT_FAMILY_MAX_ROW_BYTES);
const integer = z.number().int().min(-2147483648).max(2147483647);
const positive = integer.min(1);
/** Source capture must explicitly format UTC with six digits. JS Date does not normalize it. */
const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .refine((v) => z.iso.datetime({ precision: 6 }).safeParse(v).success);
const bigint = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]*)$/)
  .refine((v) => {
    const n = BigInt(v);
    return n >= -9223372036854775808n && n <= 9223372036854775807n;
  });
const name = z
  .string()
  .min(1)
  .refine((v) => !v.includes('\0') && Buffer.byteLength(v, 'utf8') <= 63);
const bytea32 = z.string().regex(/^\\x[a-f0-9]{64}$/);
const rowHashMethod = z.literal('postgres-row-jsonb-utc-v1');
const base = { athlete_id: tenant };
const minimalResult = z.strictObject({
  schemaVersion: z.literal(2),
  evidenceId: uuid,
  decisionId: uuid,
  proposalId: uuid,
  candidateDigest: hash,
  createdAt: timestamp,
  applicable: z.literal(false),
  approvalAllowed: z.literal(false),
});
const schemas = {
  nutrition_race_item_disconnection: z.strictObject({
    ...base,
    version_id: uuid,
    item_key: bytea32,
    item_id: text.min(1).refine((v) => v === v.trim()),
    event_id: uuid,
  }),
  nutrition_integrated_candidate_disconnection: z.strictObject({
    ...base,
    candidate_id: uuid,
    event_id: uuid,
    row_digest_version: rowHashMethod,
    row_digest: hash,
    payload_digest_version: z.literal('integrated-candidate-v4-canonical-v1'),
    payload_digest: hash,
  }),
  race_result_proof_ref: z
    .strictObject({
      ...base,
      result_id: uuid,
      result_revision: positive,
      ordinal: integer.min(0).max(3),
      source_kind: z.enum(['gallery-image', 'resource-pdf']),
      source_id: uuid,
      version_id: uuid.nullable(),
      access_revision: positive.nullable(),
    })
    .superRefine((v, c) => {
      if ((v.source_kind === 'gallery-image') !== (v.version_id === null))
        c.addIssue({ code: 'custom', message: 'Proof version namespace mismatch' });
    }),
  nutrition_race_disconnection_lineage: z
    .strictObject({
      ...base,
      plan_id: uuid,
      version_id: uuid,
      version: integer.min(2).max(2147483646),
      prior_version_id: uuid,
      prior_version: positive,
      item_key: bytea32,
      item_id: text.min(1).refine((v) => v === v.trim()),
      origin_version_id: uuid,
      origin_event_id: uuid,
      disposition: z.enum(['retained', 'reconnected', 'carried']),
      prior_row_digest_version: rowHashMethod,
      prior_row_digest: hash,
    })
    .superRefine((v, c) => {
      if (v.version !== v.prior_version + 1 || v.version_id === v.prior_version_id)
        c.addIssue({ code: 'custom', message: 'Lineage version mismatch' });
    }),
  nutrition_v4_commit_seal: z.strictObject({
    ...base,
    version_id: uuid,
    plan_id: uuid,
    prior_version_id: uuid,
    caller_role: name,
    owner_xid: bigint,
    app_revision: positive,
    receipt_key: text,
    request_digest: hash,
    saved_digest: hash,
    expires_at: timestamp,
  }),
  plan_snapshot_aggregate: z.strictObject({ ...base, version_id: uuid, aggregate_id: uuid }),
  manual_race_evidence_v2: z
    .strictObject({
      ...base,
      id: uuid,
      decision_id: uuid,
      proposal_id: uuid,
      created_at: timestamp,
      receipt_key: text,
      candidate_digest: hash,
      original_payload_sql_digest: hash,
      payload: raceManualReviewRetainedPayloadV2Schema.nullable(),
      purged_at: timestamp.nullable(),
      purged_event_id: uuid.nullable(),
    })
    .superRefine((v, c) => {
      if (
        v.payload === null
          ? v.purged_at === null || v.purged_event_id === null
          : v.purged_at !== null || v.purged_event_id !== null
      )
        c.addIssue({ code: 'custom', message: 'Physical purge tuple mismatch' });
      if (
        v.payload !== null &&
        (v.payload.minimalAudit.athleteId !== v.athlete_id ||
          v.payload.minimalAudit.candidateDigest !== v.candidate_digest)
      )
        c.addIssue({ code: 'custom', message: 'Payload audit mismatch' });
    }),
  manual_race_decision_v2: z.strictObject({ ...base, id: uuid, evidence_id: uuid }),
  manual_race_proposal_v2: z.strictObject({
    ...base,
    id: uuid,
    evidence_id: uuid,
    decision_id: uuid,
    applicable: z.literal(false),
  }),
  manual_race_chain_source_ref_v2: z.strictObject({
    ...base,
    evidence_id: uuid,
    ordinal: positive.max(5000),
    identity: manualReviewSourceIdentityV7Schema,
    identity_key: bytea32,
    dto_digest: hash,
    copied_locations: z.array(text.min(1)).min(1).max(5000),
    sql_relations: z.array(z.json()).max(5000),
  }),
  manual_race_chain_lifecycle_edge_v2: z.strictObject({
    ...base,
    evidence_id: uuid,
    ordinal: positive.max(5000),
    edge_key: bytea32,
    edge: raceManualReviewLifecycleEdgeV2Schema,
  }),
  manual_race_chain_suppression_v2: z.strictObject({
    ...base,
    evidence_id: uuid,
    event_id: uuid,
    occurred_at: timestamp,
    original_payload_sql_digest: hash,
  }),
  manual_race_chain_receipt_v2: z.strictObject({
    ...base,
    receipt_key: text,
    request_digest: bytea32,
    result: minimalResult,
    evidence_id: uuid,
  }),
  manual_race_chain_commit_v2: z.strictObject({
    ...base,
    evidence_id: uuid,
    caller_role: name,
    owner_xid: bigint,
    payload_hash: bytea32,
  }),
  manual_race_v2_live_transition: z.strictObject({
    ...base,
    event_id: uuid,
    identity: manualReviewSourceIdentityV7Schema,
    occurred_at: timestamp,
    owner_xid: bigint,
    caller_role: name,
    version_scope: z.enum(['exact_identity', 'all_versions']),
  }),
};
export const currentFamilyRelations = Object.freeze(Object.keys(schemas));
const rowSchema = z.union([
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('nutrition_race_item_disconnection'),
    row: schemas.nutrition_race_item_disconnection,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('nutrition_integrated_candidate_disconnection'),
    row: schemas.nutrition_integrated_candidate_disconnection,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('race_result_proof_ref'),
    row: schemas.race_result_proof_ref,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('nutrition_race_disconnection_lineage'),
    row: schemas.nutrition_race_disconnection_lineage,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('nutrition_v4_commit_seal'),
    row: schemas.nutrition_v4_commit_seal,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('plan_snapshot_aggregate'),
    row: schemas.plan_snapshot_aggregate,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_evidence_v2'),
    row: schemas.manual_race_evidence_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_decision_v2'),
    row: schemas.manual_race_decision_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_proposal_v2'),
    row: schemas.manual_race_proposal_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_chain_source_ref_v2'),
    row: schemas.manual_race_chain_source_ref_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_chain_lifecycle_edge_v2'),
    row: schemas.manual_race_chain_lifecycle_edge_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_chain_suppression_v2'),
    row: schemas.manual_race_chain_suppression_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_chain_receipt_v2'),
    row: schemas.manual_race_chain_receipt_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_chain_commit_v2'),
    row: schemas.manual_race_chain_commit_v2,
  }),
  z.strictObject({
    ordinal: positive.max(5000),
    relation: z.literal('manual_race_v2_live_transition'),
    row: schemas.manual_race_v2_live_transition,
  }),
]);
const counts = z.strictObject({
  nutrition_race_item_disconnection: integer.min(0).max(5000),
  nutrition_integrated_candidate_disconnection: integer.min(0).max(5000),
  race_result_proof_ref: integer.min(0).max(5000),
  nutrition_race_disconnection_lineage: integer.min(0).max(5000),
  nutrition_v4_commit_seal: integer.min(0).max(5000),
  plan_snapshot_aggregate: integer.min(0).max(5000),
  manual_race_evidence_v2: integer.min(0).max(5000),
  manual_race_decision_v2: integer.min(0).max(5000),
  manual_race_proposal_v2: integer.min(0).max(5000),
  manual_race_chain_source_ref_v2: integer.min(0).max(5000),
  manual_race_chain_lifecycle_edge_v2: integer.min(0).max(5000),
  manual_race_chain_suppression_v2: integer.min(0).max(5000),
  manual_race_chain_receipt_v2: integer.min(0).max(5000),
  manual_race_chain_commit_v2: integer.min(0).max(5000),
  manual_race_v2_live_transition: z.literal(0),
});
const configuredIdentitySchema = z.strictObject({
  profile: z.strictObject({
    profileVersion: z.literal(1),
    normalSchemaVersion: z.literal(107),
    explicitVersions: z.tuple([
      z.literal(108),
      z.literal(109),
      z.literal(110),
      z.literal(111),
      z.literal(112),
      z.literal(113),
      z.literal(114),
      z.literal(115),
      z.literal(116),
    ]),
    rowEncoding: z.literal('utc-microseconds-decimal-bigint-hex-bytea-v1'),
    relationProfileSha256: hash,
  }),
  source: z.strictObject({
    systemIdentifier: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .refine((v) => BigInt(v) <= 18446744073709551615n),
    databaseOid: z.number().int().min(1).max(4294967295),
    captureId: uuid,
    generationId: uuid,
    registrySha256: hash,
    catalogSha256: hash,
    baselineThroughLsn: z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/),
  }),
  identity: z.strictObject({
    artifactId: uuid,
    athleteId: tenant,
    sourceKeyId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    sourceKeyVersion: positive,
  }),
  count: positive.max(5000),
  relationCounts: counts,
  rowsSha256: hash,
});
export type CurrentFamilyConfiguredIdentity = z.infer<typeof configuredIdentitySchema>;
export type CurrentFamilyTypedRow = z.infer<typeof rowSchema>;
const bodySchema = configuredIdentitySchema
  .extend({
    artifactVersion: z.literal(1),
    rows: z.array(rowSchema).min(1).max(5000),
    parentCoverage: z.literal('not_authenticated'),
    originalTailCoverage: z.literal('not_authenticated'),
  })
  .strict();
export type CurrentFamilyArtifactBody = z.infer<typeof bodySchema>;
export class CurrentFamilyArtifactError extends Error {
  constructor() {
    super('INVALID_CURRENT_FAMILY_ARTIFACT');
  }
}
function reject(): never {
  throw new CurrentFamilyArtifactError();
}
function plain(value: unknown, maximum: number): void {
  const active = new WeakSet<object>();
  let nodes = 0,
    strings = 0;
  function visit(v: unknown, depth: number): void {
    if (++nodes > maximum + 1 || depth > 64) reject();
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return;
    if (typeof v === 'string') {
      strings += Buffer.byteLength(v, 'utf8');
      if (strings > maximum) reject();
      return;
    }
    if (typeof v !== 'object' || active.has(v) || Object.getOwnPropertySymbols(v).length) reject();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) reject();
    if (
      Array.isArray(v) &&
      (Object.keys(v).length !== v.length || Object.getOwnPropertyNames(v).length !== v.length + 1)
    )
      reject();
    active.add(v);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      strings += Buffer.byteLength(key, 'utf8');
      if (strings > maximum || !d.enumerable || !('value' in d)) reject();
      visit(d.value, depth + 1);
    }
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximum) reject();
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  const s = JSON.stringify(v);
  if (s === undefined) reject();
  return s;
}
function checksum(v: unknown) {
  return createHash('sha256').update(canonical(v), 'utf8').digest('hex');
}
const primaryKeys: Record<CurrentFamilyTypedRow['relation'], readonly string[]> = {
  nutrition_race_item_disconnection: ['athlete_id', 'version_id', 'item_key'],
  nutrition_integrated_candidate_disconnection: ['athlete_id', 'candidate_id'],
  race_result_proof_ref: ['athlete_id', 'result_id', 'result_revision', 'ordinal'],
  nutrition_race_disconnection_lineage: ['athlete_id', 'version_id', 'item_key'],
  nutrition_v4_commit_seal: ['athlete_id', 'version_id'],
  plan_snapshot_aggregate: ['athlete_id', 'version_id'],
  manual_race_evidence_v2: ['athlete_id', 'id'],
  manual_race_decision_v2: ['athlete_id', 'id'],
  manual_race_proposal_v2: ['athlete_id', 'id'],
  manual_race_chain_source_ref_v2: ['athlete_id', 'evidence_id', 'ordinal'],
  manual_race_chain_lifecycle_edge_v2: ['athlete_id', 'evidence_id', 'ordinal', 'edge_key'],
  manual_race_chain_suppression_v2: ['athlete_id', 'evidence_id', 'event_id'],
  manual_race_chain_receipt_v2: ['athlete_id', 'receipt_key'],
  manual_race_chain_commit_v2: ['athlete_id', 'evidence_id'],
  manual_race_v2_live_transition: ['athlete_id', 'event_id'],
};
function validateBody(raw: unknown): CurrentFamilyArtifactBody {
  plain(raw, CURRENT_FAMILY_MAX_TOTAL_BYTES);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) reject();
  const body = parsed.data;
  if (canonical(body) !== canonical(raw)) reject();
  if (body.count !== body.rows.length || checksum(body.rows) !== body.rowsSha256) reject();
  const seen = new Set<string>();
  const actual = new Map<string, number>();
  for (const [i, entry] of body.rows.entries()) {
    plain(entry.row, CURRENT_FAMILY_MAX_ROW_BYTES);
    if (
      entry.ordinal !== i + 1 ||
      entry.row.athlete_id !== body.identity.athleteId ||
      entry.relation === 'manual_race_v2_live_transition'
    )
      reject();
    if (
      entry.relation === 'nutrition_race_item_disconnection' ||
      entry.relation === 'nutrition_race_disconnection_lineage'
    ) {
      const expectedItemKey = `\\x${createHash('sha256').update(entry.row.item_id, 'utf8').digest('hex')}`;
      if (entry.row.item_key !== expectedItemKey) reject();
    }
    const values = z.record(z.string(), z.unknown()).parse(entry.row);
    if (values === null || Array.isArray(values) || typeof values !== 'object') reject();
    const pk = canonical([entry.relation, primaryKeys[entry.relation].map((k) => values[k])]);
    if (seen.has(pk)) reject();
    seen.add(pk);
    actual.set(entry.relation, (actual.get(entry.relation) ?? 0) + 1);
  }
  for (const [relation, count] of Object.entries(body.relationCounts))
    if ((actual.get(relation) ?? 0) !== count) reject();
  // Check correspondence available inside this child bundle. Absent external
  // parents/original events remain unverified; no synthetic parent is generated.
  const evidenceRows = body.rows.flatMap((entry) =>
    entry.relation === 'manual_race_evidence_v2' ? [entry.row] : [],
  );
  for (const entry of body.rows) {
    if ('evidence_id' in entry.row) {
      const evidenceId = entry.row.evidence_id;
      const e = evidenceRows.find((row) => row.id === evidenceId);
      if (!e) continue;
      switch (entry.relation) {
        case 'manual_race_decision_v2':
          if (entry.row.id !== e.decision_id) reject();
          break;
        case 'manual_race_proposal_v2':
          if (entry.row.id !== e.proposal_id || entry.row.decision_id !== e.decision_id) reject();
          break;
        case 'manual_race_chain_suppression_v2':
          if (entry.row.original_payload_sql_digest !== e.original_payload_sql_digest) reject();
          break;
        case 'manual_race_chain_receipt_v2':
          if (
            entry.row.receipt_key !== e.receipt_key ||
            entry.row.result.evidenceId !== e.id ||
            entry.row.result.decisionId !== e.decision_id ||
            entry.row.result.proposalId !== e.proposal_id ||
            entry.row.result.candidateDigest !== e.candidate_digest ||
            entry.row.result.createdAt !== e.created_at
          )
            reject();
          break;
        case 'manual_race_chain_commit_v2':
          if (entry.row.payload_hash !== `\\x${e.original_payload_sql_digest}`) reject();
          break;
      }
    }
  }
  // Every byte is signed, but these SQL JSONB hashes and external FK/provenance
  // checks require a typed SQL stage and independently authenticated parent family.
  return body;
}
/** Structural physical parsing only; no source, census, or admission authority. */
export function parseCurrentFamilyPhysicalRows(raw: unknown): CurrentFamilyTypedRow[] {
  plain(raw, CURRENT_FAMILY_MAX_TOTAL_BYTES);
  const parsed = z.array(rowSchema).min(1).max(5000).safeParse(raw);
  if (!parsed.success || canonical(parsed.data) !== canonical(raw)) reject();
  return parsed.data;
}
export function currentFamilyRowsSha256(raw: unknown): string {
  return checksum(parseCurrentFamilyPhysicalRows(raw));
}
/** Producer encoding, not verification. Keys are configured independently of bytes. */
export function signCurrentFamilyArtifact(raw: unknown, key: Uint8Array): Uint8Array {
  const body = validateBody(raw);
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) reject();
  const hmacSha256 = createHmac('sha256', key).update(domain).update(canonical(body)).digest('hex');
  return Buffer.from(canonical({ body, hmacSha256 }), 'utf8');
}
export interface VerifiedCurrentFamilyChildBytes {
  readonly kind: 'verified_current_family_child_bytes';
  readonly parentClosure: 'blocked';
  readonly originalTailStage: 'unavailable';
  readonly authority: 'none';
  readonly admissionAllowed: false;
}
/** Process-private callback exposes authenticated child bytes only. It is NOT a
 * SQL stage capability. The callback cannot certify parents/tail from this handle. */
export function createCurrentFamilyArtifactVerifier(configuration: {
  readonly expected: CurrentFamilyConfiguredIdentity;
  readonly resolveSourceKey: (id: string, version: number) => Uint8Array;
}) {
  plain(configuration.expected, CURRENT_FAMILY_MAX_TOTAL_BYTES);
  const expected = configuredIdentitySchema.parse(configuration.expected);
  const pinned = canonical(expected);
  // Pin the configured port identity, while the original resolver can still
  // enforce key revocation/version policy on preparation and callback use.
  const resolveSourceKey = configuration.resolveSourceKey;
  const verified = new WeakMap<
    VerifiedCurrentFamilyChildBytes,
    { body: CurrentFamilyArtifactBody; keyDigest: string }
  >();
  function currentSourceKey(): Uint8Array {
    const value = resolveSourceKey(
      expected.identity.sourceKeyId,
      expected.identity.sourceKeyVersion,
    );
    if (!(value instanceof Uint8Array) || value.byteLength !== 32) reject();
    // A resolver-owned mutable buffer is never retained as handle evidence.
    return Uint8Array.from(value);
  }
  function prepareVerifiedCurrentFamilyArtifact(
    bytes: Uint8Array,
  ): VerifiedCurrentFamilyChildBytes {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > CURRENT_FAMILY_MAX_TOTAL_BYTES + 256)
        reject();
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const wrapper = z
        .strictObject({ body: z.unknown(), hmacSha256: hash })
        .parse(JSON.parse(decoded));
      const body = validateBody(wrapper.body);
      if (decoded !== canonical({ body, hmacSha256: wrapper.hmacSha256 })) reject();
      const {
        artifactVersion: _,
        rows: __,
        parentCoverage: ___,
        originalTailCoverage: ____,
        ...identity
      } = body;
      void _;
      void __;
      void ___;
      void ____;
      if (canonical(identity) !== pinned) reject();
      const key = currentSourceKey();
      const wanted = createHmac('sha256', key).update(domain).update(canonical(body)).digest();
      if (!timingSafeEqual(wanted, Buffer.from(wrapper.hmacSha256, 'hex'))) reject();
      const handle: VerifiedCurrentFamilyChildBytes = Object.freeze({
        kind: 'verified_current_family_child_bytes',
        parentClosure: 'blocked',
        originalTailStage: 'unavailable',
        authority: 'none',
        admissionAllowed: false,
      });
      verified.set(handle, {
        body,
        keyDigest: createHash('sha256').update(key).digest('hex'),
      });
      return handle;
    } catch {
      reject();
    }
  }
  function withVerifiedCurrentFamilyArtifact<T>(
    handle: VerifiedCurrentFamilyChildBytes,
    consume: (
      body: Readonly<CurrentFamilyArtifactBody>,
      limits: Readonly<{
        parentClosure: 'blocked';
        reason: 'authenticated_parent_family_unavailable';
        sqlRowEncoding: 'not_verified';
        originalTailStage: 'unavailable';
        historicalSeals: 'audit_only';
        authority: 'none';
        admissionAllowed: false;
      }>,
    ) => T,
  ): T {
    const state = verified.get(handle);
    if (!state) reject();
    let key: Uint8Array;
    try {
      key = currentSourceKey();
    } catch {
      reject();
    }
    if (createHash('sha256').update(key).digest('hex') !== state.keyDigest) reject();
    // Hand a fresh decoded copy so callback mutation cannot alter factory evidence.
    const copy = validateBody(JSON.parse(canonical(state.body)));
    return consume(
      copy,
      Object.freeze({
        parentClosure: 'blocked',
        reason: 'authenticated_parent_family_unavailable',
        sqlRowEncoding: 'not_verified',
        originalTailStage: 'unavailable',
        historicalSeals: 'audit_only',
        authority: 'none',
        admissionAllowed: false,
      }),
    );
  }
  return Object.freeze({ prepareVerifiedCurrentFamilyArtifact, withVerifiedCurrentFamilyArtifact });
}
