'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  coachingRunCreateCommandV1Schema,
  type CoachingRunCreateCommandV1,
  type CoachingRunV1,
} from '@workout/contracts/coaching-runs';
import { CoachingRunRequestError, createCoachingRunApi } from './run-api';
import styles from './run-panel.module.css';

interface Props {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  threadId: string;
  snapshotId: string | null;
  observedRevision: number | null;
  createId(): string;
}

type Operation =
  | { kind: 'create'; command: CoachingRunCreateCommandV1 }
  | { kind: 'fixture'; runId: string; idempotencyKey: string }
  | { kind: 'cancel'; runId: string };
type Feedback = { kind: 'status' | 'alert'; text: string };

const inFlight = (run: CoachingRunV1) =>
  run.status.kind === 'queued' || run.status.kind === 'running';
const statusLabels: Record<CoachingRunV1['status']['kind'], string> = {
  queued: '대기 중',
  running: '실행 중',
  analysis_ready: '분석 자료 준비됨',
  needs_question: '추가 질문 필요',
  validated_final: '후보 검증 완료',
  unable_to_evaluate: '실행 실패',
  cancelled: '취소됨',
};

function RunStage({ run }: { run: CoachingRunV1 }) {
  switch (run.status.kind) {
    case 'queued':
      return <p role="status">대기 중 · 저장된 근거를 바탕으로 실행을 준비합니다.</p>;
    case 'running': {
      const stage = {
        preparing_evidence: '근거 확인 중',
        evaluating: '계획 검토 중',
        validating_candidates: '후보 검증 중',
      }[run.status.stage];
      return <p role="status">실행 중 · {stage}</p>;
    }
    case 'analysis_ready':
      return (
        <p>
          분석 자료가 저장되었습니다. 아직 검증된 후보나 계획 변경은 아닙니다. 아래에서 검증을
          명시적으로 요청할 수 있습니다.
        </p>
      );
    case 'needs_question':
      return (
        <p>
          추가 정보가 필요합니다: {run.status.question} 답변을 상담 메시지로 저장하고 새 근거를
          선택한 뒤 다시 실행하세요.
        </p>
      );
    case 'validated_final':
      return <p>후보 검증을 마쳤습니다. 제안을 별도로 검토해야 계획에 반영할 수 있습니다.</p>;
    case 'unable_to_evaluate':
      return <p role="alert">이번 실행을 완료할 수 없습니다. 근거와 연결 상태를 확인하세요.</p>;
    case 'cancelled':
      return <p>실행이 취소되었습니다. 계획은 변경되지 않았습니다.</p>;
  }
}

export function CoachingRunPanel(props: Props) {
  return <Panel key={props.threadId} {...props} />;
}

function Panel({
  athleteId,
  sessionId,
  transport,
  threadId,
  snapshotId,
  observedRevision,
  createId,
}: Props) {
  const api = createCoachingRunApi(transport);
  const client = useQueryClient();
  const prefix = ['users', athleteId, 'sessions', sessionId, 'coaching-runs', threadId];
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pollingSince, setPollingSince] = useState(() => Date.now());
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);
  const list = useQuery({
    queryKey: [...prefix, 'list', offset],
    queryFn: ({ signal }) => api.list(threadId, { limit: 20, offset }, signal),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const runId = selectedId ?? list.data?.items[0]?.id ?? null;
  const run = useQuery({
    queryKey: [...prefix, 'detail', runId],
    enabled: runId !== null,
    queryFn: ({ signal }) => api.read(threadId, runId ?? '', signal),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    refetchInterval: (query) =>
      query.state.status === 'success' &&
      query.state.data &&
      inFlight(query.state.data) &&
      Date.now() - pollingSince < 120_000
        ? 2_500
        : false,
  });
  // Query keeps its last successful data after a failed refetch. Never render that
  // cached body while freshness is unknown, including a stored model question.
  const visibleRun = run.isSuccess && !run.isFetching ? run.data : null;
  const candidates = useQuery({
    queryKey: [...prefix, 'candidates', runId],
    enabled:
      runId !== null &&
      (visibleRun?.status.kind === 'analysis_ready' ||
        visibleRun?.status.kind === 'validated_final'),
    queryFn: ({ signal }) => api.candidates(runId ?? '', signal),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const visibleCandidates = candidates.isSuccess && !candidates.isFetching ? candidates.data : null;
  const busy = operation !== null;
  const canStart =
    snapshotId !== null &&
    observedRevision !== null &&
    !busy &&
    !run.isFetching &&
    !run.isError &&
    !(visibleRun && inFlight(visibleRun));
  const selectedSnapshotMatches = visibleRun?.evidenceSnapshotId === snapshotId;

  async function send(command: Operation) {
    const controller = life.current;
    if (!controller || controller.signal.aborted) return;
    setOperation(command);
    setFeedback({ kind: 'status', text: '요청을 확인하고 있습니다.' });
    try {
      if (command.kind === 'create') {
        const created = await api.create(threadId, command.command, controller.signal);
        if (controller.signal.aborted) return;
        setSelectedId(created.id);
        setPollingSince(Date.now());
      } else if (command.kind === 'fixture') {
        await api.validateFixture(command.runId, command.idempotencyKey, controller.signal);
      } else {
        await api.cancel(threadId, command.runId, controller.signal);
      }
      if (controller.signal.aborted) return;
      await client.invalidateQueries({ queryKey: prefix });
      if (controller.signal.aborted) return;
      setOperation(null);
      setFeedback({
        kind: 'status',
        text:
          command.kind === 'create'
            ? '실행 요청이 저장되었습니다. 상태를 확인하세요.'
            : command.kind === 'fixture'
              ? 'fixture 후보 검증 결과를 불러왔습니다. 제안을 별도로 검토하세요.'
              : '실행 취소를 확인했습니다.',
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof CoachingRunRequestError && [404, 409, 422].includes(error.status)) {
        setOperation(null);
        setFeedback({
          kind: 'alert',
          text:
            error.status === 404
              ? '상담 또는 실행을 찾을 수 없습니다. 최신 목록을 확인하세요.'
              : error.status === 422
                ? '선택한 근거 또는 fixture 결과를 사용할 수 없습니다. 근거를 다시 확인하세요.'
                : '상담·근거·동의 또는 계획 상태가 변경되었습니다. 최신 내용을 확인한 뒤 새로 요청하세요.',
        });
      } else {
        // An uncertain response may have committed. Reuse the exact command and key on retry.
        setFeedback({
          kind: 'alert',
          text: '요청 결과를 확인하지 못했습니다. 같은 요청 재확인으로 서버 결과를 조회하세요.',
        });
      }
    }
  }

  return (
    <section className={styles.panel} aria-label="코칭 실행">
      <h2>코칭 실행</h2>
      <p>
        선택한 저장 근거와 상담 기록을 검토합니다. 실행 또는 후보 검증만으로 계획이 바뀌지 않습니다.
      </p>
      {feedback ? <p role={feedback.kind}>{feedback.text}</p> : null}
      {operation && feedback?.kind === 'alert' ? (
        <button type="button" onClick={() => void send(operation)}>
          같은 요청 재확인
        </button>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          disabled={!canStart}
          onClick={() => {
            const parsed = coachingRunCreateCommandV1Schema.safeParse({
              schemaVersion: 1,
              evidenceSnapshotId: snapshotId,
              expectedConversationRevision: observedRevision,
              idempotencyKey: createId(),
            });
            if (parsed.success) void send({ kind: 'create', command: parsed.data });
            else setFeedback({ kind: 'alert', text: '선택한 근거와 상담 기록을 확인하세요.' });
          }}
        >
          선택한 근거로 실행
        </button>
        <button type="button" disabled={busy} onClick={() => void list.refetch()}>
          실행 목록 새로고침
        </button>
      </div>
      {!snapshotId ? (
        <p>실행하려면 저장된 근거를 먼저 선택하세요.</p>
      ) : observedRevision === null ? (
        <p>최신 상담 기록을 모두 불러온 뒤 실행할 수 있습니다.</p>
      ) : (
        <p>선택한 근거와 확인한 상담 기록 {observedRevision}번을 사용합니다.</p>
      )}
      {list.isPending ? <p role="status">실행 목록 조회 중</p> : null}
      {list.isError ? <p role="alert">실행 목록을 확인할 수 없습니다.</p> : null}
      {list.data && list.data.items.length === 0 ? <p>아직 실행 기록이 없습니다.</p> : null}
      {list.data && list.data.items.length > 0 ? (
        <div>
          <h3>실행 기록</h3>
          <ul className={styles.history}>
            {list.data.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={runId === item.id}
                  disabled={busy}
                  onClick={() => {
                    setSelectedId(item.id);
                    setPollingSince(Date.now());
                    setFeedback(null);
                  }}
                >
                  {item.createdAt} · {statusLabels[item.status.kind]}
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy || offset === 0}
              onClick={() => {
                setOffset((value) => Math.max(0, value - 20));
                setSelectedId(null);
              }}
            >
              최신 기록
            </button>
            <button
              type="button"
              disabled={busy || offset + 20 >= list.data.total}
              onClick={() => {
                setOffset((value) => value + 20);
                setSelectedId(null);
              }}
            >
              이전 기록
            </button>
          </div>
        </div>
      ) : null}
      {runId && run.isFetching ? <p role="status">선택한 실행 조회 중</p> : null}
      {run.isError ? (
        <p role="alert">
          선택한 실행을 확인할 수 없습니다.{' '}
          <button type="button" onClick={() => void run.refetch()}>
            실행 다시 확인
          </button>
        </p>
      ) : null}
      {visibleRun ? (
        <section aria-label="선택한 실행" className={styles.detail}>
          <h3>선택한 실행</h3>
          {visibleRun.source.kind === 'deterministic_fixture' ? (
            <p>테스트용 결정론 fixture 실행입니다. 실제 AI 상담 결과가 아닙니다.</p>
          ) : (
            <p>서버에 설정된 공급자 실행입니다. 계획 변경에는 별도 승인이 필요합니다.</p>
          )}
          <RunStage run={visibleRun} />
          {!selectedSnapshotMatches ? (
            <p>이 실행의 근거는 현재 선택한 근거와 다릅니다. 기록을 검토하세요.</p>
          ) : null}
          <div className={styles.actions}>
            <button type="button" disabled={busy} onClick={() => void run.refetch()}>
              상태 새로고침
            </button>
            {inFlight(visibleRun) ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void send({ kind: 'cancel', runId: visibleRun.id })}
              >
                실행 취소
              </button>
            ) : null}
          </div>
          {visibleRun.status.kind === 'analysis_ready' &&
          visibleRun.source.kind === 'deterministic_fixture' ? (
            <button
              type="button"
              disabled={
                busy ||
                !selectedSnapshotMatches ||
                observedRevision !== visibleRun.conversationRevision ||
                candidates.isPending ||
                Boolean(visibleCandidates?.length)
              }
              onClick={() =>
                void send({ kind: 'fixture', runId: visibleRun.id, idempotencyKey: createId() })
              }
            >
              테스트용 fixture 후보 검증
            </button>
          ) : null}
          {visibleRun.status.kind === 'analysis_ready' &&
          visibleRun.source.kind !== 'deterministic_fixture' ? (
            <p>이 실행의 후보 검증은 이 화면에서 제공되지 않습니다.</p>
          ) : null}
          {candidates.isFetching ? <p role="status">검증된 후보 조회 중</p> : null}
          {candidates.isError ? (
            <p role="alert">
              후보를 확인할 수 없습니다.{' '}
              <button type="button" onClick={() => void candidates.refetch()}>
                후보 다시 확인
              </button>
            </p>
          ) : null}
          {visibleRun.status.kind === 'validated_final' && visibleCandidates?.length === 0 ? (
            <p>현재 검토 가능한 후보가 없습니다. 근거와 동의 상태를 다시 확인하세요.</p>
          ) : null}
          {visibleCandidates && visibleCandidates.length > 0 ? (
            <div>
              <h4>서버에서 검증한 후보</h4>
              <ul>
                {visibleCandidates.map(({ candidate }) => (
                  <li key={candidate.id}>
                    {candidate.validation.status === 'checked' ? (
                      <a href={`/proposals/${encodeURIComponent(candidate.id)}`}>
                        후보 제안 검토 · {candidate.createdAt}
                      </a>
                    ) : (
                      <span>검증 상태 {candidate.validation.status} · 승인할 수 없음</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
