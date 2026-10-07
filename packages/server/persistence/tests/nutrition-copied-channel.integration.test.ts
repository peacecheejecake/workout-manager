import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  integratedCandidateV4Schema,
  type IntegratedCandidateV4,
} from '@workout/contracts/integrated-coaching';
import { nutritionPlanDraftSchema } from '@workout/contracts/nutrition-core';
import {
  nutritionPlanVersionCompatibleV3Schema,
  nutritionPlanVersionV3Schema,
} from '@workout/contracts/nutrition-race-plan-v3';
import { planDraftSchema } from '@workout/contracts/planning';
import {
  runOneCoachingJob,
  createDeterministicFixtureAdapter,
} from '@workout/server-coaching/runner';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createCoachingRunRepository, createCoachingRunWorkerStore } from '../src/coaching-runs.js';
import { createTrainingCandidateRepository } from '../src/coaching-candidates.js';
import { createIntegratedApprovalV4Repository } from '../src/integrated-approval-v4.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createNutritionRacePlanWriter } from '../src/nutrition-race-plan-writer.js';
import { createRaceRepository } from '../src/races.js';
import {
  inspectIntegratedNutritionCopiedSources,
  integratedCandidatePayloadDigest,
} from '../src/nutrition-copied-source-inventory.js';
import {
  grantCorePlanning,
  grantOperations,
  grantRaces,
  grantNutritionCore,
  grantCoachingThreads,
  grantCoachingConstraints,
  grantCoreEvidenceSnapshots,
  grantCoachingRuns,
  grantCoachingRunWorker,
  grantCoachingCandidates,
  grantIntegratedApprovalV4,
  grantCheckIns,
  grantSessionCompletions,
  migrate,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root executes this preparation separately: public107 then owned108, plain owner,
// FORCE RLS, actual producer fixtures. No registry/admission/trigger bypass.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `nutrition_copy_${suffix}`;
const ownerRole = `nutrition_copy_owner_${suffix}`;
const runtimeRole = `nutrition_copy_app_${suffix}`;
const workerRole = `nutrition_copy_worker_${suffix}`;
let owner: Pool;
let database: Database;
let workerDatabase: Database;
let unsupported: Awaited<ReturnType<typeof seed>>;
function roleUrl(role: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
async function owned<T>(athlete: string, body: (client: PoolClient) => Promise<T>, replay = false) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query(
      replay
        ? 'SELECT pg_advisory_xact_lock(77210,1)'
        : 'SELECT pg_advisory_xact_lock_shared(77210,1)',
    );
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const policy = { id: 'running-core-v2-training', version: '1' };
const modelSource = { kind: 'deterministic_fixture' as const, fixtureId: 'synthetic-v1' };
const plan = () =>
  planDraftSchema.parse({
    title: 'Synthetic preserved training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: 'Preserved training purpose',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Synthetic run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: 'Endurance',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
const nutritionDraft = (event: string | null, quantity = 0, itemId = 'meal') =>
  nutritionPlanDraftSchema.parse({
    period: { from: '2080-01-01', toInclusive: '2080-01-08' },
    timezone: 'UTC',
    purpose: 'Preserved food intent',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: itemId,
        category: 'before',
        title: 'Synthetic meal',
        anchor:
          event === null
            ? { kind: 'absolute', date: '2080-01-02', localTime: null, timezone: 'UTC' }
            : {
                kind: 'relative',
                entity: 'race',
                entityId: event,
                point: 'start',
                offsetMinutes: -30,
              },
        foods: [
          {
            foodVersionId: null,
            description: 'Preserved food',
            quantity,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
        ],
        targets: [],
        instructions: '',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
const integrated = () =>
  createIntegratedApprovalV4Repository(database, { policyVersion: 'copy-test' });
async function seed() {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  const consent = createConsentRepository(database);
  for (const kind of ['app', 'ai'] as const)
    await consent.setConsent(athlete, {
      kind,
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  const training = await createPlanningRepository(database).save(athlete, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: plan(),
  });
  const head = await owned(athlete, async (client) =>
    z
      .uuid()
      .parse(
        (await client.query('SELECT aggregate_id FROM plan_head WHERE athlete_id=$1', [athlete]))
          .rows[0]?.aggregate_id,
      ),
  );
  const thread = (
    await createCoachingThreadRepository(database).create(athlete, {
      planVersionId: training.id,
      title: 'Synthetic thread',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic training input',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    athlete,
    thread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  const race = await createRaceRepository(database).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic race',
      localDate: '2080-01-02',
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
    },
  });
  return {
    athlete,
    training,
    head,
    evidence,
    thread,
    race,
    nutritionPlanId: randomUUID(),
    recoveryId: randomUUID(),
    scheduleId: randomUUID(),
  };
}
type Seed = Omit<Awaited<ReturnType<typeof seed>>, 'nutritionPlanId'> & { nutritionPlanId: string };
async function prepare(value: Seed, event: string | null = value.race.id, quantity = 0) {
  const basis = await integrated().captureBasis(value.athlete, {
    evidenceSnapshotId: value.evidence.id,
    trainingAggregateId: value.head,
    nutritionAggregateId: value.nutritionPlanId,
    recoveryAggregateId: value.recoveryId,
    routineScheduleAggregateId: value.scheduleId,
  });
  return integrated().prepareInternal(value.athlete, {
    proposalId: randomUUID(),
    basis,
    writes: [
      {
        domain: 'nutrition',
        aggregateId: value.nutritionPlanId,
        proposed: nutritionDraft(event, quantity),
      },
    ],
    summary: 'Explicit nutrition source fixture',
    validation: { status: 'checked', errors: [], unknowns: [] },
    idempotencyKey: randomUUID(),
  });
}
async function saveRaceSource(value: Seed, itemId = 'meal') {
  return await createNutritionRacePlanWriter(database).savePlanV2(value.athlete, {
    schemaVersion: 2,
    command: {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft: nutritionDraft(value.race.id, 0, itemId),
    },
    expectedRaceHeads: [
      { namespace: 'race-event', eventId: value.race.id, revision: value.race.revision },
    ],
  });
}
async function remove(value: Seed) {
  return createRaceRepository(database).deleteRaceEvent(value.athlete, value.race.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
}
async function candidateRow(value: Seed, candidate: IntegratedCandidateV4) {
  return owned(value.athlete, async (client) => {
    const result = await client.query(
      'SELECT body,purged_reason,digest,proposal_id,created_at FROM integrated_candidate_v4 WHERE athlete_id=$1 AND id=$2',
      [value.athlete, candidate.id],
    );
    return z
      .object({
        body: z.json().nullable(),
        purged_reason: z.string().nullable(),
        digest: z.string(),
        proposal_id: z.uuid(),
        created_at: z.date(),
      })
      .parse(result.rows[0]);
  });
}
async function replay(value: Seed) {
  return owned(
    value.athlete,
    async (client) => {
      const result = await client.query(
        `SELECT public.replay_race_deletion_exact(e.athlete_id,e.kind,e.target_id,e.event_id,e.occurred_at,e.race_previous_revision,e.race_deleted_revision) AS result FROM restore_suppression_event e WHERE e.athlete_id=$1 AND e.target_id=$2 AND e.record_version=4`,
        [value.athlete, value.race.id],
      );
      return z.string().parse(result.rows[0]?.result);
    },
    true,
  );
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, workerRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  await migrate(roleUrl(ownerRole), 107);
  owner = new Pool({ connectionString: roleUrl(ownerRole) });
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  for (const grant of [
    grantCorePlanning,
    grantOperations,
    grantRaces,
    grantNutritionCore,
    grantCoachingThreads,
    grantCoachingConstraints,
    grantCoreEvidenceSnapshots,
    grantCoachingRuns,
    grantCoachingCandidates,
    grantIntegratedApprovalV4,
    grantCheckIns,
    grantSessionCompletions,
  ])
    await grant(roleUrl(ownerRole), runtimeRole);
  await owner.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON consent,plan_snapshot,plan_head,plan_history,command_receipt,outbox TO "${runtimeRole}"`,
  );
  await owner.query(
    `GRANT SELECT ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,check_in,session_completion,session_completion_collection_head,check_in_collection_head,coaching_constraint_head,integrated_dependency_head TO "${runtimeRole}"`,
  );
  database = createDatabase({ connectionString: roleUrl(runtimeRole), max: 4 });
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
  await grantCoachingRunWorker(roleUrl(ownerRole), workerRole);
  // Separate nonowner worker with canonical worker-only grants.
  workerDatabase = createDatabase({ connectionString: roleUrl(workerRole), max: 2 });
  unsupported = await seed();
  const valid = await prepare(unsupported);
  // Genuine pre108 admission: immutable old schema accepts generic JSON; this
  // deliberately unsupported new row has an authentic own evidence binding.
  const id = randomUUID(),
    proposalId = randomUUID();
  const body = {
    ...valid,
    id,
    proposalId,
    unregisteredCopiedChannel: { eventId: unsupported.race.id },
  };
  const digest = integratedCandidatePayloadDigest(body);
  await owned(unsupported.athlete, (client) =>
    client.query(
      'INSERT INTO integrated_candidate_v4(athlete_id,id,proposal_id,digest,body,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
      [
        unsupported.athlete,
        id,
        proposalId,
        digest,
        JSON.stringify({ ...body, digest }),
        valid.createdAt,
      ],
    ),
  );
  await owner.query(
    await readFile(
      new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
      'utf8',
    ),
  );
  // Only existing public root grant entrypoints, no new helpers granted.
  await grantOperations(roleUrl(ownerRole), runtimeRole);
  await grantRaces(roleUrl(ownerRole), runtimeRole);
});
afterAll(async () => {
  await database?.close();
  await workerDatabase?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [workerRole, runtimeRole, ownerRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
describe('108 exact copied-source local storage protocol', () => {
  it('purges a direct race copy even with no saved nutrition version; keeps digest/audit and authentic original4 marker', async () => {
    const value = await seed(),
      candidate = await prepare(value);
    const before = await candidateRow(value, candidate);
    await remove(value);
    const after = await candidateRow(value, candidate);
    expect(after).toEqual({ ...before, body: null, purged_reason: 'source_deleted' });
    expect(await integrated().read(value.athlete, candidate.id)).toBeNull();
    const proof = await owned(
      value.athlete,
      async (client) =>
        (
          await client.query(
            `SELECT m.payload_digest=m.row_digest AS confused,m.row_digest_version,m.payload_digest_version,e.record_version,e.kind,e.athlete_id=m.athlete_id AS same_tenant FROM nutrition_integrated_candidate_disconnection m JOIN restore_suppression_event e ON e.event_id=m.event_id WHERE m.athlete_id=$1 AND m.candidate_id=$2`,
            [value.athlete, candidate.id],
          )
        ).rows,
    );
    expect(proof).toEqual([
      {
        confused: false,
        row_digest_version: 'postgres-row-jsonb-utc-v1',
        payload_digest_version: 'integrated-candidate-v4-canonical-v1',
        record_version: 4,
        kind: 'race_event_deleted',
        same_tenant: true,
      },
    ]);
  });
  it('preserves a known unrelated integrated nutrition candidate byte-for-byte', async () => {
    const value = await seed(),
      candidate = await prepare(value, null);
    const before = await candidateRow(value, candidate);
    await remove(value);
    expect(await candidateRow(value, candidate)).toEqual(before);
  });
  it('purges copied source-head consumption even when the proposed write has no direct race anchor', async () => {
    const initial = await seed();
    const saved = await saveRaceSource(initial, '한글'.repeat(150));
    const value = { ...initial, nutritionPlanId: saved.planId };
    const candidate = await prepare(value, null);
    await remove(value);
    expect((await candidateRow(value, candidate)).body).toBeNull();
    const after = await owned(value.athlete, async (client) =>
      nutritionPlanVersionV3Schema.parse(
        (
          await client.query(
            'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
            [value.athlete, saved.versionId],
          )
        ).rows[0]?.record_json,
      ),
    );
    expect(after.items[0]?.id).toBe(saved.items[0]?.id);
    expect(after.items[0]?.foods).toEqual(saved.items[0]?.foods);
    expect(after.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
  });
  it('preserves an unrelated owned frozen nutrition source and candidate bytes', async () => {
    const initial = await seed();
    const saved = await createNutritionRepository(database).savePlan(initial.athlete, {
      kind: 'create',
      confirmed: true,
      idempotencyKey: randomUUID(),
      draft: nutritionDraft(null),
    });
    const value = { ...initial, nutritionPlanId: saved.planId };
    const candidate = await prepare(value, null),
      before = await candidateRow(value, candidate);
    await remove(value);
    expect(await candidateRow(value, candidate)).toEqual(before);
  });
  it('rejects one unsupported pre108 row and rolls back original event emission and all candidate redaction', async () => {
    await expect(remove(unsupported)).rejects.toThrow('NUTRITION_COPY_UNSUPPORTED_CANDIDATE');
    expect(
      await owned(
        unsupported.athlete,
        async (client) =>
          (
            await client.query(
              'SELECT count(*)::integer AS count FROM restore_suppression_event WHERE athlete_id=$1 AND target_id=$2',
              [unsupported.athlete, unsupported.race.id],
            )
          ).rows,
      ),
    ).toEqual([{ count: 0 }]);
  });
  it('preserves strict minimal approved facts and owned foods/history while purging candidate raw timing', async () => {
    const initial = await seed();
    const original = await saveRaceSource(initial);
    const value = { ...initial, nutritionPlanId: original.planId };
    const candidate = await prepare(value, null);
    const approval = await integrated().approve(value.athlete, {
      schemaVersion: 4,
      confirmed: true,
      proposalId: candidate.proposalId,
      candidateId: candidate.id,
      proposalDigest: candidate.digest,
      writeDomains: ['nutrition'],
      expectedBasis: candidate.basis,
      idempotencyKey: randomUUID(),
    });
    // Explicit replacement does not rewrite old captured timing or transplant its pins.
    const beforeHistory = await owned(
      value.athlete,
      async (client) =>
        (
          await client.query(
            'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
            [value.athlete, original.versionId],
          )
        ).rows[0]?.record_json,
    );
    expect(beforeHistory).toEqual(original);
    const before = await owned(
      value.athlete,
      async (client) =>
        (
          await client.query(
            'SELECT to_jsonb(a) AS facts FROM integrated_approval_v4 a WHERE athlete_id=$1',
            [value.athlete],
          )
        ).rows,
    );
    await remove(value);
    expect(
      await owned(
        value.athlete,
        async (client) =>
          (
            await client.query(
              'SELECT to_jsonb(a) AS facts FROM integrated_approval_v4 a WHERE athlete_id=$1',
              [value.athlete],
            )
          ).rows,
      ),
    ).toEqual(before);
    expect((await candidateRow(value, candidate)).body).toBeNull();
    expect(approval.versions).toHaveLength(1);
    const saved = await owned(
      value.athlete,
      async (client) =>
        (
          await client.query('SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1', [
            value.athlete,
          ])
        ).rows,
    );
    expect(saved).toHaveLength(2);
    const originalRow = saved.find(
      (row) => nutritionPlanVersionV3Schema.safeParse(row.record_json).success,
    );
    const savedBody = nutritionPlanVersionV3Schema.parse(originalRow?.record_json);
    expect(savedBody.versionId).toBe(original.versionId);
    expect(savedBody.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
    expect(savedBody.items[0]?.foods).toEqual(original.items[0]?.foods);
    const approvedVersion = approval.versions[0]?.versionId;
    expect(
      saved.some(
        (row) =>
          nutritionPlanVersionCompatibleV3Schema.parse(row.record_json).versionId ===
          approvedVersion,
      ),
    ).toBe(true);
  });
  it('owner already-applied replay keeps one original marker/event and never mints new event6', async () => {
    const value = await seed();
    await prepare(value);
    await remove(value);
    const before = await owned(
      value.athlete,
      async (client) =>
        (
          await client.query(
            'SELECT event_id,record_version FROM restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id',
            [value.athlete],
          )
        ).rows,
    );
    expect(await replay(value)).toBe('already_applied');
    expect(await replay(value)).toBe('already_applied');
    expect(
      await owned(
        value.athlete,
        async (client) =>
          (
            await client.query(
              'SELECT event_id,record_version FROM restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id',
              [value.athlete],
            )
          ).rows,
      ),
    ).toEqual(before);
  });
  it('refuses raw candidate source reentry and unproven NULL restore', async () => {
    const value = await seed(),
      candidate = await prepare(value);
    await remove(value);
    const id = randomUUID(),
      proposalId = randomUUID();
    const clone = integratedCandidateV4Schema.parse({
      ...candidate,
      id,
      proposalId,
      digest: integratedCandidatePayloadDigest({ ...candidate, proposalId }),
    });
    await expect(
      owned(value.athlete, (client) =>
        client.query(
          'INSERT INTO integrated_candidate_v4(athlete_id,id,proposal_id,digest,body,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
          [value.athlete, id, proposalId, clone.digest, JSON.stringify(clone), clone.createdAt],
        ),
      ),
    ).rejects.toThrow('NUTRITION_COPY_SUPPRESSED_SOURCE_REENTRY');
    await expect(
      owned(value.athlete, (client) =>
        client.query(
          "INSERT INTO integrated_candidate_v4(athlete_id,id,proposal_id,digest,body,purged_reason,created_at) VALUES($1,$2,$3,$4,NULL,'source_deleted',$5)",
          [value.athlete, randomUUID(), randomUUID(), candidate.digest, candidate.createdAt],
        ),
      ),
    ).rejects.toThrow('NUTRITION_COPY_AUTHENTICATED_RESTORE_REQUIRED');
  });
  it('guards marker mutation and candidate audit changes even for the owner', async () => {
    const value = await seed(),
      candidate = await prepare(value);
    await remove(value);
    await expect(
      owned(value.athlete, (client) =>
        client.query(
          'UPDATE nutrition_integrated_candidate_disconnection SET payload_digest=$2 WHERE athlete_id=$1',
          [value.athlete, 'f'.repeat(64)],
        ),
      ),
    ).rejects.toThrow('NUTRITION_DISCONNECTION_IMMUTABLE');
    await expect(
      owned(value.athlete, (client) =>
        client.query(
          'DELETE FROM nutrition_integrated_candidate_disconnection WHERE athlete_id=$1',
          [value.athlete],
        ),
      ),
    ).rejects.toThrow('NUTRITION_DISCONNECTION_IMMUTABLE');
    await expect(
      owned(value.athlete, (client) =>
        client.query('UPDATE integrated_candidate_v4 SET digest=$2 WHERE athlete_id=$1 AND id=$3', [
          value.athlete,
          'f'.repeat(64),
          candidate.id,
        ]),
      ),
    ).rejects.toThrow('NUTRITION_COPY_REDACTION_NOT_EXACT');
  });
  it('rejects a foreign original4 event even with a correct own candidate SQL fingerprint', async () => {
    const foreign = await seed();
    await prepare(foreign);
    await remove(foreign);
    const event = await owned(foreign.athlete, async (client) =>
      z
        .uuid()
        .parse(
          (
            await client.query(
              'SELECT event_id FROM restore_suppression_event WHERE athlete_id=$1 AND target_id=$2 AND record_version=4',
              [foreign.athlete, foreign.race.id],
            )
          ).rows[0]?.event_id,
        ),
    );
    const value = await seed(),
      candidate = await prepare(value);
    await expect(
      owned(value.athlete, async (client) => {
        await client.query("SELECT set_config('TimeZone','UTC',true)");
        await client.query(
          "INSERT INTO nutrition_integrated_candidate_disconnection(athlete_id,candidate_id,event_id,row_digest_version,row_digest,payload_digest_version,payload_digest) SELECT athlete_id,id,$3,'postgres-row-jsonb-utc-v1',encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex'),'integrated-candidate-v4-canonical-v1',digest FROM integrated_candidate_v4 c WHERE athlete_id=$1 AND id=$2",
          [value.athlete, candidate.id, event],
        );
      }),
    ).rejects.toThrow('NUTRITION_COPY_MARKER_AUTHORITY');
    expect((await candidateRow(value, candidate)).body).toEqual(candidate);
  });
  it('refuses owner mint for an unrelated row despite an authentic same-tenant original4 event', async () => {
    const value = await seed(),
      candidate = await prepare(value, null);
    await remove(value);
    await expect(
      owned(value.athlete, async (client) => {
        await client.query("SELECT set_config('TimeZone','UTC',true)");
        await client.query(
          "INSERT INTO nutrition_integrated_candidate_disconnection(athlete_id,candidate_id,event_id,row_digest_version,row_digest,payload_digest_version,payload_digest) SELECT c.athlete_id,c.id,e.event_id,'postgres-row-jsonb-utc-v1',encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex'),'integrated-candidate-v4-canonical-v1',c.digest FROM integrated_candidate_v4 c JOIN restore_suppression_event e ON e.athlete_id=c.athlete_id AND e.target_id=$3 AND e.record_version=4 AND e.kind='race_event_deleted' WHERE c.athlete_id=$1 AND c.id=$2",
          [value.athlete, candidate.id, value.race.id],
        );
      }),
    ).rejects.toThrow('NUTRITION_COPY_MARKER_MEMBERSHIP');
    expect((await candidateRow(value, candidate)).body).toEqual(candidate);
  });
  it('preserves genuine training V1 decision/proposal/candidate producer chain bytes', async () => {
    const value = await seed();
    const run = await createCoachingRunRepository(database, { policy, source: modelSource }).create(
      value.athlete,
      value.thread.id,
      {
        schemaVersion: 1,
        evidenceSnapshotId: value.evidence.id,
        expectedConversationRevision: 1,
        idempotencyKey: randomUUID(),
      },
    );
    expect(
      await runOneCoachingJob({
        athleteId: value.athlete,
        store: createCoachingRunWorkerStore(workerDatabase, { policy, source: modelSource }),
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('stored');
    await createTrainingCandidateRepository(database, {
      policy,
      source: modelSource,
    }).createFromFixture(value.athlete, { runId: run.id, idempotencyKey: randomUUID() });
    const snapshot = () =>
      owned(
        value.athlete,
        async (client) =>
          (
            await client.query(
              `SELECT jsonb_build_object('decisions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM coaching_decision d WHERE athlete_id=$1),'proposals',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM coaching_proposal p WHERE athlete_id=$1),'candidates',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM coaching_candidate c WHERE athlete_id=$1)) AS body`,
              [value.athlete],
            )
          ).rows,
      );
    const before = await snapshot();
    await remove(value);
    expect(await snapshot()).toEqual(before);
  });
  it.each([0, 0.1, 1e-7, 1e-6, 1e20, 1e21, Number.MAX_SAFE_INTEGER])(
    'matches actual JS payload digest and source manifest for quantity %s',
    async (quantity) => {
      const value = await seed(),
        candidate = await prepare(value, value.race.id.toUpperCase(), quantity);
      const inspected = inspectIntegratedNutritionCopiedSources({
        identity: {
          athleteId: value.athlete,
          id: candidate.id,
          proposalId: candidate.proposalId,
          digest: candidate.digest,
          createdAt: candidate.createdAt,
        },
        body: candidate,
      });
      if (inspected.kind !== 'supported')
        throw new Error('Actual producer classification unavailable');
      const result = await owned(
        value.athlete,
        async (client) =>
          (
            await client.query(
              'SELECT nutrition_copy_candidate_manifest($1,$2,$3,$4,$5,$6::jsonb) AS manifest',
              [
                value.athlete,
                candidate.id,
                candidate.proposalId,
                candidate.digest,
                candidate.createdAt,
                JSON.stringify(candidate),
              ],
            )
          ).rows[0]?.manifest,
      );
      expect(result).toEqual(inspected.manifest);
    },
  );
  it('matches JS UTF-16 ordering and canonical JSON bytes for astral object keys/control strings', async () => {
    const value = { '\uffff': 'last', '😀': 'astral', a: '\b\t\n\f\r"\\' };
    const canonical = `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(',')}}`;
    const result = await owner.query('SELECT nutrition_copy_canonical_json($1::jsonb) AS encoded', [
      JSON.stringify(value),
    ]);
    expect(result.rows).toEqual([{ encoded: canonical }]);
    expect(createHash('sha256').update(canonical).digest('hex')).toHaveLength(64);
  });
  it('erases candidate markers with parent rows while retaining original suppression events', async () => {
    const value = await seed();
    await prepare(value);
    await remove(value);
    await owned(value.athlete, (client) =>
      client.query('SELECT public.erase_account($1)', [value.athlete]),
    );
    const proof = await owned(
      value.athlete,
      async (client) =>
        (
          await client.query(
            "SELECT (SELECT count(*)::integer FROM nutrition_integrated_candidate_disconnection WHERE athlete_id=$1) AS markers,(SELECT count(*)::integer FROM integrated_candidate_v4 WHERE athlete_id=$1) AS candidates,(SELECT count(*)::integer FROM restore_suppression_event WHERE athlete_id=$1 AND record_version=4 AND kind='race_event_deleted') AS events",
            [value.athlete],
          )
        ).rows,
    );
    expect(proof).toEqual([{ markers: 0, candidates: 0, events: 1 }]);
  });
});
