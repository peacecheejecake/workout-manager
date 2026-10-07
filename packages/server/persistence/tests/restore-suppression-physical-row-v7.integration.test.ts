import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { migrate, grantCorePlanning, grantOperations, grantRaces } from '../src/migrate.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import {
  decodeSuppressionRecordColumnsV7,
  suppressionRecordColumnNamesV7,
} from '../src/restore-suppression-records-v7.js';
import {
  encodeRestoreSuppressionPhysicalRowV7,
  decodeRestoreSuppressionPhysicalRowV7,
} from '../src/restore-suppression-physical-row-v7.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real public originals1/4/5, SQL116 physical rows, no fabricated event INSERT.
// SQL2/3/6/7 synthetic unit inputs are codec evidence only, not authenticated event producers.
const enabled = Boolean(process.env['TEST_DATABASE_ADMIN_URL']);
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `physical_v7_${suffix}`;
const ownerRole = `physical_v7_owner_${suffix}`;
const runtimeRole = `physical_v7_app_${suffix}`;
const athlete = randomUUID();
const roles: string[] = [];
let admin: Pool, owner: Pool, db: Database;
let created = false;
function endpoint(role: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD -c statement_timeout=10000');
  return u.toString();
}
const timestamps = new Set(['occurred_at', 'course_share_audit_occurred_at']);
const names = suppressionRecordColumnNamesV7();
// Names originate only in the fixed physical codec roster, never caller input.
const boolColumns = new Set(['consent_previous_granted', 'consent_granted']);
const textColumns = names
  .map(
    (name) =>
      `${boolColumns.has(name) ? `CASE WHEN e."${name}" IS NULL THEN NULL WHEN e."${name}" THEN 't' ELSE 'f' END` : `e."${name}"::text`} AS "${name}"`,
  )
  .join(',');
const encodedFields = names
  .map(
    (name) =>
      `'${name}',${timestamps.has(name) ? `to_char(e."${name}" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` : `e."${name}"`}`,
  )
  .join(',');
const wireRow = z.record(z.string(), z.string().nullable());
async function observed() {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const rows = await c.query(
      `SELECT ${textColumns},jsonb_build_object(${encodedFields}) AS physical FROM public.restore_suppression_event e WHERE athlete_id=$1 ORDER BY occurred_at,event_id LIMIT 33`,
      [athlete],
    );
    expect(rows.rows.length).toBeLessThan(33);
    await c.query('COMMIT');
    return rows.rows.map((raw: unknown) => {
      const parsed = z.record(z.string(), z.unknown()).parse(raw);
      const { physical, ...text } = parsed;
      return { physical, text: wireRow.parse(text) };
    });
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
describe
  .skipIf(!enabled)
  .sequential('V7 reverse physical original codec / explicit116 staging', () => {
    beforeAll(async () => {
      admin = new Pool({ connectionString: adminUrl });
      for (const role of [ownerRole, runtimeRole]) {
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        roles.push(role);
      }
      await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
      created = true;
      await migrate(endpoint(ownerRole), 107);
      owner = new Pool({ connectionString: endpoint(ownerRole) });
      for (const file of [
        '108_nutrition_race_disconnection.sql',
        '109_race_result_proof_lifecycle.sql',
        '110_nutrition_disconnection_lineage.sql',
        '111_race_result_preserved_proof_updates.sql',
        '112_training_plan_aggregate_history.sql',
        '113_race_media_cleanup_source.sql',
        '114_manual_review_owned_source_bindings_v2.sql',
        '115_manual_review_full_owned_source_bindings_v2.sql',
        '116_manual_race_chain_v2.sql',
      ])
        await owner.query(
          await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
        );
      for (const grant of [grantCorePlanning, grantOperations, grantRaces])
        await grant(endpoint(ownerRole), runtimeRole);
      // Identity-only FK prerequisite, not source/admission/body authority.
      await owner.query(
        "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
        [athlete, athlete],
      );
      db = createDatabase({ connectionString: endpoint(runtimeRole), max: 2 });
      const consents = createConsentRepository(db);
      await consents.setConsent(athlete, {
        kind: 'app',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      await consents.setConsent(athlete, {
        kind: 'ai',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      await consents.setConsent(athlete, {
        kind: 'ai',
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      const races = createRaceRepository(db);
      const race = await races.createRaceEvent(athlete, {
        idempotencyKey: randomUUID(),
        values: {
          title: 'Synthetic codec original',
          localDate: '2026-10-08',
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
      await races.deleteRaceEvent(athlete, race.id, {
        expectedRevision: race.revision,
        idempotencyKey: randomUUID(),
      });
      await consents.setConsent(athlete, {
        kind: 'app',
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
    }, 120000);
    afterAll(async () => {
      await db?.close();
      await owner?.end();
      if (created) await dropIsolatedDatabase(admin, name);
      for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
      await admin?.end();
    }, 30000);
    it('retains registry107 and plain isolated owner/runtime roles with exact46 actual columns', async () => {
      expect(
        (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows,
      ).toEqual([{ version: 107 }]);
      const columns = await owner.query(
        "SELECT attname FROM pg_attribute WHERE attrelid='public.restore_suppression_event'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",
      );
      expect(columns.rows.map((row) => row['attname'])).toEqual(names);
      expect(
        (
          await owner.query(
            'SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1::text[])',
            [[ownerRole, runtimeRole]],
          )
        ).rows,
      ).toEqual(
        Array.from({ length: 2 }, () => ({
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
        })),
      );
    });
    it.each([1, 4, 5])(
      'roundtrips real public original%s independently against actual SQL UTC microsecond physical projection',
      async (version) => {
        const rows = (await observed()).filter(
          (row) => row.text['record_version'] === String(version),
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const { text, physical } of rows) {
          const original = decodeSuppressionRecordColumnsV7(new Map(Object.entries(text)));
          const encoded = encodeRestoreSuppressionPhysicalRowV7(original);
          expect(encoded).toEqual(physical);
          expect(encoded.event_id).toBe(text['event_id']);
          expect(encoded.occurred_at).toMatch(/\.\d{6}Z$/);
          expect(decodeRestoreSuppressionPhysicalRowV7(encoded)).toEqual({
            ...original,
            occurredAt: encoded.occurred_at.replace('T', ' ').replace('Z', '+00'),
          });
        }
      },
    );
    it('codec reads leave actual events, receipts and outbox unchanged after app withdrawal', async () => {
      const count = async () => {
        const c = await owner.connect();
        try {
          await c.query('BEGIN');
          await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
          const result = await c.query(
            `SELECT (SELECT count(*)::text FROM restore_suppression_event WHERE athlete_id=$1) AS events,(SELECT count(*)::text FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::text FROM outbox WHERE athlete_id=$1) AS outbox,
 (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(e) ORDER BY event_id),'[]'::jsonb)::text,'UTF8')),'hex') FROM restore_suppression_event e WHERE athlete_id=$1) AS event_hash,
 (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) ORDER BY idempotency_key),'[]'::jsonb)::text,'UTF8')),'hex') FROM command_receipt r WHERE athlete_id=$1) AS receipt_hash,
 (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb)::text,'UTF8')),'hex') FROM outbox o WHERE athlete_id=$1) AS outbox_hash`,
            [athlete],
          );
          await c.query('COMMIT');
          return result.rows;
        } finally {
          c.release();
        }
      };
      const before = await count();
      for (const row of await observed())
        encodeRestoreSuppressionPhysicalRowV7(
          decodeSuppressionRecordColumnsV7(new Map(Object.entries(row.text))),
        );
      expect(await count()).toEqual(before);
    });
  });
