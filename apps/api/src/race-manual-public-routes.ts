import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  raceManualPublicPrepareSchema,
  raceManualPublicApproveSchema,
  raceManualPublicReviewResultSchema,
} from '@workout/contracts/race-manual-public';
import { raceManualPublicImpactSchema } from '@workout/contracts/race-manual-public-impact';
import { RaceManualPublicError } from '@workout/server-persistence/race-manual-public';
import { RacePlanImpactPreviewError } from '@workout/server-persistence/race-plan-impact-preview';
import { raceManualPublicPreviewSchema } from '@workout/contracts/race-manual-public-preview';
import { raceManualApprovalResultSchema } from '@workout/contracts/race-manual-approval';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

/** Exact public factory surface. Unknown repository responses are decoded before
 * transport; this port accepts no browser source/basis/recipe authority. */
export interface RaceManualPublicRoutesRepository {
  impact?(athleteId: string, command: unknown): Promise<unknown>;
  review(athleteId: string, command: unknown): Promise<unknown>;
  approve(athleteId: string, command: unknown): Promise<unknown>;
  readPreview(athleteId: string, candidateId: unknown): Promise<unknown>;
}
const uuid = z.uuid().transform((value) => value.toLowerCase());
const reviewParams = z.strictObject({ raceId: uuid });
const candidateParams = z.strictObject({ candidateId: uuid });
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const finiteError = z.object({
  code: z.enum([
    'PUBLIC_REFERENCE_UNAVAILABLE',
    'PUBLIC_APPLICATION_UNAVAILABLE',
    'PUBLIC_RESPONSE_LIMIT',
    'PUBLIC_PREVIEW_LIMIT',
    'PUBLIC_INVALID_RESPONSE',
    'PUBLIC_PREVIEW_INVALID_CONTEXT',
    'PUBLIC_PORT_UNAVAILABLE',
    'PARENT_UNAVAILABLE',
    'APPLICATION_UNAVAILABLE',
    'STALE_BASIS',
    'UNRESOLVED_AFFECTED',
  ]),
});
function translate(error: unknown): ProductRequestError | undefined {
  if (error instanceof RacePlanImpactPreviewError && error.code === 'APP_CONSENT_REQUIRED')
    return new ProductRequestError(409, error.code);
  if (!(error instanceof Error)) return undefined;
  const known = finiteError.safeParse(error);
  if (!known.success) return undefined;
  switch (known.data.code) {
    case 'PUBLIC_REFERENCE_UNAVAILABLE':
      return new ProductRequestError(404, known.data.code);
    case 'PUBLIC_RESPONSE_LIMIT':
    case 'PUBLIC_PREVIEW_LIMIT':
      return new ProductRequestError(413, known.data.code);
    case 'PUBLIC_APPLICATION_UNAVAILABLE':
    case 'PARENT_UNAVAILABLE':
    case 'APPLICATION_UNAVAILABLE':
    case 'STALE_BASIS':
    case 'UNRESOLVED_AFFECTED':
      return new ProductRequestError(409, known.data.code);
    case 'PUBLIC_INVALID_RESPONSE':
    case 'PUBLIC_PREVIEW_INVALID_CONTEXT':
    case 'PUBLIC_PORT_UNAVAILABLE':
      return new ProductRequestError(500, 'INTERNAL_ERROR');
  }
}
function translateImpact(error: unknown): ProductRequestError | undefined {
  if (error instanceof RaceManualPublicError) {
    switch (error.code) {
      case 'PUBLIC_RESPONSE_LIMIT':
        return new ProductRequestError(413, error.code);
      case 'PUBLIC_PORT_UNAVAILABLE':
        return new ProductRequestError(503, error.code);
      case 'PUBLIC_REFERENCE_UNAVAILABLE':
        return new ProductRequestError(404, error.code);
      case 'PUBLIC_APPLICATION_UNAVAILABLE':
        return new ProductRequestError(409, error.code);
      case 'PUBLIC_INVALID_RESPONSE':
        return new ProductRequestError(500, 'INTERNAL_ERROR');
    }
  }
  if (!(error instanceof RacePlanImpactPreviewError)) return undefined;
  switch (error.code) {
    case 'INVALID_INTENT':
      return new ProductRequestError(400, error.code);
    case 'EVENT_UNAVAILABLE':
    case 'SOURCE_UNAVAILABLE':
      return new ProductRequestError(404, error.code);
    case 'REVISION_CONFLICT':
    case 'APP_CONSENT_REQUIRED':
      return new ProductRequestError(409, error.code);
    case 'CONTEXT_LIMIT':
      return new ProductRequestError(422, error.code);
    case 'INVALID_CONTEXT':
    case 'CONTEXT_UNAVAILABLE':
      return new ProductRequestError(503, 'PUBLIC_PORT_UNAVAILABLE');
  }
}
function response<T>(schema: z.ZodType<T>, value: unknown): T {
  const checked = schema.safeParse(value);
  if (!checked.success) throw new ProductRequestError(500, 'INTERNAL_ERROR');
  return checked.data;
}
/** Composition only. Register under createApi's authenticated session/CSRF
 * product boundary. Retained reads/replay and fresh processing are repository
 * responsibilities. This plugin neither activates configured storage nor
 * changes the existing direct race-date update policy. */
export function registerRaceManualPublicRoutes(
  routes: FastifyInstance,
  repository: RaceManualPublicRoutesRepository,
  principal: (request: FastifyRequest) => Principal,
): void {
  routes.register(async (api) => {
    api.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'private, no-store');
    });
    api.post('/races/:raceId/date-change-impact', { bodyLimit: 4194304 }, async (request) => {
      const athlete = principal(request).athleteId;
      input(emptyQuery, request.query);
      const { raceId } = input(reviewParams, request.params);
      const body = input(raceManualPublicPrepareSchema, request.body);
      if (
        request.headers['idempotency-key'] !== undefined ||
        body.intent.expectedEvent.id.toLowerCase() !== raceId
      )
        throw new ProductRequestError(400, 'INVALID_REQUEST');
      const impact = repository.impact;
      if (!impact) throw new ProductRequestError(503, 'PUBLIC_PORT_UNAVAILABLE');
      const result = response(
        raceManualPublicImpactSchema,
        await command(
          () =>
            impact(athlete, {
              ...body,
              intent: {
                ...body.intent,
                expectedEvent: { ...body.intent.expectedEvent, id: raceId },
              },
            }),
          translateImpact,
        ),
      );
      if (
        result.status === 'projected' &&
        (result.expectedEvent.id !== raceId ||
          result.expectedEvent.revision !== body.intent.expectedEvent.revision)
      )
        throw new ProductRequestError(500, 'INTERNAL_ERROR');
      return result;
    });
    api.post(
      '/races/:raceId/date-change-reviews',
      { bodyLimit: 4194304 },
      async (request, reply) => {
        const athlete = principal(request).athleteId;
        input(emptyQuery, request.query);
        const { raceId } = input(reviewParams, request.params);
        const body = input(raceManualPublicPrepareSchema, request.body);
        if (body.intent.expectedEvent.id.toLowerCase() !== raceId)
          throw new ProductRequestError(400, 'INVALID_REQUEST');
        const result = response(
          raceManualPublicReviewResultSchema,
          await command(
            () =>
              repository.review(athlete, {
                ...body,
                intent: {
                  ...body.intent,
                  expectedEvent: { ...body.intent.expectedEvent, id: raceId },
                },
                idempotencyKey: input(idempotencyKey, request.headers['idempotency-key']),
              }),
            translate,
          ),
        );
        return reply.code(result.status === 'reviewed' ? 201 : 409).send(result);
      },
    );
    api.get('/race-date-change-reviews/:candidateId', async (request) => {
      const athlete = principal(request).athleteId;
      input(emptyQuery, request.query);
      const { candidateId } = input(candidateParams, request.params);
      const raw = await command(() => repository.readPreview(athlete, candidateId), translate);
      if (raw === null) throw new ProductRequestError(404, 'NOT_FOUND');
      const result = response(raceManualPublicPreviewSchema, raw);
      if (result.reference.candidateId !== candidateId)
        throw new ProductRequestError(500, 'INTERNAL_ERROR');
      return result;
    });
    api.post(
      '/race-date-change-reviews/:candidateId/approve',
      { bodyLimit: 4194304 },
      async (request, reply) => {
        const athlete = principal(request).athleteId;
        input(emptyQuery, request.query);
        const { candidateId } = input(candidateParams, request.params);
        const body = input(raceManualPublicApproveSchema, request.body);
        const result = response(
          raceManualApprovalResultSchema,
          await command(
            () =>
              repository.approve(athlete, {
                ...body,
                candidateId,
                idempotencyKey: input(idempotencyKey, request.headers['idempotency-key']),
              }),
            translate,
          ),
        );
        if (result.candidateId !== candidateId)
          throw new ProductRequestError(500, 'INTERNAL_ERROR');
        return reply.code(result.status === 'committed' ? 200 : 409).send(result);
      },
    );
  });
}
