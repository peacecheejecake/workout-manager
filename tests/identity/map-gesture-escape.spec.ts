import { expect, test, type Locator, type Page } from '@playwright/test';
import { login, shells } from './course-editor-support';
import { mapRegion } from './map-evidence';

/**
 * M2-01k P5-gesture-escape: the real map renderer must leave ordinary page scrolling
 * and keyboard focus available. These are Chromium wheel/key events, not evidence of
 * a physical touch gesture or an OS input method.
 */
async function focusIsInside(map: Locator): Promise<boolean> {
  return map.evaluate((element) => element.contains(document.activeElement));
}

async function pageScroll(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function wheelOverMap(page: Page, canvas: Locator): Promise<void> {
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('map canvas has no bounds');
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(
    await canvas.evaluate(
      (element, at) => document.elementFromPoint(at.x, at.y) === element,
      point,
    ),
    'wheel target is the map canvas',
  ).toBe(true);
  await page.mouse.move(point.x, point.y);
  const before = await pageScroll(page);
  await page.mouse.wheel(0, 340);
  await expect.poll(() => pageScroll(page)).toBeGreaterThan(before);
}

async function keyboardLeavesMap(page: Page, map: Locator, key: 'Tab' | 'Shift+Tab') {
  for (let press = 0; press < 12 && (await focusIsInside(map)); press += 1)
    await page.keyboard.press(key);
  const focus = await map.evaluate((element) => {
    const active = document.activeElement;
    return {
      inside: element.contains(active),
      focusable:
        active instanceof HTMLElement &&
        active.matches('a[href], button, input, textarea, select, [tabindex]') &&
        active.tabIndex >= 0 &&
        !active.hasAttribute('disabled') &&
        active.getClientRects().length > 0,
    };
  });
  expect(focus.inside, `${key} leaves the map region`).toBe(false);
  expect(focus.focusable, `${key} reaches another focusable control`).toBe(true);
}

for (const shell of shells) {
  test(`${shell.name} course map releases page wheel scrolling and keyboard focus`, async ({
    page,
  }) => {
    await login(page);
    await page.setViewportSize({ width: 390, height: 500 });
    await page.goto(`${shell.origin}/courses/new`);

    const screen = page.getByRole('region', { name: '새 코스' });
    const map = mapRegion(screen, '코스 지도');
    const canvas = map.locator('canvas').first();
    await expect(canvas).toBeVisible();
    await expect(screen.getByRole('region', { name: '경유지 편집' })).toBeVisible();

    // The cursor stays over the renderer. A normal wheel must scroll the document,
    // including after repeated map interaction, rather than getting trapped by the map.
    await wheelOverMap(page, canvas);
    await canvas.focus();
    await wheelOverMap(page, canvas);

    // Check both directions from the focused MapLibre canvas. The assertion is on
    // actual DOM focus, so a key handler that merely announces an escape cannot pass.
    await canvas.focus();
    await expect.poll(() => focusIsInside(map)).toBe(true);
    await keyboardLeavesMap(page, map, 'Tab');

    await canvas.focus();
    await expect.poll(() => focusIsInside(map)).toBe(true);
    await keyboardLeavesMap(page, map, 'Shift+Tab');
  });
}
