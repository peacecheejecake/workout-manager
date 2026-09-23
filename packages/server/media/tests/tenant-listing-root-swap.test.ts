import { randomUUID } from 'node:crypto';
import { realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createActivityTrackFinalObjectKey,
  createCourseThumbnailFinalObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createFinalObjectKey,
  createTemporaryObjectKey,
  tenantObjectPrefix,
  type ObjectKey,
} from '../src/keys.js';
import {
  createLocalFilesystemObjectStorage,
  UnsafeStoragePathError,
} from '../src/local-filesystem.js';

/**
 * The tenant listing's root guard (M2-01x), driven at exact calls (M2-01ab).
 *
 * The timing sweep in `tenant-listing.test.ts` swaps the root after k unrelated filesystem calls,
 * so where the swap lands depends on the thread pool. Here the two path calls the listing makes —
 * `lstat` and `readdir` — are wrapped, and the swap is made at a chosen call: before it is issued,
 * or after it has run but before the listing's code resumes. The last of those positions, after
 * the final root check, is the one the sweep's old verdict misread (M2-01ab): the swap is done
 * when the answer arrives, and the answer is still entirely the real store's.
 */
type FsHook = (operation: string, path: string) => void;
const hooks = vi.hoisted(() => ({
  before: null as FsHook | null,
  after: null as FsHook | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  function wrap<A extends [unknown, ...unknown[]], R>(
    operation: string,
    call: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    return async (...args) => {
      hooks.before?.(operation, String(args[0]));
      const result = await call(...args);
      hooks.after?.(operation, String(args[0]));
      return result;
    };
  }
  const lstat = wrap('lstat', actual.lstat);
  const readdir = wrap('readdir', actual.readdir);
  return { ...actual, default: { ...actual, lstat, readdir }, lstat, readdir };
});

const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const roots: string[] = [];
const sha256 = 'a'.repeat(64);
const id = () => randomUUID();

afterEach(async () => {
  hooks.before = null;
  hooks.after = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The store's own keys: resources and an activity track, at different depths. */
function ownKeys(): ObjectKey[] {
  const resourceId = id();
  return [
    createTemporaryObjectKey({ tenantId: tenant, resourceId, uploadId: id() }),
    createFinalObjectKey({
      tenantId: tenant,
      resourceId,
      uploadId: id(),
      sha256,
      extension: 'pdf',
    }),
    createTemporaryObjectKey({ tenantId: tenant, resourceId: id(), uploadId: id() }),
    createActivityTrackFinalObjectKey({
      tenantId: tenant,
      activityId: id(),
      trackId: id(),
      uploadId: id(),
      artifactKind: 'raw',
      sha256,
      extension: 'gpx',
    }),
  ];
}

/**
 * The link target's keys: the same tenant, but only under `courses/`, a directory the store does
 * not have. So the target shares no key with the store, and not even a name directly under the
 * tenant directory.
 */
function foreignKeys(): ObjectKey[] {
  const courseId = id();
  return [
    createCourseThumbnailTemporaryObjectKey({ tenantId: tenant, courseId, jobId: id() }),
    createCourseThumbnailFinalObjectKey({ tenantId: tenant, courseId, revisionId: id(), sha256 }),
    createCourseThumbnailTemporaryObjectKey({ tenantId: tenant, courseId: id(), jobId: id() }),
  ];
}

async function place(root: string, key: string, body: string): Promise<void> {
  const path = join(root, ...key.split('/'));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
}

/**
 * A store holding `own`, and next to it a directory holding `foreign` that the root can be
 * swapped for. Any foreign key in an answer was read through the link; an answer that is exactly
 * `own` was read from the real store.
 */
async function swappableStore() {
  const base = await mkdtemp(join(tmpdir(), 'workout-listing-swap-'));
  roots.push(base);
  const root = join(base, 'store');
  const copy = join(base, 'copy');
  const moved = join(base, 'moved');
  const storage = await createLocalFilesystemObjectStorage(root);
  // The paths the store itself walks: its root is canonical (macOS `tmpdir()` is a link).
  const canonicalRoot = realpathSync(root);
  const own = ownKeys();
  const foreign = foreignKeys();
  for (const key of own) await place(root, key, 'own');
  for (const key of foreign) await place(copy, key, 'foreign');
  return {
    storage,
    own,
    foreign,
    copy,
    canonicalRoot,
    tenantDirectory: join(canonicalRoot, ...tenantObjectPrefix(tenant).split('/')),
    swap: () => {
      renameSync(root, moved);
      symlinkSync(copy, root);
    },
    swapBack: () => {
      unlinkSync(root);
      renameSync(moved, root);
    },
  };
}

type Store = Awaited<ReturnType<typeof swappableStore>>;

/** How many `lstat`/`readdir` calls one listing of `store` makes, unswapped. */
async function callsOfOneListing(store: Store): Promise<number> {
  let calls = 0;
  hooks.before = () => {
    calls += 1;
  };
  try {
    await store.storage.listTenantObjects(tenant, 1000);
  } finally {
    hooks.before = null;
  }
  return calls;
}

async function outcomeOf(store: Store) {
  return store.storage.listTenantObjects(tenant, 1000).then(
    (listing) => ({ keys: [...listing.keys].sort() }),
    (error: unknown) => ({ error }),
  );
}

const refused = { error: expect.any(UnsafeStoragePathError) as unknown };

describe('the tenant listing under a root swapped at an exact call (M2-01ab)', () => {
  it('refuses a one-way swap before any of its calls, and answers the real store after the last', async () => {
    const probe = await swappableStore();
    const total = await callsOfOneListing(probe);
    expect(await outcomeOf(probe)).toEqual({ keys: [...probe.own].sort() });
    // The root twice, the tenant path's four components, and a readdir between two lstats
    // for every directory: a walk of real length.
    expect(total).toBeGreaterThan(40);

    for (let n = 0; n < total; n += 1) {
      const store = await swappableStore();
      let call = 0;
      hooks.before = () => {
        if (call === n) store.swap();
        call += 1;
      };
      const outcome = await outcomeOf(store);
      hooks.before = null;
      expect(call, `swap before call ${n}`).toBeGreaterThan(n);
      // Whatever the walk had read by then, at least the final root check follows the swap.
      expect(outcome, `swap before call ${n} of ${total}`).toEqual(refused);
    }

    // After the final root check has read the root, before the listing resumes. The swap is
    // done when the answer arrives — what the timing sweep's old verdict called "answered
    // through the link" — yet every name in it was read from the real store.
    const store = await swappableStore();
    let call = 0;
    hooks.after = () => {
      call += 1;
      if (call === total) store.swap();
    };
    const outcome = await outcomeOf(store);
    hooks.after = null;
    expect(call).toBe(total);
    expect(outcome).toEqual({ keys: [...store.own].sort() });
  }, 120_000);

  it('refuses a directory read through a root that was swapped around the read and back before the answer', async () => {
    // `readTenantDirectory`'s device/inode comparison, which the final root check does not
    // cover: the root is a link from just before the tenant directory's `readdir` until just
    // after the `lstat` that follows it, and real again by the final root check. The `readdir`
    // read the link target's names (only `courses`), which the real store does not have, so
    // without the comparison the walk would find nothing under them and answer "empty" — the
    // answer a purge records as a finished pass.
    const store = await swappableStore();
    let armed = false;
    hooks.before = (operation, path) => {
      if (operation === 'readdir' && path === store.tenantDirectory && !armed) {
        store.swap();
        armed = true;
      }
    };
    hooks.after = (operation, path) => {
      if (armed && operation === 'lstat' && path === store.tenantDirectory) {
        store.swapBack();
        hooks.after = null;
      }
    };
    const outcome = await outcomeOf(store);
    hooks.before = null;
    hooks.after = null;
    expect(armed).toBe(true);
    expect(outcome).toEqual(refused);
    expect(await outcomeOf(store)).toEqual({ keys: [...store.own].sort() });
  });

  it('residual (M2-01o): a swap away and back between the root checks is invisible, and a purge of what it named leaves the root alone', async () => {
    // The limit no path-based check can pass: the root is a link only between the listing's
    // first and final root checks, so both see the real directory, and every directory of
    // the link target is read consistently. This pins the documented residual instead of
    // hiding it — the answer is the link target's names. They are still names of THIS tenant
    // (every listed file must parse as its key). The delete half passes because the root is
    // real again when `delete` runs, so those names resolve against the real store and are
    // absent there; it does not exercise `delete`'s own root checks (M2-01o's tests do). The
    // next listing reads the real store again.
    const store = await swappableStore();
    let rootChecks = 0;
    hooks.before = (operation, path) => {
      if (operation !== 'lstat' || path !== store.canonicalRoot) return;
      rootChecks += 1;
      if (rootChecks === 2) store.swapBack();
    };
    hooks.after = (operation, path) => {
      if (operation === 'lstat' && path === store.canonicalRoot && rootChecks === 1) store.swap();
    };
    const outcome = await outcomeOf(store);
    hooks.before = null;
    hooks.after = null;
    expect(rootChecks).toBe(2);
    expect(outcome).toEqual({ keys: [...store.foreign].sort() });

    for (const key of store.foreign) await store.storage.delete(key);
    for (const key of store.foreign)
      expect(await readFile(join(store.copy, ...key.split('/')), 'utf8')).toBe('foreign');
    for (const key of store.own) expect(await store.storage.stat(key), key).not.toBeNull();
    expect(await outcomeOf(store)).toEqual({ keys: [...store.own].sort() });
  });
});
