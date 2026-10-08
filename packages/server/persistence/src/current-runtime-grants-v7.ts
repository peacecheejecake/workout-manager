import { Pool } from 'pg';
import { z } from 'zod';
import { currentRuntimeV6RpcSourcePins as currentRuntimeV7ParentRpcSourcePins } from './current-runtime-grants-v6.js';
import { verifyCurrentRuntimeV7InstalledIn } from './current-runtime-installation-v7.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';

// Root actual metadata artifact SHA256
// 8cb77face39372df244a763741c9a1ce7045d277afff44ea0ef927c6934d8498.
// This witness is owner-observed parent22 + raw133, NOT a profile23 receipt.
// The verifier below separately requires the exact receipted V7 installation.
// Only the existing commit root changes; all other32 roots and ordering persist.
const indexedCommitSignature = 'public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)';
const indexedCommitSourceSha256 =
  '16b2dc4c79dec56d417f504d4c005034b2769fefc4249dc8244698c6593a75a6';
export const currentRuntimeV7RpcSourcePins = Object.freeze(
  currentRuntimeV7ParentRpcSourcePins.map((pin) =>
    Object.freeze({
      ...pin,
      prosrcSha256:
        pin.signature === indexedCommitSignature ? indexedCommitSourceSha256 : pin.prosrcSha256,
      configuration: Object.freeze([...pin.configuration]),
    }),
  ),
);
export const currentRuntimeV7RpcSignatures = Object.freeze(
  currentRuntimeV7RpcSourcePins.map((pin) => pin.signature),
);
export class CurrentRuntimeV7GrantError extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V7_INVALID_ROLE'
      | 'CURRENT_RUNTIME_V7_UNSAFE_ROLE'
      | 'CURRENT_RUNTIME_V7_RPC_INVALID',
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
function invalid(code: CurrentRuntimeV7GrantError['code']): never {
  throw new CurrentRuntimeV7GrantError(code);
}
function checkedRole(raw: unknown): string {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V7_INVALID_ROLE');
  return parsed.data;
}

/** Deployment-owner transaction only. The verifier reads exact installed
 * receipts; this does not install a missing profile or authorize processing.
 * Caller owns BEGIN/COMMIT and must roll back any exception. */
export async function grantCurrentRuntimeV7ProfileIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = checkedRole(unknownRuntimeRole);
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const installation = await verifyCurrentRuntimeV7InstalledIn(tx);
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
    AND NOT has_function_privilege(r.oid,'public.manual_source_personal_row_exists_v1(jsonb,jsonb)','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_proc helper CROSS JOIN LATERAL aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
      WHERE helper.oid='public.manual_source_personal_row_exists_v1(jsonb,jsonb)'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_class extension JOIN pg_namespace en ON en.oid=extension.relnamespace
      WHERE en.nspname='wm_runtime_installation' AND extension.relkind IN ('r','p','v','m','f','S')
        AND extension.relname NOT IN ('migration','profile_extension_v2','profile_extension_v3','profile_extension_v4','profile_extension_v5','profile_extension_v6','profile_extension_v7'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner=r.oid)
    AS safe FROM pg_roles r CROSS JOIN pg_roles o
    WHERE r.rolname=$1 AND o.rolname=session_user`,
    [runtimeRole],
  );
  if (role.rows.length !== 1 || !roleObservationSchema.safeParse(role.rows[0]).success)
    invalid('CURRENT_RUNTIME_V7_UNSAFE_ROLE');
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
    [[...currentRuntimeV7RpcSignatures]],
  );
  const parsed = z
    .array(rpcObservationSchema)
    .length(currentRuntimeV7RpcSignatures.length)
    .safeParse(observed.rows);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V7_RPC_INVALID');
  for (const [index, rpc] of parsed.data.entries()) {
    const pin = currentRuntimeV7RpcSourcePins[index];
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
      invalid('CURRENT_RUNTIME_V7_RPC_INVALID');
  }
  for (const signature of currentRuntimeV7RpcSignatures)
    await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
  return {
    installation,
    runtimeRole,
    grantedFunctions: currentRuntimeV7RpcSignatures,
    supported: false as const,
    processingAuthority: 'none' as const,
    catalogSecurity: 'not_verified' as const,
    restore: 'not_verified' as const,
  };
}

/** One atomic ACL transaction; normal107 and unreceipted raw staging fail
 * closed. No ownership transfer, table DML or schema USAGE is added. */
export async function grantCurrentRuntimeV7Profile(connectionString: string, runtimeRole: string) {
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
      const result = await grantCurrentRuntimeV7ProfileIn(client, runtimeRole);
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
