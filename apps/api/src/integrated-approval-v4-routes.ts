import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { decodeApprovalRequest } from '@workout/contracts/approval';
import {
  integratedApprovalResultV4Schema,
  integratedCandidateV4Schema,
} from '@workout/contracts/integrated-coaching';
import { integratedApprovalV023Schema } from '@workout/contracts/routines';
import {
  IntegratedApprovalV4Error,
  type IntegratedApprovalV4Repository,
} from '@workout/server-persistence/integrated-approval-v4';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const candidateParams = z.strictObject({ candidateId: uuid });
const candidateQuery = z.strictObject({
  maxSchemaVersion: z.coerce.number().int().min(1).max(4).default(3),
});
const keySchema = integratedApprovalV023Schema.shape.idempotencyKey;

function execute<T>(operation: () => Promise<T>): Promise<T> {
  return command(operation, (error) => {
    if (!(error instanceof IntegratedApprovalV4Error)) return undefined;
    const status =
      error.code === 'CANDIDATE_UNAVAILABLE'
        ? 404
        : error.code === 'AI_CONSENT_REQUIRED'
          ? 403
          : error.code === 'CANDIDATE_NOT_APPROVABLE'
            ? 422
            : 409;
    return new ProductRequestError(status, error.code);
  });
}

function approvalPayload(body: unknown, idempotencyKey: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  if ('idempotencyKey' in body) throw new ProductRequestError(400, 'INVALID_APPROVAL_PAYLOAD');
  return { ...body, idempotencyKey };
}

/** Schema v4 remains explicit; clients without negotiation retain the legacy v3 boundary. */
export function registerIntegratedApprovalV4Routes(
  routes: FastifyInstance,
  repository: IntegratedApprovalV4Repository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/integrated-candidates/:candidateId', async (request) => {
    const { candidateId } = input(candidateParams, request.params);
    const { maxSchemaVersion } = input(candidateQuery, request.query);
    if (maxSchemaVersion < 4) throw new ProductRequestError(409, 'UNSUPPORTED_SCHEMA_VERSION');

    const candidate = await execute(() =>
      repository.read(principal(request).athleteId, candidateId),
    );
    if (!candidate) throw new ProductRequestError(404, 'CANDIDATE_UNAVAILABLE');
    return integratedCandidateV4Schema.parse(candidate);
  });

  routes.post(
    '/integrated-candidates/:candidateId/approve',
    { bodyLimit: 32 * 1024 },
    async (request) => {
      input(emptyQuery, request.query);
      const { candidateId } = input(candidateParams, request.params);
      const idempotencyKey = input(keySchema, request.headers['idempotency-key']);
      const decoded = decodeApprovalRequest(approvalPayload(request.body, idempotencyKey));
      if (!decoded.ok) {
        throw new ProductRequestError(
          decoded.code === 'UNSUPPORTED_SCHEMA_VERSION' ? 409 : 400,
          decoded.code,
        );
      }
      if (decoded.data.schemaVersion !== 4)
        throw new ProductRequestError(409, 'UNSUPPORTED_SCHEMA_VERSION');
      const approval = integratedApprovalV023Schema.parse(decoded.data);
      if (approval.candidateId !== candidateId)
        throw new ProductRequestError(400, 'CANDIDATE_ID_MISMATCH');

      return integratedApprovalResultV4Schema.parse(
        await execute(() => repository.approve(principal(request).athleteId, approval)),
      );
    },
  );
}
