import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { verifyCurrentRuntimeInstalledIn } from '../src/current-runtime-installation.js';
import {
  installCurrentRuntimeV3,
  installCurrentRuntimeV3In,
  verifyCurrentRuntimeV3InstalledIn,
} from '../src/current-runtime-installation-v3.js';
import {
  installCurrentRuntimeV2,
  verifyCurrentRuntimeV2InstalledIn,
} from '../src/current-runtime-installation-v2.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual execution only. Synthetic roles/catalog metadata; no health rows.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [],
  databases: string[] = [];
const ownerRole = `current_runtime_v3_owner_${suffix}`,
  runtimeRole = `current_runtime_v3_app_${suffix}`;
const fresh = `current_runtime_v3_fresh_${suffix}`,
  upgrade = `current_runtime_v3_upgrade_${suffix}`;
function url(name: string, role = ownerRole) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function session<T>(name: string, apply: (tx: PoolClient) => Promise<T>, role = ownerRole) {
  const pool = new Pool({ connectionString: url(name, role), max: 1 });
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
  await installCurrentRuntimeV2(url(upgrade));
}, 120000);
afterAll(async () => {
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
    extension128Catalog: (
      await tx.query(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='wm_runtime_installation.profile_extension_v2'::regclass ORDER BY conname",
      )
    ).rows,
    parentReaderMetadata: (
      await tx.query(
        "SELECT p.oid::regprocedure::text AS signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body,p.prosecdef,p.proconfig,p.proacl::text,p.proowner FROM pg_proc p WHERE p.oid IN('public.read_check_in_template_personal_export_v1(integer)'::regprocedure,'public.read_race_manual_personal_export_v1(integer)'::regprocedure) ORDER BY p.oid::regprocedure::text",
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
it('fresh107 applies exact parent17+128 then extension129 without changing the baseline registry', async () => {
  const before = await session(
    fresh,
    async (tx) =>
      (await tx.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version'))
        .rows,
  );
  const result = await installCurrentRuntimeV3(url(fresh));
  expect(result).toMatchObject({
    profileVersion: 3,
    runtimeStep: 19,
    sourceDdlTip: 129,
    parentRuntimeStep: 18,
    supported: false,
    restore: 'not_verified',
  });
  expect((await observe(fresh)).base).toEqual(before);
  expect(result.parentAppliedMembers).toHaveLength(18);
}, 120000);
it('upgrade retains exact v1/v2 row and constraint bytes with17/18 prefix provenance', async () => {
  const before = await observe(upgrade);
  await installCurrentRuntimeV3(url(upgrade));
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
}, 120000);
it('successful replay returns the immutable original extension row without new xid/version', async () => {
  const before = await session(
    fresh,
    async (tx) =>
      (
        await tx.query(
          'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v3',
        )
      ).rows,
  );
  const a = await installCurrentRuntimeV3(url(fresh)),
    b = await installCurrentRuntimeV3(url(fresh));
  expect(b).toEqual(a);
  expect(
    await session(
      fresh,
      async (tx) =>
        (
          await tx.query(
            'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v3',
          )
        ).rows,
    ),
  ).toEqual(before);
});
it('raw129 without a receipt cannot be adopted even with a valid parent18', async () => {
  const name = `current_runtime_v3_raw_${suffix}`;
  await base(name);
  await installCurrentRuntimeV2(url(name));
  await session(name, async (tx) =>
    tx.query(
      await readFile(
        new URL('../migrations/129_manual_internal_retained_export.sql', import.meta.url),
        'utf8',
      ),
    ),
  );
  await expect(installCurrentRuntimeV3(url(name))).rejects.toThrow(
    'CURRENT_RUNTIME_V3_UNREGISTERED_STAGE',
  );
  expect(
    await session(
      name,
      async (tx) =>
        (
          await tx.query(
            "SELECT to_regclass('wm_runtime_installation.profile_extension_v3') AS ledger",
          )
        ).rows[0]?.['ledger'],
    ),
  ).toBeNull();
}, 120000);
it('actual constraints refuse extra step/unknown DDL/wrong parent or source hashes', async () => {
  for (const assignment of [
    'extension_step=2',
    'source_ddl_id=130',
    "source_sha256=repeat('a',64)",
    "parent_manifest_sha256=repeat('b',64)",
    "filename='unknown.sql'",
  ]) {
    await rollback(fresh, async (tx) => {
      await expect(
        tx.query(`UPDATE wm_runtime_installation.profile_extension_v3 SET ${assignment}`),
      ).rejects.toMatchObject({ code: '23514' });
    });
  }
});
it('private ACL, extra column, altered exact CHECK and missing reader each fail closed', async () => {
  for (const sql of [
    `GRANT SELECT ON wm_runtime_installation.profile_extension_v3 TO "${runtimeRole}"`,
    'ALTER TABLE wm_runtime_installation.profile_extension_v3 ADD COLUMN extra text',
    'ALTER TABLE wm_runtime_installation.profile_extension_v3 DROP CONSTRAINT profile_extension_v3_step',
    'DELETE FROM wm_runtime_installation.profile_extension_v3',
  ])
    await rollback(fresh, async (tx) => {
      await tx.query(sql);
      await expect(verifyCurrentRuntimeV3InstalledIn(tx)).rejects.toThrow(
        'CURRENT_RUNTIME_V3_LEDGER_INVALID',
      );
    });
  await rollback(fresh, async (tx) => {
    await tx.query('DROP FUNCTION public.read_manual_race_internal_personal_export_v1(integer)');
    await expect(verifyCurrentRuntimeV3InstalledIn(tx)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_READERS_MISSING',
    );
  });
  await rollback(fresh, async (tx) => {
    await tx.query('ALTER TABLE wm_runtime_installation.profile_extension_v3 SET SCHEMA public');
    await expect(verifyCurrentRuntimeV3InstalledIn(tx)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_UNREGISTERED_STAGE',
    );
  });
  await session(
    fresh,
    async (tx) => {
      await expect(
        tx.query('SELECT * FROM wm_runtime_installation.profile_extension_v3'),
      ).rejects.toMatchObject({ code: '42501' });
    },
    runtimeRole,
  );
});
it('same transaction parent installation and128/129 readers rollback together on caller abort', async () => {
  const name = `current_runtime_v3_abort_${suffix}`;
  await base(name);
  await rollback(name, async (tx) => {
    await installCurrentRuntimeV3In(tx);
    throwIfAbsent(
      (
        await tx.query(
          "SELECT to_regprocedure('public.read_race_manual_personal_export_v1(integer)') AS reader",
        )
      ).rows[0]?.['reader'],
    );
  });
  const after = await session(
    name,
    async (tx) =>
      (
        await tx.query(
          "SELECT to_regclass('wm_runtime_installation.migration') AS parent,to_regclass('wm_runtime_installation.profile_extension_v2') AS parent_extension,to_regclass('wm_runtime_installation.profile_extension_v3') AS extension,to_regprocedure('public.read_manual_race_internal_personal_export_v1(integer)') AS first,to_regprocedure('public.read_race_manual_personal_export_v1(integer)') AS second",
        )
      ).rows[0],
  );
  expect(after).toEqual({
    parent: null,
    parent_extension: null,
    extension: null,
    first: null,
    second: null,
  });
}, 120000);
function throwIfAbsent(value: unknown) {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
}
it('two actual concurrent upgrades serialize to one extension receipt and original results', async () => {
  const name = `current_runtime_v3_concurrent_${suffix}`;
  await base(name);
  await installCurrentRuntimeV2(url(name));
  const [a, b] = await Promise.all([
    installCurrentRuntimeV3(url(name)),
    installCurrentRuntimeV3(url(name)),
  ]);
  expect(a).toEqual(b);
  expect(
    await session(
      name,
      async (tx) =>
        (
          await tx.query(
            'SELECT count(*)::int AS count FROM wm_runtime_installation.profile_extension_v3',
          )
        ).rows[0]?.['count'],
    ),
  ).toBe(1);
}, 120000);
it('runtime owner membership and elevated session cannot bootstrap or read installation proof', async () => {
  await expect(
    session(fresh, (tx) => verifyCurrentRuntimeV3InstalledIn(tx), runtimeRole),
  ).rejects.toThrow('CURRENT_RUNTIME_OWNER_REQUIRED');
  await admin.query(`GRANT "${ownerRole}" TO "${runtimeRole}"`);
  try {
    await expect(
      session(fresh, (tx) => verifyCurrentRuntimeV3InstalledIn(tx), runtimeRole),
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
      await expect(verifyCurrentRuntimeV3InstalledIn(tx)).rejects.toThrow(
        'CURRENT_RUNTIME_OWNER_REQUIRED',
      );
    } finally {
      tx.release();
    }
  } finally {
    await elevated.end();
  }
});

it('failure after actual129 DDL before extension receipt leaves no parent, readers or extension ledger', async () => {
  const name = `current_runtime_v3_fail_${suffix}`;
  await base(name);
  await session(name, async (tx) => {
    await tx.query('BEGIN');
    const failure = new Error('synthetic caller failure after actual129 DDL');
    try {
      await expect(
        installCurrentRuntimeV3In({
          query: async (sql, values) => {
            const result = await tx.query(sql, values);
            if (sql.startsWith('-- Internal retained enumeration only')) throw failure;
            return { rows: result.rows, rowCount: result.rowCount };
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
            "SELECT to_regclass('wm_runtime_installation.migration') AS parent,to_regclass('wm_runtime_installation.profile_extension_v2') AS parent_extension,to_regclass('wm_runtime_installation.profile_extension_v3') AS extension,to_regprocedure('public.read_manual_race_internal_personal_export_v1(integer)') AS first,to_regprocedure('public.read_race_manual_personal_export_v1(integer)') AS second",
          )
        ).rows[0],
    ),
  ).toEqual({ parent: null, parent_extension: null, extension: null, first: null, second: null });
}, 120000);
