import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  confirmRecoveryStrategyRequestSchema,
  correctRecoveryActionRequestSchema,
  createRecoveryActionRequestSchema,
  createRecoveryMethodRequestSchema,
  createRecoveryStrategyRequestSchema,
  deleteRecoveryActionRequestSchema,
  deletedRecoveryActionSchema,
  recoveryActionLogSchema,
  recoveryMethodVersionSchema,
  recoveryStrategyVersionSchema,
  recoveryWorkspaceReadSchema,
} from '@workout/contracts/recovery-core';
import {
  RecoveryReferenceError,
  RecoveryValidationError,
  type RecoveryRepository,
} from '@workout/server-persistence/recovery-core';
import type { Principal } from './ports.js';
import { command, emptyQuery, input, ProductRequestError } from './product-boundary.js';

const strategyPath = z.strictObject({
  strategyId: z.uuid().transform((value) => value.toLowerCase()),
});
const actionPath = z.strictObject({ actionId: z.uuid().transform((value) => value.toLowerCase()) });
const recordSchema = z.record(z.string(), z.unknown());

function withHeaders<T>(
  schema: z.ZodType<T>,
  body: unknown,
  additions: Record<string, unknown>,
): T {
  const record = input(recordSchema, body);
  if (Object.keys(additions).some((key) => key in record))
    throw new ProductRequestError(400, 'INVALID_REQUEST');
  return input(schema, { ...record, ...additions });
}

function recoveryError(error: unknown) {
  if (error instanceof RecoveryValidationError) {
    return new ProductRequestError(422, error.code);
  }
  if (error instanceof RecoveryReferenceError) {
    const status = ['OPTION_LINK_INVALID'].includes(error.code) ? 422 : 404;
    return new ProductRequestError(status, error.code);
  }
  return undefined;
}

export function registerRecoveryRoutes(
  routes: FastifyInstance,
  recovery: RecoveryRepository,
  principal: (request: FastifyRequest) => Principal,
) {
  routes.get('/recovery', async (request) => {
    input(emptyQuery, request.query);
    return recoveryWorkspaceReadSchema.parse(
      await recovery.workspace(principal(request).athleteId),
    );
  });
  routes.get('/recovery/strategies/:strategyId', async (request) => {
    input(emptyQuery, request.query);
    const { strategyId } = input(strategyPath, request.params);
    const result = await recovery.readStrategy(principal(request).athleteId, strategyId);
    if (result === null) throw new ProductRequestError(404, 'STRATEGY_NOT_FOUND');
    return recoveryStrategyVersionSchema.parse(result);
  });
  routes.post('/recovery/methods', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const payload = withHeaders(createRecoveryMethodRequestSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return recoveryMethodVersionSchema.parse(
      await command(
        () => recovery.createMethod(principal(request).athleteId, payload),
        recoveryError,
      ),
    );
  });
  routes.post('/recovery/strategy-drafts', { bodyLimit: 512 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const payload = withHeaders(createRecoveryStrategyRequestSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return recoveryStrategyVersionSchema.parse(
      await command(
        () => recovery.createStrategy(principal(request).athleteId, payload),
        recoveryError,
      ),
    );
  });
  routes.post('/recovery/strategies/:strategyId/confirm', async (request) => {
    input(emptyQuery, request.query);
    const { strategyId } = input(strategyPath, request.params);
    const payload = withHeaders(confirmRecoveryStrategyRequestSchema, request.body, {
      strategyId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return recoveryStrategyVersionSchema.parse(
      await command(
        () => recovery.confirmStrategy(principal(request).athleteId, payload),
        recoveryError,
      ),
    );
  });
  routes.post('/recovery/action-logs', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const payload = withHeaders(createRecoveryActionRequestSchema, request.body, {
      idempotencyKey: request.headers['idempotency-key'],
    });
    return recoveryActionLogSchema.parse(
      await command(
        () => recovery.createAction(principal(request).athleteId, payload),
        recoveryError,
      ),
    );
  });
  routes.patch('/recovery/action-logs/:actionId', { bodyLimit: 128 * 1024 }, async (request) => {
    input(emptyQuery, request.query);
    const { actionId } = input(actionPath, request.params);
    const payload = withHeaders(correctRecoveryActionRequestSchema, request.body, {
      actionId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return recoveryActionLogSchema.parse(
      await command(
        () => recovery.correctAction(principal(request).athleteId, payload),
        recoveryError,
      ),
    );
  });
  routes.delete('/recovery/action-logs/:actionId', async (request) => {
    input(emptyQuery, request.query);
    const { actionId } = input(actionPath, request.params);
    const payload = withHeaders(deleteRecoveryActionRequestSchema, request.body, {
      actionId,
      idempotencyKey: request.headers['idempotency-key'],
    });
    return deletedRecoveryActionSchema.parse(
      await command(
        () => recovery.deleteAction(principal(request).athleteId, payload),
        recoveryError,
      ),
    );
  });
}
