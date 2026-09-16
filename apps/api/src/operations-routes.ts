import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  accountExportSchema,
  operationsStatusSchema,
  eraseAccountSchema,
  eraseAccountResultSchema,
} from '@workout/contracts/operations';
import { OperationsError, type OperationsRepository } from '@workout/server-persistence/operations';
import type { Principal } from './ports.js';
import { input, emptyQuery, command, ProductRequestError } from './product-boundary.js';

function execute<T>(operation: () => Promise<T>) {
  return command(operation, (error) =>
    error instanceof OperationsError
      ? new ProductRequestError(error.code === 'EXPORT_TOO_LARGE' ? 413 : 409, error.code)
      : undefined,
  );
}
export function registerOperationsRoutes(
  routes: FastifyInstance,
  repository: OperationsRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/operations/status', async (request) => {
    input(emptyQuery, request.query);
    return operationsStatusSchema.parse(await repository.status(principal(request).athleteId));
  });
  routes.post('/operations/export', async (request, reply) => {
    input(emptyQuery, request.query);
    if (request.body !== undefined) throw new ProductRequestError(400, 'INVALID_REQUEST');
    const result = accountExportSchema.parse(
      await execute(() => repository.exportAccount(principal(request).athleteId)),
    );
    return reply
      .header('content-disposition', 'attachment; filename="workout-account.json"')
      .send(result);
  });
  routes.delete('/operations/account', async (request) => {
    input(emptyQuery, request.query);
    input(eraseAccountSchema, request.body);
    return eraseAccountResultSchema.parse(
      await execute(() => repository.eraseAccount(principal(request).athleteId)),
    );
  });
}
