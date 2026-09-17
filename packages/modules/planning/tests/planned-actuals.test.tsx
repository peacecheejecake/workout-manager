import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { sessionActualsSchema } from '@workout/contracts/session-actuals';
import { PlannedActualCell, type PlannedActualsState } from '../src/planned-actuals';

const empty = { value: null, knownCount: 0, missingCount: 0 };
const read = sessionActualsSchema.parse({
  definitionVersion: 'session-actuals-v1',
  observedAt: '2026-09-17T00:00:00Z',
  planVersion: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, title: 'Saved targets' },
  currentPlanVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  coverage: 'unknown',
  activityDataRevision: { count: 3, revisionSum: '5' },
  sessions: [
    {
      sessionId: 'run',
      distanceTarget: { minMeters: 1000, maxMeters: 1000 },
      actual: {
        count: 3,
        distanceMeters: { value: 1000, knownCount: 2, missingCount: 1 },
        durationSeconds: {
          timer: { value: 0, knownCount: 1, missingCount: 0 },
          elapsed: { value: 100, knownCount: 1, missingCount: 0 },
          moving: empty,
          unknown: { value: null, knownCount: 0, missingCount: 1 },
        },
        sources: { manual: 2, fit: 1, fixture: 0 },
        overlayCount: 1,
      },
    },
  ],
});
const ready: PlannedActualsState = {
  state: 'ready',
  read,
  sessions: new Map(read.sessions.map((s) => [s.sessionId, s])),
};
describe('planned actual cells', () => {
  it('labels partial sums and distinct duration bases without supplying a fabricated comparison', () => {
    const { rerender } = render(
      <PlannedActualCell state={ready} sessionId="run" column="actual" />,
    );
    expect(screen.getByText('연결된 활동 3개')).toBeVisible();
    expect(screen.getByText(/거리 1,000 m · 부분 합계/)).toBeVisible();
    expect(screen.getByText(/타이머 시간 \(timer\): 0 초/)).toBeVisible();
    expect(screen.getByText(/경과 시간 \(elapsed\): 100 초/)).toBeVisible();
    expect(screen.getByText(/정의 미확인 시간 \(unknown\): 미보고/)).toBeVisible();
    expect(screen.queryByText(/이동 시간/)).not.toBeInTheDocument();
    rerender(<PlannedActualCell state={ready} sessionId="run" column="comparison" />);
    expect(screen.getByText('저장 목표 1,000 m')).toBeVisible();
    expect(screen.getByText('거리 일부 미보고 · 비교 불가')).toBeVisible();
    expect(screen.queryByText(/거리 차이/)).not.toBeInTheDocument();
  });
  it.each([
    ['loading', '연결 실적 조회 중'],
    ['error', '연결 실적 조회 실패'],
    ['stale', '연결 실적 버전 불일치'],
    ['unsaved', '저장 전 세션'],
  ] as const)('keeps %s separate from no linked data', (state, label) => {
    render(<PlannedActualCell state={{ state }} sessionId="run" column="actual" />);
    expect(screen.getByText(label)).toBeVisible();
  });
  it('does not apply another saved session aggregate to an unsaved copy', () => {
    render(<PlannedActualCell state={ready} sessionId="new-copy" column="comparison" />);
    expect(screen.getByText('저장 전 세션')).toBeVisible();
  });
});
