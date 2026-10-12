import { Pool } from 'pg';
import { z } from 'zod';
import { currentRuntimeV7RpcSourcePins } from './current-runtime-grants-v7.js';
import {
  verifyCurrentRuntimeV10InstalledIn,
  currentRuntimeV10FunctionPins,
  currentRuntimeV10GuardFunctionSignature,
  currentRuntimeV10KnownLedgers,
} from './current-runtime-installation-v10.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';

// Profile26 (physical V10, source tip 146). 146 adds only an owner-only trigger
// function, so the runtime root roster stays the exact post142 42 and the
// owner-only/private helper roster stays 17. The guard is neither root nor helper:
// it must stay unexecutable by the runtime role and is checked separately.
const pooledDirectSignatures = Object.freeze([
  'public.store_manual_race_pooled_chain_v1(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
  'public.read_manual_race_pooled_chain_v1(uuid)',
  'public.ack_manual_race_pooled_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)',
  'public.prepare_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
  'public.begin_race_manual_pooled_application_v1(jsonb,jsonb,jsonb,jsonb)',
  'public.finish_race_manual_pooled_public_review_v1(text,jsonb,uuid)',
  'public.read_race_manual_pooled_public_preview_source_v1(uuid)',
  'public.read_manual_race_pooled_personal_export_batch_v1(integer)',
  'public.read_manual_race_pooled_parent_delta_v1(uuid,jsonb)',
] as const);
export const currentRuntimeV10OwnerOnlyPublicHelpers = Object.freeze([
  'public.validate_race_manual_pooled_application_basis_v1(jsonb,jsonb,jsonb)',
  'public.race_manual_pooled_relative_membership_v1(jsonb)',
  'public.race_manual_pooled_routine_expansion_v1(jsonb,jsonb,jsonb,text)',
  'public.race_manual_pooled_validate_recipes_v1(jsonb,jsonb)',
] as const);
export const currentRuntimeV10PrivateHelpers = Object.freeze([
  'wm_manual_pooled.assert_owner()',
  'wm_manual_pooled.exact_keys(jsonb,text[])',
  'wm_manual_pooled.path_parts(text,boolean)',
  'wm_manual_pooled.at_exact(jsonb,text[])',
  'wm_manual_pooled.check_encoded(jsonb)',
  'wm_manual_pooled.lookup(jsonb,text)',
  'wm_manual_pooled.read_internal_export_v2(integer)',
  'wm_manual_pooled.read_public_export_metadata_v2(integer)',
  'wm_manual_pooled.lookup_validated_local(jsonb,text)',
  'wm_manual_pooled.relative_membership_validated_local_v1(jsonb)',
  'wm_manual_pooled.routine_expansion_validated_local_v1(jsonb,jsonb,jsonb,text)',
  'wm_manual_pooled.validate_recipes_validated_local_v1(jsonb,jsonb)',
  'wm_manual_pooled.parent_delta_node_v1(jsonb,jsonb,integer,integer)',
] as const);
/** Owner-only trigger functions added by 146. Never granted; runtime EXECUTE refused. */
export const currentRuntimeV10TriggerFunctions = Object.freeze([
  currentRuntimeV10GuardFunctionSignature,
] as const);
function pooledPins() {
  const direct = currentRuntimeV10FunctionPins.filter((pin) => pin.runtimeDirect);
  const helpers = currentRuntimeV10FunctionPins.filter(
    (pin) =>
      !pin.runtimeDirect &&
      !(currentRuntimeV10TriggerFunctions as readonly string[]).includes(pin.signature),
  );
  const triggers = currentRuntimeV10FunctionPins.filter((pin) =>
    (currentRuntimeV10TriggerFunctions as readonly string[]).includes(pin.signature),
  );
  if (
    direct.length !== 9 ||
    direct.some((pin, i) => pin.signature !== pooledDirectSignatures[i]) ||
    helpers.length !== 17 ||
    triggers.length !== 1 ||
    triggers.some((pin) => pin.runtimeDirect || pin.metadata.prosecdef) ||
    new Set(currentRuntimeV10FunctionPins.map((p) => p.signature)).size !== 27 ||
    [...currentRuntimeV10OwnerOnlyPublicHelpers, ...currentRuntimeV10PrivateHelpers].some(
      (signature) => !helpers.some((p) => p.signature === signature),
    )
  )
    throw new Error('CURRENT_RUNTIME_V10_COMPILED_ROSTER_INVALID');
  if (direct.some((pin) => !['2950', '3802'].includes(pin.metadata.prorettype)))
    throw new Error('CURRENT_RUNTIME_V10_COMPILED_ROSTER_INVALID');
  return direct.map((pin) =>
    Object.freeze({
      signature: pin.signature,
      prosrcSha256: pin.prosrcSha256,
      language: pin.language,
      result_type: pin.metadata.prorettype === '2950' ? ('uuid' as const) : ('jsonb' as const),
      security_definer: pin.metadata.prosecdef,
      volatility: pin.metadata.provolatile,
      configuration: Object.freeze([...pin.metadata.proconfig]),
    }),
  );
}
export const currentRuntimeV10RpcSourcePins = Object.freeze([
  ...currentRuntimeV7RpcSourcePins,
  ...pooledPins(),
]);
export const currentRuntimeV10RpcSignatures = Object.freeze(
  currentRuntimeV10RpcSourcePins.map((pin) => pin.signature),
);
export class CurrentRuntimeV10GrantError extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V10_INVALID_ROLE'
      | 'CURRENT_RUNTIME_V10_UNSAFE_ROLE'
      | 'CURRENT_RUNTIME_V10_RPC_INVALID',
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
  language: z.literal('plpgsql'),
  result_type: z.enum(['jsonb', 'boolean', 'uuid']),
  security_definer: z.boolean(),
  volatility: z.enum(['i', 's', 'v']),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  public_execute: z.literal(false),
  safe_delegation: z.literal(true),
  configuration: z.array(z.string().max(128)).min(1).max(3),
});
function invalid(code: CurrentRuntimeV10GrantError['code']): never {
  throw new CurrentRuntimeV10GrantError(code);
}
function checkedRole(raw: unknown): string {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V10_INVALID_ROLE');
  return parsed.data;
}

/** Deployment-owner transaction only. The verifier reads exact installed
 * receipts; this does not install a missing profile or authorize processing.
 * Caller owns BEGIN/COMMIT and must roll back any exception. */
export async function grantCurrentRuntimeV10ProfileIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = checkedRole(unknownRuntimeRole);
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const installation = await verifyCurrentRuntimeV10InstalledIn(tx);
  const role = await tx.query(
    `SELECT
    NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
    AND r.oid<>o.oid AND NOT pg_has_role(r.oid,o.oid,'MEMBER')
    AND NOT EXISTS(SELECT 1 FROM pg_roles elevated WHERE
      (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolname LIKE 'pg_%') AND pg_has_role(r.oid,elevated.oid,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege(r.oid,n.oid,'CREATE'))
    AND NOT has_schema_privilege(r.oid,'wm_runtime_installation','USAGE,CREATE')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.migration','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v2','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v3','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v4','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v5','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v6','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v7','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v8','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v9','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_table_privilege(r.oid,'wm_runtime_installation.profile_extension_v10','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT has_function_privilege(r.oid,'public.manual_source_personal_row_exists_v1(jsonb,jsonb)','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_proc helper CROSS JOIN LATERAL aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
      WHERE helper.oid='public.manual_source_personal_row_exists_v1(jsonb,jsonb)'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_class extension JOIN pg_namespace en ON en.oid=extension.relnamespace
      WHERE en.nspname='wm_runtime_installation' AND extension.relkind IN ('r','p','v','m','f','S')
        AND extension.relname<>ALL($3::text[]))
    AND NOT has_schema_privilege(r.oid,'wm_manual_pooled','USAGE,CREATE')
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('wm_runtime_installation','wm_manual_pooled') AND c.relkind IN ('r','p','v','m','f')
      AND (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) i(signature)
      WHERE has_function_privilege(r.oid,to_regprocedure(i.signature),'EXECUTE'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc h CROSS JOIN LATERAL aclexplode(coalesce(h.proacl,acldefault('f',h.proowner))) a
      WHERE h.oid IN (SELECT to_regprocedure(signature) FROM unnest($2::text[]) i(signature))
      AND a.grantee<>h.proowner)
    AND NOT has_function_privilege(r.oid,'public.finish_resource_object_cleanup(uuid,uuid,boolean,text,timestamptz)','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner=r.oid)
    AS safe FROM pg_roles r CROSS JOIN pg_roles o
    WHERE r.rolname=$1 AND o.rolname=session_user`,
    [
      runtimeRole,
      [
        ...currentRuntimeV10OwnerOnlyPublicHelpers,
        ...currentRuntimeV10PrivateHelpers,
        ...currentRuntimeV10TriggerFunctions,
      ],
      [...currentRuntimeV10KnownLedgers],
    ],
  );
  if (role.rows.length !== 1 || !roleObservationSchema.safeParse(role.rows[0]).success)
    invalid('CURRENT_RUNTIME_V10_UNSAFE_ROLE');
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
    [[...currentRuntimeV10RpcSignatures]],
  );
  const parsed = z
    .array(rpcObservationSchema)
    .length(currentRuntimeV10RpcSignatures.length)
    .safeParse(observed.rows);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V10_RPC_INVALID');
  for (const [index, rpc] of parsed.data.entries()) {
    const pin = currentRuntimeV10RpcSourcePins[index];
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
      invalid('CURRENT_RUNTIME_V10_RPC_INVALID');
  }
  for (const signature of currentRuntimeV10RpcSignatures)
    await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
  return {
    installation,
    runtimeRole,
    grantedFunctions: currentRuntimeV10RpcSignatures,
    supported: false as const,
    processingAuthority: 'none' as const,
    catalogSecurity: 'not_verified' as const,
    restore: 'not_verified' as const,
  };
}

/** One atomic ACL transaction; normal107 and unreceipted raw staging fail
 * closed. No ownership transfer, table DML or schema USAGE is added. */
export async function grantCurrentRuntimeV10Profile(connectionString: string, runtimeRole: string) {
  checkedRole(runtimeRole);
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    query_timeout: 12000,
  });
  try {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      const result = await grantCurrentRuntimeV10ProfileIn(client, runtimeRole);
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
