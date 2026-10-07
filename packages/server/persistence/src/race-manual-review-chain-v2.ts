import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from './database.js';
import { raceProjectionIntentSchema } from './race-plan-impact-projection-input.js';
import { RaceImpactDependencyError } from './race-plan-impact-dependencies.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import {
  prepareRaceManualSemanticBasisV2In,
  raceManualSemanticBasisV2Schema,
} from './race-manual-review-semantic-basis-v2.js';
import { raceManualReviewRetainedPayloadV2Schema } from './race-manual-review-retained-payload-v2.js';
import { captureRaceManualReviewLifecycleInventoryV2In } from './race-manual-review-lifecycle-inventory-v2.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
/** Optimistic intent/expectation only. No capture, candidate, source inventory,
 * permission flag or caller-provided ID is accepted as a storage credential. */
const boundedPlain = z.unknown().superRefine((value, ctx) => {
  try {
    assertRaceManualPlainV2(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid bounded plain chain command' });
  }
});
export const raceManualReviewChainCommandV2Schema = boundedPlain.pipe(
  z.strictObject({
    schemaVersion: z.literal(2),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    intent: raceProjectionIntentSchema,
    expectedBasis: raceManualSemanticBasisV2Schema,
  }),
);
export type RaceManualReviewChainCommandV2 = z.infer<typeof raceManualReviewChainCommandV2Schema>;
export const raceManualReviewChainResultV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  evidenceId: uuid,
  decisionId: uuid,
  proposalId: uuid,
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime({ offset: true }),
  applicable: z.literal(false),
  approvalAllowed: z.literal(false),
});
export const raceManualReviewChainReadV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  result: raceManualReviewChainResultV2Schema,
  payload: raceManualReviewRetainedPayloadV2Schema.nullable(),
});
export type RaceManualReviewChainResultV2 = z.infer<typeof raceManualReviewChainResultV2Schema>;
export type RaceManualReviewChainReadV2 = z.infer<typeof raceManualReviewChainReadV2Schema>;
const limits = {
  authority: 'none',
  freshness: 'not_checked',
  sourceAuthentication: 'unverified_original_event',
  permissionAuthority: 'none',
  approvalAllowed: false,
  planApplied: false,
  budgetCoverage: 'request_source_response_reservations',
  aggregatePhysicalTransfer: 'not_verified',
} as const;
function command(raw: unknown) {
  return raceManualReviewChainCommandV2Schema.parse(raw);
}
const response = z.strictObject({
  bytes: z.string().regex(/^(0|[1-9][0-9]*)$/),
  value: z.unknown(),
});
/** The SQL call is MATERIALIZED exactly once. Its JSON response is not sent by
 * the driver when larger than the remaining request reservation. This does not
 * measure the SQL function's internal physical row reads. */
async function boundedCall(
  tx: Transaction,
  expression: string,
  values: unknown[],
  budget: SourceBudget,
): Promise<unknown> {
  validateRaceSourceResponseBudget(budget);
  const remaining = 4194304n - budget.bytes;
  const row = response.parse(
    (
      await tx.query(
        `WITH observed AS MATERIALIZED (SELECT ${expression} AS value), measured AS MATERIALIZED
         (SELECT value,octet_length(COALESCE(value::text,'null'))::bigint AS bytes FROM observed)
         SELECT bytes::text AS bytes,CASE WHEN bytes <= $${values.length + 1}::bigint THEN value ELSE NULL END AS value FROM measured`,
        [...values, remaining.toString()],
      )
    ).rows[0],
  );
  const bytes = BigInt(row.bytes);
  if (bytes > remaining)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  reserveSourceBudget(budget, bytes, 0);
  assertRaceManualPlainV2(row.value);
  return row.value;
}
/** Trusted transaction entry. SQL116 must itself validate actual sources,
 * semantic basis, lifecycle edges and privacy closure before storing. Neither
 * these preparation observations nor caller JSON grant admission. */
export async function storeRaceManualReviewChainV2In(
  tx: Transaction,
  rawCommand: unknown,
  budget: SourceBudget,
  ids: () => string = randomUUID,
) {
  const input = command(rawCommand);
  const request = JSON.stringify(input);
  const replay = await boundedCall(
    tx,
    'public.read_manual_race_chain_receipt_v2($1::text,$2::jsonb)',
    [input.idempotencyKey, request],
    budget,
  );
  if (replay !== null)
    return {
      status: 'replayed' as const,
      result: raceManualReviewChainResultV2Schema.parse(replay),
      storage: 'persisted' as const,
      ...limits,
    };
  const prepared = await prepareRaceManualSemanticBasisV2In(
    tx,
    input.intent,
    input.expectedBasis,
    budget,
  );
  if (prepared.status !== 'current_dependencies_captured')
    return { status: 'blocked' as const, prepared, storage: 'not_persisted' as const, ...limits };
  const retained = raceManualReviewRetainedPayloadV2Schema.parse(prepared.prepared.retained);
  if (
    retained.state !== 'present' ||
    retained.status !== 'structurally_corresponding' ||
    retained.payload.preparation.candidate.status !== 'assembled_readonly'
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  const lifecycle = await captureRaceManualReviewLifecycleInventoryV2In(tx, retained, budget);
  if (lifecycle.status !== 'dependency_correspondence')
    return {
      status: 'blocked' as const,
      prepared,
      lifecycle,
      storage: 'not_persisted' as const,
      ...limits,
    };
  const minted = {
    evidenceId: uuid.parse(ids()),
    decisionId: uuid.parse(ids()),
    proposalId: uuid.parse(ids()),
  };
  const result = raceManualReviewChainResultV2Schema.parse(
    await boundedCall(
      tx,
      'public.store_manual_race_chain_v2($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
      [
        minted.evidenceId,
        minted.decisionId,
        minted.proposalId,
        input.idempotencyKey,
        request,
        JSON.stringify(retained),
        JSON.stringify(prepared.basis),
        JSON.stringify(lifecycle),
      ],
      budget,
    ),
  );
  if (
    result.evidenceId !== minted.evidenceId ||
    result.decisionId !== minted.decisionId ||
    result.proposalId !== minted.proposalId ||
    result.candidateDigest !== retained.payload.preparation.candidate.digest
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return { status: 'stored' as const, result, storage: 'persisted' as const, ...limits };
}
/** Retained read has no fresh processing gate; source purge returns no copied
 * body. Exact ownership/privacy enforcement remains in the SQL116 reader. */
export async function readRaceManualReviewChainV2In(
  tx: Transaction,
  rawId: unknown,
  budget: SourceBudget,
) {
  const id = uuid.parse(rawId);
  const raw = await boundedCall(tx, 'public.read_manual_race_chain_v2($1::uuid)', [id], budget);
  if (raw === null) return null;
  const read = raceManualReviewChainReadV2Schema.parse(raw);
  if (read.result.evidenceId !== id) throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (read.payload !== null && read.payload.minimalAudit.athleteId !== tx.athleteId)
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  if (
    read.payload?.state === 'present' &&
    (read.payload.payload.preparation.candidate.status !== 'assembled_readonly' ||
      read.payload.payload.preparation.candidate.digest !== read.result.candidateDigest)
  )
    throw new RaceImpactDependencyError('INVALID_CONTEXT');
  return read;
}
/** Composition remains internal until SQL116/all source deletion hooks are
 * accepted. Snapshot capability is required; there is no RC fallback. */
export function createRaceManualReviewChainV2Repository(
  database: Database,
  ids: () => string = randomUUID,
) {
  return {
    async store(athleteId: string, rawCommand: unknown) {
      const input = command(rawCommand);
      if (!database.snapshotTenant) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE');
      return database.snapshotTenant(athleteId, (tx) =>
        storeRaceManualReviewChainV2In(tx, input, { bytes: 0n, sources: 0 }, ids),
      );
    },
    async read(athleteId: string, rawId: unknown) {
      const id = uuid.parse(rawId);
      if (!database.snapshotTenant) throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE');
      return database.snapshotTenant(athleteId, (tx) =>
        readRaceManualReviewChainV2In(tx, id, { bytes: 0n, sources: 0 }),
      );
    },
  };
}

export type RaceManualReviewChainStoreV2 = Awaited<
  ReturnType<typeof storeRaceManualReviewChainV2In>
>;
