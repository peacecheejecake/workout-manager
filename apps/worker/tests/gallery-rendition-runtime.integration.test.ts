import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGalleryCodecSupervisor } from '@workout/server-media/gallery-codec-supervisor';
import {
  createGalleryFinalObjectKey,
  createGalleryTemporaryObjectKey,
  parseObjectKey,
  validateObjectKey,
} from '@workout/server-media/keys';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { createGalleryMediaRepository } from '@workout/server-persistence/gallery-media';
import {
  createGalleryRenditionReader,
  createGalleryRenditionWorkerStore,
} from '@workout/server-persistence/gallery-renditions';
import { migrate, grantGalleryMedia } from '@workout/server-persistence/migrate';
import { installCurrentRuntimeV10 } from '@workout/server-persistence/current-runtime-installation-v10';
import { grantCurrentRuntimeV10Profile } from '@workout/server-persistence/current-runtime-grants-v10';
import { grantCurrentRuntimeAppBaselineV2 } from '@workout/server-persistence/current-runtime-app-grants-v2';
import {
  galleryProfile27MembersV1,
  readGalleryMemberSourceV1,
} from '@workout/server-persistence/gallery-profile27-members-v1';
import {
  galleryNavigationRuntimeFunctionsV1,
  galleryNavigationRuntimeReadTablesV1,
} from '@workout/server-persistence/gallery-navigation-pins-v1';
import {
  galleryRenditionApiFunctionsV1,
  galleryRenditionWorkerFunctionsV1,
} from '@workout/server-persistence/gallery-rendition-pins-v1';

import { createGalleryRenditionRuntime } from '../src/gallery-rendition-runtime.js';
import { runGalleryRenditionWorker } from '../src/gallery-rendition-run.js';

// Test-only stand-in for the profile27 installer and grants (another lane owns those): a
// committed profile26 parent with its runtime grants, the pinned 143/144/145 bytes applied raw
// in one owner transaction (no ledger), then the exact gallery rosters per role.
type GalleryRosterForTest = 'navigation' | 'api' | 'worker';
async function stageGalleryProfile27ForTest(
  ownerUrl: string,
  runtimeRoles: readonly string[],
  rosters: readonly (readonly [string, GalleryRosterForTest])[],
) {
  await installCurrentRuntimeV10(ownerUrl);
  for (const role of runtimeRoles) {
    await grantCurrentRuntimeAppBaselineV2(ownerUrl, role, 'core');
    await grantCurrentRuntimeV10Profile(ownerUrl, role);
  }
  const pool = new Pool({ connectionString: ownerUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(872194,1)');
    await client.query('SELECT pg_advisory_xact_lock(77210,1)');
    for (const member of galleryProfile27MembersV1)
      await client.query(await readGalleryMemberSourceV1(member));
    for (const [role, roster] of rosters) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('INVALID_TEST_ROLE');
      if (roster === 'navigation')
        await client.query(
          `GRANT SELECT ON ${galleryNavigationRuntimeReadTablesV1.map((t) => `public.${t}`).join(',')} TO "${role}"`,
        );
      const functions =
        roster === 'navigation'
          ? galleryNavigationRuntimeFunctionsV1
          : roster === 'api'
            ? galleryRenditionApiFunctionsV1
            : galleryRenditionWorkerFunctionsV1;
      for (const signature of functions)
        await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${role}"`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// M2-03c end to end on owned resources: disposable PostgreSQL 17 (SQL143/144/145 pinned bytes
// over a committed profile26 parent, test stand-in for profile27), a private
// local object store under a fresh TMP root, the supervised codec child (sharp/libvips and
// FFmpeg 9.0.2) and synthetic media only. Synthetic EXIF/GPS values are not real places.
const execute = promisify(execFile);
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `gallery_rendition_e2e_${suffix}`;
const ownerRole = `gallery_e2e_owner_${suffix}`;
const runtimeRole = `gallery_e2e_app_${suffix}`;
const workerRole = `gallery_e2e_worker_${suffix}`;
const roles: string[] = [];
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let created = false;
let owner: Pool | undefined;
let workerPool: Pool | undefined;
let runtimeDb: Database | undefined;
let root: string | undefined;
let scratch: string | undefined;
let ffmpegPath = '';
let ffprobePath = '';

function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('GALLERY_E2E_FIXTURE_NOT_READY');
  return value;
}
async function binary(tool: 'ffmpeg' | 'ffprobe') {
  for (const path of (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(isAbsolute)
    .map((directory) => join(directory, tool))) {
    let actual: string;
    try {
      actual = await realpath(path);
      await access(actual, constants.X_OK);
    } catch {
      continue;
    }
    const version = await execute(actual, ['-version'], { maxBuffer: 65536, timeout: 5000 });
    if (!new RegExp(`^${tool} version 9\\.0\\.2(?: |\\n)`).test(version.stdout))
      throw new Error('test_binary_version_required_9_0_2');
    return actual;
  }
  throw new Error('test_binary_unavailable');
}
async function ffmpeg(args: string[]): Promise<Buffer> {
  const { stdout } = await execute(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
    {
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 20000,
    },
  );
  return stdout;
}

/** A big-endian TIFF/EXIF APP1 with Orientation=6 and a synthetic GPS IFD (lat 1/1,2/1,3/1). */
const GPS_RATIONALS = Buffer.from([
  0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 1,
]);
function exifSegment(): Buffer {
  const tiff = Buffer.alloc(104);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  let p = 8;
  tiff.writeUInt16BE(2, p);
  p += 2;
  // Orientation SHORT 6
  tiff.writeUInt16BE(0x0112, p);
  tiff.writeUInt16BE(3, p + 2);
  tiff.writeUInt32BE(1, p + 4);
  tiff.writeUInt16BE(6, p + 8);
  p += 12;
  // GPSInfo LONG -> 38
  tiff.writeUInt16BE(0x8825, p);
  tiff.writeUInt16BE(4, p + 2);
  tiff.writeUInt32BE(1, p + 4);
  tiff.writeUInt32BE(38, p + 8);
  p += 12;
  tiff.writeUInt32BE(0, p);
  p = 38;
  tiff.writeUInt16BE(3, p);
  p += 2;
  tiff.writeUInt16BE(0x0000, p); // GPSVersionID BYTE[4]
  tiff.writeUInt16BE(1, p + 2);
  tiff.writeUInt32BE(4, p + 4);
  tiff.writeUInt8(2, p + 8);
  tiff.writeUInt8(2, p + 9);
  p += 12;
  tiff.writeUInt16BE(0x0001, p); // GPSLatitudeRef ASCII "N"
  tiff.writeUInt16BE(2, p + 2);
  tiff.writeUInt32BE(2, p + 4);
  tiff.write('N', p + 8, 'latin1');
  p += 12;
  tiff.writeUInt16BE(0x0002, p); // GPSLatitude RATIONAL[3] -> 80
  tiff.writeUInt16BE(5, p + 2);
  tiff.writeUInt32BE(3, p + 4);
  tiff.writeUInt32BE(80, p + 8);
  p += 12;
  tiff.writeUInt32BE(0, p);
  GPS_RATIONALS.copy(tiff, 80);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}
async function exifJpeg(): Promise<Buffer> {
  const base = await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=800x400:rate=1',
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-pix_fmt',
    'yuvj420p',
    '-f',
    'image2pipe',
    'pipe:1',
  ]);
  if (base[0] !== 0xff || base[1] !== 0xd8) throw new Error('fixture_not_jpeg');
  return Buffer.concat([base.subarray(0, 2), exifSegment(), base.subarray(2)]);
}
async function locatedMp4(): Promise<Buffer> {
  const directory = need(scratch);
  const path = join(directory, `${randomUUID()}.mp4`);
  await ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x96:rate=12:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-metadata',
    'location=+01.0000+002.0000/',
    '-metadata',
    'title=synthetic-located-clip',
    '-movflags',
    '+use_metadata_tags',
    '-y',
    path,
  ]);
  return readFile(path);
}
async function gif(): Promise<Buffer> {
  return ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=32x32:rate=1',
    '-frames:v',
    '1',
    '-f',
    'gif',
    'pipe:1',
  ]);
}

async function ownerTx<T>(athlete: string, work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await need(owner).connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await work(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
async function storage() {
  return createLocalFilesystemObjectStorage(need(root));
}
async function* once(bytes: Uint8Array) {
  yield bytes;
}
/** Stores synthetic original bytes as a published private gallery object and its row. */
async function upload(
  athlete: string,
  bytes: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'video/mp4',
) {
  const store = await storage();
  const mediaItemId = randomUUID();
  const uploadId = randomUUID();
  const digest = sha(bytes);
  const extension = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/png' ? 'png' : 'mp4';
  const temporary = createGalleryTemporaryObjectKey({ tenantId: athlete, mediaItemId, uploadId });
  const final = createGalleryFinalObjectKey({
    tenantId: athlete,
    mediaItemId,
    uploadId,
    sha256: digest,
    extension,
  });
  await store.writeTemporary(temporary, once(bytes));
  await store.publishTemporary(temporary, final, { sizeBytes: bytes.length, sha256: digest });
  await ownerTx(athlete, (tx) =>
    tx.query(
      `INSERT INTO public.gallery_media_item(athlete_id,id,media_kind,storage_ref,original_filename,
       media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
       VALUES($1,$2,$3,$4,'synthetic',$5,$6,$7,1,clock_timestamp(),clock_timestamp())`,
      [
        athlete,
        mediaItemId,
        mediaType.startsWith('video') ? 'video' : 'image',
        final,
        mediaType,
        bytes.length,
        digest,
      ],
    ),
  );
  return { mediaItemId, digest, final };
}
async function readObject(storageRef: string): Promise<Buffer> {
  const opened = await (await storage()).open(validateObjectKey(storageRef));
  if (opened === null) throw new Error('object_missing');
  const chunks: Uint8Array[] = [];
  for await (const chunk of opened.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function riffChunks(bytes: Buffer): string[] {
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP')
    throw new Error('not_webp');
  const chunks: string[] = [];
  for (let p = 12; p + 8 <= bytes.length;) {
    chunks.push(bytes.toString('latin1', p, p + 4));
    const size = bytes.readUInt32LE(p + 4);
    p += 8 + size + (size % 2);
  }
  return chunks;
}
async function drain() {
  const store = await storage();
  const childModulePath = join(
    dirname(fileURLToPath(import.meta.resolve('@workout/server-media/gallery-codec-supervisor'))),
    'gallery-codec-child.ts',
  );
  const worker = createGalleryRenditionRuntime({
    store: createGalleryRenditionWorkerStore(need(workerPool), { leaseSeconds: 60 }),
    storage: store,
    codec: createGalleryCodecSupervisor({
      nodePath: process.execPath,
      childModulePath,
      typescriptLoaderPath: fileURLToPath(import.meta.resolve('tsx')),
      ffmpegPath,
      ffprobePath,
      scratchRoot: need(scratch),
    }),
    clock: {
      nowMs: () => Date.now(),
      schedule: (delay, callback) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
    },
    workerId: randomUUID(),
    deadlineMs: 30000,
  });
  const results: unknown[] = [];
  for (let i = 0; i < 20; i++) {
    const result = await worker.runJob();
    if (result.state === 'no_job') break;
    results.push(result);
  }
  return { results, worker };
}

beforeAll(async () => {
  ffmpegPath = await binary('ffmpeg');
  ffprobePath = await binary('ffprobe');
  root = await mkdtemp(join(tmpdir(), 'wm-rendition-store-'));
  scratch = await mkdtemp(join(tmpdir(), 'wm-rendition-scratch-'));
  for (const role of [ownerRole, runtimeRole, workerRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(connection(ownerRole), 107);
  await stageGalleryProfile27ForTest(
    connection(ownerRole),
    [runtimeRole],
    [
      [workerRole, 'worker'],
      [runtimeRole, 'api'],
    ],
  );
  await grantGalleryMedia(connection(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: connection(ownerRole), max: 2 });
  workerPool = new Pool({ connectionString: connection(workerRole), max: 2 });
  runtimeDb = createDatabase({ connectionString: connection(runtimeRole), max: 2 });
});

afterAll(async () => {
  await runtimeDb?.close();
  await workerPool?.end();
  await owner?.end();
  if (created) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const open = await admin.query<{ total: number }>(
        'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=$1',
        [name],
      );
      if (Number(open.rows[0]?.total) === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
  for (const role of roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
  for (const path of [root, scratch]) if (path) await rm(path, { recursive: true, force: true });
});

async function newAthlete() {
  const athlete = randomUUID();
  await ownerTx(athlete, (tx) =>
    tx.query(
      "INSERT INTO public.consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)",
      [athlete],
    ),
  );
  return athlete;
}

describe('M2-03c rendition worker with real codecs, storage and PostgreSQL', () => {
  it('derives oriented, metadata-free WebP renditions and keeps the original immutable', async () => {
    const athlete = await newAthlete();
    const jpeg = await exifJpeg();
    expect(jpeg.includes(GPS_RATIONALS)).toBe(true);
    const item = await upload(athlete, jpeg, 'image/jpeg');
    const { results } = await drain();
    expect(results).toEqual([{ state: 'ready' }, { state: 'ready' }]);
    const reader = createGalleryRenditionReader(need(runtimeDb));
    const list = need((await reader.list(athlete, item.mediaItemId)) ?? undefined);
    const dims = Object.fromEntries(
      list.renditions.map((r) => [
        r.kind,
        r.state === 'ready' ? [r.output.widthPixels, r.output.heightPixels] : r.state,
      ]),
    );
    // EXIF orientation 6 rotates 800x400 to portrait; no upscale; thumbnail fits 320.
    expect(dims).toEqual({ image_preview: [400, 800], image_thumbnail: [160, 320] });
    for (const kind of ['image_preview', 'image_thumbnail'] as const) {
      const object = need(
        (await reader.resolveObject(athlete, item.mediaItemId, kind)) ?? undefined,
      );
      const parsed = parseObjectKey(object.storageRef);
      expect(parsed).toMatchObject({
        kind: 'gallery_rendition',
        tenantId: athlete,
        mediaItemId: item.mediaItemId,
        renditionKind: kind,
      });
      const bytes = await readObject(object.storageRef);
      expect(sha(bytes)).toBe(object.sha256);
      expect(bytes.length).toBe(object.byteSize);
      const chunks = riffChunks(bytes);
      expect(chunks.some((chunk) => chunk === 'EXIF' || chunk === 'XMP ')).toBe(false);
      expect(bytes.includes(GPS_RATIONALS)).toBe(false);
      expect(bytes.includes(Buffer.from('Exif', 'latin1'))).toBe(false);
    }
    const original = await readObject(item.final);
    expect(sha(original)).toBe(item.digest);
    expect(original.includes(GPS_RATIONALS)).toBe(true);
    const row = await ownerTx(athlete, (tx) =>
      tx.query('SELECT content_hash,storage_ref FROM public.gallery_media_item WHERE id=$1', [
        item.mediaItemId,
      ]),
    );
    expect(row.rows[0]).toEqual({ content_hash: item.digest, storage_ref: item.final });
  });

  it('transcodes a located MP4 to H.264 playback without container location metadata', async () => {
    const athlete = await newAthlete();
    const clip = await locatedMp4();
    expect(clip.includes(Buffer.from('+01.0000+002.0000', 'latin1'))).toBe(true);
    const item = await upload(athlete, clip, 'video/mp4');
    const { results } = await drain();
    expect(results).toEqual([{ state: 'ready' }]);
    const reader = createGalleryRenditionReader(need(runtimeDb));
    const list = need((await reader.list(athlete, item.mediaItemId)) ?? undefined);
    const rendition = list.renditions[0];
    expect(rendition?.state).toBe('ready');
    if (rendition?.state === 'ready' && rendition.output.mediaType === 'video/mp4')
      expect(rendition.output.durationSeconds).toBeGreaterThan(0);
    const object = need(
      (await reader.resolveObject(athlete, item.mediaItemId, 'video_playback')) ?? undefined,
    );
    const bytes = await readObject(object.storageRef);
    expect(sha(bytes)).toBe(object.sha256);
    expect(bytes.includes(Buffer.from('+01.0000+002.0000', 'latin1'))).toBe(false);
    expect(bytes.includes(Buffer.from('synthetic-located-clip', 'latin1'))).toBe(false);
    const path = join(need(scratch), `${randomUUID()}.mp4`);
    await writeFile(path, bytes);
    const codec = await execute(ffprobePath, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'csv=p=0',
      path,
    ]);
    expect(codec.stdout.trim()).toBe('h264');
  });

  it('records corrupt input as failed and unsupported formats without any retry', async () => {
    const athlete = await newAthlete();
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 7)]);
    const broken = await upload(athlete, corrupt, 'image/jpeg');
    const animated = await upload(athlete, await gif(), 'image/png');
    const { results } = await drain();
    expect(results).toHaveLength(4);
    for (const result of results)
      expect(result).toMatchObject({ state: 'failed', reason: 'codec_invalid' });
    const reader = createGalleryRenditionReader(need(runtimeDb));
    const failed = need((await reader.list(athlete, broken.mediaItemId)) ?? undefined);
    for (const r of failed.renditions)
      expect(r).toMatchObject({ state: 'failed', retryEligibility: 'ineligible' });
    const unsupported = need((await reader.list(athlete, animated.mediaItemId)) ?? undefined);
    for (const r of unsupported.renditions)
      expect(r).toMatchObject({ state: 'unsupported', code: 'unsupported_format' });
    // Terminal: no further lease is handed out, even when time passes.
    await ownerTx(athlete, (tx) =>
      tx.query(
        `UPDATE public.gallery_rendition_job SET available_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE athlete_id=$1 AND state='queued'`,
        [athlete],
      ),
    );
    expect((await drain()).results).toEqual([]);
    const attempts = await ownerTx(athlete, (tx) =>
      tx.query(
        'SELECT max(attempts) AS attempts FROM public.gallery_rendition_job WHERE athlete_id=$1',
        [athlete],
      ),
    );
    expect(attempts.rows[0]).toEqual({ attempts: 1 });
  });

  it('suppresses deleted media: queues outputs, sweeps only rendition keys and keeps no live state', async () => {
    const athlete = await newAthlete();
    const item = await upload(athlete, await exifJpeg(), 'image/jpeg');
    const { results, worker } = await drain();
    expect(results).toEqual([{ state: 'ready' }, { state: 'ready' }]);
    // Earlier failed leases armed immediate attempt sweeps; they had staged nothing.
    for (
      let sweep = await worker.runSweep();
      sweep.state !== 'no_sweep';
      sweep = await worker.runSweep()
    )
      expect(sweep).toEqual({ state: 'swept', deleted: 0, complete: true });
    const reader = createGalleryRenditionReader(need(runtimeDb));
    const preview = need(
      (await reader.resolveObject(athlete, item.mediaItemId, 'image_preview')) ?? undefined,
    );
    await createGalleryMediaRepository(need(runtimeDb)).softDelete(athlete, item.mediaItemId, {
      expectedAccessRevision: 1,
      idempotencyKey: `delete-${randomUUID()}`,
    });
    expect(await reader.resolveObject(athlete, item.mediaItemId, 'image_preview')).toBeNull();
    const cleanup = await ownerTx(athlete, (tx) =>
      tx.query('SELECT reason FROM public.resource_object_cleanup WHERE storage_ref=$1', [
        preview.storageRef,
      ]),
    );
    expect(cleanup.rows).toEqual([{ reason: 'resource_deleted' }]);
    // Sweep is delayed past any lease; the owner test clock brings it due.
    expect(await worker.runSweep()).toEqual({ state: 'no_sweep' });
    await ownerTx(athlete, (tx) =>
      tx.query(
        `UPDATE public.gallery_rendition_sweep SET available_at=clock_timestamp()-interval '1 second'
         WHERE athlete_id=$1 AND media_item_id=$2`,
        [athlete, item.mediaItemId],
      ),
    );
    const swept = await worker.runSweep();
    expect(swept).toEqual({ state: 'swept', deleted: 2, complete: true });
    const listing = await (
      await storage()
    ).listScopeObjects({ kind: 'gallery', tenantId: athlete, mediaItemId: item.mediaItemId }, 100);
    expect(listing.keys.map((key) => parseObjectKey(key).kind)).toEqual(['gallery_final']);
    expect(await worker.runSweep()).toEqual({ state: 'no_sweep' });
  });

  it('runs the bounded CLI composition: worker probe, store, private storage and codec', async () => {
    const athlete = await newAthlete();
    const item = await upload(athlete, await exifJpeg(), 'image/jpeg');
    const config = {
      connectionString: connection(workerRole),
      storageRoot: need(root),
      ffmpegPath,
      ffprobePath,
      scratchRoot: need(scratch),
      release: 'synthetic-e2e',
    };
    // The API role holds no worker RPC: the run fails closed before any claim.
    expect(
      await runGalleryRenditionWorker({ ...config, connectionString: connection(runtimeRole) }),
    ).toMatchObject({ result: 'unavailable', jobs: {}, sweep: 'not_run' });
    const event = await runGalleryRenditionWorker(config);
    expect(event).toMatchObject({ result: 'completed', jobs: { ready: 2 } });
    expect(JSON.stringify(event)).not.toContain(athlete);
    const list = need(
      (await createGalleryRenditionReader(need(runtimeDb)).list(athlete, item.mediaItemId)) ??
        undefined,
    );
    expect(list.renditions.map((r) => r.state)).toEqual(['ready', 'ready']);
  });
});
