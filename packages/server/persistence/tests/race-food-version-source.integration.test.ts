import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { saveFoodDefinitionVersionRequestSchema } from '@workout/contracts/nutrition-core';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createConsentRepository } from '../src/repositories.js';
import { grantCorePlanning, grantNutritionCore, grantOperations, migrate } from '../src/migrate.js';
import {
  captureRaceFoodVersionSourceIn,
  type SourceBudget,
} from '../src/race-plan-impact-nested-sources.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `race_food_source_${suffix}`;
const ownerRole = `race_food_owner_${suffix}`;
const runtimeRole = `race_food_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
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
  await migrate(url(ownerRole));
  for (const grant of [grantCorePlanning, grantNutritionCore, grantOperations])
    await grant(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
function snapshot<T>(athlete: string, run: (tx: Transaction) => Promise<T>) {
  const port = db.snapshotTenant;
  if (!port) throw Error('SNAPSHOT_PORT_UNAVAILABLE');
  return port(athlete, run);
}
const unknown = <T extends 'g' | 'mg' | 'mL' | 'kcal'>(unit: T) => ({
  value: null,
  unit,
  status: 'unknown',
  evidenceIds: [],
});
function command(foodId = '식품/opaque-𐀀-0') {
  return saveFoodDefinitionVersionRequestSchema.parse({
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    confirmed: true,
    definition: {
      foodId,
      name: 'Synthetic food',
      basis: { kind: 'per_100g' },
      nutrients: {
        energy: unknown('kcal'),
        carbohydrate: unknown('g'),
        protein: unknown('g'),
        fat: unknown('g'),
        fluid: unknown('mL'),
        sodium: unknown('mg'),
      },
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-10-07T00:00:00.000Z',
        reviewState: 'unreviewed',
      },
    },
  });
}
async function seed() {
  const athlete = randomUUID();
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const repo = createNutritionRepository(db);
  const first = await repo.saveFood(athlete, command());
  return { athlete, repo, first };
}
function capture(
  athlete: string,
  versionId: string,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
) {
  return snapshot(athlete, (tx) => captureRaceFoodVersionSourceIn(tx, versionId, budget));
}
it('reads exact current immutable public food with opaque ID and distinct head/provenance', async () => {
  const { athlete, first } = await seed();
  const result = await capture(athlete, first.versionId.toUpperCase());
  expect(result).toMatchObject({
    requestedVersionId: first.versionId,
    state: 'current',
    content: {
      foodId: first.foodId,
      versionId: first.versionId,
      record: first,
      digest: impactDependencyDigest(first),
    },
    currentHead: { versionId: first.versionId },
  });
  expect(result.content?.record.nutrients.energy.value).toBeNull();
});
it('keeps old body and provenance when the public head advances', async () => {
  const { athlete, repo, first } = await seed();
  const base = command(first.foodId);
  const second = await repo.saveFood(athlete, {
    ...base,
    expectedVersionId: first.versionId,
    definition: {
      ...base.definition,
      name: 'New head',
      provenance: { ...base.definition.provenance, capturedAt: '2026-10-07T01:00:00.000Z' },
    },
  });
  const result = await capture(athlete, first.versionId);
  expect(result).toMatchObject({
    state: 'historical',
    content: { record: first },
    currentHead: {
      versionId: second.versionId,
      provenance: { capturedAt: second.provenance.capturedAt },
    },
  });
  expect(await capture(athlete, second.versionId)).toMatchObject({
    state: 'current',
    content: { record: second },
  });
});
it('returns unavailable for foreign and absent versions without invented food or head', async () => {
  const { athlete, first } = await seed();
  for (const [owner, id] of [
    [randomUUID(), first.versionId],
    [athlete, randomUUID()],
  ]) {
    if (!owner || !id) throw Error('FIXTURE_TUPLE_MISSING');
    expect(await capture(owner, id)).toEqual({
      requestedVersionId: id,
      state: 'unavailable',
      content: null,
      currentHead: null,
    });
  }
});
it('reserves scalar bytes before transporting body at an inherited near cap', async () => {
  const { athlete, first } = await seed();
  const queries: string[] = [];
  const budget = { bytes: 4194303n, sources: 0 };
  await expect(
    snapshot(athlete, (tx) => {
      const traced: Transaction = {
        athleteId: tx.athleteId,
        query: (sql, values) => {
          queries.push(sql);
          return tx.query(sql, values);
        },
      };
      return captureRaceFoodVersionSourceIn(traced, first.versionId, budget);
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('octet_length');
  expect(budget.bytes).toBeGreaterThan(4194304n);
});
it('rejects malformed requested UUID before any source query', async () => {
  const queries: string[] = [];
  await expect(
    snapshot(randomUUID(), (tx) => {
      const traced: Transaction = {
        athleteId: tx.athleteId,
        query: (sql, values) => {
          queries.push(sql);
          return tx.query(sql, values);
        },
      };
      return captureRaceFoodVersionSourceIn(traced, 'opaque-not-a-version', {
        bytes: 0n,
        sources: 0,
      });
    }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(queries).toEqual([]);
});
it('refuses a body transport with a mismatched exact row version tuple', async () => {
  const { athlete, first } = await seed();
  await expect(
    snapshot(athlete, (tx) => {
      const traced: Transaction = {
        athleteId: tx.athleteId,
        query: async (sql, values) => {
          const result = await tx.query(sql, values);
          if (sql.startsWith('SELECT v.food_id'))
            return {
              ...result,
              rows: result.rows.map((row) => ({ ...row, version_id: randomUUID() })),
            };
          return result;
        },
      };
      return captureRaceFoodVersionSourceIn(traced, first.versionId, { bytes: 0n, sources: 0 });
    }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});

it('rejects invalid direct budget counters before querying without resetting caller state', async () => {
  for (const budget of [
    { bytes: -1n, sources: 0 },
    { bytes: 0n, sources: NaN },
    { bytes: 0n, sources: -1 },
    { bytes: 0n, sources: 0.5 },
  ]) {
    const queries: string[] = [];
    await expect(
      snapshot(randomUUID(), (tx) => {
        const traced: Transaction = {
          athleteId: tx.athleteId,
          query: (sql, values) => {
            queries.push(sql);
            return tx.query(sql, values);
          },
        };
        return captureRaceFoodVersionSourceIn(traced, randomUUID(), budget);
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    expect(queries).toEqual([]);
  }
});
