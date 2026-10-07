import type { Transaction } from '../src/database.js';
import type { SourceBudget } from '../src/race-plan-impact-nested-sources.js';
import { captureCourseReadSources } from '../src/race-plan-impact-course-sources.js';
import { describe, expect, it } from 'vitest';
import { courseRevisionSchema } from '@workout/contracts/courses';
import { courseContentDigest } from '@workout/server-courses/digest';
import {
  courseReadManifestSchema,
  validateCourseReadManifest,
} from '../src/race-plan-impact-course-manifest.js';

const courseId = 'aaaaaaaa-0000-4000-8000-000000000001';
const revisionId = 'bbbbbbbb-0000-4000-8000-000000000002';
const activityId = '00000000-0000-4000-8000-000000000004';
const trackId = '00000000-0000-4000-8000-000000000005';
const at = '2026-10-07T00:00:00Z';
const ref = { courseId, courseRevision: 1, revisionId };
const scope = { athleteId: 'owner', eventCourse: ref };
function fixture() {
  const revision = courseRevisionSchema.parse({
    ...ref,
    name: '계획 코스',
    geometry: {
      type: 'LineString',
      coordinates: [
        [127, 37],
        [127.01, 37.01],
      ],
    },
    waypoints: [
      { role: 'start', position: [127, 37], name: null, sourceSampleId: null, locked: false },
      {
        role: 'finish',
        position: [127.01, 37.01],
        name: null,
        sourceSampleId: null,
        locked: false,
      },
    ],
    generation: {
      kind: 'imported-file',
      format: 'gpx',
      sourceKind: 'gpx-rte',
      itemIndex: 0,
      parserId: 'gpx-track-v1',
      parserVersion: 1,
      fileSha256: 'a'.repeat(64),
      fileByteLength: 320,
      originalFilename: null,
      fileCreator: null,
      vertexCount: 2,
      importedWaypointCount: 0,
      ignoredFileWaypointCount: 0,
    },
    edit: { kind: 'imported' },
    lineage: [],
    distanceMeters: 0,
    contentDigest: 'a'.repeat(64),
    createdAt: at,
  });
  revision.contentDigest = courseContentDigest({
    ...revision,
    coordinates: revision.geometry.coordinates,
  });
  return courseReadManifestSchema.parse({
    ref,
    digest: revision.contentDigest,
    owned: {
      athleteId: 'owner',
      head: {
        status: 'available',
        courseId,
        name: revision.name,
        visibility: 'private',
        headRevision: 1,
        revisionId,
        createdAt: at,
        updatedAt: at,
      },
      revision,
      deletion: { state: 'absent' },
    },
    lineageSources: [],
  });
}
function ownedFixture() {
  const capture = fixture();
  if (!capture.owned?.revision) throw new Error('fixture');
  return { capture, owned: capture.owned, revision: capture.owned.revision };
}
function refresh(capture: ReturnType<typeof fixture>) {
  if (!capture.owned?.revision) throw new Error('fixture');
  const revision = capture.owned.revision;
  revision.contentDigest = courseContentDigest({
    ...revision,
    coordinates: revision.geometry.coordinates,
  });
  capture.digest = revision.contentDigest;
}
function recordedFixture() {
  const { capture, revision } = ownedFixture();
  revision.generation = {
    kind: 'recorded-segment',
    activityId,
    trackId,
    trackRevision: 1,
    lineIndex: 0,
    segmentIndex: 0,
    startSampleId: '0:0',
    endSampleId: '0:1',
    vertexCount: 2,
    mapPathContentSha256: 'b'.repeat(64),
    simplificationVersion: 1,
    toleranceMeters: 0,
  };
  revision.lineage = [{ activityId, trackId, trackRevision: 1 }];
  capture.lineageSources = [
    {
      athleteId: 'owner',
      activity: { id: activityId, revision: 3, deleted: false },
      suppression: { state: 'absent' },
      track: {
        activityId,
        trackId,
        trackRevision: 1,
        sourceKind: 'manual',
        sourceId: 'manual-source',
        sourceRevision: 1,
        recordedSourceKind: 'gpx-trk',
        correspondence: {
          algorithm: 'track-correspondence-v1',
          parserId: 'gpx-track-v1',
          parserVersion: 1,
          digest: 'c'.repeat(64),
        },
        file: { originalFileName: null, format: 'gpx', byteSize: 320, sha256: 'a'.repeat(64) },
        derivatives: [
          { kind: 'normalized', byteSize: 100, sha256: 'd'.repeat(64) },
          { kind: 'map_path', byteSize: 100, sha256: 'b'.repeat(64) },
        ],
        sampleCount: 2,
        positionedSampleCount: 2,
        segmentCount: 1,
        segmentPolicy: { version: 1, maxGapSeconds: 60, maxGapMeters: 200 },
        distances: { deviceReportedMeters: null, recomputedFromPositionsMeters: 0 },
        createdAt: at,
      },
    },
  ];
  refresh(capture);
  return capture;
}

function harness(capture = fixture()) {
  if (!capture.owned?.revision) throw Error('fixture owned revision');
  const { lineage, ...body } = capture.owned.revision;
  const replies: Record<string, unknown>[][] = [
    [{ available: true }],
    [{ deleted: false }],
    [
      {
        geometry_bytes: '100',
        waypoint_bytes: '100',
        generation_bytes: '100',
        edit_bytes: '100',
        bytes: '4496',
        lineage_count: String(lineage.length),
      },
    ],
    [{ count: String(lineage.length), bytes: String(lineage.length * 4096) }],
    [{ head: capture.owned.head, body }],
    lineage,
    (capture.lineageSources ?? []).map((s) => ({
      activity_id: s.activity.id,
      activity_revision: s.activity.revision,
      deleted: s.activity.deleted,
      track: s.track,
      suppressed: s.suppression.state === 'present',
    })),
  ];
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx: Transaction = {
    athleteId: 'owner',
    async query(sql, values) {
      calls.push({ sql, values });
      const rows = replies.shift();
      if (!rows) throw Error('unexpected query');
      return { rows, rowCount: rows.length };
    },
  };
  const budget: SourceBudget = { bytes: 0n, sources: 0 };
  return { replies, calls, tx, budget, capture };
}
describe('actual owned course read source projection', () => {
  it('reads no sources for absent event course', async () => {
    const h = harness();
    expect(await captureCourseReadSources(h.tx, null, h.budget)).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(h.budget).toEqual({ bytes: 0n, sources: 0 });
  });
  it.each([false, true])(
    'reads full persisted course and bounded exact lineage, recorded=%s',
    async (recorded) => {
      const h = harness(recorded ? recordedFixture() : fixture());
      expect(await captureCourseReadSources(h.tx, ref, h.budget)).toEqual(h.capture);
      expect(h.budget.sources).toBe(recorded ? 2 : 1);
      expect(validateCourseReadManifest(scope, h.capture).status).toBe('validated_read_scope');
      expect(h.calls[1]?.sql).toContain('EXISTS');
      expect(h.calls.every((c) => !c.sql.includes('FROM course_deletion'))).toBe(true);
      expect(h.calls.every((c) => !c.sql.includes('storage_ref'))).toBe(true);
      expect(h.calls.slice(2).every((c) => c.values?.[0] === 'owner')).toBe(true);
    },
  );
  it('uses historical requested tuple while preserving actual later current head', async () => {
    const c = fixture();
    if (!c.owned || c.owned.head.status !== 'available') throw Error('head');
    c.owned.head.headRevision = 2;
    c.owned.head.revisionId = activityId;
    const h = harness(c),
      got = await captureCourseReadSources(h.tx, ref, h.budget);
    expect(got?.owned?.revision?.courseRevision).toBe(1);
    expect(validateCourseReadManifest(scope, got).status).toBe('validated_read_scope');
  });
  it.each([false, null, 'true'])(
    'requires strict existing reader capability %s',
    async (available) => {
      const h = harness();
      h.replies[0] = [{ available }];
      await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
        code: available === false ? 'SOURCE_UNAVAILABLE' : 'INVALID_CONTEXT',
      });
      expect(h.calls).toHaveLength(1);
      expect(h.budget.bytes).toBe(0n);
    },
  );
  it('fails deleted course before coordinates and exposes only bounded deletion bool', async () => {
    const h = harness();
    h.replies[1] = [{ deleted: true }];
    await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.sql).toContain('d.athlete_id=$1 AND d.course_id=$2');
  });
  it('does not create requested revision or digest when owned revision is absent', async () => {
    const h = harness();
    h.replies[2] = [];
    await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(h.calls).toHaveLength(3);
  });
  it.each([
    'geometry_bytes',
    'waypoint_bytes',
    'generation_bytes',
    'edit_bytes',
    'lineage_count',
  ] as const)('bounds %s before body transport', async (field) => {
    const h = harness(),
      p = h.replies[2]?.[0];
    if (!p) throw Error('preflight');
    p[field] = field === 'lineage_count' ? '13' : '1048577';
    await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
      code: 'CONTEXT_UNAVAILABLE',
    });
    expect(h.calls).toHaveLength(3);
    expect(h.budget.bytes).toBe(0n);
  });
  it.each(['bytes', 'sources'] as const)(
    'reserves shared %s budget before geometry transport',
    async (field) => {
      const h = harness(recordedFixture());
      if (field === 'bytes') h.budget.bytes = 4194300n;
      else h.budget.sources = 5000;
      await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
        code: 'CONTEXT_UNAVAILABLE',
      });
      expect(h.calls).toHaveLength(4);
    },
  );
  it('refuses missing or foreign exact lineage track before body transport', async () => {
    const h = harness(recordedFixture());
    h.replies[3] = [{ count: '0', bytes: '0' }];
    await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    });
    expect(h.calls).toHaveLength(4);
  });
  it('keeps source deletion and suppression as facts, never source permission', async () => {
    const c = recordedFixture(),
      s = c.lineageSources?.[0];
    if (!s) throw Error('source');
    s.activity.deleted = true;
    s.suppression = { state: 'present' };
    const h = harness(c),
      got = await captureCourseReadSources(h.tx, ref, h.budget);
    expect(got?.lineageSources?.[0]?.suppression.state).toBe('present');
    expect(validateCourseReadManifest(scope, got).blockers).toContain('lineage_source_unavailable');
    expect(h.calls[6]?.sql).toContain('h.activity_id=a.id');
  });
  it('rejects wrong lineage track fulltuple without accepting asserted ownership', async () => {
    const h = harness(recordedFixture()),
      row = h.replies[6]?.[0];
    if (!row) throw Error('source');
    row.track = { ...recordedFixture().lineageSources?.[0]?.track, trackId: revisionId };
    await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
      code: 'INVALID_CONTEXT',
    });
  });
  it('rejects malformed persisted geometry', async () => {
    const h = harness(),
      row = h.replies[4]?.[0];
    if (!row) throw Error('body');
    row.body = {
      ...fixture().owned?.revision,
      geometry: { type: 'LineString', coordinates: [[0, 0]] },
    };
    await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
      code: 'INVALID_CONTEXT',
    });
  });
  it('preserves zero distance and unknown filename/creator without generating object proof', async () => {
    const h = harness(),
      got = await captureCourseReadSources(h.tx, ref, h.budget);
    expect(got?.owned?.revision).toMatchObject({
      distanceMeters: 0,
      generation: { originalFilename: null, fileCreator: null },
    });
  });
  it('propagates SQL permission failure for caller transaction rollback', async () => {
    const h = harness();
    h.tx.query = async () => {
      throw Object.assign(Error('permission'), { code: '42501' });
    };
    await expect(captureCourseReadSources(h.tx, ref, h.budget)).rejects.toMatchObject({
      code: '42501',
    });
  });
  it('rejects unknown ref keys and invalid budget before SQL', async () => {
    const h = harness();
    await expect(
      captureCourseReadSources(h.tx, { ...ref, granted: true }, h.budget),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    await expect(
      captureCourseReadSources(h.tx, ref, { bytes: -1n, sources: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
    expect(h.calls).toHaveLength(0);
  });
});
