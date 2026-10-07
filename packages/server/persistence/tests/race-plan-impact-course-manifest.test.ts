import { describe, expect, it } from 'vitest';
import { courseRevisionSchema } from '@workout/contracts/courses';
import { courseContentDigest } from '@workout/server-courses/digest';
import {
  courseReadManifestSchema,
  validateCourseReadManifest,
} from '../src/race-plan-impact-course-manifest.js';

const courseId = 'aaaaaaaa-0000-4000-8000-000000000001';
const revisionId = 'bbbbbbbb-0000-4000-8000-000000000002';
const laterId = '00000000-0000-4000-8000-000000000003';
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
function blocked(input: unknown, reason: string) {
  const result = validateCourseReadManifest(scope, input);
  expect(result).toMatchObject({
    status: 'blocked',
    authority: 'none',
    freshness: 'not_checked',
    complete: false,
    digest: null,
  });
  expect(result.blockers).toContain(reason);
}

describe('course read manifest correspondence only', () => {
  it('preserves full owned imported geometry/provenance, null and zero without approval', () => {
    const capture = fixture(),
      before = structuredClone(capture);
    const result = validateCourseReadManifest(scope, capture);
    expect(result).toMatchObject({
      status: 'validated_read_scope',
      authority: 'none',
      freshness: 'not_checked',
      complete: false,
      blockers: [],
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.remaining).toHaveLength(5);
    expect(capture).toEqual(before);
    expect(capture.owned?.revision).toMatchObject({
      distanceMeters: 0,
      generation: { originalFilename: null, fileCreator: null },
    });
  });
  it('accepts absent course without fabricating source facts', () => {
    expect(validateCourseReadManifest({ athleteId: 'owner', eventCourse: null }, null).status).toBe(
      'validated_read_scope',
    );
  });
  it('blocks metadata-only old capture explicitly', () =>
    blocked({ ref, digest: fixture().digest }, 'course_owned_projection_port_missing'));
  it('blocks missing capture', () => blocked(null, 'course_reference_mismatch'));
  it('blocks foreign tenant', () => {
    const { capture, owned } = ownedFixture();
    owned.athleteId = 'other';
    blocked(capture, 'foreign_source');
  });
  it('blocks deleted owned course', () => {
    const { capture, owned } = ownedFixture();
    owned.deletion = { state: 'present', courseId };
    blocked(capture, 'course_deleted');
  });
  it('decodes reclaimed head without inventing a surviving geometry', () => {
    const capture = fixture();
    if (!capture.owned) throw new Error('fixture');
    capture.owned.head = {
      status: 'unavailable',
      courseId,
      name: '계획 코스',
      visibility: 'private',
      reason: 'source_activity_deleted',
      reclaimedAt: at,
      createdAt: at,
      updatedAt: at,
    };
    capture.owned.revision = null;
    blocked(capture, 'course_unavailable');
    blocked(capture, 'course_version_missing');
  });
  it('rejects wrong exact revision body identity', () => {
    const { capture, revision } = ownedFixture();
    revision.revisionId = laterId;
    blocked(capture, 'course_version_mismatch');
  });
  it('rejects ref/body courseRevision mismatch', () => {
    const { capture, revision } = ownedFixture();
    revision.courseRevision = 2;
    blocked(capture, 'course_version_mismatch');
  });
  it('allows an exact historical version under a later available head without repinning', () => {
    const { capture, owned, revision } = ownedFixture();
    owned.head = {
      ...owned.head,
      status: 'available',
      courseId,
      name: '새 코스',
      visibility: 'private',
      headRevision: 2,
      revisionId: laterId,
      createdAt: at,
      updatedAt: at,
    };
    expect(validateCourseReadManifest(scope, capture).status).toBe('validated_read_scope');
    expect(revision.revisionId).toBe(revisionId);
  });
  it('rejects older or false same-revision current head', () => {
    const { capture, owned } = ownedFixture();
    if (owned.head.status !== 'available') throw new Error('fixture');
    owned.head.revisionId = laterId;
    blocked(capture, 'course_head_mismatch');
  });
  it('rejects reused immutable revision ID on a newer head', () => {
    const { capture, owned } = ownedFixture();
    if (owned.head.status !== 'available') throw new Error('fixture');
    owned.head.headRevision = 2;
    blocked(capture, 'course_head_mismatch');
  });
  it('rejects capture digest disagreement', () => {
    const capture = fixture();
    capture.digest = 'b'.repeat(64);
    blocked(capture, 'course_digest_mismatch');
  });
  it('recomputes canonical full content hash, not only stored metadata', () => {
    const { capture, revision } = ownedFixture();
    revision.geometry.coordinates[1] = [127.02, 37.02];
    blocked(capture, 'course_digest_mismatch');
  });
  it('checks actual vertex count even under a matching canonical digest', () => {
    const { capture, revision } = ownedFixture();
    revision.generation.vertexCount = 3;
    refresh(capture);
    blocked(capture, 'course_geometry_mismatch');
  });
  it('rejects unknown permission flags rather than granting them', () => {
    const capture = fixture();
    blocked({ ...capture, permissionAllowed: true }, 'invalid_projection');
  });
  it('checks stable UUID identity while retaining original body', () => {
    const capture = fixture();
    expect(
      validateCourseReadManifest(
        {
          ...scope,
          eventCourse: {
            ...ref,
            courseId: courseId.toUpperCase(),
            revisionId: revisionId.toUpperCase(),
          },
        },
        capture,
      ).status,
    ).toBe('validated_read_scope');
  });
  it('blocks lineage missing actual source port', () => {
    const { capture, revision } = ownedFixture();
    revision.lineage = [{ activityId, trackId, trackRevision: 1 }];
    delete capture.lineageSources;
    refresh(capture);
    blocked(capture, 'lineage_source_port_missing');
  });
  it('rejects missing/extra lineage source correspondence', () => {
    const { capture, revision } = ownedFixture();
    revision.lineage = [{ activityId, trackId, trackRevision: 1 }];
    refresh(capture);
    blocked(capture, 'lineage_source_mismatch');
  });
  it('validates historical recording tuple and source metadata without repinning a newer activity', () => {
    const capture = recordedFixture(),
      before = structuredClone(capture);
    expect(validateCourseReadManifest(scope, capture).status).toBe('validated_read_scope');
    expect(capture).toEqual(before);
  });
  it.each(['foreign', 'deleted', 'suppressed', 'track-version', 'map-hash', 'duplicate'])(
    'blocks invalid actual recording source: %s',
    (kind) => {
      const capture = recordedFixture(),
        source = capture.lineageSources?.[0];
      if (!source) throw new Error('fixture');
      if (kind === 'foreign') source.athleteId = 'other';
      if (kind === 'deleted') source.activity.deleted = true;
      if (kind === 'suppressed') source.suppression = { state: 'present' };
      if (kind === 'track-version') source.track.trackRevision = 2;
      if (kind === 'map-hash')
        source.track.derivatives[1] = { kind: 'map_path', byteSize: 100, sha256: 'e'.repeat(64) };
      if (kind === 'duplicate') capture.lineageSources?.push(structuredClone(source));
      expect(validateCourseReadManifest(scope, capture).status).toBe('blocked');
    },
  );
  it('bounds total UTF8 input before nested decoding', () =>
    blocked({ huge: '한'.repeat(1_400_000) }, 'projection_limit'));
  it('rejects non-finite geometry and unsupported units', () => {
    const { capture, revision } = ownedFixture();
    revision.distanceMeters = Infinity;
    blocked(capture, 'invalid_projection');
  });
});
