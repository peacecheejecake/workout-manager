import { test, expect, type Page } from '@playwright/test';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';
import {
  fitFile,
  recordMessage,
  sessionMessage,
} from '../../packages/track-parsing/tests/fit-fixture';

/**
 * Real-browser check of the local-file preview route in the Next shell.
 *
 * Real bytes go through a real dedicated worker here: the file is sniffed by content,
 * parsed, normalized, validated against the contract and drawn. Nothing is uploaded —
 * the assertions below include that no request leaves for the API while parsing.
 */
const GPX11 = 'http://www.topografix.com/GPX/1/1';
const at = (seconds: number) =>
  new Date(Date.parse('2026-03-01T00:00:00Z') + seconds * 1000).toISOString();

const gpxBytes = Buffer.from(
  `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" xmlns="${GPX11}">` +
    `<trk><name>실제 GPX 기록</name><trkseg>` +
    [0, 1, 2, 3, 4]
      .map(
        (index) =>
          `<trkpt lat="${37.5 + index / 1000}" lon="${127.02 + index / 1000}">` +
          `<time>${at(index * 10)}</time></trkpt>`,
      )
      .join('') +
    `</trkseg></trk></gpx>`,
);

// Synthetic FIT bytes from the parser package's own fixture builder: framing, header CRC
// and trailer CRC are real, and positions are stored as semicircles.
const fitBytes = Buffer.from(
  fitFile([
    sessionMessage({ startedAt: at(0), elapsedSeconds: 30, distanceMeters: 250 }),
    recordMessage({ at: at(0), longitude: 127.05, latitude: 37.5, heartRate: 140 }),
    recordMessage({ at: at(10), longitude: 127.0501, latitude: 37.5001, heartRate: 142 }),
    recordMessage({ at: at(20), longitude: 127.0502, latitude: 37.5002, heartRate: 144 }),
  ]),
);

async function signIn(page: Page) {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: 'Sign in as Alice' }).click();
  await page.goto('/activities/track-preview');
}

test('parses real GPX bytes in a worker, draws the track and uploads nothing', async ({ page }) => {
  const pageErrors: string[] = [];
  const writeRequests: string[] = [];
  const workers: string[] = [];
  const closedWorkers: string[] = [];
  page.on('worker', (worker) => {
    workers.push(worker.url());
    worker.on('close', (closed) => closedWorkers.push(closed.url()));
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Any non-GET request at all, to any host: an upload cannot hide behind a different
  // path or origin. Document loads and asset fetches are GET.
  page.on('request', (request) => {
    if (request.method() !== 'GET') writeRequests.push(`${request.method()} ${request.url()}`);
  });
  await signIn(page);

  const input = page.getByLabel('미리 볼 기록 파일');
  await expect(page.getByText('아직 파일을 선택하지 않았습니다.')).toBeVisible();
  await input.setInputFiles({
    name: 'run.gpx',
    mimeType: 'application/octet-stream',
    buffer: gpxBytes,
  });

  await expect(page.getByText(/로컬 파일 미리보기 · 저장 안 함 · 활동 ID 없음/)).toBeVisible();
  await expect(page.getByText('전체 5개 · 위치 있음 5개 · 구간 1개')).toBeVisible();
  await expect(page.getByText('40초')).toBeVisible();
  await expect(page.getByRole('heading', { name: '경로' })).toBeVisible();
  // Not just "the adapter is ready": the renderer reported the path features it actually
  // drew. The count is renderer feature instances (one line can be split across tiles),
  // so the assertion is that it is non-zero, not a specific number.
  await expect(page.getByText(/렌더된 경로 feature [1-9]\d*개/)).toBeVisible();

  // Start and end selection resolve back to source sample ids.
  await page.getByRole('button', { name: '시작 지점' }).click();
  await expect(page.getByText(/선택 표본 0:0/)).toBeVisible();
  await page.getByRole('button', { name: '끝 지점' }).click();
  await expect(page.getByText(/선택 표본 0:4/)).toBeVisible();
  await page.getByRole('button', { name: '전체 보기' }).click();
  await expect(page.getByText(/선택 표본 0:4/)).toBeVisible();

  // The parse really ran in a dedicated worker, and that worker was terminated after it.
  // Turbopack serves a module worker through its own loader chunk, so the preview worker
  // is identified by not being the MapLibre one; the main-thread fallback would create
  // no worker at all.
  const parseWorkers = workers.filter((url) => !url.includes('maplibre'));
  expect(parseWorkers).toHaveLength(1);
  await expect.poll(() => closedWorkers.filter((url) => !url.includes('maplibre')).length).toBe(1);

  expect(writeRequests).toEqual([]);
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('track'))),
  ).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('parses real FIT bytes by content, keeps device distance apart and reflows to 320px', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await signIn(page);
  const input = page.getByLabel('미리 볼 기록 파일');

  // Named `.txt` on purpose: the format is decided by the `.FIT` magic, not the name.
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: fitBytes });
  await expect(page.getByText(/활동 ID 없음 \(fit-track-v1\)/)).toBeVisible();
  await expect(page.getByText('전체 3개 · 위치 있음 3개 · 구간 1개')).toBeVisible();
  // Device-reported 250 m stays separate from the recomputed GPS distance.
  await expect(page.getByText('250m')).toBeVisible();
  await expect(page.getByRole('heading', { name: '경로' })).toBeVisible();

  for (const fixture of viewportFixtures) {
    await page.setViewportSize({ width: fixture.width, height: fixture.height });
    await expect(page.getByRole('heading', { name: '경로' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('main.wm-page').evaluate((element) => {
    element.style.width = '420px';
    element.style.boxSizing = 'border-box';
  });
  await expect(page.getByText('전체 3개 · 위치 있음 3개 · 구간 1개')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(pageErrors).toEqual([]);
});

test('refuses an archive by content and keeps the screen usable, then accepts a real file', async ({
  page,
}) => {
  await signIn(page);
  const input = page.getByLabel('미리 볼 기록 파일');
  await input.setInputFiles({
    name: 'track.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
  });
  await expect(page.getByText(/TRACK_ARCHIVE_REJECTED/)).toBeVisible();
  await expect(page.getByRole('heading', { name: '경로' })).toHaveCount(0);

  // Replacing the file clears the failure rather than leaving both states on screen.
  await input.setInputFiles({
    name: 'run.gpx',
    mimeType: 'application/octet-stream',
    buffer: gpxBytes,
  });
  await expect(page.getByText('전체 5개 · 위치 있음 5개 · 구간 1개')).toBeVisible();
  await expect(page.getByText(/TRACK_ARCHIVE_REJECTED/)).toHaveCount(0);

  // Keyboard reaches the file control with a visible focus ring.
  await input.focus();
  await expect(input).toBeFocused();
});
