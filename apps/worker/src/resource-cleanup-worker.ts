import {
  createLocalFilesystemObjectStorage,
  validateObjectKey,
  type ObjectScopeEnumeration,
  type ObjectStorage,
  type StoreReachability,
  type TenantObjectEnumeration,
} from '@workout/server-media';
import {
  createResourceObjectCleanupRepository,
  OBJECT_SCOPE_PURGE_RUNS_PER_INVOCATION,
  processObjectScopePurges,
  processOneResourceObjectCleanup,
  processTenantObjectPurges,
  reconcileActivityTrackObjects,
  reconcileCourseThumbnailObjects,
  TENANT_OBJECT_PURGE_RUNS_PER_INVOCATION,
  type ResourceObjectCleanupRepository,
  type TenantObjectPurgeResult,
  type TrackReconciliationOutcome,
} from '@workout/server-persistence/resource-object-cleanup';
import {
  createResourceDerivedCleanupRepository,
  createResourceDerivedStorePurge,
  processOneResourceDerivedCleanup,
  type ResourceDerivedCleanupRepository,
  type ResourceDerivedPurge,
} from '@workout/server-persistence/resource-derived-cleanup';
import type { ResourceCleanupWorkerConfig } from './config.js';

export type ResourceCleanupWorkerResult = {
  objects: Awaited<ReturnType<typeof processOneResourceObjectCleanup>>;
  derived: Awaited<ReturnType<typeof processOneResourceDerivedCleanup>>;
  /**
   * The leased runs of erased tenants' object-prefix purges (M2-01x), in order: up to
   * `TENANT_OBJECT_PURGE_RUNS_PER_INVOCATION`, ending at the first run that did not succeed
   * (M2-01z).
   */
  tenantPurges: readonly TenantObjectPurgeResult[];
  /**
   * The leased runs of deleted activities' and reclaimed courses' prefix purges (M2-01y), in
   * order: up to `OBJECT_SCOPE_PURGE_RUNS_PER_INVOCATION`, ending at the first run that did not
   * succeed.
   */
  scopePurges: readonly TenantObjectPurgeResult[];
  /** Bounded comparison of the track object namespace against the ledger. */
  trackReconciliation: TrackReconciliationOutcome;
  /** The same, for the course-thumbnail namespace (M2-01m). */
  thumbnailReconciliation: TrackReconciliationOutcome;
};

export interface ResourceCleanupWorkerDependencies {
  createStorage(
    rootDirectory: string,
  ): Promise<ObjectStorage & StoreReachability & TenantObjectEnumeration & ObjectScopeEnumeration>;
  createRepository(options: {
    connectionString: string;
    max: number;
  }): ResourceObjectCleanupRepository;
  createDerivedRepository(options: {
    connectionString: string;
    max: number;
  }): ResourceDerivedCleanupRepository;
  /**
   * Executors for each derived store named by the manifest. M2-05 installs the
   * real deletions, built from the leased repository itself. A store without an
   * executor is still never reported as purged: the manifest is released with
   * `DERIVED_TARGET_UNSUPPORTED` and the coach-use gate stays closed.
   */
  derivedPurge?: (repository: ResourceDerivedCleanupRepository) => ResourceDerivedPurge;
  now?: () => Date;
}

/**
 * Never register a no-op here. An executor that does not really delete would
 * complete a manifest that was never purged and would silently reopen the
 * coach-use gate on data that still exists. Every entry below performs a real,
 * lease-checked deletion of its store.
 */
export const configuredDerivedStorePurge = createResourceDerivedStorePurge;

const defaultDependencies: ResourceCleanupWorkerDependencies = {
  createStorage: createLocalFilesystemObjectStorage,
  createRepository: createResourceObjectCleanupRepository,
  createDerivedRepository: createResourceDerivedCleanupRepository,
  derivedPurge: configuredDerivedStorePurge,
};

/** Runs exactly one bounded queue attempt and always releases the database pool. */
export async function runResourceCleanupWorker(
  config: ResourceCleanupWorkerConfig,
  dependencies: ResourceCleanupWorkerDependencies = defaultDependencies,
): Promise<ResourceCleanupWorkerResult> {
  const storage = await dependencies.createStorage(config.storageRoot);
  const repository = dependencies.createRepository({
    connectionString: config.connectionString,
    max: 1,
  });
  const derivedRepository = dependencies.createDerivedRepository({
    connectionString: config.connectionString,
    max: 1,
  });
  try {
    const now = dependencies.now ?? (() => new Date());
    await repository.reapExpired(now(), 100);
    // Abandoned course-thumbnail renders join the same reaping pass, so there is still one
    // reaper, one bound and one schedule for every private object of a tenant.
    await repository.reapCourseThumbnailRenders(100);
    const objects = await processOneResourceObjectCleanup(
      repository,
      (storageRef) => storage.delete(validateObjectKey(storageRef)),
      now,
    );
    // An erased tenant's whole prefix, independently of any row (M2-01x): what a restored
    // archive brought back that no row of the restored database names. Right after the queue,
    // for the same reason: deleting what an erased user left is the point of this worker.
    // Several runs per invocation, one lease at a time (M2-01z): each tenant needs one run an
    // hour for thirty days, and one run per invocation capped that at the scheduler's rate.
    const tenantPurges = await processTenantObjectPurges(
      repository,
      {
        listTenantObjects: (tenantId, limit) => storage.listTenantObjects(tenantId, limit),
        delete: (key) => storage.delete(validateObjectKey(key)),
        stat: (key) => storage.stat(validateObjectKey(key)),
      },
      TENANT_OBJECT_PURGE_RUNS_PER_INVOCATION,
      200,
      now,
    );
    // The same, one directory lower, for a live tenant (M2-01y): what a restored archive
    // brought back under an activity deleted after the backup, or under a course that deletion
    // reclaimed, that no row of the restored database names.
    // Several runs per invocation, as for tenants (N4): each scope needs one complete pass, and
    // the migration's backfill arms one for every activity ever deleted.
    const scopePurges = await processObjectScopePurges(
      repository,
      {
        listScopeObjects: (scope, limit) => storage.listScopeObjects(scope, limit),
        delete: (key) => storage.delete(validateObjectKey(key)),
        stat: (key) => storage.stat(validateObjectKey(key)),
      },
      OBJECT_SCOPE_PURGE_RUNS_PER_INVOCATION,
      200,
      now,
    );
    const derived = await processOneResourceDerivedCleanup(
      derivedRepository,
      (dependencies.derivedPurge ?? configuredDerivedStorePurge)(derivedRepository),
      now,
    );
    // Reconciliation before housekeeping: an object the ledger does not account for is a
    // leak, and it must be found even when every receipt for it is already closed. The pass
    // is bounded and resumes where the last run stopped.
    const trackReconciliation = await reconcileActivityTrackObjects(repository, storage, 200);
    // One window each, so one run of this worker costs a bounded number of `stat` calls
    // whatever either namespace has accumulated. Neither sweep can starve the other: they
    // keep separate cursors and separate budgets.
    const thumbnailReconciliation = await reconcileCourseThumbnailObjects(repository, storage, 200);
    // Housekeeping runs last. Deleting what a user withdrew is the point of
    // this worker; reclaiming history and expired cache entries must never
    // delay it, even when a prune has to wait for its own bounded timeout.
    await repository.pruneUploadHistory(100);
    await repository.pruneCourseThumbnailHistory(100);
    await repository.pruneCleanupHistory(100);
    await derivedRepository.pruneHistory(100);
    await derivedRepository.pruneRetrievalCache(500);
    return {
      objects,
      tenantPurges,
      scopePurges,
      derived,
      trackReconciliation,
      thumbnailReconciliation,
    };
  } finally {
    await Promise.all([repository.close(), derivedRepository.close()]);
  }
}
