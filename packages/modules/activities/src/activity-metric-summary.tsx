import type { Activity, ActivityDetailsRead } from '@workout/contracts/activity';
import { calculateActivityPace } from '@workout/contracts/activity-metrics';
import { detailsMatchActivity } from './detail-projection';
import styles from './activity-metric-summary.module.css';

export type MetricSourceDetails =
  { state: 'loading' | 'error' | 'unavailable' } | { state: 'ready'; value: ActivityDetailsRead };
const durationLabels = {
  timer: '타이머 시간',
  elapsed: '경과 시간',
  moving: '이동 시간',
  unknown: '정의 미확인 시간',
};
const reasons = {
  unsupported_sport: '이 종목은 페이스 계산을 지원하지 않습니다.',
  unknown_duration_kind: '시간 정의가 없어 페이스를 계산하지 않습니다.',
  missing_duration: '시간 미보고',
  missing_distance: '거리 미보고',
  zero_duration: '시간이 0초여서 페이스를 계산하지 않습니다.',
  zero_distance: '거리가 0m여서 페이스를 계산하지 않습니다.',
  unrepresentable: '계산 가능한 수치 범위를 벗어났습니다.',
};
function Pace({ label, values }: { label: string; values: Activity['effective'] }) {
  const pace = calculateActivityPace(values);
  const rounded = pace.state === 'available' ? Math.round(pace.secondsPerKilometer) : null;
  const formatted =
    rounded === null
      ? null
      : `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
  return (
    <section aria-label={label}>
      <h4>{label}</h4>
      <p>
        거리 {values.distanceMeters === null ? '미보고' : `${values.distanceMeters}m`} ·{' '}
        {durationLabels[values.durationKind]}{' '}
        {values.durationSeconds === null ? '미보고' : `${values.durationSeconds}초`}
      </p>
      <p>
        {pace.state === 'available'
          ? pace.secondsPerKilometer < 1
            ? '계산 페이스: 1초 미만 /km'
            : `계산 페이스: ${formatted} /km (초 단위 반올림)`
          : `계산 페이스 미제공: ${reasons[pace.reason]}`}
      </p>
    </section>
  );
}
function HeartRate({ activity, source }: { activity: Activity; source: MetricSourceDetails }) {
  if (source.state === 'loading') return <p role="status">출처 심박 요약을 확인하고 있습니다.</p>;
  if (source.state === 'error')
    return <p role="alert">출처 심박 요약 조회 실패. 다시 확인하세요.</p>;
  if (source.state !== 'ready') return <p>출처 심박 요약을 확인할 수 없습니다.</p>;
  if (!detailsMatchActivity(activity, source.value))
    return <p role="alert">활동과 세부 기록의 출처·수정이 달라 심박 요약을 표시하지 않습니다.</p>;
  const details = source.value.details;
  if (details === null) return <p>출처에 세션 심박 요약이 없습니다.</p>;
  if (details.schemaVersion === 1) return <p>이전 형식에 요약 없음</p>;
  const heartRate = details.sessionSummary;
  return (
    <>
      <p>
        평균 심박:{' '}
        {heartRate.averageHeartRateBpm === null ? '미보고' : `${heartRate.averageHeartRateBpm} bpm`}
      </p>
      <p>
        최대 심박:{' '}
        {heartRate.maximumHeartRateBpm === null ? '미보고' : `${heartRate.maximumHeartRateBpm} bpm`}
      </p>
      <p>
        출처가 제공한 세션 요약입니다. 레코드·랩에서 추정하거나 정정된 거리·시간으로 바꾸지
        않습니다.
      </p>
    </>
  );
}
export function ActivityMetricSummary({
  activity,
  sourceDetails,
}: {
  activity: Activity;
  sourceDetails: MetricSourceDetails;
}) {
  return (
    <section aria-label="활동 거리·시간·페이스·심박 요약" className={styles.summary}>
      <h3>거리·시간·페이스·심박</h3>
      <div className={styles.values}>
        <Pace label="원본 값의 페이스" values={activity.original} />
        <Pace label="현재 값의 페이스" values={activity.effective} />
        <section aria-label="출처 세션 심박 요약">
          <h4>출처 세션 심박 요약</h4>
          <HeartRate activity={activity} source={sourceDetails} />
        </section>
      </div>
      <p>페이스는 표시된 시간 ÷ 거리로 계산하며 시간 정의가 다르면 직접 비교할 수 없습니다.</p>
    </section>
  );
}
