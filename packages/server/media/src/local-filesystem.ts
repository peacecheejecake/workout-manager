import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

import { createHash } from 'node:crypto';

import {
  parseObjectKey,
  type FinalObjectKey,
  type ObjectKey,
  type TemporaryObjectKey,
} from './keys.js';
import type {
  ObjectStorage,
  OpenedStoredObject,
  PublishExpectation,
  PublishResult,
  StoredObjectStat,
} from './object-storage.js';

export class ObjectStorageConflictError extends Error {
  readonly code = 'OBJECT_STORAGE_CONFLICT';

  constructor() {
    super('An object already exists at the final key with different content.');
    this.name = 'ObjectStorageConflictError';
  }
}

export class UnsafeStoragePathError extends Error {
  readonly code = 'UNSAFE_STORAGE_PATH';

  constructor() {
    super('Storage path is outside the configured root or contains a symbolic link.');
    this.name = 'UnsafeStoragePathError';
  }
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export async function createLocalFilesystemObjectStorage(
  rootDirectory: string,
): Promise<ObjectStorage> {
  if (!isAbsolute(rootDirectory)) throw new UnsafeStoragePathError();
  const absoluteRoot = resolve(rootDirectory);
  if (absoluteRoot === parse(absoluteRoot).root) throw new UnsafeStoragePathError();
  await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new UnsafeStoragePathError();
  await chmod(absoluteRoot, 0o700);
  const canonicalRoot = await realpath(absoluteRoot);

  function keyPath(key: ObjectKey): string {
    parseObjectKey(key);
    const path = resolve(canonicalRoot, ...key.split('/'));
    if (!path.startsWith(`${canonicalRoot}${sep}`)) throw new UnsafeStoragePathError();
    return path;
  }

  async function prepareParents(path: string): Promise<void> {
    const relativeParts = dirname(path)
      .slice(canonicalRoot.length + 1)
      .split(sep);
    let current = canonicalRoot;
    for (const part of relativeParts) {
      current = resolve(current, part);
      if (await missing(current)) {
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new UnsafeStoragePathError();
      await chmod(current, 0o700);
    }
  }

  async function assertSafeExistingFile(
    path: string,
  ): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    const relativeParts = path.slice(canonicalRoot.length + 1).split(sep);
    let current = canonicalRoot;
    for (const part of relativeParts) {
      current = resolve(current, part);
      if (await missing(current)) return null;
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new UnsafeStoragePathError();
      if (current !== path && !stat.isDirectory()) throw new UnsafeStoragePathError();
      if (current === path && !stat.isFile()) throw new UnsafeStoragePathError();
    }
    return lstat(path);
  }

  async function objectStat(key: ObjectKey): Promise<StoredObjectStat | null> {
    const stat = await assertSafeExistingFile(keyPath(key));
    if (!stat) return null;
    return { key, sizeBytes: Number(stat.size), modifiedAt: stat.mtime };
  }

  async function hashFile(path: string): Promise<{ sizeBytes: number; sha256: string }> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        sizeBytes += chunk.byteLength;
        hash.update(chunk);
      }
      return { sizeBytes, sha256: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  }

  async function* readFileBody(path: string): AsyncGenerator<Uint8Array> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false })) yield chunk;
    } finally {
      await handle.close();
    }
  }

  return {
    async writeTemporary(key, body) {
      const parsedKey = parseObjectKey(key);
      if (parsedKey.kind !== 'temporary' && parsedKey.kind !== 'url_temporary')
        throw new UnsafeStoragePathError();
      const path = keyPath(key);
      await prepareParents(path);
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let sizeBytes = 0;
      try {
        for await (const chunk of body) {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
            if (bytesWritten === 0) throw new Error('Object storage write made no progress.');
            offset += bytesWritten;
            sizeBytes += bytesWritten;
          }
        }
        await handle.sync();
        await handle.chmod(0o600);
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(path).catch(() => undefined);
        throw error;
      }
      await handle.close();
      const stat = await lstat(path);
      return { key, sizeBytes, modifiedAt: stat.mtime };
    },

    async publishTemporary(
      temporaryKey: TemporaryObjectKey,
      finalKey: FinalObjectKey,
      expectation: PublishExpectation,
    ): Promise<PublishResult> {
      const temporaryPath = keyPath(temporaryKey);
      const finalPath = keyPath(finalKey);
      const parsedTemporaryKey = parseObjectKey(temporaryKey);
      const parsedFinalKey = parseObjectKey(finalKey);
      if (
        (parsedTemporaryKey.kind !== 'temporary' && parsedTemporaryKey.kind !== 'url_temporary') ||
        (parsedFinalKey.kind !== 'final' && parsedFinalKey.kind !== 'url_final')
      )
        throw new ObjectStorageConflictError();
      const uploadPair =
        parsedTemporaryKey.kind === 'temporary' &&
        parsedFinalKey.kind === 'final' &&
        parsedTemporaryKey.uploadId === parsedFinalKey.uploadId;
      const urlPair =
        parsedTemporaryKey.kind === 'url_temporary' &&
        parsedFinalKey.kind === 'url_final' &&
        parsedTemporaryKey.ingestionId === parsedFinalKey.ingestionId &&
        parsedTemporaryKey.artifactKind === parsedFinalKey.artifactKind;
      if (
        (!uploadPair && !urlPair) ||
        parsedTemporaryKey.tenantId !== parsedFinalKey.tenantId ||
        parsedTemporaryKey.resourceId !== parsedFinalKey.resourceId ||
        parsedFinalKey.sha256 !== expectation.sha256
      ) {
        throw new ObjectStorageConflictError();
      }
      const temporaryStat = await assertSafeExistingFile(temporaryPath);
      if (!temporaryStat || Number(temporaryStat.size) !== expectation.sizeBytes) {
        throw new ObjectStorageConflictError();
      }
      const temporaryContent = await hashFile(temporaryPath);
      if (
        temporaryContent.sizeBytes !== expectation.sizeBytes ||
        temporaryContent.sha256 !== expectation.sha256
      ) {
        throw new ObjectStorageConflictError();
      }
      await prepareParents(finalPath);
      try {
        await chmod(temporaryPath, 0o600);
        await link(temporaryPath, finalPath);
        // Once the hard link is visible, publication is committed. A failed temporary unlink must
        // not turn a successful publish into an ambiguous error that a caller cannot compensate
        // without risking deletion of another worker's content-addressed object.
        await unlink(temporaryPath).catch(() => undefined);
        return { key: finalKey, outcome: 'published', ...expectation };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await assertSafeExistingFile(finalPath);
        const existing = await hashFile(finalPath);
        if (
          existing.sizeBytes !== expectation.sizeBytes ||
          existing.sha256 !== expectation.sha256
        ) {
          throw new ObjectStorageConflictError();
        }
        await unlink(temporaryPath).catch(() => undefined);
        return { key: finalKey, outcome: 'already_present', ...expectation };
      }
    },

    async open(key): Promise<OpenedStoredObject | null> {
      const path = keyPath(key);
      const stat = await assertSafeExistingFile(path);
      if (!stat) return null;
      return {
        key,
        sizeBytes: Number(stat.size),
        modifiedAt: stat.mtime,
        body: readFileBody(path),
      };
    },

    stat: objectStat,

    async delete(key): Promise<void> {
      const path = keyPath(key);
      const stat = await assertSafeExistingFile(path);
      if (!stat) return;
      await unlink(path);
    },
  };
}
