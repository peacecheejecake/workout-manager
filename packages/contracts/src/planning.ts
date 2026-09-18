import { z } from 'zod';
import { planningLensSchema, type DayProjection, type PlanningLens } from './core.js';
import { periodConstraintsSchema } from './period-constraints.js';
import { supplementarySessionLinkSchema } from './supplementary-core.js';
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
export const durationRangeSchema = z
  .strictObject({ minSeconds: duration.unwrap(), maxSeconds: duration.unwrap() })
  .refine((value) => value.minSeconds <= value.maxSeconds, {
    message: 'Minimum duration must not exceed maximum',
    path: ['maxSeconds'],
  });
export const distanceRangeSchema = z
  .strictObject({ minMeters: distance.unwrap(), maxMeters: distance.unwrap() })
  .refine((value) => value.minMeters <= value.maxMeters, {
    message: 'Minimum distance must not exceed maximum',
    path: ['maxMeters'],
  });
// Technical input bounds, not physiological recommendations or observed measurements.
const targetPace = z.number().finite().positive().max(86400);
const targetHeartRate = z.number().int().min(1).max(1000);
export const paceTargetSchema = z
  .strictObject({ minSecondsPerKm: targetPace, maxSecondsPerKm: targetPace })
  .refine((value) => value.minSecondsPerKm <= value.maxSecondsPerKm, {
    message: 'Fast pace boundary must not exceed slow pace boundary',
    path: ['maxSecondsPerKm'],
  });
export const heartRateTargetSchema = z
  .strictObject({ minBpm: targetHeartRate, maxBpm: targetHeartRate })
  .refine((value) => value.minBpm <= value.maxBpm, {
    message: 'Minimum heart-rate target must not exceed maximum',
    path: ['maxBpm'],
  });
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
  // Missing remains missing in immutable legacy snapshots and command receipts.
  priority: z.enum(['low', 'normal', 'high']).nullable().optional(),
  constraints: periodConstraintsSchema.optional(),
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
    // Explicit ranges and exact quantities are mutually exclusive. Never infer a midpoint.
    durationRange: durationRangeSchema.nullable().optional(),
    distanceRange: distanceRangeSchema.nullable().optional(),
    targetRpe: z.number().finite().min(0).max(10).nullable(),
    // Missing stays missing when reading legacy snapshots and idempotency receipts.
    intensityLabel: z.enum(['A', 'B', 'C']).nullable().optional(),
    paceTarget: paceTargetSchema.nullable().optional(),
    heartRateTarget: heartRateTargetSchema.nullable().optional(),
    purpose: z.string().max(2000),
    notes: z.string().max(4000),
    priority: z.enum(['low', 'normal', 'high']),
    locks: z.strictObject({
      date: z.boolean(),
      time: z.boolean(),
      intensity: z.boolean(),
      // Presence lock protects deletion only. Omission in historical versions stays omitted.
      attendance: z.boolean().optional(),
    }),
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
    if (session.durationRange && session.durationSeconds !== null)
      context.addIssue({
        code: 'custom',
        message: 'Duration range requires a null exact duration',
        path: ['durationSeconds'],
      });
    if (session.distanceRange && session.distanceMeters !== null)
      context.addIssue({
        code: 'custom',
        message: 'Distance range requires a null exact distance',
        path: ['distanceMeters'],
      });
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
      period.constraints?.unavailableDates.forEach((date, dateIndex) => {
        if (date < period.startDate || date >= period.endDateExclusive)
          issue('Constraint date exceeds period range', [
            ...path,
            'constraints',
            'unavailableDates',
            dateIndex,
          ]);
      });
      period.constraints?.dailyTimeLimits.forEach((limit, limitIndex) => {
        if (limit.date < period.startDate || limit.date >= period.endDateExclusive)
          issue('Constraint date exceeds period range', [
            ...path,
            'constraints',
            'dailyTimeLimits',
            limitIndex,
            'date',
          ]);
      });
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
  /** Optional changes to frozen strength-session content in this new plan version. */
  supplementaryLinks: z
    .array(
      z.strictObject({
        plannedSessionId: boundedId,
        content: supplementarySessionLinkSchema.shape.content.nullable(),
      }),
    )
    .max(1000)
    .refine((links) => new Set(links.map((link) => link.plannedSessionId)).size === links.length)
    .optional(),
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
    if (!replacement) return !locks.date && !locks.time && !locks.intensity && !locks.attendance;
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
        value.paceTarget
          ? [value.paceTarget.minSecondsPerKm, value.paceTarget.maxSecondsPerKm]
          : null,
        value.heartRateTarget ? [value.heartRateTarget.minBpm, value.heartRateTarget.maxBpm] : null,
        value.durationSeconds,
        value.distanceMeters,
        value.durationRange
          ? [value.durationRange.minSeconds, value.durationRange.maxSeconds]
          : null,
        value.distanceRange ? [value.distanceRange.minMeters, value.distanceRange.maxMeters] : null,
        value.steps,
      ]);
    return !locks.intensity || intensity(session) === intensity(replacement);
  });
}

/** Known target bounds only; these are neither measurements nor an inferred exact target. */
export function sessionDurationBounds(
  session: PlannedSession,
): { min: number; max: number } | null {
  if (session.durationRange)
    return { min: session.durationRange.minSeconds, max: session.durationRange.maxSeconds };
  return session.durationSeconds === null
    ? null
    : { min: session.durationSeconds, max: session.durationSeconds };
}
export function sessionDistanceBounds(
  session: PlannedSession,
): { min: number; max: number } | null {
  if (session.distanceRange)
    return { min: session.distanceRange.minMeters, max: session.distanceRange.maxMeters };
  return session.distanceMeters === null
    ? null
    : { min: session.distanceMeters, max: session.distanceMeters };
}

/** Sum canonical decimal quantities as stored in JSON/PostgreSQL numeric, rounding only the result. */
export function sumTargetQuantities(values: readonly number[]): number {
  let total = 0n;
  let scale = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError('Target quantities must be finite and nonnegative');
    const [coefficient = '0', exponent = '0'] = value.toString().split('e');
    const [whole = '0', fraction = ''] = coefficient.split('.');
    const inputScale = fraction.length - Number(exponent);
    const nextScale = Math.max(scale, inputScale);
    total =
      total * 10n ** BigInt(nextScale - scale) +
      BigInt(whole + fraction) * 10n ** BigInt(nextScale - inputScale);
    scale = nextScale;
  }
  const result = Number(`${total}e-${scale}`);
  if (!Number.isFinite(result)) throw new RangeError('Target sum exceeds the numeric bound');
  return result;
}
