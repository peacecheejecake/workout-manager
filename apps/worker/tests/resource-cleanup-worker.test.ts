import type {
  ObjectScopeEnumeration,
  ObjectStorage,
  StoreReachability,
  TenantObjectEnumeration,
  TenantObjectListing,
} from '@workout/server-media';
import type {
  ObjectScopePurgeLease,
  ResourceObjectCleanupLease,
  ResourceObjectCleanupRepository,
  TenantObjectPurgeLease,
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
  /** References whose `stat` raises, and what it raises (M2-01n). */
  statFailures?: ReadonlyMap<string, Error>;
  /** Fault state the window reports per reference; absent means none on record. */
  windowFaults?: ReadonlyMap<string, { sweepAttempts: number; deferred: boolean }>;
  /** What recording a fault answers; a function so a test can make it fail. */
  recordFault?: () => Promise<number | null>;
  /** What the store's reachability check raises; absent means the store answers. */
  storeDown?: Error;
  /** The erased tenant whose prefix purge is due (M2-01x); absent means none. Leased once. */
  purgeLease?: TenantObjectPurgeLease;
  /** Successive purge leases, one per lease call, then none (M2-01z); overrides `purgeLease`. */
  purgeLeases?: readonly TenantObjectPurgeLease[];
  /** Successive answers of the tenant listing; the last one repeats. */
  tenantListings?: readonly TenantObjectListing[];
  /** The deleted activity or reclaimed course whose prefix purge is due (M2-01y). */
  scopePurgeLease?: ObjectScopePurgeLease;
  /** Successive scope leases, one per lease call, then none; overrides `scopePurgeLease`. */
  scopePurgeLeases?: readonly ObjectScopePurgeLease[];
  /** Successive answers of the scope listing; the last one repeats. */
  scopeListings?: readonly TenantObjectListing[];
}) {
  const window = (references: readonly string[]) =>
    references.map((storageRef) => ({
      storageRef,
      ...(input.windowFaults?.get(storageRef) ?? { sweepAttempts: 0, deferred: false }),
    }));
  const scopeLeases = [
    ...(input.scopePurgeLeases ?? (input.scopePurgeLease ? [input.scopePurgeLease] : [])),
  ];
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
    reconcileWindow: vi.fn(async () => window(input.candidates ?? [])),
    settleTrackObjectRef: vi.fn(async () => input.settled ?? false),
    reclaimUnreferencedTrackObject: vi.fn(async () => input.reclaimQueued ?? false),
    recordTrackSweepFault: vi.fn(input.recordFault ?? (async () => 1)),
    clearTrackSweepFault: vi.fn(async () => true),
    thumbnailReconcileCursor: vi.fn(async () => ''),
    advanceThumbnailReconcileCursor: vi.fn(async () => undefined),
    thumbnailReconcileWindow: input.thumbnailSweepFailure
      ? vi.fn(async () => Promise.reject(input.thumbnailSweepFailure))
      : vi.fn(async () => window(input.thumbnailCandidates ?? [])),
    settleThumbnailObjectRef: vi.fn(async () => input.thumbnailSettled ?? false),
    reclaimUnreferencedThumbnailObject: vi.fn(async () => input.thumbnailReclaimQueued ?? false),
    recordThumbnailSweepFault: vi.fn(input.recordFault ?? (async () => 1)),
    clearThumbnailSweepFault: vi.fn(async () => true),
    leaseTenantObjectPurge: vi.fn(async () => purgeLeases.shift() ?? null),
    finishTenantObjectPurge: vi.fn(async () => true),
    leaseObjectScopePurge: vi.fn(async () => scopeLeases.shift() ?? null),
    finishObjectScopePurge: vi.fn(async () => true),
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
  const listings = [...(input.tenantListings ?? [])];
  const purgeLeases = [...(input.purgeLeases ?? (input.purgeLease ? [input.purgeLease] : []))];
  const scopeListings = [...(input.scopeListings ?? [])];
  const storage: ObjectStorage &
    StoreReachability &
    TenantObjectEnumeration &
    ObjectScopeEnumeration = {
    listScopeObjects: vi.fn(
      async () =>
        (scopeListings.length > 1 ? scopeListings.shift() : scopeListings[0]) ?? {
          keys: [],
          unrecognized: 0,
          truncated: false,
        },
    ),
    listTenantObjects: vi.fn(
      async () =>
        (listings.length > 1 ? listings.shift() : listings[0]) ?? {
          keys: [],
          unrecognized: 0,
          truncated: false,
        },
    ),
    assertReachable: vi.fn(async () => {
      if (input.storeDown) throw input.storeDown;
    }),
    writeTemporary: notUsed,
    publishTemporary: notUsed,
    open: notUsed,
    // Each namespace's window has its own store answer, so one sweep's arrangement cannot
    // silently decide the other's outcome.
    stat: vi.fn(async (key: string) => {
      const failure = input.statFailures?.get(key);
      if (failure) throw failure;
      return (
        (input.thumbnailCandidates ?? []).includes(key)
          ? (input.thumbnailStatResult ?? null)
          : (input.statResult ?? null)
      ) as never;
    }),
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
    expect(repository.reconcileWindow).toHaveBeenCalledWith('', 200);
    expect(storage.stat).toHaveBeenCalledWith(trackKey);
    expect(repository.reclaimUnreferencedTrackObject).toHaveBeenCalledWith(trackKey);
    expect(result.trackReconciliation).toEqual({
      inspected: 1,
      queued: 1,
      faulted: 0,
      deferred: 0,
      wrapped: true,
    });
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
    expect(result.trackReconciliation).toEqual({
      inspected: 1,
      queued: 0,
      faulted: 0,
      deferred: 0,
      wrapped: true,
    });
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
    expect(repository.thumbnailReconcileWindow).toHaveBeenCalledWith('', 200);
    expect(storage.stat).toHaveBeenCalledWith(thumbnailKey);
    expect(repository.reclaimUnreferencedThumbnailObject).toHaveBeenCalledWith(thumbnailKey);
    expect(result.thumbnailReconciliation).toEqual({
      inspected: 1,
      queued: 1,
      faulted: 0,
      deferred: 0,
      wrapped: true,
    });
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
    expect(result.thumbnailReconciliation).toEqual({
      inspected: 1,
      queued: 0,
      faulted: 0,
      deferred: 0,
      wrapped: true,
    });
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
    //
    // This stays true after M2-01n. What M2-01n added is narrower: a `stat` that raises for one
    // reference is recorded against that reference in the database (the tests below), which is
    // keeping the error, not swallowing it. A failure with nowhere to be recorded — this one,
    // the window itself — still ends the run.
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

  describe('a reference whose stat always raises (M2-01n)', () => {
    const tenant = 'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa';
    const poisoned = `${tenant}/courses/4d6cc1ce-0643-4c53-b055-9df458fec594/thumbnails/temporary/00000000-0000-4000-8000-000000000001`;
    const orphan = `${tenant}/courses/4d6cc1ce-0643-4c53-b055-9df458fec594/thumbnails/temporary/00000000-0000-4000-8000-000000000002`;
    const unsafe = Object.assign(new Error('Storage path … contains a symbolic link.'), {
      code: 'UNSAFE_STORAGE_PATH',
    });

    it('is recorded against that one reference, and the rest of the window and the run go on', async () => {
      const { dependencies, repository, derivedRepository, storage } = setup({
        leased: lease,
        thumbnailCandidates: [poisoned, orphan],
        thumbnailStatResult: { key: orphan, sizeBytes: 298, modifiedAt: new Date(0) },
        thumbnailReclaimQueued: true,
        statFailures: new Map([[poisoned, unsafe]]),
      });

      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );

      // The fault is written down with its code — never the message, which can carry a path.
      expect(repository.recordThumbnailSweepFault).toHaveBeenCalledWith(
        poisoned,
        'UNSAFE_STORAGE_PATH',
      );
      // A raised stat is not an answer: nothing is settled or queued on its strength.
      expect(repository.settleThumbnailObjectRef).not.toHaveBeenCalledWith(poisoned);
      expect(repository.reclaimUnreferencedThumbnailObject).not.toHaveBeenCalledWith(poisoned);
      // The reference behind it in the same window is still examined and reclaimed.
      expect(storage.stat).toHaveBeenCalledWith(orphan);
      expect(repository.reclaimUnreferencedThumbnailObject).toHaveBeenCalledWith(orphan);
      expect(result.thumbnailReconciliation).toEqual({
        inspected: 2,
        queued: 1,
        faulted: 1,
        deferred: 0,
        wrapped: true,
      });
      // The cursor moves, and the housekeeping after the sweep runs.
      expect(repository.advanceThumbnailReconcileCursor).toHaveBeenCalledTimes(1);
      expect(repository.pruneUploadHistory).toHaveBeenCalledWith(100);
      expect(repository.pruneCourseThumbnailHistory).toHaveBeenCalledWith(100);
      expect(repository.pruneCleanupHistory).toHaveBeenCalledWith(100);
      expect(derivedRepository.pruneHistory).toHaveBeenCalledWith(100);
      expect(derivedRepository.pruneRetrievalCache).toHaveBeenCalledWith(500);
    });

    it('is recorded the same way in the track namespace, with an errno code', async () => {
      const trackKey =
        'private/v1/tenants/a1d6ca43-36eb-4e86-8e31-e4e75afab3fa/activities/4d6cc1ce-0643-4c53-b055-9df458fec594/tracks/db985aaa-b96e-4aef-871a-c99a16183439/temporary/db985aaa-b96e-4aef-871a-c99a16183439/raw';
      const denied = Object.assign(new Error('EACCES: permission denied, lstat /secret/path'), {
        code: 'EACCES',
      });
      // A second, answering reference: the store is reachable, so this is one bad reference.
      const healthy = trackKey.replace('/raw', '/normalized');
      const { dependencies, repository } = setup({
        candidates: [trackKey, healthy],
        statFailures: new Map([[trackKey, denied]]),
      });

      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );

      expect(repository.recordTrackSweepFault).toHaveBeenCalledWith(trackKey, 'EACCES');
      expect(repository.settleTrackObjectRef).not.toHaveBeenCalledWith(trackKey);
      expect(repository.settleTrackObjectRef).toHaveBeenCalledWith(healthy);
      expect(repository.reclaimUnreferencedTrackObject).not.toHaveBeenCalled();
      expect(result.trackReconciliation).toMatchObject({ inspected: 2, faulted: 1, queued: 0 });
    });

    it('records an error without a usable code under a generic one', async () => {
      const { dependencies, repository } = setup({
        thumbnailCandidates: [poisoned, orphan],
        statFailures: new Map([[poisoned, new Error('no code at all')]]),
      });
      await runResourceCleanupWorker({ connectionString, storageRoot }, dependencies);
      expect(repository.recordThumbnailSweepFault).toHaveBeenCalledWith(
        poisoned,
        'OBJECT_STAT_FAILED',
      );
    });

    it('ends the run before reading any window when the store itself does not answer', async () => {
      // Asked on every run, never backed off, and not a reference's fault: nothing is read
      // and nothing is recorded, so the references are not delayed once the store is back.
      const missing = Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
      const { dependencies, repository, storage } = setup({
        leased: lease,
        candidates: [orphan],
        thumbnailCandidates: [poisoned],
        storeDown: missing,
      });
      await expect(
        runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
      ).rejects.toBe(missing);
      expect(repository.reconcileWindow).not.toHaveBeenCalled();
      expect(repository.thumbnailReconcileWindow).not.toHaveBeenCalled();
      expect(storage.stat).not.toHaveBeenCalled();
      expect(repository.recordTrackSweepFault).not.toHaveBeenCalled();
      expect(repository.recordThumbnailSweepFault).not.toHaveBeenCalled();
      expect(repository.advanceReconcileCursor).not.toHaveBeenCalled();
      expect(repository.pruneUploadHistory).not.toHaveBeenCalled();
      expect(repository.close).toHaveBeenCalledTimes(1);
    });

    it('asks whether the store answers on every run, whatever the window holds', async () => {
      // Even a window of nothing but deferred references — the state a lasting outage leaves
      // behind — is preceded by the check, so the outage keeps failing runs.
      const down = Object.assign(new Error('EIO'), { code: 'EIO' });
      const { dependencies, storage } = setup({
        thumbnailCandidates: [poisoned],
        windowFaults: new Map([[poisoned, { sweepAttempts: 3, deferred: true }]]),
        storeDown: down,
      });
      await expect(
        runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
      ).rejects.toBe(down);
      expect(storage.assertReachable).toHaveBeenCalledTimes(1);
    });

    it('ends the run with the first error when every reference asked raised — the store is down', async () => {
      // Per-reference isolation must not turn a dead store into a successful run with
      // `faulted: N`. Each fault is still recorded first, so the next run defers them and the
      // window cannot stall for good; but this run fails, as it did before M2-01n.
      const other = Object.assign(new Error('EIO'), { code: 'EIO' });
      const { dependencies, repository } = setup({
        leased: lease,
        thumbnailCandidates: [poisoned, orphan],
        statFailures: new Map([
          [poisoned, unsafe],
          [orphan, other],
        ]),
      });
      await expect(
        runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
      ).rejects.toBe(unsafe);
      expect(repository.recordThumbnailSweepFault).toHaveBeenCalledWith(
        poisoned,
        'UNSAFE_STORAGE_PATH',
      );
      expect(repository.recordThumbnailSweepFault).toHaveBeenCalledWith(orphan, 'EIO');
      expect(repository.advanceThumbnailReconcileCursor).not.toHaveBeenCalled();
      expect(repository.pruneUploadHistory).not.toHaveBeenCalled();
      expect(repository.close).toHaveBeenCalledTimes(1);
    });

    it('counts only references actually asked: deferred ones neither rescue nor sink a run', async () => {
      // One deferred reference plus one that raises: the only reference asked raised.
      const { dependencies: failing } = setup({
        thumbnailCandidates: [poisoned, orphan],
        statFailures: new Map([[orphan, unsafe]]),
        windowFaults: new Map([[poisoned, { sweepAttempts: 2, deferred: true }]]),
      });
      await expect(
        runResourceCleanupWorker({ connectionString, storageRoot }, failing),
      ).rejects.toBe(unsafe);
      // A window of nothing but deferred references asked nothing, so it is not an outage.
      const { dependencies: resting } = setup({
        thumbnailCandidates: [poisoned],
        windowFaults: new Map([[poisoned, { sweepAttempts: 2, deferred: true }]]),
      });
      await expect(
        runResourceCleanupWorker({ connectionString, storageRoot }, resting),
      ).resolves.toMatchObject({ thumbnailReconciliation: { deferred: 1, faulted: 0 } });
    });

    it('still ends the run with the original error when the fault cannot be recorded', async () => {
      // No watched row to record against: the error has nowhere to go, so it is not hidden.
      const { dependencies, repository } = setup({
        thumbnailCandidates: [poisoned, orphan],
        statFailures: new Map([[poisoned, unsafe]]),
        recordFault: async () => null,
      });
      await expect(
        runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
      ).rejects.toBe(unsafe);
      expect(repository.advanceThumbnailReconcileCursor).not.toHaveBeenCalled();
      expect(repository.pruneUploadHistory).not.toHaveBeenCalled();
      expect(repository.close).toHaveBeenCalledTimes(1);
    });

    it('still ends the run when the database refuses to record the fault', async () => {
      const refused = new Error('connection terminated');
      const { dependencies, repository } = setup({
        thumbnailCandidates: [poisoned],
        statFailures: new Map([[poisoned, unsafe]]),
        recordFault: async () => Promise.reject(refused),
      });
      await expect(
        runResourceCleanupWorker({ connectionString, storageRoot }, dependencies),
      ).rejects.toBe(refused);
      expect(repository.advanceThumbnailReconcileCursor).not.toHaveBeenCalled();
    });

    it('is not asked again while its backoff runs, and costs no statement at all', async () => {
      const { dependencies, repository, storage } = setup({
        thumbnailCandidates: [poisoned],
        windowFaults: new Map([[poisoned, { sweepAttempts: 3, deferred: true }]]),
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(storage.stat).not.toHaveBeenCalledWith(poisoned);
      expect(repository.recordThumbnailSweepFault).not.toHaveBeenCalled();
      expect(repository.settleThumbnailObjectRef).not.toHaveBeenCalled();
      expect(repository.reclaimUnreferencedThumbnailObject).not.toHaveBeenCalled();
      expect(repository.clearThumbnailSweepFault).not.toHaveBeenCalled();
      expect(result.thumbnailReconciliation).toMatchObject({ inspected: 1, deferred: 1 });
    });

    it('is handled like any reference once its stat answers again, and only then cleared', async () => {
      const { dependencies, repository } = setup({
        thumbnailCandidates: [orphan],
        thumbnailStatResult: { key: orphan, sizeBytes: 298, modifiedAt: new Date(0) },
        thumbnailReclaimQueued: true,
        windowFaults: new Map([[orphan, { sweepAttempts: 12, deferred: false }]]),
      });
      await runResourceCleanupWorker({ connectionString, storageRoot }, dependencies);
      expect(repository.reclaimUnreferencedThumbnailObject).toHaveBeenCalledWith(orphan);
      expect(repository.clearThumbnailSweepFault).toHaveBeenCalledWith(orphan);
      const reclaimed = vi.mocked(repository.reclaimUnreferencedThumbnailObject).mock
        .invocationCallOrder[0];
      const cleared = vi.mocked(repository.clearThumbnailSweepFault).mock.invocationCallOrder[0];
      expect(reclaimed).toBeLessThan(cleared ?? 0);
    });

    it('clears nothing for a reference that had no fault on record', async () => {
      const { dependencies, repository } = setup({
        thumbnailCandidates: [orphan],
        thumbnailStatResult: null,
      });
      await runResourceCleanupWorker({ connectionString, storageRoot }, dependencies);
      expect(repository.clearThumbnailSweepFault).not.toHaveBeenCalled();
    });
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

  describe('an erased tenant’s prefix purge (M2-01x)', () => {
    const erased = 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa';
    const purgeLease: TenantObjectPurgeLease = { tenantId: erased, attempts: 1 };
    const keyOf = (tenantPart: string, hex: string) =>
      `private/v1/tenants/${tenantPart}/courses/4d6cc1ce-0643-4c53-b055-9df458fec594/thumbnails/temporary/db985aaa-b96e-4aef-871a-c99a16183${hex}` as never;
    const first = keyOf(erased, '439');
    const second = keyOf(erased, '43a');
    const listing = (...keys: never[]): TenantObjectListing => ({
      keys,
      unrecognized: 0,
      truncated: false,
    });

    it('deletes every listed key of the leased tenant through the guarded delete, then passes', async () => {
      const { dependencies, repository, deleteObject, storage } = setup({
        purgeLease,
        tenantListings: [listing(first, second), listing()],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.tenantPurges).toEqual(['passed', 'empty']);
      expect(storage.listTenantObjects).toHaveBeenCalledWith(erased, 100);
      expect(deleteObject.mock.calls).toEqual([[first], [second]]);
      expect(repository.finishTenantObjectPurge).toHaveBeenCalledWith(purgeLease, {
        ok: true,
        purged: 2,
        unrecognized: 0,
        more: false,
      });
    });

    it('does nothing at all when no purge is due', async () => {
      const { dependencies, repository, storage } = setup({});
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.tenantPurges).toEqual(['empty']);
      expect(storage.listTenantObjects).not.toHaveBeenCalled();
      expect(repository.finishTenantObjectPurge).not.toHaveBeenCalled();
    });

    it('stops before deleting anything when a listing names a key outside the tenant’s directory', async () => {
      // `…/tenants/<erased>0/…` starts with the tenant id but is another directory: the
      // boundary is the separator after the id, not the id's characters.
      const lookalike = keyOf(`${erased}0`, '43b');
      const { dependencies, repository, deleteObject } = setup({
        purgeLease,
        tenantListings: [listing(first, lookalike)],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.tenantPurges).toEqual(['retry_scheduled']);
      expect(deleteObject).not.toHaveBeenCalled();
      expect(repository.finishTenantObjectPurge).toHaveBeenCalledWith(purgeLease, {
        ok: false,
        errorCode: 'FOREIGN_KEY_LISTED',
        purged: 0,
      });
    });

    it('stops at the first failed delete and records its code instead of going on to the next key', async () => {
      const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
      const { dependencies, repository, deleteObject } = setup({
        purgeLease,
        deleteFailure: unsafe,
        tenantListings: [listing(first, second)],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.tenantPurges).toEqual(['retry_scheduled']);
      expect(deleteObject.mock.calls).toEqual([[first]]);
      expect(repository.finishTenantObjectPurge).toHaveBeenCalledWith(purgeLease, {
        ok: false,
        errorCode: 'UNSAFE_STORAGE_PATH',
        purged: 0,
      });
    });

    it('treats a key another deleter removed first as gone only when stat says so', async () => {
      const gone = Object.assign(new Error('unlink'), { code: 'ENOENT' });
      const { dependencies, repository, storage } = setup({
        purgeLease,
        deleteFailure: gone,
        statResult: null,
        tenantListings: [listing(first), listing()],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.tenantPurges).toEqual(['passed', 'empty']);
      expect(storage.stat).toHaveBeenCalledWith(first);
      expect(repository.finishTenantObjectPurge).toHaveBeenCalledWith(purgeLease, {
        ok: true,
        purged: 1,
        unrecognized: 0,
        more: false,
      });

      const still = setup({
        purgeLease,
        deleteFailure: gone,
        statResult: { key: first, sizeBytes: 1, modifiedAt: new Date(0) },
        tenantListings: [listing(first)],
      });
      const failed = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        still.dependencies,
      );
      expect(failed.tenantPurges).toEqual(['retry_scheduled']);
      expect(still.repository.finishTenantObjectPurge).toHaveBeenCalledWith(purgeLease, {
        ok: false,
        errorCode: 'ENOENT',
        purged: 0,
      });
    });

    describe('several runs per invocation (M2-01z)', () => {
      const tenantAt = (index: number) =>
        `a1d6ca43-36eb-4e86-8e31-${index.toString(16).padStart(12, '0')}`;

      it('runs at most ten leased purges, one after another, when more are due', async () => {
        const leases = Array.from({ length: 12 }, (_, index) => ({
          tenantId: tenantAt(index),
          attempts: 1,
        }));
        const { dependencies, repository } = setup({ purgeLeases: leases });
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.tenantPurges).toEqual(Array.from({ length: 10 }, () => 'passed'));
        expect(repository.leaseTenantObjectPurge).toHaveBeenCalledTimes(10);
        // Each run finished its own lease before the next was taken.
        const leaseOrder = vi.mocked(repository.leaseTenantObjectPurge).mock.invocationCallOrder;
        const finishOrder = vi.mocked(repository.finishTenantObjectPurge).mock.invocationCallOrder;
        for (let run = 0; run < 10; run += 1) {
          expect(finishOrder[run]).toBeGreaterThan(leaseOrder[run] ?? Infinity);
          if (run < 9) expect(leaseOrder[run + 1]).toBeGreaterThan(finishOrder[run] ?? Infinity);
        }
        expect(repository.finishTenantObjectPurge).toHaveBeenLastCalledWith(leases[9], {
          ok: true,
          purged: 0,
          unrecognized: 0,
          more: false,
        });
      });

      it('stops the batch at the first run that failed and leases nothing after it', async () => {
        const failing = tenantAt(1);
        const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
        const { dependencies, repository, deleteObject } = setup({
          purgeLeases: [0, 1, 2].map((index) => ({ tenantId: tenantAt(index), attempts: 1 })),
          deleteFailure: unsafe,
          tenantListings: [listing(), listing(keyOf(failing, '439'))],
        });
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.tenantPurges).toEqual(['passed', 'retry_scheduled']);
        expect(repository.leaseTenantObjectPurge).toHaveBeenCalledTimes(2);
        expect(deleteObject).toHaveBeenCalledTimes(1);
      });

      it('stops the batch at a lost lease', async () => {
        const { dependencies, repository } = setup({
          purgeLeases: [0, 1].map((index) => ({ tenantId: tenantAt(index), attempts: 1 })),
        });
        vi.mocked(repository.finishTenantObjectPurge).mockResolvedValueOnce(false);
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.tenantPurges).toEqual(['lease_lost']);
        expect(repository.leaseTenantObjectPurge).toHaveBeenCalledTimes(1);
      });

      it('keeps each run’s own delete budget: a run that used it is due again in the same batch', async () => {
        const keys = Array.from({ length: 100 }, (_, index) =>
          keyOf(erased, index.toString(16).padStart(3, '0')),
        );
        const { dependencies, repository, deleteObject } = setup({
          purgeLeases: [purgeLease, purgeLease, purgeLease],
          // Three full listings for the first run (budget 200: 100 + 100, then stop), one for
          // the second, then nothing left.
          tenantListings: [
            listing(...keys),
            listing(...keys),
            listing(...keys.slice(0, 5)),
            listing(),
          ],
        });
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.tenantPurges).toEqual(['continuing', 'passed', 'passed', 'empty']);
        expect(deleteObject).toHaveBeenCalledTimes(205);
        expect(repository.finishTenantObjectPurge).toHaveBeenNthCalledWith(1, purgeLease, {
          ok: true,
          purged: 200,
          unrecognized: 0,
          more: true,
        });
        expect(repository.finishTenantObjectPurge).toHaveBeenNthCalledWith(2, purgeLease, {
          ok: true,
          purged: 5,
          unrecognized: 0,
          more: false,
        });
      });
    });
  });
  describe('a deleted activity’s or reclaimed course’s prefix purge (M2-01y)', () => {
    const tenant = 'a1d6ca43-36eb-4e86-8e31-e4e75afab3fa';
    const activity = '4d6cc1ce-0643-4c53-b055-9df458fec594';
    const course = '5e7dd2df-1754-4d64-a166-0ae569e1a5a5';
    const activityLease: ObjectScopePurgeLease = {
      scope: { kind: 'activity', tenantId: tenant, activityId: activity },
      attempts: 1,
    };
    const courseLease: ObjectScopePurgeLease = {
      scope: { kind: 'course', tenantId: tenant, courseId: course },
      attempts: 1,
    };
    const trackKey = (tenantPart: string, activityPart: string, hex: string) =>
      `private/v1/tenants/${tenantPart}/activities/${activityPart}/tracks/db985aaa-b96e-4aef-871a-c99a16183439/temporary/db985aaa-b96e-4aef-871a-c99a16183${hex}/raw` as never;
    const first = trackKey(tenant, activity, '439');
    const second = trackKey(tenant, activity, '43a');
    const listing = (...keys: never[]): TenantObjectListing => ({
      keys,
      unrecognized: 0,
      truncated: false,
    });

    it('deletes every listed key of the leased activity through the guarded delete, then passes', async () => {
      const { dependencies, repository, deleteObject, storage } = setup({
        scopePurgeLease: activityLease,
        scopeListings: [listing(first, second), listing()],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.scopePurges).toEqual(['passed', 'empty']);
      expect(storage.listScopeObjects).toHaveBeenCalledWith(activityLease.scope, 100);
      expect(deleteObject.mock.calls).toEqual([[first], [second]]);
      expect(repository.finishObjectScopePurge).toHaveBeenCalledWith(activityLease, {
        ok: true,
        purged: 2,
        unrecognized: 0,
        more: false,
      });
    });

    it('purges a reclaimed course’s pictures under the course’s own directory', async () => {
      const picture =
        `private/v1/tenants/${tenant}/courses/${course}/thumbnails/temporary/db985aaa-b96e-4aef-871a-c99a16183439` as never;
      const { dependencies, repository, deleteObject } = setup({
        scopePurgeLease: courseLease,
        scopeListings: [listing(picture), listing()],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.scopePurges).toEqual(['passed', 'empty']);
      expect(deleteObject.mock.calls).toEqual([[picture]]);
      expect(repository.finishObjectScopePurge).toHaveBeenCalledWith(courseLease, {
        ok: true,
        purged: 1,
        unrecognized: 0,
        more: false,
      });
    });

    it('stops before deleting anything when a course listing names an id that starts with the course id', async () => {
      const picture =
        `private/v1/tenants/${tenant}/courses/${course}/thumbnails/temporary/db985aaa-b96e-4aef-871a-c99a16183439` as never;
      const lookalike =
        `private/v1/tenants/${tenant}/courses/${course}0/thumbnails/temporary/db985aaa-b96e-4aef-871a-c99a16183439` as never;
      const { dependencies, repository, deleteObject } = setup({
        scopePurgeLease: courseLease,
        scopeListings: [listing(picture, lookalike)],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.scopePurges).toEqual(['retry_scheduled']);
      expect(deleteObject).not.toHaveBeenCalled();
      expect(repository.finishObjectScopePurge).toHaveBeenCalledWith(courseLease, {
        ok: false,
        errorCode: 'FOREIGN_KEY_LISTED',
        purged: 0,
      });
    });

    it('does nothing at all when no scope purge is due', async () => {
      const { dependencies, repository, storage } = setup({});
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.scopePurges).toEqual(['empty']);
      expect(storage.listScopeObjects).not.toHaveBeenCalled();
      expect(repository.finishObjectScopePurge).not.toHaveBeenCalled();
    });

    it.each([
      ['an id that starts with the activity id', trackKey(tenant, `${activity}0`, '43b')],
      [
        'a sibling activity of the same tenant',
        trackKey(tenant, 'db985aaa-b96e-4aef-871a-c99a16183439', '43b'),
      ],
      [
        'the same activity id under another tenant',
        trackKey('b1d6ca43-36eb-4e86-8e31-e4e75afab3fa', activity, '43b'),
      ],
      [
        'the tenant’s course of the same id',
        `private/v1/tenants/${tenant}/courses/${activity}/thumbnails/temporary/db985aaa-b96e-4aef-871a-c99a16183439` as never,
      ],
    ])('stops before deleting anything when a listing names %s', async (_label, foreign: never) => {
      const { dependencies, repository, deleteObject } = setup({
        scopePurgeLease: activityLease,
        scopeListings: [listing(first, foreign)],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.scopePurges).toEqual(['retry_scheduled']);
      expect(deleteObject).not.toHaveBeenCalled();
      expect(repository.finishObjectScopePurge).toHaveBeenCalledWith(activityLease, {
        ok: false,
        errorCode: 'FOREIGN_KEY_LISTED',
        purged: 0,
      });
    });

    it('stops at the first failed delete and records its code instead of going on to the next key', async () => {
      const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
      const { dependencies, repository, deleteObject } = setup({
        scopePurgeLease: activityLease,
        deleteFailure: unsafe,
        scopeListings: [listing(first, second)],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.scopePurges).toEqual(['retry_scheduled']);
      expect(deleteObject.mock.calls).toEqual([[first]]);
      expect(repository.finishObjectScopePurge).toHaveBeenCalledWith(activityLease, {
        ok: false,
        errorCode: 'UNSAFE_STORAGE_PATH',
        purged: 0,
      });
    });

    it('treats a key another deleter removed first as gone only when stat says so', async () => {
      const gone = Object.assign(new Error('unlink'), { code: 'ENOENT' });
      const { dependencies, repository, storage } = setup({
        scopePurgeLease: activityLease,
        deleteFailure: gone,
        statResult: null,
        scopeListings: [listing(first), listing()],
      });
      const result = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        dependencies,
      );
      expect(result.scopePurges).toEqual(['passed', 'empty']);
      expect(storage.stat).toHaveBeenCalledWith(first);
      expect(repository.finishObjectScopePurge).toHaveBeenCalledWith(activityLease, {
        ok: true,
        purged: 1,
        unrecognized: 0,
        more: false,
      });

      const still = setup({
        scopePurgeLease: activityLease,
        deleteFailure: gone,
        statResult: { key: first, sizeBytes: 1, modifiedAt: new Date(0) },
        scopeListings: [listing(first)],
      });
      const failed = await runResourceCleanupWorker(
        { connectionString, storageRoot },
        still.dependencies,
      );
      expect(failed.scopePurges).toEqual(['retry_scheduled']);
      expect(still.repository.finishObjectScopePurge).toHaveBeenCalledWith(activityLease, {
        ok: false,
        errorCode: 'ENOENT',
        purged: 0,
      });
    });
    describe('several runs per invocation (N4)', () => {
      const activityAt = (index: number) =>
        `4d6cc1ce-0643-4c53-b055-${index.toString(16).padStart(12, '0')}`;
      const leaseAt = (index: number): ObjectScopePurgeLease => ({
        scope: { kind: 'activity', tenantId: tenant, activityId: activityAt(index) },
        attempts: 1,
      });

      it('runs at most twenty leased scope purges, one after another, when more are due', async () => {
        const leases = Array.from({ length: 25 }, (_, index) => leaseAt(index));
        const { dependencies, repository } = setup({ scopePurgeLeases: leases });
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.scopePurges).toEqual(Array.from({ length: 20 }, () => 'passed'));
        expect(repository.leaseObjectScopePurge).toHaveBeenCalledTimes(20);
        const leaseOrder = vi.mocked(repository.leaseObjectScopePurge).mock.invocationCallOrder;
        const finishOrder = vi.mocked(repository.finishObjectScopePurge).mock.invocationCallOrder;
        for (let run = 0; run < 20; run += 1) {
          expect(finishOrder[run]).toBeGreaterThan(leaseOrder[run] ?? Infinity);
          if (run < 19) expect(leaseOrder[run + 1]).toBeGreaterThan(finishOrder[run] ?? Infinity);
        }
        expect(repository.finishObjectScopePurge).toHaveBeenLastCalledWith(leases[19], {
          ok: true,
          purged: 0,
          unrecognized: 0,
          more: false,
        });
      });

      it('stops the batch at the first failed run and leases nothing after it', async () => {
        const unsafe = Object.assign(new Error('root swapped'), { code: 'UNSAFE_STORAGE_PATH' });
        const { dependencies, repository, deleteObject } = setup({
          scopePurgeLeases: [0, 1, 2].map(leaseAt),
          deleteFailure: unsafe,
          scopeListings: [listing(), listing(trackKey(tenant, activityAt(1), '439'))],
        });
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.scopePurges).toEqual(['passed', 'retry_scheduled']);
        expect(repository.leaseObjectScopePurge).toHaveBeenCalledTimes(2);
        expect(deleteObject).toHaveBeenCalledTimes(1);
      });

      it('stops the batch at a lost lease', async () => {
        const { dependencies, repository } = setup({ scopePurgeLeases: [0, 1].map(leaseAt) });
        vi.mocked(repository.finishObjectScopePurge).mockResolvedValueOnce(false);
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.scopePurges).toEqual(['lease_lost']);
        expect(repository.leaseObjectScopePurge).toHaveBeenCalledTimes(1);
      });

      it('keeps each run’s own delete budget: a run that used it goes on in the same batch', async () => {
        const keys = Array.from({ length: 100 }, (_, index) =>
          trackKey(tenant, activity, index.toString(16).padStart(3, '0')),
        );
        const { dependencies, repository, deleteObject } = setup({
          scopePurgeLeases: [activityLease, activityLease],
          scopeListings: [
            listing(...keys),
            listing(...keys),
            listing(...keys.slice(0, 5)),
            listing(),
          ],
        });
        const result = await runResourceCleanupWorker(
          { connectionString, storageRoot },
          dependencies,
        );
        expect(result.scopePurges).toEqual(['continuing', 'passed', 'empty']);
        expect(deleteObject).toHaveBeenCalledTimes(205);
        expect(repository.finishObjectScopePurge).toHaveBeenNthCalledWith(1, activityLease, {
          ok: true,
          purged: 200,
          unrecognized: 0,
          more: true,
        });
      });
    });
  });
});
