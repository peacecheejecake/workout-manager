import { captureRaceManualMediaPurposeV2In } from '../src/race-manual-review-media-purpose-v2.js';
import { prepareRaceManualConsumedUseV2In } from '../src/race-manual-review-consumed-use-v2.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import { createRaceRepository } from '../src/races.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createSupplementaryRepository } from '../src/supplementary-core.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { createPlanningRepository } from '../src/planning.js';
import { routineBlueprintVersionSchema } from '@workout/contracts/routines';
import { planDraftSchema } from '@workout/contracts/planning';
import type { galleryMediaItemSchema } from '@workout/contracts/gallery';
import {
  grantSupplementaryCore,
  grantRoutineCore,
  grantRecoveryCore,
  grantCheckIns,
  grantCourses,
  grantNutritionCore,
  grantResources,
  grantResourceRetrieval,
  grantRaces,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate, grantOperations, grantGalleryMedia, grantCorePlanning } from '../src/migrate.js';
import { createGalleryMediaRepository } from '../src/gallery-media.js';
import { createConsentRepository } from '../src/repositories.js';
import { captureMediaRetainedReadFacts } from '../src/race-plan-impact-media-read-facts.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// DB metadata acceptance only: no provider/object-store upload or deletion ran.
// Public107 plus explicit unregistered113; registry/retarget/fullprivacy is separate.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `media_purpose_${suffix}`,
  ownerRole = `media_purpose_owner_${suffix}`,
  runtimeRole = `media_purpose_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 }),
  roles: string[] = [];
let without113: Awaited<ReturnType<typeof captureRaceManualMediaPurposeV2In>>;
let db: Database,
  owner: Pool,
  created = false;
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
  owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  const state = await owner.query('SELECT max(version)::int AS version FROM schema_migrations');
  expect(state.rows[0]?.['version']).toBe(107);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
  const initialAthlete = await tenant();
  const initialMedia = await image(initialAthlete);
  without113 = await purpose(initialAthlete, initialMedia.item);
  await owner.query(
    await readFile(
      new URL('../migrations/113_race_media_cleanup_source.sql', import.meta.url),
      'utf8',
    ),
  );
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await owner.query(
    `GRANT EXECUTE ON FUNCTION public.read_race_media_cleanup(uuid,integer) TO "${runtimeRole}"`,
  );
  await grantOperations(url(ownerRole), runtimeRole);
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  await owner.query(
    await readFile(
      new URL('../migrations/115_manual_review_full_owned_source_bindings_v2.sql', import.meta.url),
      'utf8',
    ),
  );
  await owner.query(
    `GRANT EXECUTE ON FUNCTION public.observe_manual_review_full_owned_source_bindings_v2(jsonb) TO "${runtimeRole}"`,
  );
  for (const grant of [
    grantSupplementaryCore,
    grantRoutineCore,
    grantRecoveryCore,
    grantCheckIns,
    grantCourses,
    grantNutritionCore,
    grantResources,
    grantResourceRetrieval,
    grantRaces,
    grantGarminUnofficial,
  ])
    await grant(url(ownerRole), runtimeRole);
});
afterAll(async () => {
  await db?.close();
  await owner?.end();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
async function tenant(mediaGrant = true) {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  // Named synthetic purpose grant; no implicit account admission or AI/media consent.
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  for (const kind of ['media', 'ai'] as const) {
    if (kind === 'media' && !mediaGrant) continue;
    await createConsentRepository(db).setConsent(athlete, {
      kind,
      granted: kind === 'media',
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  }
  return athlete;
}
function key(athlete: string, media: string, upload: string, hash: string, extension: string) {
  return `private/v1/tenants/${athlete}/gallery/${media}/objects/uploads/${upload}/sha256/${hash}.${extension}`;
}
async function image(athlete: string) {
  const gallery = createGalleryMediaRepository(db),
    hash = 'a'.repeat(64);
  const reservation = await gallery.reserveCreate(
    athlete,
    {
      mediaKind: 'image',
      album: null,
      caption: 'Synthetic metadata',
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
    },
    `media-${randomUUID()}`,
  );
  const storageRef = key(athlete, reservation.mediaItemId, reservation.uploadId, hash, 'png');
  await gallery.prepareObject(athlete, reservation.uploadId, {
    storageRef,
    file: { originalFileName: 'synthetic.png', mediaType: 'image/png', byteSize: 2, sha256: hash },
  });
  await gallery.markStaged(athlete, reservation.uploadId);
  const stored = await gallery.finalize(athlete, reservation.uploadId);
  if (stored.status !== 'available') throw Error('synthetic media unavailable');
  return { gallery, item: stored.item, storageRef };
}
async function preview(athlete: string, media: string, revision: number) {
  const gallery = createGalleryMediaRepository(db),
    hash = 'b'.repeat(64);
  const reservation = await gallery.reservePreview(
    athlete,
    media,
    { expectedAccessRevision: revision },
    `preview-${randomUUID()}`,
  );
  const storageRef = key(athlete, media, reservation.uploadId, hash, 'jpg');
  await gallery.prepareObject(athlete, reservation.uploadId, {
    storageRef,
    file: {
      originalFileName: 'synthetic-preview.jpg',
      mediaType: 'image/jpeg',
      byteSize: 2,
      sha256: hash,
    },
  });
  await gallery.markStaged(athlete, reservation.uploadId);
  await gallery.finalize(athlete, reservation.uploadId);
  return storageRef;
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
async function snapshot<T>(athlete: string, op: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return db.snapshotTenant(athlete, op);
}
async function purpose(athlete: string, item: ReturnType<typeof galleryMediaItemSchema.parse>) {
  return snapshot(athlete, async (tx) => {
    const budget = { bytes: 0n, sources: 0 };
    const fact = (await captureMediaRetainedReadFacts(tx, [item.id], budget)).facts[0];
    return captureRaceManualMediaPurposeV2In(
      tx,
      {
        mediaItemId: item.id,
        expectedAccessRevision: item.accessRevision,
        expectedDescriptorDigest: impactDependencyDigest(item),
        expectedObjectIdentityDigest: fact?.originalObjectIdentityDigest ?? '0'.repeat(64),
      },
      budget,
    );
  });
}
async function intent(athlete: string) {
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic media purpose',
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
  return {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-08',
    selection: { kind: 'keep_plan' as const },
  };
}

it('normal107 denies unavailable113 capability without claiming stored media admission', () => {
  expect(without113).toMatchObject({
    status: 'blocked',
    reason: 'media_cleanup_capability_unavailable',
    observation: null,
    authority: 'none',
  });
});
it('staged113 public finalized original+preview yields actual purpose through preparation and semantic projection with AI=false', async () => {
  const athlete = await tenant(),
    stored = await image(athlete);
  await preview(athlete, stored.item.id, 1);
  const read = await stored.gallery.read(athlete, stored.item.id);
  if (read.status !== 'available') throw Error('MEDIA_UNAVAILABLE');
  const direct = await purpose(athlete, read.item);
  expect(direct).toMatchObject({
    status: 'observed_media_use',
    observation: {
      mediaConsent: { kind: 'media', granted: true, revision: 1 },
      accessRevision: 2,
      cleanup: { state: 'absent', refs: expect.any(Array) },
    },
    sourceAuthentication: 'unverified',
  });
  await catalogFixture(athlete, db, [stored.item.id]);
  const command = await intent(athlete);
  const prepared = await snapshot(athlete, (tx) =>
    prepareRaceManualConsumedUseV2In(tx, command, { bytes: 0n, sources: 0 }),
  );
  expect(prepared.status).toBe('observed_manual_use');
  if (prepared.status !== 'observed_manual_use') throw Error('PUBLIC_MEDIA_PREPARATION_BLOCKED');
  expect(prepared.uses.facts.find((f) => f.identity.kind === 'gallery-descriptor')).toMatchObject({
    reason: null,
    use: 'core_manual',
    sourcePurpose: { kind: 'own_media_descriptor', accessRevision: 2 },
    sourceAuthentication: 'unverified',
  });
  const semantic = await snapshot(athlete, (tx) =>
    prepareRaceManualSemanticBasisV2In(tx, command, null, { bytes: 0n, sources: 0 }),
  );
  expect(semantic.status).toBe('current_dependencies_captured');
  if (semantic.status !== 'current_dependencies_captured')
    throw Error('PUBLIC_MEDIA_SEMANTIC_BLOCKED');
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'ai',
    granted: true,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const unusedAI = await snapshot(athlete, (tx) =>
    prepareRaceManualSemanticBasisV2In(tx, command, semantic.basis, { bytes: 0n, sources: 0 }),
  );
  expect(unusedAI.status).toBe('current_dependencies_captured');
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'media',
    granted: true,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const mediaDrift = await snapshot(athlete, (tx) =>
    prepareRaceManualSemanticBasisV2In(tx, command, semantic.basis, { bytes: 0n, sources: 0 }),
  );
  expect(mediaDrift).toMatchObject({
    status: 'blocked',
    reason: 'semantic_basis_changed',
    authority: 'none',
    approvalAllowed: false,
  });
});
it('actual absent/withdrawn media grant blocks while gallery read remains available', async () => {
  const athlete = await tenant(),
    stored = await image(athlete),
    consents = createConsentRepository(db);
  await consents.setConsent(athlete, {
    kind: 'media',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  expect(await purpose(athlete, stored.item)).toMatchObject({ reason: 'media_consent_required' });
  expect((await stored.gallery.read(athlete, stored.item.id)).status).toBe('available');
  await consents.setConsent(athlete, {
    kind: 'media',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(await purpose(athlete, stored.item)).toMatchObject({
    status: 'observed_media_use',
    observation: { mediaConsent: { revision: 3 } },
  });
});
it('foreign/stale/deleted current descriptors cannot be admitted by expected hashes', async () => {
  const athlete = await tenant(),
    foreign = await tenant(),
    stored = await image(athlete);
  expect(await purpose(foreign, stored.item)).toMatchObject({ reason: 'media_source_unavailable' });
  await preview(athlete, stored.item.id, 1);
  expect(await purpose(athlete, stored.item)).toMatchObject({
    reason: 'media_source_tuple_mismatch',
  });
  await stored.gallery.softDelete(athlete, stored.item.id, {
    expectedAccessRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(await purpose(athlete, stored.item)).toMatchObject({ reason: 'media_source_deleted' });
});

it('public app-only gallery owner without individual media grant cannot obtain manual processing observation', async () => {
  const athlete = await tenant(false),
    stored = await image(athlete);
  expect((await stored.gallery.read(athlete, stored.item.id)).status).toBe('available');
  expect(await purpose(athlete, stored.item)).toMatchObject({
    status: 'blocked',
    reason: 'media_consent_required',
    observation: null,
  });
});
