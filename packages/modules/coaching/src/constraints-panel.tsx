'use client';
import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  coachingConstraintCreateSchema,
  coachingConstraintUpdateSchema,
  coachingConstraintDeleteSchema,
  coachingConstraintDefinition,
} from '@workout/contracts/coaching-constraints';
import { createConstraintsApi, ConstraintsRequestError } from './constraints-api';
import {
  createConstraintsDraftStore,
  type ConstraintsDraftStore,
  type ConstraintsPending,
} from './constraints-store';
import styles from './constraints-panel.module.css';
export interface ConstraintsPanelProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  createId?: () => string;
  onChanged?: () => void;
}
export function ConstraintsPanel(props: ConstraintsPanelProps) {
  return <Lifetime key={JSON.stringify([props.athleteId, props.sessionId])} {...props} />;
}
function Lifetime(props: ConstraintsPanelProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  const [store] = useState(createConstraintsDraftStore);
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
      store.getState().actions.reset();
    },
    [client, store],
  );
  return (
    <QueryClientProvider client={client}>
      <Panel {...props} store={store} />
    </QueryClientProvider>
  );
}
function Panel({
  athleteId,
  sessionId,
  transport,
  store,
  createId = () => crypto.randomUUID(),
  onChanged,
}: ConstraintsPanelProps & { store: ConstraintsDraftStore }) {
  const api = createConstraintsApi(transport),
    client = useQueryClient();
  const queryKey = ['users', athleteId, 'sessions', sessionId, 'coaching-constraints'];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.list(signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const [reviewing, setReviewing] = useState(false);
  const text = useStore(store, (s) => s.text),
    editing = useStore(store, (s) => s.editing),
    pending = useStore(store, (s) => s.pending),
    phase = useStore(store, (s) => s.phase),
    feedback = useStore(store, (s) => s.feedback),
    conflict = useStore(store, (s) => s.conflict),
    actions = useStore(store, (s) => s.actions);
  const baseline = useRef<{ head: number | null; revision: number | null } | null>(null);
  const [confirmation, setConfirmation] = useState<ConstraintsPending | null>(null);
  const life = useRef<AbortController | null>(null);
  const confirmCancel = useRef<HTMLButtonElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!confirmation && restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus();
    }
  }, [confirmation]);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (confirmation) confirmCancel.current?.focus();
  }, [confirmation]);
  useEffect(() => {
    if (!text && !pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [text, pending]);
  const locked = pending !== null;
  const ready = query.isSuccess && !query.isFetching && !query.isError && !conflict;
  async function send(command: ConstraintsPending) {
    const controller = life.current;
    if (!controller || controller.signal.aborted) return;
    try {
      if (command.kind === 'create') await api.create(command.command, controller.signal);
      else if (command.kind === 'update')
        await api.update(command.id, command.command, controller.signal);
      else await api.remove(command.id, command.command, controller.signal);
      if (controller.signal.aborted) return;
      onChanged?.();
      const keepDraft = command.kind === 'delete' && store.getState().editing !== command.id;
      actions.succeeded();
      if (!keepDraft) baseline.current = null;
      await client.resetQueries({ queryKey, exact: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ConstraintsRequestError && error.status === 409)
        actions.reject(
          '제약이 변경되었습니다. 최신 제약을 확인한 뒤 초안을 다시 검토하세요.',
          true,
        );
      else if (
        error instanceof ConstraintsRequestError &&
        [400, 403, 404, 413].includes(error.status)
      )
        actions.reject(
          error.status === 403
            ? '요청 권한을 확인할 수 없습니다. 입력은 유지했습니다. 다시 로그인한 뒤 확인하세요.'
            : error.status === 413
              ? '최대 50개의 제약만 저장할 수 있습니다.'
              : error.status === 404
                ? '제약을 찾을 수 없습니다. 최신 제약을 확인하세요.'
                : '제약 문장을 확인하세요.',
          error.status === 404,
        );
      else actions.uncertain();
    }
  }
  function prepare(kind: 'save' | 'delete', id?: string) {
    if (!ready || !query.data || locked) return;
    const target = query.data.items.find((item) => item.id === (id ?? editing));
    const idempotencyKey = createId();
    if (kind === 'delete' && target) {
      const result = coachingConstraintDeleteSchema.safeParse({
        expectedHeadRevision: query.data.headRevision,
        expectedRevision: target.revision,
        confirmed: true,
        idempotencyKey,
      });
      if (result.success) setConfirmation({ kind: 'delete', id: target.id, command: result.data });
    } else if (editing && target) {
      const result = coachingConstraintUpdateSchema.safeParse({
        expectedHeadRevision: baseline.current?.head ?? query.data.headRevision,
        expectedRevision: baseline.current?.revision ?? target.revision,
        confirmed: true,
        text,
        idempotencyKey,
      });
      if (result.success) setConfirmation({ kind: 'update', id: target.id, command: result.data });
      else actions.reject('공백이 아닌 2,000자 이내 제약 문장을 입력하세요.');
    } else if (!editing) {
      const result = coachingConstraintCreateSchema.safeParse({
        expectedHeadRevision: baseline.current ? baseline.current.head : query.data.headRevision,
        confirmed: true,
        text,
        idempotencyKey,
      });
      if (result.success) setConfirmation({ kind: 'create', command: result.data });
      else actions.reject('공백이 아닌 2,000자 이내 제약 문장을 입력하세요.');
    } else
      actions.reject(
        '수정할 제약이 없어졌습니다. 초안을 새 제약으로 등록하려면 새 제약 작성을 선택하세요.',
      );
  }
  async function refresh() {
    if (locked || reviewing) return;
    const controller = life.current;
    if (!controller || controller.signal.aborted) return;
    setConfirmation(null);
    setReviewing(true);
    try {
      const result = await query.refetch();
      if (result.isSuccess && !controller.signal.aborted) {
        baseline.current = {
          head: result.data.headRevision,
          revision: result.data.items.find((item) => item.id === editing)?.revision ?? null,
        };
        actions.reviewed();
      }
    } finally {
      if (!controller.signal.aborted) setReviewing(false);
    }
  }
  return (
    <section className={styles.panel} aria-label="필수 사용자 제약">
      <h2>필수 사용자 제약</h2>
      <p>{coachingConstraintDefinition.meaning}</p>
      <p>
        새로 저장하는 근거에는 전체 사용자 제약이 필수로 포함됩니다. 이전 근거 v1에는 포함되지
        않았습니다. AI나 계획 변경에 자동 적용되지 않습니다.
      </p>
      <button type="button" disabled={locked || query.isFetching} onClick={() => void refresh()}>
        최신 제약 확인
      </button>
      {feedback ? (
        <p role={phase === 'uncertain' || conflict ? 'alert' : 'status'}>{feedback}</p>
      ) : null}
      {phase === 'sending' ? <p role="status">제약 변경을 저장하고 있습니다.</p> : null}
      {phase === 'uncertain' ? (
        <button
          type="button"
          onClick={() => {
            const command = actions.retry();
            if (command) void send(command);
          }}
        >
          같은 제약 요청 재확인
        </button>
      ) : null}
      {query.isPending || query.isFetching ? (
        <p role="status">사용자 제약 조회 중</p>
      ) : query.isError ? (
        <p role="alert">사용자 제약을 확인할 수 없습니다. 입력은 유지했습니다.</p>
      ) : (
        <>
          <p>
            {query.data.headRevision === null
              ? coachingConstraintDefinition.absent
              : query.data.items.length === 0
                ? coachingConstraintDefinition.cleared
                : `저장된 제약 ${query.data.items.length}개`}
          </p>
          <ul>
            {query.data.items.map((item) => (
              <li key={item.id}>
                <p className={styles.text}>{item.text}</p>
                <p>
                  수정 {item.revision} · 사용자 확인 {item.confirmedAt}
                </p>
                <button
                  type="button"
                  disabled={locked || confirmation !== null || !ready}
                  onClick={() => {
                    baseline.current = { head: query.data.headRevision, revision: item.revision };
                    actions.select(item.id, item.text);
                  }}
                >
                  제약 수정 · {item.text}
                </button>
                <button
                  type="button"
                  disabled={locked || confirmation !== null || !ready}
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    prepare('delete', item.id);
                  }}
                >
                  제약 삭제 · {item.text}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <fieldset disabled={locked || confirmation !== null || reviewing}>
        <legend>{editing ? '사용자 제약 수정' : '사용자 제약 작성'}</legend>
        <label>
          사용자 제약 문장
          <textarea
            maxLength={2000}
            value={text}
            onChange={(event) => {
              if (!baseline.current)
                baseline.current = {
                  head: query.data?.headRevision ?? null,
                  revision: query.data?.items.find((item) => item.id === editing)?.revision ?? null,
                };
              actions.edit(event.target.value);
            }}
          />
        </label>
        <button
          type="button"
          disabled={!ready || (!editing && (query.data?.items.length ?? 0) >= 50)}
          onClick={(event) => {
            opener.current = event.currentTarget;
            prepare('save');
          }}
        >
          제약 변경 검토
        </button>
        {editing ? (
          <button
            type="button"
            onClick={() => {
              baseline.current = { head: query.data?.headRevision ?? null, revision: null };
              actions.select(null, text);
            }}
          >
            새 제약으로 작성
          </button>
        ) : null}
      </fieldset>
      {confirmation ? (
        <section role="group" aria-label="사용자 제약 변경 확인">
          <p>
            {confirmation.kind === 'delete'
              ? '이 사용자 제약을 삭제합니다. 자동 일정 변경은 없습니다.'
              : '다음 문장을 사용자 제약으로 직접 확인하여 저장합니다.'}
          </p>
          {confirmation.kind !== 'delete' ? (
            <p className={styles.text}>{confirmation.command.text}</p>
          ) : (
            <p>{query.data?.items.find((item) => item.id === confirmation.id)?.text}</p>
          )}
          <button
            type="button"
            ref={confirmCancel}
            onClick={() => {
              restoreFocus.current = true;
              setConfirmation(null);
            }}
          >
            제약 변경 취소
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              const command = confirmation;
              setConfirmation(null);
              if (actions.begin(command)) void send(command);
            }}
          >
            확인하고 제약 변경
          </button>
        </section>
      ) : null}
    </section>
  );
}
