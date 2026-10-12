import { z } from 'zod';
import { postgresInstantMicros } from '@workout/contracts/postgres-instant';
import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import { checkInTemplateExportVersionRowSchema } from '@workout/contracts/check-in-template-export';
import {
  raceManualApprovalCandidateSchema,
  raceManualApprovalResultSchema,
} from '@workout/contracts/race-manual-approval';
import { raceManualPublicPreviewReferenceSchema } from '@workout/contracts/race-manual-public-preview';
import { raceManualSemanticBasisV2Schema } from './race-manual-review-semantic-basis-v2.js';
import { raceManualReviewLifecycleInventoryV2Schema } from './race-manual-review-lifecycle-inventory-v2.js';

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const text = z.string();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const bytea32 = z.string().regex(/^\\x[0-9a-f]{64}$/);
const revision = z.number().int().min(1).max(2147483646);
const utc6 = z.iso.datetime({ precision: 6 }).regex(/\.\d{6}Z$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const domain = z.enum(['training', 'nutrition', 'recovery', 'routine_schedule']);
const limitsSchema = z.strictObject({ maxRowBytes: z.number().int().min(2).max(8388608) });
const validatedJson = (schema: z.ZodType) =>
  z.unknown().superRefine((value, context) => {
    if (!schema.safeParse(value).success)
      context.addIssue({ code: 'custom', message: 'Invalid retained structure' });
  });
function sameInstant(a: string, b: string) {
  const value = postgresInstantMicros(a);
  return value !== null && value === postgresInstantMicros(b);
}
const templateVersion = z
  .strictObject({
    athlete_id: text,
    template_id: uuid,
    version_id: uuid,
    version: revision,
    previous_version_id: uuid.nullable(),
    previous_version: revision.nullable(),
    created_at: utc6,
    record_json: z.unknown(),
  })
  .superRefine((row, context) => {
    const { athlete_id: _athlete, ...physical } = row;
    if (!checkInTemplateExportVersionRowSchema.safeParse(physical).success)
      context.addIssue({ code: 'custom', message: 'Invalid original template tuple' });
    // SQL123 compares these JSON strings directly, before any public UUID transform.
    const original = z
      .object({ templateId: text, versionId: text, previousVersionId: text.nullable() })
      .safeParse(row.record_json);
    if (
      !original.success ||
      original.data.templateId !== row.template_id ||
      original.data.versionId !== row.version_id ||
      original.data.previousVersionId !== row.previous_version_id
    )
      context.addIssue({ code: 'custom', message: 'Original template identity spelling mismatch' });
  });
const templateHead = z.strictObject({
  athlete_id: text,
  template_id: uuid,
  version_id: uuid,
  version: revision,
});
const templateReceipt = z.strictObject({
  athlete_id: text,
  idempotency_key: key,
  request_digest: bytea32,
  template_id: uuid,
  version_id: uuid,
});
const candidate = z
  .strictObject({
    athlete_id: text,
    id: uuid,
    evidence_id: uuid,
    decision_id: uuid,
    proposal_id: uuid,
    application_digest: digest,
    candidate_json: validatedJson(raceManualApprovalCandidateSchema).nullable(),
    basis_json: validatedJson(raceManualSemanticBasisV2Schema).nullable(),
    lifecycle_json: validatedJson(raceManualReviewLifecycleInventoryV2Schema).nullable(),
    created_at: utc6,
    purged_event_id: uuid.nullable(),
    purged_at: utc6.nullable(),
  })
  .superRefine((row, context) => {
    const purged =
      row.candidate_json === null &&
      row.basis_json === null &&
      row.lifecycle_json === null &&
      row.purged_event_id !== null &&
      row.purged_at !== null;
    const present =
      row.candidate_json !== null &&
      row.basis_json !== null &&
      row.lifecycle_json !== null &&
      row.purged_event_id === null &&
      row.purged_at === null;
    if (!purged && !present) context.addIssue({ code: 'custom', message: 'Invalid purge tuple' });
    if (!present) return;
    const parsed = raceManualApprovalCandidateSchema.safeParse(row.candidate_json);
    const basis = raceManualSemanticBasisV2Schema.safeParse(row.basis_json);
    const lifecycle = raceManualReviewLifecycleInventoryV2Schema.safeParse(row.lifecycle_json);
    if (!parsed.success || !basis.success || !lifecycle.success) return;
    const body = parsed.data;
    if (
      body.candidateId !== row.id ||
      body.chain.evidenceId !== row.evidence_id ||
      body.chain.decisionId !== row.decision_id ||
      body.chain.proposalId !== row.proposal_id ||
      body.applicationDigest !== row.application_digest ||
      !sameInstant(body.createdAt, row.created_at) ||
      basis.data.athleteId !== row.athlete_id ||
      lifecycle.data.athleteId !== row.athlete_id
    )
      context.addIssue({ code: 'custom', message: 'Candidate physical identity mismatch' });
  });
const committedResult = z.unknown().superRefine((value, context) => {
  const parsed = raceManualApprovalResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.status !== 'committed')
    context.addIssue({ code: 'custom', message: 'Original committed result required' });
});
const applicationReceipt = z
  .strictObject({
    athlete_id: text,
    receipt_key: text,
    request_digest: bytea32,
    candidate_id: uuid,
    identity_digest: bytea32,
    result: committedResult,
  })
  .superRefine((row, context) => {
    const parsed = raceManualApprovalResultSchema.safeParse(row.result);
    if (parsed.success && parsed.data.candidateId !== row.candidate_id)
      context.addIssue({ code: 'custom', message: 'Receipt candidate mismatch' });
  });
const history = z.strictObject({
  athlete_id: text,
  approval_id: uuid,
  candidate_id: uuid,
  domain,
  aggregate_id: uuid,
  version_id: uuid,
  approved_at: utc6,
});
const publicReceipt = z
  .strictObject({
    athlete_id: text,
    operation: z.enum(['review', 'approve']),
    receipt_key: key,
    request_digest: bytea32,
    candidate_id: uuid,
    result: z.unknown(),
  })
  .superRefine((row, context) => {
    const parsed =
      row.operation === 'review'
        ? raceManualPublicPreviewReferenceSchema.safeParse(row.result)
        : raceManualApprovalResultSchema.safeParse(row.result);
    if (
      !parsed.success ||
      parsed.data.candidateId !== row.candidate_id ||
      ('status' in parsed.data && parsed.data.status !== 'committed')
    )
      context.addIssue({ code: 'custom', message: 'Original public result mismatch' });
  });
const envelope = z.discriminatedUnion('relation', [
  z.strictObject({ relation: z.literal('check_in_template_version'), row: templateVersion }),
  z.strictObject({ relation: z.literal('check_in_template_head'), row: templateHead }),
  z.strictObject({ relation: z.literal('check_in_template_receipt'), row: templateReceipt }),
  z.strictObject({ relation: z.literal('race_manual_application_candidate_v1'), row: candidate }),
  z.strictObject({
    relation: z.literal('race_manual_application_receipt_v1'),
    row: applicationReceipt,
  }),
  z.strictObject({ relation: z.literal('race_manual_application_history_v1'), row: history }),
  z.strictObject({ relation: z.literal('race_manual_public_receipt_v1'), row: publicReceipt }),
]);
type DurableRow = z.infer<typeof envelope>;
/** Exact column names each durable codec's strict row schema accepts (registration cross-check). */
export const fullRestoreDurableRowColumnsV1: Readonly<Record<string, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      (
        [
          ['check_in_template_version', templateVersion],
          ['check_in_template_head', templateHead],
          ['check_in_template_receipt', templateReceipt],
          ['race_manual_application_candidate_v1', candidate],
          ['race_manual_application_receipt_v1', applicationReceipt],
          ['race_manual_application_history_v1', history],
          ['race_manual_public_receipt_v1', publicReceipt],
        ] as const
      ).map(([relation, schema]) => [relation, Object.freeze(Object.keys(schema.shape))]),
    ),
  );
type Immutable<T> = T extends readonly (infer Item)[]
  ? readonly Immutable<Item>[]
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T;
export type FullRestoreDurableRowErrorCode =
  'INVALID_DURABLE_ROW_LIMITS' | 'INVALID_DURABLE_PHYSICAL_ROW' | 'INVALID_TEMPLATE_ROW_CLOSURE';
export class FullRestoreDurableRowError extends Error {
  constructor(readonly code: FullRestoreDurableRowErrorCode) {
    super(code);
    this.name = 'FullRestoreDurableRowError';
  }
}
function fail(code: FullRestoreDurableRowErrorCode): never {
  throw new FullRestoreDurableRowError(code);
}
function freezeJson(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}
export type ValidatedFullRestoreDurableRowV1 = Readonly<{
  kind: 'validated_full_restore_durable_row_v1';
  authority: 'none';
  admissionAllowed: false;
  closure: 'not_checked';
  facts: Immutable<DurableRow>;
}>;
/** Caller supplies a reviewed transport cap. It is not a SQL JSONB CHECK or authority. */
export function createFullRestoreDurableRowParserV1(rawLimits: unknown) {
  if (!createBoundedPlainJsonSchema(1024).safeParse(rawLimits).success)
    fail('INVALID_DURABLE_ROW_LIMITS');
  const parsedLimits = limitsSchema.safeParse(rawLimits);
  if (!parsedLimits.success) fail('INVALID_DURABLE_ROW_LIMITS');
  const boundary = createBoundedPlainJsonSchema(parsedLimits.data.maxRowBytes);
  return {
    parse(raw: unknown): ValidatedFullRestoreDurableRowV1 {
      if (!boundary.safeParse(raw).success) fail('INVALID_DURABLE_PHYSICAL_ROW');
      const parsed = envelope.safeParse(raw);
      if (!parsed.success) fail('INVALID_DURABLE_PHYSICAL_ROW');
      // Nested schema transforms validate only; preserve original spelling and own an immutable copy.
      const facts = structuredClone(parsed.data);
      freezeJson(facts);
      return Object.freeze({
        kind: 'validated_full_restore_durable_row_v1',
        authority: 'none',
        admissionAllowed: false,
        closure: 'not_checked',
        facts,
      });
    },
  };
}
/** A complete caller-supplied template subset, not complete source or tenant authority.
 * Checks relational versions/head/receipt links, not PostgreSQL command digest authenticity. */
export function validateFullRestoreTemplateRowClosureV1(rawRows: unknown, rawLimits: unknown) {
  const parser = createFullRestoreDurableRowParserV1(rawLimits);
  const limits = limitsSchema.parse(rawLimits);
  // The caller-selected cap also bounds this entire closure input; no hidden SQL cap.
  if (!createBoundedPlainJsonSchema(limits.maxRowBytes).safeParse(rawRows).success)
    fail('INVALID_TEMPLATE_ROW_CLOSURE');
  const parsedRows = z.array(z.unknown()).safeParse(rawRows);
  if (!parsedRows.success) fail('INVALID_TEMPLATE_ROW_CLOSURE');
  const rows = parsedRows.data.map((row) => parser.parse(row));
  const templateRelations = new Set([
    'check_in_template_version',
    'check_in_template_head',
    'check_in_template_receipt',
  ]);
  if (rows.some((v) => !templateRelations.has(v.facts.relation)))
    fail('INVALID_TEMPLATE_ROW_CLOSURE');
  const versions = rows.flatMap((v) =>
    v.facts.relation === 'check_in_template_version' ? [v.facts.row] : [],
  );
  const heads = rows.flatMap((v) =>
    v.facts.relation === 'check_in_template_head' ? [v.facts.row] : [],
  );
  const receipts = rows.flatMap((v) =>
    v.facts.relation === 'check_in_template_receipt' ? [v.facts.row] : [],
  );
  const tuple = (...values: (string | number)[]) => JSON.stringify(values);
  const exact = new Map(versions.map((v) => [tuple(v.athlete_id, v.template_id, v.version_id), v]));
  const numbers = new Set(versions.map((v) => tuple(v.athlete_id, v.template_id, v.version)));
  const ids = new Set(versions.map((v) => tuple(v.athlete_id, v.version_id)));
  const headMap = new Map(heads.map((h) => [tuple(h.athlete_id, h.template_id), h]));
  if (
    exact.size !== versions.length ||
    numbers.size !== versions.length ||
    ids.size !== versions.length ||
    headMap.size !== heads.length
  )
    fail('INVALID_TEMPLATE_ROW_CLOSURE');
  for (const v of versions) {
    const head = headMap.get(tuple(v.athlete_id, v.template_id));
    if (!head || head.version < v.version) fail('INVALID_TEMPLATE_ROW_CLOSURE');
    if (v.previous_version_id !== null) {
      const prior = exact.get(tuple(v.athlete_id, v.template_id, v.previous_version_id));
      if (!prior || prior.version !== v.previous_version) fail('INVALID_TEMPLATE_ROW_CLOSURE');
    }
  }
  for (const h of heads)
    if (exact.get(tuple(h.athlete_id, h.template_id, h.version_id))?.version !== h.version)
      fail('INVALID_TEMPLATE_ROW_CLOSURE');
  const receiptKeys = new Set<string>(),
    receiptVersions = new Set<string>();
  for (const r of receipts) {
    const k = tuple(r.athlete_id, r.idempotency_key),
      v = tuple(r.athlete_id, r.version_id);
    if (
      receiptKeys.has(k) ||
      receiptVersions.has(v) ||
      !exact.has(tuple(r.athlete_id, r.template_id, r.version_id))
    )
      fail('INVALID_TEMPLATE_ROW_CLOSURE');
    receiptKeys.add(k);
    receiptVersions.add(v);
  }
  if (receiptVersions.size !== versions.length) fail('INVALID_TEMPLATE_ROW_CLOSURE');
  return Object.freeze({
    kind: 'validated_template_row_links_v1' as const,
    authority: 'none' as const,
    admissionAllowed: false as const,
    commandDigests: 'not_checked' as const,
  });
}
