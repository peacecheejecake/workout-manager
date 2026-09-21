import type { RoutingEngineEndpoint } from './endpoint.js';

/**
 * The one place an HTTP call to the routing engine happens. The adapter above it sees a
 * port, so the engine can be replaced or faked without HTTP leaking further inward.
 */
export interface RoutingEngineResponse {
  readonly status: number;
  /** Decoded body, already bounded. Parsing is the adapter's job. */
  readonly bodyText: string;
  /** True when the engine sent more bytes than the cap; the body is then not parseable. */
  readonly truncated: boolean;
  readonly byteLength: number;
}

export class RoutingTransportError extends Error {
  constructor(
    readonly code:
      'ENGINE_UNREACHABLE' | 'ENGINE_REDIRECTED' | 'ENGINE_RESPONSE_TOO_LARGE' | 'ENGINE_ABORTED',
  ) {
    super(code);
    this.name = 'RoutingTransportError';
  }
}

export interface RoutingEngineTransportRequest {
  readonly path: string;
  readonly query: URLSearchParams;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

export interface RoutingEngineTransport {
  get(request: RoutingEngineTransportRequest): Promise<RoutingEngineResponse>;
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * `redirect: 'error'` matters: the engine must answer itself. Following a redirect would
 * let a misconfigured or compromised endpoint move our internal call to another host,
 * and the allowlist check only sees the first URL.
 */
export function createFetchRoutingTransport(
  endpoint: RoutingEngineEndpoint,
  fetchImplementation: FetchLike = (input, init) => fetch(input, init),
): RoutingEngineTransport {
  return {
    async get({ path, query, signal, maxBytes }) {
      const url = endpoint.resolve(path, query);
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: 'GET',
          redirect: 'error',
          credentials: 'omit',
          headers: { accept: 'application/json' },
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw new RoutingTransportError('ENGINE_ABORTED');
        if (error instanceof TypeError && /redirect/i.test(error.message))
          throw new RoutingTransportError('ENGINE_REDIRECTED');
        throw new RoutingTransportError('ENGINE_UNREACHABLE');
      }
      if (response.redirected) {
        await response.body?.cancel();
        throw new RoutingTransportError('ENGINE_REDIRECTED');
      }
      const body = response.body;
      if (body === null)
        return { status: response.status, bodyText: '', truncated: false, byteLength: 0 };
      const reader = body.getReader();
      const decoder = new TextDecoder('utf-8');
      let text = '';
      let byteLength = 0;
      let truncated = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          byteLength += value.byteLength;
          if (byteLength > maxBytes) {
            truncated = true;
            break;
          }
          text += decoder.decode(value, { stream: true });
        }
        if (!truncated) text += decoder.decode();
      } catch {
        if (signal.aborted) throw new RoutingTransportError('ENGINE_ABORTED');
        throw new RoutingTransportError('ENGINE_UNREACHABLE');
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      if (truncated) throw new RoutingTransportError('ENGINE_RESPONSE_TOO_LARGE');
      return { status: response.status, bodyText: text, truncated, byteLength };
    },
  };
}
