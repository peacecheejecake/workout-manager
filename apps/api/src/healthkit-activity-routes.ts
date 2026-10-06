import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  healthKitCreateActivityResultSchema,
  healthKitCreateActivitySchema,
} from '@workout/contracts/healthkit-activity';
import {
  HealthKitActivityError,
  type HealthKitActivityRepository,
} from '@workout/server-persistence/healthkit-activity';
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
  SAMPLE_UNAVAILABLE: 409,
  DIGEST_CONFLICT: 409,
  ALREADY_LINKED: 409,
  IDEMPOTENCY_CONFLICT: 409,
} as const;

export function registerHealthKitActivityRoutes(
  routes: FastifyInstance,
  repository: HealthKitActivityRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/healthkit/workout-activities', { bodyLimit: 4_096 }, async (request) => {
    input(emptyQuery, request.query);
    const owner = principal(request);
    const command = input(healthKitCreateActivitySchema, request.body);
    return healthKitCreateActivityResultSchema.parse(
      await executeCommand(
        () => repository.createActivity(owner.athleteId, command),
        (error) =>
          error instanceof HealthKitActivityError
            ? new ProductRequestError(statusByCode[error.code], error.code)
            : undefined,
      ),
    );
  });
}
