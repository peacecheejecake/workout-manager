import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  checkInTemplateVersionSchema,
  saveCheckInTemplateSchema,
} from '@workout/contracts/check-in-templates';

const base = '/bff/v1/check-in-templates';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const querySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
});
const listSchema = z.strictObject({ items: z.array(checkInTemplateVersionSchema).max(100) });
const errorSchema = z.object({
  error: z.object({
    code: z.enum([
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'CSRF_REJECTED',
      'NOT_FOUND',
      'INVALID_REQUEST',
      'CHECK_IN_TEMPLATE_BOUND',
      'CHECK_IN_TEMPLATE_VERSION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'APP_CONSENT_REQUIRED',
      'INTERNAL_ERROR',
    ]),
  }),
});
export class CheckInTemplateRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'CheckInTemplateRequestError';
  }
}
function response<T>(schema: z.ZodType<T>, raw: unknown, status: number): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CheckInTemplateRequestError(status, 'INVALID_RESPONSE');
  return parsed.data;
}
/** AuthenticatedTransport owns credentials/CSRF. Templates describe prompts;
 * neither these DTOs nor a successful save establish an actual CheckIn. */
export function createCheckInTemplateApi(transport: AuthenticatedTransport) {
  async function request(
    path: string,
    method: TransportRequest['method'],
    body: TransportRequest['body'] = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      throw new CheckInTemplateRequestError(0, 'UNAVAILABLE');
    }
    signal?.throwIfAborted();
    const reply = response(transportReplySchema, raw, 0);
    if (reply.status < 200 || reply.status >= 300) {
      const error = errorSchema.safeParse(reply.body);
      throw new CheckInTemplateRequestError(
        reply.status,
        error.success ? error.data.error.code : 'REQUEST_FAILED',
      );
    }
    return reply;
  }
  return {
    async list(query: unknown = {}, signal?: AbortSignal) {
      const { limit, offset } = querySchema.parse(query);
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const reply = await request(`${base}?${params}`, 'GET', null, null, signal);
      const result = response(listSchema, reply.body, reply.status);
      if (
        result.items.length > limit ||
        result.items.some(
          (item, index) =>
            index > 0 && (result.items[index - 1]?.templateId ?? '') >= item.templateId,
        )
      )
        throw new CheckInTemplateRequestError(reply.status, 'INVALID_RESPONSE');
      return result;
    },
    async readHead(templateId: string, signal?: AbortSignal) {
      const id = uuid.parse(templateId);
      const reply = await request(`${base}/${encodeURIComponent(id)}`, 'GET', null, null, signal);
      const result = response(checkInTemplateVersionSchema, reply.body, reply.status);
      if (result.templateId !== id)
        throw new CheckInTemplateRequestError(reply.status, 'INVALID_RESPONSE');
      return result;
    },
    async readExact(templateId: string, versionId: string, signal?: AbortSignal) {
      const id = uuid.parse(templateId),
        version = uuid.parse(versionId);
      const reply = await request(
        `${base}/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`,
        'GET',
        null,
        null,
        signal,
      );
      const result = response(checkInTemplateVersionSchema, reply.body, reply.status);
      if (result.templateId !== id || result.versionId !== version)
        throw new CheckInTemplateRequestError(reply.status, 'INVALID_RESPONSE');
      return result;
    },
    async save(raw: unknown, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = saveCheckInTemplateSchema.parse(raw);
      const reply = await request(base, 'POST', body, idempotencyKey, signal);
      const result = response(checkInTemplateVersionSchema, reply.body, reply.status);
      if (
        result.templateId !== body.templateId ||
        result.version !== body.expectedVersion + 1 ||
        JSON.stringify(result.content) !== JSON.stringify(body.content)
      )
        throw new CheckInTemplateRequestError(reply.status, 'INVALID_RESPONSE');
      return result;
    },
  };
}
export type CheckInTemplateApi = ReturnType<typeof createCheckInTemplateApi>;
