import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createIdentityMobilePreviewHost,
  type IdentityMobilePreviewHost,
} from '../../../scripts/fixtures/identity-mobile-preview.mjs';

const servers: Server[] = [];
const hosts: IdentityMobilePreviewHost[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_LISTEN_INVALID');
  return { server, port: address.port };
}
async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections();
  });
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(servers.splice(0).map(close));
});
function get(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((done, reject) => {
    const client = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    client.once('error', reject);
    client.end();
  });
}
async function fixture(guard: (request: IncomingMessage, response: ServerResponse) => void) {
  const next = await listen(guard);
  const previewPaths: string[] = [];
  const preview = await listen((request, response) => {
    previewPaths.push(request.url ?? '');
    if (request.url?.startsWith('/map/basemap'))
      return response.end('copied raw disclosure must not escape');
    response.setHeader('content-security-policy', "connect-src 'self'");
    if (request.url?.startsWith('/bff/')) {
      response.setHeader('set-cookie', 'synthetic=one; HttpOnly');
      response.end(
        `${request.headers.cookie}:${request.headers.authorization}:${request.headers.origin}`,
      );
    } else response.end('ordinary Vite preview');
  });
  let previewClosed = 0;
  const host = await createIdentityMobilePreviewHost({
    mobilePort: 0,
    webPort: next.port,
    startPreview: async () => ({
      port: preview.port,
      close: async () => {
        previewClosed++;
        await close(preview.server);
      },
    }),
  });
  hosts.push(host);
  return { host, next, preview, previewPaths, previewClosed: () => previewClosed };
}
it('forwards guarded bytes and HEAD/cache metadata without public request or reply credentials', async () => {
  const seen: IncomingMessage[] = [];
  const f = await fixture((request, response) => {
    seen.push(request);
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      etag: 'synthetic',
      'set-cookie': 'private=secret',
      'content-length': '7',
    });
    response.end('{"v":1}');
  });
  const result = await get(f.host.port, '/map/basemap/current.json', {
    headers: {
      cookie: 'synthetic=secret',
      authorization: 'Bearer synthetic',
      origin: 'http://foreign.invalid',
      'x-forwarded-host': 'foreign.invalid',
      range: 'bytes=0-1',
      accept: 'application/json',
    },
  });
  expect(result.status).toBe(200);
  expect(result.body.toString()).toBe('{"v":1}');
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(seen[0]?.headers).toMatchObject({
    accept: 'application/json',
    'accept-encoding': 'identity',
  });
  for (const name of ['cookie', 'authorization', 'origin', 'x-forwarded-host', 'range'])
    expect(seen[0]?.headers[name]).toBeUndefined();
  const head = await get(f.host.port, '/map/basemap/current.json', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(head.body.length).toBe(0);
  expect(head.headers['content-length']).toBe('7');
  expect(seen[1]?.method).toBe('HEAD');
  expect(f.previewPaths).toEqual([]);
});
it('keeps guarded missing/script rejection and does not serve copied preview bytes', async () => {
  const f = await fixture((_request, response) =>
    response.writeHead(404, { 'cache-control': 'no-store' }).end(),
  );
  const result = await get(f.host.port, '/map/basemap/deployment/odbl-scripts/0.txt');
  expect(result.status).toBe(404);
  expect(result.body.length).toBe(0);
  expect(f.previewPaths).toEqual([]);
});
it.each([
  '/map/basemap%2Fodbl-scripts%2F0.txt',
  '/%6dap/basemap/current.json',
  '/map/basemap/%252e%252e/secret',
  '/map/basemap/../secret',
  '/map/basemap/a%5Cb.txt',
  '/map/basemap/current.json?origin=http://foreign.invalid',
  '//foreign.invalid/map/basemap/current.json',
  '/map/basemap/%ZZ',
  '/%2fmap/basemap/copied.txt',
  '/map//basemap/copied.txt',
])('rejects unsafe or ambiguous target %s before either upstream', async (path) => {
  let calls = 0;
  const f = await fixture((_request, response) => {
    calls++;
    response.end('forbidden');
  });
  expect((await get(f.host.port, path)).status).toBe(400);
  expect(calls).toBe(0);
  expect(f.previewPaths).toEqual([]);
});
it('permits a canonical encoded font segment without double decoding', async () => {
  let path = '';
  const f = await fixture((request, response) => {
    path = request.url ?? '';
    response.end('font');
  });
  expect(
    (await get(f.host.port, '/map/basemap/deployment/fonts/Noto%20Sans/0-255.pbf')).status,
  ).toBe(200);
  expect(path).toBe('/map/basemap/deployment/fonts/Noto%20Sans/0-255.pbf');
});
it.each(['POST', 'DELETE', 'OPTIONS'])(
  'rejects basemap %s without forwarding it',
  async (method) => {
    let calls = 0;
    const f = await fixture((_request, response) => {
      calls++;
      response.end();
    });
    const result = await get(f.host.port, '/map/basemap/current.json', { method });
    expect(result.status).toBe(405);
    expect(result.headers.allow).toBe('GET, HEAD');
    expect(calls).toBe(0);
  },
);
it('never follows a guarded redirect or emits its destination or cookie', async () => {
  const f = await fixture((_request, response) =>
    response
      .writeHead(302, { location: 'http://foreign.invalid/raw', 'set-cookie': 'private=secret' })
      .end(),
  );
  const result = await get(f.host.port, '/map/basemap/current.json');
  expect(result.status).toBe(502);
  expect(result.headers.location).toBeUndefined();
  expect(result.headers['set-cookie']).toBeUndefined();
  expect(result.body.length).toBe(0);
});
it('bounds declared public bytes and rejects foreign Host authority', async () => {
  let calls = 0;
  const f = await fixture((_request, response) => {
    calls++;
    response.writeHead(200, { 'content-length': String(16 * 1024 * 1024 + 1) }).end();
  });
  expect((await get(f.host.port, '/map/basemap/current.json')).status).toBe(502);
  expect(
    (await get(f.host.port, '/map/basemap/current.json', { headers: { host: 'foreign.invalid' } }))
      .status,
  ).toBe(421);
  expect(calls).toBe(1);
});
it('preserves ordinary preview and BFF credentials/CSP without sending them to Next', async () => {
  let nextCalls = 0;
  const f = await fixture((_request, response) => {
    nextCalls++;
    response.end();
  });
  expect((await get(f.host.port, '/assets/shell.js')).body.toString()).toBe(
    'ordinary Vite preview',
  );
  const result = await get(f.host.port, '/bff/v1/session', {
    headers: {
      cookie: 'synthetic=one',
      authorization: 'Bearer synthetic',
      origin: 'http://127.0.0.1:4200',
    },
  });
  expect(result.body.toString()).toBe('synthetic=one:Bearer synthetic:http://127.0.0.1:4200');
  expect(result.headers['content-security-policy']).toBe("connect-src 'self'");
  expect(result.headers['set-cookie']).toEqual(['synthetic=one; HttpOnly']);
  expect(nextCalls).toBe(0);
});
it('closes its public and owned preview server once and leaves Next alone', async () => {
  const f = await fixture((_request, response) => response.end('guard'));
  await get(f.host.port, '/map/basemap/current.json');
  await Promise.all([f.host.close(), f.host.close()]);
  expect(f.previewClosed()).toBe(1);
  expect(f.next.server.listening).toBe(true);
  expect(f.preview.server.listening).toBe(false);
  const result = await new Promise<string>((done) => {
    const socket = createConnection({ host: '127.0.0.1', port: f.host.port });
    socket.once('error', (error) => {
      socket.destroy();
      done('code' in error && typeof error.code === 'string' ? error.code : 'unknown');
    });
    socket.once('connect', () => {
      socket.destroy();
      done('listening');
    });
  });
  expect(result).toBe('ECONNREFUSED');
});
it('rejects external-origin options instead of accepting an extra raw static source', async () => {
  let started = false;
  await expect(
    createIdentityMobilePreviewHost(
      Object.assign(
        {
          mobilePort: 0,
          webPort: 3100,
          startPreview: async () => {
            started = true;
            return { port: 1, close: async () => {} };
          },
        },
        { basemapOrigin: 'http://foreign.invalid' },
      ),
    ),
  ).rejects.toThrow('IDENTITY_MOBILE_HOST_OPTIONS_INVALID');
  expect(started).toBe(false);
});

it('keeps compressed public bytes exact rather than decoding them before forwarding', async () => {
  const bytes = Buffer.from([0x1f, 0x8b, 0, 1, 2]);
  const f = await fixture((_request, response) =>
    response
      .writeHead(200, { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' })
      .end(bytes),
  );
  const result = await get(f.host.port, '/map/basemap/deployment/tiles/1/0/0.pbf');
  expect(result.body).toEqual(bytes);
  expect(result.headers['content-encoding']).toBe('gzip');
});
it('enforces the actual deadline on a stalled guarded response without leaking its connection', async () => {
  let reached: (() => void) | undefined;
  const waiting = new Promise<void>((done) => {
    reached = done;
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const f = await fixture(() => {
    reached?.();
  });
  const pending = get(f.host.port, '/map/basemap/current.json');
  await waiting;
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await pending).status).toBe(502);
  vi.useRealTimers();
  await f.host.close();
  expect(f.previewClosed()).toBe(1);
});
it('enforces the public byte bound when upstream omits Content-Length', async () => {
  const f = await fixture((_request, response) => response.end(Buffer.alloc(16 * 1024 * 1024 + 1)));
  const result = await get(f.host.port, '/map/basemap/deployment/large.pbf');
  expect(result.status).toBe(502);
  expect(result.body.length).toBe(0);
});
it('releases its owned preview if the requested public port is already occupied', async () => {
  const busy = await listen((_request, response) =>
    response.end('pre-existing synthetic listener'),
  );
  const next = await listen((_request, response) => response.end());
  const internal = await listen((_request, response) => response.end());
  let released = 0;
  await expect(
    createIdentityMobilePreviewHost({
      mobilePort: busy.port,
      webPort: next.port,
      startPreview: async () => ({
        port: internal.port,
        close: async () => {
          released++;
          await close(internal.server);
        },
      }),
    }),
  ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(released).toBe(1);
  expect(busy.server.listening).toBe(true);
  expect(next.server.listening).toBe(true);
});
it('does not impose the basemap deadline on an ordinary BFF reply', async () => {
  let arrived: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const reached = new Promise<void>((done) => {
    arrived = done;
  });
  const next = await listen((_request, response) => response.end());
  const internal = await listen((_request, response) => {
    finish = () => response.end('ordinary delayed BFF');
    arrived?.();
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const host = await createIdentityMobilePreviewHost({
    mobilePort: 0,
    webPort: next.port,
    startPreview: async () => ({ port: internal.port, close: () => close(internal.server) }),
  });
  hosts.push(host);
  const result = get(host.port, '/bff/v1/synthetic');
  await reached;
  await vi.advanceTimersByTimeAsync(15_000);
  finish?.();
  expect((await result).body.toString()).toBe('ordinary delayed BFF');
  vi.useRealTimers();
});
it('propagates client cancellation to its guarded request without stopping Next', async () => {
  let arrived: (() => void) | undefined;
  let stopped: (() => void) | undefined;
  const reached = new Promise<void>((done) => {
    arrived = done;
  });
  const cancelled = new Promise<void>((done) => {
    stopped = done;
  });
  const f = await fixture((_request, response) => {
    response.once('close', () => stopped?.());
    arrived?.();
  });
  const client = request({
    hostname: '127.0.0.1',
    port: f.host.port,
    path: '/map/basemap/current.json',
  });
  client.on('error', () => {});
  client.end();
  await reached;
  client.destroy();
  await cancelled;
  expect(f.next.server.listening).toBe(true);
  await f.host.close();
  expect(f.previewClosed()).toBe(1);
});
