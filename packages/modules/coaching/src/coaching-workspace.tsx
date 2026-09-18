'use client';
import { useEffect, useRef, useState } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  coachingThreadCreateSchema,
  coachingMessageAppendSchema,
  type CoachingReviewScope,
} from '@workout/contracts/coaching-threads';
import { createCoachingApi, CoachingRequestError } from './api';
import { readCoachingSearch, changeCoachingSearch } from './search';
import {
  createCoachingDraftStore,
  type CoachingDraftStore,
  type CoachingPending,
} from './draft-store';
import { ThreadList } from './thread-list';
import { ScopeView } from './scope-view';
import { coachingScopeLabels } from './scope-context';
import { EvidencePanel } from './evidence-panel';
import { ConstraintsPanel } from './constraints-panel';
import { createEvidenceDraftStore, type EvidenceDraftStore } from './evidence-store';
import styles from './coaching.module.css';
export interface CoachingWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  search: string;
  onSearchChange(search: string): void;
  createId?: () => string;
}
export function CoachingWorkspace(props: CoachingWorkspaceProps) {
  return <Lifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Lifetime(props: CoachingWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
      }),
  );
  const [store] = useState(createCoachingDraftStore);
  const [evidenceStore] = useState(createEvidenceDraftStore);
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
      store.getState().actions.reset();
      evidenceStore.getState().actions.reset();
    },
    [client, store, evidenceStore],
  );
  return (
    <QueryClientProvider client={client}>
      <Workspace {...props} store={store} evidenceStore={evidenceStore} />
    </QueryClientProvider>
  );
}
function Workspace({
  athleteId,
  sessionId,
  transport,
  search,
  onSearchChange,
  createId = () => crypto.randomUUID(),
  store,
  evidenceStore,
}: CoachingWorkspaceProps & { store: CoachingDraftStore; evidenceStore: EvidenceDraftStore }) {
  const client = useQueryClient(),
    api = createCoachingApi(transport),
    parsed = readCoachingSearch(search),
    query = parsed.query;
  const prefix = ['users', athleteId, 'sessions', sessionId, 'coaching'];
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);
  const title = useStore(store, (s) => s.title),
    firstMessage = useStore(store, (s) => s.firstMessage),
    pending = useStore(store, (s) => s.pending),
    phase = useStore(store, (s) => s.phase),
    feedback = useStore(store, (s) => s.feedback),
    conflict = useStore(store, (s) => s.conflictThreadId),
    actions = useStore(store, (s) => s.actions);
  const compose = useStore(store, (s) => (query?.thread ? s.messages[query.thread] : undefined));
  const evidencePending = useStore(evidenceStore, (state) => state.pending);
  const evidenceHasDraft = useStore(evidenceStore, (state) =>
    Boolean(
      state.pending ||
      Object.values(state.drafts).some(
        (draft) => draft.from || draft.toExclusive || draft.timezone,
      ),
    ),
  );
  const list = useQuery({
    queryKey: [...prefix, 'list', query?.offset],
    enabled: query !== null,
    queryFn: ({ signal }) => api.list({ limit: 20, offset: query?.offset ?? 0 }, signal),
  });
  const plans = useQuery({
    queryKey: [...prefix, 'plans'],
    enabled: query !== null,
    queryFn: ({ signal }) => api.plans(signal),
  });
  const selected = useQuery({
    queryKey: [...prefix, 'thread', query?.thread],
    enabled: Boolean(query?.thread),
    queryFn: ({ signal }) => api.thread(query?.thread ?? '', signal),
  });
  const messages = useInfiniteQuery({
    queryKey: [...prefix, 'messages', query?.thread],
    enabled: Boolean(query?.thread),
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api.messages(query?.thread ?? '', { limit: 50, afterRevision: pageParam }, signal),
    getNextPageParam: (last) => (last.hasMore ? last.messages.at(-1)?.revision : undefined),
  });
  const planId = query?.thread
    ? selected.data?.planVersionId
    : (query?.planVersion ?? plans.data?.head?.id);
  const plan = useQuery({
    queryKey: [...prefix, 'plan', planId],
    enabled: Boolean(planId),
    queryFn: ({ signal }) => api.plan(planId ?? '', signal),
  });
  const hasDraft = useStore(store, (state) =>
    Boolean(
      state.title ||
      state.firstMessage ||
      Object.values(state.messages).some((draft) => draft.message) ||
      state.pending,
    ),
  );
  useEffect(() => {
    if (!hasDraft && !evidenceHasDraft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDraft, evidenceHasDraft]);
  const locked = pending !== null || evidencePending !== null;
  const change = (patch: Record<string, string | null>) => {
    if (!store.getState().pending && !evidenceStore.getState().pending)
      onSearchChange(changeCoachingSearch(search, patch));
  };
  async function send(command: CoachingPending) {
    const controller = life.current;
    if (!controller || controller.signal.aborted) return;
    try {
      const result =
        command.kind === 'create'
          ? await api.create(command.command, controller.signal)
          : await api.append(command.threadId, command.command, controller.signal);
      if (controller.signal.aborted) return;
      actions.succeeded();
      if (command.kind === 'create')
        onSearchChange(changeCoachingSearch(search, { thread: result.thread.id }));
      void client.invalidateQueries({ queryKey: prefix }).catch(() => undefined);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof CoachingRequestError && error.status === 409) {
        actions.reject(
          '상담 기록이 변경되었거나 요청이 충돌했습니다. 최신 기록을 확인하고 초안을 다시 검토하세요.',
          command.kind === 'append' ? command.threadId : 'new',
        );
      } else if (
        error instanceof CoachingRequestError &&
        (error.status === 400 || error.status === 404)
      ) {
        actions.reject(
          error.status === 404
            ? '계획 또는 상담 대상을 찾을 수 없습니다. 선택을 다시 확인하세요.'
            : '입력값을 확인하세요. 기록은 저장되지 않았습니다.',
        );
      } else actions.uncertain();
    }
  }
  const begin = (command: CoachingPending) => {
    if (!evidenceStore.getState().pending && actions.begin(command)) void send(command);
  };
  const visibleThread = useRef(query?.thread);
  useEffect(() => {
    visibleThread.current = query?.thread;
  }, [query?.thread]);
  async function review() {
    const controller = life.current;
    const target = store.getState().conflictThreadId;
    if (
      !controller ||
      !target ||
      (target === 'new' ? Boolean(query?.thread) : query?.thread !== target)
    )
      return;
    const stillReviewing = () =>
      !controller.signal.aborted &&
      store.getState().conflictThreadId === target &&
      !store.getState().pending &&
      (target === 'new' ? !visibleThread.current : visibleThread.current === target);
    try {
      if (target === 'new') {
        await plans.refetch({ throwOnError: true });
        if (stillReviewing()) actions.review('new', 0);
      } else {
        const result = await selected.refetch({ throwOnError: true });
        const refreshed = await messages.refetch({ throwOnError: true });
        if (!stillReviewing() || !result.data || !refreshed.data) return;
        const pages = refreshed.data.pages;
        const revision = Math.max(
          result.data.revision,
          ...pages.map((page) => page.thread.revision),
        );
        const loaded = pages.flatMap((page) => page.messages);
        // Only explicitly loaded, contiguous history establishes what the user could review.
        // Never fetch an unbounded number of pages or silently accept an unseen head.
        if (
          loaded.length < revision ||
          !loaded.every((message, index) => message.revision === index + 1)
        ) {
          actions.reject(
            '최신 메시지가 아직 표시되지 않았습니다. 메시지 더 보기로 남은 기록을 읽은 뒤 다시 검토하세요.',
            target,
          );
          return;
        }
        actions.review(target, revision);
      }
    } catch {
      if (stillReviewing())
        actions.reject('최신 기록 조회에 실패했습니다. 초안을 유지했습니다.', target);
    }
  }
  const targets = plan.data
    ? query?.scopeKind === 'session'
      ? plan.data.draft.sessions.map((s) => ({ id: s.id, title: s.title }))
      : plan.data.draft.periods
          .filter((p) => p.level === query?.scopeKind)
          .map((p) => ({ id: p.id, title: p.title }))
    : [];
  const targetId = query?.targetId ?? null;
  const scope: CoachingReviewScope | null =
    query && targetId ? { kind: query.scopeKind, targetId } : null;
  const completeRevision = (threadRevision: number | undefined, pages: typeof messages.data) => {
    if (!threadRevision || !pages) return null;
    const revision = Math.max(threadRevision, ...pages.pages.map((page) => page.thread.revision));
    const loaded = pages.pages.flatMap((page) => page.messages);
    return revision <= 100 &&
      loaded.length === revision &&
      loaded.every((message, index) => message.revision === index + 1)
      ? revision
      : null;
  };
  const evidenceRevision =
    selected.isError || selected.isFetching || messages.isError || messages.isFetching
      ? null
      : completeRevision(selected.data?.revision, messages.data);
  async function reviewEvidenceConversation() {
    const [thread, history] = await Promise.all([
      selected.refetch({ throwOnError: true }),
      messages.refetch({ throwOnError: true }),
    ]);
    return completeRevision(thread.data?.revision, history.data) !== null;
  }
  return (
    <section className={styles.workspace} aria-label="상담 기록">
      <h1>상담 기록</h1>
      <p>
        저장된 계획에 연결해 사용자 메시지를 기록합니다. AI 답변·제안·계획 변경은 실행하지 않습니다.
        작성 중인 내용은 이 로그인 세션의 메모리에만 유지됩니다.
      </p>
      <ConstraintsPanel
        athleteId={athleteId}
        sessionId={sessionId}
        transport={transport}
        createId={createId}
        onChanged={() => {
          void client.resetQueries({
            queryKey: ['users', athleteId, 'sessions', sessionId, 'evidence'],
          });
        }}
      />
      {parsed.error ? <p role="alert">{parsed.error}</p> : null}
      {feedback ? (
        <p role={phase === 'uncertain' || conflict ? 'alert' : 'status'}>{feedback}</p>
      ) : null}
      {phase === 'sending' ? <p role="status">사용자 기록을 저장하고 있습니다.</p> : null}
      {phase === 'uncertain' ? (
        <button
          type="button"
          onClick={() => {
            const command = actions.retry();
            if (command) void send(command);
          }}
        >
          같은 요청 재확인
        </button>
      ) : null}
      {conflict && !locked ? (
        <button type="button" onClick={() => void review()}>
          최신 기록 확인 후 다시 검토
        </button>
      ) : null}
      {!query ? null : (
        <div className={styles.grid}>
          <ThreadList
            state={
              list.isPending
                ? { kind: 'loading' }
                : list.isError
                  ? { kind: 'error' }
                  : { kind: 'ready', data: list.data }
            }
            selectedId={query.thread}
            offset={query.offset}
            locked={locked}
            onNew={() => change({ thread: null })}
            onRetry={() => void list.refetch()}
            onSelect={(thread) => change({ thread })}
            onPage={(offset) => change({ offset: String(offset) })}
          />
          {query.thread ? (
            <section className={styles.card} aria-label="선택한 상담 기록">
              {selected.isPending ? (
                <p role="status">상담 조회 중</p>
              ) : selected.isError ? (
                <p role="alert">
                  상담을 확인할 수 없습니다.{' '}
                  <button type="button" onClick={() => void selected.refetch()}>
                    상담 다시 확인
                  </button>
                </p>
              ) : (
                <>
                  <h2>{selected.data.title}</h2>
                  <p>저장된 검토 범위: {coachingScopeLabels[selected.data.scope.kind]}</p>
                  {plan.isPending ? (
                    <p>연결된 계획 조회 중</p>
                  ) : plan.isError ? (
                    <p role="alert">
                      연결된 계획 조회 실패{' '}
                      <button type="button" onClick={() => void plan.refetch()}>
                        계획 다시 확인
                      </button>
                    </p>
                  ) : plan.data ? (
                    <ScopeView plan={plan.data} scope={selected.data.scope} />
                  ) : null}
                  <section aria-label="사용자 메시지 기록">
                    <h3>사용자 메시지</h3>
                    {messages.isPending ? (
                      <p>메시지 조회 중</p>
                    ) : messages.isError ? (
                      <p role="alert">
                        메시지 조회 실패{' '}
                        <button type="button" onClick={() => void messages.refetch()}>
                          메시지 다시 확인
                        </button>
                      </p>
                    ) : (
                      <>
                        <ol>
                          {messages.data.pages
                            .flatMap((page) => page.messages)
                            .map((message) => (
                              <li key={message.id}>
                                <p>
                                  사용자 · 기록 {message.revision} · {message.createdAt}
                                </p>
                                <p className={styles.message}>{message.content}</p>
                              </li>
                            ))}
                        </ol>
                        {messages.hasNextPage ? (
                          <button
                            type="button"
                            disabled={messages.isFetchingNextPage}
                            onClick={() => void messages.fetchNextPage()}
                          >
                            메시지 더 보기
                          </button>
                        ) : null}
                      </>
                    )}
                  </section>
                  <fieldset disabled={locked}>
                    <legend>사용자 메시지 작성</legend>
                    <label>
                      사용자 메시지
                      <textarea
                        maxLength={8000}
                        value={compose?.message ?? ''}
                        onChange={(event) =>
                          actions.editMessage(
                            selected.data.id,
                            event.target.value,
                            selected.data.revision,
                          )
                        }
                      />
                    </label>
                    <p>작성 중 기록이 바뀌면 최신 내용을 확인한 뒤 다시 저장해야 합니다.</p>
                    <button
                      type="button"
                      disabled={conflict === query.thread || !compose?.message.trim()}
                      onClick={() => {
                        const result = coachingMessageAppendSchema.safeParse({
                          expectedRevision: compose?.expectedRevision ?? selected.data.revision,
                          message: compose?.message ?? '',
                          idempotencyKey: createId(),
                        });
                        if (result.success)
                          begin({
                            kind: 'append',
                            threadId: selected.data.id,
                            command: result.data,
                          });
                        else actions.reject('메시지 입력값을 확인하세요.');
                      }}
                    >
                      사용자 메시지 저장
                    </button>
                  </fieldset>
                </>
              )}
            </section>
          ) : (
            <section className={styles.card} aria-label="새 상담 기록">
              <h2>새 상담 기록</h2>
              {plans.isError ? (
                <p role="alert">
                  계획 목록 조회 실패{' '}
                  <button type="button" onClick={() => void plans.refetch()}>
                    계획 목록 다시 확인
                  </button>
                </p>
              ) : null}
              <fieldset disabled={locked}>
                <legend>상담 대상과 첫 메시지</legend>
                <label>
                  상담 계획 버전
                  <select
                    value={planId ?? ''}
                    onChange={(event) =>
                      change({ planVersion: event.target.value, targetId: null })
                    }
                  >
                    <option value="">계획 버전을 선택하세요</option>
                    {planId && !plans.data?.history.some((v) => v.id === planId) ? (
                      <option value={planId}>
                        {plan.data
                          ? `v${plan.data.version} · ${plan.data.draft.title}`
                          : '선택한 계획 불러오는 중'}
                      </option>
                    ) : null}
                    {plans.data?.history.map((version) => (
                      <option key={version.id} value={version.id}>
                        v{version.version} · {version.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  상담 범위 종류
                  <select
                    value={query.scopeKind}
                    onChange={(event) => change({ scopeKind: event.target.value, targetId: null })}
                  >
                    <option value="session">세션</option>
                    <option value="block">Block</option>
                    <option value="phase">Phase</option>
                  </select>
                </label>
                <label>
                  상담 대상
                  <select
                    value={targetId ?? ''}
                    onChange={(event) => change({ targetId: event.target.value || null })}
                  >
                    <option value="">상담 대상을 선택하세요</option>
                    {targets.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.title}
                      </option>
                    ))}
                  </select>
                </label>
                {plan.isError ? <p role="alert">선택한 계획을 확인할 수 없습니다.</p> : null}
                {scope && plan.data ? <ScopeView plan={plan.data} scope={scope} /> : null}
                {plans.data && !plans.data.head ? (
                  <p>상담을 만들려면 먼저 계획 버전을 저장하세요.</p>
                ) : null}
                <label>
                  상담 제목
                  <input
                    maxLength={200}
                    value={title}
                    onChange={(event) => actions.editNew('title', event.target.value)}
                  />
                </label>
                <label>
                  첫 사용자 메시지
                  <textarea
                    maxLength={8000}
                    value={firstMessage}
                    onChange={(event) => actions.editNew('firstMessage', event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={
                    !plan.data ||
                    !scope ||
                    !targets.some((target) => target.id === targetId) ||
                    !title.trim() ||
                    !firstMessage.trim() ||
                    conflict === 'new'
                  }
                  onClick={() => {
                    const result = coachingThreadCreateSchema.safeParse({
                      planVersionId: planId,
                      title: title.trim(),
                      scope,
                      message: firstMessage,
                      idempotencyKey: createId(),
                    });
                    if (result.success) begin({ kind: 'create', command: result.data });
                    else actions.reject('상담 대상과 입력값을 확인하세요.');
                  }}
                >
                  상담 기록 만들기
                </button>
              </fieldset>
            </section>
          )}
        </div>
      )}
      <EvidencePanel
        athleteId={athleteId}
        sessionId={sessionId}
        transport={transport}
        threadId={query?.thread ?? null}
        observedRevision={evidenceRevision}
        snapshotId={query?.snapshot ?? null}
        offset={query?.snapshotOffset ?? 0}
        search={search}
        onSearchChange={onSearchChange}
        onReviewConversation={reviewEvidenceConversation}
        createId={createId}
        store={evidenceStore}
        externalPending={pending !== null}
      />
    </section>
  );
}
