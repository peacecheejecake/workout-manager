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
 * S09 route tab for an indoor / GPS-less recording (M2-01t), against the real OIDC session,
 * API, PostgreSQL and object storage, in both shells.
 *
 * The spec (01 §7.2) keeps the route tab reachable for such a recording: its panel says no
 * location was recorded, draws no map and shows the summary, and nothing makes up a path.
 * The recording here is a synthetic FIT file whose records carry time, distance and heart
 * rate but no position at all — no personal file is involved.
 */
const start = Date.parse('2026-03-02T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const indices = [0, 1, 2, 3, 4, 5];
const fitBytes = Buffer.from(
  fitFile([
    sessionMessage({ startedAt: at(0), elapsedSeconds: 50, distanceMeters: 640 }),
    ...indices.map((index) =>
      recordMessage({
        at: at(index * 10),
        longitude: null,
        latitude: null,
        heartRate: 130 + index,
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

/** Imports an indoor run and stores its position-less FIT recording through the real upload. */
async function storeIndoorTrack(page: Page, headers: Record<string, string>) {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'd'.repeat(64) },
    activity: {
      title: `실내 러닝 ${randomUUID()}`,
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
      records: indices.map((index) => ({
        index,
        timestamp: at(index * 10),
        distanceMeters: index * 128,
        heartRateBpm: 130 + index,
      })),
      laps: [],
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
        'x-track-file-name': encodeURIComponent('indoor.fit'),
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

const shells = [
  ['Next', 'http://127.0.0.1:3100'],
  ['Vite', 'http://127.0.0.1:4200'],
] as const;

for (const [shell, origin] of shells) {
  test(`${shell} shell: an indoor recording keeps the route tab reachable and draws no path`, async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const headers = await login(page);
    const activityId = await storeIndoorTrack(page, headers);

    // The server stored the recording and made up no geometry for it.
    const mapPath = await page.request.get(
      `/bff/v1/activities/${activityId}/track/content?variant=map_path`,
      { headers },
    );
    expect(mapPath.status()).toBe(200);
    const stored = (await mapPath.json()) as {
      geometry: { coordinates: unknown[] };
      vertexSampleIds: unknown[];
    };
    expect(stored.geometry.coordinates).toEqual([]);
    expect(stored.vertexSampleIds).toEqual([]);

    // A full load on another tab; the route tab is then reached by the user, not the URL.
    await page.goto(`${origin}/activities?selected=${activityId}&detailTab=overview`);
    const routeTab = page.getByRole('tab', { name: '경로', exact: true });
    await expect(routeTab).toBeEnabled();
    await expect(routeTab).toHaveAttribute('aria-selected', 'false');
    await routeTab.click();
    await expect(routeTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/detailTab=route/);

    const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('전체 6개 · 위치 있음 0개');
    // The panel says why there is no map…
    await expect(
      panel.getByText('위치가 기록되지 않은 활동입니다. 지도는 표시하지 않고 요약만 보여 줍니다.'),
    ).toBeVisible();
    // …and, once the geometry query has resolved (the map pane's notice renders in the same
    // commit that would mount the map leaf), the map pane holds that notice and nothing else.
    // A mounted leaf is always present as its loading fallback, its failure fallback or the
    // renderer section, so a single child rules it out without waiting on the lazy chunk.
    const mapPane = panel.getByRole('group', { name: '저장된 경로 지도', exact: true });
    await expect(mapPane.getByText(/그릴 좌표가 없습니다/)).toBeVisible();
    await expect(mapPane.locator(':scope > *')).toHaveCount(1);
    await expect(mapPane.getByText('지도 구성 요소를 불러오는 중입니다.')).toHaveCount(0);
    // Let any late chunk or request settle, then check that no renderer, canvas or drawn
    // path appeared after all.
    await page.waitForLoadState('networkidle');
    await expect(mapPane.locator(':scope > *')).toHaveCount(1);
    await expect(panel.getByRole('region', { name: '저장된 활동 경로' })).toHaveCount(0);
    await expect(panel.locator('canvas')).toHaveCount(0);
    await expect(panel.getByText(/렌더된 경로 feature/)).toHaveCount(0);
    await expect(panel.getByText(/지도가 경로를 그렸습니다/)).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '시작 지점', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '끝 지점', exact: true })).toBeDisabled();

    // The summary stays: the recording's own and the activity's.
    const summary = panel.getByRole('group', { name: '저장된 경로 요약과 표본', exact: true });
    await expect(summary).toBeVisible();
    await expect(summary.getByRole('heading', { name: '기본 요약' })).toBeVisible();
    await expect(summary).toContainText('50초');
    await expect(summary).toContainText('640m');
    await expect(page.getByRole('region', { name: '활동 요약 출처', exact: true })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
}
