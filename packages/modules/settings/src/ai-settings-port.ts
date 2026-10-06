import {
  aiExecutionCatalogV1Schema,
  aiSettingsV1Schema,
  validateAiCatalogExposureV1,
  type AiSettingsWriteV1,
} from '@workout/contracts/ai-settings';

export interface AiSettingsPortContext {
  readonly athleteId: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
}
export interface AiSettingsPort {
  getCatalog(context: AiSettingsPortContext): Promise<unknown>;
  getSettings(context: AiSettingsPortContext): Promise<unknown>;
  save(context: AiSettingsPortContext, command: AiSettingsWriteV1): Promise<unknown>;
}
export type AiSettingsFailureCode =
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CSRF_REJECTED'
  | 'DEFAULT_NOT_SELECTABLE'
  | 'COMPARISON_NOT_SELECTABLE'
  | 'STALE_CATALOG'
  | 'STALE_POLICY'
  | 'STALE_DISCLOSURE'
  | 'UNAVAILABLE'
  | 'INVALID_RESPONSE';
export class AiSettingsPortError extends Error {
  constructor(readonly code: AiSettingsFailureCode) {
    super(code);
    this.name = 'AiSettingsPortError';
  }
}
export async function readCatalog(port: AiSettingsPort, context: AiSettingsPortContext) {
  const result = aiExecutionCatalogV1Schema.safeParse(await port.getCatalog(context));
  context.signal.throwIfAborted();
  if (!result.success || !validateAiCatalogExposureV1(result.data, ['openai']))
    throw new AiSettingsPortError('INVALID_RESPONSE');
  return result.data;
}
export async function readSettings(port: AiSettingsPort, context: AiSettingsPortContext) {
  const result = aiSettingsV1Schema.safeParse(await port.getSettings(context));
  context.signal.throwIfAborted();
  if (!result.success) throw new AiSettingsPortError('INVALID_RESPONSE');
  return result.data;
}
