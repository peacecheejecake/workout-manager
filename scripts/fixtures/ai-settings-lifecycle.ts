import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import {
  readAiSettingsFixtureContext,
  readAiSettingsFixtureFacts,
  verifyAiSettingsExternalDatabase,
} from './ai-settings-context';

function uuid(value: unknown): string {
  assert.ok(
    typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
    'LIFECYCLE_INVALID_UUID',
  );
  return value;
}
function state(input: unknown) {
  assert.ok(
    typeof input === 'object' && input !== null && !Array.isArray(input),
    'LIFECYCLE_INVALID_STATE',
  );
  assert.deepEqual(Object.keys(input).sort(), [
    'admissionAllowed',
    'generationId',
    'localRevision',
    'state',
    'targetAttested',
    'targetIncarnation',
    'targetNonce',
  ]);
  assert.ok(
    'state' in input &&
      input.state === 'CLOSED' &&
      'admissionAllowed' in input &&
      input.admissionAllowed === false &&
      'targetAttested' in input &&
      input.targetAttested === false,
    'LIFECYCLE_INVALID_STATE',
  );
  assert.ok(
    'localRevision' in input &&
      typeof input.localRevision === 'string' &&
      /^[1-9][0-9]{0,18}$/.test(input.localRevision) &&
      BigInt(input.localRevision) <= 9223372036854775807n,
    'LIFECYCLE_INVALID_REVISION',
  );
  assert.ok(
    'generationId' in input && 'targetNonce' in input && 'targetIncarnation' in input,
    'LIFECYCLE_INVALID_STATE',
  );
  assert.equal(
    input.targetNonce === null,
    input.targetIncarnation === null,
    'LIFECYCLE_INVALID_TARGET_PAIR',
  );
  return {
    state: 'CLOSED',
    localRevision: input.localRevision,
    generationId: uuid(input.generationId),
    targetNonce: input.targetNonce === null ? null : uuid(input.targetNonce),
    targetIncarnation: input.targetIncarnation === null ? null : uuid(input.targetIncarnation),
    admissionAllowed: false,
    targetAttested: false,
  } as const;
}
function optIn() {
  assert.equal(process.env['IDENTITY_E2E_AI_SETTINGS_LIFECYCLE'], 'on', 'LIFECYCLE_NOT_OPTED_IN');
  assert.equal(
    process.env['IDENTITY_E2E_AI_SETTINGS_LIFECYCLE_SPEC_ONLY'],
    '1',
    'LIFECYCLE_NOT_ISOLATED',
  );
  assert.ok(
    process.env['IDENTITY_E2E_RUN_ID'] && process.env['IDENTITY_E2E_RUN_ID'] !== 'default',
    'LIFECYCLE_RUN_REQUIRED',
  );
  const values = ['WEB', 'MOBILE', 'API', 'OIDC', 'GARMIN'].map(
    (name) => process.env[`WORKOUT_IDENTITY_${name}_PORT`],
  );
  assert(
    values.every(
      (value) =>
        value !== undefined &&
        /^[0-9]{4,5}$/.test(value) &&
        Number(value) >= 1024 &&
        Number(value) <= 65535,
    ) && new Set(values).size === 5,
    'LIFECYCLE_DEDICATED_PORTS_REQUIRED',
  );
}
async function ownerPool() {
  optIn();
  const context = await readAiSettingsFixtureContext();
  assert.notEqual(context.harnessPid, process.pid, 'LIFECYCLE_HARNESS_REQUIRED');
  process.kill(context.harnessPid, 0); // Liveness query only; never a signal.
  const pool = new Pool({
    connectionString: context.ownerUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    ...(context.schemaVersion === 2 ? { statement_timeout: 10000, query_timeout: 12000 } : {}),
  });
  try {
    if (context.schemaVersion === 2)
      await verifyAiSettingsExternalDatabase(pool, context.externalProof, 'owner');
    return { pool, context };
  } catch (error) {
    await pool.end();
    throw error;
  }
}
/** Destructive control close on a disposable, spec-only harness. Never reopens.
 * Owner exclusive global lock first; not Database.tenant/shared-lock upgrade.
 */
export async function closeAiSettingsFixtureRestoreTarget() {
  const { pool, context } = await ownerPool();
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(77210,1)');
    if (context.schemaVersion === 2) {
      await verifyAiSettingsExternalDatabase(client, context.externalProof, 'owner');
    } else {
      const identity =
        await client.query(`SELECT current_user=session_user AND session_user='workout_owner' AND NOT rolsuper AND NOT rolbypassrls AND current_database()='workout_identity'
      AND pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.restore_processing_admission'::regclass))=session_user
      AND pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='public.close_restore_processing_exact(bigint,uuid,uuid,uuid)'::regprocedure))=session_user AS valid FROM pg_roles WHERE rolname=session_user`);
      assert.deepEqual(identity.rows, [{ valid: true }], 'LIFECYCLE_OWNER_REQUIRED');
    }
    const migrations = await client.query(
      'SELECT version,checksum FROM schema_migrations ORDER BY version',
    );
    if (context.schemaVersion === 2) {
      assert.deepEqual(
        migrations.rows,
        context.externalProof.normalMigrations,
        'LIFECYCLE_EXTERNAL_NORMAL_MIGRATIONS_REQUIRED',
      );
    } else {
      assert.deepEqual(
        migrations.rows.map((row) => row['version']),
        Array.from({ length: 105 }, (_, index) => index + 1),
        'LIFECYCLE_NORMAL105_REQUIRED',
      );
      const expectedHash = createHash('sha256')
        .update(
          await readFile(
            new URL(
              '../../packages/server/persistence/migrations/105_tenant_reconcile_bounds.sql',
              import.meta.url,
            ),
          ),
        )
        .digest('hex');
      assert.equal(migrations.rows.at(-1)?.['checksum'], expectedHash, 'LIFECYCLE_SCHEMA105_DRIFT');
    }
    const initial = state(
      (await client.query('SELECT read_restore_processing_admission() AS state')).rows[0]?.[
        'state'
      ],
    );
    assert.equal(initial.localRevision, '1', 'LIFECYCLE_TARGET_NOT_FRESH');
    assert.deepEqual(
      (
        await client.query(
          'SELECT count(*)::integer AS count FROM restore_processing_close_receipt',
        )
      ).rows,
      [{ count: 0 }],
      'LIFECYCLE_TARGET_NOT_FRESH',
    );
    assert.equal(initial.targetNonce, null, 'LIFECYCLE_TARGET_NOT_FRESH');
    assert.equal(initial.targetIncarnation, null, 'LIFECYCLE_TARGET_NOT_FRESH');
    const command = randomUUID(),
      nonce = randomUUID(),
      incarnation = randomUUID();
    const result = state(
      (
        await client.query(
          'SELECT close_restore_processing_exact($1::bigint,$2::uuid,$3::uuid,$4::uuid) AS state',
          [initial.localRevision, command, nonce, incarnation],
        )
      ).rows[0]?.['state'],
    );
    const after = state(
      (await client.query('SELECT read_restore_processing_admission() AS state')).rows[0]?.[
        'state'
      ],
    );
    assert.deepEqual(after, result, 'LIFECYCLE_CLOSE_READBACK_MISMATCH');
    assert.equal(after.localRevision, (BigInt(initial.localRevision) + 1n).toString());
    assert.equal(after.targetNonce, nonce);
    assert.equal(after.targetIncarnation, incarnation);
    assert.equal(
      after.generationId,
      (await client.query('SELECT current_restore_generation() AS generation')).rows[0]?.[
        'generation'
      ],
    );
    assert.deepEqual(
      (
        await client.query(
          'SELECT count(*)::integer AS count FROM restore_processing_close_receipt',
        )
      ).rows,
      [{ count: 1 }],
    );
    const receipt = await client.query(
      'SELECT expected_revision::text AS expected_revision,result_revision::text AS result_revision,generation_id,target_nonce,target_incarnation FROM restore_processing_close_receipt WHERE command_id=$1',
      [command],
    );
    assert.deepEqual(
      receipt.rows,
      [
        {
          expected_revision: initial.localRevision,
          result_revision: after.localRevision,
          generation_id: after.generationId,
          target_nonce: nonce,
          target_incarnation: incarnation,
        },
      ],
      'LIFECYCLE_EXACT_RECEIPT_MISMATCH',
    );
    await client.query('COMMIT');
    return {
      closed: true,
      admissionAllowed: false,
      localRevision: after.localRevision,
      closeReceiptCount: 1,
    } as const;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
/** Own aggregate counts only; no keys, request bodies, URLs or secrets returned. */
export async function readAiSettingsLifecycleFacts(athleteId: string) {
  uuid(athleteId);
  const { pool } = await ownerPool();
  try {
    const facts = await readAiSettingsFixtureFacts(athleteId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
      const count: unknown = (
        await client.query(
          "SELECT count(*)::integer AS count FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'ai-settings:write:%'",
          [athleteId],
        )
      ).rows[0]?.['count'];
      assert.ok(
        typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 2147483647,
        'LIFECYCLE_INVALID_COUNT',
      );
      await client.query('ROLLBACK');
      return { ...facts, settingsReceiptCount: count };
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await pool.end();
  }
}
