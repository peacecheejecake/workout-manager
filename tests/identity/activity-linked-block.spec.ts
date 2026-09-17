import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activityContextSchema } from '../../packages/contracts/src/activity-context';
import {
  manualActivityResultSchema,
  activityImportResultSchema,
  activityListSchema,
} from '../../packages/contracts/src/activity';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';

async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
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

const cleanupHeaders = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const headers = cleanupHeaders.get(page);
  if (!headers) return;
  cleanupHeaders.delete(page);
  // Teardown has its own timeout budget, even if the product journey fails.
  // Local isolated OIDC/PostgreSQL synthetic Alice only; never external accounts.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

test('linked Block filtering uses immutable explicit links independently from actual dates and current head', async ({
  page,
  browser,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const marker = `Linked Block ${randomUUID()}`;
  const currentResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(currentResponse.status()).toBe(200);
  const current = planReadSchema.parse(await currentResponse.json());
  const draft = planDraftSchema.parse({
    title: marker,
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `linked-${level}`,
      parentId: index === 0 ? null : `linked-${levels[index - 1]}`,
      level,
      title: `${marker} ${level}`,
      startDate: '2015-02-01',
      endDateExclusive: '2015-02-11',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'linked-session',
        blockId: 'linked-block',
        date: '2015-02-02',
        localStartTime: null,
        title: 'Synthetic linked session',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
  {
    const save = async (expectedVersionId: string | null, title: string) => {
      const response = await page.request.put('/bff/v1/plans/current', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: { source: 'manual', confirmed: true, expectedVersionId, draft: { ...draft, title } },
      });
      expect(response.status()).toBe(200);
      return planSnapshotSchema.parse(await response.json());
    };
    const old = await save(current.head?.id ?? null, marker);
    const manual = async (title: string, date: string, versionId: string | null) => {
      const response = await page.request.post('/bff/v1/activities', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          confirmed: true,
          activity: {
            title,
            kind: 'running',
            startedAt: `${date}T08:00:00+09:00`,
            timezone: 'Asia/Seoul',
            distanceMeters: 0,
            durationSeconds: null,
            durationKind: 'unknown',
          },
          report: {
            sessionRpe: null,
            note: null,
            planLink: versionId ? { planVersionId: versionId, sessionId: 'linked-session' } : null,
          },
        },
      });
      expect(response.status()).toBe(200);
      return manualActivityResultSchema.parse(await response.json());
    };
    const outside = await manual(`${marker} old outside`, '2015-02-12', old.id);
    await manual(`${marker} unlinked same date`, '2015-02-02', null);
    const importedResponse = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'a'.repeat(64) },
        activity: {
          title: `${marker} unknown date`,
          kind: 'running',
          startedAt: null,
          timezone: null,
          distanceMeters: null,
          durationSeconds: null,
          durationKind: 'unknown',
        },
      },
    });
    expect(importedResponse.status()).toBe(200);
    const imported = activityImportResultSchema.parse(await importedResponse.json());
    expect(
      (
        await page.request.patch(`/bff/v1/activities/${imported.activityId}`, {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data: {
            expectedRevision: imported.revision,
            reason: 'Explicit user link',
            report: {
              sessionRpe: null,
              note: null,
              planLink: { planVersionId: old.id, sessionId: 'linked-session' },
            },
          },
        })
      ).status(),
    ).toBe(200);
    const head = await save(old.id, `${marker} newer`);
    const newLinked = await manual(`${marker} new linked`, '2015-02-02', head.id);
    const pair = (version: string) =>
      new URLSearchParams({ linkedPlanVersionId: version, linkedBlockId: 'linked-block' });
    const list = async (query: URLSearchParams) => {
      const response = await page.request.get(`/bff/v1/activities?${query}`, { headers });
      expect(response.status()).toBe(200);
      return activityListSchema.parse(await response.json());
    };
    const oldResults = await list(pair(old.id));
    expect(oldResults.total).toBe(2);
    expect(oldResults.items.map((item) => item.id).sort()).toEqual(
      [outside.activityId, imported.activityId].sort(),
    );
    expect((await list(pair(head.id))).items.map((item) => item.id)).toEqual([
      newLinked.activityId,
    ]);
    const withDates = pair(old.id);
    withDates.set('from', '2015-02-12');
    withDates.set('toExclusive', '2015-02-13');
    withDates.set('timezone', 'Asia/Seoul');
    expect((await list(withDates)).items.map((item) => item.id)).toEqual([outside.activityId]);
    withDates.set('from', '2015-02-01');
    withDates.set('toExclusive', '2015-02-11');
    expect((await list(withDates)).total).toBe(0);
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const other = await otherContext.newPage();
      const otherHeaders = await login(other, 'Bob');
      const response = await other.request.get(`/bff/v1/activities?${pair(old.id)}`, {
        headers: otherHeaders,
      });
      expect(response.status()).toBe(200);
      expect(activityListSchema.parse(await response.json())).toEqual({ items: [], total: 0 });
    } finally {
      await otherContext.close();
    }
    const contextResponse = await page.request.get(
      `/bff/v1/activities/${outside.activityId}/context`,
      { headers },
    );
    expect(contextResponse.status()).toBe(200);
    expect(activityContextSchema.parse(await contextResponse.json()).planContext).toMatchObject({
      status: 'linked',
      planVersion: { id: old.id },
      currentPlanVersionId: head.id,
    });
    await page.goto(`/activities?selected=${outside.activityId}&detailTab=impact`);
    const contextPanel = page.getByRole('region', { name: '계획 연결과 관측 영향', exact: true });
    const blockLink = contextPanel.getByRole('link', {
      name: '이 Block에 명시적으로 연결된 활동 보기',
      exact: true,
    });
    await expect(blockLink).toHaveAttribute('href', `/activities?${pair(old.id)}`);
    await blockLink.click();
    await expect(page).toHaveURL(new RegExp(`linkedPlanVersionId=${old.id}`));
    await expect(
      page.getByText('조회 조건에 맞는 활동 2개 · 현재 페이지 2개', { exact: true }),
    ).toBeVisible();
    await page.goto(`/activities?${pair(old.id)}&selected=${outside.activityId}`);
    await page.reload();
    await expect(
      page.getByText('조회 조건에 맞는 활동 2개 · 현재 페이지 2개', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: '연결된 계획 Block', exact: true })
      .selectOption(JSON.stringify([head.id, 'linked-block']));
    await expect(page).toHaveURL(new RegExp(`linkedPlanVersionId=${head.id}`));
    await expect(
      page.getByText('조회 조건에 맞는 활동 1개 · 현재 페이지 1개', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '계획 Block 조건 지우기', exact: true }).click();
    await expect(page).not.toHaveURL(/linkedPlanVersionId=/);
    await expect(page).not.toHaveURL(/linkedBlockId=/);
    await expect(page).toHaveURL(new RegExp(`selected=${outside.activityId}`));
    await expect(page.getByRole('region', { name: '선택한 활동 상세', exact: true })).toContainText(
      `${marker} old outside`,
    );
  }
});
