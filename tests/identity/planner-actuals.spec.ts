import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  manualActivityResultSchema,
  activityImportResultSchema,
} from '../../packages/contracts/src/activity';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

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

test('planner actual pages use saved local dates and preserve drafts across lenses, layouts and detail navigation', async ({
  page,
}) => {
  test.setTimeout(60000);
  const headers = await login(page);
  const marker = `Planner actual ${randomUUID()}`;
  const currentResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(currentResponse.status()).toBe(200);
  const current = planReadSchema.parse(await currentResponse.json());
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `actual-${level}`,
      parentId: index === 0 ? null : `actual-${levels[index - 1]}`,
      level,
      title: `${marker} ${level}`,
      startDate: '2017-02-01',
      endDateExclusive: '2017-02-03',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'actual-session',
        blockId: 'actual-block',
        date: '2017-02-01',
        localStartTime: null,
        title: 'Synthetic planned session',
        sport: 'running',
        durationSeconds: 1200,
        distanceMeters: 1000,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
  try {
    const response = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: current.head?.id ?? null,
        draft,
      },
    });
    expect(response.status()).toBe(200);
    const plan = planSnapshotSchema.parse(await response.json());
    const createManual = async (
      title: string,
      startedAt: string,
      distanceMeters: number | null,
      linked: boolean,
    ) => {
      const created = await page.request.post('/bff/v1/activities', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          confirmed: true,
          activity: {
            title,
            kind: 'running',
            startedAt,
            timezone: 'Asia/Seoul',
            distanceMeters,
            durationSeconds: null,
            durationKind: 'timer',
          },
          report: {
            sessionRpe: null,
            note: null,
            planLink: linked ? { planVersionId: plan.id, sessionId: 'actual-session' } : null,
          },
        },
      });
      expect(created.status()).toBe(200);
      return manualActivityResultSchema.parse(await created.json());
    };
    const linked = await createManual(`${marker} linked zero`, '2017-01-31T15:00:00Z', 0, true);
    for (let index = 0; index < 49; index++) {
      const imported = await page.request.post('/bff/v1/activity-imports', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          source: {
            kind: 'fixture',
            sourceId: randomUUID(),
            revision: 1,
            contentHash: 'a'.repeat(64),
          },
          activity: {
            title: `${marker} filler ${index}`,
            kind: 'walking',
            startedAt: `2017-02-01T01:00:${String(index).padStart(2, '0')}Z`,
            timezone: 'UTC',
            distanceMeters: null,
            durationSeconds: null,
            durationKind: 'unknown',
          },
        },
      });
      expect(imported.status()).toBe(200);
      activityImportResultSchema.parse(await imported.json());
    }
    await createManual(`${marker} unlinked missing`, '2017-02-02T01:00:00Z', null, false);
    await createManual(`${marker} outside boundary`, '2017-01-31T14:59:59Z', 999, false);
    await page.goto('/planner?lens=calendar&from=2017-02-01&to=2017-02-03&view=split');
    // Remaining assertions use the product's accessible actual-layer controls, not network mocks.
    const actuals = page.getByRole('region', { name: '실제 활동 레이어', exact: true });
    await expect(actuals).toContainText(`${marker} linked zero`);
    await expect(actuals).not.toContainText(`${marker} outside boundary`);
    await expect(page.getByRole('region', { name: '일별 계획', exact: true })).toContainText(
      '계획: Synthetic planned session',
    );
    await expect(actuals).toContainText('조회 범위의 실제 활동 51개 · 1페이지 · 현재 페이지 50개');
    await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
    const title = page.getByLabel('계획 제목', { exact: true });
    await title.fill(`${marker} unsaved draft`);
    await page.getByLabel('계획 시간대', { exact: true }).fill('America/New_York');
    await expect(actuals).toContainText('Asia/Seoul');
    await expect(actuals).toContainText(`${marker} linked zero`);
    await expect(actuals).not.toContainText(`${marker} outside boundary`);
    await title.focus();
    for (const viewport of viewportFixtures) {
      await page.setViewportSize({ width: viewport.width, height: 900 });
      await expect(title).toHaveValue(`${marker} unsaved draft`);
      await expect(title).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.setViewportSize({ width: 320, height: 900 });
    const linkedRecord = actuals
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: `${marker} linked zero`, exact: true }) });
    await expect(linkedRecord).toContainText('거리 0m');
    await expect(linkedRecord).toContainText('시간 미확인');
    await expect(linkedRecord).toContainText('현재 계획 버전 연결');
    const detail = linkedRecord.getByRole('link', {
      name: '실제 활동 상세 보기 (새 탭)',
      exact: true,
    });
    await detail.focus();
    const popupPromise = page.waitForEvent('popup');
    await detail.press('Enter');
    const popup = await popupPromise;
    try {
      await expect(popup).toHaveURL(new RegExp(`selected=${linked.activityId}`));
      await expect(
        popup.getByRole('region', { name: '선택한 활동 상세', exact: true }),
      ).toContainText(`${marker} linked zero`);
    } finally {
      await popup.close();
    }
    await expect(title).toHaveValue(`${marker} unsaved draft`);
    await actuals.getByRole('button', { name: '다음 실제 활동', exact: true }).click();
    await expect(page).toHaveURL(/actualPage=2/);
    await expect(actuals).toContainText(`${marker} unlinked missing`);
    await expect(actuals).toContainText('조회 범위의 실제 활동 51개 · 2페이지 · 현재 페이지 1개');
    await expect(actuals).toContainText('명시적 계획 연결 없음');
    await expect(actuals).toContainText('거리 미확인');
    await expect(actuals).not.toContainText(`${marker} linked zero`);
    await expect(title).toHaveValue(`${marker} unsaved draft`);
    await actuals.getByRole('button', { name: '이전 실제 활동', exact: true }).click();
    await page.getByRole('button', { name: '한 열 보기', exact: true }).click();
    for (const level of ['season', 'wave', 'phase', 'block'])
      await page
        .getByRole('button', { name: `${level} · ${marker} ${level}`, exact: true })
        .click();
    await expect(actuals).toContainText(`${marker} linked zero`);
    await expect(title).toHaveValue(`${marker} unsaved draft`);
    await page.getByRole('button', { name: 'Rolling', exact: true }).click();
    await page.getByLabel('Rolling 기준일', { exact: true }).fill('2017-02-02');
    await page.getByLabel('Rolling 일수 (1–366)', { exact: true }).fill('2');
    await expect(actuals).toContainText(`${marker} linked zero`);
    const corrected = await page.request.patch(`/bff/v1/activities/${linked.activityId}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        expectedRevision: linked.revision,
        reason: 'Synthetic correction while planner draft exists',
        distanceMeters: 42,
      },
    });
    expect(corrected.status()).toBe(200);
    await actuals.getByRole('button', { name: '실제 활동 다시 확인', exact: true }).click();
    await expect(actuals).toContainText('42m');
    await expect(title).toHaveValue(`${marker} unsaved draft`);
  } finally {
    // Isolated local OIDC/PostgreSQL fixture account only; no external users or services.
    const erased = await page.request.delete('/bff/v1/operations/account', {
      headers,
      data: { confirmation: 'DELETE MY ACCOUNT' },
    });
    expect(erased.status()).toBe(200);
    expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
  }
});
