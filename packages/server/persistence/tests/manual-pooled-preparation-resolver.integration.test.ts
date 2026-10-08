import { randomUUID } from 'node:crypto';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import {
  toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase,
  decodeRaceManualReviewPooledDatabaseEnvelopeV1 as decode,
} from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { installCurrentRuntimeV4 } from '../src/current-runtime-installation-v4.js';
import { grantCurrentRuntimeV4Profile } from '../src/current-runtime-grants-v4.js';
import * as baseline from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual PG only. Public synthetic sources, no private health/event seed.
// Account row is the identity-only foreign-key prerequisite, not source authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_resolver_${suffix}`,
  ownerRole = `pooled_resolver_owner_${suffix}`,
  runtimeRole = `pooled_resolver_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database,
  envelope: ReturnType<typeof toDatabase>;
let pending: Promise<void> = Promise.resolve();
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function owner<T>(apply: (p: Pool) => Promise<T>) {
  const p = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    return await apply(p);
  } finally {
    await p.end();
  }
}
function fixtureIt(label: string, apply: () => Promise<void>) {
  it(
    label,
    async () => {
      const work = pending.then(apply);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    30000,
  );
}
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
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await baseline.migrate(url(ownerRole), 107);
  await installCurrentRuntimeV4(url(ownerRole));
  for (const grant of appRecipe) await grant(url(ownerRole), runtimeRole);
  await grantCurrentRuntimeV4Profile(url(ownerRole), runtimeRole);
  await owner(async (p) => {
    await p.query(
      await readFile(
        new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  const athlete = randomUUID();
  await owner((p) =>
    p.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    ),
  );
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic pooled resolver',
      localDate: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
  const nutrition = createNutritionRepository(db);
  const datum = <const U extends string>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: ['順序B', '順序A'],
  });
  const food = await nutrition.saveFood(athlete, {
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    confirmed: true,
    definition: {
      foodId: '食/opaque-𐀀',
      name: 'Synthetic food',
      basis: { kind: 'per_100g' },
      nutrients: {
        energy: datum('kcal'),
        carbohydrate: datum('g'),
        protein: datum('g'),
        fat: datum('g'),
        fluid: datum('mL'),
        sodium: datum('mg'),
      },
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-10-07T00:00:00Z',
        reviewState: 'unreviewed',
      },
    },
  });
  await nutrition.savePlan(athlete, {
    kind: 'create',
    idempotencyKey: randomUUID(),
    confirmed: true,
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'Asia/Seoul',
      purpose: 'Synthetic plan only',
      linkedTrainingPlanVersionId: null,
      items: [
        {
          id: 'opaque/item',
          category: 'meal',
          title: 'Synthetic meal',
          anchor: { kind: 'absolute', date: '2026-10-06', localTime: null, timezone: 'Asia/Seoul' },
          foods: [
            {
              foodVersionId: food.versionId,
              description: 'zero',
              quantity: 0,
              unit: 'g',
              sourceBasis: 'per_100g',
            },
            {
              foodVersionId: null,
              description: 'unknown',
              quantity: null,
              unit: 'unspecified',
              sourceBasis: 'unknown',
            },
          ],
          targets: [],
          instructions: 'Not actual intake',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  envelope = await db.snapshotTenant(athlete, async (tx) => {
    const prepared = await prepareRaceManualSemanticBasisV2In(
      tx,
      {
        expectedEvent: { id: race.id, revision: race.revision },
        newLocalDate: '2026-10-08',
        selection: { kind: 'keep_plan' },
      },
      null,
      { bytes: 0n, sources: 0 },
    );
    if (prepared.status !== 'current_dependencies_captured')
      throw Error('GENUINE_PREPARATION_UNAVAILABLE');
    return toDatabase(encode(prepared.prepared.retained));
  });
  expect(envelope.payload.preparation.sourcePool.length).toBeGreaterThan(0);
}, 180000);
afterAll(async () => {
  await pending;
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 30000);
async function check(raw: unknown) {
  return owner((p) =>
    p.query('SELECT wm_manual_pooled.check_encoded($1::jsonb)', [JSON.stringify(raw)]),
  );
}
async function lookup(raw: unknown, path: string) {
  return owner(async (p) => {
    const row = await p.query<{ value: unknown }>(
      'SELECT wm_manual_pooled.lookup($1::jsonb,$2::text) AS value',
      [JSON.stringify(raw), path],
    );
    return row.rows[0]?.value;
  });
}
fixtureIt(
  'returns each actual encoded root and every copied DTO without altering null/zero/opaque/array order',
  async () => {
    const logical = decode(envelope);
    if (logical.state !== 'present') throw Error('PRESENT_LOGICAL_REQUIRED');
    await check(envelope);
    for (const root of ['context', 'sourceInput', 'candidate'] as const)
      expect(await lookup(envelope, root)).toEqual(logical.payload.preparation[root]);
    for (const ref of logical.payload.inventory.refs)
      for (const location of ref.copiedLocations) {
        const parts = location.replace(/\[([0-9]+)\]/g, '.$1').split('.');
        let v: unknown = logical.payload.preparation;
        for (const part of parts) {
          const record = z.record(z.string(), z.unknown()).safeParse(v);
          if (Array.isArray(v)) v = v[Number(part)];
          else if (record.success) v = record.data[part];
          else throw Error('FIXTURE_LOCATION');
        }
        expect(await lookup(envelope, location)).toEqual(v);
      }
    const record = logical.payload.preparation.context.nutrition[0]?.record;
    if (!record) throw Error('FIXTURE_NUTRITION');
    const items = nutritionPlanVersionSchema.parse(record).items;
    expect(items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
  },
);
fixtureIt('rejects unknown/drop encoding and fractional/out-of-range pool ordinals', async () => {
  for (const mutate of [
    (e: typeof envelope) => {
      Object.assign(e.payload.preparation, { encodingVersion: 2 });
    },
    (e: typeof envelope) => {
      Object.assign(e.payload.preparation, { unknown: true });
    },
    (e: typeof envelope) => {
      Reflect.deleteProperty(e.payload.preparation, 'skeleton');
    },
    (e: typeof envelope) => {
      const s = e.payload.preparation.substitutions[0];
      if (!s) throw Error('SLOT_REQUIRED');
      s.sourceOrdinal = 0.5;
    },
    (e: typeof envelope) => {
      const s = e.payload.preparation.substitutions[0];
      if (!s) throw Error('SLOT_REQUIRED');
      s.sourceOrdinal = 5000;
    },
  ]) {
    const e = structuredClone(envelope);
    mutate(e);
    await expect(check(e)).rejects.toThrow();
  }
});
fixtureIt(
  'rejects placeholder, duplicate/prefix, unused pool and inventory digest divergence',
  async () => {
    const nonnull = structuredClone(envelope);
    const occupied = nonnull.payload.preparation.substitutions[0];
    if (!occupied) throw Error('SLOT_REQUIRED');
    const keys = occupied.location.replace(/\[([0-9]+)\]/g, '.$1').split('.');
    let parent: unknown = nonnull.payload.preparation.skeleton;
    const last = keys.pop();
    if (last === undefined) throw Error('KEY_REQUIRED');
    for (const key of keys) {
      if (parent === null || typeof parent !== 'object') throw Error('PARENT_REQUIRED');
      parent = Reflect.get(parent, key);
    }
    if (parent === null || typeof parent !== 'object') throw Error('PARENT_REQUIRED');
    Object.defineProperty(parent, last, {
      value: 0,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    await expect(check(nonnull)).rejects.toThrow();
    const duplicate = structuredClone(envelope);
    const slot = duplicate.payload.preparation.substitutions[0];
    if (!slot) throw Error('SLOT_REQUIRED');
    duplicate.payload.preparation.substitutions.push({ ...slot });
    await expect(check(duplicate)).rejects.toThrow();
    const prefix = structuredClone(envelope);
    prefix.payload.preparation.substitutions.push({ ...slot, location: slot.location + '.nested' });
    await expect(check(prefix)).rejects.toThrow();
    const unused = structuredClone(envelope);
    const pooled = unused.payload.preparation.sourcePool[0];
    if (!pooled) throw Error('POOL_REQUIRED');
    unused.payload.preparation.sourcePool.push({
      ...pooled,
      ordinal: unused.payload.preparation.sourcePool.length,
    });
    await expect(check(unused)).rejects.toThrow();
    const divergent = structuredClone(envelope);
    const first = divergent.payload.preparation.sourcePool[0];
    if (!first) throw Error('POOL_REQUIRED');
    first.dtoDigest = 'f'.repeat(64);
    await expect(check(divergent)).rejects.toThrow();
  },
);
fixtureIt(
  'rejects metadata/unsafe/proposed paths, missing keys and oversized encoded input',
  async () => {
    for (const path of [
      'payload.inventory',
      'context.__proto__',
      'candidate.after',
      'context.missing',
      'context.nutrition[-1]',
      'context.nutrition[999999999999]',
    ])
      await expect(lookup(envelope, path)).rejects.toThrow();
    const oversized = structuredClone(envelope);
    Object.assign(oversized.payload.preparation.skeleton, { huge: 'x'.repeat(4194304) });
    await expect(check(oversized)).rejects.toThrow('POOLED_ENCODED_BOUND');
  },
);
fixtureIt('preflights an amplified individual selected root before reconstruction', async () => {
  const e = structuredClone(envelope);
  const slot = e.payload.preparation.substitutions[0];
  if (!slot) throw Error('SLOT_REQUIRED');
  const pooled = e.payload.preparation.sourcePool[slot.sourceOrdinal];
  if (!pooled) throw Error('POOL_REQUIRED');
  pooled.body = { literal: 'x'.repeat(1500000) };
  // Structural membership is not source authentication. This deliberate fault
  // changes the body under its declared digest; authoritative stores must reject.
  // Resolver capacity still cannot allocate a >4MiB selected subtree.
  const frame = z.record(z.string(), z.unknown()).parse(e.payload.preparation.skeleton.context);
  frame['amplification'] = [null, null, null];
  e.payload.preparation.skeleton.context = z.json().parse(frame);
  const ref = e.payload.inventory.refs.find(
    (r) => JSON.stringify(r.identity) === JSON.stringify(pooled.identity),
  );
  if (!ref) throw Error('REF_REQUIRED');
  for (let i = 0; i < 3; i++) {
    const location = `context.amplification[${i}]`;
    ref.copiedLocations.push(location);
    e.payload.preparation.substitutions.push({ location, sourceOrdinal: slot.sourceOrdinal });
  }
  await expect(lookup(e, 'context')).rejects.toThrow('POOLED_SELECTED_BODY_BOUND');
});
fixtureIt(
  'denies runtime/PUBLIC execution and preserves INVOKER/config/catalog boundaries',
  async () => {
    const app = new Pool({ connectionString: url(runtimeRole) });
    try {
      await expect(
        app.query('SELECT wm_manual_pooled.lookup($1::jsonb,$2::text)', [
          JSON.stringify(envelope),
          'context',
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.end();
    }
    await owner(async (p) => {
      const rows = await p.query<{
        prosecdef: boolean;
        proconfig: string[];
        public_execute: boolean;
      }>(
        `SELECT p.prosecdef,p.proconfig,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wm_manual_pooled'`,
      );
      expect(rows.rows).toHaveLength(6);
      for (const row of rows.rows) {
        expect(row.prosecdef).toBe(false);
        expect(row.proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(row.public_execute).toBe(false);
      }
    });
  },
);
