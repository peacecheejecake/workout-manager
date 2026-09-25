import { describe, expect, it } from 'vitest';

import {
  RoutingEndpointError,
  createFetchRoutingTransport,
  createRoutingEngineEndpoint,
} from '../src/routing/index.js';

describe('routing engine endpoint', () => {
  it('accepts a loopback base URL and builds only known engine paths', () => {
    const endpoint = createRoutingEngineEndpoint('http://127.0.0.1:8991/');
    expect(endpoint.host).toBe('127.0.0.1');
    // No query string can be built: nothing a request carries travels in the URL (M2-01af).
    expect(endpoint.resolve('/route').toString()).toBe('http://127.0.0.1:8991/route');
    expect(() => endpoint.resolve('/nearest')).toThrow(RoutingEndpointError);
  });

  it.each([
    ['file:///etc/passwd', 'ENDPOINT_SCHEME_NOT_ALLOWED'],
    ['http://user:pass@127.0.0.1:8991/', 'ENDPOINT_CREDENTIALS_NOT_ALLOWED'],
    ['http://127.0.0.1:8991/?x=1', 'ENDPOINT_QUERY_NOT_ALLOWED'],
    ['http://127.0.0.1:8991/engine', 'ENDPOINT_PATH_NOT_ALLOWED'],
    ['http://routing.example.com/', 'ENDPOINT_HOST_NOT_ALLOWED'],
    ['not a url', 'ENDPOINT_MALFORMED'],
  ])('refuses %s', (value, code) => {
    expect(() => createRoutingEngineEndpoint(value)).toThrow(
      expect.objectContaining({ code }) as Error,
    );
  });

  it('only reaches a host the operator allowlisted', () => {
    expect(() =>
      createRoutingEngineEndpoint('http://routing.internal:8991/', {
        allowedHosts: ['routing.internal'],
      }),
    ).not.toThrow();
    expect(() =>
      createRoutingEngineEndpoint('http://other.internal:8991/', {
        allowedHosts: ['routing.internal'],
      }),
    ).toThrow(RoutingEndpointError);
  });

  it('cannot be steered by a path that tries to escape the allowed set', () => {
    const endpoint = createRoutingEngineEndpoint('http://127.0.0.1:8991/');
    for (const path of ['/route/../../evil', '//evil.example/route', 'http://evil.example/route'])
      expect(() => endpoint.resolve(path)).toThrow(RoutingEndpointError);
  });
});

describe('routing engine transport', () => {
  const endpoint = createRoutingEngineEndpoint('http://127.0.0.1:8991/');

  it('refuses to follow a redirect and omits credentials', async () => {
    const calls: RequestInit[] = [];
    const transport = createFetchRoutingTransport(endpoint, async (_url, init) => {
      calls.push(init);
      return new Response('{}', { status: 200 });
    });
    await transport.send({
      method: 'GET',
      path: '/info',
      signal: new AbortController().signal,
      maxBytes: 1024,
    });
    expect(calls[0]?.redirect).toBe('error');
    expect(calls[0]?.credentials).toBe('omit');
  });

  it('reports a redirected response rather than reading it', async () => {
    const redirected = new Response('{}', { status: 200 });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const transport = createFetchRoutingTransport(endpoint, async () => redirected);
    await expect(
      transport.send({
        method: 'GET',
        path: '/info',
        signal: new AbortController().signal,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_REDIRECTED' });
  });

  it('refuses a response larger than the cap instead of buffering it', async () => {
    const transport = createFetchRoutingTransport(
      endpoint,
      async () => new Response('x'.repeat(5000), { status: 200 }),
    );
    await expect(
      transport.send({
        method: 'POST',
        path: '/route',
        json: {},
        signal: new AbortController().signal,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_RESPONSE_TOO_LARGE' });
  });

  it('reports an aborted call as aborted, not as an unreachable engine', async () => {
    const controller = new AbortController();
    const transport = createFetchRoutingTransport(endpoint, async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      transport.send({
        method: 'POST',
        path: '/route',
        json: {},
        signal: controller.signal,
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'ENGINE_ABORTED' });
  });
});
