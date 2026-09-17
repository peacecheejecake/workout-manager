import type { PlanSnapshot, PeriodDraft, PlannedSession } from '@workout/contracts/planning';
import type { CoachingReviewScope } from '@workout/contracts/coaching-threads';
export const coachingScopeLabels = { session: '세션', block: 'Block', phase: 'Phase' } as const;
export interface CoachingScopeContext {
  targetLabel: string;
  periods: ReadonlyArray<PeriodDraft>;
  sessions: ReadonlyArray<PlannedSession>;
}
/** Only stored plan constraints/locks; absence never means a complete user constraint profile. */
export function deriveScopeContext(
  plan: PlanSnapshot,
  scope: CoachingReviewScope,
): CoachingScopeContext | null {
  const periods = new Map(plan.draft.periods.map((p) => [p.id, p]));
  const session =
    scope.kind === 'session' ? plan.draft.sessions.find((s) => s.id === scope.targetId) : undefined;
  const target = periods.get(session?.blockId ?? scope.targetId);
  if (
    !target ||
    (scope.kind === 'session' ? !session || target.level !== 'block' : target.level !== scope.kind)
  )
    return null;
  const selected = new Set<string>();
  let current: PeriodDraft | undefined = target;
  while (current) {
    if (selected.has(current.id)) return null;
    selected.add(current.id);
    if (current.parentId === null) break;
    current = periods.get(current.parentId);
    if (!current) return null;
  }
  const descendants = new Set([target.id]);
  if (scope.kind !== 'session') {
    for (let i = 0; i < plan.draft.periods.length; i++) {
      let changed = false;
      for (const p of plan.draft.periods)
        if (p.parentId !== null && descendants.has(p.parentId) && !descendants.has(p.id)) {
          descendants.add(p.id);
          changed = true;
        }
      if (!changed) break;
    }
    for (const id of descendants) selected.add(id);
  }
  return {
    targetLabel: session?.title ?? target.title,
    periods: plan.draft.periods.filter((p) => selected.has(p.id)),
    sessions: session ? [session] : plan.draft.sessions.filter((s) => descendants.has(s.blockId)),
  };
}
