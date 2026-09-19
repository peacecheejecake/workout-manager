import type { FastifyInstance, FastifyRequest } from 'fastify';

import { integratedCandidateV4Schema } from '@workout/contracts/integrated-coaching';
import { IntegratedApprovalV4Error } from '@workout/server-persistence/integrated-approval-v4';
import {
  IntegratedFixtureV4Error,
  integratedFixtureV4CreateSchema,
  type IntegratedFixtureV4Repository,
} from '@workout/server-persistence/integrated-fixture-v4';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (error instanceof IntegratedFixtureV4Error)
      return new ProductRequestError(
        error.code === 'INTEGRATED_FIXTURE_REFERENCE_INVALID' ? 422 : 404,
        error.code,
      );
    if (!(error instanceof IntegratedApprovalV4Error)) return undefined;
    const status =
      error.code === 'AI_CONSENT_REQUIRED'
        ? 403
        : error.code === 'CANDIDATE_UNAVAILABLE'
          ? 404
          : error.code === 'CANDIDATE_NOT_APPROVABLE'
            ? 422
            : 409;
    return new ProductRequestError(status, error.code);
  });
}

/** Registered only with an explicit nonproduction repository; proposed writes are server-owned. */
export function registerIntegratedFixtureV4Routes(
  routes: FastifyInstance,
  repository: IntegratedFixtureV4Repository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/integrated-fixture-v4-candidates', { bodyLimit: 4 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const body = input(
      integratedFixtureV4CreateSchema.omit({ idempotencyKey: true }),
      request.body,
    );
    const idempotencyKey = input(
      integratedFixtureV4CreateSchema.shape.idempotencyKey,
      request.headers['idempotency-key'],
    );
    return integratedCandidateV4Schema.parse(
      await execute(() =>
        repository.create(principal(request).athleteId, { ...body, idempotencyKey }),
      ),
    );
  });
}
