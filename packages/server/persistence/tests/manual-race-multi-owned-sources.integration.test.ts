import { readRaceManualReviewCompatibleChainIn } from '../src/race-manual-review-chain-v2.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { captureRaceManualReviewCompatibleLifecycleInventoryIn } from '../src/race-manual-review-lifecycle-inventory-v2.js';
import { raceProjectionIntentSchema } from '../src/race-plan-impact-projection-input.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import {
  migrate,
  grantCorePlanning,
  grantSupplementaryCore,
  grantOperations,
  grantRaces,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantNutritionCore,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root-only actual PG fixture: normal107/public consent+race, existing narrow
// grants. This checks current app/policy binding, never a full permission seal.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `multi_owned_${suffix}`,
  ownerRole = `multi_owned_owner_${suffix}`,
  runtimeRole = `multi_owned_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  const migrationOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    for (const file of [
      '108_nutrition_race_disconnection.sql',
      '109_race_result_proof_lifecycle.sql',
      '110_nutrition_disconnection_lineage.sql',
      '111_race_result_preserved_proof_updates.sql',
      '112_training_plan_aggregate_history.sql',
      '113_race_media_cleanup_source.sql',
      '114_manual_review_owned_source_bindings_v2.sql',
      '115_manual_review_full_owned_source_bindings_v2.sql',
      '116_manual_race_chain_v2.sql',
    ])
      await migrationOwner.query(
        await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      );
    const before = (
      await migrationOwner.query(
        "SELECT proowner::text,proacl::text,proconfig,prosecdef FROM pg_proc WHERE oid='public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure",
      )
    ).rows[0];
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/118_race_manual_atomic_approval.sql', import.meta.url),
        'utf8',
      ),
    );
    const preserved = (
      await migrationOwner.query(
        "SELECT proname,prosrc,proconfig,proacl::text,proowner::text,prosecdef FROM pg_proc WHERE oid=ANY(ARRAY['public.observe_manual_review_full_owned_source_bindings_v2(jsonb)'::regprocedure,'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,'public.manual_race_v2_guard_mutation()'::regprocedure]) ORDER BY proname",
      )
    ).rows;
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/120_manual_race_multi_owned_sources.sql', import.meta.url),
        'utf8',
      ),
    );
    expect(
      (
        await migrationOwner.query(
          "SELECT proname,prosrc,proconfig,proacl::text,proowner::text,prosecdef FROM pg_proc WHERE oid=ANY(ARRAY['public.observe_manual_review_full_owned_source_bindings_v2(jsonb)'::regprocedure,'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure,'public.manual_race_v2_guard_mutation()'::regprocedure]) ORDER BY proname",
        )
      ).rows,
    ).toEqual(preserved);
    const after = (
      await migrationOwner.query(
        "SELECT proowner::text,proacl::text,proconfig,prosecdef FROM pg_proc WHERE oid='public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)'::regprocedure",
      )
    ).rows[0];
    expect(after).toEqual(before);
    for (const signature of [
      'public.observe_manual_review_full_owned_source_bindings_v2(jsonb)',
      'public.observe_manual_review_multi_owned_source_bindings_v3(jsonb)',
      'public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.read_manual_race_chain_receipt_v2(text,jsonb)',
      'public.read_manual_race_chain_v2(uuid)',
      'public.read_nutrition_disconnection_origin(uuid,uuid,text)',
      'public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)',
      'public.prepare_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)',
      'public.read_race_manual_application_v1(uuid)',
      'public.read_race_manual_application_receipt_v1(text,jsonb)',
      'public.begin_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)',
      'public.apply_race_manual_event_v1(uuid)',
      'public.race_manual_nutrition_affected_items_v1(uuid,jsonb)',
      'public.commit_race_manual_application_v1(uuid,jsonb)',
      'public.race_manual_nutrition_preserved_items_v1(uuid,jsonb)',
    ])
      await migrationOwner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
    expect(
      (await migrationOwner.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await migrationOwner.end();
  }

  for (const grant of [
    grantCorePlanning,
    grantSupplementaryCore,
    grantOperations,
    grantRaces,
    grantRoutineCore,
    grantRecoveryCore,
    grantCheckIns,
    grantCourses,
    grantNutritionCore,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
  ])
    await grant(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});

async function snapshot<T>(athlete: string, run: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(athlete, run);
}
async function seed(multi = false) {
  const athlete = randomUUID();
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    await owner.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    );
  } finally {
    await owner.end();
  }
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const races = createRaceRepository(db);
  const values = {
    title: 'Synthetic current',
    localDate: '2026-10-06',
    localStartTime: '09:00',
    timezone: 'UTC',
    locationName: null,
    distance: { kind: 'standard' as const, class: '10k' as const },
    priority: null,
    participation: 'registered' as const,
    officialUrl: null,
    course: null,
    targetSeconds: null,
    planVersionId: null,
  };
  const event = await races.createRaceEvent(athlete, { idempotencyKey: randomUUID(), values });
  const other = multi
    ? await races.createRaceEvent(athlete, {
        idempotencyKey: randomUUID(),
        values: { ...values, title: 'Unrelated frozen source' },
      })
    : null;
  if (other)
    await createNutritionRacePlanWriter(db).savePlanV2(athlete, {
      schemaVersion: 2,
      command: {
        kind: 'create',
        confirmed: true,
        idempotencyKey: randomUUID(),
        draft: {
          period: { from: '2026-10-01', toInclusive: '2026-11-04' },
          timezone: 'UTC',
          purpose: 'Frozen two race meals',
          linkedTrainingPlanVersionId: null,
          items: [event, other].map((r, index) => ({
            id: `meal-${index}`,
            category: 'before',
            title: 'Frozen meal',
            anchor: {
              kind: 'relative',
              entity: 'race',
              entityId: r.id,
              point: 'start',
              offsetMinutes: -30,
            },
            foods: [
              {
                foodVersionId: null,
                description: 'Food retained',
                quantity: 0,
                unit: 'g',
                sourceBasis: 'unknown',
              },
            ],
            targets: [],
            instructions: 'Record synthetic intake explicitly',
            evidenceIds: [],
            source: 'user_confirmed',
          })),
        },
      },
      expectedRaceHeads: [event, other]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((r) => ({ namespace: 'race-event', eventId: r.id, revision: r.revision })),
    });
  return {
    athlete,
    event,
    other,
    intent: raceProjectionIntentSchema.parse({
      expectedEvent: { id: event.id, revision: event.revision },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' },
    }),
  };
}
async function prepared(tx: Transaction, intent: unknown) {
  const budget = { bytes: 0n, sources: 0 };
  const actual = await prepareRaceManualSemanticBasisV2In(tx, intent, null, budget);
  if (actual.status !== 'current_dependencies_captured') throw Error('ACTUAL_BASIS_BLOCKED');
  const lifecycle = await captureRaceManualReviewCompatibleLifecycleInventoryIn(
    tx,
    actual.prepared.retained,
    budget,
  );
  if (lifecycle.status !== 'dependency_correspondence') throw Error('ACTUAL_LIFECYCLE_BLOCKED');
  const key = randomUUID();
  return {
    payload: actual.prepared.retained,
    basis: actual.basis,
    lifecycle,
    key,
    ids: [randomUUID(), randomUUID(), randomUUID()],
    request: {
      schemaVersion: 2,
      idempotencyKey: key,
      intent: actual.basis.intent,
      expectedBasis: actual.basis,
    },
  };
}
type Prepared = Awaited<ReturnType<typeof prepared>>;
async function store(tx: Transaction, p: Prepared, legacy = false) {
  const name = legacy
    ? 'public.store_manual_race_chain_v2'
    : 'public.store_manual_race_multi_owned_chain_v3';
  return (
    await tx.query(
      `SELECT ${name}($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) AS result`,
      [
        ...p.ids,
        p.key,
        JSON.stringify(p.request),
        JSON.stringify(p.payload),
        JSON.stringify(p.basis),
        JSON.stringify(p.lifecycle),
      ],
    )
  ).rows[0]?.['result'];
}
it('old v2 single-race actual chain remains readonly and replay returns original identity', async () => {
  const f = await seed();
  await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, f.intent);
    const result = await store(tx, p, true);
    expect(result).toMatchObject({ schemaVersion: 2, applicable: false, approvalAllowed: false });
    expect(await store(tx, p, true)).toEqual(result);
  });
});
it('v3 stores primary and unrelated actual frozen race bodies without widening observation wire2', async () => {
  const f = await seed(true);
  await snapshot(f.athlete, async (tx) => {
    const p = await prepared(tx, f.intent);
    const refs = p.payload.payload.inventory.refs.filter((r) => r.identity.kind === 'race-event');
    expect(refs.map((r) => r.identity.sourceId).sort()).toEqual([f.event.id, f.other?.id].sort());
    expect(p.payload.payload.sqlObservations).toMatchObject({
      bindingVersion: 2,
      authority: 'none',
      freshness: 'not_checked',
    });
    const result = await store(tx, p);
    expect(result).toMatchObject({ schemaVersion: 2, applicable: false, approvalAllowed: false });
    const id = z
      .strictObject({
        schemaVersion: z.literal(2),
        evidenceId: z.uuid(),
        decisionId: z.uuid(),
        proposalId: z.uuid(),
        candidateDigest: z.string(),
        createdAt: z.string(),
        applicable: z.literal(false),
        approvalAllowed: z.literal(false),
      })
      .parse(result).evidenceId;
    const read = await readRaceManualReviewCompatibleChainIn(tx, id, { bytes: 0n, sources: 0 });
    expect(read?.payload).toEqual(p.payload);
  });
});
it('v3 rejects foreign extra source through actual owned relation validation', async () => {
  const f = await seed(true),
    foreign = await seed();
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      const refs = p.payload.payload.inventory.refs;
      const extra = refs.find(
        (r) => r.identity.kind === 'race-event' && r.identity.sourceId === f.other?.id,
      );
      if (!extra || extra.identity.kind !== 'race-event') throw Error('EXTRA_REQUIRED');
      extra.identity.sourceId = foreign.event.id;
      await store(tx, p);
    }),
  ).rejects.toThrow('MANUAL_CHAIN_SOURCE_UNAVAILABLE');
});
it('v3 rejects duplicate primary ref instead of retrying historical v2 storage', async () => {
  const f = await seed(true);
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      const primary = p.payload.payload.inventory.refs.find(
        (r) => r.identity.kind === 'race-event' && r.identity.sourceId === f.event.id,
      );
      if (!primary) throw Error('PRIMARY_REQUIRED');
      p.payload.payload.inventory.refs.push(primary);
      await store(tx, p);
    }),
  ).rejects.toThrow('MANUAL_FULL_BINDING_DUPLICATE');
});
it('v3 rejects missing primary even though the unrelated owned race roster remains nonempty', async () => {
  const f = await seed(true);
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      p.payload.payload.inventory.refs = p.payload.payload.inventory.refs.filter(
        (r) => r.identity.kind !== 'race-event' || r.identity.sourceId !== f.event.id,
      );
      await store(tx, p);
    }),
  ).rejects.toThrow('MANUAL_CHAIN_EVENT_REF_REQUIRED');
});
it('runtime cannot mint an actual commit row with JSON, GUC or direct table writes', async () => {
  const f = await seed();
  await expect(
    snapshot(f.athlete, async (tx) => {
      await tx.query("SELECT set_config('app.manual_ready','true',true)");
      await tx.query(
        "INSERT INTO public.manual_race_chain_commit_v2 VALUES($1,$2,current_user,txid_current(),sha256(convert_to('{}','UTF8')))",
        [f.athlete, randomUUID()],
      );
    }),
  ).rejects.toThrow('permission denied');
});

it('historical v2 storage still rejects a multi-race roster while v3 handles it separately', async () => {
  const f = await seed(true);
  await expect(
    snapshot(f.athlete, async (tx) => {
      const p = await prepared(tx, f.intent);
      await store(tx, p, true);
    }),
  ).rejects.toThrow('MANUAL_CHAIN_EVENT_REF_REQUIRED');
});
