import { z } from 'zod';
import {
  raceManualApprovalCandidateSchema,
  raceManualApprovalCommandSchema,
} from '@workout/contracts/race-manual-approval';
import type { Transaction } from './database.js';
import { raceManualSemanticBasisV2Schema } from './race-manual-review-semantic-basis-v2.js';
import { raceManualReviewLifecycleInventoryV2Schema } from './race-manual-review-lifecycle-inventory-v2.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import {
  impactDependencyDigest,
  RaceImpactDependencyError,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
export const raceManualStoredApprovalReferenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateId: uuid,
  applicationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  chain: raceManualApprovalCommandSchema.out.shape.chain,
  createdAt: z.iso.datetime({ offset: true }),
});
export const raceManualStoredApprovalReadSchema = z.discriminatedUnion('bodyState', [
  z.strictObject({
    reference: raceManualStoredApprovalReferenceSchema,
    bodyState: z.literal('present'),
    candidate: raceManualApprovalCandidateSchema,
    basis: raceManualSemanticBasisV2Schema,
    lifecycle: raceManualReviewLifecycleInventoryV2Schema,
  }),
  z.strictObject({
    reference: raceManualStoredApprovalReferenceSchema,
    bodyState: z.literal('purged'),
    candidate: z.null(),
    basis: z.null(),
    lifecycle: z.null(),
  }),
]);
type Present = Extract<
  z.infer<typeof raceManualStoredApprovalReadSchema>,
  { bodyState: 'present' }
>;
const anchorSchema = z.strictObject({
  xid: z.string().regex(/^[1-9][0-9]*$/),
  role: z.string().min(1).max(63),
  sessionRole: z.string().min(1).max(63),
  athleteId: z.string().min(1).max(200),
  isolation: z.enum(['repeatable read', 'serializable']),
  readOnly: z.literal(false),
});
type Anchor = z.infer<typeof anchorSchema>;
export class RaceManualSameTxApprovalContinuationError extends Error {
  readonly code = 'SAME_TX_APPROVAL_CONTINUATION_INVALID';
  constructor() {
    super('SAME_TX_APPROVAL_CONTINUATION_INVALID');
  }
}
function invalid(): never {
  throw new RaceManualSameTxApprovalContinuationError();
}
async function measured(
  tx: Transaction,
  expression: string,
  values: unknown[],
  budget: SourceBudget,
) {
  validateRaceSourceResponseBudget(budget);
  reserveSourceBudget(budget, 0n, 1);
  const remaining = 4194304n - budget.bytes;
  const rows = (
    await tx.query(
      `WITH observed AS MATERIALIZED (SELECT ${expression} value),
 measured AS MATERIALIZED (SELECT value,octet_length(coalesce(value::text,'null'))::bigint bytes FROM observed)
 SELECT bytes::text bytes,CASE WHEN bytes <= $${values.length + 1}::bigint THEN value ELSE NULL END value FROM measured`,
      [...values, remaining.toString()],
    )
  ).rows;
  assertRaceManualPlainV2(rows);
  const row = z
    .strictObject({ bytes: z.string().regex(/^(0|[1-9][0-9]*)$/), value: z.unknown() })
    .safeParse(rows[0]);
  if (rows.length !== 1 || !row.success) invalid();
  const bytes = BigInt(row.data.bytes);
  if (bytes > remaining)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  assertRaceManualPlainV2(row.data.value);
  if (BigInt(Buffer.byteLength(JSON.stringify(row.data.value), 'utf8')) > bytes) invalid();
  reserveSourceBudget(budget, bytes, 0);
  return row.data.value;
}
async function anchor(tx: Transaction, budget: SourceBudget) {
  const a = anchorSchema.parse(
    await measured(
      tx,
      `jsonb_build_object('xid',txid_current()::text,
 'role',current_user::text,'sessionRole',session_user::text,'athleteId',current_setting('app.athlete_id',true),
 'isolation',current_setting('transaction_isolation'),'readOnly',current_setting('transaction_read_only')='on')`,
      [],
      budget,
    ),
  );
  if (a.athleteId !== tx.athleteId || a.role !== a.sessionRole) invalid();
  return a;
}
/** Factory-scoped, process-private capture. Only this protected RPC can mint a
 * handle; caller JSON, reference and hashes are never capture credentials. */
const factories = new WeakSet<object>();
export function assertRaceManualSameTxApprovalContinuation(
  factory: unknown,
): asserts factory is RaceManualSameTxApprovalContinuation {
  if (factory === null || typeof factory !== 'object' || !factories.has(factory)) invalid();
}
export function createRaceManualSameTxApprovalContinuation() {
  const entries = new WeakMap<
    object,
    {
      tx: Transaction;
      anchor: Anchor;
      stored: Present;
      fingerprint: string;
      phase: 'captured' | 'consuming' | 'invalid';
    }
  >();
  function invalidate(handle: unknown) {
    if (handle !== null && typeof handle === 'object') {
      const e = entries.get(handle);
      if (e) e.phase = 'invalid';
    }
  }
  const factory = {
    invalidate,
    async capture(tx: Transaction, unknownId: unknown, budget: SourceBudget) {
      const id = uuid.parse(unknownId);
      const a = await anchor(tx, budget);
      const raw = await measured(
        tx,
        'public.read_race_manual_public_candidate_v1($1::uuid)',
        [id],
        budget,
      );
      if (raw === null) return null;
      const read = raceManualStoredApprovalReadSchema.parse(raw);
      if (read.reference.candidateId !== id) invalid();
      if (read.bodyState === 'purged')
        return { bodyState: 'purged' as const, reference: read.reference };
      if (
        read.candidate.candidateId !== id ||
        read.candidate.applicationDigest !== read.reference.applicationDigest ||
        impactDependencyDigest(read.candidate.chain) !==
          impactDependencyDigest(read.reference.chain) ||
        read.candidate.createdAt !== read.reference.createdAt ||
        read.basis.athleteId !== tx.athleteId ||
        read.lifecycle.athleteId !== tx.athleteId
      )
        invalid();
      if (impactDependencyDigest(await anchor(tx, budget)) !== impactDependencyDigest(a)) invalid();
      const stored = raceManualStoredApprovalReadSchema.parse(structuredClone(read));
      if (stored.bodyState !== 'present') invalid();
      const handle = Object.freeze({});
      entries.set(handle, {
        tx,
        anchor: a,
        stored,
        fingerprint: impactDependencyDigest(stored),
        phase: 'captured',
      });
      return {
        bodyState: 'present' as const,
        handle,
        reference: structuredClone(read.reference),
        candidate: structuredClone(read.candidate),
      };
    },
    async consume<T>(
      tx: Transaction,
      handle: unknown,
      unknownCommand: unknown,
      budget: SourceBudget,
      callback: (stored: Present) => Promise<T>,
    ): Promise<T> {
      if (handle === null || typeof handle !== 'object') invalid();
      const e = entries.get(handle);
      if (!e || e.tx !== tx || e.phase !== 'captured' || e.anchor.athleteId !== tx.athleteId)
        invalid();
      e.phase = 'consuming';
      try {
        assertRaceManualPlainV2(unknownCommand);
        const command = raceManualApprovalCommandSchema.parse(unknownCommand),
          c = e.stored.candidate;
        if (
          command.candidateId !== c.candidateId ||
          command.applicationDigest !== c.applicationDigest ||
          impactDependencyDigest([command.chain, command.raceChange, command.expectation]) !==
            impactDependencyDigest([c.chain, c.raceChange, c.expectation]) ||
          impactDependencyDigest(e.stored) !== e.fingerprint ||
          impactDependencyDigest(await anchor(tx, budget)) !== impactDependencyDigest(e.anchor)
        )
          invalid();
        const copy = raceManualStoredApprovalReadSchema.parse(structuredClone(e.stored));
        if (copy.bodyState !== 'present') invalid();
        const result = await callback(copy);
        if (
          impactDependencyDigest(e.stored) !== e.fingerprint ||
          impactDependencyDigest(await anchor(tx, budget)) !== impactDependencyDigest(e.anchor)
        )
          invalid();
        return result;
      } finally {
        e.phase = 'invalid';
      }
    },
  };
  factories.add(factory);
  return Object.freeze(factory);
}
export type RaceManualSameTxApprovalContinuation = ReturnType<
  typeof createRaceManualSameTxApprovalContinuation
>;
