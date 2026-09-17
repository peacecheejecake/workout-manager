import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { activityListSchema } from '../../packages/contracts/src/activity';
import {
  sessionCompletionResultSchema,
  sessionCompletionReadSchema,
  sessionCompletionListSchema,
} from '../../packages/contracts/src/session-completion';

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

const cleanupHeaders = new WeakMap<Page, Awaited<ReturnType<typeof login>>>();
test.afterEach(async ({ page }) => {
  const headers = cleanupHeaders.get(page);
  if (!headers) return;
  cleanupHeaders.delete(page);
  // Teardown has its own timeout budget, even if the product journey fails.
  // Local isolated OIDC/PostgreSQL synthetic Alice only; never external accounts.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});

test('completion reports protect saved scheduling until explicit retraction without creating actual activities', async ({
  page,
  browser,
}) => {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers, timeout: 5000 });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const previous = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const actualBefore = activityListSchema.parse(await get('/bff/v1/activities')).total;
  const sessionId = `완료 / ${randomUUID()}`;
  const draft = planDraftSchema.parse({
    title: 'Synthetic completion plan',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `completion-${level}`,
      parentId: index === 0 ? null : `completion-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: sessionId,
        blockId: 'completion-block',
        date: '2026-09-20',
        localStartTime: null,
        title: 'Synthetic completed report',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  });
  const initial = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: previous.head?.id ?? null,
      draft,
    },
  });
  expect(initial.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await initial.json());
  const path = `/bff/v1/plans/sessions/${encodeURIComponent(sessionId)}/completion`;
  expect(sessionCompletionReadSchema.parse(await get(path)).report).toBeNull();
  const key = randomUUID();
  const command = {
    action: 'complete',
    confirmed: true,
    expectedPlanVersionId: saved.id,
    expectedRevision: null,
    reason: null,
  };
  // Discard the successful body, then retry the identical command as a client missing its receipt.
  const first = await page.request.post(path, {
    headers: { ...headers, 'idempotency-key': key },
    data: command,
    timeout: 5000,
  });
  expect(first.status()).toBe(200);
  await first.dispose();
  const replay = await page.request.post(path, {
    headers: { ...headers, 'idempotency-key': key },
    data: command,
    timeout: 5000,
  });
  expect(replay.status()).toBe(200);
  const completed = sessionCompletionResultSchema.parse(await replay.json());
  expect(completed.report).toMatchObject({
    revision: 1,
    status: 'completed',
    source: 'user',
    method: 'self_report',
    schedule: { date: '2026-09-20' },
  });
  expect(sessionCompletionReadSchema.parse(await get(path)).totalHistory).toBe(1);
  const movedDraft = {
    ...draft,
    sessions: draft.sessions.map((session) => ({ ...session, date: '2026-09-21' })),
  };
  const move = () =>
    page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { source: 'manual', confirmed: true, expectedVersionId: saved.id, draft: movedDraft },
      timeout: 5000,
    });
  const blocked = await move();
  expect(blocked.status()).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: 'PLAN_COMPLETED_SESSION' } });
  expect(planReadSchema.parse(await get('/bff/v1/plans/current')).head?.id).toBe(saved.id);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Bob');
    expect((await other.request.get(path, { headers: otherHeaders, timeout: 5000 })).status()).toBe(
      404,
    );
    expect(
      (
        await other.request.post(path, {
          headers: { ...otherHeaders, 'idempotency-key': randomUUID() },
          data: command,
          timeout: 5000,
        })
      ).status(),
    ).toBe(404);
    expect(
      sessionCompletionListSchema
        .parse(
          await (
            await other.request.get('/bff/v1/plans/current/session-completions', {
              headers: otherHeaders,
              timeout: 5000,
            })
          ).json(),
        )
        .items.some((report) => report.sessionId === sessionId),
    ).toBe(false);
  } finally {
    await otherContext.close();
  }
  const retract = await page.request.post(path, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      action: 'retract',
      confirmed: true,
      expectedPlanVersionId: saved.id,
      expectedRevision: 1,
      reason: 'Synthetic mistaken confirmation',
    },
  });
  expect(retract.status()).toBe(200);
  expect(sessionCompletionResultSchema.parse(await retract.json()).report.status).toBe('retracted');
  const moved = await move();
  expect(moved.status()).toBe(200);
  const next = planSnapshotSchema.parse(await moved.json());
  const stale = await page.request.post(path, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: { ...command, expectedRevision: 2, reason: 'Synthetic reconfirmation' },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: 'PLAN_REVISION_CONFLICT' } });
  const again = await page.request.post(path, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    timeout: 5000,
    data: {
      ...command,
      expectedPlanVersionId: next.id,
      expectedRevision: 2,
      reason: 'Synthetic reconfirmation',
    },
  });
  expect(again.status()).toBe(200);
  expect(sessionCompletionResultSchema.parse(await again.json()).report).toMatchObject({
    status: 'completed',
    revision: 3,
    planVersionId: next.id,
    schedule: { date: '2026-09-21' },
  });
  expect(sessionCompletionReadSchema.parse(await get(path)).totalHistory).toBe(3);
  expect(activityListSchema.parse(await get('/bff/v1/activities')).total).toBe(actualBefore);
  expect(
    sessionCompletionListSchema.parse(await get('/bff/v1/plans/current/session-completions')).items,
  ).toHaveLength(1);
});
