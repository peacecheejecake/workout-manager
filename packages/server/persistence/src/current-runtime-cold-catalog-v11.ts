import { z } from 'zod';
import { canonical, boundedPlain } from './current-runtime-catalog-witness.js';
import {
  buildCurrentRuntimeCatalogWitnessV11,
  currentRuntimeCatalogMetadataQueryV11,
  currentRuntimeV11PrincipalRoleTags,
} from './current-runtime-catalog-witness-v11.js';
import { currentRuntimeCompiledExpectedV11 } from './current-runtime-compiled-expected-v11.js';
import {
  currentRuntimeV11AiDispatcherRole,
  currentRuntimeV11GalleryWorkerRole,
} from './current-runtime-grants-v11.js';
import type { CurrentRuntimeInstallationTransaction } from './current-runtime-installation.js';

const MAX_BYTES = 16 * 1024 * 1024;
const ownerOid = '(SELECT datdba FROM pg_catalog.pg_database WHERE datname=current_database())';
const anchors = [
  [
    'SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN(session_user,$1)',
    `SELECT ${ownerOid} AS oid UNION SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1`,
  ],
  ["CASE WHEN rolname=session_user THEN 'owner'", `CASE WHEN r.oid=${ownerOid} THEN 'owner'`],
] as const;
function runtimeQuery() {
  let query = currentRuntimeCatalogMetadataQueryV11;
  for (const [before, after] of anchors) {
    if (query.split(before).length !== 2) throw new Error('COLD_CATALOG_QUERY_SOURCE_INVALID');
    query = query.replace(before, () => after);
  }
  return query;
}
// Compiled SQL only: no caller role, owner, expected hash, or SQL fragment input. Same two
// owner anchors as V10 over the V11 query (fixed worker/dispatcher principal tags).
export const currentRuntimeColdCatalogQueryV11 = runtimeQuery();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const section = z.strictObject({
  section: z.string(),
  rowCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sha256: hash,
});
// gallery/AI tables (143..148) live in public; the v11 ledger is in wm_runtime_installation.
const expectedSchema = z.object({
  recognizedNamespaces: z.tuple([
    z.literal('garmin_private'),
    z.literal('identity_private'),
    z.literal('public'),
    z.literal('wm_app_load'),
    z.literal('wm_check_in_templates_v1'),
    z.literal('wm_manual_pooled'),
    z.literal('wm_runtime_installation'),
  ]),
  principalRoleTags: z.tuple([z.literal('ai_dispatcher'), z.literal('gallery_rendition_worker')]),
  metadataEncoding: z.literal('pg-catalog-runtime-security-normalized-v3-principals-v11'),
  profileVersion: z.literal(11),
  runtimeStep: z.literal(27),
  sourceDdlTip: z.literal(148),
  catalogSha256: hash,
  sections: z.array(section).min(1).max(64),
});
const contextSchema = z.strictObject({
  runtimeRole: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
  safe: z.literal(true),
  ownerSafe: z.literal(true),
  ownerBound: z.literal(true),
  privateDenied: z.literal(true),
  readOnly: z.literal(true),
  pathSafe: z.literal(true),
  locksHeld: z.literal(true),
  isolation: z.enum(['repeatable read', 'serializable']),
  roleCount: z.number().int().min(4).max(10000),
});
// $1 fixed principal names: the observing runtime is neither of them nor connected to them.
const contextSql = `WITH owner AS (SELECT datdba oid FROM pg_catalog.pg_database WHERE datname=current_database()), actor AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname=session_user)
SELECT a.rolname::text AS "runtimeRole",
 current_user=session_user AND a.oid<>o.oid AND NOT a.rolsuper AND NOT a.rolbypassrls AND NOT a.rolcreaterole AND NOT a.rolcreatedb AND NOT a.rolreplication
 AND NOT pg_has_role(a.oid,o.oid,'MEMBER') AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR left(e.rolname,3)='pg_') AND pg_has_role(a.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=a.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=a.oid) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=a.oid)
 AND a.rolname<>ALL($1::text[]) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles f WHERE f.rolname=ANY($1::text[]) AND (pg_has_role(a.oid,f.oid,'MEMBER') OR pg_has_role(f.oid,a.oid,'MEMBER'))) AS safe,
 NOT r.rolsuper AND NOT r.rolbypassrls AS "ownerSafe",
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='wm_runtime_installation' AND n.nspowner=o.oid) AS "ownerBound",
 NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname IN('wm_runtime_installation','wm_manual_pooled') AND has_schema_privilege(a.oid,n.oid,'USAGE'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND (has_table_privilege(a.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(a.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS "privateDenied",
 current_setting('transaction_read_only')='on' AS "readOnly", current_setting('search_path') IN('pg_catalog,pg_temp','pg_catalog, pg_temp') AS "pathSafe",current_setting('transaction_isolation') AS isolation,
 (SELECT count(*)::int FROM pg_catalog.pg_roles) AS "roleCount",
 EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=872194 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AND EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=77210 AND objid=1 AND objsubid=2 AND mode='ShareLock' AND granted) AS "locksHeld"
FROM actor a CROSS JOIN owner o JOIN pg_catalog.pg_roles r ON r.oid=o.oid`;
const countsSchema = z.strictObject({
  functions: z.number().int().min(56).max(5000),
  relations: z.number().int().min(36).max(5000),
  types: z.number().int().nonnegative().max(5000),
  maxSourceBytes: z.number().int().nonnegative().max(2097152),
});
const countsSql = `SELECT
 (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE pronamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) functions,
 (SELECT count(*)::int FROM pg_catalog.pg_class WHERE relnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) relations,
 (SELECT count(*)::int FROM pg_catalog.pg_type WHERE typnamespace IN(SELECT oid FROM pg_catalog.pg_namespace WHERE left(nspname,3)<>'pg_' AND nspname<>'information_schema')) types,
 (SELECT coalesce(max(octet_length(prosrc)),0)::int FROM pg_catalog.pg_proc) "maxSourceBytes"`;
const reasonSchema = z.enum([
  'matched',
  'context_required',
  'catalog_mismatch',
  'limit',
  'invalid_response',
  'query_unavailable',
  'expected_asset_invalid',
]);
type Reason = z.infer<typeof reasonSchema>;
function result(
  catalog: 'verified' | 'incompatible' | 'unavailable',
  reason: Reason,
  catalogSha256: string | null = null,
  metadataBytes: string | null = null,
) {
  return {
    schemaVersion: 1 as const,
    catalog,
    reason: reasonSchema.parse(reason),
    profileVersion: 11 as const,
    runtimeStep: 27 as const,
    sourceDdlTip: 148 as const,
    catalogSha256,
    metadataBytes,
    supported: false as const,
    processingAuthority: 'none' as const,
    restore: 'not_verified' as const,
    installationReceiptRows: 'not_observed_by_runtime' as const,
  };
}
export type CurrentRuntimeColdCatalogV11 = ReturnType<typeof result>;
/** Actual runtime RR/read-only observation. Compiled expected is a build asset;
 * private installation rows, dynamic wire proof and processing admission are not observed.
 * Caller owns the transaction (search_path is transaction-local). */
export async function observeCurrentRuntimeColdCatalogV11In(
  tx: CurrentRuntimeInstallationTransaction,
): Promise<CurrentRuntimeColdCatalogV11> {
  try {
    const expected = expectedSchema.safeParse(currentRuntimeCompiledExpectedV11);
    if (!expected.success) return result('unavailable', 'expected_asset_invalid');
    const context = await tx.query(contextSql, [
      [currentRuntimeV11GalleryWorkerRole, currentRuntimeV11AiDispatcherRole],
    ]);
    boundedPlain(context.rows);
    const ctx = contextSchema.safeParse(context.rows[0]);
    if (context.rows.length !== 1 || !ctx.success)
      return result('incompatible', 'context_required');
    const counts = await tx.query(countsSql);
    boundedPlain(counts.rows);
    if (counts.rows.length !== 1 || !countsSchema.safeParse(counts.rows[0]).success)
      return result('incompatible', 'limit');
    await tx.query("SET LOCAL statement_timeout='30000ms'");
    const observed = await tx.query(
      `${currentRuntimeColdCatalogQueryV11}, measured AS MATERIALIZED (SELECT body,octet_length(body::text) bytes,encode(sha256(convert_to(body::text,'UTF8')),'hex') sha256 FROM enriched)
SELECT bytes::text bytes,sha256,CASE WHEN bytes<=16777216 THEN body ELSE NULL END metadata FROM measured`,
      [ctx.data.runtimeRole],
    );
    boundedPlain(observed.rows);
    const envelope = z
      .strictObject({
        bytes: z
          .string()
          .regex(/^(0|[1-9][0-9]*)$/)
          .max(20),
        sha256: hash,
        metadata: z.unknown(),
      })
      .safeParse(observed.rows[0]);
    if (observed.rows.length !== 1 || !envelope.success)
      return result('incompatible', 'invalid_response');
    if (BigInt(envelope.data.bytes) > BigInt(MAX_BYTES)) return result('incompatible', 'limit');
    if (
      envelope.data.metadata === null ||
      Buffer.byteLength(JSON.stringify(envelope.data.metadata), 'utf8') >
        BigInt(envelope.data.bytes)
    )
      return result('incompatible', 'invalid_response');
    const witness = buildCurrentRuntimeCatalogWitnessV11(envelope.data.metadata);
    const principals = witness.metadata.roles
      .map((v) => v.tag)
      .filter((t) => Object.values(currentRuntimeV11PrincipalRoleTags).includes(t))
      .sort();
    if (
      JSON.stringify(witness.metadata.schemas.map((v) => v.name).sort()) !==
        JSON.stringify(expected.data.recognizedNamespaces) ||
      JSON.stringify(principals) !== JSON.stringify(expected.data.principalRoleTags) ||
      witness.unmappedRoleTags.length ||
      witness.metadata.userMappings.length ||
      witness.metadata.foreignServers.length ||
      witness.metadata.foreignWrappers.length ||
      witness.catalogSha256 !== expected.data.catalogSha256 ||
      witness.metadataEncoding !== expected.data.metadataEncoding ||
      JSON.stringify(canonical(witness.sections)) !==
        JSON.stringify(canonical(expected.data.sections))
    )
      return result('incompatible', 'catalog_mismatch');
    return result('verified', 'matched', witness.catalogSha256, envelope.data.bytes);
  } catch (error) {
    const code = z.object({ code: z.string() }).safeParse(error);
    if (code.success && code.data.code === 'CATALOG_WITNESS_LIMIT')
      return result('incompatible', 'limit');
    if (code.success && code.data.code === 'CATALOG_WITNESS_INVALID')
      return result('incompatible', 'invalid_response');
    return result('unavailable', 'query_unavailable');
  }
}
