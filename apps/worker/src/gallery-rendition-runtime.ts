import { createHash } from 'node:crypto';

import type { GalleryCodecSupervisorCode } from '@workout/server-media/gallery-codec-supervisor';
import {
  createGalleryRenditionFinalObjectKey,
  createGalleryRenditionTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
} from '@workout/server-media/keys';
import type { ObjectScopeEnumeration, ObjectStorage } from '@workout/server-media/object-storage';
import type {
  GalleryRenditionReleaseCode,
  GalleryRenditionWorkerStore,
} from '@workout/server-persistence/gallery-renditions';

import {
  runOneGalleryRenditionJob,
  type GalleryRenditionClock,
  type GalleryRenditionLease,
  type GalleryRenditionReleaseOutcome,
  type GalleryRenditionWorkerDependencies,
  type GalleryRenditionWorkerResult,
} from './gallery-rendition-worker.js';

/**
 * Composition of the bounded rendition worker (M2-03c): SQL144 store, private object storage
 * and the supervised codec. One call processes at most one job or one sweep. The original is
 * only read; derivatives are written under the job/lease rendition namespace and published
 * before the receipt transaction, which is the only place a derivative becomes visible.
 */
export interface GalleryRenditionRuntimeDependencies {
  store: Pick<
    GalleryRenditionWorkerStore,
    'claim' | 'settle' | 'release' | 'claimSweep' | 'finishSweep'
  >;
  storage: ObjectStorage & ObjectScopeEnumeration;
  codec: GalleryRenditionWorkerDependencies['codec'];
  clock: GalleryRenditionClock;
  workerId: string;
  /** Wall budget of one job, at most 30 s and well below the store lease. */
  deadlineMs: number;
  signal?: AbortSignal;
}

const SCOPE_LIST_LIMIT = 1000;
const TERMINAL_CODEC_CODES = [
  'unsupported_format',
  'unsupported_pages',
  'input_invalid',
  'input_budget',
  'pixel_budget',
  'invalid_media',
  'decode_failed',
  'output_budget',
] as const satisfies readonly GalleryCodecSupervisorCode[];

/** Maps a worker outcome to the finite store code; only codec facts may end a job for good. */
export function galleryRenditionReleaseCode(
  outcome: GalleryRenditionReleaseOutcome,
): GalleryRenditionReleaseCode {
  const code = outcome.codecCode;
  if (outcome.reason === 'codec_invalid') {
    const terminal = TERMINAL_CODEC_CODES.find((candidate) => candidate === code);
    if (terminal) return terminal;
    if (code === 'timeout' || code === 'aborted' || code === 'codec_unavailable') return code;
    return 'transient';
  }
  if (outcome.reason === 'deadline') return 'timeout';
  if (outcome.reason === 'aborted') return 'aborted';
  return 'transient';
}

async function readBounded(body: AsyncIterable<Uint8Array>, size: number): Promise<Uint8Array> {
  const result = new Uint8Array(size);
  let offset = 0;
  for await (const chunk of body) {
    if (offset + chunk.byteLength > size) throw new Error('original_size_mismatch');
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== size) throw new Error('original_size_mismatch');
  return result;
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export function createGalleryRenditionRuntime(d: GalleryRenditionRuntimeDependencies) {
  // Original references come from the same claim transaction; they never leave this process.
  const originals = new Map<string, { token: string; storageRef: string }>();

  function renditionKeys(lease: GalleryRenditionLease, sha256?: string) {
    const base = {
      tenantId: lease.job.athleteId,
      mediaItemId: lease.job.mediaId,
      renditionKind: lease.job.kind,
      jobId: lease.job.id,
      attemptId: lease.token,
      recipeVersion: 1 as const,
    };
    return {
      temporary: createGalleryRenditionTemporaryObjectKey(base),
      final:
        sha256 === undefined
          ? undefined
          : createGalleryRenditionFinalObjectKey({
              ...base,
              sha256,
              extension: lease.job.kind === 'video_playback' ? 'mp4' : 'webp',
            }),
    };
  }

  /** Deletes rendition keys of one media item, optionally only one job/lease attempt. */
  async function deleteRenditionKeys(
    tenantId: string,
    mediaItemId: string,
    attempt: { jobId: string; attemptId: string } | null,
  ): Promise<{ deleted: number; complete: boolean }> {
    const listing = await d.storage.listScopeObjects(
      { kind: 'gallery', tenantId, mediaItemId },
      SCOPE_LIST_LIMIT,
    );
    let deleted = 0;
    for (const key of listing.keys) {
      const parsed = parseObjectKey(key);
      if (parsed.kind !== 'gallery_rendition' && parsed.kind !== 'gallery_rendition_temporary')
        continue;
      if (parsed.tenantId !== tenantId || parsed.mediaItemId !== mediaItemId) continue;
      if (attempt && (parsed.jobId !== attempt.jobId || parsed.attemptId !== attempt.attemptId))
        continue;
      await d.storage.delete(key);
      deleted++;
    }
    return { deleted, complete: !listing.truncated };
  }

  const dependencies: GalleryRenditionWorkerDependencies = {
    workerId: d.workerId,
    deadlineMs: d.deadlineMs,
    clock: d.clock,
    codec: d.codec,
    ...(d.signal ? { signal: d.signal } : {}),
    repository: {
      async claimLease(workerId) {
        const claim = await d.store.claim(workerId);
        if (claim === null) return { state: 'no_job' };
        originals.set(claim.jobId, {
          token: claim.leaseToken,
          storageRef: claim.originalStorageRef,
        });
        return {
          state: 'job',
          token: claim.leaseToken,
          expiresAtMs: Date.parse(claim.leaseUntil),
          job: {
            version: 1,
            id: claim.jobId,
            athleteId: claim.athleteId,
            mediaId: claim.mediaItemId,
            expectedAccessRevision: claim.parentAccessRevision,
            sourceSha256: claim.sourceSha256,
            sourceByteSize: claim.sourceByteSize,
            kind: claim.kind,
            recipeVersion: 1,
            idempotencyKey: claim.idempotencyKey,
          },
        };
      },
      async settle({ lease, rendition }) {
        const { final } = renditionKeys(lease, rendition.output.sha256);
        if (final === undefined) throw new Error('stage_invalid');
        const reply = await d.store.settle({
          athleteId: lease.job.athleteId,
          jobId: lease.job.id,
          leaseToken: lease.token,
          output: {
            storageRef: final,
            sha256: rendition.output.sha256,
            byteSize: rendition.output.byteSize,
            mediaType: rendition.output.mediaType,
            width: rendition.output.width,
            height: rendition.output.height,
            durationSeconds:
              rendition.output.mediaType === 'video/mp4' ? rendition.output.durationSeconds : null,
          },
        });
        if (reply.state === 'ready') originals.delete(lease.job.id);
        return reply;
      },
      async release(lease, outcome) {
        originals.delete(lease.job.id);
        await d.store.release({
          athleteId: lease.job.athleteId,
          jobId: lease.job.id,
          leaseToken: lease.token,
          code: galleryRenditionReleaseCode(outcome),
        });
        return { state: 'released' };
      },
    },
    storage: {
      async readOriginal(job, signal) {
        const original = originals.get(job.id);
        if (!original || signal.aborted) throw new Error('original_unavailable');
        const key = validateObjectKey(original.storageRef);
        const parsed = parseObjectKey(key);
        if (
          parsed.kind !== 'gallery_final' ||
          parsed.tenantId !== job.athleteId ||
          parsed.mediaItemId !== job.mediaId ||
          parsed.sha256 !== job.sourceSha256
        )
          throw new Error('original_lineage_mismatch');
        const opened = await d.storage.open(key);
        if (opened === null || opened.sizeBytes !== job.sourceByteSize)
          throw new Error('original_unavailable');
        const bytes = await readBounded(opened.body, job.sourceByteSize);
        if (createHash('sha256').update(bytes).digest('hex') !== job.sourceSha256)
          throw new Error('original_integrity');
        return bytes;
      },
      async stagePrivate({ stageId, lease, rendition, signal }) {
        if (signal.aborted) throw new Error('aborted');
        const keys = renditionKeys(lease, rendition.output.sha256);
        if (keys.final === undefined) throw new Error('stage_invalid');
        await d.storage.writeTemporary(keys.temporary, once(rendition.output.bytes));
        const published = await d.storage.publishTemporary(keys.temporary, keys.final, {
          sizeBytes: rendition.output.byteSize,
          sha256: rendition.output.sha256,
        });
        return { stageId, sha256: published.sha256, byteSize: published.sizeBytes };
      },
      async cleanup(_stageId, lease) {
        const result = await deleteRenditionKeys(lease.job.athleteId, lease.job.mediaId, {
          jobId: lease.job.id,
          attemptId: lease.token,
        });
        return { state: result.complete ? 'cleaned' : 'incomplete' };
      },
    },
  };

  return {
    runJob(): Promise<GalleryRenditionWorkerResult> {
      return runOneGalleryRenditionJob(dependencies);
    },
    /** One delayed sweep of a retired item or an abandoned lease. Never touches originals. */
    async runSweep(): Promise<
      { state: 'no_sweep' } | { state: 'swept'; deleted: number; complete: boolean }
    > {
      const sweep = await d.store.claimSweep(d.workerId);
      if (sweep === null) return { state: 'no_sweep' };
      let result: { deleted: number; complete: boolean };
      try {
        result = await deleteRenditionKeys(
          sweep.athleteId,
          sweep.mediaItemId,
          sweep.jobId !== null && sweep.attemptId !== null
            ? { jobId: sweep.jobId, attemptId: sweep.attemptId }
            : null,
        );
      } catch (error) {
        await d.store.finishSweep(sweep.sweepId, d.workerId, false);
        throw error;
      }
      await d.store.finishSweep(sweep.sweepId, d.workerId, result.complete);
      return { state: 'swept', ...result };
    },
  };
}
