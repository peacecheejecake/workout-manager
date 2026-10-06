import { z } from 'zod';
import {
  transportReplySchema,
  transportRequestDtoSchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsV1Schema,
  aiSettingsWriteV1Schema,
  validateAiCatalogExposureV1,
} from '@workout/contracts/ai-settings';
import { AiSettingsPortError, type AiSettingsPort } from './ai-settings-port';

const writeBodySchema = aiSettingsWriteV1Schema.omit({ idempotencyKey: true });

const apiErrorCodeSchema = z.enum([
  'REVISION_CONFLICT',
  'STALE_CATALOG',
  'STALE_POLICY',
  'STALE_DISCLOSURE',
  'IDEMPOTENCY_CONFLICT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'CSRF_REJECTED',
  'DEFAULT_NOT_SELECTABLE',
  'COMPARISON_NOT_SELECTABLE',
  'UNAVAILABLE',
]);
const apiErrorSchema = z.strictObject({
  error: z.strictObject({ code: apiErrorCodeSchema }),
  requestId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
});
type RequestCode = z.infer<typeof apiErrorCodeSchema>;
const statusByCode: Record<RequestCode, number> = {
  REVISION_CONFLICT: 409,
  STALE_CATALOG: 409,
  STALE_POLICY: 409,
  STALE_DISCLOSURE: 409,
  IDEMPOTENCY_CONFLICT: 409,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  DEFAULT_NOT_SELECTABLE: 422,
  COMPARISON_NOT_SELECTABLE: 422,
  UNAVAILABLE: 503,
};
/** Ownership and credentials remain in AuthenticatedTransport. Context IDs only scope UI state. */
export function createAiSettingsPort(transport: AuthenticatedTransport): AiSettingsPort {
  async function request(input: TransportRequest) {
    input.signal?.throwIfAborted();
    const dto = transportRequestDtoSchema.safeParse({
      path: input.path,
      method: input.method,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    });
    if (!dto.success) throw new AiSettingsPortError('INVALID_RESPONSE');
    let unknownReply: unknown;
    try {
      unknownReply = await transport.request({
        ...dto.data,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      input.signal?.throwIfAborted();
      throw new AiSettingsPortError('UNAVAILABLE');
    }
    input.signal?.throwIfAborted();
    const envelope = transportReplySchema.safeParse(unknownReply);
    if (!envelope.success) throw new AiSettingsPortError('INVALID_RESPONSE');
    if (envelope.data.status === 200) return envelope.data.body;
    const error = apiErrorSchema.safeParse(envelope.data.body);
    if (!error.success || statusByCode[error.data.error.code] !== envelope.data.status)
      throw new AiSettingsPortError('INVALID_RESPONSE');
    throw new AiSettingsPortError(error.data.error.code);
  }
  return {
    async getCatalog({ signal }) {
      const result = aiExecutionCatalogV1Schema.safeParse(
        await request({
          path: '/bff/v1/ai-settings/catalog',
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (!result.success || !validateAiCatalogExposureV1(result.data, ['openai']))
        throw new AiSettingsPortError('INVALID_RESPONSE');
      return result.data;
    },
    async getSettings({ signal }) {
      const result = aiSettingsV1Schema.safeParse(
        await request({
          path: '/bff/v1/ai-settings',
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (!result.success) throw new AiSettingsPortError('INVALID_RESPONSE');
      return result.data;
    },
    async save({ signal }, unknownCommand) {
      signal.throwIfAborted();
      const parsed = aiSettingsWriteV1Schema.safeParse(unknownCommand);
      if (!parsed.success) throw new AiSettingsPortError('INVALID_RESPONSE');
      const { idempotencyKey, ...preferenceBody } = parsed.data;
      const body = writeBodySchema.parse(preferenceBody);
      const result = aiSettingsV1Schema.safeParse(
        await request({ path: '/bff/v1/ai-settings', method: 'PUT', body, idempotencyKey, signal }),
      );
      if (
        !result.success ||
        result.data.revision !== body.expectedRevision + 1 ||
        JSON.stringify(result.data.defaultSelection) !== JSON.stringify(body.defaultSelection) ||
        JSON.stringify(result.data.syntheticComparison) !== JSON.stringify(body.syntheticComparison)
      )
        throw new AiSettingsPortError('INVALID_RESPONSE');
      return result.data;
    },
  };
}
