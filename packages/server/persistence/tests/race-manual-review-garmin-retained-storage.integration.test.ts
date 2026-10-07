import { captureRaceManualReviewLifecycleInventoryV2In } from '../src/race-manual-review-lifecycle-inventory-v2.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { captureRacePlanImpactContext } from '../src/race-plan-impact-context.js';
import { createActivityRepository } from '../src/activities.js';
import { createGarminUnofficialStore } from '../src/garmin-unofficial.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createPlanningRepository } from '../src/planning.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { planDraftSchema } from '@workout/contracts/planning';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import {
  migrate,
  grantCorePlanning,
  grantActivityTracks,
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
// normal107 public producers + isolated raw115 full-owned observation stage.
// No remote collector, official authentication, device or binary parser evidence.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `garmin_retained_store_${suffix}`,
  ownerRole = `garmin_retained_store_owner_${suffix}`,
  runtimeRole = `garmin_retained_store_app_${suffix}`;
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
      'store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'read_manual_race_chain_receipt_v2(text,jsonb)',
      'read_manual_race_chain_v2(uuid)',
    ])
      await migrationOwner.query(
        `GRANT EXECUTE ON FUNCTION public.${signature} TO "${runtimeRole}"`,
      );
    expect(
      (await migrationOwner.query('SELECT max(version)::int AS version FROM schema_migrations'))
        .rows[0]?.['version'],
    ).toBe(107);
  } finally {
    await migrationOwner.end();
  }

  for (const grant of [
    grantCorePlanning,
    grantActivityTracks,
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
  const activityOwner = new Pool({ connectionString: url(ownerRole) });
  try {
    await activityOwner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
    );
  } finally {
    await activityOwner.end();
  }
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
  const owner = new Pool({ connectionString: url(ownerRole) });
  // Identity-only FK prerequisite. No owner health/source/admission rows.
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
      title: 'Synthetic manual binding',
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
  const intent = {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' as const },
  };
  return { athlete, consent, intent };
}
async function inSnapshot<T>(athlete: string, op: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return db.snapshotTenant(athlete, op);
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

async function catalogFixture(athlete: string, target = db, mediaAssetIds: string[] = []) {
  const resources = createPrivateTextResourceRepository(target),
    catalog = createSupplementaryRepository(target),
    routines = createRoutineRepository(target);
  const resource = await resources.create(athlete, {
    sourceKind: 'text',
    title: 'Synthetic source',
    category: 'guide',
    metadata: {},
    tags: [],
    favorite: false,
    text: 'Synthetic plain text only.',
    idempotencyKey: randomUUID(),
  });
  if (resource.status !== 'available') throw Error('FIXTURE_RESOURCE_UNAVAILABLE');
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
      mediaAssetIds,
      resourceVersionIds: [resource.version.id],
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
  const blueprint = routineBlueprintVersionSchema.parse({
    schemaVersion: 4,
    routineId: randomUUID(),
    versionId: randomUUID(),
    title: 'Synthetic source blueprint',
    intent: 'Retained source read',
    status: 'published',
    tags: [],
    steps: [
      {
        id: 'step',
        title: 'Named source',
        content: {
          kind: 'workout_template',
          ref: { id: saved.template.routineId, versionId: saved.template.versionId },
        },
        timing: { kind: 'user_scheduled' },
        required: true,
        choiceGroupId: null,
      },
    ],
    choiceGroups: [],
    estimatedDurationSeconds: null,
    createdAt: '2026-01-01T00:00:00Z',
  });
  const savedBlueprint = await routines.saveBlueprint(athlete, {
    blueprint,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });

  const training = await createPlanningRepository(target).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: {
      ...draft(),
      sessions: draft().sessions.map((session) => ({ ...session, sport: 'strength' })),
    },
    supplementaryLinks: [
      {
        plannedSessionId: 'session',
        content: { kind: 'embedded', spec: { ...saved.template.spec, routineVersionId: null } },
      },
    ],
  });
  const scheduleInput = {
    schedule: {
      schemaVersion: 4 as const,
      id: randomUUID(),
      versionId: randomUUID(),
      blueprint: {
        id: savedBlueprint.blueprint.routineId,
        versionId: savedBlueprint.blueprint.versionId,
      },
      window: {
        startDate: '2026-10-01',
        endDateExclusive: '2026-11-01',
        timezone: 'Asia/Seoul',
        maxOccurrences: 10,
      },
      rule: { kind: 'dates' as const, dates: ['2026-10-06'], localTime: '08:00' },
      state: 'draft' as const,
    },
    sourcePlanVersionId: training.id,
  };
  const schedulePreview = await routines.previewSchedule(athlete, scheduleInput);
  const approved = await routines.approveSchedule(athlete, {
    ...scheduleInput,
    previewDigest: schedulePreview.previewDigest,
    confirmed: true,
    idempotencyKey: randomUUID(),
  });
  return {
    resource,
    resources,
    exercise,
    saved,
    catalog,
    blueprint: savedBlueprint.blueprint,
    routines,
    approved,
  };
}

async function collected(link = true) {
  const f = await setup(),
    catalog = await catalogFixture(f.athlete),
    activities = createActivityRepository(db);
  const source = {
    kind: 'fit' as const,
    sourceId: `Collected-식-A-${randomUUID()}`,
    revision: 1,
    contentHash: 'a'.repeat(64),
  };
  const imported = await activities.importActivity(f.athlete, {
    idempotencyKey: randomUUID(),
    source,
    activity: {
      title: 'Synthetic saved core',
      kind: 'strength',
      startedAt: '2026-10-06T00:00:00Z',
      timezone: 'Asia/Seoul',
      durationSeconds: 0,
      durationKind: 'unknown',
      distanceMeters: null,
    },
  });
  const current = await activities.updateOverlay(f.athlete, imported.activityId, {
    expectedRevision: imported.revision,
    idempotencyKey: randomUUID(),
    reason: 'Explicit synthetic zero overlay',
    distanceMeters: 0,
  });
  if (link)
    await createGarminUnofficialStore(db).recordCollected({
      athleteId: f.athlete,
      garminActivityId: '987654321',
      provider: 'garmin-connect-unofficial',
      outcome: 'imported',
      sources: [{ kind: source.kind, sourceId: source.sourceId }],
      now: new Date('2026-10-07T00:00:00Z'),
      appRevision: 1,
    });
  let run = await catalog.routines.startRun(f.athlete, {
    runId: randomUUID(),
    blueprintVersionId: catalog.blueprint.versionId,
    occurrenceId: null,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  run = await catalog.routines.recordStep(f.athlete, {
    runId: run.run.id,
    stepId: 'step',
    state: 'performed',
    actualRefs: [
      {
        kind: 'activity',
        id: current.id,
        revisionId: String(current.revision),
        detailId: null,
        allocationId: null,
      },
    ],
    occurredAt: '2026-10-06T00:00:00Z',
    reason: null,
    expectedRevision: run.run.revision,
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  return { f, source, current, activities, run };
}
function capture(tx: Transaction, f: Awaited<ReturnType<typeof setup>>) {
  return captureRacePlanImpactContext(
    tx,
    {
      eventId: f.intent.expectedEvent.id,
      expectedRevision: f.intent.expectedEvent.revision,
      selection: { kind: 'keep_plan' },
    },
    { bytes: 0n, sources: 0 },
  );
}

// Root-only actual PG. Synthetic normalized FIT and collector attribution, not
// binary parsing, remote login, or authenticated provider/device observations.
const resultSchema = z.strictObject({
  schemaVersion: z.literal(2),
  evidenceId: z.uuid(),
  decisionId: z.uuid(),
  proposalId: z.uuid(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  applicable: z.literal(false),
  approvalAllowed: z.literal(false),
});
async function prepared(tx: Transaction, unknownIntent: unknown) {
  const budget = { bytes: 0n, sources: 0 };
  const actual = await prepareRaceManualSemanticBasisV2In(tx, unknownIntent, null, budget);
  if (actual.status !== 'current_dependencies_captured')
    throw Error(JSON.stringify({ status: actual.status, reason: actual.reason }));
  const lifecycle = await captureRaceManualReviewLifecycleInventoryV2In(
    tx,
    actual.prepared.retained,
    budget,
  );
  if (lifecycle.status !== 'dependency_correspondence') throw Error('ACTUAL_LIFECYCLE_BLOCKED');
  const key = randomUUID();
  return {
    key,
    payload: actual.prepared.retained,
    basis: actual.basis,
    lifecycle,
    request: {
      schemaVersion: 2,
      idempotencyKey: key,
      intent: actual.basis.intent,
      expectedBasis: actual.basis,
    },
    ids: [randomUUID(), randomUUID(), randomUUID()],
  };
}
type Prepared = Awaited<ReturnType<typeof prepared>>;
async function store(tx: Transaction, p: Prepared) {
  const r = await tx.query(
    'SELECT public.store_manual_race_chain_v2($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb) AS result',
    [
      ...p.ids,
      p.key,
      JSON.stringify(p.request),
      JSON.stringify(p.payload),
      JSON.stringify(p.basis),
      JSON.stringify(p.lifecycle),
    ],
  );
  return resultSchema.parse(r.rows[0]?.['result']);
}
async function read(tx: Transaction, id: string) {
  return (await tx.query('SELECT public.read_manual_race_chain_v2($1::uuid) AS value', [id]))
    .rows[0]?.['value'];
}
async function inspect<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const owner = new Pool({ connectionString: url(ownerRole) }),
    client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    return await operation(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await owner.end();
  }
}
async function counts(athlete: string) {
  return inspect(
    athlete,
    async (client) =>
      (
        await client.query(
          'SELECT (SELECT count(*)::int FROM public.manual_race_evidence_v2 WHERE athlete_id=$1) AS evidence,(SELECT count(*)::int FROM public.manual_race_decision_v2 WHERE athlete_id=$1) AS decision,(SELECT count(*)::int FROM public.manual_race_proposal_v2 WHERE athlete_id=$1) AS proposal',
          [athlete],
        )
      ).rows[0],
  );
}
it('public collected core Activity stores once with exact source/app observation, readable original zero/null and no approval', async () => {
  const x = await collected();
  const saved = await inSnapshot(x.f.athlete, async (tx) => {
    const p = await prepared(tx, x.f.intent);
    const facts = p.basis.consumedUses.facts.filter(
      (f) => f.sourcePurpose?.kind === 'own_garmin_current_core_activity',
    );
    expect(facts).toHaveLength(2);
    for (const fact of facts)
      expect(fact.sourcePurpose).toMatchObject({
        activityId: x.current.id,
        canonicalRevision: x.current.revision,
        source: x.source,
        collectionPermission: 'not_captured',
        appAdmission: { kind: 'app', granted: true, revision: 1 },
      });
    return { p, result: await store(tx, p) };
  });
  expect(saved.result).toMatchObject({ applicable: false, approvalAllowed: false });
  expect(await inSnapshot(x.f.athlete, (tx) => read(tx, saved.result.evidenceId))).toMatchObject({
    payload: saved.p.payload,
    result: saved.result,
  });
  expect(await inSnapshot(x.f.athlete, (tx) => store(tx, saved.p))).toEqual(saved.result);
  expect(await counts(x.f.athlete)).toEqual({ evidence: 1, decision: 1, proposal: 1 });
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await inSnapshot(x.f.athlete, (tx) => store(tx, saved.p))).toEqual(saved.result);
  expect(
    (await inSnapshot(x.f.athlete, (tx) => capture(tx, x.f))).garminActivityReadFacts.facts[0]
      ?.state,
  ).toBe('current');
});
it('genuine public Activity deletion scrubs sole payload and receipt never restores copied source', async () => {
  const x = await collected(),
    saved = await inSnapshot(x.f.athlete, async (tx) => {
      const p = await prepared(tx, x.f.intent);
      return { p, result: await store(tx, p) };
    });
  await x.activities.deleteActivity(x.f.athlete, x.current.id, {
    expectedRevision: x.current.revision,
  });
  expect(await inSnapshot(x.f.athlete, (tx) => read(tx, saved.result.evidenceId))).toEqual({
    schemaVersion: 2,
    result: saved.result,
    payload: null,
  });
  expect(await inSnapshot(x.f.athlete, (tx) => store(tx, saved.p))).toEqual(saved.result);
  expect(await counts(x.f.athlete)).toEqual({ evidence: 1, decision: 1, proposal: 1 });
  await inspect(x.f.athlete, async (owner) => {
    const r = await owner.query(
      'SELECT s.kind,s.target_id,m.original_payload_sql_digest FROM public.manual_race_chain_suppression_v2 m JOIN public.restore_suppression_event s ON s.athlete_id=m.athlete_id AND s.event_id=m.event_id WHERE m.athlete_id=$1 AND m.evidence_id=$2',
      [x.f.athlete, saved.result.evidenceId],
    );
    expect(r.rows).toEqual([
      expect.objectContaining({
        kind: 'activity_deleted',
        target_id: x.current.id,
        original_payload_sql_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    const receipts = await owner.query(
      'SELECT result,request_digest FROM public.manual_race_chain_receipt_v2 WHERE athlete_id=$1',
      [x.f.athlete],
    );
    expect(receipts.rows).toEqual([
      expect.objectContaining({ result: saved.result, request_digest: expect.any(Buffer) }),
    ]);
    expect(JSON.stringify(receipts.rows)).not.toContain(x.source.sourceId);
  });
});
it('current app withdrawal and reallow revision deny stale new storage without treating unused provider cycles as permission', async () => {
  const x = await collected(),
    p = await inSnapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent));
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(inSnapshot(x.f.athlete, (tx) => store(tx, p))).rejects.toThrow();
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  await expect(inSnapshot(x.f.athlete, (tx) => store(tx, p))).rejects.toThrow();
  expect(await counts(x.f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'provider',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'provider',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const fresh = await inSnapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent));
  expect(await inSnapshot(x.f.athlete, (tx) => store(tx, fresh))).toMatchObject({
    applicable: false,
  });
});
it.each(['source', 'app', 'ledger', 'extra', 'authentication'] as const)(
  'forged %s observation cannot establish final purpose authority',
  async (field) => {
    const x = await collected(),
      p = await inSnapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent)),
      basis = structuredClone(p.basis);
    for (const f of basis.consumedUses.facts) {
      const o = f.sourcePurpose;
      if (o?.kind !== 'own_garmin_current_core_activity') continue;
      if (field === 'source') o.source.contentHash = 'b'.repeat(64);
      else if (field === 'app') o.appAdmission.revision = 99;
      else if (field === 'ledger') o.collection.garminActivityId = '123';
      else if (field === 'extra') Object.assign(o, { collectionGrant: true });
      else Object.assign(f, { sourceAuthentication: 'verified' });
    }
    await expect(
      inSnapshot(x.f.athlete, (tx) =>
        store(tx, { ...p, basis, request: { ...p.request, expectedBasis: basis } }),
      ),
    ).rejects.toThrow('MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE');
    expect(await counts(x.f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
  },
);
it('existing runtime ledger drift and public overlay revision changes reject earlier basis; foreign tenant is not authority', async () => {
  const x = await collected(),
    p = await inSnapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent));
  // Public recordCollected is immutable/idempotent for an already linked source.
  // This negative deliberately changes the persisted ledger via its EXISTING
  // runtime UPDATE capability (grantGarminUnofficial), not owner authentication.
  await db.tenant(x.f.athlete, (tx) =>
    tx.query(
      'UPDATE public.garmin_activity_ledger SET collected_at=$2::timestamptz WHERE athlete_id=$1 AND garmin_activity_id=$3',
      [x.f.athlete, '2026-10-08T00:00:00Z', '987654321'],
    ),
  );
  await expect(inSnapshot(x.f.athlete, (tx) => store(tx, p))).rejects.toThrow(
    'MANUAL_CHAIN_SOURCE_USE_UNAVAILABLE',
  );
  const next = await inSnapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent));
  await x.activities.updateOverlay(x.f.athlete, x.current.id, {
    expectedRevision: x.current.revision,
    idempotencyKey: randomUUID(),
    reason: 'Synthetic overlay move',
    title: 'Later current',
  });
  // Exact current copied tuples are checked before aggregate semantic heads.
  await expect(inSnapshot(x.f.athlete, (tx) => store(tx, next))).rejects.toThrow(
    'MANUAL_CHAIN_SOURCE_UNAVAILABLE',
  );
  const foreign = await setup();
  await expect(inSnapshot(foreign.athlete, (tx) => store(tx, p))).rejects.toThrow(
    'MANUAL_CHAIN_STALE_BASIS',
  );
  expect(await counts(x.f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
it('callback failure rolls back evidence/decision/proposal/receipt before retry', async () => {
  const x = await collected();
  await expect(
    inSnapshot(x.f.athlete, async (tx) => {
      await store(tx, await prepared(tx, x.f.intent));
      throw Error('SYNTHETIC_ROLLBACK');
    }),
  ).rejects.toThrow('SYNTHETIC_ROLLBACK');
  expect(await counts(x.f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
  const p = await inSnapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent));
  expect(await inSnapshot(x.f.athlete, (tx) => store(tx, p))).toMatchObject({ applicable: false });
});

function gate() {
  let signal: () => void = () => {
    throw Error('GATE_UNINITIALIZED');
  };
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return { promise, signal };
}
async function ownLockWait() {
  const deadline = Date.now() + 2000;
  do {
    const rows = await admin.query(
      "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND wait_event_type='Lock'",
      [name, runtimeRole],
    );
    if (z.number().parse(rows.rows[0]?.['waiting']) > 0) return;
  } while (Date.now() < deadline);
  throw Error('OWN_LOCK_WAIT_NOT_OBSERVED');
}
type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  );
}
function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}
async function waitStarted<T>(started: ReturnType<typeof gate>, held: Promise<Outcome<T>>) {
  const first = await Promise.race([
    started.promise.then(() => ({ status: 'started' as const })),
    held,
  ]);
  if (first.status === 'rejected') throw first.reason;
  if (first.status === 'fulfilled') throw Error('TRANSACTION_ENDED_BEFORE_GATE');
}

it('public withdrawal-first transaction fences a waiting fresh store before latest admission', async () => {
  const x = await collected(),
    p = await inSnapshot(x.f.athlete, (tx) => prepared(tx, x.f.intent)),
    started = gate(),
    release = gate();
  const held = observe(
    inSnapshot(x.f.athlete, async (tx) => {
      const scoped: Database = {
        ...db,
        tenant: async (id, operation) => {
          if (id !== tx.athleteId) throw Error('FOREIGN_TRANSACTION');
          return operation(tx);
        },
      };
      await createConsentRepository(scoped).setConsent(x.f.athlete, {
        kind: 'app',
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      started.signal();
      await release.promise;
    }),
  );
  let writing: Promise<Outcome<z.infer<typeof resultSchema>>> | null = null;
  try {
    await waitStarted(started, held);
    writing = observe(inSnapshot(x.f.athlete, (tx) => store(tx, p)));
    await ownLockWait();
  } finally {
    release.signal();
    await held;
    if (writing !== null) await writing;
  }
  unwrap(await held);
  if (writing === null) throw Error('STORE_NOT_STARTED');
  expect((await writing).status).toBe('rejected');
  expect(await counts(x.f.athlete)).toEqual({ evidence: 0, decision: 0, proposal: 0 });
});
