import { readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { identityApiPort } from './identity-api-port.js';
import { identityE2eRunId } from './identity-e2e-run.js';

export interface DisposableAiSettingsPg17Proof {
  kind: 'disposable-pg17';
  runId: string;
  harnessPid: number;
  hostname: 'localhost' | '127.0.0.1';
  port: number;
  databaseName: string;
  databaseOid: number;
  ownerRoleOid: number;
  adminRole: string;
  adminRoleOid: number;
  serverVersionNum: number;
  credentialDigest: string;
  normalMigrations: { version: number; checksum: string }[];
}
function object(value: unknown, keys: string[], code: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), code);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), code);
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, maximum: number, code: string): string {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= maximum, code);
  return value;
}
function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  assert.ok(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    code,
  );
  return value;
}
export function parseDisposableAiSettingsPg17Proof(value: unknown): DisposableAiSettingsPg17Proof {
  const code = 'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_PROOF';
  const row = object(
    value,
    [
      'kind',
      'runId',
      'harnessPid',
      'hostname',
      'port',
      'databaseName',
      'databaseOid',
      'ownerRoleOid',
      'adminRole',
      'adminRoleOid',
      'serverVersionNum',
      'credentialDigest',
      'normalMigrations',
    ],
    code,
  );
  assert.equal(row['kind'], 'disposable-pg17', code);
  const hostname = row['hostname'];
  assert.ok(hostname === 'localhost' || hostname === '127.0.0.1', code);
  const runId = text(row['runId'], 64, code);
  assert.ok(/^[a-z0-9-]+$/.test(runId) && runId !== 'default', code);
  const databaseName = text(row['databaseName'], 63, code);
  assert.match(databaseName, /^workout_identity_[a-f0-9]{32}$/, code);
  const credentialDigest = text(row['credentialDigest'], 64, code);
  assert.match(credentialDigest, /^[a-f0-9]{64}$/, code);
  const migrations = row['normalMigrations'];
  assert.ok(Array.isArray(migrations) && migrations.length > 0 && migrations.length <= 128, code);
  const normalMigrations = migrations.map((value: unknown, index: number) => {
    const migration = object(value, ['version', 'checksum'], code);
    const version = integer(migration['version'], 1, 128, code);
    assert.equal(version, index + 1, code);
    const checksum = text(migration['checksum'], 64, code);
    assert.match(checksum, /^[a-f0-9]{64}$/, code);
    return { version, checksum };
  });
  return {
    kind: 'disposable-pg17',
    runId,
    hostname,
    databaseName,
    credentialDigest,
    normalMigrations,
    harnessPid: integer(row['harnessPid'], 1, Number.MAX_SAFE_INTEGER, code),
    port: integer(row['port'], 1024, 65535, code),
    databaseOid: integer(row['databaseOid'], 1, 4294967295, code),
    ownerRoleOid: integer(row['ownerRoleOid'], 1, 4294967295, code),
    adminRole: text(row['adminRole'], 63, code),
    adminRoleOid: integer(row['adminRoleOid'], 1, 4294967295, code),
    serverVersionNum: integer(row['serverVersionNum'], 170000, 179999, code),
  };
}
export function aiSettingsEphemeralCredentialDigest(password: string) {
  return createHash('sha256')
    .update('identity-disposable-pg17-credential-v1\0')
    .update(password)
    .digest('hex');
}
export function validateAiSettingsExternalUrl(
  value: unknown,
  role: 'owner' | 'admin',
  unknownProof: unknown,
): string {
  const proof = parseDisposableAiSettingsPg17Proof(unknownProof);
  assert.ok(
    typeof value === 'string' && value.length <= 2048 && value.trim() === value,
    'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_URL',
  );
  let url: URL;
  let username: string;
  let password: string;
  try {
    url = new URL(value);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_URL');
  }
  assert.ok(
    url.protocol === 'postgresql:' &&
      url.hostname === proof.hostname &&
      Number(url.port) === proof.port &&
      url.pathname === `/${proof.databaseName}` &&
      url.search === '' &&
      url.hash === '' &&
      username === (role === 'owner' ? 'workout_owner' : proof.adminRole),
    'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_URL',
  );
  if (role === 'owner') {
    assert.ok(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(password) &&
        aiSettingsEphemeralCredentialDigest(password) === proof.credentialDigest,
      'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_CREDENTIAL',
    );
  }
  return value;
}
/** Accident-prevention fixture identity only: not restore witness or approval. */
export async function verifyAiSettingsExternalDatabase(
  client: Pick<PoolClient, 'query'>,
  unknownProof: unknown,
  role: 'owner' | 'admin',
) {
  const proof = parseDisposableAiSettingsPg17Proof(unknownProof);
  const identity = await client.query(
    `SELECT d.oid::int AS database_oid,d.datdba::int AS owner_oid,
    current_database() AS database_name,current_setting('server_version_num')::integer AS server_version,
    r.oid::int AS role_oid,current_user=session_user AS direct_role,
    r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,
    (SELECT count(*)::integer FROM pg_class WHERE relnamespace='public'::regnamespace
      AND relname=ANY($1) AND relowner=$2::oid) AS owned_tables,
    (SELECT proowner::int FROM pg_proc WHERE oid='public.close_restore_processing_exact(bigint,uuid,uuid,uuid)'::regprocedure) AS close_owner
    FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`,
    [
      [
        'ai_settings_catalog_definition',
        'ai_settings_catalog_head',
        'restore_processing_admission',
      ],
      proof.ownerRoleOid,
    ],
  );
  const row = identity.rows[0];
  assert.ok(
    identity.rows.length === 1 &&
      row &&
      row.database_oid === proof.databaseOid &&
      row.owner_oid === proof.ownerRoleOid &&
      row.database_name === proof.databaseName &&
      row.server_version === proof.serverVersionNum &&
      row.direct_role === true &&
      row.role_oid === (role === 'owner' ? proof.ownerRoleOid : proof.adminRoleOid) &&
      row.owned_tables === 3 &&
      row.close_owner === proof.ownerRoleOid,
    'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_DATABASE',
  );
  if (role === 'owner')
    assert.ok(
      row.rolsuper === false &&
        row.rolbypassrls === false &&
        row.rolcreatedb === false &&
        row.rolcreaterole === false,
      'INVALID_AI_SETTINGS_FIXTURE_OWNER',
    );
  if (role === 'admin')
    assert.ok(
      row.rolsuper === true &&
        row.rolbypassrls === true &&
        row.rolcreatedb === true &&
        row.rolcreaterole === true,
      'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_ADMIN',
    );
  const migrations = await client.query(
    'SELECT version,checksum FROM public.schema_migrations ORDER BY version LIMIT 129',
  );
  assert.deepEqual(
    migrations.rows,
    proof.normalMigrations,
    'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_MIGRATIONS',
  );
}
/** External fixture provisioning requires a direct local maintenance admin.
 * These bounded catalog facts prevent role substitution; they are not proof of
 * operational restore ownership or authority for an existing database. */
export function validateAiSettingsDisposableAdminIdentity(value: unknown, expectedRole: string) {
  const code = 'INVALID_AI_SETTINGS_FIXTURE_EXTERNAL_ADMIN';
  const row = object(
    value,
    [
      'database_name',
      'role_name',
      'direct_role',
      'rolsuper',
      'rolbypassrls',
      'rolcreatedb',
      'rolcreaterole',
      'server_version',
    ],
    code,
  );
  assert.ok(
    row['database_name'] === 'postgres' &&
      row['role_name'] === expectedRole &&
      row['direct_role'] === true &&
      row['rolsuper'] === true &&
      row['rolbypassrls'] === true &&
      row['rolcreatedb'] === true &&
      row['rolcreaterole'] === true,
    code,
  );
  return integer(row['server_version'], 170000, 179999, code);
}
function localDatabaseUrl(value: string, role: string): boolean {
  try {
    if (value.length > 2048) return false;
    const url = new URL(value);
    const socket = url.searchParams.get('host');
    return (
      url.protocol === 'postgresql:' &&
      url.username === role &&
      url.password === '' &&
      url.hostname === 'localhost' &&
      url.pathname === '/workout_identity' &&
      socket !== null &&
      (socket.startsWith('/private/tmp/') || socket.startsWith(tmpdir()))
    );
  } catch {
    return false;
  }
}
export function parseAiSettingsFixtureContext(value: unknown) {
  if (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 2
  ) {
    const code = 'INVALID_AI_SETTINGS_FIXTURE_CONTEXT';
    const row = object(
      value,
      ['schemaVersion', 'runId', 'apiPort', 'harnessPid', 'ownerUrl', 'adminUrl', 'externalProof'],
      code,
    );
    const result = {
      schemaVersion: 2 as const,
      runId: text(row['runId'], 64, code),
      apiPort: integer(row['apiPort'], 1024, 65535, code),
      harnessPid: integer(row['harnessPid'], 1, Number.MAX_SAFE_INTEGER, code),
      ownerUrl: text(row['ownerUrl'], 2048, code),
      adminUrl: text(row['adminUrl'], 2048, code),
      externalProof: parseDisposableAiSettingsPg17Proof(row['externalProof']),
    };
    assert.ok(
      result.runId === identityE2eRunId &&
        result.apiPort === identityApiPort &&
        result.externalProof.runId === result.runId &&
        result.externalProof.harnessPid === result.harnessPid,
      code,
    );
    validateAiSettingsExternalUrl(result.ownerUrl, 'owner', result.externalProof);
    validateAiSettingsExternalUrl(result.adminUrl, 'admin', result.externalProof);
    return result;
  }
  assert.ok(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_AI_SETTINGS_FIXTURE_CONTEXT',
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    ['adminUrl', 'apiPort', 'harnessPid', 'ownerUrl', 'runId', 'schemaVersion'],
    'INVALID_AI_SETTINGS_FIXTURE_CONTEXT',
  );
  assert.ok(
    'schemaVersion' in value &&
      value.schemaVersion === 1 &&
      'runId' in value &&
      value.runId === identityE2eRunId &&
      'apiPort' in value &&
      value.apiPort === identityApiPort &&
      'harnessPid' in value &&
      typeof value.harnessPid === 'number' &&
      Number.isInteger(value.harnessPid) &&
      value.harnessPid > 0 &&
      'ownerUrl' in value &&
      typeof value.ownerUrl === 'string' &&
      localDatabaseUrl(value.ownerUrl, 'workout_owner') &&
      'adminUrl' in value &&
      typeof value.adminUrl === 'string' &&
      localDatabaseUrl(value.adminUrl, 'workout_admin'),
    'INVALID_AI_SETTINGS_FIXTURE_CONTEXT',
  );
  if (
    new URL(value.ownerUrl).searchParams.get('host') !==
    new URL(value.adminUrl).searchParams.get('host')
  )
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_CONTEXT');
  return {
    schemaVersion: 1 as const,
    runId: identityE2eRunId,
    apiPort: identityApiPort,
    harnessPid: value.harnessPid,
    ownerUrl: value.ownerUrl,
    adminUrl: value.adminUrl,
  };
}
export const aiSettingsContextPath = join(
  tmpdir(),
  `workout-ai-settings-e2e-${identityApiPort}-${identityE2eRunId}.json`,
);
/** Isolated identity harness only. Contains private local DB credentials; never log it. */
export async function writeAiSettingsFixtureContext(input: {
  ownerUrl: string;
  adminUrl: string;
  externalProof?: DisposableAiSettingsPg17Proof;
}) {
  const result = parseAiSettingsFixtureContext({
    schemaVersion: input.externalProof === undefined ? 1 : 2,
    runId: identityE2eRunId,
    apiPort: identityApiPort,
    harnessPid: process.pid,
    ...input,
  });
  const serialized = JSON.stringify(result);
  if (result.schemaVersion === 2 && Buffer.byteLength(serialized, 'utf8') > 16384)
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_CONTEXT');
  await writeFile(aiSettingsContextPath, serialized, { mode: 0o600, flag: 'wx' });
  const written = await lstat(aiSettingsContextPath);
  return async () => {
    const current = await lstat(aiSettingsContextPath).catch(() => null);
    // Never remove a replacement file from a different harness incarnation.
    if (current?.ino === written.ino && current.dev === written.dev)
      await rm(aiSettingsContextPath, { force: true });
  };
}
export async function readAiSettingsFixtureContext() {
  const metadata = await lstat(aiSettingsContextPath);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 16384)
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_CONTEXT');
  const result = parseAiSettingsFixtureContext(
    JSON.parse(await readFile(aiSettingsContextPath, 'utf8')),
  );
  if (result.schemaVersion === 1 && metadata.size > 8192)
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_CONTEXT');
  return result;
}
function count(value: unknown): number {
  assert.ok(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647,
    'INVALID_AI_SETTINGS_FIXTURE_FACTS',
  );
  return value;
}
function consentDigest(value: unknown): string {
  assert.ok(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    'INVALID_AI_SETTINGS_FIXTURE_FACTS',
  );
  return value;
}
/** Bounded independent SQL facts, no health text, IDs, tokens or provider payloads. */
export async function readAiSettingsFixtureFacts(athleteId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(athleteId))
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_ACCOUNT');
  const context = await readAiSettingsFixtureContext();
  const { adminUrl } = context;
  const pool = new Pool({
    connectionString: adminUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
    ...(context.schemaVersion === 2 ? { statement_timeout: 10000, query_timeout: 12000 } : {}),
  });
  try {
    if (context.schemaVersion === 2)
      await verifyAiSettingsExternalDatabase(pool, context.externalProof, 'admin');
    const result = await pool.query(
      `SELECT
      coalesce((SELECT revision FROM ai_settings_head WHERE athlete_id=$1),0)::integer AS "settingsRevision",
      (SELECT count(*)::integer FROM ai_settings_revision WHERE athlete_id=$1) AS "settingsHistoryCount",
      (SELECT count(*)::integer FROM consent WHERE athlete_id=$1) AS "consentCount",
      (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,granted,revision) ORDER BY kind),'[]'::jsonb)::text,'UTF8')),'hex') FROM consent WHERE athlete_id=$1) AS "consentStateDigest",
      (SELECT count(*)::integer FROM outbox WHERE athlete_id=$1) AS "outboxCount",
      (SELECT count(*)::integer FROM plan_snapshot WHERE athlete_id=$1) AS "planCount",
      (SELECT count(*)::integer FROM coaching_run WHERE athlete_id=$1) AS "runCount"`,
      [athleteId],
    );
    const row = result.rows[0];
    assert.ok(row && result.rows.length === 1, 'INVALID_AI_SETTINGS_FIXTURE_FACTS');
    return {
      consentStateDigest: consentDigest(row['consentStateDigest']),
      settingsRevision: count(row['settingsRevision']),
      settingsHistoryCount: count(row['settingsHistoryCount']),
      consentCount: count(row['consentCount']),
      outboxCount: count(row['outboxCount']),
      planCount: count(row['planCount']),
      runCount: count(row['runCount']),
    };
  } finally {
    await pool.end();
  }
}
