import { test, expect } from '@playwright/test';
import { viewportFixtures, getLayoutMode } from '../../packages/ui/foundation/src/responsive';

test('generated viewport matrix keeps focused draft and reflows all information', async ({
  page,
}) => {
  await page.goto('/');
  const note = page.getByLabel('작업 메모 (임시)');
  await note.fill('뷰포트 변경 중 유지할 메모');
  await note.focus();
  for (const fixture of viewportFixtures) {
    await page.setViewportSize({ width: fixture.width, height: fixture.height });
    await expect(note).toHaveValue('뷰포트 변경 중 유지할 메모');
    await expect(note).toBeFocused();
    expect(
      await page
        .locator('.wm-page')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--layout-mode').trim()),
    ).toBe(getLayoutMode(fixture.width));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('region', { name: '활동', exact: true }).evaluate((el) => {
    el.style.width = '420px';
    el.style.boxSizing = 'border-box';
  });
  await expect(note).toHaveValue('뷰포트 변경 중 유지할 메모');
  await expect(note).toBeFocused();
  expect(
    await page
      .locator('[data-view]')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--container-mode').trim()),
  ).toBe('compact');
  await expect(page.getByText('시간 미확인', { exact: true })).toBeVisible();
});

test('explicit views retain composition input; keyboard controls and reduced motion remain usable', async ({
  page,
}) => {
  await page.goto('/');
  const note = page.getByLabel('작업 메모 (임시)');
  await note.focus();
  await note.dispatchEvent('compositionstart', { data: '메' });
  await note.fill('메모');
  await page.setViewportSize({ width: 320, height: 700 });
  await note.dispatchEvent('compositionend', { data: '메모' });
  await expect(note).toHaveValue('메모');
  await page.getByRole('button', { name: '세로 보기' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '세로 보기' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(note).toHaveValue('메모');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .getByRole('button', { name: '메모 초기화' })
      .evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s');
  await page.locator('html').evaluate((el) => {
    el.style.fontSize = '200%';
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
