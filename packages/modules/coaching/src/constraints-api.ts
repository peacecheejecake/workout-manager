import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  coachingConstraintListSchema,
  coachingConstraintCreateSchema,
  coachingConstraintUpdateSchema,
  coachingConstraintDeleteSchema,
  coachingConstraintCommandResultSchema,
  type CoachingConstraintCreate,
  type CoachingConstraintUpdate,
  type CoachingConstraintDelete,
} from '@workout/contracts/coaching-constraints';
export class ConstraintsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const known = new Set([
  'COACHING_CONSTRAINT_NOT_FOUND',
  'COACHING_CONSTRAINT_LIMIT',
  'COACHING_CONSTRAINT_REVISION_CONFLICT',
  'COACHING_CONSTRAINT_HEAD_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_REQUEST',
]);
export function createConstraintsApi(transport: AuthenticatedTransport) {
  async function request<T>(
    method: TransportRequest['method'],
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    body: TransportRequest['body'] = null,
    key: string | null = null,
  ) {
    let raw: unknown;
    try {
      raw = await transport.request({
        method,
        path,
        body,
        idempotencyKey: key,
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new Error('CONSTRAINTS_TRANSPORT_UNCONFIRMED');
    }
    const envelope = transportReplySchema.safeParse(raw);
    if (!envelope.success) throw new Error('CONSTRAINTS_RESPONSE_INVALID');
    if (envelope.data.status < 200 || envelope.data.status >= 300) {
      const parsed = z
        .object({ error: z.object({ code: z.string() }) })
        .safeParse(envelope.data.body);
      throw new ConstraintsRequestError(
        envelope.data.status,
        parsed.success && known.has(parsed.data.error.code)
          ? parsed.data.error.code
          : 'REQUEST_FAILED',
      );
    }
    const parsed = schema.safeParse(envelope.data.body);
    if (!parsed.success) throw new Error('CONSTRAINTS_RESPONSE_INVALID');
    return parsed.data;
  }
  const path = '/bff/v1/coaching-constraints';
  return {
    list: (signal?: AbortSignal) => request('GET', path, coachingConstraintListSchema, signal),
    async create(input: CoachingConstraintCreate, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = coachingConstraintCreateSchema.parse(input);
      const result = await request(
        'POST',
        path,
        coachingConstraintCommandResultSchema,
        signal,
        body,
        idempotencyKey,
      );
      if (
        result.deleted ||
        result.revision !== 1 ||
        result.headRevision !== (body.expectedHeadRevision ?? 0) + 1
      )
        throw new Error('CONSTRAINTS_RESPONSE_MISMATCH');
      return result;
    },
    async update(id: string, input: CoachingConstraintUpdate, signal?: AbortSignal) {
      const key = z.uuid().parse(id).toLowerCase();
      const { idempotencyKey, ...body } = coachingConstraintUpdateSchema.parse(input);
      const result = await request(
        'PUT',
        `${path}/${encodeURIComponent(key)}`,
        coachingConstraintCommandResultSchema,
        signal,
        body,
        idempotencyKey,
      );
      if (
        result.id !== key ||
        result.deleted ||
        result.revision !== body.expectedRevision + 1 ||
        result.headRevision !== body.expectedHeadRevision + 1
      )
        throw new Error('CONSTRAINTS_RESPONSE_MISMATCH');
      return result;
    },
    async remove(id: string, input: CoachingConstraintDelete, signal?: AbortSignal) {
      const key = z.uuid().parse(id).toLowerCase();
      const { idempotencyKey, ...body } = coachingConstraintDeleteSchema.parse(input);
      const result = await request(
        'DELETE',
        `${path}/${encodeURIComponent(key)}`,
        coachingConstraintCommandResultSchema,
        signal,
        body,
        idempotencyKey,
      );
      if (
        result.id !== key ||
        !result.deleted ||
        result.revision !== body.expectedRevision + 1 ||
        result.headRevision !== body.expectedHeadRevision + 1
      )
        throw new Error('CONSTRAINTS_RESPONSE_MISMATCH');
      return result;
    },
  };
}
