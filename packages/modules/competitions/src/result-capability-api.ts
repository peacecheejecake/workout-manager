import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { raceResultCapabilitiesSchema } from '@workout/contracts/race-result-capabilities';

export class ResultCapabilityError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'INVALID_RESPONSE') {
    super(code);
    this.name = 'ResultCapabilityError';
  }
}

/** Protocol support only; it grants no consent, proof verification or write authority. */
export function createResultCapabilityApi(transport: AuthenticatedTransport) {
  return {
    async read(signal: AbortSignal) {
      signal.throwIfAborted();
      let raw: unknown;
      try {
        raw = await transport.request({
          path: '/bff/v1/race-results/capabilities',
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new ResultCapabilityError('UNAVAILABLE');
      }
      signal.throwIfAborted();
      const reply = transportReplySchema.safeParse(raw);
      if (!reply.success) throw new ResultCapabilityError('INVALID_RESPONSE');
      if (reply.data.status !== 200) throw new ResultCapabilityError('UNAVAILABLE');
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(reply.data.body);
      } catch {
        throw new ResultCapabilityError('INVALID_RESPONSE');
      }
      if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > 256)
        throw new ResultCapabilityError('INVALID_RESPONSE');
      const body = raceResultCapabilitiesSchema.safeParse(reply.data.body);
      if (!body.success) throw new ResultCapabilityError('INVALID_RESPONSE');
      return body.data;
    },
  };
}
