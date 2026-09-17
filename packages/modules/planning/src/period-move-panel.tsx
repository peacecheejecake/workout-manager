import { useEffect, useId, useRef, useState } from 'react';
import type { PlanDraft } from '@workout/contracts/planning';
import type { SessionCompletion } from '@workout/contracts/session-completion';
import { Button } from '@workout/ui-foundation/button';
import { applyPeriodMove, type PeriodMoveReason, type PeriodMoveResult } from './period-move';
import { buildPeriodNavigation } from './period-navigation';
import { PlanConstraintsReport } from './period-constraints-summary';
import styles from './period-move-panel.module.css';

export interface PeriodMovePanelProps {
  draft: PlanDraft;
  baseline: PlanDraft | null;
  completionState:
    | { status: 'ready'; reports: readonly SessionCompletion[]; revision: string }
    | { status: 'unavailable' };
  selectedPeriodId: string | null;
  onApply(next: PlanDraft): void;
}
type Scope = 'period_only' | 'descendants_and_sessions';
type Candidate = Extract<PeriodMoveResult, { status: 'changed' }>;
interface Review {
  draft: PlanDraft;
  baseline: PlanDraft | null;
  revision: string;
  periodId: string;
  date: string;
  scope: Scope;
  candidate: Candidate;
}
type ReviewState =
  | { status: 'empty' }
  | { status: 'stale' }
  | { status: 'rejected'; reason: PeriodMoveReason }
  | { status: 'unchanged' }
  | { status: 'review'; value: Review };
const rejectionText: Record<PeriodMoveReason, string> = {
  invalid_draft: '현재 초안에 입력 오류가 있습니다. 먼저 기간과 세션 입력을 수정해 주세요.',
  invalid_baseline: '저장된 계획을 확인할 수 없습니다. 최신 계획을 다시 확인해 주세요.',
  invalid_date: '이동할 시작일을 올바른 날짜로 입력해 주세요.',
  invalid_scope: '이동 범위를 직접 선택해 주세요.',
  missing_period: '선택한 기간을 찾을 수 없습니다. 이동할 기간을 다시 선택해 주세요.',
  unsupported_calendar: '이 날짜 범위는 기간 이동에서 지원하지 않습니다.',
  outside_parent: '이동한 기간이 상위 기간 범위를 벗어납니다.',
  sibling_overlap: '이동한 기간이 같은 단계의 다른 기간과 겹칩니다.',
  child_outside_period: '고정된 자식 기간이 이동한 상위 기간 범위를 벗어납니다.',
  fixed_session_outside_block:
    '완료 확인 또는 날짜가 고정된 세션이 이동한 Block 밖으로 나갑니다. 세션을 자동 이동하거나 완료 확인·잠금을 해제하지 않습니다.',
  constraints_outside_period:
    '고정된 제약 날짜가 이동한 기간 범위를 벗어납니다. 운동 불가 날짜와 가용 시간을 먼저 확인해 주세요.',
  locked:
    '저장된 세션의 잠금 조건을 지킬 수 없어 이동하지 않습니다. 잠금을 자동 해제하지 않습니다.',
  completed:
    '완료 확인된 세션의 일정을 유지할 수 없어 이동하지 않습니다. 완료 확인을 자동 철회하지 않습니다.',
  invalid_result: '이동 결과가 계획의 기간·세션 조건에 맞지 않습니다. 날짜와 범위를 확인해 주세요.',
};

export function PeriodMovePanel({
  draft,
  baseline,
  completionState,
  selectedPeriodId,
  onApply,
}: PeriodMovePanelProps) {
  const [date, setDate] = useState('');
  const [scope, setScope] = useState<Scope | null>(null);
  const [review, setReview] = useState<ReviewState>({ status: 'empty' });
  const [inputError, setInputError] = useState<string | null>(null);
  const [appliedDraft, setAppliedDraft] = useState<{ periodId: string; draft: PlanDraft } | null>(
    null,
  );
  const radioName = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const returnFocus = useRef(false);
  const applied = useRef<Review | null>(null);
  const selected = draft.periods.find((period) => period.id === selectedPeriodId);
  if (
    appliedDraft !== null &&
    (appliedDraft.periodId !== selectedPeriodId || appliedDraft.draft !== draft)
  )
    setAppliedDraft(null);
  const fresh =
    review.status === 'review' &&
    review.value.draft === draft &&
    review.value.baseline === baseline &&
    completionState.status === 'ready' &&
    review.value.revision === completionState.revision &&
    review.value.periodId === selectedPeriodId &&
    review.value.date === date &&
    review.value.scope === scope;
  // Invalidated reviews never become valid again when an old prop value reappears.
  if (review.status === 'review' && !fresh) setReview({ status: 'stale' });
  useEffect(() => {
    if (review.status === 'review') cancel.current?.focus();
    if (returnFocus.current && review.status === 'empty') {
      returnFocus.current = false;
      trigger.current?.focus();
    }
  }, [review]);
  function invalidate() {
    if (review.status !== 'empty') setReview({ status: 'stale' });
    setInputError(null);
    setAppliedDraft(null);
  }
  function prepare() {
    if (!selected || completionState.status !== 'ready') return;
    setAppliedDraft(null);
    if (!scope || !date) {
      setInputError('이동할 시작일과 이동 범위를 직접 선택해 주세요.');
      return;
    }
    setInputError(null);
    const result = applyPeriodMove({
      draft,
      baseline,
      completionReports: completionState.reports,
      periodId: selected.id,
      newStartDate: date,
      scope,
    });
    if (result.status !== 'changed') {
      setReview(result);
      return;
    }
    setReview({
      status: 'review',
      value: {
        draft,
        baseline,
        revision: completionState.revision,
        periodId: selected.id,
        date,
        scope,
        candidate: result,
      },
    });
  }
  function apply() {
    if (review.status !== 'review' || !fresh || applied.current === review.value) return;
    applied.current = review.value;
    returnFocus.current = true;
    setReview({ status: 'empty' });
    setAppliedDraft({ periodId: review.value.periodId, draft: review.value.candidate.draft });
    onApply(review.value.candidate.draft);
  }
  return (
    <section aria-label="기간 날짜 이동" className={styles.panel}>
      <h2>기간 날짜 이동</h2>
      <p>이동 영향을 확인한 뒤 초안에 적용합니다. 계획 저장은 별도의 명시 확인이 필요합니다.</p>
      <p>
        완료 확인·날짜 잠금 세션과 제약의 달력 날짜는 고정됩니다. 실제 활동은 이동하지 않습니다.
      </p>
      {selected ? (
        <p>
          선택한 기간: {selected.title} · {selected.startDate}–{selected.endDateExclusive} (종료일
          미포함)
        </p>
      ) : (
        <p>기간 탐색에서 이동할 기간을 선택해 주세요.</p>
      )}
      {selected && completionState.status === 'unavailable' ? (
        <p role="status">최신 완료 상태를 확인할 수 없어 이동을 검토하거나 적용할 수 없습니다.</p>
      ) : null}
      <label className={styles.field}>
        이동할 기간 시작일
        <input
          type="date"
          value={date}
          disabled={!selected || completionState.status !== 'ready'}
          onChange={(event) => {
            setDate(event.target.value);
            invalidate();
          }}
        />
      </label>
      <fieldset
        className={styles.options}
        disabled={!selected || completionState.status !== 'ready'}
      >
        <legend>이동 범위</legend>
        <label>
          <input
            type="radio"
            name={radioName}
            checked={scope === 'period_only'}
            onChange={() => {
              setScope('period_only');
              invalidate();
            }}
          />
          이 기간만 이동
        </label>
        <label>
          <input
            type="radio"
            name={radioName}
            checked={scope === 'descendants_and_sessions'}
            onChange={() => {
              setScope('descendants_and_sessions');
              invalidate();
            }}
          />
          자식 기간과 세션 함께 이동
        </label>
      </fieldset>
      <Button
        ref={trigger}
        disabled={!selected || completionState.status !== 'ready'}
        onClick={prepare}
      >
        기간 이동 영향 확인
      </Button>
      {inputError ? <p role="alert">{inputError}</p> : null}
      {appliedDraft !== null && appliedDraft.draft === draft ? (
        <p role="status">
          기간 이동을 초안에 적용했습니다. 아직 저장하지 않았습니다. 실행 취소로 되돌릴 수 있습니다.
        </p>
      ) : null}
      {review.status === 'stale' ? (
        <p role="alert">
          검토 조건이 변경되었습니다. 입력은 유지했습니다. 기간 이동 영향을 다시 확인해 주세요.
        </p>
      ) : review.status === 'rejected' ? (
        <p role="alert">{rejectionText[review.reason]}</p>
      ) : review.status === 'unchanged' ? (
        <p role="status">시작일이 같아 이동할 변경이 없습니다.</p>
      ) : review.status === 'review' && fresh ? (
        <fieldset aria-label="기간 이동 영향 검토" className={styles.preview}>
          <legend>기간 이동 영향 검토</legend>
          <MoveSummary
            review={review.value}
            completionReports={completionState.status === 'ready' ? completionState.reports : []}
          />
          <PlanConstraintsReport plan={review.value.candidate.draft} />
          <div className={styles.actions}>
            <Button onClick={apply}>확인하고 기간 이동 초안 적용</Button>
            <Button
              ref={cancel}
              variant="secondary"
              onClick={() => {
                returnFocus.current = true;
                setReview({ status: 'empty' });
              }}
            >
              기간 이동 검토 취소
            </Button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );
}

function MoveSummary({
  review,
  completionReports,
}: {
  review: Review;
  completionReports: readonly SessionCompletion[];
}) {
  const { draft, candidate, baseline } = review;
  const completed = new Set(
    completionReports
      .filter((report) => report.status === 'completed')
      .map((report) => report.sessionId),
  );
  const selected = draft.periods.find((period) => period.id === review.periodId);
  const parentId = selected?.parentId ?? null;
  const beforeParent = buildPeriodNavigation(draft, parentId);
  const afterParent = buildPeriodNavigation(candidate.draft, parentId);
  return (
    <>
      <p>
        이동 {candidate.summary.deltaDays}일 · 기간 {candidate.summary.movedPeriodIds.length}개 ·
        이동 세션 {candidate.summary.movedSessionIds.length}개 · 고정 세션{' '}
        {candidate.summary.fixedSessionIds.length}개
      </p>
      <p>제약 날짜는 이동하지 않습니다. 아래 판정은 이동 후 초안 기준입니다.</p>
      {beforeParent.status === 'ready' && afterParent.status === 'ready' ? (
        <p>
          상위 범위 미배정 간격: 이전 {beforeParent.unassignedDays}일 → 이후{' '}
          {afterParent.unassignedDays}일
        </p>
      ) : null}
      <section aria-label="이동할 기간 전후">
        <h3>기간 전후</h3>
        <ul>
          {candidate.summary.movedPeriodIds.map((id) => {
            const before = draft.periods.find((period) => period.id === id);
            const after = candidate.draft.periods.find((period) => period.id === id);
            return (
              <li key={id}>
                {before?.title} · {before?.startDate}–{before?.endDateExclusive} →{' '}
                {after?.startDate}–{after?.endDateExclusive} (종료일 미포함)
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="이동할 세션 전후">
        <h3>세션 전후</h3>
        <ul>
          {candidate.summary.movedSessionIds.map((id) => {
            const before = draft.sessions.find((session) => session.id === id);
            const after = candidate.draft.sessions.find((session) => session.id === id);
            return (
              <li key={id}>
                {before?.title} · {before?.date} → {after?.date} · 시작{' '}
                {after?.localStartTime ?? '미정'}
              </li>
            );
          })}
        </ul>
      </section>
      <section aria-label="고정된 세션">
        <h3>고정된 세션</h3>
        {!candidate.summary.fixedSessionIds.length ? (
          <p>고정된 세션 없음</p>
        ) : (
          <ul>
            {candidate.summary.fixedSessionIds.map((id) => {
              const session = draft.sessions.find((item) => item.id === id);
              const locked =
                session?.locks.date ||
                baseline?.sessions.find((item) => item.id === id)?.locks.date;
              return (
                <li key={id}>
                  {session?.title} · {session?.date} ·{' '}
                  {completed.has(id) ? '완료 확인으로 고정' : ''}
                  {completed.has(id) && locked ? ' · ' : ''}
                  {locked ? '날짜 잠금으로 고정' : ''}
                  {!locked && !completed.has(id) ? '기간만 이동: 세션 유지' : ''}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
