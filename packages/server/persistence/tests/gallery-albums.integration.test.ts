import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  galleryAlbumDeleteResultV1Schema,
  galleryAlbumV1Schema,
} from '@workout/contracts/gallery-navigation-v2';
import { migrate } from '../src/migrate.js';
import {
  assertGalleryFunctionPinsV1In,
  assertGalleryTriggersV1In,
  galleryNavigationFunctionPinsV1,
  galleryNavigationRuntimeFunctionsV1,
  galleryNavigationTriggersV1,
  probeGalleryNavigationRuntimeV1In,
} from '../src/gallery-navigation-pins-v1.js';
import { readGalleryNavigationPageIn } from '../src/gallery-navigation-queries.js';
import { readGalleryAlbumPageIn } from '../src/gallery-album-queries.js';
import { setGalleryMediaNavigationIn } from '../src/gallery-album-commands.js';
import { readGalleryAccountExportV39In } from '../src/gallery-account-export-v39.js';
import { createGalleryExtensionErasureRepositoryCandidate } from '../src/gallery-erasure-repository-candidate.js';
import { createGalleryMediaExtensionRepository } from '../src/gallery-media.js';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  grantGalleryNavigationRuntimeForTest,
  grantProfile27Runtime,
  installProfile27,
} from './gallery-profile27-fixture.js';

// SQL143 (with 144/145/147/148) installed by the profile27 installer V11 and the V11 runtime
// grant (which includes the exact navigation runtime roster).
// This does not attest a profile27 cold catalog, restore authority or current source-proof
// readiness. All rows are synthetic.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `gallery_albums_${suffix}`;
const ownerRole = `gallery_albums_owner_${suffix}`;
const runtimeRole = `gallery_albums_app_${suffix}`;
const roles: string[] = [];
const admin = new Pool({ connectionString: adminUrl, max: 1 });
let created = false;
let owner: Pool | undefined;
let runtime: Pool | undefined;
let database: Database | undefined;
function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
const semanticCodes = new Set([
  'INVALID_GALLERY_ALBUM_COMMAND',
  'ALBUM_NOT_FOUND',
  'ALBUM_CONFLICT',
  'MEDIA_ACCESS_CONFLICT',
  'GALLERY_ALBUM_DETACH_LIMIT',
  'GALLERY_ALBUM_DELETION_TERMINAL',
  'IDEMPOTENCY_CONFLICT',
  'MEDIA_NOT_FOUND',
  'COURSE_NOT_FOUND',
  'GALLERY_ALBUM_GLOBAL_LOCK_REQUIRED',
  'GALLERY_ALBUM_OWNER_REQUIRED',
  'APP_CONSENT_REQUIRED',
  'ACCOUNT_ERASED',
  'RESTORE_PROCESSING_CLOSED',
  'RESTORE_PROCESSING_CONTROL_MISSING',
]);
const sqlStates = new Set([
  'P0001',
  '42501',
  '23502',
  '23503',
  '23505',
  '23514',
  '22P02',
  '42883',
  '57014',
  '40001',
  '40P01',
]);
function finite(error: unknown) {
  const value = z
    .object({
      name: z.string().optional(),
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .safeParse(error);
  const code = value.success ? value.data.code : undefined;
  const message = value.success ? value.data.message : undefined;
  return {
    errorClass:
      value.success && ['Error', 'AssertionError', 'ZodError'].includes(value.data.name ?? '')
        ? value.data.name
        : 'unknown',
    code: semanticCodes.has(message ?? '') ? message : 'unknown',
    sqlState: sqlStates.has(code ?? '') ? code : 'unknown',
  };
}
function caseIt(label: string, work: () => Promise<void>) {
  it(label, async () => {
    try {
      await work();
    } catch (error) {
      throw new Error(JSON.stringify(finite(error)));
    }
  });
}
function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function pool(kind: 'owner' | 'runtime') {
  const value = kind === 'owner' ? owner : runtime;
  if (!value) throw new Error('GALLERY_ALBUM_FIXTURE_NOT_READY');
  return value;
}
async function tenant<T>(
  kind: 'owner' | 'runtime',
  athlete: string,
  work: (tx: PoolClient) => Promise<T>,
  global = true,
) {
  const tx = await pool(kind).connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL statement_timeout='10000ms'");
    if (global) await tx.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [athlete]);
    if (kind === 'owner')
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
    const value = await work(tx);
    const commit = await tx.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('GALLERY_ALBUM_FIXTURE_COMMIT_FAILED');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}
const commands = {
  create: 'SELECT public.create_gallery_album_v1($1::jsonb,$2) AS result',
  rename: 'SELECT public.rename_gallery_album_v1($1::jsonb,$2) AS result',
  delete: 'SELECT public.delete_gallery_album_v1($1::jsonb,$2) AS result',
} as const;
async function command(
  athlete: string,
  kind: keyof typeof commands,
  body: unknown,
  key: string = randomUUID(),
) {
  return tenant('runtime', athlete, async (tx) => {
    const reply: unknown = (await tx.query(commands[kind], [JSON.stringify(body), key])).rows[0]?.[
      'result'
    ];
    return reply;
  });
}
async function create(athlete: string, title = '합성 앨범', key: string = randomUUID()) {
  return galleryAlbumV1Schema.parse(await command(athlete, 'create', { title }, key));
}
async function newAthlete() {
  const athlete = randomUUID();
  await tenant('owner', athlete, (tx) =>
    tx.query(
      "INSERT INTO public.consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)",
      [athlete],
    ),
  );
  return athlete;
}
async function failure(
  read: () => Promise<unknown>,
  expected: string,
  field: 'code' | 'sqlState' = 'code',
) {
  let observed: ReturnType<typeof finite> | undefined;
  try {
    await read();
  } catch (error) {
    observed = finite(error);
  }
  expect(observed?.[field]).toBe(expected);
}
async function counts(athlete: string) {
  return tenant('owner', athlete, async (tx) =>
    z
      .strictObject({
        albums: z.number(),
        receipts: z.number(),
        events: z.number(),
        ledgers: z.number(),
        links: z.number(),
        cleanup: z.number(),
      })
      .parse(
        (
          await tx.query(
            `SELECT
   (SELECT count(*)::int FROM public.gallery_album WHERE athlete_id=$1) albums,
   (SELECT count(*)::int FROM public.gallery_navigation_command_receipt WHERE athlete_id=$1) receipts,
   (SELECT count(*)::int FROM public.outbox WHERE athlete_id=$1 AND topic LIKE 'gallery.album_%') events,
   (SELECT count(*)::int FROM public.gallery_album_deletion WHERE athlete_id=$1) ledgers,
   (SELECT count(*)::int FROM public.gallery_media_album_membership WHERE athlete_id=$1) links,
   (SELECT count(*)::int FROM public.resource_object_cleanup WHERE storage_ref LIKE $2) cleanup`,
            [athlete, `synthetic-gallery-${athlete}-%`],
          )
        ).rows[0],
      ),
  );
}
async function seedMedia(athlete: string, albumId: string, revisions: readonly number[]) {
  return tenant('owner', athlete, async (tx) => {
    const ids: string[] = [];
    for (const revision of revisions) {
      const id = randomUUID();
      ids.push(id);
      await tx.query(
        `INSERT INTO public.gallery_media_item
       (athlete_id,id,media_kind,visibility,include_for_coach,album,caption,activity_id,captured_at,captured_local_date,
        storage_ref,original_filename,media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
       VALUES($1,$2,'image','private',false,NULL,NULL,NULL,NULL,NULL,$3,'synthetic.png','image/png',1,$4,$5,
        '2026-10-09T00:00:00.000001Z','2026-10-09T00:00:00.000001Z')`,
        [athlete, id, `synthetic-gallery-${athlete}-${id}`, 'a'.repeat(64), revision],
      );
      await tx.query(
        'INSERT INTO public.gallery_media_album_membership(athlete_id,media_item_id,album_id) VALUES($1,$2,$3)',
        [athlete, id, albumId],
      );
    }
    return ids;
  });
}
async function mediaHeads(athlete: string) {
  return tenant('owner', athlete, async (tx) =>
    z
      .array(
        z.strictObject({
          id: z.uuid(),
          access_revision: z.number(),
          deleted: z.boolean(),
          byte_size: z.string(),
          content_hash: z.string(),
        }),
      )
      .parse(
        (
          await tx.query(
            `SELECT id::text,access_revision,deleted_at IS NOT NULL AS deleted,size_bytes::text AS byte_size,content_hash FROM public.gallery_media_item WHERE athlete_id=$1 ORDER BY id`,
            [athlete],
          )
        ).rows,
      ),
  );
}

function transaction(tx: PoolClient, athleteId: string): Transaction {
  return { athleteId, query: (sql, values) => tx.query(sql, values) };
}
const day = (value: string) => value;
async function seedCourse(athlete: string, revisions = 1) {
  const courseId = randomUUID();
  const ids = Array.from({ length: revisions }, () => randomUUID());
  await tenant('owner', athlete, async (tx) => {
    await tx.query(
      `INSERT INTO public.course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,created_at,updated_at)
       VALUES($1,$2,'합성 코스','private','available',$3,$4,statement_timestamp(),statement_timestamp())`,
      [athlete, courseId, revisions, ids.at(-1)],
    );
    for (const [index, revisionId] of ids.entries())
      await tx.query(
        `INSERT INTO public.course_revision(athlete_id,course_id,course_revision,revision_id,name,geometry,waypoints,
          generation,edit,vertex_count,distance_meters,content_digest,created_at)
         VALUES($1,$2,$3,$4,'합성 코스','{"type":"LineString","coordinates":[[0,0],[0.001,0]]}','[]','{}','{}',2,111,$5,statement_timestamp())`,
        [athlete, courseId, index + 1, revisionId, 'b'.repeat(64)],
      );
  });
  const revisionsOut = ids.map((revisionId, index) => ({ courseRevision: index + 1, revisionId }));
  const first = revisionsOut[0];
  if (!first) throw new Error('GALLERY_ALBUM_FIXTURE_COURSE');
  return { courseId, revisions: revisionsOut, first: { courseId, ...first } };
}
async function seedPlainMedia(
  athlete: string,
  entries: readonly {
    createdAt: string;
    kind?: 'image' | 'video';
    localDate?: string | null;
    capturedAt?: string | null;
    legacyAlbum?: string | null;
  }[],
) {
  return tenant('owner', athlete, async (tx) => {
    const ids: string[] = [];
    for (const entry of entries) {
      const id = randomUUID();
      ids.push(id);
      const kind = entry.kind ?? 'image';
      await tx.query(
        `INSERT INTO public.gallery_media_item
         (athlete_id,id,media_kind,album,captured_at,captured_local_date,storage_ref,original_filename,media_type,
          size_bytes,content_hash,access_revision,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9,1,$10,1,$11,$11)`,
        [
          athlete,
          id,
          kind,
          entry.legacyAlbum ?? null,
          entry.capturedAt ?? null,
          entry.localDate ?? null,
          `synthetic-gallery-${athlete}-${id}`,
          kind === 'image' ? 'synthetic.png' : 'synthetic.mp4',
          kind === 'image' ? 'image/png' : 'video/mp4',
          'c'.repeat(64),
          entry.createdAt,
        ],
      );
    }
    return ids;
  });
}
function navigationQuery(
  filters: Partial<{
    album: { mode: 'all' } | { mode: 'unassigned' } | { mode: 'album'; albumId: string };
    mediaKind: 'image' | 'video' | null;
    activityId: string | null;
    courseLink: { courseId: string; courseRevision: number; revisionId: string } | null;
    capturedDay:
      | { mode: 'all' }
      | { mode: 'unknown' }
      | { mode: 'stored_local_range'; from: string; toInclusive: string };
  }>,
  limit = 100,
) {
  return {
    filters: {
      album: { mode: 'all' },
      mediaKind: null,
      activityId: null,
      courseLink: null,
      capturedDay: { mode: 'all' },
      ...filters,
    },
    limit,
    sort: 'created_desc_id_asc',
    cursor: null,
  } as const;
}
async function navigate(athlete: string, query: unknown) {
  return tenant('runtime', athlete, (tx) =>
    readGalleryNavigationPageIn(transaction(tx, athlete), query),
  );
}
async function setNavigation(athlete: string, body: unknown, key: string = randomUUID()) {
  return tenant('runtime', athlete, (tx) =>
    setGalleryMediaNavigationIn(transaction(tx, athlete), body, key),
  );
}
function revisionOf(course: { revisions: { revisionId: string }[] }, index: number) {
  const value = course.revisions[index];
  if (!value) throw new Error('GALLERY_ALBUM_FIXTURE_COURSE');
  return value.revisionId;
}
function db() {
  if (!database) throw new Error('GALLERY_ALBUM_FIXTURE_NOT_READY');
  return database;
}

beforeAll(async () => {
  try {
    for (const role of [ownerRole, runtimeRole]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      roles.push(role);
    }
    await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
    created = true;
    await migrate(connection(ownerRole), 107);
    await installProfile27(connection(ownerRole));
    await grantProfile27Runtime(connection(ownerRole), runtimeRole);
    await grantGalleryNavigationRuntimeForTest(connection(ownerRole), runtimeRole);
    owner = new Pool({ connectionString: connection(ownerRole), max: 1 });
    runtime = new Pool({ connectionString: connection(runtimeRole), max: 4 });
    database = createDatabase({ connectionString: connection(runtimeRole), max: 2 });
  } catch (error) {
    throw new Error(JSON.stringify({ stage: 'setup', ...finite(error) }));
  }
}, 180000);
afterAll(async () => {
  const failures: ReturnType<typeof finite>[] = [];
  async function clean(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      failures.push(finite(error));
    }
  }
  await clean(async () => database?.close());
  await clean(async () => runtime?.end());
  await clean(async () => owner?.end());
  if (created) await clean(async () => dropIsolatedDatabase(admin, name));
  for (const role of roles.reverse()) await clean(async () => admin.query(`DROP ROLE "${role}"`));
  await clean(async () => admin.end());
  if (failures.length) throw new Error(JSON.stringify({ stage: 'cleanup', failures }));
}, 30000);

describe('Gallery navigation SQL143 extension on owned PostgreSQL', () => {
  caseIt(
    'uses a plain FORCE-RLS owner and denies runtime DML, private helpers and missing global fence',
    async () => {
      const observed = await pool('owner').query(`SELECT NOT rolsuper AND NOT rolbypassrls AS plain,
      (SELECT bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid IN
       ('public.gallery_album'::regclass,'public.gallery_media_album_membership'::regclass,
        'public.gallery_navigation_command_receipt'::regclass,'public.gallery_album_deletion'::regclass)) AS forced
      FROM pg_roles WHERE rolname=current_user`);
      expect(observed.rows[0]).toEqual({ plain: true, forced: true });
      const actor = await pool('runtime').query(
        `SELECT current_user<>$1 AS nonowner,NOT rolsuper AND NOT rolbypassrls AS plain FROM pg_roles WHERE rolname=current_user`,
        [ownerRole],
      );
      expect(actor.rows[0]).toEqual({ nonowner: true, plain: true });
      const athlete = await newAthlete();
      await failure(
        () =>
          tenant(
            'runtime',
            athlete,
            (tx) =>
              tx.query('SELECT public.create_gallery_album_v1($1::jsonb,$2)', [
                JSON.stringify({ title: '합성' }),
                'missing-global-key',
              ]),
            false,
          ),
        'GALLERY_ALBUM_GLOBAL_LOCK_REQUIRED',
      );
      await failure(
        () =>
          tenant('runtime', athlete, (tx) =>
            tx.query('SELECT public.redact_gallery_album_receipts_v1($1)', [randomUUID()]),
          ),
        '42501',
        'sqlState',
      );
      await failure(
        () =>
          tenant('runtime', athlete, (tx) =>
            tx.query('DELETE FROM public.gallery_album WHERE athlete_id=$1', [athlete]),
          ),
        '42501',
        'sqlState',
      );
    },
  );
  caseIt(
    'returns the original committed DTO after a later rename and emits no duplicate receipt or event',
    async () => {
      const athlete = await newAthlete(),
        key = randomUUID();
      const first = await create(athlete, '첫 합성 앨범', key);
      expect(first.revision).toBe(1);
      expect(first.createdAt).toMatch(/\.\d{6}Z$/);
      const renamed = galleryAlbumV1Schema.parse(
        await command(athlete, 'rename', {
          albumId: first.id,
          expectedRevision: 1,
          title: '둘째 합성 앨범',
        }),
      );
      expect(renamed.revision).toBe(2);
      const replay = await create(athlete, '첫 합성 앨범', key);
      expect(hash(replay)).toBe(hash(first));
      expect(replay.revision).toBe(1);
      expect(await counts(athlete)).toMatchObject({
        albums: 1,
        receipts: 2,
        events: 2,
        ledgers: 0,
      });
      await failure(() => create(athlete, '다른 payload', key), 'IDEMPOTENCY_CONFLICT');
      expect(await counts(athlete)).toMatchObject({ receipts: 2, events: 2 });
    },
  );
  caseIt(
    'rejects malformed command fields, key and stale revisions before committing effects',
    async () => {
      const athlete = await newAthlete();
      for (const body of [
        { title: '합성', extra: true },
        { title: '' },
        { title: null },
        { title: '\u0001' },
        { title: 'x'.repeat(101) },
      ])
        await failure(() => command(athlete, 'create', body), 'INVALID_GALLERY_ALBUM_COMMAND');
      await failure(
        () => command(athlete, 'create', { title: '합성' }, 'short'),
        'INVALID_GALLERY_ALBUM_COMMAND',
      );
      expect(await counts(athlete)).toMatchObject({ albums: 0, receipts: 0, events: 0 });
      const album = await create(athlete);
      await failure(
        () =>
          command(athlete, 'rename', { albumId: album.id, expectedRevision: 2, title: 'stale' }),
        'ALBUM_CONFLICT',
      );
      expect(await counts(athlete)).toMatchObject({ albums: 1, receipts: 1, events: 1 });
    },
  );
  caseIt('isolates foreign albums in read queries and mutation commands', async () => {
    const athlete = await newAthlete(),
      foreign = await newAthlete();
    const album = await create(athlete);
    const rows = await tenant('runtime', foreign, (tx) =>
      tx.query('SELECT id FROM public.gallery_album WHERE id=$1', [album.id]),
    );
    expect(rows.rowCount).toBe(0);
    await failure(
      () =>
        command(foreign, 'rename', { albumId: album.id, expectedRevision: 1, title: 'foreign' }),
      'ALBUM_NOT_FOUND',
    );
    await failure(
      () => command(foreign, 'delete', { albumId: album.id, expectedRevision: 1 }),
      'ALBUM_NOT_FOUND',
    );
    expect(await counts(foreign)).toMatchObject({ albums: 0, receipts: 0, events: 0 });
  });
  caseIt('allows independent album authoring with false and missing app consent', async () => {
    for (const state of ['false', 'missing'] as const) {
      const athlete = randomUUID();
      if (state === 'false') {
        await tenant('owner', athlete, (tx) =>
          tx.query(
            "INSERT INTO public.consent(athlete_id,kind,granted,revision) VALUES($1,'app',false,1)",
            [athlete],
          ),
        );
      }
      const album = await create(athlete, '독립 합성 앨범');
      const renamed = galleryAlbumV1Schema.parse(
        await command(athlete, 'rename', {
          albumId: album.id,
          expectedRevision: 1,
          title: '독립 합성 이름 변경',
        }),
      );
      expect(renamed.revision).toBe(2);
      expect(renamed.title).toBe('독립 합성 이름 변경');
      const consent = await tenant('owner', athlete, (tx) =>
        tx.query("SELECT granted,revision FROM public.consent WHERE athlete_id=$1 AND kind='app'", [
          athlete,
        ]),
      );
      expect(consent.rows).toEqual(state === 'false' ? [{ granted: false, revision: 1 }] : []);
      expect(await counts(athlete)).toMatchObject({
        albums: 1,
        receipts: 2,
        events: 2,
        ledgers: 0,
      });
    }
  });
  caseIt(
    'allows successful replay and deletion after app withdrawal without deleting media originals',
    async () => {
      const athlete = await newAthlete(),
        key = randomUUID();
      const album = await create(athlete, '철회 전 합성 앨범', key);
      await seedMedia(athlete, album.id, [1, 1]);
      const before = await mediaHeads(athlete);
      await tenant('owner', athlete, (tx) =>
        tx.query(
          "UPDATE public.consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='app'",
          [athlete],
        ),
      );
      expect(hash(await create(athlete, '철회 전 합성 앨범', key))).toBe(hash(album));
      // JSONB replay key order differs from the strict-parsed first reply; both
      // are compared after the same public schema parse.
      const deleteKey = randomUUID(),
        body = { albumId: album.id, expectedRevision: 1 };
      const deleted = galleryAlbumDeleteResultV1Schema.parse(
        await command(athlete, 'delete', body, deleteKey),
      );
      expect(deleted).toMatchObject({ revision: 2, detachedMediaCount: 2, status: 'deleted' });
      expect(
        hash(
          galleryAlbumDeleteResultV1Schema.parse(await command(athlete, 'delete', body, deleteKey)),
        ),
      ).toBe(hash(deleted));
      const after = await mediaHeads(athlete);
      expect(after.map((v) => v.access_revision)).toEqual([2, 2]);
      expect(
        hash(
          after.map(({ access_revision: omitted, ...rest }) => ({ ...rest, prior: omitted - 1 })),
        ),
      ).toBe(hash(before.map(({ access_revision: prior, ...rest }) => ({ ...rest, prior }))));
      expect(await counts(athlete)).toMatchObject({
        ledgers: 1,
        links: 0,
        cleanup: 0,
        receipts: 2,
        events: 2,
      });
      const ledger = await tenant('owner', athlete, (tx) =>
        tx.query(
          `SELECT deleted_revision,to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
         EXISTS(SELECT 1 FROM public.gallery_album a WHERE a.athlete_id=$1 AND a.id=$2
          AND a.revision=d.deleted_revision AND a.deleted_at=d.deleted_at) AS matches_head
         FROM public.gallery_album_deletion d WHERE athlete_id=$1 AND album_id=$2`,
          [athlete, album.id],
        ),
      );
      expect(ledger.rows).toHaveLength(1);
      expect(ledger.rows[0]).toMatchObject({
        deleted_revision: deleted.revision,
        matches_head: true,
      });
      expect(ledger.rows[0]?.['deleted_at']).toMatch(/\.\d{6}Z$/);
      const receipt = await tenant('owner', athlete, (tx) =>
        tx.query(
          "SELECT state,result IS NULL AS redacted FROM public.gallery_navigation_command_receipt WHERE athlete_id=$1 AND operation='create_album'",
          [athlete],
        ),
      );
      expect(receipt.rows[0]).toEqual({ state: 'redacted', redacted: true });
      await failure(() => create(athlete, '철회 전 합성 앨범', key), 'ALBUM_NOT_FOUND');
    },
  );
  caseIt(
    'serializes real concurrent CAS commands on two independent PostgreSQL connections',
    async () => {
      const athlete = await newAthlete(),
        album = await create(athlete);
      const clients = await Promise.all([pool('runtime').connect(), pool('runtime').connect()]);
      try {
        const pids = await Promise.all(
          clients.map((tx) => tx.query('SELECT pg_backend_pid() AS pid')),
        );
        expect(pids[0]?.rows[0]?.['pid'] !== pids[1]?.rows[0]?.['pid']).toBe(true);
        const work = clients.map(async (tx, index) => {
          await tx.query('BEGIN');
          try {
            await tx.query("SET LOCAL statement_timeout='10000ms'");
            await tx.query(
              "SELECT pg_advisory_xact_lock_shared(77210,1),set_config('app.athlete_id',$1,true)",
              [athlete],
            );
            const reply: unknown = (
              await tx.query(commands.rename, [
                JSON.stringify({ albumId: album.id, expectedRevision: 1, title: `합성 ${index}` }),
                randomUUID(),
              ])
            ).rows[0]?.['result'];
            await tx.query('COMMIT');
            return galleryAlbumV1Schema.parse(reply).revision;
          } catch (error) {
            await tx.query('ROLLBACK');
            throw error;
          }
        });
        const outcomes = await Promise.allSettled(work);
        expect(outcomes.filter((v) => v.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.flatMap((v) => (v.status === 'fulfilled' ? [v.value] : []))).toEqual([2]);
        expect(
          outcomes.flatMap((v) => (v.status === 'rejected' ? [finite(v.reason).code] : [])),
        ).toEqual(['ALBUM_CONFLICT']);
        expect(await counts(athlete)).toMatchObject({ receipts: 2, events: 2 });
      } finally {
        clients.forEach((tx) => tx.release());
      }
    },
  );
  caseIt(
    'deduplicates simultaneous identical creates without a second ID or outbox row',
    async () => {
      const athlete = await newAthlete(),
        key = randomUUID();
      const replies = await Promise.all([
        create(athlete, '同一 합성', key),
        create(athlete, '同一 합성', key),
      ]);
      expect(hash(replies[0])).toBe(hash(replies[1]));
      expect(await counts(athlete)).toMatchObject({ albums: 1, receipts: 1, events: 1 });
    },
  );
  caseIt(
    'rolls back every detach and revision when one linked media head is exhausted',
    async () => {
      const athlete = await newAthlete(),
        album = await create(athlete);
      await seedMedia(athlete, album.id, [1, 2147483646]);
      const before = await mediaHeads(athlete),
        priorCounts = await counts(athlete);
      await failure(
        () => command(athlete, 'delete', { albumId: album.id, expectedRevision: 1 }),
        'MEDIA_ACCESS_CONFLICT',
      );
      expect(hash(await mediaHeads(athlete))).toBe(hash(before));
      expect(await counts(athlete)).toEqual(priorCounts);
      const current = await tenant('runtime', athlete, (tx) =>
        tx.query(
          'SELECT revision,deleted_at IS NOT NULL AS deleted FROM public.gallery_album WHERE id=$1',
          [album.id],
        ),
      );
      expect(current.rows[0]).toEqual({ revision: 1, deleted: false });
    },
  );
  caseIt('rolls back rename and delete when the album revision is exhausted', async () => {
    const athlete = await newAthlete(),
      album = { id: randomUUID() };
    await tenant('owner', athlete, (tx) =>
      tx.query(
        `INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at)
       VALUES($1,$2,'합성 상한',2147483646,statement_timestamp(),statement_timestamp())`,
        [athlete, album.id],
      ),
    );
    const before = await counts(athlete);
    await failure(
      () =>
        command(athlete, 'rename', {
          albumId: album.id,
          expectedRevision: 2147483646,
          title: '합성 변경',
        }),
      'ALBUM_CONFLICT',
    );
    await failure(
      () =>
        command(athlete, 'delete', {
          albumId: album.id,
          expectedRevision: 2147483646,
        }),
      'ALBUM_CONFLICT',
    );
    expect(await counts(athlete)).toEqual(before);
    const head = await tenant('runtime', athlete, (tx) =>
      tx.query(
        'SELECT revision,deleted_at IS NOT NULL AS deleted FROM public.gallery_album WHERE id=$1',
        [album.id],
      ),
    );
    expect(head.rows[0]).toEqual({ revision: 2147483646, deleted: false });
  });
  caseIt(
    'enforces the complete detach limit instead of partially deleting an oversized album',
    async () => {
      const athlete = await newAthlete(),
        album = await create(athlete);
      await tenant('owner', athlete, async (tx) => {
        await tx.query(
          `INSERT INTO public.gallery_media_item(athlete_id,id,media_kind,storage_ref,original_filename,media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
       SELECT $1,gen_random_uuid(),'image',$2||g::text,'synthetic.png','image/png',1,$3,1,statement_timestamp(),statement_timestamp() FROM generate_series(1,1001) g`,
          [athlete, `synthetic-gallery-${athlete}-`, 'a'.repeat(64)],
        );
        await tx.query(
          'INSERT INTO public.gallery_media_album_membership SELECT athlete_id,id,$2 FROM public.gallery_media_item WHERE athlete_id=$1',
          [athlete, album.id],
        );
      });
      const prior = await counts(athlete);
      await failure(
        () => command(athlete, 'delete', { albumId: album.id, expectedRevision: 1 }),
        'GALLERY_ALBUM_DETACH_LIMIT',
      );
      expect(await counts(athlete)).toEqual(prior);
      const heads = await mediaHeads(athlete);
      expect(heads).toHaveLength(1001);
      expect(heads.every((v) => v.access_revision === 1)).toBe(true);
    },
  );
  caseIt(
    'preserves known microsecond creation facts and rejects terminal album reinsertion',
    async () => {
      const athlete = await newAthlete(),
        id = randomUUID();
      await tenant('owner', athlete, (tx) =>
        tx.query(
          `INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at)
      VALUES($1,$2,'合成',1,'2026-10-09T00:00:00.000001Z','2026-10-09T00:00:00.000002Z')`,
          [athlete, id],
        ),
      );
      const reply = galleryAlbumV1Schema.parse(
        await command(athlete, 'rename', { albumId: id, expectedRevision: 1, title: '합성 변경' }),
      );
      expect(reply.createdAt).toBe('2026-10-09T00:00:00.000001Z');
      expect(reply.updatedAt).toMatch(/\.\d{6}Z$/);
      await command(athlete, 'delete', { albumId: id, expectedRevision: 2 });
      await failure(
        () =>
          tenant('owner', athlete, (tx) =>
            tx.query(
              `INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at) VALUES($1,$2,'合成',1,statement_timestamp(),statement_timestamp())`,
              [athlete, id],
            ),
          ),
        'GALLERY_ALBUM_DELETION_TERMINAL',
      );
    },
  );
  caseIt('rolls back album creation when either receipt or outbox commit fails', async () => {
    const athlete = await newAthlete();
    // Own-fixture failure injection, no production constraint or trigger disabled.
    await pool('owner').query(
      "ALTER TABLE public.gallery_navigation_command_receipt ADD CONSTRAINT gallery_albums_fixture_receipt_failure CHECK(idempotency_key<>'receipt-failure-key')",
    );
    try {
      await failure(() => create(athlete, '합성 실패', 'receipt-failure-key'), '23514', 'sqlState');
    } finally {
      await pool('owner').query(
        'ALTER TABLE public.gallery_navigation_command_receipt DROP CONSTRAINT gallery_albums_fixture_receipt_failure',
      );
    }
    expect(await counts(athlete)).toMatchObject({ albums: 0, receipts: 0, events: 0 });
    const key = randomUUID();
    await tenant('owner', athlete, (tx) =>
      tx.query(
        "INSERT INTO public.outbox(athlete_id,id,idempotency_key,topic,payload) VALUES($1,gen_random_uuid(),$2,'gallery.album_created','{}')",
        [athlete, `gallery.nav:create_album:${key}`],
      ),
    );
    await failure(() => create(athlete, '합성 실패', key), '23505', 'sqlState');
    expect(await counts(athlete)).toMatchObject({ albums: 0, receipts: 0, events: 1 });
  });

  caseIt('matches the pinned SQL143 roster and grants no receipt or DML access', async () => {
    await tenant('owner', randomUUID(), async (tx) => {
      await assertGalleryFunctionPinsV1In(
        tx,
        galleryNavigationFunctionPinsV1,
        galleryNavigationRuntimeFunctionsV1,
      );
      await assertGalleryTriggersV1In(tx, galleryNavigationTriggersV1);
    });
    const athlete = await newAthlete();
    expect(await tenant('runtime', athlete, (tx) => probeGalleryNavigationRuntimeV1In(tx))).toBe(
      'available',
    );
    await failure(
      () =>
        tenant('runtime', athlete, (tx) =>
          tx.query('SELECT count(*) FROM public.gallery_navigation_command_receipt'),
        ),
      '42501',
      'sqlState',
    );
    await failure(
      () =>
        tenant('runtime', athlete, (tx) =>
          tx.query('SELECT count(*) FROM public.restore_gallery_album_replay_receipt'),
        ),
      '42501',
      'sqlState',
    );
    await failure(
      () =>
        tenant('runtime', athlete, (tx) =>
          tx.query(
            'INSERT INTO public.gallery_media_course_association VALUES($1,gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid())',
            [athlete],
          ),
        ),
      '42501',
      'sqlState',
    );
  });
  caseIt(
    'sets and clears one album membership and exact course link under media CAS with original replay',
    async () => {
      const athlete = await newAthlete(),
        foreign = await newAthlete();
      const [mediaId] = await seedPlainMedia(athlete, [
        { createdAt: '2026-10-09T00:00:00.000001Z', legacyAlbum: '기존 문자열 앨범' },
      ]);
      if (!mediaId) throw new Error('seed');
      const album = await create(athlete, '합성 묶음');
      const foreignAlbum = await create(foreign, '남의 앨범');
      const course = await seedCourse(athlete, 2);
      const foreignCourse = await seedCourse(foreign);
      const link = course.first;
      const key = randomUUID();
      const body = {
        mediaItemId: mediaId,
        expectedAccessRevision: 1,
        albumMembership: { albumId: album.id },
        courseLink: link,
      };
      const first = await setNavigation(athlete, body, key);
      expect(first.item.accessRevision).toBe(2);
      expect(first.item.album).toBe('기존 문자열 앨범');
      expect(first.albumMembership).toEqual({ albumId: album.id });
      // An older saved revision stays the saved revision; no newer head is chosen.
      expect(first.courseLink).toEqual(link);
      expect(first.courseAvailability).toEqual({ state: 'available' });
      expect(first.item.visibility).toBe('private');
      await failure(() => setNavigation(athlete, body), 'MEDIA_ACCESS_CONFLICT');
      const cleared = await setNavigation(athlete, {
        ...body,
        expectedAccessRevision: 2,
        albumMembership: null,
        courseLink: null,
      });
      expect(cleared).toMatchObject({
        albumMembership: null,
        courseLink: null,
        courseAvailability: null,
      });
      expect(cleared.item.accessRevision).toBe(3);
      expect(hash(await setNavigation(athlete, body, key))).toBe(hash(first));
      await failure(
        () => setNavigation(athlete, { ...body, expectedAccessRevision: 3 }, key),
        'IDEMPOTENCY_CONFLICT',
      );
      await failure(
        () =>
          setNavigation(athlete, {
            ...body,
            expectedAccessRevision: 3,
            albumMembership: { albumId: foreignAlbum.id },
          }),
        'ALBUM_NOT_FOUND',
      );
      await failure(
        () =>
          setNavigation(athlete, {
            ...body,
            expectedAccessRevision: 3,
            courseLink: foreignCourse.first,
          }),
        'COURSE_NOT_FOUND',
      );
      await failure(
        () =>
          setNavigation(athlete, {
            ...body,
            expectedAccessRevision: 3,
            courseLink: { ...link, revisionId: revisionOf(course, 1) },
          }),
        'COURSE_NOT_FOUND',
      );
      await failure(
        () => setNavigation(foreign, { ...body, expectedAccessRevision: 3 }),
        'MEDIA_NOT_FOUND',
      );
      const heads = await tenant('owner', athlete, (tx) =>
        tx.query(
          `SELECT access_revision,album,(SELECT count(*)::int FROM public.gallery_media_album_membership WHERE athlete_id=$1) links,
           (SELECT count(*)::int FROM public.gallery_media_course_association WHERE athlete_id=$1) courses,
           (SELECT count(*)::int FROM public.outbox WHERE athlete_id=$1 AND topic='gallery.media_navigation_updated') events
           FROM public.gallery_media_item WHERE athlete_id=$1`,
          [athlete],
        ),
      );
      expect(heads.rows).toEqual([
        { access_revision: 3, album: '기존 문자열 앨범', links: 0, courses: 0, events: 2 },
      ]);
    },
  );
  caseIt(
    'preserves an unchanged saved course tuple after reclamation and reports it unavailable',
    async () => {
      const athlete = await newAthlete();
      const [mediaId] = await seedPlainMedia(athlete, [
        { createdAt: '2026-10-09T00:00:00.000001Z' },
      ]);
      if (!mediaId) throw new Error('seed');
      const course = await seedCourse(athlete);
      const link = course.first;
      await setNavigation(athlete, {
        mediaItemId: mediaId,
        expectedAccessRevision: 1,
        albumMembership: null,
        courseLink: link,
      });
      await tenant('owner', athlete, (tx) =>
        tx.query(
          `UPDATE public.course SET status='unavailable',head_revision=NULL,revision_id=NULL,
           unavailable_reason='source_activity_deleted',reclaimed_at=clock_timestamp(),updated_at=clock_timestamp()
           WHERE athlete_id=$1 AND course_id=$2`,
          [athlete, course.courseId],
        ),
      );
      const page = await navigate(athlete, navigationQuery({ courseLink: link }));
      expect(page.items.map((v) => [v.item.id, v.courseLink, v.courseAvailability])).toEqual([
        [mediaId, link, { state: 'unavailable' }],
      ]);
      const album = await create(athlete);
      const kept = await setNavigation(athlete, {
        mediaItemId: mediaId,
        expectedAccessRevision: 2,
        albumMembership: { albumId: album.id },
        courseLink: link,
      });
      expect(kept).toMatchObject({
        courseLink: link,
        courseAvailability: { state: 'unavailable' },
      });
      const replacement = await seedCourse(athlete);
      await failure(
        () =>
          setNavigation(athlete, {
            mediaItemId: mediaId,
            expectedAccessRevision: 3,
            albumMembership: null,
            courseLink: { ...link, revisionId: revisionOf(replacement, 0) },
          }),
        'COURSE_NOT_FOUND',
      );
    },
  );
  caseIt(
    'pages owned navigation by stored local date, album, course and kind with microsecond keyset',
    async () => {
      const athlete = await newAthlete(),
        foreign = await newAthlete();
      const tie = '2026-10-09T00:00:00.000005Z';
      const ids = await seedPlainMedia(athlete, [
        // Stored local date is authoritative; the UTC instant falls on the previous UTC day.
        { createdAt: tie, localDate: '2026-01-01', capturedAt: '2025-12-31T16:00:00.000000Z' },
        { createdAt: tie, localDate: null, kind: 'video' },
        { createdAt: '2026-10-09T00:00:00.000004Z', localDate: '2026-01-02' },
        {
          createdAt: '2026-10-09T00:00:00.000006Z',
          localDate: '2025-12-31',
          legacyAlbum: '문자열',
        },
      ]);
      await seedPlainMedia(foreign, [{ createdAt: tie, localDate: '2026-01-01' }]);
      const [a, b, c, d] = ids as [string, string, string, string];
      const tied = [a, b].sort();
      const expectedOrder = [d, ...tied, c];
      const album = await create(athlete);
      const course = await seedCourse(athlete);
      const link = course.first;
      await setNavigation(athlete, {
        mediaItemId: c,
        expectedAccessRevision: 1,
        albumMembership: { albumId: album.id },
        courseLink: link,
      });
      const seen: string[] = [];
      let query: unknown = navigationQuery({}, 2);
      for (let page = 0; page < 3; page++) {
        const result = await navigate(athlete, query);
        seen.push(...result.items.map((v) => v.item.id));
        if (!result.nextCursor) break;
        expect(result.items).toHaveLength(2);
        query = { ...navigationQuery({}, 2), cursor: result.nextCursor };
      }
      expect(seen).toEqual(expectedOrder);
      const ids0 = async (filters: Parameters<typeof navigationQuery>[0]) =>
        (await navigate(athlete, navigationQuery(filters))).items.map((v) => v.item.id);
      expect(await ids0({ capturedDay: { mode: 'unknown' } })).toEqual([b]);
      expect(
        await ids0({
          capturedDay: {
            mode: 'stored_local_range',
            from: day('2026-01-01'),
            toInclusive: day('2026-01-01'),
          },
        }),
      ).toEqual([a]);
      expect(
        await ids0({
          capturedDay: {
            mode: 'stored_local_range',
            from: '2025-12-31',
            toInclusive: '2026-01-02',
          },
        }),
      ).toEqual([d, a, c]);
      expect(await ids0({ album: { mode: 'album', albumId: album.id } })).toEqual([c]);
      expect(await ids0({ album: { mode: 'unassigned' } })).toEqual([d, ...tied]);
      expect(await ids0({ courseLink: link })).toEqual([c]);
      expect(await ids0({ mediaKind: 'video' })).toEqual([b]);
      const legacy = await navigate(athlete, navigationQuery({}));
      expect(legacy.items.find((v) => v.item.id === d)?.albumMembership).toBeNull();
      expect(legacy.items.find((v) => v.item.id === d)?.item.album).toBe('문자열');
      expect(legacy.items.find((v) => v.item.id === b)?.capturedDay).toEqual({ state: 'unknown' });
      expect((await navigate(foreign, navigationQuery({ courseLink: link }))).items).toEqual([]);
      const albums = await tenant('runtime', athlete, (tx) =>
        readGalleryAlbumPageIn(transaction(tx, athlete), {
          limit: 1,
          sort: 'created_desc_id_asc',
          cursor: null,
        }),
      );
      expect(albums.items.map((v) => v.id)).toEqual([album.id]);
      expect(
        (
          await tenant('runtime', foreign, (tx) =>
            readGalleryAlbumPageIn(transaction(tx, foreign), {
              limit: 100,
              sort: 'created_desc_id_asc',
              cursor: null,
            }),
          )
        ).items,
      ).toEqual([]);
    },
  );
  caseIt(
    'removes relations and redacts membership receipts on extension media deletion',
    async () => {
      const athlete = await newAthlete();
      const [mediaId] = await seedPlainMedia(athlete, [
        { createdAt: '2026-10-09T00:00:00.000001Z' },
      ]);
      if (!mediaId) throw new Error('seed');
      const album = await create(athlete);
      const course = await seedCourse(athlete);
      const key = randomUUID();
      const body = {
        mediaItemId: mediaId,
        expectedAccessRevision: 1,
        albumMembership: { albumId: album.id },
        courseLink: course.first,
      };
      await setNavigation(athlete, body, key);
      const deleted = await createGalleryMediaExtensionRepository(db()).softDelete(
        athlete,
        mediaId,
        {
          expectedAccessRevision: 2,
          idempotencyKey: `synthetic-delete-${randomUUID()}`,
        },
      );
      expect(deleted).toMatchObject({ status: 'deleted', accessRevision: 3 });
      const rows = await tenant('owner', athlete, (tx) =>
        tx.query(
          `SELECT (SELECT count(*)::int FROM public.gallery_media_album_membership WHERE athlete_id=$1) links,
         (SELECT count(*)::int FROM public.gallery_media_course_association WHERE athlete_id=$1) courses,
         (SELECT jsonb_agg(jsonb_build_object('state',state,'result',result IS NULL)) FROM public.gallery_navigation_command_receipt
          WHERE athlete_id=$1 AND operation='set_media_navigation') receipts`,
          [athlete],
        ),
      );
      expect(rows.rows[0]).toEqual({
        links: 0,
        courses: 0,
        receipts: [{ state: 'redacted', result: true }],
      });
      await failure(() => setNavigation(athlete, body, key), 'MEDIA_NOT_FOUND');
      expect((await navigate(athlete, navigationQuery({}))).items).toEqual([]);
    },
  );
  caseIt('exports the gallery section and erases extension rows with the account', async () => {
    const athlete = await newAthlete();
    const [mediaId, other] = await seedPlainMedia(athlete, [
      { createdAt: '2026-10-09T00:00:00.000001Z' },
      { createdAt: '2026-10-09T00:00:00.000002Z' },
    ]);
    if (!mediaId || !other) throw new Error('seed');
    const album = await create(athlete, '내보낼 앨범');
    const removed = await create(athlete, '삭제될 앨범');
    await command(athlete, 'delete', { albumId: removed.id, expectedRevision: 1 });
    const course = await seedCourse(athlete);
    const link = course.first;
    await setNavigation(athlete, {
      mediaItemId: mediaId,
      expectedAccessRevision: 1,
      albumMembership: { albumId: album.id },
      courseLink: link,
    });
    let budget = 8388608;
    const snapshot = db().snapshotTenant;
    if (!snapshot) throw new Error('GALLERY_ALBUM_FIXTURE_SNAPSHOT');
    const exported = await snapshot(athlete, (tx) =>
      readGalleryAccountExportV39In(
        tx,
        () => budget,
        (bytes) => {
          budget -= bytes;
        },
      ),
    );
    expect(exported.galleryAlbums.map((v) => v.id)).toEqual([album.id]);
    expect(exported.galleryAlbumMemberships).toEqual([{ mediaItemId: mediaId, albumId: album.id }]);
    expect(exported.galleryCourseAssociations).toEqual([
      { mediaItemId: mediaId, courseLink: link, courseAvailability: { state: 'available' } },
    ]);
    expect(exported.galleryAlbumDeletions.map((v) => v.albumId)).toEqual([removed.id]);
    const erased =
      await createGalleryExtensionErasureRepositoryCandidate(db()).eraseAccount(athlete);
    expect(erased.erased).toBe(true);
    const left = await tenant(
      'owner',
      athlete,
      (tx) =>
        tx.query(
          `SELECT (SELECT count(*)::int FROM public.gallery_album WHERE athlete_id=$1)
           +(SELECT count(*)::int FROM public.gallery_album_deletion WHERE athlete_id=$1)
           +(SELECT count(*)::int FROM public.gallery_media_album_membership WHERE athlete_id=$1)
           +(SELECT count(*)::int FROM public.gallery_media_course_association WHERE athlete_id=$1)
           +(SELECT count(*)::int FROM public.gallery_navigation_command_receipt WHERE athlete_id=$1)
           +(SELECT count(*)::int FROM public.gallery_media_item WHERE athlete_id=$1) AS rows,
           EXISTS(SELECT 1 FROM public.tenant_erasure WHERE athlete_id=$1) AS erased`,
          [athlete],
        ),
      true,
    );
    expect(left.rows[0]).toEqual({ rows: 0, erased: true });
    await failure(() => create(athlete), 'ACCOUNT_ERASED');
  });
  caseIt(
    'requires a formal new-processing guard for a committed restored CLOSED target',
    async () => {
      // Holding global/shared alone is not admission. Kept last: the committed
      // target stays CLOSED for this database. Replay and deletion stay available.
      const athlete = await newAthlete(),
        key = randomUUID(),
        album = await create(athlete, '닫힘 전 합성 앨범', key);
      const [mediaId] = await seedPlainMedia(athlete, [
        { createdAt: '2026-10-09T00:00:00.000001Z' },
      ]);
      if (!mediaId) throw new Error('seed');
      // Links authored while open; under CLOSED they may only be removed (P27-p1-3).
      const kept = await create(athlete, '닫힘 전 연결 앨범');
      const course = await seedCourse(athlete, 2);
      const attached = await setNavigation(athlete, {
        mediaItemId: mediaId,
        expectedAccessRevision: 1,
        albumMembership: { albumId: kept.id },
        courseLink: course.first,
      });
      expect(attached.item.accessRevision).toBe(2);
      await pool('owner').query('SELECT public.close_restore_processing_exact(1,$1,$2,$3)', [
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ]);
      const control = await pool('owner').query(
        'SELECT public.read_restore_processing_admission() AS result',
      );
      const state = z
        .object({
          state: z.literal('CLOSED'),
          targetNonce: z.uuid(),
          targetIncarnation: z.uuid(),
          admissionAllowed: z.literal(false),
        })
        .parse(control.rows[0]?.['result']);
      expect(state.admissionAllowed).toBe(false);
      await failure(() => create(athlete), 'RESTORE_PROCESSING_CLOSED');
      await failure(
        () =>
          command(athlete, 'rename', {
            albumId: album.id,
            expectedRevision: 1,
            title: '차단되어야 함',
          }),
        'RESTORE_PROCESSING_CLOSED',
      );
      // Attach or change is new authoring: refused, nothing written.
      for (const body of [
        { albumMembership: { albumId: album.id }, courseLink: null },
        {
          albumMembership: null,
          courseLink: { ...course.first, courseRevision: 2, revisionId: revisionOf(course, 1) },
        },
        {
          albumMembership: { albumId: kept.id },
          courseLink: { ...course.first, courseRevision: 2, revisionId: revisionOf(course, 1) },
        },
      ])
        await failure(
          () =>
            setNavigation(athlete, { mediaItemId: mediaId, expectedAccessRevision: 2, ...body }),
          'RESTORE_PROCESSING_CLOSED',
        );
      // Privacy detach creates nothing new: clearing the course while keeping the exact
      // current album, then clearing everything, both commit under CLOSED.
      const courseCleared = await setNavigation(athlete, {
        mediaItemId: mediaId,
        expectedAccessRevision: 2,
        albumMembership: { albumId: kept.id },
        courseLink: null,
      });
      expect(courseCleared).toMatchObject({
        albumMembership: { albumId: kept.id },
        courseLink: null,
      });
      expect(courseCleared.item.accessRevision).toBe(3);
      const detached = await setNavigation(athlete, {
        mediaItemId: mediaId,
        expectedAccessRevision: 3,
        albumMembership: null,
        courseLink: null,
      });
      expect(detached).toMatchObject({ albumMembership: null, courseLink: null });
      expect(detached.item.accessRevision).toBe(4);
      await failure(
        () =>
          setNavigation(athlete, {
            mediaItemId: mediaId,
            expectedAccessRevision: 4,
            albumMembership: { albumId: kept.id },
            courseLink: null,
          }),
        'RESTORE_PROCESSING_CLOSED',
      );
      expect(hash(await create(athlete, '닫힘 전 합성 앨범', key))).toBe(hash(album));
      const deleted = galleryAlbumDeleteResultV1Schema.parse(
        await command(athlete, 'delete', { albumId: album.id, expectedRevision: 1 }),
      );
      expect(deleted).toMatchObject({ status: 'deleted', revision: 2, detachedMediaCount: 0 });
    },
  );
});
