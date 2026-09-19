import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import { coreEvidenceSnapshotSchema } from '../../packages/contracts/src/evidence-snapshots';
import {
  integratedApprovalResultV4Schema,
  integratedCandidateV4Schema,
} from '../../packages/contracts/src/integrated-coaching';
import { integratedPlannerReadV4Schema } from '../../packages/contracts/src/integrated-planner';
import {
  nutritionPlanReadSchema,
  nutritionPlanVersionSchema,
} from '../../packages/contracts/src/nutrition-core';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { recoveryWorkspaceReadSchema } from '../../packages/contracts/src/recovery-core';
import { routineBlueprintReadSchema } from '../../packages/contracts/src/routine-commands';
import { consentSchema } from '../../apps/api/src/ports';

type Headers = {
  origin: string;
  'x-workout-session-id': string;
  'x-csrf-token': string;
};
const cleanup = new WeakMap<Page, Headers>();

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session = (await response.json()) as { sessionId: string; csrfToken: string };
  const headers = {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
  cleanup.set(page, headers);
  return headers;
}

test.afterEach(async ({ page }) => {
  const headers = cleanup.get(page);
  if (!headers) return;
  cleanup.delete(page);
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
});

test('reviews and atomically applies one server-owned four-domain candidate on web and mobile', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const headers = await login(page);
  const post = (path: string, data: unknown, key = randomUUID()) =>
    page.request.post(path, { headers: { ...headers, 'idempotency-key': key }, data });
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status(), path).toBe(200);
    return response.json();
  };

  const consent = consentSchema.parse(await get('/bff/v1/consents/ai'));
  if (!consent.granted) {
    const granted = await page.request.put('/bff/v1/consents/ai', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { granted: true, expectedRevision: consent.revision },
    });
    expect(granted.status()).toBe(200);
  }

  const day = '2080-01-03';
  const toExclusive = '2080-01-04';
  const draft = planDraftSchema.parse({
    title: `Integrated v4 source ${randomUUID()}`,
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: day,
      endDateExclusive: toExclusive,
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [],
  });
  const savedPlan = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: null, draft },
  });
  expect(savedPlan.status()).toBe(200);
  const training = planSnapshotSchema.parse(await savedPlan.json());

  const savedNutrition = await post('/bff/v1/nutrition/plans', {
    kind: 'create',
    confirmed: true,
    draft: {
      period: { from: day, toInclusive: day },
      timezone: 'UTC',
      purpose: 'Integrated v4 source nutrition',
      linkedTrainingPlanVersionId: training.id,
      items: [],
    },
  });
  expect(savedNutrition.status()).toBe(200);
  const nutrition = nutritionPlanVersionSchema.parse(await savedNutrition.json());

  const routineId = randomUUID();
  const routineVersionId = randomUUID();
  const savedRoutine = await post('/bff/v1/routines', {
    blueprint: {
      schemaVersion: 4,
      routineId,
      versionId: routineVersionId,
      title: 'Integrated fixture routine',
      intent: 'E2E review only',
      status: 'published',
      tags: ['fixture'],
      steps: [
        {
          id: randomUUID(),
          title: 'Check readiness',
          content: { kind: 'checklist', prompt: 'Confirm only when reviewed.' },
          timing: { kind: 'ordered', afterStepId: null },
          required: true,
          choiceGroupId: null,
        },
      ],
      choiceGroups: [],
      estimatedDurationSeconds: null,
      createdAt: new Date().toISOString(),
    },
    expectedVersionId: null,
    confirmed: true,
  });
  expect(savedRoutine.status()).toBe(200);
  const routine = routineBlueprintReadSchema.parse(await savedRoutine.json());

  const threadReply = await post('/bff/v1/coaching-threads', {
    planVersionId: training.id,
    title: 'Integrated v4 fixture consultation',
    scope: { kind: 'phase', targetId: 'phase' },
    message: 'Review all four plan domains together.',
  });
  expect(threadReply.status()).toBe(200);
  const { thread } = coachingMessageResultSchema.parse(await threadReply.json());
  const window = { from: day, toExclusive, timezone: 'UTC' } as const;
  const snapshotReply = await post(`/bff/v1/coaching-threads/${thread.id}/evidence-snapshots`, {
    expectedConversationRevision: thread.revision,
    window,
  });
  expect(snapshotReply.status()).toBe(200);
  const snapshot = coreEvidenceSnapshotSchema.parse(await snapshotReply.json());
  expect(snapshot.status).toBe('available');

  const recoveryStrategyId = randomUUID();
  const routineScheduleId = randomUUID();
  const fixtureRequest = {
    threadId: thread.id,
    evidenceSnapshotId: snapshot.id,
    expectedConversationRevision: thread.revision,
    trainingPlanVersionId: training.id,
    nutritionPlanId: nutrition.planId,
    nutritionPlanVersionId: nutrition.versionId,
    routineBlueprintId: routine.blueprint.routineId,
    routineBlueprintVersionId: routine.blueprint.versionId,
    recoveryStrategyId,
    routineScheduleId,
    window,
  };
  const fixtureKey = randomUUID();
  const candidateReply = await post(
    '/bff/v1/integrated-fixture-v4-candidates',
    fixtureRequest,
    fixtureKey,
  );
  expect(candidateReply.status(), JSON.stringify(await candidateReply.json())).toBe(200);
  const candidate = integratedCandidateV4Schema.parse(await candidateReply.json());
  expect(candidate.writes.map((write) => write.domain)).toEqual([
    'training',
    'nutrition',
    'recovery',
    'routine_schedule',
  ]);
  const replay = await post('/bff/v1/integrated-fixture-v4-candidates', fixtureRequest, fixtureKey);
  expect(replay.status()).toBe(200);
  expect(integratedCandidateV4Schema.parse(await replay.json()).id).toBe(candidate.id);

  await page.goto(`/integrated-proposals/${candidate.id}`);
  let review = page.getByRole('region', { name: '네 도메인 통합 후보 검토' });
  await expect(review).toContainText('훈련');
  await expect(review).toContainText('영양');
  await expect(review).toContainText('회복');
  await expect(review).toContainText('루틴 일정');
  await page.goto(`http://127.0.0.1:4200/integrated-proposals/${candidate.id}`);
  await expect(page.getByRole('region', { name: '네 도메인 통합 후보 검토' })).toContainText(
    '네 도메인 변경',
  );
  await page.goto(`http://127.0.0.1:3100/integrated-proposals/${candidate.id}`);
  review = page.getByRole('region', { name: '네 도메인 통합 후보 검토' });
  const approve = review.getByRole('button', { name: '네 도메인 변경 승인' });
  await expect(approve).toBeDisabled();
  const confirmation = review.getByRole('checkbox', {
    name: '이 후보의 훈련·영양·회복·루틴 일정 변경과 근거를 확인했습니다.',
  });
  await confirmation.focus();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(confirmation).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await confirmation.check();
  const approvalResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/bff/v1/integrated-candidates/${candidate.id}/approve` &&
      response.request().method() === 'POST',
  );
  await approve.click();
  const approvedReply = await approvalResponse;
  expect(approvedReply.status()).toBe(200);
  const approved = integratedApprovalResultV4Schema.parse(await approvedReply.json());
  expect(approved.versions).toHaveLength(4);
  await expect(review).toContainText('네 도메인 계획의 원자적 적용을 확인했습니다');
  await expect(review).toContainText('루틴 발생분 1건');

  expect(planReadSchema.parse(await get('/bff/v1/plans/current')).head?.version).toBe(
    training.version + 1,
  );
  expect(
    nutritionPlanReadSchema.parse(await get(`/bff/v1/nutrition/plans/${nutrition.planId}`)).head
      ?.version,
  ).toBe(nutrition.version + 1);
  const recovery = recoveryWorkspaceReadSchema.parse(await get('/bff/v1/recovery'));
  expect(recovery.strategies).toContainEqual(
    expect.objectContaining({ strategyId: recoveryStrategyId, status: 'user_confirmed' }),
  );
  expect(recovery.actions).toEqual([]);

  const plannerQuery = new URLSearchParams({ ...window, maxSchemaVersion: '4' });
  const planner = integratedPlannerReadV4Schema.parse(
    await get(`/bff/v1/planner/integrated?${plannerQuery}`),
  );
  expect(planner.summary.recovery).toEqual({ plannedStrategyCount: 1, actualActionCount: 0 });
  expect(planner.summary.routines).toEqual({ occurrenceCount: 1, runCount: 0 });

  await page.goto(`/planner?lens=calendar&from=${day}&to=${toExclusive}`);
  const plannerPanel = page.getByRole('region', { name: '통합 Planner' });
  await expect(plannerPanel).toContainText('Integrated fixture recovery');
  await expect(plannerPanel).toContainText('발생분 1건');
  await expect(plannerPanel).toContainText('RoutineRun은 실제 기록을 연결하는 wrapper');
});
