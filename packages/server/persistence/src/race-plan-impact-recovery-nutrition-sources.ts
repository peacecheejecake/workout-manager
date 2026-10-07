import { z } from 'zod';
import {
  nutritionPlanVersionCompatibleV4Schema,
  type NutritionPlanVersionCompatibleV4,
} from '@workout/contracts/nutrition-race-plan-v4';
import type { PlanSnapshot } from '@workout/contracts/planning';
import type { RaceEvent } from '@workout/contracts/races';
import type { Transaction } from './database.js';
import {
  captureNestedNutritionSources,
  reserveSourceBudget,
  type SourceBudget,
} from './race-plan-impact-nested-sources.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const tuple = z.strictObject({ aggregateId: uuid, versionId: uuid });
const fact = z.strictObject({
  requested: tuple,
  state: z.enum(['current', 'historical', 'unavailable']),
  reason: z.literal('owned_version_unavailable').nullable(),
  content: z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
  currentHead: tuple.nullable(),
});
export type RecoveryNutritionReference = z.infer<typeof tuple>;
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (ref: RecoveryNutritionReference) => JSON.stringify([ref.aggregateId, ref.versionId]);
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
function boundedBytes(input: unknown, maximum = 4194304) {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  }
  if (encoded === undefined) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > maximum) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  return bytes;
}
/** Exact owned recovery-consumed nutrition bodies, including historical versions.
 * The caller supplies references from authenticated capture. This helper neither
 * authenticates caller intent nor establishes freshness/approval authority.
 */
export async function captureRecoveryNutritionSourceFacts(
  tx: Transaction,
  references: readonly RecoveryNutritionReference[],
  budget: SourceBudget,
  sources?: { plan(id: string): Promise<PlanSnapshot>; race(id: string): Promise<RaceEvent> },
) {
  parse(
    z.strictObject({
      bytes: z.bigint().min(0n).max(4194304n),
      sources: z.number().int().min(0).max(5000),
    }),
    budget,
  );
  boundedBytes(references);
  const refs = parse(z.array(tuple).max(5000), references);
  // Charge visits before dedup: repeated references cannot hide unbounded input.
  reserveSourceBudget(budget, BigInt(boundedBytes(refs)), refs.length);
  const unique = [...new Map(refs.map((ref) => [key(ref), ref])).values()].sort((a, b) =>
    order(key(a), key(b)),
  );
  const records: NutritionPlanVersionCompatibleV4[] = [];
  const facts: z.infer<typeof fact>[] = [];
  for (const requested of unique) {
    const bytes = parse(
      z.strictObject({ bytes: z.string().regex(/^\d+$/) }),
      (
        await tx.query(
          `SELECT (coalesce(sum(octet_length(record_json::text)),0)+2048)::text AS bytes
         FROM nutrition_plan_version WHERE athlete_id=$1 AND plan_id=$2::uuid AND version_id=$3::uuid`,
          [tx.athleteId, requested.aggregateId, requested.versionId],
        )
      ).rows[0],
    );
    reserveSourceBudget(budget, BigInt(bytes.bytes), 1);
    const rows = (
      await tx.query(
        `SELECT v.plan_id,v.version_id,v.record_json,v.linked_training_plan_version_id,
        h.plan_id AS head_plan_id,h.version_id AS head_version_id
       FROM nutrition_plan_version v LEFT JOIN nutrition_plan_head h
        ON h.athlete_id=v.athlete_id AND h.plan_id=v.plan_id
       WHERE v.athlete_id=$1 AND v.plan_id=$2::uuid AND v.version_id=$3::uuid LIMIT 2`,
        [tx.athleteId, requested.aggregateId, requested.versionId],
      )
    ).rows;
    if (rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
    if (!rows[0]) {
      facts.push({
        requested,
        state: 'unavailable',
        reason: 'owned_version_unavailable',
        content: null,
        currentHead: null,
      });
      continue;
    }
    const row = parse(
      z.strictObject({
        plan_id: uuid,
        version_id: uuid,
        record_json: z.unknown(),
        linked_training_plan_version_id: uuid.nullable(),
        head_plan_id: uuid.nullable(),
        head_version_id: uuid.nullable(),
      }),
      rows[0],
    );
    boundedBytes(row.record_json, 524288);
    const record = parse(nutritionPlanVersionCompatibleV4Schema, row.record_json);
    if (
      row.plan_id !== requested.aggregateId ||
      row.version_id !== requested.versionId ||
      record.planId.toLowerCase() !== requested.aggregateId ||
      record.versionId.toLowerCase() !== requested.versionId ||
      (record.linkedTrainingPlanVersionId?.toLowerCase() ?? null) !==
        row.linked_training_plan_version_id ||
      (row.head_plan_id === null) !== (row.head_version_id === null) ||
      (row.head_plan_id !== null && row.head_plan_id !== requested.aggregateId)
    )
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    records.push(record);
    facts.push({
      requested,
      state: row.head_version_id === requested.versionId ? 'current' : 'historical',
      reason: null,
      content: { digest: impactDependencyDigest(record) },
      currentHead:
        row.head_plan_id !== null && row.head_version_id !== null
          ? { aggregateId: row.head_plan_id, versionId: row.head_version_id }
          : null,
    });
  }
  // One batch gives the existing nested reader's food/plan/race caches the entire
  // consumed historical roster, preserving the parent's shared owned source cache.
  const nestedSources = await captureNestedNutritionSources(tx, records, budget, sources);
  const result = {
    records,
    facts: parse(z.array(fact).max(5000), facts),
    nestedSources,
    authority: 'none' as const,
    freshness: 'not_checked' as const,
  };
  boundedBytes(result);
  return result;
}
export type RecoveryNutritionSourceFacts = Awaited<
  ReturnType<typeof captureRecoveryNutritionSourceFacts>
>;
