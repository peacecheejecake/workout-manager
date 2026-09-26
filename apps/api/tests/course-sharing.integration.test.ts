import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityImport } from '@workout/contracts/activity';
import {
  courseDisclosurePreviewSchema,
  courseDisclosureReceiptSchema,
  courseShareCreatedSchema,
  courseShareListSchema,
  courseSharingLimits,
  sharedCourseSchema,
} from '@workout/contracts/course-sharing';
import { accountExportSchema } from '@workout/contracts/operations';
import type { CourseGeneration, CoursePosition, CourseWaypoint } from '@workout/contracts/courses';
import { courseContentDigest } from '@workout/server-courses/digest';
import {
  drawShareOffset,
  shareCircle,
  shareCircles,
  sharedLineTouchesCircle,
} from '@workout/server-courses/disclosure';
import { greatCircleMeters, segmentDistanceToPointMeters } from '@workout/server-courses/geo';
import { coordinateProbes, valueProbes } from '@workout/server-courses/log-audit';
import { privacyZoneSetDigest, type ProtectedCircle } from '@workout/server-courses/privacy-trim';
import { createLocalFilesystemObjectStorage } from '@workout/server-media/local-filesystem';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import { createActivityRepository } from '@workout/server-persistence/activities';
import { createActivityTrackRepository } from '@workout/server-persistence/activity-tracks';
import { createCoursePreferenceRepository } from '@workout/server-persistence/course-preferences';
import {
  createCourseSharingRepository,
  createSharedCourseReader,
  type SharedCourseReader,
} from '@workout/server-persistence/course-sharing';
import { createCourseRepository } from '@workout/server-persistence/courses';
import { createDatabase, type Database } from '@workout/server-persistence/database';
import { grantCourses, grantOperations, migrate } from '@workout/server-persistence/migrate';
import { createOperationsRepository } from '@workout/server-persistence/operations';

import { createApi } from '../src/app.js';
import type { CourseSharingConfiguration } from '../src/course-sharing.js';
import { confirmDisclosure, confirmedExport } from './course-disclosure-support.js';
import { auditRouteLogs } from './log-audit-support.js';

/**
 * M2-01k-o against real PostgreSQL: the privacy confirmation, the confirmed GPX and the
 * view-only link, through the real routes, the real repositories and migration 050.
 *
 * Every coordinate is synthetic (AGENTS.md: no personal FIT/GPS). The link tests build an
 * API with the flag ON — the test environment's choice (§8); the shipped default is off and
 * is asserted here too (T9).
 */
const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
const runtimeUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl || !runtimeUrl)
  throw new Error('Isolated real PostgreSQL required: run pnpm test:integration');

const admin = new Pool({ connectionString: adminUrl });
let database: Database;
let storage: ObjectStorage;
let objectRoot: string;
const readers: SharedCourseReader[] = [];

const csrfToken = 'c'.repeat(43);
const headers = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};

// ── Synthetic geometry ─────────────────────────────────────────────────────────────────

const home: CoursePosition = [127.02, 37.5];
const METERS_PER_DEGREE = (Math.PI / 180) * 6_371_008.8;
const at = (east: number, north: number): CoursePosition => {
  const longitude = home[0] + east / (METERS_PER_DEGREE * Math.cos((home[1] * Math.PI) / 180));
  const latitude = home[1] + north / METERS_PER_DEGREE;
  return [Number(longitude.toFixed(8)), Number(latitude.toFixed(8))];
};
const leg = (
  from: readonly [number, number],
  to: readonly [number, number],
  step: number,
): CoursePosition[] => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.max(1, Math.round(length / step));
  return Array.from({ length: count }, (_, index) =>
    at(
      from[0] + ((to[0] - from[0]) * index) / count,
      from[1] + ((to[1] - from[1]) * index) / count,
    ),
  );
};

/** Home → 1.5 km east → 600 m north → back west → south into home: both ends inside. */
const loop: CoursePosition[] = [
  ...leg([0, 0], [1500, 0], 2),
  ...leg([1500, 0], [1500, 600], 50),
  ...leg([1500, 600], [0, 600], 25),
  ...leg([0, 600], [0, 0], 2),
  at(0, 0),
];
/** Nowhere near home. */
const elsewhere: CoursePosition[] = leg([5000, 5000], [6500, 5200], 20).concat([at(6500, 5200)]);
/** Straight through home: the middle re-enters, which no trim can fix (D3). */
const through: CoursePosition[] = leg([-1500, 0], [1500, 0], 20).concat([at(1500, 0)]);

function waypointsOf(line: readonly CoursePosition[], names = true): CourseWaypoint[] {
  const start = line[0];
  const finish = line[line.length - 1];
  // Halfway along: on the loop that is 1.1 km out, past the 2.5 · S continuation cut a link
  // makes at its start (M2-01as), so a named via is still on the line a link shows.
  const middle = line[Math.floor(line.length / 2)];
  if (!start || !finish || !middle) throw new Error('empty line');
  return [
    {
      role: 'start',
      position: start,
      name: names ? '우리 집 현관' : null,
      sourceSampleId: null,
      locked: false,
    },
    {
      role: 'via',
      position: middle,
      name: names ? '공원 입구' : null,
      sourceSampleId: null,
      locked: false,
    },
    { role: 'finish', position: finish, name: null, sourceSampleId: null, locked: false },
  ];
}

const homeZone = { name: '집', center: home, radiusMeters: 200 } as const;

function isOutside(
  line: {
    coordinates: readonly CoursePosition[];
    waypoints: readonly { position: CoursePosition }[];
  },
  circles: readonly ProtectedCircle[],
): boolean {
  for (const circle of circles) {
    if (line.coordinates.some((p) => greatCircleMeters(circle.center, p) <= circle.radiusMeters))
      return false;
    if (
      line.waypoints.some(
        (w) => greatCircleMeters(circle.center, w.position) <= circle.radiusMeters,
      )
    )
      return false;
    for (let index = 1; index < line.coordinates.length; index += 1) {
      const from = line.coordinates[index - 1];
      const to = line.coordinates[index];
      if (
        from &&
        to &&
        segmentDistanceToPointMeters(from, to, circle.center) <= circle.radiusMeters
      )
        return false;
    }
  }
  return true;
}

/** Parse a GPX document's route points and waypoints (the writer's own simple shape). */
function gpxPoints(document: string) {
  const read = (pattern: RegExp) =>
    [...document.matchAll(pattern)].map(
      (match) => [Number(match[2]), Number(match[1])] as CoursePosition,
    );
  return {
    coordinates: read(/<rtept lat="([-0-9.]+)" lon="([-0-9.]+)"/g),
    waypoints: read(/<wpt lat="([-0-9.]+)" lon="([-0-9.]+)"/g).map((position) => ({ position })),
  };
}

// ── Composition ────────────────────────────────────────────────────────────────────────

let signedIn = '';
const plantedTokens: string[] = [];
const logs = auditRouteLogs(() => [
  ...valueProbes('token', [csrfToken, 'session=fixture', ...plantedTokens]),
  ...valueProbes(
    'token',
    plantedTokens.map((token) => createHash('sha256').update(token).digest('hex')),
  ),
  ...coordinateProbes([home, ...loop.slice(0, 5), ...loop.slice(-5)]),
  ...valueProbes('body', ['우리 집 현관', '공원 입구']),
]);

function sharingOn(epoch = 1, trustedProxies: readonly string[] = []): CourseSharingConfiguration {
  return { enabled: true, epoch, rateKey: Buffer.alloc(32, 7), trustedProxies };
}

function reader(limits?: Parameters<typeof createSharedCourseReader>[0]['limits']) {
  const created = createSharedCourseReader({
    connectionString: runtimeUrl as string,
    ...(limits ? { limits } : {}),
  });
  readers.push(created);
  return created;
}

function makeApp(
  options: { sharing?: CourseSharingConfiguration; reader?: SharedCourseReader } = {},
) {
  const courses = createCourseRepository(database);
  return createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () => ({
        athleteId: signedIn,
        sessionId: 'current',
        csrfToken,
        method: 'cookie' as const,
      }),
    },
    consent: {
      getConsent: async () => ({ kind: 'ai' as const, granted: false, revision: 0 }),
      setConsent: async () => ({ kind: 'ai' as const, granted: false, revision: 0 }),
    },
    operations: createOperationsRepository(database),
    courses: { courses, tracks: createActivityTrackRepository(database), storage },
    courseExtras: {
      courses,
      preferences: createCoursePreferenceRepository(database, {
        drawShareOffset: () => drawShareOffset(),
        shareTouchesNewZone: (snapshot, zone, offset) =>
          shareCircles(zone, offset).some((circle) => sharedLineTouchesCircle(snapshot, circle)),
      }),
    },
    courseDisclosure: {
      sharing: createCourseSharingRepository(database),
      ...(options.sharing?.enabled ? { links: { epoch: options.sharing.epoch } } : {}),
    },
    ...(options.sharing ? { courseSharing: options.sharing } : {}),
    ...(options.reader ? { sharedCourseReader: options.reader } : {}),
    ...logs.options(),
  });
}

const apps: ReturnType<typeof createApi>[] = [];
function app(options: Parameters<typeof makeApp>[0] = {}) {
  const created = makeApp(options);
  apps.push(created);
  return created;
}
function linkApp(epoch = 1, trustedProxies: readonly string[] = []) {
  return app({ sharing: sharingOn(epoch, trustedProxies), reader: reader() });
}

const usedAddresses = new Set<string>();
/**
 * A fresh client address per scenario, so one scenario's counters never limit another.
 * Random rather than counted: counters live for up to two hours, and a database reused
 * between runs must not hand one run's failures to the next.
 */
const freshAddress = (): string => {
  const bytes = createHash('sha256').update(randomUUID()).digest();
  const address = `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
  if (usedAddresses.has(address)) return freshAddress();
  usedAddresses.add(address);
  return address;
};

beforeAll(async () => {
  await migrate(adminUrl);
  await admin.query('GRANT USAGE ON SCHEMA public TO workout_runtime');
  await grantOperations(adminUrl, 'workout_runtime');
  await grantCourses(adminUrl, 'workout_runtime');
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON activity_canonical,activity_source_head,
     activity_source_revision,activity_overlay,activity_overlay_revision,activity_suppression,
     activity_import_receipt TO workout_runtime`,
  );
  database = createDatabase({ connectionString: runtimeUrl, max: 8 });
  objectRoot = await mkdtemp(join(tmpdir(), 'course-sharing-'));
  storage = await createLocalFilesystemObjectStorage(objectRoot);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

afterAll(async () => {
  await Promise.all(readers.map((instance) => instance.close()));
  await database?.close();
  await admin.end();
  if (objectRoot) await rm(objectRoot, { recursive: true, force: true });
});

// ── Fixtures ───────────────────────────────────────────────────────────────────────────

const hashOf = (value: string) => createHash('sha256').update(value).digest('hex');

async function ownerWithCourse(
  line: readonly CoursePosition[] = loop,
  options: {
    name?: string;
    zones?: readonly { name: string; center: CoursePosition; radiusMeters: number }[];
    lineage?: { activityId: string };
    generation?: CourseGeneration;
  } = {},
) {
  const athleteId = randomUUID();
  signedIn = athleteId;
  const courseId = await addCourse(athleteId, line, options);
  const preferences = createCoursePreferenceRepository(database, {
    // A fixed offset for the fixture areas: with δ ≤ 1 · S (M2-01as) about one offset in a
    // thousand makes the `loop` fixture graze its own share circle and be refused
    // (LINE_CROSSES_AREA), which would make these scenarios flaky rather than wrong. Offsets
    // themselves are tested where they are the subject (the domain suite, T22).
    drawShareOffset: () => ({ x: 0.6, y: -0.5 }),
    shareTouchesNewZone: (snapshot, zone, offset) =>
      shareCircles(zone, offset).some((circle) => sharedLineTouchesCircle(snapshot, circle)),
  });
  for (const zone of options.zones ?? [homeZone])
    await preferences.createPrivacyZone(athleteId, zone);
  return { athleteId, courseId };
}

async function addCourse(
  athleteId: string,
  line: readonly CoursePosition[],
  options: { name?: string; lineage?: { activityId: string }; generation?: CourseGeneration } = {},
) {
  const name = options.name ?? '한강 둘레길';
  const coordinates = [...line];
  const waypoints = waypointsOf(coordinates);
  const generation: CourseGeneration = options.generation ?? {
    kind: 'imported-file' as const,
    format: 'gpx' as const,
    sourceKind: 'gpx-rte' as const,
    itemIndex: 0,
    parserId: 'gpx-track-v1' as const,
    parserVersion: 1 as const,
    fileSha256: hashOf(randomUUID()),
    fileByteLength: 320,
    originalFilename: null,
    fileCreator: null,
    vertexCount: coordinates.length,
    importedWaypointCount: 0,
    ignoredFileWaypointCount: 0,
  };
  const lineage = options.lineage
    ? [{ activityId: options.lineage.activityId, trackId: randomUUID(), trackRevision: 1 }]
    : [];
  const created = await createCourseRepository(database).create(
    athleteId,
    {
      name,
      coordinates,
      waypoints,
      generation,
      edit: { kind: 'imported' },
      lineage,
      distanceMeters: 4_000,
      contentDigest: courseContentDigest({ name, coordinates, waypoints, generation, lineage }),
    },
    `course-${randomUUID()}`,
  );
  if (created.status !== 'available') throw new Error('course not created');
  return created.course.courseId;
}

async function makeLink(
  instance: ReturnType<typeof createApi>,
  courseId: string,
  options: { includeNames?: boolean; expiresInDays?: number } = {},
) {
  const { confirmation } = await confirmDisclosure(instance, headers, courseId, {
    purpose: 'share',
    ...(options.includeNames === undefined ? {} : { includeNames: options.includeNames }),
  });
  expect(confirmation.statusCode).toBe(200);
  const receipt = courseDisclosureReceiptSchema.parse(confirmation.json());
  const created = await instance.inject({
    method: 'POST',
    url: `/bff/v1/courses/${courseId}/shares`,
    headers,
    payload: {
      receiptId: receipt.receiptId,
      ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }),
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const parsed = courseShareCreatedSchema.parse(created.json());
  plantedTokens.push(parsed.token);
  return parsed;
}

function read(
  instance: ReturnType<typeof createApi>,
  payload: unknown,
  address = freshAddress(),
  extraHeaders: Record<string, string> = {},
) {
  return instance.inject({
    method: 'POST',
    url: '/bff/v1/shared/course',
    remoteAddress: address,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

async function shareCirclesOf(athleteId: string): Promise<ProtectedCircle[]> {
  const rows = await admin.query(
    `SELECT z.center_longitude,z.center_latitude,z.radius_meters,o.offset_x,o.offset_y
     FROM course_privacy_zone z JOIN course_privacy_zone_share_offset o
       ON o.athlete_id=z.athlete_id AND o.zone_id=z.zone_id WHERE z.athlete_id=$1`,
    [athleteId],
  );
  return rows.rows.map((row) =>
    shareCircle(
      {
        center: [Number(row['center_longitude']), Number(row['center_latitude'])],
        radiusMeters: Number(row['radius_meters']),
      },
      { x: Number(row['offset_x']), y: Number(row['offset_y']) },
    ),
  );
}

async function countRows(table: string, athleteId: string) {
  const result = await admin.query(
    `SELECT count(*)::integer AS n FROM ${table} WHERE athlete_id=$1`,
    [athleteId],
  );
  return Number(result.rows[0]?.['n']);
}

// ── A. The owner's GPX behind a confirmation ───────────────────────────────────────────

describe('A. the owner GPX export is gated by a server-side confirmation', () => {
  it('T1: gives no GPX body without a receipt, with a made-up one, or with another course one', async () => {
    const { athleteId, courseId } = await ownerWithCourse(elsewhere);
    const other = await addCourse(athleteId, elsewhere, { name: '다른 코스' });
    const instance = app();
    for (const url of [
      `/bff/v1/courses/${courseId}/export.gpx`,
      `/bff/v1/courses/${courseId}/export.gpx?receipt=${randomUUID()}`,
    ]) {
      const response = await instance.inject({ method: 'GET', url, headers });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe('COURSE_EXPORT_NOT_CONFIRMED');
      expect(response.body).not.toContain('<gpx');
    }
    const { receipt } = await confirmedExport(instance, headers, other);
    const crossed = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx?receipt=${receipt.receiptId}`,
      headers,
    });
    expect(crossed.statusCode).toBe(409);
    const stranger = randomUUID();
    signedIn = stranger;
    const foreign = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx?receipt=${receipt.receiptId}`,
      headers,
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('T3: the default trimmed GPX has no vertex, waypoint or segment in a protected area', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = app();
    const { preview } = await confirmDisclosure(instance, headers, courseId);
    expect(preview.outcome).toBe('ends-inside');
    expect(preview.defaultExposure).toBe('trimmed');
    expect(preview.options.map((option) => option.exposure)).toEqual(['trimmed', 'owner-exact']);
    expect(preview.zones).toEqual([{ name: '집', removedVertexCount: expect.any(Number) }]);
    // The areas by name and count, never a centre (§5 item 3).
    expect(JSON.stringify(preview)).not.toMatch(/center|offset/i);
    const { receipt, response } = await confirmedExport(instance, headers, courseId);
    expect(response.statusCode).toBe(200);
    // R-10: the confirmation appended a trimmed revision; the receipt is for it.
    expect(receipt.courseRevision).toBe(preview.courseRevision + 1);
    const detail = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}`,
      headers,
    });
    expect(detail.json().revision.generation.kind).toBe('privacy-trimmed');
    const document = response.body;
    const points = gpxPoints(document);
    expect(points.coordinates.length).toBeGreaterThan(10);
    expect(isOutside(points, [{ center: home, radiusMeters: 200 }])).toBe(true);
    for (const match of document.matchAll(/(?:lat|lon)="(-?\d+\.(\d+))"/g))
      expect(match[2]).toHaveLength(5);
  });

  it('T20(1): the exact line only after the explicit warning, and then exactly', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = app();
    const refused = await confirmDisclosure(instance, headers, courseId, {
      exposure: 'owner-exact',
      acknowledgedRisk: false,
    });
    expect(refused.confirmation.statusCode).toBe(409);
    expect(refused.confirmation.json().error.code).toBe('COURSE_EXPORT_NOT_CONFIRMED');
    const { response } = await confirmedExport(instance, headers, courseId, {
      exposure: 'owner-exact',
      acknowledgedRisk: true,
    });
    expect(response.statusCode).toBe(200);
    const points = gpxPoints(response.body);
    expect(points.coordinates[0]).toEqual([
      Number(loop[0]?.[0].toFixed(7)),
      Number(loop[0]?.[1].toFixed(7)),
    ]);
    expect(points.coordinates.at(-1)).toEqual([
      Number(loop.at(-1)?.[0].toFixed(7)),
      Number(loop.at(-1)?.[1].toFixed(7)),
    ]);
    expect(points.coordinates).toHaveLength(loop.length);
  });

  it('T21: no protected area — a warning to tick, then the exact ends; never before', async () => {
    const { courseId } = await ownerWithCourse(loop, { zones: [] });
    const instance = app();
    const { preview, confirmation } = await confirmDisclosure(instance, headers, courseId, {
      acknowledgedRisk: false,
    });
    expect(preview.outcome).toBe('no-zones');
    expect(preview.options).toEqual([
      expect.objectContaining({ exposure: 'no-zones-exact', requiresAcknowledgement: true }),
    ]);
    expect(confirmation.statusCode).toBe(409);
    expect(confirmation.json().error.code).toBe('COURSE_EXPORT_NOT_CONFIRMED');
    const before = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx`,
      headers,
    });
    expect(before.statusCode).toBe(409);
    const { response } = await confirmedExport(instance, headers, courseId);
    expect(response.statusCode).toBe(200);
    const points = gpxPoints(response.body);
    expect(points.coordinates[0]).toEqual([Number(home[0].toFixed(5)), Number(home[1].toFixed(5))]);
    expect(points.coordinates.at(-1)).toEqual([
      Number(home[0].toFixed(5)),
      Number(home[1].toFixed(5)),
    ]);
  });

  it('T17: a refused trim is blocked by name, for the preview, the confirmation and the GPX', async () => {
    const { courseId } = await ownerWithCourse(through);
    const instance = linkApp();
    const preview = courseDisclosurePreviewSchema.parse(
      (
        await instance.inject({
          method: 'GET',
          url: `/bff/v1/courses/${courseId}/disclosure-preview?purpose=export`,
          headers,
        })
      ).json(),
    );
    expect(preview).toMatchObject({
      outcome: 'blocked',
      blockedReason: 'COURSE_TRIM_SPLITS_THE_LINE',
      options: [],
    });
    for (const purpose of ['export', 'share'] as const)
      for (const exposure of ['trimmed', 'no-zone-intersection'] as const) {
        const confirmation = await instance.inject({
          method: 'POST',
          url: `/bff/v1/courses/${courseId}/disclosure-confirmations`,
          headers: { ...headers, 'idempotency-key': `confirm-${randomUUID()}` },
          payload: {
            purpose,
            expectedRevision: preview.courseRevision,
            acknowledgedZoneSetDigest: preview.zoneSetDigest,
            exposure,
            includeNames: false,
            acknowledgedRisk: true,
          },
        });
        expect(confirmation.statusCode).toBe(409);
        expect(confirmation.json().error.code).toBe('COURSE_EXPORT_BLOCKED');
      }
    const gpx = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx`,
      headers,
    });
    expect(gpx.statusCode).toBe(409);
    expect(gpx.json().error.code).toBe('COURSE_EXPORT_BLOCKED');
    expect(await countRows('course_disclosure_receipt', signedIn)).toBe(0);
    expect(await countRows('course_share', signedIn)).toBe(0);
  });

  it('T7: a protected area added after the confirmation makes the receipt unusable', async () => {
    const { athleteId, courseId } = await ownerWithCourse(elsewhere);
    const instance = app();
    const { confirmation } = await confirmDisclosure(instance, headers, courseId);
    const receipt = courseDisclosureReceiptSchema.parse(confirmation.json());
    await createCoursePreferenceRepository(database).createPrivacyZone(athleteId, {
      name: '회사',
      center: at(9000, 9000),
      radiusMeters: 100,
    });
    const response = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx?receipt=${receipt.receiptId}`,
      headers,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('COURSE_EXPORT_NOT_CONFIRMED');
  });

  it('T8/T18: the GPX carries names by default, none when turned off, and no identity at all', async () => {
    const { courseId } = await ownerWithCourse(elsewhere, { name: '비밀 공원 한 바퀴' });
    const instance = app();
    const named = await confirmedExport(instance, headers, courseId);
    expect(named.response.body).toContain('<metadata>\n    <name>비밀 공원 한 바퀴</name>');
    expect(named.response.body).toContain('<name>공원 입구</name>');
    expect(named.response.headers['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('비밀-공원-한-바퀴.gpx')}`,
    );
    const nameless = await confirmedExport(instance, headers, courseId, { includeNames: false });
    expect(nameless.response.body).not.toContain('<name>');
    expect(nameless.response.body).not.toContain('<metadata>');
    expect(nameless.response.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''course.gpx",
    );
    for (const { response } of [named, nameless]) {
      expect(response.body).not.toContain(courseId);
      expect(response.body).not.toContain('<desc>');
      expect(response.body).not.toContain('<time>');
      expect(response.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(response.body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(response.body).not.toContain('workout-manager');
      expect(String(response.headers['content-disposition'])).not.toMatch(/-r\d+\.gpx|revision/);
    }
  });

  it('T13: the account export needs no confirmation and carries link facts only (v23)', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const { token } = await makeLink(instance, courseId);
    const exported = await instance.inject({
      method: 'POST',
      url: '/bff/v1/operations/export',
      headers,
    });
    expect(exported.statusCode).toBe(200);
    const artifact = accountExportSchema.parse(exported.json());
    if (artifact.schemaVersion !== 24) throw new Error('expected v24');
    expect(artifact.data.courseShares).toHaveLength(1);
    expect(Object.keys(artifact.data.courseShares[0] ?? {}).sort()).toEqual(
      [
        'course_id',
        'course_revision',
        'created_at',
        'expires_at',
        'include_names',
        'revoke_reason',
        'revoked_at',
        'share_id',
        'state',
      ].sort(),
    );
    expect(artifact.data.coursePrivacyZoneShareOffsets).toHaveLength(1);
    // The offset leaves only here, and whole: the zone it belongs to, both components as
    // stored, and when it was drawn — nothing else.
    const storedOffset = await admin.query(
      `SELECT zone_id,offset_x,offset_y,created_at FROM course_privacy_zone_share_offset
       WHERE athlete_id=$1`,
      [athleteId],
    );
    const exportedOffset = artifact.data.coursePrivacyZoneShareOffsets[0] ?? {};
    expect(Object.keys(exportedOffset).sort()).toEqual(
      ['created_at', 'offset_x', 'offset_y', 'zone_id'].sort(),
    );
    expect(exportedOffset).toEqual({
      zone_id: storedOffset.rows[0]?.['zone_id'],
      offset_x: storedOffset.rows[0]?.['offset_x'],
      offset_y: storedOffset.rows[0]?.['offset_y'],
      created_at: expect.any(String),
    });
    expect(Date.parse(String(exportedOffset['created_at']))).toBe(
      (storedOffset.rows[0]?.['created_at'] as Date).getTime(),
    );
    // M2-01ao's course-deletion ledger travels in v23 too: course id and time, nothing else.
    const gone = await addCourse(athleteId, loop, { name: '지운 코스' });
    expect(
      (
        await instance.inject({
          method: 'DELETE',
          url: `/bff/v1/courses/${gone}?expectedRevision=1`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    const after = accountExportSchema.parse(
      (await instance.inject({ method: 'POST', url: '/bff/v1/operations/export', headers })).json(),
    );
    if (after.schemaVersion !== 24) throw new Error('expected v24');
    expect(after.data.courseDeletions).toEqual([
      { course_id: gone, deleted_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    expect(JSON.stringify(after.data.courseDeletions)).not.toContain('지운 코스');
    // The ledger stays unreadable as a table for the runtime role (049's rule); the export's
    // definer function hands out the session tenant's rows and nobody else's.
    const stranger = randomUUID();
    const strangerView = await database.tenant(stranger, (tx) =>
      tx.query('SELECT course_id FROM public.export_course_deletions()'),
    );
    expect(strangerView.rows).toEqual([]);
    const ownView = await database.tenant(athleteId, (tx) =>
      tx.query('SELECT course_id FROM public.export_course_deletions()'),
    );
    expect(ownView.rows).toEqual([{ course_id: gone }]);
    await expect(
      database.tenant(athleteId, (tx) => tx.query('SELECT * FROM course_deletion')),
    ).rejects.toMatchObject({ code: '42501' });
    const body = exported.body;
    expect(body).not.toContain(token);
    expect(body).not.toContain(hashOf(token));
    const stored = await admin.query('SELECT token_digest FROM course_share WHERE athlete_id=$1', [
      athleteId,
    ]);
    expect(body).not.toContain(String(stored.rows[0]?.['token_digest']));
  });
});

// ── T9: the flag is off by default ─────────────────────────────────────────────────────

describe('T9: with the flag off (the shipped default) there is no link at all', () => {
  it('registers no link route, offers no share confirmation and serves no link', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const on = linkApp();
    const { token } = await makeLink(on, courseId);
    const off = app();
    await Promise.all([off.ready(), on.ready()]);
    for (const [method, url] of [
      ['GET', '/bff/v1/courses/shares'],
      ['POST', '/bff/v1/courses/:courseId/shares'],
      ['POST', '/bff/v1/courses/shares/:shareId/revoke'],
      ['POST', '/bff/v1/courses/shares/revoke-all'],
    ] as const) {
      expect(off.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
      // The same patterns exist with the flag on, so "false" above is not a typo in a path.
      expect(on.hasRoute({ method, url }), `${method} ${url}`).toBe(true);
    }
    const preview = await off.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/disclosure-preview?purpose=share`,
      headers,
    });
    expect(preview.statusCode).toBe(404);
    const served = await read(off, { token });
    expect(served.statusCode).toBe(404);
    expect(served.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    // A (the export gate) does not depend on the flag.
    expect((await confirmedExport(off, headers, courseId)).response.statusCode).toBe(200);
    // …and the same link is served again by an instance with the flag on.
    expect((await read(on, { token })).statusCode).toBe(200);
  });
});

// ── B. The view-only link ──────────────────────────────────────────────────────────────

const sharedKeys = ['coordinates', 'distanceMeters', 'expiresOn', 'waypoints'];

describe('B. the view-only link', () => {
  it('discloses routing data on a shared computed course, including without a basemap', async () => {
    const { courseId } = await ownerWithCourse(loop, {
      generation: {
        kind: 'routed-waypoints',
        computation: {
          schemaVersion: 1,
          requestId: 'share-disclosure-fixture',
          requestRevision: 1,
          graph: {
            engine: 'graphhopper',
            identitySource: 'engine',
            engineVersion: '10.0',
            engineArtifactSha256: 'a'.repeat(64),
            profileId: 'foot-v1',
            profileConfigSha256: 'b'.repeat(64),
            extractSha256: 'c'.repeat(64),
            extractRegion: 'seoul',
            graphContentSha256: 'd'.repeat(64),
            graphBuildId: '0123456789abcdef',
            graphImportedAt: '2026-03-01T00:00:00.000Z',
            roadDataAt: '2026-02-01T00:00:00.000Z',
          },
          conditions: {
            profileId: 'foot-v1',
            algorithm: 'flexible',
            contractionHierarchies: false,
            maxVisitedNodes: 1_000_000,
            deadlineMilliseconds: 8_000,
            snapLimitMeters: 120,
            waypointCount: 3,
          },
          computedAt: '2026-03-02T00:00:00.000Z',
          computationMilliseconds: 42,
          warnings: [],
        },
        engineDistanceMeters: 4_000,
        engineDurationSeconds: 2_000,
        maxSnapDistanceMeters: 4,
        waypointCount: 3,
        vertexCount: loop.length,
      },
    });
    const instance = linkApp();
    const { token } = await makeLink(instance, courseId);
    const response = await read(instance, { token });
    expect(response.statusCode).toBe(200);
    expect(sharedCourseSchema.parse(response.json()).routeDataNotice).toBe(true);
    expect(Object.keys(response.json()).sort()).toEqual([...sharedKeys, 'routeDataNotice'].sort());
    expect(response.body).not.toContain('0123456789abcdef');
  });

  it('T3/T25: serves a snapshot outside every share circle, rounded to five places', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const preview = courseDisclosurePreviewSchema.parse(
      (
        await instance.inject({
          method: 'GET',
          url: `/bff/v1/courses/${courseId}/disclosure-preview?purpose=share`,
          headers,
        })
      ).json(),
    );
    // D3b: the link flow never offers the exact line.
    expect(preview.options.map((option) => option.exposure)).toEqual(['trimmed']);
    expect(preview.includeNamesDefault).toBe(false);
    const { token } = await makeLink(instance, courseId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const response = await read(instance, { token });
    expect(response.statusCode).toBe(200);
    const shared = sharedCourseSchema.parse(response.json());
    const circles = await shareCirclesOf(athleteId);
    expect(circles).toHaveLength(1);
    expect(isOutside(shared, circles)).toBe(true);
    expect(isOutside(shared, [{ center: home, radiusMeters: 200 }])).toBe(true);
    for (const position of [...shared.coordinates, ...shared.waypoints.map((w) => w.position)])
      for (const ordinate of position) expect(Math.round(ordinate * 1e5) / 1e5).toBe(ordinate);
    // R-3: the ends are the line's own ends, whether or not they were cut.
    expect(shared.waypoints[0]?.position).toEqual(shared.coordinates[0]);
    expect(shared.waypoints.at(-1)?.position).toEqual(shared.coordinates.at(-1));
    // B-1: the share snapshot is kept beside the ledger; no revision was appended.
    const detail = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}`,
      headers,
    });
    expect(detail.json().course.headRevision).toBe(1);
  });

  it('T8/T18: answers with the allowlist only — no names unless kept, no id, time or trim fact', async () => {
    const { courseId } = await ownerWithCourse(loop, { name: '비밀 공원 한 바퀴' });
    const instance = linkApp();
    const hidden = await makeLink(instance, courseId);
    const response = await read(instance, { token: hidden.token });
    expect(Object.keys(response.json()).sort()).toEqual(sharedKeys);
    for (const waypoint of response.json().waypoints)
      expect(Object.keys(waypoint).sort()).toEqual(['position', 'role']);
    expect(response.body).not.toContain('비밀');
    expect(response.body).not.toContain('공원 입구');
    expect(response.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    expect(response.body).not.toMatch(/[a-f0-9]{64}/);
    expect(response.body).not.toMatch(/T\d{2}:\d{2}/);
    expect(response.body).not.toMatch(/trim|zone|exposure|generation|lineage|revision|elevation/i);
    expect(response.json().expiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [name, value] of Object.entries({
      'cache-control': 'no-store, private',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'x-content-type-options': 'nosniff',
    }))
      expect(response.headers[name], name).toBe(value);
    const named = await makeLink(instance, courseId, { includeNames: true });
    const withNames = (await read(instance, { token: named.token })).json();
    expect(withNames.name).toBe('비밀 공원 한 바퀴');
    expect(
      withNames.waypoints
        .filter((w: { name?: string }) => w.name)
        .map((w: { name?: string }) => w.name),
    ).toEqual(['공원 입구']);
    // The ends never carry a name: a nameless end would say it had been cut (B-3).
    expect(withNames.waypoints[0].name).toBeUndefined();
  });

  it('T4: every failure is the same 404 — unknown, malformed, expired, revoked, restored, off', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const expiring = await makeLink(instance, courseId);
    const revoking = await makeLink(instance, courseId);
    const live = await makeLink(instance, courseId);
    await admin.query('ALTER TABLE course_share DISABLE TRIGGER course_share_transition');
    try {
      await admin.query(
        `UPDATE course_share SET created_at=clock_timestamp()-interval '2 days',
           expires_at=clock_timestamp()-interval '1 day' WHERE share_id=$1`,
        [expiring.share.shareId],
      );
    } finally {
      await admin.query('ALTER TABLE course_share ENABLE TRIGGER course_share_transition');
    }
    // The expired link is read while another transaction holds its row, so the housekeeping
    // reaper skips it: what refuses it is the read's own expiry comparison, not the reaper.
    const holder = await admin.connect();
    let expiredRead: Awaited<ReturnType<typeof read>>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM course_share WHERE share_id=$1 FOR UPDATE', [
        expiring.share.shareId,
      ]);
      expiredRead = await read(instance, { token: expiring.token });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: `/bff/v1/courses/shares/${revoking.share.shareId}/revoke`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    // A client over its limit gets the same answer as everyone else (R8: rate limit included).
    const limited = app({
      sharing: sharingOn(),
      reader: reader({
        readsPerClientPerMinute: 1,
        readsPerSharePerMinute: 60,
        failedReadsPerClientPerHour: 100,
      }),
    });
    const limitedAddress = freshAddress();
    expect((await read(limited, { token: live.token }, limitedAddress)).statusCode).toBe(200);
    const limitedRead = await read(limited, { token: live.token }, limitedAddress);
    const restored = linkApp(2);
    const off = app();
    const failures = [
      expiredRead,
      limitedRead,
      await read(instance, { token: 'A'.repeat(43) }),
      await read(instance, { token: 'short' }),
      await read(instance, { token: '!'.repeat(43) }),
      await read(instance, 'not json at all'),
      await read(instance, { token: 'x'.repeat(2000) }),
      await read(instance, {}),
      await read(instance, { token: revoking.token }),
      await read(restored, { token: live.token }),
      await read(off, { token: live.token }),
    ];
    // The reference is the plain unknown token; every other failure must look exactly like it.
    const reference = failures[2];
    if (!reference) throw new Error('unreachable');
    for (const failure of failures) {
      expect(failure.statusCode).toBe(404);
      expect(failure.body).toBe(reference.body);
      for (const name of ['cache-control', 'referrer-policy', 'x-robots-tag', 'content-type'])
        expect(failure.headers[name], name).toBe(reference.headers[name]);
    }
    expect(reference.json()).toEqual({ error: { code: 'NOT_FOUND' } });
    expect((await read(instance, { token: live.token })).statusCode).toBe(200);
    // Another owner can neither list, revoke nor see these links.
    signedIn = randomUUID();
    const list = courseShareListSchema.parse(
      (await instance.inject({ method: 'GET', url: '/bff/v1/courses/shares', headers })).json(),
    );
    expect(list.shares).toEqual([]);
    const foreign = await instance.inject({
      method: 'POST',
      url: `/bff/v1/courses/shares/${live.share.shareId}/revoke`,
      headers,
    });
    expect(foreign.statusCode).toBe(404);
    expect((await read(instance, { token: live.token })).statusCode).toBe(200);
  });

  it('T5: a revoked link is 404 from the next request and can never be turned back on', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const { token, share } = await makeLink(instance, courseId);
    expect((await read(instance, { token })).statusCode).toBe(200);
    const revoked = await instance.inject({
      method: 'POST',
      url: `/bff/v1/courses/shares/${share.shareId}/revoke`,
      headers,
    });
    expect(revoked.json()).toMatchObject({ state: 'revoked', revokeReason: 'owner' });
    expect((await read(instance, { token })).statusCode).toBe(404);
    await expect(
      admin.query(
        "UPDATE course_share SET state='active',revoked_at=NULL,revoke_reason=NULL WHERE share_id=$1",
        [share.shareId],
      ),
    ).rejects.toThrow(/INVALID_COURSE_SHARE_TRANSITION/);
    expect((await read(instance, { token })).statusCode).toBe(404);
    const audit = await admin.query(
      'SELECT action,reason FROM course_share_audit WHERE share_id=$1 ORDER BY occurred_at',
      [share.shareId],
    );
    expect(audit.rows).toEqual([
      { action: 'created', reason: null },
      { action: 'revoked', reason: 'owner' },
    ]);
  });

  it('R-6: "모든 링크 끄기" revokes every active link of the owner at once', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const second = await addCourse(athleteId, loop, { name: '둘째 코스' });
    const instance = linkApp();
    const links = [await makeLink(instance, courseId), await makeLink(instance, second)];
    const result = await instance.inject({
      method: 'POST',
      url: '/bff/v1/courses/shares/revoke-all',
      headers,
    });
    expect(result.json()).toEqual({ revokedCount: 2 });
    for (const { token } of links) expect((await read(instance, { token })).statusCode).toBe(404);
  });

  it('T6: deleting the course, reclaiming it with its recording, or erasing the account takes the link', async () => {
    // Course deletion.
    const deleted = await ownerWithCourse(loop);
    const instance = linkApp();
    const first = await makeLink(instance, deleted.courseId);
    const removal = await instance.inject({
      method: 'DELETE',
      url: `/bff/v1/courses/${deleted.courseId}?expectedRevision=1`,
      headers,
    });
    expect(removal.statusCode).toBe(200);
    expect((await read(instance, { token: first.token })).statusCode).toBe(404);
    expect(await countRows('course_share', deleted.athleteId)).toBe(0);
    expect(await countRows('course_disclosure_receipt', deleted.athleteId)).toBe(0);

    // Activity deletion reclaims the course and every revision; the link goes with them.
    const athleteId = randomUUID();
    signedIn = athleteId;
    const activities = createActivityRepository(database);
    const imported = await activities.importActivity(athleteId, activityImport());
    const reclaimedCourse = await addCourse(athleteId, loop, {
      lineage: { activityId: imported.activityId },
    });
    await createCoursePreferenceRepository(database).createPrivacyZone(athleteId, homeZone);
    const second = await makeLink(instance, reclaimedCourse);
    await activities.deleteActivity(athleteId, imported.activityId, {
      expectedRevision: imported.revision,
    });
    expect((await read(instance, { token: second.token })).statusCode).toBe(404);
    expect(await countRows('course_share', athleteId)).toBe(0);

    // Account erasure: the link, its audit, its receipts, its offsets and its counters.
    const erased = await ownerWithCourse(loop);
    const third = await makeLink(instance, erased.courseId);
    expect((await read(instance, { token: third.token })).statusCode).toBe(200);
    // The whole erasure chain in one account: a course-deletion ledger row (049) and an
    // unofficial Garmin connection (048) beside the link rows this node adds (050).
    const deletedLater = await addCourse(erased.athleteId, loop, { name: '지운 코스' });
    expect(
      (
        await instance.inject({
          method: 'DELETE',
          url: `/bff/v1/courses/${deletedLater}?expectedRevision=1`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(await countRows('course_deletion', erased.athleteId)).toBe(1);
    // M2-01as: the links above were cut against the area, so it has a budget row.
    expect(await countRows('course_share_area_budget', erased.athleteId)).toBeGreaterThan(0);
    await admin.query('INSERT INTO garmin_unofficial_connection(athlete_id) VALUES($1)', [
      erased.athleteId,
    ]);
    const eraseResponse = await instance.inject({
      method: 'DELETE',
      url: '/bff/v1/operations/account',
      headers,
      payload: { confirmation: 'DELETE MY ACCOUNT' },
    });
    expect(eraseResponse.statusCode).toBe(200);
    expect((await read(instance, { token: third.token })).statusCode).toBe(404);
    for (const table of [
      'course_share',
      'course_share_audit',
      'course_disclosure_receipt',
      'course_privacy_zone_share_offset',
      'course_share_area_budget',
      'course_deletion',
      'garmin_unofficial_connection',
      'course',
      'course_privacy_zone',
    ])
      expect(await countRows(table, erased.athleteId), table).toBe(0);
    // The chain is 054's link (M2-01as) wrapping this node's, wrapping 049's, wrapping 048's:
    // each outermost link takes
    // the account lock and then the command lock before any row (77206 → 0 → rows).
    const chain: string[] = [];
    for (let name = 'erase_account'; ;) {
      const found = await admin.query<{ source: string }>(
        `SELECT prosrc AS source FROM pg_proc WHERE proname=$1`,
        [name],
      );
      const source = found.rows[0]?.source ?? '';
      chain.push(name);
      const next = /RETURN public\.(erase_account_before_[a-z_]+)\(\$1\)/.exec(source)?.[1];
      if (chain.length <= 4) {
        const accountLock = source.indexOf('hashtextextended($1,77206)');
        const commandLock = source.indexOf('hashtextextended($1,0)');
        const firstDelete = source.indexOf('DELETE');
        expect(accountLock, name).toBeGreaterThan(-1);
        expect(commandLock, name).toBeGreaterThan(accountLock);
        expect(firstDelete, name).toBeGreaterThan(commandLock);
      }
      if (!next || chain.length > 60) break;
      name = next;
    }
    expect(chain.slice(0, 5)).toEqual([
      'erase_account',
      'erase_account_before_course_share_budget',
      'erase_account_before_course_sharing',
      'erase_account_before_course_deletion',
      'erase_account_before_garmin_unofficial',
    ]);
    const counters = await admin.query(
      `SELECT count(*)::integer AS n FROM course_share_rate WHERE bucket=$1`,
      [`s:${third.share.shareId.replaceAll('-', '')}`],
    );
    expect(counters.rows[0]?.['n']).toBe(0);
  });

  it('T7/B-6: a new area revokes the links that touch its share circle, and only those', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const near = await makeLink(instance, courseId);
    const preferences = createCoursePreferenceRepository(database, {
      shareTouchesNewZone: (snapshot, zone, offset) =>
        shareCircles(zone, offset).some((circle) => sharedLineTouchesCircle(snapshot, circle)),
    });
    // Far from the line: the link stays.
    await preferences.createPrivacyZone(athleteId, {
      name: '먼 곳',
      center: at(-8000, -8000),
      radiusMeters: 100,
    });
    expect((await read(instance, { token: near.token })).statusCode).toBe(200);
    // On the line: the link goes, in the same transaction as the area.
    await preferences.createPrivacyZone(athleteId, {
      name: '공원',
      center: at(1500, 300),
      radiusMeters: 100,
    });
    expect((await read(instance, { token: near.token })).statusCode).toBe(404);
    const state = await admin.query(
      'SELECT state,revoke_reason FROM course_share WHERE share_id=$1',
      [near.share.shareId],
    );
    expect(state.rows[0]).toEqual({ state: 'revoked', revoke_reason: 'zone_added' });
  });

  it('R-7: removing an area revokes the links cut against it', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const link = await makeLink(instance, courseId);
    const zones = await createCoursePreferenceRepository(database).listPrivacyZones(athleteId);
    const removed = await instance.inject({
      method: 'DELETE',
      url: `/bff/v1/courses/privacy-zones/${zones[0]?.zoneId}`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    expect((await read(instance, { token: link.token })).statusCode).toBe(404);
    expect(await countRows('course_privacy_zone_share_offset', athleteId)).toBe(0);
  });

  it('T15: editing the course never changes what a link shows', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const link = await makeLink(instance, courseId, { includeNames: true });
    const before = (await read(instance, { token: link.token })).body;
    const renamed = await instance.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: { ...headers, 'idempotency-key': `rename-${randomUUID()}` },
      payload: { expectedRevision: 1, change: { kind: 'rename', name: '새 이름' } },
    });
    expect(renamed.statusCode).toBe(200);
    const zones = await createCoursePreferenceRepository(database).listPrivacyZones(signedIn);
    const trimmed = await instance.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: { ...headers, 'idempotency-key': `trim-${randomUUID()}` },
      payload: {
        expectedRevision: 2,
        change: {
          kind: 'privacy-trim',
          acknowledgedZoneSetDigest: (
            await instance.inject({ method: 'GET', url: '/bff/v1/courses/privacy-zones', headers })
          ).json().zoneSetDigest,
        },
      },
    });
    expect(zones).toHaveLength(1);
    expect(trimmed.statusCode).toBe(200);
    expect((await read(instance, { token: link.token })).body).toBe(before);
  });

  it('T16: the recipient has one unauthenticated route, a POST that returns JSON, and no download', async () => {
    const instance = linkApp();
    await instance.ready();
    expect(instance.hasRoute({ method: 'POST', url: '/bff/v1/shared/course' })).toBe(true);
    expect(instance.hasRoute({ method: 'GET', url: '/bff/v1/shared/course' })).toBe(false);
    const routes = instance.printRoutes({ commonPrefix: false });
    const shared = routes.split('\n').filter((line) => /shared/.test(line));
    expect(shared).toHaveLength(1);
    expect(shared.join('\n')).not.toMatch(/gpx|download|export/i);
    for (const url of [
      '/bff/v1/shared/course',
      '/bff/v1/shared/course.gpx',
      '/bff/v1/shared/course/export.gpx',
    ]) {
      const response = await instance.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
    }
    const { courseId } = await ownerWithCourse(loop);
    const withoutSession = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx`,
    });
    expect([401, 404, 409]).toContain(withoutSession.statusCode);
    expect(withoutSession.body).not.toContain('<gpx');
  });

  it('T19: seven days when omitted, never more than thirty, twenty per owner and five per course', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const first = await makeLink(instance, courseId);
    const days =
      (Date.parse(first.share.expiresAt) - Date.parse(first.share.createdAt)) / 86_400_000;
    // R-4: the link ends at the UTC midnight seven days after the one before it was made.
    expect(days).toBeGreaterThan(6);
    expect(days).toBeLessThanOrEqual(7);
    expect(first.share.expiresAt).toMatch(/T00:00:00(\.000)?Z$/);
    const createdDay = Date.parse(first.share.createdAt.slice(0, 10));
    expect(Date.parse(first.share.expiresAt) - createdDay).toBe(7 * 86_400_000);
    const { confirmation } = await confirmDisclosure(instance, headers, courseId, {
      purpose: 'share',
    });
    const receipt = courseDisclosureReceiptSchema.parse(confirmation.json());
    const tooLong = await instance.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/shares`,
      headers,
      payload: { receiptId: receipt.receiptId, expiresInDays: 31 },
    });
    expect(tooLong.statusCode).toBe(400);
    for (let index = 1; index < courseSharingLimits.activeSharesPerCourse; index += 1)
      await makeLink(instance, courseId, { expiresInDays: 30 });
    const sixth = await instance.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/shares`,
      headers,
      payload: { receiptId: receipt.receiptId },
    });
    expect(sixth.statusCode).toBe(409);
    expect(sixth.json().error.code).toBe('COURSE_SHARE_LIMIT_REACHED');
    // The other links are of courses nowhere near the area: they are cut against nothing, so
    // the place's lifetime budget (M2-01as, 10) is not what stops the twenty-first.
    for (let course = 1; course < 4; course += 1) {
      const next = await addCourse(athleteId, elsewhere, { name: `코스 ${course}` });
      for (let index = 0; index < courseSharingLimits.activeSharesPerCourse; index += 1)
        await makeLink(instance, next);
    }
    const last = await addCourse(athleteId, elsewhere, { name: '스물한 번째' });
    const { confirmation: lastConfirmation } = await confirmDisclosure(instance, headers, last, {
      purpose: 'share',
    });
    const twentyFirst = await instance.inject({
      method: 'POST',
      url: `/bff/v1/courses/${last}/shares`,
      headers,
      payload: {
        receiptId: courseDisclosureReceiptSchema.parse(lastConfirmation.json()).receiptId,
      },
    });
    expect(twentyFirst.statusCode).toBe(409);
    expect(twentyFirst.json().error.code).toBe('COURSE_SHARE_LIMIT_REACHED');
    expect(await countRows('course_share', athleteId)).toBe(20);
  });

  it('T20(2–4): a link is never made from the exact line', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    // (4) The contract refuses an exact line for a link outright.
    for (const exposure of ['owner-exact', 'no-zones-exact'] as const) {
      const { confirmation } = await confirmDisclosure(instance, headers, courseId, {
        purpose: 'share',
        exposure,
        acknowledgedRisk: true,
      });
      expect(confirmation.statusCode).toBe(400);
    }
    // (3) An owner-exact export receipt cannot make a link.
    const { confirmation } = await confirmDisclosure(instance, headers, courseId, {
      exposure: 'owner-exact',
      acknowledgedRisk: true,
    });
    expect(confirmation.statusCode).toBe(200);
    const exact = courseDisclosureReceiptSchema.parse(confirmation.json());
    const refused = await instance.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/shares`,
      headers,
      payload: { receiptId: exact.receiptId },
    });
    expect(refused.statusCode).toBe(409);
    expect(await countRows('course_share', signedIn)).toBe(0);
  });

  it('T21: without a protected area a link cannot be confirmed, and says why', async () => {
    const { courseId } = await ownerWithCourse(loop, { zones: [] });
    const instance = linkApp();
    const preview = courseDisclosurePreviewSchema.parse(
      (
        await instance.inject({
          method: 'GET',
          url: `/bff/v1/courses/${courseId}/disclosure-preview?purpose=share`,
          headers,
        })
      ).json(),
    );
    expect(preview).toMatchObject({ outcome: 'no-zones', options: [], defaultExposure: null });
    const confirmation = await instance.inject({
      method: 'POST',
      url: `/bff/v1/courses/${courseId}/disclosure-confirmations`,
      headers: { ...headers, 'idempotency-key': `confirm-${randomUUID()}` },
      payload: {
        purpose: 'share',
        expectedRevision: preview.courseRevision,
        acknowledgedZoneSetDigest: preview.zoneSetDigest,
        exposure: 'no-zone-intersection',
        includeNames: false,
        acknowledgedRisk: true,
      },
    });
    expect(confirmation.statusCode).toBe(409);
    expect(confirmation.json().error.code).toBe('COURSE_SHARE_REQUIRES_PROTECTED_AREA');
    expect(await countRows('course_share', signedIn)).toBe(0);
  });

  it('T22 (B-1): every link of one area uses the same stored offset, which never leaves', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const bodies: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { token } = await makeLink(instance, courseId);
      bodies.push((await read(instance, { token })).body);
    }
    const coordinatesOf = (body: string) => JSON.stringify(JSON.parse(body).coordinates);
    expect(new Set(bodies.map(coordinatesOf)).size).toBe(1);
    const offsets = await admin.query(
      'SELECT offset_x,offset_y FROM course_privacy_zone_share_offset WHERE athlete_id=$1',
      [athleteId],
    );
    expect(offsets.rows).toHaveLength(1);
    const offset = offsets.rows[0] as { offset_x: number; offset_y: number };
    const everything = [
      ...bodies,
      (
        await instance.inject({
          method: 'GET',
          url: `/bff/v1/courses/${courseId}/disclosure-preview?purpose=share`,
          headers,
        })
      ).body,
      (await instance.inject({ method: 'GET', url: '/bff/v1/courses/privacy-zones', headers }))
        .body,
      (await instance.inject({ method: 'GET', url: '/bff/v1/courses/shares', headers })).body,
    ].join('\n');
    for (const value of [offset.offset_x, offset.offset_y])
      expect(everything).not.toContain(String(value).slice(0, 8));
  });
});

// ── Rate limits (T12, T23) and the epoch guard (B-5) ──────────────────────────────────

describe('T12/T23: limits the unauthenticated read, across instances, by client and by link', () => {
  it('lets a client read 30 times a minute and not a 31st', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const { token } = await makeLink(instance, courseId);
    const address = freshAddress();
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1)
      statuses.push((await read(instance, { token }, address)).statusCode);
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(404);
  });

  it('shares the counters between two API instances', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const first = linkApp();
    const second = linkApp();
    const { token } = await makeLink(first, courseId);
    const address = freshAddress();
    for (let index = 0; index < 15; index += 1)
      expect((await read(first, { token }, address)).statusCode).toBe(200);
    for (let index = 0; index < 15; index += 1)
      expect((await read(second, { token }, address)).statusCode).toBe(200);
    expect((await read(first, { token }, address)).statusCode).toBe(404);
    expect((await read(second, { token }, address)).statusCode).toBe(404);
  });

  it('limits one link to 60 matched reads a minute, counted by link, across clients', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    const { token } = await makeLink(instance, courseId);
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1)
      statuses.push((await read(instance, { token })).statusCode);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(404);
  });

  it('shuts a client out for the hour after 100 failures, whatever it asks next', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const instance = app({
      sharing: sharingOn(),
      reader: reader({
        readsPerClientPerMinute: 1000,
        readsPerSharePerMinute: 1000,
        failedReadsPerClientPerHour: courseSharingLimits.failedReadsPerClientPerHour,
      }),
    });
    const { token } = await makeLink(instance, courseId);
    const address = freshAddress();
    for (let index = 0; index < 99; index += 1)
      expect(
        (await read(instance, { token: `${index}`.padEnd(43, 'Z') }, address)).statusCode,
      ).toBe(404);
    expect((await read(instance, { token }, address)).statusCode).toBe(200);
    expect((await read(instance, { token: 'Q'.repeat(43) }, address)).statusCode).toBe(404);
    expect((await read(instance, { token }, address)).statusCode).toBe(404);
    expect((await read(instance, { token })).statusCode).toBe(200);
  });

  it('R-5: a thousand unknown tokens create no per-link counter row', async () => {
    const instance = app({
      sharing: sharingOn(),
      reader: reader({
        readsPerClientPerMinute: 10_000,
        readsPerSharePerMinute: 60,
        failedReadsPerClientPerHour: 100_000,
      }),
    });
    const before = await admin.query(
      "SELECT count(*)::integer AS n FROM course_share_rate WHERE bucket LIKE 's:%'",
    );
    const address = freshAddress();
    for (let index = 0; index < 1000; index += 1)
      await read(instance, { token: randomUUID().replaceAll('-', '').padEnd(43, 'k') }, address);
    const after = await admin.query(
      "SELECT count(*)::integer AS n FROM course_share_rate WHERE bucket LIKE 's:%'",
    );
    expect(after.rows[0]?.['n']).toBe(before.rows[0]?.['n']);
  });

  it('T23: ignores a forged X-Forwarded-For, keeps clients behind a trusted proxy apart, stores no address', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const direct = linkApp();
    const { token } = await makeLink(direct, courseId);
    const attacker = freshAddress();
    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1)
      statuses.push(
        (await read(direct, { token }, attacker, { 'x-forwarded-for': `198.51.100.${index}` }))
          .statusCode,
      );
    expect(statuses[30]).toBe(404);
    // A second link, so the per-link limit of the first cannot stand in for the client's.
    const { token: second } = await makeLink(direct, courseId);
    const proxy = freshAddress();
    const proxied = linkApp(1, [proxy]);
    for (let index = 0; index < 30; index += 1)
      expect(
        (await read(proxied, { token: second }, proxy, { 'x-forwarded-for': '203.0.113.7' }))
          .statusCode,
      ).toBe(200);
    expect(
      (await read(proxied, { token: second }, proxy, { 'x-forwarded-for': '203.0.113.7' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await read(proxied, { token: second }, proxy, { 'x-forwarded-for': '203.0.113.8' }))
        .statusCode,
    ).toBe(200);
    // B-4: counters are kept at most two hours; the read itself removes older ones.
    await admin.query(
      `INSERT INTO course_share_rate(bucket,window_start,hits)
       VALUES ('c:${'0'.repeat(64)}',clock_timestamp()-interval '3 hours',1)`,
    );
    await read(proxied, { token: second });
    const buckets = await admin.query('SELECT bucket FROM course_share_rate');
    const all = buckets.rows.map((row) => String(row['bucket'])).join('\n');
    for (const address of ['203.0.113.7', '203.0.113.8', attacker, proxy])
      expect(all).not.toContain(address);
    expect(buckets.rows.every((row) => /^[cfs]:[a-f0-9]{32,64}$/.test(String(row['bucket'])))).toBe(
      true,
    );
    const old = await admin.query(
      "SELECT count(*)::integer AS n FROM course_share_rate WHERE window_start<clock_timestamp()-interval '2 hours 5 minutes'",
    );
    expect(old.rows[0]?.['n']).toBe(0);
  });

  it('B-5: a link from a higher epoch than the configured one stops every link', async () => {
    const { courseId } = await ownerWithCourse(loop);
    const current = linkApp(5);
    const { token } = await makeLink(current, courseId);
    expect((await read(current, { token })).statusCode).toBe(200);
    const future = linkApp(6);
    const { token: futureToken } = await makeLink(future, courseId);
    expect((await read(future, { token: futureToken })).statusCode).toBe(200);
    // The configuration went back to 5 with a link of epoch 6 in the database.
    expect((await read(current, { token })).statusCode).toBe(404);
    await admin.query('DELETE FROM course_share WHERE epoch>5');
    expect((await read(current, { token })).statusCode).toBe(200);
    // Leave no raised epoch behind for the scenarios of epoch 1.
    await admin.query('DELETE FROM course_share WHERE epoch>1');
  });
});

/** Age a receipt past its hour, as the admin, around the trigger that refuses any edit. */
async function ageReceipt(receiptId: string) {
  await admin.query(
    'ALTER TABLE course_disclosure_receipt DISABLE TRIGGER course_disclosure_receipt_immutable',
  );
  try {
    const aged = await admin.query(
      `UPDATE course_disclosure_receipt SET confirmed_at=confirmed_at-interval '2 hours',
         expires_at=expires_at-interval '2 hours' WHERE receipt_id=$1`,
      [receiptId],
    );
    expect(aged.rowCount).toBe(1);
  } finally {
    await admin.query(
      'ALTER TABLE course_disclosure_receipt ENABLE TRIGGER course_disclosure_receipt_immutable',
    );
  }
}

describe('peer review r1: receipt expiry and the share circles', () => {
  it('a receipt past its hour gives no GPX and makes no link, on the route and in the store', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp();
    // Export: usable, then aged, then refused (A1, `readUsableReceipt`).
    const exported = await confirmedExport(instance, headers, courseId);
    expect(exported.response.statusCode).toBe(200);
    await ageReceipt(exported.receipt.receiptId);
    const refused = await instance.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/export.gpx?receipt=${exported.receipt.receiptId}`,
      headers,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('COURSE_EXPORT_NOT_CONFIRMED');
    expect(refused.body).not.toContain('<gpx');

    // Link: the same receipt makes a link while fresh, and nothing once aged.
    const { confirmation } = await confirmDisclosure(instance, headers, courseId, {
      purpose: 'share',
    });
    const receipt = courseDisclosureReceiptSchema.parse(confirmation.json());
    const create = () =>
      instance.inject({
        method: 'POST',
        url: `/bff/v1/courses/${courseId}/shares`,
        headers,
        payload: { receiptId: receipt.receiptId },
      });
    expect((await create()).statusCode).toBe(201);
    await ageReceipt(receipt.receiptId);
    const late = await create();
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('COURSE_EXPORT_NOT_CONFIRMED');
    // The store's own gate (A2, `createShare`), with everything else about the request right:
    // the head, the area set and the exposure all match; only the hour has passed.
    const zones = await createCoursePreferenceRepository(database).listPrivacyZones(athleteId);
    const before = await countRows('course_share', athleteId);
    await expect(
      createCourseSharingRepository(database).createShare(athleteId, {
        courseId,
        receiptId: receipt.receiptId,
        exposure: 'trimmed',
        tokenDigest: hashOf(randomUUID()),
        epoch: 1,
        expiresInDays: 7,
        snapshot: {
          coordinates: [at(3000, 3000), at(3100, 3000)],
          waypoints: [
            { role: 'start', position: at(3000, 3000) },
            { role: 'finish', position: at(3100, 3000) },
          ],
          distanceMeters: 100,
        },
        zoneIds: zones.map((zone) => zone.zoneId),
        cutZoneIds: [],
        zoneSetDigest: privacyZoneSetDigest(zones),
        digestOf: privacyZoneSetDigest,
      }),
    ).rejects.toMatchObject({ code: 'COURSE_EXPORT_NOT_CONFIRMED' });
    expect(await countRows('course_share', athleteId)).toBe(before);
  });

  it('R-2: a link is cut against a large area itself, not only its flat-map share circle', async () => {
    // A 5 km area whose offset points south-west: its share circle leaves a sliver of the
    // area's own north-east edge outside it (about 7 cm deep at this grid point). The line
    // ends on that sliver.
    const center: CoursePosition = [127.02, 37.5];
    const sliver: CoursePosition = [127.06716, 37.52495];
    // From about 27 km north-east: long enough to keep a line after the 2.5 · S = 12.5 km
    // continuation cut past the cut end (M2-01as).
    const line: CoursePosition[] = [
      ...Array.from({ length: 25 }, (_, index): CoursePosition => [
        Number((127.09536 + 0.0094 * (25 - index)).toFixed(5)),
        Number((37.54004 + 0.00503 * (25 - index)).toFixed(5)),
      ]),
      [127.09536, 37.54004],
      [127.08596, 37.53501],
      [127.07656, 37.52998],
      sliver,
    ];
    const zone = { name: '넓은 구역', center, radiusMeters: 5000 } as const;
    const { athleteId, courseId } = await ownerWithCourse(line, { zones: [zone] });
    const angle = (2 * Math.PI * 38) / 64;
    const offset = { x: 0.999999 * Math.cos(angle), y: 0.999999 * Math.sin(angle) };
    await admin.query('DELETE FROM course_privacy_zone_share_offset WHERE athlete_id=$1', [
      athleteId,
    ]);
    await admin.query(
      `INSERT INTO course_privacy_zone_share_offset(athlete_id,zone_id,offset_x,offset_y,created_at)
       SELECT athlete_id,zone_id,$2,$3,now() FROM course_privacy_zone WHERE athlete_id=$1`,
      [athleteId, offset.x, offset.y],
    );
    // The gap is real: the sliver is inside the area and outside its share circle.
    const [circle] = await shareCirclesOf(athleteId);
    if (!circle) throw new Error('no share circle');
    expect(greatCircleMeters(center, sliver)).toBeLessThan(5000);
    expect(greatCircleMeters(circle.center, sliver)).toBeGreaterThan(circle.radiusMeters);
    const instance = linkApp();
    const { token } = await makeLink(instance, courseId);
    const shared = sharedCourseSchema.parse((await read(instance, { token })).json());
    expect(isOutside(shared, [{ center, radiusMeters: 5000 }])).toBe(true);
    expect(shared.coordinates).not.toContainEqual(sliver);
  });
});

function activityImport(): ActivityImport {
  return {
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
    activity: {
      title: 'Synthetic run',
      kind: 'running',
      startedAt: '2026-09-16T08:00:00+09:00',
      durationSeconds: 600,
      durationKind: 'timer',
      timezone: 'Asia/Seoul',
      distanceMeters: 1000,
    },
  };
}

// ── M2-01as: the lifetime link budget per place (migration 054) ────────────────────────

async function budgetOf(athleteId: string) {
  const rows = await admin.query<{
    zone_id: string;
    cell_latitude: number;
    cell_longitude: number;
    reach_meters: number;
    links_cut: number;
  }>(
    `SELECT zone_id::text,cell_latitude,cell_longitude,reach_meters,links_cut
     FROM course_share_area_budget WHERE athlete_id=$1 ORDER BY zone_id`,
    [athleteId],
  );
  return rows.rows;
}

async function refusedLink(instance: ReturnType<typeof createApi>, courseId: string) {
  const { confirmation } = await confirmDisclosure(instance, headers, courseId, {
    purpose: 'share',
  });
  expect(confirmation.statusCode).toBe(200);
  const receipt = courseDisclosureReceiptSchema.parse(confirmation.json());
  return instance.inject({
    method: 'POST',
    url: `/bff/v1/courses/${courseId}/shares`,
    headers,
    payload: { receiptId: receipt.receiptId },
  });
}

async function revoke(instance: ReturnType<typeof createApi>, shareId: string) {
  const revoked = await instance.inject({
    method: 'POST',
    url: `/bff/v1/courses/shares/${shareId}/revoke`,
    headers,
  });
  expect(revoked.statusCode).toBe(200);
}

describe('M2-01as: a place gives out at most 10 links, ever', () => {
  it('counts revoked, reaped-away and epoch-invalidated links, and refuses the 11th', async () => {
    expect(courseSharingLimits.shareLinksPerAreaLifetime).toBe(10);
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const epochOne = linkApp(1);
    // 3 made and turned off by the owner.
    for (let index = 0; index < 3; index += 1)
      await revoke(epochOne, (await makeLink(epochOne, courseId)).share.shareId);
    // 3 made and then gone as an expired link goes: the reaper removes the row.
    const reaped: string[] = [];
    for (let index = 0; index < 3; index += 1)
      reaped.push((await makeLink(epochOne, courseId)).share.shareId);
    await admin.query('DELETE FROM course_share WHERE athlete_id=$1 AND share_id=ANY($2::uuid[])', [
      athleteId,
      reaped,
    ]);
    // 3 left active under epoch 1 — a restore then raises the epoch and invalidates them.
    const invalidated: string[] = [];
    for (let index = 0; index < 3; index += 1)
      invalidated.push((await makeLink(epochOne, courseId)).share.shareId);
    const epochTwo = linkApp(2);
    try {
      const listed = courseShareListSchema.parse(
        (await epochTwo.inject({ method: 'GET', url: '/bff/v1/courses/shares', headers })).json(),
      );
      expect(
        listed.shares
          .filter((item) => invalidated.includes(item.shareId))
          .map((item) => item.state),
      ).toEqual(['invalidated', 'invalidated', 'invalidated']);
      // 1 more under epoch 2: the tenth link is the last one. Turning them all off gives
      // nothing back.
      await makeLink(epochTwo, courseId);
      expect((await budgetOf(athleteId)).map((row) => row.links_cut)).toEqual([10]);
      await epochTwo.inject({ method: 'POST', url: '/bff/v1/courses/shares/revoke-all', headers });
      const linksBefore = await countRows('course_share', athleteId);
      const auditBefore = await countRows('course_share_audit', athleteId);
      const refused = await refusedLink(epochTwo, courseId);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('COURSE_SHARE_AREA_LIFETIME_REACHED');
      expect(await countRows('course_share', athleteId)).toBe(linksBefore);
      expect(await countRows('course_share_audit', athleteId)).toBe(auditBefore);
      expect((await budgetOf(athleteId)).map((row) => row.links_cut)).toEqual([10]);
      // A course that never comes near the area was not cut against it and still shares.
      const far = await addCourse(athleteId, elsewhere);
      const farLink = await makeLink(epochTwo, far);
      expect(farLink.share.state).toBe('active');
      expect((await budgetOf(athleteId)).map((row) => row.links_cut)).toEqual([10]);
    } finally {
      // A link of a higher epoch stops every read under epoch 1 (the fail-closed rule), and
      // the other scenarios of this file read under epoch 1: remove this scenario's.
      await admin.query('DELETE FROM course_share WHERE athlete_id=$1 AND epoch>1', [athleteId]);
    }
  });

  it('keeps the count when the area is deleted and made again over the same place', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp(1);
    await makeLink(instance, courseId);
    const [first] = await budgetOf(athleteId);
    if (!first) throw new Error('no budget row');
    expect(first.links_cut).toBe(1);
    // What the row keeps of the place: a 0.01° cell and the share reach, 3 · S rounded up to 100 m.
    expect(first).toMatchObject({
      cell_latitude: Math.floor(home[1] * 100),
      cell_longitude: Math.floor(home[0] * 100),
      reach_meters: 600,
    });
    // Nine more links of the place, as the owner's own history (an increase is the
    // only change the table allows).
    await admin.query(
      'UPDATE course_share_area_budget SET links_cut=10 WHERE athlete_id=$1 AND zone_id=$2',
      [athleteId, first.zone_id],
    );
    const removed = await instance.inject({
      method: 'DELETE',
      url: `/bff/v1/courses/privacy-zones/${first.zone_id}`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    // The area and its offset are gone; its budget row stays as the place's tombstone.
    expect(await countRows('course_privacy_zone', athleteId)).toBe(0);
    expect(await countRows('course_privacy_zone_share_offset', athleteId)).toBe(0);
    expect((await budgetOf(athleteId)).map((row) => row.zone_id)).toEqual([first.zone_id]);
    // Made again 120 m away and smaller: a new area, a new offset — and no new budget.
    const preferences = createCoursePreferenceRepository(database, {
      shareTouchesNewZone: () => false,
    });
    await preferences.createPrivacyZone(athleteId, {
      name: '다시 만든 집',
      center: at(120, 0),
      radiusMeters: 150,
    });
    const again = await refusedLink(instance, courseId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('COURSE_SHARE_AREA_LIFETIME_REACHED');
    // The refused claim wrote nothing, not even the new area's row.
    expect(await budgetOf(athleteId)).toHaveLength(1);
    // An area 30 km away is another place: it starts from nothing.
    const distant: CoursePosition[] = leg([30_000, 0], [31_500, 0], 5)
      .concat(leg([31_500, 0], [31_500, 600], 50))
      .concat(leg([31_500, 600], [30_000, 600], 25))
      .concat(leg([30_000, 600], [30_000, 0], 5))
      .concat([at(30_000, 0)]);
    const distantCourse = await addCourse(athleteId, distant);
    await preferences.createPrivacyZone(athleteId, {
      name: '먼 곳',
      center: at(30_000, 0),
      radiusMeters: 200,
    });
    const created = await makeLink(instance, distantCourse);
    expect(created.share.state).toBe('active');
    expect((await budgetOf(athleteId)).map((row) => row.links_cut).sort()).toEqual([1, 10]);
  });

  it('lets only the claim write a budget, only upward, and only for the session tenant', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp(1);
    await makeLink(instance, courseId);
    const [row] = await budgetOf(athleteId);
    if (!row) throw new Error('no budget row');
    // The runtime role reads (the export) and writes nothing directly.
    for (const statement of [
      `INSERT INTO course_share_area_budget(athlete_id,zone_id,cell_latitude,cell_longitude,
         reach_meters,links_cut) VALUES('${athleteId}','${randomUUID()}',0,0,100,0)`,
      'UPDATE course_share_area_budget SET links_cut=0',
      'DELETE FROM course_share_area_budget',
    ])
      await expect(database.tenant(athleteId, (tx) => tx.query(statement))).rejects.toMatchObject({
        code: '42501',
      });
    // Not even the owner role may lower a count or move a place; only erasure removes a row.
    await expect(
      admin.query('UPDATE course_share_area_budget SET links_cut=0 WHERE athlete_id=$1', [
        athleteId,
      ]),
    ).rejects.toThrow('IMMUTABLE_SHARE_AREA_BUDGET');
    await expect(
      admin.query('UPDATE course_share_area_budget SET cell_latitude=0 WHERE athlete_id=$1', [
        athleteId,
      ]),
    ).rejects.toThrow('IMMUTABLE_SHARE_AREA_BUDGET');
    // The claim takes the session's tenant and no other: another tenant's area is unknown.
    const stranger = randomUUID();
    await expect(
      database.tenant(stranger, (tx) =>
        tx.query('SELECT public.claim_course_share_budget($1::uuid[])', [[row.zone_id]]),
      ),
    ).rejects.toThrow('COURSE_SHARE_AREA_UNKNOWN');
    expect((await budgetOf(athleteId)).map((each) => each.links_cut)).toEqual([1]);
    // The bound is the database's own: claiming past it is refused however it is asked.
    await admin.query(
      'UPDATE course_share_area_budget SET links_cut=10 WHERE athlete_id=$1 AND zone_id=$2',
      [athleteId, row.zone_id],
    );
    const claimed = await database.tenant(athleteId, (tx) =>
      tx.query('SELECT public.claim_course_share_budget($1::uuid[]) AS claimed', [[row.zone_id]]),
    );
    expect(claimed.rows[0]?.['claimed']).toBe(false);
  });

  it('exports each place budget in v24: area id, cell, rounded radius and count only', async () => {
    const { athleteId, courseId } = await ownerWithCourse(loop);
    const instance = linkApp(1);
    await makeLink(instance, courseId);
    await makeLink(instance, courseId);
    const exported = await instance.inject({
      method: 'POST',
      url: '/bff/v1/operations/export',
      headers,
    });
    expect(exported.statusCode).toBe(200);
    const artifact = accountExportSchema.parse(exported.json());
    if (artifact.schemaVersion !== 24) throw new Error('expected v24');
    const [row] = await budgetOf(athleteId);
    expect(artifact.data.courseShareAreaBudgets).toEqual([
      {
        zone_id: row?.zone_id,
        cell_latitude: Math.floor(home[1] * 100),
        cell_longitude: Math.floor(home[0] * 100),
        reach_meters: 600,
        links_cut: 2,
      },
    ]);
    expect(Object.keys(artifact.data.courseShareAreaBudgets[0] ?? {}).sort()).toEqual([
      'cell_latitude',
      'cell_longitude',
      'links_cut',
      'reach_meters',
      'zone_id',
    ]);
  });
});
