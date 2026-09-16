import { test, expect } from '@playwright/test';

test('manual plan draft previews before commit and survives responsive lens changes', async ({
  page,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await page.getByRole('link', { name: '훈련 계획', exact: true }).click();
  await page.getByRole('button', { name: '계획 초안 편집' }).click();
  await page.getByLabel('계획 제목', { exact: true }).fill('수동 검증 계획');
  for (const level of ['season', 'wave', 'phase', 'block'])
    await page.getByRole('button', { name: `${level} 추가`, exact: true }).click();
  await page.getByRole('button', { name: '세션 추가', exact: true }).click();
  await page.getByLabel('세션 제목', { exact: true }).fill('미정 러닝');
  const note = page.getByLabel('세션 메모', { exact: true });
  await note.fill('크기 변경에도 유지');
  await note.focus();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(note).toHaveValue('크기 변경에도 유지');
    await expect(note).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await expect(page.getByText('현재 버전: 없음', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장' }).click();
  await expect(page.getByText('계획 버전 1 저장 완료')).toBeVisible();
  await page.reload();
  await expect(page.getByText('현재 버전: 1 · 수동 검증 계획')).toBeVisible();
  await page.getByRole('button', { name: '계획 초안 편집' }).click();
  await expect(page.getByLabel('시간 (초, 미정 가능)', { exact: true })).toHaveValue('');
  await page.getByLabel('시간 (초, 미정 가능)', { exact: true }).fill('0');
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장' }).click();
  await expect(page.getByText('계획 버전 2 저장 완료')).toBeVisible();
});
