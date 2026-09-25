import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { coursePrivacyZoneListSchema } from '../../packages/contracts/src/courses';
import {
  courseSharingLimits,
  sharedCourseSchema,
} from '../../packages/contracts/src/course-sharing';
import { importCourse, login, shells, type Headers } from './course-editor-support';

/**
 * M2-01k-o B: the view-only link, in both shells, against the real stack.
 *
 * The link flag is OFF in every shipped configuration. These specs run only in a harness
 * started with IDENTITY_E2E_COURSE_SHARING=on — the "test environment with the flag on" the
 * requirement names (§8) — and are skipped, visibly, in every other run. Synthetic
 * coordinates only.
 */
const sharingOn = process.env['IDENTITY_E2E_COURSE_SHARING'] === 'on';
const courseSharingReadsPerMinute = courseSharingLimits.readsPerClientPerMinute;
test.skip(!sharingOn, 'link sharing is off in this run (the shipped default); see §8');

const METERS_PER_DEGREE = (Math.PI / 180) * 6_371_008.8;
/** A small protected area: its share circle (S = 200 m) is four times its radius. */
const home: [number, number] = [127.05, 37.6];
const radius = 50;
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
const loop: [number, number][] = [
  ...leg([0, 0], [1200, 0], 20),
  ...leg([1200, 0], [1200, 600], 100),
  ...leg([1200, 600], [0, 600], 100),
  ...leg([0, 600], [0, 0], 20),
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

/**
 * T11 (web-shell stream): when a run captures the shells' logs, the values this spec planted
 * — the token, its digest, the line it was shown, the course name — are written to the file
 * `IDENTITY_E2E_SHELL_PROBES` names, one JSON line each, for `scripts/audit-shell-log.mts`
 * to look for in what the shells wrote. Synthetic values only; the file lives outside the
 * repository and is deleted by the auditor.
 */
function plantProbes(values: Record<string, readonly string[]>) {
  const file = process.env['IDENTITY_E2E_SHELL_PROBES'];
  if (!file) return;
  for (const [kind, list] of Object.entries(values))
    for (const value of list)
      if (value !== '') appendFileSync(file, `${JSON.stringify({ kind, value })}\n`);
}

async function ensureZone(page: Page, headers: Headers) {
  const listed = coursePrivacyZoneListSchema.parse(
    await (await page.request.get('/bff/v1/courses/privacy-zones', { headers })).json(),
  );
  if (listed.zones.some((zone) => zone.name === 'M2-01k-o 공유 집')) return;
  const created = await page.request.post('/bff/v1/courses/privacy-zones', {
    headers,
    data: { name: 'M2-01k-o 공유 집', center: home, radiusMeters: radius },
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

/** What the page kept anywhere a browser keeps things, as one string to search (T24). */
async function keptByBrowser(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [];
    for (const storage of [localStorage, sessionStorage])
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? '';
        parts.push(key, storage.getItem(key) ?? '');
      }
    const databases = (await indexedDB.databases?.()) ?? [];
    for (const database of databases) parts.push(database.name ?? '');
    for (const name of await caches.keys()) {
      parts.push(name);
      for (const request of await (await caches.open(name)).keys()) parts.push(request.url);
    }
    parts.push(...performance.getEntriesByType('resource').map((entry) => entry.name));
    parts.push(document.cookie);
    return parts.join('\n');
  });
}

for (const shell of shells) {
  test.describe(`${shell.name} shell`, () => {
    test('a link shows a fixed, trimmed, name-free line to anyone who has it — and nothing before "코스 보기"', async ({
      page,
      browser,
    }) => {
      test.setTimeout(300_000);
      const headers = await login(page, 'Alice');
      await ensureZone(page, headers);
      const name = `M2-01k-o 링크 ${shell.name} ${Date.now()}`;
      await importCourse(page, headers, name, loop);
      await page.setViewportSize({ width: 1280, height: 900 });
      const workbench = await openCourse(page, shell.origin, name);

      // The owner: one confirmation screen, no exact-line choice, names off by default.
      const panel = workbench.getByRole('region', { name: '링크 공유' });
      await panel.getByRole('button', { name: '링크로 공유' }).click();
      const confirmation = workbench.getByRole('region', { name: '링크 공유 전 확인' });
      await expect(
        confirmation.getByRole('button', { name: '확인하고 링크 만들기' }),
      ).toBeVisible();
      await expect(confirmation.getByRole('radio')).toHaveCount(0);
      await expect(confirmation).not.toContainText('정확한 선');
      await expect(confirmation.getByLabel('코스 이름과 경유점 이름 포함')).not.toBeChecked();
      for (const sentence of [
        '링크는 항상 보호 구역을 제거한 선을 보여 줍니다.',
        '코스를 고쳐도 링크의 내용은 바뀌지 않습니다.',
        '받은 사람은 파일을 받을 수 없습니다.',
        '브라우저 기록에 링크가 남을 수 있습니다.',
      ])
        await expect(confirmation).toContainText(sentence);
      await confirmation.getByRole('button', { name: '확인하고 링크 만들기' }).click();
      const field = confirmation.getByLabel('공유 링크');
      await expect(field).toHaveValue(
        new RegExp(`^${shell.origin}/shared/course#[A-Za-z0-9_-]{43}$`),
      );
      const link = await field.inputValue();
      const token = link.split('#')[1];
      assert.ok(token);
      // B-7 / T24: the token lives in that field and nowhere the browser keeps things.
      expect(await keptByBrowser(page)).not.toContain(token);
      expect(page.url()).not.toContain(token);

      // T3 (B-1): the link's line stays at least S = 200 m from the centre of a 50 m area —
      // what lying outside a share circle means, whatever its secret offset.
      const read = await page.request.post('/bff/v1/shared/course', { data: { token } });
      expect(read.status()).toBe(200);
      const shared = sharedCourseSchema.parse(await read.json());
      for (const position of [...shared.coordinates, ...shared.waypoints.map((w) => w.position)]) {
        expect(haversine(home, position)).toBeGreaterThanOrEqual(200);
        for (const ordinate of position) expect(Math.round(ordinate * 1e5) / 1e5).toBe(ordinate);
      }
      expect(shared.name).toBeUndefined();
      plantProbes({
        token: [token],
        digest: [createHash('sha256').update(token, 'utf8').digest('hex')],
        coordinate: [
          ...new Set(
            [...shared.coordinates, ...shared.waypoints.map((w) => w.position)]
              .flat()
              .map((ordinate) => String(ordinate)),
          ),
        ],
        body: [name],
      });
      expect(read.headers()['cache-control']).toBe('no-store, private');
      expect(read.headers()['referrer-policy']).toBe('no-referrer');

      // The recipient: a fresh browser, no account.
      const guestContext = await browser.newContext();
      const guest = await guestContext.newPage();
      const requests: Request[] = [];
      guest.on('request', (request) => requests.push(request));
      await guest.goto(link);
      await expect(guest.getByRole('button', { name: '코스 보기' })).toBeVisible();
      await guest.waitForTimeout(500);
      // R-4: before the click there is no API call, no map code and no tile.
      const early = requests.map((request) => new URL(request.url()).pathname);
      expect(early.filter((path) => path.startsWith('/bff/'))).toEqual([]);
      expect(early.filter((path) => /maplibre|\/map\/basemap\/|tiles/.test(path))).toEqual([]);
      const scriptsBefore = new Set(
        requests.filter((request) => request.resourceType() === 'script').map((r) => r.url()),
      );
      expect(guest.url()).toContain(`#${token}`);
      // Static, generic preview metadata and no image; not for indexing.
      await expect(guest.locator('meta[property="og:image"]')).toHaveCount(0);
      await expect(guest.locator('meta[name="robots"]').first()).toHaveAttribute(
        'content',
        /noindex/,
      );
      if (shell.name === 'Next')
        await expect(guest.locator('meta[property="og:title"]')).toHaveAttribute(
          'content',
          '공유된 코스',
        );

      await guest.getByRole('button', { name: '코스 보기' }).click();
      await expect(guest.getByTestId('shared-course-expiry')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
      await expect(guest.getByRole('list', { name: '코스 지점' })).toContainText('출발');
      await guest.waitForTimeout(1500);
      // The fragment was read and removed; nothing any request carried held the token.
      expect(guest.url()).not.toContain('#');
      for (const request of requests) {
        expect(request.url()).not.toContain(token);
        expect(request.headers()['referer'] ?? '').not.toContain(token);
        // No request left this origin (R7).
        expect(new URL(request.url()).origin).toBe(shell.origin);
      }
      const readRequest = requests.find((request) =>
        request.url().endsWith('/bff/v1/shared/course'),
      );
      assert.ok(readRequest);
      expect(readRequest.method()).toBe('POST');
      // The map code arrived only after the click: new script chunks were fetched for it.
      const scriptsAfter = requests.filter(
        (request) => request.resourceType() === 'script' && !scriptsBefore.has(request.url()),
      );
      expect(scriptsAfter.length).toBeGreaterThan(0);
      // B-3 / D5: no word about a trim and no download control.
      await expect(guest.locator('body')).not.toContainText('보호 구역');
      await expect(guest.getByRole('button', { name: /다운로드|GPX|내보내기/ })).toHaveCount(0);
      await expect(guest.getByRole('link', { name: /다운로드|GPX|내보내기/ })).toHaveCount(0);
      // B-8: at most the map's attribution goes elsewhere, and it sends no referrer.
      const external = await guest
        .locator('a[href^="http"]')
        .evaluateAll(
          (anchors, origin) =>
            anchors
              .filter((anchor) => new URL((anchor as HTMLAnchorElement).href).origin !== origin)
              .map((anchor) => anchor.getAttribute('rel') ?? ''),
          shell.origin,
        );
      expect(external.length).toBeLessThanOrEqual(1);
      for (const rel of external) expect(rel).toContain('noreferrer');
      expect(await keptByBrowser(guest)).not.toContain(token);

      // 320 px: the recipient screen reflows without a horizontal scroll.
      await guest.setViewportSize({ width: 320, height: 800 });
      expect(
        await guest.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);

      // T15: an edit of the course does not change what the link shows.
      const before = await (
        await page.request.post('/bff/v1/shared/course', { data: { token } })
      ).text();
      await workbench.getByLabel('코스 이름', { exact: true }).fill(`${name} 수정`);
      await workbench.getByRole('button', { name: '이름 저장' }).click();
      await expect(workbench.getByText(/이름을 저장했습니다/)).toBeVisible();
      const after = await (
        await page.request.post('/bff/v1/shared/course', { data: { token } })
      ).text();
      expect(JSON.parse(after).coordinates).toEqual(JSON.parse(before).coordinates);

      // T5: the owner turns it off; the recipient gets nothing from the next request on.
      await page.goto(`${shell.origin}/courses`);
      await workbench.getByRole('button', { name: `${name} 수정`, exact: true }).click();
      const links = workbench.getByRole('region', { name: '링크 공유' }).getByRole('list', {
        name: '이 코스의 링크',
      });
      await links.getByRole('button', { name: '링크 끄기' }).first().click();
      await expect(links).toContainText('꺼짐');
      const again = await guestContext.newPage();
      await again.goto(link);
      await again.getByRole('button', { name: '코스 보기' }).click();
      await expect(again.getByRole('alert').filter({ hasText: '이 링크로' })).toContainText(
        '이 링크로 볼 수 있는 코스가 없습니다.',
      );
      await guestContext.close();

      // T11 through this shell: the 404 path (the revoked link, above and here) and the
      // rate-limit path — more reads in a minute than one client may make. Every answer is
      // the same 404 by design, so the limit is not visible here; the API integration test
      // T11/T12 tells the two apart. What this run checks is what the shell itself wrote.
      const through = `${shell.origin}/bff/v1/shared/course`;
      for (let index = 0; index <= courseSharingReadsPerMinute; index += 1)
        expect((await page.request.post(through, { data: { token } })).status()).toBe(404);
      // The harness proxies from one loopback address, so this client's minute is everyone's:
      // let it pass before the next test reads a link.
      const now = new Date();
      await page.waitForTimeout(61_000 - now.getSeconds() * 1000 - now.getMilliseconds());
    });

    test('T21: an owner without a protected area gets no share button, only the way to add one', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const headers = await login(page, 'Bob');
      const listed = coursePrivacyZoneListSchema.parse(
        await (await page.request.get('/bff/v1/courses/privacy-zones', { headers })).json(),
      );
      for (const zone of listed.zones)
        await page.request.delete(`/bff/v1/courses/privacy-zones/${zone.zoneId}`, { headers });
      const name = `M2-01k-o 구역 없는 링크 ${shell.name} ${Date.now()}`;
      await importCourse(page, headers, name, loop);
      const workbench = await openCourse(page, shell.origin, name);
      const panel = workbench.getByRole('region', { name: '링크 공유' });
      await expect(panel).toContainText('보호 구역을 먼저 추가하세요');
      await expect(panel.getByRole('button', { name: '링크로 공유' })).toHaveCount(0);
      await panel.getByRole('button', { name: '보호 구역 추가하러 가기' }).click();
      await expect(workbench.getByLabel('보호 구역 이름')).toBeFocused();
    });
  });
}
