import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import {
  coachingFixtureCandidateContentV1Schema,
  coachingRunOutputV1Schema,
  coachingRunV1Schema,
} from '../../packages/contracts/src/coaching-runs';
import {
  trainingCandidateBundleV1Schema,
  trainingCandidateStatusV1Schema,
} from '../../packages/contracts/src/coaching-candidates';
import { coreEvidenceSnapshotSchema } from '../../packages/contracts/src/evidence-snapshots';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { consentSchema } from '../../apps/api/src/ports';
import { coachingWorkerContextPath } from '../../scripts/fixtures/coaching-worker-context';

const execFileAsync = promisify(execFile);
type Headers = {
  origin: string;
  'x-workout-session-id': string;
  'x-csrf-token': string;
};
const cleanupHeaders = new WeakMap<Page, Headers>();

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
      'athleteId' in session &&
      typeof session.athleteId === 'string' &&
      'sessionId' in session &&
      typeof session.sessionId === 'string' &&
      'csrfToken' in session &&
      typeof session.csrfToken === 'string',
  );
  const headers: Headers = {
    origin: new URL(page.url()).origin,
    'x-workout-session-id': session.sessionId,
    'x-csrf-token': session.csrfToken,
  };
  cleanupHeaders.set(page, headers);
  return { athleteId: session.athleteId, headers };
}

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
});

async function createQueuedRun(page: Page) {
  const { athleteId, headers } = await login(page, 'Alice');
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const post = (path: string, data: unknown, key = randomUUID()) =>
    page.request.post(path, { headers: { ...headers, 'idempotency-key': key }, data });
  const consent = consentSchema.parse(await get('/bff/v1/consents/ai'));
  if (!consent.granted) {
    const granted = await page.request.put('/bff/v1/consents/ai', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { granted: true, expectedRevision: consent.revision },
    });
    expect(granted.status()).toBe(200);
  }
  const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const draft = planDraftSchema.parse({
    title: 'Synthetic coaching run plan',
    timezone: 'UTC',
    sessions: [
      {
        id: 'synthetic-session',
        blockId: 'block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Synthetic run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: 'Fixture validation only',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
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
  const plan = planSnapshotSchema.parse(await savedResponse.json());
  const threadResponse = await post('/bff/v1/coaching-threads', {
    planVersionId: plan.id,
    title: 'Synthetic run consultation',
    scope: { kind: 'phase', targetId: 'phase' },
    message: 'Review my synthetic training schedule.',
  });
  expect(threadResponse.status()).toBe(200);
  const { thread } = coachingMessageResultSchema.parse(await threadResponse.json());
  const captureResponse = await post(`/bff/v1/coaching-threads/${thread.id}/evidence-snapshots`, {
    expectedConversationRevision: thread.revision,
    window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
  });
  expect(captureResponse.status()).toBe(200);
  const snapshot = coreEvidenceSnapshotSchema.parse(await captureResponse.json());
  expect(snapshot.status).toBe('available');
  const path = `/bff/v1/coaching-threads/${thread.id}/runs`;
  const command = {
    schemaVersion: 1,
    evidenceSnapshotId: snapshot.id,
    expectedConversationRevision: thread.revision,
  };
  const key = randomUUID();
  const queuedResponse = await post(path, command, key);
  expect(queuedResponse.status()).toBe(200);
  const run = coachingRunV1Schema.parse(await queuedResponse.json());
  expect(run.status).toEqual({ kind: 'queued' });
  expect(run.source).toEqual({ kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' });
  return { athleteId, headers, post, path, command, key, run, plan };
}

async function dispatchOne(athleteId: string) {
  const context: unknown = JSON.parse(await readFile(coachingWorkerContextPath, 'utf8'));
  assert.ok(
    typeof context === 'object' &&
      context !== null &&
      'databaseUrl' in context &&
      typeof context.databaseUrl === 'string' &&
      'workerDatabaseUrl' in context &&
      typeof context.workerDatabaseUrl === 'string',
  );
  await execFileAsync(
    'pnpm',
    ['--filter', '@workout/worker', 'coaching:fixture', '--athlete-id', athleteId],
    {
      cwd: process.cwd(),
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        COACHING_FIXTURE_ENABLED: 'true',
        COACHING_FIXTURE_ID: 'synthetic-v1',
        DATABASE_URL: context.databaseUrl,
        COACHING_WORKER_DATABASE_URL: context.workerDatabaseUrl,
      },
    },
  );
}

test('runs synthetic analysis through OIDC, API, tenant worker and PostgreSQL without approval', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const fixture = await createQueuedRun(page);
  const detail = `/bff/v1/coaching-runs/${fixture.run.id}`;
  expect((await page.request.get(`${detail}/output`, { headers: fixture.headers })).status()).toBe(
    404,
  );
  await dispatchOne(fixture.athleteId);
  const read = await page.request.get(detail, { headers: fixture.headers });
  expect(read.status()).toBe(200);
  const updated = coachingRunV1Schema.parse(await read.json());
  expect(updated.status.kind).toBe('analysis_ready');
  const outputResponse = await page.request.get(`${detail}/output`, { headers: fixture.headers });
  expect(outputResponse.status()).toBe(200);
  const output = coachingRunOutputV1Schema.parse(await outputResponse.json());
  expect(output).toMatchObject({
    runId: fixture.run.id,
    trust: 'untrusted_fixture',
    validation: 'unvalidated',
  });
  const content = coachingFixtureCandidateContentV1Schema.parse(output.content);
  expect(content).toMatchObject({
    intent: {
      kind: 'set_session_duration_seconds',
      sessionId: 'synthetic-session',
      durationSeconds: 2100,
    },
  });
  const replay = await fixture.post(fixture.path, fixture.command, fixture.key);
  expect(replay.status()).toBe(200);
  expect(coachingRunV1Schema.parse(await replay.json())).toEqual(updated);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await otherContext.newPage();
    const other = await login(otherPage, 'Bob');
    expect((await otherPage.request.get(detail, { headers: other.headers })).status()).toBe(404);
    expect(
      (await otherPage.request.get(`${detail}/output`, { headers: other.headers })).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
  const consent = consentSchema.parse(
    await (await page.request.get('/bff/v1/consents/ai', { headers: fixture.headers })).json(),
  );
  const withdrawn = await page.request.put('/bff/v1/consents/ai', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: { granted: false, expectedRevision: consent.revision },
  });
  expect(withdrawn.status()).toBe(200);
  expect((await page.request.get(`${detail}/output`, { headers: fixture.headers })).status()).toBe(
    404,
  );
});

test('seals a server-validated fixture candidate without accepting a client plan or changing the plan head', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const fixture = await createQueuedRun(page);
  const collection = `/bff/v1/coaching-runs/${fixture.run.id}/candidates`;
  const key = randomUUID();
  expect(
    (
      await page.request.post(collection, {
        headers: { ...fixture.headers, 'idempotency-key': key },
      })
    ).status(),
  ).toBe(409);
  await dispatchOne(fixture.athleteId);
  expect(
    (
      await page.request.post(collection, {
        headers: { ...fixture.headers, 'idempotency-key': key },
        data: { proposed: { title: 'Client supplied plan' } },
      })
    ).status(),
  ).toBe(400);
  const response = await page.request.post(collection, {
    headers: { ...fixture.headers, 'idempotency-key': key },
  });
  expect(response.status()).toBe(200);
  const bundle = trainingCandidateBundleV1Schema.parse(await response.json());
  expect(bundle.candidate).toMatchObject({
    runId: fixture.run.id,
    digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    before: { id: fixture.plan.id },
  });
  expect(bundle.candidate.proposed.sessions[0]?.durationSeconds).toBe(2100);
  expect(bundle.candidate.diff.sessionChanges).toEqual([
    expect.objectContaining({ id: 'synthetic-session', kind: 'modified' }),
  ]);
  const replay = await page.request.post(collection, {
    headers: { ...fixture.headers, 'idempotency-key': key },
  });
  expect(trainingCandidateBundleV1Schema.parse(await replay.json())).toEqual(bundle);
  const listing = await page.request.get(collection, { headers: fixture.headers });
  const listed: unknown = await listing.json();
  assert.ok(Array.isArray(listed));
  expect(listed.map((item: unknown) => trainingCandidateBundleV1Schema.parse(item))).toEqual([
    bundle,
  ]);
  const detail = `/bff/v1/coaching-candidates/${bundle.candidate.id}`;
  const read = await page.request.get(detail, { headers: fixture.headers });
  expect(trainingCandidateBundleV1Schema.parse(await read.json())).toEqual(bundle);
  const planResponse = await page.request.get('/bff/v1/plans/current', {
    headers: fixture.headers,
  });
  expect(planReadSchema.parse(await planResponse.json()).head?.id).toBe(fixture.plan.id);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await otherContext.newPage();
    const other = await login(otherPage, 'Bob');
    expect((await otherPage.request.get(detail, { headers: other.headers })).status()).toBe(404);
    expect(
      (
        await otherPage.request.post(collection, {
          headers: { ...other.headers, 'idempotency-key': randomUUID() },
        })
      ).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
  const consent = consentSchema.parse(
    await (await page.request.get('/bff/v1/consents/ai', { headers: fixture.headers })).json(),
  );
  const withdrawn = await page.request.put('/bff/v1/consents/ai', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: { granted: false, expectedRevision: consent.revision },
  });
  expect(withdrawn.status()).toBe(200);
  expect((await page.request.get(detail, { headers: fixture.headers })).status()).toBe(404);
  await expect(
    (await page.request.get(collection, { headers: fixture.headers })).json(),
  ).resolves.toEqual([]);
});

test('revalidates a selected change as a new candidate and shows stale or withdrawn status without a body', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const fixture = await createQueuedRun(page);
  await dispatchOne(fixture.athleteId);
  const collection = `/bff/v1/coaching-runs/${fixture.run.id}/candidates`;
  const originalResponse = await page.request.post(collection, {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
  });
  expect(originalResponse.status()).toBe(200);
  const original = trainingCandidateBundleV1Schema.parse(await originalResponse.json());
  const partialPath = `/bff/v1/coaching-candidates/${original.candidate.id}/partials`;
  const selection = {
    schemaVersion: 1,
    sessionIds: ['synthetic-session'],
    periodIds: [],
    includeTitle: false,
  };
  const key = randomUUID();
  const partialResponse = await page.request.post(partialPath, {
    headers: { ...fixture.headers, 'idempotency-key': key },
    data: selection,
  });
  expect(partialResponse.status()).toBe(200);
  const partial = trainingCandidateBundleV1Schema.parse(await partialResponse.json());
  expect(partial.candidate.id).not.toBe(original.candidate.id);
  expect(partial.candidate.parentCandidateId).toBe(original.candidate.id);
  expect(partial.candidate.digest).not.toBe(original.candidate.digest);
  expect(partial.proposal.id).not.toBe(original.proposal.id);
  expect(partial.decision.id).toBe(original.decision.id);
  expect(partial.candidate.proposed.sessions[0]?.durationSeconds).toBe(2100);
  const replay = await page.request.post(partialPath, {
    headers: { ...fixture.headers, 'idempotency-key': key },
    data: selection,
  });
  expect(trainingCandidateBundleV1Schema.parse(await replay.json())).toEqual(partial);
  const invalid = await page.request.post(partialPath, {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: { ...selection, sessionIds: ['not-a-changed-session'] },
  });
  expect(invalid.status()).toBe(422);
  const listed: unknown = await (
    await page.request.get(collection, { headers: fixture.headers })
  ).json();
  assert.ok(Array.isArray(listed));
  expect(
    listed.map((item: unknown) => trainingCandidateBundleV1Schema.parse(item).candidate.id),
  ).toEqual([original.candidate.id, partial.candidate.id]);
  const statusPath = `/bff/v1/coaching-candidates/${partial.candidate.id}/status`;
  const currentStatus = trainingCandidateStatusV1Schema.parse(
    await (await page.request.get(statusPath, { headers: fixture.headers })).json(),
  );
  expect(currentStatus.kind).toBe('current');
  expect(Object.keys(currentStatus).sort()).toEqual(['candidateId', 'kind', 'schemaVersion']);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await otherContext.newPage();
    const other = await login(otherPage, 'Bob');
    expect((await otherPage.request.get(statusPath, { headers: other.headers })).status()).toBe(
      404,
    );
    expect(
      (
        await otherPage.request.post(partialPath, {
          headers: { ...other.headers, 'idempotency-key': randomUUID() },
          data: selection,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
  const stillCurrent = planReadSchema.parse(
    await (await page.request.get('/bff/v1/plans/current', { headers: fixture.headers })).json(),
  );
  expect(stillCurrent.head?.id).toBe(fixture.plan.id);
  const changedPlan = await page.request.put('/bff/v1/plans/current', {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: fixture.plan.id,
      draft: { ...fixture.plan.draft, title: 'New current synthetic plan' },
    },
  });
  expect(changedPlan.status()).toBe(200);
  const staleStatus = trainingCandidateStatusV1Schema.parse(
    await (await page.request.get(statusPath, { headers: fixture.headers })).json(),
  );
  expect(staleStatus).toEqual({
    schemaVersion: 1,
    candidateId: partial.candidate.id,
    kind: 'stale',
  });
  expect(
    (
      await page.request.get(`/bff/v1/coaching-candidates/${partial.candidate.id}`, {
        headers: fixture.headers,
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.request.post(partialPath, {
        headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
        data: selection,
      })
    ).status(),
  ).toBe(409);
  const consent = consentSchema.parse(
    await (await page.request.get('/bff/v1/consents/ai', { headers: fixture.headers })).json(),
  );
  expect(
    (
      await page.request.put('/bff/v1/consents/ai', {
        headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
        data: { granted: false, expectedRevision: consent.revision },
      })
    ).status(),
  ).toBe(200);
  expect(
    trainingCandidateStatusV1Schema.parse(
      await (await page.request.get(statusPath, { headers: fixture.headers })).json(),
    ).kind,
  ).toBe('withdrawn');
});

test('applies a candidate only after explicit confirmation and returns one new plan version', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  const fixture = await createQueuedRun(page);
  await dispatchOne(fixture.athleteId);
  const created = await page.request.post(`/bff/v1/coaching-runs/${fixture.run.id}/candidates`, {
    headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
  });
  expect(created.status()).toBe(200);
  const bundle = trainingCandidateBundleV1Schema.parse(await created.json());
  const approvalPath = `/bff/v1/coaching-candidates/${bundle.candidate.id}/approve`;
  const approval = {
    schemaVersion: 1,
    expectedDigest: bundle.candidate.digest,
    confirmed: true,
  };
  const headers = { ...fixture.headers, 'idempotency-key': randomUUID() };
  expect(
    (
      await page.request.post(approvalPath, {
        headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
        data: { ...approval, confirmed: false },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.post(approvalPath, {
        headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
        data: { ...approval, expectedDigest: '0'.repeat(64) },
      })
    ).status(),
  ).toBe(409);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const otherPage = await otherContext.newPage();
    const other = await login(otherPage, 'Bob');
    expect(
      (
        await otherPage.request.post(approvalPath, {
          headers: { ...other.headers, 'idempotency-key': randomUUID() },
          data: approval,
        })
      ).status(),
    ).toBe(404);
  } finally {
    await otherContext.close();
  }
  const before = planReadSchema.parse(
    await (await page.request.get('/bff/v1/plans/current', { headers: fixture.headers })).json(),
  );
  expect(before.head?.id).toBe(fixture.plan.id);
  const approvedResponse = await page.request.post(approvalPath, { headers, data: approval });
  expect(approvedResponse.status()).toBe(200);
  const approved = planSnapshotSchema.parse(await approvedResponse.json());
  expect(approved.id).not.toBe(fixture.plan.id);
  expect(approved.version).toBe(fixture.plan.version + 1);
  expect(approved.draft.sessions[0]?.durationSeconds).toBe(2100);
  const replay = await page.request.post(approvalPath, { headers, data: approval });
  expect(replay.status()).toBe(200);
  expect(planSnapshotSchema.parse(await replay.json())).toEqual(approved);
  expect(
    (
      await page.request.post(approvalPath, {
        headers: { ...fixture.headers, 'idempotency-key': randomUUID() },
        data: approval,
      })
    ).status(),
  ).toBe(409);
  const after = planReadSchema.parse(
    await (await page.request.get('/bff/v1/plans/current', { headers: fixture.headers })).json(),
  );
  expect(after.head).toEqual(approved);
  expect(after.history.filter((item) => item.id === approved.id)).toHaveLength(1);
  expect(
    trainingCandidateStatusV1Schema.parse(
      await (
        await page.request.get(`/bff/v1/coaching-candidates/${bundle.candidate.id}/status`, {
          headers: fixture.headers,
        })
      ).json(),
    ).kind,
  ).toBe('stale');
});

test('reviews a fixture run and approves a selected change through the product UI', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const fixture = await createQueuedRun(page);
  await dispatchOne(fixture.athleteId);

  await page.goto(
    `/coach?thread=${fixture.run.threadId}&snapshot=${fixture.run.evidenceSnapshotId}`,
  );
  const runPanel = page.getByRole('region', { name: '코칭 실행' });
  await expect(runPanel.getByText('분석 자료가 저장되었습니다.', { exact: false })).toBeVisible();
  await runPanel.getByRole('button', { name: '테스트용 fixture 후보 검증' }).click();
  await runPanel.getByRole('link', { name: /후보 제안 검토/ }).click();

  const review = page.getByRole('region', { name: '제안 검토' });
  await expect(review.getByRole('region', { name: '변경 전후 일정' })).toBeVisible();
  await expect(review.getByRole('region', { name: '예상 영향' })).toBeVisible();
  await expect(review.getByRole('region', { name: '후보 검증 결과' })).toBeVisible();
  await expect(review.getByRole('button', { name: '확인하고 계획에 적용' })).toBeDisabled();
  for (const width of [768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    ).toBe(false);
  }
  expect(
    planReadSchema.parse(
      await (await page.request.get('/bff/v1/plans/current', { headers: fixture.headers })).json(),
    ).head?.id,
  ).toBe(fixture.plan.id);

  await review.getByRole('checkbox', { name: /세션 synthetic-session/ }).check();
  await review.getByRole('button', { name: '선택한 변경으로 새 후보 만들기' }).click();
  await review.getByRole('link', { name: '새로 검증한 후보 검토' }).click();
  await expect(review.getByRole('link', { name: '부모 후보 검토' })).toBeVisible();
  const childPath = new URL(page.url()).pathname;
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`http://127.0.0.1:4200${childPath}`);
  await expect(review.getByRole('region', { name: '변경 전후 일정' })).toBeVisible();
  await expect(review.getByRole('region', { name: '후보 검증 결과' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
  const approvalConfirmation = review.getByRole('checkbox', {
    name: '원안과 제안, 검증 결과를 확인했고 이 후보를 계획에 적용합니다.',
  });
  await approvalConfirmation.focus();
  await page.keyboard.press('Space');
  await expect(approvalConfirmation).toBeChecked();
  await review.getByRole('button', { name: '확인하고 계획에 적용' }).click();
  await expect(
    review.getByText(`계획 버전 ${fixture.plan.version + 1} 적용을 서버에서 확인했습니다.`),
  ).toBeVisible();
  const head = planReadSchema.parse(
    await (await page.request.get('/bff/v1/plans/current', { headers: fixture.headers })).json(),
  ).head;
  expect(head?.version).toBe(fixture.plan.version + 1);
  expect(head?.draft.sessions[0]?.durationSeconds).toBe(2100);
  await review.getByRole('link', { name: '저장된 계획 보기' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4200/planner');
  await expect(page.getByRole('region', { name: '훈련 계획' })).toContainText(
    `현재 버전: ${fixture.plan.version + 1} · Synthetic coaching run plan`,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(
    false,
  );
});

test('keeps a user-cancelled queued attempt cancelled when the worker later sees its event', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = await createQueuedRun(page);
  const detail = `/bff/v1/coaching-runs/${fixture.run.id}`;
  const cancelled = await page.request.post(`${detail}/cancel`, { headers: fixture.headers });
  expect(cancelled.status()).toBe(200);
  expect(coachingRunV1Schema.parse(await cancelled.json()).status).toEqual({
    kind: 'cancelled',
    reason: 'user_requested',
  });
  await dispatchOne(fixture.athleteId);
  const read = await page.request.get(detail, { headers: fixture.headers });
  expect(coachingRunV1Schema.parse(await read.json()).status).toEqual({
    kind: 'cancelled',
    reason: 'user_requested',
  });
  expect((await page.request.get(`${detail}/output`, { headers: fixture.headers })).status()).toBe(
    404,
  );
});
