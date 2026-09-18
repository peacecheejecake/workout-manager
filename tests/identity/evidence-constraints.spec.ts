import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { coachingConstraintCommandResultSchema } from '../../packages/contracts/src/coaching-constraints';
import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import {
  coreEvidenceSnapshotSchema,
  coreEvidenceSnapshotListSchema,
} from '../../packages/contracts/src/evidence-snapshots';
import { planReadSchema, planSnapshotSchema } from '../../packages/contracts/src/planning';
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
const cleanupHeaders = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const headers = cleanupHeaders.get(page);
  if (!headers) return;
  cleanupHeaders.delete(page);
  const response = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(response.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
});

// Only the isolated OIDC harness's synthetic Alice account is seeded and erased.
// Every business outcome below uses the real BFF and PostgreSQL; no model or API mocks.
test('mandatory confirmed constraints remain frozen across captures and are purged after source deletion without replay resurrection', async ({
  page,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const get = async (path: string) => {
    const r = await page.request.get(path, { headers });
    expect(r.status()).toBe(200);
    return r.json();
  };
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post(path, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data,
    });
    expect(r.status()).toBe(200);
    return r.json();
  };
  const firstText = '합성 사용자 제약 · 먼저 설명을 요청한다';
  const secondText = '합성 사용자 제약 · 선택 기간과 관계없이 확인한다';
  const first = coachingConstraintCommandResultSchema.parse(
    await post('/bff/v1/coaching-constraints', {
      expectedHeadRevision: null,
      confirmed: true,
      text: firstText,
    }),
  );
  await post('/bff/v1/coaching-constraints', {
    expectedHeadRevision: first.headRevision,
    confirmed: true,
    text: secondText,
  });
  const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const planResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: current.head?.id ?? null,
      draft: {
        title: 'Mandatory constraints synthetic plan',
        timezone: 'UTC',
        sessions: [],
        periods: (['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
          id: level,
          parentId: index === 0 ? null : levels[index - 1],
          level,
          title: level,
          startDate: '2024-03-01',
          endDateExclusive: '2024-04-01',
          timezone: 'UTC',
          intent: '',
          isPartial: false,
        })),
      },
    },
  });
  expect(planResponse.status()).toBe(200);
  const plan = planSnapshotSchema.parse(await planResponse.json());
  const { thread } = coachingMessageResultSchema.parse(
    await post('/bff/v1/coaching-threads', {
      planVersionId: plan.id,
      title: 'Mandatory constraints synthetic thread',
      scope: { kind: 'phase', targetId: 'phase' },
      message: '사용자 합성 검토 요청',
    }),
  );
  const collection = `/bff/v1/coaching-threads/${thread.id}/evidence-snapshots`;
  await page.goto(`/coach?thread=${thread.id}`);
  const evidence = page.getByRole('region', { name: '저장된 근거', exact: true });
  const constraints = page.getByRole('region', { name: '필수 사용자 제약', exact: true });
  await evidence.getByLabel('근거 시작일', { exact: true }).fill('2025-09-01');
  await evidence.getByLabel('근거 종료일 (제외)', { exact: true }).fill('2025-09-02');
  await evidence.getByRole('textbox', { name: '근거 시간대', exact: true }).fill('Asia/Seoul');
  async function capture() {
    const waiting = page.waitForResponse(
      (r) => new URL(r.url()).pathname === collection && r.request().method() === 'POST',
    );
    await evidence.getByRole('button', { name: '근거 저장', exact: true }).click();
    const r = await waiting;
    expect(r.status()).toBe(200);
    const snapshot = coreEvidenceSnapshotSchema.parse(await r.json());
    const key = r.request().headers()['idempotency-key'];
    assert.ok(key);
    const body: unknown = r.request().postDataJSON();
    await expect(page).toHaveURL(new RegExp(`snapshot=${snapshot.id}`));
    return { snapshot, key, body };
  }
  const firstCapture = await capture();
  assert.equal(firstCapture.snapshot.status, 'available');
  assert.equal(firstCapture.snapshot.body.schemaVersion, 2);
  expect(firstCapture.snapshot.body.userConstraints.items.map((item) => item.text)).toEqual(
    expect.arrayContaining([firstText, secondText]),
  );
  expect(firstCapture.snapshot.body.userConstraints.items).toHaveLength(2);
  const selected = page.getByRole('region', { name: '선택한 근거', exact: true });
  await expect(
    selected.getByRole('region', { name: '필수 사용자 제약 근거', exact: true }),
  ).toBeVisible();
  await expect(selected.getByText(firstText, { exact: true })).toBeVisible();
  await expect(selected.getByText(secondText, { exact: true })).toBeVisible();
  const updatedText = '합성 사용자 제약 · 수정한 문장도 직접 확인한다';
  await constraints.getByRole('button', { name: `제약 수정 · ${firstText}`, exact: true }).click();
  await constraints
    .getByRole('textbox', { name: '사용자 제약 문장', exact: true })
    .fill(updatedText);
  await constraints.getByRole('button', { name: '제약 변경 검토', exact: true }).click();
  await constraints.getByRole('button', { name: '확인하고 제약 변경', exact: true }).click();
  await expect(
    constraints.getByRole('button', { name: `제약 수정 · ${updatedText}`, exact: true }),
  ).toBeVisible();
  const frozen = coreEvidenceSnapshotSchema.parse(
    await get(`/bff/v1/evidence-snapshots/${firstCapture.snapshot.id}`),
  );
  expect(frozen).toEqual(firstCapture.snapshot);
  const secondCapture = await capture();
  assert.equal(secondCapture.snapshot.status, 'available');
  assert.equal(secondCapture.snapshot.body.schemaVersion, 2);
  expect(secondCapture.snapshot.body.userConstraints.items.map((item) => item.text)).toEqual(
    expect.arrayContaining([updatedText, secondText]),
  );
  expect(secondCapture.snapshot.body.userConstraints.headRevision).toBe(3);
  await expect(selected.getByText(updatedText, { exact: true })).toBeVisible();
  await constraints
    .getByRole('button', { name: `제약 삭제 · ${updatedText}`, exact: true })
    .click();
  const deletion = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/bff/v1/coaching-constraints/${first.id}` &&
      response.request().method() === 'DELETE',
  );
  await constraints.getByRole('button', { name: '확인하고 제약 변경', exact: true }).click();
  expect((await deletion).status()).toBe(200);
  await expect(
    constraints.getByRole('button', { name: `제약 수정 · ${updatedText}`, exact: true }),
  ).toHaveCount(0);
  await expect(selected.getByText(updatedText, { exact: true })).toHaveCount(0);
  await expect(selected.getByText(/근거 본문이 폐기되었습니다/)).toBeVisible();
  for (const capture of [firstCapture, secondCapture]) {
    const snapshot = coreEvidenceSnapshotSchema.parse(
      await get(`/bff/v1/evidence-snapshots/${capture.snapshot.id}`),
    );
    expect(snapshot.status).toBe('purged');
    expect(snapshot).not.toHaveProperty('body');
    const replay = await page.request.post(collection, {
      headers: { ...headers, 'idempotency-key': capture.key },
      data: capture.body,
    });
    expect(replay.status()).toBe(200);
    expect(coreEvidenceSnapshotSchema.parse(await replay.json())).toEqual(snapshot);
  }
  const list = coreEvidenceSnapshotListSchema.parse(await get(collection));
  expect(list.total).toBe(2);
  expect(list.items.every((item) => item.status === 'purged')).toBe(true);
  await expect(selected.getByText(/근거 본문이 폐기되었습니다/)).toBeVisible();
  await expect(selected.getByText(updatedText, { exact: true })).toHaveCount(0);
  await expect(selected.getByText(secondText, { exact: true })).toHaveCount(0);
});
