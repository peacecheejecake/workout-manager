import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  checkInCreateSchema,
  checkInUpdateSchema,
  checkInDeleteSchema,
  checkInSchema,
  checkInCommandResultSchema,
  checkInListQuerySchema,
  checkInListSchema,
} from '@workout/contracts/check-ins';
import {
  CheckInNotFound,
  CheckInValidationError,
  type CheckInRepository,
} from '@workout/server-persistence/check-ins';
import type { Principal } from './ports.js';
import { input, command, emptyQuery, ProductRequestError } from './product-boundary.js';

const params = z.strictObject({ id: z.uuid() });
function checkInCommand<T>(operation: () => Promise<T>) {
  return command(operation, (error) => {
    if (error instanceof CheckInNotFound) return new ProductRequestError(404, 'NOT_FOUND');
    if (error instanceof CheckInValidationError) return new ProductRequestError(400, error.code);
    return undefined;
  });
}

export function registerCheckInRoutes(
  routes: FastifyInstance,
  checkIns: CheckInRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/check-ins', async (request) =>
    checkInListSchema.parse(
      await checkIns.listCheckIns(
        principal(request).athleteId,
        input(checkInListQuerySchema, request.query),
      ),
    ),
  );
  routes.get('/check-ins/:id', async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const result = await checkIns.getCheckIn(principal(request).athleteId, id);
    if (!result) throw new ProductRequestError(404, 'NOT_FOUND');
    return checkInSchema.parse(result);
  });
  routes.post('/check-ins', async (request) => {
    input(emptyQuery, request.query);
    const body = input(checkInCreateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(checkInCreateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return checkInCommandResultSchema.parse(
      await checkInCommand(() => checkIns.createCheckIn(principal(request).athleteId, payload)),
    );
  });
  routes.put('/check-ins/:id', async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const body = input(checkInUpdateSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(checkInUpdateSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return checkInCommandResultSchema.parse(
      await checkInCommand(() => checkIns.updateCheckIn(principal(request).athleteId, id, payload)),
    );
  });
  routes.delete('/check-ins/:id', async (request) => {
    input(emptyQuery, request.query);
    const { id } = input(params, request.params);
    const body = input(checkInDeleteSchema.omit({ idempotencyKey: true }), request.body);
    const payload = input(checkInDeleteSchema, {
      ...body,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return checkInCommandResultSchema.parse(
      await checkInCommand(() => checkIns.deleteCheckIn(principal(request).athleteId, id, payload)),
    );
  });
}
