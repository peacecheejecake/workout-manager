import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityImport } from '@workout/contracts/activity';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createOperationsRepository } from '@workout/server-persistence/operations';
import {
  createGarminUnofficialStore,
  GARMIN_UNOFFICIAL_LOGIN_ATTEMPTS,
} from '@workout/server-persistence/garmin-unofficial';
import {
  grantGarmin,
  grantGarminUnofficial,
  grantOperations,
  migrate,
} from '@workout/server-persistence/migrate';
import { createGarminCipher } from '@workout/server-identity/garmin-crypto';
import {
  runGarminCollection,
  type GarminActivityCollector,
  type GarminCollectionRequest,
  type GarminCollectionResult,
} from '@workout/server-integrations/garmin-collection';
import {
  createGarminProfilePin,
  createGarminUnofficialService,
} from '@workout/server-integrations/garmin-unofficial-service';
import type { GarminLoginStep } from '@workout/server-integrations/garmin-unofficial-worker';
import { unofficialSessionCipher } from '../src/garmin-unofficial-deployment.js';

/**
 * The temporary unofficial collector (M1-06b-tmp) against real PostgreSQL: session storage,
 * pinning, lease/CAS, the import path and deletion suppression, the provider-neutral ledger,
 * failure policy, erasure and export. The provider is a scripted collector; the Python worker
 * itself is tested in packages/server/integrations/tests/garmin-unofficial-worker.test.ts.
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
const keys = { k1: Buffer.alloc(32, 5).toString('base64') };
const cipher = unofficialSessionCipher({ activeKeyId: 'k1', keys });
const pinKey = Buffer.alloc(32, 21);
const garminProfileHash = createGarminProfilePin(pinKey);
let raw: Database;
let openTransactions = 0;
/** Counts open tenant transactions, so a test can prove no provider call happens inside one. */
const database: Database = {
  async tenant(athleteId, operation) {
    openTransactions += 1;
    try {
      return await raw.tenant(athleteId, operation);
    } finally {
      openTransactions -= 1;
    }
  },
  async exclusiveTenant(athleteId, operation) {
    openTransactions += 1;
    try {
      return await raw.exclusiveTenant(athleteId, operation);
    } finally {
      openTransactions -= 1;
    }
  },
  close: () => raw.close(),
};
const store = createGarminUnofficialStore(database);
const activities = createActivityRepository(database);

beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantGarmin(adminUrl, 'workout_runtime');
  await grantGarminUnofficial(adminUrl, 'workout_runtime');
  await admin.query(
    'GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,activity_import_receipt,outbox,command_receipt,plan_snapshot,plan_head,plan_history TO workout_runtime',
  );
  raw = createDatabase({ connectionString: runtimeUrl, max: 8 });
});
afterAll(async () => {
  await raw?.close();
  await admin.end();
});

const SESSION = '{"di_token":"di-secret-access-0001","di_refresh_token":"di-secret-refresh-0001"}';
function fitCommand(seed: string, startedAt = '2026-09-20T06:00:00+00:00'): ActivityImport {
  const hash = createHash('sha256').update(seed).digest('hex');
  return {
    idempotencyKey: `fit-${hash}-0`,
    source: { kind: 'fit', sourceId: `sha256:${hash}:session:0`, revision: 1, contentHash: hash },
    activity: {
      title: null,
      kind: 'running',
      startedAt,
      timezone: null,
      durationSeconds: 1800,
      durationKind: 'timer',
      distanceMeters: 5000,
    },
  };
}
function scriptedWorker(steps: GarminLoginStep[]) {
  return {
    login: async () => {
      const step = steps.shift();
      if (!step) throw new Error('NO_STEP');
      return step;
    },
    collector: undefined as unknown as GarminActivityCollector,
  };
}
async function connect(athleteId: string, profileId = '1001', session = SESSION) {
  const service = createGarminUnofficialService({
    ownerAthleteId: athleteId,
    store,
    worker: scriptedWorker([{ kind: 'connected', profileId, session }]),
    cipher,
    profilePin: garminProfileHash,
    activities,
  });
  return service.login(athleteId, 'session-1', {
    email: 'owner@example.test',
    password: 'synthetic-pass-1',
  });
}
async function connectionRow(athleteId: string) {
  return (
    await admin.query('SELECT * FROM garmin_unofficial_connection WHERE athlete_id=$1', [athleteId])
  ).rows[0] as Record<string, unknown> | undefined;
}
async function revocations() {
  return Number(
    (await admin.query('SELECT count(*)::int AS n FROM garmin_private.revocation')).rows[0]?.n,
  );
}

/** A provider stand-in: lists `listed`, delivers `commands[id]`, then returns `result`. */
function collector(
  listed: string[],
  commands: Record<string, ActivityImport[]>,
  result: (
    request: GarminCollectionRequest,
  ) => GarminCollectionResult | Promise<GarminCollectionResult> = () => ({
    kind: 'finished',
    complete: true,
    credential: '{"di_token":"di-secret-access-0002","di_refresh_token":"r2"}',
  }),
) {
  const downloaded: string[] = [];
  const providerCallsInsideTransactions: number[] = [];
  const provider = () => providerCallsInsideTransactions.push(openTransactions);
  const value: GarminActivityCollector = {
    provider: 'garmin-connect-unofficial',
    official: false,
    async collect(request) {
      provider(); // open + profile
      if (!request.verifyAccount('1001')) return { kind: 'account_mismatch' };
      provider(); // listing
      const wanted = await request.select(
        listed.map((id) => ({ id, startedAtLocal: '2026-09-20 15:00:00' })),
      );
      for (const id of wanted) {
        provider(); // download
        downloaded.push(id);
        await request.accept({ id, imports: commands[id] ?? [] });
      }
      return result(request);
    },
  };
  return { value, downloaded, providerCallsInsideTransactions };
}
async function run(athleteId: string, value: GarminActivityCollector) {
  return runGarminCollection(
    { store, collector: value, cipher, activities, accountHash: garminProfileHash },
    athleteId,
  );
}

describe('session storage and pinning', () => {
  it('stores only a sealed session under its own purpose, and nothing for revocation', async () => {
    const athlete = randomUUID();
    const before = await revocations();
    expect(await connect(athlete)).toEqual({ state: 'connected' });
    const row = await connectionRow(athlete);
    expect(row?.['state']).toBe('connected');
    const envelope = row?.['encrypted_session'] as { ciphertext: string };
    // Neither the row nor the decoded ciphertext carries the session in the clear.
    expect(JSON.stringify(row)).not.toContain('di-secret');
    expect(Buffer.from(envelope.ciphertext, 'base64').toString('latin1')).not.toContain(
      'di-secret',
    );
    expect(cipher.open(athlete, row?.['encrypted_session'] as never)).toBe(SESSION);
    const official = createGarminCipher({ activeKeyId: 'k1', keys });
    expect(() =>
      official.decrypt(athlete, 'tokens', row?.['encrypted_session'] as never),
    ).toThrow();
    expect(row?.['profile_hash']).toBe(garminProfileHash('1001'));
    expect(await revocations()).toBe(before);
    expect(
      (await admin.query('SELECT 1 FROM garmin_connection WHERE athlete_id=$1', [athlete]))
        .rowCount,
    ).toBe(0);
  });

  it('disconnect deletes the session, keeps the pin and queues nothing', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    const before = await revocations();
    await store.disconnect(athlete);
    const row = await connectionRow(athlete);
    expect(row).toMatchObject({ state: 'not_connected', encrypted_session: null });
    expect(row?.['profile_hash']).toBe(garminProfileHash('1001'));
    expect(await revocations()).toBe(before);
  });

  it('refuses a different Garmin profile and stores nothing from it', async () => {
    const athlete = randomUUID();
    await connect(athlete, '1001');
    await store.disconnect(athlete);
    await expect(connect(athlete, '2002', '{"di_token":"di-other-profile"}')).rejects.toThrow(
      'GARMIN_UNOFFICIAL_PROFILE_MISMATCH',
    );
    const row = await connectionRow(athlete);
    expect(row).toMatchObject({ state: 'not_connected', encrypted_session: null });
    expect(JSON.stringify(row)).not.toContain('di-other');
  });

  it('persists the password nowhere: not in the session the scheduled runs consume, not in any row', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    // The session exactly as login stored it, before any run could replace it.
    const first = cipher.open(
      athlete,
      (await connectionRow(athlete))?.['encrypted_session'] as never,
    );
    await store.requestRun(athlete, new Date());
    await run(athlete, collector(['9001'], { '9001': [fitCommand(`${athlete}-pw`)] }).value);
    const row = await connectionRow(athlete);
    const stored = cipher.open(athlete, row?.['encrypted_session'] as never);
    const rows = await Promise.all(
      [
        'garmin_unofficial_connection',
        'garmin_unofficial_run',
        'garmin_activity_ledger',
        'outbox',
        'activity_source_revision',
      ].map(async (table) =>
        JSON.stringify(
          (
            await admin.query(
              table === 'outbox'
                ? 'SELECT * FROM outbox'
                : `SELECT * FROM ${table} WHERE athlete_id=$1`,
              table === 'outbox' ? [] : [athlete],
            )
          ).rows,
        ),
      ),
    );
    for (const text of [first, stored, ...rows]) {
      expect(text).not.toContain('synthetic-pass-1');
      expect(text).not.toContain('owner@example.test');
    }
  });

  it('bounds login attempts per window and backs off after failures', async () => {
    const athlete = randomUUID();
    const now = new Date('2026-09-25T00:00:00Z');
    for (let index = 0; index < GARMIN_UNOFFICIAL_LOGIN_ATTEMPTS; index++)
      expect(await store.beginLogin(athlete, now)).toEqual({ allowed: true });
    expect(await store.beginLogin(athlete, now)).toMatchObject({ allowed: false });
    const other = randomUUID();
    const first = await store.recordLoginFailure(other, now);
    const second = await store.recordLoginFailure(other, now);
    expect(first?.getTime()).toBe(now.getTime() + 60_000);
    expect(second?.getTime()).toBe(now.getTime() + 120_000);
    expect(await store.beginLogin(other, now)).toMatchObject({ allowed: false });
    expect(await store.beginLogin(other, new Date(now.getTime() + 121_000))).toEqual({
      allowed: true,
    });
  });
});

describe('collection runs', () => {
  it('imports through the import path, records provenance, stores the refreshed session by CAS, and never calls the provider inside a transaction', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.requestRun(athlete, new Date());
    const first = collector(['9001', '9002'], {
      '9001': [fitCommand(`${athlete}-9001`)],
      '9002': [fitCommand(`${athlete}-9002`, '2026-09-21T06:00:00+00:00')],
    });
    expect(await run(athlete, first.value)).toBe('succeeded');
    expect(first.downloaded).toEqual(['9001', '9002']);
    expect(first.providerCallsInsideTransactions.every((open) => open === 0)).toBe(true);
    const list = await activities.listActivities(athlete);
    expect(list.total).toBe(2);
    expect(await store.provenance(athlete, list.items[0]?.id ?? '')).toMatchObject({
      provider: 'garmin-connect-unofficial',
      official: false,
    });
    const row = await connectionRow(athlete);
    expect(cipher.open(athlete, row?.['encrypted_session'] as never)).toContain('0002');
    const lastRun = (
      await admin.query('SELECT * FROM garmin_unofficial_run WHERE athlete_id=$1', [athlete])
    ).rows[0];
    expect(lastRun).toMatchObject({
      state: 'succeeded',
      listed: 2,
      imported: 2,
      trigger: 'manual',
    });

    // A second run lists the same activities and downloads none of them.
    await store.requestRun(athlete, new Date());
    const second = collector(['9001', '9002'], {});
    expect(await run(athlete, second.value)).toBe('succeeded');
    expect(second.downloaded).toEqual([]);
  });

  it('never re-imports a deleted activity: not after the collector brought it, not after a manual import', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    // Collected, then deleted by the user: the next run does not download it again.
    await store.requestRun(athlete, new Date());
    const command = fitCommand(`${athlete}-collected`);
    await run(athlete, collector(['9001'], { '9001': [command] }).value);
    const collected = (await activities.listActivities(athlete)).items[0];
    await activities.deleteActivity(athlete, collected?.id ?? '', { expectedRevision: 1 });
    await store.requestRun(athlete, new Date());
    const again = collector(['9001'], { '9001': [command] });
    await run(athlete, again.value);
    expect(again.downloaded).toEqual([]);
    // Imported by hand and deleted before any collector saw it: the collector's import of the
    // same FIT is suppressed by the existing path, and nothing reappears.
    const manual = fitCommand(`${athlete}-manual`);
    const imported = await activities.importActivity(athlete, manual);
    await activities.deleteActivity(athlete, imported.activityId, { expectedRevision: 1 });
    await store.requestRun(athlete, new Date());
    const suppressed = collector(['9003'], { '9003': [manual] });
    expect(await run(athlete, suppressed.value)).toBe('succeeded');
    expect(suppressed.downloaded).toEqual(['9003']);
    expect((await activities.listActivities(athlete)).total).toBe(0);
    const runRow = (
      await admin.query(
        'SELECT suppressed FROM garmin_unofficial_run WHERE athlete_id=$1 ORDER BY started_at DESC LIMIT 1',
        [athlete],
      )
    ).rows[0];
    expect(runRow?.['suppressed']).toBe(1);
  });

  it('skips activities an official adapter already collected (provider-neutral ledger)', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.recordCollected({
      athleteId: athlete,
      garminActivityId: '7777',
      provider: 'garmin-official',
      outcome: 'imported',
      sources: [],
      now: new Date(),
    });
    await store.requestRun(athlete, new Date());
    const value = collector(['7777', '7778'], { '7778': [fitCommand(`${athlete}-7778`)] });
    await run(athlete, value.value);
    expect(value.downloaded).toEqual(['7778']);
  });

  it('refuses a stored session that opens a different Garmin profile than the pinned one', async () => {
    const athlete = randomUUID();
    await connect(athlete, '1001');
    await store.requestRun(athlete, new Date());
    const downloaded: string[] = [];
    const impostor: GarminActivityCollector = {
      provider: 'garmin-connect-unofficial',
      official: false,
      async collect(request) {
        if (!request.verifyAccount('2002')) return { kind: 'account_mismatch' };
        const wanted = await request.select([
          { id: '9001', startedAtLocal: '2026-09-20 15:00:00' },
        ]);
        downloaded.push(...wanted);
        return { kind: 'finished', complete: true, credential: null };
      },
    };
    expect(await run(athlete, impostor)).toBe('reconnect_required');
    expect(downloaded).toEqual([]);
    expect(await connectionRow(athlete)).toMatchObject({
      state: 'reconnect_required',
      encrypted_session: null,
    });
  });

  it('runs one collection per connection at a time', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.requestRun(athlete, new Date());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = collector([], {}, async () => {
      await gate;
      return { kind: 'finished', complete: true, credential: null };
    });
    const firstRun = run(athlete, slow.value);
    await expect.poll(async () => (await connectionRow(athlete))?.['lease_id']).not.toBeNull();
    expect(await store.requestRun(athlete, new Date())).toBe('running');
    await store.setSchedule(athlete, true, new Date());
    expect(await run(athlete, collector([], {}).value)).toBeNull();
    release();
    expect(await firstRun).toBe('succeeded');
  });

  it('honours Retry-After on 429, pauses the schedule and refuses a manual run until then', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.setSchedule(athlete, true, new Date());
    const limited = collector([], {}, () => ({
      kind: 'failed',
      failure: { kind: 'rate_limited', retryAfterSeconds: 7200 },
      credential: null,
    }));
    const started = Date.now();
    expect(await run(athlete, limited.value)).toBe('rate_limited');
    const row = await connectionRow(athlete);
    expect(row?.['schedule_paused']).toBe(true);
    expect((row?.['blocked_until'] as Date).getTime()).toBeGreaterThanOrEqual(started + 7_200_000);
    expect(await store.requestRun(athlete, new Date())).toBe('blocked');
    expect(await run(athlete, collector([], {}).value)).toBeNull();
  });

  it('moves to reconnect-required on an auth failure, drops the session and does not retry', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.setSchedule(athlete, true, new Date());
    const rejected = collector([], {}, () => ({
      kind: 'failed',
      failure: { kind: 'auth' },
      credential: null,
    }));
    expect(await run(athlete, rejected.value)).toBe('reconnect_required');
    expect(await connectionRow(athlete)).toMatchObject({
      state: 'reconnect_required',
      encrypted_session: null,
    });
    expect(await run(athlete, collector([], {}).value)).toBeNull();
    expect(await store.requestRun(athlete, new Date())).toBe('not_connected');
  });

  it('backs off after a transient failure and pauses the schedule after a permanent one', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.setSchedule(athlete, true, new Date());
    const transient = collector([], {}, () => ({
      kind: 'failed',
      failure: { kind: 'transient', code: 'PROVIDER_UNAVAILABLE' },
      credential: null,
    }));
    expect(await run(athlete, transient.value)).toBe('failed_transient');
    const row = await connectionRow(athlete);
    expect(row?.['blocked_until']).not.toBeNull();
    expect(row?.['schedule_paused']).toBe(false);
    await admin.query(
      'UPDATE garmin_unofficial_connection SET blocked_until=NULL,next_scheduled_at=NULL WHERE athlete_id=$1',
      [athlete],
    );
    const permanent = collector([], {}, () => ({
      kind: 'failed',
      failure: { kind: 'permanent', code: 'POLICY_REFUSED' },
      credential: null,
    }));
    expect(await run(athlete, permanent.value)).toBe('failed_permanent');
    expect((await connectionRow(athlete))?.['schedule_paused']).toBe(true);
  });

  it('a disconnect during a run cancels it and the refreshed session is not stored', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.requestRun(athlete, new Date());
    const racing = collector(['9001'], { '9001': [fitCommand(`${athlete}-race`)] }, async () => {
      await store.disconnect(athlete);
      return { kind: 'finished', complete: true, credential: '{"di_token":"di-secret-after"}' };
    });
    expect(await run(athlete, racing.value)).toBe('cancelled');
    const row = await connectionRow(athlete);
    expect(row).toMatchObject({ state: 'not_connected', encrypted_session: null, lease_id: null });
    expect(
      (await admin.query('SELECT state FROM garmin_unofficial_run WHERE athlete_id=$1', [athlete]))
        .rows[0]?.['state'],
    ).toBe('cancelled');
  });
});

describe('hardening (review r1)', () => {
  it('pins the profile as a keyed HMAC, not a reversible digest of the id', async () => {
    const athlete = randomUUID();
    await connect(athlete, '1001');
    const stored = (await connectionRow(athlete))?.['profile_hash'];
    expect(stored).toBe(
      createHmac('sha256', pinKey).update('garmin-connect-profile:1001').digest('hex'),
    );
    // The unkeyed digest of the small id (what anyone could enumerate) is not what is stored.
    expect(stored).not.toBe(
      createHash('sha256').update('garmin-connect-profile:1001').digest('hex'),
    );
    expect(stored).not.toBe(createHash('sha256').update('1001').digest('hex'));
    expect(createGarminProfilePin(Buffer.alloc(32, 22))('1001')).not.toBe(stored);
  });

  async function leased(athlete: string) {
    await store.requestRun(athlete, new Date());
    const leaseId = randomUUID();
    const lease = await store.acquireRun({
      athleteId: athlete,
      runId: randomUUID(),
      leaseId,
      now: new Date(),
    });
    if (lease === null) throw new Error('EXPECTED_LEASE');
    return { leaseId, lease };
  }
  const sealed = (athlete: string, marker: string) =>
    cipher.seal(athlete, `{"di_token":"${marker}"}`);
  const storedSession = async (athlete: string) =>
    cipher.open(athlete, (await connectionRow(athlete))?.['encrypted_session'] as never);

  it('session write-back CAS: a stale generation loses and the newer session stays', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    const { leaseId, lease } = await leased(athlete);
    const first = { athleteId: athlete, leaseId, now: new Date() };
    expect(
      await store.commitSession({
        ...first,
        sessionGeneration: lease.sessionGeneration,
        encryptedSession: sealed(athlete, 'newer'),
      }),
    ).toBe(true);
    expect(
      await store.commitSession({
        ...first,
        sessionGeneration: lease.sessionGeneration,
        encryptedSession: sealed(athlete, 'stale'),
      }),
    ).toBe(false);
    expect(await storedSession(athlete)).toBe('{"di_token":"newer"}');
  });

  it('session write-back CAS: a stale lease id loses', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    const { lease } = await leased(athlete);
    expect(
      await store.commitSession({
        athleteId: athlete,
        leaseId: randomUUID(),
        sessionGeneration: lease.sessionGeneration,
        encryptedSession: sealed(athlete, 'intruder'),
        now: new Date(),
      }),
    ).toBe(false);
    expect(await storedSession(athlete)).toBe(SESSION);
  });

  it('session write-back CAS: after a disconnect and a new login the old run cannot write', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    const { leaseId, lease } = await leased(athlete);
    await store.disconnect(athlete);
    await connect(athlete, '1001', '{"di_token":"relogin"}');
    expect(
      await store.commitSession({
        athleteId: athlete,
        leaseId,
        sessionGeneration: lease.sessionGeneration,
        encryptedSession: sealed(athlete, 'from-old-run'),
        now: new Date(),
      }),
    ).toBe(false);
    expect(await storedSession(athlete)).toBe('{"di_token":"relogin"}');
  });

  it('an unreadable session (lost or unknown key) ends in reconnect-required, not endless retries', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.setSchedule(athlete, true, new Date());
    await admin.query(
      "UPDATE garmin_unofficial_connection SET encrypted_session=jsonb_set(encrypted_session,'{keyId}','\"lost-key\"') WHERE athlete_id=$1",
      [athlete],
    );
    const events: { event: string; code?: string }[] = [];
    const untouched = collector(['9001'], { '9001': [fitCommand(`${athlete}-lost`)] });
    const state = await runGarminCollection(
      {
        store,
        collector: untouched.value,
        cipher,
        activities,
        accountHash: garminProfileHash,
        onEvent: (event) => events.push(event),
      },
      athlete,
    );
    expect(state).toBe('reconnect_required');
    expect(untouched.downloaded).toEqual([]);
    expect(events).toContainEqual({
      event: 'garmin_collection_failed',
      code: 'CREDENTIAL_UNREADABLE',
    });
    expect(await connectionRow(athlete)).toMatchObject({
      state: 'reconnect_required',
      encrypted_session: null,
    });
    expect(await run(athlete, collector([], {}).value)).toBeNull();
  });
});

describe('erasure and export', () => {
  it('erasure removes the session, pin, runs and ledger and queues nothing', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.requestRun(athlete, new Date());
    await run(athlete, collector(['9001'], { '9001': [fitCommand(`${athlete}-erase`)] }).value);
    const before = await revocations();
    await createOperationsRepository(database).eraseAccount(athlete);
    for (const table of [
      'garmin_unofficial_connection',
      'garmin_unofficial_run',
      'garmin_activity_ledger',
      'garmin_activity_ledger_source',
    ])
      expect(
        (await admin.query(`SELECT 1 FROM ${table} WHERE athlete_id=$1`, [athlete])).rowCount,
        table,
      ).toBe(0);
    expect(await revocations()).toBe(before);
  });

  it('export contains neither the session nor its envelope', async () => {
    const athlete = randomUUID();
    await connect(athlete);
    await store.requestRun(athlete, new Date());
    await run(athlete, collector(['9001'], { '9001': [fitCommand(`${athlete}-export`)] }).value);
    const envelope = (await connectionRow(athlete))?.['encrypted_session'] as {
      ciphertext: string;
    };
    const exported = JSON.stringify(
      await createOperationsRepository(database).exportAccount(athlete),
    );
    expect(exported).not.toContain('di-secret');
    expect(exported).not.toContain(envelope.ciphertext);
    expect(exported).not.toContain('encrypted_session');
    expect(exported).toContain('sha256:');
  });
});
