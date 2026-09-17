import {
  sessionDurationLabel,
  sessionDistanceLabel,
  rangePresenceLabel,
} from './session-quantity-labels';
import type { PlanDraft } from '@workout/contracts/planning';
import { PeriodConstraintsSummary } from './period-constraints-summary';
import { periodPriorityLabel } from './period-priority';
import { heartRateTargetLabel, paceTargetLabel } from './session-target-labels';
import { attendanceLockLabel } from './attendance-lock-label';

/** Human-readable full before/after review; identities remain internal to the command. */
export function PlanSummary({ draft }: { draft: PlanDraft | null }) {
  if (!draft) return <p>저장된 계획 없음</p>;
  return (
    <div>
      <p>
        {draft.title} · {draft.timezone}
      </p>
      <h5>기간</h5>
      <ul>
        {draft.periods.map((period) => (
          <li key={period.id}>
            {period.level} · {period.title} · 상위{' '}
            {draft.periods.find((parent) => parent.id === period.parentId)?.title ?? '없음'} ·{' '}
            {period.startDate}–{period.endDateExclusive} (종료일 미포함) · {period.timezone} · 목적{' '}
            {period.intent || '미정'} · {period.isPartial ? '부분 기간' : '일반 기간'} · 기간
            우선순위 {periodPriorityLabel(period.priority)}
            <PeriodConstraintsSummary constraints={period.constraints} />
          </li>
        ))}
      </ul>
      <h5>계획 세션</h5>
      <ul>
        {draft.sessions.map((session) => (
          <li key={session.id}>
            <strong>{session.title}</strong> · {session.sport} · {session.date}{' '}
            {session.localStartTime ?? '시각 미정'} · Block{' '}
            {draft.periods.find((period) => period.id === session.blockId)?.title ?? '미배정'}
            <p>
              목적: {session.purpose || '미정'} · 중요도: {session.priority} · 시간:{' '}
              {sessionDurationLabel(session)} · 거리: {sessionDistanceLabel(session)} · RPE:{' '}
              {session.targetRpe ?? '미정'} · 강도 라벨: {session.intensityLabel ?? '미지정'}
            </p>
            <p>
              목표 페이스: {paceTargetLabel(session.paceTarget)} · 목표 심박:{' '}
              {heartRateTargetLabel(session.heartRateTarget)}
            </p>
            <p>
              잠금: 날짜 {session.locks.date ? '켜짐' : '꺼짐'}, 시각{' '}
              {session.locks.time ? '켜짐' : '꺼짐'}, 강도{' '}
              {session.locks.intensity ? '켜짐' : '꺼짐'}
            </p>
            <p>참석 잠금: {attendanceLockLabel(session.locks.attendance)}</p>
            <p>
              시간 범위: {rangePresenceLabel(session.durationRange)} · 거리 범위:{' '}
              {rangePresenceLabel(session.distanceRange)}
            </p>
            <p>메모: {session.notes || '없음'}</p>
            <ol>
              {session.steps.map((step) => (
                <li key={step.id}>
                  {step.kind} · {step.repetitions}회 ·{' '}
                  {step.durationSeconds === null ? '시간 미정' : `${step.durationSeconds}초`} ·{' '}
                  {step.distanceMeters === null ? '거리 미정' : `${step.distanceMeters}m`}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </div>
  );
}
