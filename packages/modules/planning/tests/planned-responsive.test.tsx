import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanDraft } from '@workout/contracts/planning';
import type { DayProjection } from '@workout/contracts/core';
import { PlannedSessionViews } from '../src/planned-session-views';
import { readPlannerSearch } from '../src/lens';

const source: PlanDraft = {
  title: '반응형 초안',
  timezone: 'UTC',
  periods: [],
  sessions: [
    {
      id: 'session',
      blockId: 'block',
      date: '2026-09-17',
      localStartTime: null,
      title: '선택한 훈련',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
      targetRpe: null,
    },
  ],
};
const days: DayProjection[] = [
  {
    date: '2026-09-17',
    timezone: 'UTC',
    blockId: 'block',
    plannedSessionIds: ['session'],
    activityIds: [],
    knownRest: false,
  },
];
const props = { source, days, selected: 'session', onSelect: vi.fn() };
function geometry(viewport: number, width: number) {
  vi.stubGlobal('innerWidth', viewport);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, width, 600),
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('responsive planned views', () => {
  it('uses automatic defaults from both viewport and container while preserving explicit single views', () => {
    geometry(1920, 1100);
    const ui = render(<PlannedSessionViews {...props} view="auto" />);
    expect(screen.getByRole('region', { name: '계획 달력 패널' })).toBeVisible();
    expect(screen.getByRole('region', { name: '계획 표 패널' })).toBeVisible();
    geometry(1920, 420);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('region', { name: '계획 표 패널' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '계획 agenda 패널' })).toBeVisible();
    ui.rerender(<PlannedSessionViews {...props} view="table" />);
    expect(screen.getByRole('region', { name: '계획 표 패널' })).toBeVisible();
    expect(readPlannerSearch('', '2026-09-17').plannedView).toBe('auto');
    expect(readPlannerSearch('plannedView=split', '2026-09-17').plannedView).toBe('split');
  });
  it('allows explicit split in a sufficiently wide tablet container and retains narrow fallback choice', () => {
    geometry(1024, 960);
    const ui = render(<PlannedSessionViews {...props} view="auto" />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    ui.rerender(<PlannedSessionViews {...props} view="split" />);
    expect(screen.getByRole('table')).toBeVisible();
    geometry(320, 288);
    act(() => window.dispatchEvent(new Event('resize')));
    fireEvent.click(screen.getByRole('button', { name: '좁은 화면 표 보기' }));
    expect(screen.getByRole('table')).toBeVisible();
    geometry(1920, 1100);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByRole('region', { name: '계획 달력 패널' })).toBeVisible();
    geometry(320, 288);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByRole('table')).toBeVisible();
  });
  it('restores each pane scroll position after fallback unmount', () => {
    geometry(1920, 1100);
    render(<PlannedSessionViews {...props} view="split" />);
    const table = screen.getByRole('table').parentElement;
    if (!table) throw new Error('Missing scroll container');
    table.scrollLeft = 240;
    fireEvent.scroll(table);
    geometry(320, 288);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    geometry(1920, 1100);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByRole('table').parentElement?.scrollLeft).toBe(240);
  });
  it('restores disappearing session focus but leaves external editor focus unchanged', () => {
    geometry(1920, 1100);
    render(
      <>
        <input aria-label="편집 중인 초안" defaultValue="유지" />
        <PlannedSessionViews {...props} view="split" />
      </>,
    );
    within(screen.getByRole('region', { name: '계획 표 패널' }))
      .getByRole('button', { name: '계획: 선택한 훈련' })
      .focus();
    geometry(320, 288);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(screen.getByRole('button', { name: '계획: 선택한 훈련' })).toHaveFocus();
    const editor = screen.getByLabelText('편집 중인 초안');
    editor.focus();
    geometry(1920, 1100);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue('유지');
  });
});
