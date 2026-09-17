import { z } from 'zod';
import { instantSchema } from './primitives.js';

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
export const coreEvidenceDependencyManifestSchema = z.strictObject({
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
export type CoreEvidenceDependencyManifest = z.infer<typeof coreEvidenceDependencyManifestSchema>;
export type CoreEvidenceDependencyField =
  'trainingPlan' | 'activities' | 'checkIns' | 'sessionCompletions' | 'aiConsent';
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
  if (!before.success || !after.success)
    return { status: 'unsupported', reason: 'INVALID_OR_UNSUPPORTED_MANIFEST' };
  if (before.data.athleteId !== after.data.athleteId)
    return { status: 'unsupported', reason: 'OWNER_MISMATCH' };
  const fields: CoreEvidenceDependencyField[] = [
    'trainingPlan',
    'activities',
    'checkIns',
    'sessionCompletions',
    'aiConsent',
  ];
  // Strict schema parsing produces a canonical field order; caller key order is irrelevant.
  const changed = fields.filter(
    (field) => JSON.stringify(before.data[field]) !== JSON.stringify(after.data[field]),
  );
  return changed.length ? { status: 'stale', changed } : { status: 'fresh', changed: [] };
}
