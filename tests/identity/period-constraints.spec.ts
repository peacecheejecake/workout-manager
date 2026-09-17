import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { activityListSchema } from '../../packages/contracts/src/activity';
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
  // Synthetic account and private PostgreSQL data belong only to this E2E harness.
  const erased = await page.request.delete('/bff/v1/operations/account', {
    headers,
    data: { confirmation: 'DELETE MY ACCOUNT' },
    timeout: 5000,
  });
  expect(erased.status()).toBe(200);
  expect((await page.request.get('/bff/v1/session', { timeout: 5000 })).status()).toBe(401);
});
async function setupConstraints(page: Page) {
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  const headers = await login(page);
  cleanupHeaders.set(page, headers);
  const read = async () => {
    const response = await page.request.get('/bff/v1/plans/current', { headers });
    expect(response.status()).toBe(200);
    return planReadSchema.parse(await response.json());
  };
  const readActuals = async () => {
    const response = await page.request.get('/bff/v1/activities', { headers });
    expect(response.status()).toBe(200);
    return activityListSchema.parse(await response.json());
  };
  const current = await read();
  const actuals = await readActuals();
  const draft = planDraftSchema.parse({
    title: `Synthetic constraints ${randomUUID()}`,
    timezone: 'UTC',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: `constraints-${level}`,
      parentId: index === 0 ? null : `constraints-${levels[index - 1]}`,
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-01-08',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      { id: 'known-one', date: '2080-01-03', durationSeconds: 120 },
      { id: 'known-two', date: '2080-01-03', durationSeconds: 180 },
      { id: 'unknown-day-known', date: '2080-01-04', durationSeconds: 60 },
      { id: 'unknown-day-missing', date: '2080-01-04', durationSeconds: null },
      { id: 'known-zero', date: '2080-01-05', durationSeconds: 0 },
    ].map((value) => ({
      ...value,
      blockId: 'constraints-block',
      localStartTime: null,
      title: value.id,
      sport: 'running',
      distanceMeters: 0,
      targetRpe: 0,
      intensityLabel: 'A',
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: true, time: true, intensity: true },
      steps: [
        {
          id: `${value.id}-step`,
          kind: 'work',
          durationSeconds: 600,
          distanceMeters: null,
          repetitions: 3,
        },
      ],
    })),
  });
  const seedBody = {
    source: 'manual',
    confirmed: true,
    expectedVersionId: current.head?.id ?? null,
    draft,
  };
  const seedKey = randomUUID();
  const response = await page.request.put('/bff/v1/plans/current', {
    headers: { ...headers, 'idempotency-key': seedKey },
    data: seedBody,
  });
  expect(response.status()).toBe(200);
  const saved = planSnapshotSchema.parse(await response.json());
  const writes: string[] = [];
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname.startsWith('/bff/v1/') &&
      !['GET', 'HEAD'].includes(request.method())
    )
      writes.push(request.method());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/planner?lens=period&period=constraints-block&plannedSession=known-one');
  return { headers, read, readActuals, actuals, saved, seedBody, seedKey, writes };
}
const periodEditor = (page: Page, level: string) =>
  page.getByRole('group', { name: `${level}: ${level}`, exact: true });
async function addLimit(editor: Locator, date: string, seconds: number) {
  await editor.getByLabel('가용 시간 날짜', { exact: true }).fill(date);
  await editor
    .getByRole('spinbutton', { name: '운동 가능 시간 (초)', exact: true })
    .fill(String(seconds));
  await editor.getByRole('button', { name: '가용 시간 추가', exact: true }).click();
  await expect(
    editor.getByRole('spinbutton', { name: `${date} 운동 가능 시간 (초)`, exact: true }),
  ).toHaveValue(String(seconds));
}
async function save(page: Page) {
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
}

test('inherited date constraints report conflict and unknown without rewriting locked sessions, and survive explicit storage and history', async ({
  page,
}) => {
  const f = await setupConstraints(page);
  expect(f.saved.draft.periods.every((period) => !Object.hasOwn(period, 'constraints'))).toBe(true);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const parent = periodEditor(page, 'season');
  const child = periodEditor(page, 'block');
  await parent.getByLabel('운동 불가 날짜', { exact: true }).fill('2080-01-03');
  await parent.getByRole('button', { name: '운동 불가 날짜 추가', exact: true }).click();
  await addLimit(parent, '2080-01-03', 400);
  await addLimit(parent, '2080-01-04', 600);
  await addLimit(child, '2080-01-03', 250);
  await addLimit(child, '2080-01-04', 500);
  await addLimit(child, '2080-01-05', 0);
  const quantity = child.getByRole('spinbutton', {
    name: '2080-01-03 운동 가능 시간 (초)',
    exact: true,
  });
  await quantity.focus();
  for (const viewport of viewportFixtures) {
    await page.setViewportSize(viewport);
    await expect(quantity).toHaveValue('250');
    await expect(quantity).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  const report = page
    .getByRole('region', { name: '기간 트리 초안', exact: true })
    .getByRole('region', { name: '기간 제약 판정', exact: true });
  const conflict = report.getByRole('listitem', { name: '제약 날짜 2080-01-03', exact: true });
  const unknown = report.getByRole('listitem', { name: '제약 날짜 2080-01-04', exact: true });
  const zero = report.getByRole('listitem', { name: '제약 날짜 2080-01-05', exact: true });
  await expect(conflict).toHaveAttribute('data-status', 'conflict');
  await expect(conflict).toContainText(
    '계획 세션 2개 · 알려진 계획 시간 300초 · 시간 미정 세션 0개 · 적용 가용량 250초',
  );
  await expect(conflict).toContainText('운동 불가 출처: season · season');
  await expect(conflict).toContainText('가용량 출처: season · season');
  await expect(conflict).toContainText('가용량 출처: block · block');
  await expect(unknown).toHaveAttribute('data-status', 'unknown');
  await expect(unknown).toContainText(
    '계획 세션 2개 · 알려진 계획 시간 60초 · 시간 미정 세션 1개 · 적용 가용량 500초',
  );
  await expect(zero).toHaveAttribute('data-status', 'no_conflict');
  await expect(zero).toContainText(
    '계획 세션 1개 · 알려진 계획 시간 0초 · 시간 미정 세션 0개 · 적용 가용량 0초',
  );
  await quantity.fill('0');
  await expect(conflict).toContainText('적용 가용량 0초');
  await expect(conflict).toContainText('알려진 계획 시간 300초');
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(quantity).toHaveValue('250');
  await expect(conflict).toContainText('적용 가용량 250초');
  expect(f.writes).toEqual([]);
  expect((await f.read()).head).toEqual(f.saved);
  await page.getByRole('button', { name: '변경 미리보기', exact: true }).click();
  const preview = page.getByRole('region', { name: '변경 미리보기', exact: true });
  await expect(
    preview
      .getByRole('region', { name: '기간 제약 판정', exact: true })
      .getByRole('listitem', { name: '제약 날짜 2080-01-03', exact: true }),
  ).toContainText('알려진 계획 시간 300초');
  await preview.getByText('변경 전후 전체 내용 비교', { exact: true }).click();
  await expect(preview).toContainText('2080-01-03');
  await expect(preview).toContainText('250');
  await expect(
    page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }),
  ).toBeEnabled();
  expect(f.writes).toEqual([]);
  await page.getByRole('button', { name: '확인하고 계획 버전 저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '계획 초안 편집', exact: true })).toBeVisible();
  const constrained = (await f.read()).head;
  assert.ok(constrained);
  expect(constrained.draft.sessions).toEqual(f.saved.draft.sessions);
  expect(constrained.draft.periods).toEqual(
    f.saved.draft.periods.map((period) =>
      period.level === 'season'
        ? {
            ...period,
            constraints: {
              unavailableDates: ['2080-01-03'],
              dailyTimeLimits: [
                { date: '2080-01-03', availableSeconds: 400 },
                { date: '2080-01-04', availableSeconds: 600 },
              ],
            },
          }
        : period.level === 'block'
          ? {
              ...period,
              constraints: {
                unavailableDates: [],
                dailyTimeLimits: [
                  { date: '2080-01-03', availableSeconds: 250 },
                  { date: '2080-01-04', availableSeconds: 500 },
                  { date: '2080-01-05', availableSeconds: 0 },
                ],
              },
            }
          : period,
    ),
  );
  expect(f.writes).toEqual(['PUT']);
  await page.reload();
  const savedReport = page
    .getByRole('region', { name: '기간 탐색', exact: true })
    .getByRole('region', { name: '기간 제약 판정', exact: true });
  const savedConflict = savedReport.getByRole('listitem', {
    name: '제약 날짜 2080-01-03',
    exact: true,
  });
  const savedUnknown = savedReport.getByRole('listitem', {
    name: '제약 날짜 2080-01-04',
    exact: true,
  });
  await expect(savedUnknown).toHaveAttribute('data-status', 'unknown');
  await expect(savedConflict).toContainText('적용 가용량 250초');
  await page.getByRole('button', { name: `버전 ${f.saved.version}과 비교`, exact: true }).click();
  const comparison = page.getByRole('region', { name: '저장된 계획 버전 비교', exact: true });
  await comparison
    .getByRole('combobox', { name: '비교할 기간', exact: true })
    .selectOption('constraints-block');
  const blockRow = comparison
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^block ·/ }) });
  await blockRow.locator('summary').first().click();
  await blockRow.getByRole('region', { name: '이후 기간', exact: true }).locator('summary').click();
  await expect(blockRow.getByRole('region', { name: '이후 기간', exact: true })).toContainText(
    '2080-01-05',
  );
  await expect(blockRow.getByRole('region', { name: '이전 기간', exact: true })).not.toContainText(
    '2080-01-05',
  );
  await comparison.getByRole('button', { name: '버전 비교 닫기', exact: true }).click();
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await child.getByRole('button', { name: '이 기간의 직접 제약 모두 해제', exact: true }).click();
  await expect(quantity).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(quantity).toHaveValue('250');
  await child.getByRole('button', { name: '이 기간의 직접 제약 모두 해제', exact: true }).click();
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  expect((await f.read()).head).toEqual(constrained);
  expect(f.writes).toEqual(['PUT']);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  await expect(quantity).toHaveValue('250');
  await child.getByRole('button', { name: '이 기간의 직접 제약 모두 해제', exact: true }).click();
  await save(page);
  const clearedRead = await f.read();
  const cleared = clearedRead.head;
  assert.ok(cleared);
  expect(cleared.draft.periods.find((period) => period.level === 'block')?.constraints).toEqual({
    unavailableDates: [],
    dailyTimeLimits: [],
  });
  expect(cleared.draft.periods.find((period) => period.level === 'season')).toEqual(
    constrained.draft.periods.find((period) => period.level === 'season'),
  );
  for (const period of cleared.draft.periods.filter((period) =>
    ['wave', 'phase'].includes(period.level),
  ))
    expect(period).not.toHaveProperty('constraints');
  expect(cleared.draft.sessions).toEqual(f.saved.draft.sessions);
  await expect(savedConflict).toContainText('적용 가용량 400초');
  await expect(savedUnknown).toContainText('적용 가용량 600초');
  await expect(
    savedReport.getByRole('listitem', { name: '제약 날짜 2080-01-05', exact: true }),
  ).toHaveCount(0);
  const replay = await page.request.put('/bff/v1/plans/current', {
    headers: { ...f.headers, 'idempotency-key': f.seedKey },
    data: f.seedBody,
  });
  expect(replay.status()).toBe(200);
  expect(planSnapshotSchema.parse(await replay.json())).toEqual(f.saved);
  expect(await f.read()).toEqual(clearedRead);
  const old = await page.request.get(`/bff/v1/plans/versions/${f.saved.id}`, {
    headers: f.headers,
  });
  expect(old.status()).toBe(200);
  expect(planSnapshotSchema.parse(await old.json())).toEqual(f.saved);
  expect(f.writes).toEqual(['PUT', 'PUT']);
  expect(await f.readActuals()).toEqual(f.actuals);
});

test('date bounds and shrinking periods keep invalid constraints visible and block preview without silent removal', async ({
  page,
}) => {
  const f = await setupConstraints(page);
  await page.getByRole('button', { name: '계획 초안 편집', exact: true }).click();
  const child = periodEditor(page, 'block');
  await child.getByLabel('운동 불가 날짜', { exact: true }).fill('2080-01-08');
  await child.getByRole('button', { name: '운동 불가 날짜 추가', exact: true }).click();
  await expect(
    child.getByRole('button', { name: '2080-01-08 운동 불가 날짜 삭제', exact: true }),
  ).toHaveCount(0);
  await expect(child.getByRole('alert')).toBeVisible();
  await child.getByLabel('운동 불가 날짜', { exact: true }).fill('2080-01-07');
  await child.getByRole('button', { name: '운동 불가 날짜 추가', exact: true }).click();
  await addLimit(child, '2080-01-07', 0);
  await child.getByLabel('기간 종료일 (미포함)', { exact: true }).fill('2080-01-07');
  await expect(
    child.getByRole('button', { name: '2080-01-07 운동 불가 날짜 삭제', exact: true }),
  ).toBeVisible();
  await expect(
    child.getByRole('spinbutton', { name: '2080-01-07 운동 가능 시간 (초)', exact: true }),
  ).toHaveValue('0');
  await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeDisabled();
  expect(f.writes).toEqual([]);
  expect((await f.read()).head).toEqual(f.saved);
  await child.getByLabel('기간 종료일 (미포함)', { exact: true }).fill('2080-01-08');
  await expect(page.getByRole('button', { name: '변경 미리보기', exact: true })).toBeEnabled();
  await child.getByRole('button', { name: '2080-01-07 가용 시간 삭제', exact: true }).click();
  await expect(
    child.getByRole('spinbutton', { name: '2080-01-07 운동 가능 시간 (초)', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소', exact: true }).click();
  await expect(
    child.getByRole('spinbutton', { name: '2080-01-07 운동 가능 시간 (초)', exact: true }),
  ).toHaveValue('0');
  await page.getByRole('button', { name: '초안 버리기', exact: true }).click();
  expect(await f.readActuals()).toEqual(f.actuals);
  expect((await f.read()).head).toEqual(f.saved);
  expect(f.writes).toEqual([]);
});
