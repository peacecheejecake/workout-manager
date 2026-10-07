import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { migrate, grantCorePlanning, grantOperations, grantRaces } from '../src/migrate.js';
import {
  installCurrentRuntime,
  verifyCurrentRuntimeInstalledIn,
  currentRuntimeMigrationMembers,
} from '../src/current-runtime-installation.js';
import { createDatabase } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real installation evidence only after Root runs this file. Base107 uses the
// historical installer; runtime17 members use the new distinct applied ledger.
// No restore target transform, owner health-row seed, runtime RPC grant or remote call.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  ownerRole = `runtime_install_owner_${suffix}`,
  runtimeRole = `runtime_install_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl }),
  roles: string[] = [],
  databases: string[] = [];
function url(name: string, role = ownerRole) {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${name}`;
  parsed.username = role;
  parsed.password = 'isolated';
  return parsed.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
});
afterAll(async () => {
  for (const name of databases.reverse()) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function base() {
  const name = `runtime_install_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  databases.push(name);
  await migrate(url(name), 107);
  return name;
}
async function withOwner<T>(name: string, run: (pool: Pool) => Promise<T>) {
  const pool = new Pool({ connectionString: url(name), max: 1 });
  try {
    return await run(pool);
  } finally {
    await pool.end();
  }
}
async function facts(name: string) {
  return withOwner(name, async (pool) => {
    const registry = await pool.query(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    );
    const profile =
      await pool.query(`SELECT to_regclass('wm_runtime_installation.migration') IS NOT NULL AS ledger,
 to_regclass('public.manual_race_evidence_v2') IS NOT NULL AS chain,
 EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('wm_current_app_load','wm_current_original_postimages','wm_identity_target_load')) AS target`);
    return { registry: registry.rows, profile: profile.rows };
  });
}
it('fresh107 applies17 exact actual artifacts, preserves107 registry and excludes target-only schemas/privileges', async () => {
  const name = await base(),
    before = await facts(name),
    result = await installCurrentRuntime(url(name));
  expect(result).toMatchObject({
    profileVersion: 1,
    baselineSchemaVersion: 107,
    runtimeStep: 17,
    sourceDdlTip: 127,
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
  });
  const after = await facts(name);
  expect(after.registry).toEqual(before.registry);
  expect(after.profile).toEqual([{ ledger: true, chain: true, target: false }]);
  await withOwner(name, async (pool) => {
    expect(await verifyCurrentRuntimeInstalledIn(pool)).toEqual(result);
    const rows = await pool.query(
      'SELECT step,source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256 FROM wm_runtime_installation.migration ORDER BY step',
    );
    expect(rows.rows).toEqual(currentRuntimeMigrationMembers);
    const permission = await pool.query(
      `SELECT has_schema_privilege($1,'wm_runtime_installation','USAGE') AS usage,
   has_table_privilege($1,'wm_runtime_installation.migration','SELECT,INSERT,UPDATE,DELETE') AS access,
   to_regprocedure('public.read_race_manual_public_preview_source_v1(uuid)') IS NOT NULL AS preview,
   to_regprocedure('public.save_check_in_template_v1(jsonb)') IS NOT NULL AS template`,
      [runtimeRole],
    );
    expect(permission.rows).toEqual([
      { usage: false, access: false, preview: true, template: true },
    ]);
  });
});
it('populated107 public consent/race survive installation without new event/history/receipt', async () => {
  const name = await base();
  for (const grant of [grantCorePlanning, grantOperations, grantRaces])
    await grant(url(name), runtimeRole);
  const database = createDatabase({ connectionString: url(name, runtimeRole) }),
    athlete = randomUUID();
  try {
    await createConsentRepository(database).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const repo = createRaceRepository(database),
      event = await repo.createRaceEvent(athlete, {
        idempotencyKey: randomUUID(),
        values: {
          title: 'Synthetic installation record',
          localDate: '2026-10-08',
          localStartTime: null,
          timezone: 'UTC',
          locationName: null,
          distance: { kind: 'standard', class: '10k' },
          priority: null,
          participation: 'registered',
          officialUrl: null,
          course: null,
          targetSeconds: null,
          planVersionId: null,
        },
      });
    const retainedEvent = await repo.getRaceEvent(athlete, event.id);
    expect(retainedEvent).toMatchObject(event);
    const previous = await withOwner(
      name,
      async (pool) =>
        (
          await pool.query(
            'SELECT (SELECT count(*) FROM race_event_revision)::int AS revisions,(SELECT count(*) FROM race_command_receipt)::int AS receipts',
          )
        ).rows,
    );
    await installCurrentRuntime(url(name));
    expect(await repo.getRaceEvent(athlete, event.id)).toEqual(retainedEvent);
    expect(
      await withOwner(
        name,
        async (pool) =>
          (
            await pool.query(
              'SELECT (SELECT count(*) FROM race_event_revision)::int AS revisions,(SELECT count(*) FROM race_command_receipt)::int AS receipts',
            )
          ).rows,
      ),
    ).toEqual(previous);
  } finally {
    await database.close();
  }
});
it('two installer connections serialize and repeat returns exact original profile/no extra ledger', async () => {
  const name = await base(),
    results = await Promise.all([
      installCurrentRuntime(url(name)),
      installCurrentRuntime(url(name)),
    ]);
  expect(results[0]).toEqual(results[1]);
  expect(await installCurrentRuntime(url(name))).toEqual(results[0]);
  await withOwner(name, async (pool) => {
    const row = await pool.query(
      'SELECT count(*)::int AS count,count(DISTINCT source_ddl_id)::int AS sources FROM wm_runtime_installation.migration',
    );
    expect(row.rows).toEqual([{ count: 17, sources: 17 }]);
  });
});
it('actual121 predecessor failure rolls back prior runtime DDL and ledger; base107 unchanged', async () => {
  const name = await base(),
    before = await facts(name);
  await withOwner(name, (pool) =>
    pool.query(
      'ALTER TABLE routine_occurrence DROP CONSTRAINT routine_occurrence_athlete_id_schedule_id_anchor_key_key',
    ),
  );
  await expect(installCurrentRuntime(url(name))).rejects.toThrow(
    'ROUTINE_OCCURRENCE_MIGRATION_PREDECESSOR_REQUIRED',
  );
  expect(await facts(name)).toEqual(before);
});
it('unregistered actualraw108 cannot be automatically adopted or given an applied acknowledgement', async () => {
  const name = await base();
  await withOwner(name, async (pool) =>
    pool.query(
      await readFile(
        new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
        'utf8',
      ),
    ),
  );
  await expect(installCurrentRuntime(url(name))).rejects.toThrow(
    'CURRENT_RUNTIME_UNREGISTERED_STAGE',
  );
  const after = await facts(name);
  expect(after.registry).toHaveLength(107);
  expect(after.profile).toEqual([{ ledger: false, chain: false, target: false }]);
});
it('base checksum drift and nonowner runtime reject before new ledger or source apply', async () => {
  const name = await base();
  await expect(installCurrentRuntime(url(name, runtimeRole))).rejects.toThrow(
    'CURRENT_RUNTIME_OWNER_REQUIRED',
  );
  await withOwner(name, (pool) =>
    pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=1', ['0'.repeat(64)]),
  );
  await expect(installCurrentRuntime(url(name))).rejects.toThrow('CURRENT_RUNTIME_BASE_MISMATCH');
  expect((await facts(name)).profile).toEqual([{ ledger: false, chain: false, target: false }]);
});
it('missing/changed applied ledger tuples fail closed; read verifier installs nothing', async () => {
  const name = await base();
  await expect(withOwner(name, (pool) => verifyCurrentRuntimeInstalledIn(pool))).rejects.toThrow(
    'LEDGER_INVALID',
  );
  await installCurrentRuntime(url(name));
  await withOwner(name, (pool) =>
    pool.query('UPDATE wm_runtime_installation.migration SET source_sha256=$1 WHERE step=3', [
      '0'.repeat(64),
    ]),
  );
  await expect(installCurrentRuntime(url(name))).rejects.toThrow('LEDGER_INVALID');
  await withOwner(name, (pool) =>
    pool.query('DELETE FROM wm_runtime_installation.migration WHERE step=2'),
  );
  await expect(withOwner(name, (pool) => verifyCurrentRuntimeInstalledIn(pool))).rejects.toThrow(
    'LEDGER_INVALID',
  );
});
it('target-transform namespace and delegated ledger read block product profile verification', async () => {
  const name = await base();
  await installCurrentRuntime(url(name));
  await withOwner(name, (pool) => pool.query('CREATE SCHEMA wm_current_app_load'));
  await expect(installCurrentRuntime(url(name))).rejects.toThrow('TARGET_TRANSFORM_PRESENT');
  await withOwner(name, async (pool) => {
    await pool.query('DROP SCHEMA wm_current_app_load');
    await pool.query(`GRANT SELECT ON wm_runtime_installation.migration TO "${runtimeRole}"`);
  });
  await expect(withOwner(name, (pool) => verifyCurrentRuntimeInstalledIn(pool))).rejects.toThrow(
    'LEDGER_INVALID',
  );
});
