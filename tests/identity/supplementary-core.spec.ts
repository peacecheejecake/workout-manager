import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityListSchema,
  activitySchema,
  manualActivityResultSchema,
} from '../../packages/contracts/src/activity';
import { parseCurrentAccountExport } from './account-export';
import {
  exerciseVersionReadSchema,
  restTimerStateSchema,
  routineTemplateReadSchema,
  setLogReadSchema,
  supplementaryExecutionSchema,
} from '../../packages/contracts/src/supplementary-core';

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
  const value: unknown = await response.json();
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      'csrfToken' in value &&
      typeof value.csrfToken === 'string',
  );
  const headers: Headers = {
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
  // The isolated OIDC/PostgreSQL harness provisions this synthetic account only.
  const erased = await page.request.delete('http://127.0.0.1:3100/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
});

const supplementary = '/bff/v1/supplementary';
const responseFor = (page: Page, path: string, method: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === method,
  );

test('versioned exercise and routine feed one Activity execution with confirmed sets and a persistent rest timer', async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(8_000);
  const headers = await login(page);
  const marker = randomUUID();
  const exerciseName = `Synthetic plyometric ${marker}`;
  const routineName = `Synthetic strength routine ${marker}`;
  const activityName = `Synthetic supplementary Activity ${marker}`;
  const read = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };

  // S29: user-authored catalog content is visibly unreviewed and versioned.
  await page.goto('/supplementary/exercises');
  const workspace = page.getByRole('region', { name: '보강 운동 작업 공간' });
  await workspace.getByRole('button', { name: '동작 추가' }).click();
  const exerciseForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '새 동작', exact: true }),
  });
  await exerciseForm.getByRole('textbox', { name: '이름', exact: true }).fill(exerciseName);
  await exerciseForm.getByRole('combobox', { name: '동작 계열' }).selectOption('plyometric');
  await exerciseForm.getByRole('combobox', { name: '횟수 정의' }).selectOption('foot_contacts');
  await exerciseForm.getByRole('combobox', { name: '횟수 기준' }).selectOption('per_side');
  await exerciseForm
    .getByRole('textbox', { name: '수행 설명' })
    .fill('Synthetic controlled contacts; no physiological claim.');
  const exerciseCreated = responseFor(page, `${supplementary}/exercises`, 'POST');
  await exerciseForm.getByRole('button', { name: '확인하고 버전 저장' }).click();
  const exerciseV1Response = await exerciseCreated;
  expect(exerciseV1Response.status()).toBe(200);
  const exerciseV1 = exerciseVersionReadSchema.parse(await exerciseV1Response.json());
  expect(exerciseV1.version).toBe(1);
  expect(exerciseV1.definition).toMatchObject({
    name: exerciseName,
    reviewState: 'unreviewed',
    countDefinitions: [{ kind: 'foot_contacts', basis: 'per_side' }],
  });
  await expect(workspace).toContainText('사용자 등록·미검토');

  // S28: a routine stores an explicit exercise version and a target, not an actual set.
  await page.goto('/supplementary');
  await workspace.getByRole('button', { name: '루틴 만들기' }).click();
  const routineForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '새 루틴', exact: true }),
  });
  await routineForm.getByRole('textbox', { name: '이름', exact: true }).fill(routineName);
  await routineForm.getByRole('textbox', { name: '목적' }).fill('Synthetic plan target only');
  await routineForm.getByRole('button', { name: '세트 추가' }).click();
  await routineForm
    .getByRole('combobox', { name: '동작 버전' })
    .selectOption(exerciseV1.definition.versionId);
  await routineForm.getByRole('spinbutton', { name: '목표 횟수' }).fill('10');
  await routineForm.getByRole('spinbutton', { name: '세트 뒤 휴식 (초)' }).fill('60');
  const routineCreated = responseFor(page, `${supplementary}/routines`, 'POST');
  await routineForm.getByRole('button', { name: '확인하고 버전 저장' }).click();
  const routineV1Response = await routineCreated;
  expect(routineV1Response.status()).toBe(200);
  const routineV1 = routineTemplateReadSchema.parse(await routineV1Response.json());
  expect(routineV1.version).toBe(1);
  expect(routineV1.template.spec.blocks[0]?.sets[0]).toMatchObject({
    exerciseVersionId: exerciseV1.definition.versionId,
    count: { target: { min: 10, max: 10, basis: 'user_confirmed' } },
  });

  await page.goto(`/supplementary/exercises/${exerciseV1.definition.exerciseId}`);
  await workspace.getByRole('button', { name: '새 버전으로 편집' }).click();
  const revisedExerciseForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '새 동작 버전' }),
  });
  await revisedExerciseForm
    .getByRole('textbox', { name: '수행 설명' })
    .fill('Updated synthetic instructions; previous routine must stay frozen.');
  const exerciseRevised = responseFor(page, `${supplementary}/exercises`, 'POST');
  await revisedExerciseForm.getByRole('button', { name: '확인하고 버전 저장' }).click();
  const exerciseV2Response = await exerciseRevised;
  expect(exerciseV2Response.status()).toBe(200);
  const exerciseV2 = exerciseVersionReadSchema.parse(await exerciseV2Response.json());
  expect(exerciseV2.version).toBe(2);
  expect(exerciseV2.definition.versionId).not.toBe(exerciseV1.definition.versionId);
  expect(
    routineTemplateReadSchema.parse(
      await read(`${supplementary}/routine-versions/${routineV1.template.versionId}`),
    ).template.spec.blocks[0]?.sets[0]?.exerciseVersionId,
  ).toBe(exerciseV1.definition.versionId);

  await page.goto(`/supplementary/routines/${routineV1.template.routineId}`);
  await expect(workspace).toContainText('버전 1');
  await workspace.getByRole('button', { name: '새 버전으로 편집' }).click();
  const revisedRoutineForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '새 루틴 버전' }),
  });
  await revisedRoutineForm
    .getByRole('combobox', { name: '동작 버전' })
    .selectOption(exerciseV2.definition.versionId);
  const routineRevised = responseFor(page, `${supplementary}/routines`, 'POST');
  await revisedRoutineForm.getByRole('button', { name: '확인하고 버전 저장' }).click();
  const routineV2Response = await routineRevised;
  expect(routineV2Response.status()).toBe(200);
  const routineV2 = routineTemplateReadSchema.parse(await routineV2Response.json());
  expect(routineV2.version).toBe(2);
  expect(routineV2.template.spec.blocks[0]?.sets[0]?.exerciseVersionId).toBe(
    exerciseV2.definition.versionId,
  );
  expect(
    routineTemplateReadSchema.parse(
      await read(`${supplementary}/routine-versions/${routineV1.template.versionId}`),
    ),
  ).toEqual(routineV1);

  // S30 attaches the execution to an existing canonical Activity. Set and timer rows
  // must not create another Activity or turn a routine target into actual performance.
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  const createdActivity = await page.request.post('/bff/v1/activities', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      confirmed: true,
      activity: {
        title: activityName,
        kind: 'strength',
        startedAt,
        timezone: 'UTC',
        distanceMeters: null,
        durationSeconds: null,
        durationKind: 'unknown',
      },
      report: { sessionRpe: null, note: null, planLink: null },
    },
  });
  expect(createdActivity.status()).toBe(200);
  const activityId = manualActivityResultSchema.parse(await createdActivity.json()).activityId;
  const activityBefore = activitySchema.parse(await read(`/bff/v1/activities/${activityId}`));
  const listActuals = async () =>
    activityListSchema.parse(
      await read(`/bff/v1/activities?${new URLSearchParams({ search: activityName })}`),
    );
  expect((await listActuals()).items.map((item) => item.id)).toEqual([activityId]);

  await page.goto('/supplementary');
  await workspace.getByRole('combobox', { name: 'Activity 연결 방식' }).selectOption('match');
  await workspace.getByRole('textbox', { name: '기존 Activity ID' }).fill(activityId);
  const executionCreated = responseFor(page, `${supplementary}/executions`, 'POST');
  await workspace.getByRole('button', { name: '확인하고 수행 시작' }).click();
  const executionResponse = await executionCreated;
  expect(executionResponse.status()).toBe(200);
  const execution = supplementaryExecutionSchema.parse(await executionResponse.json());
  expect(execution).toMatchObject({ activityId, status: 'active', plannedSession: null });
  await expect(page).toHaveURL(
    new RegExp(`/supplementary/sessions/${execution.executionId}/perform`),
  );
  expect((await listActuals()).items.map((item) => item.id)).toEqual([activityId]);
  const setPath = `${supplementary}/executions/${execution.executionId}/sets`;
  const setForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '세트 추가', exact: true }),
  });
  await setForm
    .getByRole('combobox', { name: '동작 버전' })
    .selectOption(exerciseV2.definition.versionId);
  const draftCreated = responseFor(page, setPath, 'POST');
  await setForm.getByRole('button', { name: '세트 초안 저장' }).click();
  const draftResponse = await draftCreated;
  expect(draftResponse.status()).toBe(200);
  const draft = setLogReadSchema.parse(await draftResponse.json());
  assert.equal(draft.status, 'active');
  expect(draft.current).toMatchObject({
    activityId,
    state: 'unconfirmed',
    count: { actual: { value: null, status: 'unknown' } },
  });
  await expect(workspace.getByText('실제 세트와 초안')).toBeVisible();
  expect((await listActuals()).total).toBe(1);

  const setsSection = workspace.locator('section').filter({
    has: page.getByRole('heading', { name: '실제 세트와 초안' }),
  });
  await setsSection
    .getByRole('listitem')
    .filter({ hasText: 'unconfirmed' })
    .getByRole('button', {
      name: '정정',
    })
    .click();
  const correctionForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '세트 정정' }),
  });
  await correctionForm
    .getByRole('combobox', { name: '상태', exact: true })
    .selectOption('performed');
  await correctionForm.getByRole('spinbutton', { name: '실제 횟수 (모르면 비움)' }).fill('8');
  await correctionForm.getByRole('spinbutton', { name: 'RPE (0~10, 모르면 비움)' }).fill('5');
  const correctedResponse = responseFor(page, `${setPath}/${draft.current.logId}`, 'PATCH');
  await correctionForm.getByRole('button', { name: '확인하고 실제 세트 저장' }).click();
  const correctedResult = await correctedResponse;
  expect(correctedResult.status()).toBe(200);
  const corrected = setLogReadSchema.parse(await correctedResult.json());
  assert.equal(corrected.status, 'active');
  expect(corrected.current).toMatchObject({
    activityId,
    revision: 2,
    state: 'performed',
    count: { actual: { value: 8, status: 'reported' }, definition: { basis: 'per_side' } },
    effort: { rpe: 5 },
  });

  await setForm
    .getByRole('combobox', { name: '동작 버전' })
    .selectOption(exerciseV2.definition.versionId);
  const extraDraftCreated = responseFor(page, setPath, 'POST');
  await setForm.getByRole('button', { name: '세트 초안 저장' }).click();
  const extraDraftResponse = await extraDraftCreated;
  expect(extraDraftResponse.status()).toBe(200);
  const extraDraft = setLogReadSchema.parse(await extraDraftResponse.json());
  assert.equal(extraDraft.status, 'active');
  expect(extraDraft.current.state).toBe('unconfirmed');
  const extraDraftDeleted = responseFor(page, `${setPath}/${extraDraft.current.logId}`, 'DELETE');
  await setsSection
    .getByRole('listitem')
    .filter({ hasText: 'unconfirmed' })
    .getByRole('button', { name: '삭제' })
    .click();
  const extraDeletedResponse = await extraDraftDeleted;
  expect(extraDeletedResponse.status()).toBe(200);
  const deletedDraft = setLogReadSchema.parse(await extraDeletedResponse.json());
  expect(deletedDraft).toMatchObject({
    status: 'deleted',
    logId: extraDraft.current.logId,
    revision: 2,
  });
  expect(setLogReadSchema.parse(await read(`${setPath}/${draft.current.logId}`))).toEqual(
    corrected,
  );
  expect((await listActuals()).total).toBe(1);

  // The timer uses server reference time. Reload and shell switch may alter its
  // display, but cannot create another actual or reset its paused state.
  const timerRegion = workspace.getByRole('region', { name: '휴식 타이머' });
  await timerRegion.getByRole('spinbutton', { name: '휴식 길이 (초)' }).fill('300');
  const timerStarted = responseFor(page, `${supplementary}/rest-timers`, 'POST');
  await timerRegion.getByRole('button', { name: '휴식 시작' }).click();
  const timerStartResponse = await timerStarted;
  expect(timerStartResponse.status()).toBe(200);
  const startedTimer = restTimerStateSchema.parse(await timerStartResponse.json());
  expect(startedTimer.status).toBe('running');
  await page.reload();
  await expect(timerRegion).toContainText('running');
  const timerPaused = responseFor(page, `${supplementary}/rest-timers`, 'POST');
  await timerRegion.getByRole('button', { name: '일시정지' }).click();
  const timerPauseResponse = await timerPaused;
  expect(timerPauseResponse.status()).toBe(200);
  const pausedTimer = restTimerStateSchema.parse(await timerPauseResponse.json());
  expect(pausedTimer).toMatchObject({ timerId: startedTimer.timerId, status: 'paused' });
  await page.goto(`http://127.0.0.1:4200/supplementary/sessions/${execution.executionId}/perform`);
  await expect(workspace).toContainText('paused');
  await expect(workspace).toContainText('performed · 8회');
  expect((await listActuals()).total).toBe(1);

  const currentExecution = supplementaryExecutionSchema.parse(
    await read(`${supplementary}/executions/${execution.executionId}`),
  );
  expect(currentExecution.status).toBe('active');
  const completionResponse = responseFor(
    page,
    `${supplementary}/executions/${execution.executionId}/completion`,
    'POST',
  );
  await workspace.getByRole('button', { name: '수행 종료 확인' }).click();
  const finishedResponse = await completionResponse;
  expect(finishedResponse.status()).toBe(200);
  const finished = supplementaryExecutionSchema.parse(await finishedResponse.json());
  expect(finished).toMatchObject({
    executionId: execution.executionId,
    activityId,
    status: 'finished',
  });
  expect(finished.endedAt).not.toBeNull();
  expect((await listActuals()).items.map((item) => item.id)).toEqual([activityId]);
  expect(activitySchema.parse(await read(`/bff/v1/activities/${activityId}`))).toEqual(
    activityBefore,
  );

  const exportResponse = await page.request.post('http://127.0.0.1:3100/bff/v1/operations/export', {
    headers,
  });
  expect(exportResponse.status()).toBe(200);
  const artifact = parseCurrentAccountExport(await exportResponse.json());
  expect(artifact.data.supplementaryExerciseVersions).toHaveLength(2);
  expect(artifact.data.supplementaryRoutineVersions).toHaveLength(2);
  expect(artifact.data.supplementaryExecutions).toContainEqual(
    expect.objectContaining({
      id: execution.executionId,
      activity_id: activityId,
      status: 'finished',
    }),
  );
  expect(artifact.data.supplementarySetLogs).toContainEqual(
    expect.objectContaining({ id: draft.current.logId, activity_id: activityId, status: 'active' }),
  );
  expect(artifact.data.supplementarySetLogs).toContainEqual(
    expect.objectContaining({
      id: extraDraft.current.logId,
      activity_id: activityId,
      status: 'deleted',
    }),
  );
  expect(artifact.data.supplementarySetLogRevisions).toHaveLength(4);
  expect(artifact.data.supplementaryRestTimers).toContainEqual(
    expect.objectContaining({ id: startedTimer.timerId, status: 'paused' }),
  );
});
