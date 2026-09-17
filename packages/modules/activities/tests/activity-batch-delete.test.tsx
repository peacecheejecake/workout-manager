import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { ActivityBatchDelete } from '../src/activity-batch-delete';
import { createBatchSelectionStore, type BatchTarget } from '../src/batch-selection';
type TransportReply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
const targets: BatchTarget[] = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1, title: '첫 번째', sourceKind: 'fit' },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    revision: 2,
    title: '두 번째',
    sourceKind: 'manual',
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    revision: 3,
    title: '세 번째',
    sourceKind: 'fixture',
  },
];
const reply = (status: number): TransportReply => ({ status, body: null, traceId: null });
function setup(transport: AuthenticatedTransport, selection = targets) {
  const store = createBatchSelectionStore();
  store.getState().selectPage(selection);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const deleted = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <ActivityBatchDelete
        store={store}
        transport={transport}
        scope={['activities', 'alice', 'session']}
        onDeleted={deleted}
      />
    </QueryClientProvider>,
  );
  return { ...view, store, client, deleted };
}
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
  await user.click(screen.getByRole('button', { name: '선택 활동 삭제 확인' }));
}
describe('explicit frozen batch deletion', () => {
  it('requires confirmation, locks selection and restores trigger focus on keyboard cancellation', async () => {
    const user = userEvent.setup(),
      request = vi.fn();
    const { store } = setup({ request });
    expect(request).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' }));
    expect(store.getState().locked).toBe(true);
    const cancel = screen.getByRole('button', { name: '일괄 삭제 취소' });
    expect(cancel).toHaveFocus();
    act(() => store.getState().clear());
    expect(store.getState().targets).toHaveLength(3);
    await user.keyboard('{Enter}');
    expect(store.getState().locked).toBe(false);
    expect(screen.getByRole('button', { name: '선택 활동 삭제 미리보기' })).toHaveFocus();
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps exact revisions for partial results and retries only uncertain targets', async () => {
    const user = userEvent.setup();
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValueOnce(reply(204))
      .mockResolvedValueOnce(reply(409))
      .mockResolvedValueOnce(reply(503))
      .mockResolvedValueOnce(reply(204));
    const { store, deleted } = setup({ request });
    await confirm(user);
    await screen.findByRole('button', { name: '미확인 활동 삭제 다시 확인' });
    const results = screen.getByRole('region', { name: '일괄 삭제 결과' });
    expect(within(results).getByText(/첫 번째/)).toHaveTextContent('로컬 삭제 확인');
    expect(within(results).getByText(/두 번째/)).toHaveTextContent('수정 충돌');
    expect(within(results).getByText(/세 번째/)).toHaveTextContent('삭제 결과 미확인');
    expect(store.getState().targets).toEqual([targets[2]]);
    expect(deleted).toHaveBeenCalledWith([targets[0]?.id]);
    await user.click(screen.getByRole('button', { name: '미확인 활동 삭제 다시 확인' }));
    await waitFor(() => expect(deleted).toHaveBeenLastCalledWith([targets[2]?.id]));
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[2]?.[0].body).toEqual({ expectedRevision: 3 });
    expect(request.mock.calls[3]?.[0].body).toEqual({ expectedRevision: 3 });
    expect(request.mock.calls[3]?.[0].path).toBe(request.mock.calls[2]?.[0].path);
    await user.click(screen.getByRole('button', { name: '결과 닫기' }));
    expect(store.getState().locked).toBe(false);
    expect(screen.getByRole('heading', { name: '선택 활동 일괄 로컬 삭제' })).toHaveFocus();
  });
  it('reports the first confirmed deletion while a later request remains pending', async () => {
    const user = userEvent.setup();
    let finish: (value: TransportReply) => void = () => {};
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValueOnce(reply(204))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const { deleted, store } = setup({ request }, targets.slice(0, 2));
    await confirm(user);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(deleted).toHaveBeenCalledWith([targets[0]?.id]);
    expect(store.getState().targets).toEqual(targets.slice(1, 2));
    expect(screen.queryByRole('button', { name: '결과 닫기' })).not.toBeInTheDocument();
    await act(async () => finish(reply(503)));
    await screen.findByRole('button', { name: '결과 닫기' });
    expect(deleted).toHaveBeenCalledTimes(1);
  });
  it('does not relabel a confirmed deletion when cache refresh fails', async () => {
    const user = userEvent.setup();
    const { client, deleted } = setup(
      { request: vi.fn().mockResolvedValue(reply(204)) },
      targets.slice(0, 1),
    );
    vi.spyOn(client, 'resetQueries').mockRejectedValue(new Error('offline refresh'));
    await confirm(user);
    expect(await screen.findByText(/목록을 새로 조회하지 못했습니다/)).toBeVisible();
    expect(screen.getByRole('region', { name: '일괄 삭제 결과' })).toHaveTextContent(
      '로컬 삭제 확인',
    );
    expect(
      screen.queryByRole('button', { name: '미확인 활동 삭제 다시 확인' }),
    ).not.toBeInTheDocument();
    expect(deleted).toHaveBeenCalledTimes(1);
  });
  it('allows explicit close after uncertainty, keeping original selection and permitting later work', async () => {
    const user = userEvent.setup();
    const request = vi.fn().mockRejectedValue(new Error('lost response'));
    const { store } = setup({ request }, targets.slice(0, 1));
    await confirm(user);
    await screen.findByRole('button', { name: '미확인 활동 삭제 다시 확인' });
    await user.click(screen.getByRole('button', { name: '결과 닫기' }));
    expect(store.getState().targets).toEqual(targets.slice(0, 1));
    expect(store.getState().locked).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('stops on authentication failure and offers no retry for remaining targets', async () => {
    const user = userEvent.setup(),
      request = vi.fn().mockResolvedValue(reply(401));
    const { store } = setup({ request });
    await confirm(user);
    await screen.findByRole('button', { name: '결과 닫기' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('region', { name: '일괄 삭제 결과' })).toHaveTextContent(
      '실행하지 않음',
    );
    expect(
      screen.queryByRole('button', { name: '미확인 활동 삭제 다시 확인' }),
    ).not.toBeInTheDocument();
    expect(store.getState().targets).toHaveLength(3);
  });
  it('does not clear a new account selection or call a new callback after scope changes', async () => {
    const user = userEvent.setup();
    let finish: (value: TransportReply) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { rerender, client, deleted } = setup({ request }, targets.slice(0, 1));
    await confirm(user);
    const nextStore = createBatchSelectionStore();
    nextStore.getState().selectPage(targets.slice(1, 2));
    const nextDeleted = vi.fn();
    rerender(
      <QueryClientProvider client={client}>
        <ActivityBatchDelete
          store={nextStore}
          transport={{ request }}
          scope={['activities', 'bob', 'new-session']}
          onDeleted={nextDeleted}
        />
      </QueryClientProvider>,
    );
    expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await act(async () => finish(reply(204)));
    expect(deleted).not.toHaveBeenCalled();
    expect(nextDeleted).not.toHaveBeenCalled();
    expect(nextStore.getState().targets).toEqual(targets.slice(1, 2));
    expect(screen.queryByRole('region', { name: '일괄 삭제 결과' })).not.toBeInTheDocument();
  });
  it('aborts and ignores late responses after unmount without callbacks or cache mutation', async () => {
    const user = userEvent.setup();
    let resolve: (value: TransportReply) => void = () => {};
    const request = vi.fn<AuthenticatedTransport['request']>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { unmount, client, deleted, store } = setup({ request });
    const cancel = vi.spyOn(client, 'cancelQueries'),
      reset = vi.spyOn(client, 'resetQueries');
    await confirm(user);
    expect(screen.queryByRole('button', { name: '결과 닫기' })).not.toBeInTheDocument();
    unmount();
    expect(request.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await act(async () => resolve(reply(204)));
    expect(deleted).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(store.getState().targets).toEqual(targets);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
