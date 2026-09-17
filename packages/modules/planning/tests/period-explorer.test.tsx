import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import { PeriodExplorer } from '../src/period-explorer';
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

describe('period explorer', () => {
  it('shares explicit ring/list selection and breadcrumbs while focus only previews', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    function Host() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <PeriodExplorer
          plan={draft}
          selectedId={selected}
          onCalendar={vi.fn()}
          onSelect={(id) => {
            changed(id);
            setSelected(id);
          }}
        />
      );
    }
    render(<Host />);
    const rootButton = screen.getByRole('button', { name: 'season · 시즌' });
    act(() => rootButton.focus());
    expect(screen.getByRole('complementary', { name: '기간 미리보기' })).toHaveTextContent(
      '미리보기: 시즌',
    );
    expect(changed).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(changed).toHaveBeenLastCalledWith('season');
    expect(
      within(screen.getByRole('region', { name: '현재 선택한 기간' })).getByRole('heading'),
    ).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'phase · 페이즈' })).not.toBeInTheDocument();
    const ring = await screen.findByRole('button', { name: '기간 원형: wave · 웨이브' });
    fireEvent.mouseEnter(ring);
    expect(
      within(screen.getByRole('region', { name: '현재 선택한 기간' })).getByRole('heading'),
    ).toHaveTextContent('시즌');
    expect(changed).toHaveBeenCalledTimes(1);
    act(() => ring.focus());
    await user.keyboard('{Enter}');
    expect(changed).toHaveBeenLastCalledWith('wave');
    await user.click(screen.getByRole('button', { name: '상위 기간으로 돌아가기' }));
    expect(changed).toHaveBeenLastCalledWith('season');
    await user.click(
      within(screen.getByRole('navigation', { name: '기간 경로' })).getByRole('button', {
        name: '전체 계획',
      }),
    );
    expect(changed).toHaveBeenLastCalledWith(null);
  });
  it('keeps focused ring preview when an independently hovered list item leaves', async () => {
    const onSelect = vi.fn();
    const wave = draft.periods.find((period) => period.id === 'wave');
    if (!wave) throw new Error('Missing fixture wave');
    const plan = {
      ...draft,
      periods: [
        ...draft.periods,
        {
          ...wave,
          id: 'wave-b',
          title: '다른 웨이브',
          startDate: wave.endDateExclusive,
          endDateExclusive: '2026-12-01',
        },
      ],
    };
    render(
      <PeriodExplorer plan={plan} selectedId="season" onSelect={onSelect} onCalendar={vi.fn()} />,
    );
    const list = screen.getByRole('button', { name: 'wave · 다른 웨이브' });
    fireEvent.mouseEnter(list);
    expect(screen.getByRole('complementary', { name: '기간 미리보기' })).toHaveTextContent(
      '다른 웨이브',
    );
    const ring = await screen.findByRole('button', { name: '기간 원형: wave · 웨이브' });
    act(() => ring.focus());
    fireEvent.mouseLeave(list);
    expect(screen.getByRole('complementary', { name: '기간 미리보기' })).toHaveTextContent(
      '미리보기: 웨이브',
    );
    expect(ring).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.mouseEnter(list);
    expect(screen.getByRole('complementary', { name: '기간 미리보기' })).toHaveTextContent(
      '미리보기: 웨이브',
    );
    act(() => ring.blur());
    expect(screen.getByRole('complementary', { name: '기간 미리보기' })).toHaveTextContent(
      '다른 웨이브',
    );
  });
  it('ends a child preview when navigating away so back and forward cannot resurrect it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const plan = {
      ...draft,
      periods: draft.periods.map((period) =>
        period.id === 'block' ? { ...period, isPartial: true } : period,
      ),
    };
    const props = { plan, onSelect, onCalendar: vi.fn() };
    const ui = render(<PeriodExplorer {...props} selectedId="phase" />);
    act(() => screen.getByRole('button', { name: 'block · 10일 Block' }).focus());
    expect(screen.getByRole('complementary', { name: '기간 미리보기' })).toHaveTextContent(
      '부분 기간',
    );
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('block');
    ui.rerender(<PeriodExplorer {...props} selectedId="block" />);
    expect(screen.queryByRole('complementary', { name: '기간 미리보기' })).not.toBeInTheDocument();
    ui.rerender(<PeriodExplorer {...props} selectedId="phase" />);
    expect(
      within(screen.getByRole('region', { name: '현재 선택한 기간' })).getByRole('heading'),
    ).toHaveFocus();
    expect(screen.queryByRole('complementary', { name: '기간 미리보기' })).not.toBeInTheDocument();
    ui.rerender(<PeriodExplorer {...props} selectedId="block" />);
    ui.rerender(<PeriodExplorer {...props} selectedId="phase" />);
    expect(screen.queryByRole('complementary', { name: '기간 미리보기' })).not.toBeInTheDocument();
  });
  it('shows partial/gap/date semantics and invokes calendar separately from selecting a period', async () => {
    const user = userEvent.setup();
    const onCalendar = vi.fn(),
      onSelect = vi.fn();
    const phase = draft.periods.find((period) => period.id === 'phase');
    if (!phase) throw new Error('Missing fixture phase');
    const plan = {
      ...draft,
      periods: [
        ...draft.periods,
        {
          ...phase,
          id: 'tiny',
          parentId: 'phase',
          level: 'block' as const,
          title: '짧은 부분',
          startDate: '2026-09-29',
          endDateExclusive: '2026-09-30',
          isPartial: true,
        },
      ],
    };
    render(
      <PeriodExplorer plan={plan} selectedId="phase" onSelect={onSelect} onCalendar={onCalendar} />,
    );
    expect(screen.getByText('자식 기간 미배정: 19일')).toBeVisible();
    expect(screen.getByRole('button', { name: 'block · 짧은 부분' })).toBeVisible();
    expect(screen.getByText(/원형 각도는 날짜 길이/)).toBeVisible();
    expect(
      await screen.findByRole('button', { name: '기간 원형: block · 짧은 부분' }),
    ).toHaveTextContent('2');
    await user.click(screen.getByRole('button', { name: '이 기간 달력 보기' }));
    expect(onCalendar).toHaveBeenCalledWith(phase);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('handles unavailable, invalid draft, missing selection and a childless Block explicitly', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const ui = render(
      <PeriodExplorer
        plan={undefined}
        selectedId={null}
        unavailableReason="조회 중입니다."
        onSelect={onSelect}
        onCalendar={vi.fn()}
      />,
    );
    expect(screen.getByText('조회 중입니다.')).toBeVisible();
    ui.rerender(
      <PeriodExplorer
        plan={{ ...draft, periods: [], sessions: [] }}
        selectedId={null}
        onSelect={onSelect}
        onCalendar={vi.fn()}
      />,
    );
    expect(screen.getByText(/등록된 기간이 없습니다/)).toBeVisible();
    ui.rerender(
      <PeriodExplorer
        plan={{ ...draft, title: '' }}
        selectedId={null}
        onSelect={onSelect}
        onCalendar={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('초안의 기간 구조');
    ui.rerender(
      <PeriodExplorer plan={draft} selectedId="absent" onSelect={onSelect} onCalendar={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: '전체 계획 보기' }));
    expect(onSelect).toHaveBeenCalledWith(null);
    ui.rerender(
      <PeriodExplorer plan={draft} selectedId="block" onSelect={onSelect} onCalendar={vi.fn()} />,
    );
    expect(screen.getByText(/하위 기간이 없습니다/)).toBeVisible();
    expect(screen.getByRole('region', { name: '현재 선택한 기간' })).toHaveTextContent(
      '종료일 미포함',
    );
  });
  it('prevents calendar requests above 366 days without silently shortening the selected period', () => {
    const root = draft.periods.find((period) => period.id === 'season');
    if (!root) throw new Error('Missing fixture root');
    const plan = {
      ...draft,
      periods: draft.periods.map((period) =>
        period.id === 'season' ? { ...period, endDateExclusive: '2028-09-01' } : period,
      ),
    };
    const onCalendar = vi.fn();
    render(
      <PeriodExplorer plan={plan} selectedId="season" onSelect={vi.fn()} onCalendar={onCalendar} />,
    );
    expect(screen.getByRole('button', { name: '이 기간 달력 보기' })).toBeDisabled();
    expect(screen.getByText(/최대 366일/)).toBeVisible();
    expect(onCalendar).not.toHaveBeenCalled();
  });
});
