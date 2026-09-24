import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { createActivityTrackFinalObjectKey } from '@workout/server-media/keys';
import type { ObjectStorage } from '@workout/server-media/object-storage';
import type {
  ActivityTrackRepository,
  PreparedActivityTrackObjects,
} from '@workout/server-persistence/activity-tracks';
import { createBoundedTrackParser } from '@workout/server-track-storage/parse-host';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coordinateProbes, valueProbes } from '@workout/server-courses/log-audit';
import { createApi } from '../src/app.js';
import { auditRouteLogs } from './log-audit-support.js';

const athleteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherAthleteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const activityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const trackId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const uploadId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const createdAt = '2026-09-19T01:00:00.000Z';
const csrfToken = 'c'.repeat(43);
const baseHeaders = {
  cookie: 'session=fixture',
  origin: 'https://workout.example',
  'x-workout-session-id': 'current',
  'x-csrf-token': csrfToken,
};
const commandHeaders = { ...baseHeaders, 'idempotency-key': 'track-command-0001' };

const gpx = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>아침</name><trkseg>
<trkpt lat="37.5" lon="127.02"><time>2026-03-01T00:00:00Z</time></trkpt>
<trkpt lat="37.5001" lon="127.0201"><time>2026-03-01T00:00:10Z</time></trkpt>
<trkpt lat="37.5002" lon="127.0202"><time>2026-03-01T00:00:20Z</time></trkpt>
</trkseg></trk></gpx>`;
const gpxBytes = Buffer.from(gpx, 'utf8');
const gpxSha256 = createHash('sha256').update(gpxBytes).digest('hex');
const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03]);

const reservation = {
  uploadId,
  activityId,
  trackId,
  state: 'reserved' as const,
  createdAt,
  updatedAt: createdAt,
};
const uploadContext = {
  uploadId,
  activityId,
  trackId,
  sourceKind: 'fit' as const,
  sourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  sourceRevision: 2,
  trackRevision: 1,
  recordedTrackIndex: 0,
  state: 'reserved' as const,
};
const track = {
  trackId,
  activityId,
  sourceKind: 'fit' as const,
  sourceId: uploadContext.sourceId,
  sourceRevision: 2,
  trackRevision: 1,
  recordedSourceKind: 'gpx-trk' as const,
  correspondence: {
    algorithm: 'track-correspondence-v1' as const,
    parserId: 'gpx-track-v1' as const,
    parserVersion: 1 as const,
    digest: 'a'.repeat(64),
  },
  file: {
    originalFileName: 'run.gpx',
    format: 'gpx' as const,
    byteSize: gpxBytes.byteLength,
    sha256: gpxSha256,
  },
  derivatives: [
    { kind: 'normalized' as const, byteSize: 512, sha256: 'b'.repeat(64) },
    { kind: 'map_path' as const, byteSize: 256, sha256: 'c'.repeat(64) },
  ],
  sampleCount: 3,
  positionedSampleCount: 3,
  segmentCount: 1,
  segmentPolicy: { version: 1 as const, maxGapSeconds: 60, maxGapMeters: 200 },
  distances: { deviceReportedMeters: null, recomputedFromPositionsMeters: 30 },
  createdAt,
};

const instances: ReturnType<typeof createApi>[] = [];

// Every app's log stream is kept and audited after each test (M2-01k-c2).
const logs = auditRouteLogs(
  [
    ...coordinateProbes([
      [127.02, 37.5],
      [127.0201, 37.5001],
      [127.0202, 37.5002],
    ]),
    ...valueProbes('token', [csrfToken, 'session=fixture']),
    ...valueProbes('body', ['아침', 'run.gpx', encodeURIComponent('아침 러닝.gpx')]),
  ],
  20,
);

function storageFixture(): ObjectStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async writeTemporary(key, body) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) chunks.push(chunk);
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (objects.has(key)) throw new Error('temporary object already exists');
      objects.set(key, bytes);
      return { key, sizeBytes: bytes.byteLength, modifiedAt: new Date(createdAt) };
    },
    async publishTemporary(temporaryKey, finalKey, expectation) {
      const bytes = objects.get(temporaryKey);
      if (bytes === undefined) throw new Error('missing temporary fixture object');
      objects.delete(temporaryKey);
      const outcome = objects.has(finalKey) ? 'already_present' : 'published';
      objects.set(finalKey, bytes);
      return { key: finalKey, outcome, ...expectation };
    },
    async open(key) {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return {
        key,
        sizeBytes: bytes.byteLength,
        modifiedAt: new Date(createdAt),
        body: Readable.from([bytes]),
      };
    },
    async stat(key) {
      const bytes = objects.get(key);
      return bytes === undefined
        ? null
        : { key, sizeBytes: bytes.byteLength, modifiedAt: new Date(createdAt) };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function setup(options: { authenticated?: boolean } = {}) {
  const storage = storageFixture();
  const tracks: ActivityTrackRepository = {
    getUpload: vi.fn().mockResolvedValue(reservation),
    getUploadContext: vi.fn().mockResolvedValue(uploadContext),
    reserve: vi.fn().mockResolvedValue(reservation),
    prepareObjects: vi.fn().mockResolvedValue({ ...reservation, state: 'prepared' as const }),
    markStaged: vi.fn().mockResolvedValue({ ...reservation, state: 'staged' as const }),
    publicationFenceOpen: vi.fn().mockResolvedValue(true),
    requeueObjects: vi.fn().mockResolvedValue({ requeued: 0 }),
    finalize: vi.fn().mockResolvedValue({ status: 'available', track }),
    fail: vi.fn().mockResolvedValue({ failed: true }),
    read: vi.fn().mockResolvedValue({ status: 'available', track }),
    resolveObject: vi.fn().mockResolvedValue(null),
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
    activityTracks: {
      tracks,
      storage,
      // The real bounded worker. The test process does not run under `tsx`, so the
      // loader is passed explicitly, exactly as the parse-host contract describes.
      parser: createBoundedTrackParser({
        execArgv: ['--import', 'tsx'],
        maxOldGenerationSizeMb: 256,
      }),
    },
    ...logs.options(),
  });
  instances.push(app);
  return { app, tracks, storage };
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((app) => app.close()));
});

describe('activity track API boundaries', () => {
  it('authenticates before any track work happens', async () => {
    const { app, tracks } = setup({ authenticated: false });
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/activities/${activityId}/track-uploads`,
      headers: commandHeaders,
      payload: { expectedActivityRevision: 1, recordedTrackIndex: 0 },
    });
    expect(response.statusCode).toBe(401);
    expect(tracks.reserve).not.toHaveBeenCalled();
  });

  it('requires CSRF for a cookie session', async () => {
    const { app, tracks } = setup();
    const response = await app.inject({
      method: 'POST',
      url: `/bff/v1/activities/${activityId}/track-uploads`,
      headers: { cookie: 'session=fixture', 'x-workout-session-id': 'current' },
      payload: { expectedActivityRevision: 1, recordedTrackIndex: 0 },
    });
    expect(response.statusCode).toBe(403);
    expect(tracks.reserve).not.toHaveBeenCalled();
  });

  it('derives the owner from the session and refuses an athlete id in the body', async () => {
    const { app, tracks } = setup();
    const accepted = await app.inject({
      method: 'POST',
      url: `/bff/v1/activities/${activityId}/track-uploads`,
      headers: commandHeaders,
      payload: { expectedActivityRevision: 3, recordedTrackIndex: 1 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(tracks.reserve).toHaveBeenCalledWith(
      athleteId,
      activityId,
      { expectedActivityRevision: 3, recordedTrackIndex: 1 },
      'track-command-0001',
    );
    const forged = await app.inject({
      method: 'POST',
      url: `/bff/v1/activities/${activityId}/track-uploads`,
      headers: commandHeaders,
      payload: { expectedActivityRevision: 3, recordedTrackIndex: 1, athleteId: otherAthleteId },
    });
    expect(forged.statusCode).toBe(400);
    expect(tracks.reserve).toHaveBeenCalledTimes(1);
  });

  it('has no place in its contract for a client parse result', async () => {
    const { app, tracks } = setup();
    for (const payload of [
      { expectedActivityRevision: 1, recordedTrackIndex: 0, sampleCount: 5 },
      { expectedActivityRevision: 1, recordedTrackIndex: 0, samples: [] },
      { expectedActivityRevision: 1, recordedTrackIndex: 0, storageRef: 'private/v1/tenants/x' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/bff/v1/activities/${activityId}/track-uploads`,
        headers: commandHeaders,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(tracks.reserve).not.toHaveBeenCalled();
  });

  it('re-parses the stored bytes on the server and records only what that parse produced', async () => {
    const { app, tracks, storage } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'application/octet-stream',
        'x-track-file-name': encodeURIComponent('아침 러닝.gpx'),
      },
      payload: gpxBytes,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'staged' });
    const prepared = vi.mocked(tracks.prepareObjects).mock
      .calls[0]?.[2] as PreparedActivityTrackObjects;
    expect(prepared.raw.sha256).toBe(gpxSha256);
    expect(prepared.raw.format).toBe('gpx');
    expect(prepared.parse.parserId).toBe('gpx-track-v1');
    expect(prepared.parse.sampleCount).toBe(3);
    expect(prepared.parse.positionedSampleCount).toBe(3);
    expect(prepared.parse.segmentCount).toBe(1);
    expect(prepared.parse.correspondenceDigest).toMatch(/^[0-9a-f]{64}$/);
    // Three objects, each under the server's own key scheme for this upload.
    const expectedRaw = createActivityTrackFinalObjectKey({
      tenantId: athleteId,
      activityId,
      trackId,
      uploadId,
      artifactKind: 'raw',
      sha256: gpxSha256,
      extension: 'gpx',
    });
    expect(prepared.raw.storageRef).toBe(expectedRaw);
    expect(storage.objects.has(expectedRaw)).toBe(true);
    expect(storage.objects.has(prepared.normalized.storageRef)).toBe(true);
    expect(storage.objects.has(prepared.mapPath.storageRef)).toBe(true);
    // No temporary object is left behind.
    expect([...storage.objects.keys()].some((key) => key.includes('/temporary/'))).toBe(false);
    // The stored normalized document carries the activity-source provenance, not the
    // local-file provenance a preview would have.
    const normalized = JSON.parse(
      new TextDecoder().decode(storage.objects.get(prepared.normalized.storageRef)),
    ) as { provenance: { kind: string; trackRevision: number } };
    expect(normalized.provenance).toEqual({
      kind: 'activity-source',
      activityId,
      sourceId: uploadContext.sourceId,
      sourceRevision: 2,
      trackRevision: 1,
    });
  });

  it('refuses a file the parser rejects and records the failure against the upload', async () => {
    const { app, tracks, storage } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
      headers: { ...baseHeaders, 'content-type': 'application/octet-stream' },
      payload: zipBytes,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: { code: 'TRACK_ARCHIVE_REJECTED' } });
    expect(tracks.fail).toHaveBeenCalledWith(athleteId, uploadId, 'TRACK_ARCHIVE_REJECTED');
    expect(tracks.prepareObjects).not.toHaveBeenCalled();
    // Nothing survives an upload that never became durable.
    expect([...storage.objects.keys()]).toHaveLength(0);
  });

  it('rejects a file name that carries control or angle-bracket characters', async () => {
    const { app, tracks } = setup();
    const response = await app.inject({
      method: 'PUT',
      url: `/bff/v1/activity-track-uploads/${uploadId}/content`,
      headers: {
        ...baseHeaders,
        'content-type': 'application/octet-stream',
        'x-track-file-name': encodeURIComponent('<script>run.gpx'),
      },
      payload: gpxBytes,
    });
    expect(response.statusCode).toBe(400);
    expect(tracks.prepareObjects).not.toHaveBeenCalled();
  });

  it('streams an authenticated download and never exposes the storage reference', async () => {
    const { app, tracks, storage } = setup();
    const key = createActivityTrackFinalObjectKey({
      tenantId: athleteId,
      activityId,
      trackId,
      uploadId,
      artifactKind: 'raw',
      sha256: gpxSha256,
      extension: 'gpx',
    });
    storage.objects.set(key, gpxBytes);
    vi.mocked(tracks.resolveObject).mockResolvedValue({
      storageRef: key,
      activityId,
      trackId,
      artifactKind: 'raw',
      mediaType: 'application/gpx+xml',
      byteSize: gpxBytes.byteLength,
      sha256: gpxSha256,
      originalFileName: 'run.gpx',
      trackRevision: 1,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/activities/${activityId}/track/content?variant=raw`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/gpx+xml');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-disposition']).toContain('run.gpx');
    expect(JSON.stringify(response.headers)).not.toContain('private/v1/tenants');
    expect(response.rawPayload.equals(gpxBytes)).toBe(true);
    expect(tracks.resolveObject).toHaveBeenCalledWith(athleteId, activityId, 'raw');
  });

  it('refuses to serve an object whose reference belongs to another tenant', async () => {
    const { app, tracks, storage } = setup();
    const foreign = createActivityTrackFinalObjectKey({
      tenantId: otherAthleteId,
      activityId,
      trackId,
      uploadId,
      artifactKind: 'raw',
      sha256: gpxSha256,
      extension: 'gpx',
    });
    storage.objects.set(foreign, gpxBytes);
    vi.mocked(tracks.resolveObject).mockResolvedValue({
      storageRef: foreign,
      activityId,
      trackId,
      artifactKind: 'raw',
      mediaType: 'application/gpx+xml',
      byteSize: gpxBytes.byteLength,
      sha256: gpxSha256,
      originalFileName: 'run.gpx',
      trackRevision: 1,
    });
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/activities/${activityId}/track/content?variant=raw`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private/v1/tenants');
  });

  it('reports a read of the stored track without any storage reference', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'GET',
      url: `/bff/v1/activities/${activityId}/track`,
      headers: baseHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'available' });
    expect(response.body).not.toContain('private/v1/tenants');
    expect(response.body).not.toContain('storageRef');
  });

  it('exposes no endpoint that deletes a stored track directly', async () => {
    const { app } = setup();
    for (const url of [
      `/bff/v1/activities/${activityId}/track`,
      `/bff/v1/activities/${activityId}/track/content`,
      `/bff/v1/activity-track-uploads/${uploadId}/content`,
    ]) {
      const response = await app.inject({ method: 'DELETE', url, headers: baseHeaders });
      expect(response.statusCode).toBe(404);
    }
  });
});
