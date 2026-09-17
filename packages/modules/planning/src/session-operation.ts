import {
  planDraftSchema,
  plannedSessionSchema,
  preservesSessionLocks,
  type PlanDraft,
} from '@workout/contracts/planning';

export type PlannedSessionOperation =
  { kind: 'move'; date: string; blockId: string } | { kind: 'resize'; durationSeconds: number };
export type SessionOperationReason =
  | 'invalid_draft'
  | 'invalid_baseline'
  | 'invalid_today'
  | 'missing_session'
  | 'invalid_operation'
  | 'missing_block'
  | 'outside_block'
  | 'locked'
  | 'past_session'
  | 'past_date';
type SessionPosition = { date: string; blockId: string; durationSeconds: number | null };
export type SessionOperationResult =
  | {
      status: 'changed';
      draft: PlanDraft;
      summary: {
        sessionId: string;
        kind: PlannedSessionOperation['kind'];
        before: SessionPosition;
        after: SessionPosition;
      };
    }
  | { status: 'unchanged' }
  | { status: 'rejected'; reason: SessionOperationReason };

/** A single draft operation, with no approval, persistence, or actual-record side effects. */
export function applyPlannedSessionOperation({
  draft,
  baseline,
  sessionId,
  today,
  operation,
}: {
  draft: PlanDraft;
  baseline: PlanDraft | null;
  sessionId: string;
  today: string;
  operation: PlannedSessionOperation;
}): SessionOperationResult {
  const reject = (reason: SessionOperationReason): SessionOperationResult => ({
    status: 'rejected',
    reason,
  });
  if (!planDraftSchema.safeParse(draft).success) return reject('invalid_draft');
  if (baseline !== null && !planDraftSchema.safeParse(baseline).success)
    return reject('invalid_baseline');
  if (!plannedSessionSchema.shape.date.safeParse(today).success) return reject('invalid_today');
  const source = draft.sessions.find((session) => session.id === sessionId);
  if (!source) return reject('missing_session');
  if (source.date < today) return reject('past_session');
  let replacement = { ...source };
  if (operation.kind === 'move') {
    if (
      !plannedSessionSchema.shape.date.safeParse(operation.date).success ||
      !plannedSessionSchema.shape.blockId.safeParse(operation.blockId).success
    )
      return reject('invalid_operation');
    if (operation.date < today) return reject('past_date');
    const block = draft.periods.find(
      (period) => period.id === operation.blockId && period.level === 'block',
    );
    if (!block) return reject('missing_block');
    if (operation.date < block.startDate || operation.date >= block.endDateExclusive)
      return reject('outside_block');
    if (
      source.locks.date &&
      (source.date !== operation.date || source.blockId !== operation.blockId)
    )
      return reject('locked');
    replacement = { ...source, date: operation.date, blockId: operation.blockId };
  } else if (operation.kind === 'resize') {
    if (
      typeof operation.durationSeconds !== 'number' ||
      !plannedSessionSchema.shape.durationSeconds.safeParse(operation.durationSeconds).success
    )
      return reject('invalid_operation');
    if (source.locks.intensity && source.durationSeconds !== operation.durationSeconds)
      return reject('locked');
    replacement = { ...source, durationSeconds: operation.durationSeconds };
  } else return reject('invalid_operation');
  // Preserve raw editor strings; schema parsing is validation, not an unrelated normalization edit.
  const candidate = structuredClone({
    ...draft,
    sessions: draft.sessions.map((session) => (session.id === sessionId ? replacement : session)),
  });
  if (!planDraftSchema.safeParse(candidate).success) return reject('invalid_draft');
  if (baseline !== null && !preservesSessionLocks(baseline, candidate)) return reject('locked');
  const position = (session: typeof source): SessionPosition => ({
    date: session.date,
    blockId: session.blockId,
    durationSeconds: session.durationSeconds,
  });
  if (
    source.date === replacement.date &&
    source.blockId === replacement.blockId &&
    source.durationSeconds === replacement.durationSeconds
  )
    return { status: 'unchanged' };
  return {
    status: 'changed',
    draft: candidate,
    summary: {
      sessionId,
      kind: operation.kind,
      before: position(source),
      after: position(replacement),
    },
  };
}
