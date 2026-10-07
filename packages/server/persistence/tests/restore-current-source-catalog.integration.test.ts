import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  migrate,
  grantCorePlanning,
  grantIdentityFunctions,
  grantOperations,
  grantRaces,
} from '../src/migrate.js';
import { createDatabase, type Database } from '../src/database.js';
import { createIdentityRepository, type IdentityRepository } from '../src/identity.js';
import { createConsentRepository } from '../src/repositories.js';
import { createRaceRepository } from '../src/races.js';
import { createOperationsRepository } from '../src/operations.js';
import {
  captureCurrentSourceCatalogIn,
  readCurrentSourceCatalogFingerprintIn,
  currentSourceCatalogExpectedSchema,
  type CurrentSourceCatalogExpected,
  type CurrentSourceCatalogProfile,
  type CurrentSourceCaptureTransaction,
} from '../src/restore-current-source-catalog.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Root executes PostgreSQL. Runtime producers are plain roles; the existing offline
// admin reads only catalog, COUNT and pg_column_size. No privileged body seed/read.
const enabled = Boolean(process.env['TEST_DATABASE_ADMIN_URL']);
const adminUrl = enabled ? z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']) : '';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const name = `source_catalog_${suffix}`,
  ownerRole = `source_catalog_owner_${suffix}`,
  runtimeRole = `source_catalog_app_${suffix}`;
const stages = [
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
const roles: string[] = [];
let created = false;
let admin: Pool,
  owner: Pool,
  backup: Pool,
  runtime: Pool,
  db: Database,
  identity: IdentityRepository,
  expected: CurrentSourceCatalogExpected,
  athlete: string,
  erased: string;
function endpoint(role?: string) {
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  if (role) {
    u.username = role;
    u.password = 'isolated';
  }
  u.searchParams.set('options', '-c timezone=UTC -c datestyle=ISO,YMD -c statement_timeout=10000');
  return u.toString();
}
async function snapshot<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
  begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(begin);
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
async function pin() {
  // Separate provisioning transaction. Pin actual metadata before public census calls;
  // expected operator is the existing admin, never a freshly privileged role.
  return snapshot(backup, async (c) => {
    const source = z
      .strictObject({
        databaseName: z.string(),
        databaseOid: z.string(),
        systemIdentifier: z.string(),
        roleName: z.string(),
        roleOid: z.string(),
        superuser: z.boolean(),
        bypassRls: z.boolean(),
      })
      .parse(
        (
          await c.query(
            `SELECT current_database() AS "databaseName",d.oid::text AS "databaseOid",(SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",current_user AS "roleName",r.oid::text AS "roleOid",r.rolsuper AS superuser,r.rolbypassrls AS "bypassRls" FROM pg_database d,pg_roles r WHERE d.datname=current_database() AND r.rolname=current_user`,
          )
        ).rows[0],
      );
    const schemas = z
      .array(z.strictObject({ name: z.string() }))
      .parse(
        (
          await c.query(
            `SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema' ORDER BY nspname COLLATE "C"`,
          )
        ).rows,
      )
      .map((r) => r.name);
    const relations = z
      .array(z.strictObject({ schema: z.string(), name: z.string() }))
      .parse(
        (
          await c.query(
            `SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`,
            [schemas],
          )
        ).rows,
      );
    const normalRegistry = z
      .array(z.strictObject({ version: z.number(), checksum: z.string() }))
      .parse(
        (await c.query('SELECT version,checksum FROM schema_migrations ORDER BY version')).rows,
      );
    const explicitPins = await Promise.all(
      stages.map(async (file, i) => ({
        version: 108 + i,
        checksum: createHash('sha256')
          .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
          .digest('hex'),
      })),
    );
    const profile: CurrentSourceCatalogProfile = {
      profileVersion: 1,
      normalSchemaVersion: 107,
      explicitPins,
      normalRegistry,
      schemas,
      relations,
      roles: [
        { tag: 'backup', name: source.roleName },
        { tag: 'database_owner', name: 'pg_database_owner' },
        { tag: 'owner', name: ownerRole },
        { tag: 'runtime', name: runtimeRole },
      ],
      source: {
        databaseName: source.databaseName,
        databaseOid: source.databaseOid,
        systemIdentifier: source.systemIdentifier,
      },
      operator: {
        roleName: source.roleName,
        roleOid: source.roleOid,
        superuser: source.superuser,
        bypassRls: source.bypassRls,
      },
    };
    const fingerprint = await readCurrentSourceCatalogFingerprintIn(c, profile);
    return currentSourceCatalogExpectedSchema.parse({
      ...profile,
      catalogSha256: fingerprint.catalogSha256,
    });
  });
}
function raceValues(title: string) {
  return {
    title,
    localDate: '2026-10-08',
    localStartTime: null,
    timezone: 'Asia/Seoul',
    locationName: null,
    distance: { kind: 'standard' as const, class: '10k' as const },
    priority: null,
    participation: 'registered' as const,
    officialUrl: null,
    course: null,
    targetSeconds: 0,
    planVersionId: null,
  };
}
const count = (
  capture: Awaited<ReturnType<typeof captureCurrentSourceCatalogIn>>,
  schema: string,
  relation: string,
) => {
  const found = capture.census.find((r) => r.schema === schema && r.relation === relation);
  expect(found).toBeDefined();
  return BigInt(found?.rows ?? '0');
};
describe
  .skipIf(!enabled)
  .sequential('current source116 catalog/census / privileged offline read visibility', () => {
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
      await migrate(endpoint(ownerRole), 107);
      owner = new Pool({ connectionString: endpoint(ownerRole) });
      for (const file of stages)
        await owner.query(
          await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
        );
      for (const grant of [grantCorePlanning, grantIdentityFunctions, grantOperations, grantRaces])
        await grant(endpoint(ownerRole), runtimeRole);
      backup = new Pool({ connectionString: endpoint(), max: 2 });
      runtime = new Pool({ connectionString: endpoint(runtimeRole) });
      db = createDatabase({ connectionString: endpoint(runtimeRole) });
      identity = createIdentityRepository({ connectionString: endpoint(runtimeRole) });
      for (const index of [0, 1]) {
        const now = new Date();
        const result = await identity.createSession({
          tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
          csrfToken: 'x'.repeat(32),
          issuer: 'https://synthetic.test',
          subject: randomUUID(),
          now,
          loginStartedAt: now,
          expiresAt: new Date(now.getTime() + 60000),
        });
        if (index === 0) athlete = result.athleteId;
        else erased = result.athleteId;
        await createConsentRepository(db).setConsent(result.athleteId, {
          kind: 'app',
          granted: true,
          expectedRevision: 0,
          idempotencyKey: randomUUID(),
        });
        await createRaceRepository(db).createRaceEvent(result.athleteId, {
          values: raceValues('Synthetic source census'),
          idempotencyKey: randomUUID(),
        });
      }
      await createOperationsRepository(db).eraseAccount(erased);
      expected = await pin();
    }, 120000);
    afterAll(async () => {
      await identity?.close();
      await db?.close();
      await runtime?.end();
      await backup?.end();
      await owner?.end();
      if (created) await dropIsolatedDatabase(admin, name);
      for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
      await admin?.end();
    }, 30000);
    it('captures every four-schema table including erased-identity originals/private rows and all six global budget relations', async () => {
      const capture = await snapshot(backup, (c) => captureCurrentSourceCatalogIn(c, expected));
      expect(capture.census.map((r) => ({ schema: r.schema, name: r.relation }))).toEqual(
        expected.relations,
      );
      expect(expected.relations).toHaveLength(222);
      expect(expected.schemas).toEqual([
        'garmin_private',
        'identity_private',
        'public',
        'wm_app_load',
      ]);
      expect(count(capture, 'identity_private', 'account')).toBe(1n);
      expect(count(capture, 'public', 'race_event')).toBe(1n);
      expect(count(capture, 'public', 'restore_suppression_event')).toBeGreaterThan(0n);
      const orphanOriginals = z
        .strictObject({ count: z.string() })
        .parse(
          (
            await backup.query(
              `SELECT count(*)::text AS count FROM public.restore_suppression_event e LEFT JOIN identity_private.account a ON a.athlete_id::text=e.athlete_id WHERE a.athlete_id IS NULL`,
            )
          ).rows[0],
        );
      expect(BigInt(orphanOriginals.count)).toBeGreaterThan(0n);
      expect(count(capture, 'public', 'restore_suppression_event')).toBeGreaterThanOrEqual(
        BigInt(orphanOriginals.count),
      );
      expect(capture.catalog.roles.filter((r) => r.tag === 'owner' || r.tag === 'runtime')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tag: 'owner',
            superuser: false,
            bypassRls: false,
            createDb: false,
            createRole: false,
          }),
          expect.objectContaining({
            tag: 'runtime',
            superuser: false,
            bypassRls: false,
            createDb: false,
            createRole: false,
          }),
        ]),
      );
      const budgets = expected.relations.filter((r) => r.name.startsWith('openai_budget_'));
      expect(budgets).toHaveLength(6);
      for (const r of budgets)
        expect(capture.census.some((f) => f.schema === r.schema && f.relation === r.name)).toBe(
          true,
        );
      expect(capture.catalog.functions.length).toBeGreaterThan(500);
      const membershipColumns = await backup.query(
        `SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='pg_auth_members'::regclass AND attname='inherit_option' AND NOT attisdropped) AS extended`,
      );
      const extended = z
        .strictObject({ extended: z.boolean() })
        .parse(membershipColumns.rows[0]).extended;
      for (const role of capture.catalog.roles)
        for (const membership of role.memberships) {
          expect(membership).toHaveProperty('inheritOption');
          expect(membership).toHaveProperty('setOption');
          if (extended) {
            expect(typeof membership.inheritOption).toBe('boolean');
            expect(typeof membership.setOption).toBe('boolean');
          } else {
            expect(membership.inheritOption).toBeNull();
            expect(membership.setOption).toBeNull();
          }
        }

      expect(capture.catalog.relations.some((r) => r.schema === 'garmin_private')).toBe(true);
      expect(capture.catalog.relations.some((r) => r.schema === 'wm_app_load')).toBe(true);
      expect(capture).toMatchObject({
        authority: 'none',
        authentication: 'not_captured',
        admissionAllowed: false,
        limits: {
          sequenceCurrentValues: 'not_captured_non_mvcc',
          sourceSignature: 'not_captured',
          tailBoundary: 'not_captured',
        },
      });
      expect(capture.catalog.registry.at(-1)?.version).toBe(107);
      expect(capture.profile.explicitPins.map((r) => r.version)).toEqual([
        108, 109, 110, 111, 112, 113, 114, 115, 116,
      ]);
    });
    it('refuses runtime FORCE-RLS visibility before body/catalog hash/count SQL; zero is never a substituted census', async () => {
      const role = z
        .strictObject({ oid: z.string(), superuser: z.boolean(), bypassRls: z.boolean() })
        .parse(
          (
            await runtime.query(
              'SELECT oid::text AS oid,rolsuper AS superuser,rolbypassrls AS "bypassRls" FROM pg_roles WHERE rolname=current_user',
            )
          ).rows[0],
        );
      expect(
        (await runtime.query("SELECT row_security_active('public.race_event'::regclass) AS active"))
          .rows,
      ).toEqual([{ active: true }]);
      const queries: string[] = [];
      await expect(
        snapshot(runtime, async (c) => {
          const port: CurrentSourceCaptureTransaction = {
            query: async (sql, values) => {
              queries.push(sql);
              return c.query(sql, values);
            },
          };
          return captureCurrentSourceCatalogIn(port, {
            ...expected,
            operator: {
              roleName: runtimeRole,
              roleOid: role.oid,
              superuser: role.superuser,
              bypassRls: role.bypassRls,
            },
          });
        }),
      ).rejects.toMatchObject({ code: 'SOURCE_VISIBILITY_UNAVAILABLE' });
      expect(
        queries.some(
          (q) =>
            q.includes('pg_control_system') ||
            q.includes('pg_column_size') ||
            q.includes('AS catalog'),
        ),
      ).toBe(false);
    });
    it.each([
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE',
    ])('rejects unsafe transaction mode %s before whole-source reads', async (begin) => {
      await expect(
        snapshot(backup, (c) => captureCurrentSourceCatalogIn(c, expected), begin),
      ).rejects.toMatchObject({ code: 'SOURCE_CONTEXT_MISMATCH' });
    });
    it('rejects wrong independent operator/source pins and metadata hash before census', async () => {
      await expect(
        snapshot(backup, (c) =>
          captureCurrentSourceCatalogIn(c, {
            ...expected,
            operator: { ...expected.operator, roleOid: '1' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_CONTEXT_MISMATCH' });
      await expect(
        snapshot(backup, (c) =>
          captureCurrentSourceCatalogIn(c, {
            ...expected,
            source: { ...expected.source, databaseOid: '1' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'SOURCE_CONTEXT_MISMATCH' });
      const queries: string[] = [];
      await expect(
        snapshot(backup, (c) =>
          captureCurrentSourceCatalogIn(
            {
              query: async (sql, values) => {
                queries.push(sql);
                return c.query(sql, values);
              },
            },
            { ...expected, catalogSha256: '0'.repeat(64) },
          ),
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_MISMATCH' });
      expect(queries.some((q) => q.includes('pg_column_size'))).toBe(false);
    });
    it('sees one RR snapshot across a concurrent public tenant write, while a new snapshot sees the committed row', async () => {
      const measure = async (c: PoolClient, label: string) => {
        const start = performance.now();
        try {
          return await captureCurrentSourceCatalogIn(c, expected);
        } finally {
          if (process.env['WM_SOURCE_CATALOG_TIMING'] === '1')
            process.stderr.write(
              JSON.stringify({ label, elapsedMs: performance.now() - start }) + '\n',
            );
        }
      };
      const observed = await snapshot(backup, async (c) => {
        const before = await measure(c, 'first_capture');
        await createRaceRepository(db).createRaceEvent(athlete, {
          values: raceValues('Concurrent public source'),
          idempotencyKey: randomUUID(),
        });
        const after = await measure(c, 'same_snapshot_capture');
        expect(after.snapshot).toEqual(before.snapshot);
        expect(after.census).toEqual(before.census);
        return before;
      });
      const fresh = await snapshot(backup, (c) => measure(c, 'fresh_snapshot_capture'));
      expect(count(fresh, 'public', 'race_event')).toBe(
        count(observed, 'public', 'race_event') + 1n,
      );
      // Three exhaustive catalogue/count captures measured 27.6s on local PG17.
      // Per-query SQL deadline remains 10s; this finite case needs three captures.
    }, 45000);
    it('detects actual function/catalog drift against the earlier independent metadata pin', async () => {
      await owner.query(
        "CREATE FUNCTION public.source_catalog_drift_fixture() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      );
      try {
        await expect(
          snapshot(backup, (c) => captureCurrentSourceCatalogIn(c, expected)),
        ).rejects.toMatchObject({ code: 'CATALOG_MISMATCH' });
      } finally {
        await owner.query('DROP FUNCTION public.source_catalog_drift_fixture()');
      }
    });
  });
