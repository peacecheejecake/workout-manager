import { planningLensSchema, type PlanningLens } from '@workout/contracts/core';
import { idSchema, localDateSchema } from '@workout/contracts/primitives';

export interface PlannerUrlState {
  lens: PlanningLens;
  view: 'stack' | 'split';
  plannedView: 'agenda' | 'calendar' | 'table';
  plannedSession: string | null;
  selectionError: boolean;
  error: boolean;
}

export function readPlannerSearch(search: string, today: string): PlannerUrlState {
  const params = new URLSearchParams(search);
  const anchor = params.get('date') ?? today;
  const days = Number(params.get('days') ?? '10');
  const kind = params.get('lens') ?? 'rolling';
  const candidate =
    kind === 'calendar'
      ? {
          kind,
          from: params.get('from') ?? anchor,
          toExclusive: params.get('to') ?? addDays(anchor, 7),
        }
      : kind === 'period'
        ? { kind, periodId: params.get('period') ?? '' }
        : { kind, anchorDate: anchor, days };
  const parsed = planningLensSchema.safeParse(candidate);
  const valid =
    parsed.success &&
    (parsed.data.kind !== 'rolling' || parsed.data.days <= 366) &&
    (parsed.data.kind !== 'calendar' ||
      Date.parse(parsed.data.toExclusive) - Date.parse(parsed.data.from) <= 366 * 86400000);
  const selected = params.get('plannedSession');
  const validSelection = selected === null || idSchema.safeParse(selected).success;
  const plannedView = params.get('plannedView') ?? 'agenda';
  return {
    plannedView: plannedView === 'calendar' || plannedView === 'table' ? plannedView : 'agenda',
    plannedSession: validSelection ? selected : null,
    selectionError: !validSelection || !['calendar', 'table', 'agenda'].includes(plannedView),
    lens: valid
      ? parsed.data
      : { kind: 'rolling', anchorDate: localDateSchema.parse(today), days: 10 },
    view: params.get('view') === 'split' ? 'split' : 'stack',
    error: !valid,
  };
}

export function updatePlannerSearch(search: string, changes: Record<string, string | null>) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  if (
    Object.keys(changes).some(
      (key) =>
        ['lens', 'date', 'days', 'from', 'to', 'period'].includes(key) &&
        new URLSearchParams(search).get(key) !== changes[key],
    )
  )
    params.delete('actualPage');
  return params.toString();
}

export function addDays(date: string, days: number): string {
  const parsed = localDateSchema.safeParse(date);
  if (!parsed.success) return date;
  return new Date(Date.parse(parsed.data) + days * 86400000).toISOString().slice(0, 10);
}
