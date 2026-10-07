import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  nutritionPlanVersionSchema,
  saveNutritionPlanVersionRequestSchema,
} from '@workout/contracts/nutrition-core';
import { nutritionPlanVersionV2Schema } from '@workout/contracts/nutrition-race-plan-v2';
import { nutritionPlanVersionV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import type { nutritionPlanVersionCompatibleV3Schema } from '@workout/contracts/nutrition-race-plan-v3';
import { createDatabase, type Database } from '../src/database.js';
import { createRaceRepository, type RaceRepository } from '../src/races.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { captureRaceTimingPins } from '../src/race-timing-bindings.js';
import { grantNutritionCore, grantOperations, grantRaces, migrate } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Source preparation only until Root grants a focused isolated-PG execution slot.
// Public107 + appended108, plain schema owner, no trigger/RLS/admission bypass.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const databaseName = `nutrition_disconnect_${suffix}`;
const ownerRole = `nutrition_disconnect_owner_${suffix}`;
const runtimeRole = `nutrition_disconnect_app_${suffix}`;
let owner: Pool, runtime: Pool, database: Database, races: RaceRepository;
let unsupported: Awaited<ReturnType<typeof fixture>>;
function urlFor(role: string) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  url.username = role;
  url.password = 'isolated';
  return url.toString();
}
async function scoped<T>(
  pool: Pool,
  athlete: string,
  body: (client: PoolClient) => Promise<T>,
  replay = false,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query(
      replay
        ? 'SELECT pg_advisory_xact_lock(77210,1)'
        : 'SELECT pg_advisory_xact_lock_shared(77210,1)',
    );
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,77206))', [athlete]);
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const owned = <T>(athlete: string, body: (client: PoolClient) => Promise<T>, replay = false) =>
  scoped(owner, athlete, body, replay);
function version(event: string, itemId = 'Meal', legacy = false) {
  const versionId = randomUUID();
  const body = {
    planId: randomUUID(),
    versionId,
    version: 1,
    previousVersionId: null,
    approvalId: randomUUID(),
    approvedAt: '2026-10-07T00:00:00Z',
    period: { from: '2026-10-07', toInclusive: '2026-10-07' },
    timezone: 'Asia/Seoul',
    purpose: 'Synthetic approved food schedule',
    linkedTrainingPlanVersionId: null,
    items: [
      {
        id: itemId,
        planVersionId: versionId,
        category: 'before',
        title: 'Synthetic meal',
        anchor: {
          kind: 'relative',
          entity: 'race',
          entityId: event,
          point: 'start',
          offsetMinutes: -30,
        },
        foods: [
          {
            foodVersionId: null,
            description: 'Preserved food',
            quantity: 0,
            unit: 'g',
            sourceBasis: 'manual_total',
          },
        ],
        targets: [],
        instructions: '',
        evidenceIds: [],
        source: 'user_confirmed',
      },
      {
        id: 'unaffected',
        planVersionId: versionId,
        category: 'meal',
        title: 'Independent meal',
        anchor: { kind: 'absolute', date: '2026-10-07', localTime: null, timezone: 'Asia/Seoul' },
        foods: [],
        targets: [],
        instructions: 'Prepare the independent meal when ready',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  };
  return legacy
    ? nutritionPlanVersionSchema.parse(body)
    : nutritionPlanVersionV2Schema.parse({
        ...body,
        schemaVersion: 2,
        raceTimingPins: [
          {
            pinVersion: 1,
            namespace: 'race-event-revision',
            eventId: event,
            eventRevision: 1,
            sourceDigestVersion: 'race-event-values-canonical-v1',
            sourceDigest: 'a'.repeat(64),
            localDate: '2026-10-07',
            localStartTime: null,
            timezone: 'Asia/Seoul',
            start: { state: 'unknown', reason: 'start_time_not_recorded' },
            end: { state: 'unknown', reason: 'race_end_not_recorded' },
          },
        ],
        itemRaceTimingBindings: [
          { itemId, binding: { state: 'captured', eventId: event, eventRevision: 1 } },
        ],
      });
}
type Version = z.infer<typeof nutritionPlanVersionCompatibleV3Schema>;
async function insertVersion(
  client: PoolClient,
  athlete: string,
  record: Version,
  body: unknown = record,
) {
  await client.query(
    `INSERT INTO nutrition_plan_version(athlete_id,plan_id,version_id,version,previous_version_id,previous_version,period_from,period_to,linked_training_plan_version_id,approval_id,approved_at,record_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      athlete,
      record.planId,
      record.versionId,
      record.version,
      record.previousVersionId,
      record.version === 1 ? null : record.version - 1,
      record.period.from,
      record.period.toInclusive,
      record.linkedTrainingPlanVersionId,
      record.approvalId,
      record.approvedAt,
      JSON.stringify(body),
    ],
  );
}
async function fixture(itemId = 'Meal', legacy = false, unknownCopy = false) {
  const athlete = randomUUID();
  await owner.query(
    "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
    [athlete, randomUUID()],
  );
  await owned(athlete, (client) =>
    client.query("INSERT INTO consent(athlete_id,kind,granted,revision) VALUES($1,'app',true,1)", [
      athlete,
    ]),
  );
  const event = await races.createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic race',
      localDate: '2026-10-07',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: null,
      planVersionId: null,
    },
  });
  const base = version(event.id, itemId, legacy);
  const record = legacy
    ? base
    : nutritionPlanVersionV2Schema.parse({
        ...base,
        raceTimingPins: await database.tenant(athlete, (tx) =>
          captureRaceTimingPins(tx, [
            { namespace: 'race-event', eventId: event.id, revision: event.revision },
          ]),
        ),
      });
  const request = {
    operation: 'nutrition_plan_save',
    ...saveNutritionPlanVersionRequestSchema.parse({
      kind: 'create',
      idempotencyKey: randomUUID(),
      confirmed: true,
      draft: {
        period: record.period,
        timezone: record.timezone,
        purpose: record.purpose,
        linkedTrainingPlanVersionId: record.linkedTrainingPlanVersionId,
        items: record.items.map((item) => ({
          id: item.id,
          category: item.category,
          title: item.title,
          anchor: item.anchor,
          foods: item.foods,
          targets: item.targets,
          instructions: item.instructions,
          evidenceIds: item.evidenceIds,
          source: item.source,
        })),
      },
    }),
  };
  await owned(athlete, async (client) => {
    await insertVersion(
      client,
      athlete,
      record,
      unknownCopy ? { ...record, unregisteredCopy: { copiedRaceDate: '2026-10-07' } } : record,
    );
    await client.query(
      'INSERT INTO nutrition_plan_head(athlete_id,plan_id,version,version_id) VALUES($1,$2,1,$3)',
      [athlete, record.planId, record.versionId],
    );
    await client.query(
      'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
      [
        athlete,
        `nutrition-plan:${request.idempotencyKey}`,
        JSON.stringify(request),
        JSON.stringify(record),
      ],
    );
  });
  await owned(athlete, (client) =>
    client.query(
      "INSERT INTO nutrition_plan_history(athlete_id,plan_id,version_id,approval_id,action) VALUES($1,$2,$3,$4,'user_approved')",
      [athlete, record.planId, record.versionId, record.approvalId],
    ),
  );
  return { athlete, event, record, request };
}
async function readBody(athlete: string, id: string) {
  return owned(athlete, async (client) => {
    const result = await client.query(
      'SELECT record_json FROM nutrition_plan_version WHERE athlete_id=$1 AND version_id=$2',
      [athlete, id],
    );
    return nutritionPlanVersionV3Schema.parse(result.rows[0]?.record_json);
  });
}
async function remove(value: Awaited<ReturnType<typeof fixture>>) {
  return races.deleteRaceEvent(value.athlete, value.event.id, {
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
}
async function replay(value: Awaited<ReturnType<typeof fixture>>, wrongStamp = false) {
  return owned(
    value.athlete,
    async (client) => {
      const result = await client.query(
        `SELECT public.replay_race_deletion_exact(e.athlete_id,e.kind,e.target_id,e.event_id,
      e.occurred_at + CASE WHEN $3 THEN interval '1 microsecond' ELSE interval '0' END,e.race_previous_revision,e.race_deleted_revision) AS outcome
      FROM restore_suppression_event e WHERE e.athlete_id=$1 AND e.target_id=$2 AND e.record_version=4`,
        [value.athlete, value.event.id, wrongStamp],
      );
      return z.string().parse(result.rows[0]?.outcome);
    },
    true,
  );
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
  await migrate(urlFor(ownerRole), 107);
  owner = new Pool({ connectionString: urlFor(ownerRole) });
  runtime = new Pool({ connectionString: urlFor(runtimeRole) });
  await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await grantRaces(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON outbox TO "${runtimeRole}"`);
  database = createDatabase({ connectionString: urlFor(runtimeRole), max: 4 });
  races = createRaceRepository(database);
  // A genuine legacy unsupported body accepted by107, before the new INSERT guard.
  unsupported = await fixture('legacy-copy', true, true);
  await owner.query(
    await readFile(
      new URL('../migrations/108_nutrition_race_disconnection.sql', import.meta.url),
      'utf8',
    ),
  );
  await grantRaces(urlFor(ownerRole), runtimeRole);
  await grantNutritionCore(urlFor(ownerRole), runtimeRole);
  await grantOperations(urlFor(ownerRole), runtimeRole);
  await owner.query(`GRANT SELECT,INSERT ON command_receipt TO "${runtimeRole}"`);
});
afterAll(async () => {
  await database?.close();
  await runtime?.end();
  await owner?.end();
  await dropIsolatedDatabase(admin, databaseName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
describe('108 permanent nutrition/race disconnection local storage', () => {
  it('uses plain owner and FORCE RLS; runtime cannot invoke private or renamed helpers', async () => {
    const proof =
      await owner.query(`SELECT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS unsafe,
      relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owner,relforcerowsecurity AS forced FROM pg_class WHERE oid='public.nutrition_race_item_disconnection'::regclass`);
    expect(proof.rows).toEqual([{ unsafe: false, owner: true, forced: true }]);
    for (const signature of [
      'public.apply_nutrition_race_disconnection(uuid)',
      'public.delete_race_entity_before_nutrition_disconnect(text,uuid,integer)',
      'public.replay_race_deletion_exact_before_nutrition_disconnect(text,text,uuid,uuid,timestamp with time zone,integer,integer)',
      'public.erase_account_before_nutrition_disconnect(text)',
    ]) {
      const result = await owner.query(
        "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
        [runtimeRole, signature],
      );
      expect(result.rows).toEqual([{ allowed: false }]);
    }
  });
  it('redacts pin/anchor/binding atomically, preserves exact foods and independent item, and leaves intake unchanged', async () => {
    const value = await fixture();
    const unknown = <U extends 'g' | 'kcal' | 'mL' | 'mg'>(unit: U) => ({
      value: null,
      unit,
      status: 'unknown' as const,
      evidenceIds: [],
    });
    const generation = z
      .uuid()
      .parse((await owner.query('SELECT public.current_restore_generation() AS id')).rows[0]?.id);
    const intake = await createNutritionRepository(database).createIntake(value.athlete, {
      idempotencyKey: randomUUID(),
      restoreGeneration: generation,
      intakeId: randomUUID(),
      confirmed: true,
      occurredAt: '2026-10-07T00:00:00Z',
      timezone: 'UTC',
      foods: [
        {
          foodVersionId: null,
          description: 'Actual preserved food',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'manual_total',
        },
      ],
      nutrientTotal: {
        energy: unknown('kcal'),
        carbohydrate: unknown('g'),
        protein: unknown('g'),
        fat: unknown('g'),
        fluid: unknown('mL'),
        sodium: unknown('mg'),
      },
      plannedItemId: null,
      relatedSessionIds: [],
      relatedActivityIds: [],
      source: 'user',
      sourceRecordId: null,
      notes: null,
    });
    const before = await owned(value.athlete, (client) =>
      client.query('SELECT record_json FROM intake_entry_revision WHERE athlete_id=$1', [
        value.athlete,
      ]),
    );
    expect(await remove(value)).toEqual({ id: value.event.id, revision: 2 });
    const body = await readBody(value.athlete, value.record.versionId);
    expect(body.items[0]?.anchor).toEqual({ kind: 'disconnected', entity: 'race' });
    expect(body.items[0]?.foods).toEqual(value.record.items[0]?.foods);
    expect(body.items[1]).toEqual(value.record.items[1]);
    expect(body.raceTimingPins).toEqual([]);
    expect(body.itemRaceTimingBindings).toEqual([]);
    const after = await owned(value.athlete, (client) =>
      client.query('SELECT record_json FROM intake_entry_revision WHERE athlete_id=$1', [
        value.athlete,
      ]),
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]?.record_json).toEqual(intake);
  });
  it('uses fixed 32-byte key for a genuine long Korean item ID without shortening it', async () => {
    const id = '식사'.repeat(2000),
      value = await fixture(id, true);
    await remove(value);
    const rows = await owned(value.athlete, (client) =>
      client.query(
        "SELECT item_id,octet_length(item_key) AS bytes,item_key=sha256(convert_to(item_id,'UTF8')) AS exact FROM nutrition_race_item_disconnection WHERE athlete_id=$1",
        [value.athlete],
      ),
    );
    expect(rows.rows).toEqual([{ item_id: id, bytes: 32, exact: true }]);
    expect((await readBody(value.athlete, value.record.versionId)).items[0]?.id).toBe(id);
  });
  it('scrubs saved receipt into original SQL request hash and minimal committed refs', async () => {
    const value = await fixture();
    const hash = await owned(value.athlete, (client) =>
      client.query(
        "SELECT encode(sha256(convert_to(request::text,'UTF8')),'hex') AS digest FROM command_receipt WHERE athlete_id=$1",
        [value.athlete],
      ),
    );
    await remove(value);
    const rows = await owned(value.athlete, (client) =>
      client.query('SELECT request,result FROM command_receipt WHERE athlete_id=$1', [
        value.athlete,
      ]),
    );
    expect(rows.rows).toEqual([
      {
        request: {
          receiptVersion: 2,
          digestVersion: 'postgres-jsonb-sha256-v1',
          requestDigest: hash.rows[0]?.digest,
        },
        result: {
          receiptVersion: 2,
          outcome: 'committed',
          kind: 'nutrition_plan',
          planId: value.record.planId,
          versionId: value.record.versionId,
          version: 1,
          approvalId: value.record.approvalId,
        },
      },
    ]);
  });
  it('redacts historical versions without creating approvals, changing head, or duplicating marker on exact replay', async () => {
    const value = await fixture();
    const next = nutritionPlanVersionV2Schema.parse({
      ...version(value.event.id),
      planId: value.record.planId,
      version: 2,
      previousVersionId: value.record.versionId,
    });
    await owned(value.athlete, async (client) => {
      await insertVersion(client, value.athlete, next);
      await client.query(
        "INSERT INTO nutrition_plan_history(athlete_id,plan_id,version_id,approval_id,action) VALUES($1,$2,$3,$4,'user_approved')",
        [value.athlete, next.planId, next.versionId, next.approvalId],
      );
      await client.query(
        'UPDATE nutrition_plan_head SET version=2,version_id=$2 WHERE athlete_id=$1 AND plan_id=$3',
        [value.athlete, next.versionId, next.planId],
      );
    });
    await remove(value);
    const first = await readBody(value.athlete, value.record.versionId);
    await replay(value);
    await replay(value);
    expect(await readBody(value.athlete, value.record.versionId)).toEqual(first);
    expect((await readBody(value.athlete, next.versionId)).items[0]?.anchor).toEqual({
      kind: 'disconnected',
      entity: 'race',
    });
    const proof = await owned(value.athlete, (client) =>
      client.query(
        'SELECT (SELECT count(*)::int FROM nutrition_race_item_disconnection WHERE athlete_id=$1) AS markers,(SELECT version FROM nutrition_plan_head WHERE athlete_id=$1) AS head,(SELECT count(*)::int FROM nutrition_plan_history WHERE athlete_id=$1) AS history,(SELECT count(*)::int FROM restore_suppression_event WHERE athlete_id=$1 AND record_version=6) AS minted6',
        [value.athlete],
      ),
    );
    expect(proof.rows).toEqual([{ markers: 2, head: 2, history: 2, minted6: 0 }]);
  });
  it('rejects original event microsecond mismatch after a successful deletion without mutation', async () => {
    const value = await fixture();
    await remove(value);
    const before = await readBody(value.athlete, value.record.versionId);
    await expect(replay(value, true)).rejects.toThrow('RESTORE_RACE_EVENT_CONFLICT');
    expect(await readBody(value.athlete, value.record.versionId)).toEqual(before);
  });
  it('rejects reinsertion of suppressed legacy/captured references and unproven disconnected V3 records', async () => {
    const value = await fixture();
    await remove(value);
    for (const record of [
      version(value.event.id, 'fresh-legacy', true),
      version(value.event.id, 'fresh-captured'),
    ])
      await expect(
        owned(value.athlete, (client) => insertVersion(client, value.athlete, record)),
      ).rejects.toThrow('NUTRITION_SUPPRESSED_RACE_REENTRY');
    const forged = nutritionPlanVersionV3Schema.parse({
      ...(await readBody(value.athlete, value.record.versionId)),
      planId: randomUUID(),
      versionId: randomUUID(),
      approvalId: randomUUID(),
      items: [],
    });
    // Keep genuine disconnected item/version membership in a fresh envelope.
    const body = nutritionPlanVersionV3Schema.parse({
      ...forged,
      items: (await readBody(value.athlete, value.record.versionId)).items.map((item) => ({
        ...item,
        planVersionId: forged.versionId,
      })),
    });
    await expect(
      owned(value.athlete, (client) => insertVersion(client, value.athlete, body)),
    ).rejects.toThrow('NUTRITION_DISCONNECTED_RESTORE_REQUIRED');
  });
  it('forbids marker deletion/update/truncate and owner redaction of food/approval identity', async () => {
    const value = await fixture();
    await remove(value);
    for (const sql of [
      'DELETE FROM nutrition_race_item_disconnection WHERE athlete_id=$1',
      "UPDATE nutrition_race_item_disconnection SET item_id='changed' WHERE athlete_id=$1",
    ])
      await expect(
        owned(value.athlete, (client) => client.query(sql, [value.athlete])),
      ).rejects.toThrow('NUTRITION_DISCONNECTION_IMMUTABLE');
    await expect(
      owned(value.athlete, (client) => client.query('TRUNCATE nutrition_race_item_disconnection')),
    ).rejects.toThrow();
    await expect(
      owned(value.athlete, (client) =>
        client.query(
          "UPDATE nutrition_plan_version SET record_json=jsonb_set(record_json,'{purpose}',to_jsonb('changed'::text)) WHERE athlete_id=$1",
          [value.athlete],
        ),
      ),
    ).rejects.toThrow('NUTRITION_REDACTION_NOT_EXACT');
    await expect(
      owned(value.athlete, (client) =>
        client.query('UPDATE nutrition_plan_version SET approval_id=$2 WHERE athlete_id=$1', [
          value.athlete,
          randomUUID(),
        ]),
      ),
    ).rejects.toThrow('NUTRITION_REDACTION_IDENTITY_CHANGE');
  });
  it('hides another tenant marker and rejects foreign old4 event authority', async () => {
    const first = await fixture(),
      second = await fixture();
    await remove(first);
    await remove(second);
    const rows = await owned(first.athlete, (client) =>
      client.query('SELECT item_id FROM nutrition_race_item_disconnection WHERE athlete_id=$1', [
        second.athlete,
      ]),
    );
    expect(rows.rows).toEqual([]);
    const event = await owned(second.athlete, (client) =>
      client.query(
        'SELECT event_id FROM restore_suppression_event WHERE athlete_id=$1 AND record_version=4',
        [second.athlete],
      ),
    );
    const target = await fixture();
    await expect(
      owned(target.athlete, (client) =>
        client.query(
          "INSERT INTO nutrition_race_item_disconnection(athlete_id,version_id,item_key,item_id,event_id) VALUES($1,$2,sha256(convert_to('Meal','UTF8')),'Meal',$3)",
          [target.athlete, target.record.versionId, event.rows[0]?.event_id],
        ),
      ),
    ).rejects.toThrow('NUTRITION_DISCONNECTION_EVENT_REQUIRED');
  });
  it('fails closed for genuine unsupported legacy copy and rolls back source deletion/event/outbox', async () => {
    await expect(remove(unsupported)).rejects.toThrow('NUTRITION_DISCONNECT_UNSUPPORTED_BODY');
    const rows = await owned(unsupported.athlete, (client) =>
      client.query(
        'SELECT deleted,(SELECT count(*)::int FROM restore_suppression_event WHERE athlete_id=$1 AND record_version=4) AS events FROM race_event WHERE athlete_id=$1 AND id=$2',
        [unsupported.athlete, unsupported.event.id],
      ),
    );
    expect(rows.rows).toEqual([{ deleted: false, events: 0 }]);
  });
  it('rejects restored raw saved receipt while retaining the committed scrubbed receipt', async () => {
    const value = await fixture();
    await remove(value);
    await expect(
      owned(value.athlete, (client) =>
        client.query(
          'INSERT INTO command_receipt(athlete_id,idempotency_key,request,result) VALUES($1,$2,$3::jsonb,$4::jsonb)',
          [
            value.athlete,
            `nutrition-plan:${randomUUID()}`,
            JSON.stringify(value.request),
            JSON.stringify(value.record),
          ],
        ),
      ),
    ).rejects.toThrow('NUTRITION_SAVE_RECEIPT_RESTORE_REQUIRED');
    const count = await owned(value.athlete, (client) =>
      client.query('SELECT count(*)::int AS receipts FROM command_receipt WHERE athlete_id=$1', [
        value.athlete,
      ]),
    );
    expect(count.rows).toEqual([{ receipts: 1 }]);
  });
  it('keeps107 manual-review admission CLOSED rather than forging a positive copied-review fixture', async () => {
    await expect(
      owner.query('SELECT public.require_restore_processing_admission()'),
    ).rejects.toThrow('RESTORE_PROCESSING_CLOSED');
  });
  it('cleans private markers on account erase while retaining immutable original suppression history', async () => {
    const value = await fixture();
    await remove(value);
    await owned(value.athlete, (client) =>
      client.query('SELECT public.erase_account($1)', [value.athlete]),
    );
    const rows = await owned(value.athlete, (client) =>
      client.query(
        'SELECT (SELECT count(*)::int FROM nutrition_race_item_disconnection WHERE athlete_id=$1) AS markers,(SELECT count(*)::int FROM nutrition_plan_version WHERE athlete_id=$1) AS versions,(SELECT count(*)::int FROM restore_suppression_event WHERE athlete_id=$1 AND record_version=4) AS originalevents',
        [value.athlete],
      ),
    );
    expect(rows.rows).toEqual([{ markers: 0, versions: 0, originalevents: 1 }]);
  });
});
