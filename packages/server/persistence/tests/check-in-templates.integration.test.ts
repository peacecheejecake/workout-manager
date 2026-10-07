import { createCheckInRepository } from '../src/check-ins.js';
import { createRoutineRepository } from '../src/routine-core.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createCheckInTemplateRepository } from '../src/check-in-templates.js';
import { createConsentRepository } from '../src/repositories.js';
import { createOperationsRepository } from '../src/operations.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantCheckIns,
  grantRoutineCore,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';
// Normal registered107 + explicit unregistered123. Public prompt producers only;
// actual CheckIn observations, routine linking and restore are later scopes.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
describe.each(['normal107', 'raw122'] as const)('%s + explicit123', (profile) => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
    name = `checkin_template_${suffix}`,
    ownerRole = `checkin_template_owner_${suffix}`,
    runtimeRole = `checkin_template_app_${suffix}`;
  const admin = new Pool({ connectionString: adminUrl }),
    roles: string[] = [];
  let db: Database,
    created = false;
  function url(role: string) {
    const value = new URL(adminUrl);
    value.pathname = `/${name}`;
    value.username = role;
    value.password = 'isolated';
    return value.toString();
  }
  beforeAll(async () => {
    for (const role of [ownerRole, runtimeRole]) {
      await admin.query(
        `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      roles.push(role);
    }
    await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
    created = true;
    await migrate(url(ownerRole), 107);
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      if (profile === 'raw122')
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
          '118_race_manual_atomic_approval.sql',
          '120_manual_race_multi_owned_sources.sql',
          '121_routine_versioned_occurrences.sql',
          '122_race_manual_public_receipts.sql',
        ])
          await owner.query(
            await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
          );
      await owner.query(
        await readFile(
          new URL('../migrations/123_check_in_template_versions.sql', import.meta.url),
          'utf8',
        ),
      );
      for (const signature of [
        'public.save_check_in_template_v1(jsonb)',
        'public.read_check_in_template_version_v1(uuid,uuid)',
        'public.read_check_in_template_head_v1(uuid)',
        'public.list_check_in_template_heads_v1(integer,integer)',
      ])
        await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
      expect(
        (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
          'version'
        ],
      ).toBe(107);
    } finally {
      await owner.end();
    }
    await grantCorePlanning(url(ownerRole), runtimeRole);
    await grantOperations(url(ownerRole), runtimeRole);
    await grantCheckIns(url(ownerRole), runtimeRole);
    await grantRoutineCore(url(ownerRole), runtimeRole);
    db = createDatabase({ connectionString: url(runtimeRole), max: 4 });
  });
  afterAll(async () => {
    await db?.close();
    if (created) await dropIsolatedDatabase(admin, name);
    for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
    await admin.end();
  });
  async function tenant() {
    const athlete = randomUUID(),
      owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query(
        "INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1::uuid,'https://synthetic.test',$2)",
        [athlete, athlete],
      );
    } finally {
      await owner.end();
    }
    const consent = createConsentRepository(db);
    await consent.setConsent(athlete, {
      kind: 'app',
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    return { athlete, consent };
  }
  const content = () => ({
    definitionVersion: 'checkin-v1' as const,
    source: 'user' as const,
    method: 'self_report' as const,
    title: 'Synthetic report prompts',
    instructions: null,
    fields: ['fatigue', 'discomfort', 'note'] as ('fatigue' | 'discomfort' | 'note')[],
  });
  const command = () => ({
    idempotencyKey: randomUUID(),
    templateId: randomUUID(),
    expectedVersion: 0,
    content: content(),
  });
  async function unrelatedActuals(athlete: string) {
    const checkins = createCheckInRepository(db),
      saved = await checkins.createCheckIn(athlete, {
        idempotencyKey: randomUUID(),
        values: {
          observedAt: '2026-10-06T00:00:00Z',
          timezone: 'UTC',
          fatigue: 0,
          discomfort: null,
          bodyLocation: null,
          note: null,
        },
      }),
      observation = await checkins.getCheckIn(athlete, saved.id);
    if (!observation) throw Error('PUBLIC_CHECKIN_MISSING');
    const routines = createRoutineRepository(db),
      blueprint = (
        await routines.saveBlueprint(athlete, {
          confirmed: true,
          expectedVersionId: null,
          idempotencyKey: randomUUID(),
          blueprint: {
            schemaVersion: 4,
            routineId: randomUUID(),
            versionId: randomUUID(),
            title: 'Existing unrelated checklist',
            intent: 'No duplicate actual',
            status: 'published',
            tags: [],
            estimatedDurationSeconds: null,
            createdAt: '2026-10-08T00:00:00Z',
            steps: [
              {
                id: 'step',
                title: 'Existing question',
                content: { kind: 'checklist', prompt: 'Synthetic question' },
                timing: { kind: 'ordered', afterStepId: null },
                required: true,
                choiceGroupId: null,
              },
            ],
            choiceGroups: [],
          },
        })
      ).blueprint;
    const run = await routines.startRun(athlete, {
      runId: randomUUID(),
      blueprintVersionId: blueprint.versionId,
      occurrenceId: null,
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
    return { checkins, observation, routines, run };
  }
  async function counts(athlete: string) {
    const owner = new Pool({ connectionString: url(ownerRole) });
    try {
      await owner.query('BEGIN');
      await owner.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      const rows = (
        await owner.query(
          `SELECT (SELECT count(*)::int FROM check_in_template_version WHERE athlete_id=$1) AS versions,(SELECT count(*)::int FROM check_in_template_head WHERE athlete_id=$1) AS heads,(SELECT count(*)::int FROM check_in_template_receipt WHERE athlete_id=$1) AS receipts,(SELECT count(*)::int FROM check_in WHERE athlete_id=$1) AS actuals,(SELECT count(*)::int FROM routine_run WHERE athlete_id=$1) AS runs,(SELECT count(*)::int FROM tenant_erasure t JOIN restore_suppression_event e ON e.athlete_id=t.athlete_id AND e.kind='tenant_erased' AND e.occurred_at=t.erased_at WHERE t.athlete_id=$1) AS erasure_originals,(SELECT count(*)::int FROM outbox WHERE athlete_id=$1) AS outbox`,
          [athlete],
        )
      ).rows;
      await owner.query('COMMIT');
      return rows;
    } finally {
      await owner.end();
    }
  }
  it('public prompt save preserves field order and exact immutable versions separately from current head and actual CheckIn', async () => {
    const f = await tenant(),
      repo = createCheckInTemplateRepository(db),
      input = command(),
      first = await repo.save(f.athlete, input);
    expect(first.content).toEqual(input.content);
    expect(first.version).toBe(1);
    expect(first.previousVersionId).toBeNull();
    const actual = await unrelatedActuals(f.athlete);
    const second = await repo.save(f.athlete, {
      ...input,
      idempotencyKey: randomUUID(),
      expectedVersion: 1,
      content: { ...input.content, title: 'Second prompt version' },
    });
    expect(second).toMatchObject({
      version: 2,
      previousVersion: 1,
      previousVersionId: first.versionId,
    });
    expect(
      await repo.readExact(f.athlete, first.templateId.toUpperCase(), first.versionId),
    ).toEqual(first);
    expect(await repo.readHead(f.athlete, first.templateId)).toEqual(second);
    expect(await actual.checkins.getCheckIn(f.athlete, actual.observation.id)).toEqual(
      actual.observation,
    );
    expect(await actual.routines.readRun(f.athlete, actual.run.run.id)).toEqual(actual.run);
    expect(await repo.readExact(f.athlete, randomUUID(), first.versionId)).toBeNull();
    expect((await counts(f.athlete))[0]).toMatchObject({
      versions: 2,
      heads: 1,
      receipts: 2,
      actuals: 1,
    });
  });
  it('same public request concurrently creates once and changed body conflicts without versions or outbox additions', async () => {
    const f = await tenant(),
      repo = createCheckInTemplateRepository(db),
      input = command(),
      results = await Promise.all([repo.save(f.athlete, input), repo.save(f.athlete, input)]);
    expect(results[0]).toEqual(results[1]);
    const before = await counts(f.athlete);
    await expect(
      repo.save(f.athlete, { ...input, content: { ...input.content, title: 'Changed request' } }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(await counts(f.athlete)).toEqual(before);
  });
  it('two competing successor CAS commands preserve the original and advance exactly one version', async () => {
    const f = await tenant(),
      repo = createCheckInTemplateRepository(db),
      input = command(),
      first = await repo.save(f.athlete, input);
    const outcomes = await Promise.allSettled(
      ['A', 'B'].map((title) =>
        repo.save(f.athlete, {
          ...input,
          idempotencyKey: randomUUID(),
          expectedVersion: 1,
          content: { ...input.content, title },
        }),
      ),
    );
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((x) => x.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'CHECK_IN_TEMPLATE_VERSION_CONFLICT' } });
    expect((await repo.readHead(f.athlete, first.templateId))?.version).toBe(2);
    expect(await repo.readExact(f.athlete, first.templateId, first.versionId)).toEqual(first);
    expect((await counts(f.athlete))[0]).toMatchObject({
      versions: 2,
      heads: 1,
      receipts: 2,
      actuals: 0,
    });
  });
  it('foreign exact/head/list and raw runtime SELECT remain tenant scoped; direct private DML is denied', async () => {
    const a = await tenant(),
      b = await tenant(),
      repo = createCheckInTemplateRepository(db),
      input = command(),
      saved = await repo.save(a.athlete, input);
    expect(await repo.readExact(b.athlete, saved.templateId, saved.versionId)).toBeNull();
    expect(await repo.readHead(b.athlete, saved.templateId)).toBeNull();
    expect((await repo.list(b.athlete, { limit: 100, offset: 0 })).items).toEqual([]);
    await expect(
      db.tenant(b.athlete, (tx) =>
        tx.query('SELECT version_id FROM check_in_template_version WHERE template_id=$1', [
          saved.templateId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      db.tenant(a.athlete, (tx) =>
        tx.query(
          'UPDATE check_in_template_version SET record_json=record_json WHERE template_id=$1',
          [saved.templateId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await repo.readExact(a.athlete, saved.templateId, saved.versionId)).toEqual(saved);
  });
  it('app withdrawal permits original receipt and retained reads while denying fresh save and changed-key requests', async () => {
    const f = await tenant(),
      repo = createCheckInTemplateRepository(db),
      input = command(),
      saved = await repo.save(f.athlete, input);
    await f.consent.setConsent(f.athlete, {
      kind: 'app',
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const before = await counts(f.athlete);
    expect(await repo.save(f.athlete, input)).toEqual(saved);
    expect(await repo.readExact(f.athlete, saved.templateId, saved.versionId)).toEqual(saved);
    expect(await repo.readHead(f.athlete, saved.templateId)).toEqual(saved);
    expect((await repo.list(f.athlete, { limit: 100, offset: 0 })).items).toEqual([saved]);
    await expect(
      repo.save(f.athlete, { ...input, idempotencyKey: randomUUID(), expectedVersion: 1 }),
    ).rejects.toThrow('APP_CONSENT_REQUIRED');
    expect(await counts(f.athlete)).toEqual(before);
  });
  it('bounded list offset uses actual ordered template heads without altering immutable reads', async () => {
    const f = await tenant(),
      repo = createCheckInTemplateRepository(db),
      saved = await Promise.all([
        repo.save(f.athlete, command()),
        repo.save(f.athlete, command()),
        repo.save(f.athlete, command()),
      ]),
      sorted = saved.sort((a, b) => (a.templateId < b.templateId ? -1 : 1));
    const one = await repo.list(f.athlete, { limit: 2, offset: 0 });
    expect(one.items).toEqual(sorted.slice(0, 2));
    const last = await repo.list(f.athlete, { limit: 2, offset: 2 });
    expect(last.items).toEqual(sorted.slice(2));
  });
  it('post-SQL injected failure rolls version/head/receipt/outbox back, allowing the same stable request retry', async () => {
    const f = await tenant(),
      input = command(),
      before = await counts(f.athlete);
    const failing: Database = {
      ...db,
      tenant: (athlete, operation) =>
        db.tenant(athlete, (tx) =>
          operation({
            ...tx,
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (sql.includes('public.save_check_in_template_v1'))
                throw Error('SYNTHETIC_AFTER_SAVE_FAILURE');
              return result;
            },
          }),
        ),
    };
    await expect(createCheckInTemplateRepository(failing).save(f.athlete, input)).rejects.toThrow(
      'SYNTHETIC_AFTER_SAVE_FAILURE',
    );
    expect(await counts(f.athlete)).toEqual(before);
    expect((await createCheckInTemplateRepository(db).save(f.athlete, input)).version).toBe(1);
  });
  it('genuine erasure with flushed deferred cleanup rolls all source/template rows back on transaction failure', async () => {
    const f = await tenant(),
      repo = createCheckInTemplateRepository(db),
      input = command(),
      saved = await repo.save(f.athlete, input),
      actual = await unrelatedActuals(f.athlete),
      before = await counts(f.athlete);
    let flushed = false;
    const failing: Database = {
      ...db,
      exclusiveTenant: (athlete, operation) =>
        db.exclusiveTenant(athlete, (tx) =>
          operation({
            ...tx,
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (sql === 'SELECT public.erase_account($1)') {
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                flushed = true;
                throw Error('SYNTHETIC_AFTER_DEFERRED_ERASURE_FAILURE');
              }
              return result;
            },
          }),
        ),
    };
    await expect(createOperationsRepository(failing).eraseAccount(f.athlete)).rejects.toThrow(
      'SYNTHETIC_AFTER_DEFERRED_ERASURE_FAILURE',
    );
    expect(flushed).toBe(true);
    expect(await counts(f.athlete)).toEqual(before);
    expect(await repo.readExact(f.athlete, saved.templateId, saved.versionId)).toEqual(saved);
    expect(await repo.save(f.athlete, input)).toEqual(saved);
    expect(await actual.checkins.getCheckIn(f.athlete, actual.observation.id)).toEqual(
      actual.observation,
    );
    expect(await actual.routines.readRun(f.athlete, actual.run.run.id)).toEqual(actual.run);
  });
  it('genuine public account erasure removes template bodies and receipts and rejects replay without resurrection', async () => {
    const f = await tenant(),
      repo = createCheckInTemplateRepository(db),
      input = command();
    await repo.save(f.athlete, input);
    await unrelatedActuals(f.athlete);
    expect(await createOperationsRepository(db).eraseAccount(f.athlete)).toEqual({ erased: true });
    expect((await counts(f.athlete))[0]).toMatchObject({
      versions: 0,
      heads: 0,
      receipts: 0,
      actuals: 0,
      runs: 0,
      erasure_originals: 1,
    });
    await expect(repo.save(f.athlete, input)).rejects.toThrow('ACCOUNT_ERASED');
    await expect(repo.readHead(f.athlete, input.templateId)).rejects.toThrow('ACCOUNT_ERASED');
  });
});
