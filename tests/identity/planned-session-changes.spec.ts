import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
} from '../../packages/contracts/src/planning';
import { activityListSchema } from '../../packages/contracts/src/activity';

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

async function setup(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page, 'Alice');
  cleanupHeaders.set(page, headers);
  const previousResponse = await page.request.get('/bff/v1/plans/current', { headers });
  expect(previousResponse.status()).toBe(200);
  const previous = planReadSchema.parse(await previousResponse.json());
  const id = `완료 / ${randomUUID()}`;
  const draft = planDraftSchema.parse({
    title: 'Synthetic session change plan',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `completion-ui-${level}`,
      parentId: index === 0 ? null : `completion-ui-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2026-09-14',
      endDateExclusive: '2026-09-28',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: [id, `${id}-other`].map((sessionId, index) => ({
      id: sessionId,
      blockId: 'completion-ui-block',
      date: index === 0 ? '2026-09-20' : '2026-09-21',
      localStartTime: null,
      title: `Synthetic change session ${index + 1}`,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: null,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  });
  const save = async (expectedVersionId: string | null, next = draft) => {
    const response = await page.request.put('/bff/v1/plans/current', {
      headers: { ...headers, 'idempotency-key': randomUUID() },
      data: { source: 'manual', confirmed: true, expectedVersionId, draft: next },
      timeout: 5000,
    });
    expect(response.status()).toBe(200);
    return planSnapshotSchema.parse(await response.json());
  };
  const saved = await save(previous.head?.id ?? null);
  const actualCount = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json()).total;
  };
  await page.goto(
    `/planner?lens=calendar&from=2026-09-14&to=2026-09-28&plannedView=table&plannedColumns=title,notes&view=stack&plannedSession=${encodeURIComponent(id)}`,
  );
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
  return { headers, saved, draft, actualCount, id };
}

const tableRow = (page: Page, title: string) =>
  page
    .getByRole('table', { name: '계획 세션 표', exact: true })
    .getByRole('row')
    .filter({
      has: page.getByRole('button', { name: `계획: ${title}`, exact: true }),
    });

async function readHead(page: Page, headers: Awaited<ReturnType<typeof login>>) {
  const response = await page.request.get('/bff/v1/plans/current', { headers });
  expect(response.status()).toBe(200);
  return planReadSchema.parse(await response.json()).head;
}

test('session markers track isolated draft edits, undo, copies and deletion until explicit plan save', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await setup(page);
  const first = tableRow(page, 'Synthetic change session 1');
  const second = tableRow(page, 'Synthetic change session 2');
  const beforeActuals = await fixture.actualCount();
  let writes = 0;
  page.on('request', (request) => {
    if (request.method() === 'PUT' && new URL(request.url()).pathname === '/bff/v1/plans/current')
      writes++;
  });
  await expect(first.getByText('저장본', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(first.getByText('저장본과 동일', { exact: true })).toBeVisible();
  const notes = page.getByLabel('세션 메모', { exact: true });
  await notes.fill('Synthetic note change');
  await expect(first.getByText('수정된 초안', { exact: true })).toBeVisible();
  await expect(second.getByText('저장본과 동일', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(notes).toHaveValue('');
  await expect(first.getByText('저장본과 동일', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '세션 복제', exact: true }).click();
  const copied = tableRow(page, 'Synthetic change session 1 복사');
  await expect(copied.getByText('새 세션', { exact: true })).toBeVisible();
  await expect(first.getByText('저장본과 동일', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '세션 삭제', exact: true }).click();
  await expect(copied).toHaveCount(0);
  await expect(
    page
      .getByRole('table', { name: '계획 세션 표', exact: true })
      .getByRole('button', { name: /^계획: / }),
  ).toHaveCount(2);
  await first
    .getByRole('button', { name: '계획: Synthetic change session 1', exact: true })
    .click();
  await page.getByLabel('세션 제목', { exact: true }).fill('Synthetic edited title');
  const edited = tableRow(page, 'Synthetic edited title');
  await expect(edited.getByText('수정된 초안', { exact: true })).toBeVisible();
  expect(writes).toBe(0);
  expect((await readHead(page, fixture.headers))?.id).toBe(fixture.saved.id);
  expect(await fixture.actualCount()).toBe(beforeActuals);
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  expect(writes).toBe(0);
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
  await expect(edited.getByText('저장본', { exact: true })).toBeVisible();
  await expect(second.getByText('저장본', { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  const saved = await readHead(page, fixture.headers);
  expect(saved?.draft.sessions.map((session) => session.title)).toEqual([
    'Synthetic edited title',
    'Synthetic change session 2',
  ]);
  expect(saved?.draft.sessions.map((session) => session.id)).toEqual(
    fixture.draft.sessions.map((session) => session.id),
  );
  expect(await fixture.actualCount()).toBe(beforeActuals);
  await page.reload();
  await expect(edited.getByText('저장본', { exact: true })).toBeVisible();
});

test('session markers preserve draft and selection across calendar, agenda and narrow layouts, and distinguish plan title from timezone changes', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fixture = await setup(page);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await page.getByLabel('계획 제목', { exact: true }).fill('Only plan metadata changed');
  await expect(
    tableRow(page, 'Synthetic change session 1').getByText('저장본과 동일', { exact: true }),
  ).toBeVisible();
  await expect(
    tableRow(page, 'Synthetic change session 2').getByText('저장본과 동일', { exact: true }),
  ).toBeVisible();
  const notes = page.getByLabel('세션 메모', { exact: true });
  await notes.fill('Retain this draft across renderers');
  const selected = new URL(page.url()).searchParams.get('plannedSession');
  for (const [view, width] of [
    ['계획 달력 보기', 1440],
    ['계획 agenda 보기', 320],
    ['계획 표 보기', 1440],
  ] as const) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    const daily = page.getByRole('region', { name: '일별 계획', exact: true });
    await expect(daily.getByText('수정된 초안', { exact: true })).toHaveCount(1);
    await expect(daily.getByText('저장본과 동일', { exact: true })).toHaveCount(1);
    await expect(notes).toHaveValue('Retain this draft across renderers');
    expect(new URL(page.url()).searchParams.get('plannedSession')).toBe(selected);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  }
  await page.getByLabel('계획 시간대', { exact: true }).fill('America/New_York');
  await expect(
    tableRow(page, 'Synthetic change session 1').getByText('수정된 초안', { exact: true }),
  ).toBeVisible();
  await expect(
    tableRow(page, 'Synthetic change session 2').getByText('수정된 초안', { exact: true }),
  ).toBeVisible();
  expect((await readHead(page, fixture.headers))?.id).toBe(fixture.saved.id);
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  await expect(
    tableRow(page, 'Synthetic change session 1').getByText('저장본', { exact: true }),
  ).toBeVisible();
  await expect(
    tableRow(page, 'Synthetic change session 2').getByText('저장본', { exact: true }),
  ).toBeVisible();
});
