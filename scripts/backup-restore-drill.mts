import {
  captureConstraintRestoreLedger,
  parseConstraintRestoreLedger,
  restoreConstraintLedger,
} from './coaching-constraint-restore.mjs';
import { createCoachingConstraintRepository } from '../packages/server/persistence/src/coaching-constraints.js';
import { createCoreEvidenceSnapshotRepository } from '../packages/server/persistence/src/evidence-snapshots.js';
import type {
  CoreEvidenceCapture,
  CoreEvidenceSnapshot,
} from '../packages/contracts/src/evidence-snapshots.js';
import { createCoachingThreadRepository } from '../packages/server/persistence/src/coaching-threads.js';
import { createCoachingRunRepository } from '../packages/server/persistence/src/coaching-runs.js';
import { createPlanScenarioRepository } from '../packages/server/persistence/src/plan-scenarios.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  createDatabase,
  TenantErasedError,
  type Database,
} from '../packages/server/persistence/src/database.js';
import {
  migrate,
  grantOperations,
  grantGarmin,
  grantCheckIns,
  grantSessionCompletions,
  grantPlanScenarios,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantCoachingConstraints,
  grantCoachingRuns,
  grantCoachingCandidates,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantActivityTracks,
  grantCourses,
  grantCourseThumbnailWorker,
} from '../packages/server/persistence/src/migrate.js';
import { createGarminStore } from '../packages/server/persistence/src/garmin.js';
import { createConsentRepository } from '../packages/server/persistence/src/repositories.js';
import { createActivityRepository } from '../packages/server/persistence/src/activities.js';
import { createCheckInRepository } from '../packages/server/persistence/src/check-ins.js';
import { createOperationsRepository } from '../packages/server/persistence/src/operations.js';
import { createPrivateTextResourceRepository } from '../packages/server/persistence/src/resources.js';
import { createResourceAccessRepository } from '../packages/server/persistence/src/resource-access.js';
import {
  createResourceRetrievalRepository,
  prepareRunGrounding,
  recordRunCitations,
  writeRunGrounding,
} from '../packages/server/persistence/src/resource-retrieval.js';
import {
  createResourceDerivedCleanupRepository,
  createResourceDerivedStorePurge,
  processOneResourceDerivedCleanup,
} from '../packages/server/persistence/src/resource-derived-cleanup.js';
import { createGalleryMediaRepository } from '../packages/server/persistence/src/gallery-media.js';
import {
  createResourceObjectCleanupRepository,
  processOneResourceObjectCleanup,
} from '../packages/server/persistence/src/resource-object-cleanup.js';
import { createActivityTrackRepository } from '../packages/server/persistence/src/activity-tracks.js';
import {
  courseGeometrySha256,
  createCourseRepository,
} from '../packages/server/persistence/src/courses.ts';
import { createCoursePreferenceRepository } from '../packages/server/persistence/src/course-preferences.ts';
import {
  createCourseThumbnailWorkerRepository,
  type CourseThumbnailLease,
} from '../packages/server/persistence/src/course-thumbnails.ts';
import { renderCourseThumbnail } from '../packages/server/courses/src/thumbnail.ts';
import { createResourceFileUploadRepository } from '../packages/server/persistence/src/resource-file-uploads.js';
import {
  createResourceUrlIngestionRepository,
  createResourceUrlIngestionWorkerRepository,
} from '../packages/server/persistence/src/resource-url-ingestions.js';
import { createLocalFilesystemObjectStorage } from '../packages/server/media/src/local-filesystem.js';
import {
  createActivityTrackFinalObjectKey,
  createActivityTrackTemporaryObjectKey,
  createCourseThumbnailFinalObjectKey,
  createCourseThumbnailTemporaryObjectKey,
  createGalleryFinalObjectKey,
  createUrlFinalObjectKey,
  createUrlTemporaryObjectKey,
  validateObjectKey,
} from '../packages/server/media/src/keys.js';
import { storeValidatedUpload } from '../packages/server/media/src/upload.js';
import { createPlanningRepository } from '../packages/server/persistence/src/planning.js';
import {
  createSessionCompletionRepository,
  SessionCompletionError,
} from '../packages/server/persistence/src/session-completions.js';
import { planDraftSchema } from '../packages/contracts/src/planning.js';
import { accountExportSchema } from '../packages/contracts/src/operations.js';
import type { SessionCompletionCommand } from '../packages/contracts/src/session-completion.js';

// Separate current revocation facts, never a copy of private snapshot bodies or messages.
// Keep this script independent of a root Zod dependency; validate unknown JSON strictly here.
function parseEvidenceWithdrawalLedger(value: unknown, backupAiOwners: readonly string[]) {
  const record = (input: unknown, keys: string[]): Record<string, unknown> => {
    assert.ok(typeof input === 'object' && input !== null && !Array.isArray(input));
    assert.deepEqual(Object.keys(input).sort(), [...keys].sort());
    return Object.fromEntries(Object.entries(input));
  };
  const uuid = (input: unknown) => {
    assert.ok(
      typeof input === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input),
    );
    return input;
  };
  const ledger = record(value, [
    'schemaVersion',
    'capturedAt',
    'subjects',
    'snapshots',
    'consents',
  ]);
  assert.equal(ledger['schemaVersion'], 2);
  const capturedAt = ledger['capturedAt'];
  assert.ok(
    typeof capturedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt) &&
      Number.isFinite(Date.parse(capturedAt)) &&
      new Date(capturedAt).toISOString() === capturedAt,
  );
  const subjectRows: unknown = ledger['subjects'];
  assert.ok(Array.isArray(subjectRows) && subjectRows.length <= 1000);
  const subjects = subjectRows.map(uuid);
  assert.equal(new Set(subjects).size, subjects.length);
  for (const owner of backupAiOwners) assert.ok(subjects.includes(uuid(owner)));
  const snapshotRows: unknown = ledger['snapshots'];
  const consentRows: unknown = ledger['consents'];
  assert.ok(Array.isArray(snapshotRows) && snapshotRows.length <= 1000);
  assert.ok(Array.isArray(consentRows) && consentRows.length <= 1000);
  const snapshots = snapshotRows.map((input: unknown) => {
    const row = record(input, ['athlete_id', 'id', 'purged_reason']);
    const reason: unknown = row['purged_reason'];
    assert.ok(reason === 'source_deleted' || reason === 'consent_withdrawn');
    return { athlete_id: uuid(row['athlete_id']), id: uuid(row['id']), purged_reason: reason };
  });
  const consents = consentRows.map((input: unknown) => {
    const row = record(input, ['athlete_id', 'kind', 'state']);
    const athlete_id = uuid(row['athlete_id']);
    assert.equal(row['kind'], 'ai');
    const state: unknown = row['state'];
    assert.ok(typeof state === 'object' && state !== null && 'kind' in state);
    if (state.kind === 'absent') {
      record(state, ['kind']);
      return { athlete_id, kind: 'ai' as const, state: { kind: 'absent' as const } };
    }
    const present = record(state, ['kind', 'revision', 'granted']);
    assert.equal(present['kind'], 'exists');
    const revision: unknown = present['revision'];
    const granted: unknown = present['granted'];
    assert.ok(
      typeof revision === 'number' &&
        Number.isSafeInteger(revision) &&
        revision > 0 &&
        revision <= 2147483647,
    );
    assert.ok(typeof granted === 'boolean');
    return {
      athlete_id,
      kind: 'ai' as const,
      state: { kind: 'exists' as const, revision, granted },
    };
  });
  assert.equal(
    new Set(snapshots.map((row) => `${row.athlete_id}:${row.id}`)).size,
    snapshots.length,
  );
  assert.equal(new Set(consents.map((row) => row.athlete_id)).size, consents.length);
  assert.deepEqual(consents.map((row) => row.athlete_id).sort(), [...subjects].sort());
  for (const snapshot of snapshots) assert.ok(subjects.includes(snapshot.athlete_id));
  return { schemaVersion: 2 as const, capturedAt, subjects, snapshots, consents };
}

async function seedCompletion(database: Database, athleteId: string) {
  const draft = planDraftSchema.parse({
    title: 'Synthetic completion restore plan',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'restore-session',
        blockId: 'block',
        date: '2026-09-16',
        localStartTime: null,
        title: 'Synthetic completion session',
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
  const basePlan = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft,
  });
  const scenarioRepository = createPlanScenarioRepository(database);
  const createScenario = {
    confirmed: true as const,
    basePlanVersionId: basePlan.id,
    label: 'A' as const,
    idempotencyKey: randomUUID(),
  };
  const initialScenario = await scenarioRepository.create(athleteId, createScenario);
  const saveScenario = {
    confirmed: true as const,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    draft: { ...initialScenario.draft, title: 'Synthetic scenario applied before completion' },
  };
  const scenario = await scenarioRepository.save(athleteId, initialScenario.id, saveScenario);
  assert.deepEqual((await createPlanningRepository(database).read(athleteId)).head, basePlan);
  const applyScenario = {
    confirmed: true as const,
    expectedScenarioRevision: 2,
    expectedPlanVersionId: basePlan.id,
    expectedCompletionRevision: 0,
    idempotencyKey: randomUUID(),
  };
  const application = await scenarioRepository.apply(athleteId, scenario.id, applyScenario);
  const plan = application.plan;
  const command: SessionCompletionCommand = {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: plan.id,
    expectedRevision: null,
    reason: null,
    idempotencyKey: randomUUID(),
  };
  const result = await createSessionCompletionRepository(database).write(
    athleteId,
    'restore-session',
    command,
  );
  assert.equal(result.report.revision, 1);
  assert.equal(result.collectionRevision, 1);
  return {
    plan,
    command,
    result,
    basePlan,
    scenario,
    initialScenario,
    application,
    createScenario,
    saveScenario,
    applyScenario,
  };
}

async function seedCoachingThread(database: Database, athleteId: string, planVersionId: string) {
  const repository = createCoachingThreadRepository(database);
  const createCommand = {
    planVersionId,
    title: 'Synthetic restored coaching discussion',
    scope: { kind: 'session' as const, targetId: 'restore-session' },
    message: 'Synthetic first user message for backup verification',
    idempotencyKey: randomUUID(),
  };
  const created = await repository.create(athleteId, createCommand);
  const appendCommand = {
    expectedRevision: created.thread.revision,
    message: 'Synthetic second user message for backup verification',
    idempotencyKey: randomUUID(),
  };
  const appended = await repository.append(athleteId, created.thread.id, appendCommand);
  assert.equal(created.thread.revision, 1);
  assert.equal(appended.thread.revision, 2);
  assert.deepEqual(appended.thread.scope, createCommand.scope);
  assert.equal(appended.thread.planVersionId, planVersionId);
  return { createCommand, appendCommand, created, appended };
}

async function seedEvidenceWithAiConsent(database: Database, athleteId: string) {
  const completion = await seedCompletion(database, athleteId);
  const coaching = await seedCoachingThread(database, athleteId, completion.plan.id);
  const consent = await createConsentRepository(database).setConsent(athleteId, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const command: CoreEvidenceCapture = {
    expectedConversationRevision: coaching.appended.thread.revision,
    window: { from: '2026-09-01', toExclusive: '2026-10-01', timezone: 'UTC' },
    idempotencyKey: randomUUID(),
  };
  const snapshot = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    coaching.appended.thread.id,
    command,
  );
  assert.ok(snapshot.status === 'available');
  return { consent, command, snapshot };
}

async function seedCoachingRunOutput(
  database: Database,
  owner: Pool,
  athleteId: string,
  threadId: string,
  evidenceSnapshotId: string,
  conversationRevision: number,
) {
  const run = await createCoachingRunRepository(database, {
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'restore-drill-v1' },
  }).create(athleteId, threadId, {
    schemaVersion: 1,
    evidenceSnapshotId,
    expectedConversationRevision: conversationRevision,
    idempotencyKey: randomUUID(),
  });
  const outputId = randomUUID();
  const body = { synthetic: 'untrusted output to test purge-safe restore' };
  const connection = await owner.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    await connection.query(
      'INSERT INTO coaching_analysis_output(athlete_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athleteId, outputId, run.id, JSON.stringify(body)],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  return { run, outputId, body };
}

async function seedCoachingCandidateRecords(owner: Pool, athleteId: string, runId: string) {
  // Storage drill fixtures exercise archive/export/purge; repository validation is tested separately.
  const decision = {
    id: randomUUID(),
    body: { synthetic: 'decision body to test purge-safe restore' },
  };
  const proposal = {
    id: randomUUID(),
    body: { synthetic: 'proposal body to test purge-safe restore' },
  };
  const candidateBody = { synthetic: 'candidate body to test purge-safe restore' };
  const candidate = {
    id: randomUUID(),
    body: candidateBody,
    digest: createHash('sha256').update(JSON.stringify(candidateBody)).digest('hex'),
  };
  const connection = await owner.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    await connection.query(
      'INSERT INTO coaching_decision(athlete_id,id,run_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athleteId, decision.id, runId, JSON.stringify(decision.body)],
    );
    await connection.query(
      'INSERT INTO coaching_proposal(athlete_id,id,decision_id,body) VALUES($1,$2,$3,$4::jsonb)',
      [athleteId, proposal.id, decision.id, JSON.stringify(proposal.body)],
    );
    await connection.query(
      'INSERT INTO coaching_candidate(athlete_id,id,decision_id,proposal_id,digest,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [
        athleteId,
        candidate.id,
        decision.id,
        proposal.id,
        candidate.digest,
        JSON.stringify(candidate.body),
      ],
    );
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  return { decision, proposal, candidate };
}

async function readCoachingCandidateRows(
  owner: Pool,
  athleteId: string,
  records: Awaited<ReturnType<typeof seedCoachingCandidateRecords>>,
) {
  const decision = await owner.query(
    'SELECT body,purged_reason FROM coaching_decision WHERE athlete_id=$1 AND id=$2',
    [athleteId, records.decision.id],
  );
  const proposal = await owner.query(
    'SELECT body,purged_reason FROM coaching_proposal WHERE athlete_id=$1 AND id=$2',
    [athleteId, records.proposal.id],
  );
  const candidate = await owner.query(
    'SELECT body,digest,purged_reason FROM coaching_candidate WHERE athlete_id=$1 AND id=$2',
    [athleteId, records.candidate.id],
  );
  return {
    decision: decision.rows,
    proposal: proposal.rows,
    candidate: candidate.rows,
  };
}

function assertCoachingCandidateRowsAvailable(
  rows: Awaited<ReturnType<typeof readCoachingCandidateRows>>,
  records: Awaited<ReturnType<typeof seedCoachingCandidateRecords>>,
) {
  assert.deepEqual(rows.decision, [{ body: records.decision.body, purged_reason: null }]);
  assert.deepEqual(rows.proposal, [{ body: records.proposal.body, purged_reason: null }]);
  assert.deepEqual(rows.candidate, [
    { body: records.candidate.body, digest: records.candidate.digest, purged_reason: null },
  ]);
}

function assertCoachingCandidateRowsPurged(
  rows: Awaited<ReturnType<typeof readCoachingCandidateRows>>,
  reason: 'source_deleted' | 'consent_withdrawn',
) {
  assert.deepEqual(rows.decision, [{ body: null, purged_reason: reason }]);
  assert.deepEqual(rows.proposal, [{ body: null, purged_reason: reason }]);
  assert.deepEqual(rows.candidate, [{ body: null, digest: null, purged_reason: reason }]);
}

// No database URL is accepted, and no inherited libpq configuration reaches subprocesses.
const childEnvironment = { PATH: process.env.PATH, LC_ALL: 'C' };
function run(bin: string, name: string, args: string[]): string {
  const result = spawnSync(join(bin, name), args, {
    encoding: 'utf8',
    env: childEnvironment,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) throw new Error(`DRILL_${name.toUpperCase()}_FAILED`);
  return result.stdout.trim();
}
async function execute() {
  const reportUrl = new URL(
    '../docs/implementation/research/backup-restore-result.json',
    import.meta.url,
  );
  let previousRuns: unknown[] = [];
  try {
    const previous: unknown = JSON.parse(await readFile(reportUrl, 'utf8'));
    assert.ok(
      typeof previous === 'object' &&
        previous !== null &&
        'executedAt' in previous &&
        typeof previous.executedAt === 'string',
    );
    const history = 'previousRuns' in previous ? previous.previousRuns : [];
    assert.ok(Array.isArray(history));
    previousRuns = [
      ...history,
      Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'previousRuns')),
    ];
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const candidates = [
    process.env.PG_BIN,
    '/opt/homebrew/opt/postgresql@14/bin',
    '/opt/homebrew/opt/postgresql@15/bin',
    '/opt/homebrew/opt/postgresql@17/bin',
    '/usr/lib/postgresql/15/bin',
    '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/17/bin',
  ];
  const bin = candidates.find((value): value is string =>
    Boolean(value && existsSync(join(value, 'initdb'))),
  );
  if (!bin) throw new Error('POSTGRESQL_BINARIES_UNAVAILABLE');
  const directory = await mkdtemp(join(tmpdir(), 'workout-restore-drill-'));
  const data = join(directory, 'data');
  const archive = join(directory, 'synthetic.dump');
  const sourceObjectRoot = join(directory, 'source-objects');
  const objectArchive = join(directory, 'object-archive');
  const restoredObjectRoot = join(directory, 'restored-objects');
  const ledgerFile = join(directory, 'post-backup-erasure-ledger.json');
  const cleanupLedgerFile = join(directory, 'post-backup-encrypted-cleanup-ledger.json');
  const evidenceWithdrawalLedgerFile = join(
    directory,
    'post-backup-evidence-withdrawal-ledger.json',
  );
  const activityDeletionLedgerFile = join(directory, 'post-backup-activity-deletion-ledger.json');
  const pools: Pool[] = [];
  const databases: Database[] = [];
  let started = false;
  const interrupt = () => {
    try {
      if (started) run(bin, 'pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      process.exit(130);
    }
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const checks: string[] = [];
  let version = '';
  const url = (name: string, role = 'drill_admin') =>
    `postgresql://${role}@localhost/${name}?host=${encodeURIComponent(directory)}`;
  const pool = (name: string) => {
    const value = new Pool({ connectionString: url(name), max: 1, connectionTimeoutMillis: 5000 });
    pools.push(value);
    return value;
  };
  const database = (name: string) => {
    const value = createDatabase({ connectionString: url(name, 'drill_runtime') });
    databases.push(value);
    return value;
  };
  try {
    version = run(bin, 'pg_dump', ['--version']);
    run(bin, 'initdb', [
      '-D',
      data,
      '-U',
      'drill_admin',
      '-A',
      'trust',
      '--no-locale',
      '--encoding=UTF8',
    ]);
    started = true;
    run(bin, 'pg_ctl', [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-k ${directory} -h ''`,
      '-w',
      'start',
    ]);
    const admin = pool('postgres');
    await admin.query(
      'CREATE ROLE drill_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
    // The thumbnail renderer is its own least-privilege login, as in production: it may
    // execute the render lifecycle functions and nothing else — no table of its own, and
    // none of the runtime role's reach.
    await admin.query(
      'CREATE ROLE drill_thumbnailer LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    );
    await admin.query('CREATE DATABASE drill_source');
    await admin.query('CREATE DATABASE drill_restore');
    await migrate(url('drill_source'));
    const source = pool('drill_source');
    await source.query(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON consent,command_receipt,outbox,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO drill_runtime',
    );
    await source.query(
      'GRANT SELECT,INSERT,UPDATE ON plan_snapshot,plan_head,plan_history TO drill_runtime',
    );
    await grantOperations(url('drill_source'), 'drill_runtime');
    await grantGarmin(url('drill_source'), 'drill_runtime');
    await grantCheckIns(url('drill_source'), 'drill_runtime');
    await grantSessionCompletions(url('drill_source'), 'drill_runtime');
    await grantPlanScenarios(url('drill_source'), 'drill_runtime');
    await grantCoachingThreads(url('drill_source'), 'drill_runtime');
    await grantCoreEvidenceSnapshots(url('drill_source'), 'drill_runtime');
    await grantCoachingConstraints(url('drill_source'), 'drill_runtime');
    await grantCoachingRuns(url('drill_source'), 'drill_runtime');
    await grantCoachingCandidates(url('drill_source'), 'drill_runtime');
    await grantResources(url('drill_source'), 'drill_runtime');
    await grantResourceRetrieval(url('drill_source'), 'drill_runtime');
    await grantGalleryMedia(url('drill_source'), 'drill_runtime');
    await grantActivityTracks(url('drill_source'), 'drill_runtime');
    await grantCourses(url('drill_source'), 'drill_runtime');
    await grantCourseThumbnailWorker(url('drill_source'), 'drill_thumbnailer');
    const sourceDb = database('drill_source');
    const deletedAthlete = randomUUID();
    const retainedAthlete = randomUUID();
    const removedConstraintAthlete = randomUUID();
    const resourceRepo = createPrivateTextResourceRepository(sourceDb);
    const retainedResourceV1 = await resourceRepo.create(retainedAthlete, {
      sourceKind: 'text',
      title: 'Synthetic restored private text',
      category: 'note',
      metadata: {},
      tags: ['restore'],
      favorite: false,
      text: 'Version one restore body.',
      idempotencyKey: randomUUID(),
    });
    if (retainedResourceV1.status !== 'available') throw new Error('RESOURCE_SEED_FAILED');
    const retainedResourceV2 = await resourceRepo.appendVersion(
      retainedAthlete,
      retainedResourceV1.resource.id,
      {
        expectedCurrentVersionId: retainedResourceV1.version.id,
        text: 'Version two restore body.',
        idempotencyKey: randomUUID(),
      },
    );
    if (retainedResourceV2.status !== 'available') throw new Error('RESOURCE_SEED_FAILED');
    const resourceFiles = createResourceFileUploadRepository(sourceDb);
    const sourceObjectStorage = await createLocalFilesystemObjectStorage(sourceObjectRoot);
    const fileReservation = await resourceFiles.reserveCreate(
      retainedAthlete,
      {
        sourceKind: 'file',
        title: 'Synthetic restored Markdown file',
        category: 'guide',
        metadata: { language: 'en' },
        tags: ['restore'],
        favorite: false,
      },
      randomUUID(),
    );
    const fileBytes = Buffer.from('# Restore guide\n\nSynthetic private file.');
    const storedFile = await storeValidatedUpload({
      storage: sourceObjectStorage,
      tenantId: retainedAthlete,
      resourceId: fileReservation.resourceId,
      uploadId: fileReservation.uploadId,
      fileName: 'restore-guide.markdown',
      declaredMimeType: 'text/markdown',
      body: (async function* () {
        yield fileBytes;
      })(),
      onPrepared: async (prepared) => {
        await resourceFiles.prepareObject(retainedAthlete, fileReservation.uploadId, {
          storageRef: prepared.finalKey,
          file: {
            originalFileName: 'restore-guide.markdown',
            extension: 'markdown',
            mediaType: prepared.mimeType,
            byteSize: prepared.sizeBytes,
            sha256: prepared.sha256,
          },
        });
      },
    });
    await resourceFiles.markStaged(retainedAthlete, fileReservation.uploadId);
    const retainedFileResource = await resourceFiles.finalize(
      retainedAthlete,
      fileReservation.uploadId,
    );
    if (retainedFileResource.status !== 'available') throw new Error('RESOURCE_FILE_SEED_FAILED');
    const resourceUrls = createResourceUrlIngestionRepository(sourceDb);
    const urlReservation = await resourceUrls.reserveCreate(
      retainedAthlete,
      {
        title: 'Synthetic restored URL capture',
        category: 'guide',
        metadata: { language: 'en' },
        tags: ['restore'],
        favorite: false,
        url: 'https://example.com/restore?private=server-only',
      },
      randomUUID(),
    );
    const urlWorker = createResourceUrlIngestionWorkerRepository({
      connectionString: url('drill_source'),
    });
    const urlFetchLease = await urlWorker.lease();
    if (!urlFetchLease || urlFetchLease.requestId !== urlReservation.requestId)
      throw new Error('RESOURCE_URL_FETCH_LEASE_FAILED');
    await urlWorker.recordHop(urlFetchLease, {
      index: 0,
      displayUrl: 'https://example.com/restore',
      urlDigest: createHash('sha256').update(urlFetchLease.requestedUrl).digest('hex'),
      responseStatus: 200,
      resolvedAddresses: ['93.184.216.34'],
      policyVersion: 'restore-drill-v1',
    });
    const urlRawBytes = Buffer.from('<article><p>Synthetic restored URL body.</p></article>');
    const urlRawSha = createHash('sha256').update(urlRawBytes).digest('hex');
    const urlRawTemporaryKey = createUrlTemporaryObjectKey({
      tenantId: retainedAthlete,
      resourceId: urlReservation.resourceId,
      ingestionId: urlReservation.requestId,
      artifactKind: 'raw',
    });
    const storedUrlRawKey = createUrlFinalObjectKey({
      tenantId: retainedAthlete,
      resourceId: urlReservation.resourceId,
      ingestionId: urlReservation.requestId,
      artifactKind: 'raw',
      sha256: urlRawSha,
      extension: 'html',
    });
    await sourceObjectStorage.writeTemporary(
      urlRawTemporaryKey,
      (async function* () {
        yield urlRawBytes;
      })(),
    );
    assert.equal(
      await urlWorker.prepareRaw(urlFetchLease, {
        storageRef: storedUrlRawKey,
        sha256: urlRawSha,
        sizeBytes: urlRawBytes.byteLength,
        mediaType: 'text/html',
      }),
      true,
    );
    await sourceObjectStorage.publishTemporary(urlRawTemporaryKey, storedUrlRawKey, {
      sha256: urlRawSha,
      sizeBytes: urlRawBytes.byteLength,
    });
    assert.equal(await urlWorker.markRawPublished(urlFetchLease), true);
    const urlParseLease = await urlWorker.lease();
    if (!urlParseLease || urlParseLease.requestId !== urlReservation.requestId)
      throw new Error('RESOURCE_URL_PARSE_LEASE_FAILED');
    const urlParsedText = 'Synthetic restored URL body.';
    const urlFragments = [
      {
        ordinal: 0,
        kind: 'html_block' as const,
        headingPath: [],
        text: urlParsedText,
        startOffset: 0,
        endOffset: urlParsedText.length,
      },
    ];
    const urlParsedBytes = Buffer.from(
      JSON.stringify({ schemaVersion: 1, text: urlParsedText, fragments: urlFragments }),
    );
    const urlParsedSha = createHash('sha256').update(urlParsedBytes).digest('hex');
    const urlParsedTemporaryKey = createUrlTemporaryObjectKey({
      tenantId: retainedAthlete,
      resourceId: urlReservation.resourceId,
      ingestionId: urlReservation.requestId,
      artifactKind: 'parsed',
    });
    const storedUrlParsedKey = createUrlFinalObjectKey({
      tenantId: retainedAthlete,
      resourceId: urlReservation.resourceId,
      ingestionId: urlReservation.requestId,
      artifactKind: 'parsed',
      sha256: urlParsedSha,
      extension: 'json',
    });
    await sourceObjectStorage.writeTemporary(
      urlParsedTemporaryKey,
      (async function* () {
        yield urlParsedBytes;
      })(),
    );
    assert.equal(
      await urlWorker.prepareParsed(urlParseLease, {
        storageRef: storedUrlParsedKey,
        sha256: urlParsedSha,
        sizeBytes: urlParsedBytes.byteLength,
        text: urlParsedText,
        fragments: urlFragments,
        parserName: 'restore-drill-parser',
        parserVersion: '1',
      }),
      true,
    );
    await sourceObjectStorage.publishTemporary(urlParsedTemporaryKey, storedUrlParsedKey, {
      sha256: urlParsedSha,
      sizeBytes: urlParsedBytes.byteLength,
    });
    assert.equal(await urlWorker.markParsedPublished(urlParseLease), true);
    assert.ok(await urlWorker.finalize(urlParseLease));
    await urlWorker.close();
    const retainedUrlResource = await resourceRepo.read(retainedAthlete, urlReservation.resourceId);
    if (retainedUrlResource.status !== 'available') throw new Error('RESOURCE_URL_SEED_FAILED');
    const deletedResource = await resourceRepo.create(deletedAthlete, {
      sourceKind: 'text',
      title: 'Synthetic erased private text',
      category: 'note',
      metadata: {},
      tags: [],
      favorite: false,
      text: 'This body must not survive erasure replay.',
      idempotencyKey: randomUUID(),
    });
    if (deletedResource.status !== 'available') throw new Error('RESOURCE_SEED_FAILED');
    await resourceUrls.reserveCreate(
      deletedAthlete,
      {
        title: 'Synthetic erased URL request',
        category: 'note',
        metadata: {},
        tags: [],
        favorite: false,
        url: 'https://example.com/erased?private=must-not-survive',
      },
      randomUUID(),
    );
    const constraintRepo = createCoachingConstraintRepository(sourceDb);
    const oldConstraintCommand = {
      expectedHeadRevision: null,
      confirmed: true as const,
      text: 'Synthetic old restriction to correct',
      idempotencyKey: randomUUID(),
    };
    const oldConstraint = await constraintRepo.create(retainedAthlete, oldConstraintCommand);
    const removedConstraintCommand = {
      expectedHeadRevision: null,
      confirmed: true as const,
      text: 'Synthetic old restriction to delete',
      idempotencyKey: randomUUID(),
    };
    const removedConstraint = await constraintRepo.create(
      removedConstraintAthlete,
      removedConstraintCommand,
    );
    await constraintRepo.create(deletedAthlete, {
      ...oldConstraintCommand,
      idempotencyKey: randomUUID(),
    });
    const backupConstraintLedger = await captureConstraintRestoreLedger(source, []);
    const backupConstraintOwners = backupConstraintLedger.subjects.map((row) => row.athleteId);
    const constraintLedgerFile = join(directory, 'post-backup-constraint-ledger.json');
    const manualIds = new Map<string, string>();
    const fixtureActivities = new Map<string, { activityId: string; revision: number }>();
    const manualHistories = new Map<string, unknown>();
    const checkInIds = new Map<string, string>();
    const completions = new Map<string, Awaited<ReturnType<typeof seedCompletion>>>();
    const coachingThreads = new Map<string, Awaited<ReturnType<typeof seedCoachingThread>>>();
    const evidenceSnapshots = new Map<
      string,
      { command: CoreEvidenceCapture; snapshot: CoreEvidenceSnapshot }
    >();
    const coachingExports = new Map<string, { threads: unknown[]; messages: unknown[] }>();
    const coachingRuns = new Map<string, Awaited<ReturnType<typeof seedCoachingRunOutput>>>();
    const coachingCandidates = new Map<
      string,
      Awaited<ReturnType<typeof seedCoachingCandidateRecords>>
    >();
    const completionTables = [
      'session_completion',
      'session_completion_revision',
      'session_completion_receipt',
      'session_completion_collection_head',
    ];
    const coachingTables = [
      'coaching_thread',
      'coaching_message',
      'coaching_constraint',
      'coaching_constraint_head',
    ];
    const scenarioTables = ['plan_scenario', 'plan_scenario_revision', 'plan_scenario_application'];
    const selfReportTables = [
      'core_evidence_snapshot',
      'coaching_run',
      'coaching_analysis_output',
      'coaching_decision',
      'coaching_proposal',
      'coaching_candidate',
      ...scenarioTables,
      ...coachingTables,
      'check_in',
      'check_in_revision',
      'check_in_receipt',
      'check_in_collection_head',
      ...completionTables,
    ];
    const checkInValues = {
      observedAt: '2026-09-16T08:00:00+09:00',
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: 'Synthetic self-report for restore verification',
    };
    for (const [index, athleteId] of [deletedAthlete, retainedAthlete].entries()) {
      await createConsentRepository(sourceDb).setConsent(athleteId, {
        kind: 'app',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      const fixtureImport = await createActivityRepository(sourceDb).importActivity(athleteId, {
        idempotencyKey: randomUUID(),
        source: {
          kind: 'fixture',
          sourceId: randomUUID(),
          revision: 1,
          contentHash: 'a'.repeat(64),
        },
        activity: {
          title: 'Synthetic restore drill',
          kind: 'running',
          startedAt: '2026-09-16T08:00:00+09:00',
          timezone: 'Asia/Seoul',
          durationSeconds: null,
          durationKind: 'unknown',
          distanceMeters: 0,
        },
      });
      fixtureActivities.set(athleteId, fixtureImport);
      const activities = createActivityRepository(sourceDb);
      const manual = await activities.createManualActivity(athleteId, {
        confirmed: true,
        idempotencyKey: randomUUID(),
        activity: {
          title: 'Synthetic manual restore fixture',
          kind: 'running',
          startedAt: '2026-09-16T08:00:00+09:00',
          timezone: 'Asia/Seoul',
          durationSeconds: 0,
          durationKind: 'timer',
          distanceMeters: null,
        },
        report: { sessionRpe: 0, note: 'Synthetic manual self-report', planLink: null },
      });
      manualIds.set(athleteId, manual.activityId);
      const initialManual = await activities.getActivity(athleteId, manual.activityId);
      assert.ok(initialManual);
      assert.equal(initialManual.userReport?.sessionRpe, 0);
      assert.equal(initialManual.userReport?.note, 'Synthetic manual self-report');
      const before = await createOperationsRepository(sourceDb).exportAccount(athleteId);
      assert.equal(before.schemaVersion, 22);
      const originalHistory = before.data.overlayRevisions.filter(
        (row) => row.activity_id === manual.activityId,
      );
      assert.equal(originalHistory.length, 1);
      assert.deepEqual(originalHistory[0]?.values_json, initialManual.overlay);
      manualHistories.set(athleteId, originalHistory[0]);
      await activities.updateOverlay(athleteId, manual.activityId, {
        expectedRevision: manual.revision,
        idempotencyKey: randomUUID(),
        reason: 'Synthetic report correction',
        report: { sessionRpe: null, note: null, planLink: null },
      });
      const checkIn = await createCheckInRepository(sourceDb).createCheckIn(athleteId, {
        idempotencyKey: randomUUID(),
        values: checkInValues,
      });
      checkInIds.set(athleteId, checkIn.id);
      const completion = await seedCompletion(sourceDb, athleteId);
      completions.set(athleteId, completion);
      coachingThreads.set(
        athleteId,
        await seedCoachingThread(sourceDb, athleteId, completion.plan.id),
      );
      const thread = coachingThreads.get(athleteId);
      assert.ok(thread);
      await createConsentRepository(sourceDb).setConsent(athleteId, {
        kind: 'ai',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      const evidenceCommand: CoreEvidenceCapture = {
        expectedConversationRevision: thread.appended.thread.revision,
        window: { from: '2026-09-01', toExclusive: '2026-10-01', timezone: 'Asia/Seoul' },
        idempotencyKey: randomUUID(),
      };
      const evidenceSnapshot = await createCoreEvidenceSnapshotRepository(sourceDb).capture(
        athleteId,
        thread.appended.thread.id,
        evidenceCommand,
      );
      assert.equal(evidenceSnapshot.status, 'available');
      evidenceSnapshots.set(athleteId, { command: evidenceCommand, snapshot: evidenceSnapshot });
      coachingRuns.set(
        athleteId,
        await seedCoachingRunOutput(
          sourceDb,
          source,
          athleteId,
          thread.appended.thread.id,
          evidenceSnapshot.id,
          thread.appended.thread.revision,
        ),
      );
      const seededRun = coachingRuns.get(athleteId);
      assert.ok(seededRun);
      coachingCandidates.set(
        athleteId,
        await seedCoachingCandidateRecords(source, athleteId, seededRun.run.id),
      );
      const coachingExport = await createOperationsRepository(sourceDb).exportAccount(athleteId);
      if (coachingExport.schemaVersion !== 22) throw new Error('Expected coaching export v22');
      assert.equal(coachingExport.data.coachingThreads.length, 1);
      assert.equal(coachingExport.data.coachingMessages.length, 2);
      assert.equal(coachingExport.data.coachingRuns.length, 1);
      assert.deepEqual(
        coachingExport.data.coachingAnalysisOutputs[0]?.body,
        coachingRuns.get(athleteId)?.body,
      );
      const seededCandidate = coachingCandidates.get(athleteId);
      assert.ok(seededCandidate);
      assert.deepEqual(
        coachingExport.data.coachingDecisions[0]?.body,
        seededCandidate.decision.body,
      );
      assert.deepEqual(
        coachingExport.data.coachingProposals[0]?.body,
        seededCandidate.proposal.body,
      );
      assert.deepEqual(
        coachingExport.data.coachingCandidates[0]?.body,
        seededCandidate.candidate.body,
      );
      assert.equal(
        coachingExport.data.coachingCandidates[0]?.digest,
        seededCandidate.candidate.digest,
      );
      // A historical v8 download keeps its original shape and remains readable after v18 is added.
      const {
        coachingDecisions,
        coachingProposals,
        coachingCandidates: candidates,
        nutritionPlanVersions: _nutritionPlanVersions,
        nutritionPlanHeads: _nutritionPlanHeads,
        nutritionPlanHistory: _nutritionPlanHistory,
        foodDefinitionVersions: _foodDefinitionVersions,
        foodDefinitionHeads: _foodDefinitionHeads,
        intakeEntries: _intakeEntries,
        intakeEntryRevisions: _intakeEntryRevisions,
        supplementaryExerciseVersions: _supplementaryExerciseVersions,
        supplementaryExerciseHeads: _supplementaryExerciseHeads,
        supplementaryRoutineVersions: _supplementaryRoutineVersions,
        supplementaryRoutineHeads: _supplementaryRoutineHeads,
        supplementaryRoutineTargetRefs: _supplementaryRoutineTargetRefs,
        supplementarySessionLinks: _supplementarySessionLinks,
        supplementarySessionTargetRefs: _supplementarySessionTargetRefs,
        supplementaryExecutions: _supplementaryExecutions,
        supplementarySetLogs: _supplementarySetLogs,
        supplementarySetLogRevisions: _supplementarySetLogRevisions,
        supplementaryRestTimers: _supplementaryRestTimers,
        resources: _resources,
        resourceVersions: _resourceVersions,
        resourceUrlIngestions: _resourceUrlIngestions,
        resourceUrlAttempts: _resourceUrlAttempts,
        resourceUrlFetchHops: _resourceUrlFetchHops,
        resourceUrlArtifacts: _resourceUrlArtifacts,
        resourceUrlProvenance: _resourceUrlProvenance,
        resourceUrlLocators: _resourceUrlLocators,
        resourceShares: _resourceShares,
        resourceAccessAudit: _resourceAccessAudit,
        galleryMediaItems: _galleryMediaItems,
        galleryMediaDerivatives: _galleryMediaDerivatives,
        resourcePassages: _resourcePassages,
        resourceGroundings: _resourceGroundings,
        resourceGroundingExcerpts: _resourceGroundingExcerpts,
        resourceCitations: _resourceCitations,
        activityTracks: _activityTracks,
        activityTrackRevisions: _activityTrackRevisions,
        courses: _courses,
        courseRevisions: _courseRevisions,
        coursePreferences: _coursePreferences,
        coursePrivacyZones: _coursePrivacyZones,
        courseThumbnails: _courseThumbnails,
        courseAccessibilityNotes: _courseAccessibilityNotes,
        ...v8Data
      } = coachingExport.data;
      assert.equal(coachingDecisions.length + coachingProposals.length + candidates.length, 3);
      assert.equal(
        accountExportSchema.parse({ ...coachingExport, schemaVersion: 8, data: v8Data })
          .schemaVersion,
        8,
      );
      coachingExports.set(athleteId, {
        threads: coachingExport.data.coachingThreads,
        messages: coachingExport.data.coachingMessages,
      });
      await source.query(
        'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
        [athleteId, 'https://synthetic.invalid', `drill-${index}`],
      );
      const session = await source.query(
        "INSERT INTO identity_private.session(token_hash,athlete_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour') RETURNING session_id",
        [String(index + 1).repeat(64), athleteId, 'x'.repeat(32)],
      );
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', randomBytes(32), iv);
      const encrypted = {
        keyId: 'synthetic',
        iv: iv.toString('base64'),
        ciphertext: Buffer.concat([cipher.update('synthetic-credential'), cipher.final()]).toString(
          'base64',
        ),
        tag: cipher.getAuthTag().toString('base64'),
      };
      const now = new Date(),
        scope = { athleteId, sessionId: String(session.rows[0].session_id), now };
      const garmin = createGarminStore(sourceDb),
        stateHash = String(index + 1).repeat(64);
      const attempt = await garmin.createAttempt({
        ...scope,
        stateHash,
        encryptedVerifier: encrypted,
        expiresAt: new Date(now.getTime() + 600000),
      });
      assert.ok(await garmin.consumeAttempt({ ...scope, stateHash }));
      assert.ok(
        await garmin.commitConnection({
          ...scope,
          ...attempt,
          userId: `synthetic-${index}`,
          permissions: [],
          encryptedTokens: encrypted,
          accessExpiresAt: new Date(now.getTime() + 3600000),
          refreshExpiresAt: new Date(now.getTime() + 86400000),
        }),
      );
    }
    await source.query(
      "INSERT INTO identity_private.login_attempt VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes')",
      ['a'.repeat(64), 'b'.repeat(64), 'n'.repeat(16), 'v'.repeat(43)],
    );
    assert.equal(
      (await source.query('SELECT count(*)::int AS count FROM activity_canonical')).rows[0].count,
      4,
    );
    checks.push('two_synthetic_tenants_seeded');
    checks.push('synthetic_candidate_bodies_in_source_export_v13_historical_v8_artifact_readable');
    // These extra tenants add no identity, provider connection or activity to the original checks.
    const withdrawnAthlete = randomUUID();
    const {
      consent: aiConsent,
      command: withdrawnCommand,
      snapshot: beforeWithdrawal,
    } = await seedEvidenceWithAiConsent(sourceDb, withdrawnAthlete);
    const withdrawnRun = await seedCoachingRunOutput(
      sourceDb,
      source,
      withdrawnAthlete,
      beforeWithdrawal.threadId,
      beforeWithdrawal.id,
      2,
    );
    const withdrawnCandidate = await seedCoachingCandidateRecords(
      source,
      withdrawnAthlete,
      withdrawnRun.run.id,
    );
    const absentConsentAthlete = randomUUID();
    const beforeConsentDeletion = await seedEvidenceWithAiConsent(sourceDb, absentConsentAthlete);
    const absentConsentRun = await seedCoachingRunOutput(
      sourceDb,
      source,
      absentConsentAthlete,
      beforeConsentDeletion.snapshot.threadId,
      beforeConsentDeletion.snapshot.id,
      2,
    );
    const absentConsentCandidate = await seedCoachingCandidateRecords(
      source,
      absentConsentAthlete,
      absentConsentRun.run.id,
    );
    for (const [athleteId, records] of [
      [withdrawnAthlete, withdrawnCandidate],
      [absentConsentAthlete, absentConsentCandidate],
    ] as const) {
      const candidateExport = await createOperationsRepository(sourceDb).exportAccount(athleteId);
      if (candidateExport.schemaVersion !== 22) throw new Error('Expected candidate export v22');
      assert.deepEqual(candidateExport.data.coachingDecisions[0]?.body, records.decision.body);
      assert.deepEqual(candidateExport.data.coachingProposals[0]?.body, records.proposal.body);
      assert.deepEqual(candidateExport.data.coachingCandidates[0]?.body, records.candidate.body);
      assert.equal(candidateExport.data.coachingCandidates[0]?.digest, records.candidate.digest);
    }
    const constraintPlan = await seedCompletion(sourceDb, removedConstraintAthlete);
    const constraintThread = await seedCoachingThread(
      sourceDb,
      removedConstraintAthlete,
      constraintPlan.plan.id,
    );
    await createConsentRepository(sourceDb).setConsent(removedConstraintAthlete, {
      kind: 'ai',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    const constraintCapture: CoreEvidenceCapture = {
      expectedConversationRevision: constraintThread.appended.thread.revision,
      window: { from: '2026-09-01', toExclusive: '2026-10-01', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    };
    const constraintSnapshot = await createCoreEvidenceSnapshotRepository(sourceDb).capture(
      removedConstraintAthlete,
      constraintThread.appended.thread.id,
      constraintCapture,
    );
    assert.ok(
      constraintSnapshot.status === 'available' && constraintSnapshot.body.schemaVersion === 2,
    );
    assert.equal(constraintSnapshot.body.userConstraints.items[0]?.id, removedConstraint.id);
    const constraintRun = await seedCoachingRunOutput(
      sourceDb,
      source,
      removedConstraintAthlete,
      constraintThread.appended.thread.id,
      constraintSnapshot.id,
      constraintThread.appended.thread.revision,
    );
    const constraintCandidate = await seedCoachingCandidateRecords(
      source,
      removedConstraintAthlete,
      constraintRun.run.id,
    );
    assertCoachingCandidateRowsAvailable(
      await readCoachingCandidateRows(source, removedConstraintAthlete, constraintCandidate),
      constraintCandidate,
    );

    // ---------------------------------------------------------------------
    // Access sharing (v15), gallery media (v16) and the retrieval derived
    // stores (v17) are seeded before the backup so the restore has to
    // reproduce them, and so a resource deleted before the backup can be
    // proved not to come back with its passages, cache, grounding or
    // citations.
    // ---------------------------------------------------------------------
    const accessRepo = createResourceAccessRepository(sourceDb);

    const galleryRepo = createGalleryMediaRepository(sourceDb);
    const galleryReservation = await galleryRepo.reserveCreate(
      retainedAthlete,
      {
        mediaKind: 'image',
        album: 'Restore drill',
        caption: 'Synthetic finish photo',
        activityId: null,
        capturedAt: null,
        capturedLocalDate: null,
      },
      `gallery-${randomUUID()}`,
    );
    const gallerySha = createHash('sha256').update('synthetic-gallery-image').digest('hex');
    await galleryRepo.prepareObject(retainedAthlete, galleryReservation.uploadId, {
      storageRef: createGalleryFinalObjectKey({
        tenantId: retainedAthlete,
        mediaItemId: galleryReservation.mediaItemId,
        uploadId: galleryReservation.uploadId,
        sha256: gallerySha,
        extension: 'png',
      }),
      file: {
        originalFileName: 'finish.png',
        mediaType: 'image/png',
        byteSize: 2048,
        sha256: gallerySha,
      },
    });
    await galleryRepo.markStaged(retainedAthlete, galleryReservation.uploadId);
    const galleryFinalized = await galleryRepo.finalize(
      retainedAthlete,
      galleryReservation.uploadId,
    );
    if (galleryFinalized.status !== 'available') throw new Error('GALLERY_SEED_FAILED');
    const previewReservation = await galleryRepo.reservePreview(
      retainedAthlete,
      galleryReservation.mediaItemId,
      { expectedAccessRevision: galleryFinalized.item.accessRevision },
      `gallery-${randomUUID()}`,
    );
    const previewSha = createHash('sha256').update('synthetic-gallery-preview').digest('hex');
    await galleryRepo.prepareObject(retainedAthlete, previewReservation.uploadId, {
      storageRef: createGalleryFinalObjectKey({
        tenantId: retainedAthlete,
        mediaItemId: galleryReservation.mediaItemId,
        uploadId: previewReservation.uploadId,
        sha256: previewSha,
        extension: 'jpg',
      }),
      file: {
        originalFileName: 'finish-preview.jpg',
        mediaType: 'image/jpeg',
        byteSize: 512,
        sha256: previewSha,
      },
    });
    await galleryRepo.markStaged(retainedAthlete, previewReservation.uploadId);
    await galleryRepo.finalize(retainedAthlete, previewReservation.uploadId);

    // Private recorded tracks for the retained tenant, seeded through the same
    // reserve → prepare → stage → finalize lifecycle the API drives, so the restore has
    // to reproduce the metadata, the revision and all three objects together.
    const trackRepo = createActivityTrackRepository(sourceDb);
    const trackCorrespondence = createHash('sha256')
      .update('drill-track-correspondence')
      .digest('hex');
    const seedTrack = async (
      activityId: string,
      activityRevision: number,
      label: string,
      owner: string = retainedAthlete,
    ) => {
      const reservation = await trackRepo.reserve(
        owner,
        activityId,
        { expectedActivityRevision: activityRevision, recordedTrackIndex: 0 },
        `track-${randomUUID()}`,
      );
      const publish = async (
        artifactKind: 'raw' | 'normalized' | 'map_path',
        extension: 'gpx' | 'json',
        content: string,
      ) => {
        const bytes = Buffer.from(content, 'utf8');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const parts = {
          tenantId: owner,
          activityId,
          trackId: reservation.trackId,
          uploadId: reservation.uploadId,
          artifactKind,
        };
        const temporary = createActivityTrackTemporaryObjectKey(parts);
        const finalKey = createActivityTrackFinalObjectKey({ ...parts, sha256, extension });
        await sourceObjectStorage.writeTemporary(
          temporary,
          (async function* () {
            yield bytes;
          })(),
        );
        await sourceObjectStorage.publishTemporary(temporary, finalKey, {
          sizeBytes: bytes.byteLength,
          sha256,
        });
        return { storageRef: finalKey, sizeBytes: bytes.byteLength, sha256, bytes };
      };
      const raw = await publish(
        'raw',
        'gpx',
        `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${label}</name><trkseg>` +
          '<trkpt lat="37.5" lon="127.02"><time>2026-03-01T00:00:00Z</time></trkpt>' +
          '<trkpt lat="37.5001" lon="127.0201"><time>2026-03-01T00:00:10Z</time></trkpt>' +
          '</trkseg></trk></gpx>',
      );
      const normalized = await publish(
        'normalized',
        'json',
        JSON.stringify({ schemaVersion: 1, sampleCount: 2, label }),
      );
      const mapPath = await publish(
        'map_path',
        'json',
        JSON.stringify({ schemaVersion: 1, lines: 1, label }),
      );
      await trackRepo.prepareObjects(owner, reservation.uploadId, {
        raw: {
          storageRef: raw.storageRef,
          sizeBytes: raw.sizeBytes,
          sha256: raw.sha256,
          format: 'gpx',
          originalFileName: 'restore-drill.gpx',
        },
        normalized: {
          storageRef: normalized.storageRef,
          sizeBytes: normalized.sizeBytes,
          sha256: normalized.sha256,
        },
        mapPath: {
          storageRef: mapPath.storageRef,
          sizeBytes: mapPath.sizeBytes,
          sha256: mapPath.sha256,
        },
        parse: {
          parserId: 'gpx-track-v1',
          parserVersion: 1,
          recordedSourceKind: 'gpx-trk',
          correspondenceDigest: trackCorrespondence,
          sampleCount: 2,
          positionedSampleCount: 2,
          segmentCount: 1,
          segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
          distances: { deviceReportedMeters: null, recomputedFromPositionsMeters: 14 },
        },
      });
      await trackRepo.markStaged(owner, reservation.uploadId);
      const stored = await trackRepo.finalize(owner, reservation.uploadId);
      assert.equal(stored.status, 'available');
      return { raw, normalized, mapPath, artifacts: [raw, normalized, mapPath] };
    };
    const retainedFixture = fixtureActivities.get(retainedAthlete);
    assert.ok(retainedFixture);
    const retainedTrack = await seedTrack(
      retainedFixture.activityId,
      retainedFixture.revision,
      'retained',
    );
    const trackRaw = retainedTrack.raw;
    const trackNormalized = retainedTrack.normalized;
    const trackMapPath = retainedTrack.mapPath;
    // A second tracked activity for the same tenant. This one is deleted *after* the
    // backup, so the restored cluster starts out holding a track the user has since
    // removed — the case a restore must not resurrect.
    const doomedImport = await createActivityRepository(sourceDb).importActivity(retainedAthlete, {
      idempotencyKey: randomUUID(),
      source: {
        kind: 'fixture',
        sourceId: randomUUID(),
        revision: 1,
        contentHash: 'b'.repeat(64),
      },
      activity: {
        title: 'Synthetic track deleted after backup',
        kind: 'running',
        startedAt: '2026-09-17T08:00:00+09:00',
        timezone: 'Asia/Seoul',
        durationSeconds: null,
        durationKind: 'unknown',
        distanceMeters: 0,
      },
    });
    const doomedTrack = await seedTrack(
      doomedImport.activityId,
      doomedImport.revision,
      'deleted-after-backup',
    );

    // Private courses cut from those recordings (M2-01f). One belongs to the retained
    // activity and must come back intact; two belong to the activity deleted after the
    // backup — the second is an independently named copy — and the replayed suppression
    // has to reclaim both, or a restore would be a way around deletion.
    const courseRepo = createCourseRepository(sourceDb);
    const courseContent = (
      activityId: string,
      trackId: string,
      name: string,
      edit:
        | { kind: 'created' }
        | { kind: 'copied'; copiedFromCourseId: string; copiedFromRevision: number },
    ) => {
      const start: [number, number] = [127.02, 37.5];
      const finish: [number, number] = [127.0201, 37.5001];
      const line: [number, number][] = [start, finish];
      return {
        name,
        coordinates: line,
        waypoints: [
          { role: 'start' as const, position: start, name: null, sourceSampleId: '0:0' },
          { role: 'finish' as const, position: finish, name: null, sourceSampleId: '0:1' },
        ],
        generation: {
          kind: 'recorded-segment' as const,
          activityId,
          trackId,
          trackRevision: 1,
          lineIndex: 0,
          segmentIndex: 0,
          startSampleId: '0:0',
          endSampleId: '0:1',
          vertexCount: 2,
          mapPathContentSha256: 'c'.repeat(64),
          simplificationVersion: 1 as const,
          toleranceMeters: 2.5,
        },
        edit,
        lineage: [{ activityId, trackId, trackRevision: 1 }],
        distanceMeters: 14.2,
        contentDigest: createHash('sha256').update(`${activityId}:${name}`).digest('hex'),
      };
    };
    const retainedTrackId = (
      await source.query<{ track_id: string }>(
        'SELECT track_id FROM activity_track WHERE athlete_id=$1 AND activity_id=$2',
        [retainedAthlete, retainedFixture.activityId],
      )
    ).rows[0]?.track_id;
    const doomedTrackId = (
      await source.query<{ track_id: string }>(
        'SELECT track_id FROM activity_track WHERE athlete_id=$1 AND activity_id=$2',
        [retainedAthlete, doomedImport.activityId],
      )
    ).rows[0]?.track_id;
    assert.ok(retainedTrackId && doomedTrackId);
    const retainedCourse = await courseRepo.create(
      retainedAthlete,
      courseContent(retainedFixture.activityId, retainedTrackId, 'Retained drill course', {
        kind: 'created',
      }),
      `course-${randomUUID()}`,
    );
    assert.equal(retainedCourse.status, 'available');
    if (retainedCourse.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    const doomedCourse = await courseRepo.create(
      retainedAthlete,
      courseContent(doomedImport.activityId, doomedTrackId, 'Doomed drill course', {
        kind: 'created',
      }),
      `course-${randomUUID()}`,
    );
    assert.equal(doomedCourse.status, 'available');
    if (doomedCourse.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    const doomedCourseCopy = await courseRepo.create(
      retainedAthlete,
      courseContent(doomedImport.activityId, doomedTrackId, 'Doomed drill course copy', {
        kind: 'copied',
        copiedFromCourseId: doomedCourse.course.courseId,
        copiedFromRevision: 1,
      }),
      `course-${randomUUID()}`,
    );
    assert.equal(doomedCourseCopy.status, 'available');
    if (doomedCourseCopy.status !== 'available') throw new Error('COURSE_SEED_FAILED');

    // M2-01j: what the owner thinks of a course, and where they do not want a course to
    // say they have been. Neither is course content, so neither appears in a revision —
    // which is exactly why a restore has to bring them back on its own.
    const preferenceRepo = createCoursePreferenceRepository(sourceDb);
    await preferenceRepo.write(retainedAthlete, retainedCourse.course.courseId, {
      favourite: true,
    });
    await preferenceRepo.write(retainedAthlete, retainedCourse.course.courseId, {
      markUsed: true,
    });
    const seededZones = await preferenceRepo.createPrivacyZone(retainedAthlete, {
      name: 'Drill protected area',
      center: [127.02, 37.5],
      radiusMeters: 300,
    });
    const seededPreference = (await preferenceRepo.list(retainedAthlete)).preferences.find(
      (preference) => preference.courseId === retainedCourse.course.courseId,
    );
    assert.ok(seededPreference?.lastUsedAt);
    // M2-01r: the owner's accessibility note. Text nothing can rebuild, written against the
    // head the owner was looking at; a restore must bring back both the words and that
    // revision, or an old note would read as a description of whatever line is there now.
    const seededNote = await preferenceRepo.writeAccessibilityNote(
      retainedAthlete,
      retainedCourse.course.courseId,
      { expectedRevision: 1, note: 'Drill accessibility note: 12 steps, handrail' },
    );
    assert.equal(seededNote?.writtenAtRevision, 1);

    // A course whose head was computed by our own pedestrian engine (M2-01h), plus one
    // reviewed-but-unsaved proposal. Both carry private planned coordinates, and the
    // revision carries the graph identity that answered — the fact that makes "a stored
    // course is never silently recomputed on a newer graph" checkable at all. A backup
    // that lost either would lose exactly that.
    const routedLine: [number, number][] = [
      [127.02, 37.5],
      [127.02005, 37.50005],
      [127.0201, 37.5001],
    ];
    const drillComputation = (requestId: string, draftRevision: number) => ({
      schemaVersion: 1 as const,
      requestId,
      requestRevision: draftRevision,
      graph: {
        engine: 'graphhopper' as const,
        identitySource: 'engine' as const,
        engineVersion: '10.0',
        engineArtifactSha256: 'a'.repeat(64),
        profileId: 'foot-v1' as const,
        profileConfigSha256: 'b'.repeat(64),
        extractSha256: 'c'.repeat(64),
        extractRegion: 'drill fixture',
        graphContentSha256: 'd'.repeat(64),
        graphBuildId: '0123456789abcdef',
        graphImportedAt: '2026-03-01T00:00:00.000Z',
        roadDataAt: '2026-02-01T00:00:00.000Z',
      },
      conditions: {
        profileId: 'foot-v1' as const,
        algorithm: 'flexible' as const,
        contractionHierarchies: false as const,
        maxVisitedNodes: 1_000_000,
        deadlineMilliseconds: 8_000,
        snapLimitMeters: 120,
        waypointCount: 2,
      },
      computedAt: '2026-03-02T00:00:00.000Z',
      computationMilliseconds: 42,
      warnings: [],
    });
    const drillProposalInput = (courseId: string, draftRevision: number) => {
      const requestId = `req-${randomUUID()}`;
      return {
        courseId,
        draftRevision,
        requestId,
        waypoints: [
          {
            role: 'start' as const,
            position: routedLine[0] as [number, number],
            name: null,
            sourceSampleId: null,
            locked: false,
          },
          {
            role: 'finish' as const,
            position: routedLine[2] as [number, number],
            name: null,
            sourceSampleId: null,
            locked: true,
          },
        ],
        coordinates: routedLine,
        engineDistanceMeters: 15.5,
        engineDurationSeconds: 12,
        snappedWaypoints: [
          {
            requested: routedLine[0] as [number, number],
            snapped: routedLine[0] as [number, number],
            snapDistanceMeters: 0,
          },
          {
            requested: routedLine[2] as [number, number],
            snapped: routedLine[2] as [number, number],
            snapDistanceMeters: 3.25,
          },
        ],
        computation: drillComputation(requestId, draftRevision),
        ttlSeconds: 1800,
      };
    };
    const routedCourse = await courseRepo.create(
      retainedAthlete,
      courseContent(retainedFixture.activityId, retainedTrackId, 'Routed drill course', {
        kind: 'created',
      }),
      `course-${randomUUID()}`,
    );
    if (routedCourse.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    const savedProposalInput = drillProposalInput(routedCourse.course.courseId, 4);
    const savedProposal = await courseRepo.storeRouteProposal(retainedAthlete, savedProposalInput);
    const routedSaved = await courseRepo.update(
      retainedAthlete,
      routedCourse.course.courseId,
      1,
      {
        name: 'Routed drill course',
        coordinates: routedLine,
        waypoints: savedProposalInput.waypoints,
        generation: {
          kind: 'routed-waypoints',
          computation: savedProposalInput.computation,
          engineDistanceMeters: savedProposalInput.engineDistanceMeters,
          engineDurationSeconds: savedProposalInput.engineDurationSeconds,
          maxSnapDistanceMeters: 3.25,
          waypointCount: 2,
          vertexCount: routedLine.length,
        },
        edit: { kind: 'rerouted' },
        lineage: [
          {
            activityId: retainedFixture.activityId,
            trackId: retainedTrackId,
            trackRevision: 1,
          },
        ],
        distanceMeters: 15.25,
        contentDigest: createHash('sha256').update('routed-drill-course').digest('hex'),
      },
      `course-${randomUUID()}`,
      { kind: 'reroute' },
      {
        consumeProposal: {
          proposalId: savedProposal.proposalId,
          draftRevision: savedProposal.draftRevision,
          geometrySha256: courseGeometrySha256(routedLine),
        },
      },
    );
    if (routedSaved.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    const unsavedProposal = await courseRepo.storeRouteProposal(
      retainedAthlete,
      drillProposalInput(routedCourse.course.courseId, 5),
    );

    // One bounded target-distance search (M2-01i) with its candidates, none of them picked.
    // A candidate is a proposal carrying private planned coordinates, and the search row
    // carries the seed and the evaluation version that make it reproducible. A backup that
    // lost the search would leave candidates nobody could say where they came from.
    const candidateLoop: [number, number][] = [
      [127.02, 37.5],
      [127.0203, 37.5004],
      [127.0197, 37.5004],
      [127.02, 37.5],
    ];
    const candidateEvaluation = {
      evaluationVersion: 1 as const,
      targetDistanceMeters: 5_000,
      engineDistanceMeters: 4_800,
      plannedLineMeters: 4_790,
      distanceErrorMeters: -200,
      distanceErrorRatio: -0.04,
      loop: { closed: true, gapMeters: 0 },
      connectivity: 'engine-attested-edges' as const,
      repetition: { repeatedMeters: 0, repeatedRatio: 0, outAndBack: false },
      knowledge: {
        stairs: 'unknown' as const,
        surface: 'unknown' as const,
        nightAccess: 'unknown' as const,
        accessRestrictions: 'unknown' as const,
        gradient: 'unknown' as const,
      },
      gradientSource: 'none' as const,
      maxSnapDistanceMeters: 2,
      waypointCount: 3,
      vertexCount: candidateLoop.length,
    };
    // A search is seeded for the same draft as its course's unsaved route. Since M2-01p a new
    // answer replaces the unsaved answers of a draft the editor has moved past, so a search
    // for another draft would remove that route before the backup ever saw it. Route and
    // search of one draft sit side by side, as they do on the editor's screen — which is why
    // the draft is a parameter here: the retained course's route is draft 5 and the erased
    // tenant's is draft 3.
    const drillCandidateSetInput = (
      courseId: string,
      candidateRequestId: string,
      draftRevision: number,
    ) => ({
      courseId,
      draftRevision,
      requestId: candidateRequestId,
      targetDistanceMeters: 5_000,
      searchSeed: 'feedfacefeedface',
      ttlSeconds: 1800,
      bounds: {
        maxCandidates: 4,
        maxAttempts: 8,
        searchBudgetMilliseconds: 30_000,
        maxSearchRadiusMeters: 2_500,
        distanceToleranceRatio: 0.25,
      },
      search: {
        attemptsMade: 2,
        elapsedMilliseconds: 320,
        duplicatesDropped: 1,
        attempts: [
          {
            attemptIndex: 0,
            candidateSeed: '0000000000000000',
            requestedRadiusMeters: 962,
            outcome: 'accepted' as const,
            engineDistanceMeters: 4_800,
          },
          {
            attemptIndex: 1,
            candidateSeed: '1111111111111111',
            requestedRadiusMeters: 970,
            outcome: 'duplicate' as const,
            engineDistanceMeters: 4_805,
          },
        ],
        stoppedBecause: 'attempt_limit' as const,
      },
      candidates: [
        {
          ordinal: 0,
          attemptIndex: 0,
          candidateSeed: '0000000000000000',
          waypoints: [
            {
              role: 'start' as const,
              position: candidateLoop[0] as [number, number],
              name: null,
              sourceSampleId: null,
              locked: false,
            },
            {
              role: 'via' as const,
              position: candidateLoop[1] as [number, number],
              name: null,
              sourceSampleId: null,
              locked: false,
            },
            {
              role: 'finish' as const,
              position: candidateLoop[0] as [number, number],
              name: null,
              sourceSampleId: null,
              locked: false,
            },
          ],
          coordinates: candidateLoop,
          engineDistanceMeters: 4_800,
          engineDurationSeconds: 3_600,
          snappedWaypoints: [0, 1, 0].map((index) => ({
            requested: candidateLoop[index] as [number, number],
            snapped: candidateLoop[index] as [number, number],
            snapDistanceMeters: 2,
          })),
          computation: {
            ...drillComputation(candidateRequestId, draftRevision),
            conditions: {
              ...drillComputation(candidateRequestId, draftRevision).conditions,
              waypointCount: 3,
            },
          },
          evaluation: candidateEvaluation,
        },
      ],
    });
    const candidateSet = await courseRepo.storeRouteCandidateSet(
      retainedAthlete,
      drillCandidateSetInput(routedCourse.course.courseId, `req-${randomUUID()}`, 5),
    );

    // M2-01s: the tenant erased after the backup owns courses too, so the restore has
    // something of theirs to bring back and the replayed erasure something to take away.
    // Everything a course can leave behind is seeded: a recorded track with its three
    // objects, a course that is edited to a second revision (so one picture is superseded
    // and one is the head), a copy whose render fails retryably with its temporary object
    // already written (a retry that never finished), a preference, a protected area, an
    // unsaved proposal, a candidate search, and — through the triggers — the reconciliation
    // index rows for both kinds of object.
    const erasedCourseFixture = fixtureActivities.get(deletedAthlete);
    assert.ok(erasedCourseFixture);
    const erasedTrack = await seedTrack(
      erasedCourseFixture.activityId,
      erasedCourseFixture.revision,
      'erased-tenant',
      deletedAthlete,
    );
    const erasedTrackId = (
      await source.query<{ track_id: string }>(
        'SELECT track_id FROM activity_track WHERE athlete_id=$1 AND activity_id=$2',
        [deletedAthlete, erasedCourseFixture.activityId],
      )
    ).rows[0]?.track_id;
    assert.ok(erasedTrackId);
    const erasedCourse = await courseRepo.create(
      deletedAthlete,
      courseContent(erasedCourseFixture.activityId, erasedTrackId, 'Erased tenant drill course', {
        kind: 'created',
      }),
      `course-${randomUUID()}`,
    );
    if (erasedCourse.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    const erasedRetryCourse = await courseRepo.create(
      deletedAthlete,
      courseContent(
        erasedCourseFixture.activityId,
        erasedTrackId,
        'Erased tenant retrying course',
        {
          kind: 'copied',
          copiedFromCourseId: erasedCourse.course.courseId,
          copiedFromRevision: 1,
        },
      ),
      `course-${randomUUID()}`,
    );
    if (erasedRetryCourse.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    // A third course whose render stalls after preparing and publishes only after every
    // receipt for its key closed, and whose ledger row is then pruned: the orphan that only
    // the M2-01m reference index still names when the backup is taken.
    const erasedStalledCourse = await courseRepo.create(
      deletedAthlete,
      courseContent(
        erasedCourseFixture.activityId,
        erasedTrackId,
        'Erased tenant stalled render course',
        {
          kind: 'copied',
          copiedFromCourseId: erasedCourse.course.courseId,
          copiedFromRevision: 1,
        },
      ),
      `course-${randomUUID()}`,
    );
    if (erasedStalledCourse.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    await preferenceRepo.write(deletedAthlete, erasedCourse.course.courseId, { favourite: true });
    await preferenceRepo.createPrivacyZone(deletedAthlete, {
      name: 'Erased tenant protected area',
      center: [127.02, 37.5],
      radiusMeters: 200,
    });
    await courseRepo.storeRouteProposal(
      deletedAthlete,
      drillProposalInput(erasedCourse.course.courseId, 3),
    );
    await courseRepo.storeRouteCandidateSet(
      deletedAthlete,
      drillCandidateSetInput(erasedCourse.course.courseId, `req-${randomUUID()}`, 3),
    );

    // M2-01l: the stored picture of each course. A thumbnail is a derivative object —
    // drawn by its own least-privilege worker, published through the same private object
    // store as every other private object, and pointed at by a row the runtime owns. A
    // restore therefore has to bring back the row *and* the bytes, and a deletion has to
    // take both away again; neither is true of anything the earlier course checks cover.
    const drawnThumbnails = new Map<
      string,
      {
        storageRef: string;
        sha256: string;
        byteSize: number;
        vertexCount: number;
        rendererId: string;
        rendererVersion: string;
      }
    >();
    // Temporary objects written by a render that then failed retryably. Nothing published
    // them, so only the ledger row's `temporary_ref` still names them.
    const failedThumbnailTemporaryRefs: string[] = [];
    let stalledRender:
      | {
          jobId: string;
          temporaryKey: ReturnType<typeof createCourseThumbnailTemporaryObjectKey>;
          finalKey: ReturnType<typeof createCourseThumbnailFinalObjectKey>;
          drawn: ReturnType<typeof renderCourseThumbnail>;
        }
      | undefined;
    const drainThumbnailQueue = async () => {
      const thumbnailWorker = createCourseThumbnailWorkerRepository({
        connectionString: url('drill_source', 'drill_thumbnailer'),
      });
      try {
        const renderOneLease = async (lease: CourseThumbnailLease) => {
          const drawn = renderCourseThumbnail(lease.coordinates);
          const temporaryKey = createCourseThumbnailTemporaryObjectKey({
            tenantId: lease.athleteId,
            courseId: lease.courseId,
            jobId: lease.jobId,
          });
          const finalKey = createCourseThumbnailFinalObjectKey({
            tenantId: lease.athleteId,
            courseId: lease.courseId,
            revisionId: lease.revisionId,
            sha256: drawn.sha256,
          });
          await sourceObjectStorage.writeTemporary(
            temporaryKey,
            (async function* () {
              yield drawn.bytes;
            })(),
          );
          if (
            lease.athleteId === deletedAthlete &&
            lease.courseId === erasedRetryCourse.course.courseId
          ) {
            // A render that wrote its temporary object and then failed retryably: the row
            // waits for a retry an hour away, and its object is in the store and the archive.
            assert.ok(
              await thumbnailWorker.fail(lease, 'DRILL_RENDER_INTERRUPTED', {
                retryable: true,
                retryAfterSeconds: 3600,
              }),
            );
            failedThumbnailTemporaryRefs.push(temporaryKey);
            return;
          }
          if (
            lease.athleteId === deletedAthlete &&
            lease.courseId === erasedStalledCourse.course.courseId
          ) {
            // Prepared, and then the writer stalls before either storage call.
            assert.ok(
              await thumbnailWorker.prepare(lease, {
                storageRef: finalKey,
                sha256: drawn.sha256,
                byteSize: drawn.byteSize,
                vertexCount: drawn.vertexCount,
              }),
            );
            stalledRender = { jobId: lease.jobId, temporaryKey, finalKey, drawn };
            await sourceObjectStorage.delete(temporaryKey);
            return;
          }
          // Prepare first, publish second, finalize last: the database decides whether these
          // bytes may become the course's picture before the store makes them visible.
          assert.ok(
            await thumbnailWorker.prepare(lease, {
              storageRef: finalKey,
              sha256: drawn.sha256,
              byteSize: drawn.byteSize,
              vertexCount: drawn.vertexCount,
            }),
          );
          await sourceObjectStorage.publishTemporary(temporaryKey, finalKey, {
            sha256: drawn.sha256,
            sizeBytes: drawn.byteSize,
          });
          assert.equal(await thumbnailWorker.finalize(lease), 'ready');
          drawnThumbnails.set(`${lease.courseId}:${lease.courseRevision}`, {
            storageRef: finalKey,
            sha256: drawn.sha256,
            byteSize: drawn.byteSize,
            vertexCount: drawn.vertexCount,
            rendererId: drawn.rendererId,
            rendererVersion: drawn.rendererVersion,
          });
        };
        // The render queue is deliberately tenant-blind — one worker drains every tenant —
        // so drain it whole and look each course up afterwards rather than assuming the next
        // lease is the one this drill just queued.
        for (let attempt = 0; ; attempt += 1) {
          if (attempt >= 200) throw new Error('COURSE_THUMBNAIL_QUEUE_DID_NOT_DRAIN');
          const lease = await thumbnailWorker.lease(60);
          if (lease === null) break;
          await renderOneLease(lease);
        }
      } finally {
        await thumbnailWorker.close();
      }
    };
    await drainThumbnailQueue();
    // The erased tenant's course moves to a second revision after its first picture was
    // stored, so the restored ledger holds a superseded picture as well as the head one.
    const erasedCourseV2 = await courseRepo.update(
      deletedAthlete,
      erasedCourse.course.courseId,
      1,
      courseContent(
        erasedCourseFixture.activityId,
        erasedTrackId,
        'Erased tenant drill course renamed',
        { kind: 'renamed' },
      ),
      `course-${randomUUID()}`,
    );
    if (erasedCourseV2.status !== 'available') throw new Error('COURSE_SEED_FAILED');
    await drainThumbnailQueue();
    // The stalled render, taken through the exact sequence M2-01m reproduced: its lease,
    // fence and deadline pass; the real reaper abandons it and queues both keys; the queue
    // closes both receipts (the objects are absent, so there is nothing to delete — done here
    // by closing exactly those two rows rather than draining a queue that holds other drill
    // fixtures); the writer then wakes and publishes; a week later the real housekeeping
    // prunes the closed row. What is left is an object and one index row naming it.
    assert.ok(stalledRender);
    const orphan = stalledRender;
    await source.query(
      `UPDATE course_thumbnail
         SET created_at=clock_timestamp()-interval '4 hours',
             updated_at=clock_timestamp()-interval '4 hours',
             lease_until=clock_timestamp()-interval '3 hours',
             publication_lease_until=clock_timestamp()-interval '3 hours',
             expires_at=clock_timestamp()-interval '3 hours'
       WHERE job_id=$1`,
      [orphan.jobId],
    );
    const sourceCleanup = createResourceObjectCleanupRepository({
      connectionString: url('drill_source'),
      max: 1,
    });
    try {
      assert.ok((await sourceCleanup.reapCourseThumbnailRenders(100)) >= 1);
      const closedReceipts = await source.query(
        `UPDATE resource_object_cleanup SET completed_at=clock_timestamp(),attempts=1
         WHERE storage_ref=ANY($1::text[]) AND completed_at IS NULL`,
        [[orphan.temporaryKey, orphan.finalKey]],
      );
      assert.equal(closedReceipts.rowCount, 2);
      await sourceObjectStorage.writeTemporary(
        orphan.temporaryKey,
        (async function* () {
          yield orphan.drawn.bytes;
        })(),
      );
      await sourceObjectStorage.publishTemporary(orphan.temporaryKey, orphan.finalKey, {
        sha256: orphan.drawn.sha256,
        sizeBytes: orphan.drawn.byteSize,
      });
      await source.query(
        `UPDATE course_thumbnail
           SET created_at=clock_timestamp()-interval '9 days',
               expires_at=clock_timestamp()-interval '8 days'-interval '1 hour',
               publication_lease_until=clock_timestamp()-interval '8 days'-interval '2 hours',
               lease_until=NULL,lease_owner=NULL,lease_token=NULL,
               updated_at=clock_timestamp()-interval '8 days'
         WHERE job_id=$1`,
        [orphan.jobId],
      );
      assert.equal(await sourceCleanup.pruneCourseThumbnailHistory(100), 1);
    } finally {
      await sourceCleanup.close();
    }
    assert.equal(
      (await source.query('SELECT 1 FROM course_thumbnail WHERE job_id=$1', [orphan.jobId]))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await source.query(
          'SELECT 1 FROM course_thumbnail_object_ref WHERE storage_ref=$1 AND athlete_id=$2',
          [orphan.finalKey, deletedAthlete],
        )
      ).rowCount,
      1,
    );
    assert.ok(await sourceObjectStorage.stat(validateObjectKey(orphan.finalKey)));
    const retainedThumbnail = drawnThumbnails.get(`${retainedCourse.course.courseId}:1`);
    const doomedThumbnail = drawnThumbnails.get(`${doomedCourse.course.courseId}:1`);
    assert.ok(retainedThumbnail, 'the retained course was queued for a thumbnail');
    assert.ok(doomedThumbnail, 'the course of the doomed activity was queued for a thumbnail');
    assert.notEqual(retainedThumbnail.storageRef, doomedThumbnail.storageRef);
    for (const thumbnail of [retainedThumbnail, doomedThumbnail]) {
      const stored = await sourceObjectStorage.stat(validateObjectKey(thumbnail.storageRef));
      assert.ok(stored);
      assert.equal(stored.sizeBytes, thumbnail.byteSize);
    }
    const sourceThumbnailObject = await courseRepo.resolveThumbnailObject(
      retainedAthlete,
      retainedCourse.course.courseId,
    );
    assert.equal(sourceThumbnailObject?.storageRef, retainedThumbnail.storageRef);

    // Reviewed, explicitly coach-enabled resources. `RESTOREDRILLTOKEN` is a
    // single lexical token so the 'simple' text search matches both bodies.
    const coachResourceText =
      'RESTOREDRILLTOKEN recovery guidance.\n\nSecond paragraph of the reviewed guidance.';
    const seedCoachResource = async (owner: string, title: string) => {
      const created = await resourceRepo.create(owner, {
        sourceKind: 'text',
        title,
        category: 'guide',
        metadata: {},
        tags: [],
        favorite: false,
        text: coachResourceText,
        idempotencyKey: randomUUID(),
      });
      if (created.status !== 'available') throw new Error('COACH_RESOURCE_SEED_FAILED');
      const reviewed = await accessRepo.setReviewed(owner, created.resource.id, {
        reviewed: true,
        expectedAccessRevision: created.resource.accessRevision,
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: randomUUID(),
      });
      const enabled = await accessRepo.setCoachUse(owner, created.resource.id, {
        includeForCoach: true,
        expectedAccessRevision: reviewed.accessRevision,
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: randomUUID(),
      });
      assert.equal(enabled.coachUseAuthorized, true);
      return { resourceId: created.resource.id, versionId: created.version.id, state: enabled };
    };
    const retrievalRepo = createResourceRetrievalRepository(sourceDb);
    const retrievalQuery = { schemaVersion: 1 as const, query: 'RESTOREDRILLTOKEN', limit: 6 };
    const retainedCoachResource = await seedCoachResource(
      retainedAthlete,
      'Synthetic reviewed coach source',
    );
    // Sharing bumps the access revision, so it is granted on the source this
    // drill does not compare field by field against its pre-backup value.
    const sharedAccess = await accessRepo.grantShare(
      retainedAthlete,
      retainedCoachResource.resourceId,
      {
        granteeKind: 'coach',
        granteePrincipalId: `coach-${randomUUID()}`,
        expectedAccessRevision: retainedCoachResource.state.accessRevision,
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(sharedAccess.shares.length, 1);
    const sharedShareId = sharedAccess.shares[0]?.shareId;
    assert.ok(sharedShareId);
    const deletedCoachResource = await seedCoachResource(
      retainedAthlete,
      'Synthetic reviewed source deleted before backup',
    );
    const seededRetrieval = await retrievalRepo.retrieve(retainedAthlete, retrievalQuery);
    assert.equal(seededRetrieval.excerpts.length, 2);
    const retainedRunId = coachingRuns.get(retainedAthlete)?.run.id;
    assert.ok(retainedRunId);
    const retainedGrounding = await sourceDb.tenant(retainedAthlete, async (tx) => {
      const prepared = await prepareRunGrounding(tx, retrievalQuery.query);
      assert.equal(prepared.excerpts.length, 2);
      const groundingId = await writeRunGrounding(tx, retainedRunId, prepared);
      await recordRunCitations(
        tx,
        retainedRunId,
        prepared.excerpts.map((excerpt, claimIndex) => ({
          claimIndex,
          passageId: excerpt.passageId,
          quoteStart: 0,
          quoteEnd: Math.min(excerpt.text.length, 40),
        })),
      );
      return { groundingId, excerpts: prepared.excerpts };
    });
    assert.equal(retainedGrounding.excerpts.length, 2);
    const citedDeletedPassage = retainedGrounding.excerpts.find(
      (excerpt) => excerpt.resourceId === deletedCoachResource.resourceId,
    );
    assert.ok(citedDeletedPassage);

    // The same derived stores for an owner whose AI consent is withdrawn after
    // the backup: the restored cluster must not expose them once the withdrawal
    // ledger is replayed before runtime access.
    const withdrawnCoachResource = await seedCoachResource(
      withdrawnAthlete,
      'Synthetic reviewed source for withdrawn consent',
    );
    const withdrawnRetrieval = await retrievalRepo.retrieve(withdrawnAthlete, retrievalQuery);
    assert.equal(withdrawnRetrieval.excerpts.length, 1);
    await sourceDb.tenant(withdrawnAthlete, async (tx) => {
      const prepared = await prepareRunGrounding(tx, retrievalQuery.query);
      const only = prepared.excerpts[0];
      assert.ok(only);
      await writeRunGrounding(tx, withdrawnRun.run.id, prepared);
      await recordRunCitations(tx, withdrawnRun.run.id, [
        { claimIndex: 0, passageId: only.passageId, quoteStart: 0, quoteEnd: 20 },
      ]);
    });

    // Deleted before the backup: the access gate is already closed and a
    // derived cleanup manifest is open, while the index rows are still in the
    // dump. Restoration must not turn that into a resurrected excerpt.
    await resourceRepo.softDelete(retainedAthlete, deletedCoachResource.resourceId, {
      expectedAccessRevision: deletedCoachResource.state.accessRevision,
      expectedCurrentVersionId: deletedCoachResource.versionId,
      idempotencyKey: randomUUID(),
    });
    const afterDeleteRetrieval = await retrievalRepo.retrieve(retainedAthlete, retrievalQuery);
    assert.deepEqual(
      afterDeleteRetrieval.excerpts.map((excerpt) => excerpt.resourceId),
      [retainedCoachResource.resourceId],
    );
    assert.equal(
      (
        await source.query(
          'SELECT count(*)::int AS count FROM resource_passage WHERE athlete_id=$1 AND resource_id=$2',
          [retainedAthlete, deletedCoachResource.resourceId],
        )
      ).rows[0].count,
      1,
    );
    checks.push('access_shares_gallery_media_and_retrieval_derived_stores_seeded_before_backup');
    checks.push(
      'resource_deleted_before_backup_keeps_index_rows_but_is_already_gate_blocked_in_source',
    );

    // Include an erased owner in the backup consent manifest to exercise replay's erasure priority.
    // The private drill has no concurrent writers between this owner manifest and pg_dump.
    const backupAiOwners = (
      await source.query<{ athlete_id: string }>(
        "SELECT athlete_id FROM consent WHERE kind='ai' ORDER BY athlete_id",
      )
    ).rows.map((row) => row.athlete_id);
    assert.deepEqual(
      backupAiOwners,
      [
        withdrawnAthlete,
        absentConsentAthlete,
        deletedAthlete,
        retainedAthlete,
        removedConstraintAthlete,
      ].sort(),
    );
    // M2-01s: what the erased tenant owns in the course and track tables at backup time,
    // and every object key any of those rows names. The restore must bring all of it back
    // and the replayed erasure must take all of it away again — rows, index rows and bytes.
    const erasedTenantCourseTables = [
      'course',
      'course_revision',
      'course_revision_source',
      'course_route_proposal',
      'course_route_candidate_set',
      'course_preference',
      'course_privacy_zone',
      'course_thumbnail',
      'course_thumbnail_object_ref',
      'activity_track',
      'activity_track_revision',
      'activity_track_object',
      'activity_track_object_ref',
    ] as const;
    const countErasedTenantRows = async (owner: Pool) => {
      const counts: Record<string, number> = {};
      for (const table of erasedTenantCourseTables) {
        counts[table] =
          (
            await owner.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`,
              [deletedAthlete],
            )
          ).rows[0]?.count ?? -1;
      }
      return counts;
    };
    const erasedTenantBackupCounts = await countErasedTenantRows(source);
    for (const table of erasedTenantCourseTables)
      assert.ok(
        (erasedTenantBackupCounts[table] ?? 0) > 0,
        `the erased tenant has ${table} rows at backup time`,
      );
    assert.equal(erasedTenantBackupCounts['course'], 3);
    assert.ok((erasedTenantBackupCounts['course_revision'] ?? 0) >= 3);
    const erasedTenantThumbnailStates = (
      await source.query<{ state: string }>(
        'SELECT state FROM course_thumbnail WHERE athlete_id=$1 ORDER BY state',
        [deletedAthlete],
      )
    ).rows.map((row) => row.state);
    assert.deepEqual(erasedTenantThumbnailStates, ['failed', 'ready', 'superseded']);
    const erasedTenantObjectRefs = (
      await source.query<{ storage_ref: string }>(
        `SELECT refs.storage_ref FROM course_thumbnail t
           CROSS JOIN LATERAL (VALUES(t.temporary_ref),(t.storage_ref)) refs(storage_ref)
           WHERE t.athlete_id=$1 AND refs.storage_ref IS NOT NULL
         UNION SELECT storage_ref FROM activity_track_object WHERE athlete_id=$1
         UNION SELECT storage_ref FROM activity_track_object_ref WHERE athlete_id=$1
         UNION SELECT storage_ref FROM course_thumbnail_object_ref WHERE athlete_id=$1
         ORDER BY 1`,
        [deletedAthlete],
      )
    ).rows.map((row) => row.storage_ref);
    // Only the keys that are actual objects: a published render's temporary key was moved.
    const erasedTenantObjects: string[] = [];
    for (const ref of erasedTenantObjectRefs)
      if (await sourceObjectStorage.stat(validateObjectKey(ref))) erasedTenantObjects.push(ref);
    // Three track objects, two published pictures, one abandoned render's temporary object,
    // and the orphan only the reference index names.
    assert.equal(erasedTenantObjects.length, 7);
    assert.ok(erasedTenantObjects.includes(orphan.finalKey));
    for (const artifact of erasedTrack.artifacts)
      assert.ok(erasedTenantObjects.includes(artifact.storageRef));
    for (const ref of failedThumbnailTemporaryRefs) assert.ok(erasedTenantObjects.includes(ref));
    checks.push(
      'erased_tenant_courses_thumbnails_retries_index_only_orphan_and_track_objects_seeded_before_backup',
    );
    run(bin, 'pg_dump', [
      '-h',
      directory,
      '-U',
      'drill_admin',
      '-d',
      'drill_source',
      '--format=custom',
      '--file',
      archive,
    ]);
    await cp(sourceObjectRoot, objectArchive, { recursive: true, errorOnExist: true });
    await constraintRepo.update(retainedAthlete, oldConstraint.id, {
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true,
      text: 'Synthetic intermediate correction',
      idempotencyKey: randomUUID(),
    });
    await constraintRepo.update(retainedAthlete, oldConstraint.id, {
      expectedHeadRevision: 2,
      expectedRevision: 2,
      confirmed: true,
      text: 'Synthetic latest confirmed restriction',
      idempotencyKey: randomUUID(),
    });
    await constraintRepo.remove(removedConstraintAthlete, removedConstraint.id, {
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    assertCoachingCandidateRowsPurged(
      await readCoachingCandidateRows(source, removedConstraintAthlete, constraintCandidate),
      'source_deleted',
    );
    const revokedConsent = await createConsentRepository(sourceDb).setConsent(withdrawnAthlete, {
      kind: 'ai',
      granted: false,
      expectedRevision: aiConsent.revision,
      idempotencyKey: randomUUID(),
    });
    const withdrawnEvidence = await createCoreEvidenceSnapshotRepository(sourceDb).read(
      withdrawnAthlete,
      beforeWithdrawal.id,
    );
    assert.ok(withdrawnEvidence);
    assert.equal(withdrawnEvidence.status, 'purged');
    assert.ok(!('body' in withdrawnEvidence));
    await sourceDb.tenant(absentConsentAthlete, async (transaction) => {
      const deleted = await transaction.query(
        "DELETE FROM consent WHERE athlete_id=$1 AND kind='ai'",
        [absentConsentAthlete],
      );
      assert.equal(deleted.rowCount, 1);
    });
    const absentConsentEvidence = await createCoreEvidenceSnapshotRepository(sourceDb).read(
      absentConsentAthlete,
      beforeConsentDeletion.snapshot.id,
    );
    assert.ok(absentConsentEvidence?.status === 'purged');
    assert.deepEqual(
      await createConsentRepository(sourceDb).getConsent(absentConsentAthlete, 'ai'),
      { kind: 'ai', granted: false, revision: 0 },
    );
    assertCoachingCandidateRowsPurged(
      await readCoachingCandidateRows(source, withdrawnAthlete, withdrawnCandidate),
      'consent_withdrawn',
    );
    assertCoachingCandidateRowsPurged(
      await readCoachingCandidateRows(source, absentConsentAthlete, absentConsentCandidate),
      'consent_withdrawn',
    );
    // An activity of the tenant that is erased right after: its deletion is in the activity
    // ledger and its owner is in the erasure ledger, so the restore has to treat the entry as
    // already satisfied instead of failing the whole replay.
    const erasedFixture = fixtureActivities.get(deletedAthlete);
    assert.ok(erasedFixture);
    await createActivityRepository(sourceDb).deleteActivity(
      deletedAthlete,
      erasedFixture.activityId,
      { expectedRevision: erasedFixture.revision },
    );
    const overlappingDeletion = (
      await source.query<{
        athlete_id: string;
        activity_id: string;
        revision: number;
        kind: string;
        source_id: string;
      }>(
        `SELECT c.athlete_id,c.id AS activity_id,c.revision,s.kind,s.source_id
         FROM activity_canonical c JOIN activity_source_head s
           ON s.athlete_id=c.athlete_id AND s.activity_id=c.id
         WHERE c.athlete_id=$1 AND c.deleted`,
        [deletedAthlete],
      )
    ).rows;
    assert.equal(overlappingDeletion.length, 1);
    await createOperationsRepository(sourceDb).eraseAccount(deletedAthlete);
    const currentConstraints = await captureConstraintRestoreLedger(source, backupConstraintOwners);
    assert.throws(() =>
      parseConstraintRestoreLedger(
        {
          ...currentConstraints,
          subjects: currentConstraints.subjects.filter((row) => row.athleteId !== retainedAthlete),
        },
        backupConstraintOwners,
      ),
    );
    assert.throws(() =>
      parseConstraintRestoreLedger(
        {
          ...currentConstraints,
          subjects: currentConstraints.subjects.map((row) =>
            row.athleteId === retainedAthlete ? { ...row, rows: row.rows.slice(1) } : row,
          ),
        },
        backupConstraintOwners,
      ),
    );
    await writeFile(constraintLedgerFile, JSON.stringify(currentConstraints), {
      mode: 0o600,
      flag: 'wx',
    });
    // One SQL statement supplies both sets from the same MVCC snapshot after the withdrawal.
    const evidenceWithdrawalResult = await source.query<{ ledger: unknown }>(
      `
      WITH subjects AS (
        SELECT unnest($1::text[]) AS athlete_id
        UNION SELECT athlete_id FROM consent WHERE kind='ai'
        UNION SELECT athlete_id FROM core_evidence_snapshot
      )
      SELECT jsonb_build_object(
        'schemaVersion',2,
        'capturedAt',to_char(statement_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'subjects',(SELECT jsonb_agg(athlete_id ORDER BY athlete_id) FROM subjects),
        'snapshots',COALESCE((SELECT jsonb_agg(jsonb_build_object('athlete_id',athlete_id,'id',id,'purged_reason',purged_reason) ORDER BY athlete_id,id)
          FROM core_evidence_snapshot WHERE body IS NULL),'[]'::jsonb),
        'consents',(SELECT jsonb_agg(jsonb_build_object('athlete_id',s.athlete_id,'kind','ai','state',
          CASE WHEN c.athlete_id IS NULL THEN jsonb_build_object('kind','absent')
          ELSE jsonb_build_object('kind','exists','revision',c.revision,'granted',c.granted) END) ORDER BY s.athlete_id)
          FROM subjects s LEFT JOIN consent c ON c.athlete_id=s.athlete_id AND c.kind='ai')
      ) AS ledger`,
      [backupAiOwners],
    );
    const evidenceWithdrawalLedger = parseEvidenceWithdrawalLedger(
      evidenceWithdrawalResult.rows[0]?.ledger,
      backupAiOwners,
    );
    const expectedSubjects = [
      withdrawnAthlete,
      absentConsentAthlete,
      deletedAthlete,
      retainedAthlete,
      removedConstraintAthlete,
    ].sort();
    assert.deepEqual(evidenceWithdrawalLedger.subjects, expectedSubjects);
    assert.deepEqual(
      evidenceWithdrawalLedger.snapshots,
      [
        {
          athlete_id: withdrawnAthlete,
          id: beforeWithdrawal.id,
          purged_reason: 'consent_withdrawn',
        },
        {
          athlete_id: absentConsentAthlete,
          id: beforeConsentDeletion.snapshot.id,
          purged_reason: 'consent_withdrawn',
        },
        {
          athlete_id: removedConstraintAthlete,
          id: constraintSnapshot.id,
          purged_reason: 'source_deleted',
        },
      ].sort((left, right) => left.athlete_id.localeCompare(right.athlete_id)),
    );
    assert.deepEqual(
      evidenceWithdrawalLedger.consents,
      expectedSubjects.map((athlete_id) => ({
        athlete_id,
        kind: 'ai',
        state:
          athlete_id === withdrawnAthlete
            ? { kind: 'exists', revision: revokedConsent.revision, granted: false }
            : athlete_id === retainedAthlete || athlete_id === removedConstraintAthlete
              ? { kind: 'exists', revision: 1, granted: true }
              : { kind: 'absent' },
      })),
    );
    // Missing entries cannot silently mean absence: every declared and backup owner must be covered.
    assert.throws(() =>
      parseEvidenceWithdrawalLedger(
        {
          ...evidenceWithdrawalLedger,
          consents: evidenceWithdrawalLedger.consents.filter(
            (row) => row.athlete_id !== absentConsentAthlete,
          ),
        },
        backupAiOwners,
      ),
    );
    assert.throws(() =>
      parseEvidenceWithdrawalLedger(
        {
          ...evidenceWithdrawalLedger,
          subjects: evidenceWithdrawalLedger.subjects.filter((id) => id !== absentConsentAthlete),
          consents: evidenceWithdrawalLedger.consents.filter(
            (row) => row.athlete_id !== absentConsentAthlete,
          ),
        },
        backupAiOwners,
      ),
    );
    assert.throws(() =>
      parseEvidenceWithdrawalLedger(
        {
          ...evidenceWithdrawalLedger,
          consents: evidenceWithdrawalLedger.consents.map((row) =>
            row.athlete_id === absentConsentAthlete
              ? { ...row, state: { kind: 'absent', granted: true } }
              : row,
          ),
        },
        backupAiOwners,
      ),
    );
    checks.push('withdrawal_ledger_requires_complete_owner_coverage_and_explicit_absence');
    await writeFile(evidenceWithdrawalLedgerFile, JSON.stringify(evidenceWithdrawalLedger), {
      mode: 0o600,
      flag: 'wx',
    });
    checks.push('post_backup_evidence_withdrawal_and_consent_ledger_captured_atomically');
    const ledger = (
      await source.query<{ athlete_id: string }>(
        'SELECT athlete_id FROM tenant_erasure ORDER BY athlete_id',
      )
    ).rows;
    await writeFile(ledgerFile, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
    const cleanupLedger = (
      await source.query('SELECT * FROM garmin_private.revocation ORDER BY id')
    ).rows;
    assert.equal(cleanupLedger.length, 1);
    await writeFile(cleanupLedgerFile, JSON.stringify(cleanupLedger), { mode: 0o600, flag: 'wx' });
    assert.deepEqual(
      ledger.map((row) => row.athlete_id),
      [deletedAthlete],
    );
    checks.push('post_backup_erasure_ledger_captured_separately');
    // Deleting a tracked activity after the backup. The dump still holds its track and its
    // three objects are still in the object archive, so the restore has to re-apply this
    // suppression before anyone can read, download, export or re-import it.
    await createActivityRepository(sourceDb).deleteActivity(
      retainedAthlete,
      doomedImport.activityId,
      { expectedRevision: doomedImport.revision },
    );
    const activityDeletionLedger = (
      await source.query<{
        athlete_id: string;
        activity_id: string;
        revision: number;
        kind: string;
        source_id: string;
      }>(
        `SELECT c.athlete_id,c.id AS activity_id,c.revision,s.kind,s.source_id
         FROM activity_canonical c JOIN activity_source_head s
           ON s.athlete_id=c.athlete_id AND s.activity_id=c.id
         WHERE c.deleted ORDER BY c.athlete_id,c.id`,
      )
    ).rows;
    assert.deepEqual(
      activityDeletionLedger.map((row) => row.activity_id),
      [doomedImport.activityId],
    );
    // The erased tenant's rows are gone from the source, so its entry is carried from the
    // capture taken before the erasure. The ledger therefore overlaps the erasure ledger.
    const combinedDeletionLedger = [...activityDeletionLedger, ...overlappingDeletion];
    assert.ok(
      combinedDeletionLedger.some((row) => row.athlete_id === deletedAthlete) &&
        combinedDeletionLedger.some((row) => row.athlete_id === retainedAthlete),
    );
    await writeFile(activityDeletionLedgerFile, JSON.stringify(combinedDeletionLedger), {
      mode: 0o600,
      flag: 'wx',
    });
    // The source has already reclaimed those objects, so only the archive still holds them.
    checks.push('post_backup_activity_deletion_ledger_captured_separately');
    run(bin, 'pg_restore', [
      '-h',
      directory,
      '-U',
      'drill_admin',
      '-d',
      'drill_restore',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      archive,
    ]);
    await cp(objectArchive, restoredObjectRoot, { recursive: true, errorOnExist: true });
    const restored = pool('drill_restore');
    // M2-01s: the archive predates the erasure, so before any replay the restored cluster
    // holds every course row and every object the erased tenant had. This is what makes
    // the checks after the replay mean something.
    assert.deepEqual(await countErasedTenantRows(restored), erasedTenantBackupCounts);
    const restoredObjectStorageBeforeReplay =
      await createLocalFilesystemObjectStorage(restoredObjectRoot);
    for (const ref of erasedTenantObjects)
      assert.ok(await restoredObjectStorageBeforeReplay.stat(validateObjectKey(ref)));
    checks.push('restore_brings_back_erased_tenant_course_rows_and_objects_before_replay');
    // Admin inspection only: the runtime has not connected to the restored database yet.
    const restoredOldEvidence = await restored.query<{ body: unknown; purged_reason: unknown }>(
      'SELECT body,purged_reason FROM core_evidence_snapshot WHERE athlete_id=$1 AND id=$2',
      [withdrawnAthlete, beforeWithdrawal.id],
    );
    assert.equal(beforeWithdrawal.status, 'available');
    if (beforeWithdrawal.status !== 'available')
      throw new Error('Expected pre-withdrawal evidence');
    assert.deepEqual(restoredOldEvidence.rows, [
      { body: beforeWithdrawal.body, purged_reason: null },
    ]);
    assert.deepEqual(
      (
        await restored.query(
          'SELECT body,purged_reason FROM coaching_analysis_output WHERE athlete_id=$1 AND id=$2',
          [withdrawnAthlete, withdrawnRun.outputId],
        )
      ).rows,
      [{ body: withdrawnRun.body, purged_reason: null }],
    );
    assertCoachingCandidateRowsAvailable(
      await readCoachingCandidateRows(restored, withdrawnAthlete, withdrawnCandidate),
      withdrawnCandidate,
    );
    assert.deepEqual(
      (
        await restored.query(
          'SELECT kind,revision,granted FROM consent WHERE athlete_id=$1 AND kind=$2',
          [withdrawnAthlete, 'ai'],
        )
      ).rows,
      [aiConsent],
    );
    assert.deepEqual(
      (
        await restored.query(
          'SELECT body,purged_reason FROM core_evidence_snapshot WHERE athlete_id=$1 AND id=$2',
          [absentConsentAthlete, beforeConsentDeletion.snapshot.id],
        )
      ).rows,
      [{ body: beforeConsentDeletion.snapshot.body, purged_reason: null }],
    );
    assert.deepEqual(
      (
        await restored.query(
          'SELECT body,purged_reason FROM coaching_analysis_output WHERE athlete_id=$1 AND id=$2',
          [absentConsentAthlete, absentConsentRun.outputId],
        )
      ).rows,
      [{ body: absentConsentRun.body, purged_reason: null }],
    );
    assertCoachingCandidateRowsAvailable(
      await readCoachingCandidateRows(restored, absentConsentAthlete, absentConsentCandidate),
      absentConsentCandidate,
    );
    assertCoachingCandidateRowsAvailable(
      await readCoachingCandidateRows(restored, removedConstraintAthlete, constraintCandidate),
      constraintCandidate,
    );
    assert.deepEqual(
      (
        await restored.query(
          "SELECT kind,revision,granted FROM consent WHERE athlete_id=$1 AND kind='ai'",
          [absentConsentAthlete],
        )
      ).rows,
      [beforeConsentDeletion.consent],
    );
    checks.push('trusted_archive_contains_pre_withdrawal_evidence_ai_consent_and_candidate_bodies');
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM activity_canonical WHERE athlete_id=$1',
          [deletedAthlete],
        )
      ).rows[0].count,
      2,
    );
    checks.push('trusted_custom_archive_restored_pre_deletion_rows');
    for (const table of selfReportTables) {
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            deletedAthlete,
          ])
        ).rows[0].count,
        table === 'plan_scenario_revision' || table === 'coaching_message' ? 2 : 1,
      );
    }
    const replayLedger: unknown = JSON.parse(await readFile(ledgerFile, 'utf8'));
    assert.ok(Array.isArray(replayLedger));
    const replayWithdrawalLedger = parseEvidenceWithdrawalLedger(
      JSON.parse(await readFile(evidenceWithdrawalLedgerFile, 'utf8')) as unknown,
      backupAiOwners,
    );
    assert.deepEqual(replayWithdrawalLedger, evidenceWithdrawalLedger);
    await restored.query('BEGIN');
    try {
      for (const entry of replayLedger) {
        assert.ok(
          typeof entry === 'object' &&
            entry !== null &&
            'athlete_id' in entry &&
            typeof entry.athlete_id === 'string',
        );
        await restored.query("SELECT set_config('app.athlete_id',$1,true)", [entry.athlete_id]);
        await restored.query('SELECT public.erase_account($1)', [entry.athlete_id]);
      }
      await restoreConstraintLedger(
        restored,
        parseConstraintRestoreLedger(
          JSON.parse(await readFile(constraintLedgerFile, 'utf8')) as unknown,
          backupConstraintOwners,
        ),
      );
      // Test fail-closed replay against real restored rows. The helper deliberately does not
      // commit/rollback: maintenance owns the transaction, including earlier owner changes.
      const safeConstraints = await captureConstraintRestoreLedger(
        restored,
        backupConstraintOwners,
      );
      const originalConstraintSubject = backupConstraintLedger.subjects.find(
        (row) => row.athleteId === retainedAthlete,
      );
      const safeConstraintHead = safeConstraints.subjects.find(
        (row) => row.athleteId === removedConstraintAthlete,
      )?.head;
      assert.ok(originalConstraintSubject && safeConstraintHead);
      const invalidConstraintLedgers = [
        {
          ...safeConstraints,
          subjects: safeConstraints.subjects.filter((row) => row.athleteId !== retainedAthlete),
        },
        {
          ...safeConstraints,
          subjects: safeConstraints.subjects.map((row) =>
            row.athleteId === retainedAthlete ? { ...row, rows: row.rows.slice(1) } : row,
          ),
        },
        {
          ...safeConstraints,
          subjects: safeConstraints.subjects.map((row) =>
            row.athleteId === retainedAthlete
              ? {
                  ...row,
                  rows: row.rows.map((item) =>
                    item.deleted
                      ? item
                      : { ...item, text: 'Synthetic same-revision contradiction' },
                  ),
                }
              : row,
          ),
        },
        {
          ...safeConstraints,
          subjects: safeConstraints.subjects.map((row) =>
            row.athleteId === retainedAthlete ? originalConstraintSubject : row,
          ),
        },
        {
          ...safeConstraints,
          subjects: safeConstraints.subjects.map((row) =>
            row.athleteId === removedConstraintAthlete
              ? {
                  ...row,
                  head: { ...safeConstraintHead, revision: safeConstraintHead.revision + 1 },
                  rows: row.rows.map((item) =>
                    item.deleted
                      ? {
                          ...item,
                          revision: item.revision + 1,
                          deleted: false,
                          text: 'Synthetic forbidden resurrection',
                        }
                      : item,
                  ),
                }
              : row,
          ),
        },
      ];
      for (const invalid of invalidConstraintLedgers) {
        await restored.query('SAVEPOINT invalid_constraint_replay');
        await restored.query("SELECT set_config('app.athlete_id',$1,true)", [retainedAthlete]);
        await restored.query(
          "UPDATE coaching_constraint_head SET updated_at='2000-01-01T00:00:00Z' WHERE athlete_id=$1",
          [retainedAthlete],
        );
        await assert.rejects(() => restoreConstraintLedger(restored, invalid));
        await restored.query('ROLLBACK TO SAVEPOINT invalid_constraint_replay');
        await restored.query('RELEASE SAVEPOINT invalid_constraint_replay');
        assert.deepEqual(
          (await captureConstraintRestoreLedger(restored, backupConstraintOwners)).subjects,
          safeConstraints.subjects,
        );
      }
      checks.push(
        'invalid_constraint_ledger_owner_row_revision_and_tombstone_replay_fails_closed_with_caller_rollback',
      );
      // Owner maintenance runs before runtime access; tenant context is required by immutable triggers.
      for (const entry of replayWithdrawalLedger.snapshots) {
        await restored.query("SELECT set_config('app.athlete_id',$1,true)", [entry.athlete_id]);
        await restored.query(
          'UPDATE core_evidence_snapshot SET body=NULL,purged_reason=$3 WHERE athlete_id=$1 AND id=$2 AND body IS NOT NULL',
          [entry.athlete_id, entry.id, entry.purged_reason],
        );
      }
      let skippedErasedConsentOwners = 0;
      for (const consent of replayWithdrawalLedger.consents) {
        await restored.query("SELECT set_config('app.athlete_id',$1,true)", [consent.athlete_id]);
        const erased = await restored.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [
          consent.athlete_id,
        ]);
        if (erased.rowCount !== 0) {
          assert.equal(
            (
              await restored.query('SELECT 1 FROM consent WHERE athlete_id=$1', [
                consent.athlete_id,
              ])
            ).rowCount,
            0,
          );
          skippedErasedConsentOwners++;
          continue;
        }
        if (consent.state.kind === 'absent') {
          await restored.query("DELETE FROM consent WHERE athlete_id=$1 AND kind='ai'", [
            consent.athlete_id,
          ]);
          assert.equal(
            (
              await restored.query("SELECT 1 FROM consent WHERE athlete_id=$1 AND kind='ai'", [
                consent.athlete_id,
              ])
            ).rowCount,
            0,
          );
          continue;
        }
        // Fail closed if the purported latest ledger would overwrite a newer or contradictory state.
        const applied = await restored.query(
          `INSERT INTO consent(athlete_id,kind,revision,granted) VALUES($1,$2,$3,$4)
           ON CONFLICT(athlete_id,kind) DO UPDATE SET revision=EXCLUDED.revision,granted=EXCLUDED.granted
           WHERE consent.revision<EXCLUDED.revision OR (consent.revision=EXCLUDED.revision AND consent.granted=EXCLUDED.granted)
           RETURNING athlete_id`,
          [consent.athlete_id, consent.kind, consent.state.revision, consent.state.granted],
        );
        assert.equal(applied.rowCount, 1);
      }
      assert.equal(skippedErasedConsentOwners, 1);
      await restored.query('DELETE FROM identity_private.session');
      await restored.query('DELETE FROM identity_private.login_attempt');
      // Old backup grants can have been rotated/disconnected since the snapshot.
      // Retain domain data, but require fresh OAuth and replay only the latest cleanup ledger.
      await restored.query('DELETE FROM garmin_attempt');
      await restored.query(
        "UPDATE garmin_connection SET generation=generation+1,state='reconnect_required',encrypted_tokens=NULL,user_id=NULL,permissions='[]',connected_at=NULL,access_expires_at=NULL,refresh_expires_at=NULL,lease_id=NULL,lease_until=NULL,attempt_expires_at=NULL,attempt_session_id=NULL",
      );
      await restored.query('DELETE FROM garmin_private.revocation');
      await restored.query('DELETE FROM garmin_private.ownership');
      const cleanupJson = await readFile(cleanupLedgerFile, 'utf8');
      await restored.query(
        'INSERT INTO garmin_private.revocation SELECT * FROM jsonb_populate_recordset(NULL::garmin_private.revocation,$1::jsonb)',
        [cleanupJson],
      );
      await restored.query(
        'UPDATE garmin_private.revocation SET lease_id=NULL,lease_until=NULL,prepared=false',
      );
      // Activity deletions that happened after the backup are suppression, not a cache:
      // the restored cluster must re-apply them before any runtime read, and must reclaim
      // the track objects the archive brought back with them.
      const activityDeletionJson: unknown = JSON.parse(
        await readFile(activityDeletionLedgerFile, 'utf8'),
      );
      assert.ok(Array.isArray(activityDeletionJson) && activityDeletionJson.length > 0);
      let replayedDeletions = 0;
      let erasureSatisfiedDeletions = 0;
      for (const entry of activityDeletionJson) {
        assert.ok(typeof entry === 'object' && entry !== null && !Array.isArray(entry));
        const row = entry as Record<string, unknown>;
        const owner = row['athlete_id'];
        const activityId = row['activity_id'];
        const kind = row['kind'];
        const sourceId = row['source_id'];
        const revision = row['revision'];
        assert.ok(
          typeof owner === 'string' &&
            typeof activityId === 'string' &&
            typeof kind === 'string' &&
            typeof sourceId === 'string' &&
            typeof revision === 'number' &&
            Number.isInteger(revision) &&
            revision > 0,
        );
        await restored.query("SELECT set_config('app.athlete_id',$1,true)", [owner]);
        const erased = await restored.query('SELECT 1 FROM tenant_erasure WHERE athlete_id=$1', [
          owner,
        ]);
        if (erased.rowCount !== 0) {
          // Erasure already removed this tenant's activities, which satisfies the entry
          // more completely than suppression would. Counted, not silently skipped, so a
          // ledger entry can never be lost without the count showing it.
          assert.equal(
            (
              await restored.query(
                'SELECT 1 FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
                [owner, activityId],
              )
            ).rowCount,
            0,
          );
          erasureSatisfiedDeletions += 1;
          continue;
        }
        await restored.query(
          `INSERT INTO activity_suppression(athlete_id,kind,source_id) VALUES($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [owner, kind, sourceId],
        );
        // Fail closed if the restored row is already ahead of the ledger.
        const applied = await restored.query(
          `UPDATE activity_canonical SET deleted=true,revision=$3
           WHERE athlete_id=$1 AND id=$2 AND revision<=$3 RETURNING id`,
          [owner, activityId, revision],
        );
        assert.equal(applied.rowCount, 1);
        replayedDeletions += 1;
      }
      assert.equal(replayedDeletions + erasureSatisfiedDeletions, activityDeletionJson.length);
      assert.equal(erasureSatisfiedDeletions, 1);
      await restored.query('COMMIT');
    } catch (error) {
      await restored.query('ROLLBACK');
      throw error;
    }
    checks.push('latest_erasure_replayed_before_runtime_access');
    checks.push('latest_activity_deletion_suppression_replayed_before_runtime_access');
    checks.push('overlapping_erasure_and_activity_deletion_ledgers_replay_without_rollback');
    checks.push('latest_evidence_withdrawal_and_consent_replayed_before_runtime_access');
    assertCoachingCandidateRowsPurged(
      await readCoachingCandidateRows(restored, withdrawnAthlete, withdrawnCandidate),
      'consent_withdrawn',
    );
    assertCoachingCandidateRowsPurged(
      await readCoachingCandidateRows(restored, absentConsentAthlete, absentConsentCandidate),
      'consent_withdrawn',
    );
    assertCoachingCandidateRowsPurged(
      await readCoachingCandidateRows(restored, removedConstraintAthlete, constraintCandidate),
      'source_deleted',
    );
    checks.push('candidate_bodies_and_digest_purged_by_pre_runtime_withdrawal_and_deletion_replay');
    const tables = [
      'consent',
      'command_receipt',
      'outbox',
      'plan_snapshot',
      'plan_head',
      'plan_history',
      'activity_canonical',
      'activity_source_head',
      'activity_source_revision',
      'activity_overlay',
      'activity_overlay_revision',
      'activity_suppression',
      'activity_import_receipt',
      'resource',
      'resource_version',
      'resource_url_ingestion',
      'resource_url_ingestion_attempt',
      'resource_url_fetch_hop',
      'resource_url_artifact',
      'resource_url_provenance',
      'resource_url_locator',
    ];
    for (const table of tables) {
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            deletedAthlete,
          ])
        ).rows[0].count,
        0,
      );
    }
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM identity_private.account WHERE athlete_id=$1',
          [deletedAthlete],
        )
      ).rows[0].count,
      0,
    );
    checks.push('deleted_tenant_absent_from_all_health_and_command_tables_and_identity');
    // M2-01s: the replayed erasure reaches every course table, the reconciliation index and
    // the track tables, and queues every object any of those rows named.
    assert.deepEqual(
      await countErasedTenantRows(restored),
      Object.fromEntries(erasedTenantCourseTables.map((table) => [table, 0])),
    );
    // Every one of them has an open `account_erased` receipt that is already due. The orphan
    // arrived with a receipt that had closed before the backup; the replay has to reopen it.
    const erasedTenantQueue = (
      await restored.query<{ storage_ref: string; reason: string; open: boolean; due: boolean }>(
        `SELECT storage_ref,reason,completed_at IS NULL AS open,
           available_at<=clock_timestamp() AS due
         FROM resource_object_cleanup WHERE storage_ref=ANY($1::text[]) ORDER BY storage_ref`,
        [erasedTenantObjects],
      )
    ).rows;
    assert.deepEqual(
      erasedTenantQueue,
      [...erasedTenantObjects]
        .sort()
        .map((storage_ref) => ({ storage_ref, reason: 'account_erased', open: true, due: true })),
    );
    checks.push('erased_tenant_course_rows_and_reference_index_absent_after_erasure_replay');
    for (const table of selfReportTables) {
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            deletedAthlete,
          ])
        ).rows[0].count,
        0,
      );
    }
    assert.equal(
      (await restored.query('SELECT count(*)::int AS count FROM identity_private.session')).rows[0]
        .count,
      0,
    );
    assert.equal(
      (await restored.query('SELECT count(*)::int AS count FROM identity_private.login_attempt'))
        .rows[0].count,
      0,
    );
    checks.push('restored_sessions_and_login_attempts_invalidated');
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM garmin_connection WHERE encrypted_tokens IS NOT NULL',
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (await restored.query('SELECT count(*)::int AS count FROM garmin_attempt')).rows[0].count,
      0,
    );
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM garmin_connection WHERE athlete_id=$1',
          [deletedAthlete],
        )
      ).rows[0].count,
      0,
    );
    const replayedCleanup = (
      await restored.query('SELECT * FROM garmin_private.revocation ORDER BY id')
    ).rows;
    assert.deepEqual(replayedCleanup, cleanupLedger);
    checks.push('all_restored_garmin_credentials_invalidated_latest_cleanup_ledger_preserved');
    const restoreDb = database('drill_restore');
    const restoredConstraints = createCoachingConstraintRepository(restoreDb);
    assert.deepEqual(
      await restoredConstraints.list(retainedAthlete),
      await constraintRepo.list(retainedAthlete),
    );
    assert.deepEqual(
      await restoredConstraints.create(retainedAthlete, oldConstraintCommand),
      oldConstraint,
    );
    assert.deepEqual(
      await restoredConstraints.create(removedConstraintAthlete, removedConstraintCommand),
      removedConstraint,
    );
    const constraintRows = (
      await restored.query(
        'SELECT text,deleted FROM coaching_constraint WHERE athlete_id=ANY($1::text[]) ORDER BY id',
        [[retainedAthlete, removedConstraintAthlete]],
      )
    ).rows;
    assert.equal(constraintRows.filter((row) => row.deleted && row.text === null).length, 1);
    assert.equal(
      constraintRows.filter(
        (row) => !row.deleted && row.text === 'Synthetic latest confirmed restriction',
      ).length,
      1,
    );
    assert.ok(!JSON.stringify(constraintRows).includes('Synthetic old restriction'));
    await assert.rejects(() => restoredConstraints.list(deletedAthlete), TenantErasedError);
    checks.push(
      'latest_constraint_ledger_replaces_backup_text_and_preserves_null_tombstones_before_runtime_access',
    );
    const constraintEvidenceRepo = createCoreEvidenceSnapshotRepository(restoreDb);
    const purgedConstraintEvidence = await constraintEvidenceRepo.read(
      removedConstraintAthlete,
      constraintSnapshot.id,
    );
    assert.ok(purgedConstraintEvidence?.status === 'purged');
    assert.equal(purgedConstraintEvidence.reason, 'source_deleted');
    assert.deepEqual(
      await constraintEvidenceRepo.capture(
        removedConstraintAthlete,
        constraintThread.appended.thread.id,
        constraintCapture,
      ),
      purgedConstraintEvidence,
    );
    const constraintExport =
      await createOperationsRepository(restoreDb).exportAccount(removedConstraintAthlete);
    assert.ok(constraintExport.schemaVersion === 22);
    assert.equal(constraintExport.data.evidenceSnapshots[0]?.body, null);
    assert.equal(constraintExport.data.coachingDecisions[0]?.body, null);
    assert.equal(constraintExport.data.coachingDecisions[0]?.purged_reason, 'source_deleted');
    assert.equal(constraintExport.data.coachingProposals[0]?.body, null);
    assert.equal(constraintExport.data.coachingProposals[0]?.purged_reason, 'source_deleted');
    assert.equal(constraintExport.data.coachingCandidates[0]?.body, null);
    assert.equal(constraintExport.data.coachingCandidates[0]?.digest, null);
    assert.equal(constraintExport.data.coachingCandidates[0]?.purged_reason, 'source_deleted');
    checks.push(
      'latest_constraint_deletion_purges_frozen_evidence_and_capture_receipt_before_runtime_access',
    );

    checks.push(
      'old_constraint_receipts_replay_metadata_without_restoring_deleted_or_corrected_text',
    );
    const withdrawnRepository = createCoreEvidenceSnapshotRepository(restoreDb);
    assert.deepEqual(
      await withdrawnRepository.read(withdrawnAthlete, beforeWithdrawal.id),
      withdrawnEvidence,
    );
    assert.deepEqual(
      await withdrawnRepository.capture(
        withdrawnAthlete,
        beforeWithdrawal.threadId,
        withdrawnCommand,
      ),
      withdrawnEvidence,
    );
    assert.deepEqual(
      await createConsentRepository(restoreDb).getConsent(withdrawnAthlete, 'ai'),
      revokedConsent,
    );
    const withdrawnExport =
      await createOperationsRepository(restoreDb).exportAccount(withdrawnAthlete);
    if (withdrawnExport.schemaVersion !== 22) throw new Error('Expected evidence export v22');
    assert.equal(withdrawnExport.data.evidenceSnapshots.length, 1);
    assert.equal(withdrawnExport.data.evidenceSnapshots[0]?.id, beforeWithdrawal.id);
    assert.equal(withdrawnExport.data.evidenceSnapshots[0]?.body, null);
    assert.equal(withdrawnExport.data.evidenceSnapshots[0]?.purged_reason, 'consent_withdrawn');
    assert.equal(withdrawnExport.data.coachingRuns[0]?.id, withdrawnRun.run.id);
    assert.equal(withdrawnExport.data.coachingAnalysisOutputs[0]?.id, withdrawnRun.outputId);
    assert.equal(withdrawnExport.data.coachingAnalysisOutputs[0]?.body, null);
    assert.equal(
      withdrawnExport.data.coachingAnalysisOutputs[0]?.purged_reason,
      'consent_withdrawn',
    );
    assert.equal(withdrawnExport.data.coachingDecisions[0]?.id, withdrawnCandidate.decision.id);
    assert.equal(withdrawnExport.data.coachingDecisions[0]?.body, null);
    assert.equal(withdrawnExport.data.coachingDecisions[0]?.purged_reason, 'consent_withdrawn');
    assert.equal(withdrawnExport.data.coachingProposals[0]?.id, withdrawnCandidate.proposal.id);
    assert.equal(withdrawnExport.data.coachingProposals[0]?.body, null);
    assert.equal(withdrawnExport.data.coachingProposals[0]?.purged_reason, 'consent_withdrawn');
    assert.equal(withdrawnExport.data.coachingCandidates[0]?.id, withdrawnCandidate.candidate.id);
    assert.equal(withdrawnExport.data.coachingCandidates[0]?.body, null);
    assert.equal(withdrawnExport.data.coachingCandidates[0]?.digest, null);
    assert.equal(withdrawnExport.data.coachingCandidates[0]?.purged_reason, 'consent_withdrawn');
    assert.ok(!JSON.stringify(withdrawnExport).includes(withdrawnRun.body.synthetic));
    for (const body of [
      withdrawnCandidate.decision.body,
      withdrawnCandidate.proposal.body,
      withdrawnCandidate.candidate.body,
    ]) {
      assert.ok(!JSON.stringify(withdrawnExport).includes(body.synthetic));
    }
    assert.deepEqual(withdrawnExport.data.consents, [revokedConsent]);
    checks.push(
      'restored_withdrawn_evidence_and_model_output_stay_purged_in_read_export_and_receipt',
    );
    assert.deepEqual(
      await withdrawnRepository.read(absentConsentAthlete, beforeConsentDeletion.snapshot.id),
      absentConsentEvidence,
    );
    assert.deepEqual(
      await withdrawnRepository.capture(
        absentConsentAthlete,
        beforeConsentDeletion.snapshot.threadId,
        beforeConsentDeletion.command,
      ),
      absentConsentEvidence,
    );
    assert.deepEqual(
      await createConsentRepository(restoreDb).getConsent(absentConsentAthlete, 'ai'),
      { kind: 'ai', granted: false, revision: 0 },
    );
    const absentExport =
      await createOperationsRepository(restoreDb).exportAccount(absentConsentAthlete);
    if (absentExport.schemaVersion !== 22) throw new Error('Expected evidence export v22');
    assert.deepEqual(absentExport.data.consents, []);
    assert.equal(absentExport.data.evidenceSnapshots.length, 1);
    assert.equal(absentExport.data.evidenceSnapshots[0]?.id, beforeConsentDeletion.snapshot.id);
    assert.equal(absentExport.data.evidenceSnapshots[0]?.body, null);
    assert.equal(absentExport.data.evidenceSnapshots[0]?.purged_reason, 'consent_withdrawn');
    assert.equal(absentExport.data.coachingRuns[0]?.id, absentConsentRun.run.id);
    assert.equal(absentExport.data.coachingAnalysisOutputs[0]?.id, absentConsentRun.outputId);
    assert.equal(absentExport.data.coachingAnalysisOutputs[0]?.body, null);
    assert.equal(absentExport.data.coachingAnalysisOutputs[0]?.purged_reason, 'consent_withdrawn');
    assert.equal(absentExport.data.coachingDecisions[0]?.id, absentConsentCandidate.decision.id);
    assert.equal(absentExport.data.coachingDecisions[0]?.body, null);
    assert.equal(absentExport.data.coachingDecisions[0]?.purged_reason, 'consent_withdrawn');
    assert.equal(absentExport.data.coachingProposals[0]?.id, absentConsentCandidate.proposal.id);
    assert.equal(absentExport.data.coachingProposals[0]?.body, null);
    assert.equal(absentExport.data.coachingProposals[0]?.purged_reason, 'consent_withdrawn');
    assert.equal(absentExport.data.coachingCandidates[0]?.id, absentConsentCandidate.candidate.id);
    assert.equal(absentExport.data.coachingCandidates[0]?.body, null);
    assert.equal(absentExport.data.coachingCandidates[0]?.digest, null);
    assert.equal(absentExport.data.coachingCandidates[0]?.purged_reason, 'consent_withdrawn');
    assert.ok(!JSON.stringify(absentExport).includes(absentConsentRun.body.synthetic));
    for (const body of [
      absentConsentCandidate.decision.body,
      absentConsentCandidate.proposal.body,
      absentConsentCandidate.candidate.body,
    ]) {
      assert.ok(!JSON.stringify(absentExport).includes(body.synthetic));
    }
    checks.push(
      'restored_deleted_ai_consent_remains_absent_and_evidence_and_model_output_stay_purged',
    );
    checks.push(
      'withdrawn_and_absent_ai_consent_candidate_bodies_and_digest_stay_purged_in_export',
    );
    assert.equal(
      (await createGarminStore(restoreDb).status(retainedAthlete)).state,
      'reconnect_required',
    );
    assert.equal(
      (await createConsentRepository(restoreDb).getConsent(retainedAthlete, 'app')).granted,
      true,
    );
    assert.equal(
      (await createActivityRepository(restoreDb).listActivities(retainedAthlete)).total,
      2,
    );
    const restoredResourceRepo = createPrivateTextResourceRepository(restoreDb);
    assert.deepEqual(
      await restoredResourceRepo.read(retainedAthlete, retainedResourceV2.resource.id),
      retainedResourceV2,
    );
    const restoredHistorical = await restoredResourceRepo.read(
      retainedAthlete,
      retainedResourceV1.resource.id,
      { versionId: retainedResourceV1.version.id },
    );
    assert.equal(restoredHistorical.status, 'available');
    if (restoredHistorical.status !== 'available') throw new Error('RESOURCE_RESTORE_FAILED');
    assert.equal(restoredHistorical.reader.originalText, 'Version one restore body.');
    await assert.rejects(
      () => restoredResourceRepo.read(deletedAthlete, deletedResource.resource.id),
      TenantErasedError,
    );
    checks.push('private_resource_current_and_pinned_versions_restored_through_runtime_rls');
    const restoredFileRepository = createResourceFileUploadRepository(restoreDb);
    const restoredFile = await restoredFileRepository.resolveObject(
      retainedAthlete,
      retainedFileResource.resource.id,
      retainedFileResource.version.id,
    );
    assert.ok(restoredFile);
    assert.equal(restoredFile.file.extension, 'markdown');
    const restoredObjectStorage = await createLocalFilesystemObjectStorage(restoredObjectRoot);
    const restoredObject = await restoredObjectStorage.open(storedFile.key);
    assert.ok(restoredObject);
    const restoredChunks: Uint8Array[] = [];
    for await (const chunk of restoredObject.body) restoredChunks.push(chunk);
    assert.deepEqual(Buffer.concat(restoredChunks), fileBytes);
    checks.push('private_resource_file_metadata_and_raw_object_archive_restored_together');
    assert.deepEqual(
      await restoredResourceRepo.read(retainedAthlete, retainedUrlResource.resource.id),
      retainedUrlResource,
    );
    const restoredUrlRaw = await restoredObjectStorage.open(storedUrlRawKey);
    const restoredUrlParsed = await restoredObjectStorage.open(storedUrlParsedKey);
    assert.ok(restoredUrlRaw && restoredUrlParsed);
    const restoredUrlRawChunks: Uint8Array[] = [];
    const restoredUrlParsedChunks: Uint8Array[] = [];
    for await (const chunk of restoredUrlRaw.body) restoredUrlRawChunks.push(chunk);
    for await (const chunk of restoredUrlParsed.body) restoredUrlParsedChunks.push(chunk);
    assert.deepEqual(Buffer.concat(restoredUrlRawChunks), urlRawBytes);
    assert.deepEqual(Buffer.concat(restoredUrlParsedChunks), urlParsedBytes);
    checks.push('private_resource_url_raw_parsed_provenance_and_objects_restored_together');
    const restoredTrackRepo = createActivityTrackRepository(restoreDb);
    const restoredTrack = await restoredTrackRepo.read(retainedAthlete, retainedFixture.activityId);
    if (restoredTrack.status !== 'available') throw new Error('TRACK_RESTORE_FAILED');
    assert.equal(restoredTrack.track.trackRevision, 1);
    assert.equal(restoredTrack.track.file.sha256, trackRaw.sha256);
    assert.equal(restoredTrack.track.correspondence.digest, trackCorrespondence);
    assert.deepEqual(
      restoredTrack.track.derivatives.map((item) => item.sha256),
      [trackNormalized.sha256, trackMapPath.sha256],
    );
    for (const artifact of [trackRaw, trackNormalized, trackMapPath]) {
      const object = await restoredObjectStorage.open(artifact.storageRef);
      assert.ok(object);
      const chunks: Uint8Array[] = [];
      for await (const chunk of object.body) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), artifact.bytes);
    }
    checks.push('private_activity_track_metadata_revision_and_all_three_objects_restored_together');
    // The activity deleted after the backup: its track came back in the dump and its
    // objects came back in the archive, and the replayed suppression must refuse every way
    // of reaching them.
    assert.deepEqual(await restoredTrackRepo.read(retainedAthlete, doomedImport.activityId), {
      status: 'unavailable',
      activityId: doomedImport.activityId,
    });
    for (const variant of ['raw', 'normalized', 'map_path'] as const)
      assert.equal(
        await restoredTrackRepo.resolveObject(retainedAthlete, doomedImport.activityId, variant),
        null,
      );
    const restoredActivities = createActivityRepository(restoreDb);
    assert.equal(
      await restoredActivities.getActivity(retainedAthlete, doomedImport.activityId),
      null,
    );
    // Re-importing the same source is suppressed rather than resurrected, and a track for
    // it is refused at the database.
    const reimported = await restoredActivities.importActivity(retainedAthlete, {
      idempotencyKey: randomUUID(),
      source: {
        kind: 'fixture',
        sourceId: String(
          (
            await restored.query<{ source_id: string }>(
              'SELECT source_id FROM activity_source_head WHERE athlete_id=$1 AND activity_id=$2',
              [retainedAthlete, doomedImport.activityId],
            )
          ).rows[0]?.source_id,
        ),
        revision: 2,
        contentHash: 'c'.repeat(64),
      },
      activity: {
        title: 'Synthetic re-import after restore',
        kind: 'running',
        startedAt: '2026-09-17T08:00:00+09:00',
        timezone: 'Asia/Seoul',
        durationSeconds: null,
        durationKind: 'unknown',
        distanceMeters: 0,
      },
    });
    assert.equal(reimported.outcome, 'suppressed');
    await assert.rejects(() =>
      createActivityTrackRepository(restoreDb).reserve(
        retainedAthlete,
        doomedImport.activityId,
        { expectedActivityRevision: doomedImport.revision + 1, recordedTrackIndex: 0 },
        `track-${randomUUID()}`,
      ),
    );
    // The replayed suppression also queued the restored objects. The real cleanup worker
    // reclaims them from the restored object store, and leaves the retained track alone.
    // Both course pictures came back in the object archive; the queue the replay filled is
    // what has to take the reclaimed one away again.
    assert.ok(await restoredObjectStorage.stat(validateObjectKey(doomedThumbnail.storageRef)));
    assert.ok(await restoredObjectStorage.stat(validateObjectKey(retainedThumbnail.storageRef)));
    const restoreCleanup = createResourceObjectCleanupRepository({
      connectionString: url('drill_restore'),
      max: 1,
    });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const outcome = await processOneResourceObjectCleanup(restoreCleanup, (ref) =>
          restoredObjectStorage.delete(validateObjectKey(ref)),
        );
        if (outcome === 'empty') break;
      }
    } finally {
      await restoreCleanup.close();
    }
    for (const artifact of doomedTrack.artifacts)
      assert.equal(await restoredObjectStorage.stat(artifact.storageRef), null);
    for (const artifact of retainedTrack.artifacts)
      assert.ok(await restoredObjectStorage.stat(artifact.storageRef));
    // The same replayed suppression reclaims the stored picture of every course cut from
    // that recording. The worker that just emptied the queue deleted those objects too,
    // while the retained course's picture — which nothing deleted — is still there.
    assert.equal(
      await restoredObjectStorage.stat(validateObjectKey(doomedThumbnail.storageRef)),
      null,
    );
    assert.ok(await restoredObjectStorage.stat(validateObjectKey(retainedThumbnail.storageRef)));
    checks.push(
      'restored_activity_deletion_reclaims_course_thumbnail_objects_through_the_cleanup_worker',
    );
    // M2-01s: the same worker run reclaims every object of the erased tenant the archive
    // brought back — track objects, the head and the superseded picture, the abandoned
    // render's temporary object and the orphan only the reference index named — so no byte
    // of the erased account outlives the replay.
    const erasedTenantSurvivors: string[] = [];
    for (const ref of erasedTenantObjects)
      if (await restoredObjectStorage.stat(validateObjectKey(ref))) erasedTenantSurvivors.push(ref);
    assert.deepEqual(erasedTenantSurvivors, []);
    checks.push('erased_tenant_course_thumbnail_and_track_objects_reclaimed_after_erasure_replay');
    // Courses restored with the cluster. The retained one is intact; the two derived from
    // the deleted activity were reclaimed by the replayed suppression, and what is left is
    // an explicitly unavailable reference with no geometry and no revisions.
    const restoredCourses = createCourseRepository(restoreDb);
    const restoredRetainedCourse = await restoredCourses.read(
      retainedAthlete,
      retainedCourse.course.courseId,
    );
    assert.equal(restoredRetainedCourse.status, 'available');
    if (restoredRetainedCourse.status !== 'available') throw new Error('COURSE_RESTORE_FAILED');
    assert.equal(restoredRetainedCourse.revision.name, 'Retained drill course');
    assert.deepEqual(restoredRetainedCourse.revision.geometry.coordinates, [
      [127.02, 37.5],
      [127.0201, 37.5001],
    ]);
    assert.deepEqual(restoredRetainedCourse.revision.lineage, [
      { activityId: retainedFixture.activityId, trackId: retainedTrackId, trackRevision: 1 },
    ]);
    checks.push('private_course_head_revision_geometry_and_lineage_restored_together');
    // M2-01l: the picture is a separate object, so the restore has to have brought back
    // both the row that points at it and the bytes it points at.
    const restoredThumbnailObject = await restoredCourses.resolveThumbnailObject(
      retainedAthlete,
      retainedCourse.course.courseId,
    );
    assert.ok(restoredThumbnailObject);
    assert.equal(restoredThumbnailObject.storageRef, retainedThumbnail.storageRef);
    assert.equal(restoredThumbnailObject.contentHash, retainedThumbnail.sha256);
    assert.equal(restoredThumbnailObject.byteSize, retainedThumbnail.byteSize);
    assert.equal(restoredThumbnailObject.courseRevision, 1);
    assert.equal(restoredThumbnailObject.mediaType, 'image/svg+xml');
    const restoredThumbnailStat = await restoredObjectStorage.stat(
      validateObjectKey(restoredThumbnailObject.storageRef),
    );
    assert.ok(restoredThumbnailStat);
    assert.equal(restoredThumbnailStat.sizeBytes, retainedThumbnail.byteSize);
    const restoredThumbnailBody = await restoredObjectStorage.open(
      validateObjectKey(restoredThumbnailObject.storageRef),
    );
    assert.ok(restoredThumbnailBody);
    const restoredThumbnailChunks: Uint8Array[] = [];
    for await (const chunk of restoredThumbnailBody.body) restoredThumbnailChunks.push(chunk);
    assert.equal(
      createHash('sha256').update(Buffer.concat(restoredThumbnailChunks)).digest('hex'),
      retainedThumbnail.sha256,
    );
    checks.push('restored_course_thumbnail_object_is_readable_after_restore');
    // The owner's own facts survive with the cluster, and they are still not revisions.
    const restoredPreferences = createCoursePreferenceRepository(restoreDb);
    const restoredPreference = (await restoredPreferences.list(retainedAthlete)).preferences.find(
      (preference) => preference.courseId === retainedCourse.course.courseId,
    );
    assert.ok(restoredPreference);
    assert.equal(restoredPreference.favourite, true);
    assert.equal(restoredPreference.lastUsedAt, seededPreference?.lastUsedAt);
    assert.equal(restoredRetainedCourse.course.headRevision, 1);
    const restoredZones = await restoredPreferences.listPrivacyZones(retainedAthlete);
    assert.equal(restoredZones.length, seededZones.length);
    assert.deepEqual(restoredZones[0]?.center, [127.02, 37.5]);
    assert.equal(restoredZones[0]?.radiusMeters, 300);
    checks.push('restored_course_favourite_last_used_and_protected_areas_survive_intact');
    const restoredNotes = await restoredPreferences.listAccessibilityNotes(retainedAthlete);
    assert.deepEqual(restoredNotes.notes, [seededNote]);
    checks.push('restored_course_accessibility_note_survives_with_its_revision');
    // The routed head comes back with the record of what computed it, and the proposal the
    // owner had not saved is still there to be reviewed — or to expire.
    const restoredRouted = await restoredCourses.read(
      retainedAthlete,
      routedCourse.course.courseId,
    );
    if (restoredRouted.status !== 'available') throw new Error('COURSE_RESTORE_FAILED');
    assert.equal(restoredRouted.course.headRevision, 2);
    assert.equal(restoredRouted.revision.generation.kind, 'routed-waypoints');
    if (restoredRouted.revision.generation.kind !== 'routed-waypoints')
      throw new Error('COURSE_RESTORE_FAILED');
    assert.equal(
      restoredRouted.revision.generation.computation.graph.graphBuildId,
      '0123456789abcdef',
    );
    assert.equal(
      restoredRouted.revision.generation.computation.graph.graphContentSha256,
      'd'.repeat(64),
    );
    assert.equal(restoredRouted.revision.generation.computation.requestRevision, 4);
    assert.equal(restoredRouted.revision.waypoints[1]?.locked, true);
    checks.push('restored_routed_course_revision_keeps_the_graph_that_computed_it');
    const restoredProposal = await restoredCourses.readRouteProposal(
      retainedAthlete,
      routedCourse.course.courseId,
      unsavedProposal.proposalId,
    );
    assert.ok(restoredProposal);
    assert.equal(restoredProposal.draftRevision, 5);
    assert.deepEqual(restoredProposal.geometry.coordinates, routedLine);
    const consumedProposal = await restoredCourses.readRouteProposal(
      retainedAthlete,
      routedCourse.course.courseId,
      savedProposal.proposalId,
    );
    assert.equal(consumedProposal, null);
    checks.push('restored_unsaved_route_proposal_survives_and_a_saved_one_stays_consumed');
    // The search comes back whole: the seed, the evaluation version and the candidate's
    // own evaluation. Without them a restored candidate could not be reproduced, and the
    // facts it has no data for could not be told from facts it never recorded.
    const restoredCandidateSet = await restoredCourses.readRouteCandidate(
      retainedAthlete,
      routedCourse.course.courseId,
      candidateSet.candidateSetId,
      candidateSet.candidates[0]?.proposalId ?? '',
    );
    assert.ok(restoredCandidateSet);
    assert.equal(restoredCandidateSet.searchSeed, 'feedfacefeedface');
    assert.equal(restoredCandidateSet.targetDistanceMeters, 5_000);
    assert.equal(restoredCandidateSet.draftRevision, 5);
    assert.equal(restoredCandidateSet.candidate.candidateSeed, '0000000000000000');
    assert.equal(restoredCandidateSet.candidate.evaluation.evaluationVersion, 1);
    assert.equal(restoredCandidateSet.candidate.evaluation.knowledge.surface, 'unknown');
    assert.equal(restoredCandidateSet.candidate.evaluation.gradientSource, 'none');
    assert.deepEqual(restoredCandidateSet.candidate.geometry.coordinates, candidateLoop);
    checks.push('restored_target_distance_search_keeps_its_seed_and_evaluation_version');
    for (const reclaimed of [doomedCourse.course.courseId, doomedCourseCopy.course.courseId]) {
      const read = await restoredCourses.read(retainedAthlete, reclaimed);
      assert.equal(read.status, 'unavailable');
      if (read.status !== 'unavailable') throw new Error('COURSE_RECLAIM_FAILED');
      assert.equal(read.course.reason, 'source_activity_deleted');
      assert.ok(!JSON.stringify(read).includes('127.02'));
    }
    assert.equal(
      (
        await restored.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM course_revision
           WHERE athlete_id=$1 AND course_id=ANY($2::uuid[])`,
          [retainedAthlete, [doomedCourse.course.courseId, doomedCourseCopy.course.courseId]],
        )
      ).rows[0]?.count,
      0,
    );
    checks.push('restored_activity_deletion_reclaims_derived_courses_and_their_copies');
    checks.push('restored_activity_deletion_refuses_read_download_export_and_reimport');
    checks.push('restored_activity_deletion_reclaims_track_objects_through_the_cleanup_worker');
    checks.push('retained_tenant_consent_and_activity_readable_through_runtime_rls');
    const manualId = manualIds.get(retainedAthlete);
    assert.ok(manualId);
    const retainedManual = await createActivityRepository(restoreDb).getActivity(
      retainedAthlete,
      manualId,
    );
    assert.ok(retainedManual);
    assert.equal(retainedManual.source.kind, 'manual');
    assert.equal(retainedManual.revision, 2);
    assert.equal(retainedManual.userReport?.sessionRpe, null);
    assert.equal(retainedManual.userReport?.rpeReportedAt, null);
    assert.equal(retainedManual.userReport?.note, null);
    const retainedExport =
      await createOperationsRepository(restoreDb).exportAccount(retainedAthlete);
    if (retainedExport.schemaVersion !== 22) throw new Error('Expected resource export v22');
    // Text, file, URL and the reviewed coach source; the source deleted before
    // the backup stays out of the export exactly as it did before restoration.
    assert.equal(retainedExport.data.resources.length, 4);
    assert.equal(retainedExport.data.resourceVersions.length, 5);
    assert.ok(
      !retainedExport.data.resources.some((row) => row['id'] === deletedCoachResource.resourceId),
    );
    assert.ok(!JSON.stringify(retainedExport).includes(storedFile.key));
    assert.ok(!JSON.stringify(retainedExport).includes(storedUrlRawKey));
    assert.ok(!JSON.stringify(retainedExport).includes(storedUrlParsedKey));
    assert.ok(!JSON.stringify(retainedExport).includes('private=server-only'));
    // v15 sharing, v16 gallery and v17 retrieval collections are reproduced by
    // the restored cluster rather than silently dropped.
    assert.equal(retainedExport.data.resourceShares.length, 1);
    assert.equal(retainedExport.data.resourceShares[0]?.['share_id'], sharedShareId);
    assert.ok(
      retainedExport.data.resourceAccessAudit.some(
        (row) => row['action'] === 'share_granted' && row['share_id'] === sharedShareId,
      ),
    );
    assert.ok(
      retainedExport.data.resourceAccessAudit.some(
        (row) =>
          row['action'] === 'resource_deleted' &&
          row['resource_id'] === deletedCoachResource.resourceId,
      ) === false,
      'audit rows of a deleted resource are removed with it',
    );
    assert.equal(retainedExport.data.galleryMediaItems.length, 1);
    assert.equal(retainedExport.data.galleryMediaItems[0]?.['id'], galleryReservation.mediaItemId);
    assert.equal(retainedExport.data.galleryMediaDerivatives.length, 1);
    assert.ok(
      !JSON.stringify(retainedExport.data.galleryMediaItems).includes('private/v1/tenants'),
    );
    assert.deepEqual(
      retainedExport.data.resourcePassages.map((row) => row['resource_id']),
      [retainedCoachResource.resourceId],
    );
    assert.equal(retainedExport.data.resourceGroundings.length, 1);
    assert.equal(retainedExport.data.resourceGroundings[0]?.['run_id'], retainedRunId);
    // The export carries passage identity and offsets, never passage bodies.
    assert.ok(!JSON.stringify(retainedExport.data.resourcePassages).includes('RESTOREDRILLTOKEN'));
    assert.ok(!JSON.stringify(retainedExport.data.resourceCitations).includes('RESTOREDRILLTOKEN'));
    // v18 track collections: identity, parser identity, the correspondence digest and
    // object hashes, and no storage reference anywhere.
    assert.equal(retainedExport.data.activityTracks.length, 1);
    assert.equal(
      retainedExport.data.activityTracks[0]?.['activity_id'],
      retainedFixture.activityId,
    );
    assert.equal(retainedExport.data.activityTrackRevisions.length, 1);
    assert.equal(
      retainedExport.data.activityTrackRevisions[0]?.['correspondence_digest'],
      trackCorrespondence,
    );
    assert.ok(
      !JSON.stringify(retainedExport.data.activityTrackRevisions).includes('private/v1/tenants'),
    );
    assert.ok(!JSON.stringify(retainedExport).includes(trackRaw.storageRef));
    // v19/v20 course collections: identity, lineage and the content digest, never a
    // coordinate of a course line.
    assert.equal(retainedExport.data.courses.length, 4);
    assert.equal(
      retainedExport.data.courses.filter((row) => row['status'] === 'unavailable').length,
      2,
    );
    assert.deepEqual(
      [...new Set(retainedExport.data.courseRevisions.map((row) => row['course_id']))].sort(),
      [retainedCourse.course.courseId, routedCourse.course.courseId].sort(),
    );
    const exportedRetainedRevisions = retainedExport.data.courseRevisions.filter(
      (row) => row['course_id'] === retainedCourse.course.courseId,
    );
    assert.equal(exportedRetainedRevisions.length, 1);
    assert.deepEqual(exportedRetainedRevisions[0]?.['lineage'], [
      {
        activity_id: retainedFixture.activityId,
        track_id: retainedTrackId,
        track_revision: 1,
      },
    ]);
    // The routed revision's conditions travel in the export — that is what a reader needs
    // to know which graph computed a stored course — and they carry no coordinate.
    const exportedRoutedRevisions = retainedExport.data.courseRevisions.filter(
      (row) => row['course_id'] === routedCourse.course.courseId,
    );
    assert.equal(exportedRoutedRevisions.length, 2);
    const exportedRoutedHead = exportedRoutedRevisions.find((row) => row['course_revision'] === 2);
    assert.ok(JSON.stringify(exportedRoutedHead?.['generation']).includes('"0123456789abcdef"'));
    assert.ok(!JSON.stringify(retainedExport.data.courseRevisions).includes('127.02'));
    checks.push('restored_courses_reproduced_in_export_v20_without_coordinates');
    // v20: the owner's own preferences and protected areas come back in their own export.
    // The protected-area centre is present on purpose — it is a datum the owner entered,
    // and an export without it could not restore what they had.
    assert.equal(retainedExport.data.coursePreferences.length, 1);
    assert.equal(
      retainedExport.data.coursePreferences[0]?.['course_id'],
      retainedCourse.course.courseId,
    );
    assert.equal(retainedExport.data.coursePreferences[0]?.['favourite'], true);
    assert.ok(retainedExport.data.coursePreferences[0]?.['last_used_at']);
    assert.equal(retainedExport.data.coursePrivacyZones.length, seededZones.length);
    assert.equal(retainedExport.data.coursePrivacyZones[0]?.['name'], 'Drill protected area');
    assert.equal(retainedExport.data.coursePrivacyZones[0]?.['center_longitude'], 127.02);
    assert.equal(retainedExport.data.coursePrivacyZones[0]?.['radius_meters'], 300);
    checks.push('restored_course_preferences_and_protected_areas_reproduced_in_export_v20');
    // v22: the accessibility note, its words and the revision it was written against.
    assert.equal(retainedExport.data.courseAccessibilityNotes.length, 1);
    assert.equal(
      retainedExport.data.courseAccessibilityNotes[0]?.['course_id'],
      retainedCourse.course.courseId,
    );
    assert.equal(
      retainedExport.data.courseAccessibilityNotes[0]?.['note'],
      'Drill accessibility note: 12 steps, handrail',
    );
    assert.equal(retainedExport.data.courseAccessibilityNotes[0]?.['written_at_revision'], 1);
    checks.push('restored_course_accessibility_note_reproduced_in_export_v22');
    // v21: a thumbnail is a *derivative*, recomputable from geometry the owner's own GPX
    // export already carries. So the export carries exactly what lets a restored
    // deployment redraw the picture and check it got the same one — the revision, the
    // renderer identity, the content hash, the byte size and the drawn vertex count — and
    // neither the bytes nor the object key.
    const exportedThumbnails = retainedExport.data.courseThumbnails;
    assert.deepEqual(
      [...new Set(exportedThumbnails.map((row) => row['course_id']))].sort(),
      [retainedCourse.course.courseId, routedCourse.course.courseId].sort(),
    );
    const exportedRetainedThumbnail = exportedThumbnails.find(
      (row) => row['course_id'] === retainedCourse.course.courseId,
    );
    assert.ok(exportedRetainedThumbnail);
    assert.equal(exportedRetainedThumbnail['course_revision'], 1);
    assert.equal(exportedRetainedThumbnail['content_hash'], retainedThumbnail.sha256);
    assert.equal(Number(exportedRetainedThumbnail['size_bytes']), retainedThumbnail.byteSize);
    assert.equal(exportedRetainedThumbnail['vertex_count'], retainedThumbnail.vertexCount);
    assert.equal(exportedRetainedThumbnail['renderer_id'], retainedThumbnail.rendererId);
    assert.equal(exportedRetainedThumbnail['renderer_version'], retainedThumbnail.rendererVersion);
    assert.equal(exportedRetainedThumbnail['media_type'], 'image/svg+xml');
    assert.ok(exportedRetainedThumbnail['ready_at']);
    // The reclaimed course's row is a tombstone for an object on its way out, not a live
    // picture, so it is not in the export at all.
    assert.ok(!exportedThumbnails.some((row) => row['course_id'] === doomedCourse.course.courseId));
    const serializedRetainedExport = JSON.stringify(retainedExport);
    assert.ok(!serializedRetainedExport.includes('<svg'));
    assert.ok(!serializedRetainedExport.includes('private/v1'));
    assert.ok(!serializedRetainedExport.includes(retainedThumbnail.storageRef));
    assert.ok(!serializedRetainedExport.includes(doomedThumbnail.storageRef));
    checks.push('restored_course_thumbnail_reproduced_in_export_v21_without_bytes_or_storage_refs');
    checks.push('restored_activity_track_reproduced_in_export_v20_without_storage_refs');
    checks.push('restored_access_shares_audit_and_gallery_media_reproduced_in_export');
    checks.push('restored_retrieval_passages_grounding_and_citations_reproduced_without_bodies');

    // ---------------------------------------------------------------------
    // Deletion and consent withdrawal must survive a restore. The dump still
    // contains the index rows of the resource deleted before the backup, so
    // this is the case where a restored cluster could resurrect an excerpt.
    // ---------------------------------------------------------------------
    const restoredPassageCount = async (owner: string, resourceId: string) =>
      (
        await restored.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM resource_passage WHERE athlete_id=$1 AND resource_id=$2',
          [owner, resourceId],
        )
      ).rows[0]?.count;
    // The physical rows really are in the restored snapshot: the block below is
    // not passing because the backup happened to be empty.
    assert.equal(await restoredPassageCount(retainedAthlete, deletedCoachResource.resourceId), 1);
    assert.equal(
      (
        await restored.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM resource_derived_cleanup
           WHERE athlete_id=$1 AND resource_id=$2 AND completed_at IS NULL`,
          [retainedAthlete, deletedCoachResource.resourceId],
        )
      ).rows[0]?.count,
      1,
    );
    const restoredRetrieval = createResourceRetrievalRepository(restoreDb);
    const restoredRetrievalResult = await restoredRetrieval.retrieve(
      retainedAthlete,
      retrievalQuery,
    );
    assert.deepEqual(
      restoredRetrievalResult.excerpts.map((excerpt) => excerpt.resourceId),
      [retainedCoachResource.resourceId],
    );
    const restoredGrounding = await restoredRetrieval.readGrounding(retainedAthlete, retainedRunId);
    assert.equal(restoredGrounding.status, 'available');
    if (restoredGrounding.status !== 'available') throw new Error('GROUNDING_RESTORE_FAILED');
    assert.deepEqual(
      restoredGrounding.excerpts.map((excerpt) => excerpt.resourceId),
      [retainedCoachResource.resourceId],
    );
    assert.equal(restoredGrounding.withdrawnExcerptCount, 1);
    assert.equal(restoredGrounding.citations.length, 2);
    assert.equal(
      restoredGrounding.citations.filter((citation) => citation.status === 'unavailable').length,
      1,
    );
    const restoredAvailableCitation = restoredGrounding.citations.find(
      (citation) => citation.status === 'available',
    );
    assert.ok(restoredAvailableCitation && restoredAvailableCitation.status === 'available');
    assert.equal(restoredAvailableCitation.resourceId, retainedCoachResource.resourceId);
    assert.equal(restoredAvailableCitation.versionId, retainedCoachResource.versionId);
    // The withdrawn owner's consent was replayed before runtime access, so its
    // reviewed source is no longer retrievable and its citation cannot resolve.
    assert.deepEqual(
      (await restoredRetrieval.retrieve(withdrawnAthlete, retrievalQuery)).excerpts,
      [],
    );
    const withdrawnRestoredGrounding = await restoredRetrieval.readGrounding(
      withdrawnAthlete,
      withdrawnRun.run.id,
    );
    assert.equal(withdrawnRestoredGrounding.status, 'available');
    if (withdrawnRestoredGrounding.status !== 'available')
      throw new Error('WITHDRAWN_GROUNDING_RESTORE_FAILED');
    assert.deepEqual(withdrawnRestoredGrounding.excerpts, []);
    assert.deepEqual(
      withdrawnRestoredGrounding.citations.map((citation) => citation.status),
      ['unavailable'],
    );
    checks.push(
      'restored_deleted_and_consent_withdrawn_sources_stay_gate_blocked_in_retrieval_and_citations',
    );

    // Operational recovery: the restored cluster's own cleanup worker drains
    // the manifests the backup carried, with the real store executors.
    const restoredCleanup = createResourceDerivedCleanupRepository({
      connectionString: url('drill_restore'),
      max: 1,
    });
    const restoredPurge = createResourceDerivedStorePurge(restoredCleanup);
    const openManifests = async () =>
      (
        await restored.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM resource_derived_cleanup WHERE completed_at IS NULL',
        )
      ).rows[0]?.count ?? 0;
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await openManifests()) === 0) break;
        await restored.query(
          `UPDATE resource_derived_cleanup SET available_at=clock_timestamp(),
             lease_owner=NULL,lease_until=NULL WHERE completed_at IS NULL`,
        );
        await processOneResourceDerivedCleanup(restoredCleanup, restoredPurge);
      }
      assert.equal(await openManifests(), 0);
      // A replayed drain finds nothing left and writes nothing back.
      assert.equal(await processOneResourceDerivedCleanup(restoredCleanup, restoredPurge), 'empty');
    } finally {
      await restoredCleanup.close();
    }
    assert.equal(await restoredPassageCount(retainedAthlete, deletedCoachResource.resourceId), 0);
    assert.equal(
      await restoredPassageCount(withdrawnAthlete, withdrawnCoachResource.resourceId),
      0,
    );
    for (const [table, owner, resourceId] of [
      ['resource_grounding_excerpt', retainedAthlete, deletedCoachResource.resourceId],
      ['resource_citation', retainedAthlete, deletedCoachResource.resourceId],
      ['resource_grounding_excerpt', withdrawnAthlete, withdrawnCoachResource.resourceId],
      ['resource_citation', withdrawnAthlete, withdrawnCoachResource.resourceId],
    ] as const) {
      assert.equal(
        (
          await restored.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1 AND resource_id=$2`,
            [owner, resourceId],
          )
        ).rows[0]?.count,
        0,
        `${table} must not survive the purge`,
      );
    }
    assert.equal(
      (
        await restored.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM resource_retrieval_cache WHERE athlete_id=$1',
          [retainedAthlete],
        )
      ).rows[0]?.count,
      0,
    );
    // The still-authorized source keeps its excerpt and its citation.
    assert.equal(await restoredPassageCount(retainedAthlete, retainedCoachResource.resourceId), 1);
    const afterPurgeGrounding = await restoredRetrieval.readGrounding(
      retainedAthlete,
      retainedRunId,
    );
    assert.equal(afterPurgeGrounding.status, 'available');
    if (afterPurgeGrounding.status !== 'available') throw new Error('GROUNDING_PURGE_FAILED');
    assert.deepEqual(
      afterPurgeGrounding.citations.map((citation) => citation.status),
      ['available'],
    );
    assert.deepEqual(
      (await restoredRetrieval.retrieve(retainedAthlete, retrievalQuery)).excerpts.map(
        (excerpt) => excerpt.resourceId,
      ),
      [retainedCoachResource.resourceId],
    );
    checks.push(
      'restored_derived_cleanup_purges_deleted_and_withdrawn_passages_cache_groundings_and_citations',
    );
    checks.push('replayed_restored_derived_cleanup_adds_nothing_back');
    assert.equal(
      retainedExport.data.coachingRuns[0]?.id,
      coachingRuns.get(retainedAthlete)?.run.id,
    );
    assert.deepEqual(
      retainedExport.data.coachingAnalysisOutputs[0]?.body,
      coachingRuns.get(retainedAthlete)?.body,
    );
    const retainedCandidate = coachingCandidates.get(retainedAthlete);
    assert.ok(retainedCandidate);
    assertCoachingCandidateRowsAvailable(
      await readCoachingCandidateRows(restored, retainedAthlete, retainedCandidate),
      retainedCandidate,
    );
    assert.deepEqual(
      retainedExport.data.coachingDecisions[0]?.body,
      retainedCandidate.decision.body,
    );
    assert.deepEqual(
      retainedExport.data.coachingProposals[0]?.body,
      retainedCandidate.proposal.body,
    );
    assert.deepEqual(
      retainedExport.data.coachingCandidates[0]?.body,
      retainedCandidate.candidate.body,
    );
    assert.equal(
      retainedExport.data.coachingCandidates[0]?.digest,
      retainedCandidate.candidate.digest,
    );
    const manualHistory = retainedExport.data.overlayRevisions.filter(
      (row) => row.activity_id === manualId,
    );
    assert.equal(manualHistory.length, 2);
    assert.deepEqual(manualHistory[0], manualHistories.get(retainedAthlete));
    assert.deepEqual(
      await restored
        .query('SELECT values_json FROM activity_overlay WHERE athlete_id=$1', [deletedAthlete])
        .then((result) => result.rows),
      [],
    );
    await assert.rejects(
      () => createOperationsRepository(restoreDb).exportAccount(deletedAthlete),
      TenantErasedError,
    );
    checks.push(
      'manual_source_and_null_report_restored_with_original_zero_report_history_erased_tenant_absent',
    );
    checks.push('coaching_run_basis_and_output_restored_for_consented_owner_erased_tenant_absent');
    checks.push('immutable_candidate_records_restored_for_consented_owner_erased_tenant_absent');
    const retainedCheckInId = checkInIds.get(retainedAthlete);
    assert.ok(retainedCheckInId);
    const retainedCheckIn = await createCheckInRepository(restoreDb).getCheckIn(
      retainedAthlete,
      retainedCheckInId,
    );
    assert.ok(retainedCheckIn);
    assert.deepEqual(retainedCheckIn.values, {
      ...checkInValues,
      observedAt: new Date(checkInValues.observedAt).toISOString(),
    });
    assert.equal(retainedCheckIn.localDate, '2026-09-16');
    assert.equal(retainedCheckIn.source, 'user');
    assert.equal(retainedCheckIn.method, 'self_report');
    assert.equal(retainedCheckIn.definitionVersion, 'checkin-v1');
    assert.equal(retainedCheckIn.revision, 1);
    await assert.rejects(
      () =>
        createCheckInRepository(restoreDb).createCheckIn(deletedAthlete, {
          idempotencyKey: randomUUID(),
          values: checkInValues,
        }),
      TenantErasedError,
    );
    checks.push('check_in_erasure_replayed_across_all_four_tables_retained_self_report_readable');
    const completion = completions.get(retainedAthlete);
    const deletedCompletion = completions.get(deletedAthlete);
    assert.ok(completion && deletedCompletion);
    const scenarioRepository = createPlanScenarioRepository(restoreDb);
    assert.deepEqual(
      await scenarioRepository.read(retainedAthlete, completion.scenario.id),
      completion.scenario,
    );
    assert.deepEqual(
      await scenarioRepository.readRevision(retainedAthlete, completion.scenario.id, 1),
      completion.initialScenario,
    );
    assert.deepEqual(
      await scenarioRepository.create(retainedAthlete, completion.createScenario),
      completion.initialScenario,
    );
    assert.deepEqual(
      await scenarioRepository.save(
        retainedAthlete,
        completion.scenario.id,
        completion.saveScenario,
      ),
      completion.scenario,
    );
    assert.deepEqual(
      await scenarioRepository.apply(
        retainedAthlete,
        completion.scenario.id,
        completion.applyScenario,
      ),
      completion.application,
    );
    assert.deepEqual(
      (await createPlanningRepository(restoreDb).read(retainedAthlete)).head,
      completion.plan,
    );
    if (retainedExport.schemaVersion !== 22) throw new Error('Expected coaching export v22');
    assert.equal(retainedExport.data.planScenarios.length, 1);
    assert.equal(retainedExport.data.planScenarioRevisions.length, 2);
    assert.equal(retainedExport.data.planScenarioApplications.length, 1);
    assert.equal(retainedExport.data.planScenarioApplications[0]?.version_id, completion.plan.id);
    for (const [table, count] of [
      ['plan_scenario', 1],
      ['plan_scenario_revision', 2],
      ['plan_scenario_application', 1],
    ] as const) {
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            retainedAthlete,
          ])
        ).rows[0].count,
        count,
      );
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            deletedAthlete,
          ])
        ).rows[0].count,
        0,
      );
    }
    checks.push(
      'scenario_revisions_application_and_receipts_restored_without_duplicate_promotion_erased_tenant_absent',
    );
    const coaching = coachingThreads.get(retainedAthlete);
    const deletedCoaching = coachingThreads.get(deletedAthlete);
    const originalCoachingExport = coachingExports.get(retainedAthlete);
    assert.ok(coaching && deletedCoaching && originalCoachingExport);
    const coachingRepository = createCoachingThreadRepository(restoreDb);
    assert.deepEqual(
      await coachingRepository.read(retainedAthlete, coaching.created.thread.id),
      coaching.appended.thread,
    );
    assert.deepEqual(await coachingRepository.list(retainedAthlete, { limit: 100, offset: 0 }), {
      items: [coaching.appended.thread],
      total: 1,
    });
    assert.deepEqual(
      await coachingRepository.messages(retainedAthlete, coaching.created.thread.id, {
        afterRevision: 0,
        limit: 100,
      }),
      {
        thread: coaching.appended.thread,
        messages: [coaching.created.message, coaching.appended.message],
        hasMore: false,
      },
    );
    assert.deepEqual(
      await coachingRepository.messages(retainedAthlete, coaching.created.thread.id, {
        afterRevision: 1,
        limit: 1,
      }),
      { thread: coaching.appended.thread, messages: [coaching.appended.message], hasMore: false },
    );
    assert.deepEqual(retainedExport.data.coachingThreads, originalCoachingExport.threads);
    assert.deepEqual(retainedExport.data.coachingMessages, originalCoachingExport.messages);
    // Original receipts must survive the restore without moving the thread head backward or
    // appending duplicate immutable messages/outbox events when a client retries an old command.
    assert.deepEqual(
      await coachingRepository.create(retainedAthlete, coaching.createCommand),
      coaching.created,
    );
    assert.deepEqual(
      await coachingRepository.append(
        retainedAthlete,
        coaching.created.thread.id,
        coaching.appendCommand,
      ),
      coaching.appended,
    );
    assert.deepEqual(
      await coachingRepository.read(retainedAthlete, coaching.created.thread.id),
      coaching.appended.thread,
    );
    assert.deepEqual(
      (await createPlanningRepository(restoreDb).read(retainedAthlete)).head,
      completion.plan,
    );
    for (const [table, count] of [
      ['coaching_thread', 1],
      ['coaching_message', 2],
    ] as const) {
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            retainedAthlete,
          ])
        ).rows[0].count,
        count,
      );
      assert.equal(
        (
          await restored.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
            deletedAthlete,
          ])
        ).rows[0].count,
        0,
      );
    }
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM command_receipt WHERE athlete_id=$1 AND idempotency_key=ANY($2::text[])',
          [
            retainedAthlete,
            [
              `coaching:create:${createHash('sha256').update(coaching.createCommand.idempotencyKey).digest('hex')}`,
              `coaching:append:${createHash('sha256').update(coaching.appendCommand.idempotencyKey).digest('hex')}`,
            ],
          ],
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (
        await restored.query(
          "SELECT count(*)::int AS count FROM outbox WHERE athlete_id=$1 AND topic IN ('coaching.thread_created','coaching.message_appended')",
          [retainedAthlete],
        )
      ).rows[0].count,
      2,
    );
    const coachingAfterReplay =
      await createOperationsRepository(restoreDb).exportAccount(retainedAthlete);
    if (coachingAfterReplay.schemaVersion !== 22) throw new Error('Expected coaching export v22');
    assert.deepEqual(coachingAfterReplay.data.coachingThreads, originalCoachingExport.threads);
    assert.deepEqual(coachingAfterReplay.data.coachingMessages, originalCoachingExport.messages);
    checks.push(
      'coaching_scope_revision_and_immutable_user_messages_export_v13_restored_receipts_replayed_without_duplicates',
    );
    await assert.rejects(
      () => coachingRepository.create(deletedAthlete, deletedCoaching.createCommand),
      TenantErasedError,
    );
    await assert.rejects(
      () =>
        coachingRepository.append(
          deletedAthlete,
          deletedCoaching.created.thread.id,
          deletedCoaching.appendCommand,
        ),
      TenantErasedError,
    );
    checks.push(
      'coaching_threads_messages_and_command_outbox_erasure_replayed_before_runtime_access',
    );
    const retainedEvidence = evidenceSnapshots.get(retainedAthlete);
    const deletedEvidence = evidenceSnapshots.get(deletedAthlete);
    assert.ok(retainedEvidence && deletedEvidence);
    const evidenceRepository = createCoreEvidenceSnapshotRepository(restoreDb);
    assert.deepEqual(
      await evidenceRepository.read(retainedAthlete, retainedEvidence.snapshot.id),
      retainedEvidence.snapshot,
    );
    assert.deepEqual(
      await evidenceRepository.capture(
        retainedAthlete,
        retainedEvidence.snapshot.threadId,
        retainedEvidence.command,
      ),
      retainedEvidence.snapshot,
    );
    assert.equal(retainedExport.data.evidenceSnapshots.length, 1);
    assert.deepEqual(
      retainedExport.data.evidenceSnapshots[0]?.body,
      retainedEvidence.snapshot.status === 'available' ? retainedEvidence.snapshot.body : null,
    );
    await assert.rejects(
      () => evidenceRepository.read(deletedAthlete, deletedEvidence.snapshot.id),
      TenantErasedError,
    );
    assert.equal(
      (
        await restored.query(
          'SELECT count(*)::int AS count FROM core_evidence_snapshot WHERE athlete_id=$1',
          [deletedAthlete],
        )
      ).rows[0].count,
      0,
    );
    checks.push(
      'core_evidence_body_and_manifest_restored_with_idempotent_receipt_erased_tenant_removed',
    );
    const completionRepository = createSessionCompletionRepository(restoreDb);
    const retainedCompletion = await completionRepository.read(retainedAthlete, 'restore-session');
    assert.deepEqual(retainedCompletion, {
      sessionId: 'restore-session',
      currentPlanVersionId: completion.plan.id,
      report: completion.result.report,
      history: [completion.result.report],
      totalHistory: 1,
    });
    assert.deepEqual(await completionRepository.list(retainedAthlete), {
      currentPlanVersionId: completion.plan.id,
      collectionRevision: 1,
      items: [completion.result.report],
    });
    for (const rows of [
      retainedExport.data.sessionCompletions,
      retainedExport.data.sessionCompletionRevisions,
    ]) {
      assert.deepEqual(rows, [
        { session_id: 'restore-session', revision: 1, record_json: completion.result.report },
      ]);
    }
    assert.deepEqual(
      await completionRepository.write(retainedAthlete, 'restore-session', completion.command),
      completion.result,
    );
    assert.deepEqual(
      await completionRepository.read(retainedAthlete, 'restore-session'),
      retainedCompletion,
    );
    await assert.rejects(
      () =>
        createPlanningRepository(restoreDb).save(retainedAthlete, {
          source: 'manual',
          confirmed: true,
          expectedVersionId: completion.plan.id,
          idempotencyKey: randomUUID(),
          draft: {
            ...completion.plan.draft,
            sessions: completion.plan.draft.sessions.map((session) => ({
              ...session,
              date: '2026-09-17',
            })),
          },
        }),
      (error: unknown) =>
        error instanceof SessionCompletionError && error.code === 'PLAN_COMPLETED_SESSION',
    );
    assert.deepEqual(
      (await createPlanningRepository(restoreDb).read(retainedAthlete)).head,
      completion.plan,
    );
    assert.equal(
      (await createActivityRepository(restoreDb).listActivities(retainedAthlete)).total,
      2,
    );
    await assert.rejects(
      () =>
        completionRepository.write(deletedAthlete, 'restore-session', deletedCompletion.command),
      TenantErasedError,
    );
    for (const table of completionTables) {
      for (const [athleteId, expectedCount] of [
        [deletedAthlete, 0],
        [retainedAthlete, 1],
      ] as const) {
        assert.equal(
          (
            await restored.query(
              `SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`,
              [athleteId],
            )
          ).rows[0].count,
          expectedCount,
        );
      }
    }
    checks.push(
      'session_completion_four_table_erasure_replayed_retained_history_export_v3_and_receipt_preserved',
    );
    checks.push('restored_completion_blocks_schedule_change_without_new_plan_or_actual_activity');
    await assert.rejects(
      () =>
        createConsentRepository(restoreDb).setConsent(deletedAthlete, {
          kind: 'app',
          granted: true,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        }),
      TenantErasedError,
    );
    const restoredCheckInId = checkInIds.get(retainedAthlete);
    assert.ok(restoredCheckInId);
    const checkInRepository = createCheckInRepository(restoreDb);
    const restoredCheckIn = await checkInRepository.getCheckIn(retainedAthlete, restoredCheckInId);
    assert.ok(restoredCheckIn);
    await checkInRepository.deleteCheckIn(retainedAthlete, restoredCheckInId, {
      expectedRevision: restoredCheckIn.revision,
      idempotencyKey: randomUUID(),
    });
    const purgedEvidence = await evidenceRepository.read(
      retainedAthlete,
      retainedEvidence.snapshot.id,
    );
    assert.ok(purgedEvidence);
    assert.equal(purgedEvidence.status, 'purged');
    assert.ok(!('body' in purgedEvidence));
    assert.deepEqual(
      await evidenceRepository.capture(
        retainedAthlete,
        retainedEvidence.snapshot.threadId,
        retainedEvidence.command,
      ),
      purgedEvidence,
    );
    const scrubbedExport =
      await createOperationsRepository(restoreDb).exportAccount(retainedAthlete);
    if (scrubbedExport.schemaVersion !== 22) throw new Error('Expected evidence export v22');
    assert.equal(scrubbedExport.data.evidenceSnapshots[0]?.body, null);
    assert.deepEqual(scrubbedExport.data.coachingRuns[0]?.status, {
      kind: 'cancelled',
      reason: 'source_deleted',
    });
    assert.equal(
      scrubbedExport.data.coachingAnalysisOutputs[0]?.id,
      coachingRuns.get(retainedAthlete)?.outputId,
    );
    assert.equal(scrubbedExport.data.coachingAnalysisOutputs[0]?.body, null);
    assert.equal(scrubbedExport.data.coachingAnalysisOutputs[0]?.purged_reason, 'source_deleted');
    assertCoachingCandidateRowsPurged(
      await readCoachingCandidateRows(restored, retainedAthlete, retainedCandidate),
      'source_deleted',
    );
    assert.equal(scrubbedExport.data.coachingDecisions[0]?.body, null);
    assert.equal(scrubbedExport.data.coachingDecisions[0]?.purged_reason, 'source_deleted');
    assert.equal(scrubbedExport.data.coachingProposals[0]?.body, null);
    assert.equal(scrubbedExport.data.coachingProposals[0]?.purged_reason, 'source_deleted');
    assert.equal(scrubbedExport.data.coachingCandidates[0]?.body, null);
    assert.equal(scrubbedExport.data.coachingCandidates[0]?.digest, null);
    assert.equal(scrubbedExport.data.coachingCandidates[0]?.purged_reason, 'source_deleted');
    for (const body of [
      retainedCandidate.decision.body,
      retainedCandidate.proposal.body,
      retainedCandidate.candidate.body,
    ]) {
      assert.ok(!JSON.stringify(scrubbedExport).includes(body.synthetic));
    }
    assert.ok(
      !JSON.stringify(scrubbedExport).includes(
        coachingRuns.get(retainedAthlete)?.body.synthetic ?? 'missing-output-fixture',
      ),
    );
    checks.push(
      'restored_source_deletion_scrubs_evidence_and_model_output_in_read_export_and_old_receipt',
    );
    checks.push('restored_source_deletion_scrubs_candidate_bodies_and_digest_in_export');
    checks.push('erasure_gate_rejects_stale_runtime_write');
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    try {
      await Promise.allSettled([
        ...databases.map((value) => value.close()),
        ...pools.map((value) => value.end()),
      ]);
    } finally {
      try {
        if (started) run(bin, 'pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    outcome: 'passed',
    postgresToolVersion: version,
    scope:
      'Synthetic ephemeral logical backup/restore drill only; not a production backup service or RPO/RTO evidence.',
    isolation:
      'New private Unix-socket cluster; no TCP listener or inherited database URL; separate generated source and restore databases.',
    archiveFormat: 'custom',
    trustedArchive: true,
    restoreBeforeRuntimeAccess: [
      'replay_latest_external_erasure_ledger',
      'replay_latest_complete_external_constraint_ledger_before_runtime_access',
      'replay_latest_external_evidence_withdrawal_ledger_and_current_ai_consent',
      'invalidate_all_restored_sessions_and_login_attempts',
      'invalidate_restored_garmin_credentials_and_replay_latest_encrypted_cleanup_ledger',
    ],
    checks,
    checkCount: checks.length,
    cleanup: { clusterStopped: true, temporaryClusterArchiveLedgerRemoved: !existsSync(directory) },
    limitations: [
      'Requires an independently retained, complete and current erasure ledger before production traffic resumes.',
      'Constraint restoration requires a complete, current, private owner/head/current-row ledger; missing coverage, missing tombstones or regressed revisions fail closed. Its health text must not be logged. This synthetic drill does not prove production ledger freshness or operations.',
      'Requires an independently retained, complete and current evidence withdrawal ledger with explicit exists/absent AI consent states covering backup owners, current consent owners and snapshot owners captured together; a missing, incomplete or stale ledger cannot authorize production restoration.',
      'Model output is untrusted and capped at 1 MiB per row; account export remains capped at 8 MiB. The restore replay uses the evidence withdrawal trigger to purge output before runtime access.',
      'Garmin revocation requires the current encrypted cleanup ledger outside the restored snapshot; all restored connection tokens are discarded and users must reconnect.',
      'The local private-object archive was exercised with the PostgreSQL snapshot; remote object providers, encrypted remote backup storage, disaster recovery infrastructure, and production recovery objectives were not exercised.',
    ],
    sources: [
      'https://www.postgresql.org/docs/15/app-pgdump.html',
      'https://www.postgresql.org/docs/15/app-pgrestore.html',
    ],
    previousRuns,
  };
  await writeFile(reportUrl, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      outcome: report.outcome,
      checkCount: report.checkCount,
      cleanup: report.cleanup,
    }),
  );
}
if (process.argv.length === 3 && process.argv[2] === '--execute') await execute();
else
  console.log(
    'Opt-in only: pnpm exec tsx scripts/backup-restore-drill.mts --execute. Creates and destroys only a new synthetic PostgreSQL cluster.',
  );
