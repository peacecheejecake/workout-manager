import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  activityListSchema,
  activitySchema,
  manualActivityResultSchema,
} from '../../packages/contracts/src/activity';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

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
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}
type Headers = Awaited<ReturnType<typeof login>>;

async function findRecords(page: Page, headers: Headers, marker: string) {
  const response = await page.request.get(
    `/bff/v1/activities?${new URLSearchParams({ search: marker })}`,
    { headers },
  );
  expect(response.status()).toBe(200);
  return activityListSchema.parse(await response.json());
}
async function cleanup(page: Page, headers: Headers, marker: string) {
  const records = await findRecords(page, headers, marker);
  for (const record of records.items) {
    const response = await page.request.delete(`/bff/v1/activities/${record.id}`, {
      headers,
      data: { expectedRevision: record.revision },
    });
    expect(response.status()).toBe(204);
  }
}

async function readRecord(page: Page, headers: Headers, id: string) {
  const response = await page.request.get(`/bff/v1/activities/${id}`, { headers });
  expect(response.status()).toBe(200);
  return activitySchema.parse(await response.json());
}

async function fillManual(page: Page, marker: string) {
  await page.getByRole('textbox', { name: '활동 제목', exact: true }).fill(marker);
  await page
    .getByRole('textbox', { name: '활동 시작 시각 (시간차 포함 ISO)', exact: true })
    .fill('2020-06-15T08:30:00Z');
  await page.getByRole('textbox', { name: '활동 시간대', exact: true }).fill('Asia/Seoul');
  await page.getByRole('spinbutton', { name: '활동 거리 (m)', exact: true }).fill('0');
  await page.getByRole('spinbutton', { name: '활동 시간 (초)', exact: true }).fill('');
  await page.getByRole('combobox', { name: '시간 정의', exact: true }).selectOption('unknown');
  await page.getByRole('spinbutton', { name: '세션 체감 강도 (RPE 0~10)', exact: true }).fill('0');
  await page
    .getByRole('textbox', { name: '활동 메모', exact: true })
    .fill(`${marker} 자기보고 메모`);
}

async function preview(page: Page) {
  await page.getByRole('button', { name: '활동 저장 미리보기', exact: true }).click();
  await expect(page.getByRole('region', { name: '활동 저장 미리보기', exact: true })).toBeVisible();
}
async function confirm(page: Page) {
  await page.getByRole('button', { name: '실제 활동 확인하고 저장', exact: true }).click();
  await expect(page.getByText('활동 저장이 확인되었습니다.', { exact: true })).toBeVisible();
}

test('manual editor previews before explicit recording and reloads zero, unknown and RPE values for correction', async ({
  page,
}) => {
  const headers = await login(page);
  const marker = `editor-manual-${randomUUID()}`;
  try {
    await page.goto('/activities/new');
    await fillManual(page, marker);
    await preview(page);
    expect((await findRecords(page, headers, marker)).total).toBe(0);
    await expect(
      page.getByRole('region', { name: '활동 저장 미리보기', exact: true }),
    ).toContainText('0m');
    await confirm(page);
    const records = await findRecords(page, headers, marker);
    expect(records.total).toBe(1);
    const original = records.items[0];
    assert.ok(original);
    expect(original.source.kind).toBe('manual');
    expect(original.effective).toMatchObject({
      distanceMeters: 0,
      durationSeconds: null,
      durationKind: 'unknown',
    });
    expect(original.userReport).toMatchObject({
      sessionRpe: 0,
      note: `${marker} 자기보고 메모`,
      source: 'user',
      method: 'self_report',
    });
    assert.ok(original.userReport?.rpeReportedAt);
    expect(Number.isFinite(Date.parse(original.userReport.rpeReportedAt))).toBe(true);
    await page.goto(`/activities/${original.id}/edit`);
    await expect(page.getByRole('textbox', { name: '활동 제목', exact: true })).toHaveValue(marker);
    await page.reload();
    await expect(page.getByRole('spinbutton', { name: '활동 거리 (m)', exact: true })).toHaveValue(
      '0',
    );
    await expect(page.getByRole('spinbutton', { name: '활동 시간 (초)', exact: true })).toHaveValue(
      '',
    );
    await expect(
      page.getByRole('spinbutton', { name: '세션 체감 강도 (RPE 0~10)', exact: true }),
    ).toHaveValue('0');
    await page.getByRole('spinbutton', { name: '세션 체감 강도 (RPE 0~10)', exact: true }).fill('');
    await page.getByRole('textbox', { name: '활동 메모', exact: true }).fill(`${marker} 정정 메모`);
    await page
      .getByRole('textbox', { name: '활동 정정 사유', exact: true })
      .fill('체감 강도 보고 철회');
    await preview(page);
    expect((await readRecord(page, headers, original.id)).revision).toBe(1);
    await confirm(page);
    const corrected = await readRecord(page, headers, original.id);
    expect(corrected.revision).toBe(2);
    expect(corrected.original).toEqual(original.original);
    expect(corrected.userReport).toMatchObject({
      sessionRpe: null,
      rpeReportedAt: null,
      note: `${marker} 정정 메모`,
    });
    await page.getByRole('link', { name: '저장된 활동 상세 보기', exact: true }).click();
    const detail = page.getByRole('region', { name: '선택한 활동 상세', exact: true });
    await expect(detail.getByRole('region', { name: '활동 자기보고', exact: true })).toContainText(
      '활동 전체의 체감 강도 (RPE): 보고하지 않음 / 10',
    );
    await expect(
      detail
        .getByRole('region', { name: '정정 반영 기록', exact: true })
        .getByText('0m', { exact: true }),
    ).toBeVisible();
  } finally {
    await cleanup(page, headers, marker);
  }
});

test('imported activity conflict preserves the draft until comparison and explicit rebased confirmation', async ({
  page,
}) => {
  const headers = await login(page);
  const marker = `editor-conflict-${randomUUID()}`;
  const importedResponse = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'c'.repeat(64) },
      activity: {
        title: marker,
        kind: 'running',
        startedAt: '2020-06-15T08:30:00Z',
        timezone: 'UTC',
        distanceMeters: 100,
        durationSeconds: null,
        durationKind: 'unknown',
      },
    },
  });
  expect(importedResponse.status()).toBe(200);
  const imported = activityImportResultSchema.parse(await importedResponse.json());
  try {
    await page.goto(`/activities/${imported.activityId}/edit`);
    const distance = page.getByRole('spinbutton', { name: '활동 거리 (m)', exact: true });
    await expect(distance).toHaveValue('100');
    await distance.fill('200');
    await page
      .getByRole('textbox', { name: '활동 메모', exact: true })
      .fill(`${marker} 보존할 초안`);
    await page.getByRole('textbox', { name: '활동 정정 사유', exact: true }).fill('합성 거리 정정');
    const remote = await page.request.patch(`/bff/v1/activities/${imported.activityId}`, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedRevision: 1, reason: '다른 탭의 합성 정정', distanceMeters: 400 },
    });
    expect(remote.status()).toBe(200);
    await preview(page);
    const rejected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/bff/v1/activities/${imported.activityId}` &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '실제 활동 확인하고 저장', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(page.getByText(/기록이 변경되었거나 요청이 충돌했습니다/)).toBeVisible();
    await expect(distance).toHaveValue('200');
    await page.getByRole('button', { name: '최신 활동 비교', exact: true }).click();
    await expect(page.getByRole('region', { name: '최신 활동 원본', exact: true })).toContainText(
      '거리 400m',
    );
    await page
      .getByRole('button', { name: '작성 내용 유지하고 다시 정정 준비', exact: true })
      .click();
    await expect(distance).toBeEnabled();
    await expect(distance).toHaveValue('200');
    await expect(page.getByRole('textbox', { name: '활동 메모', exact: true })).toHaveValue(
      `${marker} 보존할 초안`,
    );
    expect((await readRecord(page, headers, imported.activityId)).effective.distanceMeters).toBe(
      400,
    );
    await preview(page);
    expect((await readRecord(page, headers, imported.activityId)).revision).toBe(2);
    await confirm(page);
    const corrected = await readRecord(page, headers, imported.activityId);
    expect(corrected.revision).toBe(3);
    expect(corrected.source.kind).toBe('fixture');
    expect(corrected.original.distanceMeters).toBe(100);
    expect(corrected.effective.distanceMeters).toBe(200);
    expect(corrected.userReport?.note).toBe(`${marker} 보존할 초안`);
  } finally {
    await cleanup(page, headers, marker);
  }
});

test('lost create response locks the reviewed command and retries the same real database write once', async ({
  page,
}) => {
  const headers = await login(page);
  const marker = `editor-retry-${randomUUID()}`;
  const attempts: { key: string; body: unknown }[] = [];
  const createRoute = '**/bff/v1/activities';
  try {
    await page.goto('/activities/new');
    await fillManual(page, marker);
    await page.route(createRoute, async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.continue();
      const key = await request.headerValue('idempotency-key');
      assert.ok(key);
      attempts.push({ key, body: request.postDataJSON() });
      if (attempts.length === 1) {
        // Execute the real HTTP/DB command, then lose only its browser response.
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        manualActivityResultSchema.parse(await response.json());
        await route.abort('failed');
      } else await route.continue();
    });
    await preview(page);
    await page.getByRole('button', { name: '실제 활동 확인하고 저장', exact: true }).click();
    await expect(
      page.getByText('저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: '활동 제목', exact: true })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: '활동 메모', exact: true })).toHaveValue(
      `${marker} 자기보고 메모`,
    );
    await expect(
      page.getByRole('button', { name: '활동 초안 버리기', exact: true }),
    ).toBeDisabled();
    const committed = await findRecords(page, headers, marker);
    expect(committed.total).toBe(1);
    const first = committed.items[0];
    assert.ok(first);
    expect(first.revision).toBe(1);
    await page.getByRole('button', { name: '같은 활동 요청 다시 시도', exact: true }).click();
    await expect(page.getByText('활동 저장이 확인되었습니다.', { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const after = await findRecords(page, headers, marker);
    expect(after.total).toBe(1);
    expect(after.items[0]?.id).toBe(first.id);
    expect(after.items[0]?.revision).toBe(1);
    expect(after.items[0]?.userReport).toEqual(first.userReport);
  } finally {
    await page.unroute(createRoute);
    await cleanup(page, headers, marker);
  }
});

test('composition guard and responsive changes preserve an in-memory draft until explicit reload discard', async ({
  page,
}) => {
  const headers = await login(page);
  const marker = `editor-draft-${randomUUID()}`;
  await page.goto('/activities/new');
  await fillManual(page, marker);
  const title = page.getByRole('textbox', { name: '활동 제목', exact: true });
  await title.focus();
  // Synthetic composition events cover the application guard; this is not OS IME evidence.
  await title.dispatchEvent('compositionstart', { data: 'ㅎ' });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '활동 저장 미리보기', exact: true })).toBeHidden();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(title).toBeFocused();
    await expect(title).toHaveValue(marker);
    await expect(page.getByRole('textbox', { name: '활동 메모', exact: true })).toHaveValue(
      `${marker} 자기보고 메모`,
    );
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
  }
  await title.dispatchEvent('compositionend', { data: '한' });
  expect((await findRecords(page, headers, marker)).total).toBe(0);
  expect(
    await page.evaluate((needle) => {
      const values = (storage: Storage) =>
        Array.from({ length: storage.length }, (_, index) =>
          storage.getItem(storage.key(index) ?? ''),
        );
      return [...values(localStorage), ...values(sessionStorage)].some((value) =>
        value?.includes(needle),
      );
    }, marker),
  ).toBe(false);
  const discard = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
  });
  await Promise.all([discard, page.reload()]);
  await expect(title).toHaveValue('');
  await expect(page.getByRole('textbox', { name: '활동 메모', exact: true })).toHaveValue('');
  expect((await findRecords(page, headers, marker)).total).toBe(0);
});
