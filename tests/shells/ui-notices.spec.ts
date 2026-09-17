import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('UI license link serves the generated notices and matching manifest', async ({ page }) => {
  await page.goto('/ui-spike');
  const link = page.getByRole('link', { name: '오픈소스 라이선스 고지' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/dist/notices/THIRD_PARTY_NOTICES.txt');
  await link.focus();
  await expect(link).toBeFocused();
  const response = await page.request.get('/dist/notices/THIRD_PARTY_NOTICES.txt');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/plain');
  const bytes = await response.body();
  const body = bytes.toString('utf8');
  for (const text of [
    'maplibre-gl@6.9.1',
    'echarts@6.1.0',
    'murmurhash-js@1.0.0',
    'Copyright (c) 2011 Gary Court',
    'licenses/LICENSE-d3',
  ]) {
    expect(body).toContain(text);
  }
  const manifest = await page.request.get('/dist/notices/manifest.json');
  expect(manifest.status()).toBe(200);
  expect(await manifest.json()).toMatchObject({
    schemaVersion: 1,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await link.click();
  await expect(page).toHaveURL(/\/dist\/notices\/THIRD_PARTY_NOTICES\.txt$/);
  await expect(page.locator('body')).toContainText('Copyright (c) 2011 Gary Court');
});
