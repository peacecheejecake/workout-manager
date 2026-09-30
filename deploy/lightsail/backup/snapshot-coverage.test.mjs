import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshotCoverage } from './snapshot-coverage.mjs';

const tables = [
  'identity_private.account',
  'public.restore_suppression_event',
  'public.tenant_erasure',
  'public.consent',
  'public.coaching_constraint_head',
  'public.coaching_constraint',
  'public.course_share_area_budget',
];
const snapshot = {
  snapshotName: '00000001-00000002-1',
  consistentPointLsn: '0/16B6C50',
  postgresSystemIdentifier: '123',
  replicationSlot: 'slot_probe',
};
const expectedOwners = ['owner-a', 'owner-b', 'owner-empty'];
const args = { snapshot, expectedSnapshotId: '1:2:', expectedOwners, hmacKey: Buffer.alloc(32, 7) };

function fixture(overrides = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
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
      if (sql.includes('FROM pg_catalog.pg_class'))
        return {
          rows: tables.map((table_name) => ({ table_name, owner_name: 'migration_owner' })),
        };
      if (sql.includes('FROM identity_private.account'))
        return { rows: expectedOwners.map((athlete_id) => ({ athlete_id })) };
      if (sql.includes('set_config')) return { rows: [{ scoped: values[0] }] };
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
