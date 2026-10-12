import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import { createGalleryRenditionWorkerStore } from '../src/gallery-renditions.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  grantGalleryRenditionForTest,
  grantProfile27Runtime,
  installProfile27,
} from './gallery-profile27-fixture.js';

// SQL144 restore admission on disposable PostgreSQL 17.6, installed with 143/145/147/148 by the
// profile27 installer V11. The CLOSED control is driven only through its own
// owner functions (101/076): a pending restore target and a rotated generation each withdraw
// admission; closing to no target in the current generation restores it. Synthetic rows only.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const name = `gallery_rend_adm_${suffix}`;
const ownerRole = `gra_owner_${suffix}`;
const apiRole = `gra_api_${suffix}`;
const workerRole = `gra_worker_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const roles: string[] = [];
let created = false;
let owner: Pool;
let worker: Pool;
let api: Database;

function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
async function failure(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    const parsed = z.object({ code: z.string().optional(), message: z.string() }).safeParse(error);
    return parsed.success ? { code: parsed.data.code, message: parsed.data.message } : null;
  }
  return null;
}
async function tx<T>(
  pool: Pool,
  athlete: string | null,
  work: (client: PoolClient) => Promise<T>,
  fence: 'shared' | 'exclusive' | 'none' = 'shared',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (fence === 'shared') await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    if (fence === 'exclusive') await client.query('SELECT pg_advisory_xact_lock(77210,1)');
    if (athlete !== null)
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
async function control() {
  return z
    .object({ localRevision: z.string(), targetNonce: z.string().nullable() })
    .parse(
      (
        await tx(owner, null, (c) =>
          c.query('SELECT public.read_restore_processing_admission() AS v'),
        )
      ).rows[0]?.['v'],
    );
}
/** A committed restore target is pending on the CLOSED control (restore load window). */
async function pendRestoreTarget() {
  const { localRevision } = await control();
  await owner.query('SELECT public.close_restore_processing_exact($1,$2,$3,$4)', [
    localRevision,
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ]);
}
/** Admission: CLOSED with no target in the current restore generation. */
async function admit() {
  const { localRevision } = await control();
  await owner.query('SELECT public.close_restore_processing_exact($1,$2)', [
    localRevision,
    randomUUID(),
  ]);
}
async function newAthlete() {
  const athlete = randomUUID();
  await tx(owner, athlete, (c) =>
    c.query(
      "INSERT INTO public.consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)",
      [athlete],
    ),
  );
  return athlete;
}
/** An owner insert holding the global fence exclusively, as a restore load does. */
async function insertImage(athlete: string, fence: 'shared' | 'exclusive' = 'shared') {
  const id = randomUUID();
  const hash = randomUUID().replaceAll('-', '').padEnd(64, '0');
  await tx(
    owner,
    athlete,
    (c) =>
      c.query(
        `INSERT INTO public.gallery_media_item(athlete_id,id,media_kind,storage_ref,original_filename,
         media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
         VALUES($1,$2,'image',$3,'synthetic.jpg','image/jpeg',4096,$4,1,clock_timestamp(),clock_timestamp())`,
        [
          athlete,
          id,
          `private/v1/tenants/${athlete}/gallery/${id}/objects/uploads/${randomUUID()}/sha256/${hash}.jpg`,
          hash,
        ],
      ),
    fence,
  );
  return id;
}
async function jobs(athlete: string, media: string) {
  return tx(
    owner,
    athlete,
    async (c) =>
      (
        await c.query(
          `SELECT (SELECT count(*)::int FROM public.gallery_rendition_job WHERE athlete_id=$1 AND media_item_id=$2) AS jobs,
            (SELECT count(*)::int FROM public.gallery_rendition_sweep WHERE athlete_id=$1 AND media_item_id=$2) AS sweeps`,
          [athlete, media],
        )
      ).rows[0],
  );
}
async function enqueue(athlete: string, media: string) {
  return tx(
    owner,
    athlete,
    async (c) =>
      (await c.query('SELECT public.enqueue_gallery_renditions_v1($1) AS v', [media])).rows[0]?.[
        'v'
      ],
  );
}
const workerCalls = {
  claim: () => worker.query('SELECT public.claim_gallery_rendition_v1($1,60)', [randomUUID()]),
  claimSweep: () =>
    worker.query('SELECT public.claim_gallery_rendition_sweep_v1($1,60)', [randomUUID()]),
  finishSweep: () =>
    worker.query('SELECT public.finish_gallery_rendition_sweep_v1($1,$2,true)', [
      randomUUID(),
      randomUUID(),
    ]),
  settle: (athlete: string) =>
    worker.query('SELECT public.settle_gallery_rendition_v1($1,$2,$3,$4::jsonb)', [
      athlete,
      randomUUID(),
      randomUUID(),
      JSON.stringify({
        storageRef: 'x',
        sha256: 'a'.repeat(64),
        byteSize: 1,
        mediaType: 'image/webp',
        width: 1,
        height: 1,
        durationSeconds: null,
      }),
    ]),
  release: (athlete: string) =>
    worker.query("SELECT public.release_gallery_rendition_v1($1,$2,$3,'transient')", [
      athlete,
      randomUUID(),
      randomUUID(),
    ]),
};
async function expectWorkerClosed(athlete: string) {
  for (const call of [
    workerCalls.claim,
    workerCalls.claimSweep,
    workerCalls.finishSweep,
    () => workerCalls.settle(athlete),
    () => workerCalls.release(athlete),
  ])
    expect(await failure(call)).toMatchObject({ message: 'RESTORE_PROCESSING_CLOSED' });
}

beforeAll(async () => {
  for (const role of [ownerRole, apiRole, workerRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(connection(ownerRole), 107);
  await installProfile27(connection(ownerRole));
  await grantProfile27Runtime(connection(ownerRole), apiRole);
  await grantGalleryRenditionForTest(connection(ownerRole), 'api', apiRole);
  await grantGalleryRenditionForTest(connection(ownerRole), 'worker', workerRole);
  owner = new Pool({ connectionString: connection(ownerRole), max: 2 });
  worker = new Pool({ connectionString: connection(workerRole), max: 2 });
  api = createDatabase({ connectionString: connection(apiRole), max: 1 });
}, 300000);
afterAll(async () => {
  await api?.close().catch(() => undefined);
  await worker?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
}, 60000);

describe('SQL144 restore admission', () => {
  it('mints jobs and serves the worker while admitted', async () => {
    const athlete = await newAthlete();
    const media = await insertImage(athlete);
    expect(await jobs(athlete, media)).toEqual({ jobs: 2, sweeps: 0 });
    const store = createGalleryRenditionWorkerStore(worker, { leaseSeconds: 60 });
    const claim = await store.claim(randomUUID());
    expect(claim).toMatchObject({ athleteId: athlete, mediaItemId: media });
    if (!claim) throw new Error('claim');
    expect(
      await store.release({
        athleteId: athlete,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        code: 'transient',
      }),
    ).toMatchObject({ state: 'released' });
  });

  it('mints no job for a restore-load insert and refuses every worker RPC while a target is pending', async () => {
    const athlete = await newAthlete();
    const before = await insertImage(athlete);
    // A lease taken before the restore window cannot settle inside it.
    const store = createGalleryRenditionWorkerStore(worker, { leaseSeconds: 300 });
    const lease = await store.claim(randomUUID());
    if (!lease) throw new Error('claim');
    await pendRestoreTarget();
    try {
      const loaded = await insertImage(athlete, 'exclusive');
      expect(await jobs(athlete, loaded)).toEqual({ jobs: 0, sweeps: 0 });
      await expectWorkerClosed(athlete);
      expect(
        await failure(() =>
          worker.query('SELECT public.settle_gallery_rendition_v1($1,$2,$3,$4::jsonb)', [
            lease.athleteId,
            lease.jobId,
            lease.leaseToken,
            JSON.stringify({
              storageRef: 'x',
              sha256: 'a'.repeat(64),
              byteSize: 1,
              mediaType: 'image/webp',
              width: 1,
              height: 1,
              durationSeconds: null,
            }),
          ]),
        ),
      ).toMatchObject({ message: 'RESTORE_PROCESSING_CLOSED' });
      expect(await failure(() => enqueue(athlete, loaded))).toMatchObject({
        message: 'RESTORE_PROCESSING_CLOSED',
      });
      // Presentation reads stay available; deletion still retires jobs and arms the sweep.
      const read = await api.tenant(athlete, async (t) =>
        t.query('SELECT public.read_gallery_renditions_v1($1) AS v', [loaded]),
      );
      expect(read.rows[0]?.['v']).toMatchObject({ mediaItemId: loaded });
      await tx(owner, athlete, (c) =>
        c.query(
          'UPDATE public.gallery_media_item SET access_revision=2,updated_at=clock_timestamp(),deleted_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2',
          [athlete, before],
        ),
      );
      expect(await jobs(athlete, before)).toEqual({ jobs: 0, sweeps: 1 });
    } finally {
      await admit();
    }
    // Admission: the owner backfill regenerates the loaded item's jobs exactly once.
    const loadedItems = (
      await tx(owner, athlete, (c) =>
        c.query(
          'SELECT id::text FROM public.gallery_media_item WHERE athlete_id=$1 AND deleted_at IS NULL',
          [athlete],
        ),
      )
    ).rows.map((row) => z.string().parse(row['id']));
    expect(loadedItems).toHaveLength(1);
    const [loaded] = loadedItems;
    if (!loaded) throw new Error('loaded');
    expect(await enqueue(athlete, loaded)).toBe(2);
    expect(await enqueue(athlete, loaded)).toBe(0);
    expect(await jobs(athlete, loaded)).toEqual({ jobs: 2, sweeps: 0 });
    expect(await workerCalls.claim()).toBeDefined();
  });

  it('withdraws admission when the restore generation rotates and restores it on close', async () => {
    const athlete = await newAthlete();
    await owner.query('SELECT public.rotate_restore_generation()');
    try {
      const loaded = await insertImage(athlete, 'exclusive');
      expect(await jobs(athlete, loaded)).toEqual({ jobs: 0, sweeps: 0 });
      await expectWorkerClosed(athlete);
    } finally {
      await admit();
    }
    const media = await insertImage(athlete);
    expect(await jobs(athlete, media)).toEqual({ jobs: 2, sweeps: 0 });
  });

  it('keeps the runtime and worker rosters apart while closed', async () => {
    expect(
      await failure(() =>
        api.tenant(randomUUID(), (t) =>
          t.query('SELECT public.enqueue_gallery_renditions_v1(gen_random_uuid())'),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    expect(
      await failure(() => worker.query('SELECT public.gallery_rendition_processing_admitted_v1()')),
    ).toMatchObject({ code: '42501' });
  });
});
