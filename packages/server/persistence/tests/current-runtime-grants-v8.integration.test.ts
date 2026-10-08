import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  grantCurrentRuntimeV8Profile,
  grantCurrentRuntimeV8ProfileIn,
  currentRuntimeV8RpcSignatures,
  currentRuntimeV8OwnerOnlyPublicHelpers,
  currentRuntimeV8PrivateHelpers,
} from '../src/current-runtime-grants-v8.js';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV7 } from '../src/current-runtime-installation-v7.js';
import { installCurrentRuntimeV8 } from '../src/current-runtime-installation-v8.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root-only post141 preparation: normal107 → namedV7/profile23 → namedV8/profile24.
// Exact physical8/member24/private12 installer pins; historical end140 is rejected.
// Metadata/ACL evidence only: no health data, supported capability or restore proof.
// Provisioning is separate from the plain migration owner/application roles.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `current_runtime_grants_v8_${suffix}`,
  ownerRole = `current_runtime_grants_v8_owner_${suffix}`,
  runtimeRole = `current_runtime_grants_v8_app_${suffix}`,
  memberRole = `current_runtime_grants_v8_member_${suffix}`,
  workerRole = `current_runtime_grants_v8_worker_${suffix}`;
const admin = new Pool({ connectionString: adminUrl }),
  roles: string[] = [];
let created = false;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, memberRole, workerRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
}, 120000);
afterAll(async () => {
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function provisioned<T>(operation: (pool: Pool) => Promise<T>) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const p = new Pool({
    connectionString: u.toString(),
    max: 1,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  try {
    return await operation(p);
  } finally {
    await p.end();
  }
}
async function owner<T>(operation: (pool: Pool) => Promise<T>) {
  const p = new Pool({
    connectionString: url(ownerRole),
    max: 1,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  try {
    return await operation(p);
  } finally {
    await p.end();
  }
}
it('normal107 and parent23 cannot obtain V8 grants', async () => {
  await expect(grantCurrentRuntimeV8Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
    'CURRENT_RUNTIME_LEDGER_INVALID',
  );
  await installCurrentRuntimeV7(url(ownerRole));
  await expect(grantCurrentRuntimeV8Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
    'CURRENT_RUNTIME_V8_LEDGER_INVALID',
  );
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        await readFile(
          new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
          'utf8',
        ),
      );
      await expect(grantCurrentRuntimeV8ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_V8_LEDGER_INVALID',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
  await installCurrentRuntimeV8(url(ownerRole));
}, 120000);
async function rollbackMutation(sql: string, expected: string) {
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(sql);
      let attemptedGrants = 0;
      await expect(
        grantCurrentRuntimeV8ProfileIn(
          {
            query: async (sql, values) => {
              if (sql.startsWith('GRANT')) attemptedGrants++;
              return tx.query(sql, values);
            },
          },
          runtimeRole,
        ),
      ).rejects.toThrow(expected);
      expect(attemptedGrants).toBe(0);
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeV8RpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
}
it.each([
  [
    'GRANT EXECUTE ON FUNCTION public.read_manual_race_pooled_chain_v1(uuid) TO PUBLIC',
    'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
  ],
  [
    'ALTER FUNCTION public.read_manual_race_pooled_chain_v1(uuid) SET search_path=public,pg_temp',
    'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
  ],
  [
    `GRANT EXECUTE ON FUNCTION public.read_manual_race_pooled_chain_v1(uuid) TO "${memberRole}" WITH GRANT OPTION`,
    'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
  ],
  [
    `GRANT EXECUTE ON FUNCTION public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb) TO "${runtimeRole}"`,
    'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
  ],
  [
    `GRANT EXECUTE ON FUNCTION wm_manual_pooled.relative_membership_validated_local_v1(jsonb) TO "${runtimeRole}"`,
    'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
  ],
  [
    `GRANT USAGE ON SCHEMA wm_manual_pooled TO "${runtimeRole}"`,
    'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
  ],
  [
    `GRANT SELECT ON wm_runtime_installation.profile_extension_v8 TO "${runtimeRole}"`,
    'CURRENT_RUNTIME_V8_LEDGER_INVALID',
  ],
  [
    `GRANT SELECT(extension_step) ON wm_runtime_installation.profile_extension_v8 TO "${runtimeRole}"`,
    'CURRENT_RUNTIME_V8_LEDGER_INVALID',
  ],
  [
    'CREATE TABLE wm_runtime_installation.profile_extension_future(id integer)',
    // Installer presence rejects an unknown ledger before the role guard.
    'CURRENT_RUNTIME_V8_LEDGER_INVALID',
  ],
  [`GRANT CREATE ON SCHEMA public TO "${runtimeRole}"`, 'CURRENT_RUNTIME_V8_UNSAFE_ROLE'],
  [
    `GRANT EXECUTE ON FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz) TO "${runtimeRole}"`,
    'CURRENT_RUNTIME_V8_UNSAFE_ROLE',
  ],
  [
    `CREATE TABLE wm_manual_pooled.synthetic_private_pool(secret text); GRANT SELECT(secret) ON wm_manual_pooled.synthetic_private_pool TO "${runtimeRole}"`,
    'CURRENT_RUNTIME_V8_UNSAFE_ROLE',
  ],
  [
    'GRANT EXECUTE ON FUNCTION wm_manual_pooled.validate_recipes_validated_local_v1(jsonb,jsonb) TO PUBLIC',
    'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
  ],
])('rejects unsafe actual ACL/catalog mutation %s', async (mutation, code) =>
  rollbackMutation(mutation, code),
);
it('body drift is rejected before any grant', async () => {
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      const original = z
        .string()
        .parse(
          (
            await tx.query(
              "SELECT pg_get_functiondef('public.read_manual_race_pooled_chain_v1(uuid)'::regprocedure) AS definition",
            )
          ).rows[0]?.['definition'],
        );
      const changed = original.replace('BEGIN', 'BEGIN /* synthetic metadata drift */');
      expect(changed).not.toBe(original);
      await tx.query(changed);
      await expect(grantCurrentRuntimeV8ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_V8_FUNCTION_DRIFT',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('owner membership, worker inheritance and built-in data roles fail closed', async () => {
  await expect(grantCurrentRuntimeV8Profile(url(ownerRole), ownerRole)).rejects.toThrow(
    'CURRENT_RUNTIME_V8_UNSAFE_ROLE',
  );
  for (const role of [ownerRole, 'pg_read_all_data']) {
    await admin.query(`GRANT "${role}" TO "${runtimeRole}"`);
    try {
      await expect(grantCurrentRuntimeV8Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_V8_UNSAFE_ROLE',
      );
    } finally {
      await admin.query(`REVOKE "${role}" FROM "${runtimeRole}"`);
    }
  }
  await owner((p) =>
    p.query(
      `GRANT EXECUTE ON FUNCTION public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz) TO "${workerRole}"`,
    ),
  );
  await admin.query(`GRANT "${workerRole}" TO "${runtimeRole}"`);
  try {
    await expect(grantCurrentRuntimeV8Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V8_UNSAFE_ROLE',
    );
  } finally {
    await admin.query(`REVOKE "${workerRole}" FROM "${runtimeRole}"`);
  }
});
it('BYPASSRLS runtime flag is refused', async () => {
  await admin.query(`ALTER ROLE "${runtimeRole}" BYPASSRLS`);
  try {
    await expect(grantCurrentRuntimeV8Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V8_UNSAFE_ROLE',
    );
  } finally {
    await admin.query(`ALTER ROLE "${runtimeRole}" NOBYPASSRLS`);
  }
});
it('unsafe deployment sessions and SET ROLE cannot issue grants', async () => {
  await expect(grantCurrentRuntimeV8Profile(url(runtimeRole), memberRole)).rejects.toThrow(
    'CURRENT_RUNTIME_OWNER_REQUIRED',
  );
  await provisioned(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(`SET LOCAL ROLE "${ownerRole}"`);
      await expect(grantCurrentRuntimeV8ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_OWNER_REQUIRED',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('a later GRANT fault rolls back every earlier grant', async () => {
  await owner(async (p) => {
    const tx = await p.connect();
    let grants = 0;
    try {
      await tx.query('BEGIN');
      await expect(
        grantCurrentRuntimeV8ProfileIn(
          {
            query: async (sql, values) => {
              if (sql.startsWith('GRANT') && ++grants === 2)
                throw new Error('DEPLOYMENT_INTERRUPTED');
              return tx.query(sql, values);
            },
          },
          runtimeRole,
        ),
      ).rejects.toThrow('DEPLOYMENT_INTERRUPTED');
      await tx.query('ROLLBACK');
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [
            runtimeRole,
            currentRuntimeV8RpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('exact41 grants serialize, preserve all old receipts and leave helpers/private tables inaccessible', async () => {
  const ledgerUnion = [
    'migration',
    ...Array.from({ length: 7 }, (_, i) => `profile_extension_v${i + 2}`),
  ]
    .map(
      (table) =>
        `SELECT '${table}' family,to_jsonb(t) receipt,xmin::text xmin FROM wm_runtime_installation.${table} t`,
    )
    .join(' UNION ALL ');
  const ledgerSql = `SELECT * FROM (${ledgerUnion}) AS receipts ORDER BY family,receipt::text`;
  const before = await owner(async (p) => (await p.query(ledgerSql)).rows);
  await owner((p) => p.query(`GRANT SELECT,INSERT ON public.plan_snapshot TO "${runtimeRole}"`));
  const [a, b] = await Promise.all([
    grantCurrentRuntimeV8Profile(url(ownerRole), runtimeRole),
    grantCurrentRuntimeV8Profile(url(ownerRole), runtimeRole),
  ]);
  expect(a).toEqual(b);
  expect(a.grantedFunctions).toHaveLength(41);
  expect(a.supported).toBe(false);
  expect(await owner(async (p) => (await p.query(ledgerSql)).rows)).toEqual(before);
  await owner(async (p) => {
    const all = await p.query(
      "SELECT signature,has_function_privilege($1,signature,'EXECUTE') allowed FROM unnest($2::text[]) signature",
      [runtimeRole, [...currentRuntimeV8RpcSignatures]],
    );
    expect(all.rows).toHaveLength(41);
    expect(all.rows.every((r) => r['allowed'] === true)).toBe(true);
    const helpers = await p.query(
      "SELECT signature,has_function_privilege($1,signature,'EXECUTE') allowed FROM unnest($2::text[]) signature",
      [runtimeRole, [...currentRuntimeV8OwnerOnlyPublicHelpers, ...currentRuntimeV8PrivateHelpers]],
    );
    expect(helpers.rows).toHaveLength(16);
    expect(helpers.rows.every((r) => r['allowed'] === false)).toBe(true);
    expect(
      (
        await p.query(
          "SELECT has_schema_privilege($1,'wm_manual_pooled','USAGE') pool,has_schema_privilege($1,'wm_runtime_installation','USAGE') ledger,has_table_privilege($1,'public.plan_snapshot','SELECT') read,has_table_privilege($1,'public.plan_snapshot','INSERT') append,has_table_privilege($1,'public.plan_snapshot','UPDATE') update,has_table_privilege($1,'public.plan_snapshot','DELETE') delete",
          [runtimeRole],
        )
      ).rows[0],
    ).toEqual({
      pool: false,
      ledger: false,
      read: true,
      append: true,
      update: false,
      delete: false,
    });
  });
}, 120000);
