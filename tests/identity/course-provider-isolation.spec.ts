import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  courseElevationResultSchema,
  placeSearchResultSchema,
} from '../../packages/contracts/src/geo-data';
import { importCourse, login, shells } from './course-editor-support';
import { expectLineDrawn, mapRegion, mapStatusLine, withoutWebGl } from './map-evidence';

/**
 * Opt-in S14 provider isolation proof. Run once with only the self-hosted basemap and once
 * with the self-hosted place/elevation dataset. Neither artifact is checked in. An absent
 * artifact is a failed precondition, never a skipped or passing provider assertion.
 */
const mode = process.env.PROVIDER_PROOF_MODE;
const seoul = [
  [126.978, 37.566],
  [126.982, 37.568],
  [126.986, 37.567],
] as const;

async function hasBasemap(page: Page, origin: string): Promise<boolean> {
  const pointer = await page.request.get(`${origin}/map/basemap/current.json`);
  if (!pointer.ok()) return false;
  try {
    const body: unknown = await pointer.json();
    return (
      body !== null &&
      typeof body === 'object' &&
      'deploymentId' in body &&
      typeof body.deploymentId === 'string'
    );
  } catch {
    return false;
  }
}

for (const shell of shells) {
  if (mode === 'missing-data') {
    test(`${shell.name}: missing place and elevation data do not stop the self-hosted map`, async ({
      page,
    }) => {
      const headers = await login(page);
      expect(await hasBasemap(page, shell.origin), 'a real self-hosted basemap is required').toBe(
        true,
      );

      const place = await page.request.post('/bff/v1/courses/place-search', {
        headers,
        data: { query: '남산', near: null },
      });
      expect(place.status()).toBe(200);
      expect(placeSearchResultSchema.parse(await place.json())).toEqual({ outcome: 'no_dataset' });
      const elevation = await page.request.post('/bff/v1/courses/elevation-profiles', {
        headers,
        data: { geometry: { type: 'LineString', coordinates: seoul } },
      });
      expect(elevation.status()).toBe(200);
      expect(courseElevationResultSchema.parse(await elevation.json())).toEqual({
        outcome: 'no_dataset',
      });

      const name = `공급자 분리 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      const backgroundRequests: string[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/map/basemap/')) backgroundRequests.push(path);
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      const map = mapRegion(workbench, '코스 지도');
      await expectLineDrawn(map);
      await expect(mapStatusLine(map)).toHaveText('지도에 경로를 표시했습니다.');
      expect(backgroundRequests.some((path) => path.endsWith('/style.json'))).toBe(true);
    });
  }

  if (mode === 'no-webgl') {
    test(`${shell.name}: WebGL failure does not stop the place or elevation API`, async ({
      page,
    }) => {
      const headers = await login(page);
      const placeBefore = await page.request.post('/bff/v1/courses/place-search', {
        headers,
        data: { query: '진달래길', near: null },
      });
      expect(placeBefore.status()).toBe(200);
      const places = placeSearchResultSchema.parse(await placeBefore.json());
      expect(places.outcome, 'a deployed place dataset is required').toBe('results');
      if (places.outcome !== 'results') throw new Error('PLACE_DATASET_REQUIRED');
      const found = places.places.find((entry) => entry.name === '진달래길');
      expect(found).toBeDefined();
      if (!found) throw new Error('KNOWN_PLACE_REQUIRED');

      const elevationBefore = await page.request.post('/bff/v1/courses/elevation-profiles', {
        headers,
        data: { geometry: { type: 'LineString', coordinates: [found.position, seoul[0]] } },
      });
      expect(elevationBefore.status()).toBe(200);
      const profile = courseElevationResultSchema.parse(await elevationBefore.json());
      expect(profile.outcome, 'a deployed elevation dataset is required').toBe('profile');
      if (profile.outcome !== 'profile') throw new Error('ELEVATION_DATASET_REQUIRED');
      expect(profile.knownCount).toBeGreaterThan(0);

      const name = `WebGL 분리 ${shell.name} ${randomUUID().slice(0, 8)}`;
      await importCourse(page, headers, name, seoul);
      await withoutWebGl(page);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${shell.origin}/courses`);
      const workbench = page.getByRole('region', { name: '내 코스' });
      await workbench.getByRole('button', { name, exact: true }).click();
      const map = mapRegion(workbench, '코스 지도');
      await expect(map).toHaveAttribute('data-map-status', 'unavailable');
      await expect(mapStatusLine(map)).toContainText('WebGL');

      const placeAfter = await page.request.post('/bff/v1/courses/place-search', {
        headers,
        data: { query: '진달래길', near: null },
      });
      const elevationAfter = await page.request.post('/bff/v1/courses/elevation-profiles', {
        headers,
        data: { geometry: { type: 'LineString', coordinates: [found.position, seoul[0]] } },
      });
      expect(placeAfter.status()).toBe(200);
      expect(elevationAfter.status()).toBe(200);
      expect(placeSearchResultSchema.parse(await placeAfter.json())).toEqual(places);
      expect(courseElevationResultSchema.parse(await elevationAfter.json())).toEqual(profile);
    });
  }
}
