import { createCheckInRepository } from '../src/check-ins.js';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
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
// Explicit normal107 + raw115/116/123. Identity bootstrap alone uses owner SQL.
// Health, template, routine, CheckIn and chain bodies use public producers.
// Root executes PG; no source authenticity, approval or whole restore is implied.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `manual_checkin_copied_${suffix}`,
  ownerRole = `manual_checkin_copied_owner_${suffix}`,
  runtimeRole = `manual_checkin_copied_app_${suffix}`;
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
    await migrationOwner.query(
      await readFile(
        new URL(
          '../migrations/115_manual_review_full_owned_source_bindings_v2.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await migrationOwner.query(
      `GRANT EXECUTE ON FUNCTION public.observe_manual_review_full_owned_source_bindings_v2(jsonb) TO "${runtimeRole}"`,
    );
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/116_manual_race_chain_v2.sql', import.meta.url),
        'utf8',
      ),
    );
    for (const signature of [
      'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.read_manual_race_chain_receipt_v2(text,jsonb)',
      'public.read_manual_race_chain_v2(uuid)',
    ])
      await migrationOwner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
    await migrationOwner.query(
      await readFile(
        new URL('../migrations/123_check_in_template_versions.sql', import.meta.url),
        'utf8',
      ),
    );
    for (const signature of [
      'public.save_check_in_template_v1(jsonb)',
      'public.read_check_in_template_version_v1(uuid,uuid)',
      'public.read_check_in_template_head_v1(uuid)',
      'public.list_check_in_template_heads_v1(integer,integer)',
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

async function setup(planned: boolean) {
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
  const consent = createConsentRepository(db);
  await consent.setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await consent.setConsent(athlete, {
    kind: 'ai',
    granted: false,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic copied CheckIn',
      localDate: '2026-10-06',
      localStartTime: null,
      timezone: 'UTC',
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
  const templates = createCheckInTemplateRepository(db);
  const content = {
    definitionVersion: 'checkin-v1' as const,
    source: 'user' as const,
    method: 'self_report' as const,
    title: 'Synthetic self report',
    instructions: null,
    fields: ['fatigue', 'note'] as ('fatigue' | 'note')[],
  };
  const template = await templates.save(athlete, {
    idempotencyKey: randomUUID(),
    templateId: randomUUID(),
    expectedVersion: 0,
    content,
  });
  const routines = createRoutineRepository(db);
  const blueprint = (
    await routines.saveBlueprint(athlete, {
      confirmed: true,
      expectedVersionId: null,
      idempotencyKey: randomUUID(),
      blueprint: {
        schemaVersion: 4,
        routineId: randomUUID(),
        versionId: randomUUID(),
        title: 'Synthetic report',
        intent: 'Explicit self report',
        status: 'published',
        tags: [],
        estimatedDurationSeconds: null,
        createdAt: new Date().toISOString(),
        steps: [
          {
            id: 'report',
            title: 'Report',
            content: {
              kind: 'checkin_template',
              ref: { id: template.templateId, versionId: template.versionId },
            },
            timing: { kind: 'ordered', afterStepId: null },
            required: true,
            choiceGroupId: null,
          },
        ],
        choiceGroups: [],
      },
    })
  ).blueprint;
  let occurrenceId: string | null = null;
  if (planned) {
    const schedule = {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: { id: blueprint.routineId, versionId: blueprint.versionId },
      window: {
        startDate: '2026-10-06',
        endDateExclusive: '2026-10-07',
        timezone: 'UTC',
        maxOccurrences: 1,
      },
      rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '07:00' },
      state: 'draft' as const,
    };
    const preview = await routines.previewSchedule(athlete, {
      schedule,
      sourcePlanVersionId: null,
    });
    const approved = await routines.approveSchedule(athlete, {
      schedule,
      sourcePlanVersionId: null,
      previewDigest: preview.previewDigest,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    occurrenceId = z.uuid().parse(approved.occurrences[0]?.id);
  }
  const started = await routines.startRun(athlete, {
    runId: randomUUID(),
    blueprintVersionId: blueprint.versionId,
    occurrenceId,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  const checkins = createCheckInRepository(db);
  const create = {
    idempotencyKey: randomUUID(),
    values: {
      observedAt: '2026-10-06T00:00:00Z',
      timezone: 'UTC',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: null,
    },
  };
  const actual = await checkins.createCheckIn(athlete, create);
  const observation = await checkins.getCheckIn(athlete, actual.id);
  if (!observation) throw Error('PUBLIC_CHECKIN_MISSING');
  const recorded = await routines.recordStep(athlete, {
    runId: started.run.id,
    stepId: 'report',
    state: 'performed',
    actualRefs: [{ kind: 'checkin', id: actual.id, revisionId: String(actual.revision) }],
    occurredAt: null,
    reason: null,
    expectedRevision: started.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  await templates.save(athlete, {
    idempotencyKey: randomUUID(),
    templateId: template.templateId,
    expectedVersion: 1,
    content: { ...content, title: 'New head must not repin frozen blueprint' },
  });
  const intent = {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' as const },
  };
  const prepared = await createRaceManualSemanticBasisV2Service(db).prepare(athlete, intent);
  if (prepared.status !== 'current_dependencies_captured')
    throw Error(`CHECKIN_BASIS_BLOCKED:${prepared.reason}`);
  const command = {
    schemaVersion: 2 as const,
    idempotencyKey: randomUUID(),
    intent,
    expectedBasis: prepared.basis,
  };
  return {
    athlete,
    template,
    blueprint,
    routines,
    checkins,
    actual,
    observation,
    recorded,
    create,
    prepared,
    command,
  };
}
function dereference(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (typeof value !== 'object' || value === null) throw Error('COPIED_LOCATION_MISSING');
    value = z
      .record(z.string(), z.unknown())
      .parse(Array.isArray(value) ? Object.fromEntries(value.entries()) : value)[key];
  }
  if (value === undefined) throw Error('COPIED_LOCATION_MISSING');
  return value;
}
async function inspected(athlete: string, evidenceId: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const inspector = new Pool({ connectionString: u.toString() });
  try {
    // Read-only metadata inspector: no owner health/source/event mutation.
    return {
      edges: (
        await inspector.query(
          'SELECT edge FROM manual_race_chain_lifecycle_edge_v2 WHERE athlete_id=$1 AND evidence_id=$2 ORDER BY ordinal,edge_key',
          [athlete, evidenceId],
        )
      ).rows.map((r) => z.record(z.string(), z.unknown()).parse(r['edge'])),
      events: (
        await inspector.query(
          "SELECT event_id,kind,target_id FROM restore_suppression_event WHERE athlete_id=$1 AND kind='check_in_deleted' ORDER BY occurred_at,event_id",
          [athlete],
        )
      ).rows,
      bodies: (
        await inspector.query(
          'SELECT (SELECT count(*)::int FROM manual_race_evidence_v2 WHERE athlete_id=$1 AND payload IS NOT NULL) AS evidence,(SELECT count(*)::int FROM manual_race_decision_v2 WHERE athlete_id=$1) AS decision,(SELECT count(*)::int FROM manual_race_proposal_v2 WHERE athlete_id=$1) AS proposal',
          [athlete],
        )
      ).rows[0],
    };
  } finally {
    await inspector.end();
  }
}
it.each([false, true])(
  'public template → %s scheduled run → copied integer CheckIn revision → exact deletion scrubs only its chain',
  async (planned) => {
    const f = await setup(planned);
    expect(f.observation.values).toMatchObject({ fatigue: 0, discomfort: null, note: null });
    expect(f.recorded.run.progress[0]?.actualRefs).toEqual([
      { kind: 'checkin', id: f.actual.id, revisionId: String(f.actual.revision) },
    ]);
    expect(await f.routines.readBlueprintVersion(f.athlete, f.blueprint.versionId)).toEqual(
      f.blueprint,
    );
    const payload = f.prepared.prepared.retained.payload;
    const refs = payload.inventory.refs.filter((r) => r.identity.kind === 'checkin-revision');
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    if (!ref) throw Error('COPIED_CHECKIN_REF_MISSING');
    expect(ref.identity).toEqual({
      kind: 'checkin-revision',
      sourceId: f.actual.id,
      revision: f.actual.revision,
    });
    expect(ref.copiedLocations.length).toBeGreaterThan(0);
    for (const location of ref.copiedLocations) {
      const copied = dereference(payload.preparation, location);
      expect(impactDependencyDigest(copied)).toBe(ref.dtoDigest);
      expect(copied).toMatchObject({ fatigue: 0, discomfort: null });
    }
    const repo = createRaceManualReviewChainV2Repository(db);
    const stored = await repo.store(f.athlete, f.command);
    if (stored.status !== 'stored') throw Error(`CHECKIN_CHAIN_NOT_STORED:${stored.status}`);
    expect(stored).toMatchObject({ authority: 'none', approvalAllowed: false, planApplied: false });
    const before = await repo.read(f.athlete, stored.result.evidenceId);
    expect(before?.payload?.state).toBe('present');
    expect((await inspected(f.athlete, stored.result.evidenceId)).edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: 'checkin',
          sourceId: f.actual.id,
          versionKey: String(f.actual.revision),
        }),
      ]),
    );
    // An unrelated genuine deletion must not purge this copied source.
    const unrelated = await f.checkins.createCheckIn(f.athlete, {
      ...f.create,
      idempotencyKey: randomUUID(),
    });
    await f.checkins.deleteCheckIn(f.athlete, unrelated.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: unrelated.revision,
    });
    expect((await repo.read(f.athlete, stored.result.evidenceId))?.payload).toEqual(
      before?.payload,
    );
    const deletion = { idempotencyKey: randomUUID(), expectedRevision: f.actual.revision };
    const deleted = await f.checkins.deleteCheckIn(f.athlete, f.actual.id, deletion);
    expect(deleted.deleted).toBe(true);
    expect(await f.checkins.getCheckIn(f.athlete, f.actual.id)).toBeNull();
    expect((await repo.read(f.athlete, stored.result.evidenceId))?.payload).toBeNull();
    const after = await inspected(f.athlete, stored.result.evidenceId);
    expect(after.bodies).toEqual({ evidence: 0, decision: 1, proposal: 1 });
    expect(after.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'check_in_deleted', target_id: f.actual.id }),
      ]),
    );
    expect(await f.checkins.deleteCheckIn(f.athlete, f.actual.id, deletion)).toEqual(deleted);
    expect(await repo.store(f.athlete, f.command)).toMatchObject({
      status: 'replayed',
      result: stored.result,
    });
    expect((await repo.read(f.athlete, stored.result.evidenceId))?.payload).toBeNull();
    const replayedActual = await f.checkins.createCheckIn(f.athlete, f.create);
    // A minimal historical command acknowledgement replays unchanged; it is
    // not a live CheckIn record. It contains no values and must not recreate data.
    expect(replayedActual).toEqual(f.actual);
    expect(Object.keys(replayedActual).sort()).toEqual([
      'collectionRevision',
      'deleted',
      'id',
      'revision',
    ]);
    expect(await f.checkins.getCheckIn(f.athlete, f.actual.id)).toBeNull();
    expect((await f.routines.readRun(f.athlete, f.recorded.run.id))?.run).toEqual(f.recorded.run);
    expect(await f.routines.readBlueprintVersion(f.athlete, f.blueprint.versionId)).toEqual(
      f.blueprint,
    );
    expect((await inspected(f.athlete, stored.result.evidenceId)).events).toEqual(after.events);
  },
);
