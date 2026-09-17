import { expect, test } from '@playwright/test';

// NEG-SYN-02 revision 2 uses a local synthetic plane and an injected response queue.
// These checks establish draft/error behavior, never provider or walking coverage.
test('routing errors preserve waypoints and require an explicit new request', async ({
  page,
  baseURL,
}) => {
  if (!baseURL) throw new Error('Expected configured shell URL');
  const origin = new URL(baseURL).origin;
  const externalRequests: string[] = [];
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) {
      await route.continue();
    } else {
      externalRequests.push(route.request().url());
      await route.abort();
    }
  });
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: '라우팅 오류 검증 열기' }).click();
  const panel = page.getByRole('region', { name: '라우팅 오류 복구 검증', exact: true });
  await expect(panel).toContainText('초안 수정 번호: 1');
  for (const scenario of ['429', 'timeout', 'NoRoute']) {
    await panel.getByLabel('합성 응답 시나리오').selectOption(scenario);
    await panel.getByRole('button', { name: '경로 요청', exact: true }).click();
    await panel.getByRole('button', { name: '대기 응답 전달', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText(scenario);
    await expect(panel).toContainText('초안 수정 번호: 1');
    await expect(panel).toContainText('합성 도착점: B');
    await expect(panel).toContainText('대기 응답: 0');
    await expect(
      panel.getByRole('img', { name: '합성 계산 결과 · 실제 보행 경로 아님' }),
    ).toHaveCount(0);
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await expect(panel.getByRole('alert')).toContainText('NoRoute');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(externalRequests).toEqual([]);
});

test('stale routing success cannot replace an edited draft or newer result', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: '라우팅 오류 검증 열기' }).click();
  const panel = page.getByRole('region', { name: '라우팅 오류 복구 검증', exact: true });
  await panel.getByLabel('합성 응답 시나리오').selectOption('success');
  await panel.getByRole('button', { name: '경로 요청', exact: true }).click();
  await panel.getByRole('button', { name: '합성 도착점 바꾸기' }).click();
  await expect(panel).toContainText('초안 수정 번호: 2');
  await expect(panel).toContainText('합성 도착점: C');
  await panel.getByRole('button', { name: '경로 요청', exact: true }).click();
  await panel.getByRole('button', { name: '최신 응답 전달', exact: true }).click();
  await expect(
    panel.getByRole('img', { name: '합성 계산 결과 · 실제 보행 경로 아님' }),
  ).toBeVisible();
  const result = await panel.getByRole('status').textContent();
  const geometry = panel
    .getByRole('img', { name: '합성 계산 결과 · 실제 보행 경로 아님' })
    .locator('polyline');
  await expect(geometry).toHaveAttribute('points', '20,20 50,45 80,80');
  await panel.getByRole('button', { name: '대기 응답 전달', exact: true }).click();
  if (result === null) throw new Error('Expected routing status text');
  await expect(panel.getByRole('status')).toHaveText(result);
  await expect(geometry).toHaveAttribute('points', '20,20 50,45 80,80');
  await expect(panel).toContainText('합성 도착점: C');
  await panel.getByRole('button', { name: '합성 도착점 바꾸기' }).click();
  await expect(
    panel.getByRole('img', { name: '합성 계산 결과 · 실제 보행 경로 아님' }),
  ).toHaveCount(0);
  await panel.getByRole('button', { name: '경로 요청', exact: true }).click();
  await panel.getByRole('button', { name: '경로 요청 취소', exact: true }).click();
  await panel.getByRole('button', { name: '대기 응답 전달', exact: true }).click();
  await expect(
    panel.getByRole('img', { name: '합성 계산 결과 · 실제 보행 경로 아님' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '라우팅 오류 검증 닫기' }).click();
  await page.getByRole('button', { name: '라우팅 오류 검증 열기' }).click();
  await expect(panel).toContainText('초안 수정 번호: 1');
  await expect(panel).toContainText('대기 응답: 0');
  expect(errors).toEqual([]);
});
