import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { transportReplySchema, type TransportRequest } from '@workout/contracts/core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import { sessionCompletionListSchema } from '@workout/contracts/session-completion';
import { PlanningWorkspace } from '../src/planning-workspace';

const head = planSnapshotSchema.parse({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  version: 1,
  createdAt: '2026-09-01T00:00:00Z',
  draft: {
    title: 'Completion workspace',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: level,
      startDate: '2080-01-01',
      endDateExclusive: '2080-02-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
    })),
    sessions: [
      {
        id: 'run',
        blockId: 'block',
        date: '2080-01-03',
        localStartTime: null,
        title: 'Reported run',
        sport: 'running',
        durationSeconds: null,
        distanceMeters: null,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
    ],
  },
});
const list = sessionCompletionListSchema.parse({
  currentPlanVersionId: head.id,
  collectionRevision: 1,
  items: [
    {
      sessionId: 'run',
      revision: 1,
      planVersionId: head.id,
      schedule: { blockId: 'block', date: '2080-01-03', localStartTime: null, timezone: 'UTC' },
      status: 'completed',
      reportedAt: '2026-09-17T00:00:00Z',
      reason: null,
      source: 'user',
      method: 'self_report',
      definitionVersion: 'session-completion-v1',
    },
  ],
});
function setup(readList: () => Promise<unknown>) {
  const request = vi.fn(async (input: TransportRequest) => {
    let body: unknown;
    if (input.path === '/bff/v1/plans/current/session-completions') body = await readList();
    else if (input.path === '/bff/v1/plans/current') body = { head, history: [] };
    else if (input.path.startsWith('/bff/v1/activities?')) body = { items: [], total: 0 };
    else return transportReplySchema.parse({ status: 404, body: {}, traceId: null });
    return transportReplySchema.parse({ status: 200, body, traceId: null });
  });
  render(
    <PlanningWorkspace
      athleteId="athlete"
      sessionId="auth"
      transport={{ request }}
      search="lens=calendar&from=2080-01-01&to=2080-02-01&plannedSession=run"
      onSearchChange={() => {}}
      today="2080-01-01"
    />,
  );
  return request;
}

describe('completion scheduling guards in planning workspace', () => {
  it('protects saved completion schedules while allowing content edits without changing reports', async () => {
    const user = userEvent.setup();
    const request = setup(async () => list);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    await waitFor(() => expect(screen.getByLabelText('세션 날짜')).toBeDisabled());
    expect(screen.getByLabelText('계획 시간대')).toBeDisabled();
    expect(screen.getByRole('button', { name: '세션 삭제' })).toBeDisabled();
    expect(screen.getByLabelText('세션 제목')).toBeEnabled();
    await user.type(screen.getByLabelText('세션 제목'), ' content edit');
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    expect(screen.getByRole('button', { name: '확인하고 계획 버전 저장' })).toBeEnabled();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('blocks a prepared schedule change when a late completion read arrives, without discarding the draft', async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => {};
    const pending = new Promise<unknown>((done) => {
      resolve = done;
    });
    const request = setup(() => pending);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    fireEvent.change(screen.getByLabelText('세션 날짜'), { target: { value: '2080-01-04' } });
    await user.click(screen.getByRole('button', { name: '변경 미리보기' }));
    await act(async () => resolve(list));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '확인하고 계획 버전 저장' })).toBeDisabled(),
    );
    expect(screen.getByText(/초안이 사용자 완료 확인으로 고정된 일정과 충돌/)).toBeVisible();
    expect(screen.getByLabelText('세션 날짜')).toHaveValue('2080-01-04');
    await user.click(screen.getByRole('button', { name: '편집으로 돌아가기' }));
    await user.click(screen.getByRole('button', { name: '실행 취소' }));
    expect(screen.getByLabelText('세션 날짜')).toHaveValue('2080-01-03');
    expect(screen.getByLabelText('세션 날짜')).toBeDisabled();
    expect(screen.getByRole('button', { name: '변경 미리보기' })).toBeEnabled();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});
