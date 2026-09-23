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
  /** Resumable cursor for the bounded track-object reconciliation sweep. */
  reconcileCursor(): Promise<string>;
  advanceReconcileCursor(key: string): Promise<void>;
  /** One bounded, ordered window of watched references after the cursor. */
  reconcileCandidates(cursor: string, limit: number): Promise<readonly string[]>;
  /** Stop watching a reference whose object is absent and can no longer be created. */
  settleTrackObjectRef(storageRef: string): Promise<boolean>;
  /** Queues one track object the ledger does not account for. */
  reclaimUnreferencedTrackObject(storageRef: string): Promise<boolean>;
  /**
   * Course thumbnail renders that stopped being drained (M2-01l): a lease that expired
   * mid-attempt gets another attempt, a render past its own deadline is abandoned. Both
   * queue their object references, so an interrupted render leaks nothing.
   */
  reapCourseThumbnailRenders(limit?: number): Promise<number>;
  pruneCourseThumbnailHistory(limit?: number): Promise<number>;
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
    async reconcileCursor() {
      const result = await pool.query('SELECT public.activity_track_reconcile_cursor() AS cursor');
      return z
        .string()
        .max(512)
        .parse(result.rows[0]?.['cursor'] ?? '');
    },
    async advanceReconcileCursor(key) {
      await pool.query('SELECT public.advance_activity_track_reconcile_cursor($1)', [
        z.string().max(512).parse(key),
      ]);
    },
    async reconcileCandidates(cursor, limit) {
      const result = await pool.query(
        'SELECT storage_ref FROM public.activity_track_reconcile_candidates($1,$2)',
        [z.string().max(512).parse(cursor), z.number().int().min(1).max(1000).parse(limit)],
      );
      return result.rows.map((row) => z.string().min(1).max(512).parse(row['storage_ref']));
    },
    async settleTrackObjectRef(storageRef) {
      const result = await pool.query(
        'SELECT public.settle_activity_track_object_ref($1) AS settled',
        [z.string().min(1).max(512).parse(storageRef)],
      );
      return result.rows[0]?.['settled'] === true;
    },
    async reclaimUnreferencedTrackObject(storageRef) {
      const result = await pool.query(
        'SELECT public.reclaim_unreferenced_activity_track_object($1) AS queued',
        [z.string().min(1).max(512).parse(storageRef)],
      );
      return result.rows[0]?.['queued'] === true;
    },
    async reapCourseThumbnailRenders(limit = 100) {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      const result = await pool.query(
        'SELECT public.reap_course_thumbnail_renders($1) AS affected',
        [boundedLimit],
      );
      return z.number().int().nonnegative().parse(result.rows[0]?.['affected']);
    },
    async pruneCourseThumbnailHistory(limit = 100) {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      const result = await pool.query(
        'SELECT public.prune_course_thumbnail_history($1) AS affected',
        [boundedLimit],
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

export interface TrackReconciliationOutcome {
  /** Ledger references examined in this run. */
  readonly inspected: number;
  /** References whose object was found on the store and had nothing referencing it. */
  readonly queued: number;
  /** True when the window ended the ledger scan and the cursor went back to the start. */
  readonly wrapped: boolean;
}

/**
 * Compare the ledger against the object store and queue whatever nothing accounts for.
 *
 * This is the part of the guarantee that does not depend on a receipt still being open: a
 * writer that resumes long after its upload expired, or any other path that leaves an object
 * nothing references, is caught here.
 *
 * What is bounded, exactly: one run reads at most `limit` rows from the reference index — an
 * index range scan over a keyset window, resumed from a stored cursor — and performs at most
 * one `stat` and one bounded statement per row. No directory is walked and no ledger table is
 * scanned, so empty directories, unrelated files and the size of the upload history all cost
 * nothing. Reaching the end of the index resets the cursor, so the next run starts again from
 * the beginning.
 */
export async function reconcileActivityTrackObjects(
  repository: ResourceObjectCleanupRepository,
  storage: { stat(key: never): Promise<unknown> },
  limit = 200,
): Promise<TrackReconciliationOutcome> {
  const boundedLimit = z.number().int().min(1).max(1000).parse(limit);
  const cursor = await repository.reconcileCursor();
  const candidates = await repository.reconcileCandidates(cursor, boundedLimit);
  let queued = 0;
  for (const reference of candidates) {
    // The object store is asked once per reference. A reference whose object is absent is
    // exactly the normal case and costs nothing further.
    if ((await storage.stat(reference as never)) === null) {
      // Absent, and possibly absent for good: the database decides whether anything could
      // still create it and stops watching only then.
      await repository.settleTrackObjectRef(reference);
      continue;
    }
    if (await repository.reclaimUnreferencedTrackObject(reference)) queued += 1;
  }
  const last = candidates.at(-1);
  // A short window means the end of the ledger: start again from the beginning next time, so
  // nothing stays unvisited because it sorts before the cursor.
  const next = candidates.length === boundedLimit && last !== undefined ? last : '';
  await repository.advanceReconcileCursor(next);
  return { inspected: candidates.length, queued, wrapped: next === '' };
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
