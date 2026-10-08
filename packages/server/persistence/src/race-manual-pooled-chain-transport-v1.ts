import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from './database.js';
import {
  raceManualReviewChainCommandV2Schema,
  raceManualReviewChainResultV2Schema,
} from './race-manual-review-chain-v2.js';
import { raceManualSemanticBasisV2Schema } from './race-manual-review-semantic-basis-v2.js';
import { raceManualReviewLifecycleInventoryV2Schema } from './race-manual-review-lifecycle-inventory-v2.js';
import { raceManualReviewMultiOwnedRetainedPayloadV3Schema } from './race-manual-review-retained-payload-v2.js';
import { encodeRaceManualReviewPooledRetainedPayloadV1 } from './race-manual-review-pooled-retained-payload-v1.js';
import {
  toRaceManualReviewPooledDatabaseEnvelopeV1,
  decodeRaceManualReviewPooledDatabaseEnvelopeV1,
} from './race-manual-review-pooled-database-envelope-v1.js';
import { assertRaceManualPlainV2 } from './race-manual-review-consumed-use-v2.js';
import { validateRaceSourceResponseBudget } from './race-plan-impact-context.js';
import { reserveSourceBudget, type SourceBudget } from './race-plan-impact-nested-sources.js';
import {
  RaceImpactDependencyError,
  impactDependencyDigest,
} from './race-plan-impact-dependencies.js';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const encoding = z.enum(['legacy-retained-v2', 'pooled-database-envelope-v1']);
const limits = {
  authority: 'none',
  permissionAuthority: 'none',
  freshness: 'not_checked',
  sourceAuthentication: 'unverified',
  approvalAllowed: false,
  planApplied: false,
  budgetCoverage: 'request_source_response_reservations',
  aggregatePhysicalTransfer: 'not_verified',
} as const;
function invalid(): never {
  throw new RaceImpactDependencyError('INVALID_CONTEXT');
}
function plain(raw: unknown) {
  try {
    assertRaceManualPlainV2(raw);
  } catch {
    invalid();
  }
}
function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  plain(raw);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) invalid();
  return parsed.data;
}
/** Exact measured SQL response reservation, not physical DB/network accounting. */
async function call(tx: Transaction, expression: string, values: unknown[], budget: SourceBudget) {
  validateRaceSourceResponseBudget(budget);
  const remaining = 4194304n - budget.bytes;
  const rows = (
    await tx.query(
      `WITH observed AS MATERIALIZED (SELECT ${expression} AS value), measured AS MATERIALIZED (SELECT value,octet_length(COALESCE(value::text,'null'))::bigint AS bytes FROM observed) SELECT bytes::text AS bytes,CASE WHEN bytes <= $${values.length + 1}::bigint THEN value ELSE NULL END AS value FROM measured`,
      [...values, remaining.toString()],
    )
  ).rows;
  plain(rows);
  if (rows.length !== 1) invalid();
  const response = parse(
    z.strictObject({ bytes: z.string().regex(/^(0|[1-9][0-9]*)$/), value: z.unknown() }),
    rows[0],
  );
  const measured = BigInt(response.bytes);
  if (measured > remaining)
    throw new RaceImpactDependencyError('CONTEXT_UNAVAILABLE', 'decoded_bytes');
  plain(response.value);
  if (BigInt(Buffer.byteLength(JSON.stringify(response.value), 'utf8')) > measured) invalid();
  reserveSourceBudget(budget, measured, 0);
  return response.value;
}
function snapshot(raw: unknown): unknown {
  plain(raw);
  try {
    return structuredClone(raw);
  } catch {
    invalid();
  }
}
function encoded(raw: unknown) {
  const logical = parse(raceManualReviewMultiOwnedRetainedPayloadV3Schema, raw);
  if (logical.state !== 'present' || logical.status !== 'structurally_corresponding') invalid();
  return {
    logical,
    wire: toRaceManualReviewPooledDatabaseEnvelopeV1(
      encodeRaceManualReviewPooledRetainedPayloadV1(logical),
    ),
  };
}
/** Caller-owned transaction only. Input observations are not credentials; SQL135
 * independently rechecks actual sources/purpose/heads/app before storing. */
export async function storeRaceManualPooledChainTransportV1In(
  tx: Transaction,
  rawCommand: unknown,
  rawLogical: unknown,
  rawBasis: unknown,
  rawLifecycle: unknown,
  budget: SourceBudget,
  ids: () => string = randomUUID,
) {
  validateRaceSourceResponseBudget(budget);
  const command = parse(raceManualReviewChainCommandV2Schema, rawCommand);
  const request = JSON.stringify(command);
  const retainedSnapshot = snapshot(rawLogical);
  const basisSnapshot = snapshot(rawBasis);
  const lifecycleSnapshot = snapshot(rawLifecycle);
  const replay = await call(
    tx,
    'public.read_manual_race_chain_receipt_v2($1::text,$2::jsonb)',
    [command.idempotencyKey, request],
    budget,
  );
  if (replay !== null)
    return {
      status: 'replayed' as const,
      result: parse(raceManualReviewChainResultV2Schema, replay),
      storage: 'persisted' as const,
      ...limits,
    };
  const { logical, wire } = encoded(retainedSnapshot);
  const basis = parse(raceManualSemanticBasisV2Schema, basisSnapshot);
  const lifecycle = parse(raceManualReviewLifecycleInventoryV2Schema, lifecycleSnapshot);
  if (
    basis.athleteId !== tx.athleteId ||
    logical.minimalAudit.athleteId !== tx.athleteId ||
    lifecycle.athleteId !== tx.athleteId ||
    lifecycle.status !== 'dependency_correspondence' ||
    impactDependencyDigest(command.expectedBasis) !== impactDependencyDigest(basis)
  )
    invalid();
  const minted = {
    evidenceId: uuid.parse(ids()),
    decisionId: uuid.parse(ids()),
    proposalId: uuid.parse(ids()),
  };
  if (new Set(Object.values(minted)).size !== 3) invalid();
  const result = parse(
    raceManualReviewChainResultV2Schema,
    await call(
      tx,
      'public.store_manual_race_pooled_chain_v1($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)',
      [
        minted.evidenceId,
        minted.decisionId,
        minted.proposalId,
        command.idempotencyKey,
        request,
        JSON.stringify(wire),
        JSON.stringify(basis),
        JSON.stringify(lifecycle),
      ],
      budget,
    ),
  );
  if (result.candidateDigest !== logical.minimalAudit.candidateDigest) invalid();
  // A competing success must correspond to the same original receipt, not just
  // an arbitrary different result tuple from the driver.
  if (
    result.evidenceId !== minted.evidenceId ||
    result.decisionId !== minted.decisionId ||
    result.proposalId !== minted.proposalId
  ) {
    const original = parse(
      raceManualReviewChainResultV2Schema,
      await call(
        tx,
        'public.read_manual_race_chain_receipt_v2($1::text,$2::jsonb)',
        [command.idempotencyKey, request],
        budget,
      ),
    );
    if (impactDependencyDigest(original) !== impactDependencyDigest(result)) invalid();
    return {
      status: 'replayed' as const,
      result: original,
      storage: 'persisted' as const,
      ...limits,
    };
  }
  return { status: 'stored' as const, result, storage: 'persisted' as const, ...limits };
}
const readWire = z.strictObject({
  readerVersion: z.literal(1),
  schemaVersion: z.literal(2),
  result: z.lazy(() => raceManualReviewChainResultV2Schema),
  payloadEncoding: encoding.nullable(),
  payload: z.unknown(),
  purgedAt: z.iso.datetime({ offset: true }).nullable(),
  purgedEventId: uuid.nullable(),
});
/** JSON structural decoding cannot establish source/event authenticity. */
export function parseRaceManualPooledChainReadTransportV1(raw: unknown) {
  const wire = parse(readWire, raw);
  if (wire.payload === null) {
    if (wire.payloadEncoding !== null || wire.purgedAt === null || wire.purgedEventId === null)
      invalid();
    return { ...wire, payload: null, bodyState: 'purged' as const, ...limits };
  }
  if (wire.payloadEncoding === null || wire.purgedAt !== null || wire.purgedEventId !== null)
    invalid();
  let logical: ReturnType<typeof decodeRaceManualReviewPooledDatabaseEnvelopeV1>;
  try {
    logical =
      wire.payloadEncoding === 'pooled-database-envelope-v1'
        ? decodeRaceManualReviewPooledDatabaseEnvelopeV1(wire.payload)
        : parse(raceManualReviewMultiOwnedRetainedPayloadV3Schema, wire.payload);
  } catch {
    invalid();
  }
  if (
    logical.state !== 'present' ||
    logical.status !== 'structurally_corresponding' ||
    logical.minimalAudit.candidateDigest !== wire.result.candidateDigest
  )
    invalid();
  return { ...wire, payload: logical, bodyState: 'present' as const, ...limits };
}
export async function readRaceManualPooledChainTransportV1In(
  tx: Transaction,
  rawId: unknown,
  budget: SourceBudget,
) {
  validateRaceSourceResponseBudget(budget);
  const id = parse(uuid, rawId);
  const value = await call(tx, 'public.read_manual_race_pooled_chain_v1($1::uuid)', [id], budget);
  if (value === null) return { status: 'unavailable' as const, ...limits };
  const read = parseRaceManualPooledChainReadTransportV1(value);
  if (
    read.result.evidenceId !== id ||
    (read.payload !== null && read.payload.minimalAudit.athleteId !== tx.athleteId)
  )
    invalid();
  return { status: 'read' as const, ...read };
}
const ackWire = z.strictObject({
  ackVersion: z.literal(2),
  payloadEncoding: encoding,
  result: z.lazy(() => raceManualReviewChainResultV2Schema),
  bodyState: z.literal('present'),
  payloadDigestMethod: z.literal('postgres-jsonb-v1'),
  payloadSqlDigest: hash,
  correspondence: z.literal('same_tx_stored_parent'),
});
const ackResponse = z.strictObject({
  ack: ackWire,
  expectedPayloadSqlDigest: hash,
  context: z.strictObject({
    xid: z.string().regex(/^[1-9][0-9]*$/),
    role: z.string().min(1).max(63),
    athleteId: z.string().min(1).max(200),
    isolation: z.enum(['repeatable read', 'serializable']),
  }),
});
/** SQL136 owns same-xid/session/ref correspondence. The separate expected hash
 * is PostgreSQL JSONB encoding, never a Node canonical digest or permission. */
export async function ackRaceManualPooledChainTransportV1In(
  tx: Transaction,
  rawResult: unknown,
  rawLogical: unknown,
  budget: SourceBudget,
) {
  validateRaceSourceResponseBudget(budget);
  const result = parse(raceManualReviewChainResultV2Schema, rawResult);
  const { logical, wire } = encoded(rawLogical);
  if (
    logical.minimalAudit.athleteId !== tx.athleteId ||
    logical.minimalAudit.candidateDigest !== result.candidateDigest
  )
    invalid();
  const response = parse(
    ackResponse,
    await call(
      tx,
      `jsonb_build_object('ack',public.ack_manual_race_pooled_same_tx_parent_v1($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb),'expectedPayloadSqlDigest',encode(sha256(convert_to($5::jsonb::text,'UTF8')),'hex'),'context',jsonb_build_object('xid',txid_current()::text,'role',current_user::text,'athleteId',current_setting('app.athlete_id',true),'isolation',current_setting('transaction_isolation')))`,
      [
        result.evidenceId,
        result.decisionId,
        result.proposalId,
        result.candidateDigest,
        JSON.stringify(wire),
      ],
      budget,
    ),
  );
  if (
    response.ack.payloadEncoding !== 'pooled-database-envelope-v1' ||
    response.context.athleteId !== tx.athleteId ||
    response.ack.payloadSqlDigest !== response.expectedPayloadSqlDigest ||
    JSON.stringify(response.ack.result) !== JSON.stringify(result)
  )
    invalid();
  return { ...response.ack, ...limits };
}
