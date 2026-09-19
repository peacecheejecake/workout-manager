'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  integratedApprovalResultV4Schema,
  integratedCandidateV4Schema,
  type IntegratedApprovalResultV4,
  type IntegratedCandidateV4,
  type IntegratedWriteV4,
} from '@workout/contracts/integrated-coaching';
import {
  integratedApprovalV023Schema,
  type IntegratedApprovalV023,
  type PlanDomain,
} from '@workout/contracts/routines';
import styles from './candidate-review.module.css';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const domainLabel: Record<PlanDomain, string> = {
  training: '훈련',
  nutrition: '영양',
  recovery: '회복',
  routine_schedule: '루틴 일정',
};
type Phase = 'idle' | 'sending' | 'uncertain' | 'conflict' | 'unsupported' | 'approved';
type ApprovalCommand = {
  candidateId: string;
  request: IntegratedApprovalV023;
};

export interface IntegratedCandidateReviewWorkspaceProps {
  athleteId: string;
  sessionId: string;
  candidateId: string;
  transport: AuthenticatedTransport;
  /** Optional host/test cache; a standalone workspace owns one when omitted. */
  queryClient?: QueryClient;
}

class IntegratedCandidateRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function createIntegratedCandidateApi(transport: AuthenticatedTransport) {
  const path = (id: string) =>
    `/bff/v1/integrated-candidates/${encodeURIComponent(uuid.parse(id))}`;
  async function request<T>(
    method: TransportRequest['method'],
    requestPath: string,
    schema: z.ZodType<T>,
    body: TransportRequest['body'],
    idempotencyKey: string | null,
    signal?: AbortSignal,
  ): Promise<T> {
    const reply = transportReplySchema.parse(
      await transport.request({
        method,
        path: requestPath,
        body,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      }),
    );
    if (reply.status < 200 || reply.status >= 300) {
      const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(reply.body);
      throw new IntegratedCandidateRequestError(
        reply.status,
        error.success ? error.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  return {
    async read(id: string, signal?: AbortSignal) {
      const normalized = uuid.parse(id);
      const candidate = await request(
        'GET',
        `${path(normalized)}?maxSchemaVersion=4`,
        integratedCandidateV4Schema,
        null,
        null,
        signal,
      );
      if (candidate.id !== normalized) throw new Error('CANDIDATE_RESPONSE_MISMATCH');
      return candidate;
    },
    approve(command: ApprovalCommand, signal?: AbortSignal) {
      const parsed = integratedApprovalV023Schema.parse(command.request);
      const { idempotencyKey, ...body } = parsed;
      if (body.candidateId !== command.candidateId) throw new Error('APPROVAL_CANDIDATE_MISMATCH');
      return request(
        'POST',
        `${path(command.candidateId)}/approve`,
        integratedApprovalResultV4Schema,
        body,
        idempotencyKey,
        signal,
      );
    },
  };
}

function WriteDetails({ write }: { write: IntegratedWriteV4 }) {
  switch (write.domain) {
    case 'training':
      return (
        <p>
          훈련 계획 {write.proposed.title} · 기간 {write.proposed.periods.length}건 · 세션{' '}
          {write.proposed.sessions.length}건
        </p>
      );
    case 'nutrition':
      return (
        <p>
          영양 계획 {write.proposed.purpose} · 항목 {write.proposed.items.length}건
        </p>
      );
    case 'recovery': {
      const selected = write.proposed.options.find(
        (option) => option.id === write.selectedOptionId,
      );
      return (
        <p>
          회복 전략 {write.proposed.title} · 선택 {selected?.title ?? write.selectedOptionId}
        </p>
      );
    }
    case 'routine_schedule':
      return (
        <p>
          루틴 일정 {write.proposed.state} · 발생분 {write.occurrences.length}건 · 원본 계획{' '}
          {write.sourcePlanVersionId ?? '없음'}
        </p>
      );
  }
}

function CandidateDetails({ candidate }: { candidate: IntegratedCandidateV4 }) {
  return (
    <div className={styles.grid}>
      <section className={styles.card} aria-label="네 도메인 변경">
        <h2>네 도메인 변경</h2>
        <p>{candidate.summary}</p>
        <ul>
          {candidate.writes.map((write) => (
            <li key={`${write.domain}:${write.aggregateId}`}>
              <strong>{domainLabel[write.domain]}</strong> · aggregate {write.aggregateId}
              <WriteDetails write={write} />
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.card} aria-label="계획 head 기준">
        <h2>계획 head 기준</h2>
        <ul>
          {candidate.basis.planHeads.map((head) => (
            <li key={`${head.domain}:${head.aggregateId}`}>
              {domainLabel[head.domain]} · {head.aggregateId} ·{' '}
              {head.head.kind === 'exists' ? `기존 버전 ${head.head.versionId}` : '기존 head 없음'}
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.card} aria-label="읽기 의존성과 검증">
        <h2>읽기 의존성과 검증</h2>
        <p>
          검증 {candidate.validation.status} · 오류 {candidate.validation.errors.length}건 · 미확인{' '}
          {candidate.validation.unknowns.length}건
        </p>
        <h3>오류</h3>
        {candidate.validation.errors.length ? (
          <ul>
            {candidate.validation.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : (
          <p>없음</p>
        )}
        <h3>미확인</h3>
        {candidate.validation.unknowns.length ? (
          <ul>
            {candidate.validation.unknowns.map((unknown) => (
              <li key={unknown}>{unknown}</li>
            ))}
          </ul>
        ) : (
          <p>없음</p>
        )}
        <h3>문맥 의존성</h3>
        {candidate.basis.contextDependencies.length ? (
          <ul>
            {candidate.basis.contextDependencies.map((dependency) => (
              <li key={`${dependency.kind}:${dependency.id}`}>
                {dependency.kind} · {dependency.id} · 개정 {dependency.revision}
              </li>
            ))}
          </ul>
        ) : (
          <p>없음</p>
        )}
      </section>
    </div>
  );
}

function appliedLabel(result: IntegratedApprovalResultV4) {
  return result.versions
    .map((version) => `${domainLabel[version.domain]} ${version.versionId}`)
    .join(' · ');
}

export function IntegratedCandidateReviewWorkspace({
  queryClient,
  ...props
}: IntegratedCandidateReviewWorkspaceProps) {
  uuid.parse(props.candidateId);
  const [client] = useState(
    () =>
      queryClient ??
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
      }),
  );
  useEffect(() => {
    if (queryClient) return;
    return () => client.clear();
  }, [client, queryClient]);
  return (
    <QueryClientProvider client={client}>
      <IntegratedCandidateReview {...props} />
    </QueryClientProvider>
  );
}

function IntegratedCandidateReview({
  athleteId,
  sessionId,
  candidateId,
  transport,
}: Omit<IntegratedCandidateReviewWorkspaceProps, 'queryClient'>) {
  const normalizedCandidateId = uuid.parse(candidateId);
  const api = useMemo(() => createIntegratedCandidateApi(transport), [transport]);
  const client = useQueryClient();
  const [reviewed, setReviewed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [feedback, setFeedback] = useState('');
  const [approved, setApproved] = useState<IntegratedApprovalResultV4 | null>(null);
  const pending = useRef<ApprovalCommand | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, []);
  const detail = useQuery({
    queryKey: [
      'users',
      athleteId,
      'sessions',
      sessionId,
      'integrated-candidate-v4',
      normalizedCandidateId,
    ],
    queryFn: ({ signal }) => api.read(normalizedCandidateId, signal),
    retry: false,
    staleTime: 0,
  });
  const unsupported =
    detail.error instanceof IntegratedCandidateRequestError &&
    detail.error.code === 'UNSUPPORTED_SCHEMA_VERSION';
  const candidate = detail.isSuccess ? detail.data : null;
  const approvable =
    candidate?.validation.status === 'checked' &&
    candidate.validation.errors.length === 0 &&
    candidate.validation.unknowns.length === 0;
  const blocked = phase !== 'idle' || detail.isFetching || !candidate || !approvable;

  async function invalidateRelatedQueries() {
    await Promise.allSettled([
      client.invalidateQueries({
        queryKey: ['users', athleteId, 'sessions', sessionId, 'integrated-candidate-v4'],
      }),
      client.invalidateQueries({
        queryKey: ['users', athleteId, 'sessions', sessionId, 'coaching'],
      }),
      client.invalidateQueries({ queryKey: ['planning', athleteId, sessionId] }),
      client.invalidateQueries({ queryKey: ['integrated-planner', athleteId, sessionId] }),
    ]);
  }

  async function send(command: ApprovalCommand) {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted) return;
    if (!navigator.onLine) {
      setPhase('uncertain');
      setFeedback(
        '오프라인입니다. 연결 후 같은 요청으로 다시 확인하세요. 아직 적용되지 않았습니다.',
      );
      return;
    }
    setPhase('sending');
    setFeedback('');
    try {
      const result = await api.approve(command, signal);
      if (signal.aborted) return;
      pending.current = null;
      setApproved(result);
      setPhase('approved');
      setFeedback('서버에서 네 도메인 계획의 원자적 적용을 확인했습니다.');
      await invalidateRelatedQueries();
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof IntegratedCandidateRequestError &&
        error.code === 'UNSUPPORTED_SCHEMA_VERSION'
      ) {
        pending.current = null;
        setReviewed(false);
        setPhase('unsupported');
        setFeedback('이 제안은 현재 앱에서 지원하지 않습니다. 앱을 업데이트한 뒤 다시 검토하세요.');
      } else if (
        error instanceof IntegratedCandidateRequestError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        pending.current = null;
        setReviewed(false);
        setPhase('conflict');
        setFeedback(`후보가 적용되지 않았습니다 (${error.code}). 최신 후보를 다시 검토하세요.`);
      } else {
        setPhase('uncertain');
        setFeedback('서버 응답을 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요.');
      }
    }
  }

  function startApproval() {
    if (blocked || !reviewed || !candidate) return;
    const request = integratedApprovalV023Schema.parse({
      schemaVersion: 4,
      confirmed: true,
      proposalId: candidate.proposalId,
      candidateId: candidate.id,
      proposalDigest: candidate.digest,
      writeDomains: candidate.writes.map((write) => write.domain),
      expectedBasis: candidate.basis,
      idempotencyKey: crypto.randomUUID(),
    });
    const command = { candidateId: candidate.id, request };
    pending.current = command;
    void send(command);
  }

  return (
    <section className={styles.workspace} aria-label="네 도메인 통합 후보 검토">
      <h1>네 도메인 통합 후보 검토</h1>
      <p>제안과 실제 기록은 별개입니다. 명시적으로 확인한 계획 변경만 승인됩니다.</p>
      {detail.isPending ? <p role="status">통합 후보 불러오는 중</p> : null}
      {unsupported ? (
        <p role="alert">이 제안은 현재 앱에서 지원하지 않습니다. 앱을 업데이트해 주세요.</p>
      ) : detail.isError ? (
        <p role="alert">통합 후보를 불러오지 못했습니다. 승인할 수 없습니다.</p>
      ) : null}
      {candidate ? (
        <>
          <CandidateDetails candidate={candidate} />
          <section className={styles.card} aria-label="통합 승인 확인">
            <h2>통합 승인 확인</h2>
            {!approvable ? (
              <p role="alert">오류 또는 미확인 항목이 있어 이 후보를 승인할 수 없습니다.</p>
            ) : null}
            <label>
              <input
                type="checkbox"
                checked={reviewed}
                disabled={phase !== 'idle' || !approvable}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              이 후보의 훈련·영양·회복·루틴 일정 변경과 근거를 확인했습니다.
            </label>
            <button type="button" disabled={blocked || !reviewed} onClick={startApproval}>
              네 도메인 변경 승인
            </button>
          </section>
        </>
      ) : null}
      {phase === 'uncertain' ? (
        <button
          type="button"
          onClick={() => {
            if (pending.current) void send(pending.current);
          }}
        >
          같은 요청 재시도
        </button>
      ) : null}
      {feedback ? (
        <p role={phase === 'conflict' || phase === 'unsupported' ? 'alert' : 'status'}>
          {feedback}
        </p>
      ) : null}
      {approved ? (
        <p role="status">
          적용 완료 · {appliedLabel(approved)} · 루틴 발생분 {approved.occurrenceIds.length}건
        </p>
      ) : null}
    </section>
  );
}
