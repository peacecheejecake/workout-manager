import { z } from 'zod';
import type { Transaction } from './database.js';

// Accounting preparation port only. The caller owns a global-shared-first
// transaction and commits before treating true as outbound admission. This module
// never sends, starts/commits transactions, or proves complete source freshness.
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid();
const amount = z.number().int().min(0).max(50000);
const outcome = z.enum(['completed', 'charged_unknown', 'released']);
const terminal = {
  outcome,
  debitMinor: amount,
  outputDigest: hash.nullable(),
};
function validTerminal(value: {
  outcome: z.infer<typeof outcome>;
  debitMinor: number;
  outputDigest: string | null;
}) {
  return value.outcome === 'completed'
    ? value.outputDigest !== null
    : value.outputDigest === null && (value.outcome !== 'released' || value.debitMinor === 0);
}
const settlementSchema = z.strictObject(terminal).refine(validTerminal);
const reservationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('acquired'),
    reservationId: uuid,
    requestDigest: hash,
    maxDebitMinor: amount,
  }),
  z.strictObject({ kind: z.literal('busy') }),
  z.strictObject({ kind: z.literal('denied') }),
  z
    .strictObject({ kind: z.literal('replayed'), reservationId: uuid, ...terminal })
    .refine(validTerminal),
]);
const requestSchema = z.strictObject({
  definitionVersion: z.literal('provider-budget-reservation-v2'),
  runId: uuid,
  key: hash,
  requestDigest: hash,
  priceVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]{0,99}$/),
  inputBound: z.number().int().min(0).max(1000000),
  outputBound: z.number().int().min(1).max(1000000),
  ownerToken: uuid,
});
const dispatchSchema = z.strictObject({
  reservationId: uuid,
  ownerToken: uuid,
  eventId: uuid,
  leaseToken: uuid,
  attempt: z.number().int().min(1).max(2147483647),
  runId: uuid,
});
const settleSchema = z
  .strictObject({
    reservationId: uuid,
    ownerToken: uuid,
    requestDigest: hash,
    outcome,
    outputDigest: hash.nullable(),
  })
  .refine((value) => (value.outcome === 'completed') === (value.outputDigest !== null));
export type GlobalOpenAiBudgetReservation = z.infer<typeof reservationSchema>;
export type GlobalOpenAiBudgetSettlement = z.infer<typeof settlementSchema>;
const codes = [
  'INVALID_OPENAI_BUDGET_INPUT',
  'INVALID_OPENAI_BUDGET_RECEIPT',
  'OPENAI_BUDGET_INVALID_REQUEST',
  'OPENAI_BUDGET_CLOSED',
  'OPENAI_BUDGET_UNPRICED',
  'OPENAI_BUDGET_SETTLEMENT_INVALID',
  'OPENAI_BUDGET_SETTLEMENT_CONFLICT',
  'RESTORE_PROCESSING_CLOSED',
  'RESTORE_PROCESSING_CONTROL_MISSING',
  'STALE_APP_ADMISSION',
  'APP_CONSENT_REQUIRED',
] as const;
export type GlobalOpenAiBudgetErrorCode = (typeof codes)[number];
export class GlobalOpenAiBudgetError extends Error {
  constructor(readonly code: GlobalOpenAiBudgetErrorCode) {
    super(code);
    this.name = 'GlobalOpenAiBudgetError';
  }
}
const sqlErrorSchema = z.object({ code: z.literal('P0001'), message: z.enum(codes) });
function translate(error: unknown): never {
  const parsed = sqlErrorSchema.safeParse(error);
  if (parsed.success) throw new GlobalOpenAiBudgetError(parsed.data.message);
  throw error;
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: GlobalOpenAiBudgetErrorCode): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GlobalOpenAiBudgetError(code);
  return result.data;
}
export function decodeGlobalOpenAiBudgetReservation(value: unknown): GlobalOpenAiBudgetReservation {
  return parse(reservationSchema, value, 'INVALID_OPENAI_BUDGET_RECEIPT');
}
export function decodeGlobalOpenAiBudgetSettlement(value: unknown): GlobalOpenAiBudgetSettlement {
  return parse(settlementSchema, value, 'INVALID_OPENAI_BUDGET_RECEIPT');
}
/** Injection seam, not an implemented production full-manifest comparator.
 * Implementations must perform only local DB reads in this same transaction and
 * preserve lease-before-run ordering; no provider/network call is allowed here. */
export interface GlobalOpenAiBudgetFreshnessPort {
  requireFreshIn(transaction: Transaction, runId: string): Promise<void>;
}
export interface GlobalOpenAiBudgetPort {
  reserveIn(transaction: Transaction, input: unknown): Promise<GlobalOpenAiBudgetReservation>;
  beginDispatchIn(transaction: Transaction, input: unknown): Promise<boolean>;
  settleIn(transaction: Transaction, input: unknown): Promise<GlobalOpenAiBudgetSettlement>;
}
async function result(transaction: Transaction, sql: string, values: unknown[]): Promise<unknown> {
  try {
    const value = await transaction.query(sql, values);
    if (value.rows.length !== 1) throw new GlobalOpenAiBudgetError('INVALID_OPENAI_BUDGET_RECEIPT');
    return value.rows[0]?.['result'];
  } catch (error) {
    return translate(error);
  }
}
export function createGlobalOpenAiBudgetPort(input: {
  completeFreshness: GlobalOpenAiBudgetFreshnessPort;
}): GlobalOpenAiBudgetPort {
  return {
    async reserveIn(transaction, value) {
      const r = parse(requestSchema, value, 'INVALID_OPENAI_BUDGET_INPUT');
      const receipt = decodeGlobalOpenAiBudgetReservation(
        await result(
          transaction,
          'SELECT public.reserve_openai_budget($1,$2,$3,$4,$5,$6,$7) AS result',
          [
            r.runId,
            r.key,
            r.requestDigest,
            r.priceVersion,
            r.inputBound,
            r.outputBound,
            r.ownerToken,
          ],
        ),
      );
      if (receipt.kind === 'acquired' && receipt.requestDigest !== r.requestDigest)
        throw new GlobalOpenAiBudgetError('INVALID_OPENAI_BUDGET_RECEIPT');
      return receipt;
    },
    async beginDispatchIn(transaction, value) {
      const r = parse(dispatchSchema, value, 'INVALID_OPENAI_BUDGET_INPUT');
      await input.completeFreshness.requireFreshIn(transaction, r.runId);
      return parse(
        z.boolean(),
        await result(
          transaction,
          'SELECT public.begin_openai_budget_dispatch($1,$2,$3,$4,$5,$6) AS result',
          [r.reservationId, r.ownerToken, r.eventId, r.leaseToken, r.attempt, r.runId],
        ),
        'INVALID_OPENAI_BUDGET_RECEIPT',
      );
    },
    async settleIn(transaction, value) {
      const r = parse(settleSchema, value, 'INVALID_OPENAI_BUDGET_INPUT');
      const receipt = decodeGlobalOpenAiBudgetSettlement(
        await result(transaction, 'SELECT public.settle_openai_budget($1,$2,$3,$4,$5) AS result', [
          r.reservationId,
          r.ownerToken,
          r.requestDigest,
          r.outcome,
          r.outputDigest,
        ]),
      );
      if (receipt.outcome !== r.outcome || receipt.outputDigest !== r.outputDigest)
        throw new GlobalOpenAiBudgetError('INVALID_OPENAI_BUDGET_RECEIPT');
      return receipt;
    },
  };
}
