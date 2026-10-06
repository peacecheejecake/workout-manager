import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsWriteV1Schema,
  type AiExecutionCatalogV1,
} from '@workout/contracts/ai-settings';
import { createDatabase, type Database } from '../src/database.js';
import { createAiSettingsRepository, type AiSettingsRepository } from '../src/ai-settings.js';
import { grantAiSettings, migrate, migrationFileNames } from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Actual PostgreSQL preference transactions only. Synthetic server-owned catalog;
// unconfigured models are selectable preferences, never provider activation/consent.
// Requires registered migration104 and its normal public grant helper. No draft SQL.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `ai_settings_${suffix}`;
const ownerRole = `ai_settings_owner_${suffix}`;
const runtimeRole = `ai_settings_runtime_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
let owner: Pool, runtime: Database, repository: AiSettingsRepository;
let catalogRevision = 0;
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  value.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD');
  return value.toString();
}
async function ownerTransaction<T>(athlete: string, action: (c: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
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
async function publish(selectable = true) {
  const next = catalog(catalogRevision + 1, selectable);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    // Publisher has no later lifecycle/tenant acquisition: global -> catalog only.
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))",
    );
    await client.query(
      `INSERT INTO ai_settings_catalog_definition(catalog_revision,definition,definition_digest)
      VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))`,
      [next.catalogRevision, JSON.stringify(next)],
    );
    if (catalogRevision === 0)
      await client.query(
        'INSERT INTO ai_settings_catalog_head(singleton,catalog_revision) VALUES(true,1)',
      );
    else
      expect(
        (
          await client.query(
            'UPDATE ai_settings_catalog_head SET catalog_revision=$1 WHERE singleton AND catalog_revision=$2',
            [next.catalogRevision, catalogRevision],
          )
        ).rowCount,
      ).toBe(1);
    await client.query('COMMIT');
    catalogRevision = next.catalogRevision;
    return next;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
async function facts(id: string) {
  return ownerTransaction(
    id,
    async (c) =>
      (
        await c.query(
          `SELECT
    (SELECT count(*)::int FROM ai_settings_revision WHERE athlete_id=$1) AS versions,
    (SELECT count(*)::int FROM ai_settings_head WHERE athlete_id=$1) AS heads,
    (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'ai-settings:write:%') AS receipts,
    (SELECT count(*)::int FROM consent WHERE athlete_id=$1) AS consents,
    (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox`,
          [id],
        )
      ).rows[0],
  );
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  owner = new Pool({ connectionString: url(ownerRole), max: 6 });
  await grantAiSettings(url(ownerRole), runtimeRole);
  runtime = createDatabase({ connectionString: url(runtimeRole), max: 6 });
  repository = createAiSettingsRepository(runtime);
}, 30000);
afterAll(async () => {
  await runtime?.close();
  await owner?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('normal migrate001..104 installs authoritative checksums with plain owner/runtime', async () => {
  const installed = (
    await owner.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
  ).rows;
  expect(installed).toHaveLength(104);
  for (const [index, file] of migrationFileNames.slice(0, 104).entries())
    expect(installed[index]).toEqual({
      version: index + 1,
      checksum: createHash('sha256')
        .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
        .digest('hex'),
    });
  expect(
    (
      await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)', [
        [ownerRole, runtimeRole],
      ])
    ).rows,
  ).toEqual([
    { rolsuper: false, rolbypassrls: false },
    { rolsuper: false, rolbypassrls: false },
  ]);
});
it('absent preference is null/off even with catalog recommendation, without consent or dispatch', async () => {
  const id = await athlete();
  const c = await publish();
  expect(await repository.catalog(id)).toEqual(c);
  expect(await repository.read(id)).toEqual({
    schemaVersion: 1,
    revision: 0,
    updatedAt: null,
    defaultSelection: null,
    syntheticComparison: { kind: 'off' },
  });
  expect(await facts(id)).toEqual({ versions: 0, heads: 0, receipts: 0, consents: 0, outbox: 0 });
});
it('explicit unconfigured Sol/Luna save commits exact preference without app/AI consent or outbox', async () => {
  const id = await athlete(),
    c = await publish();
  const input = command(c);
  const saved = await repository.write(id, input);
  expect(saved.revision).toBe(1);
  expect(saved.defaultSelection).toEqual(input.defaultSelection);
  expect(saved.syntheticComparison).toEqual(input.syntheticComparison);
  expect(await repository.read(id)).toEqual(saved);
  expect(await facts(id)).toEqual({ versions: 1, heads: 1, receipts: 1, consents: 0, outbox: 0 });
});
it('existing head same-revision commands on real separate connections have one CAS winner', async () => {
  const id = await athlete(),
    c = await publish();
  await repository.write(id, command(c));
  const left = command(c, 1),
    right = { ...command(c, 1), syntheticComparison: { kind: 'off' as const } };
  const result = await Promise.allSettled([
    repository.write(id, left),
    repository.write(id, right),
  ]);
  const winners = result.filter((r) => r.status === 'fulfilled');
  const losers = result.filter((r) => r.status === 'rejected');
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  const loser = losers[0],
    winner = winners[0];
  if (loser?.status !== 'rejected' || winner?.status !== 'fulfilled')
    throw new Error('CAS_FIXTURE_RESULT_INVALID');
  expect(loser.reason).toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await repository.read(id)).toEqual(winner.value);
  expect(winner.value.revision).toBe(2);
  expect(await facts(id)).toEqual({ versions: 2, heads: 1, receipts: 2, consents: 0, outbox: 0 });
});
it('same-key concurrent overlap yields exact original receipt with no second revision', async () => {
  const id = await athlete(),
    c = await publish(),
    input = command(c);
  const [first, second] = await Promise.all([
    repository.write(id, input),
    repository.write(id, input),
  ]);
  expect(second).toEqual(first);
  expect(await facts(id)).toEqual({ versions: 1, heads: 1, receipts: 1, consents: 0, outbox: 0 });
});
it('successful receipt replays before changed catalog/policy/disclosure and revoked choice gates', async () => {
  const id = await athlete(),
    c = await publish(),
    input = command(c);
  const original = await repository.write(id, input);
  await publish(false);
  expect(await repository.write(id, input)).toEqual(original);
  expect(await repository.read(id)).toEqual(original);
  await expect(
    repository.write(id, { ...input, idempotencyKey: randomUUID(), expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: 'STALE_CATALOG' });
  await expect(
    repository.write(id, { ...input, syntheticComparison: { kind: 'off' } }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await facts(id)).toEqual({ versions: 1, heads: 1, receipts: 1, consents: 0, outbox: 0 });
});
it('RLS hides foreign head/history/receipt and rejects direct foreign write without broad grants', async () => {
  const own = await athlete(),
    foreign = await athlete(),
    c = await publish();
  await repository.write(foreign, command(c));
  await runtime.tenant(own, async (tx) => {
    for (const table of ['ai_settings_head', 'ai_settings_revision', 'command_receipt'])
      expect(
        (await tx.query(`SELECT * FROM public.${table} WHERE athlete_id=$1`, [foreign])).rows,
      ).toEqual([]);
  });
  await expect(
    runtime.tenant(own, (tx) =>
      tx.query('INSERT INTO ai_settings_head(athlete_id,revision) VALUES($1,1)', [foreign]),
    ),
  ).rejects.toThrow();
  expect(await facts(own)).toEqual({ versions: 0, heads: 0, receipts: 0, consents: 0, outbox: 0 });
  expect((await facts(foreign))?.versions).toBe(1);
});
it('runtime cannot publish or mutate server catalog and failed statements leave head unchanged', async () => {
  const id = await athlete(),
    c = await publish();
  await expect(
    runtime.tenant(id, (tx) =>
      tx.query('UPDATE ai_settings_catalog_head SET catalog_revision=catalog_revision+1'),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    runtime.tenant(id, (tx) => tx.query('DELETE FROM ai_settings_catalog_definition')),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    runtime.tenant(id, (tx) =>
      tx.query(
        `INSERT INTO ai_settings_catalog_definition(catalog_revision,definition,definition_digest) VALUES($1,$2::jsonb,repeat('0',64))`,
        [c.catalogRevision + 1, JSON.stringify(catalog(c.catalogRevision + 1))],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  expect(await repository.catalog(id)).toEqual(c);
});
it('SQL rejects null catalog values and half-null selection pairs before any receipt/head mutation', async () => {
  const id = await athlete(),
    c = await publish();
  await repository.write(id, command(c));
  for (const field of ['schemaVersion', 'approvedScopes', 'providers']) {
    const invalid = { ...catalog(c.catalogRevision + 1), [field]: null };
    await expect(
      ownerTransaction(id, (tx) =>
        tx.query(
          `INSERT INTO ai_settings_catalog_definition(catalog_revision,definition,definition_digest)
      VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))`,
          [c.catalogRevision + 1, JSON.stringify(invalid)],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
  const preparedCatalog = catalog(c.catalogRevision + 1);
  const provider = preparedCatalog.providers[0];
  if (!provider) throw new Error('CATALOG_FIXTURE_PROVIDER_ABSENT');
  for (const invalid of [
    { ...preparedCatalog, providers: [{ ...provider, selectable: null }] },
    {
      ...preparedCatalog,
      providers: [
        { ...provider, models: provider.models.map((model) => ({ ...model, selectable: null })) },
      ],
    },
    { ...preparedCatalog, recommendedDefault: { providerId: 'openai', modelId: null } },
  ]) {
    await expect(
      ownerTransaction(id, (tx) =>
        tx.query(
          `INSERT INTO ai_settings_catalog_definition(catalog_revision,definition,definition_digest)
      VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))`,
          [preparedCatalog.catalogRevision, JSON.stringify(invalid)],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
  for (const pair of [
    {
      provider: null,
      model: 'gpt-6.1-sol',
      comparisonKind: 'off',
      comparisonProvider: null,
      comparisonModel: null,
    },
    {
      provider: null,
      model: null,
      comparisonKind: 'off',
      comparisonProvider: 'openai',
      comparisonModel: null,
    },
  ]) {
    await expect(
      ownerTransaction(id, (tx) =>
        tx.query(
          `INSERT INTO ai_settings_revision
      (athlete_id,revision,updated_at,catalog_revision,policy_version,disclosure_version,default_provider_id,default_model_id,
       comparison_kind,comparison_provider_id,comparison_model_id,receipt_key,request_digest)
      VALUES($1,2,clock_timestamp(),$2,$3,$4,$5,$6,$7,$8,$9,$10,repeat('0',64))`,
          [
            id,
            c.catalogRevision,
            c.policyVersion,
            c.disclosureVersion,
            pair.provider,
            pair.model,
            pair.comparisonKind,
            pair.comparisonProvider,
            pair.comparisonModel,
            `ai-settings:write:${createHash('sha256').update(randomUUID()).digest('hex')}`,
          ],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  }
  expect(await facts(id)).toEqual({ versions: 1, heads: 1, receipts: 1, consents: 0, outbox: 0 });
  expect(await repository.catalog(id)).toEqual(c);
});
it('all preference/catalog tables FORCE RLS and even live owner cannot mutate immutable history', async () => {
  const tables = [
    'ai_settings_catalog_definition',
    'ai_settings_catalog_head',
    'ai_settings_revision',
    'ai_settings_head',
  ];
  const rows = (
    await owner.query(
      `SELECT relname,relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) AS owner
    FROM pg_class WHERE oid=ANY($1::regclass[]) ORDER BY relname`,
      [tables.map((t) => `public.${t}`)],
    )
  ).rows;
  expect(rows).toHaveLength(4);
  for (const row of rows)
    expect(row).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
      owner: ownerRole,
    });
  const id = await athlete(),
    c = await publish();
  const saved = await repository.write(id, command(c));
  await expect(
    ownerTransaction(id, (tx) =>
      tx.query(
        'UPDATE ai_settings_catalog_definition SET definition=definition WHERE catalog_revision=$1',
        [c.catalogRevision],
      ),
    ),
  ).rejects.toThrow('AI_SETTINGS_CATALOG_IMMUTABLE');
  await expect(
    ownerTransaction(id, (tx) =>
      tx.query('UPDATE ai_settings_revision SET updated_at=updated_at WHERE athlete_id=$1', [id]),
    ),
  ).rejects.toThrow('AI_SETTINGS_REVISION_IMMUTABLE');
  expect(await repository.read(id)).toEqual(saved);
  expect(await facts(id)).toEqual({ versions: 1, heads: 1, receipts: 1, consents: 0, outbox: 0 });
});
it('a real reader shared catalog lock blocks owner publication until reader transaction commits', async () => {
  const id = await athlete(),
    previous = await publish();
  const next = catalog(previous.catalogRevision + 1);
  const publisher = await owner.connect();
  let insertion: Promise<unknown> | undefined;
  try {
    await publisher.query('BEGIN');
    await publisher.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    const pid = Number((await publisher.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await runtime.tenant(id, async (tx) => {
      await tx.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('ai-settings-catalog',77212))",
      );
      insertion = publisher.query(
        `INSERT INTO ai_settings_catalog_definition(catalog_revision,definition,definition_digest)
        VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))`,
        [next.catalogRevision, JSON.stringify(next)],
      );
      const deadline = Date.now() + 2000;
      let blocked = false;
      while (Date.now() < deadline) {
        const status = await owner.query(
          'SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',
          [pid],
        );
        if (
          status.rows[0]?.wait_event_type === 'Lock' &&
          status.rows[0]?.wait_event === 'advisory'
        ) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      expect(
        (await tx.query('SELECT catalog_revision FROM ai_settings_catalog_head')).rows,
      ).toEqual([{ catalog_revision: previous.catalogRevision }]);
    });
    await insertion;
    expect(
      (
        await publisher.query(
          'UPDATE ai_settings_catalog_head SET catalog_revision=$1 WHERE catalog_revision=$2',
          [next.catalogRevision, previous.catalogRevision],
        )
      ).rowCount,
    ).toBe(1);
    await publisher.query('COMMIT');
    catalogRevision = next.catalogRevision;
    expect(await repository.catalog(id)).toEqual(next);
  } catch (error) {
    await insertion?.catch(() => undefined);
    await publisher.query('ROLLBACK');
    throw error;
  } finally {
    publisher.release();
  }
});
it('pinned CLOSED restore target blocks new save/publication but preserves existing read and exact receipt replay', async () => {
  const id = await athlete(),
    c = await publish(),
    input = command(c);
  const original = await repository.write(id, input);
  const state = (await owner.query('SELECT read_restore_processing_admission() state')).rows[0]
    .state;
  await owner.query(
    'SELECT close_restore_processing_exact($1::bigint,$2::uuid,$3::uuid,$4::uuid)',
    [state.localRevision, randomUUID(), randomUUID(), randomUUID()],
  );
  expect(await repository.read(id)).toEqual(original);
  expect(await repository.write(id, input)).toEqual(original);
  expect(await repository.catalog(id)).toEqual(c);
  await expect(
    repository.write(id, { ...input, idempotencyKey: randomUUID(), expectedRevision: 1 }),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await expect(publish()).rejects.toThrow('AI_SETTINGS_RESTORE_TARGET_CLOSED');
  expect(await facts(id)).toEqual({ versions: 1, heads: 1, receipts: 1, consents: 0, outbox: 0 });
  expect(
    (await owner.query('SELECT read_restore_processing_admission() state')).rows[0].state,
  ).toMatchObject({ state: 'CLOSED', admissionAllowed: false });
});
