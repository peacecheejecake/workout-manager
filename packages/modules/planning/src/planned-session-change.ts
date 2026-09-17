import type { PlanDraft } from '@workout/contracts/planning';
import { samePlanValue } from './plan-value-equality';

export type PlannedSessionChangeContext =
  { kind: 'saved' } | { kind: 'draft'; baseline: PlanDraft | null };
export type PlannedSessionChange = 'saved' | 'unchanged' | 'changed' | 'added';

/** Session values and inherited timezone only; period and plan metadata have separate comparisons. */
export function plannedSessionChanges(
  source: PlanDraft,
  context: PlannedSessionChangeContext,
): ReadonlyMap<string, PlannedSessionChange> {
  if (context.kind === 'saved')
    return new Map(source.sessions.map((session) => [session.id, 'saved']));
  const baseline = context.baseline;
  const originals = new Map(baseline?.sessions.map((session) => [session.id, session]));
  return new Map(
    source.sessions.map((session) => {
      const original = originals.get(session.id);
      const change: PlannedSessionChange = !original
        ? 'added'
        : baseline?.timezone === source.timezone && samePlanValue(original, session)
          ? 'unchanged'
          : 'changed';
      return [session.id, change];
    }),
  );
}
