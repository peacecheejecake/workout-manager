import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsWriteV1Schema,
  type AiExecutionCatalogV1,
} from '@workout/contracts/ai-settings';
import { createDatabase, type Database } from '../src/database.js';
import { createAiSettingsRepository, type AiSettingsRepository } from '../src/ai-settings.js';
import { createOperationsRepository, type OperationsRepository } from '../src/operations.js';
import { migrate, grantAiSettings, grantOperations } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Registered104 actual SQL acceptance. Synthetic unconfigured catalog only;
// no provider, positive admission, budget activation or operational restore proof.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `settings_export_${suffix}`;
const roles = {
  owner: `settings_export_owner_${suffix}`,
  writer: `settings_export_writer_${suffix}`,
  exporter: `settings_export_reader_${suffix}`,
  outsider: `settings_export_outsider_${suffix}`,
};
const admin = new Pool({ connectionString: adminUrl });
let owner: Pool,
  readerPool: Pool,
  outside: Pool,
  writer: Database,
  reader: Database,
  settings: AiSettingsRepository,
  operations: OperationsRepository;
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  u.username = role;
  u.password = 'isolated';
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD');
  return u.toString();
}
async function scoped<T>(id: string, action: (c: PoolClient) => Promise<T>) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const r = await action(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
async function athlete() {
  const id = randomUUID();
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [id, 'https://synthetic.invalid', randomUUID()],
  );
  return id;
}
function catalog(revision: number, selectable = true): AiExecutionCatalogV1 {
  return aiExecutionCatalogV1Schema.parse({
    schemaVersion: 1,
    catalogRevision: revision,
    policyVersion: `ai-policy:${revision}`,
    disclosureVersion: `ai-recipient:${revision}`,
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
          disclosureVersion: `ai-recipient:${revision}`,
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
function command(c: AiExecutionCatalogV1, expectedRevision = 0) {
  return aiSettingsWriteV1Schema.parse({
    schemaVersion: 1,
    expectedRevision,
    idempotencyKey: `settings-${randomUUID()}`,
    catalogRevision: c.catalogRevision,
    policyVersion: c.policyVersion,
    disclosureVersion: c.disclosureVersion,
    defaultSelection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
    syntheticComparison: {
      kind: 'selected',
      selection: { providerId: 'openai', modelId: 'gpt-6-luna' },
    },
  });
}

const definition = catalog(1);
let savedId: string, foreignId: string;
async function saveTwo(id: string) {
  await settings.write(id, command(definition));
  await settings.write(id, {
    ...command(definition, 1),
    defaultSelection: null,
    syntheticComparison: { kind: 'off' },
  });
}
async function exported(id: string) {
  const artifact = await operations.exportAccount(id);
  if (artifact.schemaVersion !== 33) throw new Error('Expected current export33');
  return artifact;
}
beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${roles.owner}"`);
  await migrate(url(roles.owner), 104);
  owner = new Pool({ connectionString: url(roles.owner) });
  readerPool = new Pool({ connectionString: url(roles.exporter) });
  outside = new Pool({ connectionString: url(roles.outsider) });
  await grantAiSettings(url(roles.owner), roles.writer);
  await grantOperations(url(roles.owner), roles.exporter);
  writer = createDatabase({ connectionString: url(roles.writer) });
  reader = createDatabase({ connectionString: url(roles.exporter) });
  settings = createAiSettingsRepository(writer);
  operations = createOperationsRepository(reader);
  await scoped(randomUUID(), async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))");
    await c.query(
      "INSERT INTO ai_settings_catalog_definition VALUES(1,$1::jsonb,encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex'))",
      [JSON.stringify(definition)],
    );
    await c.query('INSERT INTO ai_settings_catalog_head VALUES(true,1)');
  });
  savedId = await athlete();
  foreignId = await athlete();
  await saveTwo(savedId);
  await settings.write(foreignId, command(definition));
}, 30000);
afterAll(async () => {
  await writer?.close();
  await reader?.close();
  await owner?.end();
  await readerPool?.end();
  await outside?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const r of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${r}"`);
  await admin.end();
});
it('normal registered104 migration and public grants use plain roles with FORCE tenant RLS', async () => {
  expect(
    (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows,
  ).toEqual([{ version: 104 }]);
  expect(
    (
      await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)', [
        Object.values(roles),
      ])
    ).rows,
  ).toEqual(Object.values(roles).map(() => ({ rolsuper: false, rolbypassrls: false })));
  expect(
    (
      await owner.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('ai_settings_head'::regclass,'ai_settings_revision'::regclass)",
      )
    ).rows,
  ).toEqual([
    { relrowsecurity: true, relforcerowsecurity: true },
    { relrowsecurity: true, relforcerowsecurity: true },
  ]);
});
it('exports two actual saved revisions and a minimal current head without command or global authority', async () => {
  const a = await exported(savedId);
  expect(a.data.aiSettingsHeads).toEqual([{ revision: 2 }]);
  expect(a.data.aiSettingsRevisions).toHaveLength(2);
  const actual = await scoped(
    savedId,
    async (c) =>
      (
        await c.query(
          'SELECT revision,updated_at,catalog_revision,policy_version,disclosure_version,default_provider_id,default_model_id,comparison_kind,comparison_provider_id,comparison_model_id FROM ai_settings_revision WHERE athlete_id=$1 ORDER BY revision',
          [savedId],
        )
      ).rows,
  );
  expect(
    a.data.aiSettingsRevisions.map((r) => ({
      ...r,
      updated_at: new Date(r.updated_at).toISOString(),
    })),
  ).toEqual(
    actual.map((r) => ({ ...r, updated_at: z.date().parse(r['updated_at']).toISOString() })),
  );
  const first = a.data.aiSettingsRevisions[0],
    second = a.data.aiSettingsRevisions[1];
  expect(first).toMatchObject({
    revision: 1,
    catalog_revision: 1,
    policy_version: 'ai-policy:1',
    disclosure_version: 'ai-recipient:1',
    default_provider_id: 'openai',
    default_model_id: 'gpt-6.1-sol',
    comparison_kind: 'selected',
    comparison_provider_id: 'openai',
    comparison_model_id: 'gpt-6-luna',
  });
  expect(second).toMatchObject({
    revision: 2,
    default_provider_id: null,
    default_model_id: null,
    comparison_kind: 'off',
    comparison_provider_id: null,
    comparison_model_id: null,
  });
  for (const r of a.data.aiSettingsRevisions)
    expect(Object.keys(r).sort()).toEqual(
      [
        'revision',
        'updated_at',
        'catalog_revision',
        'policy_version',
        'disclosure_version',
        'default_provider_id',
        'default_model_id',
        'comparison_kind',
        'comparison_provider_id',
        'comparison_model_id',
      ].sort(),
    );
  for (const forbidden of [
    'receipt_key',
    'request_digest',
    'api_key',
    'aiSettingsCatalog',
    'openaiBudgetActivation',
    'openaiBudgetMonth',
    'openaiBudgetJournal',
    'commandReceipts',
    'restoreAppReceipts',
  ])
    expect(JSON.stringify(a.data)).not.toContain(`"${forbidden}"`);
});
it('literal empty collections preserve an absent head and isolate foreign tenant rows', async () => {
  const empty = await exported(await athlete());
  expect(empty.data.aiSettingsHeads).toEqual([]);
  expect(empty.data.aiSettingsRevisions).toEqual([]);
  const foreign = await exported(foreignId);
  expect(foreign.data.aiSettingsHeads).toEqual([{ revision: 1 }]);
  expect(foreign.data.aiSettingsRevisions).toHaveLength(1);
  await reader.tenant(savedId, async (tx) => {
    expect(
      (await tx.query('SELECT revision FROM ai_settings_revision WHERE athlete_id=$1', [foreignId]))
        .rows,
    ).toEqual([]);
  });
  expect((await readerPool.query('SELECT revision FROM ai_settings_head')).rows).toEqual([]);
});
it('export grants confer neither preference writes nor private/global/PUBLIC authority', async () => {
  for (const table of ['ai_settings_head', 'ai_settings_revision'])
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE'])
      expect(
        (
          await owner.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [
            roles.exporter,
            table,
            privilege,
          ])
        ).rows,
      ).toEqual([{ allowed: false }]);
  for (const table of [
    'ai_settings_catalog_definition',
    'ai_settings_catalog_head',
    'openai_budget_activation',
    'openai_budget_month',
    'openai_budget_journal',
    'restore_app_consent_replay_receipt',
  ])
    await expect(readerPool.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({
      code: '42501',
    });
  for (const table of ['ai_settings_head', 'ai_settings_revision'])
    await expect(outside.query(`SELECT * FROM public.${table}`)).rejects.toMatchObject({
      code: '42501',
    });
});
it('app and AI withdrawal retain saved preferences and do not grant processing', async () => {
  const before = await exported(savedId);
  await scoped(savedId, async (c) => {
    await c.query("INSERT INTO consent VALUES($1,'app',true,1)", [savedId]);
    await c.query(
      "UPDATE consent SET granted=false,revision=2 WHERE athlete_id=$1 AND kind='app'",
      [savedId],
    );
    await c.query("INSERT INTO consent VALUES($1,'ai',false,1)", [savedId]);
  });
  const after = await exported(savedId);
  expect(after.data.aiSettingsHeads).toEqual(before.data.aiSettingsHeads);
  expect(after.data.aiSettingsRevisions).toEqual(before.data.aiSettingsRevisions);
  expect(
    (await owner.query('SELECT public.read_restore_processing_admission() AS state')).rows[0]?.[
      'state'
    ],
  ).toMatchObject({ state: 'CLOSED' });
});
it('source history cap rejects1001 actual revisions without truncation or a success audit', async () => {
  const id = await athlete();
  for (let revision = 0; revision < 1001; revision++)
    await settings.write(id, {
      ...command(definition, revision),
      defaultSelection: null,
      syntheticComparison: { kind: 'off' },
    });
  await expect(operations.exportAccount(id)).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  expect(
    await scoped(
      id,
      async (c) =>
        (
          await c.query(
            "SELECT count(*)::int AS count FROM operations_audit WHERE athlete_id=$1 AND action='export_requested'",
            [id],
          )
        ).rows,
    ),
  ).toEqual([{ count: 0 }]);
}, 60000);
it('SQL byte preflight rejects a large synthetic plan payload before returning a partial export', async () => {
  const id = await athlete();
  // Owner-only synthetic planned data, not an approved actual activity or provider input.
  // Explicit named app consent is solely for this fixture's storage guard.
  await scoped(id, async (c) => {
    await c.query("INSERT INTO consent VALUES($1,'app',true,1)", [id]);
    await c.query(
      "INSERT INTO plan_snapshot(athlete_id,id,version,draft) SELECT $1,gen_random_uuid(),n,jsonb_build_object('body',repeat('x',950000)) FROM generate_series(1,9) n",
      [id],
    );
  });
  await expect(operations.exportAccount(id)).rejects.toMatchObject({ code: 'EXPORT_TOO_LARGE' });
  expect(
    await scoped(
      id,
      async (c) =>
        (
          await c.query(
            "SELECT count(*)::int AS count FROM operations_audit WHERE athlete_id=$1 AND action='export_requested'",
            [id],
          )
        ).rows,
    ),
  ).toEqual([{ count: 0 }]);
});
it('removing models from the next immutable catalog preserves exact historical selection values', async () => {
  const before = await exported(savedId);
  const next = aiExecutionCatalogV1Schema.parse({ ...catalog(2, false), providers: [] });
  await scoped(savedId, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))");
    await c.query(
      "INSERT INTO ai_settings_catalog_definition VALUES(2,$1::jsonb,encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex'))",
      [JSON.stringify(next)],
    );
    await c.query('UPDATE ai_settings_catalog_head SET catalog_revision=2');
  });
  const after = await exported(savedId);
  expect(after.data.aiSettingsHeads).toEqual(before.data.aiSettingsHeads);
  expect(after.data.aiSettingsRevisions).toEqual(before.data.aiSettingsRevisions);
});
