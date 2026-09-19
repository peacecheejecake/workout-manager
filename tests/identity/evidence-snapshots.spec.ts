import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { manualActivityResultSchema } from '../../packages/contracts/src/activity';
import { checkInCommandResultSchema } from '../../packages/contracts/src/check-ins';
import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import {
  coreEvidenceSnapshotSchema,
  coreEvidenceSnapshotListSchema,
} from '../../packages/contracts/src/evidence-snapshots';
import { accountExportSchema } from '../../packages/contracts/src/operations';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { consentSchema } from '../../apps/api/src/ports';

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
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session')).status()).toBe(401);
});
const window = { from: '2024-03-10', toExclusive: '2024-03-11', timezone: 'America/New_York' };
async function setup(page: Page) {
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const post = (path: string, data: unknown, key = randomUUID()) =>
    page.request.post(path, { headers: { ...headers, 'idempotency-key': key }, data });
  const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const draft = planDraftSchema.parse({
    title: 'Synthetic captured plan',
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
  const savedResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { source: 'manual', confirmed: true, expectedVersionId: current.head?.id ?? null, draft },
  });
  expect(savedResponse.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await savedResponse.json());
  const threadResponse = await post('/bff/v1/coaching-threads', {
    planVersionId: saved.id,
    title: 'Synthetic evidence conversation',
    scope: { kind: 'phase', targetId: 'phase' },
    message: 'Synthetic initial message',
  });
  expect(threadResponse.status()).toBe(200);
  const { thread } = coachingMessageResultSchema.parse(await threadResponse.json());
  const collection = `/bff/v1/coaching-threads/${thread.id}/evidence-snapshots`;
  const command = { expectedConversationRevision: thread.revision, window };
  const capture = async (key = randomUUID(), revision = thread.revision) => {
    const response = await post(
      collection,
      { ...command, expectedConversationRevision: revision },
      key,
    );
    expect(response.status()).toBe(200);
    return coreEvidenceSnapshotSchema.parse(await response.json());
  };
  const read = async (id: string) =>
    coreEvidenceSnapshotSchema.parse(await get(`/bff/v1/evidence-snapshots/${id}`));
  const exported = async () => {
    const response = await page.request.post('/bff/v1/operations/export', { headers });
    expect(response.status()).toBe(200);
    const artifact = accountExportSchema.parse(await response.json());
    assert.equal(artifact.schemaVersion, 12);
    if (artifact.schemaVersion !== 12) throw new Error('Expected snapshot export v12');
    return artifact;
  };
  return { headers, get, post, saved, thread, collection, command, capture, read, exported };
}

// Actual local OIDC, same-origin BFF and private PostgreSQL; capture never invokes a model or applies a plan.
test('captures immutable core evidence with local dates, tenant isolation and deletion-safe replay/export', async ({
  page,
  browser,
}) => {
  const f = await setup(page);
  const activityResponse = await f.post('/bff/v1/activities', {
    confirmed: true,
    activity: {
      title: 'Synthetic zero distance',
      kind: 'running',
      startedAt: '2024-03-11T03:30:00Z',
      timezone: 'Asia/Seoul',
      distanceMeters: 0,
      durationSeconds: null,
      durationKind: 'unknown',
    },
    report: { sessionRpe: 0, note: 'Synthetic activity evidence', planLink: null },
  });
  expect(activityResponse.status()).toBe(200);
  const activity = manualActivityResultSchema.parse(await activityResponse.json());
  const checkInResponse = await f.post('/bff/v1/check-ins', {
    values: {
      observedAt: '2024-03-11T03:30:00Z',
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: 'Synthetic check-in evidence',
    },
  });
  expect(checkInResponse.status()).toBe(200);
  const checkIn = checkInCommandResultSchema.parse(await checkInResponse.json());
  const key = randomUUID();
  const snapshot = await f.capture(key);
  assert.equal(snapshot.status, 'available');
  if (snapshot.status !== 'available') throw new Error('Expected available evidence');
  expect(snapshot.body.plan).toEqual(f.saved);
  expect(snapshot.body.thread).toEqual(f.thread);
  expect(snapshot.body.messages.map((message) => message.content)).toEqual([
    'Synthetic initial message',
  ]);
  expect(snapshot.body.activities).toHaveLength(1);
  expect(snapshot.body.activities[0]).toMatchObject({
    localDate: '2024-03-10',
    record: {
      id: activity.activityId,
      effective: { distanceMeters: 0, durationSeconds: null, durationKind: 'unknown' },
      userReport: { sessionRpe: 0 },
    },
  });
  expect(snapshot.body.checkIns).toHaveLength(1);
  expect(snapshot.body.checkIns[0]).toMatchObject({
    localDate: '2024-03-10',
    record: { id: checkIn.id, localDate: '2024-03-11', values: { fatigue: 0, discomfort: null } },
  });
  expect(snapshot.body.dependencies.activities).toEqual({ count: '1', revisionSum: '1' });
  expect(snapshot.body.dependencies.checkIns).toEqual({ kind: 'exists', revision: 1 });
  expect(snapshot.body.dependencies.sessionCompletions).toEqual({ kind: 'absent' });
  expect(snapshot.body.sessionCompletions).toEqual([]);
  expect(await f.capture(key)).toEqual(snapshot);
  expect(await f.read(snapshot.id)).toEqual(snapshot);
  const history = coreEvidenceSnapshotListSchema.parse(
    await f.get(`${f.collection}?limit=1&offset=0`),
  );
  expect(history).toEqual({
    items: [
      {
        id: snapshot.id,
        threadId: f.thread.id,
        status: 'available',
        createdAt: snapshot.createdAt,
      },
    ],
    total: 1,
  });
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const other = await otherContext.newPage();
    const otherHeaders = await login(other, 'Bob');
    expect(
      (
        await other.request.get(`/bff/v1/evidence-snapshots/${snapshot.id}`, {
          headers: otherHeaders,
        })
      ).status(),
    ).toBe(404);
    expect((await other.request.get(f.collection, { headers: otherHeaders })).status()).toBe(404);
    expect(
      (
        await other.request.post(f.collection, {
          headers: { ...otherHeaders, 'idempotency-key': randomUUID() },
          data: f.command,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
  const newerResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: f.saved.id,
      draft: { ...f.saved.draft, title: 'Synthetic newer plan head' },
    },
  });
  expect(newerResponse.status()).toBe(200);
  const newer = planSnapshotSchema.parse(await newerResponse.json());
  const appended = await f.post(`/bff/v1/coaching-threads/${f.thread.id}/messages`, {
    expectedRevision: 1,
    message: 'Synthetic subsequent message',
  });
  expect(appended.status()).toBe(200);
  expect(await f.read(snapshot.id)).toEqual(snapshot);
  expect(await f.capture(key)).toEqual(snapshot);
  const stale = await f.post(f.collection, f.command);
  expect(stale.status()).toBe(409);
  const beforeDeletion = await f.exported();
  expect(beforeDeletion.data.evidenceSnapshots).toHaveLength(1);
  expect(beforeDeletion.data.evidenceSnapshots[0]).toMatchObject({
    id: snapshot.id,
    body: snapshot.body,
    purged_reason: null,
  });
  const removed = await page.request.delete(`/bff/v1/activities/${activity.activityId}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: { expectedRevision: activity.revision },
  });
  expect(removed.status()).toBe(204);
  const purged = {
    id: snapshot.id,
    threadId: f.thread.id,
    createdAt: snapshot.createdAt,
    status: 'purged',
    reason: 'source_deleted',
  };
  expect(await f.read(snapshot.id)).toEqual(purged);
  expect(await f.capture(key)).toEqual(purged);
  expect(coreEvidenceSnapshotListSchema.parse(await f.get(f.collection)).items).toEqual([purged]);
  const afterDeletion = await f.exported();
  expect(afterDeletion.data.evidenceSnapshots).toEqual([
    expect.objectContaining({ id: snapshot.id, body: null, purged_reason: 'source_deleted' }),
  ]);
  expect(JSON.stringify(afterDeletion.data.evidenceSnapshots)).not.toContain(
    'Synthetic activity evidence',
  );
  const secondKey = randomUUID();
  const second = await f.capture(secondKey, 2);
  assert.equal(second.status, 'available');
  if (second.status !== 'available') throw new Error('Expected fresh evidence');
  expect(second.body.activities).toEqual([]);
  expect(second.body.checkIns).toHaveLength(1);
  expect(second.body.plan.id).toBe(f.saved.id);
  expect(second.body.dependencies.trainingPlan).toEqual({ kind: 'exists', versionId: newer.id });
  expect(second.body.messages).toHaveLength(2);
  const removeCheckIn = await page.request.delete(`/bff/v1/check-ins/${checkIn.id}`, {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: { expectedRevision: checkIn.revision },
  });
  expect(removeCheckIn.status()).toBe(200);
  expect(await f.read(second.id)).toMatchObject({ status: 'purged', reason: 'source_deleted' });
  expect(await f.capture(secondKey, 2)).toEqual(await f.read(second.id));
  expect((await f.exported()).data.evidenceSnapshots.every((row) => row['body'] === null)).toBe(
    true,
  );
  expect(planReadSchema.parse(await f.get('/bff/v1/plans/current')).head).toEqual(newer);
});

test('withdrawal purges existing evidence and a later consent grant never resurrects its receipt', async ({
  page,
}) => {
  const f = await setup(page);
  const key = randomUUID();
  const snapshot = await f.capture(key);
  expect(snapshot.status).toBe('available');
  const consent = consentSchema.parse(await f.get('/bff/v1/consents/ai'));
  const withdrawn = await page.request.put('/bff/v1/consents/ai', {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: { granted: false, expectedRevision: consent.revision },
  });
  expect(withdrawn.status()).toBe(200);
  const next = consentSchema.parse(await withdrawn.json());
  const purged = {
    id: snapshot.id,
    threadId: f.thread.id,
    createdAt: snapshot.createdAt,
    status: 'purged',
    reason: 'consent_withdrawn',
  };
  expect(await f.read(snapshot.id)).toEqual(purged);
  expect(await f.capture(key)).toEqual(purged);
  const granted = await page.request.put('/bff/v1/consents/ai', {
    headers: { ...f.headers, 'idempotency-key': randomUUID() },
    data: { granted: true, expectedRevision: next.revision },
  });
  expect(granted.status()).toBe(200);
  expect(await f.read(snapshot.id)).toEqual(purged);
  expect(await f.capture(key)).toEqual(purged);
  expect((await f.exported()).data.evidenceSnapshots).toEqual([
    expect.objectContaining({ id: snapshot.id, body: null, purged_reason: 'consent_withdrawn' }),
  ]);
  expect(planReadSchema.parse(await f.get('/bff/v1/plans/current')).head).toEqual(f.saved);
});
