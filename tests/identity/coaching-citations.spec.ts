import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { coachingMessageResultSchema } from '../../packages/contracts/src/coaching-threads';
import { coachingRunV1Schema } from '../../packages/contracts/src/coaching-runs';
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

const RESOURCE_TEXT = '회복 주간에는 강도를 낮춘다.\n\nRecovery week reduces training intensity.';

// Real local OIDC, BFF, isolated PostgreSQL, the tenant worker and the browser UI.
// The worker only produces a deterministic fixture citation; this journey does not
// establish model quality or the physiological validity of the cited content.
test('cites a reviewed resource in the browser and blocks the citation once the resource is deleted', async ({
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

  // An explicitly reviewed, explicitly coach-enabled resource: the only kind
  // retrieval may read.
  const created: unknown = await post('/bff/v1/resources', {
    sourceKind: 'text',
    title: '회복 주간 지침',
    category: 'guide',
    metadata: {},
    tags: [],
    favorite: false,
    text: RESOURCE_TEXT,
  });
  assert.ok(
    typeof created === 'object' &&
      created !== null &&
      'resource' in created &&
      typeof created.resource === 'object' &&
      created.resource !== null &&
      'id' in created.resource &&
      typeof created.resource.id === 'string' &&
      'accessRevision' in created.resource &&
      typeof created.resource.accessRevision === 'number' &&
      'version' in created &&
      typeof created.version === 'object' &&
      created.version !== null &&
      'id' in created.version &&
      typeof created.version.id === 'string',
  );
  const resourceId = created.resource.id;
  const versionId = created.version.id;
  const reviewed: unknown = await post(`/bff/v1/resources/${resourceId}/reviewed`, {
    reviewed: true,
    expectedAccessRevision: created.resource.accessRevision,
    expectedCurrentVersionId: versionId,
  });
  assert.ok(
    typeof reviewed === 'object' &&
      reviewed !== null &&
      'accessRevision' in reviewed &&
      typeof reviewed.accessRevision === 'number',
  );
  const enabled: unknown = await post(`/bff/v1/resources/${resourceId}/coach-use`, {
    includeForCoach: true,
    expectedAccessRevision: reviewed.accessRevision,
    expectedCurrentVersionId: versionId,
  });
  assert.ok(
    typeof enabled === 'object' &&
      enabled !== null &&
      'accessRevision' in enabled &&
      typeof enabled.accessRevision === 'number' &&
      'coachUseAuthorized' in enabled &&
      enabled.coachUseAuthorized === true,
  );

  const current = planReadSchema.parse(await get('/bff/v1/plans/current'));
  const draft = planDraftSchema.parse({
    title: 'Synthetic citation plan',
    timezone: 'UTC',
    sessions: [
      {
        id: 'citation-session',
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
    data: {
      source: 'manual',
      confirmed: true,
      expectedVersionId: current.head?.id ?? null,
      draft,
    },
  });
  expect(savedResponse.status()).toBe(200);
  const plan = planSnapshotSchema.parse(await savedResponse.json());
  const { thread } = coachingMessageResultSchema.parse(
    await post('/bff/v1/coaching-threads', {
      planVersionId: plan.id,
      title: '회복 주간 상담',
      scope: { kind: 'phase', targetId: 'phase' },
      message: '회복 주간 운영 방법을 검토해 주세요.',
    }),
  );
  const snapshot = coreEvidenceSnapshotSchema.parse(
    await post(`/bff/v1/coaching-threads/${thread.id}/evidence-snapshots`, {
      expectedConversationRevision: thread.revision,
      window: { from: '2080-01-01', toExclusive: '2080-01-08', timezone: 'UTC' },
    }),
  );
  assert.equal(snapshot.status, 'available');

  await page.goto(`/coach?thread=${thread.id}&snapshot=${snapshot.id}`);
  const runPanel = page.getByRole('region', { name: '코칭 실행' });
  await runPanel.getByLabel('검토 자료 검색어(선택)').fill('회복');
  const queuedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/bff/v1/coaching-threads/${thread.id}/runs` &&
      response.request().method() === 'POST',
  );
  await runPanel.getByRole('button', { name: '선택한 근거로 실행' }).click();
  const queued = coachingRunV1Schema.parse(await (await queuedResponse).json());
  expect(queued.status.kind).toBe('queued');

  const citations = runPanel.getByRole('region', { name: '검토 자료 인용' });
  await expect(citations.getByText(/검색어 “회복”/)).toBeVisible();
  await expect(citations.getByText(/고정한 자료 1건/)).toBeVisible();

  await dispatchFixtureWorker(athleteId);
  await runPanel.getByRole('button', { name: '상태 새로고침' }).click();
  await expect(runPanel.getByText('분석 자료가 저장되었습니다.', { exact: false })).toBeVisible();
  await citations.getByRole('button', { name: '인용 다시 확인' }).click();
  await expect(citations.getByText('회복 주간 지침', { exact: false })).toBeVisible();
  await expect(citations.getByText('회복 주간에는', { exact: false })).toBeVisible();
  await expect(citations.getByText(/자료 버전 /)).toBeVisible();

  // Narrow viewport: the citation quote must reflow rather than scroll the page.
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(citations.getByText('회복 주간에는', { exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Deleting the resource blocks the stored citation on the next read, before
  // any asynchronous purge has run.
  const deleted = await page.request.delete(`/bff/v1/resources/${resourceId}`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: {
      expectedAccessRevision: enabled.accessRevision,
      expectedCurrentVersionId: versionId,
    },
  });
  expect(deleted.status()).toBe(200);
  await citations.getByRole('button', { name: '인용 다시 확인' }).click();
  await expect(citations.getByText('권한이 철회되어 이 인용을 표시할 수 없습니다.')).toBeVisible();
  await expect(citations.getByText('회복 주간에는', { exact: false })).toHaveCount(0);
  await expect(
    citations.getByText(/삭제·동의 철회·검토 해제로 권한이 사라진 발췌는 표시하지 않습니다/),
  ).toBeVisible();
});
