import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { galleryRenditionListV1Schema } from '@workout/contracts/gallery-rendition';
import { migrate, grantGalleryMedia } from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import {
  createGalleryRenditionReader,
  createGalleryRenditionWorkerStore,
  type GalleryRenditionClaimRow,
} from '../src/gallery-renditions.js';
import {
  grantGalleryRenditionForTest,
  grantProfile26Runtime,
  installProfile26WithGalleryMembers,
} from './gallery-profile27-fixture.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// SQL144 (with 143/145) applied raw from pinned bytes over a committed profile26 parent and the
// separated API/worker rosters (test stand-in for the profile27 installer/grants). Synthetic
// tenants and hashes only; no media bytes are needed at this layer.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `gallery_renditions_${suffix}`;
const ownerRole = `gallery_rend_owner_${suffix}`;
const runtimeRole = `gallery_rend_app_${suffix}`;
const workerRole = `gallery_rend_worker_${suffix}`;
const roles: string[] = [];
const admin = new Pool({ connectionString: adminUrl, max: 1 });
let created = false;
let owner: Pool | undefined;
let worker: Pool | undefined;
let runtime: Database | undefined;
const workerA = randomUUID();
const workerB = randomUUID();

function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('GALLERY_RENDITION_FIXTURE_NOT_READY');
  return value;
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
const sha = (seed: string) => createHash('sha256').update(seed).digest('hex');
async function newAthlete(consent = true) {
  const athlete = randomUUID();
  await ownerTx(athlete, (tx) =>
    tx.query("INSERT INTO public.consent(athlete_id,kind,granted,revision) VALUES($1,'app',$2,1)", [
      athlete,
      consent,
    ]),
  );
  return athlete;
}
async function insertMedia(athlete: string, kind: 'image' | 'video' = 'image') {
  const id = randomUUID();
  const hash = sha(id);
  const mediaType = kind === 'image' ? 'image/jpeg' : 'video/mp4';
  const extension = kind === 'image' ? 'jpg' : 'mp4';
  await ownerTx(athlete, (tx) =>
    tx.query(
      `INSERT INTO public.gallery_media_item(athlete_id,id,media_kind,storage_ref,original_filename,
       media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
       VALUES($1,$2,$3,$4,'synthetic.bin',$5,4096,$6,1,clock_timestamp(),clock_timestamp())`,
      [
        athlete,
        id,
        kind,
        `private/v1/tenants/${athlete}/gallery/${id}/objects/uploads/${randomUUID()}/sha256/${hash}.${extension}`,
        mediaType,
        hash,
      ],
    ),
  );
  return { id, hash };
}
async function jobs(athlete: string, media: string) {
  return ownerTx(athlete, async (tx) =>
    z
      .array(
        z.object({
          kind: z.string(),
          state: z.string(),
          attempts: z.number(),
          source_sha256: z.string(),
          parent_access_revision: z.number(),
          failure_code: z.string().nullable(),
          retry_eligibility: z.string().nullable(),
        }),
      )
      .parse(
        (
          await tx.query(
            `SELECT kind,state,attempts,source_sha256,parent_access_revision,failure_code,retry_eligibility
             FROM public.gallery_rendition_job WHERE athlete_id=$1 AND media_item_id=$2 ORDER BY kind`,
            [athlete, media],
          )
        ).rows,
      ),
  );
}
/** Owner-only test clock: make a queued job due now without touching its lineage. */
async function makeDue(athlete: string, media: string) {
  await ownerTx(athlete, (tx) =>
    tx.query(
      `UPDATE public.gallery_rendition_job SET available_at=clock_timestamp()-interval '1 second',
       updated_at=clock_timestamp() WHERE athlete_id=$1 AND media_item_id=$2 AND state='queued'`,
      [athlete, media],
    ),
  );
}
const store = () => createGalleryRenditionWorkerStore(need(worker), { leaseSeconds: 60 });
async function claimFor(athlete: string, media: string, id = workerA) {
  // Other tests' due jobs may be ahead in the global order; claim until this item's job.
  for (let i = 0; i < 40; i++) {
    const claim = await store().claim(id);
    if (claim === null) return null;
    if (claim.athleteId === athlete && claim.mediaItemId === media) return claim;
    await store().release({
      athleteId: claim.athleteId,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      code: 'aborted',
    });
  }
  throw new Error('CLAIM_NOT_REACHED');
}
function outputFor(claim: GalleryRenditionClaimRow, seed = 'out') {
  const digest = sha(seed + claim.leaseToken);
  const video = claim.kind === 'video_playback';
  return {
    storageRef: `private/v1/tenants/${claim.athleteId}/gallery/${claim.mediaItemId}/renditions/v1/${claim.kind}/${claim.jobId}/${claim.leaseToken}/sha256/${digest}.${video ? 'mp4' : 'webp'}`,
    sha256: digest,
    byteSize: 1000,
    mediaType: video ? ('video/mp4' as const) : ('image/webp' as const),
    width: claim.kind === 'image_thumbnail' ? 320 : 640,
    height: 240,
    durationSeconds: video ? 1.5 : null,
  };
}
async function sqlState(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const parsed = z.object({ code: z.string().optional() }).safeParse(error);
    return parsed.success ? (parsed.data.code ?? 'no_code') : 'no_code';
  }
  return 'no_error';
}
async function message(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : 'unknown';
  }
  return 'no_error';
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(connection(ownerRole), 107);
  await installProfile26WithGalleryMembers(connection(ownerRole));
  await grantProfile26Runtime(connection(ownerRole), runtimeRole);
  await grantGalleryMedia(connection(ownerRole), runtimeRole);
  // Pinned 143/144/145 bytes over profile26 and the two least-privilege rosters (API / worker).
  await grantGalleryRenditionForTest(connection(ownerRole), 'worker', workerRole);
  await grantGalleryRenditionForTest(connection(ownerRole), 'api', runtimeRole);
  owner = new Pool({ connectionString: connection(ownerRole), max: 4 });
  // The idempotent backfill RPC is not part of the API grant; these tests exercise it
  // through the runtime role with an explicit, test-only grant.
  await owner.query(
    `GRANT EXECUTE ON FUNCTION public.enqueue_gallery_renditions_v1(uuid) TO "${runtimeRole}"`,
  );
  worker = new Pool({ connectionString: connection(workerRole), max: 4 });
  runtime = createDatabase({ connectionString: connection(runtimeRole), max: 4 });
}, 180000);

afterAll(async () => {
  await runtime?.close();
  await worker?.end();
  await owner?.end();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
}, 30000);

describe('SQL144 gallery renditions on owned PostgreSQL', () => {
  it('installs FORCE-RLS ledgers on a plain owner and grants no direct table access', async () => {
    const observed = await need(owner).query(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AS plain,
      (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN
       ('public.gallery_rendition_job'::regclass,'public.gallery_rendition_due'::regclass,
        'public.gallery_rendition_sweep'::regclass)) AS forced
      FROM pg_roles r WHERE r.rolname=current_user`);
    expect(observed.rows[0]).toEqual({ plain: true, forced: true });
    for (const table of [
      'gallery_rendition_job',
      'gallery_rendition_due',
      'gallery_rendition_sweep',
    ])
      expect(await sqlState(() => need(worker).query(`SELECT 1 FROM public.${table}`))).toBe(
        '42501',
      );
    expect(
      await sqlState(() =>
        need(worker).query('SELECT public.read_gallery_renditions_v1(gen_random_uuid())'),
      ),
    ).toBe('42501');
    const athlete = await newAthlete();
    expect(
      await sqlState(() =>
        need(runtime).tenant(athlete, (tx) =>
          tx.query('SELECT public.claim_gallery_rendition_v1(gen_random_uuid(),60)'),
        ),
      ),
    ).toBe('42501');
  });

  it('queues exact recipe jobs with the original lineage in the creating transaction', async () => {
    const athlete = await newAthlete();
    const image = await insertMedia(athlete, 'image');
    const video = await insertMedia(athlete, 'video');
    expect(await jobs(athlete, image.id)).toEqual(
      ['image_preview', 'image_thumbnail'].map((kind) => ({
        kind,
        state: 'queued',
        attempts: 0,
        source_sha256: image.hash,
        parent_access_revision: 1,
        failure_code: null,
        retry_eligibility: null,
      })),
    );
    expect((await jobs(athlete, video.id)).map((job) => job.kind)).toEqual(['video_playback']);
    const reader = createGalleryRenditionReader(need(runtime));
    expect(await reader.enqueue(athlete, image.id)).toBe(0);
    const list = await reader.list(athlete, image.id);
    expect(list?.renditions.map((r) => [r.kind, r.state])).toEqual([
      ['image_preview', 'queued'],
      ['image_thumbnail', 'queued'],
    ]);
    // Another tenant sees nothing; an unknown id is not fabricated as a state.
    expect(await reader.list(await newAthlete(), image.id)).toBeNull();
    // Lineage is immutable even for the owner.
    expect(
      await message(() =>
        ownerTx(athlete, (tx) =>
          tx.query(
            `UPDATE public.gallery_rendition_job SET source_sha256=$3,updated_at=clock_timestamp()
             WHERE athlete_id=$1 AND media_item_id=$2`,
            [athlete, image.id, 'f'.repeat(64)],
          ),
        ),
      ),
    ).toBe('GALLERY_RENDITION_TRANSITION_INVALID');
  });

  it('leases, settles an exact-lineage receipt once and replays it after a lost reply', async () => {
    const athlete = await newAthlete();
    const image = await insertMedia(athlete, 'image');
    const claim = need((await claimFor(athlete, image.id)) ?? undefined);
    expect(claim).toMatchObject({ sourceSha256: image.hash, attempt: 1, parentAccessRevision: 1 });
    const reader = createGalleryRenditionReader(need(runtime));
    const running = await reader.list(athlete, image.id);
    expect(running?.renditions.find((r) => r.kind === claim.kind)?.state).toBe('running');
    // A receipt naming another job, lease or tenant violates the exact lineage CHECK.
    const output = outputFor(claim);
    for (const storageRef of [
      output.storageRef.replace(claim.leaseToken, randomUUID()),
      output.storageRef.replace(claim.jobId, randomUUID()),
      output.storageRef.replace(athlete, randomUUID()),
    ])
      expect(
        await sqlState(() =>
          store().settle({
            athleteId: athlete,
            jobId: claim.jobId,
            leaseToken: claim.leaseToken,
            output: { ...output, storageRef },
          }),
        ),
      ).toBe('23514');
    // Output budget is enforced in SQL too (thumbnail max 320 px).
    expect(
      await sqlState(() =>
        store().settle({
          athleteId: athlete,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          output: { ...output, width: claim.kind === 'image_thumbnail' ? 321 : 1601 },
        }),
      ),
    ).not.toBe('no_error');
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: claim.jobId,
        leaseToken: randomUUID(),
        output,
      }),
    ).toEqual({ state: 'rejected', reason: 'lease_lost' });
    const settle = {
      athleteId: athlete,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      output,
    };
    expect(await store().settle(settle)).toEqual({ state: 'ready' });
    expect(await store().settle(settle)).toEqual({ state: 'ready' });
    const ready = galleryRenditionListV1Schema.parse(await reader.list(athlete, image.id));
    const rendition = ready.renditions.find((r) => r.kind === claim.kind);
    expect(rendition).toMatchObject({
      state: 'ready',
      originalSha256: image.hash,
      output: { sha256: output.sha256, byteSize: 1000 },
    });
    expect(JSON.stringify(ready)).not.toContain('private/v1');
    expect(await reader.resolveObject(athlete, image.id, claim.kind)).toEqual({
      storageRef: output.storageRef,
      sha256: output.sha256,
      byteSize: 1000,
      mediaType: 'image/webp',
    });
    // A ready job is terminal and never leased again.
    expect(
      await message(() =>
        ownerTx(athlete, (tx) =>
          tx.query(
            `UPDATE public.gallery_rendition_job SET state='queued',lease_token=NULL,
             output_storage_ref=NULL,output_sha256=NULL,output_byte_size=NULL,output_media_type=NULL,
             output_width=NULL,output_height=NULL,updated_at=clock_timestamp()
             WHERE athlete_id=$1 AND job_id=$2`,
            [athlete, claim.jobId],
          ),
        ),
      ),
    ).toBe('GALLERY_RENDITION_TRANSITION_INVALID');
  });

  it('makes deterministic codec failures terminal and bounds transient retries to three', async () => {
    const athlete = await newAthlete();
    const image = await insertMedia(athlete, 'image');
    const first = need((await claimFor(athlete, image.id)) ?? undefined);
    expect(
      await store().release({
        athleteId: athlete,
        jobId: first.jobId,
        leaseToken: first.leaseToken,
        code: 'decode_failed',
      }),
    ).toEqual({ state: 'released', outcome: 'failed' });
    const second = need((await claimFor(athlete, image.id)) ?? undefined);
    expect(second.kind).not.toBe(first.kind);
    expect(
      await store().release({
        athleteId: athlete,
        jobId: second.jobId,
        leaseToken: second.leaseToken,
        code: 'transient',
      }),
    ).toEqual({ state: 'released', outcome: 'requeued' });
    // Backoff: not due again yet.
    expect(await claimFor(athlete, image.id)).toBeNull();
    for (const expected of ['requeued', 'failed']) {
      await makeDue(athlete, image.id);
      const next = need((await claimFor(athlete, image.id)) ?? undefined);
      expect(next.jobId).toBe(second.jobId);
      expect(
        (
          await store().release({
            athleteId: athlete,
            jobId: next.jobId,
            leaseToken: next.leaseToken,
            code: 'timeout',
          })
        ).outcome,
      ).toBe(expected);
    }
    const terminal = Object.fromEntries(
      (await jobs(athlete, image.id)).map((j) => [
        j.kind,
        [j.state, j.failure_code, j.retry_eligibility, j.attempts],
      ]),
    );
    expect(terminal).toEqual({
      [first.kind]: ['failed', 'decode_failed', 'ineligible', 1],
      [second.kind]: ['failed', 'timeout', 'ineligible', 3],
    });
    await makeDue(athlete, image.id);
    expect(await claimFor(athlete, image.id)).toBeNull();
    const list = await createGalleryRenditionReader(need(runtime)).list(athlete, image.id);
    expect(
      list?.renditions.every((r) => r.state === 'failed' && r.retryEligibility === 'ineligible'),
    ).toBe(true);
  });

  it('records unsupported input without retry and postpones work without app consent', async () => {
    const athlete = await newAthlete();
    const video = await insertMedia(athlete, 'video');
    const claim = need((await claimFor(athlete, video.id)) ?? undefined);
    expect(
      (
        await store().release({
          athleteId: athlete,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          code: 'unsupported_format',
        })
      ).outcome,
    ).toBe('unsupported');
    expect((await jobs(athlete, video.id))[0]).toMatchObject({
      state: 'unsupported',
      failure_code: 'unsupported_format',
      attempts: 1,
    });
    const withdrawn = await newAthlete(false);
    const pending = await insertMedia(withdrawn, 'video');
    expect(await claimFor(withdrawn, pending.id)).toBeNull();
    expect((await jobs(withdrawn, pending.id))[0]).toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('rejects a late settle after soft delete, queues outputs and arms a delayed sweep', async () => {
    const athlete = await newAthlete();
    const image = await insertMedia(athlete, 'image');
    const done = need((await claimFor(athlete, image.id)) ?? undefined);
    const doneOutput = outputFor(done);
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: done.jobId,
        leaseToken: done.leaseToken,
        output: doneOutput,
      }),
    ).toEqual({ state: 'ready' });
    const inflight = need((await claimFor(athlete, image.id)) ?? undefined);
    const media = createGalleryMediaRepository(need(runtime));
    const deleted = await media.softDelete(athlete, image.id, {
      expectedAccessRevision: 1,
      idempotencyKey: `delete-${randomUUID()}`,
    });
    expect(deleted.status).toBe('deleted');
    expect(await jobs(athlete, image.id)).toEqual([]);
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: inflight.jobId,
        leaseToken: inflight.leaseToken,
        output: outputFor(inflight),
      }),
    ).toEqual({ state: 'rejected', reason: 'deleted' });
    expect(
      await store().release({
        athleteId: athlete,
        jobId: inflight.jobId,
        leaseToken: inflight.leaseToken,
        code: 'transient',
      }),
    ).toEqual({ state: 'released', outcome: 'released' });
    const queued = await ownerTx(athlete, async (tx) => ({
      cleanup: (
        await tx.query(
          'SELECT reason FROM public.resource_object_cleanup WHERE storage_ref=$1 AND completed_at IS NULL',
          [doneOutput.storageRef],
        )
      ).rows,
      sweeps: (
        await tx.query(
          `SELECT cause,job_id,available_at>clock_timestamp()+interval '9 minutes' AS delayed
           FROM public.gallery_rendition_sweep WHERE athlete_id=$1 AND media_item_id=$2`,
          [athlete, image.id],
        )
      ).rows,
    }));
    expect(queued).toEqual({
      cleanup: [{ reason: 'resource_deleted' }],
      sweeps: [{ cause: 'media_deleted', job_id: null, delayed: true }],
    });
    const reader = createGalleryRenditionReader(need(runtime));
    const list = await reader.list(athlete, image.id);
    expect(list?.renditions.map((r) => r.state === 'unavailable' && r.reason)).toEqual([
      'media_deleted',
      'media_deleted',
    ]);
    expect(await reader.resolveObject(athlete, image.id, 'image_preview')).toBeNull();
    expect(await message(() => reader.enqueue(athlete, image.id))).toBe('MEDIA_NOT_FOUND');
    expect(await claimFor(athlete, image.id)).toBeNull();
  });

  it('serializes a concurrent settle and delete so no receipt survives the tombstone', async () => {
    for (let round = 0; round < 3; round++) {
      const athlete = await newAthlete();
      const image = await insertMedia(athlete, 'image');
      const claim = need((await claimFor(athlete, image.id)) ?? undefined);
      const media = createGalleryMediaRepository(need(runtime));
      const [settled, deleted] = await Promise.allSettled([
        store().settle({
          athleteId: athlete,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          output: outputFor(claim, `race${round}`),
        }),
        media.softDelete(athlete, image.id, {
          expectedAccessRevision: 1,
          idempotencyKey: `delete-${randomUUID()}`,
        }),
      ]);
      expect(deleted.status).toBe('fulfilled');
      expect(settled.status).toBe('fulfilled');
      expect(await jobs(athlete, image.id)).toEqual([]);
      if (settled.status === 'fulfilled' && settled.value.state === 'ready') {
        const rows = await ownerTx(athlete, (tx) =>
          tx.query('SELECT 1 FROM public.resource_object_cleanup WHERE storage_ref=$1', [
            outputFor(claim, `race${round}`).storageRef,
          ]),
        );
        expect(rows.rowCount).toBe(1);
      }
    }
  });

  it('reclaims an expired lease once, rejects the stale holder and sweeps only that attempt', async () => {
    const athlete = await newAthlete();
    const video = await insertMedia(athlete, 'video');
    const short = createGalleryRenditionWorkerStore(need(worker), { leaseSeconds: 5 });
    let first: GalleryRenditionClaimRow | null = null;
    for (let i = 0; i < 40 && first === null; i++) {
      const claim = await short.claim(workerA);
      if (claim === null) break;
      if (claim.mediaItemId === video.id) first = claim;
      else
        await short.release({
          athleteId: claim.athleteId,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          code: 'aborted',
        });
    }
    const held = need(first ?? undefined);
    expect(await claimFor(athlete, video.id, workerB)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5500));
    // Expired but not yet reclaimed: the holder can no longer publish a receipt.
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: held.jobId,
        leaseToken: held.leaseToken,
        output: outputFor(held, 'expired'),
      }),
    ).toEqual({ state: 'rejected', reason: 'lease_lost' });
    const second = need((await claimFor(athlete, video.id, workerB)) ?? undefined);
    expect(second.jobId).toBe(held.jobId);
    expect(second.leaseToken).not.toBe(held.leaseToken);
    expect(second.attempt).toBe(2);
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: held.jobId,
        leaseToken: held.leaseToken,
        output: outputFor(held),
      }),
    ).toEqual({ state: 'rejected', reason: 'lease_lost' });
    const sweeps = await ownerTx(athlete, (tx) =>
      tx.query(
        `SELECT cause,attempt_id::text AS attempt FROM public.gallery_rendition_sweep
         WHERE athlete_id=$1 AND media_item_id=$2 ORDER BY attempt_id`,
        [athlete, video.id],
      ),
    );
    expect(sweeps.rows).toEqual([{ cause: 'attempt_abandoned', attempt: held.leaseToken }]);
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: second.jobId,
        leaseToken: second.leaseToken,
        output: outputFor(second),
      }),
    ).toEqual({ state: 'ready' });
  }, 20000);

  it('retires every job on account erasure and leaves no live rendition state', async () => {
    const athlete = await newAthlete();
    const image = await insertMedia(athlete, 'image');
    const claim = need((await claimFor(athlete, image.id)) ?? undefined);
    const output = outputFor(claim);
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        output,
      }),
    ).toEqual({ state: 'ready' });
    const inflight = need((await claimFor(athlete, image.id)) ?? undefined);
    const tx = await need(owner).connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
      await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await tx.query('SELECT public.erase_account($1)', [athlete]);
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }
    const after = await ownerTx(athlete, async (owned) => ({
      jobs: (
        await owned.query('SELECT 1 FROM public.gallery_rendition_job WHERE athlete_id=$1', [
          athlete,
        ])
      ).rowCount,
      cleanup: (
        await owned.query(
          'SELECT reason FROM public.resource_object_cleanup WHERE storage_ref=$1',
          [output.storageRef],
        )
      ).rows,
      sweeps: (
        await owned.query(
          'SELECT cause FROM public.gallery_rendition_sweep WHERE athlete_id=$1 AND job_id IS NULL',
          [athlete],
        )
      ).rows,
    }));
    expect(after).toEqual({
      jobs: 0,
      cleanup: [{ reason: 'account_erased' }],
      sweeps: [{ cause: 'account_erased' }],
    });
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: inflight.jobId,
        leaseToken: inflight.leaseToken,
        output: outputFor(inflight),
      }),
    ).toEqual({ state: 'rejected', reason: 'deleted' });
  });

  it('hands a due media sweep out once and never sweeps a live item or a ready attempt', async () => {
    const athlete = await newAthlete();
    const live = await insertMedia(athlete, 'image');
    const claim = need((await claimFor(athlete, live.id)) ?? undefined);
    expect(
      await store().settle({
        athleteId: athlete,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        output: outputFor(claim),
      }),
    ).toEqual({ state: 'ready' });
    const gone = await insertMedia(athlete, 'video');
    await createGalleryMediaRepository(need(runtime)).softDelete(athlete, gone.id, {
      expectedAccessRevision: 1,
      idempotencyKey: `delete-${randomUUID()}`,
    });
    // Planted sweeps (owner-only table): one for the live item, one for its ready attempt.
    await ownerTx(athlete, async (tx) => {
      await tx.query(
        `INSERT INTO public.gallery_rendition_sweep(sweep_id,athlete_id,media_item_id,cause,available_at,created_at)
         VALUES(gen_random_uuid(),$1,$2,'media_deleted',clock_timestamp()-interval '1 minute',clock_timestamp())`,
        [athlete, live.id],
      );
      await tx.query(
        `INSERT INTO public.gallery_rendition_sweep(sweep_id,athlete_id,media_item_id,job_id,attempt_id,cause,available_at,created_at)
         VALUES(gen_random_uuid(),$1,$2,$3,$4,'attempt_abandoned',clock_timestamp()-interval '1 minute',clock_timestamp())`,
        [athlete, live.id, claim.jobId, claim.leaseToken],
      );
      await tx.query(
        `UPDATE public.gallery_rendition_sweep SET available_at=clock_timestamp()-interval '1 minute'
         WHERE athlete_id=$1 AND media_item_id=$2`,
        [athlete, gone.id],
      );
    });
    const seen: string[] = [];
    for (let i = 0; i < 50; i++) {
      const sweep = await store().claimSweep(workerA);
      if (sweep === null) break;
      if (sweep.athleteId === athlete) seen.push(sweep.mediaItemId);
      expect(await store().finishSweep(sweep.sweepId, workerA, true)).toBe(true);
    }
    expect(seen).toEqual([gone.id]);
    const left = await ownerTx(athlete, (tx) =>
      tx.query('SELECT 1 FROM public.gallery_rendition_sweep WHERE athlete_id=$1', [athlete]),
    );
    expect(left.rowCount).toBe(0);
    expect((await jobs(athlete, live.id)).find((j) => j.kind === claim.kind)?.state).toBe('ready');
  });

  it('hands one due job to exactly one of several concurrent workers', async () => {
    for (let claim = await store().claim(workerA); claim; claim = await store().claim(workerA))
      await store().release({
        athleteId: claim.athleteId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        code: 'aborted',
      });
    const athlete = await newAthlete();
    const video = await insertMedia(athlete, 'video');
    const workers = Array.from({ length: 6 }, () => randomUUID());
    const claims = await Promise.all(workers.map((id) => store().claim(id)));
    const mine = claims.filter((claim) => claim?.mediaItemId === video.id);
    expect(mine).toHaveLength(1);
    for (const claim of claims)
      if (claim && claim.mediaItemId !== video.id)
        await store().release({
          athleteId: claim.athleteId,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          code: 'aborted',
        });
  });
});
