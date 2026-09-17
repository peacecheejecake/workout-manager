import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import { ActivityMetricSummary, type MetricSourceDetails } from '../src/activity-metric-summary';
const values: Activity['original'] = {
  title: 'Run',
  kind: 'running',
  startedAt: null,
  timezone: null,
  durationSeconds: 300.6,
  durationKind: 'timer',
  distanceMeters: 1000,
};
const activity: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 2,
  source: { kind: 'fixture', sourceId: 'source', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: { ...values, durationSeconds: 120, durationKind: 'moving' },
  overlay: { durationSeconds: 120, durationKind: 'moving', reason: '수동 정정' },
};
function details(): ActivityDetailsRead {
  return {
    activityId: activity.id,
    activityRevision: 2,
    source: activity.source,
    details: {
      schemaVersion: 2,
      sessionSummary: { averageHeartRateBpm: 0, maximumHeartRateBpm: null },
      streamIndex: 0,
      sessionIndex: 0,
      startedAt: null,
      recordedAt: null,
      elapsedSeconds: null,
      records: [{ index: 0, timestamp: null, distanceMeters: null, heartRateBpm: 180 }],
      laps: [],
    },
  };
}
it('calculates original and effective pace separately while preserving time basis and source-reported zero/null heart rate', () => {
  render(
    <ActivityMetricSummary
      activity={activity}
      sourceDetails={{ state: 'ready', value: details() }}
    />,
  );
  const original = screen.getByRole('region', { name: '원본 값의 페이스' }),
    current = screen.getByRole('region', { name: '현재 값의 페이스' });
  expect(original).toHaveTextContent('타이머 시간 300.6초');
  expect(original).toHaveTextContent('5:01 /km (초 단위 반올림)');
  expect(current).toHaveTextContent('이동 시간 120초');
  expect(current).toHaveTextContent('2:00 /km');
  const heart = screen.getByRole('region', { name: '출처 세션 심박 요약' });
  expect(heart).toHaveTextContent('평균 심박: 0 bpm');
  expect(heart).toHaveTextContent('최대 심박: 미보고');
  expect(heart).not.toHaveTextContent('180 bpm');
});
it.each([
  [{ kind: 'strength' }, '이 종목은 페이스 계산을 지원하지 않습니다.'],
  [{ durationKind: 'unknown' }, '시간 정의가 없어 페이스를 계산하지 않습니다.'],
  [{ durationSeconds: null }, '시간 미보고'],
  [{ distanceMeters: null }, '거리 미보고'],
  [{ durationSeconds: 0 }, '시간이 0초여서'],
  [{ distanceMeters: 0 }, '거리가 0m여서'],
  [{ distanceMeters: Number.MIN_VALUE }, '계산 가능한 수치 범위를'],
] as const)('explains unavailable pace without fabricating zero: %j', (patch, reason) => {
  render(
    <ActivityMetricSummary
      activity={{ ...activity, effective: { ...activity.effective, ...patch } }}
      sourceDetails={{ state: 'unavailable' }}
    />,
  );
  const current = screen.getByRole('region', { name: '현재 값의 페이스' });
  expect(current).toHaveTextContent(reason);
  expect(current).not.toHaveTextContent('계산 페이스: 0:00');
});
it.each(['loading', 'error', 'unavailable'] as const)(
  'keeps current pace visible while heart-rate state is %s',
  (state) => {
    render(<ActivityMetricSummary activity={activity} sourceDetails={{ state }} />);
    expect(screen.getByRole('region', { name: '현재 값의 페이스' })).toHaveTextContent('2:00 /km');
    expect(screen.getByRole('region', { name: '출처 세션 심박 요약' })).not.toHaveTextContent(
      '평균 심박:',
    );
    if (state === 'loading') expect(screen.getByRole('status')).toHaveTextContent('확인하고');
    if (state === 'error') expect(screen.getByRole('alert')).toHaveTextContent('조회 실패');
  },
);
it.each(['id', 'revision', 'source'] as const)('hides heart rate from a mismatching %s', (kind) => {
  const read = details();
  if (kind === 'id') read.activityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  if (kind === 'revision') read.activityRevision = 1;
  if (kind === 'source') read.source = { ...read.source, contentHash: 'b'.repeat(64) };
  render(
    <ActivityMetricSummary activity={activity} sourceDetails={{ state: 'ready', value: read }} />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('출처·수정이 달라');
  expect(screen.queryByText('평균 심박: 0 bpm')).not.toBeInTheDocument();
});
it('distinguishes legacy missing fields from absent source details without deriving lap averages', () => {
  const read = details();
  if (!read.details || read.details.schemaVersion !== 2) throw new Error('fixture');
  const { sessionSummary: _summary, ...legacy } = read.details;
  const source: MetricSourceDetails = {
    state: 'ready',
    value: { ...read, details: { ...legacy, schemaVersion: 1 } },
  };
  const { rerender } = render(<ActivityMetricSummary activity={activity} sourceDetails={source} />);
  expect(screen.getByText('이전 형식에 요약 없음')).toBeVisible();
  rerender(
    <ActivityMetricSummary
      activity={activity}
      sourceDetails={{ state: 'ready', value: { ...read, details: null } }}
    />,
  );
  expect(
    within(screen.getByRole('region', { name: '출처 세션 심박 요약' })).getByText(
      '출처에 세션 심박 요약이 없습니다.',
    ),
  ).toBeVisible();
});

it.each([0.1, 0.5, 0.999])(
  'shows %s seconds per kilometer as subsecond rather than rounded zero',
  (durationSeconds) => {
    render(
      <ActivityMetricSummary
        activity={{
          ...activity,
          effective: { ...activity.effective, durationSeconds, distanceMeters: 1000 },
        }}
        sourceDetails={{ state: 'unavailable' }}
      />,
    );
    const current = screen.getByRole('region', { name: '현재 값의 페이스' });
    expect(current).toHaveTextContent('계산 페이스: 1초 미만 /km');
    expect(current).not.toHaveTextContent('0:00');
    expect(screen.queryByText(/activity-duration-distance-pace-v1/)).not.toBeInTheDocument();
  },
);
