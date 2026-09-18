'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import type { AuthenticatedTransport } from '@workout/contracts/core';
import {
  trainingCandidatePartialRequestV1Schema,
  type TrainingCandidateDiffV1,
  type TrainingCandidateIssueV1,
  type TrainingCandidateV1,
} from '@workout/contracts/coaching-candidates';
import type { PeriodDraft, PlanDraft, PlannedSession } from '@workout/contracts/planning';
import { CandidateRequestError, createCandidateApi } from './candidate-api';
import {
  createCandidateReviewStore,
  type CandidatePending,
  type CandidateReviewStore,
} from './candidate-review-store';
import styles from './candidate-review.module.css';

export interface CandidateReviewWorkspaceProps {
  athleteId: string;
  sessionId: string;
  transport: AuthenticatedTransport;
  candidateId: string;
  createId?: () => string;
}

const createRandomId = () => crypto.randomUUID();
const candidateHref = (id: string) => `/proposals/${encodeURIComponent(id)}`;

export function CandidateReviewWorkspace(props: CandidateReviewWorkspaceProps) {
  return (
    <Lifetime
      key={JSON.stringify([props.athleteId, props.sessionId, props.candidateId])}
      {...props}
    />
  );
}

function Lifetime(props: CandidateReviewWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  const [store] = useState(createCandidateReviewStore);
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
      <Review {...props} store={store} />
    </QueryClientProvider>
  );
}

function IssueList({ title, issues }: { title: string; issues: TrainingCandidateIssueV1[] }) {
  return (
    <div>
      <h4>
        {title} {issues.length}건
      </h4>
      {issues.length === 0 ? (
        <p>없음</p>
      ) : (
        <ul>
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              {issue.code} ·{' '}
              {issue.subject.kind === 'session'
                ? `세션 ${issue.subject.id}`
                : issue.subject.kind === 'date'
                  ? `날짜 ${issue.subject.date}`
                  : '계획 전체'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sessionLabel(session: PlannedSession) {
  const duration = session.durationRange
    ? `${session.durationRange.minSeconds}~${session.durationRange.maxSeconds}초`
    : session.durationSeconds === null
      ? '시간 미확인'
      : `${session.durationSeconds}초`;
  const distance = session.distanceRange
    ? `${session.distanceRange.minMeters}~${session.distanceRange.maxMeters}m`
    : session.distanceMeters === null
      ? '거리 미확인'
      : `${session.distanceMeters}m`;
  return `${session.title} · ${duration} · ${distance}`;
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value: string | number | null | undefined;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value === null || value === undefined || value === '' ? '미지정' : value}</dd>
    </>
  );
}

function SessionDetail({ session }: { session: PlannedSession }) {
  return (
    <>
      {session.date} · {sessionLabel(session)}
      <details className={styles.details}>
        <summary>세션 세부 내용</summary>
        <dl>
          <DetailField label="세션 ID" value={session.id} />
          <DetailField label="Block" value={session.blockId} />
          <DetailField label="날짜" value={session.date} />
          <DetailField label="시작 시각" value={session.localStartTime} />
          <DetailField label="제목" value={session.title} />
          <DetailField label="종목" value={session.sport} />
          <DetailField
            label="예정 시간"
            value={session.durationSeconds === null ? null : `${session.durationSeconds}초`}
          />
          <DetailField
            label="시간 범위"
            value={
              session.durationRange
                ? `${session.durationRange.minSeconds}~${session.durationRange.maxSeconds}초`
                : null
            }
          />
          <DetailField
            label="예정 거리"
            value={session.distanceMeters === null ? null : `${session.distanceMeters}m`}
          />
          <DetailField
            label="거리 범위"
            value={
              session.distanceRange
                ? `${session.distanceRange.minMeters}~${session.distanceRange.maxMeters}m`
                : null
            }
          />
          <DetailField label="목표 RPE" value={session.targetRpe} />
          <DetailField label="강도" value={session.intensityLabel} />
          <DetailField
            label="페이스 목표"
            value={
              session.paceTarget
                ? `${session.paceTarget.minSecondsPerKm}~${session.paceTarget.maxSecondsPerKm}초/km`
                : null
            }
          />
          <DetailField
            label="심박 목표"
            value={
              session.heartRateTarget
                ? `${session.heartRateTarget.minBpm}~${session.heartRateTarget.maxBpm}bpm`
                : null
            }
          />
          <DetailField label="목적" value={session.purpose} />
          <DetailField label="메모" value={session.notes} />
          <DetailField label="우선순위" value={session.priority} />
          <DetailField
            label="잠금"
            value={
              [
                session.locks.date ? '날짜' : null,
                session.locks.time ? '시각' : null,
                session.locks.intensity ? '강도' : null,
                session.locks.attendance ? '참석' : null,
              ]
                .filter(Boolean)
                .join(', ') || '없음'
            }
          />
          <DetailField
            label="단계"
            value={
              session.steps.length === 0
                ? '없음'
                : session.steps
                    .map(
                      (step) =>
                        `${step.id} ${step.kind} · ${step.durationSeconds === null ? '시간 미확인' : `${step.durationSeconds}초`} · ${step.distanceMeters === null ? '거리 미확인' : `${step.distanceMeters}m`} · ${step.repetitions}회`,
                    )
                    .join(' / ')
            }
          />
        </dl>
      </details>
    </>
  );
}

function PeriodDetail({ period }: { period: PeriodDraft }) {
  return (
    <>
      {period.title} · {period.startDate}~{period.endDateExclusive}
      <details className={styles.details}>
        <summary>기간 세부 내용</summary>
        <dl>
          <DetailField label="기간 ID" value={period.id} />
          <DetailField label="상위 기간" value={period.parentId} />
          <DetailField label="단계" value={period.level} />
          <DetailField label="제목" value={period.title} />
          <DetailField label="시작일" value={period.startDate} />
          <DetailField label="종료일 미포함" value={period.endDateExclusive} />
          <DetailField label="시간대" value={period.timezone} />
          <DetailField label="목적" value={period.intent} />
          <DetailField label="부분 기간" value={period.isPartial ? '예' : '아니요'} />
          <DetailField label="우선순위" value={period.priority} />
          <DetailField
            label="운동 불가 날짜"
            value={period.constraints?.unavailableDates.join(', ') || '없음'}
          />
          <DetailField
            label="날짜별 가용 시간"
            value={
              period.constraints?.dailyTimeLimits
                .map((limit) => `${limit.date} ${limit.availableSeconds}초`)
                .join(', ') || '없음'
            }
          />
        </dl>
      </details>
    </>
  );
}

function CalendarComparison({ candidate }: { candidate: TrainingCandidateV1 }) {
  const dates = new Set<string>();
  for (const change of candidate.diff.sessionChanges) {
    if (change.before) dates.add(change.before.date);
    if (change.after) dates.add(change.after.date);
  }
  for (const change of candidate.diff.periodChanges) {
    if (change.before) {
      dates.add(change.before.startDate);
      dates.add(change.before.endDateExclusive);
    }
    if (change.after) {
      dates.add(change.after.startDate);
      dates.add(change.after.endDateExclusive);
    }
  }
  const rows = [...dates].sort();
  const index = (draft: PlanDraft) => {
    const byDate = new Map<string, PlannedSession[]>();
    for (const session of draft.sessions) {
      const entries = byDate.get(session.date) ?? [];
      entries.push(session);
      byDate.set(session.date, entries);
    }
    for (const entries of byDate.values())
      entries.sort(
        (a, b) =>
          (a.localStartTime ?? '').localeCompare(b.localStartTime ?? '') ||
          a.id.localeCompare(b.id),
      );
    return byDate;
  };
  const beforeByDate = index(candidate.before.draft);
  const afterByDate = index(candidate.proposed);
  return (
    <section className={styles.card} aria-label="변경 전후 일정">
      <h3>변경 전후 일정</h3>
      <p>변경된 세션 날짜와 기간 경계의 계획을 비교합니다. 실제 수행 기록이 아닙니다.</p>
      {rows.length === 0 ? (
        <p>날짜별 일정 변경은 없습니다.</p>
      ) : (
        <div className={styles.tableScroll}>
          <table>
            <caption>영향받는 날짜별 원안과 제안</caption>
            <thead>
              <tr>
                <th scope="col">날짜</th>
                <th scope="col">원안</th>
                <th scope="col">제안</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((date) => (
                <tr key={date}>
                  <th scope="row" className={styles.nowrap}>
                    {date}
                  </th>
                  <td>
                    {beforeByDate.get(date)?.map(sessionLabel).join(' / ') || '예정 세션 없음'}
                  </td>
                  <td>
                    {afterByDate.get(date)?.map(sessionLabel).join(' / ') || '예정 세션 없음'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Impact({
  label,
  value,
}: {
  label: string;
  value: TrainingCandidateDiffV1['duration'] | TrainingCandidateDiffV1['distance'];
}) {
  const unit = value.before.unit;
  const range = (min: number, max: number) =>
    min === max ? `${min}${unit}` : `${min}~${max}${unit}`;
  return (
    <div>
      <h4>{label}</h4>
      <p>
        원안 {range(value.before.knownMin, value.before.knownMax)} · 제안{' '}
        {range(value.after.knownMin, value.after.knownMax)}
      </p>
      <p>
        변화량 {value.delta === null ? '확정할 수 없음' : range(value.delta.min, value.delta.max)}
        {' · '}미확인 세션 원안 {value.before.unknownSessionIds.length}개, 제안{' '}
        {value.after.unknownSessionIds.length}개
      </p>
    </div>
  );
}

function ChangeComparison({
  candidate,
  store,
  disabled,
}: {
  candidate: TrainingCandidateV1;
  store: CandidateReviewStore;
  disabled: boolean;
}) {
  const sessionIds = useStore(store, (state) => state.sessionIds);
  const periodIds = useStore(store, (state) => state.periodIds);
  const includeTitle = useStore(store, (state) => state.includeTitle);
  const actions = useStore(store, (state) => state.actions);
  const diff = candidate.diff;
  return (
    <section className={styles.card} aria-label="변경 항목 비교">
      <h3>변경 항목</h3>
      <p>
        일부만 적용하려면 항목을 선택하여 새 후보를 만드세요. 선택만으로 계획이 바뀌지 않습니다.
      </p>
      <fieldset disabled={disabled}>
        <legend>새 후보에 포함할 변경</legend>
        {diff.title ? (
          <label>
            <input
              type="checkbox"
              checked={includeTitle}
              onChange={(event) => actions.setTitle(event.target.checked)}
            />
            제목: {diff.title.before} → {diff.title.after}
          </label>
        ) : (
          <p>제목 변경 없음</p>
        )}
        {diff.periodChanges.map((change) => (
          <label key={`period-${change.id}`}>
            <input
              type="checkbox"
              checked={periodIds.includes(change.id)}
              onChange={() => actions.togglePeriod(change.id)}
            />
            기간 {change.id} · {change.kind}
          </label>
        ))}
        {diff.sessionChanges.map((change) => (
          <label key={`session-${change.id}`}>
            <input
              type="checkbox"
              checked={sessionIds.includes(change.id)}
              onChange={() => actions.toggleSession(change.id)}
            />
            세션 {change.id} · {change.kind}
          </label>
        ))}
      </fieldset>
      <div className={styles.tableScroll}>
        <table>
          <caption>변경 전후 세부 항목</caption>
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">원안</th>
              <th scope="col">제안</th>
            </tr>
          </thead>
          <tbody>
            {diff.title ? (
              <tr>
                <th scope="row">계획 제목</th>
                <td>{diff.title.before}</td>
                <td>{diff.title.after}</td>
              </tr>
            ) : null}
            {diff.periodChanges.map((change) => (
              <tr key={`period-${change.id}`}>
                <th scope="row">기간 {change.id}</th>
                <td>{change.before ? <PeriodDetail period={change.before} /> : '없음'}</td>
                <td>{change.after ? <PeriodDetail period={change.after} /> : '없음'}</td>
              </tr>
            ))}
            {diff.sessionChanges.map((change) => (
              <tr key={`session-${change.id}`}>
                <th scope="row">세션 {change.id}</th>
                <td>{change.before ? <SessionDetail session={change.before} /> : '없음'}</td>
                <td>{change.after ? <SessionDetail session={change.after} /> : '없음'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Review({
  athleteId,
  sessionId,
  transport,
  candidateId,
  createId = createRandomId,
  store,
}: CandidateReviewWorkspaceProps & { store: CandidateReviewStore }) {
  const api = useMemo(() => createCandidateApi(transport), [transport]);
  const client = useQueryClient();
  const scope = [
    'users',
    athleteId,
    'sessions',
    sessionId,
    'candidate-review',
    candidateId,
  ] as const;
  const status = useQuery({
    queryKey: [...scope, 'status'],
    queryFn: ({ signal }) => api.status(candidateId, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const detail = useQuery({
    queryKey: [...scope, 'detail'],
    queryFn: ({ signal }) => api.read(candidateId, signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const plan = useQuery({
    queryKey: [...scope, 'plan'],
    queryFn: ({ signal }) => api.plan(signal),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  const peerRunId = detail.data?.candidate.runId;
  const peers = useQuery({
    queryKey: [...scope, 'peers', peerRunId ?? null],
    queryFn: ({ signal }) => {
      if (!peerRunId) throw new Error('CANDIDATE_RUN_UNAVAILABLE');
      return api.peers(peerRunId, signal);
    },
    enabled: peerRunId !== undefined && status.data?.kind === 'current',
    staleTime: 0,
    gcTime: 0,
  });
  const sessionIds = useStore(store, (state) => state.sessionIds);
  const periodIds = useStore(store, (state) => state.periodIds);
  const includeTitle = useStore(store, (state) => state.includeTitle);
  const confirmed = useStore(store, (state) => state.confirmed);
  const pending = useStore(store, (state) => state.pending);
  const phase = useStore(store, (state) => state.phase);
  const conflict = useStore(store, (state) => state.conflict);
  const feedback = useStore(store, (state) => state.feedback);
  const partialCandidateId = useStore(store, (state) => state.partialCandidateId);
  const approvedVersion = useStore(store, (state) => state.approvedVersion);
  const actions = useStore(store, (state) => state.actions);
  const life = useRef<AbortController | null>(null);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);

  const candidate = detail.data?.candidate;
  const current = status.data?.kind === 'current';
  const headMatches = candidate !== undefined && plan.data?.head?.id === candidate.before.id;
  const validated =
    candidate?.validation.status === 'checked' &&
    candidate.validation.errors.length === 0 &&
    candidate.validation.unknowns.length === 0;
  const reviewReady =
    current &&
    headMatches &&
    !status.isFetching &&
    !detail.isFetching &&
    !plan.isFetching &&
    !status.isError &&
    !detail.isError &&
    !plan.isError &&
    !pending &&
    !conflict &&
    !approvedVersion &&
    !reviewing;
  const approvalReady = reviewReady && validated;

  async function refresh() {
    if (pending || reviewing) return;
    setReviewing(true);
    try {
      const [latestStatus, latestPlan] = await Promise.all([status.refetch(), plan.refetch()]);
      if (latestStatus.data?.kind === 'current') await detail.refetch();
      if (latestStatus.isSuccess && latestPlan.isSuccess && !life.current?.signal.aborted)
        actions.reviewed();
    } finally {
      if (!life.current?.signal.aborted) setReviewing(false);
    }
  }

  async function send(command: CandidatePending) {
    const signal = life.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      if (command.kind === 'partial') {
        const created = await api.partial(candidateId, command.command, signal);
        if (signal.aborted) return;
        actions.partialSucceeded(created.candidate.id);
        await client.invalidateQueries({ queryKey: [...scope, 'peers'] });
      } else {
        const version = await api.approve(
          candidateId,
          command.expectedDigest,
          command.idempotencyKey,
          signal,
        );
        if (signal.aborted) return;
        actions.approvalSucceeded({ id: version.id, version: version.version });
        await Promise.all([
          client.resetQueries({ queryKey: [...scope, 'plan'], exact: true }),
          client.resetQueries({ queryKey: [...scope, 'status'], exact: true }),
        ]);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof CandidateRequestError && [404, 409, 422].includes(error.status)) {
        actions.reject('후보 또는 기준 계획이 변경되었습니다. 최신 상태를 다시 확인하세요.', true);
        await Promise.all([
          client.resetQueries({ queryKey: [...scope, 'status'], exact: true }),
          client.resetQueries({ queryKey: [...scope, 'plan'], exact: true }),
        ]);
      } else if (
        error instanceof CandidateRequestError &&
        [400, 401, 403, 413].includes(error.status)
      ) {
        actions.reject('요청을 처리할 수 없습니다. 접근 권한과 선택 항목을 확인하세요.');
      } else actions.uncertain();
    }
  }

  function createPartial() {
    if (!reviewReady || !candidate) return;
    const result = trainingCandidatePartialRequestV1Schema.safeParse({
      schemaVersion: 1,
      sessionIds: candidate.diff.sessionChanges
        .map((change) => change.id)
        .filter((id) => sessionIds.includes(id)),
      periodIds: candidate.diff.periodChanges
        .map((change) => change.id)
        .filter((id) => periodIds.includes(id)),
      includeTitle: candidate.diff.title !== null && includeTitle,
      idempotencyKey: createId(),
    });
    if (!result.success) {
      actions.reject('새 후보에 포함할 변경을 하나 이상 선택하세요.');
      return;
    }
    const command: CandidatePending = { kind: 'partial', command: result.data };
    if (actions.begin(command)) void send(command);
  }

  async function approve() {
    if (!approvalReady || !confirmed || !candidate) return;
    const signal = life.current?.signal;
    if (!signal || signal.aborted) return;
    setReviewing(true);
    try {
      const [latestStatus, latestPlan] = await Promise.all([
        api.status(candidateId, signal),
        api.plan(signal),
      ]);
      if (signal.aborted) return;
      if (latestStatus.kind !== 'current' || latestPlan.head?.id !== candidate.before.id) {
        actions.reject('후보 또는 기준 계획이 변경되었습니다. 최신 상태를 다시 확인하세요.', true);
        await Promise.all([status.refetch(), plan.refetch()]);
        return;
      }
      const command: CandidatePending = {
        kind: 'approval',
        expectedDigest: candidate.digest,
        idempotencyKey: createId(),
      };
      if (actions.begin(command)) void send(command);
    } catch {
      if (!signal.aborted)
        actions.reject('최신 후보와 계획을 확인할 수 없습니다. 다시 확인하세요.');
    } finally {
      if (!signal.aborted) setReviewing(false);
    }
  }

  return (
    <section className={styles.workspace} aria-label="제안 검토">
      <h1>제안 검토</h1>
      <p>
        제안은 계획 초안입니다. 명시적으로 승인한 뒤 서버가 저장을 확인할 때만 계획에 적용됩니다.
      </p>
      <div className={styles.actions}>
        <a href="/coach">코치로 돌아가기</a>
        <button
          type="button"
          disabled={Boolean(pending) || reviewing}
          onClick={() => void refresh()}
        >
          최신 상태 확인
        </button>
      </div>
      {feedback ? (
        <p role={conflict || phase === 'uncertain' ? 'alert' : 'status'}>{feedback}</p>
      ) : null}
      {phase === 'sending' ? <p role="status">서버에서 요청을 확인하고 있습니다.</p> : null}
      {phase === 'uncertain' ? (
        <button
          type="button"
          onClick={() => {
            const command = actions.retry();
            if (command) void send(command);
          }}
        >
          같은 요청으로 결과 재확인
        </button>
      ) : null}
      {approvedVersion ? (
        <div className={styles.card} role="status">
          <p>
            서버에서 적용한 계획 버전 {approvedVersion.version} · {approvedVersion.id}
          </p>
          <a href="/planner">저장된 계획 보기</a>
        </div>
      ) : null}
      {partialCandidateId ? (
        <p>
          <a href={candidateHref(partialCandidateId)}>새로 검증한 후보 검토</a>
        </p>
      ) : null}
      {status.isPending || status.isFetching ? (
        <p role="status">후보 상태 확인 중</p>
      ) : status.isError ? (
        <p role="alert">
          후보 상태를 확인할 수 없습니다. 이 환경에서 제공되지 않거나 후보가 없을 수 있습니다.
        </p>
      ) : status.data.kind === 'withdrawn' ? (
        <p role="alert">이 후보는 철회되었습니다. 본문을 표시하거나 승인할 수 없습니다.</p>
      ) : status.data.kind === 'stale' ? (
        <p role="alert">
          기준 자료가 바뀌어 이 후보는 오래되었습니다. 본문을 표시하거나 승인할 수 없습니다.
        </p>
      ) : detail.isPending || detail.isFetching ? (
        <p role="status">후보 내용 확인 중</p>
      ) : detail.isError || !candidate ? (
        <p role="alert">후보 본문을 확인할 수 없습니다. 최신 상태를 확인하세요.</p>
      ) : plan.isPending || plan.isFetching ? (
        <p role="status">현재 계획 확인 중</p>
      ) : plan.isError ? (
        <p role="alert">현재 계획을 확인할 수 없어 후보 본문을 표시하거나 승인할 수 없습니다.</p>
      ) : !headMatches ? (
        <p role="alert">
          현재 계획이 후보의 기준 버전과 다릅니다. 이 후보의 본문을 표시하거나 승인할 수 없습니다.
        </p>
      ) : (
        <>
          <section className={styles.card} aria-label="후보 요약">
            <h2>후보 요약</h2>
            <p>
              기준 계획 버전 {candidate.before.version} · {candidate.before.draft.title}
            </p>
            <p>
              검증 기준 날짜 {candidate.asOfLocalDate} · 시간대 {candidate.proposed.timezone}
            </p>
            {candidate.parentCandidateId ? (
              <p>
                <a href={candidateHref(candidate.parentCandidateId)}>부모 후보 검토</a>
              </p>
            ) : null}
            <h3>전략</h3>
            <p>{candidate.strategy.summary}</p>
            <h4>보존한 목적</h4>
            <p>{candidate.strategy.preservedIntent}</p>
            <h4>변경 근거</h4>
            <p>{candidate.strategy.rationale}</p>
            <h4>다시 판단할 때</h4>
            <p>{candidate.strategy.revisitWhen}</p>
            <h4>확인되지 않은 정보</h4>
            {candidate.strategy.unconfirmedInformation.length > 0 ? (
              <ul>
                {candidate.strategy.unconfirmedInformation.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>기재된 항목 없음</p>
            )}
          </section>
          {peers.data && peers.data.length > 1 ? (
            <nav className={styles.card} aria-label="같은 실행의 다른 후보">
              <h2>다른 후보</h2>
              <ul>
                {peers.data.map(({ candidate: peer }, index) => (
                  <li key={peer.id}>
                    {peer.id === candidate.id ? (
                      <strong>
                        현재 후보 {index + 1} · {peer.strategy.summary}
                      </strong>
                    ) : (
                      <a href={candidateHref(peer.id)}>
                        후보 {index + 1} · {peer.strategy.summary}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <CalendarComparison candidate={candidate} />
          <ChangeComparison candidate={candidate} store={store} disabled={!reviewReady} />
          <section className={styles.card} aria-label="예상 영향">
            <h3>예상 계획 영향</h3>
            <p>예정 목표의 합계입니다. 실제 운동량이나 효과를 뜻하지 않습니다.</p>
            <div className={styles.grid}>
              <Impact label="시간" value={candidate.diff.duration} />
              <Impact label="거리" value={candidate.diff.distance} />
            </div>
          </section>
          <section className={styles.card} aria-label="후보 검증 결과">
            <h3>후보 검증 결과</h3>
            <p>
              상태: {candidate.validation.status} · 구조 검증{' '}
              {candidate.validation.definitionVersion}
            </p>
            <div className={styles.grid}>
              <IssueList title="오류" issues={candidate.validation.errors} />
              <IssueList title="경고" issues={candidate.validation.warnings} />
              <IssueList title="미확인" issues={candidate.validation.unknowns} />
            </div>
          </section>
          {conflict ? (
            <p role="alert">충돌을 확인했습니다. 최신 상태 확인 후 다시 검토하세요.</p>
          ) : null}
          {!validated ? (
            <p role="alert">오류 또는 미확인 항목이 있어 이 후보를 승인할 수 없습니다.</p>
          ) : null}
          <div className={styles.actions}>
            <button
              type="button"
              disabled={
                !reviewReady || (sessionIds.length === 0 && periodIds.length === 0 && !includeTitle)
              }
              onClick={createPartial}
            >
              선택한 변경으로 새 후보 만들기
            </button>
          </div>
          <fieldset disabled={!approvalReady}>
            <legend>계획 적용 확인</legend>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => actions.setConfirmed(event.target.checked)}
              />
              원안과 제안, 검증 결과를 확인했고 이 후보를 계획에 적용합니다.
            </label>
            <button
              type="button"
              disabled={!approvalReady || !confirmed}
              onClick={() => void approve()}
            >
              확인하고 계획에 적용
            </button>
          </fieldset>
          <p>
            <a href="/coach">적용하지 않기</a>
          </p>
        </>
      )}
    </section>
  );
}
