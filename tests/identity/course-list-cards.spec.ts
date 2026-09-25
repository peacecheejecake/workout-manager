import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import {
  courseReadResultSchema,
  courseRoutePreviewResultSchema,
  courseThumbnailPath,
  type CourseReadResult,
} from '../../packages/contracts/src/courses';
import {
  courseElevationResultSchema,
  elevationDatasetDocumentSchema,
} from '../../packages/contracts/src/geo-data';
import {
  fitFile,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';
import { importCourse, login, shells, type Headers } from './course-editor-support';

/**
 * M2-01k-a: the S13 list card, per card and in both shells, against the real OIDC session,
 * API, PostgreSQL, object store, thumbnail worker and the routing port the harness is
 * configured with (the deterministic fixture unless `IDENTITY_E2E_ROUTING=graphhopper`).
 *
 * 01 §9: "S13 코스 카드에 지도 썸네일, 실제/추정 거리, 고도 데이터 출처, 노면 정보의 확인 상태,
 * 접근성 메모, 마지막 사용을 표시한다". Every item is asserted on the card of one named course —
 * the list row, not the detail — and against what the server itself stored:
 *
 * - three courses of three kinds, so "actual" and "estimated" are told apart on screen: one
 *   cut from a stored recording (actual), one our engine proposed (estimated, with the
 *   engine's own figure), one read from a file (neither);
 * - the thumbnail is the projection of the stored head line while drawn, and the stored
 *   picture once the worker has made it;
 * - the elevation source on the card is exactly what the elevation read answers for that
 *   course, and a separate test REFUSES "없음" whenever a dataset is deployed on this machine;
 * - surface says "확인되지 않음": there is no surface source, so anything else is a lie;
 * - last used says "사용 기록 없음" until the course is opened, and then the date the server
 *   recorded.
 */
const start = Date.parse('2026-03-01T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const fitBytes = Buffer.from(
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

const elevationFile = join(import.meta.dirname, '../../.geo-build/geo-data/elevation.json');

function metres(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}km` : `${Math.round(value)}m`;
}

const keyed = (headers: Headers) => ({ ...headers, 'idempotency-key': randomUUID() });

async function readCourse(page: Page, headers: Headers, courseId: string) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}`, { headers });
  expect(response.status()).toBe(200);
  const read: CourseReadResult = courseReadResultSchema.parse(await response.json());
  assert.ok(read.status === 'available');
  return read;
}

/** A course cut from a genuinely stored recording: FIT bytes re-parsed by the server. */
async function recordedCourse(page: Page, headers: Headers, name: string) {
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'f'.repeat(64) },
    activity: {
      title: `카드 원본 활동 ${randomUUID()}`,
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
  const activity = activityImportResultSchema.parse(await imported.json());
  const reserved = await page.request.post(
    `/bff/v1/activities/${activity.activityId}/track-uploads`,
    {
      headers: keyed(headers),
      data: { expectedActivityRevision: activity.revision, recordedTrackIndex: 0 },
    },
  );
  expect(reserved.status()).toBe(200);
  const { uploadId } = (await reserved.json()) as { uploadId: string };
  const uploaded = await page.request.put(`/bff/v1/activity-track-uploads/${uploadId}/content`, {
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-track-file-name': encodeURIComponent('card.fit'),
    },
    data: fitBytes,
  });
  expect(uploaded.status()).toBe(200);
  const finalized = await page.request.post(`/bff/v1/activity-track-uploads/${uploadId}/finalize`, {
    headers: keyed(headers),
  });
  expect(finalized.status()).toBe(200);
  const created = await page.request.post('/bff/v1/courses', {
    headers: keyed(headers),
    data: {
      name,
      from: {
        kind: 'recorded-segment',
        activityId: activity.activityId,
        trackRevision: 1,
        startSampleId: '0:0',
        endSampleId: '0:4',
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const read = courseReadResultSchema.parse(await created.json());
  assert.ok(read.status === 'available');
  expect(read.revision.generation.kind).toBe('recorded-segment');
  return read.course.courseId;
}

/** A course our engine proposed and the owner reviewed: previewed, then saved. */
async function routedCourse(page: Page, headers: Headers, name: string) {
  const waypoints = [
    { role: 'start', position: [126.978, 37.566], name: null, sourceSampleId: null, locked: false },
    {
      role: 'finish',
      position: [126.982, 37.569],
      name: null,
      sourceSampleId: null,
      locked: false,
    },
  ];
  const previewed = await page.request.post('/bff/v1/courses/route-previews', {
    headers,
    data: { requestId: `card-${randomUUID()}`, draftRevision: 1, waypoints },
  });
  expect(previewed.status(), await previewed.text()).toBe(200);
  const preview = courseRoutePreviewResultSchema.parse(await previewed.json());
  assert.ok(preview.outcome === 'route_computed');
  const created = await page.request.post('/bff/v1/courses', {
    headers: keyed(headers),
    data: {
      name,
      from: {
        kind: 'routed-waypoints',
        waypoints,
        draftRevision: 1,
        reviewedGeometrySha256: preview.preview.geometrySha256,
        acknowledgedGraph: { previous: null, next: preview.preview.computation.graph.graphBuildId },
      },
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const read = courseReadResultSchema.parse(await created.json());
  assert.ok(read.status === 'available');
  assert.ok(read.revision.generation.kind === 'routed-waypoints');
  return read.course.courseId;
}

function card(page: Page, name: string): Locator {
  return page
    .getByRole('region', { name: '내 코스' })
    .getByRole('list', { name: '코스 목록' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name, exact: true }) });
}

/** The card's picture is the stored head line: drawn from its projection, or the stored SVG. */
async function expectThumbnailOf(row: Locator, read: CourseReadResult) {
  assert.ok(read.status === 'available');
  const picture = row.getByTestId('course-card-thumbnail');
  await expect(picture).toBeVisible();
  const expected = courseThumbnailPath(read.revision.geometry.coordinates);
  assert.ok(expected);
  // The stored picture may replace the drawn one at any moment (the worker and the
  // authenticated fetch run on their own schedule), so each look reads the source and, when
  // it is still drawn, the path it draws — both from the same element at the same time.
  await expect
    .poll(() =>
      picture.evaluate((element) =>
        element.getAttribute('data-source') === 'drawn'
          ? `drawn ${element.querySelector('path')?.getAttribute('d') ?? ''}`
          : (element.getAttribute('data-source') ?? 'none'),
      ),
    )
    .toMatch(new RegExp(`^(stored|drawn ${expected.path.replace(/[.]/g, '\\.')})$`));
}

/** The elevation line of the card says exactly what the elevation read says. */
async function expectElevationOf(page: Page, headers: Headers, row: Locator, courseId: string) {
  const response = await page.request.get(`/bff/v1/courses/${courseId}/elevation`, { headers });
  expect(response.status()).toBe(200);
  const profile = courseElevationResultSchema.parse(await response.json());
  const elevation = row.getByTestId('course-card-elevation');
  switch (profile.outcome) {
    case 'no_dataset':
      await expect(elevation).toHaveAttribute('data-status', 'not_deployed');
      await expect(elevation).toHaveText(/^없음/);
      return profile;
    case 'outside_region':
      await expect(elevation).toHaveAttribute('data-status', 'outside_region');
      await expect(elevation).toContainText(`데이터셋 ${profile.dataset.datasetId}`);
      await expect(elevation).toContainText(`${profile.dataset.region} 범위 밖`);
      return profile;
    case 'profile':
      await expect(elevation).toHaveAttribute('data-status', 'sampled');
      await expect(elevation).toContainText(
        `${profile.dataset.attribution}, 데이터셋 ${profile.dataset.datasetId}`,
      );
      await expect(elevation).toContainText(
        `표본 ${profile.points.length}곳 중 ${profile.knownCount}곳 값 있음`,
      );
      await expect(elevation).not.toHaveText(/^없음/);
      return profile;
  }
}

async function expectSurfaceUnknown(row: Locator) {
  const surface = row.getByTestId('course-card-surface');
  await expect(surface).toHaveAttribute('data-confirmation', 'unknown');
  await expect(surface).toHaveText(/^확인되지 않음/);
}

for (const shell of shells) {
  test.describe(`${shell.name} shell (${shell.origin})`, () => {
    test('each S13 card shows its thumbnail, actual/estimated distance, elevation source, surface and last use', async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const headers = await login(page);
      const tag = `${shell.name} ${randomUUID().slice(0, 8)}`;
      const names = {
        recorded: `카드 기록 ${tag}`,
        routed: `카드 경로 ${tag}`,
        imported: `카드 파일 ${tag}`,
      };
      const ids = {
        recorded: await recordedCourse(page, headers, names.recorded),
        routed: await routedCourse(page, headers, names.routed),
        imported: await importCourse(page, headers, names.imported, [
          [126.99, 37.57],
          [126.992, 37.571],
          [126.994, 37.573],
        ]),
      };
      const reads = {
        recorded: await readCourse(page, headers, ids.recorded),
        routed: await readCourse(page, headers, ids.routed),
        imported: await readCourse(page, headers, ids.imported),
      };

      await page.goto(`${shell.origin}/courses`);
      for (const kind of ['recorded', 'routed', 'imported'] as const) {
        const row = card(page, names[kind]);
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId('course-card')).toHaveAttribute('data-card-status', 'ready');
        await expectThumbnailOf(row, reads[kind]);
        await expectElevationOf(page, headers, row, ids[kind]);
        await expectSurfaceUnknown(row);
        // Never opened: no use is recorded, and the card says so rather than showing a date.
        await expect(row.getByTestId('course-card-last-used')).toHaveText('사용 기록 없음');
      }

      // Distance: the planned line, and what it is. Only the recorded line is actual; the
      // engine line is an estimate with the engine's own figure; the file's line is neither.
      const recorded = reads.recorded;
      assert.ok(recorded.status === 'available');
      const recordedDistance = card(page, names.recorded).getByTestId('course-card-distance');
      await expect(recordedDistance).toHaveAttribute('data-basis', 'recorded');
      await expect(recordedDistance).toHaveText(
        `계획 거리 ${metres(recorded.revision.distanceMeters)} · 실제 기록 구간의 거리(지도 단순화 선 기준)`,
      );
      const routed = reads.routed;
      assert.ok(
        routed.status === 'available' && routed.revision.generation.kind === 'routed-waypoints',
      );
      const routedDistance = card(page, names.routed).getByTestId('course-card-distance');
      await expect(routedDistance).toHaveAttribute('data-basis', 'engine-estimate');
      await expect(routedDistance).toHaveText(
        `계획 거리 ${metres(routed.revision.distanceMeters)} · 추정 거리(경로 엔진 ${metres(
          routed.revision.generation.engineDistanceMeters,
        )})`,
      );
      await expect(routedDistance).not.toContainText('실제');
      const imported = reads.imported;
      assert.ok(imported.status === 'available');
      const importedDistance = card(page, names.imported).getByTestId('course-card-distance');
      await expect(importedDistance).toHaveAttribute('data-basis', 'imported-file');
      await expect(importedDistance).toHaveText(
        `계획 거리 ${metres(imported.revision.distanceMeters)} · 가져온 파일의 선, 실제/추정 확인되지 않음`,
      );

      // Stored thumbnails: once the worker has made each picture, every card shows the
      // stored one — the M2-01l derivative, fetched by the owner's authenticated read.
      for (const kind of ['recorded', 'routed', 'imported'] as const)
        await expect
          .poll(async () => (await readCourse(page, headers, ids[kind])).thumbnail.status, {
            timeout: 20_000,
          })
          .toBe('ready');
      await page.goto(`${shell.origin}/courses`);
      for (const kind of ['recorded', 'routed', 'imported'] as const)
        await expect(card(page, names[kind]).getByTestId('course-card-thumbnail')).toHaveAttribute(
          'data-source',
          'stored',
        );

      // Last use: opening the course is the use, and the card shows the server's moment.
      await page
        .getByRole('region', { name: '내 코스' })
        .getByRole('button', { name: names.imported, exact: true })
        .click();
      await expect
        .poll(async () => {
          const response = await page.request.get('/bff/v1/courses/preferences', { headers });
          const body = (await response.json()) as {
            preferences: { courseId: string; lastUsedAt: string | null }[];
          };
          return body.preferences.find((entry) => entry.courseId === ids.imported)?.lastUsedAt;
        })
        .toEqual(expect.any(String));
      const preferences = (await (
        await page.request.get('/bff/v1/courses/preferences', { headers })
      ).json()) as { preferences: { courseId: string; lastUsedAt: string | null }[] };
      const usedAt = preferences.preferences.find(
        (entry) => entry.courseId === ids.imported,
      )?.lastUsedAt;
      assert.ok(usedAt);
      await page.goto(`${shell.origin}/courses`);
      const shown = await page.evaluate((iso) => new Date(iso).toLocaleDateString('ko-KR'), usedAt);
      await expect(card(page, names.imported).getByTestId('course-card-last-used')).toHaveText(
        `마지막 사용 ${shown}`,
      );
      // The other two were not opened, and their cards still say so.
      await expect(card(page, names.routed).getByTestId('course-card-last-used')).toHaveText(
        '사용 기록 없음',
      );

      // The card keeps every fact at tablet and at 320px, without widening the page.
      for (const width of [800, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const row = card(page, names.routed);
        await row.scrollIntoViewIfNeeded();
        for (const id of [
          'course-card-thumbnail',
          'course-card-distance',
          'course-card-elevation',
          'course-card-surface',
          'course-card-last-used',
        ])
          await expect(row.getByTestId(id), `${id} at ${width}px`).toBeVisible();
        const box = await row.getByTestId('course-card').boundingBox();
        assert.ok(box);
        expect(box.x + box.width, `card right edge at ${width}px`).toBeLessThanOrEqual(width);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
          `horizontal overflow at ${width}px`,
        ).toBe(0);
      }

      // Bob: the cards read is his own. None of Alice's courses — by id or by name — is in
      // his answer, and his screen shows none of them.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto('/account');
      await page.getByRole('button', { name: '로그아웃', exact: true }).click();
      await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
      const bob = await login(page, 'Bob');
      const bobCards = await page.request.get('/bff/v1/courses/cards', { headers: bob });
      expect(bobCards.status()).toBe(200);
      const bobBody = await bobCards.text();
      for (const kind of ['recorded', 'routed', 'imported'] as const) {
        expect(bobBody).not.toContain(ids[kind]);
        expect(bobBody).not.toContain(names[kind]);
      }
      const bobScreenCards = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/bff/v1/courses/cards',
      );
      await page.goto(`${shell.origin}/courses`);
      expect((await bobScreenCards).status()).toBe(200);
      await expect(page.getByRole('region', { name: '내 코스' })).toBeVisible();
      for (const kind of ['recorded', 'routed', 'imported'] as const)
        await expect(card(page, names[kind])).toHaveCount(0);
    });

    test('a deployed elevation dataset is named on the card, never "없음"', async ({ page }) => {
      // Absent on a checkout that never built it (CI): skipped and reported, never passed.
      test.skip(
        !existsSync(elevationFile),
        'No self-hosted elevation dataset on this machine (scripts/build-geo-datasets.mjs is opt-in).',
      );
      const document = elevationDatasetDocumentSchema.parse(
        JSON.parse(readFileSync(elevationFile, 'utf8')),
      );
      const [west, south, east, north] = document.identity.bbox;
      const known = document.points.find(
        ({ position: [longitude, latitude] }) =>
          longitude > west && longitude < east && latitude > south && latitude < north,
      );
      assert.ok(known, 'the dataset has no point inside its own region');
      const headers = await login(page);
      const name = `카드 고도 ${shell.name} ${randomUUID().slice(0, 8)}`;
      // The first vertex sits exactly on a fact the dataset holds.
      await importCourse(page, headers, name, [
        known.position,
        [known.position[0] + 0.002, known.position[1] + 0.001],
      ]);
      await page.goto(`${shell.origin}/courses`);
      const elevation = card(page, name).getByTestId('course-card-elevation');
      await expect(elevation).toHaveAttribute('data-status', 'sampled');
      await expect(elevation).not.toHaveText(/^없음/);
      await expect(elevation).toContainText(`데이터셋 ${document.identity.datasetId}`);
      await expect(elevation).toContainText(document.identity.attribution);
      await expect(elevation).toContainText(/표본 2곳 중 [12]곳 값 있음/);
    });
  });
}
