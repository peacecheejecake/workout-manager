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
  installCurrentRuntimeV8In,
  currentRuntimeV8ParentMembers,
  currentRuntimeV8ParentManifestSha256,
  currentRuntimeV8ExtensionMembers,
  currentRuntimeV8FunctionPins,
} from './current-runtime-installation-v8.js';
// Actual Root post142 metadata, SHA5ad2d0745f5e8504891550e4e43d1e7004869fc37309ef3f74ed267469162158.
// Physical9 successors, logical runtime25 and source142 are distinct.
export const currentRuntimeV9ParentManifestSha256 =
  '02255356ed6a14191c117d785aee7a086670d6830b8a7740bd525a588b071042';
export const currentRuntimeV9ParentMembers = Object.freeze([
  ...currentRuntimeV8ParentMembers,
  ...currentRuntimeV8ExtensionMembers.map((m) =>
    Object.freeze({
      step: 23 + m.extensionStep,
      sourceDdlId: m.sourceDdlId,
      filename: m.filename,
      sha256: m.sha256,
    }),
  ),
]);
export const currentRuntimeV9ExtensionMembers = Object.freeze([
  Object.freeze({
    extensionStep: 1,
    sourceDdlId: 142,
    filename: '142_manual_pooled_parent_delta.sql',
    sha256: '7653de06a0b5017195729a20d2a21ea706c45c1e0db6b21f4b9c3a7094851cca',
  }),
]);
export const currentRuntimeV9FunctionPins = Object.freeze([
  ...currentRuntimeV8FunctionPins,
  ...[
    {
      signature: 'public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)',
      prosrcSha256: 'e8e2bec33d0b7b828804d6162ef897de93f087c24afd72215836719da3f927cb',
      language: 'plpgsql',
      runtimeDirect: true,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'read_manual_race_pooled_parent_delta_v1',
        prorows: 0,
        pronargs: 2,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: true,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['evidence_id', 'fresh_encoded'],
        proargtypes: ['2950', '3802'],
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
      signature: 'wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)',
      prosrcSha256: '0b35560836ce1d5d11f836eac108bb8563cf6832aa664946f53629fe01391d05',
      language: 'plpgsql',
      runtimeDirect: false,
      metadata: {
        probin: null,
        procost: 100,
        prokind: 'f',
        proname: 'parent_delta_node_v1',
        prorows: 0,
        pronargs: 4,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        proretset: false,
        prosecdef: false,
        prorettype: '3802',
        prosqlbody: null,
        prosupport: '-',
        proargmodes: null,
        proargnames: ['base', 'parent', 'depth', 'node_budget'],
        proargtypes: ['3802', '3802', '23', '23'],
        proisstrict: false,
        proparallel: 'u',
        protrftypes: null,
        provariadic: '0',
        provolatile: 's',
        proleakproof: false,
        proallargtypes: null,
        proargdefaults: null,
        pronargdefaults: 0,
      },
    },
  ],
]);
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
freezeCompilerValue(currentRuntimeV9FunctionPins);
export class CurrentRuntimeInstallationV9Error extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V9_SOURCE_MISMATCH'
      | 'CURRENT_RUNTIME_V9_PARENT_MISMATCH'
      | 'CURRENT_RUNTIME_V9_LEDGER_INVALID'
      | 'CURRENT_RUNTIME_V9_UNREGISTERED_STAGE'
      | 'CURRENT_RUNTIME_V9_FUNCTION_DRIFT'
      | 'CURRENT_RUNTIME_V9_METADATA_CHANGED',
  ) {
    super(code);
  }
}
function fail(code: CurrentRuntimeInstallationV9Error['code']): never {
  throw new CurrentRuntimeInstallationV9Error(code);
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'";
}
freezeCompilerValue(guardPins);
const parentEncoding = JSON.stringify({
  encoding: 'current-runtime-profile-v8-parent-manifest-v1',
  profileVersion: 8,
  baselineSchemaVersion: 107,
  runtimeStep: 24,
  members: currentRuntimeV9ParentMembers.map((m) => [m.step, m.sourceDdlId, m.filename, m.sha256]),
});
async function sources() {
  if (hash(parentEncoding) !== currentRuntimeV9ParentManifestSha256)
    fail('CURRENT_RUNTIME_V9_PARENT_MISMATCH');
  for (const member of currentRuntimeV9ParentMembers) {
    const body = await readFile(
      new URL(`../migrations/${member.filename}`, import.meta.url),
      'utf8',
    );
    if (hash(body) !== member.sha256) fail('CURRENT_RUNTIME_V9_PARENT_MISMATCH');
  }
  const result: string[] = [];
  for (const member of currentRuntimeV9ExtensionMembers) {
    const text = await readFile(
      new URL(`../migrations/${member.filename}`, import.meta.url),
      'utf8',
    );
    if (hash(text) !== member.sha256) fail('CURRENT_RUNTIME_V9_SOURCE_MISMATCH');
    result.push(text);
  }
  return result;
}
const receiptSchema = z.strictObject({
  extensionStep: z.number().int().min(1).max(1),
  sourceDdlId: z.number().int().min(142).max(142),
  filename: z.string().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parentManifestSha256: z.literal(currentRuntimeV9ParentManifestSha256),
});
const receiptRosterSchema = z.array(receiptSchema).length(1);
function jsonMap(field: 'filename' | 'sha256') {
  // Canonical PostgreSQL jsonb text for this fixed eight-key/string map.
  return (
    '{' +
    currentRuntimeV9ExtensionMembers
      .map((m) => JSON.stringify(String(m.extensionStep)) + ': ' + JSON.stringify(m[field]))
      .join(', ') +
    '}'
  );
}
const checks = [
  ['profile_extension_v9_step', 'extension_step = 1'],
  ['profile_extension_v9_ddl', 'source_ddl_id = 142'],
  [
    'profile_extension_v9_filename',
    `filename = (${literal(jsonMap('filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v9_source',
    `source_sha256 = (${literal(jsonMap('sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v9_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV9ParentManifestSha256)}::text`,
  ],
] as const;
const bootstrap = `CREATE TABLE wm_runtime_installation.profile_extension_v9 (
 extension_step integer NOT NULL CONSTRAINT profile_extension_v9_step CHECK(${checks[0][1]}),
 source_ddl_id integer NOT NULL CONSTRAINT profile_extension_v9_ddl CHECK(${checks[1][1]}),
 filename text NOT NULL CONSTRAINT profile_extension_v9_filename CHECK(${checks[2][1]}),
 source_sha256 text NOT NULL CONSTRAINT profile_extension_v9_source CHECK(${checks[3][1]}),
 parent_manifest_sha256 text NOT NULL CONSTRAINT profile_extension_v9_parent CHECK(${checks[4][1]}),
 CONSTRAINT profile_extension_v9_pkey PRIMARY KEY(extension_step),
 CONSTRAINT profile_extension_v9_source_ddl_id_key UNIQUE(source_ddl_id),
 CONSTRAINT profile_extension_v9_filename_key UNIQUE(filename)
); REVOKE ALL ON wm_runtime_installation.profile_extension_v9 FROM PUBLIC;`;
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
    name: 'profile_extension_v9_pkey',
    kind: 'p',
    definition: 'PRIMARY KEY (extension_step)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v9_source_ddl_id_key',
    kind: 'u',
    definition: 'UNIQUE (source_ddl_id)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v9_filename_key',
    kind: 'u',
    definition: 'UNIQUE (filename)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
function parentJsonMap(field: 'filename' | 'sha256') {
  // Canonical PostgreSQL jsonb text for this fixed eight-key/string map.
  return (
    '{' +
    currentRuntimeV8ExtensionMembers
      .map((m) => JSON.stringify(String(m.extensionStep)) + ': ' + JSON.stringify(m[field]))
      .join(', ') +
    '}'
  );
}
const parentChecks = [
  ['profile_extension_v8_step', 'extension_step = ANY (ARRAY[1, 2, 3, 4, 5, 6, 7, 8])'],
  ['profile_extension_v8_ddl', 'source_ddl_id = (133 + extension_step)'],
  [
    'profile_extension_v8_filename',
    `filename = (${literal(parentJsonMap('filename'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_source',
    `source_sha256 = (${literal(parentJsonMap('sha256'))}::jsonb ->> (extension_step)::text)`,
  ],
  [
    'profile_extension_v8_parent',
    `parent_manifest_sha256 = ${literal(currentRuntimeV8ParentManifestSha256)}::text`,
  ],
] as const;
const parentConstraints = [
  ...parentChecks.map(([name, expression]) => ({
    name,
    kind: 'c',
    definition: `CHECK ((${expression}))`,
    validated: true,
    deferrable: false,
    deferred: false,
  })),
  {
    name: 'profile_extension_v8_pkey',
    kind: 'p',
    definition: 'PRIMARY KEY (extension_step)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v8_source_ddl_id_key',
    kind: 'u',
    definition: 'UNIQUE (source_ddl_id)',
    validated: true,
    deferrable: false,
    deferred: false,
  },
  {
    name: 'profile_extension_v8_filename_key',
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
const catalogSql = `SELECT current_user=session_user AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND n.nspowner=c.relowner AS owner,
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
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relname='profile_extension_v9'`;
async function receipts(tx: CurrentRuntimeInstallationTransaction) {
  const c = await tx.query(catalogSql, [JSON.stringify(expectedConstraints)]);
  if (c.rows.length !== 1 || !catalogSchema.safeParse(c.rows[0]).success)
    fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
  const rows = await tx.query(
    `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.profile_extension_v9 ORDER BY extension_step`,
  );
  const parsed = receiptRosterSchema.safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
  if (
    JSON.stringify(parsed.data) !==
    JSON.stringify(
      currentRuntimeV9ExtensionMembers.map((m) => ({
        ...m,
        parentManifestSha256: currentRuntimeV9ParentManifestSha256,
      })),
    )
  )
    fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
  return parsed.data;
}
const parentReceiptRosterSchema = z
  .array(
    receiptSchema.extend({
      extensionStep: z.number().int().min(1).max(8),
      sourceDdlId: z.number().int().min(134).max(141),
      parentManifestSha256: z.literal(currentRuntimeV8ParentManifestSha256),
    }),
  )
  .length(8);
async function parentReceipts(tx: CurrentRuntimeInstallationTransaction) {
  const c = await tx.query(catalogSql.replaceAll('profile_extension_v9', 'profile_extension_v8'), [
    JSON.stringify(parentConstraints),
  ]);
  if (c.rows.length !== 1 || !catalogSchema.safeParse(c.rows[0]).success)
    fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
  const rows = await tx.query(
    `SELECT extension_step AS "extensionStep",source_ddl_id AS "sourceDdlId",filename,source_sha256 AS sha256,parent_manifest_sha256 AS "parentManifestSha256" FROM wm_runtime_installation.profile_extension_v8 ORDER BY extension_step`,
  );
  const parsed = parentReceiptRosterSchema.safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
  if (
    JSON.stringify(parsed.data) !==
    JSON.stringify(
      currentRuntimeV8ExtensionMembers.map((m) => ({
        ...m,
        parentManifestSha256: currentRuntimeV8ParentManifestSha256,
      })),
    )
  )
    fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
  return parsed.data;
}
const stateSchema = z.strictObject({
  ledger: z.boolean(),
  pooled: z.boolean(),
  knownLedgers: z.literal(true),
});
async function presence(tx: CurrentRuntimeInstallationTransaction) {
  const rows = await tx.query(
    `SELECT to_regclass('wm_runtime_installation.profile_extension_v9') IS NOT NULL AS ledger,
 EXISTS(SELECT 1 FROM unnest($1::text[]) s(signature) WHERE to_regprocedure(s.signature) IS NOT NULL) AS pooled,
 NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND c.relkind IN ('r','p','v','m','f','S') AND c.relname NOT IN ('migration','profile_extension_v2','profile_extension_v3','profile_extension_v4','profile_extension_v5','profile_extension_v6','profile_extension_v7','profile_extension_v8','profile_extension_v9')) AS "knownLedgers"`,
    [currentRuntimeV9FunctionPins.slice(24).map((p) => p.signature)],
  );
  const parsed = stateSchema.safeParse(rows.rows[0]);
  if (rows.rows.length !== 1 || !parsed.success) fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
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
async function verifyFunctions(tx: CurrentRuntimeInstallationTransaction) {
  const rows = await tx.query(
    `SELECT pin.value->>'signature' AS signature,
 current_user=session_user AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owner,
 CASE WHEN octet_length(p.prosrc)<=2097152 THEN encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') ELSE NULL END AS "bodySha256",
 (to_jsonb(p)-ARRAY['oid','proowner','prolang','pronamespace','proacl','prosrc'])=pin.value->'metadata'
 AND l.lanname=pin.value->>'language' AS "metadataMatches",
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 OR a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR pin.value->>'runtimeDirect'<>'true')) AS "safeAcl",
 n.nspname=split_part(pin.value->>'signature','.',1) AND (n.nspname='public' OR n.nspowner=p.proowner) AS namespace
 FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY pin(value,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(pin.value->>'signature') JOIN pg_language l ON l.oid=p.prolang JOIN pg_namespace n ON n.oid=p.pronamespace ORDER BY pin.ordinal`,
    [JSON.stringify([...currentRuntimeV9FunctionPins, ...guardPins])],
  );
  const parsed = z.array(functionRow).length(30).safeParse(rows.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V9_FUNCTION_DRIFT');
  for (const [i, row] of parsed.data.entries()) {
    const pin = [...currentRuntimeV9FunctionPins, ...guardPins][i];
    if (!pin || row.signature !== pin.signature || row.bodySha256 !== pin.prosrcSha256)
      fail('CURRENT_RUNTIME_V9_FUNCTION_DRIFT');
  }
  const shape = await tx.query(`SELECT count(*)::int AS count,
 coalesce(bool_and(n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee<>n.nspowner)),false) AS private FROM pg_namespace n JOIN pg_proc p ON p.pronamespace=n.oid WHERE n.nspname='wm_manual_pooled'`);
  if (
    shape.rows.length !== 1 ||
    shape.rows[0]?.['count'] !== 13 ||
    shape.rows[0]?.['private'] !== true
  )
    fail('CURRENT_RUNTIME_V9_FUNCTION_DRIFT');
}
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
    fail('CURRENT_RUNTIME_V9_PARENT_MISMATCH');
  const receipts = await parentReceipts(tx);
  if (
    JSON.stringify(
      receipts.map((m) => ({
        step: 23 + m.extensionStep,
        sourceDdlId: m.sourceDdlId,
        filename: m.filename,
        sha256: m.sha256,
      })),
    ) !== JSON.stringify(currentRuntimeV9ParentMembers.slice(23))
  )
    fail('CURRENT_RUNTIME_V9_PARENT_MISMATCH');
}
// Full parent33 source/meta and ledger rows+xmin are compared across installation.
// Retained domain bodies/credentials are never selected here.
const prefixFunctionsSchema = z
  .array(
    z.strictObject({
      signature: z.string().max(250),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  )
  .length(57);
async function prefix(tx: CurrentRuntimeInstallationTransaction) {
  const functions = await tx.query(
    `SELECT requested.signature,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') AS fingerprint FROM unnest($1::text[]) WITH ORDINALITY requested(signature,ordinal) JOIN pg_proc p ON p.oid=to_regprocedure(requested.signature) ORDER BY requested.ordinal`,
    [[...currentRuntimeV7RpcSourcePins, ...currentRuntimeV8FunctionPins].map((p) => p.signature)],
  );
  const parsed = prefixFunctionsSchema.safeParse(functions.rows);
  if (!parsed.success) fail('CURRENT_RUNTIME_V9_METADATA_CHANGED');
  for (const [i, row] of parsed.data.entries())
    if (
      row.signature !==
      [...currentRuntimeV7RpcSourcePins, ...currentRuntimeV8FunctionPins][i]?.signature
    )
      fail('CURRENT_RUNTIME_V9_METADATA_CHANGED');
  const ledgerNames = [
    'migration',
    'profile_extension_v2',
    'profile_extension_v3',
    'profile_extension_v4',
    'profile_extension_v5',
    'profile_extension_v6',
    'profile_extension_v7',
    'profile_extension_v8',
  ] as const;
  const ledger = [];
  for (const name of ledgerNames) {
    // Finite module-owned identifier only; never derived from caller JSON/catalog.
    const found = await tx.query(
      `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM wm_runtime_installation.${name} t`,
    );
    const stamp = z
      .strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
      .safeParse(found.rows[0]);
    if (found.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V9_METADATA_CHANGED');
    ledger.push({ name, ...stamp.data });
  }
  const baseline = await tx.query(
    `SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('row',to_jsonb(t),'xmin',t.xmin::text) ORDER BY version),'[]'::jsonb)::text,'UTF8')),'hex') AS fingerprint FROM public.schema_migrations t`,
  );
  const stamp = z
    .strictObject({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    .safeParse(baseline.rows[0]);
  if (baseline.rows.length !== 1 || !stamp.success) fail('CURRENT_RUNTIME_V9_METADATA_CHANGED');
  return { functions: parsed.data, ledger, baseline: stamp.data };
}

function result(extensionReceipts: z.infer<typeof receiptRosterSchema>) {
  return {
    profileVersion: 9 as const,
    parentProfileVersion: 8 as const,
    baselineSchemaVersion: 107 as const,
    parentRuntimeStep: 24 as const,
    extensionSteps: 1 as const,
    runtimeStep: 25 as const,
    sourceDdlTip: 142 as const,
    parentManifestSha256: currentRuntimeV9ParentManifestSha256,
    parentAppliedMembers: currentRuntimeV9ParentMembers,
    extensionMembers: currentRuntimeV9ExtensionMembers,
    extensionReceipts,
    excludedTargetTransforms: currentRuntimeTargetTransforms,
    catalogSecurity: 'not_verified' as const,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
  };
}
export async function verifyCurrentRuntimeV9InstalledIn(tx: CurrentRuntimeInstallationTransaction) {
  await sources();
  await parent(tx);
  const p = await presence(tx);
  if (!p.ledger || !p.pooled) fail('CURRENT_RUNTIME_V9_LEDGER_INVALID');
  const r = await receipts(tx);
  await verifyFunctions(tx);
  return result(r);
}
export async function installCurrentRuntimeV9In(tx: CurrentRuntimeInstallationTransaction) {
  const texts = await sources();
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const p = await presence(tx);
  if (p.ledger) return verifyCurrentRuntimeV9InstalledIn(tx);
  if (p.pooled) fail('CURRENT_RUNTIME_V9_UNREGISTERED_STAGE');
  await installCurrentRuntimeV8In(tx);
  await parent(tx);
  const before = await prefix(tx);
  await tx.query(bootstrap);
  for (const [i, text] of texts.entries()) {
    const member = currentRuntimeV9ExtensionMembers[i];
    if (!member) fail('CURRENT_RUNTIME_V9_SOURCE_MISMATCH');
    await tx.query(text);
    await tx.query(
      'INSERT INTO wm_runtime_installation.profile_extension_v9(extension_step,source_ddl_id,filename,source_sha256,parent_manifest_sha256) VALUES($1,$2,$3,$4,$5)',
      [
        member.extensionStep,
        member.sourceDdlId,
        member.filename,
        member.sha256,
        currentRuntimeV9ParentManifestSha256,
      ],
    );
  }
  if (JSON.stringify(await prefix(tx)) !== JSON.stringify(before))
    fail('CURRENT_RUNTIME_V9_METADATA_CHANGED');
  return verifyCurrentRuntimeV9InstalledIn(tx);
}
export async function installCurrentRuntimeV9(connectionString: string) {
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
      const r = await installCurrentRuntimeV9In(tx);
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
