import { z } from 'zod';
import { instantSchema } from './primitives.js';
import { privateResourceCoachUseManifestSchema } from './resources.js';

const unsignedDecimalSchema = z
  .string()
  .max(40)
  .regex(/^(0|[1-9][0-9]*)$/);
const headRevisionSchema = z.number().int().positive().max(2147483647);
const revisionHeadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({ kind: z.literal('exists'), revision: headRevisionSchema }),
]);
const activitiesSchema = z
  .strictObject({ count: unsignedDecimalSchema, revisionSum: unsignedDecimalSchema })
  .refine((value) => {
    // Check bounds again before BigInt: refinements can run after field validation fails.
    if (
      !unsignedDecimalSchema.safeParse(value.count).success ||
      !unsignedDecimalSchema.safeParse(value.revisionSum).success
    )
      return false;
    const count = BigInt(value.count);
    const sum = BigInt(value.revisionSum);
    return count === 0n ? sum === 0n : sum >= count;
  }, 'Canonical revisions must cover every canonical row');

/** Conservative core-ledger capture, including canonical activity tombstones.
 * Excludes detail/provider heads and is not the complete coaching expectedBasis.
 */
export const coreEvidenceDependencyManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('core-ledgers-v1'),
  athleteId: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value === value.trim()),
  capturedAt: instantSchema,
  trainingPlan: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('absent') }),
    z.strictObject({
      kind: z.literal('exists'),
      versionId: z
        .uuid()
        .refine((value) => value === value.toLowerCase(), 'Expected canonical lowercase UUID'),
    }),
  ]),
  activities: activitiesSchema,
  checkIns: revisionHeadSchema,
  sessionCompletions: revisionHeadSchema,
  aiConsent: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('absent') }),
    z.strictObject({
      kind: z.literal('exists'),
      revision: headRevisionSchema,
      granted: z.boolean(),
    }),
  ]),
});
export const coreEvidenceDependencyManifestV2Schema = coreEvidenceDependencyManifestV1Schema.extend(
  {
    schemaVersion: z.literal(2),
    scope: z.literal('core-ledgers-v2'),
    userConstraints: revisionHeadSchema,
  },
);
export const coreEvidenceDependencyManifestSchema = z.discriminatedUnion('schemaVersion', [
  coreEvidenceDependencyManifestV1Schema,
  coreEvidenceDependencyManifestV2Schema,
]);
export type CoreEvidenceDependencyManifestV1 = z.infer<
  typeof coreEvidenceDependencyManifestV1Schema
>;
export type CoreEvidenceDependencyManifestV2 = z.infer<
  typeof coreEvidenceDependencyManifestV2Schema
>;
export type CoreEvidenceDependencyManifest = z.infer<typeof coreEvidenceDependencyManifestSchema>;
export type CoreEvidenceDependencyField =
  | 'trainingPlan'
  | 'activities'
  | 'checkIns'
  | 'sessionCompletions'
  | 'aiConsent'
  | 'userConstraints';
export type CoreEvidenceDependencyComparison =
  | { status: 'fresh'; changed: [] }
  | { status: 'stale'; changed: CoreEvidenceDependencyField[] }
  | { status: 'unsupported'; reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' | 'OWNER_MISMATCH' };

/** Revision equality only: capturedAt is ignored. No age policy or approval authorization.
 * Callers must revalidate within their eventual atomic approval transaction.
 */
export function compareCoreEvidenceDependencies(
  expected: unknown,
  current: unknown,
): CoreEvidenceDependencyComparison {
  const before = coreEvidenceDependencyManifestSchema.safeParse(expected);
  const after = coreEvidenceDependencyManifestSchema.safeParse(current);
  if (!before.success || !after.success || before.data.schemaVersion !== after.data.schemaVersion)
    return { status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' };
  if (before.data.athleteId !== after.data.athleteId)
    return { status: 'unsupported', reason: 'OWNER_MISMATCH' };
  const fields: Exclude<CoreEvidenceDependencyField, 'userConstraints'>[] = [
    'trainingPlan',
    'activities',
    'checkIns',
    'sessionCompletions',
    'aiConsent',
  ];
  // Strict schema parsing produces a canonical field order; caller key order is irrelevant.
  const changed: CoreEvidenceDependencyField[] = fields.filter(
    (field) => JSON.stringify(before.data[field]) !== JSON.stringify(after.data[field]),
  );
  if (
    before.data.schemaVersion === 2 &&
    after.data.schemaVersion === 2 &&
    JSON.stringify(before.data.userConstraints) !== JSON.stringify(after.data.userConstraints)
  )
    changed.push('userConstraints');
  return changed.length ? { status: 'stale', changed } : { status: 'fresh', changed: [] };
}

/**
 * Resource access is the second half of the dependency manifest an approval has
 * to validate. `resource-access-v1` is captured by the resource ledger and pins
 * the complete authorized coach-use set — including its absence — behind one
 * digest, so a deletion, a consent withdrawal, a revoked share or a review
 * downgrade after capture is observable as a changed set rather than as a
 * missing entry.
 */
export const resourceAccessDependencyManifestSchema = privateResourceCoachUseManifestSchema;
export type ResourceAccessDependencyManifest = z.infer<
  typeof resourceAccessDependencyManifestSchema
>;
export type ResourceAccessDependencyField = 'aiConsent' | 'authorizedSet';
export type ResourceAccessDependencyComparison =
  | { status: 'fresh'; changed: [] }
  | { status: 'stale'; changed: ResourceAccessDependencyField[] }
  | { status: 'unsupported'; reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' | 'OWNER_MISMATCH' };

/** Digest equality only. The digest is an unkeyed self-consistency check over a
 * server-produced manifest, not proof of origin; callers must recheck the gate
 * inside their own write transaction. */
export function compareResourceAccessDependencies(
  expected: unknown,
  current: unknown,
): ResourceAccessDependencyComparison {
  const before = resourceAccessDependencyManifestSchema.safeParse(expected);
  const after = resourceAccessDependencyManifestSchema.safeParse(current);
  if (!before.success || !after.success)
    return { status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' };
  if (before.data.athleteId !== after.data.athleteId)
    return { status: 'unsupported', reason: 'OWNER_MISMATCH' };
  const changed: ResourceAccessDependencyField[] = [];
  if (
    before.data.aiConsentRevision !== after.data.aiConsentRevision ||
    before.data.aiConsentGranted !== after.data.aiConsentGranted
  )
    changed.push('aiConsent');
  if (before.data.entriesDigest !== after.data.entriesDigest) changed.push('authorizedSet');
  return changed.length ? { status: 'stale', changed } : { status: 'fresh', changed: [] };
}

/** The complete dependency manifest: core ledger heads plus resource access. */
export const evidenceDependencyManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.literal('evidence-dependencies-v1'),
  core: coreEvidenceDependencyManifestSchema,
  resourceAccess: resourceAccessDependencyManifestSchema,
});
export type EvidenceDependencyManifest = z.infer<typeof evidenceDependencyManifestSchema>;
export type EvidenceDependencyChange =
  `core.${CoreEvidenceDependencyField}` | `resourceAccess.${ResourceAccessDependencyField}`;
export type EvidenceDependencyComparison =
  | { status: 'fresh'; changed: [] }
  | { status: 'stale'; changed: EvidenceDependencyChange[] }
  | {
      status: 'unsupported';
      reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' | 'OWNER_MISMATCH';
    };

/** Both halves must be present and both must be fresh; a missing half is
 * unsupported, never treated as unchanged. */
export function compareEvidenceDependencies(
  expected: unknown,
  current: unknown,
): EvidenceDependencyComparison {
  const before = evidenceDependencyManifestSchema.safeParse(expected);
  const after = evidenceDependencyManifestSchema.safeParse(current);
  if (!before.success || !after.success)
    return { status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' };
  if (
    before.data.core.athleteId !== after.data.core.athleteId ||
    before.data.resourceAccess.athleteId !== after.data.resourceAccess.athleteId ||
    before.data.core.athleteId !== before.data.resourceAccess.athleteId ||
    after.data.core.athleteId !== after.data.resourceAccess.athleteId
  )
    return { status: 'unsupported', reason: 'OWNER_MISMATCH' };
  const core = compareCoreEvidenceDependencies(before.data.core, after.data.core);
  const resourceAccess = compareResourceAccessDependencies(
    before.data.resourceAccess,
    after.data.resourceAccess,
  );
  if (core.status === 'unsupported' || resourceAccess.status === 'unsupported')
    return {
      status: 'unsupported',
      reason:
        core.status === 'unsupported'
          ? core.reason
          : (resourceAccess as { reason: 'OWNER_MISMATCH' | 'INVALID_OR_UNSUPPORTED_MANIFEST' })
              .reason,
    };
  const changed: EvidenceDependencyChange[] = [
    ...core.changed.map((field) => `core.${field}` as const),
    ...resourceAccess.changed.map((field) => `resourceAccess.${field}` as const),
  ];
  return changed.length ? { status: 'stale', changed } : { status: 'fresh', changed: [] };
}
