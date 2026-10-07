import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { prepareRaceManualReviewCompatibleV4In } from '../src/race-manual-review-preparation-v2.js';
import { enumerateRaceManualReviewFullCopiedSourcesV2 } from '../src/race-manual-review-full-copied-inventory-v2.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import type { SourceBudget } from '../src/race-plan-impact-nested-sources.js';
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
// Public normal107 producers only. Root executes PG; no stored candidate/approval,
// provider evidence, new grant capability or full-owned adapter is exercised here.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `unplanned_${suffix}`,
  ownerRole = `unplanned_owner_${suffix}`,
  runtimeRole = `unplanned_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
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
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
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
async function setup() {
  const athlete = randomUUID();
  // Synthetic identity FK prerequisite only: no health/source/approval owner DML.
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
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic race',
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
  const routines = createRoutineRepository(db);
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Frozen checklist',
    intent: 'Synthetic',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'Checklist-食',
        title: 'Explicit report',
        content: { kind: 'checklist', prompt: '합성 확인을 기록한다' },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
  await routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  return { athlete, race, routines, blueprint };
}
for (const scheduleCount of [0, 1, 2])
  it(`public unplanned run retains frozen body with ${scheduleCount} unrelated same-blueprint schedules`, async () => {
    const f = await setup();
    for (let i = 0; i < scheduleCount; i++) {
      const input = {
        schedule: {
          schemaVersion: 4 as const,
          id: randomUUID(),
          versionId: randomUUID(),
          blueprint: { id: f.blueprint.routineId, versionId: f.blueprint.versionId },
          window: {
            startDate: '2026-10-01',
            endDateExclusive: '2026-11-01',
            timezone: 'Asia/Seoul',
            maxOccurrences: 10,
          },
          rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '08:00' },
          state: 'draft' as const,
        },
        sourcePlanVersionId: null,
      };
      const preview = await f.routines.previewSchedule(f.athlete, input);
      await f.routines.approveSchedule(f.athlete, {
        ...input,
        previewDigest: preview.previewDigest,
        idempotencyKey: randomUUID(),
        confirmed: true,
      });
    }
    let run = await f.routines.startRun(f.athlete, {
      runId: randomUUID(),
      blueprintVersionId: f.blueprint.versionId,
      occurrenceId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    run = await f.routines.recordStep(f.athlete, {
      runId: run.run.id,
      stepId: 'Checklist-食',
      state: 'performed',
      actualRefs: [],
      occurredAt: '2026-10-06T00:00:00Z',
      reason: null,
      expectedRevision: run.run.revision,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const timer = await f.routines.commandTimer(f.athlete, {
      runId: run.run.id,
      stepId: 'Checklist-食',
      action: 'start',
      durationSeconds: 30,
      expectedRevision: null,
      idempotencyKey: randomUUID(),
    });
    await f.routines.saveBlueprint(f.athlete, {
      blueprint: { ...f.blueprint, versionId: randomUUID(), title: 'New head' },
      expectedVersionId: f.blueprint.versionId,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    await db.snapshotTenant(f.athlete, async (tx) => {
      const artifacts = async () =>
        (
          await tx.query(
            'SELECT (SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
            [f.athlete],
          )
        ).rows;
      const before = await artifacts();
      const budget: SourceBudget = { bytes: 0n, sources: 0 };
      const prepared = await prepareRaceManualReviewCompatibleV4In(
        tx,
        {
          expectedEvent: { id: f.race.id, revision: f.race.revision },
          newLocalDate: '2026-10-08',
          selection: { kind: 'keep_plan' },
        },
        budget,
      );
      if (!('sourceInput' in prepared) || !('candidate' in prepared))
        throw Error(
          `PREPARATION_BLOCKED:${'stage' in prepared ? prepared.stage : 'unknown'}:${'reason' in prepared ? prepared.reason : 'unknown'}`,
        );
      expect(prepared.sourceInput.projectionInput.retainedUnplannedRuns).toEqual([
        { blueprint: f.blueprint, run: run.run },
      ]);
      expect(prepared.candidate.body.projection.retainedUnplannedRuns).toEqual([
        { state: 'retained_unplanned', blueprint: f.blueprint, run: run.run },
      ]);
      expect(
        prepared.candidate.body.projection.routines.every((row) => row.runs.length === 0),
      ).toBe(true);
      expect(
        prepared.context.routineTimerReads?.some((row) =>
          row.timers.some((t) => t.runId === run.run.id && t.revision === timer.revision),
        ),
      ).toBe(true);
      const mapped = enumerateRaceManualReviewFullCopiedSourcesV2({
        context: prepared.context,
        sourceInput: prepared.sourceInput,
        candidate: prepared.candidate,
      });
      expect(mapped).toMatchObject({
        inventoryState: 'mapped',
        allCopiedBodiesIndexed: true,
        authority: 'none',
        approvalAllowed: false,
        storage: 'not_persisted',
        candidateCoverage: { complete: false },
      });
      expect(mapped.candidateCoverage?.missing).toHaveLength(5);
      const ref = mapped.refs.find(
        (row) => row.identity.kind === 'routine-run' && row.identity.sourceId === run.run.id,
      );
      expect(ref?.dtoDigest).toBe(impactDependencyDigest(run.run));
      expect(ref?.copiedLocations).toEqual(
        expect.arrayContaining([
          'context.routineActualManifest.runs[0].record',
          'sourceInput.projectionInput.retainedUnplannedRuns[0].run',
          'candidate.body.projectionInput.retainedUnplannedRuns[0].run',
          'candidate.body.projection.retainedUnplannedRuns[0].run',
        ]),
      );
      expect(await artifacts()).toEqual(before);
    });
    expect((await f.routines.readRun(f.athlete, run.run.id))?.run).toEqual(run.run);
    expect(await f.routines.readRun(randomUUID(), run.run.id)).toBeNull();
  });
it('foreign event preparation stays unavailable rather than retaining foreign run', async () => {
  const f = await setup();
  // App admission is a preceding gate. Use a legitimate second tenant with its
  // own public consent so this case reaches foreign event ownership validation.
  const other = await setup();
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  await expect(
    db.snapshotTenant(other.athlete, (tx) =>
      prepareRaceManualReviewCompatibleV4In(tx, {
        expectedEvent: { id: f.race.id, revision: f.race.revision },
        newLocalDate: '2026-10-08',
        selection: { kind: 'keep_plan' },
      }),
    ),
  ).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
});
