'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  transportReplySchema,
  type AuthenticatedTransport,
  type TransportRequest,
} from '@workout/contracts/core';
import {
  jointCandidatePartialSelectionV3Schema,
  jointCandidateV3Schema,
  type JointCandidateIssueV3,
  type JointCandidatePartialSelectionV3,
  type JointCandidateV3,
  type JointSupplementaryLinkV3,
} from '@workout/contracts/joint-coaching';
import {
  jointApprovalRequestSchema,
  type JointApprovalRequest,
} from '@workout/contracts/nutrition';
import { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import { planSnapshotSchema } from '@workout/contracts/planning';
import styles from './candidate-review.module.css';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const resultSchema = z.strictObject({
  training: planSnapshotSchema.nullable(),
  nutrition: z.array(nutritionPlanVersionSchema).max(100),
});
type ApprovalResult = z.infer<typeof resultSchema>;
type PartialCommand = {
  kind: 'partial';
  candidateId: string;
  selection: JointCandidatePartialSelectionV3;
  idempotencyKey: string;
};
type ApprovalCommand = { kind: 'approval'; candidateId: string; request: JointApprovalRequest };
type PendingCommand = PartialCommand | ApprovalCommand;
type Selection = {
  includeTrainingTitle: boolean;
  trainingPeriodIds: string[];
  trainingSessionIds: string[];
  nutritionPlanIds: string[];
};
const emptySelection: Selection = {
  includeTrainingTitle: false,
  trainingPeriodIds: [],
  trainingSessionIds: [],
  nutritionPlanIds: [],
};

export interface JointCandidateReviewWorkspaceProps {
  athleteId: string;
  sessionId: string;
  candidateId: string;
  transport: AuthenticatedTransport;
  createId?: () => string;
}

class JointCandidateRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function createJointCandidateApi(transport: AuthenticatedTransport) {
  const path = (id: string) => `/bff/v1/joint-candidates/${encodeURIComponent(uuid.parse(id))}`;
  async function request<T>(
    method: TransportRequest['method'],
    url: string,
    schema: z.ZodType<T>,
    body: TransportRequest['body'] = null,
    idempotencyKey: string | null = null,
    signal?: AbortSignal,
  ): Promise<T> {
    const reply = transportReplySchema.parse(
      await transport.request({
        method,
        path: url,
        body,
        idempotencyKey,
        ...(signal ? { signal } : {}),
      }),
    );
    if (reply.status < 200 || reply.status >= 300) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(reply.body);
      throw new JointCandidateRequestError(
        reply.status,
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
      );
    }
    return schema.parse(reply.body);
  }
  return {
    async read(id: string, signal?: AbortSignal) {
      const normalized = uuid.parse(id);
      const candidate = await request(
        'GET',
        path(normalized),
        jointCandidateV3Schema,
        null,
        null,
        signal,
      );
      if (candidate.id !== normalized) throw new Error('CANDIDATE_RESPONSE_MISMATCH');
      return candidate;
    },
    async partial(command: PartialCommand, signal?: AbortSignal) {
      const selection = jointCandidatePartialSelectionV3Schema.parse(command.selection);
      const candidate = await request(
        'POST',
        `${path(command.candidateId)}/partials`,
        jointCandidateV3Schema,
        { selection },
        command.idempotencyKey,
        signal,
      );
      if (
        candidate.parentCandidateId !== command.candidateId ||
        candidate.id === command.candidateId
      )
        throw new Error('PARTIAL_RESPONSE_MISMATCH');
      return candidate;
    },
    approve(command: ApprovalCommand, signal?: AbortSignal) {
      const { idempotencyKey, ...body } = jointApprovalRequestSchema.parse(command.request);
      if (body.candidateId !== command.candidateId) throw new Error('APPROVAL_CANDIDATE_MISMATCH');
      return request(
        'POST',
        `${path(command.candidateId)}/approve`,
        resultSchema,
        body,
        idempotencyKey,
        signal,
      );
    },
  };
}

function issueSubject(issue: JointCandidateIssueV3): string {
  switch (issue.subject.kind) {
    case 'candidate':
      return '후보 전체';
    case 'session':
      return `세션 ${issue.subject.id}`;
    case 'nutrition_plan':
      return `영양 계획 ${issue.subject.id}`;
    case 'nutrition_item':
      return `영양 항목 ${issue.subject.id}`;
  }
}

function IssueList({ title, issues }: { title: string; issues: JointCandidateIssueV3[] }) {
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
              {issue.code} · {issueSubject(issue)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function frozenLinkLabel(link: JointSupplementaryLinkV3 | undefined): string {
  if (!link) return '없음';
  if (link.content.kind === 'routine_version')
    return `고정 루틴 버전 ${link.content.routineVersionId}`;
  const blocks = link.content.spec.blocks;
  return `고정 내장 보강 ${blocks.length}블록 · ${blocks.reduce((count, block) => count + block.sets.length, 0)}세트 목표`;
}

function periodLabel(
  period: { title: string; startDate: string; endDateExclusive: string } | undefined,
): string {
  return period
    ? `${period.title} (${period.startDate} ~ ${period.endDateExclusive} 미만)`
    : '없음';
}

function sessionLabel(
  session:
    { title: string; date: string; localStartTime: string | null; sport: string } | undefined,
): string {
  return session
    ? `${session.title} · ${session.date} ${session.localStartTime ?? '시각 미정'} · ${session.sport}`
    : '없음';
}

function nutritionItemLabel(
  item: { title: string; category: string; anchor: unknown } | undefined,
): string {
  return item ? `${item.title} · ${item.category} · 위치 ${JSON.stringify(item.anchor)}` : '없음';
}

function CandidateDetails({ candidate }: { candidate: JointCandidateV3 }) {
  const { basis, diff, writes, validation } = candidate;
  const beforeLinks = new Map(
    writes.training?.beforeSupplementaryLinks.map((link) => [link.plannedSessionId, link]),
  );
  const afterLinks = new Map(
    writes.training?.supplementaryLinks.map((link) => [link.plannedSessionId, link]),
  );
  const changedLinks = [...new Set([...beforeLinks.keys(), ...afterLinks.keys()])]
    .filter(
      (id) =>
        JSON.stringify(beforeLinks.get(id) ?? null) !== JSON.stringify(afterLinks.get(id) ?? null),
    )
    .sort();
  const beforePeriods = new Map(
    writes.training?.before.draft.periods.map((period) => [period.id, period]),
  );
  const afterPeriods = new Map(
    writes.training?.proposed.periods.map((period) => [period.id, period]),
  );
  const beforeSessions = new Map(
    writes.training?.before.draft.sessions.map((session) => [session.id, session]),
  );
  const afterSessions = new Map(
    writes.training?.proposed.sessions.map((session) => [session.id, session]),
  );
  return (
    <div className={styles.grid}>
      <section className={styles.card} aria-label="후보 기준과 검증">
        <h3>후보 기준과 검증</h3>
        <p>
          범위 {writes.scope} · 기준일 {candidate.asOfLocalDate} · 후보 {candidate.id}
        </p>
        {candidate.parentCandidateId ? (
          <p>부분 선택으로 새로 만든 후보 · 원본 {candidate.parentCandidateId}</p>
        ) : null}
        <p>
          검증 {validation.status} · 근거 스냅샷 {basis.evidenceSnapshotId}
        </p>
        <dl>
          <dt>훈련 기준 버전</dt>
          <dd>{basis.domains.training?.planVersionId ?? '범위 밖'}</dd>
          <dt>영양 기준 버전</dt>
          <dd>
            {basis.domains.nutrition === null
              ? '범위 밖'
              : (basis.domains.nutrition.planVersionId ?? '기존 버전 없음')}
          </dd>
          <dt>활동·동작 개정</dt>
          <dd>
            {basis.domains.training
              ? `${basis.domains.training.activityDataRevision} / ${basis.domains.training.exerciseCatalogRevision}`
              : '범위 밖'}
          </dd>
          <dt>섭취·식품 개정</dt>
          <dd>
            {basis.domains.nutrition
              ? `${basis.domains.nutrition.intakeDataRevision} / ${basis.domains.nutrition.foodCatalogRevision}`
              : '범위 밖'}
          </dd>
          <dt>선호·제약·대화 개정</dt>
          <dd>
            {basis.preferenceRevision} / {basis.constraintRevision} / {basis.conversationRevision}
          </dd>
          <dt>정책 버전</dt>
          <dd>{basis.policyVersion}</dd>
        </dl>
        <p>
          의존 문맥 {basis.contextDependencies.length}건 · 영양 계획 head{' '}
          {candidate.nutritionPlanHeads.length}건
        </p>
        {basis.contextDependencies.length ? (
          <ul>
            {basis.contextDependencies.map((dependency) => (
              <li key={`${dependency.kind}:${dependency.id}`}>
                {dependency.kind} {dependency.id} · 개정 {dependency.revision}
              </li>
            ))}
          </ul>
        ) : null}
        {candidate.nutritionPlanHeads.length ? (
          <ul>
            {candidate.nutritionPlanHeads.map((head) => (
              <li key={head.planId}>
                영양 계획 {head.planId} · 기준 버전 {head.versionId ?? '기존 버전 없음'}
              </li>
            ))}
          </ul>
        ) : null}
        <IssueList title="오류" issues={validation.errors} />
        <IssueList title="경고" issues={validation.warnings} />
        <IssueList title="미확인" issues={validation.unknowns} />
      </section>
      <section className={styles.card} aria-label="훈련과 영양 변경">
        <h3>훈련과 영양 변경</h3>
        {writes.training && diff.training ? (
          <>
            <p>
              훈련 제목: {writes.training.before.draft.title} → {writes.training.proposed.title}
              {diff.training.titleChanged ? ' (변경)' : ' (유지)'}
            </p>
            <h4>변경 기간</h4>
            {diff.training.periodIds.length ? (
              <ul>
                {diff.training.periodIds.map((id) => (
                  <li key={id}>
                    {id}: {periodLabel(beforePeriods.get(id))} → {periodLabel(afterPeriods.get(id))}
                  </li>
                ))}
              </ul>
            ) : (
              <p>없음</p>
            )}
            <h4>변경 세션</h4>
            {diff.training.sessionIds.length ? (
              <ul>
                {diff.training.sessionIds.map((id) => (
                  <li key={id}>
                    {id}: {sessionLabel(beforeSessions.get(id))} →{' '}
                    {sessionLabel(afterSessions.get(id))}
                  </li>
                ))}
              </ul>
            ) : (
              <p>없음</p>
            )}
          </>
        ) : (
          <p>훈련 변경 없음</p>
        )}
        {diff.nutrition.length ? (
          <ul>
            {diff.nutrition.map((change) => {
              const write = writes.nutrition?.find((entry) => entry.planId === change.planId);
              return (
                <li key={change.planId}>
                  영양 계획 {change.planId} · 메타데이터 {change.metadataChanged ? '변경' : '유지'}
                  {write ? (
                    <>
                      <p>
                        기간 {write.before?.period.from ?? '없음'} ~{' '}
                        {write.before?.period.toInclusive ?? '없음'} → {write.proposed.period.from}{' '}
                        ~ {write.proposed.period.toInclusive}
                      </p>
                      <p>
                        목적 {write.before?.purpose ?? '없음'} → {write.proposed.purpose} · 연결
                        훈련 {write.before?.linkedTrainingPlanVersionId ?? '없음'} →{' '}
                        {write.proposed.linkedTrainingPlanVersionId ?? '없음'}
                      </p>
                      {change.itemIds.length ? (
                        <ul>
                          {change.itemIds.map((id) => (
                            <li key={id}>
                              항목 {id}:{' '}
                              {nutritionItemLabel(
                                write.before?.items.find((item) => item.id === id),
                              )}{' '}
                              →{' '}
                              {nutritionItemLabel(
                                write.proposed.items.find((item) => item.id === id),
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>변경 항목 없음</p>
                      )}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p>영양 변경 없음</p>
        )}
        <h4>상대 영양 영향</h4>
        {diff.relativeImpacts.length ? (
          <ul>
            {diff.relativeImpacts.map((impact) => (
              <li key={`${impact.planId}-${impact.itemId}`}>
                영양 항목 {impact.itemId} · 세션 {impact.sessionId} {impact.point} ·{' '}
                {impact.resolution === 'unresolved' ? '시각 미해결' : '재계산 필요'}
              </li>
            ))}
          </ul>
        ) : (
          <p>영향 없음</p>
        )}
        <h4>고정된 보강 내용 변경</h4>
        {changedLinks.length ? (
          <ul>
            {changedLinks.map((id) => (
              <li key={id}>
                <details>
                  <summary>
                    세션 {id}: {frozenLinkLabel(beforeLinks.get(id))} →{' '}
                    {frozenLinkLabel(afterLinks.get(id))}
                  </summary>
                  <pre className={styles.tableScroll}>
                    {JSON.stringify(
                      {
                        before: beforeLinks.get(id)?.content ?? null,
                        after: afterLinks.get(id)?.content ?? null,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p>변경 없음</p>
        )}
        <p>이 비교는 계획 제안이며 실제 섭취·수행 기록이 아닙니다.</p>
      </section>
    </div>
  );
}

function toggle(ids: string[], id: string) {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export function JointCandidateReviewWorkspace(props: JointCandidateReviewWorkspaceProps) {
  return (
    <Lifetime
      key={JSON.stringify([props.athleteId, props.sessionId, props.candidateId])}
      {...props}
    />
  );
}

function Lifetime(props: JointCandidateReviewWorkspaceProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  useEffect(
    () => () => {
      void client.cancelQueries();
      client.clear();
    },
    [client],
  );
  return (
    <QueryClientProvider client={client}>
      <Review {...props} />
    </QueryClientProvider>
  );
}

function Review({
  candidateId,
  athleteId,
  sessionId,
  transport,
  createId = () => crypto.randomUUID(),
}: JointCandidateReviewWorkspaceProps) {
  const api = useMemo(() => createJointCandidateApi(transport), [transport]);
  const [activeCandidateId, setActiveCandidateId] = useState(() => uuid.parse(candidateId));
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [reviewed, setReviewed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'sending' | 'uncertain' | 'conflict' | 'approved'>(
    'idle',
  );
  const [feedback, setFeedback] = useState('');
  const [approved, setApproved] = useState<ApprovalResult | null>(null);
  const pending = useRef<PendingCommand | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    return () => controller.abort();
  }, []);
  const detail = useQuery({
    queryKey: ['users', athleteId, 'sessions', sessionId, 'joint-candidate', activeCandidateId],
    queryFn: async ({ signal }) => {
      try {
        return await api.read(activeCandidateId, signal);
      } catch (error) {
        // Replace a revoked candidate in the query cache, not just in the rendered view.
        if (
          error instanceof JointCandidateRequestError &&
          error.status >= 400 &&
          error.status < 500
        )
          return null;
        throw error;
      }
    },
    staleTime: 0,
    gcTime: 0,
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
  });
  const candidate =
    !detail.isFetching && !detail.isError && detail.data?.id === activeCandidateId
      ? detail.data
      : null;
  const blocked = phase !== 'idle' || detail.isFetching || detail.isError || !candidate;
  const approvable = candidate?.validation.status === 'checked';
  const hasSelection =
    selection.includeTrainingTitle ||
    selection.trainingPeriodIds.length > 0 ||
    selection.trainingSessionIds.length > 0 ||
    selection.nutritionPlanIds.length > 0;

  async function send(command: PendingCommand) {
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
      if (command.kind === 'partial') {
        const child = await api.partial(command, signal);
        if (signal.aborted) return;
        pending.current = null;
        setSelection(emptySelection);
        setReviewed(false);
        setActiveCandidateId(child.id);
        setPhase('idle');
        setFeedback('선택한 내용으로 새 후보를 만들었습니다. 새 후보를 다시 검토하고 확인하세요.');
      } else {
        const result = await api.approve(command, signal);
        if (signal.aborted) return;
        pending.current = null;
        setApproved(result);
        setPhase('approved');
        setFeedback('서버에서 훈련·영양 계획의 원자적 적용을 확인했습니다.');
      }
    } catch (error) {
      if (signal.aborted) return;
      if (
        error instanceof JointCandidateRequestError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        pending.current = null;
        setReviewed(false);
        setPhase('conflict');
        setFeedback(
          `후보가 적용되지 않았습니다 (${error.code}). 최신 근거로 새 후보를 검토하세요.`,
        );
      } else {
        setPhase('uncertain');
        setFeedback('서버 응답을 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요.');
      }
    }
  }

  function startPartial() {
    if (blocked || !reviewed || !hasSelection || !candidate) return;
    const parsed = jointCandidatePartialSelectionV3Schema.safeParse(selection);
    if (!parsed.success) {
      setFeedback('새 후보에 포함할 변경을 하나 이상 선택하세요.');
      return;
    }
    const command: PartialCommand = {
      kind: 'partial',
      candidateId: candidate.id,
      selection: parsed.data,
      idempotencyKey: createId(),
    };
    pending.current = command;
    void send(command);
  }

  function startApproval() {
    if (blocked || !reviewed || !approvable || !candidate) return;
    const request = jointApprovalRequestSchema.parse({
      schemaVersion: 3,
      confirmed: true,
      proposalId: candidate.proposalId,
      candidateId: candidate.id,
      proposalDigest: candidate.digest,
      expectedBasis: candidate.basis,
      idempotencyKey: createId(),
    });
    const command: ApprovalCommand = { kind: 'approval', candidateId: candidate.id, request };
    pending.current = command;
    void send(command);
  }

  async function refresh() {
    const latest = await detail.refetch();
    if (latest.isSuccess && latest.data?.id === activeCandidateId) {
      setReviewed(false);
      setSelection(emptySelection);
      if (phase !== 'conflict')
        setFeedback('최신 후보를 다시 불러왔습니다. 변경 내용을 검토하세요.');
    } else {
      setReviewed(false);
      setSelection(emptySelection);
    }
  }

  return (
    <section className={styles.workspace} aria-label="훈련·영양 공동 후보 검토">
      <h1>훈련·영양 공동 후보 검토</h1>
      <p>제안, 계획, 실제 기록은 별개입니다. 승인 확인 후에만 계획 버전이 적용됩니다.</p>
      {detail.isPending ? <p role="status">후보 불러오는 중</p> : null}
      {detail.isError ? <p role="alert">후보를 불러오지 못했습니다. 승인할 수 없습니다.</p> : null}
      {detail.isSuccess && detail.data === null ? (
        <p role="alert">후보가 회수되었거나 접근할 수 없습니다. 새 후보를 검토하세요.</p>
      ) : null}
      {detail.isFetching && candidate ? <p role="status">최신 후보 확인 중</p> : null}
      <button
        type="button"
        disabled={phase === 'sending' || phase === 'uncertain'}
        onClick={() => void refresh()}
      >
        후보 다시 조회
      </button>
      {candidate ? (
        <>
          <CandidateDetails candidate={candidate} />
          <section className={styles.card} aria-label="일부 변경으로 새 후보 만들기">
            <h3>일부 변경으로 새 후보 만들기</h3>
            <p>
              선택 항목은 현재 후보를 일부 승인하지 않습니다. 서버가 영향과 근거를 다시 계산한 새
              후보를 만듭니다.
            </p>
            <fieldset disabled={blocked}>
              <legend>새 후보에 포함할 변경</legend>
              {candidate.diff.training?.titleChanged ? (
                <label>
                  <input
                    type="checkbox"
                    checked={selection.includeTrainingTitle}
                    onChange={(event) => {
                      setSelection((old) => ({
                        ...old,
                        includeTrainingTitle: event.target.checked,
                      }));
                      setReviewed(false);
                    }}
                  />
                  훈련 제목
                </label>
              ) : null}
              {candidate.diff.training?.periodIds.map((id) => (
                <label key={`period-${id}`}>
                  <input
                    type="checkbox"
                    checked={selection.trainingPeriodIds.includes(id)}
                    onChange={() => {
                      setSelection((old) => ({
                        ...old,
                        trainingPeriodIds: toggle(old.trainingPeriodIds, id),
                      }));
                      setReviewed(false);
                    }}
                  />
                  기간 {id}
                </label>
              ))}
              {candidate.diff.training?.sessionIds.map((id) => (
                <label key={`session-${id}`}>
                  <input
                    type="checkbox"
                    checked={selection.trainingSessionIds.includes(id)}
                    onChange={() => {
                      setSelection((old) => ({
                        ...old,
                        trainingSessionIds: toggle(old.trainingSessionIds, id),
                      }));
                      setReviewed(false);
                    }}
                  />
                  세션 {id}
                </label>
              ))}
              {candidate.diff.nutrition.map((change) => (
                <label key={change.planId}>
                  <input
                    type="checkbox"
                    checked={selection.nutritionPlanIds.includes(change.planId)}
                    onChange={() => {
                      setSelection((old) => ({
                        ...old,
                        nutritionPlanIds: toggle(old.nutritionPlanIds, change.planId),
                      }));
                      setReviewed(false);
                    }}
                  />
                  영양 계획 {change.planId}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              disabled={blocked || !reviewed || !hasSelection}
              onClick={startPartial}
            >
              선택으로 새 후보 만들기
            </button>
          </section>
          <section className={styles.card} aria-label="후보 승인 확인">
            <h3>후보 승인 확인</h3>
            <p>
              후보 {candidate.id} · digest {candidate.digest}. 오류·미확인 항목이 있으면 승인할 수
              없습니다.
            </p>
            <label>
              <input
                type="checkbox"
                checked={reviewed}
                disabled={blocked}
                onChange={(event) => setReviewed(event.target.checked)}
              />
              이 후보의 훈련·영양 변경과 근거를 확인했습니다.
            </label>
            <button
              type="button"
              disabled={blocked || !reviewed || !approvable}
              onClick={startApproval}
            >
              이 후보 전체 승인
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
      {phase === 'conflict' ? (
        <p role="alert">기준이 변경됐거나 요청이 거절됐습니다. 이 후보의 승인을 중단했습니다.</p>
      ) : null}
      {feedback ? <p role={phase === 'conflict' ? 'alert' : 'status'}>{feedback}</p> : null}
      {approved ? (
        <p role="status">
          적용 완료 · 훈련 {approved.training?.id ?? '변경 없음'} · 영양 버전{' '}
          {approved.nutrition.length}건
        </p>
      ) : null}
    </section>
  );
}
