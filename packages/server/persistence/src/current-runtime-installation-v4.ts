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
import {
  currentRuntimeV3ExtensionMember,
  installCurrentRuntimeV3In,
  verifyCurrentRuntimeV3InstalledIn,
} from './current-runtime-installation-v3.js';

// This exact successor preserves all parent19 ledgers/artifacts. Source IDs
// remain distinct from baseline schema_migrations versions and logical steps.
export const currentRuntimeV4ParentManifestSha256 =
  '55db9bfe52c52fa4e91678c74ad21e4fb7bea4cc3382b69126c9c9ba4570b46e';
export const currentRuntimeV4ExtensionMember = Object.freeze({
  extensionStep: 1 as const,
  sourceDdlId: 130 as const,
  filename: '130_retained_source_provenance_export.sql' as const,
  sha256: 'dc3d7e4b5d301c6804561c6f1405eaa37992fad4a46b7ee2b4b7457cbdc083a5',
});
const signatures = [
  'public.manual_source_personal_row_exists_v1(jsonb,jsonb)',
  'public.read_manual_race_source_personal_export_v1(integer)',
  'public.read_nutrition_disconnection_personal_export_v1(integer)',
] as const;
export class CurrentRuntimeInstallationV4Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V4_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V4_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V4_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V4_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V4_READERS_MISSING',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV4Error['code']): never {
  throw new CurrentRuntimeInstallationV4Error(code);
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
]);
const parentJson = JSON.stringify({
  encoding: 'current-runtime-profile-v3-parent-manifest-v1',
  profileVersion: 3,
  baselineSchemaVersion: 107,
  runtimeStep: 19,
  members: parentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function extensionSource() {
  if (
    createHash('sha256').update(parentJson).digest('hex') !== currentRuntimeV4ParentManifestSha256
  )
    fail('CURRENT_RUNTIME_V4_PARENT_MISMATCH');
  const sql = await readFile(
    new URL(`../migrations/${currentRuntimeV4ExtensionMember.filename}`, import.meta.url),
    'utf8',
  );
  if (createHash('sha256').update(sql).digest('hex') !== currentRuntimeV4ExtensionMember.sha256)
    fail('CURRENT_RUNTIME_V4_SOURCE_MISMATCH');
  return sql;
}
const receiptSchema = z.strictObject({
  extensionStep: z.literal(1),
  sourceDdlId: z.literal(130),
  filename: z.literal(currentRuntimeV4ExtensionMember.filename),
  sha256: z.literal(currentRuntimeV4ExtensionMember.sha256),
  parentManifestSha256: z.literal(currentRuntimeV4ParentManifestSha256),
});
const checks = [
  ['profile_extension_v4_step', 'extension_step = 1'],
  ['profile_extension_v4_ddl', 'source_ddl_id = 130'],
  [
    'profile_extension_v4_filename',
    `filename = ${literal(currentRuntimeV4ExtensionMember.filename)}::text`,
  ],
  [
    'profile_extension_v4_source',
    `source_sha256 = ${literal(currentRuntimeV4ExtensionMember.sha256)}::text`,
  ],
  [
    'profile_extension_v4_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV4ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v4 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v4_step CHECK(extension_step=1),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v4_ddl CHECK(source_ddl_id=130),
 filename text NOT NULL CONSTRAINT profile_extension_v4_filename CHECK(filename=${literal(currentRuntimeV4ExtensionMember.filename)}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v4_source CHECK(source_sha256=${literal(currentRuntimeV4ExtensionMember.sha256)}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v4_parent CHECK(parent_manifest_sha256=${literal(currentRuntimeV4ParentManifestSha256)}),
 CONSTRAINT profile_extension_v4_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v4_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v4_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v4 FROM PUBLIC;`;
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
    name: 'profile_extension_v4_pkey',
    kind: 'p',
    definition: 'PRIMARY KEY (extension_step)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v4_source_ddl_id_key',
    kind: 'u',
    definition: 'UNIQUE (source_ddl_id)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v4_filename_key',
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
 WHERE n.nspname='wm_runtime_installation' AND c.relname='profile_extension_v4'`;
const receiptSql = `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.profile_extension_v4 ORDER BY extension_step`;
async function readReceipt(tx: CurrentRuntimeInstallationTransaction) {
  const catalog = await tx.query(catalogSql, [JSON.stringify(expectedConstraints)]);
  if (catalog.rows.length !== 1 || !catalogSchema.safeParse(catalog.rows[0]).success)
    fail('CURRENT_RUNTIME_V4_LEDGER_INVALID');
  const found = await tx.query(receiptSql);
  if (found.rows.length !== 1) fail('CURRENT_RUNTIME_V4_LEDGER_INVALID');
  const parsed = receiptSchema.safeParse(found.rows[0]);
  if (!parsed.success) fail('CURRENT_RUNTIME_V4_LEDGER_INVALID');
  return parsed.data;
}
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const observed = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v4') IS NOT NULL AS ledger,
 to_regprocedure($1) IS NOT NULL AS helper, to_regprocedure($2) IS NOT NULL AS "manualReader", to_regprocedure($3) IS NOT NULL AS "nutritionReader"`,
    [...signatures],
  );
  const schema = z.strictObject({
    ledger: z.boolean(),
    helper: z.boolean(),
    manualReader: z.boolean(),
    nutritionReader: z.boolean(),
  });
  const parsed = schema.safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V4_LEDGER_INVALID');
  return parsed.data;
}
function result(receipt: z.infer<typeof receiptSchema>) {
  return {
    profileVersion: 4 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 19 as const,
    extensionStep: 1 as const,
    runtimeStep: 20 as const,
    sourceDdlTip: 130 as const,
    parentManifestSha256: currentRuntimeV4ParentManifestSha256,
    extensionReceipt: receipt,
    parentAppliedMembers: parentMembers,
    extensionMember: currentRuntimeV4ExtensionMember,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
/** Owner-only read verifier. V1/V2/V3 remain exact17/18/19 prefix provenance. Reader
 * existence is not a body/ACL/transitive security or runtime grant proof. */
export async function verifyCurrentRuntimeV4InstalledIn(tx: CurrentRuntimeInstallationTransaction) {
  await extensionSource();
  await verifyCurrentRuntimeV3InstalledIn(tx);
  const p = await presence(tx);
  if (!p.ledger)
    fail(
      p.helper || p.manualReader || p.nutritionReader
        ? 'CURRENT_RUNTIME_V4_UNREGISTERED_STAGE'
        : 'CURRENT_RUNTIME_V4_LEDGER_INVALID',
    );
  const receipt = await readReceipt(tx);
  if (!p.helper || !p.manualReader || !p.nutritionReader)
    fail('CURRENT_RUNTIME_V4_READERS_MISSING');
  return result(receipt);
}
/** Same transaction parent+extension installer. Existing v1/v2/v3 use these exact
 * xact locks too; reentrant acquisition stays held until this caller commits. */
export async function installCurrentRuntimeV4In(tx: CurrentRuntimeInstallationTransaction) {
  const sql = await extensionSource();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  await installCurrentRuntimeV3In(tx);
  await verifyCurrentRuntimeV3InstalledIn(tx);
  const p = await presence(tx);
  if (p.ledger) return verifyCurrentRuntimeV4InstalledIn(tx);
  if (p.helper || p.manualReader || p.nutritionReader)
    fail('CURRENT_RUNTIME_V4_UNREGISTERED_STAGE');
  await tx.query(bootstrap);
  await tx.query(sql);
  await tx.query(
    `INSERT INTO wm_runtime_installation.profile_extension_v4(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES(1,130,$1,$2,$3)`,
    [
      currentRuntimeV4ExtensionMember.filename,
      currentRuntimeV4ExtensionMember.sha256,
      currentRuntimeV4ParentManifestSha256,
    ],
  );
  return verifyCurrentRuntimeV4InstalledIn(tx);
}
export async function installCurrentRuntimeV4(connectionString: string) {
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
      const installed = await installCurrentRuntimeV4In(tx);
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
