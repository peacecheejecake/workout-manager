'use client';

import { createContext, use, useEffect, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import { transportReplySchema } from '@workout/contracts/core';
import {
  planDraftSchema,
  planReadSchema,
  planSnapshotSchema,
  preservesSessionLocks,
  projectPlan,
  type PlanDraft,
  type ManualPlanCommand,
} from '@workout/contracts/planning';
import { idSchema, localDateSchema } from '@workout/contracts/primitives';
import { Button } from '@workout/ui-foundation/button';
import { TextField } from '@workout/ui-foundation/text-field';
import { AdaptiveWorkspace } from '@workout/ui-foundation/adaptive-workspace';
import { StatusNotice } from '@workout/ui-foundation/status-notice';
import { createPlanningDraftStore } from './draft-store';
import { PlanSummary } from './plan-summary';
import { validationGuidance } from './validation-guidance';
import { PeriodEditor, SessionEditor } from './plan-fields';
import { readPlannerSearch, updatePlannerSearch } from './lens';
import styles from './planning.module.css';
import { PlannedSessionViews } from './planned-session-views';
import { PlannedSessionDetail } from './planned-session-detail';
import { ActualActivities } from './actual-activities';

export interface PlanningWorkspaceProps {
  activityHref?: (id: string) => string;
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  search: string;
  onSearchChange(query: string): void;
  /** Optional clock/ID seams for deterministic hosts and verification. */
  today?: string;
  createId?: () => string;
}
const DraftContext = createContext<ReturnType<typeof createPlanningDraftStore> | null>(null);
const randomId = () => crypto.randomUUID();
export function PlanningWorkspace(props: PlanningWorkspaceProps) {
  idSchema.parse(props.athleteId);
  idSchema.parse(props.sessionId);
  return <PlanningLifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function PlanningLifetime(props: PlanningWorkspaceProps) {
  const [store] = useState(() => createPlanningDraftStore(props.createId ?? randomId));
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
      }),
  );
  const [defaultToday] = useState(() => new Date().toISOString().slice(0, 10));
  useEffect(
    () => () => {
      client.clear();
      store.getState().actions.reset();
    },
    [client, store],
  );
  return (
    <QueryClientProvider client={client}>
      <DraftContext value={store}>
        <Planner {...props} today={localDateSchema.parse(props.today ?? defaultToday)} />
      </DraftContext>
    </QueryClientProvider>
  );
}
class PlanRequestError extends Error {
  constructor(readonly status: number) {
    super(`PLAN_REQUEST_${status}`);
  }
}
function Planner({
  athleteId,
  sessionId,
  transport,
  search,
  onSearchChange,
  today,
  createId = randomId,
  activityHref,
}: PlanningWorkspaceProps & { today: string }) {
  const store = use(DraftContext);
  if (!store) throw new Error('PlanningLifetime required');
  const state = useStore(store, (value) => value.state);
  const actions = useStore(store, (value) => value.actions);
  const client = useQueryClient();
  const key = ['planning', athleteId, sessionId] as const;
  const plan = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const response = transportReplySchema.parse(
        await transport.request({
          path: '/bff/v1/plans/current',
          method: 'GET',
          body: null,
          idempotencyKey: null,
          signal,
        }),
      );
      if (response.status !== 200) throw new PlanRequestError(response.status);
      return planReadSchema.parse(response.body);
    },
  });
  const save = useMutation({
    mutationFn: async (command: ManualPlanCommand) => {
      const { idempotencyKey, ...body } = command;
      const response = transportReplySchema.parse(
        await transport.request({
          path: '/bff/v1/plans/current',
          method: 'PUT',
          body,
          idempotencyKey,
        }),
      );
      if (response.status !== 200 && response.status !== 201)
        throw new PlanRequestError(response.status);
      return planSnapshotSchema.parse(response.body);
    },
    onSuccess: async () => {
      // A successful idempotent replay is a receipt for that write, not the current head.
      // Drop cached reads before the authoritative GET, including a read started before PUT.
      await client.cancelQueries({ queryKey: key, exact: true });
      actions.reset();
      await client.resetQueries({ queryKey: key, exact: true });
    },
    onError: async () => {
      // A lost response or conflict can also mean the head changed. Preserve the draft/key,
      // but never offer a new edit from a cached pre-command head.
      await client.cancelQueries({ queryKey: key, exact: true });
      await client.resetQueries({ queryKey: key, exact: true });
    },
  });
  const currentPlan = plan.isSuccess && !plan.isFetching && !save.isPending ? plan.data : undefined;
  const url = readPlannerSearch(search, today);
  const draft = state.draft;
  const validated = planDraftSchema.safeParse(draft);
  const lockValid =
    !(draft && state.baseline) || preservesSessionLocks(state.baseline.draft, draft);
  const projectionSource = draft
    ? validated.success
      ? validated.data
      : undefined
    : currentPlan?.head?.draft;
  const selectedPeriodId = url.lens.kind === 'period' ? url.lens.periodId : null;
  const selectedPeriod = projectionSource?.periods.find((period) => period.id === selectedPeriodId);
  const missingPeriod = selectedPeriodId !== null && !selectedPeriod;
  const projection =
    projectionSource && !missingPeriod ? projectPlan(projectionSource, url.lens) : [];
  const isConflict = save.error instanceof PlanRequestError && save.error.status === 409;
  function edit(update: (value: PlanDraft) => PlanDraft) {
    actions.edit(update);
    save.reset();
  }
  function changeSearch(changes: Record<string, string | null>) {
    onSearchChange(updatePlannerSearch(search, changes));
  }
  return (
    <section className={styles.workspace} aria-labelledby="planning-title">
      <h1 id="planning-title">훈련 계획</h1>
      <p>
        계획과 실제 수행은 별도입니다. 이 화면은 수동 계획 버전만 저장하며 실제 활동이나 AI 제안을
        승인하지 않습니다.
      </p>
      {plan.isPending ? (
        <StatusNotice state="loading">계획을 불러오고 있습니다.</StatusNotice>
      ) : null}
      {plan.isError ? (
        <StatusNotice
          state="error"
          action={<Button onClick={() => void plan.refetch()}>계획 다시 불러오기</Button>}
        >
          계획을 확인할 수 없습니다. 초안이 있으면 유지됩니다.
        </StatusNotice>
      ) : null}
      {save.isSuccess ? <p role="status">계획 버전 {save.data.version} 저장 완료</p> : null}
      {save.isError ? (
        <StatusNotice state={isConflict ? 'stale' : 'error'}>
          {isConflict
            ? '다른 변경과 충돌했습니다. 초안을 유지했습니다. 최신 계획을 불러와 비교한 뒤 다시 검토하세요.'
            : '저장 결과를 확인할 수 없습니다. 초안을 유지했습니다. 같은 확인 버튼으로 재시도하면 동일 요청 키를 사용합니다.'}
        </StatusNotice>
      ) : null}
      {isConflict ? (
        <div>
          <Button onClick={() => void plan.refetch()}>최신 버전 불러오기</Button>
          {currentPlan &&
          !plan.isFetching &&
          !plan.isError &&
          currentPlan.head?.id !== state.baseline?.id ? (
            <Button
              onClick={() => {
                actions.rebase(currentPlan?.head ?? null);
                save.reset();
              }}
            >
              최신 버전을 기준으로 내 초안 다시 검토
            </Button>
          ) : null}
          <p>
            다시 검토는 내 초안 전체를 새 버전으로 저장하기 위한 기준 변경입니다. 최신 내용과
            비교하세요.
          </p>
        </div>
      ) : null}
      {currentPlan ? (
        <p>
          현재 버전: {currentPlan.head?.version ?? '없음'} ·{' '}
          {currentPlan.head?.draft.title ?? '새 계획을 만드세요.'}
        </p>
      ) : null}
      {!draft && currentPlan ? (
        <Button
          onClick={() => {
            actions.start(currentPlan.head, {
              title: '새 훈련 계획',
              timezone: 'UTC',
              periods: [],
              sessions: [],
            });
            save.reset();
          }}
        >
          계획 초안 편집
        </Button>
      ) : null}
      <section aria-label="기간 탐색">
        <h2>Season · Wave · Phase · Block</h2>
        <ul>
          {projectionSource?.periods.map((period) => (
            <li key={period.id}>
              <Button
                variant="secondary"
                aria-pressed={selectedPeriodId === period.id}
                onClick={() => changeSearch({ lens: 'period', period: period.id })}
              >
                {period.level} · {period.title}
              </Button>
              <span>
                {' '}
                {period.startDate}–{period.endDateExclusive} (종료일 미포함) ·{' '}
                {period.intent || '목적 미정'}
                {period.isPartial ? ' · 부분 기간' : ''}
              </span>
            </li>
          ))}
        </ul>
        {selectedPeriod ? (
          <p>
            선택: {selectedPeriod.title} · 상위:{' '}
            {projectionSource?.periods.find((period) => period.id === selectedPeriod.parentId)
              ?.title ?? '최상위'}
          </p>
        ) : null}
        {missingPeriod ? (
          <p role="alert">
            URL이 가리키는 기간을 찾을 수 없습니다. 목록에서 다른 기간을 선택하세요.
          </p>
        ) : null}
      </section>
      <section aria-label="조회 범위">
        <h2>달력·rolling 조회</h2>
        <p>조회 범위는 기간 트리를 변경하지 않습니다. Rolling은 기준일까지의 최근 N일입니다.</p>
        <div className={styles.toolbar}>
          <Button
            variant="secondary"
            aria-pressed={url.lens.kind === 'rolling'}
            onClick={() => changeSearch({ lens: 'rolling' })}
          >
            Rolling
          </Button>
          <Button
            variant="secondary"
            aria-pressed={url.lens.kind === 'calendar'}
            onClick={() => changeSearch({ lens: 'calendar' })}
          >
            달력 범위
          </Button>
          <Button
            variant="secondary"
            aria-pressed={url.view === 'stack'}
            onClick={() => changeSearch({ view: 'stack' })}
          >
            한 열 보기
          </Button>
          <Button
            variant="secondary"
            aria-pressed={url.view === 'split'}
            onClick={() => changeSearch({ view: 'split' })}
          >
            나란히 보기
          </Button>
        </div>
        {url.lens.kind === 'rolling' ? (
          <div className={styles.toolbar}>
            <TextField
              label="Rolling 기준일"
              type="date"
              value={url.lens.anchorDate}
              onChange={(event) => changeSearch({ date: event.target.value })}
            />
            <TextField
              label="Rolling 일수 (1–366)"
              type="number"
              min="1"
              max="366"
              value={url.lens.days}
              onChange={(event) => changeSearch({ days: event.target.value })}
            />
          </div>
        ) : url.lens.kind === 'calendar' ? (
          <div className={styles.toolbar}>
            <TextField
              label="조회 시작일"
              type="date"
              value={url.lens.from}
              onChange={(event) => changeSearch({ from: event.target.value })}
            />
            <TextField
              label="조회 종료일 (미포함)"
              type="date"
              value={url.lens.toExclusive}
              onChange={(event) => changeSearch({ to: event.target.value })}
            />
          </div>
        ) : null}
        {url.error ? (
          <p role="alert">
            URL 조회 범위가 올바르지 않아 기본 최근 10일을 표시합니다. 최대 366일입니다.
          </p>
        ) : null}
      </section>
      <AdaptiveWorkspace requestedView={url.view}>
        <div>
          {draft ? (
            <section aria-label="계획 초안">
              <h2>미저장 초안</h2>
              <fieldset disabled={save.isPending || state.preview !== null}>
                <legend>계획 편집</legend>
                <TextField
                  label="계획 제목"
                  value={draft.title}
                  onChange={(event) =>
                    edit((current) => ({ ...current, title: event.target.value }))
                  }
                />
                <TextField
                  label="계획 시간대"
                  description="IANA 시간대 예: Asia/Seoul. 새 계획 기본값은 UTC입니다."
                  disabled={state.baseline?.draft.sessions.some(
                    (session) => session.locks.date || session.locks.time,
                  )}
                  value={draft.timezone}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      timezone: event.target.value,
                      periods: current.periods.map((period) => ({
                        ...period,
                        timezone: event.target.value,
                      })),
                    }))
                  }
                />
                <PeriodEditor draft={draft} edit={edit} today={today} createId={createId} />
                <SessionEditor
                  selectedId={url.plannedSession}
                  draft={draft}
                  baseline={state.baseline?.draft ?? null}
                  edit={edit}
                  today={today}
                  createId={createId}
                />
              </fieldset>
              {state.preview ? (
                <section aria-label="변경 미리보기">
                  <h3>변경 미리보기 · 아직 미적용</h3>
                  <p>
                    기준 버전 {state.baseline?.version ?? '없음'} → 기간 {draft.periods.length}개,
                    계획 세션 {draft.sessions.length}개
                  </p>
                  <p>
                    제목: {draft.title} · 시간대: {draft.timezone}
                  </p>
                  <p>
                    아래 변경 내용 전체가 새 계획 버전으로 저장됩니다. 실제 활동은 생성되지
                    않습니다.
                  </p>
                  <details>
                    <summary>변경 전후 전체 내용 비교</summary>
                    <h4>변경 전</h4>
                    <PlanSummary draft={state.baseline?.draft ?? null} />
                    <h4>변경 후</h4>
                    <PlanSummary draft={state.preview.draft} />
                  </details>
                  <Button
                    disabled={save.isPending || isConflict}
                    onClick={() => {
                      if (state.preview) save.mutate(state.preview);
                    }}
                  >
                    확인하고 계획 버전 저장
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={save.isPending}
                    onClick={() => {
                      actions.returnToEditing();
                      save.reset();
                    }}
                  >
                    편집으로 돌아가기
                  </Button>
                </section>
              ) : (
                <div className={styles.toolbar}>
                  <Button
                    disabled={!validated.success || !lockValid}
                    onClick={() => actions.preview()}
                  >
                    변경 미리보기
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={state.undo.length === 0}
                    onClick={actions.undo}
                  >
                    실행 취소
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      actions.reset();
                      save.reset();
                    }}
                  >
                    초안 버리기
                  </Button>
                </div>
              )}
              {!validated.success ? (
                <div role="status">
                  <p>미리보기 전에 수정할 항목</p>
                  <ul>
                    {validated.error.issues.slice(0, 20).map((issue, index) => (
                      <li key={`${issue.path.join('.')}-${index}`}>{validationGuidance(issue)}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {!lockValid ? (
                <p role="alert">저장된 잠금과 충돌합니다. 잠금을 먼저 해제해 저장하세요.</p>
              ) : null}
            </section>
          ) : null}
        </div>
        <section aria-label="일별 계획">
          <h2>{draft ? '초안' : '현재 저장된 계획'} 일별 조회</h2>
          <div className={styles.toolbar}>
            {(['agenda', 'calendar', 'table'] as const).map((view) => (
              <Button
                key={view}
                variant="secondary"
                aria-pressed={url.plannedView === view}
                onClick={() => changeSearch({ plannedView: view })}
              >
                {view === 'agenda'
                  ? '계획 agenda 보기'
                  : view === 'calendar'
                    ? '계획 달력 보기'
                    : '계획 표 보기'}
              </Button>
            ))}
          </div>
          {new URLSearchParams(search).has('plannedSession') ? (
            <Button variant="secondary" onClick={() => changeSearch({ plannedSession: null })}>
              계획 세션 선택 해제
            </Button>
          ) : null}
          {url.selectionError ? (
            <p role="alert">
              계획 보기 또는 선택 주소가 올바르지 않습니다. 잘못된 보기는 agenda로 표시하고 잘못된
              선택은 적용하지 않습니다.
            </p>
          ) : null}
          {draft && !validated.success ? (
            <p role="alert">
              초안이 유효하지 않아 날짜별 보기를 표시할 수 없습니다. 작성 내용은 편집기에
              유지됩니다.
            </p>
          ) : projectionSource && projection.length ? (
            <PlannedSessionViews
              source={projectionSource}
              days={projection}
              view={url.plannedView}
              selected={url.plannedSession}
              onSelect={(plannedSession) => changeSearch({ plannedSession })}
            />
          ) : (
            <p>조회할 계획이 없습니다.</p>
          )}
          <PlannedSessionDetail
            source={draft ?? currentPlan?.head?.draft}
            selected={url.plannedSession}
            visibleIds={
              projectionSource && !missingPeriod
                ? projection.flatMap((day) => day.plannedSessionIds)
                : null
            }
            draft={draft !== null}
          />
        </section>
      </AdaptiveWorkspace>
      <ActualActivities
        athleteId={athleteId}
        sessionId={sessionId}
        transport={transport}
        head={currentPlan?.head}
        lens={url.lens}
        invalidLens={url.error}
        search={search}
        onSearchChange={onSearchChange}
        {...(activityHref ? { activityHref } : {})}
      />
      <section aria-label="계획 버전 이력">
        <h2>버전 이력 (최근 100개)</h2>
        <ol>
          {currentPlan?.history.map((version) => (
            <li key={version.id}>
              버전 {version.version} · {version.title} ·{' '}
              <time dateTime={version.createdAt}>{version.createdAt}</time>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}
