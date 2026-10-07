import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  raceManualPublicPrepareSchema,
  raceManualPublicApproveSchema,
  raceManualPublicReviewResultSchema,
} from '@workout/contracts/race-manual-public';
import { raceManualPublicPreviewSchema } from '@workout/contracts/race-manual-public-preview';
import { raceManualApprovalResultSchema } from '@workout/contracts/race-manual-approval';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

/** Exact public factory surface. Unknown repository responses are decoded before
 * transport; this port accepts no browser source/basis/recipe authority. */
export interface RaceManualPublicRoutesRepository {
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
