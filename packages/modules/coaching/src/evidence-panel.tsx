'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  coreEvidenceCaptureSchema,
  type CoreEvidenceSnapshotList,
} from '@workout/contracts/evidence-snapshots';
import { createEvidenceApi, EvidenceRequestError } from './evidence-api';
import type { EvidenceDraftStore, EvidencePending } from './evidence-store';
import { EvidenceView } from './evidence-view';
import { changeCoachingSearch } from './search';
import styles from './coaching.module.css';
interface Props {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  threadId: string | null;
  observedRevision: number | null;
  snapshotId: string | null;
  offset: number;
  search: string;
  onSearchChange(search: string): void;
  onReviewConversation(): Promise<boolean>;
  createId(): string;
  store: EvidenceDraftStore;
  externalPending: boolean;
}
export function EvidencePanel(props: Props) {
  const {
    athleteId,
    sessionId,
    transport,
    threadId,
    observedRevision,
    snapshotId,
    offset,
    search,
    onSearchChange,
    onReviewConversation,
    createId,
    store,
    externalPending,
  } = props;
  const client = useQueryClient();
  const prefix = ['users', athleteId, 'sessions', sessionId, 'evidence'];
  const api = createEvidenceApi(transport);
  const draft = useStore(store, (state) => (threadId ? state.drafts[threadId] : undefined));
  const pending = useStore(store, (state) => state.pending);
  const phase = useStore(store, (state) => state.phase);
  const feedback = useStore(store, (state) => state.feedback);
  const actions = useStore(store, (state) => state.actions);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const life = useRef<AbortController | null>(null);
  const visible = useRef({ threadId, search, onSearchChange });
  useEffect(() => {
    visible.current = { threadId, search, onSearchChange };
  }, [threadId, search, onSearchChange]);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);
  const list = useQuery({
    queryKey: [...prefix, 'list', threadId, offset],
    enabled: threadId !== null,
    queryFn: ({ signal }) => api.list(threadId ?? '', { limit: 20, offset }, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const locked = externalPending || pending !== null;
  async function send(command: EvidencePending) {
    const controller = life.current;
    if (!controller || controller.signal.aborted) return;
    try {
      const result = await api.capture(command.threadId, command.command, controller.signal);
      if (controller.signal.aborted) return;
      // Read the current server lifecycle before displaying a body, including after replay.
      await client.invalidateQueries({ queryKey: prefix });
      if (controller.signal.aborted) return;
      actions.succeeded();
      if (visible.current.threadId === command.threadId)
        visible.current.onSearchChange(
          changeCoachingSearch(visible.current.search, {
            snapshot: result.id,
            snapshotOffset: '0',
          }),
        );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof EvidenceRequestError && error.status === 409) {
        actions.reject(
          '상담 기록 또는 요청이 충돌했습니다. 상담 기록을 새로 확인한 뒤 다시 저장하세요.',
        );
        setConflicts((previous) => [...new Set([...previous, command.threadId])]);
      } else if (error instanceof EvidenceRequestError && error.status === 413) {
        actions.reject(
          '근거 저장 한도를 초과했습니다. 날짜 범위를 줄이세요. 메시지 100개·활동 500개·체크인 100개·완료 보고 1,000개 또는 본문 2MiB를 넘으면 저장할 수 없습니다.',
        );
      } else if (error instanceof EvidenceRequestError && [400, 404].includes(error.status)) {
        actions.reject(
          error.status === 404
            ? '상담 대상을 찾을 수 없습니다.'
            : '근거 날짜와 시간대를 확인하세요.',
        );
      } else actions.uncertain();
    }
  }
  async function reviewConversation() {
    const target = threadId,
      controller = life.current;
    if (!target || !controller || locked || reviewing) return;
    setReviewing(true);
    try {
      const confirmed = await onReviewConversation();
      if (controller.signal.aborted || visible.current.threadId !== target) return;
      if (confirmed) {
        setConflicts((previous) => previous.filter((id) => id !== target));
        actions.reject(
          '표시된 최신 상담 기록을 확인했습니다. 날짜 범위와 내용을 검토한 뒤 근거를 저장하세요.',
        );
      } else
        actions.reject(
          '상담 기록을 모두 확인하지 못했습니다. 메시지 더 보기로 기록을 읽고 다시 확인하세요.',
        );
    } catch {
      if (!controller.signal.aborted && visible.current.threadId === target)
        actions.reject('상담 기록 조회에 실패했습니다. 근거 입력은 유지했습니다.');
    } finally {
      if (!controller.signal.aborted) setReviewing(false);
    }
  }
  const change = (patch: Record<string, string | null>) => {
    if (!locked) onSearchChange(changeCoachingSearch(search, patch));
  };
  return (
    <section className={styles.card} aria-label="저장된 근거">
      <h2>저장된 근거</h2>
      <p>
        앱 안에서 검토할 계획·사용자 대화·관측 기록을 저장합니다. AI로 전송하거나 계획을 변경하지
        않습니다. 미전송 메시지는 포함하지 않습니다.
      </p>
      {feedback ? <p role={phase === 'uncertain' ? 'alert' : 'status'}>{feedback}</p> : null}
      {phase === 'sending' ? <p role="status">근거를 저장하고 있습니다.</p> : null}
      {phase === 'uncertain' ? (
        <button
          type="button"
          disabled={externalPending}
          onClick={() => {
            const command = actions.retry();
            if (command) void send(command);
          }}
        >
          근거 같은 요청 재확인
        </button>
      ) : null}
      {!threadId ? (
        <p>저장된 상담을 선택하세요.</p>
      ) : (
        <>
          <fieldset disabled={locked || reviewing}>
            <legend>저장할 관측 범위</legend>
            <label>
              근거 시작일
              <input
                type="date"
                value={draft?.from ?? ''}
                onChange={(event) => actions.edit(threadId, 'from', event.target.value)}
              />
            </label>
            <label>
              근거 종료일 (제외)
              <input
                type="date"
                value={draft?.toExclusive ?? ''}
                onChange={(event) => actions.edit(threadId, 'toExclusive', event.target.value)}
              />
            </label>
            <label>
              근거 시간대
              <input
                value={draft?.timezone ?? ''}
                placeholder="Asia/Seoul"
                maxLength={100}
                onChange={(event) => actions.edit(threadId, 'timezone', event.target.value)}
              />
            </label>
            <p>
              1~90일의 현지 날짜 범위입니다. 시각을 모르는 활동은 날짜 불명으로 함께 저장합니다.
              계획과 저장된 전체 대화, 계획 세션의 완료 보고도 포함합니다.
            </p>
            <p>
              {observedRevision === null
                ? '상담 기록을 모두 불러와 확인해야 저장할 수 있습니다. 100개를 넘는 대화는 저장할 수 없습니다.'
                : `저장할 사용자 대화: 기록 ${observedRevision}까지`}
            </p>
            <button type="button" onClick={() => void reviewConversation()}>
              상담 기록 새로 확인
            </button>
            <button
              type="button"
              disabled={observedRevision === null || conflicts.includes(threadId)}
              onClick={() => {
                const parsed = coreEvidenceCaptureSchema.safeParse({
                  expectedConversationRevision: observedRevision,
                  window: draft ?? { from: '', toExclusive: '', timezone: '' },
                  idempotencyKey: createId(),
                });
                if (!parsed.success) {
                  actions.reject('1~90일의 시작일·종료일과 유효한 시간대를 입력하세요.');
                  return;
                }
                const command = { threadId, command: parsed.data };
                if (actions.begin(command)) void send(command);
              }}
            >
              근거 저장
            </button>
          </fieldset>
          <section aria-label="근거 목록">
            <h3>근거 목록</h3>
            <button type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>
              근거 목록 새로 확인
            </button>
            {list.isPending ? (
              <p role="status">근거 목록 조회 중</p>
            ) : list.isError ? (
              <p role="alert">근거 목록을 확인할 수 없습니다.</p>
            ) : (
              <>
                <p>
                  총 {list.data.total}개 · {offset + 1}번째부터
                </p>
                {list.data.items.length === 0 ? (
                  <p>이 페이지에 저장된 근거가 없습니다.</p>
                ) : (
                  <ul>
                    {list.data.items.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          disabled={locked}
                          aria-current={snapshotId === item.id ? 'true' : undefined}
                          onClick={() => change({ snapshot: item.id })}
                        >
                          근거 보기 {item.createdAt} {item.id}
                        </button>
                        <span> · {item.status === 'purged' ? '본문 회수됨' : '저장됨'}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className={styles.actions}>
                  <button
                    type="button"
                    disabled={locked || offset === 0}
                    onClick={() => change({ snapshotOffset: String(Math.max(0, offset - 20)) })}
                  >
                    이전 근거 페이지
                  </button>
                  <button
                    type="button"
                    disabled={locked || offset + 20 >= list.data.total || offset + 20 > 10000}
                    onClick={() => change({ snapshotOffset: String(offset + 20) })}
                  >
                    다음 근거 페이지
                  </button>
                </div>
              </>
            )}
          </section>
          {snapshotId ? (
            <SelectedEvidence
              key={JSON.stringify([threadId, snapshotId])}
              athleteId={athleteId}
              sessionId={sessionId}
              transport={transport}
              threadId={threadId}
              snapshotId={snapshotId}
              metadata={list.data?.items.find((item) => item.id === snapshotId)}
            />
          ) : (
            <p>목록에서 근거를 선택하면 저장 당시 내용을 확인할 수 있습니다.</p>
          )}
        </>
      )}
    </section>
  );
}
function SelectedEvidence({
  athleteId,
  sessionId,
  transport,
  threadId,
  snapshotId,
  metadata,
}: {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  threadId: string;
  snapshotId: string;
  metadata: CoreEvidenceSnapshotList['items'][number] | undefined;
}) {
  const client = useQueryClient();
  const [visible, setVisible] = useState(true);
  const key = [
    'users',
    athleteId,
    'sessions',
    sessionId,
    'evidence',
    'snapshot',
    threadId,
    snapshotId,
  ];
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => createEvidenceApi(transport).read(threadId, snapshotId, signal),
    enabled: metadata?.status !== 'purged' && visible,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  useEffect(() => {
    if (metadata?.status !== 'purged') return;
    const queryKey = [
      'users',
      athleteId,
      'sessions',
      sessionId,
      'evidence',
      'snapshot',
      threadId,
      snapshotId,
    ];
    void client.cancelQueries({ queryKey, exact: true }, { revert: false });
    client.setQueryData(queryKey, metadata);
  }, [athleteId, sessionId, threadId, snapshotId, metadata, client]);
  useEffect(() => {
    const queryKey = [
      'users',
      athleteId,
      'sessions',
      sessionId,
      'evidence',
      'snapshot',
      threadId,
      snapshotId,
    ];
    const refresh = () => {
      if (document.visibilityState !== 'hidden')
        void client.resetQueries({ queryKey, exact: true });
    };
    const visibility = () => {
      setVisible(document.visibilityState !== 'hidden');
      refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [athleteId, sessionId, threadId, snapshotId, client]);
  return (
    <section aria-label="선택한 근거">
      <h3>선택한 근거</h3>
      <button
        type="button"
        disabled={query.isFetching}
        onClick={() => void client.resetQueries({ queryKey: key, exact: true })}
      >
        선택한 근거 새로 확인
      </button>
      <p>
        저장 당시 내용입니다. 다른 창에서 삭제·동의를 변경했다면 새로 확인하세요. 화면 복귀 시에도
        확인하며, 확인 중이나 실패한 경우 이전 본문을 표시하지 않습니다.
      </p>
      {metadata?.status === 'purged' ? (
        <EvidenceView snapshot={metadata} />
      ) : !visible || query.isPending || query.isFetching ? (
        <p role="status">근거 열람 상태 확인 중</p>
      ) : query.isError ? (
        <p role="alert">근거를 확인할 수 없습니다. 이전 본문은 표시하지 않습니다.</p>
      ) : (
        <EvidenceView snapshot={query.data} />
      )}
    </section>
  );
}
