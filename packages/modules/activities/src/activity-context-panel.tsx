import { useId } from 'react';
import type { ActivityContext } from '@workout/contracts/activity-context';
import { sessionDistanceBounds, sessionDurationBounds } from '@workout/contracts/planning';
import type { DashboardMetric } from '@workout/contracts/dashboard';
import { sourceLabels } from './browser-records';
const durationLabels = {
  timer: '타이머 시간 (timer)',
  elapsed: '경과 시간 (elapsed)',
  moving: '이동 시간 (moving)',
  unknown: '정의 미확인 시간 (unknown)',
};
function metric(value: DashboardMetric, unit: string) {
  return `${value.value === null ? '미확인' : `${value.value}${unit}`} · 알려진 ${value.knownCount}개 · 미확인 ${value.missingCount}개`;
}
function measurement(value: number | null, unit: string) {
  return value === null ? '미확인' : `${value}${unit}`;
}
function plannedMeasurement(bounds: { min: number; max: number } | null, unit: string) {
  if (bounds === null) return '미확인';
  return bounds.min === bounds.max ? `${bounds.min}${unit}` : `${bounds.min}–${bounds.max}${unit}`;
}
export function ActivityContextPanel({
  context,
  planDayHref,
  linkedBlockHref,
}: {
  context: ActivityContext;
  linkedBlockHref?: (versionId: string, blockId: string) => string;
  planDayHref?: (date: string) => string;
}) {
  const plan = context.planContext;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId}>관측·계산</h3>
      <p>
        출처: 이 활동의 기록 값(출처 {sourceLabels[context.activity.source.kind]} · 원본 수정{' '}
        {context.activity.source.revision})과 연결 계획 버전에서 계산한 관측값입니다. 추정이
        아닙니다.
      </p>
      <p>
        관측 시각: <time dateTime={context.observedAt}>{context.observedAt}</time> · 정의{' '}
        {context.definitionVersion}
      </p>
      <p>
        {context.activity.userReport?.sessionRpe === null ||
        context.activity.userReport?.sessionRpe === undefined
          ? '보고한 RPE: 없음. 보고하지 않은 값을 0으로 채우지 않습니다.'
          : `보고한 RPE: ${context.activity.userReport.sessionRpe} · 사용자 자기 보고 · 보고 시각 ${context.activity.userReport.rpeReportedAt ?? '미확인'}`}
      </p>
      {plan.status === 'unlinked' ? (
        <p>연결한 계획이 없습니다. 날짜나 종목이 비슷해도 계획 연결을 추정하지 않습니다.</p>
      ) : plan.status === 'unavailable' ? (
        <p>
          {plan.reason === 'unsupported_calendar'
            ? '기록 또는 계획에 지원 범위를 벗어난 날짜가 있어 기간 합계를 계산할 수 없습니다. 원본 날짜를 다른 날짜나 0으로 바꾸지 않습니다.'
            : '저장된 계획 연결은 있지만 해당 계획을 확인할 수 없습니다. 다른 버전으로 대체하지 않습니다.'}
        </p>
      ) : (
        <>
          <p>
            연결 계획: {plan.planVersion.title} · 버전 {plan.planVersion.version} ·{' '}
            {plan.planVersion.id}
          </p>
          <p>
            {plan.currentPlanVersionId === plan.planVersion.id
              ? '현재 계획 버전에 연결되어 있습니다.'
              : '과거 계획 버전에 연결되어 있습니다. 현재 계획으로 대체하지 않습니다.'}
          </p>
          <p>
            계획 세션: {plan.session.title} · {plan.session.date} ·{' '}
            {plan.session.localStartTime ?? '시간 미정'} · {plan.session.sport}
          </p>
          <p>
            연결 Block: {plan.block.title} · {plan.block.startDate} ~ {plan.block.endDateExclusive}{' '}
            (종료일 제외) · {plan.block.timezone}
            {plan.block.isPartial ? ' · 부분 Block' : ''}
          </p>
          <p>Block 시간대에서 본 실제 활동 날짜: {plan.actualLocalDate ?? '미확인'}</p>
          <p>
            {plan.blockMembership === 'included'
              ? '이 활동은 연결 Block의 날짜 범위에 포함되어 부분 합계에 반영됩니다.'
              : plan.blockMembership === 'outside'
                ? '이 활동은 연결 Block의 날짜 범위 밖에 있어 해당 Block 부분 합계에 기여하지 않습니다.'
                : '실제 시작 시각을 확인할 수 없어 해당 Block 부분 합계에 기여하지 않습니다.'}
          </p>
          {plan.blockMembership === 'included' ? (
            <p>
              이 활동의 합계 기여: 거리{' '}
              {measurement(context.activity.effective.distanceMeters, 'm')}
              {' · '}시간 {measurement(context.activity.effective.durationSeconds, '초')}
              {' · '}
              {durationLabels[context.activity.effective.durationKind]}. 미확인 값은 합산하지
              않습니다.
            </p>
          ) : null}
          {linkedBlockHref ? (
            <p>
              <a href={linkedBlockHref(plan.planVersion.id, plan.block.id)}>
                이 Block에 명시적으로 연결된 활동 보기
              </a>
            </p>
          ) : null}
          {plan.currentPlanVersionId === plan.planVersion.id && planDayHref ? (
            <p>
              <a href={planDayHref(plan.session.date)}>현재 계획의 해당 날짜 보기</a>
            </p>
          ) : null}
          <section aria-label="계획과 실제의 단순 비교">
            <h4>계획과 실제의 단순 비교</h4>
            <p>
              거리: 실제 {measurement(plan.distanceComparison.actual, 'm')} · 계획{' '}
              {plannedMeasurement(sessionDistanceBounds(plan.session), 'm')}
            </p>
            <p>
              {plan.distanceComparison.plannedRange
                ? `거리 목표 범위: ${{ below: '범위 미만', within: '범위 안', above: '범위 초과', unknown: '실제 거리 미확인' }[plan.distanceComparison.rangePosition ?? 'unknown']} · 단일 거리 차이는 계산하지 않습니다.`
                : plan.distanceComparison.delta === null
                  ? '거리 차이를 계산할 수 없습니다. 실제 또는 계획 거리가 미확인입니다.'
                  : `거리 차이 (실제 − 계획): ${plan.distanceComparison.delta}m`}
            </p>
            <p>
              시간: 실제 {measurement(plan.durationComparison.actual, '초')} ·{' '}
              {durationLabels[plan.durationComparison.actualKind]} · 계획{' '}
              {plannedMeasurement(sessionDurationBounds(plan.session), '초')}
            </p>
            <p>
              계획 시간의 측정 정의가 없어 시간을 비교할 수 없습니다. 시간 차이를 계산하지 않습니다.
            </p>
          </section>
          <section aria-label="연결 Block의 관측 부분 합계">
            <h4>연결 Block의 관측 부분 합계</h4>
            <p>
              이 Block의 시간대·날짜 범위에 있는 모든 종목의 기록입니다. 다른 계획에 연결되었거나
              계획 연결이 없는 기록도 포함합니다.
            </p>
            <p>
              관측 활동 {plan.blockActual.count}개 · 거리{' '}
              {metric(plan.blockActual.distanceMeters, 'm')}
            </p>
            <dl>
              {(['timer', 'elapsed', 'moving', 'unknown'] as const).map((kind) => (
                <div key={kind}>
                  <dt>{durationLabels[kind]}</dt>
                  <dd>{metric(plan.blockActual.durationSeconds[kind], '초')}</dd>
                </div>
              ))}
            </dl>
            <p>
              출처: FIT {plan.blockActual.sources.fit}개 · 테스트 자료{' '}
              {plan.blockActual.sources.fixture}개 · 수동 기록 {plan.blockActual.sources.manual}개 ·
              사용자 정정 {plan.blockActual.overlayCount}개
            </p>
            <p>
              수집 완전성은 미확인입니다. 알려진 값만 합산하며 누락을 0으로 채우지 않습니다. 위
              합계는 이 활동 한 건의 값이 아닙니다.
            </p>
          </section>
        </>
      )}
      <p>
        관측값과 단순 차이이며, 계획 이행률·기여율·훈련 부하·부상 위험·회복 효능을 계산하지
        않습니다. 계획 연결은 실제 수행의 추가 증명이 아닙니다.
      </p>
    </section>
  );
}
