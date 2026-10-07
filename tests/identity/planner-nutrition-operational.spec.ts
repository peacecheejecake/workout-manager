import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { identityMobileOrigin, identityWebOrigin } from '../../scripts/fixtures/identity-ports';
import { grantAppProcessingForScenario } from './app-consent-prerequisite';
import { integratedPlannerReadV5Schema } from '../../packages/contracts/src/integrated-planner';
import { nutritionPlanVersionSchema } from '../../packages/contracts/src/nutrition-core';
import { nutritionPlanVersionV4Schema } from '../../packages/contracts/src/nutrition-race-plan-v4';
import { planDraftSchema, planSnapshotSchema } from '../../packages/contracts/src/planning';

// Root executes Playwright. Authentication, host lifetime and normal plan/app seeds
// use the real synthetic IdP/API. ONLY integrated GET transport is mocked below.
// This is browser rendering/cache acceptance, not a public V4 write/deletion E2E,
// persisted disconnected plan or source-authentication evidence.
function parseSession(value: unknown) {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      'csrfToken' in value &&
      typeof value.csrfToken === 'string' &&
      value.csrfToken.length > 0,
  );
  return { sessionId: value.sessionId, csrfToken: value.csrfToken };
}
type Headers = { origin: string; 'x-workout-session-id': string; 'x-csrf-token': string };
const cleanup = new WeakMap<Page, Headers>();
async function login(page: Page, origin: string, user: 'Alice' | 'Bob') {
  await page.goto(`${origin}/account`);
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${user}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get(`${origin}/bff/v1/session`);
  expect(response.status()).toBe(200);
  const session = parseSession(await response.json());
  const headers = {
    origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
  cleanup.set(page, headers);
  await grantAppProcessingForScenario(page);
  return headers;
}
async function erase(page: Page, headers: Headers) {
  const response = await page.request.delete(`${headers.origin}/bff/v1/operations/account`, {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(response.status()).toBe(200);
  cleanup.delete(page);
}
test.afterEach(async ({ page }) => {
  const headers = cleanup.get(page);
  if (headers) await erase(page, headers);
});
const unknown = <T extends string>(unit: T) => ({
  value: null,
  unit,
  status: 'unknown' as const,
  evidenceIds: [],
});
const metric = { value: null, knownCount: 0, missingCount: 0 };
const emptySummary = {
  training: {
    plannedSessionCount: 0,
    actualActivityCount: 0,
    supplementaryActivityCount: 0,
    distanceMeters: metric,
    durationSeconds: { timer: metric, elapsed: metric, moving: metric, unknown: metric },
  },
  nutrition: {
    plannedItemCount: 0,
    intakeCount: 0,
    intakeCoverage: 'unknown',
    nutrients: {
      energyKcal: metric,
      carbohydrateGrams: metric,
      proteinGrams: metric,
      fatGrams: metric,
      fluidMl: metric,
      sodiumMg: metric,
    },
  },
};
function nextDate(day: string) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}
async function seed(page: Page, headers: Headers, day: string) {
  const draft = planDraftSchema.parse({
    title: 'Synthetic operational baseline',
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `operational-${level}`,
      parentId: index === 0 ? null : `operational-${levels[index - 1]}`,
      level,
      title: level,
      startDate: day,
      endDateExclusive: nextDate(day),
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [],
  });
  const training = await page.request.put(`${headers.origin}/bff/v1/plans/current`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: null, draft },
  });
  expect(training.status()).toBe(200);
  const plan = planSnapshotSchema.parse(await training.json());
  const nutrition = await page.request.post(`${headers.origin}/bff/v1/nutrition/plans`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      kind: 'create',
      confirmed: true,
      draft: {
        period: { from: day, toInclusive: day },
        timezone: 'UTC',
        purpose: 'Synthetic browser baseline',
        linkedTrainingPlanVersionId: plan.id,
        items: [
          {
            id: 'meal',
            category: 'meal',
            title: 'Baseline meal',
            anchor: { kind: 'absolute', date: day, localTime: null, timezone: 'UTC' },
            foods: [
              {
                foodVersionId: null,
                description: 'Retained zero',
                quantity: 0,
                unit: 'g',
                sourceBasis: 'manual_total',
              },
              {
                foodVersionId: null,
                description: 'Retained unknown',
                quantity: null,
                unit: 'unspecified',
                sourceBasis: 'unknown',
              },
            ],
            targets: [],
            instructions: 'Baseline only',
            evidenceIds: [],
            source: 'user_confirmed',
          },
        ],
      },
    },
  });
  expect(nutrition.status()).toBe(200);
  return { plan, nutrition: nutritionPlanVersionSchema.parse(await nutrition.json()) };
}
function fixture(
  day: string,
  saved: Awaited<ReturnType<typeof seed>>,
  title: string,
  suspended: boolean,
) {
  // Local strict V4 structural sample, never written through the V1 API above.
  const v4 = nutritionPlanVersionV4Schema.parse({
    ...saved.nutrition,
    schemaVersion: 4,
    items: saved.nutrition.items.map((item) => ({
      ...item,
      title,
      anchor: { kind: 'disconnected', entity: 'race' },
    })),
    raceTimingPins: [],
    itemRaceTimingBindings: [],
  });
  expect(v4.items[0]?.foods.map((food) => food.quantity)).toEqual([0, null]);
  return integratedPlannerReadV5Schema.parse({
    schemaVersion: 5,
    from: day,
    toExclusive: nextDate(day),
    timezone: 'UTC',
    trainingPlanVersionId: saved.plan.id,
    nutritionPlanVersionIds: [v4.versionId],
    recoveryStrategyVersionIds: [],
    routineScheduleVersionIds: [],
    days: [
      {
        date: day,
        plannedSessions: [],
        nutritionItems: [],
        activities: [],
        intakes: [
          {
            intakeId: 'synthetic-retained-zero',
            revision: 1,
            occurredAt: `${day}T08:00:00Z`,
            nutrientTotal: {
              energy: { value: 0, unit: 'kcal', status: 'reported', evidenceIds: [] },
              carbohydrate: unknown('g'),
              protein: unknown('g'),
              fat: unknown('g'),
              fluid: unknown('mL'),
              sodium: unknown('mg'),
            },
          },
          {
            intakeId: 'synthetic-retained-unknown',
            revision: 1,
            occurredAt: `${day}T09:00:00Z`,
            nutrientTotal: {
              energy: unknown('kcal'),
              carbohydrate: unknown('g'),
              protein: unknown('g'),
              fat: unknown('g'),
              fluid: unknown('mL'),
              sodium: unknown('mg'),
            },
          },
        ],
        recoveryPlans: [],
        recoveryActions: [],
        routineOccurrences: [],
        routineRuns: [],
        stretchingActivityIds: [],
        summary: {
          ...emptySummary,
          nutrition: {
            ...emptySummary.nutrition,
            intakeCount: 2,
            intakeCoverage: 'unknown',
            nutrients: {
              ...emptySummary.nutrition.nutrients,
              energyKcal: { value: 0, knownCount: 1, missingCount: 1 },
            },
          },
        },
      },
    ],
    unresolvedNutritionItems: [
      {
        id: 'meal',
        planVersionId: v4.versionId,
        title,
        category: 'meal',
        source: 'user_confirmed',
        reason: 'missing_anchor',
      },
    ],
    nutritionOperationalStates: [
      {
        planVersionId: v4.versionId,
        itemId: 'meal',
        ...(suspended
          ? { state: 'suspended', reason: 'race_disconnected' }
          : { state: 'unresolved', reason: 'legacy_unpinned' }),
      },
    ],
    unplacedActivityCount: 0,
    summary: {
      ...emptySummary,
      nutrition: {
        ...emptySummary.nutrition,
        intakeCount: 2,
        intakeCoverage: 'unknown',
        nutrients: {
          ...emptySummary.nutrition.nutrients,
          energyKcal: { value: 0, knownCount: 1, missingCount: 1 },
        },
      },
      recovery: { plannedStrategyCount: 0, actualActionCount: 0 },
      routines: { occurrenceCount: 0, runCount: 0 },
      stretchingActivityCount: 0,
    },
  });
}
for (const [host, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${host}: mocked strict V5 disconnected rendering, responsive reflow and actual account lifetime reset`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    const day = new Date(Date.now() - 3600000).toISOString().slice(0, 10),
      privateSourceId = randomUUID();
    const alice = await login(page, origin, 'Alice'),
      saved = await seed(page, alice, day);
    const aliceTitle = `보존 식사 ${randomUUID()}`,
      bobTitle = `별도 미해결 식사 ${randomUUID()}`;
    let response = fixture(day, saved, aliceTitle, true),
      activeSession = alice['x-workout-session-id'];
    const requests: { session: string; version: string | null }[] = [];
    await page.route(
      (url) => url.origin === origin && url.pathname === '/bff/v1/planner/integrated',
      async (route) => {
        expect(route.request().method()).toBe('GET');
        const url = new URL(route.request().url()),
          session = route.request().headers()['x-workout-session-id'];
        expect(session).toBe(activeSession);
        expect(url.searchParams.get('maxSchemaVersion')).toBe('5');
        expect(url.searchParams.get('from')).toBe(day);
        expect(url.searchParams.get('toExclusive')).toBe(nextDate(day));
        requests.push({
          session: activeSession,
          version: url.searchParams.get('maxSchemaVersion'),
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(response),
        });
      },
    );
    const planner = `${origin}/planner?lens=calendar&from=${day}&to=${nextDate(day)}`;
    await page.goto(planner);
    const panel = page.getByRole('region', { name: '통합 Planner' }),
      unresolved = panel.getByRole('region', { name: '날짜 미해결 영양 계획' });
    await expect(unresolved).toContainText(aliceTitle);
    await expect(unresolved.getByRole('status')).toContainText('대회 연결 해제');
    await expect(unresolved).toContainText('대회 유래 시각 사용이 중단되었습니다');
    await expect(unresolved).toContainText('음식·수량과 실제 섭취 기록은 유지됩니다');
    await expect(unresolved).toContainText(
      '재연결·재승인 전까지 저장된 대회 시각을 사용하지 않습니다',
    );
    await expect(panel.getByRole('region', { name: `${day} 영양 계획` })).not.toContainText(
      aliceTitle,
    );
    await expect(unresolved.getByRole('button', { name: /재연결|승인/ })).toHaveCount(0);
    await expect(unresolved).not.toContainText(/승인 완료|연결 완료|08:00|09:00/);
    const actual = panel.getByRole('region', { name: `${day} 섭취 실제` });
    await expect(actual).toContainText('에너지 0 kcal');
    await expect(actual).toContainText('에너지 미상');
    await expect(panel).not.toContainText(saved.nutrition.versionId);
    await expect(panel).not.toContainText(privateSourceId);
    for (const width of [320, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(unresolved.getByRole('status')).toBeVisible();
      expect(
        await page.evaluate(() => ({
          root: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
          viewport: innerWidth,
        })),
      ).toMatchObject({ viewport: width });
      expect(
        await page.evaluate(
          () =>
            Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(
      requests.some((request) => request.session === activeSession && request.version === '5'),
    ).toBe(true);
    // Actual account erasure ends Alice's session. No fake callback/cache reset.
    await erase(page, alice);
    await page.goto(planner);
    await expect(page.getByText(aliceTitle, { exact: false })).toHaveCount(0);
    const bob = await login(page, origin, 'Bob'),
      other = await seed(page, bob, day);
    expect(bob['x-workout-session-id']).not.toBe(alice['x-workout-session-id']);
    activeSession = bob['x-workout-session-id'];
    response = fixture(day, other, bobTitle, false);
    await page.goto(planner);
    await expect(unresolved).toContainText(bobTitle);
    await expect(unresolved).toContainText('이전 계획의 시각 근거가 고정되지 않았습니다');
    await expect(unresolved).toContainText('시각은 미해결 상태');
    await expect(panel).not.toContainText(aliceTitle);
    await expect(unresolved).not.toContainText('대회 연결 해제');
    expect(
      requests.some((request) => request.session === activeSession && request.version === '5'),
    ).toBe(true);
  });
}
