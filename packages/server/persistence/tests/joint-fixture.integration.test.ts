import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PlanDraft } from '@workout/contracts/planning';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createDatabase, type Database } from '../src/database.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createJointApprovalRepository } from '../src/joint-approval.js';
import { createJointFixtureRepository } from '../src/joint-fixture.js';
import {
  grantCoachingCandidates,
  grantCoachingRuns,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantNutritionCore,
  grantOperations,
  grantSupplementaryCore,
  migrate,
} from '../src/migrate.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createPlanningRepository } from '../src/planning.js';
import { createConsentRepository } from '../src/repositories.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
const approval = () =>
  createJointApprovalRepository(database, {
    policy: { id: 'running-core-v3-joint', version: '1' },
  });
const fixture = (
  options: Parameters<typeof createJointFixtureRepository>[2] = {
    enabled: true,
    environment: 'test',
  },
) => createJointFixtureRepository(database, approval(), options);

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantNutritionCore(adminUrl, 'workout_runtime');
  await grantSupplementaryCore(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCoachingRuns(adminUrl, 'workout_runtime');
  await grantCoachingCandidates(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE ON consent,plan_snapshot,plan_head,plan_history,
      command_receipt,outbox,coaching_run TO workout_runtime`,
  );
  await admin.query('GRANT INSERT ON coaching_analysis_output TO workout_runtime');
  await admin.query(
    `GRANT SELECT ON activity_canonical,activity_source_head,activity_source_revision,
      activity_overlay,activity_overlay_revision,activity_suppression,
      check_in,check_in_collection_head,session_completion,session_completion_collection_head,
      coaching_constraint_head TO workout_runtime`,
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});

function trainingDraft(): PlanDraft {
  return {
    title: 'Synthetic training',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, all) => ({
      id: level,
      parentId: index === 0 ? null : (all[index - 1] ?? null),
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: 'Synthetic fixture',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'session-1',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: '06:00',
        title: 'Synthetic run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 5000,
        targetRpe: null,
        purpose: 'Synthetic',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  };
}

async function seed() {
  const athleteId = randomUUID();
  const training = await createPlanningRepository(database).save(athleteId, {
    source: 'manual',
    confirmed: true,
    expectedVersionId: null,
    idempotencyKey: randomUUID(),
    draft: trainingDraft(),
  });
  const nutrition = await createNutritionRepository(database).savePlan(athleteId, {
    kind: 'create',
    confirmed: true,
    idempotencyKey: randomUUID(),
    draft: {
      period: { from: '2080-01-01', toInclusive: '2080-01-31' },
      timezone: 'UTC',
      purpose: 'Training fuel',
      linkedTrainingPlanVersionId: training.id,
      items: [
        {
          id: randomUUID(),
          category: 'before',
          title: 'Pre-session meal',
          anchor: {
            kind: 'relative',
            entity: 'session',
            entityId: 'session-1',
            point: 'start',
            offsetMinutes: -30,
          },
          foods: [],
          targets: [],
          instructions: 'Prepare food',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: training.id,
      title: 'Joint fixture',
      scope: { kind: 'session', targetId: 'session-1' },
      message: 'Review training and food together',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  await createConsentRepository(database).setConsent(athleteId, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const command = {
    threadId: thread.id,
    nutritionPlanId: nutrition.planId,
    expectedConversationRevision: 1,
    window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
    idempotencyKey: randomUUID(),
  };
  return { athleteId, training, nutrition, command };
}

describe('server-owned joint v3 fixture run producer', () => {
  it('captures evidence, persists a v3 run and untrusted output, and prepares an approvable candidate', async () => {
    const data = await seed();
    const candidate = await fixture().create(data.athleteId, data.command);
    expect(candidate.writes.scope).toBe('combined');
    expect(candidate.validation.status).toBe('checked');
    expect(candidate.writes.training?.proposed.title).toContain('[joint fixture]');
    expect(candidate.writes.nutrition?.[0]?.proposed.purpose).toContain('[joint fixture]');
    expect(await fixture().create(data.athleteId, data.command)).toEqual(candidate);
    const ledger = await database.tenant(
      data.athleteId,
      async (tx) =>
        (
          await tx.query(
            `SELECT r.policy,r.source,r.basis,r.status,o.body AS output,
            (SELECT count(*)::int FROM core_evidence_snapshot WHERE athlete_id=$1) AS evidence_count,
            (SELECT count(*)::int FROM coaching_run WHERE athlete_id=$1) AS run_count,
            (SELECT count(*)::int FROM intake_entry WHERE athlete_id=$1) AS intake_count
           FROM coaching_decision d JOIN coaching_run r ON r.athlete_id=d.athlete_id AND r.id=d.run_id
           JOIN coaching_analysis_output o ON o.athlete_id=r.athlete_id AND o.run_id=r.id
           WHERE d.athlete_id=$1 AND d.id=$2`,
            [data.athleteId, candidate.decisionId],
          )
        ).rows[0],
    );
    expect(ledger).toMatchObject({
      policy: { id: 'running-core-v3-joint', version: '1' },
      source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v3-joint' },
      basis: { schemaVersion: 3 },
      status: { kind: 'validated_final', decisionId: candidate.decisionId },
      output: { trust: 'untrusted_fixture', validation: 'unvalidated' },
      evidence_count: 1,
      run_count: 1,
      intake_count: 0,
    });
    const result = await approval().approve(data.athleteId, {
      schemaVersion: 3,
      confirmed: true,
      proposalId: candidate.proposalId,
      candidateId: candidate.id,
      proposalDigest: candidate.digest,
      expectedBasis: candidate.basis,
      idempotencyKey: randomUUID(),
    });
    expect(result.training?.version).toBe(2);
    expect(result.nutrition[0]?.version).toBe(2);
  });

  it('does not create a run when a nutrition head changes after evidence capture', async () => {
    const data = await seed();
    const evidence = createCoreEvidenceSnapshotRepository(database);
    await expect(
      fixture({
        enabled: true,
        environment: 'test',
        evidenceSnapshots: {
          async capture(...args) {
            const snapshot = await evidence.capture(...args);
            await createNutritionRepository(database).savePlan(data.athleteId, {
              kind: 'update',
              planId: data.nutrition.planId,
              expectedHeadVersionId: data.nutrition.versionId,
              idempotencyKey: randomUUID(),
              confirmed: true,
              draft: {
                period: data.nutrition.period,
                timezone: data.nutrition.timezone,
                purpose: 'User changed nutrition',
                linkedTrainingPlanVersionId: data.nutrition.linkedTrainingPlanVersionId,
                items: data.nutrition.items.map(({ planVersionId: _versionId, ...item }) => ({
                  ...item,
                  source: 'user_confirmed' as const,
                })),
              },
            });
            return snapshot;
          },
        },
      }).create(data.athleteId, data.command),
    ).rejects.toMatchObject({ code: 'STALE_BASIS' });
    const runCount = await database.tenant(
      data.athleteId,
      async (tx) =>
        (
          await tx.query('SELECT count(*)::int AS count FROM coaching_run WHERE athlete_id=$1', [
            data.athleteId,
          ])
        ).rows[0]?.['count'],
    );
    expect(runCount).toBe(0);
  });

  it('does not create a run after AI consent withdrawal during evidence capture', async () => {
    const data = await seed();
    const evidence = createCoreEvidenceSnapshotRepository(database);
    await expect(
      fixture({
        enabled: true,
        environment: 'test',
        evidenceSnapshots: {
          async capture(...args) {
            const snapshot = await evidence.capture(...args);
            await createConsentRepository(database).setConsent(data.athleteId, {
              kind: 'ai',
              granted: false,
              expectedRevision: 1,
              idempotencyKey: randomUUID(),
            });
            return snapshot;
          },
        },
      }).create(data.athleteId, data.command),
    ).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
    expect(
      await database.tenant(
        data.athleteId,
        async (tx) =>
          (
            await tx.query('SELECT count(*)::int AS count FROM coaching_run WHERE athlete_id=$1', [
              data.athleteId,
            ])
          ).rows[0]?.['count'],
      ),
    ).toBe(0);
  });

  it('redacts the fixture output and candidate after consent withdrawal', async () => {
    const data = await seed();
    const candidate = await fixture().create(data.athleteId, data.command);
    expect(await approval().read(randomUUID(), candidate.id)).toBeNull();
    await createConsentRepository(database).setConsent(data.athleteId, {
      kind: 'ai',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await approval().read(data.athleteId, candidate.id)).toBeNull();
    await expect(fixture().create(data.athleteId, data.command)).rejects.toMatchObject({
      code: 'JOINT_FIXTURE_UNAVAILABLE',
    });
    const row = await database.tenant(
      data.athleteId,
      async (tx) =>
        (
          await tx.query(
            `SELECT c.body AS candidate_body,o.body AS output_body
           FROM coaching_candidate c JOIN coaching_decision d
             ON d.athlete_id=c.athlete_id AND d.id=c.decision_id
           JOIN coaching_analysis_output o
             ON o.athlete_id=d.athlete_id AND o.run_id=d.run_id
           WHERE c.athlete_id=$1 AND c.id=$2`,
            [data.athleteId, candidate.id],
          )
        ).rows[0],
    );
    expect(row).toEqual({ candidate_body: null, output_body: null });
  });

  it('disables the fixture in production and when explicitly off', async () => {
    const data = await seed();
    for (const options of [
      { enabled: true, environment: 'production' as const },
      { enabled: false, environment: 'test' as const },
    ])
      await expect(fixture(options).create(data.athleteId, data.command)).rejects.toMatchObject({
        code: 'JOINT_FIXTURE_DISABLED',
      });
  });
});
