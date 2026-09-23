import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const sessionEditor = () => within(screen.getByRole('region', { name: '계획 세션 초안' }));
const draftEditor = () => within(screen.getByRole('region', { name: '계획 초안' }));
const preview = () => within(screen.getByRole('region', { name: '변경 미리보기' }));
function setup(
  readList: () => Promise<unknown>,
  saved = head,
  search = 'lens=calendar&from=2080-01-01&to=2080-02-01&plannedSession=run',
) {
  const request = vi.fn(async (input: TransportRequest) => {
    let body: unknown;
    if (input.path === '/bff/v1/plans/current/session-completions') body = await readList();
    else if (input.path === '/bff/v1/plans/current') body = { head: saved, history: [] };
    else if (input.path.startsWith('/bff/v1/activities?')) body = { items: [], total: 0 };
    else return transportReplySchema.parse({ status: 404, body: {}, traceId: null });
    return transportReplySchema.parse({ status: 200, body, traceId: null });
  });
  render(
    <PlanningWorkspace
      athleteId="athlete"
      sessionId="auth"
      transport={{ request }}
      search={search}
      onSearchChange={() => {}}
      today="2080-01-01"
    />,
  );
  return request;
}

describe('completion scheduling guards in planning workspace', () => {
  it('shows authoritative table report states without dropping the draft or treating failed reads as missing reports', async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => {};
    let read = () =>
      new Promise<unknown>((done) => {
        resolve = done;
      });
    const request = setup(
      () => read(),
      head,
      'lens=calendar&from=2080-01-01&to=2080-02-01&plannedView=table&plannedColumns=completion&plannedSession=run',
    );
    const table = within(await screen.findByRole('table', { name: '계획 세션 표' }));
    expect(table.getByText('완료 보고 조회 중')).toBeVisible();
    await act(async () => resolve(list));
    await table.findByText('사용자 완료 확인');
    await user.click(screen.getByRole('button', { name: '계획 초안 편집' }));
    await user.type(sessionEditor().getByLabelText('세션 메모'), '유지할 초안');
    read = async () => {
      throw new Error('offline');
    };
    await user.click(screen.getByRole('button', { name: '완료 상태 다시 확인' }));
    await table.findByText('완료 보고 조회 실패');
    expect(table.queryByText('사용자 완료 확인')).not.toBeInTheDocument();
    expect(table.queryByText('완료 확인 기록 없음')).not.toBeInTheDocument();
    read = async () => ({ ...list, currentPlanVersionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    await user.click(screen.getByRole('button', { name: '완료 상태 다시 확인' }));
    await table.findByText('완료 보고 버전 불일치');
    read = async () => ({
      ...list,
      collectionRevision: 2,
      items: list.items.map((item) => ({
        ...item,
        status: 'retracted',
        revision: 2,
        reason: '명시 철회',
      })),
    });
    await user.click(screen.getByRole('button', { name: '완료 상태 다시 확인' }));
    await table.findByText('완료 확인 철회');
    expect(sessionEditor().getByLabelText('세션 메모')).toHaveValue('유지할 초안');
    expect(table.getByRole('button', { name: '계획: Reported run' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
  it('applies a reviewed period move as one undo step while completed sessions stay fixed', async () => {
    const user = userEvent.setup();
    const saved = structuredClone(head);
    saved.draft.periods = saved.draft.periods.map((period) =>
      period.level === 'block'
        ? period
        : { ...period, startDate: '2079-12-01', endDateExclusive: '2080-03-01' },
    );
    const request = setup(async () => list, saved, 'lens=period&period=block&plannedSession=run');
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    const panel = within(screen.getByRole('region', { name: '기간 날짜 이동' }));
    fireEvent.change(panel.getByLabelText('이동할 기간 시작일'), {
      target: { value: '2080-01-02' },
    });
    await user.click(panel.getByRole('radio', { name: '자식 기간과 세션 함께 이동' }));
    await user.click(panel.getByRole('button', { name: '기간 이동 영향 확인' }));
    const block = within(screen.getByRole('group', { name: 'block: block' }));
    expect(block.getByLabelText('기간 시작일')).toHaveValue('2080-01-01');
    await user.click(panel.getByRole('button', { name: '확인하고 기간 이동 초안 적용' }));
    expect(block.getByLabelText('기간 시작일')).toHaveValue('2080-01-02');
    expect(block.getByLabelText('기간 종료일 (미포함)')).toHaveValue('2080-02-02');
    expect(sessionEditor().getByLabelText('세션 날짜')).toHaveValue('2080-01-03');
    await user.click(draftEditor().getByRole('button', { name: '실행 취소' }));
    expect(block.getByLabelText('기간 시작일')).toHaveValue('2080-01-01');
    expect(block.getByLabelText('기간 종료일 (미포함)')).toHaveValue('2080-02-01');
    expect(sessionEditor().getByLabelText('세션 날짜')).toBeDisabled();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });

  it('does not prepare period movement when completion records are unavailable', async () => {
    const user = userEvent.setup();
    setup(
      async () => {
        throw new Error('offline');
      },
      head,
      'lens=period&period=block',
    );
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    const panel = within(screen.getByRole('region', { name: '기간 날짜 이동' }));
    expect(panel.getByRole('button', { name: '기간 이동 영향 확인' })).toBeDisabled();
    expect(
      panel.queryByRole('button', { name: '확인하고 기간 이동 초안 적용' }),
    ).not.toBeInTheDocument();
  });
  it('protects saved completion schedules while allowing content edits without changing reports', async () => {
    const user = userEvent.setup();
    const request = setup(async () => list);
    await user.click(await screen.findByRole('button', { name: '계획 초안 편집' }));
    await waitFor(() => expect(sessionEditor().getByLabelText('세션 날짜')).toBeDisabled());
    expect(draftEditor().getByLabelText('계획 시간대')).toBeDisabled();
    expect(sessionEditor().getByRole('button', { name: '세션 삭제' })).toBeDisabled();
    expect(sessionEditor().getByLabelText('세션 제목')).toBeEnabled();
    await user.type(sessionEditor().getByLabelText('세션 제목'), ' content edit');
    await user.click(draftEditor().getByRole('button', { name: '변경 미리보기' }));
    expect(preview().getByRole('button', { name: '확인하고 계획 버전 저장' })).toBeEnabled();
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
    fireEvent.change(sessionEditor().getByLabelText('세션 날짜'), {
      target: { value: '2080-01-04' },
    });
    await user.click(draftEditor().getByRole('button', { name: '변경 미리보기' }));
    await act(async () => resolve(list));
    await waitFor(() =>
      expect(preview().getByRole('button', { name: '확인하고 계획 버전 저장' })).toBeDisabled(),
    );
    expect(screen.getByText(/초안이 사용자 완료 확인으로 고정된 일정과 충돌/)).toBeVisible();
    expect(sessionEditor().getByLabelText('세션 날짜')).toHaveValue('2080-01-04');
    await user.click(preview().getByRole('button', { name: '편집으로 돌아가기' }));
    await user.click(draftEditor().getByRole('button', { name: '실행 취소' }));
    expect(sessionEditor().getByLabelText('세션 날짜')).toHaveValue('2080-01-03');
    expect(sessionEditor().getByLabelText('세션 날짜')).toBeDisabled();
    expect(draftEditor().getByRole('button', { name: '변경 미리보기' })).toBeEnabled();
    expect(request.mock.calls.every(([input]) => input.method === 'GET')).toBe(true);
  });
});
