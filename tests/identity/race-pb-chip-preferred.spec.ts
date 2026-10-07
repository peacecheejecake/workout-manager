import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Locator, type Request } from '@playwright/test';
import {
  raceCommandResultSchema,
  raceEventValuesSchema,
  raceResultValuesSchema,
} from '../../packages/contracts/src/race-commands';
import { raceResultReadSchema } from '../../packages/contracts/src/race-commands';
import { raceResultListPageSchema } from '../../packages/contracts/src/race-queries';
import { eraseAccountResultSchema } from '../../packages/contracts/src/operations';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';
import { shells, type Headers } from './course-editor-support';

// Public OIDC, app consent and PostgreSQL producers only. Root runs these two
// shells; no route interception, server clock override or source/body SQL seed.
async function login(page: Page): Promise<Headers> {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(typeof session === 'object' && session !== null);
  assert.ok('sessionId' in session && typeof session.sessionId === 'string');
  assert.ok('csrfToken' in session && typeof session.csrfToken === 'string');
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}
async function erase(page: Page, headers: Headers) {
  const response = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 10000,
  });
  expect(response.status()).toBe(200);
  expect(eraseAccountResultSchema.parse(await response.json()).erased).toBe(true);
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
}
async function reflow(page: Page, pb: Locator) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  expect(await pb.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  for (const control of await pb.locator('input,select,button').all()) {
    const box = await control.boundingBox();
    assert.ok(box);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(321);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
}

for (const shell of shells) {
  test(`${shell.name}: default Chip preference, null-only Gun fallback, original actuals and responsive public replay/delete`, async ({
    browser,
  }) => {
    test.setTimeout(90000);
    const context = await browser.newContext({
      baseURL: shell.origin,
      viewport: { width: 320, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    let headers: Headers | null = null;
    try {
      // Erase only this disposable harness's synthetic account, then recreate
      // through OIDC so no preceding spec's health/result rows enter this test.
      headers = await login(page);
      await erase(page, headers);
      headers = null;
      headers = await login(page);
      await grantAppProcessingForScenario(page);
      const initial = await page.request.get('/bff/v1/race-results?limit=100', { headers });
      expect(initial.status()).toBe(200);
      expect(raceResultListPageSchema.parse(await initial.json()).items).toEqual([]);
      const marker = `PB기본 ${shell.name} ${randomUUID().slice(0, 8)}`;
      const eventReply = await page.request.post('/bff/v1/races', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          values: raceEventValuesSchema.parse({
            title: marker,
            localDate: '2026-01-01',
            localStartTime: null,
            timezone: 'Asia/Seoul',
            locationName: null,
            distance: { kind: 'standard', class: '5k' },
            priority: null,
            participation: 'registered',
            officialUrl: null,
            course: null,
            targetSeconds: null,
            planVersionId: null,
          }),
        },
      });
      expect(eventReply.status()).toBe(201);
      const race = raceCommandResultSchema.parse(await eventReply.json());
      const input = (
        day: number,
        chipSeconds: number | null,
        gunSeconds: number | null,
        distance = 5000,
        device = false,
      ) =>
        raceResultValuesSchema.parse({
          kind: 'race-result',
          raceEventId: race.id,
          localDate: `2026-01-${String(day).padStart(2, '0')}`,
          timezone: 'Asia/Seoul',
          source: device
            ? { kind: 'device', providerLabel: 'Synthetic device' }
            : { kind: 'manual' },
          chipSeconds,
          gunSeconds,
          officialDistanceMeters: distance,
          deviceDistanceMeters: null,
          linkedActivityId: null,
          weatherNote: `${marker} ${day}`,
        });
      const values = [
        input(1, 100, 1),
        input(2, null, 90),
        input(3, 0, 1),
        input(4, null, null),
        input(5, 200, 180, 10000),
        input(6, 300, 290, 21097.5),
        input(7, 400, 390, 42195),
        input(8, 1, 1, 1234),
        input(9, 1, 1, 5000, true),
      ];
      const created: ReturnType<typeof raceCommandResultSchema.parse>[] = [];
      for (const value of values) {
        const key = randomUUID();
        const reply = await page.request.post('/bff/v1/race-results', {
          headers: { ...headers, 'idempotency-key': key },
          data: { values: value },
        });
        expect(reply.status()).toBe(201);
        const receipt = raceCommandResultSchema.parse(await reply.json());
        created.push(receipt);
        const read = await page.request.get(`/bff/v1/race-results/${receipt.id}`, { headers });
        expect(read.status()).toBe(200);
        expect(raceResultReadSchema.parse(await read.json())).toEqual({ ...value, ...receipt });
        const replay = await page.request.post('/bff/v1/race-results', {
          headers: { ...headers, 'idempotency-key': key },
          data: { values: value },
        });
        expect(replay.status()).toBe(201);
        expect(raceCommandResultSchema.parse(await replay.json())).toEqual(receipt);
      }
      const count = await page.request.get('/bff/v1/race-results?limit=100', { headers });
      expect(count.status()).toBe(200);
      expect(raceResultListPageSchema.parse(await count.json()).items).toHaveLength(9);
      await page.goto('/records');
      const results = page.getByRole('region', { name: '실제 대회 결과', exact: true });
      const pb = results.getByRole('region', { name: '거리별 PB 비교', exact: true });
      await expect(pb.getByText('전체 9개 기록을 비교했습니다.', { exact: true })).toBeVisible();
      await expect(pb.getByLabel('PB 거리 기준')).toHaveValue('standard');
      await expect(pb.getByLabel('PB 시간 기준')).toHaveValue('chip-preferred');
      await expect(pb.getByLabel('PB 기준일')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
      const winners = pb.getByRole('list', { name: '거리별 PB 결과' });
      await expect(winners.getByRole('listitem')).toHaveCount(4);
      await expect(winners).toContainText('5000 m · Gun · 90 초');
      await expect(winners).toContainText('10000 m · Chip · 200 초');
      await expect(winners).toContainText('21097.5 m · Chip · 300 초');
      await expect(winners).toContainText('42195 m · Chip · 400 초');
      await expect(winners).not.toContainText('1234 m');
      await expect(winners).toContainText('직접 입력');
      const bases = pb.getByRole('list', { name: '각 기록 PB 비교 기준' });
      await expect(bases).toContainText('2026-01-01 · 선택 기준 Chip · 100 초');
      await expect(bases).toContainText('2026-01-02 · 선택 기준 Gun · 90 초');
      await expect(bases).toContainText('2026-01-03 · 선택 기준 Chip · 0 초 · 0초 기록');
      await expect(bases).toContainText('2026-01-04 · 선택 기준 Gun · 미상 초 · 시간 미상');
      await expect(pb.getByRole('list', { name: 'PB 제외 사유' })).toContainText(
        '기기 추정 출처: 1개 시간 비교',
      );
      await expect(results.getByText('Chip 100 초 · Gun 1 초', { exact: true })).toBeVisible();
      await expect(results.getByText('Chip 미상 초 · Gun 90 초', { exact: true })).toBeVisible();
      await expect(results.getByText('Chip 0 초 · Gun 1 초', { exact: true })).toBeVisible();
      await expect(pb.getByText(/첨부 근거는 진위 확인 완료를 뜻하지 않습니다/)).toBeVisible();
      await reflow(page, pb);
      const comparisonWrites: string[] = [];
      const trackWrites = (request: Request) => {
        if (new URL(request.url()).pathname.startsWith('/bff/v1/') && request.method() !== 'GET')
          comparisonWrites.push(request.method());
      };
      page.on('request', trackWrites);
      await pb.getByLabel('PB 거리 기준').focus();
      await page.keyboard.press('Tab');
      await expect(pb.getByLabel('PB 시간 기준')).toBeFocused();
      expect(
        await pb.getByLabel('PB 시간 기준').evaluate((element) => {
          const style = getComputedStyle(element);
          return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
        }),
      ).toBe(true);
      await pb.getByLabel('PB 시간 기준').selectOption('both');
      const apply = pb.getByRole('button', { name: 'PB 비교 적용', exact: true });
      await apply.focus();
      await expect(apply).toBeFocused();
      await apply.press('Enter');
      await expect(winners).toContainText('5000 m · Chip · 100 초');
      await expect(winners).toContainText('5000 m · Gun · 1 초');
      await pb.getByLabel('PB 거리 기준').selectOption('exact');
      await pb.getByLabel('PB 시간 기준').selectOption('chip-preferred');
      await apply.press('Enter');
      await expect(winners).toContainText('1234 m · Chip · 1 초');
      await pb.getByLabel('PB 거리 기준').selectOption('standard');
      await apply.press('Enter');
      await expect(winners).not.toContainText('1234 m');
      await expect(winners).toContainText('5000 m · Gun · 90 초');
      expect(comparisonWrites).toEqual([]);
      page.off('request', trackWrites);
      // A genuine public change invalidates an earlier collection cursor. The
      // browser subsequently refreshes its owned list, including partial pages.
      const first = await page.request.get('/bff/v1/race-results?limit=1', { headers });
      expect(first.status()).toBe(200);
      const cursor = raceResultListPageSchema.parse(await first.json()).nextCursor;
      assert.ok(cursor);
      for (let index = 0; index < 42; index++) {
        const reply = await page.request.post('/bff/v1/race-results', {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: { values: input(10, 1000 + index, 2000 + index) },
        });
        expect(reply.status()).toBe(201);
        raceCommandResultSchema.parse(await reply.json());
      }
      const stale = await page.request.get(
        `/bff/v1/race-results?limit=1&cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
        { headers },
      );
      expect(stale.status()).toBe(409);
      expect(await stale.json()).toMatchObject({ error: { code: 'RACE_CURSOR_STALE' } });
      await results.getByRole('button', { name: '목록 새로고침', exact: true }).click();
      await expect(pb.getByText(/불러온 50개 기록 기준.*전체 PB 비교는 미완료/)).toBeVisible();
      await results.getByRole('button', { name: '다음 실제 대회 결과 보기', exact: true }).click();
      await expect(pb.getByText('전체 51개 기록을 비교했습니다.', { exact: true })).toBeVisible();
      await expect(winners).toContainText('5000 m · Gun · 90 초');
      await reflow(page, pb);
      const fallback = created[1],
        fallbackValues = values[1];
      assert.ok(fallback && fallbackValues);
      const updatedReply = await page.request.patch(`/bff/v1/race-results/${fallback.id}`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { values: fallbackValues, expectedRevision: fallback.revision },
      });
      expect(updatedReply.status()).toBe(200);
      const updated = raceCommandResultSchema.parse(await updatedReply.json());
      expect(updated.revision).toBe(fallback.revision + 1);
      const refused = await page.request.delete(`/bff/v1/race-results/${fallback.id}`, {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { expectedRevision: fallback.revision },
      });
      expect(refused.status()).toBe(409);
      const retained = await page.request.get(`/bff/v1/race-results/${fallback.id}`, { headers });
      expect(retained.status()).toBe(200);
      expect(raceResultReadSchema.parse(await retained.json())).toEqual({
        ...fallbackValues,
        ...updated,
      });
      await results.getByRole('button', { name: '목록 새로고침', exact: true }).click();
      await expect(pb.getByText(/불러온 50개 기록 기준/)).toBeVisible();
      await results.getByRole('button', { name: '다음 실제 대회 결과 보기', exact: true }).click();
      await expect(pb.getByText('전체 51개 기록을 비교했습니다.', { exact: true })).toBeVisible();
      const card = results
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: '2026-01-02 대회 결과', exact: true }) });
      await expect(card).toHaveCount(1);
      await card.getByRole('button', { name: '삭제', exact: true }).click();
      const deletion = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/bff/v1/race-results/${fallback.id}` &&
          response.request().method() === 'DELETE',
        { timeout: 15000 },
      );
      await results.getByRole('button', { name: '삭제 확인', exact: true }).click();
      const deleted = await deletion;
      expect(deleted.status()).toBe(200);
      raceCommandResultSchema.parse(await deleted.json());
      await expect(pb.getByText('전체 50개 기록을 비교했습니다.', { exact: true })).toBeVisible();
      await expect(winners).toContainText('5000 m · Chip · 100 초');
      await expect(winners).not.toContainText('Gun · 90 초');
      await expect(
        results.getByRole('heading', { name: '2026-01-02 대회 결과', exact: true }),
      ).toHaveCount(0);
      const original = created[0],
        originalValues = values[0];
      assert.ok(original && originalValues);
      const originalRead = await page.request.get(`/bff/v1/race-results/${original.id}`, {
        headers,
      });
      expect(originalRead.status()).toBe(200);
      expect(raceResultReadSchema.parse(await originalRead.json())).toEqual({
        ...originalValues,
        ...original,
      });
      await reflow(page, pb);
    } finally {
      try {
        if (headers) await erase(page, headers);
      } finally {
        await context.close();
      }
    }
  });
}
