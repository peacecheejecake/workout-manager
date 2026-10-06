import { expect, test } from '@playwright/test';

/** Synthetic bridge only. This is never evidence of UIKit or HealthKit access. */
test('explicit selection, keyboard focus, error recovery, withdrawal and reflow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '합성 앱 연결·계정 전환', exact: true }).click();
  const selection = page.getByRole('region', { name: '계정별 운동 등록', exact: true });
  await expect(selection).toHaveCount(1);
  await expect(selection.getByText('현재 계정 등록 운동: 확인되지 않음')).toBeVisible();
  const choose = page.getByRole('button', { name: 'iPhone 운동 선택·등록', exact: true });
  await choose.focus();
  await expect(choose).toBeFocused();
  await choose.press('Enter');
  await expect(page.getByText('iPhone 화면에서 운동을 선택하고 있습니다.')).toBeVisible();
  await page.getByRole('button', { name: '운동 선택 취소', exact: true }).press('Tab');
  const refresh = page.getByRole('button', { name: '운동 등록 상태 다시 확인', exact: true });
  await expect(refresh).toBeFocused();
  await expect(refresh).toHaveCSS('outline-style', 'solid');
  await page.getByLabel('등록 결과 시나리오', { exact: true }).selectOption('offline');
  await refresh.click();
  await expect(
    page.getByText('연결을 확인하지 못했습니다. 온라인에서 다시 확인하세요.'),
  ).toBeVisible();
  await page.getByLabel('등록 결과 시나리오', { exact: true }).selectOption('registered');
  await refresh.click();
  await expect(page.getByText('현재 계정 등록 운동: 1개')).toBeVisible();
  await expect(page.getByText('iPhone 운동 읽기 허용 여부: 알 수 없음')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  await page.getByRole('button', { name: 'HealthKit 동의 철회', exact: true }).click();
  await expect(selection.getByText('현재 계정 등록 운동: 확인되지 않음')).toBeVisible();
  await expect(page.getByText('최근 등록 결과: 확인되지 않음')).toBeVisible();
  await expect(choose).toBeDisabled();
});

test('account switch clears selection facts and an older host omits selection controls', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '합성 앱 연결·계정 전환', exact: true }).click();
  await page.getByRole('button', { name: 'iPhone 운동 선택·등록', exact: true }).click();
  await expect(page.getByText('선택 운동: 1개')).toBeVisible();
  await page.getByRole('button', { name: '합성 앱 연결·계정 전환', exact: true }).click();
  await expect(page.getByText('현재 계정: synthetic-account-3')).toBeVisible();
  await expect(page.getByRole('region', { name: '계정별 운동 등록', exact: true })).toHaveCount(1);
  await expect(page.getByRole('region', { name: '등록 운동 관리·해제', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByText('선택 운동: 0개', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: '구형 host (다음 연결 적용)', exact: true }).check();
  await page.getByRole('button', { name: '합성 앱 연결·계정 전환', exact: true }).click();
  await expect(page.getByText('현재 계정: synthetic-account-4')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'iPhone 운동 선택·등록', exact: true }),
  ).toHaveCount(0);
});

test('management close keeps cleanup pending, release is separate, and legacy work remains blocked', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '합성 앱 연결·계정 전환', exact: true }).click();
  const management = page.getByRole('region', { name: '등록 운동 관리·해제', exact: true });
  await expect(management.getByText(/HealthKit 원본은 삭제하지 않습니다/)).toBeVisible();
  await management.getByRole('button', { name: 'iPhone 등록 운동 관리·해제', exact: true }).click();
  await expect(
    management.getByText('관련 기록을 정리하고 있습니다. 등록 귀속은 아직 해제되지 않았습니다.'),
  ).toBeVisible();
  await management.getByRole('button', { name: '운동 관리 화면 닫기', exact: true }).click();
  await expect(management.getByText('최근 해제 완료 결과: 확인되지 않음')).toBeVisible();
  await expect(management.getByText('관련 기록 정리와 등록 귀속 해제를 확인했습니다.')).toHaveCount(
    0,
  );
  await page.getByLabel('해제 결과 시나리오', { exact: true }).selectOption('released');
  await management.getByRole('button', { name: '운동 해제 상태 다시 확인', exact: true }).click();
  await expect(management.getByText('최근 해제 완료 결과: 1개')).toBeVisible();
  await page.getByLabel('해제 결과 시나리오', { exact: true }).selectOption('legacy_blocked');
  await management.getByRole('button', { name: '운동 해제 상태 다시 확인', exact: true }).click();
  await expect(management.getByText(/과거 전송 자료의 운동 범위를 확인하지 못해/)).toBeVisible();
  await expect(management.getByText('최근 해제 완료 결과: 확인되지 않음')).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
});
