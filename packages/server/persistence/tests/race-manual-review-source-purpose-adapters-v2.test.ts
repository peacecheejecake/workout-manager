import { courseRevisionSchema } from '@workout/contracts/courses';
import { courseContentDigest } from '@workout/server-courses/digest';
import { courseReadManifestSchema } from '../src/race-plan-impact-course-manifest.js';
import { captureRaceManualCoursePurposeV2In } from '../src/race-manual-review-source-purpose-adapters-v2.js';
import { it, expect } from 'vitest';
import type { Transaction } from '../src/database.js';
import { captureRaceManualLocalActivityPurposeV2In } from '../src/race-manual-review-source-purpose-adapters-v2.js';
import { impactDependencyDigest } from '../src/race-plan-impact-dependencies.js';
const id = 'a0000000-0000-4000-8000-000000000001';
const original = {
  title: 'Synthetic',
  kind: 'running',
  startedAt: null,
  durationSeconds: 0,
  durationKind: 'unknown',
  timezone: null,
  distanceMeters: null,
};
function fixture() {
  const source = {
    kind: 'fit',
    sourceId: 'Local-FIT-식',
    revision: 1,
    contentHash: 'a'.repeat(64),
  };
  const request = {
    activityId: id,
    canonicalRevision: 1,
    source,
    expectedOriginalDigest: impactDependencyDigest(original),
    expectedOverlayDigest: null,
    expectedOverlayRevision: null,
  };
  const meta = {
    id,
    revision: 1,
    deleted: false,
    kind: source.kind,
    source_id: source.sourceId,
    source_revision: 1,
    content_hash: source.contentHash,
    revision_hash: source.contentHash,
    suppressed: false,
    garmin: false,
    overlay_revision: null,
    bytes: 1000,
  };
  const body = { original, overlay: null, source_record: original };
  let calls = 0;
  const tx: Transaction = {
    athleteId: 'Synthetic',
    async query() {
      calls++;
      return { rows: calls === 1 ? [meta] : [body], rowCount: 1 };
    },
  };
  return { request, meta, body, tx, calls: () => calls };
}
for (const kind of ['fit', 'fixture', 'manual'] as const)
  it(`actual owned ${kind} tuple yields only local-use observation`, async () => {
    const f = fixture();
    f.request.source.kind = kind;
    f.meta.kind = kind;
    const r = await captureRaceManualLocalActivityPurposeV2In(f.tx, f.request, {
      bytes: 0n,
      sources: 0,
    });
    expect(r.status).toBe('observed_local_use');
    expect(r).toMatchObject({
      authority: 'none',
      sourceAuthentication: 'unverified',
      approvalAllowed: false,
    });
  });
for (const field of [
  'deleted',
  'suppressed',
  'garmin',
  'healthkit',
  'revision',
  'sourceHash',
  'sourceID',
  'rawBody',
  'expectedDigest',
] as const)
  it(`blocks ${field} without widening authority`, async () => {
    const f = fixture();
    if (field === 'deleted') f.meta.deleted = true;
    if (field === 'suppressed') f.meta.suppressed = true;
    if (field === 'garmin') f.meta.garmin = true;
    if (field === 'healthkit') f.meta.kind = 'healthkit';
    if (field === 'revision') f.meta.revision = 2;
    if (field === 'sourceHash') f.meta.revision_hash = 'b'.repeat(64);
    if (field === 'sourceID') f.meta.source_id = 'Different';
    if (field === 'rawBody') f.body.source_record = { ...original, title: 'Changed' };
    if (field === 'expectedDigest') f.request.expectedOriginalDigest = 'c'.repeat(64);
    expect(
      (await captureRaceManualLocalActivityPurposeV2In(f.tx, f.request, { bytes: 0n, sources: 0 }))
        .status,
    ).toBe('blocked');
  });
it('foreign/absent row is unavailable, with no body transport', async () => {
  let calls = 0;
  const tx: Transaction = {
    athleteId: 'Foreign',
    async query() {
      calls++;
      return { rows: [], rowCount: 0 };
    },
  };
  expect(
    await captureRaceManualLocalActivityPurposeV2In(tx, fixture().request, {
      bytes: 0n,
      sources: 0,
    }),
  ).toMatchObject({ status: 'blocked', reason: 'source_unavailable' });
  expect(calls).toBe(1);
});
it('response cap stops before body transport and preserves mutable shared budget', async () => {
  const f = fixture(),
    budget = { bytes: 4190000n, sources: 0 };
  await expect(
    captureRaceManualLocalActivityPurposeV2In(f.tx, f.request, budget),
  ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  expect(f.calls()).toBe(1);
  expect(budget.bytes).toBeGreaterThan(4190000n);
});
it('strict unknown fields and accessor inputs cannot execute a query or getter', async () => {
  const f = fixture();
  expect(
    await captureRaceManualLocalActivityPurposeV2In(
      f.tx,
      { ...f.request, permission: true },
      { bytes: 0n, sources: 0 },
    ),
  ).toMatchObject({ status: 'blocked' });
  let reads = 0;
  const input = {};
  Object.defineProperty(input, 'source', {
    enumerable: true,
    get() {
      reads++;
      return f.request.source;
    },
  });
  await expect(
    captureRaceManualLocalActivityPurposeV2In(f.tx, input, { bytes: 0n, sources: 0 }),
  ).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
  expect(reads).toBe(0);
  expect(f.calls()).toBe(0);
});
const courseId = 'aaaaaaaa-0000-4000-8000-000000000001';
const revisionId = 'bbbbbbbb-0000-4000-8000-000000000002';
const at = '2026-10-07T00:00:00Z';
const ref = { courseId, courseRevision: 1, revisionId };
function importedCourseFixture() {
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

it('an owned imported geometry with no actual manual recording cannot become manual course permission', async () => {
  const f = fixture();
  expect(
    await captureRaceManualCoursePurposeV2In(f.tx, importedCourseFixture(), {
      bytes: 0n,
      sources: 0,
    }),
  ).toMatchObject({ status: 'blocked', reason: 'course_lineage_use_unavailable' });
  expect(f.calls()).toBe(0);
});
it('recorded-segment metadata without an actual lineage port remains blocked before reads', async () => {
  const f = fixture(),
    course = importedCourseFixture();
  if (!course.owned?.revision) throw Error('FIXTURE_COURSE_MISSING');
  course.owned.revision.generation = {
    kind: 'recorded-segment',
    activityId: id,
    trackId: id,
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
  course.owned.revision.lineage = [{ activityId: id, trackId: id, trackRevision: 1 }];
  course.owned.revision.contentDigest = courseContentDigest({
    ...course.owned.revision,
    coordinates: course.owned.revision.geometry.coordinates,
  });
  course.digest = course.owned.revision.contentDigest;
  expect(
    await captureRaceManualCoursePurposeV2In(f.tx, course, { bytes: 0n, sources: 0 }),
  ).toMatchObject({ status: 'blocked', reason: 'course_lineage_use_unavailable' });
  expect(f.calls()).toBe(0);
});
