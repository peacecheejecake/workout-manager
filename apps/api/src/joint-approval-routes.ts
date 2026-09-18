import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  jointCandidatePartialSelectionV3Schema,
  jointCandidateV3Schema,
} from '@workout/contracts/joint-coaching';
import { jointApprovalRequestSchema } from '@workout/contracts/nutrition';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import {
  JointApprovalError,
  type JointApprovalRepository,
} from '@workout/server-persistence/joint-approval';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const candidateParams = z.strictObject({ candidateId: uuid });
const decisionParams = z.strictObject({ decisionId: uuid });
const keySchema = jointApprovalRequestSchema.shape.idempotencyKey;
const partialBody = z.strictObject({ selection: jointCandidatePartialSelectionV3Schema });
const resultSchema = z.strictObject({
  training: planSnapshotSchema.nullable(),
  nutrition: z.array(nutritionPlanVersionSchema),
});

function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (!(error instanceof JointApprovalError)) return undefined;
    const status =
      error.code === 'CANDIDATE_UNAVAILABLE'
        ? 404
        : error.code === 'AI_CONSENT_REQUIRED'
          ? 403
          : [
                'CANDIDATE_NOT_APPROVABLE',
                'INVALID_PROJECTION',
                'INVALID_PARTIAL_SELECTION',
                'NUTRITION_REFERENCE_INVALID',
                'CANDIDATE_LIMIT_REACHED',
                'RUN_NOT_READY',
              ].includes(error.code)
            ? 422
            : 409;
    return new ProductRequestError(status, error.code);
  });
}

/** Candidate content comes only from a persisted, server prepared proposal. */
export function registerJointApprovalRoutes(
  routes: FastifyInstance,
  repository: JointApprovalRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/joint-decisions/:decisionId/candidates', async (request) => {
    input(emptyQuery, request.query);
    const { decisionId } = input(decisionParams, request.params);
    return z
      .array(jointCandidateV3Schema)
      .max(100)
      .parse(await execute(() => repository.list(principal(request).athleteId, decisionId)));
  });

  routes.get('/joint-candidates/:candidateId', async (request) => {
    input(emptyQuery, request.query);
    const { candidateId } = input(candidateParams, request.params);
    const candidate = await execute(() =>
      repository.read(principal(request).athleteId, candidateId),
    );
    if (!candidate) throw new ProductRequestError(404, 'CANDIDATE_UNAVAILABLE');
    return jointCandidateV3Schema.parse(candidate);
  });

  routes.post(
    '/joint-candidates/:candidateId/partials',
    { bodyLimit: 32 * 1024 },
    async (request) => {
      input(emptyQuery, request.query);
      const { candidateId } = input(candidateParams, request.params);
      const { selection } = input(partialBody, request.body);
      const idempotencyKey = input(keySchema, request.headers['idempotency-key']);
      return jointCandidateV3Schema.parse(
        await execute(() =>
          repository.derivePartial(principal(request).athleteId, candidateId, {
            selection,
            idempotencyKey,
          }),
        ),
      );
    },
  );

  routes.post(
    '/joint-candidates/:candidateId/approve',
    { bodyLimit: 32 * 1024 },
    async (request) => {
      input(emptyQuery, request.query);
      const { candidateId } = input(candidateParams, request.params);
      const body = input(jointApprovalRequestSchema.omit({ idempotencyKey: true }), request.body);
      if (body.candidateId !== candidateId)
        throw new ProductRequestError(400, 'CANDIDATE_ID_MISMATCH');
      const idempotencyKey = input(keySchema, request.headers['idempotency-key']);
      return resultSchema.parse(
        await execute(() =>
          repository.approve(principal(request).athleteId, { ...body, idempotencyKey }),
        ),
      );
    },
  );
}
