import { Pool } from 'pg';
import { z } from 'zod';
import {
  currentRuntimeV10RpcSourcePins,
  currentRuntimeV10OwnerOnlyPublicHelpers,
  currentRuntimeV10PrivateHelpers,
  currentRuntimeV10TriggerFunctions,
} from './current-runtime-grants-v10.js';
import {
  verifyCurrentRuntimeV11InstalledIn,
  currentRuntimeV11FunctionPins,
  currentRuntimeV11KnownLedgers,
  currentRuntimeV11Tables,
  currentRuntimeV11TableDelegations,
} from './current-runtime-installation-v11.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';
import {
  galleryNavigationRuntimeFunctionsV1,
  galleryNavigationRuntimeReadTablesV1,
} from './gallery-navigation-pins-v1.js';
import {
  galleryRenditionApiFunctionsV1,
  galleryRenditionWorkerFunctionsV1,
  galleryRenditionWorkerRoleV1,
} from './gallery-rendition-pins-v1.js';

// Profile27 (physical V11, source tip 148). Three disjoint principals:
//  - the API runtime role: V10's 42 roots + 7 gallery navigation RPCs + 2 rendition read RPCs,
//    SELECT on the 4 navigation read tables, SELECT/INSERT on ai_execution_job and SELECT on
//    ai_synthetic_evidence_attestation. Restore admission stays read_/require_/lock_ only (the
//    migrate.ts runtime grants; 147 replaces read_/require_ in place and keeps their ACL);
//  - the gallery rendition worker (fixed name): the 5 worker RPCs only, no table privilege;
//  - the M2-05b AI dispatcher (fixed name): SELECT/INSERT on ai_execution_job_disposition.
// No role is created here; each grant refuses a role that overlaps another principal.
export const currentRuntimeV11GalleryWorkerRole = galleryRenditionWorkerRoleV1;
export const currentRuntimeV11AiDispatcherRole = 'workout_ai_dispatcher';
type TableGrant = Readonly<{ table: string; privileges: readonly ('SELECT' | 'INSERT')[] }>;
export const currentRuntimeV11RuntimeTableGrants: readonly TableGrant[] = Object.freeze([
  ...galleryNavigationRuntimeReadTablesV1.map((table) =>
    Object.freeze({ table, privileges: Object.freeze(['SELECT'] as const) }),
  ),
  Object.freeze({
    table: 'ai_execution_job',
    privileges: Object.freeze(['SELECT', 'INSERT'] as const),
  }),
  Object.freeze({
    table: 'ai_synthetic_evidence_attestation',
    privileges: Object.freeze(['SELECT'] as const),
  }),
]);
export const currentRuntimeV11AiDispatcherTableGrants: readonly TableGrant[] = Object.freeze([
  Object.freeze({
    table: 'ai_execution_job_disposition',
    privileges: Object.freeze(['SELECT', 'INSERT'] as const),
  }),
]);
function pinOf(signature: string) {
  const pin = currentRuntimeV11FunctionPins.find((p) => p.signature === signature);
  if (!pin) throw new Error('CURRENT_RUNTIME_V11_COMPILED_ROSTER_INVALID');
  return pin;
}
function galleryRpcPins() {
  const signatures = [...galleryNavigationRuntimeFunctionsV1, ...galleryRenditionApiFunctionsV1];
  return signatures.map((signature) => {
    const pin = pinOf(signature);
    if (pin.access !== 'runtime') throw new Error('CURRENT_RUNTIME_V11_COMPILED_ROSTER_INVALID');
    return Object.freeze({
      signature,
      prosrcSha256: pin.prosrcSha256,
      language: pin.language,
      result_type: pin.returns,
      security_definer: pin.securityDefiner,
      volatility: pin.volatility,
      configuration: Object.freeze(['search_path=pg_catalog, pg_temp']),
    });
  });
}
export const currentRuntimeV11RpcSourcePins = Object.freeze([
  ...currentRuntimeV10RpcSourcePins,
  ...galleryRpcPins(),
]);
export const currentRuntimeV11RpcSignatures = Object.freeze(
  currentRuntimeV11RpcSourcePins.map((pin) => pin.signature),
);
export const currentRuntimeV11WorkerRpcSignatures = Object.freeze(
  galleryRenditionWorkerFunctionsV1.map((signature) => {
    if (pinOf(signature).access !== 'worker')
      throw new Error('CURRENT_RUNTIME_V11_COMPILED_ROSTER_INVALID');
    return signature;
  }),
);
/** Functions no principal other than the owner may ever execute (V10 helpers + guard and
 * every owner-access V11 function, incl. 147's open_/admit_/close_/assert_/roster_*). */
export const currentRuntimeV11OwnerOnlyFunctions = Object.freeze([
  ...currentRuntimeV10OwnerOnlyPublicHelpers,
  ...currentRuntimeV10PrivateHelpers,
  ...currentRuntimeV10TriggerFunctions,
  ...currentRuntimeV11FunctionPins.filter((p) => p.access === 'owner').map((p) => p.signature),
]);
if (
  currentRuntimeV11RpcSignatures.length !== 51 ||
  new Set(currentRuntimeV11RpcSignatures).size !== 51 ||
  currentRuntimeV11WorkerRpcSignatures.length !== 5 ||
  currentRuntimeV11OwnerOnlyFunctions.some(
    (s) =>
      currentRuntimeV11RpcSignatures.includes(s) ||
      (currentRuntimeV11WorkerRpcSignatures as readonly string[]).includes(s),
  ) ||
  [...currentRuntimeV11RuntimeTableGrants, ...currentRuntimeV11AiDispatcherTableGrants].some(
    (g) =>
      JSON.stringify(g.privileges) !==
      JSON.stringify(currentRuntimeV11TableDelegations[g.table] ?? null),
  ) ||
  Object.keys(currentRuntimeV11TableDelegations).length !== 7
)
  throw new Error('CURRENT_RUNTIME_V11_COMPILED_ROSTER_INVALID');

export class CurrentRuntimeV11GrantError extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V11_INVALID_ROLE'
      | 'CURRENT_RUNTIME_V11_UNSAFE_ROLE'
      | 'CURRENT_RUNTIME_V11_RPC_INVALID'
      | 'CURRENT_RUNTIME_V11_GRANT_UNVERIFIED',
  ) {
    super(code);
  }
}
const roleSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const roleObservationSchema = z.strictObject({ safe: z.literal(true) });
const rpcObservationSchema = z.strictObject({
  ordinal: z.number().int().positive(),
  signature: z.string(),
  owned: z.literal(true),
  language: z.enum(['plpgsql', 'sql']),
  result_type: z.enum(['jsonb', 'boolean', 'uuid', 'void', 'timestamp with time zone']),
  security_definer: z.boolean(),
  volatility: z.enum(['i', 's', 'v']),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  public_execute: z.literal(false),
  safe_delegation: z.literal(true),
  configuration: z.array(z.string().max(128)).min(1).max(3),
});
function invalid(code: CurrentRuntimeV11GrantError['code']): never {
  throw new CurrentRuntimeV11GrantError(code);
}
function checkedRole(raw: unknown): string {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V11_INVALID_ROLE');
  return parsed.data;
}
function fixedRole(raw: unknown, expected: string): string {
  const role = checkedRole(raw);
  if (role !== expected) invalid('CURRENT_RUNTIME_V11_INVALID_ROLE');
  return role;
}
const allPrivileges = 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER';
// Plain non-owner principal: no elevated attribute or membership, owns nothing, cannot
// create anywhere, never touches the installation ledgers or the private pooled schema,
// and executes none of the owner-only functions ($2) or no grantee holds them at all.
const plainPrincipalSql = `NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
    AND r.oid<>o.oid AND NOT pg_has_role(r.oid,o.oid,'MEMBER') AND NOT pg_has_role(o.oid,r.oid,'MEMBER')
    AND NOT EXISTS(SELECT 1 FROM pg_roles elevated WHERE
      (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolname LIKE 'pg_%') AND pg_has_role(r.oid,elevated.oid,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT has_schema_privilege(r.oid,'wm_runtime_installation','USAGE,CREATE')
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) l(name)
      WHERE has_table_privilege(r.oid,to_regclass('wm_runtime_installation.'||l.name),'${allPrivileges}'))
    AND NOT EXISTS(SELECT 1 FROM pg_class extension JOIN pg_namespace en ON en.oid=extension.relnamespace
      WHERE en.nspname='wm_runtime_installation' AND extension.relkind IN ('r','p','v','m','f','S')
        AND extension.relname<>ALL($3::text[]))
    AND NOT has_schema_privilege(r.oid,'wm_manual_pooled','USAGE,CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('wm_runtime_installation','wm_manual_pooled') AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege(r.oid,c.oid,'${allPrivileges}')
       OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT has_function_privilege(r.oid,'public.manual_source_personal_row_exists_v1(jsonb,jsonb)','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_proc helper CROSS JOIN LATERAL aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
      WHERE helper.oid='public.manual_source_personal_row_exists_v1(jsonb,jsonb)'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) i(signature)
      WHERE has_function_privilege(r.oid,to_regprocedure(i.signature),'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc h CROSS JOIN LATERAL aclexplode(coalesce(h.proacl,acldefault('f',h.proowner))) a
      WHERE h.oid IN (SELECT to_regprocedure(signature) FROM unnest($2::text[]) i(signature))
      AND a.grantee<>h.proowner)
    AND NOT has_function_privilege(r.oid,'public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz)','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner=r.oid)`;
// V11 tables: the principal holds no privilege outside its own allowance ($4 jsonb
// table -> privileges) and no column privilege at all.
const v11TableAllowanceSql = `NOT EXISTS(SELECT 1 FROM unnest($5::text[]) t(name)
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(privilege)
      WHERE has_table_privilege(r.oid,to_regclass('public.'||t.name),p.privilege)
        AND p.privilege NOT IN (SELECT jsonb_array_elements_text(coalesce($4::jsonb->t.name,'[]'::jsonb))))
    AND NOT EXISTS(SELECT 1 FROM unnest($5::text[]) t(name) JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||t.name)
      CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE x.grantee=r.oid)`;
function allowance(grants: readonly TableGrant[]) {
  return JSON.stringify(Object.fromEntries(grants.map((g) => [g.table, g.privileges])));
}
// The other principals (fixed names) must not be the role, its member or its parent.
const disjointSql = `NOT EXISTS(SELECT 1 FROM pg_roles other WHERE other.rolname=ANY($6::text[])
      AND (other.oid=r.oid OR pg_has_role(r.oid,other.oid,'MEMBER') OR pg_has_role(other.oid,r.oid,'MEMBER')))`;
// Functions this principal must not execute ($7): the other principals' RPCs.
const forbiddenFunctionsSql = `AND NOT EXISTS(SELECT 1 FROM unnest($7::text[]) f(signature)
      WHERE has_function_privilege(r.oid,to_regprocedure(f.signature),'EXECUTE'))`;
async function assertPrincipal(
  tx: CurrentRuntimeInstallationTransaction,
  role: string,
  extra: string,
  values: { forbidden: readonly string[]; allowance: readonly TableGrant[]; others: string[] },
) {
  const observed = await tx.query(
    `SELECT ${plainPrincipalSql}
    AND ${v11TableAllowanceSql}
    AND ${disjointSql}
    ${forbiddenFunctionsSql}
    ${extra}
    AS safe FROM pg_roles r CROSS JOIN pg_roles o
    WHERE r.rolname=$1 AND o.rolname=session_user`,
    [
      role,
      [...currentRuntimeV11OwnerOnlyFunctions],
      [...currentRuntimeV11KnownLedgers],
      allowance(values.allowance),
      [...currentRuntimeV11Tables],
      values.others,
      [...values.forbidden],
    ],
  );
  if (observed.rows.length !== 1 || !roleObservationSchema.safeParse(observed.rows[0]).success)
    invalid('CURRENT_RUNTIME_V11_UNSAFE_ROLE');
}
async function observeRpcs(
  tx: CurrentRuntimeInstallationTransaction,
  pins: readonly {
    signature: string;
    prosrcSha256: string;
    language: string;
    result_type: string;
    security_definer: boolean;
    volatility: string;
    configuration: readonly string[];
  }[],
) {
  const observed = await tx.query(
    `SELECT i.ordinal::int AS ordinal,i.signature,
    p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owned,
    l.lanname AS language,format_type(p.prorettype,NULL) AS result_type,
    p.prosecdef AS security_definer,p.provolatile AS volatility,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source_sha256,
    CASE WHEN cardinality(p.proconfig) BETWEEN 1 AND 3
      AND NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE octet_length(setting)>128)
      THEN p.proconfig ELSE NULL END AS configuration,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
    ,NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable)) AS safe_delegation
    FROM unnest($1::text[]) WITH ORDINALITY i(signature,ordinal)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(i.signature)
    LEFT JOIN pg_language l ON l.oid=p.prolang ORDER BY i.ordinal`,
    [pins.map((p) => p.signature)],
  );
  const parsed = z.array(rpcObservationSchema).length(pins.length).safeParse(observed.rows);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V11_RPC_INVALID');
  for (const [index, rpc] of parsed.data.entries()) {
    const pin = pins[index];
    if (
      !pin ||
      rpc.ordinal !== index + 1 ||
      rpc.signature !== pin.signature ||
      rpc.language !== pin.language ||
      rpc.result_type !== pin.result_type ||
      rpc.security_definer !== pin.security_definer ||
      rpc.volatility !== pin.volatility ||
      rpc.source_sha256 !== pin.prosrcSha256 ||
      JSON.stringify(rpc.configuration) !== JSON.stringify(pin.configuration)
    )
      invalid('CURRENT_RUNTIME_V11_RPC_INVALID');
  }
}
async function grantTables(
  tx: CurrentRuntimeInstallationTransaction,
  role: string,
  grants: readonly TableGrant[],
) {
  // Module-owned table/privilege literals only; the role name is regex-checked.
  for (const grant of grants)
    await tx.query(`GRANT ${grant.privileges.join(',')} ON public.${grant.table} TO "${role}"`);
}
/** After granting: the principal holds exactly its functions and V11 table privileges. */
async function assertGranted(
  tx: CurrentRuntimeInstallationTransaction,
  role: string,
  functions: readonly string[],
  grants: readonly TableGrant[],
) {
  const observed = await tx.query(
    `SELECT (SELECT coalesce(bool_and(has_function_privilege($1,to_regprocedure(f),'EXECUTE')),true)
      FROM unnest($3::text[]) f) AS functions,
    (SELECT coalesce(bool_and(has_table_privilege($1,to_regclass('public.'||g.key),p.value)),true)
      FROM jsonb_each($2::jsonb) g CROSS JOIN LATERAL jsonb_array_elements_text(g.value) p) AS tables`,
    [role, allowance(grants), [...functions]],
  );
  if (observed.rows[0]?.['functions'] !== true || observed.rows[0]?.['tables'] !== true)
    invalid('CURRENT_RUNTIME_V11_GRANT_UNVERIFIED');
}
function outcome() {
  return {
    supported: false as const,
    processingAuthority: 'none' as const,
    catalogSecurity: 'not_verified' as const,
    restore: 'not_verified' as const,
  };
}

/** Deployment-owner transaction only. Verifies the exact installed profile27 first; this does
 * not install a missing profile or authorize processing. Caller owns BEGIN/COMMIT and must
 * roll back any exception. */
export async function grantCurrentRuntimeV11ProfileIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = checkedRole(unknownRuntimeRole);
  if (
    runtimeRole === currentRuntimeV11GalleryWorkerRole ||
    runtimeRole === currentRuntimeV11AiDispatcherRole
  )
    invalid('CURRENT_RUNTIME_V11_UNSAFE_ROLE');
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const installation = await verifyCurrentRuntimeV11InstalledIn(tx);
  await assertPrincipal(tx, runtimeRole, '', {
    forbidden: currentRuntimeV11WorkerRpcSignatures,
    allowance: currentRuntimeV11RuntimeTableGrants,
    others: [currentRuntimeV11GalleryWorkerRole, currentRuntimeV11AiDispatcherRole],
  });
  await observeRpcs(tx, currentRuntimeV11RpcSourcePins);
  for (const signature of currentRuntimeV11RpcSignatures)
    await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
  await grantTables(tx, runtimeRole, currentRuntimeV11RuntimeTableGrants);
  await assertGranted(
    tx,
    runtimeRole,
    currentRuntimeV11RpcSignatures,
    currentRuntimeV11RuntimeTableGrants,
  );
  return {
    installation,
    runtimeRole,
    grantedFunctions: currentRuntimeV11RpcSignatures,
    grantedTables: currentRuntimeV11RuntimeTableGrants,
    ...outcome(),
  };
}
// A worker/dispatcher holds no table or column privilege anywhere outside its allowance and
// executes no runtime RPC; it is a member of no role and has no members.
const isolatedPrincipalSql = `AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f','S')
        AND NOT (n.nspname='public' AND c.relname=ANY($5::text[]))
        AND (has_table_privilege(r.oid,c.oid,'${allPrivileges}')
          OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))`;
/** Gallery rendition worker (fixed name `workout_gallery_rendition_worker`): EXECUTE on the
 * five worker RPCs only. Refuses a role that holds a runtime RPC, any table privilege, the
 * dispatcher's privileges, or shares membership with the other principals. */
export async function grantCurrentRuntimeV11GalleryWorkerIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownWorkerRole: unknown,
) {
  const workerRole = fixedRole(unknownWorkerRole, currentRuntimeV11GalleryWorkerRole);
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const installation = await verifyCurrentRuntimeV11InstalledIn(tx);
  await assertPrincipal(tx, workerRole, isolatedPrincipalSql, {
    forbidden: currentRuntimeV11RpcSignatures,
    allowance: [],
    others: [currentRuntimeV11AiDispatcherRole],
  });
  await observeRpcs(
    tx,
    currentRuntimeV11WorkerRpcSignatures.map((signature) => {
      const pin = pinOf(signature);
      return {
        signature,
        prosrcSha256: pin.prosrcSha256,
        language: pin.language,
        result_type: pin.returns,
        security_definer: pin.securityDefiner,
        volatility: pin.volatility,
        configuration: ['search_path=pg_catalog, pg_temp'],
      };
    }),
  );
  for (const signature of currentRuntimeV11WorkerRpcSignatures)
    await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${workerRole}"`);
  await assertGranted(tx, workerRole, currentRuntimeV11WorkerRpcSignatures, []);
  return {
    installation,
    workerRole,
    grantedFunctions: currentRuntimeV11WorkerRpcSignatures,
    ...outcome(),
  };
}
/** M2-05b AI dispatcher (fixed name `workout_ai_dispatcher`, never created by product code):
 * SELECT/INSERT on ai_execution_job_disposition only. Same isolation as the worker. */
export async function grantCurrentRuntimeV11AiDispatcherIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownDispatcherRole: unknown,
) {
  const dispatcherRole = fixedRole(unknownDispatcherRole, currentRuntimeV11AiDispatcherRole);
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const installation = await verifyCurrentRuntimeV11InstalledIn(tx);
  await assertPrincipal(tx, dispatcherRole, isolatedPrincipalSql, {
    forbidden: [...currentRuntimeV11RpcSignatures, ...currentRuntimeV11WorkerRpcSignatures],
    allowance: currentRuntimeV11AiDispatcherTableGrants,
    others: [currentRuntimeV11GalleryWorkerRole],
  });
  await grantTables(tx, dispatcherRole, currentRuntimeV11AiDispatcherTableGrants);
  await assertGranted(tx, dispatcherRole, [], currentRuntimeV11AiDispatcherTableGrants);
  return {
    installation,
    dispatcherRole,
    grantedTables: currentRuntimeV11AiDispatcherTableGrants,
    ...outcome(),
  };
}
async function ownerTransaction<T>(
  connectionString: string,
  work: (tx: CurrentRuntimeInstallationTransaction) => Promise<T>,
) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  try {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  } finally {
    await pool.end();
  }
}
/** One atomic ACL transaction; normal107, profile26 and unreceipted raw staging fail closed.
 * No ownership transfer, schema USAGE or role creation is added. */
export async function grantCurrentRuntimeV11Profile(connectionString: string, runtimeRole: string) {
  checkedRole(runtimeRole);
  return ownerTransaction(connectionString, (tx) =>
    grantCurrentRuntimeV11ProfileIn(tx, runtimeRole),
  );
}
export async function grantCurrentRuntimeV11GalleryWorker(
  connectionString: string,
  workerRole: string,
) {
  fixedRole(workerRole, currentRuntimeV11GalleryWorkerRole);
  return ownerTransaction(connectionString, (tx) =>
    grantCurrentRuntimeV11GalleryWorkerIn(tx, workerRole),
  );
}
export async function grantCurrentRuntimeV11AiDispatcher(
  connectionString: string,
  dispatcherRole: string,
) {
  fixedRole(dispatcherRole, currentRuntimeV11AiDispatcherRole);
  return ownerTransaction(connectionString, (tx) =>
    grantCurrentRuntimeV11AiDispatcherIn(tx, dispatcherRole),
  );
}
