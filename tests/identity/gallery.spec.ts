import assert from 'node:assert/strict';
import { expect, test, type Page } from '@playwright/test';
import { galleryMediaListSchema } from '../../packages/contracts/src/gallery';

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function login(page: Page, name: 'Alice' | 'Bob') {
  await page.goto('/account');
  await page.getByRole('link', { name: 'OIDC로 로그인' }).click();
  await page.getByRole('link', { name: `Sign in as ${name}` }).click();
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

// M2-03: real OIDC, same-origin BFF and isolated PostgreSQL. Gallery media stays
// private, keeps no storage reference in any response and reflows at 320px.
test('uploads, lists and deletes private gallery media through the browser', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const headers = await login(page, 'Alice');
  await page.goto('/gallery');
  await expect(page.getByRole('heading', { level: 1, name: '사진 · 동영상' })).toBeVisible();
  await expect(page.getByText('아직 저장한 사진이나 동영상이 없습니다.')).toBeVisible();

  await page.getByLabel('앨범 (선택)').fill('대회');
  await page.getByLabel('설명 (선택)').fill('결승선 사진');
  await page.getByLabel('파일').setInputFiles({
    name: 'finish.png',
    mimeType: 'image/png',
    buffer: pngBytes,
  });
  await page.getByRole('button', { name: '올리기' }).click();
  await expect(page.getByRole('link', { name: '결승선 사진' })).toBeVisible({ timeout: 30_000 });

  const listResponse = await page.request.get('/bff/v1/gallery/media?limit=50&offset=0', {
    headers,
  });
  expect(listResponse.status()).toBe(200);
  const listBody = await listResponse.text();
  expect(listBody).not.toContain('private/v1/tenants');
  const list = galleryMediaListSchema.parse(JSON.parse(listBody));
  expect(list.items).toHaveLength(1);
  const [stored] = list.items;
  assert.ok(stored);
  expect(stored).toMatchObject({
    mediaKind: 'image',
    visibility: 'private',
    includeForCoach: false,
    album: '대회',
  });

  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Bob');
    const foreign = await other.request.get(`/bff/v1/gallery/media/${stored.id}`, {
      headers: otherHeaders,
    });
    expect(foreign.status()).toBe(404);
    const foreignContent = await other.request.get(
      `/bff/v1/gallery/media/${stored.id}/content?variant=original`,
      { headers: otherHeaders },
    );
    expect(foreignContent.status()).toBe(404);
    const foreignList = galleryMediaListSchema.parse(
      await (
        await other.request.get('/bff/v1/gallery/media?limit=50&offset=0', {
          headers: otherHeaders,
        })
      ).json(),
    );
    expect(foreignList.items).toHaveLength(0);
  } finally {
    await otherContext.close();
  }

  const content = await page.request.get(
    `/bff/v1/gallery/media/${stored.id}/content?variant=original`,
    { headers },
  );
  expect(content.status()).toBe(200);
  expect(content.headers()['content-type']).toBe('image/png');
  expect(Buffer.from(await content.body()).equals(pngBytes)).toBe(true);

  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel('파일')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }

  await page.getByRole('button', { name: '삭제' }).click();
  await expect(page.getByText('아직 저장한 사진이나 동영상이 없습니다.')).toBeVisible({
    timeout: 30_000,
  });
  const afterDelete = await page.request.get(
    `/bff/v1/gallery/media/${stored.id}/content?variant=original`,
    { headers },
  );
  expect(afterDelete.status()).toBe(404);
});

// The submit control is disabled while an upload runs, so a real browser would
// refuse focus if restoration happened before the control is enabled again.
test('returns focus to the submit control after a failed upload in a real browser', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await login(page, 'Alice');
  await page.goto('/gallery');
  await expect(page.getByRole('heading', { level: 1, name: '사진 · 동영상' })).toBeVisible();
  await page.getByLabel('앨범 (선택)').fill('대회');
  await page.getByLabel('설명 (선택)').fill('보존될 초안');
  // A PNG name and content type with JPEG bytes: the server refuses it.
  await page.getByLabel('파일').setInputFiles({
    name: 'fake.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  });
  await page.getByRole('button', { name: '올리기' }).click();
  await expect(page.getByText('파일 내용이 선언한 형식과 일치하지 않습니다.')).toBeVisible({
    timeout: 30_000,
  });
  const submit = page.getByRole('button', { name: '올리기' });
  await expect(submit).toBeEnabled();
  await expect(submit).toBeFocused();
  await expect(page.getByLabel('앨범 (선택)')).toHaveValue('대회');
  await expect(page.getByLabel('설명 (선택)')).toHaveValue('보존될 초안');
});

test('refuses an upload whose bytes contradict the declared content type', async ({ page }) => {
  test.setTimeout(60_000);
  const headers = await login(page, 'Alice');
  const reservation = await page.request.post('/bff/v1/gallery/media/uploads', {
    headers: { ...headers, 'idempotency-key': 'gallery-e2e-mismatch-1' },
    data: { mediaKind: 'image' },
  });
  expect(reservation.status()).toBe(200);
  const reserved: unknown = await reservation.json();
  assert.ok(
    typeof reserved === 'object' &&
      reserved !== null &&
      'uploadId' in reserved &&
      typeof reserved.uploadId === 'string',
  );
  const mismatched = await page.request.put(
    `/bff/v1/gallery/media/uploads/${reserved.uploadId}/content`,
    {
      headers: {
        ...headers,
        'content-type': 'image/png',
        'x-gallery-file-name': encodeURIComponent('fake.png'),
      },
      data: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    },
  );
  expect(mismatched.status()).toBe(422);
  expect(await mismatched.text()).not.toContain('private/v1/tenants');
});
