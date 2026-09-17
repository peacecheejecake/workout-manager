import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activityListSchema,
  activitySchema,
  activitySummarySchema,
} from '../../packages/contracts/src/activity';
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

// S07 / V2-F12: explicit per-item outcomes, fixed revisions and deletion suppression.
test('batch deletion distinguishes actual success, stale conflict and a lost committed response', async ({
  page,
}) => {
  const headers = await login(page);
  const prefix = `batch-delete-${randomUUID()}`;
  const records: Array<{ id: string; revision: number; title: string; sourceId: string }> = [];
  const list = async () => {
    const response = await page.request.get(
      `/bff/v1/activities?${new URLSearchParams({ search: prefix })}`,
      { headers },
    );
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const summary = async () => {
    const response = await page.request.get('/bff/v1/activities/summary', { headers });
    expect(response.status()).toBe(200);
    return activitySummarySchema.parse(await response.json());
  };
  const before = await summary();
  try {
    for (const suffix of ['A', 'B', 'C']) {
      const sourceId = randomUUID();
      const title = `${prefix} ${suffix}`;
      const response = await page.request.post('/bff/v1/activity-imports', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          source: { kind: 'fixture', sourceId, revision: 1, contentHash: 'd'.repeat(64) },
          activity: {
            title,
            kind: 'running',
            startedAt: '2023-07-01T00:00:00Z',
            timezone: 'UTC',
            durationSeconds: 10,
            durationKind: 'elapsed',
            distanceMeters: 0,
          },
        },
      });
      expect(response.status()).toBe(200);
      const imported = activityImportResultSchema.parse(await response.json());
      records.push({ id: imported.activityId, revision: imported.revision, title, sourceId });
    }
    const [first, stale, uncertain] = records;
    assert.ok(first && stale && uncertain);
    const deletes: Array<{ id: string; revision: number }> = [];
    page.on('request', (request) => {
      if (request.method() !== 'DELETE') return;
      const body: unknown = request.postDataJSON();
      assert.ok(
        typeof body === 'object' &&
          body !== null &&
          'expectedRevision' in body &&
          typeof body.expectedRevision === 'number',
      );
      deletes.push({
        id: new URL(request.url()).pathname.split('/').at(-1) ?? '',
        revision: body.expectedRevision,
      });
    });
    await page.goto(`/activities?${new URLSearchParams({ search: prefix, sort: 'title_asc' })}`);
    const firstChoice = page.getByRole('checkbox', {
      name: `일괄 선택: ${first.title}`,
      exact: true,
    });
    await firstChoice.check();
    await firstChoice.focus();
    for (const viewport of viewportFixtures) {
      await page.setViewportSize(viewport);
      await expect(firstChoice).toBeChecked();
      await expect(firstChoice).toBeFocused();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();
    const batch = page.getByRole('region', { name: '선택 활동 일괄 로컬 삭제', exact: true });
    await expect(batch).toContainText('현재 선택 3개');
    await page.getByRole('button', { name: first.title, exact: true }).click();
    await expect(page.getByRole('region', { name: '선택한 활동 상세', exact: true })).toBeVisible();
    await batch.getByRole('button', { name: '선택 활동 삭제 미리보기', exact: true }).click();
    await expect(firstChoice).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '현재 페이지 선택', exact: true }),
    ).toBeDisabled();
    await expect(batch.getByRole('button', { name: '일괄 삭제 취소', exact: true })).toBeFocused();
    expect((await list()).total).toBe(3);
    expect((await summary()).count).toBe(before.count + 3);
    expect(deletes).toEqual([]);
    const newTitle = `${stale.title} changed`;
    const correction = await page.request.patch(`/bff/v1/activities/${stale.id}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        expectedRevision: stale.revision,
        title: newTitle,
        reason: 'Synthetic concurrent correction',
      },
    });
    expect(correction.status()).toBe(200);
    stale.revision = activitySchema.parse(await correction.json()).revision;
    let loseResponse = true;
    await page.route(`**/bff/v1/activities/${uncertain.id}`, async (route) => {
      if (route.request().method() === 'DELETE' && loseResponse) {
        loseResponse = false;
        const result = await route.fetch();
        expect(result.status()).toBe(204);
        await route.abort('failed');
      } else await route.continue();
    });
    await batch.getByRole('button', { name: '선택 활동 삭제 확인', exact: true }).click();
    const results = batch.getByRole('region', { name: '일괄 삭제 결과', exact: true });
    await expect(results).toContainText(`${first.title} · 수정 번호 1 · 로컬 삭제 확인`);
    await expect(results).toContainText(
      `${stale.title} · 수정 번호 1 · 수정 충돌: 최신 기록 확인 필요`,
    );
    await expect(results).toContainText(`${uncertain.title} · 수정 번호 1 · 삭제 결과 미확인`);
    await expect(batch).toContainText('현재 선택 1개');
    await expect(page.getByRole('region', { name: '선택한 활동 상세', exact: true })).toBeHidden();
    expect((await list()).items.map((item) => item.id)).toEqual([stale.id]);
    expect((await summary()).count).toBe(before.count + 1);
    expect(deletes).toEqual(records.map((record) => ({ id: record.id, revision: 1 })));
    await batch.getByRole('button', { name: '미확인 활동 삭제 다시 확인', exact: true }).click();
    await expect(results).toContainText(`${uncertain.title} · 수정 번호 1 · 로컬 삭제 확인`);
    await expect(batch).toContainText('현재 선택 0개');
    expect(deletes.at(-1)).toEqual({ id: uncertain.id, revision: 1 });
    expect((await summary()).count).toBe(before.count + 1);
    await batch.getByRole('button', { name: '결과 닫기', exact: true }).click();
    await page.getByRole('checkbox', { name: `일괄 선택: ${newTitle}`, exact: true }).check();
    await batch.getByRole('button', { name: '선택 활동 삭제 미리보기', exact: true }).click();
    await expect(
      batch.getByRole('group', { name: '일괄 로컬 삭제 확인', exact: true }),
    ).toContainText('확인한 수정 번호 2');
    await batch.getByRole('button', { name: '선택 활동 삭제 확인', exact: true }).click();
    await expect(results).toContainText(`${newTitle} · 수정 번호 2 · 로컬 삭제 확인`);
    await expect(batch).toContainText('현재 선택 0개');
    expect((await list()).total).toBe(0);
    expect(await summary()).toEqual(before);
    const replay = await page.request.post('/bff/v1/activity-imports', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: {
          kind: 'fixture',
          sourceId: first.sourceId,
          revision: 2,
          contentHash: 'e'.repeat(64),
        },
        activity: {
          title: first.title,
          kind: 'running',
          startedAt: null,
          timezone: null,
          durationSeconds: null,
          durationKind: 'unknown',
          distanceMeters: null,
        },
      },
    });
    expect(replay.status()).toBe(200);
    expect(activityImportResultSchema.parse(await replay.json()).outcome).toBe('suppressed');
    expect((await list()).total).toBe(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    for (const record of records) {
      const response = await page.request.delete(`/bff/v1/activities/${record.id}`, {
        headers,
        data: { expectedRevision: record.revision },
      });
      expect(response.status()).toBe(204);
    }
  }
});
