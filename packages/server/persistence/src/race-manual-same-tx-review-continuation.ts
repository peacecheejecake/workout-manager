import { ackRaceManualPooledChainTransportV1In } from './race-manual-pooled-chain-transport-v1.js';
import { z } from 'zod';
import type { Transaction } from './database.js';
import { prepareRaceManualSemanticBasisV2In } from './race-manual-review-semantic-basis-v2.js';
import { captureRaceManualReviewCompatibleLifecycleInventoryIn } from './race-manual-review-lifecycle-inventory-v2.js';
import { raceManualReviewChainResultV2Schema } from './race-manual-review-chain-v2.js';
import type { RaceManualReviewChainResultV2 } from './race-manual-review-chain-v2.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';
import { raceProjectionIntentSchema } from './race-plan-impact-projection-input.js';

type Current = Extract<
  Awaited<ReturnType<typeof prepareRaceManualSemanticBasisV2In>>,
  { status: 'current_dependencies_captured' }
>;
type Lifecycle = Awaited<ReturnType<typeof captureRaceManualReviewCompatibleLifecycleInventoryIn>>;
export type RaceManualSameTxReviewContinuation = Readonly<object>;
export class RaceManualSameTxReviewContinuationError extends Error {
  readonly code = 'SAME_TX_REVIEW_CONTINUATION_INVALID';
  constructor() {
    super('SAME_TX_REVIEW_CONTINUATION_INVALID');
  }
}
const signature = 'public.ack_manual_race_same_tx_parent_v1(uuid,uuid,uuid,text,jsonb)';
const anchorSchema = z.strictObject({
  xid: z.string().regex(/^[1-9][0-9]*$/),
  role: z.string().min(1).max(63),
  athleteId: z.string().min(1).max(200),
  isolation: z.enum(['repeatable read', 'serializable']),
  readOnly: z.literal(false),
});
type Anchor = z.infer<typeof anchorSchema>;
interface Entry {
  tx: Transaction;
  anchor: Anchor;
  current: Current;
  lifecycle: Lifecycle;
  fingerprint: string;
  intentDigest: string;
  phase: 'captured' | 'storing' | 'stored' | 'preparing' | 'consumed' | 'invalid';
  result?: RaceManualReviewChainResultV2;
}
const entries = new WeakMap<object, Entry>();
function invalid(): never {
  throw new RaceManualSameTxReviewContinuationError();
}
function contentDigest(e: Pick<Entry, 'current' | 'lifecycle'>) {
  return impactDependencyDigest({ current: e.current, lifecycle: e.lifecycle });
}
/** Scalar bodies are measured by PostgreSQL before crossing the driver boundary.
 * Local compact bytes detect an underreported synthetic/invalid driver envelope. */
async function measuredScalar(
  tx: Transaction,
  expression: string,
  values: unknown[],
  budget: SourceBudget,
) {
  validateRaceSourceResponseBudget(budget);
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
  const parsed = z
    .strictObject({ bytes: z.string().regex(/^(0|[1-9][0-9]*)$/), value: z.unknown() })
    .safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success) invalid();
  const bytes = BigInt(parsed.data.bytes);
  if (bytes > remaining)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  assertRaceManualPlainV2(parsed.data.value);
  if (BigInt(Buffer.byteLength(JSON.stringify(parsed.data.value), 'utf8')) > bytes) invalid();
  reserveSourceBudget(budget, bytes, 1);
  return parsed.data.value;
}
async function anchor(tx: Transaction, budget: SourceBudget): Promise<Anchor> {
  const parsed = anchorSchema.safeParse(
    await measuredScalar(
      tx,
      `jsonb_build_object('xid',txid_current()::text,'role',current_user::text,
 'athleteId',current_setting('app.athlete_id',true),'isolation',current_setting('transaction_isolation'),
 'readOnly',current_setting('transaction_read_only')='on')`,
      [],
      budget,
    ),
  );
  if (!parsed.success || parsed.data.athleteId !== tx.athleteId) invalid();
  return parsed.data;
}
export async function hasRaceManualSameTxReviewCapabilityIn(tx: Transaction, budget: SourceBudget) {
  const result = z
    .strictObject({ installed: z.boolean(), executable: z.boolean() })
    .safeParse(
      await measuredScalar(
        tx,
        `jsonb_build_object('installed',to_regprocedure($1) IS NOT NULL,'executable',coalesce(has_function_privilege(current_user,to_regprocedure($1),'EXECUTE'),false))`,
        [signature],
        budget,
      ),
    );
  if (!result.success || (!result.data.installed && result.data.executable)) invalid();
  return result.data.installed && result.data.executable;
}
/** Only actual preparation mints a handle. No caller witness, hash or Current
 * JSON can enter this factory. Same-tx reuse is not processing/approval authority. */
export async function captureRaceManualSameTxReviewContinuationIn(
  tx: Transaction,
  unknownIntent: unknown,
  budget: SourceBudget,
) {
  assertRaceManualPlainV2(unknownIntent);
  const intent = raceProjectionIntentSchema.parse(unknownIntent);
  const a = await anchor(tx, budget);
  const current = await prepareRaceManualSemanticBasisV2In(tx, intent, null, budget);
  if (current.status !== 'current_dependencies_captured')
    return { status: 'blocked' as const, stage: 'semantic' as const };
  const lifecycle = await captureRaceManualReviewCompatibleLifecycleInventoryIn(
    tx,
    current.prepared.retained,
    budget,
  );
  if (lifecycle.status !== 'dependency_correspondence')
    return { status: 'blocked' as const, stage: 'chain' as const };
  const handle = Object.freeze({});
  const entry: Entry = {
    tx,
    anchor: a,
    current,
    lifecycle,
    fingerprint: contentDigest({ current, lifecycle }),
    intentDigest: impactDependencyDigest(intent),
    phase: 'captured',
  };
  entries.set(handle, entry);
  return { status: 'captured' as const, handle, basis: current.basis };
}
async function checked(
  tx: Transaction,
  handle: unknown,
  phase: Entry['phase'],
  intent: unknown,
  basis: unknown,
  budget: SourceBudget,
) {
  if (handle === null || typeof handle !== 'object') invalid();
  const e = entries.get(handle);
  if (!e || e.tx !== tx || e.phase !== phase || e.anchor.athleteId !== tx.athleteId) invalid();
  // Claim the next state synchronously before the first await: concurrent calls
  // cannot both pass the captured/stored phase check.
  e.phase = phase === 'captured' ? 'storing' : 'preparing';
  try {
    assertRaceManualPlainV2(intent);
    assertRaceManualPlainV2(basis);
    if (
      impactDependencyDigest(raceProjectionIntentSchema.parse(intent)) !== e.intentDigest ||
      impactDependencyDigest(basis) !== impactDependencyDigest(e.current.basis) ||
      contentDigest(e) !== e.fingerprint
    ) {
      e.phase = 'invalid';
      invalid();
    }
    const now = await anchor(tx, budget);
    if (impactDependencyDigest(now) !== impactDependencyDigest(e.anchor)) {
      e.phase = 'invalid';
      invalid();
    }
  } catch (error) {
    e.phase = 'invalid';
    throw error;
  }
  return e;
}
async function storeContinuation(
  protocol: 'legacy' | 'pooled',
  tx: Transaction,
  handle: unknown,
  intent: unknown,
  basis: unknown,
  budget: SourceBudget,
  persist: (current: Current, lifecycle: Lifecycle) => Promise<RaceManualReviewChainResultV2>,
) {
  const e = await checked(tx, handle, 'captured', intent, basis, budget);
  try {
    const result = raceManualReviewChainResultV2Schema.parse(await persist(e.current, e.lifecycle));
    // The pooled ACK transport performs the frozen strict logical-to-encoded
    // codec checks. Its individually bounded logical roots are not a legacy
    // whole-frame 4MiB transport. Legacy ingress remains unchanged.
    if (protocol === 'legacy') assertRaceManualPlainV2(e.current.prepared.retained);
    const candidate = e.current.prepared.retained.payload.preparation.candidate;
    if (candidate.status !== 'assembled_readonly' || result.candidateDigest !== candidate.digest)
      invalid();
    if (protocol === 'pooled') {
      await ackRaceManualPooledChainTransportV1In(tx, result, e.current.prepared.retained, budget);
    } else {
      validateRaceSourceResponseBudget(budget);
      const remaining = 4194304n - budget.bytes;
      // Actual protected store context/current xid must be acknowledged by SQL131.
      // The driver receives only a measured minimal ACK, never a second parent body.
      const rows = (
        await tx.query(
          `WITH observed AS MATERIALIZED (
 SELECT public.ack_manual_race_same_tx_parent_v1($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb) value),
 measured AS MATERIALIZED (SELECT value,octet_length(coalesce(value::text,'null'))::bigint bytes FROM observed)
 SELECT bytes::text bytes,CASE WHEN bytes <= $6::bigint THEN value ELSE NULL END value FROM measured`,
          [
            result.evidenceId,
            result.decisionId,
            result.proposalId,
            result.candidateDigest,
            JSON.stringify(e.current.prepared.retained),
            remaining.toString(),
          ],
        )
      ).rows;
      assertRaceManualPlainV2(rows);
      const response = z
        .strictObject({ bytes: z.string().regex(/^(0|[1-9][0-9]*)$/), value: z.unknown() })
        .safeParse(rows[0]);
      if (rows.length !== 1 || !response.success) invalid();
      if (BigInt(response.data.bytes) > remaining)
        throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
      assertRaceManualPlainV2(response.data.value);
      if (
        Buffer.byteLength(JSON.stringify(response.data.value), 'utf8') > Number(response.data.bytes)
      )
        invalid();
      reserveSourceBudget(budget, BigInt(response.data.bytes));
      const ack = z
        .strictObject({
          ackVersion: z.literal(1),
          result: raceManualReviewChainResultV2Schema,
          bodyState: z.literal('present'),
          payloadDigestMethod: z.literal('postgres-jsonb-v1'),
          payloadSqlDigest: z.string().regex(/^[a-f0-9]{64}$/),
          correspondence: z.literal('same_tx_stored_parent'),
        })
        .parse(response.data.value);
      if (
        impactDependencyDigest(ack.result) !== impactDependencyDigest(result) ||
        contentDigest(e) !== e.fingerprint
      )
        invalid();
    }
    if (contentDigest(e) !== e.fingerprint) invalid();
    // Recheck the actual backend identity after the asynchronous store/ACK.
    if (impactDependencyDigest(await anchor(tx, budget)) !== impactDependencyDigest(e.anchor))
      invalid();
    e.result = result;
    e.phase = 'stored';
    return result;
  } catch (error) {
    e.phase = 'invalid';
    throw error;
  }
}
type StoreContinuationArguments = [
  tx: Transaction,
  handle: unknown,
  intent: unknown,
  basis: unknown,
  budget: SourceBudget,
  persist: (current: Current, lifecycle: Lifecycle) => Promise<RaceManualReviewChainResultV2>,
];
export function storeRaceManualSameTxReviewContinuationIn(...args: StoreContinuationArguments) {
  return storeContinuation('legacy', ...args);
}
/** Fixed private successor selection. Caller JSON cannot select the ACK codec. */
export function storeRaceManualPooledSameTxReviewContinuationIn(
  ...args: StoreContinuationArguments
) {
  return storeContinuation('pooled', ...args);
}
export async function prepareRaceManualSameTxReviewApplicationIn<T>(
  tx: Transaction,
  handle: unknown,
  intent: unknown,
  basis: unknown,
  chain: unknown,
  budget: SourceBudget,
  prepare: (current: Current, lifecycle: Lifecycle) => Promise<T>,
): Promise<T> {
  const e = await checked(tx, handle, 'stored', intent, basis, budget);
  const r = e.result;
  try {
    assertRaceManualPlainV2(chain);
    if (
      !r ||
      impactDependencyDigest(chain) !==
        impactDependencyDigest({
          evidenceId: r.evidenceId,
          decisionId: r.decisionId,
          proposalId: r.proposalId,
          readonlyCandidateDigest: r.candidateDigest,
        })
    )
      invalid();
    const result = await prepare(e.current, e.lifecycle);
    if (
      contentDigest(e) !== e.fingerprint ||
      impactDependencyDigest(await anchor(tx, budget)) !== impactDependencyDigest(e.anchor)
    )
      invalid();
    e.phase = 'consumed';
    return result;
  } catch (error) {
    e.phase = 'invalid';
    throw error;
  }
}
export function invalidateRaceManualSameTxReviewContinuation(handle: unknown) {
  if (handle !== null && typeof handle === 'object') {
    const e = entries.get(handle);
    if (e) e.phase = 'invalid';
  }
}
