import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activityContextSchema } from '../../packages/contracts/src/activity-context';
import { manualActivityResultSchema } from '../../packages/contracts/src/activity';
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

test('activity context preserves linked historical plan and separates block observations with ownership and deletion', async ({
  page,
  browser,
}) => {
  const headers = await login(page, 'Alice');
  const currentResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(currentResponse.status()).toBe(200);
  const current = planReadSchema.parse(await currentResponse.json());
  const draft = planDraftSchema.parse({
    title: `Synthetic context ${randomUUID()}`,
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `context-${level}`,
      parentId: index === 0 ? null : `context-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2018-02-01',
      endDateExclusive: '2018-02-11',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'context-session',
        blockId: 'context-block',
        date: '2018-02-02',
        localStartTime: null,
        title: 'Synthetic planned context',
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
  try {
    const savedResponse = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: current.head?.id ?? null,
        draft,
      },
    });
    expect(savedResponse.status()).toBe(200);
    const saved = planSnapshotSchema.parse(await savedResponse.json());
    const create = async (date: string, distanceMeters: number | null) => {
      const response = await page.request.post('/bff/v1/activities', {
        headers: { ...headers, 'idempotency-key': randomUUID() },
        data: {
          confirmed: true,
          activity: {
            title: `Synthetic context actual ${date}`,
            kind: 'running',
            startedAt: `${date}T08:00:00+09:00`,
            timezone: 'Asia/Seoul',
            distanceMeters,
            durationSeconds: null,
            durationKind: 'timer',
          },
          report: {
            sessionRpe: 0,
            note: null,
            planLink: { planVersionId: saved.id, sessionId: 'context-session' },
          },
        },
      });
      expect(response.status()).toBe(200);
      return manualActivityResultSchema.parse(await response.json());
    };
    const zero = await create('2018-02-02', 0);
    await create('2018-02-03', null);
    const outside = await create('2018-02-12', 300);
    const nextResponse = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: saved.id,
        draft: {
          ...draft,
          title: 'Synthetic newer context plan',
          sessions: [{ ...draft.sessions[0], distanceMeters: 5000 }],
        },
      },
    });
    expect(nextResponse.status()).toBe(200);
    const next = planSnapshotSchema.parse(await nextResponse.json());
    const read = async (id: string) => {
      const response = await page.request.get(`/bff/v1/activities/${id}/context`, { headers });
      expect(response.status()).toBe(200);
      return activityContextSchema.parse(await response.json());
    };
    const context = await read(zero.activityId);
    expect(context.planContext.status).toBe('linked');
    assert.ok(context.planContext.status === 'linked');
    expect(context.planContext.planVersion.id).toBe(saved.id);
    expect(context.planContext.currentPlanVersionId).toBe(next.id);
    expect(context.planContext.distanceComparison).toEqual({
      actual: 0,
      planned: 0,
      delta: 0,
      status: 'available',
    });
    expect(context.planContext.durationComparison).toMatchObject({
      actual: null,
      planned: 600,
      delta: null,
      status: 'not_comparable',
    });
    expect(context.planContext.blockActual).toMatchObject({
      count: 2,
      distanceMeters: { value: 0, knownCount: 1, missingCount: 1 },
      sources: { manual: 2 },
      durationSeconds: { timer: { value: null, knownCount: 0, missingCount: 2 } },
    });
    expect((await read(outside.activityId)).planContext).toMatchObject({
      status: 'linked',
      blockMembership: 'outside',
      blockActual: { count: 2 },
    });
    await page.goto(`/activities?selected=${zero.activityId}&detailTab=impact`);
    const panel = page.getByRole('region', { name: '계획 연결과 관측 영향', exact: true });
    await expect(panel).toContainText(
      '과거 계획 버전에 연결되어 있습니다. 현재 계획으로 대체하지 않습니다.',
    );
    await expect(panel).toContainText('계획 시간의 측정 정의가 없어 시간을 비교할 수 없습니다.');
    await page.goto(`/activities?selected=${outside.activityId}&detailTab=impact`);
    await expect(panel).toContainText('이 활동은 연결 Block의 날짜 범위 밖에 있어');
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const other = await otherContext.newPage();
      const otherHeaders = await login(other, 'Bob');
      expect(
        (
          await other.request.get(`/bff/v1/activities/${zero.activityId}/context`, {
            headers: otherHeaders,
          })
        ).status(),
      ).toBe(404);
    } finally {
      await otherContext.close();
    }
    expect(
      (
        await page.request.delete(`/bff/v1/activities/${zero.activityId}`, {
          headers,
          data: { expectedRevision: zero.revision },
        })
      ).status(),
    ).toBe(204);
    expect(
      (
        await page.request.get(`/bff/v1/activities/${zero.activityId}/context`, { headers })
      ).status(),
    ).toBe(404);
    const remaining = await read(outside.activityId);
    expect(remaining.planContext).toMatchObject({
      status: 'linked',
      blockActual: { count: 1, distanceMeters: { value: null, knownCount: 0, missingCount: 1 } },
    });
  } finally {
    // Isolated local OIDC/PostgreSQL harness only: Alice is synthetic, never an external user.
    // Remove fixture plan versions so later journeys can start at version 1.
    const erased = await page.request.delete('/bff/v1/operations/account', {
      headers,
      data: { confirmation: 'DELETE MY ACCOUNT' },
    });
    expect(erased.status()).toBe(200);
    expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
  }
});
