import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import {
  fitFile,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';

/**
 * S13 private courses cut from a stored recording, against the real OIDC session, API,
 * PostgreSQL and object storage.
 *
 * The recording is genuinely stored — real FIT bytes, re-parsed by the server — and the
 * course is cut from the derivative the server itself produced. Deleting the activity
 * afterwards is what turns the course into an explicitly unavailable reference, and the
 * delete confirmation names it first.
 */
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

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
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

async function storeTrack(page: Page, headers: Record<string, string>) {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'f'.repeat(64) },
    activity: {
      title: `코스 원본 활동 ${randomUUID()}`,
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
        'x-track-file-name': encodeURIComponent('course.fit'),
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
  return result;
}

const routeAddress = (activityId: string) => `/activities?selected=${activityId}&detailTab=route`;

test('cuts a course from a stored recording, exports it and reclaims it with the activity', async ({
  page,
}) => {
  const headers = await login(page);
  const activity = await storeTrack(page, headers);

  await page.goto(routeAddress(activity.activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  await expect(panel).toBeVisible();
  const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
  await expect(courseSection).toBeVisible();

  // An explicit range: pick a sample, name it the start, pick another, name it the end.
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' }).click();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' }).click();
  await expect(courseSection.getByTestId('course-range')).toHaveText('시작 0:0 · 끝 0:4');
  await courseSection.getByLabel('코스 이름').fill('경복궁 한 바퀴');
  await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
  await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');

  // The recording itself did not move: the stored track is still revision 1.
  await expect(panel).toContainText('경로 수정 번호');
  const storedTrack = await page.request.get(`/bff/v1/activities/${activity.activityId}/track`, {
    headers,
  });
  expect(storedTrack.status()).toBe(200);
  expect(
    ((await storedTrack.json()) as { track: { trackRevision: number } }).track.trackRevision,
  ).toBe(1);

  // The course screen reads it back after a full load.
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  await expect(workbench).toContainText('공개 공유 기능은 없으며');
  await workbench.getByRole('button', { name: '경복궁 한 바퀴' }).click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  const courseUrl = await workbench.getByTestId('course-export').getAttribute('href');
  assert.ok(courseUrl);
  const courseId = courseUrl.split('/')[4];
  assert.ok(courseId);

  // The download the screen actually performs: a plain navigation cannot carry the
  // session header this API requires, so the click does the authenticated read itself.
  const downloadPromise = page.waitForEvent('download');
  await workbench.getByTestId('course-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.gpx$/);

  // The owner's authenticated GPX export is a route with waypoints, never a track.
  const exported = await page.request.get(courseUrl, { headers });
  expect(exported.status()).toBe(200);
  expect(exported.headers()['content-type']).toBe('application/gpx+xml; charset=utf-8');
  expect(exported.headers()['cache-control']).toBe('private, no-store');
  const gpx = await exported.text();
  expect(gpx).toContain('<rte>');
  expect(gpx).toContain('<rtept ');
  expect(gpx).not.toContain('<trk>');
  expect(gpx).not.toContain('<trkpt');

  // A rename carries the revision the screen was showing.
  await workbench.getByLabel('코스 이름').fill('경복궁 두 바퀴');
  await workbench.getByRole('button', { name: '이름 저장' }).click();
  // Scoped to the message itself: the map pane inside this region also has a status line.
  await expect(workbench.getByText(/이름을 저장했습니다\. 현재 수정 번호 2/)).toBeVisible();

  // The delete confirmation names the course before anything is deleted.
  await page.goto(`/activities?selected=${activity.activityId}`);
  await page.getByRole('button', { name: '이 활동 로컬 삭제' }).click();
  const impact = page.getByRole('region', { name: '삭제 영향 코스' });
  await expect(impact).toContainText('코스 1개도 함께 회수되어');
  await expect(impact).toContainText('경복궁 두 바퀴');
  await page.getByRole('button', { name: '이 활동 삭제 확인' }).click();
  await expect(page.getByText(/로컬 삭제가 확인되었습니다/)).toBeVisible();

  // What is left is an explicitly unavailable reference, with no geometry behind it.
  await page.goto('/courses');
  const reclaimed = page.getByRole('region', { name: '내 코스' });
  await expect(reclaimed).toContainText('사용 불가 · 원본 기록 삭제됨');
  await reclaimed.getByRole('button', { name: '경복궁 두 바퀴' }).click();
  await expect(reclaimed.getByRole('alert')).toContainText(
    '활동 기록이 삭제되어 경로를 더 이상 사용할 수 없습니다',
  );
  const afterDeletion = await page.request.get(`/bff/v1/courses/${courseId}/export.gpx`, {
    headers,
  });
  expect(afterDeletion.status()).toBe(410);
  const read = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(read.status()).toBe(200);
  const body = await read.text();
  expect(body).toContain('"status":"unavailable"');
  expect(body).not.toContain('126.97');
});

/**
 * Narrow-width, keyboard and IME behaviour of the screens this node changed.
 *
 * Aside cannot resize a viewport, so this part is Playwright's, as in M2-01e. It covers
 * what was built — the course list/detail and the "cut a course" section — and not the
 * S13 map/list layout, which this node did not build (see the progress note).
 */
test('keeps the course screens usable at 320px, by keyboard and during an IME composition', async ({
  page,
}) => {
  const headers = await login(page);
  const activity = await storeTrack(page, headers);
  await page.setViewportSize({ width: 320, height: 720 });

  await page.goto(routeAddress(activity.activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  // Mobile width shows one pane at a time; the course section lives in the summary pane.
  await panel.getByRole('tab', { name: '요약·표본' }).click();
  const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
  await expect(courseSection).toBeVisible();
  const overflow = async () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await overflow()).toBeLessThanOrEqual(0);

  // Keyboard only: focus the two range controls and the name field, and type into it.
  await panel.getByRole('tab', { name: '지도' }).click();
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await panel.getByRole('tab', { name: '요약·표본' }).click();
  const startButton = courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' });
  await startButton.focus();
  await expect(startButton).toBeFocused();
  await page.keyboard.press('Enter');
  await panel.getByRole('tab', { name: '지도' }).click();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await panel.getByRole('tab', { name: '요약·표본' }).click();
  const endButton = courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' });
  await endButton.focus();
  await page.keyboard.press('Enter');
  await expect(courseSection.getByTestId('course-range')).toHaveText('시작 0:0 · 끝 0:4');

  // Synthetic composition events cover the application guard; this is not OS IME evidence.
  const nameField = courseSection.getByLabel('코스 이름');
  await nameField.focus();
  await nameField.dispatchEvent('compositionstart', { data: 'ㅎ' });
  await nameField.fill('한');
  await nameField.dispatchEvent('compositionupdate', { data: '한' });
  await nameField.fill('한강');
  await nameField.dispatchEvent('compositionend', { data: '한강' });
  await expect(nameField).toHaveValue('한강');
  await expect(courseSection.getByRole('status')).toHaveCount(0);
  await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
  await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');

  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  await expect(workbench).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  const courseButton = workbench.getByRole('button', { name: '한강' });
  await courseButton.focus();
  await expect(courseButton).toBeFocused();
  await page.keyboard.press('Enter');
  const renameField = workbench.getByLabel('코스 이름');
  await expect(renameField).toBeVisible();
  await renameField.focus();
  await renameField.dispatchEvent('compositionstart', { data: 'ㅅ' });
  await renameField.fill('산책');
  await renameField.dispatchEvent('compositionend', { data: '산책' });
  await expect(renameField).toHaveValue('산책');
  expect(await overflow()).toBeLessThanOrEqual(0);
});

/**
 * S14 waypoint editing against the real stack (M2-01h).
 *
 * The routing engine itself is a deterministic fixture in this harness — a real
 * GraphHopper build and its verified graph are not present in a test environment — so what
 * this proves is our side of that boundary: the draft, the review, the explicit save, the
 * stored proposal becoming an immutable revision, and the graph identity surviving into it.
 * It is not evidence about pedestrian coverage or about a real engine's answers.
 */
test('edits waypoints, reviews the computed route and only then saves it', async ({ page }) => {
  const headers = await login(page);
  const activity = await storeTrack(page, headers);

  await page.goto(routeAddress(activity.activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' }).click();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' }).click();
  await courseSection.getByLabel('코스 이름').fill('경유지 편집 대상');
  await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
  await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  await workbench.getByRole('button', { name: '경유지 편집 대상' }).click();
  const editor = workbench.getByRole('region', { name: '경유지 편집' });
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId('draft-revision')).toHaveText('초안 변경 번호 1');
  await expect(editor.getByTestId('draft-conflict')).toHaveCount(0);
  await expect(workbench.getByTestId('course-generation')).toContainText('기록 구간 잘라내기');

  // A via waypoint placed by typing coordinates. No drag anywhere in this flow.
  await editor.getByLabel('경유점 경도').fill('126.9795');
  await editor.getByLabel('경유점 위도').fill('37.5675');
  await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    3,
  );
  await expect(editor.getByTestId('draft-revision')).toHaveText('초안 변경 번호 2');

  // Locking refuses the moves that would disturb it, in words, and changes nothing.
  await editor.getByRole('button', { name: '2번 잠그기' }).click();
  await editor.getByRole('button', { name: '2번 삭제' }).click();
  await expect(editor.getByRole('alert')).toContainText('잠긴 경유점입니다');
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    3,
  );
  await editor.getByRole('button', { name: '2번 잠금 해제' }).click();

  // Undo and redo, and the revision that never rewinds.
  await editor.getByRole('button', { name: '되돌리기' }).click();
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    3,
  );
  await editor.getByRole('button', { name: '다시 실행' }).click();
  await expect(editor.getByTestId('draft-revision')).toHaveText('초안 변경 번호 6');

  await editor.getByRole('button', { name: '경로 계산' }).click();
  const review = editor.getByRole('group', { name: '계산된 경로 검토' });
  await expect(review).toBeVisible();
  await expect(review).toContainText('경로 계산 예상 거리');
  await expect(review.getByTestId('route-graph')).toHaveText('0123456789abcdef');

  // Nothing has been saved yet: the course is still at the revision it was.
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  const beforeSave = await page.request.get(`/bff/v1/courses`, { headers });
  expect(beforeSave.status()).toBe(200);

  const save = review.getByRole('button', { name: '검토한 경로 저장' });
  await expect(save).toBeDisabled();
  await review.getByLabel('위 내용을 검토했습니다.').check();
  await save.click();
  await expect(editor.getByText(/경로를 저장했습니다/)).toBeVisible();

  // The stored revision records what computed it, and keeps the recording's lineage.
  await expect(workbench.getByTestId('course-revision')).toHaveText('2');
  await expect(workbench.getByTestId('course-generation')).toContainText('경유지 경로 계산');
  await expect(workbench.getByTestId('course-generation')).toContainText('0123456789abcdef');
  const courseUrl = await workbench.getByTestId('course-export').getAttribute('href');
  assert.ok(courseUrl);
  const stored = await page.request.get(courseUrl.replace('/export.gpx', ''), { headers });
  expect(stored.status()).toBe(200);
  const body = (await stored.json()) as {
    revision: {
      generation: { kind: string; computation: { graph: { graphBuildId: string } } };
      lineage: { activityId: string }[];
      waypoints: { locked: boolean }[];
    };
  };
  expect(body.revision.generation.kind).toBe('routed-waypoints');
  expect(body.revision.generation.computation.graph.graphBuildId).toBe('0123456789abcdef');
  expect(body.revision.lineage[0]?.activityId).toBe(activity.activityId);
  expect(body.revision.waypoints).toHaveLength(3);

  // The reviewed computation is spent: there is no route left to save again, and the draft
  // continues from what its own save wrote — its own save is not somebody else's change, so
  // nothing is asked and nothing is lost.
  await expect(editor.getByRole('group', { name: '계산된 경로 검토' })).toHaveCount(0);
  await expect(editor.getByTestId('draft-conflict')).toHaveCount(0);
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    3,
  );

  // An unsaved edit survives a rename, which advances the head without touching waypoints.
  await editor.getByLabel('경유점 경도').fill('126.9793');
  await editor.getByLabel('경유점 위도').fill('37.5673');
  await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    4,
  );
  await workbench.getByLabel('코스 이름').fill('경유지 편집 대상 (이름만 변경)');
  await workbench.getByRole('button', { name: '이름 저장' }).click();
  await expect(workbench.getByText(/이름을 저장했습니다/)).toBeVisible();
  await expect(workbench.getByTestId('course-revision')).toHaveText('3');
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    4,
  );
  await expect(editor.getByTestId('draft-conflict')).toHaveCount(0);
});

/**
 * The S13 layout at the generated boundaries, carried forward from M2-01f.
 *
 * Playwright rather than Aside because a viewport has to be resized, which Aside's REPL
 * cannot do. The geometry is measured from the real rendered boxes, so this is about the
 * stylesheet actually applying, not about the data attributes the component tests assert.
 */
test('composes the course screen at 767/768 and 1279/1280 and in a 420px pane', async ({
  page,
}) => {
  const headers = await login(page);
  const activity = await storeTrack(page, headers);
  await page.goto(routeAddress(activity.activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' }).click();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' }).click();
  await courseSection.getByLabel('코스 이름').fill('배치 확인 코스');
  await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
  await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');

  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  const panes = page.locator('[data-layout][class*="panes"]');
  const listPane = page.locator('[data-pane="list"]');
  const mapPane = page.locator('[data-pane="map"]');

  // 767: mobile. The list is the screen; opening a course replaces it with a sheet.
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  await expect(panes).toHaveAttribute('data-layout', 'mobile');
  await expect(listPane).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await workbench.getByRole('button', { name: '배치 확인 코스' }).click();
  await expect(listPane).toBeHidden();
  await expect(page.getByRole('region', { name: '경유지 편집' })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: '코스 목록으로 돌아가기' }).click();
  await expect(listPane).toBeVisible();

  // 768: tablet. The course list runs across the top and folds; under it the map and the
  // open course sit side by side (M2-01k-c1: the waypoint editor is beside the map).
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(panes).toHaveAttribute('data-layout', 'tablet');
  await workbench.getByRole('button', { name: '배치 확인 코스' }).click();
  await expect(listPane).toBeVisible();
  await expect(mapPane).toBeVisible();
  const tabletList = await listPane.boundingBox();
  const tabletMap = await mapPane.boundingBox();
  assert.ok(tabletList && tabletMap);
  expect(tabletList.y + tabletList.height).toBeLessThanOrEqual(tabletMap.y);
  const expandedHeight = tabletList.height;
  await page.getByRole('button', { name: '코스 목록 접기' }).click();
  await expect(page.getByRole('list', { name: '코스 목록' })).toBeHidden();
  const collapsed = await listPane.boundingBox();
  assert.ok(collapsed);
  expect(collapsed.height).toBeLessThan(expandedHeight);
  await page.getByRole('button', { name: '코스 목록 펼치기' }).click();
  expect(await overflow()).toBeLessThanOrEqual(0);

  // 1279 is still tablet; 1280 is the first desktop width.
  await page.setViewportSize({ width: 1279, height: 900 });
  await expect(panes).toHaveAttribute('data-layout', 'tablet');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(panes).toHaveAttribute('data-layout', 'desktop');
  const desktopMap = await mapPane.boundingBox();
  const desktopList = await listPane.boundingBox();
  assert.ok(desktopMap && desktopList);
  // Map and list share a row, map first: the S13 desktop composition.
  expect(Math.abs(desktopMap.y - desktopList.y)).toBeLessThan(4);
  expect(desktopMap.x).toBeLessThan(desktopList.x);
  expect(await overflow()).toBeLessThanOrEqual(0);

  // A narrow pane: the waypoint editor must not force a horizontal scroll at 420px.
  await page.evaluate(() => {
    const root = document.querySelector('[data-layout]');
    if (root instanceof HTMLElement) root.style.width = '420px';
  });
  const editorOverflow = await page.evaluate(() => {
    const editor = document.querySelector('[class*="editor"]');
    return editor instanceof HTMLElement ? editor.scrollWidth - editor.clientWidth : -1;
  });
  expect(editorOverflow).toBeLessThanOrEqual(0);
  expect(await overflow()).toBeLessThanOrEqual(0);

  // 320px reflow of the whole editing screen, keyboard reachable controls included.
  await page.evaluate(() => {
    const root = document.querySelector('[data-layout]');
    if (root instanceof HTMLElement) root.style.removeProperty('width');
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panes).toHaveAttribute('data-layout', 'mobile');
  await expect(page.getByRole('region', { name: '경유지 편집' })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  const compute = page.getByRole('button', { name: '경로 계산' });
  await compute.focus();
  await expect(compute).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('group', { name: '계산된 경로 검토' })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(headers['x-workout-session-id']).toBeTruthy();
  expect(activity.activityId).toBeTruthy();
});

/**
 * An unsaved draft when the course really changes somewhere else.
 *
 * The trigger is the one that is actually guaranteed to happen. Every write this screen
 * makes carries the revision it was showing, so once the stored course has moved the next
 * write is refused — and a refused write is what makes the screen read the course again.
 * A refetch that depends on the tab regaining focus is not something this can rely on:
 * driven headlessly the visibility never changes, and a guard that is only reachable when
 * a person happens to switch windows is not a guard.
 */
test('keeps an unsaved draft and asks before replacing it with a change made elsewhere', async ({
  page,
  context,
}) => {
  const headers = await login(page);
  const activity = await storeTrack(page, headers);
  await page.goto(routeAddress(activity.activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  const courseSection = panel.getByRole('region', { name: '선택 구간으로 코스 만들기' });
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 시작으로' }).click();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await courseSection.getByRole('button', { name: '이 지점을 구간 끝으로' }).click();
  await courseSection.getByLabel('코스 이름').fill('초안 충돌 확인용');
  await courseSection.getByRole('button', { name: '이 구간을 코스로 저장' }).click();
  await expect(courseSection.getByRole('status')).toContainText('코스를 저장했습니다');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  await workbench.getByRole('button', { name: '초안 충돌 확인용' }).click();
  const editor = workbench.getByRole('region', { name: '경유지 편집' });
  await editor.getByLabel('경유점 경도').fill('126.9795');
  await editor.getByLabel('경유점 위도').fill('37.5675');
  await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    3,
  );
  const courseUrl = await workbench.getByTestId('course-export').getAttribute('href');
  assert.ok(courseUrl);
  const courseId = courseUrl.split('/')[4];
  assert.ok(courseId);

  // Somewhere else entirely — another tab of the same account — the course is rerouted to
  // a different shape.
  const other = await context.newPage();
  await other.goto('/courses');
  const stored = await other.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(stored.status()).toBe(200);
  const before = (await stored.json()) as { course: { headRevision: number } };
  const waypoints = [
    {
      role: 'start',
      position: [126.9782, 37.5663],
      name: null,
      sourceSampleId: null,
      locked: false,
    },
    { role: 'via', position: [126.9792, 37.5667], name: null, sourceSampleId: null, locked: false },
    {
      role: 'finish',
      position: [126.9802, 37.567],
      name: null,
      sourceSampleId: null,
      locked: false,
    },
  ];
  const proposal = await other.request.post(`/bff/v1/courses/${courseId}/route-proposals`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { requestId: randomUUID(), draftRevision: 1, waypoints },
  });
  expect(proposal.status()).toBe(200);
  const computedRoute = (await proposal.json()) as {
    proposal: { proposalId: string; computation: { graph: { graphBuildId: string } } };
  };
  const saved = await other.request.patch(`/bff/v1/courses/${courseId}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      expectedRevision: before.course.headRevision,
      change: {
        kind: 'reroute',
        proposalId: computedRoute.proposal.proposalId,
        draftRevision: 1,
        acknowledgedGraph: {
          previous: null,
          next: computedRoute.proposal.computation.graph.graphBuildId,
        },
      },
    },
  });
  expect(saved.status()).toBe(200);
  const afterElsewhere = (await saved.json()) as { course: { headRevision: number } };
  expect(afterElsewhere.course.headRevision).toBe(before.course.headRevision + 1);
  await other.close();

  // The first tab still believes the old revision. Its next write is refused — and that
  // refusal is what makes it read the course again.
  await workbench.getByLabel('코스 이름').fill('이름을 바꿔 보려 한다');
  await workbench.getByRole('button', { name: '이름 저장' }).click();
  await expect(workbench.getByText(/다른 변경이 먼저 저장되었습니다/)).toBeVisible();
  const conflict = editor.getByTestId('draft-conflict');
  await expect(conflict).toBeVisible({ timeout: 15_000 });
  await expect(conflict).toContainText('저장된 코스가 다른 곳에서 바뀌었습니다');
  // Nothing was discarded: the owner's three waypoints are still there.
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    3,
  );
  // Keeping the draft is a choice, and so is giving it up.
  await editor.getByRole('button', { name: '편집 중인 내용 유지' }).click();
  await expect(conflict).toHaveCount(0);
  await expect(editor.getByRole('list', { name: '경유점 목록' }).getByRole('listitem')).toHaveCount(
    3,
  );
});
