import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import {
  courseImportResultSchema,
  courseListSchema,
  type CourseReadResult,
} from '../../packages/contracts/src/courses';

/**
 * Shared steps of the M2-01k-c1 specs (S14 editor: folding waypoint list, undo/redo content,
 * safety notice, late answers, map states). Everything here drives the real screens or the
 * real API as the signed-in owner; nothing stands in for the server.
 */
export type Headers = Record<string, string>;

export const shells = [
  { name: 'Next', origin: 'http://127.0.0.1:3100' },
  { name: 'Vite', origin: 'http://127.0.0.1:4200' },
] as const;

export async function login(page: Page, name: 'Alice' | 'Bob' = 'Alice'): Promise<Headers> {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
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

/** A stored course made through the API; what is under test is the screen that edits it. */
export async function importCourse(
  page: Page,
  headers: Headers,
  name: string,
  points: readonly (readonly [number, number])[],
): Promise<string> {
  const response = await page.request.post('/bff/v1/courses/imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      name,
      originalFilename: 'course-editor.gpx',
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

/** How many of the owner's courses carry exactly this name, read from the API. */
export async function coursesNamed(page: Page, headers: Headers, name: string): Promise<number> {
  const response = await page.request.get('/bff/v1/courses', { headers });
  expect(response.status()).toBe(200);
  const list = courseListSchema.parse(await response.json());
  return list.courses.filter((course) => course.name === name).length;
}

export async function place(editor: Locator, longitude: number, latitude: number) {
  await editor.getByLabel('경유점 경도').fill(String(longitude));
  await editor.getByLabel('경유점 위도').fill(String(latitude));
  await editor.getByRole('button', { name: '좌표로 경유점 추가' }).click();
}

/** The text the list prints for a position. */
export const printed = (position: readonly [number, number]) =>
  `${position[1].toFixed(5)}, ${position[0].toFixed(5)}`;

/**
 * Every row of the waypoint list as the owner reads it: the ordinal and role, the printed
 * coordinate, the name typed into its field, and whether it is locked. This is the CONTENT
 * of the draft, not a count.
 */
export interface WaypointRow {
  readonly label: string;
  readonly coordinate: string;
  readonly name: string;
  readonly locked: boolean;
}

export async function waypointRows(editor: Locator): Promise<WaypointRow[]> {
  return editor
    .getByRole('list', { name: '경유점 목록' })
    .getByRole('listitem')
    .evaluateAll((items) =>
      items.map((item) => ({
        label: item.querySelector('span')?.textContent ?? '',
        coordinate: item.querySelector('[class*="coordinate"]')?.textContent ?? '',
        name: item.querySelector('input')?.value ?? '',
        locked: Array.from(item.querySelectorAll('button')).some((button) =>
          /잠금 해제$/.test(button.textContent ?? ''),
        ),
      })),
    );
}

export async function draftRevision(editor: Locator): Promise<number> {
  const text = (await editor.getByTestId('draft-revision').textContent()) ?? '';
  const match = /(\d+)/.exec(text);
  assert.ok(match, `no draft revision in "${text}"`);
  return Number(match[1]);
}

/**
 * The positions the map was handed, from the renderer's own coordinate list (the kit's
 * always-present non-map alternative lists every vertex of every path it draws).
 */
export async function mapCoordinates(map: Locator): Promise<string[]> {
  return map
    .getByRole('list', { name: /좌표 목록$/ })
    .getByRole('button')
    .allTextContents();
}

export const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Let the page run what a just-delivered response set off: two frames and a task. */
export async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0))),
      ),
  );
}
