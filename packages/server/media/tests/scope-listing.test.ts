import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  createCourseThumbnailFinalObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createTemporaryObjectKey,
  InvalidObjectKeyError,
  isObjectKeyOfScope,
  objectScopePrefix,
  type ObjectKey,
  type ObjectScope,
} from '../src/keys.js';
import {
  createLocalFilesystemObjectStorage,
  UnsafeStoragePathError,
} from '../src/local-filesystem.js';

/**
 * M2-01y: listing one activity's (or one course's) objects, by its own directory.
 *
 * The ids are chosen as close as canonical ids get: two tenants and two activities that differ
 * only in the last character, and a course that has the SAME id as the activity — a walk that
 * compared strings, or kinds loosely, would cross into each of them.
 */
const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const neighbour = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const activity = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sibling = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
const course = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const activityScope: ObjectScope = { kind: 'activity', tenantId: tenant, activityId: activity };
const courseScope: ObjectScope = { kind: 'course', tenantId: tenant, courseId: course };
const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workout-scope-listing-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Every key a recorded track of this activity writes: three temporary and three final. */
function trackKeysOf(tenantId: string, activityId: string): ObjectKey[] {
  const trackId = randomUUID();
  const uploadId = randomUUID();
  const parts = { tenantId, activityId, trackId, uploadId };
  return [
    createActivityTrackTemporaryObjectKey({ ...parts, artifactKind: 'raw' }),
    createActivityTrackTemporaryObjectKey({ ...parts, artifactKind: 'normalized' }),
    createActivityTrackTemporaryObjectKey({ ...parts, artifactKind: 'map_path' }),
    createActivityTrackFinalObjectKey({
      ...parts,
      artifactKind: 'raw',
      sha256: hash(`${activityId}raw`),
      extension: 'fit',
    }),
    createActivityTrackFinalObjectKey({
      ...parts,
      artifactKind: 'normalized',
      sha256: hash(`${activityId}normalized`),
      extension: 'json',
    }),
    createActivityTrackFinalObjectKey({
      ...parts,
      artifactKind: 'map_path',
      sha256: hash(`${activityId}map_path`),
      extension: 'json',
    }),
  ];
}

/** Every key a course's pictures write: a render's temporary object and a revision's picture. */
function thumbnailKeysOf(tenantId: string, courseId: string): ObjectKey[] {
  return [
    createCourseThumbnailTemporaryObjectKey({ tenantId, courseId, jobId: randomUUID() }),
    createCourseThumbnailFinalObjectKey({
      tenantId,
      courseId,
      revisionId: randomUUID(),
      sha256: hash(courseId),
    }),
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

/** What surrounds the scope: everything a purge of it must leave alone. */
function surroundings(): ObjectKey[] {
  return [
    ...trackKeysOf(tenant, sibling),
    ...trackKeysOf(neighbour, activity),
    ...thumbnailKeysOf(tenant, activity),
    ...thumbnailKeysOf(tenant, `${course.slice(0, -1)}d`),
    ...thumbnailKeysOf(neighbour, course),
    createTemporaryObjectKey({ tenantId: tenant, resourceId: activity, uploadId: randomUUID() }),
  ];
}

describe('listing one scope’s objects (M2-01y)', () => {
  it('names every key of that activity and nothing of anyone else’s', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = trackKeysOf(tenant, activity);
    for (const key of [...own, ...surroundings()]) await place(root, key);
    // A directory whose name starts with the activity id but is not its directory.
    await place(
      root,
      `private/v1/tenants/${tenant}/activities/${activity}0/tracks/${randomUUID()}/temporary/${randomUUID()}/raw`,
    );
    // Inside the activity's own directory: a file that is no key, a path shaped like another
    // tenant's key, and a directory chain deeper than any key of an activity.
    const prefix = objectScopePrefix(activityScope);
    await place(root, `${prefix}/README`);
    await place(
      root,
      `${prefix}/private/v1/tenants/${neighbour}/activities/${activity}/tracks/${randomUUID()}/temporary/${randomUUID()}/raw`,
    );
    await place(root, `${prefix}/tracks/${randomUUID()}/temporary/${randomUUID()}/raw.bak`);
    await place(root, `${prefix}/a/b/c/d/e/f/g/deep-1`);
    await place(root, `${prefix}/a/b/c/d/e/f/g/deep-2`);

    const listing = await storage.listScopeObjects(activityScope, 1000);
    expect([...listing.keys].sort()).toEqual([...own].sort());
    expect(listing.truncated).toBe(false);
    // README, the `.bak` file, the one directory at depth seven — and the neighbour-shaped
    // path, whose chain reaches that same depth-seven limit and is counted there once.
    expect(listing.unrecognized).toBe(4);
  });

  it('names every picture of that course and nothing of anyone else’s', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = thumbnailKeysOf(tenant, course);
    for (const key of [...own, ...surroundings(), ...trackKeysOf(tenant, activity)])
      await place(root, key);
    const prefix = objectScopePrefix(courseScope);
    await place(root, `${prefix}/thumbnails/temporary/not-a-job`);
    await place(root, `${prefix}/a/b/c/d/e/deep-1`);
    await place(root, `${prefix}/a/b/c/d/e/deep-2`);

    const listing = await storage.listScopeObjects(courseScope, 1000);
    expect([...listing.keys].sort()).toEqual([...own].sort());
    // The non-key file and the one directory at depth five, counted once and not entered.
    expect(listing.unrecognized).toBe(2);
  });

  it('purges only that scope: siblings, neighbours, look-alikes and shared directories stay', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = trackKeysOf(tenant, activity);
    const others = surroundings();
    for (const key of [...own, ...others]) await place(root, key);
    const lookalike = await place(root, `private/v1/tenants/${tenant}/activities/${activity}0/x`);
    const unknown = await place(root, `${objectScopePrefix(activityScope)}/README`);

    for (;;) {
      const listing = await storage.listScopeObjects(activityScope, 2);
      if (listing.keys.length === 0) break;
      for (const key of listing.keys) await storage.delete(key);
    }

    for (const key of own) expect(await storage.stat(key), key).toBeNull();
    for (const key of others) expect(await storage.stat(key), key).not.toBeNull();
    expect(await present(lookalike)).toBe(true);
    expect(await present(unknown)).toBe(true);
    // The tenant's `activities` directory and the activity's own directory are shared by
    // every write unit under them (M2-01n); a purge is ordinary deletes and prunes neither.
    expect(await present(join(root, ...objectScopePrefix(activityScope).split('/')))).toBe(true);
    expect((await storage.listScopeObjects(activityScope, 1000)).keys).toEqual([]);
  });

  it('stops at the limit and says so', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = trackKeysOf(tenant, activity);
    for (const key of own) await place(root, key);
    const first = await storage.listScopeObjects(activityScope, 4);
    expect(first.keys).toHaveLength(4);
    expect(first.truncated).toBe(true);
    await expect(storage.listScopeObjects(activityScope, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(storage.listScopeObjects(activityScope, 1001)).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses any tenant, activity or course id that is not exactly a canonical one', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    for (const key of trackKeysOf(tenant, activity)) await place(root, key);
    const bad = [
      activity.toUpperCase(),
      activity.slice(0, -1),
      `${activity}0`,
      `${activity}/..`,
      '..',
      '',
    ];
    const scopes: ObjectScope[] = [
      ...bad.map((id): ObjectScope => ({ kind: 'activity', tenantId: tenant, activityId: id })),
      ...bad.map((id): ObjectScope => ({ kind: 'course', tenantId: tenant, courseId: id })),
      ...bad.map((id): ObjectScope => ({ kind: 'activity', tenantId: id, activityId: activity })),
      { kind: 'other', tenantId: tenant, activityId: activity } as unknown as ObjectScope,
    ];
    for (const scope of scopes)
      await expect(
        storage.listScopeObjects(scope, 10),
        JSON.stringify(scope),
      ).rejects.toBeInstanceOf(InvalidObjectKeyError);
  });

  it('answers empty for a scope with nothing, and rejects when the store itself is gone', async () => {
    const base = await newRoot();
    const root = join(base, 'store');
    const storage = await createLocalFilesystemObjectStorage(root);
    expect(await storage.listScopeObjects(activityScope, 10)).toEqual({
      keys: [],
      unrecognized: 0,
      truncated: false,
    });
    await rename(root, `${root}.moved`);
    await expect(storage.listScopeObjects(activityScope, 10)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses a symbolic link under the scope and in its place', async () => {
    const base = await newRoot();
    const root = join(base, 'store');
    const outside = join(base, 'outside');
    const storage = await createLocalFilesystemObjectStorage(root);
    await place(root, trackKeysOf(tenant, activity)[0] as ObjectKey);
    const outsideObject = await place(outside, `temporary/${randomUUID()}/raw`);
    await symlink(outside, join(root, objectScopePrefix(activityScope), 'tracks', 'linked'));
    await expect(storage.listScopeObjects(activityScope, 10)).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    expect(await present(outsideObject)).toBe(true);

    // The activity directory itself a link.
    const other = await newRoot();
    const linked = await createLocalFilesystemObjectStorage(join(other, 'store'));
    await place(join(other, 'elsewhere'), `tracks/${randomUUID()}/temporary/${randomUUID()}/raw`);
    await mkdir(join(other, 'store', 'private', 'v1', 'tenants', tenant, 'activities'), {
      recursive: true,
    });
    await symlink(join(other, 'elsewhere'), join(other, 'store', objectScopePrefix(activityScope)));
    await expect(linked.listScopeObjects(activityScope, 10)).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
  });

  it('refuses to list through a root swapped for a link', async () => {
    const base = await newRoot();
    const root = join(base, 'store');
    const copy = join(base, 'copy');
    const storage = await createLocalFilesystemObjectStorage(root);
    const own = trackKeysOf(tenant, activity);
    for (const key of own) await place(root, key);
    await cp(root, copy, { recursive: true });
    await rename(root, `${root}.moved`);
    await symlink(copy, root);
    await expect(storage.listScopeObjects(activityScope, 1000)).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    for (const key of own) expect(await present(join(copy, ...String(key).split('/')))).toBe(true);
  });
});

describe('what belongs to a scope (M2-01y)', () => {
  it('is a key of the scope’s own family naming the same tenant and owner, and nothing else', () => {
    const [ownTrack] = trackKeysOf(tenant, activity);
    const [ownPicture] = thumbnailKeysOf(tenant, course);
    expect(isObjectKeyOfScope(String(ownTrack), activityScope)).toBe(true);
    expect(isObjectKeyOfScope(String(ownPicture), courseScope)).toBe(true);
    for (const key of [
      ...trackKeysOf(tenant, sibling),
      ...trackKeysOf(neighbour, activity),
      // A course with the activity's id: right tenant, right id, wrong family.
      ...thumbnailKeysOf(tenant, activity),
      createTemporaryObjectKey({ tenantId: tenant, resourceId: activity, uploadId: randomUUID() }),
      `${objectScopePrefix(activityScope)}/README`,
    ])
      expect(isObjectKeyOfScope(String(key), activityScope), String(key)).toBe(false);
    expect(isObjectKeyOfScope(String(ownTrack), courseScope)).toBe(false);
    // Another course of the same tenant.
    for (const key of thumbnailKeysOf(tenant, `${course.slice(0, -1)}d`))
      expect(isObjectKeyOfScope(String(key), courseScope), String(key)).toBe(false);
    expect(
      isObjectKeyOfScope(String(ownPicture), {
        kind: 'course',
        tenantId: neighbour,
        courseId: course,
      }),
    ).toBe(false);
  });
});
