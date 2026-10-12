import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGalleryRenditionFinalObjectKey,
  createGalleryRenditionTemporaryObjectKey,
} from '@workout/server-media/keys';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
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
import { createGalleryRenditionWorkerStore } from '@workout/server-persistence/gallery-renditions';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { createConfiguredApi } from '../src/configured.js';
import { registerGalleryRenditionRoutes } from '../src/gallery-rendition-routes.js';
import {
  createVerifiedGalleryRenditionServices,
  GalleryRenditionCompositionError,
} from '../src/gallery-rendition-services.js';
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

// Actual PostgreSQL + Fastify inject over the verified SQL144 services. The principal stub
// stands in for the authenticated product plugin; OIDC sign-in and sessions are not exercised.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const name = `gallery_rend_api_${suffix}`;
const ownerRole = `gallery_rend_api_owner_${suffix}`;
const runtimeRole = `gallery_rend_api_app_${suffix}`;
const workerRole = `gallery_rend_api_worker_${suffix}`;
const ungrantedRole = `gallery_rend_api_bare_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const roles: string[] = [];
let created = false;
let database: Database | undefined;
let workerPool: Pool | undefined;
let app: FastifyInstance | undefined;
let storageRoot: string | undefined;
const athletes = { owner: randomUUID(), foreign: randomUUID() };
const media = { image: randomUUID(), video: randomUUID() };

function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + name;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('GALLERY_RENDITION_API_FIXTURE_NOT_READY');
  return value;
}
function http() {
  if (!app) throw new Error('GALLERY_RENDITION_API_FIXTURE_NOT_READY');
  return app;
}
function get(athlete: string, url: string) {
  return http().inject({ method: 'GET', url, headers: { 'x-synthetic-athlete': athlete } });
}
async function* once(bytes: Uint8Array) {
  yield bytes;
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'gallery-rend-api-'));
  for (const role of [ownerRole, runtimeRole, workerRole, ungrantedRole]) {
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
    [
      [runtimeRole, 'api'],
      [workerRole, 'worker'],
    ],
  );
  const owner = new Pool({ connectionString: connection(ownerRole), max: 1 });
  try {
    for (const athlete of Object.values(athletes)) {
      const tx = await owner.connect();
      try {
        await tx.query('BEGIN');
        await tx.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
        await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
        await tx.query(
          "INSERT INTO public.consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)",
          [athlete],
        );
        if (athlete === athletes.owner)
          for (const [kind, id] of [
            ['image', media.image],
            ['video', media.video],
          ] as const) {
            const hash = createHash('sha256').update(id).digest('hex');
            await tx.query(
              `INSERT INTO public.gallery_media_item(athlete_id,id,media_kind,storage_ref,original_filename,
               media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
               VALUES($1,$2,$3,$4,'synthetic',$5,4096,$6,1,clock_timestamp(),clock_timestamp())`,
              [
                athlete,
                id,
                kind,
                `private/v1/tenants/${athlete}/gallery/${id}/objects/uploads/${randomUUID()}/sha256/${hash}.${kind === 'image' ? 'jpg' : 'mp4'}`,
                kind === 'image' ? 'image/jpeg' : 'video/mp4',
                hash,
              ],
            );
          }
        await tx.query('COMMIT');
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      } finally {
        tx.release();
      }
    }
  } finally {
    await owner.end();
  }
  database = createDatabase({ connectionString: connection(runtimeRole), max: 2 });
  workerPool = new Pool({ connectionString: connection(workerRole), max: 2 });
  const storage = await createLocalFilesystemObjectStorage(storageRoot);
  app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProductRequestError)
      return reply.code(error.statusCode).send({ error: { code: error.code } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });
  const services = await createVerifiedGalleryRenditionServices(database, storage);
  // Same /bff/v1 prefix the authenticated product plugin applies.
  await app.register(
    async (routes) => {
      registerGalleryRenditionRoutes(routes, services, (request) => ({
        method: 'bearer',
        athleteId: z.uuid().parse(request.headers['x-synthetic-athlete']),
        sessionId: 'synthetic-session',
      }));
    },
    { prefix: '/bff/v1' },
  );
  await app.ready();
}, 240000);
afterAll(async () => {
  await app?.close();
  await database?.close();
  await workerPool?.end();
  if (created) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
}, 60000);

describe('Gallery rendition HTTP over the installed SQL144 extension', () => {
  it('lists owned presentation state, serves only exact ready bytes and hides other tenants', async () => {
    const listed = await get(athletes.owner, `/bff/v1/gallery/media/${media.image}/renditions`);
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('private, no-store');
    const body = z
      .object({ renditions: z.array(z.object({ kind: z.string(), state: z.string() })) })
      .parse(listed.json());
    expect(body.renditions.map((r) => [r.kind, r.state])).toEqual([
      ['image_preview', 'queued'],
      ['image_thumbnail', 'queued'],
    ]);
    expect(JSON.stringify(listed.json())).not.toMatch(/storage|lease|job|private\//i);
    const notReady = await get(
      athletes.owner,
      `/bff/v1/gallery/media/${media.image}/renditions/image_preview/content`,
    );
    expect(notReady.statusCode).toBe(404);
    expect(notReady.json()).toEqual({ error: { code: 'RENDITION_NOT_READY' } });
    const foreign = await get(athletes.foreign, `/bff/v1/gallery/media/${media.image}/renditions`);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ error: { code: 'MEDIA_NOT_FOUND' } });

    // A worker-role settle of a stored synthetic WebP makes exactly that kind ready.
    const store = createGalleryRenditionWorkerStore(need(workerPool), { leaseSeconds: 60 });
    const workerId = randomUUID();
    let claim = await store.claim(workerId);
    while (claim && !(claim.mediaItemId === media.image && claim.kind === 'image_preview')) {
      await store.release({
        athleteId: claim.athleteId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        code: 'aborted',
      });
      claim = await store.claim(workerId);
    }
    if (!claim) throw new Error('GALLERY_RENDITION_API_FIXTURE_CLAIM');
    const bytes = Buffer.from('RIFF\x10\x00\x00\x00WEBPsynthetic', 'latin1');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const base = {
      tenantId: claim.athleteId,
      mediaItemId: claim.mediaItemId,
      renditionKind: claim.kind,
      jobId: claim.jobId,
      attemptId: claim.leaseToken,
      recipeVersion: 1 as const,
    };
    const storage = await createLocalFilesystemObjectStorage(need(storageRoot));
    const temporary = createGalleryRenditionTemporaryObjectKey(base);
    const final = createGalleryRenditionFinalObjectKey({
      ...base,
      sha256: digest,
      extension: 'webp',
    });
    await storage.writeTemporary(temporary, once(bytes));
    await storage.publishTemporary(temporary, final, { sizeBytes: bytes.length, sha256: digest });
    expect(
      await store.settle({
        athleteId: claim.athleteId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        output: {
          storageRef: final,
          sha256: digest,
          byteSize: bytes.length,
          mediaType: 'image/webp',
          width: 640,
          height: 480,
          durationSeconds: null,
        },
      }),
    ).toEqual({ state: 'ready' });
    const ready = await get(
      athletes.owner,
      `/bff/v1/gallery/media/${media.image}/renditions/image_preview/content`,
    );
    expect(ready.statusCode).toBe(200);
    expect(ready.headers['content-type']).toBe('image/webp');
    expect(ready.headers['x-content-type-options']).toBe('nosniff');
    expect(ready.rawPayload.equals(bytes)).toBe(true);
    const stateAfter = await get(athletes.owner, `/bff/v1/gallery/media/${media.image}/renditions`);
    expect(
      z
        .object({ renditions: z.array(z.object({ kind: z.string(), state: z.string() })) })
        .parse(stateAfter.json())
        .renditions.map((r) => r.state),
    ).toEqual(['ready', 'queued']);
    const foreignBytes = await get(
      athletes.foreign,
      `/bff/v1/gallery/media/${media.image}/renditions/image_preview/content`,
    );
    expect(foreignBytes.statusCode).toBe(404);
  });

  it('baseline107 configured composition registers no rendition route; the retired flag is inert', async () => {
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
        OIDC_CLIENT_ID: 'gallery-rendition-fixture',
        OIDC_CLIENT_SECRET: 'synthetic-never-log-client-secret',
        ALLOW_INSECURE_LOCALHOST: 'true',
        PRIVATE_RESOURCE_STORAGE_ROOT: storageRoot ?? '',
        WORKOUT_GALLERY_RENDITIONS: 'installed-extension-v1',
      },
      { logStream: silent },
    );
    try {
      const url = `/bff/v1/gallery/media/${media.image}/renditions`;
      // Renditions are a profile27 member only; baseline107 has no rendition route at all.
      expect((await configured.inject({ method: 'GET', url })).statusCode).toBe(404);
    } finally {
      await configured.close();
    }
  });
  it('verified rendition services fail closed for a role without exactly the API roster', async () => {
    const storage = await createLocalFilesystemObjectStorage(storageRoot ?? '');
    for (const role of [ungrantedRole, workerRole]) {
      const other = createDatabase({ connectionString: connection(role), max: 1 });
      try {
        await expect(createVerifiedGalleryRenditionServices(other, storage)).rejects.toBeInstanceOf(
          GalleryRenditionCompositionError,
        );
      } finally {
        await other.close();
      }
    }
  });
});
