import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV6 } from '../src/current-runtime-installation-v6.js';
import { grantCurrentRuntimeAppBaselineV1 } from '../src/current-runtime-app-grants-v1.js';
import {
  grantCurrentRuntimeAppBaselineV2,
  currentRuntimeAppGarminConnectionColumnsV2,
} from '../src/current-runtime-app-grants-v2.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root-only actual PG. Synthetic not_connected rows test column ACL/RLS only:
// no provider credentials, health data, collection or processing truth is seeded.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `current_app_grants_v2_${suffix}`;
const ownerRole = `current_app_grants_v2_owner_${suffix}`;
const coreRole = `current_app_grants_v2_core_${suffix}`;
const legacyRole = `current_app_grants_v2_legacy_${suffix}`;
const optionalRole = `current_app_grants_v2_optional_${suffix}`;
const memberRole = `current_app_grants_v2_member_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const roles: string[] = [];
let created = false;
const tenants = ['synthetic_core_own', 'synthetic_core_foreign'] as const;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${databaseName}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function owned<T>(operation: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}
async function scoped<T>(role: string, tenant: string, operation: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url(role), max: 1 });
  try {
    await pool.query('BEGIN');
    await pool.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
    return await operation(pool);
  } finally {
    await pool.query('ROLLBACK');
    await pool.end();
  }
}
beforeAll(async () => {
  for (const role of [ownerRole, coreRole, legacyRole, optionalRole, memberRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  await installCurrentRuntimeV6(url(ownerRole));
  await grantCurrentRuntimeAppBaselineV1(url(ownerRole), legacyRole);
  await grantCurrentRuntimeAppBaselineV2(url(ownerRole), coreRole);
  await grantCurrentRuntimeAppBaselineV2(url(ownerRole), optionalRole, 'garmin-unofficial');
  // Only synthetic disconnected metadata is committed here. Negative access
  // checks below retain their separate rollback-only transaction helper.
  for (const tenant of tenants) {
    await owned(async (pool) => {
      await pool.query('BEGIN');
      try {
        await pool.query("SELECT set_config('app.athlete_id',$1,true)", [tenant]);
        await pool.query('INSERT INTO public.garmin_unofficial_connection(athlete_id) VALUES($1)', [
          tenant,
        ]);
        await pool.query('COMMIT');
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    });
    await scoped(ownerRole, tenant, async (pool) => {
      expect(
        (
          await pool.query(
            'SELECT athlete_id FROM public.garmin_unofficial_connection WHERE athlete_id=$1',
            [tenant],
          )
        ).rows,
      ).toEqual([{ athlete_id: tenant }]);
    });
  }
}, 180000);
afterAll(async () => {
  if (created) await dropIsolatedDatabase(admin, databaseName);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
it('legacy V1 lacks connection metadata access; version2 adds only five exact column rights', async () => {
  await expect(
    scoped(legacyRole, tenants[0], (pool) =>
      pool.query(
        'SELECT session_generation,state,schedule_enabled,schedule_paused FROM public.garmin_unofficial_connection WHERE athlete_id=$1',
        [tenants[0]],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await owned(async (pool) => {
    const rows = (
      await pool.query(
        `SELECT a.attname,has_column_privilege($1,c.oid,a.attnum,'SELECT') allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relname='garmin_unofficial_connection' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [coreRole],
      )
    ).rows;
    expect(
      rows
        .filter((r) => r['allowed'])
        .map((r) => r['attname'])
        .sort(),
    ).toEqual([...currentRuntimeAppGarminConnectionColumnsV2].sort());
    expect(
      (
        await pool.query(
          `SELECT has_table_privilege($1,'public.garmin_unofficial_connection','SELECT') full_read,has_table_privilege($1,'public.garmin_unofficial_connection','INSERT,UPDATE,DELETE,TRUNCATE') write,has_table_privilege($1,'public.garmin_unofficial_run','SELECT,INSERT,UPDATE,DELETE') run_access`,
          [coreRole],
        )
      ).rows,
    ).toEqual([{ full_read: false, write: false, run_access: false }]);
  });
});
it('executes the actual nested-source metadata projection with zero preserved and tenant RLS', async () => {
  await scoped(coreRole, tenants[0], async (pool) => {
    expect(
      (
        await pool.query(
          'SELECT session_generation,state,schedule_enabled,schedule_paused FROM public.garmin_unofficial_connection WHERE athlete_id=$1',
          [tenants[0]],
        )
      ).rows,
    ).toEqual([
      {
        session_generation: 0,
        state: 'not_connected',
        schedule_enabled: false,
        schedule_paused: false,
      },
    ]);
    expect(
      (
        await pool.query(
          'SELECT athlete_id FROM public.garmin_unofficial_connection ORDER BY athlete_id',
        )
      ).rows,
    ).toEqual([{ athlete_id: tenants[0] }]);
    expect(
      (
        await pool.query(
          'SELECT session_generation,state,schedule_enabled,schedule_paused FROM public.garmin_unofficial_connection WHERE athlete_id=$1',
          [tenants[1]],
        )
      ).rows,
    ).toEqual([]);
  });
  await scoped(coreRole, '', async (pool) => {
    expect(
      (await pool.query('SELECT athlete_id FROM public.garmin_unofficial_connection')).rows,
    ).toEqual([]);
  });
});
it.each([
  'SELECT * FROM public.garmin_unofficial_connection',
  'SELECT encrypted_session FROM public.garmin_unofficial_connection',
  'SELECT profile_hash FROM public.garmin_unofficial_connection',
  'SELECT login_attempts FROM public.garmin_unofficial_connection',
  'SELECT lease_id FROM public.garmin_unofficial_connection',
  'SELECT athlete_id FROM public.garmin_unofficial_run',
])('core denies non-projection access: %s', async (sql) => {
  await expect(scoped(coreRole, tenants[0], (pool) => pool.query(sql))).rejects.toMatchObject({
    code: '42501',
  });
});
it.each([
  "INSERT INTO public.garmin_unofficial_connection(athlete_id) VALUES('synthetic_forbidden')",
  'UPDATE public.garmin_unofficial_connection SET schedule_paused=true',
  'DELETE FROM public.garmin_unofficial_connection',
])('core denies mutation: %s', async (sql) => {
  await expect(scoped(coreRole, tenants[0], (pool) => pool.query(sql))).rejects.toMatchObject({
    code: '42501',
  });
});
it('optional collector keeps explicit V1 DML but grants no owner membership', async () => {
  await owned(async (pool) => {
    expect(
      (
        await pool.query(
          `SELECT has_table_privilege($1,'public.garmin_unofficial_connection','SELECT') full_read,has_table_privilege($1,'public.garmin_unofficial_connection','INSERT') i,has_table_privilege($1,'public.garmin_unofficial_connection','UPDATE') u,has_table_privilege($1,'public.garmin_unofficial_connection','DELETE') d,has_table_privilege($1,'public.garmin_unofficial_run','INSERT') run_write,pg_has_role($1,$2,'MEMBER') owner_member`,
          [optionalRole, ownerRole],
        )
      ).rows,
    ).toEqual([
      { full_read: true, i: true, u: true, d: true, run_write: true, owner_member: false },
    ]);
  });
});
it('repeat version2 preserves append-only planning and no fixture/private RPC privileges', async () => {
  expect(await grantCurrentRuntimeAppBaselineV2(url(ownerRole), coreRole)).toMatchObject({
    recipeVersion: 2,
    recipe: 'configured-app-baseline-v2',
    deployment: 'core',
    supported: false,
    processingAuthority: 'none',
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
    atomicity: 'separate_existing_grant_transactions',
  });
  await owned(async (pool) => {
    expect(
      (
        await pool.query(
          `SELECT has_table_privilege($1,'public.plan_snapshot','SELECT') s,has_table_privilege($1,'public.plan_snapshot','INSERT') i,has_table_privilege($1,'public.plan_snapshot','UPDATE,DELETE') excessive,has_table_privilege($1,'public.plan_history','UPDATE,DELETE') history_excessive,has_table_privilege($1,'public.coaching_analysis_output','INSERT') fixture_insert,has_function_privilege($1,'public.read_manual_race_retained_source_batch_v1(integer)','EXECUTE') new_rpc`,
          [coreRole],
        )
      ).rows,
    ).toEqual([
      {
        s: true,
        i: true,
        excessive: false,
        history_excessive: false,
        fixture_insert: false,
        new_rpc: false,
      },
    ]);
  });
}, 60000);
it('original safety guard rejects owner, owner-member and elevated role before V2 addition', async () => {
  await expect(grantCurrentRuntimeAppBaselineV2(url(ownerRole), ownerRole)).rejects.toThrow(
    'APP_GRANT_UNSAFE_PRINCIPAL',
  );
  await admin.query(`GRANT "${ownerRole}" TO "${memberRole}"`);
  try {
    await expect(grantCurrentRuntimeAppBaselineV2(url(ownerRole), memberRole)).rejects.toThrow(
      'APP_GRANT_UNSAFE_PRINCIPAL',
    );
  } finally {
    await admin.query(`REVOKE "${ownerRole}" FROM "${memberRole}"`);
  }
  await admin.query(`ALTER ROLE "${memberRole}" CREATEDB`);
  try {
    await expect(grantCurrentRuntimeAppBaselineV2(url(ownerRole), memberRole)).rejects.toThrow(
      'APP_GRANT_UNSAFE_PRINCIPAL',
    );
  } finally {
    await admin.query(`ALTER ROLE "${memberRole}" NOCREATEDB`);
  }
  await owned(async (pool) => {
    expect(
      (
        await pool.query(
          `SELECT has_column_privilege($1,'public.garmin_unofficial_connection','state','SELECT') leaked`,
          [memberRole],
        )
      ).rows,
    ).toEqual([{ leaked: false }]);
  });
});
it('unknown recipe/deployment remains invalid before any V2 composition', async () => {
  await expect(
    grantCurrentRuntimeAppBaselineV2(url(ownerRole), memberRole, {
      recipeVersion: 2,
      columns: ['encrypted_session'],
    }),
  ).rejects.toThrow('APP_GRANT_INVALID_INPUT');
});
