import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createRaceManualSemanticBasisV2Service } from '../src/race-manual-review-semantic-basis-v2.js';
import { createRaceManualReviewChainV2Repository } from '../src/race-manual-review-chain-v2.js';
import {
  createCurrentFamilyArtifactVerifier,
  currentFamilyRelations,
  currentFamilyRowsSha256,
  signCurrentFamilyArtifact,
  type CurrentFamilyConfiguredIdentity,
} from '../src/restore-current-family-artifact.js';
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
const name = `current_family_${suffix}`,
  ownerRole = `current_family_owner_${suffix}`,
  runtimeRole = `current_family_app_${suffix}`;
const admin = new Pool({ connectionString: adminUrl });
const roles: string[] = [];
let created = false;
let db: Database;
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
  db = createDatabase({ connectionString: url(runtimeRole), max: 2 });
}, 60000);
afterAll(async () => {
  await db?.close();
  if (created) await dropIsolatedDatabase(admin, name);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
const columnSchema = z.strictObject({ name: z.string(), type: z.string(), nullable: z.boolean() });
const physicalRowSchema = z.record(z.string(), z.unknown());
async function capture(athleteId: string) {
  const owner = new Pool({ connectionString: url(ownerRole), max: 1 });
  const client = await owner.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('app.athlete_id',$1,true)", [athleteId]);
    const catalog: { relation: string; columns: z.infer<typeof columnSchema>[] }[] = [];
    const rows: { ordinal: number; relation: string; row: Record<string, unknown> }[] = [];
    const countMap = new Map<string, number>();
    let capturedBytes = 0n;
    for (const relation of currentFamilyRelations) {
      const result = await client.query(
        `SELECT a.attname AS name,t.typname AS type,NOT a.attnotnull AS nullable
        FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
        WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [`public.${relation}`],
      );
      const columns = z.array(columnSchema).min(1).parse(result.rows);
      catalog.push({ relation, columns });
      const fields = columns.flatMap((c) => {
        const field = `s.${quote(c.name)}`;
        // Physical SQL encodings, not Date/Number driver coercion. Preserve NULL.
        const expression =
          c.type === 'timestamptz'
            ? `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
            : c.type === 'bytea'
              ? `CASE WHEN ${field} IS NULL THEN NULL ELSE '\\x'||encode(${field},'hex') END`
              : c.type === 'int8' || c.type === 'name'
                ? `${field}::text`
                : field;
        return [literal(c.name), expression];
      });
      const scalar = await client.query(
        `SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(s)::text)),0)::text AS bytes FROM public.${quote(relation)} s WHERE s.athlete_id=$1`,
        [athleteId],
      );
      const bounds = z
        .strictObject({ count: z.string().regex(/^[0-9]+$/), bytes: z.string().regex(/^[0-9]+$/) })
        .parse(scalar.rows[0]);
      capturedBytes += BigInt(bounds.bytes);
      if (
        BigInt(bounds.count) > 5000n ||
        rows.length + Number(bounds.count) > 5000 ||
        capturedBytes > 16n * 1024n * 1024n
      )
        throw Error('CHILD_CAPTURE_LIMIT');
      const found = await client.query(
        `SELECT jsonb_build_object(${fields.join(',')}) AS row FROM public.${quote(relation)} s
        WHERE s.athlete_id=$1 ORDER BY to_jsonb(s)::text COLLATE "C"`,
        [athleteId],
      );
      countMap.set(relation, found.rows.length);
      for (const entry of found.rows)
        rows.push({
          ordinal: rows.length + 1,
          relation,
          row: physicalRowSchema.parse(entry['row']),
        });
    }
    const registry = (
      await client.query('SELECT version,checksum FROM schema_migrations ORDER BY version')
    ).rows;
    const databaseOid = z
      .number()
      .int()
      .positive()
      .parse(
        (
          await client.query(
            'SELECT oid::int AS oid FROM pg_database WHERE datname=current_database()',
          )
        ).rows[0]?.['oid'],
      );
    const lsn = z
      .string()
      .parse((await client.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0]?.['lsn']);
    await client.query('COMMIT');
    const systemIdentifier = z
      .string()
      .parse(
        (await admin.query('SELECT system_identifier::text AS id FROM pg_control_system()'))
          .rows[0]?.['id'],
      );
    const generationId = await db.tenant(athleteId, async (tx) =>
      z
        .uuid()
        .parse(
          (await tx.query('SELECT public.current_restore_generation()::text AS id')).rows[0]?.[
            'id'
          ],
        ),
    );
    const count = (relation: string) => {
      const n = countMap.get(relation);
      if (n === undefined) throw Error('CENSUS_INCOMPLETE');
      return n;
    };
    expect(count('manual_race_v2_live_transition')).toBe(0);
    const expected: CurrentFamilyConfiguredIdentity = {
      profile: {
        profileVersion: 1,
        normalSchemaVersion: 107,
        explicitVersions: [108, 109, 110, 111, 112, 113, 114, 115, 116],
        rowEncoding: 'utc-microseconds-decimal-bigint-hex-bytea-v1',
        relationProfileSha256: digest(catalog),
      },
      source: {
        systemIdentifier,
        databaseOid,
        captureId: randomUUID(),
        generationId,
        registrySha256: digest(registry),
        catalogSha256: digest(catalog),
        baselineThroughLsn: lsn,
      },
      identity: {
        artifactId: randomUUID(),
        athleteId,
        sourceKeyId: 'isolated-current-family',
        sourceKeyVersion: 1,
      },
      count: rows.length,
      rowsSha256: currentFamilyRowsSha256(rows),
      relationCounts: {
        nutrition_race_item_disconnection: count('nutrition_race_item_disconnection'),
        nutrition_integrated_candidate_disconnection: count(
          'nutrition_integrated_candidate_disconnection',
        ),
        race_result_proof_ref: count('race_result_proof_ref'),
        nutrition_race_disconnection_lineage: count('nutrition_race_disconnection_lineage'),
        nutrition_v4_commit_seal: count('nutrition_v4_commit_seal'),
        plan_snapshot_aggregate: count('plan_snapshot_aggregate'),
        manual_race_evidence_v2: count('manual_race_evidence_v2'),
        manual_race_decision_v2: count('manual_race_decision_v2'),
        manual_race_proposal_v2: count('manual_race_proposal_v2'),
        manual_race_chain_source_ref_v2: count('manual_race_chain_source_ref_v2'),
        manual_race_chain_lifecycle_edge_v2: count('manual_race_chain_lifecycle_edge_v2'),
        manual_race_chain_suppression_v2: count('manual_race_chain_suppression_v2'),
        manual_race_chain_receipt_v2: count('manual_race_chain_receipt_v2'),
        manual_race_chain_commit_v2: count('manual_race_chain_commit_v2'),
        manual_race_v2_live_transition: 0,
      },
    };
    return {
      expected,
      body: {
        ...expected,
        artifactVersion: 1,
        rows,
        parentCoverage: 'not_authenticated',
        originalTailCoverage: 'not_authenticated',
      },
      catalog,
    };
  } finally {
    client.release();
    await owner.end();
  }
}
async function scenario() {
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
      title: 'Synthetic child codec',
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
  return { athlete, race, command, stored, repository };
}
function verify(c: Awaited<ReturnType<typeof capture>>, key: Uint8Array = randomBytes(32)) {
  const factory = createCurrentFamilyArtifactVerifier({
    expected: c.expected,
    resolveSourceKey: () => key,
  });
  const handle = factory.prepareVerifiedCurrentFamilyArtifact(
    signCurrentFamilyArtifact(c.body, key),
  );
  return factory.withVerifiedCurrentFamilyArtifact(handle, (body, limits) => ({
    body,
    limits,
    handle,
  }));
}
it('authenticates actual physical15 census with public chain rows, UTC6µs/text bigint/hex bytea and empty transition, without parent authority', async () => {
  const f = await scenario(),
    c = await capture(f.athlete),
    result = verify(c);
  expect(c.catalog.map((x) => x.relation)).toEqual(currentFamilyRelations);
  expect(result.body.rows).toEqual(c.body.rows);
  expect(result.limits).toMatchObject({
    parentClosure: 'blocked',
    originalTailStage: 'unavailable',
    authority: 'none',
    admissionAllowed: false,
    historicalSeals: 'audit_only',
  });
  const header = c.body.rows.find((x) => x.relation === 'manual_race_evidence_v2');
  expect(header?.row['created_at']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  expect(header?.row).toHaveProperty('purged_at', null);
  expect(header?.row).toHaveProperty('purged_event_id', null);
  const commit = c.body.rows.find((x) => x.relation === 'manual_race_chain_commit_v2');
  expect(commit?.row['owner_xid']).toMatch(/^[0-9]+$/);
  expect(commit?.row['payload_hash']).toMatch(/^\\x[0-9a-f]{64}$/);
  // Six producer families are empty in this fixture; these are census-only.
  for (const relation of currentFamilyRelations.slice(0, 6))
    expect(c.body.rows.some((x) => x.relation === relation)).toBe(false);
});
it('rejects physical NULL omission, microsecond truncation, bytea/bigint driver coercion and duplicate PK', async () => {
  const c = await capture((await scenario()).athlete),
    key = randomBytes(32);
  for (const mutate of [
    (row: Record<string, unknown>) => {
      delete row['purged_at'];
    },
    (row: Record<string, unknown>) => {
      row['created_at'] = '2026-10-08T00:00:00.123Z';
    },
  ]) {
    const body = structuredClone(c.body),
      row = body.rows.find((x) => x.relation === 'manual_race_evidence_v2');
    if (!row) throw Error('HEADER_MISSING');
    mutate(row.row);
    expect(() => {
      body.rowsSha256 = currentFamilyRowsSha256(body.rows);
      return signCurrentFamilyArtifact(body, key);
    }).toThrow();
  }
  for (const [field, value] of [
    ['owner_xid', 123],
    ['payload_hash', '00'],
  ] as const) {
    const body = structuredClone(c.body),
      row = body.rows.find((x) => x.relation === 'manual_race_chain_commit_v2');
    if (!row) throw Error('COMMIT_MISSING');
    row.row[field] = value;
    expect(() => {
      body.rowsSha256 = currentFamilyRowsSha256(body.rows);
      return signCurrentFamilyArtifact(body, key);
    }).toThrow();
  }
  const body = structuredClone(c.body),
    first = body.rows[0];
  if (!first) throw Error('ROWS_MISSING');
  body.rows.push({ ...structuredClone(first), ordinal: body.rows.length + 1 });
  body.count++;
  body.rowsSha256 = currentFamilyRowsSha256(body.rows);
  expect(() => signCurrentFamilyArtifact(body, key)).toThrow();
});
it('rejects wrong expected source/key, foreign tenant rows and incomplete physical census', async () => {
  const c = await capture((await scenario()).athlete),
    key = randomBytes(32),
    bytes = signCurrentFamilyArtifact(c.body, key);
  for (const expected of [
    {
      ...c.expected,
      source: { ...c.expected.source, databaseOid: c.expected.source.databaseOid + 1 },
    },
    { ...c.expected, identity: { ...c.expected.identity, athleteId: randomUUID() } },
  ]) {
    const factory = createCurrentFamilyArtifactVerifier({ expected, resolveSourceKey: () => key });
    expect(() => factory.prepareVerifiedCurrentFamilyArtifact(bytes)).toThrow();
  }
  expect(() =>
    createCurrentFamilyArtifactVerifier({
      expected: c.expected,
      resolveSourceKey: () => randomBytes(32),
    }).prepareVerifiedCurrentFamilyArtifact(bytes),
  ).toThrow();
  const foreign = structuredClone(c.body);
  for (const row of foreign.rows) row.row['athlete_id'] = randomUUID();
  // Strict row correspondence may reject before signing; either boundary must reject.
  expect(() => {
    foreign.rowsSha256 = currentFamilyRowsSha256(foreign.rows);
    signCurrentFamilyArtifact(foreign, key);
  }).toThrow();
  expect(() =>
    signCurrentFamilyArtifact(
      {
        ...c.body,
        relationCounts: { ...c.body.relationCounts, manual_race_v2_live_transition: 1 },
      },
      key,
    ),
  ).toThrow();
  expect(() =>
    signCurrentFamilyArtifact(
      { ...c.body, relationCounts: { ...c.body.relationCounts, manual_race_decision_v2: 0 } },
      key,
    ),
  ).toThrow();
});
it('captures genuine race purge NULL body and original minimal receipt/event rows without resurrecting or minting tail authority', async () => {
  const f = await scenario();
  await createRaceRepository(db).deleteRaceEvent(f.athlete, f.race.id, {
    expectedRevision: f.race.revision,
    idempotencyKey: randomUUID(),
  });
  expect(await f.repository.read(f.athlete, f.stored.result.evidenceId)).toEqual({
    schemaVersion: 2,
    result: f.stored.result,
    payload: null,
  });
  expect((await f.repository.store(f.athlete, f.command)).status).toBe('replayed');
  const c = await capture(f.athlete),
    result = verify(c);
  expect(c.expected.relationCounts.manual_race_chain_suppression_v2).toBeGreaterThan(0);
  const header = result.body.rows.find((x) => x.relation === 'manual_race_evidence_v2');
  expect(header?.row['payload']).toBeNull();
  expect(header?.row['purged_at']).toMatch(/\.\d{6}Z$/);
  expect(result.handle).toMatchObject({
    parentClosure: 'blocked',
    originalTailStage: 'unavailable',
    authority: 'none',
    admissionAllowed: false,
  });
});
