import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import {
  fitFile,
  lapMessage,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';
import { expectLineDrawn, mapRegion } from './map-evidence';

/**
 * S09 stored-track route screen, against the real OIDC session, API, PostgreSQL and object
 * storage — and against the self-hosted basemap when one has been built on this machine.
 *
 * The track here is genuinely stored: real FIT bytes are uploaded, the server re-parses
 * them in its bounded worker, and the screen then *re-reads* them over the API after a
 * full page load. Nothing in the browser hands the server a parse result.
 */
const start = Date.parse('2026-03-01T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
// Inside the bounds of the self-hosted Seoul basemap deployment.
const longitude = (index: number) => 126.978 + index / 2000;
const latitude = (index: number) => 37.566 + index / 2000;

/** Six records; the third has no fix, so the recording is drawn as three pieces. */
const positioned = [0, 1, 3, 4, 5];
const fitBytes = Buffer.from(
  fitFile([
    sessionMessage({ startedAt: at(0), elapsedSeconds: 50, distanceMeters: 640 }),
    lapMessage(at(0), 30),
    lapMessage(at(30), 20),
    ...[0, 1, 2, 3, 4, 5].map((index) =>
      recordMessage({
        at: at(index * 10),
        ...(positioned.includes(index)
          ? { longitude: longitude(index), latitude: latitude(index) }
          : { longitude: null, latitude: null }),
        heartRate: 140 + index,
        distanceMeters: index * 128,
      }),
    ),
  ]),
);

async function login(page: Page, subject: 'Alice' | 'Bob' = 'Alice') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${subject}` }).click();
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

/** Imports the activity with matching detail observations and stores the FIT track. */
async function storeTrack(page: Page, headers: Record<string, string>) {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'e'.repeat(64) },
    activity: {
      title: `저장된 경로 활동 ${randomUUID()}`,
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
      // Same instants as the FIT records, which is what the screen's correspondence uses.
      records: [0, 1, 2, 3, 4, 5].map((index) => ({
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
        'x-track-file-name': encodeURIComponent('run.fit'),
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
  return result.activityId;
}

const routeAddress = (activityId: string) => `/activities?selected=${activityId}&detailTab=route`;
const intervalAddress = (activityId: string) =>
  `/activities?selected=${activityId}&detailTab=intervals`;

test('re-reads a stored track after a full load, draws it and round-trips selection', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const foreignRequests: string[] = [];
  const consoleMessages: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleMessages.push(message.text()));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:3100' && url.protocol !== 'data:')
      foreignRequests.push(request.url());
  });
  const headers = await login(page);
  const activityId = await storeTrack(page, headers);

  // Only what the screen itself requests counts here; the login redirect legitimately
  // visits the identity provider before this point.
  foreignRequests.length = 0;
  // A full load: nothing from the upload is still in memory.
  await page.goto(routeAddress(activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('전체 6개 · 위치 있음 5개 · 구간 3개');
  await expect(panel).toContainText('경로 수정 번호');
  // Device-reported distance and the GPS recomputation stay separate values.
  await expect(panel).toContainText('640m');
  // The map's own status line says the path is shown only after the renderer drew our
  // line features; a loaded style is not enough (M2-01q).
  await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'));
  await expect(panel.getByText(/위치가 없어 표시하지 않았습니다/)).toBeVisible();

  // Start and end resolve to the stored track's own sample ids.
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await expect(panel.getByText(/선택 표본 0:0/)).toBeVisible();
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await expect(panel.getByText(/선택 표본 0:5/)).toBeVisible();

  // The selection survives the tab change and appears as the same observation, then a new
  // observation selection comes back to the map as its sample.
  await page.goto(intervalAddress(activityId));
  const selection = page.getByRole('region', { name: '관측 선택 요약', exact: true });
  await expect(selection).toContainText('선택 구간 없음');
  await page.getByRole('button', { name: '관측 3 선택', exact: true }).click();
  await expect(selection).toContainText('선택한 관측 3');
  await page.getByRole('tab', { name: '경로', exact: true }).click();
  await expect(panel.getByText(/선택 표본 0:3/)).toBeVisible();

  // The other direction, without a reload: a sample picked on the route tab is the same
  // selection the interval workbench shows after a tab change.
  await panel.getByRole('button', { name: /^0:1 · /u }).click();
  await expect(panel.getByText(/선택 표본 0:1/)).toBeVisible();
  await page.getByRole('tab', { name: '구간', exact: true }).click();
  await expect(selection).toContainText('선택한 관측 1');

  // The observation whose sample has no fix keeps its measurements and says it is not drawn.
  await page.getByRole('button', { name: '관측 2 선택', exact: true }).click();
  await page.getByRole('tab', { name: '경로', exact: true }).click();
  await expect(panel.getByText(/선택 표본 0:2/)).toBeVisible();
  await expect(panel.getByText(/지도에 그려진 지점이 아닙니다/)).toBeVisible();

  expect(foreignRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  // Precise coordinates never reach the console: the recorded decimal degrees of this
  // track would show up as these literals if anything logged a position.
  expect(consoleMessages.filter((text) => /126\.97|37\.56/.test(text))).toEqual([]);
  // …and nothing about the track is written to browser storage.
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('track'))),
  ).toEqual([]);
});

test('draws the stored path over the self-hosted basemap with its attribution', async ({
  page,
}, testInfo) => {
  const headers = await login(page);
  const activityId = await storeTrack(page, headers);
  const styleResponse = await page.request.get('/map/basemap/current.json');
  test.skip(
    styleResponse.status() !== 200,
    'No self-hosted basemap deployment on this machine (scripts/build-basemap.mjs is opt-in).',
  );
  const pointer = (await styleResponse.json()) as { deploymentId: string };

  const assets: string[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/map/basemap/'))
      assets.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(routeAddress(activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'));
  // ODbL attribution is rendered next to the map as plain text by the kit itself, so it
  // is present whether or not the renderer's own control is.
  const attribution = panel.getByText(/Background map tiles built by Workout Manager/);
  await expect(attribution).toBeVisible();
  await expect(attribution).toContainText('OpenStreetMap contributors');
  await expect(panel.getByText(/배경 지도를 불러오지 못했습니다/)).toHaveCount(0);
  await expect(panel.getByText(/WebGL/)).toHaveCount(0);
  await expect
    .poll(() => assets.filter((entry) => entry.startsWith('200 ')).length)
    .toBeGreaterThan(2);
  expect(assets.filter((entry) => !entry.startsWith('200 '))).toEqual([]);
  expect(assets.some((entry) => entry.includes(`/${pointer.deploymentId}/style.json`))).toBe(true);
  expect(assets.some((entry) => entry.includes('/tiles/'))).toBe(true);
  await testInfo.attach('basemap-assets', { body: assets.join('\n'), contentType: 'text/plain' });
});

test('lays out S09 at every breakpoint boundary and in a 420px pane', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const headers = await login(page);
  const activityId = await storeTrack(page, headers);
  await page.goto(routeAddress(activityId));
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  const panes = page.getByTestId('stored-track-panes');
  await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'));
  await panel.getByRole('button', { name: '끝 지점', exact: true }).click();
  await expect(panel.getByText(/선택 표본 0:5/)).toBeVisible();

  // S09 desktop split-pane: the large graph and the map are on screen together.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('group', { name: '저장된 경로 지도', exact: true })).toBeVisible();
  await expect(
    page.getByRole('group', { name: '저장된 경로 관측 그래프', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: '원본 심박 (bpm) 차트' })).toBeVisible();

  for (const [width, mode] of [
    [320, 'mobile'],
    [767, 'mobile'],
    [768, 'tablet'],
    [1279, 'tablet'],
    [1280, 'desktop'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect(panes).toHaveAttribute('data-layout', mode);
    // The selection is kept across every layout change.
    await expect(panel.getByText(/선택 표본 0:5/)).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  expect(pageErrors).toEqual([]);

  // Mobile tabs: one pane at a time, reachable from the keyboard.
  await page.setViewportSize({ width: 360, height: 900 });
  const tabs = panel.getByRole('tablist', { name: '저장된 경로 보기', exact: true });
  await expect(tabs).toBeVisible();
  await tabs.getByRole('tab', { name: '지도', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '그래프', exact: true })).toBeFocused();
  await expect(panes).toHaveAttribute('data-pane', 'chart');
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '요약·표본', exact: true })).toBeFocused();
  await expect(panes).toHaveAttribute('data-pane', 'detail');
  await expect(panel.getByText(/선택 표본 0:5/)).toBeVisible();

  // A 420px module container inside a wide viewport.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('main.wm-page').evaluate((element) => {
    element.style.width = '420px';
    element.style.boxSizing = 'border-box';
  });
  await expect(panel.getByText(/선택 표본 0:5/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('another account never sees the stored track', async ({ page }) => {
  const headers = await login(page);
  const activityId = await storeTrack(page, headers);
  await page.goto(routeAddress(activityId));
  await expect(page.getByText('전체 6개 · 위치 있음 5개 · 구간 3개')).toBeVisible();

  await page.goto('/account');
  // Sign-out is an async request from this page; navigating before it lands can cancel it
  // and leave the previous account signed in.
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
  const bob = await login(page, 'Bob');
  await page.goto(routeAddress(activityId));
  // Bob's session cannot read Alice's activity at all, so neither the summary nor the
  // stored geometry is on screen.
  await expect(page.getByText('전체 6개 · 위치 있음 5개 · 구간 3개')).toHaveCount(0);
  await expect(page.getByText(/선택 표본/)).toHaveCount(0);
  const direct = await page.request.get(`/bff/v1/activities/${activityId}/track`, {
    headers: bob,
  });
  expect(direct.status()).toBe(404);
  const content = await page.request.get(
    `/bff/v1/activities/${activityId}/track/content?variant=map_path`,
    { headers: bob },
  );
  expect(content.status()).toBe(404);
});

test('shows the stored track in the Vite shell too', async ({ page }) => {
  const headers = await login(page);
  const activityId = await storeTrack(page, headers);
  await page.goto(`http://127.0.0.1:4200${routeAddress(activityId)}`);
  const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
  await expect(panel).toContainText('전체 6개 · 위치 있음 5개 · 구간 3개');
  await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'));
  await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
  await expect(panel.getByText(/선택 표본 0:0/)).toBeVisible();
});

test('says so when an activity has no stored track', async ({ page }) => {
  const headers = await login(page);
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'f'.repeat(64) },
    activity: {
      title: `경로 없는 활동 ${randomUUID()}`,
      kind: 'running',
      startedAt: at(0),
      timezone: 'UTC',
      durationSeconds: 50,
      durationKind: 'elapsed',
      distanceMeters: 640,
    },
  });
  const { idempotencyKey, ...body } = command;
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(imported.status()).toBe(200);
  const result = activityImportResultSchema.parse(await imported.json());
  await page.goto(routeAddress(result.activityId));
  await expect(page.getByText(/이 활동에는 저장된 경로가 없습니다/)).toBeVisible();
  // The summary stays usable next to the empty route state.
  await expect(page.getByRole('region', { name: '활동 요약 출처', exact: true })).toBeVisible();
});
