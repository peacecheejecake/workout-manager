/**
 * M0-06b: coverage evidence set for an INDEPENDENT reviewer of Korean pedestrian routing.
 *
 *   node --import tsx scripts/probe-routing-korea-coverage.mts --execute
 *   ROUTING_GRAPH_ROOT=<dir> ROUTING_EXTRACT_SOURCE=<allowlist id> \
 *     node --import tsx scripts/probe-routing-korea-coverage.mts --execute --report-name <file>.json
 *
 * Opt-in only, refuses to run in CI. It never calls an external routing service.
 *
 * HOLD THE SHARED HARNESS LOCK while it runs (M0-06b review). It starts an engine on loopback
 * 8997/8998, which other nodes' probes also use, and reads the shared `.geo-build`. The lock is
 * a convention of the machine it runs on, not something this file can take: the probe refuses
 * to start when either port is already bound, and the run must be wrapped in the lock.
 *
 * With `ROUTING_GRAPH_ROOT` it runs on the relocated deployment instead of the served one, with
 * the extract `ROUTING_EXTRACT_SOURCE` selects (M2-01ak: the national graph), and must write its
 * own report (`--report-name`), so the M0-06b record stays what it was.
 *
 * What it does:
 * 1. Verifies the deployed graph (`.geo-build/routing-graph/foot`, or the relocated one) against its
 *    manifest (graph files, engine jar, serving profile), then copies the graph files into
 *    a temporary directory and verifies the copy against the same manifest. The engine runs
 *    on the copy. GraphHopper creates a transient lock file in the graph directory it loads,
 *    and `.geo-build` must not be written to by this probe.
 * 2. Starts the pinned GraphHopper jar on loopback through `startEngine`, which builds its
 *    command line with `scripts/geo/graphhopper-launch.mjs` (the runbook launch).
 * 3. Sends every sample pair through the production adapter (`WalkingRouteService`), and
 *    one supplementary engine request with edge details, so that snap distances also exist
 *    for failed pairs and the road class, environment and car-oriented `road_access` along
 *    the route are visible.
 * 4. Extracts access-tagged ways, access/barrier nodes and military areas from the same
 *    extract with `osmium` into the temporary directory, and records whether each computed
 *    route runs along a way tagged `foot=no`, `access=private` and similar values, passes a
 *    restricted node, or enters a military area.
 *
 * M2-01ay: on a graph that encodes `osm_way_id` the supplementary request also asks for it, and
 * the ways under a route are the engine's own (`wayMatchMethod: engine-way-ids`) with their tags
 * read from the extract by id, instead of ways found near the line. The geometric match could
 * take a parallel way under or beside a route for the route (the M0-06b review's FRY-03
 * `foot=no` match). Bridges and tunnels are listed too, so a reviewer can see which crossing a
 * route took. Nodes are still matched geometrically, and their pedestrian access is reported
 * by `foot`-before-`access` precedence as well as by the M0-06b class. The graph directory is
 * copied with its subdirectories (edge facts).
 *
 * What it does NOT do: it grades nothing. There is no expected outcome in this file and the
 * report has no pass field. A computed route is evidence that the graph had edges, not that
 * a person can walk there today. The coordinates are synthetic points at public landmarks
 * and contain no personal GPS data. The report carries no host paths and no host names.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { cpus, homedir, tmpdir, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { WalkingRouteRequest, WalkingRouteResult } from '../packages/contracts/src/routing.js';
import {
  RoutingRequestError,
  TenantAdmissionControl,
  WalkingRouteService,
  GraphHopperRoutingAdapter,
  createRoutingEngineEndpoint,
  graphEncodedValueNames,
  hashGraphDirectory,
  haversineMeters,
  loadRoutingDeployment,
  loadVerifiedRoutingGraph,
} from '../packages/server/integrations/src/routing/index.js';
import {
  probeReportPath,
  relocatedDeploymentNote,
  routingExtract,
  routingGraphConfig,
  routingGraphDirectory,
  routingGraphRelocated,
  routingGraphRoot,
  startEngine,
  stopEngine,
  waitForEngine,
} from './build-routing-graph.mjs';
import {
  accessClass,
  checkRouteTags,
  decodeOpl,
  indexNodes,
  indexSegments,
  isPosition,
  item,
  nodeMatchToleranceMeters,
  positions,
  stringTags,
  timeConditional,
  wayMatchMaxAngleDegrees,
  wayMatchToleranceMeters,
  type EngineWay,
  type Position,
  type TagIndex,
  type TaggedArea,
  type TaggedNode,
  type TaggedWay,
  type Tags,
} from './routing-tag-check.ts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
// Follows ROUTING_GRAPH_ROOT / ROUTING_EXTRACT_SOURCE (M2-01ak); the served layout by default.
const extractPath = routingExtract.path;
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const CANONICAL_REPORT = 'm0-06b-routing-korea-coverage.json';
/** How the report names the graph directory: never a host path. */
const graphDirectoryLabel = routingGraphRelocated
  ? '<ROUTING_GRAPH_ROOT>/foot'
  : '.geo-build/routing-graph/foot';

/** Ports away from the runbook's blue (8991) and green (8993) pair. */
const enginePorts = { application: 8997, admin: 8998 } as const;

type Stratum =
  | 'dense-urban-seoul'
  | 'dense-urban-busan'
  | 'suburban'
  | 'mountain-trail'
  | 'rural'
  | 'riverside'
  | 'university-campus'
  | 'apartment-complex'
  | 'access-restricted-military'
  | 'access-restricted-private'
  | 'access-restricted-foot-no'
  | 'stairs'
  | 'underpass'
  | 'pedestrian-bridge'
  | 'ferry'
  | 'negative-control';

interface SamplePair {
  readonly id: string;
  /** One of {@link Stratum} for the built-in sample; free text from a `--pairs` file. */
  readonly stratum: string;
  /** Region label from a `--pairs` file. Not used by the built-in sample. */
  readonly region?: string;
  readonly from: { readonly label: string; readonly position: Position };
  readonly to: { readonly label: string; readonly position: Position };
  /** What the independent reviewer should look at. Not an expected result. */
  readonly reviewerFocus: string;
}

/**
 * Stratified sample. Coordinates are rounded, hand-picked points at public landmarks
 * ([longitude, latitude], WGS84). They are approximate by design: the engine snaps them to
 * the network and the snap distance is reported. No personal GPS data is used.
 * The order and the ids are fixed so a rerun is comparable.
 */
const samplePairs: readonly (SamplePair & { readonly stratum: Stratum })[] = [
  {
    id: 'URB-SEL-01',
    stratum: 'dense-urban-seoul',
    from: { label: '강남역', position: [127.0276, 37.4979] },
    to: { label: '역삼역', position: [127.0364, 37.5006] },
    reviewerFocus: '테헤란로 보도·횡단보도를 따르는지',
  },
  {
    id: 'URB-SEL-02',
    stratum: 'dense-urban-seoul',
    from: { label: '명동성당', position: [126.987, 37.5633] },
    to: { label: '남대문시장', position: [126.9776, 37.5592] },
    reviewerFocus: '명동 보행 골목과 대로 횡단 지점',
  },
  {
    id: 'URB-SEL-03',
    stratum: 'dense-urban-seoul',
    from: { label: '홍대입구역', position: [126.9245, 37.5572] },
    to: { label: '합정역', position: [126.9139, 37.5496] },
    reviewerFocus: '양화로 보도와 골목 경로',
  },
  {
    id: 'URB-SEL-04',
    stratum: 'dense-urban-seoul',
    from: { label: '서울역', position: [126.9707, 37.5547] },
    to: { label: '강남역', position: [127.0276, 37.4979] },
    reviewerFocus: '한강 횡단 교량의 보도 존재, 긴 도심 경로의 연결성',
  },
  {
    id: 'URB-BSN-01',
    stratum: 'dense-urban-busan',
    from: { label: '부산 서면역', position: [129.0592, 35.1578] },
    to: { label: '부산 전포카페거리', position: [129.0648, 35.1555] },
    reviewerFocus: '배포 extract 밖 도시의 응답 형태',
  },
  {
    id: 'URB-BSN-02',
    stratum: 'dense-urban-busan',
    from: { label: '해운대해수욕장', position: [129.1604, 35.1587] },
    to: { label: '해운대역', position: [129.1589, 35.1633] },
    reviewerFocus: '배포 extract 밖 도시의 응답 형태',
  },
  {
    id: 'SUB-01',
    stratum: 'suburban',
    from: { label: '성남 서현역', position: [127.1233, 37.385] },
    to: { label: '성남 수내역', position: [127.1143, 37.3786] },
    reviewerFocus: '분당 신도시 보도·중앙공원 경로',
  },
  {
    id: 'SUB-02',
    stratum: 'suburban',
    from: { label: '고양 정발산역', position: [126.7733, 37.6597] },
    to: { label: '일산호수공원', position: [126.766, 37.654] },
    reviewerFocus: '일산 신도시 보도·공원 진입로',
  },
  {
    id: 'SUB-03',
    stratum: 'suburban',
    from: { label: '안양 범계역', position: [126.9728, 37.39] },
    to: { label: '안양 평촌역', position: [126.9637, 37.3942] },
    reviewerFocus: '평촌 신도시 보도',
  },
  {
    id: 'SUB-04',
    stratum: 'suburban',
    from: { label: '수원 화성행궁', position: [127.0138, 37.2818] },
    to: { label: '수원 팔달문', position: [127.0172, 37.2772] },
    reviewerFocus: '배포 extract 밖 교외 도시의 응답 형태',
  },
  {
    id: 'MTN-01',
    stratum: 'mountain-trail',
    from: { label: '북한산 북한산성 탐방지원센터', position: [126.948, 37.659] },
    to: { label: '북한산 백운대', position: [126.9778, 37.6587] },
    reviewerFocus: 'sac_scale 등급 탐방로가 제외되는지, 우회 경로의 실재',
  },
  {
    id: 'MTN-02',
    stratum: 'mountain-trail',
    from: { label: '관악산 공원 입구', position: [126.9483, 37.471] },
    to: { label: '관악산 연주대', position: [126.9637, 37.4449] },
    reviewerFocus: '등산로 연결과 암릉 구간 처리',
  },
  {
    id: 'MTN-03',
    stratum: 'mountain-trail',
    from: { label: '남한산성 남문', position: [127.1788, 37.4705] },
    to: { label: '남한산성 행궁', position: [127.1811, 37.4786] },
    reviewerFocus: '성곽 탐방로와 성문 통과',
  },
  {
    id: 'RUR-01',
    stratum: 'rural',
    from: { label: '설악산 소공원', position: [128.487, 38.1719] },
    to: { label: '설악산 비선대', position: [128.473, 38.1615] },
    reviewerFocus: '배포 extract 밖 국립공원의 응답 형태',
  },
  {
    id: 'RUR-02',
    stratum: 'rural',
    from: { label: '안동 하회마을', position: [128.5185, 36.539] },
    to: { label: '안동 부용대', position: [128.5132, 36.5418] },
    reviewerFocus: '배포 extract 밖 농촌 마을의 응답 형태',
  },
  {
    id: 'RIV-01',
    stratum: 'riverside',
    from: { label: '반포한강공원', position: [126.996, 37.5105] },
    to: { label: '잠원한강공원', position: [127.013, 37.5195] },
    reviewerFocus: '한강 남안 산책로 연속성과 진입 나들목',
  },
  {
    id: 'RIV-02',
    stratum: 'riverside',
    from: { label: '안양천 오목교', position: [126.875, 37.5245] },
    to: { label: '안양천 신정교', position: [126.865, 37.517] },
    reviewerFocus: '하천변 산책로와 제방 진입로',
  },
  {
    id: 'RIV-03',
    stratum: 'riverside',
    from: { label: '성남 정자역', position: [127.1113, 37.367] },
    to: { label: '성남 미금역', position: [127.1087, 37.35] },
    reviewerFocus: '탄천 산책로 연결',
  },
  {
    id: 'RIV-04',
    stratum: 'riverside',
    from: { label: '부산 동래역', position: [129.0784, 35.2055] },
    to: { label: '부산 온천장역', position: [129.086, 35.2203] },
    reviewerFocus: '배포 extract 밖 하천 산책로(온천천)의 응답 형태',
  },
  {
    id: 'UNI-01',
    stratum: 'university-campus',
    from: { label: '서울대 정문', position: [126.9519, 37.4664] },
    to: { label: '서울대 중앙도서관', position: [126.9526, 37.4596] },
    reviewerFocus: '캠퍼스 내부 도로의 access 태그와 실제 개방 여부',
  },
  {
    id: 'UNI-02',
    stratum: 'university-campus',
    from: { label: '연세대 정문', position: [126.9369, 37.5596] },
    to: { label: '연세대 언더우드관', position: [126.9391, 37.5664] },
    reviewerFocus: '캠퍼스 내부 보행로',
  },
  {
    id: 'APT-01',
    stratum: 'apartment-complex',
    from: { label: '압구정 현대아파트 단지 내부', position: [127.0265, 37.532] },
    to: { label: '압구정역', position: [127.0285, 37.527] },
    reviewerFocus: '단지 내부 도로(private 여부)와 출입구 통과',
  },
  {
    id: 'APT-02',
    stratum: 'apartment-complex',
    from: { label: '잠실 아파트 단지 내부', position: [127.08, 37.514] },
    to: { label: '잠실새내역', position: [127.0864, 37.5116] },
    reviewerFocus: '단지 내부 도로(private 여부)와 출입구 통과',
  },
  {
    id: 'ACC-MIL-01',
    stratum: 'access-restricted-military',
    from: { label: '삼각지역', position: [126.9731, 37.5349] },
    to: { label: '이촌역', position: [126.9752, 37.5218] },
    reviewerFocus: '두 점 사이 직선이 옛 용산기지 부지를 지난다. 경로가 부지 안을 지나는지',
  },
  {
    id: 'ACC-MIL-02',
    stratum: 'access-restricted-military',
    from: { label: '서울공항 서측', position: [127.1, 37.445] },
    to: { label: '서울공항 동측', position: [127.132, 37.442] },
    reviewerFocus: '두 점 사이 직선이 군 비행장을 지난다. 경로가 비행장 안을 지나는지',
  },
  {
    id: 'ACC-PRV-01',
    stratum: 'access-restricted-private',
    from: { label: '청와대로', position: [126.975, 37.583] },
    to: { label: '삼청공원', position: [126.983, 37.59] },
    reviewerFocus: '개방 상태가 바뀌어 온 구역. 경로가 경내를 지나는지와 현재 개방 여부',
  },
  {
    id: 'ACC-FOOTNO-01',
    stratum: 'access-restricted-foot-no',
    from: { label: '뚝섬한강공원', position: [127.069, 37.529] },
    to: { label: '청담동 한강변', position: [127.056, 37.522] },
    reviewerFocus: '한강 횡단 교량 중 보행 불가 교량을 쓰는지',
  },
  {
    id: 'STR-01',
    stratum: 'stairs',
    from: { label: '이화마을', position: [127.007, 37.578] },
    to: { label: '낙산공원', position: [127.0075, 37.5807] },
    reviewerFocus: '계단(highway=steps) 사용과 무계단 대안',
  },
  {
    id: 'STR-02',
    stratum: 'stairs',
    from: { label: '해방촌 108계단 아래', position: [126.985, 37.5445] },
    to: { label: '해방촌 108계단 위', position: [126.987, 37.547] },
    reviewerFocus: '계단(highway=steps) 사용과 경사로·엘리베이터 대안',
  },
  {
    id: 'UND-01',
    stratum: 'underpass',
    from: { label: '시청역', position: [126.977, 37.5657] },
    to: { label: '을지로입구역', position: [126.9826, 37.566] },
    reviewerFocus: '지하상가·지하보도 사용 여부(실내 통로는 프로필이 쓰지 않을 수 있음)',
  },
  {
    id: 'UND-02',
    stratum: 'underpass',
    from: { label: '강남대로 서측(강남역)', position: [127.0268, 37.4983] },
    to: { label: '강남대로 동측(강남역)', position: [127.0287, 37.4975] },
    reviewerFocus: '대로 횡단이 횡단보도인지 지하도인지',
  },
  {
    id: 'BRG-01',
    stratum: 'pedestrian-bridge',
    from: { label: '반포한강공원', position: [126.996, 37.5105] },
    to: { label: '잠수교 북단', position: [126.995, 37.5195] },
    reviewerFocus: '잠수교 보행로 사용 여부와 침수 통제',
  },
  {
    id: 'BRG-02',
    stratum: 'pedestrian-bridge',
    from: { label: '서울역 서부', position: [126.969, 37.556] },
    to: { label: '회현역', position: [126.9785, 37.5585] },
    reviewerFocus: '서울로7017 고가 보행로 사용 여부',
  },
  {
    id: 'BRG-03',
    stratum: 'pedestrian-bridge',
    from: { label: '선유도공원', position: [126.899, 37.543] },
    to: { label: '양화한강공원', position: [126.903, 37.539] },
    reviewerFocus: '선유교 보행교 사용 여부',
  },
  {
    id: 'FRY-01',
    stratum: 'ferry',
    from: { label: '인천 월미도 선착장', position: [126.5975, 37.477] },
    // Corrected before the first engine run: a first guess of [126.5957, 37.4988] was
    // about 1.2 km off the pier. The pier position was checked against the extract's
    // route=ferry way end, not against any engine answer.
    to: { label: '영종도 구읍뱃터', position: [126.5822, 37.4936] },
    reviewerFocus: '도선(route=ferry) 사용 여부, 운항 시간·요금 정보 부재',
  },
  {
    id: 'FRY-03',
    stratum: 'ferry',
    from: { label: '여의도한강공원 선착장', position: [126.935, 37.5286] },
    to: { label: '압구정 한강 선착장', position: [127.0207, 37.5362] },
    reviewerFocus: '정기 운항 선박(한강버스, route=ferry)을 보행 경로에 넣는지와 강변 보행로 대안',
  },
  {
    id: 'FRY-02',
    stratum: 'ferry',
    from: { label: '제주 성산포항', position: [126.9316, 33.4735] },
    to: { label: '우도 천진항', position: [126.953, 33.494] },
    reviewerFocus: '배포 extract 밖 도선 구간의 응답 형태',
  },
  {
    id: 'NEG-OFFSHORE',
    stratum: 'negative-control',
    from: { label: '서해 해상', position: [125.5, 36.5] },
    to: { label: '서해 해상', position: [125.52, 36.52] },
    reviewerFocus: '보행망이 없는 좌표. 경로가 나오면 결함',
  },
];

interface Options {
  readonly reportPath: string;
  /** A sample file to run instead of the built-in pairs (M0-06b coverage review). */
  readonly pairsPath: string | null;
}

function parseArguments(argv: readonly string[]): Options | 'list-pairs' | null {
  if (argv.length === 1 && argv[0] === '--list-pairs') return 'list-pairs';
  if (!argv.includes('--execute')) return null;
  let pairsPath: string | null = null;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = item(argv, index);
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === '--execute') continue;
    if (flag !== '--report-name' && flag !== '--pairs') return null;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return null;
    if (flag === '--pairs') pairsPath = resolve(value);
    index += 1;
  }
  // A relocated run must name its own report (M2-01af F3), checked before anything starts.
  const reportPath = probeReportPath(argv, CANONICAL_REPORT);
  // A different sample is a different record: it never lands in the canonical report either.
  if (pairsPath !== null && (!seen.has('--report-name') || reportPath.endsWith(CANONICAL_REPORT)))
    throw new Error('PAIRS_FILE_NEEDS_ITS_OWN_REPORT: pass --report-name other than the canonical');
  return { reportPath, pairsPath };
}

/** The built-in sample in the `--pairs` file shape, so a review sample can start from it. */
function listPairs(): string {
  const pairs = samplePairs.map((pair) => ({
    id: pair.id,
    stratum: pair.stratum,
    description: pair.reviewerFocus,
    from: pair.from,
    to: pair.to,
  }));
  return `${JSON.stringify({ pairs }, null, 2)}\n`;
}

function textField(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`PAIRS_FILE_BAD_${name}`);
  return value;
}

function endpointField(value: unknown, name: string): SamplePair['from'] {
  const endpoint = value as { label?: unknown; position?: unknown } | null;
  const position = endpoint?.position;
  if (
    !isPosition(position) ||
    position.length !== 2 ||
    !position.every(Number.isFinite) ||
    Math.abs(position[0]) > 180 ||
    Math.abs(position[1]) > 90
  )
    throw new Error(`PAIRS_FILE_BAD_${name}_POSITION`);
  return {
    label: textField(endpoint?.label, /^.{1,80}$/u, `${name}_LABEL`),
    position: [position[0], position[1]],
  };
}

/**
 * Reads a `--pairs` file: `{ "pairs": [{ id, stratum, region?, description, from, to }] }` with
 * `from`/`to` as `{ label, position: [longitude, latitude] }`. Everything else in the file is
 * ignored, so a blinded review file (ids, strata, landmark descriptions, coordinates) is a valid
 * input and nothing here reads an expectation.
 */
async function loadPairs(path: string): Promise<{ pairs: SamplePair[]; sha256: string }> {
  const bytes = await readFile(path);
  const parsed = JSON.parse(bytes.toString('utf8')) as { pairs?: unknown };
  if (!Array.isArray(parsed.pairs) || parsed.pairs.length === 0 || parsed.pairs.length > 200)
    throw new Error('PAIRS_FILE_NEEDS_1_TO_200_PAIRS');
  const pairs = parsed.pairs.map((raw: unknown): SamplePair => {
    const entry = raw as Record<string, unknown>;
    return {
      id: textField(entry.id, /^[A-Z0-9-]{1,32}$/, 'ID'),
      stratum: textField(entry.stratum, /^[a-z0-9-]{1,48}$/, 'STRATUM'),
      ...(entry.region === undefined
        ? {}
        : { region: textField(entry.region, /^.{1,40}$/u, 'REGION') }),
      from: endpointField(entry.from, 'FROM'),
      to: endpointField(entry.to, 'TO'),
      reviewerFocus: textField(entry.description, /^.{1,300}$/u, 'DESCRIPTION'),
    };
  });
  if (new Set(pairs.map((pair) => pair.id)).size !== pairs.length)
    throw new Error('PAIRS_FILE_DUPLICATE_ID');
  return { pairs, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * The engine ports must be free: another process on them would answer for this one. A TCP
 * connect, not an HTTP request, so a bound port that does not speak HTTP counts as busy too
 * (review round 1).
 */
async function refuseBusyPorts(ports: readonly number[]): Promise<void> {
  for (const port of ports) {
    const busy = await new Promise<boolean>((done) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        done(true);
      });
      // Refused: nothing listens. A timeout means something holds the port without answering.
      socket.once('timeout', () => {
        socket.destroy();
        done(true);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => done(error.code !== 'ECONNREFUSED'));
    });
    if (busy) throw new Error(`PORT_BUSY: ${port} (hold the harness lock; see the file header)`);
  }
}

/**
 * A byte-identical copy of the graph directory, subdirectories included (M2-01ay: the edge facts
 * live in `edge-facts/`). Anything but a regular file or a directory is refused.
 */
async function copyGraphDirectory(source: string, target: string): Promise<void> {
  await mkdir(target);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory())
      await copyGraphDirectory(join(source, entry.name), join(target, entry.name));
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(target, entry.name));
    else throw new Error(`UNEXPECTED_GRAPH_ENTRY: ${entry.name}`);
  }
}

/**
 * The tags of the given OSM ways, read from the extract with `osmium getid` (M2-01ay). Every id
 * must be found: an engine way id that is not in the extract the graph was built from is a
 * problem, not a gap.
 */
async function readWayTags(scratch: string, ids: readonly number[]): Promise<Map<number, Tags>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const tags = new Map<number, Tags>();
  if (unique.length === 0) return tags;
  const idFile = join(scratch, 'engine-way-ids.txt');
  await writeFile(idFile, `${unique.map((id) => `w${id}`).join('\n')}\n`);
  const opl = await run('osmium', [
    'getid',
    extractPath,
    '--id-file',
    idFile,
    '--output-format',
    'opl',
    '--output',
    '-',
  ]);
  for (const line of opl.split('\n')) {
    const match = /^w(\d+) .* T(\S*)/.exec(line);
    if (match?.[1] === undefined) continue;
    const entry: Record<string, string> = {};
    for (const pair of (match[2] ?? '').split(',')) {
      if (pair === '') continue;
      const separator = pair.indexOf('=');
      if (separator < 0) continue;
      entry[decodeOpl(pair.slice(0, separator))] = decodeOpl(pair.slice(separator + 1));
    }
    tags.set(Number(match[1]), entry);
  }
  const missing = unique.filter((id) => !tags.has(id));
  if (missing.length > 0)
    throw new Error(`ENGINE_WAYS_NOT_IN_EXTRACT: ${missing.slice(0, 5).join(', ')}`);
  return tags;
}

/** Removes host-specific path prefixes from any text that goes into the report. */
function makeRedactor(prefixes: readonly string[]) {
  return (text: string): string =>
    prefixes.reduce((current, prefix) => current.split(prefix).join('<redacted>'), text);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Names and sizes of the files in a directory, to show that the run did not change it. */
async function directoryListing(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const listing: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const { size } = await stat(join(directory, entry.name));
    listing.push(`${entry.isDirectory() ? 'dir' : 'file'} ${entry.name} ${size}`);
  }
  return listing;
}

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (code === 0) done(stdout);
      else fail(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

async function buildTagIndex(scratch: string): Promise<TagIndex> {
  const filtered = join(scratch, 'tagged.osm.pbf');
  const exported = join(scratch, 'tagged.geojsonseq');
  await run('osmium', [
    'tags-filter',
    '--overwrite',
    '--output',
    filtered,
    extractPath,
    'w/foot',
    'w/access',
    'w/highway=trunk,trunk_link,motorway,motorway_link,corridor,steps',
    'w/indoor',
    'w/route=ferry',
    'w/sac_scale',
    // Coverage review (M0-06b): crossings and time-conditional access, reported only.
    'w/footway=crossing',
    'w/access:conditional',
    'w/foot:conditional',
    'w/opening_hours',
    'n/highway=crossing',
    'n/foot',
    'n/access',
    'n/barrier',
    'a/landuse=military',
    'a/military',
  ]);
  await run('osmium', [
    'export',
    '--overwrite',
    '--format',
    'geojsonseq',
    '--add-unique-id',
    'type_id',
    '--output',
    exported,
    filtered,
  ]);

  const ways: TaggedWay[] = [];
  const nodes: TaggedNode[] = [];
  const areas: TaggedArea[] = [];
  const counts = new Map<string, { count: number; meters: number }>();
  const bump = (key: string, meters: number) => {
    const entry = counts.get(key) ?? { count: 0, meters: 0 };
    counts.set(key, { count: entry.count + 1, meters: entry.meters + meters });
  };

  const lines = createInterface({ input: createReadStream(exported, 'utf8') });
  for await (const rawLine of lines) {
    const line = (rawLine.startsWith('\u001e') ? rawLine.slice(1) : rawLine).trim();
    if (line.length === 0) continue;
    const feature = JSON.parse(line) as {
      id?: unknown;
      properties?: unknown;
      geometry?: { type?: unknown; coordinates?: unknown } | null;
    };
    const id = typeof feature.id === 'string' ? feature.id : String(feature.id);
    const tags = stringTags(feature.properties);
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === 'Point' && isPosition(geometry.coordinates)) {
      if (accessClass(tags) !== null || tags.highway === 'crossing')
        nodes.push({ id, tags, position: [geometry.coordinates[0], geometry.coordinates[1]] });
      continue;
    }
    if (geometry.type === 'LineString') {
      const coordinates = positions(geometry.coordinates);
      if (coordinates.length < 2) continue;
      let meters = 0;
      for (let index = 1; index < coordinates.length; index += 1)
        meters += haversineMeters(item(coordinates, index - 1), item(coordinates, index));
      const highway = tags.highway;
      const klass = accessClass(tags);
      if (highway !== undefined) {
        if (klass !== null) bump(`highway way with ${klass}`, meters);
        if (['trunk', 'trunk_link', 'motorway', 'motorway_link'].includes(highway)) {
          bump(`highway=${highway}`, meters);
          if (tags.sidewalk !== undefined && tags.sidewalk !== 'no' && tags.sidewalk !== 'none')
            bump(`highway=${highway} with sidewalk=${tags.sidewalk}`, meters);
          if (tags.foot !== undefined) bump(`highway=${highway} with foot=${tags.foot}`, meters);
        }
        if (highway === 'corridor') bump('highway=corridor', meters);
        if (highway === 'steps') bump('highway=steps', meters);
        // GraphHopper 10.0 foot.json multiplies priority by 0 when hike_rating >= 2, i.e.
        // sac_scale=mountain_hiking or harder, so these ways carry no foot route.
        if (tags.sac_scale !== undefined)
          bump(`highway way with sac_scale=${tags.sac_scale}`, meters);
        if (tags.indoor !== undefined) bump(`highway way with indoor=${tags.indoor}`, meters);
      } else if (tags.indoor !== undefined) {
        bump(`non-highway way with indoor=${tags.indoor}`, meters);
      }
      if (tags.route === 'ferry') bump('route=ferry', meters);
      const crossing = highway !== undefined && tags.footway === 'crossing';
      const conditional = highway !== undefined && timeConditional(tags);
      if (crossing) bump('highway way with footway=crossing', meters);
      if (conditional) bump('highway way with a time condition', meters);
      if (klass !== null || tags.route === 'ferry' || crossing || conditional)
        ways.push({ id, tags, coordinates });
      continue;
    }
    if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
      if (tags.landuse !== 'military' && tags.military === undefined) continue;
      const parts: Position[][][] =
        geometry.type === 'Polygon'
          ? [(geometry.coordinates as unknown[]).map(positions)]
          : (geometry.coordinates as unknown[][]).map((part) => part.map(positions));
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const part of parts)
        for (const [x, y] of part[0] ?? []) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      areas.push({ id, tags, polygons: parts, bbox: [minX, minY, maxX, maxY] });
      bump(
        `military area (${tags.landuse === 'military' ? 'landuse=military' : `military=${tags.military}`})`,
        0,
      );
    }
  }

  const statistics: Record<string, unknown> = {};
  for (const [key, value] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)))
    statistics[key] = { count: value.count, kilometers: Number((value.meters / 1000).toFixed(2)) };
  statistics['restricted or access-tagged nodes indexed'] = nodes.filter(
    (node) => accessClass(node.tags) !== null,
  ).length;
  statistics['highway=crossing nodes indexed'] = nodes.filter(
    (node) => node.tags.highway === 'crossing',
  ).length;
  return { ways, nodes, areas, statistics };
}

// ---------------------------------------------------------------------------------------
// Supplementary engine request: details and snap distances
// ---------------------------------------------------------------------------------------

/**
 * `street_name` (M0-06b coverage review) is the OSM `name` of the edges, from the graph's
 * key-value store: how a reviewer sees which named bridge or street a route used.
 */
const detailKeys = [
  'road_class',
  'road_environment',
  'road_access',
  'surface',
  'street_name',
] as const;

interface EngineDetailView {
  readonly httpStatus: number;
  readonly engineMessage: string | null;
  readonly distanceMeters: number | null;
  readonly snapDistancesMeters: number[] | null;
  readonly metersByDetail: Record<string, Record<string, number>> | null;
  /**
   * M2-01ay, on a graph that encodes `osm_way_id`: the OSM ways under the route in order, with the
   * metres on each (consecutive edges of one way merged). `null` on an older graph or a failure.
   */
  readonly ways: EngineWay[] | null;
}

async function engineDetailView(pair: SamplePair, withWayIds: boolean): Promise<EngineDetailView> {
  const query = new URLSearchParams({
    profile: 'foot',
    'ch.disable': 'true',
    points_encoded: 'false',
    instructions: 'false',
    calc_points: 'true',
    elevation: 'false',
    max_visited_nodes: '1000000',
    timeout_ms: '7000',
  });
  for (const key of detailKeys) query.append('details', key);
  if (withWayIds) query.append('details', 'osm_way_id');
  for (const [longitude, latitude] of [pair.from.position, pair.to.position])
    query.append('point', `${latitude},${longitude}`);
  const response = await fetch(`http://127.0.0.1:${enginePorts.application}/route?${query}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as {
    message?: unknown;
    paths?: {
      distance?: unknown;
      points?: { coordinates?: unknown };
      snapped_waypoints?: { coordinates?: unknown };
      details?: Record<string, unknown>;
    }[];
  };
  const path = Array.isArray(body.paths) ? body.paths[0] : undefined;
  if (!response.ok || path === undefined)
    return {
      httpStatus: response.status,
      engineMessage: typeof body.message === 'string' ? body.message.slice(0, 300) : null,
      distanceMeters: null,
      snapDistancesMeters: null,
      metersByDetail: null,
      ways: null,
    };
  const points = positions(path.points?.coordinates);
  const snapped = positions(path.snapped_waypoints?.coordinates);
  const requested = [pair.from.position, pair.to.position];
  const metersByDetail: Record<string, Record<string, number>> = {};
  for (const key of detailKeys) {
    const intervals = path.details?.[key];
    const totals: Record<string, number> = {};
    if (Array.isArray(intervals))
      for (const interval of intervals) {
        if (!Array.isArray(interval) || interval.length < 3) continue;
        const [from, to, value] = interval as [unknown, unknown, unknown];
        if (typeof from !== 'number' || typeof to !== 'number') continue;
        let meters = 0;
        for (let index = from + 1; index <= to && index < points.length; index += 1)
          meters += haversineMeters(item(points, index - 1), item(points, index));
        const label = String(value);
        totals[label] = Number(((totals[label] ?? 0) + meters).toFixed(1));
      }
    metersByDetail[key] = totals;
  }
  let ways: EngineWay[] | null = null;
  const wayIntervals = path.details?.osm_way_id;
  if (withWayIds) {
    if (!Array.isArray(wayIntervals)) throw new Error(`${pair.id}: NO_OSM_WAY_ID_DETAIL`);
    const merged: EngineWay[] = [];
    for (const interval of wayIntervals) {
      const [from, to, value] = interval as [unknown, unknown, unknown];
      if (typeof from !== 'number' || typeof to !== 'number' || typeof value !== 'number')
        throw new Error(`${pair.id}: BAD_OSM_WAY_ID_INTERVAL`);
      let meters = 0;
      for (let index = from + 1; index <= to && index < points.length; index += 1)
        meters += haversineMeters(item(points, index - 1), item(points, index));
      const last = merged.at(-1);
      if (last !== undefined && last.wayId === value)
        merged[merged.length - 1] = { wayId: value, meters: last.meters + meters };
      else merged.push({ wayId: value, meters });
    }
    ways = merged.map((way) => ({ wayId: way.wayId, meters: Number(way.meters.toFixed(1)) }));
  }
  return {
    httpStatus: response.status,
    engineMessage: null,
    distanceMeters: typeof path.distance === 'number' ? Number(path.distance.toFixed(1)) : null,
    snapDistancesMeters:
      snapped.length === requested.length
        ? snapped.map((position, index) =>
            Number(haversineMeters(item(requested, index), position).toFixed(2)),
          )
        : null,
    metersByDetail,
    ways,
  };
}

// ---------------------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === 'list-pairs') {
    process.stdout.write(listPairs());
    return;
  }
  if (!options) {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-routing-korea-coverage.mts --execute ' +
        '[--report-name <file>.json] (required with ROUTING_GRAPH_ROOT) ' +
        '[--pairs <file>.json] (a sample file instead of the built-in pairs; needs --report-name). ' +
        '--list-pairs prints the built-in pairs in the --pairs shape and starts nothing. ' +
        'Runs the self-hosted GraphHopper engine on loopback 8997/8998 on a verified copy of the deployed graph ' +
        'and records an ungraded Korean coverage evidence set. Hold the shared harness lock while it runs. ' +
        'Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine runs are disabled in CI');
  // Read and checked before the engine starts, so a bad file costs nothing.
  const sample =
    options.pairsPath === null
      ? { pairs: samplePairs, source: 'built-in', sha256: null }
      : { ...(await loadPairs(options.pairsPath)), source: basename(options.pairsPath) };
  for (const required of [extractPath, jarPath, routingGraphConfig, routingGraphDirectory]) {
    try {
      await stat(required);
    } catch {
      throw new Error(`MISSING_PREREQUISITE: ${required}`);
    }
  }

  await refuseBusyPorts([enginePorts.application, enginePorts.admin]);

  const scratch = await mkdtemp(join(tmpdir(), 'm0-06b-coverage-'));
  // The scratch directory (graph copy, osmium exports) goes on every path out, a failed run
  // included (M0-06b review).
  try {
    await collect(scratch, options.reportPath, sample);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface Sample {
  readonly pairs: readonly SamplePair[];
  /** `built-in`, or the file name of the `--pairs` file (never a host path). */
  readonly source: string;
  readonly sha256: string | null;
}

async function collect(scratch: string, reportPath: string, sample: Sample) {
  const redact = makeRedactor([
    scratch,
    routingGraphRoot,
    workRoot,
    repositoryRoot,
    tmpdir(),
    homedir(),
  ]);
  const endpoint = createRoutingEngineEndpoint(`http://127.0.0.1:${enginePorts.application}/`);

  // 1. The deployed graph, verified in place (read only), and its listing before the run.
  const deployed = await loadRoutingDeployment({
    graphDirectory: routingGraphDirectory,
    engineArtifactPath: jarPath,
    profileConfigPath: routingGraphConfig,
    endpoint,
  });
  const deployedListingBefore = await directoryListing(routingGraphDirectory);
  const extractSha256 = await sha256File(extractPath);
  if (extractSha256 !== deployed.manifest.extractSha256)
    throw new Error('EXTRACT_NOT_THE_ONE_THE_GRAPH_WAS_BUILT_FROM');

  // 2. A byte-identical copy the engine may lock.
  const graphCopy = join(scratch, 'foot');
  await copyGraphDirectory(routingGraphDirectory, graphCopy);
  // M2-01ay: a graph that encodes `osm_way_id` lets the tag check read the engine's own way ids.
  const withWayIds = (await graphEncodedValueNames(routingGraphDirectory)).includes('osm_way_id');
  const deployment = await loadRoutingDeployment({
    graphDirectory: graphCopy,
    engineArtifactPath: jarPath,
    profileConfigPath: routingGraphConfig,
    endpoint,
  });
  if (deployment.graphBuildId !== deployed.graphBuildId)
    throw new Error('GRAPH_COPY_IDENTITY_DIFFERS');

  const tagIndex = await buildTagIndex(scratch);
  const grid = indexSegments(tagIndex.ways);
  const nodeGrid = indexNodes(tagIndex.nodes);
  const headerInfo = JSON.parse(await run('osmium', ['fileinfo', '--json', extractPath])) as {
    header?: { boxes?: unknown };
  };
  const boxes = Array.isArray(headerInfo.header?.boxes) ? headerInfo.header.boxes : [];
  const box = Array.isArray(boxes[0]) ? (boxes[0] as number[]) : null;
  const insideHeaderBox = (position: Position) =>
    box !== null &&
    position[0] >= item(box, 0) &&
    position[0] <= item(box, 2) &&
    position[1] >= item(box, 1) &&
    position[1] <= item(box, 3);

  const engine = startEngine({
    jarPath,
    configPath: routingGraphConfig,
    extractPath,
    graphPath: graphCopy,
    ports: enginePorts,
  });

  const results: Record<string, unknown>[] = [];
  const problems: string[] = [];
  const pending: {
    entry: Record<string, unknown>;
    geometry: Position[];
    ways: EngineWay[] | null;
  }[] = [];
  try {
    await waitForEngine(engine, enginePorts.application);
    const clock = { now: () => new Date() };
    const adapter = new GraphHopperRoutingAdapter({ deployment, clock });
    // Production service, with a request window wide enough for one sequential sample run.
    const service = new WalkingRouteService({
      adapter,
      admission: new TenantAdmissionControl(
        { now: () => Date.now() },
        {
          concurrency: 1,
          requestsPerWindow: 1000,
          windowMilliseconds: 60_000,
          maxTrackedTenants: 4,
        },
      ),
      clock,
    });

    let revision = 0;
    for (const pair of sample.pairs) {
      revision += 1;
      const request: WalkingRouteRequest = {
        schemaVersion: 1,
        requestId: `m0-06b-${pair.id}`,
        requestRevision: revision,
        profileId: 'foot-v1',
        waypoints: [pair.from.position, pair.to.position],
      };
      const started = Date.now();
      let result: WalkingRouteResult | null = null;
      let rejectedBeforeEngine: string | null = null;
      try {
        ({ result } = await service.compute('m0-06b-probe', request, {}));
      } catch (error) {
        if (!(error instanceof RoutingRequestError)) throw error;
        rejectedBeforeEngine = redact(error.message);
      }
      const latencyMs = Date.now() - started;
      const computed = result?.outcome === 'route_computed' ? result : null;
      const detail = await engineDetailView(pair, withWayIds);
      const geometry = computed
        ? computed.geometry.coordinates.map(([x, y]): Position => [
            Number(x.toFixed(6)),
            Number(y.toFixed(6)),
          ])
        : null;
      results.push({
        pairId: pair.id,
        stratum: pair.stratum,
        region: pair.region ?? null,
        from: pair.from,
        to: pair.to,
        straightLineMeters: Number(
          haversineMeters(pair.from.position, pair.to.position).toFixed(1),
        ),
        bothEndsInsideExtractHeaderBbox:
          insideHeaderBox(pair.from.position) && insideHeaderBox(pair.to.position),
        outcome: result?.outcome ?? 'rejected_before_engine',
        rejectedBeforeEngine,
        warnings: result?.computation.warnings ?? [],
        distanceMeters: computed ? Number(computed.distanceMeters.toFixed(1)) : null,
        durationSeconds: computed ? Number(computed.durationSeconds.toFixed(0)) : null,
        snapDistancesMeters: computed
          ? computed.snappedWaypoints.map((entry) => Number(entry.snapDistanceMeters.toFixed(2)))
          : null,
        engineDetailView: detail,
        // Filled in below, once the tags of the ways the engine reported are read.
        tagCheck: null,
        latencyMs,
        graphBuildId: result?.computation.graph.graphBuildId ?? null,
        geometryPoints: geometry?.length ?? null,
        geometrySha256: geometry
          ? createHash('sha256').update(JSON.stringify(geometry)).digest('hex')
          : null,
        geometry,
        reviewerFocus: pair.reviewerFocus,
        coverageReview: 'not_reviewed',
      });
      if (computed && detail.distanceMeters !== null) {
        if (Math.abs(detail.distanceMeters - computed.distanceMeters) > 1)
          problems.push(`${pair.id}: detail request distance differs from the adapter answer`);
      }
      if (geometry) pending.push({ entry: results.at(-1) ?? {}, geometry, ways: detail.ways });
    }
  } finally {
    await stopEngine(engine);
  }

  // The engine's way ids are exact for the edges a route uses; their tags come from the extract.
  const wayTags = withWayIds
    ? await readWayTags(
        scratch,
        pending.flatMap((route) => (route.ways ?? []).map((way) => way.wayId)),
      )
    : new Map<number, Tags>();
  for (const route of pending) {
    if (withWayIds && route.ways === null) {
      problems.push(`${String(route.entry.pairId)}: no engine way ids for a computed route`);
      continue;
    }
    route.entry.tagCheck = checkRouteTags(
      route.geometry,
      tagIndex,
      grid,
      nodeGrid,
      withWayIds && route.ways !== null ? { ways: route.ways, tags: wayTags } : null,
    );
  }

  // 3. The deployed graph must be unchanged by the run.
  const deployedListingAfter = await directoryListing(routingGraphDirectory);
  const deployedGraphContentAfter = await hashGraphDirectory(routingGraphDirectory);
  if (deployedGraphContentAfter !== deployed.manifest.graphContentSha256)
    problems.push('the deployed graph content hash changed during the run');
  if (JSON.stringify(deployedListingAfter) !== JSON.stringify(deployedListingBefore))
    problems.push('the deployed graph directory listing changed during the run');
  const verifiedAgain = await loadVerifiedRoutingGraph(routingGraphDirectory);
  if (verifiedAgain.manifest.graphContentSha256 !== deployed.manifest.graphContentSha256)
    problems.push('the deployed graph no longer verifies against its manifest');
  if (results.length !== sample.pairs.length)
    problems.push(`ran ${results.length}/${sample.pairs.length} pairs`);
  if (!results.some((entry) => entry.outcome === 'route_computed'))
    problems.push('no pair produced a route, so the probe measured nothing');

  const report = {
    schemaVersion: 1,
    node: 'M0-06b',
    executedAt: new Date().toISOString(),
    purpose:
      'Ungraded evidence set for an independent reviewer of Korean pedestrian routing coverage. Nothing in this file is a pass or a fail.',
    coverageReview: 'not_reviewed',
    method: {
      engine:
        'Pinned GraphHopper jar started on loopback through startEngine / graphhopperJavaArguments (runbook launch), on a byte-identical temporary copy of the deployed graph verified against the same manifest. The deployed graph directory was only read.',
      requestPath:
        "Production WalkingRouteService + GraphHopperRoutingAdapter (default limits: snap 120 m, deadline 8 s, 1,000,000 visited nodes). Admission window widened to 1000/60 s so one sequential run is not refused; concurrency 1. `warnings` are the adapter answer's own; on a graph with edge facts (built since M2-01ay) they include route_includes_ferry and route_includes_time_conditional_access.",
      supplementaryRequest: `One direct loopback /route request per pair with details ${[...detailKeys, ...(withWayIds ? ['osm_way_id'] : [])].join(', ')}, used for snap distances of failed pairs, per-class metres and (with osm_way_id) the OSM ways under the route in order (engineDetailView.ways). road_access is GraphHopper 10.0 car-oriented (motorcar, motor_vehicle, vehicle, access), not foot access. street_name is the OSM name of the edges.`,
      tagCheck: withWayIds
        ? `Ways: EXACT, from the engine's own osm_way_id detail (wayMatchMethod engine-way-ids): each way's metres are summed from the engine's intervals and its tags read from the same extract with osmium; waysAlongRoute lists the ways that are access-tagged, a ferry, a crossing, time-conditional, a bridge or a tunnel. A parallel way under or beside the route cannot be matched. Nodes: foot/access/barrier nodes exported from the same extract; a route vertex within ${nodeMatchToleranceMeters} m of one counts as passing it (geometric). restrictedNodesPassed keeps its M0-06b meaning (any access-tagged node); footRestrictedNodesPassed counts only nodes whose pedestrian access is restricted (a restrictive foot value, or a restrictive access value with no foot value) and accessRestrictedNodesWithFootOverridePassed those where a foot value overrides a restrictive access value. Military areas (landuse=military or military=*): a route segment midpoint inside one counts (geometric). None of this is ground truth.`
        : `Ways tagged foot/access (and route=ferry), foot/access/barrier nodes and military areas exported from the same extract with osmium. A route segment counts as running along a way when its midpoint is within ${wayMatchToleranceMeters} m of a way segment and the directions differ by at most ${wayMatchMaxAngleDegrees} degrees. A route vertex within ${nodeMatchToleranceMeters} m of a tagged node counts as passing it. A military area counts when a route segment midpoint lies inside it. These are geometric matches against OSM tags, not ground truth.`,
      coordinates:
        'Synthetic, rounded points at public landmarks chosen by hand; approximate on purpose. No personal GPS data.',
    },
    sample: {
      source: sample.source,
      pairsFileSha256: sample.sha256,
      pairs: sample.pairs.length,
    },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
      node: process.version,
    },
    graph: {
      manifest: deployed.manifest,
      graphBuildId: deployed.graphBuildId,
      deployedGraphDirectory: graphDirectoryLabel,
      deployment: (await relocatedDeploymentNote()) ?? { deployment: '.geo-build/routing-graph' },
      extractSource: routingExtract.sourceId,
      deployedGraphContentBeforeRun: deployed.manifest.graphContentSha256,
      deployedGraphContentAfterRun: deployedGraphContentAfter,
      deployedDirectoryListingUnchanged:
        JSON.stringify(deployedListingAfter) === JSON.stringify(deployedListingBefore),
      extractSha256Recomputed: extractSha256,
      extractHeaderBbox: box,
    },
    extractTagStatistics: tagIndex.statistics,
    results,
    problems,
  };

  await mkdir(dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${redact(JSON.stringify(report, null, 2))}\n`, { flag: 'wx' });
  await rename(temporary, reportPath);
  console.log(
    JSON.stringify({
      graphBuildId: deployed.graphBuildId,
      results: results.map(
        (entry) =>
          `${String(entry.pairId)}:${String(entry.outcome)}${
            typeof entry.distanceMeters === 'number' ? `:${entry.distanceMeters}m` : ''
          }`,
      ),
      problems,
    }),
  );
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
