/**
 * M2-01an: the cost of one S13 card list (`GET /courses/cards`) at the reference load —
 * 200 courses of 20,000 vertices each, the tenant and line maxima — before and after the
 * card read, measured in the same process against the same stored courses.
 *
 *   node --import tsx scripts/probe-course-cards-cost.mts --execute
 *
 * Opt-in, refuses CI. It starts its own PostgreSQL on a unix socket in a temporary directory
 * (no TCP port) and removes it afterwards; nothing external is called and no harness port is
 * bound. Every line is SYNTHETIC; no personal FIT or GPS is read. The elevation index is the
 * built dataset in `.geo-build/geo-data/elevation.json` when it is there (an OSM-derived build
 * artefact), which is what a deployed server would hold.
 *
 * "Before" is the route as M2-01k-a left it, reproduced here line for line: the list, then
 * every head read whole (four at a time, one tenant transaction each), then `courseCard`.
 * "After" is the route now: one `readCardSources` transaction and `courseCardFromSource`.
 * Both end in the same `courseCardListSchema.parse` and `JSON.stringify` the route's reply
 * goes through, and the two answers are compared for equality on every round.
 *
 * Measured per request: wall time, this process's CPU (user + system, `process.cpuUsage`) and
 * the CPU the cluster's server processes spent (from `ps`, summed over the postmaster's
 * children, 10 ms resolution). The rounds alternate before/after so both see the same machine
 * state, and the load average is recorded around every round. This is a single-caller
 * measurement on a shared desktop, not a load test and not a product budget.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { courseCardListSchema, type CourseCard } from '../packages/contracts/src/course-cards.ts';
import type { CourseGeneration, CourseReadResult } from '../packages/contracts/src/courses.ts';
import { elevationDatasetDocumentSchema } from '../packages/contracts/src/geo-data.ts';
import {
  courseCard,
  courseCardFromSource,
  courseCardVertexIndices,
} from '../packages/server/courses/src/course-cards.ts';
import {
  createElevationIndex,
  type ElevationIndex,
} from '../packages/server/courses/src/geo-data.ts';
import {
  COURSE_CARD_LINE_CHUNK,
  CourseNotFoundError,
  createCourseRepository,
  type CourseRepository,
  type PreparedCourseContent,
} from '../packages/server/persistence/src/courses.ts';
import { createDatabase, type Database } from '../packages/server/persistence/src/database.ts';
import { detectedBin, startDatabase } from './probe-routing-operational.mts';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const reportPath = join(repositoryRoot, 'docs/implementation/research/course-cards-cost.json');
const datasetPath = join(repositoryRoot, '.geo-build/geo-data/elevation.json');

const COURSES = 200;
const VERTICES = 20_000;
const ROUNDS = 5;
/** What the M2-01k-a route ran at once. */
const CARD_READ_CONCURRENCY = 4;

const imported: CourseGeneration = {
  kind: 'imported-file',
  format: 'gpx',
  sourceKind: 'gpx-trk',
  itemIndex: 0,
  parserId: 'gpx-track-v1',
  parserVersion: 1,
  fileSha256: 'a'.repeat(64),
  fileByteLength: 200,
  originalFilename: null,
  fileCreator: null,
  vertexCount: VERTICES,
  importedWaypointCount: 0,
  ignoredFileWaypointCount: 0,
};

/** A synthetic 20,000-vertex line, a few kilometres, with full-precision decimals. */
function line(courseIndex: number, origin: [number, number]): [number, number][] {
  const [longitude, latitude] = origin;
  return Array.from({ length: VERTICES }, (_, vertex) => [
    longitude + courseIndex * 1.1e-4 + vertex * 1.234567e-6 + Math.sin(vertex / 97) * 3.1e-5,
    latitude + courseIndex * 0.7e-4 + vertex * 5.4321987e-7 + Math.cos(vertex / 89) * 2.3e-5,
  ]);
}

function content(name: string, coordinates: [number, number][]): PreparedCourseContent {
  const first = coordinates[0] as [number, number];
  const last = coordinates[coordinates.length - 1] as [number, number];
  return {
    name,
    coordinates,
    waypoints: [
      { role: 'start', position: first, name: null, sourceSampleId: null, locked: false },
      { role: 'finish', position: last, name: null, sourceSampleId: null, locked: false },
    ],
    generation: imported,
    edit: { kind: 'imported' },
    lineage: [],
    distanceMeters: 4321.5,
    contentDigest: randomUUID().replaceAll('-', '').repeat(2),
  };
}

/** The M2-01k-a route body, as it was. */
async function cardsBefore(
  courses: CourseRepository,
  athleteId: string,
  elevation: ElevationIndex | null,
) {
  const list = await courses.list(athleteId);
  const cards: (CourseCard | null)[] = new Array<CourseCard | null>(list.courses.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < list.courses.length) {
      const index = next;
      next += 1;
      const head = list.courses[index];
      if (head === undefined) continue;
      if (head.status === 'unavailable') {
        cards[index] = courseCard({ status: 'unavailable', course: head }, elevation);
        continue;
      }
      let read: CourseReadResult;
      try {
        read = await courses.read(athleteId, head.courseId);
      } catch (error) {
        if (error instanceof CourseNotFoundError) {
          cards[index] = null;
          continue;
        }
        failed = true;
        throw error;
      }
      cards[index] = courseCard(read, elevation);
    }
  };
  await Promise.all(Array.from({ length: CARD_READ_CONCURRENCY }, () => worker()));
  const present = cards.filter((card): card is CourseCard => card !== null);
  return courseCardListSchema.parse({ cards: present, total: present.length });
}

/** The route body now. */
async function cardsAfter(
  courses: CourseRepository,
  athleteId: string,
  elevation: ElevationIndex | null,
) {
  const sources = await courses.readCardSources(athleteId, {
    vertexIndices: (vertexCount) => courseCardVertexIndices(vertexCount, elevation),
    region: elevation === null ? null : elevation.identity.bbox,
  });
  const cards = sources.map((source) => courseCardFromSource(source, elevation));
  return courseCardListSchema.parse({ cards, total: cards.length });
}

/** CPU seconds spent so far by the cluster's server processes (the postmaster's children). */
function clusterCpuSeconds(postmasterPid: number): number {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error('PS_FAILED');
  let total = 0;
  for (const row of listed.stdout.split('\n')) {
    const [pid, ppid, time] = row.trim().split(/\s+/);
    if (pid === undefined || time === undefined) continue;
    if (Number(ppid) !== postmasterPid && Number(pid) !== postmasterPid) continue;
    // [[hh:]mm:]ss.ss
    total += time
      .split(':')
      .map(Number)
      .reduce((sum, part) => sum * 60 + part, 0);
  }
  return total;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** The 5 s `statement_timeout` every tenant transaction sets (`database.ts`). */
const STATEMENT_TIMEOUT_MILLISECONDS = 5000;
/** Wall time of each card line statement (the ones that read `jsonb_to_recordset`). */
let lineStatementMilliseconds: number[] = [];

/** The same database, timing each card line statement. */
function timingLineStatements(database: Database): Database {
  return {
    ...database,
    tenant: (athleteId, operation) =>
      database.tenant(athleteId, (tx) =>
        operation({
          athleteId: tx.athleteId,
          query: async (sql, values) => {
            if (!sql.includes('jsonb_to_recordset')) return tx.query(sql, values);
            const started = performance.now();
            try {
              return await tx.query(sql, values);
            } finally {
              lineStatementMilliseconds.push(performance.now() - started);
            }
          },
        }),
      ),
  };
}

function lineStatementSummary() {
  const taken = lineStatementMilliseconds;
  lineStatementMilliseconds = [];
  return {
    count: taken.length,
    maxMilliseconds: Math.round(Math.max(0, ...taken)),
    totalMilliseconds: Math.round(taken.reduce((sum, value) => sum + value, 0)),
  };
}

async function measure(
  label: string,
  run: () => Promise<unknown>,
  postmasterPid: number,
): Promise<{
  label: string;
  wallMilliseconds: number;
  apiCpuMilliseconds: number;
  databaseCpuMilliseconds: number;
  responseBytes: number;
  loadAverageBefore: number[];
  loadAverageAfter: number[];
  body: unknown;
}> {
  const loadAverageBefore = loadavg().map(round3);
  const databaseBefore = clusterCpuSeconds(postmasterPid);
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const body = await run();
  const text = JSON.stringify(body);
  const wallMilliseconds = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const databaseAfter = clusterCpuSeconds(postmasterPid);
  return {
    label,
    wallMilliseconds: Math.round(wallMilliseconds),
    apiCpuMilliseconds: Math.round((cpu.user + cpu.system) / 1000),
    databaseCpuMilliseconds: Math.round((databaseAfter - databaseBefore) * 1000),
    responseBytes: Buffer.byteLength(text),
    loadAverageBefore,
    loadAverageAfter: loadavg().map(round3),
    body,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== '--execute')
    throw new Error('Opt-in only: node --import tsx scripts/probe-course-cards-cost.mts --execute');
  if (process.env['CI']) throw new Error('Cost probes are disabled in CI');
  if (detectedBin === undefined) throw new Error('PostgreSQL binaries unavailable; set PG_BIN');
  const loadAverageAtStart = loadavg().map(round3);

  const elevation = existsSync(datasetPath)
    ? createElevationIndex(
        elevationDatasetDocumentSchema.parse(JSON.parse(await readFile(datasetPath, 'utf8'))),
      )
    : null;
  const directory = await mkdtemp(join(tmpdir(), 'course-cards-cost-'));
  const cluster = await startDatabase(directory, detectedBin);
  const database = createDatabase({ connectionString: cluster.runtimeUrl, max: 8 });
  try {
    const postmasterPid = Number(
      (await readFile(join(directory, 'data', 'postmaster.pid'), 'utf8')).split('\n')[0],
    );
    const version = await cluster.admin.query('SHOW server_version');
    const timed = timingLineStatements(database);
    const courses = createCourseRepository(timed);
    // The shape the first review saw: every line in ONE statement. Measured only for the
    // statement-timeout comparison; it is not what the route runs.
    const unchunked = createCourseRepository(timed, { cardLineChunkCourses: COURSES });

    // Two tenants at the maximum: lines inside the elevation box (where the box question
    // stops at the first vertex) and lines wholly outside it (where it reads every vertex).
    const inside = randomUUID();
    const outside = randomUUID();
    const seedStarted = performance.now();
    for (let index = 0; index < COURSES; index += 1) {
      await courses.create(
        inside,
        content(`Synthetic ${index}`, line(index, [126.95, 37.5])),
        `seed-${randomUUID()}`,
      );
      await courses.create(
        outside,
        content(`Synthetic far ${index}`, line(index, [129.0, 35.1])),
        `seed-${randomUUID()}`,
      );
    }
    const seedMilliseconds = Math.round(performance.now() - seedStarted);
    const stored = await cluster.admin.query(
      `SELECT count(*)::int AS courses, sum(vertex_count)::bigint AS vertices,
         pg_size_pretty(pg_total_relation_size('course_revision')) AS revision_table
       FROM course_revision`,
    );

    const cases: {
      tenant: string;
      athleteId: string;
      elevation: ElevationIndex | null;
    }[] = [
      { tenant: 'inside-box', athleteId: inside, elevation },
      { tenant: 'outside-box', athleteId: outside, elevation },
      { tenant: 'inside-box-no-dataset', athleteId: inside, elevation: null },
    ];
    const results = [];
    for (const entry of cases) {
      // One unmeasured warm-up of each, so neither pays for first-use compilation or a cold
      // buffer cache the other then enjoys.
      await cardsBefore(courses, entry.athleteId, entry.elevation);
      await cardsAfter(courses, entry.athleteId, entry.elevation);
      const rounds = [];
      let cards = 0;
      for (let round = 0; round < ROUNDS; round += 1) {
        const order =
          round % 2 === 0 ? (['before', 'after'] as const) : (['after', 'before'] as const);
        const measured: Record<string, Awaited<ReturnType<typeof measure>>> = {};
        let lineStatements = lineStatementSummary();
        for (const label of order) {
          lineStatementSummary();
          measured[label] = await measure(
            label,
            () =>
              label === 'before'
                ? cardsBefore(courses, entry.athleteId, entry.elevation)
                : cardsAfter(courses, entry.athleteId, entry.elevation),
            postmasterPid,
          );
          if (label === 'after') lineStatements = lineStatementSummary();
        }
        const before = measured['before'];
        const after = measured['after'];
        if (before === undefined || after === undefined) throw new Error('ROUND_INCOMPLETE');
        const identical = isDeepStrictEqual(before.body, after.body);
        cards = courseCardListSchema.parse(after.body).total;
        if (!identical) throw new Error(`CARDS_DIFFER in ${entry.tenant} round ${round}`);
        rounds.push({
          round,
          order,
          identical,
          before: { ...before, body: undefined },
          after: { ...after, body: undefined, lineStatements },
        });
      }
      // One statement over every line, three times, for the timeout comparison only.
      const unchunkedStatements = [];
      for (let run = 0; run < 3; run += 1) {
        lineStatementSummary();
        const loadAverageBefore = loadavg().map(round3);
        const body = await cardsAfter(unchunked, entry.athleteId, entry.elevation);
        if (!isDeepStrictEqual(body, await cardsBefore(courses, entry.athleteId, entry.elevation)))
          throw new Error(`UNCHUNKED_CARDS_DIFFER in ${entry.tenant}`);
        unchunkedStatements.push({ loadAverageBefore, ...lineStatementSummary() });
      }
      const pick = (
        side: 'before' | 'after',
        key: 'wallMilliseconds' | 'apiCpuMilliseconds' | 'databaseCpuMilliseconds',
      ) => median(rounds.map((round) => round[side][key]));
      results.push({
        tenant: entry.tenant,
        elevationDataset: entry.elevation === null ? null : entry.elevation.identity.datasetId,
        cards,
        lineStatements: {
          chunkCourses: COURSE_CARD_LINE_CHUNK,
          statementTimeoutMilliseconds: STATEMENT_TIMEOUT_MILLISECONDS,
          worstChunkMilliseconds: Math.max(
            ...rounds.map((round) => round.after.lineStatements.maxMilliseconds),
          ),
          medianChunkMaxMilliseconds: median(
            rounds.map((round) => round.after.lineStatements.maxMilliseconds),
          ),
          unchunkedSingleStatement: unchunkedStatements,
        },
        median: {
          before: {
            wallMilliseconds: pick('before', 'wallMilliseconds'),
            apiCpuMilliseconds: pick('before', 'apiCpuMilliseconds'),
            databaseCpuMilliseconds: pick('before', 'databaseCpuMilliseconds'),
          },
          after: {
            wallMilliseconds: pick('after', 'wallMilliseconds'),
            apiCpuMilliseconds: pick('after', 'apiCpuMilliseconds'),
            databaseCpuMilliseconds: pick('after', 'databaseCpuMilliseconds'),
          },
        },
        rounds,
      });
      console.log(
        JSON.stringify({
          tenant: entry.tenant,
          median: results.at(-1)?.median,
          lineStatements: results.at(-1)?.lineStatements,
        }),
      );
    }

    const report = {
      probe: 'probe-course-cards-cost',
      node: 'M2-01an',
      measuredAt: new Date().toISOString(),
      command: 'node --import tsx scripts/probe-course-cards-cost.mts --execute',
      machine: {
        platform: process.platform,
        arch: process.arch,
        cpuModel: cpus()[0]?.model ?? null,
        logicalCpus: cpus().length,
        totalMemoryGiB: Math.round(totalmem() / 2 ** 30),
        node: process.version,
        postgres: version.rows[0]?.['server_version'] ?? null,
        loadAverageAtStart,
        loadAverageAtEnd: loadavg().map(round3),
      },
      fixture: {
        synthetic: true,
        coursesPerTenant: COURSES,
        verticesPerCourse: VERTICES,
        tenants: [
          'inside-box: lines inside the Seoul elevation box',
          'outside-box: lines near Busan, outside it',
        ],
        elevationDataset: elevation === null ? null : elevation.identity,
        stored: stored.rows[0],
        seedMilliseconds,
      },
      method: {
        rounds: ROUNDS,
        warmUpPerPath: 1,
        order: 'alternating before/after per round',
        before: 'list + head read of every course (4 at a time) + courseCard (M2-01k-a route)',
        after:
          'readCardSources (one tenant transaction, line statements of COURSE_CARD_LINE_CHUNK courses) + courseCardFromSource (M2-01an route)',
        lineStatements:
          'wall time of each line statement as the API sees it; worst chunk vs the 5 s statement_timeout; plus 3 runs with all 200 lines in one statement (the first-review shape) for comparison',
        bothEndIn: 'courseCardListSchema.parse + JSON.stringify',
        apiCpu: 'process.cpuUsage user+system of this process during the request',
        databaseCpu:
          'ps cputime of the private cluster (postmaster and children), 10 ms resolution',
        equality: 'isDeepStrictEqual(before, after) on every round; a difference aborts the probe',
      },
      results,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    const temporary = `${reportPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
    await rename(temporary, reportPath);
    console.log(`report: ${reportPath}`);
  } finally {
    await database.close();
    await cluster.stop();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
