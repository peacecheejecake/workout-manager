import { expect, test, type Page } from '@playwright/test';

async function openPanel(page: Page) {
  await page.goto('/ui-spike');
  await page.getByRole('button', { name: 'Overlay 조합 검증 열기', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Overlay 조합 검증' })).toBeVisible();
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('native menu escapes clipping at 320px and callbacks run only once for enabled actions', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openPanel(page);
  await expect(page.getByText('Native popover 사용 가능', { exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Clipping 내부 메뉴', exact: true });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'Clipping 내부 메뉴', exact: true });
  await expect(menu).toHaveAttribute('data-presentation', 'native-popover');
  await expect.poll(() => menu.evaluate((element) => element.matches(':popover-open'))).toBe(true);
  const boxes = await menu.evaluate((element) => {
    const clip = element.closest('[aria-label="Overflow clipping 검사 영역"]');
    if (!clip) throw new Error('CLIP_ANCESTOR_MISSING');
    const box = element.getBoundingClientRect();
    const ancestor = clip.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      ancestorTop: ancestor.top,
      ancestorBottom: ancestor.bottom,
    };
  });
  expect(boxes.bottom > boxes.ancestorBottom || boxes.top < boxes.ancestorTop).toBe(true);
  expect(boxes.left).toBeGreaterThanOrEqual(0);
  expect(boxes.right).toBeLessThanOrEqual(320);
  const disabled = menu.getByRole('menuitem', { name: '사용 불가 합성 동작', exact: true });
  await expect(disabled).toBeVisible();
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  const pointer = await disabled.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return {
      x,
      y,
      inViewport:
        box.width > 0 && box.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
      hitsDisabledItem: document.elementFromPoint(x, y)?.closest('[role="menuitem"]') === element,
    };
  });
  expect(pointer.inViewport).toBe(true);
  expect(pointer.hitsDisabledItem).toBe(true);
  // Locator.click waits for aria-disabled=false; a real pointer verifies the disabled callback guard.
  await page.mouse.click(pointer.x, pointer.y);
  await expect(page.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
    '합성 동작 횟수: 0',
  );
  await expect(menu).toBeVisible();
  await disabled.focus();
  await expect(disabled).toBeFocused();
  for (const key of ['Enter', 'Space']) {
    await page.keyboard.press(key);
    await expect(page.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
      '합성 동작 횟수: 0',
    );
    await expect(menu).toBeVisible();
  }
  await menu.getByRole('menuitem', { name: '합성 횟수 증가', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
    '합성 동작 횟수: 1',
  );
  await noPageOverflow(page);
});

test('menu Tab skips hidden ancestors and ShiftTab returns to its trigger', async ({ page }) => {
  await openPanel(page);
  const trigger = page.getByRole('button', { name: 'Clipping 내부 메뉴', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Clipping 내부 메뉴', exact: true });
  await expect(menu.getByRole('menuitem', { name: '합성 횟수 증가', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole('button', { name: '메뉴 다음 가시 동작', exact: true }),
  ).toBeFocused();
  await trigger.focus();
  await page.keyboard.press('ArrowUp');
  await expect(
    menu.getByRole('menuitem', { name: '다른 합성 횟수 증가', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('modal scopes menu keyboard navigation and Escape restores menu then launcher focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await openPanel(page);
  const launcher = page.getByRole('button', { name: '조합 모달 열기', exact: true });
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: '합성 조합 모달', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((element) => element.matches(':modal'))).toBe(true);
  await expect(
    dialog.getByRole('button', { name: '모달 첫 가시 동작', exact: true }),
  ).toBeFocused();
  const trigger = dialog.getByRole('button', { name: '모달 안 메뉴', exact: true });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  const menu = dialog.getByRole('menu', { name: '모달 안 메뉴', exact: true });
  await page.keyboard.press('ArrowDown');
  await expect(
    menu.getByRole('menuitem', { name: '사용 불가 합성 동작', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('End');
  await expect(
    menu.getByRole('menuitem', { name: '다른 합성 횟수 증가', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: '합성 횟수 증가', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(
    dialog.getByRole('button', { name: '모달 다음 가시 동작', exact: true }),
  ).toBeFocused();
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
  await trigger.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(page.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
    '합성 동작 횟수: 0',
  );
  await noPageOverflow(page);
});

test('modal close never restores focus into a newly hidden launcher ancestor', async ({ page }) => {
  await openPanel(page);
  const launcher = page.getByRole('button', { name: '조합 모달 열기', exact: true });
  await launcher.click();
  const dialog = page.getByRole('dialog', { name: '합성 조합 모달', exact: true });
  await dialog.getByRole('button', { name: '닫고 실행 버튼 숨기기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(launcher).toBeHidden();
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('[hidden],[inert]'))),
  ).toBe(false);
  await page.getByRole('button', { name: '모달 실행 버튼 복원', exact: true }).click();
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(
    dialog.getByRole('button', { name: '모달 첫 가시 동작', exact: true }),
  ).toBeFocused();
  await dialog.getByRole('button', { name: '조합 모달 닫기', exact: true }).click();
  await expect(launcher).toBeFocused();
});

test('tooltip focus and trusted emulated touch both expose and dismiss descriptive text', async ({
  page,
  browser,
}, testInfo) => {
  await openPanel(page);
  const trigger = page.getByRole('button', { name: '합성 횟수 도움말', exact: true });
  await trigger.focus();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toHaveText('횟수 증가는 합성 callback일 뿐 저장이나 승인이 아닙니다.');
  await expect(trigger).toHaveAccessibleDescription(
    '횟수 증가는 합성 callback일 뿐 저장이나 승인이 아닙니다.',
  );
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(trigger).toBeFocused();
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
    await touchPage.addInitScript(() => {
      document.addEventListener('pointerdown', (event) => {
        document.documentElement.dataset.overlayPointerType = event.pointerType;
      });
    });
    await openPanel(touchPage);
    const touchTrigger = touchPage.getByRole('button', { name: '합성 횟수 도움말', exact: true });
    await touchTrigger.tap();
    await expect(touchPage.getByRole('tooltip')).toBeVisible();
    await expect(touchPage.locator('html')).toHaveAttribute('data-overlay-pointer-type', 'touch');
    await touchTrigger.tap();
    await expect(touchPage.getByRole('tooltip')).toBeHidden();
    await expect(touchPage.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
      '합성 동작 횟수: 0',
    );
    await noPageOverflow(touchPage);
  } finally {
    await context.close();
  }
});

test('OS reduced-motion keeps modal, menu callbacks and tooltip dismissal available', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPanel(page);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--transition-duration').trim(),
    ),
  ).toMatch(/^(?:0s|0ms)$/);
  await page.getByRole('button', { name: '조합 모달 열기', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '합성 조합 모달', exact: true });
  await dialog.getByRole('button', { name: '모달 안 메뉴', exact: true }).click();
  await dialog.getByRole('menuitem', { name: '합성 횟수 증가', exact: true }).click();
  await dialog.getByRole('button', { name: '모달 도움말', exact: true }).focus();
  await expect(dialog.getByRole('tooltip')).toBeVisible();
  // Explicit close does not depend on any animation completion event.
  await dialog.getByRole('button', { name: '조합 모달 닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
    '합성 동작 횟수: 1',
  );
  await expect(page.getByRole('button', { name: '조합 모달 열기', exact: true })).toBeFocused();
});

test('missing native methods expose inline alternatives and refuse false modal success', async ({
  page,
}) => {
  await page.addInitScript(() => {
    for (const name of ['showPopover', 'hidePopover'])
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: undefined });
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: undefined,
    });
  });
  await openPanel(page);
  await expect(page.getByText(/Native popover 미지원/)).toBeVisible();
  await page.getByRole('button', { name: 'Clipping 내부 메뉴', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Clipping 내부 메뉴', exact: true });
  await expect(menu).toHaveAttribute('data-presentation', 'inline-fallback');
  await menu.getByRole('menuitem', { name: '합성 횟수 증가', exact: true }).click();
  await expect(page.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
    '합성 동작 횟수: 1',
  );
  await expect(
    page.getByText('횟수 증가는 합성 callback일 뿐 저장이나 승인이 아닙니다.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '조합 모달 열기', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Overlay 조합 검증', exact: true });
  await expect(panel.getByRole('alert')).toHaveText('Modal 사용 불가: native_dialog_unavailable');
  await expect(panel.getByRole('status', { name: '합성 동작 횟수' })).toHaveText(
    '합성 동작 횟수: 1',
  );
  await expect(page.getByRole('dialog', { name: '합성 조합 모달', exact: true })).toBeHidden();
  await noPageOverflow(page);
});
