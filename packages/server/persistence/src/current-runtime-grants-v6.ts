import { Pool } from 'pg';
import { z } from 'zod';
import { currentRuntimeV5RpcSourcePins } from './current-runtime-grants-v5.js';
import { verifyCurrentRuntimeV6InstalledIn } from './current-runtime-installation-v6.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';

// Independently Root-observed final33 owner metadata, source artifact SHA256
// 25fee4ba6e14b263528dbb2d2d8ee0b1da700badcc982aac35f18b6dd4ab6f45.
// The first32 pins are imported unchanged; no caller-provided pin is accepted.
// These roots do not attest transitive guards, whole catalog, or processing.
const additions = [
  {
    signature: 'public.read_manual_race_retained_source_batch_v1(integer)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: '041207534eaf528741327a022e5d005e733b48d5738dcb1a717578e79d1998eb',
  },
] as const;
export const currentRuntimeV6RpcSourcePins = Object.freeze(
  [...currentRuntimeV5RpcSourcePins, ...additions].map((pin) =>
    Object.freeze({ ...pin, configuration: Object.freeze([...pin.configuration]) }),
  ),
);
export const currentRuntimeV6RpcSignatures = Object.freeze(
  currentRuntimeV6RpcSourcePins.map((pin) => pin.signature),
);
export class CurrentRuntimeV6GrantError extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_V6_INVALID_ROLE'
      | 'CURRENT_RUNTIME_V6_UNSAFE_ROLE'
      | 'CURRENT_RUNTIME_V6_RPC_INVALID',
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
function invalid(code: CurrentRuntimeV6GrantError['code']): never {
  throw new CurrentRuntimeV6GrantError(code);
}
function checkedRole(raw: unknown): string {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V6_INVALID_ROLE');
  return parsed.data;
}

/** Deployment-owner transaction only. The verifier reads exact installed
 * receipts; this does not install a missing profile or authorize processing.
 * Caller owns BEGIN/COMMIT and must roll back any exception. */
export async function grantCurrentRuntimeV6ProfileIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = checkedRole(unknownRuntimeRole);
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const installation = await verifyCurrentRuntimeV6InstalledIn(tx);
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
    AND NOT has_function_privilege(r.oid,'public.manual_source_personal_row_exists_v1(jsonb,jsonb)','EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_proc helper CROSS JOIN LATERAL aclexplode(coalesce(helper.proacl,acldefault('f',helper.proowner))) a
      WHERE helper.oid='public.manual_source_personal_row_exists_v1(jsonb,jsonb)'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE')
    AND NOT EXISTS(SELECT 1 FROM pg_class extension JOIN pg_namespace en ON en.oid=extension.relnamespace
      WHERE en.nspname='wm_runtime_installation' AND extension.relkind IN ('r','p','v','m','f','S')
        AND extension.relname NOT IN ('migration','profile_extension_v2','profile_extension_v3','profile_extension_v4','profile_extension_v5','profile_extension_v6'))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner=r.oid)
    AS safe FROM pg_roles r CROSS JOIN pg_roles o
    WHERE r.rolname=$1 AND o.rolname=session_user`,
    [runtimeRole],
  );
  if (role.rows.length !== 1 || !roleObservationSchema.safeParse(role.rows[0]).success)
    invalid('CURRENT_RUNTIME_V6_UNSAFE_ROLE');
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
    [[...currentRuntimeV6RpcSignatures]],
  );
  const parsed = z
    .array(rpcObservationSchema)
    .length(currentRuntimeV6RpcSignatures.length)
    .safeParse(observed.rows);
  if (!parsed.success) invalid('CURRENT_RUNTIME_V6_RPC_INVALID');
  for (const [index, rpc] of parsed.data.entries()) {
    const pin = currentRuntimeV6RpcSourcePins[index];
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
      invalid('CURRENT_RUNTIME_V6_RPC_INVALID');
  }
  for (const signature of currentRuntimeV6RpcSignatures)
    await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
  return {
    installation,
    runtimeRole,
    grantedFunctions: currentRuntimeV6RpcSignatures,
    supported: false as const,
    processingAuthority: 'none' as const,
    catalogSecurity: 'not_verified' as const,
    restore: 'not_verified' as const,
  };
}

/** One atomic ACL transaction; normal107 and unreceipted raw staging fail
 * closed. No ownership transfer, table DML or schema USAGE is added. */
export async function grantCurrentRuntimeV6Profile(connectionString: string, runtimeRole: string) {
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
      const result = await grantCurrentRuntimeV6ProfileIn(client, runtimeRole);
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
