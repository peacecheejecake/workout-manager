import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { activityContextSchema } from '@workout/contracts/activity-context';
import { ActivityContextPanel } from '../src/activity-context-panel';
const version = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const values = {
  title: '관측 활동',
  kind: 'running',
  startedAt: '2026-09-16T00:00:00Z',
  timezone: 'Asia/Seoul',
  durationSeconds: 0,
  durationKind: 'timer',
  distanceMeters: 0,
};
const activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revision: 2,
  source: { kind: 'manual', sourceId: 'manual-one', revision: 1, contentHash: 'a'.repeat(64) },
  original: values,
  effective: values,
  overlay: {},
  userReport: {
    sessionRpe: 0,
    note: null,
    planLink: { planVersionId: version, sessionId: 'session' },
    source: 'user',
    method: 'self_report',
    definitionVersion: 'activity-report-v1',
    rpeReportedAt: '2026-09-16T01:00:00Z',
  },
};
const metric = { value: null, knownCount: 0, missingCount: 0 };
const envelope = {
  definitionVersion: 'activity-context-v1',
  observedAt: '2026-09-16T01:00:00Z',
  activity,
  activityDataRevision: { count: 2, revisionSum: '3' },
};
function linked() {
  return {
    ...envelope,
    planContext: {
      status: 'linked',
      planVersion: { id: version, version: 1, title: '저장된 계획' },
      currentPlanVersionId: version,
      session: {
        id: 'session',
        blockId: 'block',
        date: '2026-09-16',
        localStartTime: null,
        title: '계획 달리기',
        sport: 'running',
        durationSeconds: 60,
        distanceMeters: 0,
        targetRpe: null,
        purpose: '',
        notes: '',
        priority: 'normal',
        locks: { date: false, time: false, intensity: false },
        steps: [],
      },
      block: {
        id: 'block',
        parentId: 'phase',
        level: 'block',
        title: '연결 Block',
        startDate: '2026-09-01',
        endDateExclusive: '2026-09-20',
        timezone: 'Asia/Seoul',
        intent: '',
        isPartial: false,
      },
      actualLocalDate: '2026-09-16',
      blockMembership: 'included',
      blockActual: {
        count: 1,
        distanceMeters: { value: 0, knownCount: 1, missingCount: 0 },
        durationSeconds: {
          timer: { value: 0, knownCount: 1, missingCount: 0 },
          elapsed: metric,
          moving: metric,
          unknown: metric,
        },
        sources: { fit: 0, fixture: 0, manual: 1 },
        overlayCount: 1,
      },
      distanceComparison: { actual: 0, planned: 0, delta: 0, status: 'available' },
      durationComparison: {
        actual: 0,
        actualKind: 'timer',
        planned: 60,
        delta: null,
        status: 'not_comparable',
        reason: 'planned_duration_definition_missing',
      },
      coverage: 'unknown',
    },
  };
}
it('never invents a plan for unlinked observations and distinguishes unavailable stored links', () => {
  const unlinked = activityContextSchema.parse({
    ...envelope,
    activity: { ...activity, userReport: null },
    planContext: { status: 'unlinked' },
  });
  const { rerender } = render(<ActivityContextPanel context={unlinked} />);
  expect(screen.getByText(/날짜나 종목이 비슷해도 계획 연결을 추정하지 않습니다/)).toBeVisible();
  rerender(
    <ActivityContextPanel
      context={activityContextSchema.parse({
        ...envelope,
        planContext: { status: 'unavailable', reason: 'linked_plan_unavailable' },
      })}
    />,
  );
  expect(screen.getByText(/저장된 계획 연결은 있지만/)).toBeVisible();
  expect(screen.queryByRole('region', { name: '계획과 실제의 단순 비교' })).not.toBeInTheDocument();
  rerender(
    <ActivityContextPanel
      context={activityContextSchema.parse({
        ...envelope,
        planContext: { status: 'unavailable', reason: 'unsupported_calendar' },
      })}
    />,
  );
  expect(screen.getByText(/지원 범위를 벗어난 날짜/)).toBeVisible();
  expect(
    screen.queryByRole('region', { name: '연결 Block의 관측 부분 합계' }),
  ).not.toBeInTheDocument();
});
it('shows a known zero difference and separate duration definitions without claiming comparability', () => {
  render(
    <ActivityContextPanel
      context={activityContextSchema.parse(linked())}
      planDayHref={(date) => `/planner?date=${date}`}
    />,
  );
  expect(screen.getByText('거리 차이 (실제 − 계획): 0m')).toBeVisible();
  expect(screen.getByText(/이 활동의 합계 기여: 거리 0m/)).toHaveTextContent('시간 0초');
  expect(screen.getByText(/계획 시간의 측정 정의가 없어 시간을 비교할 수 없습니다/)).toBeVisible();
  const totals = screen.getByRole('region', { name: '연결 Block의 관측 부분 합계' });
  expect(totals).toHaveTextContent('0m · 알려진 1개 · 미확인 0개');
  expect(totals).toHaveTextContent('수동 기록 1개');
  expect(within(totals).getAllByText('미확인 · 알려진 0개 · 미확인 0개')).toHaveLength(3);
  expect(screen.getByRole('link', { name: '현재 계획의 해당 날짜 보기' })).toHaveAttribute(
    'href',
    '/planner?date=2026-09-16',
  );
});
it('keeps historical plan metadata and does not link to an unsupported historical planner', () => {
  const value = linked();
  value.planContext.currentPlanVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  render(
    <ActivityContextPanel
      context={activityContextSchema.parse(value)}
      planDayHref={() => '/planner'}
    />,
  );
  expect(screen.getByText(/과거 계획 버전에 연결되어 있습니다/)).toBeVisible();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByText(/연결 계획: 저장된 계획 · 버전 1/)).toBeVisible();
});
for (const membership of ['outside', 'unknown_time'] as const)
  it(`does not attribute an activity to Block totals when membership is ${membership}`, () => {
    const base = linked();
    const value = {
      ...base,
      activity: { ...base.activity, effective: { ...values, distanceMeters: null } },
      planContext: {
        ...base.planContext,
        actualLocalDate: membership === 'outside' ? '2026-09-30' : null,
        blockMembership: membership,
        distanceComparison: { actual: null, planned: 0, delta: null, status: 'missing_actual' },
      },
    };
    render(<ActivityContextPanel context={activityContextSchema.parse(value)} />);
    expect(screen.getByText(/해당 Block 부분 합계에 기여하지 않습니다/)).toBeVisible();
    expect(screen.queryByText(/이 활동의 합계 기여:/)).not.toBeInTheDocument();
    expect(screen.getByText(/거리 차이를 계산할 수 없습니다/)).toBeVisible();
    expect(screen.queryByText('거리 차이 (실제 − 계획): 0m')).not.toBeInTheDocument();
  });

it('links the exact immutable Block even when its version is historical', () => {
  const value = linked();
  value.planContext.currentPlanVersionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  render(
    <ActivityContextPanel
      context={activityContextSchema.parse(value)}
      linkedBlockHref={(version, block) =>
        `/activities?linkedPlanVersionId=${version}&linkedBlockId=${block}`
      }
    />,
  );
  expect(
    screen.getByRole('link', { name: '이 Block에 명시적으로 연결된 활동 보기' }),
  ).toHaveAttribute('href', `/activities?linkedPlanVersionId=${version}&linkedBlockId=block`);
});
