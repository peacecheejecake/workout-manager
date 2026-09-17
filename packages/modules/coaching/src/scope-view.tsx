import type { PlanSnapshot } from '@workout/contracts/planning';
import type { CoachingReviewScope } from '@workout/contracts/coaching-threads';
import { deriveScopeContext } from './scope-context';
export function ScopeView({ plan, scope }: { plan: PlanSnapshot; scope: CoachingReviewScope }) {
  const context = deriveScopeContext(plan, scope);
  if (!context) return <p role="alert">저장된 계획에서 상담 대상을 확인할 수 없습니다.</p>;
  return (
    <section aria-label="저장된 상담 맥락" data-plan-version-id={plan.id}>
      <h3>{context.targetLabel}</h3>
      <p>
        저장된 계획 v{plan.version} · {plan.draft.title} · {plan.draft.timezone}
      </p>
      <p>
        아래 내용은 이 상담에 연결된 불변 계획 버전입니다. 현재 계획 변경은 여기에 반영되지
        않습니다.
      </p>
      <ul>
        {context.periods.map((period) => (
          <li key={period.id}>
            <h4>
              {period.level} · {period.title}
            </h4>
            <p>
              {period.startDate} ~ {period.endDateExclusive} (종료일 제외) · {period.timezone}
            </p>
            {period.constraints === undefined ? (
              <p>기간 제약: 미기록</p>
            ) : (
              <>
                <p>
                  운동 불가 날짜:{' '}
                  {period.constraints.unavailableDates.length
                    ? period.constraints.unavailableDates.join(', ')
                    : '명시된 날짜 없음'}
                </p>
                <p>
                  가용 시간 (날짜별 시간량):{' '}
                  {period.constraints.dailyTimeLimits.length
                    ? period.constraints.dailyTimeLimits
                        .map((value) => `${value.date}: ${value.availableSeconds}초`)
                        .join(', ')
                    : '명시된 한도 없음'}
                </p>
              </>
            )}
          </li>
        ))}
      </ul>
      <ul>
        {context.sessions.map((session) => (
          <li key={session.id}>
            <h4>{session.title}</h4>
            <p>
              {session.date} · 시작 시각 {session.localStartTime ?? '미정'}
            </p>
            <p>
              계획 거리:{' '}
              {session.distanceRange
                ? `${session.distanceRange.minMeters}~${session.distanceRange.maxMeters}m`
                : session.distanceMeters === null
                  ? '미정'
                  : `${session.distanceMeters}m`}{' '}
              · 계획 시간:{' '}
              {session.durationRange
                ? `${session.durationRange.minSeconds}~${session.durationRange.maxSeconds}초`
                : session.durationSeconds === null
                  ? '미정'
                  : `${session.durationSeconds}초`}
            </p>
            <p>
              계획 잠금: 날짜 {session.locks.date ? '켜짐' : '꺼짐'} · 시각{' '}
              {session.locks.time ? '켜짐' : '꺼짐'} · 강도{' '}
              {session.locks.intensity ? '켜짐' : '꺼짐'} · 참석{' '}
              {session.locks.attendance === undefined
                ? '미기록'
                : session.locks.attendance
                  ? '켜짐'
                  : '꺼짐'}
            </p>
          </li>
        ))}
      </ul>
      <p>
        기간 제약과 계획 잠금만 표시합니다. 더 넓은 사용자 제약과 AI 검토는 아직 연결되지
        않았습니다. 실제 수행이나 완료를 의미하지 않습니다.
      </p>
    </section>
  );
}
