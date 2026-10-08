import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as baseline from '../src/migrate.js';
import { installCurrentRuntime } from '../src/current-runtime-installation.js';
import { grantCurrentRuntimeProfile } from '../src/current-runtime-grants.js';
import {
  captureCurrentRuntimeCatalogWitnessIn,
  parseCurrentRuntimeCatalogWitness,
} from '../src/current-runtime-catalog-witness.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Metadata only. Root executes PostgreSQL; this fixture creates no health/source
// rows and invokes no product RPC. Observed equality is not dependency closure.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = ['a', 'b'].map((label) => ({
  database: `current_runtime_catalog_${label}_${suffix}`,
  owner: `current_runtime_catalog_owner_${label}_${suffix}`,
  runtime: `current_runtime_catalog_app_${label}_${suffix}`,
}));
const first = z
  .strictObject({ database: z.string(), owner: z.string(), runtime: z.string() })
  .parse(environments[0]);
const unknownRole = `current_runtime_catalog_other_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [],
  databases: string[] = [];
type Environment = (typeof environments)[number];
function url(environment: Environment, role = environment.owner) {
  const value = new URL(adminUrl);
  value.pathname = `/${environment.database}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function session<T>(
  environment: Environment,
  role: string,
  apply: (tx: PoolClient) => Promise<T>,
) {
  const pool = new Pool({ connectionString: url(environment, role), max: 1 });
  const tx = await pool.connect();
  try {
    return await apply(tx);
  } finally {
    tx.release();
    await pool.end();
  }
}
// Named app-only recipe copied from scripts/identity-e2e.mts:835-836,869-892,
// 944-957. Worker roles and fixture-only analysis INSERT/catalog publication are
// deliberately absent. This is an observed fixture recipe, not compiled authority.
const appRecipe = [
  baseline.grantIdentityFunctions,
  baseline.grantAiSettings,
  baseline.grantOperations,
  baseline.grantNutritionCore,
  baseline.grantSupplementaryCore,
  baseline.grantRoutineCore,
  baseline.grantStretchingCore,
  baseline.grantRecoveryCore,
  baseline.grantCheckIns,
  baseline.grantSessionCompletions,
  baseline.grantPlanScenarios,
  baseline.grantCoachingConstraints,
  baseline.grantCoachingThreads,
  baseline.grantCoreEvidenceSnapshots,
  baseline.grantCoachingRuns,
  baseline.grantCoachingCandidates,
  baseline.grantIntegratedApprovalV4,
  baseline.grantResources,
  baseline.grantResourceRetrieval,
  baseline.grantGalleryMedia,
  baseline.grantActivityTracks,
  baseline.grantCourses,
  baseline.grantRaces,
  baseline.grantCorePlanning,
  baseline.grantGarmin,
  baseline.grantGarminUnofficial,
];
beforeAll(async () => {
  // Complete both environments first: actual clusterRoleCount cannot change
  // merely because the second fixture role was provisioned between captures.
  for (const role of [...environments.flatMap((e) => [e.owner, e.runtime]), unknownRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  for (const environment of environments) {
    await admin.query(`CREATE DATABASE "${environment.database}" OWNER "${environment.owner}"`);
    databases.push(environment.database);
  }
  for (const environment of environments) {
    await baseline.migrate(url(environment), 107);
    await installCurrentRuntime(url(environment));
    for (const grant of appRecipe) await grant(url(environment), environment.runtime);
    await grantCurrentRuntimeProfile(url(environment), environment.runtime);
    await session(environment, environment.owner, async (tx) => {
      await tx.query(`GRANT USAGE ON SCHEMA public TO "${environment.runtime}"`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON
        consent,outbox,command_receipt,plan_head,plan_snapshot,plan_history,
        activity_canonical,activity_source_head,activity_source_revision,
        activity_overlay,activity_overlay_revision,activity_suppression,
        activity_import_receipt TO "${environment.runtime}"`);
    });
  }
}, 180000);
afterAll(async () => {
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function capture(environment = first) {
  return session(environment, environment.owner, async (tx) => {
    // Session locks before BEGIN avoid acquiring the RR snapshot before waiting.
    await tx.query('SELECT pg_advisory_lock_shared(872194,1)');
    let lifecycleLocked = false;
    try {
      await tx.query('SELECT pg_advisory_lock_shared(77210,1)');
      lifecycleLocked = true;
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await tx.query("SET LOCAL statement_timeout='30000ms'");
      await tx.query('SET LOCAL search_path=pg_catalog,pg_temp');
      const witness = await captureCurrentRuntimeCatalogWitnessIn(tx, environment.runtime);
      await tx.query('COMMIT');
      return witness;
    } finally {
      await tx.query('ROLLBACK');
      if (lifecycleLocked)
        expect(
          (await tx.query('SELECT pg_advisory_unlock_shared(77210,1) AS unlocked')).rows[0]?.[
            'unlocked'
          ],
        ).toBe(true);
      expect(
        (await tx.query('SELECT pg_advisory_unlock_shared(872194,1) AS unlocked')).rows[0]?.[
          'unlocked'
        ],
      ).toBe(true);
    }
  });
}
async function mutation(sql: string, undo: string, check: () => Promise<void>) {
  await session(first, first.owner, (tx) => tx.query(sql));
  try {
    await check();
  } finally {
    await session(first, first.owner, (tx) => tx.query(undo));
  }
}
it('two independent installed profiles normalize actual catalog and effective app privileges without advertising support', async () => {
  const witnesses = await Promise.all(environments.map((environment) => capture(environment)));
  const a = witnesses[0],
    b = witnesses[1];
  if (!a || !b) throw new Error('fixture witnesses missing');
  expect(a.metadata).toEqual(b.metadata);
  expect(a.sections).toEqual(b.sections);
  expect(a.catalogSha256).toBe(b.catalogSha256);
  expect(a.observation.clusterRoleCount).toBe(b.observation.clusterRoleCount);
  for (const witness of witnesses) {
    expect(witness).toMatchObject({
      supported: false,
      processingAuthority: 'none',
      restore: 'not_verified',
      closure: {
        dynamicDependencies: 'not_verified',
        strictCallerWire: 'not_verified',
        effectiveRecipe: 'not_verified',
        independentNormalization: 'not_verified',
      },
    });
    const { observation, ...artifact } = witness;
    expect(parseCurrentRuntimeCatalogWitness(artifact)).toEqual(artifact);
    expect(observation.expectedRootCount).toBe(26);
    expect(BigInt(observation.metadataBytes)).toBeLessThanOrEqual(16777216n);
  }
}, 90000);
it('function body drift remains visible despite unchanged source ledger', async () => {
  const definition = await session(first, first.owner, async (tx) =>
    z
      .string()
      .parse(
        (
          await tx.query(
            "SELECT pg_get_functiondef('public.read_manual_race_chain_v2(uuid)'::regprocedure) AS definition",
          )
        ).rows[0]?.['definition'],
      ),
  );
  const before = await capture();
  const changed = definition.replace('BEGIN', 'BEGIN /* metadata drift fixture */');
  expect(changed).not.toBe(definition);
  await mutation(changed, definition, async () => {
    const after = await capture();
    expect(after.catalogSha256).not.toBe(before.catalogSha256);
    expect(
      after.metadata.functions.find((f) => f.name === 'read_manual_race_chain_v2')?.sourceSha256,
    ).not.toBe(
      before.metadata.functions.find((f) => f.name === 'read_manual_race_chain_v2')?.sourceSha256,
    );
    expect(after.supported).toBe(false);
  });
  expect((await capture()).catalogSha256).toBe(before.catalogSha256);
}, 90000);
it.each([
  [
    'trigger',
    'ALTER TABLE public.check_in_template_version DISABLE TRIGGER check_in_template_rows',
    'ALTER TABLE public.check_in_template_version ENABLE TRIGGER check_in_template_rows',
  ],
  [
    'force RLS',
    'ALTER TABLE public.check_in_template_version NO FORCE ROW LEVEL SECURITY',
    'ALTER TABLE public.check_in_template_version FORCE ROW LEVEL SECURITY',
  ],
  [
    'constraint',
    'ALTER TABLE public.check_in_template_version ADD CONSTRAINT witness_metadata_check CHECK (true)',
    'ALTER TABLE public.check_in_template_version DROP CONSTRAINT witness_metadata_check',
  ],
])(
  'observes %s drift instead of discarding changed installed metadata',
  async (_label, sql, undo) => {
    const before = await capture();
    await mutation(sql, undo, async () => {
      const after = await capture();
      expect(
        after.metadata.relations.find(
          (r) => r.schema === 'public' && r.name === 'check_in_template_version',
        ),
      ).not.toEqual(
        before.metadata.relations.find(
          (r) => r.schema === 'public' && r.name === 'check_in_template_version',
        ),
      );
      expect(after.catalogSha256).not.toBe(before.catalogSha256);
      expect(after.supported).toBe(false);
    });
    expect((await capture()).catalogSha256).toBe(before.catalogSha256);
  },
  90000,
);
it('retains unknown namespace and ACL principal rather than excluding them from normalized evidence', async () => {
  await mutation(
    `CREATE SCHEMA witness_unrecognized; GRANT USAGE ON SCHEMA witness_unrecognized TO "${unknownRole}"`,
    'DROP SCHEMA witness_unrecognized',
    async () => {
      const witness = await capture();
      expect(witness.unknownNamespaces).toContain('witness_unrecognized');
      expect(witness.unmappedRoleTags).toContain(`unmapped:${unknownRole}`);
      expect(witness.metadata.schemas.find((s) => s.name === 'witness_unrecognized')?.acl).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ grantee: `unmapped:${unknownRole}`, privilege: 'USAGE' }),
        ]),
      );
      expect(witness.supported).toBe(false);
    },
  );
}, 90000);
it('observes effective EXECUTE drift and rejects a nonprivate installer ledger before capture', async () => {
  const before = await capture();
  await mutation(
    `REVOKE EXECUTE ON FUNCTION public.save_check_in_template_v1(jsonb) FROM "${first.runtime}"`,
    `GRANT EXECUTE ON FUNCTION public.save_check_in_template_v1(jsonb) TO "${first.runtime}"`,
    async () => {
      const after = await capture();
      expect(
        after.metadata.functions.find((f) => f.name === 'save_check_in_template_v1')
          ?.runtimeExecute,
      ).toBe(false);
      expect(after.catalogSha256).not.toBe(before.catalogSha256);
    },
  );
  await mutation(
    `GRANT SELECT ON wm_runtime_installation.migration TO "${first.runtime}"`,
    `REVOKE SELECT ON wm_runtime_installation.migration FROM "${first.runtime}"`,
    async () => {
      await expect(capture()).rejects.toThrow('CURRENT_RUNTIME_LEDGER_INVALID');
    },
  );
}, 90000);
it('runtime, elevated sessions, read committed and read write contexts are rejected before catalog capture', async () => {
  for (const [role, begin] of [
    [first.runtime, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'],
    [first.owner, 'BEGIN READ ONLY'],
    [first.owner, 'BEGIN ISOLATION LEVEL REPEATABLE READ'],
  ]) {
    if (!role || !begin) throw new Error('fixture denial missing');
    await session(first, role, async (tx) => {
      await tx.query(begin);
      try {
        await expect(captureCurrentRuntimeCatalogWitnessIn(tx, first.runtime)).rejects.toThrow(
          'CATALOG_WITNESS_CONTEXT_REQUIRED',
        );
      } finally {
        await tx.query('ROLLBACK');
      }
    });
  }
  const elevatedUrl = new URL(adminUrl);
  elevatedUrl.pathname = `/${first.database}`;
  const elevated = new Pool({ connectionString: elevatedUrl.toString() });
  try {
    const tx = await elevated.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await expect(captureCurrentRuntimeCatalogWitnessIn(tx, first.runtime)).rejects.toThrow(
        'CATALOG_WITNESS_CONTEXT_REQUIRED',
      );
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  } finally {
    await elevated.end();
  }
});
it('oversized actual function source is rejected by the catalog preflight before transporting its body', async () => {
  const huge = 'x'.repeat(2097153);
  await mutation(
    `CREATE FUNCTION public.witness_large_source() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN /*${huge}*/ RETURN; END $body$`,
    'DROP FUNCTION public.witness_large_source()',
    async () => {
      await expect(capture()).rejects.toThrow('CATALOG_WITNESS_LIMIT');
    },
  );
}, 90000);

it('owner membership cannot turn the runtime identity into an accepted capture subject', async () => {
  await admin.query(`GRANT "${first.owner}" TO "${first.runtime}"`);
  try {
    await expect(capture()).rejects.toThrow('CATALOG_WITNESS_CONTEXT_REQUIRED');
  } finally {
    await admin.query(`REVOKE "${first.owner}" FROM "${first.runtime}"`);
  }
});

it('actual user trigger RI lookalike stays named while internal FK dependencies use structural identities', async () => {
  const before = await capture();
  const internal = before.metadata.dependencies.filter((d) =>
    d.dependent.startsWith('internal-fk-trigger:'),
  );
  expect(internal.length).toBeGreaterThan(0);
  expect(
    before.metadata.dependencies.some((d) =>
      /^trigger RI_ConstraintTrigger_[ac]_\d+ on table /.test(d.dependent),
    ),
  ).toBe(false);
  await mutation(
    'CREATE TRIGGER "RI_ConstraintTrigger_a_12345" BEFORE TRUNCATE ON public.check_in_template_version FOR EACH STATEMENT EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',
    'DROP TRIGGER "RI_ConstraintTrigger_a_12345" ON public.check_in_template_version',
    async () => {
      const after = await capture();
      expect(
        after.metadata.dependencies.some(
          (d) =>
            d.dependent ===
              'trigger "RI_ConstraintTrigger_a_12345" on table public.check_in_template_version' ||
            d.dependent ===
              'trigger RI_ConstraintTrigger_a_12345 on table public.check_in_template_version',
        ),
      ).toBe(true);
      expect(
        after.metadata.relations
          .find((r) => r.schema === 'public' && r.name === 'check_in_template_version')
          ?.triggers.some((t) => t.name === 'RI_ConstraintTrigger_a_12345'),
      ).toBe(true);
      expect(after.catalogSha256).not.toBe(before.catalogSha256);
    },
  );
  expect((await capture()).catalogSha256).toBe(before.catalogSha256);
}, 90000);
