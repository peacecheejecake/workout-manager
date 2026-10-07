import { z } from 'zod';
import type { Transaction } from './database.js';
import { RaceImpactDependencyError } from './race-plan-impact-dependencies.js';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const mappedRow = z.strictObject({ version_id: uuid, aggregate_id: uuid });
export type TrainingPlanAggregateSource = {
  readonly versionId: string;
  readonly aggregateId: string;
};
/** Exact owned immutable association only. Caller holds the fenced tenant Tx.
 * A missing historical capability/row is unknown, never the current head or a
 * fabricated aggregate. SQL112's narrow definer reader enforces tenant scope.
 */
export async function readTrainingPlanAggregateSource(
  tx: Transaction,
  versionId: unknown,
): Promise<TrainingPlanAggregateSource | null> {
  const parsed = uuid.safeParse(versionId);
  if (!parsed.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const capability = await tx.query(
    "SELECT to_regprocedure('public.read_training_plan_aggregate(uuid)') IS NOT NULL AS available",
  );
  const state = z.strictObject({ available: z.boolean() }).safeParse(capability.rows[0]);
  if (capability.rows.length !== 1 || !state.success)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (!state.data.available) return null;
  const result = await tx.query(
    'SELECT version_id,aggregate_id FROM public.read_training_plan_aggregate($1::uuid) LIMIT 2',
    [parsed.data],
  );
  if (result.rows.length > 1) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (result.rows.length === 0) return null;
  const row = mappedRow.safeParse(result.rows[0]);
  if (!row.success || row.data.version_id !== parsed.data)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return { versionId: row.data.version_id, aggregateId: row.data.aggregate_id };
}
