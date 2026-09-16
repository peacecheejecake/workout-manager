import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { expect, test, type Page } from '@playwright/test';
import { checkInCommandResultSchema, checkInSchema } from '../../packages/contracts/src/check-ins';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

const wellbeingUrl = '/wellbeing?from=2026-09-16&toExclusive=2026-09-17';

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
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
  await page.goto(wellbeingUrl);
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

async function createCheckIn(page: Page, observedAt: string, note: string) {
  await page
    .getByRole('textbox', { name: '관측 시각 (시간차 포함 ISO)', exact: true })
    .fill(observedAt);
  await page.getByRole('textbox', { name: '관측 시간대', exact: true }).fill('Asia/Seoul');
  const fatigue = page.getByRole('combobox', { name: '피로 (0~10)', exact: true });
  const discomfort = page.getByRole('combobox', { name: '불편감 (0~10)', exact: true });
  await fatigue.selectOption('0');
  await expect(fatigue).toHaveValue('0');
  await discomfort.selectOption('');
  await expect(discomfort).toHaveValue('');
  await page.getByRole('textbox', { name: '체크인 메모', exact: true }).fill(note);
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/bff/v1/check-ins' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '체크인 저장', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const result = checkInCommandResultSchema.parse(await response.json());
  await expect(page.getByText('저장이 확인되었습니다.', { exact: true })).toBeVisible();
  return result;
}

async function selectCheckIn(page: Page, observedAt: string, note: string) {
  await page
    .getByRole('button', {
      name: `기록 상세 보기 · ${new Date(observedAt).toISOString()}`,
      exact: true,
    })
    .click();
  const detail = page.getByRole('region', { name: '선택한 체크인', exact: true });
  await expect(detail.getByText(note, { exact: true })).toBeVisible();
  return detail;
}

// S12 / V2-F17: actual OIDC, UI, API and PostgreSQL; all report values are synthetic.
test('check-in UI preserves zero and unknown values across reload, correction and confirmed deletion', async ({
  page,
}) => {
  const headers = await login(page);
  const observedAt = '2026-09-15T23:30:01Z';
  const note = `합성 체크인 UI ${randomUUID()}`;
  const created = await createCheckIn(page, observedAt, note);
  const path = `/bff/v1/check-ins/${created.id}`;
  const response = await page.request.get(path, { headers });
  expect(response.status()).toBe(200);
  expect(checkInSchema.parse(await response.json())).toMatchObject({
    revision: 1,
    localDate: '2026-09-16',
    values: { fatigue: 0, discomfort: null, note, timezone: 'Asia/Seoul' },
    source: 'user',
    method: 'self_report',
  });
  await page.reload();
  const detail = await selectCheckIn(page, observedAt, note);
  await expect(detail.getByText('0', { exact: true })).toBeVisible();
  await expect(detail.getByText('보고하지 않음', { exact: true })).toHaveCount(2);
  await detail.getByRole('button', { name: '이 기록 정정', exact: true }).click();
  const fatigue = page.getByRole('combobox', { name: '피로 (0~10)', exact: true });
  const discomfort = page.getByRole('combobox', { name: '불편감 (0~10)', exact: true });
  await fatigue.selectOption('');
  await expect(fatigue).toHaveValue('');
  await discomfort.selectOption('0');
  await expect(discomfort).toHaveValue('0');
  await page
    .getByRole('textbox', { name: '정정 사유', exact: true })
    .fill('합성 기록의 미보고와 0 정정');
  const corrected = page.waitForResponse(
    (result) => new URL(result.url()).pathname === path && result.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '정정 저장', exact: true }).click();
  const correctedResponse = await corrected;
  expect(correctedResponse.status()).toBe(200);
  expect(checkInCommandResultSchema.parse(await correctedResponse.json())).toMatchObject({
    id: created.id,
    revision: 2,
    deleted: false,
  });
  await expect(detail.getByText(/수정 2$/)).toBeVisible();
  const current = await page.request.get(path, { headers });
  expect(checkInSchema.parse(await current.json()).values).toMatchObject({
    fatigue: null,
    discomfort: 0,
  });
  await page.reload();
  await expect(detail.getByText(note, { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '이 기록 정정', exact: true }).click();
  const remove = page.getByRole('button', { name: '체크인 삭제', exact: true });
  await expect(remove).toBeDisabled();
  await page.getByRole('checkbox', { name: '이 체크인을 삭제합니다', exact: true }).check();
  await remove.click();
  await expect(page.getByText('삭제가 확인되었습니다.', { exact: true })).toBeVisible();
  expect((await page.request.get(path, { headers })).status()).toBe(404);
  await page.reload();
  await expect(page.getByText(note, { exact: true })).toBeHidden();
  await expect(
    page.getByRole('button', {
      name: `기록 상세 보기 · ${new Date(observedAt).toISOString()}`,
      exact: true,
    }),
  ).toBeHidden();
});

test('a stale UI correction retains the draft until explicit comparison and resubmission', async ({
  page,
}) => {
  const headers = await login(page);
  const observedAt = '2026-09-15T23:31:02Z';
  const note = `합성 동시 수정 ${randomUUID()}`;
  const created = await createCheckIn(page, observedAt, note);
  const detail = await selectCheckIn(page, observedAt, note);
  await detail.getByRole('button', { name: '이 기록 정정', exact: true }).click();
  const localNote = `${note} 작성 중인 변경`;
  await page.getByRole('textbox', { name: '체크인 메모', exact: true }).fill(localNote);
  await page.getByRole('textbox', { name: '정정 사유', exact: true }).fill('사용자가 준비한 정정');
  const path = `/bff/v1/check-ins/${created.id}`;
  const current = await page.request.get(path, { headers });
  const original = checkInSchema.parse(await current.json());
  const remoteNote = `${note} 다른 창의 변경`;
  const remote = await page.request.put(path, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      expectedRevision: original.revision,
      reason: '합성 동시 변경',
      values: { ...original.values, note: remoteNote },
    },
  });
  expect(remote.status()).toBe(200);
  const stale = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '정정 저장', exact: true }).click();
  expect((await stale).status()).toBe(409);
  await expect(page.getByText(/다른 변경으로 기록이 달라졌습니다/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: '체크인 메모', exact: true })).toHaveValue(
    localNote,
  );
  await expect(page.getByRole('button', { name: '정정 저장', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '최신 기록 확인', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: '최신 원본 비교', exact: true })
      .getByText(remoteNote, { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '작성한 내용으로 다시 정정 준비', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '체크인 메모', exact: true })).toHaveValue(
    localNote,
  );
  const beforeResubmit = await page.request.get(path, { headers });
  expect(checkInSchema.parse(await beforeResubmit.json())).toMatchObject({
    revision: 2,
    values: { note: remoteNote },
  });
  await page.getByRole('button', { name: '정정 저장', exact: true }).click();
  await expect(page.getByText('저장이 확인되었습니다.', { exact: true })).toBeVisible();
  const after = await page.request.get(path, { headers });
  expect(checkInSchema.parse(await after.json())).toMatchObject({
    revision: 3,
    values: { note: localNote },
  });
  await expect(detail.getByText(localNote, { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '이 기록 정정', exact: true }).click();
  await page.getByRole('checkbox', { name: '이 체크인을 삭제합니다', exact: true }).check();
  await page.getByRole('button', { name: '체크인 삭제', exact: true }).click();
  await expect(page.getByText('삭제가 확인되었습니다.', { exact: true })).toBeVisible();
});

test('generated viewport boundaries preserve the focused check-in draft without persisting health text', async ({
  page,
}) => {
  await login(page);
  const note = page.getByRole('textbox', { name: '체크인 메모', exact: true });
  const draft = `저장하지 않은 합성 메모 ${randomUUID()}`;
  await note.fill(draft);
  await note.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(note).toHaveValue(draft);
    await expect(note).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  expect(
    await page.evaluate((marker) => {
      const values = (storage: Storage) =>
        Array.from({ length: storage.length }, (_, index) =>
          storage.getItem(storage.key(index) ?? ''),
        );
      return [...values(localStorage), ...values(sessionStorage)].some((value) =>
        value?.includes(marker),
      );
    }, draft),
  ).toBe(false);
  const discardConfirmation = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
  });
  await Promise.all([discardConfirmation, page.reload()]);
  await expect(note).toHaveValue('');
});
