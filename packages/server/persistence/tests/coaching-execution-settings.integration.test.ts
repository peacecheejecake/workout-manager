import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createAiSettingsRepository, type AiSettingsRepository } from '../src/ai-settings.js';
import { migrate, grantAiSettings } from '../src/migrate.js';
import { readCoachingExecutionSettingsIn } from '../src/coaching-execution-settings.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real105 data/read evidence; synthetic unconfigured catalog, no dispatch or
// consent authority. Reader intentionally permits retained immutable history.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const admin = new Pool({ connectionString: adminUrl });
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `execution_settings_${suffix}`;
const roles = {
  owner: `exec_settings_owner_${suffix}`,
  runtime: `exec_settings_runtime_${suffix}`,
  outside: `exec_settings_outside_${suffix}`,
};
function url(role: string) {
  const value = new URL(adminUrl);
  value.username = role;
  value.password = 'isolated';
  value.pathname = `/${dbName}`;
  return value.toString();
}
let owner: Pool, outside: Pool, database: Database, repository: AiSettingsRepository;
const athlete = randomUUID(),
  foreign = randomUUID();
const expected = {
  revision: 1,
  catalogRevision: 1,
  policyVersion: 'policy:1',
  disclosureVersion: 'disclosure:1',
};
function catalog(revision: number, selectable = true) {
  return {
    schemaVersion: 1,
    catalogRevision: revision,
    policyVersion: `policy:${revision}`,
    disclosureVersion: `disclosure:${revision}`,
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
          disclosureVersion: `disclosure:${revision}`,
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
        ],
      },
    ],
    recommendedDefault: null,
    recommendedSyntheticComparison: { kind: 'off' },
  };
}
async function publish(revision: number, selectable = true) {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))",
    );
    await client.query(
      "INSERT INTO ai_settings_catalog_definition VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))",
      [revision, JSON.stringify(catalog(revision, selectable))],
    );
    if (revision === 1) await client.query('INSERT INTO ai_settings_catalog_head VALUES(true,1)');
    else
      await client.query(
        'UPDATE ai_settings_catalog_head SET catalog_revision=$1 WHERE singleton=true',
        [revision],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const read = (subject = athlete, input: unknown = expected) =>
  database.tenant(subject, (tx) => readCoachingExecutionSettingsIn(tx, input));
beforeAll(async () => {
  for (const role of Object.values(roles))
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${roles.owner}"`);
  await migrate(url(roles.owner), 105);
  await grantAiSettings(url(roles.owner), roles.runtime);
  owner = new Pool({ connectionString: url(roles.owner) });
  outside = new Pool({ connectionString: url(roles.outside) });
  database = createDatabase({ connectionString: url(roles.runtime) });
  repository = createAiSettingsRepository(database);
  await publish(1);
  for (const subject of [athlete, foreign])
    await repository.write(subject, {
      schemaVersion: 1,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
      catalogRevision: 1,
      policyVersion: 'policy:1',
      disclosureVersion: 'disclosure:1',
      defaultSelection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
      syntheticComparison: { kind: 'off' },
    });
});
afterAll(async () => {
  await database?.close();
  await owner?.end();
  await outside?.end();
  await dropIsolatedDatabase(admin, dbName);
  for (const role of Object.values(roles)) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
it('normal105 plain owner/runtime and exact immutable metadata read, absence fails closed', async () => {
  expect(
    (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows,
  ).toEqual([{ version: 105 }]);
  expect(
    (
      await owner.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)', [
        Object.values(roles),
      ])
    ).rows,
  ).toEqual(Array.from({ length: 3 }, () => ({ rolsuper: false, rolbypassrls: false })));
  expect(await read()).toMatchObject({
    kind: 'read',
    admissionAllowed: false,
    saved: {
      catalogRevision: 1,
      policyVersion: 'policy:1',
      disclosureVersion: 'disclosure:1',
      settings: { revision: 1, defaultSelection: { providerId: 'openai', modelId: 'gpt-6.1-sol' } },
    },
  });
  expect(await read(randomUUID())).toEqual({
    kind: 'blocked',
    admissionAllowed: false,
    code: 'NOT_FOUND',
  });
  expect(await read(athlete, { ...expected, revision: 99 })).toMatchObject({ code: 'NOT_FOUND' });
});
it('newer preference is never substituted for requested frozen revision', async () => {
  await repository.write(athlete, {
    schemaVersion: 1,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    catalogRevision: 1,
    policyVersion: 'policy:1',
    disclosureVersion: 'disclosure:1',
    defaultSelection: null,
    syntheticComparison: { kind: 'off' },
  });
  expect(await read()).toMatchObject({
    kind: 'read',
    saved: { settings: { revision: 1, defaultSelection: { modelId: 'gpt-6.1-sol' } } },
  });
  expect(await read(athlete, { ...expected, revision: 2 })).toMatchObject({
    kind: 'read',
    saved: { settings: { revision: 2, defaultSelection: null } },
  });
});
it('foreign RLS cannot be changed by Transaction subject; PUBLIC cannot read tables', async () => {
  await database.tenant(athlete, async (tx) => {
    expect(
      (await tx.query('SELECT revision FROM ai_settings_revision WHERE athlete_id=$1', [foreign]))
        .rows,
    ).toEqual([]);
    expect(
      await readCoachingExecutionSettingsIn({ ...tx, athleteId: foreign }, expected),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });
  await expect(outside.query('SELECT * FROM ai_settings_revision')).rejects.toMatchObject({
    code: '42501',
  });
  expect(
    (
      await owner.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('ai_settings_revision','ai_settings_head')",
      )
    ).rows,
  ).toEqual(Array.from({ length: 2 }, () => ({ relrowsecurity: true, relforcerowsecurity: true })));
});
it('malformed/unknown request metadata and exact pin mismatch fail closed', async () => {
  for (const bad of [
    { ...expected, verified: true },
    { ...expected, policyVersion: 'bad whitespace' },
    { ...expected, revision: 2147483648 },
    { ...expected, catalogRevision: null },
  ])
    expect(await read(athlete, bad)).toMatchObject({ code: 'INVALID_REQUEST' });
  for (const bad of [
    { ...expected, catalogRevision: 2 },
    { ...expected, policyVersion: 'policy:2' },
    { ...expected, disclosureVersion: 'disclosure:2' },
  ])
    expect(await read(athlete, bad)).toMatchObject({ code: 'METADATA_MISMATCH' });
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query('UPDATE ai_settings_revision SET policy_version=$2 WHERE athlete_id=$1', [
        athlete,
        'bad whitespace',
      ]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});
it('current catalog revoke and denied app/AI do not destroy retained revision read', async () => {
  await publish(2, false);
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    await client.query("INSERT INTO consent VALUES($1,'app',false,1),($1,'ai',false,1)", [athlete]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  expect((await repository.catalog(athlete)).catalogRevision).toBe(2);
  expect(await read()).toMatchObject({
    kind: 'read',
    admissionAllowed: false,
    saved: { catalogRevision: 1, settings: { revision: 1 } },
  });
});
it('orphan head absence and deferred head pointing at nonexistent history fail closed without disabling guards', async () => {
  const client = await owner.connect();
  try {
    for (const statement of [
      'DELETE FROM ai_settings_head WHERE athlete_id=$1',
      'UPDATE ai_settings_head SET revision=revision+1 WHERE athlete_id=$1',
    ]) {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      await client.query(statement, [athlete]);
      expect(
        await readCoachingExecutionSettingsIn(
          { athleteId: athlete, query: (sql, values) => client.query(sql, values) },
          expected,
        ),
      ).toMatchObject({ code: 'INVALID_STORED_BASIS' });
      await client.query('ROLLBACK');
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect(await read()).toMatchObject({ kind: 'read' });
});
