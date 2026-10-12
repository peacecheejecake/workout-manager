import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import type { PlanDraft } from '@workout/contracts/planning';
import {
  parseAccountExportIncludingV40,
  parseAccountExportV39,
  parseAccountExportV40,
} from '@workout/contracts/operations';
import { createDatabase, type Database } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createAiSettingsRepository } from '../src/ai-settings.js';
import {
  cancelRestoredAiExecutionJobIn,
  createAiExecutionJobRepository,
} from '../src/ai-execution-jobs.js';
import { createGalleryAlbumCommandRepository } from '../src/gallery-album-commands.js';
import {
  createOperationsV39PooledRepository,
  createOperationsV40PooledRepository,
} from '../src/operations.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  grantGalleryNavigationRuntimeForTest,
  grantProfile26Runtime,
  installProfile26WithGalleryMembers,
} from './gallery-profile27-fixture.js';

// Real PostgreSQL 17: committed profile26 (V10 installer + app core + V10 runtime grants),
// raw SQL143/144/145 (gallery fixture) and raw SQL148 applied by the plain owner, with
// test-local grants standing in for the profile27 (V11) roster another lane owns. This is
// not a profile27 install, catalog witness or source proof. All data is synthetic; no
// provider request, budget hold or dispatch happens.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `operations_v40_${suffix}`;
const ownerRole = `operations_v40_owner_${suffix}`;
const runtimeRole = `operations_v40_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 2 });
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
const inspectorUrl = new URL(adminUrl);
inspectorUrl.pathname = `/${dbName}`;
let owner: Pool, inspector: Pool, database: Database;
let created = false;
const policy = { id: 'running-core-v2-training', version: '1' };
const sol = { providerId: 'openai', modelId: 'gpt-6.1-sol' };
const catalogRevision = 1;
const settings = {
  revision: 1,
  catalogRevision,
  policyVersion: 'p27e-policy:1',
  disclosureVersion: 'p27e-disclosure:1',
};
const registry = [
  {
    selection: sol,
    purpose: 'coaching',
    adapterBindingVersion: 'synthetic:adapter:1',
    vendorModelRef: `synthetic:${sol.modelId}`,
    priceModelRef: sol.modelId,
    priceVersion: 'synthetic:price:1',
    tokenizerVersion: 'synthetic:tokenizer:1',
  },
];
const catalog = {
  schemaVersion: 1,
  catalogRevision,
  policyVersion: settings.policyVersion,
  disclosureVersion: settings.disclosureVersion,
  approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
  providers: [
    {
      providerId: 'openai',
      displayName: 'Synthetic OpenAI',
      selectable: true,
      availability: { kind: 'available' },
      recipient: {
        recipientId: 'openai',
        displayName: 'Synthetic recipient',
        disclosureVersion: settings.disclosureVersion,
      },
      models: [
        {
          modelId: sol.modelId,
          displayName: 'Synthetic Sol',
          selectable: true,
          availability: { kind: 'available' },
          purposes: ['coaching'],
        },
      ],
    },
  ],
  recommendedDefault: null,
  recommendedSyntheticComparison: { kind: 'off' },
};

async function ownerTransaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  created = true;
  await migrate(url(ownerRole), 107);
  await installProfile26WithGalleryMembers(url(ownerRole));
  await grantProfile26Runtime(url(ownerRole), runtimeRole);
  await grantGalleryNavigationRuntimeForTest(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole), max: 2 });
  inspector = new Pool({ connectionString: inspectorUrl.toString(), max: 2 });
  const sql = await readFile(
    new URL('../migrations/148_ai_execution_job_store.sql', import.meta.url),
    'utf8',
  );
  await ownerTransaction(async (client) => {
    await client.query(sql);
    await client.query(`GRANT SELECT,INSERT ON public.ai_execution_job TO "${runtimeRole}"`);
    await client.query(
      `GRANT SELECT ON public.ai_synthetic_evidence_attestation TO "${runtimeRole}"`,
    );
    await client.query(
      `GRANT SELECT,INSERT ON public.ai_execution_job_disposition TO "${runtimeRole}"`,
    );
  });
  await ownerTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))",
    );
    await client.query(
      "INSERT INTO ai_settings_catalog_definition VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))",
      [catalogRevision, JSON.stringify(catalog)],
    );
    await client.query('INSERT INTO ai_settings_catalog_head VALUES(true,$1)', [catalogRevision]);
  });
  database = createDatabase({ connectionString: url(runtimeRole), max: 6 });
}, 300000);
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await inspector?.end();
  if (created) await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
}, 60000);

async function scenario() {
  const athleteId = randomUUID();
  // Identity-only prerequisite of the retained readers (not source authority).
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athleteId, 'https://issuer.invalid', randomUUID()],
  );
  const consent = createConsentRepository(database);
  await consent.setConsent(athleteId, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const draft: PlanDraft = {
    title: 'Training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
  const plan = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: plan.id,
      title: 'Synthetic question',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic note',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  await consent.setConsent(athleteId, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    thread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  await createAiSettingsRepository(database).write(athleteId, {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    catalogRevision,
    policyVersion: settings.policyVersion,
    disclosureVersion: settings.disclosureVersion,
    defaultSelection: sol,
    syntheticComparison: { kind: 'off' },
  });
  const jobs = createAiExecutionJobRepository(database, { policy, registry });
  const createJob = () =>
    jobs.create(athleteId, thread.id, {
      commandVersion: 1,
      evidenceSnapshotId: evidence.id,
      expectedConversationRevision: 1,
      purpose: 'coaching',
      settings,
      idempotencyKey: randomUUID(),
    });
  return { athleteId, thread, evidence, createJob };
}

/** Owner-seeded synthetic media rows (no bytes); SQL144 enqueues rendition jobs. */
async function seedMedia(athleteId: string, count: number) {
  return ownerTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,77206))', [
      athleteId,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athleteId]);
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      ids.push(id);
      await client.query(
        `INSERT INTO public.gallery_media_item
         (athlete_id,id,media_kind,storage_ref,original_filename,media_type,size_bytes,content_hash,
          access_revision,created_at,updated_at)
         VALUES($1,$2,'image',$3,'synthetic.png','image/png',1,$4,1,$5,$5)`,
        [
          athleteId,
          id,
          `synthetic-gallery-${athleteId}-${id}`,
          'c'.repeat(64),
          `2026-10-09T00:00:00.00000${index + 1}Z`,
        ],
      );
    }
    return ids;
  });
}

async function rows(athleteId: string) {
  const result = await inspector.query(
    `SELECT
      (SELECT count(*)::int FROM ai_execution_job WHERE athlete_id=$1) AS jobs,
      (SELECT count(*)::int FROM ai_execution_job_disposition WHERE athlete_id=$1) AS dispositions,
      (SELECT count(*)::int FROM coaching_run WHERE athlete_id=$1) AS runs,
      (SELECT count(*)::int FROM gallery_album WHERE athlete_id=$1) AS albums,
      (SELECT count(*)::int FROM gallery_album_deletion WHERE athlete_id=$1) AS album_deletions,
      (SELECT count(*)::int FROM gallery_media_album_membership WHERE athlete_id=$1) AS memberships,
      (SELECT count(*)::int FROM gallery_media_course_association WHERE athlete_id=$1) AS course_links,
      (SELECT count(*)::int FROM gallery_navigation_command_receipt WHERE athlete_id=$1) AS navigation_receipts,
      (SELECT count(*)::int FROM gallery_media_item WHERE athlete_id=$1) AS media,
      (SELECT count(*)::int FROM gallery_rendition_job WHERE athlete_id=$1) AS rendition_jobs,
      (SELECT count(*)::int FROM gallery_rendition_due WHERE athlete_id=$1) AS rendition_due,
      (SELECT count(*)::int FROM gallery_rendition_sweep WHERE athlete_id=$1 AND cause<>'account_erased') AS live_sweeps,
      (SELECT count(*)::int FROM gallery_rendition_sweep WHERE athlete_id=$1 AND cause='account_erased') AS erased_sweeps,
      (SELECT count(*)::int FROM restore_gallery_album_replay_receipt WHERE athlete_id=$1) AS album_replay_receipts,
      (SELECT count(*)::int FROM restore_suppression_event WHERE athlete_id=$1 AND kind='gallery_album_deleted') AS album_events,
      EXISTS(SELECT 1 FROM tenant_erasure WHERE athlete_id=$1) AS erased`,
    [athleteId],
  );
  return result.rows[0] as Record<string, number | boolean>;
}

let shared: Awaited<ReturnType<typeof scenario>> & {
  jobIds: string[];
  media: string[];
  album: string;
  removed: string;
};

it('V40 pooled export carries AI jobs and the V39 gallery section in one snapshot, never renditions', async () => {
  const s = await scenario();
  const first = await s.createJob();
  const second = await s.createJob();
  const media = await seedMedia(s.athleteId, 2);
  const [mediaId, other] = media;
  if (!mediaId || !other) throw new Error('seed');
  const albums = createGalleryAlbumCommandRepository(database);
  const album = (await albums.createAlbum(s.athleteId, { title: '합성 앨범' }, randomUUID())) as {
    id: string;
  };
  const removed = (await albums.createAlbum(s.athleteId, { title: '삭제' }, randomUUID())) as {
    id: string;
  };
  await albums.deleteAlbum(s.athleteId, { albumId: removed.id, expectedRevision: 1 }, randomUUID());
  await albums.updateMembership(
    s.athleteId,
    {
      mediaItemId: mediaId,
      expectedAccessRevision: 1,
      albumMembership: { albumId: album.id },
      courseLink: null,
    },
    randomUUID(),
  );
  const before = await rows(s.athleteId);
  // Renditions exist in storage (SQL144 enqueue) so their absence below is meaningful.
  expect(before['rendition_jobs']).toBeGreaterThan(0);
  const renditionKeys = (
    await inspector.query(
      'SELECT job_id::text AS id,idempotency_key AS key FROM gallery_rendition_job WHERE athlete_id=$1',
      [s.athleteId],
    )
  ).rows as { id: string; key: string }[];

  const exported = await createOperationsV40PooledRepository(database).exportAccount(s.athleteId);
  expect(exported.schemaVersion).toBe(40);
  expect(parseAccountExportV40(exported)).toEqual(exported);
  expect(parseAccountExportIncludingV40(JSON.parse(JSON.stringify(exported)))).toEqual(exported);
  // AI execution jobs: exact frozen facts, deterministic order, null disposition.
  expect(exported.data.aiExecutionJobs).toMatchObject({
    schemaVersion: 1,
    kind: 'ai_execution_jobs',
  });
  expect(exported.data.aiExecutionJobs.items.map((item) => item.jobId)).toEqual([
    first.jobId,
    second.jobId,
  ]);
  expect(exported.data.aiExecutionJobs.items[0]).toMatchObject({
    runId: first.runId,
    threadId: s.thread.id,
    evidenceSnapshotId: s.evidence.id,
    selection: sol,
    selectionDigest: first.selectionDigest,
    consentRevisions: { app: 1, ai: 1 },
    disposition: null,
  });
  const runIds = exported.data.coachingRuns.map((row) => row['id']);
  expect(runIds).toEqual(expect.arrayContaining([first.runId, second.runId]));
  // Gallery 143 section (already part of V39) is present and exact.
  expect(exported.data.galleryAlbums.map((row) => row.id)).toEqual([album.id]);
  expect(exported.data.galleryAlbumMemberships).toEqual([
    { mediaItemId: mediaId, albumId: album.id },
  ]);
  expect(exported.data.galleryAlbumDeletions.map((row) => row.albumId)).toEqual([removed.id]);
  expect(exported.data.galleryCourseAssociations).toEqual([]);
  expect(exported.data.galleryMediaItems.map((row) => row['id']).sort()).toEqual([...media].sort());
  // Renditions (SQL144) are excluded (user decision U1).
  const text = JSON.stringify(exported);
  expect(Object.keys(exported.data).filter((key) => /rendition/i.test(key))).toEqual([]);
  for (const forbidden of [
    'gallery-rendition:',
    '/renditions/',
    'image_preview',
    'image_thumbnail',
    'video_playback',
    'receipt_key',
    'ai-execution:run:v1:',
    'request_digest',
    'restore_generation',
    ...renditionKeys.flatMap((row) => [row.id, row.key]),
  ])
    expect(text).not.toContain(forbidden);
  // The V39 repository is unchanged: same gallery section, no AI job section.
  const v39 = await createOperationsV39PooledRepository(database).exportAccount(s.athleteId);
  expect(parseAccountExportV39(v39).schemaVersion).toBe(39);
  expect(v39.data).not.toHaveProperty('aiExecutionJobs');
  expect(v39.data.galleryAlbums).toEqual(exported.data.galleryAlbums);
  shared = {
    ...s,
    jobIds: [first.jobId, second.jobId],
    media,
    album: album.id,
    removed: removed.id,
  };
}, 60000);

it('V40 export carries an append-only restore_cancelled disposition', async () => {
  const control = async (sql: string, args: unknown[] = []) =>
    (await owner.query(sql, args)).rows[0] as Record<string, unknown> | undefined;
  const revision = async () =>
    Number(
      (
        (await control('SELECT public.read_restore_processing_admission() AS c'))?.['c'] as {
          localRevision: number;
        }
      ).localRevision,
    );
  await control('SELECT public.rotate_restore_generation()');
  await control('SELECT public.close_restore_processing_exact($1,$2)', [
    await revision(),
    randomUUID(),
  ]);
  const [cancelled] = shared.jobIds;
  if (!cancelled) throw new Error('fixture');
  expect(
    await database.tenant(shared.athleteId, (tx) => cancelRestoredAiExecutionJobIn(tx, cancelled)),
  ).toMatchObject({ kind: 'restore_cancelled' });
  const exported = await createOperationsV40PooledRepository(database).exportAccount(
    shared.athleteId,
  );
  const items = exported.data.aiExecutionJobs.items;
  expect(items.find((item) => item.jobId === cancelled)?.disposition).toMatchObject({
    kind: 'restore_cancelled',
  });
  expect(items.filter((item) => item.disposition === null)).toHaveLength(1);
  expect(parseAccountExportV40(exported)).toEqual(exported);
}, 60000);

it('tenant isolation: another account exports an empty AI job section and no gallery rows', async () => {
  const other = await scenario();
  const exported = await createOperationsV40PooledRepository(database).exportAccount(
    other.athleteId,
  );
  expect(exported.data.aiExecutionJobs.items).toEqual([]);
  expect(exported.data.galleryAlbums).toEqual([]);
  const text = JSON.stringify(exported);
  for (const id of [...shared.jobIds, shared.album, shared.removed, ...shared.media])
    expect(text).not.toContain(id);
}, 60000);

it('V40 erasure removes SQL148 jobs/dispositions, SQL143 rows and SQL144 jobs with the account', async () => {
  const before = await rows(shared.athleteId);
  expect(before).toMatchObject({
    jobs: 2,
    dispositions: 1,
    albums: 2,
    album_deletions: 1,
    memberships: 1,
    media: 2,
    erased: false,
  });
  expect(before['navigation_receipts']).toBeGreaterThan(0);
  expect(before['rendition_jobs']).toBeGreaterThan(0);
  expect(
    await createOperationsV40PooledRepository(database).eraseAccount(shared.athleteId),
  ).toEqual({ erased: true });
  const after = await rows(shared.athleteId);
  expect(after).toMatchObject({
    jobs: 0,
    dispositions: 0,
    runs: 0,
    albums: 0,
    album_deletions: 0,
    memberships: 0,
    course_links: 0,
    navigation_receipts: 0,
    media: 0,
    rendition_jobs: 0,
    rendition_due: 0,
    live_sweeps: 0,
    erased: true,
  });
  // SQL144 retires every erased item's stored keys through a delayed storage sweep
  // (no user content, removed once the sweep completes).
  expect(after['erased_sweeps']).toBe(2);
  // SQL145 album-deletion suppression fact is designed to survive erasure (066/070 pattern:
  // no FK, ids/revision/time only, no title) so a restore cannot resurrect the album. This
  // fixture made no owner replay, so no SQL145 replay receipt exists.
  expect(after).toMatchObject({ album_events: 1, album_replay_receipts: 0 });
  const fact = await inspector.query(
    `SELECT to_jsonb(e) AS row FROM restore_suppression_event e
     WHERE athlete_id=$1 AND kind='gallery_album_deleted'`,
    [shared.athleteId],
  );
  expect(JSON.stringify(fact.rows)).not.toContain('삭제');
  expect(fact.rows[0]?.['row']).toMatchObject({ target_id: shared.removed, record_version: 8 });
  await expect(
    createOperationsV40PooledRepository(database).exportAccount(shared.athleteId),
  ).rejects.toThrow();
}, 60000);
