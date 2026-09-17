import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = 'https://routing.openstreetmap.de';
const endpoint = `${origin}/routed-foot/route/v1/foot/`;
const cases = [
  {
    id: 'KR-SYN-01',
    revision: 1,
    context: 'Synthetic Seoul city probe; exact walkway not independently reviewed',
    coordinates: [
      [126.978, 37.566],
      [126.982, 37.566],
    ],
  },
  {
    id: 'KR-SYN-02',
    revision: 1,
    context:
      'Synthetic Han River crossing probe; bridge/access suitability not independently reviewed',
    coordinates: [
      [126.93, 37.525],
      [126.932, 37.537],
    ],
  },
  {
    id: 'NEG-SYN-03',
    negativeControl: true,
    revision: 1,
    context: 'Synthetic nonzero ocean coordinates near Null Island; no long-distance snap allowed',
    coordinates: [
      [0.01, 0.01],
      [0.011, 0.011],
    ],
  },
];
const provenance = {
  operator: 'FOSSGIS e.V.',
  profile: 'foot',
  engine: 'OSRM',
  engineVersion: null,
  graphDate: null,
  endpointConfiguration:
    'https://raw.githubusercontent.com/fossgis-routing-server/osrm-frontend/master/src/leaflet_options.js',
  operatorPolicySummary: 'https://routing.openstreetmap.de/about.html',
  fullPolicy: 'https://fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/',
  policyAccess:
    'Operator summary read directly; full policy indexed text read, direct page blocked by Anubis during M0-06a research.',
  attribution: 'Data © OpenStreetMap contributors (ODbL). Routing service operated by FOSSGIS e.V.',
  dataLicense: 'https://www.openstreetmap.org/copyright',
  reportMapError: 'https://www.openstreetmap.org/fixthemap',
};
const maxBytes = 512 * 1024;
const userAgent =
  'WorkoutManager-RoutingResearch/0.1 (manual fixed-public-coordinate feasibility probe; no personal GPS)';
const execFileAsync = promisify(execFile);

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--execute') return 'node';
  if (args.length === 2 && args[0] === '--execute' && args[1] === '--transport=curl') return 'curl';
  return null;
}

// execFile never invokes a shell. --disable is first so local curlrc cannot add
// redirects, retries, credentials, or extra requests to this fixed probe.
export async function curlRequest(url, execute = execFileAsync) {
  if (
    url.origin !== origin ||
    !url.pathname.startsWith('/routed-foot/route/v1/foot/') ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('INVALID_ENDPOINT');
  let output;
  try {
    output = await execute(
      'curl',
      [
        '--disable',
        '--silent',
        '--show-error',
        '--proto',
        '=https',
        '--max-redirs',
        '0',
        '--max-time',
        '15',
        '--max-filesize',
        String(maxBytes),
        '--user-agent',
        userAgent,
        '--header',
        'Accept: application/json',
        '--write-out',
        '\n%{http_code}',
        '--url',
        url.href,
      ],
      { timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: maxBytes + 4, encoding: 'utf8' },
    );
  } catch (error) {
    // Never retain stderr or the command-bearing error.message.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    const failure =
      code === 63 || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        ? 'RESPONSE_TOO_LARGE'
        : code === 28 || (error && typeof error === 'object' && 'killed' in error && error.killed)
          ? 'TIMEOUT'
          : 'CURL_REQUEST_FAILED';
    const safeCode = Number.isInteger(code)
      ? `CURL_EXIT_${code}`
      : typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
        ? code
        : undefined;
    throw new Error(failure, { cause: { code: safeCode } });
  }
  const match = /\n([1-5][0-9]{2})$/.exec(output.stdout);
  if (!match) throw new Error('INVALID_HTTP_STATUS');
  const body = output.stdout.slice(0, -4);
  const status = Number(match[1]);
  return withHttpStatus(status, async () => {
    if (Buffer.byteLength(body) > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    if (status >= 300 && status < 400) throw new Error('REDIRECT_REJECTED');
    return JSON.parse(body);
  });
}

async function nodeRequest(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  return withHttpStatus(response.status, () => readBoundedJson(response));
}

// Keep observed HTTP status on parse/body failures so 403/429 stop the run even
// when a provider returns HTML instead of JSON.
async function withHttpStatus(status, readPayload) {
  try {
    return { status, payload: await readPayload() };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'INVALID_RESPONSE', {
      cause: { httpStatus: status },
    });
  }
}

function validPosition(value) {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}
async function readBoundedJson(response) {
  if (!response.body) throw new Error('EMPTY_RESPONSE');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function probe(testCase, request = nodeRequest) {
  const url = new URL(
    `${endpoint}${testCase.coordinates.map((coordinate) => coordinate.join(',')).join(';')}`,
  );
  url.search = new URLSearchParams({
    radiuses: '100;100',
    overview: 'full',
    geometries: 'geojson',
    alternatives: 'false',
    steps: 'false',
  }).toString();
  const result = {
    caseId: testCase.id,
    caseRevision: testCase.revision ?? 1,
    requestedOptions: Object.fromEntries(url.searchParams),
    requestHash: createHash('sha256').update(`GET\n${url.href}`).digest('hex'),
    diagnostic: 'request_failure',
    expectedVerdict: testCase.negativeControl === true ? 'inconclusive' : null,
    context: testCase.context,
    requestedCoordinates: testCase.coordinates,
    requestedRadiusMeters: 100,
    requestedAt: new Date().toISOString(),
    endpointOrigin: origin,
    profile: 'foot',
    httpStatus: null,
    providerCode: null,
    distanceMeters: null,
    snappedWaypoints: [],
    geometryHash: null,
    geometryCoordinateCount: null,
    outcome: 'request_failed',
    coverageReview: 'not_reviewed',
    error: null,
    errorName: null,
    networkErrorCode: null,
    latencyMs: null,
  };
  const started = performance.now();
  try {
    const { status, payload } = await request(url);
    result.httpStatus = status;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('INVALID_RESPONSE');
    result.providerCode =
      typeof payload.code === 'string' && /^[A-Za-z_]{1,64}$/.test(payload.code)
        ? payload.code
        : null;
    result.diagnostic =
      result.providerCode === 'InvalidOptions'
        ? 'options_rejection'
        : result.providerCode === 'NoSegment'
          ? 'snap_failure'
          : result.providerCode === 'NoRoute'
            ? 'route_failure'
            : result.providerCode === 'Ok'
              ? 'route_response'
              : 'provider_rejection';
    if (testCase.negativeControl === true)
      result.expectedVerdict =
        (status === 200 || status === 400) &&
        (result.providerCode === 'NoSegment' || result.providerCode === 'NoRoute')
          ? 'observed_rejection'
          : 'inconclusive';
    if (status < 200 || status >= 300 || payload.code !== 'Ok') {
      result.outcome =
        payload.code === 'NoRoute' || payload.code === 'NoSegment'
          ? 'unreachable'
          : 'provider_rejected';
      return result;
    }
    const route = Array.isArray(payload.routes) ? payload.routes[0] : undefined;
    const coordinates = route?.geometry?.coordinates;
    if (
      route?.geometry?.type !== 'LineString' ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      coordinates.length > 20_000 ||
      !coordinates.every(validPosition) ||
      !Number.isFinite(route.distance) ||
      route.distance < 0
    )
      throw new Error('INVALID_ROUTE');
    if (
      !Array.isArray(payload.waypoints) ||
      payload.waypoints.length !== 2 ||
      !payload.waypoints.every(
        (point) =>
          validPosition(point?.location) &&
          Number.isFinite(point.distance) &&
          point.distance >= 0 &&
          point.distance <= 100,
      )
    )
      throw new Error('INVALID_SNAP');
    result.distanceMeters = route.distance;
    result.snappedWaypoints = payload.waypoints.map((point) => ({
      coordinates: point.location,
      distanceMeters: point.distance,
    }));
    result.geometryHash = createHash('sha256').update(JSON.stringify(route.geometry)).digest('hex');
    result.geometryCoordinateCount = coordinates.length;
    result.outcome = 'computed_not_reviewed';
    if (testCase.negativeControl === true) result.expectedVerdict = 'unexpected_route';
    return result;
  } catch (error) {
    result.errorName =
      error instanceof Error && /^[A-Za-z_]{1,64}$/.test(error.name) ? error.name : null;
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      cause &&
      typeof cause === 'object' &&
      'httpStatus' in cause &&
      Number.isInteger(cause.httpStatus) &&
      cause.httpStatus >= 100 &&
      cause.httpStatus <= 599
    )
      result.httpStatus = cause.httpStatus;
    result.networkErrorCode =
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      typeof cause.code === 'string' &&
      /^[A-Z0-9_]{1,64}$/.test(cause.code)
        ? cause.code
        : null;
    const safeErrors = new Set([
      'EMPTY_RESPONSE',
      'RESPONSE_TOO_LARGE',
      'INVALID_RESPONSE',
      'INVALID_ROUTE',
      'INVALID_SNAP',
      'INVALID_ENDPOINT',
      'INVALID_HTTP_STATUS',
      'REDIRECT_REJECTED',
      'CURL_REQUEST_FAILED',
      'TIMEOUT',
    ]);
    result.error =
      error instanceof Error && safeErrors.has(error.message)
        ? error.message
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'TIMEOUT'
          : 'REQUEST_OR_PARSE_FAILED';
    return result;
  } finally {
    result.latencyMs = Math.round(performance.now() - started);
  }
}

async function main() {
  const transport = parseArguments(process.argv.slice(2));
  if (!transport) {
    console.log(
      'Opt-in only: node scripts/probe-routing.mjs --execute [--transport=curl]. Runs up to three sequential public synthetic probes; never use as CI. Default transport is Node fetch; no automatic fallback or retries.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Public routing probes are disabled in CI');
  const output = fileURLToPath(
    new URL('../docs/implementation/research/routing-sample-results.json', import.meta.url),
  );
  const previousRuns = [];
  try {
    const previous = JSON.parse(await readFile(output, 'utf8'));
    const { previousRuns: history = [], ...lastRun } = previous;
    if (!Array.isArray(history) || typeof lastRun.executedAt !== 'string')
      throw new Error('INVALID_PREVIOUS_REPORT');
    previousRuns.push(...history, lastRun);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  let curlVersion = null;
  if (transport === 'curl') {
    const { stdout } = await execFileAsync('curl', ['--disable', '--version'], {
      timeout: 2000,
      maxBuffer: 8192,
      encoding: 'utf8',
    });
    curlVersion = /^curl ([0-9]+\.[0-9]+\.[0-9]+)\b/.exec(stdout)?.[1] ?? null;
    if (!curlVersion) throw new Error('INVALID_CURL_VERSION');
  }
  const results = [];
  for (const [index, testCase] of cases.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await probe(testCase, transport === 'curl' ? curlRequest : nodeRequest);
    results.push(result);
    if ([403, 429].includes(result.httpStatus)) break;
  }
  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    scope: 'M0-06b manual low-rate public synthetic feasibility sample only',
    executionContext: {
      transport,
      curlVersion,
      nodeVersion: process.version,
      systemCaRequested: process.execArgv.includes('--use-system-ca'),
      additionalCaConfigured: Boolean(process.env.NODE_EXTRA_CA_CERTS),
      proxyConfigured: Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY),
      diagnosticLimitation:
        'Only bounded Error.name and Error.cause.code are retained. A pre-HTTP failure does not establish provider rejection or routing coverage.',
    },
    provenance,
    limits: {
      maximumRequests: 3,
      requestCount: results.length,
      parallelRequests: 1,
      minimumPauseBetweenRequestsMs: 1100,
      timeoutMs: 15000,
      maximumResponseBytes: maxBytes,
      retries: 0,
    },
    interpretation:
      'HTTP success and computed geometry are not Korea walking coverage or real access/safety approval. No production provider selected; full routes are not retained.',
    notExecutedCaseIds: cases.slice(results.length).map((testCase) => testCase.id),
    results,
    previousRuns,
  };
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, output);
  console.log(
    JSON.stringify({
      output: 'docs/implementation/research/routing-sample-results.json',
      results: results.map(({ caseId, outcome, httpStatus, providerCode, error }) => ({
        caseId,
        outcome,
        httpStatus,
        providerCode,
        error,
      })),
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
