import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  coachingRunCreateCommandV1Schema,
  coachingRunListQuerySchema,
  coachingRunListSchema,
  coachingRunV1Schema,
  type CoachingRunCreateCommandV1,
  type CoachingRunListQuery,
} from '@workout/contracts/coaching-runs';
import { trainingCandidateBundleV1Schema } from '@workout/contracts/coaching-candidates';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const knownErrors = new Set([
  'THREAD_NOT_FOUND',
  'RUN_NOT_FOUND',
  'EVIDENCE_UNAVAILABLE',
  'CONVERSATION_REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'CANDIDATE_UNAVAILABLE',
  'INVALID_FIXTURE_OUTPUT',
  'STALE_BASIS',
  'UNAUTHENTICATED',
  'FORBIDDEN',
]);

export class CoachingRunRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function createCoachingRunApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: 'GET' | 'POST',
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    body: TransportRequest['body'] = null,
    idempotencyKey: string | null = null,
  ): Promise<T> {
    let raw: unknown;
    try {
      raw = await transport.request({
        path,
        method,
        body,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new Error('COACHING_RUN_TRANSPORT_UNCONFIRMED');
    }
    const envelope = transportReplySchema.safeParse(raw);
    if (!envelope.success) throw new Error('COACHING_RUN_RESPONSE_INVALID');
    const reply = envelope.data;
    if (reply.status < 200 || reply.status >= 300) {
      const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(reply.body);
      throw new CoachingRunRequestError(
        reply.status,
        error.success && knownErrors.has(error.data.error.code)
          ? error.data.error.code
          : 'REQUEST_FAILED',
      );
    }
    const parsed = schema.safeParse(reply.body);
    if (!parsed.success) throw new Error('COACHING_RUN_RESPONSE_INVALID');
    return parsed.data;
  }

  return {
    async list(threadId: string, input: Partial<CoachingRunListQuery>, signal?: AbortSignal) {
      const thread = uuid.parse(threadId);
      const query = coachingRunListQuerySchema.parse(input);
      const result = await request(
        `/bff/v1/coaching-threads/${encodeURIComponent(thread)}/runs?${new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) })}`,
        'GET',
        coachingRunListSchema,
        signal,
      );
      if (
        result.items.length > query.limit ||
        result.items.some((item) => item.threadId !== thread)
      )
        throw new Error('COACHING_RUN_RESPONSE_MISMATCH');
      return result;
    },
    async read(threadId: string, runId: string, signal?: AbortSignal) {
      const thread = uuid.parse(threadId);
      const id = uuid.parse(runId);
      const result = await request(
        `/bff/v1/coaching-runs/${encodeURIComponent(id)}`,
        'GET',
        coachingRunV1Schema,
        signal,
      );
      if (result.id !== id || result.threadId !== thread)
        throw new Error('COACHING_RUN_RESPONSE_MISMATCH');
      return result;
    },
    async create(threadId: string, input: CoachingRunCreateCommandV1, signal?: AbortSignal) {
      const thread = uuid.parse(threadId);
      const { idempotencyKey, ...body } = coachingRunCreateCommandV1Schema.parse(input);
      const result = await request(
        `/bff/v1/coaching-threads/${encodeURIComponent(thread)}/runs`,
        'POST',
        coachingRunV1Schema,
        signal,
        body,
        idempotencyKey,
      );
      if (
        result.threadId !== thread ||
        result.evidenceSnapshotId !== body.evidenceSnapshotId ||
        result.conversationRevision !== body.expectedConversationRevision
      )
        throw new Error('COACHING_RUN_RESPONSE_MISMATCH');
      return result;
    },
    async candidates(runId: string, signal?: AbortSignal) {
      const id = uuid.parse(runId);
      const result = await request(
        `/bff/v1/coaching-runs/${encodeURIComponent(id)}/candidates`,
        'GET',
        z.array(trainingCandidateBundleV1Schema).max(100),
        signal,
      );
      if (result.some((bundle) => bundle.candidate.runId !== id))
        throw new Error('COACHING_RUN_RESPONSE_MISMATCH');
      return result;
    },
    async validateFixture(runId: string, idempotencyKey: string, signal?: AbortSignal) {
      const id = uuid.parse(runId);
      const key = coachingRunCreateCommandV1Schema.shape.idempotencyKey.parse(idempotencyKey);
      const result = await request(
        `/bff/v1/coaching-runs/${encodeURIComponent(id)}/candidates`,
        'POST',
        trainingCandidateBundleV1Schema,
        signal,
        null,
        key,
      );
      if (result.candidate.runId !== id) throw new Error('COACHING_RUN_RESPONSE_MISMATCH');
      return result;
    },
    async cancel(threadId: string, runId: string, signal?: AbortSignal) {
      const thread = uuid.parse(threadId);
      const id = uuid.parse(runId);
      const result = await request(
        `/bff/v1/coaching-runs/${encodeURIComponent(id)}/cancel`,
        'POST',
        coachingRunV1Schema,
        signal,
      );
      if (result.id !== id || result.threadId !== thread)
        throw new Error('COACHING_RUN_RESPONSE_MISMATCH');
      return result;
    },
  };
}
