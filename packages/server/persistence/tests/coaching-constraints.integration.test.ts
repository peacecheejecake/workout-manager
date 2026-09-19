import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { createDatabase, TenantErasedError, type Database } from '../src/database.js';
import { migrate, grantOperations, grantCoachingConstraints } from '../src/migrate.js';
import { createCoachingConstraintRepository } from '../src/coaching-constraints.js';
import { createOperationsRepository } from '../src/operations.js';
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'],
  runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Use isolated PostgreSQL integration harness');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;
beforeAll(async () => {
  await migrate(adminUrl);
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCoachingConstraints(adminUrl, 'workout_runtime');
  await admin.query('GRANT SELECT,INSERT,UPDATE ON command_receipt,outbox TO workout_runtime');
  await admin.query(
    'GRANT SELECT ON consent,plan_snapshot,plan_head,plan_history,activity_canonical,activity_source_head,activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression TO workout_runtime',
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 6 });
});
afterAll(async () => {
  await database?.close();
  await admin.end();
});
const create = (
  expectedHeadRevision: number | null = null,
  text = 'Private confirmed restriction',
) => ({ expectedHeadRevision, confirmed: true as const, text, idempotencyKey: randomUUID() });
it('distinguishes absent from explicitly emptied constraints and replays metadata without retaining old or deleted text', async () => {
  const athlete = randomUUID(),
    repo = createCoachingConstraintRepository(database),
    input = { ...create(), idempotencyKey: 'k'.repeat(200) };
  expect(await repo.list(athlete)).toEqual({ headRevision: null, items: [] });
  const [first, duplicate] = await Promise.all([
    repo.create(athlete, input),
    repo.create(athlete, input),
  ]);
  expect(duplicate).toEqual(first);
  const before = (await repo.list(athlete)).items[0];
  expect(before?.text).toBe(input.text);
  const updated = await repo.update(athlete, first.id, {
    expectedHeadRevision: 1,
    expectedRevision: 1,
    confirmed: true,
    text: '  Corrected user restriction  ',
    idempotencyKey: randomUUID(),
  });
  expect(updated).toMatchObject({ id: first.id, revision: 2, headRevision: 2, deleted: false });
  expect((await repo.list(athlete)).items[0]?.text).toBe('Corrected user restriction');
  expect(await repo.create(athlete, input)).toEqual(first);
  await expect(repo.create(athlete, { ...input, text: 'Different body' })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  const removal = {
    expectedHeadRevision: 2,
    expectedRevision: 2,
    confirmed: true as const,
    idempotencyKey: randomUUID(),
  };
  const removed = await repo.remove(athlete, first.id, removal);
  expect(removed).toMatchObject({ revision: 3, headRevision: 3, deleted: true });
  expect(await repo.remove(athlete, first.id, removal)).toEqual(removed);
  expect(await repo.create(athlete, input)).toEqual(first);
  expect(await repo.list(athlete)).toEqual({ headRevision: 3, items: [] });
  await database.tenant(athlete, async (tx) => {
    expect(
      (
        await tx.query('SELECT text,deleted FROM coaching_constraint WHERE athlete_id=$1', [
          athlete,
        ])
      ).rows,
    ).toEqual([{ text: null, deleted: true }]);
    const receipts = await tx.query(
      "SELECT request,result FROM command_receipt WHERE athlete_id=$1 AND idempotency_key LIKE 'coaching:constraint:%'",
      [athlete],
    );
    expect(receipts.rows).toHaveLength(3);
    for (const receipt of receipts.rows) {
      expect(receipt['request']).toEqual({ requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(Object.keys(receipt['result'] as object).sort()).toEqual([
        'deleted',
        'headRevision',
        'id',
        'revision',
      ]);
    }
    expect(JSON.stringify(receipts.rows)).not.toContain('restriction');
    const events = await tx.query(
      "SELECT payload FROM outbox WHERE athlete_id=$1 AND topic='coaching.constraint_changed'",
      [athlete],
    );
    expect(events.rows).toHaveLength(3);
    expect(JSON.stringify(events.rows)).not.toContain('restriction');
  });
  await expect(
    repo.update(athlete, first.id, {
      expectedHeadRevision: 3,
      expectedRevision: 3,
      confirmed: true,
      text: 'Resurrect',
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'COACHING_CONSTRAINT_NOT_FOUND' });
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query(
        "UPDATE coaching_constraint SET deleted=false,text='resurrect',revision=revision+1 WHERE athlete_id=$1",
        [athlete],
      ),
    ),
  ).rejects.toThrow('IMMUTABLE_CONSTRAINT_IDENTITY');
});
it('serializes competing aggregate and item revisions and concurrent final slot creation', async () => {
  const athlete = randomUUID(),
    repo = createCoachingConstraintRepository(database),
    first = await repo.create(athlete, create());
  const races = await Promise.allSettled(
    ['One', 'Two'].map((text) =>
      repo.update(athlete, first.id, {
        expectedHeadRevision: 1,
        expectedRevision: 1,
        confirmed: true,
        text,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  expect(races.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(races.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'COACHING_CONSTRAINT_REVISION_CONFLICT' },
  });
  await expect(repo.create(athlete, create(1))).rejects.toMatchObject({
    code: 'COACHING_CONSTRAINT_REVISION_CONFLICT',
  });
  // Seed the remaining independent confirmed entries through the real command boundary.
  let head = 2;
  for (let index = 1; index < 49; index++) {
    await repo.create(athlete, create(head, `Bounded constraint ${index}`));
    head++;
  }
  const final = await Promise.allSettled([
    repo.create(athlete, create(head, 'Last A')),
    repo.create(athlete, create(head, 'Last B')),
  ]);
  expect(final.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await repo.list(athlete)).items).toHaveLength(50);
  await expect(repo.create(athlete, create(head + 1, 'Over limit'))).rejects.toMatchObject({
    code: 'COACHING_CONSTRAINT_LIMIT',
  });
});
it('enforces ownership and immutable identity, exports current text only, and erases head, tombstones and command history', async () => {
  const athlete = randomUUID(),
    other = randomUUID(),
    repo = createCoachingConstraintRepository(database),
    first = await repo.create(athlete, create());
  expect(await repo.list(other)).toEqual({ headRevision: null, items: [] });
  await expect(
    repo.remove(other, first.id, {
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: 'COACHING_CONSTRAINT_NOT_FOUND' });
  await database.tenant(other, async (tx) =>
    expect(
      (await tx.query('SELECT * FROM coaching_constraint WHERE athlete_id=$1', [athlete])).rows,
    ).toEqual([]),
  );
  await expect(
    database.tenant(other, (tx) =>
      tx.query('INSERT INTO coaching_constraint_head(athlete_id,revision) VALUES($1,1)', [athlete]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query('UPDATE coaching_constraint SET id=$2,revision=revision+1 WHERE athlete_id=$1', [
        athlete,
        randomUUID(),
      ]),
    ),
  ).rejects.toThrow('IMMUTABLE_CONSTRAINT_IDENTITY');
  await expect(
    database.tenant(athlete, (tx) =>
      tx.query('DELETE FROM coaching_constraint WHERE athlete_id=$1', [athlete]),
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await repo.update(athlete, first.id, {
    expectedHeadRevision: 1,
    expectedRevision: 1,
    confirmed: true,
    text: 'Latest confirmed restriction',
    idempotencyKey: randomUUID(),
  });
  const exported = await createOperationsRepository(database).exportAccount(athlete);
  expect(exported).toMatchObject({
    schemaVersion: 12,
    data: {
      coachingConstraints: [
        { id: first.id, revision: 2, text: 'Latest confirmed restriction', deleted: false },
      ],
      coachingConstraintHeads: [{ revision: 2 }],
    },
  });
  expect(JSON.stringify(exported)).not.toContain('Private confirmed restriction');
  await createOperationsRepository(database).eraseAccount(athlete);
  await expect(repo.list(athlete)).rejects.toBeInstanceOf(TenantErasedError);
  for (const table of ['coaching_constraint', 'coaching_constraint_head', 'command_receipt'])
    expect(
      (
        await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE athlete_id=$1`, [
          athlete,
        ])
      ).rows[0].count,
    ).toBe(0);
});
it('rolls back both revisions, text and metadata when outbox fails, then reuses the original command key', async () => {
  const athlete = randomUUID(),
    repo = createCoachingConstraintRepository(database),
    input = create();
  const broken: Database = {
    ...database,
    tenant: (id, operation) =>
      database.tenant(id, (tx) =>
        operation({
          ...tx,
          query: (sql, values) => {
            if (sql.includes('INSERT INTO outbox')) throw new Error('Injected constraint failure');
            return tx.query(sql, values);
          },
        }),
      ),
  };
  const failing = createCoachingConstraintRepository(broken);
  await expect(failing.create(athlete, input)).rejects.toThrow('Injected constraint failure');
  expect(await repo.list(athlete)).toEqual({ headRevision: null, items: [] });
  const first = await repo.create(athlete, input),
    update = {
      expectedHeadRevision: 1,
      expectedRevision: 1,
      confirmed: true as const,
      text: 'New private text',
      idempotencyKey: randomUUID(),
    };
  await expect(failing.update(athlete, first.id, update)).rejects.toThrow(
    'Injected constraint failure',
  );
  expect(await repo.list(athlete)).toMatchObject({
    headRevision: 1,
    items: [{ revision: 1, text: input.text }],
  });
  await repo.update(athlete, first.id, update);
  const remove = {
    expectedHeadRevision: 2,
    expectedRevision: 2,
    confirmed: true as const,
    idempotencyKey: randomUUID(),
  };
  await expect(failing.remove(athlete, first.id, remove)).rejects.toThrow(
    'Injected constraint failure',
  );
  expect(await repo.list(athlete)).toMatchObject({
    headRevision: 2,
    items: [{ revision: 2, text: update.text }],
  });
  await repo.remove(athlete, first.id, remove);
  expect(await repo.list(athlete)).toEqual({ headRevision: 3, items: [] });
});
