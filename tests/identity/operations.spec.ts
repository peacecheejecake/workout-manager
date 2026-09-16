import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { accountExportSchema } from '../../packages/contracts/src/operations';

test('exports scoped data then erases the account, revokes other tabs and starts empty on re-login', async ({
  page,
  context,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Bob' }).click();
  const before = await (await page.request.get('/bff/v1/session')).json();
  const headers = {
    'x-workout-session-id': before.sessionId,
    'x-csrf-token': before.csrfToken,
    origin: 'http://127.0.0.1:3100',
    'idempotency-key': randomUUID(),
  };
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers,
    data: {
      source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'b'.repeat(64) },
      activity: {
        title: '내보내기 합성 기록',
        kind: 'running',
        startedAt: null,
        timezone: null,
        durationSeconds: null,
        durationKind: 'unknown',
        distanceMeters: 0,
      },
    },
  });
  expect(imported.status()).toBe(200);
  await page.reload();
  await expect(page.getByText('Garmin: 연결되지 않음 · HealthKit: 연결되지 않음')).toBeVisible();
  const deleteButton = page.getByRole('button', { name: '확인하고 앱 계정 삭제' });
  await expect(deleteButton).toBeDisabled();
  await page.getByRole('button', { name: '내 데이터 내보내기 준비' }).click();
  const link = page.getByRole('link', { name: '내 데이터 JSON 다운로드' });
  await expect(link).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Expected completed local download');
  const raw = await readFile(downloadPath, 'utf8');
  const artifact = accountExportSchema.parse(JSON.parse(raw));
  expect(artifact.athleteId).toBe(before.athleteId);
  expect(raw).toContain('내보내기 합성 기록');
  expect(raw).not.toContain(before.csrfToken);
  expect(raw).not.toContain('token_hash');
  const other = await context.newPage();
  await other.goto('/account');
  await expect(other.getByRole('button', { name: '내 데이터 내보내기 준비' })).toBeVisible();
  for (const width of [320, 767, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByLabel('삭제 확인 문구').fill('DELETE MY ACCOUNT');
  await deleteButton.click();
  await expect(page.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
  await expect(link).toHaveCount(0);
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
  await other.getByRole('button', { name: '내 데이터 내보내기 준비' }).click();
  await expect(other.getByRole('link', { name: 'OIDC로 로그인' })).toBeVisible();
  await other.close();
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Bob' }).click();
  const after = await (await page.request.get('/bff/v1/session')).json();
  expect(after.athleteId).not.toBe(before.athleteId);
  const records = await page.request.get('/bff/v1/activities', {
    headers: { 'x-workout-session-id': after.sessionId },
  });
  expect(await records.json()).toEqual({ items: [], total: 0 });
});
