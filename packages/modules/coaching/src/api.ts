import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  coachingThreadListQuerySchema,
  coachingThreadListSchema,
  coachingThreadSchema,
  coachingMessagesQuerySchema,
  coachingMessagesSchema,
  coachingThreadCreateSchema,
  coachingMessageAppendSchema,
  coachingMessageResultSchema,
  type CoachingThreadListQuery,
  type CoachingMessagesQuery,
  type CoachingThreadCreate,
  type CoachingMessageAppend,
} from '@workout/contracts/coaching-threads';
import { planReadSchema, planSnapshotSchema } from '@workout/contracts/planning';
export class CoachingRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const idSchema = z.uuid().transform((v) => v.toLowerCase());
const known = new Set([
  'THREAD_NOT_FOUND',
  'PLAN_VERSION_NOT_FOUND',
  'SCOPE_NOT_FOUND',
  'CONVERSATION_REVISION_CONFLICT',
  'CONVERSATION_LIMIT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_REQUEST',
  'SESSION_CHANGED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
]);
export function createCoachingApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    body: TransportRequest['body'] = null,
    key: string | null = null,
  ): Promise<T> {
    const reply = transportReplySchema.parse(
      await transport.request({
        path,
        method: body === null ? 'GET' : 'POST',
        body,
        idempotencyKey: key,
        ...(signal ? { signal } : {}),
      }),
    );
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(reply.body);
      const code =
        parsed.success && known.has(parsed.data.error.code)
          ? parsed.data.error.code
          : 'REQUEST_FAILED';
      throw new CoachingRequestError(reply.status, code);
    }
    return schema.parse(reply.body);
  }
  const threadPath = (id: string) =>
    `/bff/v1/coaching-threads/${encodeURIComponent(idSchema.parse(id))}`;
  return {
    list(query: Partial<CoachingThreadListQuery>, signal?: AbortSignal) {
      const q = coachingThreadListQuerySchema.parse(query);
      return request(
        `/bff/v1/coaching-threads?${new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) })}`,
        coachingThreadListSchema,
        signal,
      );
    },
    async thread(id: string, signal?: AbortSignal) {
      const normalized = idSchema.parse(id);
      const value = await request(threadPath(normalized), coachingThreadSchema, signal);
      if (value.id !== normalized) throw new Error('RESPONSE_MISMATCH');
      return value;
    },
    async messages(id: string, query: Partial<CoachingMessagesQuery>, signal?: AbortSignal) {
      const normalized = idSchema.parse(id);
      const q = coachingMessagesQuerySchema.parse(query);
      const value = await request(
        `${threadPath(normalized)}/messages?${new URLSearchParams({ afterRevision: String(q.afterRevision), limit: String(q.limit) })}`,
        coachingMessagesSchema,
        signal,
      );
      if (
        value.thread.id !== normalized ||
        value.messages.some((m) => m.revision <= q.afterRevision) ||
        value.messages.length > q.limit
      )
        throw new Error('RESPONSE_MISMATCH');
      return value;
    },
    plans(signal?: AbortSignal) {
      return request('/bff/v1/plans/current', planReadSchema, signal);
    },
    async plan(id: string, signal?: AbortSignal) {
      const normalized = idSchema.parse(id);
      const value = await request(
        `/bff/v1/plans/versions/${encodeURIComponent(normalized)}`,
        planSnapshotSchema,
        signal,
      );
      if (value.id !== normalized) throw new Error('RESPONSE_MISMATCH');
      return value;
    },
    async create(input: CoachingThreadCreate, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = coachingThreadCreateSchema.parse(input);
      const value = await request(
        '/bff/v1/coaching-threads',
        coachingMessageResultSchema,
        signal,
        body,
        idempotencyKey,
      );
      if (
        value.thread.planVersionId !== body.planVersionId ||
        value.thread.title !== body.title ||
        value.thread.scope.kind !== body.scope.kind ||
        value.thread.scope.targetId !== body.scope.targetId ||
        value.message.content !== body.message ||
        value.thread.revision !== 1
      )
        throw new Error('RESPONSE_MISMATCH');
      return value;
    },
    async append(id: string, input: CoachingMessageAppend, signal?: AbortSignal) {
      const normalized = idSchema.parse(id);
      const { idempotencyKey, ...body } = coachingMessageAppendSchema.parse(input);
      const value = await request(
        `${threadPath(normalized)}/messages`,
        coachingMessageResultSchema,
        signal,
        body,
        idempotencyKey,
      );
      if (
        value.thread.id !== normalized ||
        value.message.content !== body.message ||
        value.thread.revision !== body.expectedRevision + 1
      )
        throw new Error('RESPONSE_MISMATCH');
      return value;
    },
  };
}
