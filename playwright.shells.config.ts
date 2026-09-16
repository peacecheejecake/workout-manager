import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/shells',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'next-desktop',
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:3100' },
    },
    { name: 'vite-mobile', use: { ...devices['Pixel 7'], baseURL: 'http://127.0.0.1:4200' } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @workout/web start',
      url: 'http://127.0.0.1:3100',
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @workout/mobile-web preview',
      url: 'http://127.0.0.1:4200',
      reuseExistingServer: false,
    },
  ],
});
