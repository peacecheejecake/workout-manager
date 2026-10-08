import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV5 } from '../src/current-runtime-installation-v5.js';
import {
  currentRuntimeAppActivityRelationsV1,
  grantCurrentRuntimeAppBaselineV1,
} from '../src/current-runtime-app-grants-v1.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root executes real PG. ACL provisioning evidence only; no processing consent,
// provider collection, health row seed or full catalog support is asserted.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `current_app_grants_${suffix}`;
const ownerRole = `current_app_grants_owner_${suffix}`;
const runtimeRole = `current_app_grants_app_${suffix}`;
const memberRole = `current_app_grants_member_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const roles: string[] = [];
let created = false;
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
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, memberRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  await installCurrentRuntimeV5(url(ownerRole));
}, 120000);
afterAll(async () => {
  if (created) await dropIsolatedDatabase(admin, databaseName);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
it('provisions named baseline on installed21 without activating current RPC or private source rights', async () => {
  const result = await grantCurrentRuntimeAppBaselineV1(url(ownerRole), runtimeRole);
  expect(result).toMatchObject({
    deployment: 'core',
    supported: false,
    catalogSecurity: 'not_verified',
    processingAuthority: 'none',
  });
  await owned(async (pool) => {
    const response = await pool.query(
      `SELECT
      has_table_privilege($1,'public.plan_snapshot','SELECT') snapshot_select,
      has_table_privilege($1,'public.plan_snapshot','INSERT') snapshot_insert,
      has_table_privilege($1,'public.plan_snapshot','UPDATE,DELETE,TRUNCATE') snapshot_mutation,
      has_table_privilege($1,'public.plan_history','SELECT') history_select,
      has_table_privilege($1,'public.plan_history','INSERT') history_insert,
      has_table_privilege($1,'public.plan_history','UPDATE,DELETE,TRUNCATE') history_mutation,
      has_function_privilege($1,'public.finish_race_manual_public_review_v1(text,jsonb,uuid)','EXECUTE') current_rpc,
      has_function_privilege($1,'public.manual_source_personal_row_exists_v1(jsonb,jsonb)','EXECUTE') private_helper,
      has_table_privilege($1,'public.manual_race_evidence_v2','SELECT,INSERT,UPDATE,DELETE') private_chain,
      has_table_privilege($1,'public.coaching_analysis_output','INSERT') fixture_insert`,
      [runtimeRole],
    );
    expect(response.rows).toEqual([
      {
        snapshot_select: true,
        snapshot_insert: true,
        snapshot_mutation: false,
        history_select: true,
        history_insert: true,
        history_mutation: false,
        current_rpc: false,
        private_helper: false,
        private_chain: false,
        fixture_insert: false,
      },
    ]);
    const activity = await pool.query(
      `SELECT name,has_table_privilege($1,'public.'||name,'SELECT') s,has_table_privilege($1,'public.'||name,'INSERT') i,has_table_privilege($1,'public.'||name,'UPDATE') u,has_table_privilege($1,'public.'||name,'DELETE') d FROM unnest($2::text[]) name`,
      [runtimeRole, [...currentRuntimeAppActivityRelationsV1]],
    );
    expect(activity.rows).toEqual(
      currentRuntimeAppActivityRelationsV1.map((name) => ({
        name,
        s: true,
        i: true,
        u: true,
        d: true,
      })),
    );
  });
}, 60000);
it('default retained provenance is SELECT only, while optional collector grants are explicit', async () => {
  await owned(async (pool) => {
    const before = await pool.query(
      `SELECT has_table_privilege($1,'public.garmin_activity_ledger','SELECT') retained_read,has_table_privilege($1,'public.garmin_activity_ledger','INSERT,UPDATE,DELETE') collector_write`,
      [runtimeRole],
    );
    expect(before.rows).toEqual([{ retained_read: true, collector_write: false }]);
  });
  await grantCurrentRuntimeAppBaselineV1(url(ownerRole), runtimeRole, 'garmin-unofficial');
  await owned(async (pool) => {
    const after = await pool.query(
      `SELECT has_table_privilege($1,'public.garmin_activity_ledger','INSERT') collector_insert,pg_has_role($1,$2,'MEMBER') owner_member`,
      [runtimeRole, ownerRole],
    );
    expect(after.rows).toEqual([{ collector_insert: true, owner_member: false }]);
  });
}, 60000);
it('repeated recipe preserves append-only rights and is not a privilege repair or admission', async () => {
  const result = await grantCurrentRuntimeAppBaselineV1(url(ownerRole), runtimeRole);
  expect(result.supported).toBe(false);
  await owned(async (pool) => {
    const row = await pool.query(
      `SELECT has_table_privilege($1,'public.plan_snapshot','UPDATE,DELETE') excessive,has_table_privilege($1,'public.plan_history','UPDATE,DELETE') history_excessive`,
      [runtimeRole],
    );
    expect(row.rows).toEqual([{ excessive: false, history_excessive: false }]);
  });
}, 60000);
it('owner and owner-member principals are rejected before provisioning', async () => {
  await expect(grantCurrentRuntimeAppBaselineV1(url(ownerRole), ownerRole)).rejects.toThrow(
    'APP_GRANT_UNSAFE_PRINCIPAL',
  );
  await admin.query(`GRANT "${ownerRole}" TO "${memberRole}"`);
  try {
    await expect(grantCurrentRuntimeAppBaselineV1(url(ownerRole), memberRole)).rejects.toThrow(
      'APP_GRANT_UNSAFE_PRINCIPAL',
    );
  } finally {
    await admin.query(`REVOKE "${ownerRole}" FROM "${memberRole}"`);
  }
});
it('unknown deployment cannot use a runtime connection to provision rights', async () => {
  await expect(
    grantCurrentRuntimeAppBaselineV1(url(runtimeRole), runtimeRole, { supported: true }),
  ).rejects.toThrow('APP_GRANT_INVALID_INPUT');
});
