import { Writable } from 'node:stream';

import type { CoursePreferenceRepository } from '@workout/server-persistence/course-preferences';
import {
  CoursePreferenceError,
  PrivacyZoneStateError,
} from '@workout/server-persistence/course-preferences';
import { CourseNotFoundError, type CourseRepository } from '@workout/server-persistence/courses';
import { createBoundedTrackParser } from '@workout/server-track-storage/parse-host';
import { createElevationIndex, createPlaceIndex } from '@workout/server-courses/geo-data';
import { privacyZoneSetDigest } from '@workout/server-courses/privacy-trim';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApi } from '../src/app.js';

/**
 * The M2-01j API boundary: import, preferences, protected areas, place search, elevation
 * and the privacy trim.
 *
 * The parser here is the **real** bounded worker, not a stub. That is the point of these
 * tests: what they establish is that a file handed to this route is parsed by the server
 * under the server's own bounds — XXE blocked, archives refused, the format read from the
 * bytes rather than from a name or a MIME type — and that a client's claims about the file
 * decide nothing.
 */
const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const courseId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const zoneId = '11111111-1111-4111-8111-111111111111';
const createdAt = '2026-09-19T01:00:00.000Z';
const csrfToken = 'c'.repeat(43);
const baseHeaders = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};
const commandHeaders = { ...baseHeaders, 'idempotency-key': 'course-import-0001' };

const gpx = (body: string, creator = 'test-writer') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="${creator}" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

const singleRoute = gpx(
  `<rte><name>가져온 경로</name><rtept lat="37.5000000" lon="127.0200000" /><rtept lat="37.5010000" lon="127.0210000" /></rte>`,
);
const trackAndRoute = gpx(
  `<trk><name>기록</name><trkseg><trkpt lat="37.5000000" lon="127.0200000" /><trkpt lat="37.5010000" lon="127.0210000" /></trkseg></trk>` +
    `<rte><name>경로</name><rtept lat="37.5000000" lon="127.0200000" /><rtept lat="37.5010000" lon="127.0210000" /></rte>`,
);

const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

const courseHead = {
  status: 'available' as const,
  courseId,
  name: '가져온 경로',
  visibility: 'private' as const,
  headRevision: 1,
  revisionId: '99999999-9999-4999-8999-999999999999',
  createdAt,
  updatedAt: createdAt,
};
const courseRevision = {
  courseId,
  courseRevision: 1,
  revisionId: courseHead.revisionId,
  name: '가져온 경로',
  geometry: {
    type: 'LineString' as const,
    // One vertex on top of the elevation fixture's only fact and one far away from it, so
    // the profile below has a known point and an unknown one.
    coordinates: [
      [127.02, 37.5],
      [127.04, 37.52],
    ] as [number, number][],
  },
  waypoints: [
    {
      role: 'start' as const,
      position: [127.02, 37.5] as [number, number],
      name: null,
      sourceSampleId: null,
      locked: false,
    },
    {
      role: 'finish' as const,
      position: [127.04, 37.52] as [number, number],
      name: null,
      sourceSampleId: null,
      locked: false,
    },
  ],
  generation: {
    kind: 'imported-file' as const,
    format: 'gpx' as const,
    sourceKind: 'gpx-rte' as const,
    itemIndex: 0,
    parserId: 'gpx-track-v1' as const,
    parserVersion: 1 as const,
    fileSha256: 'a'.repeat(64),
    fileByteLength: 200,
    originalFilename: 'course.gpx',
    fileCreator: 'test-writer',
    vertexCount: 2,
    importedWaypointCount: 0,
    ignoredFileWaypointCount: 0,
  },
  edit: { kind: 'imported' as const },
  lineage: [],
  distanceMeters: 140,
  contentDigest: 'e'.repeat(64),
  createdAt,
};

const zone = {
  zoneId,
  name: '집',
  center: [127.02, 37.5] as [number, number],
  radiusMeters: 200,
  createdAt,
  updatedAt: createdAt,
};

const placeIndex = createPlaceIndex({
  identity: {
    kind: 'places',
    datasetId: '0123456789ab',
    datasetVersion: 1,
    region: 'Seoul',
    sourceExtractSha256: 'a'.repeat(64),
    licence: 'ODbL-1.0',
    licenceUrl: 'https://www.openstreetmap.org/copyright',
    attribution: '© OpenStreetMap contributors',
    updateCadence: '월 1회',
    builtAt: createdAt,
    featureCount: 1,
    bbox: [126.734, 37.413, 127.269, 37.715],
  },
  places: [
    {
      placeId: 'p1',
      name: '남산',
      localName: 'Namsan',
      kind: 'place:locality',
      position: [126.9882, 37.5512],
    },
  ],
});

const elevationIndex = createElevationIndex({
  identity: {
    kind: 'elevation',
    datasetId: 'beef0123cafe',
    datasetVersion: 1,
    region: 'Seoul',
    sourceExtractSha256: 'a'.repeat(64),
    licence: 'ODbL-1.0',
    licenceUrl: 'https://www.openstreetmap.org/copyright',
    attribution: '© OpenStreetMap contributors',
    updateCadence: '월 1회',
    builtAt: createdAt,
    featureCount: 1,
    bbox: [126.734, 37.413, 127.269, 37.715],
  },
  maxSourceDistanceMeters: 150,
  points: [{ position: [127.02, 37.5], elevationMeters: 42 }],
});

const instances: ReturnType<typeof createApi>[] = [];

function setup(
  options: {
    authenticated?: boolean;
    datasets?: boolean;
    zones?: (typeof zone)[];
    headGeometry?: [number, number][];
  } = {},
) {
  const coordinates = options.headGeometry ?? [
    [127.02, 37.5],
    [127.03, 37.51],
    [127.04, 37.52],
  ];
  const courses: CourseRepository = {
    replayCommand: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockResolvedValue({ status: 'available', course: courseHead, revision: courseRevision }),
    read: vi
      .fn()
      .mockResolvedValue({ status: 'available', course: courseHead, revision: courseRevision }),
    list: vi.fn().mockResolvedValue({ courses: [courseHead], total: 1 }),
    headContent: vi.fn().mockResolvedValue({
      courseId,
      courseRevision: 1,
      name: courseRevision.name,
      coordinates,
      waypoints: [
        {
          role: 'start',
          position: coordinates[0],
          name: '집 앞',
          sourceSampleId: null,
          locked: false,
        },
        {
          role: 'finish',
          position: coordinates[coordinates.length - 1],
          name: null,
          sourceSampleId: null,
          locked: false,
        },
      ],
      generation: courseRevision.generation,
      lineage: [],
    }),
    update: vi.fn().mockResolvedValue({
      status: 'available',
      course: { ...courseHead, headRevision: 2 },
      revision: { ...courseRevision, courseRevision: 2 },
    }),
    remove: vi.fn().mockResolvedValue({ deleted: true }),
    storeRouteProposal: vi.fn().mockRejectedValue(new Error('not used')),
    readRouteProposal: vi.fn().mockResolvedValue(null),
    storeRouteCandidateSet: vi.fn().mockRejectedValue(new Error('not used')),
    readRouteCandidate: vi.fn().mockResolvedValue(null),
    affectedByActivityDeletion: vi.fn().mockRejectedValue(new Error('not used')),
  } as unknown as CourseRepository;
  const zones = options.zones ?? [zone];
  const preferences: CoursePreferenceRepository = {
    list: vi.fn().mockResolvedValue({
      preferences: [{ courseId, favourite: true, lastUsedAt: createdAt }],
      total: 1,
    }),
    write: vi.fn().mockResolvedValue({ courseId, favourite: true, lastUsedAt: createdAt }),
    listPrivacyZones: vi.fn().mockResolvedValue(zones),
    createPrivacyZone: vi.fn().mockResolvedValue(zones),
    removePrivacyZone: vi.fn().mockResolvedValue([]),
  };
  const app = createApi({
    allowedOrigins: ['https://workout.example'],
    auth: {
      authenticate: async () =>
        options.authenticated === false
          ? null
          : { athleteId, sessionId: 'current', csrfToken, method: 'cookie' as const },
    },
    consent: { getConsent: vi.fn(), setConsent: vi.fn() },
    courses: {
      courses,
      tracks: { read: vi.fn(), resolveObject: vi.fn() } as never,
      storage: {} as never,
    },
    courseExtras: {
      courses,
      preferences,
      // The real worker. The test process does not run under `tsx`, so the loader is
      // passed explicitly, exactly as the parse-host contract describes.
      parser: createBoundedTrackParser({
        execArgv: ['--import', 'tsx'],
        maxOldGenerationSizeMb: 256,
      }),
      places: options.datasets === false ? null : placeIndex,
      elevation: options.datasets === false ? null : elevationIndex,
    },
    logStream: new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  });
  instances.push(app);
  return { app, courses, preferences, zones };
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

async function importFile(
  app: ReturnType<typeof createApi>,
  payload: Record<string, unknown>,
  headers: Record<string, string> = commandHeaders,
) {
  return app.inject({ method: 'POST', url: '/bff/v1/courses/imports', headers, payload });
}

describe('course import', () => {
  it('imports a GPX route as a private course with no recording lineage', async () => {
    const { app, courses } = setup();
    const response = await importFile(app, {
      name: null,
      originalFilename: 'course.gpx',
      selection: null,
      fileBase64: base64(singleRoute),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ outcome: 'imported' });
    const created = (courses.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(created.name).toBe('가져온 경로');
    expect(created.lineage).toEqual([]);
    expect(created.edit).toEqual({ kind: 'imported' });
    expect(created.generation.kind).toBe('imported-file');
    expect(created.generation.sourceKind).toBe('gpx-rte');
    expect(created.coordinates).toHaveLength(2);
  });

  it('answers with what the file holds instead of choosing between a track and a route', async () => {
    const { app, courses } = setup();
    const response = await importFile(app, {
      name: null,
      originalFilename: 'both.gpx',
      selection: null,
      fileBase64: base64(trackAndRoute),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe('requires_selection');
    expect(body.items.map((item: { sourceKind: string }) => item.sourceKind)).toEqual([
      'gpx-trk',
      'gpx-rte',
    ]);
    // Nothing was stored while the owner had not chosen.
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('imports the chosen item and records which kind it was', async () => {
    const { app, courses } = setup();
    const response = await importFile(app, {
      name: '내가 고른 기록',
      originalFilename: 'both.gpx',
      selection: { sourceKind: 'gpx-trk', itemIndex: 0 },
      fileBase64: base64(trackAndRoute),
    });
    expect(response.statusCode).toBe(200);
    const created = (courses.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
    expect(created.generation.sourceKind).toBe('gpx-trk');
    expect(created.name).toBe('내가 고른 기록');
  });

  it('blocks a DOCTYPE and an external entity and stores nothing', async () => {
    const { app, courses } = setup();
    const xxe =
      `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
      `<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>&xxe;</name>` +
      `<rtept lat="37.5" lon="127.02" /><rtept lat="37.501" lon="127.021" /></rte></gpx>`;
    const response = await importFile(app, {
      name: null,
      originalFilename: 'evil.gpx',
      selection: null,
      fileBase64: base64(xxe),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('TRACK_XML_DTD_BLOCKED');
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('refuses an archive rather than unpacking it', async () => {
    const { app, courses } = setup();
    // A real ZIP local file header. The name says `.gpx`; the bytes say otherwise.
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64, 0),
    ]).toString('base64');
    const response = await importFile(app, {
      name: '압축',
      originalFilename: 'course.gpx',
      selection: null,
      fileBase64: zip,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('TRACK_ARCHIVE_REJECTED');
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('does not trust the file name: FIT bytes under a .gpx name are refused as a course', async () => {
    const { app, courses } = setup();
    // A FIT header with the `.FIT` magic. The parser sniffs the format from the content,
    // and a course is imported from GPX only.
    const header = Buffer.alloc(14);
    header.writeUInt8(14, 0);
    header.writeUInt8(0x10, 1);
    header.write('.FIT', 8, 'ascii');
    const response = await importFile(app, {
      name: '핏 파일',
      originalFilename: 'course.gpx',
      selection: null,
      fileBase64: header.toString('base64'),
    });
    expect(response.statusCode).toBe(422);
    // Either the FIT reader refuses the truncated file or the route refuses the format;
    // both are refusals that store nothing, and neither is a course.
    expect(response.json().error.code).toMatch(/^(COURSE_IMPORT_FORMAT_UNSUPPORTED|TRACK_FIT_)/);
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('refuses an empty file and a file past the import bound', async () => {
    const { app, courses } = setup();
    const empty = await importFile(app, {
      name: '빈 파일',
      originalFilename: null,
      selection: null,
      fileBase64: base64(''),
    });
    expect(empty.statusCode).toBe(400);
    const oversize = await importFile(app, {
      name: '큰 파일',
      originalFilename: null,
      selection: null,
      fileBase64: 'A'.repeat(4 * 1024 * 1024 * 2),
    });
    expect([400, 413]).toContain(oversize.statusCode);
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('has no place for a geometry, a distance or a vertex count in the request', async () => {
    const { app, courses } = setup();
    for (const extra of [
      { geometry: { type: 'LineString', coordinates: [] } },
      { distanceMeters: 100 },
      { vertexCount: 2 },
      { coordinates: [[127.02, 37.5]] },
    ]) {
      const response = await importFile(app, {
        name: '클라이언트 형상',
        originalFilename: null,
        selection: null,
        fileBase64: base64(singleRoute),
        ...extra,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('requires authentication, CSRF and an idempotency key', async () => {
    const unauthenticated = setup({ authenticated: false });
    const refused = await importFile(unauthenticated.app, {
      name: null,
      originalFilename: null,
      selection: null,
      fileBase64: base64(singleRoute),
    });
    expect(refused.statusCode).toBe(401);
    const { app, courses } = setup();
    const noCsrf = await importFile(
      app,
      { name: null, originalFilename: null, selection: null, fileBase64: base64(singleRoute) },
      { cookie: 'session=fixture', 'x-workout-session-id': 'current' },
    );
    expect(noCsrf.statusCode).toBe(403);
    const noKey = await importFile(
      app,
      { name: null, originalFilename: null, selection: null, fileBase64: base64(singleRoute) },
      baseHeaders,
    );
    expect(noKey.statusCode).toBe(400);
    expect(courses.create).not.toHaveBeenCalled();
  });

  it('replays a successful resend instead of importing a second course', async () => {
    const { app, courses } = setup();
    (courses.replayCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      courseId,
      courseRevision: 1,
    });
    const response = await importFile(app, {
      name: null,
      originalFilename: null,
      selection: null,
      fileBase64: base64(singleRoute),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('imported');
    expect(courses.create).not.toHaveBeenCalled();
  });
});

describe('course preferences', () => {
  it('lists the owner preferences', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/bff/v1/courses/preferences',
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      preferences: [{ courseId, favourite: true, lastUsedAt: createdAt }],
      total: 1,
    });
  });

  it('persists only the two allowlisted fields', async () => {
    const { app, preferences } = setup();
    const accepted = await app.inject({
      method: 'PUT',
      url: '/bff/v1/courses/preferences',
      headers: baseHeaders,
      payload: { courseId, update: { favourite: true } },
    });
    expect(accepted.statusCode).toBe(200);
    expect(preferences.write).toHaveBeenCalledWith(athleteId, courseId, { favourite: true });
    for (const update of [
      { favourite: true, note: '집 근처' },
      { lastUsedAt: '2020-01-01T00:00:00.000Z' },
      { colour: 'red' },
      {},
    ]) {
      const refused = await app.inject({
        method: 'PUT',
        url: '/bff/v1/courses/preferences',
        headers: baseHeaders,
        payload: { courseId, update },
      });
      expect(refused.statusCode).toBe(400);
    }
    expect(preferences.write).toHaveBeenCalledTimes(1);
  });

  it('answers a preference for a course that is not the caller with a missing course', async () => {
    const { app, preferences } = setup();
    (preferences.write as ReturnType<typeof vi.fn>).mockRejectedValue(new CoursePreferenceError());
    const response = await app.inject({
      method: 'PUT',
      url: '/bff/v1/courses/preferences',
      headers: baseHeaders,
      payload: { courseId, update: { markUsed: true } },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('COURSE_NOT_FOUND');
  });
});

describe('every write on these routes', () => {
  it('requires CSRF for a cookie session', async () => {
    const { app, preferences } = setup();
    const headers = { cookie: 'session=fixture', 'x-workout-session-id': 'current' };
    for (const [method, url, payload] of [
      ['PUT', '/bff/v1/courses/preferences', { courseId, update: { favourite: true } }],
      [
        'POST',
        '/bff/v1/courses/privacy-zones',
        { name: '집', center: [127.02, 37.5], radiusMeters: 300 },
      ],
      ['DELETE', `/bff/v1/courses/privacy-zones/${zoneId}`, undefined],
      ['POST', '/bff/v1/courses/place-search', { query: '남산', near: null }],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers,
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode).toBe(403);
    }
    expect(preferences.write).not.toHaveBeenCalled();
    expect(preferences.createPrivacyZone).not.toHaveBeenCalled();
    expect(preferences.removePrivacyZone).not.toHaveBeenCalled();
  });

  it('authenticates before it reads or writes a preference or an area', async () => {
    const { app, preferences } = setup({ authenticated: false });
    for (const [method, url] of [
      ['GET', '/bff/v1/courses/preferences'],
      ['GET', '/bff/v1/courses/privacy-zones'],
    ] as const) {
      const response = await app.inject({ method, url, headers: baseHeaders });
      expect(response.statusCode).toBe(401);
    }
    expect(preferences.list).not.toHaveBeenCalled();
    expect(preferences.listPrivacyZones).not.toHaveBeenCalled();
  });
});

describe('protected areas', () => {
  it('lists areas with an identity that covers no centre', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: '/bff/v1/courses/privacy-zones',
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.zoneSetDigest).toBe(privacyZoneSetDigest([zone]));
    expect(body.zones[0].center).toEqual([127.02, 37.5]);
  });

  it('refuses a radius outside the bounds', async () => {
    const { app, preferences } = setup();
    for (const radiusMeters of [10, 50_000]) {
      const response = await app.inject({
        method: 'POST',
        url: '/bff/v1/courses/privacy-zones',
        headers: baseHeaders,
        payload: { name: '집', center: [127.02, 37.5], radiusMeters },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(preferences.createPrivacyZone).not.toHaveBeenCalled();
  });

  it('reports a quota refusal rather than an unexpected error', async () => {
    const { app, preferences } = setup();
    (preferences.createPrivacyZone as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PrivacyZoneStateError('PRIVACY_ZONE_QUOTA_EXCEEDED'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses/privacy-zones',
      headers: baseHeaders,
      payload: { name: '집', center: [127.02, 37.5], radiusMeters: 300 },
    });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('PRIVACY_ZONE_QUOTA_EXCEEDED');
  });

  it('removes one area', async () => {
    const { app, preferences } = setup();
    const response = await app.inject({
      method: 'DELETE',
      url: `/bff/v1/courses/privacy-zones/${zoneId}`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(preferences.removePrivacyZone).toHaveBeenCalledWith(athleteId, zoneId);
  });
});

describe('privacy trim through the course ledger', () => {
  function trim(app: ReturnType<typeof createApi>, digest: string) {
    return app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: { ...commandHeaders, 'idempotency-key': 'course-trim-0001' },
      payload: {
        expectedRevision: 1,
        change: { kind: 'privacy-trim', acknowledgedZoneSetDigest: digest },
      },
    });
  }

  it('appends a derived revision and never rewrites the one it trimmed', async () => {
    const { app, courses } = setup();
    const response = await trim(app, privacyZoneSetDigest([zone]));
    expect(response.statusCode).toBe(200);
    const [, , expectedRevision, content] = (courses.update as ReturnType<typeof vi.fn>).mock
      .calls[0] as [
      string,
      string,
      number,
      { generation: { kind: string }; edit: unknown; coordinates: unknown[] },
    ];
    // CAS against the revision the screen was showing: the trim is an append.
    expect(expectedRevision).toBe(1);
    expect(content.edit).toEqual({ kind: 'privacy-trimmed' });
    expect(content.generation.kind).toBe('privacy-trimmed');
    // The first vertex was inside the area; what is written starts after it.
    expect(content.coordinates).toEqual([
      [127.03, 37.51],
      [127.04, 37.52],
    ]);
  });

  it('refuses a trim acknowledging an area set that has changed', async () => {
    const { app, courses } = setup();
    const response = await trim(app, 'f'.repeat(64));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('COURSE_ZONE_ACKNOWLEDGEMENT_STALE');
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('refuses a trim when the owner has no protected area', async () => {
    const { app, courses } = setup({ zones: [] });
    const response = await trim(app, privacyZoneSetDigest([]));
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('COURSE_TRIM_NO_PROTECTED_AREA');
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('refuses a course that re-enters the area and stores nothing', async () => {
    const { app, courses } = setup({
      headGeometry: [
        [127.03, 37.51],
        [127.02, 37.5],
        [127.04, 37.52],
      ],
    });
    const response = await trim(app, privacyZoneSetDigest([zone]));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('COURSE_TRIM_SPLITS_THE_LINE');
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('tells a crossing line apart from a re-entering one, and stores nothing', async () => {
    // Every vertex is well outside the 200 m area; the straight line between them runs
    // over its centre. Nothing re-enters, so the owner is not told that it does.
    const { app, courses } = setup({
      headGeometry: [
        [127.01, 37.5],
        [127.03, 37.5],
      ],
    });
    const response = await trim(app, privacyZoneSetDigest([zone]));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('COURSE_TRIM_LINE_CROSSES_AREA');
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('says a course never enters an area rather than writing a copy of it', async () => {
    const { app, courses } = setup({
      headGeometry: [
        [127.03, 37.51],
        [127.04, 37.52],
      ],
    });
    const response = await trim(app, privacyZoneSetDigest([zone]));
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('COURSE_TRIM_CHANGES_NOTHING');
    expect(courses.update).not.toHaveBeenCalled();
  });

  it('has no place for a geometry in a trim request', async () => {
    const { app, courses } = setup();
    const response = await app.inject({
      method: 'PATCH',
      url: `/bff/v1/courses/${courseId}`,
      headers: { ...commandHeaders, 'idempotency-key': 'course-trim-0002' },
      payload: {
        expectedRevision: 1,
        change: {
          kind: 'privacy-trim',
          acknowledgedZoneSetDigest: privacyZoneSetDigest([zone]),
          geometry: { type: 'LineString', coordinates: [] },
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(courses.update).not.toHaveBeenCalled();
  });
});

describe('self-hosted place search and elevation', () => {
  it('searches our own data over POST, so no position enters a request line', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses/place-search',
      headers: baseHeaders,
      payload: { query: '남산', near: [126.9779, 37.5663] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe('results');
    expect(body.dataset.licence).toBe('ODbL-1.0');
    expect(body.dataset.updateCadence).toBe('월 1회');
    expect(body.places[0].name).toBe('남산');
    // There is no GET for this: a bias position must not travel in a URL.
    const asGet = await app.inject({
      method: 'GET',
      url: '/bff/v1/courses/place-search?query=남산',
      headers: baseHeaders,
    });
    // There is no GET route for a search: the path is read as a course id and refused.
    expect([400, 404]).toContain(asGet.statusCode);
  });

  it('says it has no dataset rather than implying the place does not exist', async () => {
    const { app } = setup({ datasets: false });
    const response = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses/place-search',
      headers: baseHeaders,
      payload: { query: '남산', near: null },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'no_dataset' });
  });

  it('answers an elevation profile with its dataset and its unknowns', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/elevation`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe('profile');
    expect(body.points[0]).toEqual({
      vertexIndex: 0,
      elevationMeters: 42,
      sourceDistanceMeters: 0,
    });
    expect(body.points[1].elevationMeters).toBeNull();
    expect(body.knownCount).toBe(1);
    expect(body).not.toHaveProperty('ascentMeters');
  });

  it('says so when no elevation dataset is deployed', async () => {
    const { app } = setup({ datasets: false });
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/elevation`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'no_dataset' });
  });

  it('refuses an elevation request for a course that is not the caller', async () => {
    const { app, courses } = setup();
    (courses.read as ReturnType<typeof vi.fn>).mockRejectedValue(new CourseNotFoundError());
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/elevation`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(404);
  });

  it('authenticates place search and elevation', async () => {
    const { app } = setup({ authenticated: false });
    const search = await app.inject({
      method: 'POST',
      url: '/bff/v1/courses/place-search',
      headers: baseHeaders,
      payload: { query: '남산', near: null },
    });
    expect(search.statusCode).toBe(401);
    const elevation = await app.inject({
      method: 'GET',
      url: `/bff/v1/courses/${courseId}/elevation`,
      headers: baseHeaders,
    });
    expect(elevation.statusCode).toBe(401);
  });
});
