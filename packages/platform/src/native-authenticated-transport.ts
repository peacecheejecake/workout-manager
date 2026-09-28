import {
  nativeBridgeActivityReadPathSchema,
  nativeBridgeReadPathSchema,
} from '@workout/contracts/native-bridge';
import { healthKitCreateActivitySchema } from '@workout/contracts/healthkit-activity';
import { healthKitBindExistingSchema } from '@workout/contracts/healthkit-binding';
import {
  transportRequestDtoSchema,
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import type { createNativeBridgeClient } from './native-bridge-client.js';

type NativeBridgeClient = ReturnType<typeof createNativeBridgeClient>;

/** Curated product requests cross the native auth boundary; the bearer stays in the host. */
export function createNativeAuthenticatedTransport(
  bridge: NativeBridgeClient,
  onUnauthorized: () => void,
): AuthenticatedTransport {
  return {
    async request(input: TransportRequest) {
      const parsed = transportRequestDtoSchema.safeParse({
        path: input.path,
        method: input.method,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
      });
      if (!parsed.success) throw new TypeError('Invalid native transport request');
      const { path, method, body, idempotencyKey } = parsed.data;
      let result;
      if (method === 'GET' && body === null && idempotencyKey === null) {
        const fixed = nativeBridgeReadPathSchema.safeParse(path);
        if (fixed.success) result = await bridge.read(fixed.data, input.signal);
        else {
          const product = nativeBridgeActivityReadPathSchema.safeParse(path);
          if (!product.success) throw new TypeError('Native read path is not allowed');
          result = await bridge.readActivity(product.data, input.signal);
        }
      } else if (method === 'POST' && typeof idempotencyKey === 'string') {
        const kind =
          path === '/bff/v1/healthkit/workout-activities'
            ? 'create'
            : path === '/bff/v1/healthkit/workout-bindings'
              ? 'link'
              : null;
        if (kind === null) throw new TypeError('Native write path is not allowed');
        if (kind === 'create') {
          const payload = healthKitCreateActivitySchema.safeParse(body);
          if (!payload.success || payload.data.idempotencyKey !== idempotencyKey)
            throw new TypeError('Native HealthKit decision is invalid');
          result = await bridge.writeHealthKitDecision({ kind, body: payload.data }, input.signal);
        } else {
          const payload = healthKitBindExistingSchema.safeParse(body);
          if (!payload.success || payload.data.idempotencyKey !== idempotencyKey)
            throw new TypeError('Native HealthKit decision is invalid');
          result = await bridge.writeHealthKitDecision({ kind, body: payload.data }, input.signal);
        }
      } else throw new TypeError('Native transport request is not allowed');
      if (!result.ok) throw new Error(`NATIVE_TRANSPORT_${result.code}`);
      if (result.value.status === 401) onUnauthorized();
      return transportReplySchema.parse({
        status: result.value.status,
        body: result.value.body,
        traceId: null,
      });
    },
  };
}
