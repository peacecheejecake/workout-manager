import { expect, test } from '@playwright/test';
import { identityMobileOrigin } from '../../scripts/fixtures/identity-ports';

test('bundled native entry does not mount browser auth or call the cookie API', async ({
  page,
}) => {
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/bff/')) apiRequests.push(request.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'CapacitorCustomPlatform', {
      value: { name: 'ios' },
      configurable: true,
    });
  });

  await page.goto(`${identityMobileOrigin}/account`);

  await expect(page.getByRole('heading', { name: 'Workout Manager' })).toBeVisible();
  await expect(
    page.getByText('앱 내 로그인과 건강 데이터 연결은 아직 사용할 수 없습니다.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '계정과 개인정보' })).toHaveCount(0);
  expect(apiRequests).toEqual([]);
});
