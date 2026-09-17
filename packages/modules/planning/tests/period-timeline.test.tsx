import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PeriodTimeline, type TimelineSegment } from '../src/period-timeline';
const segments: TimelineSegment[] = [
  {
    id: 'main',
    label: 'block · 주요 기간',
    number: 1,
    startFraction: 0,
    endFraction: 0.5,
    days: 3,
    partial: false,
  },
  {
    id: 'tiny',
    label: 'block · 짧은 기간',
    number: 2,
    startFraction: 5 / 6,
    endFraction: 1,
    days: 1,
    partial: true,
  },
];
describe('period timeline', () => {
  it('preserves leap-day date proportions, gaps and partial spans without enlarging tiny bars', () => {
    const { container } = render(
      <PeriodTimeline
        segments={segments}
        startDate="2024-02-27"
        endDateExclusive="2024-03-04"
        onSelect={vi.fn()}
        onPreview={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-period-bar="main"]')).toHaveStyle({
      '--period-start': '0%',
      '--period-width': '50%',
    });
    const tiny = container.querySelector<HTMLElement>('[data-period-bar="tiny"]');
    expect(Number.parseFloat(tiny?.style.getPropertyValue('--period-start') ?? '')).toBeCloseTo(
      83.3333,
      3,
    );
    expect(Number.parseFloat(tiny?.style.getPropertyValue('--period-width') ?? '')).toBeCloseTo(
      16.6667,
      3,
    );
    expect(screen.getByText(/짧은 기간 · 1일 · 부분 기간/)).toBeVisible();
  });
  it('previews focus and hover independently, selects only with explicit keyboard or pointer action', async () => {
    const select = vi.fn(),
      preview = vi.fn();
    render(
      <PeriodTimeline
        segments={segments}
        startDate="2024-02-27"
        endDateExclusive="2024-03-04"
        onSelect={select}
        onPreview={preview}
      />,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(preview).toHaveBeenCalledWith('main', 'focus');
    expect(select).not.toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('button', { name: '기간 타임라인: block · 짧은 기간' }));
    expect(preview).toHaveBeenCalledWith('tiny', 'hover');
    await user.keyboard('{Enter}');
    expect(select).toHaveBeenLastCalledWith('main');
    await user.click(screen.getByRole('button', { name: '기간 타임라인: block · 짧은 기간' }));
    expect(select).toHaveBeenLastCalledWith('tiny');
  });
  it('keeps leaf and long ranges explicit without inventing child bars', () => {
    const { rerender } = render(
      <PeriodTimeline
        segments={[]}
        startDate="2024-01-01"
        endDateExclusive="2030-01-01"
        onSelect={vi.fn()}
        onPreview={vi.fn()}
      />,
    );
    expect(screen.getByText('2024-01-01부터 2030-01-01 미포함')).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/표시할 막대가 없습니다/)).toBeVisible();
    rerender(
      <PeriodTimeline
        segments={[]}
        startDate={null}
        endDateExclusive={null}
        onSelect={vi.fn()}
        onPreview={vi.fn()}
      />,
    );
    expect(screen.getByText('표시할 날짜 범위가 없습니다.')).toBeVisible();
  });
});
