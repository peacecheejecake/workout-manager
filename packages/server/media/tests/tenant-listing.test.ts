import { createHash, randomUUID } from 'node:crypto';
import { renameSync, symlinkSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  createCourseThumbnailFinalObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createFinalObjectKey,
  createGalleryFinalObjectKey,
  createGalleryTemporaryObjectKey,
  createTemporaryObjectKey,
  createUrlFinalObjectKey,
  createUrlTemporaryObjectKey,
  InvalidObjectKeyError,
  tenantObjectPrefix,
  type ObjectKey,
} from '../src/keys.js';
import {
  createLocalFilesystemObjectStorage,
  UnsafeStoragePathError,
} from '../src/local-filesystem.js';

// Two tenants whose ids differ only in the last character: as close as two canonical ids get.
const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const neighbour = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workout-tenant-listing-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** One key of every family this store writes, all for `tenantId`. */
function everyKeyOf(tenantId: string): ObjectKey[] {
  const id = () => randomUUID();
  const sha256 = hash(tenantId);
  const resourceId = id();
  const activityId = id();
  const trackId = id();
  const courseId = id();
  return [
    createTemporaryObjectKey({ tenantId, resourceId, uploadId: id() }),
    createFinalObjectKey({ tenantId, resourceId, uploadId: id(), sha256, extension: 'pdf' }),
    createGalleryTemporaryObjectKey({ tenantId, mediaItemId: id(), uploadId: id() }),
    createGalleryFinalObjectKey({
      tenantId,
      mediaItemId: id(),
      uploadId: id(),
      sha256,
      extension: 'png',
    }),
    createUrlTemporaryObjectKey({ tenantId, resourceId, ingestionId: id(), artifactKind: 'raw' }),
    createUrlFinalObjectKey({
      tenantId,
      resourceId,
      ingestionId: id(),
      artifactKind: 'parsed',
      sha256,
      extension: 'json',
    }),
    createActivityTrackTemporaryObjectKey({
      tenantId,
      activityId,
      trackId,
      uploadId: id(),
      artifactKind: 'raw',
    }),
    createActivityTrackFinalObjectKey({
      tenantId,
      activityId,
      trackId,
      uploadId: id(),
      artifactKind: 'raw',
      sha256,
      extension: 'gpx',
    }),
    createCourseThumbnailTemporaryObjectKey({ tenantId, courseId, jobId: id() }),
    createCourseThumbnailFinalObjectKey({ tenantId, courseId, revisionId: id(), sha256 }),
  ];
}

/** Put a file at a path under the root, creating its directories. */
async function place(root: string, relative: string, body = 'x'): Promise<string> {
  const path = join(root, ...relative.split('/'));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

const present = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

describe('listing one tenant’s objects (M2-01x)', () => {
  it('names every key of that tenant and nothing of anyone else’s', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = everyKeyOf(tenant);
    const theirs = everyKeyOf(neighbour);
    for (const key of [...own, ...theirs]) await place(root, key);
    // Directories whose names START with the tenant id but are not its directory. A walk
    // that compared strings instead of directories would enter both.
    const lookalikes = [
      `private/v1/tenants/${tenant}0/resources/${randomUUID()}/temporary/${randomUUID()}`,
      `private/v1/tenants/${tenant}-old/notes.txt`,
    ];
    for (const path of lookalikes) await place(root, path);
    // Inside the tenant's own directory: a file that is no key, a key-shaped path naming the
    // neighbour, and a directory chain deeper than any key.
    const foreignShaped = `${tenantObjectPrefix(tenant)}/courses/${randomUUID()}/thumbnails/temporary/${randomUUID()}.bak`;
    const inside = [
      `${tenantObjectPrefix(tenant)}/README`,
      `${tenantObjectPrefix(tenant)}/private/v1/tenants/${neighbour}/resources/${randomUUID()}/temporary/${randomUUID()}`,
      foreignShaped,
    ];
    for (const path of inside) await place(root, path);
    // Two files below a ninth level: the walk counts the directory once and does not enter it.
    await place(root, `${tenantObjectPrefix(tenant)}/a/b/c/d/e/f/g/h/i/deep-1`);
    await place(root, `${tenantObjectPrefix(tenant)}/a/b/c/d/e/f/g/h/i/deep-2`);

    const listing = await storage.listTenantObjects(tenant, 1000);
    expect([...listing.keys].sort()).toEqual([...own].sort());
    expect(listing.truncated).toBe(false);
    // README, the neighbour-shaped key (its path under this directory is not a key of this
    // tenant), the `.bak` file, and the one directory at depth nine.
    expect(listing.unrecognized).toBe(4);
  });

  it('purges only that tenant: the neighbour, the look-alikes, unknown files and shared directories stay', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = everyKeyOf(tenant);
    const theirs = everyKeyOf(neighbour);
    for (const key of [...own, ...theirs]) await place(root, key);
    const lookalike = await place(root, `private/v1/tenants/${tenant}0/README`);
    const unknown = await place(root, `${tenantObjectPrefix(tenant)}/README`);

    for (;;) {
      const listing = await storage.listTenantObjects(tenant, 3);
      if (listing.keys.length === 0) break;
      for (const key of listing.keys) await storage.delete(key);
    }

    for (const key of own) expect(await storage.stat(key), key).toBeNull();
    for (const key of theirs) expect(await storage.stat(key), key).not.toBeNull();
    expect(await present(lookalike)).toBe(true);
    expect(await present(unknown)).toBe(true);
    // The directories siblings share (M2-01n) are not removed by a purge either: a purge is
    // a sequence of ordinary deletes, each pruning only its own write unit's directories.
    for (const key of own) {
      const parts = String(key).split('/');
      // tenants/<t>/<owner kind>/<owner id> is shared by every unit of that owner.
      expect(await present(join(root, ...parts.slice(0, 6))), parts.slice(0, 6).join('/')).toBe(
        true,
      );
    }
    expect((await storage.listTenantObjects(tenant, 1000)).keys).toEqual([]);
  });

  it('stops at the limit and says so', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = everyKeyOf(tenant);
    for (const key of own) await place(root, key);
    const first = await storage.listTenantObjects(tenant, 4);
    expect(first.keys).toHaveLength(4);
    expect(first.truncated).toBe(true);
    const all = await storage.listTenantObjects(tenant, own.length);
    expect(all.keys).toHaveLength(own.length);
    await expect(storage.listTenantObjects(tenant, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(storage.listTenantObjects(tenant, 1001)).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses any tenant id that is not exactly a canonical one', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    for (const key of everyKeyOf(tenant)) await place(root, key);
    for (const bad of [
      tenant.toUpperCase(),
      tenant.slice(0, -1),
      `${tenant}0`,
      `${tenant}/..`,
      '..',
      '',
      'aaaaaaaa',
    ]) {
      await expect(storage.listTenantObjects(bad, 10), bad).rejects.toBeInstanceOf(
        InvalidObjectKeyError,
      );
    }
  });

  it('answers empty for a tenant with nothing, and rejects when the store itself is gone', async () => {
    const base = await newRoot();
    const root = join(base, 'store');
    const storage = await createLocalFilesystemObjectStorage(root);
    expect(await storage.listTenantObjects(tenant, 10)).toEqual({
      keys: [],
      unrecognized: 0,
      truncated: false,
    });
    await rename(root, `${root}.moved`);
    await expect(storage.listTenantObjects(tenant, 10)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symbolic link anywhere under the tenant, and on the way to it', async () => {
    const base = await newRoot();
    const root = join(base, 'store');
    const outside = join(base, 'outside');
    const storage = await createLocalFilesystemObjectStorage(root);
    const key = everyKeyOf(tenant)[0] as ObjectKey;
    await place(root, key);
    // Outside the store: a key-shaped tree of this tenant that a followed link would expose.
    const outsideObject = await place(
      outside,
      `resources/${randomUUID()}/temporary/${randomUUID()}`,
    );
    await symlink(join(outside, 'resources'), join(root, tenantObjectPrefix(tenant), 'resources2'));
    await expect(storage.listTenantObjects(tenant, 10)).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    expect(await present(outsideObject)).toBe(true);

    // The tenant directory itself a link.
    const other = await newRoot();
    const linked = await createLocalFilesystemObjectStorage(join(other, 'store'));
    await place(join(other, 'elsewhere'), 'resources/r/temporary/t');
    await mkdir(join(other, 'store', 'private', 'v1', 'tenants'), { recursive: true });
    await symlink(join(other, 'elsewhere'), join(other, 'store', tenantObjectPrefix(tenant)));
    await expect(linked.listTenantObjects(tenant, 10)).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
  });

  it('refuses to list through a root swapped for a link, and the deletes after it touch nothing there', async () => {
    const base = await newRoot();
    const root = join(base, 'store');
    const copy = join(base, 'copy');
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = everyKeyOf(tenant);
    for (const key of own) await place(root, key);
    const listed = await storage.listTenantObjects(tenant, 1000);
    await cp(root, copy, { recursive: true });
    await rename(root, `${root}.moved`);
    await symlink(copy, root);
    await expect(storage.listTenantObjects(tenant, 1000)).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    // A purge that listed before the swap and deletes after it: its first delete refuses.
    await expect(storage.delete(listed.keys[0] as ObjectKey)).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    for (const key of own) expect(await present(join(copy, ...String(key).split('/')))).toBe(true);
  });

  it('never answers a listing through a root swapped during the walk', async () => {
    // As in the M2-01o mid-operation sweep: a fresh store, and the root swapped ONE WAY, after
    // k other filesystem calls, for a link to a directory holding a DISJOINT set of this
    // tenant's keys. So the answer itself says where it was read: any key the store does not
    // hold came through the link, and an answer that is exactly the store's keys did not.
    //
    // The verdict is read from the answer, never from "was the swap done when the answer
    // arrived" (M2-01ab). The final root check is an `lstat` run on the thread pool; the swap
    // can land after that `lstat` has read the real root and before its result reaches the
    // listing. The swap is then done when the answer arrives, yet every name in the answer
    // was read before it. The old verdict counted that as "answered through the link" and
    // failed under machine load; the deterministic positions, that one included, are in
    // `tenant-listing-root-swap.test.ts`.
    async function attempt(ticks: number): Promise<string> {
      const base = await newRoot();
      const root = join(base, 'store');
      const elsewhere = join(base, 'elsewhere');
      const moved = join(base, 'moved');
      const storage = await createLocalFilesystemObjectStorage(root);
      const own = everyKeyOf(tenant);
      for (const key of own) await place(root, key);
      for (const key of everyKeyOf(tenant)) await place(elsewhere, key);
      const [observed] = await Promise.allSettled([
        storage.listTenantObjects(tenant, 1000),
        (async () => {
          for (let tick = 0; tick < ticks; tick += 1) await lstat(elsewhere);
          renameSync(root, moved);
          symlinkSync(elsewhere, root);
        })(),
      ]);
      if (observed.status === 'rejected') {
        const reason = observed.reason as NodeJS.ErrnoException;
        return `error ${reason.code ?? reason.name}`;
      }
      const answered = [...observed.value.keys].sort();
      if (answered.some((key) => !own.includes(key))) return 'ANSWERED THROUGH THE LINK';
      // Nothing foreign, and nothing of the store's missed either: a walk that read part of
      // the store and then part of the link target is not "from the real store".
      if (JSON.stringify(answered) !== JSON.stringify([...own].sort())) return 'ANSWERED PARTIALLY';
      return 'answered from the real store';
    }
    const counts: Record<string, number> = {};
    // A tenant walk makes a few hundred filesystem calls, so the delay spans that range.
    for (let ticks = 0; ticks <= 800; ticks += 5) {
      const outcome = await attempt(ticks);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    expect(counts['ANSWERED THROUGH THE LINK'] ?? 0, JSON.stringify(counts)).toBe(0);
    expect(counts['ANSWERED PARTIALLY'] ?? 0, JSON.stringify(counts)).toBe(0);
    expect(counts['answered from the real store'] ?? 0, JSON.stringify(counts)).toBeGreaterThan(0);
    expect(counts['error UNSAFE_STORAGE_PATH'] ?? 0, JSON.stringify(counts)).toBeGreaterThan(0);
  }, 120_000);
});
