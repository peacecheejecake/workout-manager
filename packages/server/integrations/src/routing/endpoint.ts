/**
 * Where the self-hosted routing engine lives, as operations configuration.
 *
 * There is no request-supplied URL path into this module and none may be added: the
 * internal routing request contract has no URL field, and this factory takes a
 * configuration string plus an explicit host allowlist. The default allowlist is
 * loopback only, which matches how the engine binds.
 *
 * Reachability from outside the host is an operations property — a firewall or network
 * namespace — and this file cannot prove it. What it does guarantee is that our server
 * only ever talks to an allowlisted host.
 */
export class RoutingEndpointError extends Error {
  constructor(
    readonly code:
      | 'ENDPOINT_MALFORMED'
      | 'ENDPOINT_SCHEME_NOT_ALLOWED'
      | 'ENDPOINT_CREDENTIALS_NOT_ALLOWED'
      | 'ENDPOINT_QUERY_NOT_ALLOWED'
      | 'ENDPOINT_PATH_NOT_ALLOWED'
      | 'ENDPOINT_HOST_NOT_ALLOWED',
  ) {
    super(code);
    this.name = 'RoutingEndpointError';
  }
}

/** Loopback only. An operator who runs the engine elsewhere must name that host. */
export const defaultRoutingEngineHosts = Object.freeze(['127.0.0.1', 'localhost', '[::1]']);

export interface RoutingEngineEndpoint {
  /** Absolute URL of one engine path. Never built from anything a user supplied. */
  resolve(path: string, query: URLSearchParams): URL;
  readonly host: string;
}

export interface RoutingEngineEndpointOptions {
  readonly allowedHosts?: readonly string[];
}

const enginePaths = Object.freeze(['/route', '/info', '/health']);

export function createRoutingEngineEndpoint(
  baseUrl: string,
  options: RoutingEngineEndpointOptions = {},
): RoutingEngineEndpoint {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RoutingEndpointError('ENDPOINT_MALFORMED');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new RoutingEndpointError('ENDPOINT_SCHEME_NOT_ALLOWED');
  if (parsed.username !== '' || parsed.password !== '')
    throw new RoutingEndpointError('ENDPOINT_CREDENTIALS_NOT_ALLOWED');
  if (parsed.search !== '' || parsed.hash !== '')
    throw new RoutingEndpointError('ENDPOINT_QUERY_NOT_ALLOWED');
  if (parsed.pathname !== '/') throw new RoutingEndpointError('ENDPOINT_PATH_NOT_ALLOWED');
  const allowed = new Set(options.allowedHosts ?? defaultRoutingEngineHosts);
  if (!allowed.has(parsed.hostname)) throw new RoutingEndpointError('ENDPOINT_HOST_NOT_ALLOWED');
  const origin = parsed.origin;
  return {
    host: parsed.hostname,
    resolve(path, query) {
      // A closed set of paths, so a future caller cannot smuggle one in.
      if (!enginePaths.includes(path)) throw new RoutingEndpointError('ENDPOINT_PATH_NOT_ALLOWED');
      const url = new URL(`${origin}${path}`);
      url.search = query.toString();
      if (url.origin !== origin) throw new RoutingEndpointError('ENDPOINT_HOST_NOT_ALLOWED');
      return url;
    },
  };
}
