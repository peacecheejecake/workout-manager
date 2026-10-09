import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';

const leaseSchema = z.strictObject({
  athlete_id: z.string().min(1).max(200),
  operation_id: z.uuid(),
  lease_token: z.uuid(),
});
const outcomeSchema = z.enum(['released', 'pending_cleanup', 'retry_scheduled', 'lease_lost']);
export type HealthKitDeregistrationWorkerOutcome = z.infer<typeof outcomeSchema> | 'empty';
export interface HealthKitDeregistrationWorkerRepository {
  processOne(): Promise<HealthKitDeregistrationWorkerOutcome>;
  deadLetterCount(): Promise<number>;
  close(): Promise<void>;
}
/** No tenant table access: only a database-selected opaque lease and its fenced finalization. */
export function createHealthKitDeregistrationWorkerRepository(options: {
  connectionString: string;
  max: number;
}): HealthKitDeregistrationWorkerRepository {
  const pool = new Pool({
    ...options,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    lock_timeout: 3000,
  });
  const workerId = randomUUID();
  return {
    async processOne() {
      const leased = await pool.query(
        'SELECT * FROM public.lease_healthkit_deregistration($1,$2::interval)',
        [workerId, '1 minute'],
      );
      if (!leased.rows[0]) return 'empty';
      const lease = leaseSchema.parse(leased.rows[0]);
      const finished = await pool.query(
        'SELECT public.finish_healthkit_deregistration($1,$2,$3,$4) AS outcome',
        [workerId, lease.athlete_id, lease.operation_id, lease.lease_token],
      );
      return outcomeSchema.parse(finished.rows[0]?.['outcome']);
    },
    async deadLetterCount() {
      const result = await pool.query(
        'SELECT public.healthkit_deregistration_work_failures() AS count',
      );
      return z.number().int().min(0).max(1000).parse(result.rows[0]?.['count']);
    },
    close: () => pool.end(),
  };
}
export async function processHealthKitDeregistrations(
  repository: HealthKitDeregistrationWorkerRepository,
  limit = 10,
): Promise<
  Record<HealthKitDeregistrationWorkerOutcome, number> & { dead_letter_count_capped: number }
> {
  const bounded = z.number().int().min(1).max(100).parse(limit);
  const counts = { empty: 0, released: 0, pending_cleanup: 0, retry_scheduled: 0, lease_lost: 0 };
  for (let attempt = 0; attempt < bounded; attempt++) {
    const outcome = await repository.processOne();
    counts[outcome]++;
    if (outcome === 'empty' || outcome === 'retry_scheduled' || outcome === 'lease_lost') break;
  }
  return { ...counts, dead_letter_count_capped: await repository.deadLetterCount() };
}
