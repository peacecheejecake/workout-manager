import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 as encode } from '../src/race-manual-review-pooled-retained-payload-v1.js';
import { toRaceManualReviewPooledDatabaseEnvelopeV1 as toDatabase } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import { captureRaceManualReviewLifecycleInventoryV2In } from '../src/race-manual-review-lifecycle-inventory-v2.js';
import { installCurrentRuntimeV5 } from '../src/current-runtime-installation-v5.js';
import { grantCurrentRuntimeV5Profile } from '../src/current-runtime-grants-v5.js';
import * as baseline from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root actual PG only. Public synthetic sources, no private health/event seed.
// Account row is the identity-only foreign-key prerequisite, not source authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `pooled_transport_${suffix}`,
  ownerRole = `pooled_transport_owner_${suffix}`,
  runtimeRole = `pooled_transport_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false,
  db: Database,
  envelope: ReturnType<typeof toDatabase>;
let athlete: string;
let current: Awaited<ReturnType<typeof prepareRaceManualSemanticBasisV2In>>;
let lifecycle: Awaited<ReturnType<typeof captureRaceManualReviewLifecycleInventoryV2In>>;
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
  await installCurrentRuntimeV5(url(ownerRole));
  for (const grant of appRecipe) await grant(url(ownerRole), runtimeRole);
  await grantCurrentRuntimeV5Profile(url(ownerRole), runtimeRole);
  await owner(async (p) => {
    await p.query(
      await readFile(
        new URL('../migrations/134_manual_pooled_preparation_resolver.sql', import.meta.url),
        'utf8',
      ),
    );
  });
  await owner(async (p) => {
    await p.query(
      await readFile(
        new URL('../migrations/135_manual_pooled_store_and_basis.sql', import.meta.url),
        'utf8',
      ),
    );
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb), public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb) TO "${runtimeRole}"`,
    );
  });
  await owner(async (p) => {
    await p.query(
      await readFile(
        new URL('../migrations/136_manual_pooled_chain_reader_and_ack.sql', import.meta.url),
        'utf8',
      ),
    );
    await p.query(
      `GRANT EXECUTE ON FUNCTION public.read_manual_race_pooled_chain_v1(uuid), public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb) TO "${runtimeRole}"`,
    );
  });
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  athlete = randomUUID();
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
      title: 'Synthetic pooled transport',
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
    current = prepared;
    lifecycle = await captureRaceManualReviewLifecycleInventoryV2In(
      tx,
      prepared.prepared.retained,
      { bytes: 0n, sources: 0 },
    );
    if (lifecycle.status !== 'dependency_correspondence') throw Error('LIFECYCLE_UNAVAILABLE');
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

import {
  storeRaceManualPooledChainTransportV1In as store,
  readRaceManualPooledChainTransportV1In as read,
  ackRaceManualPooledChainTransportV1In as ack,
} from '../src/race-manual-pooled-chain-transport-v1.js';
import { decodeRaceManualReviewPooledDatabaseEnvelopeV1 as decode } from '../src/race-manual-review-pooled-database-envelope-v1.js';
import type { raceManualReviewChainResultV2Schema } from '../src/race-manual-review-chain-v2.js';
function basis() {
  if (current.status !== 'current_dependencies_captured') throw Error('BASIS_UNAVAILABLE');
  return current.basis;
}
function logical() {
  const value = decode(envelope);
  if (value.state !== 'present') throw Error('PRESENT_REQUIRED');
  return value;
}
function command(key: string) {
  return { schemaVersion: 2, idempotencyKey: key, intent: basis().intent, expectedBasis: basis() };
}
async function snapshot<T>(operation: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  return db.snapshotTenant(athlete, operation);
}
async function rejected(tx: Transaction, operation: () => Promise<unknown>) {
  await tx.query('SAVEPOINT denied');
  try {
    await expect(operation()).rejects.toThrow();
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT denied');
    await tx.query('RELEASE SAVEPOINT denied');
  }
}
const key = randomUUID();
let originalResult: z.infer<typeof raceManualReviewChainResultV2Schema>;
fixtureIt(
  'actual store, same-xid ACK, full read and receipt replay preserve original without applying a plan',
  async () => {
    const beforeRace = await createRaceRepository(db).getRaceEvent(athlete, basis().event.id);
    await snapshot(async (tx) => {
      const budget = { bytes: 0n, sources: 0 };
      const stored = await store(tx, command(key), logical(), basis(), lifecycle, budget);
      expect(stored.status).toBe('stored');
      originalResult = stored.result;
      const acknowledged = await ack(tx, stored.result, logical(), budget);
      expect(acknowledged).toMatchObject({
        ackVersion: 2,
        payloadEncoding: 'pooled-database-envelope-v1',
        correspondence: 'same_tx_stored_parent',
        result: stored.result,
        authority: 'none',
        approvalAllowed: false,
      });
      const viewed = await read(tx, stored.result.evidenceId, budget);
      if (viewed.status !== 'read') throw Error('READ_REQUIRED');
      expect(viewed.payload).toEqual(logical());
      expect(viewed).toMatchObject({
        bodyState: 'present',
        payloadEncoding: 'pooled-database-envelope-v1',
        planApplied: false,
      });
      expect(budget.bytes).toBeGreaterThan(0n);
      const replay = await store(tx, command(key), null, null, null, budget);
      expect(replay).toMatchObject({ status: 'replayed', result: stored.result });
    });
    expect(await createRaceRepository(db).getRaceEvent(athlete, basis().event.id)).toEqual(
      beforeRace,
    );
  },
);
fixtureIt('new transaction acknowledgement fails while retained read stays lossless', async () => {
  await snapshot(async (tx) => {
    const budget = { bytes: 0n, sources: 0 };
    const viewed = await read(tx, originalResult.evidenceId, budget);
    expect(viewed.status).toBe('read');
    await rejected(tx, () => ack(tx, originalResult, logical(), budget));
  });
});
fixtureIt('foreign tenant never receives parent body or acknowledgement', async () => {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_REQUIRED');
  await db.snapshotTenant(randomUUID(), async (tx) => {
    expect(await read(tx, originalResult.evidenceId, { bytes: 0n, sources: 0 })).toMatchObject({
      status: 'unavailable',
      authority: 'none',
    });
    await rejected(tx, () => ack(tx, originalResult, logical(), { bytes: 0n, sources: 0 }));
  });
});
fixtureIt(
  'malformed logical source and wrong result digest reject without fresh SQL store',
  async () => {
    await snapshot(async (tx) => {
      let stores = 0;
      const observed: Transaction = {
        athleteId: tx.athleteId,
        query: async (sql, values) => {
          if (sql.includes('public.store_manual_race_pooled_chain_v1(')) stores++;
          return tx.query(sql, values);
        },
      };
      const changed = structuredClone(logical());
      changed.minimalAudit.candidateDigest = 'f'.repeat(64);
      await expect(
        store(observed, command(randomUUID()), changed, basis(), lifecycle, {
          bytes: 0n,
          sources: 0,
        }),
      ).rejects.toThrow();
      expect(stores).toBe(0);
      await expect(
        ack(observed, { ...originalResult, candidateDigest: 'f'.repeat(64) }, logical(), {
          bytes: 0n,
          sources: 0,
        }),
      ).rejects.toThrow();
    });
  },
);
fixtureIt(
  'actual MATERIALIZED response gate respects inherited remaining budget before driver body',
  async () => {
    await snapshot(async (tx) => {
      const measured = await tx.query(
        'SELECT octet_length(public.read_manual_race_pooled_chain_v1($1)::text)::text AS bytes',
        [originalResult.evidenceId],
      );
      const bytes = z
        .string()
        .regex(/^[1-9][0-9]*$/)
        .parse(measured.rows[0]?.['bytes']);
      expect(BigInt(bytes)).toBeGreaterThan(64n);
      const budget = { bytes: 4194304n - 64n, sources: 0 };
      const before = budget.bytes;
      await expect(read(tx, originalResult.evidenceId, budget)).rejects.toMatchObject({
        code: 'CONTEXT_UNAVAILABLE',
      });
      expect(budget.bytes).toBe(before);
      const near = { bytes: 4194304n - BigInt(bytes), sources: 0 };
      expect((await read(tx, originalResult.evidenceId, near)).status).toBe('read');
      expect(near.bytes).toBe(4194304n);
    });
  },
);
fixtureIt(
  'SQL cancellation propagates and successful transport store rolls back on callback failure',
  async () => {
    await snapshot(async (tx) => {
      const delayed: Transaction = {
        athleteId: tx.athleteId,
        query: async (sql, values) => {
          await tx.query('SELECT pg_sleep(0.02)');
          return tx.query(sql, values);
        },
      };
      await tx.query('SAVEPOINT deadline');
      try {
        await tx.query("SET LOCAL statement_timeout='1ms'");
        await expect(
          read(delayed, originalResult.evidenceId, { bytes: 0n, sources: 0 }),
        ).rejects.toMatchObject({ code: '57014' });
      } finally {
        await tx.query('ROLLBACK TO SAVEPOINT deadline');
        await tx.query('RELEASE SAVEPOINT deadline');
      }
    });
    const rollbackKey = randomUUID();
    let candidate: string | null = null;
    await expect(
      snapshot(async (tx) => {
        const result = await store(tx, command(rollbackKey), logical(), basis(), lifecycle, {
          bytes: 0n,
          sources: 0,
        });
        candidate = result.result.evidenceId;
        throw Error('FORCED_TRANSPORT_ROLLBACK');
      }),
    ).rejects.toThrow('FORCED_TRANSPORT_ROLLBACK');
    if (candidate === null) throw Error('NO_STORED_RESULT');
    await snapshot(async (tx) => {
      expect(await read(tx, candidate, { bytes: 0n, sources: 0 })).toMatchObject({
        status: 'unavailable',
      });
      const receipt = await tx.query(
        'SELECT public.read_manual_race_chain_receipt_v2($1,$2) AS value',
        [rollbackKey, JSON.stringify(command(rollbackKey))],
      );
      expect(receipt.rows[0]?.['value']).toBeNull();
    });
  },
);
fixtureIt(
  'withdrawal permits original receipt/read but fresh processing remains denied',
  async () => {
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      expect((await read(tx, originalResult.evidenceId, { bytes: 0n, sources: 0 })).status).toBe(
        'read',
      );
      expect(
        await store(tx, command(key), null, null, null, { bytes: 0n, sources: 0 }),
      ).toMatchObject({ status: 'replayed', result: originalResult });
      await rejected(tx, () =>
        store(tx, command(randomUUID()), logical(), basis(), lifecycle, { bytes: 0n, sources: 0 }),
      );
    });
  },
);
fixtureIt(
  'genuine source deletion returns contentless unknown encoding and immutable original receipt',
  async () => {
    await createConsentRepository(db).setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 2,
      idempotencyKey: randomUUID(),
    });
    await createRaceRepository(db).deleteRaceEvent(athlete, basis().event.id, {
      expectedRevision: basis().event.revision,
      idempotencyKey: randomUUID(),
    });
    await snapshot(async (tx) => {
      const viewed = await read(tx, originalResult.evidenceId, { bytes: 0n, sources: 0 });
      expect(viewed).toMatchObject({
        status: 'read',
        bodyState: 'purged',
        payload: null,
        payloadEncoding: null,
        result: originalResult,
      });
      if (viewed.status !== 'read' || viewed.bodyState !== 'purged') throw Error('PURGED_REQUIRED');
      expect(viewed.purgedAt).not.toBeNull();
      expect(viewed.purgedEventId).not.toBeNull();
      expect(
        await store(tx, command(key), null, null, null, { bytes: 0n, sources: 0 }),
      ).toMatchObject({ status: 'replayed', result: originalResult });
      await rejected(tx, () => ack(tx, originalResult, logical(), { bytes: 0n, sources: 0 }));
    });
  },
);
