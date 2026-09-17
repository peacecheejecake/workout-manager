import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
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

async function setup(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const read = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const previous = await read();
  const draft = planDraftSchema.parse({
    title: 'Synthetic step units',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: ['editable', 'locked'].map((id) => ({
      id,
      blockId: 'block',
      date: '2026-09-20',
      localStartTime: null,
      title: id,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: null,
      targetRpe: null,
      purpose: 'Synthetic purpose',
      notes: 'Preserve metadata',
      priority: 'normal',
      locks: { date: false, time: false, intensity: id === 'locked' },
      steps: [
        {
          id: `${id}-fraction`,
          kind: 'work',
          durationSeconds: 61.25,
          distanceMeters: 1234.567,
          repetitions: 3,
        },
        {
          id: `${id}-zero`,
          kind: 'recovery',
          durationSeconds: 0,
          distanceMeters: null,
          repetitions: 2,
        },
        {
          id: `${id}-null`,
          kind: 'cooldown',
          durationSeconds: null,
          distanceMeters: 0,
          repetitions: 1,
        },
      ],
    })),
  });
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: previous.head?.id ?? null,
      draft,
    },
  });
  expect(response.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await response.json());
  await page.goto(
    '/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=agenda&plannedSession=editable&view=stack',
  );
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const step = page.getByRole('group', { name: '계획 단계 1', exact: true });
  await expect(step.getByLabel('단계 거리 (m)', { exact: true })).toHaveValue('1234.567');
  return { draft, saved, read, step };
}

test('confirmed same-dimension display conversion preserves precision, while edits require separate plan approval', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const fixture = await setup(page);
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes += 1;
  });
  const undo = page.getByRole('button', { name: '실행 취소', exact: true });
  await expect(undo).toBeDisabled();
  const distanceUnit = fixture.step.getByRole('combobox', { name: '단계 거리 단위', exact: true });
  await distanceUnit.selectOption('kilometers');
  const distanceConfirmation = fixture.step.getByRole('group', {
    name: '단계 거리 단위 전환 확인',
    exact: true,
  });
  await expect(distanceConfirmation).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const cancel = distanceConfirmation.getByRole('button', {
    name: '단계 거리 단위 전환 취소',
    exact: true,
  });
  await cancel.focus();
  await cancel.press('Enter');
  await expect(distanceConfirmation).toHaveCount(0);
  await expect(fixture.step.getByLabel('단계 거리 (m)', { exact: true })).toHaveValue('1234.567');
  await distanceUnit.selectOption('kilometers');
  const apply = distanceConfirmation.getByRole('button', {
    name: '단계 거리 단위 전환 적용',
    exact: true,
  });
  await apply.focus();
  await apply.press('Enter');
  await expect(fixture.step.getByLabel('단계 거리 (km)', { exact: true })).toHaveValue('1.234567');
  await fixture.step
    .getByRole('combobox', { name: '단계 시간 단위', exact: true })
    .selectOption('minutes');
  await fixture.step.getByRole('button', { name: '단계 시간 단위 전환 적용', exact: true }).click();
  await expect(fixture.step.getByLabel('단계 시간 (분)', { exact: true })).toHaveValue(
    String(61.25 / 60),
  );
  await expect(undo).toBeDisabled();
  expect(writes).toBe(0);
  expect((await fixture.read()).head).toEqual(fixture.saved);
  await fixture.step.getByLabel('단계 거리 (km)', { exact: true }).fill('2.5');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(fixture.step.getByLabel('단계 거리 (km)', { exact: true })).toHaveValue('1.234567');
  await fixture.step.getByLabel('단계 거리 (km)', { exact: true }).fill('2.5');
  await fixture.step.getByLabel('단계 시간 (분)', { exact: true }).fill('1.5');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(fixture.step.getByLabel('단계 거리 (km)', { exact: true })).toHaveValue('2.5');
  await expect(fixture.step.getByLabel('단계 시간 (분)', { exact: true })).toHaveValue('1.5');
  expect(writes).toBe(0);
  expect((await fixture.read()).head?.id).toBe(fixture.saved.id);
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(
    page.getByText(`계획 버전 ${fixture.saved.version + 1} 저장 완료`, { exact: true }),
  ).toBeVisible();
  expect(writes).toBe(1);
  const expected = structuredClone(fixture.draft);
  const edited = expected.sessions[0]?.steps[0];
  assert.ok(edited);
  edited.distanceMeters = 2500;
  edited.durationSeconds = 90;
  expect((await fixture.read()).head?.draft).toEqual(expected);
  await page.reload();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(fixture.step.getByLabel('단계 거리 (m)', { exact: true })).toHaveValue('2500');
  await expect(fixture.step.getByLabel('단계 시간 (초)', { exact: true })).toHaveValue('90');
  await expect(fixture.step.getByLabel('반복 횟수', { exact: true })).toHaveValue('3');
});

test('zero and unknown survive unit display changes and intensity-locked steps cannot be edited', async ({
  page,
}) => {
  const fixture = await setup(page);
  const zero = page.getByRole('group', { name: '계획 단계 2', exact: true });
  const unknown = page.getByRole('group', { name: '계획 단계 3', exact: true });
  for (const step of [zero, unknown]) {
    await step
      .getByRole('combobox', { name: '단계 시간 단위', exact: true })
      .selectOption('minutes');
    await step.getByRole('button', { name: '단계 시간 단위 전환 적용', exact: true }).click();
    await step
      .getByRole('combobox', { name: '단계 거리 단위', exact: true })
      .selectOption('kilometers');
    await step.getByRole('button', { name: '단계 거리 단위 전환 적용', exact: true }).click();
  }
  await expect(zero.getByLabel('단계 시간 (분)', { exact: true })).toHaveValue('0');
  await expect(zero.getByLabel('단계 거리 (km)', { exact: true })).toHaveValue('');
  await expect(unknown.getByLabel('단계 시간 (분)', { exact: true })).toHaveValue('');
  await expect(unknown.getByLabel('단계 거리 (km)', { exact: true })).toHaveValue('0');
  await expect(page.getByRole('button', { name: '실행 취소', exact: true })).toBeDisabled();
  expect((await fixture.read()).head).toEqual(fixture.saved);
  await page.getByRole('button', { name: '계획: locked', exact: true }).click();
  await expect(fixture.step.getByLabel('단계 시간 (초)', { exact: true })).toBeDisabled();
  await expect(fixture.step.getByLabel('단계 거리 (m)', { exact: true })).toBeDisabled();
  await expect(
    fixture.step.getByRole('combobox', { name: '단계 시간 단위', exact: true }),
  ).toBeDisabled();
  await expect(
    fixture.step.getByRole('combobox', { name: '단계 거리 단위', exact: true }),
  ).toBeDisabled();
});
