import assert from 'node:assert/strict';
import { expect, test, type Page } from '@playwright/test';
import {
  privateResourceListSchema,
  privateResourceReadResultSchema,
  privateTextResourceReadResultSchema,
} from '../../packages/contracts/src/resources';

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

// M2-04a: real OIDC, same-origin BFF and isolated PostgreSQL; text remains private and unindexed.
test('creates, versions, pins and deletes a private text resource', async ({ page, browser }) => {
  test.setTimeout(60_000);
  const headers = await login(page, 'Alice');
  await page.goto('/resources');
  await expect(page.getByRole('heading', { level: 1, name: '자료실' })).toBeVisible();
  const createForm = page.getByRole('form', { name: '텍스트 자료 만들기' });
  await createForm.getByLabel('제목', { exact: true }).fill('레이스 회복 메모');
  await expect(createForm.getByRole('combobox', { name: '분류' })).toHaveValue('note');
  await createForm
    .getByLabel('원문', { exact: true })
    .fill('첫 원문 문단입니다.\n\n두 번째 문단입니다.');
  await createForm.getByRole('button', { name: '텍스트 자료 저장' }).click();
  await expect(page).toHaveURL(/\/resources\/[0-9a-f-]+$/);
  await expect(
    page.getByText('원문 버전 1 · 파싱 완료 · 검색 색인 안 됨 · 코치 사용 안 함'),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: '문단 2 링크' })).toBeVisible();

  const listResponse = await page.request.get('/bff/v1/resources?limit=50&offset=0', { headers });
  expect(listResponse.status()).toBe(200);
  const list = privateResourceListSchema.parse(await listResponse.json());
  expect(list.items).toHaveLength(1);
  const [listed] = list.items;
  assert.ok(listed);
  const resourceId = listed.id;
  const firstVersionId = listed.currentVersionId;

  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Bob');
    expect(
      (
        await other.request.get(`/bff/v1/resources/${resourceId}`, { headers: otherHeaders })
      ).status(),
    ).toBe(404);
    const otherList = await other.request.get('/bff/v1/resources?limit=50&offset=0', {
      headers: otherHeaders,
    });
    expect(privateResourceListSchema.parse(await otherList.json()).items).toEqual([]);
  } finally {
    await otherContext.close();
  }

  const versionForm = page.getByRole('form', { name: '새 텍스트 자료 버전 저장' });
  await versionForm.getByLabel('수정한 원문').fill('수정된 원문입니다.');
  await versionForm.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(
    page.getByText('원문 버전 2 · 파싱 완료 · 검색 색인 안 됨 · 코치 사용 안 함'),
  ).toBeVisible();
  await page.getByRole('link', { name: '이전 버전 열기' }).click();
  await expect(page).toHaveURL(new RegExp(`version=${firstVersionId}$`));
  await expect(page.getByRole('listitem').filter({ hasText: '첫 원문 문단입니다.' })).toBeVisible();

  await page.goto(`http://127.0.0.1:4200/resources/${resourceId}?version=${firstVersionId}`);
  await expect(
    page.getByText('원문 버전 1 · 파싱 완료 · 검색 색인 안 됨 · 코치 사용 안 함'),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 800 });

  const currentResponse = await page.request.get(
    `http://127.0.0.1:3100/bff/v1/resources/${resourceId}`,
    { headers },
  );
  const current = privateTextResourceReadResultSchema.parse(await currentResponse.json());
  assert.equal(current.status, 'available');
  await page.goto(`http://127.0.0.1:3100/resources/${resourceId}`);
  await page.getByLabel('삭제 결과를 확인했습니다').check();
  await page.getByRole('button', { name: '자료 삭제' }).click();
  await expect(page).toHaveURL(/\/resources$/);
  await expect(page.getByText('저장한 자료가 없습니다.')).toBeVisible();
  const deletedCurrentResponse = await page.request.get(`/bff/v1/resources/${resourceId}`, {
    headers,
  });
  expect(deletedCurrentResponse.status()).toBe(200);
  expect(
    privateTextResourceReadResultSchema.parse(await deletedCurrentResponse.json()).status,
  ).toBe('deleted');
  const deletedHistoryResponse = await page.request.get(
    `/bff/v1/resources/${resourceId}?versionId=${firstVersionId}`,
    { headers },
  );
  expect(deletedHistoryResponse.status()).toBe(200);
  expect(
    privateTextResourceReadResultSchema.parse(await deletedHistoryResponse.json()).status,
  ).toBe('deleted');
});

test('uploads, downloads, versions and deletes a private Markdown file', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const headers = await login(page, 'Alice');
  await page.goto('/resources');
  const createForm = page.getByRole('form', { name: '파일 자료 만들기' });
  await createForm.getByLabel('제목', { exact: true }).fill('레이스 체크리스트');
  await createForm.getByLabel('원본 파일').setInputFiles({
    name: '레이스-체크리스트.markdown',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 레이스\n\n- 물\n- 젤'),
  });
  await createForm.getByRole('button', { name: '원본 파일 업로드' }).click();
  await expect(page).toHaveURL(/\/resources\/[0-9a-f-]+$/);
  await expect(
    page.getByText(
      '원문 버전 1 · 원본 파일 저장됨 · 본문 파싱 안 됨 · 검색 색인 안 됨 · 코치 사용 안 함',
    ),
  ).toBeVisible();
  await expect(page.getByText('레이스-체크리스트.markdown')).toBeVisible();
  await expect(page.getByText(/본문 파싱과 페이지 인용은 아직 제공되지 않습니다/)).toBeVisible();

  const listResponse = await page.request.get('/bff/v1/resources?limit=50&offset=0', { headers });
  const list = privateResourceListSchema.parse(await listResponse.json());
  const listed = list.items.find((item) => item.title === '레이스 체크리스트');
  assert.ok(listed?.sourceKind === 'file');
  const resourceId = listed.id;
  const firstVersionId = listed.currentVersionId;

  const download = await page.request.get(
    `/bff/v1/resources/${resourceId}/content?versionId=${firstVersionId}`,
    { headers },
  );
  expect(download.status()).toBe(200);
  expect(download.headers()['content-type']).toContain('text/markdown');
  expect((await download.body()).toString('utf8')).toBe('# 레이스\n\n- 물\n- 젤');

  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Bob');
    expect(
      (
        await other.request.get(`/bff/v1/resources/${resourceId}/content`, {
          headers: otherHeaders,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }

  const appendForm = page.getByRole('form', { name: '새 파일 자료 버전 저장' });
  await appendForm.getByLabel('교체할 원본 파일').setInputFiles({
    name: '레이스-체크리스트.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# 레이스\n\n- 물\n- 젤\n- 번호표'),
  });
  await appendForm.getByRole('button', { name: '새 파일 버전 업로드' }).click();
  await expect(page.getByText(/원문 버전 2 · 원본 파일 저장됨/)).toBeVisible();
  await page.getByRole('link', { name: '이전 버전 열기' }).click();
  await expect(page).toHaveURL(new RegExp(`version=${firstVersionId}$`));
  await expect(page.getByText('레이스-체크리스트.markdown')).toBeVisible();

  await page.setViewportSize({ width: 320, height: 760 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 1280, height: 800 });

  const currentResponse = await page.request.get(`/bff/v1/resources/${resourceId}`, { headers });
  const current = privateResourceReadResultSchema.parse(await currentResponse.json());
  assert.equal(current.status, 'available');
  await page.goto(`/resources/${resourceId}`);
  await page.getByLabel('삭제 결과를 확인했습니다').check();
  await page.getByRole('button', { name: '자료 삭제' }).click();
  await expect(page).toHaveURL(/\/resources$/);
  expect(
    privateResourceReadResultSchema.parse(
      await (await page.request.get(`/bff/v1/resources/${resourceId}`, { headers })).json(),
    ).status,
  ).toBe('deleted');
  expect(
    (await page.request.get(`/bff/v1/resources/${resourceId}/content`, { headers })).status(),
  ).toBe(404);
});
