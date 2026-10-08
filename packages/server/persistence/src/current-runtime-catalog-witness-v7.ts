import { z } from 'zod';
import {
  boundedPlain,
  canonical,
  CurrentRuntimeCatalogWitnessError,
} from './current-runtime-catalog-witness.js';
import {
  buildCurrentRuntimeCatalogWitnessV6,
  parseCurrentRuntimeCatalogWitnessV6,
} from './current-runtime-catalog-witness-v6.js';
import { currentRuntimeCatalogMetadataQueryV3 } from './current-runtime-catalog-witness-v3.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';
import {
  currentRuntimeV7ExtensionMember,
  verifyCurrentRuntimeV7InstalledIn,
} from './current-runtime-installation-v7.js';
import {
  currentRuntimeV7RpcSourcePins,
  currentRuntimeV7RpcSignatures,
} from './current-runtime-grants-v7.js';
const rpcRecipe = Object.freeze({
  recipeVersion: 7 as const,
  name: 'current-runtime-grants-v7' as const,
  rootCount: 33 as const,
  signatures: currentRuntimeV7RpcSignatures,
  grantSourceSha256: 'c9d789e3c178544784c898d0d027a006284e43be15df313230be17dd10088be6',
  metadataArtifactSha256: '8cb77face39372df244a763741c9a1ce7045d277afff44ea0ef927c6934d8498',
});
const MAX_BYTES = 16 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function fail(code: CurrentRuntimeCatalogWitnessError['code']): never {
  throw new CurrentRuntimeCatalogWitnessError(code);
}
/** Same V3 whole metadata encoding. Profile23 observation is no support seal. The pinned metadata artifact
 * observes parent22 + raw133 only; exact V7 receipts are verified separately. */
export function buildCurrentRuntimeCatalogWitnessV7(raw: unknown) {
  const prior = buildCurrentRuntimeCatalogWitnessV6(raw);
  const artifact = {
    ...prior,
    witnessVersion: 7 as const,
    rpcRecipe,
    profile: {
      ...prior.profile,
      profileVersion: 7 as const,
      runtimeStep: 23 as const,
      sourceDdlTip: 133 as const,
      runtimeSteps: [
        ...prior.profile.runtimeSteps,
        {
          step: 23,
          sourceDdlId: currentRuntimeV7ExtensionMember.sourceDdlId,
          filename: currentRuntimeV7ExtensionMember.filename,
          sha256: currentRuntimeV7ExtensionMember.sha256,
        },
      ],
    },
  };
  boundedPlain(artifact);
  return artifact;
}
export type CurrentRuntimeCatalogWitnessV7 = ReturnType<typeof buildCurrentRuntimeCatalogWitnessV7>;
const observationSchema = z.strictObject({
  clusterRoleCount: z.number().int().min(2).max(10000),
  metadataBytes: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .refine((v) => BigInt(v) <= BigInt(MAX_BYTES)),
  sqlJsonbSha256: hash,
  expectedRootCount: z.literal(33),
});
/** Pure structure/checksum verification, never authenticates caller expectations. */
export function parseCurrentRuntimeCatalogWitnessV7(
  raw: unknown,
): CurrentRuntimeCatalogWitnessV7 & { observation?: z.infer<typeof observationSchema> } {
  boundedPlain(raw);
  const shell = z
    .object({
      witnessVersion: z.literal(7),
      profile: z.unknown(),
      rpcRecipe: z.unknown(),
      metadata: z.unknown(),
      observation: observationSchema.optional(),
    })
    .safeParse(raw);
  if (!shell.success) fail('CATALOG_WITNESS_INVALID');
  const expected = buildCurrentRuntimeCatalogWitnessV7(shell.data.metadata);
  if (JSON.stringify(canonical(shell.data.profile)) !== JSON.stringify(canonical(expected.profile)))
    fail('CATALOG_WITNESS_INVALID');
  if (JSON.stringify(canonical(shell.data.rpcRecipe)) !== JSON.stringify(canonical(rpcRecipe)))
    fail('CATALOG_WITNESS_INVALID');
  const prior = buildCurrentRuntimeCatalogWitnessV6(shell.data.metadata);
  // Delegate exact finite body fields, section hashes, namespaces and V3 encoding limits.
  const parsed = z.record(z.string(), z.unknown()).parse(raw);
  const { rpcRecipe: declaredRecipe, ...priorFields } = parsed;
  void declaredRecipe;
  parseCurrentRuntimeCatalogWitnessV6({
    ...priorFields,
    witnessVersion: 6,
    profile: prior.profile,
    rpcRecipe: prior.rpcRecipe,
    ...(shell.data.observation
      ? { observation: { ...shell.data.observation, expectedRootCount: 33 } }
      : {}),
  });
  return shell.data.observation ? { ...expected, observation: shell.data.observation } : expected;
}
/** Owner RR READ ONLY observation only; no body text, health rows or private RPC. */
export async function captureCurrentRuntimeCatalogWitnessV7In(
  tx: CurrentRuntimeInstallationTransaction,
  unknownRuntimeRole: unknown,
) {
  const runtimeRole = z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .safeParse(unknownRuntimeRole);
  if (!runtimeRole.success) fail('CATALOG_WITNESS_INVALID');
  const context = await tx.query(
    `SELECT current_user=session_user AND NOT o.rolsuper AND NOT o.rolbypassrls AS owner,
 r.oid<>o.oid AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND NOT pg_has_role(r.oid,o.oid,'MEMBER') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR left(e.rolname,3)='pg_') AND pg_has_role(r.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid) AS runtime,
 h.oid IS NOT NULL AND NOT has_function_privilege(r.oid,h.oid,'EXECUTE') AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(h.proacl,acldefault('f',h.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS "privateHelper",
 current_setting('transaction_read_only')='on' AS "readOnly",current_setting('search_path') IN('pg_catalog,pg_temp','pg_catalog, pg_temp') AS "pathSafe",current_setting('transaction_isolation') AS isolation,(SELECT count(*)::int FROM pg_catalog.pg_roles) AS "roleCount",
 EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=872194 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=77210 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AS "locksHeld"
 FROM pg_catalog.pg_roles o CROSS JOIN pg_catalog.pg_roles r LEFT JOIN pg_catalog.pg_proc h ON h.oid=to_regprocedure('public.manual_source_personal_row_exists_v1(jsonb,jsonb)') WHERE o.rolname=session_user AND r.rolname=$1`,
    [runtimeRole.data],
  );
  boundedPlain(context.rows);
  const ctx = z
    .strictObject({
      owner: z.literal(true),
      privateHelper: z.literal(true),
      locksHeld: z.literal(true),
      runtime: z.literal(true),
      readOnly: z.literal(true),
      pathSafe: z.literal(true),
      isolation: z.enum(['repeatable read', 'serializable']),
      roleCount: z.number().int().min(2).max(10000),
    })
    .safeParse(context.rows[0]);
  if (context.rows.length !== 1 || !ctx.success) fail('CATALOG_WITNESS_CONTEXT_REQUIRED');
  await verifyCurrentRuntimeV7InstalledIn(tx);
  await verifyRecipe(tx, runtimeRole.data);
  const counts = await tx.query(`SELECT
 (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE pronamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) functions,
 (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) relations,
 (SELECT count(*)::int FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) types,
 (SELECT coalesce(max(octet_length(prosrc)),0)::int FROM pg_catalog.pg_proc) "maxSourceBytes"`);
  boundedPlain(counts.rows);
  const countSchema = z.strictObject({
    functions: z.number().int().min(33).max(5000),
    relations: z.number().int().min(23).max(5000),
    types: z.number().int().min(0).max(5000),
    maxSourceBytes: z.number().int().min(0).max(2097152),
  });
  if (counts.rows.length !== 1 || !countSchema.safeParse(counts.rows[0]).success)
    fail('CATALOG_WITNESS_LIMIT');
  // One materialized catalog body per capture. SQL computes scalar evidence
  // before conditionally returning metadata; oversized bodies never leave PG.
  await tx.query("SET LOCAL statement_timeout='30000ms'");
  const observed = await tx.query(
    `${currentRuntimeCatalogMetadataQueryV3}, measured AS MATERIALIZED (SELECT body,octet_length(body::text) bytes,encode(sha256(convert_to(body::text,'UTF8')),'hex') sha256 FROM enriched)
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
  const witness = buildCurrentRuntimeCatalogWitnessV7(raw);
  return {
    ...witness,
    observation: {
      clusterRoleCount: ctx.data.roleCount,
      metadataBytes: envelope.data.bytes,
      sqlJsonbSha256: envelope.data.sha256,
      expectedRootCount: 33,
    },
  };
}

const rpcObservationSchema = z.strictObject({
  ordinal: z.number().int().positive(),
  signature: z.string(),
  owned: z.literal(true),
  language: z.literal('plpgsql'),
  result_type: z.enum(['jsonb', 'boolean', 'uuid']),
  security_definer: z.boolean(),
  volatility: z.enum(['i', 's', 'v']),
  source_sha256: hash,
  configuration: z.array(z.string().max(128)).min(1).max(3),
  runtime_execute: z.literal(true),
  public_execute: z.literal(false),
  safe_delegation: z.literal(true),
});
async function verifyRecipe(tx: CurrentRuntimeInstallationTransaction, runtimeRole: string) {
  const result = await tx.query(
    `SELECT i.ordinal::int AS ordinal,i.signature,p.proowner=(SELECT oid FROM pg_roles WHERE rolname=session_user) AS owned,l.lanname AS language,format_type(p.prorettype,NULL) AS result_type,p.prosecdef AS security_definer,p.provolatile AS volatility,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS source_sha256,
 CASE WHEN cardinality(p.proconfig) BETWEEN 1 AND 3 AND NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) setting WHERE octet_length(setting)>128) THEN p.proconfig ELSE NULL END AS configuration,
 has_function_privilege($2,p.oid,'EXECUTE') AS runtime_execute,
 EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
 NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable)) AS safe_delegation
 FROM unnest($1::text[]) WITH ORDINALITY i(signature,ordinal) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(i.signature) LEFT JOIN pg_language l ON l.oid=p.prolang ORDER BY i.ordinal`,
    [[...currentRuntimeV7RpcSignatures], runtimeRole],
  );
  boundedPlain(result.rows);
  const observed = z.array(rpcObservationSchema).length(33).safeParse(result.rows);
  if (!observed.success) fail('CATALOG_WITNESS_INVALID');
  for (const [i, r] of observed.data.entries()) {
    const expected = currentRuntimeV7RpcSourcePins[i];
    if (
      !expected ||
      r.ordinal !== i + 1 ||
      r.signature !== expected.signature ||
      r.language !== expected.language ||
      r.result_type !== expected.result_type ||
      r.security_definer !== expected.security_definer ||
      r.volatility !== expected.volatility ||
      r.source_sha256 !== expected.prosrcSha256 ||
      JSON.stringify(r.configuration) !== JSON.stringify(expected.configuration)
    )
      fail('CATALOG_WITNESS_INVALID');
  }
}
