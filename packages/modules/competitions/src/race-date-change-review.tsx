'use client';

import type { z } from 'zod';
import type { raceManualPublicOperationalTimingSchema } from '@workout/contracts/race-manual-public-preview';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { planReadSchema, type PlanRead } from '@workout/contracts/planning';
import { raceEventSchema } from '@workout/contracts/races';
import {
  raceManualPublicPrepareSchema,
  raceManualPublicReviewResultSchema,
  type RaceManualPublicPrepare,
} from '@workout/contracts/race-manual-public';
import {
  raceManualPublicPreviewSchema,
  raceManualPublicPreviewReferenceSchema,
  type RaceManualPublicPreview,
  type RaceManualPublicPreviewReference,
} from '@workout/contracts/race-manual-public-preview';
import {
  raceManualApprovalResultSchema,
  type RaceManualApprovalResult,
} from '@workout/contracts/race-manual-approval';
import {
  RaceManualPublicRequestError,
  type createRaceManualPublicApi,
} from './race-manual-public-api';
import styles from './race-date-change-review.module.css';
import {
  raceManualPublicImpactSchema,
  type RaceManualPublicImpact,
} from '@workout/contracts/race-manual-public-impact';
import { RaceImpactResolutionEditor } from './race-impact-resolution-editor';

type PublicApi = ReturnType<typeof createRaceManualPublicApi>;
export interface RaceDateChangeReviewProps {
  /** Authenticated private lifetime identifier, never sent as authority. */
  scopeKey: string;
  support: 'supported' | 'unsupported' | 'unknown';
  /** Independent protocol capability, not admission or approval permission. */
  impactSupport?: 'supported' | 'unsupported' | 'unknown';
  event: unknown;
  api: PublicApi;
  loadCurrentPlan: ((signal: AbortSignal) => Promise<unknown>) | null;
  commandKey?: () => string;
  onStateChange?: (state: { dirty: boolean; pending: boolean }) => void;
  onCommitted?: (result: Extract<RaceManualApprovalResult, { status: 'committed' }>) => void;
}
/** Independent review flow; existing race metadata editors and Host composition
 * remain separate. Support is not processing or approval permission. */
export function RaceDateChangeReview(props: RaceDateChangeReviewProps) {
  const event = raceEventSchema.safeParse(props.event);
  if (!props.scopeKey || !event.success)
    return <p role="alert">대회 검토 기준을 읽을 수 없습니다.</p>;
  if (props.support !== 'supported')
    return <p role="status">대회 날짜 변경 검토 지원을 확인할 수 없습니다.</p>;
  if (!props.loadCurrentPlan)
    return <p role="status">현재 계획 조회가 제공되지 않아 날짜 변경 검토를 시작할 수 없습니다.</p>;
  return <PrivateLifetime key={JSON.stringify([props.scopeKey, event.data.id])} {...props} />;
}
function PrivateLifetime(props: RaceDateChangeReviewProps) {
  const [identity, setIdentity] = useState({
    api: props.api,
    plan: props.loadCurrentPlan,
    revision: 0,
  });
  if (identity.api !== props.api || identity.plan !== props.loadCurrentPlan) {
    setIdentity({ api: props.api, plan: props.loadCurrentPlan, revision: identity.revision + 1 });
    return null;
  }
  return <CacheLifetime key={identity.revision} {...props} />;
}
function CacheLifetime(props: RaceDateChangeReviewProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
            gcTime: Infinity,
            refetchOnMount: false,
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
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
function message(error: unknown): string {
  if (error instanceof RaceManualPublicRequestError) {
    if (error.code === 'STALE_BASIS' || error.code === 'STALE_RESTORE_GENERATION')
      return '검토 기준이 달라졌습니다. 입력은 유지됩니다. 새 검토가 필요합니다.';
    if (error.code === 'APP_CONSENT_REQUIRED')
      return '앱 저장·처리 동의가 필요합니다. 입력은 유지됩니다.';
    if (error.status === 413 || error.code === 'PUBLIC_PREVIEW_LIMIT')
      return '전체 미리보기의 크기 한도를 초과했습니다. 일부만 표시하거나 승인하지 않습니다.';
    if (error.status === 404) return '검토 자료를 찾을 수 없거나 접근할 수 없습니다.';
  }
  return '응답을 확인하지 못했습니다. 입력과 요청 키를 유지합니다. 같은 요청으로 다시 확인하세요.';
}
function Review(props: RaceDateChangeReviewProps) {
  const [event] = useState(() => raceEventSchema.parse(props.event));
  const [date, setDate] = useState('');
  const [selection, setSelection] = useState<'' | 'keep_plan' | 'move_period'>('');
  const [periodId, setPeriodId] = useState('');
  const [newStart, setNewStart] = useState('');
  const [scope, setScope] = useState<'' | 'period_only' | 'descendants_and_sessions'>('');
  const [reference, setReference] = useState<RaceManualPublicPreviewReference | null>(null);
  const [phase, setPhase] = useState<
    | 'draft'
    | 'reviewing'
    | 'review_uncertain'
    | 'reviewed'
    | 'blocked'
    | 'approving'
    | 'approve_uncertain'
    | 'committed'
  >('draft');
  const [notice, setNotice] = useState('');
  const [diagnostic, setDiagnostic] = useState<{
    body: RaceManualPublicPrepare;
    value: RaceManualPublicImpact;
  } | null>(null);
  const [impactPending, setImpactPending] = useState(false);
  const [resolutionDirty, setResolutionDirty] = useState(false);
  const [replacement, setReplacement] = useState<RaceManualPublicPrepare | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const reviewAttempt = useRef<{ body: RaceManualPublicPrepare; key: string } | null>(null);
  const approvalKey = useRef<string | null>(null);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const confirmControl = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
      reviewAttempt.current = null;
      approvalKey.current = null;
    };
  }, []);
  const plan = useQuery({
    queryKey: ['race-date-review', props.scopeKey, 'current-plan'],
    queryFn: async ({ signal }): Promise<PlanRead> => {
      if (!props.loadCurrentPlan) throw Error('Plan unavailable');
      return planReadSchema.parse(await props.loadCurrentPlan(signal));
    },
  });
  const preview = useQuery({
    queryKey: ['race-date-review', props.scopeKey, 'preview', reference?.candidateId ?? null],
    enabled: reference !== null,
    queryFn: async ({ signal }) => {
      if (!reference) throw Error('Reference required');
      const result = raceManualPublicPreviewSchema.parse(
        await props.api.readPreview(reference.candidateId, signal),
      );
      const received = result.reference;
      if (JSON.stringify(received) !== JSON.stringify(reference)) throw Error('Reference changed');
      return result;
    },
  });
  const onStateChange = props.onStateChange;
  const dirty =
    phase !== 'committed' &&
    (date !== '' ||
      selection !== '' ||
      periodId !== '' ||
      newStart !== '' ||
      scope !== '' ||
      reference !== null);
  const pending =
    impactPending ||
    phase === 'reviewing' ||
    phase === 'approving' ||
    phase === 'approve_uncertain';
  useEffect(() => {
    onStateChange?.({ dirty, pending });
  }, [onStateChange, dirty, pending]);
  useEffect(() => () => onStateChange?.({ dirty: false, pending: false }), [onStateChange]);
  const locked = phase !== 'draft' || impactPending;
  const head = plan.data?.head ?? null;
  const previewPresent = preview.data?.status === 'present';
  useEffect(() => {
    if (phase === 'reviewed' && previewPresent) confirmControl.current?.focus();
  }, [phase, previewPresent]);
  const canApprove = phase === 'reviewed' && previewPresent && !preview.isError && confirmed;
  function reset() {
    if (phase === 'approving' || phase === 'approve_uncertain') return;
    controller.current?.abort();
    reviewAttempt.current = null;
    approvalKey.current = null;
    setReference(null);
    setConfirmed(false);
    setPhase('draft');
    setNotice('');
  }
  function buildPrepare(): RaceManualPublicPrepare | null {
    if (!selection || !date || date === event.localDate) {
      setNotice('새 날짜와 비교 방식을 직접 선택하세요.');
      return null;
    }
    const body = raceManualPublicPrepareSchema.safeParse({
      schemaVersion: 1,
      intent: {
        expectedEvent: { id: event.id, revision: event.revision },
        newLocalDate: date,
        selection:
          selection === 'keep_plan'
            ? { kind: 'keep_plan' }
            : {
                kind: 'move_period',
                expectedCurrentPlanVersionId: head?.id,
                periodId,
                newStartDate: newStart,
                scope,
              },
      },
    });
    if (!body.success) {
      setNotice('날짜와 기간 이동 입력을 확인하세요.');
      return null;
    }
    return body.data;
  }
  function invalidateDiagnostic() {
    setDiagnostic(null);
    setReplacement(null);
    setResolutionDirty(false);
    reset();
  }
  async function diagnose(bodyOverride?: RaceManualPublicPrepare) {
    if (
      composing.current ||
      pending ||
      plan.isPending ||
      plan.isError ||
      props.impactSupport !== 'supported'
    )
      return;
    const body = bodyOverride ?? replacement ?? buildPrepare();
    if (!body) return;
    reset();
    setDiagnostic(null);
    setImpactPending(true);
    const request = new AbortController();
    controller.current = request;
    try {
      const value = raceManualPublicImpactSchema.parse(
        await props.api.impact(event.id, body, request.signal),
      );
      if (!alive.current) return;
      if (
        value.status === 'projected' &&
        (value.expectedEvent.id !== event.id ||
          value.expectedEvent.revision !== event.revision ||
          JSON.stringify(value.intent) !== JSON.stringify(body.intent))
      )
        throw Error('Impact identity mismatch');
      setDiagnostic({ body, value });
      setReplacement(body);
      setResolutionDirty(false);
    } catch (error) {
      if (alive.current) setNotice(message(error));
    } finally {
      if (alive.current) setImpactPending(false);
    }
  }
  async function review(eventSubmit?: FormEvent) {
    eventSubmit?.preventDefault();
    if (
      composing.current ||
      plan.isPending ||
      plan.isError ||
      !plan.data ||
      phase === 'reviewing' ||
      impactPending ||
      resolutionDirty
    )
      return;
    let attempt = reviewAttempt.current;
    if (!attempt) {
      if (!selection || !date || date === event.localDate) {
        setNotice('새 날짜와 비교 방식을 직접 선택하세요.');
        return;
      }
      if (
        selection === 'move_period' &&
        (!head || !scope || !head.draft.periods.some((period) => period.id === periodId))
      ) {
        setNotice('현재 계획의 실제 기간과 이동 범위를 선택하세요.');
        return;
      }
      const body = replacement ?? buildPrepare();
      if (!body) return;
      attempt = { body, key: (props.commandKey ?? (() => crypto.randomUUID()))() };
      reviewAttempt.current = attempt;
    }
    const request = new AbortController();
    controller.current = request;
    setPhase('reviewing');
    setNotice('');
    try {
      const result = raceManualPublicReviewResultSchema.parse(
        await props.api.review(event.id, attempt.body, attempt.key, request.signal),
      );
      if (!alive.current) return;
      if (result.status === 'blocked') {
        setPhase('blocked');
        setNotice(
          `검토를 준비할 수 없습니다 (${result.stage}). 영향받는 미해결 계획을 해결한 뒤 새 검토가 필요합니다.`,
        );
        return;
      }
      setReference(raceManualPublicPreviewReferenceSchema.parse(result.reference));
      setPhase('reviewed');
    } catch (error) {
      if (alive.current) {
        setPhase('review_uncertain');
        setNotice(message(error));
      }
    }
  }
  async function approve() {
    if (
      (!canApprove && phase !== 'approve_uncertain') ||
      !reference ||
      !previewPresent ||
      composing.current
    )
      return;
    approvalKey.current ??= (props.commandKey ?? (() => crypto.randomUUID()))();
    const request = new AbortController();
    controller.current = request;
    setPhase('approving');
    setNotice('');
    try {
      const result = raceManualApprovalResultSchema.parse(
        await props.api.approve(
          reference,
          { schemaVersion: 1, confirmed: true, applicationDigest: reference.applicationDigest },
          approvalKey.current,
          request.signal,
        ),
      );
      if (!alive.current) return;
      if (result.status === 'blocked') {
        setPhase('blocked');
        setNotice(
          `승인이 차단되었습니다: ${result.blockers.map((item) => item.reason).join(', ')}. 입력은 유지됩니다.`,
        );
        return;
      }
      if (
        result.candidateId !== reference.candidateId ||
        result.proposalId !== reference.chain.proposalId
      )
        throw Error('Approval identity mismatch');
      setPhase('committed');
      setNotice('날짜와 영향받는 계획의 승인이 서버에 반영되었습니다.');
      try {
        props.onCommitted?.(result);
      } catch {
        setNotice('서버 승인은 반영되었습니다. 화면 새로고침을 확인하세요.');
      }
    } catch (error) {
      if (alive.current) {
        setPhase('approve_uncertain');
        setNotice(message(error));
      }
    }
  }
  return (
    <section className={styles.review} aria-label="대회 날짜 변경 검토">
      <h2>대회 날짜 변경 검토</h2>
      <p>
        기준 {event.title} · {event.localDate} · revision {event.revision}. 검토는 실제 수행 기록이
        아니며 별도 승인 전 계획을 적용하지 않습니다.
      </p>
      <p>
        대회 삭제로 연결 해제된 영양 시각은 명시 재연결·재승인 전까지 사용이 중단됩니다.
        음식·수량·실제 섭취는 보존됩니다.
      </p>
      {plan.isPending ? <p role="status">현재 계획을 확인하는 중입니다.</p> : null}
      {plan.isError ? (
        <div role="alert">
          <p>현재 계획을 확인할 수 없어 검토를 시작하지 않습니다.</p>
          <button
            type="button"
            onClick={() => {
              void plan.refetch();
            }}
          >
            현재 계획 다시 확인
          </button>
        </div>
      ) : null}
      {plan.data?.head === null ? (
        <p>현재 훈련 계획 없음. 계획 유지 방식만 선택할 수 있습니다.</p>
      ) : null}
      <form
        onSubmit={(eventSubmit) => {
          void review(eventSubmit);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      >
        <fieldset disabled={locked || plan.isPending || plan.isError}>
          <legend>변경 의도</legend>
          <label>
            새 대회 날짜
            <input
              type="date"
              value={date}
              onChange={(e) => {
                invalidateDiagnostic();
                setDate(e.target.value);
              }}
            />
          </label>
          <label>
            계획 비교 방식
            <select
              value={selection}
              onChange={(e) => {
                if (
                  e.target.value === '' ||
                  e.target.value === 'keep_plan' ||
                  e.target.value === 'move_period'
                ) {
                  invalidateDiagnostic();
                  setSelection(e.target.value);
                }
              }}
            >
              <option value="">직접 선택</option>
              <option value="keep_plan">계획 유지</option>
              <option value="move_period" disabled={!head}>
                기간 이동
              </option>
            </select>
          </label>
          {selection === 'move_period' && head ? (
            <>
              <label>
                현재 계획의 기간
                <select
                  value={periodId}
                  onChange={(e) => {
                    invalidateDiagnostic();
                    setPeriodId(e.target.value);
                  }}
                >
                  <option value="">기간 선택</option>
                  {head.draft.periods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title} · {p.startDate}–{p.endDateExclusive}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                기간의 새 시작 날짜
                <input
                  type="date"
                  value={newStart}
                  onChange={(e) => {
                    invalidateDiagnostic();
                    setNewStart(e.target.value);
                  }}
                />
              </label>
              <label>
                이동 범위
                <select
                  value={scope}
                  onChange={(e) => {
                    if (
                      e.target.value === '' ||
                      e.target.value === 'period_only' ||
                      e.target.value === 'descendants_and_sessions'
                    ) {
                      invalidateDiagnostic();
                      setScope(e.target.value);
                    }
                  }}
                >
                  <option value="">범위 선택</option>
                  <option value="period_only">해당 기간만</option>
                  <option value="descendants_and_sessions">하위 기간과 세션 포함</option>
                </select>
              </label>
            </>
          ) : null}
        </fieldset>
        {phase === 'draft' ? (
          <button
            type="submit"
            disabled={
              plan.isPending ||
              plan.isError ||
              !selection ||
              !date ||
              impactPending ||
              resolutionDirty ||
              (diagnostic?.value.status === 'projected' &&
                diagnostic.value.resolutionRequirements.length > 0)
            }
          >
            전체 영향 검토
          </button>
        ) : null}
      </form>
      {props.impactSupport === 'supported' && phase === 'draft' ? (
        <button
          type="button"
          disabled={pending || plan.isPending || plan.isError || !selection || !date}
          onClick={() => {
            void diagnose();
          }}
        >
          미저장 영향 보기
        </button>
      ) : null}
      {props.impactSupport !== 'supported' ? (
        <p>미저장 영향 진단 지원을 확인할 수 없습니다.</p>
      ) : null}
      {impactPending ? <p role="status">미저장 영향을 확인하는 중입니다.</p> : null}
      {resolutionDirty ? (
        <p role="status">
          해결 입력이 변경되었습니다. 다시 진단하기 전 저장 검토를 진행하지 않습니다.
        </p>
      ) : null}
      {diagnostic ? <ImpactView value={diagnostic.value} /> : null}
      {diagnostic?.value.status === 'projected' && phase === 'draft' ? (
        <RaceImpactResolutionEditor
          key={JSON.stringify(diagnostic.body)}
          impact={diagnostic.value}
          prepare={diagnostic.body}
          disabled={pending}
          onDirty={() => {
            setResolutionDirty(true);
            reviewAttempt.current = null;
            approvalKey.current = null;
            setReference(null);
            setConfirmed(false);
          }}
          onPrepared={(body) => {
            setReplacement(body);
            void diagnose(body);
          }}
        />
      ) : null}
      {phase === 'reviewing' ? <p role="status">검토 요청을 확인하는 중입니다.</p> : null}
      {phase === 'review_uncertain' ? (
        <button
          type="button"
          onClick={() => {
            void review();
          }}
        >
          같은 검토 요청 다시 확인
        </button>
      ) : null}
      {reference && preview.isPending ? (
        <p role="status">저장된 전체 미리보기를 읽는 중입니다.</p>
      ) : null}
      {reference && preview.isError ? (
        <div role="alert">
          <p>{message(preview.error)}</p>
          <button
            type="button"
            onClick={() => {
              void preview.refetch();
            }}
          >
            같은 검토 미리보기 다시 읽기
          </button>
        </div>
      ) : null}
      {preview.data ? <Preview value={preview.data} /> : null}
      {phase === 'reviewed' && previewPresent ? (
        <div className={styles.confirmation}>
          <label>
            <input
              ref={confirmControl}
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            전체 변경과 보존 항목을 확인했으며 이 계획 변경을 명시적으로 승인합니다
          </label>
          <button
            type="button"
            disabled={!canApprove}
            onClick={() => {
              void approve();
            }}
          >
            계획 변경 승인
          </button>
        </div>
      ) : null}
      {phase === 'approving' ? <p role="status">서버 승인 결과를 확인하는 중입니다.</p> : null}
      {phase === 'approve_uncertain' ? (
        <button
          type="button"
          onClick={() => {
            void approve();
          }}
        >
          같은 승인 요청 다시 확인
        </button>
      ) : null}
      {phase !== 'draft' &&
      phase !== 'committed' &&
      phase !== 'reviewing' &&
      phase !== 'approving' &&
      phase !== 'approve_uncertain' ? (
        <button type="button" onClick={reset}>
          입력을 유지하고 새 검토
        </button>
      ) : null}
      <p role="status">{notice}</p>
    </section>
  );
}

const labels: Readonly<Record<string, string>> = {
  title: '제목',
  timezone: '시간대',
  periods: '기간',
  sessions: '세션',
  startDate: '시작 날짜',
  endDateExclusive: '종료 날짜(미포함)',
  intent: '목적',
  purpose: '목적',
  date: '날짜',
  localStartTime: '시작 시각',
  durationSeconds: '시간(초)',
  distanceMeters: '거리(m)',
  targetRpe: '목표 RPE',
  foods: '음식과 수량',
  quantity: '수량',
  unit: '단위',
  description: '설명',
  targets: '목표',
  instructions: '지시',
  notes: '메모',
  period: '기간',
  from: '시작',
  toInclusive: '종료(포함)',
  category: '분류',
  anchor: '시간 연결',
  goal: '목표',
  options: '선택지',
  explanation: '설명',
  reassessment: '재평가 조건',
  plannedAt: '예정 시각',
  priority: '우선순위',
  steps: '단계',
  content: '고정 내용',
  rule: '반복 규칙',
  window: '확장 범위',
  localTime: '현지 시각',
  selectedOptionId: '선택한 항목',
  planLinks: '고정 계획 연결',
  ref: '고정 버전',
  before: '고정된 변경 전',
  after: '가정한 변경 후 · 아직 적용하지 않음',
  storedOccurrences: '고정된 저장 일정 시각',
  storedCurrentOccurrences: '저장된 현재 일정',
  retainedStarted: '시작된 실행 보존',
  requirement: '검토 전 해결 필요',
  state: '상태',
  status: '상태',
};
/** Only strict public planned bodies selected by the five typed handlers enter
 * this lossless field view. No private context/evidence/provider body is rendered. */
function PlannedFields({ value }: { value: unknown }): ReactNode {
  if (value === null) return <span>미상(null)</span>;
  if (value === undefined) return <span>미제공</span>;
  if (typeof value === 'boolean') return <span>{value ? '예' : '아니오'}</span>;
  if (typeof value === 'string' || typeof value === 'number')
    return <span>{String(value) || '빈 값'}</span>;
  if (Array.isArray(value))
    return value.length === 0 ? (
      <span>없음</span>
    ) : (
      <ol>
        {value.map((item: unknown, index) => (
          <li key={index}>
            <PlannedFields value={item} />
          </li>
        ))}
      </ol>
    );
  if (typeof value !== 'object') return <span>사용 불가</span>;
  return (
    <dl className={styles.fields}>
      {Object.entries(value).map(([key, entry]) => (
        <div key={key}>
          <dt>{labels[key] ?? key}</dt>
          <dd>
            <PlannedFields value={entry} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
function BeforeAfter({ before, after }: { before: unknown; after: unknown }) {
  return (
    <div className={styles.comparison}>
      <div>
        <h4>고정된 변경 전</h4>
        <PlannedFields value={before} />
      </div>
      <div>
        <h4>승인 시 가정한 변경 후</h4>
        <PlannedFields value={after} />
      </div>
    </div>
  );
}
function Timing({ value }: { value: z.infer<typeof raceManualPublicOperationalTimingSchema> }) {
  return (
    <span>
      {value.state === 'suspended'
        ? '연결 해제 · 명시 재연결·재승인 전 시각 사용 중단'
        : value.state === 'unresolved'
          ? `미해결 (${value.reason})`
          : `${value.date} · ${value.localTime ?? '시각 미상'} · ${value.timezone}`}
    </span>
  );
}
function Preview({ value }: { value: RaceManualPublicPreview }) {
  const region = useRef<HTMLDivElement | null>(null);
  if (value.status === 'unavailable')
    return (
      <section aria-label="검토 자료 사용 불가">
        <p>
          검토 본문이 삭제되어 사용할 수 없습니다. 최소 검토 참조만 보존됩니다. 승인할 수 없습니다.
        </p>
      </section>
    );
  return (
    <section aria-label="전체 계획 영향 미리보기">
      <nav aria-label="긴 미리보기 이동">
        <button
          type="button"
          onClick={() =>
            region.current?.scrollBy({ top: -region.current.clientHeight, behavior: 'auto' })
          }
        >
          미리보기 위로
        </button>
        <button
          type="button"
          onClick={() =>
            region.current?.scrollBy({ top: region.current.clientHeight, behavior: 'auto' })
          }
        >
          미리보기 아래로
        </button>
      </nav>
      <div role="region" aria-label="미리보기 본문" ref={region} className={styles.preview}>
        <h3>전체 계획 영향 · 고정된 검토와 승인 가정</h3>
        <p>
          저장된 검토는 현재 승인 권한을 뜻하지 않습니다. 최신 의존성과 동의는 승인 시 서버가 다시
          확인합니다. 변경 후는 아직 적용하거나 수행하지 않았습니다.
        </p>
        <section>
          <h3>대회</h3>
          <BeforeAfter before={value.race.before} after={value.race.after} />
        </section>
        <section>
          <h3>훈련</h3>
          {value.training.state === 'absent' ? (
            <p>훈련 계획 없음</p>
          ) : (
            value.training.members.map((m) => (
              <article key={m.aggregateId}>
                <p>{m.after.kind === 'retained' ? '변경 없음' : '승인 시 새 버전'}</p>
                <BeforeAfter before={m.before.plan} after={m.after.plan} />
              </article>
            ))
          )}
        </section>
        <section>
          <h3>영양</h3>
          {value.nutrition.state === 'absent' ? (
            <p>영양 계획 없음</p>
          ) : (
            value.nutrition.members.map((m) => (
              <article key={m.aggregateId}>
                <p>{m.after.kind === 'retained' ? '변경 없음' : '승인 시 새 버전'}</p>
                <BeforeAfter
                  before={{ ...m.before.plan, linkedTraining: m.before.linkedTraining }}
                  after={{ ...m.after.plan, linkedTraining: m.after.linkedTraining }}
                />
                {m.timings.map((t) => (
                  <p key={t.itemId}>
                    {m.before.plan.items.find((i) => i.id === t.itemId)?.title} ·{' '}
                    {t.state === 'unchanged' ? '영향 밖 보존' : '변경 영향'}:{' '}
                    <Timing value={t.before} /> → <Timing value={t.after} />
                  </p>
                ))}
              </article>
            ))
          )}
        </section>
        <section>
          <h3>회복</h3>
          {value.recovery.state === 'absent' ? (
            <p>회복 계획 없음</p>
          ) : (
            value.recovery.members.map((m) => (
              <article key={m.aggregateId}>
                <p>{m.after.kind === 'retained' ? '변경 없음' : '승인 시 새 버전'}</p>
                <BeforeAfter
                  before={{
                    ...m.before.plan,
                    selectedOptionId: m.before.selectedOptionId,
                    status: m.before.status,
                    planLinks: m.before.planLinks,
                  }}
                  after={{
                    ...m.after.plan,
                    selectedOptionId: m.after.selectedOptionId,
                    status: m.after.status,
                    planLinks: m.after.planLinks,
                  }}
                />
              </article>
            ))
          )}
        </section>
        <section>
          <h3>루틴</h3>
          {value.routines.state === 'absent' ? (
            <p>루틴 일정 없음</p>
          ) : (
            value.routines.members.map((m) => (
              <article key={m.aggregateId}>
                <h4>{m.blueprint.title} · 고정 블루프린트</h4>
                <PlannedFields value={m.blueprint} />
                <BeforeAfter before={m.before.schedule} after={m.after.schedule} />
                <BeforeAfter before={m.before.expansion} after={m.after.expansion} />
                <h4>저장된 현재 일정</h4>
                {m.storedCurrentOccurrences.length ? (
                  <ul>
                    {m.storedCurrentOccurrences.map((o) => (
                      <li key={o.occurrenceId}>
                        {o.anchorKey}:{' '}
                        {o.timingStatus === 'unresolved'
                          ? m.after.kind === 'retained'
                            ? '미해결 · 영향 밖이라 시각을 정하지 않고 그대로 보존'
                            : '미해결 · 승인 시 새 일정으로 대체'
                          : o.scheduledAt}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>없음</p>
                )}
                <h4>시작된 실행 보존</h4>
                {m.retainedStarted.length ? (
                  <ul>
                    {m.retainedStarted.map((run) => (
                      <li key={run.runId}>
                        {run.runId}: 시작된 실행의 일정·내용·실제 기록은 변경하지 않습니다.
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>없음</p>
                )}
              </article>
            ))
          )}
        </section>
        <section>
          <h3>계획 밖 실행 보존</h3>
          {value.retainedUnplanned.length ? (
            <ul>
              {value.retainedUnplanned.map((run) => (
                <li key={run.runId}>{run.runId}: 계획 밖 실행은 그대로 보존됩니다.</li>
              ))}
            </ul>
          ) : (
            <p>없음</p>
          )}
        </section>
        {value.notices.length ? (
          <section>
            <h3>보존 안내</h3>
            <ul>
              {value.notices.map((n, index) => (
                <li key={index}>
                  {n.code === 'DISCONNECTED_RETAINED'
                    ? '연결 해제 영양 시각 중단 · 재연결·재승인 필요'
                    : n.code === 'UNCHANGED_UNRESOLVED'
                      ? n.domain === 'routine_schedule'
                        ? '영향 밖 루틴의 미해결 저장 일정은 그대로 보존 · 승인해도 시각을 정하지 않음'
                        : '영향 밖 미해결 항목은 그대로 보존'
                      : n.code === 'STARTED_RUN_PRESERVED'
                        ? '시작된 실행 보존'
                        : '종료된 일정 보존'}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function ImpactView({ value }: { value: RaceManualPublicImpact }) {
  if (value.status === 'blocked')
    return (
      <section aria-label="미저장 영향 진단">
        <p role="status">영향 진단 차단: {value.reason}. 저장·승인은 수행하지 않았습니다.</p>
      </section>
    );
  return (
    <section aria-label="미저장 전체 영향 진단" className={styles.preview}>
      <h3>미저장 영향 · 고정된 변경 전과 가정한 변경 후</h3>
      <p>현재 승인 권한·최신성은 확인하지 않았습니다. 계획이나 실제 기록을 저장하지 않았습니다.</p>
      <h4>대회</h4>
      <BeforeAfter before={value.race.before} after={value.race.after} />
      <h4>훈련</h4>
      <PlannedFields value={value.training} />
      <h4>영양</h4>
      <PlannedFields value={value.nutrition} />
      <h4>회복</h4>
      <PlannedFields value={value.recovery} />
      <h4>루틴</h4>
      <PlannedFields value={value.routines} />
      <h4>계획 밖 실행 보존</h4>
      <PlannedFields value={value.retainedUnplanned} />
      <h4>보존 안내</h4>
      <PlannedFields value={value.notices} />
    </section>
  );
}
