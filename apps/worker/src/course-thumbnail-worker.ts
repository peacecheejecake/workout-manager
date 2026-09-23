import {
  createCourseThumbnailFinalObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createLocalFilesystemObjectStorage,
  type ObjectStorage,
} from '@workout/server-media';
import {
  createCourseThumbnailWorkerRepository,
  type CourseThumbnailLease,
  type CourseThumbnailWorkerRepository,
} from '@workout/server-persistence/course-thumbnails';
import {
  CourseThumbnailRenderError,
  renderCourseThumbnail,
} from '@workout/server-courses/thumbnail';

import type { CourseThumbnailWorkerConfig } from './config.js';

/**
 * Draws one stored course thumbnail per run (M2-01l, plan section 5's "parsing and
 * derivative work belongs in the worker").
 *
 * Nothing here decides policy. The database hands out the work, fences the publication and
 * refuses to make a picture current unless it is still the head's; this process turns
 * coordinates into bytes and puts them where the ledger already says they will be.
 *
 * Two rules govern the failure paths.
 *
 * **A render never fails a course save.** The save enqueued this work in its own
 * transaction and went home. Everything that can go wrong here ends as a state the read
 * model can name — pending, unavailable, retrying, abandoned — and the screen falls back to
 * drawing the line itself.
 *
 * **Nothing is logged about the line.** No coordinate, no course name, no object key and no
 * storage path appears in any event this worker emits. The outcome and the tenant-free job
 * identity are the whole story.
 */
export type CourseThumbnailWorkerResult =
  'empty' | 'ready' | 'superseded' | 'unavailable' | 'failed' | 'released' | 'lease_lost';

export interface ClosableObjectStorage extends ObjectStorage {
  close?(): Promise<void>;
}

export interface CourseThumbnailWorkerDependencies {
  createStorage(rootDirectory: string): Promise<ClosableObjectStorage>;
  createRepository(options: {
    connectionString: string;
    workerId?: string;
  }): CourseThumbnailWorkerRepository;
  logger?: (event: {
    event: 'course_thumbnail_render_finished';
    result: CourseThumbnailWorkerResult;
  }) => void;
  /**
   * Fired when the process is asked to stop. A render that has not yet recorded an object
   * reference hands its lease straight back, so a restart does not hold the work for the
   * lease's whole term and does not spend one of its five attempts.
   *
   * It cannot interrupt a storage call already in flight: the object port has no
   * cancellation, and neither has this one been given a wall-clock budget of its own. What
   * bounds a render instead is the size of what it writes — one document of at most 64 KiB,
   * to the same object store the rest of this product writes to — and the database's own
   * `statement_timeout`/`lock_timeout` on every call it makes. A real deadline belongs with
   * a cancellable object port; it is recorded as a limitation rather than faked here.
   */
  shutdownSignal?: AbortSignal;
}

class LeaseLostError extends Error {
  constructor() {
    super('COURSE_THUMBNAIL_LEASE_LOST');
    this.name = 'LeaseLostError';
  }
}

/** The ledger's recorded temporary name is not the one this render would write. */
class RefMismatchError extends Error {
  constructor() {
    super('COURSE_THUMBNAIL_REF_MISMATCH');
    this.name = 'RefMismatchError';
  }
}

function oneChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield value;
  })();
}

const defaultDependencies: CourseThumbnailWorkerDependencies = {
  createStorage: createLocalFilesystemObjectStorage,
  createRepository: createCourseThumbnailWorkerRepository,
};

async function renderOne(
  lease: CourseThumbnailLease,
  repository: CourseThumbnailWorkerRepository,
  storage: ClosableObjectStorage,
  shutdownSignal?: AbortSignal,
): Promise<CourseThumbnailWorkerResult> {
  let published = false;
  let committed = false;
  const temporaryKey = createCourseThumbnailTemporaryObjectKey({
    tenantId: lease.athleteId,
    courseId: lease.courseId,
    jobId: lease.jobId,
  });
  try {
    // The ledger recorded this name before the object could exist. If the two disagree, the
    // row is not describing this render and nothing may be written under either name. This
    // is inside the guarded path on purpose: thrown out of it, the render would end with no
    // durable state at all, and "every failure ends as a state the read model can name"
    // would be false for the one failure that means the ledger and the code disagree.
    if (lease.temporaryRef !== temporaryKey) throw new RefMismatchError();
    let drawn;
    try {
      drawn = renderCourseThumbnail(lease.coordinates);
    } catch (error) {
      if (!(error instanceof CourseThumbnailRenderError)) throw error;
      // A permanent answer, recorded as one. Retrying an unchanged immutable revision
      // would refuse again every time.
      return (await repository.markUnavailable(lease, error.code)) ? 'unavailable' : 'lease_lost';
    }
    const finalKey = createCourseThumbnailFinalObjectKey({
      tenantId: lease.athleteId,
      courseId: lease.courseId,
      revisionId: lease.revisionId,
      sha256: drawn.sha256,
    });
    // A previous attempt under this same job may have left its temporary object behind;
    // the store refuses to overwrite one, so the retry clears its own name first.
    await storage.delete(temporaryKey).catch(() => undefined);
    await storage.writeTemporary(temporaryKey, oneChunk(drawn.bytes));
    // The last point at which stopping is free: no object reference is recorded yet, so the
    // temporary name can be cleared and the lease and its attempt handed back. Past
    // `prepare` the row owns a final name and unwinding it belongs to the reaper.
    if (shutdownSignal?.aborted === true) {
      await storage.delete(temporaryKey).catch(() => undefined);
      return (await repository.release(lease)) ? 'released' : 'lease_lost';
    }
    if (
      !(await repository.prepare(lease, {
        storageRef: finalKey,
        sha256: drawn.sha256,
        byteSize: drawn.byteSize,
        vertexCount: drawn.vertexCount,
      }))
    )
      throw new LeaseLostError();
    // Asked immediately before the object becomes visible: a render that stalled past its
    // fence stops here rather than creating an object the manifest already accounted for.
    if (!(await repository.publicationFenceOpen(lease))) throw new LeaseLostError();
    await storage.publishTemporary(temporaryKey, finalKey, {
      sha256: drawn.sha256,
      sizeBytes: drawn.byteSize,
    });
    published = true;
    const outcome = await repository.finalize(lease);
    if (outcome === 'ready') {
      committed = true;
      return 'ready';
    }
    // The course moved on while we drew. The picture is of a line that is no longer the
    // head's, so it is given straight back to the manifest instead of being kept.
    await repository.requeueRefs(lease);
    committed = true;
    return outcome === 'superseded' ? 'superseded' : 'lease_lost';
  } catch (error) {
    await storage.delete(temporaryKey).catch(() => undefined);
    if (error instanceof LeaseLostError) {
      if (published) await repository.requeueRefs(lease);
      return 'lease_lost';
    }
    // A mismatch between the ledger and the code will read the same on every attempt, so
    // it is recorded once and not retried; anything else gets its bounded retries.
    const permanent = error instanceof RefMismatchError;
    const recorded = await repository.fail(
      lease,
      permanent ? 'RENDER_REF_MISMATCH' : 'RENDER_FAILED',
      permanent ? { retryable: false } : { retryable: true, retryAfterSeconds: 60 },
    );
    if (published && !committed) await repository.requeueRefs(lease);
    return recorded ? 'failed' : 'lease_lost';
  }
}

/** Runs exactly one bounded render and always releases the database pool. */
export async function runCourseThumbnailWorker(
  config: CourseThumbnailWorkerConfig,
  overrides: Partial<CourseThumbnailWorkerDependencies> = {},
): Promise<CourseThumbnailWorkerResult> {
  const dependencies = { ...defaultDependencies, ...overrides };
  const storage = await dependencies.createStorage(config.storageRoot);
  const repository = dependencies.createRepository({ connectionString: config.connectionString });
  let result: CourseThumbnailWorkerResult = 'empty';
  try {
    const lease = await repository.lease();
    if (lease === null) {
      dependencies.logger?.({ event: 'course_thumbnail_render_finished', result });
      return result;
    }
    // Asked to stop before any work began: give the lease back rather than hold it for its
    // whole term, and give the attempt back with it.
    if (dependencies.shutdownSignal?.aborted === true && (await repository.release(lease))) {
      result = 'released';
      dependencies.logger?.({ event: 'course_thumbnail_render_finished', result });
      return result;
    }
    result = await renderOne(lease, repository, storage, dependencies.shutdownSignal);
    dependencies.logger?.({ event: 'course_thumbnail_render_finished', result });
    return result;
  } finally {
    await repository.close();
    await storage.close?.();
  }
}
