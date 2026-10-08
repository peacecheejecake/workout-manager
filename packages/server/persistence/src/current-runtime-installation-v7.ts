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
import { currentRuntimeV5ExtensionMember } from './current-runtime-installation-v5.js';
import {
  currentRuntimeV6ExtensionMember,
  installCurrentRuntimeV6In,
  verifyCurrentRuntimeV6InstalledIn,
} from './current-runtime-installation-v6.js';

// This exact successor preserves all parent22 ledgers/artifacts. Source IDs
// remain distinct from baseline schema_migrations versions and logical steps.
export const currentRuntimeV7ParentManifestSha256 =
  'bd924e83583070628ebf19f054cd8e4dd107a77990e200f813434568869d2cdb';
export const currentRuntimeV7ExtensionMember = Object.freeze({
  extensionStep: 1 as const,
  sourceDdlId: 133 as const,
  filename: '133_nutrition_v4_indexed_application.sql' as const,
  sha256: '44b4705652ed5dd27ad2e414b95a63c1f2ba252569f837ea3951fcaed34a529b',
});

export class CurrentRuntimeInstallationV7Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V7_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V7_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V7_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V7_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V7_FUNCTION_DRIFT'
      | 'CURRENT_RUNTIME_V7_METADATA_CHANGED',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV7Error['code']): never {
  throw new CurrentRuntimeInstallationV7Error(code);
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
  Object.freeze({
    step: 22 as const,
    sourceDdlId: currentRuntimeV6ExtensionMember.sourceDdlId,
    filename: currentRuntimeV6ExtensionMember.filename,
    sha256: currentRuntimeV6ExtensionMember.sha256,
  }),
]);
const parentJson = JSON.stringify({
  encoding: 'current-runtime-profile-v6-parent-manifest-v1',
  profileVersion: 6,
  baselineSchemaVersion: 107,
  runtimeStep: 22,
  members: parentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function extensionSource() {
  if (
    createHash('sha256').update(parentJson).digest('hex') !== currentRuntimeV7ParentManifestSha256
  )
    fail('CURRENT_RUNTIME_V7_PARENT_MISMATCH');
  const sql = await readFile(
    new URL(`../migrations/${currentRuntimeV7ExtensionMember.filename}`, import.meta.url),
    'utf8',
  );
  if (createHash('sha256').update(sql).digest('hex') !== currentRuntimeV7ExtensionMember.sha256)
    fail('CURRENT_RUNTIME_V7_SOURCE_MISMATCH');
  return sql;
}
const receiptSchema = z.strictObject({
  extensionStep: z.literal(1),
  sourceDdlId: z.literal(133),
  filename: z.literal(currentRuntimeV7ExtensionMember.filename),
  sha256: z.literal(currentRuntimeV7ExtensionMember.sha256),
  parentManifestSha256: z.literal(currentRuntimeV7ParentManifestSha256),
});
const checks = [
  ['profile_extension_v7_step', 'extension_step = 1'],
  ['profile_extension_v7_ddl', 'source_ddl_id = 133'],
  [
    'profile_extension_v7_filename',
    `filename = ${literal(currentRuntimeV7ExtensionMember.filename)}::text`,
  ],
  [
    'profile_extension_v7_source',
    `source_sha256 = ${literal(currentRuntimeV7ExtensionMember.sha256)}::text`,
  ],
  [
    'profile_extension_v7_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV7ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v7 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v7_step CHECK(extension_step=1),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v7_ddl CHECK(source_ddl_id=133),
 filename text NOT NULL CONSTRAINT profile_extension_v7_filename CHECK(filename=${literal(currentRuntimeV7ExtensionMember.filename)}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v7_source CHECK(source_sha256=${literal(currentRuntimeV7ExtensionMember.sha256)}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v7_parent CHECK(parent_manifest_sha256=${literal(currentRuntimeV7ParentManifestSha256)}),
 CONSTRAINT profile_extension_v7_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v7_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v7_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v7 FROM PUBLIC;`;
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
    name: 'profile_extension_v7_pkey',
    kind: 'p',
    definition: 'PRIMARY KEY (extension_step)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v7_source_ddl_id_key',
    kind: 'u',
    definition: 'UNIQUE (source_ddl_id)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v7_filename_key',
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
 WHERE n.nspname='wm_runtime_installation' AND c.relname='profile_extension_v7'`;
const receiptSql = `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.profile_extension_v7 ORDER BY extension_step`;
async function readReceipt(tx: CurrentRuntimeInstallationTransaction) {
  const catalog = await tx.query(catalogSql, [JSON.stringify(expectedConstraints)]);
  if (catalog.rows.length !== 1 || !catalogSchema.safeParse(catalog.rows[0]).success)
    fail('CURRENT_RUNTIME_V7_LEDGER_INVALID');
  const found = await tx.query(receiptSql);
  if (found.rows.length !== 1) fail('CURRENT_RUNTIME_V7_LEDGER_INVALID');
  const parsed = receiptSchema.safeParse(found.rows[0]);
  if (!parsed.success) fail('CURRENT_RUNTIME_V7_LEDGER_INVALID');
  return parsed.data;
}
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const observed = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v7') IS NOT NULL AS ledger`,
  );
  const parsed = z.strictObject({ ledger: z.boolean() }).safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V7_LEDGER_INVALID');
  return parsed.data;
}
export const currentRuntimeV7FunctionTransitions = Object.freeze([
  Object.freeze({
    signature: 'public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)',
    predecessorSha256: 'bb5eca0bd23f90cdf1ea082e229e95188b808ce1ff01a9c34c63cfaa72f257bd',
    successorSha256: '16b2dc4c79dec56d417f504d4c005034b2769fefc4249dc8244698c6593a75a6',
    definer: true,
    resultType: 'jsonb',
    configuration: Object.freeze([
      'search_path=pg_catalog, pg_temp',
      'TimeZone=UTC',
      'DateStyle=ISO,YMD',
    ]),
  }),
  Object.freeze({
    signature: 'public.assert_nutrition_disconnect_body(jsonb)',
    predecessorSha256: 'ff1c1996a25f93a8ad096f2622b2f3a2897f7283d6d0a4a9698fe60cae37475b',
    successorSha256: '92a0643c5eff075ec00bacd21152666755dc439c1c01571640e8827a618edc6f',
    definer: false,
    resultType: 'void',
    configuration: Object.freeze(['search_path=pg_catalog, pg_temp']),
  }),
]);
const functionSchema = z.strictObject({
  signature: z.string().max(200),
  owner: z.literal(true),
  language: z.literal('plpgsql'),
  resultType: z.enum(['jsonb', 'void']),
  definer: z.boolean(),
  volatility: z.literal('v'),
  parallel: z.literal('u'),
  strict: z.literal(false),
  setReturning: z.literal(false),
  configuration: z.array(z.string().max(200)).max(3),
  privatePublic: z.literal(true),
  safeDelegation: z.literal(true),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
async function observeFunctions(tx: CurrentRuntimeInstallationTransaction) {
  const observed = await tx.query(
    `SELECT requested.signature,
 p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND current_user=session_user
 AND p.proowner=(SELECT relowner FROM pg_class WHERE oid='public.nutrition_plan_version'::regclass) AS owner,
 l.lanname AS language,pg_get_function_result(p.oid) AS "resultType",p.prosecdef AS definer,p.provolatile AS volatility,p.proparallel AS parallel,p.proisstrict AS strict,p.proretset AS "setReturning",p.proconfig AS configuration,
 encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS "bodySha256",
 encode(sha256(convert_to((to_jsonb(p)-'prosrc')::text,'UTF8')),'hex') AS "metadataSha256",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0) AS "privatePublic",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable)) AS "safeDelegation"
 FROM unnest($1::text[]) WITH ORDINALITY requested(signature,ordinal)
 JOIN pg_proc p ON p.oid=to_regprocedure(requested.signature) JOIN pg_language l ON l.oid=p.prolang ORDER BY requested.ordinal`,
    [currentRuntimeV7FunctionTransitions.map((f) => f.signature)],
  );
  const parsed = z.array(functionSchema).length(2).safeParse(observed.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V7_FUNCTION_DRIFT');
  for (const [i, row] of parsed.data.entries()) {
    const expected = currentRuntimeV7FunctionTransitions[i];
    if (
      !expected ||
      row.signature !== expected.signature ||
      row.definer !== expected.definer ||
      row.resultType !== expected.resultType ||
      JSON.stringify(row.configuration) !== JSON.stringify(expected.configuration)
    )
      fail('CURRENT_RUNTIME_V7_FUNCTION_DRIFT');
  }
  return parsed.data;
}
function verifyBodies(
  rows: Awaited<ReturnType<typeof observeFunctions>>,
  stage: 'predecessor' | 'successor',
) {
  for (const [i, row] of rows.entries()) {
    const expected = currentRuntimeV7FunctionTransitions[i];
    if (
      !expected ||
      row.bodySha256 !== expected[stage === 'predecessor' ? 'predecessorSha256' : 'successorSha256']
    )
      fail('CURRENT_RUNTIME_V7_FUNCTION_DRIFT');
  }
}

function result(receipt: z.infer<typeof receiptSchema>) {
  return {
    profileVersion: 7 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 22 as const,
    extensionStep: 1 as const,
    runtimeStep: 23 as const,
    sourceDdlTip: 133 as const,
    parentManifestSha256: currentRuntimeV7ParentManifestSha256,
    extensionReceipt: receipt,
    parentAppliedMembers: parentMembers,
    extensionMember: currentRuntimeV7ExtensionMember,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
/** Owner-only provenance verifier: the historical22 prefix remains unchanged.
 * Exact final function bodies/metadata are observed, not whole security/support. */
export async function verifyCurrentRuntimeV7InstalledIn(tx: CurrentRuntimeInstallationTransaction) {
  await extensionSource();
  await verifyCurrentRuntimeV6InstalledIn(tx);
  const p = await presence(tx);
  if (!p.ledger) fail('CURRENT_RUNTIME_V7_LEDGER_INVALID');
  const receipt = await readReceipt(tx);
  verifyBodies(await observeFunctions(tx), 'successor');
  return result(receipt);
}
/** Same-transaction parent22 + exact133 upgrade. Actual SQL133 also checks the
 * predecessor/patch counts/trigger hooks and preserves every pg_proc field. */
export async function installCurrentRuntimeV7In(tx: CurrentRuntimeInstallationTransaction) {
  const sql = await extensionSource();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  await installCurrentRuntimeV6In(tx);
  await verifyCurrentRuntimeV6InstalledIn(tx);
  const p = await presence(tx);
  if (p.ledger) return verifyCurrentRuntimeV7InstalledIn(tx);
  const before = await observeFunctions(tx);
  if (
    before.some(
      (row, index) =>
        row.bodySha256 === currentRuntimeV7FunctionTransitions[index]?.successorSha256,
    )
  )
    fail('CURRENT_RUNTIME_V7_UNREGISTERED_STAGE');
  verifyBodies(before, 'predecessor');
  await tx.query(bootstrap);
  await tx.query(sql);
  const after = await observeFunctions(tx);
  verifyBodies(after, 'successor');
  if (after.some((row, index) => row.metadataSha256 !== before[index]?.metadataSha256))
    fail('CURRENT_RUNTIME_V7_METADATA_CHANGED');
  await tx.query(
    `INSERT INTO wm_runtime_installation.profile_extension_v7(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES(1,133,$1,$2,$3)`,
    [
      currentRuntimeV7ExtensionMember.filename,
      currentRuntimeV7ExtensionMember.sha256,
      currentRuntimeV7ParentManifestSha256,
    ],
  );
  return verifyCurrentRuntimeV7InstalledIn(tx);
}
export async function installCurrentRuntimeV7(connectionString: string) {
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
      const installed = await installCurrentRuntimeV7In(tx);
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
