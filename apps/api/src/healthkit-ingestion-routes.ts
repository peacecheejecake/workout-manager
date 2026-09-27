import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  healthKitIngestionAckSchema,
  healthKitIngestionBatchSchema,
} from '@workout/contracts/healthkit-ingestion';
import {
  HealthKitIngestionError,
  type HealthKitIngestionRepository,
} from '@workout/server-persistence/healthkit-ingestion';
import type { Principal } from './ports.js';
import { emptyQuery, input, ProductRequestError } from './product-boundary.js';

export function registerHealthKitIngestionRoutes(
  routes: FastifyInstance,
  repository: HealthKitIngestionRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.post('/healthkit/workout-batches', { bodyLimit: 65_536 }, async (request) => {
    input(emptyQuery, request.query);
    const owner = principal(request);
    if (owner.method !== 'bearer') throw new ProductRequestError(403, 'BEARER_REQUIRED');
    const batch = input(healthKitIngestionBatchSchema, request.body);
    try {
      return healthKitIngestionAckSchema.parse(
        await repository.ingestBatch(owner.athleteId, batch),
      );
    } catch (error) {
      if (error instanceof HealthKitIngestionError) {
        throw new ProductRequestError(error.code === 'CONSENT_REQUIRED' ? 403 : 409, error.code);
      }
      throw error;
    }
  });
}
