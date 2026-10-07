import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntime } from '../src/current-runtime-installation.js';
import { grantCurrentRuntimeProfile } from '../src/current-runtime-grants.js';
import {
  probeCurrentRuntimeSupportIn,
  currentRuntimeSupportMissingClosure,
} from '../src/current-runtime-support.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root executes this real-PG fixture. No health/account/source data seed, source
// RPC execution or restore operation. Metadata mutation is isolated and restored.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ownerRole = `current_runtime_support_owner_${suffix}`;
const runtimeRole = `current_runtime_support_app_${suffix}`;
const name = `current_runtime_support_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [],
  databases: string[] = [];
function url(database: string, role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${database}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function withRole<T>(database: string, role: string, apply: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url(database, role), max: 1 });
  try {
    return await apply(pool);
  } finally {
    await pool.end();
  }
}
async function base(database: string) {
  await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
  databases.push(database);
  await migrate(url(database, ownerRole), 107);
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await base(name);
}, 120000);
afterAll(async () => {
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function runtimeProbe(database = name) {
  return withRole(database, runtimeRole, async (pool) => {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN READ ONLY');
      await tx.query("SET LOCAL statement_timeout='5000ms'");
      const output = await probeCurrentRuntimeSupportIn(tx);
      await tx.query('COMMIT');
      return output;
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
}
async function mutate(sql: string, undo: string, check: () => Promise<void>) {
  // Runtime uses its own session: SET ROLE in the owner connection would not
  // prove the current_user/session_user runtime identity enforced by the probe.
  await withRole(name, ownerRole, (pool) => pool.query(sql));
  try {
    await check();
  } finally {
    await withRole(name, ownerRole, (pool) => pool.query(undo));
  }
}
it('actual plain runtime sees baseline107 artifacts absent and never claims checksum/profile support', async () => {
  expect(await runtimeProbe()).toMatchObject({
    state: 'unsupported',
    reason: 'current_artifacts_absent',
    rootEvidence: 'absent',
    supported: false,
    catalogSecurity: 'not_verified',
  });
});
it('actual unreceipted raw108 partial installation is incompatible, not absent/fallback', async () => {
  const partial = `current_runtime_support_partial_${suffix}`;
  await base(partial);
  await withRole(partial, ownerRole, async (pool) =>
    pool.query(
      await readFile(
        new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
        'utf8',
      ),
    ),
  );
  expect(await runtimeProbe(partial)).toMatchObject({
    state: 'incompatible',
    reason: 'partial_installation',
    supported: false,
  });
}, 120000);
it('installed17 plus exact26 grants yields verified roots but explicit incomplete closure, without private ledger read', async () => {
  await installCurrentRuntime(url(name, ownerRole));
  await grantCurrentRuntimeProfile(url(name, ownerRole), runtimeRole);
  await withRole(name, ownerRole, async (pool) => {
    // Existing normal public schema USAGE; not a private metadata/table grant.
    expect(
      (
        await pool.query("SELECT has_schema_privilege($1,'public','USAGE') AS allowed", [
          runtimeRole,
        ])
      ).rows[0]?.['allowed'],
    ).toBe(true);
  });
  expect(await runtimeProbe()).toEqual({
    state: 'incompatible',
    reason: 'required_closure_not_verified',
    rootEvidence: 'verified',
    supported: false,
    missingClosure: [...currentRuntimeSupportMissingClosure],
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
    processingAuthority: 'none',
  });
  await withRole(name, runtimeRole, async (pool) => {
    await expect(
      pool.query('SELECT * FROM wm_runtime_installation.migration'),
    ).rejects.toMatchObject({ code: '42501' });
  });
}, 120000);
it('revoked current EXECUTE is detected despite exact roots and unchanged installer ledger', async () => {
  await mutate(
    `REVOKE EXECUTE ON FUNCTION public.save_check_in_template_v1(jsonb) FROM "${runtimeRole}"`,
    `GRANT EXECUTE ON FUNCTION public.save_check_in_template_v1(jsonb) TO "${runtimeRole}"`,
    async () => {
      expect(await runtimeProbe()).toMatchObject({
        reason: 'root_privilege_missing',
        rootEvidence: 'not_verified',
        supported: false,
      });
    },
  );
  expect((await runtimeProbe()).rootEvidence).toBe('verified');
});
it('actual root prosrc drift is detected and original definition restored with no source data mutation', async () => {
  const original = await withRole(name, ownerRole, async (pool) =>
    z
      .string()
      .parse(
        (
          await pool.query(
            "SELECT pg_get_functiondef('public.read_manual_race_chain_v2(uuid)'::regprocedure) AS definition",
          )
        ).rows[0]?.['definition'],
      ),
  );
  const changed = original.replace('BEGIN', 'BEGIN /* isolated metadata negative */');
  expect(changed).not.toBe(original);
  await mutate(changed, original, async () => {
    expect(await runtimeProbe()).toMatchObject({
      state: 'incompatible',
      reason: 'root_metadata_mismatch',
      supported: false,
    });
  });
  expect((await runtimeProbe()).rootEvidence).toBe('verified');
});
it('private ledger SELECT or schema USAGE privileges fail closed without the probe selecting its rows', async () => {
  for (const [grant, revoke] of [
    [
      `GRANT SELECT ON wm_runtime_installation.migration TO "${runtimeRole}"`,
      `REVOKE SELECT ON wm_runtime_installation.migration FROM "${runtimeRole}"`,
    ],
    [
      `GRANT USAGE ON SCHEMA wm_runtime_installation TO "${runtimeRole}"`,
      `REVOKE USAGE ON SCHEMA wm_runtime_installation FROM "${runtimeRole}"`,
    ],
  ]) {
    if (!grant || !revoke) throw new Error('fixture tuple');
    await mutate(grant, revoke, async () => {
      expect(await runtimeProbe()).toMatchObject({
        reason: 'private_ledger_access',
        supported: false,
      });
    });
  }
});
it('genuine current owner membership and owner session are unsafe, not installation witnesses', async () => {
  await admin.query(`GRANT "${ownerRole}" TO "${runtimeRole}"`);
  try {
    expect(await runtimeProbe()).toMatchObject({ reason: 'runtime_role_unsafe', supported: false });
  } finally {
    await admin.query(`REVOKE "${ownerRole}" FROM "${runtimeRole}"`);
  }
  expect(await withRole(name, ownerRole, probeCurrentRuntimeSupportIn)).toMatchObject({
    reason: 'runtime_role_unsafe',
    supported: false,
  });
});
it('actual missing RPC remains partial installation and does not retry an older SQL protocol', async () => {
  await mutate(
    'ALTER FUNCTION public.save_check_in_template_v1(jsonb) RENAME TO isolated_displaced_template',
    'ALTER FUNCTION public.isolated_displaced_template(jsonb) RENAME TO save_check_in_template_v1',
    async () => {
      expect(await runtimeProbe()).toMatchObject({
        reason: 'partial_installation',
        supported: false,
      });
    },
  );
});
it('malformed actual SQL response and aborted runtime query return sanitized unavailable with no fallback', async () => {
  await withRole(name, runtimeRole, async (pool) => {
    // Controlled response-port corruption, not a claimed PostgreSQL catalog
    // defect or source ownership observation. The values originate in real SQL.
    expect(
      await probeCurrentRuntimeSupportIn({
        query: () => pool.query("SELECT '{}'::jsonb AS roots"),
      }),
    ).toMatchObject({ reason: 'catalog_evidence_invalid', state: 'unavailable', supported: false });
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN READ ONLY');
      await expect(
        tx.query('SELECT * FROM wm_runtime_installation.migration'),
      ).rejects.toMatchObject({ code: '42501' });
      const output = await probeCurrentRuntimeSupportIn(tx);
      expect(output).toMatchObject({
        reason: 'catalog_query_failed',
        state: 'unavailable',
        supported: false,
      });
      expect(JSON.stringify(output)).not.toContain(ownerRole);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('unvalidated transitive FORCE RLS drift still cannot become support or be mislabeled as detected closure', async () => {
  await mutate(
    'ALTER TABLE public.check_in_template_version NO FORCE ROW LEVEL SECURITY',
    'ALTER TABLE public.check_in_template_version FORCE ROW LEVEL SECURITY',
    async () => {
      expect(await runtimeProbe()).toMatchObject({
        reason: 'required_closure_not_verified',
        rootEvidence: 'verified',
        supported: false,
      });
    },
  );
});
