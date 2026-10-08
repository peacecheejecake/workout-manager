import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';

import {
  installCurrentRuntimeV6,
  verifyCurrentRuntimeV6InstalledIn,
} from '../src/current-runtime-installation-v6.js';
import {
  installCurrentRuntimeV7,
  installCurrentRuntimeV7In,
  verifyCurrentRuntimeV7InstalledIn,
  currentRuntimeV7FunctionTransitions,
  currentRuntimeV7ExtensionMember,
  currentRuntimeV7ParentManifestSha256,
} from '../src/current-runtime-installation-v7.js';
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
const ownerRole = `current_runtime_v7_owner_${suffix}`,
  runtimeRole = `current_runtime_v7_app_${suffix}`;
const fresh = `current_runtime_v7_fresh_${suffix}`,
  upgrade = `current_runtime_v7_upgrade_${suffix}`;
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
  await installCurrentRuntimeV6(url(upgrade));
}, 120000);
afterAll(async () => {
  await Promise.allSettled([...pendingFixtureWork]);
  for (const name of databases.reverse()) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

const ledgerNames = [
  'migration',
  'profile_extension_v2',
  'profile_extension_v3',
  'profile_extension_v4',
  'profile_extension_v5',
  'profile_extension_v6',
];
async function historical(name: string) {
  return session(name, async (tx) => {
    const ledgers = [];
    for (const ledger of ledgerNames) {
      ledgers.push({
        name: ledger,
        rows: (
          await tx.query(
            `SELECT *,xmin::text AS transaction FROM wm_runtime_installation.${ledger} ORDER BY 1`,
          )
        ).rows,
      });
    }
    return {
      ledgers,
      baseline: (
        await tx.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version')
      ).rows,
      catalog: (
        await tx.query(
          `SELECT c.relname,c.relowner,c.relacl::text,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_class c LEFT JOIN pg_constraint k ON k.conrelid=c.oid WHERE c.relnamespace='wm_runtime_installation'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname`,
          [ledgerNames],
        )
      ).rows,
      readers: (
        await tx.query(
          `SELECT p.oid::regprocedure::text AS signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body,p.prosecdef,p.proconfig,p.proacl::text,p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY signature`,
          [
            [
              'read_check_in_template_personal_export_v1',
              'read_race_manual_personal_export_v1',
              'read_manual_race_internal_personal_export_v1',
              'read_manual_race_source_personal_export_v1',
              'read_nutrition_disconnection_personal_export_v1',
              'ack_manual_race_same_tx_parent_v1',
              'read_manual_race_retained_source_batch_v1',
            ],
          ],
        )
      ).rows,
    };
  });
}
async function functions(name: string) {
  return session(
    name,
    async (tx) =>
      (
        await tx.query(
          `SELECT p.oid::regprocedure::text AS signature,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS body,encode(sha256(convert_to((to_jsonb(p)-'prosrc')::text,'UTF8')),'hex') AS metadata FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure,'public.assert_nutrition_disconnect_body(jsonb)'::regprocedure]) ORDER BY signature`,
        )
      ).rows,
  );
}
async function rollback(name: string, run: (tx: PoolClient) => Promise<void>) {
  return session(name, async (tx) => {
    await tx.query('BEGIN');
    try {
      await run(tx);
    } finally {
      await tx.query('ROLLBACK');
    }
  });
}
fixtureIt(
  'fresh107 installs exact parent22 and immutable profile23 without advertising support',
  async () => {
    const baseline = await session(
      fresh,
      async (tx) =>
        (await tx.query('SELECT version,checksum FROM public.schema_migrations ORDER BY version'))
          .rows,
    );
    const result = await installCurrentRuntimeV7(url(fresh));
    expect(result).toMatchObject({
      profileVersion: 7,
      runtimeStep: 23,
      sourceDdlTip: 133,
      parentRuntimeStep: 22,
      supported: false,
      processingAuthority: 'none',
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
    });
    expect(result.parentAppliedMembers).toHaveLength(22);
    expect(
      await session(
        fresh,
        async (tx) =>
          (await tx.query('SELECT * FROM wm_runtime_installation.profile_extension_v7')).rows,
      ),
    ).toEqual([
      {
        extension_step: 1,
        source_ddl_id: 133,
        filename: currentRuntimeV7ExtensionMember.filename,
        source_sha256: currentRuntimeV7ExtensionMember.sha256,
        parent_manifest_sha256: currentRuntimeV7ParentManifestSha256,
      },
    ]);

    expect((await historical(fresh)).baseline).toEqual(baseline);
    const rows = await functions(fresh);
    for (const transition of currentRuntimeV7FunctionTransitions)
      expect(rows).toContainEqual(
        expect.objectContaining({
          signature: transition.signature.replace('public.', ''),
          body: transition.successorSha256,
        }),
      );
  },
);
fixtureIt(
  'upgrade preserves historical22 receipts constraints ACL and source128 through132 readers',
  async () => {
    const before = await historical(upgrade),
      beforeFunctions = await functions(upgrade);
    await installCurrentRuntimeV7(url(upgrade));
    expect(await historical(upgrade)).toEqual(before);
    expect((await functions(upgrade)).map((r) => r['metadata'])).toEqual(
      beforeFunctions.map((r) => r['metadata']),
    );
    expect(await session(upgrade, verifyCurrentRuntimeV6InstalledIn)).toMatchObject({
      runtimeStep: 22,
      sourceDdlTip: 132,
      supported: false,
    });
  },
);
fixtureIt('repeated23 verification returns original receipt without changing xmin', async () => {
  const read = () =>
    session(
      fresh,
      async (tx) =>
        (
          await tx.query(
            'SELECT *,xmin::text AS transaction FROM wm_runtime_installation.profile_extension_v7',
          )
        ).rows,
    );
  const before = await read();
  expect(await installCurrentRuntimeV7(url(fresh))).toEqual(
    await installCurrentRuntimeV7(url(fresh)),
  );
  expect(await read()).toEqual(before);
});
fixtureIt('raw133 without exact receipt cannot be adopted', async () => {
  const name = `current_runtime_v7_raw_${suffix}`;
  await base(name);
  await installCurrentRuntimeV6(url(name));
  await session(name, async (tx) =>
    tx.query(
      await readFile(
        new URL('../migrations/133_nutrition_v4_indexed_application.sql', import.meta.url),
        'utf8',
      ),
    ),
  );
  await expect(installCurrentRuntimeV7(url(name))).rejects.toThrow(
    'CURRENT_RUNTIME_V7_UNREGISTERED_STAGE',
  );
  expect(
    await session(
      name,
      async (tx) =>
        (
          await tx.query(
            "SELECT to_regclass('wm_runtime_installation.profile_extension_v7') AS ledger",
          )
        ).rows[0],
    ),
  ).toEqual({ ledger: null });
});
fixtureIt(
  'both final function bodies fail closed independently on metadata-only body drift',
  async () => {
    for (const transition of currentRuntimeV7FunctionTransitions)
      await rollback(fresh, async (tx) => {
        const r = await tx.query<{ definition: string; body: string }>(
          'SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS body FROM pg_proc p WHERE p.oid=to_regprocedure($1)',
          [transition.signature],
        );
        const row = r.rows[0];
        if (!row) throw new Error('fixture function missing');
        await tx.query(
          row.definition.replace(row.body, `${row.body}\n-- synthetic catalog-only drift`),
        );
        await expect(verifyCurrentRuntimeV7InstalledIn(tx)).rejects.toThrow(
          'CURRENT_RUNTIME_V7_FUNCTION_DRIFT',
        );
      });
  },
);
fixtureIt('function config and PUBLIC execute drift each fail closed and rollback', async () => {
  for (const sql of [
    'ALTER FUNCTION public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb) RESET ALL',
    'GRANT EXECUTE ON FUNCTION public.assert_nutrition_disconnect_body(jsonb) TO PUBLIC',
  ])
    await rollback(fresh, async (tx) => {
      await tx.query(sql);
      await expect(verifyCurrentRuntimeV7InstalledIn(tx)).rejects.toThrow(
        'CURRENT_RUNTIME_V7_FUNCTION_DRIFT',
      );
    });
});
fixtureIt(
  'private ledger ACL columns constraints and absent receipt each fail closed',
  async () => {
    for (const sql of [
      `GRANT SELECT ON wm_runtime_installation.profile_extension_v7 TO "${runtimeRole}"`,
      'ALTER TABLE wm_runtime_installation.profile_extension_v7 ADD COLUMN extra text',
      'ALTER TABLE wm_runtime_installation.profile_extension_v7 DROP CONSTRAINT profile_extension_v7_step',
      'DELETE FROM wm_runtime_installation.profile_extension_v7',
    ])
      await rollback(fresh, async (tx) => {
        await tx.query(sql);
        await expect(verifyCurrentRuntimeV7InstalledIn(tx)).rejects.toThrow(
          'CURRENT_RUNTIME_V7_LEDGER_INVALID',
        );
      });
    for (const assignment of [
      'extension_step=2',
      'source_ddl_id=134',
      "filename='unknown.sql'",
      "source_sha256=repeat('a',64)",
      "parent_manifest_sha256=repeat('b',64)",
    ])
      await rollback(fresh, async (tx) => {
        await expect(
          tx.query(`UPDATE wm_runtime_installation.profile_extension_v7 SET ${assignment}`),
        ).rejects.toMatchObject({ code: '23514' });
      });
  },
);
fixtureIt(
  'failure after actual133 restores both predecessor bodies metadata and removes V7 receipt',
  async () => {
    const name = `current_runtime_v7_abort_${suffix}`;
    await base(name);
    await installCurrentRuntimeV6(url(name));
    const before = await historical(name),
      oldFunctions = await functions(name),
      failure = new Error('synthetic after actual133 DDL');
    await rollback(name, async (tx) => {
      await expect(
        installCurrentRuntimeV7In({
          query: async (sql, values) => {
            const r = await tx.query(sql, values);
            if (sql.startsWith('-- Exact SQL118 nutrition V4 successor')) throw failure;
            return { rows: r.rows, rowCount: r.rowCount };
          },
        }),
      ).rejects.toBe(failure);
    });
    expect(await historical(name)).toEqual(before);
    expect(await functions(name)).toEqual(oldFunctions);
    expect(
      await session(
        name,
        async (tx) =>
          (
            await tx.query(
              "SELECT to_regclass('wm_runtime_installation.profile_extension_v7') AS ledger",
            )
          ).rows[0],
      ),
    ).toEqual({ ledger: null });
  },
);
fixtureIt('two concurrent actual upgrades serialize to one immutable receipt', async () => {
  const name = `current_runtime_v7_concurrent_${suffix}`;
  await base(name);
  await installCurrentRuntimeV6(url(name));
  const [a, b] = await Promise.all([
    installCurrentRuntimeV7(url(name)),
    installCurrentRuntimeV7(url(name)),
  ]);
  expect(a).toEqual(b);
  expect(
    await session(
      name,
      async (tx) =>
        (
          await tx.query(
            'SELECT count(*)::int AS count FROM wm_runtime_installation.profile_extension_v7',
          )
        ).rows[0],
    ),
  ).toEqual({ count: 1 });
});
fixtureIt(
  'runtime role and owner membership cannot install or verify private profile23',
  async () => {
    await expect(session(fresh, verifyCurrentRuntimeV7InstalledIn, runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_OWNER_REQUIRED',
    );
    await expect(installCurrentRuntimeV7(url(fresh, runtimeRole))).rejects.toThrow(
      'CURRENT_RUNTIME_OWNER_REQUIRED',
    );
    await admin.query(`GRANT "${ownerRole}" TO "${runtimeRole}"`);
    try {
      await expect(session(fresh, verifyCurrentRuntimeV7InstalledIn, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_OWNER_REQUIRED',
      );
    } finally {
      await admin.query(`REVOKE "${ownerRole}" FROM "${runtimeRole}"`);
    }
    await session(
      fresh,
      async (tx) => {
        await expect(
          tx.query('SELECT * FROM wm_runtime_installation.profile_extension_v7'),
        ).rejects.toMatchObject({ code: '42501' });
      },
      runtimeRole,
    );
  },
);

fixtureIt(
  'fresh107 parent22 and both133 replacements roll back together on caller abort',
  async () => {
    const name = `current_runtime_v7_parent_abort_${suffix}`;
    await base(name);
    await rollback(name, async (tx) => {
      await installCurrentRuntimeV7In(tx);
      expect(
        (
          await tx.query(
            "SELECT to_regclass('wm_runtime_installation.profile_extension_v7') AS ledger",
          )
        ).rows[0]?.['ledger'],
      ).not.toBeNull();
    });
    expect(
      await session(
        name,
        async (tx) =>
          (
            await tx.query(
              "SELECT to_regclass('wm_runtime_installation.migration') AS parent,to_regclass('wm_runtime_installation.profile_extension_v7') AS extension,to_regprocedure('public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)') AS writer",
            )
          ).rows[0],
      ),
    ).toEqual({ parent: null, extension: null, writer: null });
  },
);
