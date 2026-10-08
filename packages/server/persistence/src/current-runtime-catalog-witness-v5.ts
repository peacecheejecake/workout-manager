import { z } from 'zod';
import {
  boundedPlain,
  canonical,
  CurrentRuntimeCatalogWitnessError,
} from './current-runtime-catalog-witness.js';
import {
  buildCurrentRuntimeCatalogWitnessV4,
  parseCurrentRuntimeCatalogWitnessV4,
} from './current-runtime-catalog-witness-v4.js';
import { currentRuntimeCatalogMetadataQueryV3 } from './current-runtime-catalog-witness-v3.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';
import {
  currentRuntimeV5ExtensionMember,
  verifyCurrentRuntimeV5InstalledIn,
} from './current-runtime-installation-v5.js';
const MAX_BYTES = 16 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function fail(code: CurrentRuntimeCatalogWitnessError['code']): never {
  throw new CurrentRuntimeCatalogWitnessError(code);
}
/** Same V3 whole metadata encoding. Profile21 observation is no support seal. */
export function buildCurrentRuntimeCatalogWitnessV5(raw: unknown) {
  const prior = buildCurrentRuntimeCatalogWitnessV4(raw);
  const artifact = {
    ...prior,
    witnessVersion: 5 as const,
    profile: {
      ...prior.profile,
      profileVersion: 5 as const,
      runtimeStep: 21 as const,
      sourceDdlTip: 131 as const,
      runtimeSteps: [
        ...prior.profile.runtimeSteps,
        {
          step: 21,
          sourceDdlId: currentRuntimeV5ExtensionMember.sourceDdlId,
          filename: currentRuntimeV5ExtensionMember.filename,
          sha256: currentRuntimeV5ExtensionMember.sha256,
        },
      ],
    },
  };
  boundedPlain(artifact);
  return artifact;
}
export type CurrentRuntimeCatalogWitnessV5 = ReturnType<typeof buildCurrentRuntimeCatalogWitnessV5>;
const observationSchema = z.strictObject({
  clusterRoleCount: z.number().int().min(2).max(10000),
  metadataBytes: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .refine((v) => BigInt(v) <= BigInt(MAX_BYTES)),
  sqlJsonbSha256: hash,
  expectedRootCount: z.literal(32),
});
/** Pure structure/checksum verification, never authenticates caller expectations. */
export function parseCurrentRuntimeCatalogWitnessV5(
  raw: unknown,
): CurrentRuntimeCatalogWitnessV5 & { observation?: z.infer<typeof observationSchema> } {
  boundedPlain(raw);
  const shell = z
    .object({
      witnessVersion: z.literal(5),
      profile: z.unknown(),
      metadata: z.unknown(),
      observation: observationSchema.optional(),
    })
    .safeParse(raw);
  if (!shell.success) fail('CATALOG_WITNESS_INVALID');
  const expected = buildCurrentRuntimeCatalogWitnessV5(shell.data.metadata);
  if (JSON.stringify(canonical(shell.data.profile)) !== JSON.stringify(canonical(expected.profile)))
    fail('CATALOG_WITNESS_INVALID');
  const prior = buildCurrentRuntimeCatalogWitnessV4(shell.data.metadata);
  // Delegate exact finite body fields, section hashes, namespaces and V3 encoding limits.
  const parsed = z.record(z.string(), z.unknown()).parse(raw);
  parseCurrentRuntimeCatalogWitnessV4({
    ...parsed,
    witnessVersion: 4,
    profile: prior.profile,
    ...(shell.data.observation
      ? { observation: { ...shell.data.observation, expectedRootCount: 31 } }
      : {}),
  });
  return shell.data.observation ? { ...expected, observation: shell.data.observation } : expected;
}
/** Owner RR READ ONLY observation only; no body text, health rows or private RPC. */
export async function captureCurrentRuntimeCatalogWitnessV5In(
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
 AND NOT pg_has_role(r.oid,o.oid,'MEMBER') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls) AND pg_has_role(r.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid) AS runtime,
 current_setting('transaction_read_only')='on' AS "readOnly",current_setting('search_path') IN('pg_catalog,pg_temp','pg_catalog, pg_temp') AS "pathSafe",current_setting('transaction_isolation') AS isolation,(SELECT count(*)::int FROM pg_catalog.pg_roles) AS "roleCount",
 EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=872194 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=77210 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AS "locksHeld"
 FROM pg_catalog.pg_roles o CROSS JOIN pg_catalog.pg_roles r WHERE o.rolname=session_user AND r.rolname=$1`,
    [runtimeRole.data],
  );
  boundedPlain(context.rows);
  const ctx = z
    .strictObject({
      owner: z.literal(true),
      locksHeld: z.literal(true),
      runtime: z.literal(true),
      readOnly: z.literal(true),
      pathSafe: z.literal(true),
      isolation: z.enum(['repeatable read', 'serializable']),
      roleCount: z.number().int().min(2).max(10000),
    })
    .safeParse(context.rows[0]);
  if (context.rows.length !== 1 || !ctx.success) fail('CATALOG_WITNESS_CONTEXT_REQUIRED');
  await verifyCurrentRuntimeV5InstalledIn(tx);
  const counts = await tx.query(`SELECT
 (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE pronamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) functions,
 (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) relations,
 (SELECT count(*)::int FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) types,
 (SELECT coalesce(max(octet_length(prosrc)),0)::int FROM pg_catalog.pg_proc) "maxSourceBytes"`);
  boundedPlain(counts.rows);
  const countSchema = z.strictObject({
    functions: z.number().int().min(32).max(5000),
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
  const witness = buildCurrentRuntimeCatalogWitnessV5(raw);
  return {
    ...witness,
    observation: {
      clusterRoleCount: ctx.data.roleCount,
      metadataBytes: envelope.data.bytes,
      sqlJsonbSha256: envelope.data.sha256,
      expectedRootCount: 32,
    },
  };
}
