import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { galleryMediaItemSchema } from '@workout/contracts/gallery';

// Product routes + synthetic HTTP boundaries only: no OIDC/backend ownership proof.
// Hosts connect the BFF subtitles reader. Subtitle replies here are synthetic HTTP only:
// they prove the viewer/host boundary, not subtitle storage, ownership or attachment.
declare global {
  interface Window {
    galleryViewerDiagnostic: {
      overflow: boolean;
      pending: Promise<void>[];
      events: {
        order: number;
        event: 'retry_click' | 'blob_created' | 'loadeddata' | 'canplay' | 'error' | 'revoked';
        trusted: boolean | null;
        byteSize: number | null;
        mediaType: 'image/png' | 'video/webm' | 'other' | null;
        sha256: string | null;
        readyState: number | null;
        mediaErrorCode: number | null;
        attached: boolean | null;
      }[];
    };
    galleryViewerMetrics: {
      created: number;
      revoked: number;
      live: number;
      revokedAttached: boolean;
    };
  }
}
const routeDiagnostics = new WeakMap<
  Page,
  { sequence: number; broken: boolean; status: number; byteSize: number; sha256: string }[]
>();

test.afterEach(async ({ page }, info) => {
  const native = await page
    .evaluate(async () => {
      const diagnostic = window.galleryViewerDiagnostic;
      if (!diagnostic) return null;
      await Promise.all(diagnostic.pending);
      return {
        overflow: diagnostic.overflow,
        events: diagnostic.events,
        revokedAttached: window.galleryViewerMetrics.revokedAttached,
      };
    })
    .catch(() => null);
  await info.attach('synthetic-video-boundary-diagnostic', {
    body: JSON.stringify({ native, routes: routeDiagnostics.get(page) ?? [] }),
    contentType: 'application/json',
  });
  routeDiagnostics.delete(page);
});

const ids = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
];
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwJfEiKYzoCH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBFt0BLZ1NTX0AAAAASUVORK5CYII=',
  'base64',
);
async function syntheticVideo(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    if (!MediaRecorder.isTypeSupported('video/webm;codecs=vp8'))
      throw new Error('SYNTHETIC_CODEC_UNAVAILABLE');
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('SYNTHETIC_CANVAS_UNAVAILABLE');
    const paint = context;
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    const result = new Promise<number[]>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => reject(new Error('SYNTHETIC_RECORD_FAILED'));
      recorder.onstop = () => {
        void new Blob(chunks)
          .arrayBuffer()
          .then((buffer) => resolve(Array.from(new Uint8Array(buffer))), reject);
      };
    });
    recorder.start();
    let frames = 0;
    await new Promise<void>((resolve) => {
      function frame() {
        paint.fillStyle = frames % 2 ? '#226633' : '#224466';
        paint.fillRect(0, 0, 64, 64);
        if (++frames === 6) {
          recorder.stop();
          stream.getTracks().forEach((track) => track.stop());
          resolve();
        } else requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });
    return result;
  });
  expect(bytes.length).toBeGreaterThan(0);
  const probe = await page.evaluate(async (values) => {
    const blob = new Blob([new Uint8Array(values)], { type: 'video/webm;codecs=vp8' });
    const url = URL.createObjectURL(blob);
    const element = document.createElement('video');
    element.preload = 'auto';
    try {
      return await new Promise<{
        byteSize: number;
        readyState: number;
        mediaErrorCode: number | null;
        loadedData: boolean;
      }>((resolve) => {
        const complete = (loadedData: boolean) =>
          resolve({
            byteSize: blob.size,
            readyState: element.readyState,
            mediaErrorCode: element.error?.code ?? null,
            loadedData,
          });
        element.onloadeddata = () => complete(true);
        element.onerror = () => complete(false);
        element.src = url;
        element.load();
      });
    } finally {
      element.onloadeddata = null;
      element.onerror = null;
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    }
  }, bytes);
  const result = Buffer.from(bytes);
  await test.info().attach('synthetic-webm-native-preflight', {
    body: JSON.stringify({ ...probe, sha256: createHash('sha256').update(result).digest('hex') }),
    contentType: 'application/json',
  });
  expect(probe.loadedData, 'SYNTHETIC_WEBM_INVALID').toBe(true);
  expect(probe.mediaErrorCode).toBeNull();
  return result;
}
type SubtitleMode = 'unconfigured' | 'available' | 'none' | 'conflict';
const subtitleTrackId = '20000000-0000-4000-8000-000000000001';
async function fixture(
  page: Page,
  video: Buffer = Buffer.from('unsupported synthetic codec'),
  subtitleMode: SubtitleMode = 'unconfigured',
) {
  let account = 'alice';
  const subtitleReads: { mediaItemId: string; accessRevision: string | null }[] = [];
  let broken = false;
  const routes: NonNullable<ReturnType<typeof routeDiagnostics.get>> = [];
  routeDiagnostics.set(page, routes);
  const items = ids.map((id, index) =>
    galleryMediaItemSchema.parse({
      id,
      mediaKind: index === 2 ? 'video' : 'image',
      visibility: 'private',
      includeForCoach: false,
      caption: ['합성 사진 A', '합성 사진 B', '합성 동영상 C'][index],
      album: null,
      activityId: null,
      capturedAt: null,
      capturedLocalDate: null,
      file: {
        originalFileName: index === 2 ? 'synthetic.webm' : 'synthetic.png',
        mediaType: index === 2 ? 'video/webm' : 'image/png',
        byteSize: index === 2 ? video.length : png.length,
        sha256: 'a'.repeat(64),
      },
      preview: null,
      accessRevision: 1,
      createdAt: '2026-10-09T00:00:00Z',
      updatedAt: '2026-10-09T00:00:00Z',
    }),
  );
  const deleted = new Set<string>();
  await page.addInitScript(() => {
    window.galleryViewerDiagnostic = { overflow: false, pending: [], events: [] };
    const diagnostic = window.galleryViewerDiagnostic;
    const record = (event: Window['galleryViewerDiagnostic']['events'][number]) => {
      if (diagnostic.events.length >= 64) {
        diagnostic.overflow = true;
        return;
      }
      diagnostic.events.push(event);
    };
    const blank = () => ({
      order: diagnostic.events.length + 1,
      trusted: null,
      byteSize: null,
      mediaType: null,
      sha256: null,
      readyState: null,
      mediaErrorCode: null,
      attached: null,
    });
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target instanceof Element ? event.target.closest('button') : null;
        if (target?.textContent === '동영상 다시 불러오기')
          record({ ...blank(), event: 'retry_click', trusted: event.isTrusted });
      },
      true,
    );
    for (const kind of ['loadeddata', 'canplay', 'error'] as const) {
      document.addEventListener(
        kind,
        (event) => {
          const element = event.target;
          if (element instanceof HTMLVideoElement && element.closest('dialog'))
            record({
              ...blank(),
              event: kind,
              readyState: element.readyState,
              mediaErrorCode: element.error?.code ?? null,
            });
        },
        true,
      );
    }
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    const live = new Set<string>();
    const revoked = new Set<string>();
    window.galleryViewerMetrics = { created: 0, revoked: 0, live: 0, revokedAttached: false };
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      if (blob instanceof Blob) {
        const observation: Window['galleryViewerDiagnostic']['events'][number] = {
          ...blank(),
          event: 'blob_created',
          byteSize: blob.size,
          mediaType:
            blob.type === 'image/png'
              ? 'image/png'
              : blob.type === 'video/webm'
                ? 'video/webm'
                : 'other',
        };
        record(observation);
        if (diagnostic.pending.length < 64 && blob.size <= 67_108_864) {
          diagnostic.pending.push(
            blob
              .arrayBuffer()
              .then((bytes) => crypto.subtle.digest('SHA-256', bytes))
              .then((digest) => {
                observation.sha256 = Array.from(new Uint8Array(digest), (byte) =>
                  byte.toString(16).padStart(2, '0'),
                ).join('');
              })
              .catch(() => {
                observation.sha256 = null;
              }),
          );
        } else diagnostic.overflow = true;
      }
      live.add(url);
      window.galleryViewerMetrics.created++;
      window.galleryViewerMetrics.live = live.size;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      record({
        ...blank(),
        event: 'revoked',
        attached: Array.from(document.querySelectorAll('img,video')).some(
          (element) => element.getAttribute('src') === url,
        ),
      });
      live.delete(url);
      revoked.add(url);
      window.galleryViewerMetrics.revoked++;
      window.galleryViewerMetrics.live = live.size;
      revoke(url);
    };
    Object.defineProperty(window.galleryViewerMetrics, 'revokedAttached', {
      get: () =>
        Array.from(document.querySelectorAll('img,video')).some((element) =>
          revoked.has(element.getAttribute('src') ?? ''),
        ),
    });
  });
  await page.route('**/bff/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/bff/v1/session') {
      await route.fulfill({
        json: {
          athleteId: account,
          sessionId: `synthetic-${account}`,
          csrfToken: 'c'.repeat(43),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      return;
    }
    if (path === '/bff/v1/gallery/media') {
      await route.fulfill({
        json: {
          items: account === 'alice' ? items.filter((item) => !deleted.has(item.id)) : [],
          total: account === 'alice' ? items.length - deleted.size : 0,
        },
      });
      return;
    }
    const content = items.find((item) => path === `/bff/v1/gallery/media/${item.id}/content`);
    if (content) {
      expect(request.headers()['x-workout-session-id']).toBe('synthetic-alice');
      if (deleted.has(content.id) || account !== 'alice') {
        await route.fulfill({ status: 404, json: { error: { code: 'MEDIA_NOT_FOUND' } } });
        return;
      }
      const body =
        content.mediaKind === 'video' ? (broken ? Buffer.from('invalid codec') : video) : png;
      if (content.mediaKind === 'video' && routes.length < 64)
        routes.push({
          sequence: routes.length + 1,
          broken,
          status: 200,
          byteSize: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        });
      await route.fulfill({ contentType: content.file.mediaType, body });
      return;
    }
    const subtitled = items.find((entry) => path === `/bff/v1/gallery/media/${entry.id}/subtitles`);
    if (subtitled && request.method() === 'GET') {
      expect(request.headers()['x-workout-session-id']).toBe('synthetic-alice');
      const accessRevision = new URL(request.url()).searchParams.get('accessRevision');
      if (subtitleReads.length < 64)
        subtitleReads.push({ mediaItemId: subtitled.id, accessRevision });
      const identity = { schemaVersion: 1, mediaItemId: subtitled.id, accessRevision: 1 };
      if (subtitleMode === 'unconfigured' || subtitleMode === 'conflict') {
        const status = subtitleMode === 'conflict' ? 409 : 503;
        await route.fulfill({
          status,
          json: {
            error: {
              code: status === 409 ? 'MEDIA_ACCESS_CONFLICT' : 'GALLERY_SUBTITLES_UNAVAILABLE',
            },
          },
        });
        return;
      }
      await route.fulfill({
        headers: { 'cache-control': 'private, no-store' },
        json:
          subtitleMode === 'none'
            ? { ...identity, status: 'none' }
            : {
                ...identity,
                status: 'available',
                tracks: [
                  {
                    id: subtitleTrackId,
                    revision: 1,
                    language: 'ko',
                    label: '합성 자막',
                    cues: [
                      { startMs: 0, endMs: 60_000, text: '<b>합성</b> 첫 자막' },
                      { startMs: 60_000, endMs: 120_000, text: '둘째 자막' },
                    ],
                  },
                ],
              },
      });
      return;
    }
    const item = items.find((entry) => path === `/bff/v1/gallery/media/${entry.id}`);
    if (item && request.method() === 'DELETE') {
      deleted.add(item.id);
      await route.fulfill({
        json: {
          status: 'deleted',
          mediaItemId: item.id,
          deletedAt: '2026-10-09T00:01:00Z',
          accessRevision: 2,
        },
      });
      return;
    }
    if (item) {
      await route.fulfill({ json: { status: 'available', item } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'SYNTHETIC_ROUTE_UNAVAILABLE' } } });
  });
  await page.goto('/gallery');
  await expect(page.getByRole('button', { name: '미디어 크게 보기' })).toHaveCount(3);
  return {
    breakVideo: () => {
      broken = true;
    },
    restoreVideo: () => {
      broken = false;
    },
    replaceSession: () => {
      account = 'bob';
    },
    subtitleReads,
  };
}

/**
 * The video tile grows when its private Blob replaces the loading text, shifting the button below it.
 * Wait for that settled layout before clicking so the click cannot land on a moving target.
 */
async function openVideoViewer(page: Page) {
  const tile = page
    .getByRole('article')
    .filter({ has: page.getByRole('link', { name: '합성 동영상 C', exact: true }) });
  await tile.scrollIntoViewIfNeeded();
  // The tile video (preload="none") replaces the loading text once its private Blob arrives.
  await expect(tile.locator('video')).toBeVisible();
  await expect(tile.getByText('미디어 불러오는 중')).toHaveCount(0);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await tile.getByRole('button', { name: '미디어 크게 보기' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('product viewer reflows and supports native dialog focus, buttons, arrows, touch and Escape', async ({
  page,
}, info) => {
  await fixture(page);
  const trigger = page.getByRole('button', { name: '미디어 크게 보기' }).first();
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '보기 닫기' })).toBeFocused();
  await expect(dialog.getByRole('img', { name: '합성 사진 A' })).toBeVisible();
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  }
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('img', { name: '합성 사진 B' })).toBeVisible();
  await dialog.getByRole('button', { name: '이전 미디어' }).click();
  await expect(dialog.getByRole('img', { name: '합성 사진 A' })).toBeVisible();
  if (info.project.name === 'vite-mobile') {
    const area = await dialog.getByRole('group', { name: '미디어 이동 영역' }).boundingBox();
    expect(area).not.toBeNull();
    if (!area) throw new Error('SWIPE_AREA_UNAVAILABLE');
    expect(area.height).toBeGreaterThanOrEqual(32);
    expect(area.width).toBeGreaterThanOrEqual(120);
    const hitInside = await page.evaluate(
      ({ x, y }) =>
        [x, x - 80].every((position) => {
          const target = document.elementFromPoint(position, y);
          return target !== null && target.closest('[aria-label="미디어 이동 영역"]') !== null;
        }),
      { x: area.x + area.width * 0.75, y: area.y + area.height / 2 },
    );
    expect(hitInside).toBe(true);
    await info.attach('synthetic-touch-target-bounds', {
      body: JSON.stringify({
        surfaceWidth: area.width,
        surfaceHeight: area.height,
        targetsInside: hitInside,
      }),
      contentType: 'application/json',
    });
    const client = await page.context().newCDPSession(page);
    const x = area.x + area.width * 0.75,
      y = area.y + area.height / 2;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x - 80, y }],
    });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await client.detach();
    await expect(dialog.getByRole('img', { name: '합성 사진 B' })).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.galleryViewerMetrics.revokedAttached)).toBe(false);
});

test('actual native video rate and codec failure recover, with honest unavailable subtitles and bounded zero tracks', async ({
  page,
}) => {
  const video = await syntheticVideo(page);
  const state = await fixture(page, video);
  state.breakVideo();
  await openVideoViewer(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toContainText('이 동영상을 재생할 수 없습니다.');
  state.restoreVideo();
  await dialog.getByRole('button', { name: '동영상 다시 불러오기' }).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  const player = dialog.locator('video');
  await expect
    .poll(() =>
      player.evaluate((element) => element instanceof HTMLVideoElement && element.readyState >= 2),
    )
    .toBe(true);
  await expect(player).toHaveAttribute('playsinline', '');
  await dialog.getByLabel('재생 속도').selectOption('1.5');
  expect(
    await player.evaluate((element) =>
      element instanceof HTMLVideoElement ? element.playbackRate : null,
    ),
  ).toBe(1.5);
  await expect(dialog.getByText(/자막을 확인할 수 없습니다/)).toBeVisible();
  await expect(dialog.getByText(/자막 연결 서비스가 제공되지 않습니다/)).toBeVisible();
  expect(state.subtitleReads.length).toBeGreaterThan(0);
  expect(state.subtitleReads.every((read) => read.accessRevision === '1')).toBe(true);
  expect(
    await player.evaluate((element) =>
      element instanceof HTMLVideoElement ? element.textTracks.length : null,
    ),
  ).toBe(0);
  await dialog.getByRole('button', { name: '동영상 전체 화면' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.fullscreenElement !== null ||
          document.body.textContent?.includes('이 환경에서는 전체 화면을 사용할 수 없습니다.') ===
            true,
      ),
    )
    .toBe(true);
  if (await page.evaluate(() => document.fullscreenElement !== null))
    await page.evaluate(() => document.exitFullscreen());
  await dialog.getByRole('button', { name: '보기 닫기' }).click();
  await openVideoViewer(page);
  expect(
    await page
      .getByRole('dialog')
      .locator('video')
      .evaluate((element) =>
        element instanceof HTMLVideoElement ? element.textTracks.length : null,
      ),
  ).toBe(0);
});

test('product deletion removes the private tile and revokes its Blob without retaining an attached revoked source', async ({
  page,
}) => {
  await fixture(page);
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('link', { name: '합성 사진 A', exact: true }) });
  await card.scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      card
        .getByRole('img')
        .evaluate(
          (element) =>
            element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0,
        ),
    )
    .toBe(true);
  const before = await page.evaluate(() => window.galleryViewerMetrics.revoked);
  await card.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.galleryViewerMetrics.revoked))
    .toBeGreaterThan(before);
  expect(await page.evaluate(() => window.galleryViewerMetrics.revokedAttached)).toBe(false);
});

test('a replaced session removes the open viewer and every private Blob for the old lifetime', async ({
  page,
}) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: '미디어 크게 보기' }).first().click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  state.replaceSession();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('아직 저장한 사진이나 동영상이 없습니다.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.galleryViewerMetrics.live)).toBe(0);
  expect(await page.evaluate(() => window.galleryViewerMetrics.revokedAttached)).toBe(false);
});

test('server-provided timed captions attach as native cues, switch off, and none/conflict stay explicit', async ({
  page,
}) => {
  const video = await syntheticVideo(page);
  const state = await fixture(page, video, 'available');
  await openVideoViewer(page);
  const dialog = page.getByRole('dialog');
  const player = dialog.locator('video');
  await expect
    .poll(() =>
      player.evaluate((element) => element instanceof HTMLVideoElement && element.readyState >= 2),
    )
    .toBe(true);
  await expect(dialog.getByText(/자동 생성되거나 검토된 자막이 아닙니다/)).toBeVisible();
  const select = dialog.getByLabel('자막 선택');
  await select.selectOption(subtitleTrackId);
  const showing = await player.evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) return null;
    const track = element.textTracks[0];
    return {
      tracks: element.textTracks.length,
      mode: track?.mode ?? null,
      cues: Array.from(track?.cues ?? [], (cue) => ({
        start: cue.startTime,
        end: cue.endTime,
        text: cue instanceof VTTCue ? cue.text : null,
      })),
      injected: document.querySelector('dialog b') !== null,
    };
  });
  expect(showing).toEqual({
    tracks: 1,
    mode: 'showing',
    cues: [
      { start: 0, end: 60, text: '&lt;b&gt;합성&lt;/b&gt; 첫 자막' },
      { start: 60, end: 120, text: '둘째 자막' },
    ],
    injected: false,
  });
  await select.selectOption('off');
  expect(
    await player.evaluate((element) => {
      if (!(element instanceof HTMLVideoElement)) return null;
      const track = element.textTracks[0];
      return { mode: track?.mode ?? null, tracks: element.textTracks.length };
    }),
  ).toEqual({ mode: 'disabled', tracks: 1 });
  // Keyboard alternative: a native, focusable select (platform popup keys differ by OS).
  await select.focus();
  await expect(select).toBeFocused();
  expect(await select.evaluate((element) => element.tagName)).toBe('SELECT');
  expect(state.subtitleReads).toEqual([{ mediaItemId: ids[2], accessRevision: '1' }]);
  await dialog.getByRole('button', { name: '보기 닫기' }).click();
  await expect(dialog).toHaveCount(0);
});

for (const mode of ['none', 'conflict'] as const)
  test(`subtitle ${mode} reply is shown honestly without a native track`, async ({ page }) => {
    await fixture(page, Buffer.from('unsupported synthetic codec'), mode);
    await openVideoViewer(page);
    const dialog = page.getByRole('dialog');
    if (mode === 'none') await expect(dialog.getByText('연결된 자막이 없습니다.')).toBeVisible();
    else {
      await expect(
        dialog.getByText(/미디어가 바뀌어 받은 자막을 사용하지 않았습니다/),
      ).toBeVisible();
      await expect(dialog.getByRole('button', { name: '자막 다시 확인' })).toBeVisible();
    }
    expect(
      await dialog
        .locator('video')
        .evaluate((element) =>
          element instanceof HTMLVideoElement ? element.textTracks.length : null,
        ),
    ).toBe(0);
  });

test('video fullscreen keeps caption and speed controls with an inline return', async ({
  page,
}) => {
  const video = await syntheticVideo(page);
  await fixture(page, video, 'available');
  await openVideoViewer(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '동영상 전체 화면' }).click();
  const entered = await page
    .waitForFunction(() => document.fullscreenElement !== null, undefined, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  await test.info().attach('synthetic-fullscreen-observation', {
    body: JSON.stringify({ entered }),
    contentType: 'application/json',
  });
  if (!entered) {
    await expect(dialog.getByText(/전체 화면을 사용할 수 없습니다/)).toBeVisible();
    return;
  }
  expect(
    await page.evaluate(() => {
      const active = document.fullscreenElement;
      return {
        wrapsVideo: active?.querySelector('video') !== null,
        hasSpeed: active?.querySelector('select') !== null,
      };
    }),
  ).toEqual({ wrapsVideo: true, hasSpeed: true });
  await dialog.getByRole('button', { name: '화면 안에서 보기' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect(dialog.getByRole('button', { name: '동영상 전체 화면' })).toBeVisible();
});
