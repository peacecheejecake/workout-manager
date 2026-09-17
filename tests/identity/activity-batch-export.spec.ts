import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  activitySchema,
  manualActivityResultSchema,
  type Activity,
} from '../../packages/contracts/src/activity';
import { selectedActivityExportSchema } from '../../packages/contracts/src/activity-export';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  return readSessionHeaders(page);
}
async function readSessionHeaders(page: Page) {
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

// S07 / V2-F12: explicit downloads preserve observed revisions and never omit failed selections.
test('selected export refuses partial reads and downloads a report-preserving artifact without writes', async ({
  page,
  context,
  browser,
}) => {
  let headers = await login(page, 'Alice');
  const prefix = `batch-export-${randomUUID()}`;
  const originals: Activity[] = [];
  const cleanupContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    storageState: await context.storageState(),
  });
  const read = async (id: string) => {
    const response = await cleanupContext.request.get(`/bff/v1/activities/${id}`, { headers });
    expect(response.status()).toBe(200);
    return activitySchema.parse(await response.json());
  };
  try {
    for (const [index, suffix] of ['A', 'B'].entries()) {
      const response = await page.request.post('/bff/v1/activities', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          confirmed: true,
          activity: {
            title: `${prefix} ${suffix}`,
            kind: 'running',
            startedAt: '2020-11-01T01:30:00-04:00',
            timezone: 'America/New_York',
            durationSeconds: null,
            durationKind: 'timer',
            distanceMeters: index === 0 ? 0 : null,
          },
          report: {
            sessionRpe: index === 0 ? 0 : null,
            note: `${suffix} 자기보고 메모`,
            planLink: null,
          },
        },
      });
      expect(response.status()).toBe(200);
      originals.push(
        await read(manualActivityResultSchema.parse(await response.json()).activityId),
      );
    }
    const [first, second] = originals;
    assert.ok(first && second);
    const correction = await page.request.patch(`/bff/v1/activities/${first.id}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        expectedRevision: 1,
        durationSeconds: 0,
        durationKind: 'elapsed',
        reason: '내보낼 정정 검증',
      },
    });
    expect(correction.status()).toBe(200);
    const mutations: string[] = [];
    let downloads = 0;
    page.on('request', (request) => {
      if (
        new URL(request.url()).pathname.startsWith('/bff/v1/') &&
        !['GET', 'HEAD'].includes(request.method())
      )
        mutations.push(`${request.method()} ${request.url()}`);
    });
    page.on('download', () => {
      downloads++;
    });
    await page.goto(
      `/activities?${new URLSearchParams({ search: prefix, sort: 'title_asc', selected: first.id })}`,
    );
    await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();
    const changed = await page.request.patch(`/bff/v1/activities/${second.id}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedRevision: 1, title: `${prefix} B corrected`, reason: '선택 뒤 동시 정정' },
    });
    expect(changed.status()).toBe(200);
    const panel = page.getByRole('region', { name: '선택 활동 요약 내보내기', exact: true });
    const open = panel.getByRole('button', { name: '선택 활동 내보내기 미리보기', exact: true });
    const create = panel.getByRole('button', {
      name: '확인하고 내보내기 파일 만들기',
      exact: true,
    });
    const close = panel.getByRole('button', { name: '내보내기 닫기', exact: true });
    const download = panel.getByRole('link', { name: '선택 활동 JSON 다운로드', exact: true });
    await open.click();
    await expect(panel).toContainText('수정 충돌');
    await expect(create).toBeDisabled();
    await expect(download).toBeHidden();
    expect(downloads).toBe(0);
    await close.click();
    await page.getByRole('button', { name: '일괄 선택 해제', exact: true }).click();
    await page.getByRole('button', { name: '활동 목록 다시 확인', exact: true }).click();
    await expect(
      page.getByRole('button', { name: `${prefix} B corrected`, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();

    const readPath = `**/bff/v1/activities/${second.id}`;
    await page.route(readPath, (route) => route.abort('failed'));
    await open.click();
    await expect(panel).toContainText('조회 실패');
    await expect(create).toBeDisabled();
    await expect(download).toBeHidden();
    await close.click();
    await page.unroute(readPath);
    const expected = await Promise.all(originals.map((activity) => read(activity.id)));
    await open.click();
    await expect(create).toBeEnabled();
    await expect(
      page.getByRole('button', { name: '선택 활동 삭제 미리보기', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '계획 연결 변경 미리보기', exact: true }),
    ).toBeDisabled();
    await expect(download).toBeHidden();
    await close.focus();
    for (const viewport of viewportFixtures) {
      await page.setViewportSize(viewport);
      await expect(close).toBeFocused();
      await expect(create).toBeEnabled();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    expect(downloads).toBe(0);
    await create.click();
    await expect(download).toBeVisible();
    expect(downloads).toBe(0);
    const url = await download.getAttribute('href');
    assert.ok(typeof url === 'string' && url.startsWith('blob:'));
    const finished = page.waitForEvent('download');
    await download.click();
    const file = await finished;
    expect(file.suggestedFilename()).toBe('workout-manager-activity-summary.json');
    const path = await file.path();
    assert.ok(path);
    const artifact = selectedActivityExportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    expect(artifact.activities).toEqual(expected);
    expect(artifact.consistency).toBe('per-activity-revision');
    expect(artifact.activities[0]?.original.durationSeconds).toBeNull();
    expect(artifact.activities[0]?.effective.durationSeconds).toBe(0);
    expect(artifact.activities[0]?.userReport).toEqual(first.userReport);
    expect(artifact.activities[1]?.userReport?.sessionRpe).toBeNull();
    expect(downloads).toBe(1);
    expect(mutations).toEqual([]);
    expect(await Promise.all(originals.map((activity) => read(activity.id)))).toEqual(expected);
    await close.click();
    await expect(download).toBeHidden();
    await expect(page.getByRole('region', { name: '활동 일괄 선택', exact: true })).toContainText(
      '일괄 선택 2개',
    );
    await expect(page).toHaveURL((value) => value.searchParams.get('selected') === first.id);
    expect(
      await page.evaluate(async (blob) => {
        try {
          await fetch(blob);
          return true;
        } catch {
          return false;
        }
      }, url),
    ).toBe(false);

    await open.click();
    await expect(create).toBeEnabled();
    await create.click();
    const accountUrl = await download.getAttribute('href');
    assert.ok(typeof accountUrl === 'string' && accountUrl.startsWith('blob:'));
    const secondTab = await context.newPage();
    try {
      await secondTab.goto('/bff/v1/auth/login');
      await secondTab.getByRole('link', { name: 'Sign in as Bob' }).click();
      await expect(secondTab.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
      await expect(download).toBeHidden();
      await expect(page.getByRole('region', { name: '활동 일괄 선택', exact: true })).toContainText(
        '일괄 선택 0개',
      );
      expect(
        await page.evaluate(async (blob) => {
          try {
            await fetch(blob);
            return true;
          } catch {
            return false;
          }
        }, accountUrl),
      ).toBe(false);
      const forbidden = await secondTab.request.get(`/bff/v1/activities/${first.id}`, {
        headers: await readSessionHeaders(secondTab),
      });
      expect(forbidden.status()).toBe(404);
    } finally {
      await secondTab.close();
    }
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    // Switching the fixture account revokes the previous session, including its copied cookies.
    const cleanupPage = await cleanupContext.newPage();
    await cleanupPage.goto('/bff/v1/auth/login');
    await cleanupPage.getByRole('link', { name: 'Sign in as Alice' }).click();
    await expect(cleanupPage.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
    headers = await readSessionHeaders(cleanupPage);
    for (const original of originals) {
      const current = await read(original.id);
      const deleted = await cleanupContext.request.delete(`/bff/v1/activities/${original.id}`, {
        headers,
        data: { expectedRevision: current.revision },
      });
      expect(deleted.status()).toBe(204);
    }
    await cleanupContext.close();
  }
});
