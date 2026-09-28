import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { identityMobileOrigin, identityWebOrigin } from '../../scripts/fixtures/identity-ports';

for (const [shell, origin] of [
  ['Next', identityWebOrigin],
  ['Vite', identityMobileOrigin],
] as const) {
  test(`${shell}: HealthKit review stays read-only until a confirmed choice at 320px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${origin}/account`);
    await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
    await page.getByRole('link', { name: 'Sign in as Alice' }).click();
    await expect(page.getByRole('heading', { name: 'Apple 건강' })).toBeVisible();
    await expect(
      page.getByText('HealthKit 운동 연동은 iPhone 앱에서 사용할 수 있습니다.'),
    ).toBeVisible();

    const sampleId = randomUUID();
    const activityId = randomUUID();
    const writes: unknown[] = [];
    await page.route('**/bff/v1/healthkit/workout-review?*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              sampleId,
              expectedSampleDigest: 'a'.repeat(64),
              kind: 'running',
              observedFrom: '2026-09-28T06:00:00Z',
              observedTo: '2026-09-28T06:35:00Z',
              durationSeconds: 2100,
              distanceMeters: 0,
            },
          ],
        }),
      });
    });
    await page.route('**/bff/v1/healthkit/workout-activities', async (route) => {
      writes.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sampleId,
          activityId,
          activityRevision: 1,
          state: 'created_activity',
        }),
      });
    });
    await page.goto(`${origin}/activities`);
    const opener = page.getByRole('button', { name: '검토할 운동 확인' });
    await opener.focus();
    await opener.press('Enter');
    const sample = page.getByRole('radio', { name: /달리기.*거리 0m/ });
    await expect(sample).toBeVisible();
    await sample.check();
    const commit = page.getByRole('button', { name: '새 활동 기록 확정' });
    await expect(commit).toBeDisabled();
    expect(writes).toHaveLength(0);
    await page.getByRole('checkbox', { name: '선택한 원본과 처리 방법을 확인했습니다.' }).check();
    await commit.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      sampleId,
      expectedSampleDigest: 'a'.repeat(64),
      confirmed: true,
    });
    await expect(page).toHaveURL(new RegExp(`selected=${activityId}`));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
