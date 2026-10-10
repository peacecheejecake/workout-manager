import type { Database } from './database.js';
import { z } from 'zod';
import { observeCurrentRuntimeColdCatalogV9In } from './current-runtime-cold-catalog-v9.js';
import { verifyCurrentRuntimeSourceProofV9 } from './current-runtime-source-proof-v9.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const catalogDigest = '127a416fb0435ed46225efc82db503d33597dcb01e006f15fb5a7ac3b4c170ed';
const proofBase = {
  profileVersion: z.literal(9),
  runtimeStep: z.literal(25),
  sourceDdlTip: z.literal(142),
  catalogDigest: z.literal(catalogDigest),
};
const proofSchema = z.discriminatedUnion('state', [
  z.strictObject({
    ...proofBase,
    state: z.literal('verified'),
    reason: z.literal('verified_build_evidence'),
    sourceManifestSha256: hash,
  }),
  z.strictObject({
    ...proofBase,
    state: z.literal('unavailable'),
    reason: z.enum([
      'compiled_asset_unavailable',
      'asset_invalid',
      'source_unavailable',
      'source_drift',
    ]),
    sourceManifestSha256: hash.nullable(),
  }),
]);
const reasonSchema = z.enum([
  'verified_catalog_and_source',
  'catalog_context_required',
  'catalog_mismatch',
  'catalog_limit',
  'catalog_invalid_response',
  'catalog_query_unavailable',
  'catalog_expected_asset_invalid',
  'source_compiled_asset_unavailable',
  'source_asset_invalid',
  'source_unavailable',
  'source_drift',
  'source_proof_invalid',
  'transaction_failed',
  'snapshot_unavailable',
]);
type Reason = z.infer<typeof reasonSchema>;
const readinessBase = {
  schemaVersion: z.literal(1),
  profileVersion: z.literal(9),
  runtimeStep: z.literal(25),
  sourceDdlTip: z.literal(142),
  protocol: z.literal('named-profile25-pooled-v2-v38'),
  processingAuthority: z.literal('none'),
  restore: z.literal('not_verified'),
  installationReceiptRows: z.literal('not_observed_by_runtime'),
};
export const currentRuntimeReadinessV9Schema = z.discriminatedUnion('state', [
  z.strictObject({
    ...readinessBase,
    state: z.literal('ready'),
    reason: z.literal('verified_catalog_and_source'),
  }),
  z.strictObject({
    ...readinessBase,
    state: z.literal('unsupported'),
    reason: z.enum([
      'catalog_context_required',
      'catalog_mismatch',
      'catalog_limit',
      'catalog_invalid_response',
      'source_drift',
      'source_proof_invalid',
    ]),
  }),
  z.strictObject({
    ...readinessBase,
    state: z.literal('unavailable'),
    reason: z.enum([
      'catalog_query_unavailable',
      'catalog_expected_asset_invalid',
      'source_compiled_asset_unavailable',
      'source_asset_invalid',
      'source_unavailable',
      'transaction_failed',
      'snapshot_unavailable',
    ]),
  }),
]);
export type CurrentRuntimeReadinessV9 = z.infer<typeof currentRuntimeReadinessV9Schema>;
function result(
  state: CurrentRuntimeReadinessV9['state'],
  reason: Reason,
): CurrentRuntimeReadinessV9 {
  return currentRuntimeReadinessV9Schema.parse({
    schemaVersion: 1,
    state,
    reason: reasonSchema.parse(reason),
    profileVersion: 9,
    runtimeStep: 25,
    sourceDdlTip: 142,
    protocol: 'named-profile25-pooled-v2-v38',
    processingAuthority: 'none',
    restore: 'not_verified',
    installationReceiptRows: 'not_observed_by_runtime',
  });
}
/** Actual runtime catalog snapshot supplied by the database's dedicated port.
 * No caller proof, expected hashes, role, owner URL or synthetic tenant input.
 * Readiness is code/catalog compatibility; every command keeps fresh admission. */
export async function probeCurrentRuntimeReadinessV9(
  database: Pick<Database, 'snapshotCatalog'>,
): Promise<CurrentRuntimeReadinessV9> {
  if (typeof database.snapshotCatalog !== 'function')
    return result('unavailable', 'snapshot_unavailable');
  try {
    return await database.snapshotCatalog(async (tx) => {
      const catalog = await observeCurrentRuntimeColdCatalogV9In(tx);
      if (catalog.catalog !== 'verified') {
        const reasons = {
          context_required: 'catalog_context_required',
          catalog_mismatch: 'catalog_mismatch',
          limit: 'catalog_limit',
          invalid_response: 'catalog_invalid_response',
          query_unavailable: 'catalog_query_unavailable',
          expected_asset_invalid: 'catalog_expected_asset_invalid',
          matched: 'catalog_invalid_response',
        } as const;
        return result(
          catalog.catalog === 'incompatible' ? 'unsupported' : 'unavailable',
          reasons[catalog.reason],
        );
      }
      const proof = proofSchema.safeParse(await verifyCurrentRuntimeSourceProofV9());
      if (!proof.success || catalog.catalogSha256 !== catalogDigest)
        return result('unsupported', 'source_proof_invalid');
      if (proof.data.state === 'verified') return result('ready', 'verified_catalog_and_source');
      const reasons = {
        compiled_asset_unavailable: 'source_compiled_asset_unavailable',
        asset_invalid: 'source_asset_invalid',
        source_unavailable: 'source_unavailable',
        source_drift: 'source_drift',
      } as const;
      return result(
        proof.data.reason === 'source_drift' ? 'unsupported' : 'unavailable',
        reasons[proof.data.reason],
      );
    });
  } catch {
    return result('unavailable', 'transaction_failed');
  }
}
