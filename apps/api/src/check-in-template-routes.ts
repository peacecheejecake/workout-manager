import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  checkInTemplateVersionSchema,
  saveCheckInTemplateSchema,
  type CheckInTemplateVersion,
} from '@workout/contracts/check-in-templates';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

/** Same public method surface as the persistence repository; no private imports. */
export interface CheckInTemplateRoutesRepository {
  save(athleteId: string, input: unknown): Promise<CheckInTemplateVersion>;
  readExact(
    athleteId: string,
    templateId: string,
    versionId: string,
  ): Promise<CheckInTemplateVersion | null>;
  readHead(athleteId: string, templateId: string): Promise<CheckInTemplateVersion | null>;
  list(athleteId: string, input: unknown): Promise<{ items: CheckInTemplateVersion[] }>;
}
const uuid = z.uuid().transform((value) => value.toLowerCase());
const headParams = z.strictObject({ templateId: uuid });
const exactParams = headParams.extend({ versionId: uuid });
const listQuery = z.strictObject({
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional(),
  offset: z
    .string()
    .regex(/^(0|[1-9]\d{0,4})$/)
    .transform(Number)
    .pipe(z.number().int().max(10000))
    .optional(),
});
const listResponse = z.strictObject({ items: z.array(checkInTemplateVersionSchema).max(100) });
const finiteError = z.object({
  code: z.enum([
    'CHECK_IN_TEMPLATE_BOUND',
    'CHECK_IN_TEMPLATE_INVALID_RESPONSE',
    'CHECK_IN_TEMPLATE_VERSION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'APP_CONSENT_REQUIRED',
  ]),
});
function operation<T>(readOrWrite: () => Promise<T>) {
  return command(readOrWrite, (error) => {
    if (!(error instanceof Error)) return undefined;
    const known = finiteError.safeParse(error);
    if (!known.success) return undefined;
    switch (known.data.code) {
      case 'CHECK_IN_TEMPLATE_BOUND':
        return new ProductRequestError(413, known.data.code);
      case 'CHECK_IN_TEMPLATE_INVALID_RESPONSE':
        return new ProductRequestError(500, 'INTERNAL_ERROR');
      case 'CHECK_IN_TEMPLATE_VERSION_CONFLICT':
      case 'IDEMPOTENCY_CONFLICT':
      case 'APP_CONSENT_REQUIRED':
        return new ProductRequestError(409, known.data.code);
    }
  });
}
function result(raw: unknown, templateId?: string, versionId?: string) {
  const value = checkInTemplateVersionSchema.parse(raw);
  if (
    (templateId !== undefined && value.templateId !== templateId) ||
    (versionId !== undefined && value.versionId !== versionId)
  )
    throw new ProductRequestError(500, 'INTERNAL_ERROR');
  return value;
}
/** Register inside the existing authenticated product plugin. Principal freshness
 * and cookie CSRF are enforced by that parent boundary, not by client fields.
 * App withdrawal / receipt replay / fresh admission belong to the repository.
 */
export function registerCheckInTemplateRoutes(
  routes: FastifyInstance,
  repository: CheckInTemplateRoutesRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/check-in-templates', async (request) => {
    const query = input(listQuery, request.query);
    return listResponse.parse(
      await operation(() =>
        repository.list(principal(request).athleteId, {
          limit: query.limit ?? 20,
          offset: query.offset ?? 0,
        }),
      ),
    );
  });
  routes.get('/check-in-templates/:templateId', async (request) => {
    input(emptyQuery, request.query);
    const { templateId } = input(headParams, request.params);
    const row = await operation(() =>
      repository.readHead(principal(request).athleteId, templateId),
    );
    if (row === null) throw new ProductRequestError(404, 'NOT_FOUND');
    return result(row, templateId);
  });
  routes.get('/check-in-templates/:templateId/versions/:versionId', async (request) => {
    input(emptyQuery, request.query);
    const { templateId, versionId } = input(exactParams, request.params);
    const row = await operation(() =>
      repository.readExact(principal(request).athleteId, templateId, versionId),
    );
    if (row === null) throw new ProductRequestError(404, 'NOT_FOUND');
    return result(row, templateId, versionId);
  });
  routes.post('/check-in-templates', async (request) => {
    input(emptyQuery, request.query);
    const body = input(saveCheckInTemplateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(saveCheckInTemplateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return result(
      await operation(() => repository.save(principal(request).athleteId, payload)),
      payload.templateId,
    );
  });
}
