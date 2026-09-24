import { defineConfig } from '@playwright/test';
import identity from './playwright.identity.config';

/**
 * M2-01k-f browser budget: the identity harness (real OIDC, API, PostgreSQL, object storage,
 * self-hosted basemap, both shells) with a separate test directory.
 *
 * A separate config on purpose. The browser budget is judged on a shared machine, so it runs
 * as its own step (`npx playwright test --config playwright.performance.config.ts`, under the
 * harness lock) and never inside
 * `pnpm test:identity`, where a slow machine would fail unrelated work.
 *
 * `--enable-precise-memory-info` makes `performance.memory` report exact numbers instead of
 * Chromium's bucketed ones, and `--js-flags=--expose-gc` lets the spec collect garbage before
 * reading the retained heap.
 */
export default defineConfig({
  ...identity,
  testDir: './tests/performance',
  timeout: 900_000,
  use: {
    ...identity.use,
    launchOptions: { args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] },
  },
});
