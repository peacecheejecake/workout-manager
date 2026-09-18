import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import {
  grantOperations,
  grantRecoveryCore,
  grantRoutineCore,
  grantStretchingCore,
  migrate,
} from '../src/migrate.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');

const appendOnly = [
  'routine_blueprint_version',
  'routine_schedule_version',
  'routine_occurrence',
  'routine_run_revision',
  'routine_checklist_confirmation',
  'routine_command_receipt',
  'stretch_profile',
  'stretching_log_revision',
  'recovery_method_version',
  'recovery_strategy_version',
  'recovery_action_revision',
];
const mutableHeads = [
  'routine_blueprint_head',
  'routine_schedule_head',
  'routine_run',
  'routine_step_timer',
  'stretching_log',
  'recovery_method_head',
  'recovery_strategy_head',
  'recovery_action_log',
];
const tables = [...appendOnly, ...mutableHeads];
const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantRoutineCore(adminUrl, 'workout_runtime');
  await grantStretchingCore(adminUrl, 'workout_runtime');
  await grantRecoveryCore(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

describe('M1c production runtime grants', () => {
  it('gives only the documented DML privileges to a nonowner runtime role under FORCE RLS', async () => {
    const result = await admin.query<{
      relname: string;
      select_allowed: boolean;
      insert_allowed: boolean;
      update_allowed: boolean;
      delete_allowed: boolean;
      rls_enabled: boolean;
      rls_forced: boolean;
    }>(
      `SELECT c.relname,
        has_table_privilege('workout_runtime', c.oid, 'SELECT') AS select_allowed,
        has_table_privilege('workout_runtime', c.oid, 'INSERT') AS insert_allowed,
        has_table_privilege('workout_runtime', c.oid, 'UPDATE') AS update_allowed,
        has_table_privilege('workout_runtime', c.oid, 'DELETE') AS delete_allowed,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [tables],
    );
    expect(result.rows).toHaveLength(tables.length);
    for (const row of result.rows) {
      expect(row).toMatchObject({
        select_allowed: true,
        insert_allowed: true,
        update_allowed: mutableHeads.includes(row.relname),
        delete_allowed: false,
        rls_enabled: true,
        rls_forced: true,
      });
    }
  });

  it('permits the latest erasure wrapper but not its previous entry points', async () => {
    const signatures = [
      'erase_account(text)',
      'erase_account_before_recovery_core(text)',
      'erase_account_before_stretching(text)',
      'erase_account_before_routine_core(text)',
    ];
    for (const [index, signature] of signatures.entries()) {
      const result = await admin.query<{ allowed: boolean }>(
        "SELECT has_function_privilege('workout_runtime', $1::text, 'EXECUTE') AS allowed",
        [`public.${signature}`],
      );
      expect(result.rows[0]?.allowed).toBe(index === 0);
    }
  });

  it('isolates actual runtime writes by tenant and erases a recovery row through the current wrapper', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const methodId = randomUUID();
    const versionId = randomUUID();
    const record = {
      schemaVersion: 1,
      methodId,
      versionId,
      reviewState: 'unreviewed',
      reviewedAt: null,
      source: 'user_recorded',
    };
    const insert = (athleteId: string) =>
      database.tenant(athleteId, (tx) =>
        tx.query(
          'INSERT INTO recovery_method_version(athlete_id,method_id,version_id,version,record_json) VALUES ($1,$2,$3,1,$4::jsonb)',
          [owner, methodId, versionId, JSON.stringify(record)],
        ),
      );
    await insert(owner);
    await database.tenant(other, async (tx) => {
      expect((await tx.query('SELECT * FROM recovery_method_version')).rows).toEqual([]);
    });
    await expect(insert(other)).rejects.toMatchObject({ code: '42501' });
    await database.exclusiveTenant(owner, (tx) =>
      tx.query('SELECT public.erase_account($1)', [owner]),
    );
    const remaining = await admin.query(
      'SELECT 1 FROM recovery_method_version WHERE athlete_id=$1',
      [owner],
    );
    expect(remaining.rows).toEqual([]);
  });
});
