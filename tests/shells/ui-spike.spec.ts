import { test, expect } from '@playwright/test';

// CI software WebGL checks worker/build compatibility, not physical GPU performance.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('library composition keeps editor input across resize and links chart/table state', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: '검증 도구 열기' }).click();
  const chart = page.getByRole('img', { name: '가상 거리 차트' });
  await expect(chart.locator('svg')).toBeVisible();
  await page.getByRole('button', { name: '거리 정렬', exact: true }).click();
  const table = page.getByRole('table', { name: '가상 활동 표', exact: true });
  await expect(table.locator('tbody tr').first()).toContainText('가상 러닝 D');
  await page.getByRole('button', { name: '거리 정렬', exact: true }).click();
  await expect(table.locator('tbody tr').first()).toContainText('가상 0km C');
  await expect(table.locator('tbody tr').last()).toContainText('미확인');
  await page.getByRole('button', { name: '가상 러닝 A 선택' }).click();
  await expect(page.getByText('표시 4개 · 선택 가상 러닝 A')).toBeVisible();
  await page.getByLabel('활동 검색', { exact: true }).fill('없는 제목');
  await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible();
  await page.getByLabel('활동 검색', { exact: true }).fill('');
  await page.getByRole('button', { name: '대량 1000행' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(1000);
  await page.getByRole('button', { name: '차트 확대', exact: true }).click();
  await expect(page.getByRole('slider', { name: '차트 구간 시작 (%)' })).toBeVisible();
  await page.getByRole('button', { name: '차트 전체 보기' }).click();
  await page.getByRole('button', { name: '기본 4행' }).click();
  const editor = page.getByRole('textbox', { name: '개발 메모 편집기' });
  await editor.fill('한글 초안 <script>문자열</script>');
  await editor.focus();
  await editor.dispatchEvent('compositionstart', { data: '한' });
  for (const width of [320, 767, 768, 1279, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(editor).toBeFocused();
    await expect(editor).toContainText('한글 초안');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await editor.dispatchEvent('compositionend', { data: '한글' });
  await page.getByRole('button', { name: 'JSON 초안 확인' }).click();
  await expect(page.getByLabel('편집기 JSON 초안')).toHaveValue(/<script>문자열<\/script>/);
  expect(errors).toEqual([]);
});

test('real keyboard sort, cancel and panel resize preserve the draft', async ({ page }) => {
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: '검증 도구 열기' }).click();
  const order = page.getByRole('status', { name: '현재 합성 순서' });
  const handle = page.getByRole('button', { name: '준비 운동 예시 이동 손잡이' });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(order).toHaveText('현재 순서: 본 운동 예시 → 준비 운동 예시 → 정리 운동 예시');
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(order).toHaveText('현재 순서: 본 운동 예시 → 준비 운동 예시 → 정리 운동 예시');
  await page.getByRole('button', { name: '준비 운동 예시 위로' }).click();
  await expect(order).toHaveText('현재 순서: 준비 운동 예시 → 본 운동 예시 → 정리 운동 예시');
  const draft = page.getByLabel('크기 조절 중 유지할 초안');
  await draft.fill('패널 크기가 바뀌어도 유지');
  const separator = page.getByRole('separator', { name: '정렬과 메모 패널 크기 조절' });
  const before = await separator.getAttribute('aria-valuenow');
  await separator.focus();
  await page.keyboard.press('ArrowUp');
  await expect(separator).not.toHaveAttribute('aria-valuenow', before ?? '');
  await expect(draft).toHaveValue('패널 크기가 바뀌어도 유지');
  const draftBox = await draft.boundingBox();
  const mapBox = await page.getByRole('region', { name: '지도 worker 검증' }).boundingBox();
  expect(draftBox).not.toBeNull();
  expect(mapBox).not.toBeNull();
  expect((draftBox?.y ?? 0) + (draftBox?.height ?? 0)).toBeLessThan(mapBox?.y ?? 0);
});

test('editor bold state follows formatting, undo and keyboard shortcuts', async ({ page }) => {
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: '검증 도구 열기' }).click();
  const editor = page.getByRole('textbox', { name: '개발 메모 편집기' });
  const bold = page.getByRole('button', { name: '굵게 전환' });
  await editor.fill('서식 검증');
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await editor.press('ControlOrMeta+a');
  await bold.click();
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('strong')).toHaveText('서식 검증');
  await page.getByRole('button', { name: '편집 실행 취소' }).click();
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
  await expect(editor.locator('strong')).toHaveCount(0);
  await editor.press('ControlOrMeta+b');
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await editor.press('ControlOrMeta+b');
  await expect(bold).toHaveAttribute('aria-pressed', 'false');
});

test('same-origin map worker renders and disposes without external tile requests', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.hostname !== '127.0.0.1') external.push(url.origin);
  });
  const response = await page.goto('/ui-spike');
  expect(response?.headers()['content-security-policy']).toContain("worker-src 'self'");
  await page.getByRole('button', { name: '검증 도구 열기' }).click();
  await expect(page.getByText('지도 worker와 합성 선 표시 확인')).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '지도 해제', exact: true }).click();
  await expect(page.getByText('지도 리소스 해제됨')).toBeVisible();
  await expect(page.locator('.maplibregl-canvas')).toHaveCount(0);
  await page.getByRole('button', { name: '지도 다시 열기', exact: true }).click();
  await expect(page.getByText('지도 worker와 합성 선 표시 확인')).toBeVisible();
  expect(external).toEqual([]);
});

test('missing WebGL retains the accessible coordinate alternative', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = new Proxy(HTMLCanvasElement.prototype.getContext, {
      apply(target, receiver, args) {
        return args[0] === 'webgl2' ? null : Reflect.apply(target, receiver, args);
      },
    });
  });
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: '검증 도구 열기' }).click();
  await expect(
    page.getByText('지도 표시 불가 · 아래 좌표 목록은 계속 사용할 수 있습니다.'),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: '합성 좌표 목록' })).toContainText('126.978, 37.566');
});
