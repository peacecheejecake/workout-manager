import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createOperationsRepository } from '../src/operations.js';
import { prepareRaceManualSemanticBasisV2In } from '../src/race-manual-review-semantic-basis-v2.js';
import {
  raceManualReviewChainResultV2Schema,
  storeRaceManualReviewChainV2In,
  readRaceManualReviewCompatibleChainIn,
} from '../src/race-manual-review-chain-v2.js';
import { prepareRaceManualApprovalIn } from '../src/race-manual-approval.js';
import { installCurrentRuntimeV4 } from '../src/current-runtime-installation-v4.js';
import { grantCurrentRuntimeV4Profile } from '../src/current-runtime-grants-v4.js';
import * as baseline from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root executes actual PG. Identity-only account FK prerequisite; all source
// content/app decisions use genuine public repositories. No owner health rows.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `same_tx_parent_ack_${suffix}`,
  ownerRole = `same_tx_parent_ack_owner_${suffix}`,
  runtimeRole = `same_tx_parent_ack_app_${suffix}`;
const signature = 'public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)';
const admin = new Pool({ connectionString: adminUrl });
let created = false,
  db: Database;
const roles: string[] = [];
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function owner<T>(apply: (p: Pool) => Promise<T>) {
  const p = new Pool({ connectionString: url(ownerRole), max: 1 });
  try {
    return await apply(p);
  } finally {
    await p.end();
  }
}
const appRecipe = [
  baseline.grantIdentityFunctions,
  baseline.grantAiSettings,
  baseline.grantOperations,
  baseline.grantNutritionCore,
  baseline.grantSupplementaryCore,
  baseline.grantRoutineCore,
  baseline.grantStretchingCore,
  baseline.grantRecoveryCore,
  baseline.grantCheckIns,
  baseline.grantSessionCompletions,
  baseline.grantPlanScenarios,
  baseline.grantCoachingConstraints,
  baseline.grantCoachingThreads,
  baseline.grantCoreEvidenceSnapshots,
  baseline.grantCoachingRuns,
  baseline.grantCoachingCandidates,
  baseline.grantIntegratedApprovalV4,
  baseline.grantResources,
  baseline.grantResourceRetrieval,
  baseline.grantGalleryMedia,
  baseline.grantActivityTracks,
  baseline.grantCourses,
  baseline.grantRaces,
  baseline.grantCorePlanning,
  baseline.grantGarmin,
  baseline.grantGarminUnofficial,
];
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
  created = true;
  await baseline.migrate(url(ownerRole), 107);
  await installCurrentRuntimeV4(url(ownerRole));
  for (const grant of appRecipe) await grant(url(ownerRole), runtimeRole);
  await grantCurrentRuntimeV4Profile(url(ownerRole), runtimeRole);
  await owner(async (p) => {
    await p.query(
      await readFile(
        new URL('../migrations/131_manual_race_same_tx_parent_ack.sql', import.meta.url),
        'utf8',
      ),
    );
    await p.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
  });
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
}, 180000);
afterAll(async () => {
  await pendingFixtureWork;
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
// Terminal drain includes any undo/rollback: Vitest timeout is not cancellation.
let pendingFixtureWork: Promise<void> = Promise.resolve();
function fixtureIt(label: string, apply: () => Promise<void>) {
  it(
    label,
    async () => {
      const work = pendingFixtureWork.then(apply);
      pendingFixtureWork = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    30000,
  );
}
async function setup() {
  const athlete = randomUUID();
  await owner((p) =>
    p.query(
      "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
      [athlete, athlete],
    ),
  );
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
      title: 'Synthetic ack source',
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
    athlete,
    race,
    intent: {
      expectedEvent: { id: race.id, revision: race.revision },
      newLocalDate: '2026-10-08',
      selection: { kind: 'keep_plan' as const },
    },
  };
}
const ackSchema = z.strictObject({
  ackVersion: z.literal(1),
  result: raceManualReviewChainResultV2Schema,
  bodyState: z.literal('present'),
  payloadDigestMethod: z.literal('postgres-jsonb-v1'),
  payloadSqlDigest: z.string().regex(/^[a-f0-9]{64}$/),
  correspondence: z.literal('same_tx_stored_parent'),
});
async function storeIn(tx: Transaction, f: Awaited<ReturnType<typeof setup>>) {
  const budget = { bytes: 0n, sources: 0 };
  const current = await prepareRaceManualSemanticBasisV2In(tx, f.intent, null, budget);
  if (current.status !== 'current_dependencies_captured')
    throw Error('ACTUAL_CURRENT_BASIS_UNAVAILABLE');
  const command = {
    schemaVersion: 2 as const,
    idempotencyKey: randomUUID(),
    intent: f.intent,
    expectedBasis: current.basis,
  };
  const stored = await storeRaceManualReviewChainV2In(tx, command, budget);
  if (stored.status !== 'stored') throw Error('ACTUAL_CHAIN_NOT_STORED');
  // Fixture reads the actual DB-stored body; it does not handbuild an expected
  // successful payload. Production continuation will avoid this full transfer.
  const read = await readRaceManualReviewCompatibleChainIn(tx, stored.result.evidenceId, budget);
  if (!read || read.payload === null) throw Error('ACTUAL_PARENT_UNAVAILABLE');
  expect(read.result).toEqual(stored.result);
  return { stored, read, command, current, budget };
}
type Stored = Awaited<ReturnType<typeof storeIn>>;
async function ack(
  tx: Transaction,
  s: Stored,
  body: unknown = s.read.payload,
  tuple = s.stored.result,
) {
  const result = await tx.query(
    'SELECT public.ack_manual_race_same_tx_parent_v1($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb) AS ack',
    [
      tuple.evidenceId,
      tuple.decisionId,
      tuple.proposalId,
      tuple.candidateDigest,
      JSON.stringify(body),
    ],
  );
  return ackSchema.parse(result.rows[0]?.['ack']);
}
async function rejectedAtSavepoint(
  tx: Transaction,
  apply: () => Promise<unknown>,
  expected: string,
) {
  await tx.query('SAVEPOINT rejected_ack');
  try {
    await expect(apply()).rejects.toThrow(expected);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT rejected_ack');
    await tx.query('RELEASE SAVEPOINT rejected_ack');
  }
}
fixtureIt(
  'actual sameTx public-source store yields only exact minimal ack then SQL118 still validates application',
  async () => {
    const f = await setup();
    const beforeRace = await createRaceRepository(db).getRaceEvent(f.athlete, f.race.id);
    expect(beforeRace).not.toBeNull();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    await db.snapshotTenant(f.athlete, async (tx) => {
      const s = await storeIn(tx, f);
      const a = await ack(tx, s);
      expect(a.result).toEqual(s.stored.result);
      expect(Object.keys(a).sort()).toEqual([
        'ackVersion',
        'bodyState',
        'correspondence',
        'payloadDigestMethod',
        'payloadSqlDigest',
        'result',
      ]);
      // A byte-equivalent JSON copy is correspondence, never a process-private handle.
      expect(await ack(tx, s, structuredClone(s.read.payload))).toEqual(a);
      const hash = await tx.query(
        "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS digest",
        [JSON.stringify(s.read.payload)],
      );
      expect(a.payloadSqlDigest).toBe(hash.rows[0]?.['digest']);
      const prepared = await prepareRaceManualApprovalIn(
        tx,
        {
          schemaVersion: 1,
          chain: {
            evidenceId: a.result.evidenceId,
            decisionId: a.result.decisionId,
            proposalId: a.result.proposalId,
            readonlyCandidateDigest: a.result.candidateDigest,
          },
          intent: f.intent,
          expectedBasis: s.current.basis,
        },
        s.budget,
      );
      expect(prepared.status).toBe('prepared');
    });
    expect(await createRaceRepository(db).getRaceEvent(f.athlete, f.race.id)).toEqual(beforeRace);
  },
);
fixtureIt(
  'wrong parent tuple, original digest or changed copied body cannot acknowledge',
  async () => {
    const f = await setup();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    await db.snapshotTenant(f.athlete, async (tx) => {
      const s = await storeIn(tx, f);
      await rejectedAtSavepoint(
        tx,
        () => ack(tx, s, s.read.payload, { ...s.stored.result, decisionId: randomUUID() }),
        'SAME_TX_PARENT_CORRESPONDENCE_MISMATCH',
      );
      await rejectedAtSavepoint(
        tx,
        () => ack(tx, s, s.read.payload, { ...s.stored.result, candidateDigest: 'a'.repeat(64) }),
        'SAME_TX_PARENT_INVALID_INPUT',
      );
      const changed = structuredClone(s.read.payload);
      if (changed?.state !== 'present') throw Error('PRESENT_PARENT_REQUIRED');
      changed.payload.preparation.context.event.title = 'Tampered source';
      await rejectedAtSavepoint(
        tx,
        () => ack(tx, s, changed),
        'SAME_TX_PARENT_CORRESPONDENCE_MISMATCH',
      );
      expect((await ack(tx, s)).result).toEqual(s.stored.result);
    });
  },
);
fixtureIt(
  'foreign tenant and historical replay in a new xid never obtain sameTx acknowledgement',
  async () => {
    const f = await setup(),
      other = await setup();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    const s = await db.snapshotTenant(f.athlete, (tx) => storeIn(tx, f));
    await expect(db.snapshotTenant(other.athlete, (tx) => ack(tx, s))).rejects.toThrow(
      'SAME_TX_PARENT_INVALID_INPUT',
    );
    await db.snapshotTenant(f.athlete, async (tx) => {
      const replay = await storeRaceManualReviewChainV2In(tx, s.command, { bytes: 0n, sources: 0 });
      expect(replay.status).toBe('replayed');
      if (replay.status !== 'replayed') throw Error('REPLAY_REQUIRED');
      expect(replay.result).toEqual(s.stored.result);
      await rejectedAtSavepoint(tx, () => ack(tx, s), 'SAME_TX_PARENT_CORRESPONDENCE_MISMATCH');
    });
  },
);
fixtureIt(
  'actual source deletion purges parent and receipt replay remains minimal but ack unavailable',
  async () => {
    const f = await setup();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    const s = await db.snapshotTenant(f.athlete, (tx) => storeIn(tx, f));
    await createRaceRepository(db).deleteRaceEvent(f.athlete, f.race.id, {
      expectedRevision: f.race.revision,
      idempotencyKey: randomUUID(),
    });
    await db.snapshotTenant(f.athlete, async (tx) => {
      const read = await readRaceManualReviewCompatibleChainIn(tx, s.stored.result.evidenceId, {
        bytes: 0n,
        sources: 0,
      });
      expect(read?.payload).toBeNull();
      expect(read?.result).toEqual(s.stored.result);
      await rejectedAtSavepoint(tx, () => ack(tx, s), 'SAME_TX_PARENT_UNAVAILABLE');
    });
  },
);
fixtureIt(
  'app withdrawal preserves original receipt only; erasure denies all further parent access',
  async () => {
    const f = await setup();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    const s = await db.snapshotTenant(f.athlete, (tx) => storeIn(tx, f));
    await createConsentRepository(db).setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await db.snapshotTenant(f.athlete, async (tx) => {
      const replay = await storeRaceManualReviewChainV2In(tx, s.command, { bytes: 0n, sources: 0 });
      expect(replay.status).toBe('replayed');
      await rejectedAtSavepoint(tx, () => ack(tx, s), 'SAME_TX_PARENT_CORRESPONDENCE_MISMATCH');
    });
    expect(await createOperationsRepository(db).eraseAccount(f.athlete)).toEqual({ erased: true });
    await expect(db.snapshotTenant(f.athlete, (tx) => ack(tx, s))).rejects.toThrow();
  },
);
fixtureIt(
  'runtime cannot mutate payload, seal caller or remove receipt; successful ack stays exact',
  async () => {
    const f = await setup();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    await db.snapshotTenant(f.athlete, async (tx) => {
      const s = await storeIn(tx, f);
      for (const query of [
        'UPDATE public.manual_race_evidence_v2 SET payload=NULL WHERE id=$1',
        "UPDATE public.manual_race_chain_commit_v2 SET caller_role='forged' WHERE evidence_id=$1",
        'DELETE FROM public.manual_race_chain_receipt_v2 WHERE evidence_id=$1',
        'DELETE FROM public.manual_race_chain_source_ref_v2 WHERE evidence_id=$1',
      ]) {
        await tx.query('SAVEPOINT denied_private_mutation');
        try {
          await expect(tx.query(query, [s.stored.result.evidenceId])).rejects.toMatchObject({
            code: '42501',
          });
        } finally {
          await tx.query('ROLLBACK TO SAVEPOINT denied_private_mutation');
          await tx.query('RELEASE SAVEPOINT denied_private_mutation');
        }
      }
      expect((await ack(tx, s)).result).toEqual(s.stored.result);
    });
  },
);
fixtureIt(
  'oversized expected body is rejected before parent read and rollback leaves no parent',
  async () => {
    const f = await setup();
    if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
    let rolled: Stored | undefined;
    await expect(
      db.snapshotTenant(f.athlete, async (tx) => {
        const s = await storeIn(tx, f);
        rolled = s;
        await rejectedAtSavepoint(
          tx,
          () => ack(tx, s, { text: 'x'.repeat(4194304) }),
          'SAME_TX_PARENT_INVALID_INPUT',
        );
        expect((await ack(tx, s)).result).toEqual(s.stored.result);
        throw Error('FORCED_PARENT_ROLLBACK');
      }),
    ).rejects.toThrow('FORCED_PARENT_ROLLBACK');
    if (!rolled) throw Error('ROLLBACK_FIXTURE_MISSING');
    const s = rolled;
    await db.snapshotTenant(f.athlete, async (tx) => {
      expect(
        await readRaceManualReviewCompatibleChainIn(tx, s.stored.result.evidenceId, {
          bytes: 0n,
          sources: 0,
        }),
      ).toBeNull();
      await rejectedAtSavepoint(tx, () => ack(tx, s), 'SAME_TX_PARENT_UNAVAILABLE');
    });
  },
);
fixtureIt(
  'new function is narrowly executable only, preserves profile20 and rejects ordinary RC caller',
  async () => {
    await owner(async (p) => {
      const metadata = await p.query(
        `SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) owner,
   NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_revoked,
   (SELECT count(*)::int FROM wm_runtime_installation.migration)+3 installed_steps,
   (SELECT max(version)::int FROM public.schema_migrations) baseline
   FROM pg_proc p WHERE p.oid=$1::regprocedure`,
        [signature],
      );
      expect(metadata.rows[0]).toEqual({
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
        owner: ownerRole,
        public_revoked: true,
        installed_steps: 20,
        baseline: 107,
      });
    });
    const f = await setup();
    await expect(
      db.tenant(f.athlete, (tx) =>
        tx.query(
          'SELECT public.ack_manual_race_same_tx_parent_v1($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb)',
          [randomUUID(), randomUUID(), randomUUID(), 'a'.repeat(64), '{}'],
        ),
      ),
    ).rejects.toThrow('SAME_TX_PARENT_CONTEXT_REQUIRED');
  },
);
