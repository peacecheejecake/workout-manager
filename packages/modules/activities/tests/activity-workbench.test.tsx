import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import { ActivityWorkbench } from '../src/activity-workbench';
const values = {
  title: '합성 상세',
  kind: 'running' as const,
  startedAt: null,
  timezone: null,
  durationSeconds: 0,
  durationKind: 'timer' as const,
  distanceMeters: null,
};
const activity: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 1,
  source: { kind: 'fixture', sourceId: 'synthetic', revision: 2, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
};
const start = Date.parse('2026-09-17T00:00:00Z');
// A chart page draws up to 500 points per metric, each an SVG circle with role="button". A
// document-wide role query computes the name and visibility of all ~1000 of them — about half a
// second per query in jsdom, so a handful of them used up the whole 5 s test budget on a loaded
// machine. The large-record tests therefore look controls up inside the group that owns them.
const recordTable = () => within(screen.getByRole('table', { name: '원본 관측 표' }));
const selection = () => within(screen.getByRole('region', { name: '관측 선택 요약' }));
const rangeControls = () => within(screen.getByRole('region', { name: '관측 구간 선택' }));
const views = () => within(screen.getByRole('navigation', { name: '원본 상세 보기' }));
/** The pager whose status reads "<label> n / m페이지". */
function pager(label: string) {
  const status = screen.getByText(new RegExp(`^${label} \\d+ / \\d+페이지`));
  if (!status.parentElement) throw new Error(`Pager ${label} missing`);
  return within(status.parentElement);
}
function read(count = 3): ActivityDetailsRead {
  return {
    activityId: activity.id,
    activityRevision: activity.revision,
    source: activity.source,
    details: {
      schemaVersion: 1,
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: new Date(start).toISOString(),
      recordedAt: '2026-09-16T00:00:00Z',
      elapsedSeconds: 60,
      records: Array.from({ length: count }, (_, index) => ({
        index,
        timestamp: new Date(start + index * 1000).toISOString(),
        distanceMeters: index === 1 ? null : index,
        heartRateBpm: index === 1 ? null : 0,
      })),
      laps: [
        {
          index: 0,
          startedAt: new Date(start).toISOString(),
          recordedAt: '2026-09-15T00:00:00Z',
          elapsedSeconds: 2,
          timerSeconds: 0,
          distanceMeters: 0,
          averageHeartRateBpm: 0,
          maximumHeartRateBpm: null,
        },
        {
          index: 1,
          startedAt: null,
          recordedAt: null,
          elapsedSeconds: null,
          timerSeconds: null,
          distanceMeters: null,
          averageHeartRateBpm: null,
          maximumHeartRateBpm: null,
        },
      ],
    },
  };
}
describe('activity detail workbench', () => {
  it('unmounts controlled panel content while retaining selection, pages and unapplied range validation', async () => {
    const user = userEvent.setup();
    const data = read(1001);
    const lap = data.details?.laps[0];
    if (!data.details || !lap) throw new Error('Fixture details missing');
    data.details.laps = Array.from({ length: 21 }, (_, index) => ({ ...lap, index }));
    const view = render(<ActivityWorkbench activity={activity} read={data} panel="intervals" />);
    expect(screen.queryByRole('button', { name: '상세 출처' })).not.toBeInTheDocument();
    await user.click(recordTable().getByRole('button', { name: '관측 0 선택' }));
    await user.click(pager('관측 표').getByRole('button', { name: '관측 표 다음 페이지' }));
    await user.click(pager('차트').getByRole('button', { name: '차트 다음 페이지' }));
    fireEvent.change(screen.getByLabelText('구간 시작 (UTC)'), {
      target: { value: '2026-09-17T00:00:04' },
    });
    await user.click(rangeControls().getByRole('button', { name: '구간 적용' }));
    expect(screen.getByRole('alert')).toBeVisible();
    view.rerender(<ActivityWorkbench activity={activity} read={data} panel="inactive" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('구간 시작 (UTC)')).not.toBeInTheDocument();
    view.rerender(<ActivityWorkbench activity={activity} read={data} panel="source" />);
    expect(screen.getByRole('region', { name: '상세 출처' })).toHaveTextContent('synthetic');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    view.rerender(<ActivityWorkbench activity={activity} read={data} panel="intervals" />);
    expect(screen.getByLabelText('구간 시작 (UTC)')).toHaveValue('2026-09-17T00:00:04.000');
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByText(/차트 원본 순번 범위: 500–999/)).toBeVisible();
    expect(recordTable().getByRole('button', { name: '관측 20 선택' })).toBeVisible();
    expect(selection().getByText(/선택한 관측 0/)).toBeVisible();
    await user.click(views().getByRole('button', { name: '랩' }));
    await user.click(screen.getByRole('button', { name: '랩 0 선택' }));
    await user.click(screen.getByRole('button', { name: '랩 표 다음 페이지' }));
    view.rerender(<ActivityWorkbench activity={activity} read={data} panel="inactive" />);
    view.rerender(<ActivityWorkbench activity={activity} read={data} panel="intervals" />);
    expect(views().getByRole('button', { name: '랩' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '랩 20 선택' })).toBeVisible();
    expect(selection().getByText(/선택한 랩 0/)).toBeVisible();
    const revised = { ...activity, revision: 2 };
    view.rerender(
      <ActivityWorkbench
        activity={revised}
        read={{ ...data, activityRevision: 2 }}
        panel="intervals"
      />,
    );
    expect(screen.getByLabelText('구간 시작 (UTC)')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(views().getByRole('button', { name: '관측 개요' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(/차트 원본 순번 범위: 0–499/)).toBeVisible();
    expect(screen.getByText('선택 구간 없음')).toBeVisible();
  });
  it('suppresses inactive missing or mismatched details but rechecks when activated', () => {
    const mismatch = { ...read(), activityRevision: 99 };
    const view = render(<ActivityWorkbench activity={activity} read={mismatch} panel="inactive" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    view.rerender(<ActivityWorkbench activity={activity} read={mismatch} panel="source" />);
    expect(screen.getByRole('alert')).toHaveTextContent('버전이 다릅니다');
    view.rerender(
      <ActivityWorkbench
        activity={activity}
        read={{ ...read(), details: null }}
        panel="inactive"
      />,
    );
    expect(screen.queryByText(/저장된 원본 관측 상세가 없습니다/)).not.toBeInTheDocument();
    view.rerender(
      <ActivityWorkbench
        activity={activity}
        read={{ ...read(), details: null }}
        panel="intervals"
      />,
    );
    expect(screen.getByText(/저장된 원본 관측 상세가 없습니다/)).toBeVisible();
  });
  it('bounds 20k records to 500 chart observations and 20 table rows while retaining cross-page selection', async () => {
    const user = userEvent.setup();
    render(<ActivityWorkbench activity={activity} read={read(20_000)} />);
    const chart = await screen.findByRole('img', { name: '원본 거리 (m) 차트' });
    expect(chart.querySelectorAll('circle')).toHaveLength(499);
    expect(recordTable().getAllByRole('row')).toHaveLength(21);
    await user.click(recordTable().getByRole('button', { name: '관측 0 선택' }));
    await user.click(pager('차트').getByRole('button', { name: '차트 다음 페이지' }));
    expect(screen.getByText(/차트 원본 순번 범위: 500–999/)).toBeVisible();
    await user.click(pager('관측 표').getByRole('button', { name: '관측 표 다음 페이지' }));
    expect(recordTable().getByRole('button', { name: '관측 20 선택' })).toBeVisible();
    expect(selection().getByText(/선택한 관측 0/)).toHaveTextContent('거리 0 m · 심박 0 bpm');
    await user.click(selection().getByRole('button', { name: '선택한 관측 페이지로 이동' }));
    expect(recordTable().getByRole('button', { name: '관측 0 선택' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  it('shares lap elapsed ranges with chart and record rows across tabs, preserving unknowns', async () => {
    const user = userEvent.setup();
    render(<ActivityWorkbench activity={activity} read={read()} />);
    await user.click(screen.getByRole('button', { name: '랩' }));
    await user.click(screen.getByRole('button', { name: '랩 0 선택' }));
    expect(screen.getByText(/선택 구간 UTC:/)).toHaveTextContent(
      '2026-09-17T00:00:00.000Z – 2026-09-17T00:00:02.000Z',
    );
    await user.click(screen.getByRole('button', { name: '관측 개요' }));
    expect(screen.getByRole('button', { name: '관측 2 선택' }).closest('tr')).toHaveAttribute(
      'data-in-range',
      'true',
    );
    const chart = await screen.findByRole('img', { name: '원본 거리 (m) 차트' });
    expect(chart.querySelector('[data-in-range="true"]')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: '랩' }));
    await user.click(screen.getByRole('button', { name: '랩 1 선택' }));
    expect(screen.getByText(/랩 구간을 표시할 수 없습니다/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '관측 개요' }));
    expect(screen.getByRole('button', { name: '관측 2 선택' }).closest('tr')).toHaveAttribute(
      'data-in-range',
      'false',
    );
  });
  it('applies explicit UTC input and rejects reversed ranges without erasing last selection', async () => {
    const user = userEvent.setup();
    render(<ActivityWorkbench activity={activity} read={read()} />);
    fireEvent.change(screen.getByLabelText('구간 시작 (UTC)'), {
      target: { value: '2026-09-17T00:00:00' },
    });
    fireEvent.change(screen.getByLabelText('구간 끝 (UTC)'), {
      target: { value: '2026-09-17T00:00:01' },
    });
    await user.click(screen.getByRole('button', { name: '구간 적용' }));
    expect(screen.getByText(/선택 구간 UTC:/)).toHaveTextContent('2026-09-17T00:00:01.000Z');
    fireEvent.change(screen.getByLabelText('구간 끝 (UTC)'), {
      target: { value: '2026-09-16T00:00:00' },
    });
    await user.click(screen.getByRole('button', { name: '구간 적용' }));
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByText(/선택 구간 UTC:/)).toHaveTextContent('2026-09-17T00:00:01.000Z');
    await user.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(screen.getByText('선택 구간 없음')).toBeVisible();
  });
  it('selects chart points and keeps source-order gaps for null, duplicate and reversed timestamps', async () => {
    const data = read(5);
    if (!data.details) throw new Error('Fixture details missing');
    data.details.records = data.details.records.map((record, index) => ({
      ...record,
      distanceMeters: index,
      timestamp: index === 1 ? null : new Date(start + (index === 4 ? -1 : 0) * 1000).toISOString(),
    }));
    render(<ActivityWorkbench activity={activity} read={data} />);
    const chart = await screen.findByRole('img', { name: '원본 거리 (m) 차트' });
    expect(chart.querySelectorAll('polyline')).toHaveLength(4);
    fireEvent.click(within(chart).getByRole('button', { name: '차트 관측 0 선택' }));
    expect(screen.getByRole('button', { name: '관측 0 선택' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  it('retains keyboard focus across resize and resets selection on source or activity revision change', async () => {
    const user = userEvent.setup();
    const view = render(<ActivityWorkbench activity={activity} read={read()} />);
    const button = screen.getByRole('button', { name: '관측 0 선택' });
    button.focus();
    await user.keyboard('{Enter}');
    fireEvent(window, new Event('resize'));
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-pressed', 'true');
    const next = { ...activity, revision: 2 };
    view.rerender(<ActivityWorkbench activity={next} read={{ ...read(), activityRevision: 2 }} />);
    expect(screen.getByText('선택 구간 없음')).toBeVisible();
    expect(screen.getByRole('button', { name: '관측 0 선택' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.click(screen.getByRole('button', { name: '관측 0 선택' }));
    const changedSource = {
      ...next,
      source: { ...next.source, revision: 3, contentHash: 'b'.repeat(64) },
    };
    view.rerender(
      <ActivityWorkbench
        activity={changedSource}
        read={{ ...read(), activityRevision: 2, source: changedSource.source }}
      />,
    );
    expect(screen.getByText('선택 구간 없음')).toBeVisible();
    expect(screen.getByRole('button', { name: '관측 0 선택' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    view.rerender(<ActivityWorkbench activity={next} read={read()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('버전이 다릅니다');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
  it('keeps source timestamps separate from summary overlays and explains absent details', async () => {
    const user = userEvent.setup();
    const view = render(<ActivityWorkbench activity={activity} read={read()} />);
    await user.click(screen.getByRole('button', { name: '상세 출처' }));
    expect(screen.getByText('fixture')).toBeVisible();
    expect(screen.getByText('2026-09-16T00:00:00.000Z')).toBeVisible();
    view.rerender(<ActivityWorkbench activity={activity} read={{ ...read(), details: null }} />);
    expect(screen.getByText(/저장된 원본 관측 상세가 없습니다/)).toBeVisible();
  });
});
