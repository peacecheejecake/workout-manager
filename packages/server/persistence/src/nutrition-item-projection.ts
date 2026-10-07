import type { z } from 'zod';
import type { nutritionPlanVersionSchema } from '@workout/contracts/nutrition-core';
import type { planDraftSchema } from '@workout/contracts/planning';
import type { RaceEvent } from '@workout/contracts/races';
import type {
  IntegratedNutritionItem,
  UnresolvedNutritionItem,
} from '@workout/contracts/integrated-planner';
import { localInstant, localParts } from './nutrition-calendar.js';

export function projectNutritionItem(
  item: z.infer<typeof nutritionPlanVersionSchema>['items'][number],
  plan: z.infer<typeof nutritionPlanVersionSchema>,
  linked: Map<string, z.infer<typeof planDraftSchema>>,
  timezone: string,
  ownedRaces: ReadonlyMap<string, RaceEvent> = new Map(),
): { date: string; value: IntegratedNutritionItem } | UnresolvedNutritionItem {
  const base = {
    id: item.id,
    planVersionId: item.planVersionId,
    title: item.title,
    category: item.category,
    source: item.source,
  };
  const unresolved = (reason: UnresolvedNutritionItem['reason']) => ({ ...base, reason });
  if (item.anchor.kind === 'absolute') {
    if (item.anchor.timezone === timezone)
      return { date: item.anchor.date, value: { ...base, localTime: item.anchor.localTime } };
    if (item.anchor.localTime === null) return unresolved('timezone_mismatch');
    const instant = localInstant(item.anchor.date, item.anchor.localTime, item.anchor.timezone);
    if (instant === null) return unresolved('ambiguous_local_time');
    const local = localParts(instant, timezone);
    return { date: local.date, value: { ...base, localTime: local.time } };
  }
  const anchor = item.anchor;
  let start: number | null;
  let durationSeconds: number | null = null;
  if (anchor.entity === 'race') {
    const race = ownedRaces.get(anchor.entityId);
    // Explicit owned preview context only. Ordinary integrated reads pass no
    // map: mutable current events cannot implicitly retime approved nutrition.
    if (
      !race ||
      race.id !== anchor.entityId ||
      anchor.point === 'end' ||
      race.localStartTime === null
    )
      return unresolved('missing_anchor');
    start = localInstant(race.localDate, race.localStartTime, race.timezone);
  } else {
    if (plan.linkedTrainingPlanVersionId === null) return unresolved('missing_anchor');
    const training = linked.get(plan.linkedTrainingPlanVersionId);
    const session = training?.sessions.find((candidate) => candidate.id === anchor.entityId);
    if (!session || !training) return unresolved('missing_anchor');
    if (session.localStartTime === null) return unresolved('missing_session_time');
    start = localInstant(session.date, session.localStartTime, training.timezone);
    durationSeconds = session.durationSeconds;
  }
  if (start === null) return unresolved('ambiguous_local_time');
  if (anchor.point === 'end' && durationSeconds === null)
    return unresolved('missing_session_duration');
  const anchored =
    start +
    (anchor.point === 'end' ? (durationSeconds ?? 0) * 1000 : 0) +
    anchor.offsetMinutes * 60_000;
  if (!Number.isFinite(anchored) || Math.abs(anchored) > 8_640_000_000_000_000)
    return unresolved('offset_out_of_range');
  const local = localParts(anchored, timezone);
  return { date: local.date, value: { ...base, localTime: local.time } };
}
