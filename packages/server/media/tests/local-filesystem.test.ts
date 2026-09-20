import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFinalObjectKey,
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
