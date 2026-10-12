import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readGalleryOriginalBytes } from '../src/gallery-original-bytes.js';
import { createGalleryFinalObjectKey, createGalleryTemporaryObjectKey } from '../src/keys.js';
import { createLocalFilesystemObjectStorage } from '../src/local-filesystem.js';
import type { ObjectStorage } from '../src/object-storage.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const mediaItemId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const uploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bytes = Buffer.from('synthetic original bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const key = createGalleryFinalObjectKey({
  tenantId,
  mediaItemId,
  uploadId,
  sha256,
  extension: 'png',
});
const source = {
  tenantId,
  mediaItemId,
  storageRef: key,
  mediaKind: 'image',
  mediaType: 'image/png',
  sourceAccessRevision: 1,
  sha256,
  byteSize: bytes.length,
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function* stream(value: Uint8Array = bytes) {
  yield value;
}
function port(
  body: AsyncIterable<Uint8Array> = stream(),
  sizeBytes = bytes.length,
): Pick<ObjectStorage, 'open'> {
  return { open: vi.fn(async () => ({ key, sizeBytes, modifiedAt: new Date(0), body })) };
}
async function local() {
  const root = await mkdtemp(join(tmpdir(), 'wm-gallery-original-test-'));
  roots.push(root);
  const storage = await createLocalFilesystemObjectStorage(root);
  const temporary = createGalleryTemporaryObjectKey({ tenantId, mediaItemId, uploadId });
  await storage.writeTemporary(temporary, stream());
  await storage.publishTemporary(temporary, key, { sizeBytes: bytes.length, sha256 });
  return { storage, root };
}

describe('owner-bound original byte snapshot', () => {
  it('returns independently owned bytes and frozen source without changing input', async () => {
    const input = Buffer.from(bytes);
    const result = await readGalleryOriginalBytes(port(stream(input)), source);
    input.fill(0);
    expect(Buffer.from(result.bytes)).toEqual(bytes);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(result.source).toEqual(source);
  });
  it.each([
    { ...source, tenantId: uploadId },
    { ...source, mediaItemId: uploadId },
    { ...source, sha256: '0'.repeat(64) },
    { ...source, mediaType: 'image/jpeg' },
    { ...source, mediaKind: 'video' },
    { ...source, sourceAccessRevision: 0 },
    { ...source, byteSize: 0 },
    { ...source, storageRef: 'https://invalid.example/original' },
    { ...source, extra: true },
  ])('rejects invalid namespace or source facts before I/O %#', async (invalid) => {
    const storage = port();
    await expect(readGalleryOriginalBytes(storage, invalid)).rejects.toMatchObject({
      code: 'invalid_source',
    });
    expect(storage.open).not.toHaveBeenCalled();
  });
  it('rejects source accessors and proxies without invoking them', async () => {
    const getter = vi.fn(() => tenantId);
    const invalid = { ...source };
    Object.defineProperty(invalid, 'tenantId', { enumerable: true, get: getter });
    await expect(readGalleryOriginalBytes(port(), invalid)).rejects.toMatchObject({
      code: 'invalid_source',
    });
    await expect(readGalleryOriginalBytes(port(), new Proxy(source, {}))).rejects.toMatchObject({
      code: 'invalid_source',
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it('rejects image budget before open and accepts the separate video namespace', async () => {
    const storage = port();
    await expect(
      readGalleryOriginalBytes(storage, { ...source, byteSize: 15 * 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({ code: 'byte_budget' });
    expect(storage.open).not.toHaveBeenCalled();
    const videoKey = createGalleryFinalObjectKey({
      tenantId,
      mediaItemId,
      uploadId,
      sha256,
      extension: 'mp4',
    });
    const videoPort = {
      open: async () => ({
        key: videoKey,
        sizeBytes: bytes.length,
        modifiedAt: new Date(0),
        body: stream(),
      }),
    };
    expect(
      (
        await readGalleryOriginalBytes(videoPort, {
          ...source,
          storageRef: videoKey,
          mediaKind: 'video',
          mediaType: 'video/mp4',
        })
      ).bytes,
    ).toEqual(Uint8Array.from(bytes));
    await expect(
      readGalleryOriginalBytes(videoPort, {
        ...source,
        storageRef: videoKey,
        mediaKind: 'video',
        mediaType: 'video/mp4',
        byteSize: 64 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({ code: 'byte_budget' });
  });
  it('checks stat before chunks and closes on stat mismatch', async () => {
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const body = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
    await expect(
      readGalleryOriginalBytes(port(body, bytes.length + 1), source),
    ).rejects.toMatchObject({ code: 'integrity_mismatch' });
    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  it('closes on oversize, truncation, corruption and next failure', async () => {
    for (const value of [
      Buffer.alloc(bytes.length + 1),
      bytes.subarray(1),
      Buffer.alloc(bytes.length),
    ]) {
      let closed = false;
      async function* body() {
        try {
          yield value;
        } finally {
          closed = true;
        }
      }
      await expect(readGalleryOriginalBytes(port(body()), source)).rejects.toMatchObject({
        code: 'integrity_mismatch',
      });
      expect(closed).toBe(true);
    }
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const body = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('private');
        },
        return: close,
      }),
    };
    await expect(readGalleryOriginalBytes(port(body), source)).rejects.toMatchObject({
      code: 'io_failed',
      message: 'io_failed',
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects shared, resizable, proxy and accessor chunks', async () => {
    const accessor = Buffer.from(bytes);
    Object.defineProperty(accessor, 'byteLength', {
      get: () => {
        throw new Error('must not invoke');
      },
    });
    const resizable: unknown = Reflect.construct(ArrayBuffer, [
      bytes.length,
      { maxByteLength: 100 },
    ]);
    if (!(resizable instanceof ArrayBuffer)) throw new Error('invalid synthetic fixture');
    for (const chunk of [
      new Uint8Array(new SharedArrayBuffer(bytes.length)),
      new Uint8Array(resizable),
      new Proxy(bytes, {}),
      accessor,
    ]) {
      await expect(readGalleryOriginalBytes(port(stream(chunk)), source)).rejects.toMatchObject({
        code: 'invalid_chunk',
      });
    }
  });
  it('does not open when already aborted and closes late-open completion', async () => {
    const controller = new AbortController();
    controller.abort();
    const storage = port();
    await expect(
      readGalleryOriginalBytes(storage, source, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(storage.open).not.toHaveBeenCalled();
    const late = new AbortController();
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const body = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: bytes }),
        return: close,
      }),
    };
    const latePort = {
      open: async () => {
        late.abort();
        return { key, sizeBytes: bytes.length, modifiedAt: new Date(0), body };
      },
    };
    await expect(
      readGalleryOriginalBytes(latePort, source, { signal: late.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(close).toHaveBeenCalledOnce();
  });
  it('waits for hanging next, then closes and reports cancellation', async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const body = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          controller.abort();
          await pending;
          return { done: false as const, value: bytes };
        },
        return: close,
      }),
    };
    let settled = false;
    const result = readGalleryOriginalBytes(port(body), source, {
      signal: controller.signal,
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    release?.();
    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    expect(close).toHaveBeenCalledOnce();
  });
  it('catches cancellation during close before returning success', async () => {
    const controller = new AbortController();
    const iterator = stream();
    const body = {
      [Symbol.asyncIterator]: () => ({
        next: () => iterator.next(),
        return: async () => {
          controller.abort();
          return { done: true as const, value: undefined };
        },
      }),
    };
    await expect(
      readGalleryOriginalBytes(port(body), source, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
  it('reads actual filesystem immutable original and detects corrupt/truncated/missing files', async () => {
    const { storage, root } = await local();
    expect((await readGalleryOriginalBytes(storage, source)).bytes).toEqual(Uint8Array.from(bytes));
    await writeFile(join(root, key), Buffer.alloc(bytes.length));
    await expect(readGalleryOriginalBytes(storage, source)).rejects.toMatchObject({
      code: 'integrity_mismatch',
    });
    await writeFile(join(root, key), bytes.subarray(1));
    await expect(readGalleryOriginalBytes(storage, source)).rejects.toMatchObject({
      code: 'integrity_mismatch',
    });
    await storage.delete(key);
    await expect(readGalleryOriginalBytes(storage, source)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
  it('awaits actual local filesystem generator close on cancellation', async () => {
    const { storage } = await local();
    const controller = new AbortController();
    let closed = false;
    const wrapped = {
      open: async (selected: Parameters<ObjectStorage['open']>[0]) => {
        const opened = await storage.open(selected);
        if (!opened) return null;
        const originalBody = opened.body;
        async function* body() {
          try {
            for await (const chunk of originalBody) {
              controller.abort();
              yield chunk;
            }
          } finally {
            closed = true;
          }
        }
        return { ...opened, body: body() };
      },
    };
    await expect(
      readGalleryOriginalBytes(wrapped, source, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(closed).toBe(true);
    await storage.delete(key);
    expect(await storage.open(key)).toBeNull();
  });
});
