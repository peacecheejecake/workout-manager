import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { coursePrivacyZoneListSchema } from '../../packages/contracts/src/courses';
import { importCourse, login, shells, type Headers } from './course-editor-support';

/**
 * M2-01k-o A: the owner's GPX behind the privacy confirmation, in both shells, against the
 * real stack (real OIDC session, API, PostgreSQL). Synthetic coordinates only.
 *
 * T1 (nothing before confirmation), T2 (what the screen explains), T3 (the default trimmed
 * GPX holds no protected coordinate), T20(1) (the exact line after its warning) and T21 (no
 * protected area: warning, then the exact ends). This spec does not depend on the link flag:
 * A is always on (T9).
 */
const METERS_PER_DEGREE = (Math.PI / 180) * 6_371_008.8;
const home: [number, number] = [127.02, 37.55];
const radius = 200;
const at = (east: number, north: number): [number, number] => [
  Number((home[0] + east / (METERS_PER_DEGREE * Math.cos((home[1] * Math.PI) / 180))).toFixed(7)),
  Number((home[1] + north / METERS_PER_DEGREE).toFixed(7)),
];
const leg = (from: [number, number], to: [number, number], step: number) => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const count = Math.max(1, Math.round(length / step));
  return Array.from({ length: count }, (_, index) =>
    at(
      from[0] + ((to[0] - from[0]) * index) / count,
      from[1] + ((to[1] - from[1]) * index) / count,
    ),
  );
};
/** Home → east → north → west → back home: both ends inside the protected area. */
const loop: [number, number][] = [
  ...leg([0, 0], [1200, 0], 40),
  ...leg([1200, 0], [1200, 500], 100),
  ...leg([1200, 500], [0, 500], 100),
  ...leg([0, 500], [0, 0], 40),
  at(0, 0),
];

function haversine(from: readonly [number, number], to: readonly [number, number]) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(to[1] - from[1]);
  const dLon = toRadians(to[0] - from[0]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from[1])) * Math.cos(toRadians(to[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Closest approach of a segment to a point, in a local plane around the point (metres). */
function segmentDistance(
  from: readonly [number, number],
  to: readonly [number, number],
  point: readonly [number, number],
) {
  const scale = Math.cos((point[1] * Math.PI) / 180) * METERS_PER_DEGREE;
  const ax = (from[0] - point[0]) * scale;
  const ay = (from[1] - point[1]) * METERS_PER_DEGREE;
  const bx = (to[0] - point[0]) * scale;
  const by = (to[1] - point[1]) * METERS_PER_DEGREE;
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function gpxPoints(document: string) {
  const read = (pattern: RegExp) =>
    [...document.matchAll(pattern)].map((match) => [Number(match[2]), Number(match[1])] as const);
  return {
    route: read(/<rtept lat="([-0-9.]+)" lon="([-0-9.]+)"/g),
    waypoints: read(/<wpt lat="([-0-9.]+)" lon="([-0-9.]+)"/g),
  };
}

async function clearZones(page: Page, headers: Headers) {
  const listed = coursePrivacyZoneListSchema.parse(
    await (await page.request.get('/bff/v1/courses/privacy-zones', { headers })).json(),
  );
  for (const zone of listed.zones) {
    const removed = await page.request.delete(`/bff/v1/courses/privacy-zones/${zone.zoneId}`, {
      headers,
    });
    expect(removed.status()).toBe(200);
  }
}

async function addHomeZone(page: Page, headers: Headers) {
  const listed = coursePrivacyZoneListSchema.parse(
    await (await page.request.get('/bff/v1/courses/privacy-zones', { headers })).json(),
  );
  if (listed.zones.some((zone) => zone.name === 'M2-01k-o 집')) return;
  const created = await page.request.post('/bff/v1/courses/privacy-zones', {
    headers,
    data: { name: 'M2-01k-o 집', center: home, radiusMeters: radius },
  });
  expect(created.status()).toBe(200);
}

async function openCourse(page: Page, origin: string, name: string) {
  await page.goto(`${origin}/courses`);
  const workbench = page.getByRole('region', { name: '내 코스' });
  await workbench.getByRole('button', { name, exact: true }).click();
  await expect(workbench.getByTestId('course-export')).toBeVisible();
  return workbench;
}

for (const shell of shells) {
  test.describe(`${shell.name} shell`, () => {
    test('T1/T2/T3: nothing leaves before the confirmation; the default GPX holds no protected coordinate', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const headers = await login(page, 'Alice');
      await addHomeZone(page, headers);
      const name = `M2-01k-o 확인 ${shell.name} ${Date.now()}`;
      const courseId = await importCourse(page, headers, name, loop);
      const gpxResponses: string[] = [];
      page.on('response', (response) => {
        if (response.url().includes('/export.gpx')) gpxResponses.push(response.url());
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      const workbench = await openCourse(page, shell.origin, name);

      // T1: the button goes to the confirmation; no GPX body came back, and the API itself
      // refuses one without a receipt.
      await workbench.getByTestId('course-export').click();
      const region = workbench.getByRole('region', { name: 'GPX 내보내기 전 확인' });
      await expect(region.getByRole('button', { name: '확인하고 GPX 내보내기' })).toBeVisible();
      expect(gpxResponses).toEqual([]);
      const refused = await page.request.get(`/bff/v1/courses/${courseId}/export.gpx`, { headers });
      expect(refused.status()).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'COURSE_EXPORT_NOT_CONFIRMED',
      );

      // T2: what the screen says, as text and as a list beside the picture of the line.
      await expect(region.getByRole('list', { name: '적용된 보호 구역' })).toContainText(
        'M2-01k-o 집 · 이 구역에서 제거되는 정점',
      );
      await expect(region.getByRole('list', { name: '나갈 시작점과 끝점' })).toContainText(
        '원래 시작에서',
      );
      await expect(region.getByRole('img', { name: '내보낼 선 미리보기' })).toBeVisible();
      for (const sentence of [
        '보호 구역의 중심 좌표는 어디로도 나가지 않습니다.',
        '같은 곳에서 출발한 코스를 여러 번 공유하면 구역 중심을 추정할 수 있습니다.',
        '내보낸 제거본 파일 3개 이상이면 집 위치를 몇 m 안으로 계산할 수 있습니다.',
        '시각, 활동 연결, 코스 id, 기기 정보, 소유자 이름·계정은 나가지 않습니다.',
        '내보낸 파일은 철회할 수 없습니다.',
        '원래 수정본은 그대로',
      ])
        await expect(region).toContainText(sentence);
      await expect(region.getByLabel('코스 이름과 경유점 이름 포함')).toBeChecked();
      // Tablet, mobile and 320 px: the confirmation reflows without a horizontal scroll and
      // its confirm button stays reachable (Aside cannot set a viewport; Playwright does).
      for (const width of [820, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(region.getByRole('button', { name: '확인하고 GPX 내보내기' })).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          `no horizontal scroll at ${width}px`,
        ).toBe(true);
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      // T3: confirm the default (the trimmed line) and read the file that was downloaded.
      const downloadPromise = page.waitForEvent('download');
      await region.getByRole('button', { name: '확인하고 GPX 내보내기' }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).not.toMatch(/-r\d+\.gpx$/);
      const path = await download.path();
      assert.ok(path);
      const gpxText = await readFile(path, 'utf8');
      expect(gpxText).not.toContain('<desc>');
      expect(gpxText).not.toContain('<time>');
      expect(gpxText).not.toContain(courseId);
      const points = gpxPoints(gpxText);
      expect(points.route.length).toBeGreaterThan(10);
      for (const position of [...points.route, ...points.waypoints])
        expect(haversine(home, position)).toBeGreaterThan(radius);
      for (let index = 1; index < points.route.length; index += 1) {
        const from = points.route[index - 1];
        const to = points.route[index];
        assert.ok(from && to);
        expect(segmentDistance(from, to, home)).toBeGreaterThan(radius);
      }
      // The confirmation appended the trimmed revision the file was made from (R-10).
      const detail = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
      expect(
        ((await detail.json()) as { course: { headRevision: number } }).course.headRevision,
      ).toBe(2);
    });

    test('T20(1): the exact line only after its own warning, and then exactly', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const headers = await login(page, 'Alice');
      await addHomeZone(page, headers);
      const name = `M2-01k-o 정확한 선 ${shell.name} ${Date.now()}`;
      await importCourse(page, headers, name, loop);
      const workbench = await openCourse(page, shell.origin, name);
      await workbench.getByTestId('course-export').click();
      const region = workbench.getByRole('region', { name: 'GPX 내보내기 전 확인' });
      await region.getByRole('radio', { name: '정확한 선 (내 GPX 파일에만)' }).check();
      await expect(
        region.getByText('보호 구역 안의 좌표가 파일에 포함됩니다. 이 파일은 철회할 수 없습니다.'),
      ).toBeVisible();
      const confirm = region.getByRole('button', { name: '확인하고 GPX 내보내기' });
      await expect(confirm).toBeDisabled();
      await region.getByLabel('보호 구역 안의 좌표가 포함된다는 것을 확인했습니다.').check();
      const downloadPromise = page.waitForEvent('download');
      await confirm.click();
      const path = await (await downloadPromise).path();
      assert.ok(path);
      const points = gpxPoints(await readFile(path, 'utf8'));
      expect(points.route).toHaveLength(loop.length);
      expect(points.route[0]).toEqual(loop[0]);
      expect(points.route.at(-1)).toEqual(loop.at(-1));
    });

    test('T21: no protected area — the warning must be ticked, then the exact ends leave', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const headers = await login(page, 'Bob');
      await clearZones(page, headers);
      const name = `M2-01k-o 구역 없음 ${shell.name} ${Date.now()}`;
      const courseId = await importCourse(page, headers, name, loop);
      const workbench = await openCourse(page, shell.origin, name);
      await workbench.getByTestId('course-export').click();
      const region = workbench.getByRole('region', { name: 'GPX 내보내기 전 확인' });
      await expect(region.getByText('보호 구역이 없어 정확한 시작·끝이 포함됩니다.')).toBeVisible();
      await expect(region.getByRole('button', { name: '보호 구역 추가하러 가기' })).toBeVisible();
      const confirm = region.getByRole('button', { name: '확인하고 GPX 내보내기' });
      await expect(confirm).toBeDisabled();
      expect(
        (await page.request.get(`/bff/v1/courses/${courseId}/export.gpx`, { headers })).status(),
      ).toBe(409);
      await region
        .getByLabel('보호 구역이 없어 정확한 시작·끝이 포함된다는 것을 확인했습니다.')
        .check();
      const downloadPromise = page.waitForEvent('download');
      await confirm.click();
      const path = await (await downloadPromise).path();
      assert.ok(path);
      const points = gpxPoints(await readFile(path, 'utf8'));
      expect(points.route[0]).toEqual([Number(home[0].toFixed(5)), Number(home[1].toFixed(5))]);
      expect(points.route.at(-1)).toEqual([Number(home[0].toFixed(5)), Number(home[1].toFixed(5))]);
      // No link control of any kind for this owner (with the flag off, none at all).
      for (const forbidden of ['링크로 공유', '링크 복사'])
        await expect(workbench.getByRole('button', { name: forbidden })).toHaveCount(0);
    });
  });
}
