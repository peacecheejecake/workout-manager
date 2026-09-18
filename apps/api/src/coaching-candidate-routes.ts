import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  trainingCandidateApprovalBodyV1Schema,
  trainingCandidateBundleV1Schema,
  trainingCandidatePartialBodyV1Schema,
  trainingCandidatePartialRequestV1Schema,
  trainingCandidateStatusV1Schema,
} from '@workout/contracts/coaching-candidates';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  TrainingCandidateError,
  type TrainingCandidateRepository,
} from '@workout/server-persistence/coaching-candidates';
import { CombinedReviewRequiredError, PlanLockedError } from '@workout/server-persistence/planning';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';
import { sessionCompletionRequestError } from './session-completion-routes.js';

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
    if (error instanceof PlanLockedError) return new ProductRequestError(409, 'PLAN_LOCKED');
    if (error instanceof CombinedReviewRequiredError)
      return new ProductRequestError(409, 'COMBINED_REVIEW_REQUIRED');
    if (!(error instanceof TrainingCandidateError)) return sessionCompletionRequestError(error);
    const statusCode = ['RUN_NOT_FOUND', 'CANDIDATE_UNAVAILABLE'].includes(error.code)
      ? 404
      : [
            'EVIDENCE_UNAVAILABLE',
            'INVALID_FIXTURE_OUTPUT',
            'CANDIDATE_TOO_LARGE',
            'INVALID_PARTIAL_SELECTION',
            'CANDIDATE_NOT_APPROVABLE',
          ].includes(error.code)
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

  routes.post(
    '/coaching-candidates/:candidateId/partials',
    { bodyLimit: 256 * 1024 },
    async (request) => {
      input(emptyQuery, request.query);
      const { candidateId } = input(candidateParams, request.params);
      const body = input(trainingCandidatePartialBodyV1Schema, request.body);
      const key = input(
        trainingCandidatePartialRequestV1Schema.shape.idempotencyKey,
        request.headers['idempotency-key'],
      );
      const command = input(trainingCandidatePartialRequestV1Schema, {
        ...body,
        idempotencyKey: key,
      });
      return trainingCandidateBundleV1Schema.parse(
        await execute(() =>
          repository.derivePartial(principal(request).athleteId, candidateId, {
            sessionIds: command.sessionIds,
            periodIds: command.periodIds,
            includeTitle: command.includeTitle,
            idempotencyKey: command.idempotencyKey,
          }),
        ),
      );
    },
  );

  routes.get('/coaching-candidates/:candidateId/status', async (request) => {
    input(emptyQuery, request.query);
    const { candidateId } = input(candidateParams, request.params);
    const status = await execute(() =>
      repository.status(principal(request).athleteId, candidateId),
    );
    if (!status) throw new ProductRequestError(404, 'CANDIDATE_UNAVAILABLE');
    return trainingCandidateStatusV1Schema.parse(status);
  });

  routes.post('/coaching-candidates/:candidateId/approve', { bodyLimit: 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { candidateId } = input(candidateParams, request.params);
    const body = input(trainingCandidateApprovalBodyV1Schema, request.body);
    const key = input(idempotencyKey, request.headers['idempotency-key']);
    return planSnapshotSchema.parse(
      await execute(() =>
        repository.approve(principal(request).athleteId, candidateId, {
          expectedDigest: body.expectedDigest,
          confirmed: body.confirmed,
          idempotencyKey: key,
        }),
      ),
    );
  });
}
