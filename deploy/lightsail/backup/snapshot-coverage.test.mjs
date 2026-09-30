import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshotCoverage, domainSchemaFingerprint } from './snapshot-coverage.mjs';

const tables = [
  'identity_private.account',
  'public.restore_suppression_event',
  'public.tenant_erasure',
  'public.consent',
  'public.coaching_constraint_head',
  'public.coaching_constraint',
  'public.course_share_area_budget',
];
const domainTables = [
  'course_deletion',
  'course',
  'activity_canonical',
  'activity_source_head',
  'activity_suppression',
  'resource',
  'gallery_media_item',
  'check_in',
  'resource_share',
  'resource_access_audit',
  'course_share',
  'course_share_audit',
  'intake_entry',
  'recovery_action_log',
  'coaching_constraint',
  'course_share_area_budget',
].map((name) => `public.${name}`);
const catalog = domainTables.map((table_name) => ({
  table_name,
  column_name: 'athlete_id',
  data_type: 'text',
  owner_name: 'migration_owner',
  not_null: true,
  force_rls: true,
  row_security: true,
}));
const migrations = Array.from({ length: 93 }, (_, index) => ({
  version: index + 1,
  checksum: String(index + 1).padStart(64, '0'),
}));
const snapshot = {
  snapshotName: '00000001-00000002-1',
  consistentPointLsn: '0/16B6C50',
  postgresSystemIdentifier: '123',
  replicationSlot: 'slot_probe',
};
const expectedOwners = ['owner-a', 'owner-b', 'owner-empty'];
const args = {
  snapshot,
  expectedSnapshotId: '1:2:',
  expectedOwners,
  expectedDomainSchemaFingerprint: domainSchemaFingerprint(catalog, migrations),
  hmacKey: Buffer.alloc(32, 7),
};

function fixture(overrides = {}) {
  const calls = [];
  let activeTable = null;
  let scopedOwner = null;
  let fetched = false;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.startsWith('DECLARE workout_snapshot_domain_cursor')) {
        activeTable = /FROM (public\.[a-z_]+) t/.exec(sql)?.[1];
        fetched = false;
        if (!activeTable) throw new Error('unexpected cursor query');
        return { rows: [] };
      }
      if (sql.startsWith('FETCH FORWARD')) {
        if (!activeTable) throw new Error('cursor not open');
        if (fetched) return { rows: [] };
        fetched = true;
        const answer = overrides.query?.(
          `SELECT to_jsonb(t)::text AS row_json FROM ${activeTable} t`,
          [scopedOwner],
        );
        return { rows: answer ?? [] };
      }
      if (sql.startsWith('CLOSE workout_snapshot_domain_cursor')) {
        activeTable = null;
        return { rows: [] };
      }
      if (overrides.query) {
        const answer = overrides.query(sql, values);
        if (answer !== undefined) return { rows: answer };
      }
      if (sql.includes('current_user AS'))
        return {
          rows: [
            {
              current_role: 'migration_owner',
              session_role: 'migration_owner',
              isolation: 'repeatable read',
              read_only: 'on',
              snapshot_id: '1:2:',
            },
          ],
        };
      if (sql.includes('FROM pg_catalog.pg_roles'))
        return { rows: [{ rolsuper: false, rolbypassrls: false }] };
      if (sql.includes('FROM pg_catalog.pg_attribute')) return { rows: catalog };
      if (sql.includes('JOIN pg_catalog.pg_attribute')) return { rows: catalog };
      if (sql.includes('FROM public.schema_migrations')) return { rows: migrations };
      if (sql.includes('FROM pg_catalog.pg_class'))
        return {
          rows: tables.map((table_name) => ({ table_name, owner_name: 'migration_owner' })),
        };
      if (sql.includes('FROM identity_private.account'))
        return { rows: expectedOwners.map((athlete_id) => ({ athlete_id })) };
      if (sql.includes('set_config')) {
        scopedOwner = values[0];
        return { rows: [{ scoped: values[0] }] };
      }
      if (sql.includes('GROUP BY kind'))
        return {
          rows:
            values[0] === 'owner-a'
              ? [{ kind: 'ai_consent_transition', record_version: 1, total: '2' }]
              : [],
        };
      if (sql.includes('FROM public.consent'))
        return {
          rows: values[0] === 'owner-a' ? [{ kind: 'ai', granted: false, revision: 2 }] : [],
        };
      if (sql.includes('FROM public.tenant_erasure')) return { rows: [{ total: '0' }] };
      if (sql.includes('FROM public.coaching_constraint_head'))
        return { rows: values[0] === 'owner-b' ? [{ revision: 3 }] : [] };
      if (sql.includes('FROM public.coaching_constraint'))
        return {
          rows: [
            {
              total: values[0] === 'owner-b' ? '2' : '0',
              tombstones: values[0] === 'owner-b' ? '1' : '0',
            },
          ],
        };
      if (sql.includes('FROM public.course_share_area_budget'))
        return {
          rows: [
            {
              total: values[0] === 'owner-b' ? '1' : '0',
              links_cut: values[0] === 'owner-b' ? '4' : '0',
            },
          ],
        };
      throw new Error('unexpected query');
    },
  };
  return { client, calls };
}

test('three owners retain absent versus false, constraint tombstones and budget history', async () => {
  const { client, calls } = fixture();
  const result = await buildSnapshotCoverage({ ...args, client });
  assert.equal(result.complete, false);
  assert.equal(result.owners.length, 3);
  assert.equal(result.owners[0].consent.ai.granted, false);
  assert.deepEqual(result.owners[2].consent.ai, { state: 'absent' });
  assert.equal(result.owners[1].coaching.tombstones, 1);
  assert.equal(result.owners[1].courseShareAreaBudget.linksCut, 4);
  assert.equal(result.owners[0].events.ai_consent_transition, 2);
  assert.ok(!JSON.stringify(result).includes('owner-a'));
  assert.equal(calls.filter((call) => call.sql.includes('set_config')).length, 3);
  assert.ok(
    calls.every((call) => !/\b(INSERT|UPDATE|DELETE|COMMIT|CREATE|DROP)\b/i.test(call.sql)),
  );
  assert.ok(result.gaps.includes('POST_SNAPSHOT_TAIL_NOT_WITNESSED'));
});

test('rejects runtime role and snapshot mismatch before tenant reads', async () => {
  for (const answer of [
    { rolsuper: false, rolbypassrls: true },
    { rolsuper: true, rolbypassrls: false },
  ]) {
    const { client } = fixture({
      query: (sql) => (sql.includes('FROM pg_catalog.pg_roles') ? [answer] : undefined),
    });
    await assert.rejects(
      buildSnapshotCoverage({ ...args, client }),
      /SNAPSHOT_COVERAGE_UNVERIFIED/,
    );
  }
  const { client } = fixture({
    query: (sql) =>
      sql.includes('current_user AS')
        ? [
            {
              current_role: 'migration_owner',
              session_role: 'migration_owner',
              isolation: 'repeatable read',
              read_only: 'on',
              snapshot_id: '2:3:',
            },
          ]
        : undefined,
  });
  await assert.rejects(buildSnapshotCoverage({ ...args, client }), /SNAPSHOT_COVERAGE_UNVERIFIED/);
});

test('rejects changed roster, unknown event kind and missing schema ownership', async () => {
  const cases = [
    (sql) =>
      sql.includes('FROM identity_private.account') ? [{ athlete_id: 'owner-a' }] : undefined,
    (sql) =>
      sql.includes('GROUP BY kind')
        ? [{ kind: 'unknown', record_version: 1, total: '1' }]
        : undefined,
    (sql) =>
      sql.includes('GROUP BY kind')
        ? [{ kind: 'ai_consent_transition', record_version: 3, total: '1' }]
        : undefined,
    (sql) =>
      sql.includes('FROM pg_catalog.pg_class')
        ? tables.slice(1).map((table_name) => ({ table_name, owner_name: 'migration_owner' }))
        : undefined,
  ];
  for (const query of cases) {
    const { client } = fixture({ query });
    await assert.rejects(
      buildSnapshotCoverage({ ...args, client }),
      /SNAPSHOT_COVERAGE_UNVERIFIED/,
    );
  }
});

test('independently listed pre-event erasure owner fails closed when not discoverable', async () => {
  const { client } = fixture();
  await assert.rejects(
    buildSnapshotCoverage({
      ...args,
      client,
      expectedOwners: [...expectedOwners, 'erased-before-066'],
    }),
    /SNAPSHOT_COVERAGE_UNVERIFIED/,
  );
});

test('recognizes current v2 resource and course share events', async () => {
  const { client } = fixture({
    query: (sql, values) =>
      sql.includes('GROUP BY kind') && values[0] === 'owner-b'
        ? [
            { kind: 'resource_share_revoked', record_version: 2, total: '1' },
            { kind: 'course_share_revoked', record_version: 2, total: '1' },
          ]
        : undefined,
  });
  const result = await buildSnapshotCoverage({ ...args, client });
  assert.equal(result.owners[1].events.resource_share_revoked, 1);
  assert.equal(result.owners[1].events.course_share_revoked, 1);
});

test('rejects malformed slot metadata', async () => {
  for (const invalid of [
    { ...snapshot, consistentPointLsn: 'invalid' },
    { ...snapshot, replicationSlot: 'slot;drop' },
    { ...snapshot, postgresSystemIdentifier: 'unknown' },
  ]) {
    const { client } = fixture();
    await assert.rejects(
      buildSnapshotCoverage({ ...args, client, snapshot: invalid }),
      /SNAPSHOT_COVERAGE_UNVERIFIED/,
    );
  }
});

test('domain leaves bind private current state without emitting IDs or content', async () => {
  const privateId = 'private-course-id-123';
  const secret = 'sensitive-location-and-name';
  const answer = (sql, values) => {
    if (!sql.includes('SELECT to_jsonb(t)::text')) return undefined;
    if (sql.includes('FROM public.course t') && values[0] === 'owner-a')
      return [
        {
          row_json: JSON.stringify({
            athlete_id: 'owner-a',
            course_id: privateId,
            name: secret,
            status: 'available',
          }),
        },
      ];
    if (sql.includes('FROM public.resource_share t') && values[0] === 'owner-a')
      return [
        {
          row_json: JSON.stringify({
            athlete_id: 'owner-a',
            grantee_principal_id: 'owner-b',
            share_id: 'secret-share',
          }),
        },
      ];
    return [];
  };
  const { client, calls } = fixture({ query: answer });
  const first = await buildSnapshotCoverage({ ...args, client });
  assert.equal(first.owners[0].domain['public.course'].count, 1);
  assert.equal(first.owners[0].domain['public.resource_share'].count, 1);
  assert.equal(first.owners[1].domain['public.resource_share'].count, 0);
  assert.equal(first.owners[2].domain['public.course'].count, 0);
  assert.equal(first.owners[2].domain['public.course'].digest.length, 64);
  assert.ok(
    calls
      .filter((call) => call.sql.startsWith('DECLARE workout_snapshot_domain_cursor'))
      .every(
        (call) =>
          call.sql.includes("WHERE athlete_id=nullif(current_setting('app.athlete_id',true),'')") &&
          call.sql.includes('octet_length(to_jsonb(t)::text) <= 2097152'),
      ),
  );
  assert.equal(
    calls.filter((call) => call.sql.startsWith('DECLARE workout_snapshot_domain_cursor')).length,
    calls.filter((call) => call.sql.startsWith('CLOSE workout_snapshot_domain_cursor')).length,
  );
  for (const value of [privateId, secret, 'secret-share', 'owner-a', 'owner-b'])
    assert.ok(!JSON.stringify(first).includes(value));
  const changed = fixture({
    query: (sql, values) => {
      const result = answer(sql, values);
      if (sql.includes('FROM public.course t') && values[0] === 'owner-a')
        return [{ row_json: result[0].row_json.replace(secret, 'different-name') }];
      return result;
    },
  });
  const second = await buildSnapshotCoverage({ ...args, client: changed.client });
  assert.notEqual(
    first.owners[0].domain['public.course'].digest,
    second.owners[0].domain['public.course'].digest,
  );
  assert.equal(
    first.owners[1].domain['public.course'].digest,
    second.owners[1].domain['public.course'].digest,
  );
});

test('domain catalog mismatch, extra columns and unbounded rows fail closed', async () => {
  const { client } = fixture();
  await assert.rejects(
    buildSnapshotCoverage({ ...args, client, expectedDomainSchemaFingerprint: '0'.repeat(64) }),
    /SNAPSHOT_COVERAGE_UNVERIFIED/,
  );
  for (const query of [
    (sql) =>
      sql.includes('JOIN pg_catalog.pg_attribute')
        ? [...catalog, { ...catalog[0], column_name: 'unknown_private_column' }]
        : undefined,
    (sql, values) =>
      sql.includes('SELECT to_jsonb(t)::text') && values[0] === 'owner-a'
        ? [{ row_json: 'x'.repeat(2 * 1024 * 1024 + 1) }]
        : undefined,
    (sql, values) =>
      sql.includes('SELECT to_jsonb(t)::text') && values[0] === 'owner-a'
        ? [{ row_json: null }]
        : undefined,
    (sql) =>
      sql.includes('FROM public.schema_migrations')
        ? migrations.map((row) => (row.version === 93 ? { ...row, version: 94 } : row))
        : undefined,
  ]) {
    const fixtureCase = fixture({ query });
    await assert.rejects(
      buildSnapshotCoverage({ ...args, client: fixtureCase.client }),
      /SNAPSHOT_COVERAGE_UNVERIFIED/,
    );
    if (
      fixtureCase.calls.some((call) =>
        call.sql.startsWith('DECLARE workout_snapshot_domain_cursor'),
      )
    )
      assert.equal(
        fixtureCase.calls.filter((call) =>
          call.sql.startsWith('DECLARE workout_snapshot_domain_cursor'),
        ).length,
        fixtureCase.calls.filter((call) =>
          call.sql.startsWith('CLOSE workout_snapshot_domain_cursor'),
        ).length,
      );
  }
});

test('owner roster is bounded before and after database enumeration', async () => {
  const { client, calls } = fixture();
  await assert.rejects(
    buildSnapshotCoverage({
      ...args,
      client,
      expectedOwners: Array.from({ length: 10_001 }, (_, index) => `owner-${index}`),
    }),
    /SNAPSHOT_COVERAGE_UNVERIFIED/,
  );
  assert.equal(calls.length, 0);
  const oversized = fixture({
    query: (sql) =>
      sql.includes('FROM identity_private.account')
        ? Array.from({ length: 10_001 }, (_, index) => ({ athlete_id: `owner-${index}` }))
        : undefined,
  });
  await assert.rejects(
    buildSnapshotCoverage({ ...args, client: oversized.client }),
    /SNAPSHOT_COVERAGE_UNVERIFIED/,
  );
  const roster = oversized.calls.find((call) => call.sql.includes('FROM identity_private.account'));
  assert.equal(roster.values[0], 10_001);
});

test('domain digest is independent of database row retrieval order', async () => {
  const records = [
    { row_json: JSON.stringify({ athlete_id: 'owner-a', id: 'first' }) },
    { row_json: JSON.stringify({ athlete_id: 'owner-a', id: 'second' }) },
  ];
  const capture = async (reverse) => {
    const { client } = fixture({
      query: (sql, values) =>
        sql.includes('FROM public.course t') && values[0] === 'owner-a'
          ? reverse
            ? [...records].reverse()
            : records
          : undefined,
    });
    return (await buildSnapshotCoverage({ ...args, client })).owners[0].domain['public.course'];
  };
  assert.deepEqual(await capture(false), await capture(true));
});
