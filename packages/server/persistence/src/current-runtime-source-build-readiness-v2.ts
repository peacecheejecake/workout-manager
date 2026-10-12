import { createBoundedPlainJsonSchema } from '@workout/contracts/bounded-plain-json';
import type { Database } from './database.js';
import { z } from 'zod';
import { observeCurrentRuntimeColdCatalogV10In } from './current-runtime-cold-catalog-v10.js';
import {
  verifyCurrentRuntimeSourceBuildProofV2,
  currentRuntimeSourceBuildProofV2CatalogDigest,
} from './current-runtime-source-build-proof-v2.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Single Root-pinned profile26 catalog digest, owned by source-build proof v2.
const catalogDigest = currentRuntimeSourceBuildProofV2CatalogDigest;
const proofBase = {
  profileVersion: z.literal(10),
  runtimeStep: z.literal(26),
  sourceDdlTip: z.literal(146),
  catalogDigest: z.literal(catalogDigest),
  buildProofVersion: z.literal(2),
  sourceBuildRevision: z.literal(1),
  currentFunctionalExecution: z.literal('not_executed'),
  authority: z.literal('none'),
  approvalAllowed: z.literal(false),
  restoreAuthority: z.literal('none'),
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
  schemaVersion: z.literal(2),
  buildProofVersion: z.literal(2),
  sourceBuildRevision: z.literal(1),
  currentFunctionalExecution: z.literal('not_executed'),
  approvalAllowed: z.literal(false),
  restoreAuthority: z.literal('none'),
  profileVersion: z.literal(10),
  runtimeStep: z.literal(26),
  sourceDdlTip: z.literal(146),
  protocol: z.literal('named-profile26-pooled-v2-v38'),
  processingAuthority: z.literal('none'),
  restore: z.literal('not_verified'),
  installationReceiptRows: z.literal('not_observed_by_runtime'),
};
export const currentRuntimeSourceBuildReadinessV2Schema = z.discriminatedUnion('state', [
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
export type CurrentRuntimeSourceBuildReadinessV2 = z.infer<
  typeof currentRuntimeSourceBuildReadinessV2Schema
>;
function result(
  state: CurrentRuntimeSourceBuildReadinessV2['state'],
  reason: Reason,
): CurrentRuntimeSourceBuildReadinessV2 {
  return currentRuntimeSourceBuildReadinessV2Schema.parse({
    schemaVersion: 2,
    buildProofVersion: 2,
    sourceBuildRevision: 1,
    currentFunctionalExecution: 'not_executed',
    approvalAllowed: false,
    restoreAuthority: 'none',
    state,
    reason: reasonSchema.parse(reason),
    profileVersion: 10,
    runtimeStep: 26,
    sourceDdlTip: 146,
    protocol: 'named-profile26-pooled-v2-v38',
    processingAuthority: 'none',
    restore: 'not_verified',
    installationReceiptRows: 'not_observed_by_runtime',
  });
}
/** Actual runtime catalog snapshot supplied by the database's dedicated port.
 * No caller proof, expected hashes, role, owner URL or synthetic tenant input.
 * Readiness is code/catalog compatibility; every command keeps fresh admission. */
export async function probeCurrentRuntimeSourceBuildReadinessV2(
  database: Pick<Database, 'snapshotCatalog'>,
): Promise<CurrentRuntimeSourceBuildReadinessV2> {
  try {
    if (typeof database.snapshotCatalog !== 'function')
      return result('unavailable', 'snapshot_unavailable');
    const rawCatalog: unknown = await database.snapshotCatalog(async (tx) =>
      observeCurrentRuntimeColdCatalogV10In(tx),
    );
    // The dedicated snapshot promise resolves only after COMMIT and transaction cleanup.
    // A rejected COMMIT must never permit source proof verification or ready ports.
    const catalogPlain = boundedObservation.safeParse(rawCatalog);
    const decodedCatalog = catalogPlain.success
      ? coldObservationSchema.safeParse(catalogPlain.data)
      : null;
    if (!decodedCatalog?.success) return result('unsupported', 'catalog_invalid_response');
    const catalog = decodedCatalog.data;
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
    if (catalog.catalogSha256 !== catalogDigest)
      return result('unsupported', 'source_proof_invalid');
    const rawProof: unknown = verifyCurrentRuntimeSourceBuildProofV2();
    const plain = boundedObservation.safeParse(rawProof);
    const proof = plain.success ? proofSchema.safeParse(plain.data) : null;
    if (!proof?.success) return result('unsupported', 'source_proof_invalid');
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
  } catch {
    return result('unavailable', 'transaction_failed');
  }
}

const boundedObservation = createBoundedPlainJsonSchema(4096);
const coldObservationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    catalog: z.enum(['verified', 'incompatible', 'unavailable']),
    reason: z.enum([
      'matched',
      'context_required',
      'catalog_mismatch',
      'limit',
      'invalid_response',
      'query_unavailable',
      'expected_asset_invalid',
    ]),
    profileVersion: z.literal(10),
    runtimeStep: z.literal(26),
    sourceDdlTip: z.literal(146),
    catalogSha256: hash.nullable(),
    metadataBytes: z
      .string()
      .regex(/^[1-9][0-9]{0,8}$/)
      .nullable(),
    supported: z.literal(false),
    processingAuthority: z.literal('none'),
    restore: z.literal('not_verified'),
    installationReceiptRows: z.literal('not_observed_by_runtime'),
  })
  .superRefine((value, context) => {
    if (
      value.catalog === 'verified' &&
      (value.reason !== 'matched' || value.catalogSha256 === null || value.metadataBytes === null)
    )
      context.addIssue({ code: 'custom', message: 'INVALID_CATALOG_OBSERVATION' });
    if (
      (value.catalog === 'unavailable' &&
        !['query_unavailable', 'expected_asset_invalid'].includes(value.reason)) ||
      (value.catalog === 'incompatible' &&
        !['context_required', 'catalog_mismatch', 'limit', 'invalid_response'].includes(
          value.reason,
        ))
    )
      context.addIssue({ code: 'custom', message: 'INVALID_CATALOG_OBSERVATION' });
  });
