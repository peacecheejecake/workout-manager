import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createActivityRepository } from '../src/activities.js';
import { captureCourseReadSources } from '../src/race-plan-impact-course-sources.js';
import { createCourseRepository, type PreparedCourseContent } from '../src/courses.js';
import { courseContentDigest } from '@workout/server-courses/digest';
import { createSessionCompletionRepository } from '../src/session-completions.js';
import {
  currentRestoreGeneration,
  requireCurrentRestoreGeneration,
} from '../src/restore-generation.js';
import {
  captureNestedNutritionSources,
  captureActivityAndMediaPermissions,
} from '../src/race-plan-impact-nested-sources.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { captureRaceImpactSourcePermissions } from '../src/race-plan-impact-source-permissions.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createResourceAccessRepository } from '../src/resource-access.js';
import { lockAppAdmission } from '../src/app-admission.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createRoutineRepository } from '../src/routine-core.js';
import {
  supplementaryExerciseVersionSchema,
  supplementarySpecSchema,
  supplementarySessionLinkSchema,
  routineTemplateVersionSchema,
} from '@workout/contracts/supplementary-core';
import { insertSupplementarySessionLink } from '../src/supplementary-core.js';
import {
  integratedDependencyKinds,
  decodeIntegratedDependencyInventory,
} from '../src/race-plan-impact-dependencies.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import {
  nutritionPlanVersionSchema,
  type NutritionPlanVersion,
} from '@workout/contracts/nutrition-core';
import { recoveryStrategyVersionSchema } from '@workout/contracts/recovery-core';
import {
  routineBlueprintVersionSchema,
  routineScheduleVersionSchema,
  routineOccurrenceSchema,
  routineRunSchema,
} from '@workout/contracts/routines';
import { planDraftSchema, planSnapshotSchema } from '@workout/contracts/planning';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import {
  migrate,
  migrationFileNames,
  grantOperations,
  grantSessionCompletions,
  grantSupplementaryCore,
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
import {
  captureRacePlanImpactContext,
  captureRacePlanImpactConsumedScope,
} from '../src/race-plan-impact-context.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  dbName = `race_context_${suffix}`,
  ownerRole = `race_context_owner_${suffix}`,
  runtimeRole = `race_context_app_${suffix}`;
let owner: Pool, database: Database, races: RaceRepository;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const values = (): RaceEventValues => ({
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
});
async function account() {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  // Explicit synthetic account permission for new race plan/actual fixture writes.
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  return athlete;
}
const create = (athlete: string, override: Partial<RaceEventValues> = {}) =>
  races.createRaceEvent(athlete, {
    values: { ...values(), ...override },
    idempotencyKey: randomUUID(),
  });
function capture(
  athlete: string,
  eventId: string,
  expectedRevision = 1,
  selection:
    | { kind: 'keep_plan' }
    | {
        kind: 'move_period';
        expectedCurrentPlanVersionId: string;
        changedSessionIds: string[];
        movedPeriodIds: string[];
      } = { kind: 'keep_plan' },
) {
  return database.tenant(athlete, (tx) =>
    captureRacePlanImpactContext(tx, { eventId, expectedRevision, selection }),
  );
}
const draft = () =>
  planDraftSchema.parse({
    title: 'Synthetic plan',
    timezone: 'Asia/Seoul',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, array) => ({
      id: level,
      parentId: index === 0 ? null : array[index - 1],
      level,
      title: level,
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2026-10-06',
        localStartTime: null,
        title: 'Synthetic planned session',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
async function training(athlete: string, body = draft(), current = true) {
  const id = randomUUID();
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) SELECT $1,$2,coalesce(max(version),0)+1,$3::jsonb FROM plan_snapshot WHERE athlete_id=$1',
      [athlete, id, JSON.stringify(body)],
    );
    if (current)
      await client.query(
        'INSERT INTO plan_head(athlete_id,aggregate_id,version_id) VALUES($1,$2,$3)',
        [athlete, randomUUID(), id],
      );
  });
  return id;
}
function nutrition(
  source: string | null,
  anchors: { entity: 'race' | 'session'; entityId: string; point?: 'start' | 'end' }[] = [],
): NutritionPlanVersion {
  const planId = randomUUID(),
    versionId = randomUUID();
  return nutritionPlanVersionSchema.parse({
    planId,
    versionId,
    version: 1,
    previousVersionId: null,
    period: { from: '2026-10-01', toInclusive: '2026-10-31' },
    timezone: 'Asia/Seoul',
    purpose: 'Synthetic schedule',
    linkedTrainingPlanVersionId: source,
    approvedAt: '2026-10-01T00:00:00Z',
    approvalId: randomUUID(),
    items: anchors.map((anchor, index) => ({
      id: `item${index}`,
      planVersionId: versionId,
      category: 'before',
      title: 'Synthetic hydration',
      anchor: {
        kind: 'relative',
        entity: anchor.entity,
        entityId: anchor.entityId,
        point: anchor.point ?? 'start',
        offsetMinutes: 0,
      },
      foods: [],
      targets: [],
      instructions: 'Review timing',
      evidenceIds: [],
      source: 'user_confirmed',
    })),
  });
}
async function seedNutrition(athlete: string, records: unknown[]) {
  await owned(athlete, async (client) => {
    await client.query(
      `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json) SELECT $1,(r->>'planId')::uuid,(r->>'versionId')::uuid,1,(r->'period'->>'from')::date,(r->'period'->>'toInclusive')::date,(r->>'linkedTrainingPlanVersionId')::uuid,(r->>'approvalId')::uuid,(r->>'approvedAt')::timestamptz,r FROM jsonb_array_elements($2::jsonb) r`,
      [athlete, JSON.stringify(records)],
    );
    await client.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) SELECT athlete_id,plan_id,version,version_id FROM nutrition_plan_version WHERE athlete_id=$1',
      [athlete],
    );
  });
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  owner = new Pool({ connectionString: url(ownerRole) });
  await grantOperations(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  await grantSessionCompletions(url(ownerRole), runtimeRole);
  // The configured identity runtime uses these same domain grants; no fixture-only SELECT.
  await grantRoutineCore(url(ownerRole), runtimeRole);
  await grantSupplementaryCore(url(ownerRole), runtimeRole);
  await grantRecoveryCore(url(ownerRole), runtimeRole);
  await grantCheckIns(url(ownerRole), runtimeRole);
  await grantCourses(url(ownerRole), runtimeRole);
  await grantNutritionCore(url(ownerRole), runtimeRole);
  // Same regular resources/retrieval combination as the configured authenticated runtime.
  await grantResources(url(ownerRole), runtimeRole);
  await grantResourceRetrieval(url(ownerRole), runtimeRole);
  // Existing configured product role composition, not collector-only privilege fabrication.
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  await grantGarminUnofficial(url(ownerRole), runtimeRole);
  // Public Activity producer privileges also used by existing API lifecycle fixtures.
  await owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
  );
  database = createDatabase({ connectionString: url(runtimeRole) });
  races = createRaceRepository(database);
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('installs all107 migrations with plain roles and returns explicit empty rosters/absence, blocked coverage and stable digest', async () => {
  const versions = await owner.query(
    'SELECT count(*)::int AS n,max(version)::int AS last FROM schema_migrations',
  );
  expect(versions.rows[0]).toEqual({ n: 107, last: 107 });
  expect(migrationFileNames).toHaveLength(107);
  for (const [version, file] of [
    [106, '106_race_manual_review.sql'],
    [107, '107_guard_race_review_stamp_authority.sql'],
  ] as const) {
    expect(migrationFileNames[version - 1]).toBe(file);
    expect(
      (await owner.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]))
        .rows,
    ).toEqual([
      {
        checksum: createHash('sha256')
          .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
          .digest('hex'),
      },
    ]);
  }
  const roles = await admin.query(
    'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)',
    [[ownerRole, runtimeRole]],
  );
  expect(roles.rows).toEqual([
    { rolsuper: false, rolbypassrls: false },
    { rolsuper: false, rolbypassrls: false },
  ]);
  const athlete = await account(),
    event = await create(athlete),
    first = await capture(athlete, event.id),
    second = await capture(athlete, event.id);
  expect(first).toMatchObject({
    status: 'blocked',
    coverage: { complete: false },
    currentTraining: null,
    linkedPlan: null,
    rosters: { nutrition: [], recovery: [], routine: [] },
    coreDependencies: { trainingPlan: { kind: 'absent' } },
    event: { localStartTime: null, targetSeconds: 0 },
  });
  expect(first.coverage.missing).toContain('routine_occurrences_and_started_runs');
  expect(first.readSetDigest).toBe(second.readSetDigest);
});
it('captures a new previously absent nutrition head and changes the read-set digest', async () => {
  const athlete = await account(),
    event = await create(athlete),
    before = await capture(athlete, event.id);
  const record = nutrition(null);
  await seedNutrition(athlete, [record]);
  const after = await capture(athlete, event.id);
  expect(after.rosters.nutrition).toEqual([
    { aggregateId: record.planId, versionId: record.versionId },
  ]);
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});
it('rejects stale CAS and makes an exact committed event revision/history visible', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await races.updateRaceEvent(athlete, event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values(), title: 'Updated' },
  });
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect((await capture(athlete, event.id, 2)).event.title).toBe('Updated');
});
it('captures a privacy-generation advance at terminal collection revision from actual deletion', async () => {
  const athlete = await account(),
    event = await create(athlete),
    other = await create(athlete);
  await owned(athlete, (client) =>
    client.query(
      "UPDATE race_collection_head SET revision=2147483647 WHERE athlete_id=$1 AND kind='race-event'",
      [athlete],
    ),
  );
  const before = await capture(athlete, event.id);
  await races.deleteRaceEvent(athlete, other.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const after = await capture(athlete, event.id);
  expect(after.collections.find((head) => head.kind === 'race-event')).toMatchObject({
    revision: 2147483647,
    privacy_generation: '1',
  });
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});
it('keeps immutable historical event link distinct from current training', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false),
    current = await training(athlete),
    event = await create(athlete, { planVersionId: historical });
  const context = await capture(athlete, event.id);
  expect(context.linkedPlan?.id).toBe(historical);
  expect(context.currentTraining?.snapshot.id).toBe(current);
});
it('classifies race and same-ID session anchors independently, keeps race end unresolved and never estimates it', async () => {
  const athlete = await account(),
    event = await create(athlete),
    body = draft();
  const session = body.sessions[0];
  if (!session) throw Error('fixture');
  session.id = event.id;
  const current = await training(athlete, body);
  const record = nutrition(current, [
    { entity: 'race', entityId: event.id, point: 'end' },
    { entity: 'session', entityId: event.id },
  ]);
  await seedNutrition(athlete, [record]);
  const keep = await capture(athlete, event.id);
  expect(keep.nutrition[0]?.relativeItems).toMatchObject([
    { entity: 'race', affected: true, point: 'end', timing: 'not_resolved' },
    { entity: 'session', affected: false },
  ]);
  expect(keep.affected.nutrition).toEqual([record.planId]);
  const move = await capture(athlete, event.id, 1, {
    kind: 'move_period',
    expectedCurrentPlanVersionId: current,
    changedSessionIds: [event.id],
    movedPeriodIds: ['block'],
  });
  expect(move.nutrition[0]?.relativeItems[1]).toMatchObject({ entity: 'session', affected: true });
});
it('does not rebind a historical current nutrition source to current training', async () => {
  const athlete = await account(),
    old = await training(athlete, draft(), false),
    current = await training(athlete),
    event = await create(athlete);
  await seedNutrition(athlete, [nutrition(old, [{ entity: 'session', entityId: 'session' }])]);
  const context = await capture(athlete, event.id, 1, {
    kind: 'move_period',
    expectedCurrentPlanVersionId: current,
    changedSessionIds: ['session'],
    movedPeriodIds: ['block'],
  });
  expect(context.nutrition[0]).toMatchObject({
    sourceRelation: 'historical',
    relativeItems: [{ affected: false, sourceVersionId: old }],
  });
  expect(context.affected.nutrition).toEqual([]);
});
it('fails closed on a foreign event and a foreign immutable linked source even when raw fixture names its ID', async () => {
  const alice = await account(),
    bob = await account(),
    plan = await training(bob),
    event = await create(alice);
  await expect(capture(bob, event.id)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  await owned(alice, async (client) => {
    const foreign = { ...values(), planVersionId: plan },
      id = randomUUID();
    await client.query(
      'INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [alice, id, JSON.stringify(foreign)],
    );
    await client.query(
      'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [alice, id, JSON.stringify(foreign)],
    );
    await expect(capture(alice, id)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  });
  // Committed fixture: separate owner tx cannot be visible before commit.
  const bad = randomUUID();
  await owned(alice, async (client) => {
    const body = { ...values(), planVersionId: plan };
    await client.query(
      'INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [alice, bad, JSON.stringify(body)],
    );
    await client.query(
      'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [alice, bad, JSON.stringify(body)],
    );
  });
  await expect(capture(alice, bad)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});
it('captures completed head revisions without moving actual or planned schedule', async () => {
  const athlete = await account(),
    plan = await training(athlete),
    event = await create(athlete),
    before = await capture(athlete, event.id);
  const report = {
    sessionId: 'session',
    revision: 1,
    planVersionId: plan,
    schedule: {
      blockId: 'block',
      date: '2026-10-06',
      localStartTime: null,
      timezone: 'Asia/Seoul',
    },
    status: 'completed',
    reportedAt: '2026-10-06T00:00:00Z',
    reason: null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  };
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO session_completion(athlete_id,session_id,revision,record_json) VALUES($1,$2,1,$3::jsonb)',
      [athlete, 'session', JSON.stringify(report)],
    );
    await client.query(
      'INSERT INTO session_completion_collection_head(athlete_id,revision) VALUES($1,1)',
      [athlete],
    );
  });
  const after = await capture(athlete, event.id);
  expect(after.completions).toEqual([report]);
  expect(after.coreDependencies.sessionCompletions).toEqual({ kind: 'exists', revision: 1 });
  expect(after.currentTraining).toEqual(before.currentTraining);
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});
it('captures public completion reports against their own frozen historical source without approving actual performance', async () => {
  const athlete = await account(),
    original = await training(athlete),
    event = await create(athlete),
    repository = createSessionCompletionRepository(database, {
      now: () => new Date('2026-10-07T00:00:00Z'),
    });
  const completed = await repository.write(athlete, 'session', {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: original,
    expectedRevision: null,
    reason: null,
    idempotencyKey: randomUUID(),
  });
  const updated = await training(athlete, { ...draft(), title: 'New current plan' }, false);
  await owned(athlete, (client) =>
    client.query('UPDATE plan_head SET version_id=$2 WHERE athlete_id=$1', [athlete, updated]),
  );
  if (!database.snapshotTenant) throw new Error('SNAPSHOT_CAPABILITY_MISSING');
  const consumed = await database.snapshotTenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: event.id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(consumed.capture.completions).toEqual([completed.report]);
  expect(consumed.capture.currentTraining?.snapshot.id).toBe(updated);
  expect(consumed.capture.consumedSources.plans.map((plan) => plan.id).sort()).toEqual(
    [original, updated].sort(),
  );
  expect(consumed.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
  expect(consumed.capture.routineActualManifest.actualRosters.activities).toEqual([]);
  expect(consumed.capture.coverage.missing).toHaveLength(5);
  const retracted = await repository.write(athlete, 'session', {
    action: 'retract',
    confirmed: true,
    expectedPlanVersionId: updated,
    expectedRevision: 1,
    reason: 'Synthetic correction',
    idempotencyKey: randomUUID(),
  });
  const after = await capture(athlete, event.id);
  expect(after.completions).toEqual([retracted.report]);
  expect(after.coreDependencies.sessionCompletions).toEqual({ kind: 'exists', revision: 2 });
  expect(after.readSetDigest).not.toBe(consumed.capture.readSetDigest);
});

it('reads public imported course geometry and original revision after an owned head change', async () => {
  const athlete = await account(),
    repository = createCourseRepository(database);
  const raw: PreparedCourseContent = {
    name: 'Synthetic imported course',
    coordinates: [
      [127, 37],
      [127.01, 37.01],
    ],
    waypoints: [
      { role: 'start', position: [127, 37], name: null, sourceSampleId: null, locked: false },
      {
        role: 'finish',
        position: [127.01, 37.01],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ],
    generation: {
      kind: 'imported-file',
      format: 'gpx',
      sourceKind: 'gpx-rte',
      itemIndex: 0,
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      fileSha256: 'a'.repeat(64),
      fileByteLength: 320,
      originalFilename: null,
      fileCreator: null,
      vertexCount: 2,
      importedWaypointCount: 0,
      ignoredFileWaypointCount: 0,
    },
    edit: { kind: 'imported' },
    lineage: [],
    distanceMeters: 0,
    contentDigest: 'a'.repeat(64),
  };
  const content = { ...raw, contentDigest: courseContentDigest(raw) };
  const created = await repository.create(athlete, content, randomUUID());
  if (created.status !== 'available') throw new Error('COURSE_NOT_AVAILABLE');
  const event = await create(athlete, {
    course: {
      courseId: created.course.courseId,
      courseRevision: 1,
      revisionId: created.revision.revisionId,
    },
  });
  const read = () =>
    database.tenant(athlete, (tx) =>
      captureRacePlanImpactConsumedScope(tx, {
        eventId: event.id,
        expectedRevision: 1,
        selection: { kind: 'keep_plan' },
      }),
    );
  const initial = await read();
  expect(initial.capture.course?.owned?.revision).toEqual(created.revision);
  expect(initial.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
  const renamedRaw: PreparedCourseContent = {
    ...content,
    name: 'Synthetic renamed course',
    edit: { kind: 'renamed' },
  };
  const renamed = await repository.update(
    athlete,
    created.course.courseId,
    1,
    { ...renamedRaw, contentDigest: courseContentDigest(renamedRaw) },
    randomUUID(),
  );
  if (renamed.status !== 'available') throw new Error('COURSE_NOT_AVAILABLE');
  const historical = await read();
  expect(historical.capture.course?.owned?.head).toEqual(renamed.course);
  expect(historical.capture.course?.owned?.revision).toEqual(created.revision);
  expect(historical.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
  expect(historical.capture.coverage.missing).toHaveLength(5);
  expect(historical.capture.readSetDigest).not.toBe(initial.capture.readSetDigest);
  const other = await account();
  await expect(
    database.tenant(other, (tx) =>
      captureCourseReadSources(
        tx,
        {
          courseId: created.course.courseId,
          courseRevision: 1,
          revisionId: created.revision.revisionId,
        },
        { bytes: 0n, sources: 0 },
      ),
    ),
  ).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await repository.remove(athlete, created.course.courseId, renamed.course.headRevision);
  await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

it('rejects unknown DTO keys and refuses1001 heads rather than claiming first1000 complete', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await seedNutrition(athlete, [{ ...nutrition(null), secret: 'unexpected' }]);
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  const overflow = await account(),
    other = await create(overflow);
  await seedNutrition(
    overflow,
    Array.from({ length: 1001 }, () => nutrition(null)),
  );
  await expect(capture(overflow, other.id)).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
});

it('captures nonempty recovery/routine rosters and classifies a current source session rule without touching occurrences/runs', async () => {
  const athlete = await account(),
    source = await training(athlete),
    event = await create(athlete);
  const current = await capture(athlete, event.id),
    aggregate = current.currentTraining?.aggregateId;
  if (!aggregate) throw Error('Missing current fixture');
  const option = randomUUID();
  const recovery = recoveryStrategyVersionSchema.parse({
    schemaVersion: 1,
    strategyId: randomUUID(),
    versionId: randomUUID(),
    version: 1,
    previousVersionId: null,
    status: 'user_confirmed',
    selectedOptionId: option,
    createdAt: '2026-10-01T00:00:00Z',
    draft: {
      title: 'Synthetic recovery',
      goal: 'Review existing plan',
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      knownFacts: [],
      missingInformation: [],
      priority: 'normal',
      observations: [],
      planRefs: [{ kind: 'training', aggregateId: aggregate, headVersionId: source }],
      options: [
        {
          id: option,
          title: 'Keep reviewed plan',
          kind: 'maintain_existing_plan',
          methodVersionId: null,
          explanation: 'User reviewed',
        },
      ],
      reassessment: [
        {
          id: randomUUID(),
          trigger: 'plan_changed',
          plannedAt: null,
          description: 'Review plan change',
          policyVersion: null,
        },
      ],
    },
  });
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic checklist',
    intent: 'Review',
    status: 'published',
    tags: [],
    steps: [],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-10-01T00:00:00Z',
  });
  const schedule = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-10-01',
      endDateExclusive: '2026-11-01',
      timezone: 'Asia/Seoul',
      maxOccurrences: 10,
    },
    rule: { kind: 'session_links', sessionIds: ['session'], point: 'end', offsetMinutes: 0 },
    state: 'active',
  });
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO recovery_strategy_version(athlete_id,strategy_id,version_id,version,record_json) VALUES($1,$2,$3,1,$4::jsonb)',
      [athlete, recovery.strategyId, recovery.versionId, JSON.stringify(recovery)],
    );
    await client.query(
      'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, recovery.strategyId, recovery.versionId],
    );
    await client.query(
      'INSERT INTO routine_blueprint_version(athlete_id,routine_id,version_id,version,record_json,created_at) VALUES($1,$2,$3,1,$4::jsonb,$5)',
      [
        athlete,
        blueprint.routineId,
        blueprint.versionId,
        JSON.stringify(blueprint),
        blueprint.createdAt,
      ],
    );
    await client.query(
      'INSERT INTO routine_schedule_version(athlete_id,schedule_id,version_id,blueprint_routine_id,blueprint_version_id,source_plan_version_id,record_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [
        athlete,
        schedule.id,
        schedule.versionId,
        blueprint.routineId,
        blueprint.versionId,
        source,
        JSON.stringify(schedule),
      ],
    );
    await client.query(
      'INSERT INTO routine_schedule_head(athlete_id,schedule_id,version_id) VALUES($1,$2,$3)',
      [athlete, schedule.id, schedule.versionId],
    );
  });
  const before = await capture(athlete, event.id),
    after = await capture(athlete, event.id, 1, {
      kind: 'move_period',
      expectedCurrentPlanVersionId: source,
      changedSessionIds: ['session'],
      movedPeriodIds: ['block'],
    });
  expect(after.rosters.recovery).toEqual([
    { aggregateId: recovery.strategyId, versionId: recovery.versionId },
  ]);
  expect(after.rosters.routine).toEqual([
    { aggregateId: schedule.id, versionId: schedule.versionId },
  ]);
  expect(before.affected.routine).toEqual([]);
  expect(after.routines[0]).toMatchObject({
    sourceRelation: 'current',
    sourceVersionId: source,
    affected: true,
  });
  expect(after.coverage.missing).toContain('routine_occurrences_and_started_runs');
  const counts = await owned(athlete, (client) =>
    client.query(
      'SELECT (SELECT count(*)::int FROM routine_occurrence WHERE athlete_id=$1) AS occurrences,(SELECT count(*)::int FROM routine_run WHERE athlete_id=$1) AS runs',
      [athlete],
    ),
  );
  expect(counts.rows[0]).toEqual({ occurrences: 0, runs: 0 });
});

async function measuredCapture(athlete: string, eventId: string) {
  let transportedBytes = 0;
  const queries: { sql: string; parameters: unknown[] | undefined }[] = [];
  const result = database.tenant(athlete, (tx) =>
    captureRacePlanImpactContext(
      {
        athleteId: tx.athleteId,
        query: async (sql, parameters) => {
          queries.push({ sql, parameters });
          const response = await tx.query(sql, parameters);
          transportedBytes += Buffer.byteLength(JSON.stringify(response.rows));
          return response;
        },
      },
      { eventId, expectedRevision: 1, selection: { kind: 'keep_plan' } },
    ),
  );
  return { result, queries, bytes: () => transportedBytes };
}
function repeatedNutrition(
  source: string | null,
  raceId: string,
  count: number,
  instructions = 'Review timing',
) {
  const record = nutrition(
    source,
    Array.from({ length: count }, () => ({ entity: 'race' as const, entityId: raceId })),
  );
  record.items.forEach((item) => {
    item.instructions = instructions;
  });
  return nutritionPlanVersionSchema.parse(record);
}
it('rejects more than4MiB via scalar SQL preflight before any DTO body reaches the driver', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await seedNutrition(
    athlete,
    Array.from({ length: 12 }, () => repeatedNutrition(null, event.id, 200, 'x'.repeat(2000))),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(
    measured.queries.some(({ sql }) =>
      sql.startsWith('SELECT id,revision,values_json FROM race_event'),
    ),
  ).toBe(false);
});
it('rejects5001 classified relative anchors across valid bounded heads without DTO decode or truncation', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await seedNutrition(
    athlete,
    Array.from({ length: 21 }, (_, index) =>
      repeatedNutrition(null, event.id, index === 20 ? 1 : 250),
    ),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'relative_anchors',
  });
  expect(measured.bytes()).toBeLessThan(4096);
});
it('loads each exact historical Plan and owned race source only once across repeated anchors', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false);
  await training(athlete);
  const event = await create(athlete, { planVersionId: historical }),
    other = await create(athlete);
  await seedNutrition(
    athlete,
    Array.from({ length: 20 }, () =>
      nutrition(
        historical,
        Array.from({ length: 100 }, (_, index) =>
          index % 2 === 0
            ? { entity: 'session' as const, entityId: 'session' }
            : { entity: 'race' as const, entityId: other.id },
        ),
      ),
    ),
  );
  const measured = await measuredCapture(athlete, event.id),
    context = await measured.result;
  expect(context.nutrition).toHaveLength(20);
  const planReads = measured.queries.filter(({ sql }) =>
    sql.includes('AS created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2'),
  );
  expect(planReads).toHaveLength(1);
  expect(planReads[0]?.parameters?.[1]).toBe(historical);
  const raceReads = measured.queries.filter(({ sql }) =>
    sql.startsWith('SELECT revision,values_json FROM race_event'),
  );
  expect(raceReads).toHaveLength(1);
  expect(raceReads[0]?.parameters?.[1]).toBe(other.id);
  expect(
    measured.queries.filter(
      ({ sql, parameters }) =>
        sql.startsWith('SELECT values_json FROM race_event_revision') &&
        parameters?.[1] === other.id,
    ),
  ).toHaveLength(1);
  expect(context.coverage.complete).toBe(false);
});
it('bounds5001 unique source identities before decoding adversarial stored source-reference bodies', async () => {
  const athlete = await account(),
    event = await create(athlete),
    records = Array.from({ length: 250 }, () => {
      const option = randomUUID();
      return recoveryStrategyVersionSchema.parse({
        schemaVersion: 1,
        strategyId: randomUUID(),
        versionId: randomUUID(),
        version: 1,
        previousVersionId: null,
        status: 'user_confirmed',
        selectedOptionId: option,
        createdAt: '2026-10-01T00:00:00Z',
        draft: {
          title: 'Synthetic bound probe',
          goal: 'Check reference budget',
          startDate: '2026-10-01',
          endDateExclusive: '2026-11-01',
          timezone: 'Asia/Seoul',
          knownFacts: [],
          missingInformation: [],
          priority: 'normal',
          observations: [],
          planRefs: Array.from({ length: 20 }, () => ({
            kind: 'training',
            aggregateId: randomUUID(),
            headVersionId: randomUUID(),
          })),
          options: [
            {
              id: option,
              title: 'Keep',
              kind: 'maintain_existing_plan',
              methodVersionId: null,
              explanation: 'Budget fixture',
            },
          ],
          reassessment: [
            {
              id: randomUUID(),
              trigger: 'plan_changed',
              plannedAt: null,
              description: 'Review',
              policyVersion: null,
            },
          ],
        },
      });
    });
  // References intentionally have no owned target: the bounded scalar preflight must run
  // before either body decoding or per-reference ownership queries.
  await owned(athlete, async (client) => {
    await client.query(
      `INSERT INTO recovery_strategy_version(athlete_id,strategy_id,version_id,version,record_json) SELECT $1,(r->>'strategyId')::uuid,(r->>'versionId')::uuid,1,r FROM jsonb_array_elements($2::jsonb) r`,
      [athlete, JSON.stringify(records)],
    );
    await client.query(
      'INSERT INTO recovery_strategy_head(athlete_id,strategy_id,version,version_id) SELECT athlete_id,strategy_id,version,version_id FROM recovery_strategy_version WHERE athlete_id=$1',
      [athlete],
    );
  });
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'unique_sources',
  });
  expect(measured.bytes()).toBeLessThan(4096);
});

it('strictly rejects missing, unexpected and duplicate dependency kinds before accepting an inventory', () => {
  const valid = integratedDependencyKinds.map((kind) => ({ kind, state: 'present', revision: 0 }));
  expect(decodeIntegratedDependencyInventory(valid)).toEqual(valid);
  for (const bad of [
    valid.slice(1),
    [...valid.slice(1), valid[1]],
    [...valid.slice(1), { kind: 'not_a_dependency', state: 'absent' }],
    valid.map((item, index) => (index === 0 ? { ...item, revision: 2147483648 } : item)),
    valid.map((item, index) => (index === 0 ? { ...item, unexpected: true } : item)),
  ])
    expect(() => decodeIntegratedDependencyInventory(bad)).toThrow('INVALID_CONTEXT');
});

it('distinguishes absent inventory from present zero and sees same-count actual corrections and tombstones', async () => {
  const athlete = await account(),
    event = await create(athlete);
  const absent = await capture(athlete, event.id);
  expect(absent.dependencyInventory).toEqual(
    integratedDependencyKinds.map((kind) => ({ kind, state: 'absent' })),
  );
  await owned(athlete, (client) =>
    client.query('INSERT INTO integrated_dependency_head(athlete_id) VALUES($1)', [athlete]),
  );
  const zero = await capture(athlete, event.id);
  expect(zero.dependencyInventory).toEqual(
    integratedDependencyKinds.map((kind) => ({ kind, state: 'present', revision: 0 })),
  );
  expect(zero.readSetDigest).not.toBe(absent.readSetDigest);
  const activityId = randomUUID();
  await owned(athlete, (client) =>
    client.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [athlete, activityId, JSON.stringify({ title: 'Synthetic actual', distanceMeters: 0 })],
    ),
  );
  const first = await capture(athlete, event.id);
  await owned(athlete, (client) =>
    client.query(
      'UPDATE activity_canonical SET revision=revision+1,original=$3::jsonb WHERE athlete_id=$1 AND id=$2',
      [athlete, activityId, JSON.stringify({ title: 'Corrected actual', distanceMeters: null })],
    ),
  );
  const corrected = await capture(athlete, event.id);
  expect(corrected.coreDependencies.activities.count).toBe(first.coreDependencies.activities.count);
  expect(corrected.dependencyInventory.find((item) => item.kind === 'activity_revision')).toEqual({
    kind: 'activity_revision',
    state: 'present',
    revision: 2,
  });
  expect(corrected.readSetDigest).not.toBe(first.readSetDigest);
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [athlete, randomUUID(), 'a'.repeat(64), activityId],
    ),
  );
  await owned(athlete, (client) =>
    client.query(
      'UPDATE activity_canonical SET deleted=true,revision=revision+1 WHERE athlete_id=$1 AND id=$2',
      [athlete, activityId],
    ),
  );
  expect(
    (await capture(athlete, event.id)).dependencyInventory.find(
      (item) => item.kind === 'activity_revision',
    ),
  ).toMatchObject({ revision: 3 });
  const other = await account(),
    otherEvent = await create(other);
  expect(
    (await capture(other, otherEvent.id)).dependencyInventory.every(
      (item) => item.state === 'absent',
    ),
  ).toBe(true);
  expect(corrected.coverage.complete).toBe(false);
  expect(corrected.coverage.missing).toContain('complete_catalog_and_actual_manifest');
});

function syntheticExercise(exerciseId: string = randomUUID(), versionId: string = randomUUID()) {
  return supplementaryExerciseVersionSchema.parse({
    schemaVersion: 2,
    exerciseId,
    versionId,
    name: 'Synthetic balance',
    family: 'balance_stability',
    equipment: ['bodyweight'],
    tags: [],
    countDefinitions: [],
    mediaAssetIds: [],
    resourceVersionIds: [],
    reviewState: 'unreviewed',
    description: 'Frozen synthetic catalog',
    safetyNotes: '',
    supportedMetrics: ['duration'],
    createdAt: '2026-10-01T00:00:00Z',
  });
}
function syntheticSpec(exerciseVersionId: string, routineVersionId: string | null = null) {
  return supplementarySpecSchema.parse({
    schemaVersion: 2,
    kind: 'supplementary',
    routineVersionId,
    blocks: [
      {
        id: 'block-one',
        mode: 'single',
        rounds: 1,
        sets: [
          {
            id: 'target-one',
            exerciseVersionId,
            side: 'bilateral',
            count: null,
            durationSeconds: {
              min: 10,
              max: 10,
              unit: 's',
              basis: 'user_confirmed',
              evidenceIds: [],
            },
            externalResistance: { kind: 'no_added_load' },
            restAfterSeconds: 0,
            tempo: null,
            effort: null,
          },
        ],
        restBetweenRoundsSeconds: null,
      },
    ],
  });
}
async function seedExercise(
  athlete: string,
  definition = syntheticExercise(),
  previous: ReturnType<typeof syntheticExercise> | null = null,
) {
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO supplementary_exercise_version(athlete_id,exercise_id,version_id,version,previous_version_id,previous_version,created_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [
        athlete,
        definition.exerciseId,
        definition.versionId,
        previous ? 2 : 1,
        previous?.versionId ?? null,
        previous ? 1 : null,
        definition.createdAt,
        JSON.stringify(definition),
      ],
    );
    if (previous)
      await client.query(
        'UPDATE supplementary_exercise_head SET version=2,version_id=$3 WHERE athlete_id=$1 AND exercise_id=$2',
        [athlete, definition.exerciseId, definition.versionId],
      );
    else
      await client.query(
        'INSERT INTO supplementary_exercise_head(athlete_id,exercise_id,version,version_id) VALUES($1,$2,1,$3)',
        [athlete, definition.exerciseId, definition.versionId],
      );
  });
  return definition;
}
function strengthDraft(count = 1) {
  const body = draft(),
    original = body.sessions[0];
  if (!original) throw new Error('Missing synthetic session');
  return planDraftSchema.parse({
    ...body,
    sessions: Array.from({ length: count }, (_, index) => ({
      ...original,
      id: `strength-${index}`,
      sport: 'strength',
    })),
  });
}
async function seedLink(
  athlete: string,
  planVersionId: string,
  plannedSessionId: string,
  content: unknown,
) {
  const link = supplementarySessionLinkSchema.parse({
    schemaVersion: 2,
    planVersionId,
    plannedSessionId,
    content,
  });
  await owned(athlete, (client) =>
    insertSupplementarySessionLink(
      { athleteId: athlete, query: (sql, parameters) => client.query(sql, parameters) },
      link,
    ),
  );
}
it('captures empty strength links, exact embedded copies and immutable historical references after catalog head changes', async () => {
  const athlete = await account(),
    firstExercise = await seedExercise(athlete);
  const oldPlan = await training(athlete, strengthDraft(), false);
  const current = await training(athlete, strengthDraft());
  const event = await create(athlete, { planVersionId: oldPlan });
  const absent = await capture(athlete, event.id);
  expect(absent.supplementaryManifest.sessions).toHaveLength(2);
  expect(absent.supplementaryManifest.sessions.every((row) => row.state === 'absent')).toBe(true);
  await seedLink(athlete, oldPlan, 'strength-0', {
    kind: 'embedded',
    spec: syntheticSpec(firstExercise.versionId),
  });
  const pinned = await capture(athlete, event.id);
  expect(pinned.supplementaryManifest.copies[0]?.link.planVersionId).toBe(oldPlan);
  expect(pinned.supplementaryManifest.exercises).toMatchObject([
    { exerciseId: firstExercise.exerciseId, versionId: firstExercise.versionId, version: 1 },
  ]);
  expect(pinned.readSetDigest).not.toBe(absent.readSetDigest);
  await seedExercise(athlete, syntheticExercise(firstExercise.exerciseId), firstExercise);
  const advanced = await capture(athlete, event.id);
  expect(advanced.supplementaryManifest).toEqual(pinned.supplementaryManifest);
  expect(advanced.readSetDigest).not.toBe(pinned.readSetDigest);
  expect(advanced.currentTraining?.snapshot.id).toBe(current);
  await expect(
    owned(athlete, (client) =>
      client.query(
        'UPDATE supplementary_exercise_version SET record_json=record_json WHERE athlete_id=$1 AND version_id=$2',
        [athlete, firstExercise.versionId],
      ),
    ),
  ).rejects.toThrow('IMMUTABLE_SUPPLEMENTARY_RECORD');
  expect(advanced.coverage.missing).toHaveLength(5);
});

it('captures exact routine frozen target copies and rejects an unexpected actual SQL target reference', async () => {
  const athlete = await account(),
    exercise = await seedExercise(athlete);
  const routineId = randomUUID(),
    versionId = randomUUID();
  const template = routineTemplateVersionSchema.parse({
    schemaVersion: 2,
    routineId,
    versionId,
    title: 'Synthetic frozen routine',
    purpose: 'Synthetic source',
    requiredEquipment: ['bodyweight'],
    spec: syntheticSpec(exercise.versionId, versionId),
    createdAt: '2026-10-01T00:00:00Z',
  });
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO supplementary_routine_version(athlete_id,routine_id,version_id,version,created_at,record_json) VALUES($1,$2,$3,1,$4,$5::jsonb)',
      [athlete, routineId, versionId, template.createdAt, JSON.stringify(template)],
    );
    await client.query(
      'INSERT INTO supplementary_routine_head(athlete_id,routine_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, routineId, versionId],
    );
  });
  const plan = await training(athlete, strengthDraft()),
    event = await create(athlete);
  await seedLink(athlete, plan, 'strength-0', {
    kind: 'routine_version',
    routineVersionId: versionId,
  });
  const captured = await capture(athlete, event.id);
  expect(captured.supplementaryManifest.routines).toMatchObject([
    { routineId, versionId, version: 1 },
  ]);
  expect(captured.supplementaryManifest.copies[0]?.targets).toEqual([
    { block_id: 'block-one', target_set_id: 'target-one', exercise_version_id: exercise.versionId },
  ]);
  await owned(athlete, (client) =>
    client.query(
      'INSERT INTO supplementary_session_target_ref(athlete_id,plan_version_id,planned_session_id,block_id,target_set_id,exercise_version_id) VALUES($1,$2,$3,$4,$5,$6)',
      [athlete, plan, 'strength-0', 'block-one', 'unexpected-target', exercise.versionId],
    ),
  );
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

it('does not expose another tenant catalog body or accept its immutable version reference', async () => {
  const foreign = await account(),
    foreignExercise = await seedExercise(foreign);
  const athlete = await account(),
    plan = await training(athlete, strengthDraft()),
    event = await create(athlete);
  await expect(
    seedLink(athlete, plan, 'strength-0', {
      kind: 'embedded',
      spec: syntheticSpec(foreignExercise.versionId),
    }),
  ).rejects.toThrow('TARGET_LINK_INVALID');
  expect((await capture(athlete, event.id)).supplementaryManifest.exercises).toEqual([]);
  const rows = await database.tenant(athlete, (tx) =>
    tx.query('SELECT record_json FROM supplementary_exercise_version WHERE version_id=$1', [
      foreignExercise.versionId,
    ]),
  );
  expect(rows.rows).toEqual([]);
});

it('rejects5001 supplementary target rows by scalar preflight before transporting any copy body', async () => {
  const athlete = await account(),
    exercise = await seedExercise(athlete),
    plan = await training(athlete, strengthDraft()),
    event = await create(athlete);
  await seedLink(athlete, plan, 'strength-0', {
    kind: 'embedded',
    spec: syntheticSpec(exercise.versionId),
  });
  // Plain owner adds adversarial extra rows without disabling the real FK/immutable triggers.
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO supplementary_session_target_ref(athlete_id,plan_version_id,planned_session_id,block_id,target_set_id,exercise_version_id) SELECT $1,$2,'strength-0','block-one','extra-'||i,$3 FROM generate_series(1,5000) i",
      [athlete, plan, exercise.versionId],
    ),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'unique_sources',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(
    measured.queries.some((item) =>
      item.sql.startsWith('SELECT plan_version_id,planned_session_id,content_kind'),
    ),
  ).toBe(false);
});

it('includes embedded frozen bodies in the shared4MiB budget before DTO decode', async () => {
  const athlete = await account(),
    exercise = await seedExercise(athlete),
    plan = await training(athlete, strengthDraft(100)),
    event = await create(athlete);
  const base = syntheticSpec(exercise.versionId),
    block = base.blocks[0];
  if (!block?.sets[0]) throw new Error('Missing synthetic target');
  const set = block.sets[0];
  const large = supplementarySpecSchema.parse({
    ...base,
    blocks: [
      {
        ...block,
        sets: [
          {
            ...set,
            durationSeconds: {
              min: 10,
              max: 10,
              unit: 's',
              basis: 'user_confirmed',
              evidenceIds: Array.from(
                { length: 400 },
                (_, index) => `synthetic-${index}-${'x'.repeat(128)}`,
              ),
            },
          },
        ],
      },
    ],
  });
  await owned(athlete, async (client) => {
    await client.query(
      "INSERT INTO supplementary_session_link(athlete_id,plan_version_id,planned_session_id,content_kind,routine_version_id,embedded_spec_json) SELECT $1,$2,'strength-'||i,'embedded',NULL,$3::jsonb FROM generate_series(0,99) i",
      [athlete, plan, JSON.stringify(large)],
    );
  });
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(
    measured.queries.some((item) =>
      item.sql.startsWith('SELECT plan_version_id,planned_session_id,content_kind'),
    ),
  ).toBe(false);
}, 30000);

it('fails closed on int4 dependency overflow and rolls back the actual mutation', async () => {
  const athlete = await account(),
    event = await create(athlete),
    activityId = randomUUID();
  await owned(athlete, async (client) => {
    await client.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}'::jsonb)",
      [athlete, activityId],
    );
    await client.query(
      'UPDATE integrated_dependency_head SET activity_revision=2147483647 WHERE athlete_id=$1',
      [athlete],
    );
  });
  const before = await capture(athlete, event.id);
  await expect(
    owned(athlete, (client) =>
      client.query('UPDATE activity_canonical SET revision=2 WHERE athlete_id=$1 AND id=$2', [
        athlete,
        activityId,
      ]),
    ),
  ).rejects.toMatchObject({ code: '22003' });
  expect((await capture(athlete, event.id)).readSetDigest).toBe(before.readSetDigest);
});

it('reads all12 real head columns distinctly without treating zero or unrelated tenant heads as absent', async () => {
  const athlete = await account(),
    event = await create(athlete);
  await owned(athlete, async (client) => {
    await client.query('INSERT INTO integrated_dependency_head(athlete_id) VALUES($1)', [athlete]);
    // Synthetic inventory fixture, not a claim that this test invokes all12 domain producers.
    await client.query(
      `UPDATE integrated_dependency_head SET ${integratedDependencyKinds.map((kind, index) => `${kind}=${index}`).join(',')} WHERE athlete_id=$1`,
      [athlete],
    );
  });
  expect((await capture(athlete, event.id)).dependencyInventory).toEqual(
    integratedDependencyKinds.map((kind, index) => ({ kind, state: 'present', revision: index })),
  );
});

function bBlueprint(content: unknown = { kind: 'checklist', prompt: 'Synthetic report' }) {
  return routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic B frozen',
    intent: 'Read context',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Synthetic step',
        content,
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
}
async function bSeedBlueprint(athlete: string, blueprint = bBlueprint(), head = true) {
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO routine_blueprint_version(athlete_id,routine_id,version_id,version,record_json,created_at) VALUES($1,$2,$3,1,$4::jsonb,$5)',
      [
        athlete,
        blueprint.routineId,
        blueprint.versionId,
        JSON.stringify(blueprint),
        blueprint.createdAt,
      ],
    );
    if (head)
      await client.query(
        "INSERT INTO routine_blueprint_head(athlete_id,routine_id,version_id,version,visibility) VALUES($1,$2,$3,1,'active')",
        [athlete, blueprint.routineId, blueprint.versionId],
      );
  });
  return blueprint;
}
async function bSeedSchedule(
  athlete: string,
  blueprint: ReturnType<typeof bBlueprint>,
  source: string | null = null,
) {
  const record = routineScheduleVersionSchema.parse({
    schemaVersion: 4,
    id: randomUUID(),
    versionId: randomUUID(),
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    window: {
      startDate: '2026-01-01',
      endDateExclusive: '2026-02-01',
      timezone: 'UTC',
      maxOccurrences: 1000,
    },
    rule: { kind: 'dates', dates: ['2026-01-01'], localTime: null },
    state: 'active',
  });
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO routine_schedule_version(athlete_id,schedule_id,version_id,blueprint_routine_id,blueprint_version_id,source_plan_version_id,record_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [
        athlete,
        record.id,
        record.versionId,
        blueprint.routineId,
        blueprint.versionId,
        source,
        JSON.stringify(record),
      ],
    );
    await client.query(
      'INSERT INTO routine_schedule_head(athlete_id,schedule_id,version_id) VALUES($1,$2,$3)',
      [athlete, record.id, record.versionId],
    );
  });
  return record;
}
async function bSeedOccurrence(
  athlete: string,
  schedule: ReturnType<typeof routineScheduleVersionSchema.parse>,
  scheduledAt: string | null = null,
  index = 0,
) {
  const record = routineOccurrenceSchema.parse({
    id: randomUUID(),
    schedule: { id: schedule.id, versionId: schedule.versionId },
    blueprint: schedule.blueprint,
    anchorKey: `anchor-${index}`,
    scheduledAt,
    timingStatus: scheduledAt === null ? 'unresolved' : 'resolved',
    stepBindings: [],
    selectedChoices: {},
  });
  await owned(athlete, (client) =>
    client.query(
      'INSERT INTO routine_occurrence(athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,blueprint_version_id,anchor_key,scheduled_at,record_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [
        athlete,
        record.id,
        schedule.id,
        schedule.versionId,
        schedule.blueprint.id,
        schedule.blueprint.versionId,
        record.anchorKey,
        scheduledAt,
        JSON.stringify(record),
      ],
    ),
  );
  return record;
}
async function bSeedRun(
  athlete: string,
  blueprint: ReturnType<typeof bBlueprint>,
  progress: unknown[] = [],
  state: 'in_progress' | 'stopped' = 'stopped',
  history = true,
) {
  const record = routineRunSchema.parse({
    id: randomUUID(),
    revision: 0,
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    origin: { kind: 'unplanned' },
    state,
    progress,
    selectedChoices: {},
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: state === 'stopped' ? '2026-01-01T00:01:00Z' : null,
  });
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO routine_run(athlete_id,id,blueprint_routine_id,blueprint_version_id,occurrence_id,revision,state,record_json) VALUES($1,$2,$3,$4,NULL,0,$5,$6::jsonb)',
      [athlete, record.id, blueprint.routineId, blueprint.versionId, state, JSON.stringify(record)],
    );
    if (history)
      await client.query(
        'INSERT INTO routine_run_revision(athlete_id,run_id,revision,record_json) VALUES($1,$2,0,$3::jsonb)',
        [athlete, record.id, JSON.stringify(record)],
      );
  });
  return record;
}
function bProgress(ref: unknown) {
  return {
    stepId: 'step',
    revision: 1,
    state: 'partial',
    actualRefs: [ref],
    occurredAt: '2026-01-01T00:00:00Z',
    recordedAt: '2026-01-01T00:00:01Z',
    reason: null,
  };
}

it('B captures unresolved/outside-period historical occurrences and consumes their frozen historical source Plans', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete, undefined, false),
    historical = await training(athlete, strengthDraft(), false);
  const before = await capture(athlete, event.id);
  const schedule = await bSeedSchedule(athlete, blueprint, historical),
    unresolved = await bSeedOccurrence(athlete, schedule),
    resolved = await bSeedOccurrence(athlete, schedule, '2026-01-01T00:00:00Z', 1);
  const captured = await capture(athlete, event.id);
  expect(captured.routineActualManifest.occurrences.map((row) => row.record.id).sort()).toEqual(
    [unresolved.id, resolved.id].sort(),
  );
  expect(
    captured.routineActualManifest.occurrences.every((row) => row.startedRun.state === 'absent'),
  ).toBe(true);
  expect(captured.routineActualManifest.blueprints[0]?.currentHead).toEqual({ state: 'absent' });
  expect(captured.supplementaryManifest.sessions).toEqual([
    { planVersionId: historical, plannedSessionId: 'strength-0', state: 'absent' },
  ]);
  expect(captured.readSetDigest).not.toBe(before.readSetDigest);
  // Advance current schedule while keeping the immutable historical occurrence/source.
  const versionId = randomUUID(),
    next = routineScheduleVersionSchema.parse({ ...schedule, versionId, state: 'paused' });
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO routine_schedule_version(athlete_id,schedule_id,version_id,prior_version_id,blueprint_routine_id,blueprint_version_id,source_plan_version_id,record_json) VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)',
      [
        athlete,
        schedule.id,
        versionId,
        schedule.versionId,
        blueprint.routineId,
        blueprint.versionId,
        JSON.stringify(next),
      ],
    );
    await client.query(
      'UPDATE routine_schedule_head SET version_id=$3 WHERE athlete_id=$1 AND schedule_id=$2',
      [athlete, schedule.id, versionId],
    );
  });
  const advanced = await capture(athlete, event.id);
  expect(advanced.routineActualManifest.schedules[0]?.versionId).toBe(schedule.versionId);
  expect(advanced.routineActualManifest.occurrences[0]?.currentSchedule).toEqual({
    state: 'present',
    versionId,
  });
  expect(advanced.supplementaryManifest).toEqual(captured.supplementaryManifest);
  expect(advanced.readSetDigest).not.toBe(captured.readSetDigest);
});

it('B sees actual runtime start revision0, checklist partial and stopped immutable progress without another Activity', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete),
    schedule = await bSeedSchedule(athlete, blueprint),
    occurrence = await bSeedOccurrence(athlete, schedule);
  const before = await capture(athlete, event.id),
    repository = createRoutineRepository(database);
  const started = await repository.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: occurrence.id,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const begun = await capture(athlete, event.id);
  expect(begun.routineActualManifest.runs[0]?.record.revision).toBe(0);
  expect(begun.routineActualManifest.occurrences[0]?.startedRun).toMatchObject({
    state: 'present',
    runId: started.run.id,
    revision: 0,
  });
  expect(begun.readSetDigest).not.toBe(before.readSetDigest);
  expect(begun.routineTimerReads).toEqual([{ run: started.run, timers: [] }]);
  const timer = await repository.commandTimer(athlete, {
    runId: started.run.id,
    stepId: 'step',
    action: 'start',
    durationSeconds: 30,
    expectedRevision: null,
    idempotencyKey: randomUUID(),
  });
  const timed = await capture(athlete, event.id);
  expect(timed.routineTimerReads).toEqual([{ run: started.run, timers: [timer] }]);
  expect(timed.readSetDigest).not.toBe(begun.readSetDigest);
  expect(timed.routineActualManifest.runs[0]?.record.progress).toEqual(started.run.progress);
  expect(timed.routineActualManifest.actualRosters.activities).toEqual([]);
  const partial = await repository.recordStep(athlete, {
    runId: started.run.id,
    stepId: 'step',
    state: 'partial',
    actualRefs: [],
    occurredAt: '2026-01-01T00:00:00.000Z',
    reason: null,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  await repository.changeRun(athlete, {
    runId: started.run.id,
    action: 'stop',
    expectedRevision: partial.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const stopped = await capture(athlete, event.id),
    record = stopped.routineActualManifest.runs[0];
  expect(record?.record).toMatchObject({
    state: 'stopped',
    progress: [{ state: 'partial', reason: null }],
  });
  expect(record?.actuals[0]?.fact).toMatchObject({
    state: 'current',
    requested: { kind: 'checklist_confirmation' },
    content: { run_id: started.run.id, step_id: 'step', state: 'partial' },
  });
  expect(stopped.routineActualManifest.actualRosters.activities).toEqual([]);
  expect(stopped.coverage.complete).toBe(false);
  const consumed = await database.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: event.id,
      expectedRevision: event.revision,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(consumed.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
  expect(consumed.capture.coverage.complete).toBe(false);
  expect(consumed.capture.coverage.missing).toHaveLength(5);
});

it('rejects5001 consumed routine timers by scalar preflight before transporting timer rows', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete),
    started = await createRoutineRepository(database).startRun(athlete, {
      runId: randomUUID(),
      blueprintVersionId: blueprint.versionId,
      occurrenceId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
  await owned(athlete, (client) =>
    client.query(
      `INSERT INTO routine_step_timer(athlete_id,run_id,step_id,revision,state,duration_seconds,
       started_at,paused_at,paused_milliseconds)
       SELECT $1,$2,'synthetic-'||i,1,'running',30,'2026-10-07T00:00:00Z',NULL,0
       FROM generate_series(1,5001) i`,
      [athlete, started.run.id],
    ),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'unique_sources',
  });
  expect(
    measured.queries.some((query) =>
      query.sql.includes('paused_milliseconds::text AS paused_milliseconds'),
    ),
  ).toBe(false);
});

it.each([false, true])(
  'validates public frozen workout template and linked manual actual with text resource %s through full readonly capture',
  async (withResource) => {
    const athlete = await account(),
      event = await create(athlete),
      catalog = createSupplementaryRepository(database),
      routines = createRoutineRepository(database),
      activities = createActivityRepository(database);
    const resources = createPrivateTextResourceRepository(database);
    const resource = withResource
      ? await resources.create(athlete, {
          sourceKind: 'text',
          title: 'Synthetic exercise reference',
          category: 'guide',
          metadata: {},
          tags: [],
          favorite: false,
          text: 'Synthetic 원문. Zero and unknown stay distinct.',
          idempotencyKey: randomUUID(),
        })
      : undefined;
    if (resource && resource.status !== 'available')
      throw new Error('RESOURCE_FIXTURE_UNAVAILABLE');
    const exercise = await catalog.saveExercise(athlete, {
      definition: {
        schemaVersion: 2,
        exerciseId: randomUUID(),
        versionId: randomUUID(),
        name: 'Synthetic balance',
        family: 'balance_stability',
        equipment: ['bodyweight'],
        tags: [],
        countDefinitions: [],
        mediaAssetIds: [],
        resourceVersionIds: resource?.status === 'available' ? [resource.version.id] : [],
        reviewState: 'unreviewed',
        description: 'User defined synthetic movement',
        safetyNotes: '',
        supportedMetrics: ['duration'],
        createdAt: '2026-01-01T00:00:00Z',
      },
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const versionId = randomUUID();
    const saved = await catalog.saveRoutine(athlete, {
      template: {
        schemaVersion: 2,
        routineId: randomUUID(),
        versionId,
        title: 'Synthetic workout template',
        purpose: 'User selected practice',
        requiredEquipment: ['bodyweight'],
        spec: {
          schemaVersion: 2,
          kind: 'supplementary',
          routineVersionId: versionId,
          blocks: [
            {
              id: 'block',
              mode: 'single',
              rounds: 1,
              sets: [
                {
                  id: 'set',
                  exerciseVersionId: exercise.definition.versionId,
                  side: 'unspecified',
                  count: null,
                  durationSeconds: {
                    min: 30,
                    max: 30,
                    unit: 's',
                    basis: 'user_confirmed',
                    evidenceIds: [],
                  },
                  externalResistance: { kind: 'no_added_load' },
                  restAfterSeconds: 0,
                  tempo: null,
                  effort: null,
                },
              ],
              restBetweenRoundsSeconds: null,
            },
          ],
        },
        createdAt: '2026-01-01T00:00:00Z',
      },
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const blueprint = bBlueprint({
      kind: 'workout_template',
      ref: { id: saved.template.routineId, versionId: saved.template.versionId },
    });
    await routines.saveBlueprint(athlete, {
      blueprint,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const activity = await activities.createManualActivity(athlete, {
      confirmed: true,
      idempotencyKey: randomUUID(),
      activity: {
        title: 'Synthetic user report',
        kind: 'strength',
        startedAt: '2026-01-01T00:00:00Z',
        durationSeconds: null,
        durationKind: 'unknown',
        timezone: 'UTC',
        distanceMeters: 0,
      },
      report: { sessionRpe: null, note: null, planLink: null },
    });
    const run = await routines.startRun(athlete, {
      runId: randomUUID(),
      blueprintVersionId: blueprint.versionId,
      occurrenceId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    await routines.recordStep(athlete, {
      runId: run.run.id,
      stepId: 'step',
      state: 'partial',
      actualRefs: [
        {
          kind: 'activity',
          id: activity.activityId,
          revisionId: '1',
          detailId: null,
          allocationId: null,
        },
      ],
      occurredAt: '2026-01-01T00:00:00Z',
      reason: null,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    const scope = await database.tenant(athlete, (tx) =>
      captureRacePlanImpactConsumedScope(tx, {
        eventId: event.id,
        expectedRevision: 1,
        selection: { kind: 'keep_plan' },
      }),
    );
    expect(scope.capture.workoutTemplateSources.templates).toEqual([saved.template]);
    expect(scope.capture.workoutTemplateSources.exercises).toEqual([
      { record: exercise.definition, version: 1 },
    ]);
    expect(scope.consumedScope).toMatchObject({
      status: 'validated_read_scope',
      approvalAuthority: 'none',
      freshness: 'not_checked',
    });
    expect(scope.capture.coverage.missing).toHaveLength(5);
    expect(scope.capture.routineActualManifest.actualRosters.activities).toHaveLength(1);
    if (resource?.status === 'available') {
      expect(scope.capture.resourceReadFacts.facts[0]).toMatchObject({
        state: 'current',
        record: resource.version,
      });
      expect(scope.capture.sourcePermissionManifest.resources[0]).toMatchObject({
        current: {
          includeForCoach: false,
          aiAuthorized: false,
          reviewedState: 'unreviewed',
        },
      });
      const next = await resources.appendVersion(athlete, resource.resource.id, {
        expectedCurrentVersionId: resource.version.id,
        text: 'New synthetic head only.',
        idempotencyKey: randomUUID(),
      });
      if (next.status !== 'available') throw new Error('RESOURCE_FIXTURE_UNAVAILABLE');
      const historic = await database.tenant(athlete, (tx) =>
        captureRacePlanImpactConsumedScope(tx, {
          eventId: event.id,
          expectedRevision: 1,
          selection: { kind: 'keep_plan' },
        }),
      );
      expect(historic.capture.resourceReadFacts.facts[0]).toMatchObject({
        state: 'historical',
        record: resource.version,
        current: { versionId: next.version.id },
      });
      expect(historic.consumedScope.status).toBe('validated_read_scope');
      expect(historic.capture.readSetDigest).not.toBe(scope.capture.readSetDigest);
      await resources.softDelete(athlete, resource.resource.id, {
        expectedAccessRevision: next.resource.accessRevision,
        expectedCurrentVersionId: next.version.id,
        idempotencyKey: randomUUID(),
      });
      const deleted = await database.tenant(athlete, (tx) =>
        captureRacePlanImpactConsumedScope(tx, {
          eventId: event.id,
          expectedRevision: 1,
          selection: { kind: 'keep_plan' },
        }),
      );
      expect(deleted.capture.resourceReadFacts.facts[0]).toMatchObject({
        state: 'deleted',
        record: null,
      });
      expect(deleted.consumedScope).toMatchObject({
        status: 'blocked',
        blockers: expect.arrayContaining([
          expect.objectContaining({ reason: 'source_unavailable' }),
        ]),
      });
    }
  },
);

it('reads public manual Activity source hash separately from canonical digest without inventing workout catalog support', async () => {
  const athlete = await account(),
    event = await create(athlete),
    activities = createActivityRepository(database);
  const created = await activities.createManualActivity(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    activity: {
      title: 'Synthetic manual actual',
      kind: 'strength',
      startedAt: '2026-01-01T00:00:00Z',
      durationSeconds: null,
      durationKind: 'unknown',
      timezone: 'UTC',
      distanceMeters: 0,
    },
    report: { sessionRpe: 0, note: null, planLink: null },
  });
  const blueprint = await bSeedBlueprint(
    athlete,
    bBlueprint({ kind: 'workout_template', ref: { id: randomUUID(), versionId: randomUUID() } }),
  );
  const requested = {
    kind: 'activity',
    id: created.activityId,
    revisionId: '1',
    detailId: null,
    allocationId: null,
  };
  // Only the actual source producer is public in this test. The deliberately
  // missing frozen workout catalog must keep the whole consumed scope blocked.
  await bSeedRun(athlete, blueprint, [bProgress(requested)]);
  const context = await capture(athlete, event.id);
  expect(context.manualActivityReadFacts.facts[0]).toMatchObject({
    requested,
    state: 'current',
    reason: null,
    current: { revision: 1, deleted: false },
    sourceEvidence: {
      metadata: {
        source: { kind: 'manual', suppressed: false, revisionRecord: { state: 'present' } },
      },
    },
  });
  expect(context.manualActivityReadFacts.facts[0]?.content?.original).toMatchObject({
    distanceMeters: 0,
    durationSeconds: null,
  });
  const scoped = await database.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: event.id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(scoped.consumedScope.status).toBe('blocked');
  if (scoped.consumedScope.status === 'blocked')
    expect(
      scoped.consumedScope.blockers.some(
        (block) => block.reason === 'actual_permission_port_missing',
      ),
    ).toBe(false);
  await activities.updateOverlay(athlete, created.activityId, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    reason: 'Synthetic correction',
    title: 'Changed manual title',
  });
  const historical = await capture(athlete, event.id);
  expect(historical.manualActivityReadFacts.facts[0]).toMatchObject({
    requested,
    state: 'unavailable',
    reason: 'requested_revision_unavailable',
    content: null,
  });
  await activities.deleteActivity(athlete, created.activityId, { expectedRevision: 2 });
  const deleted = await capture(athlete, event.id);
  expect(deleted.manualActivityReadFacts.facts[0]).toMatchObject({
    requested,
    state: 'deleted',
    content: null,
    current: { revision: 3, deleted: true },
    sourceEvidence: {
      metadata: { overlay: { revision: 2 }, source: { kind: 'manual', suppressed: true } },
    },
  });
});

it('B preserves requested Activity revision after same-count correction/deletion without inventing historical canonical body', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(
      athlete,
      bBlueprint({ kind: 'workout_template', ref: { id: randomUUID(), versionId: randomUUID() } }),
    ),
    activityId = randomUUID();
  const original = {
    title: 'Synthetic actual',
    kind: 'strength',
    startedAt: '2026-01-01T00:00:00Z',
    durationSeconds: null,
    durationKind: 'unknown',
    timezone: 'UTC',
    distanceMeters: 0,
  };
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [athlete, activityId, JSON.stringify(original)],
    );
    await client.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [athlete, randomUUID(), 'a'.repeat(64), activityId],
    );
  });
  const requested = {
    kind: 'activity',
    id: activityId,
    revisionId: '1',
    detailId: null,
    allocationId: null,
  };
  await bSeedRun(athlete, blueprint, [bProgress(requested)]);
  const first = await capture(athlete, event.id);
  expect(first.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    state: 'current',
    content: { original: { distanceMeters: 0, durationSeconds: null } },
  });
  await owned(athlete, (client) =>
    client.query(
      'UPDATE activity_canonical SET revision=2,original=$3::jsonb WHERE athlete_id=$1 AND id=$2',
      [athlete, activityId, JSON.stringify({ ...original, distanceMeters: 10 })],
    ),
  );
  const corrected = await capture(athlete, event.id);
  expect(corrected.routineActualManifest.runs[0]?.actuals[0]?.fact).toEqual({
    requested,
    state: 'unavailable',
    reason: 'requested_revision_unavailable',
    current: { id: activityId, revision: 2, deleted: false },
    content: null,
  });
  expect(corrected.readSetDigest).not.toBe(first.readSetDigest);
  await owned(athlete, (client) =>
    client.query(
      'UPDATE activity_canonical SET revision=3,deleted=true WHERE athlete_id=$1 AND id=$2',
      [athlete, activityId],
    ),
  );
  const deleted = await capture(athlete, event.id);
  expect(deleted.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    requested,
    state: 'deleted',
    content: null,
  });
  expect(deleted.routineActualManifest.runs[0]?.record.state).toBe('stopped');
});

it('B keeps absent/foreign references unavailable and does not expose foreign actual content', async () => {
  const foreign = await account(),
    athlete = await account(),
    event = await create(athlete),
    activityId = randomUUID(),
    blueprint = await bSeedBlueprint(
      athlete,
      bBlueprint({ kind: 'workout_template', ref: { id: randomUUID(), versionId: randomUUID() } }),
    );
  await owned(foreign, (client) =>
    client.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}'::jsonb)",
      [foreign, activityId],
    ),
  );
  const requested = {
    kind: 'activity',
    id: activityId,
    revisionId: '1',
    detailId: null,
    allocationId: null,
  };
  await bSeedRun(athlete, blueprint, [bProgress(requested)]);
  const context = await capture(athlete, event.id);
  expect(context.routineActualManifest.runs[0]?.actuals[0]?.fact).toEqual({
    requested,
    state: 'unavailable',
    reason: 'owned_reference_unavailable',
    current: null,
    content: null,
  });
  expect(context.routineActualManifest.actualRosters.activities).toEqual([]);
});

it('B marks unsupported source variants without adding writer support', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(
      athlete,
      bBlueprint({ kind: 'recovery_method', ref: { id: randomUUID(), versionId: randomUUID() } }),
    );
  await bSeedRun(athlete, blueprint, [
    bProgress({ kind: 'recovery_log', id: randomUUID(), revisionId: randomUUID() }),
  ]);
  const context = await capture(athlete, event.id);
  expect(context.routineActualManifest.blueprints[0]?.unsupportedContent[0]).toMatchObject({
    state: 'unavailable',
    reason: 'producer_content_unsupported',
  });
  expect(context.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    state: 'unavailable',
    reason: 'producer_actual_unsupported',
    content: null,
  });
  expect(context.coverage.missing).toHaveLength(5);
});

it('B fails closed when current run history is absent or a requested current revision is forged', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete);
  await bSeedRun(athlete, blueprint, [], 'stopped', false);
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  const other = await account(),
    otherEvent = await create(other),
    otherBlueprint = await bSeedBlueprint(
      other,
      bBlueprint({ kind: 'workout_template', ref: { id: randomUUID(), versionId: randomUUID() } }),
    ),
    activityId = randomUUID();
  await owned(other, (client) =>
    client.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}'::jsonb)",
      [other, activityId],
    ),
  );
  await bSeedRun(other, otherBlueprint, [
    bProgress({
      kind: 'activity',
      id: activityId,
      revisionId: '2',
      detailId: null,
      allocationId: null,
    }),
  ]);
  await expect(capture(other, otherEvent.id)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});

it('B keeps exact historical check-in values after correction and a content-free deleted reference', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(
      athlete,
      bBlueprint({ kind: 'checkin_template', ref: { id: randomUUID(), versionId: randomUUID() } }),
    ),
    repository = createCheckInRepository(database);
  const values = {
    observedAt: '2026-01-01T00:00:00Z',
    timezone: 'UTC',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: null,
  };
  const created = await repository.createCheckIn(athlete, { idempotencyKey: randomUUID(), values });
  await bSeedRun(athlete, blueprint, [
    bProgress({ kind: 'checkin', id: created.id, revisionId: '1' }),
  ]);
  await repository.updateCheckIn(athlete, created.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    reason: 'Synthetic correction',
    values: { ...values, fatigue: 1 },
  });
  const historical = await capture(athlete, event.id);
  expect(historical.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    state: 'historical',
    requested: { revisionId: '1' },
    current: { revision: 2 },
    content: { fatigue: 0, discomfort: null },
  });
  expect(historical.routineActualManifest.blueprints[0]?.unsupportedContent).toMatchObject([
    { reason: 'producer_content_unsupported' },
  ]);
  await repository.deleteCheckIn(athlete, created.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: 2,
  });
  const deleted = await capture(athlete, event.id);
  expect(deleted.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    state: 'deleted',
    content: null,
    current: { deleted: true, revision: 3 },
  });
});

it('B bounds1001 occurrences before transporting their DTO bodies', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete),
    schedule = await bSeedSchedule(athlete, blueprint);
  const occurrence = routineOccurrenceSchema.parse({
    id: randomUUID(),
    schedule: { id: schedule.id, versionId: schedule.versionId },
    blueprint: schedule.blueprint,
    anchorKey: 'cap',
    scheduledAt: null,
    timingStatus: 'unresolved',
    stepBindings: [],
    selectedChoices: {},
  });
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO routine_occurrence(athlete_id,id,schedule_id,schedule_version_id,blueprint_routine_id,blueprint_version_id,anchor_key,scheduled_at,record_json) SELECT $1,g.id::uuid,$2,$3,$4,$5,'cap-'||i,NULL,jsonb_set(jsonb_set($6::jsonb,'{id}',to_jsonb(g.id)), '{anchorKey}',to_jsonb('cap-'||i)) FROM generate_series(1,1001) i CROSS JOIN LATERAL (SELECT gen_random_uuid()::text AS id WHERE i>0) g",
      [
        athlete,
        schedule.id,
        schedule.versionId,
        blueprint.routineId,
        blueprint.versionId,
        JSON.stringify(occurrence),
      ],
    ),
  ).catch((error) => {
    throw error;
  });
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
  expect(measured.bytes()).toBeLessThan(4096);
});

it('B includes run/history JSON in global4MiB preflight before decoding a large stopped draft', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete);
  const payload = 'x'.repeat(400000);
  await owned(athlete, async (client) => {
    for (let index = 0; index < 6; index++) {
      const record = routineRunSchema.parse({
        id: randomUUID(),
        revision: 0,
        blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
        origin: { kind: 'unplanned' },
        state: 'stopped',
        progress: [
          {
            stepId: 'step',
            revision: 1,
            state: 'stopped',
            actualRefs: [],
            occurredAt: null,
            recordedAt: '2026-01-01T00:00:00Z',
            reason: payload,
          },
        ],
        selectedChoices: {},
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:01:00Z',
      });
      await client.query(
        "INSERT INTO routine_run(athlete_id,id,blueprint_routine_id,blueprint_version_id,revision,state,record_json) VALUES($1,$2,$3,$4,0,'stopped',$5::jsonb)",
        [athlete, record.id, blueprint.routineId, blueprint.versionId, JSON.stringify(record)],
      );
      await client.query(
        'INSERT INTO routine_run_revision(athlete_id,run_id,revision,record_json) VALUES($1,$2,0,$3::jsonb)',
        [athlete, record.id, JSON.stringify(record)],
      );
    }
  });
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(measured.queries.some((item) => item.sql.startsWith('SELECT r.id,r.blueprint'))).toBe(
    false,
  );
});

it('B preserves exact historical Intake UUID revision and reads its real null-body tombstone after deletion', async () => {
  const athlete = await account(),
    event = await create(athlete),
    repository = createNutritionRepository(database);
  const unknown = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
    value: null,
    unit,
    status: 'unknown' as const,
    evidenceIds: [],
  });
  const nutrients = {
    energy: unknown('kcal'),
    carbohydrate: unknown('g'),
    protein: unknown('g'),
    fat: unknown('g'),
    fluid: unknown('mL'),
    sodium: unknown('mg'),
  };
  const food = await repository.saveFood(athlete, {
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    confirmed: true,
    definition: {
      foodId: 'synthetic-b-food',
      name: 'Synthetic food',
      basis: { kind: 'per_100g' },
      nutrients,
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-01-01T00:00:00Z',
        reviewState: 'unreviewed',
      },
    },
  });
  const restoreGeneration = z
    .uuid()
    .parse((await owner.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']);
  const input = {
    intakeId: randomUUID(),
    confirmed: true as const,
    occurredAt: '2026-01-01T00:00:00Z',
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: food.versionId,
        description: 'Synthetic food',
        quantity: 0,
        unit: 'g' as const,
        sourceBasis: 'per_100g' as const,
      },
    ],
    nutrientTotal: {
      ...nutrients,
      energy: { value: 0, unit: 'kcal' as const, status: 'reported' as const, evidenceIds: [] },
    },
    plannedItemId: null,
    relatedSessionIds: [],
    relatedActivityIds: [],
    source: 'user' as const,
    sourceRecordId: null,
    notes: null,
  };
  const created = await repository.createIntake(athlete, {
    ...input,
    idempotencyKey: randomUUID(),
    restoreGeneration,
  });
  const meal = await repository.savePlan(athlete, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2026-10-01', toInclusive: '2026-10-31' },
      timezone: 'UTC',
      purpose: 'Synthetic intake template',
      linkedTrainingPlanVersionId: null,
      items: [],
    },
  });
  const blueprint = bBlueprint({
      kind: 'nutrition_template',
      ref: { id: meal.planId, versionId: meal.versionId },
    }),
    requested = { kind: 'intake' as const, id: created.intakeId, revisionId: created.revisionId },
    routines = createRoutineRepository(database);
  await routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const started = await routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  await expect(
    routines.recordStep(athlete, {
      runId: started.run.id,
      stepId: 'step',
      state: 'partial',
      actualRefs: [requested],
      occurredAt: '2026-01-01T00:00:01Z',
      reason: null,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: 'ACTUAL_TIME_MISMATCH' });
  await routines.recordStep(athlete, {
    runId: started.run.id,
    stepId: 'step',
    state: 'partial',
    actualRefs: [requested],
    occurredAt: input.occurredAt,
    reason: null,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  await repository.correctIntake(athlete, {
    ...input,
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    notes: 'Synthetic correction',
  });
  const historical = await capture(athlete, event.id);
  const scoped = await database.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: event.id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(scoped.consumedScope).toMatchObject({
    status: 'validated_read_scope',
    approvalAuthority: 'none',
    freshness: 'not_checked',
  });
  expect(historical.manualIntakeReadFacts.facts[0]).toMatchObject({
    requested,
    state: 'historical',
    current: { revision: 2 },
    content: { revision: 1, notes: null },
  });

  expect(historical.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    requested,
    state: 'historical',
    current: { revision: 2 },
    content: {
      revision: 1,
      notes: null,
      nutrientTotal: { energy: { value: 0 }, protein: { value: null } },
    },
  });
  await repository.deleteIntake(athlete, {
    idempotencyKey: randomUUID(),
    intakeId: created.intakeId,
    expectedRevision: 2,
    confirmed: true,
    reason: 'user_requested',
  });
  const deleted = await capture(athlete, event.id);
  expect(deleted.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    requested,
    state: 'deleted',
    current: { status: 'deleted', revision: 3 },
    content: null,
  });
  expect(deleted.routineActualManifest.actualRosters.intake).toMatchObject([
    { id: created.intakeId, status: 'deleted', revision: 3 },
  ]);
  expect(deleted.manualIntakeReadFacts.facts[0]).toMatchObject({
    requested,
    state: 'deleted',
    content: null,
  });
  await owned(athlete, (client) =>
    client.query("UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'", [
      athlete,
    ]),
  );
  const retained = await capture(athlete, event.id);
  expect(retained.manualIntakeReadFacts).toEqual(deleted.manualIntakeReadFacts);
  const denied = await database.tenant(athlete, (tx) =>
    captureRacePlanImpactConsumedScope(tx, {
      eventId: event.id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    }),
  );
  expect(denied.consumedScope).toMatchObject({
    status: 'blocked',
    blockers: [{ path: 'manualBasis.app', reason: 'manual_admission_unavailable' }],
  });
});

it('B keeps the frozen run blueprint after a new catalog head and captures the changed head facts', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete),
    run = await bSeedRun(athlete, blueprint);
  const before = await capture(athlete, event.id),
    next = routineBlueprintVersionSchema.parse({
      ...blueprint,
      versionId: randomUUID(),
      title: 'Synthetic changed catalog',
    });
  await createRoutineRepository(database).saveBlueprint(athlete, {
    blueprint: next,
    expectedVersionId: blueprint.versionId,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const after = await capture(athlete, event.id);
  expect(after.routineActualManifest.runs[0]?.record).toEqual(run);
  expect(after.routineActualManifest.blueprints[0]?.record).toEqual(blueprint);
  expect(after.routineActualManifest.blueprints[0]?.currentHead).toMatchObject({
    state: 'present',
    versionId: next.versionId,
    version: 2,
  });
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});

it('B rejects5001 unique actual refs before transporting stopped run JSON', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(
      athlete,
      bBlueprint({ kind: 'recovery_method', ref: { id: randomUUID(), versionId: randomUUID() } }),
    );
  const refs = Array.from({ length: 5001 }, () => ({
    kind: 'recovery_log',
    id: randomUUID(),
    revisionId: randomUUID(),
  }));
  const progress = {
    stepId: 'step',
    revision: 1,
    state: 'stopped',
    actualRefs: refs,
    occurredAt: null,
    recordedAt: '2026-01-01T00:00:00Z',
    reason: null,
  };
  // Valid stored DTO bound by1MiB; exceeds product command's20-ref limit intentionally.
  await bSeedRun(athlete, blueprint, [progress]);
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'unique_sources',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(measured.queries.some((item) => item.sql.startsWith('SELECT r.id,r.blueprint'))).toBe(
    false,
  );
});

it('B captures allocation refs as unavailable without using current body as unsupported allocation evidence', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(
      athlete,
      bBlueprint({ kind: 'workout_template', ref: { id: randomUUID(), versionId: randomUUID() } }),
    ),
    activityId = randomUUID();
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,'{}'::jsonb)",
      [athlete, activityId],
    ),
  );
  await bSeedRun(athlete, blueprint, [
    bProgress({
      kind: 'activity',
      id: activityId,
      revisionId: '1',
      detailId: null,
      allocationId: randomUUID(),
    }),
  ]);
  const context = await capture(athlete, event.id);
  expect(context.routineActualManifest.runs[0]?.actuals[0]?.fact).toMatchObject({
    state: 'unavailable',
    reason: 'producer_allocation_unsupported',
    current: { id: activityId, revision: 1 },
    content: null,
  });
});

it('B bounds1001 runs before querying run current/history bodies', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete);
  const record = routineRunSchema.parse({
    id: randomUUID(),
    revision: 0,
    blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
    origin: { kind: 'unplanned' },
    state: 'stopped',
    progress: [],
    selectedChoices: {},
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:01:00Z',
  });
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO routine_run(athlete_id,id,blueprint_routine_id,blueprint_version_id,revision,state,record_json) SELECT $1,g.id::uuid,$2,$3,0,'stopped',jsonb_set($4::jsonb,'{id}',to_jsonb(g.id)) FROM generate_series(1,1001) i CROSS JOIN LATERAL (SELECT gen_random_uuid()::text AS id WHERE i>0) g",
      [athlete, blueprint.routineId, blueprint.versionId, JSON.stringify(record)],
    ),
  );
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(measured.queries.some((item) => item.sql.startsWith('SELECT r.id,r.blueprint'))).toBe(
    false,
  );
});

it('B rejects a forged checklist confirmation revision on a real owned stopped run', async () => {
  const athlete = await account(),
    event = await create(athlete),
    blueprint = await bSeedBlueprint(athlete),
    runId = randomUUID(),
    actualId = randomUUID(),
    storedRevisionId = randomUUID();
  await owned(athlete, async (client) => {
    const record = routineRunSchema.parse({
      id: runId,
      revision: 0,
      blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
      origin: { kind: 'unplanned' },
      state: 'stopped',
      progress: [
        bProgress({ kind: 'checklist_confirmation', id: actualId, revisionId: randomUUID() }),
      ],
      selectedChoices: {},
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
    });
    await client.query(
      "INSERT INTO routine_run(athlete_id,id,blueprint_routine_id,blueprint_version_id,revision,state,record_json) VALUES($1,$2,$3,$4,0,'stopped',$5::jsonb)",
      [athlete, runId, blueprint.routineId, blueprint.versionId, JSON.stringify(record)],
    );
    await client.query(
      'INSERT INTO routine_run_revision(athlete_id,run_id,revision,record_json) VALUES($1,$2,0,$3::jsonb)',
      [athlete, runId, JSON.stringify(record)],
    );
    await client.query(
      "INSERT INTO routine_checklist_confirmation(athlete_id,id,run_id,step_id,revision_id,occurred_at,state) VALUES($1,$2,$3,'step',$4,'2026-01-01T00:00:00Z','partial')",
      [athlete, actualId, runId, storedRevisionId],
    );
  });
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});

async function permissionFacts(
  athlete: string,
  resourceVersionIds: string[] = [],
  plannedRefs: Parameters<typeof captureRaceImpactSourcePermissions>[1]['plannedRefs'] = [],
  baseBytes = 0n,
  existingSourceCount = 0,
  catalogRefs: Parameters<typeof captureRaceImpactSourcePermissions>[1]['catalogRefs'] = [],
) {
  return database.tenant(athlete, async (tx) => {
    await lockAppAdmission(tx);
    return captureRaceImpactSourcePermissions(tx, {
      resourceVersionIds,
      plannedRefs,
      baseBytes,
      existingSourceCount,
      catalogRefs,
    });
  });
}
it('captures exact owned resource access changes without requiring AI consent for manual reads', async () => {
  const athlete = await account();
  const resources = createPrivateTextResourceRepository(database);
  const access = createResourceAccessRepository(database);
  const created = await resources.create(athlete, {
    sourceKind: 'text',
    title: 'Synthetic reference',
    category: 'guide',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic private source.',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('Synthetic resource unavailable');
  const version = created.version.id;
  const initial = await permissionFacts(athlete, [version]);
  expect(initial.resources).toMatchObject([
    {
      state: 'current',
      current: { accessRevision: 1, aiAuthorized: false, includeForCoach: false },
    },
  ]);
  expect(initial.aiConsent).toEqual({ state: 'absent' });
  const reviewed = await access.setReviewed(athlete, created.resource.id, {
    reviewed: true,
    expectedAccessRevision: 1,
    expectedCurrentVersionId: version,
    idempotencyKey: randomUUID(),
  });
  const marked = await permissionFacts(athlete, [version]);
  expect(marked.resources).toMatchObject([
    {
      state: 'current',
      current: {
        reviewedState: 'reviewed',
        accessRevision: reviewed.accessRevision,
        aiAuthorized: false,
      },
    },
  ]);
  await owned(athlete, (c) =>
    c.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'ai',true,1)", [
      athlete,
    ]),
  );
  await access.setCoachUse(athlete, created.resource.id, {
    includeForCoach: true,
    expectedAccessRevision: reviewed.accessRevision,
    expectedCurrentVersionId: version,
    idempotencyKey: randomUUID(),
  });
  const enabled = await permissionFacts(athlete, [version]);
  expect(enabled.resources).toMatchObject([
    { current: { aiAuthorized: true, includeForCoach: true } },
  ]);
  expect(enabled.aiConsent).toEqual({ state: 'present', granted: true, revision: 1 });
  const appended = await resources.appendVersion(athlete, created.resource.id, {
    expectedCurrentVersionId: version,
    text: 'Synthetic new version.',
    idempotencyKey: randomUUID(),
  });
  if (appended.status !== 'available') throw new Error('Synthetic append unavailable');
  const historical = await permissionFacts(athlete, [version]);
  expect(historical.resources).toMatchObject([
    {
      requestedVersionId: version,
      state: 'historical',
      content: { versionId: version, contentHash: created.version.contentHash },
      current: { versionId: appended.version.id },
    },
  ]);
  expect(historical).not.toEqual(enabled);
  await owned(athlete, (c) =>
    c.query(
      "UPDATE consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='ai'",
      [athlete],
    ),
  );
  const withdrawn = await permissionFacts(athlete, [version]);
  expect(withdrawn.resources).toMatchObject([
    { state: 'historical', current: { aiAuthorized: false, cleanupPending: true } },
  ]);
  expect(withdrawn.aiConsent).toEqual({ state: 'present', granted: false, revision: 2 });
  expect(withdrawn.complete).toBe(false);
});
it('keeps foreign, missing and opaque resource refs contentless and bounded', async () => {
  const athlete = await account(),
    other = await account();
  const resources = createPrivateTextResourceRepository(database);
  const created = await resources.create(other, {
    sourceKind: 'text',
    title: 'Other synthetic reference',
    category: 'note',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Foreign synthetic source.',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('Synthetic resource unavailable');
  const result = await permissionFacts(athlete, [
    created.version.id,
    randomUUID(),
    'opaque-legacy',
  ]);
  expect(result.resources).toHaveLength(3);
  expect(
    result.resources.every(
      (row) => row.state === 'unavailable' && row.content === null && row.current === null,
    ),
  ).toBe(true);
  await expect(permissionFacts(athlete, [], [], 4194304n + 1n)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
  await expect(permissionFacts(athlete, [created.version.id], [], 0n, 5000)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
  });
});
it('separates exact planned session membership from current association and absent aggregate history', async () => {
  const athlete = await account(),
    version = await training(athlete);
  const head = await owned(athlete, (c) =>
    c.query('SELECT aggregate_id FROM plan_head WHERE athlete_id=$1', [athlete]),
  );
  const aggregate = z.uuid().parse(head.rows[0]?.['aggregate_id']);
  const requested = {
    domain: 'training' as const,
    planId: aggregate,
    versionId: version,
    itemId: 'session',
  };
  const current = await permissionFacts(athlete, [], [requested]);
  expect(current.planned).toMatchObject([
    { state: 'current', aggregateIdentity: 'current_head_association_only' },
  ]);
  const next = await training(athlete, draft(), false);
  await owned(athlete, (c) =>
    c.query('UPDATE plan_head SET version_id=$2 WHERE athlete_id=$1', [athlete, next]),
  );
  const old = await permissionFacts(athlete, [], [requested]);
  // Normal107 has no immutable SQL112 historical aggregate mapping. The current
  // head can identify its own snapshot, never certify an older snapshot's aggregate.
  expect(old.planned).toMatchObject([
    {
      state: 'unavailable',
      reason: 'aggregate_identity_unavailable',
      content: null,
      currentHead: { version_id: next },
    },
  ]);
  await owned(athlete, (c) => c.query('DELETE FROM plan_head WHERE athlete_id=$1', [athlete]));
  const absent = await permissionFacts(athlete, [], [requested]);
  expect(absent.planned).toMatchObject([
    {
      state: 'unavailable',
      reason: 'aggregate_identity_unavailable',
      content: null,
      currentHead: null,
    },
  ]);
  const other = await account();
  expect((await permissionFacts(other, [], [requested])).planned).toMatchObject([
    { state: 'unavailable', reason: 'owned_version_unavailable', content: null },
  ]);
  await expect(
    permissionFacts(athlete, [], [{ ...requested, versionId: 'forged' }]),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});

it('includes resource access and deleted facts in the captured context digest through frozen supplementary refs', async () => {
  const athlete = await account(),
    resources = createPrivateTextResourceRepository(database),
    access = createResourceAccessRepository(database);
  const created = await resources.create(athlete, {
    sourceKind: 'text',
    title: 'Synthetic immutable source',
    category: 'guide',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic fixture only.',
    idempotencyKey: randomUUID(),
  });
  if (created.status !== 'available') throw new Error('Synthetic resource unavailable');
  const exercise = await seedExercise(
    athlete,
    supplementaryExerciseVersionSchema.parse({
      ...syntheticExercise(),
      resourceVersionIds: [created.version.id],
    }),
  );
  const version = await training(athlete, strengthDraft()),
    event = await create(athlete);
  await seedLink(athlete, version, 'strength-0', {
    kind: 'embedded',
    spec: syntheticSpec(exercise.versionId),
  });
  const initial = await capture(athlete, event.id);
  expect(initial.sourcePermissionManifest.resources).toMatchObject([
    { state: 'current', current: { accessRevision: 1, aiAuthorized: false } },
  ]);
  expect((await capture(athlete, event.id)).readSetDigest).toBe(initial.readSetDigest);
  const reviewed = await access.setReviewed(athlete, created.resource.id, {
    reviewed: true,
    expectedAccessRevision: 1,
    expectedCurrentVersionId: created.version.id,
    idempotencyKey: randomUUID(),
  });
  const changed = await capture(athlete, event.id);
  expect(changed.readSetDigest).not.toBe(initial.readSetDigest);
  expect(changed.supplementaryManifest).toEqual(initial.supplementaryManifest);
  await resources.softDelete(athlete, created.resource.id, {
    expectedAccessRevision: reviewed.accessRevision,
    expectedCurrentVersionId: created.version.id,
    idempotencyKey: randomUUID(),
  });
  const deleted = await capture(athlete, event.id);
  expect(deleted.sourcePermissionManifest.resources).toMatchObject([
    { state: 'deleted', content: null, current: { deleted: true, cleanupPending: true } },
  ]);
  expect(deleted.readSetDigest).not.toBe(changed.readSetDigest);
  expect(deleted.coverage.complete).toBe(false);
});
it('validates immutable nutrition aggregate and item membership without foreign or latest substitution', async () => {
  const athlete = await account(),
    record = nutrition(null, [{ entity: 'race', entityId: randomUUID() }]);
  await seedNutrition(athlete, [record]);
  const requested = {
    domain: 'nutrition' as const,
    planId: record.planId,
    versionId: record.versionId,
    itemId: 'item0',
  };
  expect((await permissionFacts(athlete, [], [requested])).planned).toMatchObject([
    { state: 'current', aggregateIdentity: 'immutable_version' },
  ]);
  await owned(athlete, (c) =>
    c.query('DELETE FROM nutrition_plan_head WHERE athlete_id=$1', [athlete]),
  );
  expect((await permissionFacts(athlete, [], [requested])).planned).toMatchObject([
    { state: 'historical', currentHead: null },
  ]);
  expect(
    (await permissionFacts(athlete, [], [{ ...requested, planId: randomUUID() }])).planned,
  ).toMatchObject([{ state: 'unavailable', reason: 'aggregate_mismatch', content: null }]);
  expect(
    (await permissionFacts(athlete, [], [{ ...requested, itemId: 'missing' }])).planned,
  ).toMatchObject([{ state: 'unavailable', reason: 'item_unavailable', content: null }]);
  expect((await permissionFacts(await account(), [], [requested])).planned).toMatchObject([
    { state: 'unavailable', reason: 'owned_version_unavailable', content: null },
  ]);
});
it('captures exact blueprint catalog ownership and rejects forged identities without current-version substitution', async () => {
  const athlete = await account(),
    exercise = await seedExercise(athlete);
  const routineId = randomUUID(),
    versionId = randomUUID();
  const template = routineTemplateVersionSchema.parse({
    schemaVersion: 2,
    routineId,
    versionId,
    title: 'Synthetic frozen template',
    purpose: 'Synthetic source',
    requiredEquipment: ['bodyweight'],
    spec: syntheticSpec(exercise.versionId, versionId),
    createdAt: '2026-10-01T00:00:00Z',
  });
  await owned(athlete, async (c) => {
    await c.query(
      'INSERT INTO supplementary_routine_version(athlete_id,routine_id,version_id,version,created_at,record_json) VALUES($1,$2,$3,1,$4,$5::jsonb)',
      [athlete, routineId, versionId, template.createdAt, JSON.stringify(template)],
    );
    await c.query(
      'INSERT INTO supplementary_routine_head(athlete_id,routine_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, routineId, versionId],
    );
  });
  const requested = { kind: 'workout_template' as const, ref: { id: routineId, versionId } };
  const current = await permissionFacts(athlete, [], [], 0n, 0, [requested]);
  expect(current.catalog).toMatchObject([
    {
      requested,
      state: 'current',
      exercises: [{ state: 'owned', content: { versionId: exercise.versionId } }],
    },
  ]);
  await owned(athlete, (c) =>
    c.query('DELETE FROM supplementary_routine_head WHERE athlete_id=$1', [athlete]),
  );
  expect((await permissionFacts(athlete, [], [], 0n, 0, [requested])).catalog).toMatchObject([
    { state: 'historical', currentHead: null },
  ]);
  expect(
    (await permissionFacts(await account(), [], [], 0n, 0, [requested])).catalog,
  ).toMatchObject([{ state: 'unavailable', content: null }]);
  await expect(
    permissionFacts(athlete, [], [], 0n, 0, [
      { ...requested, ref: { id: randomUUID(), versionId } },
    ]),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  await expect(
    permissionFacts(athlete, [], [], 4194304n - 2048n, 0, [requested]),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
});

function dNutrients() {
  return {
    energy: { value: null, unit: 'kcal' as const, status: 'unknown' as const, evidenceIds: [] },
    carbohydrate: { value: null, unit: 'g' as const, status: 'unknown' as const, evidenceIds: [] },
    protein: { value: null, unit: 'g' as const, status: 'unknown' as const, evidenceIds: [] },
    fat: { value: null, unit: 'g' as const, status: 'unknown' as const, evidenceIds: [] },
    fluid: { value: null, unit: 'mL' as const, status: 'unknown' as const, evidenceIds: [] },
    sodium: { value: null, unit: 'mg' as const, status: 'unknown' as const, evidenceIds: [] },
  };
}
it('D consumes blueprint historical nutrition food and linked Plan copies before supplementary capture', async () => {
  const athlete = await account(),
    repository = createNutritionRepository(database);
  const firstFood = await repository.saveFood(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    expectedVersionId: null,
    definition: {
      foodId: 'synthetic-food',
      name: 'Synthetic food',
      basis: { kind: 'per_100g' },
      nutrients: dNutrients(),
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: '2026-10-01T00:00:00Z',
        reviewState: 'unreviewed',
      },
    },
  });
  const exercise = await seedExercise(athlete),
    oldPlan = await training(athlete, strengthDraft(), false);
  await seedLink(athlete, oldPlan, 'strength-0', {
    kind: 'embedded',
    spec: syntheticSpec(exercise.versionId),
  });
  await training(athlete);
  const event = await create(athlete),
    base = nutrition(oldPlan, [
      { entity: 'session', entityId: 'strength-0' },
      { entity: 'race', entityId: event.id },
    ]);
  const record = nutritionPlanVersionSchema.parse({
    ...base,
    items: base.items.map((item) => ({
      ...item,
      foods: [
        {
          foodVersionId: firstFood.versionId,
          description: 'Synthetic portion',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'per_100g',
        },
      ],
    })),
  });
  await seedNutrition(athlete, [record]);
  await owned(athlete, (c) =>
    c.query('DELETE FROM nutrition_plan_head WHERE athlete_id=$1', [athlete]),
  );
  const blueprint = await bSeedBlueprint(
    athlete,
    bBlueprint({
      kind: 'nutrition_template',
      ref: { id: record.planId, versionId: record.versionId },
    }),
  );
  await bSeedRun(athlete, blueprint);
  const captured = await capture(athlete, event.id);
  expect(captured.sourcePermissionManifest.nestedNutritionSources).toMatchObject([
    {
      versionId: record.versionId,
      foods: [{ requestedVersionId: firstFood.versionId, state: 'current' }],
      linkedPlan: { state: 'historical', requestedVersionId: oldPlan },
      anchors: [
        { source: { state: 'owned', planVersionId: oldPlan } },
        { source: { state: 'current' } },
      ],
    },
  ]);
  expect(captured.supplementaryManifest.copies).toMatchObject([
    { link: { planVersionId: oldPlan } },
  ]);
  expect(captured.supplementaryManifest.exercises).toMatchObject([
    { versionId: exercise.versionId },
  ]);
  const newer = await repository.saveFood(athlete, {
    confirmed: true,
    idempotencyKey: randomUUID(),
    expectedVersionId: firstFood.versionId,
    definition: {
      foodId: firstFood.foodId,
      name: 'Synthetic corrected catalog',
      basis: firstFood.basis,
      nutrients: dNutrients(),
      provenance: {
        kind: 'user_entered',
        reference: null,
        capturedAt: firstFood.provenance.capturedAt,
        reviewState: 'unreviewed',
      },
    },
  });
  const changed = await capture(athlete, event.id);
  expect(changed.sourcePermissionManifest.nestedNutritionSources).toMatchObject([
    {
      foods: [
        {
          state: 'historical',
          content: { versionId: firstFood.versionId, provenance: { reviewState: 'unreviewed' } },
          currentHead: { versionId: newer.versionId, provenance: { reviewState: 'unreviewed' } },
        },
      ],
    },
  ]);
  expect(changed.readSetDigest).not.toBe(captured.readSetDigest);
  expect(changed.supplementaryManifest).toEqual(captured.supplementaryManifest);
});
it('D caches repeated exact nutrition food/Plan/race bodies and keeps foreign refs contentless', async () => {
  const athlete = await account(),
    other = await account(),
    event = await create(athlete),
    plan = await training(athlete);
  const baseRecord = nutrition(plan, [
    { entity: 'race', entityId: event.id },
    { entity: 'race', entityId: event.id },
    { entity: 'session', entityId: 'session' },
  ]);
  const repository = createNutritionRepository(database);
  async function saveFood(tenant: string, id: string) {
    return repository.saveFood(tenant, {
      confirmed: true,
      idempotencyKey: randomUUID(),
      expectedVersionId: null,
      definition: {
        foodId: id,
        name: 'Synthetic cached source',
        basis: { kind: 'per_100g' },
        nutrients: dNutrients(),
        provenance: {
          kind: 'user_entered',
          reference: null,
          capturedAt: '2026-10-01T00:00:00Z',
          reviewState: 'unreviewed',
        },
      },
    });
  }
  const ownFood = await saveFood(athlete, 'owned-food'),
    foreignFood = await saveFood(other, 'foreign-food'),
    missingFood = randomUUID();
  const portion = (versionId: string) => ({
    foodVersionId: versionId,
    description: 'Synthetic portion',
    quantity: 0,
    unit: 'g',
    sourceBasis: 'per_100g',
  });
  const record = nutritionPlanVersionSchema.parse({
    ...baseRecord,
    items: baseRecord.items.map((item) => ({ ...item, foods: [portion(ownFood.versionId)] })),
  });
  const baseForeign = nutrition(null, [{ entity: 'race', entityId: (await create(other)).id }]);
  const foreign = nutritionPlanVersionSchema.parse({
    ...baseForeign,
    items: baseForeign.items.map((item) => ({
      ...item,
      foods: [portion(foreignFood.versionId), portion(missingFood)],
    })),
  });
  let raceBodyReads = 0,
    planBodyReads = 0,
    foodBodyReads = 0;
  const result = await database.tenant(athlete, async (tx) => {
    await lockAppAdmission(tx);
    return captureNestedNutritionSources(
      {
        athleteId: tx.athleteId,
        query: async (sql, values) => {
          if (sql.startsWith('SELECT v.food_id')) foodBodyReads++;
          return tx.query(sql, values);
        },
      },
      [record, record, foreign],
      { bytes: 0n, sources: 0 },
      {
        plan: async (id) => {
          planBodyReads++;
          const rows = await tx.query(
            'SELECT id,version,created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2::uuid',
            [athlete, id],
          );
          const row = z
            .object({
              id: z.uuid(),
              version: z.number(),
              created_at: z.date(),
              draft: planDraftSchema,
            })
            .parse(rows.rows[0]);
          return planSnapshotSchema.parse({
            id: row.id,
            version: row.version,
            createdAt: row.created_at.toISOString(),
            draft: row.draft,
          });
        },
        race: async (id) => {
          raceBodyReads++;
          const record = await races.getRaceEvent(athlete, id);
          if (!record) throw new Error('Synthetic owned race unavailable');
          return record;
        },
      },
    );
  });
  expect(planBodyReads).toBe(1);
  expect(raceBodyReads).toBe(1);
  expect(foodBodyReads).toBe(3);
  expect(result.nutrition.find((row) => row.versionId === foreign.versionId)?.foods).toMatchObject([
    { state: 'unavailable', content: null },
    { state: 'unavailable', content: null },
  ]);
  expect(result.nutrition).toHaveLength(2);
  expect(
    result.nutrition.find((row) => row.versionId === foreign.versionId)?.anchors,
  ).toMatchObject([{ source: { state: 'unavailable', content: null } }]);
});
it('D media metadata preserves own identity/deletion and explicitly leaves cleanup completion unavailable', async () => {
  const athlete = await account(),
    mediaId = randomUUID(),
    storageRef = `synthetic-object-${randomUUID()}`;
  // Plain-owner SQL represents an already committed synthetic upload, not real bytes/storage evidence.
  await owned(athlete, async (c) => {
    await c.query(
      "INSERT INTO gallery_media_object(athlete_id,storage_ref,content_hash,size_bytes,media_type,created_at) VALUES($1,$2,$3,1,'image/png',now())",
      [athlete, storageRef, 'a'.repeat(64)],
    );
    await c.query(
      "INSERT INTO gallery_media_item(athlete_id,id,media_kind,storage_ref,original_filename,media_type,size_bytes,content_hash,access_revision,created_at,updated_at) VALUES($1,$2,'image',$3,'synthetic.png','image/png',1,$4,1,now(),now())",
      [athlete, mediaId, storageRef, 'a'.repeat(64)],
    );
  });
  async function media(tenant: string) {
    return database.tenant(tenant, async (tx) => {
      await lockAppAdmission(tx);
      return captureActivityAndMediaPermissions(tx, [mediaId], { bytes: 0n, sources: 0 });
    });
  }
  const initial = await media(athlete);
  expect(initial.media).toMatchObject([
    {
      state: 'owned',
      accessRevision: 1,
      content: { objectIdentity: { state: 'present' } },
      cleanup: { state: 'unavailable' },
    },
  ]);
  expect(JSON.stringify(initial)).not.toContain(storageRef);
  expect((await media(await account())).media).toMatchObject([
    { state: 'unavailable', content: null },
  ]);
  await createGalleryMediaRepository(database).softDelete(athlete, mediaId, {
    expectedAccessRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect((await media(athlete)).media).toMatchObject([
    { state: 'deleted', accessRevision: 2, content: null, cleanup: { state: 'unavailable' } },
  ]);
});
it('D captures canonical overlay/source suppression and true provider provenance without treating FIT as Garmin', async () => {
  const athlete = await account(),
    event = await create(athlete),
    id = randomUUID(),
    sourceId = randomUUID();
  const original = {
    title: 'Synthetic actual',
    kind: 'running',
    startedAt: null,
    durationSeconds: null,
    durationKind: 'unknown',
    timezone: 'UTC',
    distanceMeters: 0,
  };
  // Owned legacy source facts, including explicit absence of its immutable raw revision.
  await owned(athlete, async (c) => {
    await c.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [athlete, id, JSON.stringify(original)],
    );
    await c.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fit',$2,1,$3,$4)",
      [athlete, sourceId, 'b'.repeat(64), id],
    );
  });
  const before = await capture(athlete, event.id);
  expect(before.sourcePermissionManifest.activityMediaPermissions.activities).toMatchObject([
    {
      source: { kind: 'fit', suppressed: false, revisionRecord: { state: 'absent' } },
      overlay: { state: 'absent' },
    },
  ]);
  expect(before.sourcePermissionManifest.activityMediaPermissions.garmin).toEqual({
    state: 'absent',
  });
  expect(before.sourcePermissionManifest.activityMediaPermissions.garminLineage).toEqual([]);
  await owned(athlete, async (c) => {
    await c.query(
      "INSERT INTO activity_overlay(athlete_id,activity_id,values_json) VALUES($1,$2,'{}')",
      [athlete, id],
    );
    await c.query(
      "INSERT INTO activity_overlay_revision(athlete_id,activity_id,revision,values_json) VALUES($1,$2,2,'{}')",
      [athlete, id],
    );
    await c.query('UPDATE activity_canonical SET revision=2 WHERE athlete_id=$1 AND id=$2', [
      athlete,
      id,
    ]);
    await c.query(
      "INSERT INTO activity_suppression(athlete_id,kind,source_id) VALUES($1,'fit',$2)",
      [athlete, sourceId],
    );
    await c.query(
      "INSERT INTO garmin_connection(athlete_id,generation,state) VALUES($1,0,'disconnected')",
      [athlete],
    );
    await c.query(
      "INSERT INTO garmin_unofficial_connection(athlete_id,session_generation,state) VALUES($1,0,'not_connected')",
      [athlete],
    );
    await c.query(
      "INSERT INTO garmin_activity_ledger(athlete_id,garmin_activity_id,provider,official,outcome,collected_at) VALUES($1,'123','garmin-connect-unofficial',false,'suppressed',now())",
      [athlete],
    );
    await c.query(
      "INSERT INTO garmin_activity_ledger_source(athlete_id,garmin_activity_id,kind,source_id) VALUES($1,'123','fit',$2)",
      [athlete, sourceId],
    );
  });
  const after = await capture(athlete, event.id);
  expect(after.sourcePermissionManifest.activityMediaPermissions.activities).toMatchObject([
    { revision: 2, source: { suppressed: true }, overlay: { state: 'present', revision: 2 } },
  ]);
  expect(after.sourcePermissionManifest.activityMediaPermissions.garmin).toMatchObject({
    state: 'present',
    connection: { generation: 0, state: 'disconnected' },
  });
  expect(after.sourcePermissionManifest.activityMediaPermissions.garminLineage).toMatchObject([
    { provider: 'garmin-connect-unofficial', official: false, outcome: 'suppressed' },
  ]);
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});

it('D records HealthKit claim/consent provenance and actual withdrawal suppression without foreign lookup', async () => {
  const athlete = await account(),
    event = await create(athlete),
    sampleId = randomUUID(),
    epoch = randomUUID();
  await owned(athlete, async (c) => {
    await c.query(
      "INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'healthkit',true,1)",
      [athlete],
    );
    await c.query('INSERT INTO healthkit_workout_registry_head(athlete_id,revision) VALUES($1,1)', [
      athlete,
    ]);
    await c.query(
      'INSERT INTO healthkit_workout_claim(athlete_id,sample_id,claim_epoch,consent_revision) VALUES($1,$2,$3,1)',
      [athlete, sampleId, epoch],
    );
    await c.query(
      "INSERT INTO healthkit_workout_sample(athlete_id,sample_id,installation_id,state,source_bundle_id,activity_type,observed_from,observed_to,duration_seconds,distance_meters,payload_digest) VALUES($1,$2,$3,'active','synthetic.fixture',37,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z',0,NULL,$4)",
      [athlete, sampleId, randomUUID(), 'c'.repeat(64)],
    );
    // Existing SQL producer creates the canonical/immutable source/lineage together.
    await c.query('SELECT public.create_healthkit_canonical($1,$2)', [sampleId, 'c'.repeat(64)]);
  });
  const before = await capture(athlete, event.id);
  expect(before.sourcePermissionManifest.activityMediaPermissions.healthkit).toMatchObject([
    {
      id: sampleId,
      sample: { state: 'present', status: 'active' },
      claim: { state: 'present', epoch, consentRevision: 1 },
      lineage: { state: 'present', status: 'created_activity' },
    },
  ]);
  expect(before.sourcePermissionManifest.activityMediaPermissions.healthkitRegistry).toEqual({
    state: 'present',
    revision: 1,
  });
  const other = await account(),
    foreignEvent = await create(other);
  const foreign = await capture(other, foreignEvent.id);
  expect(foreign.sourcePermissionManifest.activityMediaPermissions.healthkit).toEqual([]);
  expect(foreign.sourcePermissionManifest.activityMediaPermissions.healthkitRegistry).toEqual({
    state: 'absent',
  });
  await owned(athlete, (c) =>
    c.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='healthkit'",
      [athlete],
    ),
  );
  const withdrawn = await capture(athlete, event.id);
  expect(withdrawn.sourcePermissionManifest.activityMediaPermissions.healthkit).toMatchObject([
    {
      id: sampleId,
      sample: { state: 'absent' },
      claim: { state: 'absent' },
    },
  ]);
  expect(withdrawn.sourcePermissionManifest.activityMediaPermissions.activities).toMatchObject([
    { deleted: true, source: { kind: 'healthkit', suppressed: true } },
  ]);
  expect(withdrawn.sourcePermissionManifest.activityMediaPermissions.healthkitRegistry).toEqual({
    state: 'absent',
  });
  expect(withdrawn.sourcePermissionManifest.activityMediaPermissions.consents).toContainEqual({
    state: 'present',
    kind: 'healthkit',
    granted: false,
    revision: 2,
  });
  expect(withdrawn.readSetDigest).not.toBe(before.readSetDigest);
  expect(withdrawn.coverage.complete).toBe(false);
});
it('D enforces cumulative metadata bytes/reference bounds and explicit absent/zero provider facts', async () => {
  const athlete = await account();
  async function facts(bytes: bigint, sources: number) {
    return database.tenant(athlete, async (tx) => {
      await lockAppAdmission(tx);
      return captureActivityAndMediaPermissions(tx, [], { bytes, sources });
    });
  }
  const empty = await facts(0n, 0);
  expect(empty.activities).toEqual([]);
  expect(empty.garmin).toEqual({ state: 'absent' });
  expect(empty.consents).toContainEqual({ kind: 'media', state: 'absent' });
  await owned(athlete, (c) =>
    c.query(
      "INSERT INTO garmin_connection(athlete_id,generation,state) VALUES($1,0,'disconnected')",
      [athlete],
    ),
  );
  const zero = await facts(0n, 0);
  expect(zero.garmin).toMatchObject({
    state: 'present',
    connection: { generation: 0, state: 'disconnected', permissions: [] },
  });
  await expect(facts(4194304n, 0)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  await expect(facts(0n, 5000)).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'unique_sources',
  });
});

it('D collector manual basis tracks absent/false/grant/regrant without changing immutable domain facts', async () => {
  // Historical unpinned records may be read without current app permission. Seed them
  // under the plain owner, rather than deleting/recreating an already recorded app epoch.
  const athlete = randomUUID(),
    event = { id: randomUUID() };
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [athlete, event.id, JSON.stringify(values())],
    );
    await client.query(
      'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [athlete, event.id, JSON.stringify(values())],
    );
  });
  const plan = await training(athlete);
  const absent = await capture(athlete, event.id);
  expect(absent.manualBasis.app).toEqual({ state: 'absent' });
  await owned(athlete, (c) =>
    c.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',false,1)", [
      athlete,
    ]),
  );
  const denied = await capture(athlete, event.id);
  expect(denied.manualBasis.app).toEqual({ state: 'present', granted: false, revision: 1 });
  await owned(athlete, (c) =>
    c.query("UPDATE consent SET granted=true,revision=2 WHERE athlete_id=$1 AND kind='app'", [
      athlete,
    ]),
  );
  const granted = await capture(athlete, event.id);
  expect(granted.manualBasis.app).toEqual({ state: 'present', granted: true, revision: 2 });
  await owned(athlete, (c) =>
    c.query("UPDATE consent SET granted=false,revision=3 WHERE athlete_id=$1 AND kind='app'", [
      athlete,
    ]),
  );
  const revoked = await capture(athlete, event.id);
  await owned(athlete, (c) =>
    c.query("UPDATE consent SET granted=true,revision=4 WHERE athlete_id=$1 AND kind='app'", [
      athlete,
    ]),
  );
  const regranted = await capture(athlete, event.id);
  expect(
    new Set([absent, denied, granted, revoked, regranted].map((context) => context.readSetDigest))
      .size,
  ).toBe(5);
  for (const context of [denied, granted, revoked, regranted]) {
    expect(context.currentTraining?.snapshot.id).toBe(plan);
    expect(context.supplementaryManifest).toEqual(absent.supplementaryManifest);
    expect(context.routineActualManifest).toEqual(absent.routineActualManifest);
    expect(context.sourcePermissionManifest).toEqual(absent.sourcePermissionManifest);
    expect(context.manualBasis.policy).toEqual(absent.manualBasis.policy);
    expect(context.status).toBe('blocked');
    expect(context.coverage.complete).toBe(false);
  }
});

it('D rejects a forged current source head/hash rather than classifying a conflicting immutable revision as absent', async () => {
  const athlete = await account(),
    event = await create(athlete),
    id = randomUUID(),
    sourceId = randomUUID();
  const original = {
    title: 'Synthetic integrity check',
    kind: 'running',
    startedAt: null,
    durationSeconds: null,
    durationKind: 'unknown',
    timezone: 'UTC',
    distanceMeters: 0,
  };
  await owned(athlete, async (c) => {
    await c.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [athlete, id, JSON.stringify(original)],
    );
    await c.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [athlete, sourceId, 'a'.repeat(64), id],
    );
    await c.query(
      "INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw) VALUES($1,'fixture',$2,1,$3,$4::jsonb)",
      [athlete, sourceId, 'b'.repeat(64), JSON.stringify(original)],
    );
  });
  await expect(capture(athlete, event.id)).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});

it('E exports only exact consumed own historical/current Plan and race bodies, deterministically once per source', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false),
    current = await training(athlete),
    event = await create(athlete, { planVersionId: historical }),
    other = await create(athlete, { localDate: '2026-10-08' });
  await seedNutrition(athlete, [
    nutrition(historical, [
      { entity: 'race', entityId: other.id },
      { entity: 'session', entityId: 'session' },
    ]),
  ]);
  const measured = await measuredCapture(athlete, event.id);
  const captured = await measured.result;
  expect(captured.consumedSources.plans.map((plan) => plan.id)).toEqual(
    [historical, current].sort(),
  );
  expect(captured.consumedSources.races.map((race) => race.id)).toEqual(
    [event.id, other.id].sort(),
  );
  expect(captured.consumedSources.plans.find((plan) => plan.id === historical)).toEqual(
    captured.linkedPlan,
  );
  expect(captured.consumedSources.plans.find((plan) => plan.id === current)).toEqual(
    captured.currentTraining?.snapshot,
  );
  expect(captured.consumedSources.races.find((race) => race.id === other.id)?.localDate).toBe(
    '2026-10-08',
  );
  expect(new Set(captured.consumedSources.plans.map((plan) => plan.id)).size).toBe(2);
  expect(
    measured.queries.filter(
      ({ sql, parameters }) =>
        sql.includes('AS created_at,draft FROM plan_snapshot WHERE athlete_id=$1 AND id=$2') &&
        parameters?.[1] === historical,
    ),
  ).toHaveLength(1);
  expect(
    measured.queries.filter(
      ({ sql, parameters }) =>
        sql.startsWith('SELECT revision,values_json FROM race_event') &&
        parameters?.[1] === other.id,
    ),
  ).toHaveLength(1);
  const repeated = await capture(athlete, event.id);
  expect(repeated.consumedSources).toEqual(captured.consumedSources);
  expect(repeated.readSetDigest).toBe(captured.readSetDigest);
  expect(captured.coverage.complete).toBe(false);
});
it('E consumed source body changes alter readSet digest while immutable historical Plan remains exact', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false),
    event = await create(athlete, { planVersionId: historical }),
    other = await create(athlete);
  await seedNutrition(athlete, [nutrition(historical, [{ entity: 'race', entityId: other.id }])]);
  const before = await capture(athlete, event.id);
  await races.updateRaceEvent(athlete, other.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    values: { ...values(), title: 'Changed synthetic anchor', localDate: '2026-10-09' },
  });
  const after = await capture(athlete, event.id);
  expect(after.consumedSources.plans).toEqual(before.consumedSources.plans);
  expect(after.consumedSources.races.find((race) => race.id === other.id)).toMatchObject({
    revision: 2,
    title: 'Changed synthetic anchor',
    localDate: '2026-10-09',
  });
  expect(after.readSetDigest).not.toBe(before.readSetDigest);
});
it('E refuses foreign/missing/deleted race and orphan exact Plan sources rather than exporting another tenant body', async () => {
  const alice = await account(),
    bob = await account(),
    foreign = await create(bob),
    event = await create(alice);
  const record = nutrition(null, [{ entity: 'race', entityId: foreign.id }]);
  await seedNutrition(alice, [record]);
  await expect(capture(alice, event.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await races.deleteRaceEvent(bob, foreign.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(capture(alice, event.id)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  const missing = await account(),
    missingEvent = await create(missing);
  await seedNutrition(missing, [nutrition(null, [{ entity: 'race', entityId: randomUUID() }])]);
  await expect(capture(missing, missingEvent.id)).rejects.toMatchObject({
    code: 'SOURCE_UNAVAILABLE',
  });
  // An orphan event reference is a valid stored tuple; nutrition's actual FK
  // intentionally prevents constructing a nonexistent linked Plan fixture.
  const orphanEvent = randomUUID(),
    orphanValues = { ...values(), planVersionId: randomUUID() };
  await owned(missing, async (client) => {
    await client.query(
      'INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at) VALUES($1,$2,1,$3::jsonb,now(),now())',
      [missing, orphanEvent, JSON.stringify(orphanValues)],
    );
    await client.query(
      'INSERT INTO race_event_revision(athlete_id,entity_id,revision,values_json,created_at) VALUES($1,$2,1,$3::jsonb,now())',
      [missing, orphanEvent, JSON.stringify(orphanValues)],
    );
  });
  await expect(capture(missing, orphanEvent)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});
it('E includes all emitted copies of a shared current/linked Plan in scalar4MiB preflight before body transport', async () => {
  const athlete = await account(),
    body = draft();
  const session = body.sessions[0];
  if (!session) throw new Error('Missing session');
  body.sessions = Array.from({ length: 250 }, (_, index) => ({
    ...session,
    id: `session-${index}`,
    notes: 'x'.repeat(3000),
  }));
  const source = await training(athlete, body),
    event = await create(athlete, { planVersionId: source });
  const sourceBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  expect(sourceBytes).toBeLessThan(4194304);
  // Each Plan remains within its real 1MiB SQL constraint. The unchanged
  // nutrition bodies plus all three emitted Plan copies exceed the global cap.
  expect(sourceBytes).toBeLessThan(1048576);
  const records = Array.from({ length: 4 }, () =>
    repeatedNutrition(null, event.id, 200, 'x'.repeat(2000)),
  );
  await seedNutrition(athlete, records);
  const nutritionBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');
  expect(sourceBytes + nutritionBytes).toBeLessThan(4194304);
  expect(sourceBytes * 3 + nutritionBytes).toBeGreaterThan(4194304);
  const measured = await measuredCapture(athlete, event.id);
  await expect(measured.result).rejects.toMatchObject({
    code: 'CONTEXT_UNAVAILABLE',
    bound: 'decoded_bytes',
  });
  expect(measured.bytes()).toBeLessThan(4096);
  expect(
    measured.queries.some(({ sql }) =>
      sql.startsWith('SELECT id,revision,values_json FROM race_event'),
    ),
  ).toBe(false);
});

async function waitGenerationFence(role: string) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const result = await admin.query(
      "SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event='advisory'",
      [role],
    );
    if (result.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('EXPECTED_REAL_GENERATION_FENCE_WAITER');
}
it('F captures a real UUID generation twice in one tenant transaction and rejects runtime state/GUC/owner bypass', async () => {
  const athlete = await account(),
    event = await create(athlete);
  const captured = await database.tenant(athlete, async (tx) => {
    const first = await captureRacePlanImpactContext(tx, {
      eventId: event.id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    });
    await tx.query(
      "SELECT set_config('app.restore_generation',$1,true), set_config('app.is_owner','true',true)",
      [randomUUID()],
    );
    const second = await captureRacePlanImpactContext(tx, {
      eventId: event.id,
      expectedRevision: 1,
      selection: { kind: 'keep_plan' },
    });
    expect(z.uuid().parse(first.restoreGeneration)).toBe(await currentRestoreGeneration(tx));
    expect(second.restoreGeneration).toBe(first.restoreGeneration);
    expect(second.readSetDigest).toBe(first.readSetDigest);
    await requireCurrentRestoreGeneration(tx, first.restoreGeneration);
    return first;
  });
  expect(captured.coverage.complete).toBe(false);
  await expect(
    database.tenant(athlete, (tx) => tx.query('SELECT * FROM public.restore_generation')),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.tenant(athlete, async (tx) => {
      await tx.query(
        "SELECT set_config('app.restore_generation',$1,true),set_config('app.is_owner','true',true)",
        [randomUUID()],
      );
      await tx.query('SELECT public.rotate_restore_generation()');
    }),
  ).rejects.toMatchObject({ code: '42501' });
});
it('F global shared capture fence precedes an exclusive owner rotation and saved generation becomes stale after commit', async () => {
  const athlete = await account(),
    event = await create(athlete),
    client = await owner.connect();
  let rotation: Promise<string> | undefined;
  try {
    const captured = await database.tenant(athlete, async (tx) => {
      const first = await captureRacePlanImpactContext(tx, {
        eventId: event.id,
        expectedRevision: 1,
        selection: { kind: 'keep_plan' },
      });
      rotation = (async () => {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(77210,1)');
        const row = await client.query('SELECT public.rotate_restore_generation() AS generation');
        await client.query('COMMIT');
        return z.uuid().parse(row.rows[0]?.generation);
      })();
      await waitGenerationFence(ownerRole);
      const second = await captureRacePlanImpactContext(tx, {
        eventId: event.id,
        expectedRevision: 1,
        selection: { kind: 'keep_plan' },
      });
      expect(second.restoreGeneration).toBe(first.restoreGeneration);
      expect(second.readSetDigest).toBe(first.readSetDigest);
      return first;
    });
    const rotated = await rotation;
    const current = await capture(athlete, event.id);
    expect(current.restoreGeneration).toBe(rotated);
    expect(current.restoreGeneration).not.toBe(captured.restoreGeneration);
    expect(current.readSetDigest).not.toBe(captured.readSetDigest);
    expect(current.event).toEqual(captured.event);
    expect(current.manualBasis).toEqual(captured.manualBasis);
    expect(current.consumedSources).toEqual(captured.consumedSources);
    await expect(
      database.tenant(athlete, (tx) =>
        requireCurrentRestoreGeneration(tx, captured.restoreGeneration),
      ),
    ).rejects.toMatchObject({ code: 'STALE_RESTORE_GENERATION' });
    await database.tenant(athlete, (tx) =>
      requireCurrentRestoreGeneration(tx, current.restoreGeneration),
    );
  } finally {
    if (rotation) await rotation;
    await client.query('ROLLBACK');
    client.release();
  }
});
it('F an exclusive owner rotation wins before a new capture and does not fabricate a prior snapshot epoch', async () => {
  const athlete = await account(),
    event = await create(athlete),
    before = await capture(athlete, event.id),
    client = await owner.connect();
  let pending: ReturnType<typeof capture> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(77210,1)');
    pending = capture(athlete, event.id);
    await waitGenerationFence(runtimeRole);
    const row = await client.query('SELECT public.rotate_restore_generation() AS generation');
    const rotated = z.uuid().parse(row.rows[0]?.generation);
    await client.query('COMMIT');
    const after = await pending;
    expect(after.restoreGeneration).toBe(rotated);
    expect(after.restoreGeneration).not.toBe(before.restoreGeneration);
    expect(after.readSetDigest).not.toBe(before.readSetDigest);
    expect(after.event).toEqual(before.event);
    expect(after.coverage.complete).toBe(false);
    await expect(
      database.tenant(athlete, (tx) =>
        requireCurrentRestoreGeneration(tx, before.restoreGeneration),
      ),
    ).rejects.toMatchObject({ code: 'STALE_RESTORE_GENERATION' });
  } finally {
    await client.query('ROLLBACK');
    if (pending) await pending;
    client.release();
  }
});
