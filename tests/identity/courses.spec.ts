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
  await expect(workbench.getByRole('status')).toContainText('현재 수정 번호 2');

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
