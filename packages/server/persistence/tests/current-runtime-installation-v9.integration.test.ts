import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import {
  installCurrentRuntimeV8,
  verifyCurrentRuntimeV8InstalledIn,
} from '../src/current-runtime-installation-v8.js';
import {
  installCurrentRuntimeV9,
  installCurrentRuntimeV9In,
  verifyCurrentRuntimeV9InstalledIn,
  currentRuntimeV9ExtensionMembers,
  currentRuntimeV9FunctionPins,
} from '../src/current-runtime-installation-v9.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root executes PostgreSQL. Metadata/receipts only; no health, candidate, secret,
// suppression or account data seed. No product/support activation is inferred.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const ownerRole = `current_runtime_v9_owner_${suffix}`,
  runtimeRole = `current_runtime_v9_app_${suffix}`;
const fresh = `current_runtime_v9_fresh_${suffix}`,
  upgrade = `current_runtime_v9_upgrade_${suffix}`,
  concurrent = `current_runtime_v9_race_${suffix}`;
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
    120000,
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
async function rollback<T>(run: (tx: PoolClient) => Promise<T>) {
  return session(fresh, async (tx) => {
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
const ledgerSql = `SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY extension_step) AS value FROM wm_runtime_installation.profile_extension_v9 t`;
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
  await installCurrentRuntimeV8(url(upgrade));
  await installCurrentRuntimeV8(url(concurrent));
}, 180000);
afterAll(async () => {
  await pending;
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 30000);
fixtureIt(
  'fresh normal107 installs parent24 and one new receipts without activating runtime',
  async () => {
    const installed = await installCurrentRuntimeV9(url(fresh));
    expect(installed).toMatchObject({
      profileVersion: 9,
      baselineSchemaVersion: 107,
      parentRuntimeStep: 24,
      extensionSteps: 1,
      runtimeStep: 25,
      sourceDdlTip: 142,
      supported: false,
      processingAuthority: 'none',
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
    });
    expect(installed.extensionReceipts.map((r) => r.sourceDdlId)).toEqual([142]);
    await session(fresh, async (tx) => {
      baselineReceipt = (await tx.query(ledgerSql)).rows[0]?.['value'];
      expect(
        (await tx.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
          'version'
        ],
      ).toBe(107);
      await verifyCurrentRuntimeV9InstalledIn(tx);
    });
  },
);
fixtureIt(
  'upgrade retains genuine parent receipts and xmin and repeated install returns original one receipts',
  async () => {
    await session(upgrade, async (tx) => {
      const metadataBefore = (
        await tx.query(
          "SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','wm_manual_pooled')",
        )
      ).rows[0]?.['value'];
      const before = (
        await tx.query(
          "SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY extension_step) AS value FROM wm_runtime_installation.profile_extension_v8 t",
        )
      ).rows[0]?.['value'];
      await tx.query('BEGIN');
      try {
        await installCurrentRuntimeV9In(tx);
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
            "SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY extension_step) AS value FROM wm_runtime_installation.profile_extension_v8 t",
          )
        ).rows[0]?.['value'],
      ).toEqual(before);
    });
    const first = await installCurrentRuntimeV9(url(fresh));
    const second = await installCurrentRuntimeV9(url(fresh));
    expect(second).toEqual(first);
    await session(fresh, async (tx) =>
      expect((await tx.query(ledgerSql)).rows[0]?.['value']).toEqual(baselineReceipt),
    );
  },
);
fixtureIt(
  'two genuine owner connections serialize one fresh installation and preserve same receipts',
  async () => {
    const [a, b] = await Promise.all([
      installCurrentRuntimeV9(url(concurrent)),
      installCurrentRuntimeV9(url(concurrent)),
    ]);
    expect(a).toEqual(b);
    expect(a.extensionReceipts).toHaveLength(1);
  },
);
fixtureIt(
  'normal nongrantable direct EXECUTE permits verify/replay but private/helpers/ledger remain inaccessible',
  async () => {
    await rollback(async (tx) => {
      for (const pin of currentRuntimeV9FunctionPins.filter((p) => p.runtimeDirect))
        await tx.query(`GRANT EXECUTE ON FUNCTION ${pin.signature} TO "${runtimeRole}"`);
      await verifyCurrentRuntimeV9InstalledIn(tx);
      await installCurrentRuntimeV9In(tx);
      for (const pin of currentRuntimeV9FunctionPins.filter((p) => !p.runtimeDirect)) {
        expect(
          (
            await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
              runtimeRole,
              pin.signature,
            ])
          ).rows[0]?.['allowed'],
        ).toBe(false);
      }
      expect(
        (
          await tx.query(
            "SELECT has_table_privilege($1,'wm_runtime_installation.profile_extension_v9','SELECT,INSERT,UPDATE,DELETE') AS allowed,has_schema_privilege($1,'wm_manual_pooled','USAGE') AS schema_allowed",
            [runtimeRole],
          )
        ).rows[0],
      ).toEqual({ allowed: false, schema_allowed: false });
    });
  },
);
fixtureIt('complete raw successor without receipt is rejected and never adopted', async () => {
  await rollback(async (tx) => {
    await tx.query('DROP TABLE wm_runtime_installation.profile_extension_v9');
    await rejected(
      tx,
      () => installCurrentRuntimeV9In(tx),
      'CURRENT_RUNTIME_V9_UNREGISTERED_STAGE',
    );
    expect(
      (
        await tx.query(
          "SELECT to_regclass('wm_runtime_installation.profile_extension_v9') IS NULL AS absent",
        )
      ).rows[0]?.['absent'],
    ).toBe(true);
  });
});
fixtureIt(
  'partial raw successor without receipt is rejected before installation writes',
  async () => {
    await rollback(async (tx) => {
      await tx.query('DROP TABLE wm_runtime_installation.profile_extension_v9');
      await tx.query('DROP FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)');
      await rejected(
        tx,
        () => installCurrentRuntimeV9In(tx),
        'CURRENT_RUNTIME_V9_UNREGISTERED_STAGE',
      );
    });
  },
);
fixtureIt('runtime/elevated principal cannot verify private installation provenance', async () => {
  await session(
    fresh,
    async (tx) => {
      await tx.query('BEGIN');
      try {
        await expect(verifyCurrentRuntimeV9InstalledIn(tx)).rejects.toThrow();
      } finally {
        await tx.query('ROLLBACK');
      }
    },
    runtimeRole,
  );
  await admin.query(`ALTER ROLE "${ownerRole}" BYPASSRLS`);
  try {
    await expect(installCurrentRuntimeV9(url(fresh))).rejects.toThrow();
  } finally {
    await admin.query(`ALTER ROLE "${ownerRole}" NOBYPASSRLS`);
  }
});
const drift = [
  [
    'parent8 missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v8 WHERE extension_step=8',
    'LEDGER_INVALID',
  ],
  [
    'parent8 ledger ACL',
    `GRANT SELECT ON wm_runtime_installation.profile_extension_v8 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'new142 PUBLIC ACL',
    'GRANT EXECUTE ON FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) TO PUBLIC',
    'FUNCTION_DRIFT',
  ],
  [
    'original guard4 metadata',
    'ALTER FUNCTION public.assert_manual_race_v2_caller() SET search_path=public',
    'FUNCTION_DRIFT',
  ],
  [
    'missing final142 helper',
    'DROP FUNCTION wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)',
    'FUNCTION_DRIFT',
  ],
  [
    'final142 helper ACL',
    `GRANT EXECUTE ON FUNCTION wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer) TO "${runtimeRole}"`,
    'FUNCTION_DRIFT',
  ],
  [
    'final142 reader configuration',
    "ALTER FUNCTION public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb) SET DateStyle='German,DMY'",
    'FUNCTION_DRIFT',
  ],
  [
    'missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v9 WHERE extension_step=1',
    'LEDGER_INVALID',
  ],
  [
    'source tuple',
    "UPDATE wm_runtime_installation.profile_extension_v9 SET source_sha256=repeat('0',64) WHERE extension_step=1",
    'CHECK',
  ],
  [
    'ledger foreign ACL',
    `GRANT SELECT ON wm_runtime_installation.profile_extension_v9 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'column foreign ACL',
    `GRANT SELECT(filename) ON wm_runtime_installation.profile_extension_v9 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'unknown extension',
    'CREATE TABLE wm_runtime_installation.unknown_v9(id int)',
    'LEDGER_INVALID',
  ],
  [
    'public function ACL',
    'GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) TO PUBLIC',
    'FUNCTION_DRIFT',
  ],
  [
    'unsafe delegation',
    `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb) TO "${runtimeRole}" WITH GRANT OPTION`,
    'FUNCTION_DRIFT',
  ],
  [
    'private helper ACL',
    `GRANT EXECUTE ON FUNCTION wm_manual_pooled.lookup_validated_local(jsonb,text) TO "${runtimeRole}"`,
    'FUNCTION_DRIFT',
  ],
  [
    'configuration',
    "ALTER FUNCTION public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb) SET DateStyle='German,DMY'",
    'FUNCTION_DRIFT',
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
          await rejected(tx, () => verifyCurrentRuntimeV9InstalledIn(tx), expected);
        }
      });
      await session(fresh, async (tx) => {
        await verifyCurrentRuntimeV9InstalledIn(tx);
        expect((await tx.query(ledgerSql)).rows[0]?.['value']).toEqual(baselineReceipt);
      });
    },
  );
for (const signature of [
  'public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)',
  'public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)',
  'public.assert_manual_race_v2_caller()',
])
  fixtureIt(
    `actual ${signature} body tamper rejects without rewriting original ledger`,
    async () => {
      await rollback(async (tx) => {
        const row = (
          await tx.query(
            'SELECT pg_get_functiondef(to_regprocedure($1)) AS definition,prosrc AS body FROM pg_proc WHERE oid=to_regprocedure($1)',
            [signature],
          )
        ).rows[0];
        if (typeof row?.['definition'] !== 'string' || typeof row?.['body'] !== 'string')
          throw Error('BODY_REQUIRED');
        const originalBody = row['body'];
        const definition = row['definition'];
        expect(definition.split(originalBody)).toHaveLength(2);
        const intendedBody = originalBody + '\n-- synthetic code drift\n';
        const tamperedDefinition = definition.replace(originalBody, () => intendedBody);
        expect(tamperedDefinition).toContain(intendedBody);
        await tx.query(tamperedDefinition);
        await rejected(tx, () => verifyCurrentRuntimeV9InstalledIn(tx), 'FUNCTION_DRIFT');
      });
    },
  );
fixtureIt(
  'failure after applying actual ordered source DDL rolls back whole new ledger/schema to genuine parent24',
  async () => {
    // New disposable parent database, without product data or raw-body patching.
    const database = `current_runtime_v9_abort_${suffix}`;
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    databases.push(database);
    await migrate(url(database), 107);
    await installCurrentRuntimeV8(url(database));
    await session(database, async (tx) => {
      await tx.query('BEGIN');
      try {
        await installCurrentRuntimeV9In(tx);
        throw Error('FORCED_INSTALL_ABORT');
      } catch (e) {
        await tx.query('ROLLBACK');
        expect(e).toEqual(Error('FORCED_INSTALL_ABORT'));
      }
      await verifyCurrentRuntimeV8InstalledIn(tx);
      expect(
        (
          await tx.query(
            "SELECT to_regclass('wm_runtime_installation.profile_extension_v9') IS NULL AS ledger_absent,to_regprocedure('public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)') IS NULL AS pooled_absent",
          )
        ).rows[0],
      ).toEqual({ ledger_absent: true, pooled_absent: true });
    });
  },
);
fixtureIt('fixed physical142 SQL files correspond exactly to the returned receipts', async () => {
  const installed = await installCurrentRuntimeV9(url(fresh));
  for (const [i, member] of currentRuntimeV9ExtensionMembers.entries()) {
    expect(installed.extensionReceipts[i]).toMatchObject(member);
    expect(
      (await readFile(new URL(`../migrations/${member.filename}`, import.meta.url))).byteLength,
    ).toBeGreaterThan(0);
  }
});

fixtureIt(
  'read-only verifier cannot turn normal107 or genuine parent8 into receipted profile9',
  async () => {
    const database = `current_runtime_v9_normal_${suffix}`;
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    databases.push(database);
    await migrate(url(database), 107);
    await expect(
      session(database, (tx) => verifyCurrentRuntimeV9InstalledIn(tx)),
    ).rejects.toThrow();
    await installCurrentRuntimeV8(url(database));
    await expect(session(database, (tx) => verifyCurrentRuntimeV9InstalledIn(tx))).rejects.toThrow(
      'CURRENT_RUNTIME_V9_LEDGER_INVALID',
    );
    await session(database, async (tx) => {
      expect(
        (
          await tx.query(
            "SELECT to_regclass('wm_runtime_installation.profile_extension_v9') IS NULL AS absent,to_regprocedure('public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)') IS NULL AS no_delta",
          )
        ).rows[0],
      ).toEqual({ absent: true, no_delta: true });
    });
  },
);
