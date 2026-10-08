import { Pool } from 'pg';
import { z } from 'zod';
import {
  CurrentRuntimeAppGrantError,
  currentRuntimeAppGrantRecipeV1,
  grantCurrentRuntimeAppBaselineV1,
} from './current-runtime-app-grants-v1.js';

/** Exact predicate/projection columns read by nested-sources even when the
 * optional unofficial collector is disabled. No credential or lease transport. */
export const currentRuntimeAppGarminConnectionColumnsV2 = Object.freeze([
  'athlete_id',
  'session_generation',
  'state',
  'schedule_enabled',
  'schedule_paused',
] as const);
export const currentRuntimeAppGrantRecipeV2 = Object.freeze({
  ...currentRuntimeAppGrantRecipeV1,
  recipeVersion: 2 as const,
  name: 'configured-app-baseline-v2' as const,
  predecessor: 'configured-app-baseline-v1' as const,
  retainedUnofficialConnection: Object.freeze({
    relation: 'public.garmin_unofficial_connection' as const,
    privilege: 'SELECT' as const,
    columns: currentRuntimeAppGarminConnectionColumnsV2,
  }),
});
// Recheck before this separate addition. The inherited helpers already ran
// V1's original guard; a later failure cannot roll back their earlier grants.
const safetySql = `SELECT current_user=session_user AND NOT o.rolsuper AND NOT o.rolbypassrls
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid='public.plan_snapshot'::regclass AND c.relowner=o.oid)
 AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid='public.garmin_unofficial_connection'::regclass AND c.relowner=o.oid)
 AND r.oid<>o.oid AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
 AND NOT pg_has_role(r.oid,o.oid,'MEMBER')
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles e WHERE (e.rolsuper OR e.rolbypassrls OR left(e.rolname,3)='pg_') AND pg_has_role(r.oid,e.oid,'MEMBER'))
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=r.oid)
 AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid) AS safe
 FROM pg_catalog.pg_roles o CROSS JOIN pg_catalog.pg_roles r WHERE o.rolname=current_user AND r.rolname=$1`;
/** Named provision precursor only. Does not activate repositories or repair
 * pre-existing excessive privileges. V1's separate transaction semantics stay. */
export async function grantCurrentRuntimeAppBaselineV2(
  ownerUrl: string,
  unknownRuntimeRole: unknown,
  unknownDeployment: unknown = 'core',
) {
  // Fixed V1 validation and safety gate run before opening any V2 addition pool.
  const base = await grantCurrentRuntimeAppBaselineV1(
    ownerUrl,
    unknownRuntimeRole,
    unknownDeployment,
  );
  if (base.deployment === 'core') {
    const pool = new Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 5000 });
    try {
      const observed = await pool.query(safetySql, [base.runtimeRole]);
      if (
        !z
          .array(z.strictObject({ safe: z.literal(true) }))
          .length(1)
          .safeParse(observed.rows).success
      )
        throw new CurrentRuntimeAppGrantError('APP_GRANT_UNSAFE_PRINCIPAL');
      await pool.query(
        `GRANT SELECT(${currentRuntimeAppGarminConnectionColumnsV2.join(',')}) ON public.garmin_unofficial_connection TO "${base.runtimeRole}"`,
      );
    } finally {
      await pool.end();
    }
  }
  // The explicit optional deployment already received its original V1 grant;
  // core's five-column read does not silently enable its full collector rights.
  return {
    ...base,
    recipeVersion: 2 as const,
    recipe: currentRuntimeAppGrantRecipeV2.name,
  };
}
