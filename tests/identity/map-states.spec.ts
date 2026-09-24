import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  coursesNamed,
  importCourse,
  login,
  mapCoordinates,
  place,
  printed,
  shells,
} from './course-editor-support';
import { expectLineDrawn, mapRegion, mapStatusLine } from './map-evidence';

/**
 * M2-01k-c1 · P5-states (plan §5: "오류·GPS 없음·부분 기록·배경 없음·WebGL unavailable·
 * 미계산·계산 중·stale·저장 실패를 구별한다"). The three states no executed assertion told
 * apart until now, each on its own, in both shells, in the real renderer:
 *
 * - partial recording: a recording with a break says so as a partial state, and its line is
 *   still drawn — which a complete recording does not say;
 * - no background map: a line drawn with no background says exactly that, requests no
 *   background asset, and is neither the "drawn over the background" state nor the
 *   "background failed" state (both of which are asserted beside it);
 * - save failure: a save whose outcome is unknown and a save the server refused are two
 *   different states, and neither loses the draft or pretends something was stored.
 */
const GPX11 = 'http://www.topografix.com/GPX/1/1';
const at = (seconds: number) =>
  new Date(Date.parse('2026-03-01T00:00:00Z') + seconds * 1000).toISOString();

const point = (index: number) =>
  `<trkpt lat="${37.5 + index / 1000}" lon="${127.02 + index / 1000}"><time>${at(index * 10)}</time></trkpt>`;

/** One recording, one segment: nothing missing. */
const complete = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="${GPX11}">` +
    `<trk><name>끊김 없는 기록</name><trkseg>${[0, 1, 2, 3, 4].map(point).join('')}</trkseg></trk></gpx>`,
);
/** The same recording with the receiver lost in the middle: two segments. */
const broken = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="${GPX11}">` +
    `<trk><name>끊긴 기록</name>` +
    `<trkseg>${[0, 1, 2].map(point).join('')}</trkseg>` +
    `<trkseg>${[6, 7, 8].map(point).join('')}</trkseg></trk></gpx>`,
);

const noBackground = '배경 지도 없이 경로를 표시했습니다.';
const overBackground = '지도에 경로를 표시했습니다.';
const partialNotice = /기록이 \d+회 끊겼습니다\. 끊긴 구간은 직선으로 잇지 않습니다\./;

function recordBackgroundRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/map/basemap/')) seen.push(path);
  });
  return seen;
}

async function preview(page: Page, name: string, buffer: Buffer) {
  await page.getByLabel('미리 볼 기록 파일').setInputFiles({
    name,
    mimeType: 'application/octet-stream',
    buffer,
  });
}

const seoul = [
  [126.978, 37.566],
  [126.982, 37.568],
  [126.986, 37.567],
] as const;

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('tells a partial recording and a map with no background apart, each on its own', async ({
      page,
    }) => {
      await login(page);
      const background = recordBackgroundRequests(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      // The local preview is drawn with no background map in both shells, by design.
      await page.goto(`${shell.origin}/activities/track-preview`);
      const map = mapRegion(page, '로컬 파일 경로');

      await preview(page, 'complete.gpx', complete);
      await expectLineDrawn(map);
      await expect(mapStatusLine(map)).toHaveText(noBackground);
      await expect(page.locator('[data-state="partial"]')).toHaveCount(0);
      await expect(page.getByText(partialNotice)).toHaveCount(0);

      const before = await map.getAttribute('data-paths-generation');
      await preview(page, 'broken.gpx', broken);
      const partial = page.locator('[data-state="partial"]').filter({ hasText: partialNotice });
      await expect(partial).toHaveCount(1);
      await expect(partial).toContainText('일부 데이터');
      // A partial recording is still drawn — in parts, with no background, and said so.
      await expectLineDrawn(map, { changedFrom: before });
      await expect(mapStatusLine(map)).toHaveText(noBackground);
      await expect(map.locator('[class*="attribution"]')).toHaveCount(0);
      expect(background, 'a map with no background asks for no background asset').toEqual([]);
    });

    test('says a course drawn over the background, without one, and with a failed one differently', async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const headers = await login(page);
      const pointer = await page.request.get(`${shell.origin}/map/basemap/current.json`);
      test.skip(
        pointer.status() !== 200,
        'No self-hosted basemap deployment on this machine (scripts/build-basemap.mjs is opt-in).',
      );
      const name = `배경 상태 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      await page.setViewportSize({ width: 1280, height: 900 });

      // Over the background.
      await page.goto(`${shell.origin}/courses`);
      let workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      let map = mapRegion(workbench, '코스 지도');
      await expectLineDrawn(map);
      await expect(mapStatusLine(map)).toHaveText(overBackground);
      await expect(map.locator('[class*="attribution"]')).not.toHaveText('');

      // A background that fails to load is not "no background": the map says it failed.
      await page.route(/\/map\/basemap\/[^/]+\/style\.json$/, (route) => route.abort());
      await page.goto(`${shell.origin}/courses`);
      workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      map = mapRegion(workbench, '코스 지도');
      await expect(map).toHaveAttribute('data-map-status', 'unavailable', { timeout: 20_000 });
      await expect(mapStatusLine(map)).toHaveText(
        '배경 지도를 불러오지 못해 지도를 표시할 수 없습니다. 아래 좌표 목록을 사용하세요.',
      );
      await page.unrouteAll({ behavior: 'ignoreErrors' });

      if (shell.name === 'Vite') {
        // This shell learns of the deployment at runtime; with no deployment pointer it has
        // no background map, and the course is drawn without one — said as such.
        const background = recordBackgroundRequests(page);
        await page.route(/\/map\/basemap\/current\.json$/, (route) =>
          route.fulfill({ status: 404, body: '' }),
        );
        await page.goto(`${shell.origin}/courses`);
        workbench = page.getByRole('region', { name: '내 코스' });
        await workbench.getByRole('button', { name, exact: true }).click();
        map = mapRegion(workbench, '코스 지도');
        await expectLineDrawn(map);
        await expect(mapStatusLine(map)).toHaveText(noBackground);
        expect(background.filter((path) => path !== '/map/basemap/current.json')).toEqual([]);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
      }
    });

    /**
     * Two save failures on `/courses/new`, told apart:
     *
     * 1. The outcome is unknown: the server stored the course, but the answer never reached
     *    the page (the connection is cut after the server answered). The screen must not say
     *    it failed or that nothing was stored; it keeps the reviewed draft and the line on
     *    the map, and saving again is the same command and does not make a second course.
     * 2. The server refused: the engine's answer at save time is not the reviewed line (here
     *    the request names a digest the engine does not reproduce). Nothing is stored; the
     *    review is spent, so the draft is uncomputed again and the map shows only the dashed
     *    draft, not the refused line.
     */
    test('tells an unknown save outcome and a refused save apart and keeps the draft through both', async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const headers = await login(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      const S = [126.978, 37.566] as const;
      const F = [126.982, 37.569] as const;

      const startReviewed = async (name: string) => {
        await page.goto(`${shell.origin}/courses/new`);
        const screen = page.getByRole('region', { name: '새 코스' });
        const editor = screen.getByRole('region', { name: '경유지 편집' });
        await place(editor, ...S);
        await place(editor, ...F);
        const answered = page.waitForResponse(
          (response) => new URL(response.url()).pathname === '/bff/v1/courses/route-previews',
        );
        await editor.getByRole('button', { name: '경로 계산' }).click();
        const preview = (await (await answered).json()) as {
          preview: { geometry: { coordinates: [number, number][] } };
        };
        const review = editor.getByRole('group', { name: '계산된 경로 검토' });
        await review.getByLabel('새 코스 이름').fill(name);
        await review.getByLabel('위 내용을 검토했습니다.').check();
        const routeVertices = preview.preview.geometry.coordinates
          .map((position) => printed(position))
          .filter((vertex) => vertex !== printed(S) && vertex !== printed(F));
        expect(routeVertices.length).toBeGreaterThan(0);
        return { screen, editor, review, routeVertices };
      };
      const create = (url: URL) => url.pathname === '/bff/v1/courses';

      // ── 1. Unknown outcome.
      const lost = `저장 결과 불명 ${shell.name} ${randomUUID().slice(0, 8)}`;
      let flow = await startReviewed(lost);
      const keys: string[] = [];
      let cut = true;
      let storedId = '';
      await page.route(create, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        keys.push(route.request().headers()['idempotency-key'] ?? '');
        if (!cut) return route.continue();
        cut = false;
        const answered = await route.fetch();
        expect(answered.status()).toBe(200);
        const stored = (await answered.json()) as { course: { courseId: string } };
        storedId = stored.course.courseId;
        await route.abort('connectionreset');
      });
      await flow.review.getByRole('button', { name: '검토한 경로로 새 코스 저장' }).click();
      await expect(
        flow.editor.getByText(
          '저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 저장하면 코스가 중복으로 생기지 않습니다.',
        ),
      ).toBeVisible();
      await expect(page).toHaveURL(`${shell.origin}/courses/new`);
      await expect(flow.editor.getByTestId('draft-route-status')).toHaveAttribute(
        'data-status',
        'computed',
      );
      await expect(flow.review.getByLabel('위 내용을 검토했습니다.')).toBeChecked();
      const map = mapRegion(flow.screen, '코스 지도');
      await expectLineDrawn(map);
      const shown = await mapCoordinates(map);
      for (const vertex of flow.routeVertices) expect(shown).toContain(vertex);
      // The server did store it; the screen did not claim either way.
      expect(await coursesNamed(page, headers, lost)).toBe(1);
      await expect(flow.editor.getByText(/저장된 것은 없습니다/)).toHaveCount(0);

      await flow.review.getByRole('button', { name: '검토한 경로로 새 코스 저장' }).click();
      await expect(page).toHaveURL(new RegExp(`^${shell.origin}/courses/[0-9a-f-]{36}/edit$`));
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      // The retry is answered with the course the lost attempt stored, not a new one.
      expect(storedId).not.toBe('');
      expect(new URL(page.url()).pathname).toBe(`/courses/${storedId}/edit`);
      expect(await coursesNamed(page, headers, lost)).toBe(1);
      await page.unrouteAll({ behavior: 'ignoreErrors' });

      // ── 2. Refused.
      const refused = `저장 거절 ${shell.name} ${randomUUID().slice(0, 8)}`;
      flow = await startReviewed(refused);
      await page.route(create, async (route) => {
        const request = route.request();
        if (request.method() !== 'POST') return route.continue();
        const body = request.postDataJSON() as { from: { reviewedGeometrySha256: string } };
        body.from.reviewedGeometrySha256 = '0'.repeat(64);
        await route.continue({ postData: JSON.stringify(body) });
      });
      const answer = page.waitForResponse(
        (response) => create(new URL(response.url())) && response.request().method() === 'POST',
      );
      await flow.review.getByRole('button', { name: '검토한 경로로 새 코스 저장' }).click();
      expect((await answer).status()).toBe(409);
      await expect(
        flow.editor.getByText(
          '저장하려고 다시 계산한 경로가 검토한 경로와 달랐습니다. 저장된 것은 없습니다. 다시 계산해 새 결과를 검토하세요.',
        ),
      ).toBeVisible();
      await expect(page).toHaveURL(`${shell.origin}/courses/new`);
      await expect(flow.editor.getByTestId('draft-route-status')).toHaveAttribute(
        'data-status',
        'uncomputed',
      );
      await expect(flow.editor.getByRole('group', { name: '계산된 경로 검토' })).toHaveCount(0);
      const refusedMap = mapRegion(flow.screen, '코스 지도');
      await expectLineDrawn(refusedMap);
      const drawn = await mapCoordinates(refusedMap);
      for (const vertex of flow.routeVertices) expect(drawn).not.toContain(vertex);
      expect(drawn).toEqual([printed(S), printed(F), printed(S), printed(F)]);
      expect(await coursesNamed(page, headers, refused)).toBe(0);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });
  });
}
