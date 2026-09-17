import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { activitySchema, manualActivityResultSchema } from '../../packages/contracts/src/activity';
import { checkInCommandResultSchema, checkInSchema } from '../../packages/contracts/src/check-ins';
import {
  coachingMessageResultSchema,
  coachingMessagesSchema,
} from '../../packages/contracts/src/coaching-threads';
import {
  coreEvidenceSnapshotSchema,
  coreEvidenceSnapshotListSchema,
} from '../../packages/contracts/src/evidence-snapshots';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { viewportFixtures } from '../../packages/ui/foundation/src/responsive';

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
const window = { from: '2024-03-10', toExclusive: '2024-03-11', timezone: 'America/New_York' };
const evidence = (page: Page) => page.getByRole('region', { name: '저장된 근거', exact: true });
const selectedEvidence = (page: Page) =>
  page.getByRole('region', { name: '선택한 근거', exact: true });
const message = (page: Page) => page.getByRole('textbox', { name: '사용자 메시지', exact: true });
async function openEvidenceGroup(page: Page, name: string) {
  const details = selectedEvidence(page)
    .locator('details')
    .filter({
      has: page.locator('summary').filter({ hasText: name }),
    });
  const summary = details.locator('summary').first();
  await expect(summary).toBeVisible();
  if ((await details.getAttribute('open')) === null) await summary.click();
  return details;
}

async function setup(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const post = (path: string, data: unknown) =>
    page.request.post(path, { headers: { ...headers, 'idempotency-key': randomUUID() }, data });
  const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const draft = planDraftSchema.parse({
    title: 'Synthetic evidence UI plan',
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
  });
  const planResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(planResponse.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await planResponse.json());
  const threadResponse = await post('/bff/v1/coaching-threads', {
    planVersionId: saved.id,
    title: 'Synthetic evidence UI conversation',
    scope: { kind: 'phase', targetId: 'phase' },
    message: '저장된 합성 사용자 메시지',
  });
  expect(threadResponse.status()).toBe(200);
  const { thread } = coachingMessageResultSchema.parse(await threadResponse.json());
  const activityResponse = await post('/bff/v1/activities', {
    confirmed: true,
    activity: {
      title: '합성 거리 0 활동',
      kind: 'running',
      startedAt: '2024-03-11T03:30:00Z',
      timezone: 'Asia/Seoul',
      distanceMeters: 0,
      durationSeconds: null,
      durationKind: 'unknown',
    },
    report: { sessionRpe: 0, note: null, planLink: null },
  });
  expect(activityResponse.status()).toBe(200);
  const activity = manualActivityResultSchema.parse(await activityResponse.json());
  const values = {
    observedAt: '2024-03-11T03:30:00Z',
    timezone: 'Asia/Seoul',
    fatigue: 0,
    discomfort: null,
    bodyLocation: null,
    note: '저장 당시의 합성 체크인',
  };
  const checkInResponse = await post('/bff/v1/check-ins', { values });
  expect(checkInResponse.status()).toBe(200);
  const checkIn = checkInCommandResultSchema.parse(await checkInResponse.json());
  const collection = `/bff/v1/coaching-threads/${thread.id}/evidence-snapshots`;
  const list = async () => coreEvidenceSnapshotListSchema.parse(await get(collection));
  const read = async (id: string) =>
    coreEvidenceSnapshotSchema.parse(await get(`/bff/v1/evidence-snapshots/${id}`));
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/bff/v1/') && !['GET', 'HEAD'].includes(request.method()))
      writes.push(`${request.method()} ${path}`);
  });
  await page.goto(`/coach?thread=${thread.id}&snapshotOffset=0`);
  await expect(page.getByRole('region', { name: '사용자 메시지 기록', exact: true })).toContainText(
    '저장된 합성 사용자 메시지',
  );
  await evidence(page).getByLabel('근거 시작일', { exact: true }).fill(window.from);
  await evidence(page).getByLabel('근거 종료일 (제외)', { exact: true }).fill(window.toExclusive);
  await evidence(page)
    .getByRole('textbox', { name: '근거 시간대', exact: true })
    .fill(window.timezone);
  await expect(
    evidence(page).getByRole('button', { name: '근거 저장', exact: true }),
  ).toBeEnabled();
  expect(writes).toEqual([]);
  return {
    headers,
    get,
    post,
    saved,
    thread,
    activity,
    checkIn,
    values,
    collection,
    list,
    read,
    writes,
  };
}
async function capture(page: Page, path: string) {
  const response = page.waitForResponse(
    (reply) => new URL(reply.url()).pathname === path && reply.request().method() === 'POST',
  );
  await evidence(page).getByRole('button', { name: '근거 저장', exact: true }).click();
  const committed = await response;
  expect(committed.status()).toBe(200);
  const snapshot = coreEvidenceSnapshotSchema.parse(await committed.json());
  await expect(page).toHaveURL(new RegExp(`snapshot=${snapshot.id}`));
  await expect(selectedEvidence(page)).toBeVisible();
  return snapshot;
}

// All successful reads and writes use actual OIDC/BFF/PostgreSQL, without synthesized model output.
test('explicitly captures saved evidence, keeps unsaved text outside the snapshot and refreshes a deleted-source tombstone', async ({
  page,
}) => {
  const f = await setup(page);
  const draftText = '근거에 포함되면 안 되는 미저장 합성 메시지';
  await message(page).fill(draftText);
  await message(page).focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(message(page)).toHaveValue(draftText);
    await expect(message(page)).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  expect((await f.list()).total).toBe(0);
  expect(f.writes).toEqual([]);
  const snapshot = await capture(page, f.collection);
  assert.ok(snapshot.status === 'available');
  expect(snapshot.body.messages.map((item) => item.content)).toEqual(['저장된 합성 사용자 메시지']);
  expect(JSON.stringify(snapshot.body)).not.toContain(draftText);
  expect(snapshot.body.activities).toEqual([
    expect.objectContaining({
      localDate: '2024-03-10',
      record: expect.objectContaining({
        id: f.activity.activityId,
        effective: expect.objectContaining({
          distanceMeters: 0,
          durationSeconds: null,
          durationKind: 'unknown',
        }),
      }),
    }),
  ]);
  expect(snapshot.body.checkIns).toEqual([
    expect.objectContaining({
      localDate: '2024-03-10',
      record: expect.objectContaining({
        id: f.checkIn.id,
        values: expect.objectContaining({ fatigue: 0, discomfort: null }),
      }),
    }),
  ]);
  await expect(message(page)).toHaveValue(draftText);
  await openEvidenceGroup(page, '실제 활동 1개');
  const activity = selectedEvidence(page).getByRole('article', {
    name: `근거 활동 ${f.activity.activityId}`,
    exact: true,
  });
  await expect(activity.getByText('0 m', { exact: true }).first()).toBeVisible();
  await expect(activity.getByText('미보고 · 정의 미확인', { exact: true }).first()).toBeVisible();
  const checkInGroup = await openEvidenceGroup(page, '체크인 사용자 보고 1개');
  await expect(
    checkInGroup.getByText('피로: 0 · 불편감: 미보고 · 신체 부위: 미보고', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(message(page)).toHaveValue(draftText);
  await expect(selectedEvidence(page)).toContainText('저장 당시의 합성 체크인');
  await expect(selectedEvidence(page)).not.toContainText(draftText);
  await expect(
    evidence(page).getByRole('button', {
      name: `근거 보기 ${snapshot.createdAt} ${snapshot.id}`,
      exact: true,
    }),
  ).toBeVisible();
  const correction = await page.request.put(`/bff/v1/check-ins/${f.checkIn.id}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: {
      expectedRevision: f.checkIn.revision,
      reason: 'Synthetic later correction',
      values: { ...f.values, fatigue: null, discomfort: 0, note: '나중에 정정된 합성 체크인' },
    },
  });
  expect(correction.status()).toBe(200);
  const corrected = checkInCommandResultSchema.parse(await correction.json());
  await selectedEvidence(page)
    .getByRole('button', { name: '선택한 근거 새로 확인', exact: true })
    .click();
  await expect(selectedEvidence(page)).toContainText('저장 당시의 합성 체크인');
  await expect(selectedEvidence(page)).not.toContainText('나중에 정정된 합성 체크인');
  expect(await f.read(snapshot.id)).toEqual(snapshot);
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    await dialog.accept();
  });
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`snapshot=${snapshot.id}`));
  await openEvidenceGroup(page, '체크인 사용자 보고 1개');
  await expect(
    selectedEvidence(page).getByText('메모: 저장 당시의 합성 체크인', { exact: true }),
  ).toBeVisible();
  expect(await f.read(snapshot.id)).toEqual(snapshot);
  const removed = await page.request.delete(`/bff/v1/check-ins/${f.checkIn.id}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: { expectedRevision: corrected.revision },
  });
  expect(removed.status()).toBe(200);
  await selectedEvidence(page)
    .getByRole('button', { name: '선택한 근거 새로 확인', exact: true })
    .click();
  await expect(selectedEvidence(page).getByRole('status')).toContainText(
    '근거 본문이 폐기되었습니다.',
  );
  await expect(selectedEvidence(page)).toContainText('포함된 원본 기록이 삭제되었습니다.');
  await expect(selectedEvidence(page)).not.toContainText('저장 당시의 합성 체크인');
  await expect(selectedEvidence(page)).not.toContainText('합성 거리 0 활동');
  expect(await f.read(snapshot.id)).toEqual({
    id: snapshot.id,
    threadId: f.thread.id,
    createdAt: snapshot.createdAt,
    status: 'purged',
    reason: 'source_deleted',
  });
  expect((await f.list()).total).toBe(1);
  expect(planReadSchema.parse(await f.get('/bff/v1/plans/current')).head).toEqual(f.saved);
  expect(
    activitySchema.parse(await f.get(`/bff/v1/activities/${f.activity.activityId}`)).revision,
  ).toBe(f.activity.revision);
  expect(f.writes).toEqual([`POST ${f.collection}`]);
});

test('retries a committed capture with the identical frozen request and preserves the message draft', async ({
  page,
}) => {
  const f = await setup(page);
  const text = '응답 유실 중에도 보존할 합성 초안';
  await message(page).fill(text);
  const attempts: { key: string | null; body: string | null }[] = [];
  await page.route(`**${f.collection}`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({
      key: route.request().headers()['idempotency-key'] ?? null,
      body: route.request().postData(),
    });
    if (attempts.length === 1) {
      const committed = await route.fetch();
      expect(committed.status()).toBe(200);
      await route.abort('failed');
    } else await route.continue();
  });
  await evidence(page).getByRole('button', { name: '근거 저장', exact: true }).click();
  const retry = evidence(page).getByRole('button', { name: '근거 같은 요청 재확인', exact: true });
  await expect(retry).toBeVisible();
  await expect(evidence(page).getByLabel('근거 시작일', { exact: true })).toBeDisabled();
  await expect(message(page)).toHaveValue(text);
  await expect(
    page.getByRole('button', { name: '사용자 메시지 저장', exact: true }),
  ).toBeDisabled();
  const committedList = await f.list();
  expect(committedList.total).toBe(1);
  const id = committedList.items[0]?.id;
  assert.ok(id);
  const committed = await f.read(id);
  await retry.click();
  await expect(page).toHaveURL(new RegExp(`snapshot=${id}`));
  await expect(selectedEvidence(page)).toContainText('저장 당시의 합성 체크인');
  await expect(message(page)).toHaveValue(text);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
  expect(await f.read(id)).toEqual(committed);
  expect((await f.list()).total).toBe(1);
  expect(
    coachingMessagesSchema.parse(await f.get(`/bff/v1/coaching-threads/${f.thread.id}/messages`))
      .messages,
  ).toHaveLength(1);
  expect(planReadSchema.parse(await f.get('/bff/v1/plans/current')).head).toEqual(f.saved);
  expect(checkInSchema.parse(await f.get(`/bff/v1/check-ins/${f.checkIn.id}`)).revision).toBe(1);
  expect(f.writes).toEqual([`POST ${f.collection}`, `POST ${f.collection}`]);
});

test('requires explicit conversation refresh after capture conflict and keeps the unsaved message through keyboard reflow', async ({
  page,
}) => {
  const f = await setup(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const text = '다른 탭이 수정해도 보존할 합성 초안';
  await message(page).fill(text);
  const concurrent = await f.post(`/bff/v1/coaching-threads/${f.thread.id}/messages`, {
    expectedRevision: 1,
    message: '다른 탭에서 저장된 합성 메시지',
  });
  expect(concurrent.status()).toBe(200);
  const response = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === f.collection && reply.request().method() === 'POST',
  );
  const save = evidence(page).getByRole('button', { name: '근거 저장', exact: true });
  await save.focus();
  await page.keyboard.press('Enter');
  expect((await response).status()).toBe(409);
  await expect(message(page)).toHaveValue(text);
  expect((await f.list()).total).toBe(0);
  await expect(save).toBeDisabled();
  const refresh = evidence(page).getByRole('button', { name: '상담 기록 새로 확인', exact: true });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '사용자 메시지 기록', exact: true })).toContainText(
    '다른 탭에서 저장된 합성 메시지',
  );
  await expect(save).toBeEnabled();
  await expect(message(page)).toHaveValue(text);
  expect((await f.list()).total).toBe(0);
  expect(f.writes).toEqual([`POST ${f.collection}`]);
  await message(page).focus();
  for (const viewport of [
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
    { width: 320, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(message(page)).toBeFocused();
    await expect(message(page)).toHaveValue(text);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const snapshot = await capture(page, f.collection);
  assert.ok(snapshot.status === 'available');
  expect(snapshot.body.thread.revision).toBe(2);
  expect(snapshot.body.messages.map((item) => item.content)).toEqual([
    '저장된 합성 사용자 메시지',
    '다른 탭에서 저장된 합성 메시지',
  ]);
  expect(JSON.stringify(snapshot.body)).not.toContain(text);
  await expect(message(page)).toHaveValue(text);
  expect((await f.list()).total).toBe(1);
  expect(planReadSchema.parse(await f.get('/bff/v1/plans/current')).head).toEqual(f.saved);
  expect(f.writes).toEqual([`POST ${f.collection}`, `POST ${f.collection}`]);
});
