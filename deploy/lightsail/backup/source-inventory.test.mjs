import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildSourceInventory, compareSourceCatalog } from './source-inventory.mjs';

const registry = JSON.parse(
  readFileSync(new URL('./source-registry.json', import.meta.url), 'utf8'),
);
const migrateSource = readFileSync(
  new URL('../../../packages/server/persistence/src/migrate.ts', import.meta.url),
  'utf8',
);
const migrationFileNames = [
  ...migrateSource
    .slice(migrateSource.indexOf('const migrationFiles'), migrateSource.indexOf('] as const;'))
    .matchAll(/'([0-9]{3}_[^']+\.sql)'/g),
].map((match) => match[1]);
const role = 'source_owner';
const databaseOwner = 'workout_admin';
const actualOwner = (owner) => (owner === '$snapshot_owner' ? role : databaseOwner);
const namespaces = registry.namespaces.map((row) => ({ ...row, owner: actualOwner(row.owner) }));
const relations = registry.relations.map((row) => ({
  schema: row.schema,
  name: row.name,
  kind: row.kind,
  persistence: row.persistence,
  owner: actualOwner(row.owner),
  rls: row.rls,
  forceRls: row.forceRls,
}));
const columns = registry.relations.flatMap((row) =>
  row.columns.map(([position, name, type, notNull]) => ({
    schema: row.schema,
    relation: row.name,
    position,
    name,
    type,
    notNull,
  })),
);
const migrations = registry.migrationChecksums;

function compare(overrides = {}) {
  return compareSourceCatalog({
    namespaces,
    relations,
    columns,
    migrations,
    registry,
    role,
    databaseOwner,
    ...overrides,
  });
}

test('candidate pin matches 001–093 file bytes and covers all 16 row-HMAC relations', () => {
  assert.equal(registry.pinStatus, 'candidate_migrations_001_093_pg14');
  assert.equal(migrationFileNames.length, 93);
  for (const [index, file] of migrationFileNames.entries()) {
    const checksum = createHash('sha256')
      .update(
        readFileSync(
          new URL(`../../../packages/server/persistence/migrations/${file}`, import.meta.url),
        ),
      )
      .digest('hex');
    assert.deepEqual(migrations[index], { version: index + 1, checksum });
  }
  const answer = compare();
  assert.equal(answer.classifications.rowHmac, 16);
  assert.deepEqual(
    registry.relations
      .filter((row) => row.classification === 'row_hmac')
      .map((row) => `${row.schema}.${row.name}`)
      .sort(),
    [
      'public.activity_canonical',
      'public.activity_source_head',
      'public.activity_suppression',
      'public.check_in',
      'public.coaching_constraint',
      'public.course',
      'public.course_deletion',
      'public.course_share',
      'public.course_share_area_budget',
      'public.course_share_audit',
      'public.gallery_media_item',
      'public.intake_entry',
      'public.recovery_action_log',
      'public.resource',
      'public.resource_access_audit',
      'public.resource_share',
    ].sort(),
  );
  assert.equal(answer.classifications.summaryOnly, 5);
  assert.equal(answer.classifications.uncovered, 480);
  assert.equal(answer.relationCount, 501);
  assert.equal(answer.columnCount, 2147);
  assert.equal(answer.uncoveredKinds.index > 0, true);
});

test('new or removed schema/relation and schema, owner, RLS or column drift fail closed', () => {
  const mutated = [
    { namespaces: [...namespaces, { name: 'surprise', owner: role }] },
    { namespaces: namespaces.slice(1) },
    { relations: [...relations, { ...relations[0], schema: 'public', name: 'surprise' }] },
    { relations: relations.slice(1) },
    {
      relations: relations.map((row, index) =>
        index === 0 ? { ...row, owner: databaseOwner } : row,
      ),
    },
    { relations: relations.map((row, index) => (index === 0 ? { ...row, rls: !row.rls } : row)) },
    {
      relations: relations.map((row, index) =>
        index === 0 ? { ...row, forceRls: !row.forceRls } : row,
      ),
    },
    { relations: relations.map((row, index) => (index === 0 ? { ...row, kind: 'p' } : row)) },
    { columns: columns.map((row, index) => (index === 0 ? { ...row, type: 'text' } : row)) },
    { columns: columns.slice(1) },
    { migrations: migrations.slice(0, 65) },
  ];
  for (const change of mutated)
    assert.throws(() => compare(change), /BACKUP_SOURCE_INVENTORY_UNVERIFIED/);
});

test('the snapshot role may also own the database and public schema', () => {
  const sameOwnerNamespaces = namespaces.map((row) => ({
    ...row,
    owner: row.owner === databaseOwner ? role : row.owner,
  }));
  const sameOwnerRelations = relations.map((row) => ({
    ...row,
    owner: row.owner === databaseOwner ? role : row.owner,
  }));
  const result = compare({
    databaseOwner: role,
    namespaces: sameOwnerNamespaces,
    relations: sameOwnerRelations,
  });
  assert.equal(result.namespaceCount, 3);
  assert.equal(result.relationCount, 501);
  assert.throws(
    () =>
      compare({
        databaseOwner: role,
        relations: sameOwnerRelations,
        namespaces: sameOwnerNamespaces.map((row) =>
          row.name === 'public' ? { ...row, owner: 'unexpected_owner' } : row,
        ),
      }),
    /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
  );
});

test('sequence, partition, materialized view and large object gaps have bounded classifications', () => {
  for (const kind of ['S', 'm', 'p']) {
    const added = {
      schema: 'public',
      name: `new_${kind.toLowerCase()}`,
      kind,
      persistence: 'p',
      owner: role,
      rls: false,
      forceRls: false,
    };
    assert.throws(
      () => compare({ relations: [...relations, added] }),
      /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
    );
  }
  assert.throws(
    () => compare({ relations: [...relations, { ...relations[0], name: 'secret_token' }] }),
    /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
  );
});

test('runtime role, changed snapshot, excessive catalog and raw row data are refused', async () => {
  assert.throws(() => compare({ role: 'api_runtime' }), /BACKUP_SOURCE_INVENTORY_UNVERIFIED/);
  assert.throws(
    () => compare({ namespaces: Array.from({ length: 65 }, () => namespaces[0]) }),
    /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
  );
  const client = {
    async query(sql) {
      if (sql.includes('current_user AS role'))
        return {
          rows: [
            {
              role,
              session_role: role,
              isolation: 'repeatable read',
              read_only: 'on',
              snapshot_id: '1:2:',
              database_owner: databaseOwner,
            },
          ],
        };
      if (sql.includes('FROM pg_catalog.pg_roles'))
        return { rows: [{ rolsuper: false, rolbypassrls: false }] };
      if (sql.includes('FROM pg_catalog.pg_namespace')) return { rows: namespaces };
      if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows: columns };
      if (sql.includes('FROM pg_catalog.pg_class')) return { rows: relations };
      if (sql.includes('FROM public.schema_migrations')) return { rows: migrations };
      if (sql.includes('pg_largeobject_metadata')) return { rows: [{ count: '2' }] };
      throw new Error('unexpected SQL');
    },
  };
  const result = await buildSourceInventory({ client, expectedSnapshotId: '1:2:' });
  assert.equal(result.complete, false);
  assert.equal(result.registryPinStatus, 'candidate_migrations_001_093_pg14');
  assert.equal(result.largeObjectCount, 2);
  assert.equal(result.classifications.rowHmac, 16);
  assert.ok(!JSON.stringify(result).includes('secret_token'));
  assert.ok(!JSON.stringify(result).includes('private-health-value'));
  await assert.rejects(
    buildSourceInventory({ client, expectedSnapshotId: '1:3:' }),
    /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
  );
  await assert.rejects(
    buildSourceInventory({ client, expectedSnapshotId: `1:2:${'1,'.repeat(600)}` }),
    /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
  );
  const runtime = {
    query: async (sql) =>
      sql.includes('current_user AS role')
        ? {
            rows: [
              {
                role: 'api_runtime',
                session_role: 'api_runtime',
                isolation: 'repeatable read',
                read_only: 'on',
                snapshot_id: '1:2:',
                database_owner: databaseOwner,
              },
            ],
          }
        : client.query(sql),
  };
  await assert.rejects(
    buildSourceInventory({ client: runtime, expectedSnapshotId: '1:2:' }),
    /BACKUP_SOURCE_INVENTORY_UNVERIFIED/,
  );
});
