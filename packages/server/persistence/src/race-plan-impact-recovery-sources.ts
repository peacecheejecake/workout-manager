import { z } from 'zod';
import {
  recoveryStrategyVersionSchema,
  recoveryMethodVersionSchema,
  type RecoveryStrategyVersion,
} from '@workout/contracts/recovery-core';
import type { Transaction } from './database.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { readTrainingPlanAggregateSource } from './training-plan-aggregate-source.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const tuple = z.strictObject({ aggregateId: uuid, versionId: uuid });
const head = z.strictObject({ aggregate_id: uuid, version_id: uuid });
const request = z.strictObject({
  kind: z.literal('recovery_method'),
  ref: z.strictObject({ id: uuid, versionId: uuid }),
});
const methodBody = recoveryMethodVersionSchema.safeExtend({
  version: z.number().int().min(1).max(2147483646),
});
const unavailable = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('method'),
    requestedVersionId: uuid,
    reason: z.literal('owned_method_unavailable'),
  }),
  z.strictObject({
    kind: z.literal('training'),
    requested: tuple,
    reason: z.enum(['aggregate_identity_unavailable', 'aggregate_mismatch']),
  }),
]);
export const recoverySourceFactsSchema = z.strictObject({
  methodCatalogRequests: z.array(request).max(5000),
  methods: z.array(methodBody).max(5000),
  methodFacts: z
    .array(
      z.strictObject({
        requested: request,
        state: z.enum(['current', 'historical']),
        reason: z.null(),
        content: z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) }),
        currentHead: head.nullable(),
        provenance: z.strictObject({
          source: z.literal('user_recorded'),
          reviewState: z.literal('unreviewed'),
          reviewedAt: z.null(),
        }),
      }),
    )
    .max(5000),
  trainingAssociations: z.array(tuple).max(5000),
  nutritionReferences: z.array(tuple).max(5000),
  unavailable: z.array(unavailable).max(5000),
  authority: z.literal('none'),
  freshness: z.literal('not_checked'),
});
export type RecoverySourceFacts = z.infer<typeof recoverySourceFactsSchema>;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (v: z.infer<typeof tuple>) => JSON.stringify([v.aggregateId, v.versionId]);
/** Actual exact owned method reads + immutable training tuple facts. Caller
 * supplies strategies from its fenced owned capture, not client approval data.
 * No claim authenticates these strategy arguments or current nutrition bodies.
 * nutritionReferences require the parent's exact captured nutrition consumer;
 * historical nutrition not in that roster remains an unresolved source port.
 */
export async function captureRecoverySourceFacts(
  tx: Transaction,
  strategies: readonly RecoveryStrategyVersion[],
  budget: SourceBudget,
): Promise<RecoverySourceFacts> {
  parse(
    z.strictObject({
      bytes: z.bigint().min(0n).max(4194304n),
      sources: z.number().int().min(0).max(5000),
    }),
    budget,
  );
  let encoded: string;
  try {
    encoded = JSON.stringify(strategies);
  } catch {
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  if (!Array.isArray(strategies) || strategies.length > 1000)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
  let visits = strategies.length;
  for (const value of strategies) {
    const raw = z
      .strictObject({
        draft: z
          .object({ options: z.array(z.unknown()).max(20), planRefs: z.array(z.unknown()).max(20) })
          .passthrough(),
      })
      .passthrough()
      .safeParse(value);
    if (!raw.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    visits += raw.data.draft.options.length + raw.data.draft.planRefs.length;
  }
  reserveSourceBudget(budget, BigInt(visits * 256), visits);
  const records = parse(z.array(recoveryStrategyVersionSchema).max(1000), strategies);
  const uniqueStrategies = new Map<string, string>();
  for (const record of records) {
    const digest = impactDependencyDigest(record),
      previous = uniqueStrategies.get(record.versionId);
    if (previous !== undefined && previous !== digest)
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    uniqueStrategies.set(record.versionId, digest);
  }
  const methodIds = [
    ...new Set(
      records.flatMap((record) =>
        record.draft.options.flatMap((option) =>
          option.methodVersionId === null ? [] : [option.methodVersionId],
        ),
      ),
    ),
  ].sort(order);
  const training = [
    ...new Map(
      records.flatMap((record) =>
        record.draft.planRefs
          .filter((ref) => ref.kind === 'training')
          .map((ref) => {
            const v = { aggregateId: ref.aggregateId, versionId: ref.headVersionId };
            return [key(v), v] as const;
          }),
      ),
    ).values(),
  ].sort((a, b) => order(key(a), key(b)));
  const nutritionReferences = [
    ...new Map(
      records.flatMap((record) =>
        record.draft.planRefs
          .filter((ref) => ref.kind === 'nutrition')
          .map((ref) => {
            const v = { aggregateId: ref.aggregateId, versionId: ref.headVersionId };
            return [key(v), v] as const;
          }),
      ),
    ).values(),
  ].sort((a, b) => order(key(a), key(b)));
  const result: RecoverySourceFacts = {
    methodCatalogRequests: [],
    methods: [],
    methodFacts: [],
    trainingAssociations: [],
    nutritionReferences,
    unavailable: [],
    authority: 'none',
    freshness: 'not_checked',
  };
  for (const versionId of methodIds) {
    const scalar = await tx.query(
      'SELECT (coalesce(sum(octet_length(record_json::text)),0)+2048)::text AS bytes FROM recovery_method_version WHERE athlete_id=$1 AND version_id=$2::uuid',
      [tx.athleteId, versionId],
    );
    if (scalar.rows.length !== 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    reserveSourceBudget(
      budget,
      BigInt(parse(z.strictObject({ bytes: z.string().regex(/^\d+$/) }), scalar.rows[0]).bytes),
      1,
    );
    const rows = (
      await tx.query(
        `SELECT v.method_id,v.version_id,v.version,v.record_json,h.method_id AS head_method_id,h.version_id AS head_version_id FROM recovery_method_version v LEFT JOIN recovery_method_head h ON h.athlete_id=v.athlete_id AND h.method_id=v.method_id WHERE v.athlete_id=$1 AND v.version_id=$2::uuid LIMIT 2`,
        [tx.athleteId, versionId],
      )
    ).rows;
    if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!rows[0]) {
      result.unavailable.push({
        kind: 'method',
        requestedVersionId: versionId,
        reason: 'owned_method_unavailable',
      });
      continue;
    }
    const row = parse(
      z.strictObject({
        method_id: uuid,
        version_id: uuid,
        version: z.number().int().min(1).max(2147483646),
        record_json: methodBody,
        head_method_id: uuid.nullable(),
        head_version_id: uuid.nullable(),
      }),
      rows[0],
    );
    if (
      row.version_id !== versionId ||
      row.record_json.methodId !== row.method_id ||
      row.record_json.versionId !== row.version_id ||
      row.record_json.version !== row.version ||
      (row.head_method_id === null) !== (row.head_version_id === null) ||
      (row.head_method_id !== null && row.head_method_id !== row.method_id)
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    const requested = parse(request, {
      kind: 'recovery_method',
      ref: { id: row.method_id, versionId },
    });
    result.methodCatalogRequests.push(requested);
    result.methods.push(row.record_json);
    result.methodFacts.push({
      requested,
      state: row.head_version_id === versionId ? 'current' : 'historical',
      reason: null,
      content: { digest: impactDependencyDigest(row.record_json) },
      currentHead:
        row.head_method_id !== null && row.head_version_id !== null
          ? { aggregate_id: row.head_method_id, version_id: row.head_version_id }
          : null,
      provenance: {
        source: row.record_json.source,
        reviewState: row.record_json.reviewState,
        reviewedAt: row.record_json.reviewedAt,
      },
    });
  }
  const cache = new Map<string, Awaited<ReturnType<typeof readTrainingPlanAggregateSource>>>();
  for (const requested of training) {
    reserveSourceBudget(budget, 1024n, 1);
    let found = cache.get(requested.versionId);
    if (!cache.has(requested.versionId)) {
      found = await readTrainingPlanAggregateSource(tx, requested.versionId);
      cache.set(requested.versionId, found);
    }
    if (!found || found.aggregateId !== requested.aggregateId) {
      result.unavailable.push({
        kind: 'training',
        requested,
        reason: found ? 'aggregate_mismatch' : 'aggregate_identity_unavailable',
      });
      continue;
    }
    result.trainingAssociations.push(requested);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return recoverySourceFactsSchema.parse(result);
}
