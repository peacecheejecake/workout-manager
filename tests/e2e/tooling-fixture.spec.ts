import { expect, test } from '@playwright/test';

test('validates keyboard input and receives a local mock HTTP confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a message before sending.');
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill('Fixture request');
  await input.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Confirmed: Fixture request');
  await expect(input).toHaveValue('Fixture request');
});

test('retains draft after a failed HTTP request and succeeds on retry', async ({ page }) => {
  await page.route('**/fixture-api/echo', (route) => route.fulfill({ status: 503 }), { times: 1 });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'Message' });
  await input.fill('Draft survives failure');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('alert')).toContainText('Your draft is preserved');
  await expect(input).toHaveValue('Draft survives failure');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('status')).toHaveText('Confirmed: Draft survives failure');
});
