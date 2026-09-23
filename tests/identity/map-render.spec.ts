import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import {
  courseImportResultSchema,
  type CourseReadResult,
} from '../../packages/contracts/src/courses';
import {
  fitFile,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';
import {
  expectLineDrawn,
  mapRegion,
  mapStatusHistory,
  mapStatusLine,
  recordMapStatuses,
  refuseMapWorker,
  renderedLines,
  withoutWebGl,
} from './map-evidence';

/**
 * M2-01q. The map says "drawn" only when it drew, in both shells, at every S13/S14 width.
 *
 * The plan (§5) has one client-only map leaf that **both shells reuse**. M2-01k proved the
 * Next shell (3100) draws the course line; nothing proved the Vite shell (4200). And the
 * status line used to say "지도 표시 중" as soon as the style loaded, which needs no
 * worker, so an empty canvas was announced as a shown map (F2 hid behind that for two
 * nodes). Every assertion here reads the map's live status line and its drawn-line count
 * — never a request, a layout attribute or a colour count.
 *
 * The Vite shell has no session endpoint of its own: its preview proxies `/bff` to the
 * same API, and the session cookie is scoped to the host (127.0.0.1), not the port, so a
 * login on 3100 is the same session on 4200. That is how the identity harness reaches it.
 */
const shells = [
  { name: 'Next', origin: 'http://127.0.0.1:3100' },
  { name: 'Vite', origin: 'http://127.0.0.1:4200' },
] as const;

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

const gpx = (name: string, points: readonly (readonly [number, number])[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="identity-e2e" xmlns="http://www.topografix.com/GPX/1/1">` +
  `<rte><name>${name}</name>` +
  points.map(([lon, lat]) => `<rtept lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" />`).join('') +
  `</rte></gpx>\n`;

/** A course made through the API; what is under test is how the screens draw it. */
async function importCourse(
  page: Page,
  headers: Record<string, string>,
  name: string,
  points: readonly (readonly [number, number])[],
): Promise<string> {
  const response = await page.request.post('/bff/v1/courses/imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      name,
      originalFilename: 'map-render.gpx',
      selection: null,
      fileBase64: Buffer.from(gpx(name, points), 'utf8').toString('base64'),
    },
  });
  expect(response.status()).toBe(200);
  const result = courseImportResultSchema.parse(await response.json());
  assert.ok(result.outcome === 'imported');
  const course: CourseReadResult = result.course;
  assert.ok(course.status === 'available');
  return course.course.courseId;
}

const seoul = [
  [126.978, 37.566],
  [126.982, 37.568],
  [126.986, 37.567],
  [126.99, 37.57],
] as const;
/** Far enough from Seoul that a viewport left on the first course cannot contain it. */
const busan = [
  [129.06, 35.15],
  [129.064, 35.152],
  [129.068, 35.151],
] as const;

const at = (seconds: number) =>
  new Date(Date.parse('2026-03-01T00:00:00Z') + seconds * 1000).toISOString();

async function storeTrack(page: Page, headers: Record<string, string>) {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'f'.repeat(64) },
    activity: {
      title: `지도 렌더 확인 ${randomUUID()}`,
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
  const bytes = Buffer.from(
    fitFile([
      sessionMessage({ startedAt: at(0), elapsedSeconds: 40, distanceMeters: 512 }),
      ...[0, 1, 2, 3, 4].map((index) =>
        recordMessage({
          at: at(index * 10),
          longitude: 126.978 + index / 2000,
          latitude: 37.566 + index / 2000,
          heartRate: 140 + index,
          distanceMeters: index * 128,
        }),
      ),
    ]),
  );
  const uploaded = await page.request.put(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/content`,
    {
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-track-file-name': encodeURIComponent('map-render.fit'),
      },
      data: bytes,
    },
  );
  expect(uploaded.status()).toBe(200);
  const finalized = await page.request.post(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/finalize`,
    { headers: { ...headers, 'idempotency-key': randomUUID() } },
  );
  expect(finalized.status()).toBe(200);
  return result.activityId;
}

const previewGpx = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<trk><name>미리보기</name><trkseg>` +
    [0, 1, 2, 3, 4]
      .map(
        (index) =>
          `<trkpt lat="${37.5 + index / 1000}" lon="${127.02 + index / 1000}">` +
          `<time>${at(index * 10)}</time></trkpt>`,
      )
      .join('') +
    `</trkseg></trk></gpx>`,
);

/**
 * Drag the map with the mouse, several map-widths to the left: the course leaves the view.
 * A mouse drag pans even with cooperative gestures (they gate the wheel and touch only).
 */
async function dragMapAway(page: Page, map: ReturnType<typeof mapRegion>, times = 3) {
  for (let index = 0; index < times; index += 1) {
    // Measured per stroke: the region can still shift (an attribution line arriving).
    await map.locator('canvas').scrollIntoViewIfNeeded();
    const box = await map.locator('canvas').boundingBox();
    if (!box) throw new Error('no map canvas to drag');
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1)
      await page.mouse.move(box.x + box.width * (0.9 - (0.8 * step) / 10), box.y + box.height / 2);
    await page.mouse.up();
  }
}

/**
 * Drag until the map itself says the course is outside its view. What is under test is what
 * happens afterwards, not whether one particular drag was taken as a pan, so a drag the
 * renderer did not take (it can arrive while the page is still settling) is repeated.
 */
async function moveViewOffCourse(page: Page, map: ReturnType<typeof mapRegion>) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await dragMapAway(page, map);
    try {
      await expect(map).toHaveAttribute('data-map-status', 'out-of-view', { timeout: 8_000 });
      return;
    } catch {
      // not moved far enough yet
    }
  }
  await expect(map).toHaveAttribute('data-map-status', 'out-of-view');
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/**
 * The narrowest each pane may be and stay usable, from the 320 CSS px reflow check point
 * (07 §2): a 320px viewport with its 16px page margins leaves 288px, so a pane narrower
 * than 240px is one the composition squeezed, not one the viewport forced.
 */
const minimumPaneWidth = 240;

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('draws the course line at every S13/S14 boundary and keeps each pane at its minimum width', async ({
      page,
    }) => {
      const headers = await login(page);
      // Six fresh documents, each waiting for the renderer to settle.
      test.setTimeout(90_000);
      const name = `지도 렌더 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      await recordMapStatuses(page);

      const widths = [
        { width: 320, layout: 'mobile' },
        { width: 767, layout: 'mobile' },
        { width: 768, layout: 'tablet' },
        { width: 1279, layout: 'tablet' },
        { width: 1280, layout: 'desktop' },
      ] as const;
      for (const { width, layout } of widths) {
        await page.setViewportSize({ width, height: 900 });
        // A fresh document at every width: what is proven is that the map draws at this
        // width, not that a renderer started at another width survived a resize.
        await page.goto(`${shell.origin}/courses`);
        const workbench = page.getByRole('region', { name: '내 코스' });
        await expect(page.locator('[data-layout][class*="panes"]')).toHaveAttribute(
          'data-layout',
          layout,
        );
        await workbench.getByRole('button', { name, exact: true }).click();
        const map = mapRegion(workbench, '코스 지도');
        await expectLineDrawn(map);

        const canvas = await map.locator('canvas').boundingBox();
        assert.ok(canvas, `no map canvas at ${width}px`);
        expect(canvas.width, `map width at ${width}px`).toBeGreaterThanOrEqual(minimumPaneWidth);
        expect(canvas.height, `map height at ${width}px`).toBeGreaterThanOrEqual(200);
        for (const pane of ['map', 'list', 'sheet'] as const) {
          const box = await page.locator(`[data-pane="${pane}"]`).boundingBox();
          // A pane the layout hides (the mobile list under the open sheet) has no box.
          if (box === null) continue;
          expect(box.width, `${pane} pane at ${width}px`).toBeGreaterThanOrEqual(minimumPaneWidth);
        }
        expect(await overflow(page), `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
      }

      // The desktop 420px module pane (07 §3): the course screen mounted in a narrow
      // container on a desktop-width viewport. The pane is narrowed before the course is
      // opened, so the renderer is created in it and the drawn-line count is its own, not
      // one left over from the wider layout.
      await page.goto(`${shell.origin}/courses`);
      await page.addStyleTag({ content: 'section[aria-label="내 코스"] { width: 420px; }' });
      const narrow = page.getByRole('region', { name: '내 코스' });
      expect((await narrow.boundingBox())?.width).toBe(420);
      await narrow.getByRole('button', { name, exact: true }).click();
      const map = mapRegion(narrow, '코스 지도');
      await expectLineDrawn(map);
      const narrowCanvas = await map.locator('canvas').boundingBox();
      assert.ok(narrowCanvas);
      expect(narrowCanvas.width, 'map width in a 420px pane').toBeGreaterThanOrEqual(
        minimumPaneWidth,
      );
      for (const pane of ['map', 'list', 'sheet'] as const) {
        const box = await page.locator(`[data-pane="${pane}"]`).boundingBox();
        assert.ok(box, `${pane} pane in a 420px pane`);
        expect(box.width, `${pane} pane in a 420px pane`).toBeGreaterThanOrEqual(minimumPaneWidth);
      }
      expect(await overflow(page)).toBeLessThanOrEqual(0);

      // A shown map was never withdrawn on the way, and nothing but honest states appeared.
      const history = await mapStatusHistory(page);
      expect(history).not.toContain('not-drawn');
      expect(history).not.toContain('unavailable');
    });

    test('draws each course on switching between two far-apart courses', async ({ page }) => {
      const headers = await login(page);
      const suffix = randomUUID().slice(0, 8);
      await importCourse(page, headers, `서울 코스 ${suffix}`, seoul);
      await importCourse(page, headers, `부산 코스 ${suffix}`, busan);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      const map = mapRegion(workbench, '코스 지도');
      await workbench.getByRole('button', { name: `서울 코스 ${suffix}`, exact: true }).click();
      await expectLineDrawn(map);
      // Switching fits the new course: its line is drawn, not left outside the viewport of
      // the previous one. Each verdict must be about the course just opened — the third
      // switch returns to a CACHED course, with no loading gap, where a verdict left over
      // from the previous course would otherwise pass (review N1).
      for (const next of [`부산 코스 ${suffix}`, `서울 코스 ${suffix}`]) {
        const before = await map.getAttribute('data-paths-generation');
        await workbench.getByRole('button', { name: next, exact: true }).click();
        await expectLineDrawn(map, { changedFrom: before });
      }
    });

    test('says the map could not draw, on every map screen, when the renderer has no worker', async ({
      page,
    }) => {
      // Three screens, each held to the kit's 10 s render deadline before it may say so.
      test.setTimeout(120_000);
      const headers = await login(page);
      const name = `워커 없음 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      const activityId = await storeTrack(page, headers);
      await recordMapStatuses(page);
      await refuseMapWorker(page);
      await page.setViewportSize({ width: 1280, height: 900 });

      const notDrawn = async (region: ReturnType<typeof mapRegion>) => {
        await expect(region).toHaveAttribute('data-map-status', 'not-drawn', { timeout: 25_000 });
        await expect(mapStatusLine(region)).toHaveText(
          '지도가 경로를 그리지 못했습니다. 아래 좌표 목록을 사용하세요.',
        );
        expect(await renderedLines(region)).toBe(0);
      };

      // Courses.
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      await notDrawn(mapRegion(workbench, '코스 지도'));
      // The list-and-coordinates alternative says so too, and stays usable.
      await expect(
        workbench.getByText(/경유점 목록과 좌표 입력만으로 편집과 저장이/),
      ).toBeVisible();

      // The stored activity track.
      await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
      const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
      await notDrawn(mapRegion(panel, '저장된 활동 경로'));

      // The local-file preview.
      await page.goto(`${shell.origin}/activities/track-preview`);
      await page.getByLabel('미리 볼 기록 파일').setInputFiles({
        name: 'run.gpx',
        mimeType: 'application/octet-stream',
        buffer: previewGpx,
      });
      await notDrawn(mapRegion(page, '로컬 파일 경로'));
      await expect(
        page.getByText(
          '지도를 표시하지 못했습니다. 아래 표본 목록과 위 요약은 그대로 사용할 수 있습니다.',
        ),
      ).toBeVisible();

      // Across all three screens the map never claimed to show the path.
      const history = await mapStatusHistory(page);
      expect(history).not.toContain('drawn');
      expect(await page.getByText(/경로를 표시했습니다|지도 표시 중/).count()).toBe(0);
    });

    test('draws the stored track and the local preview', async ({ page }) => {
      const headers = await login(page);
      const activityId = await storeTrack(page, headers);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
      const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
      await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'));

      await page.goto(`${shell.origin}/activities/track-preview`);
      await page.getByLabel('미리 볼 기록 파일').setInputFiles({
        name: 'run.gpx',
        mimeType: 'application/octet-stream',
        buffer: previewGpx,
      });
      await expectLineDrawn(mapRegion(page, '로컬 파일 경로'));
    });

    test('names a browser without WebGL as its own state', async ({ page }) => {
      const headers = await login(page);
      const name = `WebGL 없음 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      await withoutWebGl(page);
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      const map = mapRegion(workbench, '코스 지도');
      await expect(map).toHaveAttribute('data-map-status', 'unavailable', { timeout: 20_000 });
      await expect(mapStatusLine(map)).toHaveText(
        '이 브라우저에서 지도 렌더러(WebGL)를 사용할 수 없습니다. 아래 좌표 목록을 사용하세요.',
      );
    });

    /**
     * `/courses/new` (M2-01r): before anything is computed, the only line is the dashed
     * uncomputed draft, drawn in its own layer. A working map must say it drew it — the
     * first rebase counted only the solid line layer and said "could not draw" here.
     */
    test('says the dashed uncomputed draft on a new course is drawn', async ({ page }) => {
      await login(page);
      await recordMapStatuses(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${shell.origin}/courses/new`);
      const screen = page.getByRole('region', { name: '새 코스' });
      const editor = screen.getByRole('region', { name: '경유지 편집' });
      for (const [longitude, latitude] of [
        ['126.978', '37.566'],
        ['126.982', '37.569'],
      ] as const) {
        await editor.getByLabel('경유점 경도').fill(longitude);
        await editor.getByLabel('경유점 위도').fill(latitude);
        await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
      }
      await expect(editor.getByTestId('draft-route-status')).toHaveAttribute(
        'data-status',
        'uncomputed',
      );
      await expectLineDrawn(mapRegion(screen, '코스 지도'));
      expect(await mapStatusHistory(page)).not.toContain('not-drawn');
      await expect(page.getByText(/지도를 표시할 수 없습니다|그리지 못했습니다/)).toHaveCount(0);
    });

    /**
     * Review B1 (RV2): a renderer that drew, then an edit while the course is off screen and
     * the background tiles are slow. `idle` waits for every tile, so no settled frame
     * arrives within the deadline — and that silence says nothing about whether the map can
     * draw. It must not be announced as "cannot draw".
     */
    test('does not call a map that drew unable to draw when an edit goes unconfirmed', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const name = `확인 대기 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      await recordMapStatuses(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      const map = mapRegion(workbench, '코스 지도');
      await expectLineDrawn(map);

      // Move the view off the course, and let it settle there.
      await moveViewOffCourse(page, map);
      // From here every background tile takes 30 s, and the view moves on to ground whose
      // tiles are not loaded yet — so no settled frame can arrive for a while.
      let delayed = 0;
      await page.route(/\/map\/basemap\/[^/]+\/tiles\//, async (route) => {
        delayed += 1;
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        await route.continue().catch(() => undefined);
      });
      await dragMapAway(page, map, 2);

      const editor = workbench.getByRole('region', { name: '경유지 편집' });
      await editor.getByLabel('경유점 경도').fill('126.9795');
      await editor.getByLabel('경유점 위도').fill('37.5675');
      await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();

      // Past the 10 s deadline.
      await expect(map).toHaveAttribute('data-map-status', 'unconfirmed', { timeout: 20_000 });
      await expect(mapStatusLine(map)).toHaveText(
        '경로가 지도에 그려졌는지 지금은 확인하지 못했습니다.',
      );
      expect(delayed, 'the pan really did wait on slow tiles').toBeGreaterThan(0);
      expect(await mapStatusHistory(page)).not.toContain('not-drawn');
      await expect(page.getByText(/그리지 못했습니다|지도를 표시할 수 없습니다/)).toHaveCount(0);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    /**
     * Plan §5: a resize only resizes. In the real renderer: move the view off the course,
     * then resize the page. A refit would bring the course back and say "drawn".
     */
    test('keeps the viewport the user chose across a resize', async ({ page }) => {
      const headers = await login(page);
      const name = `크기 조절 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      await recordMapStatuses(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      const map = mapRegion(workbench, '코스 지도');
      await expectLineDrawn(map);
      await moveViewOffCourse(page, map);
      const before = (await map.locator('canvas').boundingBox())?.width ?? 0;

      const seen = (await mapStatusHistory(page)).length;
      await page.setViewportSize({ width: 1300, height: 800 });
      // The renderer really resized…
      await expect
        .poll(async () => (await map.locator('canvas').boundingBox())?.width ?? 0)
        .not.toBe(before);
      // …and settled again without bringing the course back into view.
      await page.waitForTimeout(3_000);
      await expect(map).toHaveAttribute('data-map-status', 'out-of-view');
      expect((await mapStatusHistory(page)).slice(seen)).not.toContain('drawn');
    });
  });
}
