import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createCourseRepository } from '../src/courses.js';
import { createActivityRepository } from '../src/activities.js';
import { createNutritionRepository } from '../src/nutrition-core.js';
import { createRecoveryRepository } from '../src/recovery-core.js';
import { createCheckInRepository } from '../src/check-ins.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import {
  migrate,
  grantOperations,
  grantCorePlanning,
  grantNutritionCore,
  grantRecoveryCore,
  grantRoutineCore,
  grantSupplementaryCore,
  grantCheckIns,
  grantCourses,
  grantRaces,
  grantResources,
  grantResourceRetrieval,
  grantGalleryMedia,
  grantGarminUnofficial,
} from '../src/migrate.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root-only actual gate. Public producers create source/permission/chain facts;
// owner queries below capture catalog/physical child rows, never seed those rows.
// Empty relation census is tested, not claimed as nonempty producer acceptance.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `current_original_post_${suffix}`,
  ownerRole = `current_original_post_owner_${suffix}`,
  runtimeRole = `current_original_post_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
let targetCreated = false;
const targetName = `${name}_target`;
function targetUrl(role: string) {
  const u = new URL(url(role));
  u.pathname = `/${targetName}`;
  return u.toString();
}
function url(role: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
const migrations = [
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
];
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
    for (const file of migrations)
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    for (const signature of [
      'public.observe_manual_review_full_owned_source_bindings_v2(jsonb)',
      'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
      'public.read_manual_race_chain_receipt_v2(text,jsonb)',
      'public.read_manual_race_chain_v2(uuid)',
    ])
      await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
    // Match the existing authenticated API/activities producer composition:
    // grantOperations deliberately supplies retained SELECT only.
    await owner.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
       activity_source_revision,activity_overlay,activity_overlay_revision,
       activity_suppression,activity_import_receipt TO "${runtimeRole}"`,
    );
    expect(
      (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
        'version'
      ],
    ).toBe(107);
  } finally {
    await owner.end();
  }
  for (const grant of [
    grantOperations,
    grantCorePlanning,
    grantNutritionCore,
    grantRecoveryCore,
    grantRoutineCore,
    grantSupplementaryCore,
    grantCheckIns,
    grantCourses,
    grantRaces,
    grantResources,
    grantResourceRetrieval,
    grantGalleryMedia,
    grantGarminUnofficial,
  ])
    await grant(url(ownerRole), runtimeRole);
  await admin.query(`CREATE DATABASE "${targetName}" OWNER "${ownerRole}"`);
  targetCreated = true;
  await migrate(targetUrl(ownerRole), 107);
  const target = new Pool({ connectionString: targetUrl(ownerRole) });
  try {
    for (const file of [
      ...migrations,
      '117_restore_current_full_parent_family_loader.sql',
      '119_current_original_postimages.sql',
    ])
      await target.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    await expect(target.query('SELECT wm_current_app_load.configure_target()')).rejects.toThrow(
      'CURRENT_LOAD_TARGET_BINDING_REQUIRED',
    );
    await target.query(
      `SELECT public.close_restore_processing_exact(
        (public.read_restore_processing_admission()->>'localRevision')::bigint,$1,$2,$3)`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    await target.query('SELECT wm_current_app_load.configure_target()');
    await target.query(
      'SELECT wm_current_original_postimages.configure_profile(wm_current_original_postimages.catalog_projection())',
    );
  } finally {
    await target.end();
  }
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
}, 60000);
afterAll(async () => {
  await db?.close();
  if (targetCreated) await dropIsolatedDatabase(admin, targetName);
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
// Actual bounded SQL protocol acceptance, not host byte authentication. Source
// rows and originals come from public producers. Factory/operational adapter
// authority and unsupported parent partitions remain separate release gates.
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const rowSchema = z.record(z.string(), z.unknown());
const profileSchema = z.array(
  z.object({ relation: z.string(), schema: z.string(), table: z.string() }),
);
type Physical = {
  ordinal: number;
  relation: string;
  row: Record<string, unknown>;
  rowDigest: string;
};
async function capture(athlete: string, family?: string) {
  const pool = new Pool({ connectionString: url(ownerRole) }),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    // Use the exact installed target profile, never caller-selected tables.
    const target = new Pool({ connectionString: targetUrl(ownerRole) });
    let profile: z.infer<typeof profileSchema>;
    try {
      if (family) {
        const names = z
          .array(z.string())
          .parse(
            (
              await target.query(
                'SELECT wm_current_original_postimages.family_relations($1) AS value',
                [family],
              )
            ).rows[0]?.['value'],
          );
        profile = names.map((relation) => {
          const [schema, table] = relation.includes('.')
            ? relation.split('.')
            : ['public', relation];
          if (!schema || !table) throw Error('FIXED_RELATION_INVALID');
          return { relation, schema, table };
        });
      } else {
        profile = profileSchema.parse(
          (await target.query('SELECT wm_current_app_load.relation_profile() AS value')).rows[0]?.[
            'value'
          ],
        );
      }
    } finally {
      await target.end();
    }
    const rows: Physical[] = [];
    const census: Record<string, number> = {};
    let bytes = 0n;
    for (const relation of profile) {
      const columns = z
        .array(z.object({ name: z.string(), type: z.string() }))
        .parse(
          (
            await c.query(
              `SELECT attname AS name,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,
              [`${quote(relation.schema)}.${quote(relation.table)}`],
            )
          ).rows,
        );
      const fields = columns.flatMap((column) => {
        const value = `s.${quote(column.name)}`;
        const expression =
          column.type === 'timestamp with time zone'
            ? `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
            : column.type === 'bigint' || column.type === 'name' || column.type === 'numeric'
              ? `${value}::text`
              : column.type === 'bytea'
                ? `CASE WHEN ${value} IS NULL THEN NULL ELSE chr(92)||'x'||encode(${value},'hex') END`
                : value;
        return [`'${column.name.replaceAll("'", "''")}'`, expression];
      });
      const bounded = z
        .object({ count: z.string(), bytes: z.string() })
        .parse(
          (
            await c.query(
              `SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(s)::text)),0)::text AS bytes FROM ${quote(relation.schema)}.${quote(relation.table)} s WHERE s.athlete_id::text=$1`,
              [athlete],
            )
          ).rows[0],
        );
      bytes += BigInt(bounded.bytes);
      if (rows.length + Number(bounded.count) > 5000 || bytes > 16n * 1024n * 1024n)
        throw Error('FIXTURE_CAPTURE_LIMIT');
      const body = await c.query(
        `SELECT jsonb_build_object(${fields.join(',')}) AS row FROM ${quote(relation.schema)}.${quote(relation.table)} s WHERE s.athlete_id::text=$1 ORDER BY to_jsonb(s)::text`,
        [athlete],
      );
      census[relation.relation] = body.rows.length;
      for (const raw of body.rows)
        rows.push({
          ordinal: rows.length + 1,
          relation: relation.relation,
          row: rowSchema.parse(raw['row']),
          rowDigest: '',
        });
    }
    await c.query('COMMIT');
    return { rows, census };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
async function scenario<T>(seed?: (athlete: string) => Promise<T>) {
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
  await createConsentRepository(db).setConsent(athlete, {
    kind: 'app',
    granted: true,
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
  });
  const race = await createRaceRepository(db).createRaceEvent(athlete, {
    idempotencyKey: randomUUID(),
    values: {
      title: 'Synthetic current parent load',
      localDate: '2026-10-08',
      localStartTime: null,
      timezone: 'Asia/Seoul',
      locationName: null,
      distance: { kind: 'standard', class: '10k' },
      priority: null,
      participation: 'registered',
      officialUrl: null,
      course: null,
      targetSeconds: 0,
      planVersionId: null,
    },
  });
  const seeded = seed ? await seed(athlete) : undefined;
  const intent = {
    expectedEvent: { id: race.id, revision: race.revision },
    newLocalDate: '2026-10-09',
    selection: { kind: 'keep_plan' as const },
  };
  const basis = await createRaceManualSemanticBasisV2Service(db).prepare(athlete, intent);
  if (basis.status !== 'current_dependencies_captured') throw Error('BASIS_UNAVAILABLE');
  const command = {
    schemaVersion: 2 as const,
    idempotencyKey: randomUUID(),
    intent: basis.basis.intent,
    expectedBasis: basis.basis,
  };
  const repository = createRaceManualReviewChainV2Repository(db),
    stored = await repository.store(athlete, command);
  if (stored.status !== 'stored') throw Error('CHAIN_UNAVAILABLE');
  return { athlete, race, command, stored, repository, seeded };
}

async function withTarget<T>(athlete: string, work: (c: PoolClient) => Promise<T>) {
  const pool = new Pool({ connectionString: targetUrl(ownerRole) }),
    c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await c.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
    const result = await work(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
async function stage(
  c: PoolClient,
  athlete: string,
  snapshot: Awaited<ReturnType<typeof capture>>,
) {
  const run = randomUUID();
  for (const row of snapshot.rows)
    row.rowDigest = z
      .string()
      .parse(
        (
          await c.query('SELECT wm_current_app_load.hash_json($1::jsonb) AS digest', [
            JSON.stringify(row.row),
          ])
        ).rows[0]?.['digest'],
      );
  const expectedRowsDigest = z
    .string()
    .parse(
      (
        await c.query(
          `SELECT wm_current_app_load.hash_json(jsonb_agg(jsonb_build_object('ordinal',(r->>'ordinal')::int,'relation',r->>'relation','rowDigest',r->>'rowDigest') ORDER BY (r->>'ordinal')::int)) AS digest FROM jsonb_array_elements($1::jsonb) r`,
          [JSON.stringify(snapshot.rows)],
        )
      ).rows[0]?.['digest'],
    );
  const originalRowsDigest = z
    .string()
    .parse(
      (
        await c.query(
          `SELECT wm_current_app_load.hash_json(coalesce(jsonb_agg(jsonb_build_object('ordinal',(r->>'ordinal')::int,'rowDigest',r->>'rowDigest') ORDER BY (r->>'ordinal')::int),'[]'::jsonb)) AS digest FROM jsonb_array_elements($1::jsonb) r WHERE r->>'relation'='restore_suppression_event'`,
          [JSON.stringify(snapshot.rows)],
        )
      ).rows[0]?.['digest'],
    );
  const target = rowSchema.parse(
    (
      await c.query(
        `SELECT jsonb_build_object('catalogHash',catalog_hash,'nonce',nonce,'incarnation',incarnation,'generationId',generation_id,'controlRevision',control_revision::text,'state',state) AS value FROM wm_current_app_load.target`,
      )
    ).rows[0]?.['value'],
  );
  const descriptor = {
    profileVersion: 1,
    source: {
      systemIdentifier: '1',
      databaseOid: 1,
      captureId: randomUUID(),
      generationId: randomUUID(),
      registrySha256: 'a'.repeat(64),
      catalogSha256: 'b'.repeat(64),
      baselineThroughLsn: '0/0',
    },
    parentArtifactDigest: 'a'.repeat(64),
    childArtifactDigest: 'b'.repeat(64),
    tailWitnessDigest: 'c'.repeat(64),
    originalRowsDigest,
    athleteId: athlete,
    expectedCount: snapshot.rows.length,
    expectedCensus: snapshot.census,
    expectedRowsDigest,
    target,
  };
  // Descriptor digest strings are correspondence fields, never factory claims.
  await c.query('SELECT wm_current_app_load.begin_stage($1,$2::jsonb)', [
    run,
    JSON.stringify(descriptor),
  ]);
  for (const row of snapshot.rows)
    await c.query('SELECT wm_current_app_load.stage_row($1,$2,$3,$4::jsonb,$5)', [
      run,
      row.ordinal,
      row.relation,
      JSON.stringify(row.row),
      row.rowDigest,
    ]);
  await c.query('SELECT wm_current_app_load.seal_stage($1)', [run]);
  return run;
}

async function envelope(
  c: PoolClient,
  run: string,
  athlete: string,
  snapshot: Awaited<ReturnType<typeof capture>>,
) {
  const descriptor = rowSchema.parse(
    (await c.query('SELECT descriptor FROM wm_current_app_load.descriptor WHERE run_id=$1', [run]))
      .rows[0]?.['descriptor'],
  );
  const source = rowSchema.parse(descriptor['source']);
  const originals = snapshot.rows.filter((row) => row.relation === 'restore_suppression_event');
  // This fixture tests SQL membership/order correspondence, not HMAC/ciphertext
  // authentication or operational release. Producer transactions are sequential;
  // xmin/ctid are local diagnostics and are never invented envelope fields.
  const pool = new Pool({ connectionString: url(ownerRole) });
  let ordered: { event_id: string; source_xid: string }[];
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('app.athlete_id',$1,true)", [athlete]);
      ordered = z
        .array(z.object({ event_id: z.uuid(), source_xid: z.string() }))
        .parse(
          (
            await client.query(
              'SELECT event_id::text,xmin::text AS source_xid FROM public.restore_suppression_event WHERE athlete_id=$1 ORDER BY xmin::text::bigint,ctid',
              [athlete],
            )
          ).rows,
        );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
  const transactions: {
    commitLsn: string;
    endLsn: string;
    records: { stageOrdinal: number; eventId: string; group: null }[];
  }[] = [];
  let prior: string | null = null;
  for (const original of ordered) {
    const row = originals.find((entry) => entry.row['event_id'] === original.event_id);
    if (!row) throw Error('ORIGINAL_CENSUS_MISMATCH');
    if (original.source_xid !== prior) {
      const commit = transactions.length * 2 + 1;
      transactions.push({
        commitLsn: `0/${commit.toString(16).toUpperCase()}`,
        endLsn: `0/${(commit + 1).toString(16).toUpperCase()}`,
        records: [],
      });
      prior = original.source_xid;
    }
    const transaction = transactions.at(-1);
    if (!transaction) throw Error('ORIGINAL_TRANSACTION_MISSING');
    transaction.records.push({
      stageOrdinal: row.ordinal,
      eventId: original.event_id,
      group: null,
    });
  }
  return {
    profileVersion: 1,
    sourceProfile: {
      registrySha256: source['registrySha256'],
      catalogSha256: source['catalogSha256'],
    },
    targetProfileDigest: z
      .string()
      .parse(
        (await c.query('SELECT target_digest FROM wm_current_original_postimages.profile'))
          .rows[0]?.['target_digest'],
      ),
    originalRowsDigest: descriptor['originalRowsDigest'],
    segments: [
      {
        segmentOrdinal: 1,
        segmentIdentity: {
          localRecordVersion: 2,
          clusterId: source['systemIdentifier'],
          fromLsn: '0/0',
          throughLsn: `0/${(transactions.length * 2).toString(16).toUpperCase()}`,
          previousHash: null,
          sha256: 'c'.repeat(64),
          source: {
            databaseName: name,
            databaseOid: source['databaseOid'],
            slotName: `wm_suppression_${suffix}`,
            publication: 'workout_restore_suppression_events',
            relationProfile: 'suppression-physical-v7',
            captureId: source['captureId'],
            registryFingerprint: source['registrySha256'],
          },
        },
        transactions,
      },
    ],
  };
}
async function beginOriginals(
  c: PoolClient,
  run: string,
  athlete: string,
  snapshot: Awaited<ReturnType<typeof capture>>,
) {
  await c.query('SELECT wm_current_app_load.load_family($1)', [run]);
  const input = await envelope(c, run, athlete, snapshot);
  await c.query('SELECT wm_current_original_postimages.begin_originals($1,$2::jsonb)', [
    run,
    JSON.stringify(input),
  ]);
  await c.query('SELECT wm_current_original_postimages.seal_originals($1)', [run]);
  return input;
}
it('uses every actual public app/race original in explicit transaction order without minting an original', async () => {
  const s = await scenario();
  await createRaceRepository(db).deleteRaceEvent(s.athlete, s.race.id, {
    expectedRevision: s.race.revision,
    idempotencyKey: randomUUID(),
  });
  const snapshot = await capture(s.athlete);
  await withTarget(s.athlete, async (c) => {
    const run = await stage(c, s.athlete, snapshot);
    await beginOriginals(c, run, s.athlete, snapshot);
    const before = await c.query(
      'SELECT event_id::text,kind,occurred_at::text FROM public.restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id',
      [s.athlete],
    );
    await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
    await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
    expect(
      (
        await c.query(
          'SELECT event_id::text,kind,occurred_at::text FROM public.restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id',
          [s.athlete],
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM wm_current_original_postimages.run WHERE run_id=$1',
          [run],
        )
      ).rows[0]?.['n'],
    ).toBe(0);
    expect(
      (
        await c.query('SELECT payload FROM public.manual_race_evidence_v2 WHERE athlete_id=$1', [
          s.athlete,
        ])
      ).rows.every((row) => row['payload'] === null),
    ).toBe(true);
  });
});
it('rejects invented transaction fields before postimages', async () => {
  const s = await scenario(),
    snapshot = await capture(s.athlete);
  await expect(
    withTarget(s.athlete, async (c) => {
      const run = await stage(c, s.athlete, snapshot);
      await c.query('SELECT wm_current_app_load.load_family($1)', [run]);
      const input = await envelope(c, run, s.athlete, snapshot);
      const segment = input.segments[0];
      if (!segment) throw Error('SEGMENT_MISSING');
      const transaction = segment.transactions[0];
      if (!transaction) throw Error('TRANSACTION_MISSING');
      await c.query('SELECT wm_current_original_postimages.begin_originals($1,$2::jsonb)', [
        run,
        JSON.stringify({
          ...input,
          segments: [
            { ...segment, transactions: [{ ...transaction, sourceTransactionId: randomUUID() }] },
          ],
        }),
      ]);
    }),
  ).rejects.toThrow('CURRENT_POST_TRANSACTION_REJECTED');
});
it('retains plain-owner/RLS constraints and denies runtime schema/function access', async () => {
  const s = await scenario(),
    pool = new Pool({ connectionString: targetUrl(runtimeRole) });
  try {
    await expect(
      pool.query('SELECT wm_current_original_postimages.begin_originals($1,$2::jsonb)', [
        randomUUID(),
        '{}',
      ]),
    ).rejects.toThrow('permission denied');
  } finally {
    await pool.end();
  }
  expect(s.race.revision).toBe(1);
});
it('rolls back loaded rows, original membership and every postimage after a later callback failure', async () => {
  const s = await scenario(),
    snapshot = await capture(s.athlete);
  await expect(
    withTarget(s.athlete, async (c) => {
      const run = await stage(c, s.athlete, snapshot);
      await beginOriginals(c, run, s.athlete, snapshot);
      await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
      throw Error('CALLBACK_ROLLBACK');
    }),
  ).rejects.toThrow('CALLBACK_ROLLBACK');
  const pool = new Pool({ connectionString: targetUrl(ownerRole) });
  try {
    await pool.query('BEGIN');
    await pool.query("SELECT set_config('app.athlete_id',$1,true)", [s.athlete]);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM public.race_event WHERE athlete_id=$1', [
          s.athlete,
        ])
      ).rows[0]?.['n'],
    ).toBe(0);
    await pool.query('ROLLBACK');
  } finally {
    await pool.end();
  }
});

function withOriginalTail(
  before: Awaited<ReturnType<typeof capture>>,
  after: Awaited<ReturnType<typeof capture>>,
) {
  const rows = [
    ...before.rows.filter((row) => row.relation !== 'restore_suppression_event'),
    ...after.rows.filter((row) => row.relation === 'restore_suppression_event'),
  ].map((row, index) => ({ ...row, ordinal: index + 1 }));
  return {
    rows,
    census: {
      ...before.census,
      restore_suppression_event: after.census['restore_suppression_event'] ?? 0,
    },
  };
}
async function verifyCheckInOriginal(expectConsumed: boolean) {
  const repository = createCheckInRepository(db);
  const s = await scenario((athlete) =>
    repository.createCheckIn(athlete, {
      idempotencyKey: randomUUID(),
      values: {
        observedAt: '2026-10-06T00:00:00Z',
        timezone: 'Asia/Seoul',
        fatigue: 0,
        discomfort: null,
        bodyLocation: null,
        note: 'synthetic checkin preimage',
      },
    }),
  );
  if (!s.seeded) throw Error('CHECKIN_PRODUCER_MISSING');
  // A deletion can purge only a genuinely consumed copied source. The current
  // public routine producer rejects checkin_template, so this exact assertion
  // exposes that missing producer port instead of manufacturing owner rows or
  // treating an unrelated check-in as a copied-source privacy proof.
  const inspector = new Pool({ connectionString: url(ownerRole) });
  let copiedCount: number;
  let copiedRefCount: number;
  try {
    const c = await inspector.connect();
    try {
      await c.query('BEGIN READ ONLY');
      await c.query("SELECT set_config('app.athlete_id',$1,true)", [s.athlete]);
      const copied = await c.query(
        `SELECT count(*)::int AS n FROM manual_race_chain_lifecycle_edge_v2
       WHERE athlete_id=$1 AND evidence_id=$2 AND edge->>'family'='checkin'
       AND edge->>'sourceId'=$3`,
        [s.athlete, s.stored.result.evidenceId, s.seeded?.id],
      );
      copiedCount = z.number().int().nonnegative().parse(copied.rows[0]?.['n']);
      copiedRefCount = z
        .number()
        .int()
        .nonnegative()
        .parse(
          (
            await c.query(
              `SELECT count(*)::int AS n FROM manual_race_chain_source_ref_v2
         WHERE athlete_id=$1 AND evidence_id=$2 AND identity->>'kind'='checkin-revision'
         AND identity->>'sourceId'=$3`,
              [s.athlete, s.stored.result.evidenceId, s.seeded?.id],
            )
          ).rows[0]?.['n'],
        );
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  } finally {
    await inspector.end();
  }
  if (expectConsumed)
    expect(copiedCount, 'public consumed CheckIn producer port required').toBeGreaterThan(0);
  else {
    expect(copiedCount, 'unrelated CheckIn must not invent a copied edge').toBe(0);
    expect(copiedRefCount, 'unconsumed CheckIn has no copied DTO digest').toBe(0);
  }
  const before = await capture(s.athlete);
  await repository.deleteCheckIn(s.athlete, s.seeded.id, {
    idempotencyKey: randomUUID(),
    expectedRevision: s.seeded.revision,
  });
  const snapshot = withOriginalTail(before, await capture(s.athlete));
  await withTarget(s.athlete, async (c) => {
    const run = await stage(c, s.athlete, snapshot);
    await beginOriginals(c, run, s.athlete, snapshot);
    const original = z
      .object({ event_id: z.uuid(), occurred_at: z.string() })
      .parse(
        (
          await c.query(
            "SELECT event_id::text,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS occurred_at FROM public.restore_suppression_event WHERE athlete_id=$1 AND kind='check_in_deleted'",
            [s.athlete],
          )
        ).rows[0],
      );
    const originalEvidence = z
      .strictObject({
        payload_present: z.boolean(),
        payload_digest: z.string(),
        original_payload_sql_digest: z.string(),
      })
      .parse(
        (
          await c.query(
            `SELECT payload IS NOT NULL AS payload_present,
       wm_current_app_load.hash_json(payload) AS payload_digest,original_payload_sql_digest
       FROM public.manual_race_evidence_v2 WHERE athlete_id=$1`,
            [s.athlete],
          )
        ).rows[0],
      );
    expect(originalEvidence.payload_present).toBe(true);
    await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
    expect(
      (
        await c.query(
          'SELECT deleted,values_json,local_date FROM public.check_in WHERE athlete_id=$1 AND id=$2',
          [s.athlete, s.seeded?.id],
        )
      ).rows[0],
    ).toEqual({ deleted: true, values_json: null, local_date: null });
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM public.check_in_revision WHERE athlete_id=$1 AND check_in_id=$2',
          [s.athlete, s.seeded?.id],
        )
      ).rows[0]?.['n'],
    ).toBe(0);
    const payloads = (
      await c.query(
        `SELECT payload IS NULL AS payload_purged,purged_event_id::text,to_char(purged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purged_at FROM public.manual_race_evidence_v2 WHERE athlete_id=$1`,
        [s.athlete],
      )
    ).rows;
    expect(payloads).toHaveLength(1);
    if (expectConsumed) {
      expect(payloads[0]).toEqual({
        payload_purged: true,
        purged_event_id: original.event_id,
        purged_at: original.occurred_at,
      });
    } else {
      expect(payloads[0]).toEqual({
        payload_purged: false,
        purged_event_id: null,
        purged_at: null,
      });
      const retained = (
        await c.query(
          `SELECT payload IS NOT NULL AS payload_present,
         wm_current_app_load.hash_json(payload) AS payload_digest,original_payload_sql_digest
         FROM public.manual_race_evidence_v2 WHERE athlete_id=$1`,
          [s.athlete],
        )
      ).rows[0];
      expect(retained).toEqual(originalEvidence);
    }
    await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
  });
}
it('reapplies a public CheckIn original, deletes its body/history and preserves a genuinely unrelated chain', async () => {
  await verifyCheckInOriginal(false);
});
// not_executed: public saveBlueprint rejects checkin_template with
// CONTENT_REFERENCE_UNAVAILABLE. No owner run/catalog seed substitutes for a
// genuinely consumed source. The original positive purge expectation remains
// here, separate from the runnable original-body deletion acceptance and R1.
it.skip('purges copied CheckIn payload/header after genuine public consumed-edge producer becomes available', async () => {
  await verifyCheckInOriginal(true);
});

for (const ledger of ['result', 'best'] as const) {
  it(`rechecks the restored ${ledger} preimage against its genuine deletion original without minting another event`, async () => {
    const repository = createRaceRepository(db);
    const s = await scenario((athlete) =>
      ledger === 'result'
        ? repository.createRaceResult(athlete, {
            idempotencyKey: randomUUID(),
            values: {
              kind: 'race-result',
              raceEventId: null,
              localDate: '2026-10-04',
              timezone: 'Asia/Seoul',
              source: {
                kind: 'official',
                authority: 'Synthetic authority',
                resultUrl: 'https://example.org/private-result',
              },
              chipSeconds: 0,
              gunSeconds: null,
              officialDistanceMeters: null,
              deviceDistanceMeters: 10042,
              linkedActivityId: null,
              weatherNote: 'Synthetic retained zero/null',
            },
          })
        : repository.createTrainingBest(athlete, {
            idempotencyKey: randomUUID(),
            values: {
              kind: 'training-best',
              observedAt: '2026-10-03T08:00:00+09:00',
              source: { kind: 'manual' },
              basis: 'user-entered',
              distanceMeters: null,
              elapsedSeconds: 0,
            },
          }),
    );
    const saved = s.seeded;
    if (!saved) throw Error('PUBLIC_LEDGER_PRODUCER_MISSING');
    const before = await capture(s.athlete);
    if (ledger === 'result')
      await repository.deleteRaceResult(s.athlete, saved.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: saved.revision,
      });
    else
      await repository.deleteTrainingBest(s.athlete, saved.id, {
        idempotencyKey: randomUUID(),
        expectedRevision: saved.revision,
      });
    const snapshot = withOriginalTail(before, await capture(s.athlete));
    await withTarget(s.athlete, async (c) => {
      const run = await stage(c, s.athlete, snapshot);
      await beginOriginals(c, run, s.athlete, snapshot);
      const originalCount = (
        await c.query(
          'SELECT count(*)::int AS n FROM public.restore_suppression_event WHERE athlete_id=$1',
          [s.athlete],
        )
      ).rows[0]?.['n'];
      await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
      const table = ledger === 'result' ? 'race_result' : 'training_best';
      expect(
        (
          await c.query(
            `SELECT revision,deleted,values_json FROM public.${table} WHERE athlete_id=$1 AND id=$2`,
            [s.athlete, saved.id],
          )
        ).rows[0],
      ).toEqual({ revision: saved.revision + 1, deleted: true, values_json: null });
      expect(
        (
          await c.query(
            'SELECT count(*)::int AS n FROM public.restore_suppression_event WHERE athlete_id=$1',
            [s.athlete],
          )
        ).rows[0]?.['n'],
      ).toBe(originalCount);
      expect(
        (
          await c.query(
            'SELECT payload IS NOT NULL AS retained FROM public.manual_race_evidence_v2 WHERE athlete_id=$1',
            [s.athlete],
          )
        ).rows[0]?.['retained'],
      ).toBe(true);
      await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
    });
  });
}

const unknownNutrient = <U extends 'kcal' | 'g' | 'mL' | 'mg'>(unit: U) => ({
  value: null,
  unit,
  status: 'unknown' as const,
  evidenceIds: [],
});
const nutrients = () => ({
  energy: unknownNutrient('kcal'),
  carbohydrate: unknownNutrient('g'),
  protein: unknownNutrient('g'),
  fat: unknownNutrient('g'),
  fluid: unknownNutrient('mL'),
  sodium: unknownNutrient('mg'),
});
async function generation(athlete: string) {
  return db.tenant(athlete, async (tx) =>
    z
      .uuid()
      .parse((await tx.query('SELECT public.current_restore_generation() AS id')).rows[0]?.['id']),
  );
}
it('keeps opaque intake identity and active history while installing the genuine deletion revision without a new original', async () => {
  const repository = createNutritionRepository(db);
  const s = await scenario(async (athlete) => {
    const food = await repository.saveFood(athlete, {
      idempotencyKey: randomUUID(),
      expectedVersionId: null,
      confirmed: true,
      definition: {
        foodId: 'opaque-food-' + randomUUID(),
        name: 'Synthetic oats',
        basis: { kind: 'per_100g' },
        nutrients: nutrients(),
        provenance: {
          kind: 'user_entered',
          reference: null,
          capturedAt: '2026-09-18T00:00:00.000Z',
          reviewState: 'unreviewed',
        },
      },
    });
    const intake = await repository.createIntake(athlete, {
      idempotencyKey: randomUUID(),
      restoreGeneration: await generation(athlete),
      intakeId: 'opaque-intake-' + randomUUID(),
      confirmed: true,
      occurredAt: '2026-09-18T08:00:00.000Z',
      timezone: 'UTC',
      foods: [
        {
          foodVersionId: food.versionId,
          description: 'Oats',
          quantity: 0,
          unit: 'g',
          sourceBasis: 'per_100g',
        },
      ],
      nutrientTotal: nutrients(),
      plannedItemId: null,
      relatedSessionIds: [],
      relatedActivityIds: [],
      source: 'user',
      sourceRecordId: null,
      notes: null,
    });
    return { food, intake };
  });
  const saved = s.seeded;
  if (!saved) throw Error('INTAKE_PRODUCER_MISSING');
  const before = await capture(s.athlete);
  await repository.deleteIntake(s.athlete, {
    intakeId: saved.intake.intakeId,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
    confirmed: true,
    reason: 'user_requested',
  });
  const snapshot = withOriginalTail(before, await capture(s.athlete));
  await withTarget(s.athlete, async (c) => {
    const run = await stage(c, s.athlete, snapshot);
    await beginOriginals(c, run, s.athlete, snapshot);
    const originals = (
      await c.query(
        'SELECT count(*)::int AS n FROM restore_suppression_event WHERE athlete_id=$1',
        [s.athlete],
      )
    ).rows[0]?.['n'];
    await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
    expect(
      (
        await c.query(
          'SELECT id,current_revision,status FROM intake_entry WHERE athlete_id=$1 AND id=$2',
          [s.athlete, saved.intake.intakeId],
        )
      ).rows[0],
    ).toEqual({ id: saved.intake.intakeId, current_revision: 2, status: 'deleted' });
    expect(
      (
        await c.query(
          'SELECT revision,status FROM intake_entry_revision WHERE athlete_id=$1 AND intake_id=$2 ORDER BY revision',
          [s.athlete, saved.intake.intakeId],
        )
      ).rows,
    ).toEqual([
      { revision: 1, status: 'active' },
      { revision: 2, status: 'deleted' },
    ]);
    expect(
      (
        await c.query(
          'SELECT food_id FROM food_definition_version WHERE athlete_id=$1 AND version_id=$2',
          [s.athlete, saved.food.versionId],
        )
      ).rows[0]?.['food_id'],
    ).toBe(saved.food.foodId);
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM restore_suppression_event WHERE athlete_id=$1',
          [s.athlete],
        )
      ).rows[0]?.['n'],
    ).toBe(originals);
    await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
  });
});
it('installs the exact recovery action tombstone but preserves its immutable method and active history', async () => {
  const repository = createRecoveryRepository(db);
  const s = await scenario(async (athlete) => {
    const method = await repository.createMethod(athlete, {
      title: 'Synthetic rest',
      category: 'rest',
      intendedUse: 'User tracking',
      applicability: [],
      cautions: [],
      sourceDescription: 'User input',
      evidenceLimitations: 'Unreviewed',
      idempotencyKey: randomUUID(),
    });
    const action = await repository.createAction(athlete, {
      restoreGeneration: await generation(athlete),
      methodVersionId: method.versionId,
      strategyVersionId: null,
      plannedOptionId: null,
      occurredAt: '2026-09-18T08:00:00Z',
      timezone: 'UTC',
      state: 'performed',
      durationSeconds: null,
      actualConditions: 'Quiet',
      beforeCheckIn: null,
      afterCheckIn: null,
      discomfort: '',
      userNotes: 'Synthetic record',
      source: 'user_confirmed',
      idempotencyKey: randomUUID(),
    });
    return { method, action };
  });
  const saved = s.seeded;
  if (!saved) throw Error('ACTION_PRODUCER_MISSING');
  const before = await capture(s.athlete);
  await repository.deleteAction(s.athlete, {
    actionId: saved.action.actionId,
    expectedRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const snapshot = withOriginalTail(before, await capture(s.athlete));
  await withTarget(s.athlete, async (c) => {
    const run = await stage(c, s.athlete, snapshot);
    await beginOriginals(c, run, s.athlete, snapshot);
    await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
    expect(
      (
        await c.query(
          'SELECT revision,status FROM recovery_action_log WHERE athlete_id=$1 AND action_id=$2',
          [s.athlete, saved.action.actionId],
        )
      ).rows[0],
    ).toEqual({ revision: 2, status: 'deleted' });
    expect(
      (
        await c.query(
          'SELECT revision,status FROM recovery_action_revision WHERE athlete_id=$1 AND action_id=$2 ORDER BY revision',
          [s.athlete, saved.action.actionId],
        )
      ).rows,
    ).toEqual([
      { revision: 1, status: 'active' },
      { revision: 2, status: 'deleted' },
    ]);
    expect(
      (
        await c.query(
          'SELECT method_id FROM recovery_method_version WHERE athlete_id=$1 AND version_id=$2',
          [s.athlete, saved.method.versionId],
        )
      ).rows[0]?.['method_id'],
    ).toBe(saved.method.methodId);
    await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
  });
});

async function stageFamily(
  c: PoolClient,
  run: string,
  family: string,
  snapshot: Awaited<ReturnType<typeof capture>>,
) {
  for (const row of snapshot.rows)
    row.rowDigest = z
      .string()
      .parse(
        (
          await c.query('SELECT wm_current_app_load.hash_json($1::jsonb) AS digest', [
            JSON.stringify(row.row),
          ])
        ).rows[0]?.['digest'],
      );
  const rowsDigest = z
    .string()
    .parse(
      (
        await c.query(
          `SELECT wm_current_app_load.hash_json(coalesce(jsonb_agg(jsonb_build_object('ordinal',(r->>'ordinal')::int,'relation',r->>'relation','rowDigest',r->>'rowDigest') ORDER BY (r->>'ordinal')::int),'[]'::jsonb)) AS digest FROM jsonb_array_elements($1::jsonb) r`,
          [JSON.stringify(snapshot.rows)],
        )
      ).rows[0]?.['digest'],
    );
  const catalogDigest = z
    .string()
    .parse(
      (await c.query('SELECT target_digest FROM wm_current_original_postimages.profile')).rows[0]?.[
        'target_digest'
      ],
    );
  await c.query('SELECT wm_current_original_postimages.stage_family($1,$2,$3::jsonb)', [
    run,
    family,
    JSON.stringify({
      profileVersion: 1,
      catalogDigest,
      relationCensus: snapshot.census,
      rowsDigest,
    }),
  ]);
  for (const row of snapshot.rows)
    await c.query(
      'SELECT wm_current_original_postimages.stage_family_row($1,$2,$3,$4,$5::jsonb,$6)',
      [run, family, row.ordinal, row.relation, JSON.stringify(row.row), row.rowDigest],
    );
  await c.query('SELECT wm_current_original_postimages.seal_family($1,$2)', [run, family]);
}
it('reapplies a real manual Activity original with exact source suppression and sealed empty track/HK partitions', async () => {
  const repository = createActivityRepository(db);
  const s = await scenario((athlete) =>
    repository.createManualActivity(athlete, {
      idempotencyKey: randomUUID(),
      confirmed: true,
      activity: {
        title: 'Manual zero/null',
        kind: 'running',
        startedAt: '2026-10-06T00:00:00Z',
        timezone: 'Asia/Seoul',
        durationSeconds: 0,
        durationKind: 'timer',
        distanceMeters: 0,
      },
      report: { sessionRpe: null, note: null, planLink: null },
    }),
  );
  const created = s.seeded;
  if (!created) throw Error('ACTIVITY_PRODUCER_MISSING');
  const actual = await repository.getActivity(s.athlete, created.activityId);
  if (!actual) throw Error('ACTIVITY_READ_MISSING');
  const before = await capture(s.athlete),
    family = await capture(s.athlete, 'activity_deleted');
  await repository.deleteActivity(s.athlete, actual.id, { expectedRevision: actual.revision });
  const snapshot = withOriginalTail(before, await capture(s.athlete));
  await withTarget(s.athlete, async (c) => {
    const run = await stage(c, s.athlete, snapshot);
    await beginOriginals(c, run, s.athlete, snapshot);
    await stageFamily(c, run, 'activity_deleted', family);
    await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
    expect(
      (
        await c.query(
          'SELECT revision,deleted FROM activity_canonical WHERE athlete_id=$1 AND id=$2',
          [s.athlete, actual.id],
        )
      ).rows[0],
    ).toEqual({ revision: actual.revision + 1, deleted: true });
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM activity_suppression WHERE athlete_id=$1 AND kind=$2 AND source_id=$3',
          [s.athlete, actual.source.kind, actual.source.sourceId],
        )
      ).rows[0]?.['n'],
    ).toBe(1);
    expect(
      (
        await c.query('SELECT original FROM activity_canonical WHERE athlete_id=$1 AND id=$2', [
          s.athlete,
          actual.id,
        ])
      ).rows[0]?.['original'],
    ).toEqual(actual.original);
    await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
  });
});

it('rejects duplicate real event membership and invalid initial segment hashes before mutation', async () => {
  const s = await scenario(),
    snapshot = await capture(s.athlete);
  for (const mode of ['duplicate', 'hash'] as const) {
    await expect(
      withTarget(s.athlete, async (c) => {
        const run = await stage(c, s.athlete, snapshot);
        await c.query('SELECT wm_current_app_load.load_family($1)', [run]);
        const input = await envelope(c, run, s.athlete, snapshot),
          segment = input.segments[0],
          transaction = segment?.transactions[0],
          record = transaction?.records[0];
        if (!segment || !transaction || !record) throw Error('ORIGINAL_FIXTURE_MISSING');
        const changed =
          mode === 'hash'
            ? {
                ...input,
                segments: [
                  {
                    ...segment,
                    segmentIdentity: { ...segment.segmentIdentity, previousHash: 'not-a-sha256' },
                  },
                ],
              }
            : {
                ...input,
                segments: [
                  {
                    ...segment,
                    transactions: [
                      { ...transaction, records: [...transaction.records, record] },
                      ...segment.transactions.slice(1),
                    ],
                  },
                ],
              };
        await c.query('SELECT wm_current_original_postimages.begin_originals($1,$2::jsonb)', [
          run,
          JSON.stringify(changed),
        ]);
      }),
    ).rejects.toThrow(
      mode === 'hash' ? 'CURRENT_POST_SEGMENT_REJECTED' : 'CURRENT_POST_MEMBER_DUPLICATE',
    );
  }
});

for (const kind of ['ai', 'healthkit'] as const) {
  it(`rechecks genuine ${kind} grant/withdrawal originals with a sealed explicitly empty derived/raw partition`, async () => {
    const s = await scenario(),
      repository = createConsentRepository(db);
    await repository.setConsent(s.athlete, {
      kind,
      granted: true,
      expectedRevision: 0,
      idempotencyKey: randomUUID(),
    });
    await repository.setConsent(s.athlete, {
      kind,
      granted: false,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    const snapshot = await capture(s.athlete),
      family = await capture(s.athlete, `${kind}_consent_transition`);
    expect(family.rows.filter((row) => row.relation !== 'consent')).toHaveLength(0);
    await withTarget(s.athlete, async (c) => {
      const run = await stage(c, s.athlete, snapshot);
      await beginOriginals(c, run, s.athlete, snapshot);
      await stageFamily(c, run, `${kind}_consent_transition`, family);
      const before = (
        await c.query(
          'SELECT event_id::text,kind,occurred_at::text FROM restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id',
          [s.athlete],
        )
      ).rows;
      await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
      expect(
        (
          await c.query('SELECT granted,revision FROM consent WHERE athlete_id=$1 AND kind=$2', [
            s.athlete,
            kind,
          ])
        ).rows[0],
      ).toEqual({ granted: false, revision: 2 });
      expect(
        (
          await c.query(
            'SELECT event_id::text,kind,occurred_at::text FROM restore_suppression_event WHERE athlete_id=$1 ORDER BY event_id',
            [s.athlete],
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await c.query(
            'SELECT payload IS NOT NULL AS retained FROM manual_race_evidence_v2 WHERE athlete_id=$1',
            [s.athlete],
          )
        ).rows[0]?.['retained'],
      ).toBe(true);
      await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
    });
  });
}

it('reapplies genuine course deletion to a retained imported descriptor and records the original deletion time without geometry resurrection', async () => {
  const repository = createCourseRepository(db);
  const s = await scenario((athlete) =>
    repository.create(
      athlete,
      {
        name: 'Synthetic imported course',
        coordinates: [
          [126.97, 37.56],
          [126.971, 37.561],
        ],
        waypoints: [
          {
            role: 'start',
            position: [126.97, 37.56],
            name: null,
            sourceSampleId: null,
            locked: false,
          },
          {
            role: 'finish',
            position: [126.971, 37.561],
            name: null,
            sourceSampleId: null,
            locked: false,
          },
        ],
        generation: {
          kind: 'imported-file',
          format: 'gpx',
          sourceKind: 'gpx-trk',
          itemIndex: 0,
          parserId: 'gpx-track-v1',
          parserVersion: 1,
          fileSha256: 'a'.repeat(64),
          fileByteLength: 200,
          originalFilename: null,
          fileCreator: null,
          vertexCount: 2,
          importedWaypointCount: 0,
          ignoredFileWaypointCount: 0,
        },
        edit: { kind: 'imported' },
        lineage: [],
        distanceMeters: 100,
        contentDigest: createHash('sha256').update('synthetic course descriptor').digest('hex'),
      },
      `course-${randomUUID()}`,
    ),
  );
  const course = s.seeded;
  if (!course || course.status !== 'available') throw Error('COURSE_PRODUCER_MISSING');
  const before = await capture(s.athlete);
  await repository.remove(s.athlete, course.course.courseId, course.course.headRevision);
  const snapshot = withOriginalTail(before, await capture(s.athlete));
  await withTarget(s.athlete, async (c) => {
    const run = await stage(c, s.athlete, snapshot);
    await beginOriginals(c, run, s.athlete, snapshot);
    await c.query('SELECT wm_current_original_postimages.apply_postimages($1)', [run]);
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM course_revision WHERE athlete_id=$1 AND course_id=$2',
          [s.athlete, course.course.courseId],
        )
      ).rows[0]?.['n'],
    ).toBe(0);
    expect(
      (
        await c.query(
          'SELECT count(*)::int AS n FROM course WHERE athlete_id=$1 AND course_id=$2 AND status=$3',
          [s.athlete, course.course.courseId, 'available'],
        )
      ).rows[0]?.['n'],
    ).toBe(0);
    expect(
      (
        await c.query(
          `SELECT d.deleted_at=e.occurred_at AS exact FROM course_deletion d JOIN restore_suppression_event e ON e.athlete_id=d.athlete_id AND e.target_id=d.course_id AND e.kind='course_deleted' WHERE d.athlete_id=$1 AND d.course_id=$2`,
          [s.athlete, course.course.courseId],
        )
      ).rows[0]?.['exact'],
    ).toBe(true);
    await c.query('SELECT wm_current_original_postimages.finish_originals($1)', [run]);
  });
});
