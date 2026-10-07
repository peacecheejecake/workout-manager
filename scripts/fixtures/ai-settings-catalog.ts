import { Pool } from 'pg';
import assert from 'node:assert/strict';
import {
  aiExecutionCatalogV1Schema,
  type AiExecutionCatalogV1,
} from '../../packages/contracts/src/ai-settings.js';

/** Synthetic labels/allowlist only; unconfigured is not provider availability evidence. */
function catalog(revision: number, selectable: boolean): AiExecutionCatalogV1 {
  return aiExecutionCatalogV1Schema.parse({
    schemaVersion: 1,
    catalogRevision: revision,
    policyVersion: `ai-e2e-policy:${revision}`,
    disclosureVersion: `ai-e2e-recipient:${revision}`,
    approvedScopes: ['plan_summary', 'actual_summary', 'check_in', 'resource_excerpt'],
    providers: [
      {
        providerId: 'openai',
        displayName: 'OpenAI',
        selectable,
        availability: { kind: 'unavailable', reasonCode: selectable ? 'unconfigured' : 'revoked' },
        recipient: {
          recipientId: 'openai',
          displayName: 'OpenAI',
          disclosureVersion: `ai-e2e-recipient:${revision}`,
        },
        models: [
          {
            modelId: 'gpt-6.1-sol',
            displayName: 'Sol',
            selectable,
            availability: {
              kind: 'unavailable',
              reasonCode: selectable ? 'unconfigured' : 'revoked',
            },
            purposes: ['coaching'],
          },
          {
            modelId: 'gpt-6-luna',
            displayName: 'Luna',
            selectable,
            availability: {
              kind: 'unavailable',
              reasonCode: selectable ? 'unconfigured' : 'revoked',
            },
            purposes: ['synthetic_comparison'],
          },
        ],
      },
    ],
    recommendedDefault: selectable ? { providerId: 'openai', modelId: 'gpt-6.1-sol' } : null,
    recommendedSyntheticComparison: selectable
      ? { kind: 'selected', selection: { providerId: 'openai', modelId: 'gpt-6-luna' } }
      : { kind: 'off' },
  });
}
export async function publishAiSettingsFixtureCatalog(
  ownerUrl: string,
  options: { selectable: boolean; initial?: boolean },
): Promise<AiExecutionCatalogV1> {
  const url = new URL(ownerUrl);
  const socket = url.searchParams.get('host');
  if (
    url.protocol !== 'postgresql:' ||
    url.username !== 'workout_owner' ||
    url.password !== '' ||
    url.hostname !== 'localhost' ||
    url.pathname !== '/workout_identity' ||
    !socket ||
    !socket.startsWith('/') ||
    (!socket.includes('/tmp') && !socket.includes('/var/folders/'))
  )
    throw new Error('INVALID_AI_SETTINGS_FIXTURE_OWNER');
  const pool = new Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('lock_timeout','3000',true),set_config('statement_timeout','5000',true)",
    );
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))",
    );
    const role = await client.query(`SELECT current_user=session_user AND
      current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='ai_settings_catalog_definition'::regclass))
      AND NOT rolsuper AND NOT rolbypassrls AS valid FROM pg_roles WHERE rolname=current_user`);
    if (role.rows[0]?.['valid'] !== true) throw new Error('INVALID_AI_SETTINGS_FIXTURE_OWNER');
    const head = await client.query(
      'SELECT catalog_revision FROM ai_settings_catalog_head WHERE singleton',
    );
    const prior: unknown = head.rows[0]?.['catalog_revision'] ?? 0;
    assert.ok(
      head.rows.length <= 1 &&
        typeof prior === 'number' &&
        Number.isInteger(prior) &&
        prior >= 0 &&
        prior <= 2147483646,
      'INVALID_AI_SETTINGS_FIXTURE_HEAD',
    );
    if (options.initial && prior !== 0)
      throw new Error('AI_SETTINGS_FIXTURE_CATALOG_ALREADY_PRESENT');
    const next = catalog(prior + 1, options.selectable);
    await client.query(
      `INSERT INTO ai_settings_catalog_definition(catalog_revision,definition,definition_digest)
      VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))`,
      [next.catalogRevision, JSON.stringify(next)],
    );
    const result =
      prior === 0
        ? await client.query(
            'INSERT INTO ai_settings_catalog_head(singleton,catalog_revision) VALUES(true,$1)',
            [next.catalogRevision],
          )
        : await client.query(
            'UPDATE ai_settings_catalog_head SET catalog_revision=$1 WHERE singleton AND catalog_revision=$2',
            [next.catalogRevision, prior],
          );
    if (result.rowCount !== 1) throw new Error('AI_SETTINGS_FIXTURE_CATALOG_CONFLICT');
    await client.query('COMMIT');
    return next;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
export function publishInitialAiSettingsCatalog(ownerUrl: string) {
  return publishAiSettingsFixtureCatalog(ownerUrl, { selectable: true, initial: true });
}
