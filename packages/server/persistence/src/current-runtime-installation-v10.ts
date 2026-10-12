import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import {
  type CurrentRuntimeInstallationTransaction,
  currentRuntimeTargetTransforms,
} from './current-runtime-installation.js';
import { currentRuntimeV7RpcSourcePins } from './current-runtime-grants-v7.js';
import { verifyCurrentRuntimeV7InstalledIn } from './current-runtime-installation-v7.js';
import {
  currentRuntimeV8ParentMembers,
  currentRuntimeV8ParentManifestSha256,
  currentRuntimeV8ExtensionMembers,
} from './current-runtime-installation-v8.js';
import {
  installCurrentRuntimeV9In,
  currentRuntimeV9ParentMembers,
  currentRuntimeV9ParentManifestSha256,
  currentRuntimeV9ExtensionMembers,
  currentRuntimeV9FunctionPins,
} from './current-runtime-installation-v9.js';

// M202-P1-03 successor. Physical10 = parent V9 (physical32: V7 ext23, V8 ext24..31,
// V9 ext32) plus one 146 extension; logical runtime26 and source tip146 are distinct.
// verifyCurrentRuntimeV9InstalledIn rejects the v10 ledger by construction, so the V9
// chain checks are re-implemented here without calling it (profile25 refuses profile26).
export const currentRuntimeV10ParentManifestSha256 =
  '282b5f1312da1f94ea26ffd23d8962f922d014ef4689c8642ea07352ca9a453a';
export const currentRuntimeV10ParentMembers = Object.freeze([
  ...currentRuntimeV9ParentMembers,
  ...currentRuntimeV9ExtensionMembers.map((m) =>
    Object.freeze({
      step: 31 + m.extensionStep,
      sourceDdlId: m.sourceDdlId,
      filename: m.filename,
      sha256: m.sha256,
    }),
  ),
]);
export const currentRuntimeV10ExtensionMembers = Object.freeze([
  Object.freeze({
    extensionStep: 1,
    sourceDdlId: 146,
    filename: '146_race_event_local_date_approval_guard.sql',
    sha256: '9969791a6c4f8fa3792697717acd5700a3e53aac1d2bd234dad1401985837582',
  }),
]);
export const currentRuntimeV10GuardFunctionSignature =
  'public.guard_race_event_local_date_approval_v1()';
export const currentRuntimeV10GuardTriggerName = 'race_local_date_approval_guard';
export const currentRuntimeV10FunctionPins = Object.freeze([
  ...currentRuntimeV9FunctionPins,
  {
    signature: currentRuntimeV10GuardFunctionSignature,
    prosrcSha256: '465fdc342cf6b58264a67f959fc9ba2880248708ffd9ff12fa130ead33dce9e0',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'guard_race_event_local_date_approval_v1',
      prorows: 0,
      pronargs: 0,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2279',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: null,
      proargtypes: [],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'v',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
]);
// Literal copy of V9's unexported four guard pins; V9 stays byte-frozen.
const guardPins = [
  {
    signature: 'public.assert_manual_race_v2_caller()',
    prosrcSha256: '94fe931526ec9a6926bdd7eda5055ab0ebda0560224626af454d4b06837ae348',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'assert_manual_race_v2_caller',
      prorows: 0,
      pronargs: 0,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: null,
      proargtypes: [],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'v',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
  {
    signature: 'public.manual_race_v2_assert_json_bound(jsonb)',
    prosrcSha256: 'eddb8a3273e013884e6400bf00bc8cf7d3a03d49edacad80d7f57b526113f2cb',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'manual_race_v2_assert_json_bound',
      prorows: 0,
      pronargs: 1,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: ['body'],
      proargtypes: ['3802'],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'i',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
  {
    signature: 'public.assert_manual_review_global_lock()',
    prosrcSha256: '6e353607c9be44e4fb4af3e6bdea0c3fa37d7b3a141e88b6f41ddd8eacb68507',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'assert_manual_review_global_lock',
      prorows: 0,
      pronargs: 0,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: null,
      proargtypes: [],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'v',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
  {
    signature: 'public.assert_manual_review_lifecycle_lock(text)',
    prosrcSha256: '61b1e390437aac9946ac4c095aa6ff75bc6fc7b992e09bb600994efe11d7aae7',
    language: 'plpgsql',
    runtimeDirect: false,
    metadata: {
      probin: null,
      procost: 100,
      prokind: 'f',
      proname: 'assert_manual_review_lifecycle_lock',
      prorows: 0,
      pronargs: 1,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      proretset: false,
      prosecdef: false,
      prorettype: '2278',
      prosqlbody: null,
      prosupport: '-',
      proargmodes: null,
      proargnames: ['tenant'],
      proargtypes: ['25'],
      proisstrict: false,
      proparallel: 'u',
      protrftypes: null,
      provariadic: '0',
      provolatile: 'v',
      proleakproof: false,
      proallargtypes: null,
      proargdefaults: null,
      pronargdefaults: 0,
    },
  },
];
function freezeCompilerValue(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeCompilerValue(child);
    Object.freeze(value);
  }
}
freezeCompilerValue(currentRuntimeV10FunctionPins);
freezeCompilerValue(guardPins);
export class CurrentRuntimeInstallationV10Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V10_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V10_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V10_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V10_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V10_FUNCTION_DRIFT'
      | 'CURRENT_RUNTIME_V10_METADATA_CHANGED',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV10Error['code']): never {
  throw new CurrentRuntimeInstallationV10Error(code);
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}
const parentEncoding = JSON.stringify({
  encoding: 'current-runtime-profile-v9-parent-manifest-v1',
  profileVersion: 9,
  baselineSchemaVersion: 107,
  runtimeStep: 25,
  members: currentRuntimeV10ParentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function sources() {
  if (hash(parentEncoding) !== currentRuntimeV10ParentManifestSha256)
    fail('CURRENT_RUNTIME_V10_PARENT_MISMATCH');
  for (const member of currentRuntimeV10ParentMembers) {
    const body = await readFile(
      new URL(`../migrations/${member.filename}`, import.meta.url),
      'utf8',
    );
    if (hash(body) !== member.sha256) fail('CURRENT_RUNTIME_V10_PARENT_MISMATCH');
  }
  const result: string[] = [];
  for (const member of currentRuntimeV10ExtensionMembers) {
    const text = await readFile(
      new URL(`../migrations/${member.filename}`, import.meta.url),
      'utf8',
    );
    if (hash(text) !== member.sha256) fail('CURRENT_RUNTIME_V10_SOURCE_MISMATCH');
    result.push(text);
  }
  return result;
}
const receiptSchema = z.strictObject({
  extensionStep: z.number().int().min(1).max(1),
  sourceDdlId: z.number().int().min(146).max(146),
  filename: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parentManifestSha256: z.literal(currentRuntimeV10ParentManifestSha256),
});
const receiptRosterSchema = z.array(receiptSchema).length(1);
function jsonMap(
  members: readonly { extensionStep: number; filename: string; sha256: string }[],
  field: 'filename' | 'sha256',
) {
  // Canonical PostgreSQL jsonb text for a fixed small key/string map.
  return (
    '{' +
    members
      .map((m) => JSON.stringify(String(m.extensionStep)) + ': ' + JSON.stringify(m[field]))
      .join(', ') +
    '}'
  );
}
type Check = readonly [name: string, expression: string];
function constraintsOf(table: string, checks: readonly Check[]) {
  return [
    ...checks.map(([name, expression]) => ({
      name,
      kind: 'c',
      definition: `CHECK ((${expression}))`,
      validated: true,
      deferrable: false,
      deferred: false,
    })),
    {
      name: `${table}_pkey`,
      kind: 'p',
      definition: 'PRIMARY KEY (extension_step)',
      validated: true,
      deferrable: false,
      deferred: false,
    },
    {
      name: `${table}_source_ddl_id_key`,
      kind: 'u',
      definition: 'UNIQUE (source_ddl_id)',
      validated: true,
      deferrable: false,
      deferred: false,
    },
    {
      name: `${table}_filename_key`,
      kind: 'u',
      definition: 'UNIQUE (filename)',
      validated: true,
      deferrable: false,
      deferred: false,
    },
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
const checks = [
  ['profile_extension_v10_step', 'extension_step = 1'],
  ['profile_extension_v10_ddl', 'source_ddl_id = 146'],
  [
    'profile_extension_v10_filename',
    `filename = (${literal(jsonMap(currentRuntimeV10ExtensionMembers, 'filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v10_source',
    `source_sha256 = (${literal(jsonMap(currentRuntimeV10ExtensionMembers, 'sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v10_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV10ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v10 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v10_step CHECK(${checks[0][1]}),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v10_ddl CHECK(${checks[1][1]}),
 filename text NOT NULL CONSTRAINT profile_extension_v10_filename CHECK(${checks[2][1]}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v10_source CHECK(${checks[3][1]}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v10_parent CHECK(${checks[4][1]}),
 CONSTRAINT profile_extension_v10_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v10_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v10_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v10 FROM PUBLIC;`;
const expectedConstraints = constraintsOf('profile_extension_v10', checks);
// Copy of V9's parent V8 receipt check (v9.ts parentChecks/parentReceipts).
const v8Checks = [
  ['profile_extension_v8_step', 'extension_step = ANY (ARRAY[1, 2, 3, 4, 5, 6, 7, 8])'],
  ['profile_extension_v8_ddl', 'source_ddl_id = (133 + extension_step)'],
  [
    'profile_extension_v8_filename',
    `filename = (${literal(jsonMap(currentRuntimeV8ExtensionMembers, 'filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_source',
    `source_sha256 = (${literal(jsonMap(currentRuntimeV8ExtensionMembers, 'sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV8ParentManifestSha256)}::text`,
  ],
] as const;
const v8Constraints = constraintsOf('profile_extension_v8', v8Checks);
// Copy of V9's own receipt check (v9.ts checks/receipts) against profile_extension_v9.
const v9Checks = [
  ['profile_extension_v9_step', 'extension_step = 1'],
  ['profile_extension_v9_ddl', 'source_ddl_id = 142'],
  [
    'profile_extension_v9_filename',
    `filename = (${literal(jsonMap(currentRuntimeV9ExtensionMembers, 'filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v9_source',
    `source_sha256 = (${literal(jsonMap(currentRuntimeV9ExtensionMembers, 'sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v9_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV9ParentManifestSha256)}::text`,
  ],
] as const;
const v9Constraints = constraintsOf('profile_extension_v9', v9Checks);
const catalogSchema = z.strictObject({
  owner: z.literal(true),
  private: z.literal(true),
  columns: z.literal(true),
  constraints: z.literal(true),
  shape: z.literal(true),
});
// Finite module-owned ledger names only; never derived from caller JSON/catalog.
type LedgerName = 'profile_extension_v8' | 'profile_extension_v9' | 'profile_extension_v10';
function catalogSql(table: LedgerName) {
  return `SELECT current_user=session_user AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND n.nspowner=c.relowner AS owner,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)
 AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND x.grantee<>c.relowner) AS private,
 (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0)
 ='[["extension_step","integer",true],["source_ddl_id","integer",true],["filename","text",true],["source_sha256","text",true],["parent_manifest_sha256","text",true]]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND (a.attisdropped OR a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'')) AS columns,
 (SELECT jsonb_agg(jsonb_build_object('name',k.conname,'kind',k.contype,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid)=$1::jsonb AS constraints,
 c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition
 AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready OR NOT i.indisunique OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u')))) AS shape
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relname='${table}'`;
}
async function ledgerReceipts<T>(
  tx: CurrentRuntimeInstallationTransaction,
  table: LedgerName,
  constraints: readonly unknown[],
  roster: z.ZodType<T>,
  expected: readonly unknown[],
): Promise<T> {
  const c = await tx.query(catalogSql(table), [JSON.stringify(constraints)]);
  if (c.rows.length !== 1 || !catalogSchema.safeParse(c.rows[0]).success)
    fail('CURRENT_RUNTIME_V10_LEDGER_INVALID');
  const rows = await tx.query(
    `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.${table} ORDER BY extension_step`,
  );
  const parsed = roster.safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V10_LEDGER_INVALID');
  if (JSON.stringify(parsed.data) !== JSON.stringify(expected))
    fail('CURRENT_RUNTIME_V10_LEDGER_INVALID');
  return parsed.data;
}
async function receipts(tx: CurrentRuntimeInstallationTransaction) {
  return ledgerReceipts(
    tx,
    'profile_extension_v10',
    expectedConstraints,
    receiptRosterSchema,
    currentRuntimeV10ExtensionMembers.map((m) => ({
      ...m,
      parentManifestSha256: currentRuntimeV10ParentManifestSha256,
    })),
  );
}
const v8ReceiptRosterSchema = z
  .array(
    z.strictObject({
      extensionStep: z.number().int().min(1).max(8),
      sourceDdlId: z.number().int().min(134).max(141),
      filename: z.string().min(1).max(200),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      parentManifestSha256: z.literal(currentRuntimeV8ParentManifestSha256),
    }),
  )
  .length(8);
const v9ReceiptRosterSchema = z
  .array(
    z.strictObject({
      extensionStep: z.number().int().min(1).max(1),
      sourceDdlId: z.number().int().min(142).max(142),
      filename: z.string().min(1).max(200),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      parentManifestSha256: z.literal(currentRuntimeV9ParentManifestSha256),
    }),
  )
  .length(1);
const stateSchema = z.strictObject({
  ledger: z.boolean(),
  staged: z.boolean(),
  knownLedgers: z.literal(true),
});
export const currentRuntimeV10KnownLedgers = Object.freeze([
  'migration',
  'profile_extension_v2',
  'profile_extension_v3',
  'profile_extension_v4',
  'profile_extension_v5',
  'profile_extension_v6',
  'profile_extension_v7',
  'profile_extension_v8',
  'profile_extension_v9',
  'profile_extension_v10',
] as const);
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const rows = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v10') IS NOT NULL AS ledger,
 (to_regprocedure($1) IS NOT NULL OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgname=$2 AND t.tgrelid=to_regclass('public.race_event'))) AS staged,
 NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relkind IN ('r','p','v','m','f','S') AND c.relname<>ALL($3::text[])) AS "knownLedgers"`,
    [
      currentRuntimeV10GuardFunctionSignature,
      currentRuntimeV10GuardTriggerName,
      [...currentRuntimeV10KnownLedgers],
    ],
  );
  const parsed = stateSchema.safeParse(rows.rows[0]);
  if (rows.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V10_LEDGER_INVALID');
  return parsed.data;
}
const functionRow = z.strictObject({
  signature: z.string().max(250),
  owner: z.literal(true),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadataMatches: z.literal(true),
  safeAcl: z.literal(true),
  namespace: z.literal(true),
});
const triggerRow = z.strictObject({
  count: z.literal(1),
  functionUses: z.literal(1),
  exact: z.literal(true),
});
async function verifyFunctions(tx: CurrentRuntimeInstallationTransaction) {
  const pins = [...currentRuntimeV10FunctionPins, ...guardPins];
  const rows = await tx.query(
    `SELECT pin.value->>'signature' AS signature,
 current_user=session_user AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owner,
 CASE WHEN octet_length(p.prosrc)<=2097152 THEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') ELSE NULL END AS "bodySha256",
 (to_jsonb(p)-ARRAY['oid','proowner','prolang','pronamespace','proacl','prosrc'])=pin.value->'metadata'
 AND l.lanname=pin.value->>'language' AS "metadataMatches",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR pin.value->>'runtimeDirect'<>'true')) AS "safeAcl",
 n.nspname=split_part(pin.value->>'signature','.',1) AND (n.nspname='public' OR n.nspowner=p.proowner) AS namespace
 FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY pin(value,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(pin.value->>'signature') JOIN pg_language l ON l.oid=p.prolang JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY pin.ordinal`,
    [JSON.stringify(pins)],
  );
  const parsed = z.array(functionRow).length(31).safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V10_FUNCTION_DRIFT');
  for (const [i, row] of parsed.data.entries()) {
    const pin = pins[i];
    if (!pin || row.signature !== pin.signature || row.bodySha256 !== pin.prosrcSha256)
      fail('CURRENT_RUNTIME_V10_FUNCTION_DRIFT');
  }
  const shape = await tx.query(`SELECT count(*)::int AS count,
 coalesce(bool_and(n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)),false) AS private FROM pg_namespace n JOIN pg_proc p ON p.pronamespace=n.oid WHERE n.nspname='wm_manual_pooled'`);
  if (
    shape.rows.length !== 1 ||
    shape.rows[0]?.['count'] !== 13 ||
    shape.rows[0]?.['private'] !== true
  )
    fail('CURRENT_RUNTIME_V10_FUNCTION_DRIFT');
  // Exactly one enabled ROW BEFORE UPDATE OF values_json trigger on public.race_event
  // executes the pinned guard. Disabled, dropped, re-targeted or conditional drifts.
  // tgtype 19 = ROW(1)|BEFORE(2)|UPDATE(16).
  const trigger = await tx.query(
    `SELECT (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.race_event') AND t.tgname=$2) AS count,
 (SELECT count(*)::int FROM pg_trigger t WHERE t.tgfoid=to_regprocedure($1)) AS "functionUses",
 coalesce((SELECT t.tgfoid=to_regprocedure($1) AND t.tgtype=19 AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
   AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgparentid=0
   AND t.tgattr::text=(SELECT a.attnum::text FROM pg_attribute a WHERE a.attrelid=t.tgrelid AND a.attname='values_json' AND NOT a.attisdropped)
   FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.race_event') AND t.tgname=$2),false) AS exact`,
    [currentRuntimeV10GuardFunctionSignature, currentRuntimeV10GuardTriggerName],
  );
  if (trigger.rows.length !== 1 || !triggerRow.safeParse(trigger.rows[0]).success)
    fail('CURRENT_RUNTIME_V10_FUNCTION_DRIFT');
}
// Re-implements V9's chain checks (verifyV7 + V8 receipts + V9 receipts) without
// calling verifyCurrentRuntimeV9InstalledIn, which refuses the v10 ledger.
async function parent(tx: CurrentRuntimeInstallationTransaction) {
  const found = await verifyCurrentRuntimeV7InstalledIn(tx);
  const actual = [
    ...found.parentAppliedMembers,
    {
      step: 23,
      sourceDdlId: found.extensionReceipt.sourceDdlId,
      filename: found.extensionReceipt.filename,
      sha256: found.extensionReceipt.sha256,
    },
  ];
  if (JSON.stringify(actual) !== JSON.stringify(currentRuntimeV8ParentMembers))
    fail('CURRENT_RUNTIME_V10_PARENT_MISMATCH');
  const v8 = await ledgerReceipts(
    tx,
    'profile_extension_v8',
    v8Constraints,
    v8ReceiptRosterSchema,
    currentRuntimeV8ExtensionMembers.map((m) => ({
      ...m,
      parentManifestSha256: currentRuntimeV8ParentManifestSha256,
    })),
  );
  const v9 = await ledgerReceipts(
    tx,
    'profile_extension_v9',
    v9Constraints,
    v9ReceiptRosterSchema,
    currentRuntimeV9ExtensionMembers.map((m) => ({
      ...m,
      parentManifestSha256: currentRuntimeV9ParentManifestSha256,
    })),
  );
  const chain = [
    ...v8.map((m) => ({ step: 23 + m.extensionStep, ...m })),
    ...v9.map((m) => ({ step: 31 + m.extensionStep, ...m })),
  ].map((m) => ({
    step: m.step,
    sourceDdlId: m.sourceDdlId,
    filename: m.filename,
    sha256: m.sha256,
  }));
  if (JSON.stringify(chain) !== JSON.stringify(currentRuntimeV10ParentMembers.slice(23)))
    fail('CURRENT_RUNTIME_V10_PARENT_MISMATCH');
}
// Parent V7 RPC + V8 + V9 function fingerprints (59), ledgers migration and v2..v9
// rows+xmin, and schema_migrations are compared across installation.
const prefixSignatures = Object.freeze(
  [...currentRuntimeV7RpcSourcePins, ...currentRuntimeV9FunctionPins].map((p) => p.signature),
);
const prefixFunctionsSchema = z
  .array(
    z.strictObject({
      signature: z.string().max(250),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .length(59);
const fingerprintSchema = z.strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
async function prefix(tx: CurrentRuntimeInstallationTransaction) {
  const functions = await tx.query(
    `SELECT requested.signature,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint FROM unnest($1::text[]) WITH ORDINALITY requested(signature,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(requested.signature) ORDER BY requested.ordinal`,
    [[...prefixSignatures]],
  );
  const parsed = prefixFunctionsSchema.safeParse(functions.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V10_METADATA_CHANGED');
  for (const [i, row] of parsed.data.entries())
    if (row.signature !== prefixSignatures[i]) fail('CURRENT_RUNTIME_V10_METADATA_CHANGED');
  const ledger = [];
  for (const name of currentRuntimeV10KnownLedgers.slice(0, 9)) {
    // Finite module-owned identifier only; never derived from caller JSON/catalog.
    const found = await tx.query(
      `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM wm_runtime_installation.${name} t`,
    );
    const stamp = fingerprintSchema.safeParse(found.rows[0]);
    if (found.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V10_METADATA_CHANGED');
    ledger.push({ name, ...stamp.data });
  }
  const baseline = await tx.query(
    `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY version),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM public.schema_migrations t`,
  );
  const stamp = fingerprintSchema.safeParse(baseline.rows[0]);
  if (baseline.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V10_METADATA_CHANGED');
  return { functions: parsed.data, ledger, baseline: stamp.data };
}
function result(extensionReceipts: z.infer<typeof receiptRosterSchema>) {
  return {
    profileVersion: 10 as const,
    parentProfileVersion: 9 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 25 as const,
    extensionSteps: 1 as const,
    runtimeStep: 26 as const,
    sourceDdlTip: 146 as const,
    parentManifestSha256: currentRuntimeV10ParentManifestSha256,
    parentAppliedMembers: currentRuntimeV10ParentMembers,
    extensionMembers: currentRuntimeV10ExtensionMembers,
    extensionReceipts,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
export type CurrentRuntimeV10Installation = ReturnType<typeof result>;
/** Read-only owner verification of the exact physical10/runtime26 receipts, the
 * 31 function pins and the race_event local-date trigger pin. */
export async function verifyCurrentRuntimeV10InstalledIn(
  tx: CurrentRuntimeInstallationTransaction,
): Promise<CurrentRuntimeV10Installation> {
  await sources();
  await parent(tx);
  const p = await presence(tx);
  if (!p.ledger || !p.staged) fail('CURRENT_RUNTIME_V10_LEDGER_INVALID');
  const r = await receipts(tx);
  await verifyFunctions(tx);
  return result(r);
}
/** Same-transaction install: fresh normal107 installs the whole V9 chain first; a
 * committed profile25 only receives 146 and its receipt. Caller owns BEGIN/COMMIT. */
export async function installCurrentRuntimeV10In(
  tx: CurrentRuntimeInstallationTransaction,
): Promise<CurrentRuntimeV10Installation> {
  const texts = await sources();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const p = await presence(tx);
  if (p.ledger) return verifyCurrentRuntimeV10InstalledIn(tx);
  if (p.staged) fail('CURRENT_RUNTIME_V10_UNREGISTERED_STAGE');
  await installCurrentRuntimeV9In(tx);
  await parent(tx);
  const before = await prefix(tx);
  await tx.query(bootstrap);
  for (const [i, text] of texts.entries()) {
    const member = currentRuntimeV10ExtensionMembers[i];
    if (!member) fail('CURRENT_RUNTIME_V10_SOURCE_MISMATCH');
    await tx.query(text);
    await tx.query(
      'INSERT INTO wm_runtime_installation.profile_extension_v10(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES($1,$2,$3,$4,$5)',
      [
        member.extensionStep,
        member.sourceDdlId,
        member.filename,
        member.sha256,
        currentRuntimeV10ParentManifestSha256,
      ],
    );
  }
  if (JSON.stringify(await prefix(tx)) !== JSON.stringify(before))
    fail('CURRENT_RUNTIME_V10_METADATA_CHANGED');
  return verifyCurrentRuntimeV10InstalledIn(tx);
}
export async function installCurrentRuntimeV10(connectionString: string) {
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
      const r = await installCurrentRuntimeV10In(tx);
      await tx.query('COMMIT');
      return r;
    } catch (e) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      tx.release(discard);
    }
  } finally {
    await pool.end();
  }
}
