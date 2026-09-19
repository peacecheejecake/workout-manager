import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';

export type ResourceObjectCleanupLease = {
  id: string;
  storageRef: string;
  attempts: number;
};

export interface ResourceObjectCleanupRepository {
  reapExpired(now: Date, limit?: number): Promise<number>;
  pruneUploadHistory(limit?: number): Promise<number>;
  pruneCleanupHistory(limit?: number): Promise<number>;
  lease(now: Date, leaseUntil: Date): Promise<ResourceObjectCleanupLease | null>;
  authorize(
    lease: ResourceObjectCleanupLease,
    now: Date,
  ): Promise<ResourceObjectCleanupLease | null>;
  finish(
    lease: ResourceObjectCleanupLease,
    outcome: { ok: true } | { ok: false; errorCode: string },
    now: Date,
  ): Promise<boolean>;
  close(): Promise<void>;
}

const leaseRow = z.object({
  id: z.uuid(),
  storage_ref: z.string().min(1).max(512),
  attempts: z.number().int().positive(),
});

/** Worker credentials receive only bounded lifecycle functions and no table access. */
export function createResourceObjectCleanupRepository(options: {
  connectionString: string;
  workerId?: string;
  max?: number;
}): ResourceObjectCleanupRepository {
  const workerId = z.uuid().parse(options.workerId ?? randomUUID());
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  return {
    async reapExpired(now, limit = 100) {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      const result = await pool.query(
        'SELECT public.reap_expired_resource_uploads($1,$2) AS affected',
        [now.toISOString(), boundedLimit],
      );
      return z.number().int().nonnegative().parse(result.rows[0]?.['affected']);
    },
    async pruneUploadHistory(limit = 100) {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      const result = await pool.query(
        'SELECT public.prune_resource_upload_history($1) AS affected',
        [boundedLimit],
      );
      return z.number().int().nonnegative().parse(result.rows[0]?.['affected']);
    },
    async pruneCleanupHistory(limit = 100) {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      const result = await pool.query(
        'SELECT public.prune_resource_cleanup_history($1) AS affected',
        [boundedLimit],
      );
      return z.number().int().nonnegative().parse(result.rows[0]?.['affected']);
    },
    async lease(now, leaseUntil) {
      const result = await pool.query(
        'SELECT * FROM public.lease_resource_object_cleanup($1,$2,$3)',
        [workerId, now.toISOString(), leaseUntil.toISOString()],
      );
      if (!result.rows[0]) return null;
      const row = leaseRow.parse(result.rows[0]);
      return { id: row.id, storageRef: row.storage_ref, attempts: row.attempts };
    },
    async authorize(lease, now) {
      const result = await pool.query(
        'SELECT * FROM public.authorize_resource_object_cleanup($1,$2,$3)',
        [z.uuid().parse(lease.id), workerId, now.toISOString()],
      );
      if (!result.rows[0]) return null;
      const row = leaseRow.parse(result.rows[0]);
      return { id: row.id, storageRef: row.storage_ref, attempts: row.attempts };
    },
    async finish(lease, outcome, now) {
      const id = z.uuid().parse(lease.id);
      const errorCode = outcome.ok
        ? null
        : z
            .string()
            .min(1)
            .max(100)
            .regex(/^[A-Z0-9_:-]+$/)
            .parse(outcome.errorCode);
      const result = await pool.query(
        'SELECT public.finish_resource_object_cleanup($1,$2,$3,$4,$5) AS finished',
        [id, workerId, outcome.ok, errorCode, now.toISOString()],
      );
      return result.rows[0]?.['finished'] === true;
    },
    close: () => pool.end(),
  };
}

/** Object deletion runs between the lease and finish transactions. */
export async function processOneResourceObjectCleanup(
  repository: ResourceObjectCleanupRepository,
  deleteObject: (storageRef: string) => Promise<void>,
  now: () => Date = () => new Date(),
): Promise<'empty' | 'completed' | 'retry_scheduled' | 'lease_lost'> {
  const leasedAt = now();
  const lease = await repository.lease(leasedAt, new Date(leasedAt.getTime() + 60_000));
  if (!lease) return 'empty';
  const authorized = await repository.authorize(lease, now());
  if (!authorized) return 'completed';
  try {
    await deleteObject(authorized.storageRef);
    return (await repository.finish(authorized, { ok: true }, now())) ? 'completed' : 'lease_lost';
  } catch {
    return (await repository.finish(
      authorized,
      { ok: false, errorCode: 'OBJECT_DELETE_FAILED' },
      now(),
    ))
      ? 'retry_scheduled'
      : 'lease_lost';
  }
}
