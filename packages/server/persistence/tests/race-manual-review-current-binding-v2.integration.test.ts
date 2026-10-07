import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualReviewCompatibleV4PreparationService } from '../src/race-manual-review-preparation-v2.js';
import { requireCurrentRaceManualReviewBindingV2In } from '../src/race-manual-review-current-binding-v2.js';
import { raceImpactConsumedScopeSchema } from '../src/race-plan-impact-complete-manifest.js';
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
const name = `manual_binding_${suffix}`,
  ownerRole = `manual_binding_owner_${suffix}`,
  runtimeRole = `manual_binding_app_${suffix}`;
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
async function capture(f: Awaited<ReturnType<typeof setup>>, target = db) {
  const result = await createRaceManualReviewCompatibleV4PreparationService(target).prepare(
    f.athlete,
    f.intent,
  );
  if (!('currentManualBinding' in result)) throw Error('CURRENT_MANUAL_BINDING_MISSING');
  const c = result.context;
  if (c.manualBasis.app.state !== 'present') throw Error('CAPTURED_APP_MISSING');
  const provenance = {
    athleteId: c.athleteId,
    restoreGeneration: c.restoreGeneration,
    event: c.event,
    manualBasis: c.manualBasis,
    readSetDigest: c.readSetDigest,
  };
  const scope = raceImpactConsumedScopeSchema.parse({
    purpose: c.manualBasis.purpose,
    athleteId: c.athleteId,
    restoreGeneration: c.restoreGeneration,
    expectedEvent: { id: c.event.id, revision: c.event.revision },
    expectedPolicy: c.manualBasis.policy,
    expectedAppRevision: c.manualBasis.app.revision,
    expectedReadSetDigest: c.readSetDigest,
  });
  expect(result.currentManualBinding).toMatchObject({
    status: 'current_manual_basis_checked',
    authority: 'none',
    permissionAuthority: 'none',
    freshness: 'not_checked',
    storage: 'not_persisted',
    admissionAllowed: false,
    approvalAllowed: false,
  });
  expect(result.context.coverage.complete).toBe(false);
  expect(result.context.coverage.missing).toHaveLength(5);
  return { result, provenance, scope };
}
async function inSnapshot<T>(athlete: string, op: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return db.snapshotTenant(athlete, op);
}
function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitForAdvisoryWait() {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const rows = await admin.query(
      "SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=$1 AND l.locktype='advisory' AND NOT l.granted",
      [name],
    );
    if (rows.rowCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw Error('REAL_ADVISORY_WAIT_NOT_OBSERVED');
}
it('actual public manual app allow/AI false preparation consumes current binding without artifacts', async () => {
  const f = await setup();
  const artifacts = () =>
    db.tenant(
      f.athlete,
      async (tx) =>
        (
          await tx.query(
            'SELECT (SELECT count(*) FROM command_receipt WHERE athlete_id=$1)::int AS receipts,(SELECT count(*) FROM outbox WHERE athlete_id=$1)::int AS outbox',
            [f.athlete],
          )
        ).rows,
    );
  const before = await artifacts();
  const r = await capture(f);
  expect(r.result.currentManualBinding.appRevision).toBe(1);
  expect(await artifacts()).toEqual(before);
});
it('withdraw denies new prepare and reallow changed revision rejects original basis', async () => {
  const f = await setup();
  const old = await capture(f);
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await expect(capture(f)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
  await f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  await expect(
    inSnapshot(f.athlete, (tx) =>
      requireCurrentRaceManualReviewBindingV2In(tx, old.provenance, old.scope),
    ),
  ).rejects.toThrow('STALE_RACE_MANUAL_BASIS');
  expect((await capture(f)).result.currentManualBinding.appRevision).toBe(3);
});
it('unused provider/HK/media consent drift changes raw capture but not the narrow app-policy check', async () => {
  const f = await setup();
  const old = await capture(f);
  for (const kind of ['provider', 'healthkit', 'media'] as const) {
    await f.consent.setConsent(f.athlete, {
      kind,
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await f.consent.setConsent(f.athlete, {
      kind,
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
  }
  const current = await capture(f);
  expect(current.result.context.readSetDigest).not.toBe(old.result.context.readSetDigest);
  expect(
    await inSnapshot(f.athlete, (tx) =>
      requireCurrentRaceManualReviewBindingV2In(tx, old.provenance, old.scope),
    ),
  ).toMatchObject({
    status: 'current_manual_basis_checked',
    freshness: 'not_checked',
    permissionAuthority: 'none',
  });
  // Deliberately not a semantic-freshness/fullpermission acceptance: no consumed
  // provider source exists in this direct-manual fixture.
});
it('rejects old policy/matching fake generation/foreign tenant despite matching supplied tuples', async () => {
  const f = await setup();
  const old = await capture(f);
  const stalePolicy = { ...old.provenance.manualBasis.policy, digest: '0'.repeat(64) };
  await expect(
    inSnapshot(f.athlete, (tx) =>
      requireCurrentRaceManualReviewBindingV2In(
        tx,
        { ...old.provenance, manualBasis: { ...old.provenance.manualBasis, policy: stalePolicy } },
        { ...old.scope, expectedPolicy: stalePolicy },
      ),
    ),
  ).rejects.toThrow('STALE_RACE_MANUAL_POLICY');
  const fakeGeneration = randomUUID();
  await expect(
    inSnapshot(f.athlete, (tx) =>
      requireCurrentRaceManualReviewBindingV2In(
        tx,
        { ...old.provenance, restoreGeneration: fakeGeneration },
        { ...old.scope, restoreGeneration: fakeGeneration },
      ),
    ),
  ).rejects.toMatchObject({ code: 'STALE_RESTORE_GENERATION' });
  const other = await setup();
  await expect(
    inSnapshot(other.athlete, (tx) =>
      requireCurrentRaceManualReviewBindingV2In(tx, old.provenance, old.scope),
    ),
  ).rejects.toMatchObject({ code: 'MANUAL_SCOPE_MISMATCH' });
});
it('withdraw commits while prepare waits on tenant0: fenced snapshot reads latest denial', async () => {
  const f = await setup();
  const written = latch(),
    commit = latch();
  const held: Database = {
    ...db,
    tenant: (athlete, op) =>
      db.tenant(athlete, async (tx) => {
        const result = await op(tx);
        written.release();
        await commit.promise;
        return result;
      }),
  };
  const withdrawal = createConsentRepository(held).setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  try {
    await Promise.race([
      written.promise,
      withdrawal.then(() => {
        throw Error('WITHDRAW_BARRIER_MISSING');
      }),
    ]);
  } catch (error) {
    commit.release();
    await Promise.allSettled([withdrawal]);
    throw error;
  }
  const pending = capture(f).then(
    () => ({ state: 'unexpected_success' as const }),
    (error) => ({ state: 'error' as const, error }),
  );
  try {
    await waitForAdvisoryWait();
  } catch (error) {
    commit.release();
    await Promise.allSettled([withdrawal, pending]);
    throw error;
  } finally {
    commit.release();
  }
  await withdrawal;
  expect(await pending).toMatchObject({ state: 'error', error: { code: 'APP_CONSENT_REQUIRED' } });
});
it('prepare holds fenced snapshot first: withdrawal waits, subsequent processing denies', async () => {
  const f = await setup();
  const checked = latch(),
    finish = latch();
  const snapshot = db.snapshotTenant;
  if (!snapshot) throw Error('SNAPSHOT_PORT_MISSING');
  const held: Database = {
    ...db,
    snapshotTenant: (athlete, op) =>
      snapshot(athlete, async (tx) => {
        const result = await op(tx);
        checked.release();
        await finish.promise;
        return result;
      }),
  };
  const prepared = capture(f, held);
  try {
    await Promise.race([
      checked.promise,
      prepared.then(() => {
        throw Error('PREPARE_BARRIER_MISSING');
      }),
    ]);
  } catch (error) {
    finish.release();
    await Promise.allSettled([prepared]);
    throw error;
  }
  const withdrawal = f.consent.setConsent(f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  try {
    await waitForAdvisoryWait();
  } catch (error) {
    finish.release();
    await Promise.allSettled([prepared, withdrawal]);
    throw error;
  } finally {
    finish.release();
  }
  expect((await prepared).result.currentManualBinding.appRevision).toBe(1);
  await withdrawal;
  await expect(capture(f)).rejects.toMatchObject({ code: 'APP_CONSENT_REQUIRED' });
});
