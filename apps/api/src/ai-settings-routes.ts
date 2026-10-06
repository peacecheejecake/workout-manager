import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  aiExecutionCatalogV1Schema,
  aiSettingsV1Schema,
  aiSettingsWriteV1Schema,
  validateAiCatalogExposureV1,
  type AiSettingsWriteV1,
} from '@workout/contracts/ai-settings';
import type { Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

/** Preference operations only. Implementations own authoritative catalog/CAS/receipt checks. */
export interface AiSettingsService {
  catalog(athleteId: string): Promise<unknown>;
  read(athleteId: string): Promise<unknown>;
  write(athleteId: string, command: AiSettingsWriteV1): Promise<unknown>;
}
export type AiSettingsServiceErrorCode =
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_CATALOG'
  | 'STALE_POLICY'
  | 'STALE_DISCLOSURE'
  | 'DEFAULT_NOT_SELECTABLE'
  | 'COMPARISON_NOT_SELECTABLE'
  | 'UNAVAILABLE';
export class AiSettingsServiceError extends Error {
  constructor(readonly code: AiSettingsServiceErrorCode) {
    super(code);
    this.name = 'AiSettingsServiceError';
  }
}
const statusByCode: Record<AiSettingsServiceErrorCode, number> = {
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_CATALOG: 409,
  STALE_POLICY: 409,
  STALE_DISCLOSURE: 409,
  DEFAULT_NOT_SELECTABLE: 422,
  COMPARISON_NOT_SELECTABLE: 422,
  UNAVAILABLE: 503,
};
async function execute(operation: () => Promise<unknown>) {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof AiSettingsServiceError && Object.hasOwn(statusByCode, error.code))
      throw new ProductRequestError(statusByCode[error.code], error.code);
    throw error;
  }
}

/** Register within the existing authenticated /bff/v1 plugin, inheriting session/CSRF hooks. */
export function registerAiSettingsRoutes(
  routes: FastifyInstance,
  service: AiSettingsService,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/ai-settings/catalog', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    input(emptyQuery, request.params);
    input(emptyQuery, request.query);
    const result = aiExecutionCatalogV1Schema.parse(
      await execute(() => service.catalog(principal(request).athleteId)),
    );
    if (!validateAiCatalogExposureV1(result, ['openai']))
      throw new Error('AI_SETTINGS_RESPONSE_INVALID');
    return result;
  });
  routes.get('/ai-settings', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    input(emptyQuery, request.params);
    input(emptyQuery, request.query);
    return aiSettingsV1Schema.parse(
      await execute(() => service.read(principal(request).athleteId)),
    );
  });
  routes.put('/ai-settings', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    input(emptyQuery, request.params);
    input(emptyQuery, request.query);
    const body = input(aiSettingsWriteV1Schema.omit({ idempotencyKey: true }), request.body);
    const payload = input(aiSettingsWriteV1Schema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    const result = aiSettingsV1Schema.parse(
      await execute(() => service.write(principal(request).athleteId, payload)),
    );
    if (
      result.revision !== payload.expectedRevision + 1 ||
      JSON.stringify(result.defaultSelection) !== JSON.stringify(payload.defaultSelection) ||
      JSON.stringify(result.syntheticComparison) !== JSON.stringify(payload.syntheticComparison)
    )
      throw new Error('AI_SETTINGS_RESPONSE_INVALID');
    return result;
  });
}
