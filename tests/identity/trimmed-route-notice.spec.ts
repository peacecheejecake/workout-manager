import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  courseReadResultSchema,
  courseRoutePreviewResultSchema,
} from '../../packages/contracts/src/courses';
import { importCourse, login, shells, type Headers } from './course-editor-support';

const keyed = (headers: Headers) => ({ ...headers, 'idempotency-key': randomUUID() });
const waypoints = [
  { role: 'start', position: [126.978, 37.566], name: null, sourceSampleId: null, locked: false },
  { role: 'finish', position: [126.982, 37.569], name: null, sourceSampleId: null, locked: false },
];

async function routedCourse(page: Page, headers: Headers, name: string) {
  const previewed = await page.request.post('/bff/v1/courses/route-previews', {
    headers,
    data: { requestId: randomUUID(), draftRevision: 1, waypoints },
  });
  expect(previewed.status(), await previewed.text()).toBe(200);
  const preview = courseRoutePreviewResultSchema.parse(await previewed.json());
  assert.equal(preview.outcome, 'route_computed');
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
  assert.equal(read.status, 'available');
  return read.course.courseId;
}

async function trim(page: Page, headers: Headers, courseId: string, zoneSetDigest: string) {
  const response = await page.request.patch(`/bff/v1/courses/${courseId}`, {
    headers: keyed(headers),
    data: {
      expectedRevision: 1,
      change: { kind: 'privacy-trim', acknowledgedZoneSetDigest: zoneSetDigest },
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const read = courseReadResultSchema.parse(await response.json());
  assert.equal(read.status, 'available');
  assert.equal(read.revision.generation.kind, 'privacy-trimmed');
  return read;
}

for (const shell of shells) {
  test(`${shell.name}: owner credits a routed privacy trim and leaves an imported trim uncredited`, async ({
    page,
  }) => {
    const headers = await login(page);
    const name = `고지 확인 ${randomUUID()}`;
    const routedId = await routedCourse(page, headers, `${name} 경로`);
    const importedId = await importCourse(page, headers, `${name} 파일`, [
      [126.978, 37.566],
      [126.979, 37.567],
      [126.99, 37.575],
    ]);
    const zoneName = `${name} 보호 구역`;
    const addedZone = await page.request.post('/bff/v1/courses/privacy-zones', {
      headers,
      data: { name: zoneName, center: [126.978, 37.566], radiusMeters: 50 },
    });
    expect(addedZone.status(), await addedZone.text()).toBe(200);
    const zone = (await addedZone.json()) as {
      zones: { zoneId: string; name: string }[];
      zoneSetDigest: string;
    };
    const zoneId = zone.zones.find((item) => item.name === zoneName)?.zoneId;
    assert.ok(zoneId);

    try {
      const routed = await trim(page, headers, routedId, zone.zoneSetDigest);
      const imported = await trim(page, headers, importedId, zone.zoneSetDigest);
      assert.equal(routed.revision.generation.kind, 'privacy-trimmed');
      assert.equal(imported.revision.generation.kind, 'privacy-trimmed');
      expect(routed.revision.generation.sourceGraphBuildId).not.toBeNull();
      expect(imported.revision.generation.sourceGraphBuildId).toBeNull();

      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name: `${name} 경로`, exact: true }).click();
      await expect(workbench.getByTestId('course-generation')).toContainText('보호 구역 제거본');
      const notice = workbench.getByTestId('route-data-notice');
      await expect(notice).toContainText('OpenStreetMap');
      await expect(notice.getByRole('link', { name: 'ODbL 1.0 라이선스' })).toBeVisible();

      await workbench.getByRole('button', { name: `${name} 파일`, exact: true }).click();
      await expect(workbench.getByTestId('course-generation')).toContainText('보호 구역 제거본');
      await expect(workbench.getByTestId('route-data-notice')).toHaveCount(0);
    } finally {
      const removed = await page.request.delete(`/bff/v1/courses/privacy-zones/${zoneId}`, {
        headers,
      });
      expect(removed.status(), await removed.text()).toBe(200);
    }
  });
}
