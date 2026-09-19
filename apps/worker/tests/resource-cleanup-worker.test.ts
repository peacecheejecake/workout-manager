import type { ObjectStorage } from '@workout/server-media';
import type {
  ResourceObjectCleanupLease,
  ResourceObjectCleanupRepository,
} from '@workout/server-persistence/resource-object-cleanup';
import { describe, expect, it, vi } from 'vitest';
import {
  runResourceCleanupWorker,
  type ResourceCleanupWorkerDependencies,
} from '../src/resource-cleanup-worker.js';

const connectionString = 'postgres://workout_resource_cleanup_worker:secret@127.0.0.1/workout';
const storageRoot = '/var/lib/workout/resources';
const storageRef =
  'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/resources/4d6cc1ce-0643-4c53-b055-9df458fec594/objects/uploads/db985aaa-b96e-4aef-871a-c99a16183439/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf';
const lease: ResourceObjectCleanupLease = {
  id: 'db985aaa-b96e-4aef-871a-c99a16183439',
  storageRef,
  attempts: 1,
};

function setup(input: {
  leased?: ResourceObjectCleanupLease | null;
  authorized?: ResourceObjectCleanupLease | null;
  deleteFailure?: Error;
  finishResult?: boolean;
  reapFailure?: Error;
  now?: () => Date;
}) {
  const deleteObject = input.deleteFailure
    ? vi.fn(async () => Promise.reject(input.deleteFailure))
    : vi.fn(async () => undefined);
  const repository: ResourceObjectCleanupRepository = {
    reapExpired: input.reapFailure
      ? vi.fn(async () => Promise.reject(input.reapFailure))
      : vi.fn(async () => 0),
    pruneUploadHistory: vi.fn(async () => 0),
    pruneCleanupHistory: vi.fn(async () => 0),
    lease: vi.fn(async () => input.leased ?? null),
    authorize: vi.fn(async (leased) =>
      input.authorized === undefined ? leased : input.authorized,
    ),
    finish: vi.fn(async () => input.finishResult ?? true),
    close: vi.fn(async () => undefined),
  };
  const notUsed = vi.fn(async () => {
    throw new Error('unexpected storage operation');
  });
  const storage: ObjectStorage = {
    writeTemporary: notUsed,
    publishTemporary: notUsed,
    open: notUsed,
    stat: notUsed,
    delete: deleteObject,
  };
  const dependencies: ResourceCleanupWorkerDependencies = {
    createStorage: vi.fn(async () => storage),
    createRepository: vi.fn(() => repository),
    now: input.now ?? vi.fn(() => new Date('2026-09-19T00:00:00.000Z')),
  };
  return { dependencies, repository, deleteObject };
}

describe('resource object cleanup worker', () => {
  it('leases one item, deletes only its validated object key, and finishes it', async () => {
    const { dependencies, repository, deleteObject } = setup({ leased: lease });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('completed');

    expect(dependencies.createStorage).toHaveBeenCalledWith(storageRoot);
    expect(dependencies.createRepository).toHaveBeenCalledWith({ connectionString, max: 1 });
    expect(repository.reapExpired).toHaveBeenCalledWith(new Date('2026-09-19T00:00:00.000Z'), 100);
    expect(repository.pruneUploadHistory).toHaveBeenCalledWith(100);
    expect(repository.pruneCleanupHistory).toHaveBeenCalledWith(100);
    expect(repository.lease).toHaveBeenCalledTimes(1);
    expect(repository.authorize).toHaveBeenCalledWith(lease, expect.any(Date));
    expect(deleteObject).toHaveBeenCalledWith(storageRef);
    expect(repository.finish).toHaveBeenCalledWith(lease, { ok: true }, expect.any(Date));
    expect(repository.close).toHaveBeenCalledTimes(1);
  });

  it('returns an empty one-shot result without attempting deletion or finish', async () => {
    const { dependencies, repository, deleteObject } = setup({ leased: null });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('empty');

    expect(deleteObject).not.toHaveBeenCalled();
    expect(repository.finish).not.toHaveBeenCalled();
    expect(repository.close).toHaveBeenCalledTimes(1);
  });

  it('closes the repository when bounded expired-upload reconciliation fails', async () => {
    const failure = new Error('sensitive reconciliation failure');
    const { dependencies, repository, deleteObject } = setup({ reapFailure: failure });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).rejects.toBe(failure);

    expect(repository.pruneUploadHistory).not.toHaveBeenCalled();
    expect(repository.pruneCleanupHistory).not.toHaveBeenCalled();
    expect(repository.lease).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(repository.close).toHaveBeenCalledTimes(1);
  });

  it('deletes one explicitly leased deterministic temporary key', async () => {
    const temporaryLease = {
      ...lease,
      storageRef:
        'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/resources/4d6cc1ce-0643-4c53-b055-9df458fec594/temporary/db985aaa-b96e-4aef-871a-c99a16183439',
    };
    const { dependencies, repository, deleteObject } = setup({ leased: temporaryLease });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('completed');

    expect(deleteObject).toHaveBeenCalledWith(temporaryLease.storageRef);
    expect(repository.finish).toHaveBeenCalledWith(temporaryLease, { ok: true }, expect.any(Date));
  });

  it('does not touch an object when the database revokes deletion authorization', async () => {
    const { dependencies, repository, deleteObject } = setup({
      leased: lease,
      authorized: null,
    });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('completed');

    expect(repository.authorize).toHaveBeenCalledWith(lease, expect.any(Date));
    expect(deleteObject).not.toHaveBeenCalled();
    expect(repository.finish).not.toHaveBeenCalled();
  });

  it('cannot turn an arbitrary future worker clock into deletion authorization', async () => {
    const arbitraryFuture = vi.fn(() => new Date('9999-12-31T23:59:59.999Z'));
    const { dependencies, repository, deleteObject } = setup({
      leased: lease,
      authorized: null,
      now: arbitraryFuture,
    });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('completed');

    expect(arbitraryFuture).toHaveBeenCalled();
    expect(repository.authorize).toHaveBeenCalledWith(lease, expect.any(Date));
    expect(deleteObject).not.toHaveBeenCalled();
    expect(repository.finish).not.toHaveBeenCalled();
  });

  it('schedules a generic retry when object deletion fails', async () => {
    const { dependencies, repository } = setup({
      leased: lease,
      deleteFailure: new Error('sensitive /storage/path'),
    });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('retry_scheduled');

    expect(repository.finish).toHaveBeenCalledWith(
      lease,
      { ok: false, errorCode: 'OBJECT_DELETE_FAILED' },
      expect.any(Date),
    );
    expect(repository.close).toHaveBeenCalledTimes(1);
  });

  it('rejects an untrusted queue key before storage access and closes the repository', async () => {
    const invalidLease = { ...lease, storageRef: '../../other-tenant/object.pdf' };
    const { dependencies, repository, deleteObject } = setup({ leased: invalidLease });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('retry_scheduled');

    expect(deleteObject).not.toHaveBeenCalled();
    expect(repository.finish).toHaveBeenCalledWith(
      invalidLease,
      { ok: false, errorCode: 'OBJECT_DELETE_FAILED' },
      expect.any(Date),
    );
    expect(repository.close).toHaveBeenCalledTimes(1);
  });

  it('reports lease loss deterministically and closes the repository', async () => {
    const { dependencies, repository } = setup({ leased: lease, finishResult: false });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toBe('lease_lost');

    expect(repository.close).toHaveBeenCalledTimes(1);
  });
});
