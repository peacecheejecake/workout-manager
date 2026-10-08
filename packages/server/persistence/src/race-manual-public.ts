import {
  createRaceManualSameTxApprovalContinuation,
  raceManualStoredApprovalReadSchema,
  raceManualStoredApprovalReferenceSchema,
} from './race-manual-same-tx-approval-continuation.js';
import {
  captureRaceManualSameTxReviewContinuationIn,
  hasRaceManualSameTxReviewCapabilityIn,
  invalidateRaceManualSameTxReviewContinuation,
} from './race-manual-same-tx-review-continuation.js';
import { storeRaceManualReviewSameTxChainIn } from './race-manual-review-chain-v2.js';
import { prepareRaceManualSameTxApprovalIn } from './race-manual-approval.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  raceManualPublicPrepareSchema,
  raceManualPublicApproveSchema,
} from '@workout/contracts/race-manual-public';
import {
  raceManualApprovalCommandSchema,
  raceManualApprovalResultSchema,
} from '@workout/contracts/race-manual-approval';
import type { Database, Transaction } from './database.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import { prepareRaceManualSemanticBasisV2In } from './race-manual-review-semantic-basis-v2.js';
import { storeRaceManualReviewChainV2In } from './race-manual-review-chain-v2.js';
import {
  prepareRaceManualApprovalIn,
  approveRaceManualApplicationFromStoredCaptureIn,
} from './race-manual-approval.js';
import {
  projectRaceManualPublicPreview,
  raceManualPublicPreviewSourceSchema,
} from './race-manual-public-preview.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';
import {
  raceManualPublicImpactSchema,
  type RaceManualPublicImpact,
} from '@workout/contracts/race-manual-public-impact';
import { previewRacePlanImpactTransaction } from './race-plan-impact-preview.js';
import {
  projectRaceManualPublicImpact,
  RaceManualPublicImpactError,
} from './race-manual-public-impact.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const prepareCommand = raceManualPublicPrepareSchema.extend({ idempotencyKey: key });
const approveCommand = raceManualPublicApproveSchema.extend({
  idempotencyKey: key,
  candidateId: uuid,
});
export const raceManualPublicReferenceSchema = raceManualStoredApprovalReferenceSchema;
export type RaceManualPublicReference = z.infer<typeof raceManualPublicReferenceSchema>;
const storedSchema = raceManualStoredApprovalReadSchema;
export class RaceManualPublicError extends Error {
  constructor(
    readonly code:
      | 'PUBLIC_REFERENCE_UNAVAILABLE'
      | 'PUBLIC_APPLICATION_UNAVAILABLE'
      | 'PUBLIC_PORT_UNAVAILABLE'
      | 'PUBLIC_RESPONSE_LIMIT'
      | 'PUBLIC_INVALID_RESPONSE',
  ) {
    super(code);
  }
}
/** Must leave the transaction callback by throwing: a blocked application may
 * follow chain insertion. Catch only outside snapshotTenant to roll back all. */
class ReviewBlocked extends Error {
  constructor(readonly stage: 'semantic' | 'chain' | 'application') {
    super('PUBLIC_REVIEW_BLOCKED');
  }
}
type Options = { now?: () => Date; createId?: () => string };
async function sql(
  tx: Transaction,
  expression: string,
  args: unknown[],
  budget: SourceBudget,
): Promise<unknown> {
  validateRaceSourceResponseBudget(budget);
  reserveSourceBudget(budget, 0n, 1);
  const remaining = 4194304n - budget.bytes;
  const response = z
    .strictObject({ bytes: z.string().regex(/^(0|[1-9][0-9]*)$/), value: z.unknown() })
    .parse(
      (
        await tx.query(
          `WITH observed AS MATERIALIZED (SELECT ${expression} AS value), measured AS MATERIALIZED (SELECT value,octet_length(COALESCE(value::text,'null'))::bigint AS bytes FROM observed) SELECT bytes::text AS bytes,CASE WHEN bytes <= $${args.length + 1}::bigint THEN value ELSE NULL END AS value FROM measured`,
          [...args, remaining.toString()],
        )
      ).rows[0],
    );
  const bytes = BigInt(response.bytes);
  if (bytes > remaining) throw new RaceManualPublicError('PUBLIC_RESPONSE_LIMIT');
  reserveSourceBudget(budget, bytes, 0);
  assertRaceManualPlainV2(response.value);
  return response.value;
}
function checkedReference(raw: unknown): RaceManualPublicReference {
  return raceManualPublicReferenceSchema.parse(raw);
}
async function stored(tx: Transaction, id: string, budget: SourceBudget) {
  const raw = await sql(tx, 'public.read_race_manual_public_candidate_v1($1::uuid)', [id], budget);
  if (raw === null) return null;
  const read = storedSchema.parse(raw);
  if (read.reference.candidateId !== id) throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
  if (
    read.bodyState === 'present' &&
    (read.candidate.candidateId !== id ||
      read.candidate.applicationDigest !== read.reference.applicationDigest ||
      JSON.stringify(read.candidate.chain) !== JSON.stringify(read.reference.chain) ||
      read.basis.athleteId !== tx.athleteId ||
      read.lifecycle.athleteId !== tx.athleteId ||
      read.candidate.createdAt !== read.reference.createdAt)
  )
    throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
  return read;
}
/** Internal-only command combines trusted header/path scalars with the strict
 * public DTO. Unknown basis/context/recipe fields are never accepted. */
export async function reviewRaceManualPublicIn(
  tx: Transaction,
  raw: unknown,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
  options: Options = {},
) {
  assertRaceManualPlainV2(raw);
  const command = prepareCommand.parse(raw);
  const request = JSON.stringify(command);
  const replay = await sql(
    tx,
    'public.read_race_manual_public_receipt_v1($1::text,$2::text,$3::jsonb)',
    ['review', command.idempotencyKey, request],
    budget,
  );
  if (replay !== null) {
    const reference = checkedReference(replay);
    const read = await stored(tx, reference.candidateId, budget);
    if (!read) throw new RaceManualPublicError('PUBLIC_REFERENCE_UNAVAILABLE');
    if (JSON.stringify(read.reference) !== JSON.stringify(reference))
      throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
    return { status: 'reviewed' as const, reference, bodyState: read.bodyState };
  }
  const continuation = (await hasRaceManualSameTxReviewCapabilityIn(tx, budget))
    ? await captureRaceManualSameTxReviewContinuationIn(tx, command.intent, budget)
    : null;
  const current =
    continuation === null
      ? await prepareRaceManualSemanticBasisV2In(tx, command.intent, null, budget)
      : null;
  if (continuation?.status === 'blocked') throw new ReviewBlocked(continuation.stage);
  if (current !== null && current.status !== 'current_dependencies_captured')
    throw new ReviewBlocked('semantic');
  const basis =
    continuation?.status === 'captured'
      ? continuation.basis
      : current?.status === 'current_dependencies_captured'
        ? current.basis
        : null;
  if (basis === null) throw new ReviewBlocked('semantic');
  const handle = continuation?.status === 'captured' ? continuation.handle : null;
  try {
    // SQL jsonb canonical namespace hash, not JSON.stringify digest or credential.
    const namespace = digest.parse(
      await sql(
        tx,
        "encode(sha256(convert_to(jsonb_build_object('tenant',$1::text,'operation','review','publicKey',$2::text)::text,'UTF8')),'hex')",
        [tx.athleteId, command.idempotencyKey],
        budget,
      ),
    );
    const chainStore =
      handle === null
        ? storeRaceManualReviewChainV2In
        : (tx: Transaction, raw: unknown, budget: SourceBudget, ids: () => string) =>
            storeRaceManualReviewSameTxChainIn(tx, raw, handle, budget, ids);
    const chain = await chainStore(
      tx,
      {
        schemaVersion: 2,
        idempotencyKey: `race_public_review_v1_${namespace}`,
        intent: command.intent,
        expectedBasis: basis,
      },
      budget,
      options.createId ?? randomUUID,
    );
    if (chain.status === 'blocked') throw new ReviewBlocked('chain');
    const refs = {
      evidenceId: chain.result.evidenceId,
      decisionId: chain.result.decisionId,
      proposalId: chain.result.proposalId,
      readonlyCandidateDigest: chain.result.candidateDigest,
    };
    const applicationInput = {
      schemaVersion: 1,
      chain: refs,
      intent: command.intent,
      expectedBasis: basis,
    };
    const application =
      handle !== null && chain.status === 'stored'
        ? await prepareRaceManualSameTxApprovalIn(tx, applicationInput, handle, budget, options)
        : await prepareRaceManualApprovalIn(tx, applicationInput, budget, options);
    if (application.status !== 'prepared') throw new ReviewBlocked('application');
    const reference = checkedReference(
      await sql(
        tx,
        'public.finish_race_manual_public_review_v1($1::text,$2::jsonb,$3::uuid)',
        [command.idempotencyKey, request, application.candidate.candidateId],
        budget,
      ),
    );
    if (
      reference.candidateId !== application.candidate.candidateId ||
      reference.applicationDigest !== application.candidate.applicationDigest
    )
      throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
    return { status: 'reviewed' as const, reference, bodyState: 'present' as const };
  } finally {
    invalidateRaceManualSameTxReviewContinuation(handle);
  }
}
export async function approveRaceManualPublicIn(
  tx: Transaction,
  raw: unknown,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
  options: Options = {},
) {
  assertRaceManualPlainV2(raw);
  const command = approveCommand.parse(raw),
    request = JSON.stringify(command);
  const replay = await sql(
    tx,
    'public.read_race_manual_public_approval_v1($1::text,$2::jsonb)',
    [command.idempotencyKey, request],
    budget,
  );
  if (replay !== null) {
    const original = raceManualApprovalResultSchema.parse(replay);
    if (original.candidateId !== command.candidateId)
      throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
    const alias = raceManualApprovalResultSchema.parse(
      await sql(
        tx,
        'public.finish_race_manual_public_approval_v1($1::text,$2::jsonb)',
        [command.idempotencyKey, request],
        budget,
      ),
    );
    if (JSON.stringify(alias) !== JSON.stringify(original))
      throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
    return alias;
  }
  const continuation = createRaceManualSameTxApprovalContinuation();
  const read = await continuation.capture(tx, command.candidateId, budget);
  try {
    if (
      !read ||
      read.bodyState !== 'present' ||
      read.candidate.applicationState !== 'ready_for_explicit_approval' ||
      read.reference.applicationDigest !== command.applicationDigest
    )
      throw new RaceManualPublicError('PUBLIC_APPLICATION_UNAVAILABLE');
    const candidate = read.candidate;
    const internal = raceManualApprovalCommandSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `race_public_approve_v1_${digest.parse(
        await sql(
          tx,
          "encode(sha256(convert_to(jsonb_build_object('tenant',$1::text,'operation','approve','publicKey',$2::text)::text,'UTF8')),'hex')",
          [tx.athleteId, command.idempotencyKey],
          budget,
        ),
      )}`,
      candidateId: candidate.candidateId,
      applicationDigest: candidate.applicationDigest,
      chain: candidate.chain,
      raceChange: candidate.raceChange,
      expectation: candidate.expectation,
      confirmed: true,
    });
    const result = await approveRaceManualApplicationFromStoredCaptureIn(
      tx,
      internal,
      continuation,
      read.handle,
      budget,
      options,
    );
    const committed = raceManualApprovalResultSchema.parse(
      await sql(
        tx,
        'public.finish_race_manual_public_approval_v1($1::text,$2::jsonb)',
        [command.idempotencyKey, request],
        budget,
      ),
    );
    if (JSON.stringify(committed) !== JSON.stringify(result))
      throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
    return committed;
  } finally {
    if (read?.bodyState === 'present') continuation.invalidate(read.handle);
  }
}
/** Internal SQL body is validated but never returned through this public-facing
 * service. Retained read makes no fresh processing/admission claim. */
export async function readRaceManualPublicCandidateIn(
  tx: Transaction,
  rawId: unknown,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
) {
  const id = uuid.parse(rawId),
    read = await stored(tx, id, budget);
  return read
    ? { status: 'retained' as const, reference: read.reference, bodyState: read.bodyState }
    : null;
}
/** Select only frozen linked bodies. Mutable heads cannot stand in for before.
 * Snapshot isolation is supplied by the repository. This retained view does
 * not establish fresh approval eligibility or perform new source processing. */
export async function readRaceManualPublicPreviewIn(
  tx: Transaction,
  rawId: unknown,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
) {
  const id = uuid.parse(rawId);
  const raw = await sql(
    tx,
    'public.read_race_manual_public_preview_source_v1($1::uuid)',
    [id],
    budget,
  );
  if (raw === null) return null;
  const source = raceManualPublicPreviewSourceSchema.parse(raw);
  if (
    source.reference.candidateId !== id ||
    (source.bodyState === 'present' && source.preparation.context.athleteId !== tx.athleteId)
  )
    throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
  return projectRaceManualPublicPreview(raw);
}
/** Fresh processing diagnostic in the caller's fenced snapshot. It creates no
 * review, receipt, candidate, plan version or approval authority. */
export async function impactRaceManualPublicIn(
  tx: Transaction,
  raw: unknown,
  budget: SourceBudget = { bytes: 0n, sources: 0 },
): Promise<RaceManualPublicImpact> {
  assertRaceManualPlainV2(raw);
  const command = raceManualPublicPrepareSchema.parse(raw);
  const preview = await previewRacePlanImpactTransaction(tx, command.intent, budget);
  if (preview.context.athleteId !== tx.athleteId)
    throw new RaceManualPublicError('PUBLIC_INVALID_RESPONSE');
  try {
    // The first blocked capture need not have a calendar intent. Do not invent
    // one or turn that incomplete context into a projected source.
    const result =
      preview.projection.status === 'blocked'
        ? raceManualPublicImpactSchema.parse({
            schemaVersion: 1,
            status: 'blocked',
            approvalAllowed: false,
            persistence: 'not_stored',
            freshness: 'not_checked',
            domains: [],
            reason:
              preview.projection.reason === 'projection_bound'
                ? 'limit_exceeded'
                : preview.projection.reason === 'event_revision_conflict'
                  ? 'stale_basis'
                  : 'source_unavailable',
          })
        : projectRaceManualPublicImpact({ context: preview.context, intent: command.intent });
    const responseBytes = BigInt(Buffer.byteLength(JSON.stringify(result), 'utf8'));
    if (responseBytes > 4194304n - budget.bytes)
      throw new RaceManualPublicError('PUBLIC_RESPONSE_LIMIT');
    reserveSourceBudget(budget, responseBytes, 0);
    return result;
  } catch (error) {
    if (error instanceof RaceManualPublicImpactError)
      throw new RaceManualPublicError(
        error.code === 'PUBLIC_IMPACT_LIMIT' ? 'PUBLIC_RESPONSE_LIMIT' : 'PUBLIC_INVALID_RESPONSE',
      );
    throw error;
  }
}
export function createRaceManualPublicRepository(database: Database, options: Options = {}) {
  function snapshot<T>(athleteId: string, apply: (tx: Transaction) => Promise<T>) {
    if (!database.snapshotTenant) throw new RaceManualPublicError('PUBLIC_PORT_UNAVAILABLE');
    return database.snapshotTenant(athleteId, apply);
  }
  return {
    async impact(athleteId: string, raw: unknown): Promise<RaceManualPublicImpact> {
      assertRaceManualPlainV2(raw);
      const command = raceManualPublicPrepareSchema.parse(raw);
      return snapshot(athleteId, (tx) => impactRaceManualPublicIn(tx, command));
    },
    async review(athleteId: string, raw: unknown) {
      assertRaceManualPlainV2(raw);
      const command = prepareCommand.parse(raw);
      try {
        return await snapshot(athleteId, (tx) =>
          reviewRaceManualPublicIn(tx, command, { bytes: 0n, sources: 0 }, options),
        );
      } catch (error) {
        if (error instanceof ReviewBlocked)
          return { status: 'blocked' as const, stage: error.stage };
        throw error;
      }
    },
    approve(athleteId: string, raw: unknown) {
      assertRaceManualPlainV2(raw);
      const command = approveCommand.parse(raw);
      return snapshot(athleteId, (tx) =>
        approveRaceManualPublicIn(tx, command, { bytes: 0n, sources: 0 }, options),
      );
    },
    async readPreview(athleteId: string, rawId: unknown) {
      const id = uuid.parse(rawId);
      return snapshot(athleteId, (tx) => readRaceManualPublicPreviewIn(tx, id));
    },
    read(athleteId: string, rawId: unknown) {
      const id = uuid.parse(rawId);
      return database.tenant(athleteId, (tx) => readRaceManualPublicCandidateIn(tx, id));
    },
  };
}
