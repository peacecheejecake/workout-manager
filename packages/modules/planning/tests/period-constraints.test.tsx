import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useStore } from 'zustand';
import { describe, expect, it } from 'vitest';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import { PeriodConstraintsEditor } from '../src/period-constraints-editor';
import { PlanConstraintsReport, PeriodConstraintsSummary } from '../src/period-constraints-summary';
import { PlanSummary } from '../src/plan-summary';
import { createPlanningDraftStore } from '../src/draft-store';
import { validationGuidance } from '../src/validation-guidance';
const draft: PlanDraft = {
  title: '봄 시즌',
  timezone: 'Asia/Seoul',
  periods: [
    {
      id: 'season',
      parentId: null,
      level: 'season',
      title: '시즌',
      startDate: '2026-09-01',
      endDateExclusive: '2026-12-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'wave',
      parentId: 'season',
      level: 'wave',
      title: '웨이브',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'phase',
      parentId: 'wave',
      level: 'phase',
      title: '페이즈',
      startDate: '2026-09-01',
      endDateExclusive: '2026-10-01',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
    {
      id: 'block',
      parentId: 'phase',
      level: 'block',
      title: '10일 Block',
      startDate: '2026-09-01',
      endDateExclusive: '2026-09-11',
      timezone: 'Asia/Seoul',
      intent: '기반',
      isPartial: false,
    },
  ],
  sessions: [
    {
      id: 'session-1',
      blockId: 'block',
      date: '2026-09-09',
      localStartTime: null,
      title: '쉬운 달리기',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: null,
      purpose: '가볍게',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    },
  ],
};

function setup(value = draft) {
  const store = createPlanningDraftStore(() => 'fixed-preview');
  store.getState().actions.start(null, value);
  function Host() {
    const current = useStore(store, (state) => state.state.draft);
    const period = current?.periods.find((item) => item.id === 'block');
    return period ? (
      <PeriodConstraintsEditor
        period={period}
        onChange={(constraints) =>
          store.getState().actions.edit((previous) => ({
            ...previous,
            periods: previous.periods.map((item) =>
              item.id === 'block' ? { ...item, constraints } : item,
            ),
          }))
        }
      />
    ) : null;
  }
  return { ...render(<Host />), store };
}
describe('period constraint editing and assessment', () => {
  it('does not convert blank availability to zero, validates dates/duplicates and preserves absent legacy fields until adding', async () => {
    const user = userEvent.setup();
    const { store } = setup();
    expect(
      store
        .getState()
        .state.draft?.periods.every((period) => !Object.hasOwn(period, 'constraints')),
    ).toBe(true);
    fireEvent.change(screen.getByLabelText('가용 시간 날짜'), { target: { value: '2026-09-09' } });
    await user.click(screen.getByRole('button', { name: '가용 시간 추가' }));
    expect(screen.getByRole('alert')).toHaveTextContent('빈칸은 0이 아닙니다');
    expect(store.getState().state.draft?.periods[3]).not.toHaveProperty('constraints');
    await user.type(screen.getByLabelText('운동 가능 시간 (초)'), '0');
    await user.click(screen.getByRole('button', { name: '가용 시간 추가' }));
    expect(store.getState().state.draft?.periods[3]?.constraints?.dailyTimeLimits).toEqual([
      { date: '2026-09-09', availableSeconds: 0 },
    ]);
    fireEvent.change(screen.getByLabelText('가용 시간 날짜'), { target: { value: '2026-09-09' } });
    await user.click(screen.getByRole('button', { name: '가용 시간 추가' }));
    expect(screen.getByRole('alert')).toHaveTextContent('같은 날짜가 이미 있습니다');
    fireEvent.change(screen.getByLabelText('운동 불가 날짜'), { target: { value: '2026-09-11' } });
    await user.click(screen.getByRole('button', { name: '운동 불가 날짜 추가' }));
    expect(screen.getByRole('alert')).toHaveTextContent('종료일 전날');
    expect(store.getState().state.draft?.sessions).toEqual(draft.sessions);
    expect(store.getState().state.preview).toBeNull();
  });
  it('edits exact seconds directly in the undoable draft while retaining the field and focus', () => {
    const value = {
      ...draft,
      periods: draft.periods.map((period) =>
        period.id === 'block'
          ? {
              ...period,
              constraints: {
                unavailableDates: [],
                dailyTimeLimits: [{ date: '2026-09-09', availableSeconds: 3671 }],
              },
            }
          : period,
      ),
    };
    const { store } = setup(value);
    const input = screen.getByLabelText('2026-09-09 운동 가능 시간 (초)');
    input.focus();
    fireEvent.change(input, { target: { value: '' } });
    expect(store.getState().actions.preview()).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('빈칸은 0이 아닙니다');
    act(() => store.getState().actions.undo());
    expect(input).toBe(screen.getByLabelText('2026-09-09 운동 가능 시간 (초)'));
    expect(input).toHaveValue(3671);
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '3601' } });
    act(() => {
      expect(store.getState().actions.preview()).toBe(true);
    });
    expect(
      store.getState().state.preview?.draft.periods[3]?.constraints?.dailyTimeLimits[0]
        ?.availableSeconds,
    ).toBe(3601);
    expect(store.getState().state.draft?.sessions).toEqual(draft.sessions);
  });
  it('deletes direct rows and clears explicitly without altering inherited constraints', async () => {
    const user = userEvent.setup();
    const value = {
      ...draft,
      periods: draft.periods.map((period) => ({
        ...period,
        constraints: { unavailableDates: ['2026-09-09'], dailyTimeLimits: [] },
      })),
    };
    const { store } = setup(value);
    await user.click(screen.getByRole('button', { name: '2026-09-09 운동 불가 날짜 삭제' }));
    expect(screen.getByRole('button', { name: '운동 불가 날짜 추가' })).toHaveFocus();
    expect(store.getState().state.draft?.periods[0]?.constraints?.unavailableDates).toEqual([
      '2026-09-09',
    ]);
    await user.click(screen.getByRole('button', { name: '이 기간의 직접 제약 모두 해제' }));
    expect(store.getState().state.draft?.periods[3]?.constraints).toEqual({
      unavailableDates: [],
      dailyTimeLimits: [],
    });
    expect(store.getState().state.draft?.periods[0]?.constraints).toEqual(
      value.periods[0]?.constraints,
    );
  });
  it('shows inherited minimum budgets, known sums, unknown counts and conflicts without changing a valid plan', () => {
    const base = draft.sessions[0];
    if (!base) throw new Error('Missing fixture');
    const value = {
      ...draft,
      periods: draft.periods.map((period) =>
        period.id === 'season'
          ? {
              ...period,
              constraints: {
                unavailableDates: ['2026-09-09'],
                dailyTimeLimits: [
                  { date: '2026-09-09', availableSeconds: 400 },
                  { date: '2026-09-10', availableSeconds: 500 },
                ],
              },
            }
          : period.id === 'block'
            ? {
                ...period,
                constraints: {
                  unavailableDates: [],
                  dailyTimeLimits: [
                    { date: '2026-09-09', availableSeconds: 250 },
                    { date: '2026-09-10', availableSeconds: 0 },
                  ],
                },
              }
            : period,
      ),
      sessions: [
        { ...base, id: 'a', durationSeconds: 120 },
        { ...base, id: 'b', durationSeconds: 180 },
        {
          ...base,
          id: 'c',
          date: '2026-09-10',
          durationSeconds: null,
          steps: [
            {
              id: 'step',
              kind: 'work' as const,
              durationSeconds: 600,
              distanceMeters: null,
              repetitions: 3,
            },
          ],
        },
        { ...base, id: 'd', date: '2026-09-10', durationSeconds: 0 },
      ],
    };
    const before = structuredClone(value);
    render(<PlanConstraintsReport plan={value} periodId="block" />);
    const conflict = screen.getByRole('listitem', { name: '제약 날짜 2026-09-09' });
    expect(conflict).toHaveAttribute('data-status', 'conflict');
    expect(conflict).toHaveTextContent('알려진 계획 시간 300초');
    expect(conflict).toHaveTextContent('적용 가용량 250초');
    expect(conflict).toHaveTextContent('상위 기간에서 적용');
    const unknown = screen.getByRole('listitem', { name: '제약 날짜 2026-09-10' });
    expect(unknown).toHaveAttribute('data-status', 'unknown');
    expect(unknown).toHaveTextContent('알려진 계획 시간 0초');
    expect(unknown).toHaveTextContent('시간 미정 세션 1개');
    expect(unknown).toHaveTextContent('적용 가용량 0초');
    expect(screen.getByText(/충돌이 있어도 수동 계획은 확인 후 저장/)).toBeVisible();
    expect(value).toEqual(before);
  });
  it('keeps out-of-range constraints after period shrink and explains why preview cannot proceed', () => {
    const value = {
      ...draft,
      periods: draft.periods.map((period) =>
        period.id === 'block'
          ? {
              ...period,
              endDateExclusive: '2026-09-09',
              constraints: { unavailableDates: ['2026-09-09'], dailyTimeLimits: [] },
            }
          : period,
      ),
    };
    const parsed = planDraftSchema.safeParse(value);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues.map(validationGuidance).join(' ')).toContain(
        '기간 축소 시 조건을 자동 삭제하지 않습니다',
      );
    render(
      <>
        <PlanConstraintsReport plan={value} />
        <PlanSummary draft={value} />
      </>,
    );
    expect(screen.getByText(/초안 입력 오류로 제약을 판정할 수 없습니다/)).toBeVisible();
    const summary = screen.getByText('직접 제약: 운동 불가 1일 · 가용 시간 0일');
    expect(summary).toBeVisible();
    expect(value.periods[3]?.constraints?.unavailableDates).toEqual(['2026-09-09']);
  });
  it('distinguishes legacy absence from explicit empty constraints and preserves exact values in summaries', () => {
    render(
      <>
        <section aria-label="이전">
          <PeriodConstraintsSummary constraints={undefined} />
        </section>
        <section aria-label="이후">
          <PeriodConstraintsSummary constraints={{ unavailableDates: [], dailyTimeLimits: [] }} />
        </section>
      </>,
    );
    expect(
      within(screen.getByRole('region', { name: '이전' })).getByText(/이전 형식에 값 없음/),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '이후' })).getByText(/명시적으로 비움/),
    ).toBeVisible();
  });
});
