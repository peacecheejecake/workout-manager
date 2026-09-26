import { expect, test } from '@playwright/test';
import { shells } from './course-editor-support';

const sharedLine = {
  coordinates: [
    [127.02, 37.5],
    [127.03, 37.51],
  ],
  waypoints: [
    { role: 'start', position: [127.02, 37.5] },
    { role: 'finish', position: [127.03, 37.51] },
  ],
  distanceMeters: 1400,
  expiresOn: '2099-01-01',
};

for (const shell of shells) {
  test(`${shell.name}: shared routed line credits OSM even without a background map`, async ({
    page,
  }) => {
    await page.route('**/bff/v1/shared/course', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...sharedLine, routeDataNotice: true }),
      });
    });
    await page.goto(`${shell.origin}/shared/course#${'a'.repeat(43)}`);
    await page.getByRole('button', { name: '코스 보기' }).click();
    await expect(page.getByTestId('shared-course-expiry')).toHaveText('2099-01-01');
    const notice = page.getByTestId('route-data-notice');
    await expect(notice).toContainText('OpenStreetMap');
    await expect(notice.getByRole('link', { name: 'ODbL 1.0 라이선스' })).toBeVisible();
    await expect(notice.getByRole('link', { name: '지도 데이터 변경 방법' })).toBeVisible();
    expect(page.url()).not.toContain('#');
  });

  test(`${shell.name}: a non-routed shared line has no routing credit`, async ({ page }) => {
    await page.route('**/bff/v1/shared/course', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(sharedLine),
      });
    });
    await page.goto(`${shell.origin}/shared/course#${'b'.repeat(43)}`);
    await page.getByRole('button', { name: '코스 보기' }).click();
    await expect(page.getByTestId('shared-course-expiry')).toHaveText('2099-01-01');
    await expect(page.getByTestId('route-data-notice')).toHaveCount(0);
  });
}
