import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import {
  createGalleryMediaExtensionRepository,
  createGalleryMediaRepository,
} from '../src/gallery-media.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  grantGalleryNavigationRuntimeForTest,
  grantProfile26Runtime,
  installProfile26WithGalleryMembers,
} from './gallery-profile27-fixture.js';

// SQL145 on disposable PostgreSQL 17.6 over a committed profile26 parent with 143/144/145
// applied raw from pinned bytes: the album deletion suppression event, the exact owner-only
// album replay and the media-deletion navigation cleanup trigger. Synthetic rows only.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const name = `gallery_album_supp_${suffix}`;
const ownerRole = `gas_owner_${suffix}`;
const runtimeRole = `gas_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const roles: string[] = [];
let created = false;
let owner: Pool;
let runtime: Pool;
let database: Database;

function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
function sqlState(error: unknown) {
  const parsed = z.object({ code: z.string().optional(), message: z.string() }).safeParse(error);
  return parsed.success ? { code: parsed.data.code, message: parsed.data.message } : null;
}
async function failure(work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    return sqlState(error);
  }
  return null;
}
type Fence = 'shared' | 'exclusive' | 'none';
/** Owner transaction with the caller-held global restore fence, then the tenant setting. */
async function ownerTenant<T>(
  athlete: string,
  work: (tx: PoolClient) => Promise<T>,
  fence: Fence = 'shared',
  pool: Pool = owner,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    if (fence === 'shared') await tx.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    if (fence === 'exclusive') await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
    await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await work(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
async function account(): Promise<string> {
  const row = await owner.query<{ athlete_id: string }>(
    `INSERT INTO identity_private.account(issuer,subject)
     VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
    [randomUUID()],
  );
  const id = row.rows[0]?.athlete_id;
  if (!id) throw new Error('missing account');
  return id;
}
async function insertImage(athlete: string) {
  const id = randomUUID();
  const hash = randomUUID().replaceAll('-', '').padEnd(64, '0');
  await ownerTenant(athlete, (tx) =>
    tx.query(
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
  );
  return id;
}
const albumSchema = z.object({ id: z.string(), revision: z.number() });
async function createAlbum(athlete: string, title = '합성 앨범') {
  return ownerTenant(athlete, async (tx) =>
    albumSchema.parse(
      (
        await tx.query('SELECT public.create_gallery_album_v1($1::jsonb,$2) AS value', [
          JSON.stringify({ title }),
          `synthetic-${randomUUID()}`,
        ])
      ).rows[0]?.['value'],
    ),
  );
}
async function deleteAlbum(athlete: string, albumId: string, expectedRevision: number) {
  return ownerTenant(
    athlete,
    async (tx) =>
      (
        await tx.query('SELECT public.delete_gallery_album_v1($1::jsonb,$2) AS value', [
          JSON.stringify({ albumId, expectedRevision }),
          `synthetic-${randomUUID()}`,
        ])
      ).rows[0]?.['value'],
  );
}
async function attach(athlete: string, mediaItemId: string, albumId: string, revision: number) {
  return ownerTenant(athlete, (tx) =>
    tx.query('SELECT public.set_gallery_media_navigation_v1($1::jsonb,$2)', [
      JSON.stringify({
        mediaItemId,
        expectedAccessRevision: revision,
        albumMembership: { albumId },
        courseLink: null,
      }),
      `synthetic-${randomUUID()}`,
    ]),
  );
}
async function albumEvents(athlete: string) {
  return (
    await owner.query(
      `SELECT event_id::text AS "eventId",record_version AS "recordVersion",kind,target_id::text AS "targetId",
        gallery_access_revision AS revision,occurred_at AS "occurredAt"
       FROM public.restore_suppression_event WHERE athlete_id=$1 AND kind='gallery_album_deleted'
       ORDER BY occurred_at`,
      [athlete],
    )
  ).rows;
}
async function navigationState(athlete: string, media: string) {
  return ownerTenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*)::int FROM public.gallery_media_album_membership
             WHERE athlete_id=$1 AND media_item_id=$2) AS memberships,
           (SELECT count(*)::int FROM public.gallery_navigation_command_receipt
             WHERE athlete_id=$1 AND target_media_item_id=$2 AND state='committed') AS committed,
           (SELECT count(*)::int FROM public.gallery_navigation_command_receipt
             WHERE athlete_id=$1 AND target_media_item_id=$2 AND state='redacted') AS redacted,
           (SELECT access_revision FROM public.gallery_media_item WHERE athlete_id=$1 AND id=$2) AS revision,
           (SELECT deleted_at IS NOT NULL FROM public.gallery_media_item WHERE athlete_id=$1 AND id=$2) AS deleted`,
          [athlete, media],
        )
      ).rows[0],
  );
}
async function dbNow() {
  return z.string().parse(
    (
      await owner.query(
        `SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`,
      )
    ).rows[0]?.['at'],
  );
}
async function replayAlbum(
  athlete: string,
  album: string,
  eventId: string,
  occurredAt: string,
  revision: number,
  fence: Fence = 'exclusive',
  pool: Pool = owner,
) {
  return ownerTenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          'SELECT public.replay_gallery_album_deletion_exact_v1($1,$2,$3,$4,$5) AS value',
          [athlete, album, eventId, occurredAt, revision],
        )
      ).rows[0]?.['value'],
    fence,
    pool,
  );
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
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
  await grantGalleryNavigationRuntimeForTest(connection(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: connection(ownerRole), max: 3 });
  runtime = new Pool({ connectionString: connection(runtimeRole), max: 2 });
  database = createDatabase({ connectionString: connection(runtimeRole), max: 2 });
}, 300000);
afterAll(async () => {
  await database?.close().catch(() => undefined);
  await runtime?.end().catch(() => undefined);
  await owner?.end().catch(() => undefined);
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
}, 60000);

describe('SQL145 album deletion suppression event', () => {
  it('mints exactly one record_version 8 event on the live -> deleted transition only', async () => {
    const athlete = await account();
    const album = await createAlbum(athlete);
    await ownerTenant(athlete, (tx) =>
      tx.query('SELECT public.rename_gallery_album_v1($1::jsonb,$2)', [
        JSON.stringify({ albumId: album.id, expectedRevision: 1, title: '새 이름' }),
        `synthetic-${randomUUID()}`,
      ]),
    );
    expect(await albumEvents(athlete)).toEqual([]);
    const deleted = z
      .object({ revision: z.number(), status: z.literal('deleted') })
      .parse(await deleteAlbum(athlete, album.id, 2));
    expect(deleted.revision).toBe(3);
    const events = await albumEvents(athlete);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ recordVersion: 8, targetId: album.id, revision: 3 });
    const ledger = await ownerTenant(
      athlete,
      async (tx) =>
        (
          await tx.query(
            'SELECT deleted_revision AS revision,deleted_at AS "deletedAt" FROM public.gallery_album_deletion WHERE athlete_id=$1 AND album_id=$2',
            [athlete, album.id],
          )
        ).rows[0],
    );
    expect(ledger).toEqual({ revision: 3, deletedAt: events[0]?.['occurredAt'] });
  });

  it('mints no event when a restore load inserts an already deleted album and its ledger', async () => {
    const athlete = await account();
    const album = randomUUID();
    await ownerTenant(
      athlete,
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
        await tx.query(
          `INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at,deleted_at)
           VALUES($1,$2,'적재',2,'2026-01-01Z','2026-01-02Z','2026-01-02Z')`,
          [athlete, album],
        );
        await tx.query("INSERT INTO public.gallery_album_deletion VALUES($1,$2,2,'2026-01-02Z')", [
          athlete,
          album,
        ]);
      },
      'exclusive',
    );
    expect(await albumEvents(athlete)).toEqual([]);
  });

  it('keeps every earlier event branch and admits the album branch only exactly', async () => {
    const athlete = await account();
    const target = randomUUID();
    const insert = (columns: string, values: string) =>
      failure(() =>
        owner.query(
          `INSERT INTO public.restore_suppression_event(athlete_id,occurred_at,${columns}) VALUES($1,clock_timestamp(),${values})`,
          [athlete, target],
        ),
      );
    // Wrong record version, out-of-range revision and an extra column are all rejected.
    expect(
      await insert(
        'record_version,kind,target_id,gallery_access_revision',
        "1,'gallery_album_deleted',$2,2",
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await insert(
        'record_version,kind,target_id,gallery_access_revision',
        "8,'gallery_album_deleted',$2,1",
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await insert(
        'record_version,kind,target_id,gallery_access_revision,resource_access_revision',
        "8,'gallery_album_deleted',$2,2,2",
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await insert(
        'record_version,kind,target_id,gallery_access_revision',
        "8,'gallery_media_deleted',$2,2",
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await insert(
        'record_version,kind,target_id,gallery_access_revision',
        "8,'gallery_album_deleted',$2,2",
      ),
    ).toBeNull();
    expect(
      await insert(
        'record_version,kind,target_id,gallery_access_revision',
        "8,'gallery_album_deleted',$2,3",
      ),
    ).toMatchObject({ code: '23505' });
    // An older branch (gallery media deletion, record version 1) is unchanged.
    expect(
      await insert(
        'record_version,kind,target_id,gallery_access_revision',
        "1,'gallery_media_deleted',$2,2",
      ),
    ).toBeNull();
    // Events stay immutable.
    expect(
      await failure(() =>
        owner.query(
          "UPDATE public.restore_suppression_event SET occurred_at=clock_timestamp() WHERE athlete_id=$1 AND kind='gallery_album_deleted'",
          [athlete],
        ),
      ),
    ).not.toBeNull();
  });
});

describe('SQL145 media deletion removes navigation relations in the deleting transaction', () => {
  it('cleans membership and redacts receipts on the plain media delete path', async () => {
    const athlete = await account();
    const media = await insertImage(athlete);
    const album = await createAlbum(athlete);
    await attach(athlete, media, album.id, 1);
    expect(await navigationState(athlete, media)).toMatchObject({
      memberships: 1,
      committed: 1,
      revision: 2,
      deleted: false,
    });
    // The plain repository does not call remove_gallery_navigation_deleted_media_v1.
    const result = await createGalleryMediaRepository(database).softDelete(athlete, media, {
      expectedAccessRevision: 2,
      idempotencyKey: `synthetic-delete-${randomUUID()}`,
    });
    expect(result).toMatchObject({ status: 'deleted', accessRevision: 3 });
    expect(await navigationState(athlete, media)).toEqual({
      memberships: 0,
      committed: 0,
      redacted: 1,
      revision: 3,
      deleted: true,
    });
  });

  it('stays idempotent with the extension path that also calls the SQL143 removal', async () => {
    const athlete = await account();
    const media = await insertImage(athlete);
    const album = await createAlbum(athlete);
    await attach(athlete, media, album.id, 1);
    const result = await createGalleryMediaExtensionRepository(database).softDelete(
      athlete,
      media,
      { expectedAccessRevision: 2, idempotencyKey: `synthetic-delete-${randomUUID()}` },
    );
    expect(result).toMatchObject({ status: 'deleted' });
    expect(await navigationState(athlete, media)).toMatchObject({
      memberships: 0,
      committed: 0,
      redacted: 1,
      deleted: true,
    });
  });

  it('lets the exact media deletion replay (082) leave no membership behind', async () => {
    const athlete = await account();
    const media = await insertImage(athlete);
    const album = await createAlbum(athlete);
    await attach(athlete, media, album.id, 1);
    const at = await dbNow();
    const args = [athlete, media, randomUUID(), at, 3];
    const sql = 'SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5) AS value';
    // Without the global restore fence the SQL143 guard refuses to touch a relation: fail closed.
    expect(
      await failure(() => ownerTenant(athlete, (tx) => tx.query(sql, args), 'none')),
    ).toMatchObject({ message: 'GALLERY_ALBUM_GLOBAL_LOCK_REQUIRED' });
    expect(await navigationState(athlete, media)).toMatchObject({ memberships: 1, deleted: false });
    // The owner replay holds the fence exclusively (restore-suppression-replay.ts).
    expect(
      await ownerTenant(
        athlete,
        async (tx) => (await tx.query(sql, args)).rows[0]?.['value'],
        'exclusive',
      ),
    ).toBe('deleted');
    expect(await navigationState(athlete, media)).toEqual({
      memberships: 0,
      committed: 0,
      redacted: 1,
      revision: 3,
      deleted: true,
    });
  });

  it('needs no SQL143 lock when the deleted item has no navigation relation', async () => {
    const athlete = await account();
    const media = await insertImage(athlete);
    const sql = 'SELECT public.replay_gallery_media_deletion_exact($1,$2,$3,$4,$5) AS value';
    expect(
      await ownerTenant(
        athlete,
        async (tx) =>
          (await tx.query(sql, [athlete, media, randomUUID(), await dbNow(), 2])).rows[0]?.[
            'value'
          ],
        'none',
      ),
    ).toBe('deleted');
  });
});

describe('SQL145 exact album deletion replay', () => {
  it('replays a live album exactly once with detach, ledger, redaction, outbox, event and receipt', async () => {
    const athlete = await account();
    const album = await createAlbum(athlete);
    const media = await insertImage(athlete);
    await attach(athlete, media, album.id, 1);
    const eventId = randomUUID();
    const at = await dbNow();
    expect(await replayAlbum(athlete, album.id, eventId, at, 2)).toBe('deleted');
    expect(await navigationState(athlete, media)).toMatchObject({
      memberships: 0,
      revision: 3,
      deleted: false,
    });
    const events = await albumEvents(athlete);
    expect(events).toEqual([
      expect.objectContaining({ eventId, recordVersion: 8, targetId: album.id, revision: 2 }),
    ]);
    const state = await ownerTenant(
      athlete,
      async (tx) =>
        (
          await tx.query(
            `SELECT (SELECT revision FROM public.gallery_album WHERE athlete_id=$1 AND id=$2) AS revision,
              (SELECT deleted_at IS NOT NULL FROM public.gallery_album WHERE athlete_id=$1 AND id=$2) AS deleted,
              (SELECT count(*)::int FROM public.gallery_album_deletion WHERE athlete_id=$1 AND album_id=$2 AND deleted_revision=2) AS ledger,
              (SELECT count(*)::int FROM public.gallery_navigation_command_receipt WHERE athlete_id=$1 AND target_album_id=$2 AND state='redacted') AS redacted,
              (SELECT count(*)::int FROM public.outbox WHERE athlete_id=$1 AND id=$3 AND topic='gallery.album_deleted') AS outbox`,
            [athlete, album.id, eventId],
          )
        ).rows[0],
    );
    expect(state).toEqual({ revision: 2, deleted: true, ledger: 1, redacted: 1, outbox: 1 });
    const receipt = (
      await owner.query(
        'SELECT outcome,deleted_revision AS revision FROM public.restore_gallery_album_replay_receipt WHERE event_id=$1',
        [eventId],
      )
    ).rows;
    expect(receipt).toEqual([{ outcome: 'deleted', revision: 2 }]);
    expect(await replayAlbum(athlete, album.id, eventId, at, 2)).toBe('already_applied');
    expect(await failure(() => replayAlbum(athlete, album.id, eventId, at, 3))).toMatchObject({
      message: 'RESTORE_GALLERY_ALBUM_EVENT_CONFLICT',
    });
    expect(await failure(() => replayAlbum(athlete, album.id, randomUUID(), at, 2))).toMatchObject({
      message: 'RESTORE_GALLERY_ALBUM_EVENT_CONFLICT',
    });
    expect(
      await failure(() =>
        owner.query('UPDATE public.restore_gallery_album_replay_receipt SET outcome=outcome'),
      ),
    ).not.toBeNull();
  });

  it('records a terminal ledger for an absent album so a later load cannot resurrect it', async () => {
    const athlete = await account();
    const album = randomUUID();
    const eventId = randomUUID();
    const at = await dbNow();
    expect(await replayAlbum(athlete, album, eventId, at, 4)).toBe('recorded_absent');
    expect(await replayAlbum(athlete, album, eventId, at, 4)).toBe('already_applied');
    expect(
      await failure(() =>
        ownerTenant(
          athlete,
          async (tx) => {
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
            await tx.query(
              `INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at)
               VALUES($1,$2,'부활',1,clock_timestamp(),clock_timestamp())`,
              [athlete, album],
            );
          },
          'exclusive',
        ),
      ),
    ).toMatchObject({ message: 'GALLERY_ALBUM_DELETION_TERMINAL' });
  });

  it('refuses a wrong pre-state, a foreign album, an erased or unknown tenant and a wrong caller', async () => {
    const athlete = await account();
    const foreign = await account();
    const album = await createAlbum(athlete);
    const at = await dbNow();
    expect(await failure(() => replayAlbum(athlete, album.id, randomUUID(), at, 5))).toMatchObject({
      message: 'RESTORE_GALLERY_ALBUM_STATE_CONFLICT',
    });
    expect(await failure(() => replayAlbum(foreign, album.id, randomUUID(), at, 2))).toMatchObject({
      message: 'RESTORE_GALLERY_ALBUM_FOREIGN_ALBUM',
    });
    expect(
      await failure(() => replayAlbum(randomUUID(), randomUUID(), randomUUID(), at, 2)),
    ).toMatchObject({ message: 'RESTORE_GALLERY_ALBUM_TENANT_UNKNOWN' });
    // app.athlete_id must name the replayed tenant.
    expect(
      await failure(() =>
        ownerTenant(
          foreign,
          (tx) =>
            tx.query('SELECT public.replay_gallery_album_deletion_exact_v1($1,$2,$3,$4,$5)', [
              athlete,
              album.id,
              randomUUID(),
              at,
              2,
            ]),
          'exclusive',
        ),
      ),
    ).toMatchObject({ message: 'RESTORE_GALLERY_ALBUM_INVALID_ENTRY' });
    // Owner-only: the runtime role cannot execute it.
    expect(
      await failure(() => replayAlbum(athlete, album.id, randomUUID(), at, 2, 'shared', runtime)),
    ).toMatchObject({ code: '42501' });
    expect(
      await failure(() =>
        runtime.query('SELECT 1 FROM public.restore_gallery_album_replay_receipt'),
      ),
    ).toMatchObject({ code: '42501' });
    const erased = await account();
    await ownerTenant(
      erased,
      (tx) => tx.query('INSERT INTO public.tenant_erasure(athlete_id) VALUES($1)', [erased]),
      'exclusive',
    );
    expect(
      await failure(() => replayAlbum(erased, randomUUID(), randomUUID(), at, 2)),
    ).toMatchObject({ message: 'RESTORE_GALLERY_ALBUM_TENANT_ERASED' });
  });
});
