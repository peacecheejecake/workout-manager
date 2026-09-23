import assert from 'node:assert/strict';
import { expect, test, type Page } from '@playwright/test';

import { courseThumbnailPath } from '../../packages/contracts/src/courses';

/**
 * M2-01l against the real stack: real OIDC session, real API, real PostgreSQL, the real
 * object store and the real render worker leasing out of the real queue.
 *
 * Two things are worth proving end to end and neither can be proved by a unit test.
 *
 * **The screen is never empty.** Before the render lands the owner sees the line drawn in
 * their own browser; afterwards they see the stored picture. Both are the same projection,
 * so the swap is invisible except in where the bytes came from.
 *
 * **A privacy trim changes the picture.** The stored thumbnail is coordinates encoded as a
 * drawing, so if it kept showing the pre-trim line it would carry exactly the locations the
 * owner just removed — past the response, past the GPX and past the export. Here the stored
 * SVG is fetched and its path is compared with the projection of the trimmed line.
 */
const gpxDocument = (name: string, points: [number, number][]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="identity-e2e" xmlns="http://www.topografix.com/GPX/1/1">` +
  `<rte><name>${name}</name>` +
  points.map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`).join('') +
  `</rte></gpx>\n`;

/** Starts inside the protected area added below, then walks away from it. */
const points: [number, number][] = [
  [126.9782, 37.5662],
  [126.9783, 37.5663],
  [126.992, 37.5762],
  [126.9965, 37.5812],
];

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session = (await response.json()) as { sessionId: string; csrfToken: string };
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

async function readCourse(page: Page, headers: Record<string, string>, courseId: string) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    course: { headRevision: number };
    revision: { geometry: { coordinates: [number, number][] } };
    thumbnail: { status: string; contentHash?: string; vertexCount?: number };
  };
}

test('stores a thumbnail of the head revision and redraws it when a protected area is trimmed', async ({
  page,
}) => {
  const headers = await login(page);
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });
  const panel = workbench.getByRole('region', { name: 'GPX 가져오기' });
  await expect(panel).toBeVisible();
  await panel.getByLabel(/새 코스의 이름/).fill('M2-01l 썸네일 확인본');
  await panel.getByLabel('가져올 GPX 파일').setInputFiles({
    name: 'thumbnail.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(gpxDocument('M2-01l 썸네일 확인본', points), 'utf8'),
  });
  await panel.getByRole('button', { name: '가져오기' }).click();
  await expect(panel.getByRole('status')).toContainText('코스를 가져왔습니다');

  await page.goto('/courses');
  await workbench.getByRole('button', { name: 'M2-01l 썸네일 확인본', exact: true }).click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  const exportHref = await workbench.getByTestId('course-export').getAttribute('href');
  assert.ok(exportHref);
  const courseId = exportHref.split('/')[4];
  assert.ok(courseId);

  // Whatever the render has managed so far, there is a picture on the screen and it is a
  // picture of this line. Falling back is not an error state.
  await expect(workbench.getByTestId('course-thumbnail')).toBeVisible();

  // The stored picture arrives. The screen reloads on its own schedule, so this waits on
  // the server's answer and then confirms the screen shows it.
  await expect
    .poll(async () => (await readCourse(page, headers, courseId)).thumbnail.status, {
      timeout: 15_000,
    })
    .toBe('ready');
  const stored = await readCourse(page, headers, courseId);
  expect(stored.thumbnail.vertexCount).toBe(points.length);
  // Facts about the picture travel in the read model; the key never does.
  expect(JSON.stringify(stored.thumbnail)).not.toContain('private/v1');

  const thumbnailUrl = `/bff/v1/courses/${courseId}/thumbnail`;
  const first = await page.request.get(thumbnailUrl, { headers });
  expect(first.status()).toBe(200);
  expect(first.headers()['content-type']).toBe('image/svg+xml');
  expect(first.headers()['cache-control']).toBe('private, no-store');
  expect(first.headers()['x-content-type-options']).toBe('nosniff');
  // Three separate reductions on a document served from our own origin: a policy that can
  // load and run nothing, no sniffing, and `attachment` so opening the address directly
  // downloads it instead of rendering it at the top level.
  expect(first.headers()['content-security-policy']).toBe("default-src 'none'");
  expect(first.headers()['content-disposition']).toContain('attachment');
  const firstSvg = await first.text();
  const drawnHead = courseThumbnailPath(stored.revision.geometry.coordinates);
  assert.ok(drawnHead);
  expect(firstSvg).toContain(`d="${drawnHead.path}"`);
  // No user text of any kind reaches the stored document.
  expect(firstSvg).not.toContain('M2-01l');
  expect(firstSvg).not.toContain('<script');

  await page.goto('/courses');
  await workbench.getByRole('button', { name: 'M2-01l 썸네일 확인본', exact: true }).click();
  await expect(workbench.getByTestId('course-thumbnail')).toHaveAttribute('data-source', 'stored');
  await expect(workbench.getByTestId('course-thumbnail-state')).toHaveText(
    '저장된 썸네일을 보고 있습니다.',
  );

  // A protected area over the first two vertices, then the derived revision.
  const privacy = workbench.getByRole('region', { name: '보호 구역' });
  await privacy.getByLabel('보호 구역 이름').fill('썸네일 보호 구역');
  await privacy.getByLabel('보호 구역 경도').fill('126.9782');
  await privacy.getByLabel('보호 구역 위도').fill('37.5662');
  await privacy.getByLabel('보호 구역 반경(m)').fill('300');
  await privacy.getByRole('button', { name: '보호 구역 추가' }).click();
  await expect(privacy.getByRole('button', { name: '썸네일 보호 구역 삭제' })).toBeVisible();
  await privacy.getByRole('button', { name: '보호 구역 제거본 만들기' }).click();
  await expect(privacy.getByText(/이전 수정본은 그대로 남아 있습니다/)).toBeVisible();

  const trimmed = await readCourse(page, headers, courseId);
  expect(trimmed.course.headRevision).toBe(2);
  expect(trimmed.revision.geometry.coordinates).toHaveLength(2);

  // The new head's picture is drawn from scratch, and until it exists the screen falls back
  // to drawing the trimmed line itself — never to the picture of the untrimmed one.
  await expect
    .poll(async () => (await readCourse(page, headers, courseId)).thumbnail.status, {
      timeout: 15_000,
    })
    .toBe('ready');
  const after = await readCourse(page, headers, courseId);
  expect(after.thumbnail.vertexCount).toBe(2);
  expect(after.thumbnail.contentHash).not.toBe(stored.thumbnail.contentHash);

  const second = await page.request.get(thumbnailUrl, { headers });
  expect(second.status()).toBe(200);
  const secondSvg = await second.text();
  const drawnTrimmed = courseThumbnailPath(trimmed.revision.geometry.coordinates);
  assert.ok(drawnTrimmed);
  // The stored picture is of the TRIMMED line. This is the assertion the whole node exists
  // for: a thumbnail is coordinates encoded as a drawing, and a stale one would carry the
  // protected area straight past the trim.
  expect(secondSvg).toContain(`d="${drawnTrimmed.path}"`);
  expect(secondSvg).not.toBe(firstSvg);
  expect(secondSvg).not.toContain(drawnHead.path);
});
