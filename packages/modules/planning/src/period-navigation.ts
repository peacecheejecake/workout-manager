import type { PeriodDraft, PlanDraft } from '@workout/contracts/planning';

export interface PeriodNavigationSegment {
  period: PeriodDraft;
  number: number;
  startFraction: number;
  endFraction: number;
  days: number;
}
export type PeriodNavigation =
  | { status: 'missing' }
  | {
      status: 'ready';
      current: PeriodDraft | null;
      ancestors: PeriodDraft[];
      children: PeriodDraft[];
      startDate: string | null;
      endDateExclusive: string | null;
      segments: PeriodNavigationSegment[];
      days: number;
      unassignedDays: number;
    };

// ISO date parsing preserves years 0001–0099, unlike Date.UTC's numeric year overload.
const calendarDay = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / 86_400_000;
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Navigation over a validated plan. Fractions preserve unassigned calendar gaps. */
export function buildPeriodNavigation(
  plan: PlanDraft,
  selectedId: string | null,
): PeriodNavigation {
  const periods = new Map(plan.periods.map((period) => [period.id, period]));
  const current = selectedId === null ? null : periods.get(selectedId);
  if (current === undefined) return { status: 'missing' };
  const ancestors: PeriodDraft[] = [];
  let parentId = current?.parentId ?? null;
  while (parentId !== null) {
    const parent = periods.get(parentId);
    if (!parent) return { status: 'missing' };
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }
  const children = plan.periods
    .filter((period) => period.parentId === selectedId)
    .sort(
      (left, right) =>
        compareText(left.startDate, right.startDate) || compareText(left.id, right.id),
    );
  const startDate = current?.startDate ?? children[0]?.startDate ?? null;
  const endDateExclusive = current?.endDateExclusive ?? children.at(-1)?.endDateExclusive ?? null;
  const start = startDate === null ? 0 : calendarDay(startDate);
  const days = endDateExclusive === null ? 0 : calendarDay(endDateExclusive) - start;
  const segments = children.map((period, index) => {
    const childStart = calendarDay(period.startDate);
    const childEnd = calendarDay(period.endDateExclusive);
    return {
      period,
      number: index + 1,
      startFraction: days === 0 ? 0 : (childStart - start) / days,
      endFraction: days === 0 ? 0 : (childEnd - start) / days,
      days: childEnd - childStart,
    };
  });
  return {
    status: 'ready',
    current,
    ancestors,
    children,
    startDate,
    endDateExclusive,
    segments,
    days,
    unassignedDays: days - segments.reduce((sum, segment) => sum + segment.days, 0),
  };
}
