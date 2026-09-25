/**
 * M0-06b: coverage evidence set for an INDEPENDENT reviewer of Korean pedestrian routing.
 *
 *   node --import tsx scripts/probe-routing-korea-coverage.mts --execute
 *
 * Opt-in only, refuses to run in CI. It never calls an external routing service.
 *
 * What it does:
 * 1. Verifies the deployed graph under `.geo-build/routing-graph/foot` against its
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
 * What it does NOT do: it grades nothing. There is no expected outcome in this file and the
 * report has no pass field. A computed route is evidence that the graph had edges, not that
 * a person can walk there today. The coordinates are synthetic points at public landmarks
 * and contain no personal GPS data. The report carries no host paths and no host names.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, homedir, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { WalkingRouteRequest, WalkingRouteResult } from '../packages/contracts/src/routing.js';
import {
  RoutingRequestError,
  TenantAdmissionControl,
  WalkingRouteService,
  GraphHopperRoutingAdapter,
  createRoutingEngineEndpoint,
  hashGraphDirectory,
  haversineMeters,
  loadRoutingDeployment,
  loadVerifiedRoutingGraph,
} from '../packages/server/integrations/src/routing/index.js';
import {
  routingGraphConfig,
  routingGraphDirectory,
  startEngine,
  stopEngine,
  waitForEngine,
} from './build-routing-graph.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workRoot = join(repositoryRoot, '.geo-build');
const extractPath = join(workRoot, 'source', 'region.osm.pbf');
const jarPath = join(workRoot, 'graphhopper', 'graphhopper-web.jar');
const reportPath = join(
  repositoryRoot,
  'docs/implementation/research/m0-06b-routing-korea-coverage.json',
);

/** Ports away from the runbook's blue (8991) and green (8993) pair. */
const enginePorts = { application: 8997, admin: 8998 } as const;

/** Route segments closer than this to a tagged way segment, and parallel to it, count as on it. */
const wayMatchToleranceMeters = 1.5;
const wayMatchMaxAngleDegrees = 20;
/** A route vertex this close to a tagged node counts as passing it. */
const nodeMatchToleranceMeters = 1.0;

type Position = [number, number];

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
  readonly stratum: Stratum;
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
const samplePairs: readonly SamplePair[] = [
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

/** Array access that fails loudly instead of asserting. */
function item<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`INDEX_OUT_OF_RANGE: ${index}`);
  return value;
}

function parseArguments(argv: readonly string[]): { execute: true } | null {
  if (argv.length !== 1 || argv[0] !== '--execute') return null;
  return { execute: true };
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

// ---------------------------------------------------------------------------------------
// OSM tag index from the same extract
// ---------------------------------------------------------------------------------------

type Tags = Readonly<Record<string, string>>;

interface TaggedWay {
  readonly id: string;
  readonly tags: Tags;
  readonly coordinates: readonly Position[];
}

interface TaggedNode {
  readonly id: string;
  readonly tags: Tags;
  readonly position: Position;
}

interface TaggedArea {
  readonly id: string;
  readonly tags: Tags;
  /** Outer and inner rings of every polygon part. */
  readonly polygons: readonly (readonly (readonly Position[])[])[];
  readonly bbox: readonly [number, number, number, number];
}

const restrictiveValues = new Set([
  'no',
  'private',
  'restricted',
  'military',
  'emergency',
  'permit',
]);
const otherAccessValues = new Set([
  'destination',
  'customers',
  'delivery',
  'agricultural',
  'forestry',
  'discouraged',
]);

/**
 * How GraphHopper 10.0's foot access parser would read the way's `foot`/`access` tags.
 * The more specific key wins (`foot` before `access`). This is a label for the reviewer,
 * derived from the tags, not a statement about the ground.
 */
function accessClass(tags: Tags): string | null {
  const foot = tags.foot;
  const access = tags.access;
  if (foot === 'no') return 'foot=no';
  if (foot !== undefined && restrictiveValues.has(foot)) return `foot=${foot}`;
  if (access !== undefined && restrictiveValues.has(access))
    return foot === undefined ? `access=${access}` : `access=${access} with foot=${foot}`;
  if (foot !== undefined && otherAccessValues.has(foot)) return `foot=${foot}`;
  if (access !== undefined && otherAccessValues.has(access))
    return foot === undefined ? `access=${access}` : `access=${access} with foot=${foot}`;
  return null;
}

const reportedTagKeys = [
  'highway',
  'foot',
  'access',
  'sidewalk',
  'barrier',
  'indoor',
  'level',
  'tunnel',
  'bridge',
  'route',
  'landuse',
  'military',
  'sac_scale',
] as const;

function reportedTags(tags: Tags): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of reportedTagKeys) {
    const value = tags[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

function stringTags(properties: unknown): Tags {
  const tags: Record<string, string> = {};
  if (typeof properties !== 'object' || properties === null) return tags;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') tags[key] = value;
  }
  return tags;
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number'
  );
}

function positions(value: unknown): Position[] {
  return Array.isArray(value) ? value.filter(isPosition).map(([x, y]): Position => [x, y]) : [];
}

interface TagIndex {
  readonly ways: readonly TaggedWay[];
  readonly nodes: readonly TaggedNode[];
  readonly areas: readonly TaggedArea[];
  readonly statistics: Record<string, unknown>;
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
      if (accessClass(tags) !== null)
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
      if (klass !== null || tags.route === 'ferry') ways.push({ id, tags, coordinates });
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
  statistics['restricted or access-tagged nodes indexed'] = nodes.length;
  return { ways, nodes, areas, statistics };
}

// ---------------------------------------------------------------------------------------
// Geometry helpers for the tag check
// ---------------------------------------------------------------------------------------

const metersPerDegreeLatitude = 111_320;

/** Local planar projection around a latitude, in meters. Adequate for metre-scale checks. */
function project(position: Position, originLatitude: number): [number, number] {
  return [
    position[0] * metersPerDegreeLatitude * Math.cos((originLatitude * Math.PI) / 180),
    position[1] * metersPerDegreeLatitude,
  ];
}

function pointToSegmentMeters(point: Position, a: Position, b: Position): number {
  const [px, py] = project(point, point[1]);
  const [ax, ay] = project(a, point[1]);
  const [bx, by] = project(b, point[1]);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function bearingDegrees(a: Position, b: Position): number {
  const [ax, ay] = project(a, a[1]);
  const [bx, by] = project(b, a[1]);
  return (Math.atan2(by - ay, bx - ax) * 180) / Math.PI;
}

function parallel(first: number, second: number): boolean {
  const difference = Math.abs(first - second) % 180;
  return Math.min(difference, 180 - difference) <= wayMatchMaxAngleDegrees;
}

const cellDegrees = 0.001;
const cellKey = (x: number, y: number) =>
  `${Math.floor(x / cellDegrees)}:${Math.floor(y / cellDegrees)}`;

interface IndexedSegment {
  readonly way: TaggedWay;
  readonly a: Position;
  readonly b: Position;
}

function indexSegments(ways: readonly TaggedWay[]): Map<string, IndexedSegment[]> {
  const grid = new Map<string, IndexedSegment[]>();
  for (const way of ways)
    for (let index = 1; index < way.coordinates.length; index += 1) {
      const a = item(way.coordinates, index - 1);
      const b = item(way.coordinates, index);
      const keys = new Set<string>();
      const steps = Math.max(1, Math.ceil(haversineMeters(a, b) / 50));
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        keys.add(cellKey(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
      }
      for (const key of keys) {
        const bucket = grid.get(key) ?? [];
        bucket.push({ way, a, b });
        grid.set(key, bucket);
      }
    }
  return grid;
}

function neighbourKeys(position: Position): string[] {
  const x = Math.floor(position[0] / cellDegrees);
  const y = Math.floor(position[1] / cellDegrees);
  const keys: string[] = [];
  for (let dx = -1; dx <= 1; dx += 1)
    for (let dy = -1; dy <= 1; dy += 1) keys.push(`${x + dx}:${y + dy}`);
  return keys;
}

function ringContains(ring: readonly Position[], point: Position): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = item(ring, i);
    const [xj, yj] = item(ring, j);
    if (
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function areaContains(area: TaggedArea, point: Position): boolean {
  const [minX, minY, maxX, maxY] = area.bbox;
  if (point[0] < minX || point[0] > maxX || point[1] < minY || point[1] > maxY) return false;
  return area.polygons.some(
    (rings) =>
      rings[0] !== undefined &&
      ringContains(rings[0], point) &&
      !rings.slice(1).some((hole) => ringContains(hole, point)),
  );
}

interface TagCheck {
  readonly waysAlongRoute: {
    wayId: string;
    accessClass: string | null;
    tags: Record<string, string>;
    metersAlongRoute: number;
  }[];
  readonly nodesOnRoute: {
    nodeId: string;
    accessClass: string | null;
    tags: Record<string, string>;
  }[];
  readonly militaryAreasEntered: {
    areaId: string;
    tags: Record<string, string>;
    routeMetersInside: number;
  }[];
  readonly summary: {
    footNoMeters: number;
    accessPrivateOrNoWithoutFootOverrideMeters: number;
    accessRestrictedWithFootOverrideMeters: number;
    otherAccessValueMeters: number;
    ferryMeters: number;
    restrictedNodesPassed: number;
    militaryAreaMeters: number;
  };
}

function checkRouteTags(
  route: readonly Position[],
  index: TagIndex,
  grid: Map<string, IndexedSegment[]>,
): TagCheck {
  const alongWay = new Map<string, { way: TaggedWay; meters: number }>();
  const insideArea = new Map<string, { area: TaggedArea; meters: number }>();
  for (let i = 1; i < route.length; i += 1) {
    const a = item(route, i - 1);
    const b = item(route, i);
    const meters = haversineMeters(a, b);
    if (meters < 0.5) continue;
    const middle: Position = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const bearing = bearingDegrees(a, b);
    const matched = new Set<string>();
    for (const key of neighbourKeys(middle))
      for (const segment of grid.get(key) ?? []) {
        if (matched.has(segment.way.id)) continue;
        if (pointToSegmentMeters(middle, segment.a, segment.b) > wayMatchToleranceMeters) continue;
        if (!parallel(bearing, bearingDegrees(segment.a, segment.b))) continue;
        matched.add(segment.way.id);
        const entry = alongWay.get(segment.way.id) ?? { way: segment.way, meters: 0 };
        alongWay.set(segment.way.id, { way: entry.way, meters: entry.meters + meters });
      }
    for (const area of index.areas)
      if (areaContains(area, middle)) {
        const entry = insideArea.get(area.id) ?? { area, meters: 0 };
        insideArea.set(area.id, { area, meters: entry.meters + meters });
      }
  }
  const nodesOnRoute = index.nodes
    .filter((node) =>
      route.some(
        (vertex) =>
          Math.abs(vertex[0] - node.position[0]) < 0.0001 &&
          Math.abs(vertex[1] - node.position[1]) < 0.0001 &&
          haversineMeters(vertex, node.position) <= nodeMatchToleranceMeters,
      ),
    )
    .map((node) => ({
      nodeId: node.id,
      accessClass: accessClass(node.tags),
      tags: reportedTags(node.tags),
    }));

  const waysAlongRoute = [...alongWay.values()]
    .map(({ way, meters }) => ({
      wayId: way.id,
      accessClass: accessClass(way.tags),
      tags: reportedTags(way.tags),
      metersAlongRoute: Number(meters.toFixed(1)),
    }))
    .sort((x, y) => x.wayId.localeCompare(y.wayId));
  const sum = (predicate: (klass: string | null, tags: Record<string, string>) => boolean) =>
    Number(
      waysAlongRoute
        .filter((entry) => predicate(entry.accessClass, entry.tags))
        .reduce((total, entry) => total + entry.metersAlongRoute, 0)
        .toFixed(1),
    );
  const militaryAreasEntered = [...insideArea.values()].map(({ area, meters }) => ({
    areaId: area.id,
    tags: reportedTags(area.tags),
    routeMetersInside: Number(meters.toFixed(1)),
  }));
  return {
    waysAlongRoute,
    nodesOnRoute,
    militaryAreasEntered,
    summary: {
      footNoMeters: sum((klass) => klass === 'foot=no'),
      accessPrivateOrNoWithoutFootOverrideMeters: sum(
        (klass) => klass === 'access=private' || klass === 'access=no',
      ),
      accessRestrictedWithFootOverrideMeters: sum(
        (klass) => klass !== null && klass.startsWith('access=') && klass.includes(' with foot='),
      ),
      otherAccessValueMeters: sum(
        (klass) =>
          klass !== null &&
          klass !== 'foot=no' &&
          klass !== 'access=private' &&
          klass !== 'access=no' &&
          !klass.includes(' with foot='),
      ),
      ferryMeters: sum((_klass, tags) => tags.route === 'ferry'),
      restrictedNodesPassed: nodesOnRoute.length,
      militaryAreaMeters: Number(
        militaryAreasEntered
          .reduce((total, entry) => total + entry.routeMetersInside, 0)
          .toFixed(1),
      ),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Supplementary engine request: details and snap distances
// ---------------------------------------------------------------------------------------

const detailKeys = ['road_class', 'road_environment', 'road_access', 'surface'] as const;

interface EngineDetailView {
  readonly httpStatus: number;
  readonly engineMessage: string | null;
  readonly distanceMeters: number | null;
  readonly snapDistancesMeters: number[] | null;
  readonly metersByDetail: Record<string, Record<string, number>> | null;
}

async function engineDetailView(pair: SamplePair): Promise<EngineDetailView> {
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
  };
}

// ---------------------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    console.log(
      'Opt-in only: node --import tsx scripts/probe-routing-korea-coverage.mts --execute. ' +
        'Runs the self-hosted GraphHopper engine on loopback on a verified copy of the deployed graph ' +
        'and records an ungraded Korean coverage evidence set. Never use as CI.',
    );
    return;
  }
  if (process.env.CI) throw new Error('Routing engine runs are disabled in CI');
  for (const required of [extractPath, jarPath, routingGraphConfig, routingGraphDirectory]) {
    try {
      await stat(required);
    } catch {
      throw new Error(`MISSING_PREREQUISITE: ${required}`);
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'm0-06b-coverage-'));
  const redact = makeRedactor([scratch, workRoot, repositoryRoot, tmpdir(), homedir()]);
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
  await mkdir(graphCopy);
  for (const entry of await readdir(routingGraphDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`UNEXPECTED_GRAPH_ENTRY: ${entry.name}`);
    await copyFile(join(routingGraphDirectory, entry.name), join(graphCopy, entry.name));
  }
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
    for (const pair of samplePairs) {
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
      const detail = await engineDetailView(pair);
      const geometry = computed
        ? computed.geometry.coordinates.map(([x, y]): Position => [
            Number(x.toFixed(6)),
            Number(y.toFixed(6)),
          ])
        : null;
      results.push({
        pairId: pair.id,
        stratum: pair.stratum,
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
        tagCheck: geometry ? checkRouteTags(geometry, tagIndex, grid) : null,
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
    }
  } finally {
    await stopEngine(engine);
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
  if (results.length !== samplePairs.length)
    problems.push(`ran ${results.length}/${samplePairs.length} pairs`);
  if (!results.some((entry) => entry.outcome === 'route_computed'))
    problems.push('no pair produced a route, so the probe measured nothing');

  await rm(scratch, { recursive: true, force: true });

  const report = {
    schemaVersion: 1,
    node: 'M0-06b',
    executedAt: new Date().toISOString(),
    purpose:
      'Ungraded evidence set for an independent reviewer of Korean pedestrian routing coverage. Nothing in this file is a pass or a fail.',
    coverageReview: 'not_reviewed',
    method: {
      engine:
        'Pinned GraphHopper jar started on loopback through startEngine / graphhopperJavaArguments (runbook launch), on a byte-identical temporary copy of the deployed graph verified against the same manifest. The deployed directory under .geo-build was only read.',
      requestPath:
        'Production WalkingRouteService + GraphHopperRoutingAdapter (default limits: snap 120 m, deadline 8 s, 1,000,000 visited nodes). Admission window widened to 1000/60 s so one sequential run is not refused; concurrency 1.',
      supplementaryRequest:
        'One direct loopback /route request per pair with details road_class, road_environment, road_access, surface, used for snap distances of failed pairs and per-class metres. road_access is GraphHopper 10.0 car-oriented (motorcar, motor_vehicle, vehicle, access), not foot access.',
      tagCheck: `Ways tagged foot/access (and route=ferry), foot/access/barrier nodes and military areas exported from the same extract with osmium. A route segment counts as running along a way when its midpoint is within ${wayMatchToleranceMeters} m of a way segment and the directions differ by at most ${wayMatchMaxAngleDegrees} degrees. A route vertex within ${nodeMatchToleranceMeters} m of a tagged node counts as passing it. A military area counts when a route segment midpoint lies inside it. These are geometric matches against OSM tags, not ground truth.`,
      coordinates:
        'Synthetic, rounded points at public landmarks chosen by hand; approximate on purpose. No personal GPS data.',
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
      deployedGraphDirectory: '.geo-build/routing-graph/foot',
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
