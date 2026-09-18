import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activitySchema, manualActivityResultSchema } from '../../packages/contracts/src/activity';
import {
  stretchingExerciseReadSchema,
  stretchLogReadSchema,
} from '../../packages/contracts/src/stretching';

type Headers = {
  origin: string;
  'x-workout-session-id': string;
  'x-csrf-token': string;
};
const cleanup = new WeakMap<Page, Headers>();

async function login(page: Page): Promise<Headers> {
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
  const response = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(response.status()).toBe(200);
});

test('S34 keeps side-specific holds and precise correction times under one Activity', async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(8_000);
  const headers = await login(page);
  const marker = randomUUID();
  const exerciseName = `Synthetic stretch ${marker}`;
  const activityName = `Synthetic stretch Activity ${marker}`;

  await page.goto('/stretching');
  const workspace = page.getByRole('region', { name: '스트레칭 작업 공간' });
  await workspace.getByRole('button', { name: '동작 추가' }).click();
  const exerciseForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '스트레칭 동작 추가' }),
  });
  await exerciseForm.getByRole('textbox', { name: '이름', exact: true }).fill(exerciseName);
  await exerciseForm.getByRole('textbox', { name: '부위 (쉼표 구분)' }).fill('hip');
  await exerciseForm.getByRole('combobox', { name: '좌우 기준' }).selectOption('per_side');
  await exerciseForm
    .getByRole('textbox', { name: '텍스트 수행 설명' })
    .fill('Synthetic static hold.');
  const createdExercise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/bff/v1/stretching/exercises' &&
      response.request().method() === 'POST',
  );
  await exerciseForm.getByRole('button', { name: '확인하고 버전 저장' }).click();
  const exerciseResponse = await createdExercise;
  expect(exerciseResponse.status()).toBe(200);
  const exercise = stretchingExerciseReadSchema.parse(await exerciseResponse.json());
  expect(exercise.profile).toMatchObject({ method: 'static_hold', sideBasis: 'per_side' });

  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const localTime = (offsetMinutes: number) => {
    const instant = new Date(Date.parse(startedAt) + offsetMinutes * 60_000);
    return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  };
  const activityResponse = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      confirmed: true,
      activity: {
        title: activityName,
        kind: 'other',
        startedAt,
        timezone: 'UTC',
        distanceMeters: null,
        durationSeconds: 300,
        durationKind: 'elapsed',
      },
      report: { sessionRpe: null, note: null, planLink: null },
    },
  });
  expect(activityResponse.status()).toBe(200);
  const activityId = manualActivityResultSchema.parse(await activityResponse.json()).activityId;
  const activityBeforeResponse = await page.request.get(`/bff/v1/activities/${activityId}`, {
    headers,
  });
  const activityBefore = activitySchema.parse(await activityBeforeResponse.json());

  await page.goto(
    `/stretching/exercises/${exercise.definition.exerciseId}?activityId=${activityId}`,
  );
  await expect(workspace.getByRole('heading', { name: exerciseName })).toBeVisible();
  const logForm = workspace.locator('form').filter({ hasText: '새 기록' });
  await logForm.getByRole('combobox', { name: '수행 상태' }).selectOption('performed');
  await logForm.getByRole('combobox', { name: '좌우·전체' }).selectOption('left');
  await logForm.getByRole('spinbutton', { name: '확인한 유지시간 (초)' }).fill('20');
  await logForm.getByLabel('수행 시각').fill(localTime(0));
  const createdLog = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/bff/v1/stretching/logs' &&
      response.request().method() === 'POST',
  );
  await logForm.getByRole('button', { name: '실제 수행 확인·저장' }).click();
  const leftResponse = await createdLog;
  expect(leftResponse.status()).toBe(200);
  const left = stretchLogReadSchema.parse(await leftResponse.json());
  expect(left.status).toBe('active');
  if (left.status === 'active')
    expect(left.current).toMatchObject({ side: 'left', holdSeconds: 20 });

  await logForm.getByRole('combobox', { name: '수행 상태' }).selectOption('performed');
  await logForm.getByRole('combobox', { name: '좌우·전체' }).selectOption('right');
  await logForm.getByRole('spinbutton', { name: '확인한 유지시간 (초)' }).fill('15');
  await logForm.getByLabel('수행 시각').fill(localTime(1));
  const createdRight = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/bff/v1/stretching/logs' &&
      response.request().method() === 'POST',
  );
  await logForm.getByRole('button', { name: '실제 수행 확인·저장' }).click();
  expect((await createdRight).status()).toBe(200);
  await expect(workspace.getByText('left · performed')).toBeVisible();
  await expect(workspace.getByText('right · performed')).toBeVisible();

  const preciseLogId = randomUUID();
  const preciseStartedAt = new Date(Date.parse(startedAt) + 30_123).toISOString();
  const preciseEndedAt = new Date(Date.parse(startedAt) + 60_987).toISOString();
  const preciseOccurredAt = new Date(Date.parse(startedAt) + 40_456).toISOString();
  const precise = await page.request.post('/bff/v1/stretching/logs', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      schemaVersion: 1,
      logId: preciseLogId,
      confirmation: 'user_confirmed',
      values: {
        activityId,
        exerciseVersionId: exercise.definition.versionId,
        plannedTarget: null,
        allocation: {
          kind: 'activity_block',
          startedAt: preciseStartedAt,
          endedAtExclusive: preciseEndedAt,
        },
        side: 'left',
        state: 'performed',
        holdSeconds: 31,
        repetitions: null,
        restSeconds: null,
        comfort: 'unknown',
        discomfortNote: null,
        reason: null,
        occurredAt: preciseOccurredAt,
      },
    },
  });
  expect(precise.status()).toBe(200);
  await page.reload();
  const preciseRow = workspace.locator('li').filter({ hasText: '유지 31초' });
  await preciseRow.getByRole('button', { name: '이 기록 정정' }).click();
  const correctionForm = workspace.locator('form').filter({ hasText: '기록 정정' });
  await correctionForm.getByRole('spinbutton', { name: '확인한 유지시간 (초)' }).fill('32');
  const correctedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/bff/v1/stretching/logs/${preciseLogId}` &&
      response.request().method() === 'PATCH',
  );
  await correctionForm.getByRole('button', { name: '정정 확인' }).click();
  const correction = await correctedResponse;
  expect(correction.status()).toBe(200);
  const corrected = stretchLogReadSchema.parse(await correction.json());
  expect(corrected.status).toBe('active');
  if (corrected.status === 'active') {
    expect(corrected.current.holdSeconds).toBe(32);
    expect(corrected.current.occurredAt).toBe(preciseOccurredAt);
    expect(corrected.current.allocation).toEqual({
      kind: 'activity_block',
      startedAt: preciseStartedAt,
      endedAtExclusive: preciseEndedAt,
    });
  }

  const activityAfterResponse = await page.request.get(`/bff/v1/activities/${activityId}`, {
    headers,
  });
  const activityAfter = activitySchema.parse(await activityAfterResponse.json());
  expect(activityAfter.original.durationSeconds).toBe(activityBefore.original.durationSeconds);
  expect(activityAfter.original.durationSeconds).toBe(300);

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(
    `http://127.0.0.1:4200/stretching/exercises/${exercise.definition.exerciseId}?activityId=${activityId}`,
  );
  await expect(page.getByRole('region', { name: '스트레칭 작업 공간' })).toContainText(
    exerciseName,
  );
  await expect(page.getByRole('region', { name: '스트레칭 작업 공간' })).toContainText(
    'right · performed',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
