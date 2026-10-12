import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import { createGalleryMediaExtensionRepository } from '../src/gallery-media.js';
import { createGalleryExtensionErasureRepositoryCandidate } from '../src/gallery-erasure-repository-candidate.js';
import { verifyCurrentRuntimeV10InstalledIn } from '../src/current-runtime-installation-v10.js';
import { installCurrentRuntimeV10 } from '../src/current-runtime-installation-v10.js';
import {
  assertGalleryFunctionPinsV1In,
  assertGalleryTriggersV1In,
  galleryNavigationFunctionPinsV1,
  galleryNavigationRuntimeFunctionsV1,
  galleryNavigationTablesV1,
  galleryNavigationTriggersV1,
  galleryRestoreSuppressionFunctionPinsV1,
  galleryRestoreSuppressionTablesV1,
  galleryRestoreSuppressionTriggersV1,
  observeGalleryFunctionsV1In,
  probeGalleryNavigationRuntimeV1In,
} from '../src/gallery-navigation-pins-v1.js';
import {
  galleryRenditionDelegableFunctionsV1,
  galleryRenditionFunctionPinsV1,
  galleryRenditionTablesV1,
  galleryRenditionTriggersV1,
  probeGalleryRenditionRuntimeV1In,
} from '../src/gallery-rendition-pins-v1.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  grantGalleryNavigationRuntimeForTest,
  grantGalleryRenditionForTest,
  grantProfile26Runtime,
  installProfile26WithGalleryMembers,
} from './gallery-profile27-fixture.js';

// The three gallery members of profile27 applied raw from pinned bytes over a committed
// profile26 parent on disposable PostgreSQL 17.6: exact function/trigger pins, relation
// security, separated API/worker rosters, drift detection, the 116 CHECK successor, and
// deletion/erasure keeping renditions and navigation suppressed. The profile27 installer,
// ledger and grants belong to another lane; nothing here is a ledger or activation.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const ownerRole = `gpm_owner_${suffix}`;
const apiRole = `gpm_api_${suffix}`;
const workerRole = `gpm_worker_${suffix}`;
const databases = { members: `gpm_members_${suffix}`, parent: `gpm_parent_${suffix}` };
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const createdRoles: string[] = [];
const createdDatabases: string[] = [];
const pools: Pool[] = [];
const runtimes: Database[] = [];

function connection(database: string, role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + database;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
function pool(database: string, role: string) {
  const created = new Pool({ connectionString: connection(database, role), max: 2 });
  pools.push(created);
  return created;
}
async function code(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const parsed = z.object({ code: z.string().optional() }).safeParse(error);
    return parsed.success ? (parsed.data.code ?? 'no_code') : 'no_code';
  }
  return 'no_error';
}
async function tx<T>(
  client: Pool,
  athlete: string | null,
  work: (tx: PoolClient) => Promise<T>,
  commit = true,
): Promise<T> {
  const connection = await client.connect();
  try {
    await connection.query('BEGIN');
    if (athlete !== null) {
      await connection.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
      await connection.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    }
    const value = await work(connection);
    await connection.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
async function verifyAll(client: PoolClient) {
  await assertGalleryFunctionPinsV1In(
    client,
    galleryNavigationFunctionPinsV1,
    galleryNavigationRuntimeFunctionsV1,
  );
  await assertGalleryFunctionPinsV1In(
    client,
    galleryRenditionFunctionPinsV1,
    galleryRenditionDelegableFunctionsV1,
  );
  await assertGalleryFunctionPinsV1In(client, galleryRestoreSuppressionFunctionPinsV1, []);
  await assertGalleryTriggersV1In(client, [
    ...galleryNavigationTriggersV1,
    ...galleryRenditionTriggersV1,
    ...galleryRestoreSuppressionTriggersV1,
  ]);
}
async function newAthlete(owner: Pool) {
  const athlete = randomUUID();
  await tx(owner, athlete, (client) =>
    client.query(
      "INSERT INTO public.consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)",
      [athlete],
    ),
  );
  return athlete;
}
async function insertImage(owner: Pool, athlete: string) {
  const id = randomUUID();
  const hash = randomUUID().replaceAll('-', '').padEnd(64, '0');
  await tx(owner, athlete, (client) =>
    client.query(
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
async function renditionRows(owner: Pool, athlete: string) {
  return tx(owner, athlete, async (client) => {
    const result = await client.query(
      `SELECT (SELECT count(*)::int FROM public.gallery_rendition_job WHERE athlete_id=$1) AS jobs,
       (SELECT coalesce(jsonb_agg(cause ORDER BY cause),'[]'::jsonb) FROM public.gallery_rendition_sweep
         WHERE athlete_id=$1) AS sweeps`,
      [athlete],
    );
    return result.rows[0];
  });
}
const checkSql = `SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE conrelid='public.restore_suppression_event'::regclass ORDER BY conname`;

beforeAll(async () => {
  for (const role of [ownerRole, apiRole, workerRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    createdRoles.push(role);
  }
  for (const database of Object.values(databases)) {
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    createdDatabases.push(database);
    await migrate(connection(database, ownerRole), 107);
  }
  await installCurrentRuntimeV10(connection(databases.parent, ownerRole));
  const url = connection(databases.members, ownerRole);
  await installProfile26WithGalleryMembers(url);
  await grantProfile26Runtime(url, apiRole);
  await grantGalleryNavigationRuntimeForTest(url, apiRole);
  await grantGalleryRenditionForTest(url, 'api', apiRole);
  await grantGalleryRenditionForTest(url, 'worker', workerRole);
}, 300000);
afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined);
  for (const created of pools) await created.end().catch(() => undefined);
  for (const database of createdDatabases) await dropIsolatedDatabase(admin, database);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
}, 60000);

describe('profile27 gallery members over the profile26 parent', () => {
  it('match every pinned function body, definer flag and trigger after the grants', async () => {
    const owner = pool(databases.members, ownerRole);
    await tx(owner, null, verifyAll);
    const observed = await tx(owner, null, (client) =>
      observeGalleryFunctionsV1In(
        client,
        galleryRenditionFunctionPinsV1,
        galleryRenditionDelegableFunctionsV1,
      ),
    );
    expect(observed.map((row) => [row.signature, row.bodySha256, row.securityDefiner])).toEqual(
      galleryRenditionFunctionPinsV1.map((pin) => [
        pin.signature,
        pin.prosrcSha256,
        pin.securityDefiner,
      ]),
    );
    // Neither retired extension-v1 ledger schema exists in a profile27-shaped database.
    expect(
      (
        await owner.query(
          "SELECT to_regnamespace('wm_gallery_installation') IS NULL AS nav,to_regnamespace('wm_gallery_rendition_installation') IS NULL AS rend",
        )
      ).rows[0],
    ).toEqual({ nav: true, rend: true });
  });

  it('keeps every gallery relation owned, forced-RLS and closed to PUBLIC; derived and receipt tables undelegated', async () => {
    const owner = pool(databases.members, ownerRole);
    const rows = await owner.query(
      `SELECT t.name,
        c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owned,
        c.relrowsecurity AND c.relforcerowsecurity AS forced,
        NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS "publicDenied",
        NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner) AS undelegated
       FROM unnest($1::text[]) t(name) JOIN pg_class c ON c.oid=to_regclass('public.'||t.name) ORDER BY t.name`,
      [
        [
          ...galleryNavigationTablesV1,
          ...galleryRenditionTablesV1,
          ...galleryRestoreSuppressionTablesV1,
        ],
      ],
    );
    expect(rows.rows).toHaveLength(9);
    for (const row of rows.rows) {
      expect(row).toMatchObject({ owned: true, forced: true, publicDenied: true });
      if (
        [
          ...galleryRenditionTablesV1,
          ...galleryRestoreSuppressionTablesV1,
          'gallery_navigation_command_receipt',
        ].includes(String(row['name']))
      )
        expect(row['undelegated']).toBe(true);
    }
  });

  it('separates the API and worker rosters and probes each capability', async () => {
    const api = pool(databases.members, apiRole);
    const worker = pool(databases.members, workerRole);
    const athlete = randomUUID();
    expect(
      await tx(api, athlete, async (client) => [
        await probeGalleryNavigationRuntimeV1In(client),
        await probeGalleryRenditionRuntimeV1In(client, 'api'),
        await probeGalleryRenditionRuntimeV1In(client, 'worker'),
      ]),
    ).toEqual(['available', 'available', 'unavailable']);
    expect(
      await tx(worker, null, async (client) => [
        await probeGalleryRenditionRuntimeV1In(client, 'worker'),
        await probeGalleryRenditionRuntimeV1In(client, 'api'),
        await probeGalleryNavigationRuntimeV1In(client),
      ]),
    ).toEqual(['available', 'unavailable', 'unavailable']);
    for (const relation of [
      'public.gallery_rendition_job',
      'public.gallery_rendition_due',
      'public.gallery_rendition_sweep',
      'public.gallery_navigation_command_receipt',
      'public.restore_gallery_album_replay_receipt',
    ]) {
      expect(await code(() => api.query(`SELECT 1 FROM ${relation}`))).toBe('42501');
      expect(await code(() => worker.query(`SELECT 1 FROM ${relation}`))).toBe('42501');
    }
    for (const call of [
      'SELECT public.enqueue_gallery_renditions_v1(gen_random_uuid())',
      "SELECT public.gallery_rendition_insert_jobs_v1('x',gen_random_uuid())",
      'SELECT public.require_gallery_rendition_processing_v1()',
      "SELECT public.replay_gallery_album_deletion_exact_v1('x',gen_random_uuid(),gen_random_uuid(),now(),2)",
    ]) {
      expect(await code(() => api.query(call))).toBe('42501');
      expect(await code(() => worker.query(call))).toBe('42501');
    }
    // An unexpected table grant makes the runtime probe fail closed.
    const owner = pool(databases.members, ownerRole);
    await owner.query(`GRANT SELECT ON public.gallery_rendition_job TO "${apiRole}"`);
    try {
      expect(
        await tx(api, athlete, (client) => probeGalleryRenditionRuntimeV1In(client, 'api')),
      ).toBe('unavailable');
    } finally {
      await owner.query(`REVOKE SELECT ON public.gallery_rendition_job FROM "${apiRole}"`);
    }
  });

  it('detects function, delegation and trigger drift of all three members', async () => {
    const owner = pool(databases.members, ownerRole);
    for (const [mutation, expected] of [
      [
        `CREATE OR REPLACE FUNCTION public.gallery_rendition_processing_admitted_v1() RETURNS boolean
         LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN RETURN true; END $$`,
        'GALLERY_FUNCTION_DRIFT',
      ],
      [
        `GRANT EXECUTE ON FUNCTION public.gallery_rendition_insert_jobs_v1(text,uuid) TO "${apiRole}"`,
        'GALLERY_FUNCTION_DRIFT',
      ],
      [
        'ALTER FUNCTION public.remove_gallery_navigation_on_media_deletion_v1() SECURITY INVOKER',
        'GALLERY_FUNCTION_DRIFT',
      ],
      [
        `GRANT EXECUTE ON FUNCTION public.replay_gallery_album_deletion_exact_v1(text,uuid,uuid,timestamptz,integer) TO "${workerRole}"`,
        'GALLERY_FUNCTION_DRIFT',
      ],
      [
        'ALTER TABLE public.gallery_media_item DISABLE TRIGGER gallery_navigation_media_deleted',
        'GALLERY_TRIGGER_DRIFT',
      ],
      [
        'DROP TRIGGER record_gallery_album_deletion_suppression_event ON public.gallery_album',
        'GALLERY_TRIGGER_DRIFT',
      ],
      [
        'ALTER TABLE public.gallery_media_item DISABLE TRIGGER gallery_rendition_enqueue_item',
        'GALLERY_TRIGGER_DRIFT',
      ],
      [
        'DROP TRIGGER gallery_album_terminal_check ON public.gallery_album',
        'GALLERY_TRIGGER_DRIFT',
      ],
    ] as const) {
      const outcome = await tx(
        owner,
        null,
        async (client) => {
          await client.query(mutation);
          try {
            await verifyAll(client);
            return 'no_error';
          } catch (error) {
            return error instanceof Error ? error.message : 'unknown';
          }
        },
        false,
      );
      expect(outcome).toBe(expected);
    }
    await tx(owner, null, verifyAll);
  });

  it('wraps the 116 suppression CHECKs without changing any earlier branch; profile26 verify is blind to the stage', async () => {
    const membersOwner = pool(databases.members, ownerRole);
    const parentOwner = pool(databases.parent, ownerRole);
    const parent = (await parentOwner.query(checkSql)).rows;
    const members = (await membersOwner.query(checkSql)).rows;
    expect(members.map((row) => row['conname'])).toEqual(parent.map((row) => row['conname']));
    for (const [index, row] of members.entries()) {
      const before = String(parent[index]?.['definition']);
      const after = String(row['definition']);
      if (
        row['conname'] === 'restore_suppression_event_kind_target_check' ||
        row['conname'] === 'restore_suppression_event_record_version_check'
      ) {
        expect(after).not.toBe(before);
        expect(after).toContain("'gallery_album_deleted'::text");
        // The whole earlier expression survives verbatim inside the successor.
        expect(after).toContain(before.replace(/^CHECK \(/, '').replace(/\)$/, ''));
      } else expect(after).toBe(before);
    }
    // Recorded fact for the profile27 installer lane: profile26 verification still passes on
    // the raw stage, so V11 must detect 143/144/145 relations itself (presence 'staged').
    for (const database of [databases.parent, databases.members]) {
      const owner = pool(database, ownerRole);
      expect(
        await tx(
          owner,
          null,
          async (client) => (await verifyCurrentRuntimeV10InstalledIn(client)).runtimeStep,
        ),
      ).toBe(26);
    }
  });

  it('keeps media deletion and extension erasure suppressing renditions and navigation', async () => {
    const owner = pool(databases.members, ownerRole);
    const runtime = createDatabase({ connectionString: connection(databases.members, apiRole) });
    runtimes.push(runtime);
    const athlete = await newAthlete(owner);
    const media = await insertImage(owner, athlete);
    expect(await renditionRows(owner, athlete)).toEqual({ jobs: 2, sweeps: [] });
    expect(
      await createGalleryMediaExtensionRepository(runtime).softDelete(athlete, media, {
        expectedAccessRevision: 1,
        idempotencyKey: `synthetic-delete-${randomUUID()}`,
      }),
    ).toMatchObject({ status: 'deleted' });
    expect(await renditionRows(owner, athlete)).toEqual({ jobs: 0, sweeps: ['media_deleted'] });
    const erasedAthlete = await newAthlete(owner);
    await insertImage(owner, erasedAthlete);
    expect(await renditionRows(owner, erasedAthlete)).toEqual({ jobs: 2, sweeps: [] });
    expect(
      (await createGalleryExtensionErasureRepositoryCandidate(runtime).eraseAccount(erasedAthlete))
        .erased,
    ).toBe(true);
    expect(await renditionRows(owner, erasedAthlete)).toEqual({
      jobs: 0,
      sweeps: ['account_erased'],
    });
  });
});
