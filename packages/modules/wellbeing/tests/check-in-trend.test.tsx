import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CheckIn } from '@workout/contracts/check-ins';
import { CheckInTrend } from '../src/check-in-trend';

function record(id: string, patch: Partial<CheckIn['values']> = {}): CheckIn {
  return {
    id,
    revision: 3,
    localDate: '2026-09-16',
    values: {
      observedAt: '2026-09-15T23:30:00Z',
      timezone: 'Asia/Seoul',
      fatigue: 0,
      discomfort: null,
      bodyLocation: null,
      note: null,
      ...patch,
    },
    recordedAt: '2026-09-16T00:00:00Z',
    updatedAt: '2026-09-16T01:00:00Z',
    source: 'user',
    method: 'self_report',
    definitionVersion: 'checkin-v1',
  };
}
function setup(items: CheckIn[], total = items.length, offset = 0) {
  const onSelect = vi.fn();
  render(
    <CheckInTrend
      data={{ items, total, collectionRevision: 8 }}
      from="2026-09-01"
      toExclusive="2026-10-01"
      offset={offset}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}
describe('CheckInTrend', () => {
  it('shows raw zero as a point and null only as missing in the source table', () => {
    setup([record('a')]);
    const fatigue = screen.getByRole('region', { name: '피로 관측 추세' });
    expect(within(fatigue).getByRole('img')).toHaveAccessibleName('피로 관측점 1개 · 0~10 척도');
    expect(fatigue.querySelector('circle')).toHaveAttribute('cy', '150');
    expect(
      screen.getByRole('region', { name: '불편감 관측 추세' }).querySelector('circle'),
    ).toBeNull();
    const row = screen.getAllByRole('row')[1];
    if (!row) throw new Error('Expected a source row');
    expect(within(row).getByRole('cell', { name: '0' })).toBeVisible();
    expect(within(row).getByRole('cell', { name: '미보고' })).toBeVisible();
    expect(within(row).getByRole('cell', { name: '3' })).toBeVisible();
  });
  it('preserves duplicate instants and sorts by actual instant then stable ID without mutating input', () => {
    const items = [
      record('b'),
      record('a', { observedAt: '2026-09-16T08:30:00+09:00' }),
      record('earlier', {
        observedAt: '2026-09-15T22:30:00Z',
        timezone: 'America/Los_Angeles',
        fatigue: 10,
        discomfort: 5,
      }),
    ];
    setup(items);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label')?.split(' · ').at(-1))).toEqual(
      ['earlier', 'a', 'b'],
    );
    expect(items.map((item) => item.id)).toEqual(['b', 'a', 'earlier']);
    const circles = screen
      .getByRole('region', { name: '피로 관측 추세' })
      .querySelectorAll('circle');
    expect(circles).toHaveLength(3);
    expect(circles[1]?.getAttribute('cx')).toBe(circles[2]?.getAttribute('cx'));
    expect(screen.getByRole('cell', { name: 'America/Los_Angeles' })).toBeVisible();
    expect(screen.getByRole('rowheader', { name: '2026-09-16T08:30:00+09:00' })).toBeVisible();
    expect(screen.getAllByRole('cell', { name: '2026-09-16' })).toHaveLength(3);
    expect(screen.getAllByText(/관측 시각 축 \(UTC\): 2026-09-15T22:30:00.000Z/)).toHaveLength(2);
  });
  it('labels partial pages and does not infer missing reports from hidden records', () => {
    setup([record('a')], 150, 100);
    expect(screen.getByText('부분 조회: 현재 1개 / 전체 150개')).toBeVisible();
    expect(
      screen.getByText(/이 페이지의 미보고 수는 전체 기간의 미보고 수가 아닙니다/),
    ).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: '불편감 관측 추세' })).getByText(
        '보고 0개 · 미보고 1개',
      ),
    ).toBeVisible();
  });
  it('distinguishes an empty collection from an empty page', () => {
    setup([], 8, 100);
    expect(screen.getByText('이 페이지에 표시할 기록이 없습니다.')).toBeVisible();
    expect(screen.queryByText('이 기간에 기록한 체크인이 없습니다.')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it.each([0, 100])('shows an empty collection without fabricated zeros at offset %s', (offset) => {
    setup([], 0, offset);
    expect(screen.getByText('전체 조회: 현재 0개 / 전체 0개')).toBeVisible();
    expect(screen.getByText('이 기간에 기록한 체크인이 없습니다.')).toBeVisible();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/표시하지 않은 기록이 있습니다/)).not.toBeInTheDocument();
  });
  it('supports keyboard access to the source table and record selection', async () => {
    const user = userEvent.setup();
    const onSelect = setup([record('a')]);
    await user.tab();
    expect(screen.getByRole('region', { name: '체크인 추세 원본 표 가로 스크롤' })).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole('button', { name: '추세 기록 상세 보기 · 2026-09-15T23:30:00Z · a' }),
    ).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('a');
  });
});
