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
/**
 * The confirmation also asks which courses the deletion would reclaim (M2-01f). That read
 * is answered here so the delete assertions below stay about the delete: they filter the
 * DELETE calls rather than assuming the component makes exactly one request.
 */
const impactDigest = 'a'.repeat(64);
/** Answers for whichever activity was asked about, as the real route does. */
const impactReply = (path: string): Reply => ({
  status: 200,
  body: {
    activityId: path.split('/')[4] ?? record.id,
    digest: impactDigest,
    courses: [],
    total: 0,
  },
  traceId: null,
});
function setup(
  request: AuthenticatedTransport['request'] = async () => ({
    status: 204,
    body: null,
    traceId: null,
  }),
) {
  const transport = {
    request: vi.fn(async (input: Parameters<AuthenticatedTransport['request']>[0]) =>
      input.path.endsWith('/deletion-impact') ? impactReply(input.path) : request(input),
    ),
  };
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
  // Confirmation is blocked until the affected-course list has been read.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '이 활동 삭제 확인' })).toBeEnabled(),
  );
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
  expect(transport.request.mock.calls.filter(([input]) => input.method === 'DELETE')).toHaveLength(
    0,
  );
});
it('invalidates unsubmitted confirmation when the selected revision changes', async () => {
  const { tree, rerender, transport } = setup();
  await userEvent.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  rerender(tree({ ...record, revision: 2 }));
  expect(screen.queryByRole('group', { name: '로컬 삭제 확인' })).not.toBeInTheDocument();
  expect(transport.request.mock.calls.filter(([input]) => input.method === 'DELETE')).toHaveLength(
    0,
  );
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
  expect(
    transport.request.mock.calls
      .filter(([input]) => input.method === 'DELETE')
      .map(([input]) => input.body),
  ).toEqual([
    { expectedRevision: 1, expectedCourseImpact: impactDigest },
    { expectedRevision: 2, expectedCourseImpact: impactDigest },
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
  expect(
    transport.request.mock.calls
      .filter(([input]) => input.method === 'DELETE')
      .map(([input]) => input.body),
  ).toEqual([
    { expectedRevision: 1, expectedCourseImpact: impactDigest },
    { expectedRevision: 1, expectedCourseImpact: impactDigest },
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

it('shows the courses this deletion would reclaim before it can be confirmed', async () => {
  const transport = {
    request: vi.fn(
      async (input: Parameters<AuthenticatedTransport['request']>[0]): Promise<Reply> =>
        input.path.endsWith('/deletion-impact')
          ? {
              status: 200,
              body: {
                activityId: record.id,
                digest: impactDigest,
                courses: [
                  {
                    courseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    name: '한강 구간',
                    headRevision: 2,
                  },
                  {
                    courseId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                    name: '독립 편집본',
                    headRevision: 1,
                  },
                ],
                total: 2,
              },
              traceId: null,
            }
          : { status: 204, body: null, traceId: null },
    ),
  };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ActivityDelete
        current={record}
        selected={record.id}
        transport={transport}
        scope={scope}
        onDeleted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  const impact = await screen.findByRole('region', { name: '삭제 영향 코스' });
  await waitFor(() => expect(impact).toHaveTextContent('코스 2개도 함께 회수되어'));
  expect(impact).toHaveTextContent('한강 구간');
  expect(impact).toHaveTextContent('독립 편집본');
  expect(transport.request).toHaveBeenCalledWith(
    expect.objectContaining({ path: `/bff/v1/activities/${record.id}/deletion-impact` }),
  );
});

it('says so when the affected courses could not be checked, rather than implying none', async () => {
  const transport = {
    request: vi.fn(
      async (input: Parameters<AuthenticatedTransport['request']>[0]): Promise<Reply> =>
        input.path.endsWith('/deletion-impact')
          ? { status: 503, body: null, traceId: null }
          : { status: 204, body: null, traceId: null },
    ),
  };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ActivityDelete
        current={record}
        selected={record.id}
        transport={transport}
        scope={scope}
        onDeleted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('코스를 확인하지 못했습니다');
});

it('cannot be confirmed while the affected-course list is still unknown', async () => {
  let releaseImpact: ((reply: Reply) => void) | undefined;
  const transport = {
    request: vi.fn(
      async (input: Parameters<AuthenticatedTransport['request']>[0]): Promise<Reply> =>
        input.path.endsWith('/deletion-impact')
          ? new Promise((resolve) => {
              releaseImpact = resolve;
            })
          : { status: 204, body: null, traceId: null },
    ),
  };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ActivityDelete
        current={record}
        selected={record.id}
        transport={transport}
        scope={scope}
        onDeleted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  const confirmButton = screen.getByRole('button', { name: '이 활동 삭제 확인' });
  expect(confirmButton).toBeDisabled();
  await userEvent.click(confirmButton);
  expect(transport.request.mock.calls.filter(([input]) => input.method === 'DELETE')).toHaveLength(
    0,
  );
  releaseImpact?.({
    status: 200,
    body: { activityId: record.id, digest: impactDigest, courses: [], total: 0 },
    traceId: null,
  });
  await waitFor(() => expect(confirmButton).toBeEnabled());
});

it('cannot be confirmed when the affected-course check failed, and can be retried', async () => {
  let attempts = 0;
  const transport = {
    request: vi.fn(
      async (input: Parameters<AuthenticatedTransport['request']>[0]): Promise<Reply> => {
        if (!input.path.endsWith('/deletion-impact'))
          return { status: 204, body: null, traceId: null };
        attempts += 1;
        return attempts === 1
          ? { status: 503, body: null, traceId: null }
          : {
              status: 200,
              body: { activityId: record.id, digest: impactDigest, courses: [], total: 0 },
              traceId: null,
            };
      },
    ),
  };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ActivityDelete
        current={record}
        selected={record.id}
        transport={transport}
        scope={scope}
        onDeleted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: '이 활동 로컬 삭제' }));
  await screen.findByRole('alert');
  const confirmButton = screen.getByRole('button', { name: '이 활동 삭제 확인' });
  expect(confirmButton).toBeDisabled();
  await userEvent.click(confirmButton);
  expect(transport.request.mock.calls.filter(([input]) => input.method === 'DELETE')).toHaveLength(
    0,
  );
  await userEvent.click(screen.getByRole('button', { name: '영향 코스 다시 확인' }));
  await waitFor(() => expect(confirmButton).toBeEnabled());
});

it('refreshes the list and asks again when the server says it changed', async () => {
  let impactCalls = 0;
  const transport = {
    request: vi.fn(
      async (input: Parameters<AuthenticatedTransport['request']>[0]): Promise<Reply> => {
        if (input.path.endsWith('/deletion-impact')) {
          impactCalls += 1;
          return {
            status: 200,
            body:
              impactCalls === 1
                ? { activityId: record.id, digest: impactDigest, courses: [], total: 0 }
                : {
                    activityId: record.id,
                    digest: 'b'.repeat(64),
                    courses: [
                      {
                        courseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                        name: '다른 탭에서 만든 코스',
                        headRevision: 1,
                      },
                    ],
                    total: 1,
                  },
            traceId: null,
          };
        }
        return { status: 409, body: { error: { code: 'COURSE_IMPACT_CHANGED' } }, traceId: null };
      },
    ),
  };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ActivityDelete
        current={record}
        selected={record.id}
        transport={transport}
        scope={scope}
        onDeleted={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const user = await confirm();
  expect(await screen.findByText(/코스 목록이 바뀌었습니다/)).toBeInTheDocument();
  const impact = await screen.findByRole('region', { name: '삭제 영향 코스' });
  await waitFor(() => expect(impact).toHaveTextContent('다른 탭에서 만든 코스'));
  // The refreshed list is what the next confirmation carries.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '이 활동 삭제 확인' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: '이 활동 삭제 확인' }));
  await waitFor(() =>
    expect(
      transport.request.mock.calls.filter(([input]) => input.method === 'DELETE'),
    ).toHaveLength(2),
  );
  expect(
    transport.request.mock.calls.filter(([input]) => input.method === 'DELETE')[1]?.[0].body,
  ).toEqual({ expectedRevision: 1, expectedCourseImpact: 'b'.repeat(64) });
});
