/** Identity-only frontend host. Vite preview keeps its public basemap deny policy. */
import { rmSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type IncomingHttpHeaders, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityMobilePort, identityWebOrigin, identityWebPort } from './identity-ports.js';
import {
  parseIdentityMobileBuildProfile,
  type IdentityShellRuntimeProfile,
} from './identity-shell-runtime-profile.js';

export interface OwnedIdentityPreview {
  port: number;
  close(): Promise<void>;
}
export interface IdentityMobilePreviewOptions {
  mobilePort: number;
  webPort: number;
  startPreview(): Promise<OwnedIdentityPreview>;
}
export interface IdentityMobilePreviewHost {
  port: number;
  close(): Promise<void>;
}
const upstreamDeadlineMs = 10_000;
const basemapMaxBytes = 16 * 1024 * 1024;
const publicResponseHeaders = [
  'content-type',
  'content-length',
  'content-encoding',
  'cache-control',
  'etag',
  'last-modified',
  'x-content-type-options',
  'referrer-policy',
] as const;
const publicRequestHeaders = ['accept', 'if-none-match', 'if-modified-since'] as const;
const hopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
function validPort(value: number, ephemeral = false): boolean {
  return (
    Number.isSafeInteger(value) && ((ephemeral && value === 0) || (value > 0 && value <= 65535))
  );
}
function target(raw: string | undefined): { path: string; basemap: boolean } | null {
  if (
    !raw ||
    raw.length > 8192 ||
    !raw.startsWith('/') ||
    raw.includes('//') ||
    /[\\#]/.test(raw) ||
    [...raw].some((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n <= 0x20 || n === 0x7f;
    })
  )
    return null;
  const rawPath = raw.split('?')[0];
  if (!rawPath) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
    if (rawPath.split('/').some((segment) => decodeURIComponent(segment).includes('/')))
      return null;
  } catch {
    return null;
  }
  if (
    /[\\%]/.test(decoded) ||
    [...decoded].some((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n < 0x20 || (n >= 0x7f && n <= 0x9f);
    })
  )
    return null;
  const segments = decoded.split('/').slice(1);
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  const basemap = decoded === '/map/basemap' || decoded.startsWith('/map/basemap/');
  if (basemap) {
    if (raw.includes('?') || segments.some((segment) => segment === '')) return null;
    // Encoded separators/prefixes and second decoding cannot escape into another route.
    if ('/' + segments.map(encodeURIComponent).join('/') !== rawPath) return null;
  }
  return { path: raw, basemap };
}
function forwardedHeaders(headers: IncomingHttpHeaders, basemap: boolean): IncomingHttpHeaders {
  if (basemap) {
    const result: IncomingHttpHeaders = {};
    for (const name of publicRequestHeaders)
      if (headers[name] !== undefined) result[name] = headers[name];
    // No cookies, authorization, range, forwarded origin/host or caller-selected upstream.
    result['accept-encoding'] = 'identity';
    return result;
  }
  const named =
    typeof headers.connection === 'string'
      ? headers.connection
          .toLowerCase()
          .split(',')
          .map((name) => name.trim())
      : [];
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !hopHeaders.has(name) && !named.includes(name)),
  );
}
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((done, reject) => {
    server.close((error) => (error ? reject(error) : done()));
    server.closeAllConnections();
  });
}

/** Ports are trusted fixture inputs; no external origin, static root or raw-dist option exists. */
export async function createIdentityMobilePreviewHost(
  options: IdentityMobilePreviewOptions,
): Promise<IdentityMobilePreviewHost> {
  if (
    Object.keys(options).sort().join(',') !== 'mobilePort,startPreview,webPort' ||
    !validPort(options.mobilePort, true) ||
    !validPort(options.webPort) ||
    typeof options.startPreview !== 'function'
  )
    throw new Error('IDENTITY_MOBILE_HOST_OPTIONS_INVALID');
  const preview = await options.startPreview();
  if (
    !validPort(preview.port) ||
    preview.port === options.webPort ||
    (options.mobilePort !== 0 && preview.port === options.mobilePort)
  ) {
    await preview.close();
    throw new Error('IDENTITY_MOBILE_PREVIEW_PORT_INVALID');
  }
  let closing = false;
  const active = new Set<ReturnType<typeof request>>();
  const server = createServer((incoming, outgoing) => {
    const address = server.address();
    if (closing || !address || typeof address === 'string') {
      outgoing.writeHead(503).end();
      return;
    }
    if (incoming.headers.host !== `127.0.0.1:${address.port}`) {
      outgoing.writeHead(421, { 'cache-control': 'no-store' }).end();
      return;
    }
    const selected = target(incoming.url);
    if (!selected) {
      outgoing.writeHead(400, { 'cache-control': 'no-store' }).end();
      return;
    }
    if (selected.basemap && !['GET', 'HEAD'].includes(incoming.method ?? '')) {
      outgoing.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
      return;
    }
    if (
      selected.basemap &&
      (incoming.headers['transfer-encoding'] !== undefined ||
        (incoming.headers['content-length'] !== undefined &&
          incoming.headers['content-length'] !== '0'))
    ) {
      outgoing.writeHead(400, { 'cache-control': 'no-store' }).end();
      return;
    }
    const upstream = request({
      hostname: '127.0.0.1',
      port: selected.basemap ? options.webPort : preview.port,
      path: selected.path,
      method: incoming.method,
      headers: forwardedHeaders(incoming.headers, selected.basemap),
    });
    active.add(upstream);
    const timer = selected.basemap
      ? setTimeout(
          () => upstream.destroy(new Error('IDENTITY_MOBILE_UPSTREAM_DEADLINE')),
          upstreamDeadlineMs,
        )
      : null;
    const fail = () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'cache-control': 'no-store' }).end();
      else outgoing.destroy();
    };
    upstream.once('error', fail);
    upstream.once('close', () => {
      if (timer !== null) clearTimeout(timer);
      active.delete(upstream);
    });
    incoming.once('aborted', () => upstream.destroy());
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    upstream.once('response', (response) => {
      const status = response.statusCode ?? 502;
      if (!selected.basemap) {
        const named =
          typeof response.headers.connection === 'string'
            ? response.headers.connection
                .toLowerCase()
                .split(',')
                .map((name) => name.trim())
            : [];
        outgoing.writeHead(
          status,
          Object.fromEntries(
            Object.entries(response.headers).filter(
              ([name]) => !hopHeaders.has(name) && !named.includes(name),
            ),
          ),
        );
        response.once('error', fail);
        response.pipe(outgoing);
        return;
      }
      // A fixed Next guarded route is the only source. Do not follow Location or expose Set-Cookie.
      if (
        (status >= 300 && status < 400 && status !== 304) ||
        (status !== 200 && status !== 304 && status !== 404)
      ) {
        response.destroy();
        fail();
        return;
      }
      const declared = response.headers['content-length'];
      if (
        declared !== undefined &&
        (!/^[0-9]+$/.test(declared) || Number(declared) > basemapMaxBytes)
      ) {
        response.destroy();
        fail();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > basemapMaxBytes) {
          response.destroy();
          upstream.destroy();
          fail();
        } else chunks.push(chunk);
      });
      response.once('error', fail);
      response.once('end', () => {
        if (outgoing.destroyed || outgoing.writableEnded) return;
        const headers: Record<string, string | string[] | undefined> = {};
        for (const name of publicResponseHeaders)
          if (response.headers[name] !== undefined) headers[name] = response.headers[name];
        outgoing
          .writeHead(status, headers)
          .end(incoming.method === 'HEAD' ? undefined : Buffer.concat(chunks));
      });
    });
    incoming.pipe(upstream);
  });
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(options.mobilePort, '127.0.0.1', done);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('IDENTITY_MOBILE_LISTEN_INVALID');
    let closePromise: Promise<void> | null = null;
    return {
      port: address.port,
      close: () =>
        (closePromise ??= (async () => {
          closing = true;
          for (const request of active) request.destroy();
          try {
            await closeServer(server);
          } finally {
            await preview.close();
          }
        })()),
    };
  } catch (error) {
    await preview.close();
    throw error;
  }
}

async function nextReady(): Promise<void> {
  const response = await fetch(`${identityWebOrigin}/map/basemap/current.json`, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(upstreamDeadlineMs),
  });
  await response.body?.cancel();
  if (![200, 404].includes(response.status))
    throw new Error('IDENTITY_NEXT_GUARDED_ROUTE_NOT_READY');
}
/**
 * VITE_WORKOUT_RUNTIME_PROFILE is baked at build time, so a shared dist cannot be trusted to
 * match this suite's API. Build a run-owned dist with exactly the harness-selected profile
 * (profile27 or absent) and remove it on close. Generated public assets (map worker, notices)
 * are the same prerequisite the shared `pnpm build` already provides.
 */
export async function buildIdentityMobileDist(
  directory: string,
  profile: IdentityShellRuntimeProfile,
  build: (options: Record<string, unknown>) => Promise<unknown>,
): Promise<string> {
  for (const asset of [
    'public/dist/maplibre/maplibre-gl-worker.mjs',
    'public/dist/notices/THIRD_PARTY_NOTICES.txt',
  ])
    await access(join(directory, asset)).catch(() => {
      throw new Error('IDENTITY_MOBILE_BUILD_PREREQUISITE_MISSING');
    });
  const outDir = await mkdtemp(join(tmpdir(), 'wm-identity-mobile-'));
  const previous = process.env['VITE_WORKOUT_RUNTIME_PROFILE'];
  try {
    if (profile === undefined) delete process.env['VITE_WORKOUT_RUNTIME_PROFILE'];
    else process.env['VITE_WORKOUT_RUNTIME_PROFILE'] = profile;
    await build({
      root: directory,
      configFile: resolve(directory, 'vite.config.ts'),
      configLoader: 'native',
      mode: 'production',
      logLevel: 'error',
      build: { outDir, emptyOutDir: true },
    });
    return outDir;
  } catch (error) {
    await rm(outDir, { recursive: true, force: true });
    throw error;
  } finally {
    if (previous === undefined) delete process.env['VITE_WORKOUT_RUNTIME_PROFILE'];
    else process.env['VITE_WORKOUT_RUNTIME_PROFILE'] = previous;
  }
}
export async function runIdentityMobilePreview(): Promise<void> {
  if (
    process.env['BASEMAP_ORIGIN'] !== undefined &&
    process.env['BASEMAP_ORIGIN'] !== identityWebOrigin
  )
    throw new Error('IDENTITY_MOBILE_RAW_ORIGIN_FORBIDDEN');
  const profile = parseIdentityMobileBuildProfile(process.env['VITE_WORKOUT_RUNTIME_PROFILE']);
  await nextReady();
  const { build, preview } = await import('vite');
  const directory = resolve(import.meta.dirname, '../../apps/mobile-web');
  const host = await createIdentityMobilePreviewHost({
    mobilePort: identityMobilePort,
    webPort: identityWebPort,
    startPreview: async () => {
      const outDir = await buildIdentityMobileDist(directory, profile, build);
      // Vite's preview handles SIGTERM itself and calls process.exit() after closing, which
      // would cut the async removal short; the exit hook removes the dist synchronously.
      const removeOnExit = () => rmSync(outDir, { recursive: true, force: true });
      process.once('exit', removeOnExit);
      const removeDist = () =>
        rm(outDir, { recursive: true, force: true }).finally(() =>
          process.off('exit', removeOnExit),
        );
      try {
        const owned = await preview({
          root: directory,
          configFile: resolve(directory, 'vite.config.ts'),
          configLoader: 'native',
          build: { outDir },
          preview: { host: '127.0.0.1', port: 0, strictPort: false },
        });
        if (!(owned.httpServer instanceof Server)) {
          owned.httpServer.close();
          throw new Error('IDENTITY_MOBILE_HTTP_PREVIEW_REQUIRED');
        }
        const ownedServer = owned.httpServer;
        const address = ownedServer.address();
        if (!address || typeof address === 'string') {
          await closeServer(ownedServer);
          throw new Error('IDENTITY_MOBILE_PREVIEW_LISTEN_INVALID');
        }
        return {
          port: address.port,
          close: () => closeServer(ownedServer).finally(removeDist),
        };
      } catch (error) {
        await removeDist();
        throw error;
      }
    },
  });
  const stop = () => {
    void host.close().then(
      () => {
        process.exitCode = 0;
      },
      () => {
        process.exitCode = 1;
      },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(
    JSON.stringify({
      state: 'identity_mobile_preview_ready',
      port: host.port,
      basemapSource: 'identity_next_guarded_route',
      runtimeProfile: profile ?? 'unset',
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runIdentityMobilePreview();
  } catch {
    console.error('IDENTITY_MOBILE_PREVIEW_START_FAILED');
    process.exitCode = 1;
  }
}
