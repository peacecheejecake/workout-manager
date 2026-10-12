import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import {
  installCurrentRuntimeV9,
  verifyCurrentRuntimeV9InstalledIn,
} from '../src/current-runtime-installation-v9.js';
import { grantCurrentRuntimeV9Profile } from '../src/current-runtime-grants-v9.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import {
  installCurrentRuntimeV10,
  installCurrentRuntimeV10In,
  verifyCurrentRuntimeV10InstalledIn,
  currentRuntimeV10ExtensionMembers,
  currentRuntimeV10FunctionPins,
} from '../src/current-runtime-installation-v10.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Real PostgreSQL. Metadata/receipts only; no health, candidate, secret,
// suppression or account data seed. No product/support activation is inferred.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const ownerRole = `current_runtime_v10_owner_${suffix}`,
  runtimeRole = `current_runtime_v10_app_${suffix}`;
const fresh = `current_runtime_v10_fresh_${suffix}`,
  upgrade = `current_runtime_v10_upgrade_${suffix}`,
  concurrent = `current_runtime_v10_race_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const databases: string[] = [],
  roles: string[] = [];
let pending: Promise<void> = Promise.resolve();
function fixtureIt(label: string, run: () => Promise<void>) {
  it(
    label,
    async () => {
      const work = pending.then(run);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    180000,
  );
}
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
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  const tx = await pool.connect();
  try {
    return await run(tx);
  } finally {
    tx.release();
    await pool.end();
  }
}
async function rollback<T>(run: (tx: PoolClient) => Promise<T>, database = fresh) {
  return session(database, async (tx) => {
    await tx.query('BEGIN');
    try {
      return await run(tx);
    } finally {
      await tx.query('ROLLBACK');
    }
  });
}
async function rejected(tx: PoolClient, run: () => Promise<unknown>, message: string) {
  await tx.query('SAVEPOINT rejection');
  try {
    await expect(run()).rejects.toThrow(message);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT rejection');
    await tx.query('RELEASE SAVEPOINT rejection');
  }
}
async function newDatabase(label: string) {
  const database = `current_runtime_v10_${label}_${suffix}`;
  await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
  databases.push(database);
  await migrate(url(database), 107);
  return database;
}
const ledgerSql = `SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY extension_step) AS value FROM wm_runtime_installation.profile_extension_v10 t`;
const parentLedgerSql = `SELECT jsonb_agg(jsonb_build_object('family',f.family,'row',f.row,'xmin',f.xmin) ORDER BY f.family,f.row::text) AS value FROM (${[
  'migration',
  ...Array.from({ length: 8 }, (_, i) => `profile_extension_v${i + 2}`),
]
  .map(
    (table) =>
      `SELECT '${table}' AS family,to_jsonb(t) AS row,t.xmin::text AS xmin FROM wm_runtime_installation.${table} t`,
  )
  .join(' UNION ALL ')}) f`;
const absenceSql =
  "SELECT to_regclass('wm_runtime_installation.profile_extension_v10') IS NULL AS ledger_absent,to_regprocedure('public.guard_race_event_local_date_approval_v1()') IS NULL AS guard_absent,NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='race_local_date_approval_guard') AS trigger_absent";
let baselineReceipt: unknown;
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  for (const database of [fresh, upgrade, concurrent]) {
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    databases.push(database);
    await migrate(url(database), 107);
  }
  // Committed profile25: V9 install, app core grants and V9 runtime grants.
  await installCurrentRuntimeV9(url(upgrade));
  await grantCurrentRuntimeAppBaselineV2(url(upgrade), runtimeRole, 'core');
  await grantCurrentRuntimeV9Profile(url(upgrade), runtimeRole);
}, 240000);
afterAll(async () => {
  await pending;
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 60000);
fixtureIt(
  'fresh normal107 installs parent25 and one 146 receipt without activating runtime',
  async () => {
    const installed = await installCurrentRuntimeV10(url(fresh));
    expect(installed).toMatchObject({
      profileVersion: 10,
      parentProfileVersion: 9,
      baselineSchemaVersion: 107,
      parentRuntimeStep: 25,
      extensionSteps: 1,
      runtimeStep: 26,
      sourceDdlTip: 146,
      supported: false,
      processingAuthority: 'none',
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
    });
    expect(installed.extensionReceipts.map((r) => r.sourceDdlId)).toEqual([146]);
    expect(installed.parentAppliedMembers).toHaveLength(32);
    await session(fresh, async (tx) => {
      baselineReceipt = (await tx.query(ledgerSql)).rows[0]?.['value'];
      expect(
        (await tx.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
          'version'
        ],
      ).toBe(107);
      expect(await verifyCurrentRuntimeV10InstalledIn(tx)).toEqual(installed);
      // BEFORE triggers fire by name: identity/deletion guard, date guard, re-entry guard.
      // Every other race_event trigger is AFTER, so none can rewrite NEW.values_json later.
      expect(
        (
          await tx.query(
            'SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t WHERE t.tgrelid=\'public.race_event\'::regclass AND NOT t.tgisinternal AND (t.tgtype & 2)=2 ORDER BY t.tgname COLLATE "C"',
          )
        ).rows.map((r) => r['tgname']),
      ).toEqual([
        'race_head_deletion_guard',
        'race_local_date_approval_guard',
        'race_suppressed_reentry_guard',
      ]);
    });
  },
);
fixtureIt(
  'committed profile25 verifies under V9, upgrades with 146 only, keeps parent receipts/xmin and functions',
  async () => {
    await session(upgrade, async (tx) => {
      // V9 copy logic in V10 must agree with V9 itself on the same database.
      const v9 = await verifyCurrentRuntimeV9InstalledIn(tx);
      expect(v9).toMatchObject({ profileVersion: 9, runtimeStep: 25, sourceDdlTip: 142 });
      expect(
        (
          await tx.query(
            "SELECT to_regprocedure('public.guard_race_event_local_date_approval_v1()') IS NULL AS absent",
          )
        ).rows[0]?.['absent'],
      ).toBe(true);
      const metadataBefore = (
        await tx.query(
          "SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','wm_manual_pooled')",
        )
      ).rows[0]?.['value'];
      const before = (await tx.query(parentLedgerSql)).rows[0]?.['value'];
      const grantsBefore = (
        await tx.query(
          "SELECT jsonb_agg(jsonb_build_object('oid',p.oid::text,'acl',p.proacl::text) ORDER BY p.oid) AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'",
        )
      ).rows[0]?.['value'];
      await tx.query('BEGIN');
      try {
        const installed = await installCurrentRuntimeV10In(tx);
        expect(installed).toMatchObject({ profileVersion: 10, runtimeStep: 26 });
        await tx.query('COMMIT');
      } catch (e) {
        await tx.query('ROLLBACK');
        throw e;
      }
      const beforeRows = z.array(z.record(z.string(), z.unknown())).parse(metadataBefore);
      const originalOids = beforeRows.map((row) =>
        z
          .union([z.string().regex(/^\d+$/), z.number().int().positive()])
          .transform(String)
          .parse(row['oid']),
      );
      expect(
        (
          await tx.query(
            'SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p WHERE p.oid=ANY($1::oid[])',
            [originalOids],
          )
        ).rows[0]?.['value'],
      ).toEqual(metadataBefore);
      expect(
        (
          await tx.query(
            "SELECT jsonb_agg(jsonb_build_object('oid',p.oid::text,'acl',p.proacl::text) ORDER BY p.oid) AS value FROM pg_proc p WHERE p.oid=ANY($1::oid[]) AND p.pronamespace='public'::regnamespace",
            [originalOids],
          )
        ).rows[0]?.['value'],
      ).toEqual(grantsBefore);
      expect((await tx.query(parentLedgerSql)).rows[0]?.['value']).toEqual(before);
      await verifyCurrentRuntimeV10InstalledIn(tx);
      // profile25 tooling refuses profile26 by construction.
      await expect(verifyCurrentRuntimeV9InstalledIn(tx)).rejects.toThrow(
        'CURRENT_RUNTIME_V9_LEDGER_INVALID',
      );
    });
    await expect(grantCurrentRuntimeV9Profile(url(upgrade), runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V9_LEDGER_INVALID',
    );
    // The upgrade and the fresh path produce identical receipts and results.
    const upgraded = await installCurrentRuntimeV10(url(upgrade));
    const freshResult = await installCurrentRuntimeV10(url(fresh));
    expect(upgraded).toEqual(freshResult);
  },
);
fixtureIt('repeated install returns the original receipt without rewriting it', async () => {
  const first = await installCurrentRuntimeV10(url(fresh));
  const second = await installCurrentRuntimeV10(url(fresh));
  expect(second).toEqual(first);
  await session(fresh, async (tx) =>
    expect((await tx.query(ledgerSql)).rows[0]?.['value']).toEqual(baselineReceipt),
  );
});
fixtureIt(
  'two genuine owner connections serialize one fresh installation and preserve same receipts',
  async () => {
    const [a, b] = await Promise.all([
      installCurrentRuntimeV10(url(concurrent)),
      installCurrentRuntimeV10(url(concurrent)),
    ]);
    expect(a).toEqual(b);
    expect(a.extensionReceipts).toHaveLength(1);
  },
);
fixtureIt('applied 146 without a receipt ledger is rejected and never adopted', async () => {
  await rollback(async (tx) => {
    await tx.query('DROP TABLE wm_runtime_installation.profile_extension_v10');
    await rejected(
      tx,
      () => installCurrentRuntimeV10In(tx),
      'CURRENT_RUNTIME_V10_UNREGISTERED_STAGE',
    );
    expect(
      (
        await tx.query(
          "SELECT to_regclass('wm_runtime_installation.profile_extension_v10') IS NULL AS absent",
        )
      ).rows[0]?.['absent'],
    ).toBe(true);
  });
  // Function alone (trigger dropped) and the raw 146 on a committed profile25 are stages too.
  await rollback(async (tx) => {
    await tx.query('DROP TABLE wm_runtime_installation.profile_extension_v10');
    await tx.query('DROP TRIGGER race_local_date_approval_guard ON public.race_event');
    await rejected(
      tx,
      () => installCurrentRuntimeV10In(tx),
      'CURRENT_RUNTIME_V10_UNREGISTERED_STAGE',
    );
  });
  const raw = await newDatabase('raw');
  await installCurrentRuntimeV9(url(raw));
  await rollback(async (tx) => {
    await tx.query(
      await readFile(
        new URL('../migrations/146_race_event_local_date_approval_guard.sql', import.meta.url),
        'utf8',
      ),
    );
    await rejected(
      tx,
      () => installCurrentRuntimeV10In(tx),
      'CURRENT_RUNTIME_V10_UNREGISTERED_STAGE',
    );
    await rejected(
      tx,
      () => verifyCurrentRuntimeV10InstalledIn(tx),
      'CURRENT_RUNTIME_V10_LEDGER_INVALID',
    );
  }, raw);
});
fixtureIt('runtime/elevated principal cannot verify private installation provenance', async () => {
  await session(
    fresh,
    async (tx) => {
      await tx.query('BEGIN');
      try {
        await expect(verifyCurrentRuntimeV10InstalledIn(tx)).rejects.toThrow();
      } finally {
        await tx.query('ROLLBACK');
      }
    },
    runtimeRole,
  );
  await admin.query(`ALTER ROLE "${ownerRole}" BYPASSRLS`);
  try {
    await expect(installCurrentRuntimeV10(url(fresh))).rejects.toThrow();
  } finally {
    await admin.query(`ALTER ROLE "${ownerRole}" NOBYPASSRLS`);
  }
});
const drift = [
  [
    'trigger disabled',
    'ALTER TABLE public.race_event DISABLE TRIGGER race_local_date_approval_guard',
    'FUNCTION_DRIFT',
  ],
  [
    'trigger replica-only',
    'ALTER TABLE public.race_event ENABLE REPLICA TRIGGER race_local_date_approval_guard',
    'FUNCTION_DRIFT',
  ],
  [
    'trigger dropped',
    'DROP TRIGGER race_local_date_approval_guard ON public.race_event',
    'FUNCTION_DRIFT',
  ],
  [
    'trigger conditional',
    'DROP TRIGGER race_local_date_approval_guard ON public.race_event; CREATE TRIGGER race_local_date_approval_guard BEFORE UPDATE OF values_json ON public.race_event FOR EACH ROW WHEN (false) EXECUTE FUNCTION public.guard_race_event_local_date_approval_v1()',
    'FUNCTION_DRIFT',
  ],
  [
    'trigger column scope',
    'DROP TRIGGER race_local_date_approval_guard ON public.race_event; CREATE TRIGGER race_local_date_approval_guard BEFORE UPDATE OF revision ON public.race_event FOR EACH ROW EXECUTE FUNCTION public.guard_race_event_local_date_approval_v1()',
    'FUNCTION_DRIFT',
  ],
  [
    'trigger timing',
    'DROP TRIGGER race_local_date_approval_guard ON public.race_event; CREATE TRIGGER race_local_date_approval_guard AFTER UPDATE OF values_json ON public.race_event FOR EACH ROW EXECUTE FUNCTION public.guard_race_event_local_date_approval_v1()',
    'FUNCTION_DRIFT',
  ],
  [
    'trigger renamed',
    'ALTER TRIGGER race_local_date_approval_guard ON public.race_event RENAME TO a_race_local_date_guard',
    'FUNCTION_DRIFT',
  ],
  [
    'second trigger use',
    'CREATE TRIGGER race_local_date_extra BEFORE UPDATE ON public.race_result FOR EACH ROW EXECUTE FUNCTION public.guard_race_event_local_date_approval_v1()',
    'FUNCTION_DRIFT',
  ],
  [
    'guard EXECUTE to runtime',
    `GRANT EXECUTE ON FUNCTION public.guard_race_event_local_date_approval_v1() TO "${runtimeRole}"`,
    'FUNCTION_DRIFT',
  ],
  [
    'guard PUBLIC EXECUTE',
    'GRANT EXECUTE ON FUNCTION public.guard_race_event_local_date_approval_v1() TO PUBLIC',
    'FUNCTION_DRIFT',
  ],
  [
    'guard SECURITY DEFINER',
    'ALTER FUNCTION public.guard_race_event_local_date_approval_v1() SECURITY DEFINER',
    'FUNCTION_DRIFT',
  ],
  [
    'guard configuration',
    'ALTER FUNCTION public.guard_race_event_local_date_approval_v1() SET search_path=public',
    'FUNCTION_DRIFT',
  ],
  [
    'parent9 guard4 metadata',
    'ALTER FUNCTION public.assert_manual_race_v2_caller() SET search_path=public',
    'FUNCTION_DRIFT',
  ],
  [
    'missing final142 helper',
    'DROP FUNCTION wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)',
    'FUNCTION_DRIFT',
  ],
  [
    'parent8 missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v8 WHERE extension_step=8',
    'LEDGER_INVALID',
  ],
  [
    'parent9 missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v9 WHERE extension_step=1',
    'LEDGER_INVALID',
  ],
  [
    'parent9 ledger ACL',
    `GRANT SELECT ON wm_runtime_installation.profile_extension_v9 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v10 WHERE extension_step=1',
    'LEDGER_INVALID',
  ],
  [
    'source tuple',
    "UPDATE wm_runtime_installation.profile_extension_v10 SET source_sha256=repeat('0',64) WHERE extension_step=1",
    'CHECK',
  ],
  [
    'dropped CHECK',
    'ALTER TABLE wm_runtime_installation.profile_extension_v10 DROP CONSTRAINT profile_extension_v10_source',
    'LEDGER_INVALID',
  ],
  [
    'ledger foreign ACL',
    `GRANT SELECT ON wm_runtime_installation.profile_extension_v10 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'column foreign ACL',
    `GRANT SELECT(filename) ON wm_runtime_installation.profile_extension_v10 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'ledger trigger',
    'CREATE TRIGGER x BEFORE UPDATE ON wm_runtime_installation.profile_extension_v10 FOR EACH ROW EXECUTE FUNCTION public.guard_race_event_local_date_approval_v1()',
    'LEDGER_INVALID',
  ],
  [
    'unknown extension',
    'CREATE TABLE wm_runtime_installation.profile_extension_v11(id int)',
    'LEDGER_INVALID',
  ],
] as const;
for (const [label, sql, expected] of drift)
  fixtureIt(
    `actual ${label} drift fails closed and rollback restores original receipt`,
    async () => {
      await rollback(async (tx) => {
        if (expected === 'CHECK') {
          await rejected(tx, () => tx.query(sql), 'check constraint');
        } else {
          await tx.query(sql);
          await rejected(tx, () => verifyCurrentRuntimeV10InstalledIn(tx), expected);
          await rejected(tx, () => installCurrentRuntimeV10In(tx), 'CURRENT_RUNTIME_V10_');
        }
      });
      await session(fresh, async (tx) => {
        await verifyCurrentRuntimeV10InstalledIn(tx);
        expect((await tx.query(ledgerSql)).rows[0]?.['value']).toEqual(baselineReceipt);
      });
    },
  );
fixtureIt('actual guard body tamper rejects without rewriting the original ledger', async () => {
  await rollback(async (tx) => {
    const row = (
      await tx.query(
        "SELECT pg_get_functiondef('public.guard_race_event_local_date_approval_v1()'::regprocedure) AS definition,prosrc AS body FROM pg_proc WHERE oid='public.guard_race_event_local_date_approval_v1()'::regprocedure",
      )
    ).rows[0];
    if (typeof row?.['definition'] !== 'string' || typeof row?.['body'] !== 'string')
      throw Error('BODY_REQUIRED');
    const originalBody = row['body'];
    const definition = row['definition'];
    expect(definition.split(originalBody)).toHaveLength(2);
    // A permissive guard is the drift that matters: it must not verify.
    const permissive = definition.replace(originalBody, () => '\nBEGIN\n  RETURN NEW;\nEND\n');
    await tx.query(permissive);
    await rejected(tx, () => verifyCurrentRuntimeV10InstalledIn(tx), 'FUNCTION_DRIFT');
  });
});
fixtureIt(
  'a fault after 146 and before the receipt rolls back to a genuine verifying profile25',
  async () => {
    const database = await newDatabase('fault');
    await installCurrentRuntimeV9(url(database));
    await session(database, async (tx) => {
      await tx.query('BEGIN');
      let applied146 = false;
      try {
        await installCurrentRuntimeV10In({
          query: async (sql, values) => {
            if (sql.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v10')) {
              applied146 =
                (
                  await tx.query(
                    "SELECT to_regprocedure('public.guard_race_event_local_date_approval_v1()') IS NOT NULL AS present",
                  )
                ).rows[0]?.['present'] === true;
              throw Error('FORCED_RECEIPT_FAULT');
            }
            return tx.query(sql, values);
          },
        });
        throw Error('FAULT_NOT_REACHED');
      } catch (e) {
        await tx.query('ROLLBACK');
        expect(e).toEqual(Error('FORCED_RECEIPT_FAULT'));
      }
      expect(applied146).toBe(true);
      await verifyCurrentRuntimeV9InstalledIn(tx);
      expect((await tx.query(absenceSql)).rows[0]).toEqual({
        ledger_absent: true,
        guard_absent: true,
        trigger_absent: true,
      });
    });
    // A whole successful install that the caller aborts also rolls back atomically.
    await session(database, async (tx) => {
      await tx.query('BEGIN');
      try {
        await installCurrentRuntimeV10In(tx);
        throw Error('FORCED_INSTALL_ABORT');
      } catch (e) {
        await tx.query('ROLLBACK');
        expect(e).toEqual(Error('FORCED_INSTALL_ABORT'));
      }
      await verifyCurrentRuntimeV9InstalledIn(tx);
      expect((await tx.query(absenceSql)).rows[0]).toEqual({
        ledger_absent: true,
        guard_absent: true,
        trigger_absent: true,
      });
    });
  },
);
fixtureIt('fixed physical146 SQL file corresponds exactly to the returned receipt', async () => {
  const installed = await installCurrentRuntimeV10(url(fresh));
  for (const [i, member] of currentRuntimeV10ExtensionMembers.entries()) {
    expect(installed.extensionReceipts[i]).toMatchObject(member);
    expect(
      (await readFile(new URL(`../migrations/${member.filename}`, import.meta.url))).byteLength,
    ).toBeGreaterThan(0);
  }
  await session(fresh, async (tx) => {
    for (const pin of currentRuntimeV10FunctionPins.filter((p) => !p.runtimeDirect))
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            pin.signature,
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
  });
});
fixtureIt(
  'read-only verifier cannot turn normal107 or genuine profile25 into receipted profile26',
  async () => {
    const database = await newDatabase('normal');
    await expect(
      session(database, (tx) => verifyCurrentRuntimeV10InstalledIn(tx)),
    ).rejects.toThrow();
    await installCurrentRuntimeV9(url(database));
    await expect(session(database, (tx) => verifyCurrentRuntimeV10InstalledIn(tx))).rejects.toThrow(
      'CURRENT_RUNTIME_V10_LEDGER_INVALID',
    );
    await session(database, async (tx) => {
      expect((await tx.query(absenceSql)).rows[0]).toEqual({
        ledger_absent: true,
        guard_absent: true,
        trigger_absent: true,
      });
    });
  },
);
