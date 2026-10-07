import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  raceManualPublicPrepareSchema,
  raceManualPublicApproveSchema,
} from '@workout/contracts/race-manual-public';
import {
  raceManualApprovalCandidateSchema,
  raceManualApprovalCommandSchema,
  raceManualApprovalResultSchema,
} from '@workout/contracts/race-manual-approval';
import type { Database, Transaction } from './database.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import {
  prepareRaceManualSemanticBasisV2In,
  raceManualSemanticBasisV2Schema,
} from './race-manual-review-semantic-basis-v2.js';
import { storeRaceManualReviewChainV2In } from './race-manual-review-chain-v2.js';
import {
  prepareRaceManualApprovalIn,
  approveRaceManualApplicationIn,
} from './race-manual-approval.js';
import { raceManualReviewLifecycleInventoryV2Schema } from './race-manual-review-lifecycle-inventory-v2.js';
import {
  projectRaceManualPublicPreview,
  raceManualPublicPreviewSourceSchema,
} from './race-manual-public-preview.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';

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
export const raceManualPublicReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateId: uuid,
  applicationDigest: digest,
  chain: raceManualApprovalCommandSchema.out.shape.chain,
  createdAt: z.iso.datetime({ offset: true }),
});
export type RaceManualPublicReference = z.infer<typeof raceManualPublicReferenceSchema>;
const storedSchema = z.discriminatedUnion('bodyState', [
  z.strictObject({
    reference: raceManualPublicReferenceSchema,
    bodyState: z.literal('present'),
    candidate: raceManualApprovalCandidateSchema,
    basis: raceManualSemanticBasisV2Schema,
    lifecycle: raceManualReviewLifecycleInventoryV2Schema,
  }),
  z.strictObject({
    reference: raceManualPublicReferenceSchema,
    bodyState: z.literal('purged'),
    candidate: z.null(),
    basis: z.null(),
    lifecycle: z.null(),
  }),
]);
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
  const current = await prepareRaceManualSemanticBasisV2In(tx, command.intent, null, budget);
  if (current.status !== 'current_dependencies_captured') throw new ReviewBlocked('semantic');
  // SQL jsonb canonical namespace hash, not JSON.stringify digest or credential.
  const namespace = digest.parse(
    await sql(
      tx,
      "encode(sha256(convert_to(jsonb_build_object('tenant',$1::text,'operation','review','publicKey',$2::text)::text,'UTF8')),'hex')",
      [tx.athleteId, command.idempotencyKey],
      budget,
    ),
  );
  const chain = await storeRaceManualReviewChainV2In(
    tx,
    {
      schemaVersion: 2,
      idempotencyKey: `race_public_review_v1_${namespace}`,
      intent: command.intent,
      expectedBasis: current.basis,
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
  const application = await prepareRaceManualApprovalIn(
    tx,
    { schemaVersion: 1, chain: refs, intent: command.intent, expectedBasis: current.basis },
    budget,
    options,
  );
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
  const read = await stored(tx, command.candidateId, budget);
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
  const result = await approveRaceManualApplicationIn(tx, internal, budget, options);
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
export function createRaceManualPublicRepository(database: Database, options: Options = {}) {
  function snapshot<T>(athleteId: string, apply: (tx: Transaction) => Promise<T>) {
    if (!database.snapshotTenant) throw new RaceManualPublicError('PUBLIC_PORT_UNAVAILABLE');
    return database.snapshotTenant(athleteId, apply);
  }
  return {
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
