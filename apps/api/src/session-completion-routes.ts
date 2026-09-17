import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  sessionCompletionPathSchema,
  sessionCompletionBodySchema,
  sessionCompletionCommandSchema,
  sessionCompletionListSchema,
  sessionCompletionReadSchema,
  sessionCompletionResultSchema,
} from '@workout/contracts/session-completion';
import {
  SessionCompletionError,
  type SessionCompletionRepository,
} from '@workout/server-persistence/session-completions';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

export function sessionCompletionRequestError(error: unknown): ProductRequestError | undefined {
  if (!(error instanceof SessionCompletionError)) return undefined;
  return new ProductRequestError(
    error.code === 'SESSION_COMPLETION_NOT_FOUND' ? 404 : 409,
    error.code,
  );
}
export function registerSessionCompletionRoutes(
  routes: FastifyInstance,
  repository: SessionCompletionRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/plans/current/session-completions', async (request) => {
    input(emptyQuery, request.query);
    return sessionCompletionListSchema.parse(await repository.list(principal(request).athleteId));
  });
  routes.get('/plans/sessions/:sessionId/completion', async (request) => {
    input(emptyQuery, request.query);
    const { sessionId } = input(sessionCompletionPathSchema, request.params);
    const result = await repository.read(principal(request).athleteId, sessionId);
    if (result === null) throw new ProductRequestError(404, 'SESSION_COMPLETION_NOT_FOUND');
    return sessionCompletionReadSchema.parse(result);
  });
  routes.post('/plans/sessions/:sessionId/completion', async (request) => {
    input(emptyQuery, request.query);
    const { sessionId } = input(sessionCompletionPathSchema, request.params);
    const body = input(sessionCompletionBodySchema, request.body);
    const payload = input(sessionCompletionCommandSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return sessionCompletionResultSchema.parse(
      await command(
        () => repository.write(principal(request).athleteId, sessionId, payload),
        sessionCompletionRequestError,
      ),
    );
  });
}
