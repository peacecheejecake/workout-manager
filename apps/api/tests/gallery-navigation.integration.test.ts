import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@workout/server-persistence/migrate';
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
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { createConfiguredApi } from '../src/configured.js';
import { registerGalleryNavigationRoutes } from '../src/gallery-navigation-routes.js';
import {
  createGalleryNavigationServices,
  createVerifiedGalleryNavigationServices,
  GalleryNavigationCompositionError,
} from '../src/gallery-navigation-services.js';
import { ProductRequestError } from '../src/product-boundary.js';

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

// Actual PostgreSQL + Fastify inject over the real services and SQL143, applied raw from pinned
// bytes (with 144/145) over a committed profile26 parent (test stand-in for profile27).
// The principal stub stands in for the existing authenticated product plugin;
// OIDC sign-in, CSRF and browser sessions are not exercised here.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const name = `gallery_nav_api_${suffix}`;
const ownerRole = `gallery_nav_api_owner_${suffix}`;
const runtimeRole = `gallery_nav_api_app_${suffix}`;
const ungrantedRole = `gallery_nav_api_bare_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const roles: string[] = [];
let created = false;
let database: Database | undefined;
let app: FastifyInstance | undefined;
let storageRoot: string | undefined;
const athletes = { owner: randomUUID(), foreign: randomUUID() };
function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
async function asOwner<T>(work: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: connection(ownerRole), max: 1 });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}
function http() {
  if (!app) throw new Error('GALLERY_NAV_API_FIXTURE_NOT_READY');
  return app;
}
const encoded = (value: unknown) =>
  new URLSearchParams({ query: JSON.stringify(value) }).toString();
function inject(
  athlete: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: unknown,
) {
  return http().inject({
    method,
    url,
    headers: {
      'x-synthetic-athlete': athlete,
      ...(method === 'GET' ? {} : { 'idempotency-key': `synthetic-${randomUUID()}` }),
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}
const navigation = (filters: Record<string, unknown>) => ({
  filters: {
    album: { mode: 'all' },
    mediaKind: null,
    activityId: null,
    courseLink: null,
    capturedDay: { mode: 'all' },
    ...filters,
  },
  limit: 10,
  sort: 'created_desc_id_asc',
  cursor: null,
});

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'gallery-nav-api-'));
  for (const role of [ownerRole, runtimeRole, ungrantedRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(connection(ownerRole), 107);
  await stageGalleryProfile27ForTest(
    connection(ownerRole),
    [runtimeRole, ungrantedRole],
    [[runtimeRole, 'navigation']],
  );
  await asOwner(async (pool) => {
    for (const athlete of Object.values(athletes)) {
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
        await tx.query(
          `INSERT INTO public.gallery_media_item(athlete_id,id,media_kind,captured_local_date,storage_ref,
            original_filename,media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
           VALUES($1,$2,'image','2026-03-01',$3,'synthetic.png','image/png',1,$4,1,statement_timestamp(),statement_timestamp())`,
          [
            athlete,
            athlete === athletes.owner ? athletes.owner : randomUUID(),
            `synthetic-${randomUUID()}`,
            'a'.repeat(64),
          ],
        );
        await tx.query('COMMIT');
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    }
  });
  database = createDatabase({ connectionString: connection(runtimeRole), max: 2 });
  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProductRequestError)
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  registerGalleryNavigationRoutes(app, createGalleryNavigationServices(database), (request) => ({
    method: 'bearer',
    athleteId: z.uuid().parse(request.headers['x-synthetic-athlete']),
    sessionId: 'synthetic-session',
  }));
  await app.ready();
}, 240000);
afterAll(async () => {
  await app?.close();
  await database?.close();
  if (created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
}, 60000);

describe('Gallery navigation HTTP over actual SQL143 services', () => {
  it('creates, lists, assigns, filters, renames and deletes owned albums with stable codes', async () => {
    const created = await inject(athletes.owner, 'POST', '/gallery/albums', {
      title: '합성 HTTP 앨범',
    });
    expect(created.statusCode).toBe(200);
    const album = z.object({ id: z.uuid(), revision: z.literal(1) }).parse(created.json());
    const listed = await inject(
      athletes.owner,
      'GET',
      `/gallery/albums?${encoded({ limit: 10, sort: 'created_desc_id_asc', cursor: null })}`,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((v: { id: string }) => v.id)).toEqual([album.id]);
    const foreignList = await inject(
      athletes.foreign,
      'GET',
      `/gallery/albums?${encoded({ limit: 10, sort: 'created_desc_id_asc', cursor: null })}`,
    );
    expect(foreignList.json().items).toEqual([]);
    const body = {
      mediaItemId: athletes.owner,
      expectedAccessRevision: 1,
      albumMembership: { albumId: album.id },
      courseLink: null,
    };
    const assigned = await inject(
      athletes.owner,
      'PUT',
      `/gallery/media/${athletes.owner}/membership`,
      body,
    );
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      albumMembership: { albumId: album.id },
      courseAvailability: null,
    });
    const stale = await inject(
      athletes.owner,
      'PUT',
      `/gallery/media/${athletes.owner}/membership`,
      body,
    );
    expect([stale.statusCode, stale.json()]).toEqual([
      409,
      { error: { code: 'MEDIA_ACCESS_CONFLICT' } },
    ]);
    const foreignMedia = await inject(
      athletes.foreign,
      'PUT',
      `/gallery/media/${athletes.owner}/membership`,
      body,
    );
    expect([foreignMedia.statusCode, foreignMedia.json()]).toEqual([
      404,
      { error: { code: 'MEDIA_NOT_FOUND' } },
    ]);
    const missingCourse = await inject(
      athletes.owner,
      'PUT',
      `/gallery/media/${athletes.owner}/membership`,
      {
        ...body,
        expectedAccessRevision: 2,
        courseLink: { courseId: randomUUID(), courseRevision: 1, revisionId: randomUUID() },
      },
    );
    expect([missingCourse.statusCode, missingCourse.json()]).toEqual([
      404,
      { error: { code: 'COURSE_NOT_FOUND' } },
    ]);
    const filtered = await inject(
      athletes.owner,
      'GET',
      `/gallery/media/navigation?${encoded(
        navigation({
          album: { mode: 'album', albumId: album.id },
          capturedDay: {
            mode: 'stored_local_range',
            from: '2026-03-01',
            toInclusive: '2026-03-01',
          },
        }),
      )}`,
    );
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items.map((v: { item: { id: string } }) => v.item.id)).toEqual([
      athletes.owner,
    ]);
    const unknownDay = await inject(
      athletes.owner,
      'GET',
      `/gallery/media/navigation?${encoded(navigation({ capturedDay: { mode: 'unknown' } }))}`,
    );
    expect(unknownDay.json().items).toEqual([]);
    const renamed = await inject(athletes.owner, 'PATCH', `/gallery/albums/${album.id}`, {
      albumId: album.id,
      expectedRevision: 1,
      title: '이름 바꾼 앨범',
    });
    expect(renamed.json()).toMatchObject({ revision: 2, title: '이름 바꾼 앨범' });
    const foreignDelete = await inject(athletes.foreign, 'DELETE', `/gallery/albums/${album.id}`, {
      albumId: album.id,
      expectedRevision: 2,
    });
    expect([foreignDelete.statusCode, foreignDelete.json()]).toEqual([
      404,
      { error: { code: 'ALBUM_NOT_FOUND' } },
    ]);
    const deleted = await inject(athletes.owner, 'DELETE', `/gallery/albums/${album.id}`, {
      albumId: album.id,
      expectedRevision: 2,
    });
    expect(deleted.json()).toMatchObject({ status: 'deleted', revision: 3, detachedMediaCount: 1 });
    const after = await inject(
      athletes.owner,
      'GET',
      `/gallery/media/navigation?${encoded(navigation({ album: { mode: 'unassigned' } }))}`,
    );
    expect(
      after.json().items.map((v: { item: { accessRevision: number } }) => v.item.accessRevision),
    ).toEqual([3]);
  });
  it('baseline107 configured composition registers no navigation route; the retired flag is inert', async () => {
    const silent = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const configured = await createConfiguredApi(
      {
        NODE_ENV: 'test',
        DATABASE_URL: connection(runtimeRole),
        PUBLIC_ORIGIN: 'http://127.0.0.1:4301',
        OIDC_ISSUER: 'http://127.0.0.1:1',
        OIDC_CLIENT_ID: 'gallery-navigation-fixture',
        OIDC_CLIENT_SECRET: 'synthetic-never-log-client-secret',
        ALLOW_INSECURE_LOCALHOST: 'true',
        PRIVATE_RESOURCE_STORAGE_ROOT: storageRoot ?? '',
        WORKOUT_GALLERY_NAVIGATION: 'installed-extension-v1',
      },
      { logStream: silent },
    );
    try {
      const response = await configured.inject({
        method: 'GET',
        url: `/bff/v1/gallery/albums?${encoded({ limit: 10, sort: 'created_desc_id_asc', cursor: null })}`,
      });
      // Navigation is a profile27 member only; baseline107 has no navigation route at all.
      expect(response.statusCode).toBe(404);
    } finally {
      await configured.close();
    }
  });
  it('verified navigation services fail closed for a role without the runtime roster', async () => {
    const ungranted = createDatabase({ connectionString: connection(ungrantedRole), max: 1 });
    try {
      await expect(createVerifiedGalleryNavigationServices(ungranted)).rejects.toBeInstanceOf(
        GalleryNavigationCompositionError,
      );
    } finally {
      await ungranted.close();
    }
    const granted = createDatabase({ connectionString: connection(runtimeRole), max: 1 });
    try {
      await expect(createVerifiedGalleryNavigationServices(granted)).resolves.toBeDefined();
    } finally {
      await granted.close();
    }
  });
});
