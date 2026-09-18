'use client';

import { useQuery } from '@tanstack/react-query';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type PlanningLens,
} from '@workout/contracts/core';
import {
  integratedPlannerQuerySchema,
  integratedPlannerReadSchema,
  type IntegratedPlannerDay,
  type IntegratedPlannerRead,
  type UnresolvedNutritionItem,
} from '@workout/contracts/integrated-planner';
import type { PlanSnapshot } from '@workout/contracts/planning';
import { sumTargetQuantities } from '@workout/contracts/planning';
import { Button } from '@workout/ui-foundation/button';
import { addDays } from './lens';
import styles from './integrated-planner-panel.module.css';

type Props = {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  head: PlanSnapshot | null | undefined;
  lens: PlanningLens;
  invalidLens: boolean;
  draftActive: boolean;
  onSelectSession(id: string): void;
  activityHref?: (id: string) => string;
};
type Range = { from: string; toExclusive: string; timezone: string };
type Read = IntegratedPlannerRead;
const maximumWindowDays = 93;

function rangeForLens(head: PlanSnapshot | null | undefined, lens: PlanningLens): Range | null {
  if (head === undefined) return null;
  const timezone = head?.draft.timezone ?? 'UTC';
  if (lens.kind === 'period') {
    const period = head?.draft.periods.find((value) => value.id === lens.periodId);
    return period
      ? { from: period.startDate, toExclusive: period.endDateExclusive, timezone: period.timezone }
      : null;
  }
  return lens.kind === 'calendar'
    ? { from: lens.from, toExclusive: lens.toExclusive, timezone }
    : {
        from: addDays(lens.anchorDate, 1 - lens.days),
        toExclusive: addDays(lens.anchorDate, 1),
        timezone,
      };
}
function readRange(range: Range) {
  const days =
    (Date.parse(`${range.toExclusive}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) /
    86_400_000;
  return Number.isInteger(days) && days >= 1 && days <= maximumWindowDays;
}
async function fetchIntegrated(
  transport: AuthenticatedTransport,
  range: Range,
  signal: AbortSignal,
): Promise<Read> {
  const input = integratedPlannerQuerySchema.parse(range);
  const query = new URLSearchParams(input);
  const response = transportReplySchema.parse(
    await transport.request({
      path: `/bff/v1/planner/integrated?${query}`,
      method: 'GET',
      body: null,
      idempotencyKey: null,
      signal,
    }),
  );
  if (signal.aborted || response.status !== 200) throw new Error('INTEGRATED_READ_FAILED');
  const read = integratedPlannerReadSchema.parse(response.body);
  if (read.from !== range.from || read.toExclusive !== range.toExclusive)
    throw new Error('INTEGRATED_RANGE_MISMATCH');
  return read;
}

export function IntegratedPlannerPanel({
  athleteId,
  sessionId,
  transport,
  head,
  lens,
  invalidLens,
  draftActive,
  onSelectSession,
  activityHref,
}: Props) {
  const range = invalidLens ? null : rangeForLens(head, lens);
  const validRange = range !== null && readRange(range);
  const read = useQuery({
    queryKey: ['integrated-planner', athleteId, sessionId, head?.id ?? null, range],
    enabled: validRange,
    retry: false,
    queryFn: ({ signal }) => {
      if (!range || !validRange) throw new Error('INTEGRATED_RANGE_UNAVAILABLE');
      return fetchIntegrated(transport, range, signal);
    },
  });
  return (
    <section aria-label="통합 Planner" className={styles.panel}>
      <h2>훈련·영양 통합 조회</h2>
      <p>
        같은 기간의 저장된 계획과 실제 기록입니다. 세트 상세는 Activity 한 건에 연결되며, 식사는
        운동 거리·횟수에 합산하지 않습니다.
      </p>
      {draftActive ? <p role="status">편집 중인 초안은 이 조회에 반영되지 않습니다.</p> : null}
      {head === undefined ? (
        <p role="status">저장된 계획과 조회 범위를 확인하는 중입니다.</p>
      ) : !range ? (
        <p>선택한 기간이 저장된 계획에 없습니다. 현재 계획을 확인하거나 다른 범위를 선택하세요.</p>
      ) : !validRange ? (
        <p role="status">
          통합 조회는 최대 93일입니다. 달력·rolling 범위를 줄여 주세요. 기존 계획 표는 계속 사용할
          수 있습니다.
        </p>
      ) : (
        <>
          <p>
            조회 기간 {range.from}부터 {range.toExclusive} 전까지
          </p>
          <Button
            variant="secondary"
            disabled={read.isFetching}
            onClick={() => void read.refetch()}
          >
            통합 기록 다시 확인
          </Button>
          {read.isFetching ? <p role="status">훈련·영양 기록을 확인하는 중입니다.</p> : null}
          {read.isError ? (
            <p role="alert">
              통합 기록을 확인하지 못했습니다. 이전 결과는 표시하지 않습니다. 다시 확인해 주세요.
            </p>
          ) : !read.isFetching && read.data ? (
            <IntegratedRead
              read={read.data}
              onSelectSession={onSelectSession}
              {...(activityHref ? { activityHref } : {})}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

function metric(values: readonly (number | null)[], unit: string) {
  const known = values.filter((value): value is number => value !== null);
  const total = known.length ? sumTargetQuantities(known) : null;
  return `${total === null ? '미상' : `${total} ${unit}`} · 알려진 ${known.length}건 · 미상 ${values.length - known.length}건`;
}
function dateTime(instant: string, timezone: string) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(instant));
}
const categoryLabel: Record<IntegratedPlannerDay['nutritionItems'][number]['category'], string> = {
  meal: '식사',
  snack: '간식',
  before: '운동 전',
  during: '운동 중',
  after: '운동 후',
  hydration: '수분',
};
const unresolvedLabel: Record<UnresolvedNutritionItem['reason'], string> = {
  missing_anchor: '연결된 세션 또는 대회가 없음',
  missing_session_time: '세션 시작 시각 미정',
  missing_session_duration: '세션 종료 시각 미정',
  ambiguous_local_time: '현지 시각이 DST 경계에서 모호함',
  timezone_mismatch: '날짜만 있는 항목의 시간대가 다름',
  offset_out_of_range: '상대 시각 범위가 유효하지 않음',
};
function IntegratedRead({
  read,
  onSelectSession,
  activityHref,
}: {
  read: Read;
  onSelectSession(id: string): void;
  activityHref?: (id: string) => string;
}) {
  const activeDays = read.days.filter(
    (day) =>
      day.plannedSessions.length +
        day.nutritionItems.length +
        day.activities.length +
        day.intakes.length >
      0,
  );
  const plannedCount = activeDays.reduce((total, day) => total + day.plannedSessions.length, 0);
  const activityCount = activeDays.reduce((total, day) => total + day.activities.length, 0);
  const supplementaryCount = activeDays.reduce(
    (total, day) =>
      total + day.activities.filter((activity) => activity.hasSupplementaryDetail).length,
    0,
  );
  const nutritionCount = activeDays.reduce((total, day) => total + day.nutritionItems.length, 0);
  const intakeCount = activeDays.reduce((total, day) => total + day.intakes.length, 0);
  return (
    <div>
      <p>
        날짜 기준: {read.timezone} · 표시한 날짜 {activeDays.length}/{read.days.length}일
      </p>
      <p>
        훈련 계획 {plannedCount}건 · 실제 Activity {activityCount}건 (세트 상세 연결{' '}
        {supplementaryCount}건) · 영양 계획 {nutritionCount}건 · 실제 섭취 {intakeCount}건
      </p>
      <p>섭취 기록 완전성은 미확인입니다. 기록이 없다는 뜻은 먹지 않았다는 뜻이 아닙니다.</p>
      {activeDays.length === 0 ? (
        <p>선택한 기간에 배치된 계획이나 실제 기록이 없습니다.</p>
      ) : (
        <ol className={styles.days}>
          {activeDays.map((day) => (
            <li key={day.date} className={styles.day}>
              <h3>{day.date}</h3>
              <div className={styles.domains}>
                <section aria-label={`${day.date} 훈련 계획`}>
                  <h4>훈련·보강 계획 {day.plannedSessions.length}건</h4>
                  <ul>
                    {day.plannedSessions.map((session) => (
                      <li key={session.id}>
                        <Button variant="secondary" onClick={() => onSelectSession(session.id)}>
                          {session.title}
                        </Button>{' '}
                        <span>{session.sport === 'strength' ? '근력·보강' : session.sport}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section aria-label={`${day.date} 운동 실제`}>
                  <h4>Activity 실제 {day.activities.length}건</h4>
                  <ul>
                    {day.activities.map((activity) => (
                      <li key={activity.activityId}>
                        {activityHref ? (
                          <a href={activityHref(activity.activityId)}>
                            {activity.title ?? activity.kind}
                          </a>
                        ) : (
                          (activity.title ?? activity.kind)
                        )}{' '}
                        <span>
                          · {dateTime(activity.startedAt, read.timezone)} · 시간{' '}
                          {activity.durationSeconds === null
                            ? '미상'
                            : `${activity.durationSeconds}초`}
                        </span>
                        {activity.hasSupplementaryDetail ? <span> · 세트 상세 연결</span> : null}
                      </li>
                    ))}
                  </ul>
                  <p>
                    거리:{' '}
                    {metric(
                      day.activities.map((activity) => activity.distanceMeters),
                      'm',
                    )}
                  </p>
                </section>
                <section aria-label={`${day.date} 영양 계획`}>
                  <h4>영양 계획 {day.nutritionItems.length}건</h4>
                  <ul>
                    {day.nutritionItems.map((item) => (
                      <li key={`${item.planVersionId}:${item.id}`}>
                        {item.title} · {categoryLabel[item.category]} ·{' '}
                        {item.localTime ?? '시각 미정'}
                      </li>
                    ))}
                  </ul>
                </section>
                <section aria-label={`${day.date} 섭취 실제`}>
                  <h4>섭취 기록 {day.intakes.length}건</h4>
                  <ul>
                    {day.intakes.map((intake) => (
                      <li key={intake.intakeId}>
                        섭취 {dateTime(intake.occurredAt, read.timezone)} · 에너지{' '}
                        {intake.nutrientTotal.energy.value === null
                          ? '미상'
                          : `${intake.nutrientTotal.energy.value} kcal`}
                      </li>
                    ))}
                  </ul>
                  <p>
                    알려진 에너지:{' '}
                    {metric(
                      day.intakes.map((intake) => intake.nutrientTotal.energy.value),
                      'kcal',
                    )}
                  </p>
                  <p>
                    알려진 수분:{' '}
                    {metric(
                      day.intakes.map((intake) => intake.nutrientTotal.fluid.value),
                      'mL',
                    )}
                  </p>
                </section>
              </div>
            </li>
          ))}
        </ol>
      )}
      {read.unresolvedNutritionItems.length > 0 ? (
        <section aria-label="날짜 미해결 영양 계획">
          <h3>날짜를 배치할 수 없는 영양 계획 {read.unresolvedNutritionItems.length}건</h3>
          <ul>
            {read.unresolvedNutritionItems.map((item) => (
              <li key={`${item.planVersionId}:${item.id}`}>
                {item.title} · {unresolvedLabel[item.reason]}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
