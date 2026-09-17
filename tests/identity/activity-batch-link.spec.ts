import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activityListSchema,
  activityOverlayWriteSchema,
  activitySchema,
  activitySummarySchema,
  manualActivityResultSchema,
  type Activity,
} from '../../packages/contracts/src/activity';
import { activityContextSchema } from '../../packages/contracts/src/activity-context';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

async function login(page: Page, name: 'Alice' | 'Bob' = 'Alice') {
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

// S07 / V2-F12: an explicit batch changes links only, not the planned or performed workload.
test('batch plan links freeze the saved version, preserve reports and recover partial writes', async ({
  page,
  browser,
}) => {
  const headers = await login(page);
  const prefix = `batch-link-${randomUUID()}`;
  const read = async (id: string) => {
    const response = await page.request.get(`/bff/v1/activities/${id}`, { headers });
    expect(response.status()).toBe(200);
    return activitySchema.parse(await response.json());
  };
  const summary = async () => {
    const response = await page.request.get('/bff/v1/activities/summary', { headers });
    expect(response.status()).toBe(200);
    return activitySummarySchema.parse(await response.json());
  };
  const currentResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(currentResponse.status()).toBe(200);
  const current = planReadSchema.parse(await currentResponse.json());
  const draft = planDraftSchema.parse({
    title: prefix,
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `batch-${level}`,
      parentId: index === 0 ? null : `batch-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2019-06-01',
      endDateExclusive: '2019-06-11',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'batch-session',
        blockId: 'batch-block',
        date: '2019-06-02',
        localStartTime: null,
        title: '일괄 연결 검증 세션',
        sport: 'running',
        durationSeconds: 600,
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
  const savePlan = async (expectedVersionId: string | null, title: string) => {
    const response = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { source: 'manual', confirmed: true, expectedVersionId, draft: { ...draft, title } },
    });
    expect(response.status()).toBe(200);
    return planSnapshotSchema.parse(await response.json());
  };
  const originals: Activity[] = [];
  try {
    const saved = await savePlan(current.head?.id ?? null, prefix);
    for (const [index, suffix] of ['A', 'B', 'C'].entries()) {
      const activity = {
        title: `${prefix} ${suffix}`,
        kind: 'running',
        startedAt: '2019-06-02T00:00:00Z',
        timezone: 'UTC',
        durationSeconds: index === 1 ? null : 10,
        durationKind: 'elapsed',
        distanceMeters: index === 1 ? null : 0,
      };
      const response = await page.request.post(
        index === 2 ? '/bff/v1/activity-imports' : '/bff/v1/activities',
        {
          headers: { ...headers, 'idempotency-key': randomUUID() },
          data:
            index === 2
              ? {
                  activity,
                  source: {
                    kind: 'fixture',
                    sourceId: randomUUID(),
                    revision: 1,
                    contentHash: 'b'.repeat(64),
                  },
                }
              : {
                  confirmed: true,
                  activity,
                  report: {
                    sessionRpe: index === 0 ? 0 : null,
                    note: `${suffix} 메모 보존`,
                    planLink: null,
                  },
                },
        },
      );
      expect(response.status()).toBe(200);
      const result =
        index === 2
          ? activityImportResultSchema.parse(await response.json())
          : manualActivityResultSchema.parse(await response.json());
      originals.push(await read(result.activityId));
    }
    const [first, stale, uncertain] = originals;
    assert.ok(first && stale && uncertain);
    const initialSummary = await summary();
    const patches: Array<{
      path: string;
      command: ReturnType<typeof activityOverlayWriteSchema.parse>;
    }> = [];
    page.on('request', (request) => {
      if (request.method() !== 'PATCH') return;
      const body: unknown = request.postDataJSON();
      assert.ok(typeof body === 'object' && body !== null);
      patches.push({
        path: new URL(request.url()).pathname,
        command: activityOverlayWriteSchema.parse({
          ...body,
          idempotencyKey: request.headers()['idempotency-key'],
        }),
      });
    });
    const url = `/activities?${new URLSearchParams({ search: prefix, sort: 'title_asc' })}`;
    await page.goto(url);
    await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();
    const batch = page.getByRole('region', { name: '선택 활동 일괄 계획 연결', exact: true });
    const reason = batch.getByRole('textbox', { name: '일괄 계획 연결 사유', exact: true });
    await reason.fill('선택한 활동을 확인한 계획에 연결');
    await reason.focus();
    for (const viewport of viewportFixtures) {
      await page.setViewportSize(viewport);
      await expect(reason).toHaveValue('선택한 활동을 확인한 계획에 연결');
      await expect(reason).toBeFocused();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await batch
      .getByRole('combobox', { name: '연결할 계획 세션', exact: true })
      .selectOption({ label: `일괄 연결 검증 세션 · 2019-06-02 · batch-session` });
    await batch.getByRole('button', { name: '계획 연결 변경 미리보기', exact: true }).click();
    const confirm = batch.getByRole('button', { name: '계획 연결 변경 확인', exact: true });
    await expect(confirm).toBeEnabled();
    await expect(batch).toContainText(saved.id);
    await expect(
      page.getByRole('button', { name: '선택 활동 삭제 미리보기', exact: true }),
    ).toBeDisabled();
    expect(patches).toEqual([]);
    for (const original of originals) expect(await read(original.id)).toEqual(original);
    const next = await savePlan(saved.id, `${prefix} next`);
    const corrected = await page.request.patch(`/bff/v1/activities/${stale.id}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedRevision: 1, title: `${prefix} B changed`, reason: '동시 정정 검증' },
    });
    expect(corrected.status()).toBe(200);
    let loseResponse = true;
    await page.route(`**/bff/v1/activities/${uncertain.id}`, async (route) => {
      if (route.request().method() === 'PATCH' && loseResponse) {
        loseResponse = false;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.abort('failed');
      } else await route.continue();
    });
    await confirm.click();
    const results = batch.getByRole('region', { name: '일괄 계획 연결 결과', exact: true });
    await expect(results).toContainText('수정 충돌');
    await expect(results).toContainText('결과 미확인');
    await batch.getByRole('button', { name: '미확인 계획 연결 다시 확인', exact: true }).click();
    await expect(
      batch.getByRole('button', { name: '미확인 계획 연결 다시 확인', exact: true }),
    ).toBeHidden();
    expect(patches).toHaveLength(4);
    expect(patches[2]).toEqual(patches[3]);
    const link = { planVersionId: saved.id, sessionId: 'batch-session' };
    for (const original of [first, uncertain]) {
      const linked = await read(original.id);
      expect(linked.revision).toBe(2);
      expect(linked.original).toEqual(original.original);
      expect(linked.effective).toEqual(original.effective);
      expect(linked.source).toEqual(original.source);
      expect(linked.userReport).toMatchObject({
        sessionRpe: original.userReport?.sessionRpe ?? null,
        rpeReportedAt: original.userReport?.rpeReportedAt ?? null,
        note: original.userReport?.note ?? null,
        planLink: link,
      });
    }
    expect((await read(stale.id)).userReport).toEqual(stale.userReport);
    const contextResponse = await page.request.get(`/bff/v1/activities/${first.id}/context`, {
      headers,
    });
    expect(activityContextSchema.parse(await contextResponse.json()).planContext).toMatchObject({
      status: 'linked',
      planVersion: { id: saved.id },
      currentPlanVersionId: next.id,
      // Block observations use its calendar bounds, independently from explicit link filtering.
      blockActual: { count: 3, distanceMeters: { value: 0, knownCount: 2, missingCount: 1 } },
    });
    const filterPath = `/bff/v1/activities?${new URLSearchParams({ linkedPlanVersionId: saved.id, linkedBlockId: 'batch-block' })}`;
    expect(
      activityListSchema.parse(await (await page.request.get(filterPath, { headers })).json())
        .total,
    ).toBe(2);
    expect(await summary()).toEqual(initialSummary);
    await batch.getByRole('button', { name: '계획 연결 결과 닫기', exact: true }).click();
    await page.getByRole('button', { name: '현재 페이지 선택', exact: true }).click();
    await batch
      .getByRole('combobox', { name: '일괄 계획 동작', exact: true })
      .selectOption('unlink');
    await reason.fill('명시적으로 계획 연결 해제');
    await batch.getByRole('button', { name: '계획 연결 변경 미리보기', exact: true }).click();
    await expect(confirm).toBeEnabled();
    await expect(batch).toContainText('이미 같은 연결: 변경하지 않음');
    await confirm.click();
    await expect(
      batch.getByRole('button', { name: '계획 연결 결과 닫기', exact: true }),
    ).toBeEnabled();
    expect(patches).toHaveLength(6);
    for (const original of originals) {
      const unlinked = await read(original.id);
      expect(unlinked.userReport).toMatchObject({
        planLink: null,
        sessionRpe: original.userReport?.sessionRpe ?? null,
        note: original.userReport?.note ?? null,
        rpeReportedAt: original.userReport?.rpeReportedAt ?? null,
      });
      expect(unlinked.revision).toBe(original.id === stale.id ? 2 : 3);
    }
    expect(
      activityListSchema.parse(await (await page.request.get(filterPath, { headers })).json())
        .total,
    ).toBe(0);
    expect(await summary()).toEqual(initialSummary);
    const head = planReadSchema.parse(
      await (await page.request.get('/bff/v1/plans/current', { headers })).json(),
    );
    expect(head.head).toEqual(next);

    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const other = await otherContext.newPage();
      const otherHeaders = await login(other, 'Bob');
      const denied = await other.request.post('/bff/v1/activities', {
        headers: { ...otherHeaders, 'idempotency-key': randomUUID() },
        data: {
          confirmed: true,
          activity: first.original,
          report: { sessionRpe: null, note: null, planLink: link },
        },
      });
      expect(denied.status()).toBe(400);
      expect(await denied.json()).toMatchObject({ error: { code: 'PLAN_LINK_INVALID' } });
    } finally {
      await otherContext.close();
    }
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    // The local fixture account and its immutable plan versions belong to this isolated E2E.
    const erased = await page.request.delete('/bff/v1/operations/account', {
      headers,
      data: { confirmation: 'DELETE MY ACCOUNT' },
    });
    expect(erased.status()).toBe(200);
  }
});
