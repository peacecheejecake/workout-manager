import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  coachingThreadCreateSchema,
  coachingMessageAppendSchema,
  type CoachingThread,
  type CoachingUserMessage,
} from '../../packages/contracts/src/coaching-threads';
import { planSnapshotSchema } from '../../packages/contracts/src/planning';

test('shared coaching UI preserves drafts, scopes saved messages and clears a replaced session', async ({
  page,
}) => {
  const plan = planSnapshotSchema.parse({
    id: randomUUID(),
    version: 1,
    createdAt: '2026-09-18T00:00:00Z',
    draft: {
      title: '두 shell 상담 계획',
      timezone: 'UTC',
      periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
        id: level,
        parentId: index ? levels[index - 1] : null,
        level,
        title: level,
        startDate: '2026-09-01',
        endDateExclusive: '2026-10-01',
        timezone: 'UTC',
        intent: '',
        isPartial: false,
        ...(level === 'season'
          ? {
              constraints: {
                unavailableDates: ['2026-09-24'],
                dailyTimeLimits: [{ date: '2026-09-25', availableSeconds: 0 }],
              },
            }
          : {}),
      })),
      sessions: [
        {
          id: 'session',
          blockId: 'block',
          date: '2026-09-20',
          localStartTime: null,
          title: '검토할 세션',
          sport: 'running',
          durationSeconds: null,
          distanceMeters: 0,
          targetRpe: null,
          purpose: '',
          notes: '',
          priority: 'normal',
          locks: { date: true, time: false, intensity: false },
          steps: [],
        },
      ],
    },
  });
  let account = 'first';
  let thread: CoachingThread | null = null;
  const messages: CoachingUserMessage[] = [];
  const writes: string[] = [];
  await page.route('**/bff/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path === '/bff/v1/session') {
      await route.fulfill({
        json: {
          athleteId: account,
          sessionId: `session-${account}`,
          csrfToken: 'c'.repeat(43),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      });
      return;
    }
    expect(request.headers()['x-workout-session-id']).toBe(`session-${account}`);
    if (path === '/bff/v1/coaching-constraints' && request.method() === 'GET') {
      await route.fulfill({ json: { headRevision: null, items: [] } });
      return;
    }
    if (request.method() !== 'GET') {
      expect(request.headers()['x-csrf-token']).toBe('c'.repeat(43));
      expect(request.headers()['idempotency-key']).toBeTruthy();
      writes.push(path);
    }
    if (path === '/bff/v1/plans/current') {
      await route.fulfill({
        json:
          account === 'first'
            ? {
                head: plan,
                history: [
                  { id: plan.id, version: 1, title: plan.draft.title, createdAt: plan.createdAt },
                ],
              }
            : { head: null, history: [] },
      });
      return;
    }
    if (path === `/bff/v1/plans/versions/${plan.id}`) {
      await route.fulfill({ json: plan });
      return;
    }
    if (path === '/bff/v1/coaching-threads' && request.method() === 'POST') {
      const input = coachingThreadCreateSchema.parse({
        ...request.postDataJSON(),
        idempotencyKey: request.headers()['idempotency-key'],
      });
      thread = {
        id: randomUUID(),
        planVersionId: input.planVersionId,
        scope: input.scope,
        title: input.title,
        revision: 1,
        createdAt: plan.createdAt,
        updatedAt: plan.createdAt,
      };
      const message: CoachingUserMessage = {
        id: randomUUID(),
        threadId: thread.id,
        revision: 1,
        role: 'user',
        content: input.message,
        createdAt: plan.createdAt,
      };
      messages.push(message);
      await route.fulfill({ json: { thread, message } });
      return;
    }
    if (path === '/bff/v1/coaching-threads') {
      await route.fulfill({
        json: {
          items: thread && account === 'first' ? [thread] : [],
          total: thread && account === 'first' ? 1 : 0,
        },
      });
      return;
    }
    if (thread && path === `/bff/v1/coaching-threads/${thread.id}`) {
      await route.fulfill({ json: thread });
      return;
    }
    if (thread && path === `/bff/v1/coaching-threads/${thread.id}/messages`) {
      if (request.method() === 'POST') {
        const input = coachingMessageAppendSchema.parse({
          ...request.postDataJSON(),
          idempotencyKey: request.headers()['idempotency-key'],
        });
        expect(input.expectedRevision).toBe(thread.revision);
        thread = { ...thread, revision: thread.revision + 1 };
        const message: CoachingUserMessage = {
          id: randomUUID(),
          threadId: thread.id,
          revision: thread.revision,
          role: 'user',
          content: input.message,
          createdAt: plan.createdAt,
        };
        messages.push(message);
        await route.fulfill({ json: { thread, message } });
        return;
      }
      await route.fulfill({
        json: {
          thread,
          messages: messages.filter(
            (message) => message.revision > Number(url.searchParams.get('afterRevision') ?? 0),
          ),
          hasMore: false,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'THREAD_NOT_FOUND' } } });
  });
  await page.goto('/coach');
  await expect(page.getByRole('heading', { name: '상담 기록', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: '상담 대상', exact: true }).selectOption('session');
  await expect(page.getByRole('region', { name: '저장된 상담 맥락' })).toContainText(
    '2026-09-25: 0초',
  );
  await page.getByRole('textbox', { name: '상담 제목', exact: true }).fill('공통 모듈 검증');
  await page
    .getByRole('textbox', { name: '첫 사용자 메시지', exact: true })
    .fill('  두 shell에서 유지할 초안\n');
  for (const width of [320, 767, 768, 1279, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('textbox', { name: '첫 사용자 메시지', exact: true })).toHaveValue(
      '  두 shell에서 유지할 초안\n',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole('button', { name: '상담 기록 만들기', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/thread=/);
  await expect(page.getByRole('region', { name: '사용자 메시지 기록' })).toContainText(
    '두 shell에서 유지할 초안',
  );
  await page
    .getByRole('textbox', { name: '사용자 메시지', exact: true })
    .fill('추가 사용자 메시지');
  await page.getByRole('button', { name: '사용자 메시지 저장', exact: true }).click();
  await expect(page.getByRole('region', { name: '사용자 메시지 기록' })).toContainText(
    '추가 사용자 메시지',
  );
  expect(messages).toHaveLength(2);
  expect(writes).toHaveLength(2);
  expect(writes.every((path) => path.startsWith('/bff/v1/coaching-threads'))).toBe(true);
  await page.getByRole('button', { name: '새 상담 작성', exact: true }).click();
  await page.getByRole('textbox', { name: '상담 제목', exact: true }).fill('이전 사용자 개인 초안');
  account = 'second';
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByRole('textbox', { name: '상담 제목', exact: true })).toHaveValue('');
  await expect(page.getByRole('navigation', { name: '상담 목록' })).not.toContainText(
    '공통 모듈 검증',
  );
  await expect(page.getByText('저장된 상담이 없습니다.', { exact: true })).toBeVisible();
});
