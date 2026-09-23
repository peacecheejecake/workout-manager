import { constants } from 'node:fs';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

import { createHash } from 'node:crypto';

import {
  isObjectKeyOfScope,
  objectScopePrefix,
  parseObjectKey,
  tenantObjectPrefix,
  type ObjectScope,
  type ParsedObjectKey,
  type FinalObjectKey,
  type ObjectKey,
  type TemporaryObjectKey,
} from './keys.js';
import type {
  ObjectScopeEnumeration,
  ObjectStorage,
  OpenedStoredObject,
  PublishExpectation,
  PublishResult,
  StoreReachability,
  StoredObjectStat,
  TenantObjectEnumeration,
  TenantObjectListing,
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

/**
 * How many directory levels below a tenant's own directory any key reaches (M2-01x). The
 * deepest keys are a track's final objects, `activities/A/tracks/T/<kind>/uploads/U/sha256/`
 * and then the file: eight levels. A tenant walk never descends further, since nothing it could
 * find down there is a key.
 */
const TENANT_DIRECTORY_DEPTH = 8;

/**
 * The same bound below one scope's own directory (M2-01y). An activity's deepest keys are its
 * track's final objects, `tracks/T/<kind>/uploads/U/sha256/` and then the file: six levels. A
 * course's are its pictures, `thumbnails/revisions/R/sha256/` and then the file: four.
 */
const SCOPE_DIRECTORY_DEPTH: Readonly<Record<ObjectScope['kind'], number>> = {
  activity: 6,
  course: 4,
};

/** Whether a path the walk found is an object key, and one of this tenant's (M2-01x). */
function isObjectKeyOfTenant(key: string, tenantId: string): boolean {
  try {
    return parseObjectKey(key).tenantId === tenantId;
  } catch {
    return false;
  }
}

export async function createLocalFilesystemObjectStorage(
  rootDirectory: string,
): Promise<ObjectStorage & StoreReachability & TenantObjectEnumeration & ObjectScopeEnumeration> {
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

  /**
   * The root itself, `lstat`ed on every walk (M2-01o).
   *
   * Every walk below starts at `canonicalRoot` and `lstat`s the components under it, but the
   * root is a non-final component of each of those paths, so the kernel follows it. A root
   * swapped for a symbolic link after this store was created was therefore followed without a
   * word — measured before this check: with the root pointing at an empty directory, `stat`,
   * `open` and `delete` answered "absent" for an object that exists; `writeTemporary` created
   * the whole key path and the object inside the link's target; and with the root pointing at
   * a copy, `publishTemporary` published into the copy and `delete` removed the copy's object. "The root moved" was being reported as "the
   * object is not there", which a reconciliation sweep then acts on.
   *
   * Unlike a reference's own components, a missing root is not "absent" and does not go
   * through `lstatIfPresent`: ENOENT here means the store is gone — an unmounted volume, a
   * wrong path — and rejects like EACCES or EIO, the same line `assertReachable` draws.
   *
   * `lstat` never reports a symbolic link as a directory, so `!isDirectory()` refuses a link,
   * a regular file and anything else alike.
   *
   * What this cannot prevent, only report. Every operation here is path-based — the walk's
   * `lstat`s, `mkdir`, `chmod`, `open`, `link`, `unlink` — and Node has no `openat` to anchor
   * them to a root descriptor. So a swap that lands after this check and before an
   * operation's last path call is followed by every call after it, and a ONE-WAY swap is
   * enough; no swap back is needed. The window is not "one walk": it spans many event-loop
   * turns and thread-pool calls (about eleven `lstat`s, then `mkdir`, `chmod`, `open` …).
   * Measured by the independent review against the first version of this check (root swapped
   * once, for a link to a copy of the store, after k = 0..40 `setImmediate` ticks; 615
   * attempts per operation): `writeTemporary` wrote into the copy 471 times, `publishTemporary`
   * published into it 267 times, `delete` removed the copy's object 193 times, and `stat`
   * returned the copy's object 579 times.
   *
   * What is done about it: every operation asks again AFTER its last path call — after the
   * write, the link, the unlink, the open of a body — and rejects with this error if the root
   * is no longer intact. The side effect outside the root has then already happened and is
   * NOT undone: undoing it would be another path-based call through the same link, touching
   * the outside again. What this buys is that no swap that persists past the operation ends
   * in a silent success. The one case it cannot see is a root swapped away and back again
   * inside a single operation — the same directory to any path-based check (measured with a
   * loop swapping continuously under load: 3 of 72,000 `stat`s read as absent, 0 of 24,000
   * unloaded).
   */
  async function assertRootIntact(): Promise<void> {
    const stat = await lstat(canonicalRoot);
    if (!stat.isDirectory()) throw new UnsafeStoragePathError();
  }

  async function prepareParents(path: string): Promise<void> {
    await assertRootIntact();
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
    await assertRootIntact();
    const relativeParts = path.slice(canonicalRoot.length + 1).split(sep);
    let current = canonicalRoot;
    for (const part of relativeParts) {
      current = resolve(current, part);
      // One `lstat`, not an existence probe followed by a second one: the gap between those
      // two was itself the window a concurrent delete fell into.
      const stat = await lstatIfPresent(current);
      if (stat === null) return absentUnderIntactRoot();
      if (stat.isSymbolicLink()) throw new UnsafeStoragePathError();
      if (current !== path && !stat.isDirectory()) throw new UnsafeStoragePathError();
      if (current === path && !stat.isFile()) throw new UnsafeStoragePathError();
    }
    // The walk proved this path safe a moment ago; a delete can still have landed since, and
    // that makes the object absent rather than the call an error.
    const stat = await lstatIfPresent(path);
    // Either answer was read through the root's path, so the root is asked again before it
    // is given: an object seen through a root swapped mid-walk is not this store's (M2-01o).
    await assertRootIntact();
    return stat;
  }

  /**
   * "Absent" is the one answer a caller acts on without touching the object — a sweep settles
   * on it — so it is only given after the root is asked again: an absence seen through a root
   * that was swapped mid-walk rejects instead (M2-01o). Costs one `lstat`, on this path only.
   */
  async function absentUnderIntactRoot(): Promise<null> {
    await assertRootIntact();
    return null;
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
      // The handle is bound to whatever the path named at `open`; if the root was intact
      // after that, the bytes read through it are this store's (M2-01o).
      await assertRootIntact();
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
      await assertRootIntact(); // as in `hashFile` (M2-01o)
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

  /**
   * The names in one directory of a tenant walk, or null when the directory has gone (M2-01x).
   *
   * `readdir` is path-based and follows a symbolic link in its last component, so the directory
   * is `lstat`ed on both sides of the read: it has to be a directory — never a link — before,
   * and still the same directory (device and inode) after. A directory swapped for a link, or
   * swapped away and back for another one, around the read is refused rather than listed. Only
   * ENOENT is read as "gone", as everywhere in this file.
   */
  async function readTenantDirectory(directory: string): Promise<string[] | null> {
    const before = await lstatIfPresent(directory);
    if (before === null) return null;
    if (!before.isDirectory()) throw new UnsafeStoragePathError();
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const after = await lstatIfPresent(directory);
    if (after === null) return null;
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino)
      throw new UnsafeStoragePathError();
    return names.sort();
  }

  /**
   * Every object key under one tenant's prefix, up to `limit` (M2-01x).
   *
   * What it walks. Exactly the directory `private/v1/tenants/<tenant>`, reached component by
   * component from the root the way every key is: each component `lstat`ed, a link or a
   * non-directory refused. The walk is by directory, never by string prefix, so a tenant whose
   * id another id starts with is a different directory and is never entered; and every file it
   * reports must parse as an object key naming this same tenant. A file that is not such a key
   * is counted as unrecognized and left alone, and so is a directory deeper than any key goes.
   *
   * The root (M2-01o), exactly as for every other operation here: asked before the walk,
   * and again before the answer — including the answer "this tenant has nothing", which a
   * purge would otherwise record as a finished pass. A root swapped mid-walk rejects.
   *
   * What it does not do is delete, and that is the point of the split. Everything this returns
   * is a name. The caller deletes each one through `delete`, which re-walks the key from the
   * root with its own guards (M2-01m's single `lstat` per component, M2-01n's prune floor,
   * M2-01o's root checks before, before answering, and after the unlink). So a listing read
   * through a directory swapped under the walk can at worst name keys; it cannot make a
   * deletion leave the root or follow a link, and nothing about those guards changes here.
   *
   * Symbolic links, sockets, FIFOs and devices under the prefix reject the walk, as a link in a
   * key's path rejects `stat`: a purge stops loudly rather than skipping past what it cannot
   * explain.
   */
  async function listTenantObjects(tenantId: string, limit: number): Promise<TenantObjectListing> {
    const prefix = tenantObjectPrefix(tenantId);
    return listObjectsBelow(prefix, limit, TENANT_DIRECTORY_DEPTH, (key) =>
      isObjectKeyOfTenant(key, tenantId),
    );
  }

  /**
   * Every object key under one activity's or one course's prefix, up to `limit` (M2-01y).
   *
   * The tenant walk above, with a narrower directory and a narrower test: the walk starts at
   * `private/v1/tenants/<tenant>/activities/<activity>` (or `…/courses/<course>`), reached
   * component by component from the root under the same guards, descends no deeper than any
   * key of that scope goes, and reports only a file that parses as a key of that scope's own
   * families naming that same tenant and that same activity or course. Everything else under
   * the directory is counted as unrecognized and left alone.
   */
  async function listScopeObjects(scope: ObjectScope, limit: number): Promise<TenantObjectListing> {
    const prefix = objectScopePrefix(scope);
    return listObjectsBelow(prefix, limit, SCOPE_DIRECTORY_DEPTH[scope.kind], (key) =>
      isObjectKeyOfScope(key, scope),
    );
  }

  /**
   * The walk both listings share (M2-01x, generalized by M2-01y without changing a guard):
   * `prefix` is an already validated canonical prefix, `maxDepth` the deepest directory level
   * below it any key reaches, and `belongs` whether a file found there is a key to report.
   */
  async function listObjectsBelow(
    prefix: string,
    limit: number,
    maxDepth: number,
    belongs: (key: string) => boolean,
  ): Promise<TenantObjectListing> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError('Listing limit must be an integer from 1 to 1000.');
    const prefixDirectory = resolve(canonicalRoot, ...prefix.split('/'));
    if (!prefixDirectory.startsWith(`${canonicalRoot}${sep}`)) throw new UnsafeStoragePathError();
    await assertRootIntact();
    let current = canonicalRoot;
    for (const part of prefix.split('/')) {
      current = resolve(current, part);
      const stat = await lstatIfPresent(current);
      if (stat === null) {
        await assertRootIntact();
        return { keys: [], unrecognized: 0, truncated: false };
      }
      if (!stat.isDirectory()) throw new UnsafeStoragePathError();
    }
    const keys: ObjectKey[] = [];
    let unrecognized = 0;
    let truncated = false;
    const visit = async (directory: string, keyPrefix: string, depth: number): Promise<void> => {
      const names = await readTenantDirectory(directory);
      if (names === null) return;
      for (const name of names) {
        if (keys.length >= limit) {
          truncated = true;
          return;
        }
        const path = resolve(directory, name);
        if (dirname(path) !== directory) throw new UnsafeStoragePathError();
        const stat = await lstatIfPresent(path);
        if (stat === null) continue;
        if (stat.isSymbolicLink()) throw new UnsafeStoragePathError();
        const key = `${keyPrefix}/${name}`;
        if (stat.isDirectory()) {
          if (depth + 1 > maxDepth) unrecognized += 1;
          else await visit(path, key, depth + 1);
          if (truncated) return;
        } else if (stat.isFile()) {
          if (belongs(key)) keys.push(key as ObjectKey);
          else unrecognized += 1;
        } else {
          throw new UnsafeStoragePathError();
        }
      }
    };
    await visit(prefixDirectory, prefix, 0);
    // Before the answer (M2-01o): names read through a root swapped mid-walk are not this
    // store's, and an empty listing read that way is not "nothing left".
    await assertRootIntact();
    return { keys, unrecognized, truncated };
  }

  return {
    listTenantObjects,
    listScopeObjects,

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
      // After the last path call (M2-01o): a root swapped since `prepareParents` means the
      // object may have been written through the link. Nothing is undone — an unlink would
      // follow the same link — but the write does not report success.
      await assertRootIntact();
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
        // After the link and unlink (M2-01o): see `writeTemporary`. A publish through a swapped
        // root does not report success; its final name is already recorded by the caller's
        // durable manifest, which is what reclaims an object this leaves behind.
        await assertRootIntact();
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
        await assertRootIntact(); // as after a publish (M2-01o)
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
     * The root, asked directly and through the same guards as every other path. Nothing is
     * absorbed: ENOENT here means the store is missing, not empty, and it rejects like EACCES
     * or EIO.
     *
     * Order (M2-01o): `lstat` refuses a root that is a symbolic link or not a directory; then
     * `access`; then `open` with `O_NOFOLLOW | O_DIRECTORY` and `fstat` on that handle. `access`
     * works by path and follows a link — Node has no descriptor-based `faccessat` — so it goes
     * before the `open`, and the last, authoritative check is on the directory actually opened
     * rather than on whatever the path named after the handle was closed.
     *
     * What is asked of the root: search (`X_OK`) is what every operation below it needs — a
     * `stat` of an object needs only search on the directories above it, not read. Read
     * (`R_OK`) is also required, deliberately: the `open(O_RDONLY | O_DIRECTORY)` that makes
     * the last check descriptor-based needs it (there is no `O_SEARCH` in Node), and a root
     * this store created `0o700` and has since lost read on was changed by someone after
     * start. So a search-only (`0o100`) root is refused although a `stat` below it would work
     * — an error on the side of reporting the store unreachable, never on the side of reading
     * an unreadable store as empty.
     */
    async assertReachable(): Promise<void> {
      await assertRootIntact();
      await access(canonicalRoot, constants.R_OK | constants.X_OK);
      const handle = await open(
        canonicalRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        if (!(await handle.stat()).isDirectory()) throw new UnsafeStoragePathError();
      } finally {
        await handle.close();
      }
    },

    async delete(key): Promise<void> {
      const path = keyPath(key);
      const stat = await assertSafeExistingFile(path);
      if (!stat) return;
      await unlink(path);
      await pruneEmptyParents(path, key);
      // After the unlink and the prune (M2-01o): a delete through a swapped root removed
      // something outside this store and must not report success.
      await assertRootIntact();
    },
  };
}
