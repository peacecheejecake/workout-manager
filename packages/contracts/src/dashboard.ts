import { z } from 'zod';
import { instantSchema, localDateSchema, timeZoneSchema } from './primitives.js';
import { periodDraftSchema, plannedSessionSchema } from './planning.js';
import { checkInSchema } from './check-ins.js';

export const dashboardDefinition = {
  version: 'dashboard-v1',
  period: '기준일을 포함한 N개 현지 달력 날짜입니다. 바로 앞 N개 날짜를 별도로 조회합니다.',
  actual: '가져온 활동의 현재 정본과 사용자 정정을 반영합니다. 계획은 실제 수행이 아닙니다.',
  distance: '알려진 거리의 합계(m)입니다. 미입력 값은 0으로 채우지 않습니다.',
  duration: '알려진 시간의 합계(초)를 timer/elapsed/moving/unknown 정의별로 구분합니다.',
  checkIns: '자기보고가 존재하는 날짜 수입니다. 미보고는 피로·불편감 0을 뜻하지 않습니다.',
  coverage: '수집 완전성을 확인할 수 없어 전기 대비 확정 증감·계획 이행률을 계산하지 않습니다.',
} as const;

/** UTC is used only for calendar arithmetic, never to measure elapsed local days. */
export function shiftDashboardDate(date: string, amount: number): string {
  localDateSchema.parse(date);
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return localDateSchema.parse(value.toISOString().slice(0, 10));
}
export const dashboardQuerySchema = z
  .strictObject({
    anchor: localDateSchema,
    window: z.coerce.number().int().min(3).max(90).default(10),
    timezone: timeZoneSchema,
  })
  .refine((query) => {
    try {
      // PostgreSQL has no year zero. Bound both comparison and upcoming ranges.
      return (
        shiftDashboardDate(query.anchor, 1 - query.window * 2) >= '0001-01-01' &&
        shiftDashboardDate(query.anchor, 8) <= '9999-12-31'
      );
    } catch {
      return false;
    }
  }, 'Dashboard date range exceeds supported calendar dates');

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const dashboardMetricSchema = z
  .strictObject({
    value: z.number().finite().nonnegative().nullable(),
    knownCount: count,
    missingCount: count,
  })
  .refine((metric) => (metric.knownCount === 0) === (metric.value === null), 'Unknown is not zero');
const durationKinds = z.strictObject({
  timer: dashboardMetricSchema,
  elapsed: dashboardMetricSchema,
  moving: dashboardMetricSchema,
  unknown: dashboardMetricSchema,
});
export const dashboardActualSchema = z
  .strictObject({
    count,
    distanceMeters: dashboardMetricSchema,
    durationSeconds: durationKinds,
    sources: z.strictObject({ fit: count, fixture: count, manual: count.default(0) }),
    overlayCount: count,
  })
  .refine(
    (actual) =>
      actual.distanceMeters.knownCount + actual.distanceMeters.missingCount === actual.count &&
      Object.values(actual.durationSeconds).reduce(
        (total, metric) => total + metric.knownCount + metric.missingCount,
        0,
      ) === actual.count &&
      actual.sources.fit + actual.sources.fixture + actual.sources.manual === actual.count &&
      actual.overlayCount <= actual.count,
    'Activity aggregate counts must agree',
  );
export const plannedTargetMetricSchema = z
  .strictObject({
    min: z.number().finite().nonnegative().nullable(),
    max: z.number().finite().nonnegative().nullable(),
    knownCount: count,
    missingCount: count,
    rangeCount: count,
  })
  .refine(
    (value) =>
      value.rangeCount <= value.knownCount &&
      (value.knownCount === 0
        ? value.min === null && value.max === null
        : value.min !== null && value.max !== null && value.min <= value.max),
    'Known targets require ordered bounds; absence is not zero',
  );
export const plannedTargetsSchema = z.strictObject({
  definitionVersion: z.literal('planned-targets-v1'),
  distanceMeters: plannedTargetMetricSchema,
  durationSeconds: plannedTargetMetricSchema,
});
export type PlannedTargetMetric = z.infer<typeof plannedTargetMetricSchema>;
export const dashboardPlannedSchema = z
  .strictObject({
    count,
    distanceMeters: dashboardMetricSchema,
    durationSeconds: dashboardMetricSchema,
    // Additive definition: original metrics remain exact-value-only partial sums.
    targets: plannedTargetsSchema.optional(),
  })
  .refine(
    (planned) =>
      [planned.distanceMeters, planned.durationSeconds].every(
        (metric) => metric.knownCount + metric.missingCount === planned.count,
      ),
    'Planned aggregate counts must agree',
  )
  .refine(
    (planned) =>
      !planned.targets ||
      (['distanceMeters', 'durationSeconds'] as const).every((key) => {
        const bounds = planned.targets?.[key];
        const exact = planned[key];
        return (
          bounds &&
          bounds.knownCount + bounds.missingCount === planned.count &&
          bounds.knownCount === exact.knownCount + bounds.rangeCount &&
          exact.missingCount === bounds.missingCount + bounds.rangeCount &&
          (bounds.rangeCount !== 0 || (bounds.min === exact.value && bounds.max === exact.value)) &&
          (exact.value === null || (bounds.min !== null && bounds.min >= exact.value))
        );
      }),
    'Target bounds and exact-only counts must agree',
  );
export const dashboardDaySchema = z.strictObject({
  date: localDateSchema,
  actual: dashboardActualSchema,
  planned: dashboardPlannedSchema,
  checkInCount: count,
});
export const dashboardWindowSchema = z.strictObject({
  actual: dashboardActualSchema,
  planned: dashboardPlannedSchema,
  checkInCount: count,
  checkInDays: count.max(90),
});
export const dashboardReadModelSchema = z
  .strictObject({
    definitionVersion: z.literal('dashboard-v1'),
    observedAt: instantSchema,
    period: z.strictObject({
      anchor: localDateSchema,
      days: z.number().int().min(3).max(90),
      timezone: timeZoneSchema,
      timezoneSource: z.enum(['plan', 'query']),
      from: localDateSchema,
      toExclusive: localDateSchema,
      previousFrom: localDateSchema,
      upcomingToExclusive: localDateSchema,
    }),
    planVersion: z
      .strictObject({ id: z.string().min(1).max(200), version: z.number().int().positive() })
      .nullable(),
    dataRevision: z.strictObject({
      // Includes deleted canonical rows; every import/correction/deletion increments revision.
      activities: z.strictObject({ count, revisionSum: z.string().regex(/^(?:0|[1-9][0-9]*)$/) }),
      checkIns: count,
    }),
    currentBlock: periodDraftSchema.nullable(),
    todaySessions: z.array(plannedSessionSchema).max(1000),
    upcomingSessions: z.array(plannedSessionSchema).max(1000),
    current: dashboardWindowSchema,
    previous: dashboardWindowSchema,
    days: z.array(dashboardDaySchema).min(3).max(90),
    unplacedActivityCount: count,
    latestCheckIn: checkInSchema.nullable(),
    availability: z.strictObject({
      coverage: z.literal('unknown'),
      comparison: z.literal('unavailable'),
      actualLoad: z.literal('unavailable'),
      providerMetrics: z.literal('unavailable'),
    }),
    proposalSummary: z.strictObject({
      status: z.literal('unavailable'),
      reason: z.literal('not_implemented'),
    }),
    connectionFreshness: z.strictObject({
      status: z.literal('unavailable'),
      reason: z.literal('activity_sync_not_implemented'),
      lastSuccessfulSyncAt: z.null(),
    }),
  })
  .refine((model) => {
    try {
      return (
        model.days.length === model.period.days &&
        model.period.from === shiftDashboardDate(model.period.anchor, 1 - model.period.days) &&
        model.period.toExclusive === shiftDashboardDate(model.period.anchor, 1) &&
        model.period.previousFrom === shiftDashboardDate(model.period.from, -model.period.days) &&
        model.period.upcomingToExclusive === shiftDashboardDate(model.period.anchor, 8) &&
        model.days.every((day, index) => day.date === shiftDashboardDate(model.period.from, index))
      );
    } catch {
      return false;
    }
  }, 'Dashboard must cover consecutive local calendar dates');

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
export type DashboardMetric = z.infer<typeof dashboardMetricSchema>;
export type DashboardActual = z.infer<typeof dashboardActualSchema>;
export type DashboardPlanned = z.infer<typeof dashboardPlannedSchema>;
export type DashboardDay = z.infer<typeof dashboardDaySchema>;
export type DashboardWindow = z.infer<typeof dashboardWindowSchema>;
export type DashboardReadModel = z.infer<typeof dashboardReadModelSchema>;
