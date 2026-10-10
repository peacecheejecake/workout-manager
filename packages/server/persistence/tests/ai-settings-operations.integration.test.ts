import { createHash, randomUUID } from 'node:crypto';
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
import {
  migrate,
  grantAiSettings,
  grantOperations,
  grantOpenAiBudgetWorker,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Actual registered104 settings/erase acceptance. Catalog is synthetic and
// unconfigured; budget liability is owner-created past accounting state, never
// a real dispatch, provider activation, invoice, usage or full restore proof.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10),
  dbName = `settings_operations_${suffix}`;
const roles = {
  owner: `settings_ops_owner_${suffix}`,
  runtime: `settings_ops_runtime_${suffix}`,
  next: `settings_ops_next_${suffix}`,
};
const admin = new Pool({ connectionString: adminUrl }),
  pools: Pool[] = [];
let owner: Pool,
  runtime: Database,
  settings: AiSettingsRepository,
  operations: OperationsRepository;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  u.username = role;
  u.password = 'isolated';
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD');
  return u.toString();
}
async function scoped<T>(id: string, action: (client: PoolClient) => Promise<T>) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const value = await action(c);
    await c.query('COMMIT');
    return value;
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
async function fixture() {
  const id = await athlete();
  const first = command(definition);
  await settings.write(id, first);
  await settings.write(id, {
    ...command(definition, 1),
    defaultSelection: null,
    syntheticComparison: { kind: 'off' },
  });
  return { id, first };
}
async function privateFacts(id: string) {
  return scoped(
    id,
    async (c) =>
      (
        await c.query(
          'SELECT (SELECT count(*)::int FROM ai_settings_head WHERE athlete_id=$1) AS heads,(SELECT count(*)::int FROM ai_settings_revision WHERE athlete_id=$1) AS revisions,(SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::int FROM tenant_erasure WHERE athlete_id=$1) AS erasures',
          [id],
        )
      ).rows[0],
  );
}
async function globalFacts() {
  return (
    await owner.query(`SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY catalog_revision) FROM ai_settings_catalog_definition r) AS catalog,
 (SELECT jsonb_agg(to_jsonb(r)) FROM ai_settings_catalog_head r) AS catalog_head,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY version) FROM openai_budget_fx_definition r) AS fx,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY version) FROM openai_budget_price_definition r) AS price,
 (SELECT jsonb_agg(to_jsonb(r)) FROM openai_budget_activation r) AS activation,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY period_key) FROM openai_budget_month r) AS months,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY sequence_id) FROM openai_budget_journal r) AS journal`)
  ).rows;
}
async function liability(id: string) {
  const reservation = randomUUID(),
    run = randomUUID();
  await scoped(id, async (c) => {
    await c.query(
      "INSERT INTO openai_budget_month(period_key) VALUES(date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date) ON CONFLICT DO NOTHING",
    );
    await c.query(
      "UPDATE openai_budget_month SET held_krw=held_krw+20,revision=revision+1 WHERE period_key=date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date",
    );
    await c.query(
      `INSERT INTO openai_budget_reservation(reservation_id,request_key,request_digest,athlete_id,run_id,subject_digest,period_key,price_version,input_bound,output_bound,reserved_krw,owner_token_digest,state,dispatch_committed_at)
 VALUES($1,$2,$3,$4,$5,$6,date_trunc('month',clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,'synthetic-settings-price-v1',1,1,20,$7,'dispatching','2026-10-01T00:00:00Z')`,
      [reservation, hash(randomUUID()), hash(randomUUID()), id, run, hash(id), hash(randomUUID())],
    );
    await c.query(
      "INSERT INTO openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) SELECT reservation_id,period_key,'reserved',20,0 FROM openai_budget_reservation WHERE reservation_id=$1",
      [reservation],
    );
    await c.query(
      "INSERT INTO openai_budget_journal(reservation_id,period_key,event_kind,held_delta,debit_delta) SELECT reservation_id,period_key,'dispatching',0,0 FROM openai_budget_reservation WHERE reservation_id=$1",
      [reservation],
    );
  });
  return reservation;
}
beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${roles.owner}"`);
  await migrate(url(roles.owner), 104);
  owner = new Pool({ connectionString: url(roles.owner), max: 6 });
  pools.push(owner);
  await grantAiSettings(url(roles.owner), roles.runtime);
  await grantOperations(url(roles.owner), roles.runtime);
  await grantOpenAiBudgetWorker(url(roles.owner), roles.runtime);
  runtime = createDatabase({ connectionString: url(roles.runtime), max: 6 });
  settings = createAiSettingsRepository(runtime);
  operations = createOperationsRepository(runtime);
  await scoped(randomUUID(), async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))");
    await c.query(
      "INSERT INTO ai_settings_catalog_definition VALUES(1,$1::jsonb,encode(sha256(convert_to(($1::jsonb)::text,'UTF8')),'hex'))",
      [JSON.stringify(definition)],
    );
    await c.query('INSERT INTO ai_settings_catalog_head VALUES(true,1)');
  });
  await owner.query(
    "INSERT INTO openai_budget_fx_definition VALUES('synthetic-settings-fx-v1',1,1,$1,true)",
    [hash('synthetic-FX-not-production-approved')],
  );
  await owner.query(
    "INSERT INTO openai_budget_price_definition VALUES('synthetic-settings-price-v1','gpt-6.1-sol','synthetic-settings-fx-v1','synthetic-tokenizer',1,1,$1,1,1,'2020-01-01','2090-01-01',false)",
    [hash('synthetic-price-no-provider-call')],
  );
}, 30000);
afterAll(async () => {
  await runtime?.close();
  for (const p of pools) await p.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('registered104 normal grants use plain roles and never grant inner erasure wrappers', async () => {
  expect(
    (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows,
  ).toEqual([{ version: 104 }]);
  expect(
    (
      await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)', [
        Object.values(roles),
      ])
    ).rows,
  ).toEqual(Array.from({ length: 3 }, () => ({ rolsuper: false, rolbypassrls: false })));
  for (const signature of [
    'public.erase_account_before_ai_settings(text)',
    'public.erase_account_before_global_budget(text)',
  ])
    expect(
      (
        await owner.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [
          roles.runtime,
          signature,
        ])
      ).rows,
    ).toEqual([{ allowed: false }]);
  const p = new Pool({ connectionString: url(roles.runtime) });
  try {
    await expect(
      p.query('SELECT public.erase_account_before_ai_settings($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      p.query('SELECT public.erase_account_before_global_budget($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await p.end();
  }
});
it('normal settings saves then104 erasure removes own head/history/receipts while preserving global catalog/budget liability', async () => {
  const f = await fixture(),
    reservation = await liability(f.id);
  expect(await privateFacts(f.id)).toEqual({ heads: 1, revisions: 2, receipts: 2, erasures: 0 });
  const before = await globalFacts();
  expect(await operations.eraseAccount(f.id)).toEqual({ erased: true });
  expect(await privateFacts(f.id)).toEqual({ heads: 0, revisions: 0, receipts: 0, erasures: 1 });
  expect(await globalFacts()).toEqual(before);
  expect(
    (
      await owner.query(
        'SELECT athlete_id,run_id,subject_digest,state,reserved_krw,debit_krw FROM openai_budget_reservation WHERE reservation_id=$1',
        [reservation],
      )
    ).rows,
  ).toEqual([
    {
      athlete_id: null,
      run_id: null,
      subject_digest: hash(f.id),
      state: 'dispatching',
      reserved_krw: 20,
      debit_krw: null,
    },
  ]);
  expect((await owner.query('SELECT enabled FROM openai_budget_activation')).rows).toEqual([
    { enabled: false },
  ]);
});
it('erased account cannot read/write/replay settings or acquire new preferences', async () => {
  const f = await fixture();
  await operations.eraseAccount(f.id);
  await expect(settings.read(f.id)).rejects.toThrow('ACCOUNT_ERASED');
  await expect(settings.catalog(f.id)).rejects.toThrow('ACCOUNT_ERASED');
  await expect(settings.write(f.id, f.first)).rejects.toThrow('ACCOUNT_ERASED');
  await expect(settings.write(f.id, command(definition))).rejects.toThrow('ACCOUNT_ERASED');
  expect(await privateFacts(f.id)).toEqual({ heads: 0, revisions: 0, receipts: 0, erasures: 1 });
});
it('foreign tenant remains unchanged by another account settings erasure', async () => {
  const first = await fixture(),
    other = await fixture();
  const saved = await settings.read(other.id);
  await operations.eraseAccount(first.id);
  expect(await settings.read(other.id)).toEqual(saved);
  expect(await privateFacts(other.id)).toEqual({
    heads: 1,
    revisions: 2,
    receipts: 2,
    erasures: 0,
  });
  await expect(
    runtime.tenant(first.id, (t) => t.query('SELECT * FROM ai_settings_head')),
  ).rejects.toThrow('ACCOUNT_ERASED');
});
it('inner budget scrub failure rolls back settings removal, receipt deletion, erasure and every accounting fact', async () => {
  const f = await fixture(),
    reservation = await liability(f.id);
  const before = await globalFacts(),
    saved = await settings.read(f.id),
    row = (
      await owner.query(
        'SELECT to_jsonb(r) AS row FROM openai_budget_reservation r WHERE reservation_id=$1',
        [reservation],
      )
    ).rows;
  await owner.query(
    'ALTER TABLE openai_budget_reservation ADD CONSTRAINT synthetic_settings_erase_failure CHECK(athlete_id IS NOT NULL) NOT VALID',
  );
  try {
    await expect(operations.eraseAccount(f.id)).rejects.toMatchObject({ code: '23514' });
    expect(await settings.read(f.id)).toEqual(saved);
    expect(await privateFacts(f.id)).toEqual({ heads: 1, revisions: 2, receipts: 2, erasures: 0 });
    expect(await globalFacts()).toEqual(before);
    expect(
      (
        await owner.query(
          'SELECT to_jsonb(r) AS row FROM openai_budget_reservation r WHERE reservation_id=$1',
          [reservation],
        )
      ).rows,
    ).toEqual(row);
  } finally {
    await owner.query(
      'ALTER TABLE openai_budget_reservation DROP CONSTRAINT synthetic_settings_erase_failure',
    );
  }
});
it('REASSIGN+existing retarget new plain liveowner erases with no refund while old owner DML is denied', async () => {
  const f = await fixture(),
    reservation = await liability(f.id),
    before = await globalFacts(),
    previous = owner;
  await admin.query(`GRANT "${roles.next}" TO "${roles.owner}"`);
  try {
    // Fixture database ownership setup is separate from the plain role's
    // application-object REASSIGN; neither role receives CREATEDB authority.
    await admin.query(`ALTER DATABASE "${dbName}" OWNER TO "${roles.next}"`);
    expect(
      (
        await admin.query(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
          [dbName],
        )
      ).rows,
    ).toEqual([{ owner: roles.next }]);
    // REASSIGN follows pg_shdepend physical order, which other suites' churn reshuffles; an object
    // (or the 078 publication) preceding its schema or the database needs next CREATE there.
    await previous.query(
      `DO $grant$ DECLARE s name; BEGIN
         FOR s IN SELECT nspname FROM pg_namespace
           WHERE nspowner='${roles.owner}'::regrole OR nspname='public'
         LOOP EXECUTE format('GRANT CREATE ON SCHEMA %I TO %I', s, '${roles.next}'); END LOOP;
         EXECUTE format('GRANT CREATE ON DATABASE %I TO %I', current_database(), '${roles.next}');
       END $grant$`,
    );
    await previous.query(`REASSIGN OWNED BY "${roles.owner}" TO "${roles.next}"`);
    await previous.query(`REVOKE CREATE ON SCHEMA public FROM "${roles.next}"`);
  } finally {
    await admin.query(`REVOKE "${roles.next}" FROM "${roles.owner}"`);
  }
  owner = new Pool({ connectionString: url(roles.next), max: 6 });
  pools.push(owner);
  expect(
    Number((await owner.query('SELECT public.retarget_definer_policies() AS n')).rows[0]?.n),
  ).toBeGreaterThan(0);
  for (const table of [
    'ai_settings_head',
    'ai_settings_revision',
    'ai_settings_catalog_definition',
    'openai_budget_reservation',
    'openai_budget_month',
  ])
    expect(
      (
        await owner.query(
          'SELECT pg_get_userbyid(relowner) AS owner,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
          [`public.${table}`],
        )
      ).rows,
    ).toEqual([{ owner: roles.next, relforcerowsecurity: true }]);
  expect(await operations.eraseAccount(f.id)).toEqual({ erased: true });
  expect(await privateFacts(f.id)).toEqual({ heads: 0, revisions: 0, receipts: 0, erasures: 1 });
  expect(await globalFacts()).toEqual(before);
  expect(
    (
      await owner.query(
        'SELECT athlete_id,run_id,state FROM openai_budget_reservation WHERE reservation_id=$1',
        [reservation],
      )
    ).rows,
  ).toEqual([{ athlete_id: null, run_id: null, state: 'dispatching' }]);
  await expect(
    previous.query('DELETE FROM ai_settings_revision WHERE athlete_id=$1', [f.id]),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    previous.query('UPDATE ai_settings_catalog_head SET catalog_revision=1'),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(previous.query('UPDATE openai_budget_month SET held_krw=0')).rejects.toMatchObject({
    code: '42501',
  });
});
it('normal103→104 upgrade revokes explicitly granted legacy erasure ACL on renamed inner function', async () => {
  const name = `settings_ops_upgrade_${suffix}`;
  await admin.query(`CREATE DATABASE "${name}" OWNER "${roles.owner}"`);
  const ownerUrl = new URL(url(roles.owner));
  ownerUrl.pathname = `/${name}`;
  const runtimeUrl = new URL(url(roles.runtime));
  runtimeUrl.pathname = `/${name}`;
  let p: Pool | null = null,
    r: Pool | null = null;
  try {
    await migrate(ownerUrl.toString(), 103);
    await grantOperations(ownerUrl.toString(), roles.runtime);
    p = new Pool({ connectionString: ownerUrl.toString() });
    expect(
      (
        await p.query(
          "SELECT has_function_privilege($1,'public.erase_account(text)','EXECUTE') AS allowed",
          [roles.runtime],
        )
      ).rows,
    ).toEqual([{ allowed: true }]);
    await migrate(ownerUrl.toString(), 104);
    expect(
      (
        await p.query(
          "SELECT has_function_privilege($1,'public.erase_account_before_ai_settings(text)','EXECUTE') AS allowed",
          [roles.runtime],
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
    expect(
      (
        await p.query(
          "SELECT count(*)::int AS n FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='public.erase_account_before_ai_settings(text)'::regprocedure AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname=$1) AND a.privilege_type='EXECUTE'",
          [roles.runtime],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    r = new Pool({ connectionString: runtimeUrl.toString() });
    await expect(
      r.query('SELECT public.erase_account_before_ai_settings($1)', [randomUUID()]),
    ).rejects.toMatchObject({ code: '42501' });
    await grantOperations(ownerUrl.toString(), roles.runtime);
    expect(
      (
        await p.query(
          "SELECT has_function_privilege($1,'public.erase_account(text)','EXECUTE') AS allowed",
          [roles.runtime],
        )
      ).rows,
    ).toEqual([{ allowed: true }]);
    expect(
      (
        await p.query(
          "SELECT has_function_privilege($1,'public.erase_account_before_ai_settings(text)','EXECUTE') AS allowed",
          [roles.runtime],
        )
      ).rows,
    ).toEqual([{ allowed: false }]);
  } finally {
    await r?.end();
    await p?.end();
    await dropIsolatedDatabase(admin, name);
  }
});
