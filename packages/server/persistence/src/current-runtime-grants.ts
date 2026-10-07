import { Pool } from 'pg';
import { z } from 'zod';
import {
  verifyCurrentRuntimeInstalledIn,
  type CurrentRuntimeInstallationTransaction,
} from './current-runtime-installation.js';

// Only application RPCs absent from the baseline helpers. Table and private
// schema privileges remain the responsibility of their existing compositions.
// Fixed source witness collected by Root from plain-owner normal107 + exact17
// DDL, then rolled back and disposed. No caller-provided hashes are accepted.
const rpcSourcePins = [
  {
    signature: 'public.read_nutrition_disconnection_origin(uuid,uuid,text)',
    language: 'plpgsql',
    result_type: 'boolean',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '1290502cf800c1f9a1b4a06805f1116cff8b246c28e99f07137e8419edff5914',
  },
  {
    signature: 'public.commit_nutrition_plan_v4(uuid,uuid,jsonb,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: 'bb5eca0bd23f90cdf1ea082e229e95188b808ce1ff01a9c34c63cfaa72f257bd',
  },
  {
    signature: 'public.observe_manual_review_full_owned_source_bindings_v2(jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: false,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: '789b41a5e88437b29a39789168904e702de726a0043e6d6290bb5fe776d277bf',
  },
  {
    signature: 'public.observe_manual_review_multi_owned_source_bindings_v3(jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: false,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: '8ad144ad00ec7249774ce6c3eb9013dd005c51016f0ce257a4f5079a3537ffdf',
  },
  {
    signature:
      'public.store_manual_race_multi_owned_chain_v3(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: 'cebc600818ea852473d718006ba6f939cf81e7b56c1e7770dbed33f60d7a926b',
  },
  {
    signature: 'public.store_manual_race_chain_v2(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: '0538523f733a77b73733431a2cd0b836c65837c1ac437d0b1bb6fe9f39196598',
  },
  {
    signature: 'public.read_manual_race_chain_receipt_v2(text,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '25c44cb6d355baa884a7b8c0f5cb948b49cac9aada362e0eeb358b0565d0342f',
  },
  {
    signature: 'public.read_manual_race_chain_v2(uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: 'b943069f3995e9b582b916e862514ee44832ad413d58b937af55d7613c7dfec3',
  },
  {
    signature: 'public.prepare_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: 'b4233f19ebf6b7fd246d035fc2eab91d647b477c7e8d890a3a04039154ba46c3',
  },
  {
    signature: 'public.read_race_manual_application_v1(uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '7288e755131de361c8174e7189b9b1fbf1730f088eef77974649d563c1ec93ff',
  },
  {
    signature: 'public.read_race_manual_application_receipt_v1(text,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '0c44e9d3ee585ff0b7657edc1a6b50f238d327a293f14971fb7f79bad4cfa5b9',
  },
  {
    signature: 'public.begin_race_manual_application_v1(jsonb,jsonb,jsonb,jsonb)',
    language: 'plpgsql',
    result_type: 'uuid',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: '28eb84586bb440eded89e32eff810a46ebbc32d6ece78e136b60007721009458',
  },
  {
    signature: 'public.apply_race_manual_event_v1(uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: 'eb75bbd76d662d58118a0001235cbaf6de5a4fc4feccd71a83cb6a7279fdecc5',
  },
  {
    signature: 'public.race_manual_nutrition_affected_items_v1(uuid,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: '8d2a2a01c27745f8e04af675391e2f449aefc85ef7d991df398a453b3adff1e4',
  },
  {
    signature: 'public.race_manual_nutrition_preserved_items_v1(uuid,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '1479a781cff9299ec20580dc1f009b895d79cf0605f60883653d604bd34e897e',
  },
  {
    signature: 'public.commit_race_manual_application_v1(uuid,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '501cf800295e8f9e9b86e6a2c26fe5bc43628e18841bc44af0b6f9e89553df13',
  },
  {
    signature: 'public.read_race_manual_public_receipt_v1(text,text,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '93b03ec222ea36481df7173564fd428f7e4bc44807ec804a53a8d6d648f6550f',
  },
  {
    signature: 'public.finish_race_manual_public_review_v1(text,jsonb,uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '4f6abd28b10f2277c08ac8591396bb62bcec406cf50efb7a6d33652b8acf8f74',
  },
  {
    signature: 'public.read_race_manual_public_approval_v1(text,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '1eb80ea49c43f002ef1462ebf52123a8151c3ee6cece04994b2c66f5d29f0868',
  },
  {
    signature: 'public.finish_race_manual_public_approval_v1(text,jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '343525fb6faee80e32580cccb394194a9ed7e84c5744e55dfc4843da76e26d6e',
  },
  {
    signature: 'public.read_race_manual_public_candidate_v1(uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '176cbc8b0a4ce3bbae6600eab337e5bc66113fe9303f8c83fe71d4392cec5e27',
  },
  {
    signature: 'public.read_race_manual_public_preview_source_v1(uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '77e6134fa464199e777535d516aada85e0f4f427f741946aae9a0157f04adc78',
  },
  {
    signature: 'public.save_check_in_template_v1(jsonb)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO,YMD'],
    prosrcSha256: '22b787deb599d7c2df67a9f8547594a0196d6b63f5382ca90228c2b5fd46ba39',
  },
  {
    signature: 'public.read_check_in_template_version_v1(uuid,uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '4d30db43065907e5eeba899052419899f7399f81a4d76852baec91c3952c304e',
  },
  {
    signature: 'public.read_check_in_template_head_v1(uuid)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: '263dd8d8b3e0c4419521310af5c275486588ae5b3076a6b05773ce255e93dd50',
  },
  {
    signature: 'public.list_check_in_template_heads_v1(integer,integer)',
    language: 'plpgsql',
    result_type: 'jsonb',
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, pg_temp'],
    prosrcSha256: 'b71b2e2459793fbfc7dadabe2d4ccafc177062c7bed218450faa4b851ed545d4',
  },
] as const;
export const currentRuntimeRpcSourcePins = Object.freeze(
  rpcSourcePins.map((pin) =>
    Object.freeze({ ...pin, configuration: Object.freeze([...pin.configuration]) }),
  ),
);
export const currentRuntimeRpcSignatures = Object.freeze(
  currentRuntimeRpcSourcePins.map((pin) => pin.signature),
);
export class CurrentRuntimeGrantError extends Error {
  constructor(
    readonly code:
      | 'CURRENT_RUNTIME_INVALID_ROLE'
      | 'CURRENT_RUNTIME_UNSAFE_ROLE'
      | 'CURRENT_RUNTIME_RPC_INVALID',
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
  configuration: z.array(z.string().max(128)).min(1).max(3),
});
function invalid(code: CurrentRuntimeGrantError['code']): never {
  throw new CurrentRuntimeGrantError(code);
}
function checkedRole(raw: unknown): string {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) invalid('CURRENT_RUNTIME_INVALID_ROLE');
  return parsed.data;
}

/** Deployment-owner transaction only. The verifier reads exact installed
 * receipts; this does not install a missing profile or authorize processing.
 * Caller owns BEGIN/COMMIT and must roll back any exception. */
export async function grantCurrentRuntimeProfileIn(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = checkedRole(unknownRuntimeRole);
  await tx.query('SELECT pg_advisory_xact_lock(872194,1)');
  await tx.query('SELECT pg_advisory_xact_lock(77210,1)');
  const installation = await verifyCurrentRuntimeInstalledIn(tx);
  const role = await tx.query(
    `SELECT
    NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
    AND r.oid<>o.oid AND NOT pg_has_role(r.oid,o.oid,'MEMBER')
    AND NOT EXISTS(SELECT 1 FROM pg_roles elevated WHERE
      (elevated.rolsuper OR elevated.rolbypassrls) AND pg_has_role(r.oid,elevated.oid,'MEMBER'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.proowner=r.oid)
    AS safe FROM pg_roles r CROSS JOIN pg_roles o
    WHERE r.rolname=$1 AND o.rolname=session_user`,
    [runtimeRole],
  );
  if (role.rows.length !== 1 || !roleObservationSchema.safeParse(role.rows[0]).success)
    invalid('CURRENT_RUNTIME_UNSAFE_ROLE');
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
    FROM unnest($1::text[]) WITH ORDINALITY i(signature,ordinal)
    LEFT JOIN pg_proc p ON p.oid=to_regprocedure(i.signature)
    LEFT JOIN pg_language l ON l.oid=p.prolang ORDER BY i.ordinal`,
    [[...currentRuntimeRpcSignatures]],
  );
  const parsed = z
    .array(rpcObservationSchema)
    .length(currentRuntimeRpcSignatures.length)
    .safeParse(observed.rows);
  if (!parsed.success) invalid('CURRENT_RUNTIME_RPC_INVALID');
  for (const [index, rpc] of parsed.data.entries()) {
    const pin = currentRuntimeRpcSourcePins[index];
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
      invalid('CURRENT_RUNTIME_RPC_INVALID');
  }
  for (const signature of currentRuntimeRpcSignatures)
    await tx.query(`GRANT EXECUTE ON FUNCTION ${signature} TO "${runtimeRole}"`);
  return {
    installation,
    runtimeRole,
    grantedFunctions: currentRuntimeRpcSignatures,
    processingAuthority: 'none' as const,
    catalogSecurity: 'not_verified' as const,
    restore: 'not_verified' as const,
  };
}

/** One atomic ACL transaction; normal107 and unreceipted raw staging fail
 * closed. No ownership transfer, table DML or schema USAGE is added. */
export async function grantCurrentRuntimeProfile(connectionString: string, runtimeRole: string) {
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
    try {
      await client.query('BEGIN');
      const result = await grantCurrentRuntimeProfileIn(client, runtimeRole);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
