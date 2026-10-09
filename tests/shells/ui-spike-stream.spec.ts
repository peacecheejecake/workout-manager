import { test, expect, type Page } from '@playwright/test';

// Local synthetic presentation only: no provider/server/domain approval evidence.
async function open(page: Page) {
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: 'Streaming 합성 검증 열기', exact: true }).click();
  return page.getByRole('region', { name: 'Streaming 합성 조합 검증', exact: true });
}
test('stream panel starts empty and labels its synthetic authority boundary', async ({ page }) => {
  const panel = await open(page);
  await expect(
    panel.getByText('합성 자료만 사용하는 로컬 표시 실험입니다.', { exact: false }),
  ).toBeVisible();
  await expect(panel.getByRole('region', { name: '합성 실행 표시', exact: true })).toHaveAttribute(
    'data-stream-phase',
    'active',
  );
  await expect(panel.getByText('작성 중인 내용 · 미검증')).toHaveCount(0);
  await expect(panel.getByRole('status', { name: '합성 초안 확인 횟수' })).toHaveText(
    '합성 초안 확인 횟수: 0',
  );
});
test('cumulative plaintext and readonly tool results cannot inject markup or submit a draft', async ({
  page,
}) => {
  const panel = await open(page);
  const input = panel.getByRole('textbox', { name: '합성 메시지 초안', exact: true });
  await input.fill('한글\n보존할 초안');
  await panel.getByRole('button', { name: '합성 텍스트 추가', exact: true }).click();
  await panel.getByRole('button', { name: '합성 텍스트 추가', exact: true }).click();
  await expect(
    panel.getByText('합성 응답 <b>태그</b> 합성 응답 <b>태그</b>', { exact: true }),
  ).toBeVisible();
  await panel.getByRole('button', { name: '합성 도구 시작', exact: true }).click();
  await expect(panel.getByText('합성 자료 검색 · 진행 중', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '합성 도구 결과', exact: true }).click();
  await expect(
    panel.getByText('<script>합성 결과</script> 계산 값 0 (합성)', { exact: true }),
  ).toBeVisible();
  await expect(panel.locator('script, b')).toHaveCount(0);
  await panel.getByRole('button', { name: '합성 실행 완료', exact: true }).click();
  await expect(panel.getByRole('region', { name: '합성 실행 표시', exact: true })).toHaveAttribute(
    'data-stream-phase',
    'terminal',
  );
  await expect(
    panel.getByText('생성이 끝났습니다. 검증과 승인은 별도로 진행합니다.', { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue('한글\n보존할 초안');
  await expect(panel.getByRole('status', { name: '합성 초안 확인 횟수' })).toHaveText(
    '합성 초안 확인 횟수: 0',
  );
  await expect(panel.getByRole('button', { name: '합성 텍스트 추가', exact: true })).toBeDisabled();
});
test('draft focus and synthetic composition survive stream events and responsive boundaries', async ({
  page,
}) => {
  const panel = await open(page);
  const input = panel.getByRole('textbox', { name: '합성 메시지 초안', exact: true });
  await input.fill('한글\nIME 초안');
  await input.focus();
  await input.dispatchEvent('compositionstart', { data: '한' });
  // Synthetic composition events do not establish physical native IME acceptance.
  await input.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true });
  await panel.getByRole('button', { name: '합성 텍스트 추가', exact: true }).click();
  await expect(input).toBeFocused();
  for (const width of [320, 767, 768, 1279, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('한글\nIME 초안');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await input.dispatchEvent('compositionend', { data: '한글' });
  await expect(panel.getByRole('status', { name: '합성 초안 확인 횟수' })).toHaveText(
    '합성 초안 확인 횟수: 0',
  );
});
test('new invocation clears presentation, preserves draft and rejects disposed old events', async ({
  page,
}) => {
  const panel = await open(page);
  const input = panel.getByRole('textbox', { name: '합성 메시지 초안', exact: true });
  await input.fill('남길 초안');
  await panel.getByRole('button', { name: '합성 텍스트 추가', exact: true }).click();
  await panel.getByRole('button', { name: '새 합성 실행', exact: true }).click();
  await expect(panel.getByText(/합성 응답/)).toHaveCount(0);
  await expect(input).toHaveValue('남길 초안');
  await panel.getByRole('button', { name: '이전 실행 늦은 입력', exact: true }).click();
  await expect(panel.getByRole('status', { name: '늦은 입력 관측' })).toHaveText(
    '이전 실행 늦은 입력 거절됨',
  );
  await expect(panel.getByText('이전 실행 비공개 합성 문자열')).toHaveCount(0);
});
test('session change clears private presentation and draft without accepting late data', async ({
  page,
}) => {
  const panel = await open(page);
  const input = panel.getByRole('textbox', { name: '합성 메시지 초안', exact: true });
  await input.fill('이전 세션 초안');
  await panel.getByRole('button', { name: '합성 도구 시작', exact: true }).click();
  await panel.getByRole('button', { name: '합성 도구 결과', exact: true }).click();
  await panel.getByRole('button', { name: '합성 세션 변경', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(panel.getByRole('list', { name: '도구 진행과 결과' })).toHaveCount(0);
  await panel.getByRole('button', { name: '이전 실행 늦은 입력', exact: true }).click();
  await expect(panel.getByRole('status', { name: '늦은 입력 관측' })).toHaveText(
    '이전 실행 늦은 입력 거절됨',
  );
  await expect(panel.getByRole('status', { name: '합성 초안 확인 횟수' })).toHaveText(
    '합성 초안 확인 횟수: 0',
  );
});
test('unmount and reopen create an empty controller lifetime with explicit-only draft confirmation', async ({
  page,
}) => {
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/bff/')) writes++;
  });
  const panel = await open(page);
  const input = panel.getByRole('textbox', { name: '합성 메시지 초안', exact: true });
  await input.fill('확인할 초안');
  await input.press('Control+Enter');
  await expect(panel.getByRole('status', { name: '합성 초안 확인 횟수' })).toHaveText(
    '합성 초안 확인 횟수: 0',
  );
  await panel.getByRole('button', { name: '합성 초안 확인', exact: true }).click();
  await expect(panel.getByRole('status', { name: '합성 초안 확인 횟수' })).toHaveText(
    '합성 초안 확인 횟수: 1',
  );
  await page.getByRole('button', { name: 'Streaming 합성 검증 닫기', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Streaming 합성 검증 열기', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '합성 메시지 초안', exact: true })).toHaveValue(
    '',
  );
  await expect(page.getByRole('status', { name: '합성 초안 확인 횟수' })).toHaveText(
    '합성 초안 확인 횟수: 0',
  );
  expect(writes).toBe(0);
});
