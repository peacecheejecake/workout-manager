import { z } from 'zod';
import type { AuthenticatedTransport, TransportRequest } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  recoveryActionLogSchema,
  recoveryMethodVersionSchema,
  recoveryStrategyVersionSchema,
  recoveryWorkspaceReadSchema,
  type ConfirmRecoveryStrategyRequest,
  type CorrectRecoveryActionRequest,
  type CreateRecoveryActionRequest,
  type CreateRecoveryMethodRequest,
  type CreateRecoveryStrategyRequest,
  type DeleteRecoveryActionRequest,
} from '@workout/contracts/recovery-core';

const errorSchema = z.object({ error: z.object({ code: z.string() }) });

export class RecoveryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function createRecoveryApi(transport: AuthenticatedTransport) {
  async function request<T>(
    path: string,
    method: TransportRequest['method'],
    schema: z.ZodType<T>,
    body: TransportRequest['body'] = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
  ) {
    const reply = transportReplySchema.parse(
      await transport.request({
        path,
        method,
        body,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      }),
    );
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = errorSchema.safeParse(reply.body);
      throw new RecoveryRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  return {
    workspace(signal?: AbortSignal) {
      return request('/bff/v1/recovery', 'GET', recoveryWorkspaceReadSchema, null, null, signal);
    },
    readStrategy(strategyId: string, signal?: AbortSignal) {
      return request(
        `/bff/v1/recovery/strategies/${encodeURIComponent(strategyId)}`,
        'GET',
        recoveryStrategyVersionSchema,
        null,
        null,
        signal,
      );
    },
    createMethod(input: CreateRecoveryMethodRequest) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/recovery/methods',
        'POST',
        recoveryMethodVersionSchema,
        body,
        idempotencyKey,
      );
    },
    createStrategy(input: CreateRecoveryStrategyRequest) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/recovery/strategy-drafts',
        'POST',
        recoveryStrategyVersionSchema,
        body,
        idempotencyKey,
      );
    },
    confirmStrategy(input: ConfirmRecoveryStrategyRequest) {
      const { idempotencyKey, strategyId, ...body } = input;
      return request(
        `/bff/v1/recovery/strategies/${encodeURIComponent(strategyId)}/confirm`,
        'POST',
        recoveryStrategyVersionSchema,
        body,
        idempotencyKey,
      );
    },
    createAction(input: CreateRecoveryActionRequest) {
      const { idempotencyKey, ...body } = input;
      return request(
        '/bff/v1/recovery/action-logs',
        'POST',
        recoveryActionLogSchema,
        body,
        idempotencyKey,
      );
    },
    correctAction(input: CorrectRecoveryActionRequest) {
      const { idempotencyKey, actionId, ...body } = input;
      return request(
        `/bff/v1/recovery/action-logs/${encodeURIComponent(actionId)}`,
        'PATCH',
        recoveryActionLogSchema,
        body,
        idempotencyKey,
      );
    },
    deleteAction(input: DeleteRecoveryActionRequest) {
      const { idempotencyKey, actionId, ...body } = input;
      return request(
        `/bff/v1/recovery/action-logs/${encodeURIComponent(actionId)}`,
        'DELETE',
        z.object({ status: z.literal('deleted') }),
        body,
        idempotencyKey,
      );
    },
  };
}
