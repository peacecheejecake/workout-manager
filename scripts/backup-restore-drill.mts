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
} from '../packages/server/persistence/src/migrate.js';
import { createGarminStore } from '../packages/server/persistence/src/garmin.js';
import { createConsentRepository } from '../packages/server/persistence/src/repositories.js';
import { createActivityRepository } from '../packages/server/persistence/src/activities.js';
import { createCheckInRepository } from '../packages/server/persistence/src/check-ins.js';
import { createOperationsRepository } from '../packages/server/persistence/src/operations.js';
import { createPrivateTextResourceRepository } from '../packages/server/persistence/src/resources.js';
import { createResourceFileUploadRepository } from '../packages/server/persistence/src/resource-file-uploads.js';
import {
  createResourceUrlIngestionRepository,
  createResourceUrlIngestionWorkerRepository,
} from '../packages/server/persistence/src/resource-url-ingestions.js';
import { createLocalFilesystemObjectStorage } from '../packages/server/media/src/local-filesystem.js';
import {
  createUrlFinalObjectKey,
  createUrlTemporaryObjectKey,
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
      await createActivityRepository(sourceDb).importActivity(athleteId, {
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
      assert.equal(before.schemaVersion, 14);
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
      if (coachingExport.schemaVersion !== 14) throw new Error('Expected coaching export v14');
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
      // A historical v8 download keeps its original shape and remains readable after v14 is added.
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
      if (candidateExport.schemaVersion !== 14) throw new Error('Expected candidate export v14');
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
      await restored.query('COMMIT');
    } catch (error) {
      await restored.query('ROLLBACK');
      throw error;
    }
    checks.push('latest_erasure_replayed_before_runtime_access');
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
    assert.ok(constraintExport.schemaVersion === 14);
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
    if (withdrawnExport.schemaVersion !== 14) throw new Error('Expected evidence export v14');
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
    if (absentExport.schemaVersion !== 14) throw new Error('Expected evidence export v14');
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
    if (retainedExport.schemaVersion !== 14) throw new Error('Expected resource export v14');
    assert.equal(retainedExport.data.resources.length, 3);
    assert.equal(retainedExport.data.resourceVersions.length, 4);
    assert.ok(!JSON.stringify(retainedExport).includes(storedFile.key));
    assert.ok(!JSON.stringify(retainedExport).includes(storedUrlRawKey));
    assert.ok(!JSON.stringify(retainedExport).includes(storedUrlParsedKey));
    assert.ok(!JSON.stringify(retainedExport).includes('private=server-only'));
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
    if (retainedExport.schemaVersion !== 14) throw new Error('Expected coaching export v14');
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
    if (coachingAfterReplay.schemaVersion !== 14) throw new Error('Expected coaching export v14');
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
    if (scrubbedExport.schemaVersion !== 14) throw new Error('Expected evidence export v14');
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
