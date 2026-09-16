import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('../fixtures/fit-activity-export.json', import.meta.url));

test('FIT export import, correction, replay and deletion suppression use canonical storage', async ({
  page,
}) => {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await page.getByRole('link', { name: '가져온 활동', exact: true }).click();
  await page.getByRole('link', { name: 'FIT 가져오기·정정', exact: true }).click();
  await page.getByLabel('가져올 활동 JSON').setInputFiles(fixture);
  await expect(page.getByText('가져오기 미리보기: 1개 세션')).toBeVisible();
  await page.getByRole('button', { name: '확인하고 가져오기' }).click();
  await expect(page.getByText('기록 1개', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '제목 미확인', exact: true }).click();
  await page.getByLabel('정정 제목').fill('정정한 활동');
  await page.getByLabel('정정 거리 (m)').fill('0');
  await page.getByLabel('정정 사유').fill('관측된 0을 명시');
  await page.getByRole('button', { name: '정정 저장' }).click();
  await expect(page.getByRole('button', { name: '정정한 활동', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '확인하고 가져오기' }).click();
  await expect(page.getByText('기록 1개 · 알려진 거리 합계 0m (1개 관측)')).toBeVisible();
  await page.getByRole('button', { name: '로컬 삭제', exact: true }).click();
  await page.getByRole('button', { name: '삭제 확인', exact: true }).click();
  await expect(page.getByText('기록 0개', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '확인하고 가져오기' }).click();
  await page.reload();
  await expect(page.getByText('가져온 활동이 없습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '정정한 활동', exact: true })).toBeHidden();
});
