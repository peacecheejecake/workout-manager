import { createHash } from 'node:crypto';
import { planDraftSchema, type PlanDraft } from '@workout/contracts/planning';
import {
  routineOccurrenceSchema,
  routineScheduleVersionSchema,
  type RoutineOccurrence,
  type RoutineScheduleVersion,
} from '@workout/contracts/routines';

export class RoutineExpansionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type ExpansionPlan = Pick<PlanDraft, 'timezone'> & {
  periods: Pick<PlanDraft['periods'][number], 'id' | 'startDate' | 'endDateExclusive'>[];
  sessions: Pick<
    PlanDraft['sessions'][number],
    'id' | 'date' | 'localStartTime' | 'durationSeconds'
  >[];
};

const dayMs = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / dayMs;
const dateAt = (day: number) => new Date(day * dayMs).toISOString().slice(0, 10);
export function localDateOf(instant: string, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}`;
}
function stableId(...values: string[]) {
  const bytes = createHash('sha256').update(JSON.stringify(values)).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = bytes.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Resolve an explicit wall-clock time only when it exists unambiguously. DST
 * gaps/overlaps are unresolved so a user can choose rather than inherit an
 * arbitrary timestamp from the host timezone. */
export function resolveLocalTime(
  date: string,
  time: string | null,
  timezone: string,
): string | null {
  if (time === null) return null;
  const [hour = 0, minute = 0, second = 0] = time.split(':').map(Number);
  const target = Date.parse(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`,
  );
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const wall = (instant: number) => {
    const parts = Object.fromEntries(
      format
        .formatToParts(instant)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}`;
  };
  const wanted = `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  const candidates = new Set<number>();
  for (const offsetHours of [-14, -12, -10, -8, -6, -4, -2, 0, 2, 4, 6, 8, 10, 12, 14]) {
    const sample = target + offsetHours * 3_600_000;
    const parts = wall(sample);
    const offset = Date.parse(`${parts}Z`) - sample;
    const candidate = target - offset;
    if (wall(candidate) === wanted) candidates.add(candidate);
  }
  if (candidates.size !== 1) return null;
  const [candidate] = candidates;
  return candidate === undefined ? null : new Date(candidate).toISOString();
}

export function parsePlanDraft(value: unknown): PlanDraft {
  const parsed = planDraftSchema.safeParse(value);
  if (!parsed.success) throw new RoutineExpansionError('SOURCE_PLAN_INVALID');
  return parsed.data;
}

export function expandRoutineSchedule(
  raw: RoutineScheduleVersion,
  sourcePlan: ExpansionPlan | null,
): RoutineOccurrence[] {
  const schedule = routineScheduleVersionSchema.parse(raw);
  const { window, rule } = schedule;
  const start = dayNumber(window.startDate);
  const end = dayNumber(window.endDateExclusive);
  if (end - start > 366 || window.maxOccurrences > 100) {
    throw new RoutineExpansionError('EXPANSION_LIMIT_EXCEEDED');
  }
  if ((rule.kind === 'period_days' || rule.kind === 'session_links') && sourcePlan === null)
    throw new RoutineExpansionError('SOURCE_PLAN_REQUIRED');
  if (sourcePlan && sourcePlan.timezone !== window.timezone)
    throw new RoutineExpansionError('SOURCE_PLAN_TIMEZONE_MISMATCH');
  const anchors: { key: string; instant: string | null }[] = [];
  const addDate = (date: string, time: string | null, key = date) => {
    if (date < window.startDate || date >= window.endDateExclusive)
      throw new RoutineExpansionError('ANCHOR_OUTSIDE_WINDOW');
    anchors.push({ key, instant: resolveLocalTime(date, time, window.timezone) });
  };
  switch (rule.kind) {
    case 'dates':
      rule.dates.forEach((date) => addDate(date, rule.localTime));
      break;
    case 'weekdays':
      for (let day = start; day < end; day++) {
        if (rule.weekdays.includes(new Date(day * dayMs).getUTCDay()))
          addDate(dateAt(day), rule.localTime);
      }
      break;
    case 'every_n_days': {
      const first = dayNumber(rule.anchorDate);
      if (first > start) throw new RoutineExpansionError('ANCHOR_OUTSIDE_WINDOW');
      for (let day = first; day < end; day += rule.intervalDays) {
        if (day >= start) addDate(dateAt(day), rule.localTime);
      }
      break;
    }
    case 'period_days': {
      const period = sourcePlan?.periods.find((item) => item.id === rule.periodId);
      if (!period) throw new RoutineExpansionError('PERIOD_NOT_FOUND');
      for (const offset of rule.offsetsDays) {
        const date = dateAt(dayNumber(period.startDate) + offset);
        if (date >= period.endDateExclusive)
          throw new RoutineExpansionError('ANCHOR_OUTSIDE_PERIOD');
        addDate(date, rule.localTime, `${period.id}:${offset}`);
      }
      break;
    }
    case 'session_links': {
      for (const sessionId of rule.sessionIds) {
        const session = sourcePlan?.sessions.find((item) => item.id === sessionId);
        if (!session) throw new RoutineExpansionError('SESSION_NOT_FOUND');
        const startAt = resolveLocalTime(session.date, session.localStartTime, window.timezone);
        const base =
          rule.point === 'start'
            ? startAt
            : startAt !== null && session.durationSeconds !== null
              ? new Date(Date.parse(startAt) + session.durationSeconds * 1000).toISOString()
              : null;
        const instant =
          base === null
            ? null
            : new Date(Date.parse(base) + rule.offsetMinutes * 60_000).toISOString();
        const date = instant === null ? session.date : localDateOf(instant, window.timezone);
        if (date < window.startDate || date >= window.endDateExclusive)
          throw new RoutineExpansionError('ANCHOR_OUTSIDE_WINDOW');
        anchors.push({ key: `${sessionId}:${rule.point}`, instant });
      }
      break;
    }
  }
  if (anchors.length === 0 || anchors.length > window.maxOccurrences || anchors.length > 100)
    throw new RoutineExpansionError('EXPANSION_LIMIT_EXCEEDED');
  if (new Set(anchors.map((anchor) => anchor.key)).size !== anchors.length)
    throw new RoutineExpansionError('DUPLICATE_ANCHOR');
  return anchors
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((anchor) =>
      routineOccurrenceSchema.parse({
        id: stableId(schedule.id, schedule.versionId, anchor.key),
        schedule: { id: schedule.id, versionId: schedule.versionId },
        blueprint: schedule.blueprint,
        anchorKey: anchor.key,
        scheduledAt: anchor.instant,
        timingStatus: anchor.instant === null ? 'unresolved' : 'resolved',
        stepBindings: [],
        selectedChoices: {},
      }),
    );
}
