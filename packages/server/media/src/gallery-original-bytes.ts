import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { parseObjectKey, validateObjectKey } from './keys.js';
import type { ObjectStorage } from './object-storage.js';

export type GalleryOriginalBytesCode =
  | 'invalid_source'
  | 'unavailable'
  | 'integrity_mismatch'
  | 'byte_budget'
  | 'invalid_chunk'
  | 'aborted'
  | 'io_failed';
export class GalleryOriginalBytesError extends Error {
  constructor(readonly code: GalleryOriginalBytesCode) {
    super(code);
    this.name = 'GalleryOriginalBytesError';
  }
}
export interface GalleryOriginalSource {
  tenantId: string;
  mediaItemId: string;
  storageRef: string;
  mediaKind: 'image' | 'video';
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/webm';
  sourceAccessRevision: number;
  sha256: string;
  byteSize: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferGetter = Object.getOwnPropertyDescriptor(typedArray, 'buffer')?.get;
const sizeGetter = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')?.get;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')?.get;
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function fail(code: GalleryOriginalBytesCode): never {
  throw new GalleryOriginalBytesError(code);
}
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail('integrity_mismatch');
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('integrity_mismatch');
  return descriptor.value;
}
function source(raw: unknown): GalleryOriginalSource {
  try {
    if (
      !raw ||
      typeof raw !== 'object' ||
      types.isProxy(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype
    )
      fail('invalid_source');
    const snapshot: Record<string, unknown> = {};
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 8) fail('invalid_source');
    for (const key of keys) {
      if (typeof key !== 'string') fail('invalid_source');
      Object.defineProperty(snapshot, key, { value: data(raw, key), enumerable: true });
    }
    const {
      tenantId,
      mediaItemId,
      storageRef,
      mediaKind,
      mediaType,
      sourceAccessRevision,
      sha256,
      byteSize,
    } = snapshot;
    if (
      typeof tenantId !== 'string' ||
      !uuid.test(tenantId) ||
      typeof mediaItemId !== 'string' ||
      !uuid.test(mediaItemId) ||
      typeof storageRef !== 'string' ||
      storageRef.length < 1 ||
      storageRef.length > 512 ||
      (mediaKind !== 'image' && mediaKind !== 'video') ||
      (mediaType !== 'image/jpeg' &&
        mediaType !== 'image/png' &&
        mediaType !== 'image/webp' &&
        mediaType !== 'video/mp4' &&
        mediaType !== 'video/webm') ||
      typeof sourceAccessRevision !== 'number' ||
      !Number.isInteger(sourceAccessRevision) ||
      sourceAccessRevision < 1 ||
      sourceAccessRevision > 2147483646 ||
      typeof sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      typeof byteSize !== 'number' ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 1
    )
      fail('invalid_source');
    const value: GalleryOriginalSource = {
      tenantId,
      mediaItemId,
      storageRef,
      mediaKind,
      mediaType,
      sourceAccessRevision,
      sha256,
      byteSize,
    };
    const key = parseObjectKey(value.storageRef);
    const extension = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
    }[value.mediaType];
    if (
      key.kind !== 'gallery_final' ||
      key.tenantId !== value.tenantId ||
      key.mediaItemId !== value.mediaItemId ||
      key.sha256 !== value.sha256 ||
      key.extension !== extension ||
      !value.mediaType.startsWith(`${value.mediaKind}/`)
    )
      fail('invalid_source');
    return value;
  } catch {
    return fail('invalid_source');
  }
}
function snapshotChunk(raw: unknown, remaining: number): Buffer {
  if (!types.isUint8Array(raw) || types.isProxy(raw)) fail('invalid_chunk');
  if (![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw)))
    fail('invalid_chunk');
  for (const key of ['buffer', 'byteLength', 'byteOffset', 'length'])
    if (Object.getOwnPropertyDescriptor(raw, key)) fail('invalid_chunk');
  if (!bufferGetter || !sizeGetter || !offsetGetter) fail('invalid_chunk');
  const buffer: unknown = bufferGetter.call(raw),
    size: unknown = sizeGetter.call(raw),
    offset: unknown = offsetGetter.call(raw);
  if (
    !types.isArrayBuffer(buffer) ||
    types.isSharedArrayBuffer(buffer) ||
    resizableGetter?.call(buffer) === true
  )
    fail('invalid_chunk');
  if (typeof size !== 'number' || typeof offset !== 'number' || size < 1) fail('invalid_chunk');
  if (size > remaining) fail('byte_budget');
  try {
    return Buffer.from(new Uint8Array(buffer, offset, size));
  } catch {
    return fail('invalid_chunk');
  }
}
function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) fail('aborted');
}
/**
 * Checks bytes only, not current ownership, consent, lease or deletion authority.
 * The returned bytes are an independent caller-owned snapshot. A hanging open/next
 * cannot be cancelled through the current object port; completion is awaited.
 */
export async function readGalleryOriginalBytes(
  storage: Pick<ObjectStorage, 'open'>,
  rawSource: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<{ source: Readonly<GalleryOriginalSource>; bytes: Uint8Array }> {
  checkAbort(options.signal);
  const selected = source(rawSource);
  const maximum = selected.mediaKind === 'image' ? 15 * 1024 * 1024 : 64 * 1024 * 1024;
  if (selected.byteSize > maximum) fail('byte_budget');
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let result: { source: Readonly<GalleryOriginalSource>; bytes: Uint8Array } | undefined;
  try {
    const opened = await storage.open(validateObjectKey(selected.storageRef));
    if (opened === null) {
      checkAbort(options.signal);
      fail('unavailable');
    }
    // Capture the trusted port's iterable before abort checks, so a late open
    // completion also reaches its return()/generator finally cleanup.
    const body = data(opened, 'body');
    if (!body || typeof body !== 'object' || types.isProxy(body) || !(Symbol.asyncIterator in body))
      fail('io_failed');
    if (body !== opened.body || typeof opened.body[Symbol.asyncIterator] !== 'function')
      fail('io_failed');
    iterator = opened.body[Symbol.asyncIterator]();
    checkAbort(options.signal);
    if (
      data(opened, 'key') !== selected.storageRef ||
      data(opened, 'sizeBytes') !== selected.byteSize
    )
      fail('integrity_mismatch');
    const digest = createHash('sha256'),
      chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      checkAbort(options.signal);
      const item = await iterator.next();
      checkAbort(options.signal);
      const done = data(item, 'done');
      if (typeof done !== 'boolean') fail('io_failed');
      if (done) break;
      const chunk = snapshotChunk(data(item, 'value'), maximum - length);
      length += chunk.length;
      if (length > selected.byteSize) fail('integrity_mismatch');
      digest.update(chunk);
      chunks.push(chunk);
    }
    checkAbort(options.signal);
    if (length !== selected.byteSize || digest.digest('hex') !== selected.sha256)
      fail('integrity_mismatch');
    const bytes = Uint8Array.from(Buffer.concat(chunks, length));
    checkAbort(options.signal);
    result = { source: Object.freeze(selected), bytes };
  } catch (error) {
    if (error instanceof GalleryOriginalBytesError) throw error;
    checkAbort(options.signal);
    fail('io_failed');
  } finally {
    if (iterator?.return) {
      try {
        await iterator.return();
      } catch {
        fail('io_failed');
      }
    }
  }
  checkAbort(options.signal);
  if (!result) fail('io_failed');
  return result;
}
