import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import { jointCandidateV3Schema } from '../../packages/contracts/src/joint-coaching';
import {
  nutritionPlanReadSchema,
  nutritionPlanVersionSchema,
} from '../../packages/contracts/src/nutrition-core';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
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
  const value = (await response.json()) as { sessionId: string; csrfToken: string };
  const headers = {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': value.sessionId,
    'x-csrf-token': value.csrfToken,
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

test('reviews and applies one server-created training and nutrition candidate on web and mobile', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const headers = await login(page);
  const get = async (path: string) => {
    const reply = await page.request.get(path, { headers });
    expect(reply.status()).toBe(200);
    return reply.json();
  };
  const post = (path: string, data: unknown, key = randomUUID()) =>
    page.request.post(path, { headers: { ...headers, 'idempotency-key': key }, data });
  const consent = consentSchema.parse(await get('/bff/v1/consents/ai'));
  if (!consent.granted) {
    const granted = await page.request.put('/bff/v1/consents/ai', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { granted: true, expectedRevision: consent.revision },
    });
    expect(granted.status()).toBe(200);
  }
  const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const draft = planDraftSchema.parse({
    title: `Joint fixture source ${randomUUID()}`,
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'joint-session',
        blockId: 'block',
        date: '2080-01-03',
        localStartTime: '08:00',
        title: 'Joint source run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 5000,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
  const saved = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(saved.status()).toBe(200);
  const training = planSnapshotSchema.parse(await saved.json());
  const nutritionReply = await post('/bff/v1/nutrition/plans', {
    kind: 'create',
    confirmed: true,
    draft: {
      period: { from: '2080-01-01', toInclusive: '2080-01-31' },
      timezone: 'UTC',
      purpose: 'Joint fixture nutrition source',
      linkedTrainingPlanVersionId: training.id,
      items: [
        {
          id: 'joint-meal',
          category: 'meal',
          title: 'User meal',
          anchor: { kind: 'absolute', date: '2080-01-03', localTime: '10:00', timezone: 'UTC' },
          foods: [],
          targets: [],
          instructions: 'User note',
          evidenceIds: [],
          source: 'user_confirmed',
        },
      ],
    },
  });
  expect(nutritionReply.status()).toBe(200);
  const nutrition = nutritionPlanVersionSchema.parse(await nutritionReply.json());
  const threadReply = await post('/bff/v1/coaching-threads', {
    planVersionId: training.id,
    title: 'Joint fixture consultation',
    scope: { kind: 'phase', targetId: 'phase' },
    message: 'Review the current plan and nutrition together.',
  });
  expect(threadReply.status()).toBe(200);
  const { thread } = coachingMessageResultSchema.parse(await threadReply.json());
  const request = {
    threadId: thread.id,
    nutritionPlanId: nutrition.planId,
    expectedConversationRevision: thread.revision,
    window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
  };
  const key = randomUUID();
  const invalid = await post('/bff/v1/joint-fixture-candidates', { ...request, proposed: draft });
  expect(invalid.status()).toBe(400);
  const created = await post('/bff/v1/joint-fixture-candidates', request, key);
  expect(created.status(), JSON.stringify(await created.json())).toBe(200);
  const candidate = jointCandidateV3Schema.parse(await created.json());
  expect(candidate.writes.scope).toBe('combined');
  expect(candidate.validation.status).toBe('checked');
  const replay = await post('/bff/v1/joint-fixture-candidates', request, key);
  expect(replay.status()).toBe(200);
  expect(jointCandidateV3Schema.parse(await replay.json()).id).toBe(candidate.id);
  expect(planReadSchema.parse(await get('/bff/v1/plans/current')).head?.id).toBe(training.id);

  await page.goto(`/joint-proposals/${candidate.id}`);
  const review = page.getByRole('region', { name: '훈련·영양 공동 후보 검토' });
  await expect(review).toContainText('훈련과 영양 변경');
  await expect(review).toContainText('Joint fixture nutrition source');
  await expect(review.getByRole('button', { name: '이 후보 전체 승인' })).toBeDisabled();
  const confirmation = review.getByRole('checkbox', {
    name: '이 후보의 훈련·영양 변경과 근거를 확인했습니다.',
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
  await review.getByRole('button', { name: '이 후보 전체 승인' }).click();
  await expect(review).toContainText('원자적 적용을 확인했습니다');
  const applied = planReadSchema.parse(await get('/bff/v1/plans/current'));
  expect(applied.head?.version).toBe(training.version + 1);
  const nutritionAfter = nutritionPlanReadSchema.parse(
    await get(`/bff/v1/nutrition/plans/${nutrition.planId}`),
  );
  expect(nutritionAfter.head?.version).toBe(nutrition.version + 1);
  await page.goto(`http://127.0.0.1:4200/joint-proposals/${candidate.id}`);
  await expect(page.getByRole('region', { name: '훈련·영양 공동 후보 검토' })).toContainText(
    '훈련과 영양 변경',
  );
});
