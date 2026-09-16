import { useQuery } from '@tanstack/react-query';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type PlanningLens,
} from '@workout/contracts/core';
import { activityListQuerySchema, activityListSchema } from '@workout/contracts/activity';
import type { PlanSnapshot } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import styles from './planning.module.css';

export function actualRange(
  head: PlanSnapshot | null | undefined,
  lens: PlanningLens,
  invalid: boolean,
) {
  if (!head || invalid) return null;
  try {
    let from: string;
    let toExclusive: string;
    let timezone = head.draft.timezone;
    if (lens.kind === 'period') {
      const period = head.draft.periods.find((value) => value.id === lens.periodId);
      if (!period) return null;
      from = period.startDate;
      toExclusive = period.endDateExclusive;
      timezone = period.timezone;
    } else if (lens.kind === 'calendar') {
      from = lens.from;
      toExclusive = lens.toExclusive;
    } else {
      const anchor = new Date(`${lens.anchorDate}T00:00:00Z`);
      from = new Date(anchor.getTime() - (lens.days - 1) * 86400000).toISOString().slice(0, 10);
      toExclusive = new Date(anchor.getTime() + 86400000).toISOString().slice(0, 10);
    }
    const result = activityListQuerySchema.safeParse({
      from,
      toExclusive,
      timezone,
      limit: 50,
      offset: 0,
      sort: 'started_asc',
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function localDate(instant: string | null, timezone: string) {
  if (!instant) return '날짜 미확인';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
export function ActualActivities({
  athleteId,
  sessionId,
  transport,
  head,
  lens,
  invalidLens,
  search,
  onSearchChange,
  activityHref,
}: {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  head: PlanSnapshot | null | undefined;
  lens: PlanningLens;
  invalidLens: boolean;
  search: string;
  onSearchChange(query: string): void;
  activityHref?: (id: string) => string;
}) {
  const range = actualRange(head, lens, invalidLens);
  const params = new URLSearchParams(search);
  const rawPage = params.get('actualPage') ?? '1';
  const parsedPage = Number(rawPage);
  const validPage =
    /^\d+$/.test(rawPage) && Number.isInteger(parsedPage) && parsedPage >= 1 && parsedPage <= 201;
  const page = validPage ? parsedPage : 1;
  const list = useQuery({
    queryKey: ['users', athleteId, 'sessions', sessionId, 'planner-actual', range, page],
    enabled: range !== null,
    queryFn: async ({ signal }) => {
      if (!range) throw new Error('RANGE_UNAVAILABLE');
      const query = new URLSearchParams(
        Object.entries({ ...range, offset: (page - 1) * 50 }).map(([name, value]) => [
          name,
          String(value),
        ]),
      );
      const response = transportReplySchema.parse(
        await transport.request({
          path: `/bff/v1/activities?${query}`,
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (signal.aborted || response.status !== 200) throw new Error('ACTUAL_UNAVAILABLE');
      return activityListSchema.parse(response.body);
    },
  });
  function selectPage(next: number) {
    const params = new URLSearchParams(search);
    params.set('actualPage', String(next));
    onSearchChange(params.toString());
  }
  return (
    <section aria-label="실제 활동 레이어">
      <h2>실제 활동</h2>
      <p>
        저장된 계획의 조회 범위와 시간대를 사용합니다. 미저장 초안은 실제 기록 조회 조건을 바꾸지
        않습니다. 날짜가 같아도 계획 수행으로 연결하지 않습니다.
      </p>
      {!validPage ? (
        <p role="alert">
          실제 활동 페이지가 올바르지 않아 1페이지를 표시합니다. 1~201페이지를 지정하세요.
        </p>
      ) : null}
      {!range ? (
        <p role="status">
          저장된 계획과 유효한 저장 기간을 확인할 수 없어 실제 활동 범위를 조회하지 않습니다.
        </p>
      ) : (
        <>
          <p>
            실제 조회 범위: {range.from} ~ {range.toExclusive} (종료일 제외) · {range.timezone}
          </p>
          <Button
            variant="secondary"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            실제 활동 다시 확인
          </Button>
          {list.isFetching ? <p role="status">실제 활동을 불러오고 있습니다.</p> : null}
          {list.isError ? (
            <p role="alert">
              실제 활동 최신 확인 실패.{' '}
              {list.data
                ? '아래는 마지막 조회 결과이며 변경되었을 수 있습니다.'
                : '다시 확인해 주세요.'}
            </p>
          ) : null}
          {list.data ? (
            <>
              <p>
                아래 기록은 현재 페이지의 활동입니다. 전체 기간의 합계나 계획 이행률을 계산하지
                않습니다.
              </p>
              {list.data.total > 10050 ? (
                <p role="status">
                  최대 201페이지(10,050개)까지 조회할 수 있습니다. 나머지 활동을 보려면 날짜 범위를
                  좁히세요.
                </p>
              ) : null}
              <p>
                조회 범위의 실제 활동 {list.data.total}개 · {page}페이지 · 현재 페이지{' '}
                {list.data.items.length}개
              </p>
              <p>
                마지막 조회 시각: {new Date(list.dataUpdatedAt).toISOString()} · 동기화 시각이
                아닙니다.
              </p>
              {list.data.items.length === 0 ? (
                <p>
                  {list.data.total === 0
                    ? '조회된 실제 활동이 없습니다. 확인된 휴식이나 미수행을 뜻하지 않습니다.'
                    : '이 페이지에는 활동이 없습니다. 이전 페이지를 확인하세요.'}
                </p>
              ) : (
                <ul className={styles.actualRecords}>
                  {list.data.items.map((activity) => {
                    const link = activity.userReport?.planLink;
                    const current =
                      link && head && link.planVersionId.toLowerCase() === head.id.toLowerCase();
                    return (
                      <li key={activity.id}>
                        <article>
                          <h3>{activity.effective.title ?? '제목 미확인'}</h3>
                          <p>
                            {localDate(activity.effective.startedAt, range.timezone ?? 'UTC')} ·{' '}
                            {activity.effective.kind}
                          </p>
                          <p>
                            거리{' '}
                            {activity.effective.distanceMeters === null
                              ? '미확인'
                              : `${activity.effective.distanceMeters}m`}{' '}
                            · 시간{' '}
                            {activity.effective.durationSeconds === null
                              ? '미확인'
                              : `${activity.effective.durationSeconds}초`}{' '}
                            ({activity.effective.durationKind})
                          </p>
                          <p>
                            출처{' '}
                            {activity.source.kind === 'manual'
                              ? '수동 기록'
                              : activity.source.kind === 'fit'
                                ? 'FIT'
                                : '테스트 자료'}{' '}
                          </p>
                          <p>
                            {link
                              ? `${current ? '현재 계획 버전 연결' : '다른 계획 버전 연결'} · ${link.sessionId}`
                              : '명시적 계획 연결 없음'}
                          </p>
                          {activityHref ? (
                            <a
                              href={activityHref(activity.id)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              실제 활동 상세 보기 (새 탭)
                            </a>
                          ) : null}
                        </article>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className={styles.toolbar}>
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => selectPage(page - 1)}
                >
                  이전 실제 활동
                </Button>
                <Button
                  variant="secondary"
                  disabled={page >= 201 || page * 50 >= list.data.total}
                  onClick={() => selectPage(page + 1)}
                >
                  다음 실제 활동
                </Button>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
