import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { verifyCurrentRuntimeInstalledIn } from '../src/current-runtime-installation.js';
import {
  installCurrentRuntimeV6,
  installCurrentRuntimeV6In,
  verifyCurrentRuntimeV6InstalledIn,
} from '../src/current-runtime-installation-v6.js';
import { verifyCurrentRuntimeV3InstalledIn } from '../src/current-runtime-installation-v3.js';
import { verifyCurrentRuntimeV2InstalledIn } from '../src/current-runtime-installation-v2.js';
import { verifyCurrentRuntimeV4InstalledIn } from '../src/current-runtime-installation-v4.js';
import {
  installCurrentRuntimeV5,
  verifyCurrentRuntimeV5InstalledIn,
} from '../src/current-runtime-installation-v5.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual execution only. Synthetic roles/catalog metadata; no health rows.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const admin = new Pool({ connectionString: adminUrl });
const pendingFixtureWork = new Set<Promise<void>>();
function fixtureIt(name: string, run: () => Promise<void>, timeout = 120000) {
  it(
    name,
    async () => {
      const work = run();
      pendingFixtureWork.add(work);
      try {
        await work;
      } finally {
        pendingFixtureWork.delete(work);
      }
    },
    timeout,
  );
}
const roles: string[] = [],
  databases: string[] = [];
const ownerRole = `current_runtime_v6_owner_${suffix}`,
  runtimeRole = `current_runtime_v6_app_${suffix}`;
const fresh = `current_runtime_v6_fresh_${suffix}`,
  upgrade = `current_runtime_v6_upgrade_${suffix}`;
function url(name: string, role = ownerRole) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function session<T>(name: string, apply: (tx: PoolClient) => Promise<T>, role = ownerRole) {
  const pool = new Pool({
    connectionString: url(name, role),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  const tx = await pool.connect();
  try {
    return await apply(tx);
  } finally {
    tx.release();
    await pool.end();
  }
}
async function base(name: string) {
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  databases.push(name);
  await migrate(url(name), 107);
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await base(fresh);
  await base(upgrade);
  await installCurrentRuntimeV5(url(upgrade));
}, 120000);
afterAll(async () => {
  await Promise.allSettled([...pendingFixtureWork]);
  for (const name of databases.reverse()) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function observe(name: string) {
  return session(name, async (tx) => ({
    base: (await tx.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version'))
      .rows,
    parent: (
      await tx.query(
        'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.migration ORDER BY step',
      )
    ).rows,
    extension128: (
      await tx.query(
        'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v2',
      )
    ).rows,
    extension129: (
      await tx.query(
        'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v3',
      )
    ).rows,
    extension129Catalog: (
      await tx.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v3'::regclass ORDER BY conname",
      )
    ).rows,
    extension130: (
      await tx.query(
        'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v4',
      )
    ).rows,
    extension130Catalog: (
      await tx.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v4'::regclass ORDER BY conname",
      )
    ).rows,
    extension131: (
      await tx.query(
        'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v5',
      )
    ).rows,
    extension131Catalog: (
      await tx.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v5'::regclass ORDER BY conname",
      )
    ).rows,
    oldAcl: (
      await tx.query(
        "SELECT relname,relowner,relacl::text FROM pg_class WHERE oid IN('wm_runtime_installation.migration'::regclass,'wm_runtime_installation.profile_extension_v2'::regclass,'wm_runtime_installation.profile_extension_v3'::regclass,'wm_runtime_installation.profile_extension_v4'::regclass,'wm_runtime_installation.profile_extension_v5'::regclass) ORDER BY relname",
      )
    ).rows,
    extension128Catalog: (
      await tx.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v2'::regclass ORDER BY conname",
      )
    ).rows,
    parentReaderMetadata: (
      await tx.query(
        "SELECT p.oid::regprocedure::text AS signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body,p.prosecdef,p.proconfig,p.proacl::text,p.proowner FROM pg_proc p WHERE p.oid IN('public.read_check_in_template_personal_export_v1(integer)'::regprocedure,'public.read_race_manual_personal_export_v1(integer)'::regprocedure,'public.read_manual_race_internal_personal_export_v1(integer)'::regprocedure,'public.read_manual_race_source_personal_export_v1(integer)'::regprocedure,'public.read_nutrition_disconnection_personal_export_v1(integer)'::regprocedure,'public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)'::regprocedure) ORDER BY p.oid::regprocedure::text",
      )
    ).rows,
    catalog: (
      await tx.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.migration'::regclass ORDER BY conname",
      )
    ).rows,
  }));
}
async function rollback<T>(name: string, apply: (tx: PoolClient) => Promise<T>) {
  return session(name, async (tx) => {
    await tx.query('BEGIN');
    try {
      return await apply(tx);
    } finally {
      await tx.query('ROLLBACK');
    }
  });
}
fixtureIt(
  'fresh107 applies exact parent21 then extension132 without changing the baseline registry',
  async () => {
    const before = await session(
      fresh,
      async (tx) =>
        (await tx.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version'))
          .rows,
    );
    const result = await installCurrentRuntimeV6(url(fresh));
    expect(result).toMatchObject({
      profileVersion: 6,
      runtimeStep: 22,
      sourceDdlTip: 132,
      parentRuntimeStep: 21,
      supported: false,
      restore: 'not_verified',
    });
    expect((await observe(fresh)).base).toEqual(before);
    expect(result.parentAppliedMembers).toHaveLength(21);
  },
  120000,
);
fixtureIt(
  'upgrade retains exact v1/v2/v3/v4 row and constraint bytes with17/18/19/20/21 prefix provenance',
  async () => {
    const before = await observe(upgrade);
    await installCurrentRuntimeV6(url(upgrade));
    expect(await observe(upgrade)).toEqual(before);
    const old = await session(upgrade, (tx) => verifyCurrentRuntimeInstalledIn(tx));
    expect(old).toMatchObject({
      profileVersion: 1,
      runtimeStep: 17,
      sourceDdlTip: 127,
      catalogSecurity: 'not_verified',
    });
    expect(await session(upgrade, (tx) => verifyCurrentRuntimeV2InstalledIn(tx))).toMatchObject({
      profileVersion: 2,
      runtimeStep: 18,
      sourceDdlTip: 128,
    });
    expect(await session(upgrade, (tx) => verifyCurrentRuntimeV3InstalledIn(tx))).toMatchObject({
      profileVersion: 3,
      runtimeStep: 19,
      sourceDdlTip: 129,
    });
    expect(await session(upgrade, (tx) => verifyCurrentRuntimeV4InstalledIn(tx))).toMatchObject({
      profileVersion: 4,
      runtimeStep: 20,
      sourceDdlTip: 130,
    });
    expect(await session(upgrade, (tx) => verifyCurrentRuntimeV5InstalledIn(tx))).toMatchObject({
      profileVersion: 5,
      runtimeStep: 21,
      sourceDdlTip: 131,
    });
    expect(await session(upgrade, (tx) => verifyCurrentRuntimeV6InstalledIn(tx))).toMatchObject({
      profileVersion: 6,
      runtimeStep: 22,
      sourceDdlTip: 132,
    });
  },
  120000,
);
fixtureIt(
  'successful replay returns the immutable original extension row without new xid/version',
  async () => {
    const before = await session(
      fresh,
      async (tx) =>
        (
          await tx.query(
            'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v6',
          )
        ).rows,
    );
    const a = await installCurrentRuntimeV6(url(fresh)),
      b = await installCurrentRuntimeV6(url(fresh));
    expect(b).toEqual(a);
    expect(
      await session(
        fresh,
        async (tx) =>
          (
            await tx.query(
              'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v6',
            )
          ).rows,
      ),
    ).toEqual(before);
  },
);
fixtureIt(
  'raw132 without a receipt cannot be adopted even with a valid parent21',
  async () => {
    const name = `current_runtime_v6_raw_${suffix}`;
    await base(name);
    await installCurrentRuntimeV5(url(name));
    await session(name, async (tx) =>
      tx.query(
        await readFile(
          new URL('../migrations/132_manual_retained_source_export_batch.sql', import.meta.url),
          'utf8',
        ),
      ),
    );
    await expect(installCurrentRuntimeV6(url(name))).rejects.toThrow(
      'CURRENT_RUNTIME_V6_UNREGISTERED_STAGE',
    );
    expect(
      await session(
        name,
        async (tx) =>
          (
            await tx.query(
              "SELECT to_regclass('wm_runtime_installation.profile_extension_v6') AS ledger",
            )
          ).rows[0]?.['ledger'],
      ),
    ).toBeNull();
  },
  120000,
);
fixtureIt(
  'actual constraints refuse extra step/unknown DDL/wrong parent or source hashes',
  async () => {
    for (const assignment of [
      'extension_step=2',
      'source_ddl_id=133',
      "source_sha256=repeat('a',64)",
      "parent_manifest_sha256=repeat('b',64)",
      "filename='unknown.sql'",
    ]) {
      await rollback(fresh, async (tx) => {
        await expect(
          tx.query(`UPDATE wm_runtime_installation.profile_extension_v6 SET ${assignment}`),
        ).rejects.toMatchObject({ code: '23514' });
      });
    }
  },
);
fixtureIt(
  'private ACL, extra column, altered exact CHECK and missing reader each fail closed',
  async () => {
    for (const sql of [
      `GRANT SELECT ON wm_runtime_installation.profile_extension_v6 TO "${runtimeRole}"`,
      'ALTER TABLE wm_runtime_installation.profile_extension_v6 ADD COLUMN extra text',
      'ALTER TABLE wm_runtime_installation.profile_extension_v6 DROP CONSTRAINT profile_extension_v6_step',
      'DELETE FROM wm_runtime_installation.profile_extension_v6',
    ])
      await rollback(fresh, async (tx) => {
        await tx.query(sql);
        await expect(verifyCurrentRuntimeV6InstalledIn(tx)).rejects.toThrow(
          'CURRENT_RUNTIME_V6_LEDGER_INVALID',
        );
      });
    await rollback(fresh, async (tx) => {
      await tx.query('DROP FUNCTION public.read_manual_race_retained_source_batch_v1(integer)');
      await expect(verifyCurrentRuntimeV6InstalledIn(tx)).rejects.toThrow(
        'CURRENT_RUNTIME_V6_BATCH_MISSING',
      );
    });
    await rollback(fresh, async (tx) => {
      await tx.query('ALTER TABLE wm_runtime_installation.profile_extension_v6 SET SCHEMA public');
      await expect(verifyCurrentRuntimeV6InstalledIn(tx)).rejects.toThrow(
        'CURRENT_RUNTIME_V6_UNREGISTERED_STAGE',
      );
    });
    await session(
      fresh,
      async (tx) => {
        await expect(
          tx.query('SELECT * FROM wm_runtime_installation.profile_extension_v6'),
        ).rejects.toMatchObject({ code: '42501' });
      },
      runtimeRole,
    );
  },
);
fixtureIt(
  'same transaction parent21 and batch rollback together on caller abort',
  async () => {
    const name = `current_runtime_v6_abort_${suffix}`;
    await base(name);
    await rollback(name, async (tx) => {
      await installCurrentRuntimeV6In(tx);
      throwIfAbsent(
        (
          await tx.query(
            "SELECT to_regprocedure('public.read_manual_race_retained_source_batch_v1(integer)') AS batch",
          )
        ).rows[0]?.['batch'],
      );
    });
    expect(
      await session(
        name,
        async (tx) =>
          (
            await tx.query(
              "SELECT to_regclass('wm_runtime_installation.migration') AS parent,to_regclass('wm_runtime_installation.profile_extension_v4') AS prior,to_regclass('wm_runtime_installation.profile_extension_v6') AS extension,to_regprocedure('public.read_manual_race_retained_source_batch_v1(integer)') AS batch",
            )
          ).rows[0],
      ),
    ).toEqual({ parent: null, prior: null, extension: null, batch: null });
  },
  120000,
);
function throwIfAbsent(value: unknown) {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
}
fixtureIt(
  'two actual concurrent upgrades serialize to one extension receipt and original results',
  async () => {
    const name = `current_runtime_v6_concurrent_${suffix}`;
    await base(name);
    await installCurrentRuntimeV5(url(name));
    const [a, b] = await Promise.all([
      installCurrentRuntimeV6(url(name)),
      installCurrentRuntimeV6(url(name)),
    ]);
    expect(a).toEqual(b);
    expect(
      await session(
        name,
        async (tx) =>
          (
            await tx.query(
              'SELECT count(*)::int AS count FROM wm_runtime_installation.profile_extension_v6',
            )
          ).rows[0]?.['count'],
      ),
    ).toBe(1);
  },
  120000,
);
fixtureIt(
  'runtime owner membership and elevated session cannot bootstrap or read installation proof',
  async () => {
    await expect(
      session(fresh, (tx) => verifyCurrentRuntimeV6InstalledIn(tx), runtimeRole),
    ).rejects.toThrow('CURRENT_RUNTIME_OWNER_REQUIRED');
    await admin.query(`GRANT "${ownerRole}" TO "${runtimeRole}"`);
    try {
      await expect(
        session(fresh, (tx) => verifyCurrentRuntimeV6InstalledIn(tx), runtimeRole),
      ).rejects.toThrow('CURRENT_RUNTIME_OWNER_REQUIRED');
    } finally {
      await admin.query(`REVOKE "${ownerRole}" FROM "${runtimeRole}"`);
    }
    const u = new URL(adminUrl);
    u.pathname = `/${fresh}`;
    const elevated = new Pool({ connectionString: u.toString() });
    try {
      const tx = await elevated.connect();
      try {
        await expect(verifyCurrentRuntimeV6InstalledIn(tx)).rejects.toThrow(
          'CURRENT_RUNTIME_OWNER_REQUIRED',
        );
      } finally {
        tx.release();
      }
    } finally {
      await elevated.end();
    }
  },
);

fixtureIt(
  'failure after actual132 DDL before receipt rolls back all parent+extension DDL',
  async () => {
    const name = `current_runtime_v6_fail_${suffix}`;
    await base(name);
    await session(name, async (tx) => {
      await tx.query('BEGIN');
      const failure = new Error('synthetic after actual132 DDL');
      try {
        await expect(
          installCurrentRuntimeV6In({
            query: async (sql, values) => {
              const r = await tx.query(sql, values);
              if (sql.startsWith('-- Additive same-RR server-private batch.')) throw failure;
              return { rows: r.rows, rowCount: r.rowCount };
            },
          }),
        ).rejects.toBe(failure);
      } finally {
        await tx.query('ROLLBACK');
      }
    });
    expect(
      await session(
        name,
        async (tx) =>
          (
            await tx.query(
              "SELECT to_regclass('wm_runtime_installation.migration') AS parent,to_regclass('wm_runtime_installation.profile_extension_v6') AS extension,to_regprocedure('public.read_manual_race_retained_source_batch_v1(integer)') AS batch",
            )
          ).rows[0],
      ),
    ).toEqual({ parent: null, extension: null, batch: null });
  },
  120000,
);

fixtureIt(
  'normal non-grant-option runtime EXECUTE permits exact V6 verify/replay; private ledger stays unavailable',
  async () => {
    await rollback(fresh, async (tx) => {
      await tx.query(
        `GRANT EXECUTE ON FUNCTION public.read_manual_race_retained_source_batch_v1(integer) TO "${runtimeRole}"`,
      );
      const before = (
        await tx.query(
          'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v6',
        )
      ).rows;
      const a = await verifyCurrentRuntimeV6InstalledIn(tx),
        b = await installCurrentRuntimeV6In(tx);
      expect(b).toEqual(a);
      expect(
        (
          await tx.query(
            'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v6',
          )
        ).rows,
      ).toEqual(before);
    });
  },
);
fixtureIt(
  'actual132 function body/config/security/PUBLIC or grant-option drift is rejected, with no old receipt rewrite',
  async () => {
    const body = await readFile(
      new URL('../migrations/132_manual_retained_source_export_batch.sql', import.meta.url),
      'utf8',
    );
    for (const mutation of [
      body
        .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION')
        .replace(' RETURN result;', ' RETURN result; -- actual drift'),
      'ALTER FUNCTION public.read_manual_race_retained_source_batch_v1(integer) RESET TimeZone',
      'ALTER FUNCTION public.read_manual_race_retained_source_batch_v1(integer) SECURITY INVOKER',
      'GRANT EXECUTE ON FUNCTION public.read_manual_race_retained_source_batch_v1(integer) TO PUBLIC',
      `GRANT EXECUTE ON FUNCTION public.read_manual_race_retained_source_batch_v1(integer) TO "${runtimeRole}" WITH GRANT OPTION`,
    ])
      await rollback(fresh, async (tx) => {
        await tx.query(mutation);
        await expect(verifyCurrentRuntimeV6InstalledIn(tx)).rejects.toThrow(
          'CURRENT_RUNTIME_V6_BATCH_DRIFT',
        );
      });
  },
);
