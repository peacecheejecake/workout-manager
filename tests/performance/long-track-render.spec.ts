import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { activityImportResultSchema } from '../../packages/contracts/src/activity';
import {
  LONG_TRACK_SAMPLES,
  longTrackAt,
  longTrackFitBytes,
  longTrackLengthMeters,
} from '../../scripts/fixtures/long-track';
import {
  describeEvaluation,
  evaluateBudget,
  parseBudgetFile,
  assertMeasurableSourceTree,
  repoRelative,
  sampleNow,
  writeResultWithHistory,
  type BudgetSample,
} from '../../scripts/performance-budget';
import { expectLineDrawn, mapRegion } from '../identity/map-evidence';

/**
 * M2-01k-f: the browser half of the performance budget. The representative long track
 * (20,000 synthetic samples, scripts/fixtures/long-track.ts) is stored through the real
 * upload, re-parsed by the server's bounded worker, and then drawn by the PRODUCT route tab
 * (S09) in both shells — not by a harness.
 *
 * Per shell it measures, over repeated full page loads:
 *   - navigation start → the map's own "drawn" verdict for this path (line features on
 *     screen after idle, M2-01q), read from `performance.now()` at the moment the attribute
 *     changed;
 *   - the retained JS heap after that, with garbage collected first.
 * and checks once that the heavy renderer (MapLibre) is not fetched until the route tab is
 * opened: no chunk carrying MapLibre's code and no MapLibre worker on another tab.
 *
 * Budgets come from docs/implementation/research/performance-budget.json and are judged by
 * the same evaluator as the server probe. Desktop, headless Chromium on this machine — the
 * WebGL renderer string is recorded with the result. Not a device result.
 *
 * Run only through playwright.performance.config.ts (under the harness lock), never as part
 * of the identity suite. Environment:
 *   PERF_SAMPLES       page loads per shell (default 20, minimum 5; with 20 the nearest-rank
 *                      p95 is not the maximum, so one outlier cannot decide the budget)
 *   PERF_RECORD_ONLY=1 record samples without judging them (baseline runs)
 *   PERF_BUDGET        another budget file (controlled checks)
 *   PERF_OUT           where to write the result (default: the research file)
 *   PERF_ALLOW_DIRTY   reason to measure although the scanned paths (packages/, apps/, scripts/,
 *                      tests/, root workspace and Playwright files) differ from HEAD;
 *   PERF_ALLOW_PRODUCT comma-separated product files (anything under packages/ or apps/ that
 *                      is not a test or fixture) that may differ from HEAD; any other changed
 *                      product file is refused (see the server probe). The guard checks
 *                      source only: rebuild the shells before this step.
 */
const repositoryRoot = join(import.meta.dirname, '../..');
const samplesPerShell = Number(process.env.PERF_SAMPLES ?? '20');
const recordOnly = process.env.PERF_RECORD_ONLY === '1';
const budgetPath =
  process.env.PERF_BUDGET ??
  join(repositoryRoot, 'docs/implementation/research/performance-budget.json');
const outPath =
  process.env.PERF_OUT ??
  join(repositoryRoot, 'docs/implementation/research/performance-budget-browser-result.json');
/** A string only MapLibre GL's own library code carries (one of its error messages). */
const MAPLIBRE_SIGNATURE = 'Style is not done loading';
const MAPLIBRE_WORKER = /maplibre-gl-worker(-dev)?\.mjs/;

const shells = [
  ['next', 'http://127.0.0.1:3100'],
  ['vite', 'http://127.0.0.1:4200'],
] as const;

async function login(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('/bff/v1/session');
  expect(response.status()).toBe(200);
  const session: unknown = await response.json();
  assert.ok(
    typeof session === 'object' &&
      session !== null &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  return {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}

/** Imports an activity and stores the long FIT track through the real upload. */
async function storeLongTrack(page: Page, headers: Record<string, string>) {
  const length = Math.round(longTrackLengthMeters());
  const imported = await page.request.post('/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      source: { kind: 'fit', sourceId: randomUUID(), revision: 1, contentHash: 'c'.repeat(64) },
      activity: {
        title: `M2-01k-f 긴 경로 ${randomUUID()}`,
        kind: 'running',
        startedAt: longTrackAt(0),
        timezone: 'UTC',
        durationSeconds: LONG_TRACK_SAMPLES,
        durationKind: 'elapsed',
        distanceMeters: length,
      },
    },
  });
  expect(imported.status()).toBe(200);
  const result = activityImportResultSchema.parse(await imported.json());
  const reserved = await page.request.post(
    `/bff/v1/activities/${result.activityId}/track-uploads`,
    {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { expectedActivityRevision: result.revision, recordedTrackIndex: 0 },
    },
  );
  expect(reserved.status()).toBe(200);
  const reservation = (await reserved.json()) as { uploadId: string };
  const uploaded = await page.request.put(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/content`,
    {
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-track-file-name': encodeURIComponent('long.fit'),
      },
      data: longTrackFitBytes(),
    },
  );
  expect(uploaded.status()).toBe(200);
  const finalized = await page.request.post(
    `/bff/v1/activity-track-uploads/${reservation.uploadId}/finalize`,
    { headers: { ...headers, 'idempotency-key': randomUUID() } },
  );
  expect(finalized.status()).toBe(200);
  // The server kept every vertex: the screen is asked to draw the whole long track.
  const mapPath = await page.request.get(
    `/bff/v1/activities/${result.activityId}/track/content?variant=map_path`,
    { headers },
  );
  expect(mapPath.status()).toBe(200);
  const body = (await mapPath.json()) as { geometry: { coordinates: unknown[][] } };
  expect(body.geometry.coordinates.reduce((sum, line) => sum + line.length, 0)).toBe(
    LONG_TRACK_SAMPLES,
  );
  return result.activityId;
}

/**
 * Records, from the first byte of the document, the `performance.now()` at which a map first
 * held a "drawn" verdict about the path it currently has (generations equal, line features
 * rendered) — the same conditions `expectLineDrawn` asserts afterwards.
 */
async function recordDrawnAt(page: Page) {
  await page.addInitScript(() => {
    const state: { drawnAt: number | null } = { drawnAt: null };
    (window as unknown as { __longTrack: typeof state }).__longTrack = state;
    const inspect = (element: Element) => {
      if (
        state.drawnAt === null &&
        element.getAttribute('data-map-status') === 'drawn' &&
        Number(element.getAttribute('data-rendered-lines') ?? '0') > 0 &&
        element.getAttribute('data-paths-generation') !== null &&
        element.getAttribute('data-paths-generation') ===
          element.getAttribute('data-evidence-generation')
      )
        state.drawnAt = performance.now();
    };
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element)
          inspect(record.target);
        for (const node of record.addedNodes)
          if (node instanceof Element)
            for (const element of [node, ...node.querySelectorAll('[data-map-status]')])
              inspect(element);
      }
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'data-map-status',
        'data-rendered-lines',
        'data-paths-generation',
        'data-evidence-generation',
      ],
    });
  });
}

/** JS responses whose body carries MapLibre's own code, and MapLibre worker requests. */
function watchMapLibre(page: Page) {
  const chunks: string[] = [];
  const workers: string[] = [];
  const pending: Promise<void>[] = [];
  page.on('request', (request) => {
    if (MAPLIBRE_WORKER.test(request.url())) workers.push(new URL(request.url()).pathname);
  });
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script') return;
    pending.push(
      response
        .text()
        .then((text) => {
          if (text.includes(MAPLIBRE_SIGNATURE)) chunks.push(new URL(response.url()).pathname);
        })
        .catch(() => undefined),
    );
  });
  return {
    chunks,
    workers,
    settle: async () => {
      await Promise.all(pending);
    },
  };
}

test('the long track meets the browser budget in both shells, and MapLibre loads lazily', async ({
  browser,
}) => {
  // Refused before anything is measured when the tree differs from HEAD.
  const sourceTree = assertMeasurableSourceTree(
    repositoryRoot,
    process.env.PERF_ALLOW_DIRTY ?? null,
    process.env.PERF_ALLOW_PRODUCT?.split(',') ?? [],
  );
  // Parsed before anything is measured, so a malformed budget fails fast. A baseline run
  // records samples before a budget exists and judges nothing.
  const budget = recordOnly
    ? null
    : parseBudgetFile(JSON.parse(await readFile(budgetPath, 'utf8')));
  expect(samplesPerShell).toBeGreaterThanOrEqual(5);
  const context = await browser.newContext();
  const setup = await context.newPage();
  const headers = await login(setup);
  const activityId = await storeLongTrack(setup, headers);
  await setup.close();

  const observations: Record<string, BudgetSample[]> = {};
  const checks: { id: string; passed: boolean; detail: string }[] = [];
  let webglRenderer = 'unknown';
  const browserVersion = browser.version();

  for (const [shell, origin] of shells) {
    // --- Lazy loading: another tab first, then the route tab reached by the user.
    const lazyPage = await context.newPage();
    const maplibre = watchMapLibre(lazyPage);
    await lazyPage.goto(`${origin}/activities?selected=${activityId}&detailTab=overview`);
    const routeTab = lazyPage.getByRole('tab', { name: '경로', exact: true });
    await expect(routeTab).toBeEnabled();
    await lazyPage.waitForLoadState('networkidle');
    await maplibre.settle();
    const beforeChunks = [...maplibre.chunks];
    const beforeWorkers = [...maplibre.workers];
    await routeTab.click();
    const lazyPanel = lazyPage.getByRole('region', { name: '저장된 경로', exact: true });
    await expectLineDrawn(mapRegion(lazyPanel, '저장된 활동 경로'), { timeout: 180_000 });
    await maplibre.settle();
    checks.push({
      id: `browser-${shell}-maplibre-not-loaded-before-route-tab`,
      passed: beforeChunks.length === 0 && beforeWorkers.length === 0,
      detail: `before: chunks [${beforeChunks.join(', ')}] workers [${beforeWorkers.join(', ')}]`,
    });
    checks.push({
      id: `browser-${shell}-maplibre-loaded-on-route-tab`,
      // Non-vacuity of the check above: the same watcher does see MapLibre once it is needed.
      passed: maplibre.chunks.length > 0 && maplibre.workers.length > 0,
      detail: `after: chunks [${maplibre.chunks.join(', ')}] workers [${maplibre.workers.join(', ')}]`,
    });
    webglRenderer = await lazyPage.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
    });
    await lazyPage.close();

    // --- Render budget: repeated full loads of the route tab, one fresh page each.
    for (let index = 0; index < samplesPerShell; index += 1) {
      const page = await context.newPage();
      await recordDrawnAt(page);
      await page.goto(`${origin}/activities?selected=${activityId}&detailTab=route`);
      const panel = page.getByRole('region', { name: '저장된 경로', exact: true });
      await expectLineDrawn(mapRegion(panel, '저장된 활동 경로'), { timeout: 180_000 });
      const measured = await page.evaluate(() => {
        (window as unknown as { gc?: () => void }).gc?.();
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return {
          drawnAt: (window as unknown as { __longTrack?: { drawnAt: number | null } }).__longTrack
            ?.drawnAt,
          heap: memory?.usedJSHeapSize ?? null,
        };
      });
      assert.ok(typeof measured.drawnAt === 'number', 'drawn time was not recorded');
      assert.ok(typeof measured.heap === 'number', 'performance.memory is unavailable');
      const time = sampleNow(Math.round(measured.drawnAt));
      const heap = sampleNow(Math.round((measured.heap / 2 ** 20) * 10) / 10);
      (observations[`browser.${shell}.navigationToDrawnMs`] ??= []).push(time);
      (observations[`browser.${shell}.jsHeapAfterDrawnMiB`] ??= []).push(heap);
      console.log(
        `${shell} #${index}: drawn ${time.value} ms, heap ${heap.value} MiB (load ${time.loadAverage1m})`,
      );
      await page.close();
    }
  }
  await context.close();

  const evaluation = budget === null ? null : evaluateBudget(budget, observations, ['browser']);
  if (evaluation) console.log(describeEvaluation(evaluation));
  const checksPassed = checks.every((entry) => entry.passed);
  await writeResultWithHistory(outPath, {
    schemaVersion: 1,
    node: 'M2-01k-f',
    executedAt: new Date().toISOString(),
    label:
      'Desktop, this shared machine, headless Chromium through Playwright, product S09 route tab in ' +
      'both shells. Not a device result. Every sample carries the 1-minute load average.',
    mode: recordOnly ? 'record-only (baseline, not judged)' : 'judged',
    budgetFile: recordOnly ? null : repoRelative(repositoryRoot, budgetPath),
    sourceTree,
    samplesPerShell,
    track: { kind: 'synthetic', samples: LONG_TRACK_SAMPLES },
    browser: { name: 'chromium', version: browserVersion, webglRenderer },
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 2 ** 30),
      loadAverageAtEnd: loadavg().map((value) => Math.round(value * 100) / 100),
    },
    passed: recordOnly ? null : checksPassed && evaluation?.passed === true,
    checks,
    evaluation,
    samples: observations,
  });
  for (const entry of checks) expect(entry.passed, `${entry.id}: ${entry.detail}`).toBe(true);
  if (evaluation) expect(evaluation.passed, describeEvaluation(evaluation)).toBe(true);
});
