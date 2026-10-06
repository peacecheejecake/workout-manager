import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { aiExecutionCatalogV1Schema, aiSettingsV1Schema } from '@workout/contracts/ai-settings';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { createAiSettingsRepository } from '@workout/server-persistence/ai-settings';
import { createConsentRepository } from '@workout/server-persistence/repositories';
import { grantAiSettings, migrate } from '@workout/server-persistence/migrate';
import { createApi } from '../src/app.js';
import { createAiSettingsService } from '../src/ai-settings-service.js';

// Actual public repository/SQL104 through Fastify inject. Authentication is an
// explicit synthetic principal fixture, not OIDC/session persistence proof.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `ai_settings_api_${suffix}`;
const ownerRole = `settings_api_owner_${suffix}`;
const runtimeRole = `settings_api_runtime_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
let owner: Pool, database: Database;
let catalogRevision = 0;
const origin = 'https://workout.example';
const csrf = 'c'.repeat(43);
const identities = new Map<string, string>();
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  u.username = role;
  u.password = 'isolated';
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD');
  return u.toString();
}
async function account() {
  const athleteId = randomUUID(),
    token = randomUUID();
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athleteId, 'https://synthetic.invalid', randomUUID()],
  );
  identities.set(token, athleteId);
  return { athleteId, token };
}
function headers(token: string) {
  return {
    cookie: `session=${token}`,
    origin,
    'x-workout-session-id': token,
    'x-csrf-token': csrf,
  };
}
function setup(db = database) {
  return createApi({
    allowedOrigins: [origin],
    auth: {
      async authenticate({ cookie, authorization }) {
        const token = cookie?.startsWith('session=') ? cookie.slice(8) : authorization?.slice(7);
        const athleteId = token === undefined ? undefined : identities.get(token);
        if (!athleteId || !token) return null;
        return cookie === undefined
          ? { athleteId, sessionId: token, method: 'bearer' as const }
          : { athleteId, sessionId: token, csrfToken: csrf, method: 'cookie' as const };
      },
    },
    consent: createConsentRepository(db),
    aiSettings: createAiSettingsService(createAiSettingsRepository(db)),
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
}
async function publish(selectable = true) {
  const revision = catalogRevision + 1;
  const availability = { kind: 'unavailable', reasonCode: selectable ? 'unconfigured' : 'revoked' };
  const catalog = aiExecutionCatalogV1Schema.parse({
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
        availability,
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
            availability,
            purposes: ['coaching'],
          },
          {
            modelId: 'gpt-6-luna',
            displayName: 'Luna',
            selectable,
            availability,
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
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock_shared(77210,1)');
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ai-settings-catalog',77212))");
    await c.query(
      `INSERT INTO ai_settings_catalog_definition(catalog_revision,definition,definition_digest)
      VALUES($1,$2::jsonb,encode(sha256(convert_to(($2::jsonb)::text,'UTF8')),'hex'))`,
      [revision, JSON.stringify(catalog)],
    );
    if (catalogRevision === 0) await c.query('INSERT INTO ai_settings_catalog_head VALUES(true,1)');
    else
      expect(
        (
          await c.query(
            'UPDATE ai_settings_catalog_head SET catalog_revision=$1 WHERE catalog_revision=$2',
            [revision, catalogRevision],
          )
        ).rowCount,
      ).toBe(1);
    await c.query('COMMIT');
    catalogRevision = revision;
    return catalog;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
function body(c: Awaited<ReturnType<typeof publish>>, expectedRevision = 0) {
  return {
    schemaVersion: 1,
    expectedRevision,
    catalogRevision: c.catalogRevision,
    policyVersion: c.policyVersion,
    disclosureVersion: c.disclosureVersion,
    defaultSelection: { providerId: 'openai', modelId: 'gpt-6.1-sol' },
    syntheticComparison: {
      kind: 'selected',
      selection: { providerId: 'openai', modelId: 'gpt-6-luna' },
    },
  };
}
async function facts(id: string) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [id]);
    const r = await c.query(
      `SELECT
      (SELECT count(*)::int FROM ai_settings_revision WHERE athlete_id=$1) versions,
      (SELECT count(*)::int FROM ai_settings_head WHERE athlete_id=$1) heads,
      (SELECT count(*)::int FROM command_receipt WHERE athlete_id=$1) receipts,
      (SELECT count(*)::int FROM consent WHERE athlete_id=$1) consents,
      (SELECT count(*)::int FROM outbox WHERE athlete_id=$1) outbox`,
      [id],
    );
    await c.query('COMMIT');
    return r.rows[0];
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await migrate(url(ownerRole));
  await grantAiSettings(url(ownerRole), runtimeRole);
  owner = new Pool({ connectionString: url(ownerRole) });
  database = createDatabase({ connectionString: url(runtimeRole), max: 6 });
}, 30000);
afterAll(async () => {
  await database?.close();
  await owner?.end();
  // Own synthetic database only; all API apps have closed before this hook.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (
      Number(
        (
          await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1', [
            dbName,
          ])
        ).rows[0].n,
      ) === 0
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  for (const role of [runtimeRole, ownerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  await admin.end();
});
it('authenticated cookie GET/PUT inherits auth, session and CSRF checks before storage', async () => {
  const { athleteId, token } = await account(),
    c = await publish(),
    app = setup();
  try {
    expect((await app.inject({ url: '/bff/v1/ai-settings' })).statusCode).toBe(401);
    for (const override of [{ 'x-csrf-token': '' }, { origin: 'https://foreign.invalid' }]) {
      const response = await app.inject({
        method: 'PUT',
        url: '/bff/v1/ai-settings',
        headers: { ...headers(token), ...override, 'idempotency-key': randomUUID() },
        payload: body(c),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CSRF_REJECTED');
    }
    expect(
      (
        await app.inject({
          url: '/bff/v1/ai-settings',
          headers: { ...headers(token), 'x-workout-session-id': 'stale' },
        })
      ).statusCode,
    ).toBe(409);
    expect(await facts(athleteId)).toEqual({
      versions: 0,
      heads: 0,
      receipts: 0,
      consents: 0,
      outbox: 0,
    });
  } finally {
    await app.close();
  }
});
it('real committed account preference reloads with no-store and another principal stays absent', async () => {
  const first = await account(),
    second = await account(),
    c = await publish(),
    app = setup();
  try {
    const catalog = await app.inject({
      url: '/bff/v1/ai-settings/catalog',
      headers: headers(first.token),
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual(c);
    expect(catalog.headers['cache-control']).toBe('no-store');
    const absent = await app.inject({ url: '/bff/v1/ai-settings', headers: headers(first.token) });
    expect(absent.json()).toEqual({
      schemaVersion: 1,
      revision: 0,
      updatedAt: null,
      defaultSelection: null,
      syntheticComparison: { kind: 'off' },
    });
    const saved = await app.inject({
      method: 'PUT',
      url: '/bff/v1/ai-settings',
      headers: { ...headers(first.token), 'idempotency-key': randomUUID() },
      payload: body(c),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers['cache-control']).toBe('no-store');
    expect(aiSettingsV1Schema.parse(saved.json()).revision).toBe(1);
    // A separate owner connection sees the committed row before a 200 is accepted.
    expect(await facts(first.athleteId)).toEqual({
      versions: 1,
      heads: 1,
      receipts: 1,
      consents: 0,
      outbox: 0,
    });
    expect(
      (await app.inject({ url: '/bff/v1/ai-settings', headers: headers(first.token) })).json(),
    ).toEqual(saved.json());
    expect(
      (
        await app.inject({
          url: '/bff/v1/ai-settings',
          headers: { authorization: `Bearer ${second.token}` },
        })
      ).json(),
    ).toEqual(absent.json());
    expect(await facts(second.athleteId)).toEqual({
      versions: 0,
      heads: 0,
      receipts: 0,
      consents: 0,
      outbox: 0,
    });
  } finally {
    await app.close();
  }
});
it('strict query/body/header separation and16KiB limit reject without database changes', async () => {
  const { athleteId, token } = await account(),
    c = await publish(),
    app = setup();
  try {
    for (const payload of [
      { ...body(c), athleteId: randomUUID() },
      { ...body(c), idempotencyKey: randomUUID() },
      { ...body(c), endpoint: 'https://arbitrary.invalid' },
    ]) {
      const r = await app.inject({
        method: 'PUT',
        url: '/bff/v1/ai-settings',
        headers: { ...headers(token), 'idempotency-key': randomUUID() },
        payload,
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('INVALID_REQUEST');
    }
    for (const key of [undefined, ' ', 'x'.repeat(201)]) {
      const r = await app.inject({
        method: 'PUT',
        url: '/bff/v1/ai-settings',
        headers: { ...headers(token), ...(key === undefined ? {} : { 'idempotency-key': key }) },
        payload: body(c),
      });
      expect(r.statusCode).toBe(400);
    }
    for (const path of ['/ai-settings?athleteId=other', '/ai-settings/catalog?provider=other'])
      expect(
        (await app.inject({ url: `/bff/v1${path}`, headers: headers(token) })).statusCode,
      ).toBe(400);
    const large = await app.inject({
      method: 'PUT',
      url: '/bff/v1/ai-settings',
      headers: { ...headers(token), 'idempotency-key': randomUUID() },
      payload: { ...body(c), padding: 'x'.repeat(16384) },
    });
    expect(large.statusCode).toBe(413);
    expect(large.json().error.code).toBe('BODY_TOO_LARGE');
    expect(await facts(athleteId)).toEqual({
      versions: 0,
      heads: 0,
      receipts: 0,
      consents: 0,
      outbox: 0,
    });
  } finally {
    await app.close();
  }
});
it('real CAS/idempotency conflicts retain stable409 codes and successful replay', async () => {
  const { athleteId, token } = await account(),
    c = await publish(),
    app = setup();
  const request = {
    method: 'PUT' as const,
    url: '/bff/v1/ai-settings',
    headers: { ...headers(token), 'idempotency-key': randomUUID() },
    payload: body(c),
  };
  try {
    const [a, b] = await Promise.all([app.inject(request), app.inject(request)]);
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    const stale = await app.inject({
      ...request,
      headers: { ...request.headers, 'idempotency-key': randomUUID() },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('REVISION_CONFLICT');
    const conflict = await app.inject({
      ...request,
      payload: { ...request.payload, syntheticComparison: { kind: 'off' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await facts(athleteId)).toEqual({
      versions: 1,
      heads: 1,
      receipts: 1,
      consents: 0,
      outbox: 0,
    });
  } finally {
    await app.close();
  }
});
it('authoritative catalog/policy/disclosure conflicts and revoked selection give stable409/422', async () => {
  const { athleteId, token } = await account(),
    previous = await publish(),
    app = setup();
  try {
    const current = await publish();
    for (const [payload, code] of [
      [body(previous), 'STALE_CATALOG'],
      [{ ...body(current), policyVersion: previous.policyVersion }, 'STALE_POLICY'],
      [{ ...body(current), disclosureVersion: previous.disclosureVersion }, 'STALE_DISCLOSURE'],
    ] as const) {
      const r = await app.inject({
        method: 'PUT',
        url: '/bff/v1/ai-settings',
        headers: { ...headers(token), 'idempotency-key': randomUUID() },
        payload,
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe(code);
    }
    const revoked = await publish(false);
    const r = await app.inject({
      method: 'PUT',
      url: '/bff/v1/ai-settings',
      headers: { ...headers(token), 'idempotency-key': randomUUID() },
      payload: body(revoked),
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('DEFAULT_NOT_SELECTABLE');
    expect(await facts(athleteId)).toEqual({
      versions: 0,
      heads: 0,
      receipts: 0,
      consents: 0,
      outbox: 0,
    });
  } finally {
    await app.close();
  }
});
it('actual transaction failure after repository writes rolls back and never sends success', async () => {
  const { athleteId, token } = await account(),
    c = await publish();
  // Explicit fault injection only: real public repository and PostgreSQL transaction;
  // fail after callback writes but before Database.tenant can COMMIT/return.
  const failing: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, async (tx) => {
        const result = await operation(tx);
        await tx.query('SELECT 1/0');
        return result;
      }),
  };
  const app = setup(failing),
    request = {
      method: 'PUT' as const,
      url: '/bff/v1/ai-settings',
      headers: { ...headers(token), 'idempotency-key': randomUUID() },
      payload: body(c),
    };
  try {
    const r = await app.inject(request);
    expect(r.statusCode).toBe(500);
    expect(r.json().error.code).toBe('INTERNAL_ERROR');
    expect(await facts(athleteId)).toEqual({
      versions: 0,
      heads: 0,
      receipts: 0,
      consents: 0,
      outbox: 0,
    });
  } finally {
    await app.close();
  }
  const normal = setup();
  try {
    expect((await normal.inject(request)).statusCode).toBe(200);
  } finally {
    await normal.close();
  }
  expect(await facts(athleteId)).toEqual({
    versions: 1,
    heads: 1,
    receipts: 1,
    consents: 0,
    outbox: 0,
  });
});
it('target-pinned104 rejects new save with sanitized503 while historical read and receipt replay persist', async () => {
  const { athleteId, token } = await account(),
    c = await publish(),
    app = setup();
  const request = {
    method: 'PUT' as const,
    url: '/bff/v1/ai-settings',
    headers: { ...headers(token), 'idempotency-key': randomUUID() },
    payload: body(c),
  };
  try {
    const saved = await app.inject(request);
    expect(saved.statusCode).toBe(200);
    const state = (await owner.query('SELECT read_restore_processing_admission() state')).rows[0]
      .state;
    await owner.query(
      'SELECT close_restore_processing_exact($1::bigint,$2::uuid,$3::uuid,$4::uuid)',
      [state.localRevision, randomUUID(), randomUUID(), randomUUID()],
    );
    const blocked = await app.inject({
      ...request,
      headers: { ...request.headers, 'idempotency-key': randomUUID() },
      payload: { ...request.payload, expectedRevision: 1 },
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().error.code).toBe('UNAVAILABLE');
    expect(JSON.stringify(blocked.json())).not.toContain('RESTORE_TARGET');
    expect((await app.inject(request)).json()).toEqual(saved.json());
    expect(
      (await app.inject({ url: '/bff/v1/ai-settings', headers: headers(token) })).json(),
    ).toEqual(saved.json());
    expect(await facts(athleteId)).toEqual({
      versions: 1,
      heads: 1,
      receipts: 1,
      consents: 0,
      outbox: 0,
    });
  } finally {
    await app.close();
  }
});
