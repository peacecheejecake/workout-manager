import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

import { manualActivityResultSchema } from '../../packages/contracts/src/activity';
import { integratedPlannerReadSchema } from '../../packages/contracts/src/integrated-planner';
import { nutritionPlanDraftSchema } from '../../packages/contracts/src/nutrition-core';
import { planDraftSchema, planSnapshotSchema } from '../../packages/contracts/src/planning';
import { supplementaryExecutionSchema } from '../../packages/contracts/src/supplementary-core';

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
  const erased = await page.request.delete('http://127.0.0.1:3100/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
});

const unknown = <U extends string>(unit: U) => ({
  value: null,
  unit,
  status: 'unknown' as const,
  evidenceIds: [],
});
function nextDate(date: string) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

test('integrated Planner shows approved plans and one canonical actual per ledger on web and mobile', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const headers = await login(page);
  const marker = randomUUID();
  const occurredAt = new Date(Date.now() - 3_600_000).toISOString();
  const day = occurredAt.slice(0, 10);
  const toExclusive = nextDate(day);
  const post = (path: string, data: unknown) =>
    page.request.post(path, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data,
    });
  const draft = planDraftSchema.parse({
    title: `Integrated training ${marker}`,
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `integrated-${level}`,
      parentId: index === 0 ? null : `integrated-${levels[index - 1]}`,
      level,
      title: level,
      startDate: day,
      endDateExclusive: toExclusive,
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'strength-session',
        blockId: 'integrated-block',
        date: day,
        localStartTime: '08:00',
        title: `Planned strength ${marker}`,
        sport: 'strength',
        durationSeconds: null,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
  const planResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: null, draft },
  });
  expect(planResponse.status()).toBe(200);
  const plan = planSnapshotSchema.parse(await planResponse.json());
  const nutritionDraft = nutritionPlanDraftSchema.parse({
    period: { from: day, toInclusive: day },
    timezone: 'UTC',
    purpose: 'Synthetic integrated Planner',
    linkedTrainingPlanVersionId: plan.id,
    items: [
      {
        id: 'meal',
        category: 'meal',
        title: `Planned meal ${marker}`,
        anchor: { kind: 'absolute', date: day, localTime: null, timezone: 'UTC' },
        foods: [],
        targets: [],
        instructions: 'User confirmed meal',
        evidenceIds: [],
        source: 'user_confirmed',
      },
      {
        id: 'unresolved',
        category: 'after',
        title: `Unresolved fuel ${marker}`,
        anchor: {
          kind: 'relative',
          entity: 'session',
          entityId: 'strength-session',
          point: 'end',
          offsetMinutes: 0,
        },
        foods: [],
        targets: [],
        instructions: 'Await duration',
        evidenceIds: [],
        source: 'user_confirmed',
      },
    ],
  });
  const nutrition = await post('/bff/v1/nutrition/plans', {
    kind: 'create',
    confirmed: true,
    draft: nutritionDraft,
  });
  expect(nutrition.status()).toBe(200);
  const activity = await post('/bff/v1/activities', {
    confirmed: true,
    activity: {
      title: `Actual strength ${marker}`,
      kind: 'strength',
      startedAt: occurredAt,
      timezone: 'UTC',
      durationSeconds: 0,
      durationKind: 'timer',
      distanceMeters: null,
    },
    report: { sessionRpe: null, note: null, planLink: null },
  });
  expect(activity.status()).toBe(200);
  const activityId = manualActivityResultSchema.parse(await activity.json()).activityId;
  const execution = await post('/bff/v1/supplementary/executions', {
    schemaVersion: 2,
    executionId: randomUUID(),
    plannedSession: null,
    activity: { kind: 'match_existing', activityId },
    confirmed: true,
  });
  expect(execution.status()).toBe(200);
  expect(supplementaryExecutionSchema.parse(await execution.json()).activityId).toBe(activityId);
  const intake = await post('/bff/v1/nutrition/intakes', {
    intakeId: `intake-${marker}`,
    confirmed: true,
    occurredAt,
    timezone: 'UTC',
    foods: [
      {
        foodVersionId: null,
        description: 'Synthetic snack',
        quantity: null,
        unit: 'unspecified',
        sourceBasis: 'manual_total',
      },
    ],
    nutrientTotal: {
      energy: { value: 0, unit: 'kcal', status: 'reported', evidenceIds: [] },
      carbohydrate: unknown('g'),
      protein: unknown('g'),
      fat: unknown('g'),
      fluid: unknown('mL'),
      sodium: unknown('mg'),
    },
    plannedItemId: 'meal',
    relatedSessionIds: ['strength-session'],
    relatedActivityIds: [activityId],
    source: 'user',
    sourceRecordId: null,
    notes: null,
  });
  expect(intake.status()).toBe(200);
  const query = new URLSearchParams({ from: day, toExclusive, timezone: 'UTC' });
  const readResponse = await page.request.get(`/bff/v1/planner/integrated?${query}`, { headers });
  expect(readResponse.status()).toBe(200);
  const read = integratedPlannerReadSchema.parse(await readResponse.json());
  expect(read.summary.training).toMatchObject({
    plannedSessionCount: 1,
    actualActivityCount: 1,
    supplementaryActivityCount: 1,
  });
  expect(read.summary.nutrition).toMatchObject({ plannedItemCount: 1, intakeCount: 1 });
  expect(read.unresolvedNutritionItems).toContainEqual(
    expect.objectContaining({ id: 'unresolved', reason: 'missing_session_duration' }),
  );

  const plannerUrl = `/planner?lens=calendar&from=${day}&to=${toExclusive}`;
  await page.goto(plannerUrl);
  const panel = page.getByRole('region', { name: '통합 Planner' });
  await expect(panel).toContainText(`Planned strength ${marker}`);
  await expect(panel).toContainText(`Actual strength ${marker}`);
  await expect(panel).toContainText(`Planned meal ${marker}`);
  await expect(panel).toContainText('실제 Activity 1건 (세트 상세 연결 1건)');
  await expect(panel.getByRole('region', { name: `${day} 섭취 실제` })).toContainText('0 kcal');
  await expect(panel.getByRole('region', { name: '날짜 미해결 영양 계획' })).toContainText(
    '세션 종료 시각 미정',
  );
  const sessionButton = panel.getByRole('button', { name: `Planned strength ${marker}` });
  await sessionButton.focus();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sessionButton).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.goto(`http://127.0.0.1:4200${plannerUrl}`);
  const mobilePanel = page.getByRole('region', { name: '통합 Planner' });
  await expect(mobilePanel).toContainText(`Planned meal ${marker}`);
  await expect(mobilePanel).toContainText('실제 Activity 1건 (세트 상세 연결 1건)');
});
