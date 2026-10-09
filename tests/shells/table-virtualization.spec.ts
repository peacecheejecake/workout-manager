import { expect, test, type Page } from '@playwright/test';

async function openTable(page: Page) {
  await page.goto('/ui-spike');
  // Root adds this explicit lazy entry; the existing chart/1000-row panel stays unopened.
  await page.getByRole('button', { name: '표 가상화 검증 열기', exact: true }).click();
  const panel = page.getByRole('region', { name: '표 가상화 검증', exact: true });
  await expect(panel).toBeVisible();
  return {
    panel,
    viewport: panel.getByRole('region', { name: '합성 표 스크롤', exact: true }),
    table: panel.getByRole('table', { name: '독립 합성 10000행 표', exact: true }),
  };
}

async function boundedRows(page: Page) {
  const rows = page.locator('[data-fixture-id]');
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(80);
}

test('full logical 10k roster stays bounded in DOM and distinguishes null from zero', async ({
  page,
}) => {
  const { panel, table } = await openTable(page);
  await expect(table).toHaveAttribute('aria-rowcount', '10001');
  await expect(panel.getByRole('status', { name: '합성 표 상태' })).toContainText(
    '적재 10000행 · 필터 결과 10000행 · 서버 전체 알 수 없음',
  );
  await expect(table.locator('[data-fixture-id="fixture-00000"]')).toContainText('미확인');
  await expect(table.locator('[data-fixture-id="fixture-00001"]')).toContainText('0 km');
  await boundedRows(page);
  await panel.getByRole('button', { name: '9999번 합성 행으로 이동', exact: true }).focus();
  await page.keyboard.press('Enter');
  const last = table.locator('[data-fixture-id="fixture-09999"]');
  await expect(last.getByRole('button', { name: '가상 행 09999 선택', exact: true })).toBeFocused();
  await expect(last).toHaveAttribute('aria-rowindex', '10001');
  await page.keyboard.press('Space');
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await boundedRows(page);
  await expect(table).toHaveAttribute('aria-rowcount', '10001');
});

test('controlled sorting preserves ID tie breaks and filter counts without changing the input roster', async ({
  page,
}) => {
  const { panel, table } = await openTable(page);
  await panel.getByRole('button', { name: '합성 거리 정렬', exact: true }).click();
  await expect(table.getByRole('columnheader', { name: '합성 거리 정렬' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  await expect(table.locator('tbody tr[data-fixture-id]').first()).toHaveAttribute(
    'data-fixture-id',
    'fixture-00001',
  );
  const firstTwo = await table
    .locator('tbody tr[data-fixture-id]')
    .evaluateAll((rows) => rows.slice(0, 2).map((row) => row.getAttribute('data-fixture-id')));
  expect(firstTwo).toEqual(['fixture-00001', 'fixture-00012']);
  await panel.getByLabel('합성 행 검색', { exact: true }).fill('가상 행 09999');
  await expect(table).toHaveAttribute('aria-rowcount', '2');
  await expect(panel.getByRole('status', { name: '합성 표 상태' })).toContainText(
    '적재 10000행 · 필터 결과 1행',
  );
  await expect(table.locator('[data-fixture-id]')).toHaveCount(1);
  await panel.getByLabel('합성 행 검색', { exact: true }).fill('없는 검색어');
  await expect(table).toHaveAttribute('aria-rowcount', '1');
  await expect(
    panel.getByText('검색 결과가 없습니다. 적재된 10,000행이 삭제된 것은 아닙니다.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: '9999번 합성 행으로 이동', exact: true }),
  ).toBeDisabled();
  await panel.getByLabel('합성 행 검색', { exact: true }).fill('');
  await expect(table).toHaveAttribute('aria-rowcount', '10001');
  await boundedRows(page);
});

test('real wheel scrolling retains a focused offscreen row and explicit filtering restores focus', async ({
  page,
}) => {
  const { panel, table, viewport } = await openTable(page);
  const selected = table.getByRole('button', { name: '가상 행 00000 선택', exact: true });
  await selected.focus();
  await page.keyboard.press('Enter');
  const box = await viewport.boundingBox();
  if (!box) throw new Error('VIEWPORT_NOT_VISIBLE');
  await page.mouse.move(box.x + 20, box.y + 100);
  await page.mouse.wheel(0, 30000);
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  await expect(selected).toBeFocused();
  await expect(table.locator('[data-fixture-id="fixture-00000"]')).toHaveCount(1);
  await boundedRows(page);
  // Return with an explicit non-drag control before invoking the row's keyboard alternative.
  await panel.getByRole('button', { name: '첫 논리 행으로 이동', exact: true }).click();
  const filterAction = table.getByRole('button', {
    name: '가상 행 00000 대신 다른 행만 보기',
    exact: true,
  });
  await filterAction.focus();
  await page.keyboard.press('Enter');
  await expect(panel.getByLabel('합성 행 검색', { exact: true })).toBeFocused();
  await expect(table.locator('[data-fixture-id="fixture-00000"]')).toHaveCount(0);
  await expect(table).toHaveAttribute('aria-rowcount', '2');
  await expect(panel.getByRole('status', { name: '합성 표 상태' })).toContainText(
    '선택 fixture-00000 · 선택 행은 현재 필터 밖',
  );
});

test('ResizeObserver measures expanded rows and responsive changes preserve state and anchor', async ({
  page,
}) => {
  const { panel, table, viewport } = await openTable(page);
  const first = table.locator('[data-fixture-id="fixture-00000"]');
  const beforeTotalHeight = Number(await viewport.getAttribute('data-virtual-total-height'));
  expect(Number.isFinite(beforeTotalHeight)).toBe(true);
  const beforeHeight = await first.evaluate((element) => element.getBoundingClientRect().height);
  await first.getByRole('button', { name: '가상 행 00000 메모 펼치기', exact: true }).click();
  await expect
    .poll(() => first.evaluate((element) => element.getBoundingClientRect().height))
    .toBeGreaterThan(beforeHeight);
  await expect
    .poll(async () => Number(await viewport.getAttribute('data-virtual-total-height')))
    .toBeGreaterThan(beforeTotalHeight);
  const height = await first.evaluate((element) => element.getBoundingClientRect().height);
  const nextTop = await table
    .locator('[data-fixture-id="fixture-00001"]')
    .evaluate((element) => element.getBoundingClientRect().top);
  const firstTop = await first.evaluate((element) => element.getBoundingClientRect().top);
  expect(nextTop - firstTop).toBeGreaterThanOrEqual(height - 1);
  await panel.getByRole('button', { name: '9999번 합성 행으로 이동', exact: true }).focus();
  await page.keyboard.press('Enter');
  const lastSelect = table.getByRole('button', { name: '가상 행 09999 선택', exact: true });
  await expect(lastSelect).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel.getByLabel('표 스크롤 기준', { exact: true })).not.toHaveText('기준 행 없음');
  const anchor = await panel.getByLabel('표 스크롤 기준', { exact: true }).textContent();
  for (const width of [320, 767, 768, 1279, 1280]) {
    const priorWidth = await viewport.getAttribute('data-viewport-width');
    await page.setViewportSize({ width, height: 900 });
    await expect(lastSelect).toBeFocused();
    await expect(panel.getByRole('status', { name: '합성 표 상태' })).toContainText(
      '선택 fixture-09999',
    );
    await expect(panel.getByLabel('표 스크롤 기준', { exact: true })).toHaveText(anchor ?? '');
    if (width === 320)
      await expect(viewport).not.toHaveAttribute('data-viewport-width', priorWidth ?? '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await boundedRows(page);
  }
  await panel.getByRole('button', { name: '첫 논리 행으로 이동', exact: true }).click();
  await expect(
    table.getByRole('button', { name: '가상 행 00000 메모 접기', exact: true }),
  ).toBeVisible();
});

test('explicit all-row reading and emulated touch alternatives retain the same logical identities', async ({
  page,
  browser,
}, testInfo) => {
  const { panel, table } = await openTable(page);
  await table.getByRole('button', { name: '가상 행 00000 선택', exact: true }).click();
  await panel.getByRole('button', { name: '전체 행 읽기', exact: true }).click();
  await expect(table.locator('[data-fixture-id]')).toHaveCount(10000);
  await expect(table).toHaveAttribute('aria-rowcount', '10001');
  await expect(table.locator('tbody button')).toHaveCount(0);
  await expect(table.locator('[data-fixture-id="fixture-00000"]')).toContainText('현재 선택됨');
  await expect(table.locator('[data-fixture-id="fixture-00000"]')).toContainText('미확인');
  await expect(table.locator('[data-fixture-id="fixture-00000"]')).toContainText(
    '한글 긴 메모 · 실제 운동이나 승인 기록이 아닙니다.',
  );
  await expect(table.locator('[data-fixture-id="fixture-00001"]')).toContainText('0 km');
  await panel.getByLabel('합성 대상 번호 (0~9999)', { exact: true }).fill('1');
  await panel.getByRole('button', { name: '입력한 합성 행 선택', exact: true }).click();
  await expect(table.locator('[data-fixture-id="fixture-00001"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(table.locator('[data-fixture-id="fixture-00001"] th')).toBeFocused();
  await panel.getByRole('button', { name: '가상 행 보기', exact: true }).click();
  await boundedRows(page);
  await expect(panel.getByRole('status', { name: '합성 표 상태' })).toContainText(
    '선택 fixture-00001',
  );
  const baseURL = testInfo.project.use.baseURL;
  if (!baseURL) throw new Error('SHELL_BASE_URL_REQUIRED');
  const context = await browser.newContext({
    baseURL,
    hasTouch: true,
    isMobile: true,
    viewport: { width: 320, height: 800 },
  });
  try {
    const touchPage = await context.newPage();
    await touchPage.addInitScript(() =>
      document.addEventListener('pointerdown', (event) => {
        document.documentElement.dataset.tablePointerType = event.pointerType;
      }),
    );
    await touchPage.goto('/ui-spike');
    await touchPage.getByRole('button', { name: '표 가상화 검증 열기', exact: true }).tap();
    await touchPage.getByRole('button', { name: '9999번 합성 행으로 이동', exact: true }).tap();
    await expect(
      touchPage.getByRole('button', { name: '가상 행 09999 선택', exact: true }),
    ).toBeFocused();
    await expect(touchPage.locator('html')).toHaveAttribute('data-table-pointer-type', 'touch');
    await boundedRows(touchPage);
    expect(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await context.close();
  }
});
