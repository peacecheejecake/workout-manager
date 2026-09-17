import { useQuery } from '@tanstack/react-query';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import type { PlanSnapshot } from '@workout/contracts/planning';
import {
  periodSummarySchema,
  periodSummaryQuerySchema,
  periodSummaryDefinition,
  type PeriodSummary,
} from '@workout/contracts/period-summary';
import { Button } from '@workout/ui-foundation/button';
import styles from './period-summary-panel.module.css';

type Props = {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  head: PlanSnapshot | null | undefined;
  periodId: string | null;
  onSelectSession(id: string): void;
};
export function PeriodSummaryPanel({
  athleteId,
  sessionId,
  transport,
  head,
  periodId,
  onSelectSession,
}: Props) {
  const period = head?.draft.periods.find((entry) => entry.id === periodId);
  const parsed = periodSummaryQuerySchema.safeParse({ planVersionId: head?.id, periodId });
  const request = period && parsed.success ? parsed.data : null;
  const summary = useQuery({
    queryKey: ['planning-period-summary', athleteId, sessionId, request],
    enabled: request !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!request) throw new Error('UNAVAILABLE');
      const response = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/plans/versions/${encodeURIComponent(request.planVersionId)}/periods/${encodeURIComponent(request.periodId)}/summary`,
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (response.status !== 200) throw new Error('READ_FAILED');
      const result = periodSummarySchema.parse(response.body);
      if (
        result.planVersion.id.toLowerCase() !== request.planVersionId ||
        result.period.id !== request.periodId
      )
        throw new Error('MISMATCH');
      return result;
    },
  });
  if (periodId === null) return null;
  return (
    <section aria-label="저장된 기간 요약" className={styles.panel}>
      <h2>저장된 기간 요약</h2>
      <p>저장된 계획 기준입니다. 저장하지 않은 초안 변경은 이 요약에 반영되지 않습니다.</p>
      {head === undefined ? (
        <p role="status">저장된 계획을 확인한 뒤 요약을 조회합니다.</p>
      ) : !period ? (
        <p>선택한 기간이 저장된 계획에 없습니다. 새 기간은 저장 후 조회할 수 있습니다.</p>
      ) : !request ? (
        <p role="alert">기간 조회 식별자가 유효하지 않습니다.</p>
      ) : (
        <>
          <Button
            variant="secondary"
            disabled={summary.isFetching}
            onClick={() => void summary.refetch()}
          >
            기간 요약 다시 확인
          </Button>
          {summary.isFetching ? (
            <p role="status">기간 요약을 확인하는 중입니다.</p>
          ) : summary.isError ? (
            <p role="alert">
              기간 요약을 확인하지 못했습니다. 이전 결과를 표시하지 않습니다. 다시 확인해 주세요.
            </p>
          ) : summary.data ? (
            <Summary data={summary.data} onSelectSession={onSelectSession} />
          ) : null}
        </>
      )}
    </section>
  );
}
function Metric({
  label,
  metric,
  unit,
}: {
  label: string;
  metric: PeriodSummary['planned']['distanceMeters'];
  unit: string;
}) {
  return (
    <p>
      {label}: {metric.value === null ? '미정' : `${metric.value} ${unit}`} · 알려진{' '}
      {metric.knownCount}개 · 미정 {metric.missingCount}개
    </p>
  );
}
function PlannedMetric({
  label,
  metric,
  target,
  unit,
}: {
  label: string;
  metric: PeriodSummary['planned']['distanceMeters'];
  target: NonNullable<PeriodSummary['planned']['targets']>['distanceMeters'] | undefined;
  unit: string;
}) {
  if (target === undefined) return <Metric label={label} metric={metric} unit={unit} />;
  const value =
    target.min === null || target.max === null
      ? '미정'
      : target.min === target.max
        ? `${target.min} ${unit}`
        : `${target.min}–${target.max} ${unit}`;
  return (
    <p>
      {label}: {value} · 알려진 {target.knownCount}개 · 미정 {target.missingCount}개 · 범위 목표{' '}
      {target.rangeCount}개{target.knownCount > 0 && target.missingCount > 0 ? ' · 부분 합계' : ''}
    </p>
  );
}
const durationLabels = {
  timer: '타이머 시간 (timer)',
  elapsed: '경과 시간 (elapsed)',
  moving: '이동 시간 (moving)',
  unknown: '정의 미확인 시간 (unknown)',
} as const;
function Summary({
  data,
  onSelectSession,
}: {
  data: PeriodSummary;
  onSelectSession(id: string): void;
}) {
  return (
    <>
      <p>
        저장 버전 {data.planVersion.version} · {data.planVersion.title} · {data.period.title}
      </p>
      <p>
        {data.period.startDate}부터 {data.period.endDateExclusive} 미포함 · {data.period.timezone}
      </p>
      {data.currentPlanVersionId?.toLowerCase() !== data.planVersion.id.toLowerCase() ? (
        <p role="status">
          조회한 저장 버전과 서버의 현재 계획이 다릅니다. 이 요약은 표시된 저장 버전 기준입니다.
        </p>
      ) : null}
      <div className={styles.totals}>
        <section aria-label="기간 계획 합계">
          <h3>계획</h3>
          <p>계획 세션 {data.planned.count}개</p>
          <PlannedMetric
            label="거리"
            metric={data.planned.distanceMeters}
            target={data.planned.targets?.distanceMeters}
            unit="m"
          />
          <PlannedMetric
            label="계획 시간"
            metric={data.planned.durationSeconds}
            target={data.planned.targets?.durationSeconds}
            unit="초"
          />
          <p>{periodSummaryDefinition.planned}</p>
        </section>
        <section aria-label="기간 실제 합계">
          <h3>실제 관측</h3>
          {data.actual.status === 'unavailable' ? (
            <p>
              이 기간은 실제 활동 집계에서 지원하지 않는 달력 범위입니다. 계획 값과 실제 0을
              동일하게 취급하지 않습니다.
            </p>
          ) : (
            <>
              <p>실제 활동 {data.actual.totals.count}개</p>
              <Metric label="거리" metric={data.actual.totals.distanceMeters} unit="m" />
              {Object.entries(data.actual.totals.durationSeconds).map(([kind, metric]) => (
                <Metric
                  key={kind}
                  label={durationLabels[kind as keyof typeof durationLabels]}
                  metric={metric}
                  unit="초"
                />
              ))}
              <p>
                출처: FIT {data.actual.totals.sources.fit}개 · 테스트 자료{' '}
                {data.actual.totals.sources.fixture}개 · 수동 입력{' '}
                {data.actual.totals.sources.manual}개 · 사용자 정정{' '}
                {data.actual.totals.overlayCount}개
              </p>
            </>
          )}
          <p>{periodSummaryDefinition.actual} 과거 실제 활동의 스냅샷이 아닙니다.</p>
        </section>
      </div>
      <h3>주요 세션</h3>
      <p>{periodSummaryDefinition.keySessions}</p>
      {data.keySessions.length ? (
        <ul>
          {data.keySessions.map((session) => (
            <li key={session.id}>
              <Button variant="secondary" onClick={() => onSelectSession(session.id)}>
                주요 세션: {session.title}
              </Button>{' '}
              · {session.date}
            </li>
          ))}
        </ul>
      ) : (
        <p>중요도가 높음인 계획 세션이 없습니다.</p>
      )}
      <p>
        전체 계정에서 기간 미배정 활동 {data.unplacedActivityCount}개 · 시작 시각이 없어 이 기간에
        배정하지 않습니다.
      </p>
      <p>{periodSummaryDefinition.coverage}</p>
      <p>{periodSummaryDefinition.duration}</p>
      <p>
        관측 시각: <time dateTime={data.observedAt}>{data.observedAt}</time>
      </p>
      <details>
        <summary>관측 기준 확인</summary>
        <p>
          정의 {data.definitionVersion} · 전체 활동 {data.dataRevision.activities.count}개 · 수정
          번호 합계 {data.dataRevision.activities.revisionSum}
        </p>
        <p>계획 버전 ID {data.planVersion.id}</p>
      </details>
    </>
  );
}
