import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  grantCurrentRuntimeProfile,
  grantCurrentRuntimeProfileIn,
  currentRuntimeRpcSignatures,
} from '../src/current-runtime-grants.js';
import { installCurrentRuntime } from '../src/current-runtime-installation.js';
import { migrate, grantOperations, grantCorePlanning } from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root-only actual execution: normal107 then the exact17 owner-receipted profile.
// Provisioning is separate from the plain migration owner/application roles.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `current_runtime_grants_${suffix}`,
  ownerRole = `current_runtime_grants_owner_${suffix}`,
  runtimeRole = `current_runtime_grants_app_${suffix}`,
  memberRole = `current_runtime_grants_member_${suffix}`;
const admin = new Pool({ connectionString: adminUrl }),
  roles: string[] = [];
let created = false,
  db: Database | undefined;
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
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function owner<T>(operation: (pool: Pool) => Promise<T>) {
  const p = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    return await operation(p);
  } finally {
    await p.end();
  }
}
it('normal107 cannot obtain current grants or an installation receipt', async () => {
  await expect(grantCurrentRuntimeProfile(url(ownerRole), runtimeRole)).rejects.toThrow(
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
      await expect(grantCurrentRuntimeProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_LEDGER_INVALID',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('validates the exact owner-receipted17 profile and rejects a renamed RPC atomically', async () => {
  await installCurrentRuntime(url(ownerRole));
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        'ALTER FUNCTION public.save_check_in_template_v1(jsonb) RENAME TO displaced_template_rpc',
      );
      await expect(grantCurrentRuntimeProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_RPC_INVALID',
      );
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeRpcSignatures[0],
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
  'GRANT EXECUTE ON FUNCTION public.save_check_in_template_v1(jsonb) TO PUBLIC',
  'ALTER FUNCTION public.save_check_in_template_v1(jsonb) SET search_path=public,pg_temp',
])('rejects unsafe actual RPC catalog mutation without granting: %s', async (mutation) => {
  await owner(async (p) => {
    const tx = await p.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(mutation);
      await expect(grantCurrentRuntimeProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_RPC_INVALID',
      );
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeRpcSignatures[0],
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
              "SELECT pg_get_functiondef('public.read_manual_race_chain_v2(uuid)'::regprocedure) AS definition",
            )
          ).rows[0]?.['definition'],
        );
      const changed = original.replace('BEGIN', 'BEGIN /* synthetic catalog body drift */');
      expect(changed).not.toBe(original);
      await tx.query(changed);
      await expect(grantCurrentRuntimeProfileIn(tx, runtimeRole)).rejects.toThrow(
        'CURRENT_RUNTIME_RPC_INVALID',
      );
      expect(
        (
          await tx.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
            runtimeRole,
            currentRuntimeRpcSignatures[0],
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
  await expect(grantCurrentRuntimeProfile(url(ownerRole), ownerRole)).rejects.toThrow(
    'CURRENT_RUNTIME_UNSAFE_ROLE',
  );
  await admin.query(`GRANT "${ownerRole}" TO "${memberRole}"`);
  try {
    await expect(grantCurrentRuntimeProfile(url(ownerRole), memberRole)).rejects.toThrow(
      'CURRENT_RUNTIME_UNSAFE_ROLE',
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
        grantCurrentRuntimeProfileIn(
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
            currentRuntimeRpcSignatures[0],
          ])
        ).rows[0]?.['allowed'],
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  });
});
it('grants only exact26 functions, is repeatable, and leaves private schema/tables inaccessible', async () => {
  const first = await grantCurrentRuntimeProfile(url(ownerRole), runtimeRole);
  expect(first.grantedFunctions).toHaveLength(26);
  expect(first.processingAuthority).toBe('none');
  expect(await grantCurrentRuntimeProfile(url(ownerRole), runtimeRole)).toEqual(first);
  await owner(async (p) => {
    const observed = await p.query(
      "SELECT signature,has_function_privilege($1,signature,'EXECUTE') AS allowed FROM unnest($2::text[]) signature",
      [runtimeRole, [...currentRuntimeRpcSignatures]],
    );
    expect(observed.rows).toHaveLength(26);
    expect(observed.rows.every((row) => row['allowed'] === true)).toBe(true);
    const privateAccess = await p.query(
      `SELECT has_schema_privilege($1,'wm_runtime_installation','USAGE') AS ledger_schema,
      has_table_privilege($1,'wm_runtime_installation.migration','SELECT') AS ledger,
      has_table_privilege($1,'public.nutrition_race_item_disconnection','SELECT') AS origin,
      has_table_privilege($1,'public.manual_race_evidence_v2','SELECT') AS evidence,
      has_table_privilege($1,'public.check_in_template_version','INSERT') AS template_write,
      has_function_privilege($1,'public.nutrition_v4_wire_schema(text)','EXECUTE') AS private_codec`,
      [runtimeRole],
    );
    expect(privateAccess.rows[0]).toEqual({
      ledger_schema: false,
      ledger: false,
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
it('supports genuine public template save/read/replay after separately composed baseline grants', async () => {
  // Existing base composition remains separate; the new helper supplies only RPC EXECUTE.
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole) });
  const athlete = randomUUID();
  await owner(async (p) => {
    await p.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  });
  const foreignAthlete = randomUUID();
  // Identity FK scaffolding only. All consent/template bodies are produced by
  // the restricted runtime repositories, including the genuine foreign tenant.
  await owner(async (pool) => {
    await pool.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [foreignAthlete, randomUUID()],
    );
  });
  const consent = createConsentRepository(db);
  await consent.setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const repo = createCheckInTemplateRepository(db);
  const command = {
    templateId: randomUUID(),
    expectedVersion: 0,
    idempotencyKey: randomUUID(),
    content: {
      definitionVersion: 'checkin-v1' as const,
      source: 'user' as const,
      method: 'self_report' as const,
      title: 'Public fixture prompts',
      instructions: null,
      fields: ['note'] as const,
    },
  };
  const saved = await repo.save(athlete, command);
  expect(await repo.readExact(athlete, saved.templateId, saved.versionId)).toEqual(saved);
  await consent.setConsent(athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await repo.save(athlete, command)).toEqual(saved);
  expect(await repo.readExact(athlete, saved.templateId, saved.versionId)).toEqual(saved);
  expect(await repo.readExact(foreignAthlete, saved.templateId, saved.versionId)).toBeNull();
});
