'use client';

import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { localDateSchema } from '@workout/contracts/primitives';
import { Button } from '@workout/ui-foundation/button';
import { createNutritionApi } from './nutrition-api';
import { FoodEditor } from './food-editor';
import { IntakeEditor } from './intake-editor';
import { PlanEditor } from './plan-editor';
import {
  coverageLabel,
  dayInTimezone,
  dayIntakes,
  intakeUtcWindow,
  knownSubtotal,
  nutrientFields,
} from './nutrition-model';
import styles from './nutrition.module.css';

export type NutritionRoute =
  | { kind: 'dashboard' }
  | { kind: 'plans-new' }
  | { kind: 'plan'; planId: string }
  | { kind: 'logs' }
  | { kind: 'log-new' }
  | { kind: 'log-edit'; intakeId: string };

export interface NutritionWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  route: NutritionRoute;
  navigate?: (path: string) => void;
}

export function NutritionWorkspace(props: NutritionWorkspaceProps) {
  return <Lifetime key={`${props.athleteId}:${props.sessionId}`} {...props} />;
}

function Lifetime(props: NutritionWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} />
    </QueryClientProvider>
  );
}

function Workspace({ athleteId, sessionId, transport, route, navigate }: NutritionWorkspaceProps) {
  const [clock, setClock] = useState<{ now: string; timezone: string; day: string } | null>(null);
  const api = useMemo(() => createNutritionApi(transport), [transport]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const now = new Date().toISOString();
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const candidate = new URLSearchParams(window.location.search).get('date');
      const parsed = localDateSchema.safeParse(candidate);
      setClock({ now, timezone, day: parsed.success ? parsed.data : dayInTimezone(now, timezone) });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const scope = ['users', athleteId, 'sessions', sessionId, 'nutrition'] as const;
  if (clock === null) return <p role="status">영양 기록 준비 중</p>;
  return (
    <section className={styles.workspace} aria-label="영양 작업 공간">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>영양 · 수동 기록</p>
          <h1>영양 계획과 실제 섭취</h1>
          <p>계획은 실제 섭취가 아닙니다. 먹은 내용은 확인 후 별도로 기록합니다.</p>
        </div>
        <nav aria-label="영양 화면" className={styles.nav}>
          <a href="/nutrition">오늘</a>
          <a href="/nutrition/plans/new">새 계획</a>
          <a href="/nutrition/logs">섭취 기록</a>
          <a href="/nutrition/logs/new">섭취 추가</a>
        </nav>
      </header>
      {route.kind === 'dashboard' || route.kind === 'logs' ? (
        <Overview api={api} scope={scope} clock={clock} route={route.kind} />
      ) : route.kind === 'plans-new' || route.kind === 'plan' ? (
        <PlanEditor
          api={api}
          scope={scope}
          clock={clock}
          planId={route.kind === 'plan' ? route.planId : null}
          navigate={navigate}
        />
      ) : (
        <IntakeEditor
          api={api}
          scope={scope}
          clock={clock}
          intakeId={route.kind === 'log-edit' ? route.intakeId : null}
          navigate={navigate}
        />
      )}
    </section>
  );
}

export type NutritionApi = ReturnType<typeof createNutritionApi>;
export type NutritionClock = { now: string; timezone: string; day: string };
export type NutritionScope = readonly ['users', string, 'sessions', string, 'nutrition'];

function Overview({
  api,
  scope,
  clock,
  route,
}: {
  api: NutritionApi;
  scope: NutritionScope;
  clock: NutritionClock;
  route: 'dashboard' | 'logs';
}) {
  const window = intakeUtcWindow(clock.day);
  const plans = useQuery({
    queryKey: [...scope, 'plans', clock.day],
    queryFn: ({ signal }) => api.listPlans(clock.day, clock.day, signal),
  });
  const intakes = useQuery({
    queryKey: [...scope, 'intakes', clock.day],
    queryFn: ({ signal }) => api.listIntakes(window.from, window.toExclusive, signal),
  });
  const entries = dayIntakes(
    (intakes.data?.entries ?? []).filter((entry) => entry.status === 'active'),
    clock.day,
    clock.timezone,
  );
  const incompletePage =
    (intakes.data !== undefined && intakes.data.nextCursor !== null) ||
    (plans.data !== undefined && plans.data.nextCursor !== null);
  return (
    <div className={styles.columns}>
      <div className={styles.stack}>
        <form
          action={route === 'logs' ? '/nutrition/logs' : '/nutrition'}
          className={styles.toolbar}
        >
          <label htmlFor="nutrition-date">조회 날짜</label>
          <input id="nutrition-date" type="date" name="date" defaultValue={clock.day} />
          <Button type="submit" variant="secondary">
            날짜 보기
          </Button>
        </form>
        {plans.isPending || intakes.isPending ? <p role="status">계획과 기록 불러오는 중</p> : null}
        {plans.isError || intakes.isError ? (
          <div role="alert" className={styles.notice}>
            계획 또는 기록을 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 시도하세요.
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void plans.refetch();
                void intakes.refetch();
              }}
            >
              다시 불러오기
            </Button>
          </div>
        ) : null}
        {incompletePage ? (
          <p role="status" className={styles.notice}>
            조회 한도를 넘는 기록이 있어 이 화면의 목록과 합계가 불완전합니다.
          </p>
        ) : null}
        <section className={styles.card} aria-labelledby="nutrition-plans-title">
          <div className={styles.sectionHead}>
            <h2 id="nutrition-plans-title">해당 날짜의 계획</h2>
            <a href="/nutrition/plans/new">계획 만들기</a>
          </div>
          {plans.data?.plans.length === 0 ? (
            <p>계획이 없습니다. 실제 섭취 기록과는 별개입니다.</p>
          ) : null}
          <ul className={styles.list}>
            {plans.data?.plans.map((plan) => (
              <li key={plan.planId}>
                <a href={`/nutrition/plans/${encodeURIComponent(plan.planId)}`}>
                  {plan.purpose} · 버전 {plan.version}
                </a>
                <p>
                  {plan.period.from} ~ {plan.period.toInclusive} · 항목 {plan.items.length}개
                </p>
                <ul className={styles.subList}>
                  {plan.items
                    .filter(
                      (item) => item.anchor.kind !== 'absolute' || item.anchor.date === clock.day,
                    )
                    .map((item) => (
                      <li key={item.id}>
                        {item.title} · {item.category} ·{' '}
                        {item.anchor.kind === 'relative'
                          ? `${item.anchor.entity} ${item.anchor.point} ${item.anchor.offsetMinutes}분 (연결 시각 미해결 가능)`
                          : (item.anchor.localTime ?? '시각 미지정')}
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.card} aria-labelledby="nutrition-intakes-title">
          <div className={styles.sectionHead}>
            <h2 id="nutrition-intakes-title">실제 섭취 기록</h2>
            <a href={`/nutrition/logs/new?date=${clock.day}`}>섭취 기록하기</a>
          </div>
          {intakes.data ? (
            <p role="status" className={styles.notice}>
              {coverageLabel(
                entries.length === 0
                  ? 'unknown'
                  : entries.some((entry) => entry.nutrientValueCoverage !== 'all_values_present')
                    ? 'partial'
                    : 'all_values_present',
                entries.length,
              )}
            </p>
          ) : null}
          {entries.length > 0 ? (
            <dl className={styles.metrics}>
              {nutrientFields.map((field) => {
                const subtotal = knownSubtotal(entries, field.key);
                return (
                  <div key={field.key}>
                    <dt>{field.label}</dt>
                    <dd>
                      {subtotal.knownCount === 0 ? '미상' : `${subtotal.known} ${field.unit}`}{' '}
                      {subtotal.missing ? `· 미상 ${subtotal.missing}건` : '· 기록된 값만'}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
          <ul className={styles.list}>
            {entries.map((entry) => (
              <li key={entry.intakeId}>
                <a href={`/nutrition/logs/${encodeURIComponent(entry.intakeId)}/edit`}>
                  {entry.foods.map((food) => food.description).join(', ')}
                </a>{' '}
                ·{' '}
                {new Date(entry.occurredAt).toLocaleTimeString('ko-KR', {
                  timeZone: clock.timezone,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                <p>
                  수정 {entry.revision} ·{' '}
                  {entry.nutrientValueCoverage === 'unknown'
                    ? '영양값 미상'
                    : entry.nutrientValueCoverage === 'partial'
                      ? '영양값 일부'
                      : '입력값 있음'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <aside className={styles.stack} aria-label="영양 도구">
        <FoodEditor api={api} scope={scope} />
        <section className={styles.card}>
          <h2>기록에 대한 질문</h2>
          <p>
            섭취·계획 차이가 궁금하면 상담 기록에서 질문할 수 있습니다. 영양 조언은 아직 일반 상담
            자료와 구분해 검토해야 합니다.
          </p>
          <a href="/coach">코치 화면 열기</a>
        </section>
      </aside>
    </div>
  );
}
