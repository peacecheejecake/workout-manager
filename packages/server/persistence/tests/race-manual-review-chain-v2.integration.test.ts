import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import {
  storeRaceManualReviewChainV2In,
  createRaceManualReviewChainV2Repository,
} from '../src/race-manual-review-chain-v2.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createPlanningRepository } from '../src/planning.js';
import { planDraftSchema } from '@workout/contracts/planning';
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
const name = `chain_v2_${suffix}`,
  ownerRole = `chain_v2_owner_${suffix}`,
  runtimeRole = `chain_v2_app_${suffix}`;
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

// Prepared for Root execution only. Registry remains107;115/116 are explicit
// staging. Identity account seed is FK-only, all source bodies public producers.
async function prepared() {
  const f = await setup();
  const observation = await createRaceManualSemanticBasisV2Service(db).prepare(f.athlete, f.intent);
  if (observation.status !== 'current_dependencies_captured')
    throw Error('ACTUAL_BASIS_UNAVAILABLE');
  return {
    ...f,
    command: {
      schemaVersion: 2 as const,
      idempotencyKey: randomUUID(),
      intent: f.intent,
      expectedBasis: observation.basis,
    },
  };
}
const repository = () => createRaceManualReviewChainV2Repository(db);
it('stores actual public source Evidence→Decision→Proposal without applying a plan and reads exact retained payload', async () => {
  const f = await prepared(),
    stored = await repository().store(f.athlete, f.command);
  expect(stored.status).toBe('stored');
  if (stored.status !== 'stored') throw Error('CHAIN_NOT_STORED');
  expect(stored).toMatchObject({
    storage: 'persisted',
    authority: 'none',
    approvalAllowed: false,
    planApplied: false,
  });
  const read = await repository().read(f.athlete, stored.result.evidenceId);
  expect(read?.result).toEqual(stored.result);
  expect(read?.payload?.state).toBe('present');
  if (read?.payload?.state !== 'present') throw Error('RETAINED_PAYLOAD_MISSING');
  expect(read.payload.payload.preparation.context.event).toEqual(f.command.expectedBasis.event);
  if (read.payload.payload.preparation.candidate.status !== 'assembled_readonly')
    throw Error('CANDIDATE_REJECTED');
  expect(read.payload.payload.preparation.candidate.digest).toBe(stored.result.candidateDigest);
  expect(await createPlanningRepository(db).read(f.athlete)).toMatchObject({
    head: null,
    history: [],
  });
});
it('receipt-first successful replay survives app withdrawal; distinct fresh request remains blocked', async () => {
  const f = await prepared(),
    stored = await repository().store(f.athlete, f.command);
  if (stored.status !== 'stored') throw Error('CHAIN_NOT_STORED');
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const replay = await repository().store(f.athlete, {
    expectedBasis: f.command.expectedBasis,
    intent: f.command.intent,
    idempotencyKey: f.command.idempotencyKey,
    schemaVersion: 2,
  });
  expect(replay).toMatchObject({ status: 'replayed', result: stored.result });
  expect((await repository().read(f.athlete, stored.result.evidenceId))?.payload?.state).toBe(
    'present',
  );
  await expect(
    repository().store(f.athlete, { ...f.command, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
});
it('same idempotency key with different valid intent rejects rather than recapturing or minting another chain', async () => {
  const f = await prepared(),
    stored = await repository().store(f.athlete, f.command);
  if (stored.status !== 'stored') throw Error('CHAIN_NOT_STORED');
  await expect(
    repository().store(f.athlete, {
      ...f.command,
      intent: { ...f.intent, newLocalDate: '2026-10-09' },
    }),
  ).rejects.toMatchObject({ code: 'P0001' });
  expect((await repository().read(f.athlete, stored.result.evidenceId))?.result).toEqual(
    stored.result,
  );
});
it('absent training head becoming public plan is semantic stale and never stored', async () => {
  const f = await prepared();
  await createPlanningRepository(db).save(f.athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: draft(),
  });
  expect(await repository().store(f.athlete, f.command)).toMatchObject({
    status: 'blocked',
    storage: 'not_persisted',
    prepared: { reason: 'semantic_basis_changed' },
    approvalAllowed: false,
  });
});
it('unused provider/AI consent drift does not block manual-only source chain', async () => {
  const f = await prepared();
  for (const kind of ['provider', 'healthkit', 'media'] as const)
    await f.consent.setConsent(f.athlete, {
      kind,
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  await f.consent.setConsent(f.athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await repository().store(f.athlete, f.command)).toMatchObject({
    status: 'stored',
    approvalAllowed: false,
  });
});
it('populated foreign chain read returns null without copied body; foreign expectation cannot authorize store', async () => {
  const f = await prepared(),
    other = await prepared(),
    stored = await repository().store(f.athlete, f.command);
  if (stored.status !== 'stored') throw Error('CHAIN_NOT_STORED');
  expect(await repository().read(other.athlete, stored.result.evidenceId)).toBeNull();
  expect(
    await repository().store(other.athlete, {
      ...other.command,
      expectedBasis: f.command.expectedBasis,
    }),
  ).toMatchObject({ status: 'blocked', storage: 'not_persisted' });
});
it('source deletion purges retained body and preserves original minimal successful replay', async () => {
  const f = await prepared(),
    stored = await repository().store(f.athlete, f.command);
  if (stored.status !== 'stored') throw Error('CHAIN_NOT_STORED');
  await createRaceRepository(db).deleteRaceEvent(f.athlete, f.intent.expectedEvent.id, {
    expectedRevision: f.intent.expectedEvent.revision,
    idempotencyKey: randomUUID(),
  });
  expect(await repository().read(f.athlete, stored.result.evidenceId)).toEqual({
    schemaVersion: 2,
    result: stored.result,
    payload: null,
  });
  expect(await repository().store(f.athlete, f.command)).toMatchObject({
    status: 'replayed',
    result: stored.result,
  });
});

// Admin inspector is metadata-only; it is never a producer or permission bypass.
async function counts(athlete: string) {
  const inspector = new Pool({
    connectionString: (() => {
      const u = new URL(adminUrl);
      u.pathname = `/${name}`;
      return u.toString();
    })(),
  });
  try {
    const row = (
      await inspector.query(
        `SELECT
    (SELECT count(*)::int FROM manual_race_evidence_v2 WHERE athlete_id=$1) AS evidence,
    (SELECT count(*)::int FROM manual_race_decision_v2 WHERE athlete_id=$1) AS decision,
    (SELECT count(*)::int FROM manual_race_proposal_v2 WHERE athlete_id=$1) AS proposal,
    (SELECT count(*)::int FROM manual_race_chain_receipt_v2 WHERE athlete_id=$1) AS receipt,
    (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox`,
        [athlete],
      )
    ).rows[0];
    return z
      .strictObject({
        evidence: z.number().int(),
        decision: z.number().int(),
        proposal: z.number().int(),
        receipt: z.number().int(),
        outbox: z.number().int(),
      })
      .parse(row);
  } finally {
    await inspector.end();
  }
}
it('callback failure after actual SQL store rolls back every chain/receipt/outbox artifact', async () => {
  const f = await prepared(),
    before = await counts(f.athlete);
  await expect(
    inSnapshot(f.athlete, async (tx) => {
      const result = await storeRaceManualReviewChainV2In(tx, f.command, { bytes: 0n, sources: 0 });
      expect(result.status).toBe('stored');
      throw Error('SYNTHETIC_CALLBACK_ROLLBACK');
    }),
  ).rejects.toThrow('SYNTHETIC_CALLBACK_ROLLBACK');
  expect(await counts(f.athlete)).toEqual(before);
});
it('stale app revision and generation expectations leave chain/receipt/outbox untouched', async () => {
  const f = await prepared(),
    before = await counts(f.athlete);
  for (const expectedBasis of [
    { ...f.command.expectedBasis, restoreGeneration: randomUUID() },
    { ...f.command.expectedBasis, athleteId: randomUUID() },
  ])
    expect(
      await repository().store(f.athlete, {
        ...f.command,
        idempotencyKey: randomUUID(),
        expectedBasis,
      }),
    ).toMatchObject({ status: 'blocked', storage: 'not_persisted' });
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  const afterConsent = await counts(f.athlete);
  expect(await repository().store(f.athlete, f.command)).toMatchObject({
    status: 'blocked',
    storage: 'not_persisted',
  });
  expect(await counts(f.athlete)).toEqual(afterConsent);
  expect(afterConsent.evidence).toBe(before.evidence);
});
it('same tenant concurrent successful commands with the same key yield one immutable chain and one outbox', async () => {
  const f = await prepared(),
    before = await counts(f.athlete);
  const results = await Promise.all([
    repository().store(f.athlete, f.command),
    repository().store(f.athlete, f.command),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual(['replayed', 'stored']);
  if (
    results[0]?.status === 'blocked' ||
    results[1]?.status === 'blocked' ||
    !results[0] ||
    !results[1]
  )
    throw Error('CHAIN_BLOCKED');
  expect(results[0].result).toEqual(results[1].result);
  const after = await counts(f.athlete);
  expect(after).toEqual({
    evidence: before.evidence + 1,
    decision: before.decision + 1,
    proposal: before.proposal + 1,
    receipt: before.receipt + 1,
    outbox: before.outbox + 1,
  });
});

async function inSnapshot<T>(athlete: string, op: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return db.snapshotTenant(athlete, op);
}
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

it('public consumed historical text with AI false/include false stores manual chain then actual resource delete purges all copied payload', async () => {
  const f = await setup(),
    sources = await catalogFixture(f.athlete);
  expect(sources.resource.resource.includeForCoach).toBe(false);
  expect(await f.consent.getConsent(f.athlete, 'ai')).toMatchObject({ granted: false });
  const changed = await sources.resources.appendVersion(f.athlete, sources.resource.resource.id, {
    expectedCurrentVersionId: sources.resource.version.id,
    text: 'Unrelated current text head',
    idempotencyKey: randomUUID(),
  });
  if (changed.status !== 'available') throw Error('RESOURCE_HEAD_UNAVAILABLE');
  const observation = await createRaceManualSemanticBasisV2Service(db).prepare(f.athlete, f.intent);
  if (observation.status !== 'current_dependencies_captured') throw Error('BASIS_UNAVAILABLE');
  expect(observation.basis.consumedUses.facts).toContainEqual(
    expect.objectContaining({
      identity: {
        kind: 'resource-text-version',
        sourceId: sources.resource.resource.id,
        versionId: sources.resource.version.id,
      },
      use: 'own_retained_text',
    }),
  );
  const input = {
    schemaVersion: 2 as const,
    idempotencyKey: randomUUID(),
    intent: f.intent,
    expectedBasis: observation.basis,
  };
  const stored = await repository().store(f.athlete, input);
  if (stored.status !== 'stored') throw Error('CHAIN_NOT_STORED');
  await sources.resources.softDelete(f.athlete, sources.resource.resource.id, {
    expectedAccessRevision: changed.resource.accessRevision,
    expectedCurrentVersionId: changed.version.id,
    idempotencyKey: randomUUID(),
  });
  expect((await repository().read(f.athlete, stored.result.evidenceId))?.payload).toBeNull();
  expect(await repository().store(f.athlete, input)).toMatchObject({
    status: 'replayed',
    result: stored.result,
  });
});
it('two actual runtime connections fence store versus public source erasure and never retain a resurrected payload', async () => {
  const f = await prepared();
  let release: () => void = () => {
    throw Error('BARRIER_NOT_SET');
  };
  let reportStored: (value: string) => void = () => {
    throw Error('BARRIER_NOT_SET');
  };
  const canCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failStored: (reason: unknown) => void = () => {
    throw Error('BARRIER_NOT_SET');
  };
  const storedId = new Promise<string>((resolve, reject) => {
    reportStored = resolve;
    failStored = reject;
  });
  const writing = inSnapshot(f.athlete, async (tx) => {
    const r = await storeRaceManualReviewChainV2In(tx, f.command, { bytes: 0n, sources: 0 });
    if (r.status !== 'stored') throw Error('CHAIN_NOT_STORED');
    reportStored(r.result.evidenceId);
    await canCommit;
    return r;
  });
  void writing.catch(failStored);
  const id = await storedId;
  const deleting = createRaceRepository(db).deleteRaceEvent(f.athlete, f.intent.expectedEvent.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  try {
    // DB-side wait observation, never a timer treated as ordering evidence.
    await expect
      .poll(
        async () =>
          z
            .number()
            .int()
            .parse(
              (
                await admin.query(
                  "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND pid<>pg_backend_pid()",
                  [name],
                )
              ).rows[0]?.['waiting'],
            ),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
  } finally {
    release();
  }
  await writing;
  await deleting;
  expect((await repository().read(f.athlete, id))?.payload).toBeNull();
});

it('strict public command rejects caller candidate/ref/permission authority before opening a processing snapshot', async () => {
  const f = await prepared(),
    before = await counts(f.athlete);
  for (const extra of [
    { candidate: {} },
    { refs: [] },
    { approved: true },
    { athleteId: f.athlete },
  ])
    await expect(repository().store(f.athlete, { ...f.command, ...extra })).rejects.toThrow();
  expect(await counts(f.athlete)).toEqual(before);
});
