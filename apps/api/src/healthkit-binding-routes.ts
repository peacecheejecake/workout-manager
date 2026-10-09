import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  healthKitBindExistingResultSchema,
  healthKitBindExistingSchema,
} from '@workout/contracts/healthkit-binding';
import {
  HealthKitBindingError,
  type HealthKitBindingRepository,
} from '@workout/server-persistence/healthkit-binding';
import type { Principal } from './ports.js';
import {
  emptyQuery,
  input,
  command as executeCommand,
  ProductRequestError,
} from './product-boundary.js';

const statusByCode = {
  CONSENT_REQUIRED: 403,
  SAMPLE_NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,
  SAMPLE_UNAVAILABLE: 409,
  TARGET_UNAVAILABLE: 409,
  REVISION_CONFLICT: 409,
  DIGEST_CONFLICT: 409,
  ALREADY_LINKED: 409,
  IDEMPOTENCY_CONFLICT: 409,
} as const;

export function registerHealthKitBindingRoutes(
  routes: FastifyInstance,
  repository: HealthKitBindingRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/healthkit/workout-bindings', { bodyLimit: 4_096 }, async (request) => {
    input(emptyQuery, request.query);
    const owner = principal(request);
    const command = input(healthKitBindExistingSchema, request.body);
    return healthKitBindExistingResultSchema.parse(
      await executeCommand(
        () => repository.bindExisting(owner.athleteId, command),
        (error) =>
          error instanceof HealthKitBindingError
            ? new ProductRequestError(statusByCode[error.code], error.code)
            : undefined,
      ),
    );
  });
}
