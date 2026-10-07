import { z } from 'zod';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import {
  raceManualPublicPrepareSchema,
  raceManualPublicApproveSchema,
  raceManualPublicReviewResultSchema,
  raceManualPublicCapabilitiesSchema,
} from '@workout/contracts/race-manual-public';
import {
  raceManualPublicPreviewSchema,
  raceManualPublicPreviewReferenceSchema,
} from '@workout/contracts/race-manual-public-preview';
import { raceManualApprovalResultSchema } from '@workout/contracts/race-manual-approval';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const keySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const errorBody = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'CSRF_INVALID',
      'INVALID_REQUEST',
      'NOT_FOUND',
      'STALE_SESSION',
      'STALE_RESTORE_GENERATION',
      'APP_CONSENT_REQUIRED',
      'PUBLIC_REFERENCE_UNAVAILABLE',
      'PUBLIC_APPLICATION_UNAVAILABLE',
      'PUBLIC_RESPONSE_LIMIT',
      'PUBLIC_PREVIEW_LIMIT',
      'PARENT_UNAVAILABLE',
      'APPLICATION_UNAVAILABLE',
      'STALE_BASIS',
      'UNRESOLVED_AFFECTED',
      'INTERNAL_ERROR',
    ]),
  }),
});
export class RaceManualPublicRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'RaceManualPublicRequestError';
  }
}
/** Validate unknown JSON before stringify/schema traversal; never copy private
 * context or mint a retry key. Public preview has its additional 5000-node cap. */
function bounded(value: unknown): void {
  const active = new Set<object>();
  let visits = 0;
  let bytes = 0;
  const charge = (text: string) => {
    if (text.length > 4194304 - bytes) throw Error('Bound');
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > 4194304) throw Error('Bound');
  };
  const visit = (entry: unknown, depth: number): void => {
    if (++visits > 50000 || depth > 64) throw Error('Bound');
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'string') {
      charge(entry);
      return;
    }
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || active.has(entry)) throw Error('Plain JSON');
    const array = Array.isArray(entry);
    if (
      array
        ? Object.getPrototypeOf(entry) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(entry))
    )
      throw Error('Plain JSON');
    const keys = Reflect.ownKeys(entry);
    if (keys.length > 50001) throw Error('Bound');
    active.add(entry);
    let count = 0;
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') throw Error('Plain JSON');
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw Error('Plain JSON');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= entry.length))
        throw Error('Dense JSON');
      count++;
      charge(key);
      visit(descriptor.value, depth + 1);
    }
    if (array && count !== entry.length) throw Error('Dense JSON');
    active.delete(entry);
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4194304) throw Error('Bound');
}
function parse<T>(schema: z.ZodType<T>, raw: unknown, input = false): T {
  try {
    bounded(raw);
    return schema.parse(raw);
  } catch {
    throw new RaceManualPublicRequestError(
      input ? 400 : 502,
      input ? 'INVALID_INPUT' : 'INVALID_RESPONSE',
    );
  }
}
/** Reviewed is a stored preview, not current permission. No implicit approval,
 * retries or key generation; uncertain writes retain the caller's original key. */
export function createRaceManualPublicApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: 'GET' | 'POST',
    body: unknown,
    key: string | null,
    schema: z.ZodType<T>,
    expectedStatus: (result: T) => number,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    let raw: unknown;
    try {
      raw = await transport.request({
        path,
        method,
        body: body === null ? null : z.json().parse(body),
        idempotencyKey: key,
        ...(signal ? { signal } : {}),
      });
    } catch {
      signal?.throwIfAborted();
      throw new RaceManualPublicRequestError(0, 'TRANSPORT_UNAVAILABLE');
    }
    signal?.throwIfAborted();
    const reply = parse(transportReplySchema, raw);
    // 409 can carry a typed blocked result; it is never a committed success.
    if (reply.status === 200 || reply.status === 201 || reply.status === 409) {
      const parsed = schema.safeParse(reply.body);
      if (parsed.success) {
        if (reply.status !== expectedStatus(parsed.data))
          throw new RaceManualPublicRequestError(502, 'INVALID_RESPONSE');
        return parsed.data;
      }
      if (reply.status !== 409) throw new RaceManualPublicRequestError(502, 'INVALID_RESPONSE');
    }
    const error = errorBody.safeParse(reply.body);
    throw new RaceManualPublicRequestError(
      reply.status,
      error.success ? error.data.error.code : 'REQUEST_FAILED',
    );
  }
  return {
    async capabilities(signal?: AbortSignal) {
      return request(
        '/bff/v1/race-date-change-reviews/capabilities',
        'GET',
        null,
        null,
        raceManualPublicCapabilitiesSchema,
        () => 200,
        signal,
      );
    },
    async review(raceId: unknown, body: unknown, idempotencyKey: unknown, signal?: AbortSignal) {
      const id = parse(uuid, raceId, true);
      const command = parse(raceManualPublicPrepareSchema, body, true);
      const key = parse(keySchema, idempotencyKey, true);
      if (command.intent.expectedEvent.id.toLowerCase() !== id)
        throw new RaceManualPublicRequestError(400, 'INVALID_INPUT');
      return request(
        `/bff/v1/races/${id}/date-change-reviews`,
        'POST',
        {
          ...command,
          intent: { ...command.intent, expectedEvent: { ...command.intent.expectedEvent, id } },
        },
        key,
        raceManualPublicReviewResultSchema,
        (result) => (result.status === 'reviewed' ? 201 : 409),
        signal,
      );
    },
    async readPreview(candidateId: unknown, signal?: AbortSignal) {
      const id = parse(uuid, candidateId, true);
      const result = await request(
        `/bff/v1/race-date-change-reviews/${id}`,
        'GET',
        null,
        null,
        raceManualPublicPreviewSchema,
        () => 200,
        signal,
      );
      if (result.reference.candidateId !== id)
        throw new RaceManualPublicRequestError(502, 'INVALID_RESPONSE');
      return result;
    },
    async approve(
      reference: unknown,
      body: unknown,
      idempotencyKey: unknown,
      signal?: AbortSignal,
    ) {
      const expected = parse(raceManualPublicPreviewReferenceSchema, reference, true);
      const id = expected.candidateId;
      const command = parse(raceManualPublicApproveSchema, body, true);
      const key = parse(keySchema, idempotencyKey, true);
      if (expected.applicationDigest !== command.applicationDigest)
        throw new RaceManualPublicRequestError(400, 'INVALID_INPUT');
      const result = await request(
        `/bff/v1/race-date-change-reviews/${id}/approve`,
        'POST',
        command,
        key,
        raceManualApprovalResultSchema,
        (value) => (value.status === 'committed' ? 200 : 409),
        signal,
      );
      if (
        result.candidateId !== id ||
        (result.status === 'committed' && result.proposalId !== expected.chain.proposalId)
      )
        throw new RaceManualPublicRequestError(502, 'INVALID_RESPONSE');
      return result;
    },
  };
}
