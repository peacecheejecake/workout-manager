import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
 * S09-range-link, V2-F13, V2-A18 (M2-01k-n), on the real stack in both shells.
 *
 * A time range dragged on the S09 route graph is the shared selection: the map highlights
 * that range's samples — read back from the real renderer's `queryRenderedFeatures`, not
 * from what the screen handed it — the lap table marks the laps it overlaps, and not one
 * request reaches the API while it moves. A range across a GPS gap is matched by instant and
 * drawn as two pieces, never a line joined across the gap.
 *
 * Desktop width: the linked split-pane, where the graph, the map and the lap table are on
 * screen together (07 §S09).
 */
const start = Date.parse('2026-03-01T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
// Inside the bounds of the self-hosted Seoul basemap deployment.
const longitude = (index: number) => 126.978 + index / 2000;
const latitude = (index: number) => 37.566 + index / 2000;

/** Twelve records, 10 s apart. Records 6 and 7 have no fix: a GPS gap in the drawn path. */
const recordIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const withoutFix = [6, 7];
/** Lap boundaries fall between records, so an inclusive range end never touches one. */
const laps = [
  { index: 0, from: 0, seconds: 35 },
  { index: 1, from: 35, seconds: 40 },
  { index: 2, from: 75, seconds: 40 },
];
const fitBytes = Buffer.from(
  fitFile([
    sessionMessage({ startedAt: at(0), elapsedSeconds: 110, distanceMeters: 1100 }),
    ...laps.map((lap) => lapMessage(at(lap.from), lap.seconds)),
    ...recordIndices.map((index) =>
      recordMessage({
        at: at(index * 10),
        ...(withoutFix.includes(index)
          ? { longitude: null, latitude: null }
          : { longitude: longitude(index), latitude: latitude(index) }),
        heartRate: 140 + index,
        distanceMeters: index * 100,
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

/** Imports the activity with detail observations and laps, then stores the FIT track. */
async function storeTrack(page: Page, headers: Record<string, string>, recordCount = 12) {
  const long = recordCount > recordIndices.length;
  const indices = long ? Array.from({ length: recordCount }, (_, index) => index) : recordIndices;
  const elapsed = long ? recordCount - 1 : 110;
  const distance = long ? recordCount - 1 : 1100;
  const bytes = long
    ? Buffer.from(
        fitFile([
          sessionMessage({ startedAt: at(0), elapsedSeconds: elapsed, distanceMeters: distance }),
          ...indices.map((index) =>
            recordMessage({
              at: at(index),
              longitude: 126.978 + index / 200000,
              latitude: 37.566 + index / 200000,
              heartRate: 140 + (index % 60),
              distanceMeters: index,
            }),
          ),
        ]),
      )
    : fitBytes;
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'e'.repeat(64) },
    activity: {
      title: `구간 연결 활동 ${randomUUID()}`,
      kind: 'running',
      startedAt: at(0),
      timezone: 'UTC',
      durationSeconds: elapsed,
      durationKind: 'elapsed',
      distanceMeters: distance,
    },
    details: {
      schemaVersion: 1,
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: at(0),
      recordedAt: at(elapsed),
      elapsedSeconds: elapsed,
      // Same instants as the FIT records: the correspondence is by instant.
      records: indices.map((index) => ({
        index,
        timestamp: at(long ? index : index * 10),
        distanceMeters: long ? index : index * 100,
        heartRateBpm: long ? 140 + (index % 60) : 140 + index,
      })),
      laps: (long ? [] : laps).map((lap) => ({
        index: lap.index,
        startedAt: at(lap.from),
        recordedAt: at(lap.from + lap.seconds),
        elapsedSeconds: lap.seconds,
        timerSeconds: lap.seconds,
        distanceMeters: lap.seconds * 10,
        averageHeartRateBpm: 145,
        maximumHeartRateBpm: 150,
      })),
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
        'x-track-file-name': encodeURIComponent('range.fit'),
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

/** Press on one graph point, move across to another and release: a real pointer drag. */
async function dragAcross(page: Page, graph: Locator, from: number, to: number) {
  const chart = graph.getByRole('img', { name: '원본 심박 (bpm) 차트' });
  // The pointer only reaches what is inside the viewport.
  await chart.scrollIntoViewIfNeeded();
  const centre = async (index: number) => {
    const box = await chart
      .getByRole('button', { name: `차트 관측 ${index} 선택`, exact: true })
      .boundingBox();
    assert.ok(box);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const a = await centre(from);
  const b = await centre(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 16 });
  await page.mouse.up();
}

/** The graph points the chart marks as inside the selected range. */
async function pointsInRange(graph: Locator): Promise<string[]> {
  return graph
    .getByRole('img', { name: '원본 심박 (bpm) 차트' })
    .locator('circle[data-in-range="true"]')
    .evaluateAll((circles) => circles.map((circle) => circle.getAttribute('aria-label') ?? ''));
}

/** The lap rows the route tab's lap table highlights for the range. */
/** The "선택 구간" cell of every lap row: the overlap in words, beside the select button. */
async function lapOverlapText(panel: Locator): Promise<string[]> {
  return panel
    .getByRole('table', { name: '경로 랩 표', exact: true })
    .locator('tbody tr')
    .evaluateAll((rows) => rows.map((row) => row.querySelectorAll('td')[1]?.textContent ?? ''));
}

async function highlightedLaps(panel: Locator): Promise<string[]> {
  return panel
    .getByRole('table', { name: '경로 랩 표', exact: true })
    .locator('tbody tr[data-in-range="true"]')
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector('button')?.textContent?.trim() ?? ''),
    );
}

const shells = [
  { name: 'Next', origin: 'http://127.0.0.1:3100' },
  { name: 'Vite', origin: 'http://127.0.0.1:4200' },
] as const;

function numericBounds(raw: string | null): number[] {
  assert.ok(raw);
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  const object: Record<string, unknown> = parsed as Record<string, unknown>;
  return (['west', 'south', 'east', 'north'] as const).map((key) => {
    const value = object[key];
    assert.ok(typeof value === 'number');
    return value;
  });
}

async function viewportDifference(map: Locator, expected: string | null): Promise<number> {
  const actual = numericBounds(await map.getAttribute('data-viewport-bounds'));
  const reference = numericBounds(expected);
  return Math.max(...actual.map((value, index) => Math.abs(value - (reference[index] ?? value))));
}

for (const shell of shells) {
  test(`${shell.name}: chart zoom can fit again on the same map after full view`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const headers = await login(page);
    const activityId = await storeTrack(page, headers);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    const graph = panel.getByRole('group', { name: '저장된 경로 관측 그래프', exact: true });
    const map = mapRegion(panel, '저장된 활동 경로');
    await expectLineDrawn(map);
    const fullBounds = await map.getAttribute('data-viewport-bounds');
    const mapGeneration = await map.getAttribute('data-paths-generation');

    await graph.getByRole('button', { name: '차트 확대' }).click();
    await expect(map).toHaveAttribute('data-viewport-request', '1');
    await expect.poll(() => map.getAttribute('data-viewport-bounds')).not.toBe(fullBounds);
    const partialBounds = await map.getAttribute('data-viewport-bounds');
    await graph.getByRole('button', { name: '차트 전체' }).click();
    await expect(panel.getByTestId('chart-zoom-domain')).toHaveText('전체');
    await expect(map).not.toHaveAttribute('data-viewport-request');
    await expect.poll(() => map.getAttribute('data-viewport-bounds')).not.toBe(partialBounds);
    await expect.poll(() => viewportDifference(map, fullBounds)).toBeLessThan(1e-7);
    const restoredBounds = await map.getAttribute('data-viewport-bounds');

    await graph.getByRole('button', { name: '차트 확대' }).click();
    await expect(map).toHaveAttribute('data-viewport-request', '2');
    await expect.poll(() => map.getAttribute('data-viewport-bounds')).not.toBe(restoredBounds);
    await expect.poll(() => viewportDifference(map, partialBounds)).toBeLessThan(1e-7);
    await expect(map).toHaveAttribute('data-paths-generation', mapGeneration ?? '');
  });

  test(`${shell.name}: quick full view after a wheel stays programmatic`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const headers = await login(page);
    const activityId = await storeTrack(page, headers);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    const graph = panel.getByRole('group', { name: '저장된 경로 관측 그래프', exact: true });
    const map = mapRegion(panel, '저장된 활동 경로');
    await expectLineDrawn(map);
    const fullBounds = await map.getAttribute('data-viewport-bounds');
    const canvas = map.locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -700);
    await page.keyboard.up('Control');
    // Dispatch the button immediately while the trusted wheel gesture is still recent;
    // Playwright's auto-scroll for a normal click can outlast MapLibre's gesture window.
    await panel
      .getByRole('button', { name: '전체 보기' })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await expect(graph.getByTestId('chart-zoom-domain')).toHaveText('전체');
    await expect(map).toHaveAttribute('data-viewport-source', 'programmatic');
    await expect.poll(() => viewportDifference(map, fullBounds)).toBeLessThan(1e-7);
  });

  test(`${shell.name}: responsive resize after wheel and full view keeps the chart unzoomed`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const headers = await login(page);
    const activityId = await storeTrack(page, headers);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    const map = mapRegion(panel, '저장된 활동 경로');
    await expectLineDrawn(map);
    const before = await map.getAttribute('data-viewport-bounds');
    const generation = await map.getAttribute('data-paths-generation');
    const canvas = map.locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -700);
    await page.keyboard.up('Control');
    await panel
      .getByRole('button', { name: '전체 보기' })
      .evaluate((button) => (button as HTMLButtonElement).click());
    await page.setViewportSize({ width: 1279, height: 1000 });

    await expect(page.getByTestId('stored-track-panes')).toHaveAttribute('data-layout', 'tablet');
    await expect.poll(() => map.getAttribute('data-viewport-bounds')).not.toBe(before);
    await expect(map).toHaveAttribute('data-paths-generation', generation ?? '');
    await expect(map).toHaveAttribute('data-viewport-source', 'programmatic');
    await expect(panel.getByTestId('chart-zoom-domain')).toHaveText('전체');
  });

  test(`${shell.name}: responsive resize during a wheel keeps chart and map linked`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const headers = await login(page);
    const activityId = await storeTrack(page, headers);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    const map = mapRegion(panel, '저장된 활동 경로');
    await expectLineDrawn(map);
    const before = await map.getAttribute('data-viewport-bounds');
    const canvas = map.locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -700);
    await page.setViewportSize({ width: 1279, height: 1000 });
    await page.keyboard.up('Control');

    await expect(page.getByTestId('stored-track-panes')).toHaveAttribute('data-layout', 'tablet');
    await expect.poll(() => map.getAttribute('data-viewport-bounds')).not.toBe(before);
    await expect(map).toHaveAttribute('data-viewport-source', 'user');
    await expect(panel.getByTestId('chart-zoom-domain')).not.toHaveText('전체');
  });

  test(`${shell.name}: map zoom reaches observations beyond the first 500-chart page`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const headers = await login(page);
    const activityId = await storeTrack(page, headers, 2100);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    const graph = panel.getByRole('group', { name: '저장된 경로 관측 그래프', exact: true });
    const map = mapRegion(panel, '저장된 활동 경로');
    await expectLineDrawn(map);
    await expect(graph).toContainText('전체 2100개 중 500개 표시');
    const canvas = map.locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width * 0.79, box.y + box.height * 0.21);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -700);
      await page.keyboard.up('Control');
      await expect(map).toHaveAttribute('data-viewport-source', 'user');
      const domain = await graph.getByTestId('chart-zoom-domain').textContent();
      if (domain && Number(domain.split('–')[0]) >= Date.parse(at(500))) break;
    }
    await expect
      .poll(async () => {
        const domain = await graph.getByTestId('chart-zoom-domain').textContent();
        return domain ? Number(domain.split('–')[0]) : 0;
      })
      .toBeGreaterThanOrEqual(Date.parse(at(500)));
    await expect(graph).toContainText('확대 범위');
    await expect(graph.getByRole('img', { name: '원본 심박 (bpm) 차트' })).toBeVisible();
    const plotted = await graph
      .getByRole('img', { name: '원본 심박 (bpm) 차트' })
      .locator('circle[aria-label]')
      .evaluateAll((circles) =>
        circles.map((circle) =>
          Number(circle.getAttribute('aria-label')?.match(/관측 (\d+)/)?.[1]),
        ),
      );
    expect(plotted.some((index) => index >= 500)).toBe(true);
    expect(plotted.every((index) => index >= 500)).toBe(true);
  });

  test(`${shell.name}: chart and map zoom share a viewport without changing the chosen range`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const headers = await login(page);
    const activityId = await storeTrack(page, headers);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    const graph = panel.getByRole('group', { name: '저장된 경로 관측 그래프', exact: true });
    const map = mapRegion(panel, '저장된 활동 경로');
    await expectLineDrawn(map);
    await expect(graph.getByRole('img', { name: '원본 심박 (bpm) 차트' })).toBeVisible();
    await panel.getByRole('button', { name: '시작 지점', exact: true }).click();
    await expect(panel.getByText(/선택 표본 0:0/)).toBeVisible();
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/bff/'))
        writes.push(request.url());
    });

    const fullBounds = await map.getAttribute('data-viewport-bounds');
    await graph.getByRole('button', { name: '차트 확대' }).click();
    await expect(graph.getByTestId('chart-zoom-domain')).not.toHaveText('전체');
    await expect(map).toHaveAttribute('data-viewport-source', 'programmatic');
    await expect.poll(() => map.getAttribute('data-viewport-bounds')).not.toBe(fullBounds);
    await expect(map).toHaveAttribute('data-viewport-request', '1');
    const zoomedBounds = await map.getAttribute('data-viewport-bounds');
    await expect(panel.getByText(/선택 표본 0:0/)).toBeVisible();
    expect(
      await graph
        .getByRole('img', { name: '원본 심박 (bpm) 차트' })
        .locator('circle[data-selected]')
        .count(),
    ).toBeLessThan(12);
    await dragAcross(page, graph, 3, 5);
    const chosenRange = await panel.getByTestId('route-range').textContent();
    await expect(panel.getByTestId('route-range')).toContainText('선택 구간 UTC');
    const zoomedDomain = await graph.getByTestId('chart-zoom-domain').textContent();

    const canvas = map.locator('canvas');
    const box = await canvas.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -700);
    await page.keyboard.up('Control');
    await expect(map).toHaveAttribute('data-viewport-source', 'user');
    await expect.poll(() => map.getAttribute('data-viewport-bounds')).not.toBe(zoomedBounds);
    await expect(graph.getByTestId('chart-zoom-domain')).not.toHaveText(zoomedDomain ?? '');
    await expect(map).not.toHaveAttribute('data-viewport-request');
    await expect(panel.getByTestId('route-range')).toHaveText(chosenRange ?? '');
    expect(writes).toEqual([]);
  });

  test(`${shell.name}: a chart drag highlights the same range on the map and in the lap table`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const headers = await login(page);
    const activityId = await storeTrack(page, headers);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    await expect(panel).toContainText('전체 12개 · 위치 있음 10개');
    await expect(page.getByTestId('stored-track-panes')).toHaveAttribute('data-layout', 'desktop');
    await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'));
    const mapPane = panel.getByRole('group', { name: '저장된 경로 지도', exact: true });
    const graph = panel.getByRole('group', { name: '저장된 경로 관측 그래프', exact: true });
    await expect(graph.getByRole('img', { name: '원본 심박 (bpm) 차트' })).toBeVisible();
    // Before any range: the renderer draws no highlight piece at all.
    await expect(mapPane).toHaveAttribute('data-rendered-highlight', '', { timeout: 15_000 });
    expect(await highlightedLaps(panel)).toEqual([]);
    expect(await lapOverlapText(panel)).toEqual(['—', '—', '—']);

    // From here on, every request the page makes is recorded: none may reach the API.
    const requests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return;
      if (url.pathname.startsWith('/bff/') || request.method() !== 'GET')
        requests.push(`${request.method()} ${url.pathname}`);
    });

    // ── 1. Records 1–3 (10 s – 30 s): one drawn run, inside lap 0.
    await dragAcross(page, graph, 1, 3);
    await expect(panel.getByTestId('route-range')).toHaveText(
      `선택 구간 UTC ${at(10)} – ${at(30)} (양끝 포함) · 관측 3개`,
    );
    expect(await pointsInRange(graph)).toEqual([
      '차트 관측 1 선택',
      '차트 관측 2 선택',
      '차트 관측 3 선택',
    ]);
    // What the renderer drew of the highlight: exactly those three samples, one piece.
    await expect(mapPane).toHaveAttribute('data-rendered-highlight', '0:1,0:2,0:3', {
      timeout: 15_000,
    });
    await expect.poll(() => highlightedLaps(panel)).toEqual(['랩 0 선택']);
    expect(await lapOverlapText(panel)).toEqual(['겹침', '—', '—']);

    expect(requests).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test(`${shell.name}: a range across a GPS gap is matched by instant and never bridged`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const headers = await login(page);
    const activityId = await storeTrack(page, headers);
    await page.goto(`${shell.origin}/activities?selected=${activityId}&detailTab=route`);
    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    await expect(panel).toContainText('전체 12개 · 위치 있음 10개');
    await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'));
    const mapPane = panel.getByRole('group', { name: '저장된 경로 지도', exact: true });
    const graph = panel.getByRole('group', { name: '저장된 경로 관측 그래프', exact: true });
    await expect(graph.getByRole('img', { name: '원본 심박 (bpm) 차트' })).toBeVisible();

    const requests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return;
      if (url.pathname.startsWith('/bff/') || request.method() !== 'GET')
        requests.push(`${request.method()} ${url.pathname}`);
    });

    // ── Records 4–9 (40 s – 90 s) cross samples 0:6 and 0:7, which have no fix.
    await dragAcross(page, graph, 4, 9);
    // The range is by instant: six observations, including the two without a fix.
    await expect(panel.getByTestId('route-range')).toHaveText(
      `선택 구간 UTC ${at(40)} – ${at(90)} (양끝 포함) · 관측 6개`,
    );
    expect(await pointsInRange(graph)).toEqual(
      [4, 5, 6, 7, 8, 9].map((index) => `차트 관측 ${index} 선택`),
    );
    // The renderer drew two separate pieces, one each side of the gap, with the same
    // instants' samples: nothing joins 0:5 to 0:8, and the fix-less samples draw nothing.
    await expect(mapPane).toHaveAttribute('data-rendered-highlight', '0:4,0:5|0:8,0:9', {
      timeout: 15_000,
    });
    await expect.poll(() => highlightedLaps(panel)).toEqual(['랩 1 선택', '랩 2 선택']);
    expect(await lapOverlapText(panel)).toEqual(['—', '겹침', '겹침']);
    await expect(panel.getByText(/선택한 구간의 표본 4개를 지도에서 강조했습니다/)).toBeVisible();

    // Clearing goes through the same store: the renderer stops drawing the highlight.
    await panel.getByRole('button', { name: '선택 해제', exact: true }).click();
    await expect(mapPane).toHaveAttribute('data-rendered-highlight', '', { timeout: 15_000 });
    await expect.poll(() => highlightedLaps(panel)).toEqual([]);
    expect(await lapOverlapText(panel)).toEqual(['—', '—', '—']);

    expect(requests).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
