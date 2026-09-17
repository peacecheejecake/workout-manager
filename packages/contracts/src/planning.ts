import { z } from 'zod';
import { planningLensSchema, type DayProjection, type PlanningLens } from './core.js';
import {
  idSchema,
  instantSchema,
  localDateSchema,
  localTimeSchema,
  timeZoneSchema,
} from './primitives.js';

const boundedId = idSchema.max(200);
const duration = z.number().finite().min(0).max(604800).nullable();
const distance = z.number().finite().min(0).max(10_000_000).nullable();
export const periodDraftSchema = z.strictObject({
  id: boundedId,
  parentId: boundedId.nullable(),
  level: z.enum(['season', 'wave', 'phase', 'block']),
  title: z.string().trim().min(1).max(200),
  startDate: localDateSchema,
  endDateExclusive: localDateSchema,
  timezone: timeZoneSchema,
  intent: z.string().max(2000),
  isPartial: z.boolean(),
});
export const plannedSessionSchema = z
  .strictObject({
    id: boundedId,
    blockId: boundedId,
    date: localDateSchema,
    localStartTime: localTimeSchema.nullable(),
    title: z.string().trim().min(1).max(200),
    sport: z.enum(['running', 'cycling', 'swimming', 'strength', 'other']),
    durationSeconds: duration,
    distanceMeters: distance,
    targetRpe: z.number().finite().min(0).max(10).nullable(),
    // Missing stays missing when reading legacy snapshots and idempotency receipts.
    intensityLabel: z.enum(['A', 'B', 'C']).nullable().optional(),
    purpose: z.string().max(2000),
    notes: z.string().max(4000),
    priority: z.enum(['low', 'normal', 'high']),
    locks: z.strictObject({ date: z.boolean(), time: z.boolean(), intensity: z.boolean() }),
    steps: z
      .array(
        z.strictObject({
          id: boundedId,
          kind: z.enum(['warmup', 'work', 'recovery', 'cooldown']),
          durationSeconds: duration,
          distanceMeters: distance,
          repetitions: z.number().int().min(1).max(1000),
        }),
      )
      .max(100),
  })
  .superRefine((session, context) => {
    if (new Set(session.steps.map((step) => step.id)).size !== session.steps.length)
      context.addIssue({ code: 'custom', message: 'Duplicate step IDs', path: ['steps'] });
  });
const dayMs = 86400000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / dayMs;
const dateAt = (day: number) =>
  localDateSchema.parse(new Date(day * dayMs).toISOString().slice(0, 10));
export const planDraftSchema = z
  .strictObject({
    timezone: timeZoneSchema,
    title: z.string().trim().min(1).max(200),
    periods: z.array(periodDraftSchema).min(1).max(100),
    sessions: z.array(plannedSessionSchema).max(1000),
  })
  .superRefine((draft, context) => {
    const issue = (message: string, path: (string | number)[]) =>
      context.addIssue({ code: 'custom', message, path });
    const periods = new Map(draft.periods.map((period) => [period.id, period]));
    if (periods.size !== draft.periods.length) issue('Duplicate period IDs', ['periods']);
    if (new Set(draft.sessions.map((session) => session.id)).size !== draft.sessions.length)
      issue('Duplicate session IDs', ['sessions']);
    const levels = ['season', 'wave', 'phase', 'block'];
    draft.periods.forEach((period, index) => {
      const path = ['periods', index];
      if (period.startDate >= period.endDateExclusive)
        issue('Expected non-empty period', [...path, 'endDateExclusive']);
      if (period.timezone !== draft.timezone)
        issue('Period timezone must match plan timezone', [...path, 'timezone']);
      if (period.level === 'season') {
        if (period.parentId !== null) issue('Season must be a root', [...path, 'parentId']);
      } else {
        const parent = period.parentId === null ? undefined : periods.get(period.parentId);
        if (
          parent === undefined ||
          levels.indexOf(parent.level) !== levels.indexOf(period.level) - 1
        )
          issue('Required parent level is missing', [...path, 'parentId']);
        else if (
          period.startDate < parent.startDate ||
          period.endDateExclusive > parent.endDateExclusive
        )
          issue('Period exceeds parent range', path);
      }
      for (const other of draft.periods.slice(0, index)) {
        if (
          other.parentId === period.parentId &&
          other.startDate < period.endDateExclusive &&
          period.startDate < other.endDateExclusive
        )
          issue('Sibling periods overlap', path);
      }
    });
    const start = Math.min(...draft.periods.map((period) => dayNumber(period.startDate)));
    const end = Math.max(...draft.periods.map((period) => dayNumber(period.endDateExclusive)));
    if (end - start > 3660) issue('Plan is bounded to 3660 calendar days', ['periods']);
    draft.sessions.forEach((session, index) => {
      const block = periods.get(session.blockId);
      if (
        block?.level !== 'block' ||
        session.date < block.startDate ||
        session.date >= block.endDateExclusive
      )
        issue('Session must belong to its containing Block', ['sessions', index, 'blockId']);
    });
    if (new TextEncoder().encode(JSON.stringify(draft)).length > 512 * 1024)
      issue('Plan exceeds 512 KiB', []);
  });
export const manualPlanCommandSchema = z.strictObject({
  source: z.literal('manual'),
  confirmed: z.literal(true),
  expectedVersionId: boundedId.nullable(),
  draft: planDraftSchema,
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
});
export const planSnapshotSchema = z.strictObject({
  id: boundedId,
  version: z.number().int().min(1).max(2147483647),
  createdAt: instantSchema,
  draft: planDraftSchema,
});
export const planHistoryEntrySchema = planSnapshotSchema
  .pick({ id: true, version: true, createdAt: true })
  .extend({ title: z.string().min(1).max(200) });
export const planReadSchema = z.strictObject({
  head: planSnapshotSchema.nullable(),
  history: z.array(planHistoryEntrySchema).max(100),
});
export type PeriodDraft = z.infer<typeof periodDraftSchema>;
export type PlannedSession = z.infer<typeof plannedSessionSchema>;
export type PlanDraft = z.infer<typeof planDraftSchema>;
export type ManualPlanCommand = z.infer<typeof manualPlanCommandSchema>;
export type PlanSnapshot = z.infer<typeof planSnapshotSchema>;
export type PlanRead = z.infer<typeof planReadSchema>;

/** Calendar arithmetic never treats a local day as an elapsed 24-hour interval. */
export function projectPlan(input: PlanDraft, inputLens: PlanningLens): DayProjection[] {
  const draft = planDraftSchema.parse(input);
  const lens = planningLensSchema.parse(inputLens);
  let from: number;
  let to: number;
  if (lens.kind === 'rolling') {
    to = dayNumber(lens.anchorDate) + 1;
    from = to - lens.days;
  } else if (lens.kind === 'calendar') {
    from = dayNumber(lens.from);
    to = dayNumber(lens.toExclusive);
  } else {
    const period = draft.periods.find((value) => value.id === lens.periodId);
    if (!period) throw new RangeError('Unknown period');
    from = dayNumber(period.startDate);
    to = dayNumber(period.endDateExclusive);
  }
  if (to <= from || to - from > 3660) throw new RangeError('Projection must span 1 to 3660 days');
  const compare = (a: string, b: string) => (a === b ? 0 : a < b ? -1 : 1);
  const sessions = [...draft.sessions].sort(
    (a, b) => compare(a.localStartTime ?? '', b.localStartTime ?? '') || compare(a.id, b.id),
  );
  return Array.from({ length: to - from }, (_, index) => {
    const date = dateAt(from + index);
    return {
      date,
      timezone: draft.timezone,
      blockId:
        draft.periods.find(
          (period) =>
            period.level === 'block' && period.startDate <= date && date < period.endDateExclusive,
        )?.id ?? null,
      plannedSessionIds: sessions
        .filter((session) => session.date === date)
        .map((session) => session.id),
      activityIds: [],
      knownRest: false,
    };
  });
}

/** Unlocking is an explicit prior save, never combined with moving a protected session. */
export function preservesSessionLocks(previous: PlanDraft, next: PlanDraft): boolean {
  const sessions = new Map(next.sessions.map((session) => [session.id, session]));
  return previous.sessions.every((session) => {
    const replacement = sessions.get(session.id);
    const locks = session.locks;
    if ((locks.date || locks.time) && previous.timezone !== next.timezone) return false;
    if (!replacement) return !locks.date && !locks.time && !locks.intensity;
    if (
      locks.date &&
      (replacement.date !== session.date || replacement.blockId !== session.blockId)
    )
      return false;
    if (locks.time && replacement.localStartTime !== session.localStartTime) return false;
    const intensity = (value: PlannedSession) =>
      JSON.stringify([
        value.sport,
        value.targetRpe,
        value.intensityLabel ?? null,
        value.durationSeconds,
        value.distanceMeters,
        value.steps,
      ]);
    return !locks.intensity || intensity(session) === intensity(replacement);
  });
}
