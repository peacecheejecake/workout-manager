import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { Activity } from '@workout/contracts/activity';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { HealthKitReviewPanel } from '../src/healthkit-review-panel';

const sampleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const activityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const item = {
  sampleId,
  expectedSampleDigest: 'a'.repeat(64),
  kind: 'running',
  observedFrom: '2026-09-28T06:00:00Z',
  observedTo: '2026-09-28T06:35:00Z',
  durationSeconds: 2100,
  distanceMeters: 0,
};
const values = {
  title: '기존 운동',
  kind: 'running' as const,
  startedAt: '2026-09-28T06:00:00Z',
  timezone: null,
  durationSeconds: 2100,
  durationKind: 'elapsed' as const,
  distanceMeters: 0,
};
const existing: Activity = {
  id: activityId,
  revision: 2,
  source: { kind: 'fit', sourceId: 'fit-one', revision: 1, contentHash: 'b'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};

function setup(
  reply: (
    input: Parameters<AuthenticatedTransport['request']>[0],
  ) => ReturnType<AuthenticatedTransport['request']>,
  selectedActivity: Activity | null = null,
) {
  const request = vi.fn(reply);
  const onActivityChosen = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HealthKitReviewPanel
        transport={{ request }}
        scope={['users', 'alice', 'sessions', 'one', 'activity-browser']}
        selectedActivity={selectedActivity}
        onActivityChosen={onActivityChosen}
      />
    </QueryClientProvider>,
  );
  return { request, onActivityChosen };
}

it('keeps raw review out of totals until the user explicitly confirms a new activity', async () => {
  const user = userEvent.setup();
  const { request, onActivityChosen } = setup(async (input) => {
    if (input.method === 'GET') return { status: 200, body: { items: [item] }, traceId: null };
    return {
      status: 200,
      body: { sampleId, activityId, activityRevision: 1, state: 'created_activity' },
      traceId: null,
    };
  });
  expect(request).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '검토할 운동 확인' }));
  await screen.findByRole('radio', { name: /달리기.*거리 0m/ });
  expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  await user.click(screen.getByRole('radio', { name: /달리기.*거리 0m/ }));
  expect(screen.getByRole('button', { name: '새 활동 기록 확정' })).toBeDisabled();
  await user.click(
    screen.getByRole('checkbox', { name: '선택한 원본과 처리 방법을 확인했습니다.' }),
  );
  await user.click(screen.getByRole('button', { name: '새 활동 기록 확정' }));
  await waitFor(() => expect(onActivityChosen).toHaveBeenCalledWith(activityId));
  expect(request.mock.calls.find(([input]) => input.method === 'POST')?.[0].body).toMatchObject({
    sampleId,
    expectedSampleDigest: item.expectedSampleDigest,
    confirmed: true,
  });
});

it('links only to the selected live FIT activity with its exact revision and retries uncertain writes', async () => {
  const user = userEvent.setup();
  let writes = 0;
  const { request, onActivityChosen } = setup(async (input) => {
    if (input.method === 'GET') return { status: 200, body: { items: [item] }, traceId: null };
    writes += 1;
    if (writes === 1) throw new Error('lost reply');
    return {
      status: 200,
      body: { sampleId, activityId, activityRevision: 2, state: 'linked_existing' },
      traceId: null,
    };
  }, existing);
  await user.click(screen.getByRole('button', { name: '검토할 운동 확인' }));
  await user.click(await screen.findByRole('radio', { name: /달리기.*거리 0m/ }));
  await user.click(screen.getByRole('radio', { name: '기존 활동에 보조 출처로 연결' }));
  await user.click(
    screen.getByRole('checkbox', { name: '선택한 원본과 처리 방법을 확인했습니다.' }),
  );
  await user.click(screen.getByRole('button', { name: '기존 활동 연결 확정' }));
  await user.click(await screen.findByRole('button', { name: '같은 요청 재시도' }));
  await waitFor(() => expect(onActivityChosen).toHaveBeenCalledWith(activityId));
  const writesSent = request.mock.calls.filter(([input]) => input.method === 'POST');
  expect(writesSent).toHaveLength(2);
  expect(writesSent[0]?.[0].body).toEqual(writesSent[1]?.[0].body);
  expect(writesSent[0]?.[0].body).toMatchObject({
    targetActivityId: activityId,
    expectedActivityRevision: 2,
  });
});
