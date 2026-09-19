import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { PrivateTextResourceCreate } from '@workout/contracts/resources';
import { createDatabase, type Database } from '../src/database.js';
import { grantOperations, grantResources, migrate } from '../src/migrate.js';
import { createOperationsRepository } from '../src/operations.js';
import { createPrivateTextResourceRepository, ResourceNotFoundError } from '../src/resources.js';

const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl) throw new Error('Run pnpm test:integration with isolated PostgreSQL');
const admin = new Pool({ connectionString: adminUrl });
let database: Database;

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantResources(adminUrl, 'workout_runtime');
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
});

afterAll(async () => {
  await database?.close();
  await admin.end();
});

const command = (idempotencyKey = randomUUID()): PrivateTextResourceCreate => ({
  sourceKind: 'text',
  title: 'Private recovery notes',
  category: 'note',
  metadata: { author: 'Owner', year: 2026, language: 'ko' },
  tags: ['Recovery', 'personal'],
  favorite: true,
  text: '첫 문단입니다.\n\nSecond paragraph.',
  idempotencyKey,
});

function available<T extends { status: string }>(
  value: T,
): asserts value is T & {
  status: 'available';
  resource: { id: string; currentVersionId: string; accessRevision: number };
  version: { id: string; version: number; source: { text: string } };
  reader: { originalText: string };
} {
  expect(value.status).toBe('available');
}

describe('M2-04a private DB-backed text resources', () => {
  it('creates, lists and reads current and immutable exact versions', async () => {
    const athlete = randomUUID();
    const repo = createPrivateTextResourceRepository(database);
    const createInput = command();
    const first = await repo.create(athlete, createInput);
    available(first);
    expect(first.resource).toMatchObject({
      title: 'Private recovery notes',
      visibility: 'private',
      includeForCoach: false,
      reviewedState: 'unreviewed',
      accessRevision: 1,
      favorite: true,
    });
    expect(first.reader.originalText).toBe('첫 문단입니다.\n\nSecond paragraph.');
    expect(first.version.paragraphs).toHaveLength(2);
    expect(first.version.paragraphs[1]?.locator).toMatchObject({
      index: 1,
      offsetUnit: 'utf16_code_unit',
    });
    expect(await repo.list(athlete)).toMatchObject({
      total: 1,
      items: [{ id: first.resource.id, deletedAt: null }],
    });
    expect((await repo.list(athlete, { query: 'RECOVERY', favorite: true })).total).toBe(1);
    expect(() => repo.list(athlete, { query: `unsafe${String.fromCharCode(0)}query` })).toThrow();
    expect((await repo.list(athlete, { category: 'paper' })).total).toBe(0);
    expect(await repo.list(athlete, { offset: 100 })).toMatchObject({ items: [], total: 1 });

    const append = {
      expectedCurrentVersionId: first.version.id,
      text: 'Updated direct text.',
      idempotencyKey: randomUUID(),
    };
    const second = await repo.appendVersion(athlete, first.resource.id, append);
    available(second);
    expect(await repo.create(athlete, createInput)).toEqual(first);
    expect(await repo.appendVersion(athlete, first.resource.id, append)).toEqual(second);
    await expect(
      repo.appendVersion(athlete, first.resource.id, { ...append, text: 'Collision' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(second.version).toMatchObject({ version: 2, previousVersionId: first.version.id });
    expect(second.resource.accessRevision).toBe(2);
    const historical = await repo.read(athlete, first.resource.id, { versionId: first.version.id });
    available(historical);
    expect(historical.version).toMatchObject({ version: 1, previousVersionId: null });
    expect(historical.reader.originalText).toBe(first.reader.originalText);
    const stored = await database.tenant(athlete, (tx) =>
      tx.query(
        'SELECT version,content FROM resource_version WHERE athlete_id=$1 ORDER BY version',
        [athlete],
      ),
    );
    expect(stored.rows).toEqual([
      { version: 1, content: first.reader.originalText },
      { version: 2, content: 'Updated direct text.' },
    ]);
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    expect(exported.schemaVersion).toBe(12);
    if (exported.schemaVersion !== 12) throw new Error('Expected resource export');
    expect(exported.data.resources).toHaveLength(1);
    expect(exported.data.resourceVersions).toHaveLength(2);
  });

  it('serializes concurrent appends and preserves replay while rejecting collisions', async () => {
    const athlete = randomUUID();
    const repo = createPrivateTextResourceRepository(database);
    const createKey = randomUUID();
    const createInput = command(createKey);
    const first = await repo.create(athlete, createInput);
    available(first);
    expect(await repo.create(athlete, createInput)).toEqual(first);
    await expect(
      repo.create(athlete, { ...createInput, title: 'Collision' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const results = await Promise.allSettled([
      repo.appendVersion(athlete, first.resource.id, {
        expectedCurrentVersionId: first.version.id,
        text: 'Competing A',
        idempotencyKey: randomUUID(),
      }),
      repo.appendVersion(athlete, first.resource.id, {
        expectedCurrentVersionId: first.version.id,
        text: 'Competing B',
        idempotencyKey: randomUUID(),
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'REVISION_CONFLICT' },
    });
    expect(
      await database.tenant(athlete, (tx) =>
        tx.query('SELECT count(*)::integer AS count FROM resource_version'),
      ),
    ).toMatchObject({ rows: [{ count: 2 }] });
  });

  it('accepts the 1,000 paragraph boundary and rejects writes beyond the bounded account quota', async () => {
    const athlete = randomUUID();
    const repo = createPrivateTextResourceRepository(database);
    for (const unsafeCommand of [
      { ...command(), title: 'unsafe\u0000title' },
      { ...command(), metadata: { author: `unsafe${String.fromCharCode(0xd800)}author` } },
      { ...command(), tags: ['unsafe\u0001tag'] },
      { ...command(), text: `unsafe${String.fromCharCode(0xd800)}body` },
    ])
      expect(() => repo.create(athlete, unsafeCommand)).toThrow();
    const payloadBytes = 65_536 - 999 * 2;
    const escapedParagraphs = Array.from({ length: 1000 }, (_, index) => {
      const length = Math.floor(payloadBytes / 1000) + (index < payloadBytes % 1000 ? 1 : 0);
      return `A${'\\"\t'.repeat(length).slice(0, length - 1)}`;
    });
    const escapedBoundaryText = escapedParagraphs.join('\n\n');
    expect(Buffer.byteLength(escapedBoundaryText, 'utf8')).toBe(65_536);
    const boundary = await repo.create(athlete, {
      ...command(),
      title: 'Paragraph boundary',
      text: escapedBoundaryText,
    });
    available(boundary);
    expect(boundary.version.paragraphs).toHaveLength(1000);

    const fullText = (marker: string) =>
      [marker.padEnd(8000, 'x'), ...Array.from({ length: 7 }, () => 'x'.repeat(8000))].join('\n\n');
    let current = await repo.create(athlete, { ...command(), title: 'Quota', text: fullText('1') });
    available(current);
    let quotaReached = false;
    for (let version = 2; version <= 50; version += 1) {
      try {
        current = await repo.appendVersion(athlete, current.resource.id, {
          expectedCurrentVersionId: current.version.id,
          text: fullText(String(version)),
          idempotencyKey: randomUUID(),
        });
        available(current);
      } catch (error) {
        expect(error).toMatchObject({ code: 'RESOURCE_QUOTA_EXCEEDED' });
        quotaReached = true;
        break;
      }
    }
    expect(quotaReached).toBe(true);
  });

  it('keeps cross-tenant resources indistinguishable and rejects foreign writes', async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const repo = createPrivateTextResourceRepository(database);
    const created = await repo.create(owner, command());
    available(created);
    expect(await repo.read(other, created.resource.id)).toEqual({ status: 'unavailable' });
    expect(await repo.list(other)).toEqual({ items: [], total: 0 });
    await expect(
      repo.appendVersion(other, created.resource.id, {
        expectedCurrentVersionId: created.version.id,
        text: 'Foreign write',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await database.tenant(other, async (tx) =>
      expect((await tx.query('SELECT * FROM resource_version')).rows).toEqual([]),
    );
  });

  it('soft deletes atomically, blocks every version immediately and replays once', async () => {
    const athlete = randomUUID();
    const repo = createPrivateTextResourceRepository(database);
    const createInput = command();
    const first = await repo.create(athlete, createInput);
    available(first);
    const append = {
      expectedCurrentVersionId: first.version.id,
      text: 'Second body',
      idempotencyKey: randomUUID(),
    };
    const second = await repo.appendVersion(athlete, first.resource.id, append);
    available(second);
    const deletion = {
      expectedAccessRevision: second.resource.accessRevision,
      expectedCurrentVersionId: second.version.id,
      idempotencyKey: randomUUID(),
    };
    const deleted = await repo.softDelete(athlete, first.resource.id, deletion);
    expect(deleted).toMatchObject({
      status: 'deleted',
      resourceId: first.resource.id,
      accessRevision: 3,
    });
    expect(await repo.softDelete(athlete, first.resource.id, deletion)).toEqual(deleted);
    await expect(
      repo.softDelete(athlete, first.resource.id, {
        ...deletion,
        expectedAccessRevision: deletion.expectedAccessRevision - 1,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await repo.read(athlete, first.resource.id)).toEqual(deleted);
    expect(await repo.read(athlete, first.resource.id, { versionId: first.version.id })).toEqual(
      deleted,
    );
    expect(await repo.read(athlete, first.resource.id, { versionId: second.version.id })).toEqual(
      deleted,
    );
    expect(await repo.list(athlete)).toEqual({ items: [], total: 0 });
    expect(await repo.create(athlete, createInput)).toEqual(deleted);
    expect(await repo.appendVersion(athlete, first.resource.id, append)).toEqual(deleted);
    const receipts = await database.tenant(athlete, (tx) =>
      tx.query(
        `SELECT request,result FROM command_receipt
         WHERE idempotency_key LIKE 'resource:%' ORDER BY idempotency_key`,
      ),
    );
    expect(JSON.stringify(receipts.rows)).not.toContain(first.reader.originalText);
    const receiptRows = z
      .array(z.object({ result: z.object({ status: z.string() }) }))
      .parse(receipts.rows);
    expect(receiptRows.every((row) => row.result.status === 'deleted')).toBe(true);
    const exported = await createOperationsRepository(database).exportAccount(athlete);
    if (exported.schemaVersion !== 12) throw new Error('Expected resource export');
    expect(exported.data.resources).toEqual([]);
    expect(exported.data.resourceVersions).toEqual([]);
    const event = await database.tenant(athlete, (tx) =>
      tx.query("SELECT payload FROM outbox WHERE topic='resource.deleted'"),
    );
    expect(event.rows).toEqual([{ payload: { resourceId: first.resource.id, versionId: null } }]);
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query(
          'UPDATE resource SET deleted_at=NULL,updated_at=clock_timestamp(),access_revision=access_revision+1 WHERE athlete_id=$1 AND id=$2',
          [athlete, first.resource.id],
        ),
      ),
    ).rejects.toThrow('INVALID_RESOURCE_TRANSITION');
  });

  it('rolls domain mutation back when outbox insertion fails', async () => {
    const athlete = randomUUID();
    const working = createPrivateTextResourceRepository(database);
    const created = await working.create(athlete, command());
    available(created);
    const broken: Database = {
      ...database,
      tenant: (id, operation) =>
        database.tenant(id, (tx) =>
          operation({
            ...tx,
            query: (sql, values) => {
              if (sql.includes('INSERT INTO outbox')) throw new Error('injected outbox failure');
              return tx.query(sql, values);
            },
          }),
        ),
    };
    await expect(
      createPrivateTextResourceRepository(broken).softDelete(athlete, created.resource.id, {
        expectedAccessRevision: 1,
        expectedCurrentVersionId: created.version.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('injected outbox failure');
    const read = await working.read(athlete, created.resource.id);
    available(read);
    expect(read.resource.accessRevision).toBe(1);
  });

  it('uses minimal runtime grants, immutable versions and account erasure', async () => {
    const athlete = randomUUID();
    const repo = createPrivateTextResourceRepository(database);
    const created = await repo.create(athlete, command());
    available(created);
    const privileges = await admin.query(
      `SELECT has_table_privilege('workout_runtime','resource_version','SELECT') AS can_select,
       has_table_privilege('workout_runtime','resource_version','INSERT') AS can_insert,
       has_table_privilege('workout_runtime','resource_version','UPDATE') AS can_update,
       has_table_privilege('workout_runtime','resource_version','DELETE') AS can_delete`,
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
    });
    const probeRole = `resource_probe_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await admin.query(`CREATE ROLE "${probeRole}" LOGIN NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO "${probeRole}"`);
    await admin.query(`GRANT SELECT ON tenant_erasure TO "${probeRole}"`);
    await grantResources(adminUrl, probeRole);
    const receiptPrivileges = await admin.query(
      `SELECT has_table_privilege($1,'command_receipt','UPDATE') AS can_update,
       has_function_privilege(
         $1,'public.tombstone_resource_receipts(uuid)','EXECUTE'
       ) AS can_tombstone_resource`,
      [probeRole],
    );
    expect(receiptPrivileges.rows[0]).toEqual({
      can_update: false,
      can_tombstone_resource: true,
    });
    await admin.query(
      `INSERT INTO command_receipt(athlete_id,idempotency_key,request,result)
       VALUES($1,'planning:resource-grant-probe','{}'::jsonb,'{}'::jsonb)`,
      [athlete],
    );
    const probeUrl = new URL(runtimeUrl);
    probeUrl.username = probeRole;
    const probeDatabase = createDatabase({ connectionString: probeUrl.toString(), max: 1 });
    await expect(
      probeDatabase.tenant(athlete, (tx) =>
        tx.query(
          `UPDATE command_receipt SET result='{}'::jsonb
           WHERE athlete_id=$1 AND idempotency_key=$2`,
          [athlete, 'planning:resource-grant-probe'],
        ),
      ),
    ).rejects.toBeTruthy();
    await expect(
      probeDatabase.tenant(athlete, (tx) =>
        tx.query('SELECT public.tombstone_resource_receipts($1)', [randomUUID()]),
      ),
    ).rejects.toThrow('INVALID_RESOURCE_TOMBSTONE');
    await probeDatabase.close();
    await admin.query(`DROP OWNED BY "${probeRole}"`);
    await admin.query(`DROP ROLE "${probeRole}"`);
    await expect(
      database.tenant(athlete, (tx) =>
        tx.query('UPDATE resource_version SET content=$3 WHERE athlete_id=$1 AND version_id=$2', [
          athlete,
          created.version.id,
          'mutated',
        ]),
      ),
    ).rejects.toBeTruthy();
    await createOperationsRepository(database).eraseAccount(athlete);
    for (const table of ['resource', 'resource_version']) {
      const count = await admin.query(
        `SELECT count(*)::integer AS count FROM ${table} WHERE athlete_id=$1`,
        [athlete],
      );
      expect(count.rows[0]?.count).toBe(0);
    }
    await expect(repo.read(athlete, created.resource.id)).rejects.toThrow('ACCOUNT_ERASED');
  });
});
