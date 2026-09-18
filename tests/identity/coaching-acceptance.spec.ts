import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { manualActivityResultSchema } from '../../packages/contracts/src/activity';
import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import { coachingRunV1Schema } from '../../packages/contracts/src/coaching-runs';
import { trainingCandidateBundleV1Schema } from '../../packages/contracts/src/coaching-candidates';
import { dashboardReadModelSchema } from '../../packages/contracts/src/dashboard';
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
  // This is the private OIDC fixture's synthetic account, never an external account.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
});

async function dispatchFixtureWorker(athleteId: string) {
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

// Real local OIDC, BFF, isolated PostgreSQL and browser UI. The worker proposes a fixed
// technical fixture delta; this journey does not establish real model or coaching quality.
test('synthetic actual enters evidence, then an explicitly reviewed fixture diff becomes one new plan version', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { athleteId, headers } = await login(page);
  const get = async (path: string) => {
    const response = await page.request.get(path, { headers });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post(path, {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data,
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const consent = consentSchema.parse(await get('/bff/v1/consents/ai'));
  if (!consent.granted) {
    const granted = await page.request.put('/bff/v1/consents/ai', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { granted: true, expectedRevision: consent.revision },
    });
    expect(granted.status()).toBe(200);
  }

  const initial = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const draft = planDraftSchema.parse({
    title: 'Synthetic actual to approval',
    timezone: 'UTC',
    sessions: [
      {
        id: 'acceptance-session',
        blockId: 'acceptance-block',
        date: '2080-01-02',
        localStartTime: null,
        title: 'Future synthetic run',
        sport: 'running',
        durationSeconds: 1800,
        distanceMeters: 0,
        targetRpe: null,
        purpose: 'Acceptance fixture only',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `acceptance-${level}`,
      parentId: index === 0 ? null : `acceptance-${levels[index - 1]}`,
      level,
      title: `Acceptance ${level}`,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
  });
  const savedResponse = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: initial.head?.id ?? null,
      draft,
    },
  });
  expect(savedResponse.status()).toBe(200);
  const before = planSnapshotSchema.parse(await savedResponse.json());

  const actualDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const actualTitle = `Synthetic acceptance actual ${randomUUID()}`;
  const actual = manualActivityResultSchema.parse(
    await post('/bff/v1/activities', {
      confirmed: true,
      activity: {
        title: actualTitle,
        kind: 'running',
        startedAt: `${actualDate}T08:00:00Z`,
        timezone: 'UTC',
        distanceMeters: 5000,
        durationSeconds: 1800,
        durationKind: 'timer',
      },
      report: { sessionRpe: 4, note: 'Synthetic self-report', planLink: null },
    }),
  );
  await page.goto(`/activities?selected=${actual.activityId}`);
  await expect(page.getByRole('region', { name: '선택한 활동 상세' })).toContainText(actualTitle);
  const today = dashboardReadModelSchema.parse(
    await get(
      `/bff/v1/dashboard?${new URLSearchParams({ anchor: actualDate, window: '3', timezone: 'UTC' })}`,
    ),
  );
  expect(today.days.find(({ date }) => date === actualDate)?.actual.count).toBe(1);
  expect(today.current.actual.sources.manual).toBe(1);
  const { thread } = coachingMessageResultSchema.parse(
    await post('/bff/v1/coaching-threads', {
      planVersionId: before.id,
      title: 'Synthetic evidence acceptance',
      scope: { kind: 'phase', targetId: 'acceptance-phase' },
      message: 'Review the synthetic actual and future training plan.',
    }),
  );
  const nextDate = new Date(`${actualDate}T00:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const snapshot = coreEvidenceSnapshotSchema.parse(
    await post(`/bff/v1/coaching-threads/${thread.id}/evidence-snapshots`, {
      expectedConversationRevision: thread.revision,
      window: {
        from: actualDate,
        toExclusive: nextDate.toISOString().slice(0, 10),
        timezone: 'UTC',
      },
    }),
  );
  assert.equal(snapshot.status, 'available');
  const capturedActual = snapshot.body.activities.find(
    ({ record }) => record.id === actual.activityId,
  );
  expect(capturedActual).toMatchObject({
    localDate: actualDate,
    record: {
      revision: actual.revision,
      source: { kind: 'manual' },
      effective: { title: actualTitle, distanceMeters: 5000, durationSeconds: 1800 },
      userReport: { sessionRpe: 4, source: 'user' },
    },
  });
  expect(snapshot.body.dependencies.activities).toMatchObject({ count: '1', revisionSum: '1' });

  await page.goto(`/coach?thread=${thread.id}&snapshot=${snapshot.id}`);
  const evidence = page.getByRole('region', { name: '선택한 근거' });
  await evidence.getByText('실제 활동 1개').click();
  await expect(
    evidence.getByRole('article', { name: `근거 활동 ${actual.activityId}` }),
  ).toContainText(actualTitle);
  const runPanel = page.getByRole('region', { name: '코칭 실행' });
  const queuedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/bff/v1/coaching-threads/${thread.id}/runs` &&
      response.request().method() === 'POST',
  );
  await runPanel.getByRole('button', { name: '선택한 근거로 실행' }).click();
  const queued = coachingRunV1Schema.parse(await (await queuedResponse).json());
  expect(queued.status.kind).toBe('queued');
  expect(queued.source).toEqual({ kind: 'deterministic_fixture', fixtureId: 'synthetic-v1' });
  expect(planReadSchema.parse(await get('/bff/v1/plans/current')).head?.id).toBe(before.id);

  await dispatchFixtureWorker(athleteId);
  await runPanel.getByRole('button', { name: '상태 새로고침' }).click();
  await expect(runPanel.getByText('분석 자료가 저장되었습니다.', { exact: false })).toBeVisible();
  const candidateResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/bff/v1/coaching-runs/${queued.id}/candidates` &&
      response.request().method() === 'POST',
  );
  await runPanel.getByRole('button', { name: '테스트용 fixture 후보 검증' }).click();
  const candidate = trainingCandidateBundleV1Schema.parse(await (await candidateResponse).json());
  expect(candidate.candidate.before.id).toBe(before.id);
  expect(candidate.candidate.proposed.sessions[0]?.durationSeconds).toBe(2100);
  expect(planReadSchema.parse(await get('/bff/v1/plans/current')).head?.id).toBe(before.id);

  await runPanel.getByRole('link', { name: /후보 제안 검토/ }).click();
  const review = page.getByRole('region', { name: '제안 검토' });
  const changes = review.getByRole('region', { name: '변경 항목 비교' });
  await expect(changes.getByRole('row', { name: /세션 acceptance-session/ })).toContainText(
    '1800초',
  );
  await expect(changes.getByRole('row', { name: /세션 acceptance-session/ })).toContainText(
    '2100초',
  );
  await expect(review.getByRole('region', { name: '변경 전후 일정' })).toBeVisible();
  await expect(review.getByRole('region', { name: '예상 영향' })).toBeVisible();
  await expect(review.getByRole('region', { name: '후보 검증 결과' })).toContainText('미확인 0건');
  const approve = review.getByRole('button', { name: '확인하고 계획에 적용' });
  await expect(approve).toBeDisabled();
  await review
    .getByRole('checkbox', {
      name: '원안과 제안, 검증 결과를 확인했고 이 후보를 계획에 적용합니다.',
    })
    .check();
  await approve.click();
  await expect(
    review.getByText(`계획 버전 ${before.version + 1} 적용을 서버에서 확인했습니다.`),
  ).toBeVisible();
  const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
  expect(current.head?.version).toBe(before.version + 1);
  expect(current.head?.id).not.toBe(before.id);
  expect(current.head?.draft.sessions[0]?.durationSeconds).toBe(2100);
  expect(current.history.filter(({ id }) => id === current.head?.id)).toHaveLength(1);
});
