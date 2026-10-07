import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  integratedApprovalResultV4Schema,
  integratedCandidateV4Schema,
  type IntegratedCandidateV4,
} from '@workout/contracts/integrated-coaching';
import { nutritionPlanVersionCompatibleV3Schema } from '@workout/contracts/nutrition-race-plan-v3';

export const nutritionCopiedSourceMaximumRefs = 5000;
export const nutritionCopiedSourceMaximumRowBytes = 512 * 1024;
export const nutritionCopiedSourceMaximumTotalBytes = 4 * 1024 * 1024;

// Exactly the current V4 producer's tenant aggregate heads, not arbitrary source kinds.
export const integratedV4ContextDependencyKinds = Object.freeze([
  'activity-head',
  'intake-head',
  'supplementary-execution-head',
  'supplementary-set-head',
  'food-catalog-head',
  'exercise-catalog-head',
  'routine-catalog-head',
  'routine-run-head',
  'routine-occurrence-head',
  'routine-blueprint-head',
  'recovery-action-head',
  'recovery-method-head',
  'check-in-head',
  'session-completion-head',
  'coaching-constraint-head',
  'ai-consent',
] as const);
const tenant = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const candidateIdentity = z.strictObject({
  athleteId: tenant,
  id: uuid,
  proposalId: uuid,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
});
export type NutritionCopiedVersionRef = Readonly<{
  namespace: 'nutrition-plan-version';
  planId: string;
  versionId: string;
}>;
export type NutritionCopiedItemRef = Readonly<{
  planId: string;
  versionId: string;
  itemId: string;
}>;
export type NutritionCopiedRaceRef = Readonly<{
  namespace: 'race-event';
  eventId: string;
}>;
export type NutritionCopiedSourceManifest = Readonly<{
  manifestVersion: 1;
  athleteId: string;
  candidateId: string;
  payloadDigestVersion: 'integrated-candidate-v4-canonical-v1';
  payloadDigest: string;
  nutritionVersions: readonly NutritionCopiedVersionRef[];
  races: readonly NutritionCopiedRaceRef[];
  nutritionItemRefs: readonly NutritionCopiedItemRef[];
}>;
type UnsupportedReason =
  | 'invalid_identity'
  | 'invalid_body'
  | 'identity_mismatch'
  | 'payload_digest_mismatch'
  | 'unsupported_dependencies'
  | 'invalid_source_ref'
  | 'duplicate_source_head'
  | 'source_tuple_mismatch'
  | 'source_unavailable'
  | 'source_limit';
export type NutritionCopiedSourceClassification =
  | { kind: 'unsupported'; reason: UnsupportedReason }
  | { kind: 'known_unrelated'; manifest: NutritionCopiedSourceManifest }
  | {
      kind: 'related';
      manifest: NutritionCopiedSourceManifest;
      disconnectedVersions: readonly NutritionCopiedVersionRef[];
    };
export type NutritionCopiedSourceInspection =
  | { kind: 'unsupported'; reason: UnsupportedReason }
  | {
      kind: 'supported';
      candidate: IntegratedCandidateV4;
      manifest: NutritionCopiedSourceManifest;
    };
const unsupported = (
  reason: UnsupportedReason,
): { kind: 'unsupported'; reason: UnsupportedReason } => ({ kind: 'unsupported', reason });
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Undefined canonical value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}
/** Same exact payload projection used by the actual prepare producer. */
export function integratedCandidatePayloadDigest(
  candidate: Pick<
    IntegratedCandidateV4,
    'proposalId' | 'basis' | 'writes' | 'summary' | 'validation'
  >,
): string {
  return createHash('sha256')
    .update(
      canonical({
        proposalId: candidate.proposalId,
        basis: candidate.basis,
        writes: candidate.writes,
        summary: candidate.summary,
        validation: candidate.validation,
      }),
    )
    .digest('hex');
}
function instantKey(value: string) {
  // Whole seconds + original fractional digits; Date never compares microseconds.
  const match = /\.(\d+)(?=Z|[+-]\d\d:\d\d$)/.exec(value);
  return `${Date.parse(value.replace(/\.\d+(?=Z|[+-]\d\d:\d\d$)/, ''))}:${(match?.[1] ?? '').replace(/0+$/, '')}`;
}
const tupleKey = (ref: Pick<NutritionCopiedVersionRef, 'planId' | 'versionId'>) =>
  `${ref.planId}:${ref.versionId}`;
/** Extraction is a descriptor, NOT source ownership/deletion/admission authority. */
export function inspectIntegratedNutritionCopiedSources(input: {
  identity: unknown;
  body: unknown;
}): NutritionCopiedSourceInspection {
  try {
    const encoded = JSON.stringify(input.body);
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded) > nutritionCopiedSourceMaximumTotalBytes
    )
      return unsupported('source_limit');
  } catch {
    return unsupported('invalid_body');
  }
  const identity = candidateIdentity.safeParse(input.identity),
    body = integratedCandidateV4Schema.safeParse(input.body);
  if (!identity.success) return unsupported('invalid_identity');
  if (!body.success) return unsupported('invalid_body');
  const candidate = body.data;
  if (
    candidate.id !== identity.data.id ||
    candidate.proposalId !== identity.data.proposalId ||
    candidate.digest !== identity.data.digest ||
    instantKey(candidate.createdAt) !== instantKey(identity.data.createdAt)
  )
    return unsupported('identity_mismatch');
  if (integratedCandidatePayloadDigest(candidate) !== candidate.digest)
    return unsupported('payload_digest_mismatch');
  const dependencies = candidate.basis.contextDependencies;
  if (
    dependencies.length !== integratedV4ContextDependencyKinds.length ||
    new Set(dependencies.map((ref) => ref.kind)).size !== dependencies.length ||
    dependencies.some(
      (ref) =>
        !integratedV4ContextDependencyKinds.some((kind) => kind === ref.kind) ||
        ref.id !== 'tenant' ||
        (ref.kind === 'ai-consent'
          ? !/^[1-9][0-9]*:true$/.test(ref.revision)
          : !/^(0|[1-9][0-9]*)$/.test(ref.revision)),
    )
  )
    return unsupported('unsupported_dependencies');
  const nutritionVersions = new Map<string, NutritionCopiedVersionRef>(),
    races = new Map<string, NutritionCopiedRaceRef>(),
    nutritionItemRefs = new Map<string, NutritionCopiedItemRef>(),
    heads = new Set<string>();
  let visitedRefs = 0;
  for (const head of candidate.basis.planHeads) {
    if (++visitedRefs > nutritionCopiedSourceMaximumRefs) return unsupported('source_limit');
    const planId = uuid.safeParse(head.aggregateId),
      versionId = head.head.kind === 'exists' ? uuid.safeParse(head.head.versionId) : null;
    if (!planId.success || (versionId !== null && !versionId.success))
      return unsupported('invalid_source_ref');
    const key = `${head.domain}:${planId.data}`;
    if (heads.has(key)) return unsupported('duplicate_source_head');
    heads.add(key);
    if (head.domain === 'nutrition' && versionId?.success) {
      const ref: NutritionCopiedVersionRef = {
        namespace: 'nutrition-plan-version',
        planId: planId.data,
        versionId: versionId.data,
      };
      nutritionVersions.set(tupleKey(ref), ref);
    }
  }
  for (const write of candidate.writes) {
    if (!uuid.safeParse(write.aggregateId).success) return unsupported('invalid_source_ref');
    if (write.domain === 'nutrition')
      for (const item of write.proposed.items) {
        if (item.anchor.kind !== 'relative' || item.anchor.entity !== 'race') continue;
        if (++visitedRefs > nutritionCopiedSourceMaximumRefs) return unsupported('source_limit');
        const id = uuid.safeParse(item.anchor.entityId);
        if (!id.success) return unsupported('invalid_source_ref');
        races.set(id.data, { namespace: 'race-event', eventId: id.data });
      }
    if (write.domain === 'recovery')
      for (const plan of write.proposed.planRefs) {
        if (plan.kind !== 'nutrition') continue;
        if (++visitedRefs > nutritionCopiedSourceMaximumRefs) return unsupported('source_limit');
        const planId = uuid.safeParse(plan.aggregateId),
          versionId = uuid.safeParse(plan.headVersionId);
        if (!planId.success || !versionId.success) return unsupported('invalid_source_ref');
        const ref: NutritionCopiedVersionRef = {
          namespace: 'nutrition-plan-version',
          planId: planId.data,
          versionId: versionId.data,
        };
        if (!nutritionVersions.has(tupleKey(ref))) return unsupported('source_tuple_mismatch');
      }
    if (write.domain === 'routine_schedule')
      for (const occurrence of write.occurrences)
        for (const binding of occurrence.stepBindings) {
          const planned = binding.plannedRef;
          if (planned.domain !== 'nutrition') continue;
          if (++visitedRefs > nutritionCopiedSourceMaximumRefs) return unsupported('source_limit');
          const planId = uuid.safeParse(planned.planId),
            versionId = uuid.safeParse(planned.versionId);
          if (!planId.success || !versionId.success) return unsupported('invalid_source_ref');
          const ref: NutritionCopiedItemRef = {
            planId: planId.data,
            versionId: versionId.data,
            itemId: planned.itemId,
          };
          if (!nutritionVersions.has(tupleKey(ref))) return unsupported('source_tuple_mismatch');
          nutritionItemRefs.set(JSON.stringify([ref.planId, ref.versionId, ref.itemId]), ref);
        }
  }
  if (
    nutritionVersions.size + races.size + nutritionItemRefs.size >
    nutritionCopiedSourceMaximumRefs
  )
    return unsupported('source_limit');
  return {
    kind: 'supported',
    candidate,
    manifest: {
      manifestVersion: 1,
      athleteId: identity.data.athleteId,
      candidateId: candidate.id,
      payloadDigestVersion: 'integrated-candidate-v4-canonical-v1',
      payloadDigest: candidate.digest,
      nutritionVersions: [...nutritionVersions.values()].sort((a, b) =>
        tupleKey(a) < tupleKey(b) ? -1 : tupleKey(a) > tupleKey(b) ? 1 : 0,
      ),
      nutritionItemRefs: [...nutritionItemRefs.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, ref]) => ref),
      races: [...races.values()].sort((a, b) =>
        a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0,
      ),
    },
  };
}
const sourceRow = z.strictObject({
  athlete_id: tenant,
  plan_id: uuid,
  version_id: uuid,
  record_json: nutritionPlanVersionCompatibleV3Schema,
});
/** Validates exact frozen source rows, never substitutes current aggregate heads.
 * Caller must read through its authenticated tenant transaction. Race owner/event
 * and original suppression authority remain SQL-B; this does not grant approval. */
export function classifyIntegratedNutritionCopiedSources(input: {
  identity: unknown;
  body: unknown;
  nutritionRows: readonly unknown[];
}): NutritionCopiedSourceClassification {
  const inspected = inspectIntegratedNutritionCopiedSources(input);
  if (inspected.kind === 'unsupported') return inspected;
  const { manifest } = inspected,
    expected = new Set(manifest.nutritionVersions.map(tupleKey)),
    seen = new Set<string>(),
    disconnectedVersions: NutritionCopiedVersionRef[] = [];
  for (const unknownRow of input.nutritionRows) {
    const parsed = sourceRow.safeParse(unknownRow);
    if (!parsed.success) return unsupported('source_tuple_mismatch');
    const row = parsed.data,
      ref: NutritionCopiedVersionRef = {
        namespace: 'nutrition-plan-version',
        planId: row.plan_id,
        versionId: row.version_id,
      };
    const key = tupleKey(ref);
    if (
      row.athlete_id !== manifest.athleteId ||
      row.record_json.planId !== row.plan_id ||
      row.record_json.versionId !== row.version_id ||
      !expected.has(key) ||
      seen.has(key)
    )
      return unsupported('source_tuple_mismatch');
    const itemIds = new Set(row.record_json.items.map((item) => item.id));
    if (
      manifest.nutritionItemRefs.some(
        (itemRef) => tupleKey(itemRef) === key && !itemIds.has(itemRef.itemId),
      )
    )
      return unsupported('source_unavailable');
    seen.add(key);
    if (row.record_json.items.some((item) => item.anchor.kind === 'disconnected'))
      disconnectedVersions.push(ref);
  }
  if (seen.size !== expected.size) return unsupported('source_unavailable');
  return expected.size === 0 && manifest.races.length === 0
    ? { kind: 'known_unrelated', manifest }
    : { kind: 'related', manifest, disconnectedVersions };
}
/** Minimal committed approval facts have no nutrition body/pins to redact. */
export function classifyIntegratedApprovalNutritionCopies(input: {
  identity: unknown;
  body: unknown;
}):
  | { kind: 'known_unrelated' }
  | { kind: 'unsupported'; reason: 'invalid_body' | 'identity_mismatch' } {
  const body = integratedApprovalResultV4Schema.safeParse(input.body);
  const identity = z
    .strictObject({
      approvalId: uuid,
      candidateId: uuid,
      approvedAt: z.iso.datetime({ offset: true }),
    })
    .safeParse(input.identity);
  if (!body.success || !identity.success) return { kind: 'unsupported', reason: 'invalid_body' };
  const versions = body.data.versions.map((ref) => `${ref.domain}:${ref.aggregateId}`);
  if (
    new Set(versions).size !== versions.length ||
    new Set(body.data.occurrenceIds).size !== body.data.occurrenceIds.length
  )
    return { kind: 'unsupported', reason: 'invalid_body' };
  if (
    body.data.approvalId !== identity.data.approvalId ||
    body.data.candidateId !== identity.data.candidateId ||
    instantKey(body.data.approvedAt) !== instantKey(identity.data.approvedAt)
  )
    return { kind: 'unsupported', reason: 'identity_mismatch' };
  return { kind: 'known_unrelated' };
}
