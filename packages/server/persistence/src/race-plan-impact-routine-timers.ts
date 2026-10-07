import { z } from 'zod';
import { routineRunSchema, type RoutineRun } from '@workout/contracts/routines';
import { routineRunReadSchema, routineTimerSchema } from '@workout/contracts/routine-commands';
import type { Transaction } from './database.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { RaceImpactDependencyError } from './race-plan-impact-dependencies.js';

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return result.data;
}
const decimal = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(30);
const instant = z
  .union([z.date(), z.iso.datetime()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value));
const timerRow = z.strictObject({
  run_id: z.uuid(),
  step_id: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  state: z.enum(['running', 'paused', 'cleared']),
  duration_seconds: z.number().int().positive().max(86400),
  started_at: instant,
  paused_at: instant.nullable(),
  paused_milliseconds: decimal,
});

/** Reads timers for runs already captured and authenticated by the owning
 * collector. An empty timer list is an actual bounded inventory, not evidence
 * of performance, timer completion, or approval freshness. */
export async function captureRoutineTimerReads(
  tx: Transaction,
  capturedRuns: readonly RoutineRun[],
  budget: SourceBudget,
) {
  const encoded = JSON.stringify(capturedRuns);
  if (Buffer.byteLength(encoded) > 4194304)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  const runs = parse(z.array(routineRunSchema).max(1000), capturedRuns);
  const ids = runs.map((run) => run.id.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (ids.length === 0) return [];
  const scalar = parse(
    z.strictObject({ count: decimal, bytes: decimal }),
    (
      await tx.query(
        `SELECT count(*)::text AS count,
         coalesce(sum(octet_length(to_jsonb(t)::text)+512),0)::text AS bytes
         FROM routine_step_timer t WHERE athlete_id=$1 AND run_id=ANY($2::uuid[])`,
        [tx.athleteId, ids],
      )
    ).rows[0],
  );
  if (BigInt(scalar.count) > 5000n)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'unique_sources');
  reserveSourceBudget(
    budget,
    BigInt(scalar.bytes) + BigInt(Buffer.byteLength(encoded)) + BigInt(ids.length * 512),
    Number(scalar.count) + ids.length,
  );
  const rows = parse(
    z.array(timerRow).max(5000),
    (
      await tx.query(
        `SELECT run_id,step_id,revision,state,duration_seconds,started_at,paused_at,
         paused_milliseconds::text AS paused_milliseconds
         FROM routine_step_timer WHERE athlete_id=$1 AND run_id=ANY($2::uuid[])
         ORDER BY run_id,step_id LIMIT 5001`,
        [tx.athleteId, ids],
      )
    ).rows,
  );
  if (BigInt(rows.length) !== BigInt(scalar.count))
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const keys = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([row.run_id.toLowerCase(), row.step_id]);
    if (!ids.includes(row.run_id.toLowerCase()) || keys.has(key))
      throw new RaceImpactDependencyError('INVALID_CONTEXT');
    keys.add(key);
  }
  return runs
    .map((run) =>
      parse(routineRunReadSchema, {
        run,
        timers: rows
          .filter((row) => row.run_id.toLowerCase() === run.id.toLowerCase())
          .map((row) =>
            parse(routineTimerSchema, {
              runId: row.run_id,
              stepId: row.step_id,
              revision: row.revision,
              state: row.state,
              durationSeconds: row.duration_seconds,
              startedAt: row.started_at,
              pausedAt: row.paused_at,
              pausedMilliseconds: Number(row.paused_milliseconds),
            }),
          ),
      }),
    )
    .sort((a, b) => (a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0));
}
