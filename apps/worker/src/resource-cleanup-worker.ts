import {
  createLocalFilesystemObjectStorage,
  validateObjectKey,
  type ObjectStorage,
} from '@workout/server-media';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
  type ResourceObjectCleanupRepository,
} from '@workout/server-persistence/resource-object-cleanup';
import {
  createResourceDerivedCleanupRepository,
  processOneResourceDerivedCleanup,
  type ResourceDerivedCleanupRepository,
  type ResourceDerivedPurge,
} from '@workout/server-persistence/resource-derived-cleanup';
import type { ResourceCleanupWorkerConfig } from './config.js';

export type ResourceCleanupWorkerResult = {
  objects: Awaited<ReturnType<typeof processOneResourceObjectCleanup>>;
  derived: Awaited<ReturnType<typeof processOneResourceDerivedCleanup>>;
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
   * Executors for each derived store named by the manifest. M2-04d ships no
   * retrieval index, retrieval cache or stored citation yet, so the default map
   * stays empty and every manifest entry is retried as
   * `DERIVED_TARGET_UNSUPPORTED` instead of being reported as purged. M2-05
   * registers the real executors here.
   */
  derivedPurge?: ResourceDerivedPurge;
  now?: () => Date;
}

/**
 * This build has no retrieval index, no retrieval cache and no stored citation
 * store, so no executor exists for any manifest target. The map is deliberately
 * empty: a manifest must stay incomplete, and the coach-use gate must stay
 * closed, until M2-05 installs real store deletions here. Registering a no-op
 * would complete manifests that were never purged and would silently reopen the
 * gate, so never widen this default without an executor that really deletes.
 */
export const noConfiguredDerivedStorePurge: ResourceDerivedPurge = {};

const defaultDependencies: ResourceCleanupWorkerDependencies = {
  createStorage: createLocalFilesystemObjectStorage,
  createRepository: createResourceObjectCleanupRepository,
  createDerivedRepository: createResourceDerivedCleanupRepository,
  derivedPurge: noConfiguredDerivedStorePurge,
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
    await repository.pruneUploadHistory(100);
    await repository.pruneCleanupHistory(100);
    await derivedRepository.pruneHistory(100);
    const objects = await processOneResourceObjectCleanup(
      repository,
      (storageRef) => storage.delete(validateObjectKey(storageRef)),
      now,
    );
    const derived = await processOneResourceDerivedCleanup(
      derivedRepository,
      dependencies.derivedPurge ?? noConfiguredDerivedStorePurge,
      now,
    );
    return { objects, derived };
  } finally {
    await Promise.all([repository.close(), derivedRepository.close()]);
  }
}
