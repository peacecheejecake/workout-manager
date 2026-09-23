/**
 * One process of the sibling write/delete churn in `local-filesystem.test.ts` (M2-01n).
 *
 * Several of these run at once against one storage root, the way several render, upload and
 * cleanup workers share one object store. Every process writes, publishes and deletes objects
 * of its own write units, but all of those units sit side by side under the same tenant and
 * the same owners — so the directories between them are shared, which is exactly where a
 * delete's pruning used to tear a directory down under a sibling's write.
 *
 * It reports every failure as `code@syscall` over IPC and never throws: the parent decides.
 */
import { createHash, randomUUID } from 'node:crypto';

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
  type FinalObjectKey,
  type TemporaryObjectKey,
} from '../src/keys.js';
import { createLocalFilesystemObjectStorage } from '../src/local-filesystem.js';

const root = process.env['CHURN_ROOT'];
const rounds = Number(process.env['CHURN_ROUNDS'] ?? '25');
if (!root) throw new Error('CHURN_ROOT is required');

// Shared by every process and every unit: the owners whose directories siblings meet in.
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const trackId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bytes = Buffer.from('sibling');
const sha256 = createHash('sha256').update(bytes).digest('hex');

type Unit = { temporary: TemporaryObjectKey; final: FinalObjectKey };

/** One fresh write unit of every key shape the store knows. */
function units(): Unit[] {
  const id = () => randomUUID();
  const upload = id();
  const galleryUpload = id();
  const ingestion = id();
  const trackUpload = id();
  const revision = id();
  return [
    {
      temporary: createTemporaryObjectKey({ tenantId, resourceId: ownerId, uploadId: upload }),
      final: createFinalObjectKey({
        tenantId,
        resourceId: ownerId,
        uploadId: upload,
        sha256,
        extension: 'md',
      }),
    },
    {
      temporary: createGalleryTemporaryObjectKey({
        tenantId,
        mediaItemId: ownerId,
        uploadId: galleryUpload,
      }),
      final: createGalleryFinalObjectKey({
        tenantId,
        mediaItemId: ownerId,
        uploadId: galleryUpload,
        sha256,
        extension: 'png',
      }),
    },
    {
      temporary: createUrlTemporaryObjectKey({
        tenantId,
        resourceId: ownerId,
        ingestionId: ingestion,
        artifactKind: 'raw',
      }),
      final: createUrlFinalObjectKey({
        tenantId,
        resourceId: ownerId,
        ingestionId: ingestion,
        artifactKind: 'raw',
        sha256,
        extension: 'txt',
      }),
    },
    {
      temporary: createActivityTrackTemporaryObjectKey({
        tenantId,
        activityId: ownerId,
        trackId,
        uploadId: trackUpload,
        artifactKind: 'raw',
      }),
      final: createActivityTrackFinalObjectKey({
        tenantId,
        activityId: ownerId,
        trackId,
        uploadId: trackUpload,
        artifactKind: 'raw',
        sha256,
        extension: 'gpx',
      }),
    },
    {
      temporary: createCourseThumbnailTemporaryObjectKey({
        tenantId,
        courseId: ownerId,
        jobId: id(),
      }),
      final: createCourseThumbnailFinalObjectKey({
        tenantId,
        courseId: ownerId,
        revisionId: revision,
        sha256,
      }),
    },
  ];
}

async function* body(): AsyncGenerator<Uint8Array> {
  yield bytes;
}

const storage = await createLocalFilesystemObjectStorage(root);
const failures: Record<string, number> = {};
let operations = 0;

async function attempt(operation: () => Promise<unknown>): Promise<boolean> {
  operations += 1;
  try {
    await operation();
    return true;
  } catch (error) {
    const { code, syscall, name } = error as NodeJS.ErrnoException;
    const label = `${code ?? name}@${syscall ?? '-'}`;
    failures[label] = (failures[label] ?? 0) + 1;
    return false;
  }
}

for (let round = 0; round < rounds; round += 1) {
  // Every unit's whole lifecycle at once, so one unit's delete lands among another's writes.
  await Promise.all(
    units().map(async ({ temporary, final }) => {
      if (!(await attempt(() => storage.writeTemporary(temporary, body())))) return;
      if (
        !(await attempt(() =>
          storage.publishTemporary(temporary, final, { sizeBytes: bytes.byteLength, sha256 }),
        ))
      ) {
        await attempt(() => storage.delete(temporary));
        return;
      }
      await attempt(() => storage.delete(final));
    }),
  );
}

process.send?.({ operations, failures });
