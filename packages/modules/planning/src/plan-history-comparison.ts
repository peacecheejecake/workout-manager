import type {
  PeriodDraft,
  PlanDraft,
  PlannedSession,
  PlanSnapshot,
} from '@workout/contracts/planning';

export type ComparisonPresence = 'beforeOnly' | 'afterOnly' | 'shared';
export type ComparisonChange = 'added' | 'removed' | 'changed' | 'unchanged';
export type ScopeMovement = 'intoScope' | 'outOfScope' | null;
export interface HistoryComparisonRow<T> {
  id: string;
  before: T | null;
  after: T | null;
  beforeInScope: boolean;
  afterInScope: boolean;
  status: ComparisonChange;
  movement: ScopeMovement;
}
export interface PlanHistoryComparison {
  periodOptions: {
    id: string;
    title: string;
    beforeTitle: string | null;
    afterTitle: string | null;
    presence: ComparisonPresence;
  }[];
  scope: {
    before: PeriodDraft | null;
    after: PeriodDraft | null;
    status: ComparisonPresence | 'wholePlan' | 'missing';
  };
  periods: HistoryComparisonRow<PeriodDraft>[];
  sessions: HistoryComparisonRow<PlannedSession>[];
  planMetadata: {
    before: Pick<PlanDraft, 'title' | 'timezone'>;
    after: Pick<PlanDraft, 'title' | 'timezone'>;
    changed: boolean;
  };
}
function presence(before: boolean, after: boolean): ComparisonPresence {
  return before && after ? 'shared' : before ? 'beforeOnly' : 'afterOnly';
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Object key order is immaterial; array order and absent fields remain meaningful. */
function sameValue(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (Array.isArray(before) && Array.isArray(after))
    return (
      before.length === after.length &&
      before.every((value, index) => sameValue(value, after[index]))
    );
  if (!isRecord(before) || !isRecord(after)) return false;
  const keys = Object.keys(before);
  return (
    keys.length === Object.keys(after).length &&
    keys.every((key) => Object.hasOwn(after, key) && sameValue(before[key], after[key]))
  );
}
/** Each immutable version resolves its own hierarchy, never the current head's hierarchy. */
function periodScope(periods: PeriodDraft[], selected: string | null): Set<string> {
  if (selected === null) return new Set(periods.map((period) => period.id));
  if (!periods.some((period) => period.id === selected)) return new Set();
  const children = new Map<string, string[]>();
  for (const period of periods) {
    if (period.parentId === null) continue;
    const siblings = children.get(period.parentId) ?? [];
    siblings.push(period.id);
    children.set(period.parentId, siblings);
  }
  const result = new Set<string>();
  const pending = [selected];
  while (pending.length) {
    const id = pending.pop();
    if (id === undefined || result.has(id)) continue;
    result.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}
function scopedSessionIds(draft: PlanDraft, periods: Set<string>): Set<string> {
  const blocks = new Set(
    draft.periods
      .filter((period) => period.level === 'block' && periods.has(period.id))
      .map((period) => period.id),
  );
  return new Set(
    draft.sessions.filter((session) => blocks.has(session.blockId)).map((session) => session.id),
  );
}
function compareRows<T extends { id: string }>(
  before: T[],
  after: T[],
  beforeScope: Set<string>,
  afterScope: Set<string>,
): HistoryComparisonRow<T>[] {
  const previous = new Map(before.map((value) => [value.id, value]));
  const next = new Map(after.map((value) => [value.id, value]));
  // Preserve the earlier version's display order, then append newly visible identities.
  const ids = new Set([
    ...before.filter((value) => beforeScope.has(value.id)).map((value) => value.id),
    ...after.filter((value) => afterScope.has(value.id)).map((value) => value.id),
  ]);
  return [...ids].map((id) => {
    const left = previous.get(id) ?? null;
    const right = next.get(id) ?? null;
    const beforeInScope = beforeScope.has(id),
      afterInScope = afterScope.has(id);
    const movement =
      left !== null && right !== null && beforeInScope !== afterInScope
        ? beforeInScope
          ? 'outOfScope'
          : 'intoScope'
        : null;
    return {
      id,
      before: left,
      after: right,
      beforeInScope,
      afterInScope,
      movement,
      status:
        left === null
          ? 'added'
          : right === null
            ? 'removed'
            : sameValue(left, right)
              ? 'unchanged'
              : 'changed',
    };
  });
}
/** Read-only projection of already validated snapshots. No date/title matching or estimates. */
export function comparePlanHistory(
  before: PlanSnapshot,
  after: PlanSnapshot,
  periodId: string | null = null,
): PlanHistoryComparison {
  const previousPeriods = new Map(before.draft.periods.map((period) => [period.id, period]));
  const nextPeriods = new Map(after.draft.periods.map((period) => [period.id, period]));
  const periodOptions: PlanHistoryComparison['periodOptions'] = [];
  for (const id of new Set([...previousPeriods.keys(), ...nextPeriods.keys()])) {
    const left = previousPeriods.get(id),
      right = nextPeriods.get(id);
    const period = right ?? left;
    if (!period) continue;
    periodOptions.push({
      id,
      title: period.title,
      beforeTitle: left?.title ?? null,
      afterTitle: right?.title ?? null,
      presence: presence(left !== undefined, right !== undefined),
    });
  }
  const left = periodId === null ? null : (previousPeriods.get(periodId) ?? null);
  const right = periodId === null ? null : (nextPeriods.get(periodId) ?? null);
  const beforeScope = periodScope(before.draft.periods, periodId);
  const afterScope = periodScope(after.draft.periods, periodId);
  const beforeMetadata = { title: before.draft.title, timezone: before.draft.timezone };
  const afterMetadata = { title: after.draft.title, timezone: after.draft.timezone };
  return {
    periodOptions,
    scope: {
      before: left,
      after: right,
      status:
        periodId === null
          ? 'wholePlan'
          : left === null && right === null
            ? 'missing'
            : presence(left !== null, right !== null),
    },
    periods: compareRows(before.draft.periods, after.draft.periods, beforeScope, afterScope),
    sessions: compareRows(
      before.draft.sessions,
      after.draft.sessions,
      scopedSessionIds(before.draft, beforeScope),
      scopedSessionIds(after.draft, afterScope),
    ),
    planMetadata: {
      before: beforeMetadata,
      after: afterMetadata,
      changed: !sameValue(beforeMetadata, afterMetadata),
    },
  };
}
