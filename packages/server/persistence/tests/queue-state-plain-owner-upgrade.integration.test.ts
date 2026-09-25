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
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
} from '../src/resource-object-cleanup.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

/**
 * The queue-and-state migration (M2-01au) on a database a migration owner that is neither
 * superuser nor BYPASSRLS built, applied on top of everything before it.
 *
 * It must change exactly what it says and nothing else:
 *   * no earlier checksum;
 *   * new functions: only the read helpers and the policy retarget — none a definer, none
 *     callable by anyone but the owner;
 *   * replaced functions: only the ones it names, each the previous body with only the stated
 *     edits, the reads it moved out found verbatim in the helper that now makes them, the same
 *     owner, definer flag and grants; every other function identical;
 *   * exactly four new policies — the queue and state tables, owner only — and every other
 *     policy the same, FORCE unchanged everywhere: so no tenant table gains a policy and no
 *     other definer function of the owner sees more;
 *   * no privilege changed on anything that existed, and after every grant helper nothing but
 *     the owner holds a privilege on the four tables or the new functions;
 *   * a cleanup row queued before the migration, which the worker could not see, is leased
 *     and finished after it.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
if (!adminUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const database = `plain_qup_${suffix}`;
const ownerRole = `plain_qup_owner_${suffix}`;
const runtimeRole = `plain_qup_rt_${suffix}`;
const workerRole = `plain_qup_worker_${suffix}`;

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
  /^\d+_queue_state_plain_owner\.sql$/.test(name),
);
if (migrationIndex < 0) throw new Error('the queue-state migration is not in the list');
const versionsBefore = migrationIndex;

const stateTables = [
  'activity_track_reconcile_state',
  'course_thumbnail_reconcile_state',
  'resource_derived_cleanup',
  'resource_object_cleanup',
];
const newFunctions = [
  'activity_track_object_held(text,timestamp with time zone)',
  'course_thumbnail_object_held(text,timestamp with time zone)',
  'object_key_tenant(text)',
  'resource_object_publication_fence(text,timestamp with time zone)',
  'resource_object_publication_window(text,timestamp with time zone)',
  'resource_object_referenced(text,timestamp with time zone)',
  'restore_foreign_scope_present(text,text,uuid)',
  'retarget_definer_policies()',
];

/**
 * One edit of a previous body. `replace` swaps text that occurs exactly once. The other kind
 * cuts the text from `from` up to and including `through` (each found exactly once, in that
 * order), puts `to` in its place, and names the helper the cut text must now be found in,
 * verbatim — without the `unwrap` prefix and suffix that wrapped the reads where they were.
 */
type Edit =
  | { readonly replace: string; readonly with: string }
  | {
      readonly from: string;
      readonly through: string;
      readonly to: string;
      readonly movedTo?: string;
      readonly unwrap?: readonly [string, string];
    };

const fenceHelper = 'resource_object_publication_fence(text,timestamp with time zone)';
const referenceHelper = 'resource_object_referenced(text,timestamp with time zone)';
const windowHelper = 'resource_object_publication_window(text,timestamp with time zone)';
const trackHeldHelper = 'activity_track_object_held(text,timestamp with time zone)';
const thumbnailHeldHelper = 'course_thumbnail_object_held(text,timestamp with time zone)';

const keyTenant = `coalesce(public.object_key_tenant($1),'')`;
const settleEdits = (target: string): Edit[] => [
  {
    replace: 'DECLARE affected integer;\n',
    with: "DECLARE affected integer;\nDECLARE caller_tenant text:=current_setting('app.athlete_id',true);\n",
  },
  {
    replace: `  UPDATE public.${target} r SET settled_at=database_now\n`,
    with: `  PERFORM set_config('app.athlete_id',${keyTenant},true);\n  UPDATE public.${target} r SET settled_at=database_now\n`,
  },
  {
    replace: '  GET DIAGNOSTICS affected=ROW_COUNT;\n',
    with: "  GET DIAGNOSTICS affected=ROW_COUNT;\n  PERFORM set_config('app.athlete_id',coalesce(caller_tenant,''),true);\n",
  },
];

const replaced: Record<string, readonly Edit[]> = {
  'authorize_resource_object_cleanup(uuid,uuid,timestamp with time zone)': [
    {
      replace: '  IF object_ref IS NULL THEN RETURN; END IF;\n',
      with: `  IF object_ref IS NULL THEN RETURN; END IF;
  -- Every reference below is read under the tenant the key names (M2-01au). A key that names
  -- no tenant cannot be checked that way, so it is refused and labelled; nothing is deleted.
  IF public.object_key_tenant(object_ref) IS NULL THEN
    UPDATE public.resource_object_cleanup q SET completed_at=database_now,lease_owner=NULL,
      lease_until=NULL,delete_authorized_at=NULL,
      last_error_code='INCONSISTENT_LEDGER:OBJECT_KEY_TENANT'
      WHERE q.id=$1;
    RETURN;
  END IF;
`,
    },
    {
      from: '  SELECT max(fence) INTO publication_fence FROM (',
      through: '  ) fences;\n',
      to: '  publication_fence:=public.resource_object_publication_fence(object_ref,database_now);\n',
      movedTo: fenceHelper,
    },
    {
      from: '  IF EXISTS(\n    SELECT 1 FROM public.resource_version v',
      through:
        "         OR (t.temporary_ref=object_ref AND t.state IN ('queued','rendering','prepared')\n           AND t.expires_at>database_now)\n  ) THEN\n",
      to: '  IF public.resource_object_referenced(object_ref,database_now) THEN\n',
      movedTo: referenceHelper,
      unwrap: ['  IF ', ' THEN\n'],
    },
  ],
  'finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamp with time zone)': [
    {
      from: '  publication_window:=EXISTS(',
      through: '      AND object_ref IN (t.temporary_ref,t.storage_ref));\n',
      to: '  publication_window:=public.resource_object_publication_window(object_ref,database_now);\n',
      movedTo: windowHelper,
    },
  ],
  'reclaim_unreferenced_activity_track_object(text)': [
    {
      from: '  IF EXISTS(\n    SELECT 1 FROM public.activity_track_revision r',
      through:
        '        i.raw_storage_ref,i.normalized_storage_ref,i.map_path_storage_ref)\n  ) OR EXISTS(\n    SELECT 1 FROM public.resource_object_cleanup q',
      to: '  IF public.activity_track_object_held($1,database_now) OR EXISTS(\n    SELECT 1 FROM public.resource_object_cleanup q',
      movedTo: trackHeldHelper,
      unwrap: ['  IF ', ' OR EXISTS(\n    SELECT 1 FROM public.resource_object_cleanup q'],
    },
  ],
  'reclaim_unreferenced_course_thumbnail_object(text)': [
    {
      from: '  IF EXISTS(\n    SELECT 1 FROM public.course_thumbnail t',
      through:
        "        t.lease_until+interval '1 hour')\n  ) OR EXISTS(\n    SELECT 1 FROM public.resource_object_cleanup q",
      to: '  IF public.course_thumbnail_object_held($1,database_now) OR EXISTS(\n    SELECT 1 FROM public.resource_object_cleanup q',
      movedTo: thumbnailHeldHelper,
      unwrap: ['  IF ', ' OR EXISTS(\n    SELECT 1 FROM public.resource_object_cleanup q'],
    },
  ],
  'settle_activity_track_object_ref(text)': settleEdits('activity_track_object_ref'),
  'settle_course_thumbnail_object_ref(text)': settleEdits('course_thumbnail_object_ref'),
  'purge_resource_derived_store(uuid,uuid,text)': [
    {
      replace: 'DECLARE affected integer := 0;\n',
      with: "DECLARE affected integer := 0;\nDECLARE caller_tenant text := current_setting('app.athlete_id', true);\n",
    },
    {
      replace: "  IF tenant IS NULL THEN RAISE EXCEPTION 'DERIVED_CLEANUP_LEASE_LOST'; END IF;\n",
      with: "  IF tenant IS NULL THEN RAISE EXCEPTION 'DERIVED_CLEANUP_LEASE_LOST'; END IF;\n  PERFORM set_config('app.athlete_id', tenant, true);\n",
    },
    {
      replace: '  GET DIAGNOSTICS affected = ROW_COUNT;\n',
      with: "  GET DIAGNOSTICS affected = ROW_COUNT;\n  PERFORM set_config('app.athlete_id', coalesce(caller_tenant, ''), true);\n",
    },
  ],
  'lease_object_scope_purge(uuid,timestamp with time zone,timestamp with time zone)': [
    {
      from: '  -- A row the lease below refuses because its owner is live: say so, once.',
      through:
        'ORDER BY p.available_at,p.athlete_id,p.scope_kind,p.scope_id FOR UPDATE SKIP LOCKED LIMIT 100);\n',
      to: `  -- A row the lease below refuses because its owner is live: say so, once. Not leased, not
  -- charged, nothing deleted. Only the head of the due order is asked — the (at most 100)
  -- unlabelled rows the lease reaches first — so the per-row tenant read is paid a bounded
  -- number of times however long the backlog is (M2-01au). A live row further back is labelled
  -- when it reaches the head; it is never leased before then either.
  -- Both steps are materialized, so the helper runs once per head row, whatever plan joins them.
  WITH head AS MATERIALIZED (
    SELECT w.athlete_id,w.scope_kind,w.scope_id FROM public.object_scope_purge w
    WHERE w.completed_at IS NULL AND w.attempts<100 AND w.available_at<=database_now
      AND (w.lease_until IS NULL OR w.lease_until<=database_now)
      AND NOT coalesce(starts_with(w.last_error_code,'INCONSISTENT_LEDGER:'),false)
    ORDER BY w.available_at,w.athlete_id,w.scope_kind,w.scope_id LIMIT 100
  ), live AS MATERIALIZED (
    SELECT h.athlete_id,h.scope_kind,h.scope_id FROM head h
    WHERE public.object_purge_scope_live(h.athlete_id,h.scope_kind,h.scope_id)
  )
  UPDATE public.object_scope_purge q SET last_error_code=CASE q.scope_kind
      WHEN 'activity' THEN 'INCONSISTENT_LEDGER:ACTIVITY_LIVE'
      ELSE 'INCONSISTENT_LEDGER:COURSE_AVAILABLE' END
  WHERE (q.athlete_id,q.scope_kind,q.scope_id) IN (
    SELECT p.athlete_id,p.scope_kind,p.scope_id FROM public.object_scope_purge p
    JOIN live l ON l.athlete_id=p.athlete_id AND l.scope_kind=p.scope_kind
      AND l.scope_id=p.scope_id
    WHERE p.completed_at IS NULL AND p.attempts<100 AND p.available_at<=database_now
      AND (p.lease_until IS NULL OR p.lease_until<=database_now)
      AND NOT coalesce(starts_with(p.last_error_code,'INCONSISTENT_LEDGER:'),false)
    FOR UPDATE OF p SKIP LOCKED);
`,
    },
  ],
  'replay_absent_activity_deletion(text,uuid,text,text,integer,integer,text)': [
    {
      replace:
        "c.athlete_id<>$1 AND c.id=$2)\n  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_FOREIGN_ACTIVITY'",
      with: "c.athlete_id<>$1 AND c.id=$2)\n    OR public.restore_foreign_scope_present($1,'activity',$2)\n  THEN RAISE EXCEPTION 'ACTIVITY_REPLAY_FOREIGN_ACTIVITY'",
    },
  ],
  'replay_course_deletion(text,uuid,timestamp with time zone)': [
    {
      replace:
        "c.athlete_id<>$1 AND c.course_id=$2)\n  THEN RAISE EXCEPTION 'COURSE_REPLAY_FOREIGN_COURSE'",
      with: "c.athlete_id<>$1 AND c.course_id=$2)\n    OR public.restore_foreign_scope_present($1,'course',$2)\n  THEN RAISE EXCEPTION 'COURSE_REPLAY_FOREIGN_COURSE'",
    },
  ],
};

let upgraded: Pool;
const queuedRef = `private/v1/tenants/${randomUUID()}/resources/${randomUUID()}/temporary/${randomUUID()}`;

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'plain' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${database} OWNER "${ownerRole}"`);
  upgraded = new Pool({ connectionString: urlFor(null) });
  await migrate(urlFor(ownerRole), versionsBefore);
  // A deletion queued before the migration: on this owner nothing could lease it.
  await upgraded.query(
    `INSERT INTO resource_object_cleanup(id,storage_ref,reason,available_at,created_at)
     VALUES($1,$2,'upload_abandoned',clock_timestamp(),clock_timestamp())`,
    [randomUUID(), queuedRef],
  );
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

describe('queue-and-state migration upgrade of a database a plain owner built', () => {
  it('changes exactly the functions, policies and nothing of the privileges it names', async () => {
    const before = await checksums();
    expect(before.size).toBe(versionsBefore);
    const functionsBefore = await functions();
    const policiesBefore = await policies();
    const rowSecurityBefore = await rowSecurity();
    const privilegesBefore = await privileges();
    // A tenant row the owner must go on not seeing without a tenant named.
    // Written in the tenant's session, as the application writes it (the owner's triggers fire).
    const tenant = randomUUID();
    const session = await upgraded.connect();
    try {
      await session.query('BEGIN');
      await session.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
      await session.query(
        `INSERT INTO activity_canonical(athlete_id,id,revision,original,deleted)
         VALUES($1,$2,1,'{}'::jsonb,true)`,
        [tenant, randomUUID()],
      );
      await session.query('COMMIT');
    } finally {
      session.release();
    }
    expect(await ownerSeesWithoutTenant('activity_canonical')).toBe(0);
    expect(await ownerSeesWithoutTenant('resource_object_cleanup')).toBe(0);

    await expect(migrate(urlFor(ownerRole), versionsBefore + 1)).resolves.toBeUndefined();

    const after = await checksums();
    expect(after.size).toBe(versionsBefore + 1);
    for (const [version, checksum] of before)
      expect(after.get(version), `migration ${version} changed`).toBe(checksum);

    const functionsAfter = await functions();
    expect(
      [...functionsAfter.keys()].filter((signature) => !functionsBefore.has(signature)).sort(),
    ).toEqual(newFunctions);
    for (const signature of newFunctions)
      expect(functionsAfter.get(signature), signature).toMatchObject({
        definer: false,
        owner: ownerRole,
        config: 'search_path=pg_catalog, pg_temp',
        acl: `{${ownerRole}=X/${ownerRole}}`,
      });
    for (const signature of Object.keys(replaced))
      expect(functionsBefore.has(signature), signature).toBe(true);
    for (const [signature, facts] of functionsBefore) {
      const now = functionsAfter.get(signature);
      const edits = replaced[signature];
      if (!edits) {
        expect(now, `${signature} changed`).toEqual(facts);
        continue;
      }
      let expected = facts.body;
      for (const edit of edits) {
        if ('replace' in edit) {
          expect(occurrences(expected, edit.replace), `${signature}: ${edit.replace}`).toBe(1);
          expected = expected.replace(edit.replace, edit.with);
          continue;
        }
        expect(occurrences(expected, edit.from), `${signature}: ${edit.from}`).toBe(1);
        expect(occurrences(expected, edit.through), `${signature}: ${edit.through}`).toBe(1);
        const start = expected.indexOf(edit.from);
        const end = expected.indexOf(edit.through) + edit.through.length;
        expect(end, `${signature}: order`).toBeGreaterThan(start);
        const cut = expected.slice(start, end);
        if (edit.movedTo) {
          const [head, tail] = edit.unwrap ?? ['', ''];
          expect(cut.startsWith(head) && cut.endsWith(tail), `${signature}: unwrap`).toBe(true);
          const moved = cut.slice(head.length, cut.length - tail.length);
          const helper = functionsAfter.get(edit.movedTo)?.body ?? '';
          expect(occurrences(helper, moved), `${signature}: moved to ${edit.movedTo}`).toBe(1);
        }
        expected = expected.slice(0, start) + edit.to + expected.slice(end);
      }
      expect(now?.body, signature).toBe(expected);
      expect(now, signature).toMatchObject({
        definer: facts.definer,
        owner: facts.owner,
        acl: facts.acl,
        config: 'search_path=pg_catalog, pg_temp',
      });
    }

    // Exactly four new policies, on the queue and state tables, for the owner only.
    const policiesAfter = await policies();
    expect(policiesAfter.filter((entry) => !policiesBefore.includes(entry))).toEqual(
      stateTables.map(
        (table) => `public.${table}:${table}_definer:PERMISSIVE:${ownerRole}:ALL:true:true`,
      ),
    );
    expect(policiesBefore.filter((entry) => !policiesAfter.includes(entry))).toEqual([]);
    expect(await rowSecurity()).toEqual(rowSecurityBefore);
    // No privilege on anything that existed changed; the new functions are the owner's only.
    const privilegesAfter = await privileges();
    for (const [object, acl] of privilegesBefore)
      expect(privilegesAfter.get(object), object).toBe(acl);
    expect(
      [...privilegesAfter.keys()].filter((object) => !privilegesBefore.has(object)).sort(),
    ).toEqual(newFunctions.map((signature) => `fn:${signature}`).sort());
    // So the owner still sees no tenant row without a tenant; it sees its queue now.
    expect(await ownerSeesWithoutTenant('activity_canonical')).toBe(0);
    expect(await ownerSeesWithoutTenant('resource_object_cleanup')).toBe(1);
  });

  it('reaches the queue and state tables only through the owner, grant helpers included', async () => {
    await migrate(urlFor(ownerRole));
    const owner = urlFor(ownerRole);
    const pool = new Pool({ connectionString: owner, max: 1 });
    try {
      await pool.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}","${workerRole}"`);
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
       WHERE c.relname=ANY($1) AND a.grantee<>c.relowner
       UNION ALL
       SELECT c.relname||'.'||t.attname||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')||':'||
         a.privilege_type
       FROM pg_class c JOIN pg_attribute t ON t.attrelid=c.oid,LATERAL aclexplode(t.attacl) a
       WHERE c.relname=ANY($1)
       UNION ALL
       SELECT p.oid::regprocedure::text||':'||coalesce(pg_get_userbyid(a.grantee),'PUBLIC')
       FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.oid::regprocedure::text=ANY($2) AND a.grantee<>p.proowner
       ORDER BY 1`,
      [stateTables, newFunctions],
    );
    expect(others.rows).toEqual([]);
    // The worker keeps its grants on the functions replaced in place.
    const executable = await upgraded.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
       WHERE p.oid::regprocedure::text=ANY($2) AND has_function_privilege($1,p.oid,'EXECUTE')
       ORDER BY 1`,
      [workerRole, Object.keys(replaced)],
    );
    expect(executable.rows.map((row) => row.signature)).toEqual([
      'authorize_resource_object_cleanup(uuid,uuid,timestamp with time zone)',
      'finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamp with time zone)',
      'lease_object_scope_purge(uuid,timestamp with time zone,timestamp with time zone)',
      'purge_resource_derived_store(uuid,uuid,text)',
      'reclaim_unreferenced_activity_track_object(text)',
      'reclaim_unreferenced_course_thumbnail_object(text)',
      'settle_activity_track_object_ref(text)',
      'settle_course_thumbnail_object_ref(text)',
    ]);
  });

  it('lets the worker lease and finish a deletion queued before the migration', async () => {
    await migrate(urlFor(ownerRole));
    await grantResourceObjectCleanupWorker(urlFor(ownerRole), workerRole);
    const worker = createResourceObjectCleanupRepository({
      connectionString: urlFor(workerRole),
      max: 1,
    });
    const deleted: string[] = [];
    try {
      expect(
        await processOneResourceObjectCleanup(worker, async (ref) => {
          deleted.push(ref);
        }),
      ).toBe('completed');
    } finally {
      await worker.close();
    }
    expect(deleted).toEqual([queuedRef]);
    const row = await upgraded.query(
      'SELECT completed_at IS NOT NULL AS done,last_error_code FROM resource_object_cleanup WHERE storage_ref=$1',
      [queuedRef],
    );
    expect(row.rows).toEqual([{ done: true, last_error_code: null }]);
  });
});
