import { Pool } from 'pg';
import { z } from 'zod';
import * as grants from './migrate.js';

const deploymentSchema = z.enum(['core', 'garmin-unofficial']);
export type CurrentRuntimeAppDeploymentV1 = z.infer<typeof deploymentSchema>;
const roleSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
export class CurrentRuntimeAppGrantError extends Error {
  constructor(readonly code: 'APP_GRANT_INVALID_INPUT' | 'APP_GRANT_UNSAFE_PRINCIPAL') {
    super(code);
  }
}
// This fixed recipe follows configured.ts's repositories. These are existing
// grant implementations, not caller-provided functions or a privilege manifest.
const steps = [
  ['identity', grants.grantIdentityFunctions],
  ['aiSettings', grants.grantAiSettings],
  ['operations', grants.grantOperations],
  ['planning', grants.grantCorePlanning],
  ['nutrition', grants.grantNutritionCore],
  ['supplementary', grants.grantSupplementaryCore],
  ['routines', grants.grantRoutineCore],
  ['stretching', grants.grantStretchingCore],
  ['recovery', grants.grantRecoveryCore],
  ['checkIns', grants.grantCheckIns],
  ['sessionCompletions', grants.grantSessionCompletions],
  ['planScenarios', grants.grantPlanScenarios],
  ['coachingConstraints', grants.grantCoachingConstraints],
  ['coachingThreads', grants.grantCoachingThreads],
  ['evidenceSnapshots', grants.grantCoreEvidenceSnapshots],
  ['coachingRuns', grants.grantCoachingRuns],
  ['coachingCandidates', grants.grantCoachingCandidates],
  ['integratedApprovalV4', grants.grantIntegratedApprovalV4],
  ['resources', grants.grantResources],
  ['resourceRetrieval', grants.grantResourceRetrieval],
  ['galleryMedia', grants.grantGalleryMedia],
  ['activityTracks', grants.grantActivityTracks],
  ['courses', grants.grantCourses],
  ['races', grants.grantRaces],
  ['healthKitIngestion', grants.grantHealthKitIngestion],
  ['garmin', grants.grantGarmin],
] as const;
export const currentRuntimeAppActivityRelationsV1 = Object.freeze([
  'activity_canonical',
  'activity_source_head',
  'activity_source_revision',
  'activity_overlay',
  'activity_overlay_revision',
  'activity_suppression',
  'activity_import_receipt',
] as const);
export const currentRuntimeAppGrantRecipeV1 = Object.freeze({
  recipeVersion: 1 as const,
  name: 'configured-app-baseline-v1' as const,
  configuredSource: 'apps/api/src/configured.ts' as const,
  repositoryOrder: Object.freeze(steps.map(([name]) => name)),
  activityRelations: currentRuntimeAppActivityRelationsV1,
  // Provenance reads remain available when the optional collector is disabled.
  retainedGarminRelations: Object.freeze([
    'garmin_activity_ledger',
    'garmin_activity_ledger_source',
  ]),
  optionalCollectorGrant: 'grantGarminUnofficial' as const,
});
const safetySql = `SELECT current_user=session_user AND NOT o.rolsuper AND NOT o.rolbypassrls
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid='public.plan_snapshot'::regclass AND c.relowner=o.oid)
 AND r.oid<>o.oid AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND NOT pg_has_role(r.oid,o.oid,'MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR left(e.rolname,3)='pg_') AND pg_has_role(r.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid) AS safe
 FROM pg_catalog.pg_roles o CROSS JOIN pg_catalog.pg_roles r WHERE o.rolname=current_user AND r.rolname=$1`;
/** Provisioning precursor, not startup admission. Existing helpers own separate
 * pools/transactions: a later failure can leave earlier grants committed.
 * Callers must independently verify the entire actual ACL before activation.
 * This adds rights; it does not repair pre-existing excessive privileges. */
export async function grantCurrentRuntimeAppBaselineV1(
  ownerUrl: string,
  unknownRuntimeRole: unknown,
  unknownDeployment: unknown = 'core',
) {
  const role = roleSchema.safeParse(unknownRuntimeRole);
  const deployment = deploymentSchema.safeParse(unknownDeployment);
  if (!role.success || !deployment.success)
    throw new CurrentRuntimeAppGrantError('APP_GRANT_INVALID_INPUT');
  const pool = new Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const observed = await pool.query(safetySql, [role.data]);
    const parsed = z
      .array(z.strictObject({ safe: z.literal(true) }))
      .length(1)
      .safeParse(observed.rows);
    if (!parsed.success) throw new CurrentRuntimeAppGrantError('APP_GRANT_UNSAFE_PRINCIPAL');
    for (const [, grant] of steps) await grant(ownerUrl, role.data);
    await pool.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON ${currentRuntimeAppActivityRelationsV1.map((name) => `public.${name}`).join(',')} TO "${role.data}"`,
    );
    await pool.query(
      `GRANT SELECT ON public.garmin_activity_ledger,public.garmin_activity_ledger_source TO "${role.data}"`,
    );
    if (deployment.data === 'garmin-unofficial')
      await grants.grantGarminUnofficial(ownerUrl, role.data);
    return {
      recipeVersion: 1 as const,
      recipe: currentRuntimeAppGrantRecipeV1.name,
      deployment: deployment.data,
      runtimeRole: role.data,
      atomicity: 'separate_existing_grant_transactions' as const,
      supported: false as const,
      processingAuthority: 'none' as const,
      catalogSecurity: 'not_verified' as const,
      restore: 'not_verified' as const,
    };
  } finally {
    await pool.end();
  }
}
