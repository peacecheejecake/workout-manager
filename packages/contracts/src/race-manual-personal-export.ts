import { z } from 'zod';
import { instantSchema } from './primitives.js';
import { planSnapshotSchema } from './planning.js';
import { routineScheduleVersionSchema } from './routines.js';
import {
  raceManualPublicPreviewReferenceSchema,
  raceManualPublicPreviewSchema,
} from './race-manual-public-preview.js';
import { raceManualPublicReviewResultSchema } from './race-manual-public.js';
import { raceManualApprovalResultSchema } from './race-manual-approval.js';

/** Standalone decoded personal-fact boundary. The account producer separately
 * enforces its aggregate 8 MiB and SQL response budget. No installed-profile,
 * current freshness, permission, original-event or restore authority is implied. */
export const RACE_MANUAL_PERSONAL_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const uuid = z.uuid().transform((value) => value.toLowerCase());
const identity = (value: string) =>
  z.uuid().safeParse(value).success ? value.toLowerCase() : value;
const original = z.unknown().superRefine((raw, ctx) => {
  const maximum = RACE_MANUAL_PERSONAL_EXPORT_MAX_BYTES;
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const charge = (text: string) => {
    if (text.length > maximum - bytes) return false;
    bytes += new TextEncoder().encode(text).byteLength;
    return bytes <= maximum;
  };
  function visit(value: unknown, depth: number): boolean {
    if (++nodes > maximum || depth > 64) return false;
    if (typeof value === 'string') return charge(value);
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximum || (array && keys.length !== value.length + 1)) return false;
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) ||
        !charge(key)
      )
        return false;
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (
        !property?.enumerable ||
        !Object.hasOwn(property, 'value') ||
        !visit(property.value, depth + 1)
      )
        return false;
    }
    ancestors.delete(value);
    return true;
  }
  let valid = false;
  try {
    valid = visit(raw, 0) && new TextEncoder().encode(JSON.stringify(raw)).byteLength <= maximum;
  } catch {
    // Reflection/serialization traps are finite input failures, not authority.
  }
  if (!valid)
    ctx.addIssue({ code: 'custom', message: 'Invalid or oversized plain personal facts' });
});
function preciseInstant(value: string): string | null {
  const match = /^(.*:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match?.[1] || !match[3]) return null;
  const seconds = Date.parse(match[1] + match[3]);
  return Number.isSafeInteger(seconds) ? `${seconds}:${(match[2] ?? '').padEnd(6, '0')}` : null;
}
function sameInstant(a: string, b: string): boolean {
  const value = preciseInstant(a);
  return value !== null && value === preciseInstant(b);
}
type Reference = z.infer<typeof raceManualPublicPreviewReferenceSchema>;
function sameReference(a: Reference, b: Reference): boolean {
  return (
    a.candidateId === b.candidateId &&
    a.applicationDigest === b.applicationDigest &&
    a.chain.evidenceId === b.chain.evidenceId &&
    a.chain.decisionId === b.chain.decisionId &&
    a.chain.proposalId === b.chain.proposalId &&
    a.chain.readonlyCandidateDigest === b.chain.readonlyCandidateDigest &&
    sameInstant(a.createdAt, b.createdAt)
  );
}
export const raceManualPersonalReviewSchema = z
  .strictObject({
    reference: raceManualPublicPreviewReferenceSchema,
    createdAt: instantSchema,
    bodyState: z.enum(['present', 'purged']),
    preview: raceManualPublicPreviewSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    if (
      !sameInstant(row.createdAt, row.reference.createdAt) ||
      (row.bodyState === 'purged' ? row.preview !== null : row.preview?.status !== 'present') ||
      (row.preview !== null && !sameReference(row.reference, row.preview.reference))
    )
      ctx.addIssue({ code: 'custom', message: 'Review state/reference correspondence required' });
  });
const historyBase = {
  candidateId: uuid,
  approvalId: uuid,
  aggregateId: uuid,
  approvedAt: instantSchema,
};
export const raceManualPersonalApprovalHistorySchema = z.discriminatedUnion('domain', [
  z.strictObject({
    ...historyBase,
    domain: z.literal('training'),
    versionId: planSnapshotSchema.shape.id.transform(identity),
  }),
  z.strictObject({ ...historyBase, domain: z.literal('nutrition'), versionId: uuid }),
  z.strictObject({ ...historyBase, domain: z.literal('recovery'), versionId: uuid }),
  z.strictObject({
    ...historyBase,
    domain: z.literal('routine_schedule'),
    versionId: routineScheduleVersionSchema.shape.versionId.transform(identity),
  }),
]);
/** Original successful returned results are audit facts, including their original
 * bodyState/notices. A later purge does not rewrite a successful receipt. */
export const raceManualPersonalCommandResultSchema = z
  .discriminatedUnion('operation', [
    z.strictObject({
      operation: z.literal('review'),
      candidateId: uuid,
      result: raceManualPublicReviewResultSchema,
    }),
    z.strictObject({
      operation: z.literal('approve'),
      candidateId: uuid,
      result: raceManualApprovalResultSchema,
    }),
  ])
  .superRefine((row, ctx) => {
    if (row.operation === 'review') {
      if (row.result.status !== 'reviewed' || row.result.reference.candidateId !== row.candidateId)
        ctx.addIssue({ code: 'custom', message: 'Durable review result requires its candidate' });
    } else if (row.result.status !== 'committed' || row.result.candidateId !== row.candidateId)
      ctx.addIssue({ code: 'custom', message: 'Durable approval result requires its candidate' });
  });
export const raceManualPersonalExportFields = {
  manualRaceReviews: z.array(raceManualPersonalReviewSchema).max(1000),
  manualRaceApprovalHistory: z.array(raceManualPersonalApprovalHistorySchema).max(1000),
  manualRaceCommandResults: z.array(raceManualPersonalCommandResultSchema).max(1000),
};
type Data = z.infer<z.ZodObject<typeof raceManualPersonalExportFields>>;
export function validateRaceManualPersonalExportTuples(data: Data, ctx: z.RefinementCtx): void {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const reviews = new Map<string, Data['manualRaceReviews'][number]>();
  const commands = new Map<string, Data['manualRaceCommandResults'][number]>();
  const approvalCandidates = new Map<string, string>();
  for (const row of data.manualRaceReviews) {
    const key = row.reference.candidateId;
    if (reviews.has(key)) fail('Duplicate review candidate');
    reviews.set(key, row);
  }
  for (const row of data.manualRaceCommandResults) {
    const key = JSON.stringify([row.operation, row.candidateId]);
    if (commands.has(key)) fail('Duplicate normalized command result');
    commands.set(key, row);
    const review = reviews.get(row.candidateId);
    if (!review) fail('Command result requires its review');
    if (
      row.operation === 'review' &&
      row.result.status === 'reviewed' &&
      review &&
      !sameReference(review.reference, row.result.reference)
    )
      fail('Review receipt reference mismatch');
    if (row.operation === 'approve' && row.result.status === 'committed') {
      if (review && row.result.proposalId !== review.reference.chain.proposalId)
        fail('Approval proposal mismatch');
      if (approvalCandidates.has(row.result.approvalId)) fail('Duplicate approval identity');
      approvalCandidates.set(row.result.approvalId, row.candidateId);
    }
  }
  const historyKeys = new Set<string>();
  for (const row of data.manualRaceApprovalHistory) {
    const key = JSON.stringify([row.approvalId, row.domain, row.aggregateId]);
    if (historyKeys.has(key)) fail('Duplicate approval history');
    historyKeys.add(key);
    const command = commands.get(JSON.stringify(['approve', row.candidateId]));
    if (
      !command ||
      command.operation !== 'approve' ||
      command.result.status !== 'committed' ||
      command.result.approvalId !== row.approvalId ||
      !sameInstant(command.result.approvedAt, row.approvedAt) ||
      !command.result.versions.some(
        (v) =>
          v.domain === row.domain &&
          v.aggregateId === row.aggregateId &&
          v.versionId === row.versionId,
      )
    )
      fail('History requires exact original committed version membership');
  }
  for (const row of data.manualRaceCommandResults) {
    if (row.operation !== 'approve' || row.result.status !== 'committed') continue;
    for (const version of row.result.versions) {
      if (
        !historyKeys.has(
          JSON.stringify([row.result.approvalId, version.domain, version.aggregateId]),
        )
      )
        fail('Committed version requires its approval history');
    }
  }
}
/** Required complete collections; missing installed ports are producer failures,
 * never default empty. Domain-owned version authenticity is an aggregate seam. */
export const raceManualPersonalExportDataSchema = original.pipe(
  z
    .strictObject(raceManualPersonalExportFields)
    .superRefine(validateRaceManualPersonalExportTuples),
);
export type RaceManualPersonalExportData = z.infer<typeof raceManualPersonalExportDataSchema>;
