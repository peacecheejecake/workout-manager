import { z } from 'zod';
import type { Database, Transaction } from './database.js';
import { raceImpactConsumedCaptureSchema } from './race-plan-impact-complete-manifest.js';
import { raceProjectionIntentSchema } from './race-plan-impact-projection-input.js';
import {
  impactDependencyDigest,
  decodeIntegratedDependencyInventory,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
import {
  assertRaceManualPlainV2,
  prepareRaceManualConsumedUseV2In,
  raceManualConsumedUseFactsV2Schema,
  type RaceManualConsumedUsePreparationV2,
} from './race-manual-review-consumed-use-v2.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';
import type { SourceBudget } from './race-plan-impact-nested-sources.js';

const cap = raceImpactConsumedCaptureSchema;
const limitations = {
  authority: 'none',
  permissionAuthority: 'none',
  storage: 'not_persisted',
  admissionAllowed: false,
  approvalAllowed: false,
} as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const plain = z.unknown().superRefine((value, ctx) => {
  try {
    assertRaceManualPlainV2(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid bounded plain semantic basis' });
  }
});
function rosterState<T extends z.ZodType>(members: z.ZodArray<T>) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('absent') }),
    z.strictObject({ state: z.literal('present'), members: members.min(1) }),
  ]);
}
const mutableKind = z.enum([
  'intake_revision',
  'activity_revision',
  'execution_revision',
  'set_revision',
  'routine_run_revision',
  'routine_occurrence_revision',
  'recovery_action_revision',
]);
function boundedResult<T>(result: T): T {
  assertRaceManualPlainV2(result);
  return result;
}
/** Manual-purpose dependency projection only. AI review/coach/share cleanup metadata
 * remains in observed uses; it is not raw-text withdrawal or a permission seal.
 * Media purpose carries actual individual consent, finalized descriptor revision
 * and deletion inventory; these are relevant sources, never AI coach-use flags. */
export const raceManualPurposeUseProjectionV2Schema = raceManualConsumedUseFactsV2Schema.extend({
  purposeProjectionVersion: z.literal(2),
  facts: z
    .array(
      raceManualConsumedUseFactsV2Schema.shape.facts.element
        .omit({ resourceAccess: true })
        .extend({ resourceSource: z.strictObject({ deleted: z.boolean() }).nullable() }),
    )
    .max(5000),
});
export function projectRaceManualPurposeUsesV2(unknownUses: unknown) {
  assertRaceManualPlainV2(unknownUses);
  const uses = raceManualConsumedUseFactsV2Schema.parse(unknownUses);
  return raceManualPurposeUseProjectionV2Schema.parse({
    ...uses,
    purposeProjectionVersion: 2,
    facts: uses.facts.map(({ resourceAccess, ...fact }) => ({
      ...fact,
      resourceSource: resourceAccess === null ? null : { deleted: resourceAccess.deleted },
    })),
  });
}
const body = z.strictObject({
  basisVersion: z.literal(2),
  athleteId: cap.shape.athleteId,
  restoreGeneration: cap.shape.restoreGeneration,
  intent: raceProjectionIntentSchema,
  manualBasis: cap.shape.manualBasis,
  event: cap.shape.event,
  collectorSelection: cap.shape.collectorSelection.unwrap(),
  heads: z.strictObject({
    nutrition: rosterState(cap.shape.rosters.shape.nutrition),
    recovery: rosterState(cap.shape.rosters.shape.recovery),
    routine: rosterState(cap.shape.rosters.shape.routine),
  }),
  currentTraining: cap.shape.currentTraining,
  core: z.union([
    cap.shape.coreDependencies.options[0].omit({
      capturedAt: true,
      aiConsent: true,
      activities: true,
    }),
    cap.shape.coreDependencies.options[1].omit({
      capturedAt: true,
      aiConsent: true,
      activities: true,
    }),
  ]),
  // A complete exact Activity roster replaces the weak count/revisionSum summary.
  activities: cap.shape.sourcePermissionManifest.shape.activityMediaPermissions.shape.activities,
  // Race-event collection gates source selection; result/PB collections are unused here.
  eventCollection: cap.shape.collections.element.nullable(),
  dependencyHeads: z
    .array(
      z.discriminatedUnion('state', [
        z.strictObject({ kind: mutableKind, state: z.literal('absent') }),
        z.strictObject({
          kind: mutableKind,
          state: z.literal('present'),
          revision: z.number().int().min(0).max(2147483647),
        }),
      ]),
    )
    .length(7)
    .refine((v) => new Set(v.map((x) => x.kind)).size === v.length),
  copiedSources: z
    .array(
      z.strictObject({
        identity: raceManualConsumedUseFactsV2Schema.shape.facts.element.shape.identity,
        dtoDigest: hash,
      }),
    )
    .max(5000),
  consumedUses: raceManualPurposeUseProjectionV2Schema,
});
/** Optimistic server-derived expectation only. Parsing this JSON is never permission,
 * authenticated snapshot or storage authority. Raw capture digest is separate. */
export const raceManualSemanticBasisV2Schema = plain.pipe(body);
export type RaceManualSemanticBasisV2 = z.infer<typeof raceManualSemanticBasisV2Schema>;
/** Pure correspondence diagnostic; only the actual entry below can produce a current
 * basis from fenced DB capture. Equal hashes do not authorize a writer. */
export function compareRaceManualSemanticBasisV2(expected: unknown, current: unknown) {
  const e = raceManualSemanticBasisV2Schema.safeParse(expected),
    c = raceManualSemanticBasisV2Schema.safeParse(current);
  if (!e.success || !c.success)
    return boundedResult({
      status: 'blocked' as const,
      reason: 'invalid_semantic_basis' as const,
      ...limitations,
    });
  return {
    status:
      impactDependencyDigest(e.data) === impactDependencyDigest(c.data)
        ? ('matched_dependencies' as const)
        : ('blocked' as const),
    reason:
      impactDependencyDigest(e.data) === impactDependencyDigest(c.data)
        ? null
        : ('semantic_basis_changed' as const),
    ...limitations,
  };
}
function semanticBasis(
  prepared: RaceManualConsumedUsePreparationV2,
  intent: z.infer<typeof raceProjectionIntentSchema>,
) {
  if (!('retained' in prepared) || prepared.retained.state !== 'present')
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const c = prepared.retained.payload.preparation.context;
  const { capturedAt: _at, aiConsent: _ai, activities: _summary, ...core } = c.coreDependencies;
  // Immutable catalog heads may advance without changing a frozen consumed body.
  // Mutable actual collections and source selection dependencies remain relevant.
  const mutableKinds = new Set([
    'intake_revision',
    'activity_revision',
    'execution_revision',
    'set_revision',
    'routine_run_revision',
    'routine_occurrence_revision',
    'recovery_action_revision',
  ]);
  return raceManualSemanticBasisV2Schema.parse({
    basisVersion: 2,
    athleteId: c.athleteId,
    restoreGeneration: c.restoreGeneration,
    intent,
    manualBasis: c.manualBasis,
    event: c.event,
    collectorSelection: c.collectorSelection,
    heads: Object.fromEntries(
      Object.entries(c.rosters).map(([kind, members]) => [
        kind,
        members.length ? { state: 'present', members } : { state: 'absent' },
      ]),
    ),
    currentTraining: c.currentTraining,
    core,
    activities: c.sourcePermissionManifest.activityMediaPermissions.activities,
    eventCollection: c.collections.find((x) => x.kind === 'race-event') ?? null,
    dependencyHeads: decodeIntegratedDependencyInventory(c.dependencyInventory).filter((x) =>
      mutableKinds.has(x.kind),
    ),
    copiedSources: prepared.retained.payload.inventory.refs.map((r) => ({
      identity: r.identity,
      dtoDigest: r.dtoDigest,
    })),
    consumedUses: projectRaceManualPurposeUsesV2(prepared.uses),
  });
}
/** Current binding/fullowned/retained/purpose capture are directly consumed here.
 * Intent and optimistic expectation only; successful receipt lookup belongs to the
 * later chain writer before invoking this path. No fallback to public RC capture. */
export async function prepareRaceManualSemanticBasisV2In(
  tx: Transaction,
  unknownIntent: unknown,
  expected: unknown | null,
  budget: SourceBudget,
) {
  validateRaceSourceResponseBudget(budget);
  assertRaceManualPlainV2(unknownIntent);
  const intent = raceProjectionIntentSchema.parse(unknownIntent);
  if (expected !== null && !raceManualSemanticBasisV2Schema.safeParse(expected).success)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const prepared = await prepareRaceManualConsumedUseV2In(tx, intent, budget);
  if (prepared.status !== 'observed_manual_use')
    return boundedResult({
      status: 'blocked' as const,
      reason: 'consumed_use_blocked' as const,
      prepared,
      ...limitations,
      freshness: 'not_checked' as const,
    });
  const basis = semanticBasis(prepared, intent),
    semanticDigest = impactDependencyDigest(basis);
  const compared = expected === null ? null : compareRaceManualSemanticBasisV2(expected, basis);
  if (compared?.status === 'blocked')
    return boundedResult({
      status: 'blocked' as const,
      reason: compared.reason,
      basis,
      semanticDigest,
      rawReadSetDigest: prepared.retained.payload.preparation.context.readSetDigest,
      ...limitations,
      freshness: 'read_dependencies_compared' as const,
    });
  const result = {
    status: 'current_dependencies_captured' as const,
    reason: compared?.reason ?? null,
    basis,
    semanticDigest,
    rawReadSetDigest: prepared.retained.payload.preparation.context.readSetDigest,
    prepared,
    ...limitations,
    freshness:
      expected === null
        ? ('current_dependencies_captured' as const)
        : ('read_dependencies_compared' as const),
  };
  assertRaceManualPlainV2(result);
  return result;
}
export function createRaceManualSemanticBasisV2Service(database: Database) {
  return {
    async prepare(
      athleteId: string,
      intent: unknown,
      expected: unknown | null = null,
      budget: SourceBudget = { bytes: 0n, sources: 0 },
    ) {
      assertRaceManualPlainV2(intent);
      const parsedIntent = raceProjectionIntentSchema.parse(intent);
      if (expected !== null && !raceManualSemanticBasisV2Schema.safeParse(expected).success)
        throw new RaceImpactDependencyError('INVALID_CONTEXT');
      if (!database.snapshotTenant) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE');
      return database.snapshotTenant(athleteId, (tx) =>
        prepareRaceManualSemanticBasisV2In(tx, parsedIntent, expected, budget),
      );
    },
  };
}
