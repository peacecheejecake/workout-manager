import type { ObjectStorage } from '@workout/server-media';
import type {
  ResourceObjectCleanupLease,
  ResourceObjectCleanupRepository,
} from '@workout/server-persistence/resource-object-cleanup';
import type {
  ResourceDerivedCleanupManifest,
  ResourceDerivedCleanupRepository,
} from '@workout/server-persistence/resource-derived-cleanup';
import { describe, expect, it, vi } from 'vitest';
import {
  configuredDerivedStorePurge,
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
  derivedManifest?: ResourceDerivedCleanupManifest | null;
  derivedReleaseResult?: boolean;
  now?: () => Date;
  reconcileCursor?: string;
  reclaimQueued?: boolean;
  candidates?: readonly string[];
  statResult?: unknown;
  settled?: boolean;
  thumbnailSweepFailure?: Error;
  thumbnailCandidates?: readonly string[];
  thumbnailStatResult?: unknown;
  thumbnailReclaimQueued?: boolean;
  thumbnailSettled?: boolean;
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
    reapCourseThumbnailRenders: vi.fn(async () => 0),
    pruneCourseThumbnailHistory: vi.fn(async () => 0),
    reconcileCursor: vi.fn(async () => input.reconcileCursor ?? ''),
    advanceReconcileCursor: vi.fn(async () => undefined),
    reconcileCandidates: vi.fn(async () => input.candidates ?? []),
    settleTrackObjectRef: vi.fn(async () => input.settled ?? false),
    reclaimUnreferencedTrackObject: vi.fn(async () => input.reclaimQueued ?? false),
    thumbnailReconcileCursor: vi.fn(async () => ''),
    advanceThumbnailReconcileCursor: vi.fn(async () => undefined),
    thumbnailReconcileCandidates: input.thumbnailSweepFailure
      ? vi.fn(async () => Promise.reject(input.thumbnailSweepFailure))
      : vi.fn(async () => input.thumbnailCandidates ?? []),
    settleThumbnailObjectRef: vi.fn(async () => input.thumbnailSettled ?? false),
    reclaimUnreferencedThumbnailObject: vi.fn(async () => input.thumbnailReclaimQueued ?? false),
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
    // Each namespace's window has its own store answer, so one sweep's arrangement cannot
    // silently decide the other's outcome.
    stat: vi.fn(
      async (key: string) =>
        ((input.thumbnailCandidates ?? []).includes(key)
          ? (input.thumbnailStatResult ?? null)
          : (input.statResult ?? null)) as never,
    ),
    delete: deleteObject,
  };
  const derivedRepository: ResourceDerivedCleanupRepository = {
    pruneHistory: vi.fn(async () => 0),
    pruneRetrievalCache: vi.fn(async () => 0),
    lease: vi.fn(async () => input.derivedManifest ?? null),
    finish: vi.fn(async () => true),
    release: vi.fn(async () => input.derivedReleaseResult ?? true),
    purgeTarget: vi.fn(async () => 1),
    close: vi.fn(async () => undefined),
  };
  const dependencies: ResourceCleanupWorkerDependencies = {
    createStorage: vi.fn(async () => storage),
    createRepository: vi.fn(() => repository),
    createDerivedRepository: vi.fn(() => derivedRepository),
    now: input.now ?? vi.fn(() => new Date('2026-09-19T00:00:00.000Z')),
  };
  return { dependencies, repository, derivedRepository, deleteObject, storage };
}

describe('resource object cleanup worker', () => {
  it('leases one item, deletes only its validated object key, and finishes it', async () => {
    const { dependencies, repository, deleteObject } = setup({ leased: lease });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toMatchObject({ objects: 'completed' });

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

  it('reconciles a bounded window of ledger references and reports what it queued', async () => {
    const trackKey =
      'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/activities/4d6cc1ce-0643-4c53-b055-9df458fec594/tracks/db985aaa-b96e-4aef-871a-c99a16183439/raw/uploads/db985aaa-b96e-4aef-871a-c99a16183439/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.gpx';
    const { dependencies, repository, storage } = setup({
      candidates: [trackKey],
      reclaimQueued: true,
      statResult: { key: trackKey, sizeBytes: 1, modifiedAt: new Date(0) },
    });
    const result = await runResourceCleanupWorker({ connectionString, storageRoot }, dependencies);
    // The window comes from the ledger, and the store is asked once per reference.
    expect(repository.reconcileCandidates).toHaveBeenCalledWith('', 200);
    expect(storage.stat).toHaveBeenCalledWith(trackKey);
    expect(repository.reclaimUnreferencedTrackObject).toHaveBeenCalledWith(trackKey);
    expect(result.trackReconciliation).toEqual({ inspected: 1, queued: 1, wrapped: true });
    // A short window ended the ledger scan, so the cursor goes back to the start.
    expect(repository.advanceReconcileCursor).toHaveBeenCalledWith('');
  });

  it('never asks the database about a reference whose object is absent', async () => {
    const absent =
      'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/activities/4d6cc1ce-0643-4c53-b055-9df458fec594/tracks/db985aaa-b96e-4aef-871a-c99a16183439/raw/uploads/db985aaa-b96e-4aef-871a-c99a16183439/sha256/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.gpx';
    const { dependencies, repository } = setup({ candidates: [absent], statResult: null });
    const result = await runResourceCleanupWorker({ connectionString, storageRoot }, dependencies);
    expect(repository.reclaimUnreferencedTrackObject).not.toHaveBeenCalled();
    // An absent object is offered for settling instead; the database decides.
    expect(repository.settleTrackObjectRef).toHaveBeenCalledWith(absent);
    expect(result.trackReconciliation).toEqual({ inspected: 1, queued: 0, wrapped: true });
  });

  it('sweeps the thumbnail namespace in its own bounded window, with its own cursor', async () => {
    const thumbnailKey =
      'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/courses/4d6cc1ce-0643-4c53-b055-9df458fec594/thumbnails/revisions/db985aaa-b96e-4aef-871a-c99a16183439/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.svg';
    const { dependencies, repository, storage } = setup({
      thumbnailCandidates: [thumbnailKey],
      thumbnailReclaimQueued: true,
      thumbnailStatResult: { key: thumbnailKey, sizeBytes: 298, modifiedAt: new Date(0) },
    });
    const result = await runResourceCleanupWorker({ connectionString, storageRoot }, dependencies);
    expect(repository.thumbnailReconcileCandidates).toHaveBeenCalledWith('', 200);
    expect(storage.stat).toHaveBeenCalledWith(thumbnailKey);
    expect(repository.reclaimUnreferencedThumbnailObject).toHaveBeenCalledWith(thumbnailKey);
    expect(result.thumbnailReconciliation).toEqual({ inspected: 1, queued: 1, wrapped: true });
    expect(repository.advanceThumbnailReconcileCursor).toHaveBeenCalledWith('');
    // The two namespaces are swept independently: neither cursor nor budget is shared.
    expect(repository.reclaimUnreferencedTrackObject).not.toHaveBeenCalled();
  });

  it('offers an absent thumbnail reference for settling instead of queueing a deletion', async () => {
    const absent =
      'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/courses/4d6cc1ce-0643-4c53-b055-9df458fec594/thumbnails/temporary/db985aaa-b96e-4aef-871a-c99a16183439';
    const { dependencies, repository } = setup({
      thumbnailCandidates: [absent],
      thumbnailStatResult: null,
    });
    const result = await runResourceCleanupWorker({ connectionString, storageRoot }, dependencies);
    expect(repository.reclaimUnreferencedThumbnailObject).not.toHaveBeenCalled();
    expect(repository.settleThumbnailObjectRef).toHaveBeenCalledWith(absent);
    expect(result.thumbnailReconciliation).toEqual({ inspected: 1, queued: 0, wrapped: true });
  });

  it('lets a sweep failure end the run rather than reporting a sweep that did not happen', async () => {
    // A deliberate absence of `catch`. The sweep reads a real object store, and the errors it
    // can raise are the ones that must not be swallowed: `UnsafeStoragePathError` is the
    // symlink guard firing, and EACCES/EIO mean the store is not answering. Turning any of
    // those into "swept nothing, all clear" is this repository's recurring "treat an error as
    // a known outcome" defect, so the run fails and says so.
    //
    // What that costs is bounded, and this test is what fixes the cost rather than leaving it
    // as a claim: the deletion the user actually asked for has already happened, and only the
    // idempotent housekeeping is skipped — it runs again on the next tick, and the cursor not
    // advancing means the same window is retried, which is the correct resume.
    const { dependencies, repository, derivedRepository, deleteObject } = setup({
      leased: lease,
      thumbnailSweepFailure: new Error('EACCES: permission denied'),
    });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).rejects.toThrow('EACCES');

    // Already done before the sweep: the withdrawal this worker exists for.
    expect(deleteObject).toHaveBeenCalledWith(storageRef);
    expect(repository.finish).toHaveBeenCalledWith(lease, { ok: true }, expect.any(Date));
    // Skipped, and safe to skip: bounded housekeeping and the cursor advance.
    expect(repository.pruneUploadHistory).not.toHaveBeenCalled();
    expect(repository.pruneCourseThumbnailHistory).not.toHaveBeenCalled();
    expect(repository.pruneCleanupHistory).not.toHaveBeenCalled();
    expect(derivedRepository.pruneHistory).not.toHaveBeenCalled();
    expect(derivedRepository.pruneRetrievalCache).not.toHaveBeenCalled();
    expect(repository.advanceThumbnailReconcileCursor).not.toHaveBeenCalled();
    // The pools are still released.
    expect(repository.close).toHaveBeenCalledTimes(1);
    expect(derivedRepository.close).toHaveBeenCalledTimes(1);
  });

  it('returns an empty one-shot result without attempting deletion or finish', async () => {
    const { dependencies, repository, deleteObject } = setup({ leased: null });

    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toMatchObject({ objects: 'empty' });

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
    ).resolves.toMatchObject({ objects: 'completed' });

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
    ).resolves.toMatchObject({ objects: 'completed' });

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
    ).resolves.toMatchObject({ objects: 'completed' });

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
    ).resolves.toMatchObject({ objects: 'retry_scheduled' });

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
    ).resolves.toMatchObject({ objects: 'retry_scheduled' });

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
    ).resolves.toMatchObject({ objects: 'lease_lost' });

    expect(repository.close).toHaveBeenCalledTimes(1);
  });

  it('never completes a derived manifest while no store executor is installed', async () => {
    const manifest: ResourceDerivedCleanupManifest = {
      id: '0b2a4f0c-0f7f-4a0f-9d1d-5b0a5a8e6a11',
      athleteId: 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa',
      resourceId: '4d6cc1ce-0643-4c53-b055-9df458fec594',
      reason: 'share_revoked',
      accessRevision: 4,
      targets: { derivedData: true, searchIndex: true, cache: true, citations: true },
      attempts: 1,
    };
    const { dependencies, derivedRepository } = setup({ derivedManifest: manifest });

    // With no executor at all the manifest must stay open and fail closed, and
    // the queue must not even be leased, so no attempt budget is spent.
    await expect(
      runResourceCleanupWorker(
        { connectionString, storageRoot },
        { ...dependencies, derivedPurge: () => ({}) },
      ),
    ).resolves.toMatchObject({ objects: 'empty', derived: 'unsupported_target' });

    expect(derivedRepository.pruneHistory).toHaveBeenCalledWith(100);
    // The retrieval cache is reclaimed on every cycle, not only on deletion.
    expect(derivedRepository.pruneRetrievalCache).toHaveBeenCalledWith(500);
    expect(derivedRepository.lease).not.toHaveBeenCalled();
    expect(derivedRepository.finish).not.toHaveBeenCalled();
    expect(derivedRepository.release).not.toHaveBeenCalled();
    expect(derivedRepository.close).toHaveBeenCalledTimes(1);
  });

  it('releases rather than fails a manifest when one target executor is missing', async () => {
    const manifest: ResourceDerivedCleanupManifest = {
      id: '0b2a4f0c-0f7f-4a0f-9d1d-5b0a5a8e6a14',
      athleteId: 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa',
      resourceId: '4d6cc1ce-0643-4c53-b055-9df458fec594',
      reason: 'coach_use_withdrawn',
      accessRevision: 5,
      targets: { derivedData: true, searchIndex: true, cache: true, citations: true },
      attempts: 1,
    };
    const { dependencies, derivedRepository } = setup({ derivedManifest: manifest });

    await expect(
      runResourceCleanupWorker(
        { connectionString, storageRoot },
        { ...dependencies, derivedPurge: () => ({ derivedData: async () => undefined }) },
      ),
    ).resolves.toMatchObject({ derived: 'unsupported_target' });

    // A released lease returns the attempt budget instead of spending it.
    expect(derivedRepository.release).toHaveBeenCalledWith(manifest, 'DERIVED_TARGET_UNSUPPORTED');
    expect(derivedRepository.finish).not.toHaveBeenCalled();
  });

  it('reports lease loss when the expired lease can no longer be released', async () => {
    const manifest: ResourceDerivedCleanupManifest = {
      id: '0b2a4f0c-0f7f-4a0f-9d1d-5b0a5a8e6a15',
      athleteId: 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa',
      resourceId: '4d6cc1ce-0643-4c53-b055-9df458fec594',
      reason: 'share_revoked',
      accessRevision: 6,
      targets: { derivedData: true, searchIndex: true, cache: true, citations: true },
      attempts: 1,
    };
    const { dependencies, derivedRepository } = setup({
      derivedManifest: manifest,
      derivedReleaseResult: false,
    });

    // A refused release means the 60s lease already expired, so the attempt was
    // not restored and this worker must not claim an unsupported-target cycle.
    await expect(
      runResourceCleanupWorker(
        { connectionString, storageRoot },
        { ...dependencies, derivedPurge: () => ({ derivedData: async () => undefined }) },
      ),
    ).resolves.toMatchObject({ derived: 'lease_lost' });

    expect(derivedRepository.release).toHaveBeenCalledTimes(1);
    expect(derivedRepository.finish).not.toHaveBeenCalled();
  });

  it('completes a derived manifest only when every target has a real executor', async () => {
    const manifest: ResourceDerivedCleanupManifest = {
      id: '0b2a4f0c-0f7f-4a0f-9d1d-5b0a5a8e6a13',
      athleteId: 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa',
      resourceId: '4d6cc1ce-0643-4c53-b055-9df458fec594',
      reason: 'review_withdrawn',
      accessRevision: 9,
      targets: { derivedData: true, searchIndex: true, cache: true, citations: true },
      attempts: 1,
    };
    const { dependencies, derivedRepository } = setup({ derivedManifest: manifest });
    const purged: string[] = [];
    const record = (name: string) => async () => {
      purged.push(name);
    };

    await expect(
      runResourceCleanupWorker(
        { connectionString, storageRoot },
        {
          ...dependencies,
          derivedPurge: () => ({
            derivedData: record('derivedData'),
            searchIndex: record('searchIndex'),
            cache: record('cache'),
            citations: record('citations'),
          }),
        },
      ),
    ).resolves.toMatchObject({ derived: 'completed' });

    expect(purged).toEqual(['derivedData', 'searchIndex', 'cache', 'citations']);
    expect(derivedRepository.finish).toHaveBeenCalledWith(manifest, { ok: true });
  });

  it('installs a real executor for every declared target by default', async () => {
    const manifest: ResourceDerivedCleanupManifest = {
      id: '0b2a4f0c-0f7f-4a0f-9d1d-5b0a5a8e6a16',
      athleteId: 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa',
      resourceId: '4d6cc1ce-0643-4c53-b055-9df458fec594',
      reason: 'resource_deleted',
      accessRevision: 11,
      targets: { derivedData: true, searchIndex: true, cache: true, citations: true },
      attempts: 1,
    };
    const { dependencies, derivedRepository } = setup({ derivedManifest: manifest });

    // The default map is the configured one, so the manifest completes only
    // because every target was really purged through the leased function.
    await expect(
      runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
    ).resolves.toMatchObject({ derived: 'completed' });

    expect(Object.keys(configuredDerivedStorePurge(derivedRepository)).sort()).toEqual([
      'cache',
      'citations',
      'derivedData',
      'searchIndex',
    ]);
    expect(derivedRepository.purgeTarget).toHaveBeenCalledTimes(4);
    for (const target of ['derivedData', 'searchIndex', 'cache', 'citations'])
      expect(derivedRepository.purgeTarget).toHaveBeenCalledWith(manifest, target);
    expect(derivedRepository.finish).toHaveBeenCalledWith(manifest, { ok: true });
  });
});
