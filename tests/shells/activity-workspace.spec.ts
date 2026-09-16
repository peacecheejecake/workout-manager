import { test, expect } from '@playwright/test';

test('shares ActivityList, preserves draft across resize, resets account and logout', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('A 가상 러닝', { exact: true })).toBeVisible();
  await expect(page.getByText('시간 미확인', { exact: true })).toBeVisible();
  await expect(page.getByText('0초', { exact: true })).toBeVisible();
  const note = page.getByLabel('작업 메모 (임시)');
  await note.fill('오늘의 임시 메모');
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(note).toHaveValue('오늘의 임시 메모');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  await page.getByRole('button', { name: '개발 계정 전환' }).click();
  await expect(page.getByText('B 가상 러닝', { exact: true })).toBeVisible();
  await expect(page.getByText('A 가상 러닝', { exact: true })).toHaveCount(0);
  await expect(note).toHaveValue('');
  await note.fill('종료할 메모');
  await page.getByRole('button', { name: '개발 세션 종료' }).click();
  await expect(note).toHaveCount(0);
  await page.getByRole('button', { name: '개발 세션 시작' }).click();
  await expect(note).toHaveValue('');
  expect(pageErrors).toEqual([]);
});

test('switches fake transport and preserves unsaved note through retry', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('데이터 시나리오').selectOption('empty');
  await expect(page.getByText('아직 활동이 없습니다.')).toBeVisible();
  await page.getByLabel('데이터 시나리오').selectOption('retry');
  await expect(
    page.getByRole('region', { name: '활동', exact: true }).getByRole('alert'),
  ).toBeVisible();
  await page.getByLabel('작업 메모 (임시)').fill('재시도 중 메모');
  await page.getByRole('button', { name: '다시 시도' }).click();
  await expect(page.getByText('A 가상 러닝', { exact: true })).toBeVisible();
  await expect(page.getByLabel('작업 메모 (임시)')).toHaveValue('재시도 중 메모');
});
