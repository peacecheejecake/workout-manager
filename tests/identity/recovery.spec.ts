import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  recoveryActionLogSchema,
  recoveryMethodVersionSchema,
  recoveryStrategyVersionSchema,
  recoveryWorkspaceReadSchema,
} from '../../packages/contracts/src/recovery-core';

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
  const erased = await page.request.delete('http://127.0.0.1:3100/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
});

const responseFor = (page: Page, path: string, method: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === method,
  );

test('OIDC recovery keeps full rest separate from actual actions across web and mobile', async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const headers = await login(page);
  const marker = randomUUID();
  const methodTitle = `Synthetic recovery method ${marker}`;
  const strategyTitle = `Synthetic rest choice ${marker}`;
  await page.goto('/recovery');
  const workspace = page.getByRole('region', { name: '회복 전략 작업 공간' });
  await expect(workspace).toContainText('확인된 행동 기록이 없습니다.');

  const methodForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '개인 방법 수동 기록' }),
  });
  await methodForm.getByRole('textbox', { name: '방법 이름' }).fill(methodTitle);
  await methodForm.getByRole('textbox', { name: '정보 출처' }).fill('개인 기록');
  const methodCreated = responseFor(page, '/bff/v1/recovery/methods', 'POST');
  await methodForm.getByRole('button', { name: '방법 저장' }).click();
  const methodResponse = await methodCreated;
  expect(methodResponse.status()).toBe(200);
  const method = recoveryMethodVersionSchema.parse(await methodResponse.json());
  expect(method.reviewState).toBe('unreviewed');
  await expect(workspace).toContainText('미검토 · 개인 수동 기록용');

  const day = new Date();
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start.getTime() + 2 * 86_400_000);
  const reassess = new Date(start.getTime() + 86_400_000 + 9 * 3_600_000);
  const asDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const asLocalTime = (date: Date) =>
    `${asDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const strategyForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '새 전략 초안' }),
  });
  await strategyForm.getByRole('textbox', { name: '제목' }).fill(strategyTitle);
  await strategyForm.getByLabel('시작 날짜').fill(asDate(start));
  await strategyForm.getByLabel('종료 날짜 (미포함)').fill(asDate(end));
  await strategyForm
    .getByRole('combobox', { name: '추가할 비운동 행동 (선택)' })
    .selectOption(method.versionId);
  await strategyForm.getByLabel('다시 확인할 시점').fill(asLocalTime(reassess));
  const draftCreated = responseFor(page, '/bff/v1/recovery/strategy-drafts', 'POST');
  await strategyForm.getByRole('button', { name: '전략 초안 저장' }).click();
  const draftResponse = await draftCreated;
  expect(draftResponse.status()).toBe(200);
  const draft = recoveryStrategyVersionSchema.parse(await draftResponse.json());
  expect(draft.draft.options.map((option) => option.kind)).toEqual([
    'full_rest',
    'maintain_existing_plan',
    'nonexercise_action',
  ]);
  await expect(workspace).toContainText('초안 · 아직 선택 확인 전');
  expect(
    recoveryWorkspaceReadSchema.parse(
      await (
        await page.request.get('/bff/v1/recovery', {
          headers,
        })
      ).json(),
    ).actions,
  ).toEqual([]);

  const strategyCard = workspace.locator('article').filter({ hasText: strategyTitle });
  const confirmed = responseFor(
    page,
    `/bff/v1/recovery/strategies/${draft.strategyId}/confirm`,
    'POST',
  );
  await strategyCard.getByRole('button', { name: '이 안을 명시적으로 선택' }).click();
  const confirmationResponse = await confirmed;
  expect(confirmationResponse.status()).toBe(200);
  const strategy = recoveryStrategyVersionSchema.parse(await confirmationResponse.json());
  expect(strategy.status).toBe('user_confirmed');
  expect(strategy.selectedOptionId).toBe(draft.draft.options[0]?.id);
  await expect(strategyCard).toContainText('완전 휴식 · 추가 활동 없음');
  await expect(workspace).toContainText('확인된 행동 기록이 없습니다.');

  await strategyCard.getByRole('link', { name: '전략 상세' }).click();
  await expect(page).toHaveURL(new RegExp(`/recovery/strategies/${draft.strategyId}$`));
  await expect(workspace).toContainText(strategyTitle);
  await page.goto(`http://127.0.0.1:4200/recovery/strategies/${draft.strategyId}`);
  await expect(workspace).toContainText(strategyTitle);
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 800 });

  // A later manual action remains unplanned because the selected option is full rest.
  await page.goto('/recovery');
  const actionForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: '비운동 행동 수동 기록' }),
  });
  await actionForm
    .getByRole('combobox', { name: '방법', exact: true })
    .selectOption(method.versionId);
  await expect(actionForm.getByRole('combobox', { name: '선택한 전략과 연결 (선택)' })).toHaveValue(
    '',
  );
  await actionForm.getByLabel('실제 시각').fill(asLocalTime(new Date()));
  await actionForm.getByRole('textbox', { name: '내 기록' }).fill('Synthetic manual note');
  const actionCreated = responseFor(page, '/bff/v1/recovery/action-logs', 'POST');
  await actionForm.getByRole('button', { name: '행동 저장' }).click();
  const actionResponse = await actionCreated;
  expect(actionResponse.status()).toBe(200);
  const action = recoveryActionLogSchema.parse(await actionResponse.json());
  expect(action.strategyVersionId).toBeNull();
  expect(action.plannedOptionId).toBeNull();
  await expect(workspace).toContainText(`${methodTitle} · performed`);
  const actionCard = workspace.locator('article').filter({ hasText: `${methodTitle} · performed` });
  await actionCard.getByRole('button', { name: '정정', exact: true }).click();
  const correctionForm = actionCard.locator('form');
  await correctionForm.getByRole('combobox', { name: '수행 상태' }).selectOption('partial');
  await correctionForm.getByRole('spinbutton', { name: '실제 확인한 시간 (초, 선택)' }).fill('0');
  const actionCorrected = responseFor(
    page,
    `/bff/v1/recovery/action-logs/${action.actionId}`,
    'PATCH',
  );
  await correctionForm.getByRole('button', { name: '정정 저장' }).click();
  const correctionResponse = await actionCorrected;
  expect(correctionResponse.status()).toBe(200);
  const corrected = recoveryActionLogSchema.parse(await correctionResponse.json());
  expect(corrected).toMatchObject({ revision: 2, state: 'partial', durationSeconds: 0 });
  await expect(workspace).toContainText(`${methodTitle} · partial`);
  const read = await page.request.get('/bff/v1/recovery', { headers });
  expect(read.status()).toBe(200);
  const snapshot = recoveryWorkspaceReadSchema.parse(await read.json());
  expect(snapshot.actions).toHaveLength(1);
  expect(snapshot.strategies[0]?.selectedOptionId).toBe(strategy.selectedOptionId);
  expect(snapshot.actions[0]?.revision).toBe(2);
  page.once('dialog', (dialog) => dialog.accept());
  const actionDeleted = responseFor(
    page,
    `/bff/v1/recovery/action-logs/${action.actionId}`,
    'DELETE',
  );
  await workspace.getByRole('button', { name: '기록 삭제' }).click();
  expect((await actionDeleted).status()).toBe(200);
  await expect(workspace).toContainText('삭제된 기록 · 이전 건강 정보는 표시하지 않습니다.');
});
