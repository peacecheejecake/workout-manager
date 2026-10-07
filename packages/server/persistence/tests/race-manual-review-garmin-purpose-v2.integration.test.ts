import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import {
  migrate,
  grantCorePlanning,
  grantGarminUnofficial,
  grantOperations,
} from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createActivityRepository } from '../src/activities.js';
import { createGarminUnofficialStore } from '../src/garmin-unofficial.js';
import { impactDependencyDigest as digest } from '../src/race-plan-impact-dependencies.js';
import {
  captureRaceManualGarminActivitySourceV2In,
  captureRaceManualGarminPurposeV2In,
} from '../src/race-manual-review-garmin-purpose-v2.js';
import {
  projectGarminActivityReadFacts,
  validateGarminActivityReadFacts,
} from '../src/race-plan-impact-garmin-activity-read-facts.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Root execution only. Public import + trusted normal collector ledger port with
// synthetic attribution, not remote provider login or final manual-purpose grant.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `garmin_purpose_${suffix}`,
  ownerRole = `garmin_purpose_owner_${suffix}`,
  runtimeRole = `garmin_purpose_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl }),
  roles: string[] = [];
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
  await grantCorePlanning(url(ownerRole), runtimeRole);
  // Existing configured operations capability includes transaction erasure guard reads.
  await grantOperations(url(ownerRole), runtimeRole);
  await grantGarminUnofficial(url(ownerRole), runtimeRole);
  const owner = new Pool({ connectionString: url(ownerRole) });
  try {
    // Exact existing API activity runtime composition, not new product permission.
    await owner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
    );
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
});
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const r of roles.reverse()) await admin.query(`DROP ROLE "${r}"`);
  await admin.end();
});
async function tenant() {
  const athlete = randomUUID(),
    owner = new Pool({ connectionString: url(ownerRole) });
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
  return { athlete, consent };
}
async function snapshot<T>(athlete: string, op: (tx: Transaction) => Promise<T>) {
  if (!db.snapshotTenant) throw Error('SNAPSHOT_PORT_MISSING');
  return db.snapshotTenant(athlete, op);
}
async function collected(link = true) {
  const f = await tenant(),
    activities = createActivityRepository(db),
    collector = createGarminUnofficialStore(db);
  const source = {
    kind: 'fit' as const,
    sourceId: `Collected-食-A-${randomUUID()}`,
    revision: 1,
    contentHash: 'a'.repeat(64),
  };
  const activity = {
    title: 'Synthetic collected FIT',
    kind: 'strength' as const,
    startedAt: '2026-10-06T00:00:00Z',
    timezone: 'Asia/Seoul',
    durationSeconds: 0,
    durationKind: 'unknown' as const,
    distanceMeters: null,
  };
  const imported = await activities.importActivity(f.athlete, {
    source,
    activity,
    idempotencyKey: randomUUID(),
  });
  const current = await activities.updateOverlay(f.athlete, imported.activityId, {
    expectedRevision: imported.revision,
    idempotencyKey: randomUUID(),
    reason: 'Explicit synthetic overlay',
    distanceMeters: 0,
  });
  if (link)
    await collector.recordCollected({
      athleteId: f.athlete,
      garminActivityId: '987654321',
      provider: 'garmin-connect-unofficial',
      outcome: 'imported',
      sources: [{ kind: source.kind, sourceId: source.sourceId }],
      now: new Date('2026-10-07T00:00:00Z'),
      appRevision: 1,
    });
  const request = {
    activityId: current.id,
    canonicalRevision: current.revision,
    source,
    expectedOriginalDigest: digest(current.original),
    expectedOverlayDigest: current.overlay === null ? null : digest(current.overlay),
    expectedOverlayRevision: current.revision,
  };
  return { f, activities, collector, source, current, request };
}
it('public collected FIT current/overlay metadata maps exact owned tuple, app authorizes existing saved core use without collection grant inference', async () => {
  const x = await collected();
  await snapshot(x.f.athlete, async (tx) => {
    const budget = { bytes: 0n, sources: 0 },
      r = await captureRaceManualGarminActivitySourceV2In(tx, x.request, budget);
    expect(r.status).toBe('observed_garmin_current_source');
    if (r.status === 'blocked') throw Error(r.reason);
    expect(r.observation).toMatchObject({
      collectionPermission: 'not_captured',
      collection: { provider: 'garmin-connect-unofficial', official: false },
      originalDigest: digest(x.current.original),
      overlayDigest: digest(x.current.overlay),
    });
    const requested = {
      kind: 'activity',
      id: x.current.id,
      revisionId: String(x.current.revision),
      detailId: null,
      allocationId: null,
    };
    const head = { id: x.current.id, revision: x.current.revision, deleted: false };
    const input = {
      athleteId: x.f.athlete,
      refs: [requested],
      actualFacts: [
        {
          requested,
          state: 'current',
          reason: null,
          current: head,
          content: { original: x.current.original, overlay: x.current.overlay, detail: null },
        },
      ],
      activityRosters: [
        {
          ...head,
          originalDigest: digest(x.current.original),
          overlayDigest: digest(x.current.overlay),
          source: {
            state: 'present',
            kind: 'fit',
            sourceId: x.source.sourceId,
            sourceRevision: 1,
            contentHash: x.source.contentHash,
          },
        },
      ],
      activityMetadata: [
        {
          ...head,
          overlay: { state: 'present', revision: x.current.revision },
          source: {
            state: 'present',
            kind: 'fit',
            sourceId: x.source.sourceId,
            revision: 1,
            contentHash: x.source.contentHash,
            suppressed: false,
            revisionRecord: { state: 'present' },
          },
        },
      ],
      garminSources: [{ activityId: x.current.id, observation: r.observation, reason: null }],
    };
    const mapped = projectGarminActivityReadFacts(input);
    expect(mapped.status).toBe('projected_retained_garmin_read_facts');
    if (mapped.status === 'blocked') throw Error(mapped.reason);
    expect(validateGarminActivityReadFacts(mapped.facts, input)).toMatchObject({
      status: 'validated_retained_garmin_read_facts',
      authority: 'none',
      sourceAuthentication: 'unverified',
    });
    expect(x.current.original.durationSeconds).toBe(0);
    expect(x.current.original.distanceMeters).toBeNull();
    expect(x.current.overlay?.distanceMeters).toBe(0);
    expect(await captureRaceManualGarminPurposeV2In(tx, x.request, budget)).toMatchObject({
      status: 'observed_saved_activity_core_use',
      observation: {
        kind: 'own_garmin_current_core_activity',
        appAdmission: { kind: 'app', granted: true, revision: 1 },
        collectionPermission: 'not_captured',
      },
      admissionAllowed: false,
      approvalAllowed: false,
    });
  });
});
it('local FIT without actual ledger and foreign scope cannot become Garmin provenance', async () => {
  const x = await collected(false),
    foreign = await tenant();
  expect(
    await snapshot(x.f.athlete, (tx) =>
      captureRaceManualGarminActivitySourceV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({ reason: 'garmin_provenance_unavailable' });
  expect(
    await snapshot(foreign.athlete, (tx) =>
      captureRaceManualGarminActivitySourceV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({ reason: 'garmin_source_unavailable' });
  expect(
    await snapshot(foreign.athlete, (tx) =>
      captureRaceManualGarminPurposeV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({ reason: 'garmin_source_unavailable' });
});
it('historical/current drift and real public deletion reject prior tuple without repinning', async () => {
  const x = await collected();
  expect(
    await snapshot(x.f.athlete, (tx) =>
      captureRaceManualGarminActivitySourceV2In(
        tx,
        { ...x.request, source: { ...x.source, revision: 2 } },
        { bytes: 0n, sources: 0 },
      ),
    ),
  ).toMatchObject({ reason: 'garmin_source_tuple_mismatch' });
  const next = await x.activities.updateOverlay(x.f.athlete, x.current.id, {
    expectedRevision: x.current.revision,
    idempotencyKey: randomUUID(),
    reason: 'Explicit changed overlay',
    title: 'New current',
  });
  expect(
    await snapshot(x.f.athlete, (tx) =>
      captureRaceManualGarminActivitySourceV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({ reason: 'garmin_source_tuple_mismatch' });
  await x.activities.deleteActivity(x.f.athlete, x.current.id, { expectedRevision: next.revision });
  expect(
    await snapshot(x.f.athlete, (tx) =>
      captureRaceManualGarminActivitySourceV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({ reason: 'garmin_source_deleted', observation: null });
});
it('provider compatibility cycles/disconnect do not replace or deny saved core app admission', async () => {
  const x = await collected();
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'provider',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'provider',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await x.collector.disconnect(x.f.athlete);
  expect(
    await snapshot(x.f.athlete, (tx) =>
      captureRaceManualGarminPurposeV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({
    status: 'observed_saved_activity_core_use',
    observation: { collectionPermission: 'not_captured' },
  });
});

it('public app withdrawal denies new core processing while exact owned retained metadata remains readable', async () => {
  const x = await collected();
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await snapshot(x.f.athlete, async (tx) => {
    expect(
      await captureRaceManualGarminPurposeV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'garmin_core_app_processing_required',
      observation: null,
    });
    expect(
      await captureRaceManualGarminActivitySourceV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ).toMatchObject({
      status: 'observed_garmin_current_source',
      observation: { collectionPermission: 'not_captured' },
    });
  });
  expect(await x.activities.getActivity(x.f.athlete, x.current.id)).toEqual(x.current);
});

it('public app reallow observes the new processing revision without using old JSON as credential', async () => {
  const x = await collected();
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: false,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  await x.f.consent.setConsent(x.f.athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 2,
    idempotencyKey: randomUUID(),
  });
  expect(
    await snapshot(x.f.athlete, (tx) =>
      captureRaceManualGarminPurposeV2In(tx, x.request, { bytes: 0n, sources: 0 }),
    ),
  ).toMatchObject({
    status: 'observed_saved_activity_core_use',
    observation: { appAdmission: { revision: 3 }, collectionPermission: 'not_captured' },
  });
});
