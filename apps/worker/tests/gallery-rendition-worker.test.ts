import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  parseGalleryCodecResultMetadata,
  GalleryCodecSupervisorError,
  type GalleryCodecSupervision,
} from '@workout/server-media/gallery-codec-supervisor';
import {
  parseGalleryRenditionJobV1,
  runOneGalleryRenditionJob,
  type GalleryRenditionWorkerDependencies,
} from '../src/gallery-rendition-worker.js';

const id = '11111111-1111-1111-1111-111111111111';
const boundStageId = `gallery-rendition-v1:${id}:44444444-4444-4444-4444-444444444444`;
const source = Uint8Array.from([1, 2, 3]);
const output = Uint8Array.from([4, 5]);
const hash = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const job = {
  version: 1,
  id,
  athleteId: '22222222-2222-2222-2222-222222222222',
  mediaId: '33333333-3333-3333-3333-333333333333',
  expectedAccessRevision: 3,
  sourceSha256: hash(source),
  sourceByteSize: 3,
  kind: 'image_preview',
  recipeVersion: 1,
  idempotencyKey: 'gallery:rendition:stable-1',
};
const metadata = {
  recipeVersion: 1,
  kind: 'image_preview',
  original: { sha256: hash(source), byteSize: 3 },
  sourceObservation: {
    format: 'jpeg',
    width: 10,
    height: 10,
    orientation: null,
    pages: 1,
    orientedWidth: 10,
    orientedHeight: 10,
  },
  output: {
    mediaType: 'image/webp',
    sha256: hash(output),
    byteSize: 2,
    width: 10,
    height: 10,
  },
  build: { sharp: '0.35.4', vips: '8.18.0' },
};
const supervision: GalleryCodecSupervision = {
  childReady: true,
  codecStarted: true,
  cancellationReceived: false,
  settlementAcknowledged: true,
  childClosed: true,
  childExitCode: 0,
  childExitSignal: null,
  terminationRequested: null,
  workspaceCleaned: true,
  workspaceRetained: false,
  elapsedMs: 1,
  stopReason: null,
  memoryLimit: 'not_enforced',
  diskHardLimit: 'not_enforced',
  networkIsolation: 'not_enforced',
  descendantEnforcement: 'codec_acknowledgement_only',
};
function setup() {
  let timer: (() => void) | undefined;
  let now = 100;
  const claim = vi.fn(async (): Promise<unknown> => ({
    state: 'job',
    token: '44444444-4444-4444-4444-444444444444',
    expiresAtMs: 1000,
    job,
  }));
  const read = vi.fn(async (): Promise<unknown> => source);
  const render = vi.fn(async () => ({
    result: parseGalleryCodecResultMetadata(metadata, output),
    supervision,
  }));
  const stage = vi.fn(async (): Promise<unknown> => ({
    stageId: boundStageId,
    sha256: hash(output),
    byteSize: 2,
  }));
  const settle = vi.fn(async (): Promise<unknown> => ({ state: 'ready' }));
  const release = vi.fn(async (_lease: unknown, _outcome: unknown): Promise<unknown> => ({
    state: 'released',
  }));
  const cleanup = vi.fn(async (): Promise<unknown> => ({ state: 'cleaned' }));
  const cancel = vi.fn();
  const dependencies: GalleryRenditionWorkerDependencies = {
    workerId: id,
    deadlineMs: 30000,
    repository: { claimLease: claim, settle, release },
    storage: { readOriginal: read, stagePrivate: stage, cleanup },
    codec: { render },
    clock: {
      nowMs: () => now,
      schedule: (_ms, cb) => {
        timer = cb;
        return cancel;
      },
    },
  };
  return {
    dependencies,
    claim,
    read,
    render,
    stage,
    settle,
    release,
    cleanup,
    cancel,
    timeout: () => timer?.(),
    expire: () => {
      now = 1000;
    },
  };
}
describe('Gallery rendition immutable job boundary', () => {
  it('copies and freezes exact V1 job with a stable key', () => {
    const parsed = parseGalleryRenditionJobV1(job);
    expect(parsed).toEqual(job);
    expect(parsed).not.toBe(job);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
  it.each([
    null,
    [],
    { ...job, extra: true },
    { ...job, version: 2 },
    { ...job, recipeVersion: 2 },
    { ...job, id: id.toUpperCase() + 'Z' },
    { ...job, athleteId: null },
    { ...job, expectedAccessRevision: 0 },
    { ...job, expectedAccessRevision: 2147483647 },
    { ...job, sourceSha256: 'z'.repeat(64) },
    { ...job, sourceByteSize: 0 },
    { ...job, sourceByteSize: 15 * 1024 * 1024 + 1 },
    { ...job, kind: 'preview' },
    { ...job, idempotencyKey: 'x'.repeat(129) },
  ])('rejects malformed job %i', (value) => {
    expect(() => parseGalleryRenditionJobV1(value)).toThrow();
  });
  it('does not invoke getters or proxy traps', () => {
    let called = 0;
    const getter = { ...job };
    Object.defineProperty(getter, 'sourceSha256', {
      enumerable: true,
      get() {
        called++;
        throw Error('secret');
      },
    });
    expect(() => parseGalleryRenditionJobV1(getter)).toThrow();
    const proxy = new Proxy(job, {
      ownKeys() {
        called++;
        return [];
      },
    });
    expect(() => parseGalleryRenditionJobV1(proxy)).toThrow();
    expect(called).toBe(0);
  });
});
describe('one-job executor', () => {
  it('binds original and exact private derivative to CAS settle', async () => {
    const x = setup();
    expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({
      state: 'ready',
    });
    expect(x.stage.mock.calls).toHaveLength(1);
    expect(x.settle.mock.calls).toHaveLength(1);
    expect(x.cleanup).not.toHaveBeenCalled();
    expect(x.release).not.toHaveBeenCalled();
    expect(x.cancel).toHaveBeenCalledOnce();
  });
  it.each(['no_job', 'completed'] as const)(
    'does not read or encode %s including successful replay',
    async (state) => {
      const x = setup();
      x.claim.mockResolvedValue({ state });
      expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({
        state,
      });
      expect(x.read).not.toHaveBeenCalled();
      expect(x.render).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed claim without codec or getter invocation', async () => {
    const x = setup();
    let called = 0;
    x.claim.mockResolvedValue(
      Object.defineProperty({}, 'state', {
        enumerable: true,
        get() {
          called++;
          return 'job';
        },
      }),
    );
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      state: 'failed',
      reason: 'invalid_input',
    });
    expect(called).toBe(0);
    expect(x.render).not.toHaveBeenCalled();
  });
  it.each([
    Uint8Array.from([1, 2]),
    Uint8Array.from([1, 2, 4]),
    new Uint8Array(new SharedArrayBuffer(3)),
  ])('rejects invalid original before codec', async (value) => {
    const x = setup();
    x.read.mockResolvedValue(value);
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      state: 'failed',
      reason: 'original_integrity',
      release: 'released',
    });
    expect(x.render).not.toHaveBeenCalled();
    expect(x.settle).not.toHaveBeenCalled();
  });
  it('rejects an own byteLength getter without evaluating it', async () => {
    const x = setup();
    let called = 0;
    const b = Uint8Array.from(source);
    Object.defineProperty(b, 'byteLength', {
      get() {
        called++;
        return 3;
      },
    });
    x.read.mockResolvedValue(b);
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'original_integrity',
    });
    expect(called).toBe(0);
  });
  it.each(['source', 'kind', 'output'] as const)(
    'rejects codec %s lineage mismatch',
    async (change) => {
      const x = setup();
      const result = parseGalleryCodecResultMetadata(metadata, output);
      if (change === 'source') result.original.sha256 = '0'.repeat(64);
      if (change === 'kind') result.kind = 'image_thumbnail';
      if (change === 'output') result.output.sha256 = '0'.repeat(64);
      x.render.mockResolvedValue({ result, supervision });
      expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
        state: 'failed',
        reason: 'codec_invalid',
        release: 'released',
      });
      expect(x.stage).not.toHaveBeenCalled();
    },
  );
  it('rejects codec metadata accessor without invoking it', async () => {
    const x = setup();
    const result = parseGalleryCodecResultMetadata(metadata, output);
    let called = 0;
    Object.defineProperty(result, 'build', {
      enumerable: true,
      get() {
        called++;
        throw Error('secret');
      },
    });
    x.render.mockResolvedValue({ result, supervision });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'codec_invalid',
    });
    expect(called).toBe(0);
  });
  it('cleans stable partial stage after write failure', async () => {
    const x = setup();
    x.stage.mockRejectedValue(Error('private path'));
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      state: 'failed',
      reason: 'stage_invalid',
      cleanup: 'cleaned',
      release: 'released',
    });
    expect(x.cleanup).toHaveBeenCalledWith(
      boundStageId,
      expect.objectContaining({
        job: expect.objectContaining({ idempotencyKey: job.idempotencyKey }),
      }),
    );
    expect(x.settle).not.toHaveBeenCalled();
  });
  it('rejects stage integrity mismatch before settle', async () => {
    const x = setup();
    x.stage.mockResolvedValue({
      stageId: boundStageId,
      sha256: '0'.repeat(64),
      byteSize: 2,
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'stage_invalid',
      cleanup: 'cleaned',
    });
    expect(x.settle).not.toHaveBeenCalled();
  });
  it.each(['lease_lost', 'stale', 'deleted', 'consent_withdrawn', 'authoring_closed'] as const)(
    'cleans explicit transactional rejection %s',
    async (reason) => {
      const x = setup();
      x.settle.mockResolvedValue({ state: 'rejected', reason });
      expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({
        state: 'rejected',
        reason,
        cleanup: 'cleaned',
        release: 'released',
      });
    },
  );
  it('retains stage and lease after ambiguous settle failure', async () => {
    const x = setup();
    x.settle.mockRejectedValue(Error('SQL private payload'));
    const result = await runOneGalleryRenditionJob(x.dependencies);
    expect(result).toEqual({
      state: 'failed',
      reason: 'settle_unknown',
      codecCode: 'not_observed',
      cleanup: 'retained_commit_unknown',
      release: 'retained_commit_unknown',
    });
    expect(x.cleanup).not.toHaveBeenCalled();
    expect(x.release).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SQL');
  });
  it('treats malformed settle response as unknown commit', async () => {
    const x = setup();
    x.settle.mockResolvedValue({ state: 'ready', extra: 'raw' });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'settle_unknown',
      codecCode: 'not_observed',
      cleanup: 'retained_commit_unknown',
    });
    expect(x.cleanup).not.toHaveBeenCalled();
  });
  it('reports cleanup and lease release uncertainty independently', async () => {
    const x = setup();
    x.stage.mockRejectedValue(Error('failure'));
    x.cleanup.mockRejectedValue(Error('failure'));
    x.release.mockResolvedValue({ state: 'unknown' });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      state: 'failed',
      cleanup: 'uncertain',
      release: 'uncertain',
    });
  });
  it('does not claim when externally aborted', async () => {
    const x = setup();
    const c = new AbortController();
    c.abort();
    x.dependencies.signal = c.signal;
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'aborted',
    });
    expect(x.claim).not.toHaveBeenCalled();
  });
  it('releases claimed lease after deadline during read', async () => {
    const x = setup();
    x.read.mockImplementation(async () => {
      x.timeout();
      return source;
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'deadline',
      release: 'released',
    });
    expect(x.render).not.toHaveBeenCalled();
  });
  it('cleans stage after lease expires during write', async () => {
    const x = setup();
    x.stage.mockImplementation(async () => {
      x.expire();
      return { stageId: boundStageId, sha256: hash(output), byteSize: 2 };
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'deadline',
      cleanup: 'cleaned',
      release: 'released',
    });
    expect(x.settle).not.toHaveBeenCalled();
  });
  it('reports codec workspace uncertainty without staging', async () => {
    const x = setup();
    x.render.mockResolvedValue({
      result: parseGalleryCodecResultMetadata(metadata, output),
      supervision: { ...supervision, workspaceCleaned: false, workspaceRetained: true },
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      state: 'failed',
      reason: 'codec_cleanup_uncertain',
      cleanup: 'retained_codec_unknown',
      release: 'retained_codec_unknown',
    });
    expect(x.stage).not.toHaveBeenCalled();
  });
  it('does not evaluate settle proxy traps and retains uncertain commit', async () => {
    const x = setup();
    let called = 0;
    x.settle.mockResolvedValue(
      new Proxy(
        { state: 'ready' },
        {
          getOwnPropertyDescriptor() {
            called++;
            throw Error('raw');
          },
        },
      ),
    );
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'settle_unknown',
      codecCode: 'not_observed',
      cleanup: 'retained_commit_unknown',
    });
    expect(called).toBe(0);
  });
  it('cleans staged bytes after external abort while staging', async () => {
    const x = setup();
    const c = new AbortController();
    x.dependencies.signal = c.signal;
    x.stage.mockImplementation(async () => {
      c.abort();
      return { stageId: boundStageId, sha256: hash(output), byteSize: 2 };
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'aborted',
      cleanup: 'cleaned',
      release: 'released',
    });
    expect(x.settle).not.toHaveBeenCalled();
  });
  it('preserves committed ready receipt even when settle response arrives after abort', async () => {
    const x = setup();
    x.settle.mockImplementation(async () => {
      x.timeout();
      return { state: 'ready' };
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({ state: 'ready' });
    expect(x.cleanup).not.toHaveBeenCalled();
  });
  it('isolates private-stage mutable bytes and metadata from transactional settle', async () => {
    const x = setup();
    x.dependencies.storage.stagePrivate = async ({ rendition }) => {
      rendition.output.bytes[0] = 99;
      rendition.original.sha256 = '0'.repeat(64);
      return { stageId: boundStageId, sha256: hash(output), byteSize: 2 };
    };
    let matched = false;
    x.dependencies.repository.settle = async ({ rendition }) => {
      matched =
        rendition.original.sha256 === job.sourceSha256 &&
        hash(rendition.output.bytes) === hash(output);
      return { state: 'ready' };
    };
    expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({ state: 'ready' });
    expect(matched).toBe(true);
  });
  it('uses the existing validator for image thumbnail', async () => {
    const x = setup();
    x.claim.mockResolvedValue({
      state: 'job',
      token: '44444444-4444-4444-4444-444444444444',
      expiresAtMs: 1000,
      job: { ...job, kind: 'image_thumbnail' },
    });
    x.render.mockResolvedValue({
      result: parseGalleryCodecResultMetadata({ ...metadata, kind: 'image_thumbnail' }, output),
      supervision,
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({ state: 'ready' });
  });
  it('uses the existing validator for video playback lineage', async () => {
    const x = setup();
    x.claim.mockResolvedValue({
      state: 'job',
      token: '44444444-4444-4444-4444-444444444444',
      expiresAtMs: 1000,
      job: { ...job, kind: 'video_playback' },
    });
    const binaryIdentity = {
      version: '9.0.2',
      sha256: 'a'.repeat(64),
      buildSha256: 'b'.repeat(64),
    };
    const video = {
      recipeVersion: 1,
      kind: 'video_playback',
      original: metadata.original,
      sourceObservation: {
        format: 'mov,mp4,m4a,3gp,3g2,mj2',
        videoCodec: 'h264',
        audioCodec: null,
        width: 10,
        height: 10,
        sampleAspectNumerator: 1,
        sampleAspectDenominator: 1,
        rotationDegrees: null,
        rotatedWidth: 10,
        rotatedHeight: 10,
        displayAspect: 1,
        fps: 30,
        durationSeconds: 1,
        frameCount: 30,
        hasAudio: false,
      },
      output: {
        ...metadata.output,
        mediaType: 'video/mp4',
        durationSeconds: 1,
        frameCount: 30,
        hasAudio: false,
      },
      build: { ffmpeg: binaryIdentity, ffprobe: binaryIdentity },
    };
    x.render.mockResolvedValue({
      result: parseGalleryCodecResultMetadata(video, output),
      supervision,
    });
    expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({ state: 'ready' });
  });
  it('late old-lease cleanup never deletes the same job new-lease stage', async () => {
    const x = setup();
    const next = '55555555-5555-5555-5555-555555555555';
    const stages = new Set<string>();
    let releaseOld: () => void = () => {};
    let observedCleanup: () => void = () => {};
    const cleanupStarted = new Promise<void>((resolve) => {
      observedCleanup = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    x.claim
      .mockResolvedValueOnce({
        state: 'job',
        token: '44444444-4444-4444-4444-444444444444',
        expiresAtMs: 1000,
        job,
      })
      .mockResolvedValueOnce({ state: 'job', token: next, expiresAtMs: 1000, job });
    x.dependencies.storage.stagePrivate = async ({ stageId, lease }) => {
      expect(stageId).toBe(`gallery-rendition-v1:${lease.job.id}:${lease.token}`);
      expect(Object.isFrozen(lease)).toBe(true);
      expect(lease.job.idempotencyKey).toBe(job.idempotencyKey);
      stages.add(stageId);
      return { stageId, sha256: hash(output), byteSize: 2 };
    };
    let settles = 0;
    x.dependencies.repository.settle = async ({ stageId, lease }) => {
      expect(stages.has(stageId)).toBe(true);
      expect(stageId.endsWith(lease.token)).toBe(true);
      return ++settles === 1 ? { state: 'rejected', reason: 'lease_lost' } : { state: 'ready' };
    };
    x.dependencies.storage.cleanup = async (stageId, lease) => {
      expect(stageId.endsWith(lease.token)).toBe(true);
      observedCleanup();
      await gate;
      stages.delete(stageId);
      return { state: 'cleaned' };
    };
    const old = runOneGalleryRenditionJob(x.dependencies);
    await cleanupStarted;
    expect(await runOneGalleryRenditionJob(x.dependencies)).toEqual({ state: 'ready' });
    releaseOld();
    expect(await old).toMatchObject({
      state: 'rejected',
      reason: 'lease_lost',
      cleanup: 'cleaned',
    });
    expect(stages).toEqual(new Set([`gallery-rendition-v1:${id}:${next}`]));
  });
  it.each(['unsupported_format', 'unsupported_pages'] as const)(
    'preserves verified %s without manufacturing public state',
    async (code) => {
      const x = setup();
      x.render.mockRejectedValue(new GalleryCodecSupervisorError(code, supervision));
      expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
        state: 'failed',
        reason: 'codec_invalid',
        codecCode: code,
        release: 'released',
      });
      expect(x.stage).not.toHaveBeenCalled();
      expect(x.release).toHaveBeenCalledTimes(1);
      expect(x.release.mock.calls[0]?.[1]).toEqual({ reason: 'codec_invalid', codecCode: code });
    },
  );
  it('passes finite non-codec outcomes to release for bounded retry decisions', async () => {
    const x = setup();
    x.read.mockImplementation(async () => {
      x.timeout();
      return source;
    });
    await runOneGalleryRenditionJob(x.dependencies);
    expect(x.release.mock.calls[0]?.[1]).toEqual({ reason: 'deadline', codecCode: 'not_observed' });
    const y = setup();
    y.settle.mockResolvedValue({ state: 'rejected', reason: 'deleted' });
    expect(await runOneGalleryRenditionJob(y.dependencies)).toMatchObject({
      state: 'rejected',
      reason: 'deleted',
      cleanup: 'cleaned',
      release: 'released',
    });
    expect(y.release.mock.calls[0]?.[1]).toEqual({ reason: 'rejected', codecCode: 'not_observed' });
    expect(Object.isFrozen(y.release.mock.calls[0]?.[1])).toBe(true);
  });
  it('retains lease when child termination is unconfirmed even with workspace cleaned', async () => {
    const x = setup();
    x.render.mockRejectedValue(
      new GalleryCodecSupervisorError('decode_failed', { ...supervision, childClosed: false }),
    );
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      reason: 'codec_cleanup_uncertain',
      codecCode: 'decode_failed',
      release: 'retained_codec_unknown',
    });
    expect(x.release).not.toHaveBeenCalled();
    expect(x.cleanup).not.toHaveBeenCalled();
  });
  it('retains a lease after explicit cleanup_uncertain supervisor error', async () => {
    const x = setup();
    x.render.mockRejectedValue(new GalleryCodecSupervisorError('cleanup_uncertain', supervision));
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({
      codecCode: 'cleanup_uncertain',
      release: 'retained_codec_unknown',
    });
    expect(x.release).not.toHaveBeenCalled();
  });
  it('does not invoke error code getters or retain raw error strings', async () => {
    const x = setup();
    let called = 0;
    const error = new GalleryCodecSupervisorError('unsupported_format', supervision);
    Object.defineProperty(error, 'code', {
      get() {
        called++;
        return 'unsupported_format';
      },
    });
    x.render.mockRejectedValue(error);
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({ codecCode: 'unknown' });
    expect(called).toBe(0);
    const y = setup();
    y.render.mockRejectedValue('raw private SQL path payload');
    const result = await runOneGalleryRenditionJob(y.dependencies);
    expect(result).toMatchObject({ codecCode: 'unknown', release: 'retained_codec_unknown' });
    expect(JSON.stringify(result)).not.toContain('payload');
  });
  it('does not manufacture decode_failed from unknown error code or proxy', async () => {
    const x = setup();
    const error = new GalleryCodecSupervisorError('decode_failed', supervision);
    Object.defineProperty(error, 'code', { value: 'arbitrary_secret' });
    x.render.mockRejectedValue(error);
    expect(await runOneGalleryRenditionJob(x.dependencies)).toMatchObject({ codecCode: 'unknown' });
    const y = setup();
    let called = 0;
    y.render.mockRejectedValue(
      new Proxy(Error('secret'), {
        getPrototypeOf() {
          called++;
          throw Error('private');
        },
      }),
    );
    expect(await runOneGalleryRenditionJob(y.dependencies)).toMatchObject({
      codecCode: 'unknown',
      release: 'retained_codec_unknown',
    });
    expect(called).toBe(0);
  });
});
