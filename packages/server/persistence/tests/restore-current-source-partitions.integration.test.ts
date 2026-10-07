import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/database.js';
import { createIdentityRepository, type IdentityRepository } from '../src/identity.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createPrivateTextResourceRepository } from '../src/resources.js';
import {
  migrate,
  grantCorePlanning,
  grantOperations,
  grantRaces,
  grantResources,
  grantIdentityFunctions,
} from '../src/migrate.js';
import { CURRENT_PARENT_TYPED_RELATIONS } from '../src/restore-current-parent-artifact.js';
import { currentFamilyRelations } from '../src/restore-current-family-artifact.js';
import {
  currentSourceExtraRelations,
  currentSourceExtraPhysicalRoster,
  currentSourceExtraDisposition,
  parseCurrentSourceExtraPhysicalRows,
  currentSourceExtraPhysicalRowsSha256,
  currentSourceExtraPhysicalPrimaryKey,
  type CurrentSourceExtraRelation,
} from '../src/restore-current-source-partitions.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root-only actual PG. No plaintext archive is published. Credential rows below
// are synthetic public identity outputs, parsed only in local memory; no bodies in assertions/logs.
const enabled = Boolean(process.env['TEST_DATABASE_ADMIN_URL']);
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12),
  name = `source_partition_${suffix}`,
  ownerRole = `source_partition_owner_${suffix}`,
  runtimeRole = `source_partition_app_${suffix}`;
const roles: string[] = [];
let created = false;
let admin: Pool,
  owner: Pool,
  offline: Pool,
  db: Database,
  identity: IdentityRepository,
  athlete: string;
function url(role?: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  if (role) {
    u.username = role;
    u.password = 'isolated';
  }
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD -c statement_timeout=10000');
  return u.toString();
}
async function readSnapshot<T>(fn: (c: PoolClient) => Promise<T>) {
  const c = await offline.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
const schemas = ['garmin_private', 'identity_private', 'public', 'wm_app_load'];
function qualified(relation: CurrentSourceExtraRelation) {
  const parts = relation.split('.');
  return parts.length === 1
    ? { schema: 'public', table: relation }
    : { schema: parts[0], table: parts[1] };
}
function encoding(relation: CurrentSourceExtraRelation) {
  return currentSourceExtraPhysicalRoster[relation].columns
    .map((c) => {
      const ref = `t."${c.name}"`;
      let expr = ref;
      if (c.type === 'timestamp with time zone')
        expr = `to_char(${ref} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      else if (c.type === 'bigint') expr = `${ref}::text`;
      else if (c.type === 'double precision')
        expr = `CASE WHEN ${ref}::text='-0' THEN to_jsonb('-0'::text) ELSE to_jsonb(${ref}) END`;
      return `'${c.name}',${expr}`;
    })
    .join(',');
}
function layouts(relation: CurrentSourceExtraRelation) {
  const arrays = currentSourceExtraPhysicalRoster[relation].arrayColumns;
  if (!arrays.length) return `'{}'::jsonb`;
  return `jsonb_build_object(${arrays.map((name) => `'${name}',jsonb_build_object('isNull',t."${name}" IS NULL,'dimensions',COALESCE((SELECT jsonb_agg(jsonb_build_object('lowerBound',array_lower(t."${name}",d),'upperBound',array_upper(t."${name}",d)) ORDER BY d) FROM generate_series(1,coalesce(array_ndims(t."${name}"),0)) d),'[]'::jsonb))`).join(',')})`;
}
async function readPhysical(c: PoolClient, relation: CurrentSourceExtraRelation) {
  const q = qualified(relation);
  if (!q.schema || !q.table) throw new Error('INVALID_STATIC_RELATION');
  // Actual offline visibility, not forced-RLS filtered row counts.
  const visible = z
    .strictObject({ readable: z.boolean(), filtered: z.boolean() })
    .parse(
      (
        await c.query(
          "SELECT has_table_privilege($1::regclass,'SELECT') AS readable,row_security_active($1::regclass) AS filtered",
          [`${q.schema}.${q.table}`],
        )
      ).rows[0],
    );
  if (!visible.readable || visible.filtered) throw new Error('SOURCE_VISIBILITY_UNAVAILABLE');
  const fields = encoding(relation),
    array = layouts(relation),
    table = `"${q.schema}"."${q.table}"`;
  const scalar = z
    .strictObject({ count: z.string(), bytes: z.string(), maximum: z.string() })
    .parse(
      (
        await c.query(
          `SELECT count(*)::text AS count,COALESCE(sum(octet_length(jsonb_build_object(${fields})::text)),0)::text AS bytes,COALESCE(max(octet_length(jsonb_build_object(${fields})::text)),0)::text AS maximum FROM ONLY ${table} t`,
        )
      ).rows[0],
    );
  if (
    BigInt(scalar.count) > 5000n ||
    BigInt(scalar.bytes) > 16n * 1024n * 1024n ||
    BigInt(scalar.maximum) > 4n * 1024n * 1024n
  )
    throw new Error('FIXTURE_PHYSICAL_LIMIT');
  const raw = await c.query(
    `SELECT jsonb_build_object(${fields}) AS row,${array} AS layouts FROM ONLY ${table} t`,
  );
  const entries = raw.rows.map((raw) => {
    const data = z.strictObject({ row: z.unknown(), layouts: z.unknown() }).parse(raw);
    const entry = parseCurrentSourceExtraPhysicalRows([
      { ordinal: 1, relation, row: data.row, arrayLayouts: data.layouts },
    ])[0];
    if (!entry) throw new Error('MISSING_PHYSICAL_ROW');
    return entry;
  });
  entries.sort((a, b) => {
    const x = currentSourceExtraPhysicalPrimaryKey(a),
      y = currentSourceExtraPhysicalPrimaryKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const parsed = parseCurrentSourceExtraPhysicalRows(
    entries.map((e, i) => ({ ...e, ordinal: i + 1 })),
  );
  return {
    count: parsed.length,
    digest: currentSourceExtraPhysicalRowsSha256(parsed),
    rows: parsed,
  };
}
describe
  .skipIf(!enabled)
  .sequential('current source116 additional physical113 / explicit staged schemas', () => {
    beforeAll(async () => {
      admin = new Pool({ connectionString: adminUrl });
      for (const role of [ownerRole, runtimeRole]) {
        await admin.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        roles.push(role);
      }
      await admin.query(`CREATE DATABASE "${name}" OWNER "${ownerRole}"`);
      created = true;
      await migrate(url(ownerRole), 107);
      owner = new Pool({ connectionString: url(ownerRole) });
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
      ])
        await owner.query(
          await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
        );
      for (const grant of [
        grantCorePlanning,
        grantOperations,
        grantRaces,
        grantResources,
        grantIdentityFunctions,
      ])
        await grant(url(ownerRole), runtimeRole);
      offline = new Pool({ connectionString: url() });
      db = createDatabase({ connectionString: url(runtimeRole) });
      identity = createIdentityRepository({ connectionString: url(runtimeRole) });
      const now = new Date();
      const session = await identity.createSession({
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        csrfToken: 'x'.repeat(32),
        issuer: 'https://synthetic.test',
        subject: randomUUID(),
        now,
        loginStartedAt: now,
        expiresAt: new Date(now.getTime() + 60000),
      });
      athlete = session.athleteId;
      await createConsentRepository(db).setConsent(athlete, {
        kind: 'app',
        granted: true,
        expectedRevision: 0,
        idempotencyKey: randomUUID(),
      });
      const resources = createPrivateTextResourceRepository(db);
      const resource = await resources.create(athlete, {
        sourceKind: 'text',
        title: 'Synthetic source physical',
        category: 'note',
        metadata: {},
        tags: [],
        favorite: false,
        text: 'Synthetic text only.\n\nSecond retained paragraph.',
        idempotencyKey: randomUUID(),
      });
      if (resource.status !== 'available') throw new Error('FIXTURE_RESOURCE_UNAVAILABLE');
      const races = createRaceRepository(db);
      const race = await races.createRaceEvent(athlete, {
        idempotencyKey: randomUUID(),
        values: {
          title: 'Synthetic source physical',
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
      await races.deleteRaceEvent(athlete, race.id, {
        expectedRevision: race.revision,
        idempotencyKey: randomUUID(),
      });
    }, 120000);
    afterAll(async () => {
      await identity?.close();
      await db?.close();
      await offline?.end();
      await owner?.end();
      if (created) await dropIsolatedDatabase(admin, name);
      for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
      await admin?.end();
    }, 30000);
    it('matches all222 actual relation membership and every113 column/type/null/PK without caller-supplied whitelist', async () => {
      const all = z
        .array(z.strictObject({ schema: z.string(), relation: z.string() }))
        .parse(
          (
            await offline.query(
              `SELECT n.nspname AS schema,c.relname AS relation FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`,
              [schemas],
            )
          ).rows,
        );
      const actual = all
        .map((r) => (r.schema === 'public' ? r.relation : `${r.schema}.${r.relation}`))
        .sort();
      const combined = [
        ...CURRENT_PARENT_TYPED_RELATIONS,
        ...currentFamilyRelations,
        ...currentSourceExtraRelations,
      ].sort();
      expect(actual).toEqual(combined);
      expect(actual).toHaveLength(222);
      expect(new Set(combined).size).toBe(222);
      const columns = z
        .array(
          z.strictObject({
            schema: z.string(),
            relation: z.string(),
            name: z.string(),
            type: z.string(),
            nullable: z.boolean(),
          }),
        )
        .parse(
          (
            await offline.query(
              `SELECT n.nspname AS schema,c.relname AS relation,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attnum`,
              [schemas],
            )
          ).rows,
        );
      for (const relation of currentSourceExtraRelations) {
        const q = qualified(relation);
        expect(
          columns
            .filter((c) => c.schema === q.schema && c.relation === q.table)
            .map(({ name, type, nullable }) => ({ name, type, nullable })),
        ).toEqual(currentSourceExtraPhysicalRoster[relation].columns);
        const primary = z
          .strictObject({ keys: z.array(z.string()) })
          .parse(
            (
              await offline.query(
                `SELECT array_agg(a.attname::text ORDER BY k.ordinal) AS keys FROM pg_constraint p CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(attnum,ordinal) JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.attnum WHERE p.conrelid=$1::regclass AND p.contype='p'`,
                [`${q.schema}.${q.table}`],
              )
            ).rows[0],
          );
        expect(primary.keys).toEqual(currentSourceExtraPhysicalRoster[relation].primaryKey);
      }
      expect(
        (await owner.query('SELECT max(version)::int AS version FROM schema_migrations')).rows,
      ).toEqual([{ version: 107 }]);
    }, 30000);
    it('captures actual public durable extra receipts/originals and private credential shape locally without activating target credentials', async () => {
      await readSnapshot(async (c) => {
        for (const relation of [
          'identity_private.session',
          'restore_suppression_event',
          'openai_budget_activation',
        ] satisfies CurrentSourceExtraRelation[]) {
          const observed = await readPhysical(c, relation);
          expect(observed.count).toBeGreaterThan(0);
          expect(observed.digest).toMatch(/^[a-f0-9]{64}$/);
          expect(currentSourceExtraDisposition(relation)).toMatchObject({
            sourceDisposition: 'EXACT_PHYSICAL_CAPTURE',
            transport: 'encrypted_only',
            targetTransform: 'not_implemented',
            authority: 'none',
          });
        }
      });
    });
    it('keeps NULL/empty/multidimensional/non-1-based SQL array evidence exact, not source authorization', async () => {
      // Type-only SQL probes: not stored source rows nor valid course-share domain fixtures.
      for (const expr of [
        `array_fill($1::uuid,ARRAY[2,2],ARRAY[-2,7])`,
        `ARRAY[]::uuid[]`,
        `NULL::uuid[]`,
      ]) {
        const raw = z
          .strictObject({ values: z.unknown(), isNull: z.boolean(), dimensions: z.unknown() })
          .parse(
            (
              await offline.query(
                `WITH sample AS(SELECT ${expr} AS a) SELECT to_jsonb(a) AS values,a IS NULL AS "isNull",COALESCE((SELECT jsonb_agg(jsonb_build_object('lowerBound',array_lower(a,d),'upperBound',array_upper(a,d)) ORDER BY d) FROM generate_series(1,coalesce(array_ndims(a),0)) d),'[]'::jsonb) AS dimensions FROM sample`,
                expr.includes('$1') ? [athlete] : [],
              )
            ).rows[0],
          );
        // B validates the layout against real ordered PostgreSQL values in a complete
        // local physical fixture. SQL CHECK semantics are explicitly not attested.
        const base: Record<string, unknown> = {};
        for (const col of currentSourceExtraPhysicalRoster['course_share'].columns) {
          if (col.nullable) base[col.name] = null;
          else if (col.type === 'uuid') base[col.name] = athlete;
          else if (col.type === 'integer') base[col.name] = 1;
          else if (col.type === 'boolean') base[col.name] = false;
          else if (col.type === 'timestamp with time zone')
            base[col.name] = '2026-10-08T01:02:03.123456Z';
          else if (col.type === 'jsonb') base[col.name] = {};
          else if (col.type === 'uuid[]') base[col.name] = raw.values;
          else base[col.name] = 'synthetic';
        }
        if (raw.isNull) {
          const receipt: Record<string, unknown> = {};
          for (const col of currentSourceExtraPhysicalRoster['healthkit_workout_batch_receipt']
            .columns) {
            if (col.nullable) receipt[col.name] = null;
            else if (col.type === 'uuid') receipt[col.name] = athlete;
            else if (col.type === 'integer') receipt[col.name] = 1;
            else if (col.type === 'boolean') receipt[col.name] = false;
            else if (col.type === 'timestamp with time zone')
              receipt[col.name] = '2026-10-08T01:02:03.123456Z';
            else receipt[col.name] = 'synthetic';
          }
          expect(
            parseCurrentSourceExtraPhysicalRows([
              {
                ordinal: 1,
                relation: 'healthkit_workout_batch_receipt',
                row: receipt,
                arrayLayouts: { sample_ids: { isNull: true, dimensions: raw.dimensions } },
              },
            ]),
          ).toHaveLength(1);
        } else
          expect(
            parseCurrentSourceExtraPhysicalRows([
              {
                ordinal: 1,
                relation: 'course_share',
                row: base,
                arrayLayouts: { zone_ids: { isNull: false, dimensions: raw.dimensions } },
              },
            ]),
          ).toHaveLength(1);
      }
    });
    it('preserves actual SQL inet array layout and ordered NULL elements without canonical lower-bound defaults', async () => {
      const raw = z
        .strictObject({ values: z.unknown(), dimensions: z.unknown() })
        .parse(
          (
            await offline.query(
              `WITH sample AS(SELECT '[0:1][4:5]={{127.0.0.1,NULL},{::1,192.0.2.1/24}}'::inet[] AS a) SELECT to_jsonb(a) AS values,(SELECT jsonb_agg(jsonb_build_object('lowerBound',array_lower(a,d),'upperBound',array_upper(a,d)) ORDER BY d) FROM generate_series(1,array_ndims(a)) d) AS dimensions FROM sample`,
            )
          ).rows[0],
        );
      const row = {
        athlete_id: athlete,
        request_id: randomUUID(),
        attempt_no: 1,
        hop_index: 0,
        display_url: 'https://synthetic.test',
        url_digest: 'a'.repeat(64),
        response_status: null,
        resolved_addresses: raw.values,
        policy_version: 'synthetic',
        observed_at: '2026-10-08T01:02:03.123456Z',
      };
      const parsed = parseCurrentSourceExtraPhysicalRows([
        {
          ordinal: 1,
          relation: 'resource_url_fetch_hop',
          row,
          arrayLayouts: { resolved_addresses: { isNull: false, dimensions: raw.dimensions } },
        },
      ]);
      expect(parsed).toHaveLength(1);
      expect(raw.dimensions).toEqual([
        { lowerBound: 0, upperBound: 1 },
        { lowerBound: 4, upperBound: 5 },
      ]);
      expect(raw.values).toEqual([
        ['127.0.0.1', null],
        ['::1', '192.0.2.1/24'],
      ]);
    });
    it('preserves actual SQL negative-zero and special float encoding without inferring sign from JSONB0', async () => {
      const observed = z
        .array(z.strictObject({ wire: z.unknown(), encoded: z.string(), original: z.string() }))
        .parse(
          (
            await offline.query(
              `SELECT CASE WHEN v::text='-0' THEN to_jsonb('-0'::text) ELSE to_jsonb(v) END AS wire,encode(float8send(v),'hex') AS original,encode(float8send((CASE WHEN v::text='-0' THEN '-0' ELSE v::text END)::float8),'hex') AS encoded FROM unnest(ARRAY['-0'::float8,'0'::float8,'1.2345678901234567'::float8,'NaN'::float8,'Infinity'::float8,'-Infinity'::float8]) v`,
            )
          ).rows,
        );
      expect(observed[0]?.wire).toBe('-0');
      expect(observed[1]?.wire).toBe(0);
      for (const row of observed) expect(row.encoded).toBe(row.original);
      const base: Record<string, unknown> = {};
      for (const col of currentSourceExtraPhysicalRoster['course_privacy_zone'].columns) {
        if (col.nullable) base[col.name] = null;
        else if (col.type === 'uuid') base[col.name] = athlete;
        else if (col.type === 'double precision') base[col.name] = 1;
        else if (col.type === 'timestamp with time zone')
          base[col.name] = '2026-10-08T01:02:03.123456Z';
        else base[col.name] = 'synthetic';
      }
      for (const sample of observed)
        expect(
          parseCurrentSourceExtraPhysicalRows([
            {
              ordinal: 1,
              relation: 'course_privacy_zone',
              row: { ...base, center_longitude: sample.wire },
              arrayLayouts: {},
            },
          ]),
        ).toHaveLength(1);
    });
  });
