import { z } from 'zod';
import {
  boundedPlain,
  canonical,
  CurrentRuntimeCatalogWitnessError,
} from './current-runtime-catalog-witness.js';
import {
  buildCurrentRuntimeCatalogWitnessV7,
  parseCurrentRuntimeCatalogWitnessV7,
} from './current-runtime-catalog-witness-v7.js';
import { buildCurrentRuntimeCatalogWitnessV10 } from './current-runtime-catalog-witness-v10.js';
import { currentRuntimeCatalogMetadataQueryV3 } from './current-runtime-catalog-witness-v3.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';
import {
  currentRuntimeV11ExtensionMembers,
  currentRuntimeV11ParentMembers,
  currentRuntimeV11Tables,
  verifyCurrentRuntimeV11InstalledIn,
} from './current-runtime-installation-v11.js';
import {
  currentRuntimeV11AiDispatcherRole,
  currentRuntimeV11AiDispatcherTableGrants,
  currentRuntimeV11GalleryWorkerRole,
  currentRuntimeV11OwnerOnlyFunctions,
  currentRuntimeV11RpcSignatures,
  currentRuntimeV11RpcSourcePins,
  currentRuntimeV11RuntimeTableGrants,
  currentRuntimeV11WorkerRpcSignatures,
} from './current-runtime-grants-v11.js';
import { currentRuntimeV11FunctionPins } from './current-runtime-installation-v11.js';

// Profile27 (physical V11, runtime27, tip148). Three non-owner principals hold catalog ACLs:
// the API runtime (51 roots + 6 V11 table grants), the gallery rendition worker (5 worker
// RPCs) and the M2-05b AI dispatcher (disposition SELECT/INSERT). The worker and dispatcher
// names are fixed by the product, so the V11 metadata query tags them by name instead of
// leaving `unmapped:<name>` tags. Every other byte of the V3 query is unchanged.
const runtimeAnchor = "WHEN rolname=$1 THEN 'runtime'";
export const currentRuntimeV11PrincipalRoleTags = Object.freeze({
  [currentRuntimeV11GalleryWorkerRole]: 'gallery_rendition_worker',
  [currentRuntimeV11AiDispatcherRole]: 'ai_dispatcher',
} as Readonly<Record<string, string>>);
function principalQuery() {
  const query = currentRuntimeCatalogMetadataQueryV3;
  const fixed = Object.entries(currentRuntimeV11PrincipalRoleTags);
  if (
    query.split(runtimeAnchor).length !== 2 ||
    fixed.length !== 2 ||
    fixed.some(([role, tag]) => !/^[a-z_][a-z0-9_]{0,62}$/.test(role) || !/^[a-z_]+$/.test(tag))
  )
    throw new Error('CATALOG_WITNESS_V11_QUERY_SOURCE_INVALID');
  const mapped = fixed.map(([role, tag]) => ` WHEN rolname='${role}' THEN '${tag}'`).join('');
  return query.replace(runtimeAnchor, () => runtimeAnchor + mapped);
}
/** Compiled SQL only (no caller fragment): V3 metadata query plus the two fixed principal tags. */
export const currentRuntimeCatalogMetadataQueryV11 = principalQuery();
const metadataEncoding = 'pg-catalog-runtime-security-normalized-v3-principals-v11' as const;
const rpcRecipe = Object.freeze({
  recipeVersion: 11 as const,
  name: 'current-runtime-grants-v11' as const,
  rootCount: 51 as const,
  signatures: currentRuntimeV11RpcSignatures,
  workerRole: currentRuntimeV11GalleryWorkerRole,
  workerRootCount: 5 as const,
  workerSignatures: currentRuntimeV11WorkerRpcSignatures,
  dispatcherRole: currentRuntimeV11AiDispatcherRole,
  runtimeTableGrants: currentRuntimeV11RuntimeTableGrants,
  dispatcherTableGrants: currentRuntimeV11AiDispatcherTableGrants,
  grantSourceSha256: '4a366989d5ab9cfe0fbb2d163467c52dba5c613d48f98b24991cff1ee561cf31',
  // The 42 parent roots keep the post142 root metadata artifact; the nine gallery roots
  // and the five worker RPCs are pinned by installer V11's function pins.
  parentRootMetadataArtifactSha256:
    '5ad2d0745f5e8504891550e4e43d1e7004869fc37309ef3f74ed267469162158',
});
const MAX_BYTES = 16 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function fail(code: CurrentRuntimeCatalogWitnessError['code']): never {
  throw new CurrentRuntimeCatalogWitnessError(code);
}
/** Same V3 whole metadata shape (V11 principal tags). Final148 observation is no support
 * seal; exact physical11 receipts and V11 pins are verified separately by verifyV11. */
export function buildCurrentRuntimeCatalogWitnessV11(raw: unknown) {
  const prior = buildCurrentRuntimeCatalogWitnessV10(raw);
  const artifact = {
    ...prior,
    witnessVersion: 11 as const,
    metadataEncoding,
    rpcRecipe,
    profile: {
      ...prior.profile,
      profileVersion: 11 as const,
      sourceDdlTip: 148 as const,
      runtimeStep: 27 as const,
      runtimeSteps: [
        ...prior.profile.runtimeSteps,
        ...currentRuntimeV11ExtensionMembers.map((member) => ({ ...member, step: 27 })),
      ],
      // Parent V10 physical receipts (physical33) and the five 143..148 receipts are
      // independently checked by verifyV11; no physical member is an extra logical step.
      parentMembers: currentRuntimeV11ParentMembers,
      extensionMembers: currentRuntimeV11ExtensionMembers,
    },
  };
  boundedPlain(artifact);
  return artifact;
}
export type CurrentRuntimeCatalogWitnessV11 = ReturnType<
  typeof buildCurrentRuntimeCatalogWitnessV11
>;
const observationSchema = z.strictObject({
  clusterRoleCount: z.number().int().min(4).max(10000),
  metadataBytes: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .refine((v) => BigInt(v) <= BigInt(MAX_BYTES)),
  sqlJsonbSha256: hash,
  expectedRootCount: z.literal(51),
  expectedWorkerRootCount: z.literal(5),
});
/** Pure structure/checksum verification, never authenticates caller expectations. */
export function parseCurrentRuntimeCatalogWitnessV11(
  raw: unknown,
): CurrentRuntimeCatalogWitnessV11 & { observation?: z.infer<typeof observationSchema> } {
  boundedPlain(raw);
  const shell = z
    .object({
      witnessVersion: z.literal(11),
      metadataEncoding: z.literal(metadataEncoding),
      profile: z.unknown(),
      rpcRecipe: z.unknown(),
      metadata: z.unknown(),
      observation: observationSchema.optional(),
    })
    .safeParse(raw);
  if (!shell.success) fail('CATALOG_WITNESS_INVALID');
  const expected = buildCurrentRuntimeCatalogWitnessV11(shell.data.metadata);
  if (JSON.stringify(canonical(shell.data.profile)) !== JSON.stringify(canonical(expected.profile)))
    fail('CATALOG_WITNESS_INVALID');
  if (JSON.stringify(canonical(shell.data.rpcRecipe)) !== JSON.stringify(canonical(rpcRecipe)))
    fail('CATALOG_WITNESS_INVALID');
  const prior = buildCurrentRuntimeCatalogWitnessV7(shell.data.metadata);
  // Delegate exact finite body fields, section hashes, namespaces and V3 encoding limits.
  const parsed = z.record(z.string(), z.unknown()).parse(raw);
  const { rpcRecipe: declaredRecipe, ...priorFields } = parsed;
  void declaredRecipe;
  parseCurrentRuntimeCatalogWitnessV7({
    ...priorFields,
    witnessVersion: 7,
    metadataEncoding: prior.metadataEncoding,
    profile: prior.profile,
    rpcRecipe: prior.rpcRecipe,
    ...(shell.data.observation
      ? {
          observation: {
            clusterRoleCount: shell.data.observation.clusterRoleCount,
            metadataBytes: shell.data.observation.metadataBytes,
            sqlJsonbSha256: shell.data.observation.sqlJsonbSha256,
            expectedRootCount: 33,
          },
        }
      : {}),
  });
  return shell.data.observation ? { ...expected, observation: shell.data.observation } : expected;
}
const roleName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
// A fixed principal: exists, distinct, no elevated attribute, no membership edge at all and
// owns nothing. ($1 runtime, $2 fixed principal name.)
const fixedPrincipalSql = (
  name: string,
) => `EXISTS(SELECT 1 FROM pg_catalog.pg_roles f WHERE f.rolname=${name}
  AND f.oid<>o.oid AND f.oid<>r.oid AND NOT f.rolsuper AND NOT f.rolbypassrls AND NOT f.rolcreaterole AND NOT f.rolcreatedb AND NOT f.rolreplication
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=f.oid OR m.roleid=f.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=f.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=f.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=f.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type t WHERE t.typowner=f.oid))`;
const contextSql = `SELECT current_user=session_user AND NOT o.rolsuper AND NOT o.rolbypassrls AS owner,
 r.oid<>o.oid AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND NOT pg_has_role(r.oid,o.oid,'MEMBER') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR left(e.rolname,3)='pg_') AND pg_has_role(r.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid)
 AND r.rolname<>ALL($2::text[]) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles f WHERE f.rolname=ANY($2::text[]) AND (pg_has_role(r.oid,f.oid,'MEMBER') OR pg_has_role(f.oid,r.oid,'MEMBER'))) AS runtime,
 ${fixedPrincipalSql('$3')} AS worker,
 ${fixedPrincipalSql('$4')} AS dispatcher,
 h.oid IS NOT NULL AND NOT has_function_privilege(r.oid,h.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(h.proacl,acldefault('f',h.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS "privateHelper",
 current_setting('transaction_read_only')='on' AS "readOnly",current_setting('search_path') IN('pg_catalog,pg_temp','pg_catalog, pg_temp') AS "pathSafe",current_setting('transaction_isolation') AS isolation,(SELECT count(*)::int FROM pg_catalog.pg_roles) AS "roleCount",
 EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=872194 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=77210 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AS "locksHeld"
 FROM pg_catalog.pg_roles o CROSS JOIN pg_catalog.pg_roles r LEFT JOIN pg_catalog.pg_proc h ON h.oid=to_regprocedure('public.manual_source_personal_row_exists_v1(jsonb,jsonb)') WHERE o.rolname=session_user AND r.rolname=$1`;
/** Owner RR READ ONLY observation only; no body text, health rows or private RPC. The
 * caller's transaction carries the transaction-local search_path verifyV11 needs. */
export async function captureCurrentRuntimeCatalogWitnessV11In(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = roleName.safeParse(unknownRuntimeRole);
  if (!runtimeRole.success) fail('CATALOG_WITNESS_INVALID');
  const fixed = [currentRuntimeV11GalleryWorkerRole, currentRuntimeV11AiDispatcherRole];
  const context = await tx.query(contextSql, [runtimeRole.data, fixed, ...fixed]);
  boundedPlain(context.rows);
  const ctx = z
    .strictObject({
      owner: z.literal(true),
      privateHelper: z.literal(true),
      locksHeld: z.literal(true),
      runtime: z.literal(true),
      worker: z.literal(true),
      dispatcher: z.literal(true),
      readOnly: z.literal(true),
      pathSafe: z.literal(true),
      isolation: z.enum(['repeatable read', 'serializable']),
      roleCount: z.number().int().min(4).max(10000),
    })
    .safeParse(context.rows[0]);
  if (context.rows.length !== 1 || !ctx.success) fail('CATALOG_WITNESS_CONTEXT_REQUIRED');
  await verifyCurrentRuntimeV11InstalledIn(tx);
  await verifyRoots(tx, runtimeRole.data);
  await verifyWorkerRoots(tx, runtimeRole.data);
  await verifyOwnerOnly(tx, runtimeRole.data);
  await verifyTables(tx, runtimeRole.data);
  const counts = await tx.query(`SELECT
 (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE pronamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) functions,
 (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) relations,
 (SELECT count(*)::int FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) types,
 (SELECT coalesce(max(octet_length(prosrc)),0)::int FROM pg_catalog.pg_proc) "maxSourceBytes"`);
  boundedPlain(counts.rows);
  const countSchema = z.strictObject({
    functions: z.number().int().min(56).max(5000),
    relations: z.number().int().min(36).max(5000),
    types: z.number().int().min(0).max(5000),
    maxSourceBytes: z.number().int().min(0).max(2097152),
  });
  if (counts.rows.length !== 1 || !countSchema.safeParse(counts.rows[0]).success)
    fail('CATALOG_WITNESS_LIMIT');
  // One materialized catalog body per capture. SQL computes scalar evidence
  // before conditionally returning metadata; oversized bodies never leave PG.
  await tx.query("SET LOCAL statement_timeout='30000ms'");
  const observed = await tx.query(
    `${currentRuntimeCatalogMetadataQueryV11}, measured AS MATERIALIZED (SELECT body,octet_length(body::text) bytes,encode(sha256(convert_to(body::text,'UTF8')),'hex') sha256 FROM enriched)
 SELECT bytes::text bytes,sha256,CASE WHEN bytes<=16777216 THEN body ELSE NULL END metadata FROM measured`,
    [runtimeRole.data],
  );
  boundedPlain(observed.rows);
  const envelope = z
    .strictObject({
      bytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
      metadata: z.unknown(),
      sha256: hash,
    })
    .safeParse(observed.rows[0]);
  if (observed.rows.length !== 1 || !envelope.success) fail('CATALOG_WITNESS_INVALID');
  if (BigInt(envelope.data.bytes) > BigInt(MAX_BYTES)) fail('CATALOG_WITNESS_LIMIT');
  const raw = envelope.data.metadata;
  boundedPlain(raw);
  if (BigInt(Buffer.byteLength(JSON.stringify(raw), 'utf8')) > BigInt(envelope.data.bytes))
    fail('CATALOG_WITNESS_INVALID');
  const witness = buildCurrentRuntimeCatalogWitnessV11(raw);
  // Both fixed principals are always part of the profile27 catalog; an unmapped role
  // connected to the catalog is never normalized away.
  const tags = witness.metadata.roles.map((v) => v.tag);
  if (
    witness.unmappedRoleTags.length ||
    !Object.values(currentRuntimeV11PrincipalRoleTags).every((t) => tags.includes(t))
  )
    fail('CATALOG_WITNESS_INVALID');
  return {
    ...witness,
    observation: {
      clusterRoleCount: ctx.data.roleCount,
      metadataBytes: envelope.data.bytes,
      sqlJsonbSha256: envelope.data.sha256,
      expectedRootCount: 51 as const,
      expectedWorkerRootCount: 5 as const,
    },
  };
}

// $1 signatures, $2 runtime, $3 worker, $4 dispatcher.
const functionAclSql = `SELECT i.ordinal::int AS ordinal,i.signature,p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owned,l.lanname AS language,format_type(p.prorettype,NULL) AS result_type,p.prosecdef AS security_definer,p.provolatile AS volatility,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source_sha256,
 CASE WHEN cardinality(p.proconfig) BETWEEN 1 AND 3 AND NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE octet_length(setting)>128) THEN p.proconfig ELSE NULL END AS configuration,
 has_function_privilege($2::text,p.oid,'EXECUTE') AS runtime_execute,has_function_privilege($3::text,p.oid,'EXECUTE') AS worker_execute,has_function_privilege($4::text,p.oid,'EXECUTE') AS dispatcher_execute,
 EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
 coalesce((SELECT array_agg(g ORDER BY g COLLATE "C") FROM (SELECT DISTINCT CASE WHEN a.grantee=0 THEN 'PUBLIC' WHEN pg_get_userbyid(a.grantee)=$2::text THEN 'runtime' WHEN pg_get_userbyid(a.grantee)=$3::text THEN 'worker' WHEN pg_get_userbyid(a.grantee)=$4::text THEN 'dispatcher' ELSE 'other' END g FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) grantee),'{}')::text[] AS grantees,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable)) AS safe_delegation
 FROM unnest($1::text[]) WITH ORDINALITY i(signature,ordinal) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(i.signature) LEFT JOIN pg_language l ON l.oid=p.prolang ORDER BY i.ordinal`;
const functionAclSchema = z.strictObject({
  ordinal: z.number().int().positive(),
  signature: z.string().max(250),
  owned: z.literal(true),
  language: z.enum(['plpgsql', 'sql']),
  result_type: z.string().max(128),
  security_definer: z.boolean(),
  volatility: z.enum(['i', 's', 'v']),
  source_sha256: hash,
  configuration: z.array(z.string().max(128)).min(1).max(3),
  runtime_execute: z.boolean(),
  worker_execute: z.boolean(),
  dispatcher_execute: z.boolean(),
  public_execute: z.literal(false),
  grantees: z.array(z.enum(['PUBLIC', 'runtime', 'worker', 'dispatcher', 'other'])).max(5),
  safe_delegation: z.literal(true),
});
type FunctionAcl = z.infer<typeof functionAclSchema>;
async function functionAcls(
  tx: CurrentRuntimeInstallationTransaction,
  signatures: readonly string[],
  runtimeRole: string,
): Promise<FunctionAcl[]> {
  const result = await tx.query(functionAclSql, [
    [...signatures],
    runtimeRole,
    currentRuntimeV11GalleryWorkerRole,
    currentRuntimeV11AiDispatcherRole,
  ]);
  boundedPlain(result.rows);
  const rows = z.array(functionAclSchema).length(signatures.length).safeParse(result.rows);
  if (!rows.success) fail('CATALOG_WITNESS_INVALID');
  for (const [i, row] of rows.data.entries())
    if (row.ordinal !== i + 1 || row.signature !== signatures[i]) fail('CATALOG_WITNESS_INVALID');
  return rows.data;
}
function principalAccess(
  row: FunctionAcl,
  expected: { runtime: boolean; worker: boolean; grantees: readonly string[] },
) {
  if (
    row.runtime_execute !== expected.runtime ||
    row.worker_execute !== expected.worker ||
    row.dispatcher_execute ||
    JSON.stringify(row.grantees) !== JSON.stringify(expected.grantees)
  )
    fail('CATALOG_WITNESS_INVALID');
}
/** 51 runtime roots: exact V10 root pins plus the nine gallery pins, runtime-only EXECUTE. */
async function verifyRoots(tx: CurrentRuntimeInstallationTransaction, runtimeRole: string) {
  const pins = currentRuntimeV11RpcSourcePins;
  if (pins.length !== 51) fail('CATALOG_WITNESS_INVALID');
  const rows = await functionAcls(
    tx,
    pins.map((p) => p.signature),
    runtimeRole,
  );
  for (const [i, row] of rows.entries()) {
    const pin = pins[i];
    if (
      !pin ||
      row.language !== pin.language ||
      row.result_type !== pin.result_type ||
      row.security_definer !== pin.security_definer ||
      row.volatility !== pin.volatility ||
      row.source_sha256 !== pin.prosrcSha256 ||
      JSON.stringify(row.configuration) !== JSON.stringify(pin.configuration)
    )
      fail('CATALOG_WITNESS_INVALID');
    principalAccess(row, { runtime: true, worker: false, grantees: ['runtime'] });
  }
}
function v11Pin(signature: string) {
  const pin = currentRuntimeV11FunctionPins.find((p) => p.signature === signature);
  if (!pin) fail('CATALOG_WITNESS_INVALID');
  return pin;
}
/** Five worker RPCs: exact installer pins, worker-only EXECUTE. */
async function verifyWorkerRoots(tx: CurrentRuntimeInstallationTransaction, runtimeRole: string) {
  const signatures = currentRuntimeV11WorkerRpcSignatures;
  if (signatures.length !== 5) fail('CATALOG_WITNESS_INVALID');
  const rows = await functionAcls(tx, signatures, runtimeRole);
  for (const row of rows) {
    const pin = v11Pin(row.signature);
    if (
      pin.access !== 'worker' ||
      row.language !== pin.language ||
      row.result_type !== pin.returns ||
      row.security_definer !== pin.securityDefiner ||
      row.volatility !== pin.volatility ||
      row.source_sha256 !== pin.prosrcSha256 ||
      JSON.stringify(row.configuration) !== JSON.stringify(['search_path=pg_catalog, pg_temp'])
    )
      fail('CATALOG_WITNESS_INVALID');
    principalAccess(row, { runtime: false, worker: true, grantees: ['worker'] });
  }
}
/** Owner-only functions (V10 helpers + guard and every owner-access V11 function): no grantee
 * other than the owner, never executable by any principal. Bodies are pinned by verifyV11. */
async function verifyOwnerOnly(tx: CurrentRuntimeInstallationTransaction, runtimeRole: string) {
  const signatures = currentRuntimeV11OwnerOnlyFunctions;
  if (signatures.length < 60 || new Set(signatures).size !== signatures.length)
    fail('CATALOG_WITNESS_INVALID');
  const result = await tx.query(functionAclSql, [
    [...signatures],
    runtimeRole,
    currentRuntimeV11GalleryWorkerRole,
    currentRuntimeV11AiDispatcherRole,
  ]);
  boundedPlain(result.rows);
  const rows = z
    .array(
      z
        .object({
          ordinal: z.number().int().positive(),
          signature: z.string().max(250),
          owned: z.literal(true),
          runtime_execute: z.literal(false),
          worker_execute: z.literal(false),
          dispatcher_execute: z.literal(false),
          public_execute: z.literal(false),
          grantees: z.array(z.string()).length(0),
          safe_delegation: z.literal(true),
        })
        .passthrough(),
    )
    .length(signatures.length)
    .safeParse(result.rows);
  if (!rows.success) fail('CATALOG_WITNESS_INVALID');
  for (const [i, row] of rows.data.entries())
    if (row.ordinal !== i + 1 || row.signature !== signatures[i]) fail('CATALOG_WITNESS_INVALID');
}
const privilegeNames = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;
/** Every V11 table: exactly the runtime/dispatcher allowances, nothing for the worker or
 * PUBLIC, no other grantee, no grant option and no column ACL. */
async function verifyTables(tx: CurrentRuntimeInstallationTransaction, runtimeRole: string) {
  const result = await tx.query(
    `SELECT t.ordinal::int AS ordinal,t.name,c.oid IS NOT NULL AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owned,
 coalesce((SELECT array_agg(p ORDER BY o) FROM unnest($5::text[]) WITH ORDINALITY x(p,o) WHERE has_table_privilege($2::text,c.oid,p)),'{}')::text[] AS runtime,
 coalesce((SELECT array_agg(p ORDER BY o) FROM unnest($5::text[]) WITH ORDINALITY x(p,o) WHERE has_table_privilege($3::text,c.oid,p)),'{}')::text[] AS worker,
 coalesce((SELECT array_agg(p ORDER BY o) FROM unnest($5::text[]) WITH ORDINALITY x(p,o) WHERE has_table_privilege($4::text,c.oid,p)),'{}')::text[] AS dispatcher,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner AND (a.is_grantable OR a.grantee=0 OR pg_get_userbyid(a.grantee) NOT IN($2::text,$4::text))) AS delegation_safe,
 NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND a.attacl IS NOT NULL) AS column_acl_free
 FROM unnest($1::text[]) WITH ORDINALITY t(name,ordinal) LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||t.name) ORDER BY t.ordinal`,
    [
      [...currentRuntimeV11Tables],
      runtimeRole,
      currentRuntimeV11GalleryWorkerRole,
      currentRuntimeV11AiDispatcherRole,
      [...privilegeNames],
    ],
  );
  boundedPlain(result.rows);
  const rows = z
    .array(
      z.strictObject({
        ordinal: z.number().int().positive(),
        name: z.string().max(63),
        owned: z.literal(true),
        runtime: z.array(z.enum(privilegeNames)).max(7),
        worker: z.array(z.enum(privilegeNames)).length(0),
        dispatcher: z.array(z.enum(privilegeNames)).max(7),
        delegation_safe: z.literal(true),
        column_acl_free: z.literal(true),
      }),
    )
    .length(currentRuntimeV11Tables.length)
    .safeParse(result.rows);
  if (!rows.success) fail('CATALOG_WITNESS_INVALID');
  const allowance = (grants: readonly { table: string; privileges: readonly string[] }[]) =>
    new Map(grants.map((g) => [g.table, JSON.stringify(g.privileges)]));
  const runtime = allowance(currentRuntimeV11RuntimeTableGrants);
  const dispatcher = allowance(currentRuntimeV11AiDispatcherTableGrants);
  for (const [i, row] of rows.data.entries())
    if (
      row.ordinal !== i + 1 ||
      row.name !== currentRuntimeV11Tables[i] ||
      JSON.stringify(row.runtime) !== (runtime.get(row.name) ?? '[]') ||
      JSON.stringify(row.dispatcher) !== (dispatcher.get(row.name) ?? '[]')
    )
      fail('CATALOG_WITNESS_INVALID');
}
