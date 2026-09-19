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
import type { ResourceCleanupWorkerConfig } from './config.js';

export type ResourceCleanupWorkerResult = Awaited<
  ReturnType<typeof processOneResourceObjectCleanup>
>;

export interface ResourceCleanupWorkerDependencies {
  createStorage(rootDirectory: string): Promise<ObjectStorage>;
  createRepository(options: {
    connectionString: string;
    max: number;
  }): ResourceObjectCleanupRepository;
  now?: () => Date;
}

const defaultDependencies: ResourceCleanupWorkerDependencies = {
  createStorage: createLocalFilesystemObjectStorage,
  createRepository: createResourceObjectCleanupRepository,
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
  try {
    const now = dependencies.now ?? (() => new Date());
    await repository.reapExpired(now(), 100);
    await repository.pruneUploadHistory(100);
    await repository.pruneCleanupHistory(100);
    return await processOneResourceObjectCleanup(
      repository,
      (storageRef) => storage.delete(validateObjectKey(storageRef)),
      now,
    );
  } finally {
    await repository.close();
  }
}
