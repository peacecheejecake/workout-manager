import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
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
import {
  decodeSuppressionPgoutputRecords,
  decodeSuppressionPgoutputRecordsV7,
  peekSuppressionPgoutput,
} from '../src/restore-suppression-pgoutput.js';
import { suppressionRecordColumnNamesV7 } from '../src/restore-suppression-records-v7.js';
import { exportAuthenticatedSuppressionSegmentV7 } from '../src/restore-suppression-exporter.js';
import {
  encodeSuppressionHeadV7,
  decodeSuppressionHeadV7,
  createSuppressionReplayVerifierV7,
} from '../src/restore-suppression-replay-v7.js';
import {
  decryptReplaySegmentV7,
  type SuppressionSourceBindingV7,
} from '../src/restore-suppression-segment.js';
import type { SuppressionRemoteStore } from '../src/restore-suppression-coordinator.js';

// Actual logical WAL / normal public producer / local crypto. No external store,
// independently authenticated witness, original-v7 installer, or restore admission.
// A public new-v7 emitter is absent: existing public deletes reuse genuine old
// original events. This missing gate is NOT represented by a passing new-v7 test.
const enabled = process.env['TEST_PGOUTPUT_CONTRACT'] === '1';
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `v7_export_${suffix}`;
const ownerRole = `v7_export_owner_${suffix}`,
  runtimeRole = `v7_export_app_${suffix}`;
const slot = `wm_suppression_v7_${suffix}`;
const athlete = randomUUID();
const encryptionKey = Buffer.alloc(32, 51),
  authenticationKey = Buffer.alloc(32, 52);
const keyId = 'synthetic-v7-local-key';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let admin: Pool, control: Pool, owner: Pool, db: Database;
let created = false,
  slotCreated = false;
const createdRoles: string[] = [];
let source: SuppressionSourceBindingV7, clusterId: string, initialLsn: string;
let headBytes: Buffer,
  headVersion = 'head-0';
let mode: 'normal' | 'bad_cipher_readback' | 'head_response_lost' = 'normal';
let sequence = 0;
const objects = new Map<string, { bytes: Buffer; versionId: string }>();
const expectedOriginals = new Map<string, string>();
function endpoint(role?: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${name}`;
  if (role) {
    value.username = role;
    value.password = 'isolated';
  }
  value.searchParams.set(
    'options',
    '-c timezone=UTC -c datestyle=ISO,YMD -c statement_timeout=10000',
  );
  return value.toString();
}
const store: SuppressionRemoteStore = {
  readHead: async () => ({ bytes: Buffer.from(headBytes), versionId: headVersion }),
  putImmutableSegment: async (bytes) => {
    const segmentId = `segment-${++sequence}`,
      versionId = `immutable-${sequence}`;
    objects.set(segmentId, { bytes: Buffer.from(bytes), versionId });
    return { segmentId, versionId };
  },
  readSegment: async (id, version) => {
    const object = objects.get(id);
    if (!object || object.versionId !== version) return null;
    return {
      bytes: mode === 'bad_cipher_readback' ? Buffer.from('corrupt') : Buffer.from(object.bytes),
      versionId: object.versionId,
    };
  },
  compareAndSetHead: async (expected, bytes) => {
    if (expected !== headVersion) throw Error('SYNTHETIC_CAS_CONFLICT');
    headVersion = `head-${sequence}`;
    headBytes = Buffer.from(bytes);
    if (mode === 'head_response_lost') throw Error('SYNTHETIC_RESPONSE_LOST');
    return { versionId: headVersion };
  },
};
function publish() {
  return exportAuthenticatedSuppressionSegmentV7({
    pool: control,
    source,
    expectedClusterId: clusterId,
    encryptionKey,
    keyId,
    headAuthenticationKey: authenticationKey,
    store,
    expectedHeadVersionId: headVersion,
    expectedHeadSha256: sha(headBytes),
  });
}
async function position() {
  const r = await control.query<{ position: string }>(
    'SELECT confirmed_flush_lsn::text AS position FROM pg_replication_slots WHERE slot_name=$1',
    [slot],
  );
  return z
    .string()
    .regex(/^[0-9A-F]+\/[0-9A-F]+$/)
    .parse(r.rows[0]?.position);
}
async function originals() {
  // Bounded original ID/time metadata only, never source/health payload output.
  const r = await control.query<{ id: string; stamp: string }>(
    `SELECT event_id::text AS id,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stamp FROM restore_suppression_event WHERE athlete_id=$1 ORDER BY occurred_at,event_id LIMIT 32`,
    [athlete],
  );
  expect(r.rows.length).toBeLessThan(32);
  for (const row of r.rows) expectedOriginals.set(row.id, row.stamp);
}
const actualInstant = (value: string) => {
  const normalized = value.replace(' ', 'T').replace(/\+00$/, 'Z');
  return normalized.replace(
    /(?:\.(\d{1,6}))?Z$/,
    (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(6, '0')}Z`,
  );
};

describe
  .skipIf(!enabled)
  .sequential('V7 extended physical publisher with genuine public old originals', () => {
    beforeAll(async () => {
      admin = new Pool({ connectionString: adminUrl });
      expect((await admin.query('SHOW wal_level')).rows[0]?.['wal_level']).toBe('logical');
      for (const role of [ownerRole, runtimeRole]) {
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        createdRoles.push(role);
      }
      await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
      created = true;
      await migrate(endpoint(ownerRole), 107);
      owner = new Pool({ connectionString: endpoint(ownerRole) });
      control = new Pool({ connectionString: endpoint() });
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
        await grant(endpoint(ownerRole), runtimeRole);
      for (const signature of [
        'public.observe_manual_review_full_owned_source_bindings_v2(jsonb)',
        'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
        'public.read_manual_race_chain_receipt_v2(text,jsonb)',
        'public.read_manual_race_chain_v2(uuid)',
      ])
        await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
      db = createDatabase({ connectionString: endpoint(runtimeRole), max: 4 });
      // Identity-only prerequisite, not a source/admission/health owner fixture.
      await owner.query(
        "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
        [athlete, athlete],
      );
      const identity = await control.query<{
        database_name: string;
        database_oid: number;
        registry_fingerprint: string;
        system_identifier: string;
      }>(
        `SELECT current_database() AS database_name,(SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid,encode(sha256(convert_to((SELECT jsonb_agg(jsonb_build_object('version',version,'checksum',checksum) ORDER BY version)::text FROM schema_migrations),'UTF8')),'hex') AS registry_fingerprint,(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier`,
      );
      const row = identity.rows[0];
      if (!row) throw Error('SOURCE_IDENTITY_MISSING');
      clusterId = row.system_identifier;
      source = {
        databaseName: row.database_name,
        databaseOid: row.database_oid,
        slotName: slot,
        publication: 'workout_restore_suppression_events',
        relationProfile: 'suppression-physical-v7',
        captureId: randomUUID(),
        registryFingerprint: row.registry_fingerprint,
      };
      const createdSlot = await control.query<{ lsn: string }>(
        'SELECT lsn::text FROM pg_create_logical_replication_slot($1,$2)',
        [slot, 'pgoutput'],
      );
      slotCreated = true;
      initialLsn = z.string().parse(createdSlot.rows[0]?.lsn);
      headBytes = encodeSuppressionHeadV7(
        {
          formatVersion: 2,
          source,
          clusterId,
          fromLsn: initialLsn,
          throughLsn: initialLsn,
          previousHash: null,
          finalLocalHash: null,
          segments: [],
        },
        authenticationKey,
      );
    }, 120000);
    afterAll(async () => {
      await db?.close();
      if (slotCreated) await control.query('SELECT pg_drop_replication_slot($1)', [slot]);
      await owner?.end();
      await control?.end();
      if (created) await dropIsolatedDatabase(admin, name);
      for (const role of createdRoles.reverse()) await admin.query(`DROP ROLE "${role}"`);
      await admin?.end();
    }, 30000);
    it('keeps registry107, plain application/owner roles and exact extended46 publication roster', async () => {
      expect(
        (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
          'version'
        ],
      ).toBe(107);
      const roles = await admin.query(
        'SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)',
        [[ownerRole, runtimeRole]],
      );
      expect(roles.rows).toHaveLength(2);
      for (const row of roles.rows)
        expect(row).toMatchObject({
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
        });
      const columns = await control.query<{ name: string }>(
        `SELECT a.attname AS name FROM pg_attribute a WHERE a.attrelid='public.restore_suppression_event'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      );
      expect(columns.rows.map((r) => r.name)).toEqual(suppressionRecordColumnNamesV7());
      expect(columns.rows).toHaveLength(46);
      expect(
        (
          await control.query(
            'SELECT schemaname,tablename FROM pg_publication_tables WHERE pubname=$1',
            [source.publication],
          )
        ).rows,
      ).toEqual([{ schemaname: 'public', tablename: 'restore_suppression_event' }]);
    });
    it('creates retained chain from public producers then public race delete reuses genuine original4 and purges payload', async () => {
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
      const races = createRaceRepository(db);
      const event = await races.createRaceEvent(athlete, {
        idempotencyKey: randomUUID(),
        values: {
          title: 'Synthetic source',
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
      const intent = {
        expectedEvent: { id: event.id, revision: event.revision },
        newLocalDate: '2026-10-09',
        selection: { kind: 'keep_plan' as const },
      };
      const basis = await createRaceManualSemanticBasisV2Service(db).prepare(athlete, intent);
      if (basis.status !== 'current_dependencies_captured') throw Error('ACTUAL_BASIS_UNAVAILABLE');
      const repository = createRaceManualReviewChainV2Repository(db);
      const command = {
        schemaVersion: 2 as const,
        idempotencyKey: randomUUID(),
        intent,
        expectedBasis: basis.basis,
      };
      const stored = await repository.store(athlete, command);
      if (stored.status !== 'stored') throw Error('CHAIN_NOT_STORED');
      expect((await repository.read(athlete, stored.result.evidenceId))?.payload?.state).toBe(
        'present',
      );
      await races.deleteRaceEvent(athlete, event.id, {
        expectedRevision: event.revision,
        idempotencyKey: randomUUID(),
      });
      expect((await repository.read(athlete, stored.result.evidenceId))?.payload).toBeNull();
      expect(await repository.store(athlete, command)).toMatchObject({
        status: 'replayed',
        result: stored.result,
      });
      await originals();
      const messages = await peekSuppressionPgoutput(control, slot);
      const transactions = decodeSuppressionPgoutputRecordsV7(messages, initialLsn);
      const records = transactions.flatMap((t) => t.records);
      expect(records.map((r) => r.schemaVersion)).toEqual(expect.arrayContaining([4, 5]));
      expect(records.some((r) => r.schemaVersion === 7)).toBe(false);
      for (const record of records)
        expect(actualInstant(record.occurredAt)).toBe(expectedOriginals.get(record.eventId));
      expect(() => decodeSuppressionPgoutputRecords(messages, initialLsn)).toThrow();
      expect(await position()).toBe(initialLsn);
    });
    it('does not ACK a failed immutable ciphertext readback', async () => {
      mode = 'bad_cipher_readback';
      await expect(publish()).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
      expect(await position()).toBe(initialLsn);
      expect(headVersion).toBe('head-0');
      mode = 'normal';
    });
    it('publishes authenticated head but keeps slot unACKed when the CAS response is lost', async () => {
      mode = 'head_response_lost';
      await expect(publish()).rejects.toThrow('SUPPRESSION_EXPORT_FAILED');
      expect(await position()).toBe(initialLsn);
      const head = decodeSuppressionHeadV7(headBytes, authenticationKey);
      expect(head.segments).toHaveLength(1);
      expect(head.throughLsn).not.toBe(initialLsn);
      mode = 'normal';
    });
    it('reconciles interrupted ACK from exact prior segment then publishes genuine public withdrawal5', async () => {
      await createConsentRepository(db).setConsent(athlete, {
        kind: 'app',
        granted: false,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      });
      await originals();
      const result = await publish();
      const head = decodeSuppressionHeadV7(headBytes, authenticationKey);
      expect(head.segments).toHaveLength(2);
      expect(await position()).toBe(result.throughLsn);
      expect(head.segments[0]?.throughLsn).toBe(head.segments[1]?.fromLsn);
      expect(head.segments[0]?.localHash).toBe(head.segments[1]?.previousHash);
      for (const segment of head.segments) {
        const object = await store.readSegment(segment.segmentId, segment.versionId);
        if (!object) throw Error('IMMUTABLE_CIPHERTEXT_MISSING');
        expect(sha(object.bytes)).toBe(segment.sha256);
        const envelope = decryptReplaySegmentV7({
          bytes: object.bytes,
          key: encryptionKey,
          expectedKeyId: keyId,
        });
        for (const record of envelope.transactions.flatMap((t) => t.records))
          expect(actualInstant(record.occurredAt)).toBe(expectedOriginals.get(record.eventId));
      }
    });
    it('verifies actual local immutable chain but refuses any replay without authenticated original stage', async () => {
      const head = decodeSuppressionHeadV7(headBytes, authenticationKey);
      if (!head.finalLocalHash) throw Error('AUTHENTICATED_HEAD_MISSING');
      const verifier = createSuppressionReplayVerifierV7({
        witness: {
          source,
          clusterId,
          fromLsn: head.fromLsn,
          throughLsn: head.throughLsn,
          previousHash: head.previousHash,
          finalLocalHash: head.finalLocalHash,
          headVersionId: headVersion,
          headSha256: sha(headBytes),
        },
        encryptionKey,
        keyId,
        headAuthenticationKey: authenticationKey,
      });
      const handle = await verifier.prepareVerifiedSuppressionChainV7(store);
      expect(handle).toMatchObject({
        status: 'verified_local_chain',
        segmentCount: 2,
        authority: 'none',
        admissionAllowed: false,
        originalEventStage: 'unavailable',
      });
      const spy = vi.spyOn(control, 'query');
      try {
        expect(verifier.replayVerifiedSuppressionChainV7In(handle)).toMatchObject({
          status: 'blocked',
          reason: 'original_event_stage_unavailable',
          authority: 'none',
          admissionAllowed: false,
        });
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
