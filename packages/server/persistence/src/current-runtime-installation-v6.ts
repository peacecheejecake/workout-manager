import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  currentRuntimeMigrationMembers,
  currentRuntimeTargetTransforms,
  type CurrentRuntimeInstallationTransaction,
} from './current-runtime-installation.js';
import { currentRuntimeV2ExtensionMember } from './current-runtime-installation-v2.js';
import { currentRuntimeV3ExtensionMember } from './current-runtime-installation-v3.js';
import { currentRuntimeV4ExtensionMember } from './current-runtime-installation-v4.js';
import {
  currentRuntimeV5ExtensionMember,
  installCurrentRuntimeV5In,
  verifyCurrentRuntimeV5InstalledIn,
} from './current-runtime-installation-v5.js';

// This exact successor preserves all parent21 ledgers/artifacts. Source IDs
// remain distinct from baseline schema_migrations versions and logical steps.
export const currentRuntimeV6ParentManifestSha256 =
  'fdaed0a1569f9bed4e666b4f94c17996cc52f1665b2f03e32314c266d7617fab';
export const currentRuntimeV6ExtensionMember = Object.freeze({
  extensionStep: 1 as const,
  sourceDdlId: 132 as const,
  filename: '132_manual_retained_source_export_batch.sql' as const,
  sha256: '07088ed6119fa52129dd8e4615253e6b00814d5b1d085fc98cc5268fcea9c30c',
});
const signature = 'public.read_manual_race_retained_source_batch_v1(integer)';
export class CurrentRuntimeInstallationV6Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V6_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V6_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V6_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V6_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V6_BATCH_MISSING'
      | 'CURRENT_RUNTIME_V6_BATCH_DRIFT',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV6Error['code']): never {
  throw new CurrentRuntimeInstallationV6Error(code);
}
function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}
const parentMembers = Object.freeze([
  ...currentRuntimeMigrationMembers,
  Object.freeze({
    step: 18 as const,
    sourceDdlId: currentRuntimeV2ExtensionMember.sourceDdlId,
    filename: currentRuntimeV2ExtensionMember.filename,
    sha256: currentRuntimeV2ExtensionMember.sha256,
  }),
  Object.freeze({
    step: 19 as const,
    sourceDdlId: currentRuntimeV3ExtensionMember.sourceDdlId,
    filename: currentRuntimeV3ExtensionMember.filename,
    sha256: currentRuntimeV3ExtensionMember.sha256,
  }),
  Object.freeze({
    step: 20 as const,
    sourceDdlId: currentRuntimeV4ExtensionMember.sourceDdlId,
    filename: currentRuntimeV4ExtensionMember.filename,
    sha256: currentRuntimeV4ExtensionMember.sha256,
  }),
  Object.freeze({
    step: 21 as const,
    sourceDdlId: currentRuntimeV5ExtensionMember.sourceDdlId,
    filename: currentRuntimeV5ExtensionMember.filename,
    sha256: currentRuntimeV5ExtensionMember.sha256,
  }),
]);
const parentJson = JSON.stringify({
  encoding: 'current-runtime-profile-v5-parent-manifest-v1',
  profileVersion: 5,
  baselineSchemaVersion: 107,
  runtimeStep: 21,
  members: parentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function extensionSource() {
  if (
    createHash('sha256').update(parentJson).digest('hex') !== currentRuntimeV6ParentManifestSha256
  )
    fail('CURRENT_RUNTIME_V6_PARENT_MISMATCH');
  const sql = await readFile(
    new URL(`../migrations/${currentRuntimeV6ExtensionMember.filename}`, import.meta.url),
    'utf8',
  );
  if (createHash('sha256').update(sql).digest('hex') !== currentRuntimeV6ExtensionMember.sha256)
    fail('CURRENT_RUNTIME_V6_SOURCE_MISMATCH');
  return sql;
}
const receiptSchema = z.strictObject({
  extensionStep: z.literal(1),
  sourceDdlId: z.literal(132),
  filename: z.literal(currentRuntimeV6ExtensionMember.filename),
  sha256: z.literal(currentRuntimeV6ExtensionMember.sha256),
  parentManifestSha256: z.literal(currentRuntimeV6ParentManifestSha256),
});
const checks = [
  ['profile_extension_v6_step', 'extension_step = 1'],
  ['profile_extension_v6_ddl', 'source_ddl_id = 132'],
  [
    'profile_extension_v6_filename',
    `filename = ${literal(currentRuntimeV6ExtensionMember.filename)}::text`,
  ],
  [
    'profile_extension_v6_source',
    `source_sha256 = ${literal(currentRuntimeV6ExtensionMember.sha256)}::text`,
  ],
  [
    'profile_extension_v6_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV6ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v6 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v6_step CHECK(extension_step=1),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v6_ddl CHECK(source_ddl_id=132),
 filename text NOT NULL CONSTRAINT profile_extension_v6_filename CHECK(filename=${literal(currentRuntimeV6ExtensionMember.filename)}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v6_source CHECK(source_sha256=${literal(currentRuntimeV6ExtensionMember.sha256)}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v6_parent CHECK(parent_manifest_sha256=${literal(currentRuntimeV6ParentManifestSha256)}),
 CONSTRAINT profile_extension_v6_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v6_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v6_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v6 FROM PUBLIC;`;
const expectedConstraints = [
  ...checks.map(([name, expression]) => ({
    name,
    kind: 'c',
    definition: `CHECK ((${expression}))`,
    validated: true,
    deferrable: false,
    deferred: false,
  })),
  {
    name: 'profile_extension_v6_pkey',
    kind: 'p',
    definition: 'PRIMARY KEY (extension_step)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v6_source_ddl_id_key',
    kind: 'u',
    definition: 'UNIQUE (source_ddl_id)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v6_filename_key',
    kind: 'u',
    definition: 'UNIQUE (filename)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const catalogSchema = z.strictObject({
  owner: z.literal(true),
  private: z.literal(true),
  columns: z.literal(true),
  constraints: z.literal(true),
  shape: z.literal(true),
});
const catalogSql = `SELECT
 current_user=session_user AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user)
 AND n.nspowner=c.relowner AS owner,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND x.grantee<>c.relowner) AS private,
 (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0)
 = '[ ["extension_step","integer",true],["source_ddl_id","integer",true],["filename","text",true],["source_sha256","text",true],["parent_manifest_sha256","text",true] ]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND (a.attisdropped OR a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'')) AS columns,
 (SELECT jsonb_agg(jsonb_build_object('name',k.conname,'kind',k.contype,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid)=$1::jsonb AS constraints,
 c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition
 AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid)
 AND (SELECT count(*) FROM pg_index i WHERE i.indrelid=c.oid)=3
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indisunique OR i.indpred IS NOT NULL OR i.indexprs IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.conindid=i.indexrelid AND k.contype IN('p','u')))) AS shape
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='wm_runtime_installation' AND c.relname='profile_extension_v6'`;
const receiptSql = `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.profile_extension_v6 ORDER BY extension_step`;
async function readReceipt(tx: CurrentRuntimeInstallationTransaction) {
  const catalog = await tx.query(catalogSql, [JSON.stringify(expectedConstraints)]);
  if (catalog.rows.length !== 1 || !catalogSchema.safeParse(catalog.rows[0]).success)
    fail('CURRENT_RUNTIME_V6_LEDGER_INVALID');
  const found = await tx.query(receiptSql);
  if (found.rows.length !== 1) fail('CURRENT_RUNTIME_V6_LEDGER_INVALID');
  const parsed = receiptSchema.safeParse(found.rows[0]);
  if (!parsed.success) fail('CURRENT_RUNTIME_V6_LEDGER_INVALID');
  return parsed.data;
}
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const observed = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v6') IS NOT NULL AS ledger,to_regprocedure($1) IS NOT NULL AS batch`,
    [signature],
  );
  const parsed = z
    .strictObject({ ledger: z.boolean(), batch: z.boolean() })
    .safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V6_LEDGER_INVALID');
  return parsed.data;
}

const rpcSchema = z.strictObject({
  owner: z.literal(true),
  language: z.literal('plpgsql'),
  resultType: z.literal('jsonb'),
  definer: z.literal(true),
  volatility: z.literal('v'),
  parallel: z.literal('u'),
  strict: z.literal(false),
  setReturning: z.literal(false),
  configuration: z.tuple([
    z.literal('search_path=pg_catalog, pg_temp'),
    z.literal('TimeZone=UTC'),
    z.literal('DateStyle=ISO,YMD'),
  ]),
  privatePublic: z.literal(true),
  safeDelegation: z.literal(true),
  body: z.string().max(1048576),
});
async function verifyBatch(tx: CurrentRuntimeInstallationTransaction, sql: string) {
  const parts = sql.split('$$');
  const expectedBody = parts[1];
  if (
    parts.length !== 3 ||
    !expectedBody ||
    !parts[0]?.endsWith(' AS ') ||
    !parts[2]?.startsWith(
      ';\nREVOKE ALL ON FUNCTION public.read_manual_race_retained_source_batch_v1(integer) FROM PUBLIC;',
    )
  )
    fail('CURRENT_RUNTIME_V6_SOURCE_MISMATCH');
  const observed = await tx.query(
    `SELECT p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND current_user=session_user AS owner,
 l.lanname AS language,pg_get_function_result(p.oid) AS "resultType",p.prosecdef AS definer,p.provolatile AS volatility,p.proparallel AS parallel,p.proisstrict AS strict,p.proretset AS "setReturning",p.proconfig AS configuration,CASE WHEN octet_length(p.prosrc)=$2 THEN p.prosrc ELSE NULL END AS body,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) AS "privatePublic",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable)) AS "safeDelegation"
 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`,
    [signature, Buffer.byteLength(expectedBody, 'utf8')],
  );
  const parsed = rpcSchema.safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !parsed.success || parsed.data.body !== expectedBody)
    fail('CURRENT_RUNTIME_V6_BATCH_DRIFT');
}

function result(receipt: z.infer<typeof receiptSchema>) {
  return {
    profileVersion: 6 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 21 as const,
    extensionStep: 1 as const,
    runtimeStep: 22 as const,
    sourceDdlTip: 132 as const,
    parentManifestSha256: currentRuntimeV6ParentManifestSha256,
    extensionReceipt: receipt,
    parentAppliedMembers: parentMembers,
    extensionMember: currentRuntimeV6ExtensionMember,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
/** Owner-only verifier: exact V1–V5 provenance plus the fixed132 body and local function metadata.
 * This does not verify transitive security, runtime support, processing or restore. */
export async function verifyCurrentRuntimeV6InstalledIn(tx: CurrentRuntimeInstallationTransaction) {
  const sql = await extensionSource();
  await verifyCurrentRuntimeV5InstalledIn(tx);
  const p = await presence(tx);
  if (!p.ledger)
    fail(p.batch ? 'CURRENT_RUNTIME_V6_UNREGISTERED_STAGE' : 'CURRENT_RUNTIME_V6_LEDGER_INVALID');
  const receipt = await readReceipt(tx);
  if (!p.batch) fail('CURRENT_RUNTIME_V6_BATCH_MISSING');
  await verifyBatch(tx, sql);
  return result(receipt);
}
/** Same transaction parent+extension installer. Existing V1–V5 use these exact
 * xact locks too; reentrant acquisition stays held until this caller commits. */
export async function installCurrentRuntimeV6In(tx: CurrentRuntimeInstallationTransaction) {
  const sql = await extensionSource();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  await installCurrentRuntimeV5In(tx);
  await verifyCurrentRuntimeV5InstalledIn(tx);
  const p = await presence(tx);
  if (p.ledger) return verifyCurrentRuntimeV6InstalledIn(tx);
  if (p.batch) fail('CURRENT_RUNTIME_V6_UNREGISTERED_STAGE');
  await tx.query(bootstrap);
  await tx.query(sql);
  await tx.query(
    `INSERT INTO wm_runtime_installation.profile_extension_v6(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES(1,132,$1,$2,$3)`,
    [
      currentRuntimeV6ExtensionMember.filename,
      currentRuntimeV6ExtensionMember.sha256,
      currentRuntimeV6ParentManifestSha256,
    ],
  );
  return verifyCurrentRuntimeV6InstalledIn(tx);
}
export async function installCurrentRuntimeV6(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  try {
    const tx = await pool.connect();
    let discard = false;
    try {
      await tx.query('BEGIN');
      const installed = await installCurrentRuntimeV6In(tx);
      await tx.query('COMMIT');
      return installed;
    } catch (error) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      tx.release(discard);
    }
  } finally {
    await pool.end();
  }
}
