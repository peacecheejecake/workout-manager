import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import type { RaceEventValues } from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createConsentRepository } from '../src/repositories.js';
import { prepareRaceManualReview } from '../src/race-manual-review-preparation.js';
import { mapRaceManualReviewSourceInventory } from '../src/race-manual-review-source-inventory.js';
import {
  migrate,
  migrationFileNames,
  grantCorePlanning,
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
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  dbName = `race_inventory_${suffix}`,
  ownerRole = `race_inventory_owner_${suffix}`,
  runtimeRole = `race_inventory_app_${suffix}`;
let owner: Pool, database: Database, races: RaceRepository;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  return value.toString();
}
async function owned<T>(athlete: string, operation: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const values = (): RaceEventValues => ({
  title: 'Synthetic race',
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
});
async function account(granted: boolean | null = true) {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  if (granted !== null)
    await createConsentRepository(database).setConsent(athlete, {
      kind: 'app',
      granted,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
  return athlete;
}
const create = (athlete: string, override: Partial<RaceEventValues> = {}) =>
  races.createRaceEvent(athlete, {
    values: { ...values(), ...override },
    idempotencyKey: randomUUID(),
  });
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
      endDateExclusive: level === 'block' ? '2026-10-20' : '2026-11-01',
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
async function training(athlete: string, body = draft(), current = true) {
  const id = randomUUID();
  await owned(athlete, async (client) => {
    await client.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) SELECT $1,$2,coalesce(max(version),0)+1,$3::jsonb FROM plan_snapshot WHERE athlete_id=$1',
      [athlete, id, JSON.stringify(body)],
    );
    if (current)
      await client.query(
        'INSERT INTO plan_head(athlete_id,aggregate_id,version_id) VALUES($1,$2,$3)',
        [athlete, randomUUID(), id],
      );
  });
  return id;
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  owner = new Pool({ connectionString: url(ownerRole) });
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  // The configured identity runtime uses these same domain grants; no fixture-only SELECT.
  await grantRoutineCore(url(ownerRole), runtimeRole);
  await grantRecoveryCore(url(ownerRole), runtimeRole);
  await grantCheckIns(url(ownerRole), runtimeRole);
  await grantCourses(url(ownerRole), runtimeRole);
  await grantNutritionCore(url(ownerRole), runtimeRole);
  // Same regular resources/retrieval combination as the configured authenticated runtime.
  await grantResources(url(ownerRole), runtimeRole);
  await grantResourceRetrieval(url(ownerRole), runtimeRole);
  // Existing configured product role composition, not collector-only privilege fabrication.
  await grantGalleryMedia(url(ownerRole), runtimeRole);
  await grantGarminUnofficial(url(ownerRole), runtimeRole);
  database = createDatabase({ connectionString: url(runtimeRole) });
  races = createRaceRepository(database);
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
// Synthetic tenant source fixtures use plain owner+tenant context, not browser facts.
const prepare = (athlete: string, eventId: string, revision = 1) =>
  database.tenant(athlete, (tx) => prepareRaceManualReview(tx, intent(eventId, revision)));
const intent = (id: string, revision = 1) => ({
  expectedEvent: { id, revision },
  newLocalDate: '2026-10-08',
  selection: { kind: 'keep_plan' },
});
async function counts(athlete: string) {
  return owned(athlete, async (client) => {
    const names = [
      'plan_snapshot',
      'plan_history',
      'command_receipt',
      'race_command_receipt',
      'outbox',
      'session_completion',
      'activity_canonical',
    ];
    const rows: [string, unknown][] = [];
    for (const name of names) {
      const row = await client.query(`SELECT count(*)::int AS n FROM ${name} WHERE athlete_id=$1`, [
        athlete,
      ]);
      rows.push([name, row.rows[0]?.n]);
    }
    return Object.fromEntries(rows);
  });
}

it('maps exact owned prepared event lineage but never changes storage, admission or database facts', async () => {
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n,max(version)::int AS last FROM schema_migrations',
      )
    ).rows[0],
  ).toEqual({ n: 107, last: 107 });
  expect(migrationFileNames).toHaveLength(107);
  for (const [version, file] of [
    [106, '106_race_manual_review.sql'],
    [107, '107_guard_race_review_stamp_authority.sql'],
  ] as const) {
    expect(migrationFileNames[version - 1]).toBe(file);
    expect(
      (await owner.query('SELECT checksum FROM schema_migrations WHERE version=$1', [version]))
        .rows,
    ).toEqual([
      {
        checksum: createHash('sha256')
          .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
          .digest('hex'),
      },
    ]);
  }
  const athlete = await account(),
    event = await create(athlete),
    before = await counts(athlete);
  const prepared = await prepare(athlete, event.id);
  expect(prepared.status).toBe('prepared_blocked');
  const mapped = mapRaceManualReviewSourceInventory(prepared);
  expect(mapped.refs).toContainEqual(
    expect.objectContaining({ kind: 'race-event', sourceId: event.id, versionKey: '1' }),
  );
  expect(mapped).toMatchObject({
    complete: false,
    coverage: false,
    storage: 'not_persisted',
    storageAllowed: false,
    approvalAllowed: false,
    sourceCompleteness: 'unverified',
  });
  expect(await counts(athlete)).toEqual(before);
  // Full real collector output is inspected below, not reduced to a fabricated capture.
  expect(mapped.unindexable).toEqual([]);
  expect(mapped.inventoryState).toBe('mapped');
  expect(mapped.allCopiedBodiesIndexed).toBe(true);
});
it('preserves exact owned historical and current Plan snapshot namespaces from authenticated preparation', async () => {
  const athlete = await account(),
    historical = await training(athlete, draft(), false),
    current = await training(athlete),
    event = await create(athlete, { planVersionId: historical });
  const before = await counts(athlete),
    prepared = await prepare(athlete, event.id);
  expect(prepared.status).toBe('prepared_blocked');
  const mapped = mapRaceManualReviewSourceInventory(prepared);
  expect(mapped.refs).toContainEqual(
    expect.objectContaining({ kind: 'plan-snapshot', sourceId: historical, versionKey: '1' }),
  );
  expect(mapped.refs).toContainEqual(
    expect.objectContaining({ kind: 'plan-snapshot', sourceId: current, versionKey: '2' }),
  );
  expect(mapped.inventoryState).toBe('mapped');
  expect(mapped.allCopiedBodiesIndexed).toBe(true);
  expect(mapped.storageAllowed).toBe(false);
  expect(await counts(athlete)).toEqual(before);
});
it('rejects foreign preparation and forged body copies without writes or replacement of the server capture', async () => {
  const athlete = await account(),
    foreign = await account(),
    event = await create(athlete),
    before = await counts(athlete);
  await expect(prepare(foreign, event.id)).rejects.toMatchObject({ code: 'EVENT_UNAVAILABLE' });
  const prepared = await prepare(athlete, event.id);
  if (prepared.status !== 'prepared_blocked') throw new Error('Expected server preparation');
  const forged = structuredClone(prepared);
  forged.sourceInput.projectionInput.event.title = 'Synthetic forged copy';
  const result = mapRaceManualReviewSourceInventory(forged);
  expect(result.inventoryState).toBe('blocked');
  expect(result.allCopiedBodiesIndexed).toBe(false);
  expect(prepared.sourceInput.projectionInput.event.title).toBe(values().title);
  expect(await counts(athlete)).toEqual(before);
});
it('blocks unsupported copies and transaction rollback retains the original owned source state', async () => {
  const athlete = await account(),
    event = await create(athlete),
    before = await counts(athlete);
  const prepared = await prepare(athlete, event.id);
  if (prepared.status !== 'prepared_blocked') throw new Error('Expected server preparation');
  const unsupported = {
    ...prepared,
    context: {
      ...prepared.context,
      actuals: { original: { title: 'Synthetic unsupported private body' } },
    },
  };
  const result = mapRaceManualReviewSourceInventory(unsupported);
  expect(result.inventoryState).toBe('blocked');
  expect(result.allCopiedBodiesIndexed).toBe(false);
  expect(result.unindexable).toContainEqual({
    path: 'context.actuals.original',
    reason: 'unsupported_copied_body',
  });
  await expect(
    database.tenant(athlete, async (tx) => {
      const captured = await prepareRaceManualReview(tx, intent(event.id));
      expect(mapRaceManualReviewSourceInventory(captured).approvalAllowed).toBe(false);
      throw new Error('SYNTHETIC_CALLER_ROLLBACK');
    }),
  ).rejects.toThrow('SYNTHETIC_CALLER_ROLLBACK');
  expect(await counts(athlete)).toEqual(before);
});
