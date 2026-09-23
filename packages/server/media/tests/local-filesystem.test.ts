import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  type ObjectKey,
} from '../src/keys.js';
import {
  createLocalFilesystemObjectStorage,
  ObjectStorageConflictError,
  UnsafeStoragePathError,
} from '../src/local-filesystem.js';
import { storeValidatedUpload, type PreparedValidatedUpload } from '../src/upload.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const resourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const temporaryUploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const roots: string[] = [];

async function recordPrepared(): Promise<void> {}

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workout-media-test-'));
  roots.push(root);
  return root;
}

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

async function readBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const values: Buffer[] = [];
  for await (const chunk of body) values.push(Buffer.from(chunk));
  return Buffer.concat(values).toString('utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('private local filesystem object storage', () => {
  it('rejects relative and filesystem-root storage directories', async () => {
    await expect(createLocalFilesystemObjectStorage('.')).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    await expect(createLocalFilesystemObjectStorage('/')).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
  });

  it('writes privately, atomically publishes, opens, stats and idempotently deletes', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const result = await storeValidatedUpload({
      storage,
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
      fileName: 'notes.md',
      declaredMimeType: 'text/markdown',
      body: chunks('# Plan\n', 'Easy run'),
      onPrepared: recordPrepared,
    });

    expect(result.outcome).toBe('published');
    const opened = await storage.open(result.key);
    expect(opened).not.toBeNull();
    if (!opened) throw new Error('Expected the stored object to exist.');
    expect(await readBody(opened.body)).toBe('# Plan\nEasy run');
    await expect(storage.stat(result.key)).resolves.toMatchObject({ sizeBytes: 15 });

    const rootMode = (await lstat(root)).mode & 0o777;
    const fileMode = (await lstat(join(root, ...result.key.split('/')))).mode & 0o777;
    expect(rootMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    await storage.delete(result.key);
    await storage.delete(result.key);
    await expect(storage.open(result.key)).resolves.toBeNull();
  });

  it('publishes a URL-ingestion artifact only to its matching request and kind', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    const body = Buffer.from('{"text":"bounded"}');
    const sha256 = createHash('sha256').update(body).digest('hex');
    const temporary = createUrlTemporaryObjectKey({
      tenantId,
      resourceId,
      ingestionId: temporaryUploadId,
      artifactKind: 'parsed',
    });
    const final = createUrlFinalObjectKey({
      tenantId,
      resourceId,
      ingestionId: temporaryUploadId,
      artifactKind: 'parsed',
      sha256,
      extension: 'json',
    });
    await storage.writeTemporary(temporary, chunks(body.toString('utf8')));
    await expect(
      storage.publishTemporary(temporary, final, { sizeBytes: body.byteLength, sha256 }),
    ).resolves.toMatchObject({ outcome: 'published', key: final });
    await expect(storage.open(final)).resolves.not.toBeNull();
  });

  it('reuses one upload key idempotently but isolates identical bytes across upload intents', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    const first = await storeValidatedUpload({
      storage,
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
      fileName: 'paper.pdf',
      declaredMimeType: 'application/pdf',
      body: chunks('%PDF-1.7\nfixed'),
      onPrepared: recordPrepared,
    });
    const retry = await storeValidatedUpload({
      storage,
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
      fileName: 'paper.pdf',
      declaredMimeType: 'application/pdf',
      body: chunks('%PDF-1.7\nfixed'),
      onPrepared: recordPrepared,
    });
    const independent = await storeValidatedUpload({
      storage,
      tenantId,
      resourceId,
      uploadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      fileName: 'paper.pdf',
      declaredMimeType: 'application/pdf',
      body: chunks('%PDF-1.7\nfixed'),
      onPrepared: recordPrepared,
    });

    expect(retry).toMatchObject({ key: first.key, outcome: 'already_present' });
    expect(independent.key).not.toBe(first.key);
    expect(independent.outcome).toBe('published');
    await storage.delete(first.key);
    await expect(storage.stat(independent.key)).resolves.not.toBeNull();
  });

  it('does not delete a temporary object owned by a concurrent PUT for the same intent', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    let preparedEntered: (() => void) | undefined;
    let allowPublish: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      preparedEntered = resolve;
    });
    const publishAllowed = new Promise<void>((resolve) => {
      allowPublish = resolve;
    });
    const first = storeValidatedUpload({
      storage,
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
      fileName: 'concurrent.md',
      declaredMimeType: 'text/markdown',
      body: chunks('# first request'),
      onPrepared: async () => {
        preparedEntered?.();
        await publishAllowed;
      },
    });
    await entered;

    const duplicate = storeValidatedUpload({
      storage,
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
      fileName: 'concurrent.md',
      declaredMimeType: 'text/markdown',
      body: chunks('# duplicate request'),
      onPrepared: recordPrepared,
    });
    await expect(duplicate).rejects.toMatchObject({ code: 'EEXIST' });

    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
    });
    await expect(storage.stat(temporary)).resolves.toMatchObject({
      sizeBytes: Buffer.byteLength('# first request'),
    });

    allowPublish?.();
    await expect(first).resolves.toMatchObject({ outcome: 'published' });
  });

  it('rejects publish when temporary bytes do not match the declared hash', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
    });
    await storage.writeTemporary(temporary, chunks('different'));
    const expected = Buffer.from('expected');
    const sha256 = createHash('sha256').update(expected).digest('hex');
    const final = createFinalObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
      sha256,
      extension: 'md',
    });
    await expect(
      storage.publishTemporary(temporary, final, { sizeBytes: expected.byteLength, sha256 }),
    ).rejects.toBeInstanceOf(ObjectStorageConflictError);
  });

  it('rejects publishing a temporary object into another tenant or upload namespace', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    const content = Buffer.from('private');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
    });
    const foreignFinal = createFinalObjectKey({
      tenantId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      resourceId,
      uploadId: temporaryUploadId,
      sha256,
      extension: 'md',
    });
    await storage.writeTemporary(temporary, chunks('private'));
    await expect(
      storage.publishTemporary(temporary, foreignFinal, {
        sizeBytes: content.byteLength,
        sha256,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageConflictError);

    const foreignUploadFinal = createFinalObjectKey({
      tenantId,
      resourceId,
      uploadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sha256,
      extension: 'md',
    });
    await expect(
      storage.publishTemporary(temporary, foreignUploadFinal, {
        sizeBytes: content.byteLength,
        sha256,
      }),
    ).rejects.toBeInstanceOf(ObjectStorageConflictError);
  });

  it('does not overwrite a corrupt object already present at a final key', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const content = Buffer.from('expected');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const final = createFinalObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
      sha256,
      extension: 'md',
    });
    const finalPath = join(root, ...final.split('/'));
    await mkdir(join(finalPath, '..'), { recursive: true });
    await writeFile(finalPath, 'corrupt!');
    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
    });
    await storage.writeTemporary(temporary, chunks('expected'));

    await expect(
      storage.publishTemporary(temporary, final, { sizeBytes: content.byteLength, sha256 }),
    ).rejects.toBeInstanceOf(ObjectStorageConflictError);
    await expect(readFile(finalPath, 'utf8')).resolves.toBe('corrupt!');
  });

  it('removes partial temporary files when streaming validation fails', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
    });
    await expect(
      storeValidatedUpload({
        storage,
        tenantId,
        resourceId,
        uploadId: temporaryUploadId,
        fileName: 'fake.pdf',
        declaredMimeType: 'application/pdf',
        body: chunks('not a PDF'),
        onPrepared: recordPrepared,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PDF_HEADER' });
    await expect(storage.stat(temporary)).resolves.toBeNull();
  });

  it('reconciles only the deterministic temporary key left by an interrupted write', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId: temporaryUploadId,
    });
    await storage.writeTemporary(temporary, chunks('# interrupted'));

    await expect(storage.stat(temporary)).resolves.not.toBeNull();
    await storage.delete(temporary);
    await expect(storage.stat(temporary)).resolves.toBeNull();

    await expect(
      storeValidatedUpload({
        storage,
        tenantId,
        resourceId,
        uploadId: temporaryUploadId,
        fileName: 'retry.md',
        declaredMimeType: 'text/markdown',
        body: chunks('# complete'),
        onPrepared: recordPrepared,
      }),
    ).resolves.toMatchObject({ outcome: 'published' });
  });

  it('records exact refs before publish and retains a durably tracked temp on interruption', async () => {
    const storage = await createLocalFilesystemObjectStorage(await newRoot());
    const publishInterrupted = new Error('publish interrupted');
    const interruptedStorage = {
      ...storage,
      publishTemporary: async () => Promise.reject(publishInterrupted),
    };
    let prepared: PreparedValidatedUpload | undefined;

    await expect(
      storeValidatedUpload({
        storage: interruptedStorage,
        tenantId,
        resourceId,
        uploadId: temporaryUploadId,
        fileName: 'prepared.md',
        declaredMimeType: 'text/markdown',
        body: chunks('# prepared'),
        onPrepared: async (value) => {
          prepared = value;
          await expect(storage.stat(value.temporaryKey)).resolves.not.toBeNull();
          await expect(storage.stat(value.finalKey)).resolves.toBeNull();
        },
      }),
    ).rejects.toBe(publishInterrupted);

    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('Expected durable preparation callback.');
    await expect(storage.stat(prepared.temporaryKey)).resolves.not.toBeNull();
    await expect(storage.stat(prepared.finalKey)).resolves.toBeNull();
  });

  it('rejects forged traversal keys and symbolic-link path components', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    await expect(storage.stat('../escape' as ObjectKey)).rejects.toThrow();

    const tenantDirectory = join(root, 'private', 'v1', 'tenants', tenantId);
    await mkdir(join(root, 'private', 'v1', 'tenants'), { recursive: true });
    await symlink(tmpdir(), tenantDirectory);
    const temporary = createTemporaryObjectKey({
      tenantId,
      resourceId,
      uploadId: randomUUID(),
    });
    await expect(storage.stat(temporary)).rejects.toBeInstanceOf(UnsafeStoragePathError);
    await expect(storage.writeTemporary(temporary, chunks('safe'))).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
  });
});

describe('deleting an object does not leave its directories behind', () => {
  it('prunes the directories an unlink emptied and stops at the first that is not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prune-'));
    try {
      const storage = await createLocalFilesystemObjectStorage(root);
      const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const activity = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const track = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const keys = [
        'dddddddd-dddd-4ddd-8ddd-000000000001',
        'dddddddd-dddd-4ddd-8ddd-000000000002',
      ].map((uploadId) =>
        createActivityTrackTemporaryObjectKey({
          tenantId: tenant,
          activityId: activity,
          trackId: track,
          uploadId,
          artifactKind: 'raw',
        }),
      );
      for (const key of keys)
        await storage.writeTemporary(
          key,
          (async function* () {
            yield new TextEncoder().encode('object');
          })(),
        );
      const [first, second] = keys;
      if (first === undefined || second === undefined) throw new Error('expected two keys');
      await storage.delete(first);
      // The upload directory of the deleted object is gone; the shared parent stays because
      // the second object still lives there.
      await expect(lstat(join(root, first.slice(0, first.lastIndexOf('/'))))).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      );
      expect(
        (await lstat(join(root, second.slice(0, second.lastIndexOf('/'))))).isDirectory(),
      ).toBe(true);
      await storage.delete(second);
      // With nothing left, the upload directory goes too — but the `temporary/` directory the
      // two uploads shared stays, and so does everything above it (M2-01n): another upload of
      // the same track may be writing into it at this very moment.
      await expect(
        lstat(join(root, second.slice(0, second.lastIndexOf('/')))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const shared = second.slice(0, second.lastIndexOf('/'));
      expect(
        (await lstat(join(root, shared.slice(0, shared.lastIndexOf('/'))))).isDirectory(),
      ).toBe(true);
      expect((await lstat(root)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers absent, not an error, when a delete lands inside a concurrent stat', async () => {
    // Several cleanup workers drain and sweep the same namespace at once — the queue is a
    // lease plus `SKIP LOCKED` design — so one process reading a key while another deletes it
    // is ordinary operation. Before the ENOENT guards in `assertSafeExistingFile`, that threw:
    // measured on this filesystem, 2 of 5,000 sequential `stat`/`delete` pairs raised
    // `ENOENT: … lstat` out of `stat`, and the M2-01m sweep made it a 4-in-8 failure of the
    // course-thumbnail lock-order suite.
    //
    // The delete is deliberately delayed by a tuned number of filesystem operations so it
    // lands inside the walk instead of before or after it; sweeping the delay covers the
    // whole window. This test can under-detect on a differently-timed machine, but it can
    // never fail spuriously: with the guard in place there is no input for which `stat`
    // throws ENOENT.
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    const outcomes: string[] = [];
    for (let ticks = 10; ticks <= 20; ticks += 1) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const key = createActivityTrackTemporaryObjectKey({
          tenantId,
          activityId: resourceId,
          trackId: temporaryUploadId,
          uploadId: randomUUID(),
          artifactKind: 'raw',
        });
        await storage.writeTemporary(key, chunks('x'));
        const path = resolve(root, ...String(key).split('/'));
        const [observed] = await Promise.allSettled([
          storage.stat(key),
          (async () => {
            for (let tick = 0; tick < ticks; tick += 1) await lstat(root);
            await unlink(path);
          })(),
        ]);
        outcomes.push(
          observed.status === 'rejected'
            ? `THREW ${(observed.reason as NodeJS.ErrnoException).code ?? 'UNKNOWN'}`
            : 'answered',
        );
      }
    }
    expect(new Set(outcomes)).toEqual(new Set(['answered']));
  });
});

describe('a delete never removes a directory a sibling write may need (M2-01n)', () => {
  const sha256 = createHash('sha256').update('sibling').digest('hex');
  const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const unit = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const base = `private/v1/tenants/${tenantId}`;

  // Each shape's object, the directory siblings share (which must survive the delete) and
  // the directory named by the unit itself (which must not). Written out rather than derived
  // from the implementation, so a changed floor has to change this table too.
  const shapes: readonly {
    name: string;
    key: ObjectKey;
    shared: string;
    unitDirectory: string | null;
  }[] = [
    {
      name: 'resource temporary',
      key: createTemporaryObjectKey({ tenantId, resourceId: owner, uploadId: unit }),
      shared: `${base}/resources/${owner}/temporary`,
      unitDirectory: null,
    },
    {
      name: 'resource final',
      key: createFinalObjectKey({
        tenantId,
        resourceId: owner,
        uploadId: unit,
        sha256,
        extension: 'md',
      }),
      shared: `${base}/resources/${owner}/objects/uploads`,
      unitDirectory: `${base}/resources/${owner}/objects/uploads/${unit}`,
    },
    {
      name: 'gallery temporary',
      key: createGalleryTemporaryObjectKey({ tenantId, mediaItemId: owner, uploadId: unit }),
      shared: `${base}/gallery/${owner}/temporary`,
      unitDirectory: null,
    },
    {
      name: 'gallery final',
      key: createGalleryFinalObjectKey({
        tenantId,
        mediaItemId: owner,
        uploadId: unit,
        sha256,
        extension: 'png',
      }),
      shared: `${base}/gallery/${owner}/objects/uploads`,
      unitDirectory: `${base}/gallery/${owner}/objects/uploads/${unit}`,
    },
    {
      name: 'URL temporary',
      key: createUrlTemporaryObjectKey({
        tenantId,
        resourceId: owner,
        ingestionId: unit,
        artifactKind: 'raw',
      }),
      shared: `${base}/resources/${owner}/url-ingestions`,
      unitDirectory: `${base}/resources/${owner}/url-ingestions/${unit}`,
    },
    {
      name: 'URL final',
      key: createUrlFinalObjectKey({
        tenantId,
        resourceId: owner,
        ingestionId: unit,
        artifactKind: 'raw',
        sha256,
        extension: 'txt',
      }),
      shared: `${base}/resources/${owner}/url-ingestions`,
      unitDirectory: `${base}/resources/${owner}/url-ingestions/${unit}`,
    },
    {
      name: 'track temporary',
      key: createActivityTrackTemporaryObjectKey({
        tenantId,
        activityId: owner,
        trackId: owner,
        uploadId: unit,
        artifactKind: 'raw',
      }),
      shared: `${base}/activities/${owner}/tracks/${owner}/temporary`,
      unitDirectory: `${base}/activities/${owner}/tracks/${owner}/temporary/${unit}`,
    },
    {
      name: 'track final',
      key: createActivityTrackFinalObjectKey({
        tenantId,
        activityId: owner,
        trackId: owner,
        uploadId: unit,
        artifactKind: 'raw',
        sha256,
        extension: 'gpx',
      }),
      shared: `${base}/activities/${owner}/tracks/${owner}/raw/uploads`,
      unitDirectory: `${base}/activities/${owner}/tracks/${owner}/raw/uploads/${unit}`,
    },
    {
      name: 'course thumbnail temporary',
      key: createCourseThumbnailTemporaryObjectKey({ tenantId, courseId: owner, jobId: unit }),
      shared: `${base}/courses/${owner}/thumbnails/temporary`,
      unitDirectory: null,
    },
    {
      name: 'course thumbnail final',
      key: createCourseThumbnailFinalObjectKey({
        tenantId,
        courseId: owner,
        revisionId: unit,
        sha256,
      }),
      shared: `${base}/courses/${owner}/thumbnails/revisions`,
      unitDirectory: `${base}/courses/${owner}/thumbnails/revisions/${unit}`,
    },
  ];

  it.each(shapes)(
    'keeps the shared directory of a $name object and prunes only its own',
    async ({ key, shared, unitDirectory }) => {
      const root = await newRoot();
      const storage = await createLocalFilesystemObjectStorage(root);
      // Placed directly, so the final shapes need no temporary of their own: the object
      // exists at its key with nothing else in the store.
      const path = join(root, ...String(key).split('/'));
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await writeFile(path, 'sibling', { mode: 0o600 });

      await storage.delete(key);

      await expect(storage.stat(key)).resolves.toBeNull();
      if (unitDirectory !== null)
        await expect(lstat(join(root, ...unitDirectory.split('/')))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      // The last object is gone and the shared directory is empty, and still it stays: that
      // emptiness is exactly the moment a sibling's `prepareParents` may be walking through it.
      expect((await lstat(join(root, ...shared.split('/')))).isDirectory()).toBe(true);
    },
  );

  it('lets siblings write and delete side by side in several processes without one failure', async () => {
    // The race, reproduced with several processes the way several workers share one store.
    // See the progress note for the measured failure counts with the floor reverted.
    //
    // It can under-detect on a differently-timed machine; it cannot fail spuriously, because
    // with the floor in place no delete removes a directory any sibling unit can be using.
    const root = await newRoot();
    const script = fileURLToPath(new URL('./sibling-churn-process.ts', import.meta.url));
    type Report = { operations: number; failures: Record<string, number> };
    const reports = await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise<Report>((resolveReport, reject) => {
            const child = fork(script, [], {
              env: { ...process.env, CHURN_ROOT: root, CHURN_ROUNDS: '25' },
              execArgv: ['--import', 'tsx'],
              stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            });
            child.once('message', (message) => resolveReport(message as Report));
            child.once('error', reject);
            child.once('exit', (code) => {
              if (code !== 0) reject(new Error(`churn process exited ${String(code)}`));
            });
          }),
      ),
    );
    const failures: Record<string, number> = {};
    let operations = 0;
    for (const report of reports) {
      operations += report.operations;
      for (const [label, count] of Object.entries(report.failures))
        failures[label] = (failures[label] ?? 0) + count;
    }
    // 4 processes × 25 rounds × 5 key shapes × (write, publish, delete) when nothing fails.
    expect(failures).toEqual({});
    expect(operations).toBe(4 * 25 * 5 * 3);
  }, 60_000);
});

describe('whether the store answers at all (M2-01n)', () => {
  it('resolves for a readable root, where a missing key is still just absent', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    await expect(storage.assertReachable()).resolves.toBeUndefined();
    await expect(
      storage.stat(createTemporaryObjectKey({ tenantId, resourceId, uploadId: temporaryUploadId })),
    ).resolves.toBeNull();
  });

  it('rejects a root that is gone — a missing store is not an empty one', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    await rm(root, { recursive: true, force: true });
    await expect(storage.assertReachable()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a root it may not read or search', async () => {
    const root = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    await chmod(root, 0o000);
    try {
      await expect(storage.assertReachable()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(root, 0o700);
    }
    // Readable but not searchable: the directory opens, yet no `stat` below it could work.
    await chmod(root, 0o400);
    try {
      await expect(storage.assertReachable()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(root, 0o700);
    }
  });

  it('rejects a root that was swapped for a symbolic link', async () => {
    const root = await newRoot();
    const elsewhere = await newRoot();
    const storage = await createLocalFilesystemObjectStorage(root);
    await rm(root, { recursive: true, force: true });
    await symlink(elsewhere, root);
    await expect(storage.assertReachable()).rejects.toBeInstanceOf(UnsafeStoragePathError);
    await unlink(root);
  });
});
