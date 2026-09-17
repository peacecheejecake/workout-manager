import {
  compareSessionDistance,
  type SessionActual,
  type SessionActuals,
} from '@workout/contracts/session-actuals';

export type PlannedActualsState =
  | { state: 'loading' | 'error' | 'stale' | 'unsaved' }
  | { state: 'ready'; read: SessionActuals; sessions: ReadonlyMap<string, SessionActual> };
export const quantity = (value: number) =>
  value.toLocaleString('ko-KR', { maximumSignificantDigits: 15 });
const durationLabels = {
  timer: '타이머 시간',
  elapsed: '경과 시간',
  moving: '이동 시간',
  unknown: '정의 미확인 시간',
} as const;
function unavailable(state: PlannedActualsState) {
  switch (state.state) {
    case 'loading':
      return '연결 실적 조회 중';
    case 'error':
      return '연결 실적 조회 실패';
    case 'stale':
      return '연결 실적 버전 불일치';
    case 'unsaved':
      return '저장 전 세션';
    case 'ready':
      return null;
  }
}
export function PlannedActualCell({
  state,
  sessionId,
  column,
}: {
  state: PlannedActualsState;
  sessionId: string;
  column: 'actual' | 'comparison';
}) {
  if (state.state !== 'ready') return unavailable(state);
  const session = state.sessions.get(sessionId);
  if (!session) return '저장 전 세션';
  if (column === 'comparison') return <DistanceComparison session={session} />;
  const actual = session.actual;
  if (actual.count === 0) return '연결된 활동 없음';
  const distance = actual.distanceMeters;
  return (
    <>
      <p>연결된 활동 {actual.count}개</p>
      <p>
        거리 {distance.value === null ? '미보고' : `${quantity(distance.value)} m`}
        {distance.knownCount > 0 && distance.missingCount > 0 ? ' · 부분 합계' : ''} · 알려진{' '}
        {distance.knownCount}개 · 미보고 {distance.missingCount}개
      </p>
      {(Object.keys(durationLabels) as (keyof typeof durationLabels)[]).map((kind) => {
        const metric = actual.durationSeconds[kind];
        if (metric.knownCount + metric.missingCount === 0) return null;
        return (
          <p key={kind}>
            {durationLabels[kind]} ({kind}):{' '}
            {metric.value === null ? '미보고' : `${quantity(metric.value)} 초`}
            {metric.knownCount > 0 && metric.missingCount > 0 ? ' · 부분 합계' : ''} · 알려진{' '}
            {metric.knownCount}개 · 미보고 {metric.missingCount}개
          </p>
        );
      })}
    </>
  );
}
function DistanceComparison({ session }: { session: SessionActual }) {
  const comparison = compareSessionDistance(session);
  let label: string;
  switch (comparison.status) {
    case 'no_linked_activities':
      label = '연결된 활동 없음';
      break;
    case 'missing_actual':
      label = '거리 미보고 · 비교 불가';
      break;
    case 'partial_actual':
      label = '거리 일부 미보고 · 비교 불가';
      break;
    case 'missing_target':
      label = '저장 목표 미정 · 비교 불가';
      break;
    case 'exact':
      label = `거리 차이 ${comparison.deltaMeters > 0 ? '+' : ''}${quantity(comparison.deltaMeters)} m`;
      break;
    case 'range':
      label =
        comparison.position === 'within'
          ? '목표 범위 안'
          : comparison.position === 'below'
            ? `하한보다 ${quantity(-comparison.distanceToRangeMeters)} m 부족`
            : `상한보다 ${quantity(comparison.distanceToRangeMeters)} m 초과`;
      break;
  }
  const target = session.distanceTarget;
  return (
    <>
      <p>
        저장 목표{' '}
        {target === null
          ? '미정'
          : target.minMeters === target.maxMeters
            ? `${quantity(target.minMeters)} m`
            : `${quantity(target.minMeters)}–${quantity(target.maxMeters)} m`}
      </p>
      <p>{label}</p>
    </>
  );
}
