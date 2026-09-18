import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { planReadSchema, planSnapshotSchema } from '../../packages/contracts/src/planning';
import {
  coachingMessageResultSchema,
  coachingMessagesSchema,
  coachingThreadListSchema,
} from '../../packages/contracts/src/coaching-threads';
import { accountExportSchema } from '../../packages/contracts/src/operations';

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

// S10: actual OIDC, same-origin BFF and isolated PostgreSQL; no model response is fabricated.
test('stores only user conversations with pinned scope, conflict recovery and account lifecycle', async ({
  page,
  browser,
}) => {
  const headers = await login(page, 'Alice');
  const base = '/bff/v1/coaching-threads';
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const post = (path: string, data: unknown, key = randomUUID()) =>
    page.request.post(path, { headers: { ...headers, 'idempotency-key': key }, data });
  try {
    const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
    const planResponse = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: {
        source: 'manual',
        confirmed: true,
        expectedVersionId: current.head?.id ?? null,
        draft: {
          title: 'Synthetic consultation plan',
          timezone: 'UTC',
          sessions: [],
          periods: (['season', 'wave', 'phase'] as const).map((level, index, levels) => ({
            id: level,
            parentId: index === 0 ? null : levels[index - 1],
            level,
            title: level,
            startDate: '2026-09-01',
            endDateExclusive: '2026-10-01',
            timezone: 'UTC',
            intent: '',
            isPartial: false,
          })),
        },
      },
    });
    expect(planResponse.status()).toBe(200);
    const plan = planSnapshotSchema.parse(await planResponse.json());
    const payload = {
      planVersionId: plan.id,
      scope: { kind: 'phase', targetId: 'phase' },
      title: '사용자 상담',
      message: '  다음 기간의 운동 시간을 검토하고 싶습니다.\n',
    };
    const key = randomUUID();
    const first = await post(base, payload, key);
    expect(first.status()).toBe(200);
    const created = coachingMessageResultSchema.parse(await first.json());
    expect(created.message.content).toBe(payload.message);
    const replay = await post(base, payload, key);
    expect(replay.status()).toBe(200);
    expect(coachingMessageResultSchema.parse(await replay.json())).toEqual(created);
    const path = `${base}/${created.thread.id}/messages`;
    const appendKey = randomUUID();
    const append = { expectedRevision: 1, message: '추가로 금요일에는 운동할 수 없습니다.' };
    const appended = await post(path, append, appendKey);
    expect(appended.status()).toBe(200);
    const result = coachingMessageResultSchema.parse(await appended.json());
    expect(result.thread.revision).toBe(2);
    expect(result.message.role).toBe('user');
    const stale = await post(path, { expectedRevision: 1, message: '오래된 화면의 요청' });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'CONVERSATION_REVISION_CONFLICT' } });
    const appendReplay = await post(path, append, appendKey);
    expect(appendReplay.status()).toBe(200);
    expect(coachingMessageResultSchema.parse(await appendReplay.json())).toEqual(result);
    const firstPage = coachingMessagesSchema.parse(await get(`${path}?limit=1`));
    expect(firstPage.messages).toEqual([created.message]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = coachingMessagesSchema.parse(await get(`${path}?afterRevision=1&limit=1`));
    expect(secondPage.messages).toEqual([result.message]);
    expect(secondPage.hasMore).toBe(false);
    expect(coachingThreadListSchema.parse(await get(base)).items).toContainEqual(result.thread);
    expect(planReadSchema.parse(await get('/bff/v1/plans/current')).head?.id).toBe(plan.id);
    const nonUser = await post(path, {
      expectedRevision: 2,
      message: 'fabricated',
      role: 'assistant',
    });
    expect(nonUser.status()).toBe(400);
    const noCsrf = await page.request.post(path, {
      headers: { origin: headers.origin, 'x-workout-session-id': headers['x-workout-session-id'] },
      data: { expectedRevision: 2, message: 'no csrf' },
    });
    expect(noCsrf.status()).toBe(403);
    const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
    try {
      const other = await otherContext.newPage();
      const otherHeaders = await login(other, 'Bob');
      expect((await other.request.get(path, { headers: otherHeaders })).status()).toBe(404);
      const foreign = await other.request.post(base, {
        headers: { ...otherHeaders, 'idempotency-key': randomUUID() },
        data: payload,
      });
      expect(foreign.status()).toBe(404);
      expect(
        coachingThreadListSchema.parse(
          await (await other.request.get(base, { headers: otherHeaders })).json(),
        ).items,
      ).not.toContainEqual(result.thread);
    } finally {
      await otherContext.close();
    }
    const exportResponse = await page.request.post('/bff/v1/operations/export', { headers });
    expect(exportResponse.status()).toBe(200);
    const exported = accountExportSchema.parse(await exportResponse.json());
    assert.equal(exported.schemaVersion, 9);
    if (exported.schemaVersion !== 9) throw new Error('Expected conversation export v9');
    expect(exported.data.coachingThreads).toHaveLength(1);
    expect(exported.data.coachingMessages.map((message) => message['content'])).toEqual([
      payload.message,
      append.message,
    ]);
  } finally {
    const erased = await page.request.delete('/bff/v1/operations/account', {
      headers,
      data: { confirmation: 'DELETE MY ACCOUNT' },
      timeout: 5000,
    });
    expect(erased.status()).toBe(200);
    expect((await page.request.get(base)).status()).toBe(401);
  }
});
