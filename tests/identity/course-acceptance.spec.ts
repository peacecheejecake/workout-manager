import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import {
  activityDeletionImpactSchema,
  courseListSchema,
  coursePrivacyZoneListSchema,
  courseReadResultSchema,
  courseThumbnailPath,
  type CourseReadResult,
} from '../../packages/contracts/src/courses';
import {
  fitFile,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';
import { parseCurrentAccountExport } from './account-export';
import { expectLineDrawn, mapRegion } from './map-evidence';

/**
 * M2-01k: one continuous map-and-course flow against the real stack — the real OIDC
 * session, API, isolated PostgreSQL, local object store, thumbnail render worker and the
 * built web shell.
 *
 * Every step below already has a spec of its own. What those fragments cannot catch is a
 * regression in the HAND-OFF between them, because each one starts from a fresh course. So
 * here there is exactly one account, one recording and two course ids, and each step
 * consumes what the previous one left behind:
 *
 *   recording → course cut from it → waypoint reroute (reviewed, explicit save)
 *   → target-distance candidate picked and saved → a second course imported from GPX
 *   → privacy trim of the import → stored thumbnails of both heads (and not for Bob)
 *   → GPX export and account export carry both → the recording is deleted
 *   → the derived course and its picture are reclaimed, the imported one is untouched
 *   → re-importing the deleted recording is suppressed and brings nothing back.
 *
 * ROUTING MODE. The harness answers route requests from one of two engines, chosen by
 * `IDENTITY_E2E_ROUTING`: the deterministic fixture (default) or the self-hosted
 * GraphHopper through the production factory. This spec runs unchanged against both and
 * asserts which one it actually ran against, so a green run can never be mistaken for
 * evidence about the other.
 */
const routingMode = process.env['IDENTITY_E2E_ROUTING'] ?? 'fixture';

function expectedEngine() {
  if (routingMode === 'fixture')
    return { graphBuildId: '0123456789abcdef', engineVersion: 'identity-e2e-fixture' };
  if (routingMode === 'graphhopper') {
    const graphBuildId = process.env['IDENTITY_E2E_EXPECTED_GRAPH_BUILD_ID'];
    assert.ok(
      graphBuildId !== undefined && /^[0-9a-f]{16}$/.test(graphBuildId),
      'IDENTITY_E2E_ROUTING=graphhopper needs IDENTITY_E2E_EXPECTED_GRAPH_BUILD_ID',
    );
    return { graphBuildId, engineVersion: '10.0' };
  }
  throw new Error(`Unsupported IDENTITY_E2E_ROUTING: ${routingMode}`);
}

// Near Seoul City Hall, so a real Seoul pedestrian graph can snap every point.
const start = Date.parse('2026-03-01T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const longitude = (index: number) => 126.978 + index / 2000;
const latitude = (index: number) => 37.566 + index / 2000;

const fitBytes = Buffer.from(
  fitFile([
    sessionMessage({ startedAt: at(0), elapsedSeconds: 40, distanceMeters: 512 }),
    ...[0, 1, 2, 3, 4].map((index) =>
      recordMessage({
        at: at(index * 10),
        longitude: longitude(index),
        latitude: latitude(index),
        heartRate: 140 + index,
        distanceMeters: index * 128,
      }),
    ),
  ]),
);

const gpxDocument = (name: string, points: [number, number][]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="identity-e2e" xmlns="http://www.topografix.com/GPX/1/1">` +
  `<rte><name>${name}</name>` +
  points.map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`).join('') +
  `</rte></gpx>\n`;

/**
 * The imported course, well away from the recording. It starts inside the protected area
 * added below and then walks out of it, so the trim removes exactly the first two vertices.
 */
const importedPoints: [number, number][] = [
  [126.99, 37.57],
  [126.9901, 37.5701],
  [127.0, 37.575],
  [127.005, 37.58],
];

const recordedName = 'M2-01k 기록에서 자른 코스';
const importedName = 'M2-01k 가져온 코스';
const zoneName = 'M2-01k 보호 구역';

type Headers = Record<string, string>;

async function login(page: Page, name: 'Alice' | 'Bob'): Promise<Headers> {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

/** Stores a genuine FIT recording; the server re-parses the bytes itself. */
async function storeTrack(page: Page, headers: Headers) {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'e'.repeat(64) },
    activity: {
      title: `M2-01k 원본 기록 ${randomUUID()}`,
      kind: 'running',
      startedAt: at(0),
      timezone: 'UTC',
      durationSeconds: 40,
      durationKind: 'elapsed',
      distanceMeters: 512,
    },
  });
  const { idempotencyKey, ...body } = command;
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(imported.status()).toBe(200);
  const result = activityImportResultSchema.parse(await imported.json());
  expect(result.outcome).toBe('imported');
  const reserved = await page.request.post(
    `/bff/v1/activities/${result.activityId}/track-uploads`,
    {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedActivityRevision: result.revision, recordedTrackIndex: 0 },
    },
  );
  expect(reserved.status()).toBe(200);
  const reservation = (await reserved.json()) as { uploadId: string };
  const uploaded = await page.request.put(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/content`,
    {
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-track-file-name': encodeURIComponent('acceptance.fit'),
      },
      data: fitBytes,
    },
  );
  expect(uploaded.status()).toBe(200);
  const finalized = await page.request.post(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/finalize`,
    { headers: { ...headers, 'idempotency-key': randomUUID() } },
  );
  expect(finalized.status()).toBe(200);
  return { result, importBody: body };
}

async function readCourse(page: Page, headers: Headers, courseId: string) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(response.status()).toBe(200);
  return courseReadResultSchema.parse(await response.json());
}

function available(read: CourseReadResult) {
  assert.equal(read.status, 'available');
  if (read.status !== 'available') throw new Error('Expected an available course');
  return read;
}

async function readyThumbnail(page: Page, headers: Headers, courseId: string, revision: number) {
  // The render worker leases on its own schedule; wait on the server's answer.
  await expect
    .poll(
      async () => {
        const read = available(await readCourse(page, headers, courseId));
        return `${read.thumbnail.status}@${'courseRevision' in read.thumbnail ? read.thumbnail.courseRevision : '-'}`;
      },
      { timeout: 20_000 },
    )
    .toBe(`ready@${revision}`);
  const read = available(await readCourse(page, headers, courseId));
  assert.equal(read.thumbnail.status, 'ready');
  if (read.thumbnail.status !== 'ready') throw new Error('Expected a ready thumbnail');
  return { read, thumbnail: read.thumbnail };
}

function patchOf(page: Page, courseId: string) {
  return page.waitForRequest(
    (request) =>
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname === `/bff/v1/courses/${courseId}`,
  );
}

async function errorCode(response: { json(): Promise<unknown> }) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code;
}

async function asBob(
  browser: Browser,
  origin: string,
  check: (page: Page, headers: Headers) => Promise<void>,
) {
  const context = await browser.newContext({ baseURL: origin });
  try {
    const page = await context.newPage();
    await check(page, await login(page, 'Bob'));
  } finally {
    await context.close();
  }
}

test('one account carries a recording through courses, thumbnails, exports and deletion', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const engine = expectedEngine();
  test
    .info()
    .annotations.push(
      { type: 'routing-mode', description: routingMode },
      { type: 'expected-graph-build-id', description: engine.graphBuildId },
    );

  const headers = await login(page, 'Alice');
  const origin = new URL(page.url()).origin;
  await page.setViewportSize({ width: 1280, height: 900 });
  const { result: activity, importBody } = await storeTrack(page, headers);
  const activityId = activity.activityId;

  try {
    // ── 1. The recording is stored and the route screen reads it back after a full load.
    await page.goto(`/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    await expect(panel).toContainText('전체 5개 · 위치 있음 5개 · 구간 1개');
    const storedTrack = await page.request.get(`/bff/v1/activities/${activityId}/track`, {
      headers,
    });
    expect(storedTrack.status()).toBe(200);
    expect(
      ((await storedTrack.json()) as { track: { trackRevision: number } }).track.trackRevision,
    ).toBe(1);

    // ── 2. A course cut from that recording, through the screen.
    const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
    await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
    await courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' }).click();
    await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
    await courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' }).click();
    await expect(courseSection.getByTestId('course-range')).toHaveText('시작 0:0 · 끝 0:4');
    await courseSection.getByLabel('코스 이름').fill(recordedName);
    const createRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname === '/bff/v1/courses',
    );
    await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
    await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');
    const createBody = (await createRequest).postDataJSON() as {
      name: string;
      from: { kind: string; activityId: string; trackRevision: number };
    };
    expect(createBody.from).toMatchObject({
      kind: 'recorded-segment',
      activityId,
      trackRevision: 1,
    });
    const created = available(
      courseReadResultSchema.parse(await (await (await createRequest).response())?.json()),
    );
    const recordedId = created.course.courseId;
    expect(created.revision.generation.kind).toBe('recorded-segment');
    expect(created.revision.lineage.map((entry) => entry.activityId)).toEqual([activityId]);
    expect(created.revision.geometry.coordinates).toHaveLength(5);

    // ── 3. Waypoint edit → engine proposal → review → explicit save, on the SAME course.
    // The course map must actually start a renderer: the Next shell once omitted the map
    // worker, and the screen still said "지도 표시 중" over an empty canvas (M2-01k).
    const mapWorker = page.waitForRequest(
      (request) =>
        new URL(request.url()).origin === new URL(page.url()).origin &&
        new URL(request.url()).pathname === '/dist/maplibre/maplibre-gl-worker.mjs',
      { timeout: 15_000 },
    );
    await page.goto('/courses');
    const workbench = page.getByRole('region', { name: '내 코스' });
    await workbench.getByRole('button', { name: recordedName, exact: true }).click();
    await mapWorker;
    // A requested worker is still only a proxy. What counts is that the renderer went idle
    // having DRAWN course-line features: `queryRenderedFeatures` over the line layer only,
    // so neither basemap tiles nor waypoint points can satisfy it, and the map's own
    // status line says so (M2-01q).
    await expectLineDrawn(mapRegion(workbench, '코스 지도'));
    await expect(workbench.getByTestId('course-revision')).toHaveText('1');
    await expect(workbench.getByTestId('course-generation')).toContainText('기록 구간 잘라내기');
    const editor = workbench.getByRole('region', { name: '경유지 편집' });
    const waypointItems = editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem');
    await expect(waypointItems).toHaveCount(2);
    await editor.getByLabel('경유점 경도').fill('126.9795');
    await editor.getByLabel('경유점 위도').fill('37.5675');
    await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
    await expect(waypointItems).toHaveCount(3);

    const proposalResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/bff/v1/courses/${recordedId}/route-proposals`,
    );
    await editor.getByRole('button', { name: '경로 계산' }).click();
    const proposalAnswer = await proposalResponse;
    const proposalBody = (await proposalAnswer.json()) as {
      outcome: string;
      proposal?: { computation: { graph: { graphBuildId: string } } };
    };
    // Reported verbatim, so a refusal from the real engine is visible in the failure.
    expect({ status: proposalAnswer.status(), outcome: proposalBody.outcome }).toEqual({
      status: 200,
      outcome: 'route_computed',
    });
    const review = editor.getByRole('group', { name: '계산된 경로 검토' });
    await expect(review.getByTestId('route-graph')).toHaveText(engine.graphBuildId);
    // The course recorded no graph, so there is no graph change to acknowledge.
    await expect(review.getByTestId('graph-changed')).toHaveCount(0);
    // A proposal is not a save.
    await expect(workbench.getByTestId('course-revision')).toHaveText('1');
    const rerouteSave = review.getByRole('button', { name: '검토한 경로 저장' });
    await expect(rerouteSave).toBeDisabled();
    await review.getByLabel('위 내용을 검토했습니다.').check();
    const reroutePatch = patchOf(page, recordedId);
    await rerouteSave.click();
    await expect(editor.getByText(/경로를 저장했습니다/)).toBeVisible();
    const rerouteBody = (await reroutePatch).postDataJSON() as {
      expectedRevision: number;
      change: { kind: string; acknowledgedGraph: { previous: string | null; next: string } };
    };
    expect(rerouteBody.expectedRevision).toBe(1);
    expect(rerouteBody.change.kind).toBe('reroute');
    expect(rerouteBody.change.acknowledgedGraph).toEqual({
      previous: null,
      next: engine.graphBuildId,
    });
    await expect(workbench.getByTestId('course-revision')).toHaveText('2');
    await expect(workbench.getByTestId('course-generation')).toContainText(
      `경유지 경로 계산 · 지도 데이터 ${engine.graphBuildId}`,
    );
    const rerouted = available(await readCourse(page, headers, recordedId));
    assert.equal(rerouted.revision.generation.kind, 'routed-waypoints');
    if (rerouted.revision.generation.kind !== 'routed-waypoints') throw new Error('unreachable');
    const routedGraph = rerouted.revision.generation.computation.graph;
    test.info().annotations.push({
      type: 'stored-graph',
      description: `${routedGraph.graphBuildId} engine ${String(routedGraph.engineVersion)} (${routedGraph.identitySource})`,
    });
    expect({
      graphBuildId: routedGraph.graphBuildId,
      engineVersion: routedGraph.engineVersion,
      identitySource: routedGraph.identitySource,
    }).toEqual({ ...engine, identitySource: 'engine' });
    expect(rerouted.revision.waypoints).toHaveLength(3);
    // The lineage to the recording survives the reroute: this is what deletion reclaims by.
    expect(rerouted.revision.lineage.map((entry) => entry.activityId)).toEqual([activityId]);

    // ── 4. Target-distance candidates on top of the rerouted head, picked and saved.
    const candidates = workbench.getByRole('region', { name: '목표 거리 후보' });
    await candidates.getByLabel('목표 거리(m)').fill('1200');
    const candidateResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/bff/v1/courses/${recordedId}/route-candidates`,
    );
    await candidates.getByRole('button', { name: '목표 거리 후보 생성' }).click();
    const candidateAnswer = await candidateResponse;
    const candidateBody = (await candidateAnswer.json()) as { outcome: string };
    expect({ status: candidateAnswer.status(), outcome: candidateBody.outcome }).toEqual({
      status: 200,
      outcome: 'candidates_generated',
    });
    await expect(candidates.getByTestId('candidate-set')).toBeVisible();
    await expect(candidates.getByTestId('candidate-knowledge-0')).toContainText('확인되지 않음');
    // Generating is not saving.
    await expect(workbench.getByTestId('course-revision')).toHaveText('2');
    await candidates.getByRole('button', { name: '1번 후보 보기' }).click();
    const pickedReview = candidates.getByTestId('candidate-review');
    // Same graph as the head, so nothing to acknowledge on screen.
    await expect(pickedReview.getByTestId('candidate-graph-changed')).toHaveCount(0);
    const pickSave = pickedReview.getByRole('button', { name: '고른 후보 저장' });
    await expect(pickSave).toBeDisabled();
    await pickedReview.getByLabel('위 후보 내용을 검토했습니다.').check();
    const pickPatch = patchOf(page, recordedId);
    await pickSave.click();
    await expect(workbench.getByTestId('course-revision')).toHaveText('3');
    const pickBody = (await pickPatch).postDataJSON() as {
      expectedRevision: number;
      change: { kind: string; acknowledgedGraph: { previous: string | null; next: string } };
    };
    expect(pickBody.expectedRevision).toBe(2);
    expect(pickBody.change.kind).toBe('pick-candidate');
    expect(pickBody.change.acknowledgedGraph).toEqual({
      previous: engine.graphBuildId,
      next: engine.graphBuildId,
    });
    await expect(workbench.getByTestId('course-generation')).toContainText(
      `목표 거리 후보 · 지도 데이터 ${engine.graphBuildId}`,
    );
    const looped = available(await readCourse(page, headers, recordedId));
    assert.equal(looped.revision.generation.kind, 'target-distance-loop');
    if (looped.revision.generation.kind !== 'target-distance-loop') throw new Error('unreachable');
    expect(looped.revision.generation.targetDistanceMeters).toBe(1200);
    expect(looped.revision.generation.computation.graph.graphBuildId).toBe(engine.graphBuildId);
    expect(looped.revision.generation.computation.graph.engineVersion).toBe(engine.engineVersion);
    expect(looped.revision.lineage.map((entry) => entry.activityId)).toEqual([activityId]);
    await expect(candidates.getByTestId('candidate-set')).toHaveCount(0);

    // ── 5. A second, independent course imported from a GPX file through the screen.
    await page.goto('/courses');
    const importPanel = workbench.getByRole('region', { name: 'GPX 가져오기' });
    await importPanel.getByLabel(/새 코스의 이름/).fill(importedName);
    await importPanel.getByLabel('가져올 GPX 파일').setInputFiles({
      name: 'acceptance.gpx',
      mimeType: 'application/gpx+xml',
      buffer: Buffer.from(gpxDocument(importedName, importedPoints), 'utf8'),
    });
    await importPanel.getByRole('button', { name: '가져오기' }).click();
    await expect(importPanel.getByRole('status')).toContainText(
      `코스를 가져왔습니다: ${importedName}`,
    );
    const listed = courseListSchema.parse(
      await (await page.request.get('/bff/v1/courses', { headers })).json(),
    );
    const importedHead = listed.courses.find((course) => course.name === importedName);
    assert.ok(importedHead);
    const importedId = importedHead.courseId;
    expect(importedId).not.toBe(recordedId);
    const importedRead = available(await readCourse(page, headers, importedId));
    expect(importedRead.revision.generation.kind).toBe('imported-file');
    // No recording of ours behind it, which is what keeps it out of the deletion below.
    expect(importedRead.revision.lineage).toEqual([]);

    // ── 6. Privacy trim of the imported course.
    await page.goto('/courses');
    await workbench.getByRole('button', { name: importedName, exact: true }).click();
    await expect(workbench.getByTestId('course-generation')).toContainText('가져온 파일');
    const privacy = workbench.getByRole('region', { name: '보호 구역' });
    await privacy.getByLabel('보호 구역 이름').fill(zoneName);
    await privacy.getByLabel('보호 구역 경도').fill('126.9900');
    await privacy.getByLabel('보호 구역 위도').fill('37.5700');
    await privacy.getByLabel('보호 구역 반경(m)').fill('300');
    await privacy.getByRole('button', { name: '보호 구역 추가' }).click();
    await expect(privacy.getByRole('button', { name: `${zoneName} 삭제` })).toBeVisible();
    await privacy.getByRole('button', { name: '보호 구역 제거본 만들기' }).click();
    await expect(privacy.getByText(/이전 수정본은 그대로 남아 있습니다/)).toBeVisible();
    await expect(workbench.getByTestId('course-revision')).toHaveText('2');
    await expect(workbench.getByTestId('course-generation')).toContainText(
      '보호 구역 제거본 · 수정본 1에서 파생',
    );
    const trimmed = available(await readCourse(page, headers, importedId));
    expect(trimmed.revision.generation.kind).toBe('privacy-trimmed');
    expect(trimmed.revision.geometry.coordinates).toHaveLength(2);
    expect(JSON.stringify(trimmed.revision.geometry.coordinates)).not.toContain('126.99,');
    // The trim touched only the course it was asked for.
    expect(available(await readCourse(page, headers, recordedId)).course.headRevision).toBe(3);

    // ── 7. Stored thumbnails of BOTH heads, served to the owner and to nobody else.
    const recordedPicture = await readyThumbnail(page, headers, recordedId, 3);
    const importedPicture = await readyThumbnail(page, headers, importedId, 2);
    expect(recordedPicture.thumbnail.revisionId).toBe(looped.revision.revisionId);
    expect(importedPicture.thumbnail.vertexCount).toBe(2);
    const fetchSvg = async (courseId: string) => {
      const response = await page.request.get(`/bff/v1/courses/${courseId}/thumbnail`, {
        headers,
      });
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toBe('image/svg+xml');
      expect(response.headers()['cache-control']).toBe('private, no-store');
      expect(response.headers()['content-security-policy']).toBe("default-src 'none'");
      return response.text();
    };
    const recordedSvg = await fetchSvg(recordedId);
    const loopPath = courseThumbnailPath(looped.revision.geometry.coordinates);
    assert.ok(loopPath);
    // The picture is of the head the candidate pick wrote, not of the cut or the reroute.
    expect(recordedSvg).toContain(`d="${loopPath.path}"`);
    expect(recordedSvg).not.toContain(recordedName);
    const importedSvg = await fetchSvg(importedId);
    const trimmedPath = courseThumbnailPath(trimmed.revision.geometry.coordinates);
    const untrimmedPath = courseThumbnailPath(importedRead.revision.geometry.coordinates);
    assert.ok(trimmedPath && untrimmedPath);
    expect(importedSvg).toContain(`d="${trimmedPath.path}"`);
    expect(importedSvg).not.toContain(untrimmedPath.path);
    await page.goto('/courses');
    await workbench.getByRole('button', { name: recordedName, exact: true }).click();
    await expect(workbench.getByTestId('course-thumbnail')).toHaveAttribute(
      'data-source',
      'stored',
    );
    await expect(workbench.getByTestId('course-thumbnail-state')).toHaveText(
      '저장된 썸네일을 보고 있습니다.',
    );
    await asBob(browser, origin, async (bob, bobHeaders) => {
      for (const courseId of [recordedId, importedId]) {
        const picture = await bob.request.get(`/bff/v1/courses/${courseId}/thumbnail`, {
          headers: bobHeaders,
        });
        expect(picture.status()).toBe(404);
        expect(await picture.text()).not.toContain('<svg');
        const read = await bob.request.get(`/bff/v1/courses/${courseId}`, { headers: bobHeaders });
        expect(read.status()).toBe(404);
        expect(await errorCode(read)).toBe('COURSE_NOT_FOUND');
        const gpx = await bob.request.get(`/bff/v1/courses/${courseId}/export.gpx`, {
          headers: bobHeaders,
        });
        expect(gpx.status()).toBe(404);
      }
      const bobList = courseListSchema.parse(
        await (await bob.request.get('/bff/v1/courses', { headers: bobHeaders })).json(),
      );
      expect(bobList.courses.map((course) => course.courseId)).not.toContain(recordedId);
      expect(bobList.courses.map((course) => course.courseId)).not.toContain(importedId);
    });

    // ── 8. GPX export: the screen's download is the same document the API serves.
    const downloadPromise = page.waitForEvent('download');
    await workbench.getByTestId('course-export').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.gpx$/);
    const downloadPath = await download.path();
    assert.ok(downloadPath);
    const downloadedGpx = await readFile(downloadPath, 'utf8');
    const recordedGpxResponse = await page.request.get(`/bff/v1/courses/${recordedId}/export.gpx`, {
      headers,
    });
    expect(recordedGpxResponse.status()).toBe(200);
    const recordedGpx = await recordedGpxResponse.text();
    expect(downloadedGpx).toBe(recordedGpx);
    expect(recordedGpx).toContain('<rte>');
    expect(recordedGpx).not.toContain('<trk>');
    expect(recordedGpx.match(/<rtept /g)).toHaveLength(looped.revision.geometry.coordinates.length);
    const importedGpxResponse = await page.request.get(`/bff/v1/courses/${importedId}/export.gpx`, {
      headers,
    });
    expect(importedGpxResponse.status()).toBe(200);
    const importedGpx = await importedGpxResponse.text();
    expect(importedGpx.match(/<rtept /g)).toHaveLength(2);
    expect(importedGpx).not.toContain('126.9900000');
    expect(importedGpx).not.toContain('126.9901000');
    expect(importedGpx).toContain('127.0050000');

    // ── 9. The account export, downloaded through the account screen, carries both.
    await page.goto('/account');
    await page.getByRole('button', { name: '내 데이터 내보내기 준비' }).click();
    const exportLink = page.getByRole('link', { name: '내 데이터 JSON 다운로드' });
    await expect(exportLink).toBeVisible();
    const exportDownload = page.waitForEvent('download');
    await exportLink.click();
    const exportPath = await (await exportDownload).path();
    assert.ok(exportPath);
    const before = parseCurrentAccountExport(JSON.parse(await readFile(exportPath, 'utf8')));
    const rowsOf = (rows: readonly Record<string, unknown>[], courseId: string) =>
      rows.filter((row) => row['course_id'] === courseId);
    expect(rowsOf(before.data.courses, recordedId)).toEqual([
      expect.objectContaining({ name: recordedName, status: 'available', head_revision: 3 }),
    ]);
    expect(rowsOf(before.data.courses, importedId)).toEqual([
      expect.objectContaining({ name: importedName, status: 'available', head_revision: 2 }),
    ]);
    const recordedRevisions = rowsOf(before.data.courseRevisions, recordedId);
    expect(recordedRevisions.map((row) => row['course_revision'])).toEqual([1, 2, 3]);
    expect(recordedRevisions.map((row) => (row['generation'] as { kind: string }).kind)).toEqual([
      'recorded-segment',
      'routed-waypoints',
      'target-distance-loop',
    ]);
    for (const row of recordedRevisions)
      expect(row['lineage']).toEqual([expect.objectContaining({ activity_id: activityId })]);
    expect(
      rowsOf(before.data.courseRevisions, importedId).map(
        (row) => (row['generation'] as { kind: string }).kind,
      ),
    ).toEqual(['imported-file', 'privacy-trimmed']);
    expect(rowsOf(before.data.courseThumbnails, recordedId)).toEqual([
      expect.objectContaining({
        course_revision: 3,
        content_hash: recordedPicture.thumbnail.contentHash,
      }),
    ]);
    expect(rowsOf(before.data.courseThumbnails, importedId)).toEqual([
      expect.objectContaining({
        course_revision: 2,
        content_hash: importedPicture.thumbnail.contentHash,
      }),
    ]);
    expect(before.data.coursePrivacyZones).toContainEqual(
      expect.objectContaining({ name: zoneName }),
    );
    // Geometry leaves only through the GPX export: none in the course ledger rows.
    const ledger = JSON.stringify([
      rowsOf(before.data.courses, recordedId),
      rowsOf(before.data.courseThumbnails, recordedId),
      rowsOf(before.data.courseThumbnails, importedId),
      recordedRevisions.map((row) => row['generation']),
    ]);
    expect(ledger).not.toMatch(/126\.9[78]/);
    expect(ledger).not.toContain('private/v1');

    // ── 10. Delete the recording. The confirmation names the derived course and only it.
    const impactResponse = await page.request.get(
      `/bff/v1/activities/${activityId}/deletion-impact`,
      { headers },
    );
    expect(impactResponse.status()).toBe(200);
    const impact = activityDeletionImpactSchema.parse(await impactResponse.json());
    expect(impact.courses).toEqual([{ courseId: recordedId, name: recordedName, headRevision: 3 }]);
    await page.goto(`/activities?selected=${activityId}`);
    await page.getByRole('button', { name: '이 활동 로컬 삭제' }).click();
    const impactRegion = page.getByRole('region', { name: '삭제 영향 코스' });
    await expect(impactRegion).toContainText('코스 1개도 함께 회수되어');
    await expect(impactRegion).toContainText(recordedName);
    await expect(impactRegion).not.toContainText(importedName);
    const deleteRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        new URL(request.url()).pathname === `/bff/v1/activities/${activityId}`,
    );
    await page.getByRole('button', { name: '이 활동 삭제 확인' }).click();
    await expect(page.getByText(/로컬 삭제가 확인되었습니다/)).toBeVisible();
    // The list the owner confirmed is the list the deletion re-checks.
    expect((await deleteRequest).postDataJSON()).toMatchObject({
      expectedCourseImpact: impact.digest,
    });
    const deleteResponse = await (await deleteRequest).response();
    expect(deleteResponse?.status()).toBe(204);

    // ── 11. The derived course is reclaimed: no geometry, no picture, no export, no edits.
    const reclaimed = await readCourse(page, headers, recordedId);
    expect(reclaimed.status).toBe('unavailable');
    if (reclaimed.status === 'unavailable')
      expect(reclaimed.course.reason).toBe('source_activity_deleted');
    expect(JSON.stringify(reclaimed)).not.toMatch(/126\.9[78]/);
    const reclaimedPicture = await page.request.get(`/bff/v1/courses/${recordedId}/thumbnail`, {
      headers,
    });
    expect(reclaimedPicture.status()).toBe(404);
    expect(await errorCode(reclaimedPicture)).toBe('COURSE_THUMBNAIL_NOT_FOUND');
    const reclaimedGpx = await page.request.get(`/bff/v1/courses/${recordedId}/export.gpx`, {
      headers,
    });
    expect(reclaimedGpx.status()).toBe(410);
    expect(await errorCode(reclaimedGpx)).toBe('COURSE_UNAVAILABLE');
    const reroute = await page.request.post(`/bff/v1/courses/${recordedId}/route-proposals`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        requestId: randomUUID(),
        draftRevision: 1,
        waypoints: [
          {
            role: 'start',
            position: [126.978, 37.566],
            name: null,
            sourceSampleId: null,
            locked: false,
          },
          {
            role: 'finish',
            position: [126.98, 37.568],
            name: null,
            sourceSampleId: null,
            locked: false,
          },
        ],
      },
    });
    expect(reroute.status()).toBe(410);
    const rename = await page.request.patch(`/bff/v1/courses/${recordedId}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedRevision: 3, change: { kind: 'rename', name: '되살리기 시도' } },
    });
    expect(rename.status()).toBe(410);

    // The screen says so in words.
    await page.goto('/courses');
    const recordedRow = workbench.locator('li').filter({ hasText: recordedName });
    await expect(recordedRow).toContainText('사용 불가 · 원본 기록 삭제됨');
    await workbench.getByRole('button', { name: recordedName, exact: true }).click();
    await expect(workbench.getByRole('alert')).toContainText(
      '활동 기록이 삭제되어 경로를 더 이상 사용할 수 없습니다',
    );

    // …and the imported course is NOT over-deleted: same head, same picture, same bytes.
    const importedRow = workbench.locator('li').filter({ hasText: importedName });
    await expect(importedRow).toContainText('수정 번호 2');
    const survivor = available(await readCourse(page, headers, importedId));
    expect(survivor.course.headRevision).toBe(2);
    expect(survivor.revision.revisionId).toBe(trimmed.revision.revisionId);
    expect(survivor.thumbnail).toEqual(importedPicture.thumbnail);
    expect(await fetchSvg(importedId)).toBe(importedSvg);
    const survivorGpx = await page.request.get(`/bff/v1/courses/${importedId}/export.gpx`, {
      headers,
    });
    expect(survivorGpx.status()).toBe(200);
    expect(await survivorGpx.text()).toBe(importedGpx);

    const afterExport = await page.request.post('/bff/v1/operations/export', { headers });
    expect(afterExport.status()).toBe(200);
    const after = parseCurrentAccountExport(await afterExport.json());
    expect(rowsOf(after.data.courses, recordedId)).toEqual([
      expect.objectContaining({
        status: 'unavailable',
        head_revision: null,
        revision_id: null,
        unavailable_reason: 'source_activity_deleted',
      }),
    ]);
    expect(rowsOf(after.data.courseRevisions, recordedId)).toEqual([]);
    expect(rowsOf(after.data.courseThumbnails, recordedId)).toEqual([]);
    expect(rowsOf(after.data.courseThumbnails, importedId)).toEqual(
      rowsOf(before.data.courseThumbnails, importedId),
    );
    expect(rowsOf(after.data.courseRevisions, importedId)).toEqual(
      rowsOf(before.data.courseRevisions, importedId),
    );

    // ── 12. "Restore": nothing brings the reclaimed course back.
    // The same recording source again is suppressed (V2-A20), not re-created …
    for (const replay of [
      importBody.source,
      { ...importBody.source, revision: 2, contentHash: 'd'.repeat(64) },
    ]) {
      const reimported = await page.request.post('/bff/v1/activity-imports', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { ...importBody, source: replay },
      });
      expect(reimported.status()).toBe(200);
      expect(activityImportResultSchema.parse(await reimported.json())).toMatchObject({
        outcome: 'suppressed',
        activityId,
      });
    }
    expect((await page.request.get(`/bff/v1/activities/${activityId}`, { headers })).status()).toBe(
      404,
    );
    expect(
      (await page.request.get(`/bff/v1/activities/${activityId}/track`, { headers })).status(),
    ).toBe(404);
    // … the exact selection the screen sent cannot cut the course again …
    const recut = await page.request.post('/bff/v1/courses', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: createBody,
    });
    expect(recut.status()).toBe(404);
    // … and the reclaimed course cannot be copied into a new one.
    const copy = await page.request.post('/bff/v1/courses', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        name: '복원 시도',
        from: { kind: 'course-copy', courseId: recordedId, expectedRevision: 3 },
      },
    });
    expect(copy.status()).toBe(410);
    expect(await errorCode(copy)).toBe('COURSE_UNAVAILABLE');
    const finalList = courseListSchema.parse(
      await (await page.request.get('/bff/v1/courses', { headers })).json(),
    );
    const mine = finalList.courses.filter((course) =>
      [recordedName, importedName, '복원 시도'].includes(course.name),
    );
    expect(mine.map((course) => [course.courseId, course.status])).toEqual(
      expect.arrayContaining([
        [recordedId, 'unavailable'],
        [importedId, 'available'],
      ]),
    );
    expect(mine).toHaveLength(2);
    expect((await readCourse(page, headers, recordedId)).status).toBe('unavailable');

    // ── 13. Deleting the surviving course itself reclaims its picture as well.
    const removed = await page.request.delete(`/bff/v1/courses/${importedId}?expectedRevision=2`, {
      headers,
    });
    expect(removed.status()).toBe(200);
    expect(await removed.json()).toEqual({ deleted: true });
    expect(
      (await page.request.get(`/bff/v1/courses/${importedId}/thumbnail`, { headers })).status(),
    ).toBe(404);
    expect((await page.request.get(`/bff/v1/courses/${importedId}`, { headers })).status()).toBe(
      404,
    );
  } finally {
    // Protected areas are account-wide and later specs trim against the whole set, so the
    // one added here must not outlive this test, whatever happened above.
    const zones = await page.request.get('/bff/v1/courses/privacy-zones', { headers });
    if (zones.status() === 200)
      for (const zone of coursePrivacyZoneListSchema.parse(await zones.json()).zones)
        if (zone.name === zoneName)
          expect(
            (
              await page.request.delete(`/bff/v1/courses/privacy-zones/${zone.zoneId}`, {
                headers,
              })
            ).status(),
          ).toBe(200);
    const remaining = await page.request.get(`/bff/v1/activities/${activityId}`, { headers });
    if (remaining.status() === 200) {
      const { revision } = (await remaining.json()) as { revision: number };
      await page.request.delete(`/bff/v1/activities/${activityId}`, {
        headers,
        data: { expectedRevision: revision },
      });
    }
  }
});
