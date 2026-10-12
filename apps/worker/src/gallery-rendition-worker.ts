import { createHash } from 'node:crypto';
import { types } from 'node:util';

import {
  parseGalleryCodecResultMetadata,
  galleryCodecMetadata,
  GalleryCodecSupervisorError,
  type createGalleryCodecSupervisor,
  type GalleryCodecKind,
  type GalleryCodecSupervisorCode,
  type GallerySupervisedRendition,
} from '@workout/server-media/gallery-codec-supervisor';

export interface GalleryRenditionJobV1 {
  readonly version: 1;
  readonly id: string;
  readonly athleteId: string;
  readonly mediaId: string;
  readonly expectedAccessRevision: number;
  readonly sourceSha256: string;
  readonly sourceByteSize: number;
  readonly kind: GalleryCodecKind;
  readonly recipeVersion: 1;
  readonly idempotencyKey: string;
}
export interface GalleryRenditionLease {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly job: GalleryRenditionJobV1;
}
export type GalleryRenditionRejection =
  'lease_lost' | 'stale' | 'deleted' | 'consent_withdrawn' | 'authoring_closed';
/** All async ports must acknowledge cancellation/complete within their adapter deadline.
 * The executor awaits acknowledgement; it never races an unquiesced stage/transaction. */
export interface GalleryRenditionRepository {
  /** Claims must be tenant scoped; completed means an existing successful receipt. */
  claimLease(workerId: string, signal: AbortSignal): Promise<unknown>;
  /**
   * One transaction must fence lease, tenant, source/revision, consent, deletion and CLOSED,
   * publish the staged reference, and commit receipt/outbox atomically. No remote I/O here.
   * Throwing (including cancellation) is an UNKNOWN commit outcome, never a rejection.
   */
  settle(input: {
    lease: GalleryRenditionLease;
    stageId: string;
    rendition: GallerySupervisedRendition;
    signal: AbortSignal;
  }): Promise<unknown>;
  /** Ends the lease without a receipt. The finite outcome lets the store make deterministic
   * codec failures terminal and spend the bounded retry budget only on transient ones. */
  release(lease: GalleryRenditionLease, outcome: GalleryRenditionReleaseOutcome): Promise<unknown>;
}
export interface GalleryRenditionReleaseOutcome {
  readonly reason: GalleryRenditionFailureReason | 'rejected';
  readonly codecCode: GalleryCodecSupervisorCode | 'not_observed' | 'unknown';
}
export interface GalleryRenditionStorage {
  readOriginal(job: GalleryRenditionJobV1, signal: AbortSignal): Promise<unknown>;
  /** stageId binds immutable job.id AND lease.token; never overwrite another lease stage. */
  stagePrivate(input: {
    stageId: string;
    lease: GalleryRenditionLease;
    rendition: GallerySupervisedRendition;
    signal: AbortSignal;
  }): Promise<unknown>;
  /** Idempotent cleanup removes only the uncommitted stage for this exact lease/job. */
  cleanup(stageId: string, lease: GalleryRenditionLease): Promise<unknown>;
}
export interface GalleryRenditionClock {
  nowMs(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}
export interface GalleryRenditionWorkerDependencies {
  repository: GalleryRenditionRepository;
  storage: GalleryRenditionStorage;
  codec: Pick<ReturnType<typeof createGalleryCodecSupervisor>, 'render'>;
  clock: GalleryRenditionClock;
  /** Injected worker identity, never used as a fresh command idempotency key. */
  workerId: string;
  deadlineMs: number;
  signal?: AbortSignal;
}
export type GalleryRenditionWorkerResult =
  | { state: 'no_job' | 'completed' | 'ready' }
  | {
      state: 'rejected';
      reason: GalleryRenditionRejection;
      cleanup: 'not_needed' | 'cleaned' | 'uncertain';
      release: 'released' | 'uncertain';
    }
  | {
      state: 'failed';
      reason:
        | 'invalid_input'
        | 'original_integrity'
        | 'codec_invalid'
        | 'stage_invalid'
        | 'io_failed'
        | 'aborted'
        | 'deadline'
        | 'settle_unknown'
        | 'codec_cleanup_uncertain';
      codecCode: GalleryCodecSupervisorCode | 'not_observed' | 'unknown';
      cleanup:
        | 'not_needed'
        | 'cleaned'
        | 'uncertain'
        | 'retained_commit_unknown'
        | 'retained_codec_unknown';
      release:
        | 'not_needed'
        | 'released'
        | 'uncertain'
        | 'retained_commit_unknown'
        | 'retained_codec_unknown';
    };
export type GalleryRenditionFailureReason =
  | 'invalid_input'
  | 'original_integrity'
  | 'codec_invalid'
  | 'stage_invalid'
  | 'io_failed'
  | 'aborted'
  | 'deadline'
  | 'settle_unknown'
  | 'codec_cleanup_uncertain';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KINDS: readonly string[] = ['image_preview', 'image_thumbnail', 'video_playback'];
const REJECTIONS: readonly string[] = [
  'lease_lost',
  'stale',
  'deleted',
  'consent_withdrawn',
  'authoring_closed',
];
const CODEC_CODES: readonly GalleryCodecSupervisorCode[] = [
  'input_invalid',
  'input_budget',
  'codec_unavailable',
  'unsupported_format',
  'unsupported_pages',
  'pixel_budget',
  'invalid_media',
  'decode_failed',
  'output_budget',
  'aborted',
  'timeout',
  'configuration_invalid',
  'protocol_invalid',
  'integrity_mismatch',
  'cleanup_uncertain',
  'io_failed',
];
function finiteCodecCode(error: unknown): GalleryCodecSupervisorCode | 'unknown' {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return 'unknown';
  const prototype = Object.getPrototypeOf(error);
  if (prototype !== Error.prototype && prototype !== GalleryCodecSupervisorError.prototype)
    return 'unknown';
  const d = Object.getOwnPropertyDescriptor(error, 'code');
  if (!d || !('value' in d)) return 'unknown';
  const value: unknown = d.value;
  return CODEC_CODES.find((code) => code === value) ?? 'unknown';
}
function stageIdentity(lease: GalleryRenditionLease): string {
  return `gallery-rendition-v1:${lease.job.id}:${lease.token}`;
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function invalid(): never {
  throw new Error('invalid');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d) || !d.enumerable) invalid();
    result[key] = d.value;
  }
  return result;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length > 128 || !pattern.test(value)) invalid();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    invalid();
  return value;
}
/** Unknown storage/job boundary: no coercion, accessors, extra keys or unbounded strings. */
export function parseGalleryRenditionJobV1(value: unknown): GalleryRenditionJobV1 {
  const r = record(value, [
    'version',
    'id',
    'athleteId',
    'mediaId',
    'expectedAccessRevision',
    'sourceSha256',
    'sourceByteSize',
    'kind',
    'recipeVersion',
    'idempotencyKey',
  ]);
  if (
    r['version'] !== 1 ||
    r['recipeVersion'] !== 1 ||
    typeof r['kind'] !== 'string' ||
    !KINDS.includes(r['kind'])
  )
    invalid();
  const kind = r['kind'];
  if (kind !== 'image_preview' && kind !== 'image_thumbnail' && kind !== 'video_playback')
    invalid();
  return Object.freeze({
    version: 1,
    id: text(r['id'], UUID),
    athleteId: text(r['athleteId'], UUID),
    mediaId: text(r['mediaId'], UUID),
    expectedAccessRevision: integer(r['expectedAccessRevision'], 1, 2147483646),
    sourceSha256: text(r['sourceSha256'], DIGEST),
    sourceByteSize: integer(
      r['sourceByteSize'],
      1,
      kind === 'video_playback' ? 64 * 1024 * 1024 : 15 * 1024 * 1024,
    ),
    kind,
    recipeVersion: 1,
    idempotencyKey: text(r['idempotencyKey'], KEY),
  });
}
function bytes(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (
    !types.isUint8Array(value) ||
    types.isProxy(value) ||
    !bufferGetter ||
    !lengthGetter ||
    !offsetGetter
  )
    invalid();
  if (
    Object.getPrototypeOf(value) !== Uint8Array.prototype &&
    Object.getPrototypeOf(value) !== Buffer.prototype
  )
    invalid();
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length'])
    if (Object.getOwnPropertyDescriptor(value, key)) invalid();
  const buffer: unknown = bufferGetter.call(value),
    length: unknown = lengthGetter.call(value),
    offset: unknown = offsetGetter.call(value);
  if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer)) invalid();
  const count = integer(length, 1, maximum),
    start = integer(offset, 0, Number.MAX_SAFE_INTEGER);
  return Uint8Array.from(new Uint8Array(buffer, start, count));
}
function metadata(value: unknown): unknown {
  let nodes = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 128 || depth > 6) invalid();
    if (typeof v === 'string') {
      if (v.length > 128) invalid();
      return v;
    }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      return v;
    if (
      !v ||
      typeof v !== 'object' ||
      types.isProxy(v) ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      invalid();
    const keys = Reflect.ownKeys(v);
    if (keys.length > 16) invalid();
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 64) invalid();
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !('value' in d) || !d.enumerable) invalid();
      Object.defineProperty(copy, key, {
        value: visit(d.value, depth + 1),
        enumerable: true,
      });
    }
    return copy;
  }
  return visit(value, 0);
}
function rendition(
  value: unknown,
  job: GalleryRenditionJobV1,
  acknowledge: () => void,
): GallerySupervisedRendition {
  const envelope = record(value, ['result', 'supervision']);
  const facts = record(envelope['supervision'], [
    'childReady',
    'codecStarted',
    'cancellationReceived',
    'settlementAcknowledged',
    'childClosed',
    'childExitCode',
    'childExitSignal',
    'terminationRequested',
    'workspaceCleaned',
    'workspaceRetained',
    'elapsedMs',
    'stopReason',
    'memoryLimit',
    'diskHardLimit',
    'networkIsolation',
    'descendantEnforcement',
  ]);
  if (
    facts['workspaceCleaned'] !== true ||
    facts['workspaceRetained'] !== false ||
    facts['childClosed'] !== true ||
    facts['settlementAcknowledged'] !== true
  )
    throw new Error('codec_cleanup_uncertain');
  acknowledge();
  const raw = record(envelope['result'], [
    'recipeVersion',
    'kind',
    'original',
    'sourceObservation',
    'output',
    'build',
  ]);
  const outputValue = raw['output'];
  if (
    !outputValue ||
    typeof outputValue !== 'object' ||
    types.isProxy(outputValue) ||
    Object.getPrototypeOf(outputValue) !== Object.prototype
  )
    invalid();
  const outputKeys = Reflect.ownKeys(outputValue);
  if (outputKeys.length > 9 || !outputKeys.includes('bytes')) invalid();
  const output: Record<string, unknown> = {};
  let binary: unknown;
  for (const key of outputKeys) {
    if (typeof key !== 'string') invalid();
    const d = Object.getOwnPropertyDescriptor(outputValue, key);
    if (!d || !('value' in d) || !d.enumerable) invalid();
    if (key === 'bytes') binary = d.value;
    else Object.defineProperty(output, key, { value: d.value, enumerable: true });
  }
  const copied = bytes(binary, job.kind === 'video_playback' ? 64 * 1024 * 1024 : 2 * 1024 * 1024);
  const parsed = parseGalleryCodecResultMetadata(metadata({ ...raw, output }), copied);
  if (
    parsed.kind !== job.kind ||
    parsed.recipeVersion !== job.recipeVersion ||
    parsed.original.sha256 !== job.sourceSha256 ||
    parsed.original.byteSize !== job.sourceByteSize ||
    parsed.output.byteSize !== copied.byteLength ||
    parsed.output.sha256 !== hash(copied)
  )
    invalid();
  return parsed;
}
/** One bounded job; ports own persistence/privacy admission. No DTO constitutes authority. */
export async function runOneGalleryRenditionJob(
  d: GalleryRenditionWorkerDependencies,
): Promise<GalleryRenditionWorkerResult> {
  let lease: GalleryRenditionLease | undefined,
    staged = false,
    settling = false;
  let codecCleanupUncertain = false;
  let codecCode: GalleryCodecSupervisorCode | 'not_observed' | 'unknown' = 'not_observed';
  let reason: Extract<GalleryRenditionWorkerResult, { state: 'failed' }>['reason'] =
    'invalid_input';
  const controller = new AbortController();
  let timedOut = false;
  let cancelTimer: (() => void) | undefined;
  const abort = (): void => controller.abort();
  async function dispose(outcome: GalleryRenditionReleaseOutcome): Promise<{
    cleanup: 'not_needed' | 'cleaned' | 'uncertain';
    release: 'not_needed' | 'released' | 'uncertain';
  }> {
    let cleanup: 'not_needed' | 'cleaned' | 'uncertain' = 'not_needed',
      release: 'not_needed' | 'released' | 'uncertain' = 'not_needed';
    if (lease && staged) {
      try {
        const r = record(await d.storage.cleanup(stageIdentity(lease), lease), ['state']);
        if (r['state'] !== 'cleaned') invalid();
        cleanup = 'cleaned';
      } catch {
        cleanup = 'uncertain';
      }
    }
    if (lease) {
      try {
        const r = record(await d.repository.release(lease, Object.freeze({ ...outcome })), [
          'state',
        ]);
        if (r['state'] !== 'released') invalid();
        release = 'released';
      } catch {
        release = 'uncertain';
      }
    }
    return { cleanup, release };
  }
  function active(): void {
    if (controller.signal.aborted) {
      reason = timedOut ? 'deadline' : 'aborted';
      invalid();
    }
    const now = integer(d.clock.nowMs(), 0, Number.MAX_SAFE_INTEGER);
    if (lease && now >= lease.expiresAtMs) {
      reason = 'deadline';
      invalid();
    }
  }
  try {
    text(d.workerId, UUID);
    integer(d.deadlineMs, 1, 30000);
    integer(d.clock.nowMs(), 0, Number.MAX_SAFE_INTEGER);
    d.signal?.addEventListener('abort', abort, { once: true });
    if (d.signal?.aborted) abort();
    cancelTimer = d.clock.schedule(d.deadlineMs, () => {
      timedOut = true;
      controller.abort();
    });
    active();
    reason = 'io_failed';
    const claimed = await d.repository.claimLease(d.workerId, controller.signal);
    reason = 'invalid_input';
    if (!claimed || typeof claimed !== 'object' || types.isProxy(claimed)) invalid();
    const state = Object.getOwnPropertyDescriptor(claimed, 'state');
    if (!state || !('value' in state)) invalid();
    if (state.value === 'no_job' || state.value === 'completed') {
      const r = record(claimed, ['state']);
      active();
      return { state: r['state'] === 'no_job' ? 'no_job' : 'completed' };
    }
    const claim = record(claimed, ['state', 'token', 'expiresAtMs', 'job']);
    if (claim['state'] !== 'job') invalid();
    lease = Object.freeze({
      token: text(claim['token'], UUID),
      expiresAtMs: integer(claim['expiresAtMs'], 0, Number.MAX_SAFE_INTEGER),
      job: parseGalleryRenditionJobV1(claim['job']),
    });
    active();
    reason = 'io_failed';
    const originalValue = await d.storage.readOriginal(lease.job, controller.signal);
    active();
    reason = 'original_integrity';
    const original = bytes(originalValue, lease.job.sourceByteSize);
    if (
      original.byteLength !== lease.job.sourceByteSize ||
      hash(original) !== lease.job.sourceSha256
    )
      invalid();
    reason = 'codec_invalid';
    codecCleanupUncertain = true;
    codecCode = 'unknown';
    let converted: GallerySupervisedRendition;
    try {
      converted = rendition(
        await d.codec.render(original, {
          kind: lease.job.kind,
          signal: controller.signal,
        }),
        lease.job,
        () => {
          codecCleanupUncertain = false;
        },
      );
    } catch (error) {
      codecCode = finiteCodecCode(error);
      if (
        error &&
        typeof error === 'object' &&
        !types.isProxy(error) &&
        Object.getPrototypeOf(error) === GalleryCodecSupervisorError.prototype
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'supervision');
        const facts: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
        const cleaned =
          facts &&
          typeof facts === 'object' &&
          !types.isProxy(facts) &&
          Object.getPrototypeOf(facts) === Object.prototype
            ? Object.getOwnPropertyDescriptor(facts, 'workspaceCleaned')
            : undefined;
        const childClosed =
          facts && typeof facts === 'object' && !types.isProxy(facts)
            ? Object.getOwnPropertyDescriptor(facts, 'childClosed')
            : undefined;
        const retained =
          facts && typeof facts === 'object' && !types.isProxy(facts)
            ? Object.getOwnPropertyDescriptor(facts, 'workspaceRetained')
            : undefined;
        codecCleanupUncertain =
          codecCode === 'cleanup_uncertain' ||
          !cleaned ||
          !('value' in cleaned) ||
          cleaned.value !== true ||
          !childClosed ||
          !('value' in childClosed) ||
          childClosed.value !== true ||
          !retained ||
          !('value' in retained) ||
          retained.value !== false;
      } else if (
        error &&
        typeof error === 'object' &&
        !types.isProxy(error) &&
        Object.getPrototypeOf(error) === Error.prototype &&
        Object.getOwnPropertyDescriptor(error, 'message')?.value === 'codec_cleanup_uncertain'
      )
        codecCleanupUncertain = true;
      throw error;
    }
    codecCode = 'not_observed';
    active();
    reason = 'stage_invalid';
    staged = true;
    const stage = record(
      await d.storage.stagePrivate({
        stageId: stageIdentity(lease),
        lease,
        rendition: parseGalleryCodecResultMetadata(
          metadata(galleryCodecMetadata(converted)),
          Uint8Array.from(converted.output.bytes),
        ),
        signal: controller.signal,
      }),
      ['stageId', 'sha256', 'byteSize'],
    );
    if (
      stage['stageId'] !== stageIdentity(lease) ||
      stage['sha256'] !== converted.output.sha256 ||
      stage['byteSize'] !== converted.output.byteSize
    )
      invalid();
    active();
    reason = 'settle_unknown';
    settling = true;
    const result = await d.repository.settle({
      lease,
      stageId: stageIdentity(lease),
      rendition: converted,
      signal: controller.signal,
    });
    if (
      !result ||
      typeof result !== 'object' ||
      types.isProxy(result) ||
      Object.getPrototypeOf(result) !== Object.prototype
    )
      invalid();
    const resultState = Object.getOwnPropertyDescriptor(result, 'state');
    if (!resultState || !('value' in resultState)) invalid();
    const resultRecord = record(result, [
      'state',
      ...(resultState.value === 'rejected' ? ['reason'] : []),
    ]);
    if (resultRecord['state'] === 'ready') return { state: 'ready' };
    if (
      resultRecord['state'] !== 'rejected' ||
      typeof resultRecord['reason'] !== 'string' ||
      !REJECTIONS.includes(resultRecord['reason'])
    )
      invalid();
    const rejected = resultRecord['reason'];
    if (
      rejected !== 'lease_lost' &&
      rejected !== 'stale' &&
      rejected !== 'deleted' &&
      rejected !== 'consent_withdrawn' &&
      rejected !== 'authoring_closed'
    )
      invalid();
    settling = false;
    const cleanup = await dispose({ reason: 'rejected', codecCode });
    return {
      state: 'rejected',
      reason: rejected,
      cleanup: cleanup.cleanup,
      release: cleanup.release === 'not_needed' ? 'uncertain' : cleanup.release,
    };
  } catch {
    // A lost settle response may hide a committed receipt. Retain stage/lease for reconciliation.
    if (settling)
      return {
        state: 'failed',
        reason: 'settle_unknown',
        codecCode,
        cleanup: 'retained_commit_unknown',
        release: 'retained_commit_unknown',
      };
    if (codecCleanupUncertain)
      return {
        state: 'failed',
        reason: 'codec_cleanup_uncertain',
        codecCode,
        cleanup: 'retained_codec_unknown',
        release: 'retained_codec_unknown',
      };
    if (controller.signal.aborted) reason = timedOut ? 'deadline' : 'aborted';
    const disposed = await dispose({ reason, codecCode });
    return {
      state: 'failed',
      reason,
      codecCode,
      ...disposed,
      cleanup: codecCleanupUncertain ? 'uncertain' : disposed.cleanup,
    };
  } finally {
    cancelTimer?.();
    d.signal?.removeEventListener('abort', abort);
  }
}
