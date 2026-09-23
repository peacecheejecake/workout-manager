import { constants } from 'node:fs';
import { access, chmod, link, lstat, mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

import { createHash } from 'node:crypto';

import {
  parseObjectKey,
  type ParsedObjectKey,
  type FinalObjectKey,
  type ObjectKey,
  type TemporaryObjectKey,
} from './keys.js';
import type {
  ObjectStorage,
  OpenedStoredObject,
  PublishExpectation,
  PublishResult,
  StoreReachability,
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

/**
 * `lstat`, answering "not there" instead of throwing when the path has gone.
 *
 * Every reader of this store races every deleter of it: the cleanup worker is a lease plus
 * `SKIP LOCKED` design, so several processes drain and sweep the same namespace at once, and
 * `delete` prunes the directories above an object as well as the object itself. A reader
 * walking a path while a deleter unlinks under it is normal operation, not an anomaly — and
 * the truthful answer to "is this object there" in that moment is "no", not an exception.
 *
 * Reproduced on the real filesystem before this existed: 5,000 `stat`/`delete` pairs on the
 * same key produced 2 `ENOENT: … lstat` throws out of `assertSafeExistingFile`, and driving
 * the race deliberately (below, in the media tests) hits it on roughly a third of attempts.
 *
 * ONLY `ENOENT` is absorbed. `EACCES`, `ELOOP`, `EIO` and the rest still throw: this function
 * sits inside the symlink and permission guard of `assertSafeExistingFile`, and turning any
 * of those into "absent" would disable the guard silently instead of failing loudly.
 */
async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
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

/**
 * How many directories directly above an object belong to that object's write unit alone,
 * and so may be pruned when it is deleted (M2-01n). Everything above them is shared with
 * sibling units and is never removed.
 *
 * A write unit is what one writer owns at a time: an upload, a URL ingestion, a course
 * revision's render. Its directories are named by the unit's own id, and only the unit's own
 * writer — or, after that writer is finished or abandoned, the cleanup of the same unit —
 * ever creates or deletes anything beneath them. The directories that hold several units side
 * by side (`temporary/`, `uploads/`, `url-ingestions/`, `revisions/`, and every owner and
 * tenant level above them) are where sibling writes and deletes meet, so they stay.
 *
 * A temporary object that sits directly in its shared `temporary/` directory therefore prunes
 * nothing: there is no directory above it that is its own.
 */
function unitPrivateDirectoryDepth(parsed: ParsedObjectKey): number {
  switch (parsed.kind) {
    // resources/R/temporary/<upload>, gallery/M/temporary/<upload>,
    // courses/C/thumbnails/temporary/<job>
    case 'temporary':
    case 'gallery_temporary':
    case 'course_thumbnail_temporary':
      return 0;
    // resources/R/objects/uploads/<upload>/sha256/<hash>.<ext>   (same for gallery)
    case 'final':
    case 'gallery_final':
      return 2;
    // resources/R/url-ingestions/<ingestion>/temporary/<kind>
    case 'url_temporary':
      return 2;
    // resources/R/url-ingestions/<ingestion>/<kind>/sha256/<hash>.<ext>
    case 'url_final':
      return 3;
    // activities/A/tracks/T/temporary/<upload>/<kind>
    case 'track_temporary':
      return 1;
    // activities/A/tracks/T/<kind>/uploads/<upload>/sha256/<hash>.<ext>
    case 'track_final':
      return 2;
    // courses/C/thumbnails/revisions/<revision>/sha256/<hash>.svg — a revision has one render
    // row, so its directory has one writer at a time.
    case 'course_thumbnail_final':
      return 2;
    default:
      return parsed satisfies never;
  }
}

export async function createLocalFilesystemObjectStorage(
  rootDirectory: string,
): Promise<ObjectStorage & StoreReachability> {
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
      // One `lstat`, not an existence probe followed by a second one: the gap between those
      // two was itself the window a concurrent delete fell into.
      const stat = await lstatIfPresent(current);
      if (stat === null) return null;
      if (stat.isSymbolicLink()) throw new UnsafeStoragePathError();
      if (current !== path && !stat.isDirectory()) throw new UnsafeStoragePathError();
      if (current === path && !stat.isFile()) throw new UnsafeStoragePathError();
    }
    // The walk proved this path safe a moment ago; a delete can still have landed since, and
    // that makes the object absent rather than the call an error.
    return lstatIfPresent(path);
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

  /**
   * Remove the directories an unlink has just emptied, innermost first — but only the ones
   * that belong to the deleted object's own write unit, never a directory siblings share.
   * Deleting objects would otherwise leave the namespace growing in empty directories
   * without limit. This is hygiene, not a bound: nothing depends on it.
   *
   * Why a floor rather than "stop at the first directory that is not empty" (M2-01n): a
   * directory is empty for exactly as long as no sibling has been written into it yet, and
   * a sibling writer walks its parents in `prepareParents` before it creates anything. So a
   * delete that prunes a shared directory tears it down under a concurrent sibling write,
   * and that write fails at whichever step it had reached — `mkdir` (ENOENT, or EINVAL on
   * macOS when the parent is removed mid-create), `lstat`, `chmod` or `open`. Measured before
   * this floor with four processes writing and deleting sibling course-thumbnail temporaries:
   * ~5% of operations failed, at every level from `private/` down to `temporary/`.
   *
   * The floor removes the race rather than tolerating it: no directory any other write unit
   * can be writing into is ever removed, so there is nothing for `prepareParents` to lose
   * and none of its errors needs to be reinterpreted. `prepareParents` is unchanged, which
   * is the point — it is the symlink guard, and absorbing `mkdir` errors inside it would
   * mean deciding what a macOS EINVAL "really" means there. What stays behind is bounded by
   * the number of owning entities (tenant, resource, gallery item, activity track, course),
   * not by the number of objects ever written.
   */
  async function pruneEmptyParents(path: string, key: ObjectKey): Promise<void> {
    let current = dirname(path);
    for (let depth = unitPrivateDirectoryDepth(parseObjectKey(key)); depth > 0; depth -= 1) {
      if (!current.startsWith(`${canonicalRoot}${sep}`)) return;
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  }

  return {
    async writeTemporary(key, body) {
      const parsedKey = parseObjectKey(key);
      if (
        parsedKey.kind !== 'temporary' &&
        parsedKey.kind !== 'url_temporary' &&
        parsedKey.kind !== 'gallery_temporary' &&
        parsedKey.kind !== 'track_temporary' &&
        parsedKey.kind !== 'course_thumbnail_temporary'
      )
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
        (parsedTemporaryKey.kind !== 'temporary' &&
          parsedTemporaryKey.kind !== 'url_temporary' &&
          parsedTemporaryKey.kind !== 'gallery_temporary' &&
          parsedTemporaryKey.kind !== 'track_temporary' &&
          parsedTemporaryKey.kind !== 'course_thumbnail_temporary') ||
        (parsedFinalKey.kind !== 'final' &&
          parsedFinalKey.kind !== 'url_final' &&
          parsedFinalKey.kind !== 'gallery_final' &&
          parsedFinalKey.kind !== 'track_final' &&
          parsedFinalKey.kind !== 'course_thumbnail_final')
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
      const galleryPair =
        parsedTemporaryKey.kind === 'gallery_temporary' &&
        parsedFinalKey.kind === 'gallery_final' &&
        parsedTemporaryKey.uploadId === parsedFinalKey.uploadId;
      // A track upload publishes three objects from one upload; the artifact kind and the
      // track id must agree as well, so a normalized derivative can never be published
      // over the original file's key.
      const trackPair =
        parsedTemporaryKey.kind === 'track_temporary' &&
        parsedFinalKey.kind === 'track_final' &&
        parsedTemporaryKey.uploadId === parsedFinalKey.uploadId &&
        parsedTemporaryKey.trackId === parsedFinalKey.trackId &&
        parsedTemporaryKey.artifactKind === parsedFinalKey.artifactKind;
      // A course thumbnail's temporary name belongs to the render job and its final name to
      // the revision it depicts, so the two cannot be matched on an upload id. What must
      // agree is the course, checked as the owner id below, and the tenant.
      const courseThumbnailPair =
        parsedTemporaryKey.kind === 'course_thumbnail_temporary' &&
        parsedFinalKey.kind === 'course_thumbnail_final';
      const temporaryOwnerId =
        parsedTemporaryKey.kind === 'gallery_temporary'
          ? parsedTemporaryKey.mediaItemId
          : parsedTemporaryKey.kind === 'track_temporary'
            ? parsedTemporaryKey.activityId
            : parsedTemporaryKey.kind === 'course_thumbnail_temporary'
              ? parsedTemporaryKey.courseId
              : parsedTemporaryKey.resourceId;
      const finalOwnerId =
        parsedFinalKey.kind === 'gallery_final'
          ? parsedFinalKey.mediaItemId
          : parsedFinalKey.kind === 'track_final'
            ? parsedFinalKey.activityId
            : parsedFinalKey.kind === 'course_thumbnail_final'
              ? parsedFinalKey.courseId
              : parsedFinalKey.resourceId;
      if (
        (!uploadPair && !urlPair && !galleryPair && !trackPair && !courseThumbnailPair) ||
        parsedTemporaryKey.tenantId !== parsedFinalKey.tenantId ||
        temporaryOwnerId !== finalOwnerId ||
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

    /**
     * The root, asked directly and through the same guards as every other path: `lstat`
     * refuses a root that became a symbolic link, `open` with `O_NOFOLLOW | O_DIRECTORY`
     * refuses one swapped in between, and `access` asks for exactly what a `stat` below the
     * root needs — search and read. Nothing is absorbed: ENOENT here means the store is
     * missing, not empty, and it rejects like EACCES or EIO.
     */
    async assertReachable(): Promise<void> {
      const rootStat = await lstat(canonicalRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new UnsafeStoragePathError();
      const handle = await open(
        canonicalRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        if (!(await handle.stat()).isDirectory()) throw new UnsafeStoragePathError();
      } finally {
        await handle.close();
      }
      await access(canonicalRoot, constants.R_OK | constants.X_OK);
    },

    async delete(key): Promise<void> {
      const path = keyPath(key);
      const stat = await assertSafeExistingFile(path);
      if (!stat) return;
      await unlink(path);
      await pruneEmptyParents(path, key);
    },
  };
}
