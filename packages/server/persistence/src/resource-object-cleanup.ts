import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';

export type ResourceObjectCleanupLease = {
  id: string;
  storageRef: string;
  attempts: number;
};

/** One erased tenant whose object-storage prefix a worker holds the lease to purge (M2-01x). */
export type TenantObjectPurgeLease = {
  tenantId: string;
  attempts: number;
};

/** What one leased purge run did, as recorded against the purge row. */
export type TenantObjectPurgeRunOutcome =
  | {
      ok: true;
      /** Objects deleted (or found already gone) in this run. */
      purged: number;
      /** Entries under the prefix that are no object key of this tenant, left alone. */
      unrecognized: number;
      /** The run stopped at its budget with keys still listed: due again at once. */
      more: boolean;
    }
  | { ok: false; errorCode: string; purged: number };

/**
 * One activity or one course whose own object-storage directory a worker holds the lease to
 * purge (M2-01y). The same shape as the store's `ObjectScope`, spelled out here so this module
 * keeps no runtime dependency on the store.
 */
export type ObjectScopePurgeScope =
  | { readonly kind: 'activity'; readonly tenantId: string; readonly activityId: string }
  | { readonly kind: 'course'; readonly tenantId: string; readonly courseId: string };

export type ObjectScopePurgeLease = {
  scope: ObjectScopePurgeScope;
  attempts: number;
};

/** One watched reference in a reconciliation window, with its recorded sweep fault (M2-01n). */
export type ReconcileCandidate = {
  storageRef: string;
  /** Consecutive `stat` failures on record for this reference; 0 when it has none. */
  sweepAttempts: number;
  /** True while a recorded fault's backoff has not run out, on the database clock. */
  deferred: boolean;
};

export interface ResourceObjectCleanupRepository {
  reapExpired(now: Date, limit?: number): Promise<number>;
  /** Resumable cursor for the bounded track-object reconciliation sweep. */
  reconcileCursor(): Promise<string>;
  advanceReconcileCursor(key: string): Promise<void>;
  /** One bounded, ordered window of watched references after the cursor. */
  reconcileWindow(cursor: string, limit: number): Promise<readonly ReconcileCandidate[]>;
  /** Stop watching a reference whose object is absent and can no longer be created. */
  settleTrackObjectRef(storageRef: string): Promise<boolean>;
  /** Queues one track object the ledger does not account for. */
  reclaimUnreferencedTrackObject(storageRef: string): Promise<boolean>;
  /**
   * Records that one reference's `stat` raised (M2-01n). Answers the attempt count on record,
   * or null when there is no watched row to record against.
   */
  recordTrackSweepFault(storageRef: string, errorCode: string): Promise<number | null>;
  clearTrackSweepFault(storageRef: string): Promise<boolean>;
  /** The same surface, for the course-thumbnail namespace (M2-01m). Its own cursor. */
  thumbnailReconcileCursor(): Promise<string>;
  advanceThumbnailReconcileCursor(key: string): Promise<void>;
  thumbnailReconcileWindow(cursor: string, limit: number): Promise<readonly ReconcileCandidate[]>;
  settleThumbnailObjectRef(storageRef: string): Promise<boolean>;
  reclaimUnreferencedThumbnailObject(storageRef: string): Promise<boolean>;
  recordThumbnailSweepFault(storageRef: string, errorCode: string): Promise<number | null>;
  clearThumbnailSweepFault(storageRef: string): Promise<boolean>;
  /**
   * Course thumbnail renders that stopped being drained (M2-01l): a lease that expired
   * mid-attempt gets another attempt, a render past its own deadline is abandoned. Both
   * queue their object references, so an interrupted render leaks nothing.
   */
  reapCourseThumbnailRenders(limit?: number): Promise<number>;
  pruneCourseThumbnailHistory(limit?: number): Promise<number>;
  pruneUploadHistory(limit?: number): Promise<number>;
  pruneCleanupHistory(limit?: number): Promise<number>;
  /**
   * One due tenant purge (M2-01x). Only a tenant in the erasure ledger with no identity
   * account left is ever returned; the database decides that, not the worker. A refused row
   * is labelled `INCONSISTENT_LEDGER:…` and a last attempt whose lease ran out
   * `DEAD_LETTER:LEASE_EXPIRED` by the same call (M2-01z, migration 045).
   */
  leaseTenantObjectPurge(now: Date, leaseUntil: Date): Promise<TenantObjectPurgeLease | null>;
  finishTenantObjectPurge(
    lease: TenantObjectPurgeLease,
    outcome: TenantObjectPurgeRunOutcome,
  ): Promise<boolean>;
  /**
   * One due activity or course purge (M2-01y). A row whose activity is present and not
   * deleted, or whose course is present and available, is never returned; the database
   * decides that, not the worker.
   */
  leaseObjectScopePurge(now: Date, leaseUntil: Date): Promise<ObjectScopePurgeLease | null>;
  finishObjectScopePurge(
    lease: ObjectScopePurgeLease,
    outcome: TenantObjectPurgeRunOutcome,
  ): Promise<boolean>;
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

const windowRow = z.object({
  storage_ref: z.string().min(1).max(512),
  sweep_attempts: z.number().int().nonnegative(),
  deferred: z.boolean(),
});

function windowRows(rows: readonly unknown[]): ReconcileCandidate[] {
  return rows.map((row) => {
    const parsed = windowRow.parse(row);
    return {
      storageRef: parsed.storage_ref,
      sweepAttempts: parsed.sweep_attempts,
      deferred: parsed.deferred,
    };
  });
}

const sweepFaultCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

function recordedAttempts(value: unknown): number | null {
  return value === null || value === undefined ? null : z.number().int().positive().parse(value);
}

const purgeLeaseRow = z.object({
  athlete_id: z.uuid(),
  attempts: z.number().int().positive(),
});

const scopePurgeLeaseRow = z.object({
  athlete_id: z.uuid(),
  scope_kind: z.enum(['activity', 'course']),
  scope_id: z.uuid(),
  attempts: z.number().int().positive(),
});

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
    async reconcileWindow(cursor, limit) {
      const result = await pool.query(
        `SELECT storage_ref,sweep_attempts,deferred
         FROM public.activity_track_reconcile_window($1,$2)`,
        [z.string().max(512).parse(cursor), z.number().int().min(1).max(1000).parse(limit)],
      );
      return windowRows(result.rows);
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
    async recordTrackSweepFault(storageRef, errorCode) {
      const result = await pool.query(
        'SELECT public.record_activity_track_sweep_fault($1,$2) AS attempts',
        [z.string().min(1).max(512).parse(storageRef), sweepFaultCode.parse(errorCode)],
      );
      return recordedAttempts(result.rows[0]?.['attempts']);
    },
    async clearTrackSweepFault(storageRef) {
      const result = await pool.query(
        'SELECT public.clear_activity_track_sweep_fault($1) AS cleared',
        [z.string().min(1).max(512).parse(storageRef)],
      );
      return result.rows[0]?.['cleared'] === true;
    },
    async thumbnailReconcileCursor() {
      const result = await pool.query(
        'SELECT public.course_thumbnail_reconcile_cursor() AS cursor',
      );
      return z
        .string()
        .max(512)
        .parse(result.rows[0]?.['cursor'] ?? '');
    },
    async advanceThumbnailReconcileCursor(key) {
      await pool.query('SELECT public.advance_course_thumbnail_reconcile_cursor($1)', [
        z.string().max(512).parse(key),
      ]);
    },
    async thumbnailReconcileWindow(cursor, limit) {
      const result = await pool.query(
        `SELECT storage_ref,sweep_attempts,deferred
         FROM public.course_thumbnail_reconcile_window($1,$2)`,
        [z.string().max(512).parse(cursor), z.number().int().min(1).max(1000).parse(limit)],
      );
      return windowRows(result.rows);
    },
    async settleThumbnailObjectRef(storageRef) {
      const result = await pool.query(
        'SELECT public.settle_course_thumbnail_object_ref($1) AS settled',
        [z.string().min(1).max(512).parse(storageRef)],
      );
      return result.rows[0]?.['settled'] === true;
    },
    async reclaimUnreferencedThumbnailObject(storageRef) {
      const result = await pool.query(
        'SELECT public.reclaim_unreferenced_course_thumbnail_object($1) AS queued',
        [z.string().min(1).max(512).parse(storageRef)],
      );
      return result.rows[0]?.['queued'] === true;
    },
    async recordThumbnailSweepFault(storageRef, errorCode) {
      const result = await pool.query(
        'SELECT public.record_course_thumbnail_sweep_fault($1,$2) AS attempts',
        [z.string().min(1).max(512).parse(storageRef), sweepFaultCode.parse(errorCode)],
      );
      return recordedAttempts(result.rows[0]?.['attempts']);
    },
    async clearThumbnailSweepFault(storageRef) {
      const result = await pool.query(
        'SELECT public.clear_course_thumbnail_sweep_fault($1) AS cleared',
        [z.string().min(1).max(512).parse(storageRef)],
      );
      return result.rows[0]?.['cleared'] === true;
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
    async leaseTenantObjectPurge(now, leaseUntil) {
      const result = await pool.query('SELECT * FROM public.lease_tenant_object_purge($1,$2,$3)', [
        workerId,
        now.toISOString(),
        leaseUntil.toISOString(),
      ]);
      if (!result.rows[0]) return null;
      const row = purgeLeaseRow.parse(result.rows[0]);
      return { tenantId: row.athlete_id, attempts: row.attempts };
    },
    async finishTenantObjectPurge(lease, outcome) {
      const count = z.number().int().min(0).max(1_000_000);
      const result = await pool.query(
        'SELECT public.finish_tenant_object_purge($1,$2,$3,$4,$5,$6,$7) AS finished',
        [
          z.uuid().parse(lease.tenantId),
          workerId,
          outcome.ok,
          outcome.ok ? null : sweepFaultCode.parse(outcome.errorCode),
          count.parse(outcome.purged),
          outcome.ok ? count.parse(outcome.unrecognized) : 0,
          outcome.ok ? outcome.more : false,
        ],
      );
      return result.rows[0]?.['finished'] === true;
    },
    async leaseObjectScopePurge(now, leaseUntil) {
      const result = await pool.query('SELECT * FROM public.lease_object_scope_purge($1,$2,$3)', [
        workerId,
        now.toISOString(),
        leaseUntil.toISOString(),
      ]);
      if (!result.rows[0]) return null;
      const row = scopePurgeLeaseRow.parse(result.rows[0]);
      const scope: ObjectScopePurgeScope =
        row.scope_kind === 'activity'
          ? { kind: 'activity', tenantId: row.athlete_id, activityId: row.scope_id }
          : { kind: 'course', tenantId: row.athlete_id, courseId: row.scope_id };
      return { scope, attempts: row.attempts };
    },
    async finishObjectScopePurge(lease, outcome) {
      const count = z.number().int().min(0).max(1_000_000);
      const result = await pool.query(
        'SELECT public.finish_object_scope_purge($1,$2,$3,$4,$5,$6,$7,$8,$9) AS finished',
        [
          z.uuid().parse(lease.scope.tenantId),
          lease.scope.kind,
          z.uuid().parse(scopeOwnerId(lease.scope)),
          workerId,
          outcome.ok,
          outcome.ok ? null : sweepFaultCode.parse(outcome.errorCode),
          count.parse(outcome.purged),
          outcome.ok ? count.parse(outcome.unrecognized) : 0,
          outcome.ok ? outcome.more : false,
        ],
      );
      return result.rows[0]?.['finished'] === true;
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
  /**
   * References whose `stat` raised in this run, each recorded against that reference with its
   * error code, attempt count and next attempt time (M2-01n). Never settled, never queued.
   */
  readonly faulted: number;
  /** References skipped without a `stat` because a recorded fault's backoff has not run out. */
  readonly deferred: number;
  /** True when the window ended the ledger scan and the cursor went back to the start. */
  readonly wrapped: boolean;
}

/**
 * The error code a sweep fault is recorded under: the error's own code when it has one (an
 * errno such as `EACCES`, or `UNSAFE_STORAGE_PATH` from the symlink guard), a generic one
 * otherwise. Only the code is kept — never the message, which can carry a filesystem path.
 */
export function sweepFaultCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'OBJECT_STAT_FAILED';
}

/**
 * What a sweep needs from the object store: one `stat` per reference, and — once per run,
 * before any reference — whether the store can answer at all.
 */
export interface SweptStorage {
  stat(key: never): Promise<unknown>;
  assertReachable(): Promise<void>;
}

/** One namespace's half of the repository, as the shared sweep below uses it. */
interface SweepNamespace {
  cursor(): Promise<string>;
  window(cursor: string, limit: number): Promise<readonly ReconcileCandidate[]>;
  advance(key: string): Promise<void>;
  settle(storageRef: string): Promise<boolean>;
  reclaim(storageRef: string): Promise<boolean>;
  recordFault(storageRef: string, errorCode: string): Promise<number | null>;
  clearFault(storageRef: string): Promise<boolean>;
}

/**
 * One bounded window of one namespace's sweep.
 *
 * Errors are isolated to the reference that raised them, and only there (M2-01n). Before
 * this, a reference whose `stat` always raised — an unreadable directory, a planted symbolic
 * link — ended every run at that reference: the cursor never advanced past it, the references
 * behind it in the window were never examined, and the housekeeping after the sweep never ran.
 *
 * Why this is not the "catch it and call it absent" defect the worker deliberately avoids:
 *
 * - The `try` covers the one `stat` call and nothing else. A failure of the database — the
 *   window read, settle, reclaim, the cursor — still ends the run, because none of those is
 *   about one reference and none of them has anywhere else to be recorded.
 * - A raised `stat` is never read as an answer. It does not become "absent" (which could
 *   settle a reference whose object is really there) and it does not become "present" (which
 *   could queue a live picture or track for deletion). Neither settle nor reclaim is called
 *   for it at all — so a fault can never lead to a deletion, which is plan section 7.
 * - The error is kept, not dropped: its code, the attempt count and the next attempt time are
 *   written to the reference's own index row in the database, and the run reports how many
 *   references faulted. If that write finds no watched row to record against, the original
 *   error is re-raised and ends the run exactly as before.
 * - Isolation is for one bad reference, not for a dead store: when every reference the run
 *   asked raised, the run still ends with the first error (see the end of the loop).
 *
 * A reference with a fault on record is re-examined when its backoff runs out; the database
 * decides when that is. When its `stat` answers again it is handled exactly like any other
 * reference, and only then is its fault cleared.
 */
async function sweepWindow(
  namespace: SweepNamespace,
  storage: SweptStorage,
  limit: number,
): Promise<TrackReconciliationOutcome> {
  const boundedLimit = z.number().int().min(1).max(1000).parse(limit);
  // Whether the store answers at all is a fact about this run, not about any reference, so it
  // is asked on every run and never backed off. A dead store ends the run here — before the
  // window is read and before any fault is recorded, since no reference is at fault and a
  // recorded fault would only delay those references after the store comes back. Without
  // this, a store that stayed down failed only the first run: its faults then put every
  // reference into backoff, and the runs in between reported success with `deferred: N`.
  await storage.assertReachable();
  const cursor = await namespace.cursor();
  const candidates = await namespace.window(cursor, boundedLimit);
  let queued = 0;
  let faulted = 0;
  let deferred = 0;
  let asked = 0;
  let firstFault: unknown = undefined;
  for (const candidate of candidates) {
    const reference = candidate.storageRef;
    if (candidate.deferred) {
      // Waiting out a recorded fault: it costs this row read and nothing else.
      deferred += 1;
      continue;
    }
    let stat: unknown;
    asked += 1;
    try {
      // The object store is asked once per reference. A reference whose object is absent is
      // exactly the normal case and costs nothing further.
      stat = await storage.stat(reference as never);
    } catch (error) {
      if ((await namespace.recordFault(reference, sweepFaultCodeOf(error))) === null) throw error;
      if (faulted === 0) firstFault = error;
      faulted += 1;
      continue;
    }
    if (stat === null) {
      // Absent, and possibly absent for good: the database decides whether anything could
      // still create it and stops watching only then.
      await namespace.settle(reference);
    } else if (await namespace.reclaim(reference)) {
      queued += 1;
    }
    if (candidate.sweepAttempts > 0) await namespace.clearFault(reference);
  }
  // Every reference the store was asked about raised. The root answered (checked above), so
  // this is the other outage: the store is up but nothing under it can be read — a
  // permission accident across the namespace, a subtree on a failed device. Reporting that
  // run as a success with `faulted: N` would be the per-reference isolation turned into the
  // global version of "an error treated as a known outcome", and it would silence exactly the
  // failure M2-01m's catch-less worker made loud. So the run ends with the first error, as it
  // did before M2-01n, and the cursor stays where it was.
  //
  // "All", not a ratio: one answer is proof the store is reachable, so any window with a
  // single answer is a partial failure and the per-reference records are the right signal;
  // a ratio would need a threshold nothing here can justify, and would fail runs that did
  // real work. The faults are recorded BEFORE the run ends, so the references that raised
  // are deferred on the next run and the window can still be passed — the permanent stall
  // this node fixed cannot come back through this path. A lone poisoned reference that is the
  // only one asked in its window does fail the run once per backoff step; that is a loud
  // false positive at a doubling interval, which is the conservative side to err on.
  if (asked > 0 && faulted === asked) throw firstFault;
  const last = candidates.at(-1);
  // A short window means the end of the ledger: start again from the beginning next time, so
  // nothing stays unvisited because it sorts before the cursor.
  const next = candidates.length === boundedLimit && last !== undefined ? last.storageRef : '';
  await namespace.advance(next);
  return { inspected: candidates.length, queued, faulted, deferred, wrapped: next === '' };
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
 * one `stat` and one bounded statement per row (two for a reference whose fault it records
 * or clears). No directory is walked and no ledger table is scanned, so empty directories,
 * unrelated files and the size of the upload history all cost nothing. Reaching the end of
 * the index resets the cursor, so the next run starts again from the beginning.
 */
export async function reconcileActivityTrackObjects(
  repository: ResourceObjectCleanupRepository,
  storage: SweptStorage,
  limit = 200,
): Promise<TrackReconciliationOutcome> {
  return sweepWindow(
    {
      cursor: () => repository.reconcileCursor(),
      window: (cursor, size) => repository.reconcileWindow(cursor, size),
      advance: (key) => repository.advanceReconcileCursor(key),
      settle: (reference) => repository.settleTrackObjectRef(reference),
      reclaim: (reference) => repository.reclaimUnreferencedTrackObject(reference),
      recordFault: (reference, code) => repository.recordTrackSweepFault(reference, code),
      clearFault: (reference) => repository.clearTrackSweepFault(reference),
    },
    storage,
    limit,
  );
}

/**
 * Compare the thumbnail reference index against the object store and queue whatever nothing
 * accounts for (M2-01m).
 *
 * This is the part of M2-01l's guarantee that does not depend on a receipt still being open.
 * A render that resumes after its lease, its publication fence and the fence's grace have all
 * passed publishes an object whose every receipt is already closed; nothing receipt-based will
 * look at that key again. Reproduced on real PostgreSQL before this was written, and the
 * reproduction is an integration test.
 *
 * Bounded exactly as `reconcileActivityTrackObjects` is, and run by the same window logic —
 * but over its own index, with its own cursor, so neither sweep's progress can starve or skip
 * the other's.
 */
export async function reconcileCourseThumbnailObjects(
  repository: ResourceObjectCleanupRepository,
  storage: SweptStorage,
  limit = 200,
): Promise<TrackReconciliationOutcome> {
  return sweepWindow(
    {
      cursor: () => repository.thumbnailReconcileCursor(),
      window: (cursor, size) => repository.thumbnailReconcileWindow(cursor, size),
      advance: (key) => repository.advanceThumbnailReconcileCursor(key),
      settle: (reference) => repository.settleThumbnailObjectRef(reference),
      reclaim: (reference) => repository.reclaimUnreferencedThumbnailObject(reference),
      recordFault: (reference, code) => repository.recordThumbnailSweepFault(reference, code),
      clearFault: (reference) => repository.clearThumbnailSweepFault(reference),
    },
    storage,
    limit,
  );
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

/**
 * What a tenant purge needs from the object store (M2-01x): the listing of one tenant's
 * prefix, the ordinary guarded `delete`, and `stat` to tell a key another deleter removed
 * first from a failure.
 */
export interface PurgedStorage {
  listTenantObjects(
    tenantId: string,
    limit: number,
  ): Promise<{ readonly keys: readonly string[]; readonly unrecognized: number }>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<unknown>;
}

export type TenantObjectPurgeResult =
  'empty' | 'passed' | 'continuing' | 'retry_scheduled' | 'lease_lost';

/** A listing that named a key outside the leased tenant's prefix: a bug to stop on. */
class ForeignKeyListedError extends Error {
  readonly code = 'FOREIGN_KEY_LISTED';

  constructor() {
    super('The store listed a key outside the tenant being purged.');
    this.name = 'ForeignKeyListedError';
  }
}

/**
 * One leased run of an erased tenant's prefix purge (M2-01x).
 *
 * Why it exists: every other deletion of an erased tenant's objects starts from a database row,
 * and an object uploaded between a backup's dump and its archive copy has none in the restored
 * cluster. The key prefix still names it.
 *
 * What it deletes, and the guards on that, in the order they apply:
 *
 * - Whose. The database leases only a tenant that is in the erasure ledger and has no identity
 *   account (`lease_tenant_object_purge`); the store lists only the canonical tenant directory,
 *   by directory and not by string prefix (`listTenantObjects`); and here every listed key must
 *   begin with that tenant's prefix INCLUDING its trailing separator, or the run stops before
 *   deleting anything of that listing — a storage implementation that answered with another
 *   tenant's key is a bug to fail on, not to act on.
 * - How. Each key goes through the store's own `delete`, with every guard it has: the walk
 *   from the root, symlinks refused, the prune floor, the root re-checked before and after.
 *   Nothing is deleted any other way.
 * - When it stops. At the first error of any kind — a root that is no longer intact, a link, an
 *   unreadable directory, a database failure. The run is recorded as failed with the error's
 *   code and retried with backoff; it never continues past an error to the next key. The one
 *   thing that is not an error is a key another deleter (the cleanup queue works the same keys)
 *   removed first: `delete`'s `unlink` then fails with ENOENT, and the key is re-asked through
 *   `stat`, which walks it under the same guards and answers "absent" only under an intact
 *   root. Anything but that answer ends the run with the original error.
 *
 * Bounded: at most `budget` deletions per run. A run that used its whole budget is recorded as
 * unfinished and is due again at once; only a run that listed nothing left is a pass.
 */
export async function processOneTenantObjectPurge(
  repository: ResourceObjectCleanupRepository,
  storage: PurgedStorage,
  budget = 200,
  now: () => Date = () => new Date(),
): Promise<TenantObjectPurgeResult> {
  const boundedBudget = z.number().int().min(1).max(1000).parse(budget);
  const leasedAt = now();
  const lease = await repository.leaseTenantObjectPurge(
    leasedAt,
    new Date(leasedAt.getTime() + 120_000),
  );
  if (!lease) return 'empty';
  const prefix = `private/v1/tenants/${lease.tenantId}/`;
  let purged = 0;
  let unrecognized = 0;
  let more = false;
  try {
    for (;;) {
      const remaining = boundedBudget - purged;
      if (remaining <= 0) {
        more = true;
        break;
      }
      const listing = await storage.listTenantObjects(lease.tenantId, Math.min(remaining, 100));
      unrecognized = listing.unrecognized;
      if (listing.keys.length === 0) break;
      for (const key of listing.keys)
        if (!key.startsWith(prefix)) throw new ForeignKeyListedError();
      for (const key of listing.keys) {
        try {
          await storage.delete(key);
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error;
          if ((await storage.stat(key)) !== null) throw error;
        }
        purged += 1;
      }
    }
  } catch (error) {
    return (await repository.finishTenantObjectPurge(lease, {
      ok: false,
      errorCode: sweepFaultCodeOf(error),
      purged,
    }))
      ? 'retry_scheduled'
      : 'lease_lost';
  }
  if (!(await repository.finishTenantObjectPurge(lease, { ok: true, purged, unrecognized, more })))
    return 'lease_lost';
  return more ? 'continuing' : 'passed';
}

/**
 * Leased purge runs one worker invocation performs at most (M2-01z).
 *
 * Why more than one: every erased tenant needs one run per hour for thirty days (720 passes),
 * so with one run per invocation the purge capacity was the scheduler's invocations per hour —
 * 60 tenants inside any thirty-day window at one invocation a minute — and a larger erased
 * population, or a restore replay that re-arms every erased tenant at once, fell behind.
 * Ten runs make that 600 tenants a minute-scheduler can keep on the hourly cadence, while one
 * invocation still does a bounded amount of work: at most 10 leases and 10 × the per-run
 * delete budget, before the derived cleanup, the sweeps and housekeeping run. Past that limit
 * nothing is lost — due rows wait in `available_at` order — only the hourly cadence stretches.
 */
export const TENANT_OBJECT_PURGE_RUNS_PER_INVOCATION = 10;

/**
 * Up to `runs` leased purge runs, one after another (M2-01z). Each run is exactly
 * `processOneTenantObjectPurge`: its own lease on one purge row, its own delete budget, its own
 * stop at the first error. The batch goes on only after a run that succeeded (`passed` or
 * `continuing`) and stops at the first that did not — nothing due (`empty`), a failure
 * (`retry_scheduled`) or a lost lease — so one broken store costs one failed run per
 * invocation, as before, not ten. Runs never overlap, so the worker never holds more than one
 * purge row's lease at a time and locks nothing but purge rows.
 */
export async function processTenantObjectPurges(
  repository: ResourceObjectCleanupRepository,
  storage: PurgedStorage,
  runs = TENANT_OBJECT_PURGE_RUNS_PER_INVOCATION,
  budget = 200,
  now: () => Date = () => new Date(),
): Promise<readonly TenantObjectPurgeResult[]> {
  const boundedRuns = z.number().int().min(1).max(100).parse(runs);
  const outcomes: TenantObjectPurgeResult[] = [];
  while (outcomes.length < boundedRuns) {
    const outcome = await processOneTenantObjectPurge(repository, storage, budget, now);
    outcomes.push(outcome);
    if (outcome !== 'passed' && outcome !== 'continuing') break;
  }
  return outcomes;
}

/** The activity's or the course's own id. */
function scopeOwnerId(scope: ObjectScopePurgeScope): string {
  return scope.kind === 'activity' ? scope.activityId : scope.courseId;
}

/**
 * The directory of one scope, WITH its trailing separator (M2-01y): what every key the store
 * lists for that scope must begin with. Built here from the lease, independently of the store.
 */
function scopeKeyPrefix(scope: ObjectScopePurgeScope): string {
  const tenant = `private/v1/tenants/${scope.tenantId}`;
  return scope.kind === 'activity'
    ? `${tenant}/activities/${scope.activityId}/`
    : `${tenant}/courses/${scope.courseId}/`;
}

/**
 * What a scope purge needs from the object store (M2-01y): the listing of one scope's
 * directory, the ordinary guarded `delete`, and `stat` — the tenant purge's needs, one level
 * narrower.
 */
export interface ScopePurgedStorage {
  listScopeObjects(
    scope: ObjectScopePurgeScope,
    limit: number,
  ): Promise<{ readonly keys: readonly string[]; readonly unrecognized: number }>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<unknown>;
}

/**
 * One leased run of a deleted activity's (or a reclaimed course's) prefix purge (M2-01y).
 *
 * Why it exists: every other deletion of such an activity's objects starts from a database
 * row, and a track uploaded — or a picture drawn — between a backup's dump and its archive copy
 * has none in the restored cluster. The tenant is alive, so M2-01x's tenant purge is not armed
 * for it. The activity's (or course's) own key prefix still names it.
 *
 * It is `processOneTenantObjectPurge` one directory lower, with the same guards in the same
 * order and nothing weakened:
 *
 * - Whose. The database leases only a scope whose activity is deleted or absent, or whose
 *   course is reclaimed or absent (`lease_object_scope_purge`), and an activity tombstone is
 *   terminal; the store lists only that canonical directory, by directory, and only keys of
 *   that scope's families naming that same tenant and owner (`listScopeObjects`); and here
 *   every listed key must begin with that directory INCLUDING its trailing separator, or the
 *   run stops before deleting anything of that listing.
 * - How. Each key goes through the store's own `delete`. Nothing is deleted any other way.
 * - When it stops. At the first error of any kind, recorded and retried with backoff. The one
 *   exception is a key another deleter removed first (the queue works the same keys): ENOENT
 *   from `delete`, confirmed absent by `stat` under the same guards.
 *
 * Bounded: at most `budget` deletions per run. Only a run that listed nothing left is a pass,
 * and for a scope the first pass closes the purge.
 */
export async function processOneObjectScopePurge(
  repository: ResourceObjectCleanupRepository,
  storage: ScopePurgedStorage,
  budget = 200,
  now: () => Date = () => new Date(),
): Promise<TenantObjectPurgeResult> {
  const boundedBudget = z.number().int().min(1).max(1000).parse(budget);
  const leasedAt = now();
  const lease = await repository.leaseObjectScopePurge(
    leasedAt,
    new Date(leasedAt.getTime() + 120_000),
  );
  if (!lease) return 'empty';
  const prefix = scopeKeyPrefix(lease.scope);
  let purged = 0;
  let unrecognized = 0;
  let more = false;
  try {
    for (;;) {
      const remaining = boundedBudget - purged;
      if (remaining <= 0) {
        more = true;
        break;
      }
      const listing = await storage.listScopeObjects(lease.scope, Math.min(remaining, 100));
      unrecognized = listing.unrecognized;
      if (listing.keys.length === 0) break;
      for (const key of listing.keys)
        if (!key.startsWith(prefix)) throw new ForeignKeyListedError();
      for (const key of listing.keys) {
        try {
          await storage.delete(key);
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error;
          if ((await storage.stat(key)) !== null) throw error;
        }
        purged += 1;
      }
    }
  } catch (error) {
    return (await repository.finishObjectScopePurge(lease, {
      ok: false,
      errorCode: sweepFaultCodeOf(error),
      purged,
    }))
      ? 'retry_scheduled'
      : 'lease_lost';
  }
  if (!(await repository.finishObjectScopePurge(lease, { ok: true, purged, unrecognized, more })))
    return 'lease_lost';
  return more ? 'continuing' : 'passed';
}

/**
 * Leased scope-purge runs one worker invocation performs at most (M2-01y, N4).
 *
 * Why more than one: every deleted activity and every course that deletion reclaims arms one
 * scope purge, and migration 046 arms one for every activity already deleted and every course
 * already unavailable when it runs. Each needs exactly one complete pass. With one run per
 * invocation the backlog drained at the scheduler's rate — 60 scopes an hour at one invocation
 * a minute — so a history of, say, 50,000 deleted activities took about 35 days. Twenty runs
 * make that 1,200 scopes an hour (28,800 a day; the same 50,000 in under two days), while one
 * invocation stays bounded: at most 20 leases and 20 × the per-run delete budget, and a scope
 * with nothing stored costs a handful of `lstat`s. Past that nothing is lost; due rows wait in
 * `available_at` order.
 */
export const OBJECT_SCOPE_PURGE_RUNS_PER_INVOCATION = 20;

/**
 * Up to `runs` leased scope-purge runs, one after another (M2-01y, N4) — the same rule as
 * `processTenantObjectPurges`: each run is exactly `processOneObjectScopePurge` with its own
 * lease on one purge row, its own delete budget and its own stop at the first error; the batch
 * goes on only after `passed` or `continuing` and stops at the first other outcome. Runs never
 * overlap, so the worker holds at most one scope-purge lease at a time.
 */
export async function processObjectScopePurges(
  repository: ResourceObjectCleanupRepository,
  storage: ScopePurgedStorage,
  runs = OBJECT_SCOPE_PURGE_RUNS_PER_INVOCATION,
  budget = 200,
  now: () => Date = () => new Date(),
): Promise<readonly TenantObjectPurgeResult[]> {
  const boundedRuns = z.number().int().min(1).max(100).parse(runs);
  const outcomes: TenantObjectPurgeResult[] = [];
  while (outcomes.length < boundedRuns) {
    const outcome = await processOneObjectScopePurge(repository, storage, budget, now);
    outcomes.push(outcome);
    if (outcome !== 'passed' && outcome !== 'continuing') break;
  }
  return outcomes;
}
