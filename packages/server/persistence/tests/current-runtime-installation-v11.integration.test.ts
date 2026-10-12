import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import {
  installCurrentRuntimeV10,
  verifyCurrentRuntimeV10InstalledIn,
} from '../src/current-runtime-installation-v10.js';
import { verifyCurrentRuntimeV9InstalledIn } from '../src/current-runtime-installation-v9.js';
import { grantCurrentRuntimeV10Profile } from '../src/current-runtime-grants-v10.js';
import { grantCurrentRuntimeAppBaselineV2 } from '../src/current-runtime-app-grants-v2.js';
import {
  installCurrentRuntimeV11,
  installCurrentRuntimeV11In,
  verifyCurrentRuntimeV11InstalledIn,
  captureCurrentRuntimeV11CatalogLinesIn,
  currentRuntimeV11ExtensionMembers,
  currentRuntimeV11FunctionPins,
  currentRuntimeV11Tables,
} from '../src/current-runtime-installation-v11.js';
import { RESTORE_ADMISSION_ROSTER_SHA256 } from '../src/full-restore-relation-classification-v2.js';
import { dropIsolatedDatabase } from './drop-isolated-database.js';

// Real PostgreSQL 17. Catalog/receipt metadata only: no health, account, provider or restore
// data. No product/support activation or processing authority is inferred from any result.
const adminUrl = z.string().min(1).parse(process.env['TEST_DATABASE_ADMIN_URL']);
const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
const ownerRole = `crv11_owner_${suffix}`,
  runtimeRole = `crv11_app_${suffix}`;
const fresh = `crv11_fresh_${suffix}`,
  upgrade = `crv11_upgrade_${suffix}`,
  concurrent = `crv11_race_${suffix}`;
const admin = new Pool({ connectionString: adminUrl, max: 1 });
const databases: string[] = [],
  roles: string[] = [];
let pending: Promise<void> = Promise.resolve();
function fixtureIt(label: string, run: () => Promise<void>) {
  it(
    label,
    async () => {
      const work = pending.then(run);
      pending = work.then(
        () => undefined,
        () => undefined,
      );
      await work;
    },
    300000,
  );
}
function url(database: string, role = ownerRole) {
  const u = new URL(adminUrl);
  u.pathname = '/' + database;
  u.username = role;
  u.password = 'isolated';
  return u.toString();
}
async function session<T>(database: string, run: (tx: PoolClient) => Promise<T>, role = ownerRole) {
  const pool = new Pool({
    connectionString: url(database, role),
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    query_timeout: 65000,
  });
  const tx = await pool.connect();
  try {
    return await run(tx);
  } finally {
    tx.release();
    await pool.end();
  }
}
async function rollback<T>(run: (tx: PoolClient) => Promise<T>, database = fresh) {
  return session(database, async (tx) => {
    await tx.query('BEGIN');
    try {
      return await run(tx);
    } finally {
      await tx.query('ROLLBACK');
    }
  });
}
async function rejected(tx: PoolClient, run: () => Promise<unknown>, message: string) {
  await tx.query('SAVEPOINT rejection');
  try {
    await expect(run()).rejects.toThrow(message);
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT rejection');
    await tx.query('RELEASE SAVEPOINT rejection');
  }
}
async function newDatabase(label: string, profile26 = false) {
  const database = `crv11_${label}_${suffix}`;
  await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
  databases.push(database);
  await migrate(url(database), 107);
  if (profile26) await installCurrentRuntimeV10(url(database));
  return database;
}
const member = (id: number) => {
  const m = currentRuntimeV11ExtensionMembers.find((x) => x.sourceDdlId === id);
  if (!m) throw Error('MEMBER');
  return readFile(new URL(`../migrations/${m.filename}`, import.meta.url), 'utf8');
};
const ledgerSql = `SELECT jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY extension_step) AS value FROM wm_runtime_installation.profile_extension_v11 t`;
const parentLedgerSql = `SELECT jsonb_agg(jsonb_build_object('family',f.family,'row',f.row,'xmin',f.xmin) ORDER BY f.family,f.row::text) AS value FROM (${[
  'migration',
  ...Array.from({ length: 9 }, (_, i) => `profile_extension_v${i + 2}`),
]
  .map(
    (table) =>
      `SELECT '${table}' AS family,to_jsonb(t) AS row,t.xmin::text AS xmin FROM wm_runtime_installation.${table} t`,
  )
  .join(' UNION ALL ')}) f`;
const absenceSql = `SELECT to_regclass('wm_runtime_installation.profile_extension_v11') IS NULL AS ledger_absent,
 NOT EXISTS(SELECT 1 FROM unnest($1::text[]) t WHERE to_regclass('public.'||t) IS NOT NULL) AS tables_absent,
 NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.restore_processing_admission'::regclass AND attname='admitted_artifact_sha256') AS columns_absent,
 to_regprocedure('public.open_restore_processing_admission_window(bigint,uuid,uuid)') IS NULL AS functions_absent`;
const absent = {
  ledger_absent: true,
  tables_absent: true,
  columns_absent: true,
  functions_absent: true,
};
const v11Signatures = currentRuntimeV11FunctionPins.map((p) => p.signature);
const replacedSignatures = currentRuntimeV11FunctionPins
  .filter((p) => p.sourceDdlId === 101)
  .map((p) => p.signature);
let baselineReceipt: unknown;
let freshResult: unknown;
beforeAll(async () => {
  for (const role of [ownerRole, runtimeRole]) {
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD 'isolated' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roles.push(role);
  }
  for (const database of [fresh, upgrade, concurrent]) {
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    databases.push(database);
    await migrate(url(database), 107);
  }
  // Committed profile26: V10 install, app core grants and V10 runtime grants.
  await installCurrentRuntimeV10(url(upgrade));
  await grantCurrentRuntimeAppBaselineV2(url(upgrade), runtimeRole, 'core');
  await grantCurrentRuntimeV10Profile(url(upgrade), runtimeRole);
}, 600000);
afterAll(async () => {
  await pending;
  for (const database of databases.reverse()) await dropIsolatedDatabase(admin, database);
  for (const role of roles.reverse()) await admin.query(`DROP ROLE "${role}"`);
  await admin.end();
}, 120000);

fixtureIt(
  'fresh normal107 installs parent26 and five receipts without activating runtime',
  async () => {
    const installed = await installCurrentRuntimeV11(url(fresh));
    freshResult = installed;
    expect(installed).toMatchObject({
      profileVersion: 11,
      parentProfileVersion: 10,
      baselineSchemaVersion: 107,
      parentRuntimeStep: 26,
      extensionSteps: 5,
      runtimeStep: 27,
      sourceDdlTip: 148,
      supported: false,
      processingAuthority: 'none',
      catalogSecurity: 'not_verified',
      restore: 'not_verified',
    });
    expect(installed.extensionReceipts.map((r) => r.sourceDdlId)).toEqual([
      143, 144, 145, 147, 148,
    ]);
    expect(installed.parentAppliedMembers).toHaveLength(33);
    await session(fresh, async (tx) => {
      baselineReceipt = (await tx.query(ledgerSql)).rows[0]?.['value'];
      expect(
        (await tx.query('SELECT max(version)::int AS version FROM schema_migrations')).rows[0]?.[
          'version'
        ],
      ).toBe(107);
      await tx.query('BEGIN');
      expect(await verifyCurrentRuntimeV11InstalledIn(tx)).toEqual(installed);
      // The installed 147 roster is the regenerated one and the control row stays CLOSED.
      expect(
        (
          await tx.query(
            "SELECT public.restore_processing_admission_roster_sha256() AS sha,public.read_restore_processing_admission()->>'state' AS state,(SELECT count(*)::int FROM public.restore_processing_admission_roster()) AS rows",
          )
        ).rows[0],
      ).toEqual({ sha: RESTORE_ADMISSION_ROSTER_SHA256, state: 'CLOSED', rows: 254 });
      expect(
        (await tx.query('SELECT public.restore_processing_admission_roster_drift() AS drift'))
          .rows[0],
      ).toEqual({ drift: false });
      // profile26 and profile25 tooling refuse profile27 by construction.
      await rejected(
        tx,
        () => verifyCurrentRuntimeV10InstalledIn(tx),
        'CURRENT_RUNTIME_V10_LEDGER_INVALID',
      );
      await rejected(
        tx,
        () => verifyCurrentRuntimeV9InstalledIn(tx),
        'CURRENT_RUNTIME_V9_LEDGER_INVALID',
      );
      await tx.query('ROLLBACK');
    });
    await expect(installCurrentRuntimeV10(url(fresh))).rejects.toThrow(
      'CURRENT_RUNTIME_V10_LEDGER_INVALID',
    );
  },
);
fixtureIt(
  'committed profile26 upgrades with 143..148 only: parent receipts/xmin, functions and ACLs keep, except the pinned 147 replacements',
  async () => {
    await session(upgrade, async (tx) => {
      await tx.query('BEGIN');
      expect(await verifyCurrentRuntimeV10InstalledIn(tx)).toMatchObject({ runtimeStep: 26 });
      await tx.query('ROLLBACK');
      const replacedOids = (
        await tx.query(
          'SELECT array_agg(to_regprocedure(s)::oid::text) AS v FROM unnest($1::text[]) s',
          [replacedSignatures],
        )
      ).rows[0]?.['v'];
      const metadataSql =
        "SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) AS value FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','wm_manual_pooled') AND p.oid<>ALL($1::oid[]) AND p.oid<=$2::oid";
      const maxOid = (await tx.query('SELECT max(oid)::text AS v FROM pg_proc')).rows[0]?.['v'];
      const metadataBefore = (await tx.query(metadataSql, [replacedOids, maxOid])).rows[0]?.[
        'value'
      ];
      const aclSql =
        "SELECT jsonb_agg(jsonb_build_object('oid',p.oid::text,'acl',p.proacl::text) ORDER BY p.oid) AS value FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<=$1::oid";
      const aclBefore = (await tx.query(aclSql, [maxOid])).rows[0]?.['value'];
      const relAclSql =
        "SELECT jsonb_agg(jsonb_build_object('rel',c.relname,'acl',c.relacl::text) ORDER BY c.relname) AS value FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.oid<=$1::oid";
      const maxRel = (await tx.query('SELECT max(oid)::text AS v FROM pg_class')).rows[0]?.['v'];
      const relAclBefore = (await tx.query(relAclSql, [maxRel])).rows[0]?.['value'];
      const before = (await tx.query(parentLedgerSql)).rows[0]?.['value'];
      await tx.query('BEGIN');
      try {
        expect(await installCurrentRuntimeV11In(tx)).toMatchObject({ runtimeStep: 27 });
        await tx.query('COMMIT');
      } catch (e) {
        await tx.query('ROLLBACK');
        throw e;
      }
      expect((await tx.query(metadataSql, [replacedOids, maxOid])).rows[0]?.['value']).toEqual(
        metadataBefore,
      );
      expect((await tx.query(aclSql, [maxOid])).rows[0]?.['value']).toEqual(aclBefore);
      expect((await tx.query(relAclSql, [maxRel])).rows[0]?.['value']).toEqual(relAclBefore);
      expect((await tx.query(parentLedgerSql)).rows[0]?.['value']).toEqual(before);
      // The runtime role keeps read_/require_/lock_ (migrate.ts grants survive CREATE OR
      // REPLACE) and gets nothing new from the installer.
      expect(
        (
          await tx.query(
            `SELECT
              bool_and(has_function_privilege($1,s,'EXECUTE')) FILTER (WHERE s IN ('public.read_restore_processing_admission()','public.require_restore_processing_admission()','public.lock_restore_processing_shared()')) AS kept,
              bool_or(has_function_privilege($1,s,'EXECUTE')) FILTER (WHERE s NOT IN ('public.read_restore_processing_admission()','public.require_restore_processing_admission()','public.lock_restore_processing_shared()')) AS gained
             FROM unnest($2::text[]) s`,
            [runtimeRole, [...v11Signatures, 'public.lock_restore_processing_shared()']],
          )
        ).rows[0],
      ).toEqual({ kept: true, gained: false });
      expect(
        (
          await tx.query(
            "SELECT bool_or(has_table_privilege($1,to_regclass('public.'||t),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS any FROM unnest($2::text[]) t",
            [runtimeRole, [...currentRuntimeV11Tables]],
          )
        ).rows[0],
      ).toEqual({ any: false });
      await tx.query('BEGIN');
      await verifyCurrentRuntimeV11InstalledIn(tx);
      await rejected(
        tx,
        () => verifyCurrentRuntimeV10InstalledIn(tx),
        'CURRENT_RUNTIME_V10_LEDGER_INVALID',
      );
      await tx.query('ROLLBACK');
    });
    await expect(grantCurrentRuntimeV10Profile(url(upgrade), runtimeRole)).rejects.toThrow(
      'CURRENT_RUNTIME_V10_LEDGER_INVALID',
    );
    // The upgrade and the fresh path produce identical receipts and results.
    expect(await installCurrentRuntimeV11(url(upgrade))).toEqual(freshResult);
  },
);
fixtureIt('repeated install returns the original receipts without rewriting them', async () => {
  const first = await installCurrentRuntimeV11(url(fresh));
  const second = await installCurrentRuntimeV11(url(fresh));
  expect(second).toEqual(first);
  await session(fresh, async (tx) =>
    expect((await tx.query(ledgerSql)).rows[0]?.['value']).toEqual(baselineReceipt),
  );
});
fixtureIt('two genuine owner connections serialize one fresh installation', async () => {
  const [a, b] = await Promise.all([
    installCurrentRuntimeV11(url(concurrent)),
    installCurrentRuntimeV11(url(concurrent)),
  ]);
  expect(a).toEqual(b);
  expect(a.extensionReceipts).toHaveLength(5);
});
fixtureIt(
  'any 143..148 object without the v11 ledger is an unregistered stage, never adopted',
  async () => {
    await rollback(async (tx) => {
      await tx.query('DROP TABLE wm_runtime_installation.profile_extension_v11');
      await rejected(
        tx,
        () => installCurrentRuntimeV11In(tx),
        'CURRENT_RUNTIME_V11_UNREGISTERED_STAGE',
      );
      await rejected(
        tx,
        () => verifyCurrentRuntimeV11InstalledIn(tx),
        'CURRENT_RUNTIME_V11_LEDGER_INVALID',
      );
    });
    const raw = await newDatabase('raw', true);
    // Each member alone (and 145's parent index / 147's control columns alone) is a stage.
    const stages: [string, string][] = [
      ['143', await member(143)],
      ['144', await member(144)],
      ['147', await member(147)],
      ['148', await member(148)],
      [
        '145 index only',
        "CREATE UNIQUE INDEX restore_suppression_event_gallery_album_once ON public.restore_suppression_event(athlete_id) WHERE kind='x'",
      ],
      [
        '147 column only',
        'ALTER TABLE public.restore_processing_admission ADD COLUMN admitted_head_sha256 text',
      ],
      [
        'parent trigger only',
        'CREATE FUNCTION public.p27i_noop() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER gallery_rendition_enqueue_item AFTER INSERT ON public.gallery_media_item FOR EACH ROW EXECUTE FUNCTION public.p27i_noop()',
      ],
    ];
    for (const [label, sql] of stages)
      await rollback(async (tx) => {
        await tx.query(sql);
        await rejected(
          tx,
          () => installCurrentRuntimeV11In(tx),
          'CURRENT_RUNTIME_V11_UNREGISTERED_STAGE',
        );
        expect([label, (await tx.query(absenceSql, [[]])).rows[0]?.['ledger_absent']]).toEqual([
          label,
          true,
        ]);
      }, raw);
    // Retired extension-v1 ledgers are legacy development stages; they are never adopted.
    for (const schema of ['wm_gallery_installation', 'wm_gallery_rendition_installation'])
      await rollback(async (tx) => {
        await tx.query(`CREATE SCHEMA ${schema}`);
        await rejected(
          tx,
          () => installCurrentRuntimeV11In(tx),
          'CURRENT_RUNTIME_V11_LEGACY_EXTENSION_LEDGER',
        );
      }, raw);
    await rollback(async (tx) => {
      await tx.query('CREATE SCHEMA wm_gallery_installation');
      await rejected(
        tx,
        () => verifyCurrentRuntimeV11InstalledIn(tx),
        'CURRENT_RUNTIME_V11_LEGACY_EXTENSION_LEDGER',
      );
    });
  },
);
fixtureIt(
  'runtime/elevated principals and out-of-transaction reads cannot verify provenance',
  async () => {
    await session(
      fresh,
      async (tx) => {
        await tx.query('BEGIN');
        try {
          await expect(verifyCurrentRuntimeV11InstalledIn(tx)).rejects.toThrow();
        } finally {
          await tx.query('ROLLBACK');
        }
      },
      runtimeRole,
    );
    await session(fresh, async (tx) => {
      await expect(verifyCurrentRuntimeV11InstalledIn(tx)).rejects.toThrow(
        'CURRENT_RUNTIME_V11_TRANSACTION_REQUIRED',
      );
      expect(
        (await tx.query("SELECT current_setting('search_path') AS p")).rows[0]?.['p'],
      ).not.toBe('pg_catalog, pg_temp');
    });
    await admin.query(`ALTER ROLE "${ownerRole}" BYPASSRLS`);
    try {
      await expect(installCurrentRuntimeV11(url(fresh))).rejects.toThrow();
    } finally {
      await admin.query(`ALTER ROLE "${ownerRole}" NOBYPASSRLS`);
    }
  },
);
const drift = [
  // Triggers on V11 tables and the V11 triggers on parent tables.
  [
    'new-table trigger disabled',
    'ALTER TABLE public.gallery_album DISABLE TRIGGER gallery_album_row_guard',
    'TRIGGER_DRIFT',
  ],
  [
    'new-table trigger replica-only',
    'ALTER TABLE public.ai_execution_job ENABLE REPLICA TRIGGER ai_execution_job_guard',
    'TRIGGER_DRIFT',
  ],
  [
    'constraint trigger always',
    'ALTER TABLE public.ai_execution_job ENABLE ALWAYS TRIGGER ai_execution_job_commit_atomic',
    'TRIGGER_DRIFT',
  ],
  [
    'parent-side V11 trigger disabled',
    'ALTER TABLE public.gallery_media_item DISABLE TRIGGER gallery_rendition_enqueue_item',
    'TRIGGER_DRIFT',
  ],
  [
    '147 commit guard disabled',
    'ALTER TABLE public.restore_processing_admission DISABLE TRIGGER restore_processing_force_rls_at_commit',
    'TRIGGER_DRIFT',
  ],
  [
    'parent-side trigger dropped',
    'DROP TRIGGER gallery_navigation_media_deleted ON public.gallery_media_item',
    'TRIGGER_DRIFT',
  ],
  [
    'trigger re-timed',
    'DROP TRIGGER gallery_rendition_retire_erased ON public.gallery_media_item; CREATE TRIGGER gallery_rendition_retire_erased AFTER DELETE ON public.gallery_media_item FOR EACH ROW EXECUTE FUNCTION public.gallery_rendition_retire_item_v1()',
    'TRIGGER_DRIFT',
  ],
  [
    'trigger WHEN removed',
    'DROP TRIGGER gallery_navigation_media_deleted ON public.gallery_media_item; CREATE TRIGGER gallery_navigation_media_deleted AFTER UPDATE OF deleted_at ON public.gallery_media_item FOR EACH ROW EXECUTE FUNCTION public.remove_gallery_navigation_on_media_deletion_v1()',
    'TRIGGER_DRIFT',
  ],
  [
    'trigger column scope',
    'DROP TRIGGER gallery_rendition_retire_deleted ON public.gallery_media_item; CREATE TRIGGER gallery_rendition_retire_deleted AFTER UPDATE ON public.gallery_media_item FOR EACH ROW EXECUTE FUNCTION public.gallery_rendition_retire_item_v1()',
    'TRIGGER_DRIFT',
  ],
  [
    'V11 function used by an extra trigger',
    'CREATE TRIGGER x_extra BEFORE UPDATE ON public.race_result FOR EACH ROW EXECUTE FUNCTION public.guard_ai_execution_job_v1()',
    'TRIGGER_DRIFT',
  ],
  [
    'extra trigger on a V11 table',
    'CREATE TRIGGER x_extra BEFORE UPDATE ON public.gallery_album FOR EACH ROW EXECUTE FUNCTION public.reject_restore_suppression_event_mutation()',
    'TRIGGER_DRIFT',
  ],
  // Functions: body, definer, configuration, ACL.
  [
    'owner function PUBLIC EXECUTE',
    'GRANT EXECUTE ON FUNCTION public.enqueue_gallery_renditions_v1(uuid) TO PUBLIC',
    'FUNCTION_DRIFT',
  ],
  [
    '147 open_ granted to runtime',
    `GRANT EXECUTE ON FUNCTION public.open_restore_processing_admission_window(bigint,uuid,uuid) TO "${runtimeRole}"`,
    'FUNCTION_DRIFT',
  ],
  [
    '147 assert_ granted to runtime',
    `GRANT EXECUTE ON FUNCTION public.assert_restore_processing_closed(bigint,uuid,uuid) TO "${runtimeRole}"`,
    'FUNCTION_DRIFT',
  ],
  [
    'runtime RPC grantable',
    `GRANT EXECUTE ON FUNCTION public.create_gallery_album_v1(jsonb,text) TO "${runtimeRole}" WITH GRANT OPTION`,
    'FUNCTION_DRIFT',
  ],
  [
    'worker RPC PUBLIC EXECUTE',
    'GRANT EXECUTE ON FUNCTION public.claim_gallery_rendition_v1(uuid,integer) TO PUBLIC',
    'FUNCTION_DRIFT',
  ],
  [
    'definer flipped',
    'ALTER FUNCTION public.guard_gallery_album_row_v1() SECURITY DEFINER',
    'FUNCTION_DRIFT',
  ],
  [
    'search_path changed',
    'ALTER FUNCTION public.read_gallery_renditions_v1(uuid) SET search_path=public',
    'FUNCTION_DRIFT',
  ],
  [
    'volatility changed',
    'ALTER FUNCTION public.gallery_album_title_valid_v1(text) VOLATILE',
    'FUNCTION_DRIFT',
  ],
  [
    '147 roster function dropped',
    'DROP FUNCTION public.restore_processing_admission_roster_drift()',
    'FUNCTION_DRIFT',
  ],
  [
    'V10 guard trigger disabled',
    'ALTER TABLE public.race_event DISABLE TRIGGER race_local_date_approval_guard',
    'FUNCTION_DRIFT',
  ],
  // Tables: FORCE RLS, ACL, structure; accepted parent changes and anything else on them.
  [
    'FORCE RLS off',
    'ALTER TABLE public.gallery_album NO FORCE ROW LEVEL SECURITY',
    'STRUCTURE_DRIFT',
  ],
  ['PUBLIC SELECT', 'GRANT SELECT ON public.ai_execution_job TO PUBLIC', 'STRUCTURE_DRIFT'],
  [
    'runtime UPDATE',
    `GRANT UPDATE ON public.ai_execution_job TO "${runtimeRole}"`,
    'STRUCTURE_DRIFT',
  ],
  [
    'runtime reads derived renditions',
    `GRANT SELECT ON public.gallery_rendition_job TO "${runtimeRole}"`,
    'STRUCTURE_DRIFT',
  ],
  [
    'runtime attestation INSERT',
    `GRANT INSERT ON public.ai_synthetic_evidence_attestation TO "${runtimeRole}"`,
    'STRUCTURE_DRIFT',
  ],
  [
    'column grant',
    `GRANT SELECT(job_id) ON public.ai_execution_job TO "${runtimeRole}"`,
    'STRUCTURE_DRIFT',
  ],
  [
    'receipt grantable',
    `GRANT SELECT ON public.gallery_album TO "${runtimeRole}" WITH GRANT OPTION`,
    'STRUCTURE_DRIFT',
  ],
  [
    'new-table column added',
    'ALTER TABLE public.gallery_rendition_sweep ADD COLUMN x integer',
    'STRUCTURE_DRIFT',
  ],
  [
    'new-table FK dropped',
    'ALTER TABLE public.ai_execution_job DROP CONSTRAINT ai_execution_job_athlete_id_run_id_fkey',
    'STRUCTURE_DRIFT',
  ],
  ['new-table index dropped', 'DROP INDEX public.ai_execution_job_created', 'STRUCTURE_DRIFT'],
  [
    'new-table policy dropped',
    'DROP POLICY ai_execution_job_tenant ON public.ai_execution_job',
    'STRUCTURE_DRIFT',
  ],
  [
    '145 parent index dropped',
    'DROP INDEX public.restore_suppression_event_gallery_album_once',
    'STRUCTURE_DRIFT',
  ],
  [
    '145 parent CHECK not validated',
    'ALTER TABLE public.restore_suppression_event DROP CONSTRAINT restore_suppression_event_record_version_check, ADD CONSTRAINT restore_suppression_event_record_version_check CHECK (record_version BETWEEN 1 AND 8) NOT VALID',
    'STRUCTURE_DRIFT',
  ],
  [
    '147 control shape dropped',
    'ALTER TABLE public.restore_processing_admission DROP CONSTRAINT restore_processing_admitted_shape',
    'STRUCTURE_DRIFT',
  ],
  [
    '147 control column default',
    "ALTER TABLE public.restore_processing_admission ALTER COLUMN admitted_head_sha256 SET DEFAULT 'x'",
    'STRUCTURE_DRIFT',
  ],
  [
    'touched parent extra column',
    'ALTER TABLE public.gallery_media_item ADD COLUMN x integer',
    'STRUCTURE_DRIFT',
  ],
  [
    'RI parent extra index',
    'CREATE INDEX x_extra ON public.coaching_run(athlete_id)',
    'STRUCTURE_DRIFT',
  ],
  // Ledgers: own receipts, parent receipts, unknown ledgers.
  [
    'missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v11 WHERE extension_step=4',
    'LEDGER_INVALID',
  ],
  [
    'parent10 missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v10 WHERE extension_step=1',
    'LEDGER_INVALID',
  ],
  [
    'parent8 missing receipt',
    'DELETE FROM wm_runtime_installation.profile_extension_v8 WHERE extension_step=8',
    'LEDGER_INVALID',
  ],
  [
    'source tuple',
    "UPDATE wm_runtime_installation.profile_extension_v11 SET source_sha256=repeat('0',64) WHERE extension_step=4",
    'CHECK',
  ],
  [
    'ddl tuple',
    'UPDATE wm_runtime_installation.profile_extension_v11 SET source_ddl_id=146 WHERE extension_step=4',
    'CHECK',
  ],
  [
    'dropped CHECK',
    'ALTER TABLE wm_runtime_installation.profile_extension_v11 DROP CONSTRAINT profile_extension_v11_ddl',
    'LEDGER_INVALID',
  ],
  [
    'ledger foreign ACL',
    `GRANT SELECT ON wm_runtime_installation.profile_extension_v11 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'column foreign ACL',
    `GRANT SELECT(filename) ON wm_runtime_installation.profile_extension_v11 TO "${runtimeRole}"`,
    'LEDGER_INVALID',
  ],
  [
    'unknown extension',
    'CREATE TABLE wm_runtime_installation.profile_extension_v12(id int)',
    'LEDGER_INVALID',
  ],
] as const;
for (const [label, sql, expected] of drift)
  fixtureIt(
    `actual ${label} drift fails closed and rollback restores the original receipts`,
    async () => {
      await rollback(async (tx) => {
        if (expected === 'CHECK') {
          await rejected(tx, () => tx.query(sql), 'check constraint');
        } else {
          await tx.query(sql);
          await rejected(tx, () => verifyCurrentRuntimeV11InstalledIn(tx), expected);
          await rejected(tx, () => installCurrentRuntimeV11In(tx), 'CURRENT_RUNTIME_V11_');
        }
      });
      await session(fresh, async (tx) => {
        await tx.query('BEGIN');
        await verifyCurrentRuntimeV11InstalledIn(tx);
        await tx.query('ROLLBACK');
        expect((await tx.query(ledgerSql)).rows[0]?.['value']).toEqual(baselineReceipt);
      });
    },
  );
fixtureIt('a delegated runtime RPC and the allowed table privileges still verify', async () => {
  await rollback(async (tx) => {
    await tx.query(
      `GRANT EXECUTE ON FUNCTION public.create_gallery_album_v1(jsonb,text) TO "${runtimeRole}"`,
    );
    await tx.query(
      `GRANT SELECT,INSERT ON public.ai_execution_job_disposition TO "${runtimeRole}"`,
    );
    await tx.query(`GRANT SELECT ON public.gallery_album TO "${runtimeRole}"`);
    await expect(verifyCurrentRuntimeV11InstalledIn(tx)).resolves.toMatchObject({
      runtimeStep: 27,
    });
  });
});
fixtureIt(
  'body tampering of a new function and of a 147 replacement is function drift',
  async () => {
    for (const signature of [
      'public.gallery_album_title_valid_v1(text)',
      'public.require_restore_processing_admission()',
      'public.restore_processing_admission_roster()',
    ])
      await rollback(async (tx) => {
        const row = (
          await tx.query(
            'SELECT pg_get_functiondef(to_regprocedure($1)) AS definition,prosrc AS body FROM pg_proc WHERE oid=to_regprocedure($1)',
            [signature],
          )
        ).rows[0];
        const definition = z.string().parse(row?.['definition']);
        const body = z.string().parse(row?.['body']);
        expect(definition.split(body)).toHaveLength(2);
        await tx.query(definition.replace(body, () => `${body}\n-- tampered\n`));
        await rejected(tx, () => verifyCurrentRuntimeV11InstalledIn(tx), 'FUNCTION_DRIFT');
      });
  },
);
fixtureIt(
  'install refuses any parent change beyond the pinned one and any unpinned new object',
  async () => {
    const database = await newDatabase('delta', true);
    for (const [label, extra] of [
      ['extra parent CHECK', 'ALTER TABLE public.coaching_run ADD CONSTRAINT x_extra CHECK (true)'],
      ['extra parent ACL', `GRANT SELECT ON public.coaching_run TO "${runtimeRole}"`],
      [
        'parent function replaced',
        "ALTER FUNCTION public.lock_restore_processing_shared() SET work_mem='1MB'",
      ],
      [
        'extra new function',
        'CREATE FUNCTION public.x_extra() RETURNS integer LANGUAGE sql AS $$SELECT 1$$',
      ],
      ['extra new table', 'CREATE TABLE public.x_extra(id integer)'],
      ['extra namespace', 'CREATE SCHEMA x_extra'],
    ] as const)
      await session(database, async (tx) => {
        await tx.query('BEGIN');
        let injected = false;
        try {
          await installCurrentRuntimeV11In({
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (!injected && sql === (await member(148))) {
                injected = true;
                await tx.query(extra);
              }
              return result;
            },
          });
          throw Error(`NOT_REFUSED ${label}`);
        } catch (e) {
          await tx.query('ROLLBACK');
          expect([label, injected, (e as Error).message]).toEqual([
            label,
            true,
            'CURRENT_RUNTIME_V11_METADATA_CHANGED',
          ]);
        }
        await tx.query('BEGIN');
        expect((await tx.query(absenceSql, [[...currentRuntimeV11Tables]])).rows[0]).toEqual(
          absent,
        );
        await verifyCurrentRuntimeV10InstalledIn(tx);
        await tx.query('ROLLBACK');
      });
  },
);
fixtureIt(
  'a fault after members and before the last receipt rolls back to a genuine verifying profile26',
  async () => {
    const database = await newDatabase('fault', true);
    await session(database, async (tx) => {
      await tx.query('BEGIN');
      let applied = false;
      try {
        await installCurrentRuntimeV11In({
          query: async (sql, values) => {
            if (
              sql.startsWith('INSERT INTO wm_runtime_installation.profile_extension_v11') &&
              (values as unknown[])[0] === 5
            ) {
              applied =
                (
                  await tx.query(
                    "SELECT to_regclass('public.ai_execution_job') IS NOT NULL AND to_regclass('public.gallery_album') IS NOT NULL AS present",
                  )
                ).rows[0]?.['present'] === true;
              throw Error('FORCED_RECEIPT_FAULT');
            }
            return tx.query(sql, values);
          },
        });
        throw Error('FAULT_NOT_REACHED');
      } catch (e) {
        await tx.query('ROLLBACK');
        expect(e).toEqual(Error('FORCED_RECEIPT_FAULT'));
      }
      expect(applied).toBe(true);
      await tx.query('BEGIN');
      await verifyCurrentRuntimeV10InstalledIn(tx);
      expect((await tx.query(absenceSql, [[...currentRuntimeV11Tables]])).rows[0]).toEqual(absent);
      await tx.query('ROLLBACK');
    });
    // A whole successful install that the caller aborts also rolls back atomically.
    await session(database, async (tx) => {
      await tx.query('BEGIN');
      try {
        await installCurrentRuntimeV11In(tx);
        throw Error('FORCED_INSTALL_ABORT');
      } catch (e) {
        await tx.query('ROLLBACK');
        expect(e).toEqual(Error('FORCED_INSTALL_ABORT'));
      }
      await tx.query('BEGIN');
      await verifyCurrentRuntimeV10InstalledIn(tx);
      expect((await tx.query(absenceSql, [[...currentRuntimeV11Tables]])).rows[0]).toEqual(absent);
      await tx.query('ROLLBACK');
    });
  },
);
fixtureIt(
  'read-only verifier cannot turn normal107 or genuine profile26 into receipted profile27',
  async () => {
    const database = await newDatabase('normal');
    await expect(
      session(database, async (tx) => {
        await tx.query('BEGIN');
        return verifyCurrentRuntimeV11InstalledIn(tx);
      }),
    ).rejects.toThrow();
    await installCurrentRuntimeV10(url(database));
    await expect(
      session(database, async (tx) => {
        await tx.query('BEGIN');
        return verifyCurrentRuntimeV11InstalledIn(tx);
      }),
    ).rejects.toThrow('CURRENT_RUNTIME_V11_LEDGER_INVALID');
  },
);
fixtureIt('fresh and upgraded catalogs agree on every V11 structure line', async () => {
  const lines = async (database: string) =>
    session(database, async (tx) => {
      await tx.query('BEGIN');
      const all = await captureCurrentRuntimeV11CatalogLinesIn(
        tx,
        currentRuntimeV11Tables.map((t) => `public.${t}`),
      );
      await tx.query('ROLLBACK');
      return all.filter((l) => l.kind !== 'acl' && l.kind !== 'column_acl');
    });
  expect(await lines(upgrade)).toEqual(await lines(fresh));
});
