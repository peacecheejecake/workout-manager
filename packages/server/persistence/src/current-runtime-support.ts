import { z } from 'zod';
import { currentRuntimeRpcSourcePins } from './current-runtime-grants.js';

export interface CurrentRuntimeSupportTransaction {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

// Compile-time roots only. These witnesses do not cover transitive bodies,
// deletion triggers, FORCE RLS, constraints or the caller's strict wire codecs.
const relations = Object.freeze([
  'nutrition_race_item_disconnection',
  'nutrition_integrated_candidate_disconnection',
  'race_result_proof_ref',
  'nutrition_race_disconnection_lineage',
  'nutrition_v4_commit_seal',
  'plan_snapshot_aggregate',
  'manual_race_evidence_v2',
  'manual_race_decision_v2',
  'manual_race_proposal_v2',
  'manual_race_chain_source_ref_v2',
  'manual_race_chain_lifecycle_edge_v2',
  'manual_race_chain_suppression_v2',
  'manual_race_chain_receipt_v2',
  'manual_race_chain_commit_v2',
  'manual_race_v2_live_transition',
  'race_manual_application_candidate_v1',
  'race_manual_application_context_v1',
  'race_manual_application_receipt_v1',
  'race_manual_application_history_v1',
  'race_manual_public_receipt_v1',
  'check_in_template_version',
  'check_in_template_head',
  'check_in_template_receipt',
]);
export const currentRuntimeSupportMissingClosure = Object.freeze([
  'transitive_function_bodies',
  'deletion_and_commit_triggers',
  'relation_rls_and_policies',
  'columns_constraints_and_indexes',
  'transitive_effective_privileges',
  'strict_caller_wire',
] as const);
const nullableHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const root = z.strictObject({
  ordinal: z.number().int().min(1).max(currentRuntimeRpcSourcePins.length),
  signature: z.string().max(256),
  present: z.boolean(),
  owned: z.boolean(),
  language: z.string().max(32).nullable(),
  result_type: z.string().max(64).nullable(),
  security_definer: z.boolean().nullable(),
  volatility: z.enum(['i', 's', 'v']).nullable(),
  source_sha256: nullableHash,
  configuration: z.array(z.string().max(128)).min(1).max(3).nullable(),
  public_execute: z.boolean(),
  executable: z.boolean(),
});
const evidence = z.strictObject({
  runtime_safe: z.boolean(),
  owner_safe: z.boolean(),
  private_ledger_access: z.boolean(),
  public_schema_usage: z.boolean(),
  relation_count: z.number().int().min(0).max(relations.length),
  versioned_occurrence_constraint: z.boolean(),
  target_transform_present: z.boolean(),
  roots: z.array(root).length(currentRuntimeRpcSourcePins.length),
});
const resultSchema = z
  .strictObject({
    // Supported is reserved for an actual complete closure successor. This
    // implementation deliberately never emits it or enables capabilities.
    state: z.enum(['supported', 'unsupported', 'incompatible', 'unavailable']),
    supported: z.literal(false),
    reason: z.enum([
      'current_artifacts_absent',
      'runtime_role_unsafe',
      'owner_unsafe',
      'private_ledger_access',
      'target_transform_present',
      'partial_installation',
      'root_metadata_mismatch',
      'root_privilege_missing',
      'required_closure_not_verified',
      'catalog_evidence_invalid',
      'catalog_query_failed',
    ]),
    rootEvidence: z.enum(['absent', 'verified', 'not_verified']),
    missingClosure: z
      .array(z.enum(currentRuntimeSupportMissingClosure))
      .length(currentRuntimeSupportMissingClosure.length),
    catalogSecurity: z.literal('not_verified'),
    restore: z.literal('not_verified'),
    processingAuthority: z.literal('none'),
  })
  .refine((value) => value.state !== 'supported');
export type CurrentRuntimeSupportResult = z.infer<typeof resultSchema>;
function result(
  state: CurrentRuntimeSupportResult['state'],
  reason: CurrentRuntimeSupportResult['reason'],
  rootEvidence: CurrentRuntimeSupportResult['rootEvidence'] = 'not_verified',
): CurrentRuntimeSupportResult {
  return resultSchema.parse({
    state,
    reason,
    rootEvidence,
    supported: false,
    missingClosure: [...currentRuntimeSupportMissingClosure],
    catalogSecurity: 'not_verified',
    restore: 'not_verified',
    processingAuthority: 'none',
  });
}

// Guard a catalog response before Zod: getters, exotic prototypes, holes,
// cycles and oversized primitive/key values are rejected without serializing.
function boundedPlain(raw: unknown): boolean {
  let visits = 0,
    bytes = 0;
  const active = new Set<object>();
  function text(value: string) {
    bytes += Buffer.byteLength(value, 'utf8');
    return bytes <= 131072;
  }
  function visit(value: unknown, depth: number): boolean {
    if (++visits > 5000 || depth > 8) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return text(value);
    if (typeof value !== 'object' || active.has(value)) return false;
    const array = Array.isArray(value),
      proto: unknown = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      return false;
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 5000) return false;
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || !text(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
      if (array && key !== String(count++)) return false;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    active.delete(value);
    return !array || count === value.length;
  }
  try {
    return visit(raw, 0) && Buffer.byteLength(JSON.stringify(raw), 'utf8') <= 131072;
  } catch {
    return false;
  }
}

/** Structural evidence validator only, never a deploy/input credential.
 * Even exact roots cannot grant support while required closure is missing. */
export function validateCurrentRuntimeSupportEvidence(raw: unknown): CurrentRuntimeSupportResult {
  if (!boundedPlain(raw)) return result('unavailable', 'catalog_evidence_invalid');
  const parsed = evidence.safeParse(raw);
  if (!parsed.success) return result('unavailable', 'catalog_evidence_invalid');
  const value = parsed.data;
  for (const [index, observed] of value.roots.entries()) {
    const pin = currentRuntimeRpcSourcePins[index];
    if (!pin || observed.ordinal !== index + 1 || observed.signature !== pin.signature)
      return result('unavailable', 'catalog_evidence_invalid');
    if (
      !observed.present &&
      (observed.owned ||
        observed.executable ||
        observed.public_execute ||
        observed.language !== null ||
        observed.result_type !== null ||
        observed.security_definer !== null ||
        observed.volatility !== null ||
        observed.source_sha256 !== null ||
        observed.configuration !== null)
    )
      return result('unavailable', 'catalog_evidence_invalid');
  }
  if (!value.runtime_safe) return result('incompatible', 'runtime_role_unsafe');
  if (!value.owner_safe) return result('incompatible', 'owner_unsafe');
  if (value.private_ledger_access) return result('incompatible', 'private_ledger_access');
  if (value.target_transform_present) return result('incompatible', 'target_transform_present');
  const count = value.roots.filter((r) => r.present).length;
  if (count === 0 && value.relation_count === 0 && !value.versioned_occurrence_constraint)
    return result('unsupported', 'current_artifacts_absent', 'absent');
  if (
    count !== currentRuntimeRpcSourcePins.length ||
    value.relation_count !== relations.length ||
    !value.versioned_occurrence_constraint
  )
    return result('incompatible', 'partial_installation');
  for (const [index, observed] of value.roots.entries()) {
    const pin = currentRuntimeRpcSourcePins[index];
    if (
      !pin ||
      !observed.owned ||
      observed.public_execute ||
      observed.language !== pin.language ||
      observed.result_type !== pin.result_type ||
      observed.security_definer !== pin.security_definer ||
      observed.volatility !== pin.volatility ||
      observed.source_sha256 !== pin.prosrcSha256 ||
      JSON.stringify(observed.configuration) !== JSON.stringify(pin.configuration)
    )
      return result('incompatible', 'root_metadata_mismatch');
  }
  if (!value.public_schema_usage || value.roots.some((r) => !r.executable))
    return result('incompatible', 'root_privilege_missing');
  return result('incompatible', 'required_closure_not_verified', 'verified');
}

// Catalog-only, bounded scalar/hash output. No private schema regprocedure
// casts, source body/ledger reads, install mutation, role/GUC changes or RPC calls.
const catalogSql = `WITH owner AS (
 SELECT c.relowner AS oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname='schema_migrations' AND c.relkind='r'
), actor AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname=current_user), roots AS (
 SELECT i.ordinal::int AS ordinal,i.signature,p.oid IS NOT NULL AS present,
 coalesce(p.proowner=(SELECT oid FROM owner),false) AS owned,l.lanname AS language,
 pg_catalog.format_type(p.prorettype,NULL) AS result_type,p.prosecdef AS security_definer,p.provolatile AS volatility,
 CASE WHEN pg_catalog.octet_length(p.prosrc)<=2097152 THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') END AS source_sha256,
 CASE WHEN cardinality(p.proconfig) BETWEEN 1 AND 3 AND NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) s WHERE octet_length(s)>128) THEN p.proconfig END AS configuration,
 p.oid IS NOT NULL AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
 coalesce(pg_catalog.has_function_privilege(p.oid,'EXECUTE'),false) AS executable
 FROM unnest($1::text[]) WITH ORDINALITY i(signature,ordinal)
 LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(i.signature)
 LEFT JOIN pg_catalog.pg_language l ON l.oid=p.prolang
) SELECT
 coalesce((SELECT NOT a.rolsuper AND NOT a.rolbypassrls AND NOT a.rolcreaterole AND current_user=session_user
 AND a.oid<>(SELECT oid FROM owner) AND NOT pg_catalog.pg_has_role(a.oid,(SELECT oid FROM owner),'MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE (r.rolsuper OR r.rolbypassrls) AND pg_catalog.pg_has_role(a.oid,r.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=a.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=a.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=a.oid) FROM actor a),false) AS runtime_safe,
 coalesce((SELECT NOT r.rolsuper AND NOT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.oid=(SELECT oid FROM owner)),false) AS owner_safe,
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname='wm_runtime_installation' AND pg_catalog.has_schema_privilege(n.oid,'USAGE'))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='wm_runtime_installation' AND pg_catalog.has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS private_ledger_access,
 coalesce((SELECT pg_catalog.has_schema_privilege(n.oid,'USAGE') FROM pg_catalog.pg_namespace n WHERE n.nspname='public'),false) AS public_schema_usage,
 (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($2::text[])) AS relation_count,
 EXISTS(SELECT 1 FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class c ON c.oid=x.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='routine_occurrence' AND x.conname='routine_occurrence_version_anchor_unique') AS versioned_occurrence_constraint,
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=ANY(ARRAY['wm_current_app_load','wm_current_original_postimages','wm_identity_target_load'])) AS target_transform_present,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY ordinal) FROM roots r) AS roots`;

/** Caller supplies a fresh coherent catalog transaction. This is not a
 * processing admission, ownership proof, installation receipt or capability.
 * No supported result until the explicitly missing closure is implemented. */
export async function probeCurrentRuntimeSupportIn(
  tx: CurrentRuntimeSupportTransaction,
): Promise<CurrentRuntimeSupportResult> {
  try {
    const observed = await tx.query(catalogSql, [
      currentRuntimeRpcSourcePins.map((p) => p.signature),
      [...relations],
    ]);
    if (observed.rows.length !== 1) return result('unavailable', 'catalog_evidence_invalid');
    return validateCurrentRuntimeSupportEvidence(observed.rows[0]);
  } catch {
    return result('unavailable', 'catalog_query_failed');
  }
}
