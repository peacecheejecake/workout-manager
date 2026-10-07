import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, it } from 'vitest';
import { z } from 'zod';
import {
  migrate,
  migrationFileNames,
  grantCorePlanning,
  grantRaces,
  grantOperations,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real registered SQL106 boundary tests. No positive health seed can be loaded
// under101 always-CLOSED. Synthetic ledger headers are not authenticated fulltail.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const dbName = `manual_review_${suffix}`;
const ownerRole = `review_owner_${suffix}`;
const runtimeRole = `review_runtime_${suffix}`;
const nextRole = `review_next_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
let owner: Pool, runtime: Pool, inspection: Pool, next: Pool;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const athlete = randomUUID(),
  source = randomUUID(),
  stamp = '2026-10-01T00:00:00.123456Z',
  event = randomUUID();
function url(role: string) {
  const value = new URL(adminUrl);
  value.pathname = `/${dbName}`;
  value.username = role;
  value.password = 'isolated';
  value.searchParams.set(
    'options',
    '-c timezone=UTC -c datestyle=ISO,YMD -c statement_timeout=5000',
  );
  return value.toString();
}
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole, nextRole])
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  await admin.query(`CREATE DATABASE ${dbName} OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: url(ownerRole) });
  runtime = new Pool({ connectionString: url(runtimeRole) });
  next = new Pool({ connectionString: url(nextRole) });
  const inspected = new URL(adminUrl);
  inspected.pathname = `/${dbName}`;
  inspection = new Pool({ connectionString: inspected.toString() });
  await migrate(url(ownerRole));
  await grantCorePlanning(url(ownerRole), runtimeRole);
  await grantRaces(url(ownerRole), runtimeRole);
  await grantOperations(url(ownerRole), runtimeRole);
  await owner.query(
    'INSERT INTO identity_private.account(athlete_id,issuer,subject) VALUES($1,$2,$3)',
    [athlete, 'https://synthetic.invalid', randomUUID()],
  );
});
afterAll(async () => {
  await Promise.all([owner?.end(), runtime?.end(), inspection?.end(), next?.end()]);
  try {
    await dropIsolatedDatabase(admin, dbName);
    for (const role of [ownerRole, runtimeRole, nextRole])
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  } finally {
    await admin.end();
  }
});
async function tx<T>(p: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const value = await fn(c);
    await c.query('COMMIT');
    return value;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
async function locks(
  c: PoolClient,
  g: 'shared' | 'exclusive' | null = 'exclusive',
  l: 'shared' | 'exclusive' | null = 'exclusive',
) {
  if (g) await c.query(`SELECT pg_advisory_xact_lock${g === 'shared' ? '_shared' : ''}(77210,1)`);
  if (l)
    await c.query(
      `SELECT pg_advisory_xact_lock${l === 'shared' ? '_shared' : ''}(hashtextextended($1,77206))`,
      [athlete],
    );
}
async function deny(fn: () => Promise<unknown>, message: string | null = null, code?: string) {
  await assert.rejects(fn, (error: unknown) => {
    const parsed = z.object({ message: z.string(), code: z.string().optional() }).safeParse(error);
    return (
      parsed.success &&
      (!message || parsed.data.message === message) &&
      (!code || parsed.data.code === code)
    );
  });
}
const replay = (
  c: PoolClient,
  args: readonly unknown[] = [
    athlete,
    event,
    stamp,
    'session-completion',
    'same-session',
    'exact_version',
    JSON.stringify([source, 2147483647]),
  ],
) =>
  c.query('SELECT replay_manual_review_source_suppression_exact($1,$2,$3,$4,$5,$6,$7) AS status', [
    ...args,
  ]);
async function insert(c: PoolClient, fields: Readonly<Record<string, unknown>>) {
  const row = {
    event_id: randomUUID(),
    record_version: 6,
    athlete_id: athlete,
    kind: 'manual_review_source_suppressed',
    occurred_at: stamp,
    manual_review_source_kind: 'routine-run',
    manual_review_source_id: randomUUID(),
    manual_review_version_scope: 'exact_version',
    manual_review_version_key: '0',
    ...fields,
  };
  return c.query(
    'INSERT INTO restore_suppression_event(' +
      Object.keys(row).join(',') +
      ') VALUES(' +
      Object.keys(row)
        .map((_, i) => '$' + (i + 1))
        .join(',') +
      ')',
    Object.values(row),
  );
}

it('registered107 preserves exact106 checksum and plain owner / FORCE RLS roster', async () => {
  assert.equal(migrationFileNames.length, 107);
  assert.equal(migrationFileNames[105], '106_race_manual_review.sql');
  assert.equal(migrationFileNames[106], '107_guard_race_review_stamp_authority.sql');
  assert.deepEqual(
    (await owner.query('SELECT count(*)::int AS n,max(version) AS v FROM schema_migrations'))
      .rows[0],
    { n: 107, v: 107 },
  );
  const sql = await readFile(
    new URL('../migrations/106_race_manual_review.sql', import.meta.url),
    'utf8',
  );
  assert.equal(
    (await owner.query('SELECT checksum FROM schema_migrations WHERE version=106')).rows[0]
      .checksum,
    hash(sql),
  );
  assert.equal(
    (await owner.query('SELECT checksum FROM schema_migrations WHERE version=107')).rows[0]
      .checksum,
    hash(
      await readFile(
        new URL('../migrations/107_guard_race_review_stamp_authority.sql', import.meta.url),
        'utf8',
      ),
    ),
  );
  assert.deepEqual(
    (await admin.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1', [ownerRole]))
      .rows[0],
    { rolsuper: false, rolbypassrls: false },
  );
  assert.equal(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('race_manual_review','race_manual_review_source_ref','race_manual_review_source_suppression','restore_manual_review_source_replay_receipt') AND relrowsecurity AND relforcerowsecurity",
      )
    ).rows[0].n,
    4,
  );
});
it('closed_store_gate_without_health_seed', async () => {
  await deny(
    () =>
      tx(owner, (c) =>
        c.query('SELECT store_race_manual_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
          randomUUID(),
          'race-manual-review:store:' + 'a'.repeat(64),
          'b'.repeat(64),
          source,
          1,
          1,
          randomUUID(),
          'c'.repeat(64),
          'd'.repeat(64),
          'e'.repeat(64),
          {},
          [],
        ]),
      ),
    'RESTORE_PROCESSING_CLOSED',
  );
  assert.equal(
    (await owner.query('SELECT count(*)::int AS n FROM race_manual_review')).rows[0].n,
    0,
  );
});
it('runtime_newtable_and_function_privilege_denials', async () => {
  await deny(
    () =>
      runtime.query('INSERT INTO race_manual_review_source_ref VALUES($1,$2,$3,$4,$5,$6)', [
        athlete,
        randomUUID(),
        'race-event',
        source,
        '1',
        'a'.repeat(64),
      ]),
    null,
    '42501',
  );
  await deny(
    () =>
      runtime.query('SELECT replay_manual_review_source_suppression_exact($1,$2,$3,$4,$5,$6,$7)', [
        athlete,
        event,
        stamp,
        'race-event',
        source,
        'all_versions',
        null,
      ]),
    null,
    '42501',
  );
  await deny(() => runtime.query('SELECT count(*) FROM race_manual_review'), null, '42501');
});
it('owner_identity_runtime_and_admin_denied', async () => {
  await deny(() => tx(runtime, (c) => c.query('SELECT manual_review_owner()')), null, '42501');
  await deny(
    () => tx(inspection, (c) => replay(c)),
    'MANUAL_REVIEW_REPLAY_OWNER_REQUIRED',
    '42501',
  );
});
it('lifecycle_absent_rejected', () =>
  deny(
    () => tx(owner, (c) => c.query('SELECT assert_manual_review_lifecycle_lock($1)', [athlete])),
    'MANUAL_REVIEW_LIFECYCLE_LOCK_REQUIRED',
  ));
for (const mode of ['shared', 'exclusive'] as const)
  it('lifecycle_' + mode + '_correct_hash_key', () =>
    tx(owner, async (c) => {
      await locks(c, 'shared', mode);
      await c.query('SELECT assert_manual_review_lifecycle_lock($1)', [athlete]);
    }),
  );
it('lifecycle_wrong_tenant_or_key_rejected', () =>
  deny(
    () =>
      tx(owner, async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [athlete]);
        await c.query('SELECT assert_manual_review_lifecycle_lock($1)', [athlete]);
      }),
    'MANUAL_REVIEW_LIFECYCLE_LOCK_REQUIRED',
  ));
it('owner_replay_global_absent_rejected', () =>
  deny(() => tx(owner, (c) => replay(c)), 'MANUAL_REVIEW_REPLAY_GLOBAL_EXCLUSIVE_REQUIRED'));
it('owner_replay_global_shared_rejected', () =>
  deny(
    () =>
      tx(owner, async (c) => {
        await locks(c, 'shared', null);
        return replay(c);
      }),
    'MANUAL_REVIEW_REPLAY_GLOBAL_EXCLUSIVE_REQUIRED',
  ));
it('owner_exact_v6_replay_receipt_id_time_terminal_namespace', async () => {
  const r = await tx(owner, async (c) => {
    await locks(c);
    return replay(c);
  });
  assert.equal(r.rows[0].status, 'applied');
  await tx(owner, async (c) => {
    const row = (
      await c.query(
        'SELECT event_id,occurred_at::text,manual_review_version_key FROM restore_suppression_event WHERE event_id=$1',
        [event],
      )
    ).rows[0];
    assert.equal(row.event_id, event);
    assert.equal(row.occurred_at, '2026-10-01 00:00:00.123456+00');
    assert.equal(row.manual_review_version_key, JSON.stringify([source, 2147483647]));
    assert.equal(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM restore_manual_review_source_replay_receipt WHERE event_id=$1',
          [event],
        )
      ).rows[0].n,
      1,
    );
  });
});
it('owner_exact_replay_no_new_event_receipt_domain_row', async () => {
  const r = await tx(owner, async (c) => {
    await locks(c);
    return replay(c);
  });
  assert.equal(r.rows[0].status, 'already_applied');
  assert.equal(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM restore_manual_review_source_replay_receipt',
      )
    ).rows[0].n,
    1,
  );
  for (const t of [
    'race_event',
    'routine_run',
    'session_completion',
    'plan_snapshot',
    'race_manual_review',
  ])
    assert.equal(
      (await tx(owner, (c) => c.query('SELECT count(*)::int AS n FROM ' + t))).rows[0].n,
      0,
    );
});
it('v6_replay_changed_original_timestamp_rejected', () =>
  deny(
    () =>
      tx(owner, async (c) => {
        await locks(c);
        return replay(c, [
          athlete,
          event,
          '2026-10-01T00:00:00Z',
          'session-completion',
          'same-session',
          'exact_version',
          JSON.stringify([source, 2147483647]),
        ]);
      }),
    'MANUAL_REVIEW_REPLAY_EVENT_CONFLICT',
  ));
it('v6_replay_tuple_other_event_id_collision_rejected', () =>
  deny(
    () =>
      tx(owner, async (c) => {
        await locks(c);
        return replay(c, [
          athlete,
          randomUUID(),
          stamp,
          'session-completion',
          'same-session',
          'exact_version',
          JSON.stringify([source, 2147483647]),
        ]);
      }),
    'MANUAL_REVIEW_REPLAY_EVENT_CONFLICT',
  ));
for (const [name, fields] of [
  ['invalid_scope', { manual_review_version_scope: 'unknown' }],
  ['exact_null_key', { manual_review_version_key: null }],
  ['all_nonnull_key', { manual_review_version_scope: 'all_versions' }],
  ['unknown_kind', { manual_review_source_kind: 'actual-content' }],
  ['old_target_nonnull', { target_id: source }],
  ['old_epoch_nonnull', { consent_revision: 1 }],
  [
    'session_noncanonical_tuple',
    {
      manual_review_source_kind: 'session-completion',
      manual_review_source_id: 'same-session',
      manual_review_version_key: JSON.stringify([source, 1]).replace(',', ', '),
    },
  ],
] as const)
  it('v6_sql_reject_' + name, () => assert.rejects(() => tx(owner, (c) => insert(c, fields))));
for (const [name, fields] of [
  [
    'race_terminal',
    { manual_review_source_kind: 'race-event', manual_review_version_key: '2147483647' },
  ],
  ['plan_exact', { manual_review_source_kind: 'plan-snapshot', manual_review_version_key: '1' }],
  [
    'immutable_version',
    { manual_review_source_kind: 'nutrition-plan-version', manual_review_version_key: source },
  ],
  [
    'occurrence_immutable',
    { manual_review_source_kind: 'routine-occurrence', manual_review_version_key: 'immutable' },
  ],
  [
    'session_all',
    {
      manual_review_source_kind: 'session-completion',
      manual_review_source_id: 'same-session',
      manual_review_version_scope: 'all_versions',
      manual_review_version_key: null,
    },
  ],
] as const)
  it('v6_sql_accept_' + name, () => tx(owner, (c) => insert(c, fields)));
const old = [
  { record_version: 1, kind: 'tenant_erased' },
  {
    record_version: 3,
    kind: 'healthkit_workout_deregistration_pending',
    target_id: randomUUID(),
    healthkit_claim_epoch: randomUUID(),
    healthkit_operation_id: randomUUID(),
    healthkit_consent_revision: 1,
    healthkit_registry_previous_revision: 0,
    healthkit_registry_revision: 1,
    healthkit_object_scopes: JSON.stringify([{ kind: 'activity', id: randomUUID() }]),
  },
  {
    record_version: 4,
    kind: 'race_result_deleted',
    target_id: randomUUID(),
    race_previous_revision: 1,
    race_deleted_revision: 2,
  },
  {
    record_version: 5,
    kind: 'app_consent_transition',
    consent_revision: 1,
    consent_granted: false,
  },
];
for (const row of old)
  it('old_v' + row.record_version + '_shape_new4_null', () =>
    tx(owner, (c) =>
      insert(c, {
        ...row,
        athlete_id: randomUUID(),
        manual_review_source_kind: null,
        manual_review_source_id: null,
        manual_review_version_scope: null,
        manual_review_version_key: null,
      }),
    ),
  );
it('old_v2_compound_share_same_transaction_new4_null', () =>
  tx(owner, async (c) => {
    const parent = randomUUID(),
      tenant = randomUUID();
    const nulls = {
      manual_review_source_kind: null,
      manual_review_source_id: null,
      manual_review_version_scope: null,
      manual_review_version_key: null,
    };
    await insert(c, {
      ...nulls,
      event_id: parent,
      athlete_id: tenant,
      record_version: 1,
      kind: 'tenant_erased',
    });
    await insert(c, {
      ...nulls,
      athlete_id: tenant,
      record_version: 2,
      kind: 'resource_share_revoked',
      target_id: randomUUID(),
      share_id: randomUUID(),
      share_granted_access_revision: 1,
      share_revoked_access_revision: 2,
      share_cause_kind: 'tenant_erased',
      share_cause_event_id: parent,
    });
  }));
it('owner_raw_review_insert_closed_no_payload_seed', async () => {
  await deny(
    () =>
      tx(owner, (c) =>
        c.query(
          `INSERT INTO race_manual_review(athlete_id,id,schema_version,created_at,event_id,event_revision,app_revision,generation_id,policy_id,policy_version,policy_digest,read_set_digest,candidate_digest,payload_sql_digest,receipt_key,request_digest,payload) VALUES($1,$2,1,$3,$4,1,1,$5,'manual-race-date-impact',1,$6,$6,$6,$7,$8,$6,'{}')`,
          [
            athlete,
            randomUUID(),
            stamp,
            source,
            randomUUID(),
            'a'.repeat(64),
            hash('{}'),
            'race-manual-review:store:' + 'f'.repeat(64),
          ],
        ),
      ),
    'RESTORE_PROCESSING_CLOSED',
  );
  assert.equal(
    (await tx(owner, (c) => c.query('SELECT count(*)::int AS n FROM race_manual_review'))).rows[0]
      .n,
    0,
  );
});
it('owner_ref_missing_parent_failclosed', () =>
  deny(
    () =>
      tx(owner, (c) =>
        c.query('INSERT INTO race_manual_review_source_ref VALUES($1,$2,$3,$4,$5,$6)', [
          athlete,
          randomUUID(),
          'race-event',
          source,
          '1',
          'a'.repeat(64),
        ]),
      ),
    'MANUAL_REVIEW_PARENT_INVALID',
  ));
it('v6_runtime_receipt_and_event_insert_denied', async () => {
  await deny(
    () =>
      runtime.query(
        'INSERT INTO restore_manual_review_source_replay_receipt VALUES($1,$2,$3,$4,$5,$6,$7)',
        [event, athlete, stamp, 'race-event', source, 'all_versions', null],
      ),
    null,
    '42501',
  );
  await deny(() => tx(runtime, (c) => insert(c, {})), null, '42501');
});
it('v6_owner_forged_receipt_fields_rejected', () =>
  deny(
    () =>
      owner.query(
        'INSERT INTO restore_manual_review_source_replay_receipt VALUES($1,$2,$3,$4,$5,$6,$7)',
        [event, athlete, stamp, 'race-event', source, 'all_versions', null],
      ),
    'MANUAL_REVIEW_REPLAY_RECEIPT_INVALID',
  ));
it('v6_foreign_event_identity_rejected', () =>
  deny(
    () =>
      tx(owner, async (c) => {
        await locks(c);
        return replay(c, [athlete, event, stamp, 'routine-run', source, 'exact_version', '0']);
      }),
    'MANUAL_REVIEW_REPLAY_EVENT_CONFLICT',
  ));
it('v6_replay_future_timestamp_rejected', () =>
  deny(
    () =>
      tx(owner, async (c) => {
        await locks(c);
        return replay(c, [
          athlete,
          randomUUID(),
          '2999-01-01T00:00:00Z',
          'race-event',
          source,
          'all_versions',
          null,
        ]);
      }),
    'MANUAL_REVIEW_REPLAY_INVALID',
  ));
it('old_v1_newfield_rejected', () =>
  assert.rejects(() =>
    tx(owner, (c) =>
      insert(c, { record_version: 1, kind: 'tenant_erased', athlete_id: randomUUID() }),
    ),
  ));
it('old4_no_copy_original_replay_without_new_global_requirement', async () => {
  const ev = randomUUID();
  const r = await tx(owner, (c) =>
    c.query('SELECT replay_race_deletion_exact($1,$2,$3,$4,$5,$6,$7) AS status', [
      athlete,
      'race_event_deleted',
      randomUUID(),
      ev,
      stamp,
      1,
      2,
    ]),
  );
  assert.ok(['applied', 'already_deleted', 'already_applied'].includes(r.rows[0].status));
  assert.equal(
    (
      await owner.query('SELECT record_version FROM restore_suppression_event WHERE event_id=$1', [
        ev,
      ])
    ).rows[0].record_version,
    4,
  );
});
it('ledger_immutable_update_delete', async () => {
  await deny(
    () =>
      owner.query(
        'UPDATE restore_manual_review_source_replay_receipt SET source_id=source_id WHERE event_id=$1',
        [event],
      ),
    'IMMUTABLE_RESTORE_SUPPRESSION_EVENT',
  );
  await deny(
    () =>
      owner.query('DELETE FROM restore_manual_review_source_replay_receipt WHERE event_id=$1', [
        event,
      ]),
    'IMMUTABLE_RESTORE_SUPPRESSION_EVENT',
  );
});
it('ownership transfer requires existing policy retarget and preserves exact replay', async () => {
  await admin.query(`ALTER DATABASE ${dbName} OWNER TO "${nextRole}"`);
  await inspection.query(`REASSIGN OWNED BY "${ownerRole}" TO "${nextRole}"`);
  // Original receipt policy follows the live owner, but its event policy still
  // names the old owner. This exact retry therefore rejects before insertion.
  await deny(
    () =>
      tx(next, async (c) => {
        await locks(c);
        return replay(c);
      }),
    'MANUAL_REVIEW_REPLAY_RECEIPT_CONFLICT',
    'P0001',
  );
  // A separate absent event reaches the original protected INSERT: stale
  // owner-specific FORCE RLS refuses42501. Neither failure creates new facts.
  const rejectedEvent = randomUUID();
  await deny(
    () =>
      tx(next, async (c) => {
        await locks(c);
        return replay(c, [
          athlete,
          rejectedEvent,
          stamp,
          'session-completion',
          'transfer-session',
          'all_versions',
          null,
        ]);
      }),
    null,
    '42501',
  );
  assert.equal(
    (
      await inspection.query(
        'SELECT count(*)::int AS n FROM restore_suppression_event WHERE event_id=$1',
        [rejectedEvent],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await inspection.query(
        'SELECT count(*)::int AS n FROM restore_manual_review_source_replay_receipt WHERE event_id=$1',
        [rejectedEvent],
      )
    ).rows[0].n,
    0,
  );
  await next.query('SELECT public.retarget_definer_policies()');
  const result = await tx(next, async (c) => {
    await locks(c);
    return replay(c);
  });
  assert.equal(result.rows[0].status, 'already_applied');
  await deny(
    () =>
      tx(owner, async (c) => {
        await locks(c);
        return replay(c);
      }),
    null,
    '42501',
  );
});
