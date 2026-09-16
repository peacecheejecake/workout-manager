import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const origin = 'https://routing.openstreetmap.de';
const endpoint = `${origin}/routed-foot/route/v1/foot/`;
const cases = [
  {
    id: 'KR-SYN-01',
    context: 'Synthetic Seoul city probe; exact walkway not independently reviewed',
    coordinates: [
      [126.978, 37.566],
      [126.982, 37.566],
    ],
  },
  {
    id: 'KR-SYN-02',
    context:
      'Synthetic Han River crossing probe; bridge/access suitability not independently reviewed',
    coordinates: [
      [126.93, 37.525],
      [126.932, 37.537],
    ],
  },
  {
    id: 'NEG-SYN-01',
    context: 'Synthetic ocean coordinates; no long-distance snap allowed',
    coordinates: [
      [0, 0],
      [0.001, 0.001],
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
async function probe(testCase) {
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
    caseRevision: 1,
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
    const response = await fetch(url, {
      headers: {
        'user-agent':
          'WorkoutManager-RoutingResearch/0.1 (manual fixed-public-coordinate feasibility probe; no personal GPS)',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    result.httpStatus = response.status;
    const payload = await readBoundedJson(response);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('INVALID_RESPONSE');
    result.providerCode =
      typeof payload.code === 'string' && /^[A-Za-z_]{1,64}$/.test(payload.code)
        ? payload.code
        : null;
    if (!response.ok || payload.code !== 'Ok') {
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
          validPosition(point.location) &&
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
    return result;
  } catch (error) {
    result.errorName =
      error instanceof Error && /^[A-Za-z_]{1,64}$/.test(error.name) ? error.name : null;
    const cause = error instanceof Error ? error.cause : undefined;
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

if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
  console.log(
    'Opt-in only: node scripts/probe-routing.mjs --execute. Runs up to three sequential public synthetic probes; never use as CI.',
  );
} else {
  if (process.env.CI) throw new Error('Public routing probes are disabled in CI');
  const results = [];
  for (const [index, testCase] of cases.entries()) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await probe(testCase);
    results.push(result);
    if ([403, 429].includes(result.httpStatus)) break;
  }
  const report = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    scope: 'M0-06b manual low-rate public synthetic feasibility sample only',
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
  };
  const output = fileURLToPath(
    new URL('../docs/implementation/research/routing-sample-results.json', import.meta.url),
  );
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
