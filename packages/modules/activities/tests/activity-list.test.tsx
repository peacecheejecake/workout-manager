import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostContext, AuthenticatedTransport } from '@workout/contracts/core';
import { WorkspaceProvider } from '@workout/platform/provider';
import { ActivityList } from '../src/activity-list.js';
const unavailable = { state: 'unavailable', reason: 'M0 fixture' } as const;
function host(transport: AuthenticatedTransport): HostContext {
  return {
    environment: 'web',
    navigate: () => {},
    openExternal: async () => {},
    onForeground: () => () => {},
    capabilities: {
      'healthkit.read': unavailable,
      'healthkit.background': unavailable,
      'media.pick': unavailable,
      'share.native': unavailable,
      haptics: unavailable,
      'notifications.native': unavailable,
    },
    transport,
  };
}
function view(transport: AuthenticatedTransport, sessionId = 'fixture-a') {
  return (
    <WorkspaceProvider
      host={host(transport)}
      userId="fixture-user"
      workspaceId="activities"
      sessionId={sessionId}
    >
      <ActivityList />
    </WorkspaceProvider>
  );
}
describe('shared ActivityList', () => {
  it('renders loading then injected fixture data with unknown and zero durations preserved', async () => {
    const transport = {
      request: vi.fn(async () => ({
        status: 200,
        traceId: null,
        body: {
          items: [
            {
              id: 'a',
              title: 'Unknown duration',
              startedAt: '2026-09-16T00:00:00Z',
              durationSeconds: null,
              source: 'fixture',
            },
            {
              id: 'b',
              title: 'Zero duration',
              startedAt: '2026-09-16T01:00:00Z',
              durationSeconds: 0,
              source: 'fixture',
            },
          ],
        },
      })),
    };
    render(view(transport));
    expect(screen.getByRole('status')).toHaveTextContent('불러오는 중');
    expect(await screen.findByText('Unknown duration')).toBeVisible();
    expect(screen.getByText('시간 미확인')).toBeVisible();
    expect(screen.getByText('0초')).toBeVisible();
  });
  it('retains a draft on error and retries without approving or writing an activity', async () => {
    const request = vi
      .fn<AuthenticatedTransport['request']>()
      .mockResolvedValueOnce({
        status: 503,
        body: { message: 'private provider payload' },
        traceId: null,
      })
      .mockResolvedValue({ status: 200, body: { items: [] }, traceId: null });
    render(view({ request }));
    fireEvent.change(screen.getByLabelText('작업 메모 (임시)'), { target: { value: '연습 메모' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('활동을 불러오지 못했습니다.');
    expect(screen.queryByText('private provider payload')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('아직 활동이 없습니다.')).toBeVisible();
    expect(screen.getByLabelText('작업 메모 (임시)')).toHaveValue('연습 메모');
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
  it('replaces the fake transport and clears prior workspace state with a new session', async () => {
    const populated = {
      request: async () => ({
        status: 200,
        traceId: null,
        body: {
          items: [
            {
              id: 'a',
              title: 'First session',
              startedAt: '2026-09-16T00:00:00Z',
              durationSeconds: null,
              source: 'fixture',
            },
          ],
        },
      }),
    };
    const empty = { request: async () => ({ status: 200, traceId: null, body: { items: [] } }) };
    const rendered = render(view(populated));
    expect(await screen.findByText('First session')).toBeVisible();
    fireEvent.change(screen.getByLabelText('작업 메모 (임시)'), { target: { value: 'private' } });
    rendered.rerender(view(empty, 'fixture-b'));
    expect(screen.queryByText('First session')).not.toBeInTheDocument();
    expect(screen.getByLabelText('작업 메모 (임시)')).toHaveValue('');
    expect(await screen.findByText('아직 활동이 없습니다.')).toBeVisible();
  });
});
