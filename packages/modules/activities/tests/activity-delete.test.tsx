import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { Activity } from '@workout/contracts/activity';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { ActivityDelete } from '../src/activity-delete';
const values = {
  title: '삭제할 기록',
  kind: 'running' as const,
  startedAt: null,
  timezone: null,
  durationSeconds: null,
  durationKind: 'unknown' as const,
  distanceMeters: 0,
};
const record: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source: { kind: 'fit', sourceId: 'one', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};
const scope = ['users', 'alice', 'sessions', 'session-a', 'activity-browser'];
type Reply = Awaited<ReturnType<AuthenticatedTransport['request']>>;
function setup(
  request: AuthenticatedTransport['request'] = async () => ({
    status: 204,
    body: null,
    traceId: null,
  }),
) {
  const transport = { request: vi.fn(request) };
  const client = new QueryClient();
  const onDeleted = vi.fn();
  const tree = (
    current: Activity | null = record,
    selected: string | null = record.id,
    callback = onDeleted,
  ) => (
    <QueryClientProvider client={client}>
      <ActivityDelete
        current={current}
        selected={selected}
        transport={transport}
        scope={scope}
        onDeleted={callback}
      />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree, client, transport, onDeleted };
}
async function confirm() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  await user.click(screen.getByRole('button', { name: '이 활동 삭제 확인' }));
  return user;
}
it('requires explicit confirmation and returns focus after keyboard cancellation', async () => {
  const { transport } = setup();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  expect(screen.getByRole('group', { name: '로컬 삭제 확인' })).toHaveTextContent(
    '제공자 원본은 삭제하지 않습니다',
  );
  const cancel = screen.getByRole('button', { name: '로컬 삭제 취소' });
  expect(cancel).toHaveFocus();
  await user.keyboard('{Enter}');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '이 활동 로컬 삭제' })).toHaveFocus(),
  );
  expect(transport.request).not.toHaveBeenCalled();
});
it('invalidates unsubmitted confirmation when the selected revision changes', async () => {
  const { tree, rerender, transport } = setup();
  await userEvent.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  rerender(tree({ ...record, revision: 2 }));
  expect(screen.queryByRole('group', { name: '로컬 삭제 확인' })).not.toBeInTheDocument();
  expect(transport.request).not.toHaveBeenCalled();
});
it('closes a conflict and blocks the old revision until fresh detail is supplied', async () => {
  const { tree, rerender, transport } = setup(async () => ({
    status: 409,
    body: null,
    traceId: null,
  }));
  await confirm();
  await screen.findByText(/활동이 변경되었습니다/);
  expect(screen.queryByRole('group')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '이 활동 로컬 삭제' })).toBeDisabled();
  rerender(tree({ ...record, revision: 2 }));
  await confirm();
  expect(transport.request.mock.calls.map(([input]) => input.body)).toEqual([
    { expectedRevision: 1 },
    { expectedRevision: 2 },
  ]);
});
it('retains the exact uncertain command through missing detail and retries without a revision change', async () => {
  let calls = 0;
  const { rerender, tree, transport, onDeleted } = setup(async () => {
    if (++calls === 1) throw new Error('lost response');
    return { status: 204, body: null, traceId: null };
  });
  const user = await confirm();
  await screen.findByRole('button', { name: '같은 활동 삭제 다시 확인' });
  rerender(tree(null));
  await user.click(screen.getByRole('button', { name: '같은 활동 삭제 다시 확인' }));
  await screen.findByText(/로컬 삭제가 확인되었습니다/);
  expect(transport.request.mock.calls.map(([input]) => input.body)).toEqual([
    { expectedRevision: 1 },
    { expectedRevision: 1 },
  ]);
  expect(onDeleted).toHaveBeenCalledWith(record.id);
});
it('uses the latest completion callback after selection changes and aborts after unmount', async () => {
  let finish: ((reply: Reply) => void) | undefined;
  const { rerender, tree, onDeleted, transport, unmount } = setup(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await confirm();
  const next = vi.fn();
  rerender(
    tree(
      { ...record, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      next,
    ),
  );
  await act(async () => {
    finish?.({ status: 204, body: null, traceId: null });
  });
  expect(onDeleted).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledWith(record.id);
  await confirm();
  const signal = transport.request.mock.lastCall?.[0].signal;
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish?.({ status: 204, body: null, traceId: null });
  });
  expect(next).toHaveBeenCalledTimes(1);
});
it('does not offer deletion without current successful detail', () => {
  const { tree, rerender } = setup();
  rerender(tree(null));
  expect(screen.queryByRole('button', { name: '이 활동 로컬 삭제' })).not.toBeInTheDocument();
});
