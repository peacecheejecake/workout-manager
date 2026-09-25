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
      | 'ENGINE_UNREACHABLE'
      | 'ENGINE_REDIRECTED'
      | 'ENGINE_RESPONSE_TOO_LARGE'
      | 'ENGINE_ABORTED'
      /** A method and path that do not belong together; nothing was sent. */
      | 'ENGINE_REQUEST_SHAPE_REFUSED',
  ) {
    super(code);
    this.name = 'RoutingTransportError';
  }
}

/** A JSON object body. The transport serialises it; callers never build request text. */
export type RoutingEngineJsonBody = Readonly<Record<string, unknown>>;

/**
 * One call to the engine. Which method goes with which path is part of the type, and the
 * transport checks it again at run time.
 *
 * A route request carries the user's waypoints, so it is a POST with a JSON body
 * (M2-01af). A request line (method, path, query string) is exactly what an access log
 * writes, and Dropwizard's default request log writes one for every call. With the
 * waypoints in the body, an engine launched without the repository's logging settings has
 * nothing to leak there. `/info` and `/health` carry nothing and stay GETs. No request has
 * a query string: the endpoint cannot build one.
 */
export type RoutingEngineTransportRequest = {
  readonly signal: AbortSignal;
  readonly maxBytes: number;
} & (
  | { readonly method: 'GET'; readonly path: '/info' | '/health' }
  | { readonly method: 'POST'; readonly path: '/route'; readonly json: RoutingEngineJsonBody }
);

export interface RoutingEngineTransport {
  send(request: RoutingEngineTransportRequest): Promise<RoutingEngineResponse>;
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
    async send(request) {
      const { path, signal, maxBytes } = request;
      // The type pairs them already; this also holds for JavaScript callers and casts.
      const shapeHolds =
        request.method === 'POST'
          ? path === '/route' && typeof request.json === 'object' && request.json !== null
          : request.method === 'GET' && (path === '/info' || path === '/health');
      if (!shapeHolds) throw new RoutingTransportError('ENGINE_REQUEST_SHAPE_REFUSED');
      const url = endpoint.resolve(path);
      let response: Response;
      try {
        response = await fetchImplementation(url, {
          method: request.method,
          redirect: 'error',
          credentials: 'omit',
          ...(request.method === 'POST'
            ? {
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(request.json),
              }
            : { headers: { accept: 'application/json' } }),
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
