import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { NutritionPlanDraft } from '@workout/contracts/nutrition-core';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantNutritionCore,
  grantRaces,
  grantOperations,
} from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Acceptance PREPARATION. Run only under the canonical disposable integration
// harness. Normal public migrations/grants, no offline fake nutrition/source body.
// Explicit focused108 mode adds the unregistered storage migration after normal107;
// that mode is actual local storage evidence, never public registry/restore admission.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `nutrition_writer_${suffix}`,
  ownerRole = `nutrition_writer_owner_${suffix}`,
  runtimeRole = `nutrition_writer_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const createdRoles: string[] = [];
let created = false,
  db: Database;
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
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole));
  const focused108 = process.env['TEST_NUTRITION_WRITER_FOCUSED_108'];
  if (focused108 !== undefined && focused108 !== '1') throw new Error('INVALID_FOCUSED_108_MODE');
  if (focused108 === '1') {
    const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
    try {
      const state = await owner.query('SELECT max(version)::int AS version FROM schema_migrations');
      if (state.rows[0]?.['version'] !== 107) throw new Error('FOCUSED_108_EXPECTED_NORMAL_107');
      await owner.query(
        await readFile(
          new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
          'utf8',
        ),
      );
    } finally {
      await owner.end();
    }
  }
  for (const grant of [grantCorePlanning, grantNutritionCore, grantRaces, grantOperations])
    await grant(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function app(athlete: string, granted: boolean) {
  const repo = createConsentRepository(db);
  const current = await repo.getConsent(athlete, 'app');
  await repo.setConsent(athlete, {
    kind: 'app',
    granted,
    expectedRevision: current?.revision ?? 0,
    idempotencyKey: randomUUID(),
  });
}
const values: RaceEventValues = {
  title: 'Synthetic race',
  localDate: '2026-10-07',
  localStartTime: '09:00',
  timezone: 'UTC',
  locationName: null,
  distance: { kind: 'standard', class: '10k' },
  priority: null,
  participation: 'registered',
  officialUrl: null,
  course: null,
  targetSeconds: null,
  planVersionId: null,
};
function draft(eventId: string, point: 'start' | 'end' = 'start'): NutritionPlanDraft {
  return {
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'UTC',
    purpose: 'Own meal schedule',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: 'meal',
        category: 'before',
        title: 'Meal',
        anchor: { kind: 'relative', entity: 'race', entityId: eventId, point, offsetMinutes: -30 },
        foods: [],
        targets: [],
        instructions: 'User-approved meal action',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
}
function intent(eventId: string, revision = 1) {
  return {
    schemaVersion: 2 as const,
    command: {
      kind: 'create' as const,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
      draft: draft(eventId),
    },
    expectedRaceHeads: [{ namespace: 'race-event' as const, eventId, revision }],
  };
}
async function setup() {
  const athlete = randomUUID();
  await app(athlete, true);
  const event = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values,
  });
  return { athlete, event, writer: createNutritionRacePlanWriter(db) };
}
async function counts(athlete: string) {
  return db.tenant(
    athlete,
    async (tx) =>
      (
        await tx.query(
          `SELECT (SELECT count(*) FROM nutrition_plan_version WHERE athlete_id=$1)::int AS versions,(SELECT count(*) FROM nutrition_plan_history WHERE athlete_id=$1)::int AS history,(SELECT count(*) FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'nutrition-plan:%')::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1 AND topic='nutrition.plan_changed')::int AS outbox`,
          [athlete],
        )
      ).rows,
  );
}
it('new race nutrition writes reject absent/false app without partial artifacts', async () => {
  const { event, writer } = await setup();
  for (const granted of [null, false]) {
    const athlete = randomUUID();
    if (granted === false) await app(athlete, false);
    const before = await counts(athlete);
    await expect(writer.savePlanV2(athlete, intent(event.id))).rejects.toMatchObject({
      code: 'APP_CONSENT_REQUIRED',
    });
    expect(await counts(athlete)).toEqual(before);
  }
});
it('public create persists exact immutable pin/version/history/receipt/outbox and replay survives withdrawal', async () => {
  const { athlete, event, writer } = await setup(),
    command = intent(event.id);
  const saved = await writer.savePlanV2(athlete, command);
  expect(saved).toMatchObject({
    schemaVersion: 2,
    version: 1,
    raceTimingPins: [{ eventId: event.id, eventRevision: 1 }],
    items: [{ id: 'meal' }],
  });
  expect(await counts(athlete)).toEqual([{ versions: 1, history: 1, receipts: 1, outbox: 1 }]);
  await app(athlete, false);
  const before = await counts(athlete);
  expect(await writer.savePlanV2(athlete, command)).toEqual(saved);
  await expect(
    writer.savePlanV2(athlete, {
      ...command,
      command: { ...command.command, idempotencyKey: randomUUID() },
    }),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  expect(await counts(athlete)).toEqual(before);
});
it('public update preserves unaffected frozen timing after an actual race edit, then affected update captures new head', async () => {
  const { athlete, event, writer } = await setup(),
    saved = await writer.savePlanV2(athlete, intent(event.id));
  if (!('schemaVersion' in saved) || saved.schemaVersion !== 2) throw Error('expected V2');
  await createRaceRepository(db).updateRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values, localStartTime: '10:00' },
  });
  const update = {
    schemaVersion: 2 as const,
    command: {
      kind: 'update' as const,
      planId: saved.planId,
      expectedHeadVersionId: saved.versionId,
      idempotencyKey: randomUUID(),
      confirmed: true as const,
      draft: { ...draft(event.id), purpose: 'Changed purpose only' },
    },
    expectedRaceHeads: [{ namespace: 'race-event' as const, eventId: event.id, revision: 2 }],
  };
  const kept = await writer.savePlanV2(athlete, update);
  expect(kept).toMatchObject({ version: 2, raceTimingPins: saved.raceTimingPins });
  const changed = await writer.savePlanV2(athlete, {
    ...update,
    command: {
      ...update.command,
      expectedHeadVersionId: kept.versionId,
      idempotencyKey: randomUUID(),
      draft: {
        ...update.command.draft,
        items: update.command.draft.items.map((item) => ({
          ...item,
          instructions: 'Explicit changed action',
        })),
      },
    },
  });
  expect(changed).toMatchObject({ version: 3, raceTimingPins: [{ eventRevision: 2 }] });
});
it('stale race head and unresolved affected end never write partial approval', async () => {
  const { athlete, event, writer } = await setup();
  const before = await counts(athlete);
  await expect(writer.savePlanV2(athlete, intent(event.id, 2))).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_APPROVAL_BLOCKED',
  });
  const command = intent(event.id);
  await expect(
    writer.savePlanV2(athlete, {
      ...command,
      command: { ...command.command, draft: draft(event.id, 'end') },
    }),
  ).rejects.toMatchObject({ code: 'NUTRITION_TIMING_APPROVAL_BLOCKED' });
  expect(await counts(athlete)).toEqual(before);
});
it('populated foreign race is unavailable even with own processing permission', async () => {
  const { event, writer } = await setup(),
    athlete = randomUUID();
  await app(athlete, true);
  const before = await counts(athlete);
  await expect(writer.savePlanV2(athlete, intent(event.id))).rejects.toMatchObject({
    code: 'NUTRITION_TIMING_APPROVAL_BLOCKED',
  });
  expect(await counts(athlete)).toEqual(before);
});
it('head CAS and successful receipt payload collision remain distinct', async () => {
  const { athlete, event, writer } = await setup(),
    command = intent(event.id),
    saved = await writer.savePlanV2(athlete, command);
  const before = await counts(athlete);
  await expect(
    writer.savePlanV2(athlete, {
      ...command,
      command: { ...command.command, draft: { ...command.command.draft, purpose: 'Collision' } },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(
    writer.savePlanV2(athlete, {
      ...command,
      command: {
        ...command.command,
        kind: 'update',
        planId: saved.planId,
        expectedHeadVersionId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await counts(athlete)).toEqual(before);
  expect(await createNutritionRepository(db).readPlanV3(athlete, saved.planId)).toMatchObject({
    head: { versionId: saved.versionId },
  });
});
// This wrapper only pauses AFTER the real transaction acquires tenant0. All SQL,
// RLS, public consent commands and writer work use the actual restricted DB.
function afterTenantLock(database: Database) {
  let signal: () => void = () => {},
    release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
      signal = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  let paused = false;
  const wrapped: Database = {
    tenant: (athlete, operation) =>
      database.tenant(athlete, (tx) =>
        operation({
          athleteId: tx.athleteId,
          async query(sql, values) {
            const result = await tx.query(sql, values);
            if (!paused && /pg_advisory_xact_lock\(hashtextextended\(\$1,\s*0\)\)/.test(sql)) {
              paused = true;
              signal();
              await released;
            }
            return result;
          },
        }),
      ),
    exclusiveTenant: (athlete, operation) => database.exclusiveTenant(athlete, operation),
    close: async () => {},
  };
  return { database: wrapped, held, release };
}
it('real tenant-lock serialization preserves both writer-first and revoke-first outcomes', async () => {
  for (const writerFirst of [true, false]) {
    const { athlete, event } = await setup(),
      command = intent(event.id),
      before = await counts(athlete),
      barrier = afterTenantLock(db);
    const holder = writerFirst
      ? createNutritionRacePlanWriter(barrier.database).savePlanV2(athlete, command)
      : createConsentRepository(barrier.database).setConsent(athlete, {
          kind: 'app',
          granted: false,
          expectedRevision: 1,
          idempotencyKey: randomUUID(),
        });
    try {
      await barrier.held;
      const follower = writerFirst
        ? createConsentRepository(db).setConsent(athlete, {
            kind: 'app',
            granted: false,
            expectedRevision: 1,
            idempotencyKey: randomUUID(),
          })
        : createNutritionRacePlanWriter(db).savePlanV2(athlete, command);
      const followerResult = Promise.allSettled([follower]);
      barrier.release();
      await holder;
      const [result] = await followerResult;
      if (writerFirst) {
        expect(result?.status).toBe('fulfilled');
        expect(await counts(athlete)).toEqual([
          { versions: 1, history: 1, receipts: 1, outbox: 1 },
        ]);
      } else {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { code: 'APP_CONSENT_REQUIRED' },
        });
        expect(await counts(athlete)).toEqual(before);
      }
    } finally {
      barrier.release();
      await Promise.allSettled([holder]);
    }
  }
});
