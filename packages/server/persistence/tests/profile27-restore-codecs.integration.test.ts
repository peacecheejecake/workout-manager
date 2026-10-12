import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { migrate } from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import { createPlanningRepository } from '../src/planning.js';
import { createCoachingThreadRepository } from '../src/coaching-threads.js';
import { createCoreEvidenceSnapshotRepository } from '../src/evidence-snapshots.js';
import { createConsentRepository } from '../src/repositories.js';
import { createAiSettingsRepository } from '../src/ai-settings.js';
import {
  cancelRestoredAiExecutionJobIn,
  createAiExecutionJobRepository,
} from '../src/ai-execution-jobs.js';
import {
  decodeSuppressionPgoutputRecordsV7,
  decodeSuppressionPgoutputRecordsV8,
  peekSuppressionPgoutput,
} from '../src/restore-suppression-pgoutput.js';
import { suppressionRecordColumnNamesV8 } from '../src/restore-suppression-records-v8.js';
import { decodeRestoreSuppressionPhysicalRowV8 } from '../src/restore-suppression-physical-row-v8.js';
import {
  encryptReplaySegmentV8,
  makeLocalReplayRecordEnvelopeV7,
  makeLocalReplayRecordEnvelopeV8,
  type SuppressionSourceBindingV8,
} from '../src/restore-suppression-segment.js';
import {
  createSuppressionReplayVerifierV8,
  encodeSuppressionHeadV8,
} from '../src/restore-suppression-replay-v8.js';
import {
  createFullRestoreDurableRowParserV2,
  FULL_RESTORE_PROFILE27_NO_CODEC_RELATIONS,
  fullRestoreDurableRowColumnsV2,
} from '../src/full-restore-durable-row-codecs-v2.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
import {
  grantGalleryNavigationRuntimeForTest,
  grantProfile26Runtime,
  installProfile26WithGalleryMembers,
} from './gallery-profile27-fixture.js';

// Real PostgreSQL 17.6 (wal_level=logical): committed profile26 (V10) with the pinned
// 143/144/145 sources and raw 148 applied by the plain owner. Album deletions mint genuine
// record-8 events, which are read back through pgoutput and the physical row, carried in a
// V8 authenticated chain and replayed by the exact SQL145 function into a template-copied
// target. Retained profile27 rows are captured catalog-driven through the durable codecs.
// Synthetic data only; no provider, key, budget or dispatch.
const enabled = Boolean(process.env['TEST_DATABASE_ADMIN_URL']);
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const sourceName = `p27_codec_src_${suffix}`;
const targetName = `p27_codec_dst_${suffix}`;
const ownerRole = `p27_codec_owner_${suffix}`;
const runtimeRole = `p27_codec_app_${suffix}`;
const slot = `wm_suppression_p27_${suffix}`;
const roles: string[] = [];
const databases: string[] = [];
let admin: Pool;
let owner: Pool;
let control: Pool;
let targetOwner: Pool;
let targetControl: Pool;
let database: Database;
let slotCreated = false;
let slotLsn = '';

function url(database: string, role?: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${database}`;
  if (role) {
    value.username = role;
    value.password = 'isolated';
  }
  return value.toString();
}
async function inTransaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const value = await work(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
/** Owner tenant transaction under the caller-held global restore fence. */
function ownerTenant<T>(
  pool: Pool,
  athlete: string,
  work: (tx: PoolClient) => Promise<T>,
  fence: 'shared' | 'exclusive' = 'shared',
) {
  return inTransaction(pool, async (tx) => {
    await tx.query(
      fence === 'shared'
        ? 'SELECT pg_advisory_xact_lock_shared(77210,1)'
        : 'SELECT pg_advisory_xact_lock(77210,1)',
    );
    await tx.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    return work(tx);
  });
}
async function waitUntilIdle(name: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const open = await admin.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname=$1',
      [name],
    );
    if (Number(open.rows[0]?.total) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('SOURCE_DATABASE_BUSY');
}

// Catalog-driven capture: the codec column set must equal the live catalog column set.
async function capture(pool: Pool, relation: string, where = 'true', args: unknown[] = []) {
  const columns = (
    await pool.query<{ name: string; type: string }>(
      `SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a
       WHERE a.attrelid=to_regclass('public.'||$1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [relation],
    )
  ).rows;
  expect(columns.length, relation).toBeGreaterThan(0);
  expect(columns.map((c) => c.name).sort()).toEqual(
    [...(fullRestoreDurableRowColumnsV2[relation] ?? [])].sort(),
  );
  const fields = columns
    .map((c) => {
      if (!/^[a-z_]+$/.test(c.name)) throw new Error('UNEXPECTED_COLUMN');
      return `'${c.name}',${
        c.type === 'timestamp with time zone'
          ? `to_char(t."${c.name}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
          : `t."${c.name}"`
      }`;
    })
    .join(',');
  if (!/^[a-z_]+$/.test(relation)) throw new Error('UNEXPECTED_RELATION');
  return (
    await pool.query<{ row: Record<string, unknown> }>(
      `SELECT jsonb_build_object(${fields}) AS row FROM public.${relation} t WHERE ${where}`,
      args,
    )
  ).rows.map((r) => r.row);
}
const parser = createFullRestoreDurableRowParserV2({ maxRowBytes: 8388608 });

async function account(pool: Pool, athleteId?: string) {
  const row = await pool.query<{ athlete_id: string }>(
    athleteId
      ? `INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,'https://issuer.test',$2) RETURNING athlete_id::text`
      : `INSERT INTO identity_private.account(issuer,subject) VALUES('https://issuer.test',$1) RETURNING athlete_id::text`,
    athleteId ? [athleteId, randomUUID()] : [randomUUID()],
  );
  return z.string().parse(row.rows[0]?.athlete_id);
}
const value = (rows: { value?: unknown }[]) => rows[0]?.value;
async function command(athlete: string, sql: string, payload: unknown) {
  return ownerTenant(owner, athlete, async (tx) =>
    value((await tx.query(sql, [JSON.stringify(payload), `synthetic-${randomUUID()}`])).rows),
  );
}
async function insertImage(athlete: string) {
  const id = randomUUID();
  const hash = randomBytes(32).toString('hex');
  await ownerTenant(owner, athlete, (tx) =>
    tx.query(
      `INSERT INTO public.gallery_media_item(athlete_id,id,media_kind,storage_ref,original_filename,
       media_type,size_bytes,content_hash,access_revision,created_at,updated_at)
       VALUES($1,$2,'image',$3,'synthetic.jpg','image/jpeg',4096,$4,1,clock_timestamp(),clock_timestamp())`,
      [
        athlete,
        id,
        `private/v1/tenants/${athlete}/gallery/${id}/objects/uploads/${randomUUID()}/sha256/${hash}.jpg`,
        hash,
      ],
    ),
  );
  return id;
}
async function seedCourse(athlete: string) {
  const courseId = randomUUID();
  const revisionId = randomUUID();
  await ownerTenant(owner, athlete, async (tx) => {
    await tx.query(
      `INSERT INTO public.course(athlete_id,course_id,name,visibility,status,head_revision,revision_id,created_at,updated_at)
       VALUES($1,$2,'합성 코스','private','available',1,$3,statement_timestamp(),statement_timestamp())`,
      [athlete, courseId, revisionId],
    );
    await tx.query(
      `INSERT INTO public.course_revision(athlete_id,course_id,course_revision,revision_id,name,geometry,waypoints,
        generation,edit,vertex_count,distance_meters,content_digest,created_at)
       VALUES($1,$2,1,$3,'합성 코스','{"type":"LineString","coordinates":[[0,0],[0.001,0]]}','[]','{}','{}',2,111,$4,statement_timestamp())`,
      [athlete, courseId, revisionId, 'b'.repeat(64)],
    );
  });
  return { courseId, courseRevision: 1, revisionId };
}

// AI job scenario (synthetic catalog/registry; mirrors the SQL148 integration fixture).
const policy = { id: 'running-core-v2-training', version: '1' };
const sol = { providerId: 'openai', modelId: 'gpt-6.1-sol' };
const settings = {
  revision: 1,
  catalogRevision: 1,
  policyVersion: 'm2-05a-policy:1',
  disclosureVersion: 'm2-05a-disclosure:1',
};
const registry = [
  {
    selection: sol,
    purpose: 'coaching',
    adapterBindingVersion: 'synthetic:adapter:1',
    vendorModelRef: `synthetic:${sol.modelId}`,
    priceModelRef: sol.modelId,
    priceVersion: 'synthetic:price:1',
    tokenizerVersion: 'synthetic:tokenizer:1',
  },
];
const catalog = {
  schemaVersion: 1,
  catalogRevision: 1,
  policyVersion: settings.policyVersion,
  disclosureVersion: settings.disclosureVersion,
  approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
  providers: [
    {
      providerId: 'openai',
      displayName: 'Synthetic OpenAI',
      selectable: true,
      availability: { kind: 'available' },
      recipient: {
        recipientId: 'openai',
        displayName: 'Synthetic recipient',
        disclosureVersion: settings.disclosureVersion,
      },
      models: [
        {
          modelId: sol.modelId,
          displayName: 'Synthetic Sol',
          selectable: true,
          availability: { kind: 'available' },
          purposes: ['coaching'],
        },
      ],
    },
  ],
  recommendedDefault: null,
  recommendedSyntheticComparison: { kind: 'off' },
};
async function aiJobScenario() {
  const athleteId = randomUUID();
  const consent = createConsentRepository(database);
  await consent.setConsent(athleteId, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
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
  const thread = (
    await createCoachingThreadRepository(database).create(athleteId, {
      planVersionId: plan.id,
      title: 'Training question',
      scope: { kind: 'session', targetId: 'session' },
      message: 'Synthetic report',
      idempotencyKey: randomUUID(),
    })
  ).thread;
  await consent.setConsent(athleteId, {
    kind: 'ai',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const evidence = await createCoreEvidenceSnapshotRepository(database).capture(
    athleteId,
    thread.id,
    {
      expectedConversationRevision: 1,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
      idempotencyKey: randomUUID(),
    },
  );
  await createAiSettingsRepository(database).write(athleteId, {
    schemaVersion: 1,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    catalogRevision: 1,
    policyVersion: settings.policyVersion,
    disclosureVersion: settings.disclosureVersion,
    defaultSelection: sol,
    syntheticComparison: { kind: 'off' },
  });
  const repository = createAiExecutionJobRepository(database, { policy, registry });
  const command = () => ({
    commandVersion: 1 as const,
    evidenceSnapshotId: evidence.id,
    expectedConversationRevision: 1,
    purpose: 'coaching' as const,
    settings,
    idempotencyKey: randomUUID(),
  });
  return { athleteId, thread, repository, command };
}

describe.skipIf(!enabled).sequential('profile27 restore suppression v8 and durable codecs', () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    expect((await admin.query('SHOW wal_level')).rows[0]?.['wal_level']).toBe('logical');
    for (const role of [ownerRole, runtimeRole]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
      );
      roles.push(role);
    }
    await admin.query(`CREATE DATABASE "${sourceName}" OWNER "${ownerRole}"`);
    databases.push(sourceName);
    const ownerUrl = url(sourceName, ownerRole);
    await migrate(ownerUrl, 107);
    await installProfile26WithGalleryMembers(ownerUrl);
    await grantProfile26Runtime(ownerUrl, runtimeRole);
    await grantGalleryNavigationRuntimeForTest(ownerUrl, runtimeRole);
    const sql148 = await readFile(
      new URL('../migrations/148_ai_execution_job_store.sql', import.meta.url),
      'utf8',
    );
    const setup = new Pool({ connectionString: ownerUrl, max: 1 });
    try {
      await inTransaction(setup, async (tx) => {
        await tx.query(sql148);
        await tx.query(`GRANT SELECT,INSERT ON public.ai_execution_job TO "${runtimeRole}"`);
        await tx.query(
          `GRANT SELECT ON public.ai_synthetic_evidence_attestation TO "${runtimeRole}"`,
        );
        await tx.query(
          `GRANT SELECT,INSERT ON public.ai_execution_job_disposition TO "${runtimeRole}"`,
        );
      });
      await inTransaction(setup, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))",
        );
        await tx.query(
          "INSERT INTO ai_settings_catalog_definition VALUES(1,$1::jsonb,encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex'))",
          [JSON.stringify(catalog)],
        );
        await tx.query('INSERT INTO ai_settings_catalog_head VALUES(true,1)');
      });
    } finally {
      await setup.end();
    }
    // The restore target is a byte copy of the installed source before any tenant data.
    await waitUntilIdle(sourceName);
    await admin.query(
      `CREATE DATABASE "${targetName}" TEMPLATE "${sourceName}" OWNER "${ownerRole}"`,
    );
    databases.push(targetName);
    owner = new Pool({ connectionString: ownerUrl, max: 3 });
    control = new Pool({ connectionString: url(sourceName), max: 2 });
    targetOwner = new Pool({ connectionString: url(targetName, ownerRole), max: 2 });
    targetControl = new Pool({ connectionString: url(targetName), max: 2 });
    database = createDatabase({ connectionString: url(sourceName, runtimeRole), max: 4 });
    const created = await control.query<{ lsn: string }>(
      'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
      [slot, 'pgoutput'],
    );
    slotCreated = true;
    slotLsn = z.string().parse(created.rows[0]?.lsn);
  }, 600000);
  afterAll(async () => {
    await database?.close().catch(() => undefined);
    if (slotCreated)
      await control.query('SELECT pg_drop_replication_slot($1)', [slot]).catch(() => undefined);
    for (const pool of [owner, control, targetOwner, targetControl])
      await pool?.end().catch(() => undefined);
    for (const name of databases.reverse()) await dropIsolatedDatabase(admin, name);
    for (const role of roles.reverse()) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin?.end();
  }, 60000);

  const albumSchema = z.object({ id: z.string(), revision: z.number() });
  let athlete = '';
  let keptAlbum = '';
  let backupAlbumRow: Record<string, unknown> = {};
  const deletedAlbums: { id: string; revision: number }[] = [];

  it('album deletions mint record-8 events that decode exactly through pgoutput V8 and the physical row', async () => {
    athlete = await account(owner);
    const first = albumSchema.parse(
      await command(athlete, 'SELECT public.create_gallery_album_v1($1::jsonb,$2) AS value', {
        title: '합성 앨범',
      }),
    );
    const second = albumSchema.parse(
      await command(athlete, 'SELECT public.create_gallery_album_v1($1::jsonb,$2) AS value', {
        title: '두 번째',
      }),
    );
    const kept = albumSchema.parse(
      await command(athlete, 'SELECT public.create_gallery_album_v1($1::jsonb,$2) AS value', {
        title: '남는 앨범',
      }),
    );
    keptAlbum = kept.id;
    const media = await insertImage(athlete);
    const linked = await insertImage(athlete);
    const course = await seedCourse(athlete);
    await command(athlete, 'SELECT public.set_gallery_media_navigation_v1($1::jsonb,$2) AS value', {
      mediaItemId: media,
      expectedAccessRevision: 1,
      albumMembership: { albumId: first.id },
      courseLink: null,
    });
    await command(athlete, 'SELECT public.set_gallery_media_navigation_v1($1::jsonb,$2) AS value', {
      mediaItemId: linked,
      expectedAccessRevision: 1,
      albumMembership: { albumId: kept.id },
      courseLink: course,
    });
    await command(athlete, 'SELECT public.rename_gallery_album_v1($1::jsonb,$2) AS value', {
      albumId: first.id,
      expectedRevision: 1,
      title: '새 이름',
    });
    // "Backup" of the first album's pre-deletion head, validated through its codec.
    const [pre] = await capture(control, 'gallery_album', 't.id=$1', [first.id]);
    backupAlbumRow = parser.parse({ relation: 'gallery_album', row: pre }).facts.row as Record<
      string,
      unknown
    >;
    expect(backupAlbumRow).toMatchObject({ revision: 2, deleted_at: null });
    for (const [album, expectedRevision] of [
      [first.id, 2],
      [second.id, 1],
    ] as const) {
      const deleted = z.object({ revision: z.number(), status: z.literal('deleted') }).parse(
        await command(athlete, 'SELECT public.delete_gallery_album_v1($1::jsonb,$2) AS value', {
          albumId: album,
          expectedRevision,
        }),
      );
      deletedAlbums.push({ id: album, revision: deleted.revision });
    }
    const messages = await peekSuppressionPgoutput(control, slot);
    const decoded = decodeSuppressionPgoutputRecordsV8(messages, slotLsn).flatMap(
      (tx) => tx.records,
    );
    expect(decoded).toHaveLength(2);
    expect(
      decoded.map((r) =>
        r.schemaVersion === 8 ? [r.kind, r.athleteId, r.targetId, r.galleryAccessRevision] : r,
      ),
    ).toEqual(deletedAlbums.map((a) => ['gallery_album_deleted', athlete, a.id, a.revision]));
    // Older decoders and envelopes fail closed on the genuine record-8 stream.
    expect(() => decodeSuppressionPgoutputRecordsV7(messages, slotLsn)).toThrow(
      'PGOUTPUT_UNKNOWN_EVENT',
    );
    expect(() =>
      makeLocalReplayRecordEnvelopeV7({
        clusterId: '1',
        fromLsn: slotLsn,
        previousHash: null,
        source: {
          databaseName: sourceName,
          databaseOid: 1,
          slotName: slot,
          publication: 'workout_restore_suppression_events',
          relationProfile: 'suppression-physical-v7',
          captureId: randomUUID(),
          registryFingerprint: 'a'.repeat(64),
        },
        messages,
      }),
    ).toThrow('PGOUTPUT_UNKNOWN_EVENT');
    // Physical row read of the same events: identical records apart from instant spelling.
    const names = suppressionRecordColumnNamesV8();
    const physical = (
      await control.query<{ row: unknown }>(
        `SELECT jsonb_build_object(${names
          .map(
            (n) =>
              `'${n}',${n === 'occurred_at' || n === 'course_share_audit_occurred_at' ? `to_char(e."${n}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : `e."${n}"`}`,
          )
          .join(',')}) AS row FROM public.restore_suppression_event e
         WHERE e.athlete_id=$1 ORDER BY e.occurred_at,e.event_id`,
        [athlete],
      )
    ).rows.map((r) => decodeRestoreSuppressionPhysicalRowV8(r.row));
    const micros = (s: string) => {
      const m = /^(.{19})(?:\.(\d{1,6}))?(.*)$/.exec(s);
      return `${new Date(Date.parse(`${m?.[1]?.replace(' ', 'T')}${m?.[3] === '+00' ? 'Z' : m?.[3]}`)).toISOString().slice(0, 19)}.${(m?.[2] ?? '').padEnd(6, '0')}`;
    };
    expect(physical.map((r) => ({ ...r, occurredAt: micros(r.occurredAt) }))).toEqual(
      decoded.map((r) => ({ ...r, occurredAt: micros(r.occurredAt) })),
    );
  });

  it('a V8 authenticated chain replays the genuine events into the restored target exactly once', async () => {
    const messages = await peekSuppressionPgoutput(control, slot);
    const identity = (
      await control.query<{ oid: number; system: string }>(
        `SELECT (SELECT oid FROM pg_database WHERE datname=current_database())::int AS oid,
          (SELECT system_identifier::text FROM pg_control_system()) AS system`,
      )
    ).rows[0];
    if (!identity) throw new Error('SOURCE_IDENTITY_MISSING');
    const source: SuppressionSourceBindingV8 = {
      databaseName: sourceName,
      databaseOid: identity.oid,
      slotName: slot,
      publication: 'workout_restore_suppression_events',
      relationProfile: 'suppression-physical-v8',
      captureId: randomUUID(),
      registryFingerprint: 'a'.repeat(64),
    };
    const envelope = makeLocalReplayRecordEnvelopeV8({
      clusterId: identity.system,
      fromLsn: slotLsn,
      previousHash: null,
      source,
      messages,
    });
    const key = randomBytes(32);
    const auth = randomBytes(32);
    const encrypted = encryptReplaySegmentV8({ envelope, key, keyId: 'synthetic-key' });
    const headBytes = encodeSuppressionHeadV8(
      {
        formatVersion: 3,
        source,
        clusterId: envelope.clusterId,
        fromLsn: envelope.fromLsn,
        throughLsn: envelope.throughLsn,
        previousHash: null,
        finalLocalHash: envelope.sha256,
        segments: [
          {
            segmentId: 'synthetic-segment',
            versionId: 'immutable-version',
            sha256: encrypted.sha256,
            byteLength: encrypted.byteLength,
            fromLsn: envelope.fromLsn,
            throughLsn: envelope.throughLsn,
            previousHash: null,
            localHash: envelope.sha256,
          },
        ],
      },
      auth,
    );
    const verifier = createSuppressionReplayVerifierV8({
      witness: {
        source,
        clusterId: envelope.clusterId,
        fromLsn: envelope.fromLsn,
        throughLsn: envelope.throughLsn,
        previousHash: null,
        finalLocalHash: envelope.sha256,
        headVersionId: 'head-version',
        headSha256: createHash('sha256').update(headBytes).digest('hex'),
      },
      encryptionKey: key,
      keyId: 'synthetic-key',
      headAuthenticationKey: auth,
    });
    const store = {
      readHead: async () => ({ bytes: headBytes, versionId: 'head-version' }),
      readSegment: async () => ({ bytes: encrypted.bytes, versionId: 'immutable-version' }),
    };
    // Restore load of the backed-up tenant: account and the first album's pre-deletion head.
    // The second album is absent from the backup (its exact ledger is recorded instead).
    await account(targetOwner, athlete);
    await ownerTenant(
      targetOwner,
      athlete,
      async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
        await tx.query(
          `INSERT INTO public.gallery_album(athlete_id,id,title,revision,created_at,updated_at,deleted_at)
           VALUES($1,$2,$3,$4,$5,$6,NULL)`,
          [
            backupAlbumRow['athlete_id'],
            backupAlbumRow['id'],
            backupAlbumRow['title'],
            backupAlbumRow['revision'],
            backupAlbumRow['created_at'],
            backupAlbumRow['updated_at'],
          ],
        );
      },
      'exclusive',
    );
    const replay = async () => {
      const prepared = await verifier.prepareVerifiedSuppressionChainV8(store);
      expect(prepared).toMatchObject({ eventCount: 2, originalEventStage: 'exact_replay' });
      return inTransaction(targetOwner, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
        return verifier.replayVerifiedSuppressionChainV8In(tx, prepared);
      });
    };
    expect(await replay()).toEqual({
      status: 'replayed',
      eventCount: 2,
      authority: 'none',
      admissionAllowed: false,
    });
    // Idempotent: the exact receipts make a second replay an already-applied no-op.
    expect(await replay()).toMatchObject({ status: 'replayed', eventCount: 2 });
    const sourceEvents = (
      await control.query(
        `SELECT event_id::text,record_version,kind,target_id::text,gallery_access_revision,occurred_at
         FROM public.restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id`,
        [athlete],
      )
    ).rows;
    const targetEvents = (
      await targetControl.query(
        `SELECT event_id::text,record_version,kind,target_id::text,gallery_access_revision,occurred_at
         FROM public.restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id`,
        [athlete],
      )
    ).rows;
    expect(targetEvents).toEqual(sourceEvents);
    const receipts = (
      await capture(targetControl, 'restore_gallery_album_replay_receipt', 't.athlete_id=$1', [
        athlete,
      ])
    ).map(
      (row) => parser.parse({ relation: 'restore_gallery_album_replay_receipt', row }).facts.row,
    );
    expect(
      receipts
        .map((r) => [
          Reflect.get(r, 'album_id'),
          Reflect.get(r, 'outcome'),
          Reflect.get(r, 'deleted_revision'),
        ])
        .sort(),
    ).toEqual(
      [
        [deletedAlbums[0]?.id, 'deleted', deletedAlbums[0]?.revision],
        [deletedAlbums[1]?.id, 'recorded_absent', deletedAlbums[1]?.revision],
      ].sort(),
    );
    const sourceLedger = await capture(control, 'gallery_album_deletion', 't.athlete_id=$1', [
      athlete,
    ]);
    const targetLedger = await capture(targetControl, 'gallery_album_deletion', 't.athlete_id=$1', [
      athlete,
    ]);
    for (const row of [...sourceLedger, ...targetLedger])
      parser.parse({ relation: 'gallery_album_deletion', row });
    const byAlbum = (rows: Record<string, unknown>[]) =>
      [...rows].sort((a, b) => String(a['album_id']).localeCompare(String(b['album_id'])));
    expect(byAlbum(targetLedger)).toEqual(byAlbum(sourceLedger));
  });

  it('captures every retained gallery relation through its exact codec', async () => {
    const counts: Record<string, number> = {};
    const states = new Set<string>();
    for (const relation of [
      'gallery_album',
      'gallery_media_album_membership',
      'gallery_media_course_association',
      'gallery_navigation_command_receipt',
      'gallery_album_deletion',
    ]) {
      const rows = await capture(control, relation, 't.athlete_id=$1', [athlete]);
      for (const row of rows) {
        const parsed = parser.parse({ relation, row });
        expect(parsed.kind).toBe('validated_full_restore_durable_row_v2');
        if (relation === 'gallery_navigation_command_receipt')
          states.add(`${String(row['operation'])}:${String(row['state'])}`);
        // A single changed column value is refused.
        if (relation === 'gallery_album')
          expect(() => parser.parse({ relation, row: { ...row, revision: 0 } })).toThrow();
      }
      counts[relation] = rows.length;
    }
    expect(counts).toEqual({
      gallery_album: 3,
      gallery_media_album_membership: 1,
      gallery_media_course_association: 1,
      gallery_navigation_command_receipt: 8,
      gallery_album_deletion: 2,
    });
    expect([...states].some((s) => s.endsWith(':committed'))).toBe(true);
    expect([...states].sort()).toContain('set_media_navigation:committed');
    void keptAlbum;
  });

  it('captures a genuine AI execution job and its restore_cancelled disposition', async () => {
    const s = await aiJobScenario();
    const job = await s.repository.create(s.athleteId, s.thread.id, s.command());
    const ownerQuery = async (sql: string, args: unknown[] = []) =>
      (await owner.query(sql, args)).rows[0];
    const revision = async () =>
      Number(
        (await ownerQuery('SELECT public.read_restore_processing_admission() AS c'))?.['c']?.[
          'localRevision'
        ],
      );
    await ownerQuery('SELECT public.rotate_restore_generation()');
    await ownerQuery('SELECT public.close_restore_processing_exact($1,$2)', [
      await revision(),
      randomUUID(),
    ]);
    const cancelled = await database.tenant(s.athleteId, (tx) =>
      cancelRestoredAiExecutionJobIn(tx, job.jobId),
    );
    expect(cancelled).toMatchObject({ kind: 'restore_cancelled' });
    const [jobRow] = await capture(control, 'ai_execution_job', 't.athlete_id=$1', [s.athleteId]);
    const [dispositionRow] = await capture(
      control,
      'ai_execution_job_disposition',
      't.athlete_id=$1',
      [s.athleteId],
    );
    expect(parser.parse({ relation: 'ai_execution_job', row: jobRow }).facts.row).toMatchObject({
      job_id: job.jobId,
      command_version: 1,
      purpose: 'coaching',
    });
    expect(
      parser.parse({ relation: 'ai_execution_job_disposition', row: dispositionRow }).facts.row,
    ).toMatchObject({ job_id: job.jobId, disposition: 'restore_cancelled' });
    // The codec recomputes the SQL148 frozen digests: one forged column is refused.
    for (const forged of [
      { selection_digest: 'b'.repeat(64) },
      { model_id: 'gpt-6-luna' },
      { ai_consent_revision: 2 },
      { athlete_id: randomUUID() },
    ])
      expect(() =>
        parser.parse({ relation: 'ai_execution_job', row: { ...jobRow, ...forged } }),
      ).toThrow();
  });

  it('derived/target-local profile27 relations exist but have no durable codec', async () => {
    for (const qualified of FULL_RESTORE_PROFILE27_NO_CODEC_RELATIONS) {
      const relation = qualified.split('.')[1] ?? '';
      if (qualified.startsWith('public.'))
        expect(
          (await control.query('SELECT to_regclass($1) IS NOT NULL AS present', [qualified]))
            .rows[0]?.['present'],
          qualified,
        ).toBe(true);
      expect(() => parser.parse({ relation, row: {} })).toThrow();
    }
  });
});
