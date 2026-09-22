import assert from 'node:assert/strict';
import { expect, test, type Page } from '@playwright/test';

/**
 * M2-01j against the real stack: the real OIDC session, the real API, real PostgreSQL and
 * the real bounded parse worker.
 *
 * Everything here is driven the way a person drives it — a file chosen in the file input,
 * buttons clicked on the screen — because a check made with `page.request` proves the API
 * works and says nothing about whether the screen reaches it. That distinction cost M2-01f
 * a real defect (an export anchor that could not carry the session header), so the import,
 * the trim and the favourite mark all go through the DOM here, and `page.request` is used
 * only to read back what the server actually stored.
 */
const gpxDocument = (name: string, points: [number, number][]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="identity-e2e" xmlns="http://www.topografix.com/GPX/1/1">` +
  `<rte><name>${name}</name>` +
  points.map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`).join('') +
  `</rte></gpx>\n`;

/** Starts inside the protected area added below, then walks away from it. */
const points: [number, number][] = [
  [126.978, 37.566],
  [126.9781, 37.5661],
  [126.99, 37.575],
  [126.995, 37.58],
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

async function importGpx(page: Page, fileName: string, contents: string, courseName?: string) {
  const workbench = page.getByRole('region', { name: '내 코스' });
  const panel = workbench.getByRole('region', { name: 'GPX 가져오기' });
  await expect(panel).toBeVisible();
  if (courseName !== undefined) await panel.getByLabel(/새 코스의 이름/).fill(courseName);
  await panel.getByLabel('가져올 GPX 파일').setInputFiles({
    name: fileName,
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(contents, 'utf8'),
  });
  await panel.getByRole('button', { name: '가져오기' }).click();
  return panel;
}

test('imports a GPX route through the screen, round-trips it and trims a protected area', async ({
  page,
}) => {
  const headers = await login(page);
  await page.goto('/courses');
  const workbench = page.getByRole('region', { name: '내 코스' });

  // 1. Import. The bytes go to the server and the server parses them: nothing on the
  //    screen decides what is in the file.
  const panel = await importGpx(page, 'seoul.gpx', gpxDocument('M2-01j 가져오기 확인본', points));
  await expect(panel.getByRole('status')).toContainText(
    '코스를 가져왔습니다: M2-01j 가져오기 확인본',
  );

  await page.goto('/courses');
  await workbench.getByRole('button', { name: 'M2-01j 가져오기 확인본', exact: true }).click();
  await expect(workbench.getByTestId('course-revision')).toHaveText('1');
  // The ledger says where the line came from, and that it came from no recording of ours.
  await expect(workbench.getByTestId('course-generation')).toContainText('가져온 파일');
  await expect(workbench.getByTestId('course-generation')).toContainText('GPX 경로(rte)');
  await expect(workbench).toContainText('가져온 파일에서 만든 코스입니다');

  const exportHref = await workbench.getByTestId('course-export').getAttribute('href');
  assert.ok(exportHref);
  const courseId = exportHref.split('/')[4];
  assert.ok(courseId);

  // 2. Round trip: export what we stored and import it again. The second course must carry
  //    the same line.
  const exported = await page.request.get(exportHref, { headers });
  expect(exported.status()).toBe(200);
  const exportedGpx = await exported.text();
  expect(exportedGpx).toContain('<rte>');
  expect(exportedGpx).not.toContain('<trk>');
  await importGpx(page, 'round-trip.gpx', exportedGpx, 'M2-01j 왕복 확인본');
  await expect(
    workbench.getByRole('region', { name: 'GPX 가져오기' }).getByRole('status'),
  ).toContainText('코스를 가져왔습니다: M2-01j 왕복 확인본');

  const list = await page.request.get('/bff/v1/courses', { headers });
  const courses = (await list.json()) as { courses: { courseId: string; name: string }[] };
  const roundTripped = courses.courses.find((course) => course.name === 'M2-01j 왕복 확인본');
  assert.ok(roundTripped);
  const original = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  const copy = await page.request.get(`/bff/v1/courses/${roundTripped.courseId}`, { headers });
  const coordinatesOf = async (response: typeof original) => {
    const body = (await response.json()) as {
      revision: { geometry: { coordinates: [number, number][] } };
    };
    return body.revision.geometry.coordinates;
  };
  const before = await coordinatesOf(original);
  const after = await coordinatesOf(copy);
  expect(after).toHaveLength(before.length);
  for (const [index, position] of before.entries()) {
    // GPX is written with fixed precision, so a round trip is equal to that precision
    // rather than bit-for-bit.
    expect(after[index]?.[0]).toBeCloseTo(position[0], 6);
    expect(after[index]?.[1]).toBeCloseTo(position[1], 6);
  }

  // 3. Favourite and last used: private preferences, written by the screen, and no new
  //    revision anywhere.
  await page.goto('/courses');
  // The favourite toggle is named for the action; the row it sits in says which course.
  const row = workbench.locator('li').filter({ hasText: 'M2-01j 가져오기 확인본' });
  await row.getByRole('button', { name: '즐겨찾기', exact: true }).click();
  await expect(row.getByRole('button', { name: '즐겨찾기 해제', exact: true })).toBeVisible();
  const preferences = await page.request.get('/bff/v1/courses/preferences', { headers });
  const stored = (await preferences.json()) as {
    preferences: { courseId: string; favourite: boolean; lastUsedAt: string | null }[];
  };
  const mine = stored.preferences.find((preference) => preference.courseId === courseId);
  assert.ok(mine);
  expect(mine.favourite).toBe(true);
  // Opening the course earlier is what recorded the use.
  expect(mine.lastUsedAt).not.toBeNull();
  const unchanged = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(
    ((await unchanged.json()) as { course: { headRevision: number } }).course.headRevision,
  ).toBe(1);

  // 4. Protected area and the derived revision. The area covers the first two vertices.
  //    The list button now carries the favourite mark, which is part of its label.
  await workbench.getByRole('button', { name: '★ M2-01j 가져오기 확인본', exact: true }).click();
  const privacy = workbench.getByRole('region', { name: '보호 구역' });
  await privacy.getByLabel('보호 구역 이름').fill('집');
  await privacy.getByLabel('보호 구역 경도').fill('126.9780');
  await privacy.getByLabel('보호 구역 위도').fill('37.5660');
  await privacy.getByLabel('보호 구역 반경(m)').fill('300');
  await privacy.getByRole('button', { name: '보호 구역 추가' }).click();
  await expect(privacy.getByRole('button', { name: '집 삭제' })).toBeVisible();
  await privacy.getByRole('button', { name: '보호 구역 제거본 만들기' }).click();
  await expect(privacy.getByText(/이전 수정본은 그대로 남아 있습니다/)).toBeVisible();

  const trimmed = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  const trimmedBody = (await trimmed.json()) as {
    course: { headRevision: number };
    revision: {
      geometry: { coordinates: [number, number][] };
      generation: { kind: string; removedVertexCount?: number };
    };
  };
  expect(trimmedBody.course.headRevision).toBe(2);
  expect(trimmedBody.revision.generation.kind).toBe('privacy-trimmed');
  expect(trimmedBody.revision.geometry.coordinates).toHaveLength(2);
  // The coordinates inside the protected area are gone from the response …
  expect(JSON.stringify(trimmedBody.revision.geometry.coordinates)).not.toContain('126.978');
  // … and from the GPX the owner exports.
  const trimmedExport = await page.request.get(exportHref, { headers });
  const trimmedGpx = await trimmedExport.text();
  expect(trimmedGpx).not.toContain('37.5660000');
  expect(trimmedGpx).not.toContain('126.9780000');
  expect(trimmedGpx).toContain('126.9950000');
  // The revision it trimmed was not rewritten: the head moved on and the ledger kept both.
  const revisions = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(
    ((await revisions.json()) as { revision: { courseRevision: number } }).revision.courseRevision,
  ).toBe(2);

  // A second trim against the same area changes nothing and says so.
  await page.goto('/courses');
  await workbench.getByRole('button', { name: '★ M2-01j 가져오기 확인본', exact: true }).click();
  await workbench
    .getByRole('region', { name: '보호 구역' })
    .getByRole('button', { name: '보호 구역 제거본 만들기' })
    .click();
  await expect(
    workbench.getByRole('region', { name: '보호 구역' }).getByText(/보호 구역을 지나지 않습니다/),
  ).toBeVisible();

  // 5. Place search and elevation report what this deployment actually has. Both states
  //    are honest answers; neither is "nothing found".
  const elevation = workbench.getByRole('region', { name: '고도 출처' });
  await expect(elevation).toContainText(/고도 데이터가 배포되어 있지 않습니다|고도 값이 있습니다/);
  await expect(elevation).toContainText('확인되지 않음');
  const search = workbench.getByRole('region', { name: '장소 검색' });
  await search.getByLabel('장소 이름').fill('한강');
  await search.getByRole('button', { name: '검색' }).click();
  await expect(search).toContainText(
    /장소 데이터가 배포되어 있지 않습니다|찾은 장소가 없습니다|© OpenStreetMap/,
  );

  // 6. Sharing is still disabled everywhere on this screen.
  for (const forbidden of ['공유', '링크 복사', '공개']) {
    await expect(workbench.getByRole('button', { name: new RegExp(forbidden) })).toHaveCount(0);
  }
});

test('refuses a file this server will not read, and stores nothing', async ({ page }) => {
  const headers = await login(page);
  await page.goto('/courses');
  const before = await page.request.get('/bff/v1/courses', { headers });
  const beforeTotal = ((await before.json()) as { total: number }).total;

  // XXE: a DOCTYPE with an external entity. The server's parser blocks it.
  const panel = await importGpx(
    page,
    'evil.gpx',
    `<?xml version="1.0"?><!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
      `<gpx version="1.1" creator="x" xmlns="http://www.topografix.com/GPX/1/1"><rte><name>&xxe;</name>` +
      `<rtept lat="37.5000000" lon="127.0200000" /><rtept lat="37.5010000" lon="127.0210000" /></rte></gpx>`,
    '외부 참조',
  );
  await expect(panel.getByRole('status')).toContainText(
    '외부 참조를 포함하고 있어 읽지 않았습니다',
  );

  const after = await page.request.get('/bff/v1/courses', { headers });
  expect(((await after.json()) as { total: number }).total).toBe(beforeTotal);
});
