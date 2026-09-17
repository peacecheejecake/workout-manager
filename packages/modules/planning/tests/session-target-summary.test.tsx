import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { planDraftSchema } from '@workout/contracts/planning';
import { PlanSummary } from '../src/plan-summary';
import { PlannedSessionDetail } from '../src/planned-session-detail';

const legacy = planDraftSchema.parse({
  title: 'Synthetic target review',
  timezone: 'UTC',
  periods: ['season', 'wave', 'phase', 'block'].map((level, index, levels) => ({
    id: level,
    parentId: index ? levels[index - 1] : null,
    level,
    title: level,
    startDate: '2080-01-01',
    endDateExclusive: '2080-02-01',
    timezone: 'UTC',
    intent: '',
    isPartial: false,
  })),
  sessions: [
    {
      id: 'run',
      blockId: 'block',
      date: '2080-01-05',
      localStartTime: null,
      title: 'Synthetic run',
      sport: 'running',
      durationSeconds: null,
      distanceMeters: 0,
      targetRpe: 0,
      purpose: '',
      notes: '',
      priority: 'normal',
      locks: { date: false, time: false, intensity: false },
      steps: [],
    },
  ],
});
const targeted = {
  ...legacy,
  sessions: legacy.sessions.map((session) => ({
    ...session,
    paceTarget: { minSecondsPerKm: 240.125, maxSecondsPerKm: 300.25 },
    heartRateTarget: { minBpm: 140, maxBpm: 140 },
  })),
};

describe('session target review and saved detail', () => {
  it('makes absent, range, single and explicitly cleared values readable before approval', () => {
    render(
      <>
        <section aria-label="before">
          <PlanSummary draft={legacy} />
        </section>
        <section aria-label="after">
          <PlanSummary draft={targeted} />
        </section>
        <section aria-label="cleared">
          <PlanSummary
            draft={{
              ...targeted,
              sessions: targeted.sessions.map((session) => ({
                ...session,
                paceTarget: null,
                heartRateTarget: null,
              })),
            }}
          />
        </section>
      </>,
    );
    expect(
      within(screen.getByRole('region', { name: 'before' })).getByText(/목표 페이스:/),
    ).toHaveTextContent('이전 형식에 값 없음');
    const after = within(screen.getByRole('region', { name: 'after' }));
    expect(after.getByText(/목표 페이스:/)).toHaveTextContent(
      '목표 페이스: 240.125–300.25 초/km · 목표 심박: 140 bpm',
    );
    expect(after.getByText(/목적:/)).toHaveTextContent('시간: 미정 · 거리: 0m · RPE: 0');
    expect(
      within(screen.getByRole('region', { name: 'cleared' })).getByText(/목표 페이스:/),
    ).toHaveTextContent('명시적으로 비움');
  });

  it('shows selected saved targets with units without claiming actual performance', () => {
    render(<PlannedSessionDetail source={targeted} selected="run" visibleIds={[]} draft={false} />);
    const detail = within(screen.getByRole('region', { name: '선택한 계획 세션' }));
    expect(detail.getByText(/저장된 계획/)).toBeVisible();
    expect(detail.getByText(/목표 페이스:/)).toHaveTextContent(
      '240.125–300.25 초/km · 목표 심박: 140 bpm',
    );
    expect(detail.getByRole('status')).toHaveTextContent('현재 조회 범위 밖');
    expect(detail.queryByText(/달성|실측/)).not.toBeInTheDocument();
  });
});
