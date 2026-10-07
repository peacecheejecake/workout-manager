import { z } from 'zod';
import {
  recoveryStrategyVersionSchema,
  recoveryMethodVersionSchema,
} from '@workout/contracts/recovery-core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { nutritionPlanVersionCompatibleV4Schema } from '@workout/contracts/nutrition-race-plan-v4';
import { impactDependencyDigest } from './race-plan-impact-dependencies.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const storedVersion = z.number().int().min(1).max(2147483646);
const strategyBody = recoveryStrategyVersionSchema.safeExtend({ version: storedVersion });
const methodBody = recoveryMethodVersionSchema.safeExtend({ version: storedVersion });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const tuple = z.strictObject({ aggregateId: uuid, versionId: uuid });
const head = z.strictObject({ aggregate_id: uuid, version_id: uuid });
const methodCatalog = z.strictObject({
  requested: z.strictObject({
    kind: z.literal('recovery_method'),
    ref: z.strictObject({ id: uuid, versionId: uuid }),
  }),
  state: z.enum(['current', 'historical', 'unavailable']),
  reason: z.literal('owned_version_unavailable').nullable(),
  content: z.strictObject({ digest: hash }).nullable(),
  currentHead: head.nullable(),
  provenance: z
    .strictObject({
      source: z.literal('user_recorded'),
      reviewState: z.literal('unreviewed'),
      reviewedAt: z.null(),
    })
    .nullable(),
});
/** Explicit projection of already captured owned rows. Optional supplemental
 * ports are not currently supplied by captureRacePlanImpactContext: their
 * absence blocks only a recovery record that actually consumes them.
 * Calling this pure codec cannot establish tenant ownership or permission. */
export const recoveryReadSourcesProjectionSchema = z.strictObject({
  roster: z.array(tuple).max(1000),
  recovery: z.array(tuple.extend({ record: strategyBody })).max(1000),
  plans: z.array(planSnapshotSchema).max(5000),
  nutrition: z.array(tuple.extend({ record: nutritionPlanVersionCompatibleV4Schema })).max(1000),
  methodCatalog: z.array(methodCatalog).max(5000),
  methodSources: z.array(methodBody).max(5000).optional(),
  trainingAssociations: z.array(tuple).max(5000).optional(),
});
export type RecoveryReadSourcesProjection = z.infer<typeof recoveryReadSourcesProjectionSchema>;
export type RecoveryReadSourceBlocker = {
  strategyVersionId: string | null;
  sourceVersionId: string | null;
  reason:
    | 'invalid_projection'
    | 'inventory_mismatch'
    | 'method_source_missing'
    | 'method_permission_missing'
    | 'method_unavailable'
    | 'method_source_mismatch'
    | 'training_source_missing'
    | 'training_association_missing'
    | 'plan_tuple_mismatch'
    | 'nutrition_source_missing'
    | 'observation_source_port_missing';
};
export type RecoveryReadSourcesResult = {
  status: 'validated_read_sources' | 'blocked';
  authority: 'none';
  freshness: 'not_checked';
  blockers: RecoveryReadSourceBlocker[];
  facts: { strategies: number; methods: number; planRefs: number };
  digest: string | null;
};
const key = (row: z.infer<typeof tuple>) => JSON.stringify([row.aggregateId, row.versionId]);
function unique<T>(rows: readonly T[], identity: (row: T) => string) {
  return new Set(rows.map(identity)).size === rows.length;
}
/** Validates frozen source correspondence, never approval, current freshness,
 * processing authorization, observed recovery or physiological effectiveness. */
export function validateRecoveryReadSources(input: unknown): RecoveryReadSourcesResult {
  const blockers: RecoveryReadSourceBlocker[] = [];
  const fail = (
    reason: RecoveryReadSourceBlocker['reason'],
    strategyVersionId: string | null = null,
    sourceVersionId: string | null = null,
  ) => blockers.push({ reason, strategyVersionId, sourceVersionId });
  const invalid = (): RecoveryReadSourcesResult => ({
    status: 'blocked',
    authority: 'none',
    freshness: 'not_checked',
    blockers: [{ reason: 'invalid_projection', strategyVersionId: null, sourceVersionId: null }],
    facts: { strategies: 0, methods: 0, planRefs: 0 },
    digest: null,
  });
  // Account bytes before traversing domain schemas; no unbounded JSON body decoding.
  try {
    const json = JSON.stringify(input);
    if (!json || Buffer.byteLength(json) > 4194304) return invalid();
  } catch {
    return invalid();
  }
  const parsed = recoveryReadSourcesProjectionSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const c = parsed.data;
  const visits = c.recovery.reduce(
    (sum, row) =>
      sum +
      row.record.draft.options.length +
      row.record.draft.planRefs.length +
      row.record.draft.observations.length,
    0,
  );
  if (
    visits +
      c.roster.length +
      c.plans.length +
      c.nutrition.length +
      c.methodCatalog.length +
      (c.methodSources?.length ?? 0) +
      (c.trainingAssociations?.length ?? 0) >
    5000
  )
    return invalid();
  for (const entry of c.methodCatalog) {
    const unavailable = entry.state === 'unavailable';
    if (
      unavailable !== (entry.reason !== null) ||
      unavailable !== (entry.content === null) ||
      unavailable !== (entry.provenance === null) ||
      (unavailable && entry.currentHead !== null)
    )
      return invalid();
  }
  const methods = c.methodSources ?? [];
  const associations = c.trainingAssociations ?? [];
  if (
    !unique(c.roster, (row) => row.aggregateId) ||
    !unique(c.recovery, (row) => row.aggregateId) ||
    !unique(c.recovery, (row) => row.versionId) ||
    !unique(c.plans, (row) => row.id.toLowerCase()) ||
    !unique(c.nutrition, (row) => row.versionId) ||
    !unique(methods, (row) => row.versionId) ||
    !unique(methods, (row) => JSON.stringify([row.methodId, row.version])) ||
    !unique(associations, (row) => row.versionId) ||
    !unique(c.methodCatalog, (row) => row.requested.ref.versionId) ||
    c.roster.length !== c.recovery.length ||
    c.roster.some((row) => !c.recovery.some((body) => key(row) === key(body)))
  )
    fail('inventory_mismatch');
  const records = [
    ...c.recovery.map((row) => row.record),
    ...methods,
    ...c.plans.map((row) => row.draft),
    ...c.nutrition.map((row) => row.record),
  ];
  if (records.some((record) => Buffer.byteLength(JSON.stringify(record)) > 524288))
    return invalid();
  for (const row of c.nutrition)
    if (row.record.planId !== row.aggregateId || row.record.versionId !== row.versionId)
      fail('plan_tuple_mismatch', null, row.versionId);
  const methodMap = new Map(methods.map((row) => [row.versionId, row]));
  const catalogMap = new Map(c.methodCatalog.map((row) => [row.requested.ref.versionId, row]));
  const planMap = new Map(c.plans.map((row) => [row.id.toLowerCase(), row]));
  const associationMap = new Map(associations.map((row) => [row.versionId, row]));
  const nutritionMap = new Map(c.nutrition.map((row) => [row.versionId, row]));
  const consumedMethods = new Set<string>();
  let planRefs = 0;
  for (const row of c.recovery) {
    const { record } = row;
    if (record.strategyId !== row.aggregateId || record.versionId !== row.versionId)
      fail('inventory_mismatch', row.versionId);
    // The public draft writer reads all offered methods, not just a selected
    // option. Their frozen content remains in the strategy's dependency scope.
    for (const option of record.draft.options) {
      if (option.methodVersionId === null) continue;
      const versionId = option.methodVersionId;
      consumedMethods.add(versionId);
      const source = methodMap.get(versionId);
      const permission = catalogMap.get(versionId);
      if (!source) fail('method_source_missing', row.versionId, versionId);
      if (!permission) {
        fail('method_permission_missing', row.versionId, versionId);
        continue;
      }
      if (permission.state === 'unavailable') {
        fail('method_unavailable', row.versionId, versionId);
        continue;
      }
      if (!source) continue;
      const current = permission.currentHead?.version_id === source.versionId;
      if (
        permission.requested.ref.id !== source.methodId ||
        permission.reason !== null ||
        permission.content?.digest !== impactDependencyDigest(source) ||
        permission.provenance?.source !== source.source ||
        permission.provenance.reviewState !== source.reviewState ||
        permission.provenance.reviewedAt !== source.reviewedAt ||
        (permission.currentHead !== null &&
          permission.currentHead.aggregate_id !== source.methodId) ||
        (permission.state === 'current') !== current
      )
        fail('method_source_mismatch', row.versionId, versionId);
    }
    for (const ref of record.draft.planRefs) {
      planRefs++;
      if (ref.kind === 'training') {
        if (!planMap.has(ref.headVersionId))
          fail('training_source_missing', row.versionId, ref.headVersionId);
        const association = associationMap.get(ref.headVersionId);
        if (!association) fail('training_association_missing', row.versionId, ref.headVersionId);
        else if (association.aggregateId !== ref.aggregateId)
          fail('plan_tuple_mismatch', row.versionId, ref.headVersionId);
      } else {
        const source = nutritionMap.get(ref.headVersionId);
        if (!source) fail('nutrition_source_missing', row.versionId, ref.headVersionId);
        else if (source.aggregateId !== ref.aggregateId)
          fail('plan_tuple_mismatch', row.versionId, ref.headVersionId);
      }
    }
    if (record.draft.observations.length) fail('observation_source_port_missing', row.versionId);
  }
  return {
    status: blockers.length ? 'blocked' : 'validated_read_sources',
    authority: 'none',
    freshness: 'not_checked',
    blockers,
    facts: { strategies: c.recovery.length, methods: consumedMethods.size, planRefs },
    digest: impactDependencyDigest(c),
  };
}
