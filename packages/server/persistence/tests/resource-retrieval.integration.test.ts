import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PlanDraft } from '@workout/contracts/planning';
import type { PrivateTextResourceCreate } from '@workout/contracts/resources';
import {
  createDeterministicFixtureAdapter,
  runOneCoachingJob,
} from '@workout/server-coaching/runner';

import { createDatabase, type Database } from '../src/database.js';
import {
  grantCoachingConstraints,
  grantCoachingCandidates,
  grantCoachingRuns,
  grantCoachingThreads,
  grantCoreEvidenceSnapshots,
  grantOperations,
  grantResourceObjectCleanupWorker,
  grantResourceRetrieval,
  grantResources,
  migrate,
} from '../src/migrate.js';
import { createCoachingRunRepository, createCoachingRunWorkerStore } from '../src/coaching-runs.js';
import {
  createTrainingCandidateRepository,
  TrainingCandidateError,
} from '../src/coaching-candidates.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createOperationsRepository } from '../src/operations.js';
import { createPlanningRepository } from '../src/planning.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import { createResourceAccessRepository } from '../src/resource-access.js';
import {
  createResourceDerivedCleanupRepository,
  createResourceDerivedStorePurge,
  processOneResourceDerivedCleanup,
} from '../src/resource-derived-cleanup.js';
import { createResourceRetrievalRepository } from '../src/resource-retrieval.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let resources: ReturnType<typeof createPrivateTextResourceRepository>;
let access: ReturnType<typeof createResourceAccessRepository>;
let retrieval: ReturnType<typeof createResourceRetrievalRepository>;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantResources(adminUrl, 'workout_runtime');
  await grantResourceRetrieval(adminUrl, 'workout_runtime');
  await grantCoachingConstraints(adminUrl, 'workout_runtime');
  await grantCoachingThreads(adminUrl, 'workout_runtime');
  await grantCoreEvidenceSnapshots(adminUrl, 'workout_runtime');
  await grantCoachingRuns(adminUrl, 'workout_runtime');
  await grantCoachingCandidates(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON consent,plan_head,plan_snapshot,plan_history,
     command_receipt,outbox TO workout_runtime`,
  );
  await admin.query('GRANT SELECT,INSERT ON coaching_analysis_output TO workout_runtime');
  await admin.query(
    `GRANT SELECT ON activity_canonical,activity_source_head,activity_source_revision,
     activity_overlay,activity_overlay_revision,activity_suppression,check_in,session_completion,
     session_completion_collection_head,check_in_collection_head TO workout_runtime`,
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  resources = createPrivateTextResourceRepository(database);
  access = createResourceAccessRepository(database);
  retrieval = createResourceRetrievalRepository(database);
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

const RESOURCE_TEXT = '회복 주간에는 강도를 낮춘다.\n\nRecovery week reduces training intensity.';

const resourceCommand = (): PrivateTextResourceCreate => ({
  sourceKind: 'text',
  title: '회복 주간 지침',
  category: 'guide',
  metadata: {},
  tags: [],
  favorite: false,
  text: RESOURCE_TEXT,
  idempotencyKey: randomUUID(),
});

async function grantAiConsent(athleteId: string) {
  await database.tenant(athleteId, async (tx) => {
    await tx.query(
      `INSERT INTO consent VALUES($1,'ai',true,1)
       ON CONFLICT (athlete_id,kind) DO UPDATE SET granted=true,revision=consent.revision+1`,
      [athleteId],
    );
  });
}

async function withdrawAiConsent(athleteId: string) {
  await database.tenant(athleteId, async (tx) => {
    await tx.query(
      "UPDATE consent SET granted=false,revision=revision+1 WHERE athlete_id=$1 AND kind='ai'",
      [athleteId],
    );
  });
}

/** A reviewed, coach-enabled resource: the only kind retrieval may ever read. */
async function reviewedResource(athleteId: string) {
  const created = await resources.create(athleteId, resourceCommand());
  if (created.status !== 'available') throw new Error('Expected a stored resource');
  const reviewed = await access.setReviewed(athleteId, created.resource.id, {
    reviewed: true,
    expectedAccessRevision: created.resource.accessRevision,
    expectedCurrentVersionId: created.version.id,
    idempotencyKey: randomUUID(),
  });
  const enabled = await access.setCoachUse(athleteId, created.resource.id, {
    includeForCoach: true,
    expectedAccessRevision: reviewed.accessRevision,
    expectedCurrentVersionId: created.version.id,
    idempotencyKey: randomUUID(),
  });
  return { resourceId: created.resource.id, versionId: created.version.id, state: enabled };
}

async function count(athleteId: string, table: string) {
  const result = await admin.query(
    `SELECT count(*)::integer AS total FROM ${table} WHERE athlete_id=$1`,
    [athleteId],
  );
  return z.number().int().parse(result.rows[0]?.['total']);
}

/**
 * Drains every open manifest with the real executors the worker ships, and
 * refuses to return while any manifest is still open, so an assertion after it
 * can never pass or fail because of a half-drained queue.
 */
async function drainDerivedCleanup(limit = 200) {
  const repository = createResourceDerivedCleanupRepository({
    connectionString: adminUrl as string,
    max: 1,
  });
  const purge = createResourceDerivedStorePurge(repository);
  const outcomes: string[] = [];
  const open = async () =>
    z
      .number()
      .int()
      .parse(
        (
          await admin.query(
            'SELECT count(*)::integer AS total FROM resource_derived_cleanup WHERE completed_at IS NULL',
          )
        ).rows[0]?.['total'],
      );
  try {
    for (let attempt = 0; attempt < limit; attempt += 1) {
      if ((await open()) === 0) break;
      // No other worker runs here, so an abandoned lease is cleared as well:
      // the helper must converge instead of spinning on a leased row.
      await admin.query(
        `UPDATE resource_derived_cleanup SET available_at=clock_timestamp(),
           lease_owner=NULL,lease_until=NULL WHERE completed_at IS NULL`,
      );
      outcomes.push(await processOneResourceDerivedCleanup(repository, purge));
    }
    const remaining = await open();
    if (remaining !== 0)
      throw new Error(`Derived cleanup did not drain: ${remaining} open, ${outcomes.join(',')}`);
  } finally {
    await repository.close();
  }
  return outcomes;
}

const query = { schemaVersion: 1 as const, query: '회복', limit: 4 };

/**
 * One cleanup attempt whose store executor fails. The manifest must stay open
 * and be retried, never reported as purged.
 */
async function failOneDerivedCleanupAttempt() {
  const repository = createResourceDerivedCleanupRepository({
    connectionString: adminUrl as string,
    max: 1,
  });
  try {
    await admin.query(
      `UPDATE resource_derived_cleanup SET available_at=clock_timestamp(),
         lease_owner=NULL,lease_until=NULL WHERE completed_at IS NULL`,
    );
    return await processOneResourceDerivedCleanup(repository, {
      derivedData: async () => {
        throw new Error('synthetic store failure');
      },
      searchIndex: async () => undefined,
      cache: async () => undefined,
      citations: async () => undefined,
    });
  } finally {
    await repository.close();
  }
}

async function seedCoaching(athleteId: string) {
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
  const { thread } = await createCoachingThreadRepository(database).create(athleteId, {
    planVersionId: plan.id,
    title: 'Training question',
    scope: { kind: 'session', targetId: 'session' },
    message: 'Synthetic private report',
    idempotencyKey: randomUUID(),
  });
  await grantAiConsent(athleteId);
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    thread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  return { thread, evidence };
}

const runRepository = () =>
  createCoachingRunRepository(database, {
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  });

const runWorkerStore = () =>
  createCoachingRunWorkerStore(database, {
    policy: { id: 'running-core-v2-training', version: '1' },
    source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
  });

describe('ACL-filtered retrieval over reviewed resources', () => {
  it('indexes and returns only reviewed, coach-enabled, consented resources', async () => {
    const athleteId = randomUUID();
    await grantAiConsent(athleteId);
    const unreviewed = await resources.create(athleteId, resourceCommand());
    if (unreviewed.status !== 'available') throw new Error('Expected a stored resource');
    // A stored but unreviewed resource is not a reviewed source and must never
    // be indexed or retrieved, however well it matches the query.
    expect(await retrieval.retrieve(athleteId, query)).toMatchObject({
      excerpts: [],
      authorizedResourceCount: 0,
      cache: 'miss',
    });
    expect(await count(athleteId, 'resource_passage')).toBe(0);

    const { resourceId, versionId } = await reviewedResource(athleteId);
    const first = await retrieval.retrieve(athleteId, query);
    expect(first.cache).toBe('miss');
    expect(first.authorizedResourceCount).toBe(1);
    expect(first.excerpts).toHaveLength(1);
    expect(first.excerpts[0]).toMatchObject({ resourceId, versionId, ordinal: 0 });
    expect(first.excerpts[0]?.text).toContain('회복 주간');
    // The unreviewed resource is still not indexed.
    const indexed = await admin.query(
      'SELECT DISTINCT resource_id FROM resource_passage WHERE athlete_id=$1',
      [athleteId],
    );
    expect(indexed.rows).toEqual([{ resource_id: resourceId }]);

    const cached = await retrieval.retrieve(athleteId, query);
    expect(cached.cache).toBe('revalidated');
    expect(cached.excerpts).toEqual(first.excerpts);
    expect(cached.authorizationDigest).toBe(first.authorizationDigest);
  });

  it('keeps one tenant out of another tenant index, cache and citations', async () => {
    const owner = randomUUID();
    const stranger = randomUUID();
    await grantAiConsent(owner);
    await grantAiConsent(stranger);
    await reviewedResource(owner);
    expect((await retrieval.retrieve(owner, query)).excerpts).toHaveLength(1);
    const foreign = await retrieval.retrieve(stranger, query);
    expect(foreign.excerpts).toEqual([]);
    expect(foreign.authorizedResourceCount).toBe(0);
    expect(await count(stranger, 'resource_passage')).toBe(0);
  });

  it('requires an explicit re-review before a replaced body becomes coach-usable', async () => {
    const athleteId = randomUUID();
    await grantAiConsent(athleteId);
    const { resourceId, versionId } = await reviewedResource(athleteId);
    expect((await retrieval.retrieve(athleteId, query)).excerpts[0]?.versionId).toBe(versionId);
    const appended = await resources.appendVersion(athleteId, resourceId, {
      text: '회복 주간 개정판입니다.\n\nSecond revision of the recovery guidance.',
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    if (appended.status !== 'available') throw new Error('Expected a new version');

    // Replacing the body replaces the content a reviewer approved. The review
    // stays pinned to the old version, so the gate closes: the new text is not
    // indexed, not retrievable and never reaches a model without a new review.
    const afterAppend = await access.readAccess(athleteId, resourceId);
    expect(afterAppend).toMatchObject({
      reviewedState: 'reviewed',
      includeForCoach: true,
      reviewedVersionId: versionId,
      currentVersionId: appended.version.id,
      coachUseAuthorized: false,
    });
    const blocked = await retrieval.retrieve(athleteId, query);
    expect(blocked.excerpts).toEqual([]);
    expect(blocked.authorizedResourceCount).toBe(0);
    // The superseded index rows are reclaimed rather than left as stored copies.
    expect(await count(athleteId, 'resource_passage')).toBe(0);

    const rereviewed = await access.setReviewed(athleteId, resourceId, {
      reviewed: true,
      expectedAccessRevision: afterAppend.accessRevision,
      expectedCurrentVersionId: appended.version.id,
      idempotencyKey: randomUUID(),
    });
    expect(rereviewed).toMatchObject({
      reviewedVersionId: appended.version.id,
      coachUseAuthorized: true,
    });
    const reindexed = await retrieval.retrieve(athleteId, query);
    // Only the current version may be returned; two versions never mix.
    expect(reindexed.excerpts.map((item) => item.versionId)).toEqual([appended.version.id]);
    expect(reindexed.excerpts[0]?.text).toContain('개정판');
    const versions = await admin.query(
      'SELECT DISTINCT version_id FROM resource_passage WHERE athlete_id=$1',
      [athleteId],
    );
    expect(versions.rows).toEqual([{ version_id: appended.version.id }]);
  });

  it('reclaims expired cache rows and evicts the oldest beyond the tenant cap', async () => {
    const athleteId = randomUUID();
    await grantAiConsent(athleteId);
    await reviewedResource(athleteId);
    // More distinct queries than the cap, so the cap has to do real work.
    const firstQuery = '회복 000';
    await retrieval.retrieve(athleteId, { ...query, query: firstQuery });
    const oldest = await admin.query(
      'SELECT cache_key FROM resource_retrieval_cache WHERE athlete_id=$1',
      [athleteId],
    );
    const oldestKey = oldest.rows[0]?.['cache_key'];
    expect(typeof oldestKey).toBe('string');
    for (let index = 1; index <= 60; index += 1)
      await retrieval.retrieve(athleteId, {
        ...query,
        query: `회복 ${String(index).padStart(3, '0')}`,
      });
    const cachedRows = await count(athleteId, 'resource_retrieval_cache');
    expect(cachedRows).toBe(50);
    // The first entry was evicted rather than kept forever.
    expect(
      (
        await admin.query(
          'SELECT count(*)::integer AS total FROM resource_retrieval_cache WHERE athlete_id=$1 AND cache_key=$2',
          [athleteId, oldestKey],
        )
      ).rows[0]?.['total'],
    ).toBe(0);

    // Expiring every entry and issuing one more query reclaims the dead rows.
    await admin.query(
      "UPDATE resource_retrieval_cache SET expires_at=created_at+interval '1 millisecond' WHERE athlete_id=$1",
      [athleteId],
    );
    await retrieval.retrieve(athleteId, { ...query, query: '회복 최신' });
    expect(await count(athleteId, 'resource_retrieval_cache')).toBe(1);

    // The shared worker reclaims globally as well, and skips rows another
    // transaction still holds instead of waiting for them.
    await admin.query(
      "UPDATE resource_retrieval_cache SET expires_at=created_at+interval '1 millisecond' WHERE athlete_id=$1",
      [athleteId],
    );
    const holder = await admin.connect();
    const repository = createResourceDerivedCleanupRepository({
      connectionString: adminUrl as string,
      max: 1,
    });
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT cache_key FROM resource_retrieval_cache WHERE athlete_id=$1 FOR UPDATE',
        [athleteId],
      );
      // The held row is skipped, so the prune returns promptly instead of
      // blocking the privacy cleanup worker behind a long transaction.
      expect(await repository.pruneRetrievalCache(500)).toBe(0);
      expect(await count(athleteId, 'resource_retrieval_cache')).toBe(1);
      await holder.query('ROLLBACK');
      expect(await repository.pruneRetrievalCache(500)).toBe(1);
      expect(await count(athleteId, 'resource_retrieval_cache')).toBe(0);
    } finally {
      holder.release();
      await repository.close();
    }
  });
});

describe('deletion, withdrawal and downgrade cannot resurface an excerpt', () => {
  /**
   * The acceptance matrix of this node. Each change is applied to a resource
   * that is already indexed, cached, pinned to a coaching run's grounding and
   * cited by its stored output, and each one is then carried all the way
   * through the index, the cache, the citation, a cleanup retry and a replayed
   * coaching job.
   */
  const cases = [
    {
      name: 'a deleted resource',
      // Deletion, consent withdrawal and a review downgrade end coach use for
      // good; a revoked share only ends that grantee's access, so the owner's
      // own coach use is legitimately usable again once the purge finishes.
      reopensAfterCleanup: false,
      async change(athleteId: string, resourceId: string, versionId: string, revision: number) {
        await resources.softDelete(athleteId, resourceId, {
          expectedAccessRevision: revision,
          expectedCurrentVersionId: versionId,
          idempotencyKey: randomUUID(),
        });
      },
    },
    {
      name: 'a withdrawn AI consent',
      reopensAfterCleanup: false,
      async change(athleteId: string) {
        await withdrawAiConsent(athleteId);
      },
    },
    {
      name: 'a stopped coach use',
      reopensAfterCleanup: false,
      async change(athleteId: string, resourceId: string, versionId: string, revision: number) {
        await access.setCoachUse(athleteId, resourceId, {
          includeForCoach: false,
          expectedAccessRevision: revision,
          expectedCurrentVersionId: versionId,
          idempotencyKey: randomUUID(),
        });
      },
    },
    {
      name: 'a review downgrade',
      reopensAfterCleanup: false,
      // A direct downgrade is refused while coach use is on, so the only legal
      // sequence is stop coach use first and then clear the review.
      async change(athleteId: string, resourceId: string, versionId: string, revision: number) {
        const stopped = await access.setCoachUse(athleteId, resourceId, {
          includeForCoach: false,
          expectedAccessRevision: revision,
          expectedCurrentVersionId: versionId,
          idempotencyKey: randomUUID(),
        });
        const cleared = await access.setReviewed(athleteId, resourceId, {
          reviewed: false,
          expectedAccessRevision: stopped.accessRevision,
          expectedCurrentVersionId: versionId,
          idempotencyKey: randomUUID(),
        });
        expect(cleared).toMatchObject({ reviewedState: 'unreviewed', reviewedVersionId: null });
      },
    },
    {
      name: 'a revoked share',
      reopensAfterCleanup: true,
      async change(athleteId: string, resourceId: string, versionId: string, revision: number) {
        const granted = await access.grantShare(athleteId, resourceId, {
          granteeKind: 'coach',
          granteePrincipalId: `coach-${randomUUID()}`,
          expectedAccessRevision: revision,
          idempotencyKey: randomUUID(),
        });
        const share = granted.shares[0];
        if (!share) throw new Error('Expected an active share');
        await access.revokeShare(athleteId, resourceId, share.shareId, {
          expectedAccessRevision: granted.accessRevision,
          idempotencyKey: randomUUID(),
        });
      },
    },
  ];

  for (const testCase of cases)
    it(`blocks index, cache, citation, retry and replay after ${testCase.name}`, async () => {
      const athleteId = randomUUID();
      const { thread, evidence } = await seedCoaching(athleteId);
      const { resourceId, versionId, state } = await reviewedResource(athleteId);
      const run = await runRepository().create(athleteId, thread.id, {
        schemaVersion: 1,
        evidenceSnapshotId: evidence.id,
        expectedConversationRevision: 1,
        retrieval: { kind: 'resource-access-v1', query: '회복' },
        idempotencyKey: randomUUID(),
      });
      expect(
        await runOneCoachingJob({
          athleteId,
          store: runWorkerStore(),
          adapter: createDeterministicFixtureAdapter('synthetic-v1'),
        }),
      ).toBe('stored');
      const grounded = await retrieval.readGrounding(athleteId, run.id);
      if (grounded.status !== 'available') throw new Error('Expected a pinned grounding');
      expect(grounded.citations.map((citation) => citation.status)).toEqual(['available']);
      expect((await retrieval.retrieve(athleteId, query)).excerpts).toHaveLength(1);
      expect(await count(athleteId, 'resource_retrieval_cache')).toBeGreaterThan(0);
      expect(await count(athleteId, 'resource_citation')).toBe(1);

      await testCase.change(athleteId, resourceId, versionId, state.accessRevision);

      // The index rows still exist: the block is the query-time gate, not the
      // asynchronous purge, so there is no window where a withdrawn excerpt is
      // retrievable because cleanup has not run yet.
      expect(await count(athleteId, 'resource_passage')).toBeGreaterThan(0);
      const blocked = await retrieval.retrieve(athleteId, query);
      expect(blocked.excerpts).toEqual([]);
      expect(blocked.authorizedResourceCount).toBe(0);
      // A previously cached entry cannot serve it either, on this read or a
      // repeated one.
      expect((await retrieval.retrieve(athleteId, query)).excerpts).toEqual([]);
      const blockedGrounding = await retrieval.readGrounding(athleteId, run.id);
      if (blockedGrounding.status !== 'available') throw new Error('Expected grounding metadata');
      expect(blockedGrounding.excerpts).toEqual([]);
      expect(blockedGrounding.withdrawnExcerptCount).toBe(1);
      expect(blockedGrounding.citations.map((citation) => citation.status)).toEqual([
        'unavailable',
      ]);

      // A cleanup attempt that fails is retried rather than reported as purged.
      const retried = await failOneDerivedCleanupAttempt();
      expect(retried).toBe('retry_scheduled');
      expect(await count(athleteId, 'resource_citation')).toBe(1);
      expect((await retrieval.retrieve(athleteId, query)).excerpts).toEqual([]);

      await drainDerivedCleanup();
      expect(await count(athleteId, 'resource_grounding_excerpt')).toBe(0);
      expect(await count(athleteId, 'resource_citation')).toBe(0);
      const purgedGrounding = await retrieval.readGrounding(athleteId, run.id);
      if (purgedGrounding.status !== 'available') throw new Error('Expected grounding metadata');
      expect(purgedGrounding.citations).toEqual([]);

      // Replaying the cleanup and the coaching job adds nothing back.
      expect(await drainDerivedCleanup()).toEqual([]);
      expect(
        await runOneCoachingJob({
          athleteId,
          store: runWorkerStore(),
          adapter: createDeterministicFixtureAdapter('synthetic-v1'),
        }),
      ).toBe('empty');
      expect(await count(athleteId, 'resource_citation')).toBe(0);

      if (testCase.reopensAfterCleanup) {
        const reopened = await retrieval.retrieve(athleteId, query);
        expect(reopened.excerpts).toHaveLength(1);
        expect(reopened.excerpts[0]?.resourceId).toBe(resourceId);
      } else {
        expect(await count(athleteId, 'resource_passage')).toBe(0);
        expect(await count(athleteId, 'resource_retrieval_cache')).toBe(0);
        expect((await retrieval.retrieve(athleteId, query)).excerpts).toEqual([]);
      }
    });

  it('refuses to purge a derived store without a live lease on the manifest', async () => {
    const athleteId = randomUUID();
    await grantAiConsent(athleteId);
    const { resourceId, versionId, state } = await reviewedResource(athleteId);
    await retrieval.retrieve(athleteId, query);
    await resources.softDelete(athleteId, resourceId, {
      expectedAccessRevision: state.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    const manifestId = z
      .string()
      .parse(
        (
          await admin.query(
            'SELECT id FROM resource_derived_cleanup WHERE athlete_id=$1 AND completed_at IS NULL',
            [athleteId],
          )
        ).rows[0]?.['id'],
      );
    await expect(
      admin.query('SELECT public.purge_resource_derived_store($1,$2,$3)', [
        manifestId,
        randomUUID(),
        'searchIndex',
      ]),
    ).rejects.toThrow(/DERIVED_CLEANUP_LEASE_LOST/);
    expect(await count(athleteId, 'resource_passage')).toBeGreaterThan(0);

    const workerRole = `retrieval_purge_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await admin.query(`CREATE ROLE "${workerRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${workerRole}"`);
    await grantResourceObjectCleanupWorker(adminUrl as string, workerRole);
    const privileges = await admin.query(
      `SELECT has_table_privilege($1,'resource_passage','DELETE') AS can_delete_index,
       has_table_privilege($1,'resource_citation','SELECT') AS can_read_citations,
       has_function_privilege($1,'public.purge_resource_derived_store(uuid,uuid,text)','EXECUTE')
         AS can_purge`,
      [workerRole],
    );
    // The least-privilege worker deletes only through the leased function.
    expect(privileges.rows[0]).toEqual({
      can_delete_index: false,
      can_read_citations: false,
      can_purge: true,
    });
    await drainDerivedCleanup();
    expect(await count(athleteId, 'resource_passage')).toBe(0);
  });

  it('rejects an unknown derived target instead of reporting it purged', async () => {
    const athleteId = randomUUID();
    await grantAiConsent(athleteId);
    const { resourceId, versionId, state } = await reviewedResource(athleteId);
    await resources.softDelete(athleteId, resourceId, {
      expectedAccessRevision: state.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    const repository = createResourceDerivedCleanupRepository({
      connectionString: adminUrl as string,
      max: 1,
    });
    try {
      const leased = await repository.lease(new Date(), new Date(Date.now() + 60_000));
      if (!leased) throw new Error('Expected a leased manifest');
      await expect(
        admin.query('SELECT public.purge_resource_derived_store($1,$2,$3)', [
          leased.id,
          randomUUID(),
          'not_a_store',
        ]),
      ).rejects.toThrow(/DERIVED_CLEANUP_LEASE_LOST/);
      expect(await repository.finish(leased, { ok: false, errorCode: 'TEST' })).toBe(true);
    } finally {
      await repository.close();
    }
    await drainDerivedCleanup();
  });
});

describe('grounded coaching output cites reviewed excerpts', () => {
  it('pins a grounding, stores citations, and never resurrects them after deletion', async () => {
    const athleteId = randomUUID();
    const { thread, evidence } = await seedCoaching(athleteId);
    const { resourceId, versionId, state } = await reviewedResource(athleteId);
    const run = await runRepository().create(athleteId, thread.id, {
      schemaVersion: 1,
      evidenceSnapshotId: evidence.id,
      expectedConversationRevision: 1,
      retrieval: { kind: 'resource-access-v1', query: '회복' },
      idempotencyKey: randomUUID(),
    });

    const pinned = await admin.query(
      'SELECT run_id,excerpt_count,manifest FROM resource_grounding WHERE athlete_id=$1',
      [athleteId],
    );
    expect(pinned.rows[0]).toMatchObject({ run_id: run.id, excerpt_count: 1 });
    expect(await count(athleteId, 'resource_grounding_excerpt')).toBe(1);

    expect(
      await runOneCoachingJob({
        athleteId,
        store: runWorkerStore(),
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('stored');

    const grounded = await retrieval.readGrounding(athleteId, run.id);
    if (grounded.status !== 'available') throw new Error('Expected a pinned grounding');
    expect(grounded).toMatchObject({
      runId: run.id,
      query: '회복',
      pinnedResourceCount: 1,
      withdrawnExcerptCount: 0,
    });
    expect(grounded.excerpts).toHaveLength(1);
    expect(grounded.citations).toHaveLength(1);
    const citation = grounded.citations[0];
    if (citation?.status !== 'available') throw new Error('Expected a resolvable citation');
    // A citation is pinned to the exact resource version it was cut from.
    expect(citation).toMatchObject({ resourceId, versionId, claimIndex: 0 });
    expect(RESOURCE_TEXT).toContain(citation.quote);

    // Deleting the resource blocks the stored citation on the next read, well
    // before the asynchronous purge removes the rows.
    await resources.softDelete(athleteId, resourceId, {
      expectedAccessRevision: state.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    const blocked = await retrieval.readGrounding(athleteId, run.id);
    if (blocked.status !== 'available') throw new Error('Expected the grounding metadata');
    expect(blocked.excerpts).toEqual([]);
    expect(blocked.withdrawnExcerptCount).toBe(1);
    expect(blocked.citations).toEqual([
      {
        status: 'unavailable',
        citationId: citation.citationId,
        claimIndex: 0,
        reason: 'not_authorized',
      },
    ]);
    expect(await count(athleteId, 'resource_citation')).toBe(1);

    await drainDerivedCleanup();
    // The citation cannot outlive the excerpt: purging the index removes the
    // derived copy and the citation row with it.
    expect(await count(athleteId, 'resource_passage')).toBe(0);
    expect(await count(athleteId, 'resource_grounding_excerpt')).toBe(0);
    expect(await count(athleteId, 'resource_citation')).toBe(0);
    const purged = await retrieval.readGrounding(athleteId, run.id);
    if (purged.status !== 'available') throw new Error('Expected the grounding metadata');
    expect(purged.citations).toEqual([]);
    expect(purged.excerpts).toEqual([]);
    expect(purged.withdrawnExcerptCount).toBe(1);

    // A replayed cleanup and a replayed coaching job add nothing back.
    expect(await drainDerivedCleanup()).toEqual([]);
    expect(
      await runOneCoachingJob({
        athleteId,
        store: runWorkerStore(),
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('empty');
    expect(await count(athleteId, 'resource_citation')).toBe(0);

    const exported = await createOperationsRepository(database).exportAccount(athleteId);
    if (exported.schemaVersion !== 17) throw new Error('Expected the current account export');
    expect(exported.data.resourcePassages).toEqual([]);
    expect(exported.data.resourceCitations).toEqual([]);
    expect(exported.data.resourceGroundings).toHaveLength(1);
  });

  it('refuses to write a citation once the cited resource is no longer authorized', async () => {
    const athleteId = randomUUID();
    const { thread, evidence } = await seedCoaching(athleteId);
    const { resourceId, versionId, state } = await reviewedResource(athleteId);
    const run = await runRepository().create(athleteId, thread.id, {
      schemaVersion: 1,
      evidenceSnapshotId: evidence.id,
      expectedConversationRevision: 1,
      retrieval: { kind: 'resource-access-v1', query: '회복' },
      idempotencyKey: randomUUID(),
    });
    // Stop coach use after the run was created but before it is evaluated.
    await access.setCoachUse(athleteId, resourceId, {
      includeForCoach: false,
      expectedAccessRevision: state.accessRevision,
      expectedCurrentVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    // The pinned resource set changed, so the basis is stale and the job is
    // cancelled instead of producing an answer over withdrawn excerpts.
    expect(
      await runOneCoachingJob({
        athleteId,
        store: runWorkerStore(),
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('skipped');
    expect(await count(athleteId, 'resource_citation')).toBe(0);
    const stored = await admin.query('SELECT status FROM coaching_run WHERE athlete_id=$1', [
      athleteId,
    ]);
    expect(stored.rows[0]?.['status']).toMatchObject({ kind: 'cancelled', reason: 'stale_basis' });
    expect(await retrieval.readGrounding(athleteId, run.id)).toMatchObject({
      status: 'available',
      excerpts: [],
      citations: [],
      withdrawnExcerptCount: 1,
    });
    await drainDerivedCleanup();
  });

  it('refuses to approve a grounded candidate once another resource is authorized', async () => {
    const athleteId = randomUUID();
    const { thread, evidence } = await seedCoaching(athleteId);
    await reviewedResource(athleteId);
    const run = await runRepository().create(athleteId, thread.id, {
      schemaVersion: 1,
      evidenceSnapshotId: evidence.id,
      expectedConversationRevision: 1,
      retrieval: { kind: 'resource-access-v1', query: '회복' },
      idempotencyKey: randomUUID(),
    });
    expect(
      await runOneCoachingJob({
        athleteId,
        store: runWorkerStore(),
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('stored');
    const repository = createTrainingCandidateRepository(database, {
      policy: { id: 'running-core-v2-training', version: '1' },
      source: { kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' },
    });
    // A real, sealed candidate built while the grounded set was still current.
    const bundle = await repository.createFromFixture(athleteId, {
      runId: run.id,
      idempotencyKey: randomUUID(),
    });
    expect(bundle.candidate.validation.status).toBe('checked');

    // Authorizing one more resource changes the complete resource-access set
    // the run was grounded on, so approval rolls back before any plan write.
    await reviewedResource(athleteId);
    // Baselines are taken after that change and before the approval, so the
    // comparison isolates what the refused approval itself wrote.
    const planBefore = await createPlanningRepository(database).read(athleteId);
    const historyBefore = await admin.query(
      'SELECT count(*)::integer AS total FROM plan_history WHERE athlete_id=$1',
      [athleteId],
    );
    const outboxBefore = await admin.query(
      'SELECT count(*)::integer AS total FROM outbox WHERE athlete_id=$1',
      [athleteId],
    );
    await expect(
      repository.approve(athleteId, bundle.candidate.id, {
        expectedDigest: bundle.candidate.digest,
        confirmed: true,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'STALE_BASIS' });
    await expect(
      repository.createFromFixture(athleteId, { runId: run.id, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(TrainingCandidateError);

    const planAfter = await createPlanningRepository(database).read(athleteId);
    expect(planAfter.head?.id).toBe(planBefore.head?.id);
    expect(planAfter.head?.version).toBe(planBefore.head?.version);
    expect(
      (
        await admin.query(
          'SELECT count(*)::integer AS total FROM plan_history WHERE athlete_id=$1',
          [athleteId],
        )
      ).rows[0]?.['total'],
    ).toBe(historyBefore.rows[0]?.['total']);
    expect(
      (
        await admin.query('SELECT count(*)::integer AS total FROM outbox WHERE athlete_id=$1', [
          athleteId,
        ])
      ).rows[0]?.['total'],
    ).toBe(outboxBefore.rows[0]?.['total']);
    expect(await count(athleteId, 'resource_citation')).toBe(1);
    await drainDerivedCleanup();
  });

  it('reports no grounding for a run that read no resource', async () => {
    const athleteId = randomUUID();
    const { thread, evidence } = await seedCoaching(athleteId);
    const run = await runRepository().create(athleteId, thread.id, {
      schemaVersion: 1,
      evidenceSnapshotId: evidence.id,
      expectedConversationRevision: 1,
      idempotencyKey: randomUUID(),
    });
    expect(await retrieval.readGrounding(athleteId, run.id)).toEqual({ status: 'none' });
    expect(
      await runOneCoachingJob({
        athleteId,
        store: runWorkerStore(),
        adapter: createDeterministicFixtureAdapter('synthetic-v1'),
      }),
    ).toBe('stored');
    expect(await count(athleteId, 'resource_citation')).toBe(0);
  });
});
