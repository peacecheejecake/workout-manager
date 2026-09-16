import { readFile, rename, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, expect, type Page } from '@playwright/test';

const origin = 'http://127.0.0.1:3100';
const output = fileURLToPath(
  new URL('../docs/implementation/research/ui-spike-performance-result.json', import.meta.url),
);
const profiles = [
  { name: 'desktop-viewport', viewport: { width: 1440, height: 900 } },
  { name: 'narrow-viewport', viewport: { width: 390, height: 844 } },
];
const repetitions = 3;

async function measure(page: Page, actionAndAssertion: () => Promise<void>) {
  const before = await page.evaluate(() => performance.now());
  await actionAndAssertion();
  const after = await page.evaluate(() => performance.now());
  return Math.round((after - before) * 100) / 100;
}

async function operations(page: Page) {
  await page.goto(`${origin}/ui-spike`, { waitUntil: 'load' });
  const table = page.getByRole('table', { name: '가상 활동 표', exact: true });
  const rows = table.locator('tbody tr');
  const chart = page.getByRole('img', { name: '가상 거리 차트', exact: true });
  const panelLoadMs = await measure(page, async () => {
    await page.getByRole('button', { name: '검증 도구 열기', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(chart.locator('svg')).toHaveCount(1);
    await expect(
      page.getByRole('textbox', { name: '개발 메모 편집기', exact: true }),
    ).toBeVisible();
  });
  // Map startup shares the initial panel load, but subsequent data operations exclude it.
  await page.getByRole('button', { name: '지도 해제', exact: true }).click();
  await expect(page.getByText('지도 리소스 해제됨', { exact: true })).toBeVisible();
  const thousandRowsMs = await measure(page, async () => {
    await page.getByRole('button', { name: '대량 1000행', exact: true }).click();
    await expect(rows).toHaveCount(1000);
    await expect(rows.first().getByRole('rowheader')).toHaveText('가상 대량 0001');
    await expect(rows.last().getByRole('rowheader')).toHaveText('가상 대량 1000');
  });
  const sort = page.getByRole('button', { name: '활동명 정렬', exact: true });
  await sort.click();
  await expect(table.getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'ascending');
  const descendingSortMs = await measure(page, async () => {
    await sort.click();
    await expect(table.getByRole('columnheader').first()).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    await expect(rows.getByRole('rowheader')).toHaveText(
      Array.from(
        { length: 1000 },
        (_, index) => `가상 대량 ${String(1000 - index).padStart(4, '0')}`,
      ),
    );
  });
  const singleRowFilterMs = await measure(page, async () => {
    await page.getByRole('textbox', { name: '활동 검색', exact: true }).fill('0999');
    await expect(rows).toHaveCount(1);
    await expect(rows.getByRole('rowheader')).toHaveText(['가상 대량 0999']);
    await expect(rows.getByRole('cell').first()).toHaveText('9.8 km');
  });
  return { panelLoadMs, thousandRowsMs, descendingSortMs, singleRowFilterMs };
}

async function previousRuns(): Promise<unknown[]> {
  try {
    const previous: unknown = JSON.parse(await readFile(output, 'utf8'));
    if (
      typeof previous !== 'object' ||
      previous === null ||
      !('executedAt' in previous) ||
      typeof previous.executedAt !== 'string' ||
      !('previousRuns' in previous) ||
      !Array.isArray(previous.previousRuns)
    )
      throw new Error('INVALID_PREVIOUS_REPORT');
    const { previousRuns: history, ...latest } = previous;
    return [...history, latest];
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function main() {
  if (process.argv.slice(2).join(' ') !== '--execute') {
    console.log(
      'Opt-in only: pnpm exec tsx scripts/probe-ui-performance.mts --execute. Requires a local production Next server at 127.0.0.1:3100. Measures synthetic UI only; no product performance budget is asserted.',
    );
    return;
  }
  if (process.env.CI) throw new Error('MANUAL_PROBE_DISABLED_IN_CI');
  const history = await previousRuns();
  const browser = await chromium.launch({ headless: true });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void browser.close().catch(() => undefined);
  }, 180_000);
  const results = [];
  let blockedRequests = 0;
  try {
    for (const profile of profiles) {
      for (let sample = 1; sample <= repetitions; sample++) {
        const context = await browser.newContext({
          viewport: profile.viewport,
          serviceWorkers: 'block',
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.origin === origin && !url.username && !url.password) await route.continue();
            else {
              blockedRequests++;
              await route.abort('blockedbyclient');
            }
          });
          await context.routeWebSocket('**/*', (socket) => {
            blockedRequests++;
            socket.close();
          });
          const page = await context.newPage();
          page.setDefaultTimeout(15_000);
          page.setDefaultNavigationTimeout(20_000);
          const cdp = await context.newCDPSession(page);
          let appliedCpuThrottleRate: number | null = null;
          try {
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
            appliedCpuThrottleRate = 4;
          } catch {
            // A missing emulation capability is reported, never treated as a slow-device result.
          }
          results.push({
            profile: profile.name,
            viewport: profile.viewport,
            sample,
            appliedCpuThrottleRate,
            assertions: 'passed',
            durations: await operations(page),
          });
        } finally {
          await context.close();
        }
      }
    }
    if (timedOut) throw new Error('PROBE_DEADLINE_EXCEEDED');
    if (blockedRequests !== 0) throw new Error('UNEXPECTED_NETWORK_REQUEST_BLOCKED');
    const report = {
      schemaVersion: 1,
      executedAt: new Date().toISOString(),
      scope: 'M0-06b synthetic UI compatibility spike; local production Next server',
      environment: {
        platform: platform(),
        architecture: arch(),
        cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
        nodeVersion: process.version,
        browserVersion: browser.version(),
        headless: true,
        requestedCpuThrottleRate: 4,
      },
      method: {
        repetitionsPerProfile: repetitions,
        cache:
          'New browser context for each sample; request routing disables browser HTTP cache. Server/OS cache is not reset.',
        timer:
          'Browser performance.now immediately before the Playwright action and after correctness assertions; includes browser-driver transport, actionability, scrolling and assertion polling. Not isolated rendering time, INP, LCP or paint completion.',
        panelLoad:
          'Click opens lazy data/editor/interaction/map panels; endpoint is four table rows, an SVG chart and a visible editor. Navigation excluded; map startup may overlap. Map readiness is not measured.',
        subsequentOperations:
          'Map is unmounted before 1000-row expansion, descending title sort and exact one-row filter. No user records or external API are used.',
        limits:
          'Six contexts, 1000 synthetic rows per context, 180-second total deadline, 15-second action timeout. No retries or automatic server start.',
      },
      network: {
        allowedOrigin: origin,
        blockedRequests,
        serviceWorkers: 'blocked',
        webSockets: 'blocked',
      },
      interpretation:
        'Observed samples only; no product latency budget or representative low-end hardware qualification. Narrow viewport and 4x CPU throttling do not reproduce a physical mobile device. Concurrent host work and shared browser/server caches can affect timings.',
      results,
      previousRuns: history,
    };
    const temporary = `${output}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, output);
    console.log(
      JSON.stringify({
        output: 'docs/implementation/research/ui-spike-performance-result.json',
        results,
      }),
    );
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}

await main();
