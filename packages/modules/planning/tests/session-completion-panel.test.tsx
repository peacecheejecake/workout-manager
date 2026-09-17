import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  transportReplySchema,
  transportRequestDtoSchema,
  type AuthenticatedTransport,
} from '@workout/contracts/core';
import type { PlanSnapshot } from '@workout/contracts/planning';
import type {
  SessionCompletion,
  SessionCompletionRead,
} from '@workout/contracts/session-completion';
import {
  SessionCompletionPanel,
  type SessionCompletionPanelProps,
} from '../src/session-completion-panel';

const versionId = '11111111-1111-4111-8111-111111111111';
const nextId = '22222222-2222-4222-8222-222222222222';
const head: PlanSnapshot = {
  id: versionId,
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  draft: {
    title: '저장된 계획',
    timezone: 'Asia/Seoul',
    periods: (['season', 'wave', 'phase', 'block'] as const).map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : (levels[index - 1] ?? null),
      level,
      title: `저장된 ${level}`,
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'Asia/Seoul',
      intent: '',
      isPartial: false,
    })),
    sessions: ['session-a', 'session-b'].map((id) => ({
      id,
      blockId: 'block',
      date: '2026-09-17',
      localStartTime: null,
      title: `저장된 ${id}`,
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    })),
  },
};
function completed(
  revision = 1,
  status: SessionCompletion['status'] = 'completed',
): SessionCompletion {
  return {
    sessionId: 'session-a',
    revision,
    planVersionId: versionId,
    schedule: {
      blockId: 'block',
      date: '2026-09-17',
      localStartTime: null,
      timezone: 'Asia/Seoul',
    },
    status,
    reportedAt: '2026-09-18T00:00:00Z',
    reason: revision > 1 ? 'Synthetic correction' : null,
    source: 'user',
    method: 'self_report',
    definitionVersion: 'session-completion-v1',
  };
}
function read(
  history: SessionCompletion[] = [],
  currentPlanVersionId = versionId,
  sessionId = 'session-a',
): SessionCompletionRead {
  return {
    sessionId,
    currentPlanVersionId,
    report: history[0] ?? null,
    history,
    totalHistory: history[0]?.revision ?? 0,
  };
}
function reply(body: unknown, status = 200) {
  return transportReplySchema.parse({ status, body, traceId: 'synthetic' });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  request: AuthenticatedTransport['request'],
  overrides: Partial<SessionCompletionPanelProps> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const createId = vi
    .fn()
    .mockReturnValueOnce('synthetic-command-1')
    .mockReturnValue('synthetic-command-2');
  const onCommitted = vi.fn(async () => {});
  const props: SessionCompletionPanelProps = {
    athleteId: 'alice',
    sessionId: 'auth-a',
    head,
    plannedSessionId: 'session-a',
    transport: { request },
    createId,
    onCommitted,
    ...overrides,
  };
  const view = (next: Partial<SessionCompletionPanelProps> = {}) => (
    <QueryClientProvider client={client}>
      <SessionCompletionPanel {...props} {...next} />
    </QueryClientProvider>
  );
  const result = render(view());
  return { ...result, view, createId, onCommitted, client };
}
const open = () => screen.getByRole('button', { name: '완료 확인하기' });
const reason = () => screen.getByRole('textbox', { name: '완료 보고 정정 사유' });
const preview = () => screen.getByRole('group', { name: '완료 보고 확인' });
async function prepareAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(open()).toBeEnabled());
  await user.click(open());
  await user.click(within(preview()).getByRole('button', { name: '확인하고 완료 기록' }));
}

describe('session completion panel', () => {
  it('round-trips arbitrary stable IDs through the real transport path schema for both reads and writes', async () => {
    const selectedId = '완료 / 11111111-1111-4111-8111-111111111111';
    const selectedHead: PlanSnapshot = {
      ...head,
      draft: {
        ...head.draft,
        sessions: head.draft.sessions.map((session) => ({
          ...session,
          id: session.id === 'session-a' ? selectedId : session.id,
        })),
      },
    };
    const report = { ...completed(), sessionId: selectedId };
    let model = read([], versionId, selectedId);
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) => {
      const { signal, ...wire } = input;
      expect(signal).toBeInstanceOf(AbortSignal);
      const validated = transportRequestDtoSchema.parse(wire);
      const url = new URL(validated.path, 'https://synthetic.invalid');
      expect(url.pathname).toBe('/bff/v1/plans/session-completion');
      expect(url.searchParams.get('sessionId')).toBe(selectedId);
      if (validated.method === 'GET') return reply(model);
      model = read([report], versionId, selectedId);
      return reply({ report, collectionRevision: 1 });
    });
    setup(request, { head: selectedHead, plannedSessionId: selectedId });
    await prepareAndConfirm(userEvent.setup());
    await screen.findByText(/완료 요청의 처리가 확인되었습니다/);
    await screen.findByText('현재 보고: 완료 확인됨');
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(request.mock.calls.filter(([call]) => call.method === 'GET')).toHaveLength(2);
    expect(
      transportRequestDtoSchema.safeParse({
        path: `/bff/v1/plans/sessions/${encodeURIComponent(selectedId)}/completion`,
        method: 'GET',
        body: null,
        idempotencyKey: null,
      }).success,
    ).toBe(false);
  });

  it('does not fetch or allow reports without a selected saved session', () => {
    const request = vi.fn<AuthenticatedTransport['request']>();
    const app = setup(request, { plannedSessionId: null });
    expect(screen.queryByRole('region', { name: '세션 완료 확인' })).not.toBeInTheDocument();
    app.rerender(app.view({ head: undefined, plannedSessionId: 'session-a' }));
    expect(screen.getByText('저장된 계획을 확인하고 있습니다.')).toBeVisible();
    expect(open()).toBeDisabled();
    app.rerender(app.view({ head: null, plannedSessionId: 'session-a' }));
    expect(screen.getByText(/새 세션은 저장 후/)).toBeVisible();
    app.rerender(app.view({ plannedSessionId: 'new-draft-only' }));
    expect(open()).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('explains missing self reports and previews the saved target without writing; cancel returns focus', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>().mockResolvedValue(reply(read()));
    setup(request);
    const user = userEvent.setup();
    await screen.findByText('현재 보고: 완료 확인 기록 없음');
    expect(screen.getByText(/실제 운동 종료 시각이 아닙니다/)).toBeVisible();
    await user.click(open());
    expect(preview()).toHaveTextContent(
      '저장된 session-a · 2026-09-17 · 저장된 block · 시작 미정 · Asia/Seoul',
    );
    const cancel = within(preview()).getByRole('button', { name: '취소' });
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    expect(open()).toHaveFocus();
    expect(screen.queryByRole('group', { name: '완료 보고 확인' })).not.toBeInTheDocument();
    expect(request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
  });

  it('writes only after explicit confirmation then queries authoritative current state and history', async () => {
    let model = read();
    const report = completed();
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) => {
      if (input.method === 'GET') return reply(model);
      model = read([report]);
      return reply({ report, collectionRevision: 1 });
    });
    const app = setup(request);
    await prepareAndConfirm(userEvent.setup());
    await screen.findByText('현재 보고: 완료 확인됨');
    await screen.findByText(/완료 요청의 처리가 확인되었습니다/);
    expect(app.onCommitted).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/bff/v1/plans/session-completion?sessionId=session-a',
        method: 'POST',
        idempotencyKey: 'synthetic-command-1',
        body: {
          action: 'complete',
          confirmed: true,
          expectedPlanVersionId: versionId,
          expectedRevision: null,
          reason: null,
        },
      }),
    );
    expect(screen.getByRole('region', { name: '완료 보고 이력' })).toHaveTextContent(
      '전체 1건 중 최근 1건',
    );
    expect(open()).toBeDisabled();
    expect(screen.getByRole('button', { name: '완료 확인 철회' })).toBeEnabled();
  });

  it('requires a reason for retraction and reconfirmation without turning missing time into zero', async () => {
    const first = completed();
    let model = read([first]);
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) => {
      if (input.method === 'GET') return reply(model);
      const report = { ...completed(2, 'retracted'), reason: '명시 철회' };
      model = read([report, first]);
      return reply({ report, collectionRevision: 2 });
    });
    setup(request);
    const user = userEvent.setup();
    const retract = await screen.findByRole('button', { name: '완료 확인 철회' });
    await waitFor(() => expect(retract).toBeEnabled());
    await user.click(retract);
    await screen.findByText(/철회·재확인에는 정정 사유가 필요합니다/);
    expect(screen.queryByRole('group', { name: '완료 보고 확인' })).not.toBeInTheDocument();
    await user.type(reason(), '명시 철회');
    await user.click(retract);
    await user.click(within(preview()).getByRole('button', { name: '확인하고 완료 기록' }));
    await screen.findByText('현재 보고: 완료 확인 철회됨');
    expect(reason()).toHaveValue('');
    await user.click(open());
    await screen.findByText(/철회·재확인에는 정정 사유가 필요합니다/);
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('region', { name: '완료 보고 이력' })).toHaveTextContent('시작 미정');
  });

  it('retains the reason after 409, refreshes both owners and requires a new explicit preview', async () => {
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockImplementation(async (input) =>
        input.method === 'GET'
          ? reply(read())
          : reply({ code: 'COMPLETION_REVISION_CONFLICT' }, 409),
      );
    const app = setup(request);
    const user = userEvent.setup();
    await waitFor(() => expect(open()).toBeEnabled());
    await user.type(reason(), '보존할 합성 사유');
    await prepareAndConfirm(user);
    await screen.findByText(/계획 또는 완료 기록이 변경되었습니다/);
    expect(reason()).toHaveValue('보존할 합성 사유');
    expect(app.onCommitted).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
    await user.click(open());
    expect(preview()).toHaveTextContent('보존할 합성 사유');
    expect(app.createId).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.filter(([call]) => call.method === 'POST')).toHaveLength(1);
  });

  it('retries the identical frozen command across head refresh and never shows a replay receipt as current status', async () => {
    let attempts = 0;
    let model = read();
    const first = completed();
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) => {
      if (input.method === 'GET') return reply(model);
      if (++attempts === 1) throw new Error('Synthetic response loss');
      return reply({ report: first, collectionRevision: 1 });
    });
    const app = setup(request);
    const user = userEvent.setup();
    await prepareAndConfirm(user);
    const retry = await screen.findByRole('button', {
      name: '같은 완료 요청 다시 확인',
    });
    expect(reason()).toBeDisabled();
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
    model = read([completed(2, 'retracted'), first], nextId);
    app.rerender(app.view({ head: { ...head, id: nextId, version: 2 } }));
    await user.click(retry);
    await screen.findByText(/완료 요청의 처리가 확인되었습니다/);
    await screen.findByText('현재 보고: 완료 확인 철회됨');
    expect(screen.queryByText('현재 보고: 완료 확인됨')).not.toBeInTheDocument();
    const posts = request.mock.calls
      .filter(([call]) => call.method === 'POST')
      .map(([call]) => call);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual(posts[0]);
    expect(app.createId).toHaveBeenCalledTimes(1);
  });

  it('keeps malformed success receipts unresolved and does not call the committed callback', async () => {
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) =>
      input.method === 'GET'
        ? reply(read())
        : reply({
            report: { ...completed(), sessionId: 'other-session' },
            collectionRevision: 1,
          }),
    );
    const app = setup(request);
    await prepareAndConfirm(userEvent.setup());
    await screen.findByRole('button', { name: '같은 완료 요청 다시 확인' });
    expect(app.onCommitted).not.toHaveBeenCalled();
    expect(screen.queryByText(/완료 요청의 처리가 확인되었습니다/)).not.toBeInTheDocument();
  });

  it('blocks stale-head and mismatched identity reads until an explicit refresh succeeds', async () => {
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValueOnce(reply(read([], nextId)))
      .mockResolvedValueOnce(reply(read([], versionId, 'other-session')))
      .mockResolvedValue(reply(read()));
    const app = setup(request);
    const user = userEvent.setup();
    await screen.findByText(/현재 저장 계획과 조회한 계획이 다릅니다/);
    expect(open()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '완료 기록 다시 확인' }));
    await screen.findByText('완료 기록을 읽지 못했습니다. 이전 결과를 사용하지 않습니다.');
    expect(open()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '완료 기록 다시 확인' }));
    await waitFor(() => expect(open()).toBeEnabled());
    expect(app.onCommitted).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
  });

  it('does not submit a preview after the saved head changes until it is cancelled and prepared again', async () => {
    let model = read();
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockImplementation(async () => reply(model));
    const app = setup(request);
    const user = userEvent.setup();
    await waitFor(() => expect(open()).toBeEnabled());
    await user.click(open());
    model = read([], nextId);
    app.rerender(app.view({ head: { ...head, id: nextId, version: 2 } }));
    await screen.findByText(/미리보기 이후 조회 상태가 달라졌습니다/);
    expect(within(preview()).getByRole('button', { name: '확인하고 완료 기록' })).toBeDisabled();
    await user.click(within(preview()).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(open()).toBeEnabled());
    await user.click(open());
    expect(within(preview()).getByRole('button', { name: '확인하고 완료 기록' })).toBeEnabled();
    expect(app.createId).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([call]) => call.method === 'GET')).toBe(true);
  });

  it.each(['selection', 'account'] as const)(
    'aborts an old write and clears private inputs on %s changes',
    async (boundary) => {
      const pending = deferred<ReturnType<typeof reply>>();
      const request = vi
        .fn<AuthenticatedTransport['request']>()
        .mockImplementation(async (input) =>
          input.method === 'GET'
            ? reply(
                read([], versionId, input.path.includes('session-b') ? 'session-b' : 'session-a'),
              )
            : pending.promise,
        );
      const app = setup(request);
      const user = userEvent.setup();
      await waitFor(() => expect(open()).toBeEnabled());
      await user.type(reason(), 'Old scoped private note');
      await prepareAndConfirm(user);
      const post = request.mock.calls.find(([call]) => call.method === 'POST')?.[0];
      expect(post?.signal?.aborted).toBe(false);
      app.rerender(
        app.view(
          boundary === 'selection'
            ? { plannedSessionId: 'session-b' }
            : { athleteId: 'bob', sessionId: 'auth-b' },
        ),
      );
      expect(post?.signal?.aborted).toBe(true);
      expect(reason()).toHaveValue('');
      await act(async () =>
        pending.resolve(
          reply({
            report: { ...completed(), reason: 'Old scoped private note' },
            collectionRevision: 1,
          }),
        ),
      );
      await waitFor(() => expect(open()).toBeEnabled());
      expect(app.onCommitted).not.toHaveBeenCalled();
      expect(screen.queryByText(/완료 요청의 처리가 확인되었습니다/)).not.toBeInTheDocument();
    },
  );

  it('shows the bounded newest history without shortening its total count', async () => {
    const history = Array.from({ length: 100 }, (_, index) => completed(105 - index));
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValue(reply(read(history)));
    setup(request);
    const historyRegion = await screen.findByRole('region', { name: '완료 보고 이력' });
    expect(historyRegion).toHaveTextContent('전체 105건 중 최근 100건');
    expect(within(historyRegion).getAllByRole('listitem')).toHaveLength(100);
    expect(within(historyRegion).getAllByRole('listitem')[0]).toHaveTextContent('수정 105');
  });

  it.each([400, 401, 403, 404])(
    'settles a definitive %i rejection and preserves editable reason',
    async (status) => {
      const request = vi
        .fn<AuthenticatedTransport['request']>()
        .mockImplementation(async (input) =>
          input.method === 'GET' ? reply(read()) : reply({ code: 'REJECTED' }, status),
        );
      const app = setup(request);
      const user = userEvent.setup();
      await waitFor(() => expect(open()).toBeEnabled());
      await user.type(reason(), 'Synthetic rejected reason');
      await prepareAndConfirm(user);
      await screen.findByText(/완료 요청이 거절되었습니다/);
      expect(reason()).toHaveValue('Synthetic rejected reason');
      expect(reason()).toBeEnabled();
      expect(
        screen.queryByRole('button', { name: '같은 완료 요청 다시 확인' }),
      ).not.toBeInTheDocument();
      expect(app.onCommitted).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a 503 command frozen while the host temporarily removes the saved head', async () => {
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockImplementation(async (input) =>
        input.method === 'GET' ? reply(read()) : reply({ code: 'TEMPORARILY_UNAVAILABLE' }, 503),
      );
    const app = setup(request);
    await prepareAndConfirm(userEvent.setup());
    await screen.findByRole('button', { name: '같은 완료 요청 다시 확인' });
    app.rerender(app.view({ head: undefined }));
    expect(screen.getByRole('button', { name: '같은 완료 요청 다시 확인' })).toBeEnabled();
    expect(preview()).toHaveTextContent('저장된 session-a');
    expect(reason()).toBeDisabled();
    expect(app.createId).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a committed receipt even when authoritative refresh fails without offering a new write retry', async () => {
    let posted = false;
    const request = vi.fn<AuthenticatedTransport['request']>().mockImplementation(async (input) => {
      if (input.method === 'GET')
        return posted ? reply({ code: 'READ_UNAVAILABLE' }, 503) : reply(read());
      posted = true;
      return reply({ report: completed(), collectionRevision: 1 });
    });
    setup(request);
    await prepareAndConfirm(userEvent.setup());
    await screen.findByText(/완료 요청의 처리는 확인했지만 최신 조회에 실패했습니다/);
    expect(open()).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: '같은 완료 요청 다시 확인' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('현재 보고: 완료 확인됨')).not.toBeInTheDocument();
  });
});
