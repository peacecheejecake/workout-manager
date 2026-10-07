import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantSupplementaryCore,
} from '../src/migrate.js';
import { captureWorkoutTemplateSources } from '../src/race-plan-impact-workout-template-sources.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Normal107 public catalog producers and normal runtime grants only. Captured
// historical facts are not permission, routing, performance or approval authority.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const dbName = `workout_sources_${suffix}`;
const ownerRole = `workout_sources_owner_${suffix}`;
const runtimeRole = `workout_sources_app_${suffix}`;
const createdRoles: string[] = [];
let created = false;
let database: Database;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole));
  const inspector = new Pool({ connectionString: url(ownerRole) });
  try {
    expect(
      (await inspector.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await inspector.end();
  }
  for (const grant of [grantCorePlanning, grantOperations, grantSupplementaryCore])
    await grant(url(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await database?.close();
  if (created) await dropIsolatedDatabase(admin, dbName);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
const at = '2026-10-07T00:00:00.000Z';
const definition = {
  kind: 'repetitions' as const,
  basis: 'per_side' as const,
  definitionId: 'rep-per-side-v1',
};
function exercise(exerciseId: string = randomUUID()) {
  return {
    definition: {
      schemaVersion: 2 as const,
      exerciseId,
      versionId: randomUUID(),
      name: 'Synthetic balance',
      family: 'balance_stability' as const,
      equipment: ['bodyweight' as const],
      tags: ['synthetic'],
      countDefinitions: [definition],
      mediaAssetIds: [],
      resourceVersionIds: [],
      reviewState: 'unreviewed' as const,
      description: 'Synthetic public producer',
      safetyNotes: '',
      supportedMetrics: ['count' as const, 'effort' as const],
      createdAt: at,
    },
    expectedVersionId: null as string | null,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
}
function routine(exerciseVersionId: string, routineId: string = randomUUID()) {
  const versionId = randomUUID();
  return {
    template: {
      schemaVersion: 2 as const,
      routineId,
      versionId,
      title: 'Synthetic workout',
      purpose: 'User selected',
      requiredEquipment: ['bodyweight' as const],
      spec: {
        schemaVersion: 2 as const,
        kind: 'supplementary' as const,
        routineVersionId: versionId,
        blocks: [
          {
            id: 'BlockCase',
            mode: 'single' as const,
            rounds: 2,
            sets: [
              {
                id: 'SetCase',
                exerciseVersionId,
                side: 'left' as const,
                count: {
                  target: {
                    min: 0,
                    max: 0,
                    unit: 'count' as const,
                    basis: 'user_confirmed' as const,
                    evidenceIds: [],
                  },
                  definition,
                },
                durationSeconds: null,
                externalResistance: { kind: 'no_added_load' as const },
                restAfterSeconds: 0,
                tempo: null,
                effort: { rir: 0, rpe: null, scaleVersion: 'rir-v1' },
              },
            ],
            restBetweenRoundsSeconds: null,
          },
        ],
      },
      createdAt: at,
    },
    expectedVersionId: null as string | null,
    idempotencyKey: randomUUID(),
    confirmed: true as const,
  };
}
async function seed() {
  const athlete = randomUUID(),
    repo = createSupplementaryRepository(database);
  await createConsentRepository(database).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const savedExercise = await repo.saveExercise(athlete, exercise());
  const savedRoutine = await repo.saveRoutine(athlete, routine(savedExercise.definition.versionId));
  const request = {
    kind: 'workout_template' as const,
    ref: { id: savedRoutine.template.routineId, versionId: savedRoutine.template.versionId },
  };
  return { athlete, repo, savedExercise, savedRoutine, request };
}
function capture(athlete: string, requests: unknown) {
  return database.tenant(athlete, (tx) =>
    captureWorkoutTemplateSources(tx, requests, { bytes: 0n, sources: 0 }),
  );
}
it('captures exact public template/exercise bodies, generated targets, units and stable digests using normal runtime', async () => {
  const f = await seed();
  const result = await database.tenant(f.athlete, async (tx) => {
    const before = await tx.query(
      'SELECT (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox',
      [f.athlete],
    );
    const facts = await captureWorkoutTemplateSources(tx, [f.request, f.request], {
      bytes: 0n,
      sources: 0,
    });
    const after = await tx.query(
      'SELECT (SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox',
      [f.athlete],
    );
    expect(after.rows).toEqual(before.rows);
    return facts;
  });
  expect(result).toMatchObject({
    authority: 'none',
    freshness: 'not_checked',
    requests: [f.request],
    templates: [f.savedRoutine.template],
    exercises: [{ record: f.savedExercise.definition, version: 1 }],
    targets: [
      {
        routineVersionId: f.savedRoutine.template.versionId,
        blockId: 'BlockCase',
        setId: 'SetCase',
        exerciseVersionId: f.savedExercise.definition.versionId,
      },
    ],
  });
  expect(result.templateFacts[0]).toMatchObject({
    state: 'current',
    reason: null,
    content: { digest: digest(f.savedRoutine.template) },
  });
  expect(result.exerciseFacts[0]).toMatchObject({
    state: 'current',
    content: { digest: digest(f.savedExercise.definition) },
  });
  expect(result.templates[0]?.spec.blocks[0]?.sets[0]).toMatchObject({
    count: { target: { min: 0, max: 0, unit: 'count' }, definition },
    durationSeconds: null,
    restAfterSeconds: 0,
    effort: { rir: 0, rpe: null },
  });
});
it('retains exact historical template and exercise pins after both public heads change', async () => {
  const f = await seed(),
    original = await capture(f.athlete, [f.request]);
  const nextExercise = await f.repo.saveExercise(f.athlete, {
    ...exercise(f.savedExercise.definition.exerciseId),
    expectedVersionId: f.savedExercise.definition.versionId,
  });
  const nextRoutine = await f.repo.saveRoutine(f.athlete, {
    ...routine(nextExercise.definition.versionId, f.savedRoutine.template.routineId),
    expectedVersionId: f.savedRoutine.template.versionId,
  });
  const result = await capture(f.athlete, [f.request]);
  expect(result.templates).toEqual(original.templates);
  expect(result.exercises).toEqual(original.exercises);
  expect(result.targets).toEqual(original.targets);
  expect(result.templateFacts[0]).toMatchObject({
    state: 'historical',
    content: original.templateFacts[0]?.content,
    currentHead: {
      aggregate_id: f.savedRoutine.template.routineId,
      version_id: nextRoutine.template.versionId,
      version: 2,
    },
  });
  expect(result.exerciseFacts[0]).toMatchObject({
    state: 'historical',
    content: original.exerciseFacts[0]?.content,
    currentHead: {
      aggregate_id: f.savedExercise.definition.exerciseId,
      version_id: nextExercise.definition.versionId,
      version: 2,
    },
  });
});
it('reports foreign and absent versions unavailable with no invented head or deletion fields', async () => {
  const f = await seed();
  for (const [athlete, request] of [
    [randomUUID(), f.request],
    [f.athlete, { kind: 'workout_template', ref: { id: randomUUID(), versionId: randomUUID() } }],
  ] as const) {
    const result = await capture(athlete, [request]);
    expect(result.templates).toEqual([]);
    expect(result.exercises).toEqual([]);
    expect(result.targets).toEqual([]);
    expect(result.templateFacts).toEqual([
      {
        requested: request,
        state: 'unavailable',
        reason: 'owned_version_unavailable',
        content: null,
        currentHead: null,
      },
    ]);
    expect(result).toMatchObject({ authority: 'none', freshness: 'not_checked' });
  }
});
it('rejects an owned version paired with forged aggregate identity', async () => {
  const f = await seed();
  await expect(
    capture(f.athlete, [{ ...f.request, ref: { ...f.request.ref, id: randomUUID() } }]),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
it('rejects public foreign exercise targets and runtime direct target forgery without owner bypass', async () => {
  const a = await seed(),
    b = await seed();
  await expect(
    a.repo.saveRoutine(a.athlete, routine(b.savedExercise.definition.versionId)),
  ).rejects.toMatchObject({ code: 'TARGET_LINK_INVALID' });
  await expect(
    database.tenant(a.athlete, (tx) =>
      tx.query(
        'INSERT INTO supplementary_routine_target_ref(athlete_id,routine_version_id,block_id,target_set_id,exercise_version_id) VALUES($1,$2,$3,$4,$5)',
        [
          a.athlete,
          a.savedRoutine.template.versionId,
          'Forged',
          'Forged',
          a.savedExercise.definition.versionId,
        ],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  expect((await capture(a.athlete, [a.request])).targets).toEqual([
    {
      routineVersionId: a.savedRoutine.template.versionId,
      blockId: 'BlockCase',
      setId: 'SetCase',
      exerciseVersionId: a.savedExercise.definition.versionId,
    },
  ]);
});
it('enforces source and byte budgets before full catalog body materialization', async () => {
  const f = await seed();
  for (const budget of [
    { bytes: 0n, sources: 5000 },
    { bytes: 4194000n, sources: 0 },
  ]) {
    const expectedQueries = budget.sources === 5000 ? 0 : 1;
    let bodyReads = 0,
      queries = 0;
    await expect(
      database.tenant(f.athlete, async (tx) => {
        const observed: Transaction = {
          athleteId: tx.athleteId,
          query(sql, values) {
            queries++;
            if (sql.startsWith('SELECT v.')) bodyReads++;
            return tx.query(sql, values);
          },
        };
        return captureWorkoutTemplateSources(observed, [f.request], budget);
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
    expect(bodyReads).toBe(0);
    expect(queries).toBe(expectedQueries);
  }
});
