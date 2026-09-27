import { nativeBridgeReadPathSchema } from '@workout/contracts/native-bridge';
import {
  transportRequestDtoSchema,
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import type { createNativeBridgeClient } from './native-bridge-client.js';

type NativeBridgeClient = ReturnType<typeof createNativeBridgeClient>;

/** Only two fixed, read-only product requests may cross the native auth boundary. */
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
      if (
        !parsed.success ||
        parsed.data.method !== 'GET' ||
        parsed.data.body !== null ||
        parsed.data.idempotencyKey !== null ||
        !nativeBridgeReadPathSchema.safeParse(parsed.data.path).success
      ) {
        throw new TypeError('Native transport accepts only fixed read requests');
      }
      const path = nativeBridgeReadPathSchema.parse(parsed.data.path);
      const result = await bridge.read(path, input.signal);
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
