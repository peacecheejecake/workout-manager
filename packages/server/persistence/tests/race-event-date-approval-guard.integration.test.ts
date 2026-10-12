import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../src/database.js';
import { migrate } from '../src/migrate.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import {
  installCurrentRuntimeV10,
  verifyCurrentRuntimeV10InstalledIn,
} from '../src/current-runtime-installation-v10.js';
import { grantCurrentRuntimeV10Profile } from '../src/current-runtime-grants-v10.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualPooledPublicRepositoryV2 } from '../src/race-manual-pooled-bundle-v2.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// M202-P1-03. Real PostgreSQL on an installed profile26 (V10) database with V10 runtime
// grants. A race event's localDate changes only inside the 118 atomic approval.
// Synthetic tenants only; no health, credential or provider data.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `race_date_guard_${suffix}`;
const ownerRole = `race_date_guard_owner_${suffix}`;
const runtimeRole = `race_date_guard_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const createdRoles: string[] = [];
let createdDatabase = false;
let db: Database | undefined;
let owner: Pool | undefined;
let pending: Promise<void> = Promise.resolve();
function fixtureIt(label: string, run: () => Promise<void>) {
  it(
    label,
    async () => {
      const work = pending.then(run);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    120000,
  );
}
function connection(role: string) {
  const url = new URL(adminUrl);
  url.pathname = '/' + databaseName;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
function runtime() {
  if (!db) throw Error('DATABASE_NOT_READY');
  return db;
}
function ownerPool() {
  if (!owner) throw Error('OWNER_NOT_READY');
  return owner;
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    createdRoles.push(role);
  }
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  createdDatabase = true;
  await migrate(connection(ownerRole), 107);
  const installed = await installCurrentRuntimeV10(connection(ownerRole));
  expect(installed).toMatchObject({ profileVersion: 10, runtimeStep: 26, sourceDdlTip: 146 });
  await grantCurrentRuntimeAppBaselineV2(connection(ownerRole), runtimeRole, 'core');
  await grantCurrentRuntimeV10Profile(connection(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: connection(ownerRole), max: 2 });
  // Test-only owner SECURITY DEFINER probe, created after the grants: it lets a
  // runtime approval transaction write race_event as the table owner, exactly as
  // 118's apply does, while the genuine approval context of that transaction is open.
  await owner.query(`CREATE SCHEMA guard_probe;
CREATE FUNCTION guard_probe.write_event_v1(tenant text,event uuid,vals jsonb,rev integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $probe$
DECLARE n integer;
BEGIN
  IF tenant IS NOT NULL THEN PERFORM set_config('app.athlete_id',tenant,true); END IF;
  UPDATE public.race_event SET values_json=vals,revision=rev WHERE id=event;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n<>1 THEN RAISE EXCEPTION 'PROBE_ROW_REQUIRED'; END IF;
END $probe$;
REVOKE ALL ON FUNCTION guard_probe.write_event_v1(text,uuid,jsonb,integer) FROM PUBLIC;
GRANT USAGE ON SCHEMA guard_probe TO "${runtimeRole}";
GRANT EXECUTE ON FUNCTION guard_probe.write_event_v1(text,uuid,jsonb,integer) TO "${runtimeRole}";`);
  db = createDatabase({ connectionString: connection(runtimeRole), max: 2 });
}, 240000);
afterAll(async () => {
  await pending;
  await db?.close();
  await owner?.end();
  if (createdDatabase) await dropIsolatedDatabase(admin, databaseName);
  for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 60000);

async function tenant() {
  const athlete = randomUUID();
  await ownerPool().query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  await createConsentRepository(runtime()).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  return athlete;
}
const baseValues = {
  title: 'Synthetic race',
  localDate: '2026-11-08',
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
} as const;
async function race(athlete: string) {
  return createRaceRepository(runtime()).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: { ...baseValues },
  });
}
const headSchema = z.object({
  revision: z.number().int(),
  values_json: z.record(z.string(), z.unknown()),
  deleted: z.boolean(),
});
async function head(athlete: string, id: string) {
  const client = await ownerPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const row = (
      await client.query(
        'SELECT revision,coalesce(values_json,$3::jsonb) AS values_json,deleted FROM public.race_event WHERE athlete_id=$1 AND id=$2',
        [athlete, id, '{}'],
      )
    ).rows[0];
    return headSchema.parse(row);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
const pgError = z.object({ code: z.string(), message: z.string() });
async function refused(work: Promise<unknown>, code: string, message: string) {
  const error: unknown = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  const parsed = pgError.safeParse(error);
  expect(parsed.success, 'expected a PostgreSQL refusal').toBe(true);
  expect(parsed.data?.message).toBe(message);
  expect(parsed.data?.code).toBe(code);
}
async function inSavepoint<T>(tx: Transaction, work: () => Promise<T>) {
  await tx.query('SAVEPOINT guard_probe');
  try {
    return await work();
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT guard_probe');
    await tx.query('RELEASE SAVEPOINT guard_probe');
  }
}
async function probeRefused(
  tx: Transaction,
  args: unknown[],
  message = 'RACE_DATE_APPROVAL_REQUIRED',
) {
  await inSavepoint(tx, () =>
    refused(
      tx.query('SELECT guard_probe.write_event_v1($1,$2::uuid,$3::jsonb,$4)', args),
      '42501',
      message,
    ),
  );
}
async function probeAllowed(tx: Transaction, args: unknown[]) {
  await inSavepoint(tx, async () => {
    await tx.query('SELECT guard_probe.write_event_v1($1,$2::uuid,$3::jsonb,$4)', args);
  });
}

fixtureIt(
  'runtime direct localDate UPDATE is refused 42501 with and without revision+1 and via upsert',
  async () => {
    const athlete = await tenant();
    const event = await race(athlete);
    const db = runtime();
    for (const sql of [
      `UPDATE race_event SET values_json=values_json||'{"localDate":"2026-11-15"}' WHERE athlete_id=$1 AND id=$2`,
      `UPDATE race_event SET values_json=values_json||'{"localDate":"2026-11-15"}',revision=revision+1,updated_at=clock_timestamp() WHERE athlete_id=$1 AND id=$2`,
      `UPDATE race_event SET values_json=values_json||'{"localDate":"2026-11-15","title":"Also renamed"}',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
      `UPDATE race_event SET values_json=values_json-'localDate',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
      `UPDATE race_event SET values_json=values_json||'{"localDate":null}',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
      `INSERT INTO race_event(athlete_id,id,revision,values_json,recorded_at,updated_at)
        SELECT athlete_id,id,revision+1,values_json||'{"localDate":"2026-11-15"}',recorded_at,updated_at FROM race_event WHERE athlete_id=$1 AND id=$2
        ON CONFLICT(athlete_id,id) DO UPDATE SET values_json=EXCLUDED.values_json,revision=EXCLUDED.revision`,
    ])
      await refused(
        db.tenant(athlete, (tx) => tx.query(sql, [athlete, event.id])),
        '42501',
        'RACE_DATE_APPROVAL_REQUIRED',
      );
    expect(await head(athlete, event.id)).toMatchObject({
      revision: event.revision,
      values_json: { localDate: '2026-11-08' },
    });
  },
);
fixtureIt(
  'runtime metadata edits through the races repository and direct metadata-only SQL stay allowed (D1)',
  async () => {
    const athlete = await tenant();
    const event = await race(athlete);
    const races = createRaceRepository(runtime());
    const edited = await races.updateRaceEvent(athlete, event.id, {
      idempotencyKey: randomUUID(),
      expectedRevision: event.revision,
      values: {
        ...baseValues,
        title: 'Renamed race',
        localStartTime: '07:30',
        timezone: 'Asia/Seoul',
        locationName: 'Synthetic park',
        planVersionId: null,
      },
    });
    expect(edited.revision).toBe(event.revision + 1);
    // The HTTP repository still refuses a date edit before SQL (unchanged).
    await expect(
      races.updateRaceEvent(athlete, event.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: edited.revision,
        values: { ...baseValues, localDate: '2026-11-15' },
      }),
    ).rejects.toThrow('RACE_PLAN_IMPACT_REQUIRED');
    // Direct SQL listing values_json: only metadata keys change. planVersionId,
    // localStartTime and timezone are not guarded (D1: localDate only).
    await runtime().tenant(athlete, (tx) =>
      tx.query(
        `UPDATE race_event SET values_json=values_json||jsonb_build_object('title','Direct rename','planVersionId',$3::text,'localStartTime','06:00','timezone','UTC'),revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
        [athlete, event.id, randomUUID()],
      ),
    );
    // Rewriting the same localDate value is not a change.
    await runtime().tenant(athlete, (tx) =>
      tx.query(
        `UPDATE race_event SET values_json=values_json||'{"localDate":"2026-11-08"}',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
        [athlete, event.id],
      ),
    );
    const after = await head(athlete, event.id);
    expect(after.revision).toBe(event.revision + 3);
    expect(after.values_json).toMatchObject({
      title: 'Direct rename',
      localDate: '2026-11-08',
      localStartTime: '06:00',
      timezone: 'UTC',
      locationName: 'Synthetic park',
    });
  },
);
fixtureIt('the table owner without an approval context is refused 42501', async () => {
  const athlete = await tenant();
  const event = await race(athlete);
  const client: PoolClient = await ownerPool().connect();
  try {
    for (const sql of [
      `UPDATE public.race_event SET values_json=values_json||'{"localDate":"2026-11-15"}',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
      `UPDATE public.race_event SET values_json=values_json||'{"localDate":"2026-11-15"}' WHERE athlete_id=$1 AND id=$2`,
    ]) {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
        await refused(
          client.query(sql, [athlete, event.id]),
          '42501',
          'RACE_DATE_APPROVAL_REQUIRED',
        );
      } finally {
        await client.query('ROLLBACK');
      }
    }
  } finally {
    client.release();
  }
  expect((await head(athlete, event.id)).values_json).toMatchObject({ localDate: '2026-11-08' });
});
fixtureIt(
  'an identity change together with a date change keeps the identity guard first',
  async () => {
    const athlete = await tenant();
    const event = await race(athlete);
    await refused(
      runtime().tenant(athlete, (tx) =>
        tx.query(
          `UPDATE race_event SET id=gen_random_uuid(),values_json=values_json||'{"localDate":"2026-11-15"}',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
          [athlete, event.id],
        ),
      ),
      'P0001',
      'RACE_IDENTITY_IMMUTABLE',
    );
  },
);
fixtureIt(
  'the normal 118 approval changes the date end to end; owner writes inside it change only localDate/planVersionId of the context event',
  async () => {
    const athlete = await tenant();
    const other = await tenant();
    const event = await race(athlete);
    const sibling = await race(athlete);
    const foreign = await race(other);
    const newDate = '2026-11-15';
    const probes: string[] = [];
    const base = runtime();
    const wrap = (tx: Transaction): Transaction => ({
      athleteId: tx.athleteId,
      async query(sql, values) {
        if (sql.includes('public.apply_race_manual_event_v1(')) {
          const before = await head(athlete, event.id);
          const old = before.values_json;
          const rev = before.revision;
          // Positive controls: exactly what 118 writes, and 118's planVersionId rewrite.
          await probeAllowed(tx, [null, event.id, { ...old, localDate: newDate }, rev + 1]);
          await probeAllowed(tx, [
            null,
            event.id,
            { ...old, localDate: newDate, planVersionId: randomUUID() },
            rev + 1,
          ]);
          probes.push('allowed');
          // Hardening: any other key smuggled into the approval.
          await probeRefused(tx, [
            null,
            event.id,
            { ...old, localDate: newDate, title: 'Smuggled' },
            rev + 1,
          ]);
          await probeRefused(tx, [
            null,
            event.id,
            { ...old, localDate: newDate, localStartTime: '05:00' },
            rev + 1,
          ]);
          // Another date than the candidate's newLocalDate.
          await probeRefused(tx, [null, event.id, { ...old, localDate: '2026-12-31' }, rev + 1]);
          // Revision not exactly +1.
          await probeRefused(tx, [null, event.id, { ...old, localDate: newDate }, rev]);
          await probeRefused(tx, [null, event.id, { ...old, localDate: newDate }, rev + 2]);
          // A different event of the same tenant.
          await probeRefused(tx, [
            null,
            sibling.id,
            { ...baseValues, localDate: newDate },
            sibling.revision + 1,
          ]);
          // A stale expected revision: a metadata bump first, then the date change.
          await inSavepoint(tx, async () => {
            await tx.query('SELECT guard_probe.write_event_v1($1,$2::uuid,$3::jsonb,$4)', [
              null,
              event.id,
              { ...old, title: 'Bumped' },
              rev + 1,
            ]);
            await refused(
              tx.query('SELECT guard_probe.write_event_v1($1,$2::uuid,$3::jsonb,$4)', [
                null,
                event.id,
                { ...old, title: 'Bumped', localDate: newDate },
                rev + 2,
              ]),
              '42501',
              'RACE_DATE_APPROVAL_REQUIRED',
            );
          });
          // Another tenant's event, even with that tenant's context setting.
          await probeRefused(tx, [
            other,
            foreign.id,
            { ...baseValues, localDate: newDate },
            foreign.revision + 1,
          ]);
          probes.push('refused');
        }
        return tx.query(sql, values);
      },
    });
    const probing: Database = {
      tenant: (id, operation) => base.tenant(id, (tx) => operation(wrap(tx))),
      exclusiveTenant: (id, operation) => base.exclusiveTenant(id, (tx) => operation(wrap(tx))),
      close: () => base.close(),
    };
    const snapshot = base.snapshotTenant?.bind(base);
    if (snapshot)
      probing.snapshotTenant = (id, operation) => snapshot(id, (tx) => operation(wrap(tx)));
    const catalog = base.snapshotCatalog?.bind(base);
    if (catalog) probing.snapshotCatalog = catalog;
    const repo = createRaceManualPooledPublicRepositoryV2(probing);
    const reviewed = await repo.review(athlete, {
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      intent: {
        expectedEvent: { id: event.id, revision: event.revision },
        newLocalDate: newDate,
        selection: { kind: 'keep_plan' },
      },
    });
    if (reviewed.status !== 'reviewed') throw Error('REVIEW_REQUIRED');
    const committed = await repo.approve(athlete, {
      schemaVersion: 1,
      candidateId: reviewed.reference.candidateId,
      applicationDigest: reviewed.reference.applicationDigest,
      confirmed: true,
      idempotencyKey: randomUUID(),
    });
    expect(committed.status).toBe('committed');
    expect(probes).toEqual(['allowed', 'refused']);
    const after = await head(athlete, event.id);
    expect(after.revision).toBe(event.revision + 1);
    expect(after.values_json).toEqual({ ...baseValues, localDate: newDate });
    expect(await createRaceRepository(runtime()).getRaceEvent(athlete, event.id)).toMatchObject({
      id: event.id,
      revision: event.revision + 1,
      localDate: newDate,
    });
    // Untouched neighbours.
    expect(await head(athlete, sibling.id)).toMatchObject({
      revision: sibling.revision,
      values_json: { localDate: '2026-11-08' },
    });
    expect(await head(other, foreign.id)).toMatchObject({
      revision: foreign.revision,
      values_json: { localDate: '2026-11-08' },
    });
    // After the approval transaction the runtime still cannot move the date back.
    await refused(
      runtime().tenant(athlete, (tx) =>
        tx.query(
          `UPDATE race_event SET values_json=values_json||'{"localDate":"2026-11-08"}',revision=revision+1 WHERE athlete_id=$1 AND id=$2`,
          [athlete, event.id],
        ),
      ),
      '42501',
      'RACE_DATE_APPROVAL_REQUIRED',
    );
  },
);
fixtureIt('delete_race_entity purge through the races repository still works', async () => {
  const athlete = await tenant();
  const event = await race(athlete);
  const deleted = await createRaceRepository(runtime()).deleteRaceEvent(athlete, event.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: event.revision,
  });
  expect(deleted).toEqual({ id: event.id, revision: event.revision + 1 });
  expect(await head(athlete, event.id)).toMatchObject({ deleted: true, values_json: {} });
  expect(await createRaceRepository(runtime()).getRaceEvent(athlete, event.id)).toBeNull();
});
fixtureIt('a disabled or dropped guard trigger is detected by verifyV10 as drift', async () => {
  for (const sql of [
    'ALTER TABLE public.race_event DISABLE TRIGGER race_local_date_approval_guard',
    'DROP TRIGGER race_local_date_approval_guard ON public.race_event',
  ]) {
    const client = await ownerPool().connect();
    try {
      await client.query('BEGIN');
      await verifyCurrentRuntimeV10InstalledIn(client);
      await client.query(sql);
      await expect(verifyCurrentRuntimeV10InstalledIn(client)).rejects.toThrow(
        'CURRENT_RUNTIME_V10_FUNCTION_DRIFT',
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  // The rolled-back drift left the committed installation intact.
  const client = await ownerPool().connect();
  try {
    await client.query('BEGIN');
    await verifyCurrentRuntimeV10InstalledIn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
