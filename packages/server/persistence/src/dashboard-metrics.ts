import {
  sessionDistanceBounds,
  sumTargetQuantities,
  sessionDurationBounds,
  type PlannedSession,
} from '@workout/contracts/planning';
import type {
  DashboardActual,
  DashboardMetric,
  DashboardPlanned,
  DashboardDay,
  DashboardWindow,
} from '@workout/contracts/dashboard';
export const durationKinds = ['timer', 'elapsed', 'moving', 'unknown'] as const;
export const emptyMetric = (): DashboardMetric => ({ value: null, knownCount: 0, missingCount: 0 });
export const emptyActual = (): DashboardActual => ({
  count: 0,
  distanceMeters: emptyMetric(),
  durationSeconds: {
    timer: emptyMetric(),
    elapsed: emptyMetric(),
    moving: emptyMetric(),
    unknown: emptyMetric(),
  },
  sources: { fit: 0, fixture: 0, manual: 0 },
  overlayCount: 0,
});
type TargetMetric = NonNullable<DashboardPlanned['targets']>['distanceMeters'];
const emptyTarget = (): TargetMetric => ({
  min: null,
  max: null,
  knownCount: 0,
  missingCount: 0,
  rangeCount: 0,
});
export function plannedTargets(
  sessions: PlannedSession[],
): NonNullable<DashboardPlanned['targets']> {
  const targets = {
    definitionVersion: 'planned-targets-v1' as const,
    distanceMeters: emptyTarget(),
    durationSeconds: emptyTarget(),
  };
  for (const key of ['distanceMeters', 'durationSeconds'] as const) {
    const metric = targets[key];
    const bounds = sessions
      .map((session) =>
        key === 'distanceMeters' ? sessionDistanceBounds(session) : sessionDurationBounds(session),
      )
      .filter((value) => value !== null);
    metric.knownCount = bounds.length;
    metric.missingCount = sessions.length - bounds.length;
    metric.rangeCount = sessions.filter((session) =>
      key === 'distanceMeters' ? session.distanceRange != null : session.durationRange != null,
    ).length;
    metric.min = bounds.length ? sumTargetQuantities(bounds.map((value) => value.min)) : null;
    metric.max = bounds.length ? sumTargetQuantities(bounds.map((value) => value.max)) : null;
  }
  return targets;
}
export const emptyPlanned = (): DashboardPlanned => ({
  count: 0,
  distanceMeters: emptyMetric(),
  durationSeconds: emptyMetric(),
  targets: plannedTargets([]),
});
function addMetric(target: DashboardMetric, input: DashboardMetric) {
  target.knownCount += input.knownCount;
  target.missingCount += input.missingCount;
  if (input.value !== null) target.value = (target.value ?? 0) + input.value;
}
/** Fold only bounded SQL daily aggregates, never raw health rows. */
export function summarizeDays(days: DashboardDay[]): DashboardWindow {
  const result: DashboardWindow = {
    actual: emptyActual(),
    planned: emptyPlanned(),
    checkInCount: 0,
    checkInDays: 0,
  };
  // Legacy daily payloads lack range evidence; never manufacture bounds from partial scalar sums.
  if (days.some((day) => day.planned.targets === undefined)) delete result.planned.targets;
  for (const day of days) {
    result.actual.count += day.actual.count;
    addMetric(result.actual.distanceMeters, day.actual.distanceMeters);
    for (const kind of durationKinds)
      addMetric(result.actual.durationSeconds[kind], day.actual.durationSeconds[kind]);
    result.actual.sources.fit += day.actual.sources.fit;
    result.actual.sources.fixture += day.actual.sources.fixture;
    result.actual.sources.manual += day.actual.sources.manual;
    result.actual.overlayCount += day.actual.overlayCount;
    result.planned.count += day.planned.count;
    addMetric(result.planned.distanceMeters, day.planned.distanceMeters);
    addMetric(result.planned.durationSeconds, day.planned.durationSeconds);
    if (result.planned.targets && day.planned.targets) {
      for (const key of ['distanceMeters', 'durationSeconds'] as const) {
        const target = result.planned.targets[key],
          input = day.planned.targets[key];
        target.knownCount += input.knownCount;
        target.missingCount += input.missingCount;
        target.rangeCount += input.rangeCount;
      }
    }
    result.checkInCount += day.checkInCount;
    if (day.checkInCount > 0) result.checkInDays++;
  }
  for (const key of ['distanceMeters', 'durationSeconds'] as const) {
    const values = days.map((day) => day.planned[key].value).filter((value) => value !== null);
    result.planned[key].value = values.length ? sumTargetQuantities(values) : null;
    const target = result.planned.targets?.[key];
    if (target)
      for (const bound of ['min', 'max'] as const) {
        const values = days
          .map((day) => day.planned.targets?.[key][bound])
          .filter((value): value is number => typeof value === 'number');
        target[bound] = values.length ? sumTargetQuantities(values) : null;
      }
  }
  return result;
}
