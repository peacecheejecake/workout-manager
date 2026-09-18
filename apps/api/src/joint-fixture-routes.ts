import type { FastifyInstance, FastifyRequest } from 'fastify';

import { jointCandidateV3Schema } from '@workout/contracts/joint-coaching';
import { CoreEvidenceSnapshotError } from '@workout/server-persistence/evidence-snapshots';
import { JointApprovalError } from '@workout/server-persistence/joint-approval';
import {
  JointFixtureError,
  jointFixtureCreateSchema,
  type JointFixtureRepository,
} from '@workout/server-persistence/joint-fixture';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (error instanceof JointFixtureError) return new ProductRequestError(404, error.code);
    if (error instanceof CoreEvidenceSnapshotError)
      return new ProductRequestError(
        error.code === 'THREAD_NOT_FOUND' ? 404 : error.code === 'EVIDENCE_TOO_LARGE' ? 413 : 409,
        error.code,
      );
    if (!(error instanceof JointApprovalError)) return undefined;
    const status =
      error.code === 'AI_CONSENT_REQUIRED'
        ? 403
        : ['RUN_NOT_READY', 'CANDIDATE_UNAVAILABLE'].includes(error.code)
          ? 404
          : ['NUTRITION_REFERENCE_INVALID', 'INVALID_PROJECTION'].includes(error.code)
            ? 422
            : 409;
    return new ProductRequestError(status, error.code);
  });
}

/** Registered only for an explicit nonproduction fixture; no proposed writes are accepted. */
export function registerJointFixtureRoutes(
  routes: FastifyInstance,
  repository: JointFixtureRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/joint-fixture-candidates', { bodyLimit: 4 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(jointFixtureCreateSchema.omit({ idempotencyKey: true }), request.body);
    const idempotencyKey = input(
      jointFixtureCreateSchema.shape.idempotencyKey,
      request.headers['idempotency-key'],
    );
    return jointCandidateV3Schema.parse(
      await execute(() =>
        repository.create(principal(request).athleteId, { ...body, idempotencyKey }),
      ),
    );
  });
}
