import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { planReadSchema } from '@workout/contracts/planning';
import type { Activity } from '@workout/contracts/activity';
import { createBatchSelectionStore, toBatchTarget } from '../src/batch-selection';
import { ActivityBatchLink } from '../src/activity-batch-link';
const version = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const activity: Activity = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  revision: 2,
  source: { kind: 'fixture', sourceId: 'fixture', revision: 1, contentHash: 'a'.repeat(64) },
  original: {
    title: '테스트',
    kind: 'running',
    startedAt: null,
    timezone: null,
    durationSeconds: 0,
    durationKind: 'timer',
    distanceMeters: 0,
  },
  effective: {
    title: '테스트',
    kind: 'running',
    startedAt: null,
    timezone: null,
    durationSeconds: 0,
    durationKind: 'timer',
    distanceMeters: 0,
  },
  overlay: {},
  userReport: {
    definitionVersion: 'activity-report-v1',
    source: 'user',
    method: 'self_report',
    sessionRpe: 0,
    note: '보존할 보고',
    rpeReportedAt: '2026-09-17T00:00:00Z',
    planLink: { planVersionId: version, sessionId: 'old-session' },
  },
};
const response = (body: unknown, status = 200) =>
  transportReplySchema.parse({ status, body, traceId: null });
function setup(request: AuthenticatedTransport['request']) {
  const store = createBatchSelectionStore();
  store.getState().selectPage([toBatchTarget(activity)]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ActivityBatchLink
        store={store}
        transport={{ request }}
        scope={['activities', 'alice', 'session']}
        createId={() => 'stable-command-id'}
      />
    </QueryClientProvider>,
  );
  return { ...view, store, client };
}
async function preview(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('일괄 계획 동작'), 'unlink');
  await user.type(screen.getByLabelText('일괄 계획 연결 사유'), '연결 정정');
  await user.click(screen.getByRole('button', { name: '계획 연결 변경 미리보기' }));
  await screen.findByRole('button', { name: '계획 연결 변경 확인' });
}
describe('batch plan link confirmation', () => {
  it('prepares reads only without a saved plan and preserves RPE/note in the frozen confirmed request', async () => {
    const user = userEvent.setup();
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith('/plans/current')
        ? response({ head: null, history: [] })
        : input.method === 'GET'
          ? response(activity)
          : response({
              ...activity,
              revision: 3,
              userReport: { ...activity.userReport, planLink: null },
            }),
    );
    const { store } = setup(request);
    await preview(user);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    expect(store.getState().locked).toBe(true);
    expect(screen.getByRole('button', { name: '계획 연결 변경 취소' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 확인' }));
    await screen.findByRole('button', { name: '계획 연결 결과 닫기' });
    const put = request.mock.calls.find(([input]) => input.method === 'PATCH')?.[0];
    expect(put?.body).toEqual({
      expectedRevision: 2,
      reason: '연결 정정',
      report: { sessionRpe: 0, note: '보존할 보고', planLink: null },
    });
    expect(put?.idempotencyKey).toBe('stable-command-id');
    expect(store.getState().targets).toHaveLength(0);
  });
  it('retries uncertain commands with identical key/body without rereading a newer report', async () => {
    const user = userEvent.setup();
    let writes = 0;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) => {
      if (input.path.endsWith('/plans/current')) return response({ head: null, history: [] });
      if (input.method === 'GET') return response(activity);
      writes++;
      return writes === 1
        ? response(null, 503)
        : response({
            ...activity,
            revision: 3,
            userReport: { ...activity.userReport, planLink: null },
          });
    });
    setup(request);
    await preview(user);
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 확인' }));
    await user.click(await screen.findByRole('button', { name: '미확인 계획 연결 다시 확인' }));
    await screen.findByRole('button', { name: '계획 연결 결과 닫기' });
    const commands = request.mock.calls
      .filter(([input]) => input.method === 'PATCH')
      .map(([input]) => ({ body: input.body, key: input.idempotencyKey }));
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    expect(
      request.mock.calls.filter(
        ([input]) => input.method === 'GET' && !input.path.endsWith('/plans/current'),
      ),
    ).toHaveLength(1);
  });
  it('cancels preparation and ignores late reads while unlocking selection', async () => {
    const user = userEvent.setup();
    let finish: (value: ReturnType<typeof response>) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>((input) =>
      input.path.endsWith('/plans/current')
        ? Promise.resolve(response({ head: null, history: [] }))
        : new Promise((resolve) => {
            finish = resolve;
          }),
    );
    const { store } = setup(request);
    await user.selectOptions(screen.getByLabelText('일괄 계획 동작'), 'unlink');
    await user.type(screen.getByLabelText('일괄 계획 연결 사유'), '취소');
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 미리보기' }));
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 취소' }));
    await act(async () => finish(response(activity)));
    expect(store.getState().locked).toBe(false);
    expect(screen.getByRole('button', { name: '계획 연결 변경 미리보기' })).toHaveFocus();
    expect(screen.queryByRole('group', { name: '일괄 계획 연결 확인' })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([input]) => input.method === 'PATCH')).toBe(false);
  });
  it('keeps confirmed success despite refresh failure and does not retry it', async () => {
    const user = userEvent.setup();
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith('/plans/current')
        ? response({ head: null, history: [] })
        : input.method === 'GET'
          ? response(activity)
          : response({
              ...activity,
              revision: 3,
              userReport: { ...activity.userReport, planLink: null },
            }),
    );
    const { client } = setup(request);
    vi.spyOn(client, 'resetQueries').mockRejectedValue(new Error('offline'));
    await preview(user);
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 확인' }));
    expect(await screen.findByText(/최신 목록 조회에 실패/)).toBeVisible();
    expect(screen.getByRole('region', { name: '일괄 계획 연결 결과' })).toHaveTextContent(
      '계획 연결 변경 확인',
    );
    expect(
      screen.queryByRole('button', { name: '미확인 계획 연결 다시 확인' }),
    ).not.toBeInTheDocument();
  });
  it('requires fresh selection after preparation conflict and never writes unchanged links', async () => {
    const user = userEvent.setup();
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith('/plans/current')
        ? response({ head: null, history: [] })
        : response({ ...activity, revision: 3 }),
    );
    const { store } = setup(request);
    await preview(user);
    expect(screen.getByRole('button', { name: '계획 연결 변경 확인' })).toBeDisabled();
    expect(store.getState().targets).toHaveLength(0);
    expect(screen.getByText(/수정 충돌/)).toBeVisible();
  });
  it('keeps an explicitly chosen immutable version after the current plan head changes', async () => {
    const user = userEvent.setup();
    const levels = ['season', 'wave', 'phase', 'block'] as const;
    const plan = planReadSchema.parse({
      head: {
        id: version,
        version: 1,
        createdAt: '2026-09-17T00:00:00Z',
        draft: {
          title: '고정 계획',
          timezone: 'UTC',
          periods: levels.map((level, index) => ({
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
          sessions: [
            {
              id: 'new-session',
              blockId: 'block',
              date: '2026-09-17',
              localStartTime: null,
              title: '선택 세션',
              sport: 'running',
              durationSeconds: null,
              distanceMeters: 0,
              purpose: '',
              notes: '',
              priority: 'normal',
              locks: { date: false, time: false, intensity: false },
              steps: [],
              targetRpe: null,
            },
          ],
        },
      },
      history: [],
    });
    let current = plan;
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith('/plans/current') ? response(current) : response(activity),
    );
    setup(request);
    await screen.findByRole('option', { name: '선택 세션 · 2026-09-17 · new-session' });
    const chosen = JSON.stringify({ planVersionId: version, sessionId: 'new-session' });
    await user.selectOptions(screen.getByLabelText('연결할 계획 세션'), chosen);
    if (!plan.head) throw new Error('Missing plan fixture');
    current = {
      ...plan,
      head: { ...plan.head, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', version: 2 },
    };
    await user.click(screen.getByRole('button', { name: '일괄 연결 계획 다시 확인' }));
    await screen.findByRole('option', { name: /이전 선택 유지/ });
    expect(screen.getByLabelText('연결할 계획 세션')).toHaveValue(chosen);
    await user.type(screen.getByLabelText('일괄 계획 연결 사유'), '이전 선택 확인');
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 미리보기' }));
    await screen.findByRole('button', { name: '계획 연결 변경 확인' });
    expect(screen.getByRole('group', { name: '일괄 계획 연결 확인' })).toHaveTextContent(version);
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
  it('allows unlink despite a failed plan lookup and does not write unchanged reports', async () => {
    const user = userEvent.setup();
    const request = vi.fn<AuthenticatedTransport['request']>(async (input) =>
      input.path.endsWith('/plans/current')
        ? response(null, 503)
        : response({ ...activity, userReport: { ...activity.userReport, planLink: null } }),
    );
    const { store } = setup(request);
    await screen.findByText(/저장된 계획을 조회하지 못했습니다/);
    await preview(user);
    expect(screen.getByText(/이미 같은 연결: 변경하지 않음/)).toBeVisible();
    expect(screen.getByRole('button', { name: '계획 연결 변경 확인' })).toBeDisabled();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
    expect(store.getState().targets).toHaveLength(1);
  });
  it('aborts on unmount and never publishes late mutation results', async () => {
    const user = userEvent.setup();
    let finish: (value: ReturnType<typeof response>) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>((input) =>
      input.path.endsWith('/plans/current')
        ? Promise.resolve(response({ head: null, history: [] }))
        : input.method === 'GET'
          ? Promise.resolve(response(activity))
          : new Promise((resolve) => {
              finish = resolve;
            }),
    );
    const { unmount, store, client } = setup(request);
    const reset = vi.spyOn(client, 'resetQueries');
    await preview(user);
    await user.click(screen.getByRole('button', { name: '계획 연결 변경 확인' }));
    await waitFor(() =>
      expect(request.mock.calls.some(([input]) => input.method === 'PATCH')).toBe(true),
    );
    unmount();
    await act(async () =>
      finish(
        response({
          ...activity,
          revision: 3,
          userReport: { ...activity.userReport, planLink: null },
        }),
      ),
    );
    expect(reset).not.toHaveBeenCalled();
    expect(store.getState().targets).toHaveLength(1);
    expect(
      request.mock.calls.find(([input]) => input.method === 'PATCH')?.[0].signal?.aborted,
    ).toBe(true);
  });
});
