import { readFile, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import assert from 'node:assert/strict';
import { identityApiPort } from './identity-api-port.js';
import { identityE2eRunId } from './identity-e2e-run.js';

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
function parseContext(value: unknown) {
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
    schemaVersion: 1,
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
export async function writeAiSettingsFixtureContext(input: { ownerUrl: string; adminUrl: string }) {
  const result = parseContext({
    schemaVersion: 1,
    runId: identityE2eRunId,
    apiPort: identityApiPort,
    harnessPid: process.pid,
    ...input,
  });
  await writeFile(aiSettingsContextPath, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
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
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size > 8192)
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_CONTEXT');
  return parseContext(JSON.parse(await readFile(aiSettingsContextPath, 'utf8')));
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
  const { adminUrl } = await readAiSettingsFixtureContext();
  const pool = new Pool({ connectionString: adminUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
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
