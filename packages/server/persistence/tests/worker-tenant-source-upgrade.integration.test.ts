import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  grantActivityTracks,
  grantCourses,
  grantCourseThumbnailWorker,
  grantGalleryMedia,
  grantOperations,
  grantResourceObjectCleanupWorker,
  grantResourceRetrieval,
  grantResources,
  grantResourceUrlIngestionWorker,
  migrate,
  migrationFileNames,
} from '../src/migrate.js';
import { createResourceDerivedCleanupRepository } from '../src/resource-derived-cleanup.js';
import { createResourceObjectCleanupRepository } from '../src/resource-object-cleanup.js';
import { createResourceUrlIngestionWorkerRepository } from '../src/resource-url-ingestions.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The tenant-source migration (M2-01av) on a database a migration owner that is neither
 * superuser nor BYPASSRLS built, applied on top of everything before it, with work of every
 * kind already waiting in two tenants.
 *
 * It must change exactly what it says and nothing else:
 *   * no earlier checksum;
 *   * every worker function it names keeps its body byte for byte — with its definer flag,
 *     owner and settings — under `<name>_in_tenant`, and EXECUTE moves from it to the wrapper
 *     now under the public name, so each public name's grants are what they were;
 *   * the other new functions are the index's helpers and triggers; the only other function it
 *     changes is `retarget_definer_policies()`, by the one entry for the index; every other
 *     function is identical;
 *   * exactly one new policy — the index's, owner only — and every other policy the same, FORCE
 *     unchanged on every table that existed (lifted for the backfill, put back): so no tenant
 *     table gains a policy and no other definer function sees more — the owner still sees no
 *     tenant row with no tenant named;
 *   * new triggers only on the eight tables the index follows; no privilege on anything that
 *     existed changes, and after every grant helper nothing but the owner reaches the index,
 *     the helpers or a renamed body;
 *   * the index holds exactly what its own entry functions say of every row that existed, and
 *     the workers do that waiting work.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `plain_wup_${suffix}`;
const ownerRole = `plain_wup_owner_${suffix}`;
const runtimeRole = `plain_wup_rt_${suffix}`;
const workerRole = `plain_wup_worker_${suffix}`;

function urlFor(role: string | null): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  if (role !== null) {
    url.username = role;
    url.password = 'plain';
  }
  return url.toString();
}

// Found by name, never by number: a migration merged in before it renumbers it.
const migrationIndex = migrationFileNames.findIndex((name) =>
  /^\d+_worker_tenant_source\.sql$/.test(name),
);
if (migrationIndex < 0) throw new Error('the tenant-source migration is not in the list');
const versionsBefore = migrationIndex;

/** The worker functions whose bodies move to `<name>_in_tenant`. */
const wrapped = [
  'activity_track_reconcile_window(text,integer)',
  'clear_activity_track_sweep_fault(text)',
  'clear_course_thumbnail_sweep_fault(text)',
  'course_thumbnail_publication_fence_open(uuid,uuid)',
  'course_thumbnail_reconcile_window(text,integer)',
  'enqueue_abandoned_resource_url_object(text,uuid,uuid,text)',
  'fail_course_thumbnail(uuid,uuid,text,boolean,interval)',
  'fail_resource_url_ingestion(uuid,uuid,text,boolean,interval)',
  'finalize_course_thumbnail(uuid,uuid)',
  'finalize_resource_url_ingestion(uuid,uuid)',
  'lease_course_thumbnail_render(uuid,interval)',
  'lease_resource_url_ingestion(uuid,interval)',
  'mark_course_thumbnail_unavailable(uuid,uuid,text)',
  'mark_resource_url_bookmark_only(uuid,uuid,text,text)',
  'mark_resource_url_parsed_published(uuid,uuid)',
  'mark_resource_url_raw_published(uuid,uuid)',
  'prepare_course_thumbnail(uuid,uuid,text,text,bigint,integer)',
  'prepare_resource_url_parsed(uuid,uuid,text,text,bigint,text,jsonb,text,text)',
  'prepare_resource_url_raw(uuid,uuid,text,text,bigint,text)',
  'prune_course_thumbnail_history(integer)',
  'prune_resource_retrieval_cache(integer)',
  'prune_resource_upload_history(integer)',
  'reap_course_thumbnail_renders(integer)',
  'reap_expired_resource_uploads(timestamp with time zone,integer)',
  'reap_resource_url_ingestions(integer)',
  'record_activity_track_sweep_fault(text,text)',
  'record_course_thumbnail_sweep_fault(text,text)',
  'record_resource_url_hop(uuid,uuid,integer,text,text,integer,inet[],text)',
  'release_course_thumbnail_render(uuid,uuid)',
  'requeue_course_thumbnail_refs(uuid)',
];
const renamed = (signature: string) => signature.replace('(', '_in_tenant(');
const helpers = [
  'course_thumbnail_work_index()',
  'course_thumbnail_work_items(course_thumbnail)',
  'defer_tenant_work(text[],text[],timestamp with time zone)',
  'object_ref_work_index()',
  'owner_reads_every_tenant()',
  'put_tenant_work(text,text,text[],text[],timestamp with time zone[])',
  'resource_retrieval_cache_work_index()',
  'resource_url_ingestion_work_index()',
  'resource_url_ingestion_work_items(resource_url_ingestion)',
  'tenant_work_due(text[],timestamp with time zone)',
  'tenant_work_item_tenant(text,text)',
  'tenant_work_window(text,text,integer)',
  'upload_intent_work_index()',
  'upload_intent_work_items(text,text,timestamp with time zone,timestamp with time zone)',
];
const triggerFunctions = new Set([
  'course_thumbnail_work_index()',
  'object_ref_work_index()',
  'resource_retrieval_cache_work_index()',
  'resource_url_ingestion_work_index()',
  'upload_intent_work_index()',
]);
const sourceTables = [
  'activity_track_object_ref',
  'activity_track_upload_intent',
  'course_thumbnail',
  'course_thumbnail_object_ref',
  'gallery_upload_intent',
  'resource_retrieval_cache',
  'resource_upload_intent',
  'resource_url_ingestion',
];

const first = randomUUID();
const second = randomUUID();
const planted = {
  queuedJob: randomUUID(),
  closedJob: randomUUID(),
  urlRequest: randomUUID(),
  resourceUpload: randomUUID(),
  galleryUpload: randomUUID(),
  trackUpload: randomUUID(),
  cacheKey: 'e'.repeat(64),
  trackRef: `private/v1/tenants/${first}/activities/${randomUUID()}/tracks/watched`,
  thumbnailRef: `private/v1/tenants/${second}/courses/${randomUUID()}/thumbnails/watched`,
};

let upgraded: Pool;

/** Rows no path of the system could have left here unhandled, planted with keys and triggers off. */
async function plantWaitingWork(): Promise<void> {
  const client = await upgraded.connect();
  const digest = 'a'.repeat(64);
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `INSERT INTO course_thumbnail(athlete_id,course_id,course_revision,revision_id,job_id,state,
         temporary_ref,created_at,updated_at,expires_at)
       VALUES($1,$2,1,$3,$4,'queued',$5,now(),now(),now()+interval '1 hour')`,
      [first, randomUUID(), randomUUID(), planted.queuedJob, `private/v1/tenants/${first}/t/q`],
    );
    await client.query(
      `INSERT INTO course_thumbnail(athlete_id,course_id,course_revision,revision_id,job_id,state,
         temporary_ref,failure_code,failed_at,created_at,updated_at,expires_at)
       VALUES($1,$2,1,$3,$4,'failed',$5,'TEST_CLOSED',now()-interval '8 days',
         now()-interval '9 days',now()-interval '8 days',now()-interval '9 days'+interval '1 hour')`,
      [second, randomUUID(), randomUUID(), planted.closedJob, `private/v1/tenants/${second}/t/c`],
    );
    await client.query(
      `INSERT INTO resource_url_ingestion(athlete_id,request_id,idempotency_key,request_digest,
         operation,resource_id,version_id,requested_url,display_url,title,category,metadata,tags,
         favorite,state,raw_temporary_ref,parsed_temporary_ref,created_at,updated_at,expires_at)
       VALUES($1,$2,$3,$4,'create',$5,$6,'https://example.com/a','https://example.com/a','Paper',
         'paper','{}','[]',false,'queued',$7,$8,now()-interval '20 minutes',
         now()-interval '20 minutes',now()-interval '1 minute')`,
      [
        first,
        planted.urlRequest,
        `url-${randomUUID()}`,
        digest,
        randomUUID(),
        randomUUID(),
        `private/v1/tenants/${first}/u/raw`,
        `private/v1/tenants/${first}/u/parsed`,
      ],
    );
    await client.query(
      `INSERT INTO resource_upload_intent(athlete_id,upload_id,idempotency_key,request_digest,
         operation,resource_id,version_id,temporary_ref,source_kind,title,category,metadata,tags,
         favorite,state,created_at,updated_at,expires_at)
       VALUES($1,$2,$3,$4,'create',$5,$6,$7,'file','File','paper','{}','[]',false,'reserved',
         now()-interval '2 hours',now()-interval '2 hours',now()-interval '1 hour')`,
      [
        second,
        planted.resourceUpload,
        `file-${randomUUID()}`,
        digest,
        randomUUID(),
        randomUUID(),
        `private/v1/tenants/${second}/r/tmp`,
      ],
    );
    await client.query(
      `INSERT INTO gallery_upload_intent(athlete_id,upload_id,idempotency_key,request_digest,
         operation,media_item_id,media_kind,temporary_ref,state,created_at,updated_at,expires_at)
       VALUES($1,$2,$3,$4,'create_item',$5,'image',$6,'reserved',now()-interval '2 hours',
         now()-interval '2 hours',now()-interval '1 hour')`,
      [
        first,
        planted.galleryUpload,
        `gallery-${randomUUID()}`,
        digest,
        randomUUID(),
        `private/v1/tenants/${first}/g/tmp`,
      ],
    );
    await client.query(
      `INSERT INTO activity_track_upload_intent(athlete_id,upload_id,idempotency_key,
         request_digest,activity_id,track_id,source_kind,source_id,source_revision,
         expected_activity_revision,recorded_track_index,track_revision,raw_temporary_ref,
         normalized_temporary_ref,map_path_temporary_ref,state,created_at,updated_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,'fit','source',1,1,0,1,$7,$8,$9,'reserved',
         now()-interval '2 hours',now()-interval '2 hours',now()-interval '1 hour')`,
      [
        second,
        planted.trackUpload,
        `track-${randomUUID()}`,
        digest,
        randomUUID(),
        randomUUID(),
        `private/v1/tenants/${second}/a/raw`,
        `private/v1/tenants/${second}/a/normalized`,
        `private/v1/tenants/${second}/a/map`,
      ],
    );
    await client.query(
      `INSERT INTO resource_retrieval_cache(athlete_id,cache_key,corpus_version,
         authorization_digest,passage_ids,created_at,expires_at)
       VALUES($1,$2,1,$3,'[]',now()-interval '2 hours',now()-interval '1 minute')`,
      [first, planted.cacheKey, 'b'.repeat(64)],
    );
    await client.query(
      `INSERT INTO activity_track_object_ref(storage_ref,athlete_id,recorded_at)
       VALUES($1,$2,now())`,
      [planted.trackRef, first],
    );
    await client.query(
      `INSERT INTO course_thumbnail_object_ref(storage_ref,athlete_id,recorded_at)
       VALUES($1,$2,now())`,
      [planted.thumbnailRef, second],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${ownerRole}"`);
  upgraded = new Pool({ connectionString: urlFor(null) });
  await migrate(urlFor(ownerRole), versionsBefore);
  await plantWaitingWork();
  // A worker granted the functions before the migration, as a deployment's helpers left it.
  await upgraded.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  for (const signature of wrapped)
    await upgraded.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO "${workerRole}"`);
});

afterAll(async () => {
  await upgraded?.end();
  await dropIsolatedDatabase(admin, database);
  for (const role of [workerRole, runtimeRole, ownerRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});

async function checksums(): Promise<Map<number, string>> {
  const rows = await upgraded.query<{ version: number; checksum: string }>(
    'SELECT version,checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.rows.map((row) => [row.version, row.checksum]));
}

type FunctionFacts = {
  body: string;
  definer: boolean;
  owner: string;
  config: string | null;
  acl: string | null;
};

async function functions(): Promise<Map<string, FunctionFacts>> {
  const rows = await upgraded.query<{ signature: string } & FunctionFacts>(
    `SELECT p.oid::regprocedure::text AS signature,p.prosrc AS body,p.prosecdef AS definer,
       pg_get_userbyid(p.proowner) AS owner,array_to_string(p.proconfig,';') AS config,
       p.proacl::text AS acl
     FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace,
       'identity_private'::regnamespace,'garmin_private'::regnamespace)`,
  );
  return new Map(rows.rows.map(({ signature, ...facts }) => [signature, facts]));
}

async function policies(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT schemaname||'.'||tablename||':'||policyname||':'||permissive||':'||
       array_to_string(roles,',')||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'')
       AS entry
     FROM pg_policies ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

async function rowSecurity(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT n.nspname||'.'||c.relname||':'||c.relrowsecurity||':'||c.relforcerowsecurity AS entry
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

async function triggers(): Promise<string[]> {
  const rows = await upgraded.query<{ entry: string }>(
    `SELECT c.relname||':'||t.tgname||':'||t.tgenabled||':'||pg_get_triggerdef(t.oid) AS entry
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE NOT t.tgisinternal ORDER BY 1`,
  );
  return rows.rows.map((row) => row.entry);
}

/** Every access-control list in the schema: relations, columns, schemas, functions. */
async function privileges(): Promise<Map<string, string>> {
  const rows = await upgraded.query<{ object: string; acl: string }>(
    `SELECT 'rel:'||n.nspname||'.'||c.relname AS object,coalesce(c.relacl::text,'') AS acl
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
     UNION ALL
     SELECT 'col:'||n.nspname||'.'||c.relname||'.'||a.attname,a.attacl::text
     FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE a.attacl IS NOT NULL AND n.nspname NOT IN ('pg_catalog','information_schema')
     UNION ALL
     SELECT 'nsp:'||n.nspname,coalesce(n.nspacl::text,'') FROM pg_namespace n
     WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname<>'information_schema'
     UNION ALL
     SELECT 'fn:'||p.oid::regprocedure::text,coalesce(p.proacl::text,'') FROM pg_proc p
     WHERE p.pronamespace IN ('public'::regnamespace,'identity_private'::regnamespace,
       'garmin_private'::regnamespace)`,
  );
  return new Map(rows.rows.map((row) => [row.object, row.acl]));
}

/** What the owner itself sees of a table with no tenant named. */
async function ownerSeesWithoutTenant(table: string): Promise<number> {
  const client = await upgraded.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE "${ownerRole}"`);
    const seen = await client.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${table}`,
    );
    return Number(seen.rows[0]?.total);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

const retargetEdits: readonly (readonly [string, string])[] = [
  [
    "      ('tenant_object_purge')) AS t(table_name)",
    "      ('tenant_object_purge'),('tenant_work_index')) AS t(table_name)",
  ],
  [
    "      ('tenant_object_purge','tenant_object_purge_definer')) AS t(table_name,policy_name)",
    "      ('tenant_object_purge','tenant_object_purge_definer'),\n      ('tenant_work_index','tenant_work_index_definer')) AS t(table_name,policy_name)",
  ],
];

describe('tenant-source migration upgrade of a database a plain owner built', () => {
  it('changes exactly the functions, policies, triggers and privileges it names', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const functionsBefore = await functions();
    const policiesBefore = await policies();
    const rowSecurityBefore = await rowSecurity();
    const triggersBefore = await triggers();
    const privilegesBefore = await privileges();
    for (const table of sourceTables) expect(await ownerSeesWithoutTenant(table), table).toBe(0);

    await expect(migrate(urlFor(ownerRole), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);

    const functionsAfter = await functions();
    expect(
      [...functionsAfter.keys()].filter((signature) => !functionsBefore.has(signature)).sort(),
    ).toEqual([...wrapped.map(renamed), ...helpers].sort());
    for (const signature of wrapped) {
      const previous = functionsBefore.get(signature);
      if (!previous) throw new Error(`${signature} did not exist`);
      // The body, byte for byte, under its new name — reachable by no one but the owner.
      expect(functionsAfter.get(renamed(signature)), renamed(signature)).toEqual({
        ...previous,
        acl: `{${ownerRole}=X/${ownerRole}}`,
      });
      // The public name: a definer wrapper that calls that body, with the grants it had.
      const wrapper = functionsAfter.get(signature);
      expect(wrapper, signature).toMatchObject({
        definer: true,
        owner: ownerRole,
        config: 'search_path=pg_catalog, pg_temp',
        acl: previous.acl,
      });
      // Once where row security passes over the owner, once under the named tenant.
      const body = wrapper?.body ?? '';
      expect(occurrences(body, `public.${renamed(signature).split('(')[0]}(`), signature).toBe(2);
      expect(occurrences(body, 'public.owner_reads_every_tenant()'), signature).toBe(1);
      expect(previous.acl, signature).toContain(`${workerRole}=X/${ownerRole}`);
    }
    for (const signature of helpers)
      expect(functionsAfter.get(signature), signature).toMatchObject({
        definer: triggerFunctions.has(signature),
        owner: ownerRole,
        config: 'search_path=pg_catalog, pg_temp',
        acl: `{${ownerRole}=X/${ownerRole}}`,
      });
    const retarget = 'retarget_definer_policies()';
    for (const [signature, facts] of functionsBefore) {
      if (wrapped.includes(signature)) continue;
      const now = functionsAfter.get(signature);
      if (signature !== retarget) {
        expect(now, `${signature} changed`).toEqual(facts);
        continue;
      }
      let expected = facts.body;
      for (const [from, to] of retargetEdits) {
        expect(occurrences(expected, from), from).toBe(1);
        expected = expected.replace(from, to);
      }
      expect(now).toEqual({ ...facts, body: expected });
    }

    // Exactly one new policy, the index's, for the owner only; FORCE unchanged everywhere.
    const policiesAfter = await policies();
    expect(policiesAfter.filter((entry) => !policiesBefore.includes(entry))).toEqual([
      `public.tenant_work_index:tenant_work_index_definer:PERMISSIVE:${ownerRole}:ALL:true:true`,
    ]);
    expect(policiesBefore.filter((entry) => !policiesAfter.includes(entry))).toEqual([]);
    expect(await rowSecurity()).toEqual(
      [...rowSecurityBefore, 'public.tenant_work_index:true:true'].sort(),
    );
    // New triggers only on the eight tables the index follows; every other trigger the same.
    const triggersAfter = await triggers();
    expect(triggersBefore.filter((entry) => !triggersAfter.includes(entry))).toEqual([]);
    expect(
      triggersAfter
        .filter((entry) => !triggersBefore.includes(entry))
        .map((entry) => entry.split(':').slice(0, 3).join(':')),
    ).toEqual(sourceTables.map((table) => `${table}:${table}_work_index:O`));
    // No privilege on anything that existed changed.
    const privilegesAfter = await privileges();
    for (const [object, acl] of privilegesBefore)
      expect(privilegesAfter.get(object), object).toBe(acl);
    expect(
      [...privilegesAfter.keys()].filter((object) => !privilegesBefore.has(object)).sort(),
    ).toEqual(
      [
        'rel:public.tenant_work_index',
        'rel:public.tenant_work_index_due',
        'rel:public.tenant_work_index_pkey',
        ...[...wrapped.map(renamed), ...helpers].map((signature) => `fn:${signature}`),
      ].sort(),
    );
    expect(privilegesAfter.get('rel:public.tenant_work_index')).toBe(
      `{${ownerRole}=arwdDxt/${ownerRole}}`,
    );
    // So the owner still sees no tenant row without a tenant; it sees the index.
    for (const table of sourceTables) expect(await ownerSeesWithoutTenant(table), table).toBe(0);
    expect(await ownerSeesWithoutTenant('tenant_work_index')).toBeGreaterThan(0);
  });

  it('fills the index with exactly what its entry functions say of every row there was', async () => {
    const index = await upgraded.query<{ entry: string }>(
      `SELECT kind||'|'||item||'|'||athlete_id||'|'||coalesce(due_at::text,'') AS entry
       FROM tenant_work_index ORDER BY 1`,
    );
    const expected = await upgraded.query<{ entry: string }>(
      `SELECT kind||'|'||item||'|'||athlete_id||'|'||coalesce(due_at::text,'') AS entry FROM (
         SELECT w.kind,t.job_id::text AS item,t.athlete_id,w.due_at FROM course_thumbnail t
         CROSS JOIN LATERAL public.course_thumbnail_work_items(t) w
         UNION ALL
         SELECT w.kind,t.request_id::text,t.athlete_id,w.due_at FROM resource_url_ingestion t
         CROSS JOIN LATERAL public.resource_url_ingestion_work_items(t) w
         UNION ALL
         SELECT w.kind,t.upload_id::text,t.athlete_id,w.due_at FROM resource_upload_intent t
         CROSS JOIN LATERAL public.upload_intent_work_items('resource_upload_intent',t.state,
           t.updated_at,t.expires_at) w
         UNION ALL
         SELECT w.kind,t.upload_id::text,t.athlete_id,w.due_at FROM gallery_upload_intent t
         CROSS JOIN LATERAL public.upload_intent_work_items('gallery_upload_intent',t.state,
           t.updated_at,t.expires_at) w
         UNION ALL
         SELECT w.kind,t.upload_id::text,t.athlete_id,w.due_at FROM activity_track_upload_intent t
         CROSS JOIN LATERAL public.upload_intent_work_items('activity_track_upload_intent',
           t.state,t.updated_at,t.expires_at) w
         UNION ALL
         SELECT 'resource_retrieval_cache:prune',cache_key,athlete_id,expires_at
         FROM resource_retrieval_cache
         UNION ALL
         SELECT 'activity_track_object_ref:window',storage_ref,athlete_id,NULL
         FROM activity_track_object_ref WHERE settled_at IS NULL
         UNION ALL
         SELECT 'course_thumbnail_object_ref:window',storage_ref,athlete_id,NULL
         FROM course_thumbnail_object_ref WHERE settled_at IS NULL
       ) e ORDER BY 1`,
    );
    expect(index.rows).toEqual(expected.rows);
    const kinds = await upgraded.query<{ kind: string; athlete_id: string; item: string }>(
      `SELECT kind,athlete_id,item FROM tenant_work_index ORDER BY kind,item`,
    );
    expect(kinds.rows).toEqual(
      [
        { kind: 'activity_track_object_ref:window', athlete_id: first, item: planted.trackRef },
        {
          kind: 'activity_track_upload_intent:reap',
          athlete_id: second,
          item: planted.trackUpload,
        },
        { kind: 'course_thumbnail:job', athlete_id: first, item: planted.queuedJob },
        { kind: 'course_thumbnail:job', athlete_id: second, item: planted.closedJob },
        { kind: 'course_thumbnail:lease', athlete_id: first, item: planted.queuedJob },
        { kind: 'course_thumbnail:prune', athlete_id: second, item: planted.closedJob },
        { kind: 'course_thumbnail:reap', athlete_id: first, item: planted.queuedJob },
        {
          kind: 'course_thumbnail_object_ref:window',
          athlete_id: second,
          item: planted.thumbnailRef,
        },
        { kind: 'gallery_upload_intent:reap', athlete_id: first, item: planted.galleryUpload },
        { kind: 'resource_retrieval_cache:prune', athlete_id: first, item: planted.cacheKey },
        { kind: 'resource_upload_intent:reap', athlete_id: second, item: planted.resourceUpload },
        { kind: 'resource_url_ingestion:lease', athlete_id: first, item: planted.urlRequest },
        { kind: 'resource_url_ingestion:reap', athlete_id: first, item: planted.urlRequest },
        { kind: 'resource_url_ingestion:request', athlete_id: first, item: planted.urlRequest },
      ].sort((a, b) => (a.kind + a.item < b.kind + b.item ? -1 : 1)),
    );
  });

  it('reaches the index, its helpers and the bodies only through the owner, helpers included', async () => {
    await migrate(urlFor(ownerRole));
    const owner = urlFor(ownerRole);
    const pool = new Pool({ connectionString: owner, max: 1 });
    try {
      await pool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    } finally {
      await pool.end();
    }
    await grantOperations(owner, runtimeRole);
    await grantActivityTracks(owner, runtimeRole);
    await grantCourses(owner, runtimeRole);
    await grantResources(owner, runtimeRole);
    await grantResourceRetrieval(owner, runtimeRole);
    await grantGalleryMedia(owner, runtimeRole);
    await grantResourceObjectCleanupWorker(owner, workerRole);
    await grantCourseThumbnailWorker(owner, workerRole);
    await grantResourceUrlIngestionWorker(owner, workerRole);
    const others = await upgraded.query<{ entry: string }>(
      `SELECT c.relname||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')||':'||a.privilege_type
         AS entry
       FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
       WHERE c.relname='tenant_work_index' AND a.grantee<>c.relowner
       UNION ALL
       SELECT p.oid::regprocedure::text||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.oid::regprocedure::text=ANY($1) AND a.grantee<>p.proowner
       ORDER BY 1`,
      [[...wrapped.map(renamed), ...helpers]],
    );
    expect(others.rows).toEqual([]);
    const executable = await upgraded.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
       WHERE p.oid::regprocedure::text=ANY($2) AND has_function_privilege($1,p.oid,'EXECUTE')
       ORDER BY 1`,
      [workerRole, wrapped],
    );
    expect(executable.rows.map((row) => row.signature)).toEqual([...wrapped].sort());
  });

  it('lets the workers do the work that was waiting before the migration', async () => {
    const cleanup = createResourceObjectCleanupRepository({
      connectionString: urlFor(workerRole),
      max: 1,
    });
    const derived = createResourceDerivedCleanupRepository({
      connectionString: urlFor(workerRole),
      max: 1,
    });
    const fetcher = createResourceUrlIngestionWorkerRepository({
      connectionString: urlFor(workerRole),
    });
    try {
      expect(await cleanup.reapExpired(new Date(), 100)).toBe(3);
      expect(await fetcher.reap(100)).toBe(1);
      expect(await cleanup.pruneCourseThumbnailHistory(100)).toBe(1);
      expect(await derived.pruneRetrievalCache(100)).toBe(1);
      expect((await cleanup.reconcileWindow('', 1000)).map((ref) => ref.storageRef)).toEqual([
        planted.trackRef,
      ]);
      expect(
        (await cleanup.thumbnailReconcileWindow('', 1000)).map((ref) => ref.storageRef),
      ).toEqual([planted.thumbnailRef]);
    } finally {
      await fetcher.close();
      await derived.close();
      await cleanup.close();
    }
    const states = await upgraded.query<{ state: string }>(
      `SELECT state FROM resource_upload_intent WHERE upload_id=$1
       UNION ALL SELECT state FROM gallery_upload_intent WHERE upload_id=$2
       UNION ALL SELECT state FROM activity_track_upload_intent WHERE upload_id=$3
       UNION ALL SELECT state FROM resource_url_ingestion WHERE request_id=$4`,
      [planted.resourceUpload, planted.galleryUpload, planted.trackUpload, planted.urlRequest],
    );
    expect(states.rows).toEqual([
      { state: 'failed' },
      { state: 'failed' },
      { state: 'failed' },
      { state: 'failed' },
    ]);
  });
});
