import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import { courseImportResultSchema } from '../../packages/contracts/src/courses';
import {
  fitFile,
  lapMessage,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';
import { expectLineDrawn, mapRegion, mapStatusHistory, recordMapStatuses } from './map-evidence';
import {
  createdSince,
  heldSince,
  holdRequests,
  instrumentLifecycle,
  lifecycleMark,
  recordAttemptedRequests,
  recordScripts,
  settleRequests,
} from './map-lifecycle-probe';

/**
 * M2-01k-d. The map is a client-only lazy leaf that both shells reuse (plan §5), and it
 * leaves nothing behind (plan §5, §6):
 *
 * - the map code arrives only when a map mounts, and S09's panes mount on demand while
 *   sharing one selection and one range;
 * - leaving the map — a tab change, a logout, an account switch — releases the renderer's
 *   WebGL context, its worker, its listeners and observers, its in-flight requests and any
 *   blob URL, and a response that arrives late never reaches the screen;
 * - no map screen even **attempts** a request to another origin.
 *
 * Everything is read from the browser: constructors and contexts are instrumented from the
 * first byte of each document (`map-lifecycle-probe.ts`), and the network is observed at the
 * route layer, where a request is seen before it can fail.
 */
const shells = [
  { name: 'Next', origin: 'http://127.0.0.1:3100' },
  { name: 'Vite', origin: 'http://127.0.0.1:4200' },
] as const;

const start = Date.parse('2026-03-01T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();

async function login(page: Page, subject: 'Alice' | 'Bob' = 'Alice') {
  await page.goto('http://127.0.0.1:3100/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${subject}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('http://127.0.0.1:3100/bff/v1/session');
  expect(response.status()).toBe(200);
  const session = (await response.json()) as { sessionId: string; csrfToken: string };
  return {
    origin: 'http://127.0.0.1:3100',
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

async function logout(page: Page) {
  await page.goto('http://127.0.0.1:3100/account');
  // Sign-out is an async request from this page; wait for it to land.
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
}

const records = [0, 1, 2, 3, 4, 5];

/** An activity with detail observations, two laps and a stored FIT track. */
async function storeTrack(page: Page, headers: Record<string, string>): Promise<string> {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'd'.repeat(64) },
    activity: {
      title: `수명 확인 ${randomUUID()}`,
      kind: 'running',
      startedAt: at(0),
      timezone: 'UTC',
      durationSeconds: 50,
      durationKind: 'elapsed',
      distanceMeters: 640,
    },
    details: {
      schemaVersion: 1,
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: at(0),
      recordedAt: at(50),
      elapsedSeconds: 50,
      records: records.map((index) => ({
        index,
        timestamp: at(index * 10),
        distanceMeters: index * 128,
        heartRateBpm: 140 + index,
      })),
      laps: [
        {
          index: 0,
          startedAt: at(0),
          recordedAt: at(30),
          elapsedSeconds: 30,
          timerSeconds: 30,
          distanceMeters: 384,
          averageHeartRateBpm: 141,
          maximumHeartRateBpm: 142,
        },
        {
          index: 1,
          startedAt: at(30),
          recordedAt: at(50),
          elapsedSeconds: 20,
          timerSeconds: 20,
          distanceMeters: 256,
          averageHeartRateBpm: 144,
          maximumHeartRateBpm: 145,
        },
      ],
    },
  });
  const { idempotencyKey, ...body } = command;
  const imported = await page.request.post('http://127.0.0.1:3100/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(imported.status()).toBe(200);
  const result = activityImportResultSchema.parse(await imported.json());
  const reserved = await page.request.post(
    `http://127.0.0.1:3100/bff/v1/activities/${result.activityId}/track-uploads`,
    {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedActivityRevision: result.revision, recordedTrackIndex: 0 },
    },
  );
  expect(reserved.status()).toBe(200);
  const reservation = (await reserved.json()) as { uploadId: string };
  const bytes = Buffer.from(
    fitFile([
      sessionMessage({ startedAt: at(0), elapsedSeconds: 50, distanceMeters: 640 }),
      lapMessage(at(0), 30),
      lapMessage(at(30), 20),
      ...records.map((index) =>
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
    `http://127.0.0.1:3100/bff/v1/activity-track-uploads/${reservation.uploadId}/content`,
    {
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-track-file-name': encodeURIComponent('lifecycle.fit'),
      },
      data: bytes,
    },
  );
  expect(uploaded.status()).toBe(200);
  const finalized = await page.request.post(
    `http://127.0.0.1:3100/bff/v1/activity-track-uploads/${reservation.uploadId}/finalize`,
    { headers: { ...headers, 'idempotency-key': randomUUID() } },
  );
  expect(finalized.status()).toBe(200);
  return result.activityId;
}

/** An activity with no stored track: its route tab mounts the panel and no map. */
async function bareActivity(page: Page, headers: Record<string, string>): Promise<string> {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'c'.repeat(64) },
    activity: {
      title: `경로 없음 ${randomUUID()}`,
      kind: 'running',
      startedAt: at(0),
      timezone: 'UTC',
      durationSeconds: 50,
      durationKind: 'elapsed',
      distanceMeters: 640,
    },
  });
  const { idempotencyKey, ...body } = command;
  const imported = await page.request.post('http://127.0.0.1:3100/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(imported.status()).toBe(200);
  return activityImportResultSchema.parse(await imported.json()).activityId;
}

async function importCourse(page: Page, headers: Record<string, string>, name: string) {
  const points = [
    [126.978, 37.566],
    [126.982, 37.568],
    [126.986, 37.567],
  ] as const;
  const gpx =
    `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="identity-e2e" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<rte><name>${name}</name>` +
    points.map(([lon, lat]) => `<rtept lat="${lat}" lon="${lon}" />`).join('') +
    `</rte></gpx>\n`;
  const response = await page.request.post('http://127.0.0.1:3100/bff/v1/courses/imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      name,
      originalFilename: 'lifecycle.gpx',
      selection: null,
      fileBase64: Buffer.from(gpx, 'utf8').toString('base64'),
    },
  });
  expect(response.status()).toBe(200);
  const result = courseImportResultSchema.parse(await response.json());
  assert.ok(result.outcome === 'imported' && result.course.status === 'available');
  return result.course.course.courseId;
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

const route = (origin: string, activityId: string, tab = 'route') =>
  `${origin}/activities?selected=${activityId}&detailTab=${tab}`;
const trackPanel = (page: Page) => page.getByRole('region', { name: '저장된 경로', exact: true });
const trackMap = (page: Page) => mapRegion(trackPanel(page), '저장된 활동 경로');
/** Background tiles, when a self-hosted basemap is deployed on this machine. */
const tiles = /\/map\/basemap\/[^/]+\/tiles\//;

async function basemapDeployed(page: Page): Promise<boolean> {
  return (
    (await page.request.get('http://127.0.0.1:3100/map/basemap/current.json')).status() === 200
  );
}

/**
 * MapLibre keeps one worker per page, shared by every map and never terminated by
 * `remove()` (its RTL-text support holds the global worker pool). What a map puts in that
 * worker is released per map (`worker-map-state`, the `removeMap` message); the worker
 * itself may stay, once. Everything else a map created must be gone.
 */
const sharedWorker = 'worker /dist/maplibre/maplibre-gl-worker.mjs';
async function leftovers(page: Page, mark: number): Promise<string[]> {
  const held = await heldSince(page, mark);
  const shared = held.indexOf(sharedWorker);
  return shared === -1 ? held : held.filter((_, index) => index !== shared);
}

/** What the map held, by kind, from the labels the probe returns. */
const kinds = (labels: readonly string[]) =>
  [...new Set(labels.map((label) => label.split(' ')[0]))].sort();

/**
 * Tell the workspace the tab became visible again. That is when it re-reads the session —
 * which is how a logout or an account switch made in another tab reaches this one.
 */
async function returnToTab(page: Page) {
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true })),
  );
}

/** Every text this page ever showed that matches `pattern`, from now on. */
async function watchText(page: Page, pattern: string) {
  await page.evaluate((source) => {
    const seen: string[] = [];
    (window as unknown as { __watched: string[] }).__watched = seen;
    const expression = new RegExp(source);
    const check = (node: Node) => {
      const text = node.textContent ?? '';
      if (expression.test(text)) seen.push(text.slice(0, 120));
    };
    new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) check(node);
        if (change.type === 'characterData') check(change.target);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, pattern);
}
const watched = (page: Page) =>
  page.evaluate(() => (window as unknown as { __watched?: string[] }).__watched ?? []);

/** A second tab of the same browser session, used to sign out or switch accounts. */
const otherTab = (page: Page) => page.context().newPage();

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('loads the map code only when a map mounts', async ({ page }) => {
      const headers = await login(page);
      const tracked = await storeTrack(page, headers);
      const bare = await bareActivity(page, headers);
      const courseName = `지연 로딩 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, courseName);
      await page.setViewportSize({ width: 1280, height: 900 });
      const scripts = await recordScripts(page);
      const none = { view: false, adapter: false, sdk: false };
      const map = async () => {
        await scripts.settle();
        const { view, adapter, sdk } = await scripts.seen();
        return { view, adapter, sdk };
      };

      // The route panel itself is lazy, and it is not the map: an activity with no stored
      // track mounts the panel and no map, so no map code may arrive.
      scripts.reset();
      await page.goto(route(shell.origin, bare));
      await expect(page.getByText(/이 활동에는 저장된 경로가 없습니다/)).toBeVisible();
      await scripts.settle();
      expect((await scripts.seen()).panel, 'the lazy route panel did load').toBe(true);
      expect(await map(), 'map code with no map mounted').toEqual(none);

      // The overview of an activity that has a track: still no map, until the route tab
      // mounts one.
      scripts.reset();
      await page.goto(route(shell.origin, tracked, 'overview'));
      await expect(page.getByRole('tab', { name: '개요', selected: true })).toBeVisible();
      await expect(page.getByRole('region', { name: '활동 요약 출처', exact: true })).toBeVisible();
      expect(await map(), 'map code before the route tab').toEqual(none);
      await page.getByRole('tab', { name: '경로', exact: true }).click();
      await expectLineDrawn(trackMap(page));
      expect(await map(), 'map code once the map mounted').toEqual({
        view: true,
        adapter: true,
        sdk: true,
      });

      // Courses: the list has no map; opening a course mounts one.
      scripts.reset();
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await expect(workbench.getByRole('button', { name: courseName, exact: true })).toBeVisible();
      expect(await map(), 'map code on the course list').toEqual(none);
      await workbench.getByRole('button', { name: courseName, exact: true }).click();
      await expectLineDrawn(mapRegion(workbench, '코스 지도'));
      expect(await map(), 'map code once a course map mounted').toEqual({
        view: true,
        adapter: true,
        sdk: true,
      });
    });

    test('mounts S09 panes on demand and shares one selection, range and viewport', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const tracked = await storeTrack(page, headers);
      await instrumentLifecycle(page);
      await recordMapStatuses(page);
      const panes = page.getByTestId('stored-track-panes');
      const pane = (name: 'map' | 'chart' | 'detail') =>
        panes.locator(`:scope > [id$="-${name}-pane"]`);
      const status = () => trackPanel(page).getByText(/^선택 표본 0:\d/);

      // Mobile: the map tab is shown, so only the map is mounted.
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(route(shell.origin, tracked));
      await expectLineDrawn(trackMap(page));
      await expect(panes).toHaveAttribute('data-layout', 'mobile');
      await expect(pane('map')).toHaveAttribute('data-mounted', 'true');
      await expect(pane('chart')).toHaveAttribute('data-mounted', 'false');
      await expect(pane('detail')).toHaveAttribute('data-mounted', 'false');
      expect(await pane('chart').locator('svg').count(), 'no chart before its tab').toBe(0);
      expect(await pane('detail').locator('ol').count(), 'no sample list before its tab').toBe(0);
      const mark = await lifecycleMark(page);
      // Remember this renderer's canvas: a remount would put a different one in its place.
      await trackMap(page)
        .locator('canvas')
        .evaluate((canvas) => {
          (window as unknown as { __s09Canvas: Element }).__s09Canvas = canvas;
        });
      const sameRenderer = () =>
        trackMap(page)
          .locator('canvas')
          .evaluate(
            (canvas) =>
              canvas === (window as unknown as { __s09Canvas: Element }).__s09Canvas &&
              canvas.isConnected,
          );

      await trackPanel(page).getByRole('button', { name: '끝 지점', exact: true }).click();
      await expect(status()).toHaveText(/^선택 표본 0:5/);

      // The graph tab mounts the chart on demand, showing the same selection.
      const tabs = trackPanel(page).getByRole('tablist', { name: '저장된 경로 보기' });
      await tabs.getByRole('tab', { name: '그래프', exact: true }).click();
      await expect(pane('chart')).toHaveAttribute('data-mounted', 'true');
      const chart = pane('chart').getByRole('img', { name: '원본 심박 (bpm) 차트' });
      await expect(chart).toBeVisible();
      await expect(chart.locator('circle[data-selected="true"]')).toHaveCount(1);
      await expect(chart.locator('circle[aria-label="차트 관측 5 선택"]')).toHaveAttribute(
        'data-selected',
        'true',
      );
      // A point picked in the graph is the map's selection too.
      await chart.locator('circle[aria-label="차트 관측 3 선택"]').click();
      await expect(status()).toHaveText(/^선택 표본 0:3/);
      expect(await pane('detail').locator('ol').count(), 'detail still not visited').toBe(0);

      // Back to the map: the same renderer, and it was never rebuilt meanwhile.
      await tabs.getByRole('tab', { name: '지도', exact: true }).click();
      await expect(pane('map')).toBeVisible();
      expect(await sameRenderer(), 'the map tab kept its renderer').toBe(true);
      expect(
        kinds(await createdSince(page, mark)),
        'nothing new created by tab changes',
      ).not.toContain('webgl-context');

      // Tablet: the graph or the map, never all three forced at once.
      await page.setViewportSize({ width: 1024, height: 900 });
      await expect(panes).toHaveAttribute('data-layout', 'tablet');
      await expect(tabs.getByRole('tab')).toHaveText(['지도', '그래프']);
      await expect(pane('map')).toBeVisible();
      await expect(pane('chart')).toBeHidden();
      await expect(pane('detail')).toBeVisible();
      await tabs.getByRole('tab', { name: '그래프', exact: true }).click();
      await expect(pane('map')).toBeHidden();
      await expect(pane('chart')).toBeVisible();

      // Desktop: the linked split-pane, graph and map on screen together.
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(panes).toHaveAttribute('data-layout', 'desktop');
      await expect(pane('map')).toBeVisible();
      await expect(pane('chart')).toBeVisible();
      await expect(status()).toHaveText(/^선택 표본 0:3/);
      expect(await sameRenderer(), 'one renderer across every layout').toBe(true);

      // A range chosen elsewhere (a lap on the interval tab) is the same range here: the
      // graph marks it and the map draws it as a second line.
      await page.getByRole('tab', { name: '구간', exact: true }).click();
      await page
        .getByRole('navigation', { name: '원본 상세 보기' })
        .getByRole('button', { name: '랩', exact: true })
        .click();
      await page.getByRole('button', { name: '랩 0 선택', exact: true }).click();
      await page.getByRole('tab', { name: '경로', exact: true }).click();
      await expect(
        trackPanel(page).getByText(/선택한 구간의 표본 \d+개를 지도에서 강조했습니다/),
      ).toBeVisible();
      const inRange = pane('chart')
        .getByRole('img', { name: '원본 심박 (bpm) 차트' })
        .locator('circle[data-in-range="true"]');
      await expect(inRange).toHaveCount(4);
      await expectLineDrawn(trackMap(page));
      expect(await mapStatusHistory(page)).not.toContain('not-drawn');
    });

    test('keeps the viewport the user chose when a mobile tab hides and shows the map', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const tracked = await storeTrack(page, headers);
      await recordMapStatuses(page);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(route(shell.origin, tracked));
      const map = trackMap(page);
      await expectLineDrawn(map);
      // Pan far off the track, until the map itself says the track is out of view.
      await expect
        .poll(
          async () => {
            await map.locator('canvas').scrollIntoViewIfNeeded();
            const box = await map.locator('canvas').boundingBox();
            if (!box) return 'no canvas';
            await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
            await page.mouse.down();
            for (let step = 1; step <= 10; step += 1)
              await page.mouse.move(
                box.x + box.width * (0.9 - (0.8 * step) / 10),
                box.y + box.height / 2,
              );
            await page.mouse.up();
            return map.getAttribute('data-map-status');
          },
          { timeout: 30_000, intervals: [1_000] },
        )
        .toBe('out-of-view');
      const seen = (await mapStatusHistory(page)).length;
      const tabs = trackPanel(page).getByRole('tablist', { name: '저장된 경로 보기' });
      await tabs.getByRole('tab', { name: '그래프', exact: true }).click();
      await expect(map).toBeHidden();
      await tabs.getByRole('tab', { name: '지도', exact: true }).click();
      await expect(map).toBeVisible();
      // A rebuilt map would fit the track again and say "drawn"; the kept one stays where
      // the user left it.
      await expect(map).toHaveAttribute('data-map-status', 'out-of-view');
      expect((await mapStatusHistory(page)).slice(seen)).not.toContain('drawn');
    });

    test('releases the renderer, worker, listeners and requests when the map unmounts', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const tracked = await storeTrack(page, headers);
      const pending = await storeTrack(page, headers);
      const withTiles = await basemapDeployed(page);
      await instrumentLifecycle(page);
      await page.setViewportSize({ width: 1280, height: 900 });

      await page.goto(route(shell.origin, tracked, 'overview'));
      await expect(page.getByRole('tab', { name: '개요', selected: true })).toBeVisible();
      const mark = await lifecycleMark(page);
      // Background tiles that never answer: requests the map has in flight when it goes.
      const heldTiles = withTiles ? await holdRequests(page, tiles) : null;
      await page.getByRole('tab', { name: '경로', exact: true }).click();
      await expectLineDrawn(trackMap(page));
      // Positive control: the probe does see what a mounted map holds.
      expect(kinds(await heldSince(page, mark))).toEqual(
        expect.arrayContaining([
          'listener',
          'resize-observer',
          'webgl-context',
          'worker',
          'worker-map-state',
        ]),
      );
      if (heldTiles) await expect.poll(() => heldTiles.count()).toBeGreaterThan(0);
      // The first map creates the page's one shared MapLibre worker, and only one.
      expect(
        (await createdSince(page, mark)).filter((label) => label === sharedWorker),
        'shared workers created by the first map',
      ).toHaveLength(1);

      // Leave the route tab: the map unmounts and must take everything with it.
      await page.getByRole('tab', { name: '구간', exact: true }).click();
      await expect(trackPanel(page)).toHaveCount(0);
      await expect.poll(() => leftovers(page, mark), { message: 'held after unmount' }).toEqual([]);
      if (heldTiles) {
        await expect
          .poll(() => heldTiles.stillWanted(), { message: 'tile requests not cancelled' })
          .toEqual([]);
        await heldTiles.releaseAll();
      }

      // Mounting the map again reuses what the page already has: no second worker, and
      // everything the second map created is released again when it goes.
      const again = await lifecycleMark(page);
      await page.getByRole('tab', { name: '경로', exact: true }).click();
      await expectLineDrawn(trackMap(page));
      expect(kinds(await createdSince(page, again))).toContain('webgl-context');
      await page.getByRole('tab', { name: '구간', exact: true }).click();
      await expect(trackPanel(page)).toHaveCount(0);
      await expect
        .poll(() => heldSince(page, again), { message: 'held after a remount' })
        .toEqual([]);
      expect(await createdSince(page, again)).not.toContain(sharedWorker);

      // A request the screen still waits for when it goes away is cancelled, not left to
      // land: the track content of another activity, held at the network.
      const content = await holdRequests(page, /\/track\/content\?variant=/);
      await page.goto(route(shell.origin, pending, 'overview'));
      await page.getByRole('tab', { name: '경로', exact: true }).click();
      await expect(trackPanel(page).getByText('경로 좌표를 불러오고 있습니다.')).toBeVisible();
      await expect.poll(() => content.count()).toBe(2);
      await page.getByRole('tab', { name: '구간', exact: true }).click();
      await expect(trackPanel(page)).toHaveCount(0);
      await expect
        .poll(() => content.stillWanted(), { message: 'track requests not cancelled' })
        .toEqual([]);
      await content.releaseAll();
    });

    test('releases the course map, its download and its requests when the course closes', async ({
      page,
    }) => {
      const headers = await login(page);
      const name = `코스 수명 ${shell.name} ${randomUUID().slice(0, 8)}`;
      const courseId = await importCourse(page, headers, name);
      // The S13 list cards (M2-01k-a) hold a blob URL per stored picture for as long as the
      // list is on screen, and the list outlives the course. Let this course's picture be
      // made, and every card's stored picture land, before the mark, so what is counted
      // after it is only what opening the course created.
      await expect
        .poll(
          async () =>
            (
              (await (
                await page.request.get(`http://127.0.0.1:3100/bff/v1/courses/${courseId}`, {
                  headers,
                })
              ).json()) as { thumbnail: { status: string } }
            ).thumbnail.status,
          { timeout: 20_000 },
        )
        .toBe('ready');
      await instrumentLifecycle(page);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await expect(workbench.getByRole('button', { name, exact: true })).toBeVisible();
      await expect(
        workbench.locator('[data-testid="course-card"][data-card-status="ready"]').first(),
      ).toBeAttached();
      await expect(
        workbench.locator('[data-thumbnail-state="ready"] [data-source="drawn"]'),
      ).toHaveCount(0);
      const mark = await lifecycleMark(page);
      await workbench.getByRole('button', { name, exact: true }).click();
      await expectLineDrawn(mapRegion(workbench, '코스 지도'));
      // The owner's GPX download goes through a blob URL.
      const download = page.waitForEvent('download');
      await workbench.getByTestId('course-export').click();
      await download;
      expect(kinds(await createdSince(page, mark))).toContain('blob-url');
      await workbench.getByRole('button', { name: '코스 목록으로 돌아가기' }).click();
      await expect(mapRegion(workbench, '코스 지도')).toHaveCount(0);
      await expect
        .poll(() => leftovers(page, mark), { message: 'held after the course closed' })
        .toEqual([]);
    });

    test('releases the map when the account signs out in another tab', async ({ page }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const tracked = await storeTrack(page, headers);
      const withTiles = await basemapDeployed(page);
      await instrumentLifecycle(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(route(shell.origin, tracked, 'overview'));
      await expect(page.getByRole('tab', { name: '개요', selected: true })).toBeVisible();
      const mark = await lifecycleMark(page);
      const heldTiles = withTiles ? await holdRequests(page, tiles) : null;
      await page.getByRole('tab', { name: '경로', exact: true }).click();
      await expectLineDrawn(trackMap(page));
      expect(kinds(await heldSince(page, mark))).toEqual(
        expect.arrayContaining(['webgl-context', 'worker', 'worker-map-state']),
      );

      const other = await otherTab(page);
      await logout(other);
      await returnToTab(page);
      await expect(page.getByText('이 작업은 로그인이 필요합니다.')).toBeVisible();
      await expect(trackPanel(page)).toHaveCount(0);
      await expect.poll(() => leftovers(page, mark), { message: 'held after logout' }).toEqual([]);
      if (heldTiles) {
        await expect.poll(() => heldTiles.stillWanted()).toEqual([]);
        await heldTiles.releaseAll();
      }
      // Carried over from activity-track-map.spec: nothing about the track in browser storage.
      expect(
        await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('track'))),
      ).toEqual([]);
      await other.close();
    });

    test('releases the map and cancels the old account’s pending requests on an account switch', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const shown = await storeTrack(page, headers);
      const late = await storeTrack(page, headers);
      await instrumentLifecycle(page);
      await page.setViewportSize({ width: 1280, height: 900 });

      // Alice's map is on screen.
      await page.goto(route(shell.origin, shown, 'overview'));
      await expect(page.getByRole('tab', { name: '개요', selected: true })).toBeVisible();
      const mark = await lifecycleMark(page);
      await page.getByRole('tab', { name: '경로', exact: true }).click();
      await expectLineDrawn(trackMap(page));

      // Then, in the same document, she opens another activity whose track is still on its
      // way when the account changes: its requests are held at the network.
      const pending = await holdRequests(page, /\/track\/content\?variant=/);
      const failed: string[] = [];
      page.on('requestfailed', (request) => {
        if (request.url().includes('/track/content')) failed.push(request.url());
      });
      // The screen follows the address (both shells listen to `popstate`), so this is an
      // in-app navigation: the probe's marks stay valid in this one document.
      await page.evaluate((address) => {
        history.pushState(null, '', address);
        dispatchEvent(new PopStateEvent('popstate'));
      }, `/activities?selected=${late}&detailTab=route`);
      await expect(trackPanel(page).getByText('경로 좌표를 불러오고 있습니다.')).toBeVisible();
      // Alice's first map went with the activity it showed.
      await expect(trackMap(page)).toHaveCount(0);
      await expect.poll(() => pending.count()).toBe(2);
      expect(failed, 'nothing cancelled before the switch').toEqual([]);

      // Bob signs in in another tab; this tab notices when it becomes visible again.
      const other = await otherTab(page);
      await logout(other);
      await login(other, 'Bob');
      await returnToTab(page);
      // Bob's workspace cannot read Alice's activity at all.
      await expect(
        page.getByText('기록이 삭제되었거나 접근할 수 없습니다.', { exact: true }),
      ).toBeVisible();
      await expect(trackPanel(page)).toHaveCount(0);

      // The page itself gave up on both requests: nothing of Alice's can still arrive.
      await expect
        .poll(() => failed.length, { message: 'the pending track requests were cancelled' })
        .toBe(2);
      expect(pending.stillWanted()).toEqual([]);
      await pending.releaseAll();
      await expect(trackPanel(page)).toHaveCount(0);
      await expect(mapRegion(page, '저장된 활동 경로')).toHaveCount(0);
      await expect.poll(() => leftovers(page, mark)).toEqual([]);
      await other.close();
    });

    /**
     * Data that did arrive. A response can only reach this page while the account it belongs
     * to is still the page's account: once the account changes elsewhere, the next request
     * this page makes (the session re-read, or a refetch on focus) answers 401/409 and the
     * workspace tears down, and every pending query is cancelled with it (the test above).
     * So what the change must deal with is Alice's track already delivered into her cache and
     * on her screen. It must go, and never come back: not on the signed-out screen, not for
     * Bob looking at the same address.
     */
    for (const change of ['sign-out', 'switch to Bob'] as const)
      test(`discards the old account’s delivered track on a ${change} elsewhere`, async ({
        page,
      }) => {
        test.setTimeout(90_000);
        const headers = await login(page);
        const tracked = await storeTrack(page, headers);
        await page.setViewportSize({ width: 1280, height: 900 });
        const delivered: number[] = [];
        page.on('response', (response) => {
          if (response.url().includes('/track/content')) delivered.push(response.status());
        });
        await page.goto(route(shell.origin, tracked));
        // The delivery is real: both answers reached the page, and the screen shows them.
        await expectLineDrawn(trackMap(page));
        await expect(trackPanel(page)).toContainText('위치 있음');
        expect(delivered).toEqual([200, 200]);
        await watchText(page, '위치 있음|선택 표본');

        const other = await otherTab(page);
        await logout(other);
        if (change === 'switch to Bob') await login(other, 'Bob');
        await returnToTab(page);
        if (change === 'sign-out')
          await expect(page.getByText('이 작업은 로그인이 필요합니다.')).toBeVisible();
        else
          await expect(
            page.getByText('기록이 삭제되었거나 접근할 수 없습니다.', { exact: true }),
          ).toBeVisible();
        // Let the new workspace settle before the final look.
        await settleRequests(page);
        await expect(page.getByText(/위치 있음|선택 표본/)).toHaveCount(0);
        await expect(trackPanel(page)).toHaveCount(0);
        expect(await watched(page), 'the old account’s track after the change').toEqual([]);
        await other.close();
      });

    test('attempts no request to another origin on any map screen', async ({ page }) => {
      test.setTimeout(120_000);
      const headers = await login(page);
      const tracked = await storeTrack(page, headers);
      const name = `외부 요청 ${shell.name} ${randomUUID().slice(0, 8)}`;
      const courseId = await importCourse(page, headers, name);
      const withTiles = await basemapDeployed(page);
      // Recording starts after the sign-in, which legitimately visits the identity provider.
      const network = await recordAttemptedRequests(page.context(), shell.origin);
      await page.setViewportSize({ width: 1280, height: 900 });
      const violations: string[] = [];
      const visit = async (url: string, drawn: () => Promise<void>) => {
        await page.goto(url);
        await drawn();
        violations.push(...(await network.violations(page)));
      };

      // S09 stored track, by its own address and by the spec alias.
      await visit(route(shell.origin, tracked), () => expectLineDrawn(trackMap(page)));
      await visit(`${shell.origin}/activities/${tracked}?tab=route`, () =>
        expectLineDrawn(trackMap(page)),
      );
      // The local-file preview.
      await visit(`${shell.origin}/activities/track-preview`, async () => {
        await page.getByLabel('미리 볼 기록 파일').setInputFiles({
          name: 'run.gpx',
          mimeType: 'application/octet-stream',
          buffer: previewGpx,
        });
        await expectLineDrawn(mapRegion(page, '로컬 파일 경로'));
      });
      // Course list with a course open, the course editor, and a new course.
      await visit(`${shell.origin}/courses`, async () => {
        const workbench = page.getByRole('region', { name: '내 코스' });
        await workbench.getByRole('button', { name, exact: true }).click();
        await expectLineDrawn(mapRegion(workbench, '코스 지도'));
      });
      await visit(`${shell.origin}/courses/${courseId}/edit`, () =>
        expectLineDrawn(mapRegion(page.getByRole('region', { name: '내 코스' }), '코스 지도')),
      );
      await visit(`${shell.origin}/courses/new`, async () => {
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
        await expectLineDrawn(mapRegion(screen, '코스 지도'));
      });

      const attempts = network.attempts();
      // Positive control: the recorder saw the map's own traffic, worker script included.
      expect(attempts.some((url) => url.includes('/dist/maplibre/maplibre-gl-worker'))).toBe(true);
      if (withTiles) expect(attempts.some((url) => tiles.test(url))).toBe(true);
      expect(network.external(), 'requests attempted to another origin').toEqual([]);
      expect(violations, 'requests a Content-Security-Policy refused').toEqual([]);
    });
  });
}
