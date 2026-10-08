import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  grantCurrentRuntimeV3Profile,
  grantCurrentRuntimeV3ProfileIn,
  currentRuntimeV3RpcSignatures,
} from '../src/current-runtime-grants-v3.js';
import { migrate } from '../src/migrate.js';
import { installCurrentRuntimeV2 } from '../src/current-runtime-installation-v2.js';
import { installCurrentRuntimeV3 } from '../src/current-runtime-installation-v3.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root-only actual execution: normal107 → exact18 parent → exact129 extension.
// Metadata/ACL evidence only: no health data, supported capability or restore proof.
// Provisioning is separate from the plain migration owner/application roles.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `current_runtime_grants_v3_${suffix}`,
  ownerRole = `current_runtime_grants_v3_owner_${suffix}`,
  runtimeRole = `current_runtime_grants_v3_app_${suffix}`,
  memberRole = `current_runtime_grants_v3_member_${suffix}`;
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
  for (const role of [ownerRole, runtimeRole, memberRole]) {
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
  const p = new Pool({ connectionString: u.toString(), max: 1 });
  try {
    return await operation(p);
  } finally {
    await p.end();
  }
}
async function owner<T>(operation: (pool: Pool) => Promise<T>) {
  const p = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    return await operation(p);
  } finally {
    await p.end();
  }
}
it('normal107 cannot obtain current grants or an installation receipt', async () => {
  await expect(grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
    'CURRENT_RUNTIME_LEDGER_INVALID',
  );
  await owner(async (p) =>
    expect(
      (await p.query("SELECT to_regclass('wm_runtime_installation.migration') AS ledger"))
        .rows[0]?.['ledger'],
    ).toBeNull(),
  );
});
it('raw108 without a ledger fails closed without adopting staged DDL', async () => {
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        await readFile(
          new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
          'utf8',
        ),
      );
      await expect(grantCurrentRuntimeV3ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_LEDGER_INVALID',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('validates the exact owner-receipted19 profile and rejects a renamed RPC atomically', async () => {
  await installCurrentRuntimeV2(url(ownerRole));
  await expect(grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
    'CURRENT_RUNTIME_V3_LEDGER_INVALID',
  );
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        await readFile(
          new URL('../migrations/129_manual_internal_retained_export.sql', import.meta.url),
          'utf8',
        ),
      );
      await expect(grantCurrentRuntimeV3ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_V3_UNREGISTERED_STAGE',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
  await installCurrentRuntimeV3(url(ownerRole));
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        'ALTER FUNCTION public.save_check_in_template_v1(jsonb) RENAME TO displaced_template_rpc',
      );
      await expect(grantCurrentRuntimeV3ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_V3_RPC_INVALID',
      );
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeV3RpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
}, 120000);
it.each([
  'GRANT EXECUTE ON FUNCTION public.read_manual_race_internal_personal_export_v1(integer) TO PUBLIC',
  'ALTER FUNCTION public.read_manual_race_internal_personal_export_v1(integer) SET search_path=public,pg_temp',
])('rejects unsafe actual RPC catalog mutation without granting: %s', async (mutation) => {
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(mutation);
      await expect(grantCurrentRuntimeV3ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_V3_RPC_INVALID',
      );
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeV3RpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('rejects function body drift despite the unchanged exact installation ledger', async () => {
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      const original = z
        .string()
        .parse(
          (
            await tx.query(
              "SELECT pg_get_functiondef('public.read_manual_race_internal_personal_export_v1(integer)'::regprocedure) AS definition",
            )
          ).rows[0]?.['definition'],
        );
      const changed = original.replace('BEGIN', 'BEGIN /* synthetic catalog body drift */');
      expect(changed).not.toBe(original);
      await tx.query(changed);
      await expect(grantCurrentRuntimeV3ProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_V3_RPC_INVALID',
      );
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeV3RpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('rejects owner and transitive owner membership without changing grants', async () => {
  await expect(grantCurrentRuntimeV3Profile(url(ownerRole), ownerRole)).rejects.toThrow(
    'CURRENT_RUNTIME_V3_UNSAFE_ROLE',
  );
  await admin.query(`GRANT "${ownerRole}" TO "${memberRole}"`);
  try {
    await expect(grantCurrentRuntimeV3Profile(url(ownerRole), memberRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_UNSAFE_ROLE',
    );
  } finally {
    await admin.query(`REVOKE "${ownerRole}" FROM "${memberRole}"`);
  }
});
it('rolls back earlier real GRANT statements when a later boundary operation fails', async () => {
  await owner(async (p) => {
    const tx = await p.connect();
    let grants = 0;
    try {
      await tx.query('BEGIN');
      await expect(
        grantCurrentRuntimeV3ProfileIn(
          {
            query: async (sql, values) => {
              if (sql.startsWith('GRANT') && ++grants === 2)
                throw new Error('synthetic deployment interruption');
              return tx.query(sql, values);
            },
          },
          runtimeRole,
        ),
      ).rejects.toThrow('synthetic deployment interruption');
      await tx.query('ROLLBACK');
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeV3RpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it.each([
  { mutation: 'GRANT CREATE ON SCHEMA public TO', code: 'CURRENT_RUNTIME_V3_UNSAFE_ROLE' },
  {
    mutation: 'GRANT USAGE ON SCHEMA wm_runtime_installation TO',
    code: 'CURRENT_RUNTIME_LEDGER_INVALID',
  },
  {
    mutation: 'GRANT SELECT ON wm_runtime_installation.profile_extension_v3 TO',
    code: 'CURRENT_RUNTIME_V3_LEDGER_INVALID',
  },
])('rejects actual schema/private-ledger capability $mutation', async ({ mutation, code }) => {
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(`${mutation} "${runtimeRole}"`);
      await expect(grantCurrentRuntimeV3ProfileIn(tx, runtimeRole)).rejects.toThrow(code);
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeV3RpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('rejects built-in data-reading membership and runtime-owned namespace/function metadata', async () => {
  await admin.query(`GRANT pg_read_all_data TO "${runtimeRole}"`);
  try {
    await expect(grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_UNSAFE_ROLE',
    );
  } finally {
    await admin.query(`REVOKE pg_read_all_data FROM "${runtimeRole}"`);
  }
  // Synthetic catalog-only ownership, no product/source rows.
  await provisioned((p) =>
    p.query(`CREATE SCHEMA runtime_owned_catalog AUTHORIZATION "${runtimeRole}"`),
  );
  try {
    await expect(grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_UNSAFE_ROLE',
    );
  } finally {
    await provisioned((p) => p.query('DROP SCHEMA runtime_owned_catalog'));
  }
  // Admin provisioner can transfer a disposable metadata-only function. This
  // negative never supplies source authority or changes a product function.
  await provisioned((p) =>
    p.query(`CREATE SCHEMA runtime_owned_function AUTHORIZATION "${ownerRole}"`),
  );
  try {
    await owner((p) =>
      p.query(`GRANT USAGE,CREATE ON SCHEMA runtime_owned_function TO "${runtimeRole}"`),
    );
    const runtime = new Pool({ connectionString: url(runtimeRole) });
    try {
      await runtime.query(
        "CREATE FUNCTION runtime_owned_function.synthetic() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      );
    } finally {
      await runtime.end();
    }
    await owner((p) =>
      p.query(`REVOKE CREATE ON SCHEMA runtime_owned_function FROM "${runtimeRole}"`),
    );
    await expect(grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V3_UNSAFE_ROLE',
    );
  } finally {
    await provisioned((p) => p.query('DROP SCHEMA runtime_owned_function CASCADE'));
  }
});
it('grants only exact29 functions, is repeatable, and leaves private schema/tables inaccessible', async () => {
  const first = await grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole);
  expect(first.grantedFunctions).toHaveLength(29);
  expect(first.processingAuthority).toBe('none');
  expect(await grantCurrentRuntimeV3Profile(url(ownerRole), runtimeRole)).toEqual(first);
  await owner(async (p) => {
    const observed = await p.query(
      "SELECT signature,has_function_privilege($1,signature,'EXECUTE') AS allowed FROM unnest($2::text[]) signature",
      [runtimeRole, [...currentRuntimeV3RpcSignatures]],
    );
    expect(observed.rows).toHaveLength(29);
    expect(observed.rows.every((row) => row['allowed'] === true)).toBe(true);
    const privateAccess = await p.query(
      `SELECT has_schema_privilege($1,'wm_runtime_installation','USAGE') AS ledger_schema,
      has_table_privilege($1,'wm_runtime_installation.migration','SELECT') AS ledger,
      has_table_privilege($1,'wm_runtime_installation.profile_extension_v2','SELECT') AS parent_extension_ledger,
      has_table_privilege($1,'wm_runtime_installation.profile_extension_v3','SELECT') AS extension_ledger,
      has_table_privilege($1,'public.nutrition_race_item_disconnection','SELECT') AS origin,
      has_table_privilege($1,'public.manual_race_evidence_v2','SELECT') AS evidence,
      has_table_privilege($1,'public.check_in_template_version','INSERT') AS template_write,
      has_function_privilege($1,'public.nutrition_v4_wire_schema(text)','EXECUTE') AS private_codec`,
      [runtimeRole],
    );
    expect(privateAccess.rows[0]).toEqual({
      ledger_schema: false,
      ledger: false,
      extension_ledger: false,
      parent_extension_ledger: false,
      origin: false,
      evidence: false,
      template_write: false,
      private_codec: false,
    });
  });
  const runtime = new Pool({ connectionString: url(runtimeRole) });
  try {
    await expect(
      runtime.query('SELECT * FROM wm_runtime_installation.migration'),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await runtime.end();
  }
});
