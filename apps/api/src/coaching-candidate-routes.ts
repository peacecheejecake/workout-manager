import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { trainingCandidateBundleV1Schema } from '@workout/contracts/coaching-candidates';
import {
  TrainingCandidateError,
  type TrainingCandidateRepository,
} from '@workout/server-persistence/coaching-candidates';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const runParams = z.strictObject({ runId: uuid });
const candidateParams = z.strictObject({ candidateId: uuid });
const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());

function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (!(error instanceof TrainingCandidateError)) return undefined;
    const statusCode = ['RUN_NOT_FOUND', 'CANDIDATE_UNAVAILABLE'].includes(error.code)
      ? 404
      : ['EVIDENCE_UNAVAILABLE', 'INVALID_FIXTURE_OUTPUT', 'CANDIDATE_TOO_LARGE'].includes(
            error.code,
          )
        ? 422
        : 409;
    return new ProductRequestError(statusCode, error.code);
  });
}

/** Only server-owned fixture intent is accepted; callers cannot submit a proposed plan. */
export function registerCoachingCandidateRoutes(
  routes: FastifyInstance,
  repository: TrainingCandidateRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/coaching-runs/:runId/candidates', { bodyLimit: 1024 }, async (request) => {
    input(emptyQuery, request.query);
    if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
    const { runId } = input(runParams, request.params);
    const key = input(idempotencyKey, request.headers['idempotency-key']);
    return trainingCandidateBundleV1Schema.parse(
      await execute(() =>
        repository.createFromFixture(principal(request).athleteId, {
          runId,
          idempotencyKey: key,
        }),
      ),
    );
  });

  routes.get('/coaching-runs/:runId/candidates', async (request) => {
    input(emptyQuery, request.query);
    const { runId } = input(runParams, request.params);
    return z
      .array(trainingCandidateBundleV1Schema)
      .max(100)
      .parse(await execute(() => repository.list(principal(request).athleteId, runId)));
  });

  routes.get('/coaching-candidates/:candidateId', async (request) => {
    input(emptyQuery, request.query);
    const { candidateId } = input(candidateParams, request.params);
    const result = await execute(() => repository.read(principal(request).athleteId, candidateId));
    if (!result) throw new ProductRequestError(404, 'CANDIDATE_UNAVAILABLE');
    return trainingCandidateBundleV1Schema.parse(result);
  });
}
