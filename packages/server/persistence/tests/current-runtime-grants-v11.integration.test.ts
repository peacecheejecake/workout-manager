import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV10 } from '../src/current-runtime-installation-v10.js';
import { grantCurrentRuntimeV10Profile } from '../src/current-runtime-grants-v10.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import {
  installCurrentRuntimeV11,
  verifyCurrentRuntimeV11InstalledIn,
  currentRuntimeV11Tables,
} from '../src/current-runtime-installation-v11.js';
import {
  grantCurrentRuntimeV11Profile,
  grantCurrentRuntimeV11ProfileIn,
  grantCurrentRuntimeV11GalleryWorker,
  grantCurrentRuntimeV11GalleryWorkerIn,
  grantCurrentRuntimeV11AiDispatcher,
  grantCurrentRuntimeV11AiDispatcherIn,
  currentRuntimeV11RpcSignatures,
  currentRuntimeV11WorkerRpcSignatures,
  currentRuntimeV11OwnerOnlyFunctions,
  currentRuntimeV11GalleryWorkerRole,
  currentRuntimeV11AiDispatcherRole,
} from '../src/current-runtime-grants-v11.js';
import { probeGalleryNavigationRuntimeV1In } from '../src/gallery-navigation-pins-v1.js';
import { probeGalleryRenditionRuntimeV1In } from '../src/gallery-rendition-pins-v1.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real PostgreSQL 17. ACL metadata only: no health, account, provider or restore data.
// The worker and dispatcher names are fixed by the product; they are created here only when
// absent and dropped only if this file created them.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const ownerRole = `crg11_owner_${suffix}`,
  runtimeRole = `crg11_app_${suffix}`,
  otherRole = `crg11_other_${suffix}`;
const worker = currentRuntimeV11GalleryWorkerRole,
  dispatcher = currentRuntimeV11AiDispatcherRole;
const fresh = `crg11_fresh_${suffix}`,
  upgrade = `crg11_upgrade_${suffix}`,
  normal = `crg11_normal_${suffix}`,
  parent = `crg11_parent_${suffix}`,
  staged = `crg11_staged_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const databases: string[] = [],
  roles: string[] = [];
function url(database: string, role = ownerRole) {
  const u = new URL(adminUrl);
  u.pathname = '/' + database;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function session<T>(database: string, run: (tx: PoolClient) => Promise<T>, role = ownerRole) {
  const pool = new Pool({
    connectionString: url(database, role),
    max: 1,
    statement_timeout: 60000,
  });
  const tx = await pool.connect();
  try {
    return await run(tx);
  } finally {
    tx.release();
    await pool.end();
  }
}
async function rollback<T>(database: string, run: (tx: PoolClient) => Promise<T>) {
  return session(database, async (tx) => {
    await tx.query('BEGIN');
    try {
      return await run(tx);
    } finally {
      await tx.query('ROLLBACK');
    }
  });
}
async function rejected(tx: PoolClient, run: () => Promise<unknown>, message: string | RegExp) {
  await tx.query('SAVEPOINT rejection');
  try {
    await expect(run()).rejects.toThrow(message);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT rejection');
    await tx.query('RELEASE SAVEPOINT rejection');
  }
}
async function privileges(database: string, role: string) {
  return session(database, async (tx) => {
    const functions = (
      await tx.query(
        `SELECT s AS signature FROM unnest($2::text[]) s WHERE has_function_privilege($1,to_regprocedure(s),'EXECUTE') ORDER BY s`,
        [
          role,
          [
            ...currentRuntimeV11RpcSignatures,
            ...currentRuntimeV11WorkerRpcSignatures,
            ...currentRuntimeV11OwnerOnlyFunctions,
          ],
        ],
      )
    ).rows.map((r) => String(r['signature']));
    const tables = (
      await tx.query(
        `SELECT t||':'||string_agg(p,',' ORDER BY p) AS grant FROM unnest($2::text[]) t
         CROSS JOIN unnest(ARRAY['DELETE','INSERT','REFERENCES','SELECT','TRIGGER','TRUNCATE','UPDATE']) p
         WHERE has_table_privilege($1,to_regclass('public.'||t),p) GROUP BY t ORDER BY t`,
        [role, [...currentRuntimeV11Tables]],
      )
    ).rows.map((r) => String(r['grant']));
    return { functions, tables };
  });
}
let createdFixed: string[] = [];
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, otherRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  for (const role of [worker, dispatcher]) {
    const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (exists.rowCount) continue;
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdFixed.push(role);
  }
  for (const database of [fresh, upgrade, normal, parent, staged]) {
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    databases.push(database);
    await migrate(url(database), 107);
  }
  await installCurrentRuntimeV11(url(fresh));
  await grantCurrentRuntimeAppBaselineV2(url(fresh), runtimeRole, 'core');
  for (const database of [upgrade, parent, staged]) {
    await installCurrentRuntimeV10(url(database));
    await grantCurrentRuntimeAppBaselineV2(url(database), runtimeRole, 'core');
    await grantCurrentRuntimeV10Profile(url(database), runtimeRole);
  }
  const raw148 = await readFile(
    new URL('../migrations/148_ai_execution_job_store.sql', import.meta.url),
    'utf8',
  );
  await session(staged, async (tx) => {
    await tx.query(raw148);
  });
}, 900000);
afterAll(async () => {
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of [...roles.reverse(), ...createdFixed])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  createdFixed = [];
  await admin.end();
}, 120000);

it('normal107, committed profile26 and raw-148 staging refuse every V11 grant without granting', async () => {
  for (const [database, code] of [
    [normal, 'CURRENT_RUNTIME_LEDGER_INVALID'],
    [parent, 'CURRENT_RUNTIME_V11_LEDGER_INVALID'],
    [staged, 'CURRENT_RUNTIME_V11_LEDGER_INVALID'],
  ] as const) {
    await expect(grantCurrentRuntimeV11Profile(url(database), runtimeRole)).rejects.toThrow(code);
    await expect(grantCurrentRuntimeV11GalleryWorker(url(database), worker)).rejects.toThrow(code);
    await expect(grantCurrentRuntimeV11AiDispatcher(url(database), dispatcher)).rejects.toThrow(
      code,
    );
  }
  const parentPrivileges = await privileges(parent, runtimeRole);
  expect(parentPrivileges.functions.filter((s) => s.includes('gallery'))).toEqual([]);
  expect((await privileges(staged, runtimeRole)).tables).toEqual([]);
}, 120000);
it('runtime grant gives exactly 51 RPCs and 6 table privileges; restore admission stays read_/require_/lock_', async () => {
  const result = await grantCurrentRuntimeV11Profile(url(fresh), runtimeRole);
  expect(result).toMatchObject({
    runtimeRole,
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
    installation: { profileVersion: 11, runtimeStep: 27, sourceDdlTip: 148 },
  });
  expect(await grantCurrentRuntimeV11Profile(url(fresh), runtimeRole)).toEqual(result);
  const held = await privileges(fresh, runtimeRole);
  expect(held.functions).toEqual([...currentRuntimeV11RpcSignatures].sort());
  expect(held.tables).toEqual([
    'ai_execution_job:INSERT,SELECT',
    'ai_execution_job_disposition:SELECT',
    'ai_synthetic_evidence_attestation:SELECT',
    'gallery_album:SELECT',
    'gallery_album_deletion:SELECT',
    'gallery_media_album_membership:SELECT',
    'gallery_media_course_association:SELECT',
  ]);
  await session(fresh, async (tx) => {
    expect(
      (
        await tx.query(
          `SELECT s, has_function_privilege($1,s,'EXECUTE') AS allowed FROM unnest($2::text[]) s ORDER BY s`,
          [
            runtimeRole,
            [
              'public.lock_restore_processing_shared()',
              'public.read_restore_processing_admission()',
              'public.require_restore_processing_admission()',
              'public.open_restore_processing_admission_window(bigint,uuid,uuid)',
              'public.admit_restore_processing_exact(bigint,uuid,uuid,uuid,text,text,text,jsonb,text,bigint)',
              'public.close_restore_processing_exact(bigint,uuid,uuid,uuid)',
              'public.assert_restore_processing_closed(bigint,uuid,uuid)',
              'public.restore_processing_admission_roster()',
            ],
          ],
        )
      ).rows.map((r) => [r['s'], r['allowed']]),
    ).toEqual([
      [
        'public.admit_restore_processing_exact(bigint,uuid,uuid,uuid,text,text,text,jsonb,text,bigint)',
        false,
      ],
      ['public.assert_restore_processing_closed(bigint,uuid,uuid)', false],
      ['public.close_restore_processing_exact(bigint,uuid,uuid,uuid)', false],
      ['public.lock_restore_processing_shared()', true],
      ['public.open_restore_processing_admission_window(bigint,uuid,uuid)', false],
      ['public.read_restore_processing_admission()', true],
      ['public.require_restore_processing_admission()', true],
      ['public.restore_processing_admission_roster()', false],
    ]);
    await tx.query('BEGIN');
    await verifyCurrentRuntimeV11InstalledIn(tx);
    await tx.query('ROLLBACK');
  });
  await session(
    fresh,
    async (tx) => {
      expect(await probeGalleryNavigationRuntimeV1In(tx)).toBe('available');
      expect(await probeGalleryRenditionRuntimeV1In(tx, 'api')).toBe('available');
      expect(await probeGalleryRenditionRuntimeV1In(tx, 'worker')).toBe('unavailable');
    },
    runtimeRole,
  );
}, 120000);
it('worker gets only the five worker RPCs; dispatcher only SELECT/INSERT on dispositions', async () => {
  const w = await grantCurrentRuntimeV11GalleryWorker(url(fresh), worker);
  expect(w.grantedFunctions).toEqual(currentRuntimeV11WorkerRpcSignatures);
  expect(await grantCurrentRuntimeV11GalleryWorker(url(fresh), worker)).toEqual(w);
  expect(await privileges(fresh, worker)).toEqual({
    functions: [...currentRuntimeV11WorkerRpcSignatures].sort(),
    tables: [],
  });
  const d = await grantCurrentRuntimeV11AiDispatcher(url(fresh), dispatcher);
  expect(d.grantedTables).toEqual([
    { table: 'ai_execution_job_disposition', privileges: ['SELECT', 'INSERT'] },
  ]);
  expect(await privileges(fresh, dispatcher)).toEqual({
    functions: [],
    tables: ['ai_execution_job_disposition:INSERT,SELECT'],
  });
  // All three principals coexist: re-granting any of them stays valid and disjoint.
  await grantCurrentRuntimeV11Profile(url(fresh), runtimeRole);
  expect((await privileges(fresh, runtimeRole)).functions).toEqual(
    [...currentRuntimeV11RpcSignatures].sort(),
  );
  await session(fresh, async (tx) => {
    await tx.query('BEGIN');
    await verifyCurrentRuntimeV11InstalledIn(tx);
    await tx.query('ROLLBACK');
  });
}, 120000);
it('overlapping or unsafe principals are refused and leave no grant behind', async () => {
  const cases: [string, string, (tx: PoolClient) => Promise<unknown>, string | RegExp][] = [
    [
      'runtime member of worker',
      `GRANT "${worker}" TO "${otherRole}"`,
      (tx) => grantCurrentRuntimeV11ProfileIn(tx, otherRole),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'worker member of runtime',
      `GRANT "${otherRole}" TO "${worker}"`,
      (tx) => grantCurrentRuntimeV11ProfileIn(tx, otherRole),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'worker with a member',
      `GRANT "${worker}" TO "${otherRole}"`,
      (tx) => grantCurrentRuntimeV11GalleryWorkerIn(tx, worker),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'worker holding a runtime RPC',
      `GRANT EXECUTE ON FUNCTION public.create_gallery_album_v1(jsonb,text) TO "${worker}"`,
      (tx) => grantCurrentRuntimeV11GalleryWorkerIn(tx, worker),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'worker holding a navigation read',
      `GRANT SELECT ON public.gallery_album TO "${worker}"`,
      (tx) => grantCurrentRuntimeV11GalleryWorkerIn(tx, worker),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'worker holding a parent table privilege',
      `GRANT SELECT ON public.gallery_media_item TO "${worker}"`,
      (tx) => grantCurrentRuntimeV11GalleryWorkerIn(tx, worker),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'runtime holding a worker RPC',
      `GRANT EXECUTE ON FUNCTION public.claim_gallery_rendition_v1(uuid,integer) TO "${otherRole}"`,
      (tx) => grantCurrentRuntimeV11ProfileIn(tx, otherRole),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'runtime writing dispositions',
      `GRANT INSERT ON public.ai_execution_job_disposition TO "${otherRole}"`,
      (tx) => grantCurrentRuntimeV11ProfileIn(tx, otherRole),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'runtime writing attestations',
      `GRANT INSERT ON public.ai_synthetic_evidence_attestation TO "${otherRole}"`,
      (tx) => grantCurrentRuntimeV11ProfileIn(tx, otherRole),
      /CURRENT_RUNTIME_V11_(UNSAFE_ROLE|STRUCTURE_DRIFT)/,
    ],
    [
      'runtime reading rendition jobs',
      `GRANT SELECT ON public.gallery_rendition_job TO "${otherRole}"`,
      (tx) => grantCurrentRuntimeV11ProfileIn(tx, otherRole),
      /CURRENT_RUNTIME_V11_(UNSAFE_ROLE|STRUCTURE_DRIFT)/,
    ],
    [
      'dispatcher holding a worker RPC',
      `GRANT EXECUTE ON FUNCTION public.settle_gallery_rendition_v1(text,uuid,uuid,jsonb) TO "${dispatcher}"`,
      (tx) => grantCurrentRuntimeV11AiDispatcherIn(tx, dispatcher),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'dispatcher holding jobs',
      `GRANT SELECT ON public.ai_execution_job TO "${dispatcher}"`,
      (tx) => grantCurrentRuntimeV11AiDispatcherIn(tx, dispatcher),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'runtime named as the worker',
      'SELECT 1',
      (tx) => grantCurrentRuntimeV11ProfileIn(tx, worker),
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    ],
    [
      'worker grant to another name',
      'SELECT 1',
      (tx) => grantCurrentRuntimeV11GalleryWorkerIn(tx, otherRole),
      'CURRENT_RUNTIME_V11_INVALID_ROLE',
    ],
    [
      'dispatcher grant to the runtime',
      'SELECT 1',
      (tx) => grantCurrentRuntimeV11AiDispatcherIn(tx, runtimeRole),
      'CURRENT_RUNTIME_V11_INVALID_ROLE',
    ],
  ];
  for (const [label, setup, run, code] of cases)
    await rollback(fresh, async (tx) => {
      // Object grants run in the rolled-back owner transaction; role membership (a shared
      // catalog the plain owner cannot change) is granted by the admin and revoked after.
      const membership = setup.startsWith('GRANT "');
      if (membership) await admin.query(setup);
      try {
        if (!membership) await tx.query(setup);
        await rejected(tx, () => run(tx), code);
      } finally {
        if (membership) await admin.query(setup.replace(/^GRANT (\S+) TO/, 'REVOKE $1 FROM'));
      }
      expect([
        label,
        (
          await tx.query(
            "SELECT has_function_privilege($1,'public.create_gallery_album_v1(jsonb,text)','EXECUTE') AS v",
            [otherRole],
          )
        ).rows[0]?.['v'],
      ]).toEqual([label, false]);
    });
  await admin.query(`ALTER ROLE "${otherRole}" CREATEDB`);
  try {
    await expect(grantCurrentRuntimeV11Profile(url(fresh), otherRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V11_UNSAFE_ROLE',
    );
  } finally {
    await admin.query(`ALTER ROLE "${otherRole}" NOCREATEDB`);
  }
}, 300000);
it('committed profile26 runtime upgrades: V10 grant refuses profile27, V11 grant succeeds', async () => {
  await installCurrentRuntimeV11(url(upgrade));
  await expect(grantCurrentRuntimeV10Profile(url(upgrade), runtimeRole)).rejects.toThrow(
    'CURRENT_RUNTIME_V10_LEDGER_INVALID',
  );
  await grantCurrentRuntimeV11Profile(url(upgrade), runtimeRole);
  expect(await privileges(upgrade, runtimeRole)).toEqual(await privileges(fresh, runtimeRole));
}, 300000);
