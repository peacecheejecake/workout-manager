import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { migrationFileNames } from './migrate.js';

/** Source artifact IDs are not legacy schema_migrations versions. Restore-only
 * artifacts stay excluded; no skipped artifact receives an applied receipt. */
const members = [
  {
    step: 1,
    sourceDdlId: 108,
    filename: '108_nutrition_race_disconnection.sql',
    sha256: 'b71fc7ab7cb863932f1472c28d46200f42f22bc25d8ca198b529b6cc564a20f4',
  },
  {
    step: 2,
    sourceDdlId: 109,
    filename: '109_race_result_proof_lifecycle.sql',
    sha256: 'fd2ecf020660c48d39990acdedc5838651ff873e7970b882814264b58808a9fa',
  },
  {
    step: 3,
    sourceDdlId: 110,
    filename: '110_nutrition_disconnection_lineage.sql',
    sha256: 'd2891aeaeb3af586c42e4e2ee924eb4adc9de0e61af3011219c654a185c91614',
  },
  {
    step: 4,
    sourceDdlId: 111,
    filename: '111_race_result_preserved_proof_updates.sql',
    sha256: '69b7689c8579575eb899d2602e979db697039cb75b8a7b8f71ab54154b0d4576',
  },
  {
    step: 5,
    sourceDdlId: 112,
    filename: '112_training_plan_aggregate_history.sql',
    sha256: '4cff9ecaae439618e3ec2b24de5428fb377f4c8a843df983aba7a765171b3dfb',
  },
  {
    step: 6,
    sourceDdlId: 113,
    filename: '113_race_media_cleanup_source.sql',
    sha256: 'b5e97aeb781d59c7b5fdef60962a6a05aed5f43336ebbc98debff455276e88b9',
  },
  {
    step: 7,
    sourceDdlId: 114,
    filename: '114_manual_review_owned_source_bindings_v2.sql',
    sha256: 'a0673efde1a0d5ae89248438d4a62a68744b0783388c560400ddedc507d2dfdf',
  },
  {
    step: 8,
    sourceDdlId: 115,
    filename: '115_manual_review_full_owned_source_bindings_v2.sql',
    sha256: '5ee731099bf520290aabab179fcb94872b984b515cc2d556fda990eb228841b3',
  },
  {
    step: 9,
    sourceDdlId: 116,
    filename: '116_manual_race_chain_v2.sql',
    sha256: '2d1a9b5f7443de7f8b1d5a37e405d038513f86c39fb9c9d8fb9eb11c17e2c4ea',
  },
  {
    step: 10,
    sourceDdlId: 118,
    filename: '118_race_manual_atomic_approval.sql',
    sha256: '781f329238f379408f33726e6cb5faf55212918bf32fa353841a9bc42684b623',
  },
  {
    step: 11,
    sourceDdlId: 120,
    filename: '120_manual_race_multi_owned_sources.sql',
    sha256: 'f95368d67ce3793561bc09a15e252df7f2eadc78dfde799a35a1cb733e3bac78',
  },
  {
    step: 12,
    sourceDdlId: 121,
    filename: '121_routine_versioned_occurrences.sql',
    sha256: '82eb2b4c597f5e8259de35af6a984b0613f6740e1bb36140673c05c4cae29cd8',
  },
  {
    step: 13,
    sourceDdlId: 122,
    filename: '122_race_manual_public_receipts.sql',
    sha256: '14d85313329b6d0d8ae4e209efc219e45046fb2cd760109841864a72013d9dda',
  },
  {
    step: 14,
    sourceDdlId: 123,
    filename: '123_check_in_template_versions.sql',
    sha256: '6d3ad2f18cb7b1c99d63ccff582214b6ba8f0318a72c1238092140a5ffc9444c',
  },
  {
    step: 15,
    sourceDdlId: 124,
    filename: '124_race_manual_public_preview_source.sql',
    sha256: '6a339bd014f9f9240378202b70907fe28221440ab522281ca725d27d57666955',
  },
  {
    step: 16,
    sourceDdlId: 126,
    filename: '126_manual_race_checklist_uuid_comparison.sql',
    sha256: 'eaf7019d29b27ec2696881e406b22b86bb55bdc8b86d1cc322adb28817bc6b0c',
  },
  {
    step: 17,
    sourceDdlId: 127,
    filename: '127_manual_race_nutrition_resolution_id.sql',
    sha256: 'caff05ddaed839a61a049b0ab72d46b2ee339dacca8b1b91c59ff1acbe0c54b4',
  },
] as const;
export const currentRuntimeMigrationMembers = Object.freeze(
  members.map((m) => Object.freeze({ ...m })),
);
export const currentRuntimeTargetTransforms = Object.freeze([117, 119, 125] as const);
const memberSchema = z.strictObject({
  step: z.number().int().min(1).max(17),
  sourceDdlId: z.number().int().min(108).max(127),
  filename: z.string().max(100),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const currentRuntimeLedgerSchema = z
  .array(memberSchema)
  .max(17)
  .superRefine((rows, c) => {
    rows.forEach((row, i) => {
      const expected = currentRuntimeMigrationMembers[i];
      if (
        !expected ||
        row.step !== expected.step ||
        row.sourceDdlId !== expected.sourceDdlId ||
        row.filename !== expected.filename ||
        row.sha256 !== expected.sha256
      )
        c.addIssue({
          code: 'custom',
          path: [i],
          message: 'Exact contiguous runtime prefix required',
        });
    });
  });
export class CurrentRuntimeInstallationError extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_BASE_MISMATCH'
      | 'CURRENT_RUNTIME_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_OWNER_REQUIRED'
      | 'CURRENT_RUNTIME_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_TARGET_TRANSFORM_PRESENT',
  ) {
    super(code);
  }
}
export interface CurrentRuntimeInstallationTransaction {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
function fail(code: CurrentRuntimeInstallationError['code']): never {
  throw new CurrentRuntimeInstallationError(code);
}
const baselineSchema = z
  .array(
    z.strictObject({ version: z.number().int(), checksum: z.string().regex(/^[a-f0-9]{64}$/) }),
  )
  .length(107);
async function sources() {
  if (migrationFileNames.length !== 107) fail('CURRENT_RUNTIME_BASE_MISMATCH');
  const baseline = await Promise.all(
    migrationFileNames.map(async (file, i) => ({
      version: i + 1,
      checksum: createHash('sha256')
        .update(await readFile(new URL(`../migrations/${file}`, import.meta.url)))
        .digest('hex'),
    })),
  );
  const runtime = await Promise.all(
    currentRuntimeMigrationMembers.map(async (member) => {
      const sql = await readFile(
        new URL(`../migrations/${member.filename}`, import.meta.url),
        'utf8',
      );
      if (createHash('sha256').update(sql).digest('hex') !== member.sha256)
        fail('CURRENT_RUNTIME_SOURCE_MISMATCH');
      return { member, sql };
    }),
  );
  return { baseline, runtime };
}
const ownerSchema = z.strictObject({
  plain: z.literal(true),
  owns: z.literal(true),
  same_role: z.literal(true),
});
const presenceSchema = z.strictObject({
  ledger: z.boolean(),
  target: z.boolean(),
  raw_stage: z.boolean(),
});
const ledgerCatalogSchema = z.strictObject({
  owned: z.literal(true),
  schema_owned: z.literal(true),
  schema_private: z.literal(true),
  table_private: z.literal(true),
  columns: z.literal(true),
  primary_key: z.literal(true),
  unique_keys: z.literal(true),
});
const bootstrap = `CREATE SCHEMA wm_runtime_installation;
REVOKE ALL ON SCHEMA wm_runtime_installation FROM PUBLIC;
CREATE TABLE wm_runtime_installation.migration (
 step integer PRIMARY KEY CHECK(step BETWEEN 1 AND 17),
 source_ddl_id integer NOT NULL UNIQUE CHECK(source_ddl_id BETWEEN 108 AND 127 AND source_ddl_id NOT IN (117,119,125)),
 filename text NOT NULL UNIQUE,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$')
);
REVOKE ALL ON wm_runtime_installation.migration FROM PUBLIC;`;
const ledgerCatalogSql = `SELECT
 c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owned,
 n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS schema_owned,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner) AS schema_private,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner) AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND x.grantee<>c.relowner) AS table_private,
 (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='[["step","integer",true],["source_ddl_id","integer",true],["filename","text",true],["source_sha256","text",true]]'::jsonb AS columns,
 EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='p' AND pg_get_constraintdef(k.oid)='PRIMARY KEY (step)') AS primary_key,
 (SELECT count(*) FROM pg_constraint k WHERE k.conrelid=c.oid AND k.contype='u' AND k.conkey IN (ARRAY[2]::smallint[],ARRAY[3]::smallint[]))=2 AS unique_keys
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relname='migration' AND c.relkind='r'`;
function result() {
  return {
    profileVersion: 1 as const,
    baselineSchemaVersion: 107 as const,
    runtimeStep: 17 as const,
    sourceDdlTip: 127 as const,
    appliedMembers: currentRuntimeMigrationMembers,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    restore: 'not_verified' as const,
  };
}
/** Installer-only transaction seam. It does not authorize domain processing or
 * authenticate an external payload. Caller must BEGIN/COMMIT this exact owner
 * connection; the public installer below provides that transaction. */
export async function installCurrentRuntimeIn(tx: CurrentRuntimeInstallationTransaction) {
  const input = await sources();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const { p, base } = await inspectInstalledBase(tx, input);
  if (p.data.target) fail('CURRENT_RUNTIME_TARGET_TRANSFORM_PRESENT');
  if (!p.data.ledger) {
    if (p.data.raw_stage) fail('CURRENT_RUNTIME_UNREGISTERED_STAGE');
    await tx.query(bootstrap);
  }
  const catalog = await tx.query(ledgerCatalogSql);
  if (catalog.rows.length !== 1 || !ledgerCatalogSchema.safeParse(catalog.rows[0]).success)
    fail('CURRENT_RUNTIME_LEDGER_INVALID');
  const current = await tx.query(
    'SELECT step,source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256 FROM wm_runtime_installation.migration ORDER BY step',
  );
  const prefix = currentRuntimeLedgerSchema.safeParse(current.rows);
  if (!prefix.success) fail('CURRENT_RUNTIME_LEDGER_INVALID');
  if (prefix.data.length === 0 && p.data.raw_stage) fail('CURRENT_RUNTIME_UNREGISTERED_STAGE');
  for (const entry of input.runtime.slice(prefix.data.length)) {
    await tx.query(entry.sql);
    await tx.query(
      'INSERT INTO wm_runtime_installation.migration(step,source_ddl_id,filename,source_sha256) VALUES($1,$2,$3,$4)',
      [entry.member.step, entry.member.sourceDdlId, entry.member.filename, entry.member.sha256],
    );
  }
  const final = await tx.query(
    'SELECT step,source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256 FROM wm_runtime_installation.migration ORDER BY step',
  );
  const done = currentRuntimeLedgerSchema.safeParse(final.rows);
  if (!done.success || done.data.length !== 17) fail('CURRENT_RUNTIME_LEDGER_INVALID');
  // No legacy registry mutation, no target transform installation, no runtime grants.
  const preserved = await tx.query(
    'SELECT version,checksum FROM public.schema_migrations ORDER BY version',
  );
  if (JSON.stringify(preserved.rows) !== JSON.stringify(base.rows))
    fail('CURRENT_RUNTIME_BASE_MISMATCH');
  return result();
}
/** Requires an already migrated, exact historical base107. Base install is
 * deliberately separate; an interrupted runtime install cannot create an applied
 * acknowledgement. Every runtime SQL and ledger row commits or rolls back together. */
export async function installCurrentRuntime(connectionString: string) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 });
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }
  let discard = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    const installed = await installCurrentRuntimeIn(client);
    await client.query('COMMIT');
    return installed;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
    await pool.end();
  }
}

async function inspectInstalledBase(
  tx: CurrentRuntimeInstallationTransaction,
  input: Awaited<ReturnType<typeof sources>>,
) {
  const role = await tx.query(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls AS plain,
 current_user=session_user AS same_role,
 NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','identity_private') AND c.relkind IN ('r','p') AND c.relowner<>r.oid) AND
 EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.schema_migrations') AND c.relowner=r.oid) AS owns
 FROM pg_roles r WHERE r.rolname=session_user`);
  if (role.rows.length !== 1 || !ownerSchema.safeParse(role.rows[0]).success)
    fail('CURRENT_RUNTIME_OWNER_REQUIRED');
  const base = await tx.query(
    'SELECT version,checksum FROM public.schema_migrations ORDER BY version',
  );
  const parsed = baselineSchema.safeParse(base.rows);
  if (
    !parsed.success ||
    parsed.data.some(
      (row, i) =>
        row.version !== input.baseline[i]?.version || row.checksum !== input.baseline[i]?.checksum,
    )
  )
    fail('CURRENT_RUNTIME_BASE_MISMATCH');
  const observed =
    await tx.query(`SELECT to_regclass('wm_runtime_installation.migration') IS NOT NULL AS ledger,
 EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN ('wm_current_app_load','wm_current_original_postimages','wm_identity_target_load')) AS target,
 (to_regclass('public.nutrition_race_item_disconnection') IS NOT NULL OR to_regclass('public.race_result_proof_ref') IS NOT NULL
 OR to_regclass('public.nutrition_race_disconnection_lineage') IS NOT NULL OR to_regclass('public.plan_snapshot_aggregate') IS NOT NULL
 OR to_regclass('public.manual_race_evidence_v2') IS NOT NULL OR to_regclass('public.race_manual_application_candidate_v1') IS NOT NULL
 OR to_regclass('public.race_manual_public_receipt_v1') IS NOT NULL OR to_regclass('public.check_in_template_version') IS NOT NULL
 OR to_regprocedure('public.read_race_media_cleanup(uuid,integer)') IS NOT NULL
 OR to_regprocedure('public.observe_manual_review_owned_source_bindings_v2(jsonb)') IS NOT NULL
 OR to_regprocedure('public.observe_manual_review_full_owned_source_bindings_v2(jsonb)') IS NOT NULL
 OR to_regprocedure('public.observe_manual_review_multi_owned_source_bindings_v3(jsonb)') IS NOT NULL
 OR to_regprocedure('public.read_race_manual_public_preview_source_v1(uuid)') IS NOT NULL
 OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.routine_occurrence') AND conname='routine_occurrence_version_anchor_unique')) AS raw_stage`);
  const p = presenceSchema.safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !p.success) fail('CURRENT_RUNTIME_LEDGER_INVALID');
  return { p, base };
}
/** Read-only installer-profile check for grant composition. Requires the same
 * plain owner; it never installs, grants, changes GUC, or accepts caller witnesses.
 * Whole catalog/security/restore closure remains explicitly not_verified. */
export async function verifyCurrentRuntimeInstalledIn(tx: CurrentRuntimeInstallationTransaction) {
  const input = await sources();
  const { p } = await inspectInstalledBase(tx, input);
  if (p.data.target) fail('CURRENT_RUNTIME_TARGET_TRANSFORM_PRESENT');
  if (!p.data.ledger) fail('CURRENT_RUNTIME_LEDGER_INVALID');
  const catalog = await tx.query(ledgerCatalogSql);
  if (catalog.rows.length !== 1 || !ledgerCatalogSchema.safeParse(catalog.rows[0]).success)
    fail('CURRENT_RUNTIME_LEDGER_INVALID');
  const found = await tx.query(
    'SELECT step,source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256 FROM wm_runtime_installation.migration ORDER BY step',
  );
  const rows = currentRuntimeLedgerSchema.safeParse(found.rows);
  if (!rows.success || rows.data.length !== 17) fail('CURRENT_RUNTIME_LEDGER_INVALID');
  return result();
}
