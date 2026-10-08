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
import {
  currentRuntimeV4ExtensionMember,
  installCurrentRuntimeV4In,
  verifyCurrentRuntimeV4InstalledIn,
} from './current-runtime-installation-v4.js';

// This exact successor preserves all parent20 ledgers/artifacts. Source IDs
// remain distinct from baseline schema_migrations versions and logical steps.
export const currentRuntimeV5ParentManifestSha256 =
  'd314023117fd40ad43387a717c48386cdabff21f472fe37fcccd632473f1f672';
export const currentRuntimeV5ExtensionMember = Object.freeze({
  extensionStep: 1 as const,
  sourceDdlId: 131 as const,
  filename: '131_manual_race_same_tx_parent_ack.sql' as const,
  sha256: '45b65db20f8d2e3c646722bed14962c007c72c7540775828e6d4638299a0fb44',
});
const signature = 'public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)';
export class CurrentRuntimeInstallationV5Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V5_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V5_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V5_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V5_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V5_ACK_MISSING',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV5Error['code']): never {
  throw new CurrentRuntimeInstallationV5Error(code);
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
]);
const parentJson = JSON.stringify({
  encoding: 'current-runtime-profile-v4-parent-manifest-v1',
  profileVersion: 4,
  baselineSchemaVersion: 107,
  runtimeStep: 20,
  members: parentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function extensionSource() {
  if (
    createHash('sha256').update(parentJson).digest('hex') !== currentRuntimeV5ParentManifestSha256
  )
    fail('CURRENT_RUNTIME_V5_PARENT_MISMATCH');
  const sql = await readFile(
    new URL(`../migrations/${currentRuntimeV5ExtensionMember.filename}`, import.meta.url),
    'utf8',
  );
  if (createHash('sha256').update(sql).digest('hex') !== currentRuntimeV5ExtensionMember.sha256)
    fail('CURRENT_RUNTIME_V5_SOURCE_MISMATCH');
  return sql;
}
const receiptSchema = z.strictObject({
  extensionStep: z.literal(1),
  sourceDdlId: z.literal(131),
  filename: z.literal(currentRuntimeV5ExtensionMember.filename),
  sha256: z.literal(currentRuntimeV5ExtensionMember.sha256),
  parentManifestSha256: z.literal(currentRuntimeV5ParentManifestSha256),
});
const checks = [
  ['profile_extension_v5_step', 'extension_step = 1'],
  ['profile_extension_v5_ddl', 'source_ddl_id = 131'],
  [
    'profile_extension_v5_filename',
    `filename = ${literal(currentRuntimeV5ExtensionMember.filename)}::text`,
  ],
  [
    'profile_extension_v5_source',
    `source_sha256 = ${literal(currentRuntimeV5ExtensionMember.sha256)}::text`,
  ],
  [
    'profile_extension_v5_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV5ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v5 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v5_step CHECK(extension_step=1),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v5_ddl CHECK(source_ddl_id=131),
 filename text NOT NULL CONSTRAINT profile_extension_v5_filename CHECK(filename=${literal(currentRuntimeV5ExtensionMember.filename)}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v5_source CHECK(source_sha256=${literal(currentRuntimeV5ExtensionMember.sha256)}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v5_parent CHECK(parent_manifest_sha256=${literal(currentRuntimeV5ParentManifestSha256)}),
 CONSTRAINT profile_extension_v5_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v5_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v5_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v5 FROM PUBLIC;`;
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
    name: 'profile_extension_v5_pkey',
    kind: 'p',
    definition: 'PRIMARY KEY (extension_step)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v5_source_ddl_id_key',
    kind: 'u',
    definition: 'UNIQUE (source_ddl_id)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v5_filename_key',
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
 WHERE n.nspname='wm_runtime_installation' AND c.relname='profile_extension_v5'`;
const receiptSql = `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.profile_extension_v5 ORDER BY extension_step`;
async function readReceipt(tx: CurrentRuntimeInstallationTransaction) {
  const catalog = await tx.query(catalogSql, [JSON.stringify(expectedConstraints)]);
  if (catalog.rows.length !== 1 || !catalogSchema.safeParse(catalog.rows[0]).success)
    fail('CURRENT_RUNTIME_V5_LEDGER_INVALID');
  const found = await tx.query(receiptSql);
  if (found.rows.length !== 1) fail('CURRENT_RUNTIME_V5_LEDGER_INVALID');
  const parsed = receiptSchema.safeParse(found.rows[0]);
  if (!parsed.success) fail('CURRENT_RUNTIME_V5_LEDGER_INVALID');
  return parsed.data;
}
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const observed = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v5') IS NOT NULL AS ledger,to_regprocedure($1) IS NOT NULL AS ack`,
    [signature],
  );
  const parsed = z
    .strictObject({ ledger: z.boolean(), ack: z.boolean() })
    .safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V5_LEDGER_INVALID');
  return parsed.data;
}
function result(receipt: z.infer<typeof receiptSchema>) {
  return {
    profileVersion: 5 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 20 as const,
    extensionStep: 1 as const,
    runtimeStep: 21 as const,
    sourceDdlTip: 131 as const,
    parentManifestSha256: currentRuntimeV5ParentManifestSha256,
    extensionReceipt: receipt,
    parentAppliedMembers: parentMembers,
    extensionMember: currentRuntimeV5ExtensionMember,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
/** Owner-only read verifier. V1/V2/V3/V4 remain exact17/18/19/20 prefix provenance. ACK
 * existence is not a body/ACL/transitive security or runtime grant proof. */
export async function verifyCurrentRuntimeV5InstalledIn(tx: CurrentRuntimeInstallationTransaction) {
  await extensionSource();
  await verifyCurrentRuntimeV4InstalledIn(tx);
  const p = await presence(tx);
  if (!p.ledger)
    fail(p.ack ? 'CURRENT_RUNTIME_V5_UNREGISTERED_STAGE' : 'CURRENT_RUNTIME_V5_LEDGER_INVALID');
  const receipt = await readReceipt(tx);
  if (!p.ack) fail('CURRENT_RUNTIME_V5_ACK_MISSING');
  return result(receipt);
}
/** Same transaction parent+extension installer. Existing v1/v2/v3/v4 use these exact
 * xact locks too; reentrant acquisition stays held until this caller commits. */
export async function installCurrentRuntimeV5In(tx: CurrentRuntimeInstallationTransaction) {
  const sql = await extensionSource();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  await installCurrentRuntimeV4In(tx);
  await verifyCurrentRuntimeV4InstalledIn(tx);
  const p = await presence(tx);
  if (p.ledger) return verifyCurrentRuntimeV5InstalledIn(tx);
  if (p.ack) fail('CURRENT_RUNTIME_V5_UNREGISTERED_STAGE');
  await tx.query(bootstrap);
  await tx.query(sql);
  await tx.query(
    `INSERT INTO wm_runtime_installation.profile_extension_v5(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES(1,131,$1,$2,$3)`,
    [
      currentRuntimeV5ExtensionMember.filename,
      currentRuntimeV5ExtensionMember.sha256,
      currentRuntimeV5ParentManifestSha256,
    ],
  );
  return verifyCurrentRuntimeV5InstalledIn(tx);
}
export async function installCurrentRuntimeV5(connectionString: string) {
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
      const installed = await installCurrentRuntimeV5In(tx);
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
