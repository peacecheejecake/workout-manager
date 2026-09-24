import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  activityImportResultSchema,
  importActivitySchema,
} from '../../packages/contracts/src/activity';
import {
  galleryMediaListSchema,
  galleryMediaReadResultSchema,
  galleryUploadReservationSchema,
} from '../../packages/contracts/src/gallery';

/**
 * S09 media tab (M2-01k-l, V2-A37), against the real OIDC session, API, PostgreSQL and
 * gallery object storage, in both shells.
 *
 * The media is real gallery media uploaded through the gallery's own upload pipeline, with a
 * client preview (the thumbnail). The owner links it on the activity's media tab, sees it
 * there, downloads the original through the authenticated transfer and unlinks it. Bob gets
 * 404 for every address of it. After the owner deletes it in the gallery, the tab no longer
 * shows it and the very thumbnail and original addresses the tab used answer 404.
 */
async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('http://127.0.0.1:3100/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  const response = await page.request.get('http://127.0.0.1:3100/bff/v1/session');
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
    origin: 'http://127.0.0.1:3100',
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
}
type Headers = Awaited<ReturnType<typeof login>>;

// A PNG signature and IHDR header: what the gallery's signature check accepts as PNG. The
// preview differs from the original so each address is known to serve its own bytes.
const originalBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const previewBytes = Buffer.concat([originalBytes, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);

const cleanup = new WeakMap<
  Page,
  { headers: Headers; activity?: { id: string; revision: number }; mediaItemId?: string }
>();
test.afterEach(async ({ page }) => {
  const entry = cleanup.get(page);
  if (!entry) return;
  cleanup.delete(page);
  const api = 'http://127.0.0.1:3100/bff/v1';
  if (entry.mediaItemId) {
    const read = await page.request.get(`${api}/gallery/media/${entry.mediaItemId}`, {
      headers: entry.headers,
      timeout: 5000,
    });
    if (read.status() === 200) {
      const current = galleryMediaReadResultSchema.parse(await read.json());
      if (current.status === 'available') {
        const removed = await page.request.delete(`${api}/gallery/media/${entry.mediaItemId}`, {
          headers: { ...entry.headers, 'idempotency-key': `cleanup-${randomUUID()}` },
          data: { expectedAccessRevision: current.item.accessRevision },
          timeout: 5000,
        });
        expect(removed.status()).toBe(200);
      }
    } else expect(read.status()).toBe(404);
  }
  if (entry.activity) {
    const response = await page.request.delete(`${api}/activities/${entry.activity.id}`, {
      headers: entry.headers,
      data: { expectedRevision: entry.activity.revision },
      timeout: 5000,
    });
    expect(response.status()).toBe(204);
  }
});

async function importActivity(page: Page, headers: Headers, title: string) {
  const start = Date.parse('2023-06-15T12:00:00Z');
  const command = importActivitySchema.parse({
    idempotencyKey: randomUUID(),
    source: { kind: 'fixture', sourceId: randomUUID(), revision: 1, contentHash: 'd'.repeat(64) },
    activity: {
      title,
      kind: 'running',
      startedAt: new Date(start).toISOString(),
      timezone: 'UTC',
      durationSeconds: 20,
      durationKind: 'elapsed',
      distanceMeters: 40,
    },
  });
  const { idempotencyKey, ...body } = command;
  const response = await page.request.post('http://127.0.0.1:3100/bff/v1/activity-imports', {
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    data: body,
  });
  expect(response.status()).toBe(200);
  const imported = activityImportResultSchema.parse(await response.json());
  return { id: imported.activityId, revision: imported.revision };
}

/** Real gallery media: reserve, stream the bytes, finalize; then the same for its preview. */
async function uploadGalleryMedia(page: Page, headers: Headers, caption: string) {
  const api = 'http://127.0.0.1:3100/bff/v1/gallery/media';
  const send = async (uploadId: string, fileName: string, bytes: Buffer) => {
    const put = await page.request.put(`${api}/uploads/${uploadId}/content`, {
      headers: {
        ...headers,
        'content-type': 'image/png',
        'x-gallery-file-name': encodeURIComponent(fileName),
      },
      data: bytes,
    });
    expect(put.status()).toBe(200);
    const finalized = await page.request.post(`${api}/uploads/${uploadId}/finalize`, { headers });
    expect(finalized.status()).toBe(200);
    return galleryMediaReadResultSchema.parse(await finalized.json());
  };
  const reserved = await page.request.post(`${api}/uploads`, {
    headers: { ...headers, 'idempotency-key': `s09-media-${randomUUID()}` },
    data: { mediaKind: 'image', album: 'S09', caption },
  });
  expect(reserved.status()).toBe(200);
  const reservation = galleryUploadReservationSchema.parse(await reserved.json());
  const created = await send(reservation.uploadId, 'finish.png', originalBytes);
  assert.equal(created.status, 'available');
  const previewReserved = await page.request.post(
    `${api}/${reservation.mediaItemId}/preview-uploads`,
    {
      headers: { ...headers, 'idempotency-key': `s09-preview-${randomUUID()}` },
      data: { expectedAccessRevision: created.item.accessRevision },
    },
  );
  expect(previewReserved.status()).toBe(200);
  const preview = galleryUploadReservationSchema.parse(await previewReserved.json());
  const withPreview = await send(preview.uploadId, 'finish-preview.png', previewBytes);
  assert.equal(withPreview.status, 'available');
  expect(withPreview.item.preview).toMatchObject({ kind: 'preview', mediaType: 'image/png' });
  return withPreview.item;
}

async function readLink(page: Page, headers: Headers, mediaItemId: string) {
  const response = await page.request.get(
    `http://127.0.0.1:3100/bff/v1/gallery/media/${mediaItemId}`,
    { headers },
  );
  expect(response.status()).toBe(200);
  const read = galleryMediaReadResultSchema.parse(await response.json());
  assert.equal(read.status, 'available');
  return read.item.activityId;
}

const shells = [
  ['Next', 'http://127.0.0.1:3100'],
  ['Vite', 'http://127.0.0.1:4200'],
] as const;

for (const [shell, origin] of shells) {
  test(`${shell} shell: the media tab links, shows, downloads and unlinks real gallery media; Bob gets 404; deletion blocks the tab and its addresses`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const headers = await login(page, 'Alice');
    const title = `S09 미디어 탭 ${randomUUID()}`;
    const caption = `결승선 ${randomUUID().slice(0, 8)}`;
    const activity = await importActivity(page, headers, title);
    cleanup.set(page, { headers, activity });
    const item = await uploadGalleryMedia(page, headers, caption);
    cleanup.set(page, { headers, activity, mediaItemId: item.id });
    const thumbnailPath = `/bff/v1/gallery/media/${item.id}/content?variant=preview`;
    const originalPath = `/bff/v1/gallery/media/${item.id}/content?variant=original`;
    const address = `${origin}/activities/${activity.id}?tab=media`;

    // The spec address of the media tab (M2-01k-k) opens the tab, which is now enabled.
    await page.goto(address);
    await expect(page).toHaveURL(
      `${origin}/activities?${new URLSearchParams({ selected: activity.id, detailTab: 'media' })}`,
    );
    const tablist = page.getByRole('tablist', { name: '활동 상세 보기', exact: true });
    const mediaTab = tablist.getByRole('tab', { name: '미디어', exact: true });
    await expect(mediaTab).toBeEnabled();
    await expect(mediaTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('미디어 연결을 제공하지 않습니다', { exact: false })).toHaveCount(
      0,
    );
    const panel = page.getByRole('region', { name: '활동 미디어', exact: true });
    const linked = panel.getByRole('region', { name: '이 활동의 미디어', exact: true });
    const picker = panel.getByRole('region', { name: '갤러리에서 연결', exact: true });
    await expect(linked.getByText('이 활동에 연결한 미디어가 없습니다.')).toBeVisible();

    // Every thumbnail response the screen received, passed through unchanged.
    const thumbnailBodies: Buffer[] = [];
    await page.route(
      (url) => url.pathname + url.search === thumbnailPath,
      async (route) => {
        const response = await route.fetch();
        if (response.status() === 200) thumbnailBodies.push(await response.body());
        await route.fulfill({ response });
      },
    );
    // Link: the owner's existing gallery item, from the picker.
    const candidate = picker.getByRole('article', { name: caption, exact: true });
    await expect(candidate).toBeVisible();
    await candidate.getByRole('button', { name: '이 활동에 연결', exact: true }).click();
    const card = linked.getByRole('article', { name: caption, exact: true });
    await expect(card).toBeVisible();
    // The pressed button left with its card; focus follows the card in a real browser, and
    // each card action is described by its media's name.
    await expect(card.getByRole('heading', { level: 5, name: caption, exact: true })).toBeFocused();
    for (const action of ['원본 내려받기', '연결 해제'])
      await expect(
        card.getByRole('button', { name: action, exact: true }),
      ).toHaveAccessibleDescription(caption);
    await expect(picker.getByRole('article', { name: caption, exact: true })).toHaveCount(0);
    expect(await readLink(page, headers, item.id)).toBe(activity.id);

    // The thumbnail on screen is a blob of the item's preview, loaded from the thumbnail
    // address, which serves the preview bytes to the owner.
    const image = card.getByRole('img', { name: caption, exact: true });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => thumbnailBodies.some((body) => body.equals(previewBytes)), { timeout: 10_000 })
      .toBe(true);
    const served = await page.request.get(`http://127.0.0.1:3100${thumbnailPath}`, { headers });
    expect(served.status()).toBe(200);
    expect(served.headers()['cache-control']).toBe('private, no-store');
    expect(Buffer.from(await served.body()).equals(previewBytes)).toBe(true);
    // The tab reflows at 320px with the linked media on it.
    await page.setViewportSize({ width: 320, height: 800 });
    await expect(card.getByRole('button', { name: '연결 해제', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
    // The link is stored, not held by the screen.
    await page.reload();
    await expect(linked.getByRole('article', { name: caption, exact: true })).toBeVisible();

    // Authenticated download of the original, through the session transfer.
    const downloading = page.waitForEvent('download');
    await linked
      .getByRole('article', { name: caption, exact: true })
      .getByRole('button', { name: '원본 내려받기', exact: true })
      .click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('finish.png');
    const saved = await download.path();
    expect((await readFile(saved)).equals(originalBytes)).toBe(true);
    // Bob: every address of Alice's media is 404, and her activity's media tab is not his.
    const bobContext = await browser.newContext({ baseURL: 'http://127.0.0.1:3100' });
    try {
      // Without any session the original address serves nothing.
      const anonymous = await bobContext.request.get(originalPath);
      expect(anonymous.status()).not.toBe(200);
      expect(Buffer.from(await anonymous.body()).equals(originalBytes)).toBe(false);
      const bob = await bobContext.newPage();
      const bobHeaders = await login(bob, 'Bob');
      for (const path of [originalPath, thumbnailPath, `/bff/v1/gallery/media/${item.id}`])
        expect((await bob.request.get(path, { headers: bobHeaders })).status()).toBe(404);
      const unlinkAttempt = await bob.request.patch(`/bff/v1/gallery/media/${item.id}`, {
        headers: { ...bobHeaders, 'idempotency-key': `bob-unlink-${randomUUID()}` },
        data: { album: null, caption: null, activityId: null, expectedAccessRevision: 3 },
      });
      expect(unlinkAttempt.status()).toBe(404);
      const bobList = galleryMediaListSchema.parse(
        await (
          await bob.request.get(
            `/bff/v1/gallery/media?activityId=${activity.id}&limit=50&offset=0`,
            { headers: bobHeaders },
          )
        ).json(),
      );
      expect(bobList).toEqual({ items: [], total: 0 });
      await bob.goto(address);
      await expect(
        bob
          .getByRole('region', { name: '선택한 활동 상세', exact: true })
          .getByRole('alert')
          .filter({ hasText: '기록이 삭제되었거나 접근할 수 없습니다.' }),
      ).toBeVisible();
      await expect(bob.getByRole('region', { name: '활동 미디어', exact: true })).toHaveCount(0);
      await expect(bob.getByText(caption)).toHaveCount(0);
    } finally {
      await bobContext.close();
    }
    // Bob's attempt changed nothing.
    expect(await readLink(page, headers, item.id)).toBe(activity.id);

    // Unlink: the item leaves the tab and returns to the picker; the media itself remains.
    await linked
      .getByRole('article', { name: caption, exact: true })
      .getByRole('button', { name: '연결 해제', exact: true })
      .click();
    await expect(linked.getByText('이 활동에 연결한 미디어가 없습니다.')).toBeVisible();
    await expect(picker.getByRole('article', { name: caption, exact: true })).toBeVisible();
    await expect(
      picker
        .getByRole('article', { name: caption, exact: true })
        .getByRole('heading', { level: 5, name: caption, exact: true }),
    ).toBeFocused();
    expect(await readLink(page, headers, item.id)).toBeNull();

    // Link again, then delete the media in the gallery.
    await picker
      .getByRole('article', { name: caption, exact: true })
      .getByRole('button', { name: '이 활동에 연결', exact: true })
      .click();
    await expect(linked.getByRole('article', { name: caption, exact: true })).toBeVisible();
    expect(await readLink(page, headers, item.id)).toBe(activity.id);
    await page.goto(`${origin}/gallery`);
    const galleryCard = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: caption, exact: true }) });
    await expect(galleryCard).toHaveCount(1);
    await galleryCard.getByRole('button', { name: '삭제', exact: true }).click();
    await expect(page.getByRole('link', { name: caption, exact: true })).toHaveCount(0);

    // The tab no longer shows it, and the addresses the tab used are closed to the owner.
    await page.goto(address);
    await expect(mediaTab).toHaveAttribute('aria-selected', 'true');
    await expect(linked.getByText('이 활동에 연결한 미디어가 없습니다.')).toBeVisible();
    await expect(panel.getByText(caption)).toHaveCount(0);
    await expect(panel.getByRole('img')).toHaveCount(0);
    for (const path of [thumbnailPath, originalPath]) {
      const again = await page.request.get(`http://127.0.0.1:3100${path}`, { headers });
      expect(again.status()).toBe(404);
      expect(await again.text()).not.toContain('private/v1/tenants');
    }
    const afterDelete = await page.request.get(
      `http://127.0.0.1:3100/bff/v1/gallery/media/${item.id}`,
      { headers },
    );
    expect(afterDelete.status()).toBe(404);
  });
}
