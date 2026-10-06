import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const browserChannel = process.env['HEALTHKIT_FIXTURE_BROWSER_CHANNEL'];
if (browserChannel !== undefined && browserChannel !== 'chrome') {
  throw new Error('HEALTHKIT_FIXTURE_BROWSER_CHANNEL must be chrome when set');
}

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  testMatch: 'selection.spec.ts',
  outputDir: '/private/tmp/wm-m3-02n-selection-e2e',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4196',
    trace: 'retain-on-failure',
    ...(browserChannel ? { channel: browserChannel } : {}),
  },
  projects: [
    { name: 'reflow-320', use: { browserName: 'chromium', viewport: { width: 320, height: 740 } } },
    { name: 'mobile-390', use: { browserName: 'chromium', viewport: { width: 390, height: 844 } } },
    {
      name: 'tablet-768',
      use: { browserName: 'chromium', viewport: { width: 768, height: 1024 } },
    },
    {
      name: 'desktop-1440',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command:
      'pnpm exec vite --config packages/tooling/fixtures/healthkit-selection/vite.config.ts --host 127.0.0.1 --port 4196 --strictPort',
    cwd: fileURLToPath(new URL('../../../..', import.meta.url)),
    url: 'http://127.0.0.1:4196',
    reuseExistingServer: !process.env['CI'],
  },
});
