/**
 * M2-01d: measure the self-hosted basemap in a real browser and prove that the page
 * makes no external request.
 *
 *   node --import tsx scripts/probe-map-performance.mts --execute
 *
 * Opt-in only, refuses to run in CI. It serves the built basemap and a geo-kit harness
 * from a loopback server with a strict CSP, drives Chromium through Playwright, and
 * fails any request whose origin is not that server.
 *
 * The track is synthetic. Headless Chromium usually renders through a software GL
 * backend, so the recorded renderer string is part of the report and a GPU claim is
 * only as strong as that string.
 *
 * The report is written with JSON.stringify, whose short-array layout differs from
 * Prettier's; run `pnpm format` after a measurement before committing it.
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { copyFile, readFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem } from 'node:os';
import { chromium } from '@playwright/test';
import type { Browser, Page, Request } from '@playwright/test';
import { build } from 'vite';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const harnessSource = join(repositoryRoot, 'scripts/geo/harness');
const harnessOutput = join(workRoot, 'harness');
const reportPath = join(
  repositoryRoot,
  'docs/implementation/research/self-hosted-map-performance.json',
);

const requireFromSpike = createRequire(
  join(repositoryRoot, 'packages/experience/ui-spike/package.json'),
);

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pbf': 'application/x-protobuf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

export function parseArguments(args: string[]): { points: number; serve: boolean } | null {
  let points = 20_000;
  for (const argument of args) {
    if (argument === '--execute' || argument === '--serve') continue;
    const match = /^--points=(\d{3,6})$/.exec(argument);
    if (!match) return null;
    points = Number(match[1]);
  }
  return args.includes('--execute') ? { points, serve: args.includes('--serve') } : null;
}

/**
 * Deterministic synthetic long track inside the built region. It is a lap course with a
 * seeded jitter and one deliberate recording gap, so the renderer sees a realistic
 * vertex count without any personal GPS.
 */
export function syntheticTrack(points: number): {
  positions: [number, number][];
  breaks: number[];
  approximateLengthMeters: number;
} {
  let seed = 20260921;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const centre: [number, number] = [126.9779, 37.5663];
  const positions: [number, number][] = [];
  const laps = 8;
  for (let index = 0; index < points; index += 1) {
    const angle = (index / points) * laps * 2 * Math.PI;
    const radius = 0.012 + 0.004 * Math.sin(angle / 3);
    positions.push([
      centre[0] + radius * Math.cos(angle) * 1.26 + (random() - 0.5) * 0.00004,
      centre[1] + radius * Math.sin(angle) + (random() - 0.5) * 0.00004,
    ]);
  }
  let approximateLengthMeters = 0;
  for (let index = 1; index < positions.length; index += 1) {
    const [x1, y1] = positions[index - 1];
    const [x2, y2] = positions[index];
    approximateLengthMeters += Math.hypot(
      (x2 - x1) * 111_320 * Math.cos((y1 * Math.PI) / 180),
      (y2 - y1) * 110_540,
    );
  }
  return {
    positions,
    breaks: [Math.floor(points / 2)],
    approximateLengthMeters: Math.round(approximateLengthMeters),
  };
}

/**
 * The published build is whatever the pointer says, not whatever directory is newest.
 * Reading mtimes would happily measure a half-written or rolled-back build.
 */
async function publishedDeployment(): Promise<{ deploymentId: string; buildId: string }> {
  const pointerPath = join(workRoot, 'dist', 'current.json');
  let pointer: { deploymentId?: unknown; buildId?: unknown };
  try {
    pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as {
      deploymentId?: unknown;
      buildId?: unknown;
    };
  } catch {
    throw new Error('NO_PUBLISHED_BASEMAP: run node scripts/build-basemap.mjs --execute first');
  }
  if (typeof pointer.deploymentId !== 'string' || pointer.deploymentId === '')
    throw new Error('INVALID_BASEMAP_POINTER');
  const directory = join(workRoot, 'dist', pointer.deploymentId);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`MISSING_PUBLISHED_BUILD: ${pointer.deploymentId}`);
  return {
    deploymentId: pointer.deploymentId,
    buildId: typeof pointer.buildId === 'string' ? pointer.buildId : pointer.deploymentId,
  };
}

/** Resolve a request path inside one root, refusing traversal. */
function safeJoin(root: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath);
  const resolved = normalize(join(root, decoded));
  return resolved === root || resolved.startsWith(root + sep) ? resolved : null;
}

interface ServerOptions {
  /** Answer one fixed tile with a 302 to another origin, to test the asset transport. */
  readonly redirectOneTileExternally?: boolean;
  /**
   * Serve without the Content-Security-Policy header. Used only for the redirect control,
   * so that what stops the external request is the kit's transport and not the CSP: a
   * library cannot make its consumers send that header.
   */
  readonly omitCsp?: boolean;
}

function startServer(deploymentId: string, trackDocument: string, options: ServerOptions = {}) {
  const basemapRoot = join(workRoot, 'dist', deploymentId);
  const prefix = `/map/basemap/${deploymentId}/`;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const headers: Record<string, string> = {
        ...(options.omitCsp ? {} : { 'content-security-policy': contentSecurityPolicy }),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      };
      if (url.pathname === '/track.json') {
        // Stands in for a private object: same policy as any non-background response.
        response.writeHead(200, {
          ...headers,
          'content-type': contentTypes['.json'] ?? 'application/json',
          'cache-control': 'no-store',
        });
        response.end(trackDocument);
        return;
      }
      if (options.redirectOneTileExternally && url.pathname.includes('/tiles/')) {
        // A same-origin endpoint that answers 30x to another host. A renderer that
        // follows redirects would end up there; the transport must refuse instead.
        response.writeHead(302, { ...headers, location: 'https://tiles.example.com/hijacked.pbf' });
        response.end();
        return;
      }
      const isBasemap = url.pathname.startsWith(prefix);
      const root = isBasemap ? basemapRoot : harnessOutput;
      const relative = isBasemap ? url.pathname.slice(prefix.length) : url.pathname.slice(1);
      const target = safeJoin(root, relative === '' ? 'index.html' : relative);
      if (!target) {
        response.writeHead(400, headers);
        response.end();
        return;
      }
      try {
        const body = await readFile(target);
        const extension = extname(target);
        const responseHeaders: Record<string, string> = {
          ...headers,
          'content-type': contentTypes[extension] ?? 'application/octet-stream',
          // Public background assets: cacheable, no credentials, separate from any
          // private GPS object path.
          'cache-control': isBasemap ? 'public, max-age=604800, immutable' : 'no-store',
        };
        // Only tiles are gzip-compressed (MBTiles stores them that way). Glyph ranges are
        // plain protobuf and must not claim an encoding.
        if (isBasemap && extension === '.pbf' && url.pathname.includes('/tiles/'))
          responseHeaders['content-encoding'] = 'gzip';
        response.writeHead(200, responseHeaders);
        response.end(body);
      } catch {
        response.writeHead(404, headers);
        response.end();
      }
    })();
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({
        port,
        close: () => new Promise<void>((closed) => server.close(() => closed())),
      });
    });
  });
}

interface RequestRecord {
  url: string;
  external: boolean;
  status: number | null;
  failure?: string | null;
}

/** Exact origin comparison. `startsWith` would accept `http://127.0.0.1:4000.evil.test/`. */
function isSameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

async function measure(page: Page, origin: string, path = '/') {
  const requests: RequestRecord[] = [];
  // `page.route` only fires for the FIRST url of a redirect chain, so a followed 30x to
  // another host would never reach the route handler. The `request` event fires for every
  // hop, so external attempts are counted here.
  const observed: { url: string; redirectedFrom: string | null }[] = [];
  page.on('request', (request: Request) =>
    observed.push({
      url: request.url(),
      redirectedFrom: request.redirectedFrom()?.url() ?? null,
    }),
  );
  const statusByUrl = new Map<string, number>();
  const failedUrls = new Map<string, string>();
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      consoleMessages.push(`${message.type()}: ${message.text().slice(0, 300)}`);
  });
  page.on('pageerror', (error) =>
    consoleMessages.push(`pageerror: ${error.message.slice(0, 300)}`),
  );
  page.on('response', (response) => statusByUrl.set(response.url(), response.status()));
  // A request that never produced a response leaves no status; without this a failed
  // asset looks identical to one that was never needed.
  page.on('requestfailed', (request) =>
    failedUrls.set(request.url(), request.failure()?.errorText ?? 'failed'),
  );
  await page.route('**/*', async (route, request: Request) => {
    const external = !isSameOrigin(request.url(), origin);
    requests.push({
      url: external ? request.url() : new URL(request.url()).pathname,
      external,
      status: null,
    });
    if (external) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  const navigationStarted = Date.now();
  await page.goto(`${origin}${path}`, { waitUntil: 'load' });
  let timedOut = false;
  try {
    await page.waitForFunction(
      () =>
        window.__geoHarness?.status === 'ready' || window.__geoHarness?.status === 'unavailable',
      undefined,
      { timeout: 120_000 },
    );
  } catch {
    // Record the failure instead of losing every diagnostic the page collected.
    timedOut = true;
  }
  // The renderer only reports it is *initialised* here: the source is still empty, the
  // track has not been handed over and no viewport fit has happened.
  const rendererReadyNotificationMs = Date.now() - navigationStarted;

  // Now wait for the renderer to actually settle with the track drawn: an idle that
  // reports rendered path features, followed by a quiet period with no further idle.
  let renderSettled = false;
  try {
    await page.waitForFunction(
      () => {
        const idles = window.__geoHarness?.idles ?? [];
        const drawn = idles.filter((entry) => entry.renderedPathFeatures > 0);
        const last = idles.at(-1);
        return drawn.length > 0 && last !== undefined && performance.now() - last.at > 1000;
      },
      undefined,
      { timeout: 120_000, polling: 250 },
    );
    renderSettled = true;
  } catch {
    renderSettled = false;
  }

  const detail = await page.evaluate(() => {
    const bridge = window.__geoHarness;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const memory = (
      performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }
    ).memory;
    const idles = bridge?.idles ?? [];
    const firstDrawn = idles.find((entry) => entry.renderedPathFeatures > 0) ?? null;
    return {
      status: bridge?.status ?? 'missing',
      diagnostics: bridge?.diagnostics ?? [],
      cspViolations: bridge?.cspViolations ?? [],
      statusAt: bridge?.statusAt ?? {},
      trackPoints: bridge?.trackPoints ?? 0,
      idleCount: idles.length,
      firstDrawnIdleAtMs: firstDrawn ? Math.round(firstDrawn.at) : null,
      renderedPathFeatures: firstDrawn?.renderedPathFeatures ?? 0,
      lastIdleAtMs: idles.length > 0 ? Math.round(idles.at(-1)?.at ?? 0) : null,
      webglRenderer:
        gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unavailable',
      webglVendor: gl && info ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) : 'unavailable',
      usedJsHeapBytes: memory?.usedJSHeapSize ?? null,
      totalJsHeapBytes: memory?.totalJSHeapSize ?? null,
      deviceMemoryGb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
    };
  });

  // Scripted pan across the track, with frame intervals recorded in the page.
  await page.evaluate(() => window.__geoHarness?.startFrameRecording());
  const surface = page.locator('[data-status]').first();
  const box = detail.status === 'ready' ? await surface.boundingBox() : null;
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 30; step += 1) {
      await page.mouse.move(box.x + box.width / 2 - step * 8, box.y + box.height / 2 - step * 4);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  const frames: number[] = await page.evaluate(
    () => window.__geoHarness?.stopFrameRecording() ?? [],
  );
  const afterPan = await page.evaluate(() => {
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return memory?.usedJSHeapSize ?? null;
  });

  for (const record of requests) {
    if (record.external) continue;
    record.status = statusByUrl.get(`${origin}${record.url}`) ?? null;
    record.failure = failedUrls.get(`${origin}${record.url}`) ?? null;
  }

  // Re-read page state AFTER the pan: an error, a CSP violation or a lost context during
  // the interaction must still reach the verdict.
  const afterInteraction = await page.evaluate(() => {
    const bridge = window.__geoHarness;
    return {
      status: bridge?.status ?? 'missing',
      diagnostics: bridge?.diagnostics ?? [],
      cspViolations: bridge?.cspViolations ?? [],
      idleCount: (bridge?.idles ?? []).length,
    };
  });

  const sorted = [...frames].sort((a, b) => a - b);
  const percentile = (value: number) => {
    if (sorted.length === 0) return null;
    const at = sorted.at(Math.min(sorted.length - 1, Math.floor(sorted.length * value)));
    return at === undefined ? null : Math.round(at * 100) / 100;
  };

  const externalObserved = observed.filter((entry) => !isSameOrigin(entry.url, origin));
  return {
    rendererReadyNotificationMs,
    afterInteraction,
    externalObserved,
    trackAndBasemapRenderedMs: detail.firstDrawnIdleAtMs,
    renderSettled,
    timedOut,
    consoleMessages: consoleMessages.slice(0, 20),
    detail,
    panFrames: {
      count: frames.length,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      maxMs: sorted.length ? Math.round((sorted.at(-1) ?? 0) * 100) / 100 : null,
    },
    usedJsHeapAfterPanBytes: afterPan,
    requests,
  };
}

interface Requirement {
  readonly name: string;
  readonly satisfied: boolean;
  readonly observed: string;
}

/**
 * The zero-external-request claim is only worth something if the page actually did the
 * work. Without these checks a missing worker file produces zero tile requests and zero
 * external requests, which would otherwise look exactly like a pass.
 */
function evaluateRequirements(measurement: Awaited<ReturnType<typeof measure>>): Requirement[] {
  const sameOrigin = measurement.requests.filter((entry) => !entry.external);
  // Route interception plus every observed hop: a followed redirect appears only in the
  // second list.
  const external = [
    ...measurement.requests.filter((entry) => entry.external).map((entry) => entry.url),
    ...measurement.externalObserved.map((entry) => entry.url),
  ];
  const succeeded = (predicate: (path: string) => boolean) =>
    sameOrigin.filter((entry) => predicate(entry.url) && entry.status === 200);
  const tiles = succeeded((path) => path.includes('/tiles/'));
  const glyphs = succeeded((path) => path.includes('/glyphs/'));
  const sprites = succeeded((path) => path.includes('/sprite'));
  const styles = succeeded((path) => path.endsWith('/style.json'));
  // A request with no status never completed; that is a failure, not an absence.
  const unsuccessful = sameOrigin.filter(
    (entry) => entry.status === null || entry.status >= 400 || entry.failure,
  );
  const after = measurement.afterInteraction;
  return [
    {
      name: 'no external request attempted (route + every redirect hop)',
      satisfied: external.length === 0,
      observed: `${external.length} attempts ${[...new Set(external)].slice(0, 3).join(', ')}`,
    },
    {
      name: 'no CSP violation (checked after the interaction)',
      satisfied: after.cspViolations.length === 0,
      observed: after.cspViolations.slice(0, 3).join(' | ') || 'none',
    },
    {
      name: 'harness ready and still ready after the interaction',
      satisfied:
        measurement.detail.status === 'ready' && after.status === 'ready' && !measurement.timedOut,
      observed: `${measurement.detail.status} -> ${after.status}${
        measurement.timedOut ? ' (timeout)' : ''
      }`,
    },
    {
      name: 'renderer reported no error, including during the interaction',
      satisfied: after.diagnostics.length === 0,
      observed: after.diagnostics.slice(0, 2).join(' | ') || 'none',
    },
    {
      name: 'basemap tiles fetched successfully',
      satisfied: tiles.length > 0,
      observed: `${tiles.length} tiles with HTTP 200`,
    },
    {
      name: 'style, sprite and glyph fetched successfully',
      satisfied: styles.length > 0 && sprites.length >= 2 && glyphs.length > 0,
      observed: `style ${styles.length}, sprite ${sprites.length}, glyph ${glyphs.length}`,
    },
    {
      name: 'every same-origin request completed with a success status',
      satisfied: unsuccessful.length === 0,
      observed:
        unsuccessful
          .slice(0, 6)
          .map((entry) => `${entry.url}:${entry.failure ?? entry.status ?? 'no-response'}`)
          .join(', ') || 'none',
    },
    {
      name: 'track rendered and renderer settled',
      satisfied: measurement.renderSettled && measurement.detail.renderedPathFeatures > 0,
      observed: `${measurement.detail.renderedPathFeatures} path features, settled=${measurement.renderSettled}`,
    },
  ];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-map-performance.mts --execute [--points=N] [--serve]. Serves the built basemap on loopback with a strict CSP and measures it in Chromium; --serve only keeps the loopback server up for a manual browser check. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Browser map measurement is disabled in CI');

  const { deploymentId, buildId } = await publishedDeployment();
  const track = syntheticTrack(options.points);
  // The kit renders attribution as text, so the plain-text form is used here; the HTML
  // form stays in the style for MapLibre's own attribution control.
  const tileJson = JSON.parse(
    await readFile(join(workRoot, 'dist', deploymentId, 'tiles.json'), 'utf8'),
  ) as { attributionText?: string };
  const attribution = tileJson.attributionText ?? '';
  const trackDocument = JSON.stringify({ deploymentId, attribution, ...track });

  await build({
    root: harnessSource,
    logLevel: 'error',
    build: { outDir: harnessOutput, emptyOutDir: true, target: 'es2022' },
    resolve: {
      alias: [
        // react-dom is not a geo-kit dependency; the harness borrows the copy already
        // installed for the UI spike rather than adding one to the kit.
        { find: /^react-dom\/client$/, replacement: requireFromSpike.resolve('react-dom/client') },
        { find: /^react$/, replacement: requireFromSpike.resolve('react') },
        {
          find: /^react\/jsx-runtime$/,
          replacement: requireFromSpike.resolve('react/jsx-runtime'),
        },
        {
          find: /^react\/jsx-dev-runtime$/,
          replacement: requireFromSpike.resolve('react/jsx-dev-runtime'),
        },
      ],
    },
  });

  // MapLibre's worker and its shared ESM sibling are not emitted by the bundler; they are
  // copied next to the bundle and served from the same origin.
  const maplibreDist = join(dirname(requireFromSpike.resolve('maplibre-gl/package.json')), 'dist');
  for (const file of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
    await copyFile(join(maplibreDist, file), join(harnessOutput, 'assets', file));
  }

  const server = await startServer(deploymentId, trackDocument);
  const origin = `http://127.0.0.1:${server.port}`;
  if (options.serve) {
    // Manual browser check: keep the same server and CSP up, run no automation.
    console.log(JSON.stringify({ serving: origin, deploymentId, buildId, points: options.points }));
    await new Promise(() => {});
    return;
  }
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const measurement = await measure(page, origin);
    await context.close();

    const external = [
      ...measurement.requests.filter((entry) => entry.external).map((entry) => entry.url),
      ...measurement.externalObserved.map((entry) => entry.url),
    ];
    const requirements = evaluateRequirements(measurement);

    // Second phase: a same-origin tile endpoint that answers 302 to another host. The
    // renderer follows redirects by default, so this is what the request hook alone
    // could not stop. Only the transport's `redirect: 'error'` prevents it.
    //
    // Third phase repeats it with a deliberately permissive transport (a fetch that
    // follows redirects). That run MUST show the external request: without it, a zero in
    // the second phase would prove nothing.
    const trap = await startServer(deploymentId, trackDocument, {
      redirectOneTileExternally: true,
      // No CSP here on purpose: the control must show the transport doing the work.
      omitCsp: true,
    });
    const trapOrigin = `http://127.0.0.1:${trap.port}`;
    let redirectControl: {
      externalAttempts: number;
      externalUrls: string[];
      tileFailures: number;
      permissiveExternalAttempts: number;
      permissiveExternalUrls: string[];
    };
    try {
      const runTrap = async (path: string) => {
        const trapContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const trapPage = await trapContext.newPage();
        const trapMeasurement = await measure(trapPage, trapOrigin, path);
        await trapContext.close();
        return trapMeasurement;
      };
      const strict = await runTrap('/');
      const permissive = await runTrap('/?permissive=1');
      const strictExternal = [
        ...strict.requests.filter((entry) => entry.external).map((entry) => entry.url),
        ...strict.externalObserved.map((entry) => entry.url),
      ];
      const permissiveExternal = [
        ...permissive.requests.filter((entry) => entry.external).map((entry) => entry.url),
        ...permissive.externalObserved.map((entry) => entry.url),
      ];
      redirectControl = {
        externalAttempts: strictExternal.length,
        externalUrls: [...new Set(strictExternal)].slice(0, 10),
        tileFailures: strict.requests.filter(
          (entry) => !entry.external && entry.url.includes('/tiles/') && entry.status !== 200,
        ).length,
        permissiveExternalAttempts: permissiveExternal.length,
        permissiveExternalUrls: [...new Set(permissiveExternal)].slice(0, 10),
      };
    } finally {
      await trap.close();
    }
    requirements.push(
      {
        name: 'redirect control (no CSP): no external request when a tile endpoint answers 302 elsewhere',
        satisfied: redirectControl.externalAttempts === 0,
        observed: `${redirectControl.externalAttempts} attempts ${redirectControl.externalUrls.join(', ')}`,
      },
      {
        name: 'redirect control: the redirected tile is treated as a failure',
        satisfied: redirectControl.tileFailures > 0,
        observed: `${redirectControl.tileFailures} tile requests did not return 200`,
      },
      {
        name: 'redirect control is not vacuous: a permissive transport is detected',
        satisfied: redirectControl.permissiveExternalAttempts > 0,
        observed: `${redirectControl.permissiveExternalAttempts} attempts ${redirectControl.permissiveExternalUrls.join(', ')}`,
      },
    );

    const passed = requirements.every((requirement) => requirement.satisfied);
    const report = {
      schemaVersion: 1,
      executedAt: new Date().toISOString(),
      scope:
        'M2-01d self-hosted basemap browser measurement on a developer machine. Not a production performance budget and not a physical-GPU result.',
      deploymentId,
      buildId,
      passed,
      requirements,
      harness: 'scripts/geo/harness (geo-kit MapView, real MapLibre 6.9.1)',
      contentSecurityPolicy,
      track: {
        kind: 'synthetic',
        points: options.points,
        breaks: track.breaks.length,
        approximateLengthMeters: track.approximateLengthMeters,
        digest: createHash('sha256').update(JSON.stringify(track.positions)).digest('hex'),
      },
      results: {
        // Time from navigation to the renderer reporting it is initialised. The path
        // source is still EMPTY at this point: no track, no viewport fit.
        rendererReadyNotificationMs: measurement.rendererReadyNotificationMs,
        // Time from navigation to the first renderer idle that actually had our path
        // features on screen, i.e. track + background tiles drawn.
        trackAndBasemapRenderedMs: measurement.trackAndBasemapRenderedMs,
        renderedPathFeatures: measurement.detail.renderedPathFeatures,
        renderSettled: measurement.renderSettled,
        idleCount: measurement.detail.idleCount,
        cspViolations: measurement.detail.cspViolations,
        harnessStatus: measurement.detail.status,
        timedOut: measurement.timedOut,
        rendererDiagnostics: measurement.detail.diagnostics,
        consoleMessages: measurement.consoleMessages,
        statusAtMs: measurement.detail.statusAt,
        usedJsHeapBytes: measurement.detail.usedJsHeapBytes,
        totalJsHeapBytes: measurement.detail.totalJsHeapBytes,
        usedJsHeapAfterPanBytes: measurement.usedJsHeapAfterPanBytes,
        panFrames: measurement.panFrames,
        webglRenderer: measurement.detail.webglRenderer,
        webglVendor: measurement.detail.webglVendor,
      },
      redirectControl: { ...redirectControl, cspSent: false },
      externalRequests: {
        attempted: external.length,
        observedUrls: [...new Set(external)].slice(0, 20),
      },
      sameOriginRequests: {
        total: measurement.requests.filter((entry) => !entry.external).length,
        byKind: summariseRequests(measurement.requests.filter((entry) => !entry.external)),
        distinctPaths: [
          ...new Set(
            measurement.requests
              .filter((entry) => !entry.external)
              .map((entry) =>
                entry.url.replace(/\/tiles\/\d+\/\d+\/\d+\.pbf$/, '/tiles/{z}/{x}/{y}.pbf'),
              ),
          ),
        ].slice(0, 30),
      },
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpus: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      interpretation:
        'These numbers only count when `passed` is true: every requirement above had to hold, including successful tile/glyph/sprite responses and an idle with the track actually drawn. GPU behaviour is only as strong as the recorded WebGL renderer string, and no product performance budget is approved here.',
    };

    const previousRuns: unknown[] = [];
    try {
      const previous = JSON.parse(await readFile(reportPath, 'utf8'));
      const { previousRuns: history = [], ...lastRun } = previous;
      if (!Array.isArray(history) || typeof lastRun.executedAt !== 'string')
        throw new Error('INVALID_PREVIOUS_REPORT');
      previousRuns.push(...history, lastRun);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(reportPath), { recursive: true });
    const temporary = `${reportPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...report, previousRuns }, null, 2)}\n`, {
      flag: 'wx',
    });
    await rename(temporary, reportPath);
    console.log(
      JSON.stringify({
        passed,
        deploymentId,
        rendererReadyNotificationMs: measurement.rendererReadyNotificationMs,
        trackAndBasemapRenderedMs: measurement.trackAndBasemapRenderedMs,
        externalRequests: external.length,
        sameOriginRequests: measurement.requests.filter((entry) => !entry.external).length,
        webglRenderer: measurement.detail.webglRenderer,
        failed: requirements.filter((requirement) => !requirement.satisfied),
      }),
    );
    if (!passed) {
      // A report that exists is not a pass. Fail loudly so no caller can read a vacuous
      // run as evidence.
      process.exitCode = 1;
      throw new Error(
        `MEASUREMENT_FAILED: ${requirements
          .filter((requirement) => !requirement.satisfied)
          .map((requirement) => `${requirement.name} (${requirement.observed})`)
          .join('; ')}`,
      );
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}

function summariseRequests(requests: RequestRecord[]) {
  const counts: Record<string, number> = {};
  for (const entry of requests) {
    const kind = entry.url.includes('/tiles/')
      ? 'tile'
      : entry.url.includes('/glyphs/')
        ? 'glyph'
        : entry.url.includes('/sprite')
          ? 'sprite'
          : entry.url.includes('style.json')
            ? 'style'
            : entry.url === '/track.json'
              ? 'track'
              : 'harness';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
