import { useLayoutEffect, useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  planSnapshotSchema,
  type PlanRead,
  type PlanSnapshot,
  type PlannedSession,
  type PeriodDraft,
} from '@workout/contracts/planning';
import { idSchema } from '@workout/contracts/primitives';
import { transportReplySchema, type AuthenticatedTransport } from '@workout/contracts/core';
import { Button } from '@workout/ui-foundation/button';
import { updatePlannerSearch } from './lens';
import { PeriodConstraintsSummary } from './period-constraints-summary';
import { periodPriorityLabel } from './period-priority';
import { comparePlanHistory } from './plan-history-comparison';
import styles from './plan-history-panel.module.css';

export interface PlanHistoryPanelProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  search: string;
  onSearchChange(query: string): void;
  current: PlanRead | undefined;
}
const versionIdSchema = idSchema.regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
class VersionError extends Error {
  constructor(readonly status: number) {
    super('PLAN_VERSION_UNAVAILABLE');
  }
}
export function PlanHistoryPanel({
  athleteId,
  sessionId,
  transport,
  search,
  onSearchChange,
  current,
}: PlanHistoryPanelProps) {
  const params = new URLSearchParams(search),
    from = params.get('compareFrom'),
    to = params.get('compareTo'),
    period = params.get('comparePeriod');
  const requested = from !== null || to !== null || period !== null;
  const valid =
    versionIdSchema.safeParse(from).success &&
    versionIdSchema.safeParse(to).success &&
    (period === null || idSchema.safeParse(period).success);
  const ids = [...new Set([from, to].map((id) => id?.toLowerCase() ?? ''))];
  const queries = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['planning-history', athleteId, sessionId, 'version', id],
      enabled: requested && valid,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const reply = transportReplySchema.parse(
          await transport.request({
            path: `/bff/v1/plans/versions/${id}`,
            method: 'GET',
            body: null,
            idempotencyKey: null,
            signal,
          }),
        );
        if (signal.aborted || reply.status !== 200) throw new VersionError(reply.status);
        const snapshot = planSnapshotSchema.parse(reply.body);
        if (snapshot.id.toLowerCase() !== id) throw new Error('PLAN_VERSION_MISMATCH');
        return snapshot;
      },
      retry: false,
    })),
  });
  const before = queries[ids.indexOf(from?.toLowerCase() ?? '')],
    after = queries[ids.indexOf(to?.toLowerCase() ?? '')];
  const comparison =
    valid && before?.isSuccess && after?.isSuccess && !before.isFetching && !after.isFetching
      ? comparePlanHistory(before.data, after.data, period)
      : null;
  const opener = useRef<HTMLButtonElement | null>(null),
    heading = useRef<HTMLHeadingElement>(null),
    historyHeading = useRef<HTMLHeadingElement>(null);
  const last = useRef('');
  const identity = requested ? JSON.stringify([from, to]) : '';
  useLayoutEffect(() => {
    if (last.current !== identity) {
      if (identity) heading.current?.focus();
      else if (opener.current?.isConnected && !opener.current.disabled) opener.current.focus();
      else historyHeading.current?.focus();
      last.current = identity;
    }
  }, [identity]);
  function change(changes: Record<string, string | null>) {
    onSearchChange(updatePlannerSearch(search, changes));
  }
  return (
    <section className={styles.panel} aria-label="계획 버전 이력">
      <h2 ref={historyHeading} tabIndex={-1}>
        버전 이력 (최근 100개)
      </h2>
      <ol>
        {current?.history.map((version) => (
          <li key={version.id}>
            버전 {version.version} · {version.title} ·{' '}
            <time dateTime={version.createdAt}>{version.createdAt}</time>{' '}
            <Button
              variant="secondary"
              disabled={
                !current.head ||
                !versionIdSchema.safeParse(version.id).success ||
                !versionIdSchema.safeParse(current.head.id).success
              }
              onClick={(event) => {
                if (!current.head) return;
                opener.current = event.currentTarget;
                change({
                  compareFrom: version.id,
                  compareTo: current.head.id,
                  comparePeriod: null,
                });
              }}
            >
              버전 {version.version}과 비교
            </Button>
          </li>
        ))}
      </ol>
      {!current?.history.length ? <p>조회된 저장 버전 이력이 없습니다.</p> : null}
      {requested ? (
        <section aria-label="저장된 계획 버전 비교">
          <h3 ref={heading} tabIndex={-1}>
            저장된 계획 버전 비교
          </h3>
          <p>
            이전 버전 ID {from ?? '미지정'} · 이후 버전 ID {to ?? '미지정'}
          </p>
          <p>
            선택 시 확인한 저장 버전 두 개를 고정해 비교합니다. 이후 새 현재 버전이나 미저장
            초안으로 바뀌지 않으며 이 비교는 계획을 수정·복원하지 않습니다.
          </p>
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={() => change({ compareFrom: null, compareTo: null, comparePeriod: null })}
            >
              버전 비교 닫기
            </Button>
            {valid ? (
              <Button
                variant="secondary"
                disabled={queries.some((query) => query.isFetching)}
                onClick={() => {
                  void Promise.all(queries.map((query) => query.refetch()));
                }}
              >
                버전 비교 다시 확인
              </Button>
            ) : null}
          </div>
          {!valid ? (
            <p role="alert">
              비교 주소의 두 버전 ID와 기간을 확인하세요. 잘못된 주소로는 조회하지 않습니다.
            </p>
          ) : queries.some((query) => query.isFetching) ? (
            <p role="status">두 저장 버전을 조회하고 있습니다.</p>
          ) : queries.some((query) => query.isError) ? (
            <p role="alert">
              {queries.some(
                (query) => query.error instanceof VersionError && query.error.status === 404,
              )
                ? '비교할 버전을 찾을 수 없거나 접근할 수 없습니다.'
                : '두 버전을 확인하지 못했습니다. 다시 조회하세요.'}{' '}
              확인되지 않은 비교 내용은 표시하지 않습니다.
            </p>
          ) : comparison && before?.data && after?.data ? (
            <>
              <label>
                비교할 기간
                <select
                  value={period ?? ''}
                  onChange={(event) => change({ comparePeriod: event.target.value || null })}
                >
                  <option value="">전체 계획</option>
                  {period && !comparison.periodOptions.some((option) => option.id === period) ? (
                    <option value={period}>없는 기간 · {period}</option>
                  ) : null}
                  {comparison.periodOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.title} · {option.id}
                      {option.presence === 'beforeOnly'
                        ? ' (이전 버전에만 있음)'
                        : option.presence === 'afterOnly'
                          ? ' (이후 버전에만 있음)'
                          : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.pair}>
                <SnapshotLabel snapshot={before.data} label="이전 저장 버전" />
                <SnapshotLabel snapshot={after.data} label="이후 저장 버전" />
              </div>
              {comparison.scope.status === 'missing' ? (
                <p role="alert">
                  선택한 기간 ID가 두 버전에 없습니다. 전체 계획이나 다른 기간을 선택하세요.
                </p>
              ) : (
                <>
                  <h4>기간 비교</h4>
                  {comparison.periods.length === 0 ? <p>비교 범위에 기간이 없습니다.</p> : null}
                  {comparison.periods.map((row) => (
                    <details key={row.id} className={styles.row}>
                      <summary>
                        {(row.after ?? row.before)?.title} · {statusLabel[row.status]}
                        {row.movement ? ` · ${movementLabel[row.movement]}` : ''}
                      </summary>
                      <p>기간 ID {row.id}</p>
                      <div className={styles.pair}>
                        <PeriodValues period={row.before} label="이전 기간" />
                        <PeriodValues period={row.after} label="이후 기간" />
                      </div>
                    </details>
                  ))}
                  <h4>계획 세션 비교</h4>
                  <p>
                    선택 기간 밖으로 이동한 세션과 계획에서 삭제된 세션을 구분합니다. 실제 수행
                    기록은 비교하지 않습니다.
                  </p>
                  {comparison.sessions.length === 0 ? (
                    <p>비교 범위에 계획 세션이 없습니다.</p>
                  ) : null}
                  {comparison.sessions.map((row) => (
                    <details key={row.id} className={styles.row}>
                      <summary>
                        세션 {(row.after ?? row.before)?.title} · {statusLabel[row.status]}
                        {row.movement ? ` · ${movementLabel[row.movement]}` : ''}
                      </summary>
                      <p>세션 ID {row.id}</p>
                      <div className={styles.pair}>
                        <SessionValues session={row.before} label="이전 세션" />
                        <SessionValues session={row.after} label="이후 세션" />
                      </div>
                    </details>
                  ))}
                </>
              )}
            </>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
const statusLabel = { added: '추가', removed: '삭제', changed: '변경', unchanged: '동일' };
const movementLabel = { intoScope: '선택 기간 안으로 이동', outOfScope: '선택 기간 밖으로 이동' };
function SnapshotLabel({ snapshot, label }: { snapshot: PlanSnapshot; label: string }) {
  return (
    <section aria-label={label}>
      <h4>
        {label}: 버전 {snapshot.version}
      </h4>
      <p>
        {snapshot.draft.title} · {snapshot.draft.timezone}
      </p>
      <p>
        ID {snapshot.id} · 저장 시각 {snapshot.createdAt}
      </p>
    </section>
  );
}
function PeriodValues({ period, label }: { period: PeriodDraft | null; label: string }) {
  return (
    <section aria-label={label}>
      <h5>{label}</h5>
      {period ? (
        <>
          <p>
            {period.level} · {period.title} · ID {period.id} · 상위 {period.parentId ?? '없음'}
          </p>
          <p>
            {period.startDate}–{period.endDateExclusive} (종료일 미포함) · {period.timezone} ·{' '}
            {period.isPartial ? '부분 기간' : '일반 기간'}
          </p>
          <p>목적 {period.intent || '미입력'}</p>
          <PeriodConstraintsSummary constraints={period.constraints} />
          <p>
            기간 우선순위{' '}
            {period.priority === undefined
              ? '미지정 (이전 형식에 값 없음)'
              : periodPriorityLabel(period.priority)}
          </p>
        </>
      ) : (
        <p>이 버전에 없음</p>
      )}
    </section>
  );
}
const metric = (value: number | null, unit: string) =>
  value === null ? '미정' : `${value}${unit}`;
function SessionValues({ session, label }: { session: PlannedSession | null; label: string }) {
  return (
    <section aria-label={label}>
      <h5>{label}</h5>
      {session ? (
        <>
          <p>
            {session.title} · {session.sport} · {session.date} ·{' '}
            {session.localStartTime ?? '시각 미정'} · Block ID {session.blockId}
          </p>
          <p>
            목적 {session.purpose || '미입력'} · 중요도 {session.priority} · 메모{' '}
            {session.notes || '없음'}
          </p>
          <p>
            거리 {metric(session.distanceMeters, 'm')} · 시간{' '}
            {metric(session.durationSeconds, '초')} · 목표 RPE {session.targetRpe ?? '미정'} · 강도
            라벨{' '}
            {session.intensityLabel === undefined
              ? '미지정 (이전 형식에 값 없음)'
              : (session.intensityLabel ?? '미지정')}
          </p>
          <p>
            잠금: 날짜 {session.locks.date ? '켜짐' : '꺼짐'}, 시각{' '}
            {session.locks.time ? '켜짐' : '꺼짐'}, 강도 {session.locks.intensity ? '켜짐' : '꺼짐'}
          </p>
          <ol>
            {session.steps.map((step) => (
              <li key={step.id}>
                단계 ID {step.id} · {step.kind} · {metric(step.durationSeconds, '초')} ·{' '}
                {metric(step.distanceMeters, 'm')} · {step.repetitions}회
              </li>
            ))}
          </ol>
          {session.steps.length === 0 ? <p>운동 단계 없음</p> : null}
        </>
      ) : (
        <p>이 버전에 없음</p>
      )}
    </section>
  );
}
