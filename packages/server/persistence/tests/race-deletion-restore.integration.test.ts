import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  RaceEventValues,
  RaceResultValues,
  TrainingBestValues,
} from '@workout/contracts/race-commands';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { grantOperations, grantRaces, migrate } from '../src/migrate.js';
import {
  coordinateSuppressionExport,
  decodeSuppressionHead,
  encodeSuppressionHead,
  type SuppressionHead,
  type SuppressionRemoteStore,
  type VersionedObject,
} from '../src/restore-suppression-coordinator.js';
import { decryptReplaySegment } from '../src/restore-suppression-segment.js';
import {
  replayVerifiedSuppressionChain,
  type TrustedReplayAnchor,
} from '../src/restore-suppression-replay.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const pgBin = z.string().min(1).parse(process.env['PG_BIN']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const sourceName = `race_archive_source_${suffix}`;
const restoredName = `race_archive_restore_${suffix}`;
const sourceOwnerRole = `race_archive_owner_${suffix}`;
const restoredOwnerRole = `race_restore_owner_${suffix}`;
const runtimeRole = `race_archive_app_${suffix}`;
const slotName = `wm_suppression_race_${suffix}`;
const encryptionKey = Buffer.alloc(32, 47);
const headAuthenticationKey = Buffer.alloc(32, 89);
const encryptionKeyId = 'synthetic-race-archive-key';
const families = ['race-event', 'race-result', 'training-best'] as const;
type Family = (typeof families)[number];
let directory: string;
let sourceOwner: Pool, sourceAdmin: Pool, restoredOwner: Pool, restoredRuntime: Pool;
let sourceDatabase: Database, restoredDatabase: Database;
let sourceRaces: RaceRepository, restoredRaces: RaceRepository;
let mainAthlete: string, overlapAthlete: string, erasedAthlete: string, otherAthlete: string;
let mainEntities: Entity[],
  overlapEntities: Entity[],
  erasedEntities: Entity[],
  otherEntities: Entity[],
  gapEntities: Entity[];
let protectedBefore: unknown;
let archiveDigest: string;
let store: FileVersionedStore;
let clusterId: string;
let initialLsn: string;
let finalHead: SuppressionHead;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function urlFor(databaseName: string, role: string) {
  const endpoint = new URL(adminUrl);
  endpoint.pathname = `/${databaseName}`;
  endpoint.username = role;
  endpoint.password = 'isolated';
  return endpoint.toString();
}
async function tenant<T>(
  pool: Pool,
  athlete: string,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function account(): Promise<string> {
  const athlete = randomUUID();
  await sourceOwner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  return athlete;
}
function pg(program: string, args: string[]) {
  const result = spawnSync(join(pgBin, program), args, { encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`ISOLATED_${program.toUpperCase()}_FAILED: ${result.stderr.slice(0, 1500)}`);
}
function eventValues(): RaceEventValues {
  return {
    title: 'Synthetic event',
    localDate: '2026-10-04',
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
  };
}
function resultValues(): RaceResultValues {
  return {
    kind: 'race-result',
    raceEventId: null,
    localDate: '2026-10-04',
    timezone: 'Asia/Seoul',
    source: { kind: 'manual' },
    chipSeconds: 0,
    gunSeconds: null,
    officialDistanceMeters: null,
    deviceDistanceMeters: 10042,
    linkedActivityId: null,
    weatherNote: 'Synthetic independent result',
  };
}
function bestValues(): TrainingBestValues {
  return {
    kind: 'training-best',
    observedAt: '2026-10-03T08:00:00+09:00',
    source: { kind: 'manual' },
    basis: 'user-entered',
    distanceMeters: null,
    elapsedSeconds: 0,
  };
}
type Entity = {
  kind: Family;
  id: string;
  original: unknown;
  corrected: unknown;
  retained: unknown;
  replayCreate: (repository: RaceRepository) => Promise<unknown>;
  replayUpdate: (repository: RaceRepository) => Promise<unknown>;
};
async function entity(athlete: string, kind: Family): Promise<Entity> {
  const createKey = randomUUID(),
    updateKey = randomUUID();
  switch (kind) {
    case 'race-event': {
      const input = { idempotencyKey: createKey, values: eventValues() };
      const original = await sourceRaces.createRaceEvent(athlete, input);
      const update = {
        idempotencyKey: updateKey,
        expectedRevision: 1,
        values: { ...eventValues(), title: 'Synthetic corrected event' },
      };
      const corrected = await sourceRaces.updateRaceEvent(athlete, original.id, update);
      const retained = await sourceRaces.getRaceEvent(athlete, original.id);
      return {
        kind,
        id: original.id,
        original,
        corrected,
        retained,
        replayCreate: (repo) => repo.createRaceEvent(athlete, input),
        replayUpdate: (repo) => repo.updateRaceEvent(athlete, original.id, update),
      };
    }
    case 'race-result': {
      const input = { idempotencyKey: createKey, values: resultValues() };
      const original = await sourceRaces.createRaceResult(athlete, input);
      const update = {
        idempotencyKey: updateKey,
        expectedRevision: 1,
        values: { ...resultValues(), weatherNote: 'Synthetic corrected result' },
      };
      const corrected = await sourceRaces.updateRaceResult(athlete, original.id, update);
      const retained = await sourceRaces.getRaceResult(athlete, original.id);
      return {
        kind,
        id: original.id,
        original,
        corrected,
        retained,
        replayCreate: (repo) => repo.createRaceResult(athlete, input),
        replayUpdate: (repo) => repo.updateRaceResult(athlete, original.id, update),
      };
    }
    case 'training-best': {
      const input = { idempotencyKey: createKey, values: bestValues() };
      const original = await sourceRaces.createTrainingBest(athlete, input);
      const update = {
        idempotencyKey: updateKey,
        expectedRevision: 1,
        values: { ...bestValues(), elapsedSeconds: 2400 },
      };
      const corrected = await sourceRaces.updateTrainingBest(athlete, original.id, update);
      const retained = await sourceRaces.getTrainingBest(athlete, original.id);
      return {
        kind,
        id: original.id,
        original,
        corrected,
        retained,
        replayCreate: (repo) => repo.createTrainingBest(athlete, input),
        replayUpdate: (repo) => repo.updateTrainingBest(athlete, original.id, update),
      };
    }
  }
}
async function entities(athlete: string) {
  const entries = [];
  for (const kind of families) entries.push(await entity(athlete, kind));
  return entries;
}
function remove(athlete: string, value: Entity) {
  const command = { expectedRevision: 2, idempotencyKey: randomUUID() };
  switch (value.kind) {
    case 'race-event':
      return sourceRaces.deleteRaceEvent(athlete, value.id, command);
    case 'race-result':
      return sourceRaces.deleteRaceResult(athlete, value.id, command);
    case 'training-best':
      return sourceRaces.deleteTrainingBest(athlete, value.id, command);
  }
}
function read(repository: RaceRepository, athlete: string, value: Entity) {
  switch (value.kind) {
    case 'race-event':
      return repository.getRaceEvent(athlete, value.id);
    case 'race-result':
      return repository.getRaceResult(athlete, value.id);
    case 'training-best':
      return repository.getTrainingBest(athlete, value.id);
  }
}
// This store is private local test storage, not an S3 durability/retention proof.
// It uses the production coordinator's exact immutable-version and HMAC-head ports.
class FileVersionedStore implements SuppressionRemoteStore {
  private sequence = 0;
  private headVersion = 'head-0';
  readonly headVersions: string[] = [];
  constructor(private readonly root: string) {}
  async seed(head: SuppressionHead) {
    await writeFile(
      join(this.root, 'head-0.json'),
      encodeSuppressionHead(head, headAuthenticationKey),
      { flag: 'wx', mode: 0o600 },
    );
  }
  async readHead(): Promise<VersionedObject> {
    return {
      bytes: await readFile(join(this.root, `${this.headVersion}.json`)),
      versionId: this.headVersion,
    };
  }
  async readSegment(segmentId: string, versionId: string): Promise<VersionedObject | null> {
    try {
      return { bytes: await readFile(join(this.root, `${segmentId}-${versionId}.bin`)), versionId };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async putImmutableSegment(bytes: Buffer) {
    const segmentId = `segment-${++this.sequence}`,
      versionId = `version-${this.sequence}`;
    await writeFile(join(this.root, `${segmentId}-${versionId}.bin`), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
    return { segmentId, versionId };
  }
  async compareAndSetHead(expectedVersionId: string, bytes: Buffer) {
    if (expectedVersionId !== this.headVersion) throw new Error('SYNTHETIC_HEAD_VERSION_CONFLICT');
    const versionId = `head-${++this.sequence}`;
    await writeFile(join(this.root, `${versionId}.json`), bytes, { flag: 'wx', mode: 0o600 });
    this.headVersion = versionId;
    this.headVersions.push(versionId);
    return { versionId };
  }
}
const indexSchema = z.strictObject({
  headVersions: z
    .array(z.string().regex(/^head-[1-9]\d*$/))
    .min(2)
    .max(4),
});
const bindingSchema = z.strictObject({
  sourceDatabase: z.string(),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  clusterId: z.string().regex(/^[1-9]\d*$/),
  initialLsn: z.string(),
  backupLsn: z.string(),
});
async function savedChain(
  options: {
    indexBytes?: Buffer;
    tailBytes?: Buffer;
    segmentTransform?: (segments: Buffer[]) => Buffer[];
  } = {},
) {
  // The index is only an untrusted filename inventory. It is not an invented
  // production authentication format. Each head is verified by the existing HMAC
  // decoder; the independently saved final head fixes the required end of chain.
  const binding = bindingSchema.parse(
    JSON.parse((await readFile(join(directory, 'backup-binding.json'))).toString('utf8')),
  );
  expect(sha(await readFile(join(directory, 'before-deletion.dump')))).toBe(binding.archiveSha256);
  const initial = decodeSuppressionHead(
    await readFile(join(directory, 'head-0.json')),
    headAuthenticationKey,
  );
  const tail = decodeSuppressionHead(
    options.tailBytes ?? (await readFile(join(directory, 'tail-head.json'))),
    headAuthenticationKey,
  );
  const index = indexSchema.parse(
    JSON.parse(
      (options.indexBytes ?? (await readFile(join(directory, 'index.json')))).toString('utf8'),
    ),
  );
  if (
    initial.clusterId !== binding.clusterId ||
    initial.throughLsn !== binding.initialLsn ||
    initial.localHash !== null ||
    tail.clusterId !== binding.clusterId
  )
    throw new Error('LOCAL_ARCHIVE_BINDING_FAILED');
  const heads: SuppressionHead[] = [];
  const segments: Buffer[] = [];
  for (const version of index.headVersions) {
    const head = decodeSuppressionHead(
      await readFile(join(directory, `${version}.json`)),
      headAuthenticationKey,
    );
    if (
      !head.segment ||
      !head.localHash ||
      head.clusterId !== binding.clusterId ||
      head.slotName !== initial.slotName
    )
      throw new Error('LOCAL_ARCHIVE_BINDING_FAILED');
    const bytes = await readFile(
      join(directory, `${head.segment.segmentId}-${head.segment.versionId}.bin`),
    );
    if (bytes.length !== head.segment.byteLength || sha(bytes) !== head.segment.sha256)
      throw new Error('LOCAL_SEGMENT_VERSION_FAILED');
    heads.push(head);
    segments.push(bytes);
  }
  const last = heads.at(-1);
  if (!last || JSON.stringify(last) !== JSON.stringify(tail) || !tail.localHash)
    throw new Error('LOCAL_TAIL_BINDING_FAILED');
  const anchor: TrustedReplayAnchor = {
    clusterId: binding.clusterId,
    fromLsn: initial.throughLsn,
    previousHash: initial.localHash,
    throughLsn: tail.throughLsn,
    finalLocalHash: tail.localHash,
    ciphertextHashes: heads.map((head) => {
      if (!head.segment) throw new Error('SEGMENT_REQUIRED');
      return head.segment.sha256;
    }),
  };
  return {
    segments: options.segmentTransform ? options.segmentTransform(segments) : segments,
    anchor,
    key: encryptionKey,
    keyId: encryptionKeyId,
  };
}
async function protectedRows(pool: Pool) {
  return tenant(pool, mainAthlete, async (client) => {
    const results = [];
    for (const table of [
      'plan_snapshot',
      'plan_head',
      'plan_history',
      'activity_canonical',
      'activity_source_head',
      'activity_source_revision',
    ])
      results.push(
        (
          await client.query(
            `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`,
          )
        ).rows[0],
      );
    return results;
  });
}
async function facts(pool: Pool) {
  const results = [];
  for (const athlete of [mainAthlete, overlapAthlete, erasedAthlete, otherAthlete])
    results.push(
      await tenant(pool, athlete, async (client) => {
        const rows = [];
        for (const table of [
          'race_event',
          'race_event_revision',
          'race_result',
          'race_result_revision',
          'training_best',
          'training_best_revision',
          'race_collection_head',
          'race_command_receipt',
          'restore_suppression_event',
          'restore_race_deletion_replay_receipt',
          'tenant_erasure',
          'outbox',
        ])
          rows.push(
            (
              await client.query(
                `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t WHERE athlete_id=$1`,
                [athlete],
              )
            ).rows[0],
          );
        return rows;
      }),
    );
  return results;
}
async function assertDeleted(athlete: string, values: Entity[]) {
  for (const value of values) {
    expect(await read(restoredRaces, athlete, value)).toBeNull();
    const table = value.kind.replaceAll('-', '_');
    const result = await tenant(restoredOwner, athlete, (client) =>
      client.query(
        `SELECT (SELECT count(*)::int FROM ${table}_revision WHERE entity_id=$1) AS history,(SELECT deleted FROM ${table} WHERE id=$1) AS deleted,(SELECT values_json FROM ${table} WHERE id=$1) AS values`,
        [value.id],
      ),
    );
    expect(result.rows[0]).toEqual({ history: 0, deleted: true, values: null });
  }
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wm-race-archive-'));
  for (const role of [sourceOwnerRole, restoredOwnerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${sourceName}" OWNER "${sourceOwnerRole}"`);
  await admin.query(`CREATE DATABASE "${restoredName}" OWNER "${restoredOwnerRole}"`);
  await migrate(urlFor(sourceName, sourceOwnerRole));
  sourceOwner = new Pool({ connectionString: urlFor(sourceName, sourceOwnerRole) });
  const adminEndpoint = new URL(adminUrl);
  adminEndpoint.pathname = `/${sourceName}`;
  sourceAdmin = new Pool({ connectionString: adminEndpoint.toString() });
  await sourceOwner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(sourceName, sourceOwnerRole), runtimeRole);
  await grantRaces(urlFor(sourceName, sourceOwnerRole), runtimeRole);
  await sourceOwner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO "${runtimeRole}"`);
  sourceDatabase = createDatabase({ connectionString: urlFor(sourceName, runtimeRole), max: 4 });
  sourceRaces = createRaceRepository(sourceDatabase);
  mainAthlete = await account();
  overlapAthlete = await account();
  erasedAthlete = await account();
  otherAthlete = await account();
  mainEntities = await entities(mainAthlete);
  overlapEntities = await entities(overlapAthlete);
  erasedEntities = await entities(erasedAthlete);
  otherEntities = await entities(otherAthlete);
  await tenant(sourceOwner, mainAthlete, async (client) => {
    const planId = randomUUID(),
      activityId = randomUUID(),
      sourceId = randomUUID();
    await client.query(
      'INSERT INTO plan_snapshot(athlete_id,id,version,draft) VALUES($1,$2,1,$3::jsonb)',
      [
        mainAthlete,
        planId,
        JSON.stringify({
          title: 'Independent synthetic plan',
          timezone: 'UTC',
          periods: [],
          sessions: [],
        }),
      ],
    );
    await client.query('INSERT INTO plan_head(athlete_id,version_id) VALUES($1,$2)', [
      mainAthlete,
      planId,
    ]);
    await client.query(
      "INSERT INTO plan_history(athlete_id,version_id,action) VALUES($1,$2,'manual_saved')",
      [mainAthlete, planId],
    );
    await client.query(
      'INSERT INTO activity_canonical(athlete_id,id,revision,original) VALUES($1,$2,1,$3::jsonb)',
      [mainAthlete, activityId, JSON.stringify({ title: 'Independent synthetic Activity' })],
    );
    await client.query(
      "INSERT INTO activity_source_head(athlete_id,kind,source_id,source_revision,content_hash,activity_id) VALUES($1,'fixture',$2,1,$3,$4)",
      [mainAthlete, sourceId, 'a'.repeat(64), activityId],
    );
    await client.query(
      "INSERT INTO activity_source_revision(athlete_id,kind,source_id,source_revision,content_hash,normalized_raw) VALUES($1,'fixture',$2,1,$3,'{}'::jsonb)",
      [mainAthlete, sourceId, 'a'.repeat(64)],
    );
  });
  protectedBefore = await protectedRows(sourceOwner);
  initialLsn = z
    .string()
    .parse(
      (
        await sourceAdmin.query('SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)', [
          slotName,
          'pgoutput',
        ])
      ).rows[0]?.['lsn'],
    );
  clusterId = z
    .string()
    .parse(
      (await sourceAdmin.query('SELECT system_identifier::text FROM pg_control_system()'))
        .rows[0]?.['system_identifier'],
    );
  store = new FileVersionedStore(directory);
  await store.seed({
    formatVersion: 1,
    clusterId,
    slotName,
    throughLsn: initialLsn,
    localHash: null,
    segment: null,
  });
  const exportSegment = () =>
    coordinateSuppressionExport({
      pool: sourceAdmin,
      store,
      slotName,
      expectedClusterId: clusterId,
      encryptionKey,
      encryptionKeyId,
      headAuthenticationKey,
    });
  for (const value of overlapEntities) await remove(overlapAthlete, value);
  const beforeBackupHead = await exportSegment();
  if (!beforeBackupHead.segment) throw new Error('ACTUAL_PRE_BACKUP_SEGMENT_REQUIRED');
  // This disposable fixture has no concurrent writers during archive capture.
  // It is not a substitute for the production exported-snapshot/baseline gate.
  const backupLsn = z
    .string()
    .parse((await sourceAdmin.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]?.['lsn']);
  pg('pg_dump', [
    '--dbname',
    adminEndpoint.toString(),
    '--format=custom',
    '--file',
    join(directory, 'before-deletion.dump'),
  ]);
  archiveDigest = sha(await readFile(join(directory, 'before-deletion.dump')));
  await writeFile(
    join(directory, 'backup-binding.json'),
    JSON.stringify({
      sourceDatabase: sourceName,
      archiveSha256: archiveDigest,
      clusterId,
      initialLsn,
      backupLsn,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  for (const value of erasedEntities) await remove(erasedAthlete, value);
  await sourceDatabase.exclusiveTenant(erasedAthlete, (tx) =>
    tx.query('SELECT public.erase_account($1)', [erasedAthlete]),
  );
  for (const value of mainEntities) await remove(mainAthlete, value);
  gapEntities = await entities(mainAthlete);
  for (const value of gapEntities) await remove(mainAthlete, value);
  finalHead = await exportSegment();
  if (!finalHead.segment || store.headVersions.length !== 2)
    throw new Error('ACTUAL_TWO_SEGMENT_CHAIN_REQUIRED');
  const position = z
    .string()
    .parse(
      (
        await sourceAdmin.query(
          'SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name=$1',
          [slotName],
        )
      ).rows[0]?.['lsn'],
    );
  expect(position).toBe(finalHead.throughLsn);
  await writeFile(
    join(directory, 'index.json'),
    JSON.stringify({ headVersions: store.headVersions }),
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(join(directory, 'tail-head.json'), (await store.readHead()).bytes, {
    flag: 'wx',
    mode: 0o600,
  });
  const targetAdminEndpoint = new URL(adminUrl);
  targetAdminEndpoint.pathname = `/${restoredName}`;
  pg('pg_restore', [
    '--dbname',
    targetAdminEndpoint.toString(),
    '--role',
    restoredOwnerRole,
    '--no-owner',
    '--single-transaction',
    '--exit-on-error',
    join(directory, 'before-deletion.dump'),
  ]);
  restoredOwner = new Pool({ connectionString: urlFor(restoredName, restoredOwnerRole) });
  // Existing restore owner cutover: FORCE-RLS definer policies name the source owner.
  await restoredOwner.query('SELECT public.retarget_definer_policies()');
  restoredRuntime = new Pool({ connectionString: urlFor(restoredName, runtimeRole) });
  await restoredOwner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(restoredName, restoredOwnerRole), runtimeRole);
  await grantRaces(urlFor(restoredName, restoredOwnerRole), runtimeRole);
  await restoredOwner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO "${runtimeRole}"`);
  restoredDatabase = createDatabase({
    connectionString: urlFor(restoredName, runtimeRole),
    max: 4,
  });
  restoredRaces = createRaceRepository(restoredDatabase);
}, 90000);
afterAll(async () => {
  await sourceDatabase?.close();
  await restoredDatabase?.close();
  await restoredRuntime?.end();
  await restoredOwner?.end();
  await sourceOwner?.end();
  if (sourceAdmin) {
    await sourceAdmin
      .query('SELECT pg_drop_replication_slot($1)', [slotName])
      .catch(() => undefined);
    await sourceAdmin.end();
  }
  await dropIsolatedDatabase(admin, sourceName);
  await dropIsolatedDatabase(admin, restoredName);
  for (const role of [runtimeRole, restoredOwnerRole, sourceOwnerRole])
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 30000);

describe('M2-02f actual custom archive and authenticated local v4 race-deletion chain', () => {
  it('restores a real pre-deletion archive into an independent database with plain owner and restricted runtime', async () => {
    expect(sourceName).not.toBe(restoredName);
    expect(
      (await readFile(join(directory, 'before-deletion.dump'))).subarray(0, 5).toString(),
    ).toBe('PGDMP');
    for (const pool of [sourceOwner, restoredOwner, restoredRuntime])
      expect(
        (await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user'))
          .rows[0],
      ).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(
      (
        await restoredOwner.query(
          "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.race_event'::regclass",
        )
      ).rows[0]?.['owner'],
    ).toBe(restoredOwnerRole);
    for (const value of mainEntities) {
      expect(await read(restoredRaces, mainAthlete, value)).toMatchObject({
        id: value.id,
        revision: 2,
      });
      expect(await read(sourceRaces, mainAthlete, value)).toBeNull();
    }
    for (const value of gapEntities)
      expect(await read(restoredRaces, mainAthlete, value)).toBeNull();
    const counts = await tenant(restoredOwner, overlapAthlete, (client) =>
      client.query(
        'SELECT (SELECT count(*)::int FROM restore_suppression_event WHERE record_version=4 AND athlete_id=$1) AS events,(SELECT count(*)::int FROM restore_race_deletion_replay_receipt WHERE athlete_id=$1) AS replay',
        [overlapAthlete],
      ),
    );
    expect(counts.rows[0]).toEqual({ events: 3, replay: 0 });
    expect(await protectedRows(restoredOwner)).toEqual(protectedBefore);
    const chain = await savedChain();
    const records = chain.segments.flatMap((bytes) =>
      decryptReplaySegment({
        bytes,
        key: encryptionKey,
        expectedKeyId: encryptionKeyId,
      }).transactions.flatMap((transaction) => transaction.records),
    );
    expect(records.filter((value) => value.schemaVersion === 4)).toHaveLength(12);
    expect(records.filter((value) => value.kind === 'tenant_erased')).toHaveLength(1);
  });
  it('rejects corrupt, missing, reordered and unauthenticated chains before any restored writes', async () => {
    const before = await facts(restoredOwner);
    const index = JSON.parse(
      (await readFile(join(directory, 'index.json'))).toString('utf8'),
    ) as unknown;
    const checked = indexSchema.parse(index);
    const tail = await readFile(join(directory, 'tail-head.json'));
    const corruptedTail = Buffer.from(tail);
    const last = corruptedTail.length - 1;
    corruptedTail[last] = (corruptedTail[last] ?? 0) ^ 1;
    const connect = vi.spyOn(restoredOwner, 'connect');
    try {
      await expect(savedChain({ tailBytes: corruptedTail })).rejects.toThrow(
        'SUPPRESSION_REMOTE_COORDINATION_FAILED',
      );
      await expect(
        savedChain({
          indexBytes: Buffer.from(JSON.stringify({ headVersions: [checked.headVersions[0]] })),
        }),
      ).rejects.toThrow();
      // Removing the first inventory entry cannot redefine the initial trusted fence.
      const good = await savedChain();
      for (const segments of [good.segments.slice(1), [...good.segments].reverse()])
        await expect(
          replayVerifiedSuppressionChain({ ...good, segments, ownerPool: restoredOwner }),
        ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      const tampered = good.segments.map((bytes) => Buffer.from(bytes));
      const final = tampered.at(-1);
      if (!final) throw new Error('SEGMENT_REQUIRED');
      final[final.length - 1] = (final[final.length - 1] ?? 0) ^ 1;
      await expect(
        replayVerifiedSuppressionChain({ ...good, segments: tampered, ownerPool: restoredOwner }),
      ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      await expect(
        replayVerifiedSuppressionChain({
          ...good,
          anchor: { ...good.anchor, clusterId: '2' },
          ownerPool: restoredOwner,
        }),
      ).rejects.toThrow('RESTORE_REPLAY_PREFLIGHT_FAILED');
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
    expect(await facts(restoredOwner)).toEqual(before);
  });
  it('denies restricted-runtime chain application even with caller-set replay GUCs', async () => {
    const before = await facts(restoredOwner);
    const chain = await savedChain();
    await expect(
      replayVerifiedSuppressionChain({ ...chain, ownerPool: restoredRuntime }),
    ).rejects.toThrow('permission denied');
    const record = decryptReplaySegment({
      bytes: chain.segments[1] ?? Buffer.alloc(0),
      key: encryptionKey,
      expectedKeyId: encryptionKeyId,
    })
      .transactions.flatMap((transaction) => transaction.records)
      .find((value) => value.kind === 'race_event_deleted');
    if (!record || record.kind !== 'race_event_deleted') throw new Error('RACE_RECORD_REQUIRED');
    await restoredOwner.query(
      `GRANT EXECUTE ON FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer) TO "${runtimeRole}"`,
    );
    try {
      await expect(
        tenant(restoredRuntime, record.athleteId, async (client) => {
          await client.query("SELECT set_config('app.restore_actual_event_id',$1,true)", [
            record.eventId,
          ]);
          return client.query('SELECT public.replay_race_deletion_exact($1,$2,$3,$4,$5,$6,$7)', [
            record.athleteId,
            record.kind,
            record.targetId,
            record.eventId,
            record.occurredAt,
            record.racePreviousRevision,
            record.raceDeletedRevision,
          ]);
        }),
      ).rejects.toThrow('RESTORE_RACE_OWNER_REQUIRED');
    } finally {
      await restoredOwner.query(
        `REVOKE EXECUTE ON FUNCTION public.replay_race_deletion_exact(text,text,uuid,uuid,timestamptz,integer,integer) FROM "${runtimeRole}"`,
      );
    }
    expect(await facts(restoredOwner)).toEqual(before);
  });
  it('applies the production v4 event stream through existing replay API and purges all three families', async () => {
    const chain = await savedChain();
    const applied = await replayVerifiedSuppressionChain({ ...chain, ownerPool: restoredOwner });
    expect(applied).toMatchObject({
      eventCount: 13,
      segmentCount: 2,
      clusterId,
      throughLsn: finalHead.throughLsn,
    });
    await assertDeleted(mainAthlete, [...mainEntities, ...gapEntities]);
    await assertDeleted(overlapAthlete, overlapEntities);
    // Compare exact authenticated production identities/facts, including the
    // backup's pre-existing events whose restore receipt was initially absent.
    const records = chain.segments.flatMap((bytes) =>
      decryptReplaySegment({
        bytes,
        key: encryptionKey,
        expectedKeyId: encryptionKeyId,
      }).transactions.flatMap((transaction) => transaction.records),
    );
    for (const record of records) {
      if (
        record.kind !== 'race_event_deleted' &&
        record.kind !== 'race_result_deleted' &&
        record.kind !== 'training_best_deleted'
      )
        continue;
      const matched = await tenant(restoredOwner, record.athleteId, (client) =>
        client.query(
          `SELECT count(*)::int AS count FROM restore_suppression_event e JOIN restore_race_deletion_replay_receipt r ON r.event_id=e.event_id
         WHERE e.event_id=$1 AND e.record_version=4 AND e.athlete_id=$2 AND e.kind=$3 AND e.target_id=$4 AND e.occurred_at=$5::timestamptz AND e.race_previous_revision=$6 AND e.race_deleted_revision=$7`,
          [
            record.eventId,
            record.athleteId,
            record.kind,
            record.targetId,
            record.occurredAt,
            record.racePreviousRevision,
            record.raceDeletedRevision,
          ],
        ),
      );
      expect(matched.rows[0]?.['count']).toBe(1);
    }

    const erased = await tenant(restoredOwner, erasedAthlete, (client) =>
      client.query(
        'SELECT (SELECT count(*)::int FROM race_event) AS events,(SELECT count(*)::int FROM race_result) AS results,(SELECT count(*)::int FROM training_best) AS bests,(SELECT count(*)::int FROM race_event_revision) AS event_history,(SELECT count(*)::int FROM race_result_revision) AS result_history,(SELECT count(*)::int FROM training_best_revision) AS best_history,(SELECT count(*)::int FROM tenant_erasure) AS erasures',
      ),
    );
    expect(erased.rows[0]).toEqual({
      events: 0,
      results: 0,
      bests: 0,
      event_history: 0,
      result_history: 0,
      best_history: 0,
      erasures: 1,
    });
    for (const value of otherEntities)
      expect(await read(restoredRaces, otherAthlete, value)).toEqual(value.retained);
    expect(await protectedRows(restoredOwner)).toEqual(protectedBefore);
  });
  it('replays complete chains and old successful commands without reconstructing deleted values or history', async () => {
    const before = await facts(restoredOwner);
    const chain = await savedChain();
    await replayVerifiedSuppressionChain({ ...chain, ownerPool: restoredOwner });
    expect(await facts(restoredOwner)).toEqual(before);
    for (const value of mainEntities) {
      expect(await value.replayCreate(restoredRaces)).toEqual(value.original);
      expect(await value.replayUpdate(restoredRaces)).toEqual(value.corrected);
    }
    await assertDeleted(mainAthlete, [...mainEntities, ...gapEntities]);
    expect(await facts(restoredOwner)).toEqual(before);
    expect(await protectedRows(restoredOwner)).toEqual(protectedBefore);
  });
  it('denies owner/runtime GUC resurrection and remains tenant isolated after the authenticated restore', async () => {
    const before = await facts(restoredOwner);
    for (const pool of [restoredOwner, restoredRuntime])
      for (const value of [...mainEntities, ...gapEntities]) {
        const table = value.kind.replaceAll('-', '_');
        await expect(
          tenant(pool, mainAthlete, async (client) => {
            await client.query("SELECT set_config('app.restore_actual_event_id',$1,true)", [
              randomUUID(),
            ]);
            return client.query(
              `UPDATE ${table} SET deleted=false,values_json='{}'::jsonb WHERE id=$1`,
              [value.id],
            );
          }),
        ).rejects.toThrow('RACE_DELETED_REENTRY');
      }
    for (const value of otherEntities)
      expect(await read(restoredRaces, mainAthlete, value)).toBeNull();
    for (const value of mainEntities)
      expect(await read(restoredRaces, otherAthlete, value)).toBeNull();
    for (const value of erasedEntities)
      await expect(value.replayCreate(restoredRaces)).rejects.toThrow('ACCOUNT_ERASED');
    expect(await facts(restoredOwner)).toEqual(before);
  });
});
