import { useState } from 'react';
import { planDraftSchema, type PlanDraft, type PeriodDraft } from '@workout/contracts/planning';
import { evaluatePlanConstraints } from '@workout/contracts/planning-constraints';
import { Button } from '@workout/ui-foundation/button';
import styles from './period-constraints.module.css';
export function PeriodConstraintsSummary({
  constraints,
}: {
  constraints: PeriodDraft['constraints'];
}) {
  if (constraints === undefined) return <p>직접 제약 미지정 (이전 형식에 값 없음)</p>;
  if (!constraints.unavailableDates.length && !constraints.dailyTimeLimits.length)
    return <p>직접 제약 없음 (명시적으로 비움)</p>;
  return (
    <details className={styles.editor}>
      <summary>
        직접 제약: 운동 불가 {constraints.unavailableDates.length}일 · 가용 시간{' '}
        {constraints.dailyTimeLimits.length}일
      </summary>
      <ul>
        {constraints.unavailableDates.map((date) => (
          <li key={date}>{date} · 운동 불가</li>
        ))}
        {constraints.dailyTimeLimits.map((item) => (
          <li key={`limit:${item.date}`}>
            {item.date} · 가용 시간{' '}
            {Number.isFinite(item.availableSeconds)
              ? `${item.availableSeconds}초`
              : '미입력 (수정 필요)'}
          </li>
        ))}
      </ul>
    </details>
  );
}
export function PlanConstraintsReport({
  plan,
  periodId = null,
}: {
  plan: PlanDraft;
  periodId?: string | null;
}) {
  const [page, setPage] = useState(0);
  const valid = planDraftSchema.safeParse(plan);
  if (!valid.success)
    return (
      <section aria-label="기간 제약 판정" className={styles.report}>
        <h4>기간 제약 판정</h4>
        <p>
          초안 입력 오류로 제약을 판정할 수 없습니다. 날짜·가용 시간·기간 구조를 먼저 수정하세요.
        </p>
      </section>
    );
  const period = periodId ? plan.periods.find((item) => item.id === periodId) : null;
  if (periodId && !period) return <p>선택한 기간을 찾을 수 없어 제약을 판정하지 않습니다.</p>;
  const days = evaluatePlanConstraints(valid.data).filter(
    (day) => !period || (day.date >= period.startDate && day.date < period.endDateExclusive),
  );
  const pages = Math.max(1, Math.ceil(days.length / 20)),
    shownPage = Math.min(page, pages - 1);
  const ancestorIds = new Set<string>();
  let parentId = period?.parentId;
  while (parentId) {
    ancestorIds.add(parentId);
    parentId = plan.periods.find((item) => item.id === parentId)?.parentId;
  }
  const name = (id: string) =>
    `${plan.periods.find((item) => item.id === id)?.level ?? '기간'} · ${plan.periods.find((item) => item.id === id)?.title ?? '미확인'}${period ? (period.id === id ? ' · 직접 지정' : ancestorIds.has(id) ? ' · 상위 기간에서 적용' : ' · 하위 기간에서 적용') : ''}`;
  return (
    <section aria-label="기간 제약 판정" className={styles.report}>
      <h4>기간 제약 판정{period ? ` · ${period.title}` : ''}</h4>
      <p>
        운동 불가 날짜는 합집합, 가용량은 적용되는 기간 중 최솟값입니다. 출처 조건은 읽기
        전용입니다. 알려진 세션 시간을 한 번씩 합산하며 미정 시간은 추정하지 않습니다.
      </p>
      <p>
        충돌 {days.filter((day) => day.status === 'conflict').length}일 · 가용량 충족 여부 미확인{' '}
        {days.filter((day) => day.status === 'unknown').length}일 · 제약 날짜 {days.length}일
      </p>
      <p>
        충돌이 있어도 수동 계획은 확인 후 저장할 수 있습니다. 세션을 자동 이동·단축·삭제하지 않으며
        충돌 없음은 실제 휴식·수행의 증거가 아닙니다.
      </p>
      {!days.length ? <p>이 범위에 지정된 제약 날짜가 없습니다.</p> : null}
      <ol className={styles.rows}>
        {days.slice(shownPage * 20, (shownPage + 1) * 20).map((day) => (
          <li key={day.date} aria-label={`제약 날짜 ${day.date}`} data-status={day.status}>
            <h5>
              {day.date} ·{' '}
              {day.status === 'conflict'
                ? '충돌'
                : day.status === 'unknown'
                  ? '가용량 충족 여부 미확인'
                  : '알려진 계획의 충돌 없음'}
            </h5>
            <p>
              계획 세션 {day.sessionIds.length}개 ·{' '}
              {day.rangeDurationSessionIds.length ? '단일값 계획 시간' : '알려진 계획 시간'}{' '}
              {day.knownDurationSeconds}초 · 시간 미정 세션 {day.unknownDurationSessionIds.length}개
              · 적용 가용량 {day.availableSeconds === null ? '미지정' : `${day.availableSeconds}초`}
            </p>
            {day.durationRangeSeconds && day.rangeDurationSessionIds.length > 0 ? (
              <p>
                알려진 계획 시간 범위 {day.durationRangeSeconds.min}–{day.durationRangeSeconds.max}
                초 · 범위 시간 세션 {day.rangeDurationSessionIds.length}개. 단일값 시간과 범위
                시간을 한 번씩 합산했습니다.
              </p>
            ) : null}
            {day.possibleTimeExcess ? (
              <p>계획 시간 범위의 상한이 가용량을 초과할 수 있어 충족 여부가 미확인입니다.</p>
            ) : null}
            {day.unavailableConflict ? <p>운동 불가 날짜에 계획 세션이 있습니다.</p> : null}
            {day.exceedsAvailableTime ? (
              <p>
                {day.rangeDurationSessionIds.length
                  ? '알려진 계획 시간 범위의 하한이 가용량을 초과합니다.'
                  : '알려진 계획 시간이 가용량을 초과합니다.'}
              </p>
            ) : null}
            <p>
              운동 불가 출처:{' '}
              {day.unavailablePeriodIds.length
                ? day.unavailablePeriodIds.map(name).join(', ')
                : '없음'}
            </p>
            <ul>
              {day.timeLimitSources.map((source) => (
                <li key={source.periodId}>
                  가용량 출처: {name(source.periodId)} · {source.availableSeconds}초
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {days.length ? (
        <details>
          <summary>제약 출처 식별자 확인</summary>
          <ul>
            {[
              ...new Set(
                days.flatMap((day) => [
                  ...day.unavailablePeriodIds,
                  ...day.timeLimitSources.map((source) => source.periodId),
                ]),
              ),
            ].map((id) => (
              <li key={id}>
                {name(id)} · ID {id}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {pages > 1 ? (
        <div className={styles.actions}>
          <span>
            제약 판정 {shownPage + 1} / {pages}페이지
          </span>
          <Button
            variant="secondary"
            disabled={shownPage === 0}
            onClick={() => setPage(shownPage - 1)}
          >
            제약 판정 이전 페이지
          </Button>
          <Button
            variant="secondary"
            disabled={shownPage + 1 >= pages}
            onClick={() => setPage(shownPage + 1)}
          >
            제약 판정 다음 페이지
          </Button>
        </div>
      ) : null}
    </section>
  );
}
