import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import type { SessionCompletion } from '@workout/contracts/session-completion';
import { PeriodMovePanel, type PeriodMovePanelProps } from '../src/period-move-panel';

function fixture(): PlanDraft {
  return planDraftSchema.parse({
    title: 'Synthetic move plan',
    timezone: 'UTC',
    periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
      id: level,
      parentId: index === 0 ? null : levels[index - 1],
      level,
      title: `기간 ${level}`,
      startDate: level === 'block' ? '2026-09-10' : '2026-09-01',
      endDateExclusive: level === 'block' ? '2026-09-20' : '2026-10-01',
      timezone: 'UTC',
      intent: '',
      isPartial: false,
      ...(level === 'block'
        ? {
            constraints: {
              unavailableDates: ['2026-09-12'],
              dailyTimeLimits: [{ date: '2026-09-12', availableSeconds: 250 }],
            },
          }
        : {}),
    })),
    sessions: [
      {
        id: 'moving',
        title: '이동 가능',
        date: '2026-09-11',
        durationSeconds: 300,
        distanceMeters: null,
      },
      {
        id: 'locked',
        title: '날짜 잠금 세션',
        date: '2026-09-12',
        durationSeconds: 0,
        distanceMeters: 0,
      },
      {
        id: 'completed',
        title: '완료 세션',
        date: '2026-09-13',
        durationSeconds: null,
        distanceMeters: null,
      },
    ].map((session) => ({
      ...session,
      blockId: 'block',
      localStartTime: null,
      sport: 'running',
      targetRpe: null,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: session.id === 'locked', time: false, intensity: false },
      steps: [],
    })),
  });
}
const completion: SessionCompletion = {
  sessionId: 'completed',
  revision: 1,
  planVersionId: '11111111-1111-4111-8111-111111111111',
  schedule: { blockId: 'block', date: '2026-09-13', localStartTime: null, timezone: 'UTC' },
  status: 'completed',
  reportedAt: '2026-09-17T00:00:00Z',
  reason: null,
  source: 'user',
  method: 'self_report',
  definitionVersion: 'session-completion-v1',
};
function setup(overrides: Partial<PeriodMovePanelProps> = {}) {
  const draft = fixture();
  const onApply = vi.fn<(next: PlanDraft) => void>();
  const props: PeriodMovePanelProps = {
    draft,
    baseline: draft,
    completionState: { status: 'ready', reports: [completion], revision: 'saved:1' },
    selectedPeriodId: 'block',
    onApply,
    ...overrides,
  };
  const view = (patch: Partial<PeriodMovePanelProps> = {}) => (
    <PeriodMovePanel {...props} {...patch} />
  );
  return { ...render(view()), view, props, onApply };
}
const date = () => screen.getByLabelText('이동할 기간 시작일');
const trigger = () => screen.getByRole('button', { name: '기간 이동 영향 확인' });
const review = () => screen.getByRole('group', { name: '기간 이동 영향 검토' });
const apply = () => screen.getByRole('button', { name: '확인하고 기간 이동 초안 적용' });
async function prepare(
  user: ReturnType<typeof userEvent.setup>,
  start = '2026-09-11',
  scope = '자식 기간과 세션 함께 이동',
) {
  fireEvent.change(date(), { target: { value: start } });
  await user.click(screen.getByRole('radio', { name: scope }));
  await user.click(trigger());
}

describe('period move impact review', () => {
  it('requires an explicit scope and date, previews fixed IDs and absolute-date constraints, then applies exactly one draft', async () => {
    const app = setup();
    const original = structuredClone(app.props.draft);
    const user = userEvent.setup();
    expect(
      screen
        .getAllByRole('radio')
        .every((radio) => !(radio instanceof HTMLInputElement) || !radio.checked),
    ).toBe(true);
    await user.click(trigger());
    expect(screen.getByRole('alert')).toHaveTextContent('시작일과 이동 범위를 직접 선택');
    fireEvent.change(date(), { target: { value: '2026-09-11' } });
    await user.click(trigger());
    expect(app.onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: '자식 기간과 세션 함께 이동' }));
    await user.click(trigger());
    expect(review()).toHaveTextContent('기간 1개 · 이동 세션 1개 · 고정 세션 2개');
    expect(within(review()).getByRole('button', { name: '기간 이동 검토 취소' })).toHaveFocus();
    expect(within(review()).getByRole('region', { name: '고정된 세션' })).toHaveTextContent(
      '날짜 잠금 세션 · 2026-09-12 · 날짜 잠금으로 고정',
    );
    expect(within(review()).getByRole('region', { name: '고정된 세션' })).toHaveTextContent(
      '완료 세션 · 2026-09-13 · 완료 확인으로 고정',
    );
    expect(within(review()).getByRole('region', { name: '이동할 세션 전후' })).toHaveTextContent(
      '이동 가능 · 2026-09-11 → 2026-09-12',
    );
    const constraint = within(review()).getByRole('listitem', { name: '제약 날짜 2026-09-12' });
    expect(constraint).toHaveAttribute('data-status', 'conflict');
    expect(constraint).toHaveTextContent('알려진 계획 시간 300초');
    expect(constraint).toHaveTextContent('적용 가용량 250초');
    expect(app.onApply).not.toHaveBeenCalled();
    expect(app.props.draft).toEqual(original);
    app.onApply.mockImplementation((next) => app.rerender(app.view({ draft: next })));
    await user.click(apply());
    expect(app.onApply).toHaveBeenCalledTimes(1);
    const candidate = app.onApply.mock.calls[0]?.[0];
    expect(candidate?.periods.find((period) => period.id === 'block')).toMatchObject({
      startDate: '2026-09-11',
      endDateExclusive: '2026-09-21',
      constraints: original.periods.find((period) => period.id === 'block')?.constraints,
    });
    expect(candidate?.sessions.find((session) => session.id === 'moving')).toMatchObject({
      date: '2026-09-12',
      durationSeconds: 300,
      distanceMeters: null,
    });
    expect(candidate?.sessions.find((session) => session.id === 'locked')).toEqual(
      original.sessions.find((session) => session.id === 'locked'),
    );
    expect(candidate?.sessions.find((session) => session.id === 'completed')).toEqual(
      original.sessions.find((session) => session.id === 'completed'),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      '초안에 적용했습니다. 아직 저장하지 않았습니다',
    );
    expect(
      screen.queryByRole('button', { name: '확인하고 기간 이동 초안 적용' }),
    ).not.toBeInTheDocument();
    // The host undo restores the exact previous draft reference.
    app.rerender(app.view({ draft: app.props.draft }));
    expect(screen.queryByText(/기간 이동을 초안에 적용했습니다/)).not.toBeInTheDocument();
    if (!candidate) throw new Error('Expected applied candidate');
    app.rerender(app.view({ draft: candidate }));
    expect(screen.queryByText(/기간 이동을 초안에 적용했습니다/)).not.toBeInTheDocument();
  });

  it('cancels review without applying and retains inputs while returning focus to the trigger', async () => {
    const app = setup();
    const user = userEvent.setup();
    await prepare(user);
    await user.click(within(review()).getByRole('button', { name: '기간 이동 검토 취소' }));
    expect(trigger()).toHaveFocus();
    expect(date()).toHaveValue('2026-09-11');
    expect(screen.getByRole('radio', { name: '자식 기간과 세션 함께 이동' })).toBeChecked();
    expect(app.onApply).not.toHaveBeenCalled();
  });

  it.each(['draft', 'baseline', 'revision', 'selection', 'unavailable'] as const)(
    'permanently invalidates a review when %s changes, retaining date and scope',
    async (boundary) => {
      const app = setup();
      const user = userEvent.setup();
      await prepare(user);
      const patch: Partial<PeriodMovePanelProps> =
        boundary === 'draft'
          ? { draft: { ...app.props.draft, title: 'Edited after preview' } }
          : boundary === 'baseline'
            ? { baseline: structuredClone(app.props.baseline) }
            : boundary === 'revision'
              ? { completionState: { status: 'ready', reports: [completion], revision: 'saved:2' } }
              : boundary === 'selection'
                ? { selectedPeriodId: 'phase' }
                : { completionState: { status: 'unavailable' } };
      app.rerender(app.view(patch));
      expect(
        screen.queryByRole('button', { name: '확인하고 기간 이동 초안 적용' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText(/검토 조건이 변경되었습니다/)).toBeVisible();
      app.rerender(app.view());
      expect(
        screen.queryByRole('button', { name: '확인하고 기간 이동 초안 적용' }),
      ).not.toBeInTheDocument();
      expect(date()).toHaveValue('2026-09-11');
      expect(screen.getByRole('radio', { name: '자식 기간과 세션 함께 이동' })).toBeChecked();
      await user.click(trigger());
      expect(apply()).toBeEnabled();
      expect(app.onApply).not.toHaveBeenCalled();
    },
  );

  it('invalidates on local date/scope edits even if their earlier value is restored', async () => {
    const app = setup();
    const user = userEvent.setup();
    await prepare(user);
    fireEvent.change(date(), { target: { value: '2026-09-12' } });
    fireEvent.change(date(), { target: { value: '2026-09-11' } });
    expect(screen.queryByRole('group', { name: '기간 이동 영향 검토' })).not.toBeInTheDocument();
    await user.click(trigger());
    await user.click(screen.getByRole('radio', { name: '이 기간만 이동' }));
    expect(screen.queryByRole('group', { name: '기간 이동 영향 검토' })).not.toBeInTheDocument();
    await user.click(trigger());
    expect(review()).toHaveTextContent('이동 세션 0개 · 고정 세션 3개');
    expect(review()).toHaveTextContent('기간만 이동: 세션 유지');
    expect(app.onApply).not.toHaveBeenCalled();
  });

  it('disables review while completion status is unavailable and requires a selected current period', () => {
    const app = setup({ completionState: { status: 'unavailable' } });
    expect(trigger()).toBeDisabled();
    expect(date()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('최신 완료 상태를 확인할 수 없어');
    app.rerender(app.view({ selectedPeriodId: null }));
    expect(screen.queryByText(/최신 완료 상태를 확인할 수 없어/)).not.toBeInTheDocument();
    expect(screen.getByText('기간 탐색에서 이동할 기간을 선택해 주세요.')).toBeVisible();
    expect(trigger()).toBeDisabled();
    app.rerender(app.view({ selectedPeriodId: 'missing' }));
    expect(trigger()).toBeDisabled();
    expect(app.onApply).not.toHaveBeenCalled();
  });

  it('rejects an absolute constraint date outside the moved period without shifting it', async () => {
    const app = setup();
    await prepare(userEvent.setup(), '2026-09-14');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '고정된 제약 날짜가 이동한 기간 범위를 벗어납니다',
    );
    expect(app.onApply).not.toHaveBeenCalled();
    expect(
      app.props.draft.periods.find((period) => period.id === 'block')?.constraints
        ?.unavailableDates,
    ).toEqual(['2026-09-12']);
  });

  it('rejects completed or locked sessions outside a moved Block instead of releasing protection', async () => {
    const withoutConstraints = fixture();
    withoutConstraints.periods = withoutConstraints.periods.map((period) => ({
      ...period,
      constraints: { unavailableDates: [], dailyTimeLimits: [] },
    }));
    const app = setup({ draft: withoutConstraints, baseline: withoutConstraints });
    await prepare(userEvent.setup(), '2026-09-14');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '완료 확인 또는 날짜가 고정된 세션이 이동한 Block 밖으로',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('완료 확인·잠금을 해제하지 않습니다');
    expect(app.onApply).not.toHaveBeenCalled();
  });

  it('treats unchanged dates as a no-op and never applies an invalid draft', async () => {
    const app = setup();
    const user = userEvent.setup();
    await prepare(user, '2026-09-10');
    expect(screen.getByRole('status')).toHaveTextContent('이동할 변경이 없습니다');
    app.rerender(app.view({ draft: { ...app.props.draft, title: '' } }));
    fireEvent.change(date(), { target: { value: '2026-09-11' } });
    await user.click(trigger());
    expect(screen.getByRole('alert')).toHaveTextContent('현재 초안에 입력 오류');
    expect(app.onApply).not.toHaveBeenCalled();
  });
});
