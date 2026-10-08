import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as baseline from '../src/migrate.js';
import { installCurrentRuntimeV4 } from '../src/current-runtime-installation-v4.js';
import { installCurrentRuntimeV5 } from '../src/current-runtime-installation-v5.js';
import { grantCurrentRuntimeV4Profile } from '../src/current-runtime-grants-v4.js';
import { captureCurrentRuntimeCatalogWitnessV5In } from '../src/current-runtime-catalog-witness-v5.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Metadata only. Root executes PostgreSQL; this fixture creates no health/source
// rows and invokes no product RPC. Observed equality is not dependency closure.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const environments = ['a', 'b'].map((label) => ({
  database: `current_runtime_catalog_v5_${label}_${suffix}`,
  owner: `current_runtime_catalog_v5_owner_${label}_${suffix}`,
  runtime: `current_runtime_catalog_v5_app_${label}_${suffix}`,
}));
const first = z
  .strictObject({ database: z.string(), owner: z.string(), runtime: z.string() })
  .parse(environments[0]);
const unknownRole = `current_runtime_catalog_v5_other_${suffix}`;
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
// A Vitest timeout does not cancel an asynchronous callback. Serialize entire
// callbacks (including mutation undo), and drain them before destructive cleanup.
// Statement deadlines remain 30s and test deadlines remain unchanged.
let pendingFixtureWork: Promise<void> = Promise.resolve();
function fixtureIt(name: string, apply: () => Promise<void>, timeout?: number) {
  it(
    name,
    async () => {
      const work = pendingFixtureWork.then(apply);
      pendingFixtureWork = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    timeout,
  );
}
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
    await installCurrentRuntimeV4(url(environment));
    for (const grant of appRecipe) await grant(url(environment), environment.runtime);
    await grantCurrentRuntimeV4Profile(url(environment), environment.runtime);
    const installed = await installCurrentRuntimeV5(url(environment));
    expect(installed).toMatchObject({
      profileVersion: 5,
      runtimeStep: 21,
      sourceDdlTip: 131,
      supported: false,
    });
    // Exact ACK-only additional ACL. Grant5 whole root metadata is not yet a
    // compiled fixture prerequisite; this observation is no activation proof.
    await session(environment, environment.owner, (tx) =>
      tx.query(
        `GRANT EXECUTE ON FUNCTION public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb) TO "${environment.runtime}"`,
      ),
    );
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
  await pendingFixtureWork;
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
      const witness = await captureCurrentRuntimeCatalogWitnessV5In(tx, environment.runtime);
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
fixtureIt(
  'two independent profile21 captures enumerate the full typed catalog without claiming dynamic/wire/recipe admission',
  async () => {
    const witnesses = await Promise.all(environments.map((environment) => capture(environment)));
    const a = witnesses[0],
      b = witnesses[1];
    if (!a || !b) throw new Error('fixture witnesses missing');
    expect(a.metadata).toEqual(b.metadata);
    expect(a.sections).toEqual(b.sections);
    expect(a.profile.runtimeStep).toBe(21);
    expect(a.profile.runtimeSteps).toHaveLength(21);
    expect(a.profile.runtimeSteps[20]?.sourceDdlId).toBe(131);
    expect(a.metadata.functions.some((f) => f.name === 'ack_manual_race_same_tx_parent_v1')).toBe(
      true,
    );
    expect(
      a.metadata.relations.some(
        (r) => r.schema === 'wm_runtime_installation' && r.name === 'profile_extension_v5',
      ),
    ).toBe(true);
    expect(
      a.metadata.relations.some(
        (r) => r.schema === 'wm_runtime_installation' && r.name === 'profile_extension_v3',
      ),
    ).toBe(true);
    const ack = a.metadata.functions.find((f) => f.name === 'ack_manual_race_same_tx_parent_v1');
    expect(ack).toMatchObject({
      owner: 'owner',
      securityDefiner: true,
      runtimeExecute: true,
      returns: 'jsonb',
      language: 'plpgsql',
    });
    expect(ack?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ack?.acl.some((a) => a.grantee === 'PUBLIC' && a.privilege === 'EXECUTE')).toBe(false);
    expect(
      a.metadata.relations.some(
        (r) => r.schema === 'wm_runtime_installation' && r.name === 'profile_extension_v4',
      ),
    ).toBe(true);
    expect(a.observation.expectedRootCount).toBe(32);
    expect(a.supported).toBe(false);
    expect(a.closure.dynamicDependencies).toBe('not_verified');
    expect(a.metadata.typeDetails.length).toBe(a.metadata.types.length);
    expect(a.metadata.relationDetails.length).toBe(a.metadata.relations.length);
    expect(a.metadata.languages.some((v) => v.name === 'plpgsql')).toBe(true);
  },
  90000,
);
fixtureIt(
  'observes actual domain/composite/range/type ACL and view/rules/index/inheritance metadata',
  async () => {
    const before = await capture();
    await mutation(
      `CREATE SCHEMA "ObservedUnicode영역"; CREATE SCHEMA "pgXObserved";
    CREATE DOMAIN "ObservedUnicode영역".positive AS integer CHECK(VALUE>0);
    CREATE TYPE "ObservedUnicode영역".pair AS (zero integer,unknown text);
    CREATE TYPE "ObservedUnicode영역".integer_span AS RANGE(subtype=integer);
    CREATE TABLE "ObservedUnicode영역".parent(id integer);
    CREATE TABLE "ObservedUnicode영역".child(extra text) INHERITS("ObservedUnicode영역".parent);
    CREATE VIEW "ObservedUnicode영역".viewed AS SELECT id FROM "ObservedUnicode영역".parent;
    CREATE UNIQUE INDEX ordered_id ON "ObservedUnicode영역".parent(id) NULLS NOT DISTINCT;
    GRANT USAGE ON TYPE "ObservedUnicode영역".positive TO "${unknownRole}"`,
      'DROP SCHEMA "ObservedUnicode영역" CASCADE; DROP SCHEMA "pgXObserved"',
      async () => {
        const w = await capture();
        expect(w.catalogSha256).not.toBe(before.catalogSha256);
        expect(w.metadata.schemas.some((v) => v.name === 'pgXObserved')).toBe(true);
        const domain = w.metadata.typeDetails.find(
          (v) => v.schema === 'ObservedUnicode영역' && v.name === 'positive',
        );
        expect(domain?.domainConstraints[0]?.definition).toContain('VALUE > 0');
        expect(domain?.acl.some((v) => v.grantee === `unmapped:${unknownRole}`)).toBe(true);
        expect(
          w.metadata.typeDetails
            .find((v) => v.schema === 'ObservedUnicode영역' && v.name === 'pair')
            ?.attributes.map((v) => v.name),
        ).toEqual(['zero', 'unknown']);
        expect(
          w.metadata.typeDetails.find(
            (v) => v.schema === 'ObservedUnicode영역' && v.name === 'integer_span',
          )?.range?.subtype,
        ).toBe('integer');
        expect(
          w.metadata.relationDetails.find(
            (v) => v.schema === 'ObservedUnicode영역' && v.name === 'viewed',
          )?.viewDefinition,
        ).toContain('parent');
        expect(
          w.metadata.relationDetails.find(
            (v) => v.schema === 'ObservedUnicode영역' && v.name === 'child',
          )?.inheritance,
        ).toHaveLength(1);
        expect(
          w.metadata.relationDetails.find(
            (v) => v.schema === 'ObservedUnicode영역' && v.name === 'ordered_id',
          )?.indexState?.nullsNotDistinct,
        ).toBe(true);
        expect(w.supported).toBe(false);
      },
    );
    expect((await capture()).catalogSha256).toBe(before.catalogSha256);
  },
  90000,
);
fixtureIt(
  'enumerates real user operators/casts and retains their actual dependency edges',
  async () => {
    await mutation(
      `CREATE SCHEMA catalog_extra;
 CREATE FUNCTION catalog_extra.same(integer,integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1=$2';
 CREATE OPERATOR catalog_extra.=== (FUNCTION=catalog_extra.same,LEFTARG=integer,RIGHTARG=integer);
 CREATE TYPE catalog_extra.state AS ENUM('zero','unknown');
 CREATE FUNCTION catalog_extra.state_text(catalog_extra.state) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1::text';
 CREATE CAST(catalog_extra.state AS text) WITH FUNCTION catalog_extra.state_text(catalog_extra.state)`,
      'DROP SCHEMA catalog_extra CASCADE',
      async () => {
        const w = await capture();
        expect(
          w.metadata.operators.find((v) => v.schema === 'catalog_extra' && v.name === '===')?.left,
        ).toBe('integer');
        expect(
          w.metadata.casts.some((v) => v.source === 'catalog_extra.state' && v.target === 'text'),
        ).toBe(true);
        expect(
          w.metadata.additionalDependencies.some((v) => v.dependent.includes('catalog_extra')),
        ).toBe(true);
      },
    );
  },
  90000,
);
fixtureIt(
  'preserves real user RI lookalike identifiers while structurally normalizing only real internal FK triggers',
  async () => {
    const before = await capture();
    await mutation(
      `CREATE FUNCTION public.catalog_user_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';
 CREATE TRIGGER "RI_ConstraintTrigger_a_12345" BEFORE UPDATE ON public.check_in_template_version FOR EACH ROW EXECUTE FUNCTION public.catalog_user_guard()`,
      'DROP TRIGGER "RI_ConstraintTrigger_a_12345" ON public.check_in_template_version; DROP FUNCTION public.catalog_user_guard()',
      async () => {
        const w = await capture();
        expect(
          w.metadata.relations
            .find((v) => v.schema === 'public' && v.name === 'check_in_template_version')
            ?.triggers.some((v) => v.name === 'RI_ConstraintTrigger_a_12345'),
        ).toBe(true);
        expect(w.catalogSha256).not.toBe(before.catalogSha256);
      },
    );
  },
  90000,
);
fixtureIt(
  'rejects nonowner/runtime capture and READ COMMITTED before returning catalog evidence',
  async () => {
    await session(first, first.runtime, async (tx) => {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await expect(captureCurrentRuntimeCatalogWitnessV5In(tx, first.runtime)).rejects.toThrow(
          'CATALOG_WITNESS_CONTEXT_REQUIRED',
        );
      } finally {
        await tx.query('ROLLBACK');
      }
    });
    await session(first, first.owner, async (tx) => {
      await tx.query('BEGIN READ ONLY');
      try {
        await expect(captureCurrentRuntimeCatalogWitnessV5In(tx, first.runtime)).rejects.toThrow(
          'CATALOG_WITNESS_CONTEXT_REQUIRED',
        );
      } finally {
        await tx.query('ROLLBACK');
      }
    });
  },
);
fixtureIt(
  'observes FORCE RLS and unknown ACL principal drift without replacing it with matching root sentinel evidence',
  async () => {
    const before = await capture();
    await mutation(
      'ALTER TABLE public.check_in_template_version NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE public.check_in_template_version FORCE ROW LEVEL SECURITY',
      async () => {
        const w = await capture();
        expect(
          w.metadata.relations.find(
            (v) => v.schema === 'public' && v.name === 'check_in_template_version',
          )?.force,
        ).toBe(false);
        expect(w.catalogSha256).not.toBe(before.catalogSha256);
      },
    );
    await mutation(
      `GRANT SELECT ON public.check_in_template_version TO "${unknownRole}"`,
      `REVOKE SELECT ON public.check_in_template_version FROM "${unknownRole}"`,
      async () => {
        const w = await capture();
        expect(w.metadata.roles.some((v) => v.tag === `unmapped:${unknownRole}`)).toBe(true);
        expect(w.catalogSha256).not.toBe(before.catalogSha256);
      },
    );
  },
  90000,
);

fixtureIt(
  'source131 observation preserves all five exact private installation receipts and old xmins',
  async () => {
    const ledger = () =>
      session(first, first.owner, async (tx) => {
        const out = await tx.query(`SELECT jsonb_build_object(
   'parent',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text) ORDER BY step) FROM wm_runtime_installation.migration t),
   'v2',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text)) FROM wm_runtime_installation.profile_extension_v2 t),
   'v3',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text)) FROM wm_runtime_installation.profile_extension_v3 t),
   'v4',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text)) FROM wm_runtime_installation.profile_extension_v4 t),
   'v5',(SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',xmin::text)) FROM wm_runtime_installation.profile_extension_v5 t)) ledger`);
        return out.rows;
      });
    const before = await ledger();
    await capture();
    expect(await ledger()).toEqual(before);
  },
);
fixtureIt(
  'enumerates source130 private helper effective ACL drift without asserting its27dynamic branches verified',
  async () => {
    const before = await capture();
    await mutation(
      `GRANT EXECUTE ON FUNCTION public.manual_source_personal_row_exists_v1(jsonb,jsonb) TO "${first.runtime}"`,
      `REVOKE EXECUTE ON FUNCTION public.manual_source_personal_row_exists_v1(jsonb,jsonb) FROM "${first.runtime}"`,
      async () => {
        const changed = await capture();
        expect(changed.catalogSha256).not.toBe(before.catalogSha256);
        expect(changed.closure.dynamicDependencies).toBe('not_verified');
        expect(changed.supported).toBe(false);
        expect(changed.processingAuthority).toBe('none');
        expect(changed.restore).toBe('not_verified');
      },
    );
    expect((await capture()).catalogSha256).toBe(before.catalogSha256);
  },
  90000,
);

fixtureIt(
  'observes actual ACK effective ACL drift without promoting protected seal/caller closure',
  async () => {
    const before = await capture();
    await mutation(
      `REVOKE EXECUTE ON FUNCTION public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb) FROM "${first.runtime}"`,
      `GRANT EXECUTE ON FUNCTION public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb) TO "${first.runtime}"`,
      async () => {
        const changed = await capture();
        expect(
          changed.metadata.functions.find((f) => f.name === 'ack_manual_race_same_tx_parent_v1')
            ?.runtimeExecute,
        ).toBe(false);
        expect(changed.catalogSha256).not.toBe(before.catalogSha256);
        expect(changed.supported).toBe(false);
        expect(changed.closure.strictCallerWire).toBe('not_verified');
      },
    );
    expect((await capture()).catalogSha256).toBe(before.catalogSha256);
  },
  90000,
);
