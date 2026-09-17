import { lazy, Suspense } from 'react';
import {
  dashboardDefinition,
  type DashboardReadModel,
  type DashboardWindow,
} from '@workout/contracts/dashboard';
import {
  sessionDistanceBounds,
  sessionDurationBounds,
  type PlannedSession,
} from '@workout/contracts/planning';
import type { DashboardLinks } from './dashboard-workspace';
import { metricText, plannedMetricText, boundsText } from './format';
import { DashboardLayoutEditor } from './dashboard-layout-editor';
import { useDashboardLayout } from './dashboard-layout-lifetime';
const DistanceView = lazy(() =>
  import('./distance-view').then((module) => ({ default: module.DistanceView })),
);
const durationLabels = {
  timer: '타이머 시간 (timer)',
  elapsed: '경과 시간 (elapsed)',
  moving: '이동 시간 (moving)',
  unknown: '정의 미확인 시간 (unknown)',
};
import styles from './dashboard.module.css';

function WindowMetrics({
  label,
  value,
  actualHref,
}: {
  label: string;
  value: DashboardWindow;
  actualHref: string;
}) {
  return (
    <section className={styles.card} aria-label={label}>
      <h3>{label}</h3>
      <h4>실제 수행 · {value.actual.count}개</h4>
      <p>거리: {metricText(value.actual.distanceMeters, 'm')}</p>
      <dl>
        {(['timer', 'elapsed', 'moving', 'unknown'] as const).map((kind) => (
          <div key={kind}>
            <dt>{durationLabels[kind]}</dt>
            <dd>{metricText(value.actual.durationSeconds[kind], '초')}</dd>
          </div>
        ))}
      </dl>
      <p>
        출처: FIT {value.actual.sources.fit}개 · 테스트 자료 {value.actual.sources.fixture}개 · 수동
        기록 {value.actual.sources.manual}개 · 사용자 정정 {value.actual.overlayCount}개
      </p>
      <p>
        <a href={actualHref}>{label} 실제 활동 보기</a>
      </p>
      <h4>계획 · {value.planned.count}개</h4>
      <p>
        거리:{' '}
        {plannedMetricText(
          value.planned.distanceMeters,
          value.planned.targets?.distanceMeters,
          'm',
        )}
      </p>
      <p>
        시간:{' '}
        {plannedMetricText(
          value.planned.durationSeconds,
          value.planned.targets?.durationSeconds,
          '초',
        )}
      </p>
      <p>
        체크인 {value.checkInCount}개 · 보고가 있는 날짜 {value.checkInDays}일
      </p>
    </section>
  );
}
function Sessions({
  label,
  sessions,
  links,
}: {
  label: string;
  sessions: PlannedSession[];
  links: DashboardLinks;
}) {
  return (
    <section aria-label={label}>
      <h3>{label}</h3>
      {sessions.length === 0 ? (
        <p>등록된 계획 세션이 없습니다. 확인된 휴식이나 실제 수행을 뜻하지 않습니다.</p>
      ) : (
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <a href={links.planDay(session.date)}>
                {session.date} · {session.title}
              </a>
              <p>
                {session.localStartTime ?? '시간 미정'} · {session.sport} · 계획 거리{' '}
                {boundsText(sessionDistanceBounds(session), 'm')} · 계획 시간{' '}
                {boundsText(sessionDurationBounds(session), '초')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
export function DashboardOverview({
  model,
  links,
}: {
  model: DashboardReadModel;
  links: DashboardLinks;
}) {
  const layout = useDashboardLayout();
  return (
    <>
      <p>
        관측 시각: <time dateTime={model.observedAt}>{model.observedAt}</time>
      </p>
      <p>
        조회 기간: {model.period.from} ~ {model.period.toExclusive} (종료일 제외),{' '}
        {model.period.days}개 현지 날짜
      </p>
      <p>
        적용 시간대: {model.period.timezone} ·{' '}
        {model.period.timezoneSource === 'plan' ? '계획 시간대 적용' : '조회 시간대 적용'}
      </p>
      <p>
        선택한 기준일: {model.period.anchor}. 최근 {model.period.days}×24시간이 아닌 현지 달력
        날짜를 조회합니다.
      </p>
      <DashboardLayoutEditor
        {...layout}
        widgets={{
          plan: (
            <section className={styles.card} aria-label="현재 계획">
              <h2>현재 계획</h2>
              <p>
                {model.planVersion
                  ? `계획 버전 ${model.planVersion.version}`
                  : '저장된 계획이 없습니다.'}
              </p>
              {model.currentBlock ? (
                <>
                  <h3>
                    <a href={links.planBlock(model.currentBlock.id)}>{model.currentBlock.title}</a>
                  </h3>
                  <p>
                    {model.currentBlock.startDate} ~ {model.currentBlock.endDateExclusive} (종료일
                    제외)
                    {model.currentBlock.isPartial ? ' · 부분 Block' : ''}
                  </p>
                  <p>{model.currentBlock.intent}</p>
                </>
              ) : (
                <p>기준일에 해당하는 Block이 없습니다.</p>
              )}
              <Sessions label="기준일 계획 세션" sessions={model.todaySessions} links={links} />
              <Sessions label="가까운 계획 일정" sessions={model.upcomingSessions} links={links} />
              <p>향후 조회 종료일: {model.period.upcomingToExclusive} (제외)</p>
              <a href={links.planning}>계획 전체 보기</a>
            </section>
          ),
          'check-in': (
            <section className={styles.card} aria-label="최신 체크인">
              <h2>최신 체크인</h2>
              {model.latestCheckIn ? (
                <>
                  <p>
                    관측 시각: {model.latestCheckIn.values.observedAt} ·{' '}
                    {model.latestCheckIn.values.timezone}
                  </p>
                  <p>저장된 현지 날짜: {model.latestCheckIn.localDate}</p>
                  <p>
                    피로 {model.latestCheckIn.values.fatigue ?? '보고하지 않음'} · 불편감{' '}
                    {model.latestCheckIn.values.discomfort ?? '보고하지 않음'}
                  </p>
                  <p>부위: {model.latestCheckIn.values.bodyLocation ?? '보고하지 않음'}</p>
                  <p>{model.latestCheckIn.values.note ?? '메모 보고하지 않음'}</p>
                  <p>
                    출처: 사용자 자기 보고 · {model.latestCheckIn.definitionVersion} · 수정{' '}
                    {model.latestCheckIn.revision}
                  </p>
                  <a href={links.checkIn(model.latestCheckIn.id)}>이 체크인 상세 보기</a>
                </>
              ) : (
                <p>조회 범위에서 확인된 체크인이 없습니다.</p>
              )}
              <p>
                <a href={links.wellbeing}>체크인 작성·목록</a>
              </p>
            </section>
          ),
          'period-summary': (
            <section aria-label="기간별 계획과 실제">
              <h2>기간별 계획과 실제</h2>
              <p>{dashboardDefinition.coverage}</p>
              <p>
                직전 기간: {model.period.previousFrom} ~ {model.period.from} (종료일 제외)
              </p>
              <div className={styles.grid}>
                <WindowMetrics
                  label="현재 기간"
                  value={model.current}
                  actualHref={links.activityRange({
                    from: model.period.from,
                    toExclusive: model.period.toExclusive,
                    timezone: model.period.timezone,
                  })}
                />
                <WindowMetrics
                  label="직전 기간"
                  value={model.previous}
                  actualHref={links.activityRange({
                    from: model.period.previousFrom,
                    toExclusive: model.period.from,
                    timezone: model.period.timezone,
                  })}
                />
              </div>
              <p>
                날짜를 배정하지 못한 활동 {model.unplacedActivityCount}개. 날짜별 값에 임의 배정하지
                않습니다. 기간·날짜별 활동 링크에서도 시작 시각 미보고 활동은 제외합니다.
              </p>
              <a href={links.activities}>활동 목록 보기</a>
            </section>
          ),
          'daily-distance': (
            <Suspense fallback={<p role="status">날짜별 그래프와 표를 불러오고 있습니다.</p>}>
              <DistanceView days={model.days} links={links} timezone={model.period.timezone} />
            </Suspense>
          ),
        }}
      />
      <section className={styles.card} aria-label="확인할 수 없는 정보">
        <h2>아직 제공하지 않는 정보</h2>
        <p>AI 제안: 아직 제공하지 않습니다.</p>
        <p>제공자 지표·실제 훈련 부하: 확인할 수 없습니다.</p>
        <p>
          활동 자동 동기화가 구현되지 않아 마지막 성공 시각과 연결 최신 상태를 확인할 수 없습니다.
          OAuth 연결 승인은 동기화 성공이 아닙니다.
        </p>
      </section>
      <details>
        <summary>집계 정의·출처·제한</summary>
        <p>정의 {model.definitionVersion}</p>
        {Object.entries(dashboardDefinition)
          .filter(([name]) => name !== 'version')
          .map(([name, description]) => (
            <p key={name}>{description}</p>
          ))}
        <p>
          시간 정의: timer는 타이머 시간, elapsed는 경과 시간, moving은 이동 시간, unknown은 원본
          시간 정의 미확인입니다. 서로 합산하지 않습니다.
        </p>
        <p>
          원본 버전: 계획 {model.planVersion?.id ?? '없음'} · 활동{' '}
          {model.dataRevision.activities.count}개 / revision 합{' '}
          {model.dataRevision.activities.revisionSum} · 체크인 revision{' '}
          {model.dataRevision.checkIns}
        </p>
        <p>운동 허가·진단·회복 효능을 판단하는 화면이 아닙니다.</p>
      </details>
    </>
  );
}
