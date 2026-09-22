import {
  createLocalFilesystemObjectStorage,
  validateObjectKey,
  type ObjectStorage,
} from '@workout/server-media';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
  reconcileActivityTrackObjects,
  type ResourceObjectCleanupRepository,
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
  /** Bounded comparison of the track object namespace against the ledger. */
  trackReconciliation: TrackReconciliationOutcome;
};

export interface ResourceCleanupWorkerDependencies {
  createStorage(rootDirectory: string): Promise<ObjectStorage>;
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
    const objects = await processOneResourceObjectCleanup(
      repository,
      (storageRef) => storage.delete(validateObjectKey(storageRef)),
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
    // Housekeeping runs last. Deleting what a user withdrew is the point of
    // this worker; reclaiming history and expired cache entries must never
    // delay it, even when a prune has to wait for its own bounded timeout.
    await repository.pruneUploadHistory(100);
    await repository.pruneCleanupHistory(100);
    await derivedRepository.pruneHistory(100);
    await derivedRepository.pruneRetrievalCache(500);
    return { objects, derived, trackReconciliation };
  } finally {
    await Promise.all([repository.close(), derivedRepository.close()]);
  }
}
