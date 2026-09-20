import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';

/**
 * Durable derived-data cleanup manifest. Deletion, revocation, consent
 * withdrawal and a reviewed/coach-use downgrade all enqueue one entry here.
 * It shares the lease, bounded retry and dead-letter discipline of the M2-04b
 * object cleanup queue and is drained by the same worker process; object bytes
 * keep flowing through `resource_object_cleanup` unchanged.
 */
export interface ResourceDerivedCleanupManifest {
  id: string;
  athleteId: string;
  resourceId: string;
  reason:
    | 'resource_deleted'
    | 'share_revoked'
    | 'consent_withdrawn'
    | 'review_withdrawn'
    | 'coach_use_withdrawn'
    | 'account_erased';
  accessRevision: number;
  targets: { derivedData: true; searchIndex: true; cache: true; citations: true };
  attempts: number;
}

export interface ResourceDerivedCleanupRepository {
  pruneHistory(limit?: number): Promise<number>;
  /** Reclaims expired retrieval cache rows; the TTL is not only a read filter. */
  pruneRetrievalCache(limit?: number): Promise<number>;
  lease(now: Date, leaseUntil: Date): Promise<ResourceDerivedCleanupManifest | null>;
  finish(
    manifest: ResourceDerivedCleanupManifest,
    outcome: { ok: true } | { ok: false; errorCode: string },
  ): Promise<boolean>;
  /** Returns the lease without charging the attempt or dead-letter budget. */
  release(manifest: ResourceDerivedCleanupManifest, errorCode: string): Promise<boolean>;
  /**
   * Deletes one derived store for the leased manifest and returns the number of
   * rows removed. The database function refuses unless this worker still holds
   * a valid lease on that entry, and it reads the tenant and resource from the
   * manifest row rather than from the caller.
   */
  purgeTarget(
    manifest: ResourceDerivedCleanupManifest,
    target: keyof ResourceDerivedCleanupManifest['targets'],
  ): Promise<number>;
  close(): Promise<void>;
}

const derivedTargetSchema = z.enum(['derivedData', 'searchIndex', 'cache', 'citations']);

const targetsSchema = z.strictObject({
  derivedData: z.literal(true),
  searchIndex: z.literal(true),
  cache: z.literal(true),
  citations: z.literal(true),
});

const manifestRowSchema = z.object({
  id: z.uuid(),
  athlete_id: z.string().min(1).max(200),
  resource_id: z.uuid(),
  reason: z.enum([
    'resource_deleted',
    'share_revoked',
    'consent_withdrawn',
    'review_withdrawn',
    'coach_use_withdrawn',
    'account_erased',
  ]),
  access_revision: z.number().int().positive(),
  targets: targetsSchema,
  attempts: z.number().int().positive(),
});

/** Worker credentials receive only bounded lifecycle functions and no table access. */
export function createResourceDerivedCleanupRepository(options: {
  connectionString: string;
  workerId?: string;
  max?: number;
  statementTimeoutMillis?: number;
  lockTimeoutMillis?: number;
}): ResourceDerivedCleanupRepository {
  const workerId = z.uuid().parse(options.workerId ?? randomUUID());
  // The privacy cleanup worker must never wait indefinitely: a statement that
  // blocks on another transaction's lock fails fast and is retried on the next
  // cycle instead of stalling deletion for every tenant.
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 2,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: options.statementTimeoutMillis ?? 15000,
    lock_timeout: options.lockTimeoutMillis ?? 5000,
  });
  return {
    async pruneHistory(limit = 100) {
      const boundedLimit = z.number().int().min(1).max(100).parse(limit);
      const result = await pool.query(
        'SELECT public.prune_resource_derived_cleanup_history($1) AS affected',
        [boundedLimit],
      );
      return z.number().int().nonnegative().parse(result.rows[0]?.['affected']);
    },
    async pruneRetrievalCache(limit = 500) {
      const boundedLimit = z.number().int().min(1).max(1000).parse(limit);
      const result = await pool.query(
        'SELECT public.prune_resource_retrieval_cache($1) AS affected',
        [boundedLimit],
      );
      return z.number().int().nonnegative().parse(result.rows[0]?.['affected']);
    },
    async lease(now, leaseUntil) {
      const result = await pool.query(
        'SELECT * FROM public.lease_resource_derived_cleanup($1,$2,$3)',
        [workerId, now.toISOString(), leaseUntil.toISOString()],
      );
      if (!result.rows[0]) return null;
      const row = manifestRowSchema.parse(result.rows[0]);
      return {
        id: row.id,
        athleteId: row.athlete_id,
        resourceId: row.resource_id,
        reason: row.reason,
        accessRevision: row.access_revision,
        targets: row.targets,
        attempts: row.attempts,
      };
    },
    async finish(manifest, outcome) {
      const errorCode = outcome.ok
        ? null
        : z
            .string()
            .min(1)
            .max(100)
            .regex(/^[A-Z0-9_:-]+$/)
            .parse(outcome.errorCode);
      const result = await pool.query(
        'SELECT public.finish_resource_derived_cleanup($1,$2,$3,$4) AS finished',
        [z.uuid().parse(manifest.id), workerId, outcome.ok, errorCode],
      );
      return result.rows[0]?.['finished'] === true;
    },
    async release(manifest, errorCode) {
      const code = z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Z0-9_:-]+$/)
        .parse(errorCode);
      const result = await pool.query(
        'SELECT public.release_resource_derived_cleanup($1,$2,$3) AS released',
        [z.uuid().parse(manifest.id), workerId, code],
      );
      return result.rows[0]?.['released'] === true;
    },
    async purgeTarget(manifest, target) {
      const result = await pool.query(
        'SELECT public.purge_resource_derived_store($1,$2,$3) AS purged',
        [z.uuid().parse(manifest.id), workerId, derivedTargetSchema.parse(target)],
      );
      return z.number().int().nonnegative().parse(result.rows[0]?.['purged']);
    },
    close: () => pool.end(),
  };
}

/**
 * Executors for each derived store. A store that does not exist yet must be
 * absent from this map rather than silently reported as purged; the manifest
 * only completes once every declared target has an executor that succeeded.
 */
export type ResourceDerivedPurge = Partial<
  Record<
    keyof ResourceDerivedCleanupManifest['targets'],
    (manifest: ResourceDerivedCleanupManifest) => Promise<void>
  >
>;

/**
 * The real executors. Each one deletes its store through the leased-only
 * database function, so a manifest completes only after every declared target
 * has actually been purged. Ordering does not matter: the foreign keys from
 * grounding excerpts and citations to the index row cascade, so a store can
 * never be left holding a copy of a purged excerpt.
 */
export function createResourceDerivedStorePurge(
  repository: ResourceDerivedCleanupRepository,
): ResourceDerivedPurge {
  const purge =
    (target: keyof ResourceDerivedCleanupManifest['targets']) =>
    async (manifest: ResourceDerivedCleanupManifest) => {
      await repository.purgeTarget(manifest, target);
    };
  return {
    derivedData: purge('derivedData'),
    searchIndex: purge('searchIndex'),
    cache: purge('cache'),
    citations: purge('citations'),
  };
}

export async function processOneResourceDerivedCleanup(
  repository: ResourceDerivedCleanupRepository,
  purge: ResourceDerivedPurge,
  now: () => Date = () => new Date(),
): Promise<'empty' | 'completed' | 'retry_scheduled' | 'lease_lost' | 'unsupported_target'> {
  // With no executor at all the queue is not touched, so an unfinished manifest
  // keeps its full attempt budget for the release that installs real stores.
  if (Object.keys(purge).length === 0) return 'unsupported_target';
  const leasedAt = now();
  const manifest = await repository.lease(leasedAt, new Date(leasedAt.getTime() + 60_000));
  if (!manifest) return 'empty';
  const targets = Object.keys(
    manifest.targets,
  ) as (keyof ResourceDerivedCleanupManifest['targets'])[];
  const missing = targets.filter((target) => purge[target] === undefined);
  if (missing.length > 0) {
    // An unimplemented derived store is never reported as purged, and it never
    // spends the dead-letter budget either: the lease is released instead of
    // failed so the backlog is still processable once an executor exists. A
    // release only applies to a lease that is still valid, so a refused release
    // means this worker no longer owns the entry and must say so.
    const released = await repository.release(manifest, 'DERIVED_TARGET_UNSUPPORTED');
    return released ? 'unsupported_target' : 'lease_lost';
  }
  try {
    for (const target of targets) await purge[target]?.(manifest);
    return (await repository.finish(manifest, { ok: true })) ? 'completed' : 'lease_lost';
  } catch {
    return (await repository.finish(manifest, { ok: false, errorCode: 'DERIVED_PURGE_FAILED' }))
      ? 'retry_scheduled'
      : 'lease_lost';
  }
}
